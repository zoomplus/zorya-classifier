import { hashIdentity } from './hash-identity.js'
import type { EvaluatorPrivateAnnotationBundle } from './schemas.js'

export function computeEvaluatorAnnotationsSha256(
  bundle: EvaluatorPrivateAnnotationBundle,
): string {
  return hashIdentity({
    schema: bundle.schema,
    phaseId: bundle.phaseId,
    freezeId: bundle.freezeId,
    independentMaskCaseIds: bundle.independentMaskCaseIds,
    cases: bundle.cases,
    qualificationSourceGroupsDistinct: bundle.qualificationSourceGroupsDistinct ?? null,
  })
}
