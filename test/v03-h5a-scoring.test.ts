import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreCandidate } from '../benchmarks/v03/evaluate-h5a-native-proposals.js'

await test('H5a scores a candidate against any passing reference instance', () => {
  const candidate = { left: 0, top: 0, width: 100, height: 100 }
  const references = [
    { left: 0, top: 0, width: 120, height: 120 },
    { left: 10, top: 10, width: 80, height: 80 },
  ]

  assert.deepEqual(scoreCandidate(candidate, references), {
    iou: 0.64,
    coverage: 1,
    pass: true,
  })
})
