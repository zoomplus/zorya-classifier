import type {
  ClassificationResult,
  ClassifyInput,
  LocalizationResult,
  LocateInput,
  Representation,
} from '../entities/contracts.js'
import type { ExtractInput, ExtractionResult } from '../entities/segmentation.js'
import type {
  AnyLocateInput,
  WholeObjectLocateInput,
  WholeObjectLocalizationResult,
} from '../entities/whole-object.js'

export type WithRepresentationField<T extends { representation?: unknown }, R> = Omit<
  T,
  'representation'
> & { representation?: R | undefined }

/** Internal composition surface; not exported from the public package entry. */
export type ComposedClassifier<R = Representation> = {
  classify(input: WithRepresentationField<ClassifyInput, R>): Promise<ClassificationResult>
  locate(
    input: WithRepresentationField<WholeObjectLocateInput, R>,
  ): Promise<WholeObjectLocalizationResult>
  locate(input: WithRepresentationField<LocateInput, R>): Promise<LocalizationResult>
  locate(
    input: WithRepresentationField<AnyLocateInput, R>,
  ): Promise<LocalizationResult | WholeObjectLocalizationResult>
  extract(input: WithRepresentationField<ExtractInput, R>): Promise<ExtractionResult>
  dispose(): Promise<void>
}
