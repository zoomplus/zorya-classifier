import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ClassifierError } from '../../entities/errors.js'
import { fileURLToPath } from 'node:url'

interface Job<T> {
  id: string
  payload: T
  signal: AbortSignal
  resolve(value: unknown): void
  reject(error: unknown): void
  promise: Promise<unknown>
  child?: ChildProcess
  timer?: NodeJS.Timeout
  abortTimer?: NodeJS.Timeout
  exitTimer?: NodeJS.Timeout
  abortListener?: () => void
  started: boolean
  done: boolean
  reply?: unknown
  failure?: unknown
}

export interface NativeChildPoolOptions<T> {
  workerUrl: URL
  maxActive?: number
  maxWaiting?: number
  jobTimeoutMs?: number
  abortGraceMs?: number
  encode(job: { id: string; payload: T }): Uint8Array
  decode(value: unknown, id: string): unknown
}

/** Owns every spawned child until its exit event confirms physical settlement. */
export class NativeChildPool<T> {
  readonly #workerUrl: URL
  readonly #maxActive: number
  readonly #maxWaiting: number
  readonly #jobTimeoutMs: number
  readonly #abortGraceMs: number
  readonly #encode: NativeChildPoolOptions<T>['encode']
  readonly #decode: NativeChildPoolOptions<T>['decode']
  readonly #queue: Job<T>[] = []
  readonly #physical = new Set<Job<T>>()
  readonly #lifetime = new AbortController()
  #active = 0
  #closing: Promise<void> | undefined
  #poisoned: unknown

  public constructor(options: NativeChildPoolOptions<T>) {
    this.#workerUrl = options.workerUrl
    this.#maxActive = options.maxActive ?? 1
    this.#maxWaiting = options.maxWaiting ?? 2
    this.#jobTimeoutMs = options.jobTimeoutMs ?? 10_000
    this.#abortGraceMs = options.abortGraceMs ?? 250
    this.#encode = options.encode
    this.#decode = options.decode
  }

