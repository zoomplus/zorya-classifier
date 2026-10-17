import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { z } from 'zod'
import { createClassifier } from '../src/index.js'
import { createCliDecision } from '../src/app/cli-route.js'

await test('direct adapter works over real local HTTP without OpenRouter or any key', async () => {
  let calls = 0
  let serverFailure: unknown
  const server = createServer((request, response) => {
    const handle = async () => {
      calls++
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, undefined)
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk))
        size += chunk.length
        assert.ok(size <= 64 * 1024)
        chunks.push(chunk)
      }
      const body = z.record(z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      assert.equal(body['model'], 'local/fixture')
      assert.equal(Object.hasOwn(body, 'provider'), false)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          model: 'local/fixture',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { content: JSON.stringify({ answers: { selection: { ranking: ['a'] } } }) },
            },
          ],
        }),
      )
    }
    handle().catch((error) => {
      serverFailure = error
      response.writeHead(500)
      response.end('Fixture failure')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = createClassifier({
    decision: createCliDecision({
      ZORYA_MODE: 'chat',
      ZORYA_ENDPOINT: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      ZORYA_MODEL: 'local/fixture',
      OPENROUTER_API_KEY: 'fixture',
      ZORYA_PROVIDER: 'fixture',
    }),
  })
  try {
    const result = await client.classify({
      input: 'synthetic data',
      classes: [
        { id: 'a', description: 'A' },
        { id: 'b', description: 'B' },
      ],
    })
    assert.equal(result.choice, 'a')
    assert.equal(result.probabilities, null)
    assert.equal(result.metadata.provider, null)
    assert.equal(calls, 1)
    assert.equal(serverFailure, undefined)
  } finally {
    await client.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

await test('CLI requires an explicit model and route and does not make import-time requests', () => {
  assert.throws(() => createCliDecision({}), /Set ZORYA_MODEL/)
  assert.throws(() => createCliDecision({ ZORYA_MODEL: 'fixture' }), /ZORYA_PROVIDER/)
  assert.throws(() =>
    createCliDecision({
      ZORYA_MODEL: 'fixture',
      ZORYA_ENDPOINT: 'http://localhost:9/v1/chat/completions',
      ZORYA_REASONING_EFFORT: 'unsupported',
    }),
  )
  assert.equal(
    typeof createCliDecision({
      ZORYA_MODEL: 'fixture',
      ZORYA_PROVIDER: 'fixture',
      OPENROUTER_API_KEY: 'fixture',
    }).decide,
    'function',
  )
})
