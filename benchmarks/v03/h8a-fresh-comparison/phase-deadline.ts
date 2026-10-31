const MAX_TIMEOUT_MS = 2_147_483_647

class PhaseDeadlineError extends Error {
  readonly code: 'PHASE_DEADLINE_EXPIRED' | 'PHASE_CALLER_ABORTED'

  constructor(code: 'PHASE_DEADLINE_EXPIRED' | 'PHASE_CALLER_ABORTED') {
    super(code)
    this.name = 'PhaseDeadlineError'
    this.code = code
  }
}

export interface PhaseDeadlineScope {
  signal: AbortSignal
  assertOpen(): void
  dispose(): void
}

export function createPhaseDeadlineScope(
  deadlineIso: string,
  callerSignal?: AbortSignal,
  nowMilliseconds: () => number = Date.now,
): PhaseDeadlineScope {
  const deadlineMilliseconds = Date.parse(deadlineIso)
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(deadlineIso)
  const normalizedIso = match ? `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z` : ''
  if (
    !match ||
    !Number.isFinite(deadlineMilliseconds) ||
    new Date(deadlineMilliseconds).toISOString() !== normalizedIso
  )
    throw new RangeError('Invalid phase deadline')
  if (deadlineMilliseconds <= nowMilliseconds()) throw new RangeError('Phase deadline has expired')

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const abortForDeadline = () => {
    if (!controller.signal.aborted)
      controller.abort(new PhaseDeadlineError('PHASE_DEADLINE_EXPIRED'))
  }
  const abortForCaller = () => {
    if (!controller.signal.aborted) controller.abort(new PhaseDeadlineError('PHASE_CALLER_ABORTED'))
  }
  const scheduleDeadlineCheck = () => {
    if (disposed || controller.signal.aborted) return
    const remaining = deadlineMilliseconds - nowMilliseconds()
    if (remaining <= 0) {
      abortForDeadline()
      return
    }
    timer = setTimeout(scheduleDeadlineCheck, Math.min(remaining, MAX_TIMEOUT_MS))
  }

  if (callerSignal?.aborted) abortForCaller()
  else callerSignal?.addEventListener('abort', abortForCaller, { once: true })
  scheduleDeadlineCheck()

  return {
    signal: controller.signal,
    assertOpen() {
      if (!controller.signal.aborted && deadlineMilliseconds <= nowMilliseconds())
        abortForDeadline()
      controller.signal.throwIfAborted()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abortForCaller)
    },
  }
}
