import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import type {
  DecisionMetadata,
  DecisionPort,
  DecisionRequest,
  DecisionState,
  PixelRect,
  RasterImage,
} from '../../src/entities/contracts.js'
import { limits, parse, pixelRectSchema } from '../../src/entities/contracts.js'
import { assertActive, ClassifierError } from '../../src/entities/errors.js'
import type { ChoiceSelection } from '../../src/entities/contracts.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import { targetState } from '../../src/features/prompts.js'
import { createSharpRaster, createVisionRepresentation } from '../../src/infrastructure/raster.js'
import { locateInput } from '../../src/processes/locate.js'

const tileLabels = ['A', 'B', 'C', 'D'] as const
const inputSchema = z
  .object({
    image: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    target: z.string().trim().min(1).max(2000),
    exclusions: z.array(z.string().trim().min(1).max(500)).max(16).optional(),
    roi: pixelRectSchema.optional(),
  })
  .strict()

export type ZoomTileLabel = (typeof tileLabels)[number]
export interface ZoomLocatorInput {
  image: Uint8Array
  target: string
  exclusions?: readonly string[]
  roi?: PixelRect
  signal: AbortSignal
}
export interface ZoomLocatorOptions {
  decision: DecisionPort
}

export interface ZoomTrace {
  stage: 'tile-choice' | 'crop-locator'
  status: 'selected' | 'none' | 'located' | 'not-found' | 'unknown'
  sourceRegion?: PixelRect
  decisionMetadata: DecisionMetadata[]
}

export interface ZoomLocatorMetadata {
  image: { width: number; height: number; coordinateSpace: 'oriented-source-pixels' }
  stages: DecisionMetadata[]
  preparedViews: Array<{
    id: string
    sourceRegion: PixelRect
    scaleX: number
    scaleY: number
    content: PixelRect
  }>
  durationMs: number
  knownCostUsd: number
  unknownCostCount: number
}

export type ZoomLocatorResult =
  | {
      status: 'located'
      sourceRegion: PixelRect
      tileRegion: PixelRect
      selectedTile: ZoomTileLabel
      selection: ChoiceSelection
      traces: ZoomTrace[]
      metadata: ZoomLocatorMetadata
    }
  | {
      status: 'unknown'
      reason: 'layout-limit' | 'none-selected' | 'crop-not-found' | 'crop-unknown'
      tileRegion?: PixelRect
      selectedTile?: ZoomTileLabel
      selection?: ChoiceSelection
      traces: ZoomTrace[]
      metadata: ZoomLocatorMetadata
    }

type ZoomLocatorResultCore =
  | Omit<Extract<ZoomLocatorResult, { status: 'located' }>, 'metadata'>
  | Omit<Extract<ZoomLocatorResult, { status: 'unknown' }>, 'metadata'>

function copyRect(rect: PixelRect): PixelRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function contains(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  )
}

/** Four deterministic ~60%-sized quadrants, giving about 20% overlap on each axis. */
export function zoomTileRegions(region: PixelRect): PixelRect[] {
  const safeRegion = parse(pixelRectSchema, region)
  if (
    !Number.isSafeInteger(safeRegion.left + safeRegion.width) ||
    !Number.isSafeInteger(safeRegion.top + safeRegion.height)
  )
    throw new RangeError('Zoom tiles require safe source coordinates')
  if (safeRegion.width < 3 || safeRegion.height < 3) return []

  const tileWidth = Math.ceil((safeRegion.width * 3) / 5)
  const tileHeight = Math.ceil((safeRegion.height * 3) / 5)
  const lefts = [safeRegion.left, safeRegion.left + safeRegion.width - tileWidth]
  const tops = [safeRegion.top, safeRegion.top + safeRegion.height - tileHeight]
  return [
    { left: lefts[0]!, top: tops[0]!, width: tileWidth, height: tileHeight },
    { left: lefts[1]!, top: tops[0]!, width: tileWidth, height: tileHeight },
    { left: lefts[0]!, top: tops[1]!, width: tileWidth, height: tileHeight },
    { left: lefts[1]!, top: tops[1]!, width: tileWidth, height: tileHeight },
  ]
}

