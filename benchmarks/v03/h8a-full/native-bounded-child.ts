import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { ClassifierError } from '../../../src/entities/errors.js'
import {
  H8A_FULL_MAX_CHILD_RSS_BYTES,
  H8A_FULL_MAX_STDOUT_BYTES,
  H8A_FULL_MAX_STDERR_BYTES,
} from './constants.js'

interface BoundedChildOptions {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  deadlineAt: number
  signal: AbortSignal
  taskTempDir: string
  stdoutLimit?: number
  stderrLimit?: number
  rssLimit?: number
  killProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
}

interface BoundedChildResult {
  stdout: Buffer
  stdoutBytesTotal: number
  stderrBytesTotal: number
  exitCode: number | null
  status: 'complete' | 'timeout' | 'cancelled' | 'resource_limit' | 'error'
  errorMessage: string | null
  rssSamplingAvailable: boolean
  rssSampleIntervalMs: number
}

const NATIVE_ENV_KEYS = [
  'HF_HUB_OFFLINE',
  'TRANSFORMERS_OFFLINE',
  'HF_HUB_DISABLE_TELEMETRY',
  'TOKENIZERS_PARALLELISM',
  'OMP_NUM_THREADS',
  'MKL_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'TMPDIR',
  'H8A_FAKE_WORKER_MODE',
  'H8A_FAKE_SLEEP_SECONDS',
  'H8A_FAKE_STDOUT_BYTES',
  'H8A_FAKE_STDERR_BYTES',
] as const

const RSS_SAMPLE_INTERVAL_MS = 100
const TERMINATION_POLL_MS = 50
const TERMINATION_GRACE_MS = 250

type IgnoreStdinNativeChild = ChildProcessByStdio<null, Readable, Readable>

type BoundedChildRunState = {
  status: BoundedChildResult['status']
  errorMessage: string | null
  stdoutRetained: Buffer
  stderrRetained: Buffer
  stdoutBytesTotal: number
  stderrBytesTotal: number
  child: IgnoreStdinNativeChild | undefined
  registeredPgid: number | undefined
  terminationPromise: Promise<void> | undefined
  physicalSettled: boolean
  termSignalSent: boolean
  killSignalSent: boolean
  rssSamplingAvailable: boolean
  poll: NodeJS.Timeout | undefined
  rssSamplePromise: Promise<void> | undefined
  deadlineTimer: NodeJS.Timeout | undefined
  closeCode: number | null
  operationalError: unknown
  killOperationalError: unknown
  closeSettled: Promise<void> | undefined
  exitSettled: Promise<void> | undefined
}

export function buildNativeChildEnv(taskTempDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of NATIVE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.TMPDIR = taskTempDir
  env.HF_HUB_OFFLINE = '1'
  env.TRANSFORMERS_OFFLINE = '1'
  env.HF_HUB_DISABLE_TELEMETRY = '1'
  env.TOKENIZERS_PARALLELISM = 'false'
  env.OMP_NUM_THREADS = '1'
  env.MKL_NUM_THREADS = '1'
  env.OPENBLAS_NUM_THREADS = '1'
  return env
}

function isRegisteredLeaderPid(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function isEsrch(error: unknown): boolean {
  return errnoCode(error) === 'ESRCH'
}

function isProcExitRace(error: unknown): boolean {
  const code = errnoCode(error)
  return code === 'ENOENT' || code === 'ESRCH'
}

function parseProcStatPgrp(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat.slice(close + 2).split(/\s+/u)
  if (fields.length < 3) return null
  const pgrp = Number(fields[2])
  return Number.isFinite(pgrp) ? pgrp : null
}

function parseProcStatState(stat: string): string | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat.slice(close + 2).split(/\s+/u)
  return fields[0] ?? null
}

async function listProcessGroupPids(pgid: number): Promise<number[]> {
  const { readdir } = await import('node:fs/promises')
  let entries: Dirent[]
  try {
    entries = await readdir('/proc', { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if (isProcExitRace(error)) return []
    throw error
  }
  const pids: number[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const pgrp = parseProcStatPgrp(stat)
      if (pgrp === null) {
        throw new Error(`malformed /proc/${pid}/stat while scanning process group`)
      }
      if (pgrp === pgid) pids.push(pid)
    } catch (error) {
      if (isProcExitRace(error)) continue
      throw error
    }
  }
  return pids
}

async function processGroupAlive(pgid: number): Promise<boolean> {
  for (const pid of await listProcessGroupPids(pgid)) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const state = parseProcStatState(stat)
      if (state === null) {
        throw new Error(`malformed /proc/${pid}/stat while checking process group liveness`)
      }
      if (state !== 'Z') return true
    } catch (error) {
      if (isProcExitRace(error)) continue
      throw error
    }
  }
  return false
}

