import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { replaySha256, readPinnedReplayFile } from './dev-replay-files.js'
import {
  assertAdmissionDeadline,
  assertBeforeDeadline,
  assertPackedReplayMaskBytes,
  assertRequiredParentAuditReferences,
  assertAuthoredScopeFreezeRetargeting,
  parseClosedReplayProtocol,
  parseReplayProtocolForStudy,
  validateReplayMaskSet,
  validateScopeParentAudit,
} from './dev-replay-admission.js'
import {
  AUTHORED_SCOPE_FREEZE_ID,
  AUTHORED_SCOPE_QUERY_POLICY,
  AUTHORED_SCOPE_ROOT,
  AUTHORED_SCOPE_STUDY_ID,
  LEGACY_REPLAY_ROOT,
  LEGACY_REPLAY_STUDY_ID,
  NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  NATIVE_SELECTOR_FREEZE_ID,
  NATIVE_SELECTOR_STUDY_ID,
  REPLAY_STUDY_REGISTRY,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'
import type { ReplayStudyId } from './dev-replay-study-policy.js'
import { makeAuthoredScopeProtocolFixture } from './dev-replay-test-fixtures.js'
import {
  DevReplayLedger,
  selectNativeSelectorParentAuditReferences,
  validateAuthoredScopeReplayParentPair,
} from './dev-replay-ledger.js'
import { ProviderRefusalReplayLedger } from './provider-refusal-replay-ledger.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import {
  PHASE_FLAT_DEV40_ID,
  PHASE_SCOPE_DEV40_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
  STRATUMS,
} from './constants.js'
import { phaseFreezeSchema, evaluatorPrivateAnnotationBundleSchema } from './schemas.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import { validateDevScreenSelection, buildDevScreenSelection } from './dev-screen-sampling.js'
import { hashIdentity } from './hash-identity.js'
import { validateConservativeCostProof } from './freeze-admission.js'

const caseIds = (): string[] => Array.from({ length: 40 }, (_, index) => `case-${index}`)

function makeCorrectedNativeSelectorParentAudit() {
  const policy = replayStudyPolicy(NATIVE_SELECTOR_CORRECTED_STUDY_ID)
  const refs = Array.from({ length: 29 }, (_, index) => ({
    path: `/offline/native-selector-ref-${index}.json`,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    bytes: 100 + index,
  }))
  refs[0] = {
    path: policy.parentLedgerPath,
    sha256: policy.parentLedgerSha256,
    bytes: 7_345,
  }
  refs[1] = {
    path: policy.parentRegistrationPath!,
    sha256: policy.parentRegistrationSha256!,
    bytes: 2_256,
  }
  return {
    schema: 'main-native-selector-corrected-prospective-parent-audit-v1',
    checkedAtUtc: '2026-11-02T03:00:30.260525+00:00',
    parentStudyId: NATIVE_SELECTOR_STUDY_ID,
    parentFreezeId: NATIVE_SELECTOR_FREEZE_ID,
    parentClosed: true,
    parentReviewDecision: 'stop',
    parentSourceCommit: '2572b8c405fc5cd8971a7b39f2683a6f75b65370',
    parentLedgerVersion: 416,
    parentRegistrationBodySha256:
      'b17dd817d013af08067274e4d95609bffd25eaaaf934629efd207fa96a0cc1cb',
    parentPhysicalDispatchCount: 413,
    parentCaseArmAttempts: 134,
    parentKnownCostUsd: 0.22744121499999995,
    parentUnknownReserveUsd: 0.36,
    parentNextPhysicalId: 414,
    parentNextReservationId: 414,
    parentInFlightReservations: 0,
    parentUncertainPhysicalDispatchCount: 0,
    parentResumeBlocked: false,
    parentCrashRecoveryLatched: false,
    parentIntegrityBlocked: false,
    parentQualEligible: false,
    parentCompletePairs: 15,
    parentFullyUnstartedPairs: 24,
    parentPartialPairs: 1,
    parentMissingPredictionRows: 49,
    correction: {
      kind: 'cross-source-typed-error-recording-defect-v1',
      maximumCorrectedFullRuns: 1,
      sourceFixCommit: '77fa1d75a53df945237dcf820871e3c30764a58f',
      sourceFixTree: 'fa2f9774822a402347f7e5d87283d88573e576a2',
      fixedRecorderSha256: '53028e360c2a50c3b7e321824d4bec37398a2a11f40bb06528f58d8d017234ac',
      regressionFailedBeforeFix: true,
      regressionPassesAfterFix: true,
      mainActualHistoricalControlledAdapterCases: 3,
      realCallsInDefectReproductionAndVerification: 0,
      usesGroundTruthOrCandidateOutcomes: false,
      originalRecordsMustRemainFailedAndImmutable: true,
    },
    deadlineIso: '2026-11-02T12:11:51.738Z',
    globalPhysicalCallLimit: 2_000,
    remainingPhysicalCalls: 1_587,
    prospectiveDevPhysicalCallLimit: 400,
    prospectiveDevExposureUsd: 48,
    reservedUsdPerPhysicalDispatch: 0.12,
    candidateMaxCallsPerCase: 4,
    controlMaxCallsPerCase: 6,
    conditionalQualPhysicalCallLimit: 1_200,
    conditionalQualExposureUsd: 144,
    qualBudgetNotYetAdmitted: true,
    qualAdmissionRequiresActualRemainingAtLeast: 1_200,
    maximumActualNewDevCallsCompatibleWithFullQualReserve: 387,
    ownerDollarCeilingUsd: null,
    candidateProfileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
    candidateRecipeSha256: '3de74926736d37ccc9184f45f015d4d5e0711ea087b29153a001d1a599276e74',
    controlRecipeSha256: 'ad521b3467280fb169f15e2db4e5841724654ef11be31138879f2bb157dea716',
    newProviderCalls: 0,
    newNativeInferenceCalls: 0,
    newStudyRegistered: false,
    refs,
  }
}

