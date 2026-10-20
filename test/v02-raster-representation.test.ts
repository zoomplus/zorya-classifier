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
import {
  pixelRleV1Encoder,
  pixelRleV1MaxEncodedBytes,
} from '../benchmarks/experiments/pixel-rle-v1.js'

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
    maxEncodedBytes: () => 3,
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
    maxEncodedBytes: () => 32,
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

await test('text allocation counts metadata against the aggregate byte budget before encoding', async () => {
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
  let encoded = false
  const port = createTextRepresentation({
    profile: 'large',
    maxEncodedBytes: () => 65500,
    async encode() {
      encoded = true
      return 'x'
    },
  })
  await assert.rejects(
    port.prepare({ source, views: [view], signal }),
    /No bounded text representation allocation fits/,
  )
  assert.equal(encoded, false)
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
    maxEncodedBytes: () => 1,
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

await test('text request rejects output that exceeds the encoder declared bound', async () => {
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
    profile: 'invalid-bound',
    maxEncodedBytes: () => 1,
    async encode() {
      return 'x'.repeat(64001)
    },
  })
  await assert.rejects(
    port.prepare({ source, views: [view], signal }),
    /exceeds its declared per-view bound/,
  )
})

await test('deduplicated text metadata retains every view role and grid labels', async () => {
  const raster = createSharpRaster()
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
    .png()
    .toBuffer()
  const source = await raster.normalize(bytes, signal)
  const region = { left: 0, top: 0, width: 2, height: 2 }
  const views: RepresentationView[] = [
    { id: 'source', role: 'source', image: source, sourceRegion: region },
    { id: 'crop-alias', role: 'crop', image: source, sourceRegion: region },
    {
      id: 'grid-alias',
      role: 'grid',
      image: source,
      sourceRegion: region,
      grid: {
        cells: [{ id: 'cell-1', column: 0, row: 0, region, xId: 'x0', yId: 'y0' }],
        labels: new Map([['cell-1', 'P01']]),
      },
    },
  ]
  const result = await createTextRepresentation({
    profile: 'metadata',
    maxEncodedBytes: () => 8,
    async encode() {
      return 'pixels'
    },
  }).prepare({ source, views, signal })
  assert.equal(result.metadata.views.length, 1)
  const envelope = JSON.parse(String(result.state[0])) as {
    representationView: {
      aliases: { id: string; role: string }[]
      dimensions: { width: number; height: number }
      scaleX: number
      grid: { viewId: string; cells: { label: string | null }[] }[]
    }
  }
  const representationView = envelope.representationView
  assert.deepEqual(
    representationView.aliases.map(({ id, role }) => [id, role]),
    [
      ['source', 'source'],
      ['crop-alias', 'crop'],
      ['grid-alias', 'grid'],
    ],
  )
  assert.deepEqual(representationView.dimensions, { width: 2, height: 2 })
  assert.equal(representationView.scaleX, 1)
  assert.equal(representationView.grid[0]?.cells[0]?.label, 'P01')
  assert.equal(result.state[1], 'pixels')
})

await test('noisy RLE views shrink under worst-case aggregate allocation before any encode call', async () => {
  const width = 5 * 64
  const height = 64
  const noisy = Uint8Array.from(
    { length: width * height * 4 },
    (_, index) => (index * 73 + 41) % 256,
  )
  const bytes = await sharp(Buffer.from(noisy), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer()
  const raster = createSharpRaster()
  const source = await raster.normalize(bytes, signal)
  const views: RepresentationView[] = Array.from({ length: 5 }, (_, index) => ({
    id: `view-${index}`,
    role: index === 0 ? 'source' : 'crop',
    image: source,
    sourceRegion: { left: index * 64, top: 0, width: 64, height: 64 },
  }))
  const planned: string[] = []
  let encodingStarted = false
  const encoder = {
    profile: pixelRleV1Encoder.profile,
    maxEncodedBytes(viewWidth: number, viewHeight: number) {
      assert.equal(encodingStarted, false, 'allocation is frozen before encoding')
      planned.push(`${viewWidth}x${viewHeight}`)
      return pixelRleV1MaxEncodedBytes(viewWidth, viewHeight)
    },
    async encode(view: TextPixelView, abortSignal: AbortSignal) {
      encodingStarted = true
      assert.ok(view.width < 64)
      return pixelRleV1Encoder.encode(view, abortSignal)
    },
  }
  const result = await createTextRepresentation(encoder).prepare({ source, views, signal })
  assert.ok(planned.includes('64x64'))
  assert.equal(result.metadata.views.length, 5)
  assert.ok(result.metadata.bytes <= 64 * 1024)
  assert.equal(result.state.length, 10)
  assert.ok(
    result.state.every(
      (part) => typeof part === 'string' && Buffer.byteLength(part, 'utf8') <= 64000,
    ),
  )
})
