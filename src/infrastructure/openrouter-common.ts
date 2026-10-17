import { isProxy } from 'node:util/types'
import { z } from 'zod'
import { ClassifierError } from '../entities/errors.js'
import type { ErrorCode } from '../entities/errors.js'
export const requestLimit = 32 * 1024 * 1024
export const responseLimit = 1024 * 1024
export const probability = z.number().finite().min(0).max(1)
export const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value !== '__proto__')
const text = z.string().min(1).max(64_000)
const imageSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string().max(22_369_656), detail: z.literal('high') }).strict(),
  })
  .strict()
const questionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      rankingSize: z.union([z.literal(1), z.literal(4)]).default(4),
      instructions: text,
      criteria: z
        .record(key, text)
        .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255),
    })
    .strict(),
  z.object({ type: z.literal('noul'), instructions: text }).strict(),
])
export const requestSchema = z
  .object({
    state: z
      .array(z.union([text, imageSchema]))
      .min(1)
      .max(64)
      .refine((value) => value.filter((part) => typeof part !== 'string').length <= 9),
    questions: z
      .record(key, questionSchema)
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 16),
  })
  .strict()
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
function imageSize(bytes: Buffer, format: string): [number, number] {
  if (format === 'png') {
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw invalid('INVALID_INPUT', 'Invalid PNG image header')
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  if (bytes[0] !== 255 || bytes[1] !== 216)
    throw invalid('INVALID_INPUT', 'Invalid JPEG image header')
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) break
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 218 || marker === 217) break
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) break
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
    }
    offset += length
  }
  throw invalid('INVALID_INPUT', 'Invalid JPEG image dimensions')
}
export function validateImage(url: string): void {
  const prefix = /^data:image\/(png|jpeg);base64,/u.exec(url)
  if (!prefix) throw invalid('INVALID_INPUT', 'Only inline PNG or JPEG images are supported')
  const encoded = url.slice(prefix[0].length)
  const padding = encoded.endsWith('==') ? 2 : Number(encoded.endsWith('='))
  if (
    !encoded.length ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+$/u.test(encoded.slice(0, encoded.length - padding))
  )
    throw invalid('INVALID_INPUT', 'Invalid image base64')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== encoded)
    throw invalid('INVALID_INPUT', 'Invalid image byte representation')
  const [width, height] = imageSize(bytes, prefix[1] ?? '')
  if (width < 280 || height < 280 || width > 1568 || height > 1568)
    throw invalid('INVALID_INPUT', 'Prepared image sides must be 280..1568 pixels')
}
/** Bounded owned snapshot; schema parsing never receives caller iterators or accessors. */
export function preflightJson(input: unknown, limit: number): unknown {
  let remaining = limit
  let nodes = 0
  const ancestors = new Set<object>()
  function charge(bytes: number): void {
    remaining -= bytes
    if (remaining < 0) throw ownedError('RESOURCE_LIMIT', 'Decision request exceeds byte limit')
  }
  function string(value: string): void {
    charge(2)
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code < 32) charge([8, 9, 10, 12, 13].includes(code) ? 2 : 6)
      else if (code === 34 || code === 92) charge(2)
      else if (code < 128) charge(1)
      else if (code < 2048) charge(2)
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          charge(4)
          index++
        } else charge(6)
      } else charge(code >= 0xdc00 && code <= 0xdfff ? 6 : 3)
    }
  }
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 10_000 || depth > 6)
      throw invalid('INVALID_INPUT', 'Decision structure exceeds supported limits')
    if (typeof value === 'string') {
      string(value)
      return value
    }
    if (value === null || typeof value === 'boolean') {
      charge(value === false ? 5 : 4)
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      charge(String(value).length)
      return value
    }
    if (typeof value !== 'object' || value === null)
      throw invalid('INVALID_INPUT', 'Unsupported decision value')
    if (isProxy(value)) throw invalid('INVALID_INPUT', 'Decision input must contain plain values')
    // Zod reads declared object fields even when they are not enumerable; JSON does not.
    for (const name of [
      'state',
      'questions',
      'type',
      'image_url',
      'url',
      'detail',
      'instructions',
      'criteria',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (descriptor && !descriptor.enumerable)
        throw invalid('INVALID_INPUT', 'Decision fields must be enumerable')
    }
    if (ancestors.has(value)) throw invalid('INVALID_INPUT', 'Circular decision structure')
    ancestors.add(value)
    charge(2)
    if (Array.isArray(value)) {
      const copy: unknown[] = []
      if (value.length > 64)
        throw invalid('INVALID_INPUT', 'Decision array exceeds supported limits')
      for (let index = 0; index < value.length; index++) {
        if (index) charge(1)
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
          throw invalid('INVALID_INPUT', 'Decision input must contain plain values')
        copy.push(visit(descriptor.value, depth + 1))
      }
      ancestors.delete(value)
      return copy
    } else {
      const copy: Record<string, unknown> = {}
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null)
        throw invalid('INVALID_INPUT', 'Decision input must contain plain objects')
      let count = 0
      for (const name in value) {
        if (!Object.hasOwn(value, name)) continue
        if (++count > 255)
          throw invalid('INVALID_INPUT', 'Decision object exceeds supported limits')
        if (count > 1) charge(1)
        string(name)
        charge(1)
        const descriptor = Object.getOwnPropertyDescriptor(value, name)
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
          throw invalid('INVALID_INPUT', 'Decision input must contain plain values')
        Object.defineProperty(copy, name, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      ancestors.delete(value)
      return copy
    }
  }
  return visit(input, 0)
}
function statusError(status: number): ClassifierError {
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
