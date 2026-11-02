import { randomUUID } from 'node:crypto'
import type { ArtifactDescriptor, ArtifactPort, ArtifactRole } from '../contracts.js'
import { McpCoreError } from '../errors.js'

export interface PrivateArtifactStoreOptions {
  readonly maxGlobalBytes?: number
  readonly maxOwnerBytes?: number
  readonly maxArtifactBytes?: number
  readonly maxArtifacts?: number
  readonly maxArtifactsPerOwner?: number
  readonly ttlMs?: number
  readonly maxConcurrentReads?: number
}

export interface PrivateArtifactStore extends ArtifactPort {
  putUpload(input: {
    readonly ownerId: string
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }): Promise<ArtifactDescriptor>
  readUploaded(input: {
    readonly ownerId: string
    readonly id: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
    readonly maxBytes: number
  }): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>
  dispose(): Promise<void>
}

interface StoredArtifact {
  readonly descriptor: ArtifactDescriptor
  readonly ownerId: string
  readonly jobId: string
  readonly bytes: Buffer
}

const DEFAULTS = {
  maxGlobalBytes: 256 * 1024 * 1024,
  maxOwnerBytes: 32 * 1024 * 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxArtifacts: 4_096,
  maxArtifactsPerOwner: 256,
  ttlMs: 60 * 60 * 1000,
  maxConcurrentReads: 32,
} as const

function assertLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new McpCoreError('INVALID_INPUT', 'Private artifact store limit is invalid.')
}

function checkRequest(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted) throw new McpCoreError('CANCELLED', 'Artifact operation was cancelled.', true)
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)
    throw new McpCoreError('TIMEOUT', 'Artifact operation deadline expired.', true)
}

