import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { assertActive } from '../../src/entities/errors.js'
import { evaluateFreshRun } from './evaluate-fresh.js'
import { loadFreshCorpus, readBoundedCorpusFile } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'

const runId = 'v02-vision-route-screen-2026-10-20T133352225Z-58d53bca'
const inputManifestSha256 = '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a'
const truthSha256 = '793e26845deaa2cb56748ef270b8cb02877218d680068573f02e5af92b26af6a'
const sourceScriptSha256 = 'fa45f27b9b89b7106be27afc1c4499f68227ae3516b39d13c3d33cb2d9fd399e'
const terminalEvidenceSha256 = 'ca016f53da941c66f33d58a444eb23d038be3f9930321fdfece9c1d9db71d4f3'
const priorPhysicalCalls = 37
const screenCallLimit = 300
const screenCostLimitUsd = 5
const unknownReceiptReserveUsd = 0.02
const maxArtifactBytes = 2_097_152
const maxPngBytes = 8 * 1024 * 1024
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boxSchema = z
  .object({
    left: z.number().finite().nonnegative(),
    top: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()
const dimensionsSchema = z
  .object({ width: z.number().int().positive(), height: z.number().int().positive() })
  .strict()
const nativeProposalSchema = z
  .object({
    method: z.literal('mobile-sam-nine-point-proposals-v1'),
    backend: z.literal('mobile-sam'),
    durationMs: z.number().finite().nonnegative(),
    input: dimensionsSchema,
    candidateCount: z.number().int().min(1).max(36),
  })
  .strict()
const profileIds = [
  'ordinary-openai-luna-mobile-sam-screen-v2',
  'ordinary-qwen37-flash-alibaba-mobile-sam-screen-v2',
] as const
const profileSchema = z.enum(profileIds)

const resultStageCommon = {
  durationMs: z.number().finite().nonnegative(),
  physicalCalls: z.number().int().nonnegative(),
  logicalCalls: z.number().int().nonnegative(),
  requestHashes: z.array(digestSchema).max(30),
}
const classifySchema = z
  .object({
    status: z.enum(['ok', 'failed']),
    ...resultStageCommon,
    value: z.enum(['present', 'absent']).optional(),
    errorCode: z.string().max(100).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.status === 'ok') === (value.value !== undefined) &&
      value.requestHashes.length === value.logicalCalls &&
      value.physicalCalls <= value.logicalCalls,
  )
const locateSchema = z
  .object({
    status: z.enum(['located', 'unknown', 'not-found', 'failed']),
    ...resultStageCommon,
    region: boxSchema.optional(),
    reason: z.string().max(512).optional(),
    errorCode: z.string().max(100).optional(),
    nativeProposal: nativeProposalSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.status === 'located') === (value.region !== undefined) &&
      value.requestHashes.length === value.logicalCalls &&
      value.physicalCalls <= value.logicalCalls,
  )
const maskDescriptorSchema = z
  .object({
    file: z.literal('mask.u8'),
    sha256: digestSchema,
    format: z.literal('binary-u8'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sourceRegion: boxSchema,
    sourceOffset: z
      .object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() })
      .strict(),
    pngFile: z.literal('cutout.png'),
    pngSha256: digestSchema,
  })
  .strict()
const maskSchema = maskDescriptorSchema
  .refine((value) => value.width * value.height <= maxArtifactBytes)
  .refine(
    (value) =>
      value.sourceRegion.left === value.sourceOffset.x &&
      value.sourceRegion.top === value.sourceOffset.y &&
      value.sourceRegion.width === value.width &&
      value.sourceRegion.height === value.height,
  )
const extractSchema = z
  .object({
    status: z.enum(['extracted', 'unknown', 'not-found', 'failed']),
    durationMs: z.number().finite().nonnegative(),
    reason: z.string().max(512).optional(),
    errorCode: z.string().max(100).optional(),
    nativeProposal: nativeProposalSchema.optional(),
    mask: maskSchema.optional(),
  })
  .strict()
  .refine((value) => (value.status === 'extracted') === (value.mask !== undefined))
const resultRowSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    imageSha256: digestSchema,
    classify: classifySchema,
    locate: locateSchema,
    extract: extractSchema,
  })
  .strict()
