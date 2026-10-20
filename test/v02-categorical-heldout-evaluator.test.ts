import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareCategoricalHeldoutPhotoLocalization,
  evaluateCategoricalHeldoutRun,
  normalizeCategoricalHeldoutOutput,
} from '../benchmarks/v02/evaluate-categorical-heldout.js'
import { freshProducerTask } from '../benchmarks/v02/fresh-corpus.js'
import type { FreshCase } from '../benchmarks/v02/fresh-corpus.js'
import {
  evaluateCategoricalNoImageHeldoutRun,
  normalizeCategoricalNoImageControlOutput,
} from '../benchmarks/v02/evaluate-no-image-heldout.js'
import { promptVariants } from '../benchmarks/v02/promptvariants.js'
import { textTransportVariants } from '../benchmarks/v02/transportvariants.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'
import { historicalRuntimeSourcePaths } from './fixtures/historical-runtime-sources.js'

async function fixture() {
  const cases: FreshCase[] = Array.from({ length: 80 }, (_, index) => ({
    caseId: `${index < 40 ? 'photo' : index < 60 ? 'ui' : 'map'}-synthetic-${index}`,
    image: {
      path: `fixture-${index}.png`,
      sha256: hashCanonical(['fixture-image', index]),
      width: 128,
      height: 128,
    },
    locate: { target: 'the requested fixture object' },
    classify: { options: ['present', 'absent'] },
  }))
  const pins = [
    {
      group: 'photo',
      cases: 40,
      sha256: '5d125e853ed93558ab634e406ca90cf931569953279c1630d49dcf239b9baa79',
    },
    {
      group: 'ui',
      cases: 20,
      sha256: '1bf7940fd92fdc1f7fa295296dfc5f84c5f4c32ccc41b7a2e80a0059bff918c3',
    },
    { group: 'map', cases: 20, sha256: hashCanonical('fixture map pin') },
  ]
  const corpus = { cases, manifests: pins.map(({ sha256, cases }) => ({ sha256, cases })) }
  const required = [
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
  const sourceHashes = Object.fromEntries(
    [...required, ...(await historicalRuntimeSourcePaths())].map((name) => [name, '1'.repeat(64)]),
  )
  const sourceDigest = hashCanonical(
    Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
  )
  const route = {
    id: 'openai-gpt-6-luna-decisions-openai-v1',
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/alpha/decisions',
    allowFallbacks: false,
  }
  const policy = {
    timeoutMs: 120_000,
    maxInFlight: 2,
    maxInFlightCases: 2,
    nativeMaxActive: 1,
    nativeMaxWaiting: 2,
    nativeThreads: 2,
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    maxPhysicalCallsPerCase: 6,
    expectedCaseCount: 80,
    worstCasePhysicalCalls: 480,
    retries: 0,
    fallback: false,
    maxPhysicalCalls: 600,
    maxCostUsd: 10,
    unknownCostReserveUsd: 0.05,
    latencyEnvironment: 'heldout-development-soak-unranked',
    latencyRankingEligible: false,
  }
  const methodDigest = 'fabb05c2c472c30a8cb20a5f9b6d697b932d94aedc43976359746463ef8708b9'
  const manifest = {
    schemaVersion: 1,
    runId: 'fixture-categorical-heldout80',
    profileId: 'native-luna-categorical-presence-sam-heldout-target-plus-neutral-v1',
    phase: 'heldout',
    purpose: 'full frozen HELDOUT photo, independent UI and independent map producer pass',
    startedAt: '2026-10-20T00:00:00.000Z',
    variantSha256: '2'.repeat(64),
    producerSourceSha256: sourceDigest,
    sourceBeforeSha256: sourceDigest,
    methodSelectionSha256: methodDigest,
    heldoutInputManifests: pins,
    sourceHashes,
    manifests: corpus.manifests,
    plannedCaseIds: corpus.cases.map((item) => item.caseId),
    plannedCases: corpus.cases.map((item) => ({
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      imageDimensions: { width: item.image.width, height: item.image.height },
    })),
    route,
    mobileSam: {
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
    },
    policy,
    targetPolicy: 'target-plus-neutral-instruction-v1',
    classification: {
      questionSource: 'freshProducerTask.question',
      instructionSuffix: 'Use only the supplied image. Choose exactly one closed label.',
      classes: [
        { id: 'present', description: 'The target in the question is visible in this image.' },
        { id: 'absent', description: 'The target in the question is not visible in this image.' },
      ],
    },
    taskManifest: corpus.cases.map((item) => ({
      caseId: item.caseId,
      task: freshProducerTask(item),
    })),
    modelBoundary: {
      evaluatorTruthRead: false,
      groundTruthInProducer: false,
      retries: 0,
      fallback: false,
    },
  }
  const summaries = corpus.cases.map((item, index) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    classify: {
      status: 'ok',
      value: 'present',
      durationMs: 1,
      physicalCalls: 1,
      logicalCalls: 1,
      requestHashes: [hashCanonical(index)],
    },
    locate: {
      status: 'unknown',
      reason: 'extent-uncertain',
      durationMs: 1,
      physicalCalls: 0,
      logicalCalls: 0,
      requestHashes: [] as string[],
    },
    extract: { status: 'unknown', reason: 'extent-uncertain', durationMs: 1 },
  }))
  const summary = {
    runId: manifest.runId,
    profileId: manifest.profileId,
    phase: 'heldout',
    purpose: manifest.purpose,
    targetPolicy: manifest.targetPolicy,
    variantSha256: manifest.variantSha256,
    producerSourceSha256: sourceDigest,
    sourceBeforeSha256: sourceDigest,
    methodSelectionSha256: methodDigest,
    heldoutInputManifests: pins,
    sourceAfterSha256: sourceDigest,
    sourceUnchanged: true,
    status: 'complete',
    plannedCaseIds: manifest.plannedCaseIds,
    completedCaseIds: manifest.plannedCaseIds,
    missingCaseIds: [] as string[],
    results: summaries,
    aggregate: {
      admittedPhysicalCalls: 80,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: 0,
      maxPhysicalCalls: 600,
      maxCostUsd: 10,
    },
    latencyEnvironment: policy.latencyEnvironment,
    latencyRankingEligible: false,
    initializationError: null,
    shutdownError: null,
    settleError: null,
    disposeError: null,
    physicalReceipts: corpus.cases.map((item, index) => ({
      caseId: item.caseId,
      physicalId: index + 1,
      logicalId: 1,
      requestSha256: hashCanonical(index),
      requestBodySha256: hashCanonical(['wire', index]),
      admittedAt: '2026-10-20T00:00:01.000Z',
      durationMs: 1,
      httpStatus: 200,
      route,
      receipt: {
        model: route.model,
        provider: route.providerName,
        requestId: 'fixture',
        costUsd: 0,
        durationMs: 1,
        attempts: 1,
      },
      wireReceipt: {
        responseModel: route.model,
        responseProvider: route.providerName,
        responseId: 'fixture',
        usageCostUsd: 0,
        errorType: null,
        errorCode: null,
        errorParameter: null,
        errorCategory: null,
        errorReason: null,
        rateLimitScope: null,
        retryAfterSeconds: null,
        responseDisposition: 'typed-decisions-response',
        finishReason: null,
        bodyRead: 'parsed',
      },
      errorCode: null,
    })),
  }
  const commitments = {
    summarySha256: '3'.repeat(64),
    runManifestSha256: '4'.repeat(64),
    freezeSha256: hashCanonical('fixture freeze bytes'),
    freeze: {
      schema: 'categorical-heldout-run-freeze-v1',
      phase: 'heldout',
      targetPolicy: 'target-plus-neutral-instruction-v1',
      methodSelectionSha256: methodDigest,
      manifests: pins,
      producerSourceSha256: sourceDigest,
      noImageProducerSourceSha256: '5'.repeat(64),
      candidateBudget: { maxPhysicalCalls: 600, maxCostUsd: 10, unknownCostReserveUsd: 0.05 },
      noImageBudget: { maxPhysicalCalls: 300, maxCostUsd: 5, unknownCostReserveUsd: 0.05 },
    },
  }
  return { corpus, manifest, summary, commitments }
}

