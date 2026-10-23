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
  /** @experimental Optional legacy region refinement; unqualified for general use. */
  refinement?: RefinementPort
  /** Caller-owned; classifier disposal never disposes a shared segmenter. @experimental Unqualified segmentation adapter. */
  segmentation?: SegmentationPort
  /** Optional caller-owned containment checker; by default reuses the injected decision port. @experimental Unqualified box-check override. */
  segmentationBoxCheck?: SegmentationBoxCheckPort
  /** Explicit, caller-owned pixel-mask proposal strategy for whole-object operations. @experimental Unqualified proposal path. */
  objectProposals?: ObjectProposalPort
}
export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassificationResult>
  /** @experimental Unqualified spatial localization; see {@link LocateInput} and {@link WholeObjectLocateInput}. */
  locate(input: WholeObjectLocateInput): Promise<WholeObjectLocalizationResult>
  /** @experimental Unqualified coarse region search; returns a hypothesized grid cell. */
  locate(input: LocateInput): Promise<LocalizationResult>
  /** @experimental Unqualified spatial localization. */
  locate(input: AnyLocateInput): Promise<LocalizationResult | WholeObjectLocalizationResult>
  /** @experimental Region-seeded extraction; unqualified for general mask or object accuracy. */
  extract(input: ExtractInput): Promise<ExtractionResult>
  dispose(): Promise<void>
}
