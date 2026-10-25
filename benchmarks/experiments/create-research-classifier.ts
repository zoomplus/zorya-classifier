import { composeClassifier } from '../../src/app/create-classifier.js'
import type { BoundaryViewPort } from '../../src/entities/boundary-view.js'
import type { ImageRepresentationPort } from '../../src/entities/representation.js'
import type { WholeObjectIntervalPolicy } from '../../src/processes/whole-object.js'
import type { ClassifierOptions } from '../../src/app/classifier-contracts.js'
import {
  acceptsResearchTextRepresentation,
  createValidatedExperimentalTextPort,
  type ResearchClassifier,
  type ResearchRepresentation,
} from './research-representation-contract.js'

/** Benchmark-only classifier composition with optional research codecs and boundary views. */
export function createResearchClassifier(
  options: ClassifierOptions,
  experimental?: ImageRepresentationPort,
  boundaryView?: BoundaryViewPort,
  intervalPolicy?: WholeObjectIntervalPolicy,
): ResearchClassifier {
  const representationPort =
    experimental === undefined ? undefined : createValidatedExperimentalTextPort(experimental)
  const research =
    representationPort === undefined
      ? undefined
      : { representationPort, acceptsRepresentation: acceptsResearchTextRepresentation }
  return composeClassifier<ResearchRepresentation>(options, research, boundaryView, intervalPolicy)
}
