import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'

import type { LocalizationResult, RasterImage, RasterPort } from '../src/entities/contracts.js'
import type { CutoutRasterPort } from '../src/entities/cutout-raster.js'
import type {
  BinaryMask,
  SegmentationInput,
  SegmentationPort,
  SegmentationResult,
} from '../src/entities/segmentation.js'
import type {
  SegmentationBoxCheckPort,
  SegmentationBoxCheckResult,
  SegmentationBoxVerdict,
} from '../src/entities/segmentation-verification.js'
import type { RgbaRaster } from '../src/entities/representation.js'
import { ClassifierError } from '../src/entities/errors.js'
import { extractFromRegion } from '../src/processes/extract-from-region.js'

function checkResult(verdict: SegmentationBoxVerdict): SegmentationBoxCheckResult {
  return {
    verdict,
    selection: {
      choice: verdict,
      nativeChoice: null,
      probabilities: null,
      ranking: [verdict],
      tied: [],
    },
    metadata: {
      model: 'fixture-box',
      provider: 'fixture',
      requestId: null,
      durationMs: 1,
      costUsd: 0.001,
      attempts: 1,
    },
  }
}
const completeBoxCheck: SegmentationBoxCheckPort = { check: async () => checkResult('complete') }

const width = 8
const height = 6
const roi = { left: 1, top: 1, width: 5, height: 4 }
const seed = { left: 2, top: 2, width: 1, height: 1 }
const original: LocalizationResult = {
  status: 'located',
  region: seed,
  normalizedRegion: { left: 0.25, top: 1 / 3, width: 1 / 8, height: 1 / 6 },
  selection: {
    choice: 'C004',
    nativeChoice: 'C004',
    probabilities: { C004: 1 },
    tied: ['C004'],
  },
  method: 'three-choice-grid-v1',
  metadata: {
    image: { width, height, coordinateSpace: 'oriented-source-pixels' },
    stages: Array.from({ length: 3 }, (_, index) => ({
      model: 'fixture-model',
      provider: 'fixture-provider',
      requestId: `fixture-${index}`,
      durationMs: 1,
      costUsd: 0,
      attempts: 1,
    })),
    durationMs: 3,
    knownCostUsd: 0,
    unknownCostCount: 0,
  },
}

async function sourcePng(): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = i + 10
    rgba[i * 4 + 1] = i + 20
    rgba[i * 4 + 2] = i + 30
    rgba[i * 4 + 3] = 255
  }
  rgba[(3 * width + 2) * 4 + 3] = 0
  const bytes = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
  rgba.fill(0)
  return new Uint8Array(bytes)
}

function rgbaFixture(): RgbaRaster {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i + 10
    data[i * 4 + 1] = i + 20
    data[i * 4 + 2] = i + 30
    data[i * 4 + 3] = 255
  }
  data[(3 * width + 2) * 4 + 3] = 0
  return { data, width, height, format: 'rgba8' }
}

function maskFixture(): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let y = 1; y <= 4; y++) for (let x = 1; x <= 5; x++) mask[y * width + x] = 1
  return mask
}

function rasterPort(bytes: Uint8Array, overrides: Partial<RasterPort> = {}): RasterPort {
  const rasterImage: RasterImage = { bytes: new Uint8Array(bytes), width, height }
  return {
    normalize: async (input) => {
      assert.notEqual(input, bytes)
      return { ...rasterImage, bytes: new Uint8Array(rasterImage.bytes) }
    },
    crop: async () => rasterImage,
    imageState: async () => [],
    grid: async () => rasterImage,
    ...overrides,
  }
}

function cutoutPort(
  overrides: Partial<CutoutRasterPort> = {},
  source = rgbaFixture(),
): CutoutRasterPort {
  return {
    rgba: async (image) => {
      assert.equal(image.width, width)
      assert.equal(image.height, height)
      return { ...source, data: new Uint8Array(source.data) }
    },
    png: async (image) =>
      new Uint8Array(
        await sharp(image.data, {
          raw: { width: image.width, height: image.height, channels: 4 },
        })
          .png()
          .toBuffer(),
      ),
    ...overrides,
  }
}

function segmenter(
  run: (input: SegmentationInput) => Promise<SegmentationResult>,
  lifecycle: { settle?: () => Promise<void>; dispose?: () => Promise<void> } = {},
): SegmentationPort {
  return {
    async segment(input) {
      return run(input)
    },
    settle: lifecycle.settle ?? (async () => undefined),
    dispose: lifecycle.dispose ?? (async () => undefined),
  }
}

