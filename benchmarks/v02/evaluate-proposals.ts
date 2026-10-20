import { createHash, randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { assertActive } from '../../src/entities/errors.js'
import { evaluateFreshRun } from './evaluate-fresh.js'
import { freshProducerTask, loadFreshCorpus, readBoundedCorpusFile } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'

const profileId = 'native-mobile-sam-proposals-v1'
const expectedProposalAssets = {
  method: 'mobile-sam-nine-point-proposals-v1',
  executionProvider: 'cpu',
  encoder: {
    bytes: 28_157_093,
    sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
  },
  decoder: {
    bytes: 16_496_559,
    sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
  },
} as const
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const pinnedFileSchema = z.object({ path: z.string().min(1), sha256: digestSchema }).strict()

/** Exact fresh DEV manifests admitted by the proposal profile. */
export const freshProposalInputPins = Object.freeze([
  { sha256: '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a', cases: 20 },
  { sha256: '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc', cases: 10 },
  { sha256: 'b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15', cases: 10 },
])

const boxSchema = z
  .object({
    left: z.number().finite().nonnegative(),
    top: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()
const dimensionSchema = z
  .object({ width: z.number().int().positive(), height: z.number().int().positive() })
  .strict()
const classSchema = z
  .object({
    id: z.enum(['present', 'absent']),
    description: z.string().min(1).max(200),
  })
  .strict()
const routeSchema = z
  .object({
    id: z.literal('openai-gpt-6-luna-decisions-openai-v1'),
    model: z.literal('openai/gpt-6-luna-decisions'),
    provider: z.literal('openai'),
    providerName: z.literal('OpenAI'),
    apiEndpoint: z.literal('/api/alpha/decisions'),
    allowFallbacks: z.literal(false),
  })
  .strict()
const assetSchema = z.object({ bytes: z.number().int().positive(), sha256: digestSchema }).strict()
const proposalAssetSchema = z
  .object({
    method: z.literal('mobile-sam-nine-point-proposals-v1'),
    executionProvider: z.literal('cpu'),
    encoder: assetSchema,
    decoder: assetSchema,
  })
  .strict()
const policySchema = z
  .object({
    timeoutMs: z.number().int().positive(),
    concurrency: z.literal(1),
    maxQueue: z.literal(0),
    boxTolerancePx: z.number().int().nonnegative(),
    maxExtentPasses: z.number().int().positive(),
    retries: z.literal(0),
    fallback: z.literal(false),
    maxPhysicalCalls: z.number().int().positive(),
    maxCostUsd: z.number().positive(),
    unknownCostReserveUsd: z.number().positive(),
    latencyEnvironment: z.string().min(1),
    latencyRankingEligible: z.boolean(),
  })
  .strict()
const producerTaskSchema = z
  .object({
    target: z.string().min(1).max(2000),
    instruction: z.string().min(1).max(4000).optional(),
    question: z.string().min(1).max(4000),
    classes: z.tuple([z.literal('present'), z.literal('absent')]),
  })
  .strict()
const caseManifestSchema = z
  .object({
    caseId: z.string().min(1),
    imageSha256: digestSchema,
    imageDimensions: dimensionSchema,
  })
  .strict()
const taskManifestSchema = z
  .array(z.object({ caseId: z.string().min(1), task: producerTaskSchema }).strict())
  .length(40)
const sourceHashesSchema = z.record(z.string().min(1), digestSchema).refine((value) => {
  const required = [
    './fresh-proposal-runner.ts',
    './run-fresh-proposals.ts',
    './fresh-corpus.ts',
    './recording.ts',
    './budget.ts',
    './protocol.ts',
    '../../package.json',
    '../../package-lock.json',
  ]
  return required.every((key) => Object.hasOwn(value, key))
})
const runManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(160),
    profileId: z.literal(profileId),
    purpose: z.literal('full fresh DEV photo, independent UI and independent map producer pass'),
    startedAt: z.string().datetime(),
    variantSha256: digestSchema,
    producerSourceSha256: digestSchema,
    sourceHashes: sourceHashesSchema,
    manifests: z
      .array(z.object({ sha256: digestSchema, cases: z.number().int().positive() }).strict())
      .length(3),
    plannedCaseIds: z.array(z.string().min(1).max(128)).length(40),
    plannedCases: z.array(caseManifestSchema).length(40),
    route: routeSchema,
    mobileSam: proposalAssetSchema,
    policy: policySchema,
    classification: z
      .object({
        questionSource: z.literal('freshProducerTask.question'),
        instructionSuffix: z.string().min(1),
        classes: z.tuple([classSchema, classSchema]),
      })
      .strict(),
    taskManifest: taskManifestSchema,
    modelBoundary: z
      .object({
        evaluatorTruthRead: z.literal(false),
        groundTruthInProducer: z.literal(false),
        retries: z.literal(0),
        fallback: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.plannedCaseIds).size !== value.plannedCaseIds.length)
      context.addIssue({ code: 'custom', message: 'Run manifest has duplicate planned case IDs' })
    if (
      value.producerSourceSha256 !==
      hashCanonical(Object.entries(value.sourceHashes).sort(([a], [b]) => a.localeCompare(b)))
    )
      context.addIssue({ code: 'custom', message: 'Run manifest source-hash digest mismatch' })
    if (!sameJson(value.mobileSam, expectedProposalAssets))
      context.addIssue({ code: 'custom', message: 'Run manifest MobileSAM asset pin mismatch' })
  })

const stageCommon = {
  durationMs: z.number().finite().nonnegative(),
  physicalCalls: z.number().int().nonnegative(),
  logicalCalls: z.number().int().nonnegative(),
  requestHashes: z.array(digestSchema).max(12),
}
const classificationStageSchema = z
  .object({
    status: z.enum(['ok', 'failed']),
    ...stageCommon,
    value: z.enum(['present', 'absent']).optional(),
    errorCode: z.string().max(100).optional(),
  })
  .strict()
  .refine((value) => (value.status === 'ok') === (value.value !== undefined))
const locationStageSchema = z
  .object({
    status: z.enum(['located', 'unknown', 'not-found', 'failed']),
    ...stageCommon,
    region: boxSchema.optional(),
    reason: z.string().max(512).optional(),
    errorCode: z.string().max(100).optional(),
    nativeProposal: z
      .object({
        method: z.string().min(1).max(100),
        backend: z.string().min(1).max(100),
        durationMs: z.number().finite().nonnegative(),
        input: dimensionSchema,
        candidateCount: z.number().int().min(1).max(36),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.status === 'located') === (value.region !== undefined))
const extractionStageSchema = z
  .object({
    status: z.enum(['extracted', 'unknown', 'not-found', 'failed']),
    durationMs: z.number().finite().nonnegative(),
    reason: z.string().max(512).optional(),
    errorCode: z.string().max(100).optional(),
    nativeProposal: z
      .object({
        method: z.string().min(1).max(100),
        backend: z.string().min(1).max(100),
        durationMs: z.number().finite().nonnegative(),
        input: dimensionSchema,
        candidateCount: z.number().int().min(1).max(36),
      })
      .strict()
      .optional(),
    segmentation: z
      .object({
        method: z.string().min(1).max(100),
        backend: z.string().min(1).max(100),
        durationMs: z.number().finite().nonnegative(),
        input: dimensionSchema,
        qualityScore: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    mask: z
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
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === 'extracted') !== (value.mask !== undefined))
      context.addIssue({ code: 'custom', message: 'Extraction artifact/status mismatch' })
    if (value.status === 'extracted' && value.segmentation === undefined)
      context.addIssue({ code: 'custom', message: 'Extracted result lacks segmentation metadata' })
    if (value.status === 'extracted' && value.nativeProposal === undefined)
      context.addIssue({
        code: 'custom',
        message: 'Extracted result lacks native proposal metadata',
      })
    if (value.status === 'failed' && value.errorCode === undefined)
      context.addIssue({ code: 'custom', message: 'Failed extraction lacks error code' })
    if (
      value.mask &&
      (value.mask.sourceRegion.width !== value.mask.width ||
        value.mask.sourceRegion.height !== value.mask.height)
    )
      context.addIssue({
        code: 'custom',
        message: 'Mask dimensions differ from its cropped source region',
      })
    if (
      value.mask &&
      (value.mask.sourceOffset.x !== value.mask.sourceRegion.left ||
        value.mask.sourceOffset.y !== value.mask.sourceRegion.top)
    )
      context.addIssue({
        code: 'custom',
        message: 'Mask source offset differs from its absolute source region',
      })
  })
const resultSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    imageSha256: digestSchema,
    classify: classificationStageSchema,
    locate: locationStageSchema,
    extract: extractionStageSchema,
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
    maxCostUsd: z.number().positive(),
  })
  .strict()
const nullableText = z.string().max(256).nullable()
const wireReceiptSchema = z
  .object({
    responseModel: nullableText,
    responseProvider: nullableText,
    responseId: nullableText,
    usageCostUsd: z.number().finite().nonnegative().nullable(),
    errorType: nullableText,
    errorCode: nullableText,
    errorParameter: nullableText,
    errorCategory: z
      .enum([
        'unsupported-parameter',
        'unsupported-route',
        'rate-limited',
        'invalid-request',
        'other',
      ])
      .nullable(),
    errorReason: z
      .enum([
        'unsupported-parameter',
        'no-provider-endpoint',
        'model-unavailable',
        'provider-unavailable',
        'rate-limited',
        'invalid-request',
        'other',
      ])
      .nullable(),
    rateLimitScope: z.enum(['account', 'key', 'provider', 'unknown']).nullable(),
    retryAfterSeconds: z.number().finite().nonnegative().nullable(),
    responseDisposition: z
      .enum([
        'error-envelope',
        'chat-json-object',
        'chat-json-nonobject',
        'chat-invalid-json',
        'chat-truncated-output',
        'chat-empty',
        'chat-content-array',
        'chat-missing-content',
        'chat-refusal',
        'typed-decisions-response',
        'other-json',
      ])
      .nullable(),
    finishReason: nullableText,
    bodyRead: z.enum([
      'parsed',
      'invalid-json',
      'oversize',
      'stalled',
      'cancelled',
      'stream-error',
      'empty',
    ]),
  })
  .strict()
const receiptSchema = z
  .object({
    model: nullableText,
    provider: nullableText,
    requestId: nullableText,
    costUsd: z.number().finite().nonnegative().nullable(),
    durationMs: z.number().finite().nonnegative(),
    attempts: z.number().int().nonnegative(),
  })
  .strict()
const physicalReceiptSchema = z
  .object({
    physicalId: z.number().int().positive(),
    logicalId: z.number().int().positive(),
    requestSha256: digestSchema,
    requestBodySha256: digestSchema,
    admittedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    route: routeSchema,
    receipt: receiptSchema.nullable(),
    wireReceipt: wireReceiptSchema.nullable(),
    errorCode: z.string().max(100).optional(),
  })
  .strict()
const rawSummarySchema = z
  .object({
    runId: z.string().min(1).max(160),
    profileId: z.literal(profileId),
    variantSha256: digestSchema,
    status: z.enum(['complete', 'incomplete']),
    plannedCaseIds: z.array(z.string().min(1).max(128)).length(40),
    completedCaseIds: z.array(z.string().min(1).max(128)).max(40),
    missingCaseIds: z.array(z.string().min(1).max(128)).max(40),
    results: z.array(resultSchema).max(40),
    aggregate: budgetSchema,
    latencyEnvironment: z.string().min(1).max(200),
    latencyRankingEligible: z.boolean(),
    initializationError: z.string().max(100).nullable(),
    shutdownError: z.string().max(100).nullable(),
    physicalReceipts: z.array(physicalReceiptSchema).max(300),
  })
  .strict()

const referenceMaskSchema = z
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
const maskTruthRowSchema = z
  .object({
    caseId: z.string().min(1),
    referenceMasks: z.array(referenceMaskSchema).max(100).optional(),
  })
  .passthrough()

const optionsSchema = z
  .object({
    rawSummary: pinnedFileSchema,
    runManifest: pinnedFileSchema,
    corpus: z
      .object({ manifests: z.array(pinnedFileSchema).length(3), imageRoot: z.string().min(1) })
      .strict(),
    truths: z.array(pinnedFileSchema).length(3),
    derivedSummary: z.string().min(1),
    output: z.string().min(1),
    provenanceOutput: z.string().min(1),
  })
  .strict()

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readPinnedJson(file: z.infer<typeof pinnedFileSchema>, signal: AbortSignal) {
  const bytes = await readBoundedCorpusFile(file.path, 16 * 1024 * 1024, signal)
  try {
    const actual = sha256(bytes)
    if (actual !== file.sha256) throw new Error('Pinned fresh proposal artifact hash mismatch')
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, sha256: actual }
  } finally {
    bytes.fill(0)
  }
}

