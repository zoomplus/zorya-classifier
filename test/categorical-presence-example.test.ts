import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from 'zorya-classifier'
import { createCategoricalPresencePort } from '../examples/categorical-presence-port.js'

const metadata: DecisionResult['metadata'] = {
  model: 'fixture',
  provider: 'fixture',
  requestId: 'local',
  durationMs: 1,
  costUsd: null,
  attempts: 1,
}
const originalChoice = {
  type: 'choice' as const,
  choice: 'b',
  probabilities: { a: 0.2, b: 0.8 },
}

function validRequest(): DecisionRequest {
  return {
    state: ['fixture image context'],
    questions: {
      spatial: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'Pick a cell.',
        criteria: { a: 'Cell A', b: 'Cell B' },
      },
      present: { type: 'noul', instructions: 'The target is visible in this image.' },
    },
  }
}

await test('one batched call preserves scored Choice and converts Noul with stable categorical tie', async () => {
  let calls = 0
  let seen: DecisionRequest | undefined
  const delegate: DecisionPort = {
    async decide(request) {
      calls++
      seen = request
      return {
        answers: {
          spatial: originalChoice,
          present: {
            type: 'choice',
            choice: 'unknown',
            probabilities: { present: 0.5, absent: 0, unknown: 0.5 },
          },
        },
        metadata,
      }
    },
  }
  const adapter = createCategoricalPresencePort(delegate)
  const result = await adapter.decide(validRequest(), new AbortController().signal)
  assert.equal(calls, 1)
  assert.deepEqual(Object.keys(seen!.questions), ['spatial', 'present'])
  assert.equal(seen!.questions.present?.type, 'choice')
  assert.equal(seen!.questions.present?.type === 'choice' && seen!.questions.present.rankingSize, 1)
  assert.match(
    seen!.questions.present?.type === 'choice' ? seen!.questions.present.instructions : '',
    /Exact proposition:\nThe target is visible in this image\./,
  )
  assert.deepEqual(result.answers.spatial, originalChoice)
  // Criteria order is present, absent, unknown: a tie chooses the stable first maximum.
  assert.deepEqual(result.answers.present, { type: 'presence', presence: 'present' })
})

await test('rank-only categorical response stays categorical without fabricated scores', async () => {
  const delegate: DecisionPort = {
    async decide() {
      return {
        answers: {
          spatial: originalChoice,
          present: { type: 'ranked-choice', ranking: ['absent'] },
        },
        metadata,
      }
    },
  }
  const result = await createCategoricalPresencePort(delegate).decide(
    validRequest(),
    new AbortController().signal,
  )
  assert.deepEqual(result.answers.present, { type: 'presence', presence: 'absent' })
})

await test('accepts only explicitly annotated rounded mass for categorical conversion', async () => {
  const request: DecisionRequest = {
    state: ['fixture'],
    questions: { present: { type: 'noul', instructions: 'The target is visible.' } },
  }
  const run = (answer: DecisionResult['answers'][string]) =>
    createCategoricalPresencePort({
      async decide() {
        return { answers: { present: answer }, metadata }
      },
    }).decide(request, new AbortController().signal)

  const accepted = await run({
    type: 'choice',
    choice: 'present',
    probabilities: { present: 0.33, absent: 0.33, unknown: 0.33 },
    probabilityRoundingStep: 0.01,
  })
  assert.deepEqual(accepted.answers.present, { type: 'presence', presence: 'present' })
  await assert.rejects(
    run({
      type: 'choice',
      choice: 'present',
      probabilities: { present: 0.33, absent: 0.33, unknown: 0.33 },
    }),
  )
  await assert.rejects(
    run({
      type: 'choice',
      choice: 'present',
      probabilities: { present: 0.34, absent: 0.34, unknown: 0.34 },
      probabilityRoundingStep: 0.01,
    }),
  )
})

await test('a Choice-only request remains Choice-only and omits absent optional fields', async () => {
  let calls = 0
  let seen!: DecisionRequest
  const request: DecisionRequest = {
    state: ['fixture'],
    questions: {
      label: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'A', b: 'B' } },
    },
  }
  const result = await createCategoricalPresencePort({
    async decide(outgoing) {
      calls++
      seen = outgoing
      return { answers: { label: originalChoice }, metadata }
    },
  }).decide(request, new AbortController().signal)
  assert.equal(calls, 1)
  assert.deepEqual(seen.questions, request.questions)
  assert.equal(Object.hasOwn(seen.questions.label!, 'rankingSize'), false)
  assert.deepEqual(result.answers.label, originalChoice)
})

await test('rejects an incomplete closed distribution and does not call delegate after abort', async () => {
  let calls = 0
  const bad: DecisionPort = {
    async decide() {
      calls++
      return {
        answers: {
          spatial: originalChoice,
          present: { type: 'choice', choice: 'present', probabilities: { present: 1 } },
        },
        metadata,
      }
    },
  }
  await assert.rejects(
    createCategoricalPresencePort(bad).decide(validRequest(), new AbortController().signal),
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(createCategoricalPresencePort(bad).decide(validRequest(), controller.signal))
  assert.equal(calls, 1)
})

await test('snapshots caller request before await and propagates cancellation after the native call', async () => {
  let release!: (value: DecisionResult) => void
  let seen!: DecisionRequest
  const delegate: DecisionPort = {
    decide(request) {
      seen = request
      return new Promise((resolve) => {
        release = resolve
      })
    },
  }
  const controller = new AbortController()
  const request = validRequest()
  const pending = createCategoricalPresencePort(delegate).decide(request, controller.signal)
  request.state[0] = 'mutated after call'
  assert.equal(seen.state[0], 'fixture image context')
  controller.abort()
  release({
    answers: { spatial: originalChoice, present: { type: 'ranked-choice', ranking: ['present'] } },
    metadata,
  })
  await assert.rejects(pending)
})
