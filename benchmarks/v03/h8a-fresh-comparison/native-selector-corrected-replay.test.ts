import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateCorrectedNativeSelectorParentStageReport,
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
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import { PHASE_NATIVE_SELECTOR_DEV40_ID } from './constants.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { hashIdentity } from './hash-identity.js'

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

await test('corrected parent stage validator uses producer selection identity for all three stages', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_NATIVE_SELECTOR_DEV40_ID)
  const annotations = buildSyntheticAnnotationBundle(
    PHASE_NATIVE_SELECTOR_DEV40_ID,
    freeze.freezeId,
    freeze.producerCases,
    freeze.pairedSchedule,
  )
  const selection = buildDevScreenSelection(freeze, annotations)
  for (const stage of ['dev8', 'dev12', 'dev40'] as const) {
    const expectedPairs = stage === 'dev8' ? 8 : stage === 'dev12' ? 12 : 40
    const reportBody = {
      schema: 'h8a-dev-screen-report-v1',
      screen: stage,
      expectedPairs,
      completedPairs: stage === 'dev40' ? 15 : expectedPairs,
      freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
      selectionCommitmentSha256: selection.selectionCommitmentSha256,
    }
    const report = { ...reportBody, reportSha256: hashIdentity(reportBody) }
    const reviewBody = {
      schema: 'h8a-dev-screen-review-v1',
      judgement: stage === 'dev40' ? 'stop' : 'advance',
      screenReportSha256: report.reportSha256,
    }
    const review = { ...reviewBody, reviewSha256: hashIdentity(reviewBody) }
    const input = { stage, report, review, freeze, annotations } as const
    assert.doesNotThrow(() => validateCorrectedNativeSelectorParentStageReport(input))

    const wrongWholeSelectionHashBody = {
      ...reportBody,
      selectionCommitmentSha256: hashIdentity(selection),
    }
    const wrongWholeSelectionReport = {
      ...wrongWholeSelectionHashBody,
      reportSha256: hashIdentity(wrongWholeSelectionHashBody),
    }
    const wrongWholeSelectionReviewBody = {
      ...reviewBody,
      screenReportSha256: wrongWholeSelectionReport.reportSha256,
    }
    assert.throws(
      () =>
        validateCorrectedNativeSelectorParentStageReport({
          ...input,
          report: wrongWholeSelectionReport,
          review: {
            ...wrongWholeSelectionReviewBody,
            reviewSha256: hashIdentity(wrongWholeSelectionReviewBody),
          },
        }),
      /parent stage report or review is invalid/u,
    )
    assert.throws(
      () =>
        validateCorrectedNativeSelectorParentStageReport({
          ...input,
          report: { ...report, reportSha256: '0'.repeat(64) },
        }),
      /parent stage report or review is invalid/u,
    )
    assert.throws(
      () =>
        validateCorrectedNativeSelectorParentStageReport({
          ...input,
          review: { ...review, reviewSha256: '0'.repeat(64) },
        }),
      /parent stage report or review is invalid/u,
    )
  }
})
