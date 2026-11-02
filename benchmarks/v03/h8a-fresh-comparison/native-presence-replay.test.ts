import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AUTHORED_SCOPE_STUDY_ID,
  NATIVE_PRESENCE_FREEZE_ID,
  NATIVE_PRESENCE_POLICY,
  NATIVE_PRESENCE_ROOT,
  NATIVE_PRESENCE_STUDY_ID,
  NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  NATIVE_SELECTOR_STUDY_ID,
  REPLAY_STUDY_REGISTRY,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'
import {
  nativePresenceReplayProtocolSchema,
  parseClosedReplayProtocol,
  parseReplayProtocolForStudy,
} from './dev-replay-admission.js'
import { makeAuthoredScopeProtocolFixture } from './dev-replay-test-fixtures.js'
import {
  replayRuntimeBinding,
  assertRequiredReplayClosure,
  REQUIRED_REPLAY_CLOSURE_PATHS,
} from './dev-replay-cli.js'
import { DevReplayLedger, validateAuthoredScopeReplayParentPair } from './dev-replay-ledger.js'
import { PROFILE_NATIVE_PRESENCE_CANDIDATE_ID } from './constants.js'
import { PHASE_NATIVE_PRESENCE_DEV40_ID } from './constants.js'
import { buildSyntheticPhaseFreeze } from './test-fixtures.js'
import { buildDev40Annotations } from './test-fixtures.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import { assertClosedReplayRetargetIdentity } from './dev-replay-retarget.js'
import { assertClosedReplayFreezeRetargeting } from './dev-replay-admission.js'
import { buildSyntheticAnnotationBundle } from './test-fixtures.js'
import { phaseFreezeSchema, evaluatorPrivateAnnotationBundleSchema } from './schemas.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import { STRATUMS } from './constants.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import { hashIdentity } from './hash-identity.js'
import { validateConservativeCostProof } from './freeze-admission.js'

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')

await test('native presence is a third closed study and retains its separate binary policy identity', () => {
  assert.deepEqual(Object.keys(REPLAY_STUDY_REGISTRY), [
    'provider-refusal-dev40-replay-v1',
    AUTHORED_SCOPE_STUDY_ID,
    NATIVE_PRESENCE_STUDY_ID,
    NATIVE_SELECTOR_STUDY_ID,
    NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  ])
  const policy = replayStudyPolicy(NATIVE_PRESENCE_STUDY_ID)
  assert.equal(policy.freezeId, NATIVE_PRESENCE_FREEZE_ID)
  assert.equal(policy.canonicalRoot, NATIVE_PRESENCE_ROOT)
  assert.equal(policy.candidateProfileId, PROFILE_NATIVE_PRESENCE_CANDIDATE_ID)
  assert.equal(policy.inheritedPhysicalCalls, 276)
  assert.equal(policy.inheritedLogicalAttempts, 87)
  assert.equal(policy.nextPhysicalId, 277)
  assert.deepEqual(policy.presencePolicy, NATIVE_PRESENCE_POLICY)
  assert.equal(policy.queryPolicy?.policyId, 'strict-authored-scope-v1')
  assert.deepEqual(replayRuntimeBinding(NATIVE_PRESENCE_STUDY_ID), {
    candidateProfileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
    recipeId: 'h8a-cpu-flat-target-v2',
    queryPolicyId: 'strict-authored-scope-v1',
    presencePolicyId: 'control-binary-v1',
  })
})

await test('native protocol requires the exact selected study and both distinct policy identities', () => {
  const scope = makeAuthoredScopeProtocolFixture()
  const fixture = nativePresenceReplayProtocolSchema.parse({
    ...scope,
    schema: 'h8a-native-presence-replay-protocol-v1',
    studyId: NATIVE_PRESENCE_STUDY_ID,
    freezeId: NATIVE_PRESENCE_FREEZE_ID,
    parentAudit: {
      path: replayStudyPolicy(NATIVE_PRESENCE_STUDY_ID).parentAuditPath,
      sha256: replayStudyPolicy(NATIVE_PRESENCE_STUDY_ID).parentAuditSha256,
    },
    presencePolicy: NATIVE_PRESENCE_POLICY,
  })
  assert.equal(parseClosedReplayProtocol(fixture).studyId, NATIVE_PRESENCE_STUDY_ID)
  assert.equal(
    parseReplayProtocolForStudy(NATIVE_PRESENCE_STUDY_ID, fixture).studyId,
    NATIVE_PRESENCE_STUDY_ID,
  )
  assert.throws(() => parseReplayProtocolForStudy(AUTHORED_SCOPE_STUDY_ID, fixture))
  assert.throws(() =>
    nativePresenceReplayProtocolSchema.parse({
      ...fixture,
      presencePolicy: { ...NATIVE_PRESENCE_POLICY, sha256: '0'.repeat(64) },
    }),
  )
  assert.throws(() =>
    nativePresenceReplayProtocolSchema.parse({ ...fixture, privateTruth: { labels: [] } }),
  )
})

