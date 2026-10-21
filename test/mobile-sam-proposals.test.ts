import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  mobileSamProposalPoints,
  packMobileSamProposalCandidates,
  mobileSamSegmentationPrompt,
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

await test('seed-center profile uses one exact geometric-center point and preserves default grid', () => {
  const seed = { left: 7, top: 11, width: 6, height: 5 }
  assert.deepEqual(mobileSamProposalPoints(seed, 'seed-center'), [{ x: 9.5, y: 13 }])
  const legacyPrompt = mobileSamSegmentationPrompt({
    prompt: 'seed-region',
    seedRegion: seed,
    wholeRegion: seed,
    xScale: 0.75,
    yScale: 0.5,
  })
  assert.deepEqual(
    mobileSamProposalPoints(seed, 'seed-center').map((point) => [point.x * 0.75, point.y * 0.5]),
    [[legacyPrompt.coordinates[0], legacyPrompt.coordinates[1]]],
    'seed-center matches the historical fractional seed prompt coordinates',
  )
  assert.equal(
    mobileSamProposalPoints(seed).length,
    9,
    'omitted profile remains nine-point compatible',
  )
  assert.throws(
    () => mobileSamProposalPoints({ left: 7, top: 11, width: 0, height: 5 }, 'seed-center'),
    /rectangle/u,
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

await test('seed-center retains exactly C00..C03 as packed masks clipped to visible ROI', () => {
  const width = 5
  const height = 3
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) rgba[index * 4 + 3] = 255
  rgba[(1 * width + 2) * 4 + 3] = 0
  const proposals = packMobileSamProposalCandidates({
    width,
    height,
    rgba,
    roi: { left: 1, top: 1, width: 3, height: 2 },
    pointIndex: 0,
    logits: new Float32Array(4 * width * height).fill(1),
    scores: Float32Array.of(0.1, 0.2, 0.3, 0.4),
  })
  assert.deepEqual(
    proposals.map(({ id }) => id),
    ['C00', 'C01', 'C02', 'C03'],
  )
  assert.deepEqual(
    [
      ...unpackBinaryMask({
        data: Buffer.from(proposals[0]!.mask, 'base64'),
        width,
        height,
        format: 'binary-lsb0',
      }),
    ],
    [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0],
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