function makeTileQuestion(tiles: readonly PixelRect[]): DecisionRequest['questions'] {
  const criteria = Object.fromEntries(
    tileLabels.map((label, index) => [
      label,
      `Select this view if it best shows a visible fragment of the target. Source region: ${JSON.stringify(tiles[index])}.`,
    ]),
  )
  return {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions:
        'Choose the one supplied crop that best shows any visible part of the requested target. Use FULL SOURCE to keep scene identity and use the enlarged crop views to inspect detail. Choose none if no supplied crop is a useful target candidate. Select only A, B, C, D, or none; do not generate coordinates. none means no candidate among these crops, not global absence.',
      criteria: { ...criteria, none: 'None of the four crop views is a useful target candidate.' },
    },
  }
}

function metadata(
  image: RasterImage,
  stages: readonly DecisionMetadata[],
  preparedViews: ZoomLocatorMetadata['preparedViews'],
  started: number,
): ZoomLocatorMetadata {
  return {
    image: { width: image.width, height: image.height, coordinateSpace: 'oriented-source-pixels' },
    stages: [...stages],
    preparedViews: preparedViews.map((view) => ({
      ...view,
      sourceRegion: copyRect(view.sourceRegion),
      content: copyRect(view.content),
    })),
    durationMs: performance.now() - started,
    knownCostUsd: stages.reduce((total, stage) => total + (stage.costUsd ?? 0), 0),
    unknownCostCount: stages.filter((stage) => stage.costUsd === null).length,
  }
}

function withResult(
  image: RasterImage,
  stages: readonly DecisionMetadata[],
  preparedViews: ZoomLocatorMetadata['preparedViews'],
  started: number,
  result: ZoomLocatorResultCore,
): ZoomLocatorResult {
  return { ...result, metadata: metadata(image, stages, preparedViews, started) }
}

/**
 * Research-only zoom fallback. The caller owns the decision route and decides
 * whether this helper runs after any separate classification/presence stage.
 */
