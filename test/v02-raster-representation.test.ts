import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import {
  createSharpRaster,
  createVisionRepresentation,
  readCanonicalPixels,
} from '../src/infrastructure/raster.js'
import {
  createTextRepresentation,
  type TextPixelView,
} from '../src/infrastructure/text-representation.js'
import type { RasterImage } from '../src/entities/contracts.js'
import type { RepresentationView } from '../src/entities/representation.js'

const signal = new AbortController().signal

await test('sharp normalization yields oriented canonical RGBA8 and preserves transparent pixels', async () => {
  const source = await sharp({
    create: { width: 2, height: 1, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } },
  })
    .png()
    .toBuffer()
  const raster = createSharpRaster()
  const normalized = await raster.normalize(source, signal)
  const pixels = await readCanonicalPixels(normalized, signal)
  assert.equal(pixels.width, 2)
  assert.equal(pixels.height, 1)
  assert.deepEqual([...pixels.data], [10, 20, 30, 0, 10, 20, 30, 0])
})

await test('normalization applies EXIF orientation and text views use source-space ROI pixels', async () => {
  const jpeg = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
    raw: { width: 2, height: 1, channels: 3 },
  })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const raster = createSharpRaster()
  const source = await raster.normalize(jpeg, signal)
  assert.equal(source.width, 1)
  assert.equal(source.height, 2)
  const oriented = await readCanonicalPixels(source, signal)
  assert.ok((oriented.data[0] ?? 0) > (oriented.data[2] ?? 0))
  assert.ok((oriented.data[6] ?? 0) > (oriented.data[4] ?? 0))
  const roi = { left: 0, top: 1, width: 1, height: 1 }
  let pixels: Uint8Array | undefined
  const port = createTextRepresentation({
    profile: 'roi',
    async encode(view) {
      pixels = view.data
      return 'roi'
    },
  })
  await port.prepare({
    source,
    views: [{ id: 'roi', role: 'crop', image: source, sourceRegion: roi }],
    signal,
  })
  assert.equal(pixels?.[1], 0)
  assert.ok((pixels?.[2] ?? 0) > (pixels?.[0] ?? 0))
})

await test('vision representation keeps legacy imageState transform and records every request view', async () => {
  const raster = createSharpRaster()
  const bytes = await sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 80, g: 90, b: 100, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const source = await raster.normalize(bytes, signal)
  const views: RepresentationView[] = [
    {
      id: 'source',
      role: 'source',
      image: source,
      sourceRegion: { left: 0, top: 0, width: 3, height: 2 },
    },
    {
      id: 'crop',
      role: 'crop',
      image: source,
      sourceRegion: { left: 1, top: 0, width: 2, height: 2 },
    },
  ]
  const actual = await createVisionRepresentation(raster).prepare({ source, views, signal })
  const expected = await raster.imageState(source, signal)
  assert.deepEqual(actual.state.slice(0, 2), expected)
  assert.equal(actual.metadata.views.length, 2)
  const transform = JSON.parse(expected[1] as string).sourceImageTransform
  assert.equal(actual.metadata.views[0]?.width, transform.output.width)
  assert.equal(actual.metadata.views[0]?.height, transform.output.height)
  assert.ok(actual.metadata.bytes > 0)
})

await test('text preparation deduplicates geometry and allocates bounded pixels before encoding', async () => {
  const raster = createSharpRaster()
  const bytes = await sharp({
    create: { width: 400, height: 200, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } },
  })
    .png()
    .toBuffer()
  const source = await raster.normalize(bytes, signal)
  const region = { left: 0, top: 0, width: 400, height: 200 }
  const views: RepresentationView[] = [
    { id: 'source', role: 'source', image: source, sourceRegion: region },
    {
      id: 'same-pixels-grid',
      role: 'grid',
      image: source,
      sourceRegion: region,
      grid: { cells: [], labels: new Map() },
    },
  ]
  const seen: TextPixelView[] = []
  const port = createTextRepresentation({
    profile: 'test',
    async encode(view) {
      seen.push(view)
      return `pixels:${view.width}x${view.height}`
    },
  })
  const result = await port.prepare({ source, views, signal })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.width, 64)
  assert.equal(seen[0]?.height, 32)
  assert.equal(seen[0]?.data.byteLength, 64 * 32 * 4)
  assert.equal(result.metadata.views.length, 1)
})

await test('text request fails byte budget rather than truncating an encoded view', async () => {
  const raster = createSharpRaster()
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
    .png()
    .toBuffer()
  const source = await raster.normalize(bytes, signal)
  const view: RepresentationView = {
    id: 'one',
    role: 'source',
    image: source,
    sourceRegion: { left: 0, top: 0, width: 1, height: 1 },
  }
  const port = createTextRepresentation({
    profile: 'large',
    async encode() {
      return 'é'.repeat(33000)
    },
  })
  await assert.rejects(
    port.prepare({ source, views: [view], signal }),
    /aggregate UTF-8 byte limit/,
  )
})

await test('text preparation rejects grid cells that collapse at 64-pixel resolution', async () => {
  const raster = createSharpRaster()
  const bytes = await sharp({ create: { width: 256, height: 64, channels: 3, background: '#fff' } })
    .png()
    .toBuffer()
  const source: RasterImage = await raster.normalize(bytes, signal)
  const region = { left: 0, top: 0, width: 256, height: 64 }
  const view: RepresentationView = {
    id: 'grid',
    role: 'grid',
    image: source,
    sourceRegion: region,
    grid: {
      cells: [
        { id: 'a', column: 0, row: 0, region: { left: 0, top: 0, width: 1, height: 64 } },
        { id: 'b', column: 1, row: 0, region: { left: 1, top: 0, width: 1, height: 64 } },
      ],
      labels: new Map([
        ['a', 'P01'],
        ['b', 'P02'],
      ]),
    },
  }
  let encoded = false
  const port = createTextRepresentation({
    profile: 'unused',
    async encode() {
      encoded = true
      return ''
    },
  })
  await assert.rejects(
    port.prepare({ source, views: [view], signal }),
    /indistinguishable|collapses/,
  )
  assert.equal(encoded, false)
})