await test('region-seeded extraction segments the entire source and derives extent from mask pixels', async () => {
  const bytes = await sourcePng()
  const originalBytes = new Uint8Array(bytes)
  const controller = new AbortController()
  let locateCalls = 0
  let pngCalls = 0
  let settleCalls = 0
  let disposeCalls = 0
  const port = segmenter(
    async (input) => {
      assert.equal(input.signal, controller.signal)
      assert.equal(input.prompt, 'seed-region')
      assert.deepEqual(input.seedRegion, seed)
      assert.deepEqual(input.wholeRegion, roi)
      assert.deepEqual(input.roi, roi)
      assert.equal(input.completeness, 'visible-object')
      assert.equal(input.image.width, width)
      assert.equal(input.image.height, height)
      assert.equal(input.image.data.length, width * height * 4)
      assert.deepEqual(input.image.data, rgbaFixture().data)
      assert.deepEqual(input.bounds, {
        left: { start: 1, endExclusive: 6 },
        right: { start: 1, endExclusive: 6 },
        top: { start: 1, endExclusive: 5 },
        bottom: { start: 1, endExclusive: 5 },
      })
      const mask = maskFixture()
      return {
        status: 'segmented',
        mask: { data: mask, width, height, format: 'binary-u8' as const },
        metadata: {
          method: 'fixture-segmenter',
          backend: 'fixture',
          durationMs: 4,
          input: { width, height },
        },
      }
    },
    {
      settle: async () => {
        settleCalls++
      },
      dispose: async () => {
        disposeCalls++
      },
    },
  )
  const cutout = cutoutPort({
    png: async (image) => {
      pngCalls++
      return new Uint8Array(
        await sharp(image.data, {
          raw: { width: image.width, height: image.height, channels: 4 },
        })
          .png()
          .toBuffer(),
      )
    },
  })
  const result = await extractFromRegion(
    { image: bytes, target: 'the visible object', roi, signal: controller.signal },
    {
      boxCheck: completeBoxCheck,
      raster: rasterPort(bytes),
      image: cutout,
      segmenter: port,
      locateRegion: async (source, request) => {
        locateCalls++
        assert.notEqual(source.bytes, bytes)
        assert.deepEqual(request.roi, roi)
        assert.equal(request.signal, controller.signal)
        assert.equal('mode' in request, false)
        return original
      },
    },
  )
  assert.deepEqual(bytes, originalBytes)
  assert.equal(locateCalls, 1)
  assert.equal(pngCalls, 1)
  assert.equal(settleCalls, 0)
  assert.equal(disposeCalls, 0)
  assert.equal(result.status, 'extracted')
  if (result.status !== 'extracted') return
  assert.deepEqual(result.region, { left: 1, top: 1, width: 5, height: 4 })
  assert.deepEqual(result.offset, { x: 1, y: 1 })
  assert.deepEqual(result.center, { x: 3.5, y: 3 })
  assert.equal(result.location.method, 'region-checked-segmentation-v1')
  assert.deepEqual(result.location.seedRegion, seed)
  assert.deepEqual(result.location.bounds, {
    left: { start: 1, endExclusive: 2 },
    right: { start: 5, endExclusive: 6 },
    top: { start: 1, endExclusive: 2 },
    bottom: { start: 4, endExclusive: 5 },
  })
  assert.equal(result.location.completeness, 'boundary-limited')
  assert.equal(result.location.metadata.stages.length, 4)
  assert.ok(Number.isFinite(result.location.metadata.durationMs))
  assert.ok(result.location.metadata.durationMs >= 0)
  assert.equal(result.mask.data.length, 20)
  assert.equal(result.mask.data[(3 - 1) * 5 + (2 - 1)], 0)
  const decoded = await sharp(result.png).metadata()
  assert.deepEqual([decoded.width, decoded.height], [5, 4])
})

await test('region locator unknown or absent skips segmentation and preserves its status', async () => {
  const bytes = await sourcePng()
  for (const result of [
    { ...original, status: 'not-found' as const, reason: 'absent-in-evaluated-region' as const },
    { ...original, status: 'unknown' as const, reason: 'uncertain-presence' as const },
  ]) {
    let segmentCalls = 0
    const output = await extractFromRegion(
      { image: bytes, target: 'object', signal: new AbortController().signal },
      {
        boxCheck: completeBoxCheck,
        raster: rasterPort(bytes),
        image: cutoutPort(),
        segmenter: segmenter(async () => {
          segmentCalls++
          throw new Error('unexpected segment call')
        }),
        locateRegion: async () => result,
      },
    )
    assert.equal(output.status, result.status)
    assert.equal(segmentCalls, 0)
  }
})

