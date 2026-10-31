import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { CAMPAIGN_MAX_COST_USD, CAMPAIGN_MAX_PHYSICAL_CALLS } from './constants.js'
import { campaignLedgerSnapshotSchema } from './schemas.js'

export class CampaignLedgerBlockedError extends Error {
  readonly code = 'H8A_CAMPAIGN_LEDGER_BLOCKED'
  constructor(message: string) {
    super(message)
    this.name = 'CampaignLedgerBlockedError'
  }
}

export class CampaignBudgetExhaustedError extends Error {
  readonly code = 'H8A_CAMPAIGN_BUDGET_EXHAUSTED'
  constructor(message: string) {
    super(message)
    this.name = 'CampaignBudgetExhaustedError'
  }
}

class CampaignLedgerLockError extends Error {
  readonly code = 'H8A_CAMPAIGN_LEDGER_LOCK'
  constructor(message: string) {
    super(message)
    this.name = 'CampaignLedgerLockError'
  }
}

export class CampaignLedgerPersistFailureError extends Error {
  readonly code = 'H8A_CAMPAIGN_LEDGER_PERSIST_FAILURE'
  constructor(message: string) {
    super(message)
    this.name = 'CampaignLedgerPersistFailureError'
  }
}

interface InFlightReservation {
  reservationId: number
  reservedUsd: number
  dispatchIntentRecorded: boolean
  dispatched: boolean
  physicalId: number | null
}

interface MutableLedgerState {
  schema: 'h8a-fresh-campaign-ledger-v1'
  ledgerVersion: number
  maxPhysicalCalls: typeof CAMPAIGN_MAX_PHYSICAL_CALLS
  maxCostUsd: typeof CAMPAIGN_MAX_COST_USD
  nextReservationId: number
  physicalDispatchCount: number
  logicalAttemptCount: number
  knownCostUsd: number
  unknownReserveUsd: number
  inFlightReservations: InFlightReservation[]
  resumeBlocked: boolean
  crashRecoveryLatched: boolean
}

const ledgerLockPayloadSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    ownerToken: z.string().min(1),
    acquiredAt: z.number().finite(),
  })
  .strict()

function initialLedgerState(): MutableLedgerState {
  return {
    schema: 'h8a-fresh-campaign-ledger-v1',
    ledgerVersion: 0,
    maxPhysicalCalls: CAMPAIGN_MAX_PHYSICAL_CALLS,
    maxCostUsd: CAMPAIGN_MAX_COST_USD,
    nextReservationId: 1,
    physicalDispatchCount: 0,
    logicalAttemptCount: 0,
    knownCostUsd: 0,
    unknownReserveUsd: 0,
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
  }
}

function exposure(state: MutableLedgerState): number {
  const inFlightReserve = state.inFlightReservations.reduce(
    (sum, item) => sum + item.reservedUsd,
    0,
  )
  return state.knownCostUsd + state.unknownReserveUsd + inFlightReserve
}

function pendingPhysicalSlots(state: MutableLedgerState): number {
  const undispatched = state.inFlightReservations.filter((item) => !item.dispatched).length
  return state.physicalDispatchCount + undispatched
}

function syncResumeBarrier(state: MutableLedgerState): void {
  if (state.inFlightReservations.some((item) => item.dispatchIntentRecorded || item.dispatched)) {
    state.resumeBlocked = true
    return
  }
  if (!state.crashRecoveryLatched) state.resumeBlocked = false
}

function cloneLedgerState(state: MutableLedgerState): MutableLedgerState {
  return {
    ...state,
    inFlightReservations: state.inFlightReservations.map((item) => ({ ...item })),
  }
}

function normalizeInFlightReservation(
  item: z.infer<typeof campaignLedgerSnapshotSchema>['inFlightReservations'][number],
): InFlightReservation {
  const dispatchIntentRecorded = item.dispatchIntentRecorded ?? item.dispatched
  return {
    reservationId: item.reservationId,
    reservedUsd: item.reservedUsd,
    dispatchIntentRecorded,
    dispatched: item.dispatched,
    physicalId: item.physicalId ?? null,
  }
}