/** Bounded process-memory store. Contents expire on TTL or process shutdown and are never written to disk. */
export function createPrivateArtifactStore(
  options: PrivateArtifactStoreOptions = {},
): PrivateArtifactStore {
  const limits = { ...DEFAULTS, ...options }
  assertLimit(limits.maxGlobalBytes, 4 * 1024 * 1024 * 1024)
  assertLimit(limits.maxOwnerBytes, limits.maxGlobalBytes)
  assertLimit(limits.maxArtifactBytes, limits.maxOwnerBytes)
  assertLimit(limits.maxArtifacts, 1_000_000)
  assertLimit(limits.maxArtifactsPerOwner, limits.maxArtifacts)
  assertLimit(limits.ttlMs, 24 * 60 * 60 * 1000)
  assertLimit(limits.maxConcurrentReads, 4096)
  const records = new Map<string, StoredArtifact>()
  const ownedBytes = new Map<string, number>()
  let totalBytes = 0
  let activeReads = 0
  let closed = false

  const remove = (id: string): void => {
    const record = records.get(id)
    if (!record) return
    records.delete(id)
    totalBytes -= record.bytes.byteLength
    const remaining = (ownedBytes.get(record.ownerId) ?? 0) - record.bytes.byteLength
    if (remaining <= 0) ownedBytes.delete(record.ownerId)
    else ownedBytes.set(record.ownerId, remaining)
    record.bytes.fill(0)
  }
  const sweepExpired = (now: number): void => {
    for (const [id, record] of records) if (record.descriptor.expiresAt <= now) remove(id)
  }
  const expiryTimer = setInterval(() => sweepExpired(Date.now()), Math.min(limits.ttlMs, 60_000))
  expiryTimer.unref()
  const ensureAvailable = (ownerId: string, size: number, now: number): void => {
    if (closed) throw new McpCoreError('DISPOSED', 'Artifact store is closed.', true)
    sweepExpired(now)
    const ownerCount = [...records.values()].filter((record) => record.ownerId === ownerId).length
    if (
      size < 1 ||
      size > limits.maxArtifactBytes ||
      records.size >= limits.maxArtifacts ||
      ownerCount >= limits.maxArtifactsPerOwner ||
      totalBytes + size > limits.maxGlobalBytes ||
      (ownedBytes.get(ownerId) ?? 0) + size > limits.maxOwnerBytes
    ) {
      throw new McpCoreError('CAPACITY_LIMIT', 'Private artifact capacity is unavailable.', true)
    }
  }
  const insert = async (input: {
    readonly ownerId: string
    readonly jobId: string
    readonly role: ArtifactRole
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly expiresAt: number
    readonly width?: number
    readonly height?: number
    readonly encoding?: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }): Promise<ArtifactDescriptor> => {
    checkRequest(input.signal, input.deadlineAt)
    const now = Date.now()
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1) {
      throw new McpCoreError('INVALID_INPUT', 'Private artifact bytes are invalid.')
    }
    if (input.bytes.byteLength > limits.maxArtifactBytes)
      throw new McpCoreError(
        'RESOURCE_LIMIT',
        'Private artifact exceeds its configured byte limit.',
      )
    if (
      !input.ownerId ||
      !input.jobId ||
      !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,63}$/u.test(
        input.mediaType,
      ) ||
      !Number.isFinite(input.expiresAt) ||
      input.expiresAt <= now ||
      input.expiresAt > now + limits.ttlMs + 1_000 ||
      (input.width !== undefined &&
        (!Number.isSafeInteger(input.width) || input.width < 1 || input.width > 16_777_216)) ||
      (input.height !== undefined &&
        (!Number.isSafeInteger(input.height) || input.height < 1 || input.height > 16_777_216)) ||
      (input.width !== undefined &&
        input.height !== undefined &&
        input.width * input.height > 16_777_216) ||
      (input.encoding !== undefined && !/^[a-zA-Z0-9._-]{1,64}$/u.test(input.encoding))
    ) {
      throw new McpCoreError('INVALID_INPUT', 'Private artifact metadata is invalid.')
    }
    ensureAvailable(input.ownerId, input.bytes.byteLength, now)
    const owned = Buffer.from(input.bytes)
    const id = randomUUID().replace(/-/gu, '')
    const descriptor: ArtifactDescriptor = {
      id,
      role: input.role,
      mediaType: input.mediaType,
      byteLength: owned.byteLength,
      expiresAt: Math.min(input.expiresAt, now + limits.ttlMs),
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.encoding === undefined ? {} : { encoding: input.encoding }),
    }
    records.set(id, { descriptor, ownerId: input.ownerId, jobId: input.jobId, bytes: owned })
    totalBytes += owned.byteLength
    ownedBytes.set(input.ownerId, (ownedBytes.get(input.ownerId) ?? 0) + owned.byteLength)
    return descriptor
  }

  const read = async (
    ownerId: string,
    artifactId: string,
    signal: AbortSignal,
    deadlineAt: number,
    maxBytes: number,
  ) => {
    checkRequest(signal, deadlineAt)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new McpCoreError('INVALID_INPUT', 'Artifact read byte limit is invalid.')
    sweepExpired(Date.now())
    const record = records.get(artifactId)
    if (!record || record.ownerId !== ownerId || record.bytes.byteLength > maxBytes)
      throw new McpCoreError('NOT_FOUND', 'Private artifact was not found.')
    if (activeReads >= limits.maxConcurrentReads)
      throw new McpCoreError(
        'CAPACITY_LIMIT',
        'Private artifact read capacity is unavailable.',
        true,
      )
    activeReads += 1
    try {
      const bytes = Uint8Array.from(record.bytes)
      try {
        checkRequest(signal, deadlineAt)
        return { bytes, mediaType: record.descriptor.mediaType }
      } catch (error) {
        bytes.fill(0)
        throw error
      }
    } finally {
      activeReads -= 1
    }
  }

  return {
    put: insert,
    async putUpload(input) {
      const id = randomUUID().replace(/-/gu, '')
      return insert({
        ...input,
        jobId: `upload-${id}`,
        role: 'source',
        expiresAt: Date.now() + limits.ttlMs,
      })
    },
    async read(input) {
      return read(input.ownerId, input.artifactId, input.signal, input.deadlineAt, input.maxBytes)
    },
    async readUploaded(input) {
      return read(input.ownerId, input.id, input.signal, input.deadlineAt, input.maxBytes)
    },
    async deleteJob(input) {
      // Cleanup is physical ownership release and must finish even after a job aborts.
      for (const [id, record] of records)
        if (record.ownerId === input.ownerId && record.jobId === input.jobId) remove(id)
    },
    async deleteOwner(ownerId) {
      for (const [id, record] of records) if (record.ownerId === ownerId) remove(id)
    },
    async dispose() {
      clearInterval(expiryTimer)
      closed = true
      for (const id of records.keys()) remove(id)
    },
  }
}
