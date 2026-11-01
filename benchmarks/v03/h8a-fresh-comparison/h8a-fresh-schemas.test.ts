import assert from 'node:assert/strict'
import test from 'node:test'
import { hashIdentity } from './hash-identity.js'
import {
  H8A_CANDIDATE_PROFILE,
  H8A_FLAT_CANDIDATE_PROFILE,
  H8A_SCOPE_CANDIDATE_PROFILE,
  H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE,
  V02_CONTROL_PROFILE,
} from './profiles.js'
import { phaseFreezeSchema, type PhaseFreeze } from './schemas.js'
import { assertNoForbiddenEvaluatorFields } from './forbidden-leakage.js'
import { buildConservativeCostProof, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import {
  assertFreezeAdmissionAsync,
  validateProfileIdentities,
  validateConservativeCostProof,
  validateQualificationSourceGroupSeparation,
} from './freeze-admission.js'
import { validateSourceGroupSplitSeparation } from './source-group-validation.js'
import {
  PHASE_DEV40_ID,
  PHASE_QUAL120_ID,
  PHASE_FLAT_DEV40_ID,
  PHASE_SCOPE_DEV40_ID,
  PHASE_SCOPE_QUAL120_ID,
  PHASE_NATIVE_PRESENCE_DEV40_ID,
  PHASE_NATIVE_PRESENCE_QUAL120_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  candidateIdForPhase,
} from './constants.js'

await test('phase freeze rejects unknown keys and wrong phase counts', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  assert.doesNotThrow(() => phaseFreezeSchema.parse(freeze))
  assert.throws(() => phaseFreezeSchema.parse({ ...freeze, unexpected: true }))
  assert.throws(() =>
    phaseFreezeSchema.parse({
      ...freeze,
      phaseCounts: { ...freeze.phaseCounts, totalCases: 119 },
    }),
  )
})

await test('qualification freeze precommits one exact 30-photo mask selection and one stratum row each', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  assert.equal(freeze.qualificationIndependentMaskCaseIds.length, 30)
  assert.throws(() =>
    phaseFreezeSchema.parse({
      ...freeze,
      qualificationIndependentMaskCaseIds: [
        ...freeze.qualificationIndependentMaskCaseIds,
        freeze.qualificationIndependentMaskCaseIds[0],
      ],
    }),
  )
  const uiIds = freeze.pairedSchedule
    .filter((item) => item.stratum === 'ui')
    .slice(0, 30)
    .map((item) => item.opaqueCaseId)
  assert.throws(() =>
    phaseFreezeSchema.parse({ ...freeze, qualificationIndependentMaskCaseIds: uiIds }),
  )
  assert.throws(() =>
    phaseFreezeSchema.parse({
      ...freeze,
      sourceStrataCommitments: [
        ...freeze.sourceStrataCommitments,
        freeze.sourceStrataCommitments[0],
      ],
    }),
  )
})

await test('profile identities depend on JSON insertion order', () => {
  const policy = H8A_CANDIDATE_PROFILE.requestPolicy
  const reorderedPolicy = {
    maxVisionChatPhysicalCallsPerCase: policy.maxVisionChatPhysicalCallsPerCase,
    caseDeadlineSeconds: policy.caseDeadlineSeconds,
    allowRetries: policy.allowRetries,
    allowProviderSort: policy.allowProviderSort,
    allowFallbacks: policy.allowFallbacks,
    reasoning: policy.reasoning,
    route: policy.route,
  }
  const originalHash = H8A_CANDIDATE_PROFILE.requestPolicyIdentitySha256
  const reorderedHash = hashIdentity(reorderedPolicy)
  assert.notEqual(originalHash, reorderedHash)
  assert.notEqual(
    H8A_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
    V02_CONTROL_PROFILE.requestPolicyIdentitySha256,
  )
})

await test('missing or invalid conservative cost proof rejects paid freeze validation', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  validateProfileIdentities(freeze)
  validateConservativeCostProof(freeze)
  const badProof = {
    ...freeze.conservativeCostProof,
    proofSha256: '0000000000000000000000000000000000000000000000000000000000000000',
  }
  assert.throws(() => validateConservativeCostProof({ ...freeze, conservativeCostProof: badProof }))
  const highPhaseBoundProof = buildConservativeCostProof(0.05)
  assert.doesNotThrow(() =>
    validateConservativeCostProof({
      ...freeze,
      conservativeCostProof: highPhaseBoundProof,
    }),
  )
})

