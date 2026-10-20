import type { PixelRect } from '../../entities/contracts.js'
import type { BinaryMask } from '../../entities/segmentation.js'
import type { RgbaRaster } from '../../entities/representation.js'

export type MaskBox = PixelRect

export function validateMask(
  mask: BinaryMask,
  image: RgbaRaster,
  roi: PixelRect,
  seed: PixelRect,
): MaskBox | undefined {
  const pixels = image.width * image.height
  if (
    !Number.isSafeInteger(pixels) ||
    pixels < 1 ||
    pixels > 16_777_216 ||
    image.data.length !== pixels * 4 ||
    mask.format !== 'binary-u8' ||
    mask.width !== image.width ||
    mask.height !== image.height ||
    mask.data.length !== pixels ||
    !inside(roi, image.width, image.height) ||
    !inside(seed, image.width, image.height) ||
    !intersects(roi, seed)
  )
    throw new TypeError('Segmentation dimensions or bounds do not match the canonical image')

  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  let intersectsSeed = false
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const value = mask.data[y * image.width + x]
      if (value !== 0 && value !== 1) throw new TypeError('Mask values must be binary 0 or 1')
      if (value !== 1) continue
      if (x < roi.left || y < roi.top || x >= roi.left + roi.width || y >= roi.top + roi.height)
        throw new TypeError('Mask contains pixels outside the hard ROI')
      const alpha = image.data[(y * image.width + x) * 4 + 3]
      if (alpha === undefined || alpha === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      if (
        x >= seed.left &&
        y >= seed.top &&
        x < seed.left + seed.width &&
        y < seed.top + seed.height
      )
        intersectsSeed = true
    }
  }
  if (right < left || !intersectsSeed) return undefined
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

export function cropMask(mask: BinaryMask, box: PixelRect): BinaryMask {
  const data = new Uint8Array(box.width * box.height)
  for (let y = 0; y < box.height; y++) {
    const from = (box.top + y) * mask.width + box.left
    data.set(mask.data.subarray(from, from + box.width), y * box.width)
  }
  return { data, width: box.width, height: box.height, format: 'binary-u8' }
}

export function maskedRgba(image: RgbaRaster, mask: BinaryMask, box: PixelRect): Uint8Array {
  const output = new Uint8Array(box.width * box.height * 4)
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const sourceIndex = (box.top + y) * image.width + box.left + x
      if (mask.data[sourceIndex] !== 1) continue
      const source = sourceIndex * 4
      const target = (y * box.width + x) * 4
      output[target] = image.data[source] ?? 0
      output[target + 1] = image.data[source + 1] ?? 0
      output[target + 2] = image.data[source + 2] ?? 0
      output[target + 3] = image.data[source + 3] ?? 0
    }
  }
  return output
}

function inside(rect: PixelRect, width: number, height: number): boolean {
  return (
    Number.isSafeInteger(rect.left) &&
    Number.isSafeInteger(rect.top) &&
    Number.isSafeInteger(rect.width) &&
    Number.isSafeInteger(rect.height) &&
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left + rect.width <= width &&
    rect.top + rect.height <= height
  )
}

function intersects(first: PixelRect, second: PixelRect): boolean {
  return (
    first.left < second.left + second.width &&
    second.left < first.left + first.width &&
    first.top < second.top + second.height &&
    second.top < first.top + first.height
  )
}
