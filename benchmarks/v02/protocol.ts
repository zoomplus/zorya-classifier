import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DecisionRequest, DecisionResult, PixelRect } from '../../src/entities/contracts.js'
import { pixelRectSchema } from '../../src/entities/contracts.js'
import { validateDecision } from '../../src/features/choice.js'

export const sourceSchema = z
  .object({
    caseId: z.string().regex(/^photo-dev-\d{2}$/u),
    image: z
      .object({
        path: z
          .string()
          .min(1)
          .refine((value) => !value.startsWith('/') && !value.includes('..')),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    target: z.string().min(1).max(200),
  })
  .strict()
export const inputManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestId: z.literal('old-exposed-dev4-diagnostic-v1'),
    cases: z.array(sourceSchema).length(4),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.cases.map((item) => item.caseId)).size !== 4)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Case IDs must be unique' })
  })
export type ProducerCase = z.infer<typeof sourceSchema>
export type ProducerManifest = z.infer<typeof inputManifestSchema>

export const modelRequestManifest = {
  modelFields: ['task', 'target', 'closed_options', 'encoded_image_data'],
  forbiddenFields: [
    'case_id',
    'local_path',
    'source_hash',
    'split',
    'ground_truth',
    'expected_answer',
  ],
  neverSendEvaluatorTruth: true,
} as const

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sanitizeDecisionRequest(request: DecisionRequest) {
  return {
    requestSha256: hashCanonical(request),
    stateParts: request.state.map((part) =>
      typeof part === 'string'
        ? { type: 'text', utf8Bytes: Buffer.byteLength(part, 'utf8'), sha256: hashCanonical(part) }
        : { type: 'image_url' as const },
    ),
    questions: Object.entries(request.questions).map(([id, question]) => ({
      id,
      type: question.type,
      ...(question.type === 'choice' ? { optionIds: Object.keys(question.criteria) } : {}),
    })),
  }
}

const traceQuestionIds = [
  'selection',
  'presence',
  'instance',
  'left',
  'right',
  'top',
  'bottom',
] as const
const axisIds = ['left', 'right', 'top', 'bottom'] as const
type TraceQuestionId = (typeof traceQuestionIds)[number]
type AxisId = (typeof axisIds)[number]
const intervalSchema = z
  .object({
    start: z.number().int().nonnegative().safe(),
    endExclusive: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => value.start < value.endExclusive)
const sourceRegionSchema = z
  .object({
    optionId: z.string().regex(/^(?:P\d{2}|C\d{3}|[A-H]|none)$/u),
    region: pixelRectSchema,
  })
  .strict()
const intervalOptionSchema = z
  .object({
    optionId: z.string().regex(/^(?:left|right|top|bottom)(?:0[0-9]|1[0-5])$/u),
    start: z.number().int().nonnegative().safe(),
    endExclusive: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => value.start < value.endExclusive)
const probabilitySchema = z
  .object({
    optionId: z
      .string()
      .regex(
        /^(?:P\d{2}|C\d{3}|[A-H]|none|same|different|ambiguous|(?:left|right|top|bottom)(?:0[0-9]|1[0-5])|unknown)$/u,
      ),
    value: z.number().finite().min(0).max(1),
  })
  .strict()
const traceQuestionSchema = z.discriminatedUnion('answerType', [
  z
    .object({
      questionId: z.enum(traceQuestionIds),
      answerType: z.literal('choice'),
      selected: z
        .string()
        .regex(
          /^(?:P\d{2}|C\d{3}|[A-H]|none|same|different|ambiguous|(?:left|right|top|bottom)(?:0[0-9]|1[0-5])|unknown)$/u,
        ),
      probabilities: z.array(probabilitySchema).max(255).optional(),
      ranking: z
        .array(
          z
            .string()
            .regex(
              /^(?:P\d{2}|C\d{3}|[A-H]|none|same|different|ambiguous|(?:left|right|top|bottom)(?:0[0-9]|1[0-5])|unknown)$/u,
            ),
        )
        .max(4)
        .optional(),
      intervalOptions: z.array(intervalOptionSchema).max(255).optional(),
      selectedSourceRegions: z.array(sourceRegionSchema).max(4).optional(),
    })
    .strict(),
  z
    .object({
      questionId: z.enum(traceQuestionIds),
      answerType: z.literal('ranked-choice'),
      ranking: z
        .array(z.string().regex(/^(?:P\d{2}|C\d{3}|[A-H]|none|same|different|ambiguous)$/u))
        .min(1)
        .max(4),
      selectedSourceRegions: z.array(sourceRegionSchema).max(4).optional(),
    })
    .strict(),
  z
    .object({
      questionId: z.literal('presence'),
      answerType: z.literal('noul'),
      value: z.number().finite().min(0).max(1),
    })
    .strict(),
  z
    .object({
      questionId: z.literal('presence'),
      answerType: z.literal('presence'),
      value: z.enum(['present', 'absent', 'unknown']),
    })
    .strict(),
])
const imageTransformSchema = z
  .object({
    viewId: z.string().nullable(),
    role: z.enum(['source', 'crop', 'grid', 'image-state']),
    sourceRegion: pixelRectSchema.nullable(),
    source: z
      .object({
        width: z.number().int().positive().max(16384),
        height: z.number().int().positive().max(16384),
      })
      .strict(),
    output: z
      .object({
        width: z.number().int().positive().max(16384),
        height: z.number().int().positive().max(16384),
      })
      .strict(),
    content: pixelRectSchema,
    scaleX: z.number().finite().positive(),
    scaleY: z.number().finite().positive(),
  })
  .strict()
const boundsSchema = z
  .object({
    left: intervalSchema,
    right: intervalSchema,
    top: intervalSchema,
    bottom: intervalSchema,
  })
  .strict()
const geometryTraceSchema = z
  .object({
    seedRegion: pixelRectSchema.nullable(),
    currentBounds: boundsSchema.nullable(),
    imageTransforms: z.array(imageTransformSchema).max(16),
  })
  .strict()
const decisionTraceSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('recorded'),
      questions: z.array(traceQuestionSchema).max(16),
      geometry: geometryTraceSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('omitted'),
      reason: z.enum([
        'invalid-decision-result',
        'unrecognized-question-id',
        'unrecognized-option-id',
        'question-limit-exceeded',
        'option-limit-exceeded',
        'byte-budget-exceeded',
        'trace-build-failed',
      ]),
    })
    .strict(),
])
export type DecisionTrace = z.infer<typeof decisionTraceSchema>

