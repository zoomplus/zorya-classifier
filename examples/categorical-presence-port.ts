import {
  ClassifierError,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResult,
} from 'zorya-classifier'
import { z } from 'zod'

const presenceCriteria = {
  present: 'The exact proposition in the question instructions is true.',
  absent: 'The exact proposition in the question instructions is false.',
  unknown: 'The available evidence is insufficient to decide the exact proposition.',
} as const

const requestSchema = z
  .object({
    state: z.array(
      z.union([
        z.string(),
        z
          .object({
            type: z.literal('image_url'),
            image_url: z.object({ url: z.string().min(1), detail: z.literal('high') }).strict(),
          })
          .strict(),
      ]),
    ),
    questions: z.record(
      z.discriminatedUnion('type', [
        z
          .object({
            type: z.literal('choice'),
            rankingSize: z.union([z.literal(1), z.literal(4)]).optional(),
            instructions: z.string(),
            criteria: z.record(z.string()),
          })
          .strict(),
        z.object({ type: z.literal('noul'), instructions: z.string().min(1) }).strict(),
      ]),
    ),
  })
  .strict()

const metadataSchema = z
  .object({
    model: z.string().nullable(),
    provider: z.string().nullable(),
    requestId: z.string().nullable(),
    durationMs: z.number().finite().nonnegative(),
    costUsd: z.number().finite().nonnegative().nullable(),
    attempts: z.number().int().positive(),
  })
  .strict()
const answerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      choice: z.string(),
      probabilities: z.record(z.number().finite().min(0).max(1)),
      confidence: z.number().finite().min(0).max(1).optional(),
      probabilityRoundingStep: z.literal(0.01).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ranked-choice'),
      ranking: z.array(z.string().min(1).max(128)).min(1).max(4),
    })
    .strict(),
])
const responseSchema = z
  .object({ answers: z.record(answerSchema), metadata: metadataSchema })
  .strict()

function validateRequest(value: unknown): DecisionRequest {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success)
    throw new ClassifierError('INVALID_INPUT', 'Invalid categorical presence request')
  const questions: DecisionRequest['questions'] = {}
  for (const [id, question] of Object.entries(parsed.data.questions)) {
    if (question.type === 'noul') {
      questions[id] = { type: 'noul', instructions: question.instructions }
    } else {
      questions[id] =
        question.rankingSize === undefined
          ? {
              type: 'choice',
              instructions: question.instructions,
              criteria: structuredClone(question.criteria),
            }
          : {
              type: 'choice',
              rankingSize: question.rankingSize,
              instructions: question.instructions,
              criteria: structuredClone(question.criteria),
            }
    }
  }
  const copied: DecisionRequest = {
    state: structuredClone(parsed.data.state),
    questions,
  }
  const entries = Object.entries(copied.questions)
  if (entries.length === 0)
    throw new ClassifierError('INVALID_INPUT', 'At least one decision question is required')
  for (const [id, question] of entries) {
    if (!id || !question || (question.type !== 'choice' && question.type !== 'noul'))
      throw new ClassifierError('INVALID_INPUT', 'Unsupported decision question')
    if (question.type === 'choice') {
      const ids = Object.keys(question.criteria)
      if (ids.length < 2 || ids.some((key) => !key || typeof question.criteria[key] !== 'string'))
        throw new ClassifierError('INVALID_INPUT', 'Choice needs at least two closed criteria')
    } else if (typeof question.instructions !== 'string' || question.instructions.length === 0) {
      throw new ClassifierError('INVALID_INPUT', 'Presence proposition must be non-empty')
    }
  }
  return copied
}

