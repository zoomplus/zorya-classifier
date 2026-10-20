export interface BudgetSnapshot {
  admittedPhysicalCalls: number
  knownCostUsd: number
  unknownCostCalls: number
  inFlightCalls: number
  accountedExposureUsd: number
  maxPhysicalCalls: number
  maxCostUsd: number
}

/** Conservative per-dispatch admission budget. Unknown receipts consume the full reserve. */
export class RunBudget {
  private calls = 0
  private knownCost = 0
  private unknownCosts = 0
  private active = new Set<number>()

  constructor(
    readonly maxPhysicalCalls: number,
    readonly maxCostUsd: number,
    readonly unknownReserveUsd = 0.02,
  ) {
    if (
      !Number.isInteger(maxPhysicalCalls) ||
      maxPhysicalCalls < 1 ||
      maxPhysicalCalls > 250 ||
      !Number.isFinite(maxCostUsd) ||
      maxCostUsd <= 0 ||
      maxCostUsd > 5 ||
      !Number.isFinite(unknownReserveUsd) ||
      unknownReserveUsd <= 0
    )
      throw new RangeError('Invalid v0.2 run budget')
  }

  admit(): number {
    if (
      this.calls >= this.maxPhysicalCalls ||
      this.exposure() + this.unknownReserveUsd > this.maxCostUsd + 1e-12
    )
      throw new RunBudgetExhausted()
    const id = ++this.calls
    this.active.add(id)
    return id
  }

  settle(id: number, costUsd: number | null): void {
    if (!this.active.delete(id)) throw new Error('Unknown or settled physical call')
    if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) this.knownCost += costUsd
    else this.unknownCosts++
  }

  cancelBeforeFetch(id: number): void {
    if (!this.active.delete(id) || id !== this.calls)
      throw new Error('Only the latest unstarted fetch reservation can be cancelled')
    this.calls--
  }

  private exposure(): number {
    return this.knownCost + (this.unknownCosts + this.active.size) * this.unknownReserveUsd
  }

  snapshot(): BudgetSnapshot {
    return {
      admittedPhysicalCalls: this.calls,
      knownCostUsd: this.knownCost,
      unknownCostCalls: this.unknownCosts,
      inFlightCalls: this.active.size,
      accountedExposureUsd: this.exposure(),
      maxPhysicalCalls: this.maxPhysicalCalls,
      maxCostUsd: this.maxCostUsd,
    }
  }
}

export class RunBudgetExhausted extends Error {
  readonly code = 'V02_RUN_BUDGET_EXHAUSTED'
  constructor() {
    super('v0.2 run budget has no remaining admission capacity')
    this.name = 'RunBudgetExhausted'
  }
}
