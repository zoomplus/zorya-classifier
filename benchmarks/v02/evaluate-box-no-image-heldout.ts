import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FreshCase } from './fresh-corpus.js'
import { loadFreshCorpus } from './fresh-corpus.js'
import { assertActive } from '../../src/entities/errors.js'
import { evaluateFreshRun } from './evaluate-fresh.js'
import {
  parseBoxCategoricalEvaluationFreeze,
  readPinnedCategoricalEvaluationJson,
} from './evaluate-categorical-box-heldout.js'
import { proposalArtifactSchemas } from './evaluate-proposals.js'
import { hashCanonical } from './protocol.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const methodSelection = '3b576871c36d904203ef06e0cf26af5847a71a92c2df3647725d532238258c5e'
const requiredSources = [
  './fresh-text-runner.ts',
  './fresh-text-dev.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  './promptvariants.ts',
  './transportvariants.ts',
  './categorical-heldout-plan.ts',
  './categorical-presence-fresh-runner.ts',
  './run-categorical-heldout.ts',
  './categorical-box-heldout-plan.ts',
  './categorical-box-heldout-source.ts',
  './run-categorical-box-heldout.ts',
  '../experiments/text-encoders-v1.ts',
  '../experiments/ascii-luma-v1.ts',
  '../experiments/palette-grid-v1.ts',
  '../experiments/svg-contours-v1.ts',
  '../experiments/pixel-rle-v1.ts',
  '../experiments/ascii-contours-v1.ts',
  '../experiments/ascii-svg-layered-v1.ts',
  '../../package.json',
  '../../package-lock.json',
]
const identity = {
  runId: z.string().min(1),
  profileId: z.literal('deepseek-flash-no-image-photo-box-confirmation-heldout-v1'),
  phase: z.literal('heldout'),
  purpose: z.literal(
    'full frozen HELDOUT photo-only no-image control for box-confirmation target policy',
  ),
  targetPolicy: z.literal('target-plus-neutral-instruction-v1'),
  methodSelectionSha256: z.literal(methodSelection),
  variantSha256: digest,
  producerSourceSha256: digest,
  sourceBeforeSha256: digest,
}
const route = z
  .object({
    id: z.literal('together-deepseek-flash-text-v1'),
    model: z.literal('deepseek/deepseek-v4.1-flash'),
    provider: z.literal('together'),
    providerName: z.literal('Together'),
    apiEndpoint: z.literal('/api/v1/chat/completions'),
    allowFallbacks: z.literal(false),
  })
  .strict()
const prompt = z
  .object({
    id: z.literal('grammar-plus-examples'),
    prepend: z.array(z.string()).length(2),
    append: z.array(z.string()).length(1),
  })
  .strict()
const transport = z
  .object({
    id: z.literal('none-json-schema'),
    responseFormat: z.literal('json-schema'),
    reasoningEffort: z.literal('none'),
  })
  .strict()
const policy = z
  .object({
    timeoutMs: z.literal(120000),
    concurrency: z.literal(1),
    maxQueue: z.literal(0),
    maxInFlight: z.literal(1),
    maxInFlightCases: z.literal(1),
    boxTolerancePx: z.literal(8),
    maxExtentPasses: z.literal(3),
    retries: z.literal(0),
    fallback: z.literal(false),
    maxPhysicalCalls: z.literal(300),
    maxCostUsd: z.literal(5),
    unknownCostReserveUsd: z.literal(0.05),
    classifyMaxOutputTokens: z.literal(1024),
    locateMaxOutputTokens: z.literal(4096),
    maxPhysicalCallsPerCase: z.literal(6),
    worstCasePhysicalCalls: z.literal(240),
    latencyEnvironment: z.literal('heldout-no-image-control-unranked'),
    latencyRankingEligible: z.literal(false),
  })
  .strict()
const commonStage = {
  durationMs: z.number().finite().nonnegative(),
  calls: z.number().int().nonnegative(),
  requestHashes: z.array(digest).max(12),
  errorCode: z.string().min(1).optional(),
}
const box = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
const row = z
  .object({
    caseId: z.string().min(1),
    imageSha256: digest,
    profileId: identity.profileId,
    classify: z
      .object({
        ...commonStage,
        status: z.enum(['ok', 'failed']),
        value: z.enum(['present', 'absent']).optional(),
      })
      .strict()
      .refine((s) => (s.status === 'ok') === (s.value !== undefined)),
    locate: z
      .object({
        ...commonStage,
        status: z.enum(['located', 'unknown', 'not-found', 'failed']),
        region: box.optional(),
        reason: z.string().optional(),
      })
      .strict()
      .refine((s) => (s.status === 'located') === (s.region !== undefined)),
  })
  .strict()