function parentPair() {
  const parent = replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID)
  const nativePresence = replayStudyPolicy(NATIVE_PRESENCE_STUDY_ID)
  const registrationBody = {
    schema: parent.registrationSchema,
    studyId: parent.studyId,
    freezeId: parent.freezeId,
    protocolSha256: '1'.repeat(64),
    parentAuditSha256: parent.parentAuditSha256,
    parentLedgerSha256: parent.parentLedgerSha256,
    parentLedgerVersion: parent.parentLedgerVersion,
    canonicalRoot: dirname(nativePresence.parentRegistrationPath!),
    caseIds: Array.from({ length: 40 }, (_, index) => `parent-case-${index}`),
    maxPhysicalCalls: 2_000,
    dev40MaxPhysicalCalls: parent.incrementalCallLimit,
    dev40MaxIncrementalUsd: parent.incrementalExposureUsd,
    candidateMaxUsdPerDispatch: parent.candidateUsdPerDispatch,
    controlMaxUsdPerDispatch: parent.controlUsdPerDispatch,
    ownerDollarCeilingUsd: null,
    retries: 0,
  }
  const registration = {
    ...registrationBody,
    registrationSha256: sha256(JSON.stringify(registrationBody)),
  }
  const ledger = {
    schema: parent.ledgerSchema,
    ledgerVersion: 161,
    registrationSha256: registration.registrationSha256,
    nextReservationId: 277,
    nextPhysicalId: 277,
    physicalDispatchCount: 276,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: 87,
    knownCostUsd: 0.17121459,
    unknownReserveUsd: 0.24,
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
    integrityBlocked: false,
  }
  return { ledger, registration }
}

await test('native parent admission verifies the authored-scope registration and state as one pair', () => {
  const { ledger, registration } = parentPair()
  const accepted = validateAuthoredScopeReplayParentPair(
    ledger,
    registration,
    NATIVE_PRESENCE_STUDY_ID,
  )
  assert.equal(accepted.ledgerVersion, 161)
  assert.equal(accepted.physicalDispatchCount, 276)
  assert.equal(accepted.logicalAttemptCount, 87)
  assert.equal(accepted.maxPhysicalCalls, 2_000)
  assert.equal(accepted.nextPhysicalId, 277)
  assert.throws(() =>
    validateAuthoredScopeReplayParentPair(
      ledger,
      { ...registration, registrationSha256: '0'.repeat(64) },
      NATIVE_PRESENCE_STUDY_ID,
    ),
  )
  assert.throws(() =>
    validateAuthoredScopeReplayParentPair(
      { ...ledger, maxPhysicalCalls: 2_000 },
      registration,
      NATIVE_PRESENCE_STUDY_ID,
    ),
  )
  assert.throws(() =>
    validateAuthoredScopeReplayParentPair(
      ledger,
      { ...registration, maxPhysicalCalls: 1_999 },
      NATIVE_PRESENCE_STUDY_ID,
    ),
  )
  assert.throws(() =>
    validateAuthoredScopeReplayParentPair(
      ledger,
      {
        ...registration,
        caseIds: [...registration.caseIds.slice(0, 39), registration.caseIds[0]!],
        registrationSha256: 'f'.repeat(64),
      },
      NATIVE_PRESENCE_STUDY_ID,
    ),
  )
})

