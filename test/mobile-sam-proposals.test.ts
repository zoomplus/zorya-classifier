import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  mobileSamProposalPoints,
  packMobileSamProposalCandidates,
} from '../src/infrastructure/segmentation/mobile-sam/worker-inference.js'
import { unpackBinaryMask } from '../src/features/segmentation/packed-mask.js'

await test('MobileSAM maps a seed rectangle to nine bounded row-major prompt points', () => {
  assert.deepEqual(mobileSamProposalPoints({ left: 2, top: 1, width: 5, height: 6 }), [
    { x: 2, y: 1 },
    { x: 4, y: 1 },
    { x: 6, y: 1 },
    { x: 2, y: 4 },
    { x: 4, y: 4 },
    { x: 6, y: 4 },
    { x: 2, y: 6 },
    { x: 4, y: 6 },
    { x: 6, y: 6 },
  ])
  assert.deepEqual(
    mobileSamProposalPoints({ left: 3, top: 4, width: 1, height: 1 }),
    Array.from({ length: 9 }, () => ({ x: 3, y: 4 })),
  )
})

await test('proposal packing retains all four tokens, hard-clips ROI and invisible pixels', () => {
  const width = 3
  const height = 2
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) rgba[index * 4 + 3] = 255
  rgba[1 * 4 + 3] = 0
  const logits = new Float32Array(4 * width * height).fill(1)
  const proposals = packMobileSamProposalCandidates({
    width,
    height,
    rgba,
    roi: { left: 1, top: 0, width: 2, height: 2 },
    pointIndex: 2,
    logits,
    scores: Float32Array.of(-0.1, 0.2, 1.3, 0.4),
  })
  assert.deepEqual(
    proposals.map(({ id }) => id),
    ['C08', 'C09', 'C10', 'C11'],
  )
  assert.deepEqual(
    proposals.map(({ qualityScore }) => Math.round((qualityScore ?? 0) * 10) / 10),
    [-0.1, 0.2, 1.3, 0.4],
  )
  assert.equal(proposals.length, 4)
  assert.deepEqual(
    [
      ...unpackBinaryMask({
        data: Buffer.from(proposals[0]!.mask, 'base64'),
        width,
        height,
        format: 'binary-lsb0',
      }),
    ],
    [0, 0, 1, 0, 1, 1],
  )
})

await test('proposal packing rejects invalid decoder tensors and non-finite scores', () => {
  const base = {
    width: 1,
    height: 1,
    rgba: Uint8Array.of(1, 2, 3, 255),
    roi: { left: 0, top: 0, width: 1, height: 1 },
    pointIndex: 0,
    logits: new Float32Array(4),
    scores: Float32Array.of(0.5, 0.5, 0.5, Number.NaN),
  }
  assert.throws(() => packMobileSamProposalCandidates(base), /quality/)
  assert.throws(
    () => packMobileSamProposalCandidates({ ...base, logits: new Float32Array(3) }),
    /dimensions/,
  )
})
