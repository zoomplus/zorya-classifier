import { randomUUID } from 'node:crypto'

import type { McpConfig, McpConfigInput } from '../config.js'
import { parseMcpConfig } from '../config.js'
import type {
  ArtifactDescriptor,
  JobSnapshot,
  JobState,
  JsonObject,
  OperationName,
  OperationOutput,
  Principal,
  SafeError,
} from '../contracts.js'
import { McpCoreError, safeError } from '../errors.js'

type JobTask = (jobId: string, signal: AbortSignal, deadlineAt: number) => Promise<OperationOutput>

interface QueuedJob {
  readonly id: string
  readonly ownerId: string
  readonly operation: OperationName
  readonly createdAt: number
  readonly deadlineAt: number
  readonly queuedBytes: number
  readonly controller: AbortController
  task?: JobTask
  state: JobState
  artifacts: ArtifactDescriptor[]
  result?: OperationOutput
  error?: SafeError
  timeoutTriggered: boolean
  cancelTriggered: boolean
  completedAt?: number
  timer?: NodeJS.Timeout
}

export interface JobSchedulerOptions {
  readonly config: McpConfig | McpConfigInput
  readonly onEvict: (ownerId: string, jobId: string) => Promise<void>
  readonly onCleanupFailure?: () => void
}

export interface SubmitJobInput {
  readonly principal: Principal
  readonly operation: OperationName
  readonly queuedBytes: number
  readonly task: JobTask
  readonly artifacts?: readonly ArtifactDescriptor[]
}

export class JobScheduler {
  readonly #config: McpConfig
  readonly #onEvict: JobSchedulerOptions['onEvict']
  readonly #onCleanupFailure: () => void
  readonly #jobs = new Map<string, QueuedJob>()
  readonly #queue: string[] = []
  readonly #running = new Map<string, QueuedJob>()
  readonly #runTasks = new Map<string, Promise<void>>()
  readonly #cleanupTasks = new Set<Promise<void>>()
  readonly #sweepTimer: NodeJS.Timeout
  #cleanupFailureCount = 0
  #closed = false
  #shutdownPromise: Promise<void> | undefined