await test('offline native ledger inherits global counters and begins from the next unique physical ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-presence-replay-'))
  const root = join(directory, NATIVE_PRESENCE_STUDY_ID, 'admission', 'successor-campaign')
  try {
    const ledger = await DevReplayLedger.register({
      studyId: NATIVE_PRESENCE_STUDY_ID,
      root,
      offlineTestOnly: true,
      protocolSha256: sha256('synthetic-only-protocol'),
      caseIds: Array.from({ length: 40 }, (_, index) => `offline-case-${index}`),
    })
    assert.deepEqual(ledger.snapshot(), {
      physicalDispatchCount: 276,
      logicalAttemptCount: 87,
      knownCostUsd: 0.17121459,
      unknownReserveUsd: 0.24,
      inFlightReservations: [],
      resumeBlocked: false,
    })
    const registration = JSON.parse(await readFile(join(root, 'registration.json'), 'utf8')) as {
      nextPhysicalId?: number
      maxPhysicalCalls?: number
      dev40MaxPhysicalCalls?: number
    }
    const state = JSON.parse(await readFile(join(root, 'campaign-ledger.json'), 'utf8')) as {
      nextPhysicalId?: number
      physicalDispatchCount?: number
      dev40PhysicalCalls?: number
      caseCounts?: unknown[]
      logicalAttempts?: unknown[]
    }
    assert.equal(registration.maxPhysicalCalls, 2_000)
    assert.equal(registration.dev40MaxPhysicalCalls, 400)
    assert.equal(state.nextPhysicalId, 277)
    assert.equal(state.physicalDispatchCount, 276)
    assert.equal(state.dev40PhysicalCalls, 0)
    assert.deepEqual(state.caseCounts, [])
    assert.deepEqual(state.logicalAttempts, [])
    const candidateCaseId = 'offline-case-0'
    const policy = replayStudyPolicy(NATIVE_PRESENCE_STUDY_ID)
    await ledger.recordLogicalAttempt({
      profileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
      opaqueCaseId: candidateCaseId,
    })
    const reservationId = await ledger.admitPhysical(policy.candidateUsdPerDispatch, {
      profileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
      opaqueCaseId: candidateCaseId,
    })
    await ledger.recordDispatchIntent(reservationId)
    assert.equal(await ledger.markDispatched(reservationId), 277)
    await ledger.settle(reservationId, null)
    for (let call = 1; call < policy.candidateCallsPerCase; call++) {
      const nextReservation = await ledger.admitPhysical(policy.candidateUsdPerDispatch, {
        profileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
        opaqueCaseId: candidateCaseId,
      })
      await ledger.recordDispatchIntent(nextReservation)
      await ledger.markDispatched(nextReservation)
      await ledger.settle(nextReservation, 0)
    }
    await assert.rejects(
      ledger.admitPhysical(policy.candidateUsdPerDispatch, {
        profileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
        opaqueCaseId: candidateCaseId,
      }),
      /ceiling/u,
    )
    for (let call = 0; call < policy.controlCallsPerCase; call++) {
      const nextReservation = await ledger.admitPhysical(policy.controlUsdPerDispatch, {
        profileId: policy.controlProfileId,
        opaqueCaseId: 'offline-case-1',
      })
      await ledger.recordDispatchIntent(nextReservation)
      await ledger.markDispatched(nextReservation)
      await ledger.settle(nextReservation, 0)
    }
    await assert.rejects(
      ledger.admitPhysical(policy.controlUsdPerDispatch, {
        profileId: policy.controlProfileId,
        opaqueCaseId: 'offline-case-1',
      }),
      /ceiling/u,
    )
    const afterUnknownSettlement = ledger.snapshot()
    assert.equal(afterUnknownSettlement.physicalDispatchCount, 286)
    assert.equal(afterUnknownSettlement.logicalAttemptCount, 88)
    assert.equal(afterUnknownSettlement.unknownReserveUsd, 0.79)
    assert.deepEqual(afterUnknownSettlement.inFlightReservations, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('native closure requirements are selected only for the native study', () => {
  const required = [
    ...REQUIRED_REPLAY_CLOSURE_PATHS,
    'benchmarks/v03/h8a-fresh-comparison/native-presence-replay-cli.ts',
    'benchmarks/v03/h8a-fresh-comparison/dev-replay-retarget.ts',
    'benchmarks/v03/h8a-fresh-comparison/runtime-recording.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-presence-evidence.ts',
    'benchmarks/v03/h6-presence-policy.ts',
    'docs/research/v03-native-presence-hypothesis.ru.md',
  ]
  assert.doesNotThrow(() => assertRequiredReplayClosure(required, NATIVE_PRESENCE_STUDY_ID))
  assert.throws(() => assertRequiredReplayClosure(required.slice(0, -1), NATIVE_PRESENCE_STUDY_ID))
  assert.doesNotThrow(() => assertRequiredReplayClosure(REQUIRED_REPLAY_CLOSURE_PATHS))
})

await test('native presence uses the existing deterministic DEV screen and only its registered retarget edge', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_NATIVE_PRESENCE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const selection = buildDevScreenSelection(freeze, annotations)
  assert.equal(selection.profileBindings[0]?.profileId, PROFILE_NATIVE_PRESENCE_CANDIDATE_ID)
  assert.equal(selection.dev8CaseIds.length, 8)
  assert.equal(selection.dev12CaseIds.length, 12)
  assert.doesNotThrow(() =>
    assertClosedReplayRetargetIdentity(
      NATIVE_PRESENCE_STUDY_ID,
      'h8a-scope-paired-dev40-v1',
      NATIVE_PRESENCE_FREEZE_ID,
      PHASE_NATIVE_PRESENCE_DEV40_ID,
    ),
  )
  assert.throws(() =>
    Reflect.apply(assertClosedReplayRetargetIdentity, undefined, [
      'provider-refusal-dev40-replay-v1',
      'h8a-flat-paired-dev40-v1',
      'h8a-provider-refusal-dev40-replay-20261101-v1',
      'h8a-scope-paired-dev40-v1',
    ]),
  )
})

await test('native freeze retargeting preserves source, truth, masks, schedule, control, and quality limits', () => {
  const parentSeed = buildSyntheticPhaseFreeze('h8a-scope-paired-dev40-v1').freeze
  const nativeSeed = buildSyntheticPhaseFreeze(PHASE_NATIVE_PRESENCE_DEV40_ID).freeze
  const parentAnnotations = evaluatorPrivateAnnotationBundleSchema.parse(
    buildSyntheticAnnotationBundle(
      parentSeed.phaseId,
      parentSeed.freezeId,
      parentSeed.producerCases,
      parentSeed.pairedSchedule,
    ),
  )
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse({
    ...parentAnnotations,
    phaseId: PHASE_NATIVE_PRESENCE_DEV40_ID,
    freezeId: NATIVE_PRESENCE_FREEZE_ID,
  })
  const parentCostProofBody = {
    schema: parentSeed.conservativeCostProof.schema,
    proofKind: parentSeed.conservativeCostProof.proofKind,
    maxUsdPerPhysicalDispatch: 0.55,
    profileDispatchUpperBounds: [
      {
        ...parentSeed.conservativeCostProof.profileDispatchUpperBounds[0]!,
        maxUsdPerPhysicalDispatch: 0.55,
      },
      {
        ...parentSeed.conservativeCostProof.profileDispatchUpperBounds[1]!,
        maxUsdPerPhysicalDispatch: 0.12,
      },
    ],
    derivedFrom: parentSeed.conservativeCostProof.derivedFrom,
  }
  const parentCostProof = { ...parentCostProofBody, proofSha256: hashIdentity(parentCostProofBody) }
  const nextCostProofBody = {
    ...parentCostProofBody,
    profileDispatchUpperBounds: [
      {
        ...parentCostProofBody.profileDispatchUpperBounds[0]!,
        profileId: PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
      },
      parentCostProofBody.profileDispatchUpperBounds[1],
    ],
  }
  const nextCostProof = { ...nextCostProofBody, proofSha256: hashIdentity(nextCostProofBody) }
  const parentFreeze = phaseFreezeSchema.parse({
    ...parentSeed,
    conservativeCostProof: parentCostProof,
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
    deadlineIso: '2026-11-02T12:11:51.738Z',
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(parentAnnotations),
  })
  const nextFreeze = phaseFreezeSchema.parse({
    ...parentFreeze,
    freezeId: NATIVE_PRESENCE_FREEZE_ID,
    phaseId: PHASE_NATIVE_PRESENCE_DEV40_ID,
    producerClosureSha256: 'c'.repeat(64),
    profileBindings: [nativeSeed.profileBindings[0]!, parentFreeze.profileBindings[1]!],
    conservativeCostProof: nextCostProof,
    sourceStrataCommitments: STRATUMS.map((stratum) => {
      const sourceGroups = annotations.cases
        .filter((row) => row.stratum === stratum)
        .map((row) => row.sourceGroup)
      return {
        stratum,
        caseCount: sourceGroups.length,
        sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
          PHASE_NATIVE_PRESENCE_DEV40_ID,
          stratum,
          sourceGroups,
        ),
      }
    }),
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  })
  assert.doesNotThrow(() =>
    assertClosedReplayFreezeRetargeting(
      NATIVE_PRESENCE_STUDY_ID,
      parentFreeze,
      nextFreeze,
      parentAnnotations,
      annotations,
      'c'.repeat(64),
    ),
  )
  assert.doesNotThrow(() => validateConservativeCostProof(nextFreeze))
  const changedTarget = structuredClone(nextFreeze)
  changedTarget.producerCases[0]!.targetTaskText = 'changed target must be rejected'
  assert.throws(() =>
    assertClosedReplayFreezeRetargeting(
      NATIVE_PRESENCE_STUDY_ID,
      parentFreeze,
      changedTarget,
      parentAnnotations,
      annotations,
      'c'.repeat(64),
    ),
  )
})
