import sharp from 'sharp'
import { z } from 'zod'
import type { DecisionRequest, DecisionState, ImagePart } from '../../src/entities/contracts.js'
import { limits } from '../../src/entities/contracts.js'
import { assertActive, ClassifierError } from '../../src/entities/errors.js'

export const jpegTransportProfile = {
  id: 'opaque-jpeg-if-smaller-v1',
  quality: 92,
  chromaSubsampling: '4:4:4',
  maximumImages: 9,
  maximumInputBytes: 64 * 1024 * 1024,
  resize: false,
  transparentImages: 'preserve-original-png',
} as const

export interface TransportImageAudit {
  stateIndex: number
  width: number
  height: number
  inputBytes: number
  outputBytes: number
  outputFormat: 'png' | 'jpeg'
  reason: 'smaller-opaque-jpeg' | 'transparent-png' | 'smaller-lossless-png' | 'oriented-png'
}

const imagePartSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: z.string(),
        detail: z.literal('high'),
      })
      .strict(),
  })
  .strict()
const prefix = 'data:image/png;base64,'
const encodedByteLimit = 4 * Math.ceil(limits.imageBytes / 3)

function readPngPart(value: unknown): { part: ImagePart; bytes: Buffer } {
  const parsed = imagePartSchema.safeParse(value)
  if (!parsed.success || !parsed.data.image_url.url.startsWith(prefix))
    throw new ClassifierError('INVALID_INPUT', 'Transport experiment accepts bounded PNG data URLs')
  const encoded = parsed.data.image_url.url.slice(prefix.length)
  if (encoded.length > encodedByteLimit)
    throw new ClassifierError('RESOURCE_LIMIT', 'Transport image exceeds its byte budget')
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0)
    throw new ClassifierError('INVALID_INPUT', 'Transport image has invalid base64')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength < 1 || bytes.byteLength > limits.imageBytes)
    throw new ClassifierError('RESOURCE_LIMIT', 'Transport image exceeds its byte budget')
  if (bytes.toString('base64') !== encoded)
    throw new ClassifierError('INVALID_INPUT', 'Transport image base64 is not canonical')
  return { part: parsed.data, bytes }
}

async function prepareImage(
  value: unknown,
  stateIndex: number,
  signal: AbortSignal,
): Promise<{ part: ImagePart; audit: TransportImageAudit }> {
  assertActive(signal)
  const { part, bytes } = readPngPart(value)
  const pipeline = sharp(bytes, { limitInputPixels: limits.imagePixels, failOn: 'error' })
  let jpeg: Buffer | undefined
  try {
    const metadata = await pipeline.metadata()
    assertActive(signal)
    const width = metadata.width
    const height = metadata.height
    if (
      metadata.format !== 'png' ||
      (metadata.pages ?? 1) !== 1 ||
      !width ||
      !height ||
      width > 16384 ||
      height > 16384 ||
      width * height > limits.imagePixels
    )
      throw new ClassifierError('INVALID_INPUT', 'Transport image is not one bounded PNG raster')
    const audit: TransportImageAudit = {
      stateIndex,
      width,
      height,
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      outputFormat: 'png',
      reason: 'oriented-png',
    }
    // Do not strip an orientation tag whose display transform has not been baked into pixels.
    if (metadata.orientation !== undefined && metadata.orientation !== 1) return { part, audit }
    const stats = await pipeline.stats()
    assertActive(signal)
    if (!stats.isOpaque) return { part, audit: { ...audit, reason: 'transparent-png' } }
    jpeg = await pipeline
      .removeAlpha()
      .jpeg({ quality: jpegTransportProfile.quality, chromaSubsampling: '4:4:4', mozjpeg: false })
      .toBuffer()
    assertActive(signal)
    if (jpeg.byteLength >= bytes.byteLength)
      return { part, audit: { ...audit, reason: 'smaller-lossless-png' } }
    return {
      part: {
        ...part,
        image_url: { ...part.image_url, url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
      },
      audit: {
        ...audit,
        outputBytes: jpeg.byteLength,
        outputFormat: 'jpeg',
        reason: 'smaller-opaque-jpeg',
      },
    }
  } catch (error) {
    assertActive(signal)
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError('INVALID_INPUT', 'Cannot prepare bounded PNG transport experiment')
  } finally {
    pipeline.destroy()
    bytes.fill(0)
    jpeg?.fill(0)
  }
}

/** Research-only presentation: geometry is unchanged; no image facts or coordinates are inferred. */
export async function prepareJpegTransportRequest(
  request: DecisionRequest,
  signal: AbortSignal,
): Promise<{ request: DecisionRequest; images: TransportImageAudit[] }> {
  assertActive(signal)
  const snapshot = structuredClone(request)
  const imageParts = snapshot.state.filter((part) => typeof part !== 'string')
  if (imageParts.length > jpegTransportProfile.maximumImages)
    throw new ClassifierError('RESOURCE_LIMIT', 'Transport experiment exceeds nine images')
  // Reserve the complete encoded input before decoding any of its images.
  let inputBytes = 0
  for (const part of imageParts) {
    const parsed = imagePartSchema.safeParse(part)
    if (!parsed.success || !parsed.data.image_url.url.startsWith(prefix))
      throw new ClassifierError('INVALID_INPUT', 'Transport experiment requires PNG data URLs')
    const encodedLength = parsed.data.image_url.url.length - prefix.length
    if (encodedLength > encodedByteLimit)
      throw new ClassifierError('RESOURCE_LIMIT', 'Transport image exceeds its byte budget')
    inputBytes += Math.floor((encodedLength * 3) / 4)
  }
  if (inputBytes > jpegTransportProfile.maximumInputBytes)
    throw new ClassifierError(
      'RESOURCE_LIMIT',
      'Transport experiment exceeds aggregate byte budget',
    )
  const state: DecisionState = []
  const images: TransportImageAudit[] = []
  for (const [index, part] of snapshot.state.entries()) {
    assertActive(signal)
    if (typeof part === 'string') state.push(part)
    else {
      const prepared = await prepareImage(part, index, signal)
      assertActive(signal)
      state.push(prepared.part)
      images.push(prepared.audit)
    }
  }
  return { request: { ...snapshot, state }, images }
}
