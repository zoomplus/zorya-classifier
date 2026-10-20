import type { ChoiceSelection, DecisionMetadata, PixelRect, RasterImage } from './contracts.js'
import type { RgbaRaster } from './representation.js'

/** A containment check for the same visible instance identified by the original seed. */
export interface SegmentationBoxCheckInput {
  image: RgbaRaster
  region: PixelRect
  seedRegion: PixelRect
  roi: PixelRect
  target: string
  exclusions: readonly string[]
  signal: AbortSignal
}

export type SegmentationBoxVerdict = 'complete' | 'needs-expansion' | 'unknown'

export interface SegmentationBoxCheckResult {
  verdict: SegmentationBoxVerdict
  selection: ChoiceSelection
  metadata: DecisionMetadata
}

export interface SegmentationBoxCheckPort {
  check(input: SegmentationBoxCheckInput): Promise<SegmentationBoxCheckResult>
}

/** Full oriented source with the actual mask box and a seed anchor; no generated geometry. */
export interface SegmentationBoxPresentationPort {
  render(input: SegmentationBoxCheckInput): Promise<RasterImage>
}

/** Containment evidence is separate from the correctness of individual mask pixels. */
export interface SegmentationVerification {
  checks: SegmentationBoxCheckResult[]
  expansion: 'not-needed' | 'unsupported' | 'no-enclosing-mask' | 'rejected-mask' | 'expanded'
}