function normalize(f: Awaited<ReturnType<typeof fixture>>) {
  return normalizeCategoricalHeldoutOutput(
    f.summary,
    f.manifest,
    f.corpus.cases,
    f.corpus.manifests,
    f.commitments,
  )
}

await test('HELDOUT normalizer preserves its own profile, all 80 cases and unknown charges', async () => {
  const f = await fixture()
  f.summary.physicalReceipts[0]!.receipt.costUsd = 0.01
  f.summary.physicalReceipts[0]!.wireReceipt.usageCostUsd = 0.01
  Object.assign(f.summary.physicalReceipts[1]!.receipt, { costUsd: null })
  Object.assign(f.summary.physicalReceipts[1]!.wireReceipt, { usageCostUsd: null })
  f.summary.aggregate.unknownCostCalls = 1
  f.summary.aggregate.knownCostUsd = 0.01
  f.summary.aggregate.accountedExposureUsd = 0.06
  const output = normalize(f)
  assert.equal(output.phase, 'heldout')
  assert.equal(output.profileId, f.manifest.profileId)
  assert.equal(output.results.length, 80)
  assert.equal(output.rawProposalProvenance.budget.knownCostUsd, 0.01)
  assert.equal(output.rawProposalProvenance.methodSelectionSha256, f.manifest.methodSelectionSha256)
})

