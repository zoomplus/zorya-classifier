import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { CampaignLedger } from './campaign-ledger.js'
import { PHASE_FLAT_DEV40_ID, PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { createCampaignFetchBoundary } from './campaign-fetch-boundary.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import { executeDevScreen } from './dev-screen-runner.js'
import { hashIdentity } from './hash-identity.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import { runVerifiedSuccessorDevScreen } from './successor-dev-screen-cli.js'
import type { SuccessorDependencies } from './successor-dev-screen-cli.js'
import type { SuccessorCampaignAdmissionPort } from './campaign-ledger-port.js'
import type { CaseExecutionPort } from './paired-runner.js'
import type { LedgerPhysicalCallContext } from './campaign-ledger-port.js'
import type { PhaseFreeze } from './schemas.js'
import {
  UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO,
  UI_STATE_DEV40_EXECUTION_V2_ID,
  UI_STATE_DEV40_FREEZE_ID,
  UI_STATE_DEV40_SOURCE_ADMISSION_POLICY,
  UI_STATE_DEV40_STUDY_ID,
  UI_STATE_DEV40_ZERO_QUERY_PROTOCOL_SHA256,
} from './ui-state-dev40-policy.js'

const directoryRoots: string[] = []

async function fixture(): Promise<Parameters<typeof runVerifiedSuccessorDevScreen>[0]['verified']> {
  const generated = buildSyntheticPhaseFreeze(PHASE_FLAT_DEV40_ID)
  const freezeId = UI_STATE_DEV40_FREEZE_ID
  const annotations = buildSyntheticAnnotationBundle(
    PHASE_FLAT_DEV40_ID,
    freezeId,
    generated.freeze.producerCases,
    generated.freeze.pairedSchedule,
  )
  const freeze: PhaseFreeze = {
    ...generated.freeze,
    freezeId,
    deadlineIso: UI_STATE_DEV40_EXECUTION_V2_DEADLINE_ISO,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  }
  const selection = buildDevScreenSelection(freeze, annotations)
  const verifiedAuthority = {
    studyId: UI_STATE_DEV40_STUDY_ID,
    executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
    authoritySha256: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    priceProofSha256: 'c'.repeat(64),
    sourceAdmissionPolicy: UI_STATE_DEV40_SOURCE_ADMISSION_POLICY,
    sourceStateProofSha256: 'e'.repeat(64),
    freezeCommitmentSha256: hashIdentity(freeze),
  }
  return {
    freeze,
    annotations,
    selection,
    sourceBytesByCaseId: new Map(
      [...generated.sourceBytesByCaseId].map(([id, bytes]) => [id, Buffer.from(bytes)]),
    ),
    sourceClosurePaths: [],
    runtimeEnvironmentSha256: 'd'.repeat(64),
    verifiedAuthority,
  }
}

function dependencies(input: {
  root: string
  getApiKey(): string | undefined
  counters: { runtime: number; execute: number; ledgerExecutionIds?: string[] }
}): SuccessorDependencies {
  return {
    verifyExecutionPreconditions: async () => undefined,
    getApiKey: input.getApiKey,
    openLedger: async (options) => {
      input.counters.ledgerExecutionIds?.push(options.executionId)
      const ledger = await CampaignLedger.open(join(input.root, 'ledger.json'))
      return Object.assign(ledger, {
        async assertStudyScopeCanAdmitPhysicalReservedUsd(
          _profileId: typeof PROFILE_FLAT_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
          _reservedUsd: number,
        ): Promise<void> {},
      }) satisfies SuccessorCampaignAdmissionPort
    },
    assertFreezeAdmission: async () => undefined,
    createRuntime: async () => {
      input.counters.runtime++
      throw new Error('runtime must not initialize during offline refusal tests')
    },
    execute: async () => {
      input.counters.execute++
      throw new Error('no provider calls are allowed in refusal tests')
    },
    acquireLock: async () => async () => undefined,
    verifyBinding: async () => undefined,
    verifyStageNotStarted: async () => undefined,
    assertSourceClosure: () => undefined,
  }
}

await test('incomplete freeze refuses before key read, runtime creation, and provider execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-incomplete-'))
  directoryRoots.push(root)
  const complete = await fixture()
  const incomplete = {
    ...complete,
    freeze: { ...complete.freeze, producerCases: complete.freeze.producerCases.slice(0, 39) },
  }
  let keyReads = 0
  const counters = { runtime: 0, execute: 0 }
  await assert.rejects(
    runVerifiedSuccessorDevScreen(
      {
        screen: 'dev8',
        apiKeyEnv: 'OFFLINE_TEST_KEY',
        verified: incomplete,
        runtime: null,
        authoritySha256: 'a'.repeat(64),
        artifactRoot: root,
      },
      {
        studyRoot: root,
        parentRoot: root,
        parentLedgerPath: join(root, 'parent.json'),
        executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
      },
      dependencies({
        root,
        getApiKey: () => {
          keyReads++
          return 'synthetic'
        },
        counters,
      }),
    ),
    /assembly is incomplete/u,
  )
  assert.equal(keyReads, 0)
  assert.deepEqual(counters, { runtime: 0, execute: 0 })
  await assert.rejects(readFile(join(root, 'terminal-stop.json')), { code: 'ENOENT' })
})