function parseLedger(raw: string): MutableLedgerState {
  const parsed = campaignLedgerSnapshotSchema.parse(JSON.parse(raw) as unknown)
  const state: MutableLedgerState = {
    ...parsed,
    nextReservationId: parsed.nextReservationId ?? 1,
    inFlightReservations: parsed.inFlightReservations.map(normalizeInFlightReservation),
    crashRecoveryLatched:
      parsed.crashRecoveryLatched ??
      (parsed.resumeBlocked === true && parsed.inFlightReservations.length === 0),
  }
  syncResumeBarrier(state)
  return state
}

function lockPathFor(ledgerPath: string): string {
  return `${ledgerPath}.lock`
}

async function assertNoForeignLock(ledgerPath: string): Promise<void> {
  try {
    await readFile(lockPathFor(ledgerPath), 'utf8')
    throw new CampaignLedgerBlockedError(
      'Campaign ledger lock file present; ownership is ambiguous',
    )
  } catch (error) {
    if (error instanceof CampaignLedgerBlockedError) throw error
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') throw error
  }
}

async function acquireExclusiveLedgerLock(
  ledgerPath: string,
): Promise<{ release: () => Promise<void> }> {
  const lockPath = lockPathFor(ledgerPath)
  await mkdir(dirname(ledgerPath), { recursive: true })
  let handle: FileHandle | undefined
  const maxAttempts = 200
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'EEXIST') {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5 + attempt)
        })
        continue
      }
      throw error
    }
  }
  if (!handle) throw new CampaignLedgerBlockedError('Campaign ledger lock acquisition timed out')
  const ownerToken = randomBytes(16).toString('hex')
  await writeFile(
    handle,
    JSON.stringify({ pid: process.pid, ownerToken, acquiredAt: Date.now() }),
    { encoding: 'utf8' },
  )
  return {
    release: async () => {
      try {
        const raw = await readFile(lockPath, 'utf8')
        const parsed = ledgerLockPayloadSchema.safeParse(JSON.parse(raw) as unknown)
        if (!parsed.success) {
          throw new CampaignLedgerLockError('Campaign ledger lock payload failed validation')
        }
        if (parsed.data.ownerToken === ownerToken) {
          await unlink(lockPath)
        } else {
          throw new CampaignLedgerLockError('Campaign ledger lock owned by another holder')
        }
      } catch (error) {
        if (error instanceof CampaignLedgerLockError) throw error
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code === 'ENOENT') return
        throw new CampaignLedgerLockError(
          error instanceof Error ? error.message : 'Campaign ledger lock release failed',
        )
      } finally {
        if (handle) await handle.close()
      }
    },
  }
}

async function loadLedgerState(ledgerPath: string): Promise<MutableLedgerState | null> {
  try {
    const raw = await readFile(ledgerPath, 'utf8')
    return parseLedger(raw)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return null
    throw error
  }
}

