import { hashIdentity } from './hash-identity.js'
import { PROFILE_CANDIDATE_ID, PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'

export type H8aFreshProfileId =
  | typeof PROFILE_CANDIDATE_ID
  | typeof PROFILE_FLAT_CANDIDATE_ID
  | typeof PROFILE_CONTROL_ID

const h8aCandidateRequestPolicy = {
  allowFallbacks: false,
  allowProviderSort: false,
  allowRetries: false,
  caseDeadlineSeconds: 240,
  maxVisionChatPhysicalCallsPerCase: 4,
  reasoning: 'medium' as const,
  route: {
    apiKind: 'openai-compatible-vision-chat' as const,
    apiEndpoint: '/api/v1/chat/completions' as const,
    maxOutputTokens: 4096,
    model: 'openai/gpt-6-luna',
    provider: 'openai' as const,
    providerName: 'OpenAI',
  },
}

const v02ControlRequestPolicy = {
  allowFallbacks: false,
  apiEndpoint: '/api/alpha/decisions' as const,
  boxCheckPassesMaximum: 2,
  caseDeadlineSeconds: 120,
  maxPhysicalCallsPerCase: 6,
  model: 'openai/gpt-6-luna-decisions' as const,
  provider: 'openai' as const,
  providerName: 'OpenAI' as const,
  mobileSamCpuThreads: 2,
  nativeDecisionRoute: 'openai-alpha-decisions' as const,
  nativeModelConcurrency: {
    maxPending: 2,
    workers: 1,
  },
  presenceCheckBeforeRegionSearch: true,
  regionSearchPasses: 3,
  sourceClosureSha256: 'be43090b13951e9a6ffa65daffb9413a6a539d8dae335925dc885733a467fb20',
  snapshotReceiptSha256: '0422a3e62925bb33f4fe41480d6554887ae9c888681125f8b8522d9174361f71',
}

export const H8A_CANDIDATE_PROFILE = {
  profileId: PROFILE_CANDIDATE_ID,
  recipeKind: 'h8a-cpu-then-h6-composer' as const,
  requestPolicy: h8aCandidateRequestPolicy,
  requestPolicyIdentitySha256: hashIdentity(h8aCandidateRequestPolicy),
}

export const H8A_FLAT_CANDIDATE_PROFILE = {
  profileId: PROFILE_FLAT_CANDIDATE_ID,
  recipeKind: 'h8a-cpu-flat-target-then-h6-composer' as const,
  requestPolicy: { ...h8aCandidateRequestPolicy },
  requestPolicyIdentitySha256: hashIdentity(h8aCandidateRequestPolicy),
}

export const V02_CONTROL_PROFILE = {
  profileId: PROFILE_CONTROL_ID,
  recipeKind: 'v02-final-v3-fresh-cohort-replay' as const,
  requestPolicy: v02ControlRequestPolicy,
  requestPolicyIdentitySha256: hashIdentity(v02ControlRequestPolicy),
}

export function profileById(profileId: H8aFreshProfileId) {
  if (profileId === PROFILE_CANDIDATE_ID) return H8A_CANDIDATE_PROFILE
  if (profileId === PROFILE_FLAT_CANDIDATE_ID) return H8A_FLAT_CANDIDATE_PROFILE
  return V02_CONTROL_PROFILE
}

export function assertIndependentProfilePolicies(): void {
  if (
    H8A_CANDIDATE_PROFILE.requestPolicyIdentitySha256 ===
    V02_CONTROL_PROFILE.requestPolicyIdentitySha256
  )
    throw new RangeError('Candidate and control request policies must remain distinct')
}