function makeRetargetedSyntheticFreeze() {
  const parentSeed = buildSyntheticPhaseFreeze(PHASE_FLAT_DEV40_ID).freeze
  const scopeSeed = buildSyntheticPhaseFreeze(PHASE_SCOPE_DEV40_ID).freeze
  const parentAnnotations = evaluatorPrivateAnnotationBundleSchema.parse(
    buildSyntheticAnnotationBundle(
      PHASE_FLAT_DEV40_ID,
      'pinned-parent-freeze-v1',
      parentSeed.producerCases,
      parentSeed.pairedSchedule,
    ),
  )
  const annotationsWithoutCommitment = {
    ...parentAnnotations,
    phaseId: PHASE_SCOPE_DEV40_ID,
    freezeId: AUTHORED_SCOPE_FREEZE_ID,
  }
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(annotationsWithoutCommitment)
  const parentCostProofBody = {
    schema: parentSeed.conservativeCostProof.schema,
    proofKind: parentSeed.conservativeCostProof.proofKind,
    maxUsdPerPhysicalDispatch: 0.55,
    profileDispatchUpperBounds: [
      {
        ...parentSeed.conservativeCostProof.profileDispatchUpperBounds[0],
        maxUsdPerPhysicalDispatch: 0.55,
      },
      {
        ...parentSeed.conservativeCostProof.profileDispatchUpperBounds[1],
        maxUsdPerPhysicalDispatch: 0.12,
      },
    ],
    derivedFrom: parentSeed.conservativeCostProof.derivedFrom,
  }
  const parentCostProof = {
    ...parentCostProofBody,
    proofSha256: hashIdentity(parentCostProofBody),
  }
  const scopeCostProofBody = {
    ...parentCostProofBody,
    profileDispatchUpperBounds: [
      {
        ...parentCostProofBody.profileDispatchUpperBounds[0],
        profileId: PROFILE_SCOPE_CANDIDATE_ID,
      },
      parentCostProofBody.profileDispatchUpperBounds[1],
    ],
  }
  const scopeCostProof = {
    ...scopeCostProofBody,
    proofSha256: hashIdentity(scopeCostProofBody),
  }
  const nextFreezeBody = {
    ...parentSeed,
    freezeId: AUTHORED_SCOPE_FREEZE_ID,
    phaseId: PHASE_SCOPE_DEV40_ID,
    producerClosureSha256: 'c'.repeat(64),
    profileBindings: [
      scopeSeed.profileBindings[0],
      parentSeed.profileBindings[1],
    ] as typeof parentSeed.profileBindings,
    conservativeCostProof: scopeCostProof,
    sourceStrataCommitments: STRATUMS.map((stratum) => {
      const sourceGroupIds = annotations.cases
        .filter((item) => item.stratum === stratum)
        .map((item) => item.sourceGroup)
      return {
        stratum,
        caseCount: sourceGroupIds.length,
        sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
          PHASE_SCOPE_DEV40_ID,
          stratum,
          sourceGroupIds,
        ),
      }
    }),
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
    deadlineIso: '2026-11-02T12:11:51.738Z',
  }
  const parentFreeze = phaseFreezeSchema.parse({
    ...parentSeed,
    freezeId: 'pinned-parent-freeze-v1',
    conservativeCostProof: parentCostProof,
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
    deadlineIso: '2026-11-02T12:11:51.738Z',
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(parentAnnotations),
  })
  return {
    parentFreeze,
    nextFreeze: phaseFreezeSchema.parse(nextFreezeBody),
    parentAnnotations,
    annotations,
  }
}

await test('closed replay registry separates scope authority and inherited counters', () => {
  assert.deepEqual(Object.keys(REPLAY_STUDY_REGISTRY), [
    LEGACY_REPLAY_STUDY_ID,
    AUTHORED_SCOPE_STUDY_ID,
    'native-presence-flat-dev40-v1',
    NATIVE_SELECTOR_STUDY_ID,
    NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  ])
  const legacy = replayStudyPolicy(LEGACY_REPLAY_STUDY_ID)
  const scoped = replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID)
  assert.equal(legacy.canonicalRoot, LEGACY_REPLAY_ROOT)
  assert.equal(scoped.canonicalRoot, AUTHORED_SCOPE_ROOT)
  assert.equal(scoped.freezeId, AUTHORED_SCOPE_FREEZE_ID)
  assert.equal(scoped.inheritedPhysicalCalls, 239)
  assert.equal(scoped.inheritedLogicalAttempts, 75)
  assert.equal(scoped.nextPhysicalId, 240)
  assert.equal(
    scoped.parentLedgerSha256,
    '9b56da23c01bde7658bf7d5aaa264a9d66192b88705e81b88cb1e9dc6d787fa7',
  )
  assert.equal(scoped.queryPolicy?.sha256, AUTHORED_SCOPE_QUERY_POLICY.sha256)
  const selector = replayStudyPolicy(NATIVE_SELECTOR_STUDY_ID)
  assert.equal(selector.inheritedPhysicalCalls, 317)
  assert.equal(selector.inheritedLogicalAttempts, 103)
  assert.equal(selector.nextPhysicalId, 318)
  assert.equal(selector.candidateUsdPerDispatch, 0.12)
  assert.equal(selector.controlUsdPerDispatch, 0.12)
  assert.equal(selector.incrementalCallLimit, 400)
  assert.equal(selector.incrementalExposureUsd, 48)
  assert.equal(selector.selectionPolicy?.policyId, 'native-categorical-all-stages-v1')
  assert.throws(() => replayStudyPolicy('caller-selected-study-v1'), /closed registry/u)
})

