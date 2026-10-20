import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePixelRleV1, encodePixelRleV1 } from '../benchmarks/experiments/pixel-rle-v1.js'
import type { TextPixelView } from '../src/infrastructure/text-representation.js'

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
