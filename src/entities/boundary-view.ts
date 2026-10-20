import type { PixelRect, RasterImage } from './contracts.js'
import type { BoundaryInterval } from './whole-object.js'

export type BoundaryAxis = 'left' | 'right' | 'top' | 'bottom'
export interface BoundaryCandidate {
  /** Exact closed Choice key; display labels are mapped back to this ID by code. */
  id: string
  display: string
  interval: BoundaryInterval
}
export interface BoundaryViewInput {
  source: RasterImage
  sourceRegion: PixelRect
  axis: BoundaryAxis
  candidates: readonly BoundaryCandidate[]
  signal: AbortSignal
}
export interface BoundaryView {
  image: RasterImage
  sourceRegion: PixelRect
  /** Source pixels occupy this rectangle; rulers/gutters are outside it. */
  content: PixelRect
  scaleX: number
  scaleY: number
  candidates: readonly BoundaryCandidate[]
}
/** Rendering only: never infers target facts or generates source coordinates. */
export interface BoundaryViewPort {
  render(input: BoundaryViewInput): Promise<BoundaryView>
}
