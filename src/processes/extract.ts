import type { RasterImage, RasterPort } from '../entities/contracts.js'
import type { CutoutRasterPort } from '../entities/cutout-raster.js'
import { parse } from '../entities/contracts.js'
import { containsNonEmptyRect, intersectsRect } from '../entities/geometry.js'
import type {
  ExtractionResult,
  SegmentationInput,
  SegmentationPort,
} from '../entities/segmentation.js'
import { ClassifierError, assertActive } from '../entities/errors.js'
import type {
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import { cropMask, maskedRgba } from '../features/segmentation/mask.js'
import {
  clearTransparentForeground,
  validateSourceMask,
} from '../features/segmentation/source-mask.js'
import {
  assertRasterImage,
  validateAndSnapshotPng,
  validateAndSnapshotRgba,
  validateSegmentationResult,
} from '../features/segmentation/validation.js'

type WholeObjectLocator = (
  image: RasterImage,
  request: Omit<WholeObjectLocateInput, 'image' | 'mode'> & { signal: AbortSignal },
) => Promise<WholeObjectLocalizationResult>

interface ExtractDependencies {
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
    !containsNonEmptyRect(
      { left: 0, top: 0, width: image.width, height: image.height },
      location.region,
    ) ||
    !containsNonEmptyRect(roi, location.region) ||
    !containsNonEmptyRect(
      { left: 0, top: 0, width: image.width, height: image.height },
      location.seedRegion,
    ) ||
    !intersectsRect(location.region, location.seedRegion) ||
    !intersectsRect(roi, location.seedRegion)
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
  const result = validateSegmentationResult(rawResult, image.width, image.height)
  if (result.status === 'unknown')
    return {
      status: 'unknown',
      reason: 'segmentation-uncertain',
      location,
      segmentation: result.metadata,
    }

  const box = validateSourceMask(result.mask, image, roi, location.seedRegion)
  if (!box)
    return {
      status: 'unknown',
      reason: 'segmentation-uncertain',
      location,
      segmentation: result.metadata,
    }
  clearTransparentForeground(result.mask, image)
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
  const png = validateAndSnapshotPng(rawPng)
  return {
    status: 'extracted',
    location,
    png,
    mask: croppedMask,
    region: box,
    center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    offset: { x: box.left, y: box.top },
    segmentation: result.metadata,
  }
}
