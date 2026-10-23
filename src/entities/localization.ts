import { z } from 'zod'

import type { ChoiceSelection, DecisionMetadata } from './decision.js'
import { pixelRectSchema, type PixelRect } from './geometry.js'
import { imageSchema, representationSchema } from './image.js'

export const locateSchema = z
  .object({
    image: imageSchema,
    target: z.string().trim().min(1).max(2000),
    exclusions: z.array(z.string().trim().min(1).max(500)).max(16).default([]),
    roi: pixelRectSchema.optional(),
    mode: z.literal('region').optional(),
    representation: representationSchema.optional(),
  })
  .strict()
/** @experimental Unqualified coarse region search; a located grid cell is a hypothesis, not reliable whole-object geometry or proof of absence. */
export type LocateInput = z.input<typeof locateSchema> & { signal?: AbortSignal }
export interface LocalizationMetadata {
  image: { width: number; height: number; coordinateSpace: 'oriented-source-pixels' }
  stages: DecisionMetadata[]
  durationMs: number
  knownCostUsd: number
  unknownCostCount: number
}
/** @experimental Outcome of unqualified spatial localization; grid regions are not semantic object boxes or masks. */
export type LocalizationResult = (
  | {
      status: 'located'
      region: PixelRect
      normalizedRegion: PixelRect
      selection: ChoiceSelection
      method: 'three-choice-grid-v1'
      refinement?: RefinementResult
    }
  | { status: 'not-found'; reason: 'absent-in-evaluated-region' }
  | {
      status: 'unknown'
      reason:
        | 'uncertain-presence'
        | 'candidate-union-empty'
        | 'contradictory-evidence'
        | 'layout-limit'
    }
) & { metadata: LocalizationMetadata }
/** @experimental Optional legacy region refinement with no general quality qualification. */
export type RefinementResult =
  | { status: 'refined'; region: PixelRect; method: string }
  | { status: 'unknown'; reason: string }
/** @experimental Caller-owned refinement hook; unqualified for general spatial accuracy. */
export interface RefinementPort {
  refine(input: {
    image: Uint8Array
    target: string
    region: PixelRect
    signal: AbortSignal
  }): Promise<RefinementResult>
}
