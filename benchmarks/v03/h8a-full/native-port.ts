import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClassifierError, assertActive } from '../../../src/entities/errors.js'
import type { H6Family, H6ProposalCandidate } from '../h6-context-composer.js'
import {
  H8A_FULL_FAMILY_CANDIDATES,
  H8A_FULL_MAX_NATIVE_ACTIVE,
  H8A_FULL_MAX_NATIVE_WAITING,
  H8A_FULL_MAX_ORIENTED_PIXELS,
  H8A_FULL_MAX_PACKED_MASK_BYTES,
  H8A_FULL_NATIVE_REQUEST_SCHEMA,
  H8A_FULL_RECIPE_ID,
  H8A_FULL_TOTAL_CANDIDATES,
} from './constants.js'
import {
  buildDinoPrompt,
  h8aAuthoredTargetSchema,
  parseNativeRequest,
  parseNativeResponse,
  parseNativeStdoutTrailer,
  type H8aNativeRequest,
  type H8aNativeResponse,
} from './contracts.js'
import { ZodError } from 'zod'
import {
  foregroundBounds,
  maskHasForeground,
  validatePackedMaskCopy,
  assertAggregatePackedWithinCap,
} from './mask-geometry.js'
import {
  buildNativeChildEnv,
  nativeFailure,
  runBoundedNativeChild,
} from './native-bounded-child.js'

const O_RDONLY_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
const MAX_NATIVE_RESPONSE_JSON_BYTES = 4 * 1024 * 1024

export interface H8aFullNativePortOptions {
  pythonExecutable: string
  assetRoot: string
  artifactRoot: string
  workerScriptPath: string
  cleanupTaskDirectory?: (taskDir: string) => Promise<void>
}

export interface H8aNativeGenerationInput {
  authoredTarget: string
  sourcePath: string
  sourceSha256: string
  width: number
  height: number
  deadlineAt: number
  signal: AbortSignal
}

export interface H8aNativeGenerationOutput {
  families: Record<H6Family, readonly H6ProposalCandidate[]>
  detectorPrompt: string
}

interface JobSnapshot {
  authoredTarget: string
  sourcePath: string
  sourceSha256: string
  width: number
  height: number
  deadlineAt: number
}

type QueueJobState = 'waiting' | 'active' | 'done'

interface QueueJob {
  id: string
  snapshot: JobSnapshot
  resolve(value: H8aNativeGenerationOutput): void
  reject(error: unknown): void
  abortController: AbortController
  callerSignal: AbortSignal
  state: QueueJobState
  deadlineTimer: ReturnType<typeof setTimeout> | undefined
  onCallerAbort: (() => void) | undefined
}

export class H8aFullNativePort {
  readonly #pythonExecutable: string
  readonly #assetRoot: string
  readonly #artifactRoot: string
  readonly #workerScriptPath: string
  readonly #cleanupTaskDirectory: ((taskDir: string) => Promise<void>) | undefined
  readonly #waiting: QueueJob[] = []
  readonly #physicalJobs = new Set<Promise<void>>()
  #active = 0
  #disposed = false

  constructor(options: H8aFullNativePortOptions) {
    if (
      !options.pythonExecutable ||
      !options.assetRoot ||
      !options.artifactRoot ||
      !options.workerScriptPath
    )
      throw new ClassifierError('INVALID_INPUT', 'H8a native port requires explicit runtime paths')
    this.#pythonExecutable = options.pythonExecutable
    this.#assetRoot = resolve(options.assetRoot)
    this.#artifactRoot = resolve(options.artifactRoot)
    this.#workerScriptPath = resolve(options.workerScriptPath)
    this.#cleanupTaskDirectory = options.cleanupTaskDirectory
  }

