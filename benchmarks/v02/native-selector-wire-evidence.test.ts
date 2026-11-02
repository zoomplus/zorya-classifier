import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionRequest } from '../../src/entities/contracts.js'
import {
  buildNativeWireEvidence,
  nativeWireQuestionSpecs,
} from './native-selector-wire-evidence.js'

const selectionIds = Array.from({ length: 9 }, (_, index) => `D${String(index).padStart(2, '0')}`)
const request: DecisionRequest = {
  state: [],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Select one supplied candidate.',
      criteria: Object.fromEntries(selectionIds.map((id) => [id, 'candidate'])),
    },
    presence: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Is the target present?',
      criteria: { present: 'Present', absent: 'Absent' },
    },
  },
}

function capture(input: {
  selectionScores: Record<string, number>
  presenceScores?: Record<string, number>
}) {
  const responseBytes = Buffer.from('controlled response')
  return buildNativeWireEvidence({
    expectedQuestions: nativeWireQuestionSpecs(request),
    responseBytes,
    responseBody: {
      answers: {
        selection: { type: 'choice', choice: 'D00', probabilities: input.selectionScores },
        presence: {
          type: 'choice',
          choice: 'present',
          probabilities: input.presenceScores ?? { present: 1, absent: 0 },
        },
        unrelated: { choice: 'secret', probabilities: { secret: 1 } },
      },
      arbitrary: 'must not be retained',
    },
    logicalId: 3,
    recorderPhysicalId: 2,
    requestSha256: 'a'.repeat(64),
    requestBodySha256: 'b'.repeat(64),
  })
}

await test('native wire evidence preserves raw fractional scores and only the closed vocabulary', () => {
  const selectionScores = Object.fromEntries(selectionIds.map((id) => [id, 1 / 9]))
  const evidence = capture({ selectionScores })
  assert.equal(evidence.schema, 'h8a-native-selector-wire-evidence-v1')
  assert.equal(evidence.logicalId, 3)
  assert.equal(evidence.recorderPhysicalId, 2)
  assert.equal(evidence.responseByteLength, Buffer.byteLength('controlled response'))
  assert.equal(evidence.questions.length, 2)
  assert.equal(evidence.questions[0]?.scores[0]?.value, 1 / 9)
  assert.equal(evidence.questions[0]?.validity, 'valid')
  assert.equal(evidence.questions[1]?.scores[0]?.value, 1)
  assert.equal(JSON.stringify(evidence).includes('must not be retained'), false)
  assert.equal(JSON.stringify(evidence).includes('secret'), false)
})

await test('native wire evidence retains invalid raw mass without normalization', () => {
  const scores = Object.fromEntries(selectionIds.map((id, index) => [id, index < 2 ? 0.25 : 0]))
  const evidence = capture({ selectionScores: scores })
  assert.equal(evidence.questions[0]?.validity, 'invalid')
  assert.equal(evidence.questions[0]?.scores[0]?.value, 0.25)
  assert.equal(evidence.questions[0]?.scores[1]?.value, 0.25)
  assert.equal(evidence.questions[0]?.mass, 0.5)
})

await test('native wire evidence reports missing question scores and preserves small exact values', () => {
  const scores = Object.fromEntries(selectionIds.map((id, index) => [id, index === 0 ? 1 / 6 : 0]))
  const evidence = capture({
    selectionScores: scores,
    presenceScores: { present: 1 / 6, absent: 1 / 9 },
  })
  assert.equal(evidence.questions[0]?.scores[0]?.value, 1 / 6)
  assert.equal(evidence.questions[1]?.scores[0]?.value, 1 / 6)
  assert.equal(evidence.questions[1]?.scores[1]?.value, 1 / 9)
  const missing = capture({ selectionScores: {} })
  assert.equal(missing.questions[0]?.validity, 'missing')
  assert.equal(missing.questions[0]?.scores.length, 0)
})

await test('native wire evidence retains finite out-of-range wire values as invalid diagnostics', () => {
  const scores = Object.fromEntries(selectionIds.map((id, index) => [id, index === 0 ? 1.2 : -0.2]))
  const evidence = capture({ selectionScores: scores })
  assert.equal(evidence.questions[0]?.validity, 'invalid')
  assert.equal(evidence.questions[0]?.scores[0]?.value, 1.2)
  assert.equal(evidence.questions[0]?.scores[1]?.value, -0.2)
})

await test('native wire evidence preserves all 36 aliases plus the none option', () => {
  const ids = [
    ...Array.from({ length: 36 }, (_, index) => `D${String(index).padStart(2, '0')}`),
    'none',
  ]
  const manyOptionRequest: DecisionRequest = {
    state: [],
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'Select the best supplied candidate or none.',
        criteria: Object.fromEntries(ids.map((id) => [id, 'candidate or none'])),
      },
    },
  }
  const specs = nativeWireQuestionSpecs(manyOptionRequest)
  assert.equal(specs.length, 1)
  assert.equal(specs[0]?.expectedOptionIds.length, 37)
  assert.equal(specs[0]?.expectedOptionIds.at(-1), 'none')
  const evidence = buildNativeWireEvidence({
    expectedQuestions: specs,
    responseBytes: Buffer.from('controlled 37-option response'),
    responseBody: {
      answers: {
        selection: {
          type: 'choice',
          choice: 'none',
          probabilities: Object.fromEntries(
            [...ids].reverse().map((id) => [id, id === 'none' ? 1 : 0]),
          ),
        },
      },
    },
    logicalId: 1,
    recorderPhysicalId: 1,
    requestSha256: 'c'.repeat(64),
    requestBodySha256: 'd'.repeat(64),
  })
  assert.equal(evidence.questions[0]?.expectedOptionIds.length, 37)
  assert.equal(evidence.questions[0]?.scores.length, 37)
  assert.equal(evidence.questions[0]?.chosenOptionId, 'none')
  assert.equal(evidence.questions[0]?.selectedValidity, 'valid')
  assert.equal(evidence.questions[0]?.validity, 'valid')
})
