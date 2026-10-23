import { performance } from 'node:perf_hooks'

import type {
  LocateInput,
  LocalizationResult,
  PixelRect,
  RasterImage,
  RasterPort,
} from '../entities/contracts.js'
import { parse } from '../entities/contracts.js'
import type { CutoutRasterPort } from '../entities/cutout-raster.js'
import { containsNonEmptyRect } from '../entities/geometry.js'
import { ClassifierError, assertActive } from '../entities/errors.js'
import type { RgbaRaster } from '../entities/representation.js'
import type {
  BinaryMask,
  ExtractInput,
  ExtractionResult,
  SegmentationInput,
  SegmentationPort,
} from '../entities/segmentation.js'
import type {
  SegmentationBoxCheckPort,
  SegmentationVerification,
} from '../entities/segmentation-verification.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import { validateSegmentationBoxCheckResult } from '../features/segmentation/box-check.js'
import { cropMask, maskedRgba } from '../features/segmentation/mask.js'
import {
  boundsFor,
  locatedFromMask,
  snapshotSeedLocation,
  unresolved,
  withLocalizationDuration,
  withMetadataDuration,
} from '../features/segmentation/region-result.js'
import {
  clearTransparentForeground,
  isEnclosingMask,
  validateSourceMask,
} from '../features/segmentation/source-mask.js'
import {
  validateAndSnapshotPng,
  assertRasterImage,
  validateAndSnapshotRgba,
  validateSegmentationResult,
} from '../features/segmentation/validation.js'

type LocateRegion = (
  source: RasterImage,
  request: Omit<LocateInput, 'image' | 'mode' | 'signal'> & { signal: AbortSignal },
) => Promise<LocalizationResult>

interface ExtractFromRegionDependencies {
  raster: RasterPort
  image: CutoutRasterPort
  segmenter: SegmentationPort
  boxCheck: SegmentationBoxCheckPort
  locateRegion: LocateRegion
}

