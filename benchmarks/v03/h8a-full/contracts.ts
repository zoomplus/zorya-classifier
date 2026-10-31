import { z } from 'zod'
import {
  H8A_FULL_MAX_AUTHORED_TARGET_CHARS,
  H8A_FULL_MAX_EXCLUSIONS,
  H8A_FULL_MAX_ORIENTED_PIXELS,
  H8A_FULL_NATIVE_REQUEST_SCHEMA,
  H8A_FULL_NATIVE_RESPONSE_SCHEMA,
  H8A_FULL_RECIPE_ID,
} from './constants.js'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)

const h8aPackedMaskSchema = z
  .object({
    format: z.literal('binary-lsb0'),
    width: z.number().int().positive().safe(),
    height: z.number().int().positive().safe(),
    data: z.instanceof(Uint8Array),
  })
  .strict()

export const h8aAuthoredTargetSchema = z
  .string()
  .min(1)
  .max(H8A_FULL_MAX_AUTHORED_TARGET_CHARS * 2)
  .refine(
    (value) =>
      Array.from(value).length <= H8A_FULL_MAX_AUTHORED_TARGET_CHARS &&
      !value.startsWith('\ufeff') &&
      !value.endsWith('\ufeff'),
    'authored target must be at most 2000 Unicode characters and cannot start or end with a BOM',
  )

export const h8aExclusionsSchema = z.array(h8aAuthoredTargetSchema).max(H8A_FULL_MAX_EXCLUSIONS)

const h8aNativeRequestSchema = z
  .object({
    schema: z.literal(H8A_FULL_NATIVE_REQUEST_SCHEMA),
    request_id: z.string().uuid(),
    recipe_id: z.literal(H8A_FULL_RECIPE_ID),
    authored_target: h8aAuthoredTargetSchema,
    task_dir: z.string().min(1),
    assets_dir: z.string().min(1),
    source_path: z.string().min(1),
    source_sha256: digestSchema,
    width: z.number().int().positive().safe(),
    height: z.number().int().positive().safe(),
    detector_prompt: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const pixels = value.width * value.height
    if (pixels > H8A_FULL_MAX_ORIENTED_PIXELS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'oriented pixel cap exceeded',
        path: ['width'],
      })
    }
    if (
      value.detector_prompt !== undefined &&
      value.detector_prompt !== buildDinoPrompt(value.authored_target)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'detector_prompt must match buildDinoPrompt(authored_target)',
        path: ['detector_prompt'],
      })
    }
  })

export type H8aNativeRequest = z.infer<typeof h8aNativeRequestSchema>

const nativeCandidateSchema = z
  .object({
    id: z.string().min(1),
    family: z.enum(['D', 'U']),
    ordinal: z.number().int().nonnegative(),
    packed_path: z.string().min(1),
    packed_bytes: z.number().int().nonnegative(),
    empty: z.boolean(),
    packed_sha256: digestSchema,
    mask_box_xyxy: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional(),
  })
  .strict()

const h8aNativeResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      schema: z.literal(H8A_FULL_NATIVE_RESPONSE_SCHEMA),
      status: z.literal('complete'),
      request_id: z.string().uuid(),
      recipe_id: z.literal(H8A_FULL_RECIPE_ID),
      source_sha256: digestSchema,
      width: z.number().int().positive().safe(),
      height: z.number().int().positive().safe(),
      authored_target: h8aAuthoredTargetSchema,
      detector_prompt: z.string().optional(),
      families: z
        .object({
          D: z.array(nativeCandidateSchema),
          U: z.array(nativeCandidateSchema),
        })
        .strict(),
      packed_mask_bytes_total: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      schema: z.literal(H8A_FULL_NATIVE_RESPONSE_SCHEMA),
      status: z.literal('error'),
      request_id: z.string().uuid(),
      recipe_id: z.literal(H8A_FULL_RECIPE_ID),
      source_sha256: digestSchema,
      error: z.string(),
      error_type: z.string().optional(),
    })
    .strict(),
])

export type H8aNativeResponse = z.infer<typeof h8aNativeResponseSchema>

