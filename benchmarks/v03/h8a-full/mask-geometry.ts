import type { PixelRect } from '../../../src/entities/contracts.js'
import { ClassifierError } from '../../../src/entities/errors.js'
import type { PackedBinaryMask } from '../../../src/entities/object-proposals.js'
import type { RgbaRaster } from '../../../src/entities/representation.js'
import { maskedRgba } from '../../../src/features/segmentation/mask.js'
import { unpackBinaryMask } from '../../../src/features/segmentation/packed-mask.js'
import { H8A_FULL_MAX_PACKED_MASK_BYTES } from './constants.js'

function invalid(message: string): ClassifierError {
  return new ClassifierError('INVALID_INPUT', message)
}

export function validatePackedMaskCopy(
  mask: PackedBinaryMask,
  width: number,
  height: number,
): PackedBinaryMask {
  const pixels = width * height
  const expected = Math.ceil(pixels / 8)
  if (
    mask.format !== 'binary-lsb0' ||
    !(mask.data instanceof Uint8Array) ||
    mask.width !== width ||
    mask.height !== height ||
    mask.data.byteLength !== expected
  )
    throw invalid('packed mask format or dimensions are invalid')
  const unusedBits = expected * 8 - pixels
  const lastByte = mask.data[expected - 1]
  if (
    unusedBits > 0 &&
    (lastByte === undefined || (lastByte & ~((1 << (8 - unusedBits)) - 1)) !== 0)
  )
    throw invalid('packed mask has nonzero padding bits')
  return {
    format: 'binary-lsb0',
    width,
    height,
    data: Uint8Array.from(mask.data),
  }
}

export function clipPackedMaskToVisibleAlpha(
  mask: PackedBinaryMask,
  image: RgbaRaster,
): PackedBinaryMask {
  if (
    image.format !== 'rgba8' ||
    !(image.data instanceof Uint8Array) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.byteLength !== image.width * image.height * 4
  )
    throw new ClassifierError('INVALID_RESPONSE', 'source RGBA frame is invalid')
  const owned = validatePackedMaskCopy(mask, image.width, image.height)
  const pixels = image.width * image.height
  for (let index = 0; index < pixels; index++) {
    if (((owned.data[index >> 3] ?? 0) & (1 << (index & 7))) === 0) continue
    if (image.data[index * 4 + 3] !== 0) continue
    owned.data[index >> 3] = (owned.data[index >> 3] ?? 0) & ~(1 << (index & 7))
  }
  return owned
}

export function foregroundBounds(mask: PackedBinaryMask): PixelRect | undefined {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  const pixels = mask.width * mask.height
  for (let index = 0; index < pixels; index++) {
    if (((mask.data[index >> 3] ?? 0) & (1 << (index & 7))) === 0) continue
    const x = index % mask.width
    const y = Math.floor(index / mask.width)
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  return right < left ? undefined : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

export function maskHasForeground(mask: PackedBinaryMask): boolean {
  return foregroundBounds(mask) !== undefined
}

export function regionCenter(region: PixelRect): { x: number; y: number } {
  return { x: region.left + region.width / 2, y: region.top + region.height / 2 }
}

export function buildOptionalCutout(
  image: RgbaRaster,
  mask: PackedBinaryMask,
  region: PixelRect,
): RgbaRaster | undefined {
  const binary = unpackBinaryMask(mask)
  try {
    const cutoutBytes = maskedRgba(
      image,
      { data: binary, width: mask.width, height: mask.height, format: 'binary-u8' },
      region,
    )
    return {
      data: cutoutBytes,
      width: region.width,
      height: region.height,
      format: 'rgba8',
    }
  } finally {
    binary.fill(0)
  }
}

function aggregatePackedByteLimit(width: number, height: number, count: number): number {
  return Math.ceil((width * height) / 8) * count
}

export function assertAggregatePackedWithinCap(width: number, height: number, count: number): void {
  if (aggregatePackedByteLimit(width, height, count) > H8A_FULL_MAX_PACKED_MASK_BYTES)
    throw invalid('aggregate packed-mask byte cap exceeded')
}
