import { hashIdentity } from './hash-identity.js'
import {
  PROFILE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
} from './constants.js'
import { H6_QUERY_POLICY_SHA256 } from '../h6-query-policy.js'
import { H6_PRESENCE_POLICY_SHA256 } from '../h6-presence-policy.js'

const H8A_SCOPE_QUERY_POLICY_SHA256 =
  '8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc'
const H8A_BINARY_PRESENCE_POLICY_SHA256 =
  '0a59411c518355279f60dba58f3d26b7910b81ad88cd3238f91214654a8c4fac'
if (H6_QUERY_POLICY_SHA256 !== H8A_SCOPE_QUERY_POLICY_SHA256)
  throw new RangeError('Authored-scope query policy identity differs from the frozen profile')
if (H6_PRESENCE_POLICY_SHA256 !== H8A_BINARY_PRESENCE_POLICY_SHA256)
  throw new RangeError('Binary presence policy identity differs from the frozen profile')

export type H8aFreshProfileId =
  | typeof PROFILE_CANDIDATE_ID
  | typeof PROFILE_FLAT_CANDIDATE_ID
  | typeof PROFILE_SCOPE_CANDIDATE_ID
  | typeof PROFILE_NATIVE_PRESENCE_CANDIDATE_ID
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

const h8aScopeCandidateRequestPolicy = Object.freeze({
  allowFallbacks: false,
  allowProviderSort: false,
  allowRetries: false,
  caseDeadlineSeconds: 240,
  maxVisionChatPhysicalCallsPerCase: 4,
  reasoning: 'medium' as const,
  route: Object.freeze({
    apiKind: 'openai-compatible-vision-chat' as const,
    apiEndpoint: '/api/v1/chat/completions' as const,
    maxOutputTokens: 4096,
    model: 'openai/gpt-6-luna',
    provider: 'openai' as const,
    providerName: 'OpenAI',
  }),
  nativeRecipeId: PROFILE_FLAT_CANDIDATE_ID,
  queryPolicyId: 'strict-authored-scope-v1' as const,
  queryPolicySha256: H8A_SCOPE_QUERY_POLICY_SHA256,
})

export const H8A_SCOPE_CANDIDATE_PROFILE = Object.freeze({
  profileId: PROFILE_SCOPE_CANDIDATE_ID,
  recipeKind: 'h8a-cpu-flat-scope-then-h6-composer' as const,
  requestPolicy: h8aScopeCandidateRequestPolicy,
  requestPolicyIdentitySha256: hashIdentity(h8aScopeCandidateRequestPolicy),
})

const h8aNativePresenceCandidateRequestPolicy = Object.freeze({
  allowFallbacks: false,
  allowProviderSort: false,
  allowRetries: false,
  caseDeadlineSeconds: 240,
  maxVisionChatPhysicalCallsPerCase: 3,
  maxNativePresencePhysicalCallsPerCase: 1,
  maxPhysicalCallsPerCase: 4,
  reasoning: 'medium' as const,
  route: H8A_SCOPE_CANDIDATE_PROFILE.requestPolicy.route,
  nativePresenceRoute: Object.freeze({
    apiKind: 'openai-compatible-native-decisions' as const,
    apiEndpoint: '/api/alpha/decisions' as const,
    model: 'openai/gpt-6-luna-decisions' as const,
    provider: 'openai' as const,
    providerName: 'OpenAI' as const,
    maxPhysicalCallsPerCase: 1,
  }),
  nativeRecipeId: PROFILE_FLAT_CANDIDATE_ID,
  presencePolicyId: 'control-binary-v1' as const,
  presencePolicySha256: H8A_BINARY_PRESENCE_POLICY_SHA256,
  queryPolicyId: 'strict-authored-scope-v1' as const,
  queryPolicySha256: H8A_SCOPE_QUERY_POLICY_SHA256,
})

export const H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE = Object.freeze({
  profileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
  recipeKind: 'h8a-cpu-flat-native-presence-then-h6-composer' as const,
  requestPolicy: h8aNativePresenceCandidateRequestPolicy,
  requestPolicyIdentitySha256: hashIdentity(h8aNativePresenceCandidateRequestPolicy),
})

export const V02_CONTROL_PROFILE = {
  profileId: PROFILE_CONTROL_ID,
  recipeKind: 'v02-final-v3-fresh-cohort-replay' as const,
  requestPolicy: v02ControlRequestPolicy,
  requestPolicyIdentitySha256: hashIdentity(v02ControlRequestPolicy),
}

export function profileById(profileId: H8aFreshProfileId) {
  if (profileId === PROFILE_CANDIDATE_ID) return H8A_CANDIDATE_PROFILE
  if (profileId === PROFILE_FLAT_CANDIDATE_ID) return H8A_FLAT_CANDIDATE_PROFILE
  if (profileId === PROFILE_SCOPE_CANDIDATE_ID) return H8A_SCOPE_CANDIDATE_PROFILE
  if (profileId === PROFILE_NATIVE_PRESENCE_CANDIDATE_ID)
    return H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE
  if (profileId === PROFILE_CONTROL_ID) return V02_CONTROL_PROFILE
  throw new RangeError('Unknown profile identity')
}

export function assertIndependentProfilePolicies(): void {
  if (
    [
      H8A_CANDIDATE_PROFILE,
      H8A_FLAT_CANDIDATE_PROFILE,
      H8A_SCOPE_CANDIDATE_PROFILE,
      H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE,
    ].some(
      (candidate) =>
        candidate.requestPolicyIdentitySha256 === V02_CONTROL_PROFILE.requestPolicyIdentitySha256,
    )
  )
    throw new RangeError('Candidate and control request policies must remain distinct')
}
