import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionRequest } from '../src/entities/contracts.js'
import { createDecisionTrace } from '../benchmarks/v02/protocol.js'

function trace(questionId: 'selection' | 'presence', ids: string[], winner: string) {
  const request: DecisionRequest = {
    state: ['Synthetic trace fixture.'],
    questions: {
      [questionId]: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'Choose one supplied option.',
        criteria: Object.fromEntries(ids.map((id) => [id, `Option ${id}`])),
      },
    },
  }
  return createDecisionTrace(request, {
    answers: {
      [questionId]: {
        type: 'choice',
        choice: winner,
        probabilities: Object.fromEntries(ids.map((id) => [id, id === winner ? 1 : 0])),
      },
    },
    metadata: {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 0,
      costUsd: 0,
      attempts: 1,
    },
  }).trace
}

await test('recorded decision traces retain all bounded D/U candidate aliases', () => {
  const ids = [
    'none',
    ...['D', 'U'].flatMap((family) =>
      Array.from({ length: 36 }, (_, i) => `${family}${String(i).padStart(2, '0')}`),
    ),
  ]
  const result = trace('selection', ids, 'U35')
  assert.equal(result.status, 'recorded')
  if (result.status !== 'recorded') throw new Error('Expected a complete trace')
  const question = result.questions[0]
  assert.equal(question?.answerType, 'choice')
  if (question?.answerType !== 'choice') throw new Error('Expected Choice evidence')
  assert.equal(question.selected, 'U35')
  assert.equal(question.probabilities?.length, 73)
})

await test('categorical presence retains uncertain without converting it to absence', () => {
  const result = trace('presence', ['present', 'absent', 'uncertain'], 'uncertain')
  assert.equal(result.status, 'recorded')
  if (result.status !== 'recorded') throw new Error('Expected a complete presence trace')
  const question = result.questions[0]
  assert.equal(question?.answerType, 'choice')
  if (question?.answerType !== 'choice') throw new Error('Expected Choice evidence')
  assert.equal(question.selected, 'uncertain')
  assert.deepEqual(question.probabilities, [
    { optionId: 'present', value: 0 },
    { optionId: 'absent', value: 0 },
    { optionId: 'uncertain', value: 1 },
  ])
})

await test('trace allowlist still omits unknown labels and out-of-range family aliases', () => {
  for (const invalid of ['D36', 'U36', 'D999', 'U999', 'caller-text', 'uncertain']) {
    assert.deepEqual(trace('selection', ['none', invalid], invalid), {
      status: 'omitted',
      reason: 'unrecognized-option-id',
    })
  }
})
