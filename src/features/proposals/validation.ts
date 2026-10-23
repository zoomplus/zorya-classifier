import { z } from 'zod'

import type { PixelRect, RasterImage } from '../../entities/contracts.js'
import { limits, parse } from '../../entities/contracts.js'
import { segmentationMetadataSafeSchema } from '../../entities/segmentation-metadata.js'
import { ClassifierError } from '../../entities/errors.js'
import { objectProposalLimits } from '../../entities/object-proposals.js'
import type { RgbaRaster } from '../../entities/representation.js'
import type { SegmentationMetadata } from '../../entities/segmentation.js'
import { unpackBinaryMask } from '../segmentation/packed-mask.js'

const rgbaSchema = z
  .object({
    data: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    width: z.number().int().positive().safe(),
    height: z.number().int().positive().safe(),
    format: z.literal('rgba8'),
  })
  .strict()
const packedMaskSchema = z
  .object({
    data: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    width: z.number().int().positive().safe(),
    height: z.number().int().positive().safe(),
    format: z.literal('binary-lsb0'),
  })
  .strict()
const proposalSchema = z
  .object({
    id: z.string().regex(/^C(?:0[0-9]|[12][0-9]|3[0-5])$/),
    mask: packedMaskSchema,
    qualityScore: z.number().finite().optional(),
  })
  .strict()
const batchSchema = z
  .object({
    proposals: z.array(proposalSchema).max(objectProposalLimits.candidates),
    metadata: segmentationMetadataSafeSchema,
  })
  .strict()

export function validateSource(image: RasterImage): RasterImage {
  if (
    !(image.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > limits.imagePixels ||
    image.bytes.byteLength < 1 ||
    image.bytes.byteLength > limits.imageBytes
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Raster normalizer returned invalid source data')
  return { bytes: new Uint8Array(image.bytes), width: image.width, height: image.height }
}

export function validateRgba(value: unknown, width: number, height: number): RgbaRaster {
  const raster = parse(rgbaSchema, value, 'INVALID_RESPONSE')
  if (
    raster.width !== width ||
    raster.height !== height ||
    width * height > objectProposalLimits.imagePixels ||
    raster.data.byteLength !== width * height * 4
  )
    throw new ClassifierError('INVALID_RESPONSE', 'RGBA snapshot has invalid dimensions or bytes')
  return { ...raster, data: new Uint8Array(raster.data) }
}

export function validateRectInImage(
  rect: PixelRect,
  image: { width: number; height: number },
  name: string,
): void {
  if (rect.left + rect.width > image.width || rect.top + rect.height > image.height)
    throw new ClassifierError('INVALID_INPUT', `${name} lies outside the oriented source image`)
}

export function deriveMaskAndRegion(
  pixels: Uint8Array,
  source: RgbaRaster,
  roi: PixelRect,
  seed: PixelRect,
): {
  data: Uint8Array
  region: PixelRect | null
  intersectsSeed: boolean
  touchesRoi: boolean
} {
  const { width, height } = source
  const data = new Uint8Array(width * height)
  let left = width,
    top = height,
    right = -1,
    bottom = -1,
    intersectsSeed = false,
    touchesRoi = false
  const roiRight = roi.left + roi.width
  const roiBottom = roi.top + roi.height
  for (let index = 0; index < pixels.length; index += 1) {
    if (!pixels[index]) continue
    const x = index % width
    const y = Math.floor(index / width)
    if (x < roi.left || x >= roiRight || y < roi.top || y >= roiBottom)
      throw new ClassifierError(
        'INVALID_RESPONSE',
        'Packed proposal contains pixels outside hard ROI',
      )
    if (source.data[index * 4 + 3] === 0) continue
    data[index] = 1
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
    if (x >= seed.left && x < seed.left + seed.width && y >= seed.top && y < seed.top + seed.height)
      intersectsSeed = true
    if (x === roi.left || x === roiRight - 1 || y === roi.top || y === roiBottom - 1)
      touchesRoi = true
  }
  if (right < left || bottom < top)
    return { data, region: null, intersectsSeed: false, touchesRoi: false }
  const region = { left, top, width: right - left + 1, height: bottom - top + 1 }
  return { data, region, intersectsSeed, touchesRoi }
}

export function validateProposalBatch(
  value: unknown,
  image: RgbaRaster,
): {
  proposals: ReturnType<typeof batchSchema.parse>['proposals']
  metadata: SegmentationMetadata
} {
  const batch = parse(batchSchema, value, 'INVALID_RESPONSE')
  if (batch.metadata.input.width !== image.width || batch.metadata.input.height !== image.height)
    throw new ClassifierError('INVALID_RESPONSE', 'Proposal metadata source dimensions mismatch')
  let totalBytes = 0
  const proposals: ReturnType<typeof batchSchema.parse>['proposals'][number][] = []
  for (const [index, proposal] of batch.proposals.entries()) {
    const expectedId = `C${String(index).padStart(2, '0')}`
    const { mask } = proposal
    const expectedBytes = Math.ceil((image.width * image.height) / 8)
    if (
      proposal.id !== expectedId ||
      mask.width !== image.width ||
      mask.height !== image.height ||
      mask.data.byteLength !== expectedBytes
    )
      throw new ClassifierError('INVALID_RESPONSE', 'Packed proposals must be ordered source masks')
    totalBytes += mask.data.byteLength
    if (totalBytes > objectProposalLimits.packedBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'Packed proposal batch exceeds its byte budget')
    const ownedMask = { ...mask, data: new Uint8Array(mask.data) }
    unpackBinaryMask(ownedMask)
    proposals.push({ ...proposal, mask: ownedMask })
  }
  return {
    proposals,
    metadata: {
      method: batch.metadata.method,
      backend: batch.metadata.backend,
      durationMs: batch.metadata.durationMs,
      input: { ...batch.metadata.input },
      ...(batch.metadata.qualityScore === undefined
        ? {}
        : { qualityScore: batch.metadata.qualityScore }),
    },
  }
}
