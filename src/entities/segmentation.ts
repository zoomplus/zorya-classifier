import type { PixelRect } from './contracts.js'
import type { RgbaRaster } from './representation.js'
import type { ObjectBounds, WholeObjectFailure, WholeObjectLocated } from './whole-object.js'

export interface BinaryMask {
  data: Uint8Array
  width: number
  height: number
  format: 'binary-u8'
}
export interface SegmentationInput {
  image: RgbaRaster
  seedRegion: PixelRect
  wholeRegion: PixelRect
  bounds: ObjectBounds
  roi: PixelRect
  target: string
  exclusions: readonly string[]
  completeness: 'visible-object' | 'boundary-limited'
  signal: AbortSignal
}
export interface SegmentationMetadata {
  method: string
  backend: string
  durationMs: number
  input: { width: number; height: number }
  qualityScore?: number
}
export type SegmentationResult =
  | { status: 'segmented'; mask: BinaryMask; metadata: SegmentationMetadata }
  | { status: 'unknown'; reason: string; metadata: SegmentationMetadata }
/** Caller-owned. settle joins physical work; dispose closes this adapter only. */
export interface SegmentationPort {
  segment(input: SegmentationInput): Promise<SegmentationResult>
  settle(): Promise<void>
  dispose(): Promise<void>
}
export type ExtractionResult =
  | {
      status: 'extracted'
      location: WholeObjectLocated
      png: Uint8Array
      mask: BinaryMask
      region: PixelRect
      offset: { x: number; y: number }
      segmentation: SegmentationMetadata
    }
  | WholeObjectFailure
  | {
      status: 'unknown'
      reason: 'segmentation-uncertain'
      location: WholeObjectLocated
      segmentation: SegmentationMetadata
    }
