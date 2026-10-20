import { performance } from 'node:perf_hooks'
import { z } from 'zod'

import type {
  LocateInput,
  LocalizationMetadata,
  LocalizationResult,
  PixelRect,
  RasterImage,
  RasterPort,
} from '../entities/contracts.js'
import { parse, pixelRectSchema } from '../entities/contracts.js'
import type { CutoutRasterPort } from '../entities/cutout-raster.js'
import { ClassifierError, assertActive } from '../entities/errors.js'
import type { RgbaRaster } from '../entities/representation.js'
import type {
  BinaryMask,
  ExtractInput,
  ExtractionResult,
  SegmentationInput,
  SegmentationMetadata,
  SegmentationPort,
} from '../entities/segmentation.js'
import type {
  SegmentationBoxCheckPort,
  SegmentationVerification,
} from '../entities/segmentation-verification.js'
import type { ObjectBounds, WholeObjectLocated } from '../entities/whole-object.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import { cropMask, maskedRgba, validateMask } from '../features/segmentation/mask.js'
import { validateSegmentationBoxCheckResult } from '../features/segmentation/box-check.js'
import {
  assertRasterImage,
  contains,
  validateAndSnapshotRgba,
  validateSegmentationResult,
} from './extract.js'

const decisionMetadataSchema = z
  .object({
    model: z.string().nullable(),
    provider: z.string().nullable(),
    requestId: z.string().nullable(),
    durationMs: z.number().finite().nonnegative(),
    costUsd: z.number().finite().nonnegative().nullable(),
    attempts: z.number().int().positive(),
  })
  .strict()
const selectionSchema = z
  .object({
    choice: z.string().min(1),
    nativeChoice: z.string().nullable(),
    probabilities: z.record(z.number().finite()).nullable(),
    ranking: z.array(z.string().min(1)).optional(),
    confidence: z.number().finite().optional(),
    probabilityRoundingStep: z.literal(0.01).optional(),
    tied: z.array(z.string().min(1)),
  })
  .strict()
const normalizedRectSchema = z
  .object({
    left: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
const localizationMetadataSchema = z
  .object({
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        coordinateSpace: z.literal('oriented-source-pixels'),
      })
      .strict(),
    stages: z.array(decisionMetadataSchema),
    durationMs: z.number().finite().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownCostCount: z.number().int().nonnegative(),
  })
  .strict()
const refinementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('refined'), region: pixelRectSchema, method: z.string() }).strict(),
  z.object({ status: z.literal('unknown'), reason: z.string() }).strict(),
])
const locatedSeedSchema = z
  .object({
    status: z.literal('located'),
    region: pixelRectSchema,
    normalizedRegion: normalizedRectSchema,
    selection: selectionSchema,
    method: z.literal('three-choice-grid-v1'),
    refinement: refinementSchema.optional(),
    metadata: localizationMetadataSchema,
  })
  .strict()

