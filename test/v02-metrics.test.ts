import assert from 'node:assert/strict'
import test from 'node:test'
import {
  binaryMaskIoU,
  pairedBootstrap,
  wholeObjectMatch,
  wholeObjectMetrics,
} from '../benchmarks/v02/metrics.js'
import type { Box, LocalizationCase, PairedOutcome } from '../benchmarks/v02/metrics.js'

const target: Box = { left: 20, top: 20, width: 20, height: 20 }

await test('whole-object scoring rejects a cell inside an object and an image-sized box', () => {
  assert.equal(wholeObjectMatch(target, [target]).matched, true)
  assert.equal(wholeObjectMatch({ ...target, width: 10, height: 10 }, [target]).matched, false)
  assert.equal(
    wholeObjectMatch({ left: 0, top: 0, width: 100, height: 100 }, [target]).matched,
    false,
  )
  // IoU passes, but losing 15% of the visible object must still fail coverage.
  assert.equal(wholeObjectMatch({ ...target, width: 17 }, [target]).matched, false)
})

await test('one predicted object may match any instance, without claiming all-instance recall', () => {
  const result = wholeObjectMatch(target, [{ ...target, left: 80 }, target])
  assert.equal(result.matched, true)
  assert.equal(result.instances[0]?.matched, false)
  assert.equal(result.instances[1]?.matched, true)
})

await test('unknown and failed cases cannot disappear from positive denominators', () => {
  const cases: LocalizationCase[] = [
    {
      caseId: 'hit',
      expected: { presence: 'present', boxes: [target] },
      outcome: { status: 'located', region: target },
    },
    {
      caseId: 'unknown',
      expected: { presence: 'present', boxes: [target] },
      outcome: { status: 'unknown' },
    },
    {
      caseId: 'failed',
      expected: { presence: 'present', boxes: [target] },
      outcome: { status: 'failed' },
    },
    {
      caseId: 'negative',
      expected: { presence: 'absent', verified: true },
      outcome: { status: 'located', region: target },
    },
  ]
  const result = wholeObjectMetrics(cases)
  assert.equal(result.attempted, 4)
  assert.equal(result.localizationRate, 1 / 3)
  assert.equal(result.falseLocations, 1)
  assert.equal(result.falseLocationRate, 1)
  assert.equal(result.unknown, 1)
  assert.equal(result.failed, 1)
})

await test('binary mask scoring uses source pixels, validates binary format and rejects empty GT', () => {
  assert.deepEqual(binaryMaskIoU(Uint8Array.of(1, 1, 0, 0), Uint8Array.of(1, 1, 0, 0)), {
    intersection: 2,
    union: 2,
    iou: 1,
    matched: true,
  })
  assert.equal(binaryMaskIoU(Uint8Array.of(1, 0, 0, 0), Uint8Array.of(1, 1, 0, 0)).matched, false)
  assert.throws(() => binaryMaskIoU(Uint8Array.of(255), Uint8Array.of(1)), RangeError)
  assert.throws(() => binaryMaskIoU(Uint8Array.of(1), Uint8Array.of(0)), RangeError)
  assert.throws(() => binaryMaskIoU(Uint8Array.of(1), Uint8Array.of(1, 0)), RangeError)
})

await test('paired bootstrap is deterministic and preserves schedule-independent pairing', () => {
  const pairs: PairedOutcome[] = Array.from({ length: 30 }, (_, index) => ({
    caseId: `photo-${index}`,
    candidate: true,
    control: false,
  }))
  const result = pairedBootstrap(pairs)
  assert.equal(result.lower, 1)
  assert.equal(result.upper, 1)
  assert.equal(result.passes, true)
  assert.deepEqual(pairedBootstrap(pairs.toReversed()), result)
  assert.equal(
    pairedBootstrap([{ caseId: 'same', candidate: false, control: false }]).passes,
    false,
  )
  assert.throws(() => pairedBootstrap([]), RangeError)
  assert.throws(() => pairedBootstrap([pairs[0]!, pairs[0]!]), RangeError)
})
