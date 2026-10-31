import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CampaignLedger } from './campaign-ledger.js'
import { PROFILE_CANDIDATE_ID, PROFILE_CONTROL_ID, PHASE_DEV40_ID } from './constants.js'
import { executeDevScreen, sealDevScreenReview } from './dev-screen-runner.js'
import { devScreenReportSchema } from './dev-screen-runner.js'
import type { CaseExecutionPort } from './paired-runner.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { assembleDev40Closeouts } from './dev-closeout-assembly.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import type { FreshRuntimeArtifacts } from './runtime-ports.js'
import { hashIdentity } from './hash-identity.js'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
    sourceBytesByCaseId,
    selection: buildDevScreenSelection(freeze, annotations),
  }
}

await test('DEV8 to DEV12 restart reuses exact paired artifacts without repeat port attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-screen-'))
  try {
    const { freeze, annotations, sourceBytesByCaseId, selection } = fixture()
    const truth = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
    const calls = new Map<string, number>()
    const makePort = (
      profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    ): CaseExecutionPort => ({
      async execute(input) {
        calls.set(
          `${profileId}:${input.opaqueCaseId}`,
          (calls.get(`${profileId}:${input.opaqueCaseId}`) ?? 0) + 1,
        )
        const positive = truth.get(input.opaqueCaseId)!.expectedPresence === 'present'
        const box = positive ? { left: 1, top: 1, width: 4, height: 4 } : null
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1',
            opaqueCaseId: input.opaqueCaseId,
            profileId,
            executionValidity: 'valid',
            caseState: positive ? 'success' : 'negative_clean',
            box,
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
              requestSha256: sha256(`${profileId}:${input.opaqueCaseId}`),
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    })
    const artifacts: FreshRuntimeArtifacts = {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    }
    const ledger = await CampaignLedger.open(join(root, 'campaign-ledger.json'))
    let clock = 0
    const common = {
      freeze,
      annotations,
      sourceBytesByCaseId,
      selection,
      selectionPath: join(root, 'selection.json'),
      artifactRoot: join(root, 'artifacts'),
      ledger,
      candidatePort: makePort(PROFILE_CANDIDATE_ID),
      controlPort: makePort(PROFILE_CONTROL_ID),
      runtimeArtifacts: artifacts,
      clockNow: () => {
        clock += 5
        return clock
      },
    }
    const dev8 = await executeDevScreen({ ...common, screen: 'dev8' })
    assert.equal(dev8.completedPairs, 8)
    assert.deepEqual(dev8.hardBlockers, [])
    assert.equal(dev8.candidatePositiveDenominator, 5)
    assert.equal(dev8.nearestRankP50Ms, 5)
    assert.equal(ledger.snapshot().logicalAttemptCount, 16)
    await sealDevScreenReview(
      join(root, 'artifacts'),
      dev8,
      'advance',
      'Offline fixture: no apparent collapse.',
    )

    const restartedLedger = await CampaignLedger.open(join(root, 'campaign-ledger.json'))
    const dev12 = await executeDevScreen({ ...common, screen: 'dev12', ledger: restartedLedger })
    assert.equal(dev12.completedPairs, 12)
    assert.deepEqual(dev12.hardBlockers, [])
    assert.equal(restartedLedger.snapshot().logicalAttemptCount, 24)
    assert.equal(calls.size, 24)
    assert.ok([...calls.values()].every((count) => count === 1))
    assert.equal(dev12.rawCandidatePositiveSuccesses, 9)
    assert.equal(dev12.weightedCandidatePositiveRate, 1)
    assert.equal(dev12.knownCostUsd, 0)
    const assembled = await assembleDev40Closeouts({
      freeze,
      annotations,
      selection,
      artifactRoot: join(root, 'artifacts'),
      ledger: restartedLedger,
      closedAtIso: '2026-10-31T10:00:00.000Z',
    })
    assert.equal(assembled.candidateCloseout.outputRows.length, 40)
    assert.equal(assembled.controlCloseout.outputRows.length, 40)
    assert.equal(assembled.missingPredictionRows, 56)
    assert.equal(assembled.candidateCloseout.logicalAttemptCount, 12)
    assert.equal(assembled.controlCloseout.logicalAttemptCount, 12)
    assert.equal(
      assembled.candidateCloseout.outputRows.filter((row) => row.caseState === 'unstarted').length,
      28,
    )
    assert.equal(
      assembled.controlCloseout.outputRows.filter((row) => row.caseState === 'unstarted').length,
      28,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('a semantic unknown is a positive miss but does not become a technical blocker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-unknown-'))
  try {
    const { freeze, annotations, sourceBytesByCaseId, selection } = fixture()
    const truth = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
    const makePort = (
      profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    ): CaseExecutionPort => ({
      async execute(input) {
        const positive = truth.get(input.opaqueCaseId)!.expectedPresence === 'present'
        const semanticUnknown = profileId === PROFILE_CANDIDATE_ID && positive
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1',
            opaqueCaseId: input.opaqueCaseId,
            profileId,
            executionValidity: 'valid',
            caseState: semanticUnknown ? 'unknown' : positive ? 'success' : 'negative_clean',
            box: positive && !semanticUnknown ? { left: 1, top: 1, width: 4, height: 4 } : null,
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
              requestSha256: sha256(`${profileId}:${input.opaqueCaseId}`),
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    })
    const artifacts: FreshRuntimeArtifacts = {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    }
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const report = await executeDevScreen({
      freeze,
      annotations,
      sourceBytesByCaseId,
      selection,
      screen: 'dev8',
      selectionPath: join(root, 'selection.json'),
      artifactRoot: join(root, 'artifacts'),
      ledger,
      candidatePort: makePort(PROFILE_CANDIDATE_ID),
      controlPort: makePort(PROFILE_CONTROL_ID),
      runtimeArtifacts: artifacts,
    })
    assert.deepEqual(report.hardBlockers, [])
    assert.equal(report.rawCandidatePositiveSuccesses, 0)
    assert.equal(report.outputs.filter((item) => item.candidateCaseState === 'unknown').length, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('reviewed DEV8 and DEV12 advance to a complete DEV40 with all records retained', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev40-complete-'))
  try {
    const { freeze, annotations, sourceBytesByCaseId, selection } = fixture()
    const truth = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
    const calls = new Map<string, number>()
    const makePort = (
      profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    ): CaseExecutionPort => ({
      async execute(input) {
        const key = `${profileId}:${input.opaqueCaseId}`
        calls.set(key, (calls.get(key) ?? 0) + 1)
        const positive = truth.get(input.opaqueCaseId)!.expectedPresence === 'present'
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
              requestSha256: sha256(key),
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    })
    const runtimeArtifacts: FreshRuntimeArtifacts = {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    }
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const common = {
      freeze,
      annotations,
      sourceBytesByCaseId,
      selection,
      selectionPath: join(root, 'selection.json'),
      artifactRoot: join(root, 'artifacts'),
      ledger,
      candidatePort: makePort(PROFILE_CANDIDATE_ID),
      controlPort: makePort(PROFILE_CONTROL_ID),
      runtimeArtifacts,
    }
    const dev8 = await executeDevScreen({ ...common, screen: 'dev8' })
    await sealDevScreenReview(
      common.artifactRoot,
      dev8,
      'advance',
      'Синтетический офлайн-обзор DEV8.',
    )
    const dev12 = await executeDevScreen({ ...common, screen: 'dev12' })
    await sealDevScreenReview(
      common.artifactRoot,
      dev12,
      'advance',
      'Синтетический офлайн-обзор DEV12.',
    )
    const dev40 = await executeDevScreen({ ...common, screen: 'dev40' })
    assert.equal(dev40.completedPairs, 40)
    assert.deepEqual(dev40.hardBlockers, [])
    assert.equal(dev40.candidatePositiveDenominator, 30)
    assert.equal(dev40.rawCandidatePositiveSuccesses, 30)
    assert.equal(dev40.weightedCandidatePositiveRate, 1)
    assert.equal(calls.size, 80)
    assert.ok([...calls.values()].every((count) => count === 1))
    const assembled = await assembleDev40Closeouts({
      freeze,
      annotations,
      selection,
      artifactRoot: common.artifactRoot,
      ledger,
    })
    assert.equal(assembled.missingPredictionRows, 0)
    assert.equal(assembled.candidateCloseout.outputRows.length, 40)
    assert.ok(assembled.candidateCloseout.outputRows.every((row) => row.caseState !== 'unstarted'))
    assert.equal(assembled.candidateCloseout.logicalAttemptCount, 40)
    assert.equal(assembled.controlCloseout.logicalAttemptCount, 40)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('candidate false output on a selected negative halts later screen dispatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-negative-stop-'))
  try {
    const { freeze, annotations, sourceBytesByCaseId, selection } = fixture()
    const truth = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
    let attempts = 0
    const makePort = (
      profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    ): CaseExecutionPort => ({
      async execute(input) {
        attempts++
        const positive = truth.get(input.opaqueCaseId)!.expectedPresence === 'present'
        const falseCandidate = profileId === PROFILE_CANDIDATE_ID && !positive
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1',
            opaqueCaseId: input.opaqueCaseId,
            profileId,
            executionValidity: 'valid',
            caseState: positive || falseCandidate ? 'success' : 'negative_clean',
            box: positive || falseCandidate ? { left: 1, top: 1, width: 4, height: 4 } : null,
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
              requestSha256: sha256(input.opaqueCaseId),
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    })
    const report = await executeDevScreen({
      freeze,
      annotations,
      sourceBytesByCaseId,
      selection,
      screen: 'dev8',
      selectionPath: join(root, 'selection.json'),
      artifactRoot: join(root, 'artifacts'),
      ledger: await CampaignLedger.open(join(root, 'ledger.json')),
      candidatePort: makePort(PROFILE_CANDIDATE_ID),
      controlPort: makePort(PROFILE_CONTROL_ID),
      runtimeArtifacts: {
        masksBySha256: new Map(),
        cutoutsBySha256: new Map(),
        cutoutsByProfileAndCase: new Map(),
      },
    })
    assert.ok(
      report.hardBlockers.some((item) => item.startsWith('candidate-negative-false-output:')),
    )
    assert.ok(report.completedPairs < report.expectedPairs)
    assert.ok(attempts < 16)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('raw exception text never enters case evidence or screen reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-secret-redaction-'))
  try {
    const { freeze, annotations, sourceBytesByCaseId, selection } = fixture()
    const candidatePort: CaseExecutionPort = {
      async execute() {
        throw new Error('Authorization Bearer private-sentinel /private/path')
      },
    }
    const normalPort: CaseExecutionPort = {
      async execute(input) {
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1',
            opaqueCaseId: input.opaqueCaseId,
            profileId: PROFILE_CONTROL_ID,
            executionValidity: 'valid',
            caseState: 'negative_clean',
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
            logicalReceiptIds: [1],
            physicalReceiptIds: [],
          },
          logicalReceipts: [
            {
              logicalId: 1,
              opaqueCaseId: input.opaqueCaseId,
              profileId: PROFILE_CONTROL_ID,
              requestSha256: sha256(input.opaqueCaseId),
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    }
    const artifactRoot = join(root, 'artifacts')
    const report = await executeDevScreen({
      freeze,
      annotations,
      sourceBytesByCaseId,
      selection,
      screen: 'dev8',
      selectionPath: join(root, 'selection.json'),
      artifactRoot,
      ledger: await CampaignLedger.open(join(root, 'ledger.json')),
      candidatePort,
      controlPort: normalPort,
      runtimeArtifacts: {
        masksBySha256: new Map(),
        cutoutsBySha256: new Map(),
        cutoutsByProfileAndCase: new Map(),
      },
    })
    assert.ok(report.hardBlockers.length > 0)
    const persisted = await readFile(join(artifactRoot, 'reports', 'dev8-report.json'), 'utf8')
    assert.doesNotMatch(persisted, /private-sentinel|\/private\/path|Authorization Bearer/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('a self-hashed screen report cannot advance when it disagrees with immutable case records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-report-forgery-'))
  try {
    const { freeze, annotations, sourceBytesByCaseId, selection } = fixture()
    const truth = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
    const makePort = (
      profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    ): CaseExecutionPort => ({
      async execute(input) {
        const positive = truth.get(input.opaqueCaseId)!.expectedPresence === 'present'
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
              requestSha256: sha256(input.opaqueCaseId),
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    })
    const artifactRoot = join(root, 'artifacts')
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const common = {
      freeze,
      annotations,
      sourceBytesByCaseId,
      selection,
      selectionPath: join(root, 'selection.json'),
      artifactRoot,
      ledger,
      candidatePort: makePort(PROFILE_CANDIDATE_ID),
      controlPort: makePort(PROFILE_CONTROL_ID),
      runtimeArtifacts: {
        masksBySha256: new Map(),
        cutoutsBySha256: new Map(),
        cutoutsByProfileAndCase: new Map(),
      },
    }
    const report = await executeDevScreen({ ...common, screen: 'dev8' })
    const { reportSha256: _discarded, ...reportBody } = report
    const forgedBody = {
      ...reportBody,
      outputs: report.outputs.map((row, index) =>
        index === 0 ? { ...row, candidateCaseState: 'unknown' } : row,
      ),
    }
    const forged = devScreenReportSchema.parse({
      ...forgedBody,
      reportSha256: hashIdentity(forgedBody),
    })
    await writeFile(
      join(artifactRoot, 'reports', 'dev8-report.json'),
      `${JSON.stringify(forged)}\n`,
      'utf8',
    )
    await sealDevScreenReview(
      artifactRoot,
      forged,
      'advance',
      'Self-hashed but forged offline fixture.',
    )
    await assert.rejects(
      () => executeDevScreen({ ...common, screen: 'dev12' }),
      /does not match immutable case artifacts/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('expired and pre-aborted DEV screens make zero port calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-deadline-preflight-'))
  try {
    const { freeze: base, annotations, sourceBytesByCaseId } = fixture()
    let calls = 0
    const makePort = (profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID) =>
      ({
        async execute() {
          calls++
          throw new Error(`unexpected ${profileId} dispatch`)
        },
      }) satisfies CaseExecutionPort
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const runtimeArtifacts = {
      masksBySha256: new Map(),
      cutoutsBySha256: new Map(),
      cutoutsByProfileAndCase: new Map(),
    }
    const expiredFreeze = {
      ...base,
      deadlineIso: new Date(Date.now() - 60_000).toISOString(),
    }
    const expiredSelection = buildDevScreenSelection(expiredFreeze, annotations)
    await assert.rejects(
      executeDevScreen({
        freeze: expiredFreeze,
        annotations,
        sourceBytesByCaseId,
        selection: expiredSelection,
        screen: 'dev8',
        selectionPath: join(root, 'expired-selection.json'),
        artifactRoot: join(root, 'expired-artifacts'),
        ledger,
        candidatePort: makePort(PROFILE_CANDIDATE_ID),
        controlPort: makePort(PROFILE_CONTROL_ID),
        runtimeArtifacts,
      }),
      /Phase deadline has expired/u,
    )

    const controller = new AbortController()
    controller.abort()
    const selection = buildDevScreenSelection(base, annotations)
    const report = await executeDevScreen({
      freeze: base,
      annotations,
      sourceBytesByCaseId,
      selection,
      screen: 'dev8',
      selectionPath: join(root, 'cancelled-selection.json'),
      artifactRoot: join(root, 'cancelled-artifacts'),
      ledger,
      candidatePort: makePort(PROFILE_CANDIDATE_ID),
      controlPort: makePort(PROFILE_CONTROL_ID),
      runtimeArtifacts,
      signal: controller.signal,
    })
    assert.ok(report.hardBlockers.some((item) => item.includes('PHASE_CALLER_ABORTED')))
    assert.equal(calls, 0)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('DEV phase deadline aborts an active port and waits for its settlement before stopping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h8a-dev-deadline-inflight-'))
  try {
    const { freeze: base, annotations, sourceBytesByCaseId } = fixture()
    const freeze = {
      ...base,
      deadlineIso: new Date(Date.now() + 1_000).toISOString(),
    }
    const selection = buildDevScreenSelection(freeze, annotations)
    const truth = new Map(annotations.cases.map((row) => [row.opaqueCaseId, row]))
    const calls = new Map<string, number>()
    let settledAfterAbort = false
    const makePort = (
      profileId: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    ): CaseExecutionPort => ({
      async execute(input, context) {
        const key = `${profileId}:${input.opaqueCaseId}`
        calls.set(key, (calls.get(key) ?? 0) + 1)
        const signal = context.signal
        assert.ok(signal)
        if (!signal.aborted)
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  settledAfterAbort = true
                  resolve()
                }, 25)
              },
              { once: true },
            )
          })
        const positive = truth.get(input.opaqueCaseId)!.expectedPresence === 'present'
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
              requestSha256: sha256(key),
              physicalIds: [],
              outcome: 'resolved' as const,
            },
          ],
          physicalReceipts: [],
        }
      },
    })
    const ledger = await CampaignLedger.open(join(root, 'ledger.json'))
    const report = await executeDevScreen({
      freeze,
      annotations,
      sourceBytesByCaseId,
      selection,
      screen: 'dev8',
      selectionPath: join(root, 'selection.json'),
      artifactRoot: join(root, 'artifacts'),
      ledger,
      candidatePort: makePort(PROFILE_CANDIDATE_ID),
      controlPort: makePort(PROFILE_CONTROL_ID),
      runtimeArtifacts: {
        masksBySha256: new Map(),
        cutoutsBySha256: new Map(),
        cutoutsByProfileAndCase: new Map(),
      },
    })
    assert.equal(calls.size, 1)
    assert.equal(settledAfterAbort, true)
    assert.ok(report.hardBlockers.some((item) => item.startsWith('phase-execution-stopped:')))
    assert.equal(report.completedPairs, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
