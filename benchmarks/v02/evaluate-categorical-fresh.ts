import { createHash, randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { assertActive } from '../../src/entities/errors.js'
import { evaluateFreshRun } from './evaluate-fresh.js'
import {
  freshProposalInputPins,
  proposalArtifactSchemas,
  scoreProposalMasks,
} from './evaluate-proposals.js'
import { freshProducerTask, loadFreshCorpus, readBoundedCorpusFile } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const pinnedFile = z.object({ path: z.string().min(1), sha256: digest }).strict()
const profile = z.enum([
  'native-luna-categorical-presence-sam-target-plus-neutral-v1',
  'native-luna-categorical-presence-sam-target-only-v1',
  'native-luna-box-confirmation-sam-target-plus-neutral-v1',
])
const targetPolicy = z.enum(['target-plus-neutral-instruction-v1', 'target-only-v1'])
const neutralInstruction =
  'Locate the visible physical instance of the named object; return unknown when unsupported.'
const policy = z
  .object({
    timeoutMs: z.literal(120_000),
    maxInFlight: z.literal(2),
    maxInFlightCases: z.literal(2),
    nativeMaxActive: z.literal(1),
    nativeMaxWaiting: z.literal(2),
    boxTolerancePx: z.literal(8),
    maxExtentPasses: z.literal(3),
    maxPhysicalCallsPerCase: z.literal(6),
    worstCaseCallsAcross40: z.literal(240),
    retries: z.literal(0),
    fallback: z.literal(false),
    maxPhysicalCalls: z.literal(300),
    maxCostUsd: z.literal(5),
    unknownCostReserveUsd: z.literal(0.05),
    latencyEnvironment: z.literal('concurrent-development-runner-unranked'),
    latencyRankingEligible: z.literal(false),
  })
  .strict()
const classification = z
  .object({
    questionSource: z.literal('freshProducerTask.question'),
    instructionSuffix: z.literal('Use only the supplied image. Choose exactly one closed label.'),
    classes: z.tuple([
      z
        .object({
          id: z.literal('present'),
          description: z.literal('The target in the question is visible in this image.'),
        })
        .strict(),
      z
        .object({
          id: z.literal('absent'),
          description: z.literal('The target in the question is not visible in this image.'),
        })
        .strict(),
    ]),
  })
  .strict()
const runSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(200),
    profileId: profile,
    phase: z.literal('dev'),
    purpose: z.literal('full fresh DEV photo, independent UI and independent map producer pass'),
    startedAt: z.string().datetime(),
    variantSha256: digest,
    producerSourceSha256: digest,
    sourceHashes: z.record(z.string().min(1), digest),
    manifests: z
      .array(z.object({ sha256: digest, cases: z.number().int().positive() }).strict())
      .length(3),
    plannedCaseIds: z.array(z.string().min(1)).length(40),
    plannedCases: z.array(proposalArtifactSchemas.plannedCase).length(40),
    route: proposalArtifactSchemas.route,
    mobileSam: proposalArtifactSchemas.assets,
    policy,
    targetPolicy,
    classification,
    taskManifest: proposalArtifactSchemas.taskManifest,
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
const nullableError = z.string().min(1).max(100).nullable()
const summarySchema = z
  .object({
    runId: z.string().min(1).max(200),
    profileId: profile,
    phase: z.literal('dev'),
    targetPolicy,
    variantSha256: digest,
    producerSourceSha256: digest,
    sourceAfterSha256: digest,
    sourceUnchanged: z.literal(true),
    status: z.literal('complete'),
    plannedCaseIds: z.array(z.string().min(1)).length(40),
    completedCaseIds: z.array(z.string().min(1)).length(40),
    missingCaseIds: z.array(z.never()).length(0),
    results: z.array(proposalArtifactSchemas.result).length(40),
    aggregate: proposalArtifactSchemas.budget,
    latencyEnvironment: policy.shape.latencyEnvironment,
    latencyRankingEligible: z.literal(false),
    initializationError: nullableError,
    shutdownError: z.null(),
    settleError: z.null(),
    disposeError: z.null(),
    physicalReceipts: z
      .array(proposalArtifactSchemas.physicalReceipt.extend({ caseId: z.string().min(1) }))
      .max(240),
  })
  .strict()

const expectedAssets = {
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
}
const legacyRequiredSources = [
  './categorical-presence-fresh-runner.ts',
  './run-categorical-presence-fresh.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  './categorical-presence-port.ts',
  './native-categorical-presence-port.ts',
  './categorical-presence-fresh-pair.md',
  '../../package.json',
  '../../package-lock.json',
]
const boxConfirmationRequiredSources = [
  ...legacyRequiredSources.slice(0, 2),
  './run-categorical-box-confirmation-dev.ts',
  ...legacyRequiredSources.slice(2, 9),
  './categorical-heldout-plan.ts',
  './fresh-text-runner.ts',
  './run-categorical-heldout.ts',
  '../../package.json',
  '../../package-lock.json',
]

function same(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right)
}