await test('HELDOUT rejects DEV relabeling, deadline drift and source freeze mismatch', async () => {
  const original = await fixture()
  const mutations: Array<(f: typeof original) => void> = [
    (f) => {
      f.manifest.phase = 'dev'
    },
    (f) => {
      f.summary.profileId = 'native-luna-categorical-presence-sam-target-only-v1'
    },
    (f) => {
      f.manifest.policy.timeoutMs = 45_000
    },
    (f) => {
      f.manifest.policy.nativeMaxWaiting = 0
    },
    (f) => {
      f.manifest.policy.nativeThreads = 1
    },
    (f) => {
      f.summary.sourceAfterSha256 = '0'.repeat(64)
    },
    (f) => {
      f.commitments.freeze.producerSourceSha256 = '0'.repeat(64)
    },
    (f) => {
      f.manifest.methodSelectionSha256 = '0'.repeat(64)
    },
    (f) => {
      f.commitments.freeze.manifests[0]!.sha256 = '0'.repeat(64)
    },
  ]
  for (const mutate of mutations) {
    const f = structuredClone(original)
    mutate(f)
    assert.throws(() => normalize(f))
  }
})

await test('HELDOUT rejects dropped rows, duplicated receipts, wrong images, tasks and boxes', async () => {
  const original = await fixture()
  for (const mutate of [
    (f: typeof original) => {
      f.summary.results.pop()
    },
    (f: typeof original) => {
      f.summary.results[1]!.caseId = f.summary.results[0]!.caseId
    },
    (f: typeof original) => {
      f.summary.physicalReceipts[1]!.physicalId = 1
    },
    (f: typeof original) => {
      f.summary.physicalReceipts[1]!.requestSha256 = '0'.repeat(64)
    },
    (f: typeof original) => {
      f.summary.results[1]!.imageSha256 = '0'.repeat(64)
    },
    (f: typeof original) => {
      f.manifest.taskManifest[1]!.task.target = 'another object'
    },
    (f: typeof original) => {
      f.summary.aggregate.knownCostUsd = 1
    },
    (f: typeof original) => {
      Object.assign(f.summary.results[0]!.locate, {
        status: 'located',
        region: { left: 127, top: 0, width: 3, height: 3 },
      })
    },
    (f: typeof original) => {
      Object.assign(f.summary.results[0]!.locate, {
        status: 'located',
        region: { left: 1.5, top: 0, width: 3, height: 3 },
      })
    },
  ]) {
    const f = structuredClone(original)
    mutate(f)
    assert.throws(() => normalize(f))
  }
})