const traceByteLimit = 64 * 1024
const geometryScanByteLimit = 256 * 1024
const geometryPartByteLimit = 64 * 1024
const generatedLabel = /^(?:P\d{2}|C\d{3}|[A-H]|none)$/u
const generatedAxisLabel = /^(?:left|right|top|bottom)(?:0[0-9]|1[0-5])$/u

const gridMetadataSchema = z
  .object({
    panel: z.string().regex(/^(?:FRAME|p[0-3])$/u),
    sourceRegion: pixelRectSchema,
    labels: z
      .array(
        z.object({ id: z.string().regex(generatedLabel), sourceRegion: pixelRectSchema }).strict(),
      )
      .max(255),
  })
  .strict()
  .superRefine((grid, context) => {
    const ids = new Set<string>()
    for (const label of grid.labels) {
      if (ids.has(label.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate generated grid label' })
        return
      }
      ids.add(label.id)
      const right = label.sourceRegion.left + label.sourceRegion.width
      const bottom = label.sourceRegion.top + label.sourceRegion.height
      if (
        !Number.isSafeInteger(right) ||
        !Number.isSafeInteger(bottom) ||
        label.sourceRegion.left < grid.sourceRegion.left ||
        label.sourceRegion.top < grid.sourceRegion.top ||
        right > grid.sourceRegion.left + grid.sourceRegion.width ||
        bottom > grid.sourceRegion.top + grid.sourceRegion.height
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Grid cell escaped its source panel',
        })
        return
      }
    }
  })
const seedMetadataSchema = z.object({ seedRegion: pixelRectSchema }).strict()
const extentMetadataSchema = z
  .object({
    pass: z.number().int().min(1).max(3),
    seedRegion: pixelRectSchema,
    currentBounds: boundsSchema,
  })
  .strict()
const transformMetadataSchema = z
  .object({
    sourceImageTransform: z
      .object({
        source: z
          .object({
            width: z.number().int().positive().max(16384),
            height: z.number().int().positive().max(16384),
          })
          .strict(),
        output: z
          .object({
            width: z.number().int().positive().max(16384),
            height: z.number().int().positive().max(16384),
          })
          .strict(),
        content: pixelRectSchema,
        scaleX: z.number().finite().positive(),
        scaleY: z.number().finite().positive(),
      })
      .strict(),
  })
  .strict()