await test('caller bytes are snapshotted before the first normalization await', async () => {
  const bytes = await sourcePng()
  const expectedBytes = new Uint8Array(bytes)
  let markEntered!: () => void
  let resume!: () => void
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  const resultPromise = extractFromRegion(
    { image: bytes, target: 'object', signal: new AbortController().signal },
    {
      boxCheck: completeBoxCheck,
      raster: rasterPort(bytes, {
        normalize: async (owned) => {
          assert.notEqual(owned, bytes)
          assert.deepEqual(owned, expectedBytes)
          markEntered()
          await gate
          return { bytes: new Uint8Array(owned), width, height }
        },
      }),
      image: cutoutPort(),
      segmenter: segmenter(async () => {
        throw new Error('segmentation should not run after region not-found')
      }),
      locateRegion: async () => ({
        ...original,
        status: 'not-found',
        reason: 'absent-in-evaluated-region',
      }),
    },
  )
  await entered
  bytes.fill(0)
  resume()
  const result = await resultPromise
  assert.equal(result.status, 'not-found')
  assert.deepEqual(bytes, new Uint8Array(bytes.length))
})

await test('segmentation unknown carries the seed result without inventing an object location', async () => {
  const bytes = await sourcePng()
  const output = await extractFromRegion(
    { image: bytes, target: 'object', signal: new AbortController().signal },
    {
      boxCheck: completeBoxCheck,
      raster: rasterPort(bytes),
      image: cutoutPort(),
      segmenter: segmenter(async () => ({
        status: 'unknown',
        reason: 'backend cannot identify target extent',
        metadata: {
          method: 'fixture-segmenter',
          backend: 'fixture',
          durationMs: 4,
          input: { width, height },
        },
      })),
      locateRegion: async () => original,
    },
  )
  assert.equal(output.status, 'unknown')
  if (output.status !== 'unknown' || !('seedLocation' in output)) return
  assert.deepEqual(output.seedLocation.region, seed)
  assert.equal(output.metadata.stages.length, 3)
  assert.equal(output.segmentation.method, 'fixture-segmenter')
})

