import type { Classifier, ClassifierOptions } from '../../src/app/classifier-contracts.js'
import { composeClassifier } from '../../src/app/create-classifier.js'
import type { BoundaryViewPort } from '../../src/entities/boundary-view.js'
import type { ImageRepresentationPort } from '../../src/entities/representation.js'
import type { WholeObjectIntervalPolicy } from '../../src/processes/whole-object.js'

/** Benchmark-only classifier composition with optional research codecs and boundary views. */
export function createResearchClassifier(
  options: ClassifierOptions,
  experimental?: ImageRepresentationPort,
  boundaryView?: BoundaryViewPort,
  intervalPolicy?: WholeObjectIntervalPolicy,
): Classifier {
  return composeClassifier(options, experimental, boundaryView, intervalPolicy)
}
