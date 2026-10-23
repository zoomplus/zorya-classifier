import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import type { TextPixelView, TextRepresentationEncoder } from './text-representation.js'

const maxSide = 64
const header = 'PIXEL_RLE_V1\n'
const colorHeader = 'color=RGBA8 order=row-major'

export function pixelRleV1MaxEncodedBytes(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > maxSide ||
    height > maxSide
  )
    throw new ClassifierError('RESOURCE_LIMIT', 'RLE resolution exceeds 64 by 64 pixels')
  let bytes = Buffer.byteLength(`${header}width=${width} height=${height}\n${colorHeader}\n\n`)
  for (let y = 0; y < height; y += 1)
    bytes += Buffer.byteLength(`y${y}: `) + width * 11 + Math.max(0, width - 1)
  bytes += Math.max(0, height - 1)
  return bytes
}

function validateRaster(view: Pick<TextPixelView, 'width' | 'height' | 'data'>): void {
  if (
    !Number.isSafeInteger(view.width) ||
    !Number.isSafeInteger(view.height) ||
    view.width < 1 ||
    view.height < 1 ||
    view.width > maxSide ||
    view.height > maxSide ||
    view.width * view.height > maxSide * maxSide ||
    view.data.byteLength !== view.width * view.height * 4
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'RLE raster dimensions or RGBA8 byte length are invalid',
    )
}

function colorAt(data: Uint8Array, offset: number): string {
  return [...data.subarray(offset, offset + 4)]
    .map((value) => value.toString(16).padStart(2, '0').toUpperCase())
    .join('')
}

export function encodePixelRleV1(view: TextPixelView): string {
  validateRaster(view)
  const rows: string[] = []
  for (let y = 0; y < view.height; y += 1) {
    const runs: string[] = []
    let x = 0
    while (x < view.width) {
      const color = colorAt(view.data, (y * view.width + x) * 4)
      let count = 1
      while (
        x + count < view.width &&
        colorAt(view.data, (y * view.width + x + count) * 4) === color
      )
        count += 1
      runs.push(`#${color}*${count}`)
      x += count
    }
    rows.push(`y${y}: ${runs.join(' ')}`)
  }
  return `${header}width=${view.width} height=${view.height}\n${colorHeader}\n\n${rows.join('\n')}`
}

export function decodePixelRleV1(encoded: string): {
  data: Uint8Array
  width: number
  height: number
} {
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024)
    throw new ClassifierError('RESOURCE_LIMIT', 'RLE input exceeds the request byte cap')
  const lines = encoded.split('\n')
  if (
    lines.length < 5 ||
    lines[0] !== 'PIXEL_RLE_V1' ||
    lines[2] !== colorHeader ||
    lines[3] !== ''
  )
    throw new ClassifierError('INVALID_INPUT', 'RLE header is invalid')
  const dimensionMatch = /^width=([1-9][0-9]*) height=([1-9][0-9]*)$/.exec(lines[1] ?? '')
  if (!dimensionMatch)
    throw new ClassifierError('INVALID_INPUT', 'RLE dimensions must be positive decimal integers')
  const width = Number(dimensionMatch[1])
  const height = Number(dimensionMatch[2])
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > maxSide ||
    height > maxSide ||
    width * height > maxSide * maxSide
  )
    throw new ClassifierError('RESOURCE_LIMIT', 'RLE dimensions exceed the 64 by 64 pixel cap')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== height + 4)
    throw new ClassifierError(
      'INVALID_INPUT',
      'RLE must contain exactly one row for every image row',
    )

  const rows: { color: number[]; count: number }[][] = []
  for (let index = 0; index < height; index += 1) {
    const line = lines[index + 4] ?? ''
    const match =
      /^y(0|[1-9][0-9]*): (#[0-9A-F]{8}\*[1-9][0-9]*(?: #[0-9A-F]{8}\*[1-9][0-9]*)*)$/.exec(line)
    if (!match || Number(match[1]) !== index)
      throw new ClassifierError('INVALID_INPUT', 'RLE rows must be unique and in ascending order')
    const runs = (match[2] ?? '').split(' ').map((token) => {
      const run = /^#([0-9A-F]{8})\*([1-9][0-9]*)$/.exec(token)
      if (!run) throw new ClassifierError('INVALID_INPUT', 'RLE run syntax is invalid')
      const count = Number(run[2])
      if (!Number.isSafeInteger(count) || count > width)
        throw new ClassifierError('INVALID_INPUT', 'RLE run count overflows its row')
      const hex = run[1] ?? ''
      const color = [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
      return { color, count }
    })
    let rowPixels = 0
    for (const run of runs) {
      rowPixels += run.count
      if (rowPixels > width)
        throw new ClassifierError('INVALID_INPUT', 'RLE runs cross row boundaries')
    }
    if (rowPixels !== width)
      throw new ClassifierError('INVALID_INPUT', 'RLE run counts do not fill the row exactly')
    rows.push(runs)
  }

  const data = new Uint8Array(width * height * 4)
  let pixel = 0
  for (const row of rows)
    for (const run of row)
      for (let count = 0; count < run.count; count += 1) {
        data.set(run.color, pixel * 4)
        pixel += 1
      }
  return { data, width, height }
}

export const pixelRleV1Encoder: TextRepresentationEncoder = {
  profile: 'pixel-rle-v1',
  maxEncodedBytes: pixelRleV1MaxEncodedBytes,
  async encode(view, signal) {
    assertActive(signal)
    return encodePixelRleV1(view)
  },
}
