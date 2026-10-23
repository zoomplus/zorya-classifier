import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import type { RunBudget } from './budget.js'
import { createDecisionTrace, hashCanonical, sanitizeDecisionRequest } from './protocol.js'

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
    bodyRead:
      | 'parsed'
      | 'invalid-json'
      | 'oversize'
      | 'stalled'
      | 'cancelled'
      | 'stream-error'
      | 'empty'
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

interface LogicalCallRecord {
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
  /** Optional for compatibility with previously captured/custom recorder objects. */
  persistenceFailures?: RecorderPersistenceFailure[]
}

const recorderBudgets = new WeakMap<Recorder, RunBudget>()

/** Verify the actual fetch recorder's captured budget, not a caller-provided receipt claim. */
export function isRecorderBoundToBudget(recorder: Recorder, budget: RunBudget): boolean {
  return recorderBudgets.get(recorder) === budget
}

interface RecorderPersistenceFailure {
  stage:
    | 'physical-admission'
    | 'physical-http'
    | 'logical-request'
    | 'decision-trace'
    | 'physical-receipt'
    | 'logical-outcome'
  logicalId: number | null
  physicalId: number | null
  errorCode: 'PERSISTENCE_ERROR'
}

const responseLimit = 1024 * 1024

function safeField(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 256 && /^[\w./:-]+$/u.test(value)
    ? value
    : null
}

const wireErrorTypes = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_timeout',
  'conflict_error',
  'rate_limit_error',
  'server_error',
  'api_error',
  'provider_error',
])

const wireErrorCodes = new Set([
  'unsupported_parameter',
  'invalid_request',
  'invalid_json',
  'invalid_json_schema',
  'model_not_found',
  'model_unavailable',
  'no_provider_available',
  'rate_limit_exceeded',
  'context_length_exceeded',
  'authentication_error',
  'permission_denied',
  'server_error',
])

const wireErrorParameters = new Set([
  'model',
  'messages',
  'prompt',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'n',
  'stream',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'user',
  'response_format',
  'reasoning_effort',
  'tools',
  'tool_choice',
  'seed',
])

function safeWireValue(value: unknown, allowlist: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowlist.has(value) ? value : null
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

const emptyWireReceipt = (
  response: Response,
  bodyRead: NonNullable<PhysicalCallRecord['wireReceipt']>['bodyRead'],
): NonNullable<PhysicalCallRecord['wireReceipt']> => ({
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
  bodyRead,
})

interface CapturedResponse {
  response: Response
  wireReceipt: NonNullable<PhysicalCallRecord['wireReceipt']>
}

/** Read the wire body once, then replay only the bounded captured bytes to the adapter. */
async function readWireReceipt(
  response: Response,
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
): Promise<CapturedResponse> {
  const replay = (bytes: Uint8Array): Response => {
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    const bodyless = [204, 205, 304].includes(response.status)
    return new Response(bodyless ? null : Buffer.from(bytes), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  if (!response.body)
    return { response: replay(new Uint8Array()), wireReceipt: emptyWireReceipt(response, 'empty') }
  const reader = response.body.getReader()
  if (!reader)
    return { response: replay(new Uint8Array()), wireReceipt: emptyWireReceipt(response, 'empty') }
  const chunks: Uint8Array[] = []
  let bytes = 0
  const deadline = performance.now() + timeoutMs
  let disposition: 'oversize' | 'stalled' | 'cancelled' | 'stream-error' | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const cancelRead = (reason: unknown): void => {
    // Do not await cancel(): user streams may have a stalled cancel algorithm.
    try {
      void reader.cancel(reason).catch(() => undefined)
    } catch {
      // The stream may already have completed or errored.
    }
  }
  try {
    while (true) {
      if (signal?.aborted) {
        disposition = 'cancelled'
        cancelRead(signal.reason)
        break
      }
      pending = reader.read()
      const remainingMs = Math.max(0, deadline - performance.now())
      const result = await Promise.race([
        pending.then((value) => ({ kind: 'read' as const, value })),
        new Promise<{ kind: 'timeout' | 'cancelled' }>((resolve) => {
          if (signal) {
            abortHandler = () => resolve({ kind: 'cancelled' })
            signal.addEventListener('abort', abortHandler, { once: true })
            if (signal.aborted) {
              resolve({ kind: 'cancelled' })
              return
            }
          }
          timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs)
        }),
      ])
      if (timer) clearTimeout(timer)
      timer = undefined
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      abortHandler = undefined
      if (result.kind !== 'read') {
        disposition = result.kind === 'cancelled' ? 'cancelled' : 'stalled'
        cancelRead(result.kind === 'cancelled' ? signal?.reason : 'wire body read deadline')
        break
      }
      pending = undefined
      const part = result.value
      if (part.done) break
      const remaining = responseLimit - bytes
      const captured =
        part.value.byteLength > remaining
          ? new Uint8Array(part.value.subarray(0, remaining))
          : part.value
      if (captured.byteLength > 0) {
        chunks.push(captured)
        bytes += captured.byteLength
      }
      if (part.value.byteLength > remaining) {
        disposition = 'oversize'
        cancelRead('wire body exceeded capture limit')
        break
      }
    }
  } catch {
    disposition = signal?.aborted ? 'cancelled' : 'stream-error'
    cancelRead(signal?.reason ?? 'wire body read error')
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    if (pending) {
      // A timed-out read may still be pending. Let cancellation settle it before unlocking.
      void pending
        .catch(() => undefined)
        .finally(() => {
          try {
            reader.releaseLock()
          } catch {
            // Ignore an already released reader.
          }
        })
    } else {
      try {
        reader.releaseLock()
      } catch {
        // Ignore an already released reader.
      }
    }
  }
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  if (disposition)
    return { response: replay(raw), wireReceipt: emptyWireReceipt(response, disposition) }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return { response: replay(raw), wireReceipt: emptyWireReceipt(response, 'invalid-json') }
  }
  if (!parsed || typeof parsed !== 'object')
    return { response: replay(raw), wireReceipt: emptyWireReceipt(response, 'invalid-json') }
  const object = parsed as Record<string, unknown>
  const parsedDisposition = responseDisposition(object)
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
    response: replay(raw),
    wireReceipt: {
      responseModel: safeField(object.model),
      responseProvider: safeField(object.provider),
      responseId: safeField(object.id),
      usageCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      errorType: safeWireValue(error?.type, wireErrorTypes),
      errorCode: safeWireValue(error?.code, wireErrorCodes),
      errorParameter: safeWireValue(parameter, wireErrorParameters),
      errorCategory: error || message ? errorCategory(message, error?.type, error?.code) : null,
      errorReason: error || message ? errorReason(message, error?.type, error?.code) : null,
      rateLimitScope: rateLimitScope(message),
      retryAfterSeconds: retryAfter(response),
      responseDisposition: parsedDisposition.disposition,
      finishReason: parsedDisposition.finishReason,
      bodyRead: 'parsed',
    },
  }
}

