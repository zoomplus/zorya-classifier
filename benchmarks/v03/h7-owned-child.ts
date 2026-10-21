import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { ClassifierError } from '../../src/entities/errors.js'

/** One benchmark-owned persistent process. Failed operations settle only after physical close. */
export class H7OwnedChild {
  readonly child: ChildProcessWithoutNullStreams
  readonly #lines: Interface
  readonly #iterator: AsyncIterator<string>
  readonly #closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  #failure: Error | undefined
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  #busy = false
  #stopping: Promise<void> | undefined
  #stderr = ''

  constructor(command: string, args: readonly string[], cwd: string) {
    this.child = spawn(command, [...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        TOKENIZERS_PARALLELISM: 'false',
      },
    })
    this.#lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.#iterator = this.#lines[Symbol.asyncIterator]()
    let outputBytes = 0
    this.child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > 8 * 1024 * 1024) {
        this.#failure ??= new ClassifierError('RESOURCE_LIMIT', 'H7 worker output exceeded 8 MiB')
        this.child.kill('SIGKILL')
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-16_384)
    })
    this.child.stdin.on('error', (error) => {
      this.#failure ??= error
      this.child.kill('SIGKILL')
    })
    this.#closed = new Promise((resolve) => {
      this.child.once('error', (error) => {
        this.#failure ??= error
      })
      this.child.once('close', (code, signal) => {
        this.#exit = { code, signal }
        this.#lines.close()
        resolve(this.#exit)
      })
    })
  }

  get receipt() {
    return { pid: this.child.pid ?? null, closed: this.#exit !== undefined, ...this.#exit }
  }

  get stderr(): string {
    return this.#stderr
  }

  async exchange(payload: unknown, deadlineAt: number, signal: AbortSignal): Promise<unknown> {
    if (this.#busy) throw new ClassifierError('CAPACITY', 'H7 worker already has an active request')
    this.#busy = true
    const abort = () => {
      this.#failure ??=
        signal.reason instanceof ClassifierError
          ? signal.reason
          : new ClassifierError('ABORTED', 'H7 worker operation was cancelled')
      this.child.kill('SIGKILL')
    }
    const timer = setTimeout(
      () => {
        this.#failure ??= new ClassifierError('TIMEOUT', 'H7 worker absolute deadline exceeded')
        this.child.kill('SIGKILL')
      },
      Math.max(0, deadlineAt - performance.now()),
    )
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      if (performance.now() >= deadlineAt)
        this.#failure ??= new ClassifierError('TIMEOUT', 'H7 worker absolute deadline exceeded')
      if (this.#failure) throw this.#failure
      if (this.#exit) throw new ClassifierError('PROVIDER', 'H7 worker is already closed')
      if (payload !== undefined) {
        const data = JSON.stringify(payload) + '\n'
        if (Buffer.byteLength(data) > 1024 * 1024)
          throw new ClassifierError('RESOURCE_LIMIT', 'H7 worker input exceeds 1 MiB')
        await new Promise<void>((resolve, reject) => {
          this.child.stdin.write(data, (error) => (error ? reject(error) : resolve()))
        })
      }
      const result = await this.#iterator.next()
      if (this.#failure) throw this.#failure
      if (result.done) throw new ClassifierError('PROVIDER', 'H7 worker closed without a response')
      if (performance.now() >= deadlineAt)
        throw new ClassifierError('TIMEOUT', 'H7 worker absolute deadline exceeded')
      return JSON.parse(result.value) as unknown
    } catch (error) {
      await this.dispose()
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.#busy = false
    }
  }

  async finish(signal: AbortSignal): Promise<void> {
    const reply = await this.exchange({ command: 'close' }, performance.now() + 5000, signal)
    if (JSON.stringify(reply) !== '{"type":"closed"}') {
      await this.dispose()
      throw new ClassifierError('INVALID_RESPONSE', 'H7 worker did not acknowledge shutdown')
    }
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000)
    try {
      const exit = await this.#closed
      if (exit.code !== 0) throw new ClassifierError('PROVIDER', 'H7 worker shutdown failed')
    } finally {
      clearTimeout(timer)
      await this.dispose()
    }
  }

  dispose(): Promise<void> {
    this.#stopping ??= this.#dispose()
    return this.#stopping
  }

  async #dispose(): Promise<void> {
    if (!this.#exit) this.child.kill('SIGTERM')
    const escalation = setTimeout(() => this.child.kill('SIGKILL'), 250)
    try {
      await this.#closed
    } finally {
      clearTimeout(escalation)
      this.#lines.close()
      this.child.stdin.destroy()
      this.child.stdout.destroy()
      this.child.stderr.destroy()
    }
  }
}