await test('HELDOUT retains logical prefetch errors with no fabricated physical request', async () => {
  const f = await fixture()
  const row = f.summary.results[0]!
  row.locate.status = 'failed'
  row.locate.logicalCalls = 1
  row.locate.requestHashes.push(hashCanonical('prefetch failure'))
  Object.assign(row.locate, { errorCode: 'INVALID_INPUT' })
  const output = normalize(f)
  assert.equal(output.results[0]!.locate.calls, 0)
  assert.equal(output.results[0]!.locate.errorCode, 'INVALID_INPUT')
  assert.equal(output.rawProposalProvenance.physicalCalls, 80)
})

await test('HELDOUT file-backed evaluator aborts before touching any artifact', async () => {
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    evaluateCategoricalHeldoutRun(
      {
        rawSummary: { path: 'missing-summary', sha256: '0'.repeat(64) },
        runManifest: { path: 'missing-manifest', sha256: '0'.repeat(64) },
        freeze: { path: 'missing-freeze', sha256: '0'.repeat(64) },
        corpus: { manifests: [], imageRoot: 'missing-images' },
        truths: [],
        derivedSummary: 'missing-derived',
        output: 'missing-output',
        provenanceOutput: 'missing-provenance',
      },
      abort.signal,
    ),
    { code: 'ABORTED' },
  )
})