const manifestSchema = z
  .object({
    ...identity,
    schemaVersion: z.literal(1),
    startedAt: z.string().datetime(),
    stages: z.literal('classify-and-locate'),
    sourceHashes: z.record(z.string(), digest),
    heldoutProducerSourceSha256: digest,
    producerSourceRole: z.literal('producer-only'),
    manifests: z.array(z.object({ sha256: digest, cases: z.literal(40) }).strict()).length(1),
    plannedCaseIds: z.array(z.string()).length(40),
    plannedCases: z.array(proposalArtifactSchemas.plannedCase).length(40),
    route,
    policy,
    prompt,
    promptSha256: digest,
    transport,
    transportSha256: digest,
    routePolicy: z
      .object({
        responseFormat: z.literal('json-schema'),
        reasoningEffort: z.literal('none'),
        promptVariant: z.literal('grammar-plus-examples'),
        transportVariant: z.literal('none-json-schema'),
        imagePartsRemoved: z.literal(true),
        textEncoder: z.null(),
        objectProposals: z.null(),
        segmentation: z.literal(false),
        ocr: z.literal(false),
      })
      .strict(),
    modelBoundary: z
      .object({
        evaluatorTruthRead: z.literal(false),
        retries: z.literal(0),
        fallback: z.literal(false),
        imagePartsRemoved: z.literal(true),
        textEncoder: z.null(),
        segmentation: z.literal(false),
        ocr: z.literal(false),
      })
      .strict(),
    imagePartAudit: z
      .object({
        method: z.literal('inspect-every-serialized-provider-request-before-fetch-v1'),
        expectedImageParts: z.literal(0),
        expectedEncodedImageState: z.literal(false),
        rawBodiesPersisted: z.literal(false),
      })
      .strict(),
  })
  .strict()
const summarySchema = z
  .object({
    ...identity,
    sourceAfterSha256: digest,
    sourceUnchanged: z.literal(true),
    status: z.literal('complete'),
    plannedCaseIds: z.array(z.string()).length(40),
    completedCaseIds: z.array(z.string()).length(40),
    missingCaseIds: z.array(z.never()).length(0),
    failure: z.null(),
    results: z.array(row).length(40),
    aggregate: proposalArtifactSchemas.budget,
    policy,
    latencyEnvironment: policy.shape.latencyEnvironment,
    latencyRankingEligible: z.literal(false),
    physicalReceipts: z
      .array(
        proposalArtifactSchemas.physicalReceipt.extend({
          caseId: z.string(),
          stage: z.enum(['classify', 'locate']),
          route,
        }),
      )
      .max(240),
    imagePartAudit: z
      .object({
        fetchesChecked: z.number().int().nonnegative(),
        fetchAttempts: z.number().int().nonnegative(),
        zeroImagePartsConfirmed: z.number().int().nonnegative(),
        zeroImageDerivedStateConfirmed: z.number().int().nonnegative(),
        imagePartViolations: z.literal(0),
        unverifiableBodies: z.literal(0),
        complete: z.literal(true),
      })
      .strict(),
  })
  .strict()

function same(a: unknown, b: unknown) {
  return hashCanonical(a) === hashCanonical(b)
}
function sameIds(a: readonly string[], b: readonly string[]) {
  return (
    new Set(a).size === a.length &&
    new Set(b).size === b.length &&
    same([...a].sort(), [...b].sort())
  )
}

