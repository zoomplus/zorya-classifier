import { randomUUID } from 'node:crypto'
import { ClassifierError } from '../../../src/entities/errors.js'
import type { DecisionPort, RasterPort } from '../../../src/entities/contracts.js'
import type { createSharpH6Presentation } from '../h6-context-composer.js'
import type { H6DecisionBudgetRecordPort } from '../h6-context-composer.js'
import type { H8aFullSuccess } from './contracts.js'
import {
  H8A_FULL_CASE_DEADLINE_MS,
  H8A_FULL_MAX_NATIVE_WAITING,
  H8A_FULL_RECIPE_ID,
  type H8aFullRecipeId,
} from './constants.js'
import {
  captureH8aFullRun,
  ownH8aFullRunSnapshot,
  runH8aFullPipelineSnapshot,
  type H8aFullPipelineDependencies,
  type H8aFullPipelineInput,
  type H8aFullRunSnapshot,
} from './pipeline.js'
import {
  H8aFullNativePort,
  defaultWorkerScriptPath,
  type H8aFullNativePortOptions,
} from './native-port.js'

type H8aRuntimeRunInput = H8aFullPipelineInput & {
  decision: DecisionPort
  imageState: RasterPort['imageState']
  presentation?: ReturnType<typeof createSharpH6Presentation>
  budgetRecord?: H6DecisionBudgetRecordPort
}

interface H8aFullRuntimeFactoryConfig {
  pythonExecutable: string
  assetRoot: string
  artifactRoot: string
  workerScriptPath?: string
  recipeId?: H8aFullRecipeId
}

interface H8aFullRuntime {
  run(input: H8aRuntimeRunInput): Promise<H8aFullSuccess>
  dispose(): Promise<void>
}

type FullRunState = 'waiting' | 'active' | 'done'

interface FullRunJob {
  id: string
  snapshot: H8aFullRunSnapshot
  dependencies: Omit<H8aFullPipelineDependencies, 'artifactRoot'>
  resolve(value: H8aFullSuccess): void
  reject(error: unknown): void
  controller: AbortController
  callerSignal: AbortSignal
  onCallerAbort: (() => void) | undefined
  deadlineTimer: ReturnType<typeof setTimeout> | undefined
  state: FullRunState
}

