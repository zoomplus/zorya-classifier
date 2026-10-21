import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import { binaryMaskIoU, wholeObjectMatch } from '../v02/metrics.js'
import type { FreshCase } from '../v02/fresh-corpus.js'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boxSchema = z
  .object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() })
  .strict()
const truthSchema = z
  .object({
    caseId: z.string().min(1),
    sourceCaseId: z.string().min(1),
    stratum: z.enum(['photo', 'ui', 'map']),
    presence: z.enum(['present', 'absent']),
    imageSha256: digestSchema,
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    boxes: z.array(boxSchema),
    referenceMasks: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: digestSchema,
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          resampling: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
export type V03PilotTruth = z.infer<typeof truthSchema>

const rowSchema = z
  .object({
    caseId: z.string().min(1),
    imageSha256: digestSchema,
    classify: z
      .object({
        status: z.enum(['skipped', 'classified', 'failed', 'ok']),
        choice: z.enum(['present', 'absent']).optional(),
        value: z.enum(['present', 'absent']).optional(),
        durationMs: z.number().nonnegative().optional(),
      })
      .passthrough(),
    extraction: z
      .object({
        status: z.string().min(1),
        reason: z.string().optional(),
        durationMs: z.number().nonnegative().optional(),
        seed: z
          .object({
            status: z.string().min(1),
            region: boxSchema.optional(),
            sourceWidth: z.number().int().positive().optional(),
            sourceHeight: z.number().int().positive().optional(),
          })
          .passthrough(),
        mask: z
          .object({
            file: z.string().min(1),
            sha256: digestSchema,
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            sourceRegion: boxSchema,
            sourceOffset: z.object({ x: z.number(), y: z.number() }).strict(),
            pngFile: z.string().optional(),
            pngSha256: digestSchema.optional(),
          })
          .passthrough()
          .optional(),
        cutout: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough()
export type V03PilotRunRow = z.infer<typeof rowSchema>

const TRUTH_SHA256 = 'af5bf46d19c7c7dd418f6da0b2d26b7708bf7e4ca659ea378641c424e2f3a1dd'
const truthPath = fileURLToPath(new URL('./evaluator-data/pilot-truth.json', import.meta.url))

/** Evaluator-only data loader. This module must never be imported by a producer. */
export async function loadV03PilotTruth(): Promise<V03PilotTruth[]> {
  const bytes = await readFile(truthPath)
  if (createHash('sha256').update(bytes).digest('hex') !== TRUTH_SHA256)
    throw new Error('v0.3 pilot evaluator truth hash mismatch')
  return z
    .array(truthSchema)
    .length(12)
    .parse(JSON.parse(bytes.toString('utf8')))
}

function maskBits(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.length)
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index]
    if (value !== 0 && value !== 1) throw new Error('Prediction mask is not binary 0/1')
    result[index] = value
  }
  return result
}

async function readReferenceMask(root: string, reference: V03PilotTruth['referenceMasks'][number]) {
  const path = resolve(root, reference.path)
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256)
    throw new Error(`Reference mask hash mismatch: ${reference.path}`)
  const decoded = await sharp(bytes, { failOn: 'error' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (
    decoded.info.width !== reference.width ||
    decoded.info.height !== reference.height ||
    decoded.info.channels !== 1 ||
    decoded.data.length !== reference.width * reference.height
  )
    throw new Error(`Reference mask dimensions mismatch: ${reference.path}`)
  const bits = new Uint8Array(decoded.data.length)
  for (let index = 0; index < decoded.data.length; index++) {
    const value = decoded.data[index]
    if (value !== 0 && value !== 255)
      throw new Error(`Reference mask is not binary: ${reference.path}`)
    bits[index] = value === 0 ? 0 : 1
  }
  return bits
}

async function scoreMask(
  row: V03PilotRunRow | undefined,
  truth: V03PilotTruth,
  outputRoot: string,
  reference: Uint8Array,
): Promise<{ iou: number; matched: boolean } | null> {
  const mask = row?.extraction.mask
  if (!mask) return null
  const bytes = await readFile(resolve(outputRoot, row.caseId, mask.file))
  if (createHash('sha256').update(bytes).digest('hex') !== mask.sha256)
    throw new Error(`Prediction mask hash mismatch for ${row.caseId}`)
  if (
    mask.width * mask.height !== bytes.length ||
    mask.sourceRegion.width !== mask.width ||
    mask.sourceRegion.height !== mask.height ||
    mask.sourceOffset.x !== mask.sourceRegion.left ||
    mask.sourceOffset.y !== mask.sourceRegion.top
  )
    throw new Error(`Prediction mask geometry mismatch for ${row.caseId}`)
  if (
    mask.sourceOffset.x < 0 ||
    mask.sourceOffset.y < 0 ||
    mask.sourceOffset.x + mask.width > truth.sourceWidth ||
    mask.sourceOffset.y + mask.height > truth.sourceHeight ||
    reference.length !== truth.sourceWidth * truth.sourceHeight
  )
    throw new Error(`Prediction mask is outside source canvas for ${row.caseId}`)
  const cropped = maskBits(bytes)
  const full = new Uint8Array(reference.length)
  for (let y = 0; y < mask.height; y++) {
    const sourceStart = (mask.sourceOffset.y + y) * truth.sourceWidth + mask.sourceOffset.x
    full.set(cropped.subarray(y * mask.width, (y + 1) * mask.width), sourceStart)
  }
  const metrics = binaryMaskIoU(full, reference)
  return { iou: metrics.iou, matched: metrics.matched }
}

export interface EvaluateV03PilotInput {
  corpus: readonly FreshCase[]
  rows: readonly unknown[]
  truth: readonly V03PilotTruth[]
  imageRoot: string
  outputRoot: string
}

/**
 * Joins persisted producer output with evaluator-only truth. A seed is never scored as a
 * whole-object box; only a valid persisted mask's sourceRegion is eligible for that metric.
 */
export async function evaluateV03Pilot(input: EvaluateV03PilotInput) {
  const corpus = input.corpus
  const planned = new Map(corpus.map((item) => [item.caseId, item]))
  const truth = new Map(input.truth.map((item) => [item.caseId, truthSchema.parse(item)]))
  if (planned.size !== 12 || truth.size !== 12 || [...planned.keys()].some((id) => !truth.has(id)))
    throw new Error('Expected the exact frozen twelve-case pilot corpus and truth')
  const rows = input.rows.map((item) => rowSchema.parse(item))
  if (
    new Set(rows.map((row) => row.caseId)).size !== rows.length ||
    rows.some((row) => !planned.has(row.caseId))
  )
    throw new Error('Run rows must have unique IDs from the frozen pilot')
  const byId = new Map(rows.map((row) => [row.caseId, row]))

  const perCase = []
  let maskReferenceCount = 0
  let maskPredictedCount = 0
  let maskPasses = 0
  let maskMissingPredictions = 0
  let seedHits = 0
  let seedAttempts = 0
  for (const [caseId, item] of planned) {
    const expected = truth.get(caseId)
    if (!expected) throw new Error('Missing evaluator truth')
    if (
      item.image.sha256 !== expected.imageSha256 ||
      item.image.width !== expected.sourceWidth ||
      item.image.height !== expected.sourceHeight
    )
      throw new Error(`Pilot input and evaluator truth identity mismatch for ${caseId}`)
    const row = byId.get(caseId)
    if (row && row.imageSha256 !== expected.imageSha256)
      throw new Error(`Run output image hash mismatch for ${caseId}`)
    const seed = row?.extraction.seed.region
    const seedHit = Boolean(
      seed &&
        expected.presence === 'present' &&
        expected.boxes.some(
          (box) =>
            Math.max(
              0,
              Math.min(seed.left + seed.width, box.left + box.width) -
                Math.max(seed.left, box.left),
            ) > 0 &&
            Math.max(
              0,
              Math.min(seed.top + seed.height, box.top + box.height) - Math.max(seed.top, box.top),
            ) > 0,
        ),
    )
    if (expected.presence === 'present' && row?.extraction.seed.status === 'located') {
      seedAttempts++
      if (seedHit) seedHits++
    }
    const finalBox = row?.extraction.mask?.sourceRegion
    const positiveSuccess =
      expected.presence === 'present' &&
      finalBox !== undefined &&
      wholeObjectMatch(finalBox, expected.boxes).matched
    const falseBox = expected.presence === 'absent' && finalBox !== undefined
    const falseSeed = expected.presence === 'absent' && seed !== undefined
    const falseCutout =
      expected.presence === 'absent' &&
      Boolean(row?.extraction.cutout || row?.extraction.mask?.pngFile)
    const wholeBoxMeasured = finalBox !== undefined
    const maskScores: Array<{ reference: string; iou: number | null; matched: boolean }> = []
    for (const reference of expected.referenceMasks) {
      maskReferenceCount++
      const referenceBits = await readReferenceMask(input.imageRoot, reference)
      try {
        const score = await scoreMask(row, expected, input.outputRoot, referenceBits)
        if (score) {
          maskPredictedCount++
          if (score.matched) maskPasses++
          maskScores.push({ reference: reference.path, iou: score.iou, matched: score.matched })
        } else {
          maskMissingPredictions++
          maskScores.push({ reference: reference.path, iou: 0, matched: false })
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error
        maskMissingPredictions++
        maskScores.push({ reference: reference.path, iou: 0, matched: false })
        // Invalid/missing prediction artifacts remain zero-valued denominator entries.
      }
    }
    perCase.push({
      caseId,
      stratum: expected.stratum,
      presence: expected.presence,
      returned: Boolean(row),
      classifyStatus: row?.classify.status ?? 'missing',
      classification: row?.classify.choice ?? row?.classify.value ?? null,
      extractionStatus: row?.extraction.status ?? 'missing',
      seedStatus: row?.extraction.seed.status ?? 'missing',
      seedHit,
      finalBox: finalBox ?? null,
      positiveSuccess: expected.presence === 'present' ? positiveSuccess : null,
      falseBox: expected.presence === 'absent' ? falseBox : null,
      falseSeed: expected.presence === 'absent' ? falseSeed : null,
      falseCutout: expected.presence === 'absent' ? falseCutout : null,
      wholeBoxStatus:
        expected.presence === 'absent'
          ? 'not-applicable-negative'
          : wholeBoxMeasured
            ? 'measured'
            : 'not-measured-no-mask-box',
      durationMs:
        row && (row.classify.durationMs !== undefined || row.extraction.durationMs !== undefined)
          ? (row.classify.durationMs ?? 0) + (row.extraction.durationMs ?? 0)
          : null,
      maskScores,
    })
  }
  const positives = perCase.filter((row) => row.presence === 'present')
  const negatives = perCase.filter((row) => row.presence === 'absent')
  const group = (stratum: 'photo' | 'ui' | 'map') => {
    const selected = positives.filter((row) => row.stratum === stratum)
    return {
      planned: selected.length,
      successes: selected.filter((row) => row.positiveSuccess).length,
    }
  }
  return {
    schemaVersion: 1,
    profile: 'v03-dev-pilot-triage-not-qualification',
    denominators: {
      plannedCases: perCase.length,
      returnedRows: rows.length,
      missingRows: perCase.filter((row) => !row.returned).length,
      positives: positives.length,
      positiveSuccesses: positives.filter((row) => row.positiveSuccess).length,
      negatives: negatives.length,
      falseSeeds: negatives.filter((row) => row.falseSeed).length,
      falseBoxes: negatives.filter((row) => row.falseBox).length,
      falseCutouts: negatives.filter((row) => row.falseCutout).length,
      falseRegionOrCutoutCases: negatives.filter(
        (row) => row.falseSeed || row.falseBox || row.falseCutout,
      ).length,
      positiveBoxesMeasured: positives.filter((row) => row.wholeBoxStatus === 'measured').length,
      unknownExtractions: perCase.filter((row) =>
        ['unknown', 'not-found'].includes(row.extractionStatus),
      ).length,
      failedExtractions: perCase.filter((row) => row.extractionStatus === 'failed').length,
      failedClassifications: perCase.filter((row) => row.classifyStatus === 'failed').length,
    },
    wholeObjectLocalization: {
      status: positives.some((row) => row.wholeBoxStatus === 'measured')
        ? 'measured'
        : 'not-measured-seed-only-or-no-boxes',
      plannedPositives: positives.length,
      boxesMeasured: positives.filter((row) => row.wholeBoxStatus === 'measured').length,
      successes: positives.filter((row) => row.positiveSuccess).length,
      rateAmongAllPositives: positives.some((row) => row.wholeBoxStatus === 'measured')
        ? positives.filter((row) => row.positiveSuccess).length / positives.length
        : null,
    },
    positiveWholeBoxSuccessByStratum: {
      photo: group('photo'),
      ui: group('ui'),
      map: group('map'),
    },
    seedDiagnostic: {
      positiveCases: positives.length,
      positiveLocatedSeeds: seedAttempts,
      positiveSeedHits: seedHits,
      hitRateAmongPositives: positives.length === 0 ? null : seedHits / positives.length,
      hitRateAmongLocatedSeeds: seedAttempts === 0 ? null : seedHits / seedAttempts,
    },
    masks: {
      independentReferenceCount: maskReferenceCount,
      predictionsPresent: maskPredictedCount,
      missingPredictions: maskMissingPredictions,
      iouAtLeast080: maskPasses,
      rateAmongAllReferences: maskReferenceCount === 0 ? null : maskPasses / maskReferenceCount,
    },
    cases: perCase,
  }
}
