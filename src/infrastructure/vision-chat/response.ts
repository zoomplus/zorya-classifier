import { z } from 'zod'
import type { DecisionRequest, DecisionResult } from '../../entities/contracts.js'
import { invalid, ownedError, validated } from '../decision-transport/errors.js'
import {
  acceptsResponseModel,
  unexpectedResponseProvider,
} from '../decision-transport/route-identity.js'
import type { ParsedVisionOptions } from './options.js'

const envelopeSchema = z.object({
  id: z.string().min(1).max(512).nullable().optional(),
  model: z.string().min(1).max(256).nullable().optional(),
  provider: z.string().min(1).max(256).nullable().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().optional(),
        finish_reason: z.string(),
        message: z.object({
          content: z.string().nullable(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .length(1),
  usage: z
    .object({ cost: z.number().finite().nonnegative().nullable().optional() })
    .nullable()
    .optional(),
})
const rankingSchema = z
  .object({ ranking: z.array(z.string().min(1).max(128)).min(1).max(4) })
  .strict()
const presenceSchema = z.object({ presence: z.enum(['present', 'absent', 'unknown']) }).strict()
const outputSchema = z.object({ answers: z.record(z.unknown()) }).strict()

export function parseVisionResult(
  raw: string,
  request: DecisionRequest,
  response: Response,
  options: ParsedVisionOptions,
  durationMs: number,
): DecisionResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw invalid('INVALID_RESPONSE', 'Vision provider returned invalid JSON')
  }
  const envelope = validated(envelopeSchema, json, 'INVALID_RESPONSE')
  if (envelope.model && !acceptsResponseModel(envelope.model, options))
    throw invalid('INVALID_RESPONSE', 'Vision provider returned an unexpected model')
  if (
    envelope.provider &&
    options.provider &&
    unexpectedResponseProvider(envelope.provider, options)
  )
    throw invalid('INVALID_RESPONSE', 'Vision provider returned an unexpected route')
  const choice = envelope.choices[0]
  if (choice?.finish_reason === 'length')
    throw ownedError('INVALID_RESPONSE', 'Model generation exceeded its output token limit', {
      reason: 'incomplete-generation',
      finishReason: 'length',
    })
  if (
    !choice ||
    choice.finish_reason !== 'stop' ||
    (choice.index !== undefined && choice.index !== 0) ||
    !choice.message.content ||
    choice.message.refusal ||
    choice.message.tool_calls?.length
  )
    throw invalid('INVALID_RESPONSE', 'Vision provider did not finish a usable classification')
  let content: unknown
  try {
    content = JSON.parse(choice.message.content)
  } catch {
    throw invalid('INVALID_RESPONSE', 'Vision model did not return strict JSON')
  }
  const value = validated(outputSchema, content, 'INVALID_RESPONSE')
  const questionIds = Object.keys(request.questions)
  if (
    Object.keys(value.answers).length !== questionIds.length ||
    questionIds.some((id) => !Object.hasOwn(value.answers, id))
  )
    throw invalid('INVALID_RESPONSE', 'Vision model returned mismatched questions')
  const answers: DecisionResult['answers'] = {}
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const answer = validated(rankingSchema, value.answers[id], 'INVALID_RESPONSE')
      if (
        answer.ranking.length !==
          Math.min(question.rankingSize ?? 4, Object.keys(question.criteria).length) ||
        new Set(answer.ranking).size !== answer.ranking.length ||
        answer.ranking.some((key) => !Object.hasOwn(question.criteria, key))
      )
        throw invalid('INVALID_RESPONSE', 'Vision model returned an invalid closed ranking')
      Object.defineProperty(answers, id, {
        value: { type: 'ranked-choice', ranking: [...answer.ranking] },
        enumerable: true,
      })
    } else {
      const answer = validated(presenceSchema, value.answers[id], 'INVALID_RESPONSE')
      Object.defineProperty(answers, id, {
        value: { type: 'presence', presence: answer.presence },
        enumerable: true,
      })
    }
  }
  const requestId = envelope.id ?? response.headers.get('x-generation-id')
  if (requestId !== null && requestId.length > 512)
    throw invalid('INVALID_RESPONSE', 'Vision provider returned an invalid request identity')
  return {
    answers,
    metadata: {
      model: envelope.model ?? null,
      provider: envelope.provider ?? null,
      requestId,
      durationMs,
      costUsd: envelope.usage?.cost ?? null,
      attempts: 1,
    },
  }
}
