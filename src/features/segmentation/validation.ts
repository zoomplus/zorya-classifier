import { z } from 'zod'

import type { RasterImage } from '../../entities/contracts.js'
import { parse } from '../../entities/contracts.js'
import { ClassifierError } from '../../entities/errors.js'
import { segmentationMetadataSchema } from '../../entities/segmentation-metadata.js'
import type { SegmentationMetadata, SegmentationResult } from '../../entities/segmentation.js'
import type { RgbaRaster } from '../../entities/representation.js'

const binaryMaskSchema = z
  .object({
    data: z.instanceof(Uint8Array),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.literal('binary-u8'),
  })
  .strict()

const rgbaSchema = z
  .object({
    data: z.instanceof(Uint8Array),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    format: z.literal('rgba8'),
  })
  .strict()

const segmentationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('segmented'),
      mask: binaryMaskSchema,
      metadata: segmentationMetadataSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unknown'),
      reason: z.string().min(1).max(500),
      metadata: segmentationMetadataSchema,
    })
    .strict(),
])

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

/** Validates PNG magic bytes and returns an owned copy of the payload. */
export function validateAndSnapshotPng(rawPng: unknown): Uint8Array {
  if (
    !(rawPng instanceof Uint8Array) ||
    rawPng.byteLength < 8 ||
    !PNG_SIGNATURE.every((byte, index) => rawPng[index] === byte)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Cutout raster port returned invalid PNG bytes')
  return new Uint8Array(rawPng)
}

/** Validates and owns a segmenter's result before any subsequent asynchronous work. */
export function validateSegmentationResult(
  value: unknown,
  width: number,
  height: number,
): SegmentationResult {
  const validation = segmentationResultSchema.safeParse(value)
  if (!validation.success)
    throw new ClassifierError('INVALID_RESPONSE', 'Segmenter returned an invalid result', {
      paths: validation.error.issues.map((issue) => issue.path.join('.')),
    })
  if (
    validation.data.metadata.input.width !== width ||
    validation.data.metadata.input.height !== height
  )
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Segmenter metadata dimensions do not match the source image',
    )
  return validation.data.status === 'segmented'
    ? {
        status: 'segmented',
        mask: { ...validation.data.mask, data: new Uint8Array(validation.data.mask.data) },
        metadata: snapshotMetadata(validation.data.metadata),
      }
    : {
        ...validation.data,
        metadata: snapshotMetadata(validation.data.metadata),
      }
}

export function assertRasterImage(image: RasterImage): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > 16_777_216 ||
    image.bytes.byteLength < 1
  )
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Raster normalizer returned invalid source dimensions',
    )
}

export function validateAndSnapshotRgba(value: unknown, width: number, height: number): RgbaRaster {
  const image = parse(rgbaSchema, value, 'INVALID_RESPONSE')
  if (
    image.format !== 'rgba8' ||
    image.width !== width ||
    image.height !== height ||
    !(image.data instanceof Uint8Array) ||
    image.data.length !== width * height * 4
  )
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Cutout raster port returned invalid RGBA dimensions',
    )
  return { data: new Uint8Array(image.data), width, height, format: 'rgba8' }
}

function snapshotMetadata(
  metadata: z.infer<typeof segmentationMetadataSchema>,
): SegmentationMetadata {
  return {
    method: metadata.method,
    backend: metadata.backend,
    durationMs: metadata.durationMs,
    input: { ...metadata.input },
    ...(metadata.qualityScore !== undefined ? { qualityScore: metadata.qualityScore } : {}),
  }
}
