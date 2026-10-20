import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { FreshCase } from './fresh-corpus.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const MAX_EXPLORATORY_SOURCE_PIXELS = 2_097_152
const MAX_ANNOTATION_CANVAS_PIXELS = 2048 * 2048
const indexRowSchema = z
  .object({
    caseId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    imageId: z.string().regex(/^[a-f0-9]{16}$/u),
    targetClassId: z.string().regex(/^\/m\/[a-z0-9_]+$/u),
    maskPath: z.string().regex(/^[a-f0-9]{16}_[A-Za-z0-9_]+_[a-f0-9]{8}\.png$/u),
    sourceCsvRow: z.number().int().positive(),
    maskFormat: z.literal(''),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    file: z.string().min(1).max(512),
    sha256: digest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict()
const maskIndexSchema = z
  .object({
    sourceUrl: z.literal(
      'https://storage.googleapis.com/openimages/v5/validation-annotations-object-segmentation.csv',
    ),
    sourceCsvSha256: z.literal('a876ff7a1a68de771e668baa9886f0ca2331992cd4af5497401be41828a5de89'),
    annotationLicense: z.literal('https://creativecommons.org/licenses/by/4.0/'),
    caseCount: z.literal(21),
    maskInstanceCount: z.literal(32),
    rows: z.array(indexRowSchema).length(32),
    downloadMethod: z.literal(
      'official per-leading-character archive; only selected mask PNG entries retained',
    ),
  })
  .strict()
const photoTruthSchema = z.array(
  z
    .object({
      caseId: z.string().min(1).max(128),
      targetClassId: z.string().regex(/^\/m\/[a-z0-9_]+$/u),
      expectedPresence: z.enum(['present', 'absent']),
      referenceMasks: z.never().optional(),
    })
    .passthrough(),
)

/** Check whether two integer canvases can share an aspect ratio after independent nearest-integer rounding. */
export function hasCompatibleIntegerRoundedAspect(
  sourceWidth: number,
  sourceHeight: number,
  referenceWidth: number,
  referenceHeight: number,
): boolean {
  for (const value of [sourceWidth, sourceHeight, referenceWidth, referenceHeight]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2048) return false
  }
  const sourceLow = (sourceWidth - 0.5) / (sourceHeight + 0.5)
  const sourceHigh = (sourceWidth + 0.5) / (sourceHeight - 0.5)
  const referenceLow = (referenceWidth - 0.5) / (referenceHeight + 0.5)
  const referenceHigh = (referenceWidth + 0.5) / (referenceHeight - 0.5)
  return Math.max(sourceLow, referenceLow) <= Math.min(sourceHigh, referenceHigh)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Join the separately pinned official mask index to canonical photo truth and frozen producer
 * image bindings. The original truth/index objects are never mutated or rewritten.
 */
function joinPhotoMaskTruth(
  input: {
    canonicalPhotoTruth: unknown
    canonicalPhotoTruthSha256: string
    maskIndex: unknown
    maskIndexSha256: string
    producerImageBindings: readonly FreshCase[]
  },
  canvasPolicy: 'exact-source-canvas' | 'openimages-v5-normalized-canvas-exploratory',
) {
  const truth = photoTruthSchema.parse(input.canonicalPhotoTruth)
  const index = maskIndexSchema.parse(input.maskIndex)
  digest.parse(input.canonicalPhotoTruthSha256)
  digest.parse(input.maskIndexSha256)
  if (input.producerImageBindings.length !== 40 || truth.length !== 40)
    throw new Error('Photo mask join requires the frozen 40-case photo source')
  if (
    input.producerImageBindings.some(
      (item) => item.image.width * item.image.height > MAX_EXPLORATORY_SOURCE_PIXELS,
    )
  )
    throw new Error('Producer image canvas exceeds the 2,097,152-pixel source limit')

  const truthById = new Map<string, (typeof truth)[number]>()
  for (const row of truth) {
    if (truthById.has(row.caseId)) throw new Error('Duplicate canonical photo truth case ID')
    truthById.set(row.caseId, row)
  }
  const bindingById = new Map<string, FreshCase>()
  for (const item of input.producerImageBindings) {
    if (bindingById.has(item.caseId)) throw new Error('Duplicate producer photo image binding')
    bindingById.set(item.caseId, item)
  }
  if (
    truthById.size !== bindingById.size ||
    [...truthById.keys()].some((id) => !bindingById.has(id))
  )
    throw new Error('Canonical photo truth and producer image case sets differ')

  const referencesByCase = new Map<
    string,
    Array<{
      path: string
      sha256: string
      bytes: number
      width: number
      height: number
      sourceImageSha256?: string
      sourceWidth?: number
      sourceHeight?: number
      coordinatePolicy?: 'openimages-v5-normalized-canvas-exploratory'
    }>
  >()
  const sourceRows = new Set<number>()
  const paths = new Set<string>()
  const hashesByCase = new Map<string, Set<string>>()
  for (const row of index.rows) {
    const expected = truthById.get(row.caseId)
    const binding = bindingById.get(row.caseId)
    if (!expected || !binding)
      throw new Error('Official mask index contains an unmatched producer/truth case')
    if (expected.expectedPresence !== 'present')
      throw new Error('Official reference mask is attached to an absent photo truth')
    if (expected.targetClassId !== row.targetClassId)
      throw new Error('Official mask target class differs from canonical photo truth')
    const imageId = /^([a-f0-9]{16})\.jpe?g$/u.exec(basename(binding.image.path))?.[1]
    if (!imageId || imageId !== row.imageId)
      throw new Error('Official mask image ID differs from the frozen producer image binding')
    if (canvasPolicy === 'exact-source-canvas') {
      if (row.width !== binding.image.width || row.height !== binding.image.height)
        throw new Error('Official mask dimensions differ from the frozen producer image')
      if (row.width * row.height > MAX_EXPLORATORY_SOURCE_PIXELS)
        throw new Error('Exact-source reference mask exceeds the 2,097,152-pixel limit')
    } else {
      if (row.width * row.height > MAX_ANNOTATION_CANVAS_PIXELS)
        throw new Error('Official annotation canvas exceeds the 2048-by-2048-pixel limit')
      if (
        !hasCompatibleIntegerRoundedAspect(
          binding.image.width,
          binding.image.height,
          row.width,
          row.height,
        )
      )
        throw new Error('Official mask canvas is not aspect-compatible under integer rounding')
    }
    if (
      row.maskPath.startsWith(`${row.imageId}_`) === false ||
      row.file !== `sealed/masks/${row.caseId}/${row.maskPath}`
    )
      throw new Error('Official mask path does not match its image and case IDs')
    if (sourceRows.has(row.sourceCsvRow) || paths.has(row.file))
      throw new Error('Duplicate official source row or mask path')
    sourceRows.add(row.sourceCsvRow)
    paths.add(row.file)
    const hashes = hashesByCase.get(row.caseId) ?? new Set<string>()
    if (hashes.has(row.sha256)) throw new Error('Duplicate official mask reference for case')
    hashes.add(row.sha256)
    hashesByCase.set(row.caseId, hashes)
    const refs = referencesByCase.get(row.caseId) ?? []
    refs.push({
      path: row.file,
      sha256: row.sha256,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      ...(canvasPolicy === 'openimages-v5-normalized-canvas-exploratory'
        ? {
            sourceImageSha256: binding.image.sha256,
            sourceWidth: binding.image.width,
            sourceHeight: binding.image.height,
            coordinatePolicy: canvasPolicy,
          }
        : {}),
    })
    referencesByCase.set(row.caseId, refs)
  }
  if (referencesByCase.size !== index.caseCount || sourceRows.size !== index.maskInstanceCount)
    throw new Error('Official mask index counts do not match its declared metadata')

  const derivedTruth = truth.map((row) => {
    const references = referencesByCase.get(row.caseId)
    return references ? { ...row, referenceMasks: references } : { ...row }
  })
  const bindingRows = input.producerImageBindings
    .map((item) => ({
      caseId: item.caseId,
      imagePath: item.image.path,
      imageSha256: item.image.sha256,
      width: item.image.width,
      height: item.image.height,
      target: item.locate.target,
    }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
  return {
    truth: derivedTruth,
    provenance: {
      schema: 'categorical-photo-mask-reference-join-v1',
      canonicalPhotoTruthSha256: input.canonicalPhotoTruthSha256,
      maskIndexSha256: input.maskIndexSha256,
      sourceCsvSha256: index.sourceCsvSha256,
      producerImageBindingsSha256: sha256(JSON.stringify(bindingRows)),
      caseCount: referencesByCase.size,
      maskInstanceCount: index.rows.length,
      annotationLicense: index.annotationLicense,
      ...(canvasPolicy === 'openimages-v5-normalized-canvas-exploratory'
        ? {
            coordinatePolicy: canvasPolicy,
            alignment: 'normalized-pixel-center-nearest-neighbor-v1',
            caveats: [
              'Aspect compatibility permits only overlapping integer-rounding ratio intervals.',
              'Exact Open Images annotation pixel sampling and source-asset rotation history are not independently verified.',
              'This exploratory component score does not qualify mask accuracy or change whole-object/classification gates.',
            ],
          }
        : {}),
    },
  }
}

/** Strict default: annotation and producer source canvases must have identical dimensions. */
export function joinCategoricalPhotoMaskTruth(input: {
  canonicalPhotoTruth: unknown
  canonicalPhotoTruthSha256: string
  maskIndex: unknown
  maskIndexSha256: string
  producerImageBindings: readonly FreshCase[]
}) {
  return joinPhotoMaskTruth(input, 'exact-source-canvas')
}

/** Explicit exploratory Open Images V5 policy for independently normalized full-frame canvases. */
export function joinCategoricalPhotoMaskTruthNormalizedCanvas(input: {
  canonicalPhotoTruth: unknown
  canonicalPhotoTruthSha256: string
  maskIndex: unknown
  maskIndexSha256: string
  producerImageBindings: readonly FreshCase[]
}) {
  return joinPhotoMaskTruth(input, 'openimages-v5-normalized-canvas-exploratory')
}
