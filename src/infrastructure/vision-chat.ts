import type { DecisionPort } from '../entities/contracts.js'
import { active, failure, invalid, ownedError, validated } from './decision-transport/errors.js'
import { readResponse } from './decision-transport/response.js'
import { visionOptionsSchema } from './vision-chat/options.js'
import type { VisionChatOptions } from './vision-chat/options.js'
import { serializeVisionRequest } from './vision-chat/request.js'
import { parseVisionResult } from './vision-chat/response.js'

export { visionOptionsSchema }
export type { VisionChatOptions }

/** Ordinary text/image chat completion, with no native classifier/Decisions requirement. */
export function createVisionChat(
  input: unknown,
  modality: 'vision' | 'text' = 'vision',
): DecisionPort {
  const options = validated(visionOptionsSchema, input, 'INVALID_INPUT')
  if (
    options.apiKey &&
    Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
  )
    throw invalid('INVALID_INPUT', 'Use apiKey or an Authorization header, not both')
  const fetcher = options.fetch ?? globalThis.fetch
  return {
    async decide(input, signal) {
      active(signal)
      let prepared: ReturnType<typeof serializeVisionRequest>
      try {
        prepared = serializeVisionRequest(input, options, modality)
      } catch (error) {
        throw failure(error, signal)
      }
      active(signal)
      const started = performance.now()
      let response: Response
      try {
        response = await fetcher(options.endpoint, {
          method: 'POST',
          headers: {
            ...options.headers,
            ...(options.apiKey === undefined ? {} : { Authorization: `Bearer ${options.apiKey}` }),
            'Content-Type': 'application/json',
          },
          body: prepared.body,
          signal,
          redirect: 'error',
        })
      } catch {
        active(signal)
        throw ownedError('PROVIDER', 'Vision provider transport failed')
      }
      try {
        const raw = await readResponse(response, signal, options.maxResponseBytes)
        const result = parseVisionResult(
          raw,
          prepared.request,
          response,
          options,
          Math.max(0, performance.now() - started),
        )
        active(signal)
        return result
      } catch (error) {
        throw failure(error, signal)
      }
    },
  }
}
