import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/index.js'
import { ClassifierError } from '../src/index.js'
import type { BenchmarkBudget } from './budget.js'
import { BudgetExhausted } from './budget.js'
import { sha256 } from './corpus.js'

export interface Failure {
  name: string
  code: string
  message: string
  primaryFailure?: Failure
}
export class ArtifactWriteError extends Error {
  readonly code = 'BENCHMARK_ARTIFACT_FAILURE'
  constructor(
    readonly stage: 'request' | 'receipt',
    readonly primaryFailure?: Failure,
  ) {
    super(`Cannot persist benchmark ${stage} evidence`)
    this.name = 'ArtifactWriteError'
  }
}
export function failure(error: unknown): Failure {
  if (error instanceof ArtifactWriteError)
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      ...(error.primaryFailure === undefined ? {} : { primaryFailure: error.primaryFailure }),
    }

  // Never serialize arbitrary external errors, request headers or environment values.
  if (error instanceof ClassifierError)
    return { name: 'ClassifierError', code: error.code, message: error.message }
  if (error instanceof BudgetExhausted)
    return { name: error.name, code: error.code, message: error.message }
  return {
    name: 'Error',
    code: 'BENCHMARK_FAILURE',
    message: 'Benchmark operation failed; inspect stage artifacts and terminal status',
  }
}
export interface CallRecord {
  ordinal: number
  request: DecisionRequest
  requestSha256: string
  startedMs: number
  finishedMs: number
  result?: DecisionResult
  error?: Failure
  artifactFailure?: Failure
  reservationId?: number
  dispatched: boolean
}
export interface Recorder {
  port: DecisionPort
  calls: CallRecord[]
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
/** All image-bearing requests are written only to the explicit, newly-created run directory. */
export function recordProvider(
  provider: DecisionPort,
  budget: BenchmarkBudget,
  directory: string,
  operationStarted: number,
): Recorder {
  const calls: CallRecord[] = []
  return {
    calls,
    port: {
      async decide(request, signal) {
        const ordinal = calls.length + 1
        if (ordinal > 3) throw new Error('Unexpected call count in one benchmark operation')
        const snapshot = structuredClone(request),
          serialized = JSON.stringify(snapshot)
        if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
          throw new Error('Benchmark request byte limit')
        const record: CallRecord = {
          ordinal,
          request: snapshot,
          requestSha256: sha256(serialized),
          startedMs: performance.now() - operationStarted,
          finishedMs: 0,
          dispatched: false,
        }
        calls.push(record)
        const callDir = join(directory, `call-${ordinal}`)
        let reservation: number | undefined, result: DecisionResult | undefined
        let caught: unknown
        let failed = false
        try {
          try {
            await mkdir(callDir)
            await writeFile(join(callDir, 'request.json'), serialized + '\n', { flag: 'wx' })
          } catch {
            throw new ArtifactWriteError('request')
          }
          if (signal.aborted)
            throw new ClassifierError(
              signal.reason instanceof ClassifierError && signal.reason.code === 'TIMEOUT'
                ? 'TIMEOUT'
                : 'ABORTED',
              'Operation stopped before benchmark dispatch',
            )
          reservation = budget.reserve()
          record.reservationId = reservation
          record.dispatched = true
          result = await provider.decide(snapshot, signal)
          record.result = structuredClone(result)
          if (signal.aborted)
            throw new ClassifierError(
              signal.reason instanceof ClassifierError && signal.reason.code === 'TIMEOUT'
                ? 'TIMEOUT'
                : 'ABORTED',
              'Late benchmark result after operation stopped',
            )
        } catch (error) {
          caught = error
          failed = true
          record.error = failure(error)
          if (error instanceof ArtifactWriteError) record.artifactFailure = record.error
        } finally {
          if (reservation !== undefined)
            budget.settle(reservation, result?.metadata.costUsd ?? null)
          record.finishedMs = performance.now() - operationStarted
        }
        // A failing receipt is fatal to the benchmark; there is no silently incomplete evidence.
        try {
          await writeJson(join(callDir, 'receipt.json'), {
            ...record,
            request: undefined,
            modelRoute: {
              model: 'typesafe/jev-1.14',
              provider: 'typesafe',
              allowFallbacks: false,
            },
            attemptsAllowed: 1,
          })
        } catch {
          const error = new ArtifactWriteError('receipt', record.error)
          record.artifactFailure = failure(error)
          caught = error
          failed = true
        }
        if (failed) throw caught
        if (!result) throw new Error('Benchmark provider returned no result')
        return result
      },
    },
  }
}
/** Deliberately content-blind mechanics neighbor; it never receives evaluator truth. */
export function offlineProvider(): DecisionPort {
  return {
    async decide(request, signal) {
      if (signal.aborted) throw new ClassifierError('ABORTED', 'Fixture operation cancelled')
      const answers: DecisionResult['answers'] = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') answers[id] = { type: 'noul', noul: 1 }
        else {
          const keys = Object.keys(question.criteria),
            choice = keys[0]
          if (!choice) throw new Error('Fixture requires at least one class')
          answers[id] = {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(keys.map((key, index) => [key, Number(index === 0)])),
          }
        }
      }
      return {
        answers,
        metadata: {
          model: 'fixture/content-blind-first-option',
          provider: 'offline-fixture',
          requestId: null,
          costUsd: 0,
          durationMs: 0,
          attempts: 1,
        },
      }
    },
  }
}
