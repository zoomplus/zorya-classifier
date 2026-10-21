import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import type { ObjectProposalBatch, ObjectProposalPort } from '../src/entities/object-proposals.js'
import type { SegmentationInput } from '../src/entities/segmentation.js'
import { packBinaryMask } from '../src/features/segmentation/packed-mask.js'
import {
  createSemanticMaskSegmenter,
  renderSemanticMaskView,
} from '../benchmarks/v03/semantic-mask-segmenter.js'

function input(): SegmentationInput {
  const roi = { left: 0, top: 0, width: 16, height: 16 }
  const data = new Uint8Array(16 * 16 * 4).fill(255)
  return {
    image: { data, width: 16, height: 16, format: 'rgba8' },
    seedRegion: { left: 4, top: 4, width: 4, height: 4 },
    prompt: 'seed-region',
    wholeRegion: roi,
    roi,
    target: 'the circular object',
    exclusions: [],
    completeness: 'visible-object',
    bounds: {
      left: { start: 0, endExclusive: 1 },
      right: { start: 15, endExclusive: 16 },
      top: { start: 0, endExclusive: 1 },
      bottom: { start: 15, endExclusive: 16 },
    },
    signal: new AbortController().signal,
  }
}
function batch(): ObjectProposalBatch {
  return {
    metadata: {
      method: 'fixture',
      backend: 'fixture',
      durationMs: 1,
      input: { width: 16, height: 16 },
    },
    proposals: Array.from({ length: 4 }, (_, index) => {
      const pixels = new Uint8Array(256)
      for (let y = 4; y < 8 + index; y++) for (let x = 4; x < 8 + index; x++) pixels[y * 16 + x] = 1
      return { id: `C0${index}`, mask: packBinaryMask(pixels, 16, 16), qualityScore: 987654321 }
    }),
  }
}

await test('semantic seed selection keeps categorical ties stable and quality diagnostics private', async () => {
  let calls = 0,
    disposed = 0
  const proposals: ObjectProposalPort = {
    async propose() {
      return batch()
    },
    async settle() {},
    async dispose() {
      disposed++
    },
  }
  const segmenter = createSemanticMaskSegmenter({
    proposals,
    decision: {
      async decide(request) {
        calls++
        assert.equal(JSON.stringify(request).includes('987654321'), false)
        assert.equal(request.state.filter((part) => typeof part === 'object').length, 5)
        return {
          answers: {
            selection: {
              type: 'choice',
              choice: 'D',
              probabilities: { A: 0.25, B: 0.25, C: 0.25, D: 0.25, none: 0 },
            },
          },
          metadata: {
            model: 'fixture',
            provider: 'fixture',
            requestId: null,
            durationMs: 1,
            costUsd: null,
            attempts: 1,
          },
        }
      },
    },
  })
  try {
    const result = await segmenter.segment(input())
    assert.equal(result.status, 'segmented')
    if (result.status === 'segmented')
      assert.equal(
        result.mask.data.reduce((total, value) => total + value, 0),
        16,
      )
    assert.equal(calls, 1)
  } finally {
    await segmenter.dispose()
  }
  assert.equal(disposed, 0)
})

await test('label padding preserves top-edge source pixels instead of painting over them', async () => {
  const source = input().image
  const view = await renderSemanticMaskView(
    source,
    { data: new Uint8Array(256), width: 16, height: 16, format: 'binary-u8' },
    'A',
    new AbortController().signal,
  )
  const decoded = await sharp(view.bytes).ensureAlpha().raw().toBuffer()
  assert.equal(view.height, 58)
  assert.deepEqual(new Uint8Array(decoded.subarray(42 * 16 * 4)), source.data)
})

await test('wrapper disposal joins late native work without disposing the caller port or dispatching a model', async () => {
  let release: (() => void) | undefined
  let nativeStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    nativeStarted = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0,
    nativeDisposed = 0
  const segmenter = createSemanticMaskSegmenter({
    proposals: {
      async propose() {
        nativeStarted!()
        await held
        return batch()
      },
      async settle() {},
      async dispose() {
        nativeDisposed++
      },
    },
    decision: {
      async decide() {
        calls++
        throw new Error('No model call after cancellation')
      },
    },
  })
  const work = assert.rejects(segmenter.segment(input()), { code: 'DISPOSED' })
  await started
  let closed = false
  const disposing = segmenter.dispose().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  release!()
  await Promise.all([work, disposing])
  assert.equal(calls, 0)
  assert.equal(nativeDisposed, 0)
})

await test('mask geometry outside ROI fails before semantic selection', async () => {
  let calls = 0
  const segmenter = createSemanticMaskSegmenter({
    proposals: {
      async propose() {
        return batch()
      },
      async settle() {},
      async dispose() {},
    },
    decision: {
      async decide() {
        calls++
        throw new Error('Must not run')
      },
    },
  })
  const request = input()
  request.roi = { left: 4, top: 4, width: 4, height: 4 }
  try {
    await assert.rejects(segmenter.segment(request), /outside the hard ROI/)
  } finally {
    await segmenter.dispose()
  }
  assert.equal(calls, 0)
})