function sameIds(expected: readonly string[], actual: readonly string[], label: string): void {
  const a = [...expected].sort()
  const b = [...actual].sort()
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    a.some((id, index) => id !== b[index])
  )
    throw new Error(`Fresh proposal ${label} set mismatch`)
}

function sameJson(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right)
}

/** Normalize a validated raw runner artifact; exported for fixture-level tests only. */
export function normalizeFreshProposalOutput(
  rawSummary: unknown,
  rawRunManifest: unknown,
  cases: readonly FreshCase[],
  manifests: readonly { sha256: string; cases: number }[],
  rawHashes: { summarySha256: string; runManifestSha256: string },
  acceptedManifestPins: readonly { sha256: string; cases: number }[] = freshProposalInputPins,
) {
  const summary = rawSummarySchema.parse(rawSummary)
  const run = runManifestSchema.parse(rawRunManifest)
  if (acceptedManifestPins.length !== 3 || manifests.length !== 3)
    throw new Error('Fresh proposal requires exactly three pinned source manifests')
  if (!sameJson(manifests, acceptedManifestPins) || !sameJson(run.manifests, acceptedManifestPins))
    throw new Error('Fresh proposal source manifest pins mismatch')
  if (summary.runId !== run.runId || summary.profileId !== run.profileId)
    throw new Error('Fresh proposal summary/run profile identity mismatch')
  if (summary.variantSha256 !== run.variantSha256)
    throw new Error('Fresh proposal variant digest mismatch')
  if (
    !/^[a-f0-9]{64}$/u.test(rawHashes.summarySha256) ||
    !/^[a-f0-9]{64}$/u.test(rawHashes.runManifestSha256)
  )
    throw new Error('Fresh proposal raw artifact commitments are malformed')

  const expectedIds = cases.map((item) => item.caseId)
  sameIds(expectedIds, run.plannedCaseIds, 'frozen planned case')
  sameIds(expectedIds, summary.plannedCaseIds, 'summary planned case')
  sameIds(
    summary.results.map((row) => row.caseId),
    summary.completedCaseIds,
    'completed case',
  )
  sameIds(expectedIds, [...summary.completedCaseIds, ...summary.missingCaseIds], 'coverage')
  if ((summary.status === 'complete') !== (summary.missingCaseIds.length === 0))
    throw new Error('Fresh proposal completion status contradicts missing cases')

  const planned = cases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    imageDimensions: { width: item.image.width, height: item.image.height },
  }))
  if (!sameJson(planned, run.plannedCases))
    throw new Error('Fresh proposal frozen source-image hashes or dimensions mismatch')
  const tasks = cases.map((item) => ({ caseId: item.caseId, task: freshProducerTask(item) }))
  if (!sameJson(tasks, run.taskManifest))
    throw new Error('Fresh proposal task manifest differs from the pinned producer inputs')

  const rowsById = new Map(summary.results.map((row) => [row.caseId, row]))
  for (const item of cases) {
    const row = rowsById.get(item.caseId)
    if (row) {
      if (row.imageSha256 !== item.image.sha256)
        throw new Error('Fresh proposal prediction/source image hash mismatch')
      if (
        row.extract.mask &&
        (row.extract.mask.sourceOffset.x + row.extract.mask.width > item.image.width ||
          row.extract.mask.sourceOffset.y + row.extract.mask.height > item.image.height)
      )
        throw new Error('Fresh proposal mask escaped the source raster')
      if (row.extract.status === 'extracted' && row.locate.status !== 'located')
        throw new Error('Fresh proposal extracted mask has no whole-object location')
    }
  }
  const stagePhysical = summary.results.reduce(
    (sum, row) => sum + row.classify.physicalCalls + row.locate.physicalCalls,
    0,
  )
  if (
    summary.aggregate.admittedPhysicalCalls !== summary.physicalReceipts.length ||
    stagePhysical !== summary.physicalReceipts.length ||
    summary.aggregate.inFlightCalls !== 0 ||
    new Set(summary.physicalReceipts.map((call) => call.physicalId)).size !==
      summary.physicalReceipts.length
  )
    throw new Error('Fresh proposal physical-call accounting does not close')
  const stageRequestHashes = summary.results.flatMap((row) => [
    ...row.classify.requestHashes,
    ...row.locate.requestHashes,
  ])
  const receiptRequestHashes = summary.physicalReceipts.map((call) => call.requestSha256)
  if (!sameJson([...stageRequestHashes].sort(), [...receiptRequestHashes].sort()))
    throw new Error('Fresh proposal stage request hashes differ from physical receipts')

  const normalized = {
    runId: run.runId,
    status: summary.status,
    completedCaseIds: summary.completedCaseIds,
    missingCaseIds: summary.missingCaseIds,
    results: summary.results.map((row) => ({
      caseId: row.caseId,
      imageSha256: row.imageSha256,
      profileId: run.profileId,
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
    })),
    proposalExtractions: summary.results.map((row) => ({
      caseId: row.caseId,
      status: row.extract.status,
      durationMs: row.extract.durationMs,
      ...(row.extract.reason ? { reason: row.extract.reason } : {}),
      ...(row.extract.errorCode ? { errorCode: row.extract.errorCode } : {}),
      ...(row.extract.nativeProposal ? { nativeProposal: row.extract.nativeProposal } : {}),
      ...(row.extract.segmentation ? { segmentation: row.extract.segmentation } : {}),
      ...(row.extract.mask ? { mask: row.extract.mask } : {}),
    })),
    rawProposalProvenance: {
      normalization: 'fresh-proposal-summary-adapter-v1',
      rawSummarySha256: rawHashes.summarySha256,
      rawRunManifestSha256: rawHashes.runManifestSha256,
      profileId: run.profileId,
      variantSha256: run.variantSha256,
      producerSourceSha256: run.producerSourceSha256,
      sourceHashes: run.sourceHashes,
      manifests: run.manifests,
      physicalReceiptCount: summary.physicalReceipts.length,
      physicalCalls: stagePhysical,
      logicalCalls: summary.results.reduce(
        (sum, row) => sum + row.classify.logicalCalls + row.locate.logicalCalls,
        0,
      ),
      budget: summary.aggregate,
    },
  }
  return normalized
}

