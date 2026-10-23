import { z } from 'zod'

import { pixelRectSchema } from '../../entities/contracts.js'

/** Validate canonical RFC 4648 base64 without a large repeated-group RegExp. */
function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  if (value.length === 0) return true

  const alphabet = (code: number): number => {
    if (code >= 65 && code <= 90) return code - 65
    if (code >= 97 && code <= 122) return code - 97 + 26
    if (code >= 48 && code <= 57) return code - 48 + 52
    if (code === 43) return 62
    if (code === 47) return 63
    return -1
  }

  const length = value.length
  const padding =
    value.charCodeAt(length - 1) === 61 ? (value.charCodeAt(length - 2) === 61 ? 2 : 1) : 0
  const contentEnd = length - padding
  for (let index = 0; index < contentEnd; index++)
    if (alphabet(value.charCodeAt(index)) < 0) return false
  for (let index = contentEnd; index < length; index++)
    if (value.charCodeAt(index) !== 61) return false

  // Padding must encode zero bits so there is exactly one spelling per byte sequence.
  if (padding === 2) return (alphabet(value.charCodeAt(length - 3)) & 15) === 0
  if (padding === 1) return (alphabet(value.charCodeAt(length - 2)) & 3) === 0
  return true
}

function base64Schema(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .refine((value) => value.length <= maxLength && isCanonicalBase64(value))
}

const segmentationPixelLimit = 16_777_216

function refineSegmentationImageAndRegions(
  value: {
    width: number
    height: number
    seedRegion: z.infer<typeof pixelRectSchema>
    wholeRegion: z.infer<typeof pixelRectSchema>
    roi: z.infer<typeof pixelRectSchema>
  },
  context: z.RefinementCtx,
): void {
  if (value.width * value.height > segmentationPixelLimit)
    context.addIssue({ code: 'custom', message: 'Image exceeds segmentation pixel limit' })
  for (const region of [value.seedRegion, value.wholeRegion, value.roi])
    if (region.left + region.width > value.width || region.top + region.height > value.height)
      context.addIssue({ code: 'custom', message: 'Segmentation region is outside the source' })
}

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
    rgba: base64Schema(90_000_000),
    seedRegion: pixelRectSchema,
    wholeRegion: pixelRectSchema,
    roi: pixelRectSchema,
    prompt: z.enum(['whole-region', 'seed-region']).default('whole-region'),
    options: modelOptionsSchema,
  })
  .strict()
  .superRefine(refineSegmentationImageAndRegions)

const mobileSamExpandRequestSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('mobile-sam-expand'),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    rgba: base64Schema(90_000_000),
    previousMask: base64Schema(2_796_204),
    seedRegion: pixelRectSchema,
    wholeRegion: pixelRectSchema,
    roi: pixelRectSchema,
    prompt: z.enum(['whole-region', 'seed-region']).default('whole-region'),
    options: modelOptionsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.width * value.height > 16_777_216)
      context.addIssue({ code: 'custom', message: 'Image exceeds segmentation pixel limit' })
    const expectedMaskBytes = Math.ceil((value.width * value.height) / 8)
    const padding = value.previousMask.endsWith('==') ? 2 : value.previousMask.endsWith('=') ? 1 : 0
    const decodedMaskBytes = (value.previousMask.length / 4) * 3 - padding
    if (decodedMaskBytes !== expectedMaskBytes)
      context.addIssue({
        code: 'custom',
        message: 'Previous mask length does not match dimensions',
      })
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
    rgba: base64Schema(11_200_000),
    seedRegion: pixelRectSchema,
    roi: pixelRectSchema,
    sampling: z.enum(['seed-grid', 'seed-center']).default('seed-grid'),
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
    rgba: base64Schema(90_000_000),
    seedRegion: pixelRectSchema,
    wholeRegion: pixelRectSchema,
    roi: pixelRectSchema,
    prompt: z.enum(['whole-region', 'seed-region']).default('whole-region'),
    assetPath: z.string().min(1).max(4096),
  })
  .strict()
  .superRefine(refineSegmentationImageAndRegions)

export const nativeSegmentationRequestSchema = z.union([
  mobileSamProbeSchema,
  grabCutProbeSchema,
  mobileSamProposalsRequestSchema,
  mobileSamRequestSchema,
  mobileSamExpandRequestSchema,
  grabCutRequestSchema,
])

export const nativeSegmentationReplySchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal('segmented'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mask: base64Schema(32_000_000),
    method: z.string().min(1).max(128),
  })
  .strict()
export type NativeSegmentationRequest = z.infer<typeof nativeSegmentationRequestSchema>
export type NativeSegmentationReply = z.infer<typeof nativeSegmentationReplySchema>

export const nativeMobileSamExpansionReplySchema = z.discriminatedUnion('status', [
  z
    .object({
      id: z.string().uuid(),
      status: z.literal('expanded'),
      width: z.number().int().positive().max(16384),
      height: z.number().int().positive().max(16384),
      mask: base64Schema(2_796_204),
      method: z.literal('mobile-sam-enclosing-mask-v1'),
      qualityScore: z.number().finite(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      status: z.literal('unknown'),
      reason: z.literal('no-enclosing-mask'),
      width: z.number().int().positive().max(16384),
      height: z.number().int().positive().max(16384),
      method: z.literal('mobile-sam-enclosing-mask-v1'),
    })
    .strict(),
])
export type NativeMobileSamExpansionReply = z.infer<typeof nativeMobileSamExpansionReplySchema>

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
            mask: base64Schema(349_528),
            qualityScore: z.number().finite(),
          })
          .strict(),
      )
      .min(4)
      .max(36),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.proposals.length !== 4 && value.proposals.length !== 36)
      context.addIssue({ code: 'custom', message: 'Proposal reply must contain four or 36 masks' })
    for (const [index, proposal] of value.proposals.entries()) {
      const expectedId = `C${String(index).padStart(2, '0')}`
      if (proposal.id !== expectedId)
        context.addIssue({
          code: 'custom',
          message: 'Proposal aliases must be contiguous from C00',
        })
    }
  })
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