async function controlFixture() {
  const candidate = await fixture()
  const cases = candidate.corpus.cases.slice(0, 40)
  const required = [
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
  const sourceHashes = Object.fromEntries([
    ...Object.entries(candidate.manifest.sourceHashes).filter(([k]) => k.startsWith('src/')),
    ...required.map((k) => [k, '1'.repeat(64)] as const),
  ])
  const source = hashCanonical(Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)))
  const identity = {
    runId: 'fixture-no-image-heldout',
    profileId: 'deepseek-flash-no-image-photo-heldout-v1',
    phase: 'heldout',
    purpose: 'full frozen HELDOUT photo-only no-image text control run',
    targetPolicy: 'target-plus-neutral-instruction-v1',
    methodSelectionSha256: candidate.manifest.methodSelectionSha256,
    variantSha256: hashCanonical('fixture control variant'),
    producerSourceSha256: source,
    sourceBeforeSha256: source,
  }
  const route = {
    id: 'together-deepseek-flash-text-v1',
    model: 'deepseek/deepseek-v4.1-flash',
    provider: 'together',
    providerName: 'Together',
    apiEndpoint: '/api/v1/chat/completions',
    allowFallbacks: false,
  }
  const policy = {
    timeoutMs: 120000,
    concurrency: 1,
    maxQueue: 0,
    maxInFlight: 1,
    maxInFlightCases: 1,
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    retries: 0,
    fallback: false,
    maxPhysicalCalls: 300,
    maxCostUsd: 5,
    unknownCostReserveUsd: 0.05,
    classifyMaxOutputTokens: 1024,
    locateMaxOutputTokens: 4096,
    maxPhysicalCallsPerCase: 6,
    worstCasePhysicalCalls: 240,
    latencyEnvironment: 'heldout-no-image-control-unranked',
    latencyRankingEligible: false,
  }
  const prompt = promptVariants['grammar-plus-examples']
  const transport = textTransportVariants['none-json-schema']
  const manifest = {
    ...identity,
    schemaVersion: 1,
    startedAt: candidate.manifest.startedAt,
    stages: 'classify-and-locate',
    sourceHashes,
    heldoutProducerSourceSha256: candidate.manifest.producerSourceSha256,
    producerSourceRole: 'producer-only',
    manifests: [candidate.corpus.manifests[0]!],
    plannedCaseIds: cases.map((c) => c.caseId),
    plannedCases: candidate.manifest.plannedCases.slice(0, 40),
    route,
    policy,
    prompt,
    promptSha256: hashCanonical(prompt),
    transport,
    transportSha256: hashCanonical(transport),
    routePolicy: {
      responseFormat: 'json-schema',
      reasoningEffort: 'none',
      promptVariant: 'grammar-plus-examples',
      transportVariant: 'none-json-schema',
      imagePartsRemoved: true,
      textEncoder: null,
      objectProposals: null,
      segmentation: false,
      ocr: false,
    },
    modelBoundary: {
      evaluatorTruthRead: false,
      retries: 0,
      fallback: false,
      imagePartsRemoved: true,
      textEncoder: null,
      segmentation: false,
      ocr: false,
    },
    imagePartAudit: {
      method: 'inspect-every-serialized-provider-request-before-fetch-v1',
      expectedImageParts: 0,
      expectedEncodedImageState: false,
      rawBodiesPersisted: false,
    },
  }
  const summary = {
    ...identity,
    sourceAfterSha256: source,
    sourceUnchanged: true,
    status: 'complete',
    plannedCaseIds: manifest.plannedCaseIds,
    completedCaseIds: manifest.plannedCaseIds,
    missingCaseIds: [],
    failure: null,
    results: candidate.summary.results.slice(0, 40).map((c) => ({
      caseId: c.caseId,
      imageSha256: c.imageSha256,
      profileId: identity.profileId,
      classify: {
        status: 'ok',
        value: 'present',
        durationMs: 1,
        calls: 1,
        requestHashes: c.classify.requestHashes,
      },
      locate: {
        status: 'unknown',
        reason: 'no-image-evidence',
        durationMs: 1,
        calls: 0,
        requestHashes: [],
      },
    })),
    aggregate: {
      admittedPhysicalCalls: 40,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: 0,
      maxPhysicalCalls: 300,
      maxCostUsd: 5,
    },
    policy,
    latencyEnvironment: policy.latencyEnvironment,
    latencyRankingEligible: false,
    physicalReceipts: candidate.summary.physicalReceipts.slice(0, 40).map((c) => ({
      ...c,
      route,
      stage: 'classify',
      receipt: { ...c.receipt, model: route.model, provider: 'Together' },
      wireReceipt: { ...c.wireReceipt, responseModel: route.model, responseProvider: 'Together' },
    })),
    imagePartAudit: {
      fetchAttempts: 40,
      fetchesChecked: 40,
      zeroImagePartsConfirmed: 40,
      zeroImageDerivedStateConfirmed: 40,
      imagePartViolations: 0,
      unverifiableBodies: 0,
      complete: true,
    },
  }
  const commitments = {
    expectedProducerSourceSha256: source,
    expectedCandidateSourceSha256: candidate.manifest.producerSourceSha256,
    expectedPromptSha256: manifest.promptSha256,
    summarySha256: '3'.repeat(64),
    runManifestSha256: '4'.repeat(64),
    freezeSha256: '5'.repeat(64),
  }
  return { cases, manifest, summary, commitments }
}

await test('HELDOUT no-image control requires actual-fetch zero-image audit and separate source identity', async () => {
  const f = await controlFixture()
  const normalize = () =>
    normalizeCategoricalNoImageControlOutput(f.summary, f.manifest, f.cases, f.commitments)
  assert.equal(normalize().results.length, 40)
  f.summary.imagePartAudit.fetchesChecked = 39
  assert.throws(normalize, /audit mismatch/u)
  f.summary.imagePartAudit.fetchesChecked = 40
  f.commitments.expectedCandidateSourceSha256 = '0'.repeat(64)
  assert.throws(normalize, /source/u)
})

