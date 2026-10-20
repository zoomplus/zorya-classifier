import { z } from 'zod'
import { limits, pixelRectSchema } from '../entities/contracts.js'
import type { DecisionState, PixelRect, RasterImage, RasterPort } from '../entities/contracts.js'
import { ClassifierError, assertActive } from '../entities/errors.js'
import type {
  BoundaryCandidate,
  BoundaryView,
  BoundaryViewPort,
} from '../entities/boundary-view.js'
import type { BoundaryInterval } from '../entities/whole-object.js'
import { targetState } from '../features/prompts.js'

const axes = ['left', 'right', 'top', 'bottom'] as const
type Axis = (typeof axes)[number]
type Orientation = 'X' | 'Y'
interface AxisChoices {
  intervals: readonly BoundaryInterval[]
  labels: readonly string[]
}
interface ViewGroup {
  orientation: Orientation
  axis: Axis
  sourceRegion: PixelRect
  candidates: BoundaryCandidate[]
  mappings: { questionId: Axis; choiceId: string; display: string; interval: BoundaryInterval }[]
}

const rect = pixelRectSchema
const rasterImageSchema = z
  .object({
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    width: z.number().int().min(280).max(1568),
    height: z.number().int().min(280).max(1568),
  })
  .strict()
  .refine(
    (image) =>
      image.bytes.byteLength >= 24 &&
      image.bytes.byteLength <= limits.imageBytes &&
      image.bytes[0] === 0x89 &&
      image.bytes[1] === 0x50 &&
      image.bytes[2] === 0x4e &&
      image.bytes[3] === 0x47 &&
      image.bytes[4] === 0x0d &&
      image.bytes[5] === 0x0a &&
      image.bytes[6] === 0x1a &&
      image.bytes[7] === 0x0a &&
      pngDimension(image.bytes, 16) === image.width &&
      pngDimension(image.bytes, 20) === image.height,
  )
const candidateSchema = z
  .object({
    id: z.string().min(1).max(128),
    display: z.string().regex(/^[XY][0-9A-F]$/u),
    interval: z
      .object({
        start: z.number().int().nonnegative().safe(),
        endExclusive: z.number().int().positive().safe(),
      })
      .strict()
      .refine((interval) => interval.start < interval.endExclusive),
  })
  .strict()
const viewSchema = z
  .object({
    image: rasterImageSchema,
    sourceRegion: rect,
    content: rect,
    scaleX: z.number().finite().positive(),
    scaleY: z.number().finite().positive(),
    candidates: z.array(candidateSchema).min(1).max(16),
  })
  .strict()

function equalRect(left: PixelRect, right: PixelRect): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  )
}

function pngDimension(bytes: Uint8Array, offset: number): number | undefined {
  if (bytes.byteLength < offset + 4) return undefined
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

function inside(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  )
}

function equalCandidates(left: readonly BoundaryCandidate[], right: readonly BoundaryCandidate[]) {
  return (
    left.length === right.length &&
    left.every(
      (candidate, index) =>
        candidate.id === right[index]?.id &&
        candidate.display === right[index]?.display &&
        candidate.interval.start === right[index]?.interval.start &&
        candidate.interval.endExclusive === right[index]?.interval.endExclusive,
    )
  )
}

function orientation(axis: Axis): Orientation {
  return axis === 'left' || axis === 'right' ? 'X' : 'Y'
}

function clippedRegion(
  orientation: Orientation,
  start: number,
  end: number,
  otherStart: number,
  otherEnd: number,
  roi: PixelRect,
) {
  const margin = Math.ceil((end - start) * 0.25)
  if (orientation === 'X') {
    const left = Math.max(roi.left, start - margin)
    const right = Math.min(roi.left + roi.width, end + margin)
    return { left, top: otherStart, width: right - left, height: otherEnd - otherStart }
  }
  const top = Math.max(roi.top, start - margin)
  const bottom = Math.min(roi.top + roi.height, end + margin)
  return { left: otherStart, top, width: otherEnd - otherStart, height: bottom - top }
}