  public run(payload: T, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(cancelledError(signal.reason))
    if (this.#closing)
      return Promise.reject(new ClassifierError('DISPOSED', 'Native child pool is disposed'))
    if (this.#poisoned) return Promise.reject(nativeFailure(this.#poisoned))
    if (this.#queue.length >= this.#maxWaiting && this.#active >= this.#maxActive)
      return Promise.reject(new ClassifierError('CAPACITY', 'Native child queue is full'))

    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<unknown>((yes, no) => {
      resolve = yes
      reject = no
    })
    const job: Job<T> = {
      id: randomUUID(),
      payload,
      signal: AbortSignal.any([signal, this.#lifetime.signal]),
      resolve,
      reject,
      promise,
      started: false,
      done: false,
    }
    job.abortListener = () => this.#abort(job, cancelledError(job.signal.reason))
    job.signal.addEventListener('abort', job.abortListener, { once: true })
    if (job.signal.aborted) job.abortListener()
    else {
      this.#queue.push(job)
      this.#pump()
    }
    return promise
  }

  #pump(): void {
    while (!this.#closing && !this.#poisoned && this.#active < this.#maxActive) {
      const job = this.#queue.shift()
      if (!job) return
      if (job.done || job.signal.aborted) {
        this.#finishQueued(job, job.signal.reason ?? new Error('Native task cancelled'))
        continue
      }
      this.#start(job)
    }
  }

  #start(job: Job<T>): void {
    job.started = true
    this.#active++
    this.#physical.add(job)
    const workerPath = fileURLToPath(this.#workerUrl)
    let child: ChildProcess
    try {
      child = fork(workerPath, [], {
        execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx'] : [],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      })
    } catch (error) {
      job.failure = nativeFailure(error)
      this.#poison(job.failure)
      this.#endPhysical(job)
      return
    }
    job.child = child
    let output = ''
    let outputBytes = 0
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 24 * 1024 * 1024) {
        job.failure = new ClassifierError(
          'RESOURCE_LIMIT',
          'Native child output exceeded its limit',
        )
        child.kill()
        return
      }
      output += chunk
    })
    child.stderr?.resume()
    child.stdin?.on('error', (error) => {
      job.failure ??= nativeFailure(error)
    })
    child.on('message', (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== 'ready'
      ) {
        job.failure ??= new ClassifierError(
          'INVALID_RESPONSE',
          'Native child sent an invalid control message',
        )
        child.kill()
      }
    })
    child.on('error', (error) => {
      job.failure ??= nativeFailure(error)
    })
    child.on('close', (code, signal) => {
      if (!job.failure && code !== 0)
        job.failure = new ClassifierError(
          'PROVIDER',
          `Native child exited with code ${String(code)} (${String(signal)})`,
        )
      if (!job.failure) {
        try {
          const raw: unknown = JSON.parse(output)
          job.reply = this.#decode(raw, job.id)
        } catch (error) {
          job.failure =
            error instanceof ClassifierError
              ? error
              : new ClassifierError('INVALID_RESPONSE', 'Native child returned an invalid reply')
        }
      }
      child.stdin?.removeAllListeners()
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      this.#endPhysical(job)
    })
    job.timer = setTimeout(
      () =>
        this.#abort(
          job,
          new ClassifierError('TIMEOUT', 'Native segmentation exceeded its job limit'),
        ),
      this.#jobTimeoutMs,
    )
    try {
      const bytes = this.#encode({ id: job.id, payload: job.payload })
      if (bytes.byteLength > 96 * 1024 * 1024)
        throw new ClassifierError('RESOURCE_LIMIT', 'Native child input exceeded its size limit')
      child.stdin?.end(bytes)
    } catch (error) {
      job.failure = nativeFailure(error)
      child.kill()
    }
    if (job.signal.aborted) this.#abort(job, cancelledError(job.signal.reason))
  }

  #abort(job: Job<T>, reason: unknown): void {
    if (job.done) return
    if (!job.started) {
      const queued = this.#queue.indexOf(job)
      if (queued >= 0) this.#queue.splice(queued, 1)
      this.#finishQueued(job, reason)
      return
    }
    job.failure ??= reason
    if (job.abortTimer) return
    job.abortTimer = setTimeout(() => {
      if (!job.child || !this.#physical.has(job)) return
      job.child.kill('SIGKILL')
      job.exitTimer = setTimeout(() => {
        if (this.#physical.has(job)) this.#poison(reason)
      }, 2000)
    }, this.#abortGraceMs)
  }

  #poison(reason: unknown): void {
    this.#poisoned ??= nativeFailure(reason)
    while (this.#queue.length) {
      const job = this.#queue.shift()
      if (job) this.#finishQueued(job, this.#poisoned)
    }
  }

  #finishQueued(job: Job<T>, error: unknown): void {
    if (job.done) return
    job.done = true
    const queued = this.#queue.indexOf(job)
    if (queued >= 0) this.#queue.splice(queued, 1)
    job.signal.removeEventListener('abort', job.abortListener!)
    job.reject(error)
  }

  #endPhysical(job: Job<T>): void {
    if (!this.#physical.delete(job)) return
    this.#active--
    clearTimeout(job.timer)
    clearTimeout(job.abortTimer)
    clearTimeout(job.exitTimer)
    job.signal.removeEventListener('abort', job.abortListener!)
    if (!job.done) {
      job.done = true
      if (job.failure !== undefined) job.reject(job.failure)
      else job.resolve(job.reply)
    }
    this.#pump()
  }

  public async settle(): Promise<void> {
    while (this.#queue.length || this.#physical.size) {
      await Promise.allSettled([...[...this.#physical].map((job) => job.promise)])
      if (this.#queue.length && this.#active === 0) this.#pump()
      if (this.#physical.size) await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }

  public dispose(): Promise<void> {
    if (!this.#closing) {
      this.#closing = this.#dispose()
      this.#lifetime.abort(new Error('Native child pool disposed'))
    }
    return this.#closing
  }

  async #dispose(): Promise<void> {
    this.#lifetime.abort(new Error('Native child pool disposed'))
    for (const job of [...this.#queue]) this.#abort(job, this.#lifetime.signal.reason)
    for (const job of this.#physical) this.#abort(job, this.#lifetime.signal.reason)
    await this.settle()
  }
}

function cancelledError(reason: unknown): ClassifierError {
  if (reason instanceof ClassifierError) return reason
  const message =
    reason instanceof Error && reason.message ? reason.message : 'Native task cancelled'
  return new ClassifierError('ABORTED', message)
}

function nativeFailure(error: unknown): ClassifierError {
  if (error instanceof ClassifierError) return error
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'ENOENT')
    return new ClassifierError('UNSUPPORTED', 'Native worker executable is unavailable')
  return new ClassifierError('PROVIDER', 'Native child process failed')
}