/** Original region seed, full-source mask, closed containment check and at most one repair. */
export async function extractFromRegion(
  input: ExtractInput & { signal: AbortSignal },
  dependencies: ExtractFromRegionDependencies,
): Promise<ExtractionResult> {
  const started = performance.now()
  const ownedBytes = new Uint8Array(input.image)
  const { signal } = input
  let source: RasterImage | undefined
  let image: RgbaRaster | undefined
  try {
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
    assertActive(signal)
    const normalized = await dependencies.raster.normalize(ownedBytes, signal)
    assertRasterImage(normalized)
    source = { ...normalized, bytes: new Uint8Array(normalized.bytes) }
    assertActive(signal)

    const roi = parsed.roi ?? { left: 0, top: 0, width: source.width, height: source.height }
    if (!containsNonEmptyRect({ left: 0, top: 0, width: source.width, height: source.height }, roi))
      throw new ClassifierError('INVALID_INPUT', 'ROI lies outside oriented source image')

    const rawLocation = await dependencies.locateRegion(
      { ...source, bytes: new Uint8Array(source.bytes) },
      {
        target: parsed.target,
        exclusions: [...parsed.exclusions],
        ...(parsed.roi ? { roi: { ...parsed.roi } } : {}),
        ...(parsed.representation ? { representation: { ...parsed.representation } } : {}),
        signal,
      },
    )
    assertActive(signal)
    if (rawLocation.status !== 'located')
      return withLocalizationDuration(rawLocation, started, source)

    const seedLocation = snapshotSeedLocation(rawLocation, source, roi)
    const rawRgba: unknown = await dependencies.image.rgba(source, signal)
    assertActive(signal)
    image = validateAndSnapshotRgba(rawRgba, source.width, source.height)
    if (
      !containsNonEmptyRect(
        { left: 0, top: 0, width: image.width, height: image.height },
        seedLocation.region,
      ) ||
      !containsNonEmptyRect(roi, seedLocation.region)
    )
      throw new ClassifierError(
        'INVALID_RESPONSE',
        'Region locator returned invalid source geometry',
      )

    const segmentInput: SegmentationInput = {
      image,
      seedRegion: { ...seedLocation.region },
      prompt: 'seed-region',
      wholeRegion: { ...roi },
      bounds: boundsFor(roi),
      roi: { ...roi },
      target: parsed.target,
      exclusions: [...parsed.exclusions],
      completeness: 'visible-object',
      signal,
    }
    let segmented = await segmentSource(dependencies.segmenter, segmentInput)
    if (segmented.status === 'unknown') {
      const metadata = withMetadataDuration(seedLocation.metadata, started, source)
      return {
        status: 'unknown',
        reason: 'segmentation-uncertain',
        seedLocation: { ...seedLocation, metadata },
        metadata,
        segmentation: segmented.metadata,
      }
    }

    const ownedMasks = [segmented.mask]
    const verification: SegmentationVerification = { checks: [], expansion: 'not-needed' }
    try {
      let box = validateSourceMask(segmented.mask, image, roi, seedLocation.region)
      if (!box) {
        const metadata = withMetadataDuration(seedLocation.metadata, started, source)
        return {
          status: 'unknown',
          reason: 'segmentation-uncertain',
          seedLocation: { ...seedLocation, metadata },
          metadata,
          segmentation: segmented.metadata,
        }
      }

      clearTransparentForeground(segmented.mask, image)
      let check = await checkBox(dependencies.boxCheck, segmentInput, box)
      verification.checks.push(check)
      if (check.verdict === 'needs-expansion') {
        if (!dependencies.segmenter.expand) {
          verification.expansion = 'unsupported'
          return unresolved(seedLocation, segmented.metadata, verification, started, source)
        }
        const expanded = await segmentSource(dependencies.segmenter, segmentInput, segmented.mask)
        if (expanded.status === 'unknown') {
          verification.expansion = 'no-enclosing-mask'
          return unresolved(seedLocation, expanded.metadata, verification, started, source)
        }
        ownedMasks.push(expanded.mask)
        const expandedBox = validateSourceMask(expanded.mask, image, roi, seedLocation.region)
        clearTransparentForeground(expanded.mask, image)
        if (!expandedBox || !isEnclosingMask(segmented.mask, box, expanded.mask, expandedBox)) {
          verification.expansion = 'rejected-mask'
          return unresolved(seedLocation, expanded.metadata, verification, started, source)
        }
        verification.expansion = 'expanded'
        segmented = expanded
        box = expandedBox
        check = await checkBox(dependencies.boxCheck, segmentInput, box)
        verification.checks.push(check)
      }
      if (check.verdict !== 'complete')
        return unresolved(seedLocation, segmented.metadata, verification, started, source)

      const croppedMask = cropMask(segmented.mask, box)
      const rgba = maskedRgba(image, segmented.mask, box)
      let rawPng: unknown
      try {
        rawPng = await dependencies.image.png(
          { data: rgba, width: box.width, height: box.height, format: 'rgba8' },
          signal,
        )
      } catch (error) {
        if (error instanceof ClassifierError) throw error
        throw new ClassifierError('PROVIDER', 'Cutout raster PNG encoder failed')
      } finally {
        rgba.fill(0)
      }
      assertActive(signal)
      const png = validateAndSnapshotPng(rawPng)

      const metadata = withMetadataDuration(seedLocation.metadata, started, source, verification)
      const location = locatedFromMask(seedLocation, box, image, roi, metadata)
      location.verification = verification
      return {
        status: 'extracted',
        location,
        png,
        mask: croppedMask,
        region: { ...box },
        center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        offset: { x: box.left, y: box.top },
        segmentation: segmented.metadata,
        verification,
      }
    } finally {
      for (const mask of ownedMasks) mask.data.fill(0)
    }
  } finally {
    ownedBytes.fill(0)
    source?.bytes.fill(0)
    image?.data.fill(0)
  }
}

async function segmentSource(
  segmenter: SegmentationPort,
  input: SegmentationInput,
  previous?: BinaryMask,
) {
  const image: RgbaRaster = { ...input.image, data: new Uint8Array(input.image.data) }
  const previousMask = previous ? { ...previous, data: new Uint8Array(previous.data) } : undefined
  const owned: SegmentationInput = {
    ...input,
    image,
    seedRegion: { ...input.seedRegion },
    wholeRegion: { ...input.wholeRegion },
    roi: { ...input.roi },
    bounds: {
      left: { ...input.bounds.left },
      right: { ...input.bounds.right },
      top: { ...input.bounds.top },
      bottom: { ...input.bounds.bottom },
    },
    exclusions: [...input.exclusions],
  }
  try {
    assertActive(input.signal)
    const result: unknown = previousMask
      ? await segmenter.expand?.(owned, previousMask)
      : await segmenter.segment(owned)
    assertActive(input.signal)
    return validateSegmentationResult(result, image.width, image.height)
  } finally {
    image.data.fill(0)
    previousMask?.data.fill(0)
  }
}

async function checkBox(port: SegmentationBoxCheckPort, input: SegmentationInput, box: PixelRect) {
  const image: RgbaRaster = { ...input.image, data: new Uint8Array(input.image.data) }
  try {
    assertActive(input.signal)
    const result: unknown = await port.check({
      image,
      region: { ...box },
      seedRegion: { ...input.seedRegion },
      roi: { ...input.roi },
      target: input.target,
      exclusions: [...input.exclusions],
      signal: input.signal,
    })
    assertActive(input.signal)
    return validateSegmentationBoxCheckResult(result)
  } finally {
    image.data.fill(0)
  }
}