/** Instrument the actual transport fetch boundary. A DecisionPort attempt alone consumes no budget. */
export function recordProvider(
  providerFactory: (fetch: typeof globalThis.fetch) => DecisionPort,
  budget: RunBudget,
  directory: string,
  route: PhysicalCallRecord['route'],
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  wireReadTimeoutMs = 45_000,
): Recorder {
  const calls: PhysicalCallRecord[] = []
  const logicalCalls: LogicalCallRecord[] = []
  const persistenceFailures: RecorderPersistenceFailure[] = []
  async function persist(
    stage: RecorderPersistenceFailure['stage'],
    path: string,
    contents: string,
    logicalId: number | null,
    physicalId: number | null,
  ): Promise<void> {
    try {
      await writeFile(path, contents, { flag: 'wx' })
    } catch {
      persistenceFailures.push({ stage, logicalId, physicalId, errorCode: 'PERSISTENCE_ERROR' })
      throw new ClassifierError('RESOURCE_LIMIT', 'Benchmark receipt persistence failed')
    }
  }
  async function ensureDirectory(
    stage: RecorderPersistenceFailure['stage'],
    logicalId: number | null,
    physicalId: number | null,
  ): Promise<void> {
    try {
      await mkdir(directory, { recursive: true })
    } catch {
      persistenceFailures.push({
        stage,
        logicalId,
        physicalId,
        errorCode: 'PERSISTENCE_ERROR',
      })
      throw new ClassifierError('RESOURCE_LIMIT', 'Benchmark receipt persistence failed')
    }
  }
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
      await ensureDirectory('physical-admission', logical.logicalId, record.physicalId)
      await persist(
        'physical-admission',
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
        logical.logicalId,
        record.physicalId,
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
      const captured = await readWireReceipt(response, init?.signal, wireReadTimeoutMs)
      record.wireReceipt = captured.wireReceipt
      record.durationMs = performance.now() - started
      await persist(
        'physical-http',
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
        logical.logicalId,
        record.physicalId,
      )
      return captured.response
    } catch (error) {
      record.errorCode = error instanceof ClassifierError ? error.code : 'HTTP_FETCH_ERROR'
      record.durationMs = performance.now() - started
      await persist(
        'physical-http',
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
        logical.logicalId,
        record.physicalId,
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
      await ensureDirectory('logical-request', logical.logicalId, null)
      await persist(
        'logical-request',
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
        logical.logicalId,
        null,
      )
      try {
        const rawResult = await currentLogical.run(logical, () =>
          provider.decide(structuredClone(request), signal),
        )
        const traced = createDecisionTrace(request, rawResult)
        await persist(
          'decision-trace',
          join(directory, `decision-trace-${logical.logicalId}.json`),
          JSON.stringify(traced.trace, null, 2) + '\n',
          logical.logicalId,
          logical.physicalIds[0] ?? null,
        )
        if (!traced.result)
          throw new ClassifierError('INVALID_RESPONSE', 'Decision result failed validation')
        const result = traced.result
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
          await persist(
            'physical-receipt',
            join(directory, `physical-receipt-${physicalId}.json`),
            JSON.stringify(physical, null, 2) + '\n',
            logical.logicalId,
            physicalId,
          )
          budget.settle(physical.reservationId, physical.receipt.costUsd)
        }
        return result
      } catch (error) {
        logical.errorCode = error instanceof ClassifierError ? error.code : 'PROVIDER_ERROR'
        await persist(
          'logical-outcome',
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
          logical.logicalId,
          logical.physicalIds[0] ?? null,
        )
        for (const physicalId of logical.physicalIds) {
          const physical = calls.find((item) => item.physicalId === physicalId)
          if (!physical) continue
          physical.errorCode = logical.errorCode
          await persist(
            'physical-receipt',
            join(directory, `physical-receipt-${physicalId}.json`),
            JSON.stringify(physical, null, 2) + '\n',
            logical.logicalId,
            physicalId,
          )
          budget.settle(physical.reservationId, physical.wireReceipt?.usageCostUsd ?? null)
        }
        throw error
      }
    },
  }
  const recorder = { port, calls, logicalCalls, fetch: trackedFetch, persistenceFailures }
  recorderBudgets.set(recorder, budget)
  return recorder
}
