import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { assertActive } from '../../src/entities/errors.js'
import { loadFreshCorpus, readBoundedCorpusFile } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { pairedBootstrap, wholeObjectMetrics } from './metrics.js'
import type { Box, LocalizationCase } from './metrics.js'
import { hashCanonical } from './protocol.js'

const sha = z.string().regex(/^[a-f0-9]{64}$/u)
const pinned = z.object({ path: z.string().min(1), sha256: sha }).strict()
const box = z
  .object({
    left: z.number().finite().nonnegative(),
    top: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()
const xyxy = z
  .tuple([
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
    z.number().finite().min(0).max(1),
  ])
  .refine(([l, t, r, b]) => l < r && t < b)
const referenceMask = z
  .object({
    path: z.string().min(1).max(512),
    sha256: sha,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
  })
  .passthrough()
  .refine((value) => value.width * value.height <= 2_097_152)
const truthRow = z
  .object({
    caseId: z.string().min(1).max(128),
    expectedPresence: z.enum(['present', 'absent']),
    targetBoxes: z.array(z.object({ xyxy }).passthrough()).max(10_000),
    negativeEvidence: z.union([z.record(z.unknown()), z.string().min(1).max(4000)]).nullable(),
    referenceMasks: z.array(referenceMask).max(100).optional(),
  })
  .passthrough()
  .superRefine((row, context) => {
    if (
      row.expectedPresence === 'present'
        ? row.targetBoxes.length === 0
        : row.targetBoxes.length !== 0 ||
          row.negativeEvidence === null ||
          (typeof row.negativeEvidence === 'string' && row.negativeEvidence.trim().length === 0) ||
          (typeof row.negativeEvidence === 'object' &&
            row.negativeEvidence !== null &&
            Object.keys(row.negativeEvidence).length === 0)
    )
      context.addIssue({ code: 'custom', message: 'Truth evidence is incomplete' })
  })
const truthFile = z.array(truthRow).min(1).max(80)
const regionStage = z
  .object({
    status: z.enum(['located', 'unknown', 'not-found', 'failed', 'not-reached']),
    region: box.optional(),
    sourceWidth: z.number().int().positive().optional(),
    sourceHeight: z.number().int().positive().optional(),
    prompt: z.literal('seed-region').optional(),
    searchLimit: box.optional(),
    durationMs: z.number().finite().nonnegative(),
    physicalCalls: z.number().int().nonnegative(),
    logicalCalls: z.number().int().nonnegative(),
    requestHashes: z.array(sha).max(12),
    errorCode: z.string().max(100).optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if ((row.status === 'located') !== (row.region !== undefined))
      context.addIssue({ code: 'custom', message: 'Seed status and region disagree' })
  })
const segmentation = z
  .object({
    method: z.string().min(1).max(100),
    backend: z.string().min(1).max(100),
    durationMs: z.number().finite().nonnegative(),
    input: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    qualityScore: z.number().finite().optional(),
  })
  .strict()
const maskDescriptor = z
  .object({
    file: z.literal('mask.u8'),
    sha256: sha,
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    sourceRegion: box,
    sourceOffset: z
      .object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() })
      .strict(),
    pngFile: z.literal('cutout.png'),
    pngSha256: sha,
    center: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    segmentation,
  })
  .strict()
const extraction = z
  .object({
    status: z.enum(['extracted', 'region-only', 'unknown', 'not-found', 'failed']),
    reason: z.string().max(100).optional(),
    errorCode: z.string().max(100).optional(),
    durationMs: z.number().finite().nonnegative(),
    physicalCalls: z.number().int().nonnegative(),
    logicalCalls: z.number().int().nonnegative(),
    requestHashes: z.array(sha).max(12),
    seed: regionStage,
    mask: maskDescriptor.optional(),
    segmentation: segmentation.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if ((row.status === 'extracted') !== (row.mask !== undefined))
      context.addIssue({ code: 'custom', message: 'Extraction status and mask disagree' })
    if (row.status === 'region-only' && row.seed.status !== 'located')
      context.addIssue({ code: 'custom', message: 'Region-only result has no seed' })
  })
const classification = z
  .object({
    status: z.enum(['ok', 'failed']),
    value: z.enum(['present', 'absent']).optional(),
    durationMs: z.number().finite().nonnegative(),
    physicalCalls: z.number().int().nonnegative(),
    logicalCalls: z.number().int().nonnegative(),
    requestHashes: z.array(sha).max(12),
    errorCode: z.string().max(100).optional(),
  })
  .strict()
  .refine((row) => (row.status === 'ok') === (row.value !== undefined))
const caseResult = z
  .object({
    caseId: z.string().min(1).max(128),
    imageSha256: sha,
    classify: classification,
    extraction,
  })
  .strict()
const routeSchema = z
  .object({
    model: z.string().min(1),
    provider: z.string().min(1),
    providerName: z.string().min(1),
    apiEndpoint: z.string().min(1),
    allowFallbacks: z.literal(false),
  })
  .strict()