function writeExclusive(path: string, bytes: string): Promise<void> {
  return writeFile(path, bytes, { flag: 'wx' })
}

async function scoreProposalMasks(
  rawSummary: z.infer<typeof rawSummarySchema>,
  corpus: readonly FreshCase[],
  truthFiles: readonly z.infer<typeof pinnedFileSchema>[],
  runDirectory: string,
  signal: AbortSignal,
) {
  const truthById = new Map<string, z.infer<typeof maskTruthRowSchema>>()
  const repoRoot = resolve(dirname(truthFiles[0]!.path), '../../../..')
  for (const file of truthFiles) {
    const { value } = await readPinnedJson(file, signal)
    for (const row of z.array(maskTruthRowSchema).parse(value)) {
      if (truthById.has(row.caseId)) throw new Error('Duplicate mask-truth case ID')
      truthById.set(row.caseId, row)
    }
  }
  const resultById = new Map(rawSummary.results.map((row) => [row.caseId, row]))
  const rows = [] as Array<{
    caseId: string
    status: 'scored' | 'missing-prediction' | 'not-extracted' | 'no-reference-mask'
    referenceInstances: number
    bestInstanceIoU?: number
    meetsThreshold?: boolean
  }>
  for (const item of corpus) {
    assertActive(signal)
    const truth = truthById.get(item.caseId)
    const references = truth?.referenceMasks ?? []
    if (references.length === 0) {
      rows.push({ caseId: item.caseId, status: 'no-reference-mask', referenceInstances: 0 })
      continue
    }
    const result = resultById.get(item.caseId)
    if (!result) {
      rows.push({
        caseId: item.caseId,
        status: 'missing-prediction',
        referenceInstances: references.length,
      })
      continue
    }
    if (result.extract.status !== 'extracted' || !result.extract.mask) {
      rows.push({
        caseId: item.caseId,
        status: 'not-extracted',
        referenceInstances: references.length,
      })
      continue
    }
    const mask = result.extract.mask
    const safeCaseId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item.caseId)
    if (!safeCaseId) throw new Error('Unsafe proposal case ID in artifact path')
    const artifactPath = resolve(runDirectory, item.caseId, mask.file)
    if (!artifactPath.startsWith(`${resolve(runDirectory)}/`))
      throw new Error('Proposal mask artifact escaped the raw run directory')
    const predicted = await readBoundedCorpusFile(artifactPath, 2_000_000, signal)
    try {
      if (predicted.length !== mask.width * mask.height || sha256(predicted) !== mask.sha256)
        throw new Error('Proposal mask byte length or digest mismatch')
      if (predicted.some((value) => value !== 0 && value !== 1))
        throw new Error('Proposal mask is not binary 0/1')
      const pngPath = resolve(runDirectory, item.caseId, mask.pngFile)
      const cutout = await readBoundedCorpusFile(pngPath, 8 * 1024 * 1024, signal)
      try {
        if (sha256(cutout) !== mask.pngSha256)
          throw new Error('Proposal cutout PNG digest mismatch')
        const pngInfo = await sharp(cutout, { limitInputPixels: 2_000_000 }).metadata()
        if (
          pngInfo.format !== 'png' ||
          pngInfo.width !== mask.width ||
          pngInfo.height !== mask.height
        )
          throw new Error('Proposal cutout PNG geometry mismatch')
      } finally {
        cutout.fill(0)
      }

      let best = 0
      for (const descriptor of references) {
        if (descriptor.width !== item.image.width || descriptor.height !== item.image.height)
          throw new Error('Reference mask geometry differs from frozen source image')
        const truthPath = isAbsolute(descriptor.path)
          ? resolve(descriptor.path)
          : resolve(repoRoot, descriptor.path)
        if (!isAbsolute(descriptor.path) && !truthPath.startsWith(`${repoRoot}/`))
          throw new Error('Reference mask path escaped repository')
        const truthBytes = await readBoundedCorpusFile(truthPath, descriptor.bytes, signal)
        try {
          if (truthBytes.length !== descriptor.bytes || sha256(truthBytes) !== descriptor.sha256)
            throw new Error('Reference mask byte length or digest mismatch')
          const decoded = await sharp(truthBytes, { limitInputPixels: 2_000_000 })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true })
          if (
            decoded.info.width !== descriptor.width ||
            decoded.info.height !== descriptor.height ||
            decoded.info.channels !== 1
          )
            throw new Error('Decoded reference mask geometry mismatch')
          if (decoded.data.some((value) => value !== 0 && value !== 255))
            throw new Error('Reference mask is not binary 0/255')
          let intersection = 0
          let union = 0
          for (let y = 0; y < item.image.height; y++) {
            assertActive(signal)
            const py = y - mask.sourceOffset.y
            for (let x = 0; x < item.image.width; x++) {
              const target = decoded.data[y * item.image.width + x] !== 0
              const px = x - mask.sourceOffset.x
              const predictedOn =
                px >= 0 &&
                py >= 0 &&
                px < mask.width &&
                py < mask.height &&
                predicted[py * mask.width + px] === 1
              if (target || predictedOn) union++
              if (target && predictedOn) intersection++
            }
          }
          const iou = union === 0 ? 0 : intersection / union
          if (iou > best) best = iou
        } finally {
          truthBytes.fill(0)
        }
      }
      rows.push({
        caseId: item.caseId,
        status: 'scored',
        referenceInstances: references.length,
        bestInstanceIoU: best,
        meetsThreshold: best >= 0.8,
      })
    } finally {
      predicted.fill(0)
    }
  }
  const scored = rows.filter((row) => row.status === 'scored')
  return {
    threshold: 0.8,
    truthCases: rows.filter((row) => row.referenceInstances > 0).length,
    scoredCases: scored.length,
    unavailableCases: rows.length - scored.length,
    passedCases: scored.filter((row) => row.meetsThreshold).length,
    meanBestInstanceIoU: scored.length
      ? scored.reduce((sum, row) => sum + row.bestInstanceIoU!, 0) / scored.length
      : null,
    matching:
      'maximum IoU over independently supplied Open Images instance masks; not bbox correctness',
    rows,
  }
}