  async generate(input: H8aNativeGenerationInput): Promise<H8aNativeGenerationOutput> {
    if (this.#disposed) throw new ClassifierError('DISPOSED', 'H8a native port is disposed')
    const captured = captureNativePortEnqueueSnapshot(input)
    const snapshot = captured.snapshot
    const callerSignal = captured.callerSignal
    if (performance.now() >= snapshot.deadlineAt) throw deadlineExceeded()
    if (callerSignal.aborted) throw cancelled(callerSignal.reason)
    if (this.#countWaiting() >= H8A_FULL_MAX_NATIVE_WAITING)
      throw new ClassifierError('CAPACITY', 'H8a native queue is full')
    const probeRequestId = randomUUID()
    try {
      parseNativeRequest(
        buildNativeRequestPayload(snapshot, probeRequestId, this.#artifactRoot, this.#assetRoot),
      )
    } catch (error) {
      throw invalidNativeInput('native generation input invalid', error)
    }

    let resolve!: (value: H8aNativeGenerationOutput) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<H8aNativeGenerationOutput>((yes, no) => {
      resolve = yes
      reject = no
    })

    const abortController = new AbortController()
    const job: QueueJob = {
      id: randomUUID(),
      snapshot,
      resolve,
      reject,
      abortController,
      callerSignal,
      state: 'waiting',
      deadlineTimer: undefined,
      onCallerAbort: undefined,
    }
    const onCallerAbort = () => {
      abortController.abort(callerSignal.reason)
      if (job.state === 'waiting') this.#finish(job, cancelled(callerSignal.reason))
    }
    job.onCallerAbort = onCallerAbort
    if (callerSignal.aborted) throw cancelled(callerSignal.reason)
    callerSignal.addEventListener('abort', onCallerAbort, { once: true })

    this.#waiting.push(job)
    this.#armWaitingDeadline(job)
    this.#pump()

    try {
      return await promise
    } finally {
      if (job.onCallerAbort) callerSignal.removeEventListener('abort', job.onCallerAbort)
      this.#clearJobDeadlineTimer(job)
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      if (this.#physicalJobs.size > 0) await Promise.all([...this.#physicalJobs])
      return
    }
    this.#disposed = true
    for (const job of [...this.#waiting]) {
      this.#clearJobDeadlineTimer(job)
      if (job.state === 'waiting') {
        job.abortController.abort(undefined)
        this.#finish(job, cancelled(undefined))
      }
    }
    for (const job of this.#collectActiveJobs()) {
      job.abortController.abort(undefined)
    }
    if (this.#physicalJobs.size > 0) await Promise.all([...this.#physicalJobs])
  }

  #collectActiveJobs(): QueueJob[] {
    return this.#waiting.filter((entry) => entry.state === 'active')
  }

  #countWaiting(): number {
    return this.#waiting.filter((entry) => entry.state === 'waiting').length
  }

  #clearJobDeadlineTimer(job: QueueJob): void {
    if (job.deadlineTimer === undefined) return
    clearTimeout(job.deadlineTimer)
    job.deadlineTimer = undefined
  }

  #armWaitingDeadline(job: QueueJob): void {
    this.#clearJobDeadlineTimer(job)
    if (job.state !== 'waiting') return
    const delay = job.snapshot.deadlineAt - performance.now()
    if (delay <= 0) {
      job.abortController.abort(deadlineExceeded())
      this.#finish(job, deadlineExceeded())
      return
    }
    job.deadlineTimer = setTimeout(() => {
      job.deadlineTimer = undefined
      if (job.state !== 'waiting') return
      job.abortController.abort(deadlineExceeded())
      this.#finish(job, deadlineExceeded())
    }, delay)
  }

  #pump(): void {
    while (!this.#disposed && this.#active < H8A_FULL_MAX_NATIVE_ACTIVE) {
      const index = this.#waiting.findIndex((entry) => entry.state === 'waiting')
      if (index < 0) return
      const job = this.#waiting[index]
      if (!job) return
      if (job.abortController.signal.aborted) {
        this.#finish(job, cancelled(job.abortController.signal.reason))
        continue
      }
      if (performance.now() >= job.snapshot.deadlineAt) {
        this.#finish(job, deadlineExceeded())
        continue
      }
      job.state = 'active'
      this.#clearJobDeadlineTimer(job)
      this.#active++
      const physical = this.#runJob(job)
        .catch((error: unknown) => {
          if (job.state !== 'done') this.#finish(job, error)
        })
        .finally(() => {
          this.#physicalJobs.delete(physical)
          this.#active--
          this.#pump()
        })
      this.#physicalJobs.add(physical)
    }
  }

  #workerCommand(): string {
    if (this.#workerScriptPath.endsWith('.mjs')) return process.execPath
    return this.#pythonExecutable
  }

  async #runJob(job: QueueJob): Promise<void> {
    const snapshot = job.snapshot
    const request = parseNativeRequest(
      buildNativeRequestPayload(snapshot, job.id, this.#artifactRoot, this.#assetRoot),
    )
    const taskDir = request.task_dir
    let output: H8aNativeGenerationOutput | undefined
    let failure: unknown
    try {
      assertActive(job.abortController.signal)
      if (performance.now() >= snapshot.deadlineAt) throw deadlineExceeded()
      await mkdir(taskDir, { recursive: true })
      if (performance.now() >= snapshot.deadlineAt) throw deadlineExceeded()
      const requestPath = join(taskDir, 'request.json')
      await writeFile(requestPath, JSON.stringify(request), 'utf8')
      if (performance.now() >= snapshot.deadlineAt) throw deadlineExceeded()
      const child = await runBoundedNativeChild({
        command: this.#workerCommand(),
        args: [this.#workerScriptPath, '--generate', requestPath],
        env: buildNativeChildEnv(taskDir),
        deadlineAt: snapshot.deadlineAt,
        signal: job.abortController.signal,
        taskTempDir: taskDir,
      })
      if (child.status !== 'complete') {
        if (child.status === 'cancelled') throw cancelled(job.abortController.signal.reason)
        if (child.status === 'timeout') throw deadlineExceeded()
        throw nativeFailure(child.errorMessage ?? `native child ${child.status}`)
      }
      const trailerLine = child.stdout.toString('utf8').trim().split('\n').at(-1)
      if (!trailerLine) throw nativeFailure('native child stdout trailer missing')
      parseNativeStdoutTrailer(
        parseWorkerJson(trailerLine, 'native child stdout trailer JSON invalid'),
      )
      const responseRaw = await readBoundedJsonFile(
        join(taskDir, 'native-response.json'),
        MAX_NATIVE_RESPONSE_JSON_BYTES,
        job.abortController.signal,
      )
      const response = parseNativeResponse(
        parseWorkerJson(responseRaw.toString('utf8'), 'native response JSON invalid'),
      )
      this.#assertMandatoryResponseIdentity(response, snapshot, job.id)
      if (response.status !== 'complete')
        throw nativeFailure(response.error ?? 'native generation failed')
      this.#assertCompleteResponseIdentity(response, snapshot, job.id)
      if (
        response.status === 'complete' &&
        response.detector_prompt !== undefined &&
        response.detector_prompt !== buildDinoPrompt(snapshot.authoredTarget)
      )
        throw nativeFailure('native response detector prompt does not match authored target')
      this.#validateFamilyStructure(response, snapshot)
      const families = await this.#loadFamilies(
        response,
        snapshot,
        taskDir,
        job.abortController.signal,
      )
      output = {
        families,
        detectorPrompt: response.detector_prompt ?? buildDinoPrompt(snapshot.authoredTarget),
      }
    } catch (error) {
      failure = normalizeWorkerSideError(error)
    } finally {
      try {
        if (this.#cleanupTaskDirectory) await this.#cleanupTaskDirectory(taskDir)
        else await rm(taskDir, { recursive: true, force: true })
      } catch (error) {
        failure = nativeFailure(
          error instanceof Error ? error.message : 'native task directory cleanup failed',
          error,
        )
      }
      if (failure && output) {
        for (const family of ['D', 'U'] as const) {
          for (const candidate of output.families[family]) candidate.mask.data.fill(0)
        }
      }
      if (performance.now() >= snapshot.deadlineAt && !failure) failure = deadlineExceeded()
      if (failure) this.#finish(job, failure)
      else if (output) this.#finish(job, undefined, output)
      else this.#finish(job, nativeFailure('native job finished without result'))
    }
  }

  #assertMandatoryResponseIdentity(
    response: H8aNativeResponse,
    snapshot: JobSnapshot,
    requestId: string,
  ): void {
    if (response.request_id !== requestId)
      throw nativeFailure('native response request_id mismatch')
    if (response.recipe_id !== H8A_FULL_RECIPE_ID)
      throw nativeFailure('native response recipe_id mismatch')
    if (response.source_sha256 !== snapshot.sourceSha256)
      throw nativeFailure('native response source digest mismatch request')
  }

  #assertCompleteResponseIdentity(
    response: Extract<H8aNativeResponse, { status: 'complete' }>,
    snapshot: JobSnapshot,
    requestId: string,
  ): void {
    this.#assertMandatoryResponseIdentity(response, snapshot, requestId)
    if (response.width !== snapshot.width || response.height !== snapshot.height)
      throw nativeFailure('native response dimensions mismatch request')
    if (response.authored_target !== snapshot.authoredTarget)
      throw nativeFailure('native response authored target mismatch request')
  }

