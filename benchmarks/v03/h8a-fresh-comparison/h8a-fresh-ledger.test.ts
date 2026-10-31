import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CampaignBudgetExhaustedError,
  CampaignLedger,
  CampaignLedgerBlockedError,
  CampaignLedgerPersistFailureError,
} from './campaign-ledger.js'
import {
  cancelUnstartedPhysicalReservation,
  finalizeObservedPhysicalDispatch,
  invokeInjectedWork,
  PhysicalDispatchConfirmFailedError,
  runInjectedPhysicalFetch,
  runPreflightOnlyLogicalAttempt,
} from './physical-dispatch.js'
import { CAMPAIGN_MAX_PHYSICAL_CALLS } from './constants.js'

await test('preflight logical attempt records zero physical dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const before = ledger.snapshot()
    await runPreflightOnlyLogicalAttempt(ledger, () => {
      throw new RangeError('invalid producer')
    }).catch(() => undefined)
    const after = ledger.snapshot()
    assert.equal(after.physicalDispatchCount, before.physicalDispatchCount)
    assert.equal(after.logicalAttemptCount, before.logicalAttemptCount + 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('physical dispatch increments only at fetch and unknown post-fetch retains reserve', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    await assert.rejects(
      () =>
        runInjectedPhysicalFetch(ledger, 0.01, async () => {
          throw new RangeError('fetch failed')
        }),
      /fetch failed/,
    )
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 1)
    assert.equal(snapshot.inFlightReservations.length, 0)
    assert.ok(snapshot.unknownReserveUsd > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('cancel before fetch releases latest unstarted reservation only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const first = await ledger.admitPhysical(0.01)
    await cancelUnstartedPhysicalReservation(ledger, first)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 0)
    const second = await ledger.admitPhysical(0.01)
    await ledger.recordDispatchIntent(second)
    await ledger.markDispatched(second)
    await assert.rejects(() => cancelUnstartedPhysicalReservation(ledger, second))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('resume with pending in-flight reservations fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  const path = join(directory, 'ledger.json')
  try {
    const ledger = await CampaignLedger.open(path)
    const reservation = await ledger.admitPhysical(0.01)
    await ledger.recordDispatchIntent(reservation)
    await ledger.markDispatched(reservation)
    const raw = await readFile(path, 'utf8')
    const reloaded = await CampaignLedger.open(path)
    assert.throws(() => reloaded.assertResumeAllowed(), CampaignLedgerBlockedError)
    await assert.rejects(() => reloaded.admitPhysical(0.01), CampaignLedgerBlockedError)
    assert.equal(JSON.parse(raw).inFlightReservations.length, 1)
    assert.equal(JSON.parse(raw).resumeBlocked, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('physical reservation without dispatch keeps zero physical count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const reservation = await ledger.admitPhysical(0.01)
    assert.ok(reservation > 0)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 0)
    assert.equal(snapshot.inFlightReservations.length, 1)
    await cancelUnstartedPhysicalReservation(ledger, reservation)
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('two ledger instances serialize admissions under shared path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  const path = join(directory, 'ledger.json')
  try {
    const left = await CampaignLedger.open(path)
    const right = await CampaignLedger.open(path)
    const reservations = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? left : right).admitPhysical(0.001),
      ),
    )
    assert.equal(reservations.length, 40)
    for (const reservationId of reservations) {
      const owner = reservationId % 2 === 0 ? left : right
      await owner.recordDispatchIntent(reservationId)
      await owner.markDispatched(reservationId)
      await owner.settle(reservationId, 0.0001)
    }
    const snapshot = left.snapshot()
    assert.ok(snapshot.physicalDispatchCount <= CAMPAIGN_MAX_PHYSICAL_CALLS)
    assert.ok(snapshot.knownCostUsd + snapshot.unknownReserveUsd <= 10 + 1e-9)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('competing admissions stay within campaign physical ceiling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const attempts = Array.from({ length: 20 }, () => ledger.admitPhysical(0.001))
    const ids = await Promise.all(attempts)
    assert.equal(ids.length, 20)
    for (const id of ids) {
      await ledger.recordDispatchIntent(id)
      await ledger.markDispatched(id)
      await ledger.settle(id, 0.0001)
    }
    const nearLimit = CAMPAIGN_MAX_PHYSICAL_CALLS - ledger.snapshot().physicalDispatchCount
    let admitted = 0
    for (let index = 0; index < nearLimit; index++) {
      const id = await ledger.admitPhysical(0.000001)
      await ledger.recordDispatchIntent(id)
      await ledger.markDispatched(id)
      await ledger.settle(id, 0.000001)
      admitted++
    }
    assert.ok(admitted > 0)
    await assert.rejects(() => ledger.admitPhysical(0.000001), CampaignBudgetExhaustedError)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('physical dispatch records intent before observed count during handler', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    let inspectedDuringInvocation = false
    const result = await runInjectedPhysicalFetch(ledger, 0.01, async () => {
      const snapshot = ledger.snapshot()
      const reservation = snapshot.inFlightReservations[0]
      assert.ok(reservation?.dispatchIntentRecorded)
      assert.equal(snapshot.physicalDispatchCount, 0)
      inspectedDuringInvocation = true
      return { result: 'ok', costUsd: 0.001 }
    })
    assert.equal(inspectedDuringInvocation, true)
    assert.equal(result.observedDispatchConfirmed, true)
    assert.equal(ledger.snapshot().physicalDispatchCount, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('async injected fetch rejection settles once with confirmed physical ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const reservedUsd = 0.01
    await assert.rejects(
      () =>
        runInjectedPhysicalFetch(ledger, reservedUsd, async () => {
          await Promise.resolve()
          throw new RangeError('async fetch reject')
        }),
      /async fetch reject/,
    )
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 1)
    assert.equal(snapshot.inFlightReservations.length, 0)
    assert.equal(snapshot.unknownReserveUsd, reservedUsd)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('invokeInjectedWork attaches handlers before async fetch rejection', async () => {
  const workOutcomePromise = invokeInjectedWork(async () => {
    await Promise.resolve()
    throw new RangeError('deferred reject')
  })
  const outcome = await workOutcomePromise
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(String(outcome.error), /deferred reject/)
})

await test('finalizeObservedPhysicalDispatch returns fetch failure without duplicate settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const reservedUsd = 0.015
    const reservationId = await ledger.admitPhysical(reservedUsd)
    await ledger.recordDispatchIntent(reservationId)
    const workOutcomePromise = invokeInjectedWork(async () => {
      await Promise.resolve()
      throw new RangeError('finalize async reject')
    })
    const outcome = await finalizeObservedPhysicalDispatch(
      ledger,
      reservationId,
      workOutcomePromise,
      () => null,
    )
    switch (outcome.kind) {
      case 'fetch_failed_settled_unknown':
        assert.equal(outcome.disposition.kind, 'settled_once')
        assert.equal(outcome.disposition.costUsd, null)
        break
      default:
        assert.fail(`unexpected finalize outcome ${outcome.kind}`)
    }
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 1)
    assert.equal(snapshot.unknownReserveUsd, reservedUsd)
    await assert.rejects(() => ledger.settle(reservationId, null), /Unknown physical reservation/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('synchronous injected fetch throw confirms observation and settles unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    await assert.rejects(
      () =>
        runInjectedPhysicalFetch(ledger, 0.01, (() => {
          throw new RangeError('sync fetch throw')
        }) as Parameters<typeof runInjectedPhysicalFetch>[2]),
      /sync fetch throw/,
    )
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 1)
    assert.equal(snapshot.inFlightReservations.length, 0)
    assert.ok(snapshot.unknownReserveUsd > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('dispatch confirmation persist failure awaits fetch and blocks recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  const path = join(directory, 'ledger.json')
  try {
    const ledger = await CampaignLedger.open(path)
    let fetchSettled = false
    ledger.scheduleSimulatedPersistFailureAfterSuccessfulTransactions(2)
    await assert.rejects(
      () =>
        runInjectedPhysicalFetch(ledger, 0.01, async () => {
          await Promise.resolve()
          fetchSettled = true
          return { result: 'done', costUsd: 0.002 }
        }),
      PhysicalDispatchConfirmFailedError,
    )
    assert.equal(fetchSettled, true)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.physicalDispatchCount, 0)
    assert.ok(snapshot.unknownReserveUsd >= 0.01)
    assert.equal(snapshot.crashRecoveryLatched, true)
    assert.throws(() => ledger.assertResumeAllowed(), CampaignLedgerBlockedError)
    await assert.rejects(() => ledger.admitPhysical(0.01), CampaignLedgerBlockedError)
    const reloaded = await CampaignLedger.open(path)
    assert.throws(() => reloaded.assertResumeAllowed(), CampaignLedgerBlockedError)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('simulated persist failure rolls back in-memory dispatch count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h8a-ledger-'))
  try {
    const ledger = await CampaignLedger.open(join(directory, 'ledger.json'))
    const reservation = await ledger.admitPhysical(0.01)
    await ledger.recordDispatchIntent(reservation)
    ledger.scheduleSimulatedPersistFailureAfterSuccessfulTransactions(0)
    await assert.rejects(
      () => ledger.markDispatched(reservation),
      CampaignLedgerPersistFailureError,
    )
    assert.equal(ledger.snapshot().physicalDispatchCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
