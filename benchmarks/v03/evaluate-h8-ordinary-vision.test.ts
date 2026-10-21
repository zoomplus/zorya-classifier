import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateH8RankOnlySelection,
  type H8RankOnlySelection,
} from './evaluate-h8-ordinary-vision.js'

const selection: H8RankOnlySelection = {
  choice: 'D01',
  ranking: ['D01', 'D02', 'none'],
  probabilities: null,
  nativeChoice: null,
  tied: [],
}

await test('H8 evaluator accepts a closed rank-only response', () => {
  assert.doesNotThrow(() => validateH8RankOnlySelection(selection, ['D01', 'D02', 'none']))
})

await test('H8 evaluator rejects inferred probabilities and nonleading choices', () => {
  assert.throws(() =>
    validateH8RankOnlySelection(
      { ...selection, probabilities: { D01: 0.9 } } as unknown as H8RankOnlySelection,
      ['D01', 'D02', 'none'],
    ),
  )
  assert.throws(() =>
    validateH8RankOnlySelection({ ...selection, choice: 'D02' }, ['D01', 'D02', 'none']),
  )
  assert.throws(() =>
    validateH8RankOnlySelection({ ...selection, ranking: ['D01', 'D01'] }, ['D01', 'D02', 'none']),
  )
})