  constructor(options: JobSchedulerOptions) {
    this.#config = parseMcpConfig(options.config)
    this.#onEvict = options.onEvict
    this.#onCleanupFailure =
      options.onCleanupFailure ?? (() => console.error('MCP artifact cleanup failed.'))
    const sweepIntervalMs = Math.max(25, Math.min(1_000, this.#config.limits.jobTtlMs / 4))
    this.#sweepTimer = setInterval(() => {
      if (this.#closed) return
      try {
        this.#pruneExpired(Date.now())
      } catch {
        this.#reportCleanupFailure()
      }
    }, sweepIntervalMs)
    this.#sweepTimer.unref()
  }

  submit(input: SubmitJobInput): JsonObject {
    this.#assertOpen()
    const now = Date.now()
    this.#pruneExpired(now)
    this.#ensureStoredCapacity(input.principal.ownerId)
    this.#ensureQueueCapacity(input.principal.ownerId, input.queuedBytes)

    const id = randomUUID()
    const job: QueuedJob = {
      id,
      ownerId: input.principal.ownerId,
      operation: input.operation,
      createdAt: now,
      deadlineAt: now + this.#config.limits.jobTimeoutMs,
      queuedBytes: input.queuedBytes,
      controller: new AbortController(),
      task: input.task,
      state: 'queued',
      artifacts: [...(input.artifacts ?? [])],
      timeoutTriggered: false,
      cancelTriggered: false,
    }
    job.timer = setTimeout(() => this.#onDeadline(job), Math.max(0, job.deadlineAt - Date.now()))
    this.#jobs.set(id, job)
    this.#queue.push(id)
    this.#pump()
    return {
      jobId: id,
      state: 'queued',
      operation: job.operation,
      createdAt: job.createdAt,
      deadlineAt: job.deadlineAt,
    }
  }

  get(ownerId: string, jobId: string): JobSnapshot {
    this.#pruneExpired(Date.now())
    const job = this.#jobs.get(jobId)
    if (job === undefined || job.ownerId !== ownerId) {
      throw new McpCoreError('NOT_FOUND', 'Job was not found.')
    }
    return this.#snapshot(job)
  }

  cancel(ownerId: string, jobId: string): JobSnapshot {
    this.#pruneExpired(Date.now())
    const job = this.#jobs.get(jobId)
    if (job === undefined || job.ownerId !== ownerId) {
      throw new McpCoreError('NOT_FOUND', 'Job was not found.')
    }
    if (job.state === 'queued') {
      job.cancelTriggered = true
      job.controller.abort(new McpCoreError('CANCELLED', 'The job was cancelled.'))
      job.state = 'cancelled'
      job.completedAt = Date.now()
      delete job.task
      this.#clearTimer(job)
      this.#removeQueued(job.id)
      this.#pump()
    } else if (job.state === 'running') {
      job.cancelTriggered = true
      job.state = 'cancelling'
      job.controller.abort(new McpCoreError('CANCELLED', 'The job was cancelled.'))
    }
    return this.#snapshot(job)
  }

  addArtifacts(ownerId: string, jobId: string, artifacts: readonly ArtifactDescriptor[]): void {
    const job = this.#jobs.get(jobId)
    if (job === undefined || job.ownerId !== ownerId) {
      throw new McpCoreError('NOT_FOUND', 'Job was not found.')
    }
    const addedBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0)
    const allArtifacts = [...this.#jobs.values()].flatMap((candidate) => candidate.artifacts)
    const globalBytes = allArtifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0)
    const ownerBytes = [...this.#jobs.values()]
      .filter((candidate) => candidate.ownerId === ownerId)
      .flatMap((candidate) => candidate.artifacts)
      .reduce((sum, artifact) => sum + artifact.byteLength, 0)
    if (
      addedBytes > this.#config.limits.maxArtifactTotalBytes - globalBytes ||
      addedBytes > this.#config.limits.maxArtifactTotalBytesPerOwner - ownerBytes
    ) {
      throw new McpCoreError('RESOURCE_LIMIT', 'Artifact storage capacity is full.')
    }
    job.artifacts.push(...artifacts)
  }

  clearArtifacts(ownerId: string, jobId: string): void {
    const job = this.#jobs.get(jobId)
    if (job === undefined || job.ownerId !== ownerId) {
      throw new McpCoreError('NOT_FOUND', 'Job was not found.')
    }
    job.artifacts = []
  }

  readResourceSnapshot(ownerId: string, jobId: string): JobSnapshot {
    return this.get(ownerId, jobId)
  }

  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdownOwned()
    return this.#shutdownPromise
  }

  async #shutdownOwned(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#sweepTimer)
    for (const job of this.#jobs.values()) {
      if (job.state === 'queued') {
        job.cancelTriggered = true
        job.controller.abort(new McpCoreError('CANCELLED', 'The server is shutting down.'))
        job.state = 'cancelled'
        job.completedAt = Date.now()
        delete job.task
        this.#clearTimer(job)
      } else if (job.state === 'running') {
        job.cancelTriggered = true
        job.state = 'cancelling'
        job.controller.abort(new McpCoreError('CANCELLED', 'The server is shutting down.'))
      }
    }
    this.#queue.length = 0
    await Promise.all([...this.#running.values()].map((job) => this.#waitForTask(job)))
    for (const job of this.#jobs.values()) {
      if (job.artifacts.length === 0) continue
      job.artifacts = []
      await this.#scheduleCleanup(job.ownerId, job.id)
    }
    await Promise.all([...this.#cleanupTasks])
    if (this.#cleanupFailureCount > 0) {
      throw new McpCoreError('INTERNAL', 'Artifact cleanup failed.')
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new McpCoreError('CANCELLED', 'The server is shutting down.')
  }

  #ensureStoredCapacity(ownerId: string): void {
    this.#evictUntil(() => this.#jobs.size < this.#config.limits.maxStoredJobs)
    this.#evictUntil(
      () => this.#countOwner(ownerId) < this.#config.limits.maxStoredJobsPerOwner,
      ownerId,
    )
    if (
      this.#jobs.size >= this.#config.limits.maxStoredJobs ||
      this.#countOwner(ownerId) >= this.#config.limits.maxStoredJobsPerOwner
    ) {
      throw new McpCoreError('CAPACITY_LIMIT', 'Stored job capacity is full.', true)
    }
  }

  #ensureQueueCapacity(ownerId: string, queuedBytes: number): void {
    if (!Number.isSafeInteger(queuedBytes) || queuedBytes < 0) {
      throw new McpCoreError('INVALID_INPUT', 'Queued input size is invalid.')
    }
    const limits = this.#config.limits
    const inFlight = [...this.#jobs.values()].filter(
      (job) => job.state === 'queued' || job.state === 'running' || job.state === 'cancelling',
    )
    const ownerInFlight = inFlight.filter((job) => job.ownerId === ownerId)
    const globalBytes = inFlight.reduce((sum, job) => sum + job.queuedBytes, 0)
    const ownerBytes = ownerInFlight.reduce((sum, job) => sum + job.queuedBytes, 0)
    if (
      inFlight.filter((job) => job.state === 'queued').length >= limits.maxQueuedJobs ||
      ownerInFlight.filter((job) => job.state === 'queued').length >=
        limits.maxQueuedJobsPerOwner ||
      queuedBytes > limits.maxQueuedInputBytes - globalBytes ||
      queuedBytes > limits.maxQueuedInputBytesPerOwner - ownerBytes
    ) {
      throw new McpCoreError('CAPACITY_LIMIT', 'Job queue capacity is full.', true)
    }
  }

  #countOwner(ownerId: string): number {
    let count = 0
    for (const job of this.#jobs.values()) if (job.ownerId === ownerId) count += 1
    return count
  }

  #evictUntil(hasCapacity: () => boolean, ownerId?: string): void {
    if (hasCapacity()) return
    for (const job of this.#jobs.values()) {
      if (hasCapacity()) return
      if (ownerId !== undefined && job.ownerId !== ownerId) continue
      if (job.state === 'queued' || job.state === 'running' || job.state === 'cancelling') continue
      this.#jobs.delete(job.id)
      void this.#scheduleCleanup(job.ownerId, job.id).catch(() => this.#reportCleanupFailure())
    }
  }

  #pruneExpired(now: number): void {
    const ttl = this.#config.limits.jobTtlMs
    for (const job of this.#jobs.values()) {
      if (job.state === 'queued' || job.state === 'running' || job.state === 'cancelling') continue
      if (job.completedAt === undefined || now - job.completedAt < ttl) continue
      this.#jobs.delete(job.id)
      void this.#scheduleCleanup(job.ownerId, job.id).catch(() => this.#reportCleanupFailure())
    }
  }