const receiptSchema = z
  .object({
    physicalId: z.number().int().positive(),
    logicalId: z.number().int().positive(),
    requestSha256: digestSchema,
    requestBodySha256: digestSchema,
    admittedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    route: z
      .object({
        model: z.string().min(1),
        provider: z.string().min(1),
        providerName: z.string().min(1),
        apiEndpoint: z.literal('/api/v1/chat/completions'),
        allowFallbacks: z.literal(false),
      })
      .strict(),
    receipt: z
      .object({
        model: z.string().nullable(),
        provider: z.string().nullable(),
        requestId: z.string().nullable(),
        costUsd: z.number().finite().nonnegative().nullable(),
        durationMs: z.number().finite().nonnegative(),
        attempts: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    wireReceipt: z.record(z.string(), z.unknown()).nullable(),
    errorCode: z.string().max(100).nullable(),
  })
  .strict()
const budgetSchema = z
  .object({
    admittedPhysicalCalls: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownCostCalls: z.number().int().nonnegative(),
    inFlightCalls: z.number().int().nonnegative(),
    accountedExposureUsd: z.number().finite().nonnegative(),
    maxPhysicalCalls: z.number().int().positive(),
    maxCostUsd: z.number().finite().positive(),
  })
  .strict()
const summarySchema = z
  .object({
    runId: z.literal(runId),
    profileId: profileSchema,
    variantSha256: digestSchema,
    status: z.enum(['complete', 'incomplete']),
    plannedCaseIds: z.array(z.string().min(1)).length(20),
    completedCaseIds: z.array(z.string().min(1)).max(20),
    missingCaseIds: z.array(z.string().min(1)).max(20),
    results: z.array(resultRowSchema).max(20),
    aggregate: budgetSchema,
    screenAggregate: budgetSchema,
    latencyEnvironment: z.literal('screen-unranked-before-resource-soak'),
    latencyRankingEligible: z.literal(false),
    shutdownError: z.string().max(100).nullable(),
    physicalReceipts: z.array(receiptSchema).max(263),
  })
  .strict()

export function parseVisionScreenSummary(value: unknown) {
  return summarySchema.parse(value)
}

export function parseVisionScreenMaskDescriptor(value: unknown) {
  return maskSchema.parse(value)
}

const pairCompletionSchema = z
  .object({
    runId: z.literal(runId),
    completedAt: z.string().datetime(),
    aggregate: budgetSchema,
    profileIds: z.array(profileSchema).length(2),
  })
  .strict()

export function parseVisionScreenPairCompletion(value: unknown) {
  const pair = pairCompletionSchema.parse(value)
  if (
    new Set(pair.profileIds).size !== 2 ||
    !profileIds.every((id) => pair.profileIds.includes(id))
  )
    throw new Error('SCREEN pair completion marker is missing a route')
  return pair
}

const terminalProfileSchema = z
  .object({
    profileId: profileSchema,
    plannedCaseIds: z.array(z.string().min(1)).length(20),
    completedCaseIds: z.array(z.string().min(1)).max(20),
    missingCaseIds: z.array(z.string().min(1)).max(20),
    admissions: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative().optional(),
    settledHttp: z.number().int().nonnegative().optional(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownCostCalls: z.number().int().nonnegative(),
    unsettledAdmissions: z.number().int().nonnegative(),
    httpStatuses: z.record(z.string(), z.number().int().nonnegative()),
    summarySha256: digestSchema.optional(),
    runCompleteSha256: digestSchema.optional(),
    summaryWritten: z.boolean().optional(),
    runCompleteWritten: z.boolean().optional(),
  })
  .strict()
const terminalEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.literal(runId),
    status: z.literal('incomplete'),
    stopReason: z.string().min(1).max(500),
    rootSourceHead: z.literal('24f849fcf3d41ec6cebdaf50b96297e0b9ef1a58'),
    controllerSha256: z.literal(sourceScriptSha256),
    runManifestSha256: digestSchema,
    profiles: z.array(terminalProfileSchema).length(2),
    carriedPriorLedger: z
      .object({
        admissions: z.number().int().nonnegative(),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownCostCalls: z.number().int().nonnegative(),
        unsettledAdmissions: z.number().int().nonnegative(),
        reservedUnknownCostCalls: z.number().int().nonnegative(),
        accountedExposureUsd: z.number().finite().nonnegative(),
      })
      .strict(),
    cumulativeScreenLedger: z
      .object({
        admissions: z.number().int().nonnegative(),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownCostCalls: z.number().int().nonnegative(),
        unsettledAdmissions: z.number().int().nonnegative(),
        reservedUnknownCostCalls: z.number().int().nonnegative(),
        unknownCostReserveUsd: z.number().positive(),
        accountedExposureUsd: z.number().finite().nonnegative(),
        limits: z
          .object({ physicalCalls: z.number().int().positive(), costUsd: z.number().positive() })
          .strict(),
      })
      .strict(),
    truthLoaded: z.literal(false),
    automaticRetries: z.literal(0),
    fallbacks: z.literal(0),
  })
  .strict()

export function parseVisionScreenTerminalEvidence(value: unknown) {
  const evidence = terminalEvidenceSchema.parse(value)
  if (new Set(evidence.profiles.map((item) => item.profileId)).size !== 2)
    throw new Error('Terminal evidence does not contain each profile exactly once')
  return evidence
}

function assertTerminalRun(
  evidence: z.infer<typeof terminalEvidenceSchema>,
  manifestSha256: string,
  ids: readonly string[],
) {
  if (
    evidence.runManifestSha256 !== manifestSha256 ||
    evidence.cumulativeScreenLedger.admissions !== 157 ||
    evidence.cumulativeScreenLedger.knownCostUsd !== 0.073623795 ||
    evidence.cumulativeScreenLedger.unknownCostCalls !== 59 ||
    evidence.cumulativeScreenLedger.unsettledAdmissions !== 2 ||
    evidence.cumulativeScreenLedger.reservedUnknownCostCalls !== 61 ||
    evidence.cumulativeScreenLedger.accountedExposureUsd !== 1.293623795 ||
    evidence.cumulativeScreenLedger.limits.physicalCalls !== screenCallLimit ||
    evidence.cumulativeScreenLedger.limits.costUsd !== screenCostLimitUsd
  )
    throw new Error('Terminal SCREEN ledger or frozen run identity does not match')
  const luna = evidence.profiles.find((item) => item.profileId === profileIds[0])
  const qwen = evidence.profiles.find((item) => item.profileId === profileIds[1])
  if (!luna || !qwen) throw new Error('Terminal evidence is missing a profile')
  sameSet(ids, luna.plannedCaseIds, 'terminal Luna planned case')
  sameSet(ids, luna.completedCaseIds, 'terminal Luna completed case')
  if (
    luna.missingCaseIds.length !== 0 ||
    luna.admissions !== 82 ||
    luna.receipts !== 82 ||
    luna.unsettledAdmissions !== 0 ||
    luna.summarySha256 === undefined ||
    luna.runCompleteSha256 === undefined ||
    luna.httpStatuses['200'] !== 72 ||
    luna.httpStatuses.timeout !== 10
  )
    throw new Error('Luna terminal evidence differs from the completed route record')
  sameSet(ids, qwen.plannedCaseIds, 'terminal Qwen planned case')
  sameSet(
    qwen.completedCaseIds,
    [
      'photo-dev-absent-01',
      'photo-dev-absent-02',
      ...ids.filter((id) => id.startsWith('photo-dev-present-')),
    ],
    'terminal Qwen completed case',
  )
  if (
    qwen.completedCaseIds.length !== 18 ||
    qwen.missingCaseIds.length !== 2 ||
    qwen.admissions !== 38 ||
    qwen.settledHttp !== 37 ||
    qwen.httpStatuses['404'] !== 37 ||
    qwen.unknownCostCalls !== 37 ||
    qwen.unsettledAdmissions !== 1 ||
    qwen.summaryWritten !== false ||
    qwen.runCompleteWritten !== false
  )
    throw new Error('Qwen terminal evidence does not establish only a route failure')
}

export function assertVisionScreenLedger(
  aggregate: z.infer<typeof budgetSchema>,
  receipts: readonly z.infer<typeof receiptSchema>[],
  lastRouteLedger: z.infer<typeof budgetSchema>,
): void {
  const currentCalls = aggregate.admittedPhysicalCalls - priorPhysicalCalls
  const currentUnknownReceipts = aggregate.unknownCostCalls - 8
  const currentKnownCost = aggregate.knownCostUsd - 0.027881325
  const receiptKnownCost = receipts.reduce((sum, item) => sum + (item.receipt?.costUsd ?? 0), 0)
  const receiptUnknowns = receipts.filter(
    (item) => item.receipt === null || item.receipt.costUsd === null,
  ).length
  const physicalIds = receipts.map((item) => item.physicalId)
  if (
    aggregate.maxPhysicalCalls !== screenCallLimit ||
    aggregate.maxCostUsd !== screenCostLimitUsd ||
    aggregate.inFlightCalls !== 0 ||
    aggregate.admittedPhysicalCalls > screenCallLimit ||
    aggregate.accountedExposureUsd > screenCostLimitUsd + 1e-9 ||
    currentCalls !== receipts.length ||
    currentUnknownReceipts !== receiptUnknowns ||
    Math.abs(currentKnownCost - receiptKnownCost) > 1e-9 ||
    new Set(physicalIds).size !== physicalIds.length ||
    JSON.stringify(lastRouteLedger) !== JSON.stringify(aggregate)
  )
    throw new Error(
      'Pair completion ledger does not reconcile with route receipts and prior budget',
    )
}
const maskTruthSchema = z
  .array(
    z
      .object({
        caseId: z.string().min(1),
        referenceMasks: z
          .array(
            z
              .object({
                path: z.string().min(1),
                sha256: digestSchema,
                bytes: z
                  .number()
                  .int()
                  .positive()
                  .max(16 * 1024 * 1024),
                width: z.number().int().positive().max(2048),
                height: z.number().int().positive().max(2048),
              })
              .passthrough()
              .refine((value) => value.width * value.height <= maxArtifactBytes),
          )
          .max(100)
          .optional(),
      })
      .passthrough(),
  )
  .min(1)
  .max(120)
const fullTruthCaseSchema = z.array(z.object({ caseId: z.string().min(1) }).passthrough()).max(120)

export interface VisionScreenOptions {
  runDirectory: string
  imageRoot: string
  inputManifest: { path: string; sha256: string }
  truth: { path: string; sha256: string }
  outputDirectory: string
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

async function readJson(
  path: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ value: unknown; sha256: string; bytes: Uint8Array }> {
  const bytes = await readBoundedCorpusFile(path, limit, signal)
  try {
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, sha256: sha256(bytes), bytes }
  } catch (error) {
    bytes.fill(0)
    throw error
  }
}

async function readPinned(path: string, expectedSha256: string, signal: AbortSignal) {
  const parsed = await readJson(path, 16 * 1024 * 1024, signal)
  if (parsed.sha256 !== expectedSha256) {
    parsed.bytes.fill(0)
    throw new Error(`Pinned input hash mismatch: ${path}`)
  }
  return parsed
}

function sameSet(expected: readonly string[], actual: readonly string[], label: string): void {
  const sortedExpected = [...expected].sort()
  const sortedActual = [...actual].sort()
  if (
    expected.length !== actual.length ||
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    sortedExpected.some((item, index) => item !== sortedActual[index])
  )
    throw new Error(`Vision screen ${label} set mismatch`)
}

function pathWithin(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const rel = relative(resolvedRoot, resolvedCandidate)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`${label} escaped its permitted root`)
  return resolvedCandidate
}

