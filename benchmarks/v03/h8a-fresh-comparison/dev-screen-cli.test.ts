import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CampaignLedger } from './campaign-ledger.js'
import {
  PROFILE_CANDIDATE_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  PHASE_DEV40_ID,
  PHASE_FLAT_DEV40_ID,
} from './constants.js'
import {
  acquireRunnerLock,
  assertLiveRunnerClosure,
  runVerifiedDevScreen,
  registerFlatDevComparison,
  registerDisjointDevComparison,
  verifyDisjointDevRegistration,
  verifyFlatDevRegistration,
  verifyCampaignConfig,
  verifyDevPhaseBinding,
  verifyPriorStageFiles,
} from './dev-screen-cli.js'
import {
  devScreenReportSchema,
  executeDevScreen,
  sealDevScreenReview,
} from './dev-screen-runner.js'
import type { CaseExecutionPort } from './paired-runner.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import type { FreshRuntimeArtifacts } from './runtime-ports.js'
import type { EvaluatorPrivateAnnotationBundle, PhaseFreeze } from './schemas.js'

const registeredCampaignConfigSha256 =
  '12da3eb42a9f8dae52ff678241686af2775c0592539827df6801996ed48ee076'
const authoritySha256 = 'a'.repeat(64)
const syntheticClosurePaths = [
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-cli.ts',
  'benchmarks/v03/h8a-fresh-comparison/runtime-ports.ts',
  'benchmarks/v03/h8a-fresh-comparison/campaign-ledger.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-sampling.ts',
  'benchmarks/v03/h8a-fresh-comparison/paired-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/case-artifact-store.ts',
  'benchmarks/v03/h8a-fresh-comparison/profiles.ts',
  'benchmarks/v03/h8a-fresh-comparison/schemas.ts',
  'benchmarks/v03/h8a-fresh-comparison/hash-identity.ts',
  'benchmarks/v03/h8a-fresh-comparison/constants.ts',
  'benchmarks/v03/h8a-fresh-comparison/phase-deadline.ts',
  'benchmarks/v03/h8a-fresh-comparison/freeze-admission.ts',
  'benchmarks/v03/h8a-fresh-comparison/evaluator.ts',
  'benchmarks/v03/h8a-fresh-comparison/packed-binary-lsb0.ts',
  'benchmarks/v03/h8a-fresh-comparison/annotation-digest.ts',
  'benchmarks/v03/h8a-fresh-comparison/freeze-commitment.ts',
  'benchmarks/v03/h8a-fresh-comparison/source-group-validation.ts',
  'benchmarks/v03/h8a-fresh-comparison/physical-dispatch.ts',
  'benchmarks/v03/h8a-fresh-comparison/campaign-fetch-boundary.ts',
]

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixture(
  phaseId: typeof PHASE_DEV40_ID | typeof PHASE_FLAT_DEV40_ID = PHASE_DEV40_ID,
  freezeId = `${phaseId}-test`,
) {
  const { freeze: base, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(phaseId)
  const annotations = buildSyntheticAnnotationBundle(
    phaseId,
    freezeId,
    base.producerCases,
    base.pairedSchedule,
  )
  const freeze = {
    ...base,
    freezeId,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  }
  return {
    freeze,
    annotations,
    sourceBytesByCaseId: new Map(
      [...sourceBytesByCaseId].map(([id, bytes]) => [id, Buffer.from(bytes)]),
    ),
    sourceClosurePaths: syntheticClosurePaths,
    selection: buildDevScreenSelection(freeze, annotations),
  }
}

function makePort(
  profileId:
    | typeof PROFILE_CANDIDATE_ID
    | typeof PROFILE_FLAT_CANDIDATE_ID
    | typeof PROFILE_CONTROL_ID,
  annotations: EvaluatorPrivateAnnotationBundle,
): CaseExecutionPort {
  const truthById = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
  return {
    async execute(input) {
      const positive = truthById.get(input.opaqueCaseId)?.expectedPresence === 'present'
      return {
        outputRow: {
          schema: 'h8a-fresh-output-row-v1',
          opaqueCaseId: input.opaqueCaseId,
          profileId,
          executionValidity: 'valid',
          caseState: positive ? 'success' : 'negative_clean',
          box: positive ? { left: 1, top: 1, width: 4, height: 4 } : null,
          cutoutPresent: false,
          maskPackedSha256: null,
          logicalReceiptIds: [1],
          physicalReceiptIds: [],
        },
        logicalReceipts: [
          {
            logicalId: 1,
            opaqueCaseId: input.opaqueCaseId,
            profileId,
            requestSha256: hash(Buffer.from(`${profileId}:${input.opaqueCaseId}`)),
            physicalIds: [],
            outcome: 'resolved',
          },
        ],
        physicalReceipts: [],
      }
    },
  }
}

async function prepareFlatCampaignFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  const ledger = {
    schema: 'h8a-fresh-campaign-ledger-v1',
    ledgerVersion: 7,
    maxPhysicalCalls: 2000,
    maxCostUsd: 10,
    nextReservationId: 8,
    physicalDispatchCount: 7,
    logicalAttemptCount: 3,
    knownCostUsd: 0.00599665,
    unknownReserveUsd: 0,
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
  }
  await writeFile(join(root, 'campaign-ledger.json'), `${JSON.stringify(ledger)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  const marker = {
    schema: 'h8a-shared-campaign-root-v1',
    campaignId: 'offline-test-campaign',
    canonicalRoot: root,
    campaignConfigSha256: registeredCampaignConfigSha256,
    maxCostUsd: 10,
    maxPhysicalCalls: 2000,
  }
  await writeFile(join(root, '.h8a-shared-campaign.json'), `${JSON.stringify(marker)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
}

async function prepareCampaign(root: string, freeze: PhaseFreeze): Promise<void> {
  await mkdir(join(root, 'phase-bindings'), { mode: 0o700 })
  await CampaignLedger.open(join(root, 'campaign-ledger.json'))
  const marker = {
    schema: 'h8a-shared-campaign-root-v1',
    campaignId: 'offline-test-campaign',
    canonicalRoot: root,
    campaignConfigSha256: registeredCampaignConfigSha256,
    maxCostUsd: 10,
    maxPhysicalCalls: 2000,
  }
  await writeFile(join(root, '.h8a-shared-campaign.json'), `${JSON.stringify(marker)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  const binding = {
    schema: 'h8a-phase-campaign-binding-v1',
    phaseId: PHASE_DEV40_ID,
    authoritySha256,
    freezeId: freeze.freezeId,
    freezeCommitmentSha256: freeze.cohortCommitmentSha256,
  }
  await writeFile(join(root, 'phase-bindings/dev40-binding.json'), `${JSON.stringify(binding)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
}

await test('portable campaign config refuses replacement and stage gate runs before key, lock, or setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-screen-gate-'))
  try {
    assert.throws(
      () =>
        assertLiveRunnerClosure(
          syntheticClosurePaths.filter((path) => !path.endsWith('/campaign-ledger.ts')),
        ),
      /omits a DEV live runner/u,
    )
    const { freeze } = fixture()
    await prepareCampaign(root, freeze)
    const badConfig = {
      schema: 'h8a-shared-campaign-config-v1',
      campaignId: 'replacement-budget',
      canonicalRoot: join(root, 'second-ledger'),
      maxCostUsd: 10,
      maxPhysicalCalls: 2000,
    }
    const bytes = Buffer.from(`${JSON.stringify(badConfig)}\n`)
    const badPath = join(root, 'replacement-config.json')
    await writeFile(badPath, bytes, { flag: 'wx', mode: 0o600 })
    await assert.rejects(
      verifyCampaignConfig({
        campaignConfigPath: badPath,
        campaignConfigSha256: hash(bytes),
        runRoot: badConfig.canonicalRoot,
      }),
      /registered campaign pin/u,
    )
    await verifyDevPhaseBinding(root, authoritySha256, freeze)
    let keyReads = 0
    let setupCalls = 0
    const verified = fixture()
    await assert.rejects(
      runVerifiedDevScreen(
        { authoritySha256, screen: 'dev12', apiKeyEnv: 'TEST_KEY' },
        { ...verified, runtimeEnvironmentSha256: 'b'.repeat(64) },
        {
          proof: { historicalSourceRoot: root },
          candidateAssetsRoot: root,
          mobileSamEncoderPath: root,
          mobileSamDecoderPath: root,
          pythonExecutable: root,
        },
        {
          campaignId: 'offline-test-campaign',
          canonicalRoot: root,
          sha256: registeredCampaignConfigSha256,
        },
        {
          getApiKey: () => {
            keyReads += 1
            return 'offline-key'
          },
          acquireLock: async () => {
            throw new Error('lock must not be acquired')
          },
          openLedger: async () => {
            throw new Error('ledger must not be opened')
          },
          createRuntime: async () => {
            setupCalls += 1
            throw new Error('runtime must not be initialized')
          },
          execute: async () => {
            setupCalls += 1
            throw new Error('runner must not execute')
          },
          writeReport: () => undefined,
        },
      ),
      /ENOENT/u,
    )
    assert.equal(keyReads, 0)
    assert.equal(setupCalls, 0)
    await assert.rejects(access(join(root, '.h8a-native-runner.lock')))
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})

await test('offline run wiring uses verified bytes, one selection, shared ledger, and lock through disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-screen-wiring-'))
  try {
    const verified = fixture()
    await prepareCampaign(root, verified.freeze)
    const campaign = {
      campaignId: 'offline-test-campaign',
      canonicalRoot: root,
      sha256: registeredCampaignConfigSha256,
    }
    const runtime = {
      proof: { historicalSourceRoot: root },
      candidateAssetsRoot: root,
      mobileSamEncoderPath: join(root, 'encoder.onnx'),
      mobileSamDecoderPath: join(root, 'decoder.onnx'),
      pythonExecutable: join(root, 'python-venv'),
    }
    const options = {
      authoritySha256,
      screen: 'dev8',
      apiKeyEnv: 'TEST_KEY',
    }
    const selectionPath = join(root, 'dev-screen-selection.json')
    const artifacts: FreshRuntimeArtifacts = {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    }
    let lockHeldDuringSetup = false
    const disposals: true[] = []
    let activeSignal: AbortSignal | undefined
    const baselineSigintListeners = process.listeners('SIGINT').length
    const baselineSigtermListeners = process.listeners('SIGTERM').length
    const delayCleanup = async (): Promise<void> =>
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    const run = async (screen: 'dev8' | 'dev12') =>
      await runVerifiedDevScreen(
        { ...options, screen },
        { ...verified, runtimeEnvironmentSha256: 'b'.repeat(64) },
        runtime,
        campaign,
        {
          getApiKey: () => 'offline-only',
          acquireLock: async (lockedRoot) => {
            assert.equal(lockedRoot, root)
            const release = await acquireRunnerLock(lockedRoot)
            return async () => {
              assert.ok(process.listeners('SIGINT').length > baselineSigintListeners)
              assert.ok(process.listeners('SIGTERM').length > baselineSigtermListeners)
              process.emit('SIGTERM')
              assert.equal(activeSignal?.aborted, true)
              await delayCleanup()
              await access(join(root, '.h8a-native-runner.lock'))
              await release()
            }
          },
          openLedger: async (path) => await CampaignLedger.open(path),
          createRuntime: async ({ verified: prepared }) => {
            if (screen === 'dev8')
              assert.equal(
                await readFile(selectionPath)
                  .then(hash)
                  .catch(() => null),
                null,
              )
            await access(join(root, '.h8a-native-runner.lock'))
            lockHeldDuringSetup = true
            assert.deepEqual(prepared.sourceBytesByCaseId, verified.sourceBytesByCaseId)
            return {
              candidatePort: makePort(PROFILE_CANDIDATE_ID, verified.annotations),
              controlPort: makePort(PROFILE_CONTROL_ID, verified.annotations),
              artifacts,
              async dispose() {
                await access(join(root, '.h8a-native-runner.lock'))
                assert.ok(process.listeners('SIGINT').length > baselineSigintListeners)
                assert.ok(process.listeners('SIGTERM').length > baselineSigtermListeners)
                process.emit('SIGINT')
                assert.equal(activeSignal?.aborted, true)
                const signalReason = activeSignal?.reason
                process.emit('SIGTERM')
                assert.equal(activeSignal?.reason, signalReason)
                await delayCleanup()
                assert.ok(process.listeners('SIGINT').length > baselineSigintListeners)
                disposals.push(true)
              },
            }
          },
          execute: async (input) => {
            activeSignal = input.signal
            return await executeDevScreen(input)
          },
          writeReport: () => undefined,
        },
      )
    await run('dev8')
    assert.ok(lockHeldDuringSetup)
    assert.equal(disposals.length, 1)
    assert.equal(process.listeners('SIGINT').length, baselineSigintListeners)
    assert.equal(process.listeners('SIGTERM').length, baselineSigtermListeners)
    await access(selectionPath)
    const selectionDigest = hash(await readFile(selectionPath))
    const dev8ReportUnknown: unknown = JSON.parse(
      await readFile(join(root, 'reports/dev8-report.json'), 'utf8'),
    )
    const report = devScreenReportSchema.parse(dev8ReportUnknown)
    await sealDevScreenReview(root, report, 'advance', 'Offline synthetic fixture review.')
    await run('dev12')
    assert.equal(disposals.length, 2)
    assert.equal(process.listeners('SIGINT').length, baselineSigintListeners)
    assert.equal(process.listeners('SIGTERM').length, baselineSigtermListeners)
    assert.equal(hash(await readFile(selectionPath)), selectionDigest)
    const ledger = await CampaignLedger.open(join(root, 'campaign-ledger.json'))
    assert.equal(ledger.snapshot().logicalAttemptCount, 24)
    const dev12ReportUnknown: unknown = JSON.parse(
      await readFile(join(root, 'reports/dev12-report.json'), 'utf8'),
    )
    const dev12Report = devScreenReportSchema.parse(dev12ReportUnknown)
    await sealDevScreenReview(root, dev12Report, 'advance', 'Offline synthetic fixture review.')
    await verifyPriorStageFiles(root, 'dev40')
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})