function sameIds(left: readonly string[], right: readonly string[], label: string): void {
  if (
    new Set(left).size !== left.length ||
    new Set(right).size !== right.length ||
    !same([...left].sort(), [...right].sort())
  )
    throw new Error(`Categorical DEV ${label} mismatch`)
}

/** Evaluator-only: preserves the two historical source closures and the separate box recipe. */
export function normalizeCategoricalFreshOutput(
  rawSummary: unknown,
  rawManifest: unknown,
  cases: readonly FreshCase[],
  manifests: readonly { sha256: string; cases: number }[],
  commitments: {
    summarySha256: string
    runManifestSha256: string
    expectedProducerSourceSha256: string
  },
) {
  const run = runSchema.parse(rawManifest)
  const summary = summarySchema.parse(rawSummary)
  digest.parse(commitments.summarySha256)
  digest.parse(commitments.runManifestSha256)
  digest.parse(commitments.expectedProducerSourceSha256)
  const expectedTargetPolicy =
    run.profileId === 'native-luna-categorical-presence-sam-target-only-v1'
      ? 'target-only-v1'
      : 'target-plus-neutral-instruction-v1'
  const isBoxConfirmation =
    run.profileId === 'native-luna-box-confirmation-sam-target-plus-neutral-v1'
  const expectedRequiredSources = isBoxConfirmation
    ? boxConfirmationRequiredSources
    : legacyRequiredSources
  const expectedSourceCount = expectedRequiredSources.length + 53
  const nonSourcePaths = Object.keys(run.sourceHashes).filter((path) => !path.startsWith('src/'))
  if (
    summary.runId !== run.runId ||
    summary.profileId !== run.profileId ||
    summary.targetPolicy !== expectedTargetPolicy ||
    run.targetPolicy !== expectedTargetPolicy ||
    summary.variantSha256 !== run.variantSha256 ||
    summary.producerSourceSha256 !== commitments.expectedProducerSourceSha256 ||
    run.producerSourceSha256 !== commitments.expectedProducerSourceSha256 ||
    summary.sourceAfterSha256 !== commitments.expectedProducerSourceSha256 ||
    hashCanonical(Object.entries(run.sourceHashes).sort(([a], [b]) => a.localeCompare(b))) !==
      commitments.expectedProducerSourceSha256 ||
    expectedRequiredSources.some((path) => !Object.hasOwn(run.sourceHashes, path)) ||
    !same([...nonSourcePaths].sort(), [...expectedRequiredSources].sort()) ||
    Object.keys(run.sourceHashes).filter((path) => path.startsWith('src/')).length !== 53 ||
    Object.keys(run.sourceHashes).length !== expectedSourceCount
  )
    throw new Error('Categorical DEV profile or frozen source mismatch')
  if (
    cases.length !== 40 ||
    !same(manifests, freshProposalInputPins) ||
    !same(run.manifests, freshProposalInputPins) ||
    !same(run.mobileSam, expectedAssets)
  )
    throw new Error('Categorical DEV corpus or native assets mismatch')
  for (const item of cases)
    if (item.locate.instruction !== undefined && item.locate.instruction !== neutralInstruction)
      throw new Error('Categorical DEV contains a non-neutral instruction')
  const ids = cases.map((item) => item.caseId)
  sameIds(ids, run.plannedCaseIds, 'manifest IDs')
  sameIds(ids, summary.plannedCaseIds, 'planned IDs')
  sameIds(ids, summary.completedCaseIds, 'completed IDs')
  sameIds(
    ids,
    summary.results.map((row) => row.caseId),
    'result IDs',
  )
  if (
    !same(
      run.plannedCases,
      cases.map((item) => ({
        caseId: item.caseId,
        imageSha256: item.image.sha256,
        imageDimensions: { width: item.image.width, height: item.image.height },
      })),
    ) ||
    !same(
      run.taskManifest,
      cases.map((item) => ({ caseId: item.caseId, task: freshProducerTask(item) })),
    )
  )
    throw new Error('Categorical DEV frozen image or task mismatch')

  const receipts = summary.physicalReceipts
  const physicalIds = receipts.map((call) => call.physicalId).sort((a, b) => a - b)
  if (
    physicalIds.some((id, index) => id !== index + 1) ||
    summary.aggregate.admittedPhysicalCalls !== receipts.length ||
    summary.aggregate.inFlightCalls !== 0 ||
    summary.aggregate.maxPhysicalCalls !== 300 ||
    summary.aggregate.maxCostUsd !== 5
  )
    throw new Error('Categorical DEV physical ledger does not close')
  const costs = receipts.map(
    (call) => call.receipt?.costUsd ?? call.wireReceipt?.usageCostUsd ?? null,
  )
  for (const call of receipts)
    if (
      call.receipt?.costUsd !== undefined &&
      call.receipt.costUsd !== null &&
      call.wireReceipt?.usageCostUsd !== undefined &&
      call.wireReceipt.usageCostUsd !== null &&
      Math.abs(call.receipt.costUsd - call.wireReceipt.usageCostUsd) > 1e-9
    )
      throw new Error('Categorical DEV parsed and wire receipt costs disagree')
  const knownCost = costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
  const unknownCosts = costs.filter((cost) => cost === null).length
  const exposure = knownCost + unknownCosts * 0.05
  if (
    Math.abs(summary.aggregate.knownCostUsd - knownCost) > 1e-9 ||
    summary.aggregate.unknownCostCalls !== unknownCosts ||
    Math.abs(summary.aggregate.accountedExposureUsd - exposure) > 1e-9 ||
    exposure > 5 ||
    receipts.some((call) => !ids.includes(call.caseId))
  )
    throw new Error('Categorical DEV receipt costs or case identity mismatch')
  const byId = new Map(cases.map((item) => [item.caseId, item]))
  for (const row of summary.results) {
    const item = byId.get(row.caseId)!
    const calls = receipts.filter((call) => call.caseId === row.caseId)
    const hashes = [...row.classify.requestHashes, ...row.locate.requestHashes]
    if (
      row.imageSha256 !== item.image.sha256 ||
      calls.length > 6 ||
      calls.length !== row.classify.physicalCalls + row.locate.physicalCalls ||
      row.classify.logicalCalls !== row.classify.requestHashes.length ||
      row.locate.logicalCalls !== row.locate.requestHashes.length ||
      row.classify.physicalCalls > row.classify.logicalCalls ||
      row.locate.physicalCalls > row.locate.logicalCalls ||
      row.classify.logicalCalls > 1 ||
      row.locate.logicalCalls > 5 ||
      (row.classify.status === 'failed' && !row.classify.errorCode) ||
      (row.locate.status === 'failed' && !row.locate.errorCode) ||
      calls.some((call) => hashes[call.logicalId - 1] !== call.requestSha256) ||
      calls.filter((call) => call.logicalId <= row.classify.logicalCalls).length !==
        row.classify.physicalCalls ||
      calls.filter((call) => call.logicalId > row.classify.logicalCalls).length !==
        row.locate.physicalCalls ||
      new Set(calls.map((call) => call.logicalId)).size !== calls.length
    )
      throw new Error('Categorical DEV per-case call or source mismatch')
    const box = row.locate.region
    const mask = row.extract.mask
    const nativeRecords = [
      row.locate.nativeProposal,
      row.extract.nativeProposal,
      row.extract.segmentation,
    ]
    if (
      (box &&
        (!Object.values(box).every(Number.isSafeInteger) ||
          box.left + box.width > item.image.width ||
          box.top + box.height > item.image.height)) ||
      nativeRecords.some(
        (native) =>
          native &&
          (native.method !== 'mobile-sam-nine-point-proposals-v1' ||
            native.backend !== 'mobile-sam' ||
            native.input.width !== item.image.width ||
            native.input.height !== item.image.height),
      ) ||
      (mask &&
        (row.locate.status !== 'located' ||
          mask.sourceOffset.x + mask.width > item.image.width ||
          mask.sourceOffset.y + mask.height > item.image.height))
    )
      throw new Error('Categorical DEV location or mask escaped its source')
  }
  return {
    runId: run.runId,
    profileId: run.profileId,
    phase: 'dev' as const,
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
    proposalExtractions: summary.results.map((row) => ({ caseId: row.caseId, ...row.extract })),
    rawProposalProvenance: {
      normalization: 'categorical-dev40-summary-adapter-v1',
      ...commitments,
      producerSourceSha256: run.producerSourceSha256,
      variantSha256: run.variantSha256,
      sourceHashes: run.sourceHashes,
      targetPolicy: run.targetPolicy,
      policy: run.policy,
      initializationError: summary.initializationError,
      physicalCalls: receipts.length,
      budget: summary.aggregate,
    },
  }
}

