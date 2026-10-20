import { hasCompatibleIntegerRoundedAspect } from './categorical-photo-mask-truth.js'

const MAX_SOURCE_OR_PREDICTION_PIXELS = 2_097_152
const MAX_ANNOTATION_CANVAS_PIXELS = 2048 * 2048

export interface NormalizedCanvasMaskInput {
  /** Binary 0/1 prediction in its cropped region. */
  predictedMask: Uint8Array
  predictedWidth: number
  predictedHeight: number
  /** Cropped-mask origin in the canonical source image. */
  sourceOffsetX: number
  sourceOffsetY: number
  sourceWidth: number
  sourceHeight: number
  /** Decoded official PNG mask as binary 0/255 values, unchanged on disk. */
  referenceMask: Uint8Array
  referenceWidth: number
  referenceHeight: number
}

/**
 * Exploratory IoU on an independently normalized full-frame annotation canvas.
 * Each reference pixel center maps to the nearest canonical source pixel center;
 * cropped prediction pixels outside their source offset are treated as background.
 */
export function scoreOpenImagesNormalizedCanvasMaskIoU(input: NormalizedCanvasMaskInput) {
  const dimensions = [
    input.predictedWidth,
    input.predictedHeight,
    input.sourceWidth,
    input.sourceHeight,
    input.referenceWidth,
    input.referenceHeight,
  ]
  if (dimensions.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 2048))
    throw new Error('Normalized mask geometry must use bounded positive integer dimensions')
  const pixelCounts = [
    input.predictedWidth * input.predictedHeight,
    input.sourceWidth * input.sourceHeight,
    input.referenceWidth * input.referenceHeight,
  ]
  if (
    pixelCounts
      .slice(0, 2)
      .some((n) => !Number.isSafeInteger(n) || n > MAX_SOURCE_OR_PREDICTION_PIXELS)
  )
    throw new Error('Source or prediction mask exceeds the 2,097,152-pixel limit')
  if (pixelCounts[2]! > MAX_ANNOTATION_CANVAS_PIXELS)
    throw new Error('Annotation canvas exceeds the 2048-by-2048-pixel limit')
  if (
    !Number.isSafeInteger(input.sourceOffsetX) ||
    !Number.isSafeInteger(input.sourceOffsetY) ||
    input.sourceOffsetX < 0 ||
    input.sourceOffsetY < 0 ||
    input.sourceOffsetX + input.predictedWidth > input.sourceWidth ||
    input.sourceOffsetY + input.predictedHeight > input.sourceHeight
  )
    throw new Error('Predicted crop does not fit its declared source canvas')
  if (
    input.predictedMask.length !== pixelCounts[0] ||
    input.referenceMask.length !== pixelCounts[2]
  )
    throw new Error('Normalized mask byte lengths do not match their declared canvases')
  if (
    !hasCompatibleIntegerRoundedAspect(
      input.sourceWidth,
      input.sourceHeight,
      input.referenceWidth,
      input.referenceHeight,
    )
  )
    throw new Error('Source and reference canvases fail integer-rounded aspect compatibility')
  if (input.predictedMask.some((value) => value !== 0 && value !== 1))
    throw new Error('Predicted mask must contain only binary 0/1 values')
  if (input.referenceMask.some((value) => value !== 0 && value !== 255))
    throw new Error('Reference mask must contain only binary 0/255 values')

  let intersection = 0
  let union = 0
  for (let y = 0; y < input.referenceHeight; y++) {
    const sourceY = Math.max(
      0,
      Math.min(
        input.sourceHeight - 1,
        Math.round(((y + 0.5) * input.sourceHeight) / input.referenceHeight - 0.5),
      ),
    )
    const localY = sourceY - input.sourceOffsetY
    for (let x = 0; x < input.referenceWidth; x++) {
      const sourceX = Math.max(
        0,
        Math.min(
          input.sourceWidth - 1,
          Math.round(((x + 0.5) * input.sourceWidth) / input.referenceWidth - 0.5),
        ),
      )
      const localX = sourceX - input.sourceOffsetX
      const predictedOn =
        localX >= 0 &&
        localY >= 0 &&
        localX < input.predictedWidth &&
        localY < input.predictedHeight &&
        input.predictedMask[localY * input.predictedWidth + localX] === 1
      const referenceOn = input.referenceMask[y * input.referenceWidth + x] === 255
      if (predictedOn || referenceOn) union++
      if (predictedOn && referenceOn) intersection++
    }
  }
  return {
    intersection,
    union,
    iou: union === 0 ? 0 : intersection / union,
    method: 'normalized-pixel-center-nearest-neighbor-v1' as const,
  }
}
