import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { ClassifierError, createClassifier } from '../src/index.js'
import type { DecisionRequest, DecisionPort } from '../src/index.js'
import { createOpenRouterVision } from '../src/openrouter.js'

const request: DecisionRequest = {
  state: ['ordinary data'],
  questions: {
    selection: {
      type: 'choice',
      instructions: 'Choose a class',
      criteria: { a: 'Class A', b: 'Class B' },
    },
  },
}
const options = { apiKey: 'fixture', model: 'fixture/vision', provider: 'fixture' }
function reply(
  value: unknown = { answers: { selection: { ranking: ['b', 'a'] } } },
  extra: Record<string, unknown> = {},
) {
  return new Response(
    JSON.stringify({
      id: 'fixture-request',
      model: options.model,
      provider: 'Fixture',
      choices: [{ index: 0, finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      usage: { cost: 0.001 },
      ...extra,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}
await test('ordinary vision adapter uses chat completions, closed classes and no native decision API', async () => {
  let calls = 0
  const port = createOpenRouterVision({
    ...options,
    fetch: async (url, init) => {
      calls++
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
      const body = z.record(z.unknown()).parse(JSON.parse(String(init?.body)))
      assert.equal(body['model'], options.model)
      assert.deepEqual(body['provider'], {
        only: [options.provider],
        allow_fallbacks: false,
        require_parameters: true,
      })
      assert.equal(Object.hasOwn(body, 'questions'), false)
      assert.equal(Object.hasOwn(body, 'response_format'), false)
      assert.equal(body['stream'], false)
      return reply({ answers: { selection: { ranking: ['b'] } } })
    },
  })
  const client = createClassifier({ decision: port })
  try {
    const result = await client.classify({
      input: 'data',
      classes: [
        { id: 'a', description: 'A' },
        { id: 'b', description: 'B' },
      ],
    })
    assert.equal(result.choice, 'b')
    assert.deepEqual(result.ranking, ['b'])
    assert.equal(result.probabilities, null)
    assert.equal(result.nativeChoice, null)
    assert.equal(result.confidence, undefined)
    assert.equal(result.metadata.costUsd, 0.001)
    assert.equal(calls, 1)
  } finally {
    await client.dispose()
  }
})
for (const [name, value] of [
  ['invented ID', { answers: { selection: { ranking: ['alien', 'a'] } } }],
  ['duplicate ID', { answers: { selection: { ranking: ['a', 'a'] } } }],
  ['incomplete ranking', { answers: { selection: { ranking: ['a'] } } }],
  [
    'extra question',
    { answers: { selection: { ranking: ['a', 'b'] }, other: { presence: 'present' } } },
  ],
  ['missing question', { answers: {} }],
  [
    'invented probabilities',
    { answers: { selection: { ranking: ['a', 'b'], probabilities: { a: 0.9, b: 0.1 } } } },
  ],
] as const) {
  await test(`vision rejects ${name} without retry`, async () => {
    let calls = 0
    const port = createOpenRouterVision({
      ...options,
      fetch: async () => {
        calls++
        return reply(value)
      },
    })
    await assert.rejects(port.decide(request, AbortSignal.timeout(1000)), {
      code: 'INVALID_RESPONSE',
    })
    assert.equal(calls, 1)
  })
}
for (const extra of [
  { model: 'another/model' },
  { provider: 'Other' },
  { choices: [{ finish_reason: 'length', message: { content: '{"answers":{}}' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] },
  {
    choices: [{ finish_reason: 'stop', message: { content: '{"answers":{}}', tool_calls: [{}] } }],
  },
]) {
  await test('vision rejects route changes, truncation, refusal and tool output', async () => {
    const port = createOpenRouterVision({ ...options, fetch: async () => reply(undefined, extra) })
    await assert.rejects(port.decide(request, AbortSignal.timeout(1000)), {
      code: 'INVALID_RESPONSE',
    })
  })
}
await test('vision supports strict schema opt-in and preserves unknown cost', async () => {
  const port = createOpenRouterVision({
    ...options,
    responseFormat: 'json-schema',
    fetch: async (_url, init) => {
      const body = z
        .object({ response_format: z.object({ type: z.string() }) })
        .parse(JSON.parse(String(init?.body)))
      assert.equal(body.response_format.type, 'json_schema')
      return reply(undefined, { usage: {} })
    },
  })
  assert.equal((await port.decide(request, AbortSignal.timeout(1000))).metadata.costUsd, null)
})
await test('vision forwards prepared images and appends task definitions after data', async () => {
  const image = await sharp({
    create: { width: 300, height: 300, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  const port = createOpenRouterVision({
    ...options,
    fetch: async (_url, init) => {
      const body = z
        .object({
          messages: z.array(
            z.object({
              content: z.union([
                z.string(),
                z.array(
                  z.object({
                    type: z.string(),
                    text: z.string().optional(),
                    image_url: z.object({ url: z.string() }).optional(),
                  }),
                ),
              ]),
            }),
          ),
        })
        .parse(JSON.parse(String(init?.body)))
      const content = body.messages[1]!.content
      assert.ok(Array.isArray(content))
      assert.ok(
        content.some(
          (part) =>
            part.type === 'image_url' && part.image_url?.url.startsWith('data:image/png;base64,'),
        ),
      )
      assert.ok(content.at(-1)?.text?.startsWith('CLASSIFICATION_TASK'))
      return reply({ answers: { selection: { ranking: ['b'] } } })
    },
  })
  const client = createClassifier({ decision: port })
  try {
    assert.equal(
      (
        await client.classify({
          input: { image },
          classes: [
            { id: 'a', description: 'A' },
            { id: 'b', description: 'B' },
          ],
        })
      ).choice,
      'b',
    )
  } finally {
    await client.dispose()
  }
})
await test('rank-only localization preserves three stages and code-derived geometry', async () => {
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls++
      const requested = request.questions['selection']
      assert.ok(requested?.type === 'choice')
      assert.equal(requested.rankingSize, calls === 3 ? 1 : 4)
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, q]) => [
          id,
          q.type === 'choice'
            ? {
                type: 'ranked-choice' as const,
                ranking: Object.keys(q.criteria).slice(0, q.rankingSize ?? 4),
              }
            : { type: 'presence' as const, presence: 'present' as const },
        ]),
      )
      return {
        answers,
        metadata: {
          model: 'fixture',
          provider: 'fixture',
          requestId: null,
          costUsd: null,
          durationMs: 0,
          attempts: 1,
        },
      }
    },
  }
  const image = await sharp({
    create: { width: 512, height: 384, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  const client = createClassifier({ decision })
  try {
    const result = await client.locate({ image, target: 'object' })
    assert.equal(result.status, 'located')
    if (result.status === 'located') {
      assert.ok(result.region.width > 0)
      assert.equal(result.selection.probabilities, null)
    }
    assert.equal(calls, 3)
  } finally {
    await client.dispose()
  }
})
await test('vision cancellation and byte caps prevent calls and hide injected errors', async () => {
  let calls = 0
  const port = createOpenRouterVision({
    ...options,
    maxRequestBytes: 20,
    fetch: async () => {
      calls++
      throw new Error('secret value')
    },
  })
  await assert.rejects(port.decide(request, AbortSignal.timeout(1000)), { code: 'RESOURCE_LIMIT' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(port.decide(request, controller.signal), { code: 'ABORTED' })
  assert.equal(calls, 0)
  const failing = createOpenRouterVision({
    ...options,
    fetch: async () => {
      throw new ClassifierError('AUTHENTICATION', 'secret value')
    },
  })
  await assert.rejects(
    failing.decide(request, AbortSignal.timeout(1000)),
    (error) =>
      error instanceof ClassifierError &&
      error.code === 'PROVIDER' &&
      !error.message.includes('secret value'),
  )
})
await test('direct OpenAI-compatible server requires no OpenRouter account or provider field', async () => {
  const { createOpenAICompatibleVision } = await import('../src/openai-compatible.js')
  const port = createOpenAICompatibleVision({
    endpoint: 'http://localhost:8000/v1/chat/completions',
    model: options.model,
    fetch: async (url, init) => {
      assert.equal(url, 'http://localhost:8000/v1/chat/completions')
      const body = z.record(z.unknown()).parse(JSON.parse(String(init?.body)))
      assert.equal(Object.hasOwn(body, 'provider'), false)
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return reply(undefined, { provider: null, usage: {} })
    },
  })
  const result = await port.decide(request, AbortSignal.timeout(1000))
  assert.equal(result.metadata.provider, null)
  assert.equal(result.metadata.costUsd, null)
  assert.equal(result.answers['selection']?.type, 'ranked-choice')
})
await test('direct server supports explicit custom authentication without forwarding it into model input', async () => {
  const { createOpenAICompatibleVision } = await import('../src/openai-compatible.js')
  const port = createOpenAICompatibleVision({
    endpoint: 'https://api.example.test/chat/completions',
    model: options.model,
    headers: { 'api-key': 'fixture-credential' },
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('api-key'), 'fixture-credential')
      assert.equal(String(init?.body).includes('fixture-credential'), false)
      return reply()
    },
  })
  await port.decide(request, AbortSignal.timeout(1000))
  assert.throws(
    () =>
      createOpenAICompatibleVision({
        endpoint: 'https://user:password@api.example.test/v1/chat/completions',
        model: options.model,
      }),
    { code: 'INVALID_INPUT' },
  )
})

await test('single-label classification rejects unused extra rankings without changing the spatial beam', async () => {
  const client = createClassifier({
    decision: createOpenRouterVision({ ...options, fetch: async () => reply() }),
  })
  try {
    await assert.rejects(
      client.classify({
        input: 'data',
        classes: [
          { id: 'a', description: 'A' },
          { id: 'b', description: 'B' },
        ],
      }),
      { code: 'INVALID_RESPONSE' },
    )
  } finally {
    await client.dispose()
  }
})
