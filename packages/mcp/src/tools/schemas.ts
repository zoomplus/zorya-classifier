import { z } from 'zod'

import type { ImageSource } from '../contracts.js'

const imageSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('inlineBase64'),
    data: z
      .string()
      .min(4)
      .max(22_369_624)
      .refine(isCanonicalBase64, 'Image data must be canonical padded Base64.'),
    mediaType: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({ kind: z.literal('localPath'), path: z.string().min(1).max(4_096) }),
  z.strictObject({ kind: z.literal('url'), url: z.string().url().max(4_096) }),
  z.strictObject({ kind: z.literal('uploadedId'), id: z.string().min(1).max(512) }),
  z.strictObject({
    kind: z.literal('chatgptFile'),
    downloadUrl: z.string().url().max(4_096),
    fileId: z.string().min(1).max(512),
    mediaType: z.string().min(1).max(128).optional(),
    fileName: z.string().min(1).max(512).optional(),
  }),
])

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const contentLength = value.length - padding
  if (padding === 2 && contentLength % 4 !== 2) return false
  if (padding === 1 && contentLength % 4 !== 3) return false
  if (padding === 0 && contentLength % 4 !== 0) return false

  let lastValue = -1
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index)
    const base64Value =
      code >= 65 && code <= 90
        ? code - 65
        : code >= 97 && code <= 122
          ? code - 71
          : code >= 48 && code <= 57
            ? code + 4
            : code === 43
              ? 62
              : code === 47
                ? 63
                : -1
    if (base64Value < 0) return false
    lastValue = base64Value
  }
  if (padding === 2 && (lastValue & 15) !== 0) return false
  if (padding === 1 && (lastValue & 3) !== 0) return false
  return true
}

const chatgptImageFileSchema = z.strictObject({
  download_url: z.string().url().max(4_096),
  file_id: z.string().min(1).max(512),
  mime_type: z.string().min(1).max(128).optional(),
  file_name: z.string().min(1).max(512).optional(),
})

const imageFields = {
  image: imageSourceSchema.optional(),
  image_file: chatgptImageFileSchema.optional(),
}

const classDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/),
  description: z.string().trim().min(1).max(300),
})

const roiSchema = z.strictObject({
  left: z.number().int().min(0),
  top: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
})

function requireOneImageSource(
  value: { readonly image?: unknown; readonly image_file?: unknown },
  context: z.RefinementCtx,
): void {
  if (value.image !== undefined && value.image_file !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['image_file'],
      message: 'Provide exactly one image source.',
    })
  }
  if (value.image === undefined && value.image_file === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['image'],
      message: 'An image source is required.',
    })
  }
}

function requireClassificationInput(
  value: {
    readonly image?: unknown | undefined
    readonly image_file?: unknown | undefined
    readonly text?: string | undefined
  },
  context: z.RefinementCtx,
): void {
  if (value.image !== undefined && value.image_file !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['image_file'],
      message: 'Provide at most one image source.',
    })
  }
  if (value.image === undefined && value.image_file === undefined && value.text === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['text'],
      message: 'Provide text or an image source.',
    })
  }
}

const profileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const exclusionsSchema = z.array(z.string().min(1).max(2_000)).max(128).default([])

export const classifyToolInputSchema = z
  .strictObject({
    ...imageFields,
    text: z.string().min(1).max(32_000).optional(),
    classes: z
      .array(classDefinitionSchema)
      .min(2)
      .max(128)
      .superRefine((classes, context) => {
        const ids = new Set<string>()
        classes.forEach((item, index) => {
          if (ids.has(item.id)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'id'],
              message: 'Class ids must be unique.',
            })
          }
          ids.add(item.id)
        })
      }),
    instructions: z.string().trim().min(1).max(4_000).optional(),
    profileId: profileIdSchema.optional(),
  })
  .superRefine(requireClassificationInput)

export const locateToolInputSchema = z
  .strictObject({
    ...imageFields,
    target: z.string().min(1).max(2_000),
    exclusions: exclusionsSchema,
    roi: roiSchema.optional(),
    mode: z.enum(['region', 'whole-object']).default('region'),
    profileId: profileIdSchema.optional(),
  })
  .superRefine(requireOneImageSource)

export const extractToolInputSchema = z
  .strictObject({
    ...imageFields,
    target: z.string().min(1).max(2_000),
    exclusions: exclusionsSchema,
    roi: roiSchema.optional(),
    profileId: profileIdSchema.optional(),
  })
  .superRefine(requireOneImageSource)

export const getJobToolInputSchema = z.strictObject({
  jobId: z.string().uuid(),
})

export const cancelJobToolInputSchema = z.strictObject({
  jobId: z.string().uuid(),
})

export const capabilitiesToolInputSchema = z.strictObject({})

export type ClassifyToolInput = z.output<typeof classifyToolInputSchema>
export type LocateToolInput = z.output<typeof locateToolInputSchema>
export type ExtractToolInput = z.output<typeof extractToolInputSchema>

export function imageSourceFromInput(input: {
  readonly image?: z.output<typeof imageSourceSchema> | undefined
  readonly image_file?: z.output<typeof chatgptImageFileSchema> | undefined
}) {
  if (input.image !== undefined) return normalizeImageSource(input.image)
  if (input.image_file !== undefined) {
    const source: ImageSource = {
      kind: 'chatgptFile' as const,
      downloadUrl: input.image_file.download_url,
      fileId: input.image_file.file_id,
      ...(input.image_file.mime_type === undefined
        ? {}
        : { mediaType: input.image_file.mime_type }),
      ...(input.image_file.file_name === undefined ? {} : { fileName: input.image_file.file_name }),
    }
    return source
  }
  return undefined
}

function normalizeImageSource(source: z.output<typeof imageSourceSchema>): ImageSource {
  switch (source.kind) {
    case 'inlineBase64':
      return {
        kind: source.kind,
        data: source.data,
        ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
      }
    case 'localPath':
    case 'url':
    case 'uploadedId':
      return source
    case 'chatgptFile':
      return {
        kind: source.kind,
        downloadUrl: source.downloadUrl,
        fileId: source.fileId,
        ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
        ...(source.fileName === undefined ? {} : { fileName: source.fileName }),
      }
  }
}

export const profileIdInputSchema = profileIdSchema
export const roiInputSchema = roiSchema
