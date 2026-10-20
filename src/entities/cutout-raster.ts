import type { RasterImage } from './contracts.js'
import type { RgbaRaster } from './representation.js'

/** Pixel codec boundary owned by infrastructure; orchestration only sees canonical pixels. */
export interface CutoutRasterPort {
  rgba(image: RasterImage, signal: AbortSignal): Promise<RgbaRaster>
  png(image: RgbaRaster, signal: AbortSignal): Promise<Uint8Array>
}
