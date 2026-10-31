import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CampaignLedger, CampaignLedgerBlockedError } from './campaign-ledger.js'
import { PHASE_DEV40_ID, PROFILE_CANDIDATE_ID } from './constants.js'
import { validateConservativeCostProof } from './freeze-admission.js'
import {
  runInjectedFetchCasePort,
  runPairedPhase,
  type CaseExecutionPort,
} from './paired-runner.js'
import { buildConservativeCostProof, buildSyntheticPhaseFreeze } from './test-fixtures.js'

await test('conservative cost proof accepts high phase envelope without future-spend rejection', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const proof = buildConservativeCostProof(0.55, {
    candidateMaxUsdPerPhysicalDispatch: 0.55,
    controlMaxUsdPerPhysicalDispatch: 0.12,
  })
  assert.doesNotThrow(() =>
    validateConservativeCostProof({
      ...freeze,
      conservativeCostProof: proof,
    }),
  )
})

await test('dispatch intent without observed fetch keeps zero physical count and blocks resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  const path = join(directory, 'ledger.json')
  try {
    const ledger = await CampaignLedger.open(path)
    const reservation = await ledger.admitPhysical(0.01)
    await ledger.recordDispatchIntent(reservation)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
    const reloaded = await CampaignLedger.open(path)
    assert.throws(() => reloaded.assertResumeAllowed(), CampaignLedgerBlockedError)
    await assert.rejects(() => reloaded.admitPhysical(0.01), CampaignLedgerBlockedError)
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { resumeBlocked: boolean }
    assert.equal(persisted.resumeBlocked, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('ledger transaction reload preserves resume barrier after pending dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  const path = join(directory, 'ledger.json')
  try {
    const ledger = await CampaignLedger.open(path)
    const reservation = await ledger.admitPhysical(0.01)
    await ledger.recordDispatchIntent(reservation)
    await ledger.markDispatched(reservation)
    await ledger.recordLogicalAttempt()
    await assert.rejects(() => ledger.admitPhysical(0.01), CampaignLedgerBlockedError)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('lock release rejects invalid lock payload without deleting foreign lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  const ledgerPath = join(directory, 'ledger.json')
  const lockPath = `${ledgerPath}.lock`
  try {
    await writeFile(lockPath, '{ "unexpected": true }', 'utf8')
    await assert.rejects(() => CampaignLedger.open(ledgerPath), CampaignLedgerBlockedError)
    await assert.rejects(async () => {
      const ledger = await CampaignLedger.open(ledgerPath)
      await ledger.recordLogicalAttempt()
    }, CampaignLedgerBlockedError)
    await readFile(lockPath, 'utf8')
    await rm(lockPath, { force: true })
    const ledger = await CampaignLedger.open(ledgerPath)
    await ledger.recordLogicalAttempt()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('injected port async handler rejection emits one physical receipt and one unknown reserve', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const caseId = freeze.producerCases[0]!.opaqueCaseId
    const sourceBytes = sourceBytesByCaseId.get(caseId)!
    const reservedUsd = 0.005
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => {
      await Promise.resolve()
      throw new RangeError('async port reject')
    })
    const result = await port.execute(
      {
        opaqueCaseId: caseId,
        sourceBytes,
        targetTaskText: freeze.producerCases[0]!.targetTaskText,
      },
      {
        profileId: PROFILE_CANDIDATE_ID,
        reservedUsdPerFetch: reservedUsd,
        ledger,
      },
    )
    assert.equal(result.physicalReceipts.length, 1)
    assert.equal(result.physicalReceipts[0]?.chargeState, 'unknown')
    assert.equal(result.outputRow.physicalReceiptIds.length, 1)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 1)
    assert.equal(snapshot.unknownReserveUsd, reservedUsd)
    await assert.rejects(() => ledger.settle(1, null), /Unknown physical reservation/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('injected port dispatch confirmation persist failure awaits fetch and blocks recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  const path = join(directory, 'ledger.json')
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const caseId = freeze.producerCases[0]!.opaqueCaseId
    const sourceBytes = sourceBytesByCaseId.get(caseId)!
    const ledger = await CampaignLedger.open(path)
    ledger.scheduleSimulatedPersistFailureAfterSuccessfulTransactions(2)
    let fetchSettled = false
    const port = await runInjectedFetchCasePort(async () => {
      await Promise.resolve()
      fetchSettled = true
      return { caseState: 'not_found' as const }
    })
    const result = await port.execute(
      {
        opaqueCaseId: caseId,
        sourceBytes,
        targetTaskText: freeze.producerCases[0]!.targetTaskText,
      },
      {
        profileId: PROFILE_CANDIDATE_ID,
        reservedUsdPerFetch: 0.005,
        ledger,
      },
    )
    assert.equal(fetchSettled, true)
    assert.equal(result.physicalReceipts.length, 1)
    assert.equal(result.outputRow.physicalReceiptIds.length, 1)
    assert.equal(result.physicalReceipts[0]?.dispatchState, 'uncertain')
    assert.equal(result.physicalReceipts[0]?.physicalId, null)
    assert.equal(result.logicalReceipts[0]?.outcome, 'unknown')
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 0)
    assert.ok(snapshot.unknownReserveUsd >= 0.005)
    assert.equal(snapshot.crashRecoveryLatched, true)
    assert.throws(() => ledger.assertResumeAllowed(), CampaignLedgerBlockedError)
    const reloaded = await CampaignLedger.open(path)
    assert.throws(() => reloaded.assertResumeAllowed(), CampaignLedgerBlockedError)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('injected port settles once and keeps known charge on malformed output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const caseId = freeze.producerCases[0]!.opaqueCaseId
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async (input) => {
      if (input.opaqueCaseId !== caseId) return { caseState: 'not_found' as const }
      return {
        output: {
          caseState: 'success' as const,
          box: { left: 'invalid' as unknown as number, top: 0, width: 1, height: 1 },
        },
        costUsd: 0.0003,
      }
    })
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
    })
    const row = candidateCloseout.outputRows.find((item) => item.opaqueCaseId === caseId)
    assert.equal(row?.caseState, 'malformed')
    const physical = candidateCloseout.physicalReceipts.find((item) => item.logicalId === 1)
    assert.equal(physical?.chargeState, 'known')
    assert.equal(physical?.costUsd, 0.0003)
    assert.ok(ledger.snapshot().knownCostUsd >= 0.0003)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner retains uncertain physical receipt when arm throws after dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const failId = freeze.producerCases[0]!.opaqueCaseId
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const throwingPort: CaseExecutionPort = {
      async execute(input, context) {
        const reservationId = await context.ledger.admitPhysical(context.reservedUsdPerFetch)
        await context.ledger.recordDispatchIntent(reservationId)
        const physicalId = await context.ledger.markDispatched(reservationId)
        const partial = {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1' as const,
            opaqueCaseId: input.opaqueCaseId,
            profileId: context.profileId,
            executionValidity: 'valid' as const,
            caseState: 'error' as const,
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
            logicalReceiptIds: [1],
            physicalReceiptIds: [reservationId],
          },
          logicalReceipts: [
            {
              logicalId: 1,
              opaqueCaseId: input.opaqueCaseId,
              profileId: context.profileId,
              requestSha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
              physicalIds: [reservationId],
              outcome: 'failed' as const,
              errorCode: 'after_dispatch',
            },
          ],
          physicalReceipts: [
            {
              receiptId: reservationId,
              physicalId,
              logicalId: 1,
              dispatchState: 'confirmed' as const,
              settled: false,
              costUsd: null,
              chargeState: 'unknown' as const,
            },
          ],
        }
        if (context.dispatchJournal) context.dispatchJournal.lastPartialResult = partial
        if (input.opaqueCaseId === failId) throw new RangeError('after_dispatch')
        await context.ledger.settle(reservationId, null)
        return partial
      },
    }
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: throwingPort,
      controlPort: throwingPort,
      sourceBytesByCaseId,
    })
    const failed = candidateCloseout.outputRows.find((row) => row.opaqueCaseId === failId)
    assert.equal(failed?.physicalReceiptIds.length, 1)
    assert.ok(candidateCloseout.physicalReceipts.some((item) => item.dispatchState === 'confirmed'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner rejects reservedUsdPerFetch below frozen profile bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    await assert.rejects(
      () =>
        runPairedPhase({
          freeze,
          ledger,
          candidatePort: port,
          controlPort: port,
          sourceBytesByCaseId,
          reservedUsdPerFetch: 0.001,
        }),
      /below frozen profile dispatch bound/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired runner owns inputs before async admission so late mutation cannot cross arms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const caseId = freeze.producerCases[0]!.opaqueCaseId
    const originalHash = freeze.producerCases[0]!.sourceBytesSha256
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    const runPromise = runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
    })
    sourceBytesByCaseId.set(caseId, new Uint8Array([9, 9, 9]))
    freeze.producerCases[0]!.targetTaskText = 'mutated-after-start'
    await runPromise
    assert.equal(freeze.producerCases[0]!.sourceBytesSha256, originalHash)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('close timestamp comes from injected clock after work settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const port = await runInjectedFetchCasePort(async () => ({ caseState: 'not_found' as const }))
    const closedAtIso = '2032-01-02T00:00:00.000Z'
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      now: () => closedAtIso,
    })
    assert.equal(candidateCloseout.closedAtIso, closedAtIso)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('cancellation keeps synthetic rows without inflating ledger logical attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-regress-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const controller = new AbortController()
    let started = 0
    const port: CaseExecutionPort = {
      async execute(input, context) {
        started++
        if (started >= 2) controller.abort()
        context.signal?.throwIfAborted()
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1',
            opaqueCaseId: input.opaqueCaseId,
            profileId: context.profileId,
            executionValidity: 'valid',
            caseState: 'success',
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
              requestSha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    }
    const { candidateCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      signal: controller.signal,
    })
    assert.equal(candidateCloseout.outputRows.length, freeze.producerCases.length)
    assert.ok(candidateCloseout.outputRows.some((row) => row.caseState === 'cancelled'))
    assert.ok(ledger.snapshot().logicalAttemptCount < freeze.producerCases.length * 2)
    assert.equal(candidateCloseout.profileId, PROFILE_CANDIDATE_ID)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
