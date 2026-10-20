import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  nativeMobileSamExpansionReplySchema,
  nativeSegmentationRequestSchema,
} from '../src/infrastructure/segmentation/native-protocol.js'
import {
  packFullSourceBinaryMask,
  selectEnclosingMobileSamCandidate,
  unpackFullSourceBinaryMask,
  validateMobileSamPreviousMask,
} from '../src/infrastructure/segmentation/mobile-sam/worker-inference.js'

const id = 'a0000000-0000-4000-8000-000000000001'
const options = {
  encoderPath: '/models/encoder.onnx',
  decoderPath: '/models/decoder.onnx',
  executionProvider: 'cpu' as const,
  threads: 2,
}

function expansionRequest(width: number, height: number, previousMask: string) {
  const pixels = width * height
  return {
    id,
    kind: 'mobile-sam-expand',
    width,
    height,
    rgba: Buffer.alloc(pixels * 4).toString('base64'),
    previousMask,
    seedRegion: { left: 0, top: 0, width: 1, height: 1 },
    wholeRegion: { left: 0, top: 0, width, height },
    roi: { left: 0, top: 0, width, height },
    prompt: 'seed-region',
    options,
  }
}

function rgba(width: number, height: number, transparent: readonly number[] = []) {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) data[index * 4 + 3] = 255
  for (const index of transparent) data[index * 4 + 3] = 0
  return data
}

function logitsFor(width: number, height: number, candidates: readonly (readonly number[])[]) {
  const pixels = width * height
  const logits = new Float32Array(pixels * 4)
  for (let token = 0; token < candidates.length; token++)
    for (const index of candidates[token] ?? []) logits[token * pixels + index] = 1
  return logits
}

await test('expansion wire schema is strict and bounds packed full-source masks', () => {
  const previous = new Uint8Array(4)
  previous[0] = 1
  const packed = packFullSourceBinaryMask(previous, 2, 2)
  const valid = expansionRequest(2, 2, Buffer.from(packed).toString('base64'))
  assert.equal(nativeSegmentationRequestSchema.safeParse(valid).success, true)
  assert.equal(
    nativeSegmentationRequestSchema.safeParse({ ...valid, extra: 'ignored?' }).success,
    false,
  )
  assert.equal(
    nativeSegmentationRequestSchema.safeParse({ ...valid, previousMask: '!!!!' }).success,
    false,
  )
  assert.equal(
    nativeSegmentationRequestSchema.safeParse({
      ...valid,
      previousMask: Buffer.alloc(2).toString('base64'),
    }).success,
    false,
  )
  assert.equal(
    nativeMobileSamExpansionReplySchema.safeParse({
      id,
      status: 'unknown',
      reason: 'no-enclosing-mask',
      width: 2,
      height: 2,
      method: 'mobile-sam-enclosing-mask-v1',
    }).success,
    true,
  )
  assert.equal(
    nativeMobileSamExpansionReplySchema.safeParse({
      id,
      status: 'unknown',
      reason: 'malformed-reason',
      width: 2,
      height: 2,
      method: 'mobile-sam-enclosing-mask-v1',
    }).success,
    false,
  )
})

await test('full-source packing supports segmentation-sized masks beyond proposal limits', () => {
  const width = 1921
  const height = 1081
  const mask = new Uint8Array(width * height)
  mask[0] = 1
  mask[mask.length - 1] = 1
  const packed = packFullSourceBinaryMask(mask, width, height)
  assert.equal(packed.length, Math.ceil((width * height) / 8))
  assert.deepEqual(unpackFullSourceBinaryMask(packed, width, height), mask)
  const badPadding = new Uint8Array(packed)
  badPadding[badPadding.length - 1] = (badPadding.at(-1) ?? 0) | 0x80
  assert.throws(() => unpackFullSourceBinaryMask(badPadding, width, height), /padding/)
})

