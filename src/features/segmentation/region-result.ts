import { performance } from 'node:perf_hooks'
import { z } from 'zod'

import type {
  LocalizationMetadata,
  LocalizationResult,
  PixelRect,
  RasterImage,
} from '../../entities/contracts.js'
import { pixelRectSchema } from '../../entities/contracts.js'
import { decisionMetadataSchema } from '../../entities/decision.js'
import { containsNonEmptyRect } from '../../entities/geometry.js'
import { ClassifierError } from '../../entities/errors.js'
import type { RgbaRaster } from '../../entities/representation.js'
import type { ExtractionResult, SegmentationMetadata } from '../../entities/segmentation.js'
import type { SegmentationVerification } from '../../entities/segmentation-verification.js'
import type { ObjectBounds, WholeObjectLocated } from '../../entities/whole-object.js'

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
    stages: z.array(decisionMetadataSchema.strict()),
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

export function unresolved(
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

export function snapshotSeedLocation(
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
    !containsNonEmptyRect(
      { left: 0, top: 0, width: source.width, height: source.height },
      seed.region,
    ) ||
    !containsNonEmptyRect(roi, seed.region)
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

export function withLocalizationDuration(
  value: RegionLocatorFailure,
  started: number,
  source?: RasterImage,
): RegionLocatorFailure {
  const metadata = withMetadataDuration(value.metadata, started, source)
  return { ...value, metadata }
}

export function withMetadataDuration(
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

export function locatedFromMask(
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

export function boundsFor(roi: PixelRect): ObjectBounds {
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