export async function locateWithZoom(
  input: ZoomLocatorInput,
  options: ZoomLocatorOptions,
): Promise<ZoomLocatorResult> {
  const started = performance.now()
  const signal = input.signal
  const sourceBytes = new Uint8Array(input.image)
  const parsed = parse(inputSchema, {
    image: sourceBytes,
    target: input.target,
    ...(input.exclusions === undefined ? {} : { exclusions: [...input.exclusions] }),
    ...(input.roi === undefined ? {} : { roi: input.roi }),
  })
  if (!options || typeof options.decision?.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'A caller-owned decision port is required')
  assertActive(signal)

  const raster = createSharpRaster()
  const representation = createVisionRepresentation(raster)
  const image = await raster.normalize(sourceBytes, signal)
  assertActive(signal)
  const roi = parsed.roi ?? { left: 0, top: 0, width: image.width, height: image.height }
  if (!contains({ left: 0, top: 0, width: image.width, height: image.height }, roi))
    throw new ClassifierError('INVALID_INPUT', 'ROI lies outside oriented source image')
  const tiles = zoomTileRegions(roi)
  const traces: ZoomTrace[] = []
  const stages: DecisionMetadata[] = []
  let preparedViews: ZoomLocatorMetadata['preparedViews'] = []
  if (tiles.length !== 4) {
    return withResult(image, stages, preparedViews, started, {
      status: 'unknown',
      reason: 'layout-limit',
      traces,
    })
  }
  assertActive(signal)

  const cropImages: RasterImage[] = []
  for (const tile of tiles) {
    assertActive(signal)
    cropImages.push(await raster.crop(image, tile, signal))
  }
  assertActive(signal)
  const views = [
    {
      id: 'full-source',
      role: 'source' as const,
      image,
      sourceRegion: { left: 0, top: 0, width: image.width, height: image.height },
    },
    ...cropImages.map((crop, index) => ({
      id: `tile-${tileLabels[index]}`,
      role: 'crop' as const,
      image: crop,
      sourceRegion: tiles[index]!,
    })),
  ]
  if (views.length > limits.maxImages)
    throw new ClassifierError('RESOURCE_LIMIT', 'Zoom request exceeds image part limit')
  const prepared = await representation.prepare({ source: image, views, signal })
  assertActive(signal)
  preparedViews = prepared.metadata.views.map((view) => {
    if (!view.content)
      throw new ClassifierError('INVALID_RESPONSE', 'Prepared zoom view lacks a content transform')
    return {
      id: view.id,
      sourceRegion: copyRect(view.sourceRegion),
      scaleX: view.scaleX,
      scaleY: view.scaleY,
      content: copyRect(view.content),
    }
  })
  const state: DecisionState = [
    ...targetState(parsed.target, parsed.exclusions ?? []),
    'FULL SOURCE AND OVERLAPPING CROP VIEWS',
    JSON.stringify({
      tiles: Object.fromEntries(tileLabels.map((label, index) => [label, tiles[index]])),
    }),
    ...prepared.state,
  ]
  const request: DecisionRequest = { state, questions: makeTileQuestion(tiles) }
  assertActive(signal)
  const rawTileDecision = await options.decision.decide(request, signal)
  assertActive(signal)
  const tileDecision = validateDecision(request, rawTileDecision)
  stages.push(tileDecision.metadata)
  const chosen = selection(tileDecision, [...tileLabels, 'none'], 1)
  if (chosen.choice === 'none') {
    traces.push({ stage: 'tile-choice', status: 'none', decisionMetadata: [tileDecision.metadata] })
    return withResult(image, stages, preparedViews, started, {
      status: 'unknown',
      reason: 'none-selected',
      selection: chosen,
      traces,
    })
  }
  assertActive(signal)
  const selectedIndex = tileLabels.indexOf(chosen.choice as ZoomTileLabel)
  if (selectedIndex < 0)
    throw new ClassifierError('INVALID_RESPONSE', 'Decision selected an unknown zoom tile')
  const tileRegion = tiles.at(selectedIndex)
  if (!tileRegion)
    throw new ClassifierError('INVALID_RESPONSE', 'Selected zoom tile has no source geometry')
  traces.push({
    stage: 'tile-choice',
    status: 'selected',
    sourceRegion: copyRect(tileRegion),
    decisionMetadata: [tileDecision.metadata],
  })

  const local = await locateInput(
    {
      image: new Uint8Array(cropImages[selectedIndex]!.bytes),
      target: parsed.target,
      exclusions: parsed.exclusions ?? [],
    },
    options.decision,
    raster,
    signal,
  )
  stages.push(...local.metadata.stages)
  if (local.status !== 'located') {
    traces.push({
      stage: 'crop-locator',
      status: local.status,
      sourceRegion: copyRect(tileRegion),
      decisionMetadata: [...local.metadata.stages],
    })
    return withResult(image, stages, preparedViews, started, {
      status: 'unknown',
      reason: local.status === 'not-found' ? 'crop-not-found' : 'crop-unknown',
      tileRegion: copyRect(tileRegion),
      selectedTile: chosen.choice as ZoomTileLabel,
      selection: chosen,
      traces,
    })
  }

  const sourceRegion: PixelRect = {
    left: tileRegion.left + local.region.left,
    top: tileRegion.top + local.region.top,
    width: local.region.width,
    height: local.region.height,
  }
  if (
    !contains({ left: 0, top: 0, width: image.width, height: image.height }, sourceRegion) ||
    !contains(roi, sourceRegion) ||
    !contains(tileRegion, sourceRegion)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Crop locator returned invalid source geometry')
  traces.push({
    stage: 'crop-locator',
    status: 'located',
    sourceRegion: copyRect(tileRegion),
    decisionMetadata: [...local.metadata.stages],
  })
  return withResult(image, stages, preparedViews, started, {
    status: 'located',
    sourceRegion,
    tileRegion: copyRect(tileRegion),
    selectedTile: chosen.choice as ZoomTileLabel,
    selection: chosen,
    traces,
  })
}