const viewIdSchema = z.string().regex(/^(?:source|seed|FRAME-grid|p[0-3]-grid|candidate-[A-H])$/u)
const textViewMetadataSchema = z
  .object({
    representationView: z
      .object({
        id: viewIdSchema,
        aliases: z
          .array(
            z
              .object({
                id: viewIdSchema,
                role: z.enum(['source', 'crop', 'grid']),
                sourceRegion: pixelRectSchema,
              })
              .strict(),
          )
          .min(1)
          .max(9),
        sourceRegion: pixelRectSchema,
        dimensions: z
          .object({
            width: z.number().int().positive().max(64),
            height: z.number().int().positive().max(64),
          })
          .strict(),
        scaleX: z.number().finite().positive(),
        scaleY: z.number().finite().positive(),
        grid: z
          .array(
            z
              .object({
                viewId: viewIdSchema,
                cells: z
                  .array(
                    z
                      .object({
                        id: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/u),
                        column: z.number().int().nonnegative().max(16384),
                        row: z.number().int().nonnegative().max(16384),
                        region: pixelRectSchema,
                        label: z.string().regex(generatedLabel).nullable(),
                      })
                      .strict(),
                  )
                  .max(255),
              })
              .strict(),
          )
          .max(9),
      })
      .strict(),
  })
  .strict()

interface RequestGeometry {
  seedRegion: PixelRect | null
  currentBounds: z.infer<typeof boundsSchema> | null
  grids: Map<string, PixelRect>
  ambiguousGridLabels: Set<string>
  transforms: {
    viewId: string | null
    role: 'source' | 'crop' | 'grid' | 'image-state'
    sourceRegion: PixelRect | null
    source: { width: number; height: number }
    output: { width: number; height: number }
    content: PixelRect
    scaleX: number
    scaleY: number
  }[]
}

function requestGeometry(request: DecisionRequest): RequestGeometry {
  const result: RequestGeometry = {
    seedRegion: null,
    currentBounds: null,
    grids: new Map(),
    ambiguousGridLabels: new Set(),
    transforms: [],
  }
  let scanned = 0
  for (const part of request.state) {
    if (typeof part !== 'string' || !part.startsWith('{')) continue
    const size = Buffer.byteLength(part, 'utf8')
    if (size > geometryPartByteLimit || scanned + size > geometryScanByteLimit) continue
    scanned += size
    let parsed: unknown
    try {
      parsed = JSON.parse(part)
    } catch {
      continue
    }
    const extent = extentMetadataSchema.safeParse(parsed)
    if (extent.success) {
      result.seedRegion = extent.data.seedRegion
      result.currentBounds = extent.data.currentBounds
      continue
    }
    const seed = seedMetadataSchema.safeParse(parsed)
    if (seed.success) {
      result.seedRegion = seed.data.seedRegion
      continue
    }
    const grid = gridMetadataSchema.safeParse(parsed)
    if (grid.success) {
      for (const item of grid.data.labels) rememberGridLabel(result, item.id, item.sourceRegion)
      continue
    }
    const transform = transformMetadataSchema.safeParse(parsed)
    if (transform.success) {
      const value = transform.data.sourceImageTransform
      result.transforms.push({
        viewId: null,
        role: 'image-state',
        sourceRegion: null,
        source: value.source,
        output: value.output,
        content: value.content,
        scaleX: value.scaleX,
        scaleY: value.scaleY,
      })
      continue
    }
    const textView = textViewMetadataSchema.safeParse(parsed)
    if (textView.success) {
      const view = textView.data.representationView
      const role = view.aliases.find((alias) => alias.id === view.id)?.role
      result.transforms.push({
        viewId: view.id,
        role: role ?? 'source',
        sourceRegion: view.sourceRegion,
        source: { width: view.sourceRegion.width, height: view.sourceRegion.height },
        output: view.dimensions,
        content: { left: 0, top: 0, width: view.dimensions.width, height: view.dimensions.height },
        scaleX: view.scaleX,
        scaleY: view.scaleY,
      })
      for (const grid of view.grid)
        for (const cell of grid.cells)
          if (cell.label !== null) rememberGridLabel(result, cell.label, cell.region)
    }
  }
  return result
}

function rememberGridLabel(geometry: RequestGeometry, id: string, region: PixelRect) {
  if (geometry.ambiguousGridLabels.has(id)) return
  const previous = geometry.grids.get(id)
  if (
    previous &&
    (previous.left !== region.left ||
      previous.top !== region.top ||
      previous.width !== region.width ||
      previous.height !== region.height)
  ) {
    geometry.grids.delete(id)
    geometry.ambiguousGridLabels.add(id)
    return
  }
  geometry.grids.set(id, region)
}

function validQuestionId(id: string): id is TraceQuestionId {
  return (traceQuestionIds as readonly string[]).includes(id)
}

function validOptionId(questionId: TraceQuestionId, id: string): boolean {
  if (questionId === 'selection') return generatedLabel.test(id)
  if (questionId === 'instance') return ['same', 'different', 'ambiguous'].includes(id)
  if (axisIds.includes(questionId as AxisId))
    return id === 'unknown' || (generatedAxisLabel.test(id) && id.startsWith(questionId))
  return false
}

