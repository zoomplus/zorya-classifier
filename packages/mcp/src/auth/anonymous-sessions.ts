import { createHash, randomBytes } from 'node:crypto'
import { McpCoreError } from '../errors.js'
import type { AnonymousSessionPort, Principal } from '../contracts.js'

export interface AnonymousSessionOptions {
  readonly maxSessions: number
  readonly ttlMs: number
  readonly maxJobsPerSessionPerDay: number
  readonly maxJobsGloballyPerDay: number
  readonly now?: () => number
  readonly token?: () => string
}

interface SessionRecord {
  readonly ownerId: string
  readonly expiresAt: number
  day: number
  jobsToday: number
}

/** Краткоживущие capability-сессии в памяти процесса; сохраняются только хэши токенов. */
export class AnonymousSessionStore implements AnonymousSessionPort {
  readonly #options: AnonymousSessionOptions
  readonly #sessions = new Map<string, SessionRecord>()
  #globalDay = 0
  #globalJobsToday = 0

  constructor(options: AnonymousSessionOptions) {
    if (
      !Number.isSafeInteger(options.maxSessions) ||
      options.maxSessions < 1 ||
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs < 60_000 ||
      !Number.isSafeInteger(options.maxJobsPerSessionPerDay) ||
      options.maxJobsPerSessionPerDay < 1 ||
      !Number.isSafeInteger(options.maxJobsGloballyPerDay) ||
      options.maxJobsGloballyPerDay < 1
    )
      throw new Error('Anonymous session limits are invalid.')
    this.#options = options
  }

  open(): { readonly token: string; readonly expiresAt: number } {
    this.#expire()
    if (this.#sessions.size >= this.#options.maxSessions)
      throw new McpCoreError('CAPACITY_LIMIT', 'Anonymous session capacity is full.', true)
    const token = (this.#options.token ?? (() => randomBytes(32).toString('base64url')))()
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('Session token generator is invalid.')
    const hash = this.#hash(token)
    if (this.#sessions.has(hash)) throw new Error('Session token collision.')
    const now = this.#now()
    const ownerId = `anon-${randomBytes(24).toString('base64url')}`
    this.#sessions.set(hash, {
      ownerId,
      expiresAt: now + this.#options.ttlMs,
      day: Math.floor(now / 86_400_000),
      jobsToday: 0,
    })
    return { token, expiresAt: now + this.#options.ttlMs }
  }

  resolve(token: unknown): Principal {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token))
      throw new McpCoreError('FORBIDDEN', 'A valid anonymous session is required.')
    this.#expire()
    const record = this.#sessions.get(this.#hash(token))
    if (!record) throw new McpCoreError('FORBIDDEN', 'The anonymous session is unavailable.')
    return { ownerId: record.ownerId, transport: 'http', access: 'anonymous-capability' }
  }

  recordSubmission(token: string): void {
    const principal = this.resolve(token)
    const record = this.#sessions.get(this.#hash(token))
    if (!record || record.ownerId !== principal.ownerId)
      throw new McpCoreError('FORBIDDEN', 'The anonymous session is unavailable.')
    const day = Math.floor(this.#now() / 86_400_000)
    if (day !== record.day) {
      record.day = day
      record.jobsToday = 0
    }
    if (day !== this.#globalDay) {
      this.#globalDay = day
      this.#globalJobsToday = 0
    }
    if (
      record.jobsToday >= this.#options.maxJobsPerSessionPerDay ||
      this.#globalJobsToday >= this.#options.maxJobsGloballyPerDay
    )
      throw new McpCoreError(
        'CAPACITY_LIMIT',
        'The configured anonymous job limit was reached.',
        true,
      )
    record.jobsToday += 1
    this.#globalJobsToday += 1
  }

  close(): void {
    this.#sessions.clear()
  }

  #expire(): void {
    const now = this.#now()
    for (const [hash, record] of this.#sessions) {
      if (record.expiresAt <= now) this.#sessions.delete(hash)
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  #hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
  }
}