/** Evaluator-only control admission. Actual request bodies were checked at the producer fetch. */
export function normalizeBoxNoImageControlOutput(
  rawSummary: unknown,
  rawManifest: unknown,
  cases: readonly FreshCase[],
  commitments: {
    expectedProducerSourceSha256: string
    expectedCandidateSourceSha256: string
    freeze: unknown
    expectedPromptSha256: string
    summarySha256: string
    runManifestSha256: string
    freezeSha256: string
  },
) {
  const run = manifestSchema.parse(rawManifest),
    summary = summarySchema.parse(rawSummary),
    freeze = parseBoxCategoricalEvaluationFreeze(commitments.freeze)
  const photoPin = { sha256: freeze.manifests[0].sha256, cases: freeze.manifests[0].cases }
  digest.parse(commitments.expectedProducerSourceSha256)
  digest.parse(commitments.expectedCandidateSourceSha256)
  digest.parse(commitments.expectedPromptSha256)
  digest.parse(commitments.summarySha256)
  digest.parse(commitments.runManifestSha256)
  digest.parse(commitments.freezeSha256)
  const ids = cases.map((c) => c.caseId)
  if (
    cases.length !== 40 ||
    !same(run.manifests, [photoPin]) ||
    !sameIds(ids, run.plannedCaseIds) ||
    !sameIds(ids, summary.plannedCaseIds) ||
    !sameIds(ids, summary.completedCaseIds) ||
    !sameIds(
      ids,
      summary.results.map((r) => r.caseId),
    )
  )
    throw new Error('Box no-image HELDOUT input/case mismatch')
  if (
    summary.runId !== run.runId ||
    summary.variantSha256 !== run.variantSha256 ||
    run.methodSelectionSha256 !== methodSelection ||
    summary.methodSelectionSha256 !== methodSelection ||
    run.producerSourceSha256 !== commitments.expectedProducerSourceSha256 ||
    summary.producerSourceSha256 !== commitments.expectedProducerSourceSha256 ||
    run.sourceBeforeSha256 !== commitments.expectedProducerSourceSha256 ||
    summary.sourceBeforeSha256 !== commitments.expectedProducerSourceSha256 ||
    summary.sourceAfterSha256 !== commitments.expectedProducerSourceSha256 ||
    run.heldoutProducerSourceSha256 !== commitments.expectedCandidateSourceSha256 ||
    hashCanonical(Object.entries(run.sourceHashes).sort(([a], [b]) => a.localeCompare(b))) !==
      commitments.expectedProducerSourceSha256 ||
    Object.keys(run.sourceHashes).length !== 82 ||
    Object.keys(run.sourceHashes).filter((k) => k.startsWith('src/')).length !== 53 ||
    requiredSources.some((k) => !Object.hasOwn(run.sourceHashes, k)) ||
    !same(
      run.plannedCases,
      cases.map((c) => ({
        caseId: c.caseId,
        imageSha256: c.image.sha256,
        imageDimensions: { width: c.image.width, height: c.image.height },
      })),
    ) ||
    run.promptSha256 !== commitments.expectedPromptSha256 ||
    hashCanonical(run.prompt) !== commitments.expectedPromptSha256 ||
    run.transportSha256 !== hashCanonical(run.transport)
  )
    throw new Error('Box no-image HELDOUT source, prompt or image mismatch')
  const receipts = summary.physicalReceipts
  if (
    receipts
      .map((r) => r.physicalId)
      .sort((a, b) => a - b)
      .some((id, i) => id !== i + 1) ||
    summary.aggregate.admittedPhysicalCalls !== receipts.length ||
    summary.aggregate.inFlightCalls !== 0 ||
    summary.aggregate.maxPhysicalCalls !== 300 ||
    summary.aggregate.maxCostUsd !== 5
  )
    throw new Error('Box no-image HELDOUT physical ledger is incomplete')
  const costs = receipts.map((c) => c.receipt?.costUsd ?? c.wireReceipt?.usageCostUsd ?? null)
  for (const c of receipts)
    if (
      c.receipt?.costUsd != null &&
      c.wireReceipt?.usageCostUsd != null &&
      Math.abs(c.receipt.costUsd - c.wireReceipt.usageCostUsd) > 1e-9
    )
      throw new Error('Box no-image HELDOUT conflicting charge receipts')
  const known = costs.reduce<number>((a, b) => a + (b ?? 0), 0),
    unknown = costs.filter((c) => c === null).length,
    exposure = known + unknown * 0.05
  if (
    Math.abs(summary.aggregate.knownCostUsd - known) > 1e-9 ||
    summary.aggregate.unknownCostCalls !== unknown ||
    Math.abs(summary.aggregate.accountedExposureUsd - exposure) > 1e-9 ||
    exposure > 5 ||
    receipts.some((c) => !ids.includes(c.caseId))
  )
    throw new Error('Box no-image HELDOUT charge accounting mismatch')
  const audit = summary.imagePartAudit
  if (
    [
      audit.fetchAttempts,
      audit.fetchesChecked,
      audit.zeroImagePartsConfirmed,
      audit.zeroImageDerivedStateConfirmed,
    ].some((n) => n !== receipts.length)
  )
    throw new Error('Box no-image HELDOUT actual-fetch audit mismatch')
  const byId = new Map(cases.map((c) => [c.caseId, c]))
  for (const result of summary.results) {
    const item = byId.get(result.caseId)!,
      calls = receipts.filter((c) => c.caseId === result.caseId)
    if (
      result.imageSha256 !== item.image.sha256 ||
      calls.length > 6 ||
      calls.length !== result.classify.calls + result.locate.calls ||
      result.classify.calls > 1 ||
      result.classify.requestHashes.length > 1
    )
      throw new Error('Box no-image HELDOUT per-case accounting mismatch')
    for (const stage of ['classify', 'locate'] as const) {
      const value = result[stage],
        stageCalls = calls.filter((c) => c.stage === stage)
      if (
        stageCalls.length !== value.calls ||
        value.calls > value.requestHashes.length ||
        new Set(stageCalls.map((c) => c.logicalId)).size !== stageCalls.length ||
        stageCalls.some((c) => value.requestHashes[c.logicalId - 1] !== c.requestSha256) ||
        (value.status === 'failed' && !value.errorCode)
      )
        throw new Error('Box no-image HELDOUT stage receipt mismatch')
    }
    const b = result.locate.region
    if (b && (b.left + b.width > item.image.width || b.top + b.height > item.image.height))
      throw new Error('Box no-image HELDOUT box escaped source')
  }
  return {
    ...summary,
    sourceQualified: true as const,
    provenance: {
      normalization: 'categorical-box-no-image-heldout40-adapter-v1',
      ...commitments,
      methodSelectionSha256: methodSelection,
    },
  }
}