type OwnedGroupLiveness = {
  kind: 'gone' | 'live' | 'indeterminate'
  errors: readonly unknown[]
}

function probeOwnedProcessGroupWithSignal(pgid: number): OwnedGroupLiveness {
  try {
    process.kill(-pgid, 0)
    return { kind: 'live', errors: [] }
  } catch (error) {
    if (isEsrch(error)) return { kind: 'gone', errors: [] }
    if (errnoCode(error) === 'EPERM') return { kind: 'live', errors: [] }
    return { kind: 'indeterminate', errors: [error] }
  }
}

async function assessOwnedProcessGroupLiveness(pgid: number): Promise<OwnedGroupLiveness> {
  try {
    return (await processGroupAlive(pgid))
      ? { kind: 'live', errors: [] }
      : { kind: 'gone', errors: [] }
  } catch (scanError) {
    const signalLiveness = probeOwnedProcessGroupWithSignal(pgid)
    if (signalLiveness.kind === 'gone' || signalLiveness.kind === 'live') {
      return { kind: signalLiveness.kind, errors: [scanError] }
    }
    return { kind: 'indeterminate', errors: [scanError, ...signalLiveness.errors] }
  }
}

function ownedGroupStillPresent(liveness: OwnedGroupLiveness): boolean {
  return liveness.kind === 'live' || liveness.kind === 'indeterminate'
}

async function readProcessRssBytes(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    for (const line of status.split('\n')) {
      if (!line.startsWith('VmRSS:')) continue
      const parts = line.split(/\s+/u)
      const kb = Number(parts[1])
      if (Number.isFinite(kb)) return kb * 1024
    }
    return null
  } catch (error) {
    if (isProcExitRace(error)) return null
    throw error
  }
}

