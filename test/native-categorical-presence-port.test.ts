import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'
import { createNativeCategoricalPresencePort } from '../benchmarks/v02/native-categorical-presence-port.js'

const request: DecisionRequest = {
  state: [
    'Judge the same physical instance and select a supplied spatial interval.',
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
  ],
  questions: {
    extent: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Select the interval covering the complete instance.',
      criteria: { left00: 'Integer coordinates in [0, 8).', unknown: 'Cannot determine.' },
    },
    sameInstance: {
      type: 'noul',
      instructions: 'Does this interval contain the same complete physical instance?',
    },
  },
}

function nativeResult(
  answers: DecisionResult['answers'],
  model = 'openai/gpt-6-luna-decisions',
): DecisionResult {
  return {
    answers,
    metadata: {
      model,
      provider: 'openai',
      requestId: 'one-native-request',
      durationMs: 123,
      costUsd: 0.001,
      attempts: 1,
    },
  }
}

function port(decide: DecisionPort['decide']): DecisionPort {
  return { decide }
}

await test('one native Choice request carries spatial and converted categorical questions', async () => {
  let calls = 0
  const native = port(async (actual) => {
    calls++
    assert.deepEqual(actual.state, request.state)
    assert.deepEqual(Object.keys(actual.questions), ['extent', 'sameInstance'])
    const converted = actual.questions.sameInstance
    assert.ok(converted?.type === 'choice')
    assert.equal(converted.rankingSize, 1)
    assert.deepEqual(Object.keys(converted.criteria), ['present', 'absent', 'unknown'])
    assert.ok(converted.instructions.endsWith(request.questions.sameInstance!.instructions))
    return nativeResult({
      extent: { type: 'ranked-choice', ranking: ['left00'] },
      sameInstance: {
        type: 'choice',
        choice: 'unknown',
        probabilities: { present: 0.2, absent: 0.3, unknown: 0.5 },
      },
    })
  })

  const actual = await createNativeCategoricalPresencePort(native).decide(
    request,
    new AbortController().signal,
  )
  assert.equal(calls, 1)
  assert.deepEqual(actual.answers.extent, {
    type: 'ranked-choice',
    ranking: ['left00'],
  })
  assert.deepEqual(actual.answers.sameInstance, { type: 'presence', presence: 'unknown' })
  assert.deepEqual(actual.metadata, nativeResult({}).metadata)
})

await test('native-only categorical adapter passes a Choice-only request through in one call', async () => {
  let calls = 0
  const expected = nativeResult({ extent: { type: 'ranked-choice', ranking: ['left00'] } })
  const actual = await createNativeCategoricalPresencePort(
    port(async () => {
      calls++
      return expected
    }),
  ).decide(
    { state: request.state, questions: { extent: request.questions.extent! } },
    new AbortController().signal,
  )
  assert.equal(calls, 1)
  assert.deepEqual(actual, expected)
})

await test('native-only categorical adapter rejects missing converted answers', async () => {
  const native = port(async () => nativeResult({}))
  await assert.rejects(
    createNativeCategoricalPresencePort(native).decide(request, new AbortController().signal),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
})
