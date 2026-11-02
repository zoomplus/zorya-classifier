import type { SafeError } from './contracts.js'
import { ClassifierError } from 'zorya-classifier'

export type McpErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_OPERATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CAPACITY_LIMIT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'MEDIA_UNAVAILABLE'
  | 'ARTIFACT_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'RESOURCE_LIMIT'
  | 'DISPOSED'
  | 'INTERNAL'

export class McpCoreError extends Error {
  readonly code: McpErrorCode
  readonly retryable: boolean

  constructor(code: McpErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'McpCoreError'
    this.code = code
    this.retryable = retryable
  }

  toSafeError(): SafeError {
    return { code: this.code, message: this.message, retryable: this.retryable }
  }
}

export function safeError(error: unknown): SafeError {
  return publicError(error).toSafeError()
}

export function publicError(error: unknown): McpCoreError {
  if (error instanceof McpCoreError) return error
  if (error instanceof ClassifierError) {
    const mapping = {
      INVALID_INPUT: ['INVALID_INPUT', 'The operation input is invalid.'],
      INVALID_RESPONSE: ['PROVIDER_RESPONSE_INVALID', 'The model response was invalid.'],
      TIMEOUT: ['TIMEOUT', 'Job deadline exceeded.'],
      ABORTED: ['CANCELLED', 'The operation was cancelled.'],
      CAPACITY: ['CAPACITY_LIMIT', 'Classifier capacity is full.'],
      DISPOSED: ['DISPOSED', 'The classifier is unavailable.'],
      PROVIDER: ['PROVIDER_ERROR', 'The configured model request failed.'],
      AUTHENTICATION: ['CREDENTIAL_UNAVAILABLE', 'The configured credential was rejected.'],
      UNSUPPORTED: [
        'UNSUPPORTED_OPERATION',
        'The configured model does not support this operation.',
      ],
      RESOURCE_LIMIT: ['RESOURCE_LIMIT', 'The operation exceeded a configured resource limit.'],
    } as const
    const [code, message] = mapping[error.code]
    return new McpCoreError(code, message, error.code !== 'INVALID_INPUT')
  }
  return new McpCoreError('INTERNAL', 'The operation failed.', true)
}

export function abortError(signal: AbortSignal): McpCoreError {
  if (signal.reason instanceof McpCoreError) return signal.reason
  return new McpCoreError('CANCELLED', 'The operation was cancelled.', true)
}
