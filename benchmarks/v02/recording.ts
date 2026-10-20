import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import type { RunBudget } from './budget.js'
import { hashCanonical, sanitizeDecisionRequest } from './protocol.js'

type WireErrorCategory =
  | 'unsupported-parameter'
  | 'unsupported-route'
  | 'rate-limited'
  | 'invalid-request'
  | 'other'

type WireErrorReason =
  | 'unsupported-parameter'
  | 'no-provider-endpoint'
  | 'model-unavailable'
  | 'provider-unavailable'
  | 'rate-limited'
  | 'invalid-request'
  | 'other'
type RateLimitScope = 'account' | 'key' | 'provider' | 'unknown' | null
type ResponseDisposition =
  | 'error-envelope'
  | 'chat-json-object'
  | 'chat-json-nonobject'
  | 'chat-invalid-json'
  | 'chat-truncated-output'
  | 'chat-empty'
  | 'chat-content-array'
  | 'chat-missing-content'
  | 'chat-refusal'
  | 'typed-decisions-response'
  | 'other-json'

export interface PhysicalCallRecord {
  physicalId: number
  reservationId: number
  logicalId: number
  requestSha256: string
  requestBodySha256: string
  admittedAt: string
  durationMs: number
  dispatched: true
  httpStatus: number | null
  wireReceipt: null | {
    responseModel: string | null
    responseProvider: string | null
    responseId: string | null
    usageCostUsd: number | null
    errorType: string | null
    errorCode: string | null
    errorParameter: string | null
    errorCategory: WireErrorCategory | null
    errorReason: WireErrorReason | null
    rateLimitScope: RateLimitScope
    retryAfterSeconds: number | null
    responseDisposition: ResponseDisposition | null
    finishReason: string | null
    bodyRead: 'parsed' | 'invalid-json' | 'oversize' | 'empty'
  }
  route: {
    model: string
    provider: string
    providerName: string
    apiEndpoint: string
    allowFallbacks: false
  }
  receipt: null | {
    model: string | null
    provider: string | null
    requestId: string | null
    costUsd: number | null
    durationMs: number
    attempts: number
  }
  errorCode?: string
}

export interface LogicalCallRecord {
  logicalId: number
  requestSha256: string
  request: ReturnType<typeof sanitizeDecisionRequest>
  physicalIds: number[]
  errorCode?: string
}

export interface Recorder {
  port: DecisionPort
  calls: PhysicalCallRecord[]
  logicalCalls: LogicalCallRecord[]
  fetch: typeof globalThis.fetch
}

const responseLimit = 1024 * 1024

function safeField(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 256 && /^[\w./:-]+$/u.test(value)
    ? value
    : null
}

function errorCategory(message: unknown, type: unknown, code: unknown): WireErrorCategory {
  const combined =
    `${String(message ?? '')} ${String(type ?? '')} ${String(code ?? '')}`.toLowerCase()
  if (/unsupported.*(?:parameter|param)|(?:parameter|param).*unsupported/u.test(combined))
    return 'unsupported-parameter'
  if (/rate.?limit|too many requests/u.test(combined)) return 'rate-limited'
  if (
    /no endpoints?|no provider|provider.{0,30}(?:unavailable|not available|not found)|model.{0,30}(?:unavailable|not found|does not exist|unknown)/u.test(
      combined,
    )
  )
    return 'unsupported-route'
  if (/invalid|bad request|schema/u.test(combined)) return 'invalid-request'
  return 'other'
}

function safeErrorText(error: Record<string, unknown> | undefined, fallback: unknown): string {
  const candidates: unknown[] = [
    error?.message,
    error?.details,
    error?.detail,
    error?.description,
    error?.code,
    error?.type,
    fallback,
  ]
  const metadata = error?.metadata
  if (metadata && typeof metadata === 'object') {
    const data = metadata as Record<string, unknown>
    candidates.push(data.message, data.details, data.code, data.type, data.provider_name)
  }
  return candidates
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .slice(0, 4096)
}

