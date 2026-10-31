import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CampaignLedger } from './campaign-ledger.js'
import { PHASE_DEV40_ID, PROFILE_CANDIDATE_ID } from './constants.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import {
  runInjectedFetchCasePort,
  runPairedPhase,
  type CaseExecutionPort,
} from './paired-runner.js'
import { hashIdentity } from './hash-identity.js'
import { buildSyntheticPhaseFreeze } from './test-fixtures.js'

await test('paired runner retains every scheduled case including failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const failingId = freeze.producerCases[0]!.opaqueCaseId
    const port = await runInjectedFetchCasePort(async (input) => {
      if (input.opaqueCaseId === failingId) throw new RangeError('injected failure')
      return { caseState: 'not_found' as const }
    })
    const { candidateCloseout, controlCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      closeAtIso: '2030-06-01T12:00:00.000Z',
    })
    assert.equal(candidateCloseout.outputRows.length, freeze.producerCases.length)
    assert.equal(controlCloseout.outputRows.length, freeze.producerCases.length)
    const failed = candidateCloseout.outputRows.find((row) => row.opaqueCaseId === failingId)
    assert.equal(failed?.caseState, 'error')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner owns nested freeze inputs before its first await', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-freeze-own-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const expectedFreezeCommitment = computePhaseFreezeCommitmentSha256(freeze)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const originalAdmission = ledger.assertCanAdmitPhysicalReservedUsd.bind(ledger)
    let releaseAdmission!: () => void
    let markAdmissionStarted!: () => void
    const admissionStarted = new Promise<void>((resolve) => {
      markAdmissionStarted = resolve
    })
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve
    })
    ledger.assertCanAdmitPhysicalReservedUsd = async (reservedUsd) => {
      markAdmissionStarted()
      await admissionGate
      await originalAdmission(reservedUsd)
    }

    const observedCandidateReservations: number[] = []
    const basePort = await runInjectedFetchCasePort(async () => ({
      caseState: 'not_found' as const,
    }))
    const observingPort: CaseExecutionPort = {
      execute(input, context) {
        if (context.profileId === PROFILE_CANDIDATE_ID) {
          observedCandidateReservations.push(context.reservedUsdPerFetch)
        }
        return basePort.execute(input, context)
      },
    }

    const run = runPairedPhase({
      freeze,
      ledger,
      candidatePort: observingPort,
      controlPort: observingPort,
      sourceBytesByCaseId,
    })
    await admissionStarted

    freeze.conservativeCostProof.profileDispatchUpperBounds[0].maxUsdPerPhysicalDispatch = 0.007
    freeze.callLimits.candidateMaxPhysicalCallsPerCase = 1
    freeze.nativeLimits.maxPendingNativeJobs = 99
    freeze.qualificationIndependentMaskCaseIds.push('caller-mutation')
    freeze.sourceStrataCommitments[0]!.caseCount++

    releaseAdmission()
    const result = await run
    assert.ok(observedCandidateReservations.length > 0)
    assert.ok(observedCandidateReservations.every((amount) => amount === 0.005))
    assert.equal(result.candidateCloseout.freezeCommitmentSha256, expectedFreezeCommitment)
    assert.equal(result.candidateCloseout.outputRows.length, 40)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner preserves unstarted and preflight rows via injected port', async () => {
  const unstartedPort: CaseExecutionPort = {
    async execute(input, context) {
      return {
        outputRow: {
          schema: 'h8a-fresh-output-row-v1',
          opaqueCaseId: input.opaqueCaseId,
          profileId: context.profileId,
          executionValidity: 'valid',
          caseState: 'unstarted',
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
            profileId: context.profileId,
            requestSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            physicalIds: [],
            outcome: 'unknown',
          },
        ],
        physicalReceipts: [],
      }
    },
  }
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: unstartedPort,
      controlPort: unstartedPort,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    assert.ok(candidateCloseout.outputRows.every((row) => row.caseState === 'unstarted'))
    assert.equal(candidateCloseout.profileId, PROFILE_CANDIDATE_ID)
    assert.equal(candidateCloseout.outputRows[0]?.profileId, PROFILE_CANDIDATE_ID)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner remaps receipt graph across multiple rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    const logicalIds = new Set(candidateCloseout.logicalReceipts.map((item) => item.logicalId))
    assert.equal(logicalIds.size, candidateCloseout.logicalReceipts.length)
    for (const row of candidateCloseout.outputRows) {
      for (const logicalId of row.logicalReceiptIds) assert.ok(logicalIds.has(logicalId))
      for (const receiptId of row.physicalReceiptIds) {
        const physical = candidateCloseout.physicalReceipts.find(
          (item) => item.receiptId === receiptId,
        )
        assert.ok(physical)
        assert.ok(logicalIds.has(physical.logicalId))
      }
    }
    assert.ok(candidateCloseout.physicalDispatchCount > 0)
    assert.equal(
      candidateCloseout.physicalDispatchCount,
      candidateCloseout.physicalReceipts.filter((item) => item.dispatchState === 'confirmed')
        .length,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner clones source bytes before await so mutation cannot cross arms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const caseId = freeze.producerCases[0]!.opaqueCaseId
    const original = sourceBytesByCaseId.get(caseId)!
    const port: CaseExecutionPort = {
      async execute(input, context) {
        input.sourceBytes[0] = 255
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1',
            opaqueCaseId: input.opaqueCaseId,
            profileId: context.profileId,
            executionValidity: 'valid',
            caseState: 'not_found',
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
              profileId: context.profileId,
              requestSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    }
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    assert.notEqual(original[0], 255)
    assert.equal(sourceBytesByCaseId.get(caseId)?.[0], original[0])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('preflight failure keeps zero physical receipts', async () => {
  const preflightPort: CaseExecutionPort = {
    async execute(input, context) {
      return {
        outputRow: {
          schema: 'h8a-fresh-output-row-v1',
          opaqueCaseId: input.opaqueCaseId,
          profileId: context.profileId,
          executionValidity: 'valid',
          caseState: 'preflight_failed',
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
            profileId: context.profileId,
            requestSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            physicalIds: [],
            outcome: 'preflight_failed',
          },
        ],
        physicalReceipts: [],
      }
    },
  }
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const before = ledger.snapshot().physicalDispatchCount
    await runPairedPhase({
      freeze,
      ledger,
      candidatePort: preflightPort,
      controlPort: preflightPort,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    const after = ledger.snapshot().physicalDispatchCount
    assert.equal(after, before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('injected fetch port records intent before physical count during handler', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const caseId = freeze.producerCases[0]!.opaqueCaseId
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    let inspectedDuringInvocation = false
    const port = await runInjectedFetchCasePort(async (input) => {
      if (input.opaqueCaseId !== caseId) return { caseState: 'not_found' as const }
      const snapshot = ledger.snapshot()
      const reservation = snapshot.inFlightReservations[0]
      assert.ok(reservation?.dispatchIntentRecorded)
      assert.equal(snapshot.physicalDispatchCount, 0)
      inspectedDuringInvocation = true
      return { caseState: 'not_found' as const }
    })
    await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    assert.equal(inspectedDuringInvocation, true)
    assert.ok(ledger.snapshot().physicalDispatchCount > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('injected fetch port accepts explicit known cost and keeps unknown reserve otherwise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const knownCaseId = freeze.producerCases[0]!.opaqueCaseId
    const port = await runInjectedFetchCasePort(async (input) => {
      if (input.opaqueCaseId === knownCaseId) {
        return { output: { caseState: 'not_found' as const }, costUsd: 0.0002 }
      }
      return { output: { caseState: 'not_found' as const } }
    })
    await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    const snapshot = ledger.snapshot()
    assert.ok(snapshot.knownCostUsd >= 0.0002)
    assert.ok(snapshot.unknownReserveUsd > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner records one ledger logical attempt per arm', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    const expectedAttempts = freeze.producerCases.length * 2
    assert.equal(ledger.snapshot().logicalAttemptCount, expectedAttempts)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('closeout hash binds closedAtIso when persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    const closedAtIso = '2031-03-15T08:30:00.000Z'
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      now: () => closedAtIso,
    })
    assert.equal(candidateCloseout.closedAtIso, closedAtIso)
    const recomputed = hashIdentity({
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
    assert.equal(recomputed, candidateCloseout.closeoutSha256)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('freeze admission rejection performs zero physical dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledgerPath = join(directory, 'ledger.json')
    const ledger = await CampaignLedger.open(ledgerPath)
    const reservation = await ledger.admitPhysical(10)
    await ledger.recordDispatchIntent(reservation)
    await ledger.markDispatched(reservation)
    await ledger.settle(reservation, null)
    const exhaustedLedger = await CampaignLedger.open(ledgerPath)
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger: exhaustedLedger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    assert.equal(exhaustedLedger.snapshot().physicalDispatchCount, 1)
    assert.ok(candidateCloseout.outputRows.every((row) => row.caseState === 'preflight_failed'))
    assert.equal(candidateCloseout.physicalDispatchCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('missing source bytes retain preflight rows for all remaining arms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-paired-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const corruptId = freeze.producerCases[5]!.opaqueCaseId
    sourceBytesByCaseId.delete(corruptId)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    const { candidateCloseout, controlCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
    })
    assert.equal(candidateCloseout.outputRows.length, freeze.producerCases.length)
    assert.equal(controlCloseout.outputRows.length, freeze.producerCases.length)
    const failedRow = candidateCloseout.outputRows.find((row) => row.opaqueCaseId === corruptId)
    assert.equal(failedRow?.caseState, 'preflight_failed')
    assert.ok(
      candidateCloseout.outputRows
        .slice(freeze.producerCases.findIndex((row) => row.opaqueCaseId === corruptId))
        .every((row) => row.caseState === 'preflight_failed'),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
