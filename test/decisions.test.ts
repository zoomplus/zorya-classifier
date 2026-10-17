import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClassifier } from '../src/index.js'
import { createOpenRouterDecisions } from '../src/openrouter.js'
import type { DecisionRequest } from '../src/index.js'
import { z } from 'zod'
const model = 'openai/gpt-6-luna-decisions'
const request: DecisionRequest = {
  state: ['fixture'],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Pick',
      criteria: { a: 'A', b: 'B' },
    },
  },
}
function response(probabilities = { a: 0.6, b: 0.4 }, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      model: model + '-20261006',
      provider: 'OpenAI',
      answers: { selection: { type: 'choice', choice: 'a', probabilities } },
      usage: { cost: 0.0001 },
      ...extra,
    }),
  )
}
await test('native Luna Decisions uses a pinned typed API, strips chat-only ranking hints and preserves real probabilities', async () => {
  let calls = 0
  const decision = createOpenRouterDecisions({
    apiKey: 'fixture',
    model,
    provider: 'openai',
    fetch: async (url, init) => {
      calls++
      assert.equal(url, 'https://openrouter.ai/api/alpha/decisions')
      const body = z.record(z.unknown()).parse(JSON.parse(String(init?.body)))
      assert.equal(body['model'], model)
      assert.deepEqual(body['provider'], { only: ['openai'], allow_fallbacks: false })
      assert.equal(String(init?.body).includes('rankingSize'), false)
      assert.equal(Object.hasOwn(body, 'messages'), false)
      return response()
    },
  })
  const client = createClassifier({ decision })
  try {
    const result = await client.classify({
      input: 'fixture',
      classes: [
        { id: 'a', description: 'A' },
        { id: 'b', description: 'B' },
      ],
    })
    assert.equal(result.choice, 'a')
    assert.deepEqual(result.probabilities, { a: 0.6, b: 0.4 })
    assert.equal(result.ranking, undefined)
    assert.equal(calls, 1)
  } finally {
    await client.dispose()
  }
})
await test('generic native adapter does not inherit Jev rounding assumptions', async () => {
  const options = {
    apiKey: 'fixture',
    model,
    provider: 'openai',
    fetch: async () => response({ a: 0.5, b: 0.49 }),
  }
  await assert.rejects(
    createOpenRouterDecisions(options).decide(request, AbortSignal.timeout(1000)),
    { code: 'INVALID_RESPONSE' },
  )
  const result = await createOpenRouterDecisions({
    ...options,
    probabilityRoundingStep: 0.01,
  }).decide(request, AbortSignal.timeout(1000))
  assert.equal(result.answers['selection']?.type, 'choice')
  assert.deepEqual(
    result.answers['selection']?.type === 'choice' && result.answers['selection'].probabilities,
    { a: 0.5, b: 0.49 },
  )
})
for (const extra of [
  { model: 'typesafe/jev-1.14' },
  { provider: 'Other' },
  { model: model + '-20260230' },
]) {
  await test('native decision adapter rejects route/identity changes without fallback', async () => {
    let calls = 0
    const port = createOpenRouterDecisions({
      apiKey: 'fixture',
      model,
      provider: 'openai',
      fetch: async () => {
        calls++
        return response(undefined, extra)
      },
    })
    await assert.rejects(port.decide(request, AbortSignal.timeout(1000)), {
      code: 'INVALID_RESPONSE',
    })
    assert.equal(calls, 1)
  })
}