function rateLimitScope(message: string): RateLimitScope {
  if (!/rate.?limit|too many requests|quota|limit exceeded/u.test(message.toLowerCase()))
    return null
  const lower = message.toLowerCase()
  if (/api.?key|key limit|key quota/u.test(lower)) return 'key'
  if (/account|workspace|user quota/u.test(lower)) return 'account'
  if (/provider|upstream/u.test(lower)) return 'provider'
  return 'unknown'
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get('retry-after')
  if (!raw) return null
  if (/^\d{1,8}(?:\.\d{1,3})?$/u.test(raw)) return Math.ceil(Number(raw))
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null
}

function safeFinishReason(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,40}$/u.test(value) ? value : null
}

function responseDisposition(object: Record<string, unknown>): {
  disposition: ResponseDisposition
  finishReason: string | null
} {
  if (object.error) return { disposition: 'error-envelope', finishReason: null }
  if (object.answers && typeof object.answers === 'object')
    return { disposition: 'typed-decisions-response', finishReason: null }
  if (Array.isArray(object.choices)) {
    const choice = object.choices[0]
    if (!choice || typeof choice !== 'object')
      return { disposition: 'chat-missing-content', finishReason: null }
    const record = choice as Record<string, unknown>
    const finishReason = safeFinishReason(record.finish_reason)
    if (record.finish_reason === 'length')
      return { disposition: 'chat-truncated-output', finishReason }
    const message =
      record.message && typeof record.message === 'object'
        ? (record.message as Record<string, unknown>)
        : undefined
    if (message?.refusal) return { disposition: 'chat-refusal', finishReason }
    const content = message?.content
    if (typeof content !== 'string')
      return {
        disposition: Array.isArray(content) ? 'chat-content-array' : 'chat-missing-content',
        finishReason,
      }
    if (content.trim().length === 0) return { disposition: 'chat-empty', finishReason }
    try {
      const parsed: unknown = JSON.parse(content)
      return {
        disposition:
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? 'chat-json-object'
            : 'chat-json-nonobject',
        finishReason,
      }
    } catch {
      return {
        disposition: 'chat-invalid-json',
        finishReason,
      }
    }
  }
  return { disposition: 'other-json', finishReason: null }
}

function errorReason(message: unknown, type: unknown, code: unknown): WireErrorReason {
  const combined =
    `${String(message ?? '')} ${String(type ?? '')} ${String(code ?? '')}`.toLowerCase()
  if (/unsupported.*(?:parameter|param)|(?:parameter|param).*unsupported/u.test(combined))
    return 'unsupported-parameter'
  if (
    /no endpoints?|no provider|provider.{0,30}(?:unavailable|not available|not found)/u.test(
      combined,
    )
  )
    return 'no-provider-endpoint'
  if (/model.{0,30}(?:unavailable|not found|does not exist|unknown)/u.test(combined))
    return 'model-unavailable'
  if (/provider.{0,30}(?:unsupported|unknown|invalid)/u.test(combined))
    return 'provider-unavailable'
  if (/rate.?limit|too many requests/u.test(combined)) return 'rate-limited'
  if (/invalid|bad request|schema/u.test(combined)) return 'invalid-request'
  return 'other'
}