function intervalOptions(questionId: string, criteria: Record<string, string>) {
  if (!axisIds.includes(questionId as AxisId)) return []
  return Object.entries(criteria).flatMap(([optionId, criterion]) => {
    if (!generatedAxisLabel.test(optionId) || !optionId.startsWith(questionId)) return []
    const match = /^Integer boundary coordinates in \[(\d+), (\d+)\)\.$/u.exec(criterion)
    if (!match) return []
    const start = Number(match[1])
    const endExclusive = Number(match[2])
    return Number.isSafeInteger(start) && Number.isSafeInteger(endExclusive) && start < endExclusive
      ? [{ optionId, start, endExclusive }]
      : []
  })
}

function selectedSourceRegions(labels: readonly string[], geometry: RequestGeometry) {
  return labels.flatMap((optionId) => {
    const region = geometry.grids.get(optionId)
    return region ? [{ optionId, region }] : []
  })
}

function buildDecisionTrace(request: DecisionRequest, result: DecisionResult): DecisionTrace {
  const ids = Object.keys(request.questions)
  if (ids.length < 1 || ids.length > 16)
    return { status: 'omitted', reason: 'question-limit-exceeded' }
  if (ids.some((id) => !validQuestionId(id)))
    return { status: 'omitted', reason: 'unrecognized-question-id' }
  const optionCount = ids.reduce((sum, id) => {
    const question = request.questions[id]
    return sum + (question?.type === 'choice' ? Object.keys(question.criteria).length : 0)
  }, 0)
  if (optionCount > 255) return { status: 'omitted', reason: 'option-limit-exceeded' }
  if (
    ids.some((id) => {
      const question = request.questions[id]
      return (
        question?.type === 'choice' &&
        Object.keys(question.criteria).some(
          (optionId) => !validOptionId(id as TraceQuestionId, optionId),
        )
      )
    })
  )
    return { status: 'omitted', reason: 'unrecognized-option-id' }

  const geometry = requestGeometry(request)
  const questions = ids.map((questionId) => {
    const question = request.questions[questionId]!
    const answer = result.answers[questionId]!
    if (question.type === 'noul') {
      if (answer.type === 'noul')
        return {
          questionId: questionId as TraceQuestionId,
          answerType: 'noul' as const,
          value: answer.noul,
        }
      if (answer.type === 'presence')
        return {
          questionId: questionId as TraceQuestionId,
          answerType: 'presence' as const,
          value: answer.presence,
        }
      throw new Error('Validated result did not match trace question type')
    }
    if (answer.type === 'ranked-choice') {
      return {
        questionId: questionId as TraceQuestionId,
        answerType: 'ranked-choice' as const,
        ranking: answer.ranking,
        selectedSourceRegions: selectedSourceRegions(answer.ranking, geometry),
      }
    }
    if (answer.type !== 'choice')
      throw new Error('Validated result did not match trace question type')
    const selected = [answer.choice]
    return {
      questionId: questionId as TraceQuestionId,
      answerType: 'choice' as const,
      selected: answer.choice,
      probabilities: Object.keys(question.criteria).map((optionId) => ({
        optionId,
        value: answer.probabilities[optionId]!,
      })),
      intervalOptions: intervalOptions(questionId, question.criteria),
      selectedSourceRegions: selectedSourceRegions(selected, geometry),
    }
  })
  const imageTransforms = geometry.transforms.map((transform) => ({
    viewId: transform.viewId,
    role: transform.role,
    sourceRegion: transform.sourceRegion,
    source: transform.source,
    output: transform.output,
    content: transform.content,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
  }))
  const candidate = decisionTraceSchema.safeParse({
    status: 'recorded',
    questions,
    geometry: {
      seedRegion: geometry.seedRegion,
      currentBounds: geometry.currentBounds,
      imageTransforms,
    },
  })
  if (!candidate.success) return { status: 'omitted', reason: 'trace-build-failed' }
  if (Buffer.byteLength(`${JSON.stringify(candidate.data, null, 2)}\n`, 'utf8') > traceByteLimit)
    return { status: 'omitted', reason: 'byte-budget-exceeded' }
  return candidate.data
}

export function createDecisionTrace(
  request: DecisionRequest,
  value: unknown,
): {
  result?: DecisionResult
  trace: DecisionTrace
} {
  let result: DecisionResult
  try {
    result = validateDecision(request, value)
  } catch {
    return { trace: { status: 'omitted', reason: 'invalid-decision-result' } }
  }
  try {
    return { result, trace: buildDecisionTrace(request, result) }
  } catch {
    return { result, trace: { status: 'omitted', reason: 'trace-build-failed' } }
  }
}
