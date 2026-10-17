import { z } from 'zod'
import type { DecisionPort } from '../entities/contracts.js'
import { createOpenAICompatibleVision } from '../openai-compatible.js'
import { createOpenRouterVision, createOpenRouterDecisions } from '../openrouter.js'

/** CLI composition only; no environment reads or network activity during import. */
export function createCliDecision(environment: NodeJS.ProcessEnv): DecisionPort {
  const model = environment['ZORYA_MODEL']
  if (!model) throw new Error('Set ZORYA_MODEL to your explicit model ID')
  const reasoning = environment['ZORYA_REASONING_EFFORT']
  const reasoningEffort = reasoning
    ? z.enum(['none', 'minimal', 'low', 'medium', 'high']).parse(reasoning)
    : undefined
  const format = environment['ZORYA_RESPONSE_FORMAT']
  const responseFormat = format
    ? z.enum(['prompt', 'json-object', 'json-schema']).parse(format)
    : undefined
  const common = {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(responseFormat ? { responseFormat } : {}),
  }
  const mode = z.enum(['decisions', 'chat']).parse(environment['ZORYA_MODE'] || 'decisions')
  const endpoint = environment['ZORYA_ENDPOINT']
  if (endpoint) {
    if (mode !== 'chat')
      throw new Error('Custom chat-completions endpoint requires ZORYA_MODE=chat')
    // Never forward a pre-existing OpenRouter credential to a custom endpoint.
    const apiKey = environment['ZORYA_API_KEY']
    return createOpenAICompatibleVision({ endpoint, ...common, ...(apiKey ? { apiKey } : {}) })
  }
  const apiKey = environment['OPENROUTER_API_KEY'],
    provider = environment['ZORYA_PROVIDER']
  if (!apiKey || !provider)
    throw new Error(
      'OpenRouter mode requires OPENROUTER_API_KEY and ZORYA_PROVIDER; direct mode uses ZORYA_ENDPOINT and optional ZORYA_API_KEY',
    )
  if (mode === 'decisions') {
    if (reasoningEffort || responseFormat)
      throw new Error('Reasoning and response-format options apply only to ZORYA_MODE=chat')
    return createOpenRouterDecisions({ apiKey, provider, model })
  }
  return createOpenRouterVision({ apiKey, provider, ...common })
}
