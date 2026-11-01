import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AUTHORED_SCOPE_FREEZE_ID,
  AUTHORED_SCOPE_QUERY_POLICY,
  AUTHORED_SCOPE_STUDY_ID,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'
import {
  authoredScopeReplayProtocolSchema,
  parseReplayProtocolForStudy,
  type VerifiedAuthoredScopeReplayAdmission,
} from './dev-replay-admission.js'
import { runAuthoredScopeReplayCli } from './authored-scope-replay-cli.js'
import {
  assertRequiredReplayClosure,
  REQUIRED_REPLAY_CLOSURE_PATHS,
  replayRuntimeBinding,
  runDevReplayCli,
  runProviderRefusalReplayCli,
  type DevReplayOfflineCliHooks,
  writePinnedReplayArtifact,
} from './dev-replay-cli.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import {
  PHASE_SCOPE_DEV40_ID,
  PROFILE_CONTROL_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
} from './constants.js'
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
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { buildDevScreenSelection, DEV_SCREEN_SEED } from './dev-screen-sampling.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { phaseFreezeSchema } from './schemas.js'
import { devScreenReportSchema, buildCaseArtifactIdentity } from './dev-screen-runner.js'
import { hashIdentity } from './hash-identity.js'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import { DevReplayLedger } from './dev-replay-ledger.js'
import { z } from 'zod'

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')
const deadlineIso = '2026-11-02T12:11:51.738Z'

await test('production runtime binding pins scope profile, flat native recipe and strict query policy', () => {
  assert.deepEqual(replayRuntimeBinding(AUTHORED_SCOPE_STUDY_ID), {
    candidateProfileId: PROFILE_SCOPE_CANDIDATE_ID,
    recipeId: 'h8a-cpu-flat-target-v2',
    queryPolicyId: 'strict-authored-scope-v1',
  })
  assert.deepEqual(replayRuntimeBinding('provider-refusal-dev40-replay-v1'), {
    candidateProfileId: 'h8a-cpu-flat-target-v2',
    recipeId: 'h8a-cpu-flat-target-v2',
    queryPolicyId: 'legacy-v1',
  })
  assert.throws(
    () => Reflect.apply(replayRuntimeBinding, undefined, ['not-a-registered-study']),
    /closed registry/u,
  )
})

await test('production closure gate rejects omissions of shared CLI, query policy and evaluator', () => {
  for (const omitted of [
    'benchmarks/v03/h8a-fresh-comparison/dev-replay-cli.ts',
    'benchmarks/v03/h6-query-policy.ts',
    'benchmarks/v03/h6-context-composer.ts',
    'benchmarks/v03/h8a-fresh-comparison/evaluator.ts',
  ]) {
    assert.throws(
      () =>
        assertRequiredReplayClosure(
          REQUIRED_REPLAY_CLOSURE_PATHS.filter((path) => path !== omitted),
        ),
      /closure omits/u,
    )
  }
})

await test('shared CLI rejects an unknown runtime study ID before protocol file access', async () => {
  const args = [
    'register',
    '--protocol',
    '/tmp/no-such-replay-protocol.json',
    '--protocol-sha256',
    sha256('pin'),
  ]
  await assert.rejects(
    Promise.resolve(Reflect.apply(runDevReplayCli, undefined, ['unknown-study', args, tmpdir()])),
    /closed registry/u,
  )
})

function assertScopeAdmission(
  admission: Parameters<DevReplayOfflineCliHooks['executeScreen']>[0],
): asserts admission is VerifiedAuthoredScopeReplayAdmission {
  assert.equal(admission.protocol.studyId, AUTHORED_SCOPE_STUDY_ID)
  if (admission.protocol.studyId !== AUTHORED_SCOPE_STUDY_ID)
    throw new RangeError('Scope fixture received a foreign admission')
}

test.beforeEach((context) => {
  if ('mock' in context)
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T00:00:00.000Z') })
})
test.afterEach((context) => {
  if ('mock' in context) context.mock.timers.reset()
})

