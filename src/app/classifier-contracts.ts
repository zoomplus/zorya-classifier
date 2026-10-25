import type {
  ClassificationResult,
  ClassifyInput,
  DecisionPort,
  LocalizationResult,
  LocateInput,
  RefinementPort,
} from '../entities/contracts.js'
import type { ExtractInput, ExtractionResult, SegmentationPort } from '../entities/segmentation.js'
import type { ObjectProposalPort } from '../entities/object-proposals.js'
import type { SegmentationBoxCheckPort } from '../entities/segmentation-verification.js'
import type {
  AnyLocateInput,
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'

export interface ClassifierOptions {
  decision: DecisionPort
  timeoutMs?: number
  concurrency?: number
  maxQueue?: number
  maxInputBytes?: number
  /** Optional legacy region refinement. */
  refinement?: RefinementPort
  /** Caller-owned; classifier disposal never disposes a shared segmenter. Segmentation adapter; structural checks do not establish semantic mask quality. */
  segmentation?: SegmentationPort
  /** Optional caller-owned containment checker; by default reuses the injected decision port. Box-check override; verdicts are not universal spatial guarantees. */
  segmentationBoxCheck?: SegmentationBoxCheckPort
  /** Explicit, caller-owned pixel-mask proposal strategy for whole-object operations. */
  objectProposals?: ObjectProposalPort
}
export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassificationResult>
  /** Spatial localization; see {@link LocateInput} and {@link WholeObjectLocateInput}. */
  locate(input: WholeObjectLocateInput): Promise<WholeObjectLocalizationResult>
  /** Coarse region search; returns a hypothesized grid cell, not whole-object geometry. */
  locate(input: LocateInput): Promise<LocalizationResult>
  /** Spatial localization. */
  locate(input: AnyLocateInput): Promise<LocalizationResult | WholeObjectLocalizationResult>
  /** Region-seeded extraction; mask and box checks measure different things than semantic object accuracy. */
  extract(input: ExtractInput): Promise<ExtractionResult>
  dispose(): Promise<void>
}