async function sampleProcessGroupRss(pgid: number): Promise<number | null> {
  let total = 0
  let found = false
  for (const pid of await listProcessGroupPids(pgid)) {
    const rss = await readProcessRssBytes(pid)
    if (rss === null) continue
    found = true
    total += rss
  }
  return found ? total : null
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitOwnedGroupDuringTermGrace(
  pgid: number,
  graceDeadlineMs: number,
  retainOperationalError: (error: unknown) => void,
): Promise<void> {
  while (performance.now() < graceDeadlineMs) {
    const liveness = await assessOwnedProcessGroupLiveness(pgid)
    for (const error of liveness.errors) retainOperationalError(error)
    if (liveness.kind === 'gone') return
    await sleep(TERMINATION_POLL_MS)
  }
}

async function pollOwnedGroupUntilConfirmedGone(
  pgid: number,
  retainOperationalError: (error: unknown) => void,
): Promise<void> {
  for (;;) {
    const liveness = await assessOwnedProcessGroupLiveness(pgid)
    for (const error of liveness.errors) retainOperationalError(error)
    if (liveness.kind === 'gone') return
    await sleep(TERMINATION_POLL_MS)
  }
}

async function drainStream(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return
  await new Promise<void>((resolve) => {
    const finish = () => {
      stream.removeListener('end', finish)
      stream.removeListener('close', finish)
      stream.removeListener('error', finish)
      resolve()
    }
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', finish)
    stream.resume()
  })
}

export async function runBoundedNativeChild(
  options: BoundedChildOptions,
): Promise<BoundedChildResult> {
  const stdoutLimit = options.stdoutLimit ?? H8A_FULL_MAX_STDOUT_BYTES
  const stderrLimit = options.stderrLimit ?? H8A_FULL_MAX_STDERR_BYTES
  const rssLimit = options.rssLimit ?? H8A_FULL_MAX_CHILD_RSS_BYTES
  const killGroup =
    options.killProcessGroup ??
    ((pgid: number, signal: NodeJS.Signals) => {
      process.kill(-pgid, signal)
    })

  const run: BoundedChildRunState = {
    status: 'complete',
    errorMessage: null,
    stdoutRetained: Buffer.alloc(0),
    stderrRetained: Buffer.alloc(0),
    stdoutBytesTotal: 0,
    stderrBytesTotal: 0,
    child: undefined,
    registeredPgid: undefined,
    terminationPromise: undefined,
    physicalSettled: false,
    termSignalSent: false,
    killSignalSent: false,
    rssSamplingAvailable: false,
    poll: undefined,
    rssSamplePromise: undefined,
    deadlineTimer: undefined,
    closeCode: null,
    operationalError: undefined,
    killOperationalError: undefined,
    closeSettled: undefined,
    exitSettled: undefined,
  }

  const emptyResult = (): BoundedChildResult => ({
    stdout: run.stdoutRetained,
    stdoutBytesTotal: run.stdoutBytesTotal,
    stderrBytesTotal: run.stderrBytesTotal,
    exitCode: run.closeCode,
    status: run.status,
    errorMessage: run.errorMessage,
    rssSamplingAvailable: run.rssSamplingAvailable,
    rssSampleIntervalMs: RSS_SAMPLE_INTERVAL_MS,
  })

  const appendRetained = (current: Buffer, chunk: Buffer, limit: number): Buffer => {
    if (current.length >= limit) return current
    const take = Math.min(chunk.byteLength, limit - current.length)
    if (take <= 0) return current
    const slice = chunk.subarray(0, take)
    const piece = Buffer.alloc(slice.byteLength)
    slice.copy(piece)
    if (current.length === 0) return piece
    return Buffer.concat([current, piece])
  }

  const retainOperationalError = (error: unknown) => {
    run.operationalError = run.operationalError ?? error
  }

  const retainKillOperationalError = (error: unknown) => {
    run.killOperationalError = run.killOperationalError ?? error
  }

  const applyOperationalFailureToStatus = () => {
    if (run.killOperationalError !== undefined) {
      run.status = 'error'
      run.errorMessage =
        run.errorMessage ??
        (run.killOperationalError instanceof Error
          ? run.killOperationalError.message
          : 'native child kill operational failure')
    }
    if (run.operationalError !== undefined) {
      if (run.status === 'complete') run.status = 'error'
      run.errorMessage =
        run.errorMessage ??
        (run.operationalError instanceof Error
          ? run.operationalError.message
          : 'native child operational failure')
    }
  }

  const markPhysicalSettled = () => {
    run.physicalSettled = true
  }

  const markInvalidLeaderSpawn = () => {
    run.status = 'error'
    run.errorMessage =
      run.operationalError instanceof Error
        ? run.operationalError.message
        : 'native child spawn did not register a positive leader pid'
  }

  const noteRssSamplingAvailable = () => {
    run.rssSamplingAvailable = true
  }

  const clearRssSamplePromise = () => {
    run.rssSamplePromise = undefined
  }

  const signalKill = async (signal: NodeJS.Signals) => {
    if (!isRegisteredLeaderPid(run.registeredPgid)) return
    try {
      killGroup(run.registeredPgid, signal)
    } catch (error) {
      if (isEsrch(error)) {
        const liveness = await assessOwnedProcessGroupLiveness(run.registeredPgid)
        for (const probeError of liveness.errors) {
          retainKillOperationalError(probeError)
        }
        if (liveness.kind === 'gone') return
        retainKillOperationalError(error)
        return
      }
      retainKillOperationalError(error)
    }
  }

  const stopPoll = () => {
    if (run.poll) clearInterval(run.poll)
    run.poll = undefined
    if (run.deadlineTimer) clearTimeout(run.deadlineTimer)
    run.deadlineTimer = undefined
  }

  const cleanupListeners = () => {
    stopPoll()
    options.signal.removeEventListener('abort', onAbort)
    run.child?.stdout.removeAllListeners('data')
    run.child?.stderr.removeAllListeners('data')
    run.child?.removeAllListeners('close')
    run.child?.removeAllListeners('exit')
  }

  const joinRssSample = async () => {
    if (!run.rssSamplePromise) return
    try {
      await run.rssSamplePromise
    } catch (error) {
      retainOperationalError(error)
    }
  }

  const settlePhysicalClosure = async (): Promise<void> => {
    if (run.physicalSettled) return

    const activeChild = run.child
    const closeWait = run.closeSettled
    if (activeChild && closeWait) {
      try {
        await closeWait
      } catch (error) {
        retainOperationalError(error)
      }
    }

    if (activeChild) {
      try {
        await drainStream(activeChild.stdout)
      } catch (error) {
        retainOperationalError(error)
      }
      try {
        await drainStream(activeChild.stderr)
      } catch (error) {
        retainOperationalError(error)
      }
    }

    const pgid = run.registeredPgid
    if (isRegisteredLeaderPid(pgid)) {
      await pollOwnedGroupUntilConfirmedGone(pgid, retainOperationalError)
    }

    applyOperationalFailureToStatus()
    markPhysicalSettled()
  }

  const runPhysicalTermination = async (): Promise<void> => {
    if (run.physicalSettled) return

    try {
      stopPoll()
      await joinRssSample()

      if (isRegisteredLeaderPid(run.registeredPgid)) {
        if (!run.termSignalSent) {
          run.termSignalSent = true
          await signalKill('SIGTERM')
        }
        const termDeadline = performance.now() + TERMINATION_GRACE_MS
        await waitOwnedGroupDuringTermGrace(
          run.registeredPgid,
          termDeadline,
          retainOperationalError,
        )
        let liveness = await assessOwnedProcessGroupLiveness(run.registeredPgid)
        for (const error of liveness.errors) retainOperationalError(error)
        while (ownedGroupStillPresent(liveness)) {
          if (!run.killSignalSent) {
            run.killSignalSent = true
            await signalKill('SIGKILL')
          }
          await pollOwnedGroupUntilConfirmedGone(run.registeredPgid, retainOperationalError)
          liveness = { kind: 'gone', errors: [] }
        }
      }
    } catch (error) {
      retainOperationalError(error)
      if (isRegisteredLeaderPid(run.registeredPgid)) {
        if (!run.killSignalSent) {
          run.killSignalSent = true
          await signalKill('SIGKILL')
        }
        await pollOwnedGroupUntilConfirmedGone(run.registeredPgid, retainOperationalError)
      }
    }

    if (!run.physicalSettled) {
      try {
        await settlePhysicalClosure()
      } catch (error) {
        retainOperationalError(error)
      }
      if (!run.physicalSettled) {
        await settlePhysicalClosure()
      }
    }
  }

  const ensureTermination = (): Promise<void> => {
    if (!run.terminationPromise) {
      run.terminationPromise = runPhysicalTermination().catch((error: unknown) => {
        retainOperationalError(error)
        if (!run.physicalSettled) {
          return settlePhysicalClosure()
        }
        return undefined
      })
    }
    return run.terminationPromise
  }

  const scheduleTermination = (): void => {
    ensureTermination().catch((error: unknown) => {
      retainOperationalError(error)
    })
  }

  const requestTerminal = (nextStatus: BoundedChildResult['status'], message: string) => {
    if (run.status !== 'complete') {
      scheduleTermination()
      return
    }
    run.status = nextStatus
    run.errorMessage = message
    scheduleTermination()
  }

  const onAbort = () => {
    requestTerminal('cancelled', 'native child cancelled')
  }

  if (options.signal.aborted) {
    return {
      ...emptyResult(),
      status: 'cancelled',
      errorMessage: 'native child cancelled',
    }
  }

  try {
    const spawned = spawn(options.command, [...options.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
      detached: true,
    })
    run.child = spawned

    spawned.on('error', (error: Error) => {
      retainOperationalError(error)
    })

    run.closeSettled = new Promise<void>((resolve) => {
      spawned.once('close', (code: number | null) => {
        run.closeCode = run.closeCode ?? code ?? spawned.exitCode ?? null
        scheduleTermination()
        resolve()
      })
    })

    if (isRegisteredLeaderPid(spawned.pid)) {
      run.exitSettled = new Promise<void>((resolve) => {
        spawned.once('exit', (code: number | null) => {
          run.closeCode = run.closeCode ?? code ?? spawned.exitCode ?? null
          scheduleTermination()
          resolve()
        })
      })
    } else {
      run.exitSettled = Promise.resolve()
    }

    if (!isRegisteredLeaderPid(spawned.pid)) {
      const closeWait = run.closeSettled
      await Promise.race([
        new Promise<void>((resolve) => {
          if (run.operationalError !== undefined) {
            resolve()
            return
          }
          spawned.once('error', (error: Error) => {
            retainOperationalError(error)
            resolve()
          })
        }),
        closeWait,
      ])
      markInvalidLeaderSpawn()
      spawned.stdout.destroy()
      spawned.stderr.destroy()
      await ensureTermination()
      return emptyResult()
    }

    run.registeredPgid = spawned.pid

    options.signal.addEventListener('abort', onAbort, { once: true })
    if (options.signal.aborted) {
      requestTerminal('cancelled', 'native child cancelled')
    }

    let overflowTriggered = false

    spawned.stdout.on('data', (chunk: Buffer) => {
      run.stdoutBytesTotal += chunk.byteLength
      run.stdoutRetained = appendRetained(run.stdoutRetained, chunk, stdoutLimit)
      if (!overflowTriggered && run.stdoutBytesTotal > stdoutLimit) {
        overflowTriggered = true
        requestTerminal('resource_limit', 'stdout exceeded bounded limit')
      }
    })

    spawned.stderr.on('data', (chunk: Buffer) => {
      run.stderrBytesTotal += chunk.byteLength
      run.stderrRetained = appendRetained(run.stderrRetained, chunk, stderrLimit)
      if (!overflowTriggered && run.stderrBytesTotal > stderrLimit) {
        overflowTriggered = true
        requestTerminal('resource_limit', 'stderr exceeded bounded limit')
      }
    })

    run.poll = setInterval(() => {
      if (run.rssSamplePromise) return
      run.rssSamplePromise = (async () => {
        try {
          if (performance.now() >= options.deadlineAt) {
            requestTerminal('timeout', 'native absolute deadline exceeded')
            return
          }
          const pgid = run.registeredPgid
          if (!isRegisteredLeaderPid(pgid)) return
          const rss = await sampleProcessGroupRss(pgid)
          if (rss !== null) {
            noteRssSamplingAvailable()
            if (rss > rssLimit) {
              requestTerminal('resource_limit', 'native child RSS exceeded bounded limit')
            }
          }
        } catch (error) {
          retainOperationalError(error)
        } finally {
          clearRssSamplePromise()
        }
      })()
    }, RSS_SAMPLE_INTERVAL_MS)

    const remainingMs = Math.max(0, options.deadlineAt - performance.now())
    run.deadlineTimer = setTimeout(() => {
      requestTerminal('timeout', 'native absolute deadline exceeded')
    }, remainingMs)

    await run.closeSettled
    await run.exitSettled

    if (run.stdoutBytesTotal > stdoutLimit && run.status === 'complete') {
      run.status = 'resource_limit'
      run.errorMessage = 'stdout exceeded bounded limit'
    }
    if (run.stderrBytesTotal > stderrLimit && run.status === 'complete') {
      run.status = 'resource_limit'
      run.errorMessage = 'stderr exceeded bounded limit'
    }

    await ensureTermination()

    if (run.status === 'complete' && run.closeCode !== 0) {
      run.status = 'error'
      run.errorMessage = `native child exited with status ${String(run.closeCode)}`
    }

    if (run.status === 'complete' && isRegisteredLeaderPid(run.registeredPgid)) {
      const pgid = run.registeredPgid
      const liveness = await assessOwnedProcessGroupLiveness(pgid)
      for (const error of liveness.errors) retainOperationalError(error)
      if (run.status === 'complete') {
        if (liveness.kind === 'indeterminate') {
          run.status = 'error'
          run.errorMessage =
            run.errorMessage ??
            (run.operationalError instanceof Error
              ? run.operationalError.message
              : 'native child process group liveness could not be confirmed')
        } else if (ownedGroupStillPresent(liveness)) {
          run.status = 'error'
          run.errorMessage = 'owned process group remained live after leader exit'
        }
      }
    }

    if (run.operationalError !== undefined && run.status === 'complete') {
      run.status = 'error'
      run.errorMessage =
        run.errorMessage ??
        (run.operationalError instanceof Error
          ? run.operationalError.message
          : 'native child operational failure')
    }

    return emptyResult()
  } catch (error) {
    run.status = 'error'
    run.errorMessage = error instanceof Error ? error.message : 'native child operational failure'
    retainOperationalError(error)
    await ensureTermination()
    if (run.operationalError !== undefined) {
      run.errorMessage =
        run.errorMessage ??
        (run.operationalError instanceof Error
          ? run.operationalError.message
          : 'native child operational failure')
    }
    return emptyResult()
  } finally {
    cleanupListeners()
    if (!run.physicalSettled) {
      await ensureTermination()
    }
    try {
      run.child?.stdout.destroy()
    } catch (error) {
      if (!isEsrch(error)) retainOperationalError(error)
    }
    try {
      run.child?.stderr.destroy()
    } catch (error) {
      if (!isEsrch(error)) retainOperationalError(error)
    }
  }
}

export function nativeFailure(message: string, cause?: unknown): ClassifierError {
  const details: Readonly<Record<string, unknown>> = cause === undefined ? {} : { cause }
  return new ClassifierError('PROVIDER', message, details)
}
