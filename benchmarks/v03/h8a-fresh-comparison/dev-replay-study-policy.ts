import {
  PROFILE_CONTROL_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
} from './constants.js'
import {
  PHASE_SCOPE_DEV40_ID,
  PHASE_NATIVE_PRESENCE_DEV40_ID,
  PHASE_NATIVE_SELECTOR_DEV40_ID,
} from './constants.js'

export const LEGACY_REPLAY_STUDY_ID = 'provider-refusal-dev40-replay-v1' as const
export const LEGACY_REPLAY_FREEZE_ID = 'h8a-provider-refusal-dev40-replay-20261101-v1' as const
export const LEGACY_REPLAY_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1' as const

export const AUTHORED_SCOPE_STUDY_ID = 'authored-scope-dev40-v1' as const
export const AUTHORED_SCOPE_FREEZE_ID = 'h8a-authored-scope-dev40-20261101-v1' as const
export const AUTHORED_SCOPE_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/authored-scope-dev40-v1' as const
export const AUTHORED_SCOPE_QUERY_POLICY = Object.freeze({
  policyId: 'strict-authored-scope-v1',
  sha256: '8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc',
  hypothesisSha256: 'dac1bf0eeecfaa204a70e3a89d5e16d7c64ced576a972923a3a1665287426ab2',
})
export const NATIVE_PRESENCE_STUDY_ID = 'native-presence-flat-dev40-v1' as const
export const NATIVE_PRESENCE_FREEZE_ID = 'h8a-native-presence-flat-dev40-20261101-v1' as const
export const NATIVE_PRESENCE_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/native-presence-flat-dev40-v1' as const
export const NATIVE_PRESENCE_POLICY = Object.freeze({
  policyId: 'control-binary-v1',
  sha256: '0a59411c518355279f60dba58f3d26b7910b81ad88cd3238f91214654a8c4fac',
  hypothesisSha256: 'f7a44466f985fa1c53eb57c93fe6dcaf44548ee2da72c9e2f8e9f8285ecb14f5',
})
export const NATIVE_SELECTOR_STUDY_ID = 'native-selector-flat-dev40-v1' as const
export const NATIVE_SELECTOR_FREEZE_ID = 'h8a-native-selector-flat-dev40-20261101-v1' as const
export const NATIVE_SELECTOR_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/native-selector-flat-dev40-v1' as const
export const NATIVE_SELECTOR_PARENT_AUDIT_PATH =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/native-selector-research-v1/prospective-parent-audit-v1.json' as const
export const NATIVE_SELECTOR_PARENT_AUDIT_SHA256 =
  'a4ec08fd76c065f8f6698e45b5b067ae1f6c5d60b5912edc580990fa15181600' as const
export const NATIVE_SELECTOR_POLICY = Object.freeze({
  policyId: 'native-categorical-all-stages-v1',
  sha256: '67593b86c44a23231a191b04b2b453d608a2a79161080de7594050d1b4c7b4e0',
  hypothesisSha256: '6ea930d091365eec2f073bfc024d85546d436135d19cd98ac92af631e5a751b8',
})
export const NATIVE_SELECTOR_PRICE_PROOF = Object.freeze({
  path: '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/native-selector-research-v1/native-route-cost-proof-v1.json',
  sha256: '433b8c9f8d91c3b52fd2cb08ceb6443a612124349aa3ea6425463e41002e1b4d',
  catalogPath:
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/native-selector-research-v1/native-route-catalog-v1.json',
  catalogSha256: '22c20d0d49d68ca4558de06956825973f6075cea44c04bfc6ffb4c0b75877974',
})

