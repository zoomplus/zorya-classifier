import { assertActive } from '../../src/entities/errors.js'
import type { TextPixelView, TextRepresentationEncoder } from './text-representation.js'
import { assertPixelView, luma, rgbaAt, utf8Size } from './encoder-common.js'

const ramp = '.:-=+*#%@'
const header = 'ASCII_LUMA_V1'

export function encodeAsciiLumaV1(view: TextPixelView): string {
  assertPixelView(view)
  const rows: string[] = []
  for (let y = 0; y < view.height; y += 1) {
    let row = ''
    for (let x = 0; x < view.width; x += 1) {
      const color = rgbaAt(view.data, y * view.width + x)
      if (color[3] === 0) row += 'T'
      else row += ramp[Math.round((luma(color[0], color[1], color[2]) * (ramp.length - 1)) / 255)]
    }
    rows.push(`y${y}: ${row}`)
  }
  return `${header}\nwidth=${view.width} height=${view.height}\nlegend=opaque-luma-ramp,transparent:T\n\n${rows.join('\n')}`
}

export function asciiLumaV1MaxEncodedBytes(width: number, height: number): number {
  let size = utf8Size(
    `${header}\nwidth=${width} height=${height}\nlegend=opaque-luma-ramp,transparent:T\n\n`,
  )
  for (let y = 0; y < height; y += 1) size += utf8Size(`y${y}: `) + width
  return size + Math.max(0, height - 1)
}

export const asciiLumaV1Encoder: TextRepresentationEncoder = {
  profile: 'ascii-luma-v1',
  maxEncodedBytes: asciiLumaV1MaxEncodedBytes,
  async encode(view, signal) {
    assertActive(signal)
    return encodeAsciiLumaV1(view)
  },
}
