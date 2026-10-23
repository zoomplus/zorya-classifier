import type { ZodType, ZodTypeDef } from 'zod'

import { ClassifierError } from './errors.js'

export function parse<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_RESPONSE' = 'INVALID_INPUT',
): T {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new ClassifierError(code, 'Schema validation failed', {
      paths: result.error.issues.map((v) => v.path.join('.')),
    })
  return result.data
}
