import { channel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'
import { setInterval, clearInterval } from 'node:timers'

interface ChildMemorySample {
  type?: 'start' | 'close' | 'memory'
  jobId?: string
  pid?: number
  rss?: number
  heapTotal?: number
  heapUsed?: number
  external?: number
  arrayBuffers?: number
}

type SamplingPhase = 'idle-before' | 'busy' | 'idle-after'
export type MonotonicClock = () => number

interface ParentMemorySample extends NodeJS.MemoryUsage {
  timestampMs: number
  phase: SamplingPhase
}

interface PhaseTransition {
  phase: SamplingPhase
  timestampMs: number
  timestampIso: string
}

export interface ResourceReport {
  sampleIntervalMs: number
  startedAtIso: string
  endedAtIso: string
  observedDurationMs: number
  phaseTransitions: PhaseTransition[]
  parentSamples: ParentMemorySample[]
  childSamples: (ChildMemorySample & { timestampMs: number })[]
  childStarts: number
  childCloses: number
  childrenStillOwned: number[]
  parentPeak: Record<keyof NodeJS.MemoryUsage, number>
  idleWindowMedian: Record<
    'before' | 'after',
    Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'external' | 'arrayBuffers'>
  >
  childPeak: Record<'rss' | 'heapTotal' | 'heapUsed' | 'external' | 'arrayBuffers', number>
}

/** Run a phase against a monotonic clock; wall-clock changes cannot shorten its deadline. */
export async function runMonotonicPhase(
  durationMs: number,
  onIteration: () => Promise<void>,
  options: { now?: MonotonicClock; shouldStop?: () => boolean } = {},
): Promise<number> {
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new RangeError('Monotonic phase duration must be a finite nonnegative number')
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  while (!hasMonotonicDeadlineElapsed(startedAt, durationMs, now()) && !options.shouldStop?.())
    await onIteration()
  return Math.max(0, now() - startedAt)
}

export function hasMonotonicDeadlineElapsed(
  startedAtMs: number,
  durationMs: number,
  nowMs: number,
): boolean {
  return nowMs - startedAtMs >= durationMs
}

/** Starts only when called; importing this helper does not create timers or subscriptions. */
export class ResourceRunner {
  readonly #intervalMs: number
  readonly #parentSamples: ParentMemorySample[] = []
  readonly #childSamples: (ChildMemorySample & { timestampMs: number })[] = []
  readonly #children = new Map<number, string>()
  readonly #phaseTransitions: PhaseTransition[] = []
  readonly #now: MonotonicClock
  #timer: NodeJS.Timeout | undefined
  #startedAt = 0
  #startedAtIso = ''
  #phase: SamplingPhase = 'idle-before'

  constructor(intervalMs: number, now: MonotonicClock = () => performance.now()) {
    if (!Number.isInteger(intervalMs) || intervalMs < 250)
      throw new RangeError('Resource sampling interval must be at least 250 ms')
    this.#intervalMs = intervalMs
    this.#now = now
  }

  start(): void {
    if (this.#timer) throw new Error('Resource runner is already active')
    const childChannel = channel('zorya.segmentation.child-resource')
    childChannel.subscribe(this.#onChild)
    this.#startedAt = this.#now()
    this.#startedAtIso = new Date().toISOString()
    this.#recordPhase('idle-before')
    this.#sampleParent()
    this.#timer = setInterval(() => this.#sampleParent(), this.#intervalMs)
    this.#timer.unref()
  }

  setPhase(phase: SamplingPhase): void {
    this.#phase = phase
    this.#recordPhase(phase)
    this.#sampleParent()
  }

  stop(): ResourceReport {
    if (!this.#timer) throw new Error('Resource runner is not active')
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#sampleParent()
    const endedAtIso = new Date().toISOString()
    const observedDurationMs = Math.max(0, this.#now() - this.#startedAt)
    channel('zorya.segmentation.child-resource').unsubscribe(this.#onChild)
    const parentKeys: (keyof NodeJS.MemoryUsage)[] = [
      'rss',
      'heapTotal',
      'heapUsed',
      'external',
      'arrayBuffers',
    ]
    const childKeys = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'] as const
    return {
      sampleIntervalMs: this.#intervalMs,
      startedAtIso: this.#startedAtIso,
      endedAtIso,
      observedDurationMs,
      phaseTransitions: [...this.#phaseTransitions],
      parentSamples: [...this.#parentSamples],
      childSamples: [...this.#childSamples],
      childStarts: this.#childSamples.filter((sample) => sample.type === 'start').length,
      childCloses: this.#childSamples.filter((sample) => sample.type === 'close').length,
      childrenStillOwned: [...this.#children.keys()],
      parentPeak: Object.fromEntries(
        parentKeys.map((key) => [
          key,
          Math.max(...this.#parentSamples.map((sample) => sample[key])),
        ]),
      ) as Record<keyof NodeJS.MemoryUsage, number>,
      idleWindowMedian: {
        before: idleMedian(this.#parentSamples.filter((sample) => sample.phase === 'idle-before')),
        after: idleMedian(this.#parentSamples.filter((sample) => sample.phase === 'idle-after')),
      },
      childPeak: Object.fromEntries(
        childKeys.map((key) => [
          key,
          Math.max(0, ...this.#childSamples.map((sample) => sample[key] ?? 0)),
        ]),
      ) as ResourceReport['childPeak'],
    }
  }

  readonly #onChild = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return
    const sample = raw as ChildMemorySample
    if (sample.type === 'start' && sample.pid !== undefined && sample.jobId)
      this.#children.set(sample.pid, sample.jobId)
    if (sample.type === 'close' && sample.pid !== undefined) this.#children.delete(sample.pid)
    if (sample.type === 'memory' || sample.rss !== undefined)
      this.#childSamples.push({ ...sample, timestampMs: this.#elapsedMs() })
    else if (sample.type === 'start' || sample.type === 'close')
      this.#childSamples.push({ ...sample, timestampMs: this.#elapsedMs() })
  }

  #sampleParent(): void {
    this.#parentSamples.push({
      ...process.memoryUsage(),
      timestampMs: this.#elapsedMs(),
      phase: this.#phase,
    })
  }

  #elapsedMs(): number {
    return Math.max(0, this.#now() - this.#startedAt)
  }

  #recordPhase(phase: SamplingPhase): void {
    this.#phaseTransitions.push({
      phase,
      timestampMs: this.#elapsedMs(),
      timestampIso: new Date().toISOString(),
    })
  }
}

function idleMedian(
  samples: readonly ParentMemorySample[],
): ResourceReport['idleWindowMedian']['before'] {
  const keys = ['rss', 'heapUsed', 'external', 'arrayBuffers'] as const
  return Object.fromEntries(
    keys.map((key) => {
      const ordered = samples.map((sample) => sample[key]).sort((a, b) => a - b)
      const middle = Math.floor(ordered.length / 2)
      const median =
        ordered.length === 0
          ? 0
          : ordered.length % 2 === 0
            ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
            : (ordered[middle] ?? 0)
      return [key, median]
    }),
  ) as ResourceReport['idleWindowMedian']['before']
}
