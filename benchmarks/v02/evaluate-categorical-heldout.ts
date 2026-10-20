import { createHash, randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { assertActive } from '../../src/entities/errors.js'
import { evaluateFreshRun } from './evaluate-fresh.js'
import { proposalArtifactSchemas, scoreProposalMasks } from './evaluate-proposals.js'
import { freshProducerTask, loadFreshCorpus, readBoundedCorpusFile } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'
import { pairedBootstrap } from './metrics.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const pinnedFile = z.object({ path: z.string().min(1), sha256: digest }).strict()
const methodSelectionDigest = 'fabb05c2c472c30a8cb20a5f9b6d697b932d94aedc43976359746463ef8708b9'
const manifestPins = z.tuple([
  z
    .object({
      group: z.literal('photo'),
      cases: z.literal(40),
      sha256: z.literal('93cf40732075ab63fd26b77806a7b118382e816c6ab691bf3e5ee68a2acbf013'),
    })
    .strict(),
  z
    .object({
      group: z.literal('ui'),
      cases: z.literal(20),
      sha256: z.literal('1bf7940fd92fdc1f7fa295296dfc5f84c5f4c32ccc41b7a2e80a0059bff918c3'),
    })
    .strict(),
  z.object({ group: z.literal('map'), cases: z.literal(20), sha256: digest }).strict(),
])
const freezeSchema = z
  .object({
    schema: z.literal('categorical-heldout-run-freeze-v1'),
    phase: z.literal('heldout'),
    targetPolicy: z.literal('target-plus-neutral-instruction-v1'),
    methodSelectionSha256: z.literal(methodSelectionDigest),
    manifests: manifestPins,
    producerSourceSha256: digest,
    noImageProducerSourceSha256: digest,
    candidateBudget: z
      .object({
        maxPhysicalCalls: z.literal(600),
        maxCostUsd: z.literal(10),
        unknownCostReserveUsd: z.literal(0.05),
      })
      .strict(),
    noImageBudget: z
      .object({
        maxPhysicalCalls: z.literal(300),
        maxCostUsd: z.literal(5),
        unknownCostReserveUsd: z.literal(0.05),
      })
      .strict(),
  })
  .strict()

/** Shared evaluator schema only; producer validation remains a separate implementation. */
export function parseCategoricalEvaluationFreeze(raw: unknown) {
  return freezeSchema.parse(raw)
}
const profile = z.literal('native-luna-categorical-presence-sam-heldout-target-plus-neutral-v1')
const targetPolicy = z.literal('target-plus-neutral-instruction-v1')
const neutralInstruction =
  'Locate the visible physical instance of the named object; return unknown when unsupported.'
const policy = z
  .object({
    timeoutMs: z.literal(120_000),
    maxInFlight: z.literal(2),
    maxInFlightCases: z.literal(2),
    nativeMaxActive: z.literal(1),
    nativeMaxWaiting: z.literal(2),
    nativeThreads: z.literal(2),
    boxTolerancePx: z.literal(8),
    maxExtentPasses: z.literal(3),
    maxPhysicalCallsPerCase: z.literal(6),
    expectedCaseCount: z.literal(80),
    worstCasePhysicalCalls: z.literal(480),
    retries: z.literal(0),
    fallback: z.literal(false),
    maxPhysicalCalls: z.literal(600),
    maxCostUsd: z.literal(10),
    unknownCostReserveUsd: z.literal(0.05),
    latencyEnvironment: z.literal('heldout-development-soak-unranked'),
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
    phase: z.literal('heldout'),
    purpose: z.literal(
      'full frozen HELDOUT photo, independent UI and independent map producer pass',
    ),
    startedAt: z.string().datetime(),
    variantSha256: digest,
    producerSourceSha256: digest,
    sourceBeforeSha256: digest,
    methodSelectionSha256: z.literal(methodSelectionDigest),
    heldoutInputManifests: manifestPins,
    sourceHashes: z.record(z.string().min(1), digest),
    manifests: z
      .array(z.object({ sha256: digest, cases: z.number().int().positive() }).strict())
      .length(3),
    plannedCaseIds: z.array(z.string().min(1)).length(80),
    plannedCases: z.array(proposalArtifactSchemas.plannedCase).length(80),
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
    phase: z.literal('heldout'),
    purpose: z.literal(
      'full frozen HELDOUT photo, independent UI and independent map producer pass',
    ),
    targetPolicy,
    variantSha256: digest,
    producerSourceSha256: digest,
    sourceBeforeSha256: digest,
    methodSelectionSha256: z.literal(methodSelectionDigest),
    heldoutInputManifests: manifestPins,
    sourceAfterSha256: digest,
    sourceUnchanged: z.literal(true),
    status: z.literal('complete'),
    plannedCaseIds: z.array(z.string().min(1)).length(80),
    completedCaseIds: z.array(z.string().min(1)).length(80),
    missingCaseIds: z.array(z.never()).length(0),
    results: z.array(proposalArtifactSchemas.result).length(80),
    aggregate: proposalArtifactSchemas.budget,
    latencyEnvironment: policy.shape.latencyEnvironment,
    latencyRankingEligible: z.literal(false),
    initializationError: nullableError,
    shutdownError: z.null(),
    settleError: z.null(),
    disposeError: z.null(),
    physicalReceipts: z
      .array(proposalArtifactSchemas.physicalReceipt.extend({ caseId: z.string().min(1) }))
      .max(480),
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
const requiredSources = [
  './categorical-presence-fresh-runner.ts',
  './run-categorical-presence-fresh.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  './categorical-presence-port.ts',
  './native-categorical-presence-port.ts',
  './categorical-presence-fresh-pair.md',
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
    throw new Error(`Categorical HELDOUT ${label} mismatch`)
}

/** Evaluator-only: the independently frozen categorical HELDOUT recipe, never relabeled DEV. */
export function normalizeCategoricalHeldoutOutput(
  rawSummary: unknown,
  rawManifest: unknown,
  cases: readonly FreshCase[],
  manifests: readonly { sha256: string; cases: number }[],
  commitments: {
    summarySha256: string
    runManifestSha256: string
    freezeSha256: string
    freeze: unknown
  },
) {
  const run = runSchema.parse(rawManifest)
  const summary = summarySchema.parse(rawSummary)
  digest.parse(commitments.summarySha256)
  digest.parse(commitments.runManifestSha256)
  digest.parse(commitments.freezeSha256)
  const freeze = freezeSchema.parse(commitments.freeze)
  const expectedProducerSourceSha256 = freeze.producerSourceSha256
  const expectedTargetPolicy = 'target-plus-neutral-instruction-v1'
  const expectedPins = freeze.manifests.map(({ sha256, cases }) => ({ sha256, cases }))
  if (
    summary.runId !== run.runId ||
    summary.profileId !== run.profileId ||
    summary.targetPolicy !== expectedTargetPolicy ||
    run.targetPolicy !== expectedTargetPolicy ||
    summary.variantSha256 !== run.variantSha256 ||
    summary.sourceBeforeSha256 !== expectedProducerSourceSha256 ||
    run.sourceBeforeSha256 !== expectedProducerSourceSha256 ||
    !same(run.heldoutInputManifests, freeze.manifests) ||
    !same(summary.heldoutInputManifests, freeze.manifests) ||
    summary.producerSourceSha256 !== expectedProducerSourceSha256 ||
    run.producerSourceSha256 !== expectedProducerSourceSha256 ||
    summary.sourceAfterSha256 !== expectedProducerSourceSha256 ||
    hashCanonical(Object.entries(run.sourceHashes).sort(([a], [b]) => a.localeCompare(b))) !==
      expectedProducerSourceSha256 ||
    requiredSources.some((path) => !Object.hasOwn(run.sourceHashes, path)) ||
    Object.keys(run.sourceHashes).filter((path) => path.startsWith('src/')).length !== 53 ||
    Object.keys(run.sourceHashes).length !== 67
  )
    throw new Error('Categorical HELDOUT profile or frozen source mismatch')
  if (
    cases.length !== 80 ||
    !same(manifests, expectedPins) ||
    !same(run.manifests, expectedPins) ||
    !same(run.mobileSam, expectedAssets)
  )
    throw new Error('Categorical HELDOUT corpus or native assets mismatch')
  for (const item of cases)
    if (item.locate.instruction !== undefined && item.locate.instruction !== neutralInstruction)
      throw new Error('Categorical HELDOUT contains a non-neutral instruction')
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
    throw new Error('Categorical HELDOUT frozen image or task mismatch')

  const receipts = summary.physicalReceipts
  const physicalIds = receipts.map((call) => call.physicalId).sort((a, b) => a - b)
  if (
    physicalIds.some((id, index) => id !== index + 1) ||
    summary.aggregate.admittedPhysicalCalls !== receipts.length ||
    summary.aggregate.inFlightCalls !== 0 ||
    summary.aggregate.maxPhysicalCalls !== 600 ||
    summary.aggregate.maxCostUsd !== 10
  )
    throw new Error('Categorical HELDOUT physical ledger does not close')
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
      throw new Error('Categorical HELDOUT parsed and wire receipt costs disagree')
  const knownCost = costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
  const unknownCosts = costs.filter((cost) => cost === null).length
  const exposure = knownCost + unknownCosts * 0.05
  if (
    Math.abs(summary.aggregate.knownCostUsd - knownCost) > 1e-9 ||
    summary.aggregate.unknownCostCalls !== unknownCosts ||
    Math.abs(summary.aggregate.accountedExposureUsd - exposure) > 1e-9 ||
    exposure > 10 ||
    receipts.some((call) => !ids.includes(call.caseId))
  )
    throw new Error('Categorical HELDOUT receipt costs or case identity mismatch')
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
      throw new Error('Categorical HELDOUT per-case call or source mismatch')
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
      throw new Error('Categorical HELDOUT location or mask escaped its source')
  }
  return {
    runId: run.runId,
    profileId: run.profileId,
    phase: 'heldout' as const,
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
      normalization: 'categorical-heldout80-summary-adapter-v1',
      summarySha256: commitments.summarySha256,
      runManifestSha256: commitments.runManifestSha256,
      freezeSha256: commitments.freezeSha256,
      methodSelectionSha256: freeze.methodSelectionSha256,
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
    freeze: pinnedFile,
    corpus: z
      .object({ manifests: z.array(pinnedFile).length(3), imageRoot: z.string().min(1) })
      .strict(),
    truths: z.array(pinnedFile).length(3),
    derivedSummary: z.string().min(1),
    output: z.string().min(1),
    provenanceOutput: z.string().min(1),
  })
  .strict()

export async function readPinnedCategoricalEvaluationJson(
  file: z.infer<typeof pinnedFile>,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedCorpusFile(file.path, 16 * 1024 * 1024, signal)
  try {
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error('Categorical HELDOUT artifact digest mismatch')
    return JSON.parse(bytes.toString('utf8')) as unknown
  } finally {
    bytes.fill(0)
  }
}

/** Independent file-backed evaluation; producer recipes and legacy evaluator stay separate. */
export async function evaluateCategoricalHeldoutRun(
  input: z.input<typeof optionsSchema>,
  signal: AbortSignal,
) {
  assertActive(signal)
  const options = optionsSchema.parse(input)
  const paths = [
    options.rawSummary.path,
    options.runManifest.path,
    options.freeze.path,
    ...options.corpus.manifests.map((file) => file.path),
    ...options.truths.map((file) => file.path),
    options.derivedSummary,
    options.output,
    options.provenanceOutput,
  ].map((path) => resolve(path))
  if (new Set(paths).size !== paths.length)
    throw new Error('Categorical HELDOUT paths must be distinct')
  const [raw, manifest, corpus, freeze] = await Promise.all([
    readPinnedCategoricalEvaluationJson(options.rawSummary, signal),
    readPinnedCategoricalEvaluationJson(options.runManifest, signal),
    loadFreshCorpus(options.corpus, signal),
    readPinnedCategoricalEvaluationJson(options.freeze, signal),
  ])
  const normalized = normalizeCategoricalHeldoutOutput(
    raw,
    manifest,
    corpus.cases,
    corpus.manifests,
    {
      summarySha256: options.rawSummary.sha256,
      runManifestSha256: options.runManifest.sha256,
      freezeSha256: options.freeze.sha256,
      freeze,
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
    phase: 'heldout' as const,
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

type ComparableEvaluation = Pick<
  Awaited<ReturnType<typeof evaluateFreshRun>>,
  'profileId' | 'complete' | 'coverage' | 'inputs' | 'truthSha256' | 'rows'
>

/** Frozen paired photo comparison; failures remain failures and do not select another recipe. */
export function compareCategoricalHeldoutPhotoLocalization(
  candidate: ComparableEvaluation & { phase: 'heldout'; sourceQualified: boolean },
  control: ComparableEvaluation & { phase: 'heldout'; sourceQualified: boolean },
  rawFreeze: unknown,
) {
  const freeze = freezeSchema.parse(rawFreeze)
  const pins = freeze.manifests.map(({ sha256, cases }) => ({ sha256, cases }))
  if (
    candidate.profileId !== profile.value ||
    control.profileId !== 'deepseek-flash-no-image-photo-heldout-v1' ||
    candidate.phase !== 'heldout' ||
    control.phase !== 'heldout' ||
    !candidate.complete ||
    !control.complete ||
    !candidate.sourceQualified ||
    !control.sourceQualified ||
    candidate.coverage.planned !== 80 ||
    candidate.coverage.reported !== 80 ||
    control.coverage.planned !== 40 ||
    control.coverage.reported !== 40 ||
    candidate.rows.length !== 80 ||
    control.rows.length !== 40 ||
    !same(candidate.inputs, pins) ||
    !same(control.inputs, [pins[0]]) ||
    candidate.truthSha256.length !== 3 ||
    control.truthSha256.length !== 1 ||
    candidate.truthSha256[0] !== control.truthSha256[0]
  )
    throw new Error('Categorical HELDOUT pairing requires complete frozen candidate and control')
  const photos = candidate.rows.slice(0, 40)
  sameIds(
    photos.map((row) => row.caseId),
    control.rows.map((row) => row.caseId),
    'paired photo IDs',
  )
  const controls = new Map(control.rows.map((row) => [row.caseId, row]))
  for (const row of photos) {
    const other = controls.get(row.caseId)!
    if (row.imageSha256 !== other.imageSha256 || row.expectedPresence !== other.expectedPresence)
      throw new Error('Categorical HELDOUT paired image or independent truth mismatch')
  }
  for (const [rows, positives, negatives] of [
    [photos, 30, 10],
    [candidate.rows.slice(40, 60), 15, 5],
    [candidate.rows.slice(60), 15, 5],
  ] as const)
    if (
      rows.filter((row) => row.expectedPresence === 'present').length !== positives ||
      rows.filter((row) => row.expectedPresence === 'absent').length !== negatives
    )
      throw new Error('Categorical HELDOUT independent source strata mismatch')
  const positivePhotos = photos.filter((row) => row.expectedPresence === 'present')
  const bootstrap = pairedBootstrap(
    positivePhotos.map((row) => ({
      caseId: row.caseId,
      candidate: row.localizationCorrect,
      control: controls.get(row.caseId)!.localizationCorrect,
    })),
  )
  const falseLocations = candidate.rows
    .filter((row) => row.expectedPresence === 'absent' && row.sourceStatus === 'located')
    .map((row) => row.caseId)
  return {
    methodSelectionSha256: freeze.methodSelectionSha256,
    photoCases: 40,
    positivePairs: bootstrap.pairs,
    allGroupsNegativeCases: 20,
    candidateFalseLocationsAllGroups: falseLocations,
    maximumAllowedFalseLocationsAllGroups: 1,
    allGroupsNegativeGatePasses: falseLocations.length <= 1,
    bootstrap,
    denominator: 'all 30 positive photo pairs; transport failures and unknowns count as failures',
  }
}
