import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ProviderRefusalReplayLedger,
  REPLAY_CANDIDATE_MAX_USD,
  REPLAY_CONTROL_MAX_USD,
} from './provider-refusal-replay-ledger.js'
import { PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'

async function withLedger(
  run: (ledger: ProviderRefusalReplayLedger, root: string) => Promise<void>,
): Promise<void> {
  const outer = await mkdtemp(join(tmpdir(), 'provider-refusal-ledger-'))
  const namespace = join(outer, 'provider-refusal-dev40-replay-v1')
  const root = join(namespace, 'admission', 'successor-campaign')
  await mkdir(join(namespace, 'admission'), { recursive: true })
  const caseIds = Array.from({ length: 40 }, (_, index) => `case-${index}`)
  try {
    const ledger = await ProviderRefusalReplayLedger.register({
      root,
      offlineTestOnly: true,
      protocolSha256: 'a'.repeat(64),
      caseIds,
    })
    await run(ledger, root)
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
}

await test('ledger inherits immutable parent baseline and accounts known and unknown charges distinctly', async () => {
  await withLedger(async (ledger) => {
    const baseline = ledger.snapshot()
    assert.equal(baseline.physicalDispatchCount, 202)
    assert.equal(baseline.logicalAttemptCount, 63)
    assert.equal(baseline.knownCostUsd, 0.11840506499999993)
    assert.equal(baseline.unknownReserveUsd, 0.24)
    const known = await ledger.admitPhysical(REPLAY_CANDIDATE_MAX_USD, {
      profileId: PROFILE_FLAT_CANDIDATE_ID,
      opaqueCaseId: 'case-0',
    })
    await ledger.recordDispatchIntent(known)
    const physicalId = await ledger.markDispatched(known)
    assert.equal(physicalId, 203)
    await ledger.settle(known, 0.2)
    const unknown = await ledger.admitPhysical(REPLAY_CONTROL_MAX_USD, {
      profileId: PROFILE_CONTROL_ID,
      opaqueCaseId: 'case-1',
    })
    await ledger.recordDispatchIntent(unknown)
    await ledger.markDispatched(unknown)
    await ledger.settle(unknown, null)
    const after = ledger.snapshot()
    assert.equal(after.physicalDispatchCount, 204)
    assert.equal(after.knownCostUsd, 0.31840506499999993)
    assert.equal(after.unknownReserveUsd, 0.36)
    assert.equal(after.resumeBlocked, false)
  })
})

await test('concurrent ledger instances serialize reservations and reserve all pending exposure', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'provider-refusal-ledger-race-'))
  const namespace = join(outer, 'provider-refusal-dev40-replay-v1')
  const root = join(namespace, 'admission', 'successor-campaign')
  await mkdir(join(namespace, 'admission'), { recursive: true })
  const caseIds = Array.from({ length: 40 }, (_, index) => `case-${index}`)
  try {
    const first = await ProviderRefusalReplayLedger.register({
      root,
      offlineTestOnly: true,
      protocolSha256: 'b'.repeat(64),
      caseIds,
    })
    const second = await ProviderRefusalReplayLedger.register({
      root,
      offlineTestOnly: true,
      protocolSha256: 'b'.repeat(64),
      caseIds,
    })
    const ids = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        (index % 2 ? first : second).admitPhysical(REPLAY_CANDIDATE_MAX_USD, {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          opaqueCaseId: 'case-0',
        }),
      ),
    )
    assert.equal(new Set(ids).size, 4)
    await assert.rejects(
      first.admitPhysical(REPLAY_CANDIDATE_MAX_USD, {
        profileId: PROFILE_FLAT_CANDIDATE_ID,
        opaqueCaseId: 'case-0',
      }),
      /Per-case/u,
    )
    assert.equal(first.snapshot().inFlightReservations.length, 4)
    await assert.rejects(second.assertExposureAllowsAdditionalUsd(117), /exposure/u)
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('confirmed but unsettled calls occupy their counted slots only once', async () => {
  await withLedger(async (ledger) => {
    for (let index = 0; index < 4; index++) {
      const reservation = await ledger.admitPhysical(REPLAY_CANDIDATE_MAX_USD, {
        profileId: PROFILE_FLAT_CANDIDATE_ID,
        opaqueCaseId: 'case-0',
      })
      await ledger.recordDispatchIntent(reservation)
      await ledger.markDispatched(reservation)
    }
    assert.equal(ledger.snapshot().physicalDispatchCount, 206)
    assert.equal(ledger.snapshot().inFlightReservations.length, 4)
    await assert.rejects(
      ledger.admitPhysical(REPLAY_CANDIDATE_MAX_USD, {
        profileId: PROFILE_FLAT_CANDIDATE_ID,
        opaqueCaseId: 'case-0',
      }),
      /Per-case/u,
    )
  })
})

