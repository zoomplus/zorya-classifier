import { z } from 'zod'

export const pixelRectSchema = z
  .object({
    left: z.number().int().nonnegative().safe(),
    top: z.number().int().nonnegative().safe(),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
  })
  .strict()
export type PixelRect = z.infer<typeof pixelRectSchema>
export interface GridCell {
  id: string
  column: number
  row: number
  region: PixelRect
  xId?: string
  yId?: string
  kind?: 'cell'
}
export interface GridPanel {
  id: string
  region: PixelRect
  cells: readonly GridCell[]
}

/** Containment with zero inner width/height allowed when endpoints fit inside outer. */
export function containsRect(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  )
}

/** Containment requiring strictly positive inner width and height. */
export function containsNonEmptyRect(outer: PixelRect, inner: PixelRect): boolean {
  return inner.width > 0 && inner.height > 0 && containsRect(outer, inner)
}

export function intersectsRect(first: PixelRect, second: PixelRect): boolean {
  return (
    first.left < second.left + second.width &&
    second.left < first.left + first.width &&
    first.top < second.top + second.height &&
    second.top < first.top + first.height
  )
}