async function makeScopeFixture(directory: string, materializeArtifactRows = false) {
  const namespaceRoot = join(directory, 'authored-scope-dev40-v1')
  const base = buildSyntheticPhaseFreeze(PHASE_SCOPE_DEV40_ID)
  const annotations = buildSyntheticAnnotationBundle(
    PHASE_SCOPE_DEV40_ID,
    AUTHORED_SCOPE_FREEZE_ID,
    base.freeze.producerCases,
    base.freeze.pairedSchedule,
  )
  const closureBytes = Buffer.from(
    '{"schema":"h8a-producer-closure-files-v1","sourceCommit":"605354e298ffa0a5b7f6a002e23cb690a4296345","files":[]}',
    'utf8',
  )
  const closureSha256 = sha256(closureBytes)
  const freeze = phaseFreezeSchema.parse({
    ...base.freeze,
    freezeId: AUTHORED_SCOPE_FREEZE_ID,
    deadlineIso,
    producerClosureSha256: closureSha256,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
  })
  const selection = buildDevScreenSelection(freeze, annotations)
  const freezeBytes = Buffer.from(JSON.stringify(freeze))
  const annotationBytes = Buffer.from(JSON.stringify(annotations))
  const selectionBytes = Buffer.from(JSON.stringify(selection))
  const freezePath = join(directory, 'freeze.json')
  const annotationsPath = join(directory, 'annotations.json')
  const selectionPath = join(directory, 'selection.json')
  const closurePath = join(directory, 'closure.json')
  await Promise.all([
    writeFile(freezePath, freezeBytes),
    writeFile(annotationsPath, annotationBytes),
    writeFile(selectionPath, selectionBytes),
    writeFile(closurePath, closureBytes),
  ])
  const policy = replayStudyPolicy(AUTHORED_SCOPE_STUDY_ID)
  const protocol = authoredScopeReplayProtocolSchema.parse({
    schema: 'h8a-authored-scope-replay-protocol-v1',
    studyId: AUTHORED_SCOPE_STUDY_ID,
    freezeId: AUTHORED_SCOPE_FREEZE_ID,
    deadlineIso,
    parentAudit: { path: policy.parentAuditPath, sha256: policy.parentAuditSha256 },
    sourceAudit: {
      path: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
    },
    freeze: { path: freezePath, sha256: sha256(freezeBytes) },
    annotations: { path: annotationsPath, sha256: sha256(annotationBytes) },
    selection: { path: selectionPath, sha256: sha256(selectionBytes) },
    producerClosure: { path: closurePath, sha256: closureSha256 },
    runtimeProof: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
    },
    runtimeEnvironment: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
      sha256: UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
    },
    sourceBytes: freeze.producerCases.map((row) => ({
      caseId: row.opaqueCaseId,
      path: join(directory, `${row.opaqueCaseId}.png`),
      sha256: row.sourceBytesSha256,
      bytes: base.sourceBytesByCaseId.get(row.opaqueCaseId)!.byteLength,
    })),
    referenceMasks: Array.from({ length: 16 }, (_, index) => ({
      path: join(directory, `mask-${index}.bin`),
      sha256: sha256(`scope-mask-${index}`),
      packedBinarySha256: sha256(`scope-mask-packed-${index}`),
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
  const protocolBytes = Buffer.from(JSON.stringify(protocol))
  const protocolPath = join(directory, 'protocol.json')
  await writeFile(protocolPath, protocolBytes)
  const sourceBytes = new Map(base.sourceBytesByCaseId)
  const admission: VerifiedAuthoredScopeReplayAdmission = {
    protocol,
    protocolSha256: sha256(protocolBytes),
    freeze,
    annotations,
    selection,
    sourceBytes,
    referenceMaskBytes: new Map(),
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
  }
  const hooks: DevReplayOfflineCliHooks = {
    offlineTestOnly: true,
    studyId: AUTHORED_SCOPE_STUDY_ID,
    namespaceRoot,
    admission,
    getApiKey: () => 'test-only-marker',
    executeScreen: async (activeAdmission, stage) => {
      assertScopeAdmission(activeAdmission)
      if (materializeArtifactRows && stage === 'dev8') {
        const ledger = await DevReplayLedger.register({
          root: join(namespaceRoot, 'admission', 'successor-campaign'),
          offlineTestOnly: true,
          studyId: AUTHORED_SCOPE_STUDY_ID,
          protocolSha256: activeAdmission.protocolSha256,
          caseIds: activeAdmission.freeze.producerCases.map((row) => row.opaqueCaseId),
        })
        const store = new ImmutableCaseArtifactStore(join(namespaceRoot, 'execution'))
        for (const producer of activeAdmission.freeze.producerCases) {
          for (const profileId of [PROFILE_SCOPE_CANDIDATE_ID, PROFILE_CONTROL_ID] as const) {
            await ledger.recordLogicalAttempt({ profileId, opaqueCaseId: producer.opaqueCaseId })
            const identity = buildCaseArtifactIdentity(
              activeAdmission.freeze,
              activeAdmission.selection,
              producer,
              profileId,
            )
            const startedAtIso = '2026-11-01T00:00:00.000Z'
            const opened = await store.begin(identity, startedAtIso)
            await store.complete({
              identitySha256: opened.identitySha256,
              identity: opened.identity,
              result: {
                outputRow: {
                  schema: 'h8a-fresh-output-row-v1',
                  opaqueCaseId: producer.opaqueCaseId,
                  profileId,
                  executionValidity: 'valid',
                  caseState:
                    activeAdmission.annotations.cases.find(
                      (item) => item.opaqueCaseId === producer.opaqueCaseId,
                    )?.expectedPresence === 'present'
                      ? 'not_found'
                      : 'negative_clean',
                  box: null,
                  cutoutPresent: false,
                  maskPackedSha256: null,
                  logicalReceiptIds: [],
                  physicalReceiptIds: [],
                },
                logicalReceipts: [],
                physicalReceipts: [],
              },
              durationMs: 1,
              startedAtIso,
              completedAtIso: startedAtIso,
              knownCostUsd: 0,
              unknownDispatchCount: 0,
              blobs: new Map(),
            })
          }
        }
      }
      return makeReport(activeAdmission, stage)
    },
  }
  return {
    namespaceRoot,
    protocolPath,
    protocolSha256: sha256(protocolBytes),
    admission,
    hooks,
    freezeBytes,
    sourceBytes,
  }
}

function makeReport(
  admission: VerifiedAuthoredScopeReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
) {
  const perCell = (['photo', 'ui', 'map'] as const).flatMap((stratum) =>
    (['present', 'absent'] as const).map((expectedPresence) => ({
      stratum,
      expectedPresence,
      quota: 1,
      inclusionProbability: 1,
      candidatePositiveSuccesses: 0,
      controlPositiveSuccesses: 0,
      candidateNegativeFalse: 0,
      controlNegativeFalse: 0,
      weightedCandidatePositiveSuccessTotal: 0,
      weightedControlPositiveSuccessTotal: 0,
      weightedCandidatePositiveFailureTotal: 0,
      weightedControlPositiveFailureTotal: 0,
      weightedCandidateNegativeFalseTotal: 0,
      weightedControlNegativeFalseTotal: 0,
      observedPositivePairs: 0,
      observedNegativePairs: 0,
      observedCandidatePositiveRows: 0,
      observedControlPositiveRows: 0,
      observedCandidateNegativeRows: 0,
      observedControlNegativeRows: 0,
    })),
  )
  const ids =
    stage === 'dev8'
      ? admission.selection.dev8CaseIds
      : stage === 'dev12'
        ? admission.selection.dev12CaseIds
        : admission.freeze.producerCases.map((item) => item.opaqueCaseId)
  const outputs = ids.map((opaqueCaseId) => {
    const producer = admission.freeze.producerCases.find(
      (item) => item.opaqueCaseId === opaqueCaseId,
    )!
    const annotation = admission.annotations.cases.find(
      (item) => item.opaqueCaseId === opaqueCaseId,
    )!
    const stratum = admission.freeze.pairedSchedule.find(
      (item) => item.opaqueCaseId === opaqueCaseId,
    )!.stratum
    return {
      opaqueCaseId,
      stratum,
      expectedPresence: annotation.expectedPresence,
      candidateCaseState:
        annotation.expectedPresence === 'present' ? 'not_found' : 'negative_clean',
      controlCaseState: annotation.expectedPresence === 'present' ? 'not_found' : 'negative_clean',
      candidatePositiveSuccess: false,
      controlPositiveSuccess: false,
      candidateNegativeFalse: false,
      controlNegativeFalse: false,
      candidateIdentitySha256: hashIdentity(
        buildCaseArtifactIdentity(
          admission.freeze,
          admission.selection,
          producer,
          PROFILE_SCOPE_CANDIDATE_ID,
        ),
      ),
      controlIdentitySha256: hashIdentity(
        buildCaseArtifactIdentity(
          admission.freeze,
          admission.selection,
          producer,
          PROFILE_CONTROL_ID,
        ),
      ),
    }
  })
  const pairs = stage === 'dev8' ? 8 : stage === 'dev12' ? 12 : 40
  const body = devScreenReportSchema.omit({ reportSha256: true }).parse({
    schema: 'h8a-dev-screen-report-v1',
    screen: stage,
    freezeCommitmentSha256: admission.freezeCommitmentSha256,
    selectionCommitmentSha256: admission.selection.selectionCommitmentSha256,
    seed: DEV_SCREEN_SEED,
    completedPairs: pairs,
    expectedPairs: pairs,
    hardBlockers: [],
    qualitativeReviewProtocol: 'no-apparent-collapse-main-review-v1',
    qualitativeReviewOwner: 'main-orchestrator',
    perCell,
    rawCandidatePositiveSuccesses: 0,
    rawControlPositiveSuccesses: 0,
    candidatePositiveDenominator: 0,
    controlPositiveDenominator: 0,
    weightedCandidatePositiveRate: null,
    weightedControlPositiveRate: null,
    weightedPairedPositiveDifference: 0,
    weightedEstimateComplete: true,
    candidateNegativeFalseOutputs: 0,
    rawDurationMs: [],
    nearestRankP50Ms: null,
    nearestRankP95Ms: null,
    knownCostUsd: 0,
    unknownReservedUsd: 0,
    successfulPositiveKnownCostUsd: null,
    candidate: {
      knownCostUsd: 0,
      unknownReservedUsd: 0,
      confirmedPhysicalCalls: 0,
      logicalAttempts: 0,
      unknownDurationCount: 0,
      durationsMs: [],
      p50Ms: null,
      p95Ms: null,
      successfulPositiveKnownCostUsd: null,
    },
    control: {
      knownCostUsd: 0,
      unknownReservedUsd: 0,
      confirmedPhysicalCalls: 0,
      logicalAttempts: 0,
      unknownDurationCount: 0,
      durationsMs: [],
      p50Ms: null,
      p95Ms: null,
      successfulPositiveKnownCostUsd: null,
    },
    outputs,
  })
  return devScreenReportSchema.parse({ ...body, reportSha256: sha256(JSON.stringify(body)) })
}

function cliArgs(command: string, protocolPath: string, protocolSha256: string, stage?: string) {
  return [
    command,
    ...(stage ? [stage] : []),
    '--protocol',
    protocolPath,
    '--protocol-sha256',
    protocolSha256,
    ...(command === 'run' ? ['--allow-paid'] : []),
  ]
}

await test('scope CLI registers and completes the ordered DEV lifecycle with hash-bound reviews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-lifecycle-'))
  try {
    const fixture = await makeScopeFixture(directory)
    const registrationArgs = cliArgs('register', fixture.protocolPath, fixture.protocolSha256)
    const registering = runAuthoredScopeReplayCli(registrationArgs, directory, fixture.hooks)
    registrationArgs[0] = 'closeout'
    await registering
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('run', fixture.protocolPath, fixture.protocolSha256, 'dev12'),
        directory,
        fixture.hooks,
      ),
      /reviewed advancement/u,
    )
    const bindingPath = join(fixture.namespaceRoot, 'admission', 'study-binding.json')
    const binding = z
      .object({ studyId: z.string() })
      .passthrough()
      .parse(JSON.parse(await readFile(bindingPath, 'utf8')) as unknown)
    assert.equal(binding.studyId, AUTHORED_SCOPE_STUDY_ID)
    assert.equal(
      sha256(
        await readFile(join(fixture.namespaceRoot, 'admission', 'freeze', 'phase-freeze.json')),
      ),
      sha256(fixture.freezeBytes),
    )
    for (const stage of ['dev8', 'dev12', 'dev40'] as const) {
      const originalExecuteScreen = fixture.hooks.executeScreen
      const running = runAuthoredScopeReplayCli(
        cliArgs('run', fixture.protocolPath, fixture.protocolSha256, stage),
        directory,
        fixture.hooks,
      )
      if (stage === 'dev8') {
        fixture.hooks.executeScreen = async () => {
          throw new Error('mutated callback must not run')
        }
        fixture.hooks.namespaceRoot = join(directory, 'mutated namespace')
        fixture.sourceBytes.clear()
      }
      await running
      if (stage === 'dev8') {
        fixture.hooks.executeScreen = originalExecuteScreen
        fixture.hooks.namespaceRoot = join(directory, 'authored-scope-dev40-v1')
      }
      await runAuthoredScopeReplayCli(
        [
          'review',
          stage,
          '--judgement',
          'advance',
          '--reason',
          'offline lifecycle fixture',
          '--protocol',
          fixture.protocolPath,
          '--protocol-sha256',
          fixture.protocolSha256,
        ],
        directory,
        fixture.hooks,
      )
      if (stage === 'dev8') {
        await assert.rejects(
          runAuthoredScopeReplayCli(
            cliArgs('run', fixture.protocolPath, fixture.protocolSha256, 'dev8'),
            directory,
            fixture.hooks,
          ),
          /repeated|stage/u,
        )
      }
    }
    await runAuthoredScopeReplayCli(
      cliArgs('closeout', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
    const closeout = z
      .object({ studyId: z.string(), missingPredictionRows: z.number(), qualEligible: z.boolean() })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(
            join(fixture.namespaceRoot, 'execution', 'closeout', 'dev40-closeout.json'),
            'utf8',
          ),
        ) as unknown,
      )
    assert.equal(closeout.studyId, AUTHORED_SCOPE_STUDY_ID)
    assert.equal(closeout.missingPredictionRows, 80)
    assert.equal(closeout.qualEligible, false)
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('synthetic offline artifact assembly carries scope identity through all 80 DEV case-arms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-artifacts-'))
  try {
    const fixture = await makeScopeFixture(directory, true)
    await runAuthoredScopeReplayCli(
      cliArgs('register', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
    for (const stage of ['dev8', 'dev12', 'dev40'] as const) {
      await runAuthoredScopeReplayCli(
        cliArgs('run', fixture.protocolPath, fixture.protocolSha256, stage),
        directory,
        fixture.hooks,
      )
      await runAuthoredScopeReplayCli(
        [
          'review',
          stage,
          '--judgement',
          'advance',
          '--reason',
          'synthetic offline lifecycle fixture',
          '--protocol',
          fixture.protocolPath,
          '--protocol-sha256',
          fixture.protocolSha256,
        ],
        directory,
        fixture.hooks,
      )
    }
    await runAuthoredScopeReplayCli(
      cliArgs('closeout', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
    const closeout = z
      .object({
        studyId: z.string(),
        missingPredictionRows: z.number(),
        allStageReviewsAdvance: z.boolean(),
        qualEligible: z.boolean(),
        candidateCloseoutSha256: z.string(),
        controlCloseoutSha256: z.string(),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(
            join(fixture.namespaceRoot, 'execution', 'closeout', 'dev40-closeout.json'),
            'utf8',
          ),
        ) as unknown,
      )
    assert.equal(closeout.studyId, AUTHORED_SCOPE_STUDY_ID)
    assert.equal(closeout.missingPredictionRows, 0)
    assert.equal(closeout.allStageReviewsAdvance, true)
    // This records lifecycle eligibility only; the fixture outputs are not inference evidence.
    assert.equal(closeout.qualEligible, true)
    assert.equal(closeout.candidateCloseoutSha256.length, 64)
    assert.equal(closeout.controlCloseoutSha256.length, 64)
    const candidateCloseout = z
      .object({
        phaseId: z.literal(PHASE_SCOPE_DEV40_ID),
        profileId: z.literal(PROFILE_SCOPE_CANDIDATE_ID),
        outputRows: z.array(z.object({ profileId: z.literal(PROFILE_SCOPE_CANDIDATE_ID) })),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(
            join(fixture.namespaceRoot, 'execution', 'closeouts', 'dev40-candidate-closeout.json'),
            'utf8',
          ),
        ) as unknown,
      )
    assert.equal(candidateCloseout.outputRows.length, 40)
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('closed entrypoints reject foreign-study protocols before creating namespaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-boundary-'))
  try {
    const fixture = await makeScopeFixture(directory)
    assert.throws(
      () =>
        parseReplayProtocolForStudy('provider-refusal-dev40-replay-v1', fixture.admission.protocol),
      /does not match/u,
    )
    await assert.rejects(
      runProviderRefusalReplayCli(
        cliArgs('register', fixture.protocolPath, fixture.protocolSha256),
        directory,
      ),
      /study|schema|protocol/u,
    )
    const wrongProtocolSha256 = `${fixture.protocolSha256.startsWith('0') ? '1' : '0'}${fixture.protocolSha256.slice(1)}`
    assert.notEqual(wrongProtocolSha256, fixture.protocolSha256)
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('register', fixture.protocolPath, wrongProtocolSha256),
        directory,
      ),
      /changed|digest/u,
    )
    await assert.rejects(readFile(fixture.namespaceRoot))
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('scope entry rejects an offline hook whose explicit test-only selector was mutated off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-hook-boundary-'))
  try {
    const fixture = await makeScopeFixture(directory)
    const hooks = { ...fixture.hooks }
    Reflect.set(hooks, 'offlineTestOnly', false)
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('register', fixture.protocolPath, fixture.protocolSha256),
        directory,
        hooks,
      ),
      /offline|temporary namespace/u,
    )
    await assert.rejects(readFile(fixture.namespaceRoot))
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('scope offline hooks reject a foreign temporary namespace before creating artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-foreign-root-'))
  try {
    const fixture = await makeScopeFixture(directory)
    const foreignRoot = join(directory, 'some-other-study')
    const hooks: DevReplayOfflineCliHooks = { ...fixture.hooks, namespaceRoot: foreignRoot }
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('register', fixture.protocolPath, fixture.protocolSha256),
        directory,
        hooks,
      ),
      /temporary namespace/u,
    )
    await assert.rejects(readFile(foreignRoot))
    await assert.rejects(readFile(fixture.namespaceRoot))
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('scope deadline blocks new runs but keeps matching review and closeout read-only', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-deadline-'))
  try {
    const fixture = await makeScopeFixture(directory)
    await runAuthoredScopeReplayCli(
      cliArgs('register', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
    await runAuthoredScopeReplayCli(
      cliArgs('run', fixture.protocolPath, fixture.protocolSha256, 'dev8'),
      directory,
      fixture.hooks,
    )
    context.mock.timers.setTime(Date.parse(deadlineIso))
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('run', fixture.protocolPath, fixture.protocolSha256, 'dev12'),
        directory,
        fixture.hooks,
      ),
      /deadline is closed/u,
    )
    await runAuthoredScopeReplayCli(
      [
        'review',
        'dev8',
        '--judgement',
        'stop',
        '--reason',
        'deadline boundary fixture',
        '--protocol',
        fixture.protocolPath,
        '--protocol-sha256',
        fixture.protocolSha256,
      ],
      directory,
      fixture.hooks,
    )
    await runAuthoredScopeReplayCli(
      cliArgs('closeout', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('scope terminal stop retains unresolved cleanup and permits only STOP review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-terminal-'))
  try {
    const fixture = await makeScopeFixture(directory)
    await runAuthoredScopeReplayCli(
      cliArgs('register', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
    const terminalHooks: DevReplayOfflineCliHooks = {
      ...fixture.hooks,
      executeScreen: async (admission, stage) => {
        assertScopeAdmission(admission)
        return makeReport(admission, stage)
      },
      removeLaunchRoot: async () => {
        throw new Error('offline cleanup fixture failure')
      },
    }
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('run', fixture.protocolPath, fixture.protocolSha256, 'dev8'),
        directory,
        terminalHooks,
      ),
      /cleanup fixture failure/u,
    )
    const terminalFile = join(fixture.namespaceRoot, 'execution', 'terminal-stop.json')
    const terminal = z
      .object({ errorCode: z.string(), temporaryCleanup: z.string(), ownedLaunchRoot: z.string() })
      .passthrough()
      .parse(JSON.parse(await readFile(terminalFile, 'utf8')) as unknown)
    assert.equal(terminal.errorCode, 'EXECUTION_FAILED')
    assert.equal(terminal.temporaryCleanup, 'unresolved')
    assert.ok(terminal.ownedLaunchRoot.length > 0)
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('run', fixture.protocolPath, fixture.protocolSha256, 'dev12'),
        directory,
        fixture.hooks,
      ),
      /terminal|stop|launch/u,
    )
    await runAuthoredScopeReplayCli(
      [
        'review',
        'dev8',
        '--judgement',
        'stop',
        '--reason',
        'offline stop fixture',
        '--protocol',
        fixture.protocolPath,
        '--protocol-sha256',
        fixture.protocolSha256,
      ],
      directory,
      fixture.hooks,
    )
    await runAuthoredScopeReplayCli(
      cliArgs('closeout', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('scope runner lock recheck seals an orphan dispatch intent as uncertain and terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-cli-orphan-'))
  try {
    const fixture = await makeScopeFixture(directory)
    await runAuthoredScopeReplayCli(
      cliArgs('register', fixture.protocolPath, fixture.protocolSha256),
      directory,
      fixture.hooks,
    )
    let executeCalled = false
    const hooks: DevReplayOfflineCliHooks = {
      ...fixture.hooks,
      executeScreen: async () => {
        executeCalled = true
        throw new Error('orphan launch must stop before execution')
      },
      beforeRunnerLock: async (namespaceRoot, ledger, admission, stage) => {
        assertScopeAdmission(admission)
        const firstCaseId = admission.freeze.producerCases[0]!.opaqueCaseId
        const reservationId = await ledger.admitPhysical(0.55, {
          profileId: PROFILE_SCOPE_CANDIDATE_ID,
          opaqueCaseId: firstCaseId,
        })
        await ledger.recordDispatchIntent(reservationId)
        const intentRoot = join(namespaceRoot, 'execution', 'launch-intents')
        await mkdir(intentRoot, { recursive: true })
        await writeFile(
          join(intentRoot, `${stage}.json`),
          `${JSON.stringify({
            schema: 'h8a-authored-scope-replay-launch-intent-v1',
            stage,
            protocolSha256: admission.protocolSha256,
            freezeCommitmentSha256: admission.freezeCommitmentSha256,
            startedAtIso: '2026-11-01T00:00:00.000Z',
          })}\n`,
          { flag: 'wx' },
        )
      },
    }
    await assert.rejects(
      runAuthoredScopeReplayCli(
        cliArgs('run', fixture.protocolPath, fixture.protocolSha256, 'dev8'),
        directory,
        hooks,
      ),
      /orphan|launch intent/u,
    )
    assert.equal(executeCalled, false)
    const terminal = z
      .object({
        errorCode: z.string(),
        uncertainPhysicalDispatchCount: z.number(),
        physicalDispatchCount: z.number(),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(join(fixture.namespaceRoot, 'execution', 'terminal-stop.json'), 'utf8'),
        ) as unknown,
      )
    assert.equal(terminal.errorCode, 'ORPHAN_LAUNCH_INTENT')
    assert.equal(terminal.uncertainPhysicalDispatchCount, 1)
    assert.equal(terminal.physicalDispatchCount, 239)
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('pinned artifact writer owns caller bytes before its first filesystem await', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authored-scope-pinned-bytes-'))
  try {
    const original = Buffer.from('original pinned bytes')
    const expected = sha256(original)
    const writing = writePinnedReplayArtifact(join(directory, 'owned.bin'), original, expected)
    original.fill(0)
    await writing
    assert.equal(sha256(await readFile(join(directory, 'owned.bin'))), expected)
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})
