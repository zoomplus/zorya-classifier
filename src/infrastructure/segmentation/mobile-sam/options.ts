import { z } from 'zod'

export const optionsSchema = z
  .object({
    encoderPath: z.string().min(1).max(4096),
    decoderPath: z.string().min(1).max(4096),
    executionProvider: z.enum(['cpu', 'dml']).default('cpu'),
    deviceId: z.number().int().min(0).max(32).optional(),
    threads: z.number().int().min(1).max(8).default(2),
  })
  .strict()
/** Options for the MobileSAM segmentation factory (caller-supplied pinned assets). */
export type MobileSamSegmenterOptions = z.input<typeof optionsSchema>

export const proposalOptionsSchema = z
  .object({
    encoderPath: z.string().min(1).max(4096),
    decoderPath: z.string().min(1).max(4096),
    executionProvider: z.literal('cpu').default('cpu'),
    threads: z.number().int().min(1).max(8).default(2),
    sampling: z.enum(['seed-grid', 'seed-center']).default('seed-grid'),
  })
  .strict()
/** Options for the MobileSAM object-proposal factory (caller-supplied pinned assets). */
export type MobileSamObjectProposalsOptions = z.input<typeof proposalOptionsSchema>