async function persistLedger(path: string, state: MutableLedgerState): Promise<void> {
  syncResumeBarrier(state)
  state.ledgerVersion++
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const tempPath = join(directory, `.ledger-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  const payload = `${JSON.stringify(state)}\n`
  await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, path)
}

export class CampaignLedger {
  private state: MutableLedgerState
  private mutex: Promise<void> = Promise.resolve()
  private simulatedPersistFailureAfterSkip = -1

  private constructor(
    private readonly path: string,
    state: MutableLedgerState,
  ) {
    this.state = state
    syncResumeBarrier(this.state)
  }

  static async open(path: string): Promise<CampaignLedger> {
    await assertNoForeignLock(path)
    const loaded = await loadLedgerState(path)
    if (loaded) {
      syncResumeBarrier(loaded)
      return new CampaignLedger(path, loaded)
    }
    const ledger = new CampaignLedger(path, initialLedgerState())
    const lock = await acquireExclusiveLedgerLock(path)
    try {
      const raced = await loadLedgerState(path)
      if (raced) {
        syncResumeBarrier(raced)
        ledger.state = raced
        return ledger
      }
      await persistLedger(path, ledger.state)
      return ledger
    } finally {
      await lock.release()
    }
  }

  scheduleSimulatedPersistFailureAfterSuccessfulTransactions(skipSuccessfulTransactions = 0): void {
    if (!Number.isInteger(skipSuccessfulTransactions) || skipSuccessfulTransactions < 0) {
      throw new RangeError('Simulated persist failure skip must be a non-negative integer')
    }
    this.simulatedPersistFailureAfterSkip = skipSuccessfulTransactions
  }

  private async withExclusiveTransaction<T>(operation: () => Promise<T>): Promise<T> {
    let releaseMutex!: () => void
    const previous = this.mutex
    this.mutex = new Promise<void>((resolve) => {
      releaseMutex = resolve
    })
    await previous
    let lock: { release: () => Promise<void> } | undefined
    let stateBeforeTransaction: MutableLedgerState | undefined
    try {
      lock = await acquireExclusiveLedgerLock(this.path)
      const latest = await loadLedgerState(this.path)
      if (!latest) throw new RangeError('Campaign ledger disappeared during transaction')
      this.state = latest
      syncResumeBarrier(this.state)
      stateBeforeTransaction = cloneLedgerState(this.state)
      const result = await operation()
      if (this.simulatedPersistFailureAfterSkip >= 0) {
        if (this.simulatedPersistFailureAfterSkip === 0) {
          this.simulatedPersistFailureAfterSkip = -1
          this.state = stateBeforeTransaction
          throw new CampaignLedgerPersistFailureError('Simulated campaign ledger persist failure')
        }
        this.simulatedPersistFailureAfterSkip--
      }
      try {
        await persistLedger(this.path, this.state)
      } catch (persistError) {
        this.state = stateBeforeTransaction
        throw persistError
      }
      return result
    } catch (error) {
      if (stateBeforeTransaction && error instanceof CampaignLedgerPersistFailureError) {
        this.state = stateBeforeTransaction
      }
      throw error
    } finally {
      if (lock) {
        await lock.release()
      }
      releaseMutex()
    }
  }

  snapshot() {
    return campaignLedgerSnapshotSchema.parse({
      ...this.state,
      inFlightReservations: this.state.inFlightReservations.map((item) => ({ ...item })),
    })
  }

  assertResumeAllowed(): void {
    syncResumeBarrier(this.state)
    if (this.state.resumeBlocked)
      throw new CampaignLedgerBlockedError(
        'Campaign ledger resume is blocked after pending dispatch',
      )
  }

  async recordLogicalAttempt(): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      this.state.logicalAttemptCount++
    })
  }

  async admitPhysical(reservedUsd: number): Promise<number> {
    return this.withExclusiveTransaction(async () => {
      this.assertResumeAllowed()
      if (!Number.isFinite(reservedUsd) || reservedUsd <= 0)
        throw new RangeError('Reserved USD must be a positive finite number')
      if (pendingPhysicalSlots(this.state) >= this.state.maxPhysicalCalls)
        throw new CampaignBudgetExhaustedError('Physical dispatch ceiling reached')
      if (exposure(this.state) + reservedUsd > this.state.maxCostUsd + 1e-12)
        throw new CampaignBudgetExhaustedError('Campaign cost exposure ceiling reached')
      const reservationId = this.state.nextReservationId
      this.state.nextReservationId++
      this.state.inFlightReservations.push({
        reservationId,
        reservedUsd,
        dispatchIntentRecorded: false,
        dispatched: false,
        physicalId: null,
      })
      return reservationId
    })
  }

  async recordDispatchIntent(reservationId: number): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      const reservation = this.state.inFlightReservations.find(
        (item) => item.reservationId === reservationId,
      )
      if (!reservation) throw new RangeError('Unknown physical reservation')
      if (reservation.dispatchIntentRecorded) return
      reservation.dispatchIntentRecorded = true
      syncResumeBarrier(this.state)
    })
  }

  async markDispatched(reservationId: number): Promise<number> {
    return this.withExclusiveTransaction(async () => {
      const reservation = this.state.inFlightReservations.find(
        (item) => item.reservationId === reservationId,
      )
      if (!reservation) throw new RangeError('Unknown physical reservation')
      if (!reservation.dispatchIntentRecorded)
        throw new RangeError('Physical dispatch requires a recorded dispatch intent')
      if (reservation.dispatched) {
        if (reservation.physicalId === null)
          throw new RangeError('Dispatched reservation missing physical ID')
        return reservation.physicalId
      }
      if (this.state.physicalDispatchCount >= this.state.maxPhysicalCalls)
        throw new CampaignBudgetExhaustedError('Physical dispatch ceiling reached')
      this.state.physicalDispatchCount++
      reservation.dispatched = true
      reservation.physicalId = this.state.physicalDispatchCount
      syncResumeBarrier(this.state)
      return reservation.physicalId
    })
  }

  async cancelBeforeFetch(reservationId: number): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      const index = this.state.inFlightReservations.findIndex(
        (item) => item.reservationId === reservationId,
      )
      if (index < 0) throw new RangeError('Unknown physical reservation')
      const reservation = this.state.inFlightReservations[index]!
      if (reservation.dispatched)
        throw new RangeError('Dispatched physical reservation cannot be cancelled')
      // The fetch boundary may cancel after persisting intent but before its
      // synchronous fetch invocation. No physical request exists in that case.
      this.state.inFlightReservations.splice(index, 1)
      syncResumeBarrier(this.state)
    })
  }

  async settle(reservationId: number, costUsd: number | null): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      const index = this.state.inFlightReservations.findIndex(
        (item) => item.reservationId === reservationId,
      )
      if (index < 0) throw new RangeError('Unknown physical reservation')
      const reservation = this.state.inFlightReservations.splice(index, 1)[0]!
      if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) {
        this.state.knownCostUsd += costUsd
      } else {
        this.state.unknownReserveUsd += reservation.reservedUsd
      }
      syncResumeBarrier(this.state)
    })
  }

  async markCrashWithPendingDispatch(): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      if (
        this.state.inFlightReservations.some(
          (item) => item.dispatchIntentRecorded || item.dispatched,
        )
      ) {
        this.state.resumeBlocked = true
        this.state.crashRecoveryLatched = true
        for (const reservation of this.state.inFlightReservations) {
          if (reservation.dispatchIntentRecorded || reservation.dispatched) {
            this.state.unknownReserveUsd += reservation.reservedUsd
          }
        }
        this.state.inFlightReservations = []
      }
    })
  }

  canAdmitCampaignWorstCase(
    additionalPhysicalCalls: number,
    additionalReservedUsd: number,
  ): boolean {
    syncResumeBarrier(this.state)
    if (this.state.resumeBlocked) return false
    if (pendingPhysicalSlots(this.state) + additionalPhysicalCalls > this.state.maxPhysicalCalls)
      return false
    return exposure(this.state) + additionalReservedUsd <= this.state.maxCostUsd + 1e-12
  }

  async assertCanAdmitPhysicalReservedUsd(reservedUsd: number): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      this.assertResumeAllowed()
      if (!Number.isFinite(reservedUsd) || reservedUsd <= 0)
        throw new RangeError('Reserved USD must be a positive finite number')
      if (pendingPhysicalSlots(this.state) >= this.state.maxPhysicalCalls)
        throw new CampaignBudgetExhaustedError('Physical dispatch ceiling reached')
      if (exposure(this.state) + reservedUsd > this.state.maxCostUsd + 1e-12)
        throw new CampaignBudgetExhaustedError('Campaign cost exposure ceiling reached')
    })
  }

  async assertExposureAllowsAdditionalUsd(additionalUsd: number): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      if (!Number.isFinite(additionalUsd) || additionalUsd < 0)
        throw new RangeError('Additional USD exposure must be a finite non-negative number')
      if (exposure(this.state) + additionalUsd > this.state.maxCostUsd + 1e-12)
        throw new CampaignBudgetExhaustedError('Campaign cost exposure ceiling reached')
    })
  }
}
