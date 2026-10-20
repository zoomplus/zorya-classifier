import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import type { TextPixelView } from '../src/infrastructure/text-representation.js'
import { asciiContoursV1Encoder } from '../benchmarks/experiments/ascii-contours-v1.js'
import { asciiLumaV1Encoder } from '../benchmarks/experiments/ascii-luma-v1.js'
import { asciiSvgLayeredV1Encoder } from '../benchmarks/experiments/ascii-svg-layered-v1.js'
import { paletteGridV1Encoder } from '../benchmarks/experiments/palette-grid-v1.js'
import { svgContoursV1Encoder } from '../benchmarks/experiments/svg-contours-v1.js'
import { textEncodersV1 } from '../benchmarks/experiments/text-encoders-v1.js'

function makeView(width: number, height: number, rgba: readonly number[]): TextPixelView {
  return {
    id: 'fixture',
    role: 'source',
    sourceRegion: { left: 0, top: 0, width, height },
    width,
    height,
    data: Uint8Array.from(rgba),
  }
}

function flatPixels(width: number, height: number, color: readonly number[]): number[] {
  return Array.from({ length: width * height }, () => [...color]).flat()
}

const signal = new AbortController().signal

await test('research registry contains all six versioned encoders', () => {
  assert.deepEqual(Object.keys(textEncodersV1), [
    'ascii-luma-v1',
    'palette-grid-v1',
    'svg-contours-v1',
    'pixel-rle-v1',
    'ascii-contours-v1',
    'ascii-svg-layered-v1',
  ])
})

await test('ASCII luma distinguishes transparent pixels from opaque luminance', async () => {
  const view = makeView(3, 1, [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0])
  const encoded = await asciiLumaV1Encoder.encode(view, signal)
  assert.match(encoded, /legend=opaque-luma-ramp,transparent:T/)
  assert.match(encoded, /y0: \.@T$/)
  assert.ok(
    asciiLumaV1Encoder.maxEncodedBytes(view.width, view.height) >= Buffer.byteLength(encoded),
  )
})

await test('palette grid is deterministic, generic, and keeps alpha in palette colors', async () => {
  const view = makeView(3, 1, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0])
  const first = await paletteGridV1Encoder.encode(view, signal)
  const second = await paletteGridV1Encoder.encode(view, signal)
  assert.equal(first, second)
  assert.match(first, /#00000000/)
  assert.match(first, /#00FF00FF/)
  assert.match(first, /#FF0000FF/)
  assert.ok(paletteGridV1Encoder.maxEncodedBytes(3, 1) >= Buffer.byteLength(first))
})

await test('SVG contours retain original color and transparency without active content', async () => {
  const view = makeView(
    3,
    2,
    [240, 10, 20, 255, 240, 10, 20, 255, 0, 0, 0, 0, 240, 10, 20, 255, 0, 0, 0, 0, 0, 0, 0, 0],
  )
  const encoded = await svgContoursV1Encoder.encode(view, signal)
  assert.match(encoded, /fill="#F00A14"/)
  assert.match(encoded, /fill-opacity="0"/)
  assert.doesNotMatch(encoded, /<script|href=|foreignObject/i)
  assert.ok(svgContoursV1Encoder.maxEncodedBytes(3, 2) >= Buffer.byteLength(encoded))
})

await test('SVG representation reports contour overflow without discarding small components', async () => {
  const width = 64
  const height = 64
  const pixels = Array.from({ length: width * height }, (_, index) => {
    const x = index % width
    const y = Math.floor(index / width)
    const color = (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]
    return color
  }).flat()
  await assert.rejects(
    svgContoursV1Encoder.encode(makeView(width, height, pixels), signal),
    /512 contour or 2048 vertex/,
  )
})

await test('contour ASCII handles constant and transparent inputs without inventing edges', async () => {
  const opaqueConstant = makeView(3, 2, flatPixels(3, 2, [45, 45, 45, 255]))
  const opaque = await asciiContoursV1Encoder.encode(opaqueConstant, signal)
  assert.match(opaque, /binary: Otsu\ny0: 000\ny1: 000/)
  assert.match(opaque, /edges: Sobel-magnitude>=128\ny0: \.{3}\ny1: \.{3}/)
  const transparent = makeView(2, 1, flatPixels(2, 1, [99, 20, 10, 0]))
  const empty = await asciiContoursV1Encoder.encode(transparent, signal)
  assert.match(empty, /y0: TT/)
  assert.match(empty, /edges: Sobel-magnitude>=128\ny0: TT/)
  assert.ok(asciiContoursV1Encoder.maxEncodedBytes(3, 2) >= Buffer.byteLength(opaque))
})

await test('contour ASCII applies p1/p99 contrast stretch and deterministic Otsu thresholding', async () => {
  const checker = makeView(
    2,
    2,
    [0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255],
  )
  const encoded = await asciiContoursV1Encoder.encode(checker, signal)
  assert.match(encoded, /luma=p1-p99\nbinary: Otsu\ny0: 01\ny1: 10/)
  assert.match(encoded, /edges: Sobel-magnitude>=128\ny0: ##\ny1: ##/)
})

await test('layered representation includes both planes at the same geometry', async () => {
  const view = makeView(2, 2, flatPixels(2, 2, [120, 40, 200, 128]))
  const encoded = await asciiSvgLayeredV1Encoder.encode(view, signal)
  assert.match(encoded, /ASCII_SVG_LAYERED_V1\nwidth=2 height=2/)
  assert.match(encoded, /ascii:\nASCII_CONTOURS_V1\nwidth=2 height=2/)
  assert.match(encoded, /svg:\nSVG_CONTOURS_V1\n<svg[^>]+width="2" height="2"/)
  assert.ok(asciiSvgLayeredV1Encoder.maxEncodedBytes(2, 2) >= Buffer.byteLength(encoded))
})

await test('encoder byte bounds cover a small varied RGBA raster and its PNG source', async () => {
  const width = 16
  const height = 16
  const data = Uint8Array.from({ length: width * height * 4 }, (_, index) =>
    index % 4 === 3 ? 255 : (index * 73 + 41) % 256,
  )
  const view = makeView(width, height, [...data])
  const png = await sharp(Buffer.from(view.data), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer()
  const rawBytes = width * height * 4
  assert.equal(rawBytes, 1024)
  assert.ok(png.byteLength > 0)
  for (const encoder of Object.values(textEncodersV1)) {
    const encoded = await encoder.encode(view, signal)
    assert.ok(
      encoder.maxEncodedBytes(view.width, view.height) >= Buffer.byteLength(encoded),
      `${encoder.profile} bound covers its encoded fixture`,
    )
  }
})
