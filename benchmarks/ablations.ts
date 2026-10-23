import { z } from 'zod'
import type { DecisionRequest, DecisionResult, PixelRect } from '../src/index.js'
import type { CallRecord } from './recording.js'
import { acceptsChoiceMass } from '../src/shared/choice-mass.js'

const regionSchema = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
const panelSchema = z
  .object({
    panel: z.string(),
    sourceRegion: regionSchema,
    labels: z.array(z.object({ id: z.string(), sourceRegion: regionSchema }).strict()).max(196),
  })
  .strict()
type PrefixResult =
  | { status: 'located'; region: PixelRect }
  | { status: 'not-found' | 'unknown' | 'failed'; reason: string }
/** Native baseline uses the same maximum and stable input-order tie convention, without another library call. */
export function nativeSelection(
  request: DecisionRequest,
  result: DecisionResult,
): { choice: string; probabilities: Record<string, number> } {
  const question = request.questions.selection,
    answer = result.answers.selection
  if (question?.type !== 'choice' || answer?.type !== 'choice')
    throw new Error('Missing categorical selection')
  const keys = Object.keys(question.criteria),
    values = keys.map((key) => answer.probabilities[key] ?? NaN)
  if (
    !keys.length ||
    Object.keys(answer.probabilities).length !== keys.length ||
    values.some(
      (value) => value === undefined || !Number.isFinite(value) || value < 0 || value > 1,
    ) ||
    !acceptsChoiceMass(values, answer.probabilityRoundingStep)
  )
    throw new Error('Invalid categorical distribution')
  const maximum = Math.max(...values.map((value) => value ?? -1))
  const choice = keys.find((key) => answer.probabilities[key] === maximum)
  if (!choice || answer.probabilities[answer.choice] !== maximum)
    throw new Error('Invalid native Choice maximum')
  return { choice, probabilities: { ...answer.probabilities } }
}
/** Prefix ablation only: no third-stage identity confirmation, no inferred boxes from text. */
export function prefixResult(calls: readonly CallRecord[], stage: 1 | 2): PrefixResult {
  const first = calls[0]
  if (!first?.result || first.error)
    return { status: 'failed', reason: 'first-stage-failed-or-unattempted' }
  const firstPresence = first.result.answers.presence
  if (firstPresence?.type !== 'noul') return { status: 'failed', reason: 'missing-presence' }
  if (firstPresence.noul === 0.5) return { status: 'unknown', reason: 'uncertain-presence' }
  if (firstPresence.noul < 0.5) return { status: 'not-found', reason: 'absent-in-evaluated-region' }
  const call = calls[stage - 1]
  if (!call?.result || call.error) return { status: 'failed', reason: 'prefix-not-complete' }
  const presence = call.result.answers.presence
  if (presence?.type !== 'noul') return { status: 'failed', reason: 'missing-presence' }
  if (presence.noul === 0.5) return { status: 'unknown', reason: 'uncertain-presence' }
  if (presence.noul < 0.5) return { status: 'unknown', reason: 'candidate-union-empty' }
  try {
    const selected = nativeSelection(call.request, call.result)
    const geometries = new Map<string, PixelRect>()
    for (const part of call.request.state) {
      if (typeof part !== 'string' || !part.startsWith('{')) continue
      let json: unknown
      try {
        json = JSON.parse(part) as unknown
      } catch {
        continue
      }
      const panel = panelSchema.safeParse(json)
      if (!panel.success) continue
      for (const label of panel.data.labels) {
        const previous = geometries.get(label.id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(label.sourceRegion))
          throw new Error('Conflicting label geometry')
        geometries.set(label.id, label.sourceRegion)
      }
    }
    const region = geometries.get(selected.choice)
    if (!region) return { status: 'failed', reason: 'missing-label-source-region' }
    return { status: 'located', region }
  } catch {
    return { status: 'failed', reason: 'invalid-prefix-evidence' }
  }
}
export function prefixLatency(
  calls: readonly CallRecord[],
  stage: 1 | 2,
  operationMs: number,
): number {
  return calls[stage - 1]?.finishedMs ?? calls.at(-1)?.finishedMs ?? operationMs
}
