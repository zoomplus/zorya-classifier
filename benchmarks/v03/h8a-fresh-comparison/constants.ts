export const H8A_FRESH_SCHEMA = 'h8a-fresh-comparison-v1' as const

export const PHASE_DEV40_ID = 'h8a-fresh-paired-dev40-v1' as const
export const PHASE_QUAL120_ID = 'h8a-fresh-paired-qual120-v1' as const
export const PHASE_FLAT_DEV40_ID = 'h8a-flat-paired-dev40-v1' as const
export const PHASE_FLAT_QUAL120_ID = 'h8a-flat-paired-qual120-v1' as const
export const PHASE_SCOPE_DEV40_ID = 'h8a-scope-paired-dev40-v1' as const
export const PHASE_SCOPE_QUAL120_ID = 'h8a-scope-paired-qual120-v1' as const

export const PROFILE_CANDIDATE_ID = 'h8a-cpu-raw-target-v1' as const
export const PROFILE_FLAT_CANDIDATE_ID = 'h8a-cpu-flat-target-v2' as const
export const PROFILE_SCOPE_CANDIDATE_ID = 'h8a-cpu-flat-scope-v3' as const
export const PROFILE_CONTROL_ID = 'v02-final-v3-fresh-cohort-replay-v1' as const

export type H8aFreshCandidateId =
  | typeof PROFILE_CANDIDATE_ID
  | typeof PROFILE_FLAT_CANDIDATE_ID
  | typeof PROFILE_SCOPE_CANDIDATE_ID
export type H8aFreshPhaseId =
  | typeof PHASE_DEV40_ID
  | typeof PHASE_QUAL120_ID
  | typeof PHASE_FLAT_DEV40_ID
  | typeof PHASE_FLAT_QUAL120_ID
  | typeof PHASE_SCOPE_DEV40_ID
  | typeof PHASE_SCOPE_QUAL120_ID

export function candidateIdForPhase(phaseId: H8aFreshPhaseId): H8aFreshCandidateId {
  switch (phaseId) {
    case PHASE_DEV40_ID:
    case PHASE_QUAL120_ID:
      return PROFILE_CANDIDATE_ID
    case PHASE_FLAT_DEV40_ID:
    case PHASE_FLAT_QUAL120_ID:
      return PROFILE_FLAT_CANDIDATE_ID
    case PHASE_SCOPE_DEV40_ID:
    case PHASE_SCOPE_QUAL120_ID:
      return PROFILE_SCOPE_CANDIDATE_ID
    default:
      throw new RangeError('Unknown H8 fresh phase identity')
  }
}

export function isDevPhase(phaseId: H8aFreshPhaseId): boolean {
  switch (phaseId) {
    case PHASE_DEV40_ID:
    case PHASE_FLAT_DEV40_ID:
    case PHASE_SCOPE_DEV40_ID:
      return true
    case PHASE_QUAL120_ID:
    case PHASE_FLAT_QUAL120_ID:
    case PHASE_SCOPE_QUAL120_ID:
      return false
    default:
      throw new RangeError('Unknown H8 fresh phase identity')
  }
}

export function isQualificationPhase(phaseId: H8aFreshPhaseId): boolean {
  switch (phaseId) {
    case PHASE_QUAL120_ID:
    case PHASE_FLAT_QUAL120_ID:
    case PHASE_SCOPE_QUAL120_ID:
      return true
    case PHASE_DEV40_ID:
    case PHASE_FLAT_DEV40_ID:
    case PHASE_SCOPE_DEV40_ID:
      return false
    default:
      throw new RangeError('Unknown H8 fresh phase identity')
  }
}

export const DEV40_CASE_COUNT = 40 as const
export const DEV40_POSITIVE_COUNT = 30 as const
export const DEV40_NEGATIVE_COUNT = 10 as const

export const DEV40_STRATUM_QUOTAS = {
  photo: { present: 16, absent: 4, total: 20 },
  ui: { present: 7, absent: 3, total: 10 },
  map: { present: 7, absent: 3, total: 10 },
} as const

export const QUAL120_CASE_COUNT = 120 as const
export const QUAL120_POSITIVE_COUNT = 90 as const
export const QUAL120_NEGATIVE_COUNT = 30 as const
export const QUAL120_STRATUM_COUNT = 30 as const

export const CAMPAIGN_MAX_PHYSICAL_CALLS = 2_000 as const
export const CAMPAIGN_MAX_COST_USD = 10 as const

export const DEV40_WORST_CASE_PHYSICAL_CALLS = 400 as const
export const QUAL120_WORST_CASE_PHYSICAL_CALLS = 1_200 as const

export const BOOTSTRAP_REPLICATES = 10_000 as const
export const BOOTSTRAP_SEED = 0x5633_4551 as const

export const EVALUATOR_VERSION = 'h8a-fresh-evaluator-v1' as const

export const STRATUMS = ['photo', 'ui', 'map'] as const
export type H8aFreshStratum = (typeof STRATUMS)[number]
