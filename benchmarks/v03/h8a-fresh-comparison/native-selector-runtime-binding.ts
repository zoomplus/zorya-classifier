import { PROFILE_FLAT_CANDIDATE_ID, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID } from './constants.js'

export const NATIVE_SELECTOR_RUNTIME_BINDING = Object.freeze({
  candidateProfileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
  recipeId: PROFILE_FLAT_CANDIDATE_ID,
  queryPolicyId: 'strict-authored-scope-v1',
  presencePolicyId: 'control-binary-v1',
  selectionPolicyId: 'native-categorical-all-stages-v1',
} as const)

/** Maps the closed replay binding to the root factory options used by the real CLI. */
export function nativeSelectorRuntimeFactoryOptions() {
  return {
    candidateProfileId: NATIVE_SELECTOR_RUNTIME_BINDING.candidateProfileId,
    selectionPolicyId: NATIVE_SELECTOR_RUNTIME_BINDING.selectionPolicyId,
    nativeRuntime: {
      recipeId: NATIVE_SELECTOR_RUNTIME_BINDING.recipeId,
      queryPolicyId: NATIVE_SELECTOR_RUNTIME_BINDING.queryPolicyId,
      presencePolicyId: NATIVE_SELECTOR_RUNTIME_BINDING.presencePolicyId,
    },
  } as const
}
