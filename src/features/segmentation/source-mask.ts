import type { PixelRect } from '../../entities/contracts.js'
import { containsNonEmptyRect } from '../../entities/geometry.js'
import { ClassifierError } from '../../entities/errors.js'
import type { RgbaRaster } from '../../entities/representation.js'
import type { BinaryMask } from '../../entities/segmentation.js'
import { validateMask } from './mask.js'

export function validateSourceMask(
  mask: BinaryMask,
  image: RgbaRaster,
  roi: PixelRect,
  seed: PixelRect,
): PixelRect | undefined {
  try {
    return validateMask(mask, image, roi, seed)
  } catch {
    throw new ClassifierError('INVALID_RESPONSE', 'Segmenter mask failed binary/source validation')
  }
}

export function clearTransparentForeground(mask: BinaryMask, image: RgbaRaster): void {
  for (let index = 0; index < mask.data.length; index++)
    if (image.data[index * 4 + 3] === 0) mask.data[index] = 0
}

export function isEnclosingMask(
  previous: BinaryMask,
  previousBox: PixelRect,
  expanded: BinaryMask,
  box: PixelRect,
): boolean {
  if (
    !containsNonEmptyRect(box, previousBox) ||
    (box.left === previousBox.left &&
      box.top === previousBox.top &&
      box.width === previousBox.width &&
      box.height === previousBox.height)
  )
    return false
  let added = false
  for (let i = 0; i < previous.data.length; i++) {
    if (previous.data[i] === 1 && expanded.data[i] !== 1) return false
    if (previous.data[i] !== 1 && expanded.data[i] === 1) added = true
  }
  return added
}
