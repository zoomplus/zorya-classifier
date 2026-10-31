import { hashIdentity } from './hash-identity.js'
import { phaseFreezeSchema, type PhaseFreeze } from './schemas.js'

export function computePhaseFreezeCommitmentSha256(freeze: PhaseFreeze): string {
  return hashIdentity(phaseFreezeSchema.parse(freeze))
}
