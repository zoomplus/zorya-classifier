import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'

import type { PixelRect } from '../src/entities/contracts.js'
import type { SegmentationInput, SegmentationPort } from '../src/entities/segmentation.js'
import type { RasterImage, RasterPort } from '../src/entities/contracts.js'
import { extractObject } from '../src/processes/extract.js'
import { validateMask } from '../src/features/segmentation/mask.js'

const location = {
  status: 'located' as const,
  kind: 'whole-object' as const,
  region: { left: 1, top: 1, width: 2, height: 2 },
  normalizedRegion: { left: 0.25, top: 1 / 3, width: 0.5, height: 2 / 3 },
  seedRegion: { left: 1, top: 1, width: 1, height: 1 },
  bounds: {
    left: { start: 1, endExclusive: 2 },
    right: { start: 2, endExclusive: 3 },
    top: { start: 1, endExclusive: 2 },
    bottom: { start: 2, endExclusive: 3 },
  },
  completeness: 'visible-object' as const,
  method: 'grid-object-extent-v1' as const,
  metadata: {
    image: { width: 4, height: 3, coordinateSpace: 'oriented-source-pixels' as const },
    stages: [],
    durationMs: 0,
    knownCostUsd: 0,
    unknownCostCount: 0,
  },
}

await test('mask validation rejects nonbinary values, ROI escape and masks missing the seed', () => {
  const image = { data: new Uint8Array(4 * 3 * 4), width: 4, height: 3, format: 'rgba8' as const }
  const seed: PixelRect = { left: 1, top: 1, width: 1, height: 1 }
  const roi: PixelRect = { left: 1, top: 1, width: 2, height: 2 }
  const bad = (value: number) => ({
    data: Uint8Array.from([value, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    width: 4,
    height: 3,
    format: 'binary-u8' as const,
  })
  assert.throws(() => validateMask(bad(2), image, roi, seed), /binary/)
  assert.throws(() => validateMask(bad(1), image, roi, seed), /outside the hard ROI/)
  const noSeed = bad(0)
  noSeed.data[9] = 1
  assert.equal(validateMask(noSeed, image, roi, seed), undefined)
  const invisible = {
    data: new Uint8Array(4 * 3 * 4),
    width: 4,
    height: 3,
    format: 'rgba8' as const,
  }
  invisible.data.fill(255)
  for (let index = 3; index < invisible.data.length; index += 4) invisible.data[index] = 0
  const invisibleMask = bad(0)
  invisibleMask.data[5] = 1
  assert.equal(validateMask(invisibleMask, invisible, roi, seed), undefined)
})

await test('extract crops to full mask bounds, preserves inside RGBA and clears pixels outside mask', async () => {
  const pixels = new Uint8Array(4 * 3 * 4)
  for (let index = 0; index < 12; index++) {
    pixels[index * 4] = index + 10
    pixels[index * 4 + 1] = index + 20
    pixels[index * 4 + 2] = index + 30
    pixels[index * 4 + 3] = 100 + index
  }
  const png = await sharp(pixels, { raw: { width: 4, height: 3, channels: 4 } })
    .png()
    .toBuffer()
  pixels[6 * 4 + 3] = 0
  const transparentPng = await sharp(pixels, { raw: { width: 4, height: 3, channels: 4 } })
    .png()
    .toBuffer()
  const rasterImage: RasterImage = { bytes: new Uint8Array(transparentPng), width: 4, height: 3 }
  const raster: RasterPort = {
    normalize: async () => rasterImage,
    crop: async () => rasterImage,
    imageState: async () => [],
    grid: async () => rasterImage,
  }
  const mask = new Uint8Array(12)
  mask[5] = 1
  mask[6] = 1
  mask[10] = 1
  const seenSignal = new AbortController().signal
  let disposed = false
  const segmenter: SegmentationPort = {
    async segment(input: SegmentationInput) {
      assert.equal(input.signal, seenSignal)
      assert.equal(input.image.format, 'rgba8')
      assert.deepEqual(input.wholeRegion, location.region)
      return {
        status: 'segmented',
        mask: { data: mask, width: 4, height: 3, format: 'binary-u8' },
        metadata: {
          method: 'fixture',
          backend: 'fixture',
          durationMs: 1,
          input: { width: 4, height: 3 },
        },
      }
    },
    settle: async () => undefined,
    dispose: async () => {
      disposed = true
    },
  }
  const result = await extractObject(
    { image: new Uint8Array(png), target: 'object', signal: seenSignal },
    {
      raster,
      segmenter,
      locateWhole: async (source, request) => {
        assert.notEqual(source, rasterImage)
        assert.deepEqual(source.bytes, rasterImage.bytes)
        assert.equal(request.signal, seenSignal)
        source.bytes.fill(0)
        return { ...location, seedRegion: { left: 0, top: 0, width: 3, height: 3 } }
      },
    },
  )
  assert.equal(result.status, 'extracted')
  if (result.status !== 'extracted') return
  assert.deepEqual(result.region, { left: 1, top: 1, width: 2, height: 2 })
  assert.deepEqual(result.offset, { x: 1, y: 1 })
  assert.deepEqual([...result.mask.data], [1, 0, 0, 1])
  const decoded = await sharp(result.png).raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([decoded.info.width, decoded.info.height, decoded.info.channels], [2, 2, 4])
  assert.deepEqual([...decoded.data.subarray(0, 4)], [...pixels.subarray(5 * 4, 5 * 4 + 4)])
  assert.deepEqual([...decoded.data.subarray(12, 16)], [...pixels.subarray(10 * 4, 10 * 4 + 4)])
  assert.deepEqual([...decoded.data.subarray(4, 8)], [0, 0, 0, 0])
  assert.deepEqual([...decoded.data.subarray(8, 12)], [0, 0, 0, 0])
  assert.equal(disposed, false)
})

await test('empty or ungrounded segmentation remains unknown and never falls back to the rectangle', async () => {
  const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer()
  const rasterImage: RasterImage = { bytes: new Uint8Array(png), width: 4, height: 3 }
  const raster: RasterPort = {
    normalize: async () => rasterImage,
    crop: async () => rasterImage,
    imageState: async () => [],
    grid: async () => rasterImage,
  }
  const result = await extractObject(
    { image: new Uint8Array(png), target: 'object', signal: new AbortController().signal },
    {
      raster,
      locateWhole: async () => location,
      segmenter: {
        segment: async (input) => ({
          status: 'segmented',
          mask: {
            data: new Uint8Array(input.image.width * input.image.height),
            width: 4,
            height: 3,
            format: 'binary-u8',
          },
          metadata: {
            method: 'empty',
            backend: 'fixture',
            durationMs: 0,
            input: { width: 4, height: 3 },
          },
        }),
        settle: async () => undefined,
        dispose: async () => undefined,
      },
    },
  )
  assert.equal(result.status, 'unknown')
  if (result.status === 'unknown') assert.equal(result.reason, 'segmentation-uncertain')
})
