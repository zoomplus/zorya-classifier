import type { LocalizationMetadata, LocalizationResult, PixelRect } from './contracts.js'
import type { RgbaRaster } from './representation.js'
import type { ObjectBounds, WholeObjectFailure, WholeObjectLocated } from './whole-object.js'
import { wholeObjectSchema } from './whole-object.js'
import { z } from 'zod'
import type { SegmentationMetadata } from './segmentation-metadata.js'
import type { SegmentationVerification } from './segmentation-verification.js'
export type { SegmentationMetadata } from './segmentation-metadata.js'

export const extractSchema = wholeObjectSchema.extend({
  mode: z.literal('whole-object').optional(),
})
/** @experimental Region-seeded extraction input; unqualified for general object or mask accuracy. */
export type ExtractInput = z.input<typeof extractSchema> & { signal?: AbortSignal }

export interface BinaryMask {
  data: Uint8Array
  width: number
  height: number
  format: 'binary-u8'
}
export interface SegmentationInput {
  image: RgbaRaster
  seedRegion: PixelRect
  /** A seed prompt identifies the instance on the full image; wholeRegion then limits search. */
  prompt?: 'whole-region' | 'seed-region'
  wholeRegion: PixelRect
  bounds: ObjectBounds
  roi: PixelRect
  target: string
  exclusions: readonly string[]
  completeness: 'visible-object' | 'boundary-limited'
  signal: AbortSignal
}
export type SegmentationResult =
  | { status: 'segmented'; mask: BinaryMask; metadata: SegmentationMetadata }
  | { status: 'unknown'; reason: string; metadata: SegmentationMetadata }
/**
 * Caller-owned. settle joins physical work; dispose closes this adapter only.
 * @experimental Caller-owned segmentation; structural validation does not establish semantic object or mask quality.
 */
export interface SegmentationPort {
  segment(input: SegmentationInput): Promise<SegmentationResult>
  /** Optional actual enclosing mask on the full source; previousMask is full-source binary-u8. */
  expand?(input: SegmentationInput, previousMask: BinaryMask): Promise<SegmentationResult>
  settle(): Promise<void>
  dispose(): Promise<void>
}
/** @experimental Extraction outcome; `extracted` reflects validation, not guaranteed semantic correctness. */
export type ExtractionResult =
  | {
      status: 'extracted'
      location: WholeObjectLocated
      png: Uint8Array
      mask: BinaryMask
      region: PixelRect
      /** Centre of the mask-derived source-space bounding rectangle. */
      center: { x: number; y: number }
      offset: { x: number; y: number }
      segmentation: SegmentationMetadata
      verification?: SegmentationVerification
    }
  | WholeObjectFailure
  | {
      status: 'unknown'
      reason: 'segmentation-uncertain'
      location: WholeObjectLocated
      segmentation: SegmentationMetadata
      verification?: SegmentationVerification
    }
  | {
      status: 'unknown'
      reason: 'segmentation-uncertain'
      /** The original grid result remains a seed, never an inferred object box. */
      seedLocation: Extract<LocalizationResult, { status: 'located' }>
      metadata: LocalizationMetadata
      segmentation: SegmentationMetadata
      verification?: SegmentationVerification
    }
