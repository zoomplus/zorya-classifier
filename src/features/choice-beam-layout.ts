import type { PixelRect } from '../entities/contracts.js'
import type {
  ChoiceAnswer as CategoricalAnswer,
  GridCell,
  GridPanel as GridDecisionPanel,
} from '../entities/contracts.js'

import { pixelRectSchema } from '../entities/contracts.js'
import { containsRect } from '../entities/geometry.js'
import { uniformCoordinateCells } from './uniform-grid.js'

type ChoiceMap =
  | Pick<CategoricalAnswer, 'choice' | 'probabilities'>
  | { choice: string; ranking: readonly string[] }
type PanelGeometry = Pick<GridDecisionPanel, 'id' | 'region' | 'cells'>
type RankedCell = { cell: GridCell; probability: number | null }
type Layout = { columns: number; rows: number; side: number; imbalance: number; count: number }
const sourceKey = (region: PixelRect): string =>
  `${region.left}:${region.top}:${region.width}:${region.height}`
function assertRegion(region: PixelRect): void {
  if (
    !pixelRectSchema.safeParse(region).success ||
    !Number.isSafeInteger(region.left + region.width) ||
    !Number.isSafeInteger(region.top + region.height)
  )
    throw new RangeError('Choice beam requires safe positive source-pixel rectangles')
}
/** Native Choice is validated by its consumer; this helper never normalizes raw probabilities. */
export function rankChoiceBeamCells(cells: readonly GridCell[], answer: ChoiceMap): RankedCell[] {
  if (cells.length > 196) throw new RangeError('Choice beam exceeds its distinct-cell budget')
  if (!cells.length) return []
  if ('ranking' in answer) {
    if (
      answer.ranking.length !== Math.min(4, cells.length) ||
      new Set(answer.ranking).size !== answer.ranking.length ||
      answer.ranking[0] !== answer.choice
    )
      throw new RangeError('Choice beam needs a complete top-four closed ranking')
    const meanings = new Map<string, string>()
    for (const cell of cells) {
      assertRegion(cell.region)
      const key = sourceKey(cell.region)
      if (!cell.id || (meanings.has(cell.id) && meanings.get(cell.id) !== key))
        throw new RangeError('Conflicting cell IDs')
      meanings.set(cell.id, key)
    }
    const seen = new Set<string>(),
      ranked: RankedCell[] = []
    for (const id of answer.ranking) {
      const cell = cells.find((value) => value.id === id)
      if (!cell) throw new RangeError('Ranking contains an unknown cell')
      const key = sourceKey(cell.region)
      if (!seen.has(key)) {
        seen.add(key)
        ranked.push({ cell, probability: null })
      }
    }
    return ranked
  }
  const meanings = new Map<string, string>()
  const ranked = cells.map((cell, order) => {
    assertRegion(cell.region)
    const probability = answer.probabilities[cell.id],
      key = sourceKey(cell.region)
    if (
      !cell.id ||
      !Object.hasOwn(answer.probabilities, cell.id) ||
      probability === undefined ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1 ||
      (meanings.has(cell.id) && meanings.get(cell.id) !== key)
    )
      throw new RangeError('Choice beam needs complete finite probabilities and canonical cell IDs')
    meanings.set(cell.id, key)
    return { cell, probability, order }
  })
  const selected = ranked.find((item) => item.cell.id === answer.choice),
    maximum = Math.max(...ranked.map((item) => item.probability))
  if (!selected || selected.probability !== maximum)
    throw new RangeError('Choice beam requires a native spatial maximum')
  ranked.sort((a, b) => b.probability - a.probability || a.order - b.order)
  const seen = new Set<string>(),
    result: RankedCell[] = []
  for (const item of ranked) {
    const key = sourceKey(item.cell.region)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ cell: item.cell, probability: item.probability })
    if (result.length === 4) break
  }
  return result
}
/** S7 coarse first pass owns every requested source pixel once, including tiny or narrow ROIs. */
export function choiceBeamFirstCells(region: PixelRect): GridCell[] {
  assertRegion(region)
  return uniformCoordinateCells(region, 4, 4)
}
function contextRegion(region: PixelRect, cell: PixelRect): PixelRect {
  const padX = Math.ceil(cell.width / 2),
    padY = Math.ceil(cell.height / 2),
    left = Math.max(region.left, cell.left - padX),
    top = Math.max(region.top, cell.top - padY)
  return {
    left,
    top,
    width: Math.min(region.left + region.width, cell.left + cell.width + padX) - left,
    height: Math.min(region.top + region.height, cell.top + cell.height + padY) - top,
  }
}
function panelLayout(region: PixelRect, accuracy: number): Layout | undefined {
  const desiredColumns = Math.ceil(region.width / accuracy),
    desiredRows = Math.ceil(region.height / accuracy)
  let best: Layout | undefined
  for (let columns = 1; columns <= Math.min(49, desiredColumns); columns++) {
    for (let rows = 1; rows <= Math.min(Math.floor(49 / columns), desiredRows); rows++) {
      const side = Math.max(Math.ceil(region.width / columns), Math.ceil(region.height / rows))
      if (side > 256) continue
      const imbalance = Math.abs(region.width / columns - region.height / rows),
        count = columns * rows
      if (
        !best ||
        side < best.side ||
        (side === best.side && imbalance < best.imbalance) ||
        (side === best.side && imbalance === best.imbalance && count > best.count)
      )
        best = { columns, rows, side, imbalance, count }
    }
  }
  return best
}
/** Four independent padded source ROIs; an impossible bounded layout returns no panels. */
export function choiceBeamPanels(
  region: PixelRect,
  coarseCells: readonly GridCell[],
  answer: ChoiceMap,
  accuracyPx: number,
): PanelGeometry[] {
  assertRegion(region)
  if (!Number.isSafeInteger(accuracyPx) || accuracyPx < 1 || accuracyPx > 64)
    throw new RangeError('Choice beam accuracy must be a bounded positive integer')
  if (coarseCells.length > 16) throw new RangeError('Choice beam first pass exceeds16 cells')
  for (const cell of coarseCells) {
    assertRegion(cell.region)
    if (!containsRect(region, cell.region))
      throw new RangeError('Choice beam coarse cells must fit the requested source ROI')
  }
  const canonical = new Map<string, string>(),
    panels: PanelGeometry[] = []
  for (const { cell } of rankChoiceBeamCells(coarseCells, answer)) {
    const roi = contextRegion(region, cell.region),
      layout = panelLayout(roi, accuracyPx)
    if (!layout) return []
    const id = `p${panels.length}`,
      cells = uniformCoordinateCells(roi, layout.columns, layout.rows).map((fine) => {
        const key = sourceKey(fine.region),
          canonicalId = canonical.get(key) ?? `${id}:${fine.id}`
        canonical.set(key, canonicalId)
        return { ...fine, id: canonicalId }
      })
    panels.push({ id, region: roi, cells })
  }
  return panels
}