await test('authored-scope protocol is explicitly bound to its own study and query policy', () => {
  const protocol = makeAuthoredScopeProtocolFixture()
  const parsed = parseClosedReplayProtocol(protocol)
  assert.equal(parsed.studyId, AUTHORED_SCOPE_STUDY_ID)
  assert.equal(
    parseReplayProtocolForStudy(AUTHORED_SCOPE_STUDY_ID, protocol).studyId,
    AUTHORED_SCOPE_STUDY_ID,
  )
  assert.equal(
    parsed.protocol.queryPolicy.hypothesisSha256,
    AUTHORED_SCOPE_QUERY_POLICY.hypothesisSha256,
  )
  assert.throws(() =>
    parseClosedReplayProtocol({
      ...protocol,
      queryPolicy: { ...protocol.queryPolicy, sha256: 'a'.repeat(64) },
    }),
  )
  assert.throws(() => parseClosedReplayProtocol({ ...protocol, studyId: 'foreign-study' }))
  assert.throws(
    () => parseReplayProtocolForStudy(LEGACY_REPLAY_STUDY_ID, protocol),
    /explicitly selected/u,
  )
  assert.throws(() => parseClosedReplayProtocol({ ...protocol, namespace: '/tmp/foreign' }))
})

await test('authored-scope admission accepts only the closed retargeting of the pinned freeze', () => {
  const fixture = makeRetargetedSyntheticFreeze()
  assert.doesNotThrow(() =>
    assertAuthoredScopeFreezeRetargeting(
      fixture.parentFreeze,
      fixture.nextFreeze,
      fixture.parentAnnotations,
      fixture.annotations,
      'c'.repeat(64),
    ),
  )
  assert.doesNotThrow(() => validateConservativeCostProof(fixture.nextFreeze))
  const changedTarget = structuredClone(fixture.nextFreeze)
  changedTarget.producerCases[0]!.targetTaskText = 'altered synthetic target'
  assert.throws(
    () =>
      assertAuthoredScopeFreezeRetargeting(
        fixture.parentFreeze,
        changedTarget,
        fixture.parentAnnotations,
        fixture.annotations,
        'c'.repeat(64),
      ),
    /fields outside/u,
  )
  const changedDimensions = structuredClone(fixture.nextFreeze)
  changedDimensions.producerCases[0]!.sourceCanvasWidth += 1
  assert.throws(
    () =>
      assertAuthoredScopeFreezeRetargeting(
        fixture.parentFreeze,
        changedDimensions,
        fixture.parentAnnotations,
        fixture.annotations,
        'c'.repeat(64),
      ),
    /fields outside/u,
  )
  const changedOrder = structuredClone(fixture.nextFreeze)
  ;[changedOrder.producerCases[0], changedOrder.producerCases[1]] = [
    changedOrder.producerCases[1]!,
    changedOrder.producerCases[0]!,
  ]
  assert.throws(() =>
    assertAuthoredScopeFreezeRetargeting(
      fixture.parentFreeze,
      changedOrder,
      fixture.parentAnnotations,
      fixture.annotations,
      'c'.repeat(64),
    ),
  )
  const swappedCandidatePolicy = structuredClone(fixture.nextFreeze)
  swappedCandidatePolicy.profileBindings[0].requestPolicyIdentitySha256 =
    swappedCandidatePolicy.profileBindings[1].requestPolicyIdentitySha256
  swappedCandidatePolicy.profileBindings[0].recipeIdentitySha256 =
    swappedCandidatePolicy.profileBindings[1].recipeIdentitySha256
  assert.throws(() =>
    assertAuthoredScopeFreezeRetargeting(
      fixture.parentFreeze,
      swappedCandidatePolicy,
      fixture.parentAnnotations,
      fixture.annotations,
      'c'.repeat(64),
    ),
  )
  const changedControl = structuredClone(fixture.nextFreeze)
  changedControl.profileBindings[1].requestPolicyIdentitySha256 = 'f'.repeat(64)
  assert.throws(() =>
    assertAuthoredScopeFreezeRetargeting(
      fixture.parentFreeze,
      changedControl,
      fixture.parentAnnotations,
      fixture.annotations,
      'c'.repeat(64),
    ),
  )
  const changedCostProvenance = structuredClone(fixture.nextFreeze)
  changedCostProvenance.conservativeCostProof.derivedFrom = 'altered synthetic price source'
  const { proofSha256: _priorProofHash, ...changedCostBody } =
    changedCostProvenance.conservativeCostProof
  changedCostProvenance.conservativeCostProof.proofSha256 = hashIdentity(changedCostBody)
  assert.throws(
    () =>
      assertAuthoredScopeFreezeRetargeting(
        fixture.parentFreeze,
        changedCostProvenance,
        fixture.parentAnnotations,
        fixture.annotations,
        'c'.repeat(64),
      ),
    /fields outside/u,
  )
  const invalidCostHash = structuredClone(fixture.nextFreeze)
  invalidCostHash.conservativeCostProof.proofSha256 = 'd'.repeat(64)
  assert.throws(() =>
    assertAuthoredScopeFreezeRetargeting(
      fixture.parentFreeze,
      invalidCostHash,
      fixture.parentAnnotations,
      fixture.annotations,
      'c'.repeat(64),
    ),
  )
})