await test('shared freeze admission passes only recognized candidate identities to study-scoped ledgers', async () => {
  const scoped: Array<[string, number]> = []
  const ledger = {
    snapshot: () => ({
      physicalDispatchCount: 0,
      logicalAttemptCount: 0,
      knownCostUsd: 0,
      unknownReserveUsd: 0,
      inFlightReservations: [],
      resumeBlocked: false,
    }),
    assertResumeAllowed() {},
    recordLogicalAttempt: async () => undefined,
    admitPhysical: async () => 1,
    recordDispatchIntent: async () => undefined,
    markDispatched: async () => 1,
    cancelBeforeFetch: async () => undefined,
    settle: async () => undefined,
    markCrashWithPendingDispatch: async () => undefined,
    assertCanAdmitPhysicalReservedUsd: async () => {
      assert.fail('successor admission must not bind to the first producer case')
    },
    assertStudyScopeCanAdmitPhysicalReservedUsd: async (profileId: string, reservedUsd: number) => {
      scoped.push([profileId, reservedUsd])
    },
    assertExposureAllowsAdditionalUsd: async () => undefined,
  }
  for (const [phaseId, candidateProfileId] of [
    [PHASE_FLAT_DEV40_ID, PROFILE_FLAT_CANDIDATE_ID],
    [PHASE_SCOPE_DEV40_ID, PROFILE_SCOPE_CANDIDATE_ID],
    [PHASE_NATIVE_PRESENCE_DEV40_ID, PROFILE_NATIVE_PRESENCE_CANDIDATE_ID],
  ] as const) {
    const { freeze } = buildSyntheticPhaseFreeze(phaseId)
    await assertFreezeAdmissionAsync(freeze, ledger)
    assert.deepEqual(
      scoped.splice(0).map(([profileId]) => profileId),
      [candidateProfileId, PROFILE_CONTROL_ID],
    )
  }
  const { freeze: rawFreeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  await assert.rejects(assertFreezeAdmissionAsync(rawFreeze, ledger), /registered .* profile/u)
})

await test('wrong recipe identity fails independent profile validation', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const tampered: PhaseFreeze = {
    ...freeze,
    profileBindings: [
      {
        ...freeze.profileBindings[0],
        recipeIdentitySha256: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      freeze.profileBindings[1],
    ],
  }
  assert.throws(() => validateProfileIdentities(tampered))
})

await test('repeated source groups within one split are allowed', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  assert.doesNotThrow(() => validateQualificationSourceGroupSeparation(freeze, ['g1', 'g1', 'g2']))
})

await test('source-group overlap across DEV and qualification splits is rejected', () => {
  assert.throws(() =>
    validateSourceGroupSplitSeparation({
      devSourceGroupIds: ['shared', 'dev-only'],
      qualificationSourceGroupIds: ['shared', 'qual-only'],
    }),
  )
  assert.doesNotThrow(() =>
    validateSourceGroupSplitSeparation({
      devSourceGroupIds: ['dev-a', 'dev-a'],
      qualificationSourceGroupIds: ['qual-b'],
    }),
  )
})

await test('producer payloads reject forbidden evaluator fields', () => {
  assert.throws(() =>
    assertNoForbiddenEvaluatorFields({ opaqueCaseId: 'x', sourceGroup: 'hidden' }, 'producer'),
  )
})

await test('flat comparison freeze has a separate phase and recipe identity with V1 candidate policy', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_FLAT_DEV40_ID)
  assert.doesNotThrow(() => phaseFreezeSchema.parse(freeze))
  validateProfileIdentities(freeze)
  validateConservativeCostProof(freeze)
  assert.equal(freeze.profileBindings[0]?.profileId, PROFILE_FLAT_CANDIDATE_ID)
  assert.equal(
    H8A_FLAT_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
    H8A_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
  )
  assert.notEqual(
    freeze.profileBindings[0]?.recipeIdentitySha256,
    buildSyntheticPhaseFreeze(PHASE_DEV40_ID).freeze.profileBindings[0]?.recipeIdentitySha256,
  )
  assert.throws(() =>
    phaseFreezeSchema.parse({
      ...freeze,
      profileBindings: [
        { ...freeze.profileBindings[0]!, profileId: PROFILE_CANDIDATE_ID },
        freeze.profileBindings[1],
      ],
    }),
  )
  const legacyReservation = buildConservativeCostProof(0.005)
  assert.throws(() =>
    validateConservativeCostProof({ ...freeze, conservativeCostProof: legacyReservation }),
  )
})