await test('zero-query recovery guard refuses before lock, ledger, key, runtime, or launch intent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00.000Z') })
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-zero-query-guard-'))
  directoryRoots.push(root)
  const verified = await fixture()
  let keyReads = 0
  let lockAcquisitions = 0
  const counters = { runtime: 0, execute: 0, ledgerExecutionIds: [] as string[] }
  const deps = dependencies({
    root,
    getApiKey: () => {
      keyReads++
      return 'synthetic-key'
    },
    counters,
  })
  deps.verifyExecutionPreconditions = async () => {
    throw new RangeError('zero-query prior-attempt proof mismatch')
  }
  deps.acquireLock = async () => {
    lockAcquisitions++
    return async () => undefined
  }
  await assert.rejects(
    runVerifiedSuccessorDevScreen(
      {
        screen: 'dev8',
        apiKeyEnv: 'OFFLINE_TEST_KEY',
        verified,
        runtime: null,
        authoritySha256: 'a'.repeat(64),
        artifactRoot: root,
      },
      {
        studyRoot: root,
        parentRoot: root,
        parentLedgerPath: join(root, 'parent.json'),
        executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
      },
      deps,
    ),
    /zero-query prior-attempt proof mismatch/u,
  )
  assert.equal(lockAcquisitions, 0)
  assert.deepEqual(counters.ledgerExecutionIds, [])
  assert.equal(keyReads, 0)
  assert.deepEqual(counters, { runtime: 0, execute: 0, ledgerExecutionIds: [] })
  await assert.rejects(readFile(join(root, 'launch-intents', 'dev8-launch.json')), {
    code: 'ENOENT',
  })
  await assert.rejects(readFile(join(root, 'terminal-stop.json')), { code: 'ENOENT' })
})

await test('invalid deadline refuses before guard, lock, key, runtime, and launch intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-deadline-preflight-'))
  directoryRoots.push(root)
  const complete = await fixture()
  const verified = {
    ...complete,
    freeze: { ...complete.freeze, deadlineIso: '2030-01-01T00:00:00.738058Z' },
  }
  let keyReads = 0
  let guardCalls = 0
  let lockAcquisitions = 0
  const counters = { runtime: 0, execute: 0, ledgerExecutionIds: [] as string[] }
  const deps = dependencies({
    root,
    getApiKey: () => {
      keyReads++
      return 'synthetic-key'
    },
    counters,
  })
  deps.verifyExecutionPreconditions = async () => {
    guardCalls++
  }
  deps.acquireLock = async () => {
    lockAcquisitions++
    return async () => undefined
  }
  await assert.rejects(
    runVerifiedSuccessorDevScreen(
      {
        screen: 'dev8',
        apiKeyEnv: 'OFFLINE_TEST_KEY',
        verified,
        runtime: null,
        authoritySha256: 'a'.repeat(64),
        artifactRoot: root,
      },
      {
        studyRoot: root,
        parentRoot: root,
        parentLedgerPath: join(root, 'parent.json'),
        executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
      },
      deps,
    ),
    /Execution-v2 deadline differs from its zero-query protocol/u,
  )
  assert.equal(guardCalls, 0)
  assert.equal(lockAcquisitions, 0)
  assert.deepEqual(counters.ledgerExecutionIds, [])
  assert.equal(keyReads, 0)
  assert.deepEqual(counters, { runtime: 0, execute: 0, ledgerExecutionIds: [] })
  await assert.rejects(readFile(join(root, 'launch-intents', 'dev8-launch.json')), {
    code: 'ENOENT',
  })
  await assert.rejects(readFile(join(root, 'terminal-stop.json')), { code: 'ENOENT' })
})