function validateChoice(
  id: string,
  criteria: Record<string, string>,
  answer: z.infer<typeof answerSchema>,
  rankingSize = 1,
) {
  const ids = Object.keys(criteria)
  if (answer.type === 'ranked-choice') {
    if (
      answer.ranking.length !== Math.min(rankingSize, ids.length) ||
      new Set(answer.ranking).size !== answer.ranking.length ||
      answer.ranking.some((key) => !ids.includes(key))
    )
      throw new ClassifierError('INVALID_RESPONSE', `Invalid closed ranking for ${id}`)
    return answer.ranking[0]!
  }
  if (
    Object.keys(answer.probabilities).length !== ids.length ||
    ids.some((key) => !Object.hasOwn(answer.probabilities, key))
  )
    throw new ClassifierError('INVALID_RESPONSE', `Incomplete Choice distribution for ${id}`)
  const values = ids.map((key) => answer.probabilities[key]!)
  const mass = values.reduce((sum, n) => sum + n, 0)
  const rounded =
    answer.probabilityRoundingStep === 0.01 &&
    values.every((n) => Math.abs(n - Math.round(n / 0.01) * 0.01) <= 1e-12)
  const roundingCanCoverOne =
    rounded &&
    values.reduce((sum, n) => sum + Math.max(0, n - 0.005), 0) <= 1 + 1e-12 &&
    values.reduce((sum, n) => sum + Math.min(1, n + 0.005), 0) >= 1 - 1e-12
  if (Math.abs(mass - 1) > 1e-6 && !roundingCanCoverOne)
    throw new ClassifierError('INVALID_RESPONSE', `Invalid Choice distribution for ${id}`)
  const max = Math.max(...values)
  if (!ids.includes(answer.choice) || answer.probabilities[answer.choice] !== max)
    throw new ClassifierError(
      'INVALID_RESPONSE',
      `Choice contradicts maximum probability for ${id}`,
    )
  // Stable order follows the closed criteria; never trust a provider's tie-breaker.
  return ids.find((key) => answer.probabilities[key] === max)!
}

/**
 * Caller-owned one-route experiment: existing Choice questions are passed through;
 * each Noul proposition becomes one closed categorical Choice in the same call.
 */
export function createCategoricalPresencePort(delegate: DecisionPort): DecisionPort {
  if (!delegate || typeof delegate.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'A DecisionPort is required')
  return {
    async decide(input, signal): Promise<DecisionResult> {
      if (!signal || signal.aborted)
        throw new ClassifierError('ABORTED', 'Decision request was aborted')
      const request = validateRequest(input)
      const outgoing: DecisionRequest = { state: structuredClone(request.state), questions: {} }
      for (const [id, question] of Object.entries(request.questions)) {
        outgoing.questions[id] =
          question.type === 'choice'
            ? structuredClone(question)
            : {
                type: 'choice',
                rankingSize: 1,
                instructions:
                  'Judge the exact proposition stated in the original question instructions. Choose present only when that proposition is true, absent only when it is false, and unknown when the available evidence is insufficient. Do not infer a numeric score or replace the proposition with a different one.\n\nExact proposition:\n' +
                  question.instructions,
                criteria: { ...presenceCriteria },
              }
      }
      // The request and nested state are owned before control crosses the async boundary.
      const raw: unknown = await delegate.decide(outgoing, signal)
      if (signal.aborted) throw new ClassifierError('ABORTED', 'Decision request was aborted')
      const result = responseSchema.safeParse(raw)
      if (!result.success)
        throw new ClassifierError('INVALID_RESPONSE', 'Malformed categorical Choice response')
      if (Object.keys(result.data.answers).length !== Object.keys(outgoing.questions).length)
        throw new ClassifierError('INVALID_RESPONSE', 'Question count mismatch')
      const answers: DecisionResult['answers'] = {}
      for (const [id, original] of Object.entries(request.questions)) {
        const answer = result.data.answers[id]
        if (!answer) throw new ClassifierError('INVALID_RESPONSE', `Missing answer for ${id}`)
        if (original.type === 'choice') {
          validateChoice(id, original.criteria, answer, original.rankingSize ?? 4)
          answers[id] = answer
          continue
        }
        const choice = validateChoice(id, presenceCriteria, answer)
        if (choice !== 'present' && choice !== 'absent' && choice !== 'unknown')
          throw new ClassifierError('INVALID_RESPONSE', `Unknown presence label for ${id}`)
        answers[id] = { type: 'presence', presence: choice }
      }
      return { answers, metadata: result.data.metadata }
    },
  }
}