await test('authored-scope profile has a separate policy identity and accepts both new phase bindings', () => {
  assert.equal(
    H8A_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
    '0c9a1bff40a1ab4fed251a2b1f9f56b8b47325b8aa79e18875d8fbf549760a5e',
  )
  assert.equal(
    H8A_FLAT_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
    '0c9a1bff40a1ab4fed251a2b1f9f56b8b47325b8aa79e18875d8fbf549760a5e',
  )
  assert.equal(H8A_SCOPE_CANDIDATE_PROFILE.profileId, PROFILE_SCOPE_CANDIDATE_ID)
  assert.equal(H8A_SCOPE_CANDIDATE_PROFILE.requestPolicy.nativeRecipeId, PROFILE_FLAT_CANDIDATE_ID)
  assert.equal(H8A_SCOPE_CANDIDATE_PROFILE.requestPolicy.queryPolicyId, 'strict-authored-scope-v1')
  assert.equal(
    H8A_SCOPE_CANDIDATE_PROFILE.requestPolicy.queryPolicySha256,
    '8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc',
  )
  assert.notEqual(
    H8A_SCOPE_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
    H8A_FLAT_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
  )
  for (const phaseId of [PHASE_SCOPE_DEV40_ID, PHASE_SCOPE_QUAL120_ID]) {
    const { freeze } = buildSyntheticPhaseFreeze(phaseId)
    assert.equal(freeze.profileBindings[0]?.profileId, PROFILE_SCOPE_CANDIDATE_ID)
    assert.doesNotThrow(() => phaseFreezeSchema.parse(freeze))
    validateProfileIdentities(freeze)
    validateConservativeCostProof(freeze)
  }
  assert.throws(() => Reflect.apply(candidateIdForPhase, undefined, ['unknown-phase']))
})

await test('native-presence profile is closed, separately bound and carries the two fixed route caps', () => {
  assert.equal(
    H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE.profileId,
    PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
  )
  assert.equal(
    H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE.requestPolicy.nativeRecipeId,
    PROFILE_FLAT_CANDIDATE_ID,
  )
  assert.equal(
    H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE.requestPolicy.nativePresenceRoute.apiEndpoint,
    '/api/alpha/decisions',
  )
  assert.equal(
    H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE.requestPolicy.nativePresenceRoute.maxPhysicalCallsPerCase,
    1,
  )
  assert.equal(
    H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE.requestPolicy.route.apiEndpoint,
    '/api/v1/chat/completions',
  )
  assert.equal(
    H8A_NATIVE_PRESENCE_CANDIDATE_PROFILE.requestPolicy.maxVisionChatPhysicalCallsPerCase,
    3,
  )
  for (const phaseId of [PHASE_NATIVE_PRESENCE_DEV40_ID, PHASE_NATIVE_PRESENCE_QUAL120_ID]) {
    const { freeze } = buildSyntheticPhaseFreeze(phaseId)
    assert.equal(freeze.profileBindings[0]?.profileId, PROFILE_NATIVE_PRESENCE_CANDIDATE_ID)
    assert.equal(freeze.conservativeCostProof.maxUsdPerPhysicalDispatch, 0.55)
    assert.equal(
      freeze.conservativeCostProof.profileDispatchUpperBounds[0].maxUsdPerPhysicalDispatch,
      0.55,
    )
    assert.equal(
      freeze.conservativeCostProof.profileDispatchUpperBounds[1].maxUsdPerPhysicalDispatch,
      0.12,
    )
    assert.doesNotThrow(() => phaseFreezeSchema.parse(freeze))
    validateProfileIdentities(freeze)
    validateConservativeCostProof(freeze)
  }
})