await test('normal DEV screen keeps case-level fetch limits local to the exhausted candidate case', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00.000Z') })
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-case-limit-'))
  directoryRoots.push(root)
  const verified = await fixture()
  const selectedSchedules = verified.freeze.pairedSchedule.filter((row) =>
    verified.selection.dev8CaseIds.includes(row.opaqueCaseId),
  )
  const exhaustedSchedule = selectedSchedules.find(
    (row, index) => index > 0 && row.candidateArmFirst,
  )
  if (!exhaustedSchedule) throw new Error('fixture must include a later candidate-first pair')
  const exhaustedCaseId = exhaustedSchedule.opaqueCaseId
  const exhaustedScheduleIndex = selectedSchedules.indexOf(exhaustedSchedule)

  const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
  const callsByCaseProfile = new Map<string, number>()
  const physicalAdmissionAttempts = new Map<string, number>()
  const originalAdmitPhysical = ledger.admitPhysical.bind(ledger)
  const candidateKey = `${PROFILE_FLAT_CANDIDATE_ID}:${exhaustedCaseId}`
  callsByCaseProfile.set(candidateKey, 4)
  Object.assign(ledger, {
    async assertStudyScopeCanAdmitPhysicalReservedUsd(
      _profileId: typeof PROFILE_FLAT_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
      reservedUsd: number,
    ): Promise<void> {
      await ledger.assertCanAdmitPhysicalReservedUsd(reservedUsd)
    },
  }) satisfies SuccessorCampaignAdmissionPort
  Object.defineProperty(ledger, 'admitPhysical', {
    configurable: true,
    value: async (reservedUsd: number, context?: LedgerPhysicalCallContext): Promise<number> => {
      assert.ok(context, 'physical fetch admission must carry frozen case and profile context')
      const key = `${context.profileId}:${context.opaqueCaseId}`
      physicalAdmissionAttempts.set(key, (physicalAdmissionAttempts.get(key) ?? 0) + 1)
      const used = callsByCaseProfile.get(key) ?? 0
      if (key === candidateKey && used >= 4)
        throw new Error('Per-case profile call ceiling reached')
      callsByCaseProfile.set(key, used + 1)
      return await originalAdmitPhysical(reservedUsd)
    },
  })

  const truthById = new Map(verified.annotations.cases.map((item) => [item.opaqueCaseId, item]))
  let physicalId = 0
  let successfulFetches = 0
  const makePort = (
    profileId: typeof PROFILE_FLAT_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
  ): CaseExecutionPort => ({
    async execute(input, context) {
      if (!context.caseExecutionIdentitySha256)
        throw new Error('Runner did not bind the physical dispatch to its case artifact')
      const body = JSON.stringify({ model: 'offline-controlled-fetch' })
      const bodySha256 = createHash('sha256').update(body).digest('hex')
      const boundary = createCampaignFetchBoundary({
        ledger,
        reservedUsd: context.reservedUsdPerFetch,
        profileId,
        opaqueCaseId: input.opaqueCaseId,
        caseExecutionIdentitySha256: context.caseExecutionIdentitySha256,
        endpoint: '/api/v1/chat/completions',
        journalDirectory: join(root, 'dispatch-journal'),
        baseFetch: async () => {
          successfulFetches++
          return new Response(JSON.stringify({ usage: { cost: 0.001 } }), {
            headers: { 'Content-Type': 'application/json' },
          })
        },
        readCurrentProviderCall: () => ({
          physicalId: ++physicalId,
          logicalId: 1,
          requestSha256: createHash('sha256').update(`request-${physicalId}`).digest('hex'),
          requestBodySha256: bodySha256,
        }),
      })
      await boundary.fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body,
      })
      const receipts = boundary.entries.map((entry) => ({
        receiptId: entry.reservationId,
        physicalId: entry.physicalId,
        logicalId: 1,
        dispatchState: entry.dispatchState,
        settled: entry.settled,
        costUsd: entry.costUsd,
        chargeState:
          entry.settled && entry.costUsd !== null ? ('known' as const) : ('unknown' as const),
      }))
      const positive = truthById.get(input.opaqueCaseId)?.expectedPresence === 'present'
      return {
        outputRow: {
          schema: 'h8a-fresh-output-row-v1',
          opaqueCaseId: input.opaqueCaseId,
          profileId,
          executionValidity: 'valid',
          caseState: positive ? 'success' : 'negative_clean',
          box: positive ? { left: 1, top: 1, width: 1, height: 1 } : null,
          cutoutPresent: false,
          maskPackedSha256: null,
          logicalReceiptIds: [1],
          physicalReceiptIds: receipts.map((receipt) => receipt.receiptId),
        },
        logicalReceipts: [
          {
            logicalId: 1,
            opaqueCaseId: input.opaqueCaseId,
            profileId,
            requestSha256: createHash('sha256').update(input.opaqueCaseId).digest('hex'),
            physicalIds: receipts.flatMap((receipt) =>
              receipt.physicalId === null ? [] : [receipt.physicalId],
            ),
            outcome: 'resolved' as const,
          },
        ],
        physicalReceipts: receipts,
      }
    },
  })

  const report = await executeDevScreen({
    freeze: verified.freeze,
    annotations: verified.annotations,
    sourceBytesByCaseId: verified.sourceBytesByCaseId,
    selection: verified.selection,
    screen: 'dev8',
    selectionPath: join(root, 'selection.json'),
    artifactRoot: join(root, 'artifacts'),
    ledger,
    candidatePort: makePort(PROFILE_FLAT_CANDIDATE_ID),
    controlPort: makePort(PROFILE_CONTROL_ID),
    runtimeArtifacts: {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    },
  })

  for (const schedule of selectedSchedules.slice(0, exhaustedScheduleIndex)) {
    assert.equal(callsByCaseProfile.get(`${PROFILE_FLAT_CANDIDATE_ID}:${schedule.opaqueCaseId}`), 1)
    assert.equal(callsByCaseProfile.get(`${PROFILE_CONTROL_ID}:${schedule.opaqueCaseId}`), 1)
  }
  assert.equal(physicalAdmissionAttempts.get(candidateKey), 1)
  assert.equal(callsByCaseProfile.get(candidateKey), 4)
  assert.equal(successfulFetches, exhaustedScheduleIndex * 2)
  assert.ok(report.hardBlockers.some((blocker) => blocker.includes(exhaustedCaseId)))
  assert.equal(report.completedPairs, exhaustedScheduleIndex)
})