await test('flat registration and screens share the campaign ledger while isolating all case artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-flat-screen-'))
  const campaignRoot = join(root, 'campaign')
  try {
    await prepareFlatCampaignFixture(campaignRoot)
    const registered = fixture(PHASE_FLAT_DEV40_ID, 'h8a-flat-dev40-20261101-v1')
    const verified = { ...registered, runtimeEnvironmentSha256: 'c'.repeat(64) }
    const campaign = {
      campaignId: 'offline-test-campaign',
      canonicalRoot: campaignRoot,
      sha256: registeredCampaignConfigSha256,
    }
    const verifyPriorEvidence = async (): Promise<number> => 0.00599665
    const before = (
      await CampaignLedger.open(join(campaignRoot, 'campaign-ledger.json'))
    ).snapshot()
    assert.equal(before.logicalAttemptCount, 3)
    assert.equal(before.physicalDispatchCount, 7)
    await registerFlatDevComparison({ authoritySha256 }, verified, campaign, {
      acquireLock: acquireRunnerLock,
      openLedger: (path) => CampaignLedger.open(path),
      verifyPriorV1Evidence: verifyPriorEvidence,
    })
    const artifactRoot = join(campaignRoot, 'experiments', 'h8a-flat-dev40-v1')
    await verifyFlatDevRegistration(
      campaignRoot,
      authoritySha256,
      verified.freeze,
      verifyPriorEvidence,
    )
    await assert.rejects(
      verifyFlatDevRegistration(campaignRoot, authoritySha256, fixture().freeze),
      /flat DEV40 profile freeze/u,
    )

    const artifacts: FreshRuntimeArtifacts = {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    }
    const runtime = {
      proof: { historicalSourceRoot: campaignRoot },
      candidateAssetsRoot: campaignRoot,
      mobileSamEncoderPath: join(campaignRoot, 'encoder.onnx'),
      mobileSamDecoderPath: join(campaignRoot, 'decoder.onnx'),
      pythonExecutable: join(campaignRoot, 'python-venv'),
    }
    const run = async (screen: 'dev8' | 'dev12'): Promise<void> =>
      await runVerifiedDevScreen(
        { authoritySha256, screen, apiKeyEnv: 'TEST_KEY' },
        verified,
        runtime,
        campaign,
        {
          getApiKey: () => 'offline-only',
          acquireLock: acquireRunnerLock,
          openLedger: (path) => CampaignLedger.open(path),
          createRuntime: async ({ root: runtimeRoot }) => {
            assert.equal(runtimeRoot, artifactRoot)
            return {
              candidatePort: makePort(PROFILE_FLAT_CANDIDATE_ID, verified.annotations),
              controlPort: makePort(PROFILE_CONTROL_ID, verified.annotations),
              artifacts,
              async dispose() {},
            }
          },
          execute: async (input) => await executeDevScreen(input),
          writeReport: () => undefined,
          verifyPriorV1Evidence: verifyPriorEvidence,
        },
      )

    await run('dev8')
    const dev8 = devScreenReportSchema.parse(
      JSON.parse(await readFile(join(artifactRoot, 'reports/dev8-report.json'), 'utf8')),
    )
    assert.equal(dev8.completedPairs, 8)
    await sealDevScreenReview(
      artifactRoot,
      dev8,
      'advance',
      'Offline synthetic profile-isolation fixture.',
    )
    await run('dev12')

    const after = (await CampaignLedger.open(join(campaignRoot, 'campaign-ledger.json'))).snapshot()
    assert.equal(after.logicalAttemptCount, before.logicalAttemptCount + 24)
    assert.equal(after.physicalDispatchCount, before.physicalDispatchCount)
    assert.ok(after.knownCostUsd >= before.knownCostUsd)
    await access(join(artifactRoot, 'reports/dev12-report.json'))
    await access(join(artifactRoot, 'case-artifacts'))
    await access(join(artifactRoot, 'case-intents'))
    await assert.rejects(access(join(campaignRoot, 'case-artifacts')))
    await assert.rejects(
      registerFlatDevComparison({ authoritySha256 }, verified, campaign, {
        acquireLock: acquireRunnerLock,
        openLedger: (path) => CampaignLedger.open(path),
        verifyPriorV1Evidence: verifyPriorEvidence,
      }),
      /stale artifacts before registration/u,
    )
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})

