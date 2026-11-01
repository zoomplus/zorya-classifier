import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CampaignLedger } from './campaign-ledger.js'
import { PROFILE_CANDIDATE_ID, PROFILE_CONTROL_ID, PHASE_DEV40_ID } from './constants.js'
import {
  acquireRunnerLock,
  assertLiveRunnerClosure,
  runVerifiedDevScreen,
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

function fixture() {
  const { freeze: base, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildSyntheticAnnotationBundle(
    base.phaseId,
    base.freezeId,
    base.producerCases,
    base.pairedSchedule,
  )
  const freeze = {
    ...base,
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
  profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
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
