import { z } from 'zod'

import { pixelRectSchema } from '../../entities/contracts.js'

const modelOptionsSchema = z
  .object({
    encoderPath: z.string().min(1).max(4096),
    decoderPath: z.string().min(1).max(4096),
    executionProvider: z.enum(['cpu', 'dml']),
    deviceId: z.number().int().min(0).max(32).optional(),
    threads: z.number().int().min(1).max(8).default(2),
  })
  .strict()

const mobileSamProbeSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('probe-mobile-sam'),
    options: modelOptionsSchema,
  })
  .strict()
const grabCutProbeSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('probe-grabcut'),
    assetPath: z.string().min(1).max(4096),
  })
  .strict()

const mobileSamRequestSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('mobile-sam'),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    rgba: z
      .string()
      .max(90_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    seedRegion: pixelRectSchema,
    wholeRegion: pixelRectSchema,
    roi: pixelRectSchema,
    options: modelOptionsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.width * value.height > 16_777_216)
      context.addIssue({ code: 'custom', message: 'Image exceeds segmentation pixel limit' })
    for (const region of [value.seedRegion, value.wholeRegion, value.roi])
      if (region.left + region.width > value.width || region.top + region.height > value.height)
        context.addIssue({ code: 'custom', message: 'Segmentation region is outside the source' })
  })

// Proposal replies are deliberately packed before IPC; 36 full-resolution byte masks
// would exceed the native child stdout budget by a wide margin.
const mobileSamProposalsRequestSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('mobile-sam-proposals'),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    rgba: z
      .string()
      .max(11_200_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    seedRegion: pixelRectSchema,
    roi: pixelRectSchema,
    options: modelOptionsSchema.extend({ executionProvider: z.literal('cpu') }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.width * value.height > 2_097_152)
      context.addIssue({ code: 'custom', message: 'Image exceeds proposal pixel limit' })
    for (const region of [value.seedRegion, value.roi])
      if (region.left + region.width > value.width || region.top + region.height > value.height)
        context.addIssue({ code: 'custom', message: 'Proposal region is outside the source' })
  })

const grabCutRequestSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('grabcut'),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    rgba: z
      .string()
      .max(90_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    seedRegion: pixelRectSchema,
    wholeRegion: pixelRectSchema,
    roi: pixelRectSchema,
    assetPath: z.string().min(1).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.width * value.height > 16_777_216)
      context.addIssue({ code: 'custom', message: 'Image exceeds segmentation pixel limit' })
    for (const region of [value.seedRegion, value.wholeRegion, value.roi])
      if (region.left + region.width > value.width || region.top + region.height > value.height)
        context.addIssue({ code: 'custom', message: 'Segmentation region is outside the source' })
  })

export const nativeSegmentationRequestSchema = z.union([
  mobileSamProbeSchema,
  grabCutProbeSchema,
  mobileSamProposalsRequestSchema,
  mobileSamRequestSchema,
  grabCutRequestSchema,
])

export const nativeSegmentationReplySchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal('segmented'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mask: z
      .string()
      .max(32_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    method: z.string().min(1).max(128),
  })
  .strict()
export type NativeSegmentationRequest = z.infer<typeof nativeSegmentationRequestSchema>
export type NativeSegmentationReply = z.infer<typeof nativeSegmentationReplySchema>

export const nativeObjectProposalReplySchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal('proposals'),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    proposals: z
      .array(
        z
          .object({
            id: z.string().regex(/^C(?:0[0-9]|1[0-9]|2[0-9]|3[0-5])$/),
            mask: z
              .string()
              .max(349_528)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
            qualityScore: z.number().finite(),
          })
          .strict(),
      )
      .length(36),
  })
  .strict()
export type NativeObjectProposalReply = z.infer<typeof nativeObjectProposalReplySchema>

export const nativeProbeReplySchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal('ready'),
    backend: z.enum(['mobile-sam', 'grabcut']),
  })
  .strict()

export const nativeErrorReplySchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal('error'),
    code: z.enum([
      'INVALID_INPUT',
      'INVALID_RESPONSE',
      'TIMEOUT',
      'ABORTED',
      'CAPACITY',
      'DISPOSED',
      'PROVIDER',
      'UNSUPPORTED',
      'RESOURCE_LIMIT',
    ]),
    message: z.string().min(1).max(300),
  })
  .strict()
