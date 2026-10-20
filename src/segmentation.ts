/** Optional native adapters are composed here; importing types never starts native work. */
export type {
  BinaryMask,
  SegmentationInput,
  SegmentationMetadata,
  SegmentationResult,
  SegmentationPort,
  ExtractionResult,
} from './entities/segmentation.js'
export { createMobileSamSegmenter } from './infrastructure/segmentation/mobile-sam/index.js'
export type { MobileSamSegmenterOptions } from './infrastructure/segmentation/mobile-sam/index.js'
export { createMobileSamObjectProposals } from './infrastructure/segmentation/mobile-sam/index.js'
export type { MobileSamObjectProposalsOptions } from './infrastructure/segmentation/mobile-sam/index.js'
export type {
  PackedBinaryMask,
  ObjectProposal,
  ObjectProposalInput,
  ObjectProposalBatch,
  ObjectProposalPort,
} from './entities/object-proposals.js'
export { packBinaryMask, unpackBinaryMask } from './features/segmentation/packed-mask.js'
export { createGrabCutSegmenter } from './infrastructure/segmentation/grabcut/index.js'
export type { GrabCutSegmenterOptions } from './infrastructure/segmentation/grabcut/index.js'