  #validateFamilyStructure(
    response: Extract<H8aNativeResponse, { status: 'complete' }>,
    snapshot: JobSnapshot,
  ): void {
    const perMaskBytes = expectedPackedMaskBytes(snapshot.width, snapshot.height)
    const seenIds = new Set<string>()
    let declaredTotal = 0
    let totalCandidates = 0
    for (const family of ['D', 'U'] as const) {
      const entries = response.families[family]
      if (entries.length > H8A_FULL_FAMILY_CANDIDATES)
        throw nativeFailure('native response family candidate cap exceeded')
      entries.forEach((entry, index) => {
        totalCandidates++
        const canonicalId = `${family}${String(index).padStart(2, '0')}`
        if (entry.id !== canonicalId)
          throw nativeFailure('native response candidate id is not canonical')
        if (entry.ordinal !== index)
          throw nativeFailure('native response candidate ordinal mismatch index')
        if (entry.family !== family)
          throw nativeFailure('native response candidate family mismatch')
        if (seenIds.has(entry.id))
          throw nativeFailure('native response candidate ids must be unique')
        seenIds.add(entry.id)
        if (entry.packed_bytes !== perMaskBytes)
          throw nativeFailure('native response packed_bytes mismatch geometry')
        declaredTotal += entry.packed_bytes
        const expectedPath = resolve(
          this.expectedPackedMaskPath(response.request_id, family, index),
        )
        const packedPath = resolve(entry.packed_path)
        if (packedPath !== expectedPath)
          throw nativeFailure('packed mask path is not the owned task path')
      })
    }
    if (totalCandidates > H8A_FULL_TOTAL_CANDIDATES)
      throw nativeFailure('native response total candidate cap exceeded')
    if (response.packed_mask_bytes_total !== declaredTotal)
      throw nativeFailure('native response packed_mask_bytes_total mismatch')
    if (declaredTotal > H8A_FULL_MAX_PACKED_MASK_BYTES)
      throw nativeFailure('aggregate packed mask bytes exceed cap')
    assertAggregatePackedWithinCap(snapshot.width, snapshot.height, totalCandidates)
  }

  expectedPackedMaskPath(requestId: string, family: H6Family, ordinal: number): string {
    const id = `${family}${String(ordinal).padStart(2, '0')}`
    return join(this.#artifactRoot, 'h8a-full-tasks', requestId, 'packed-masks', `${id}.bin`)
  }

  async #loadFamilies(
    response: Extract<H8aNativeResponse, { status: 'complete' }>,
    snapshot: JobSnapshot,
    taskDir: string,
    signal: AbortSignal,
  ): Promise<Record<H6Family, readonly H6ProposalCandidate[]>> {
    const families: Record<H6Family, H6ProposalCandidate[]> = { D: [], U: [] }
    const taskRoot = resolve(taskDir)
    try {
      for (const family of ['D', 'U'] as const) {
        for (const entry of response.families[family]) {
          const packedPath = assertTaskContainedPath(taskRoot, entry.packed_path)
          const packedBytes = await readBoundedVerifiedFile(
            packedPath,
            entry.packed_bytes,
            entry.packed_sha256,
            H8A_FULL_MAX_PACKED_MASK_BYTES,
            signal,
          )
          try {
            const mask = validatePackedMaskCopy(
              {
                format: 'binary-lsb0',
                width: snapshot.width,
                height: snapshot.height,
                data: new Uint8Array(packedBytes),
              },
              snapshot.width,
              snapshot.height,
            )
            const hasForeground = maskHasForeground(mask)
            if (entry.empty !== !hasForeground)
              throw nativeFailure('packed mask empty flag mismatch')
            if (!entry.empty) {
              const bounds = foregroundBounds(mask)
              if (!bounds) throw nativeFailure('non-empty packed mask missing foreground bounds')
              if (entry.mask_box_xyxy) {
                const [x0, y0, x1, y1] = entry.mask_box_xyxy
                const expected = [
                  bounds.left,
                  bounds.top,
                  bounds.left + bounds.width,
                  bounds.top + bounds.height,
                ]
                if (
                  x0 !== expected[0] ||
                  y0 !== expected[1] ||
                  x1 !== expected[2] ||
                  y1 !== expected[3]
                )
                  throw nativeFailure('packed mask bounds mismatch recomputed foreground')
              }
              families[family].push({ id: entry.id, mask })
            } else {
              mask.data.fill(0)
            }
          } finally {
            packedBytes.fill(0)
          }
        }
      }
      return families
    } catch (error) {
      for (const family of ['D', 'U'] as const) {
        for (const candidate of families[family]) candidate.mask.data.fill(0)
      }
      throw error
    }
  }

  #finish(job: QueueJob, error?: unknown, value?: H8aNativeGenerationOutput): void {
    if (job.state === 'done') return
    this.#clearJobDeadlineTimer(job)
    job.state = 'done'
    if (error) job.reject(error)
    else if (value) job.resolve(value)
    else job.reject(new ClassifierError('PROVIDER', 'native job finished without result'))
    const index = this.#waiting.indexOf(job)
    if (index >= 0) this.#waiting.splice(index, 1)
  }
}

