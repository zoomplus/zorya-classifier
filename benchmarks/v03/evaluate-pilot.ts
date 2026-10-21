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
  .object({
    left: z.number().finite(),
    top: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  })
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
            file: z.literal('mask.u8'),
            sha256: digestSchema,
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            sourceRegion: boxSchema,
            sourceOffset: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
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

function requireBoxWithin(
  box: V03PilotTruth['boxes'][number],
  width: number,
  height: number,
): void {
  if (
    box.left < 0 ||
    box.top < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.left + box.width > width ||
    box.top + box.height > height
  )
    throw new Error('box-outside-source-canvas')
}

function boxEquals(
  left: V03PilotTruth['boxes'][number],
  right: V03PilotTruth['boxes'][number],
): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  )
}

type ValidatedMask = {
  status: 'missing' | 'valid' | 'invalid'
  reason: string | null
  box: V03PilotTruth['boxes'][number] | null
  sourceBits: Uint8Array | null
}

async function validatePredictionMask(
  row: V03PilotRunRow | undefined,
  truth: V03PilotTruth,
  outputRoot: string,
): Promise<ValidatedMask> {
  const mask = row?.extraction.mask
  if (!mask) return { status: 'missing', reason: null, box: null, sourceBits: null }
  const invalid = (reason: string): ValidatedMask => ({
    status: 'invalid',
    reason,
    box: null,
    sourceBits: null,
  })
  if (['failed', 'unknown', 'not-found', 'skipped'].includes(row.extraction.status))
    return invalid('mask-inconsistent-with-extraction-status')
  if (!Number.isInteger(mask.sourceOffset.x) || !Number.isInteger(mask.sourceOffset.y))
    return invalid('non-integer-source-offset')
  if (
    mask.width * mask.height > truth.sourceWidth * truth.sourceHeight ||
    mask.sourceOffset.x < 0 ||
    mask.sourceOffset.y < 0 ||
    mask.sourceOffset.x + mask.width > truth.sourceWidth ||
    mask.sourceOffset.y + mask.height > truth.sourceHeight
  )
    return invalid('mask-canvas-outside-source')
  try {
    const bytes = await readFile(resolve(outputRoot, row.caseId, mask.file))
    if (createHash('sha256').update(bytes).digest('hex') !== mask.sha256)
      return invalid('mask-hash-mismatch')
    if (bytes.length !== mask.width * mask.height) return invalid('mask-byte-length-mismatch')
    const localBits = new Uint8Array(bytes.length)
    let minX = mask.width
    let minY = mask.height
    let maxX = -1
    let maxY = -1
    for (let index = 0; index < bytes.length; index++) {
      const value = bytes[index]
      if (value !== 0 && value !== 1) return invalid('mask-not-binary-u8')
      localBits[index] = value
      if (value === 1) {
        const x = index % mask.width
        const y = Math.floor(index / mask.width)
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    if (maxX < 0 || maxY < 0) return invalid('mask-has-no-foreground')
    const derivedBox = {
      left: mask.sourceOffset.x + minX,
      top: mask.sourceOffset.y + minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    }
    try {
      requireBoxWithin(mask.sourceRegion, truth.sourceWidth, truth.sourceHeight)
    } catch {
      return invalid('descriptor-box-outside-source')
    }
    if (!boxEquals(mask.sourceRegion, derivedBox))
      return invalid('descriptor-box-does-not-match-mask-foreground')
    const sourceBits = new Uint8Array(truth.sourceWidth * truth.sourceHeight)
    for (let y = 0; y < mask.height; y++) {
      const targetStart = (mask.sourceOffset.y + y) * truth.sourceWidth + mask.sourceOffset.x
      sourceBits.set(localBits.subarray(y * mask.width, (y + 1) * mask.width), targetStart)
    }
    return { status: 'valid', reason: null, box: derivedBox, sourceBits }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return invalid('mask-file-unreadable')
  }
}

async function readReferenceMask(
  root: string,
  reference: V03PilotTruth['referenceMasks'][number],
  sourceWidth: number,
  sourceHeight: number,
): Promise<Uint8Array> {
  const path = resolve(root, reference.path)
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256)
    throw new Error(`Reference mask hash mismatch: ${reference.path}`)
  if (!reference.resampling.startsWith('nearest-neighbor to acquired '))
    throw new Error(`Unsupported pinned reference-mask resampling policy: ${reference.path}`)
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
  if (reference.width === sourceWidth && reference.height === sourceHeight) return bits
  const resized = await sharp(Buffer.from(bits), {
    raw: { width: reference.width, height: reference.height, channels: 1 },
  })
    .resize(sourceWidth, sourceHeight, { kernel: 'nearest' })
    .greyscale()
    .raw()
    .toBuffer()
  if (resized.length !== sourceWidth * sourceHeight)
    throw new Error(`Reference mask resampling failed: ${reference.path}`)
  const sourceBits = new Uint8Array(resized.length)
  for (let index = 0; index < resized.length; index++) {
    const value = resized[index]
    if (value !== 0 && value !== 1)
      throw new Error(`Resampled reference mask is not binary: ${reference.path}`)
    sourceBits[index] = value
  }
  return sourceBits
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
  if (new Set(corpus.map((item) => item.caseId)).size !== corpus.length)
    throw new Error('Duplicate case ID in frozen pilot corpus')
  if (new Set(input.truth.map((item) => item.caseId)).size !== input.truth.length)
    throw new Error('Duplicate case ID in evaluator truth')
  if (new Set(input.truth.map((item) => item.sourceCaseId)).size !== input.truth.length)
    throw new Error('Duplicate source case ID in evaluator truth')
  const planned = new Map(corpus.map((item) => [item.caseId, item]))
  const parsedTruth = input.truth.map((item) => truthSchema.parse(item))
  for (const item of parsedTruth) {
    if (item.presence === 'present' && item.boxes.length === 0)
      throw new Error(`Positive truth has no box: ${item.caseId}`)
    if (item.presence === 'absent' && item.boxes.length > 0)
      throw new Error(`Negative truth has target boxes: ${item.caseId}`)
    for (const box of item.boxes) requireBoxWithin(box, item.sourceWidth, item.sourceHeight)
  }
  const truth = new Map(parsedTruth.map((item) => [item.caseId, item]))
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
  let invalidMaskArtifacts = 0
  let invalidOutputRows = 0
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
    const outputErrors: string[] = []
    const classificationValue = row?.classify.choice ?? row?.classify.value
    if (row && row.classify.status === 'classified' && classificationValue === undefined)
      outputErrors.push('classified-without-choice')
    if (
      row &&
      row.classify.status !== 'classified' &&
      row.classify.status !== 'ok' &&
      classificationValue !== undefined
    )
      outputErrors.push('choice-on-unclassified-row')
    if (row?.classify.choice && row.classify.value && row.classify.choice !== row.classify.value)
      outputErrors.push('classification-choice-value-disagree')

    let seed = row?.extraction.seed.region
    const seedStatus = row?.extraction.seed.status
    if (row && seedStatus === 'located') {
      if (!seed) outputErrors.push('located-seed-without-region')
      if (
        row.extraction.seed.sourceWidth !== expected.sourceWidth ||
        row.extraction.seed.sourceHeight !== expected.sourceHeight
      )
        outputErrors.push('seed-source-dimensions-disagree')
      if (seed) {
        try {
          requireBoxWithin(seed, expected.sourceWidth, expected.sourceHeight)
        } catch {
          outputErrors.push('seed-region-outside-source')
          seed = undefined
        }
      }
    } else if (seed) {
      outputErrors.push('region-on-unlocated-seed')
      seed = undefined
    }
    if (
      seedStatus !== 'located' &&
      row &&
      (row.extraction.seed.sourceWidth !== undefined ||
        row.extraction.seed.sourceHeight !== undefined) &&
      (row.extraction.seed.sourceWidth !== expected.sourceWidth ||
        row.extraction.seed.sourceHeight !== expected.sourceHeight)
    )
      outputErrors.push('seed-source-dimensions-disagree')
    const maskArtifact = await validatePredictionMask(row, expected, input.outputRoot)
    if (maskArtifact.status === 'invalid') invalidMaskArtifacts++
    if (outputErrors.length > 0) invalidOutputRows++
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
    if (expected.presence === 'present' && seedStatus === 'located' && seed) {
      seedAttempts++
      if (seedHit) seedHits++
    }
    const finalBox = maskArtifact.box
    const positiveSuccess =
      expected.presence === 'present' &&
      finalBox !== null &&
      wholeObjectMatch(finalBox, expected.boxes).matched
    const falseBox =
      expected.presence === 'absent' && row?.extraction.mask?.sourceRegion !== undefined
    const falseSeed = expected.presence === 'absent' && seed !== undefined
    const falseCutout =
      expected.presence === 'absent' &&
      Boolean(row?.extraction.cutout || row?.extraction.mask?.pngFile)
    const wholeBoxMeasured = finalBox !== null
    const maskScores: Array<{ reference: string; iou: number | null; matched: boolean }> = []
    for (const reference of expected.referenceMasks) {
      maskReferenceCount++
      const referenceBits = await readReferenceMask(
        input.imageRoot,
        reference,
        expected.sourceWidth,
        expected.sourceHeight,
      )
      if (maskArtifact.status === 'valid' && maskArtifact.sourceBits) {
        const score = binaryMaskIoU(maskArtifact.sourceBits, referenceBits)
        maskPredictedCount++
        if (score.matched) maskPasses++
        maskScores.push({ reference: reference.path, iou: score.iou, matched: score.matched })
      } else {
        maskMissingPredictions++
        maskScores.push({ reference: reference.path, iou: 0, matched: false })
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
      outputErrors,
      maskArtifactStatus: maskArtifact.status,
      maskArtifactReason: maskArtifact.reason,
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
      invalidMaskArtifacts,
      invalidOutputRows,
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
