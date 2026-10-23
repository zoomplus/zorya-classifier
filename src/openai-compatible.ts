import { createVisionChat, visionOptionsSchema } from './infrastructure/vision-chat.js'
import type { VisionChatOptions } from './infrastructure/vision-chat.js'
import type { DecisionPort } from './entities/contracts.js'
import { validated } from './infrastructure/decision-transport/errors.js'

export type OpenAICompatibleVisionOptions = Omit<VisionChatOptions, 'provider' | 'providerName'>
const schema = visionOptionsSchema.omit({ provider: true, providerName: true }).strict()
/** Explicit trusted endpoint, including direct providers and local OpenAI-compatible servers. */
export function createOpenAICompatibleVision(input: OpenAICompatibleVisionOptions): DecisionPort {
  return createVisionChat(validated(schema, input, 'INVALID_INPUT'))
}
export type OpenAICompatibleTextOptions = OpenAICompatibleVisionOptions
/** Explicit endpoint for a text-only model. Image parts are rejected, never stripped. */
export function createOpenAICompatibleText(input: OpenAICompatibleTextOptions): DecisionPort {
  return createVisionChat(validated(schema, input, 'INVALID_INPUT'), 'text')
}