await test('authored-scope annotation retargeting preserves labels and deterministic nested selection', () => {
  const fixture = makeRetargetedSyntheticFreeze()
  const changedAnnotation = structuredClone(fixture.annotations)
  changedAnnotation.cases[0]!.expectedPresence =
    changedAnnotation.cases[0]!.expectedPresence === 'present' ? 'absent' : 'present'
  const changedFreeze = structuredClone(fixture.nextFreeze)
  changedFreeze.evaluatorAnnotationsSha256 = computeEvaluatorAnnotationsSha256(changedAnnotation)
  assert.throws(
    () =>
      assertAuthoredScopeFreezeRetargeting(
        fixture.parentFreeze,
        changedFreeze,
        fixture.parentAnnotations,
        changedAnnotation,
        'c'.repeat(64),
      ),
    /annotations changed/u,
  )
  const selection = buildDevScreenSelection(fixture.nextFreeze, fixture.annotations)
  assert.deepEqual(
    validateDevScreenSelection(selection, fixture.nextFreeze, fixture.annotations),
    selection,
  )
  const changedSelection = structuredClone(selection)
  ;[changedSelection.dev8CaseIds[0], changedSelection.dev8CaseIds[1]] = [
    changedSelection.dev8CaseIds[1]!,
    changedSelection.dev8CaseIds[0]!,
  ]
  assert.throws(() =>
    validateDevScreenSelection(changedSelection, fixture.nextFreeze, fixture.annotations),
  )
})

await test('scope parent pins, packed mask set and absolute deadline reject tampering', () => {
  const policy = REPLAY_STUDY_REGISTRY[AUTHORED_SCOPE_STUDY_ID]
  const references = Array.from({ length: 14 }, (_, index) => ({
    path: `/pinned/reference-${index}.json`,
    sha256: 'a'.repeat(64),
  }))
  const required = [
    [policy.parentLedgerPath, policy.parentLedgerSha256],
    [policy.parentFreezePath, policy.parentFreezeSha256],
    [policy.parentAnnotationsPath, policy.parentAnnotationsSha256],
  ] as const
  const pinnedReferences = references.map((reference, index) =>
    index < required.length
      ? { path: required[index]![0], sha256: required[index]![1] }
      : reference,
  )
  const audit = {
    schema: 'h8a-authored-scope-parent-audit-v1',
    priorStudyId: LEGACY_REPLAY_STUDY_ID,
    priorStudyStatus: 'sealed-terminal-stop',
    inputPending: false,
    references: pinnedReferences,
    baseline: {
      parentLedgerVersion: 161,
      physicalDispatchCount: 239,
      logicalCaseAttemptCount: 75,
      knownCostUsd: 0.14494101499999998,
      unknownReserveUsd: 0.24,
      nextPhysicalId: 240,
      nextReservationId: 240,
      uncertainPhysicalDispatchCount: 0,
      inFlightReservations: 0,
    },
    sourceCases: 40,
    sourceClaim: 'same-disclosed-development-inputs',
    qual120Eligible: false,
    qualificationResult: null,
    reclassificationsPerformed: 0,
    providerCallsPerformed: 0,
    frozenGroundTruthChanged: false,
    newStudyRegistered: false,
  }
  assert.equal(validateScopeParentAudit(audit).references.length, 14)
  assert.throws(() =>
    validateScopeParentAudit({
      ...audit,
      baseline: { ...audit.baseline, physicalDispatchCount: 238 },
    }),
  )
  assertRequiredParentAuditReferences(pinnedReferences, required)
  assert.throws(() => assertRequiredParentAuditReferences(pinnedReferences.slice(1), required))
  assert.throws(() =>
    assertRequiredParentAuditReferences(
      pinnedReferences.map((item, index) =>
        index === 0 ? { ...item, sha256: 'b'.repeat(64) } : item,
      ),
      required,
    ),
  )

  const fixture = makeRetargetedSyntheticFreeze()
  const annotated = structuredClone(fixture.annotations)
  const validPackedMask = new Uint8Array([0, 1])
  const validHash = replaySha256(validPackedMask)
  annotated.cases[0]!.referenceMasks.push({ width: 3, height: 3, packedBinarySha256: validHash })
  validateReplayMaskSet(annotated, [{ packedBinarySha256: validHash }])
  assert.throws(() => validateReplayMaskSet(annotated, []))
  assert.throws(() =>
    validateReplayMaskSet(annotated, [
      { packedBinarySha256: validHash },
      { packedBinarySha256: validHash },
    ]),
  )
  assert.doesNotThrow(() => assertPackedReplayMaskBytes(annotated, validHash, validPackedMask))
  const invalidPadding = new Uint8Array([0, 128])
  const invalidHash = replaySha256(invalidPadding)
  annotated.cases[0]!.referenceMasks[0]!.packedBinarySha256 = invalidHash
  assert.throws(
    () => assertPackedReplayMaskBytes(annotated, invalidHash, invalidPadding),
    /Unused high bits/u,
  )

  const now = Date.parse('2026-11-01T12:00:00.000Z')
  assert.doesNotThrow(() => assertBeforeDeadline('2026-11-02T12:11:51.738Z', now))
  assert.throws(() =>
    assertBeforeDeadline('2026-11-02T12:11:51.738Z', Date.parse('2026-11-02T12:11:51.738Z')),
  )
  assert.throws(() => assertBeforeDeadline('invalid', now))
  const afterDeadline = Date.parse('2026-11-03T12:00:00.000Z')
  assert.doesNotThrow(() =>
    assertAdmissionDeadline('2026-11-02T12:11:51.738Z', afterDeadline, true),
  )
  assert.throws(() => assertAdmissionDeadline('2026-11-02T12:11:51.738Z', afterDeadline, false))
  assert.throws(() => assertAdmissionDeadline('invalid', afterDeadline, true))
})

