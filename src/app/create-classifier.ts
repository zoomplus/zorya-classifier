import { z } from 'zod'
import type {
  ClassificationResult,
  ClassifyInput,
  DecisionPort,
  LocalizationResult,
  LocateInput,
  RefinementPort,
} from '../entities/contracts.js'
import { classifySchema, locateSchema, parse } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import { createSharpRaster } from '../infrastructure/raster.js'
import { classifyInput } from '../processes/classify.js'
import { locateInput } from '../processes/locate.js'
import { OperationGate } from '../shared/gate.js'
import { OperationScope } from '../shared/scope.js'
import { InputBudget } from '../shared/input-budget.js'

export interface ClassifierOptions {
  decision: DecisionPort
  timeoutMs?: number
  concurrency?: number
  maxQueue?: number
  maxInputBytes?: number
  refinement?: RefinementPort
}
export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassificationResult>
  locate(input: LocateInput): Promise<LocalizationResult>
  dispose(): Promise<void>
}
const configSchema = z.object({
  timeoutMs: z.number().int().min(1).max(120000).default(45000),
  concurrency: z.number().int().min(1).max(4).default(2),
  maxQueue: z.number().int().min(0).max(32).default(16),
  maxInputBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024 * 1024)
    .default(64 * 1024 * 1024),
})
function signalOf(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal))
    throw new ClassifierError('INVALID_INPUT', 'signal must be an AbortSignal')
  return value
}
export function createClassifier(options: ClassifierOptions): Classifier {
  if (!options || typeof options.decision?.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'A DecisionPort is required')
  const config = parse(configSchema, {
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    maxQueue: options.maxQueue,
    maxInputBytes: options.maxInputBytes,
  })
  const gate = new OperationGate(config.concurrency, config.maxQueue)
  const inputBudget = new InputBudget(config.maxInputBytes)
  const raster = createSharpRaster()
  const owned = new Map<OperationScope, Promise<unknown>>()
  let disposed = false
  async function run<T>(
    signal: AbortSignal | undefined,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
    const scope = new OperationScope(config.timeoutMs, signal)
    const job = (async () => {
      let acquired = false
      try {
        await gate.acquire(scope.signal)
        acquired = true
        scope.guard()
        const result = await task(scope.signal)
        scope.guard()
        return result
      } catch (error) {
        scope.guard()
        throw error
      } finally {
        if (acquired) gate.release()
        scope.dispose()
        owned.delete(scope)
      }
    })()
    owned.set(scope, job)
    return job
  }
  return {
    async classify(input) {
      if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
      gate.assertAvailable()
      if (!input || typeof input !== 'object')
        throw new ClassifierError('INVALID_INPUT', 'Expected classify input object')
      const { signal, ...rest } = input
      const parent = signalOf(signal)
      const parsed = parse(classifySchema, rest)
      const byteCount =
        typeof parsed.input === 'string'
          ? Buffer.byteLength(parsed.input)
          : (parsed.input.image?.byteLength ?? 0) + Buffer.byteLength(parsed.input.text ?? '')
      const release = inputBudget.reserve(byteCount)
      try {
        const media =
          typeof parsed.input === 'string'
            ? parsed.input
            : {
                ...parsed.input,
                ...(parsed.input.image === undefined
                  ? {}
                  : { image: new Uint8Array(parsed.input.image) }),
              }
        return await run(parent, (s) =>
          classifyInput({ ...parsed, input: media }, options.decision, raster, s),
        )
      } finally {
        release()
      }
    },
    async locate(input) {
      if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
      gate.assertAvailable()
      if (!input || typeof input !== 'object')
        throw new ClassifierError('INVALID_INPUT', 'Expected locate input object')
      const { signal, ...rest } = input
      const parent = signalOf(signal)
      const parsed = parse(locateSchema, rest)
      const release = inputBudget.reserve(parsed.image.byteLength)
      try {
        const snapshot = { ...parsed, image: new Uint8Array(parsed.image) }
        return await run(parent, (s) =>
          locateInput(snapshot, options.decision, raster, s, options.refinement),
        )
      } finally {
        release()
      }
    },
    async dispose() {
      disposed = true
      for (const scope of owned.keys()) scope.abort()
      await Promise.allSettled(owned.values())
    },
  }
}