await test('flat registration refuses a symlinked experiment root before writing outside the campaign', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-flat-hostile-root-'))
  const campaignRoot = join(root, 'campaign')
  const outside = join(root, 'outside')
  try {
    await prepareFlatCampaignFixture(campaignRoot)
    await mkdir(outside)
    await symlink(outside, join(campaignRoot, 'experiments'))
    const originalLedger = await readFile(join(campaignRoot, 'campaign-ledger.json'))
    const verified = {
      ...fixture(PHASE_FLAT_DEV40_ID, 'h8a-flat-dev40-20261101-v1'),
      runtimeEnvironmentSha256: 'c'.repeat(64),
    }
    await assert.rejects(
      registerFlatDevComparison(
        { authoritySha256 },
        verified,
        {
          campaignId: 'offline-test-campaign',
          canonicalRoot: campaignRoot,
          sha256: registeredCampaignConfigSha256,
        },
        {
          acquireLock: acquireRunnerLock,
          openLedger: (path) => CampaignLedger.open(path),
          verifyPriorV1Evidence: async () => 0.00599665,
        },
      ),
      /real directory/u,
    )
    assert.deepEqual(await readdir(outside), [])
    assert.deepEqual(await readFile(join(campaignRoot, 'campaign-ledger.json')), originalLedger)
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})

