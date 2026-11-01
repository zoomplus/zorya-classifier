import { createHash } from 'node:crypto'
import {
  AUTHORED_SCOPE_FREEZE_ID,
  AUTHORED_SCOPE_QUERY_POLICY,
  AUTHORED_SCOPE_STUDY_ID,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'
import { authoredScopeReplayProtocolSchema } from './dev-replay-admission.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import {
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
} from './provider-refusal-replay-admission.js'
import {
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
  UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
} from './ui-state-dev40-policy.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function makeAuthoredScopeProtocolFixture() {
  const policy = replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID)
  return authoredScopeReplayProtocolSchema.parse({
    schema: 'h8a-authored-scope-replay-protocol-v1',
    studyId: AUTHORED_SCOPE_STUDY_ID,
    freezeId: AUTHORED_SCOPE_FREEZE_ID,
    deadlineIso: '2026-11-02T12:11:51.738Z',
    parentAudit: {
      path: policy.parentAuditPath,
      sha256: policy.parentAuditSha256,
    },
    sourceAudit: {
      path: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
    },
    freeze: { path: '/tmp/authored-scope-freeze.json', sha256: sha256('freeze') },
    annotations: { path: '/tmp/authored-scope-annotations.json', sha256: sha256('annotations') },
    selection: { path: '/tmp/authored-scope-selection.json', sha256: sha256('selection') },
    producerClosure: { path: '/tmp/authored-scope-closure.json', sha256: sha256('closure') },
    runtimeProof: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
    },
    runtimeEnvironment: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
    },
    sourceBytes: Array.from({ length: 40 }, (_, index) => ({
      caseId: `scope-case-${index}`,
      path: `/tmp/authored-scope-source-${index}.png`,
      sha256: sha256(`source-${index}`),
      bytes: index + 1,
    })),
    referenceMasks: Array.from({ length: 16 }, (_, index) => ({
      path: `/tmp/authored-scope-mask-${index}.bin`,
      sha256: sha256(`mask-${index}`),
      packedBinarySha256: sha256(`mask-${index}`),
    })),
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256,
    queryPolicy: AUTHORED_SCOPE_QUERY_POLICY,
    budget: {
      globalPhysicalCallLimit: 2_000,
      dev40PhysicalCallLimit: 400,
      candidateMaxCallsPerCase: 4,
      controlMaxCallsPerCase: 6,
      candidateMaxUsdPerDispatch: 0.55,
      controlMaxUsdPerDispatch: 0.12,
      ownerDollarCeilingUsd: null,
    },
    noRetryOrFallback: true,
    physicalCallsAt: 'fetch',
  })
}
