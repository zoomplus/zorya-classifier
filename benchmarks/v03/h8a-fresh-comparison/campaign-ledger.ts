import type { z } from 'zod'
import { CAMPAIGN_MAX_COST_USD, CAMPAIGN_MAX_PHYSICAL_CALLS } from './constants.js'
import { campaignLedgerSnapshotSchema } from './schemas.js'
import { AtomicJsonLedgerStore, JsonLedgerStorageError } from './atomic-json-ledger.js'
import type {
  CampaignLedgerPort,
  LedgerLogicalAttemptContext,
  LedgerPhysicalCallContext,
} from './campaign-ledger-port.js'

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

function parseLedger(raw: unknown): MutableLedgerState {
  const parsed = campaignLedgerSnapshotSchema.parse(raw)
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

export class CampaignLedger implements CampaignLedgerPort {
  private state: MutableLedgerState
  private simulatedPersistFailureAfterSkip = -1

  private constructor(
    state: MutableLedgerState,
    private readonly storage: AtomicJsonLedgerStore,
  ) {
    this.state = state
    syncResumeBarrier(this.state)
  }

  static async open(path: string): Promise<CampaignLedger> {
    const storage = new AtomicJsonLedgerStore(path)
    let loaded: MutableLedgerState
    try {
      await storage.assertNoLockFile()
      loaded = await storage.openOrCreate(parseLedger, initialLedgerState())
    } catch (error) {
      if (error instanceof JsonLedgerStorageError)
        throw new CampaignLedgerBlockedError(error.message)
      throw error
    }
    syncResumeBarrier(loaded)
    return new CampaignLedger(loaded, storage)
  }

  scheduleSimulatedPersistFailureAfterSuccessfulTransactions(skipSuccessfulTransactions = 0): void {
    if (!Number.isInteger(skipSuccessfulTransactions) || skipSuccessfulTransactions < 0) {
      throw new RangeError('Simulated persist failure skip must be a non-negative integer')
    }
    this.simulatedPersistFailureAfterSkip = skipSuccessfulTransactions
  }

  private async withExclusiveTransaction<T>(operation: () => Promise<T>): Promise<T> {
    let rollbackState: MutableLedgerState | undefined
    try {
      return await this.storage.transact(parseLedger, async (latest) => {
        this.state = latest
        syncResumeBarrier(this.state)
        rollbackState = cloneLedgerState(this.state)
        try {
          const result = await operation()
          if (this.simulatedPersistFailureAfterSkip >= 0) {
            if (this.simulatedPersistFailureAfterSkip === 0) {
              this.simulatedPersistFailureAfterSkip = -1
              throw new CampaignLedgerPersistFailureError(
                'Simulated campaign ledger persist failure',
              )
            }
            this.simulatedPersistFailureAfterSkip--
          }
          syncResumeBarrier(this.state)
          this.state.ledgerVersion++
          return { next: this.state, result }
        } catch (error) {
          this.state = rollbackState
          throw error
        }
      })
    } catch (error) {
      if (rollbackState) this.state = rollbackState
      if (error instanceof JsonLedgerStorageError)
        throw new CampaignLedgerBlockedError(error.message)
      throw error
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

  async recordLogicalAttempt(_context?: LedgerLogicalAttemptContext): Promise<void> {
    return this.withExclusiveTransaction(async () => {
      this.state.logicalAttemptCount++
    })
  }

  async admitPhysical(reservedUsd: number, _context?: LedgerPhysicalCallContext): Promise<number> {
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

  async assertCanAdmitPhysicalReservedUsd(
    reservedUsd: number,
    _context?: LedgerPhysicalCallContext,
  ): Promise<void> {
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
