import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nativeSelectorCorrectedReplayProtocolSchema,
  parseReplayProtocolForStudy,
} from './dev-replay-admission.js'
import {
  NATIVE_SELECTOR_CORRECTED_FREEZE_ID,
  NATIVE_SELECTOR_CORRECTED_PARENT_AUDIT_PATH,
  NATIVE_SELECTOR_CORRECTED_PARENT_AUDIT_SHA256,
  NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  NATIVE_SELECTOR_POLICY,
  NATIVE_SELECTOR_PRICE_PROOF,
  NATIVE_PRESENCE_POLICY,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'
import { makeAuthoredScopeProtocolFixture } from './dev-replay-test-fixtures.js'

await test('corrected replay is an explicit closed identity with inherited V5 policy and budget', () => {
  const scope = makeAuthoredScopeProtocolFixture()
  const protocol = nativeSelectorCorrectedReplayProtocolSchema.parse({
    ...scope,
    schema: 'h8a-native-selector-corrected-replay-protocol-v1',
    studyId: NATIVE_SELECTOR_CORRECTED_STUDY_ID,
    freezeId: NATIVE_SELECTOR_CORRECTED_FREEZE_ID,
    parentAudit: {
      path: NATIVE_SELECTOR_CORRECTED_PARENT_AUDIT_PATH,
      sha256: NATIVE_SELECTOR_CORRECTED_PARENT_AUDIT_SHA256,
    },
    selectionPolicy: NATIVE_SELECTOR_POLICY,
    presencePolicy: NATIVE_PRESENCE_POLICY,
    priceProof: {
      path: NATIVE_SELECTOR_PRICE_PROOF.path,
      sha256: NATIVE_SELECTOR_PRICE_PROOF.sha256,
    },
    budget: {
      ...scope.budget,
      candidateMaxUsdPerDispatch: 0.12,
      controlMaxUsdPerDispatch: 0.12,
    },
  })
  assert.equal(
    parseReplayProtocolForStudy(NATIVE_SELECTOR_CORRECTED_STUDY_ID, protocol).studyId,
    NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  )
  assert.throws(
    () =>
      parseReplayProtocolForStudy(NATIVE_SELECTOR_CORRECTED_STUDY_ID, {
        ...protocol,
        studyId: 'native-selector-flat-dev40-v1',
      }),
    /protocol does not match/u,
  )
  const policy = replayStudyPolicy(NATIVE_SELECTOR_CORRECTED_STUDY_ID)
  assert.equal(policy.inheritedPhysicalCalls, 413)
  assert.equal(policy.inheritedLogicalAttempts, 134)
  assert.equal(policy.inheritedKnownCostUsd, 0.22744121499999995)
  assert.equal(policy.inheritedUnknownReserveUsd, 0.36)
  assert.equal(policy.nextPhysicalId, 414)
  assert.equal(policy.incrementalCallLimit, 400)
  assert.equal(policy.incrementalExposureUsd, 48)
  assert.equal(
    policy.priceProof.sha256,
    '433b8c9f8d91c3b52fd2cb08ceb6443a612124349aa3ea6425463e41002e1b4d',
  )
})