function makeGroups(
  current: Record<Axis, BoundaryInterval>,
  roi: PixelRect,
  choices: Record<Axis, AxisChoices>,
): ViewGroup[] {
  const groups = new Map<string, ViewGroup>()
  for (const axis of axes) {
    const orient = orientation(axis)
    const horizontal = orient === 'X'
    const boundary = current[axis]
    const start = boundary.start
    const end = boundary.endExclusive
    const otherStart = horizontal ? current.top.start : current.left.start
    const otherEnd = horizontal ? current.bottom.endExclusive : current.right.endExclusive
    const sourceRegion = clippedRegion(orient, start, end, otherStart, otherEnd, roi)
    if (sourceRegion.width < 1 || sourceRegion.height < 1)
      throw new ClassifierError('INVALID_RESPONSE', 'Boundary view has an empty source region')
    const candidates = choices[axis].intervals.map((interval, index) => ({
      id: choices[axis].labels[index]!,
      display: `${orient}${index.toString(16).toUpperCase()}`,
      interval: { ...interval },
    }))
    const key = JSON.stringify({
      orientation: orient,
      sourceRegion,
      candidates: candidates.map(({ display, interval }) => ({ display, interval })),
    })
    const mapping = candidates.map((candidate) => ({
      questionId: axis,
      choiceId: candidate.id,
      display: candidate.display,
      interval: candidate.interval,
    }))
    const existing = groups.get(key)
    if (existing) existing.mappings.push(...mapping)
    else
      groups.set(key, {
        orientation: orient,
        axis,
        sourceRegion,
        candidates,
        mappings: mapping,
      })
  }
  return [...groups.values()]
}

function validatedView(
  value: BoundaryView,
  input: Parameters<BoundaryViewPort['render']>[0],
): BoundaryView {
  const parsed = viewSchema.safeParse(value)
  if (!parsed.success)
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Boundary renderer returned invalid view metadata',
    )
  const view = parsed.data
  const imageRect = { left: 0, top: 0, width: view.image.width, height: view.image.height }
  if (
    !equalRect(view.sourceRegion, input.sourceRegion) ||
    !inside(imageRect, view.content) ||
    view.scaleX !== view.content.width / view.sourceRegion.width ||
    view.scaleY !== view.content.height / view.sourceRegion.height ||
    !equalCandidates(view.candidates, input.candidates)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Boundary renderer changed requested geometry')
  return view
}

function imageCount(state: DecisionState): number {
  return state.reduce((sum, part) => sum + (typeof part === 'string' ? 0 : 1), 0)
}

/** Compose original, seed, and validated zoom views without exposing model instructions as geometry. */
export async function prepareBoundaryState(
  raster: RasterPort,
  source: RasterImage,
  seed: PixelRect,
  target: string,
  exclusions: readonly string[],
  signal: AbortSignal,
  boundaryView: BoundaryViewPort,
  roi: PixelRect,
  current: Record<Axis, BoundaryInterval>,
  choices: Record<Axis, AxisChoices>,
): Promise<DecisionState> {
  const seedImage = await raster.crop(source, seed, signal)
  assertActive(signal)
  const original = await raster.imageState(source, signal)
  assertActive(signal)
  const seedState = await raster.imageState(seedImage, signal)
  assertActive(signal)
  if (imageCount(original) !== 1 || imageCount(seedState) !== 1)
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Original and seed states must each contain one image',
    )

  const state: DecisionState = [
    ...targetState(target, exclusions),
    'ORIGINAL',
    ...original,
    'SEED',
    ...seedState,
  ]
  for (const group of makeGroups(current, roi, choices)) {
    assertActive(signal)
    const input = {
      source: { ...source, bytes: new Uint8Array(source.bytes) },
      sourceRegion: group.sourceRegion,
      axis: group.axis,
      candidates: group.candidates,
      signal,
    }
    const view = validatedView(await boundaryView.render(input), input)
    assertActive(signal)
    state.push(
      JSON.stringify({
        boundaryView: {
          axis: group.orientation,
          sourceRegion: view.sourceRegion,
          content: view.content,
          image: { width: view.image.width, height: view.image.height },
          scaleX: view.scaleX,
          scaleY: view.scaleY,
          choices: group.mappings,
        },
      }),
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from(view.image.bytes).toString('base64')}`,
          detail: 'high',
        },
      },
    )
    if (imageCount(state) > 6)
      throw new ClassifierError('RESOURCE_LIMIT', 'Boundary state exceeds six images')
  }
  return state
}
