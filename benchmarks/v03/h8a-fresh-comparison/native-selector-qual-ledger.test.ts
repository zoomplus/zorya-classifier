import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PROFILE_CONTROL_ID, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID } from './constants.js'
import { NativeSelectorQualLedger } from './native-selector-qual-ledger.js'

const caseIds = Array.from({ length: 120 }, (_, index) => `offline-case-${index}`)
const parent = {
  ledgerVersion: 180,
  physicalDispatchCount: 317,
  logicalAttemptCount: 103,
  knownCostUsd: 0.191844515,
  unknownReserveUsd: 0.24,
  nextPhysicalId: 318,
  nextReservationId: 318,
}

async function makeLedger(root: string, parentSnapshot: typeof parent = parent) {
  return NativeSelectorQualLedger.openOfflineForTest(join(root, 'ledger.json'), {
    offlineTestOnly: true,
    namespaceRoot: root,
    caseIds,
    parent: parentSnapshot,
  })
}

async function dispatch(
  ledger: NativeSelectorQualLedger,
  profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
  opaqueCaseId: string,
) {
  const reservation = await ledger.admitPhysical(0.12, { profileId, opaqueCaseId })
  await ledger.recordDispatchIntent(reservation)
  const physicalId = await ledger.markDispatched(reservation)
  await ledger.settle(reservation, 0.12)
  return physicalId
}

await test('QUAL offline ledger allows exactly four candidate and six control calls per case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-qual-ledger-'))
  try {
    const ledger = await makeLedger(root)
    const firstCase = caseIds[0]!
    const candidateIds: number[] = []
    const controlIds: number[] = []
    for (let index = 0; index < 4; index++)
      candidateIds.push(await dispatch(ledger, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, firstCase))
    for (let index = 0; index < 6; index++)
      controlIds.push(await dispatch(ledger, PROFILE_CONTROL_ID, firstCase))
    assert.equal(new Set([...candidateIds, ...controlIds]).size, 10)
    await assert.rejects(
      dispatch(ledger, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, firstCase),
      /per-case physical call cap exhausted/u,
    )
    await assert.rejects(dispatch(ledger, PROFILE_CONTROL_ID, firstCase), /cap exhausted/u)
    assert.equal(ledger.snapshot().physicalDispatchCount, 327)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('QUAL per-case capacity keeps dispatched reservations charged until settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-qual-dispatched-pending-'))
  try {
    const ledger = await makeLedger(root)
    const opaqueCaseId = caseIds[5]!
    const reservations: number[] = []
    const physicalIds: number[] = []
    for (let index = 0; index < 4; index++) {
      const reservation = await ledger.admitPhysical(0.12, {
        profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
        opaqueCaseId,
      })
      reservations.push(reservation)
      await ledger.recordDispatchIntent(reservation)
      physicalIds.push(await ledger.markDispatched(reservation))
    }
    assert.equal(physicalIds.length, 4)
    await assert.rejects(
      ledger.admitPhysical(0.12, {
        profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
        opaqueCaseId,
      }),
      /per-case physical call cap exhausted/u,
    )
    for (const reservation of reservations) await ledger.settle(reservation, 0.12)
    assert.equal(ledger.snapshot().physicalDispatchCount, parent.physicalDispatchCount + 4)
    assert.equal(ledger.snapshot().inFlightReservations.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('QUAL unknown charges remain reserved and intent crashes remain uncertain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-qual-ledger-'))
  try {
    const ledger = await makeLedger(root)
    const reservation = await ledger.admitPhysical(0.12, {
      profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
      opaqueCaseId: caseIds[1]!,
    })
    await ledger.recordDispatchIntent(reservation)
    await ledger.markDispatched(reservation)
    await ledger.settle(reservation, null)
    assert.equal(ledger.snapshot().unknownReserveUsd, parent.unknownReserveUsd + 0.12)
    assert.equal(ledger.snapshot().knownCostUsd, parent.knownCostUsd)

    const crashReservation = await ledger.admitPhysical(0.12, {
      profileId: PROFILE_CONTROL_ID,
      opaqueCaseId: caseIds[2]!,
    })
    await ledger.recordDispatchIntent(crashReservation)
    await ledger.markCrashWithPendingDispatch()
    assert.equal(ledger.snapshot().resumeBlocked, true)
    assert.equal(ledger.snapshot().unknownReserveUsd, parent.unknownReserveUsd + 0.24)
    await assert.rejects(
      ledger.admitPhysical(0.12, {
        profileId: PROFILE_CONTROL_ID,
        opaqueCaseId: caseIds[3]!,
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('QUAL offline ledger rejects a target path outside its declared namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selector-qual-ledger-'))
  const outside = await mkdtemp(join(tmpdir(), 'native-selector-qual-ledger-outside-'))
  try {
    await assert.rejects(
      NativeSelectorQualLedger.openOfflineForTest(join(outside, 'ledger.json'), {
        offlineTestOnly: true,
        namespaceRoot: root,
        caseIds,
        parent,
      }),
      /escapes its canonical test namespace/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

await test('QUAL ledger counts pending reservations against exact phase and global ceilings', async () => {
  const phaseRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-phase-cap-'))
  const globalRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-global-cap-'))
  try {
    const phaseLedger = await makeLedger(phaseRoot)
    const pending: number[] = []
    for (const opaqueCaseId of caseIds) {
      for (const [profileId, calls] of [
        [PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, 4],
        [PROFILE_CONTROL_ID, 6],
      ] as const) {
        for (let index = 0; index < calls; index++) {
          pending.push(await phaseLedger.admitPhysical(0.12, { profileId, opaqueCaseId }))
        }
      }
    }
    assert.equal(pending.length, 1_200)
    await assert.rejects(
      phaseLedger.admitPhysical(0.12, {
        profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
        opaqueCaseId: caseIds[0]!,
      }),
      /global, phase, or exposure budget exhausted/u,
    )

    const nearGlobalCap = {
      ...parent,
      physicalDispatchCount: 1_996,
      nextPhysicalId: 1_997,
    }
    const globalLedger = await makeLedger(globalRoot, nearGlobalCap)
    for (let index = 0; index < 4; index++) {
      await globalLedger.admitPhysical(0.12, {
        profileId: PROFILE_CONTROL_ID,
        opaqueCaseId: caseIds[index]!,
      })
    }
    await assert.rejects(
      globalLedger.admitPhysical(0.12, {
        profileId: PROFILE_CONTROL_ID,
        opaqueCaseId: caseIds[4]!,
      }),
      /global, phase, or exposure budget exhausted/u,
    )
    assert.equal(globalLedger.snapshot().physicalDispatchCount, 1_996)
    assert.equal(globalLedger.snapshot().inFlightReservations.length, 4)
  } finally {
    await rm(phaseRoot, { recursive: true, force: true })
    await rm(globalRoot, { recursive: true, force: true })
  }
})
