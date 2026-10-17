import { ClassifierError, assertActive } from '../entities/errors.js'

export class OperationScope {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  readonly startedAt = performance.now()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly onAbort: () => void
  constructor(
    timeoutMs: number,
    private readonly parent?: AbortSignal,
  ) {
    this.onAbort = () =>
      this.controller.abort(new ClassifierError('ABORTED', 'Operation cancelled'))
    if (parent?.aborted) this.onAbort()
    else parent?.addEventListener('abort', this.onAbort, { once: true })
    this.timer = setTimeout(
      () => this.controller.abort(new ClassifierError('TIMEOUT', 'Operation deadline exceeded')),
      timeoutMs,
    )
    this.timer.unref()
  }
  guard(): void {
    assertActive(this.signal)
  }
  abort(): void {
    this.onAbort()
  }
  dispose(): void {
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.onAbort)
  }
}