await test('legacy and authored-scope ledgers keep isolated inherited baselines and reservations', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'dev-replay-cross-study-'))
  const legacyPolicy = replayStudyPolicy(LEGACY_REPLAY_STUDY_ID)
  const scopePolicy = replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID)
  const legacyRoot = join(outer, LEGACY_REPLAY_STUDY_ID, 'admission', 'successor-campaign')
  const scopeRoot = join(outer, AUTHORED_SCOPE_STUDY_ID, 'admission', 'successor-campaign')
  const caseIds = Array.from({ length: 40 }, (_, index) => `case-${index}`)
  try {
    const [legacy, scoped] = await Promise.all([
      DevReplayLedger.register({
        root: legacyRoot,
        offlineTestOnly: true,
        studyId: LEGACY_REPLAY_STUDY_ID,
        protocolSha256: 'b'.repeat(64),
        caseIds,
      }),
      DevReplayLedger.register({
        root: scopeRoot,
        offlineTestOnly: true,
        studyId: AUTHORED_SCOPE_STUDY_ID,
        protocolSha256: 'c'.repeat(64),
        caseIds,
      }),
    ])
    assert.equal(legacy.snapshot().physicalDispatchCount, 202)
    assert.equal(scoped.snapshot().physicalDispatchCount, 239)
    const [legacyReservation, scopeReservation] = await Promise.all([
      legacy.admitPhysical(legacyPolicy.candidateUsdPerDispatch, {
        profileId: legacyPolicy.candidateProfileId,
        opaqueCaseId: 'case-0',
      }),
      scoped.admitPhysical(scopePolicy.candidateUsdPerDispatch, {
        profileId: scopePolicy.candidateProfileId,
        opaqueCaseId: 'case-0',
      }),
    ])
    assert.equal(legacyReservation, 203)
    assert.equal(scopeReservation, 240)
    await Promise.all([
      legacy.recordDispatchIntent(legacyReservation),
      scoped.recordDispatchIntent(scopeReservation),
    ])
    const physicalIds = await Promise.all([
      legacy.markDispatched(legacyReservation),
      scoped.markDispatched(scopeReservation),
    ])
    assert.deepEqual(physicalIds, [203, 240])
    assert.equal(legacy.snapshot().physicalDispatchCount, 203)
    assert.equal(scoped.snapshot().physicalDispatchCount, 240)
    await legacy.settle(legacyReservation, 0.2)
    await scoped.settle(scopeReservation, null)
    assert.equal(legacy.snapshot().knownCostUsd, 0.31840506499999993)
    assert.equal(legacy.snapshot().unknownReserveUsd, 0.24)
    assert.equal(scoped.snapshot().knownCostUsd, 0.14494101499999998)
    assert.equal(scoped.snapshot().unknownReserveUsd, 0.79)
    await assert.rejects(
      scoped.admitPhysical(legacyPolicy.candidateUsdPerDispatch, {
        profileId: legacyPolicy.candidateProfileId,
        opaqueCaseId: 'case-1',
      }),
      /outside the replay ledger/u,
    )
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('authored-scope parent registration supplies the cap and links the cap-free state', () => {
  const policy = replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID)
  const registrationBody = {
    schema: 'h8a-provider-refusal-replay-registration-v1',
    studyId: 'provider-refusal-dev40-replay-v1',
    freezeId: 'h8a-provider-refusal-dev40-replay-20261101-v1',
    protocolSha256: 'a'.repeat(64),
    parentAuditSha256: '5e7f8db8bbdd59c39d04bd78536fead6dd269568f5816872e0cbfef48e18736a',
    parentLedgerSha256: 'b3c2348e09d8459ebc8b6935b03753c6b1082ce1f0f6584656bd8f39c4ca727b',
    parentLedgerVersion: 556,
    canonicalRoot: join(LEGACY_REPLAY_ROOT, 'admission', 'successor-campaign'),
    caseIds: Array.from({ length: 40 }, (_, index) => `opaque-${index}`),
    maxPhysicalCalls: 2_000,
    dev40MaxPhysicalCalls: 400,
    dev40MaxIncrementalUsd: 116.8,
    candidateMaxUsdPerDispatch: 0.55,
    controlMaxUsdPerDispatch: 0.12,
    ownerDollarCeilingUsd: null,
    retries: 0,
  }
  const registration = {
    ...registrationBody,
    registrationSha256: replaySha256(JSON.stringify(registrationBody)),
  }
  const state = {
    schema: 'h8a-provider-refusal-replay-ledger-v1',
    ledgerVersion: 161,
    registrationSha256: registration.registrationSha256,
    nextReservationId: 240,
    nextPhysicalId: 240,
    physicalDispatchCount: 239,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: 75,
    knownCostUsd: 0.14494101499999998,
    unknownReserveUsd: 0.24,
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
    integrityBlocked: false,
  }
  assert.equal(Object.hasOwn(state, 'maxPhysicalCalls'), false)
  assert.deepEqual(
    validateAuthoredScopeReplayParentPair(state, registration, AUTHORED_SCOPE_STUDY_ID),
    {
      ledgerVersion: 161,
      physicalDispatchCount: 239,
      logicalAttemptCount: 75,
      knownCostUsd: 0.14494101499999998,
      unknownReserveUsd: 0.24,
      maxPhysicalCalls: 2_000,
      nextPhysicalId: 240,
      nextReservationId: 240,
    },
  )
  assert.throws(
    () => validateAuthoredScopeReplayParentPair(state, undefined, AUTHORED_SCOPE_STUDY_ID),
    /invalid_type/u,
  )
  assert.throws(
    () =>
      validateAuthoredScopeReplayParentPair(
        { ...state, registrationSha256: 'c'.repeat(64) },
        registration,
        AUTHORED_SCOPE_STUDY_ID,
      ),
    /do not match/u,
  )
  assert.throws(
    () =>
      validateAuthoredScopeReplayParentPair(
        { ...state, maxPhysicalCalls: 2_000 },
        registration,
        AUTHORED_SCOPE_STUDY_ID,
      ),
    /do not match/u,
  )
  assert.throws(
    () =>
      validateAuthoredScopeReplayParentPair(
        { ...state, physicalDispatchCount: 238 },
        registration,
        AUTHORED_SCOPE_STUDY_ID,
      ),
    /baseline differs/u,
  )
  const brokenRegistration = { ...registration, registrationSha256: 'e'.repeat(64) }
  assert.throws(
    () =>
      validateAuthoredScopeReplayParentPair(
        { ...state, registrationSha256: 'e'.repeat(64) },
        brokenRegistration,
        AUTHORED_SCOPE_STUDY_ID,
      ),
    /do not match/u,
  )
  assert.throws(
    () =>
      validateAuthoredScopeReplayParentPair(
        state,
        { ...registration, maxPhysicalCalls: 1_999 },
        AUTHORED_SCOPE_STUDY_ID,
      ),
    /invalid_literal/u,
  )
  assert.throws(
    () =>
      validateAuthoredScopeReplayParentPair(
        state,
        { ...registration, registrationSha256: 'd'.repeat(64) },
        AUTHORED_SCOPE_STUDY_ID,
      ),
    /do not match/u,
  )
  assert.throws(
    () => validateAuthoredScopeReplayParentPair(state, registration, LEGACY_REPLAY_STUDY_ID),
    /not registered/u,
  )
  assert.equal(policy.parentLedgerVersion, 161)
})

