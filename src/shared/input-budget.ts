import { ClassifierError } from '../entities/errors.js'

/** Reserves active plus queued snapshots before allocating any owned byte copy. */
export class InputBudget {
  private retained = 0
  constructor(private readonly limit: number) {}

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.retained)
      throw new ClassifierError('CAPACITY', 'Owned input byte budget is full')
    this.retained += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.retained -= bytes
    }
  }
}
