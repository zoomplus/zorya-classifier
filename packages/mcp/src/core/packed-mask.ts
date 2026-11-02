import { McpCoreError } from '../errors.js'

/** Pack row-major binary pixels into bytes, least-significant bit first. */
export function packMaskBytes(data: Uint8Array, width: number, height: number): Uint8Array {
  const pixelCount = width * height
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(pixelCount) ||
    pixelCount > 16_777_216 ||
    data.byteLength !== pixelCount
  ) {
    throw new McpCoreError('ARTIFACT_UNAVAILABLE', 'Mask dimensions do not match its pixel data.')
  }
  const packed = new Uint8Array(Math.ceil(pixelCount / 8))
  for (let index = 0; index < pixelCount; index += 1) {
    const pixel = data[index]
    if (pixel !== 0 && pixel !== 1) {
      throw new McpCoreError('ARTIFACT_UNAVAILABLE', 'Mask pixels are not binary.')
    }
    if (pixel === 1) packed[index >> 3] = (packed[index >> 3] ?? 0) | (1 << (index & 7))
  }
  return packed
}