export const h8aNativeStdoutTrailerSchema = z
  .object({
    schema: z.literal(H8A_FULL_NATIVE_RESPONSE_SCHEMA),
    status: z.enum(['complete', 'error']),
  })
  .strict()

const h8aLocatedResultObjectSchema = z
  .object({
    status: z.literal('located'),
    family: z.enum(['D', 'U']),
    alias: z.string().min(1),
    sourceAlias: z.string().min(1),
    originalEncodedSha256: digestSchema,
    sourceFrame: z
      .object({
        sha256: digestSchema,
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      })
      .strict(),
    mask: h8aPackedMaskSchema,
    region: z
      .object({
        left: z.number().int().nonnegative().safe(),
        top: z.number().int().nonnegative().safe(),
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      })
      .strict(),
    center: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .strict(),
    cutout: z
      .object({
        data: z.instanceof(Uint8Array),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        format: z.literal('rgba8'),
      })
      .optional(),
  })
  .strict()

function refineLocatedResult(
  value: z.infer<typeof h8aLocatedResultObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  const { sourceFrame, mask, region, center } = value
  if (mask.width !== sourceFrame.width || mask.height !== sourceFrame.height) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'mask dimensions do not match source frame',
    })
    return
  }
  const pixels = mask.width * mask.height
  if (!Number.isSafeInteger(pixels) || pixels > H8A_FULL_MAX_ORIENTED_PIXELS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'source frame exceeds oriented pixel cap',
    })
    return
  }
  const expectedBytes = Math.ceil(pixels / 8)
  if (mask.data.byteLength !== expectedBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'packed mask byte length does not match frame',
    })
    return
  }
  const unusedBits = expectedBytes * 8 - pixels
  const lastByte = mask.data[expectedBytes - 1]
  if (
    unusedBits > 0 &&
    lastByte !== undefined &&
    (lastByte & ~((1 << (8 - unusedBits)) - 1)) !== 0
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'packed mask padding bits are nonzero' })
    return
  }
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let index = 0; index < pixels; index++) {
    if (((mask.data[index >> 3] ?? 0) & (1 << (index & 7))) === 0) continue
    const x = index % mask.width
    const y = Math.floor(index / mask.width)
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  if (right < left) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'located mask has no foreground pixels' })
    return
  }
  const expectedRegion = { left, top, width: right - left + 1, height: bottom - top + 1 }
  if (
    region.left !== expectedRegion.left ||
    region.top !== expectedRegion.top ||
    region.width !== expectedRegion.width ||
    region.height !== expectedRegion.height
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'region does not match packed foreground bounds',
    })
  if (center.x !== left + expectedRegion.width / 2 || center.y !== top + expectedRegion.height / 2)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'center does not match packed foreground bounds',
    })
  if (value.cutout && value.cutout.data.byteLength !== value.cutout.width * value.cutout.height * 4)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cutout byte length does not match dimensions',
    })
  if (
    value.cutout &&
    (value.cutout.width !== region.width || value.cutout.height !== region.height)
  )
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cutout dimensions do not match region' })
}

const h8aUnknownResultSchema = z
  .object({
    status: z.literal('unknown'),
    reason: z.string().min(1),
  })
  .strict()

export const h8aFullSuccessSchema = z
  .discriminatedUnion('status', [h8aLocatedResultObjectSchema, h8aUnknownResultSchema])
  .superRefine((value, ctx) => {
    if (value.status === 'located') refineLocatedResult(value, ctx)
  })

export type H8aFullSuccess = z.infer<typeof h8aFullSuccessSchema>

export function buildDinoPrompt(authoredTarget: string): string {
  return `a ${h8aAuthoredTargetSchema.parse(authoredTarget)}`
}

export function parseNativeResponse(value: unknown): H8aNativeResponse {
  return h8aNativeResponseSchema.parse(value)
}

export function parseNativeRequest(value: unknown): H8aNativeRequest {
  return h8aNativeRequestSchema.parse(value)
}

export function parseNativeStdoutTrailer(
  value: unknown,
): z.infer<typeof h8aNativeStdoutTrailerSchema> {
  return h8aNativeStdoutTrailerSchema.parse(value)
}