async function readWireReceipt(
  response: Response,
): Promise<NonNullable<PhysicalCallRecord['wireReceipt']>> {
  if (!response.body)
    return {
      responseModel: null,
      responseProvider: null,
      responseId: null,
      usageCostUsd: null,
      errorType: null,
      errorCode: null,
      errorParameter: null,
      errorCategory: null,
      errorReason: null,
      rateLimitScope: null,
      retryAfterSeconds: retryAfter(response),
      responseDisposition: null,
      finishReason: null,
      bodyRead: 'empty',
    }
  const reader = response.clone().body?.getReader()
  if (!reader)
    return {
      responseModel: null,
      responseProvider: null,
      responseId: null,
      usageCostUsd: null,
      errorType: null,
      errorCode: null,
      errorParameter: null,
      errorCategory: null,
      errorReason: null,
      rateLimitScope: null,
      retryAfterSeconds: retryAfter(response),
      responseDisposition: null,
      finishReason: null,
      bodyRead: 'empty',
    }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > responseLimit) {
        await reader.cancel()
        return {
          responseModel: null,
          responseProvider: null,
          responseId: null,
          usageCostUsd: null,
          errorType: null,
          errorCode: null,
          errorParameter: null,
          errorCategory: null,
          errorReason: null,
          rateLimitScope: null,
          retryAfterSeconds: retryAfter(response),
          responseDisposition: null,
          finishReason: null,
          bodyRead: 'oversize',
        }
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'))
  } catch {
    return {
      responseModel: null,
      responseProvider: null,
      responseId: null,
      usageCostUsd: null,
      errorType: null,
      errorCode: null,
      errorParameter: null,
      errorCategory: null,
      errorReason: null,
      rateLimitScope: null,
      retryAfterSeconds: retryAfter(response),
      responseDisposition: null,
      finishReason: null,
      bodyRead: 'invalid-json',
    }
  }
  if (!parsed || typeof parsed !== 'object')
    return {
      responseModel: null,
      responseProvider: null,
      responseId: null,
      usageCostUsd: null,
      errorType: null,
      errorCode: null,
      errorParameter: null,
      errorCategory: null,
      errorReason: null,
      rateLimitScope: null,
      retryAfterSeconds: retryAfter(response),
      responseDisposition: null,
      finishReason: null,
      bodyRead: 'invalid-json',
    }
  const object = parsed as Record<string, unknown>
  const disposition = responseDisposition(object)
  const usage =
    object.usage && typeof object.usage === 'object'
      ? (object.usage as Record<string, unknown>)
      : undefined
  const outerError =
    object.error && typeof object.error === 'object'
      ? (object.error as Record<string, unknown>)
      : undefined
  const nestedError =
    outerError?.error && typeof outerError.error === 'object'
      ? (outerError.error as Record<string, unknown>)
      : undefined
  const error = nestedError ?? outerError
  const cost = usage?.cost
  const message = safeErrorText(error, object.message)
  const parameter =
    error?.param ??
    (typeof message === 'string'
      ? /(?:parameter|param)\s+["'`]?([a-zA-Z0-9_.-]{1,80})/iu.exec(message)?.[1]
      : undefined)
  return {
    responseModel: safeField(object.model),
    responseProvider: safeField(object.provider),
    responseId: safeField(object.id),
    usageCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    errorType: safeField(error?.type),
    errorCode: safeField(error?.code),
    errorParameter: safeField(parameter),
    errorCategory: error || message ? errorCategory(message, error?.type, error?.code) : null,
    errorReason: error || message ? errorReason(message, error?.type, error?.code) : null,
    rateLimitScope: rateLimitScope(message),
    retryAfterSeconds: retryAfter(response),
    responseDisposition: disposition.disposition,
    finishReason: disposition.finishReason,
    bodyRead: 'parsed',
  }
}

