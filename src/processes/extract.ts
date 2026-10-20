import sharp from 'sharp'
import { z } from 'zod'

import type { PixelRect, RasterImage, RasterPort } from '../entities/contracts.js'
import { parse } from '../entities/contracts.js'
import type {
  ExtractionResult,
  SegmentationMetadata,
  SegmentationInput,
  SegmentationPort,
} from '../entities/segmentation.js'
import type { RgbaRaster } from '../entities/representation.js'
import { ClassifierError, assertActive } from '../entities/errors.js'
import type {
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import { cropMask, maskedRgba, validateMask } from '../features/segmentation/mask.js'

const binaryMaskSchema = z
  .object({
    data: z.instanceof(Uint8Array),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.literal('binary-u8'),
  })
  .strict()
const segmentationMetadataSchema = z
  .object({
    method: z.string().min(1).max(128),
    backend: z.string().min(1).max(128),
    durationMs: z.number().finite().nonnegative(),
    input: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    qualityScore: z.number().finite().nonnegative().optional(),
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

export type WholeObjectLocator = (
  image: RasterImage,
  request: Omit<WholeObjectLocateInput, 'image' | 'mode'> & { signal: AbortSignal },
) => Promise<WholeObjectLocalizationResult>

export interface ExtractDependencies {
  raster: RasterPort
  segmenter: SegmentationPort
  locateWhole: WholeObjectLocator
}

/** Runs whole-object location and explicit segmentation over one normalized source image. */
export async function extractObject(
  input: Omit<WholeObjectLocateInput, 'mode' | 'signal'> & {
    mode?: 'whole-object'
    signal: AbortSignal
  },
  dependencies: ExtractDependencies,
): Promise<ExtractionResult> {
  const ownedBytes = new Uint8Array(input.image)
  const parsed = parse(wholeObjectSchema, {
    image: ownedBytes,
    target: input.target,
    exclusions: input.exclusions,
    ...(input.roi ? { roi: input.roi } : {}),
    ...(input.representation ? { representation: input.representation } : {}),
    ...(input.boxTolerancePx !== undefined ? { boxTolerancePx: input.boxTolerancePx } : {}),
    ...(input.maxExtentPasses !== undefined ? { maxExtentPasses: input.maxExtentPasses } : {}),
    mode: 'whole-object',
  })
  const { signal } = input
  assertActive(signal)
  const normalized = await dependencies.raster.normalize(ownedBytes, signal)
  assertRasterImage(normalized)
  const source: RasterImage = { ...normalized, bytes: new Uint8Array(normalized.bytes) }
  assertActive(signal)

  const location = await dependencies.locateWhole(
    { ...source, bytes: new Uint8Array(source.bytes) },
    {
      target: parsed.target,
      exclusions: parsed.exclusions,
      ...(parsed.roi ? { roi: parsed.roi } : {}),
      ...(parsed.representation ? { representation: parsed.representation } : {}),
      boxTolerancePx: parsed.boxTolerancePx,
      maxExtentPasses: parsed.maxExtentPasses,
      signal,
    },
  )
  assertActive(signal)
  if (location.status !== 'located') return location

  const image = await toCanonicalRgba(source, signal)
  const roi = parsed.roi ?? { left: 0, top: 0, width: image.width, height: image.height }
  if (
    !contains({ left: 0, top: 0, width: image.width, height: image.height }, location.region) ||
    !contains(roi, location.region) ||
    !contains({ left: 0, top: 0, width: image.width, height: image.height }, location.seedRegion) ||
    !intersects(location.region, location.seedRegion) ||
    !intersects(roi, location.seedRegion)
  )
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Whole-object locator returned invalid source geometry',
    )

  const segmentInput: SegmentationInput = {
    image: { ...image, data: new Uint8Array(image.data) },
    seedRegion: { ...location.seedRegion },
    wholeRegion: { ...location.region },
    bounds: {
      left: { ...location.bounds.left },
      right: { ...location.bounds.right },
      top: { ...location.bounds.top },
      bottom: { ...location.bounds.bottom },
    },
    roi: { ...roi },
    target: parsed.target,
    exclusions: [...parsed.exclusions],
    completeness: location.completeness,
    signal,
  }
  const rawResult: unknown = await dependencies.segmenter.segment(segmentInput)
  assertActive(signal)
  const validation = segmentationResultSchema.safeParse(rawResult)
  if (!validation.success)
    throw new ClassifierError('INVALID_RESPONSE', 'Segmenter returned an invalid result', {
      paths: validation.error.issues.map((issue) => issue.path.join('.')),
    })
  if (
    validation.data.metadata.input.width !== image.width ||
    validation.data.metadata.input.height !== image.height
  )
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Segmenter metadata dimensions do not match the source image',
    )
  const result =
    validation.data.status === 'segmented'
      ? {
          status: 'segmented' as const,
          mask: { ...validation.data.mask, data: new Uint8Array(validation.data.mask.data) },
          metadata: {
            ...snapshotMetadata(validation.data.metadata),
          },
        }
      : {
          ...validation.data,
          metadata: snapshotMetadata(validation.data.metadata),
        }
  if (result.status === 'unknown')
    return {
      status: 'unknown',
      reason: 'segmentation-uncertain',
      location,
      segmentation: result.metadata,
    }

  let box: PixelRect | undefined
  try {
    box = validateMask(result.mask, image, roi, location.seedRegion)
  } catch {
    throw new ClassifierError('INVALID_RESPONSE', 'Segmenter mask failed binary/source validation')
  }
  if (!box)
    return {
      status: 'unknown',
      reason: 'segmentation-uncertain',
      location,
      segmentation: result.metadata,
    }
  for (let index = 0; index < result.mask.data.length; index++)
    if (image.data[index * 4 + 3] === 0) result.mask.data[index] = 0
  const croppedMask = cropMask(result.mask, box)
  const rgba = maskedRgba(image, result.mask, box)
  const pipeline = sharp(rgba, { raw: { width: box.width, height: box.height, channels: 4 } })
  let png: Uint8Array
  try {
    png = new Uint8Array(await pipeline.png().toBuffer())
  } finally {
    pipeline.destroy()
  }
  assertActive(signal)
  return {
    status: 'extracted',
    location,
    png,
    mask: croppedMask,
    region: box,
    offset: { x: box.left, y: box.top },
    segmentation: result.metadata,
  }
}

function assertRasterImage(image: RasterImage): void {
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

async function toCanonicalRgba(source: RasterImage, signal: AbortSignal): Promise<RgbaRaster> {
  assertActive(signal)
  const pipeline = sharp(source.bytes, { limitInputPixels: 16_777_216, failOn: 'error' })
  try {
    const output = await pipeline
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    assertActive(signal)
    if (
      output.info.width !== source.width ||
      output.info.height !== source.height ||
      output.info.channels !== 4 ||
      output.data.length !== source.width * source.height * 4
    )
      throw new ClassifierError(
        'INVALID_RESPONSE',
        'Canonical RGBA dimensions differ from the normalized source',
      )
    return {
      data: new Uint8Array(output.data),
      width: source.width,
      height: source.height,
      format: 'rgba8',
    }
  } finally {
    pipeline.destroy()
  }
}

function contains(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.width > 0 &&
    inner.height > 0 &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
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
