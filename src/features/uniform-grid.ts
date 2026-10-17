import type { PixelRect } from '../entities/contracts.js'
import type { GridCell } from '../entities/contracts.js'

import { pixelRectSchema } from '../entities/contracts.js'

export function uniformCoordinateCells(
  region: PixelRect,
  columns: number,
  rows: number,
): GridCell[] {
  if (
    !pixelRectSchema.safeParse(region).success ||
    !Number.isSafeInteger(region.left + region.width) ||
    !Number.isSafeInteger(region.top + region.height) ||
    !Number.isSafeInteger(columns) ||
    !Number.isSafeInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns > 63 ||
    rows > 63
  )
    throw new RangeError('Uniform grid requires safe bounded coordinates and axis counts')
  const cx = Math.min(columns, region.width),
    cy = Math.min(rows, region.height)
  if (cx * cy > 713 || cx + cy + 2 > 128)
    throw new RangeError('Uniform grid exceeds its cell or question budget')
  return Array.from({ length: cx * cy }, (_, index) => {
    const column = index % cx,
      row = Math.floor(index / cx)
    const left = region.left + Math.floor((column * region.width) / cx)
    const top = region.top + Math.floor((row * region.height) / cy)
    return {
      id: `y${row}:x${column}`,
      xId: `x${column}`,
      yId: `y${row}`,
      column,
      row,
      kind: 'cell',
      region: {
        left,
        top,
        width: region.left + Math.floor(((column + 1) * region.width) / cx) - left,
        height: region.top + Math.floor(((row + 1) * region.height) / cy) - top,
      },
    }
  })
}
