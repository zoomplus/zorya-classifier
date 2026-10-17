interface InitialBudget {
  admittedProviderCalls: number
  knownCostUsd: number
  unknownCostCalls: number
  inFlightCalls: number
}
/** Admission is conservative when price is unknown; it is not a provider-side spending cap. */
export class BenchmarkBudget {
  private calls = 0
  private known = 0
  private unknown = 0
  private active = new Set<number>()
  constructor(
    readonly maxCalls: number,
    readonly maxCostUsd: number,
    readonly reservationUsd = 0.02,
    initial?: InitialBudget,
  ) {
    if (
      !Number.isInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 1000 ||
      !Number.isFinite(maxCostUsd) ||
      maxCostUsd <= 0 ||
      maxCostUsd > 1 ||
      !Number.isFinite(reservationUsd) ||
      reservationUsd <= 0
    )
      throw new Error('Invalid benchmark budget')
    if (initial) {
      if (
        !Number.isInteger(initial.admittedProviderCalls) ||
        initial.admittedProviderCalls < 0 ||
        initial.admittedProviderCalls > maxCalls ||
        !Number.isInteger(initial.unknownCostCalls) ||
        initial.unknownCostCalls < 0 ||
        initial.unknownCostCalls > initial.admittedProviderCalls ||
        !Number.isFinite(initial.knownCostUsd) ||
        initial.knownCostUsd < 0 ||
        initial.inFlightCalls !== 0 ||
        initial.knownCostUsd + initial.unknownCostCalls * reservationUsd > maxCostUsd + 1e-12
      )
        throw new Error('Invalid initial benchmark budget')
      this.calls = initial.admittedProviderCalls
      this.known = initial.knownCostUsd
      this.unknown = initial.unknownCostCalls
    }
  }
  reserve(): number {
    if (
      this.calls >= this.maxCalls ||
      this.exposure() + this.reservationUsd > this.maxCostUsd + 1e-12
    )
      throw new BudgetExhausted()
    const id = ++this.calls
    this.active.add(id)
    return id
  }
  settle(id: number, cost: number | null): void {
    if (!this.active.delete(id)) throw new Error('Reservation already settled or unknown')
    if (cost !== null && Number.isFinite(cost) && cost >= 0) this.known += cost
    else this.unknown++
  }
  private exposure(): number {
    return this.known + (this.unknown + this.active.size) * this.reservationUsd
  }
  snapshot() {
    return {
      admittedProviderCalls: this.calls,
      maxCalls: this.maxCalls,
      maxCostUsd: this.maxCostUsd,
      knownCostUsd: this.known,
      unknownCostCalls: this.unknown,
      inFlightCalls: this.active.size,
      reservationPerUnknownUsd: this.reservationUsd,
      accountedExposureUsd: this.exposure(),
      exceededByReportedCost: this.exposure() > this.maxCostUsd + 1e-12,
    }
  }
}
export class BudgetExhausted extends Error {
  readonly code = 'BENCHMARK_BUDGET_EXHAUSTED'
  constructor() {
    super('Remaining benchmark admission budget is insufficient')
    this.name = 'BudgetExhausted'
  }
}
