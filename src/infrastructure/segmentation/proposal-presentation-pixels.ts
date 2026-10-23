import type { PixelRect } from '../../entities/contracts.js'

export function maskBounds(mask: Uint8Array, width: number, height: number): PixelRect | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right < left || bottom < top
    ? null
    : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

export function makeOverlay(
  source: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  bounds: PixelRect | null,
): Uint8Array {
  const output = new Uint8Array(source.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const offset = index * 4
      output[offset] = source[offset]!
      output[offset + 1] = source[offset + 1]!
      output[offset + 2] = source[offset + 2]!
      output[offset + 3] = source[offset + 3]!
      if (mask[index] === 0) continue
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        mask[index - 1] === 0 ||
        mask[index + 1] === 0 ||
        mask[index - width] === 0 ||
        mask[index + width] === 0
      if (edge) {
        output[offset] = 0
        output[offset + 1] = 255
        output[offset + 2] = 255
        output[offset + 3] = 255
      } else {
        output[offset] = Math.round(source[offset]! * 0.65 + 255 * 0.35)
        output[offset + 1] = Math.round(source[offset + 1]! * 0.65 + 32 * 0.35)
        output[offset + 2] = Math.round(source[offset + 2]! * 0.65 + 32 * 0.35)
      }
    }
  }
  if (bounds !== null) {
    const right = bounds.left + bounds.width - 1
    const bottom = bounds.top + bounds.height - 1
    for (let x = bounds.left; x <= right; x++) {
      paintRectanglePixel(output, width, x, bounds.top)
      paintRectanglePixel(output, width, x, bottom)
    }
    for (let y = bounds.top; y <= bottom; y++) {
      paintRectanglePixel(output, width, bounds.left, y)
      paintRectanglePixel(output, width, right, y)
    }
  }
  return output
}

function paintRectanglePixel(output: Uint8Array, width: number, x: number, y: number): void {
  const offset = (y * width + x) * 4
  output[offset] = 255
  output[offset + 1] = 220
  output[offset + 2] = 0
  output[offset + 3] = 255
}

export function makeCutout(
  source: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  bounds: PixelRect,
): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(bounds.width * bounds.height * 4)
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const sourceIndex = (bounds.top + y) * width + bounds.left + x
      const outputIndex = (y * bounds.width + x) * 4
      if (mask[sourceIndex] === 0) continue
      data[outputIndex] = source[sourceIndex * 4]!
      data[outputIndex + 1] = source[sourceIndex * 4 + 1]!
      data[outputIndex + 2] = source[sourceIndex * 4 + 2]!
      data[outputIndex + 3] = source[sourceIndex * 4 + 3]!
    }
  }
  return { data, width: bounds.width, height: bounds.height }
}
