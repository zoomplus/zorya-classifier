import { isProxy } from 'node:util/types'
import { z } from 'zod'
import { invalid, ownedError } from './errors.js'

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
