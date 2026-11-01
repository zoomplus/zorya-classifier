import {
  PROFILE_CONTROL_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
} from './constants.js'
import { PHASE_SCOPE_DEV40_ID } from './constants.js'

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