async function writeExclusive(path: string, value: unknown): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  await writeFile(path, bytes, { flag: 'wx' })
  return sha256(bytes)
}

export function normalizeVisionScreenRow(row: z.infer<typeof resultRowSchema>, profile: string) {
  return {
    caseId: row.caseId,
    imageSha256: row.imageSha256,
    profileId: profile,
    classify: {
      status: row.classify.status,
      ...(row.classify.value ? { value: row.classify.value } : {}),
      durationMs: row.classify.durationMs,
      calls: row.classify.physicalCalls,
      requestHashes: row.classify.requestHashes,
      ...(row.classify.errorCode ? { errorCode: row.classify.errorCode } : {}),
    },
    locate: {
      status: row.locate.status,
      ...(row.locate.region ? { region: row.locate.region } : {}),
      ...(row.locate.reason ? { reason: row.locate.reason } : {}),
      durationMs: row.locate.durationMs,
      calls: row.locate.physicalCalls,
      requestHashes: row.locate.requestHashes,
      ...(row.locate.errorCode ? { errorCode: row.locate.errorCode } : {}),
    },
  }
}

async function scoreMasks(
  rows: readonly z.infer<typeof resultRowSchema>[],
  cases: readonly { caseId: string; image: { width: number; height: number } }[],
  truthRows: z.infer<typeof maskTruthSchema>,
  profileDirectory: string,
  imageRoot: string,
  signal: AbortSignal,
) {
  const truths = new Map(truthRows.map((row) => [row.caseId, row]))
  const predictions = new Map(rows.map((row) => [row.caseId, row]))
  const caseMap = new Map(cases.map((item) => [item.caseId, item]))
  type ScoreRow =
    | { caseId: string; status: 'unannotated'; referenceInstances: 0 }
    | { caseId: string; status: 'unavailable'; referenceInstances: number }
    | {
        caseId: string
        status: 'scored'
        referenceInstances: number
        instanceIoUs: Array<{ maskSha256: string; iou: number; passes: boolean }>
        bestInstanceIoU: number
        passes: boolean
      }
  const scoreRows: ScoreRow[] = []
  for (const [caseId, item] of caseMap) {
    assertActive(signal)
    const references = truths.get(caseId)?.referenceMasks ?? []
    if (!references.length) {
      scoreRows.push({ caseId, status: 'unannotated', referenceInstances: 0 })
      continue
    }
    const result = predictions.get(caseId)
    if (!result || result.extract.status !== 'extracted' || !result.extract.mask) {
      scoreRows.push({ caseId, status: 'unavailable', referenceInstances: references.length })
      continue
    }
    const descriptor = maskDescriptorSchema.parse(result.extract.mask)
    if (
      descriptor.width > item.image.width ||
      descriptor.height > item.image.height ||
      descriptor.sourceOffset.x + descriptor.width > item.image.width ||
      descriptor.sourceOffset.y + descriptor.height > item.image.height
    )
      throw new Error('Predicted mask escaped the source raster')
    const caseDirectory = pathWithin(
      profileDirectory,
      resolve(profileDirectory, caseId),
      'Case directory',
    )
    const maskPath = pathWithin(
      caseDirectory,
      resolve(caseDirectory, descriptor.file),
      'Predicted mask',
    )
    const pngPath = pathWithin(
      caseDirectory,
      resolve(caseDirectory, descriptor.pngFile),
      'Predicted cutout',
    )
    const predBytes = await readBoundedCorpusFile(maskPath, maxArtifactBytes, signal)
    const pngBytes = await readBoundedCorpusFile(pngPath, maxPngBytes, signal)
    try {
      if (
        predBytes.length !== descriptor.width * descriptor.height ||
        sha256(predBytes) !== descriptor.sha256 ||
        predBytes.some((n) => n !== 0 && n !== 1)
      )
        throw new Error('Predicted mask bytes failed size, digest, or binary validation')
      if (sha256(pngBytes) !== descriptor.pngSha256) throw new Error('Cutout PNG digest mismatch')
      const pngMeta = await sharp(pngBytes, { limitInputPixels: maxArtifactBytes }).metadata()
      if (
        pngMeta.format !== 'png' ||
        pngMeta.width !== descriptor.width ||
        pngMeta.height !== descriptor.height
      )
        throw new Error('Cutout PNG geometry mismatch')
      const ious: Array<{ maskSha256: string; iou: number; passes: boolean }> = []
      for (const reference of references) {
        if (
          reference.width !== item.image.width ||
          reference.height !== item.image.height ||
          isAbsolute(reference.path) ||
          /^[A-Za-z]:[\\/]/u.test(reference.path)
        )
          throw new Error('Reference mask metadata/path is invalid')
        const truthPath = pathWithin(
          imageRoot,
          resolve(imageRoot, reference.path),
          'Reference mask',
        )
        const truthBytes = await readBoundedCorpusFile(truthPath, reference.bytes, signal)
        try {
          if (truthBytes.length !== reference.bytes || sha256(truthBytes) !== reference.sha256)
            throw new Error('Reference mask bytes failed size or digest validation')
          const decoded = await sharp(truthBytes, { limitInputPixels: maxArtifactBytes })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true })
          if (
            decoded.info.width !== item.image.width ||
            decoded.info.height !== item.image.height ||
            decoded.info.channels !== 1 ||
            decoded.data.some((n) => n !== 0 && n !== 255)
          )
            throw new Error('Reference mask is not a binary source-sized grayscale raster')
          let intersection = 0
          let union = 0
          for (let y = 0; y < item.image.height; y++) {
            assertActive(signal)
            for (let x = 0; x < item.image.width; x++) {
              const target = decoded.data[y * item.image.width + x] !== 0
              const px = x - descriptor.sourceOffset.x
              const py = y - descriptor.sourceOffset.y
              const predicted =
                px >= 0 &&
                py >= 0 &&
                px < descriptor.width &&
                py < descriptor.height &&
                predBytes[py * descriptor.width + px] === 1
              if (target || predicted) union++
              if (target && predicted) intersection++
            }
          }
          const iou = union ? intersection / union : 0
          ious.push({ maskSha256: reference.sha256, iou, passes: iou >= 0.8 })
        } finally {
          truthBytes.fill(0)
        }
      }
      scoreRows.push({
        caseId,
        status: 'scored',
        referenceInstances: references.length,
        instanceIoUs: ious,
        bestInstanceIoU: Math.max(...ious.map((x) => x.iou)),
        passes: ious.some((x) => x.passes),
      })
    } finally {
      predBytes.fill(0)
      pngBytes.fill(0)
    }
  }
  const scored = scoreRows.filter((row) => row.status === 'scored')
  const annotated = scoreRows.filter((row) => row.referenceInstances !== 0)
  const instanceRows = scored.flatMap((row) => row.instanceIoUs)
  return {
    threshold: 0.8,
    annotatedCases: annotated.length,
    scoredCases: scored.length,
    unavailableAnnotatedCases: annotated.length - scored.length,
    unannotatedCases: scoreRows.length - annotated.length,
    referenceInstances: annotated.reduce((sum, row) => sum + Number(row.referenceInstances), 0),
    scoredReferenceInstances: instanceRows.length,
    passingReferenceInstances: instanceRows.filter((item) => item.passes).length,
    passingCases: scored.filter((row) => row.passes === true).length,
    meanInstanceIoU: instanceRows.length
      ? instanceRows.reduce((sum, item) => sum + item.iou, 0) / instanceRows.length
      : null,
    rows: scoreRows,
  }
}