await test('runner lock serializes contenders before key lookup without poisoning a clean stage', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00.000Z') })
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-race-'))
  directoryRoots.push(root)
  const verified = await fixture()
  let keyReads = 0
  let lockHeld = false
  let announceAdmission: (() => void) | undefined
  let releaseAdmission: (() => void) | undefined
  const admissionEntered = new Promise<void>((resolve) => {
    announceAdmission = resolve
  })
  const admissionGate = new Promise<void>((resolve) => {
    releaseAdmission = resolve
  })
  const counters = { runtime: 0, execute: 0 }
  const deps = dependencies({
    root,
    getApiKey: () => {
      keyReads++
      return undefined
    },
    counters,
  })
  deps.acquireLock = async () => {
    if (lockHeld) throw new RangeError('runner lock is already held')
    lockHeld = true
    return async () => {
      lockHeld = false
    }
  }
  deps.assertFreezeAdmission = async () => {
    announceAdmission?.()
    await admissionGate
  }
  const input = {
    screen: 'dev8' as const,
    apiKeyEnv: 'OFFLINE_TEST_KEY',
    verified,
    runtime: null,
    authoritySha256: 'a'.repeat(64),
    artifactRoot: root,
  }
  const options = {
    studyRoot: root,
    parentRoot: root,
    parentLedgerPath: join(root, 'parent.json'),
    executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
  }
  const firstRun = runVerifiedSuccessorDevScreen(input, options, deps)
  await admissionEntered
  await assert.rejects(
    runVerifiedSuccessorDevScreen(input, options, deps),
    /runner lock is already held/u,
  )
  assert.equal(keyReads, 0)
  assert.deepEqual(counters, { runtime: 0, execute: 0 })
  await assert.rejects(readFile(join(root, 'terminal-stop.json')), { code: 'ENOENT' })
  releaseAdmission?.()
  await assert.rejects(firstRun, /provider key environment variable is unset/u)
  assert.equal(keyReads, 1)
  await assert.rejects(readFile(join(root, 'terminal-stop.json')), { code: 'ENOENT' })
})

