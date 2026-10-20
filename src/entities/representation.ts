import type { DecisionState, GridCell, PixelRect, RasterImage } from './contracts.js'

/** Canonical oriented RGBA8. Alpha remains meaningful; transparent is not black. */
export interface RgbaRaster {
  data: Uint8Array
  width: number
  height: number
  format: 'rgba8'
}
export interface RepresentationView {
  id: string
  role: 'source' | 'crop' | 'grid'
  image: RasterImage
  sourceRegion: PixelRect
  grid?: { cells: readonly GridCell[]; labels: ReadonlyMap<string, string> }
}
export interface RepresentationMetadata {
  profile: string
  bytes: number
  views: {
    id: string
    sourceRegion: PixelRect
    width: number
    height: number
    scaleX: number
    scaleY: number
    content?: PixelRect
  }[]
}
/** Prepare once for the entire decision request, including all candidate views. */
export interface ImageRepresentationPort {
  prepare(input: {
    source: RasterImage
    views: readonly RepresentationView[]
    signal: AbortSignal
  }): Promise<{ state: DecisionState; metadata: RepresentationMetadata }>
}
export const representationLimits = Object.freeze({
  totalBytes: 64 * 1024,
  partCharacters: 64000,
  maxSide: 64,
  maxViews: 9,
})
