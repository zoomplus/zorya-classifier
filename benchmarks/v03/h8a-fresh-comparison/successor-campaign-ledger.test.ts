import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { UI_STATE_DEV40_EXECUTION_V2_ID } from './ui-state-dev40-policy.js'
import { PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import {
  CANDIDATE_MAX_USD_PER_DISPATCH,
  CONTROL_MAX_USD_PER_DISPATCH,
  DEV40_SUCCESSOR_MAX_CALLS,
  INDEPENDENT_DEV40_COST_PROOF_SHA256,
  INDEPENDENT_DEV40_PARENT_LEDGER_SHA256,
  INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256,
  SUCCESSOR_DEV40_MAX_INCREMENTAL_USD,
  SuccessorCampaignLedger,
  SuccessorCampaignBudgetExhaustedError,
  SuccessorCampaignLedgerBlockedError,
  SUCCESSOR_REGISTRATION_RELATIVE_PATH,
} from './successor-campaign-ledger.js'
import type { SuccessorCampaignLedgerOptions } from './successor-campaign-ledger.js'

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/independent-dev40-v2-admission/', import.meta.url),
)
const ownedTemporaryRoots: string[] = []

interface LedgerFixture {
  options: SuccessorCampaignLedgerOptions
  studyRoot: string
  parentLedgerPath: string
  successorRoot: string
}

async function makeFixture(): Promise<LedgerFixture> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'h8a-successor-ledger-'))
  ownedTemporaryRoots.push(tempRoot)
  const studyRoot = join(tempRoot, 'ui-state-dev40-v1')
  const parentRoot = join(tempRoot, 'h8a-fresh-dev-qual-campaign-v1')
  const parentLedgerPath = join(parentRoot, 'campaign-ledger.json')
  await Promise.all([
    mkdir(join(studyRoot, 'main'), { recursive: true, mode: 0o700 }),
    mkdir(parentRoot, { recursive: true, mode: 0o700 }),
  ])
  await Promise.all([
    copyFile(
      join(fixtureRoot, 'parent-registration.json.fixture'),
      join(studyRoot, 'parent-registration.json'),
    ),
    copyFile(
      join(fixtureRoot, 'public-cost-bounds.json.fixture'),
      join(studyRoot, 'main', 'public-cost-bounds.json'),
    ),
    copyFile(join(fixtureRoot, 'parent-ledger.json.fixture'), parentLedgerPath),
  ])
  return {
    options: { studyRoot, parentRoot, parentLedgerPath, offlineTestOnly: true },
    studyRoot,
    parentLedgerPath,
    successorRoot: resolve(studyRoot, SUCCESSOR_REGISTRATION_RELATIVE_PATH),
  }
}

async function confirmedCall(
  ledger: SuccessorCampaignLedger,
  profileId: typeof PROFILE_CONTROL_ID | typeof PROFILE_FLAT_CANDIDATE_ID,
  opaqueCaseId: string,
  costUsd: number | null,
): Promise<void> {
  const reservedUsd =
    profileId === PROFILE_FLAT_CANDIDATE_ID
      ? CANDIDATE_MAX_USD_PER_DISPATCH
      : CONTROL_MAX_USD_PER_DISPATCH
  const context = { profileId, opaqueCaseId }
  const reservationId = await ledger.admitPhysical(reservedUsd, context)
  await ledger.recordDispatchIntent(reservationId)
  await ledger.markDispatched(reservationId)
  await ledger.settle(reservationId, costUsd)
}

