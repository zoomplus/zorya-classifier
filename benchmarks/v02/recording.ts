import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import type { RunBudget } from './budget.js'
import { hashCanonical, sanitizeDecisionRequest } from './protocol.js'

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
  route: { model: string; provider: string; providerName: string; allowFallbacks: false }
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
            costUsd: result.metadata.costUsd,
            durationMs: result.metadata.durationMs,
            attempts: result.metadata.attempts,
          }
          await writeFile(
            join(directory, `physical-receipt-${physicalId}.json`),
            JSON.stringify(physical, null, 2) + '\n',
            { flag: 'wx' },
          )
          budget.settle(physical.reservationId, result.metadata.costUsd)
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
          await writeFile(
            join(directory, `physical-receipt-${physicalId}.json`),
            JSON.stringify(physical, null, 2) + '\n',
            { flag: 'wx' },
          )
          budget.settle(physical.reservationId, null)
        }
        throw error
      }
    },
  }
  return { port, calls, logicalCalls, fetch: trackedFetch }
}
