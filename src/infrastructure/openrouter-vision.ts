import { createVisionChat, visionOptionsSchema } from './vision-chat.js'
import type { VisionChatOptions } from './vision-chat.js'
import { validated } from './openrouter-common.js'
import { z } from 'zod'
import type { DecisionPort } from '../entities/contracts.js'

export interface OpenRouterVisionOptions
  extends Omit<VisionChatOptions, 'endpoint' | 'headers' | 'apiKey' | 'provider'> {
  apiKey: string
  provider: string
}
const schema = visionOptionsSchema
  .omit({ endpoint: true, headers: true })
  .extend({ apiKey: z.string().min(1), provider: z.string().min(1) })
  .strict()
/** Optional OpenRouter routing wrapper over the ordinary chat-completions adapter. */
export function createOpenRouterVision(input: OpenRouterVisionOptions): DecisionPort {
  const options = validated(schema, input, 'INVALID_INPUT')
  return createVisionChat({ ...options, endpoint: 'https://openrouter.ai/api/v1/chat/completions' })
}
export type OpenRouterTextOptions = OpenRouterVisionOptions
/** Same strict chat protocol; rejects image parts before transport. */
export function createOpenRouterText(input: OpenRouterTextOptions): DecisionPort {
  const options = validated(schema, input, 'INVALID_INPUT')
  return createVisionChat(
    { ...options, endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
    'text',
  )
}
