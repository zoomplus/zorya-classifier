import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalizeControlledUiTruth,
  parseControlledUiTruthJsonl,
} from '../benchmarks/v02/canonical-ui-truth.js'

const provenance = {
  action: 'fixture action',
  oracle: 'fixture allocation',
  scope: 'fixture toolbar',
}
const positive = {
  ...provenance,
  id: 'fixture-positive',
  kind: 'positive',
  bbox: { x: 20, y: 10, width: 40, height: 30 },
  allocation: [20, 10, 40, 30],
  paintEvidence: {
    fourEdgeMagentaCoverage: { top: 0.9, bottom: 0.9, left: 0.9, right: 0.9 },
    innerGreenCoverage: 0.9,
    passes: true,
  },
}
const negative = {
  ...provenance,
  id: 'fixture-negative',
  kind: 'negative',
  bbox: null,
  negativeEvidence: {
    completeATSPIPushToggleInventory: true,
    exactActionAbsent: true,
    inventorySha256: 'a'.repeat(64),
  },
}
const producers = [
  { caseId: negative.id, image: { width: 200, height: 100 } },
  { caseId: positive.id, image: { width: 200, height: 100 } },
]

await test('controlled UI truth keeps measured geometry and source absence in producer order', () => {
  const rows = canonicalizeControlledUiTruth([positive, negative], producers)
  assert.equal(rows[0]?.expectedPresence, 'absent')
  assert.deepEqual(rows[0]?.targetBoxes, [])
  assert.equal(rows[0]?.negativeEvidence?.inventorySha256, 'a'.repeat(64))
  assert.deepEqual(rows[1]?.targetBoxes, [{ xyxy: [0.1, 0.1, 0.3, 0.4] }])
  assert.equal(rows[1]?.negativeEvidence, null)
  assert.equal(rows[1]?.provenance.sourceRecordId, positive.id)
})

await test('controlled UI truth rejects missing, duplicate and unproved source records', () => {
  assert.throws(() => canonicalizeControlledUiTruth([positive], producers))
  assert.throws(() => canonicalizeControlledUiTruth([positive, positive], producers))
  assert.throws(() =>
    canonicalizeControlledUiTruth([positive, negative], [producers[0], producers[0]]),
  )
  assert.throws(() =>
    canonicalizeControlledUiTruth(
      [{ ...positive, paintEvidence: { ...positive.paintEvidence, passes: false } }, negative],
      producers,
    ),
  )
  assert.throws(() =>
    canonicalizeControlledUiTruth(
      [
        positive,
        {
          ...negative,
          negativeEvidence: { ...negative.negativeEvidence, exactActionAbsent: false },
        },
      ],
      producers,
    ),
  )
})

await test('controlled UI truth rejects escaped, mismatched or unconfirmed visible bounds', () => {
  for (const invalid of [
    { ...positive, bbox: { x: 190, y: 10, width: 40, height: 30 } },
    { ...positive, allocation: [21, 10, 40, 30] },
    {
      ...positive,
      paintEvidence: {
        ...positive.paintEvidence,
        fourEdgeMagentaCoverage: { ...positive.paintEvidence.fourEdgeMagentaCoverage, left: 0.79 },
      },
    },
  ])
    assert.throws(() => canonicalizeControlledUiTruth([invalid, negative], producers))
})

await test('UI JSONL parser accepts complete CRLF records and rejects invalid framing and size', () => {
  assert.deepEqual(
    parseControlledUiTruthJsonl(`${JSON.stringify(positive)}\r\n${JSON.stringify(negative)}\r\n`),
    [positive, negative],
  )
  for (const invalid of [
    '',
    '{}\n\n',
    '{}\n \n{}',
    '{broken}',
    '{}\n'.repeat(121),
    ' '.repeat(1024 * 1024 + 1),
  ])
    assert.throws(() => parseControlledUiTruthJsonl(invalid))
})
