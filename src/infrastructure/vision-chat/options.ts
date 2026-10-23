import { z } from 'zod'
import { requestLimit, responseLimit } from '../decision-transport/request.js'

const name = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u)
export const visionOptionsSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value)
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        } catch {
          return false
        }
      }),
    headers: z
      .record(
        z.string().regex(/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/u),
        z
          .string()
          .max(4096)
          .refine((value) => !/[\r\n]/u.test(value)),
      )
      .refine((value) => Object.keys(value).length <= 32)
      .optional(),
    apiKey: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/\s/u.test(value))
      .optional(),
    model: name,
    provider: name.optional(),
    providerName: z.string().min(1).max(256).optional(),
    responseModelIds: z.array(name).max(8).optional(),
    responseFormat: z.enum(['prompt', 'json-object', 'json-schema']).default('prompt'),
    maxOutputTokens: z.number().int().min(64).max(4096).default(1024),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
    fetch: z.custom<typeof globalThis.fetch>((value) => typeof value === 'function').optional(),
    maxRequestBytes: z.number().int().min(1).max(requestLimit).default(requestLimit),
    maxResponseBytes: z.number().int().min(1).max(responseLimit).default(responseLimit),
  })
  .strict()
export interface VisionChatOptions {
  endpoint: string
  headers?: Record<string, string>
  apiKey?: string
  model: string
  provider?: string
  /** Expected display name when it differs from the pinned provider slug. */
  providerName?: string
  /** Explicit additional response snapshot identities; never a routing fallback. */
  responseModelIds?: string[]
  responseFormat?: 'prompt' | 'json-object' | 'json-schema'
  maxOutputTokens?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  fetch?: typeof globalThis.fetch
  maxRequestBytes?: number
  maxResponseBytes?: number
}

export type ParsedVisionOptions = z.infer<typeof visionOptionsSchema>
