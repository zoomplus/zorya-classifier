import { z } from 'zod'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import { acceptsChoiceMass } from '../shared/choice-mass.js'
import { active, failure, invalid, ownedError, validated } from './decision-transport/errors.js'
import { validateImage } from './decision-transport/images.js'
import {
  key,
  preflightJson,
  probability,
  requestLimit,
  requestSchema,
  responseLimit,
} from './decision-transport/request.js'
import { readResponse } from './decision-transport/response.js'
import {
  acceptsResponseModel,
  unexpectedResponseProvider,
} from './decision-transport/route-identity.js'

const endpoint = 'https://openrouter.ai/api/alpha/decisions'
const responseSchema = z
  .object({
    id: z.string().min(1).max(512).nullable().optional(),
    model: z.string().min(1).max(128).nullable().optional(),
    provider: z.string().min(1).max(128).nullable().optional(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
        cost: z.number().finite().nonnegative().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    answers: z.record(
      key,
      z.discriminatedUnion('type', [
        z
          .object({
            type: z.literal('choice'),
            choice: key,
            probabilities: z.record(key, probability),
            confidence: probability.optional(),
          })
          .strict(),
        z.object({ type: z.literal('noul'), noul: probability }).strict(),
      ]),
    ),
  })
  .strict()

export interface OpenRouterJevOptions {
  apiKey: string
  fetch?: typeof globalThis.fetch
  maxRequestBytes?: number
  maxResponseBytes?: number
}
const legacyOptionsSchema = z
  .object({
    apiKey: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/\s/u.test(value)),
    fetch: z.custom<typeof globalThis.fetch>((value) => typeof value === 'function').optional(),
    maxRequestBytes: z.number().int().min(1).max(requestLimit).default(requestLimit),
    maxResponseBytes: z.number().int().min(1).max(responseLimit).default(responseLimit),
  })
  .strict()
export interface OpenRouterDecisionsOptions extends OpenRouterJevOptions {
  model: string
  provider: string
  providerName?: string
  responseModelIds?: string[]
  /** Only enable after confirming this wire quantization for the selected model. */
  probabilityRoundingStep?: 0.01
}
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u)
const optionsSchema = legacyOptionsSchema
  .extend({
    model: identifier,
    provider: identifier,
    providerName: z.string().min(1).max(256).optional(),
    responseModelIds: z.array(identifier).max(8).optional(),
    probabilityRoundingStep: z.literal(0.01).optional(),
  })
  .strict()
type Options = z.infer<typeof optionsSchema>
function serialize(
  input: DecisionRequest,
  maxBytes: number,
  options: Options,
): { request: DecisionRequest; body: string } {
  const envelope = {
    model: options.model,
    provider: { only: [options.provider], allow_fallbacks: false },
  }
  const snapshot = preflightJson(input, maxBytes - Buffer.byteLength(JSON.stringify(envelope)) + 1)
  const request = validated(requestSchema, snapshot, 'INVALID_INPUT')
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      question.type === 'choice'
        ? { type: question.type, instructions: question.instructions, criteria: question.criteria }
        : question,
    ]),
  )
  const body = JSON.stringify({ ...request, questions, ...envelope })
  if (Buffer.byteLength(body) > maxBytes)
    throw ownedError('RESOURCE_LIMIT', 'Decision request exceeds byte limit')
  for (const part of request.state) if (typeof part !== 'string') validateImage(part.image_url.url)
  return { request, body }
}
function result(
  raw: string,
  request: DecisionRequest,
  response: Response,
  durationMs: number,
  options: Options,
): DecisionResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw invalid('INVALID_RESPONSE', 'Provider returned invalid JSON')
  }
  const value = validated(responseSchema, json, 'INVALID_RESPONSE')
  if (value.model && !acceptsResponseModel(value.model, options))
    throw invalid('INVALID_RESPONSE', 'Provider returned an unexpected model')
  if (value.provider && unexpectedResponseProvider(value.provider, options))
    throw invalid('INVALID_RESPONSE', 'Provider returned an unexpected route')
  const questionIds = Object.keys(request.questions)
  if (Object.keys(value.answers).length !== questionIds.length)
    throw invalid('INVALID_RESPONSE', 'Provider returned mismatched questions')
  const answers: DecisionResult['answers'] = { ...value.answers }
  for (const id of questionIds) {
    const question = request.questions[id],
      answer = value.answers[id]
    if (!question || !answer || question.type !== answer.type)
      throw invalid('INVALID_RESPONSE', 'Provider returned mismatched answer types')
    if (question.type === 'choice' && answer.type === 'choice') {
      const keys = Object.keys(question.criteria)
      const scores = answer.probabilities
      if (
        Object.keys(scores).length !== keys.length ||
        keys.some((option) => !Object.hasOwn(scores, option)) ||
        !Object.hasOwn(question.criteria, answer.choice) ||
        scores[answer.choice] !== Math.max(...Object.values(scores)) ||
        !acceptsChoiceMass(Object.values(scores), options.probabilityRoundingStep)
      )
        throw invalid('INVALID_RESPONSE', 'Provider returned an invalid choice distribution')
      // Explicitly configured wire quantization; retain raw scores and native ties.
      if (!acceptsChoiceMass(Object.values(scores)))
        answers[id] = { ...answer, probabilityRoundingStep: 0.01 }
    }
  }
  const requestId = value.id ?? response.headers.get('x-generation-id')
  if (requestId !== null && requestId.length > 512)
    throw invalid('INVALID_RESPONSE', 'Provider returned an invalid request identity')
  return {
    answers,
    metadata: {
      model: value.model ?? null,
      provider: value.provider ?? null,
      requestId,
      costUsd: value.usage?.cost ?? null,
      durationMs,
      attempts: 1,
    },
  }
}
/** One pinned provider call; the caller owns the absolute deadline through its signal. */
export function createOpenRouterDecisions(input: OpenRouterDecisionsOptions): DecisionPort {
  const options = validated(optionsSchema, input, 'INVALID_INPUT')
  const fetcher = options.fetch ?? globalThis.fetch
  return {
    async decide(input, signal) {
      active(signal)
      let prepared: ReturnType<typeof serialize>
      try {
        prepared = serialize(input, options.maxRequestBytes, options)
      } catch (error) {
        active(signal)
        if (error instanceof ClassifierError) throw error
        throw invalid('INVALID_INPUT', 'Decision input could not be serialized')
      }
      active(signal)
      const started = performance.now()
      let response: Response
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: prepared.body,
          signal,
          redirect: 'error',
        })
      } catch {
        active(signal)
        throw ownedError('PROVIDER', 'OpenRouter transport failed')
      }
      try {
        const raw = await readResponse(response, signal, options.maxResponseBytes)
        const value = result(
          raw,
          prepared.request,
          response,
          Math.max(0, performance.now() - started),
          options,
        )
        active(signal)
        return value
      } catch (error) {
        throw failure(error, signal)
      }
    },
  }
}

/** Optional historical integration; never an automatic fallback. */
export function createOpenRouterJev(input: OpenRouterJevOptions): DecisionPort {
  const { fetch: fetcher, ...options } = validated(legacyOptionsSchema, input, 'INVALID_INPUT')
  return createOpenRouterDecisions({
    ...options,
    ...(fetcher ? { fetch: fetcher } : {}),
    model: 'typesafe/jev-1.14',
    provider: 'typesafe',
    probabilityRoundingStep: 0.01,
  })
}
