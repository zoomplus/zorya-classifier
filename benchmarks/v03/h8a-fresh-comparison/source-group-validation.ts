import { hashIdentity } from './hash-identity.js'
import type { H8aFreshPhaseId, H8aFreshStratum } from './constants.js'

interface SourceGroupSplitCommitments {
  devSourceGroupIds: readonly string[]
  qualificationSourceGroupIds: readonly string[]
  exclusionSourceGroupIds?: readonly string[]
}

export function computeSourceGroupStratumCommitmentSha256(
  phaseId: H8aFreshPhaseId,
  stratum: H8aFreshStratum,
  sourceGroupIds: readonly string[],
): string {
  return hashIdentity({ phaseId, stratum, sourceGroupIds })
}

function setsIntersect(a: readonly string[], b: readonly string[]): string[] {
  const lookup = new Set(a)
  const overlap: string[] = []
  for (const item of b) {
    if (lookup.has(item)) overlap.push(item)
  }
  return overlap
}

/** Repeated source groups within one split are valid; overlap across splits is not. */
export function validateSourceGroupSplitSeparation(commitments: SourceGroupSplitCommitments): void {
  const devQualOverlap = setsIntersect(
    commitments.devSourceGroupIds,
    commitments.qualificationSourceGroupIds,
  )
  if (devQualOverlap.length > 0)
    throw new RangeError('DEV and qualification source groups must not overlap')

  const exclusion = commitments.exclusionSourceGroupIds ?? []
  const devExclusionOverlap = setsIntersect(commitments.devSourceGroupIds, exclusion)
  if (devExclusionOverlap.length > 0)
    throw new RangeError('DEV and exclusion source groups must not overlap')
  const qualExclusionOverlap = setsIntersect(commitments.qualificationSourceGroupIds, exclusion)
  if (qualExclusionOverlap.length > 0)
    throw new RangeError('Qualification and exclusion source groups must not overlap')
}
