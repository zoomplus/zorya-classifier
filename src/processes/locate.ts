import { z } from 'zod'
import type {
  DecisionMetadata,
  DecisionPort,
  DecisionRequest,
  DecisionState,
  GridCell,
  GridPanel,
  LocateInput,
  LocalizationResult,
  PixelRect,
  RasterImage,
  RasterPort,
  RefinementPort,
  ChoiceSelection,
} from '../entities/contracts.js'
import type { ImageRepresentationPort, RepresentationView } from '../entities/representation.js'
import { parse, pixelRectSchema } from '../entities/contracts.js'
import { assertActive, ClassifierError } from '../entities/errors.js'
import {
  choiceBeamFirstCells,
  choiceBeamPanels,
  rankChoiceBeamCells,
} from '../features/choice-beam-layout.js'
import { presence, selection, validateDecision } from '../features/choice.js'
import { candidateQuestions, gridQuestions, targetState } from '../features/prompts.js'

interface Context {
  decision: DecisionPort
  raster: RasterPort
  signal: AbortSignal
  image: RasterImage
  original: DecisionState
  stages: DecisionMetadata[]
  target: string
  exclusions: readonly string[]
  representation?: ImageRepresentationPort
}
function labelsFor(cells: readonly GridCell[], pass: 1 | 2): Map<string, string> {
  return new Map(
    cells.map((cell, i) => [
      cell.id,
      pass === 1 ? `P${String(i + 1).padStart(2, '0')}` : `C${String(i).padStart(3, '0')}`,
    ]),
  )
}
function canonicalAnswer(chosen: ChoiceSelection, labels: ReadonlyMap<string, string>) {
  const ids = new Map([...labels].map(([id, label]) => [label, id]))
  const choice = ids.get(chosen.choice)
  if (!choice) throw new ClassifierError('INVALID_RESPONSE', 'Unknown printed choice')
  if (chosen.probabilities === null) {
    const ranking = chosen.ranking?.map((label) => ids.get(label))
    if (!ranking || ranking.some((id) => id === undefined))
      throw new ClassifierError('INVALID_RESPONSE', 'Unknown ranked label')
    return {
      choice,
      ranking: ranking.map((id) => {
        if (!id) throw new ClassifierError('INVALID_RESPONSE', 'Missing rank ID')
        return id
      }),
    }
  }
  const probabilities = chosen.probabilities
  return {
    choice,
    probabilities: Object.fromEntries(
      [...labels].map(([id, label]) => [id, probabilities[label] ?? NaN]),
    ),
  }
}
async function decide(context: Context, request: DecisionRequest) {
  assertActive(context.signal)
  const result = validateDecision(request, await context.decision.decide(request, context.signal))
  context.stages.push(result.metadata)
  assertActive(context.signal)
  return result
}
async function gridPass(context: Context, panels: readonly GridPanel[], pass: 1 | 2) {
  const cells = [...new Map(panels.flatMap((p) => p.cells).map((cell) => [cell.id, cell])).values()]
  const labels = labelsFor(cells, pass)
  const state: DecisionState = [
    ...targetState(context.target, context.exclusions),
    'ORIGINAL',
    ...context.original,
  ]
  const views: RepresentationView[] = context.representation
    ? [
        {
          id: 'source',
          role: 'source',
          image: context.image,
          sourceRegion: {
            left: 0,
            top: 0,
            width: context.image.width,
            height: context.image.height,
          },
        },
      ]
    : []
  for (const panel of panels) {
    if (!context.representation)
      state.push(
        JSON.stringify({
          panel: panel.id,
          sourceRegion: panel.region,
          labels: panel.cells.map((cell) => ({
            id: labels.get(cell.id),
            sourceRegion: cell.region,
          })),
        }),
      )
    if (context.representation) {
      const clean = await context.raster.crop(context.image, panel.region, context.signal)
      views.push({
        id: `${panel.id}-grid`,
        role: 'grid',
        image: clean,
        sourceRegion: panel.region,
        grid: { cells: panel.cells, labels },
      })
    } else if (
      pass === 2 ||
      panel.region.left !== 0 ||
      panel.region.top !== 0 ||
      panel.region.width !== context.image.width ||
      panel.region.height !== context.image.height
    ) {
      state.push(
        `${panel.id} CLEAN CROP`,
        ...(await context.raster.imageState(
          await context.raster.crop(context.image, panel.region, context.signal),
          context.signal,
        )),
      )
    }
    if (!context.representation) {
      const grid = await context.raster.grid(
        context.image,
        panel.region,
        panel.cells,
        labels,
        context.signal,
      )
      state.push(`${panel.id} GRID`, ...(await context.raster.imageState(grid, context.signal)))
    }
  }
  if (context.representation) {
    const prepared = await context.representation.prepare({
      source: context.image,
      views,
      signal: context.signal,
    })
    state.push(...prepared.state)
  }
  const answer = await decide(context, { state, questions: gridQuestions(cells, labels) })
  return {
    cells,
    answer,
    selected: canonicalAnswer(selection(answer, [...labels.values()]), labels),
  }
}
async function finalPass(
  context: Context,
  cells: readonly GridCell[],
  selected:
    | { choice: string; probabilities: Record<string, number> }
    | { choice: string; ranking: readonly string[] },
) {
  const ranked = rankChoiceBeamCells(cells, selected)
  const shortest = Math.min(...ranked.flatMap((c) => [c.cell.region.width, c.cell.region.height]))
  const longest = Math.max(...ranked.flatMap((c) => [c.cell.region.width, c.cell.region.height]))
  const scale = Math.min(16, Math.floor(1024 / longest), Math.ceil(512 / shortest))
  if (scale < 1 || !ranked.length) return undefined
  const labels = ranked.map((_, i) => String.fromCharCode(65 + i))
  const state: DecisionState = [
    ...targetState(context.target, context.exclusions),
    'ORIGINAL',
    ...context.original,
  ]
  const views: RepresentationView[] = context.representation
    ? [
        {
          id: 'source',
          role: 'source',
          image: context.image,
          sourceRegion: {
            left: 0,
            top: 0,
            width: context.image.width,
            height: context.image.height,
          },
        },
      ]
    : []
  for (const [index, item] of ranked.entries()) {
    const crop = await context.raster.crop(context.image, item.cell.region, context.signal, scale)
    if (context.representation) {
      views.push({
        id: `candidate-${labels[index]}`,
        role: 'crop',
        image: crop,
        sourceRegion: item.cell.region,
      })
    } else {
      state.push(
        `CANDIDATE ${labels[index]}`,
        ...(await context.raster.imageState(crop, context.signal)),
      )
    }
  }
  if (context.representation) {
    const prepared = await context.representation.prepare({
      source: context.image,
      views,
      signal: context.signal,
    })
    state.push(...prepared.state)
  }
  const answer = await decide(context, { state, questions: candidateQuestions(labels) })
  const result = selection(answer, [...labels, 'none'], 1)
  const index = labels.indexOf(result.choice)
  return { result, present: presence(answer), region: ranked[index]?.cell.region }
}
function unknown(reason: Extract<LocalizationResult, { status: 'unknown' }>['reason']) {
  return { status: 'unknown' as const, reason }
}
async function search(context: Context, region: PixelRect) {
  const firstCells = choiceBeamFirstCells(region)
  if (firstCells.length < 2) return unknown('layout-limit')
  const first = await gridPass(context, [{ id: 'FRAME', region, cells: firstCells }], 1)
  if (presence(first.answer) === 0.5) return unknown('uncertain-presence')
  if (presence(first.answer) < 0.5)
    return { status: 'not-found' as const, reason: 'absent-in-evaluated-region' as const }
  const panels = choiceBeamPanels(region, first.cells, first.selected, 8)
  if (!panels.length || new Set(panels.flatMap((p) => p.cells.map((c) => c.id))).size < 2)
    return unknown('layout-limit')
  const second = await gridPass(context, panels, 2)
  if (presence(second.answer) === 0.5) return unknown('uncertain-presence')
  if (presence(second.answer) < 0.5) return unknown('candidate-union-empty')
  const final = await finalPass(context, second.cells, second.selected)
  if (!final) return unknown('layout-limit')
  if (final.present === 0.5) return unknown('uncertain-presence')
  if (final.result.choice === 'none')
    return unknown(final.present > 0.5 ? 'contradictory-evidence' : 'candidate-union-empty')
  if (final.present < 0.5 || !final.region) return unknown('contradictory-evidence')
  return {
    status: 'located' as const,
    region: { ...final.region },
    normalizedRegion: {
      left: final.region.left / context.image.width,
      top: final.region.top / context.image.height,
      width: final.region.width / context.image.width,
      height: final.region.height / context.image.height,
    },
    selection: final.result,
    method: 'three-choice-grid-v1' as const,
  }
}
const refinementSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('refined'), region: pixelRectSchema, method: z.string().min(1) })
    .strict(),
  z.object({ status: z.literal('unknown'), reason: z.string().min(1) }).strict(),
])
async function refine(
  refiner: RefinementPort,
  image: RasterImage,
  target: string,
  region: PixelRect,
  signal: AbortSignal,
) {
  const result = parse(
    refinementSchema,
    await refiner.refine({
      image: new Uint8Array(image.bytes),
      target,
      region: { ...region },
      signal,
    }),
    'INVALID_RESPONSE',
  )
  assertActive(signal)
  if (result.status === 'refined') {
    const r = result.region
    if (
      r.left + r.width > image.width ||
      r.top + r.height > image.height ||
      r.left >= region.left + region.width ||
      r.top >= region.top + region.height ||
      r.left + r.width <= region.left ||
      r.top + r.height <= region.top
    )
      throw new ClassifierError(
        'INVALID_RESPONSE',
        'Refinement must fit the source and intersect the selected cell',
      )
  }
  return result
}
export async function locateInput(
  input: Omit<LocateInput, 'signal'>,
  decision: DecisionPort,
  raster: RasterPort,
  signal: AbortSignal,
  refiner?: RefinementPort,
  representation?: ImageRepresentationPort,
): Promise<LocalizationResult> {
  const started = performance.now()
  const image = await raster.normalize(input.image, signal)
  const region = input.roi ?? { left: 0, top: 0, width: image.width, height: image.height }
  if (region.left + region.width > image.width || region.top + region.height > image.height)
    throw new ClassifierError('INVALID_INPUT', 'ROI lies outside oriented source image')
  const context: Context = {
    decision,
    raster,
    signal,
    image,
    original: representation ? [] : await raster.imageState(image, signal),
    stages: [],
    target: input.target,
    exclusions: input.exclusions ?? [],
    ...(representation === undefined ? {} : { representation }),
  }
  const result = await search(context, region)
  const refinement =
    result.status === 'located' && refiner
      ? await refine(refiner, image, input.target, result.region, signal)
      : undefined
  assertActive(signal)
  return {
    ...result,
    ...(refinement === undefined ? {} : { refinement }),
    metadata: {
      image: {
        width: image.width,
        height: image.height,
        coordinateSpace: 'oriented-source-pixels',
      },
      stages: context.stages,
      durationMs: performance.now() - started,
      knownCostUsd: context.stages.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
      unknownCostCount: context.stages.filter((s) => s.costUsd === null).length,
    },
  }
}