export function createH8aFullRuntime(config: H8aFullRuntimeFactoryConfig): H8aFullRuntime {
  if (!config.pythonExecutable || !config.assetRoot || !config.artifactRoot)
    throw new ClassifierError('INVALID_INPUT', 'H8a runtime factory requires explicit paths')
  const artifactRoot = config.artifactRoot
  const recipeId = config.recipeId ?? H8A_FULL_RECIPE_ID
  const nativeOptions: H8aFullNativePortOptions = {
    pythonExecutable: config.pythonExecutable,
    assetRoot: config.assetRoot,
    artifactRoot,
    workerScriptPath: config.workerScriptPath ?? defaultWorkerScriptPath(),
    recipeId,
  }
  const native = new H8aFullNativePort(nativeOptions)
  const waiting: FullRunJob[] = []
  const physicalJobs = new Set<Promise<void>>()
  let active: FullRunJob | undefined
  let disposed = false
  let disposePromise: Promise<void> | undefined

  const clearDeadline = (job: FullRunJob) => {
    if (job.deadlineTimer === undefined) return
    clearTimeout(job.deadlineTimer)
    job.deadlineTimer = undefined
  }

  const finish = (job: FullRunJob, error?: unknown, value?: H8aFullSuccess) => {
    if (job.state === 'done') return
    if (value !== undefined && performance.now() >= job.snapshot.deadlineAt) {
      error = timeoutError()
      value = undefined
    }
    clearDeadline(job)
    if (job.onCallerAbort) job.callerSignal.removeEventListener('abort', job.onCallerAbort)
    job.state = 'done'
    job.snapshot.encodedImage.fill(0)
    const index = waiting.indexOf(job)
    if (index >= 0) waiting.splice(index, 1)
    if (error !== undefined) job.reject(error)
    else if (value !== undefined) job.resolve(value)
    else job.reject(new ClassifierError('PROVIDER', 'H8a full run ended without a result'))
  }

  const pump = () => {
    if (disposed || active || waiting.length === 0) return
    const job = waiting.shift()
    if (!job || job.state !== 'waiting') return
    if (job.controller.signal.aborted) {
      finish(job, normalizeAbort(job.controller.signal.reason))
      pump()
      return
    }
    if (performance.now() >= job.snapshot.deadlineAt) {
      finish(job, timeoutError())
      pump()
      return
    }
    job.state = 'active'
    active = job
    const physical = runH8aFullPipelineSnapshot(
      job.snapshot,
      job.dependencies,
      job.controller.signal,
    )
      .then(
        (result) => finish(job, undefined, result),
        (error: unknown) => finish(job, normalizeRunError(error)),
      )
      .then(() => {
        physicalJobs.delete(physical)
        if (active === job) active = undefined
        pump()
      })
    physicalJobs.add(physical)
  }

  return {
    run(input) {
      if (disposed)
        return Promise.reject(new ClassifierError('DISPOSED', 'H8a runtime is disposed'))
      const admittedAt = performance.now()
      const deadlineAt = admittedAt + H8A_FULL_CASE_DEADLINE_MS
      let capture
      try {
        const dependencies: H8aFullPipelineDependencies = {
          decision: input.decision,
          imageState: input.imageState,
          native,
          artifactRoot,
          ...(input.presentation ? { presentation: input.presentation } : {}),
          ...(input.budgetRecord ? { budgetRecord: input.budgetRecord } : {}),
        }
        capture = captureH8aFullRun(input, dependencies)
      } catch (error) {
        return Promise.reject(normalizeRunError(error))
      }
      if (
        active &&
        waiting.filter((job) => job.state === 'waiting').length >= H8A_FULL_MAX_NATIVE_WAITING
      )
        return Promise.reject(new ClassifierError('CAPACITY', 'H8a full-run queue is full'))
      if (capture.callerSignal.aborted)
        return Promise.reject(normalizeAbort(capture.callerSignal.reason))

      let snapshot: H8aFullRunSnapshot
      try {
        snapshot = ownH8aFullRunSnapshot(capture, deadlineAt, randomUUID())
      } catch (error) {
        return Promise.reject(normalizeRunError(error))
      }
      if (performance.now() >= deadlineAt) {
        snapshot.encodedImage.fill(0)
        return Promise.reject(timeoutError())
      }

      let resolve!: (value: H8aFullSuccess) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<H8aFullSuccess>((yes, no) => {
        resolve = yes
        reject = no
      })
      const controller = new AbortController()
      const job: FullRunJob = {
        id: randomUUID(),
        snapshot,
        dependencies: capture.dependencies,
        resolve,
        reject,
        controller,
        callerSignal: capture.callerSignal,
        onCallerAbort: undefined,
        deadlineTimer: undefined,
        state: 'waiting',
      }
      const onCallerAbort = () => {
        controller.abort(capture.callerSignal.reason)
        if (job.state === 'waiting') finish(job, normalizeAbort(capture.callerSignal.reason))
      }
      job.onCallerAbort = onCallerAbort
      capture.callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      if (capture.callerSignal.aborted) {
        finish(job, normalizeAbort(capture.callerSignal.reason))
        return promise
      }
      job.deadlineTimer = setTimeout(
        () => {
          const reason = timeoutError()
          controller.abort(reason)
          if (job.state === 'waiting') finish(job, reason)
        },
        Math.max(0, deadlineAt - performance.now()),
      )
      job.deadlineTimer.unref?.()
      waiting.push(job)
      pump()
      return promise
    },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      for (const job of [...waiting]) {
        if (job.state !== 'waiting') continue
        const reason = new ClassifierError('DISPOSED', 'H8a runtime disposed before run started')
        job.controller.abort(reason)
        finish(job, reason)
      }
      active?.controller.abort(new ClassifierError('DISPOSED', 'H8a runtime is disposing'))
      disposePromise = (async () => {
        while (physicalJobs.size > 0) await Promise.all([...physicalJobs])
        await native.dispose()
      })()
      return disposePromise
    },
  }
}

function timeoutError(): ClassifierError {
  return new ClassifierError('TIMEOUT', 'H8a full run exceeded its absolute deadline')
}

function normalizeAbort(reason: unknown): ClassifierError {
  if (reason instanceof ClassifierError) return reason
  return new ClassifierError('ABORTED', 'H8a full run was cancelled', { cause: reason })
}

function normalizeRunError(error: unknown): unknown {
  if (error instanceof ClassifierError) return error
  if (error instanceof Error)
    return new ClassifierError('PROVIDER', error.message.slice(0, 500), { cause: error })
  return new ClassifierError('PROVIDER', 'H8a full run failed', { cause: error })
}
