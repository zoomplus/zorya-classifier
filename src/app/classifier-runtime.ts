import { ClassifierError } from '../entities/errors.js'
import { OperationGate } from '../shared/gate.js'
import { OperationScope } from '../shared/scope.js'
import { InputBudget } from '../shared/input-budget.js'
import type { ClassifierRuntimeConfig } from './classifier-config.js'

export function parseOperationSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof AbortSignal))
    throw new ClassifierError('INVALID_INPUT', 'signal must be an AbortSignal')
  return value
}

export function createClassifierRuntime(config: ClassifierRuntimeConfig) {
  const gate = new OperationGate(config.concurrency, config.maxQueue)
  const inputBudget = new InputBudget(config.maxInputBytes)
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

  async function dispose(): Promise<void> {
    disposed = true
    for (const scope of owned.keys()) scope.abort()
    await Promise.allSettled(owned.values())
  }

  function assertAcceptingOperations(): void {
    if (disposed) throw new ClassifierError('DISPOSED', 'Classifier has been disposed')
    gate.assertAvailable()
  }

  async function withOwnedInput<TSnapshot, TResult>(
    byteCount: number,
    parentSignal: AbortSignal | undefined,
    snapshotFactory: () => TSnapshot,
    task: (snapshot: TSnapshot, signal: AbortSignal) => Promise<TResult>,
  ): Promise<TResult> {
    const release = inputBudget.reserve(byteCount)
    try {
      const snapshot = snapshotFactory()
      return await run(parentSignal, (signal) => task(snapshot, signal))
    } finally {
      release()
    }
  }

  return {
    dispose,
    assertAcceptingOperations,
    withOwnedInput,
  }
}