/** Score a completed route; an incomplete pair is reported without scoring the unavailable route. */
export async function evaluateVisionRouteScreen(input: VisionScreenOptions, signal: AbortSignal) {
  assertActive(signal)
  const runDirectory = resolve(input.runDirectory)
  const outputDirectory = resolve(input.outputDirectory)
  await mkdir(outputDirectory, { recursive: false })
  const inputManifest = await readPinned(input.inputManifest.path, inputManifestSha256, signal)
  if (input.inputManifest.sha256 !== inputManifestSha256)
    throw new Error('Unexpected SCREEN photo input pin')
  const truth = await readPinned(input.truth.path, truthSha256, signal)
  if (input.truth.sha256 !== truthSha256) throw new Error('Unexpected SCREEN photo truth pin')
  const rootCompletePath = resolve(runDirectory, 'run-complete.json')
  let rootCompleteFile: Awaited<ReturnType<typeof readJson>> | undefined
  try {
    await access(rootCompletePath)
    rootCompleteFile = await readJson(rootCompletePath, 1024 * 1024, signal)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  let terminalFile: Awaited<ReturnType<typeof readJson>> | undefined
  if (!rootCompleteFile)
    terminalFile = await readPinned(
      resolve(runDirectory, 'terminal/incomplete-evidence.json'),
      terminalEvidenceSha256,
      signal,
    )
  const rootComplete = rootCompleteFile
    ? parseVisionScreenPairCompletion(rootCompleteFile.value)
    : undefined
  const terminal = terminalFile ? parseVisionScreenTerminalEvidence(terminalFile.value) : undefined
  const manifestFile = await readJson(
    resolve(runDirectory, 'run-manifest.json'),
    8 * 1024 * 1024,
    signal,
  )
  const manifest = z
    .object({
      schemaVersion: z.literal(1),
      runId: z.literal(runId),
      profileId: z.literal('ordinary-vision-mobile-sam-screen-pair-v2'),
      startedAt: z.string().datetime(),
      variantSha256: digestSchema,
      sourceHashes: z.record(z.string(), digestSchema),
      input: z
        .object({
          manifestSha256: z.literal(inputManifestSha256),
          plannedCaseIds: z.array(z.string()).length(20),
          cases: z
            .array(
              z
                .object({
                  caseId: z.string(),
                  sourceSha256: digestSchema,
                  width: z.number().int().positive(),
                  height: z.number().int().positive(),
                  targetTaskSha256: digestSchema,
                  classifyTaskSha256: digestSchema,
                  validatedStages: z.array(z.enum(['classify', 'whole-object', 'extract'])),
                })
                .strict(),
            )
            .length(20),
        })
        .strict(),
      mobileSam: z
        .object({
          method: z.literal('mobile-sam-nine-point-proposals-v1'),
          executionProvider: z.literal('cpu'),
          encoderSha256: digestSchema,
          decoderSha256: digestSchema,
        })
        .strict(),
      profiles: z
        .array(
          z
            .object({
              id: profileSchema,
              model: z.string().min(1),
              provider: z.string().min(1),
              providerName: z.string().min(1),
              apiEndpoint: z.literal('https://openrouter.ai/api/v1/chat/completions'),
              allowFallbacks: z.literal(false),
              responseFormat: z.literal('json-schema'),
              reasoningEffort: z.literal('none'),
              maxOutputTokens: z.literal(1024),
              timeoutMs: z.literal(45_000),
              maxExtentPasses: z.literal(3),
              boxTolerancePx: z.literal(8),
              retries: z.literal(0),
              concurrency: z.literal(1),
              maxQueue: z.literal(0),
              presentation: z.literal('original-image-numeric-v1'),
              route: z
                .object({
                  model: z.string(),
                  provider: z.string(),
                  providerName: z.string(),
                  apiEndpoint: z.literal('/api/v1/chat/completions'),
                  allowFallbacks: z.literal(false),
                })
                .strict(),
            })
            .strict(),
        )
        .length(2),
      policy: z
        .object({
          screenMaxPhysicalCalls: z.literal(screenCallLimit),
          screenMaxCostUsd: z.literal(screenCostLimitUsd),
          priorLedger: z
            .object({
              admissions: z.literal(priorPhysicalCalls),
              knownCostUsd: z.number().nonnegative(),
              unknownCostCalls: z.number().int().nonnegative(),
              accountedExposureUsd: z.number().nonnegative(),
            })
            .strict(),
          availablePhysicalCallsAfterPriorRun: z.number().int().positive(),
          availableCostUsdAfterPriorRun: z.number().positive(),
          unknownCostReserveUsd: z.literal(unknownReceiptReserveUsd),
          timeoutMs: z.literal(45_000),
          maxExtentPasses: z.literal(3),
          boxTolerancePx: z.literal(8),
          retries: z.literal(0),
          fallback: z.literal(false),
          concurrency: z.literal(1),
          maxQueue: z.literal(0),
          latencyEnvironment: z.literal('screen-unranked-before-resource-soak'),
          latencyRankingEligible: z.literal(false),
        })
        .strict(),
      classification: z.record(z.string(), z.unknown()),
      offlineSmoke: z.record(z.string(), z.unknown()),
      boundaries: z
        .object({
          groundTruthLoaded: z.literal(false),
          classificationFeedsLocalization: z.literal(false),
          retries: z.literal(0),
          fallback: z.literal(false),
        })
        .strict(),
    })
    .strict()
    .parse(manifestFile.value)
  const inputRows = z
    .array(
      z
        .object({
          caseId: z.string(),
          image: z
            .object({
              path: z.string(),
              sha256: digestSchema,
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            })
            .strict(),
        })
        .passthrough(),
    )
    .length(20)
    .parse(inputManifest.value)
  const corpus = await loadFreshCorpus(
    { manifests: [input.inputManifest], imageRoot: input.imageRoot },
    signal,
  )
  if (corpus.cases.length !== 20 || inputRows.length !== 20)
    throw new Error('SCREEN requires exactly the pinned 20-photo corpus')
  const ids = corpus.cases.map((item) => item.caseId)
  sameSet(ids, manifest.input.plannedCaseIds, 'run manifest case')
  sameSet(
    ids,
    manifest.input.cases.map((item) => item.caseId),
    'run manifest source case',
  )
  if (manifest.sourceHashes['.run/v02/vision-route-screen.ts'] !== sourceScriptSha256)
    throw new Error('SCREEN producer source differs from the reviewed frozen controller')
  const corpusById = new Map(corpus.cases.map((item) => [item.caseId, item]))
  for (const item of manifest.input.cases) {
    const source = corpusById.get(item.caseId)!
    if (
      item.sourceSha256 !== source.image.sha256 ||
      item.width !== source.image.width ||
      item.height !== source.image.height ||
      item.validatedStages.join(',') !== 'classify,whole-object,extract'
    )
      throw new Error('SCREEN run manifest case differs from the pinned photo input')
  }
  for (const item of inputRows) {
    const source = corpusById.get(item.caseId)!
    if (
      item.image.sha256 !== source.image.sha256 ||
      item.image.width !== source.image.width ||
      item.image.height !== source.image.height
    )
      throw new Error('SCREEN input manifest rows differ from the pinned photo inputs')
  }
  const truthRows = maskTruthSchema.parse(truth.value)
  sameSet(
    ids,
    truthRows.map((item) => item.caseId).filter((id) => ids.includes(id)),
    'truth case',
  )
  if (!rootComplete && !terminal)
    throw new Error('SCREEN has neither pair completion nor terminal evidence')
  if (terminal) assertTerminalRun(terminal, manifestFile.sha256, ids)
  const selectedProfileIds: readonly string[] = rootComplete ? profileIds : [profileIds[0]]
  const profileEvaluations = []
  const routeReceipts: Array<z.infer<typeof receiptSchema>> = []
  let lastRouteLedger: z.infer<typeof budgetSchema> | undefined
  let lastProfileBudget: z.infer<typeof budgetSchema> | undefined
  for (const profileId of selectedProfileIds) {
    assertActive(signal)
    const profileDirectory = resolve(runDirectory, profileId)
    const frozenProfile = manifest.profiles.find((item) => item.id === profileId)!
    const { id: _id, model, provider, providerName, route, ...presentation } = frozenProfile
    if (route.model !== model || route.provider !== provider || route.providerName !== providerName)
      throw new Error('Profile route differs from the paired run manifest')
    const expectedVariantSha256 = hashCanonical({
      route: { id: profileId, model, provider, providerName },
      presentation,
      policy: manifest.policy,
      manifestHash: inputManifestSha256,
      sourceHashes: manifest.sourceHashes,
      assetHashes: [manifest.mobileSam.encoderSha256, manifest.mobileSam.decoderSha256],
      cases: manifest.input.cases,
    })
    const completeFile = await readJson(
      resolve(profileDirectory, 'run-complete.json'),
      1024 * 1024,
      signal,
    )
    const complete = z
      .object({
        profileId: z.literal(profileId),
        completedAt: z.string().datetime(),
        summarySha256: digestSchema,
      })
      .strict()
      .parse(completeFile.value)
    const summaryFile = await readJson(
      resolve(profileDirectory, 'summary.json'),
      16 * 1024 * 1024,
      signal,
    )
    if (hashCanonical(summaryFile.value) !== complete.summarySha256)
      throw new Error('Route summary digest does not match its completion marker')
    const summary = summarySchema.parse(summaryFile.value)
    if (summary.profileId !== profileId || summary.variantSha256 !== expectedVariantSha256)
      throw new Error('Route summary profile identity mismatch')
    if (summary.status !== 'complete' || summary.shutdownError !== null)
      throw new Error('Route summary is incomplete or shutdown failed')
    sameSet(ids, summary.plannedCaseIds, 'route planned case')
    sameSet(ids, summary.completedCaseIds, 'route completed case')
    if (summary.missingCaseIds.length) throw new Error('Route summary has missing cases')
    sameSet(
      ids,
      summary.results.map((row) => row.caseId),
      'route result',
    )
    const caseById = new Map(corpus.cases.map((item) => [item.caseId, item]))
    for (const row of summary.results) {
      const item = caseById.get(row.caseId)!
      if (row.imageSha256 !== item.image.sha256)
        throw new Error('Raw result image hash differs from frozen producer input')
      if (
        row.locate.region &&
        (row.locate.region.left + row.locate.region.width > item.image.width ||
          row.locate.region.top + row.locate.region.height > item.image.height)
      )
        throw new Error('Located region escaped source raster')
      const rawResultPath = resolve(profileDirectory, row.caseId, 'result.json')
      const rawResultFile = await readJson(rawResultPath, 1024 * 1024, signal)
      const rawResult = resultRowSchema.parse(rawResultFile.value)
      if (JSON.stringify(rawResult) !== JSON.stringify(row))
        throw new Error('Per-case durable result differs from the frozen route summary')
      rawResultFile.bytes.fill(0)
    }
    const receiptIds = new Set<number>()
    for (const receipt of summary.physicalReceipts) {
      if (receiptIds.has(receipt.physicalId)) throw new Error('Duplicate physical receipt ID')
      receiptIds.add(receipt.physicalId)
      if (
        receipt.route.model !== frozenProfile.model ||
        receipt.route.provider !== frozenProfile.provider
      )
        throw new Error('Physical receipt route differs from frozen route')
      routeReceipts.push(receipt)
    }
    const stagedPhysical = summary.results.reduce(
      (sum, row) => sum + row.classify.physicalCalls + row.locate.physicalCalls,
      0,
    )
    if (stagedPhysical !== summary.physicalReceipts.length)
      throw new Error('Stage physical-call counts do not reconcile with receipt ledger')
    if (
      summary.aggregate.maxPhysicalCalls !== screenCallLimit - priorPhysicalCalls ||
      Math.abs(summary.aggregate.maxCostUsd - 4.812118675) > 1e-9 ||
      summary.aggregate.inFlightCalls !== 0 ||
      summary.screenAggregate.maxPhysicalCalls !== screenCallLimit ||
      summary.screenAggregate.maxCostUsd !== screenCostLimitUsd ||
      summary.screenAggregate.admittedPhysicalCalls > screenCallLimit ||
      summary.screenAggregate.inFlightCalls !== 0 ||
      summary.screenAggregate.accountedExposureUsd > screenCostLimitUsd + 1e-9
    )
      throw new Error('Route budget ledger violates the frozen SCREEN limits')
    const normalizedDirectory = resolve(outputDirectory, profileId)
    await mkdir(normalizedDirectory, { recursive: false })
    const normalizedSummary = {
      runId,
      status: 'complete' as const,
      completedCaseIds: ids,
      missingCaseIds: [],
      results: summary.results.map((row) => normalizeVisionScreenRow(row, profileId)),
    }
    const normalizedManifest = { runId, profileId, plannedCaseIds: ids }
    const normalizedSummaryPath = resolve(normalizedDirectory, 'summary.json')
    const normalizedManifestPath = resolve(normalizedDirectory, 'run-manifest.json')
    const normalizedSummarySha = await writeExclusive(normalizedSummaryPath, normalizedSummary)
    const normalizedManifestSha = await writeExclusive(normalizedManifestPath, normalizedManifest)
    const evaluationPath = resolve(normalizedDirectory, 'whole-object-evaluation.json')
    const truthSubset = fullTruthCaseSchema
      .parse(truth.value)
      .filter((item) => ids.includes(item.caseId))
    const normalizedTruthPath = resolve(normalizedDirectory, 'truth.json')
    const normalizedTruthSha = await writeExclusive(normalizedTruthPath, truthSubset)
    const wholeObject = await evaluateFreshRun(
      {
        summary: { path: normalizedSummaryPath, sha256: normalizedSummarySha },
        runManifest: { path: normalizedManifestPath, sha256: normalizedManifestSha },
        corpus: { manifests: [input.inputManifest], imageRoot: input.imageRoot },
        truths: [{ path: normalizedTruthPath, sha256: normalizedTruthSha }],
        output: evaluationPath,
      },
      signal,
    )
    const masks = await scoreMasks(
      summary.results,
      corpus.cases,
      truthRows.filter((row) => ids.includes(row.caseId)),
      profileDirectory,
      input.imageRoot,
      signal,
    )
    const result = {
      profileId,
      summaryArtifactSha256: summaryFile.sha256,
      summaryCanonicalSha256: complete.summarySha256,
      runCompleteSha256: completeFile.sha256,
      normalizedSummarySha256: normalizedSummarySha,
      normalizedRunManifestSha256: normalizedManifestSha,
      wholeObject,
      masks,
      ledger: {
        casePhysicalCalls: stagedPhysical,
        receiptPhysicalCalls: summary.physicalReceipts.length,
        unknownReceiptCount: summary.physicalReceipts.filter((receipt) => receipt.receipt === null)
          .length,
        stageLogicalCalls: summary.results.reduce(
          (sum, row) => sum + row.classify.logicalCalls + row.locate.logicalCalls,
          0,
        ),
        profileBudget: summary.aggregate,
      },
    }
    await writeExclusive(resolve(normalizedDirectory, 'evaluation.json'), result)
    profileEvaluations.push(result)
    lastRouteLedger = summary.screenAggregate
    lastProfileBudget = summary.aggregate
  }
  if (!lastRouteLedger || !lastProfileBudget)
    throw new Error('SCREEN has no completed route ledger')
  if (rootComplete) {
    assertVisionScreenLedger(rootComplete.aggregate, routeReceipts, lastRouteLedger)
  } else {
    const luna = terminal!.profiles.find((item) => item.profileId === profileIds[0])!
    const receiptKnownCost = routeReceipts.reduce(
      (sum, item) => sum + (item.receipt?.costUsd ?? 0),
      0,
    )
    const receiptUnknowns = routeReceipts.filter(
      (item) => item.receipt === null || item.receipt.costUsd === null,
    ).length
    if (
      routeReceipts.length !== luna.receipts ||
      receiptUnknowns !== luna.unknownCostCalls ||
      Math.abs(receiptKnownCost - luna.knownCostUsd) > 1e-9 ||
      lastProfileBudget.admittedPhysicalCalls !== luna.admissions ||
      lastProfileBudget.unknownCostCalls !== luna.unknownCostCalls ||
      Math.abs(lastProfileBudget.knownCostUsd - luna.knownCostUsd) > 1e-9 ||
      lastProfileBudget.inFlightCalls !== 0
    )
      throw new Error('Closed Luna route ledger differs from terminal evidence')
  }
  const result = {
    schema: 'ordinary-vision-screen-independent-evaluation-v1',
    runId,
    pairStatus: rootComplete ? 'complete' : 'incomplete',
    ...(rootCompleteFile ? { pairRunCompleteSha256: rootCompleteFile.sha256 } : {}),
    ...(terminalFile
      ? {
          terminalEvidenceSha256: terminalFile.sha256,
          unavailableRoute: {
            profileId: profileIds[1],
            status: 'route-unavailable',
            http404Responses:
              terminal!.profiles.find((item) => item.profileId === profileIds[1])!.httpStatuses[
                '404'
              ] ?? 0,
            scoredForVisionAccuracy: false,
          },
        }
      : {}),
    runManifestSha256: manifestFile.sha256,
    sourceInputSha256: inputManifestSha256,
    sourceTruthSha256: truthSha256,
    sourceScriptSha256,
    phaseScope: '20-photo DEV SCREEN only; not the full 40-case DEV gate',
    latency: {
      rawLegacyLabel: 'screen-unranked-before-resource-soak',
      actualEnvironment: 'concurrent native resource soak',
      rankingEligible: false,
      interpretation: 'Durations are retained as diagnostics only; this run cannot rank latency.',
    },
    overallLedger: rootComplete?.aggregate ?? terminal!.cumulativeScreenLedger,
    profiles: profileEvaluations,
  }
  const evaluationSha256 = await writeExclusive(resolve(outputDirectory, 'evaluation.json'), result)
  truth.bytes.fill(0)
  inputManifest.bytes.fill(0)
  return { ...result, evaluationSha256 }
}
