import { z } from 'zod'

export type ImagePart = { type: 'image_url'; image_url: { url: string; detail: 'high' } }
export type DecisionState = (string | ImagePart)[]
export type ChoiceQuestion = {
  type: 'choice'
  rankingSize?: 1 | 4
  instructions: string
  criteria: Record<string, string>
}
type NoulQuestion = { type: 'noul'; instructions: string }
type DecisionQuestion = ChoiceQuestion | NoulQuestion
export type DecisionRequest = { state: DecisionState; questions: Record<string, DecisionQuestion> }
export interface DecisionMetadata {
  model: string | null
  provider: string | null
  requestId: string | null
  durationMs: number
  costUsd: number | null
  attempts: number
}
const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1).optional(),
  probabilityRoundingStep: z.literal(0.01).optional(),
})
export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>
const answersSchema = z.record(
  z.discriminatedUnion('type', [
    choiceAnswerSchema,
    z
      .object({
        type: z.literal('ranked-choice'),
        ranking: z.array(z.string().min(1).max(128)).min(1).max(4),
      })
      .strict(),
    z
      .object({ type: z.literal('presence'), presence: z.enum(['present', 'absent', 'unknown']) })
      .strict(),
    z.object({ type: z.literal('noul'), noul: z.number().finite().min(0).max(1) }),
  ]),
)
export const decisionMetadataSchema = z.object({
  model: z.string().nullable(),
  provider: z.string().nullable(),
  requestId: z.string().nullable(),
  durationMs: z.number().finite().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
  attempts: z.number().int().positive(),
})
export const decisionResultSchema = z.object({
  answers: answersSchema,
  metadata: decisionMetadataSchema,
})
export type DecisionResult = z.infer<typeof decisionResultSchema>
export interface DecisionPort {
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>
}
export interface ChoiceSelection {
  choice: string
  nativeChoice: string | null
  probabilities: Record<string, number> | null
  ranking?: string[]
  confidence?: number
  probabilityRoundingStep?: 0.01
  tied: string[]
}
export interface ClassificationResult extends ChoiceSelection {
  metadata: DecisionMetadata
}
