import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nativeSegmentationRequestSchema } from '../src/infrastructure/segmentation/native-protocol.js'
import {
  collectMobileSamSegmentationCandidates,
  mobileSamSegmentationPrompt,
  selectBestMaskCandidate,
} from '../src/infrastructure/segmentation/mobile-sam/worker-inference.js'
import { initializeGrabCutMask } from '../src/infrastructure/segmentation/grabcut/worker-inference.js'

const rect = { left: 0, top: 0, width: 1, height: 1 }
const options = {
  encoderPath: 'encoder.onnx',
  decoderPath: 'decoder.onnx',
  executionProvider: 'cpu' as const,
}

await test('native segmentation protocol defaults prompt to whole-region and rejects unknown prompts', () => {
  const base = {
    id: '2d58b44f-469f-4f0b-8426-fec756edc2fd',
    kind: 'mobile-sam',
    width: 1,
    height: 1,
    rgba: 'AAAAAA==',
    seedRegion: rect,
    wholeRegion: rect,
    roi: rect,
    options,
  }
  const parsed = nativeSegmentationRequestSchema.parse(base)
  assert.equal(parsed.kind, 'mobile-sam')
  if (parsed.kind === 'mobile-sam') assert.equal(parsed.prompt, 'whole-region')
  const grabCut = nativeSegmentationRequestSchema.parse({
    id: base.id,
    kind: 'grabcut',
    width: base.width,
    height: base.height,
    rgba: base.rgba,
    seedRegion: base.seedRegion,
    wholeRegion: base.wholeRegion,
    roi: base.roi,
    assetPath: 'opencv.js',
  })
  assert.equal(grabCut.kind, 'grabcut')
  if (grabCut.kind === 'grabcut') assert.equal(grabCut.prompt, 'whole-region')
  assert.throws(() => nativeSegmentationRequestSchema.parse({ ...base, prompt: 'bbox-ish' }))
  assert.equal(
    nativeSegmentationRequestSchema.parse({ ...base, prompt: 'seed-region' }).kind,
    'mobile-sam',
  )
})

await test('MobileSAM keeps box prompts unchanged and uses one positive seed point with ignored padding', () => {
  const seedRegion = { left: 4, top: 2, width: 3, height: 2 }
  const wholeRegion = { left: 1, top: 1, width: 10, height: 8 }
  const box = mobileSamSegmentationPrompt({
    prompt: 'whole-region',
    seedRegion,
    wholeRegion,
    xScale: 0.5,
    yScale: 0.25,
  })
  assert.deepEqual([...box.coordinates], [0.5, 0.25, 5.5, 2.25])
  assert.deepEqual([...box.labels], [2, 3])

  const point = mobileSamSegmentationPrompt({
    prompt: 'seed-region',
    seedRegion,
    wholeRegion,
    xScale: 0.5,
    yScale: 0.25,
  })
  assert.deepEqual([...point.coordinates], [2.5, 0.625, 2.5, 0.625])
  assert.deepEqual([...point.labels], [1, -1])
})

await test('seed-prompt masks remain full-source, clip to ROI/alpha, and require seed intersection', () => {
  const width = 5
  const height = 4
  const rgba = new Uint8Array(width * height * 4).fill(255)
  rgba[(2 * width + 4) * 4 + 3] = 0
  const logits = new Float32Array(width * height * 4).fill(1)
  const scores = Float32Array.of(0.6, 0.99, 0.8, 0.7)
  const roi = { left: 1, top: 0, width: 4, height: 3 }
  const seedRegion = { left: 4, top: 2, width: 1, height: 1 }
  const candidates = collectMobileSamSegmentationCandidates({
    width,
    height,
    rgba,
    logits,
    scores,
    roi,
    seedRegion,
    prompt: 'seed-region',
  })
  assert.equal(candidates.length, 0)

  rgba[(2 * width + 4) * 4 + 3] = 255
  const seeded = collectMobileSamSegmentationCandidates({
    width,
    height,
    rgba,
    logits,
    scores,
    roi,
    seedRegion,
    prompt: 'seed-region',
  })
  assert.equal(seeded.length, 4)
  const best = selectBestMaskCandidate(seeded)
  assert.equal(best?.token, 1)
  assert.equal(best?.mask.length, width * height)
  assert.equal(best?.mask[0], 0)
  assert.equal(best?.mask[width], 0)
  assert.equal(best?.mask[2 * width + 4], 1)

  // The legacy box mode retains its previous alpha-independent ROI behavior.
  rgba[(2 * width + 4) * 4 + 3] = 0
  const boxCandidates = collectMobileSamSegmentationCandidates({
    width,
    height,
    rgba,
    logits,
    scores,
    roi,
    seedRegion,
    prompt: 'whole-region',
  })
  assert.equal(boxCandidates[0]?.mask[2 * width + 4], 1)
})

await test('GrabCut seed prompt initializes probable background only in hard ROI', () => {
  const width = 6
  const height = 5
  const labels = { background: 0, foreground: 1, probableBackground: 2, probableForeground: 3 }
  const seedRegion = { left: 2, top: 2, width: 1, height: 1 }
  const wholeRegion = { left: 1, top: 1, width: 4, height: 3 }
  const roi = { left: 2, top: 1, width: 3, height: 3 }
  const seedFlags = new Uint8Array(width * height)
  initializeGrabCutMask({
    flags: seedFlags,
    width,
    height,
    seedRegion,
    wholeRegion,
    roi,
    prompt: 'seed-region',
    labels,
  })
  assert.equal(seedFlags[0], labels.background)
  assert.equal(seedFlags[1 * width + 2], labels.probableBackground)
  assert.equal(seedFlags[2 * width + 2], labels.foreground)
  assert.equal(seedFlags[1 * width + 1], labels.background)
  assert.equal(seedFlags[2 * width + 4], labels.probableBackground)

  const boxFlags = new Uint8Array(width * height)
  initializeGrabCutMask({
    flags: boxFlags,
    width,
    height,
    seedRegion,
    wholeRegion,
    roi,
    prompt: 'whole-region',
    labels,
  })
  assert.equal(boxFlags[1 * width + 1], labels.probableForeground)
  assert.equal(boxFlags[1 * width + 2], labels.probableForeground)
  assert.equal(boxFlags[2 * width + 2], labels.foreground)
})
