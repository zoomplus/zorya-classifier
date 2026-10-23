import { active, failure, invalid, ownedError } from './errors.js'

function statusError(status: number) {
  const code =
    status === 401 || status === 403
      ? 'AUTHENTICATION'
      : status === 413
        ? 'RESOURCE_LIMIT'
        : status === 415
          ? 'UNSUPPORTED'
          : 'PROVIDER'
  return ownedError(code, 'Model provider rejected the request', { status })
}

export async function readResponse(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    active(signal)
    if (!response.ok) throw statusError(response.status)
    throw invalid('INVALID_RESPONSE', 'Provider response has no body')
  }
  let cancelTask: Promise<boolean> | undefined
  function cancel(): void {
    cancelTask ??= reader!.cancel().then(
      () => true,
      () => false,
    )
  }
  signal.addEventListener('abort', cancel, { once: true })
  let caught: unknown
  let output = ''
  let complete = false
  try {
    active(signal)
    if (!response.ok) throw statusError(response.status)
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit))
      throw ownedError('RESOURCE_LIMIT', 'Provider response exceeds byte limit')
    const storage = Buffer.allocUnsafe(limit)
    let bytes = 0
    while (true) {
      active(signal)
      const next = await reader.read()
      active(signal)
      if (next.done) break
      if (next.value.byteLength > limit - bytes)
        throw ownedError('RESOURCE_LIMIT', 'Provider response exceeds byte limit')
      storage.set(next.value, bytes)
      bytes += next.value.byteLength
    }
    complete = true
    try {
      output = new TextDecoder('utf-8', { fatal: true }).decode(storage.subarray(0, bytes))
    } catch {
      throw invalid('INVALID_RESPONSE', 'Provider returned invalid UTF-8')
    }
  } catch (error) {
    caught = error
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    const released = cancelTask ? await cancelTask : true
    reader.releaseLock()
    if (!released) caught = failure(caught, signal, true)
  }
  if (caught !== undefined) throw failure(caught, signal)
  active(signal)
  return output
}
