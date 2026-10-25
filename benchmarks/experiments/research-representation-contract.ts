import { z } from 'zod'

import type { ClassifyInput } from '../../src/entities/contracts.js'
import { pixelRectSchema } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import { parse } from '../../src/entities/contracts.js'
import type { ComposedClassifier } from '../../src/app/composed-classifier.js'
import type { ImageRepresentationPort } from '../../src/entities/representation.js'

/** Benchmark-only selector retired from public runtime; not exported from npm `dist`. */
export const researchRepresentationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('vision') }).strict(),
  z.object({ type: z.literal('experimental-text'), profile: z.literal('text-image-v1') }).strict(),
])

export type ResearchRepresentation = z.infer<typeof researchRepresentationSchema>

type WithResearchRepresentation<T extends { representation?: unknown }> = Omit<
  T,
  'representation'
> & {
  representation?: ResearchRepresentation
}

export type ResearchClassifyInput = WithResearchRepresentation<ClassifyInput>

export type ResearchClassifier = ComposedClassifier<ResearchRepresentation>

export function acceptsResearchTextRepresentation(raw: unknown): boolean {
  const parsed = researchRepresentationSchema.safeParse(raw)
  return parsed.success && parsed.data.type === 'experimental-text'
}

export const representationLimits = Object.freeze({
  totalBytes: 64 * 1024,
  partCharacters: 64000,
  maxSide: 64,
  maxViews: 9,
})

const preparedTextSchema = z
  .object({
    state: z.array(z.string().min(1).max(representationLimits.partCharacters)).min(1).max(64),
    metadata: z
      .object({
        profile: z.string().min(1).max(128),
        bytes: z.number().int().nonnegative().max(representationLimits.totalBytes),
        views: z
          .array(
            z
              .object({
                id: z.string().min(1).max(256),
                sourceRegion: pixelRectSchema,
                width: z.number().int().positive().max(16384),
                height: z.number().int().positive().max(16384),
                scaleX: z.number().finite().positive(),
                scaleY: z.number().finite().positive(),
                content: pixelRectSchema.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(representationLimits.maxViews),
      })
      .strict(),
  })
  .strict()

/** Wraps a research encoder port with text-only response validation (benchmark composition only). */
export function createValidatedExperimentalTextPort(
  experimental: ImageRepresentationPort,
): ImageRepresentationPort {
  return {
    async prepare(input) {
      const result = parse(
        preparedTextSchema,
        await experimental.prepare(input),
        'INVALID_RESPONSE',
      )
      const bytes = result.state.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0)
      if (bytes > representationLimits.totalBytes || bytes !== result.metadata.bytes)
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Representation byte accounting is inconsistent',
        )
      return {
        state: result.state,
        metadata: {
          ...result.metadata,
          views: result.metadata.views.map(({ content, ...view }) => ({
            ...view,
            ...(content === undefined ? {} : { content }),
          })),
        },
      }
    },
  }
}