function captureNativePortEnqueueSnapshot(input: H8aNativeGenerationInput): {
  snapshot: JobSnapshot
  callerSignal: AbortSignal
} {
  validateNativePortEnqueueInput(input)
  return {
    snapshot: {
      authoredTarget: input.authoredTarget,
      sourcePath: input.sourcePath,
      sourceSha256: input.sourceSha256,
      width: input.width,
      height: input.height,
      deadlineAt: input.deadlineAt,
    },
    callerSignal: input.signal,
  }
}

function validateNativePortEnqueueInput(input: H8aNativeGenerationInput): void {
  if (!input || typeof input !== 'object')
    throw invalidNativeInput('native generation input must be an object')
  if (!(input.signal instanceof AbortSignal))
    throw invalidNativeInput('native generation input requires AbortSignal')
  if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= 0)
    throw invalidNativeInput('native generation input requires finite positive absolute deadline')
  try {
    h8aAuthoredTargetSchema.parse(input.authoredTarget)
  } catch (error) {
    throw invalidNativeInput('native generation authored target invalid', error)
  }
  if (typeof input.sourcePath !== 'string' || !input.sourcePath)
    throw invalidNativeInput('native generation source path invalid')
  if (typeof input.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sourceSha256))
    throw invalidNativeInput('native generation source digest invalid')
  if (
    !Number.isSafeInteger(input.width) ||
    input.width <= 0 ||
    !Number.isSafeInteger(input.height) ||
    input.height <= 0
  )
    throw invalidNativeInput('native generation dimensions invalid')
  if (input.width * input.height > H8A_FULL_MAX_ORIENTED_PIXELS)
    throw invalidNativeInput('oriented pixel cap exceeded')
}