await test('previous mask validation requires visible binary foreground inside the ROI', () => {
  const width = 5
  const height = 4
  const image = rgba(width, height)
  const previous = new Uint8Array(width * height)
  previous[2 * width + 2] = 1
  assert.equal(
    validateMobileSamPreviousMask({
      width,
      height,
      rgba: image,
      previousMask: previous,
      roi: { left: 1, top: 1, width: 3, height: 2 },
    }).area,
    1,
  )
  assert.throws(
    () =>
      validateMobileSamPreviousMask({
        width,
        height,
        rgba: image,
        previousMask: new Uint8Array(width * height),
        roi: { left: 0, top: 0, width, height },
      }),
    /no foreground/,
  )
  const transparentImage = rgba(width, height, [2 * width + 2])
  assert.throws(
    () =>
      validateMobileSamPreviousMask({
        width,
        height,
        rgba: transparentImage,
        previousMask: previous,
        roi: { left: 0, top: 0, width, height },
      }),
    /visible ROI/,
  )
  const outside = new Uint8Array(width * height)
  outside[0] = 1
  assert.throws(
    () =>
      validateMobileSamPreviousMask({
        width,
        height,
        rgba: image,
        previousMask: outside,
        roi: { left: 1, top: 1, width: 3, height: 2 },
      }),
    /visible ROI/,
  )
  const nonbinary = new Uint8Array(previous)
  nonbinary[0] = 2
  assert.throws(
    () =>
      validateMobileSamPreviousMask({
        width,
        height,
        rgba: image,
        previousMask: nonbinary,
        roi: { left: 0, top: 0, width, height },
      }),
    /not binary/,
  )
})

await test('expansion chooses the smallest strict outer mask and applies score then token ties', () => {
  const width = 7
  const height = 5
  const pixels = width * height
  const previous = new Uint8Array(pixels)
  previous[2 * width + 2] = 1
  previous[2 * width + 3] = 1
  const oldBounds = { left: 2, top: 2, right: 3, bottom: 2 }
  const minimal = [2 * width + 2, 2 * width + 3, 2 * width + 4]
  const equallySmall = [2 * width + 2, 2 * width + 3, 3 * width + 3]
  const slightlyLarger = [...minimal, 3 * width + 2]
  const large = [...minimal, 2 * width + 5, 3 * width + 4]
  const selected = selectEnclosingMobileSamCandidate({
    width,
    height,
    rgba: rgba(width, height),
    previousMask: previous,
    logits: logitsFor(width, height, [minimal, slightlyLarger, large, large]),
    scores: Float32Array.of(-0.2, 0.8, 0.99, 0.8),
    roi: { left: 0, top: 0, width, height },
  })
  assert.ok(selected)
  assert.equal(selected.token, 0)
  assert.equal(selected.area, 3)
  assert.equal(selected.bounds.left, oldBounds.left)
  assert.equal(selected.bounds.right, 4)
  assert.equal(selected.bounds.bottom, oldBounds.bottom)

  const tieByScore = selectEnclosingMobileSamCandidate({
    width,
    height,
    rgba: rgba(width, height),
    previousMask: previous,
    logits: logitsFor(width, height, [minimal, equallySmall, large, minimal]),
    scores: Float32Array.of(0.7, 0.9, 0.99, 0.8),
    roi: { left: 0, top: 0, width, height },
  })
  assert.equal(tieByScore?.token, 1)

  const tieByToken = selectEnclosingMobileSamCandidate({
    width,
    height,
    rgba: rgba(width, height),
    previousMask: previous,
    logits: logitsFor(width, height, [large, large, minimal, minimal]),
    scores: Float32Array.of(0.99, 0.99, 0.8, 0.8),
    roi: { left: 0, top: 0, width, height },
  })
  assert.equal(tieByToken?.token, 2)
})

await test('expansion returns no candidate when masks are unchanged, fragments or contract bounds', () => {
  const width = 5
  const height = 5
  const previous = new Uint8Array(width * height)
  previous[2 * width + 2] = 1
  previous[2 * width + 3] = 1
  const unchanged = [2 * width + 2, 2 * width + 3]
  const fragment = [2 * width + 3, 2 * width + 4]
  const contractedEdge = [2 * width + 3, 2 * width + 4, 3 * width + 3]
  const result = selectEnclosingMobileSamCandidate({
    width,
    height,
    rgba: rgba(width, height),
    previousMask: previous,
    logits: logitsFor(width, height, [unchanged, fragment, contractedEdge, unchanged]),
    scores: Float32Array.of(1, 1, 1, 1),
    roi: { left: 0, top: 0, width, height },
  })
  assert.equal(result, undefined)
})

await test('expansion bounds selection to ROI and visible source pixels', () => {
  const width = 6
  const height = 4
  const previous = new Uint8Array(width * height)
  previous[width + 2] = 1
  previous[width + 3] = 1
  const mask = [width + 1, width + 2, width + 3, width + 4]
  const image = rgba(width, height, [width + 1])
  const selected = selectEnclosingMobileSamCandidate({
    width,
    height,
    rgba: image,
    previousMask: previous,
    logits: logitsFor(width, height, [mask, mask, mask, mask]),
    scores: Float32Array.of(0.2, 0.9, 0.8, 0.7),
    roi: { left: 2, top: 1, width: 2, height: 1 },
  })
  assert.equal(selected, undefined)
})