await test('mask outside hard ROI is invalid and cannot produce a rectangle fallback', async () => {
  const bytes = await sourcePng()
  await assert.rejects(
    extractFromRegion(
      { image: bytes, target: 'object', roi, signal: new AbortController().signal },
      {
        boxCheck: completeBoxCheck,
        raster: rasterPort(bytes),
        image: cutoutPort(),
        segmenter: segmenter(async () => {
          const mask = new Uint8Array(width * height)
          mask[0] = 1
          mask[2 * width + 2] = 1
          return {
            status: 'segmented',
            mask: { data: mask, width, height, format: 'binary-u8' as const },
            metadata: {
              method: 'fixture',
              backend: 'fixture',
              durationMs: 0,
              input: { width, height },
            },
          }
        }),
        locateRegion: async () => original,
      },
    ),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
})

await test('abort after the segmenter resolves is honored and shared adapter ownership stays external', async () => {
  const bytes = await sourcePng()
  const controller = new AbortController()
  let pngCalls = 0
  let settleCalls = 0
  let disposeCalls = 0
  await assert.rejects(
    extractFromRegion(
      { image: bytes, target: 'object', signal: controller.signal },
      {
        boxCheck: completeBoxCheck,
        raster: rasterPort(bytes),
        image: cutoutPort({
          png: async () => {
            pngCalls++
            return new Uint8Array(8)
          },
        }),
        segmenter: segmenter(
          async (input) => {
            assert.equal(input.signal, controller.signal)
            controller.abort(new ClassifierError('ABORTED', 'test abort'))
            return {
              status: 'segmented',
              mask: { data: maskFixture(), width, height, format: 'binary-u8' as const },
              metadata: {
                method: 'fixture',
                backend: 'fixture',
                durationMs: 0,
                input: { width, height },
              },
            }
          },
          {
            settle: async () => {
              settleCalls++
            },
            dispose: async () => {
              disposeCalls++
            },
          },
        ),
        locateRegion: async () => original,
      },
    ),
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  assert.equal(pngCalls, 0)
  assert.equal(settleCalls, 0)
  assert.equal(disposeCalls, 0)
})

function segmentedMask(data: Uint8Array): SegmentationResult {
  return {
    status: 'segmented',
    mask: { data, width, height, format: 'binary-u8' },
    metadata: {
      method: 'fixture-mask',
      backend: 'fixture',
      durationMs: 1,
      input: { width, height },
    },
  }
}

function partMask(): Uint8Array {
  const data = new Uint8Array(width * height)
  data[2 * width + 2] = 1
  data[2 * width + 3] = 1
  return data
}

async function correctionFixture(
  boxCheck: SegmentationBoxCheckPort,
  expand?: SegmentationPort['expand'],
  signal = new AbortController().signal,
) {
  const bytes = await sourcePng()
  let pngCalls = 0
  const port: SegmentationPort = {
    ...segmenter(async () => segmentedMask(partMask())),
    ...(expand ? { expand } : {}),
  }
  const result = await extractFromRegion(
    { image: bytes, target: 'one physical object', exclusions: ['another object'], roi, signal },
    {
      raster: rasterPort(bytes),
      image: cutoutPort({
        png: async (image, operationSignal) => {
          pngCalls++
          return cutoutPort().png(image, operationSignal)
        },
      }),
      segmenter: port,
      locateRegion: async () => original,
      boxCheck,
    },
  )
  return { result, pngCalls }
}

await test('incomplete part triggers exactly one enclosing-mask correction and rechecks real geometry', async () => {
  const controller = new AbortController()
  let checks = 0
  let expansions = 0
  const seenImages: Uint8Array[] = []
  const seenPrevious: Uint8Array[] = []
  const externalMask = maskFixture()
  const { result, pngCalls } = await correctionFixture(
    {
      async check(input) {
        checks++
        assert.equal(input.signal, controller.signal)
        assert.deepEqual(input.image.data, rgbaFixture().data)
        seenImages.push(input.image.data)
        assert.deepEqual(input.seedRegion, seed)
        assert.deepEqual(input.roi, roi)
        assert.equal(input.target, 'one physical object')
        assert.deepEqual(input.exclusions, ['another object'])
        assert.deepEqual(input.region, checks === 1 ? { ...seed, width: 2 } : roi)
        // A caller implementation cannot mutate the canonical image or later stage geometry.
        input.image.data.fill(0)
        input.region.left = 0
        input.seedRegion.left = 0
        return checkResult(checks === 1 ? 'needs-expansion' : 'complete')
      },
    },
    async (input, previous) => {
      expansions++
      assert.equal(input.signal, controller.signal)
      assert.equal(input.prompt, 'seed-region')
      assert.deepEqual(input.image.data, rgbaFixture().data)
      assert.deepEqual(input.seedRegion, seed)
      assert.deepEqual(input.wholeRegion, roi)
      assert.deepEqual(previous.data, partMask())
      assert.deepEqual(
        [previous.width, previous.height, previous.format],
        [width, height, 'binary-u8'],
      )
      seenImages.push(input.image.data)
      seenPrevious.push(previous.data)
      previous.data.fill(0)
      return segmentedMask(externalMask)
    },
    controller.signal,
  )
  assert.equal(result.status, 'extracted')
  assert.equal(checks, 2)
  assert.equal(expansions, 1)
  assert.equal(pngCalls, 1)
  for (const bytes of [...seenImages, ...seenPrevious]) assert.ok(bytes.every((byte) => byte === 0))
  assert.deepEqual(externalMask, maskFixture())
  if (result.status !== 'extracted') throw new Error('Expected verified cutout')
  assert.deepEqual(result.region, roi)
  assert.deepEqual(result.center, { x: 3.5, y: 3 })
  assert.equal(result.verification?.expansion, 'expanded')
  assert.deepEqual(
    result.verification?.checks.map((check) => check.verdict),
    ['needs-expansion', 'complete'],
  )
  assert.equal(result.location.metadata.stages.length, 5)
  assert.equal(result.location.metadata.knownCostUsd, 0.002)
  assert.equal(result.location.metadata.unknownCostCount, 0)
  assert.deepEqual(result.location.verification, result.verification)
})

await test('already complete box skips expansion and preserves the maximum below 0.8', async () => {
  let expansions = 0
  const selection = {
    choice: 'complete',
    nativeChoice: 'complete',
    probabilities: { complete: 0.66, 'needs-expansion': 0.31, unknown: 0.03 },
    tied: ['complete'],
  }
  const { result } = await correctionFixture(
    { check: async () => ({ ...checkResult('complete'), selection }) },
    async () => {
      expansions++
      throw new Error('Complete box must not expand')
    },
  )
  assert.equal(result.status, 'extracted')
  assert.equal(expansions, 0)
  if (result.status !== 'extracted') throw new Error('Expected complete result')
  assert.equal(result.verification?.expansion, 'not-needed')
  assert.deepEqual(result.verification?.checks[0]?.selection.probabilities, selection.probabilities)
})

await test('missing expansion, no parent and uncertain checks return unknown without a partial PNG', async () => {
  for (const scenario of ['unsupported', 'no-enclosing-mask', 'unknown'] as const) {
    let expansions = 0
    const { result, pngCalls } = await correctionFixture(
      { check: async () => checkResult(scenario === 'unknown' ? 'unknown' : 'needs-expansion') },
      scenario === 'unsupported'
        ? undefined
        : async () => {
            expansions++
            return {
              status: 'unknown',
              reason: 'no-enclosing-mask',
              metadata: {
                method: 'fixture-expand',
                backend: 'fixture',
                durationMs: 1,
                input: { width, height },
              },
            }
          },
    )
    assert.equal(result.status, 'unknown')
    assert.equal(pngCalls, 0)
    assert.equal(expansions, scenario === 'no-enclosing-mask' ? 1 : 0)
    assert.equal('png' in result, false)
    assert.equal('region' in result, false)
    if (result.status !== 'unknown' || !('seedLocation' in result))
      throw new Error('Expected seed-only unknown')
    assert.equal(result.reason, 'segmentation-uncertain')
    assert.deepEqual(result.seedLocation.region, seed)
    assert.equal(result.verification?.expansion, scenario === 'unknown' ? 'not-needed' : scenario)
  }
})

await test('a replacement that removes original foreground or fails to grow the box is rejected', async () => {
  for (const scenario of ['missing-old-pixel', 'same-mask'] as const) {
    let checks = 0
    let data = maskFixture()
    if (scenario === 'missing-old-pixel') data[2 * width + 3] = 0
    else data = partMask()
    const { result, pngCalls } = await correctionFixture(
      {
        check: async () => {
          checks++
          return checkResult('needs-expansion')
        },
      },
      async () => segmentedMask(data),
    )
    assert.equal(result.status, 'unknown')
    assert.equal(checks, 1)
    assert.equal(pngCalls, 0)
    if (result.status !== 'unknown' || !('seedLocation' in result))
      throw new Error('Expected unknown')
    assert.equal(result.verification?.expansion, 'rejected-mask')
  }
})

await test('a second incomplete or unknown verdict never loops or publishes an unverified cutout', async () => {
  for (const finalVerdict of ['needs-expansion', 'unknown'] as const) {
    let checks = 0
    let expansions = 0
    const { result, pngCalls } = await correctionFixture(
      { check: async () => checkResult(++checks === 1 ? 'needs-expansion' : finalVerdict) },
      async () => {
        expansions++
        return segmentedMask(maskFixture())
      },
    )
    assert.equal(result.status, 'unknown')
    assert.equal(checks, 2)
    assert.equal(expansions, 1)
    assert.equal(pngCalls, 0)
    if (result.status !== 'unknown' || !('seedLocation' in result))
      throw new Error('Expected unknown')
    assert.equal(result.verification?.checks[1]?.verdict, finalVerdict)
    assert.equal(result.verification?.expansion, 'expanded')
  }
})

await test('box-check cancellation joins its physical result and clears owned image bytes', async () => {
  const controller = new AbortController()
  let image: Uint8Array | undefined
  let markEntered!: () => void
  let resume!: () => void
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    resume = resolve
  })
  let settled = false
  const promise = correctionFixture(
    {
      async check(input) {
        image = input.image.data
        markEntered()
        await pending
        return checkResult('complete')
      },
    },
    undefined,
    controller.signal,
  ).finally(() => {
    settled = true
  })
  const rejection = assert.rejects(
    promise,
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  await entered
  controller.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  assert.ok(image?.some((value) => value !== 0))
  resume()
  await rejection
  assert.ok(image?.every((value) => value === 0))
})

await test('late enclosing-mask result cannot succeed after cancellation and both input copies are released', async () => {
  const controller = new AbortController()
  let image: Uint8Array | undefined
  let previous: BinaryMask | undefined
  await assert.rejects(
    correctionFixture(
      { check: async () => checkResult('needs-expansion') },
      async (input, previousMask) => {
        image = input.image.data
        previous = previousMask
        controller.abort()
        return segmentedMask(maskFixture())
      },
      controller.signal,
    ),
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  assert.ok(image?.every((value) => value === 0))
  assert.ok(previous?.data.every((value) => value === 0))
})