function invalidNativeInput(message: string, cause?: unknown): ClassifierError {
  return new ClassifierError('INVALID_INPUT', message, cause === undefined ? {} : { cause })
}

function normalizeWorkerSideError(error: unknown): ClassifierError {
  if (error instanceof ClassifierError) {
    if (error.code === 'ABORTED' || error.code === 'TIMEOUT') return error
    return error
  }
  if (error instanceof ZodError) return nativeFailure('native response schema invalid', error)
  const message = error instanceof Error ? error.message : 'native worker failed'
  return nativeFailure(message, error)
}

function parseWorkerJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw nativeFailure(message, error)
  }
}

function buildNativeRequestPayload(
  snapshot: JobSnapshot,
  requestId: string,
  artifactRoot: string,
  assetRoot: string,
): H8aNativeRequest {
  return {
    schema: H8A_FULL_NATIVE_REQUEST_SCHEMA,
    request_id: requestId,
    recipe_id: H8A_FULL_RECIPE_ID,
    authored_target: snapshot.authoredTarget,
    task_dir: join(artifactRoot, 'h8a-full-tasks', requestId),
    assets_dir: assetRoot,
    source_path: snapshot.sourcePath,
    source_sha256: snapshot.sourceSha256,
    width: snapshot.width,
    height: snapshot.height,
  }
}

