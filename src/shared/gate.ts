import { ClassifierError, assertActive } from '../entities/errors.js'

type Waiter = {
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
  onAbort: () => void
}
/** A slot is retained until the physical job's finally block calls release. */
export class OperationGate {
  private active = 0
  private readonly queue: Waiter[] = []
  constructor(
    private readonly capacity: number,
    private readonly maxQueue: number,
  ) {}
  assertAvailable(): void {
    if (this.active >= this.capacity && this.queue.length >= this.maxQueue)
      throw new ClassifierError('CAPACITY', 'Operation queue is full')
  }
  async acquire(signal: AbortSignal): Promise<void> {
    assertActive(signal)
    this.assertAvailable()
    if (this.active < this.capacity) {
      this.active++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(entry)
          if (index < 0) return
          this.queue.splice(index, 1)
          signal.removeEventListener('abort', entry.onAbort)
          reject(signal.reason)
        },
      }
      this.queue.push(entry)
      signal.addEventListener('abort', entry.onAbort, { once: true })
      if (signal.aborted) entry.onAbort()
    })
  }
  release(): void {
    this.active--
    const entry = this.queue.shift()
    if (!entry) return
    entry.signal.removeEventListener('abort', entry.onAbort)
    this.active++
    entry.resolve()
  }
}
