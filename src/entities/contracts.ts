import { z } from 'zod'
import { ClassifierError } from './errors.js'

export const limits = Object.freeze({
  imageBytes: 16 * 1024 * 1024,
  imagePixels: 16_777_216,
  bodyBytes: 32 * 1024 * 1024,
  maxClasses: 255,
  maxImages: 9,
})
export const pixelRectSchema = z
  .object({
    left: z.number().int().nonnegative().safe(),
    top: z.number().int().nonnegative().safe(),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
  })
  .strict()
export type PixelRect = z.infer<typeof pixelRectSchema>
export interface GridCell {
  id: string
  column: number
  row: number
  region: PixelRect
  xId?: string
  yId?: string
  kind?: 'cell'
}
export interface GridPanel {
  id: string
  region: PixelRect
  cells: readonly GridCell[]
}
export const classSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    description: z.string().trim().min(1).max(300),
  })
  .strict()
export type ClassDefinition = z.infer<typeof classSchema>
const imageSchema = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array)
  .refine(
    (v) => v.byteLength > 0 && v.byteLength <= limits.imageBytes,
    'Expected 1..16MiB image bytes',
  )
const mediaInputSchema = z
  .object({ text: z.string().trim().min(1).max(32000).optional(), image: imageSchema.optional() })
  .strict()
  .refine((v) => v.text !== undefined || v.image !== undefined, 'Provide text or image')
export const classifySchema = z
  .object({
    input: z.union([z.string().trim().min(1).max(32000), mediaInputSchema]),
    classes: z
      .array(classSchema)
      .min(2)
      .max(limits.maxClasses)
      .refine((v) => new Set(v.map((c) => c.id)).size === v.length, 'Class IDs must be unique'),
    instructions: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
export type ClassifyInput = z.input<typeof classifySchema> & { signal?: AbortSignal }
export const locateSchema = z
  .object({
    image: imageSchema,
    target: z.string().trim().min(1).max(2000),
    exclusions: z.array(z.string().trim().min(1).max(500)).max(16).default([]),
    roi: pixelRectSchema.optional(),
  })
  .strict()
export type LocateInput = z.input<typeof locateSchema> & { signal?: AbortSignal }
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
const metadataSchema = z.object({
  model: z.string().nullable(),
  provider: z.string().nullable(),
  requestId: z.string().nullable(),
  durationMs: z.number().finite().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
  attempts: z.number().int().positive(),
})
export const decisionResultSchema = z.object({ answers: answersSchema, metadata: metadataSchema })
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
interface LocalizationMetadata {
  image: { width: number; height: number; coordinateSpace: 'oriented-source-pixels' }
  stages: DecisionMetadata[]
  durationMs: number
  knownCostUsd: number
  unknownCostCount: number
}
export type LocalizationResult = (
  | {
      status: 'located'
      region: PixelRect
      normalizedRegion: PixelRect
      selection: ChoiceSelection
      method: 'three-choice-grid-v1'
      refinement?: RefinementResult
    }
  | { status: 'not-found'; reason: 'absent-in-evaluated-region' }
  | {
      status: 'unknown'
      reason:
        | 'uncertain-presence'
        | 'candidate-union-empty'
        | 'contradictory-evidence'
        | 'layout-limit'
    }
) & { metadata: LocalizationMetadata }
export type RefinementResult =
  | { status: 'refined'; region: PixelRect; method: string }
  | { status: 'unknown'; reason: string }
export interface RefinementPort {
  refine(input: {
    image: Uint8Array
    target: string
    region: PixelRect
    signal: AbortSignal
  }): Promise<RefinementResult>
}
export function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_RESPONSE' = 'INVALID_INPUT',
): T {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new ClassifierError(code, 'Schema validation failed', {
      paths: result.error.issues.map((v) => v.path.join('.')),
    })
  return result.data
}

export interface RasterImage {
  bytes: Uint8Array
  width: number
  height: number
}
export interface RasterPort {
  normalize(bytes: Uint8Array, signal: AbortSignal): Promise<RasterImage>
  crop(
    image: RasterImage,
    region: PixelRect,
    signal: AbortSignal,
    scale?: number,
  ): Promise<RasterImage>
  imageState(image: RasterImage, signal: AbortSignal): Promise<DecisionState>
  grid(
    image: RasterImage,
    region: PixelRect,
    cells: readonly GridCell[],
    labels: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<RasterImage>
}
