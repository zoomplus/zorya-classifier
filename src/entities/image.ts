import { z } from 'zod'

import type { DecisionState } from './decision.js'
import type { GridCell, PixelRect } from './geometry.js'

export const limits = Object.freeze({
  imageBytes: 16 * 1024 * 1024,
  imagePixels: 16_777_216,
  bodyBytes: 32 * 1024 * 1024,
  maxClasses: 255,
  maxImages: 9,
})

export const imageSchema = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array)
  .refine(
    (v) => v.byteLength > 0 && v.byteLength <= limits.imageBytes,
    'Expected 1..16MiB image bytes',
  )

export const representationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('vision') }).strict(),
  z.object({ type: z.literal('experimental-text'), profile: z.literal('text-image-v1') }).strict(),
])
export type Representation = z.infer<typeof representationSchema>

export interface RasterImage {
  bytes: Uint8Array
  width: number
  height: number
}
export interface RasterPort {
  normalize(bytes: Uint8Array, signal: AbortSignal): Promise<RasterImage>
  crop(
    image: RasterImage,
    region: PixelRect,
    signal: AbortSignal,
    scale?: number,
  ): Promise<RasterImage>
  imageState(image: RasterImage, signal: AbortSignal): Promise<DecisionState>
  grid(
    image: RasterImage,
    region: PixelRect,
    cells: readonly GridCell[],
    labels: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<RasterImage>
}