await test('independent DEV40 successor ledger', async (context) => {
  context.after(async () => {
    for (const root of ownedTemporaryRoots) await rm(root, { recursive: true, force: true })
  })

  await context.test('offline mode refuses live execution identities', async () => {
    const fixture = await makeFixture()
    await assert.rejects(
      SuccessorCampaignLedger.register({
        ...fixture.options,
        executionId: UI_STATE_DEV40_EXECUTION_V2_ID,
      }),
      /Offline test mode requires disposable temporary roots/u,
    )
  })

  await context.test(
    'register and open own options before asynchronous filesystem checks',
    async () => {
      const fixture = await makeFixture()
      const registerOptions = { ...fixture.options }
      const pendingRegistration = SuccessorCampaignLedger.register(registerOptions)
      registerOptions.executionId = UI_STATE_DEV40_EXECUTION_V2_ID
      const registered = await pendingRegistration
      assert.equal(registered.snapshot().physicalDispatchCount, 100)

      const openOptions = { ...fixture.options }
      const pendingOpen = SuccessorCampaignLedger.open(openOptions)
      openOptions.parentRoot = join(dirname(fixture.studyRoot), 'missing-parent-root')
      assert.equal((await pendingOpen).snapshot().physicalDispatchCount, 100)
    },
  )

  await context.test(
    'registers one deterministic child, carries parent counters, and never writes the parent ledger',
    async () => {
      const fixture = await makeFixture()
      const parentBefore = await readFile(fixture.parentLedgerPath)
      const [first, second] = await Promise.all([
        SuccessorCampaignLedger.register(fixture.options),
        SuccessorCampaignLedger.register(fixture.options),
      ])
      const registrationBytes = await readFile(join(fixture.successorRoot, 'registration.json'))
      const stateBytes = await readFile(join(fixture.successorRoot, 'campaign-ledger.json'))

      assert.equal(first.snapshot().physicalDispatchCount, 100)
      assert.equal(first.snapshot().logicalAttemptCount, 32)
      assert.equal(first.snapshot().knownCostUsd, 0.059908515)
      assert.equal(first.snapshot().unknownReserveUsd, 0.12)
      assert.equal(
        (await readFile(join(fixture.successorRoot, 'registration.json'))).toString(),
        registrationBytes.toString(),
      )
      assert.equal(
        (await readFile(join(fixture.successorRoot, 'campaign-ledger.json'))).toString(),
        stateBytes.toString(),
      )
      assert.deepEqual(await readFile(fixture.parentLedgerPath), parentBefore)

      const registration: unknown = JSON.parse(registrationBytes.toString('utf8'))
      assert.ok(registration && typeof registration === 'object')
      const { registrationSha256, ...registrationBody } = registration as Record<string, unknown>
      assert.equal(
        registrationSha256,
        createHash('sha256').update(JSON.stringify(registrationBody)).digest('hex'),
      )
      assert.equal(
        registrationBody.parentRegistrationSha256,
        INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256,
      )
      assert.equal(registrationBody.parentLedgerSha256, INDEPENDENT_DEV40_PARENT_LEDGER_SHA256)
      assert.equal(registrationBody.publicCostProofSha256, INDEPENDENT_DEV40_COST_PROOF_SHA256)
      assert.equal(registrationBody.canonicalStudyRoot, fixture.studyRoot)
      assert.equal(registrationBody.ownerDollarCeilingUsd, null)
      assert.equal(registrationBody.globalPhysicalCallLimit, 2_000)
      assert.equal(registrationBody.dev40PhysicalCallLimit, DEV40_SUCCESSOR_MAX_CALLS)
      assert.equal(
        registrationBody.dev40IncrementalExposureUsd,
        SUCCESSOR_DEV40_MAX_INCREMENTAL_USD,
      )
      assert.deepEqual(registrationBody.inherited, {
        ledgerVersion: 497,
        nextReservationId: 101,
        physicalDispatchCount: 100,
        logicalAttemptCount: 32,
        knownCostUsd: 0.059908515,
        unknownReserveUsd: 0.12,
      })
      assert.equal(second.snapshot().physicalDispatchCount, 100)
    },
  )

  await context.test(
    'uses exact per-profile reserves and accumulates known/unknown costs without refunds',
    async () => {
      const fixture = await makeFixture()
      const ledger = await SuccessorCampaignLedger.register(fixture.options)
      const context = { profileId: PROFILE_FLAT_CANDIDATE_ID, opaqueCaseId: 'case-a' }

      await assert.rejects(
        ledger.admitPhysical(CONTROL_MAX_USD_PER_DISPATCH, context),
        SuccessorCampaignLedgerBlockedError,
      )
      await ledger.recordLogicalAttempt(context)
      await confirmedCall(ledger, PROFILE_FLAT_CANDIDATE_ID, 'case-a', 0.03)
      await confirmedCall(ledger, PROFILE_CONTROL_ID, 'case-a', null)

      assert.equal(ledger.snapshot().physicalDispatchCount, 102)
      assert.equal(ledger.snapshot().logicalAttemptCount, 33)
      assert.equal(ledger.snapshot().knownCostUsd, 0.089908515)
      assert.equal(ledger.snapshot().unknownReserveUsd, 0.24)
      await assert.rejects(
        ledger.recordLogicalAttempt(context),
        SuccessorCampaignLedgerBlockedError,
      )
      assert.equal(ledger.snapshot().physicalDispatchCount, 102)
    },
  )

  await context.test(
    'rolls back a prefetch cancellation and keeps reservation identifiers monotone',
    async () => {
      const fixture = await makeFixture()
      const ledger = await SuccessorCampaignLedger.register(fixture.options)
      const context = { profileId: PROFILE_FLAT_CANDIDATE_ID, opaqueCaseId: 'case-prefetch' }
      const first = await ledger.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, context)
      await ledger.recordDispatchIntent(first)
      await ledger.cancelBeforeFetch(first)
      const next = await ledger.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, context)

      assert.equal(first, 101)
      assert.equal(next, 102)
      assert.equal(ledger.snapshot().physicalDispatchCount, 100)
      assert.equal(ledger.snapshot().knownCostUsd, 0.059908515)
      assert.equal(ledger.snapshot().unknownReserveUsd, 0.12)
      await ledger.cancelBeforeFetch(next)
    },
  )

  await context.test(
    'a failed stale-instance transaction restores the latest successor state',
    async () => {
      const fixture = await makeFixture()
      const first = await SuccessorCampaignLedger.register(fixture.options)
      const stale = await SuccessorCampaignLedger.open(fixture.options)
      const logicalAttempt = {
        profileId: PROFILE_FLAT_CANDIDATE_ID,
        opaqueCaseId: 'case-stale-instance',
      }
      await first.recordLogicalAttempt(logicalAttempt)
      await assert.rejects(
        stale.recordLogicalAttempt(logicalAttempt),
        SuccessorCampaignLedgerBlockedError,
      )
      assert.equal(stale.snapshot().logicalAttemptCount, 33)
      assert.equal(
        (await SuccessorCampaignLedger.open(fixture.options)).snapshot().logicalAttemptCount,
        33,
      )
    },
  )

  await context.test(
    'persists pending dispatch barriers and turns a lost outcome into a conservative unknown charge',
    async () => {
      const fixture = await makeFixture()
      const ledger = await SuccessorCampaignLedger.register(fixture.options)
      const context = { profileId: PROFILE_FLAT_CANDIDATE_ID, opaqueCaseId: 'case-pending' }
      const reservation = await ledger.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, context)
      await ledger.recordDispatchIntent(reservation)
      const reopened = await SuccessorCampaignLedger.open(fixture.options)
      assert.throws(() => reopened.assertResumeAllowed(), SuccessorCampaignLedgerBlockedError)

      await reopened.markCrashWithPendingDispatch()
      const blocked = await SuccessorCampaignLedger.open(fixture.options)
      assert.throws(() => blocked.assertResumeAllowed(), SuccessorCampaignLedgerBlockedError)
      assert.equal(blocked.snapshot().physicalDispatchCount, 100)
      assert.equal(blocked.snapshot().unknownReserveUsd, 0.67)
      assert.equal(blocked.snapshot().resumeBlocked, true)
    },
  )

  await context.test(
    'keeps a fetch-confirmed but unsettled call as known physical with unknown charge',
    async () => {
      const fixture = await makeFixture()
      const ledger = await SuccessorCampaignLedger.register(fixture.options)
      const reservation = await ledger.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, {
        profileId: PROFILE_FLAT_CANDIDATE_ID,
        opaqueCaseId: 'case-fetched-unsettled',
      })
      await ledger.recordDispatchIntent(reservation)
      await ledger.markDispatched(reservation)
      await ledger.markCrashWithPendingDispatch()
      const reopened = await SuccessorCampaignLedger.open(fixture.options)

      assert.equal(reopened.snapshot().physicalDispatchCount, 101)
      assert.equal(reopened.snapshot().unknownReserveUsd, 0.67)
      assert.equal(reopened.snapshot().resumeBlocked, true)
      await assert.rejects(
        reopened.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          opaqueCaseId: 'case-new',
        }),
        SuccessorCampaignLedgerBlockedError,
      )
    },
  )

  await context.test(
    'enforces the four/six physical cap per case arm and rejects over-bound provider cost',
    async () => {
      const fixture = await makeFixture()
      const ledger = await SuccessorCampaignLedger.register(fixture.options)
      for (let index = 0; index < 4; index++)
        await confirmedCall(ledger, PROFILE_FLAT_CANDIDATE_ID, 'case-capped', 0)
      await assert.rejects(
        ledger.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          opaqueCaseId: 'case-capped',
        }),
        SuccessorCampaignBudgetExhaustedError,
      )

      await confirmedCall(ledger, PROFILE_CONTROL_ID, 'case-cost-integrity', 0.13)
      assert.equal(ledger.snapshot().unknownReserveUsd, 0.24)
      const reopened = await SuccessorCampaignLedger.open(fixture.options)
      assert.throws(() => reopened.assertResumeAllowed(), SuccessorCampaignLedgerBlockedError)
    },
  )

  await context.test(
    'study-scope preflight does not bind admission to an already exhausted first case',
    async () => {
      const fixture = await makeFixture()
      const ledger = await SuccessorCampaignLedger.register(fixture.options)
      for (let index = 0; index < 4; index++)
        await confirmedCall(ledger, PROFILE_FLAT_CANDIDATE_ID, 'case-preflight-closed', 0)

      await ledger.assertStudyScopeCanAdmitPhysicalReservedUsd(
        PROFILE_FLAT_CANDIDATE_ID,
        CANDIDATE_MAX_USD_PER_DISPATCH,
      )
      await assert.rejects(
        ledger.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, {
          profileId: PROFILE_FLAT_CANDIDATE_ID,
          opaqueCaseId: 'case-preflight-closed',
        }),
        SuccessorCampaignBudgetExhaustedError,
      )
      const otherCaseReservation = await ledger.admitPhysical(CANDIDATE_MAX_USD_PER_DISPATCH, {
        profileId: PROFILE_FLAT_CANDIDATE_ID,
        opaqueCaseId: 'case-preflight-next',
      })
      await ledger.cancelBeforeFetch(otherCaseReservation)
    },
  )

  await context.test(
    'fails closed when parent pins or copied state are changed and never creates an alternate root',
    async () => {
      const fixture = await makeFixture()
      const ledger = await SuccessorCampaignLedger.register(fixture.options)
      const originalParent = await readFile(fixture.parentLedgerPath)
      const originalSuccessor = await readFile(join(fixture.successorRoot, 'campaign-ledger.json'))
      await writeFile(fixture.parentLedgerPath, `${originalParent.toString().trim()}\n `)
      await assert.rejects(
        SuccessorCampaignLedger.open(fixture.options),
        SuccessorCampaignLedgerBlockedError,
      )
      assert.deepEqual(
        await readFile(join(fixture.successorRoot, 'campaign-ledger.json')),
        originalSuccessor,
      )
      assert.notEqual(await readFile(fixture.parentLedgerPath, 'utf8'), originalParent.toString())
      assert.equal(ledger.snapshot().physicalDispatchCount, 100)
    },
  )
})
