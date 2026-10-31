import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { ClassifierError } from '../../../src/entities/errors.js'
import type { RgbaRaster } from '../../../src/entities/representation.js'
import { H8A_FULL_MAX_ENCODED_BYTES, H8A_FULL_MAX_ORIENTED_PIXELS } from './constants.js'

const MAX_IMAGE_SIDE = 16_384
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif'])

export interface OwnedOrientedSource {
  originalEncodedSha256: string
  frameSha256: string
  width: number
  height: number
  raster: RgbaRaster
  dispose(): void
}

export interface OwnedOrientedPng {
  bytes: Uint8Array
  sha256: string
  dispose(): void
}

function invalid(message: string, cause?: unknown): ClassifierError {
  return new ClassifierError('INVALID_INPUT', message, cause === undefined ? {} : { cause })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function copyEncodedImageBytes(source: Uint8Array): Uint8Array {
  if (!(source instanceof Uint8Array)) throw invalid('encoded image must be Uint8Array')
  if (source.byteLength > H8A_FULL_MAX_ENCODED_BYTES)
    throw invalid('encoded image exceeds 24 MiB before ownership copy')
  if (source.byteLength === 0) throw invalid('encoded image is empty')
  return Uint8Array.from(source)
}

export async function orientedDimensionsFromHeader(encoded: Uint8Array): Promise<{
  width: number
  height: number
  orientation: number
}> {
  if (encoded.byteLength > H8A_FULL_MAX_ENCODED_BYTES)
    throw invalid('encoded image exceeds byte cap before header inspection')
  if (!(encoded instanceof Uint8Array) || encoded.byteLength === 0)
    throw invalid('encoded image is empty or invalid')

  let meta: sharp.Metadata
  try {
    meta = await sharp(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength), {
      animated: false,
      limitInputPixels: H8A_FULL_MAX_ORIENTED_PIXELS,
    }).metadata()
  } catch (error) {
    throw invalid('image header could not be decoded', error)
  }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format))
    throw invalid('image format is not supported')
  if ((meta.pages ?? 1) !== 1) throw invalid('animated or multi-page images are unsupported')
  if (
    !Number.isSafeInteger(meta.width) ||
    !meta.width ||
    !Number.isSafeInteger(meta.height) ||
    !meta.height
  )
    throw invalid('image header lacks valid dimensions')
  const orientation = meta.orientation ?? 1
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8)
    throw invalid('image EXIF orientation is invalid')
  let width = meta.width
  let height = meta.height
  if (orientation >= 5 && orientation <= 8) [width, height] = [height, width]
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
    throw invalid('oriented image side exceeds limit before pixel allocation')
  if (width * height > H8A_FULL_MAX_ORIENTED_PIXELS)
    throw invalid('oriented pixel cap exceeded before full decode')
  return { width, height, orientation }
}

export async function decodeOrientedSource(encoded: Uint8Array): Promise<OwnedOrientedSource> {
  const header = await orientedDimensionsFromHeader(encoded)
  let result: { data: Buffer; info: sharp.OutputInfo }
  try {
    result = await sharp(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength), {
      animated: false,
      limitInputPixels: H8A_FULL_MAX_ORIENTED_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
  } catch (error) {
    throw invalid('encoded image failed oriented decode', error)
  }
  const { data, info } = result
  if (info.channels !== 4) {
    data.fill(0)
    throw invalid('decoded image is not RGBA')
  }
  if (
    info.width < 1 ||
    info.height < 1 ||
    info.width > MAX_IMAGE_SIDE ||
    info.height > MAX_IMAGE_SIDE ||
    info.width * info.height > H8A_FULL_MAX_ORIENTED_PIXELS
  ) {
    data.fill(0)
    throw invalid('decoded oriented dimensions exceed limits')
  }
  if (info.width !== header.width || info.height !== header.height) {
    data.fill(0)
    throw invalid('decoded oriented dimensions do not match validated image header')
  }
  const raster: RgbaRaster = {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    format: 'rgba8',
  }
  return {
    originalEncodedSha256: sha256(encoded),
    frameSha256: sha256(raster.data),
    width: info.width,
    height: info.height,
    raster,
    dispose() {
      raster.data.fill(0)
    },
  }
}

export async function encodeOrientedPng(source: OwnedOrientedSource): Promise<OwnedOrientedPng> {
  if (
    source.raster.format !== 'rgba8' ||
    source.raster.width !== source.width ||
    source.raster.height !== source.height ||
    source.raster.data.byteLength !== source.width * source.height * 4
  )
    throw new ClassifierError('INVALID_RESPONSE', 'oriented source frame is inconsistent')
  let png: Buffer
  try {
    png = await sharp(source.raster.data, {
      raw: { width: source.width, height: source.height, channels: 4 },
      limitInputPixels: H8A_FULL_MAX_ORIENTED_PIXELS,
      failOn: 'error',
    })
      .png({ compressionLevel: 6 })
      .toBuffer()
  } catch (error) {
    throw new ClassifierError('PROVIDER', 'oriented source PNG encoding failed', { cause: error })
  }
  if (png.byteLength === 0 || png.byteLength > H8A_FULL_MAX_ENCODED_BYTES) {
    png.fill(0)
    throw new ClassifierError('RESOURCE_LIMIT', 'oriented source PNG exceeds 24 MiB')
  }
  const bytes = Uint8Array.from(png)
  const digest = sha256(bytes)
  png.fill(0)
  return {
    bytes,
    sha256: digest,
    dispose() {
      bytes.fill(0)
    },
  }
}