type LocatedSeed = Extract<LocalizationResult, { status: 'located' }>
type RegionLocatorFailure = Exclude<LocalizationResult, { status: 'located' }>

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
    if (!contains({ left: 0, top: 0, width: source.width, height: source.height }, roi))
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
      !contains(
        { left: 0, top: 0, width: image.width, height: image.height },
        seedLocation.region,
      ) ||
      !contains(roi, seedLocation.region)
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
      if (
        !(rawPng instanceof Uint8Array) ||
        rawPng.byteLength < 8 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => rawPng[index] === byte)
      )
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Cutout raster port returned invalid PNG bytes',
        )

      const metadata = withMetadataDuration(seedLocation.metadata, started, source, verification)
      const location = locatedFromMask(seedLocation, box, image, roi, metadata)
      location.verification = verification
      return {
        status: 'extracted',
        location,
        png: new Uint8Array(rawPng),
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

function validateSourceMask(
  mask: BinaryMask,
  image: RgbaRaster,
  roi: PixelRect,
  seed: PixelRect,
): PixelRect | undefined {
  try {
    return validateMask(mask, image, roi, seed)
  } catch {
    throw new ClassifierError('INVALID_RESPONSE', 'Segmenter mask failed binary/source validation')
  }
}

function clearTransparentForeground(mask: BinaryMask, image: RgbaRaster): void {
  for (let index = 0; index < mask.data.length; index++)
    if (image.data[index * 4 + 3] === 0) mask.data[index] = 0
}

function isEnclosingMask(
  previous: BinaryMask,
  previousBox: PixelRect,
  expanded: BinaryMask,
  box: PixelRect,
): boolean {
  if (
    !contains(box, previousBox) ||
    (box.left === previousBox.left &&
      box.top === previousBox.top &&
      box.width === previousBox.width &&
      box.height === previousBox.height)
  )
    return false
  let added = false
  for (let i = 0; i < previous.data.length; i++) {
    if (previous.data[i] === 1 && expanded.data[i] !== 1) return false
    if (previous.data[i] !== 1 && expanded.data[i] === 1) added = true
  }
  return added
}

function unresolved(
  seedLocation: LocatedSeed,
  segmentation: SegmentationMetadata,
  verification: SegmentationVerification,
  started: number,
  source: RasterImage,
): ExtractionResult {
  const metadata = withMetadataDuration(seedLocation.metadata, started, source, verification)
  return {
    status: 'unknown',
    reason: 'segmentation-uncertain',
    seedLocation: { ...seedLocation, metadata },
    metadata,
    segmentation,
    verification,
  }
}

function snapshotSeedLocation(
  value: LocatedSeed,
  source: RasterImage,
  roi: PixelRect,
): LocatedSeed {
  const parsed = locatedSeedSchema.safeParse(value)
  if (!parsed.success)
    throw new ClassifierError('INVALID_RESPONSE', 'Region locator returned an invalid result', {
      paths: parsed.error.issues.map((issue) => issue.path.join('.')),
    })
  const seed = parsed.data
  if (
    seed.metadata.image.width !== source.width ||
    seed.metadata.image.height !== source.height ||
    !contains({ left: 0, top: 0, width: source.width, height: source.height }, seed.region) ||
    !contains(roi, seed.region)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Region locator returned invalid source geometry')
  return {
    status: 'located',
    region: { ...seed.region },
    normalizedRegion: { ...seed.normalizedRegion },
    selection: {
      choice: seed.selection.choice,
      nativeChoice: seed.selection.nativeChoice,
      probabilities: seed.selection.probabilities ? { ...seed.selection.probabilities } : null,
      ...(seed.selection.ranking ? { ranking: [...seed.selection.ranking] } : {}),
      ...(seed.selection.confidence !== undefined ? { confidence: seed.selection.confidence } : {}),
      ...(seed.selection.probabilityRoundingStep !== undefined
        ? { probabilityRoundingStep: seed.selection.probabilityRoundingStep }
        : {}),
      tied: [...seed.selection.tied],
    },
    ...(seed.refinement !== undefined ? { refinement: { ...seed.refinement } } : {}),
    method: 'three-choice-grid-v1',
    metadata: snapshotLocalizationMetadata(seed.metadata),
  }
}

function snapshotLocalizationMetadata(value: LocalizationMetadata): LocalizationMetadata {
  const parsed = localizationMetadataSchema.safeParse(value)
  if (!parsed.success)
    throw new ClassifierError('INVALID_RESPONSE', 'Region locator returned invalid metadata', {
      paths: parsed.error.issues.map((issue) => issue.path.join('.')),
    })
  return {
    ...parsed.data,
    image: { ...parsed.data.image },
    stages: parsed.data.stages.map((stage) => ({ ...stage })),
  }
}

function withLocalizationDuration(
  value: RegionLocatorFailure,
  started: number,
  source?: RasterImage,
): RegionLocatorFailure {
  const metadata = withMetadataDuration(value.metadata, started, source)
  return { ...value, metadata }
}

function withMetadataDuration(
  value: LocalizationMetadata,
  started: number,
  source?: RasterImage,
  verification?: SegmentationVerification,
): LocalizationMetadata {
  const metadata = snapshotLocalizationMetadata(value)
  if (source && (metadata.image.width !== source.width || metadata.image.height !== source.height))
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Region locator metadata source dimensions mismatch',
    )
  metadata.durationMs = Math.max(0, performance.now() - started)
  for (const check of verification?.checks ?? []) {
    metadata.stages.push({ ...check.metadata })
    if (check.metadata.costUsd === null) metadata.unknownCostCount++
    else metadata.knownCostUsd += check.metadata.costUsd
  }
  return metadata
}

function locatedFromMask(
  seed: LocatedSeed,
  box: PixelRect,
  image: RgbaRaster,
  roi: PixelRect,
  metadata: LocalizationMetadata,
): WholeObjectLocated {
  const touchesRoi =
    box.left === roi.left ||
    box.top === roi.top ||
    box.left + box.width === roi.left + roi.width ||
    box.top + box.height === roi.top + roi.height
  return {
    status: 'located',
    kind: 'whole-object',
    seedRegion: { ...seed.region },
    region: { ...box },
    normalizedRegion: {
      left: box.left / image.width,
      top: box.top / image.height,
      width: box.width / image.width,
      height: box.height / image.height,
    },
    bounds: boundsForMask(box),
    completeness: touchesRoi ? 'boundary-limited' : 'visible-object',
    method: 'region-checked-segmentation-v1',
    center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    metadata,
  }
}

function boundsFor(roi: PixelRect): ObjectBounds {
  const right = roi.left + roi.width
  const bottom = roi.top + roi.height
  return {
    left: { start: roi.left, endExclusive: right },
    right: { start: roi.left, endExclusive: right },
    top: { start: roi.top, endExclusive: bottom },
    bottom: { start: roi.top, endExclusive: bottom },
  }
}

function boundsForMask(box: PixelRect): ObjectBounds {
  const right = box.left + box.width
  const bottom = box.top + box.height
  return {
    left: { start: box.left, endExclusive: box.left + 1 },
    right: { start: right - 1, endExclusive: right },
    top: { start: box.top, endExclusive: box.top + 1 },
    bottom: { start: bottom - 1, endExclusive: bottom },
  }
}
