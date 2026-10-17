export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'CAPACITY'
  | 'DISPOSED'
  | 'PROVIDER'
  | 'AUTHENTICATION'
  | 'UNSUPPORTED'
  | 'RESOURCE_LIMIT'
export class ClassifierError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'ClassifierError'
  }
}
export function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof ClassifierError
      ? signal.reason
      : new ClassifierError('ABORTED', 'Operation cancelled')
}
