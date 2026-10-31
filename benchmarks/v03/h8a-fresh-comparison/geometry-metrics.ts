export interface BoxRect {
  left: number
  top: number
  width: number
  height: number
}

function validateBox(box: BoxRect): void {
  if (
    ![box.left, box.top, box.width, box.height].every(Number.isFinite) ||
    box.left < 0 ||
    box.top < 0 ||
    box.width <= 0 ||
    box.height <= 0
  )
    throw new RangeError('Invalid box geometry')
}

export function boxIoUAndReferenceCoverage(predicted: BoxRect, reference: BoxRect) {
  validateBox(predicted)
  validateBox(reference)
  const overlapLeft = Math.max(predicted.left, reference.left)
  const overlapTop = Math.max(predicted.top, reference.top)
  const overlapRight = Math.min(predicted.left + predicted.width, reference.left + reference.width)
  const overlapBottom = Math.min(predicted.top + predicted.height, reference.top + reference.height)
  const overlapWidth = Math.max(0, overlapRight - overlapLeft)
  const overlapHeight = Math.max(0, overlapBottom - overlapTop)
  const intersection = overlapWidth * overlapHeight
  const predictedArea = predicted.width * predicted.height
  const referenceArea = reference.width * reference.height
  const union = predictedArea + referenceArea - intersection
  if (!(union > 0)) throw new RangeError('Box union must be positive')
  const iou = intersection / union
  const referenceCoverage = intersection / referenceArea
  return {
    iou,
    referenceCoverage,
    matched: iou >= 0.5 && referenceCoverage >= 0.9,
  }
}

export function binaryMaskIoU(predicted: Uint8Array, reference: Uint8Array) {
  if (predicted.length === 0 || predicted.length !== reference.length)
    throw new RangeError('Mask length mismatch')
  let intersection = 0
  let union = 0
  let referencePixels = 0
  for (let index = 0; index < predicted.length; index++) {
    const p = predicted[index]
    const r = reference[index]
    if ((p !== 0 && p !== 1) || (r !== 0 && r !== 1))
      throw new RangeError('Masks must be binary 0/1')
    if (r === 1) referencePixels++
    if (p === 1 || r === 1) union++
    if (p === 1 && r === 1) intersection++
  }
  if (referencePixels === 0)
    throw new RangeError('Reference mask cannot be empty for scored positives')
  const iou = union === 0 ? 0 : intersection / union
  return { iou, matched: iou >= 0.8 }
}

export function missingPredictionMaskIoU(): { iou: number; matched: false } {
  return { iou: 0, matched: false }
}
