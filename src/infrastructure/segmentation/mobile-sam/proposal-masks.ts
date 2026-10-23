import { packBinaryMask } from '../../../features/segmentation/packed-mask.js'
import type { NativeObjectProposalReply } from '../native-protocol.js'
import { inside } from './segmentation-masks.js'

/** Produce either the historical 3x3 grid or one geometric-center prompt. */
export function mobileSamProposalPoints(
  rect: {
    left: number
    top: number
    width: number
    height: number
  },
  sampling: 'seed-grid' | 'seed-center' = 'seed-grid',
): Array<{ x: number; y: number }> {
  if (
    !Number.isSafeInteger(rect.left) ||
    !Number.isSafeInteger(rect.top) ||
    !Number.isSafeInteger(rect.width) ||
    !Number.isSafeInteger(rect.height) ||
    rect.left < 0 ||
    rect.top < 0 ||
    rect.width < 1 ||
    rect.height < 1
  )
    throw new Error('Invalid MobileSAM seed rectangle')
  if (sampling !== 'seed-grid' && sampling !== 'seed-center')
    throw new Error('Invalid MobileSAM proposal sampling profile')
  if (sampling === 'seed-center')
    return [{ x: rect.left + (rect.width - 1) / 2, y: rect.top + (rect.height - 1) / 2 }]
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3)
    const column = index % 3
    return {
      x: rect.left + Math.round(((rect.width - 1) * column) / 2),
      y: rect.top + Math.round(((rect.height - 1) * row) / 2),
    }
  })
}

/** Turn one decoder response into four owned packed candidates immediately. */
export function packMobileSamProposalCandidates(input: {
  width: number
  height: number
  rgba: Uint8Array
  roi: { left: number; top: number; width: number; height: number }
  pointIndex: number
  logits: Float32Array
  scores: Float32Array
}): NativeObjectProposalReply['proposals'] {
  const pixels = input.width * input.height
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    pixels > 2_097_152 ||
    input.rgba.length !== pixels * 4 ||
    input.logits.length !== pixels * 4 ||
    input.scores.length !== 4 ||
    !Number.isInteger(input.pointIndex) ||
    input.pointIndex < 0 ||
    input.pointIndex > 8 ||
    input.roi.left < 0 ||
    input.roi.top < 0 ||
    input.roi.width < 1 ||
    input.roi.height < 1 ||
    input.roi.left + input.roi.width > input.width ||
    input.roi.top + input.roi.height > input.height
  )
    throw new Error('Invalid MobileSAM proposal response dimensions')
  const proposals: NativeObjectProposalReply['proposals'] = []
  for (let token = 0; token < 4; token++) {
    const qualityScore = input.scores[token]
    if (qualityScore === undefined || !Number.isFinite(qualityScore))
      throw new Error('Invalid MobileSAM proposal quality score')
    const mask = new Uint8Array(pixels)
    const base = token * pixels
    for (let index = 0; index < pixels; index++) {
      const value = input.logits[base + index]
      if (value === undefined || !Number.isFinite(value))
        throw new Error('Non-finite MobileSAM proposal logit')
      if (value <= 0 || input.rgba[index * 4 + 3] === 0) continue
      const x = index % input.width
      const y = Math.floor(index / input.width)
      if (inside(input.roi, x, y)) mask[index] = 1
    }
    const id = `C${String(input.pointIndex * 4 + token).padStart(2, '0')}`
    const packed = packBinaryMask(mask, input.width, input.height)
    proposals.push({ id, mask: Buffer.from(packed.data).toString('base64'), qualityScore })
  }
  return proposals
}