await test('corrected selector identity accepts its exact closed V5 parent wire pair', () => {
  const corrected = replayStudyPolicy(NATIVE_SELECTOR_CORRECTED_STUDY_ID)
  if (
    !corrected.parentRegistrationPath ||
    !corrected.parentRegistrationStudyId ||
    !corrected.parentRegistrationFreezeId ||
    !corrected.parentRegistrationSchema
  )
    throw new RangeError('Corrected selector fixture lacks its closed parent registration pins')
  const parentPolicy = replayStudyPolicy(corrected.parentRegistrationStudyId)
  const registrationBody = {
    schema: corrected.parentRegistrationSchema,
    studyId: corrected.parentRegistrationStudyId,
    freezeId: corrected.parentRegistrationFreezeId,
    protocolSha256: 'a'.repeat(64),
    parentAuditSha256: parentPolicy.parentAuditSha256,
    parentLedgerSha256: parentPolicy.parentLedgerSha256,
    parentLedgerVersion: parentPolicy.parentLedgerVersion,
    canonicalRoot: dirname(corrected.parentRegistrationPath),
    caseIds: Array.from({ length: 40 }, (_, index) => `corrected-parent-case-${index}`),
    maxPhysicalCalls: 2_000,
    dev40MaxPhysicalCalls: parentPolicy.incrementalCallLimit,
    dev40MaxIncrementalUsd: parentPolicy.incrementalExposureUsd,
    candidateMaxUsdPerDispatch: parentPolicy.candidateUsdPerDispatch,
    controlMaxUsdPerDispatch: parentPolicy.controlUsdPerDispatch,
    ownerDollarCeilingUsd: null,
    retries: 0,
  }
  const registration = {
    ...registrationBody,
    registrationSha256: replaySha256(JSON.stringify(registrationBody)),
  }
  const state = {
    schema: corrected.parentLedgerSchema,
    ledgerVersion: corrected.parentLedgerVersion,
    registrationSha256: registration.registrationSha256,
    nextReservationId: corrected.nextReservationId,
    nextPhysicalId: corrected.nextPhysicalId,
    physicalDispatchCount: corrected.inheritedPhysicalCalls,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: corrected.inheritedLogicalAttempts,
    knownCostUsd: corrected.inheritedKnownCostUsd,
    unknownReserveUsd: corrected.inheritedUnknownReserveUsd,
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
    integrityBlocked: false,
  }
  assert.deepEqual(
    validateAuthoredScopeReplayParentPair(state, registration, NATIVE_SELECTOR_CORRECTED_STUDY_ID),
    {
      ledgerVersion: corrected.parentLedgerVersion,
      physicalDispatchCount: corrected.inheritedPhysicalCalls,
      logicalAttemptCount: corrected.inheritedLogicalAttempts,
      knownCostUsd: corrected.inheritedKnownCostUsd,
      unknownReserveUsd: corrected.inheritedUnknownReserveUsd,
      maxPhysicalCalls: 2_000,
      nextPhysicalId: corrected.nextPhysicalId,
      nextReservationId: corrected.nextReservationId,
    },
  )
})

