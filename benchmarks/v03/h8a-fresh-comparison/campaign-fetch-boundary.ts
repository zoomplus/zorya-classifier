import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CampaignLedger } from './campaign-ledger.js'
import {
  finalizeObservedPhysicalDispatch,
  invokeInjectedWork,
  PhysicalDispatchConfirmFailedError,
} from './physical-dispatch.js'
import type { H8aFreshProfileId } from './profiles.js'

const costSchema = z
  .object({
    usage: z
      .object({ cost: z.number().finite().nonnegative().nullable().optional() })
      .nullable()
      .optional(),
  })
  .passthrough()

const MAX_COST_RECEIPT_BYTES = 8 * 1024 * 1024

export interface RecordedProviderCall {
  physicalId: number
  logicalId: number
  requestSha256: string
  requestBodySha256: string
}

export interface CampaignFetchJournalEntry {
  reservationId: number
  physicalId: number | null
  profileId: H8aFreshProfileId
  opaqueCaseId: string
  caseExecutionIdentitySha256: string
  logicalId: number
  recorderPhysicalId: number
  requestSha256: string
  requestBodySha256: string
  endpoint: '/api/v1/chat/completions' | '/api/alpha/decisions'
  dispatchState: 'confirmed' | 'uncertain'
  settled: boolean
  costUsd: number | null
  httpStatus: number | null
  errorCode?: string
}

interface CampaignFetchBoundaryOptions {
  ledger: CampaignLedger
  reservedUsd: number
  profileId: H8aFreshProfileId
  opaqueCaseId: string
  caseExecutionIdentitySha256: string
  endpoint: CampaignFetchJournalEntry['endpoint']
  journalDirectory: string
  baseFetch: typeof globalThis.fetch
  readCurrentProviderCall: () => RecordedProviderCall | undefined
  journalEntries?: CampaignFetchJournalEntry[]
  signal?: AbortSignal
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const value = Reflect.get(error, 'code')
    if (typeof value === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(value)) return value
    return error.name.slice(0, 80) || 'ERROR'
  }
  return 'UNKNOWN_ERROR'
}

function requestBodyHash(init: RequestInit | undefined): string {
  const body = init?.body
  if (typeof body === 'string') return sha256(body)
  if (body instanceof Uint8Array) return sha256(Buffer.from(body).toString('base64'))
  throw new TypeError('Campaign fetch requires a pre-serialized JSON request body')
}

function requestEndpoint(input: RequestInfo | URL): string | undefined {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== 'https://openrouter.ai') return undefined
    return url.pathname
  } catch {
    return undefined
  }
}

async function readReplayableResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<{ response: Response; costUsd: number | null }> {
  const body = response.body
  if (!body) return { response, costUsd: null }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let abortHandler: (() => void) | undefined
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  let abortPromise: Promise<never> | undefined
  let streamDone = false
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('Provider response read cancelled')
    abortPromise = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(signal?.reason ?? new Error('Provider response read cancelled'))
      signal?.addEventListener('abort', abortHandler, { once: true })
    })
    while (true) {
      pending = reader.read()
      const result =
        signal !== undefined ? await Promise.race([pending, abortPromise!]) : await pending
      pending = undefined
      if (result.done) {
        streamDone = true
        break
      }
      bytes += result.value.byteLength
      if (bytes > MAX_COST_RECEIPT_BYTES)
        throw new RangeError('Provider response exceeds bounded receipt size')
      chunks.push(result.value)
    }
    const payload = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      bytes,
    )
    let costUsd: number | null = null
    try {
      const parsed: unknown = JSON.parse(payload.toString('utf8'))
      const parsedCost = costSchema.safeParse(parsed)
      const cost = parsedCost.success ? parsedCost.data.usage?.cost : undefined
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) costUsd = cost
    } catch {
      costUsd = null
    }
    const headers = new Headers(response.headers)
    const replay = new Response(Uint8Array.from(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
    payload.fill(0)
    return { response: replay, costUsd }
  } finally {
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    for (const chunk of chunks) chunk.fill(0)
    if (!streamDone) {
      try {
        await reader.cancel('campaign response read ended')
      } catch {
        // The response stream may already have closed or errored.
      }
      if (pending) await pending.catch(() => undefined)
    }
    try {
      reader.releaseLock()
    } catch {
      // The reader releases its lock when its pending read settles.
    }
  }
}

async function persistJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporaryPath, path)
}

/**
 * Wraps the actual provider fetch edge. The campaign ledger reserves and records
 * intent first; the network function is invoked synchronously before observed
 * dispatch confirmation is written. Its receipts are independent of the frozen
 * v0.2 recorder's earlier local `dispatched` marker.
 */
