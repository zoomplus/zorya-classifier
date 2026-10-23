import type { z } from 'zod'
import { ClassifierError } from '../../entities/errors.js'
import type { ErrorCode } from '../../entities/errors.js'

const localErrors = new WeakSet<ClassifierError>()

export function ownedError(
  code: ErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ClassifierError {
  const error = new ClassifierError(code, message, details)
  localErrors.add(error)
  return error
}

export function invalid(
  code: 'INVALID_INPUT' | 'INVALID_RESPONSE',
  message: string,
): ClassifierError {
  return ownedError(code, message)
}

export function active(signal: AbortSignal): void {
  if (!signal.aborted) return
  const timeout = signal.reason instanceof ClassifierError && signal.reason.code === 'TIMEOUT'
  throw ownedError(
    timeout ? 'TIMEOUT' : 'ABORTED',
    timeout ? 'Operation timed out' : 'Operation cancelled',
  )
}

export function validated<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
  code: 'INVALID_INPUT' | 'INVALID_RESPONSE',
): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw invalid(code, 'Decision schema validation failed')
  return parsed.data
}

export function failure(
  error: unknown,
  signal: AbortSignal,
  cleanupFailed = false,
): ClassifierError {
  const known = error instanceof ClassifierError && localErrors.has(error)
  const incompleteCleanup = cleanupFailed || (known && error.details.cleanupFailed === true)
  try {
    active(signal)
  } catch (aborted) {
    if (aborted instanceof ClassifierError)
      return ownedError(
        aborted.code,
        aborted.message,
        incompleteCleanup ? { cleanupFailed: true } : {},
      )
  }
  return ownedError(
    known ? error.code : 'PROVIDER',
    known ? error.message : 'Model provider transport failed',
    { ...(known ? error.details : {}), ...(incompleteCleanup ? { cleanupFailed: true } : {}) },
  )
}
