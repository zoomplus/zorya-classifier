import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  assertProviderRefusalReplayStageTransition,
  parseProviderRefusalReplayArgs,
  runProviderRefusalReplayCli,
  writePinnedReplayArtifact,
} from './provider-refusal-replay-cli.js'
import {
  providerRefusalReplayProtocolSchema,
  PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO,
  PROVIDER_REFUSAL_REPLAY_FREEZE_ID,
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
  PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
  PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
  PROVIDER_REFUSAL_REPLAY_STUDY_ID,
} from './provider-refusal-replay-admission.js'
import type { VerifiedProviderRefusalReplayAdmission } from './provider-refusal-replay-admission.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import { PHASE_FLAT_DEV40_ID, PROFILE_CONTROL_ID } from './constants.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { buildDevScreenSelection, DEV_SCREEN_SEED } from './dev-screen-sampling.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { phaseFreezeSchema } from './schemas.js'
import { buildCaseArtifactIdentity, devScreenReportSchema } from './dev-screen-runner.js'
import type { ProviderRefusalReplayOfflineCliHooks } from './provider-refusal-replay-cli.js'
import {
  ProviderRefusalReplayLedger,
  REPLAY_CANDIDATE_MAX_USD,
} from './provider-refusal-replay-ledger.js'
import { PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import { hashIdentity } from './hash-identity.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

test.beforeEach((context) => {
  if ('mock' in context)
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T00:00:00.000Z') })
})

test.afterEach((context) => {
  if ('mock' in context) context.mock.timers.reset()
})

async function buildOfflineCliFixture(directory: string): Promise<{
  admission: VerifiedProviderRefusalReplayAdmission
  hooks: ProviderRefusalReplayOfflineCliHooks
  protocolPath: string
  protocolSha256: string
  namespaceRoot: string
}> {
  const namespaceRoot = join(directory, 'provider-refusal-dev40-replay-v1')
  const base = buildSyntheticPhaseFreeze(PHASE_FLAT_DEV40_ID)
  const freezeId = PROVIDER_REFUSAL_REPLAY_FREEZE_ID
  const annotations = buildSyntheticAnnotationBundle(
    PHASE_FLAT_DEV40_ID,
    freezeId,
    base.freeze.producerCases,
    base.freeze.pairedSchedule,
  )
  const annotationBytes = Buffer.from(JSON.stringify(annotations), 'utf8')
  const closureBytes = Buffer.from('{"schema":"offline-test-closure"}\n', 'utf8')
  const closureSha256 = hash(closureBytes.toString('utf8'))
  const freeze = phaseFreezeSchema.parse({
    ...base.freeze,
    freezeId,
    deadlineIso: PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO,
    producerClosureSha256: closureSha256,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
  })
  const freezeBytes = Buffer.from(JSON.stringify(freeze), 'utf8')
  const selection = buildDevScreenSelection(freeze, annotations)
  const selectionBytes = Buffer.from(JSON.stringify(selection), 'utf8')
  const protocol = providerRefusalReplayProtocolSchema.parse({
    schema: 'h8a-provider-refusal-replay-protocol-v1',
    studyId: PROVIDER_REFUSAL_REPLAY_STUDY_ID,
    freezeId,
    deadlineIso: PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO,
    parentAudit: {
      path: PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
    },
    sourceAudit: {
      path: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH,
      sha256: PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256,
    },
    freeze: { path: join(directory, 'phase-freeze.json'), sha256: hash(freezeBytes.toString()) },
    annotations: {
      path: join(directory, 'annotations.json'),
      sha256: hash(annotationBytes.toString()),
    },
    selection: {
      path: join(directory, 'selection.json'),
      sha256: hash(selectionBytes.toString()),
    },
    producerClosure: {
      path: join(directory, 'closure.json'),
      sha256: closureSha256,
    },
    runtimeProof: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH,
      sha256: '278015e2d7a9bbd7f308c865c01a9dc2277ec48d89d11852400940ef6e0ec389',
    },
    runtimeEnvironment: {
      path: PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH,
      sha256: '1941f16dfb906f54331cc06c8b58bed15b86b65d86f16f7f708b49bc60680ba6',
    },
    sourceBytes: freeze.producerCases.map((row) => ({
      caseId: row.opaqueCaseId,
      path: join(directory, `${row.opaqueCaseId}.png`),
      sha256: row.sourceBytesSha256,
      bytes: base.sourceBytesByCaseId.get(row.opaqueCaseId)!.byteLength,
    })),
    referenceMasks: Array.from({ length: 16 }, (_, index) => ({
      path: join(directory, `mask-${index}.bin`),
      sha256: hash(`mask-bytes-${index}`),
      packedBinarySha256: hash(`mask-packed-${index}`),
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
  await writeFile(protocol.freeze.path, freezeBytes)
  await writeFile(protocol.annotations.path, annotationBytes)
  await writeFile(protocol.selection.path, selectionBytes)
  await writeFile(protocol.producerClosure.path, closureBytes)
  const protocolBytes = Buffer.from(JSON.stringify(protocol), 'utf8')
  const protocolPath = join(directory, 'protocol.json')
  await writeFile(protocolPath, protocolBytes)
  const protocolSha256 = hash(protocolBytes.toString('utf8'))
  const admission: VerifiedProviderRefusalReplayAdmission = {
    protocol,
    protocolSha256,
    freeze,
    annotations,
    selection,
    sourceBytes: base.sourceBytesByCaseId,
    referenceMaskBytes: new Map(),
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
  }
  const hooks: ProviderRefusalReplayOfflineCliHooks = {
    offlineTestOnly: true,
    namespaceRoot,
    admission,
    getApiKey: () => 'offline-test-only',
    executeScreen: async (_admission, stage) => makeTestReport(admission, stage, false),
  }
  return { admission, hooks, protocolPath, protocolSha256, namespaceRoot }
}

function makeTestReport(
  admission: VerifiedProviderRefusalReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
  blocked: boolean,
): z.infer<typeof devScreenReportSchema> {
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
  const outputIds =
    stage === 'dev8'
      ? admission.selection.dev8CaseIds
      : stage === 'dev12'
        ? admission.selection.dev12CaseIds
        : admission.freeze.producerCases.map((row) => row.opaqueCaseId)
  const outputs = outputIds.map((opaqueCaseId) => {
    const producer = admission.freeze.producerCases.find(
      (row) => row.opaqueCaseId === opaqueCaseId,
    )!
    const annotation = admission.annotations.cases.find((row) => row.opaqueCaseId === opaqueCaseId)!
    const stratum = admission.freeze.pairedSchedule.find(
      (row) => row.opaqueCaseId === opaqueCaseId,
    )!.stratum
    const candidateProfile = admission.freeze.profileBindings[0].profileId
    return {
      opaqueCaseId,
      stratum,
      expectedPresence: annotation.expectedPresence,
      candidateCaseState: annotation.expectedPresence === 'present' ? 'success' : 'negative_clean',
      controlCaseState: annotation.expectedPresence === 'present' ? 'success' : 'negative_clean',
      candidatePositiveSuccess: annotation.expectedPresence === 'present',
      controlPositiveSuccess: annotation.expectedPresence === 'present',
      candidateNegativeFalse: false,
      controlNegativeFalse: false,
      candidateIdentitySha256: hashIdentity(
        buildCaseArtifactIdentity(
          admission.freeze,
          admission.selection,
          producer,
          candidateProfile,
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
  const expectedPairs = stage === 'dev8' ? 8 : stage === 'dev12' ? 12 : 40
  const body = devScreenReportSchema.omit({ reportSha256: true }).parse({
    schema: 'h8a-dev-screen-report-v1',
    screen: stage,
    freezeCommitmentSha256: admission.freezeCommitmentSha256,
    selectionCommitmentSha256: admission.selection.selectionCommitmentSha256,
    seed: DEV_SCREEN_SEED,
    completedPairs: blocked ? 0 : expectedPairs,
    expectedPairs,
    hardBlockers: blocked ? ['OFFLINE_CONTROLLED_STOP'] : [],
    qualitativeReviewProtocol: 'no-apparent-collapse-main-review-v1',
    qualitativeReviewOwner: 'main-orchestrator',
    perCell,
    rawCandidatePositiveSuccesses: 0,
    rawControlPositiveSuccesses: 0,
    candidatePositiveDenominator: 0,
    controlPositiveDenominator: 0,
    weightedCandidatePositiveRate: null,
    weightedControlPositiveRate: null,
    weightedPairedPositiveDifference: null,
    weightedEstimateComplete: false,
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
  return devScreenReportSchema.parse({ ...body, reportSha256: hash(JSON.stringify(body)) })
}

await test('CLI requires exact protocol pin and an explicit paid switch only on run', () => {
  const sha = hash('protocol')
  assert.deepEqual(
    parseProviderRefusalReplayArgs([
      'register',
      '--protocol',
      '/tmp/protocol.json',
      '--protocol-sha256',
      sha,
    ]),
    {
      command: 'register',
      protocolPath: '/tmp/protocol.json',
      protocolSha256: sha,
      allowPaid: false,
    },
  )
  assert.deepEqual(
    parseProviderRefusalReplayArgs([
      'run',
      'dev8',
      '--protocol',
      '/tmp/protocol.json',
      '--protocol-sha256',
      sha,
      '--allow-paid',
    ]),
    {
      command: 'run',
      screen: 'dev8',
      protocolPath: '/tmp/protocol.json',
      protocolSha256: sha,
      allowPaid: true,
    },
  )
  assert.throws(() =>
    parseProviderRefusalReplayArgs([
      'run',
      'dev8',
      '--protocol',
      '/tmp/protocol.json',
      '--protocol-sha256',
      sha,
    ]),
  )
  assert.throws(() =>
    parseProviderRefusalReplayArgs([
      'register',
      '--allow-paid',
      '--protocol',
      '/tmp/protocol.json',
      '--protocol-sha256',
      sha,
    ]),
  )
  assert.throws(() =>
    parseProviderRefusalReplayArgs([
      'run',
      'dev40',
      '--protocol',
      '/tmp/protocol.json',
      '--protocol-sha256',
      sha,
      '--allow-paid',
      '--unknown-root',
      '/tmp',
    ]),
  )
})

await test('CLI stage transitions require one immutable launch per stage and advance reviews', () => {
  const initial = { launchedStages: [] as const, reviewJudgements: {}, terminalStop: false }
  assert.doesNotThrow(() =>
    assertProviderRefusalReplayStageTransition({ ...initial, stage: 'dev8' }),
  )
  assert.throws(
    () => assertProviderRefusalReplayStageTransition({ ...initial, stage: 'dev12' }),
    /reviewed advancement/u,
  )
  const dev8Done = {
    launchedStages: ['dev8'] as const,
    reviewJudgements: { dev8: 'advance' as const },
    terminalStop: false,
  }
  assert.doesNotThrow(() =>
    assertProviderRefusalReplayStageTransition({ ...dev8Done, stage: 'dev12' }),
  )
  assert.throws(
    () => assertProviderRefusalReplayStageTransition({ ...dev8Done, stage: 'dev8' }),
    /repeated/u,
  )
  const dev12Done = {
    launchedStages: ['dev8', 'dev12'] as const,
    reviewJudgements: { dev8: 'advance' as const, dev12: 'advance' as const },
    terminalStop: false,
  }
  assert.doesNotThrow(() =>
    assertProviderRefusalReplayStageTransition({ ...dev12Done, stage: 'dev40' }),
  )
  assert.throws(
    () =>
      assertProviderRefusalReplayStageTransition({
        ...dev12Done,
        stage: 'dev40',
        terminalStop: true,
      }),
    /Terminal/u,
  )
  assert.throws(
    () =>
      assertProviderRefusalReplayStageTransition({
        launchedStages: ['dev8', 'dev12', 'dev40'],
        reviewJudgements: {},
        terminalStop: false,
        stage: 'dev40',
      }),
    /repeated/u,
  )
})

await test('mismatched protocol digest is refused before schema parsing or namespace writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-refusal-cli-'))
  try {
    const path = join(directory, 'protocol.json')
    await writeFile(path, '{}\n', { flag: 'wx' })
    await assert.rejects(
      runProviderRefusalReplayCli(
        ['register', '--protocol', path, '--protocol-sha256', hash('wrong')],
        directory,
      ),
      /Protocol digest/u,
    )
    assert.deepEqual(await readFile(path, 'utf8'), '{}\n')
    assert.deepEqual(await (await import('node:fs/promises')).readdir(directory), ['protocol.json'])
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('pinned absolute deadline refuses registration when the mocked clock reaches it', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-refusal-cli-deadline-'))
  try {
    const fixture = await buildOfflineCliFixture(directory)
    context.mock.timers.setTime(Date.parse(PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO))
    await assert.rejects(
      runProviderRefusalReplayCli(
        [
          'register',
          '--protocol',
          fixture.protocolPath,
          '--protocol-sha256',
          fixture.protocolSha256,
        ],
        directory,
        fixture.hooks,
      ),
      /deadline is closed/u,
    )
    await assert.rejects(access(fixture.namespaceRoot), /ENOENT/u)
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('pinned freeze artifacts retain their exact whitespace-formatted source bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-refusal-pinned-copy-'))
  try {
    const sourceBytes = Buffer.from('{\n  "schema": "fixture",\n  "value": 1\n}\n', 'utf8')
    const path = join(directory, 'freeze.json')
    await writePinnedReplayArtifact(path, sourceBytes, hash(sourceBytes.toString('utf8')))
    assert.deepEqual(await readFile(path), sourceBytes)
    await assert.rejects(
      writePinnedReplayArtifact(path, Buffer.from('{}\n'), hash('{}\n')),
      /immutable/u,
    )
    await assert.rejects(
      writePinnedReplayArtifact(join(directory, 'bad.json'), sourceBytes, hash('different')),
      /digest/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('run rechecks an orphan launch under lock and preserves an intent as uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-refusal-cli-lock-recheck-'))
  try {
    const fixture = await buildOfflineCliFixture(directory)
    const commonArgs = [
      '--protocol',
      fixture.protocolPath,
      '--protocol-sha256',
      fixture.protocolSha256,
    ]
    await runProviderRefusalReplayCli(['register', ...commonArgs], directory, fixture.hooks)
    let executionStarted = false
    const hooks: ProviderRefusalReplayOfflineCliHooks = {
      ...fixture.hooks,
      executeScreen: async (admission, stage) => {
        executionStarted = true
        return makeTestReport(admission, stage, false)
      },
      beforeRunnerLock: async (namespaceRoot, ledger, admission, stage) => {
        const firstCase = admission.freeze.producerCases[0]!.opaqueCaseId
        const reservationId = await ledger.admitPhysical(REPLAY_CANDIDATE_MAX_USD, {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          opaqueCaseId: firstCase,
        })
        await ledger.recordDispatchIntent(reservationId)
        const launchDirectory = join(namespaceRoot, 'execution', 'launch-intents')
        await mkdir(launchDirectory, { recursive: true })
        await writeFile(
          join(launchDirectory, `${stage}.json`),
          `${JSON.stringify({
            schema: 'h8a-provider-refusal-replay-launch-intent-v1',
            stage,
            protocolSha256: admission.protocolSha256,
            freezeCommitmentSha256: admission.freezeCommitmentSha256,
            startedAtIso: new Date().toISOString(),
          })}\n`,
          { flag: 'wx' },
        )
      },
    }
    await assert.rejects(
      runProviderRefusalReplayCli(['run', 'dev8', ...commonArgs, '--allow-paid'], directory, hooks),
      /orphan launch intent/u,
    )
    const terminalValue: unknown = JSON.parse(
      await readFile(join(fixture.namespaceRoot, 'execution', 'terminal-stop.json'), 'utf8'),
    )
    const terminal = z
      .object({
        errorCode: z.literal('ORPHAN_LAUNCH_INTENT'),
        uncertainPhysicalDispatchCount: z.literal(1),
        runtimeDisposed: z.literal(false),
        temporaryCleanup: z.literal('unresolved'),
      })
      .passthrough()
      .parse(terminalValue)
    assert.equal(terminal.errorCode, 'ORPHAN_LAUNCH_INTENT')
    assert.equal(terminal.uncertainPhysicalDispatchCount, 1)
    assert.equal(executionStarted, false)
    const ledger = await ProviderRefusalReplayLedger.register({
      root: join(fixture.namespaceRoot, 'admission', 'successor-campaign'),
      offlineTestOnly: true,
      protocolSha256: fixture.protocolSha256,
      caseIds: fixture.admission.freeze.producerCases.map((row) => row.opaqueCaseId),
    })
    assert.equal(ledger.uncertainDispatchCount(), 1)
    assert.equal(ledger.snapshot().unknownReserveUsd, 0.24)
    assert.equal(ledger.snapshot().inFlightReservations.length, 1)
    assert.throws(() => ledger.assertResumeAllowed(), /unresolved/u)
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})

await test('terminal stage accepts STOP review and retains a full partial closeout after cleanup failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-refusal-cli-partial-closeout-'))
  try {
    const fixture = await buildOfflineCliFixture(directory)
    const commonArgs = [
      '--protocol',
      fixture.protocolPath,
      '--protocol-sha256',
      fixture.protocolSha256,
    ]
    await runProviderRefusalReplayCli(['register', ...commonArgs], directory, fixture.hooks)
    const hooks: ProviderRefusalReplayOfflineCliHooks = {
      ...fixture.hooks,
      removeLaunchRoot: async () => {
        throw new Error('OFFLINE_TEMP_CLEANUP_FAILURE')
      },
    }
    await assert.rejects(
      runProviderRefusalReplayCli(['run', 'dev8', ...commonArgs, '--allow-paid'], directory, hooks),
      /OFFLINE_TEMP_CLEANUP_FAILURE/u,
    )
    const terminalValue: unknown = JSON.parse(
      await readFile(join(fixture.namespaceRoot, 'execution', 'terminal-stop.json'), 'utf8'),
    )
    const terminal = z
      .object({
        runtimeDisposed: z.literal(true),
        temporaryCleanup: z.literal('unresolved'),
        ownedLaunchRoot: z.string().min(1),
      })
      .passthrough()
      .parse(terminalValue)
    assert.equal(terminal.temporaryCleanup, 'unresolved')
    await runProviderRefusalReplayCli(
      [
        'review',
        'dev8',
        ...commonArgs,
        '--judgement',
        'stop',
        '--reason',
        'offline lifecycle test',
      ],
      directory,
      hooks,
    )
    await runProviderRefusalReplayCli(['closeout', ...commonArgs], directory, hooks)
    const closeoutValue: unknown = JSON.parse(
      await readFile(
        join(fixture.namespaceRoot, 'execution', 'closeout', 'dev40-closeout.json'),
        'utf8',
      ),
    )
    const closeout = z
      .object({
        missingPredictionRows: z.literal(80),
        allStageReviewsAdvance: z.literal(false),
        qualEligible: z.literal(false),
        terminalStop: z.object({ errorCode: z.string() }).passthrough(),
      })
      .passthrough()
      .parse(closeoutValue)
    assert.equal(closeout.missingPredictionRows, 80)
    assert.equal(closeout.qualEligible, false)
    assert.equal(closeout.terminalStop.errorCode, 'EXECUTION_FAILED')
  } finally {
    await rm(directory, { recursive: true, force: false })
  }
})
