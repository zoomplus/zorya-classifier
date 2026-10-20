import { ClassifierError } from '../../entities/errors.js'
import { objectProposalLimits, type PackedBinaryMask } from '../../entities/object-proposals.js'

/** Pack row-major binary pixels into bytes, least-significant bit first. */
export function packBinaryMask(mask: Uint8Array, width: number, height: number): PackedBinaryMask {
  const pixels = checkedPixelCount(width, height)
  if (!(mask instanceof Uint8Array) || mask.length !== pixels)
    throw new ClassifierError('INVALID_INPUT', 'Binary mask dimensions do not match its pixels')
  const data = new Uint8Array(Math.ceil(pixels / 8))
  if (data.byteLength > objectProposalLimits.packedBytes)
    throw new ClassifierError('RESOURCE_LIMIT', 'Packed binary mask exceeds its byte limit')
  for (let index = 0; index < pixels; index++) {
    const value = mask[index]
    if (value !== 0 && value !== 1)
      throw new ClassifierError('INVALID_RESPONSE', 'Binary mask pixels must be zero or one')
    if (value === 1) data[index >> 3] = (data[index >> 3] ?? 0) | (1 << (index & 7))
  }
  return { data, width, height, format: 'binary-lsb0' }
}

/** Validate and unpack an owned LSB-first mask into one byte per source pixel. */
export function unpackBinaryMask(mask: PackedBinaryMask): Uint8Array {
  if (
    typeof mask !== 'object' ||
    mask === null ||
    mask.format !== 'binary-lsb0' ||
    !(mask.data instanceof Uint8Array)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Packed mask format is invalid')
  const pixels = checkedPixelCount(mask.width, mask.height, 'INVALID_RESPONSE')
  const expectedBytes = Math.ceil(pixels / 8)
  if (mask.data.length !== expectedBytes || mask.data.byteLength > objectProposalLimits.packedBytes)
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Packed mask length does not match its dimensions',
    )
  const unusedBits = expectedBytes * 8 - pixels
  if (unusedBits > 0) {
    const allowed = (1 << (8 - unusedBits)) - 1
    const last = mask.data[expectedBytes - 1]
    if (last === undefined || (last & ~allowed) !== 0)
      throw new ClassifierError('INVALID_RESPONSE', 'Packed mask has nonzero padding bits')
  }
  const output = new Uint8Array(pixels)
  for (let index = 0; index < pixels; index++)
    output[index] = ((mask.data[index >> 3] ?? 0) >> (index & 7)) & 1
  return output
}

function checkedPixelCount(
  width: number,
  height: number,
  errorCode: 'INVALID_INPUT' | 'INVALID_RESPONSE' = 'INVALID_INPUT',
): number {
  const pixels = width * height
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(pixels) ||
    pixels > objectProposalLimits.imagePixels
  )
    throw new ClassifierError(errorCode, 'Binary mask dimensions exceed the proposal limit')
  return pixels
}