await test('native-selector parent audit reference selection preserves closed old and corrected wire shapes', () => {
  const corrected = makeCorrectedNativeSelectorParentAudit()
  assert.deepEqual(
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, corrected),
    corrected.refs,
  )
  const withoutRefs = Object.fromEntries(
    Object.entries(corrected).filter(([key]) => key !== 'refs'),
  )
  assert.throws(() =>
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, withoutRefs),
  )
  assert.throws(() =>
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, {
      ...withoutRefs,
      references: corrected.refs,
    }),
  )
  assert.throws(() =>
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, {
      ...corrected,
      schema: 'main-native-selector-prospective-parent-audit-v1',
    }),
  )
  assert.throws(() =>
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, {
      ...corrected,
      refs: corrected.refs.slice(1),
    }),
  )
  assert.throws(() =>
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, {
      ...corrected,
      parentStudyId: 'native-selector-flat-dev40-corrected-v1',
    }),
  )
  assert.throws(() =>
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, {
      ...corrected,
      refs: corrected.refs.map((reference, index) =>
        index === 0 ? { ...reference, path: '/offline/ledger-alias.json' } : reference,
      ),
    }),
  )
  assert.throws(() =>
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_CORRECTED_STUDY_ID, {
      ...corrected,
      refs: corrected.refs.map((reference, index) =>
        index === 0 ? { ...reference, sha256: 'f'.repeat(64) } : reference,
      ),
    }),
  )

  const oldPolicy = replayStudyPolicy(NATIVE_SELECTOR_STUDY_ID)
  const oldRefs = Array.from({ length: 14 }, (_, index) => ({
    path: `/offline/old-native-selector-ref-${index}.json`,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    bytes: 100 + index,
  }))
  oldRefs[0] = {
    path: oldPolicy.parentLedgerPath!,
    sha256: oldPolicy.parentLedgerSha256,
    bytes: 7_345,
  }
  oldRefs[1] = {
    path: oldPolicy.parentRegistrationPath!,
    sha256: oldPolicy.parentRegistrationSha256!,
    bytes: 2_256,
  }
  const oldAudit = {
    schema: 'main-native-selector-prospective-parent-audit-v1',
    parentStudyId: 'native-presence-flat-dev40-v1',
    parentClosed: true,
    parentReviewDecision: 'stop',
    parentPhysicalDispatchCount: 317,
    parentCaseArmAttempts: 103,
    parentKnownCostUsd: 0.19184451499999994,
    parentUnknownReserveUsd: 0.24,
    globalPhysicalCallLimit: 2_000,
    refs: oldRefs,
  }
  assert.deepEqual(
    selectNativeSelectorParentAuditReferences(NATIVE_SELECTOR_STUDY_ID, oldAudit),
    oldRefs,
  )
})