/** Evaluator-only adapter. It validates raw proposal artifacts before delegating to evaluateFreshRun. */
export async function evaluateFreshProposalRun(
  input: z.input<typeof optionsSchema>,
  signal: AbortSignal,
) {
  assertActive(signal)
  const options = optionsSchema.parse(input)
  const paths = [
    options.rawSummary.path,
    options.runManifest.path,
    ...options.corpus.manifests.map((file) => file.path),
    ...options.truths.map((file) => file.path),
    options.derivedSummary,
    options.output,
    options.provenanceOutput,
  ].map((path) => resolve(path))
  if (new Set(paths).size !== paths.length)
    throw new Error('Fresh proposal artifact paths must be distinct')
  const [rawSummary, rawRunManifest] = await Promise.all([
    readPinnedJson(options.rawSummary, signal),
    readPinnedJson(options.runManifest, signal),
  ])
  const corpus = await loadFreshCorpus(options.corpus, signal)
  if (!sameJson(corpus.manifests, freshProposalInputPins))
    throw new Error('Fresh proposal evaluator was given non-active DEV source pins')
  const derived = normalizeFreshProposalOutput(
    rawSummary.value,
    rawRunManifest.value,
    corpus.cases,
    corpus.manifests,
    { summarySha256: rawSummary.sha256, runManifestSha256: rawRunManifest.sha256 },
  )
  const rawSummaryValue = rawSummarySchema.parse(rawSummary.value)
  const proposalMaskMetrics = await scoreProposalMasks(
    rawSummaryValue,
    corpus.cases,
    options.truths,
    dirname(resolve(options.rawSummary.path)),
    signal,
  )
  const derivedBytes = `${JSON.stringify(derived, null, 2)}\n`
  const derivedSha256 = sha256(Buffer.from(derivedBytes))
  await writeExclusive(options.derivedSummary, derivedBytes)
  assertActive(signal)
  const evaluatorOutput = `${options.output}.evaluator-${randomUUID()}.tmp`
  let evaluated: Awaited<ReturnType<typeof evaluateFreshRun>>
  try {
    evaluated = await evaluateFreshRun(
      {
        summary: { path: options.derivedSummary, sha256: derivedSha256 },
        runManifest: options.runManifest,
        corpus: options.corpus,
        truths: options.truths,
        output: evaluatorOutput,
      },
      signal,
    )
  } finally {
    await unlink(evaluatorOutput).catch(() => undefined)
  }
  const finalEvaluation = {
    ...evaluated,
    proposalExtractions: derived.proposalExtractions,
    proposalMaskMetrics,
  }
  const evaluatorBytes = `${JSON.stringify(finalEvaluation, null, 2)}\n`
  assertActive(signal)
  await writeExclusive(options.output, evaluatorBytes)
  const provenance = {
    schemaVersion: 1,
    normalization: 'fresh-proposal-summary-adapter-v1',
    runId: evaluated.runId,
    profileId: evaluated.profileId,
    rawSummarySha256: rawSummary.sha256,
    runManifestSha256: rawRunManifest.sha256,
    derivedSummarySha256: derivedSha256,
    evaluationOutputSha256: sha256(Buffer.from(evaluatorBytes)),
    truthSha256: options.truths.map((file) => file.sha256),
    producerInputs: corpus.manifests,
    producerSourceSha256: derived.rawProposalProvenance.producerSourceSha256,
    variantSha256: derived.rawProposalProvenance.variantSha256,
    physicalCalls: derived.rawProposalProvenance.physicalCalls,
    logicalCalls: derived.rawProposalProvenance.logicalCalls,
  }
  await writeExclusive(options.provenanceOutput, `${JSON.stringify(provenance, null, 2)}\n`)
  return { ...finalEvaluation, provenance }
}