const policySchema = routeSchema.extend({
  timeoutMs: z.literal(120_000),
  maxInFlightCases: z.literal(2),
  nativeMaxActive: z.literal(1),
  nativeMaxWaiting: z.literal(2),
  nativeThreads: z.literal(2),
  native: z.string().min(1),
  regionSearchPasses: z.literal(3),
  extentCalls: z.literal(0),
  sameInstanceCalls: z.literal(0),
  maxLogicalCallsPerCase: z.literal(4),
  maxPhysicalCallsPerCase: z.literal(4),
  maxPhysicalCalls: z.number().int().positive().max(600),
  maxCostUsd: z.number().positive().max(10),
  unknownCostReserveUsd: z.number().positive(),
  retries: z.literal(0),
  fallback: z.literal(false),
  latencyRankingEligible: z.literal(false),
  /** V2 reuses the recipe but skips all localization work after a non-present class result. */
  requireClassifiedPresence: z.literal(true).optional(),
})
const budget = z
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
const receipt = z
  .object({
    caseId: z.string().min(1),
    physicalId: z.number().int().positive(),
    logicalId: z.number().int().positive(),
    requestSha256: sha,
    requestBodySha256: sha,
    admittedAt: z.string().min(1),
    durationMs: z.number().finite().nonnegative(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    route: routeSchema,
    receipt: z
      .object({ costUsd: z.number().finite().nonnegative().nullable() })
      .passthrough()
      .nullable(),
    wireReceipt: z
      .object({ usageCostUsd: z.number().finite().nonnegative().nullable() })
      .passthrough()
      .nullable(),
    errorCode: z.string().max(100).nullable(),
  })
  .strict()
const summarySchema = z
  .object({
    runId: z.string().min(1),
    profileId: z.string().min(1),
    phase: z.enum(['dev', 'heldout']),
    status: z.enum(['complete', 'incomplete']),
    producerSourceSha256: sha,
    sourceBeforeSha256: sha,
    sourceAfterSha256: sha,
    sourceUnchanged: z.boolean(),
    plannedCaseIds: z.array(z.string().min(1)).min(1).max(80),
    completedCaseIds: z.array(z.string().min(1)).max(80),
    missingCaseIds: z.array(z.string().min(1)).max(80),
    results: z.array(caseResult).max(80),
    aggregate: budget,
    shutdownError: z.string().nullable(),
    physicalReceipts: z.array(receipt).max(600),
    imageFetchAudit: z
      .object({
        checkedFetches: z.number().int().nonnegative(),
        imagePartFetches: z.number().int().nonnegative(),
        allRequestsVerifiedImageFree: z.boolean(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
const manifestSchema = z
  .object({
    runId: z.string().min(1),
    profileId: z.string().min(1),
    phase: z.enum(['dev', 'heldout']),
    purpose: z.string().min(1),
    producerSourceSha256: sha,
    producerSourceFiles: z.record(z.string().min(1), sha),
    manifests: z
      .array(z.object({ sha256: sha, cases: z.number().int().positive() }).strict())
      .length(3),
    plannedCaseIds: z.array(z.string().min(1)).min(1).max(80),
    imageChecks: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            status: z.enum(['verified', 'failed']),
            errorCode: z.string().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(80),
    variantSha256: sha,
    route: routeSchema,
    variant: z.enum(['region-seeded-sam', 'no-image-control']),
    policy: policySchema,
    budget: z
      .object({
        maxPhysicalCalls: z.number().int().positive(),
        maxCostUsd: z.number().positive(),
        unknownCostReserveUsd: z.number().positive(),
      })
      .strict(),
  })
  .passthrough()
const completion = z
  .object({
    runId: z.string().min(1),
    status: z.enum(['complete', 'incomplete']),
    summarySha256: sha,
    sourceBeforeSha256: sha,
    sourceAfterSha256: sha,
    sourceUnchanged: z.boolean(),
  })
  .strict()
const optionsSchema = z
  .object({
    phase: z.enum(['dev', 'heldout']),
    variant: z.enum(['region-seeded-sam', 'no-image-control']),
    profileId: z.string().min(1),
    purpose: z.string().min(1),
    expectedProducerSourceSha256: sha,
    expectedVariantSha256: sha,
    expectedRoute: routeSchema,
    expectedPolicy: policySchema,
    expectedTargetPolicy: z.literal('target-plus-neutral-instruction-v1'),
    summary: pinned,
    runManifest: pinned,
    completionSeal: pinned,
    corpus: z
      .object({ manifests: z.array(pinned).length(3), imageRoot: z.string().min(1) })
      .strict(),
    truths: z.array(pinned).length(3),
    referenceRoot: z.string().min(1),
    runDirectory: z.string().min(1),
    output: z.string().min(1),
  })
  .strict()

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function same(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right)
}
function sameIds(expected: readonly string[], actual: readonly string[], what: string): void {
  if (
    expected.length !== actual.length ||
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    !same([...expected].toSorted(), [...actual].toSorted())
  )
    throw new Error(`Region-seeded ${what} IDs mismatch`)
}
async function readPinned(file: z.infer<typeof pinned>, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBoundedCorpusFile(file.path, 16 * 1024 * 1024, signal)
  try {
    if (digest(bytes) !== file.sha256) throw new Error('Pinned evaluator artifact digest mismatch')
    return JSON.parse(bytes.toString('utf8')) as unknown
  } finally {
    bytes.fill(0)
  }
}
function targetBoxes(row: z.infer<typeof truthRow>, source: FreshCase): Box[] {
  return row.targetBoxes.map(({ xyxy: [left, top, right, bottom] }) => ({
    left: left * source.image.width,
    top: top * source.image.height,
    width: (right - left) * source.image.width,
    height: (bottom - top) * source.image.height,
  }))
}
function overlaps(a: Box, b: Box): boolean {
  return (
    Math.min(a.left + a.width, b.left + b.width) > Math.max(a.left, b.left) &&
    Math.min(a.top + a.height, b.top + b.height) > Math.max(a.top, b.top)
  )
}
function safeWithin(root: string, path: string, label: string): string {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  const rel = relative(resolvedRoot, resolvedPath)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`${label} escaped its pinned root`)
  return resolvedPath
}
async function actualPath(root: string, path: string, label: string): Promise<string> {
  const rootPath = await realpath(root)
  const pathPath = await realpath(path)
  return safeWithin(rootPath, pathPath, label)
}
function validateMaskBounds(mask: z.infer<typeof maskDescriptor>, source: FreshCase): void {
  if (
    mask.width !== mask.sourceRegion.width ||
    mask.height !== mask.sourceRegion.height ||
    !Number.isInteger(mask.sourceRegion.left) ||
    !Number.isInteger(mask.sourceRegion.top) ||
    mask.sourceOffset.x !== mask.sourceRegion.left ||
    mask.sourceOffset.y !== mask.sourceRegion.top ||
    mask.sourceRegion.left + mask.width > source.image.width ||
    mask.sourceRegion.top + mask.height > source.image.height ||
    mask.segmentation.input.width !== source.image.width ||
    mask.segmentation.input.height !== source.image.height ||
    !Number.isFinite(mask.center.x) ||
    !Number.isFinite(mask.center.y) ||
    mask.center.x < mask.sourceRegion.left ||
    mask.center.y < mask.sourceRegion.top ||
    mask.center.x >= mask.sourceRegion.left + mask.width ||
    mask.center.y >= mask.sourceRegion.top + mask.height
  )
    throw new Error('Predicted mask bounds, offset, center or source canvas mismatch')
}

export function measureSeedRegion(
  seed: z.infer<typeof regionStage>,
  expected: 'present' | 'absent',
  boxes: readonly Box[],
  width: number,
  height: number,
):
  | { located: false; boxOverlap: false }
  | {
      located: true
      boxOverlap: boolean
      centerInsideReferenceBox: boolean
      positiveBoxIntersection: boolean
      seedRegion: Box
    } {
  if (seed.status !== 'located' || !seed.region) return { located: false, boxOverlap: false }
  if (
    seed.region.left + seed.region.width > width ||
    seed.region.top + seed.region.height > height ||
    seed.sourceWidth !== width ||
    seed.sourceHeight !== height
  )
    throw new Error('Seed region escaped or disagreed with source canvas')
  const boxOverlap = boxes.some((target) => overlaps(seed.region!, target))
  const center = {
    x: seed.region.left + seed.region.width / 2,
    y: seed.region.top + seed.region.height / 2,
  }
  const centerInsideReferenceBox = boxes.some(
    (target) =>
      center.x >= target.left &&
      center.x <= target.left + target.width &&
      center.y >= target.top &&
      center.y <= target.top + target.height,
  )
  return {
    located: true,
    boxOverlap,
    centerInsideReferenceBox,
    positiveBoxIntersection: expected === 'present' ? boxOverlap : false,
    /** This is a seed-cell proxy only; it is never whole-object localization. */
    seedRegion: seed.region,
  }
}

async function scoreReferenceMasks(args: {
  source: FreshCase
  refs: readonly z.infer<typeof referenceMask>[]
  predicted?: { bytes: Uint8Array; width: number; height: number; offset: { x: number; y: number } }
  seed?: Box
  referenceRoot: string
  signal: AbortSignal
}) {
  const { source, refs, predicted, seed, referenceRoot, signal } = args
  const scored: Array<{ sha256: string; status: string; iou?: number; passed?: boolean }> = []
  let totalSeedForegroundPixels = 0
  for (const descriptor of refs) {
    assertActive(signal)
    if (descriptor.width !== source.image.width || descriptor.height !== source.image.height) {
      scored.push({ sha256: descriptor.sha256, status: 'unavailable-wrong-reference-canvas' })
      continue
    }
    const joined = isAbsolute(descriptor.path)
      ? resolve(descriptor.path)
      : resolve(referenceRoot, descriptor.path)
    const path = await actualPath(referenceRoot, joined, 'Reference mask')
    const bytes = await readBoundedCorpusFile(path, descriptor.bytes, signal)
    try {
      if (bytes.length !== descriptor.bytes || digest(bytes) !== descriptor.sha256)
        throw new Error('Reference mask size or digest mismatch')
      const decoded = await sharp(bytes, { limitInputPixels: 2_097_152, failOn: 'error' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      try {
        if (
          decoded.info.width !== descriptor.width ||
          decoded.info.height !== descriptor.height ||
          decoded.info.channels !== 1
        ) {
          scored.push({ sha256: descriptor.sha256, status: 'unavailable-wrong-decoded-canvas' })
          continue
        }
        if (decoded.data.some((pixel) => pixel !== 0 && pixel !== 255))
          throw new Error('Reference mask is not binary')
        let seedForegroundPixels = 0
        if (seed) {
          const left = Math.max(0, Math.floor(seed.left))
          const top = Math.max(0, Math.floor(seed.top))
          const right = Math.min(source.image.width, Math.ceil(seed.left + seed.width))
          const bottom = Math.min(source.image.height, Math.ceil(seed.top + seed.height))
          for (let y = top; y < bottom; y++)
            for (let x = left; x < right; x++)
              if (decoded.data[y * source.image.width + x] === 255) seedForegroundPixels++
          totalSeedForegroundPixels += seedForegroundPixels
        }
        if (predicted) {
          if (predicted.width !== predicted.bytes.length / predicted.height)
            throw new Error('Predicted mask byte geometry mismatch')
          let intersection = 0
          let union = 0
          for (let y = 0; y < source.image.height; y++) {
            assertActive(signal)
            for (let x = 0; x < source.image.width; x++) {
              const refOn = decoded.data[y * source.image.width + x] === 255
              const px = x - predicted.offset.x
              const py = y - predicted.offset.y
              const predOn =
                px >= 0 &&
                py >= 0 &&
                px < predicted.width &&
                py < predicted.height &&
                predicted.bytes[py * predicted.width + px] === 1
              if (refOn || predOn) union++
              if (refOn && predOn) intersection++
            }
          }
          const iou = union === 0 ? 0 : intersection / union
          scored.push({
            sha256: descriptor.sha256,
            status: 'scored',
            iou,
            passed: iou >= 0.8,
            ...(seed ? { seedForegroundPixels } : {}),
          })
        } else {
          scored.push({
            sha256: descriptor.sha256,
            status: 'unavailable-no-predicted-mask',
            ...(seed ? { seedForegroundPixels } : {}),
          })
        }
      } finally {
        decoded.data.fill(0)
      }
    } finally {
      bytes.fill(0)
    }
  }
  return { scores: scored, seedForegroundPixels: totalSeedForegroundPixels }
}

/** Strict evaluator. The caller supplies every freeze pin; this module selects no recipe. */
export async function evaluateRegionSeededRun(
  input: z.input<typeof optionsSchema>,
  signal: AbortSignal,
) {
  assertActive(signal)
  const options = optionsSchema.parse(input)
  const [rawManifest, rawSummary, rawSeal, corpus] = await Promise.all([
    readPinned(options.runManifest, signal),
    readPinned(options.summary, signal),
    readPinned(options.completionSeal, signal),
    loadFreshCorpus(options.corpus, signal),
  ])
  const run = manifestSchema.parse(rawManifest)
  const summary = summarySchema.parse(rawSummary)
  const seal = completion.parse(rawSeal)
  const expectedCount = options.phase === 'dev' ? 40 : 80
  const expectedGroups = options.phase === 'dev' ? [20, 10, 10] : [40, 20, 20]
  const expectedIds = corpus.cases.map((item) => item.caseId)
  if (expectedIds.length !== expectedCount)
    throw new Error('Unexpected region-seeded case denominator')
  sameIds(expectedIds, run.plannedCaseIds, 'manifest planned')
  sameIds(
    expectedIds,
    run.imageChecks.map((row) => row.caseId),
    'manifest image check',
  )
  if (run.imageChecks.some((row) => row.status !== 'verified' || row.errorCode !== null))
    throw new Error('Producer image preflight contains a failed source image')
  sameIds(expectedIds, summary.plannedCaseIds, 'summary planned')
  sameIds(expectedIds, summary.completedCaseIds, 'summary completed')
  if (summary.missingCaseIds.length !== 0 || summary.status !== 'complete')
    throw new Error('A sealed evaluator requires all planned case records; failures stay in rows')
  sameIds(
    expectedIds,
    summary.results.map((row) => row.caseId),
    'result',
  )
  const sealChecks = {
    runId: run.runId === summary.runId && run.runId === seal.runId,
    profile: run.profileId === options.profileId && summary.profileId === options.profileId,
    phase: run.phase === options.phase && summary.phase === options.phase,
    variant: run.variant === options.variant && run.purpose === options.purpose,
    producer:
      run.producerSourceSha256 === options.expectedProducerSourceSha256 &&
      summary.producerSourceSha256 === options.expectedProducerSourceSha256,
    variantSha: run.variantSha256 === options.expectedVariantSha256,
    source:
      summary.sourceBeforeSha256 === options.expectedProducerSourceSha256 &&
      summary.sourceAfterSha256 === options.expectedProducerSourceSha256 &&
      summary.sourceUnchanged === true &&
      seal.sourceBeforeSha256 === options.expectedProducerSourceSha256 &&
      seal.sourceAfterSha256 === options.expectedProducerSourceSha256 &&
      seal.sourceUnchanged === true,
    sealStatus: seal.status === 'complete',
    shutdown: summary.shutdownError === null,
    summaryDigest: digest(JSON.stringify(rawSummary)) === seal.summarySha256,
  }
  if (
    run.runId !== summary.runId ||
    run.runId !== seal.runId ||
    run.profileId !== options.profileId ||
    summary.profileId !== options.profileId ||
    run.phase !== options.phase ||
    summary.phase !== options.phase ||
    run.variant !== options.variant ||
    run.purpose !== options.purpose ||
    run.producerSourceSha256 !== options.expectedProducerSourceSha256 ||
    run.variantSha256 !== options.expectedVariantSha256 ||
    summary.producerSourceSha256 !== options.expectedProducerSourceSha256 ||
    summary.sourceBeforeSha256 !== options.expectedProducerSourceSha256 ||
    summary.sourceAfterSha256 !== options.expectedProducerSourceSha256 ||
    summary.sourceUnchanged !== true ||
    seal.sourceBeforeSha256 !== options.expectedProducerSourceSha256 ||
    seal.sourceAfterSha256 !== options.expectedProducerSourceSha256 ||
    seal.sourceUnchanged !== true ||
    seal.status !== 'complete' ||
    summary.shutdownError !== null ||
    digest(JSON.stringify(rawSummary)) !== seal.summarySha256
  )
    throw new Error(
      `Region-seeded run identity/source/completion seal mismatch: ${Object.entries(sealChecks)
        .filter(([, valid]) => !valid)
        .map(([name]) => name)
        .join(',')}`,
    )
  if (
    hashCanonical(
      Object.entries(run.producerSourceFiles).sort(([a], [b]) => a.localeCompare(b)),
    ) !== options.expectedProducerSourceSha256
  )
    throw new Error('Producer source file map does not match its frozen closure hash')
  if (!same(run.route, options.expectedRoute) || !same(run.policy, options.expectedPolicy))
    throw new Error('Region-seeded route or policy differs from caller-pinned freeze')
  if (
    options.variant === 'no-image-control' &&
    (summary.imageFetchAudit?.allRequestsVerifiedImageFree !== true ||
      summary.imageFetchAudit.imagePartFetches !== 0 ||
      summary.imageFetchAudit.checkedFetches !== summary.aggregate.admittedPhysicalCalls)
  )
    throw new Error('No-image control fetch audit did not close')
  if (
    run.targetPolicy !== options.expectedTargetPolicy ||
    run.policy.maxPhysicalCalls !== (options.phase === 'dev' ? 250 : 600) ||
    run.policy.maxCostUsd !== (options.phase === 'dev' ? 5 : 10) ||
    run.policy.unknownCostReserveUsd !== 0.05
  )
    throw new Error('Region-seeded target or phase budget policy mismatch')
  if (
    run.budget.maxPhysicalCalls !== options.expectedPolicy.maxPhysicalCalls ||
    run.budget.maxCostUsd !== options.expectedPolicy.maxCostUsd ||
    run.budget.unknownCostReserveUsd !== options.expectedPolicy.unknownCostReserveUsd
  )
    throw new Error('Region-seeded budget differs from caller-pinned policy')
  if (
    corpus.manifests.length !== 3 ||
    corpus.manifests.some(
      (manifest, index) =>
        manifest.sha256 !== run.manifests[index]?.sha256 ||
        manifest.cases !== run.manifests[index]?.cases ||
        manifest.cases !== expectedGroups[index],
    )
  )
    throw new Error('Region-seeded producer manifest pins differ')
  for (const file of options.corpus.manifests) {
    if (!run.manifests.some((manifest) => manifest.sha256 === file.sha256))
      throw new Error('Input manifest caller pin mismatch')
  }
  const truths: z.infer<typeof truthRow>[] = []
  for (const file of options.truths) truths.push(...truthFile.parse(await readPinned(file, signal)))
  sameIds(
    expectedIds,
    truths.map((row) => row.caseId),
    'truth',
  )
  let groupOffset = 0
  for (const [groupIndex, groupSize] of expectedGroups.entries()) {
    const groupIds = new Set(expectedIds.slice(groupOffset, groupOffset + groupSize))
    const groupTruths = truths.filter((row) => groupIds.has(row.caseId))
    const expectedPositiveCounts = options.phase === 'dev' ? [16, 7, 7] : [30, 15, 15]
    const expectedPositives = expectedPositiveCounts[groupIndex]
    if (
      expectedPositives === undefined ||
      groupTruths.length !== groupSize ||
      groupTruths.filter((row) => row.expectedPresence === 'present').length !==
        expectedPositives ||
      groupTruths.filter((row) => row.expectedPresence === 'absent').length !==
        groupSize - expectedPositives
    )
      throw new Error('Region-seeded frozen stratum truth counts mismatch')
    groupOffset += groupSize
  }
  const truthById = new Map(truths.map((row) => [row.caseId, row]))
  const resultById = new Map(summary.results.map((row) => [row.caseId, row]))
  const receiptIds = new Set<number>()
  const receiptCounts = new Map<
    string,
    {
      physical: number
      logicalIds: Set<number>
      logicalRequests: Map<number, string>
      costKnown: number
      costUnknown: number
      hashes: string[]
    }
  >()
  let knownCost = 0
  let unknownCostCalls = 0
  for (const call of summary.physicalReceipts) {
    if (receiptIds.has(call.physicalId)) throw new Error('Duplicate physical receipt ID')
    receiptIds.add(call.physicalId)
    if (!expectedIds.includes(call.caseId) || !same(call.route, run.route))
      throw new Error('Receipt case/route mismatch')
    const parsed = call.receipt?.costUsd ?? null
    const wire = call.wireReceipt?.usageCostUsd ?? null
    if (parsed !== null && wire !== null && Math.abs(parsed - wire) > 1e-9)
      throw new Error('Parsed and wire costs disagree')
    const cost = parsed ?? wire
    const row = receiptCounts.get(call.caseId) ?? {
      physical: 0,
      logicalIds: new Set<number>(),
      logicalRequests: new Map<number, string>(),
      costKnown: 0,
      costUnknown: 0,
      hashes: [],
    }
    row.physical++
    if (row.logicalRequests.has(call.logicalId))
      throw new Error('More than one physical fetch was attributed to a logical request')
    row.logicalIds.add(call.logicalId)
    row.logicalRequests.set(call.logicalId, call.requestSha256)
    row.hashes.push(call.requestSha256)
    if (cost === null) {
      unknownCostCalls++
      row.costUnknown++
    } else {
      knownCost += cost
      row.costKnown += cost
    }
    receiptCounts.set(call.caseId, row)
  }
  if (
    summary.aggregate.admittedPhysicalCalls !== summary.physicalReceipts.length ||
    summary.aggregate.inFlightCalls !== 0 ||
    summary.aggregate.admittedPhysicalCalls > options.expectedPolicy.maxPhysicalCalls ||
    summary.aggregate.maxPhysicalCalls !== options.expectedPolicy.maxPhysicalCalls ||
    summary.aggregate.maxCostUsd !== options.expectedPolicy.maxCostUsd ||
    Math.abs(summary.aggregate.knownCostUsd - knownCost) > Math.max(1, knownCost) * 1e-9 ||
    summary.aggregate.unknownCostCalls !== unknownCostCalls ||
    Math.abs(
      summary.aggregate.accountedExposureUsd -
        (knownCost + unknownCostCalls * options.expectedPolicy.unknownCostReserveUsd),
    ) > 1e-9 ||
    summary.aggregate.accountedExposureUsd > options.expectedPolicy.maxCostUsd
  )
    throw new Error('Region-seeded physical receipt budget does not reconcile')

  const wholeCases: LocalizationCase[] = []
  const maskRows: Array<{
    caseId: string
    status: string
    referenceInstances: number
    scores: Array<{
      sha256: string
      status: string
      iou?: number
      passed?: boolean
      seedForegroundPixels?: number
    }>
    seedForegroundPixels: number
  }> = []
  const rows: Array<{
    caseId: string
    imageSha256: string
    expectedPresence: 'present' | 'absent'
    classifyStatus: 'ok' | 'failed'
    classificationCorrect: boolean
    extractionStatus: z.infer<typeof extraction>['status']
    seedStatus: z.infer<typeof regionStage>['status']
    seedRegion: Box | null
    seedRegionBoxIntersection: boolean
    seedRegionCenterInsideBox: boolean
    seedMaskForegroundHit: boolean | null
    wholeObjectBox: Box | null
    wholeObjectBoxCorrect: boolean
  }> = []
  let classificationCorrect = 0
  let classificationAttempted = 0
  let seedLocated = 0
  let positiveSeedLocations = 0
  let negativeSeedLocations = 0
  let seedBoxHits = 0
  let falsePositiveSeedHits = 0
  let positiveSeedHits = 0
  let falseExtractions = 0
  for (const source of corpus.cases) {
    assertActive(signal)
    const truth = truthById.get(source.caseId)!
    const result = resultById.get(source.caseId)!
    if (result.imageSha256 !== source.image.sha256)
      throw new Error('Prediction/input image hash mismatch')
    const boxes = targetBoxes(truth, source)
    const seedMetrics = measureSeedRegion(
      result.extraction.seed,
      truth.expectedPresence,
      boxes,
      source.image.width,
      source.image.height,
    )
    if (seedMetrics.located) {
      seedLocated++
      if (truth.expectedPresence === 'present') positiveSeedLocations++
      else negativeSeedLocations++
    }
    if (seedMetrics.boxOverlap) seedBoxHits++
    if (truth.expectedPresence === 'present' && seedMetrics.boxOverlap) positiveSeedHits++
    if (truth.expectedPresence === 'absent' && seedMetrics.boxOverlap) falsePositiveSeedHits++
    const expectedReceipt = receiptCounts.get(source.caseId) ?? {
      physical: 0,
      logicalIds: new Set<number>(),
      logicalRequests: new Map<number, string>(),
      costKnown: 0,
      costUnknown: 0,
      hashes: [],
    }
    if (
      result.classify.physicalCalls + result.extraction.physicalCalls !==
        expectedReceipt.physical ||
      result.classify.physicalCalls > 1 ||
      result.extraction.physicalCalls > 3 ||
      result.classify.physicalCalls > result.classify.logicalCalls ||
      result.extraction.physicalCalls > result.extraction.logicalCalls ||
      result.classify.logicalCalls > 1 ||
      result.extraction.logicalCalls > 3 ||
      result.classify.physicalCalls + result.extraction.physicalCalls > 4 ||
      result.classify.logicalCalls + result.extraction.logicalCalls > 4 ||
      result.classify.requestHashes.length !== result.classify.logicalCalls ||
      result.extraction.requestHashes.length !== result.extraction.logicalCalls
    )
      throw new Error('Per-case call budget does not reconcile')
    // Logical IDs are local to the case and allocated in stage order. A request
    // can fail during local validation before physical admission, so it has a
    // request hash but no receipt. Receipts must still map one-to-one to the
    // corresponding logical request, and only failed stages may lack receipts.
    const stagesHashes = [...result.classify.requestHashes, ...result.extraction.requestHashes]
    const stageLogicalCount = result.classify.logicalCalls + result.extraction.logicalCalls
    if (
      result.classify.logicalCalls !== result.classify.requestHashes.length ||
      result.extraction.logicalCalls !== result.extraction.requestHashes.length ||
      expectedReceipt.logicalRequests.size > stageLogicalCount
    )
      throw new Error('Stage logical request accounting is inconsistent')
    for (const [logicalId, requestSha256] of expectedReceipt.logicalRequests) {
      if (logicalId > stageLogicalCount || stagesHashes[logicalId - 1] !== requestSha256)
        throw new Error('Physical receipt does not match its numbered logical request')
    }
    for (let logicalId = 1; logicalId <= stageLogicalCount; logicalId++) {
      if (expectedReceipt.logicalRequests.has(logicalId)) continue
      const unchargedStage =
        logicalId <= result.classify.logicalCalls ? result.classify : result.extraction
      if (unchargedStage.status !== 'failed' || !unchargedStage.errorCode)
        throw new Error(
          'A logical request without a physical fetch is not a recorded stage failure',
        )
    }
    if (
      result.extraction.seed.physicalCalls !== result.extraction.physicalCalls ||
      result.extraction.seed.logicalCalls !== result.extraction.logicalCalls ||
      !same(
        result.extraction.seed.requestHashes.toSorted(),
        result.extraction.requestHashes.toSorted(),
      )
    )
      throw new Error('Seed and extraction call ledgers disagree')
    if (
      options.variant === 'no-image-control' &&
      (result.extraction.mask ||
        result.extraction.status === 'extracted' ||
        result.extraction.segmentation)
    )
      throw new Error('No-image control contains segmentation artifacts')
    if (
      options.variant === 'region-seeded-sam' &&
      seedMetrics.located &&
      (result.extraction.seed.prompt !== 'seed-region' ||
        !same(result.extraction.seed.searchLimit, {
          left: 0,
          top: 0,
          width: source.image.width,
          height: source.image.height,
        }))
    )
      throw new Error('Candidate seed prompt or full-source search region mismatch')
    const mask = result.extraction.status === 'extracted' ? result.extraction.mask : undefined
    if (truth.expectedPresence === 'absent' && mask) falseExtractions++
    if (options.variant === 'region-seeded-sam' && mask && !seedMetrics.located)
      throw new Error('Extracted candidate mask has no recorded seed region')
    const whole = mask !== undefined
    if (mask) validateMaskBounds(mask, source)
    if (options.variant === 'region-seeded-sam' && result.extraction.status === 'region-only')
      throw new Error('Candidate produced control-only region result')
    if (
      options.variant === 'no-image-control' &&
      result.extraction.status !== 'region-only' &&
      result.extraction.seed.status === 'located'
    )
      throw new Error('No-image region result schema mismatch')
    const outcome: LocalizationCase['outcome'] = whole
      ? { status: 'located', region: mask!.sourceRegion }
      : result.extraction.status === 'not-found'
        ? { status: 'not-found' }
        : result.extraction.status === 'unknown'
          ? { status: 'unknown' }
          : { status: 'failed' }
    wholeCases.push({
      caseId: source.caseId,
      expected:
        truth.expectedPresence === 'present'
          ? { presence: 'present', boxes }
          : { presence: 'absent', verified: true },
      outcome,
    })
    if (result.classify.status === 'ok') classificationAttempted++
    if (result.classify.status === 'ok' && result.classify.value === truth.expectedPresence)
      classificationCorrect++
    const references = truth.referenceMasks ?? []
    const prediction = mask
      ? await loadPrediction(mask, source, options.runDirectory, signal)
      : undefined
    const maskScores = await scoreReferenceMasks({
      source,
      refs: references,
      ...(prediction ? { predicted: prediction } : {}),
      ...(seedMetrics.located ? { seed: seedMetrics.seedRegion } : {}),
      referenceRoot: options.referenceRoot,
      signal,
    })
    maskRows.push({
      caseId: source.caseId,
      status:
        references.length === 0
          ? 'unannotated'
          : prediction
            ? 'scored-or-unavailable'
            : 'unavailable-no-mask',
      referenceInstances: references.length,
      scores: maskScores.scores,
      seedForegroundPixels: maskScores.seedForegroundPixels,
    })
    if (prediction) prediction.bytes.fill(0)
    rows.push({
      caseId: source.caseId,
      imageSha256: source.image.sha256,
      expectedPresence: truth.expectedPresence,
      classifyStatus: result.classify.status,
      classificationCorrect:
        result.classify.status === 'ok' && result.classify.value === truth.expectedPresence,
      extractionStatus: result.extraction.status,
      seedStatus: result.extraction.seed.status,
      seedRegion: seedMetrics.located ? seedMetrics.seedRegion : null,
      seedRegionBoxIntersection: seedMetrics.boxOverlap,
      seedRegionCenterInsideBox: seedMetrics.located ? seedMetrics.centerInsideReferenceBox : false,
      seedMaskForegroundHit: references.some(
        (ref) => ref.width === source.image.width && ref.height === source.image.height,
      )
        ? maskScores.seedForegroundPixels > 0
        : null,
      wholeObjectBox: mask ? mask.sourceRegion : null,
      wholeObjectBoxCorrect: mask
        ? wholeObjectMetrics([
            {
              caseId: source.caseId,
              expected:
                truth.expectedPresence === 'present'
                  ? { presence: 'present', boxes }
                  : { presence: 'absent', verified: true },
              outcome: { status: 'located', region: mask.sourceRegion },
            },
          ]).rows[0]!.correct
        : false,
    })
  }
  const localization = wholeObjectMetrics(wholeCases)
  const strata = Object.fromEntries(
    (['photo-', 'ui-', 'map-'] as const).map((prefix) => {
      const groupRows = rows.filter((row) => row.caseId.startsWith(prefix))
      const positives = groupRows.filter((row) => row.expectedPresence === 'present')
      const negatives = groupRows.filter((row) => row.expectedPresence === 'absent')
      return [
        prefix.slice(0, -1),
        {
          denominator: groupRows.length,
          positives: positives.length,
          negatives: negatives.length,
          classification: {
            answered: groupRows.filter((row) => row.classifyStatus === 'ok').length,
            correct: groupRows.filter((row) => row.classificationCorrect).length,
          },
          extractionStatuses: Object.fromEntries(
            [...new Set(groupRows.map((row) => row.extractionStatus))].map((status) => [
              status,
              groupRows.filter((row) => row.extractionStatus === status).length,
            ]),
          ),
          seed: {
            located: groupRows.filter((row) => row.seedStatus === 'located').length,
            positiveBoxIntersections: positives.filter((row) => row.seedRegionBoxIntersection)
              .length,
            falseSeedLocations: negatives.filter((row) => row.seedStatus === 'located').length,
            falsePositiveBoxIntersections: negatives.filter((row) => row.seedRegionBoxIntersection)
              .length,
          },
          maskDerivedBoxes: {
            matchedPositive: positives.filter((row) => row.wholeObjectBoxCorrect).length,
            falseExtractions: negatives.filter((row) => row.extractionStatus === 'extracted')
              .length,
          },
        },
      ]
    }),
  )
  const output = {
    schema: 'region-seeded-independent-evaluation-v1',
    runId: run.runId,
    profileId: run.profileId,
    phase: run.phase,
    variant: run.variant,
    complete: true,
    denominator: expectedIds.length,
    inputManifests: corpus.manifests,
    rawSha256: {
      runManifest: options.runManifest.sha256,
      summary: options.summary.sha256,
      completionSeal: options.completionSeal.sha256,
      truths: options.truths.map((item) => item.sha256),
    },
    producerSourceSha256: options.expectedProducerSourceSha256,
    variantSha256: options.expectedVariantSha256,
    classification: {
      denominator: expectedIds.length,
      answered: classificationAttempted,
      correct: classificationCorrect,
      accuracy: expectedIds.length ? classificationCorrect / expectedIds.length : null,
      unanswered: expectedIds.length - classificationAttempted,
      errors: expectedIds.length - classificationCorrect,
    },
    strata,
    seedRegionCoarseProxy: {
      located: seedLocated,
      locatedOnPresentCases: positiveSeedLocations,
      locatedOnAbsentCases: negativeSeedLocations,
      positiveBoxIntersections: positiveSeedHits,
      boxIntersections: seedBoxHits,
      falsePositiveBoxIntersections: falsePositiveSeedHits,
      falseSeedLocations: negativeSeedLocations,
      falseExtractions,
      positiveCellIsNotWholeObject: true,
      metric:
        'any positive-area intersection of seed cell and independent target box; coarse proxy only',
    },
    wholeObjectLocalization: options.variant === 'region-seeded-sam' ? localization : null,
    mask: {
      referenceInstances: maskRows.reduce((sum, row) => sum + row.referenceInstances, 0),
      scored: maskRows.reduce(
        (sum, row) => sum + row.scores.filter((score) => score.status === 'scored').length,
        0,
      ),
      passedAtIoU08: maskRows.reduce(
        (sum, row) =>
          sum + row.scores.filter((score) => score.status === 'scored' && score.passed).length,
        0,
      ),
      unavailable: maskRows.reduce(
        (sum, row) => sum + row.scores.filter((score) => score.status !== 'scored').length,
        0,
      ),
      unannotatedCases: maskRows.filter((row) => row.referenceInstances === 0).length,
      rows: maskRows,
    },
    physical: {
      count: summary.aggregate.admittedPhysicalCalls,
      knownCostUsd: knownCost,
      unknownCostCalls,
      accountedExposureUsd: summary.aggregate.accountedExposureUsd,
      receipts: summary.physicalReceipts.length,
    },
    rows,
  }
  assertActive(signal)
  const outputPath = resolve(options.output)
  await mkdir(resolve(outputPath, '..'), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })
  return output
}

/** Paired comparison is only between the same seed-search proxy, never a mask box and a seed cell. */
export function compareRegionSeededPhotoSeeds(
  candidate: Awaited<ReturnType<typeof evaluateRegionSeededRun>>,
  control: Awaited<ReturnType<typeof evaluateRegionSeededRun>>,
) {
  if (
    candidate.phase !== control.phase ||
    candidate.variant !== 'region-seeded-sam' ||
    control.variant !== 'no-image-control' ||
    candidate.complete !== true ||
    control.complete !== true ||
    !same(candidate.inputManifests, control.inputManifests) ||
    !same(candidate.rawSha256.truths, control.rawSha256.truths)
  )
    throw new Error('Paired seed comparison requires matching frozen DEV inputs and truth')
  const candidateById = new Map(candidate.rows.map((row) => [row.caseId, row]))
  const controlById = new Map(control.rows.map((row) => [row.caseId, row]))
  const photoPositiveIds = candidate.rows
    .filter((row) => row.caseId.startsWith('photo-') && row.expectedPresence === 'present')
    .map((row) => row.caseId)
  sameIds(
    photoPositiveIds,
    control.rows
      .filter((row) => row.caseId.startsWith('photo-') && row.expectedPresence === 'present')
      .map((row) => row.caseId),
    'paired positive photo',
  )
  const coarsePairs = photoPositiveIds.map((caseId) => ({
    caseId,
    candidate: candidateById.get(caseId)!.seedRegionBoxIntersection,
    control: controlById.get(caseId)!.seedRegionBoxIntersection,
  }))
  const maskPairs = photoPositiveIds.flatMap((caseId) => {
    const first = candidateById.get(caseId)!.seedMaskForegroundHit
    const second = controlById.get(caseId)!.seedMaskForegroundHit
    return first === null || second === null ? [] : [{ caseId, candidate: first, control: second }]
  })
  return {
    photoPositivePairs: photoPositiveIds.length,
    coarseBoxIntersectionSeedProxy: pairedBootstrap(coarsePairs),
    exactReferenceMaskForegroundSeedHit: maskPairs.length ? pairedBootstrap(maskPairs) : null,
    interpretation:
      'Paired seed-search proxy only. Region-cell intersection is not whole-object localization; no candidate mask box is paired against a control seed cell.',
  }
}

async function loadPrediction(
  mask: z.infer<typeof maskDescriptor>,
  source: FreshCase,
  runDirectory: string,
  signal: AbortSignal,
) {
  const caseDirectory = resolve(runDirectory, source.caseId)
  const maskPath = await actualPath(
    runDirectory,
    resolve(caseDirectory, mask.file),
    'Predicted mask',
  )
  const bytes = await readBoundedCorpusFile(maskPath, 2_097_152, signal)
  try {
    if (
      digest(bytes) !== mask.sha256 ||
      bytes.length !== mask.width * mask.height ||
      bytes.some((value) => value !== 0 && value !== 1)
    )
      throw new Error('Predicted mask hash, length or binary format mismatch')
    const pngPath = await actualPath(
      runDirectory,
      resolve(caseDirectory, mask.pngFile),
      'Predicted cutout',
    )
    const png = await readBoundedCorpusFile(pngPath, 8 * 1024 * 1024, signal)
    try {
      if (digest(png) !== mask.pngSha256) throw new Error('Predicted cutout PNG digest mismatch')
      const decoded = await sharp(png, { limitInputPixels: 2_097_152, failOn: 'error' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      try {
        if (
          decoded.info.format !== 'raw' ||
          decoded.info.width !== mask.width ||
          decoded.info.height !== mask.height ||
          decoded.info.channels !== 4
        )
          throw new Error('Cutout PNG geometry mismatch')
        for (let i = 0; i < bytes.length; i++)
          if ((bytes[i] === 1) !== decoded.data[i * 4 + 3]! > 0)
            throw new Error('Cutout PNG alpha does not match the binary mask')
      } finally {
        decoded.data.fill(0)
      }
    } finally {
      png.fill(0)
    }
    return {
      bytes: new Uint8Array(bytes),
      width: mask.width,
      height: mask.height,
      offset: { x: mask.sourceOffset.x, y: mask.sourceOffset.y },
    }
  } finally {
    bytes.fill(0)
  }
}
