import { z } from 'zod'

/** Diagnostic native scores are uncalibrated finite values, not probabilities. */
export interface SegmentationMetadata {
  method: string
  backend: string
  durationMs: number
  input: { width: number; height: number }
  qualityScore?: number
}

const safePositiveDimensionSchema = z
  .object({
    width: z.number().int().positive().safe(),
    height: z.number().int().positive().safe(),
  })
  .strict()

export const segmentationMetadataSchema = z
  .object({
    method: z.string().min(1).max(128),
    backend: z.string().min(1).max(128),
    durationMs: z.number().finite().nonnegative(),
    input: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    qualityScore: z.number().finite().optional(),
  })
  .strict()

export const segmentationMetadataSafeSchema = segmentationMetadataSchema
  .extend({ input: safePositiveDimensionSchema })
  .strict()