/** Instrument the actual transport fetch boundary. A DecisionPort attempt alone consumes no budget. */
export function recordProvider(
  providerFactory: (fetch: typeof globalThis.fetch) => DecisionPort,
  budget: RunBudget,
  directory: string,
  route: PhysicalCallRecord['route'],
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): Recorder {
  const calls: PhysicalCallRecord[] = []
  const logicalCalls: LogicalCallRecord[] = []
  const currentLogical = new AsyncLocalStorage<LogicalCallRecord>()
  let trackedFetch: typeof globalThis.fetch = globalThis.fetch
  trackedFetch = async (input, init) => {
    const logical = currentLogical.getStore()
    if (!logical) throw new Error('Provider fetch occurred outside a recorded logical decision')
    if (logical.physicalIds.length > 0)
      throw new Error('Pinned provider attempted an extra physical request')
    const body = init?.body
    const bodyText =
      typeof body === 'string'
        ? body
        : body instanceof Uint8Array
          ? Buffer.from(body).toString('base64')
          : ''
    const reservationId = budget.admit()
    const record: PhysicalCallRecord = {
      physicalId: reservationId,
      reservationId,
      logicalId: logical.logicalId,
      requestSha256: logical.requestSha256,
      requestBodySha256: createHash('sha256').update(bodyText).digest('hex'),
      admittedAt: new Date().toISOString(),
      durationMs: 0,
      dispatched: true,
      httpStatus: null,
      wireReceipt: null,
      route,
      receipt: null,
    }
    const started = performance.now()
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, `physical-admission-${record.physicalId}.json`),
        JSON.stringify(
          {
            physicalId: record.physicalId,
            logicalId: record.logicalId,
            admittedAt: record.admittedAt,
            dispatched: true,
            requestSha256: record.requestSha256,
            requestBodySha256: record.requestBodySha256,
            route,
            redirects: 'error',
            retries: 0,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      )
    } catch (error) {
      budget.cancelBeforeFetch(reservationId)
      throw error
    }
    logical.physicalIds.push(record.physicalId)
    calls.push(record)
    try {
      const response = await baseFetch(input, init)
      record.httpStatus = response.status
      record.wireReceipt = await readWireReceipt(response)
      record.durationMs = performance.now() - started
      await writeFile(
        join(directory, `physical-http-${record.physicalId}.json`),
        JSON.stringify(
          {
            physicalId: record.physicalId,
            logicalId: record.logicalId,
            httpStatus: response.status,
            durationMs: record.durationMs,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      )
      return response
    } catch (error) {
      record.errorCode = error instanceof ClassifierError ? error.code : 'HTTP_FETCH_ERROR'
      record.durationMs = performance.now() - started
      await writeFile(
        join(directory, `physical-http-${record.physicalId}.json`),
        JSON.stringify(
          {
            physicalId: record.physicalId,
            logicalId: record.logicalId,
            httpStatus: null,
            durationMs: record.durationMs,
            errorCode: record.errorCode,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      )
      throw error
    }
  }
  const provider = providerFactory(trackedFetch)

  const port: DecisionPort = {
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      const requestInfo = {
        requestSha256: hashCanonical(request),
        request: sanitizeDecisionRequest(request),
      }
      const logical: LogicalCallRecord = {
        logicalId: logicalCalls.length + 1,
        requestSha256: requestInfo.requestSha256,
        request: requestInfo.request,
        physicalIds: [],
      }
      logicalCalls.push(logical)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, `logical-${logical.logicalId}.json`),
        JSON.stringify(
          {
            logicalId: logical.logicalId,
            requestSha256: logical.requestSha256,
            request: logical.request,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      )
      try {
        const result = await currentLogical.run(logical, () =>
          provider.decide(structuredClone(request), signal),
        )
        for (const physicalId of logical.physicalIds) {
          const physical = calls.find((item) => item.physicalId === physicalId)
          if (!physical) throw new Error('Missing physical fetch ledger entry')
          physical.receipt = {
            model: result.metadata.model,
            provider: result.metadata.provider,
            requestId: result.metadata.requestId,
            costUsd: result.metadata.costUsd ?? physical.wireReceipt?.usageCostUsd ?? null,
            durationMs: result.metadata.durationMs,
            attempts: result.metadata.attempts,
          }
          await writeFile(
            join(directory, `physical-receipt-${physicalId}.json`),
            JSON.stringify(physical, null, 2) + '\n',
            { flag: 'wx' },
          )
          budget.settle(physical.reservationId, physical.receipt.costUsd)
        }
        return result
      } catch (error) {
        logical.errorCode = error instanceof ClassifierError ? error.code : 'PROVIDER_ERROR'
        await writeFile(
          join(directory, `logical-outcome-${logical.logicalId}.json`),
          JSON.stringify(
            {
              logicalId: logical.logicalId,
              requestSha256: logical.requestSha256,
              physicalIds: logical.physicalIds,
              errorCode: logical.errorCode,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
        for (const physicalId of logical.physicalIds) {
          const physical = calls.find((item) => item.physicalId === physicalId)
          if (!physical) continue
          physical.errorCode = logical.errorCode
          await writeFile(
            join(directory, `physical-receipt-${physicalId}.json`),
            JSON.stringify(physical, null, 2) + '\n',
            { flag: 'wx' },
          )
          budget.settle(physical.reservationId, physical.wireReceipt?.usageCostUsd ?? null)
        }
        throw error
      }
    },
  }
  return { port, calls, logicalCalls, fetch: trackedFetch }
}
