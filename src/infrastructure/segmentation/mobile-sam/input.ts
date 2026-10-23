import { ClassifierError } from '../../../entities/errors.js'
import type { BinaryMask, SegmentationInput } from '../../../entities/segmentation.js'
import type { ObjectProposalInput } from '../../../entities/object-proposals.js'
import { objectProposalLimits } from '../../../entities/object-proposals.js'
import { limits, pixelRectSchema } from '../../../entities/contracts.js'
import { validateMobileSamPreviousMask } from './segmentation-masks.js'

export function snapshotInput(input: SegmentationInput) {
  const image = input.image
  const pixels = image.width * image.height
  const prompt = input.prompt ?? 'whole-region'
  if (
    image.format !== 'rgba8' ||
    !(image.data instanceof Uint8Array) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    !Number.isSafeInteger(pixels) ||
    image.width < 1 ||
    image.height < 1 ||
    pixels > limits.imagePixels ||
    image.data.length !== pixels * 4
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Segmentation requires canonical RGBA8 within the image pixel limit',
    )
  if (
    (prompt !== 'whole-region' && prompt !== 'seed-region') ||
    !pixelRectSchema.safeParse(input.seedRegion).success ||
    !pixelRectSchema.safeParse(input.wholeRegion).success ||
    !pixelRectSchema.safeParse(input.roi).success
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Segmentation regions must be positive integer rectangles',
    )
  for (const region of [input.seedRegion, input.wholeRegion, input.roi])
    if (region.left + region.width > image.width || region.top + region.height > image.height)
      throw new ClassifierError(
        'INVALID_INPUT',
        'Segmentation region lies outside the source image',
      )
  return {
    data: new Uint8Array(image.data),
    width: image.width,
    height: image.height,
    seedRegion: { ...input.seedRegion },
    wholeRegion: { ...input.wholeRegion },
    roi: { ...input.roi },
    prompt,
  }
}

export function snapshotPreviousMask(
  input: SegmentationInput,
  previousMask: BinaryMask,
  image: ReturnType<typeof snapshotInput>,
) {
  if (
    !previousMask ||
    previousMask.format !== 'binary-u8' ||
    !(previousMask.data instanceof Uint8Array) ||
    previousMask.width !== image.width ||
    previousMask.height !== image.height ||
    previousMask.data.length !== image.width * image.height
  )
    throw new ClassifierError('INVALID_INPUT', 'Expansion requires a full-source binary mask')
  try {
    validateMobileSamPreviousMask({
      width: image.width,
      height: image.height,
      rgba: image.data,
      previousMask: previousMask.data,
      roi: image.roi,
    })
  } catch {
    throw new ClassifierError(
      'INVALID_INPUT',
      'Expansion mask must be nonempty binary foreground inside visible ROI pixels',
    )
  }
  return new Uint8Array(previousMask.data)
}

export function snapshotProposalInput(input: ObjectProposalInput) {
  const { image } = input
  const pixels = image.width * image.height
  if (pixels > objectProposalLimits.imagePixels)
    throw new ClassifierError('RESOURCE_LIMIT', 'Proposal image exceeds the two-megapixel limit')
  if (
    image.format !== 'rgba8' ||
    !(image.data instanceof Uint8Array) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    !Number.isSafeInteger(pixels) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.length !== pixels * 4
  )
    throw new ClassifierError('INVALID_INPUT', 'Proposals require canonical RGBA8 pixels')
  for (const region of [input.seedRegion, input.roi])
    if (
      !pixelRectSchema.safeParse(region).success ||
      region.left + region.width > image.width ||
      region.top + region.height > image.height
    )
      throw new ClassifierError('INVALID_INPUT', 'Proposal region lies outside the source image')
  return {
    image: { data: new Uint8Array(image.data), width: image.width, height: image.height },
    seedRegion: { ...input.seedRegion },
    roi: { ...input.roi },
  }
}
