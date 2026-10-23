import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePixelRleV1, encodePixelRleV1 } from '../benchmarks/experiments/pixel-rle-v1.js'
import { pixelRleV1Encoder } from '../benchmarks/experiments/pixel-rle-v1.js'
import type { TextPixelView } from '../benchmarks/experiments/text-representation.js'

function view(width: number, height: number, data: number[]): TextPixelView {
  return {
    id: 'test',
    role: 'source',
    sourceRegion: { left: 0, top: 0, width, height },
    width,
    height,
    data: Uint8Array.from(data),
  }
}

await test('pixel-rle-v1 roundtrips normalized RGBA8 pixels exactly', () => {
  const input = view(
    4,
    2,
    [
      255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 9,
      10, 11, 12,
    ],
  )
  const encoded = encodePixelRleV1(input)
  assert.deepEqual(decodePixelRleV1(encoded), {
    data: input.data,
    width: input.width,
    height: input.height,
  })
})

await test('pixel-rle-v1 decodes the specified blank-line grammar example', () => {
  const example = [
    'PIXEL_RLE_V1',
    'width=8 height=2',
    'color=RGBA8 order=row-major',
    '',
    'y0: #FF0000FF*5 #000000FF*3',
    'y1: #FFFFFFFF*8',
  ].join('\n')
  const decoded = decodePixelRleV1(example)
  assert.equal(decoded.width, 8)
  assert.equal(decoded.height, 2)
  assert.deepEqual([...decoded.data.slice(0, 20)], Array(5).fill([255, 0, 0, 255]).flat())
  assert.match(encodePixelRleV1(view(1, 1, [1, 2, 3, 4])), /row-major\n\ny0:/)
  assert.ok(
    pixelRleV1Encoder.maxEncodedBytes(64, 64) >=
      Buffer.byteLength(
        encodePixelRleV1(
          view(
            64,
            64,
            Array.from({ length: 64 * 64 * 4 }, (_, i) => i % 256),
          ),
        ),
      ),
  )
})

await test('pixel-rle-v1 rejects malformed rows, counts, dimensions, and row crossing', () => {
  const good = encodePixelRleV1(view(2, 1, [0, 0, 0, 0, 255, 255, 255, 255]))
  const malformed = [
    good.replace('y0:', 'y00:'),
    good.replace('*1', '*0'),
    good.replace('*1', '*1e0'),
    good.replace('*1 #FFFFFFFF*1', '*3'),
    good.replace('width=2 height=1', 'width=65 height=1'),
    good.replace('y0:', 'y1:'),
    good.replace('#00000000', '#0000000a'),
  ]
  for (const value of malformed) assert.throws(() => decodePixelRleV1(value))
})

await test('pixel-rle-v1 rejects duplicate, missing, and out-of-order rows', () => {
  const twoRows = encodePixelRleV1(view(1, 2, [0, 0, 0, 0, 0, 0, 0, 0]))
  assert.throws(() => decodePixelRleV1(twoRows.replace('y1:', 'y0:')))
  assert.throws(() => decodePixelRleV1(twoRows.replace('y1: #00000000*1', '')))
  const reversed = twoRows.replace('y0: #00000000*1\ny1:', 'y1: #00000000*1\ny0:')
  assert.throws(() => decodePixelRleV1(reversed))
})