await test('HELDOUT no-image control rejects image payload policy, altered prompt and lost receipts', async () => {
  const original = await controlFixture()
  for (const mutate of [
    (f: typeof original) => {
      f.manifest.modelBoundary.imagePartsRemoved = false
    },
    (f: typeof original) => {
      f.summary.physicalReceipts.pop()
    },
    (f: typeof original) => {
      f.manifest.promptSha256 = '0'.repeat(64)
    },
    (f: typeof original) => {
      f.summary.physicalReceipts[0]!.stage = 'locate'
    },
    (f: typeof original) => {
      f.summary.physicalReceipts[0]!.requestBodySha256 = 'wrong'
    },
    (f: typeof original) => {
      f.summary.aggregate.knownCostUsd = 1
    },
  ]) {
    const f = structuredClone(original)
    mutate(f)
    assert.throws(() =>
      normalizeCategoricalNoImageControlOutput(f.summary, f.manifest, f.cases, f.commitments),
    )
  }
})

await test('HELDOUT paired comparison keeps all failures, rejects mismatched pairs and preserves negative gate', async () => {
  const f = await fixture()
  const rows = f.corpus.cases.map((c, index) => ({
    caseId: c.caseId,
    imageSha256: c.image.sha256,
    expectedPresence:
      index < 30 || (index >= 40 && index < 55) || (index >= 60 && index < 75)
        ? ('present' as const)
        : ('absent' as const),
    sourceStatus: 'unknown',
    classificationCorrect: false,
    localizationCorrect: index < 6,
  }))
  const candidate = {
    profileId: f.manifest.profileId,
    phase: 'heldout' as const,
    complete: true,
    sourceQualified: true,
    coverage: { planned: 80, reported: 80, missing: [], denominatorPolicy: 'all planned' },
    inputs: f.corpus.manifests,
    truthSha256: ['0'.repeat(64), '1'.repeat(64), '2'.repeat(64)],
    rows,
  }
  const control = {
    ...candidate,
    profileId: 'deepseek-flash-no-image-photo-heldout-v1',
    coverage: { ...candidate.coverage, planned: 40, reported: 40 },
    inputs: [f.corpus.manifests[0]!],
    truthSha256: [candidate.truthSha256[0]!],
    rows: rows.slice(0, 40).map((r) => ({ ...r, localizationCorrect: false })),
  }
  const result = compareCategoricalHeldoutPhotoLocalization(
    candidate,
    control,
    f.commitments.freeze,
  )
  assert.equal(result.bootstrap.pairs, 30)
  assert.equal(result.bootstrap.iterations, 10000)
  assert.equal(result.bootstrap.passes, true)
  assert.equal(result.allGroupsNegativeGatePasses, true)
  candidate.rows[30]!.sourceStatus = 'located'
  candidate.rows[31]!.sourceStatus = 'located'
  assert.equal(
    compareCategoricalHeldoutPhotoLocalization(candidate, control, f.commitments.freeze)
      .allGroupsNegativeGatePasses,
    false,
  )
  control.rows[0]!.imageSha256 = 'f'.repeat(64)
  assert.throws(
    () => compareCategoricalHeldoutPhotoLocalization(candidate, control, f.commitments.freeze),
    /image/u,
  )
})

await test('HELDOUT control file evaluator aborts before opening private artifacts', async () => {
  const abort = new AbortController()
  abort.abort()
  const file = { path: 'must-not-open', sha256: '0'.repeat(64) }
  await assert.rejects(
    evaluateCategoricalNoImageHeldoutRun(
      {
        rawSummary: file,
        runManifest: file,
        freeze: file,
        expectedPromptSha256: '0'.repeat(64),
        corpus: { manifests: [file], imageRoot: 'must-not-open' },
        truths: [file],
        derivedSummary: 'must-not-create',
        output: 'must-not-create',
        provenanceOutput: 'must-not-create',
      },
      abort.signal,
    ),
    { code: 'ABORTED' },
  )
})
