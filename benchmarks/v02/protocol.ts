import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DecisionRequest } from '../../src/entities/contracts.js'

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