  #scheduleCleanup(ownerId: string, jobId: string): Promise<void> {
    const cleanup = Promise.resolve()
      .then(() => this.#onEvict(ownerId, jobId))
      .catch(() => {
        this.#reportCleanupFailure()
      })
      .finally(() => this.#cleanupTasks.delete(cleanup))
    this.#cleanupTasks.add(cleanup)
    return cleanup
  }

  #reportCleanupFailure(): void {
    this.#cleanupFailureCount += 1
    try {
      this.#onCleanupFailure()
    } catch {
      console.error('MCP artifact cleanup failure reporter failed.')
    }
  }

  #onDeadline(job: QueuedJob): void {
    if (job.state === 'queued') {
      job.timeoutTriggered = true
      job.controller.abort(new McpCoreError('TIMEOUT', 'Job deadline exceeded.', true))
      job.state = 'failed'
      job.error = { code: 'TIMEOUT', message: 'Job deadline exceeded.', retryable: true }
      job.completedAt = Date.now()
      delete job.task
      this.#removeQueued(job.id)
      this.#clearTimer(job)
      this.#pump()
      return
    }
    if (job.state === 'running') {
      job.timeoutTriggered = true
      job.state = 'cancelling'
      job.controller.abort(new McpCoreError('TIMEOUT', 'Job deadline exceeded.', true))
    }
  }

  #pump(): void {
    if (this.#closed) return
    while (this.#running.size < this.#config.limits.maxActiveJobs) {
      const nextIndex = this.#queue.findIndex((id) => {
        const job = this.#jobs.get(id)
        return (
          job !== undefined &&
          job.state === 'queued' &&
          this.#activeForOwner(job.ownerId) < this.#config.limits.maxActiveJobsPerOwner
        )
      })
      if (nextIndex < 0) return
      const [id] = this.#queue.splice(nextIndex, 1)
      if (id === undefined) return
      const job = this.#jobs.get(id)
      if (job === undefined || job.state !== 'queued') continue
      if (Date.now() >= job.deadlineAt) {
        job.timeoutTriggered = true
        job.controller.abort(new McpCoreError('TIMEOUT', 'Job deadline exceeded.', true))
        job.state = 'failed'
        job.error = { code: 'TIMEOUT', message: 'Job deadline exceeded.', retryable: true }
        job.completedAt = Date.now()
        delete job.task
        this.#clearTimer(job)
        continue
      }
      if (job.controller.signal.aborted) {
        job.state = job.timeoutTriggered ? 'failed' : 'cancelled'
        this.#clearTimer(job)
        continue
      }
      job.state = 'running'
      this.#running.set(job.id, job)
      const task = this.#run(job)
      this.#runTasks.set(job.id, task)
      void task.then(
        () => this.#runTasks.delete(job.id),
        () => {
          this.#runTasks.delete(job.id)
          this.#reportCleanupFailure()
        },
      )
    }
  }

  #activeForOwner(ownerId: string): number {
    let count = 0
    for (const job of this.#running.values()) if (job.ownerId === ownerId) count += 1
    return count
  }

  async #run(job: QueuedJob): Promise<void> {
    try {
      const task = job.task
      delete job.task
      if (task === undefined) throw new McpCoreError('INTERNAL', 'Job task was unavailable.')
      const result = await task(job.id, job.controller.signal, job.deadlineAt)
      if (job.timeoutTriggered || Date.now() >= job.deadlineAt) {
        job.timeoutTriggered = true
        job.state = 'failed'
        job.error = { code: 'TIMEOUT', message: 'Job deadline exceeded.', retryable: true }
        job.completedAt = Date.now()
      } else if (job.cancelTriggered || job.controller.signal.aborted) {
        job.state = 'cancelled'
        job.error = { code: 'CANCELLED', message: 'The job was cancelled.', retryable: true }
        job.completedAt = Date.now()
      } else {
        const resultBytes = Buffer.byteLength(JSON.stringify(result))
        if (resultBytes > this.#config.limits.maxResultJsonBytes) {
          throw new McpCoreError('RESOURCE_LIMIT', 'Job result exceeds the configured size limit.')
        }
        job.result = result
        job.state = 'succeeded'
        job.completedAt = Date.now()
      }
    } catch (error) {
      if (job.timeoutTriggered || Date.now() >= job.deadlineAt) {
        job.timeoutTriggered = true
        job.state = 'failed'
        job.error = { code: 'TIMEOUT', message: 'Job deadline exceeded.', retryable: true }
        job.completedAt = Date.now()
      } else if (job.cancelTriggered || job.controller.signal.aborted) {
        job.state = 'cancelled'
        job.error = { code: 'CANCELLED', message: 'The job was cancelled.', retryable: true }
        job.completedAt = Date.now()
      } else {
        job.state = 'failed'
        job.error = safeError(error)
        job.completedAt = Date.now()
      }
    } finally {
      if (job.state !== 'succeeded' && job.artifacts.length > 0) {
        job.artifacts = []
        await this.#scheduleCleanup(job.ownerId, job.id)
      }
      this.#clearTimer(job)
      this.#running.delete(job.id)
      this.#pump()
    }
  }

  #waitForTask(job: QueuedJob): Promise<void> {
    return this.#runTasks.get(job.id) ?? Promise.resolve()
  }

  #snapshot(job: QueuedJob): JobSnapshot {
    return {
      id: job.id,
      state: job.state,
      operation: job.operation,
      createdAt: job.createdAt,
      deadlineAt: job.deadlineAt,
      artifacts: [...job.artifacts],
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
    }
  }

  #removeQueued(id: string): void {
    const index = this.#queue.indexOf(id)
    if (index >= 0) this.#queue.splice(index, 1)
  }

  #clearTimer(job: QueuedJob): void {
    if (job.timer !== undefined) {
      clearTimeout(job.timer)
      delete job.timer
    }
  }
}