export function createCampaignFetchBoundary(options: CampaignFetchBoundaryOptions): {
  fetch: typeof globalThis.fetch
  entries: CampaignFetchJournalEntry[]
} {
  const entries = options.journalEntries ?? []
  return {
    entries,
    fetch: async (input, init) => {
      if (options.signal?.aborted || init?.signal?.aborted)
        throw options.signal?.reason ?? init?.signal?.reason
      const endpoint = requestEndpoint(input)
      if (endpoint !== options.endpoint)
        throw new TypeError('Provider endpoint does not match the frozen profile route')
      const bodySha256 = requestBodyHash(init)
      const rawCall = options.readCurrentProviderCall()
      if (
        !rawCall ||
        rawCall.requestBodySha256 !== bodySha256 ||
        !Number.isSafeInteger(rawCall.logicalId) ||
        !Number.isSafeInteger(rawCall.physicalId)
      )
        throw new TypeError('Actual fetch has no matching recorder request identity')

      const reservationId = await options.ledger.admitPhysical(options.reservedUsd)
      if (options.signal?.aborted || init?.signal?.aborted) {
        await options.ledger.cancelBeforeFetch(reservationId)
        throw (
          options.signal?.reason ?? init?.signal?.reason ?? new Error('Provider dispatch cancelled')
        )
      }
      const intentPath = join(options.journalDirectory, `dispatch-${reservationId}.json`)
      try {
        await mkdir(options.journalDirectory, { recursive: true, mode: 0o700 })
        await writeFile(
          intentPath,
          `${JSON.stringify({
            reservationId,
            profileId: options.profileId,
            opaqueCaseId: options.opaqueCaseId,
            caseExecutionIdentitySha256: options.caseExecutionIdentitySha256,
            logicalId: rawCall.logicalId,
            recorderPhysicalId: rawCall.physicalId,
            requestSha256: rawCall.requestSha256,
            requestBodySha256: bodySha256,
            endpoint,
            state: 'admitted',
          })}\n`,
          { mode: 0o600, flag: 'wx' },
        )
      } catch (error) {
        await options.ledger.cancelBeforeFetch(reservationId).catch(() => undefined)
        throw error
      }

      try {
        await options.ledger.recordDispatchIntent(reservationId)
      } catch (error) {
        await options.ledger.cancelBeforeFetch(reservationId).catch(() => undefined)
        throw error
      }

      if (options.signal?.aborted || init?.signal?.aborted) {
        await options.ledger.cancelBeforeFetch(reservationId)
        await rm(intentPath, { force: true })
        throw (
          options.signal?.reason ?? init?.signal?.reason ?? new Error('Provider dispatch cancelled')
        )
      }

      let invokedAt: string | null = null
      let responseStatus: number | null = null
      let observedCost: number | null = null
      const workOutcomePromise = invokeInjectedWork(async () => {
        invokedAt = new Date().toISOString()
        const response = await options.baseFetch(input, init)
        responseStatus = response.status
        const replay = await readReplayableResponse(response, init?.signal ?? options.signal)
        observedCost = replay.costUsd
        return replay.response
      })
      const outcome = await finalizeObservedPhysicalDispatch(
        options.ledger,
        reservationId,
        workOutcomePromise,
        () => observedCost,
      )

      if (outcome.kind === 'confirm_failed_recovery_barrier') {
        const entry: CampaignFetchJournalEntry = {
          reservationId,
          physicalId: null,
          profileId: options.profileId,
          opaqueCaseId: options.opaqueCaseId,
          caseExecutionIdentitySha256: options.caseExecutionIdentitySha256,
          logicalId: rawCall.logicalId,
          recorderPhysicalId: rawCall.physicalId,
          requestSha256: rawCall.requestSha256,
          requestBodySha256: bodySha256,
          endpoint,
          dispatchState: 'uncertain',
          settled: false,
          costUsd: null,
          httpStatus: responseStatus,
          errorCode: errorCode(outcome.confirmCause),
        }
        entries.push(entry)
        await persistJson(intentPath, { ...entry, invokedAt })
        throw new PhysicalDispatchConfirmFailedError(outcome.confirmCause)
      }

      if (outcome.kind === 'fetch_failed_settled_unknown') {
        const entry: CampaignFetchJournalEntry = {
          reservationId,
          physicalId: outcome.physicalId,
          profileId: options.profileId,
          opaqueCaseId: options.opaqueCaseId,
          caseExecutionIdentitySha256: options.caseExecutionIdentitySha256,
          logicalId: rawCall.logicalId,
          recorderPhysicalId: rawCall.physicalId,
          requestSha256: rawCall.requestSha256,
          requestBodySha256: bodySha256,
          endpoint,
          dispatchState: 'confirmed',
          settled: true,
          costUsd: null,
          httpStatus: null,
          errorCode: errorCode(outcome.error),
        }
        entries.push(entry)
        await persistJson(intentPath, { ...entry, invokedAt })
        throw outcome.error
      }

      const entry: CampaignFetchJournalEntry = {
        reservationId,
        physicalId: outcome.physicalId,
        profileId: options.profileId,
        opaqueCaseId: options.opaqueCaseId,
        caseExecutionIdentitySha256: options.caseExecutionIdentitySha256,
        logicalId: rawCall.logicalId,
        recorderPhysicalId: rawCall.physicalId,
        requestSha256: rawCall.requestSha256,
        requestBodySha256: bodySha256,
        endpoint,
        dispatchState: 'confirmed',
        settled: true,
        costUsd: outcome.costUsd,
        httpStatus: responseStatus,
      }
      entries.push(entry)
      await persistJson(intentPath, { ...entry, invokedAt })
      return outcome.value
    },
  }
}
