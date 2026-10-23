import { assertActive } from '../../src/entities/errors.js'
import type { TextPixelView, TextRepresentationEncoder } from './text-representation.js'
import { assertPixelView, hexRgba, rgbaAt, utf8Size } from './encoder-common.js'

const paletteCap = 16
const digits = '0123456789ABCDEF'
const header = 'PALETTE_GRID_V1'

interface ColorEntry {
  rgba: [number, number, number, number]
  hex: string
  count: number
}

function makePalette(view: TextPixelView): ColorEntry[] {
  const counts = new Map<string, ColorEntry>()
  for (let pixel = 0; pixel < view.width * view.height; pixel += 1) {
    const rgba = rgbaAt(view.data, pixel)
    const hex = hexRgba(rgba)
    const current = counts.get(hex)
    if (current) current.count += 1
    else counts.set(hex, { rgba, hex, count: 1 })
  }
  return [...counts.values()]
    .sort(
      (left, right) =>
        right.count - left.count || (left.hex < right.hex ? -1 : left.hex > right.hex ? 1 : 0),
    )
    .slice(0, paletteCap)
}

function closestIndex(rgba: readonly number[], palette: readonly ColorEntry[]): number {
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  palette.forEach((entry, index) => {
    const distance = rgba.reduce((sum, value, channel) => {
      const difference = value - (entry.rgba[channel] ?? 0)
      return sum + difference * difference
    }, 0)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return bestIndex
}

export function encodePaletteGridV1(view: TextPixelView): string {
  assertPixelView(view)
  const palette = makePalette(view)
  const rows: string[] = []
  for (let y = 0; y < view.height; y += 1) {
    let row = ''
    for (let x = 0; x < view.width; x += 1)
      row += digits[closestIndex(rgbaAt(view.data, y * view.width + x), palette)] ?? '0'
    rows.push(`y${y}: ${row}`)
  }
  const paletteLines = palette.map((entry, index) => `${digits[index]}=#${entry.hex}`)
  return `${header}\nwidth=${view.width} height=${view.height} colors=${palette.length}\n${paletteLines.join('\n')}\ngrid:\n${rows.join('\n')}`
}

export function paletteGridV1MaxEncodedBytes(width: number, height: number): number {
  let size = utf8Size(`${header}\nwidth=${width} height=${height} colors=${paletteCap}\n`)
  for (let index = 0; index < paletteCap; index += 1)
    size += utf8Size(`${digits[index]}=#FFFFFFFF`) + (index === 0 ? 0 : 1)
  size += utf8Size('\ngrid:\n')
  for (let y = 0; y < height; y += 1) size += utf8Size(`y${y}: `) + width
  return size + Math.max(0, height - 1)
}

export const paletteGridV1Encoder: TextRepresentationEncoder = {
  profile: 'palette-grid-v1',
  maxEncodedBytes: paletteGridV1MaxEncodedBytes,
  async encode(view, signal) {
    assertActive(signal)
    return encodePaletteGridV1(view)
  },
}