await test('flat registration refuses a reset global budget even when historical call counters remain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-flat-reset-ledger-'))
  const campaignRoot = join(root, 'campaign')
  try {
    await prepareFlatCampaignFixture(campaignRoot)
    const ledgerPath = join(campaignRoot, 'campaign-ledger.json')
    const ledger: unknown = JSON.parse(await readFile(ledgerPath, 'utf8'))
    assert.ok(ledger !== null && typeof ledger === 'object')
    Reflect.set(ledger, 'knownCostUsd', 0)
    Reflect.set(ledger, 'unknownReserveUsd', 0)
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`)
    const verified = {
      ...fixture(PHASE_FLAT_DEV40_ID, 'h8a-flat-dev40-20261101-v1'),
      runtimeEnvironmentSha256: 'c'.repeat(64),
    }
    await assert.rejects(
      registerFlatDevComparison(
        { authoritySha256 },
        verified,
        {
          campaignId: 'offline-test-campaign',
          canonicalRoot: campaignRoot,
          sha256: registeredCampaignConfigSha256,
        },
        {
          acquireLock: acquireRunnerLock,
          openLedger: (path) => CampaignLedger.open(path),
          verifyPriorV1Evidence: async () => 0.00599665,
        },
      ),
      /global budget/u,
    )
    await assert.rejects(access(join(campaignRoot, 'experiments')))
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})

await test('disjoint registration uses its own freeze and namespace with the settled V1/V2 ledger floor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-disjoint-screen-'))
  const campaignRoot = join(root, 'campaign')
  const canonicalConfig = {
    campaignId: 'offline-test-campaign',
    canonicalRoot: campaignRoot,
    sha256: registeredCampaignConfigSha256,
  }
  try {
    await prepareFlatCampaignFixture(campaignRoot)
    const ledgerPath = join(campaignRoot, 'campaign-ledger.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, unknown>
    ledger.nextReservationId = 15
    ledger.physicalDispatchCount = 14
    ledger.logicalAttemptCount = 5
    ledger.knownCostUsd = 0.009603065
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`)
    const verified = {
      ...fixture(PHASE_FLAT_DEV40_ID, 'h8a-flat-disjoint-dev40-20261101-v1'),
      runtimeEnvironmentSha256: 'd'.repeat(64),
    }
    const verifyPriorEvidence = async (): Promise<number> => 0.009603065
    const dependencies = {
      acquireLock: acquireRunnerLock,
      openLedger: (path: string) => CampaignLedger.open(path),
      verifyPriorEvidence,
    }
    await assert.rejects(
      registerDisjointDevComparison(
        { authoritySha256 },
        { ...verified, freeze: { ...verified.freeze, freezeId: 'h8a-flat-dev40-20261101-v1' } },
        canonicalConfig,
        dependencies,
      ),
      /pinned disjoint flat DEV40 profile/u,
    )
    await assert.rejects(access(join(campaignRoot, 'experiments')))

    const before = (await CampaignLedger.open(ledgerPath)).snapshot()
    assert.equal(before.physicalDispatchCount, 14)
    assert.equal(before.logicalAttemptCount, 5)
    await assert.rejects(
      registerDisjointDevComparison({ authoritySha256 }, verified, canonicalConfig, {
        ...dependencies,
        verifyPriorEvidence: async () => 0.01,
      }),
      /settled V1\/V2 budget floor/u,
    )
    await assert.rejects(access(join(campaignRoot, 'experiments')))
    await registerDisjointDevComparison(
      { authoritySha256 },
      verified,
      canonicalConfig,
      dependencies,
    )
    const namespace = join(campaignRoot, 'experiments', 'flat-disjoint-replication-v1')
    const registration = JSON.parse(await readFile(join(namespace, 'registration.json'), 'utf8'))
    assert.equal(registration.freezeId, 'h8a-flat-disjoint-dev40-20261101-v1')
    assert.equal(registration.studyId, 'flat-disjoint-replication-v1')
    assert.equal(registration.priorV1BindingSha256.length, 64)
    assert.equal(registration.priorV2BindingSha256.length, 64)
    await verifyDisjointDevRegistration(
      campaignRoot,
      authoritySha256,
      verified.freeze,
      verifyPriorEvidence,
    )
    let keyReads = 0
    let setupCalls = 0
    await assert.rejects(
      runVerifiedDevScreen(
        { authoritySha256, screen: 'dev8', apiKeyEnv: 'TEST_KEY' },
        verified,
        {
          proof: { historicalSourceRoot: campaignRoot },
          candidateAssetsRoot: campaignRoot,
          mobileSamEncoderPath: join(campaignRoot, 'encoder.onnx'),
          mobileSamDecoderPath: join(campaignRoot, 'decoder.onnx'),
          pythonExecutable: join(campaignRoot, 'python'),
        },
        canonicalConfig,
        {
          getApiKey: () => {
            keyReads += 1
            return undefined
          },
          acquireLock: async () => {
            throw new Error('runner lock must not be acquired')
          },
          openLedger: async () => {
            throw new Error('ledger must not be opened')
          },
          createRuntime: async () => {
            setupCalls += 1
            throw new Error('runtime must not be initialized')
          },
          execute: async () => {
            throw new Error('screen must not be executed')
          },
          writeReport: () => undefined,
          verifyPriorDisjointEvidence: async () => {
            throw new Error('pinned historical evidence is invalid')
          },
        },
      ),
      /pinned historical evidence is invalid/u,
    )
    assert.equal(keyReads, 0)
    assert.equal(setupCalls, 0)
    await assert.rejects(access(join(campaignRoot, 'experiments', 'h8a-flat-dev40-v1')))

    const after = (await CampaignLedger.open(ledgerPath)).snapshot()
    assert.equal(after.physicalDispatchCount, before.physicalDispatchCount)
    assert.equal(after.knownCostUsd, before.knownCostUsd)
    await writeFile(join(namespace, 'reports-stale.json'), '{}\n')
    await assert.rejects(
      registerDisjointDevComparison({ authoritySha256 }, verified, canonicalConfig, dependencies),
      /stale artifacts before registration/u,
    )
  } finally {
    await rm(root, { recursive: true, force: false })
  }
})
