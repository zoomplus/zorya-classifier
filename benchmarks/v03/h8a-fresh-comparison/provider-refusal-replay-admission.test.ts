import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  providerRefusalReplayProtocolSchema,
  PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
  PROVIDER_REFUSAL_REPLAY_STUDY_ID,
  PROVIDER_REFUSAL_REPLAY_FREEZE_ID,
} from './provider-refusal-replay-admission.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import {
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
  UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
} from './ui-state-dev40-policy.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

await test('replay protocol schema binds fixed namespace, policy and unchanged bounded budget', () => {
  const protocol = providerRefusalReplayProtocolSchema.parse({
    schema: 'h8a-provider-refusal-replay-protocol-v1',
    studyId: PROVIDER_REFUSAL_REPLAY_STUDY_ID,
    freezeId: PROVIDER_REFUSAL_REPLAY_FREEZE_ID,
    deadlineIso: PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO,
    parentAudit: {
      path: PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
    },
    sourceAudit: {
      path: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
    },
    freeze: { path: '/tmp/freeze.json', sha256: hash('freeze') },
    annotations: { path: '/tmp/annotations.json', sha256: hash('annotations') },
    selection: { path: '/tmp/selection.json', sha256: hash('selection') },
    producerClosure: { path: '/tmp/closure.json', sha256: hash('closure') },
    runtimeProof: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
    },
    runtimeEnvironment: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
    },
    sourceBytes: Array.from({ length: 40 }, (_, index) => ({
      caseId: `case-${index}`,
      path: `/tmp/source-${index}.png`,
      sha256: hash(`source-${index}`),
      bytes: 1,
    })),
    referenceMasks: Array.from({ length: 16 }, (_, index) => ({
      path: `/tmp/mask-${index}.bin`,
      sha256: hash(`mask-${index}`),
      packedBinarySha256: hash(`mask-${index}`),
    })),
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256,
    budget: {
      globalPhysicalCallLimit: 2000,
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
  assert.equal(protocol.sourceBytes.length, 40)
  assert.equal(protocol.referenceMasks.length, 16)
  assert.equal(protocol.runtimeProof.path, PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH)
  assert.equal(protocol.runtimeEnvironment.path, PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH)
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      budget: { ...protocol.budget, ownerDollarCeilingUsd: 10 },
    }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({ ...protocol, executionPolicy: hash('wrong') }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      runtimeProof: {
        ...protocol.runtimeProof,
        path: 'zorya-classifier-mcp-20261101/main-flat-compare-v2/checked-runtime-files-v2.json',
      },
    }),
  )
  assert.throws(() =>
    providerRefusalReplayProtocolSchema.parse({
      ...protocol,
      runtimeEnvironment: {
        ...protocol.runtimeEnvironment,
        path: '/tmp/runtime-environment.json',
      },
    }),
  )
})
