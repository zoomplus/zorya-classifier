import { createHash } from 'node:crypto'
import type { BoxRect } from './geometry-metrics.js'

function packedBinaryLsb0ByteLength(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new RangeError('Invalid mask geometry')
  return Math.ceil((width * height) / 8)
}

export function sha256PackedBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function assertArtifactMapKeyMatchesBytes(mapKeySha256: string, bytes: Uint8Array): void {
  const actual = sha256PackedBytes(bytes)
  if (actual !== mapKeySha256) throw new RangeError('Artifact map key hash mismatch')
}

export function unpackBinaryLsb0V1(width: number, height: number, packed: Uint8Array): Uint8Array {
  const expectedLen = packedBinaryLsb0ByteLength(width, height)
  if (packed.length !== expectedLen) throw new RangeError('Packed mask length mismatch')
  const pixelCount = width * height
  const unpacked = new Uint8Array(pixelCount)
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const byteIndex = Math.floor(pixelIndex / 8)
    const bitIndex = pixelIndex % 8
    unpacked[pixelIndex] = (packed[byteIndex]! >> bitIndex) & 1
  }
  const remainder = pixelCount % 8
  if (remainder !== 0) {
    const lastByte = packed[packed.length - 1]!
    const usedLowBitsMask = (1 << remainder) - 1
    if ((lastByte & ~usedLowBitsMask) !== 0)
      throw new RangeError('Unused high bits in final packed byte must be zero')
  }
  return unpacked
}

export function packBinaryLsb0V1(
  width: number,
  height: number,
  binaryPixels: Uint8Array,
): Uint8Array {
  const pixelCount = width * height
  if (binaryPixels.length !== pixelCount) throw new RangeError('Binary mask pixel count mismatch')
  const packed = new Uint8Array(packedBinaryLsb0ByteLength(width, height))
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const value = binaryPixels[pixelIndex]
    if (value !== 0 && value !== 1) throw new RangeError('Mask pixels must be 0 or 1')
    if (value === 1) {
      const byteIndex = Math.floor(pixelIndex / 8)
      const bitIndex = pixelIndex % 8
      packed[byteIndex] = (packed[byteIndex] ?? 0) | (1 << bitIndex)
    }
  }
  return packed
}

export function countForegroundPixels(binaryPixels: Uint8Array): number {
  let count = 0
  for (let index = 0; index < binaryPixels.length; index++) {
    if (binaryPixels[index] === 1) count++
  }
  return count
}

/** Inclusive pixel bounds: left/top are min indices; width/height span through max index. */
export function deriveInclusivePixelBox(
  binaryPixels: Uint8Array,
  width: number,
  height: number,
): BoxRect | null {
  if (binaryPixels.length !== width * height) throw new RangeError('Binary mask geometry mismatch')
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (binaryPixels[y * width + x] === 1) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

export function boxesExactlyEqual(a: BoxRect, b: BoxRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}
