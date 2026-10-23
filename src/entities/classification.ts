import { z } from 'zod'

import { imageSchema, limits, representationSchema } from './image.js'

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
    representation: representationSchema.optional(),
  })
  .strict()
export type ClassifyInput = z.input<typeof classifySchema> & { signal?: AbortSignal }
