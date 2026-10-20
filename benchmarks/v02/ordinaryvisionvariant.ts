import { z } from 'zod'
import { hashCanonical } from './protocol.js'

export const ordinaryVisionAxisVariant = Object.freeze({
  id: 'ordinary-luna-axis-v1',
  promptId: 'ordinary-vision-closed-choice-v1',
  model: 'openai/gpt-6-luna',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
  allowFallbacks: false,
  responseFormat: 'json-schema',
  reasoningEffort: 'none',
  maxOutputTokens: 1024,
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  timeoutMs: 45000,
  retries: 0,
  presentation: 'axis-rulers-v1',
})

const schema = z
  .object({
    id: z.literal('ordinary-luna-axis-v1'),
    promptId: z.literal('ordinary-vision-closed-choice-v1'),
    model: z.literal('openai/gpt-6-luna'),
    provider: z.literal('openai'),
    providerName: z.literal('OpenAI'),
    apiEndpoint: z.literal('https://openrouter.ai/api/v1/chat/completions'),
    allowFallbacks: z.literal(false),
    responseFormat: z.literal('json-schema'),
    reasoningEffort: z.literal('none'),
    maxOutputTokens: z.literal(1024),
    boxTolerancePx: z.literal(8),
    maxExtentPasses: z.literal(3),
    timeoutMs: z.literal(45000),
    retries: z.literal(0),
    presentation: z.literal('axis-rulers-v1'),
  })
  .strict()

schema.parse(ordinaryVisionAxisVariant)

export function ordinaryVisionAxisVariantHash(sourceHashes: Record<string, string>): string {
  const sourceEntries = Object.entries(sourceHashes).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  if (
    sourceEntries.length === 0 ||
    sourceEntries.some(([, digest]) => !/^[a-f0-9]{64}$/u.test(digest))
  )
    throw new TypeError('ordinary-luna-axis-v1 requires frozen SHA-256 source digests')
  return hashCanonical({ variant: ordinaryVisionAxisVariant, sourceHashes: sourceEntries })
}