await test('ledger binds physical and logical attempts to the frozen IDs and serializes different registration identities', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'provider-refusal-ledger-registration-'))
  const namespace = join(outer, 'provider-refusal-dev40-replay-v1')
  const root = join(namespace, 'admission', 'successor-campaign')
  await mkdir(join(namespace, 'admission'), { recursive: true })
  const caseIds = Array.from({ length: 40 }, (_, index) => `case-${index}`)
  try {
    const registrations = await Promise.allSettled([
      ProviderRefusalReplayLedger.register({
        root,
        offlineTestOnly: true,
        protocolSha256: 'c'.repeat(64),
        caseIds,
      }),
      ProviderRefusalReplayLedger.register({
        root,
        offlineTestOnly: true,
        protocolSha256: 'd'.repeat(64),
        caseIds,
      }),
    ])
    const created = registrations.filter((result) => result.status === 'fulfilled')
    const refused = registrations.filter((result) => result.status === 'rejected')
    assert.equal(created.length, 1)
    assert.equal(refused.length, 1)
    assert.match(
      String(refused[0]?.status === 'rejected' ? refused[0].reason : ''),
      /different protocol/u,
    )
    const ledger = created[0]?.status === 'fulfilled' ? created[0].value : undefined
    assert.ok(ledger)
    await assert.rejects(
      ledger.admitPhysical(REPLAY_CANDIDATE_MAX_USD, {
        profileId: PROFILE_FLAT_CANDIDATE_ID,
        opaqueCaseId: 'foreign-case',
      }),
      /frozen cohort/u,
    )
    await ledger.recordLogicalAttempt({
      profileId: PROFILE_FLAT_CANDIDATE_ID,
      opaqueCaseId: 'case-0',
    })
    await assert.rejects(
      ledger.recordLogicalAttempt({ profileId: PROFILE_FLAT_CANDIDATE_ID, opaqueCaseId: 'case-0' }),
      /already recorded/u,
    )
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('offline ledger uses its synthetic parent and cannot target the production root', async () => {
  await withLedger(async (ledger) => {
    assert.equal(ledger.snapshot().physicalDispatchCount, 202)
  })
  await assert.rejects(
    ProviderRefusalReplayLedger.register({
      offlineTestOnly: true,
      protocolSha256: 'e'.repeat(64),
      caseIds: Array.from({ length: 40 }, (_, index) => `case-${index}`),
    }),
    /canonical new namespace/u,
  )
  const outer = await mkdtemp(join(tmpdir(), 'provider-refusal-ledger-alias-'))
  const namespace = join(outer, 'provider-refusal-dev40-replay-v1')
  const parent = join(outer, 'alias-parent')
  const aliasedNamespace = join(parent, 'provider-refusal-dev40-replay-v1')
  try {
    await mkdir(join(namespace, 'admission'), { recursive: true })
    await mkdir(parent, { recursive: true })
    await symlink(namespace, aliasedNamespace, 'dir')
    await assert.rejects(
      ProviderRefusalReplayLedger.register({
        root: join(aliasedNamespace, 'admission', 'successor-campaign'),
        offlineTestOnly: true,
        protocolSha256: 'e'.repeat(64),
        caseIds: Array.from({ length: 40 }, (_, index) => `case-${index}`),
      }),
      /alias|canonical/u,
    )
    await assert.rejects(
      readFile(join(namespace, 'admission', 'successor-campaign', 'registration.json')),
      { code: 'ENOENT' },
    )
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('initial ledger without registration recovers, progressed orphan state stays blocked', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'provider-refusal-ledger-recovery-'))
  const namespace = join(outer, 'provider-refusal-dev40-replay-v1')
  const root = join(namespace, 'admission', 'successor-campaign')
  await mkdir(join(namespace, 'admission'), { recursive: true })
  const caseIds = Array.from({ length: 40 }, (_, index) => `case-${index}`)
  try {
    const initial = await ProviderRefusalReplayLedger.register({
      root,
      offlineTestOnly: true,
      protocolSha256: 'f'.repeat(64),
      caseIds,
    })
    assert.equal(initial.snapshot().physicalDispatchCount, 202)
    await unlink(join(root, 'registration.json'))
    const recovered = await ProviderRefusalReplayLedger.register({
      root,
      offlineTestOnly: true,
      protocolSha256: 'f'.repeat(64),
      caseIds,
    })
    assert.equal(recovered.snapshot().physicalDispatchCount, 202)
    await unlink(join(root, 'registration.json'))
    await recovered.recordLogicalAttempt({
      profileId: PROFILE_FLAT_CANDIDATE_ID,
      opaqueCaseId: 'case-0',
    })
    await assert.rejects(
      ProviderRefusalReplayLedger.register({
        root,
        offlineTestOnly: true,
        protocolSha256: 'f'.repeat(64),
        caseIds,
      }),
      /progressed or foreign state/u,
    )
  } finally {
    await rm(outer, { recursive: true, force: false })
  }
})

await test('ambiguous dispatch remains reserved and blocks resume; charge over bound is retained and integrity-latched', async () => {
  await withLedger(async (ledger, root) => {
    const ambiguous = await ledger.admitPhysical(REPLAY_CONTROL_MAX_USD, {
      profileId: PROFILE_CONTROL_ID,
      opaqueCaseId: 'case-0',
    })
    await ledger.recordDispatchIntent(ambiguous)
    await ledger.markCrashWithPendingDispatch()
    assert.equal(ledger.snapshot().inFlightReservations.length, 1)
    assert.equal(ledger.uncertainDispatchCount(), 1)
    assert.throws(() => ledger.assertResumeAllowed(), /unresolved/u)
    const reopened = await ProviderRefusalReplayLedger.register({
      root,
      offlineTestOnly: true,
      protocolSha256: 'a'.repeat(64),
      caseIds: Array.from({ length: 40 }, (_, index) => `case-${index}`),
    })
    assert.equal(reopened.uncertainDispatchCount(), 1)
    assert.equal(reopened.snapshot().inFlightReservations.length, 1)
    assert.throws(() => reopened.assertResumeAllowed(), /unresolved/u)
  })
  await withLedger(async (ledger, root) => {
    const id = await ledger.admitPhysical(REPLAY_CONTROL_MAX_USD, {
      profileId: PROFILE_CONTROL_ID,
      opaqueCaseId: 'case-1',
    })
    await ledger.recordDispatchIntent(id)
    await ledger.markDispatched(id)
    await ledger.settle(id, 200)
    assert.ok(Math.abs(ledger.snapshot().knownCostUsd - 200.118405065) < 1e-9)
    assert.equal(ledger.snapshot().resumeBlocked, true)
    const reopened = await ProviderRefusalReplayLedger.register({
      root,
      offlineTestOnly: true,
      protocolSha256: 'a'.repeat(64),
      caseIds: Array.from({ length: 40 }, (_, index) => `case-${index}`),
    })
    assert.ok(Math.abs(reopened.snapshot().knownCostUsd - 200.118405065) < 1e-9)
    assert.equal(reopened.snapshot().resumeBlocked, true)
  })
})
