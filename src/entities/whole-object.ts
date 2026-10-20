import { z } from 'zod'
import { locateSchema } from './contracts.js'
import type { SegmentationMetadata } from './segmentation-metadata.js'
import type {
  LocalizationMetadata,
  LocalizationResult,
  LocateInput,
  PixelRect,
} from './contracts.js'

export const wholeObjectSchema = locateSchema.extend({
  mode: z.literal('whole-object'),
  boxTolerancePx: z.number().int().min(1).max(64).default(8),
  maxExtentPasses: z.number().int().min(1).max(3).default(3),
})
export type RegionLocateInput = LocateInput
export type WholeObjectLocateInput = z.input<typeof wholeObjectSchema> & { signal?: AbortSignal }
export type AnyLocateInput = RegionLocateInput | WholeObjectLocateInput
export interface BoundaryInterval {
  start: number
  endExclusive: number
}
export interface ObjectBounds {
  left: BoundaryInterval
  right: BoundaryInterval
  top: BoundaryInterval
  bottom: BoundaryInterval
}
type LocalizationFailure = Exclude<LocalizationResult, { status: 'located' }>
export interface WholeObjectLocated {
  status: 'located'
  kind: 'whole-object'
  region: PixelRect
  normalizedRegion: PixelRect
  seedRegion: PixelRect
  bounds: ObjectBounds
  completeness: 'visible-object' | 'boundary-limited'
  method: 'grid-object-extent-v1' | 'pixel-mask-proposals-v1'
  /** Present only for the explicitly configured, caller-owned mask proposal workflow. */
  proposalMetadata?: SegmentationMetadata
  metadata: LocalizationMetadata
}
export type WholeObjectFailure =
  | LocalizationFailure
  | {
      status: 'unknown'
      reason:
        | 'instance-ambiguous'
        | 'extent-uncertain'
        | 'extent-inconsistent'
        | 'representation-limit'
      metadata: LocalizationMetadata
    }
export type WholeObjectLocalizationResult = WholeObjectLocated | WholeObjectFailure
