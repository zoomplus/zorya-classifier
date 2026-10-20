import { z } from 'zod'
import type {
  DecisionMetadata,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  DecisionState,
  LocateInput,
  LocalizationMetadata,
  PixelRect,
  RasterImage,
  RasterPort,
} from '../entities/contracts.js'
import { parse } from '../entities/contracts.js'
import { assertActive, ClassifierError } from '../entities/errors.js'
import type { ImageRepresentationPort, RepresentationView } from '../entities/representation.js'
import type {
  BoundaryInterval,
  ObjectBounds,
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'
import { wholeObjectSchema } from '../entities/whole-object.js'
import { validateDecision } from '../features/choice.js'
import { targetState } from '../features/prompts.js'
import { locateInput } from './locate.js'

const axisOrder = ['left', 'right', 'top', 'bottom'] as const
type Axis = (typeof axisOrder)[number]
type Interval = BoundaryInterval
const boundaryResponseSchema = z
  .object({
    status: z.literal('known'),
    interval: z.object({ start: z.number().int(), endExclusive: z.number().int() }).strict(),
  })
  .strict()

function partition(interval: Interval): Interval[] {
  const length = interval.endExclusive - interval.start
  if (!Number.isSafeInteger(length) || length < 1) return []
  const count = Math.min(16, length)
  return Array.from({ length: count }, (_, i) => {
    const start = interval.start + Math.floor((i * length) / count)
    const endExclusive = interval.start + Math.floor(((i + 1) * length) / count)
    return { start, endExclusive }
  })
}
function boundsFor(region: PixelRect): Record<Axis, Interval> {
  return {
    left: { start: region.left, endExclusive: region.left + region.width },
    right: { start: region.left, endExclusive: region.left + region.width },
    top: { start: region.top, endExclusive: region.top + region.height },
    bottom: { start: region.top, endExclusive: region.top + region.height },
  }
}
function boundaryInstruction(axis: Axis): string {
  const edge =
    axis === 'left' ? 'left' : axis === 'right' ? 'right' : axis === 'top' ? 'top' : 'bottom'
  return `Select the interval containing the ${edge}most visible pixel coordinate INSIDE HARD_ROI of the SAME physical instance identified by SEED. If the object continues outside HARD_ROI, locate only the visible intersection with that ROI; do not infer hidden parts. Coordinates use the original oriented source pixels. Choose only a supplied interval or unknown; do not infer free coordinates. The interval limits are half-open integer coordinate ranges. Current boundary intervals are candidate ranges, not new ROI limits.`
}
function choicesFor(axis: Axis, current: Interval) {
  const intervals = partition(current)
  const labels = intervals.map((_, i) => `${axis}${String(i).padStart(2, '0')}`)
  return {
    intervals,
    labels,
    question: {
      type: 'choice' as const,
      rankingSize: 1 as const,
      instructions: boundaryInstruction(axis),
      criteria: {
        ...Object.fromEntries(
          intervals.map((range, i) => [
            labels[i]!,
            `Integer boundary coordinates in [${range.start}, ${range.endExclusive}).`,
          ]),
        ),
        unknown: 'The same seeded instance or its boundary cannot be identified reliably.',
      },
    },
  }
}
function sameInstanceQuestion() {
  return {
    type: 'choice' as const,
    rankingSize: 1 as const,
    instructions:
      'Using ORIGINAL and SEED, determine whether extent answers can track the same single visible physical instance represented by SEED. If multiple indistinguishable instances could be the seed, or identity cannot be resolved, choose ambiguous. Select only one supplied answer.',
    criteria: {
      same: 'The visible extent can be tracked to the exact same physical instance represented by SEED.',
      different: 'The apparent extent may belong to a different matching instance than SEED.',
      ambiguous: 'The seeded instance is not uniquely identifiable in the scene.',
    },
  }
}
async function prepareState(
  raster: RasterPort,
  image: RasterImage,
  seed: PixelRect,
  target: string,
  exclusions: readonly string[],
  signal: AbortSignal,
  representation?: ImageRepresentationPort,
): Promise<DecisionState> {
  const seedImage = await raster.crop(image, seed, signal)
  if (!representation) {
    const original = await raster.imageState(image, signal)
    const seedState = await raster.imageState(seedImage, signal)
    return [...targetState(target, exclusions), 'ORIGINAL', ...original, 'SEED', ...seedState]
  }
  const views: RepresentationView[] = [
    {
      id: 'source',
      role: 'source',
      image,
      sourceRegion: { left: 0, top: 0, width: image.width, height: image.height },
    },
    { id: 'seed', role: 'crop', image: seedImage, sourceRegion: seed },
  ]
  const prepared = await representation.prepare({ source: image, views, signal })
  return [
    ...targetState(target, exclusions),
    'ORIGINAL AND SEED GEOMETRY',
    JSON.stringify({ seedRegion: seed }),
    ...prepared.state,
  ]
}
function resultMetadata(
  image: RasterImage,
  stages: DecisionMetadata[],
  durationMs: number,
): LocalizationMetadata {
  return {
    image: { width: image.width, height: image.height, coordinateSpace: 'oriented-source-pixels' },
    stages,
    durationMs,
    knownCostUsd: stages.reduce((sum, stage) => sum + (stage.costUsd ?? 0), 0),
    unknownCostCount: stages.filter((stage) => stage.costUsd === null).length,
  }
}
function unknown(
  reason:
    | 'instance-ambiguous'
    | 'extent-uncertain'
    | 'extent-inconsistent'
    | 'representation-limit',
  metadata: LocalizationMetadata,
): WholeObjectLocalizationResult {
  return { status: 'unknown', reason, metadata }
}
function intervalWidth(interval: Interval): number {
  return interval.endExclusive - interval.start
}
function selectedChoice(result: DecisionResult, question: string, keys: readonly string[]): string {
  const answer = result.answers[question]
  if (!answer || (answer.type !== 'choice' && answer.type !== 'ranked-choice'))
    throw new ClassifierError('INVALID_RESPONSE', `Missing closed Choice answer for ${question}`)
  if (answer.type === 'ranked-choice') {
    const choice = answer.ranking[0]
    if (!choice || !keys.includes(choice))
      throw new ClassifierError('INVALID_RESPONSE', 'Unknown ranked interval')
    return choice
  }
  const maximum = Math.max(...keys.map((key) => answer.probabilities[key] ?? -Infinity))
  const choice = keys.find((key) => answer.probabilities[key] === maximum)
  if (!choice) throw new ClassifierError('INVALID_RESPONSE', 'Closed Choice has no winner')
  return choice
}
function finalRegion(
  bounds: ObjectBounds,
  roi: PixelRect,
  source: RasterImage,
  seed: PixelRect,
): PixelRect | undefined {
  const { left, right, top, bottom } = bounds
  const x1 = left.start,
    x2 = right.endExclusive
  const y1 = top.start,
    y2 = bottom.endExclusive
  if (x1 >= x2 || y1 >= y2) return undefined
  const region = { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
  if (
    x1 < roi.left ||
    y1 < roi.top ||
    x2 > roi.left + roi.width ||
    y2 > roi.top + roi.height ||
    x2 > source.width ||
    y2 > source.height ||
    x1 >= seed.left + seed.width ||
    y1 >= seed.top + seed.height ||
    x2 <= seed.left ||
    y2 <= seed.top
  )
    return undefined
  return region
}

/** Seed a physical instance, then narrow its four visible source-space boundaries with closed interval Choices. */
export async function locateWholeObjectInput(
  input: Omit<WholeObjectLocateInput, 'signal'>,
  decision: DecisionPort,
  raster: RasterPort,
  signal: AbortSignal,
  representation?: ImageRepresentationPort,
): Promise<WholeObjectLocalizationResult> {
  const started = performance.now()
  const args = parse(wholeObjectSchema, input)
  const normalized = await raster.normalize(args.image, signal)
  const roi = args.roi ?? { left: 0, top: 0, width: normalized.width, height: normalized.height }
  const seedInput: Omit<LocateInput, 'signal'> = {
    image: args.image,
    target: args.target,
    exclusions: args.exclusions,
    roi,
    mode: 'region',
    ...(args.representation === undefined ? {} : { representation: args.representation }),
  }
  const stages: DecisionMetadata[] = []
  const trackedDecision: DecisionPort = {
    async decide(request, callSignal) {
      const result = await decision.decide(request, callSignal)
      stages.push(result.metadata)
      return result
    },
  }
  const metadata = () => resultMetadata(normalized, stages, performance.now() - started)
  try {
    const seedResult = await locateInput(
      seedInput,
      trackedDecision,
      raster,
      signal,
      undefined,
      representation,
    )
    if (seedResult.status !== 'located') return { ...seedResult, metadata: metadata() }
    const seed = seedResult.region
    let current = boundsFor(roi)
    for (let pass = 0; pass < args.maxExtentPasses; pass++) {
      assertActive(signal)
      const state = await prepareState(
        raster,
        normalized,
        seed,
        args.target,
        args.exclusions,
        signal,
        representation,
      )
      const specs = Object.fromEntries(
        axisOrder.map((axis) => [axis, choicesFor(axis, current[axis])]),
      ) as Record<Axis, ReturnType<typeof choicesFor>>
      const questions: DecisionRequest['questions'] = Object.fromEntries(
        axisOrder.map((axis) => [axis, specs[axis].question]),
      )
      if (pass === 0) questions['instance'] = sameInstanceQuestion()
      const request = {
        state: [
          ...state,
          JSON.stringify({
            pass: pass + 1,
            hardRoi: roi,
            seedRegion: seed,
            currentBounds: current,
          }),
        ],
        questions,
      }
      const answer = validateDecision(request, await trackedDecision.decide(request, signal))
      assertActive(signal)
      if (pass === 0) {
        const identity = selectedChoice(answer, 'instance', ['same', 'different', 'ambiguous'])
        if (identity !== 'same') return unknown('instance-ambiguous', metadata())
      }
      const next = { ...current }
      for (const axis of axisOrder) {
        const spec = specs[axis]
        const selected = selectedChoice(answer, axis, [...spec.labels, 'unknown'])
        if (selected === 'unknown') return unknown('extent-uncertain', metadata())
        const chosen = spec.intervals[spec.labels.indexOf(selected)]
        if (!chosen)
          throw new ClassifierError('INVALID_RESPONSE', 'Selected boundary interval is missing')
        next[axis] = parse(
          boundaryResponseSchema,
          { status: 'known', interval: chosen },
          'INVALID_RESPONSE',
        ).interval
      }
      current = next
      if (axisOrder.every((axis) => intervalWidth(current[axis]) <= args.boxTolerancePx)) break
    }
    if (axisOrder.some((axis) => intervalWidth(current[axis]) > args.boxTolerancePx))
      return unknown('extent-uncertain', metadata())
    const bounds: ObjectBounds = current
    const region = finalRegion(bounds, roi, normalized, seed)
    if (!region) return unknown('extent-inconsistent', metadata())
    const edgeLimited =
      bounds.left.start === roi.left ||
      bounds.top.start === roi.top ||
      bounds.right.endExclusive === roi.left + roi.width ||
      bounds.bottom.endExclusive === roi.top + roi.height
    return {
      status: 'located',
      kind: 'whole-object',
      seedRegion: { ...seed },
      region,
      normalizedRegion: {
        left: region.left / normalized.width,
        top: region.top / normalized.height,
        width: region.width / normalized.width,
        height: region.height / normalized.height,
      },
      bounds,
      completeness: edgeLimited ? 'boundary-limited' : 'visible-object',
      method: 'grid-object-extent-v1',
      metadata: metadata(),
    }
  } catch (error) {
    if (
      error instanceof ClassifierError &&
      error.code === 'RESOURCE_LIMIT' &&
      error.details['component'] === 'representation'
    )
      return unknown('representation-limit', metadata())
    throw error
  }
}