const optionsSchema = z
  .object({
    rawSummary: pinnedFile,
    runManifest: pinnedFile,
    expectedProducerSourceSha256: digest,
    corpus: z
      .object({ manifests: z.array(pinnedFile).length(3), imageRoot: z.string().min(1) })
      .strict(),
    truths: z.array(pinnedFile).length(3),
    derivedSummary: z.string().min(1),
    output: z.string().min(1),
    provenanceOutput: z.string().min(1),
  })
  .strict()

async function readPinned(file: z.infer<typeof pinnedFile>, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBoundedCorpusFile(file.path, 16 * 1024 * 1024, signal)
  try {
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error('Categorical DEV artifact digest mismatch')
    return JSON.parse(bytes.toString('utf8')) as unknown
  } finally {
    bytes.fill(0)
  }
}

/** Independent file-backed evaluation; producer recipes and legacy evaluator stay separate. */
export async function evaluateCategoricalFreshRun(
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
    throw new Error('Categorical DEV paths must be distinct')
  const [raw, manifest, corpus] = await Promise.all([
    readPinned(options.rawSummary, signal),
    readPinned(options.runManifest, signal),
    loadFreshCorpus(options.corpus, signal),
  ])
  const normalized = normalizeCategoricalFreshOutput(
    raw,
    manifest,
    corpus.cases,
    corpus.manifests,
    {
      summarySha256: options.rawSummary.sha256,
      runManifestSha256: options.runManifest.sha256,
      expectedProducerSourceSha256: options.expectedProducerSourceSha256,
    },
  )
  const masks = await scoreProposalMasks(
    summarySchema.parse(raw),
    corpus.cases,
    options.truths,
    dirname(resolve(options.rawSummary.path)),
    options.corpus.imageRoot,
    signal,
  )
  const body = JSON.stringify(normalized, null, 2) + '\n'
  const normalizedSha256 = createHash('sha256').update(body).digest('hex')
  await writeFile(options.derivedSummary, body, { flag: 'wx' })
  const temporary = `${options.output}.evaluator-${randomUUID()}.tmp`
  let evaluated: Awaited<ReturnType<typeof evaluateFreshRun>>
  let evaluationFailed = false
  let evaluationFailure: unknown
  try {
    evaluated = await evaluateFreshRun(
      {
        summary: { path: options.derivedSummary, sha256: normalizedSha256 },
        runManifest: options.runManifest,
        corpus: options.corpus,
        truths: options.truths,
        output: temporary,
      },
      signal,
    )
  } catch (error) {
    evaluationFailed = true
    evaluationFailure = error
    throw error
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
      if (evaluationFailed)
        throw new AggregateError(
          [evaluationFailure, error],
          'Evaluation and temporary cleanup failed',
        )
      throw error
    })
  }
  const result = {
    ...evaluated,
    proposalExtractions: normalized.proposalExtractions,
    proposalMaskMetrics: masks,
    sourceQualified: normalized.rawProposalProvenance.initializationError === null,
    latencyRankingEligible: false,
  }
  const resultBody = JSON.stringify(result, null, 2) + '\n'
  assertActive(signal)
  await writeFile(options.output, resultBody, { flag: 'wx' })
  const provenance = {
    ...normalized.rawProposalProvenance,
    derivedSummarySha256: normalizedSha256,
    evaluationSha256: createHash('sha256').update(resultBody).digest('hex'),
    producerInputs: corpus.manifests,
    truthSha256: options.truths.map((file) => file.sha256),
  }
  await writeFile(options.provenanceOutput, JSON.stringify(provenance, null, 2) + '\n', {
    flag: 'wx',
  })
  return { ...result, provenance }
}