await test('a launched failed stage is terminal and cannot read the key or execute on resubmission', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00.000Z') })
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-terminal-'))
  directoryRoots.push(root)
  const verified = await fixture()
  let keyReads = 0
  const counters = { runtime: 0, execute: 0, ledgerExecutionIds: [] as string[] }
  const deps = dependencies({
    root,
    getApiKey: () => {
      keyReads++
      return 'synthetic-key'
    },
    counters,
  })
  const input = {
    screen: 'dev8' as const,
    apiKeyEnv: 'OFFLINE_TEST_KEY',
    verified,
    runtime: {
      proof: { historicalSourceRoot: '/synthetic/historical' },
      candidateAssetsRoot: '/synthetic/assets',
      mobileSamEncoderPath: '/synthetic/encoder.onnx',
      mobileSamDecoderPath: '/synthetic/decoder.onnx',
      pythonExecutable: '/synthetic/python',
    },
    authoritySha256: 'a'.repeat(64),
    artifactRoot: root,
  }
  const options = {
    studyRoot: root,
    parentRoot: root,
    parentLedgerPath: join(root, 'parent.json'),
    executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
  }
  await assert.rejects(
    runVerifiedSuccessorDevScreen(input, options, deps),
    /runtime must not initialize/u,
  )
  assert.equal(keyReads, 1)
  assert.equal(counters.runtime, 1)
  assert.equal(counters.execute, 0)
  assert.deepEqual(counters.ledgerExecutionIds, [
    UI_STATE_DEV40_EXECUTION_V2_ID,
    UI_STATE_DEV40_EXECUTION_V2_ID,
  ])
  const launch = JSON.parse(
    await readFile(join(root, 'launch-intents', 'dev8-launch.json'), 'utf8'),
  ) as Record<string, unknown>
  assert.equal(launch.studyId, UI_STATE_DEV40_STUDY_ID)
  assert.equal(launch.executionId, UI_STATE_DEV40_EXECUTION_V2_ID)
  assert.equal(launch.zeroQueryProtocolSha256, UI_STATE_DEV40_ZERO_QUERY_PROTOCOL_SHA256)
  assert.equal(launch.freezeId, UI_STATE_DEV40_FREEZE_ID)
  assert.equal(launch.sourceAdmissionPolicy, UI_STATE_DEV40_SOURCE_ADMISSION_POLICY)
  assert.equal(launch.sourceStateProofSha256, 'e'.repeat(64))
  const terminalStopBeforeRetry = await readFile(join(root, 'terminal-stop.json'))
  assert.ok(terminalStopBeforeRetry.length > 0)
  await assert.rejects(runVerifiedSuccessorDevScreen(input, options, deps), /terminal stop record/u)
  assert.equal(keyReads, 1)
  assert.equal(counters.runtime, 1)
  assert.equal(counters.execute, 0)
  assert.deepEqual(await readFile(join(root, 'terminal-stop.json')), terminalStopBeforeRetry)
})

await test('missing cumulative prior-stage report is not swallowed and refuses before key read', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00.000Z') })
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-prior-stage-'))
  directoryRoots.push(root)
  const verified = await fixture()
  let keyReads = 0
  const counters = { runtime: 0, execute: 0 }
  await assert.rejects(
    runVerifiedSuccessorDevScreen(
      {
        screen: 'dev12',
        apiKeyEnv: 'OFFLINE_TEST_KEY',
        verified,
        runtime: null,
        authoritySha256: 'a'.repeat(64),
        artifactRoot: root,
      },
      {
        studyRoot: root,
        parentRoot: root,
        parentLedgerPath: join(root, 'parent.json'),
        executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
      },
      dependencies({
        root,
        getApiKey: () => {
          keyReads++
          return 'synthetic'
        },
        counters,
      }),
    ),
    { code: 'ENOENT' },
  )
  assert.equal(keyReads, 0)
  assert.deepEqual(counters, { runtime: 0, execute: 0 })
  await assert.rejects(readFile(join(root, 'terminal-stop.json')), { code: 'ENOENT' })
})

await test('corrupt cumulative prior-stage report is not swallowed and refuses before key read', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00.000Z') })
  const root = await mkdtemp(join(tmpdir(), 'h8a-successor-corrupt-stage-'))
  directoryRoots.push(root)
  await mkdir(join(root, 'reports'), { recursive: true })
  await mkdir(join(root, 'reviews'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'reports', 'dev8-report.json'), '{}\n'),
    writeFile(join(root, 'reviews', 'dev8-review.json'), '{}\n'),
  ])
  const verified = await fixture()
  let keyReads = 0
  const counters = { runtime: 0, execute: 0 }
  await assert.rejects(
    runVerifiedSuccessorDevScreen(
      {
        screen: 'dev12',
        apiKeyEnv: 'OFFLINE_TEST_KEY',
        verified,
        runtime: null,
        authoritySha256: 'a'.repeat(64),
        artifactRoot: root,
      },
      {
        studyRoot: root,
        parentRoot: root,
        parentLedgerPath: join(root, 'parent.json'),
        executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
      },
      dependencies({
        root,
        getApiKey: () => {
          keyReads++
          return 'synthetic'
        },
        counters,
      }),
    ),
    { name: 'ZodError' },
  )
  assert.equal(keyReads, 0)
  assert.deepEqual(counters, { runtime: 0, execute: 0 })
  await assert.rejects(readFile(join(root, 'terminal-stop.json')), { code: 'ENOENT' })
})

after(async () => {
  await Promise.all(
    directoryRoots.map(async (root) => await rm(root, { recursive: true, force: true })),
  )
})
