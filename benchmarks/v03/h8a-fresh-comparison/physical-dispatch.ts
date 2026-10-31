import type { CampaignLedger } from './campaign-ledger.js'

interface PhysicalDispatchResult<T> {
  value: T
  reservationId: number
  physicalId: number
  costUsd: number | null
  observedDispatchConfirmed: boolean
}

type InjectedFetch<T> = () => Promise<{ result: T; costUsd: number | null }>

type InjectedWorkOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

type SettledOnceDisposition = {
  kind: 'settled_once'
  reservationId: number
  costUsd: number | null
}

type FinalizeObservedPhysicalDispatchOutcome<T> =
  | {
      kind: 'confirmed_settled'
      physicalId: number
      value: T
      costUsd: number | null
      disposition: SettledOnceDisposition
    }
  | {
      kind: 'fetch_failed_settled_unknown'
      physicalId: number
      error: unknown
      disposition: SettledOnceDisposition
    }
  | {
      kind: 'confirm_failed_recovery_barrier'
      confirmCause: unknown
      disposition: { kind: 'crash_recovery_barrier' }
    }

export class PhysicalDispatchConfirmFailedError extends Error {
  readonly code = 'H8A_PHYSICAL_DISPATCH_CONFIRM_FAILED'
  readonly confirmCause: unknown
  readonly disposition: { kind: 'crash_recovery_barrier' }

  constructor(
    confirmCause: unknown,
    disposition: { kind: 'crash_recovery_barrier' } = { kind: 'crash_recovery_barrier' },
  ) {
    super('Physical dispatch observation could not be durably confirmed')
    this.name = 'PhysicalDispatchConfirmFailedError'
    this.confirmCause = confirmCause
    this.disposition = disposition
  }
}

export function invokeInjectedWork<T>(
  invoke: () => Promise<T> | T,
): Promise<InjectedWorkOutcome<T>> {
  try {
    return Promise.resolve(invoke()).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    )
  } catch (error) {
    return Promise.resolve({ ok: false as const, error })
  }
}

export async function finalizeObservedPhysicalDispatch<T>(
  ledger: CampaignLedger,
  reservationId: number,
  workOutcomePromise: Promise<InjectedWorkOutcome<T>>,
  readCostUsd: (value: T) => number | null,
): Promise<FinalizeObservedPhysicalDispatchOutcome<T>> {
  let physicalId: number | null = null
  let observedDispatchConfirmed = false
  let confirmError: unknown
  try {
    physicalId = await ledger.markDispatched(reservationId)
    observedDispatchConfirmed = true
  } catch (error) {
    confirmError = error
  }

  const workOutcome = await workOutcomePromise

  if (!observedDispatchConfirmed) {
    await ledger.markCrashWithPendingDispatch()
    return {
      kind: 'confirm_failed_recovery_barrier',
      confirmCause: confirmError,
      disposition: { kind: 'crash_recovery_barrier' },
    }
  }

  if (!workOutcome.ok) {
    await ledger.settle(reservationId, null)
    if (physicalId === null) throw new RangeError('Confirmed physical dispatch missing physical ID')
    return {
      kind: 'fetch_failed_settled_unknown',
      physicalId,
      error: workOutcome.error,
      disposition: { kind: 'settled_once' as const, reservationId, costUsd: null },
    }
  }

  const costUsd = readCostUsd(workOutcome.value)
  await ledger.settle(reservationId, costUsd)
  if (physicalId === null) throw new RangeError('Confirmed physical dispatch missing physical ID')
  return {
    kind: 'confirmed_settled',
    physicalId,
    value: workOutcome.value,
    costUsd,
    disposition: { kind: 'settled_once' as const, reservationId, costUsd },
  }
}

export async function runInjectedPhysicalFetch<T>(
  ledger: CampaignLedger,
  reservedUsd: number,
  fetch: InjectedFetch<T>,
): Promise<PhysicalDispatchResult<T>> {
  const reservationId = await ledger.admitPhysical(reservedUsd)
  await ledger.recordDispatchIntent(reservationId)
  const workOutcomePromise = invokeInjectedWork(fetch)
  const outcome = await finalizeObservedPhysicalDispatch(
    ledger,
    reservationId,
    workOutcomePromise,
    (value) => value.costUsd,
  )
  if (outcome.kind === 'fetch_failed_settled_unknown') {
    throw outcome.error
  }
  if (outcome.kind === 'confirm_failed_recovery_barrier') {
    throw new PhysicalDispatchConfirmFailedError(outcome.confirmCause, outcome.disposition)
  }
  return {
    value: outcome.value.result,
    reservationId,
    physicalId: outcome.physicalId,
    costUsd: outcome.costUsd,
    observedDispatchConfirmed: true,
  }
}

export async function runPreflightOnlyLogicalAttempt(
  ledger: CampaignLedger,
  attempt: () => void,
): Promise<void> {
  await ledger.recordLogicalAttempt()
  attempt()
}

export async function cancelUnstartedPhysicalReservation(
  ledger: CampaignLedger,
  reservationId: number,
): Promise<void> {
  await ledger.cancelBeforeFetch(reservationId)
}