const pinnedFile = z.object({ path: z.string().min(1), sha256: digest }).strict()
const optionsSchema = z
  .object({
    rawSummary: pinnedFile,
    runManifest: pinnedFile,
    freeze: pinnedFile,
    expectedPromptSha256: digest,
    corpus: z
      .object({ manifests: z.array(pinnedFile).length(1), imageRoot: z.string().min(1) })
      .strict(),
    truths: z.array(pinnedFile).length(1),
    derivedSummary: z.string().min(1),
    output: z.string().min(1),
    provenanceOutput: z.string().min(1),
  })
  .strict()

/** Complete pinned-file control evaluation, using the same independent box criteria. */
export async function evaluateBoxNoImageHeldoutRun(
  input: z.input<typeof optionsSchema>,
  signal: AbortSignal,
) {
  assertActive(signal)
  const options = optionsSchema.parse(input)
  const paths = [
    options.rawSummary.path,
    options.runManifest.path,
    options.freeze.path,
    ...options.corpus.manifests.map((p) => p.path),
    ...options.truths.map((p) => p.path),
    options.derivedSummary,
    options.output,
    options.provenanceOutput,
  ].map((p) => resolve(p))
  if (new Set(paths).size !== paths.length)
    throw new Error('Box no-image HELDOUT paths must be distinct')
  const [raw, run, rawFreeze, corpus] = await Promise.all([
    readPinnedCategoricalEvaluationJson(options.rawSummary, signal),
    readPinnedCategoricalEvaluationJson(options.runManifest, signal),
    readPinnedCategoricalEvaluationJson(options.freeze, signal),
    loadFreshCorpus(options.corpus, signal),
  ])
  const freeze = parseBoxCategoricalEvaluationFreeze(rawFreeze)
  if (!same(corpus.manifests, [{ sha256: freeze.manifests[0].sha256, cases: 40 }]))
    throw new Error('Box no-image HELDOUT photo manifest mismatch')
  const normalized = normalizeBoxNoImageControlOutput(raw, run, corpus.cases, {
    expectedProducerSourceSha256: freeze.noImageProducerSourceSha256,
    expectedCandidateSourceSha256: freeze.producerSourceSha256,
    expectedPromptSha256: options.expectedPromptSha256,
    freeze,
    summarySha256: options.rawSummary.sha256,
    runManifestSha256: options.runManifest.sha256,
    freezeSha256: options.freeze.sha256,
  })
  const body = JSON.stringify(normalized, null, 2) + '\n'
  const normalizedSha256 = createHash('sha256').update(body).digest('hex')
  await writeFile(options.derivedSummary, body, { flag: 'wx' })
  const temporary = `${options.output}.evaluator-${randomUUID()}.tmp`
  let evaluated: Awaited<ReturnType<typeof evaluateFreshRun>>
  let failed = false,
    failure: unknown
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
    failed = true
    failure = error
    throw error
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
      if (failed)
        throw new AggregateError([failure, error], 'Control evaluation and cleanup failed')
      throw error
    })
  }
  const result = { ...evaluated, phase: 'heldout' as const, sourceQualified: true as const }
  const resultBody = JSON.stringify(result, null, 2) + '\n'
  assertActive(signal)
  await writeFile(options.output, resultBody, { flag: 'wx' })
  const provenance = {
    ...normalized.provenance,
    derivedSummarySha256: normalizedSha256,
    evaluationSha256: createHash('sha256').update(resultBody).digest('hex'),
    producerInputs: corpus.manifests,
    truthSha256: options.truths.map((f) => f.sha256),
    physicalCalls: normalized.physicalReceipts.length,
    actualFetchAudit: normalized.imagePartAudit,
  }
  await writeFile(options.provenanceOutput, JSON.stringify(provenance, null, 2) + '\n', {
    flag: 'wx',
  })
  return { ...result, provenance }
}