await test('registration owns every selector and ordered case ID before awaiting', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'dev-replay-owned-inputs-'))
  const initialRoot = join(outer, AUTHORED_SCOPE_STUDY_ID, 'admission', 'successor-campaign')
  const changedRoot = join(outer, 'changed-study', 'admission', 'successor-campaign')
  const ids = caseIds()
  const options: {
    root: string
    offlineTestOnly: boolean
    studyId: ReplayStudyId
    protocolSha256: string
    caseIds: string[]
  } = {
    root: initialRoot,
    offlineTestOnly: true,
    studyId: AUTHORED_SCOPE_STUDY_ID,
    protocolSha256: 'd'.repeat(64),
    caseIds: ids,
  }
  try {
    const pending = DevReplayLedger.register(options)
    options.root = changedRoot
    options.offlineTestOnly = false
    options.studyId = LEGACY_REPLAY_STUDY_ID
    options.protocolSha256 = 'e'.repeat(64)
    ids[0] = ''
    const ledger = await pending
    assert.equal(ledger.snapshot().physicalDispatchCount, 239)
    const registration = JSON.parse(
      await readFile(join(initialRoot, 'registration.json'), 'utf8'),
    ) as { studyId: string; protocolSha256: string; caseIds: string[]; canonicalRoot: string }
    assert.equal(registration.studyId, AUTHORED_SCOPE_STUDY_ID)
    assert.equal(registration.protocolSha256, 'd'.repeat(64))
    assert.equal(registration.caseIds[0], 'case-0')
    assert.equal(registration.canonicalRoot, initialRoot)
    await assert.rejects(readFile(join(changedRoot, 'registration.json'), 'utf8'))
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('registration rejects empty or duplicate case IDs before creating a ledger root', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'dev-replay-invalid-case-ids-'))
  const root = join(outer, AUTHORED_SCOPE_STUDY_ID, 'admission', 'successor-campaign')
  const invalidSets = [caseIds().map((caseId, index) => (index === 0 ? '' : caseId))]
  invalidSets.push(caseIds().map((caseId, index) => (index === 39 ? 'case-0' : caseId)))
  try {
    for (const invalidIds of invalidSets) {
      await assert.rejects(
        DevReplayLedger.register({
          root,
          offlineTestOnly: true,
          studyId: AUTHORED_SCOPE_STUDY_ID,
          protocolSha256: 'f'.repeat(64),
          caseIds: invalidIds,
        }),
        /40 unique frozen case IDs/u,
      )
    }
    await assert.rejects(readFile(join(root, 'registration.json'), 'utf8'))
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('both registered profiles enforce independent candidate and control case caps', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'dev-replay-caps-'))
  const policies = [
    replayStudyPolicy(LEGACY_REPLAY_STUDY_ID),
    replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID),
  ]
  try {
    for (const policy of policies) {
      const root = join(outer, policy.studyId, 'admission', 'successor-campaign')
      await mkdir(join(outer, policy.studyId), { recursive: true })
      const ledger = await DevReplayLedger.register({
        root,
        offlineTestOnly: true,
        studyId: policy.studyId,
        protocolSha256: 'f'.repeat(64),
        caseIds: caseIds(),
      })
      for (let index = 0; index < policy.candidateCallsPerCase; index++) {
        const reservation = await ledger.admitPhysical(policy.candidateUsdPerDispatch, {
          profileId: policy.candidateProfileId,
          opaqueCaseId: 'case-0',
        })
        await ledger.recordDispatchIntent(reservation)
        await ledger.markDispatched(reservation)
        await ledger.settle(reservation, policy.candidateUsdPerDispatch)
      }
      await assert.rejects(
        ledger.admitPhysical(policy.candidateUsdPerDispatch, {
          profileId: policy.candidateProfileId,
          opaqueCaseId: 'case-0',
        }),
        /Per-case/u,
      )
      for (let index = 0; index < policy.controlCallsPerCase; index++) {
        const reservation = await ledger.admitPhysical(policy.controlUsdPerDispatch, {
          profileId: policy.controlProfileId,
          opaqueCaseId: 'case-1',
        })
        await ledger.recordDispatchIntent(reservation)
        await ledger.markDispatched(reservation)
        await ledger.settle(reservation, policy.controlUsdPerDispatch)
      }
      await assert.rejects(
        ledger.admitPhysical(policy.controlUsdPerDispatch, {
          profileId: policy.controlProfileId,
          opaqueCaseId: 'case-1',
        }),
        /Per-case/u,
      )
    }
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('legacy facade stays bound to legacy registration and rejects scope root and profile', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'dev-replay-legacy-facade-'))
  const root = join(outer, LEGACY_REPLAY_STUDY_ID, 'admission', 'successor-campaign')
  const extraSelector = {
    root,
    offlineTestOnly: true,
    protocolSha256: 'a'.repeat(64),
    caseIds: caseIds(),
    studyId: AUTHORED_SCOPE_STUDY_ID,
  }
  try {
    const legacy = await ProviderRefusalReplayLedger.register(extraSelector)
    assert.equal(legacy.snapshot().physicalDispatchCount, 202)
    await assert.rejects(
      legacy.admitPhysical(0.55, {
        profileId: replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID).candidateProfileId,
        opaqueCaseId: 'case-0',
      }),
      /outside the replay ledger/u,
    )
    const scopeRoot = join(outer, AUTHORED_SCOPE_STUDY_ID, 'admission', 'successor-campaign')
    await assert.rejects(
      ProviderRefusalReplayLedger.register({ ...extraSelector, root: scopeRoot }),
      /canonical new namespace/u,
    )
    const foreignOptions: unknown = {
      root: join(outer, 'foreign-study', 'admission', 'successor-campaign'),
      offlineTestOnly: true,
      studyId: 'foreign-study',
      protocolSha256: 'b'.repeat(64),
      caseIds: caseIds(),
    }
    await assert.rejects(
      Reflect.apply(DevReplayLedger.register, undefined, [foreignOptions]),
      /closed registry/u,
    )
    const missingSelectorOptions: unknown = {
      root: join(outer, AUTHORED_SCOPE_STUDY_ID, 'admission', 'successor-campaign'),
      offlineTestOnly: true,
      protocolSha256: 'c'.repeat(64),
      caseIds: caseIds(),
    }
    await assert.rejects(
      Reflect.apply(DevReplayLedger.register, undefined, [missingSelectorOptions]),
      /closed registry/u,
    )
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('shared pin reader verifies bytes, bounds, symlinks, and digest before returning data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-replay-files-'))
  const path = join(root, 'pinned.json')
  const alias = join(root, 'alias.json')
  const bytes = Buffer.from('{"safe":true}', 'utf8')
  try {
    await writeFile(path, bytes, { mode: 0o600 })
    const read = await readPinnedReplayFile(path, replaySha256(bytes), 128)
    assert.deepEqual(read, bytes)
    await symlink(path, alias)
    await assert.rejects(readPinnedReplayFile(alias, replaySha256(bytes), 128), /canonical/u)
    await assert.rejects(readPinnedReplayFile(path, replaySha256('wrong'), 128), /changed/u)
    await assert.rejects(readPinnedReplayFile(path, replaySha256(bytes), 4), /bounded/u)
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})

await test('closed replay CLI entry files stay inert on import and sanitize invalid commands', () => {
  const entries = [
    'benchmarks/v03/h8a-fresh-comparison/provider-refusal-replay-cli.ts',
    'benchmarks/v03/h8a-fresh-comparison/authored-scope-replay-cli.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-presence-replay-cli.ts',
  ]
  for (const entry of entries) {
    const imported = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', `import('./${entry}')`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout, '')
    const invoked = spawnSync(process.execPath, ['--import', 'tsx', entry, 'invalid-command'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(invoked.status, 1)
    assert.equal(invoked.stdout, '')
    assert.match(invoked.stderr, /^[A-Z0-9_:-]+\n$/u)
  }
})
