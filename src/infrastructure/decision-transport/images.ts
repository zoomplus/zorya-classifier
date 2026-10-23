import { invalid } from './errors.js'

function imageSize(bytes: Buffer, format: string): [number, number] {
  if (format === 'png') {
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw invalid('INVALID_INPUT', 'Invalid PNG image header')
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  if (bytes[0] !== 255 || bytes[1] !== 216)
    throw invalid('INVALID_INPUT', 'Invalid JPEG image header')
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) break
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 218 || marker === 217) break
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) break
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
    }
    offset += length
  }
  throw invalid('INVALID_INPUT', 'Invalid JPEG image dimensions')
}

export function validateImage(url: string): void {
  const prefix = /^data:image\/(png|jpeg);base64,/u.exec(url)
  if (!prefix) throw invalid('INVALID_INPUT', 'Only inline PNG or JPEG images are supported')
  const encoded = url.slice(prefix[0].length)
  const padding = encoded.endsWith('==') ? 2 : Number(encoded.endsWith('='))
  if (
    !encoded.length ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+$/u.test(encoded.slice(0, encoded.length - padding))
  )
    throw invalid('INVALID_INPUT', 'Invalid image base64')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== encoded)
    throw invalid('INVALID_INPUT', 'Invalid image byte representation')
  const [width, height] = imageSize(bytes, prefix[1] ?? '')
  if (width < 280 || height < 280 || width > 1568 || height > 1568)
    throw invalid('INVALID_INPUT', 'Prepared image sides must be 280..1568 pixels')
}
