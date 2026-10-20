import { z } from 'zod'
import { hashCanonical } from './protocol.js'

export const presentationRoute = Object.freeze({
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
})

const variantSchema = z
  .object({
    id: z.enum(['numeric-v1', 'axis-rulers-v1']),
    boundaryPresentation: z.enum(['numeric-only', 'axis-rulers']),
    route: z
      .object({
        model: z.literal('openai/gpt-6-luna-decisions'),
        provider: z.literal('openai'),
        providerName: z.literal('OpenAI'),
        apiEndpoint: z.literal('/api/alpha/decisions'),
        allowFallbacks: z.literal(false),
      })
      .strict(),
    boxTolerancePx: z.literal(8),
    maxExtentPasses: z.literal(3),
    timeoutMs: z.literal(45000),
    retries: z.literal(0),
  })
  .strict()

export const presentationVariants = Object.freeze({
  'numeric-v1': variantSchema.parse({
    id: 'numeric-v1',
    boundaryPresentation: 'numeric-only',
    route: presentationRoute,
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    timeoutMs: 45000,
    retries: 0,
  }),
  'axis-rulers-v1': variantSchema.parse({
    id: 'axis-rulers-v1',
    boundaryPresentation: 'axis-rulers',
    route: presentationRoute,
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    timeoutMs: 45000,
    retries: 0,
  }),
})

export type PresentationVariantId = keyof typeof presentationVariants
export type PresentationVariant = (typeof presentationVariants)[PresentationVariantId]

export function presentationVariantHash(
  id: PresentationVariantId,
  rendererSha256?: string,
): string {
  const variant = presentationVariants[id]
  if (id === 'axis-rulers-v1') {
    if (!rendererSha256 || !/^[a-f0-9]{64}$/u.test(rendererSha256))
      throw new TypeError('axis-rulers-v1 requires the frozen boundary renderer SHA-256')
    return hashCanonical({ variant, rendererSha256 })
  }
  if (rendererSha256 !== undefined)
    throw new TypeError('numeric-v1 does not accept a boundary renderer digest')
  return hashCanonical({ variant, rendererSha256: null })
}