export const REPLAY_STUDY_REGISTRY = Object.freeze({
  [LEGACY_REPLAY_STUDY_ID]: Object.freeze({
    studyId: LEGACY_REPLAY_STUDY_ID,
    freezeId: LEGACY_REPLAY_FREEZE_ID,
    canonicalRoot: LEGACY_REPLAY_ROOT,
    candidateProfileId: PROFILE_FLAT_CANDIDATE_ID,
    controlProfileId: PROFILE_CONTROL_ID,
    inheritedPhysicalCalls: 202,
    inheritedLogicalAttempts: 63,
    inheritedKnownCostUsd: 0.11840506499999993,
    inheritedUnknownReserveUsd: 0.24,
    nextPhysicalId: 203,
    nextReservationId: 203,
    candidateCallsPerCase: 4,
    controlCallsPerCase: 6,
    candidateUsdPerDispatch: 0.55,
    controlUsdPerDispatch: 0.12,
    incrementalCallLimit: 400,
    incrementalExposureUsd: 116.8,
    parentAuditPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/refusal-policy/admission-parent-audit-v1.json',
    parentAuditSha256: '5e7f8db8bbdd59c39d04bd78536fead6dd269568f5816872e0cbfef48e18736a',
    parentLedgerPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/campaign-ledger.json',
    parentLedgerSha256: 'b3c2348e09d8459ebc8b6935b03753c6b1082ce1f0f6584656bd8f39c4ca727b',
    parentLedgerVersion: 556,
    parentLedgerSchema: 'h8a-ui-state-dev40-successor-ledger-v1',
    parentRegistrationPath: null,
    parentRegistrationSha256: null,
    parentRegistrationSchema: null,
    parentRegistrationStudyId: null,
    parentRegistrationFreezeId: null,
    ledgerSchema: 'h8a-provider-refusal-replay-ledger-v1',
    registrationSchema: 'h8a-provider-refusal-replay-registration-v1',
    queryPolicy: null,
  }),
  [AUTHORED_SCOPE_STUDY_ID]: Object.freeze({
    studyId: AUTHORED_SCOPE_STUDY_ID,
    freezeId: AUTHORED_SCOPE_FREEZE_ID,
    canonicalRoot: AUTHORED_SCOPE_ROOT,
    candidateProfileId: PROFILE_SCOPE_CANDIDATE_ID,
    controlProfileId: PROFILE_CONTROL_ID,
    inheritedPhysicalCalls: 239,
    inheritedLogicalAttempts: 75,
    inheritedKnownCostUsd: 0.14494101499999998,
    inheritedUnknownReserveUsd: 0.24,
    nextPhysicalId: 240,
    nextReservationId: 240,
    candidateCallsPerCase: 4,
    controlCallsPerCase: 6,
    candidateUsdPerDispatch: 0.55,
    controlUsdPerDispatch: 0.12,
    incrementalCallLimit: 400,
    incrementalExposureUsd: 116.8,
    parentAuditPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/parent-admission-audit-v1.json',
    parentAuditSha256: '80bdf20178c11f1e578ecaae24d177099c414500874a485a0e64e5d974bfdac7',
    parentLedgerPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1/admission/successor-campaign/campaign-ledger.json',
    parentLedgerSha256: '9b56da23c01bde7658bf7d5aaa264a9d66192b88705e81b88cb1e9dc6d787fa7',
    parentLedgerVersion: 161,
    parentLedgerSchema: 'h8a-provider-refusal-replay-ledger-v1',
    parentRegistrationPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1/admission/successor-campaign/registration.json',
    parentRegistrationSha256: 'c1a4cefb1437012bbbbe734e26816acef8742b66ca3689c85b1dd055148861be',
    parentRegistrationSchema: 'h8a-provider-refusal-replay-registration-v1',
    parentRegistrationStudyId: 'provider-refusal-dev40-replay-v1',
    parentRegistrationFreezeId: 'h8a-provider-refusal-dev40-replay-20261101-v1',
    ledgerSchema: 'h8a-authored-scope-replay-ledger-v1',
    registrationSchema: 'h8a-authored-scope-replay-registration-v1',
    queryPolicy: AUTHORED_SCOPE_QUERY_POLICY,
    phaseId: PHASE_SCOPE_DEV40_ID,
    parentFreezePath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1/protocol-inputs/phase-freeze.json',
    parentFreezeSha256: '92808248501c6fbacbb5965a2b293aba67f18bd71a8a9027a0b9e6630effce6e',
    parentAnnotationsPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1/protocol-inputs/evaluator-private-annotations.json',
    parentAnnotationsSha256: '8031bb7e41c984d9519a3da8137888d17c1d788f2966363d962f6858324b0edb',
  }),
  [NATIVE_PRESENCE_STUDY_ID]: Object.freeze({
    studyId: NATIVE_PRESENCE_STUDY_ID,
    freezeId: NATIVE_PRESENCE_FREEZE_ID,
    canonicalRoot: NATIVE_PRESENCE_ROOT,
    candidateProfileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
    controlProfileId: PROFILE_CONTROL_ID,
    inheritedPhysicalCalls: 276,
    inheritedLogicalAttempts: 87,
    inheritedKnownCostUsd: 0.17121459,
    inheritedUnknownReserveUsd: 0.24,
    nextPhysicalId: 277,
    nextReservationId: 277,
    candidateCallsPerCase: 4,
    controlCallsPerCase: 6,
    candidateUsdPerDispatch: 0.55,
    controlUsdPerDispatch: 0.12,
    incrementalCallLimit: 400,
    incrementalExposureUsd: 116.8,
    parentAuditPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/native-presence-parent-audit-v1.json',
    parentAuditSha256: '81354ec6f7607f3044553fecf94ba0b63d93c171ae3339cdc2debe0cfd24e053',
    parentLedgerPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/authored-scope-dev40-v1/admission/successor-campaign/campaign-ledger.json',
    parentLedgerSha256: '5828795cd175de4c56651ee73f33f110185d4cfeb9f18e141032926316e1c73c',
    parentLedgerVersion: 161,
    parentLedgerSchema: 'h8a-authored-scope-replay-ledger-v1',
    parentRegistrationPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/authored-scope-dev40-v1/admission/successor-campaign/registration.json',
    parentRegistrationSha256: '9053d9aacae81d1dc709ba08b51912c356c82063ed1f87539440af3a3deda3c2',
    parentRegistrationSchema: 'h8a-authored-scope-replay-registration-v1',
    parentRegistrationStudyId: 'authored-scope-dev40-v1',
    parentRegistrationFreezeId: 'h8a-authored-scope-dev40-20261101-v1',
    ledgerSchema: 'h8a-native-presence-replay-ledger-v1',
    registrationSchema: 'h8a-native-presence-replay-registration-v1',
    queryPolicy: AUTHORED_SCOPE_QUERY_POLICY,
    presencePolicy: NATIVE_PRESENCE_POLICY,
    phaseId: PHASE_NATIVE_PRESENCE_DEV40_ID,
    parentFreezePath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/authored-scope-dev40-v1/protocol-inputs/phase-freeze.json',
    parentFreezeSha256: '9ecac5059499183e50b1dd76e2eb7e88793f8fa4e2b457049f6158cb01601e23',
    parentAnnotationsPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/authored-scope-dev40-v1/protocol-inputs/evaluator-private-annotations.json',
    parentAnnotationsSha256: '9ee7a831ce6f903ae27505bc844c23638091f3484f4d4a8ecdffeecfd854d71f',
  }),
  [NATIVE_SELECTOR_STUDY_ID]: Object.freeze({
    studyId: NATIVE_SELECTOR_STUDY_ID,
    freezeId: NATIVE_SELECTOR_FREEZE_ID,
    canonicalRoot: NATIVE_SELECTOR_ROOT,
    candidateProfileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
    controlProfileId: PROFILE_CONTROL_ID,
    inheritedPhysicalCalls: 317,
    inheritedLogicalAttempts: 103,
    inheritedKnownCostUsd: 0.19184451499999994,
    inheritedUnknownReserveUsd: 0.24,
    nextPhysicalId: 318,
    nextReservationId: 318,
    candidateCallsPerCase: 4,
    controlCallsPerCase: 6,
    candidateUsdPerDispatch: 0.12,
    controlUsdPerDispatch: 0.12,
    incrementalCallLimit: 400,
    incrementalExposureUsd: 48,
    parentAuditPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/native-selector-research-v1/prospective-parent-audit-v1.json',
    parentAuditSha256: 'a4ec08fd76c065f8f6698e45b5b067ae1f6c5d60b5912edc580990fa15181600',
    parentLedgerPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/native-presence-flat-dev40-v1/admission/successor-campaign/campaign-ledger.json',
    parentLedgerSha256: '58b6bee18de48d99e0804197555030cfd6e11cfe28ab744ee2e3c5cc81d2c4ae',
    parentLedgerVersion: 180,
    parentLedgerSchema: 'h8a-native-presence-replay-ledger-v1',
    parentRegistrationPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/native-presence-flat-dev40-v1/admission/successor-campaign/registration.json',
    parentRegistrationSha256: '5accb2fd43df0afc78f9882feb612ca023536883dccf55a1c1f544e2f2bdd7ed',
    parentRegistrationSchema: 'h8a-native-presence-replay-registration-v1',
    parentRegistrationStudyId: NATIVE_PRESENCE_STUDY_ID,
    parentRegistrationFreezeId: NATIVE_PRESENCE_FREEZE_ID,
    ledgerSchema: 'h8a-native-selector-replay-ledger-v1',
    registrationSchema: 'h8a-native-selector-replay-registration-v1',
    queryPolicy: AUTHORED_SCOPE_QUERY_POLICY,
    presencePolicy: NATIVE_PRESENCE_POLICY,
    selectionPolicy: NATIVE_SELECTOR_POLICY,
    priceProof: NATIVE_SELECTOR_PRICE_PROOF,
    phaseId: PHASE_NATIVE_SELECTOR_DEV40_ID,
    parentFreezePath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/native-presence-flat-dev40-v1/protocol-inputs/phase-freeze.json',
    parentFreezeSha256: 'fd7b3297558d685e2fd887e4054ec9d35574f3a88c9393c1cb73ec55cbe07654',
    parentAnnotationsPath:
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/native-presence-flat-dev40-v1/protocol-inputs/evaluator-private-annotations.json',
    parentAnnotationsSha256: 'baab789da7a8065624712efb7261db04039be46d0c48deb05c8ab6bb8ecd1d79',
  }),
})

export type ReplayStudyId = keyof typeof REPLAY_STUDY_REGISTRY
export type ReplayStudyPolicy = (typeof REPLAY_STUDY_REGISTRY)[ReplayStudyId]

function isReplayStudyId(value: string): value is ReplayStudyId {
  return Object.hasOwn(REPLAY_STUDY_REGISTRY, value)
}

export function replayStudyPolicy(studyId: unknown): ReplayStudyPolicy {
  if (typeof studyId !== 'string' || !isReplayStudyId(studyId))
    throw new RangeError('Replay study is outside the closed registry')
  return REPLAY_STUDY_REGISTRY[studyId]
}