function expectedPackedMaskBytes(width: number, height: number): number {
  return Math.ceil((width * height) / 8)
}

function assertTaskContainedPath(taskDir: string, candidatePath: string): string {
  const resolved = resolve(candidatePath)
  const root = resolve(taskDir)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
    throw nativeFailure('packed mask path escaped task directory')
  return resolved
}

async function readBoundedJsonFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  assertActive(signal)
  const handle = await openNativeBoundedFile(path)
  try {
    const stat = await handle.stat()
    assertActive(signal)
    if (!stat.isFile()) throw nativeFailure('native response path is not a regular file')
    if (stat.size < 1 || stat.size > maxBytes)
      throw nativeFailure('native response JSON exceeds cap')
    return await readExactFromHandle(handle, stat.size, signal)
  } finally {
    await handle.close()
  }
}

async function readBoundedVerifiedFile(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  assertActive(signal)
  if (expectedSize > maxBytes) throw nativeFailure('packed mask exceeds per-file cap')
  const handle = await openNativeBoundedFile(path)
  try {
    const stat = await handle.stat()
    assertActive(signal)
    if (!stat.isFile()) throw nativeFailure('packed mask path is not a regular file')
    if (stat.size !== expectedSize) throw nativeFailure('packed mask on-disk size mismatch')
    const bytes = await readExactFromHandle(handle, expectedSize, signal)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== expectedSha256) throw nativeFailure('packed mask digest mismatch')
    return bytes
  } finally {
    await handle.close()
  }
}

async function openNativeBoundedFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, O_RDONLY_NOFOLLOW)
  } catch (error) {
    throw nativeFailure(
      error instanceof Error ? error.message : 'native bounded file open failed',
      error,
    )
  }
}

async function readExactFromHandle(
  handle: FileHandle,
  expectedSize: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedSize + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    assertActive(signal)
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== expectedSize) throw nativeFailure('bounded file read size mismatch')
  const extra = Buffer.alloc(1)
  assertActive(signal)
  const { bytesRead: extraRead } = await handle.read(extra, 0, 1, expectedSize)
  if (extraRead !== 0) throw nativeFailure('bounded file has trailing bytes')
  return buffer.subarray(0, expectedSize)
}

function cancelled(reason: unknown): ClassifierError {
  if (reason instanceof ClassifierError) return reason
  return new ClassifierError('ABORTED', 'H8a native operation cancelled', { cause: reason })
}

function deadlineExceeded(): ClassifierError {
  return new ClassifierError('TIMEOUT', 'H8a native absolute deadline exceeded')
}

export function defaultWorkerScriptPath(): string {
  return fileURLToPath(new URL('./native-worker.py', import.meta.url))
}

export function fakeWorkerScriptPath(): string {
  return fileURLToPath(new URL('./fake-native-worker.mjs', import.meta.url))
}
