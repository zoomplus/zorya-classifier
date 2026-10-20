import { z } from 'zod'

import type { PixelRect, RasterImage, RasterPort } from '../entities/contracts.js'
import type { CutoutRasterPort } from '../entities/cutout-raster.js'
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
  image: CutoutRasterPort
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

  const rawImage: unknown = await dependencies.image.rgba(source, signal)
  assertActive(signal)
  const image = validateAndSnapshotRgba(rawImage, source.width, source.height)
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
  let rawPng: unknown
  try {
    rawPng = await dependencies.image.png(
      { data: rgba, width: box.width, height: box.height, format: 'rgba8' },
      signal,
    )
  } catch (error) {
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError('PROVIDER', 'Cutout raster PNG encoder failed')
  }
  assertActive(signal)
  if (
    !(rawPng instanceof Uint8Array) ||
    rawPng.byteLength < 8 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => rawPng[index] === byte)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Cutout raster port returned invalid PNG bytes')
  const png = new Uint8Array(rawPng)
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

function validateAndSnapshotRgba(value: unknown, width: number, height: number): RgbaRaster {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('data' in value) ||
    !('width' in value) ||
    !('height' in value) ||
    !('format' in value)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Cutout raster port returned invalid RGBA pixels')
  const image = value as RgbaRaster
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
