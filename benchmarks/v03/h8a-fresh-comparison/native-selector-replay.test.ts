import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nativeSelectorReplayProtocolSchema,
  parseReplayProtocolForStudy,
} from './dev-replay-admission.js'
import {
  NATIVE_SELECTOR_FREEZE_ID,
  NATIVE_SELECTOR_PARENT_AUDIT_PATH,
  NATIVE_SELECTOR_PARENT_AUDIT_SHA256,
  NATIVE_SELECTOR_POLICY,
  NATIVE_SELECTOR_PRICE_PROOF,
  NATIVE_SELECTOR_STUDY_ID,
  NATIVE_PRESENCE_POLICY,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'
import { assertClosedReplayRetargetIdentity } from './dev-replay-retarget.js'
import { makeAuthoredScopeProtocolFixture } from './dev-replay-test-fixtures.js'
import { PHASE_NATIVE_PRESENCE_DEV40_ID, PHASE_NATIVE_SELECTOR_DEV40_ID } from './constants.js'
import {
  PROFILE_CONTROL_ID,
  PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
  STRATUMS,
} from './constants.js'
import {
  buildSyntheticAnnotationBundle,
  buildSyntheticPhaseFreeze,
  buildConservativeCostProof,
} from './test-fixtures.js'
import { evaluatorPrivateAnnotationBundleSchema, phaseFreezeSchema } from './schemas.js'
import { immutableCloseoutSchema } from './schemas.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import { assertClosedReplayFreezeRetargeting } from './dev-replay-admission.js'
import { hashIdentity } from './hash-identity.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { validateImmutableCloseouts } from './evaluator.js'

await test('native-selector protocol closes the policy, parent, pricing and dispatch ceilings', () => {
  const scope = makeAuthoredScopeProtocolFixture()
  const protocol = nativeSelectorReplayProtocolSchema.parse({
    ...scope,
    schema: 'h8a-native-selector-replay-protocol-v1',
    studyId: NATIVE_SELECTOR_STUDY_ID,
    freezeId: NATIVE_SELECTOR_FREEZE_ID,
    parentAudit: {
      path: NATIVE_SELECTOR_PARENT_AUDIT_PATH,
      sha256: NATIVE_SELECTOR_PARENT_AUDIT_SHA256,
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
    parseReplayProtocolForStudy(NATIVE_SELECTOR_STUDY_ID, protocol).studyId,
    NATIVE_SELECTOR_STUDY_ID,
  )
  assert.throws(
    () =>
      parseReplayProtocolForStudy(NATIVE_SELECTOR_STUDY_ID, {
        ...protocol,
        selectionPolicy: { ...protocol.selectionPolicy, sha256: '0'.repeat(64) },
      }),
    /protocol does not match|invalid replay protocol/u,
  )
  const policy = replayStudyPolicy(NATIVE_SELECTOR_STUDY_ID)
  if (!('selectionPolicy' in policy) || !('priceProof' in policy))
    throw new RangeError(
      'Native-selector study policy is missing its closed selector or price proof',
    )
  assert.equal(
    policy.selectionPolicy.sha256,
    '67593b86c44a23231a191b04b2b453d608a2a79161080de7594050d1b4c7b4e0',
  )
  assert.equal(
    policy.priceProof.sha256,
    '433b8c9f8d91c3b52fd2cb08ceb6443a612124349aa3ea6425463e41002e1b4d',
  )
})

await test('native-selector only admits the pinned native-presence-to-selector phase edge', () => {
  assert.doesNotThrow(() =>
    assertClosedReplayRetargetIdentity(
      NATIVE_SELECTOR_STUDY_ID,
      PHASE_NATIVE_PRESENCE_DEV40_ID,
      NATIVE_SELECTOR_FREEZE_ID,
      PHASE_NATIVE_SELECTOR_DEV40_ID,
    ),
  )
  assert.throws(
    () =>
      assertClosedReplayRetargetIdentity(
        NATIVE_SELECTOR_STUDY_ID,
        PHASE_NATIVE_PRESENCE_DEV40_ID,
        NATIVE_SELECTOR_FREEZE_ID,
        'h8a-native-selector-qual120-v1',
      ),
    /registered study identity/u,
  )
})

await test('native-selector retarget changes only the pinned v5 phase identity and candidate cost proof', () => {
  const parentSeed = buildSyntheticPhaseFreeze(PHASE_NATIVE_PRESENCE_DEV40_ID).freeze
  const childSeed = buildSyntheticPhaseFreeze(PHASE_NATIVE_SELECTOR_DEV40_ID).freeze
  const parentAnnotations = evaluatorPrivateAnnotationBundleSchema.parse(
    buildSyntheticAnnotationBundle(
      PHASE_NATIVE_PRESENCE_DEV40_ID,
      'synthetic-native-parent-freeze',
      parentSeed.producerCases,
      parentSeed.pairedSchedule,
    ),
  )
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse({
    ...parentAnnotations,
    phaseId: PHASE_NATIVE_SELECTOR_DEV40_ID,
    freezeId: NATIVE_SELECTOR_FREEZE_ID,
  })
  const parentFreeze = phaseFreezeSchema.parse({
    ...parentSeed,
    freezeId: 'synthetic-native-parent-freeze',
    deadlineIso: '2026-11-02T12:11:51.738Z',
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(parentAnnotations),
    conservativeCostProof: buildConservativeCostProof(0.55, {
      candidateMaxUsdPerPhysicalDispatch: 0.55,
      controlMaxUsdPerPhysicalDispatch: 0.12,
      candidateProfileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
    }),
  })
  const costProofBody = {
    schema: 'h8a-fresh-conservative-cost-proof-v1' as const,
    proofKind: 'audited-upper-bound' as const,
    maxUsdPerPhysicalDispatch: 0.12,
    profileDispatchUpperBounds: [
      { profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, maxUsdPerPhysicalDispatch: 0.12 },
      { profileId: PROFILE_CONTROL_ID, maxUsdPerPhysicalDispatch: 0.12 },
    ],
    derivedFrom: `pinned-price-proof-sha256:${NATIVE_SELECTOR_PRICE_PROOF.sha256}`,
  }
  const costProof = { ...costProofBody, proofSha256: hashIdentity(costProofBody) }
  const childFreeze = phaseFreezeSchema.parse({
    ...parentFreeze,
    freezeId: NATIVE_SELECTOR_FREEZE_ID,
    phaseId: PHASE_NATIVE_SELECTOR_DEV40_ID,
    producerClosureSha256: 'c'.repeat(64),
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
    profileBindings: [childSeed.profileBindings[0]!, parentFreeze.profileBindings[1]!],
    conservativeCostProof: costProof,
    sourceStrataCommitments: STRATUMS.map((stratum) => {
      const sourceGroups = annotations.cases
        .filter((row) => row.stratum === stratum)
        .map((row) => row.sourceGroup)
      return {
        stratum,
        caseCount: sourceGroups.length,
        sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
          PHASE_NATIVE_SELECTOR_DEV40_ID,
          stratum,
          sourceGroups,
        ),
      }
    }),
  })
  assert.equal(childFreeze.producerCases.length, 40)
  assert.deepEqual(
    childFreeze.producerCases.map((row) => row.opaqueCaseId),
    parentFreeze.producerCases.map((row) => row.opaqueCaseId),
  )
  assert.deepEqual(
    childFreeze.pairedSchedule.map((row) => row.opaqueCaseId),
    parentFreeze.pairedSchedule.map((row) => row.opaqueCaseId),
  )
  assert.equal(childFreeze.profileBindings[0]?.profileId, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID)
  assert.equal(
    childFreeze.conservativeCostProof.profileDispatchUpperBounds[0]?.maxUsdPerPhysicalDispatch,
    0.12,
  )
  assert.equal(
    childFreeze.conservativeCostProof.profileDispatchUpperBounds[1]?.profileId,
    PROFILE_CONTROL_ID,
  )
  assertClosedReplayFreezeRetargeting(
    NATIVE_SELECTOR_STUDY_ID,
    parentFreeze,
    childFreeze,
    parentAnnotations,
    annotations,
    childFreeze.producerClosureSha256,
  )
  assert.throws(
    () =>
      assertClosedReplayFreezeRetargeting(
        NATIVE_SELECTOR_STUDY_ID,
        parentFreeze,
        phaseFreezeSchema.parse({
          ...childFreeze,
          conservativeCostProof: parentFreeze.conservativeCostProof,
        }),
        parentAnnotations,
        annotations,
        childFreeze.producerClosureSha256,
      ),
    /candidate and control/u,
  )
  const wrongPriceSourceBody = { ...costProofBody, derivedFrom: 'synthetic-test-proof' }
  assert.throws(
    () =>
      assertClosedReplayFreezeRetargeting(
        NATIVE_SELECTOR_STUDY_ID,
        parentFreeze,
        phaseFreezeSchema.parse({
          ...childFreeze,
          conservativeCostProof: {
            ...wrongPriceSourceBody,
            proofSha256: hashIdentity(wrongPriceSourceBody),
          },
        }),
        parentAnnotations,
        annotations,
        childFreeze.producerClosureSha256,
      ),
    /pinned fresh price proof/u,
  )
})

await test('immutable parent closeout verification hashes the producer body without schema', () => {
  const freezeSeed = buildSyntheticPhaseFreeze(PHASE_NATIVE_PRESENCE_DEV40_ID)
  const freeze = freezeSeed.freeze
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(
    buildSyntheticAnnotationBundle(
      PHASE_NATIVE_PRESENCE_DEV40_ID,
      freeze.freezeId,
      freeze.producerCases,
      freeze.pairedSchedule,
    ),
  )
  const freezeCommitmentSha256 = computePhaseFreezeCommitmentSha256(freeze)
  const makeCloseout = (index: 0 | 1) => {
    const binding = freeze.profileBindings[index]!
    const body = {
      freezeId: freeze.freezeId,
      freezeCommitmentSha256,
      phaseId: freeze.phaseId,
      profileId: binding.profileId,
      closedAtIso: '2026-11-01T00:00:00.000Z',
      cohortCommitmentSha256: freeze.cohortCommitmentSha256,
      producerClosureSha256: freeze.producerClosureSha256,
      recipeIdentitySha256: binding.recipeIdentitySha256,
      requestPolicyIdentitySha256: binding.requestPolicyIdentitySha256,
      outputRows: freeze.producerCases.map((producer) => ({
        schema: 'h8a-fresh-output-row-v1' as const,
        opaqueCaseId: producer.opaqueCaseId,
        profileId: binding.profileId,
        executionValidity: 'valid' as const,
        caseState:
          annotations.cases.find((row) => row.opaqueCaseId === producer.opaqueCaseId)
            ?.expectedPresence === 'present'
            ? ('not_found' as const)
            : ('negative_clean' as const),
        box: null,
        cutoutPresent: false,
        maskPackedSha256: null,
        logicalReceiptIds: [],
        physicalReceiptIds: [],
      })),
      logicalReceipts: [],
      physicalReceipts: [],
      logicalAttemptCount: 0,
      physicalDispatchCount: 0,
      uncertainDispatchCount: 0,
    }
    const closeoutBodySha256 = hashIdentity({
      freezeId: body.freezeId,
      freezeCommitmentSha256: body.freezeCommitmentSha256,
      phaseId: body.phaseId,
      profileId: body.profileId,
      closedAtIso: body.closedAtIso,
      cohortCommitmentSha256: body.cohortCommitmentSha256,
      producerClosureSha256: body.producerClosureSha256,
      recipeIdentitySha256: body.recipeIdentitySha256,
      requestPolicyIdentitySha256: body.requestPolicyIdentitySha256,
      outputRows: body.outputRows,
      logicalReceipts: body.logicalReceipts,
      physicalReceipts: body.physicalReceipts,
      logicalAttemptCount: body.logicalAttemptCount,
      physicalDispatchCount: body.physicalDispatchCount,
      uncertainDispatchCount: body.uncertainDispatchCount,
    })
    return immutableCloseoutSchema.parse({
      schema: 'h8a-fresh-immutable-closeout-v1',
      ...body,
      closeoutSha256: closeoutBodySha256,
    })
  }
  const candidateCloseout = makeCloseout(0)
  const controlCloseout = makeCloseout(1)
  assert.equal(candidateCloseout.schema, 'h8a-fresh-immutable-closeout-v1')
  assert.doesNotThrow(() =>
    validateImmutableCloseouts({ freeze, candidateCloseout, controlCloseout }),
  )
  const schemaIncludedHash = hashIdentity({
    schema: candidateCloseout.schema,
    freezeId: candidateCloseout.freezeId,
    freezeCommitmentSha256: candidateCloseout.freezeCommitmentSha256,
    phaseId: candidateCloseout.phaseId,
    profileId: candidateCloseout.profileId,
    closedAtIso: candidateCloseout.closedAtIso,
    cohortCommitmentSha256: candidateCloseout.cohortCommitmentSha256,
    producerClosureSha256: candidateCloseout.producerClosureSha256,
    recipeIdentitySha256: candidateCloseout.recipeIdentitySha256,
    requestPolicyIdentitySha256: candidateCloseout.requestPolicyIdentitySha256,
    outputRows: candidateCloseout.outputRows,
    logicalReceipts: candidateCloseout.logicalReceipts,
    physicalReceipts: candidateCloseout.physicalReceipts,
    logicalAttemptCount: candidateCloseout.logicalAttemptCount,
    physicalDispatchCount: candidateCloseout.physicalDispatchCount,
    uncertainDispatchCount: candidateCloseout.uncertainDispatchCount,
  })
  assert.notEqual(schemaIncludedHash, candidateCloseout.closeoutSha256)
  const incorrectlyHashedCandidate = immutableCloseoutSchema.parse({
    ...candidateCloseout,
    closeoutSha256: schemaIncludedHash,
  })
  assert.throws(
    () =>
      validateImmutableCloseouts({
        freeze,
        candidateCloseout: incorrectlyHashedCandidate,
        controlCloseout,
      }),
    /integrity hash mismatch/u,
  )
})
