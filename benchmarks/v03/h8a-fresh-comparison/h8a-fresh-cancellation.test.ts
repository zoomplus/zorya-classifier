import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CampaignLedger } from './campaign-ledger.js'
import { PHASE_DEV40_ID } from './constants.js'
import { runPairedPhase, type CaseExecutionPort } from './paired-runner.js'
import { runInjectedPhysicalFetch } from './physical-dispatch.js'
import { buildSyntheticPhaseFreeze } from './test-fixtures.js'

await test('cancellation awaits injected physical work before settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-cancel-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const controller = new AbortController()
    let fetchStarted = false
    const work = runInjectedPhysicalFetch(ledger, 0.01, async () => {
      fetchStarted = true
      await Promise.resolve()
      if (controller.signal.aborted) throw new Error('aborted-after-await')
      return { result: 'ok', costUsd: 0.001 }
    })
    await Promise.resolve()
    controller.abort()
    await assert.rejects(work, /aborted-after-await/)
    assert.equal(fetchStarted, true)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 1)
    assert.ok(snapshot.unknownReserveUsd > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired abort retains full scheduled row set for both arms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-cancel-'))
  try {
    const { freeze, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const controller = new AbortController()
    let started = 0
    const slowPort: CaseExecutionPort = {
      async execute(input, context) {
        started++
        await Promise.resolve()
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
              requestSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
              physicalIds: [],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [],
        }
      },
    }
    const { candidateCloseout, controlCloseout } = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: slowPort,
      controlPort: slowPort,
      sourceBytesByCaseId,
      reservedUsdPerFetch: 0.005,
      signal: controller.signal,
    })
    assert.equal(candidateCloseout.outputRows.length, freeze.producerCases.length)
    assert.equal(controlCloseout.outputRows.length, freeze.producerCases.length)
    assert.ok(
      candidateCloseout.outputRows.some(
        (row) => row.caseState === 'cancelled' || row.caseState === 'success',
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('malformed and expired phase deadlines reject before any paired port dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-phase-deadline-invalid-'))
  try {
    const { freeze: base, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    let calls = 0
    const port: CaseExecutionPort = {
      async execute() {
        calls++
        throw new Error('unexpected dispatch')
      },
    }
    await assert.rejects(
      runPairedPhase({
        freeze: { ...base, deadlineIso: 'not-an-iso-timestamp' },
        ledger,
        candidatePort: port,
        controlPort: port,
        sourceBytesByCaseId,
      }),
    )
    await assert.rejects(
      runPairedPhase({
        freeze: { ...base, deadlineIso: new Date(Date.now() - 60_000).toISOString() },
        ledger,
        candidatePort: port,
        controlPort: port,
        sourceBytesByCaseId,
      }),
      /Phase deadline has expired/u,
    )
    const controller = new AbortController()
    controller.abort()
    const cancelled = await runPairedPhase({
      freeze: base,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
      signal: controller.signal,
    })
    assert.equal(calls, 0)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
    assert.ok(cancelled.candidateCloseout.outputRows.every((row) => row.caseState === 'cancelled'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('paired phase deadline aborts active port work and waits for settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-phase-deadline-inflight-'))
  try {
    const { freeze: base, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
    const freeze = {
      ...base,
      deadlineIso: new Date(Date.now() + 1_000).toISOString(),
    }
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    let started = 0
    let settledAfterAbort = false
    const port: CaseExecutionPort = {
      async execute(input, context) {
        started++
        const signal = context.signal
        assert.ok(signal)
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
        return {
          outputRow: {
            schema: 'h8a-fresh-output-row-v1',
            opaqueCaseId: input.opaqueCaseId,
            profileId: context.profileId,
            executionValidity: 'valid',
            caseState: 'unknown',
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
              requestSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
              physicalIds: [],
              outcome: 'unknown',
            },
          ],
          physicalReceipts: [],
        }
      },
    }
    const result = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: port,
      controlPort: port,
      sourceBytesByCaseId,
    })
    assert.equal(started, 1)
    assert.equal(settledAfterAbort, true)
    assert.equal(result.candidateCloseout.outputRows.length, freeze.producerCases.length)
    assert.equal(result.controlCloseout.outputRows.length, freeze.producerCases.length)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
