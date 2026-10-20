import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  evaluateCategoricalFreshRun,
  normalizeCategoricalFreshOutput,
} from '../benchmarks/v02/evaluate-categorical-fresh.js'
import { freshProposalInputPins } from '../benchmarks/v02/evaluate-proposals.js'
import { freshProducerTask, loadFreshCorpus } from '../benchmarks/v02/fresh-corpus.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'
import { categoricalFreshPolicy } from '../benchmarks/v02/categorical-presence-fresh-runner.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const signal = new AbortController().signal
const inputFiles = ['dev', 'dev-independent-ui', 'dev-independent-map'].map((part, index) => ({
  path: join(root, 'benchmarks/v02/corpus', part, 'inputs.json'),
  sha256: freshProposalInputPins[index]!.sha256,
}))
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

async function fixture(sourceClosure: 'legacy' | 'box' = 'legacy') {
  const corpus = await loadFreshCorpus({ manifests: inputFiles, imageRoot: root }, signal)
  const legacyRequired = [
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
  const boxRequired = [
    ...legacyRequired.slice(0, 2),
    './run-categorical-box-confirmation-dev.ts',
    ...legacyRequired.slice(2, 9),
    './categorical-heldout-plan.ts',
    './fresh-text-runner.ts',
    './run-categorical-heldout.ts',
    ...legacyRequired.slice(9),
  ]
  const required = sourceClosure === 'box' ? boxRequired : legacyRequired
  async function sourceFiles(directory: string): Promise<string[]> {
    const files: string[] = []
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
      else if (path.endsWith('.ts')) files.push(path)
    }
    return files
  }
  const sourceHashes = Object.fromEntries(
    [...required, ...(await sourceFiles('src'))].map((name) => [name, '1'.repeat(64)]),
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
    ...(sourceClosure === 'box' ? { nativeThreads: 2 } : {}),
    boxTolerancePx: 8,
    maxExtentPasses: 3,
    maxPhysicalCallsPerCase: 6,
    worstCaseCallsAcross40: 240,
    retries: 0,
    fallback: false,
    maxPhysicalCalls: 300,
    maxCostUsd: 5,
    unknownCostReserveUsd: 0.05,
    latencyEnvironment: 'concurrent-development-runner-unranked',
    latencyRankingEligible: false,
  }
  const manifest = {
    schemaVersion: 1,
    runId: 'fixture-categorical-dev40',
    profileId: 'native-luna-categorical-presence-sam-target-plus-neutral-v1',
    phase: 'dev',
    purpose: 'full fresh DEV photo, independent UI and independent map producer pass',
    startedAt: '2026-10-20T00:00:00.000Z',
    variantSha256: '2'.repeat(64),
    producerSourceSha256: sourceDigest,
    ...(sourceClosure === 'box' ? { sourceBeforeSha256: sourceDigest } : {}),
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
    phase: 'dev',
    targetPolicy: manifest.targetPolicy,
    variantSha256: manifest.variantSha256,
    producerSourceSha256: sourceDigest,
    ...(sourceClosure === 'box' ? { sourceBeforeSha256: sourceDigest } : {}),
    sourceAfterSha256: sourceDigest,
    sourceUnchanged: true,
    status: 'complete',
    plannedCaseIds: manifest.plannedCaseIds,
    completedCaseIds: manifest.plannedCaseIds,
    missingCaseIds: [] as string[],
    results: summaries,
    aggregate: {
      admittedPhysicalCalls: 40,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: 0,
      maxPhysicalCalls: 300,
      maxCostUsd: 5,
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
    expectedProducerSourceSha256: sourceDigest,
  }
  return { corpus, manifest, summary, commitments }
}

function convertToLegacyClosure(f: Awaited<ReturnType<typeof fixture>>) {
  f.manifest.sourceHashes = Object.fromEntries(
    Object.entries(f.manifest.sourceHashes).filter(
      ([path]) => path.startsWith('src/') || legacyRequiredSources.includes(path),
    ),
  )
  const sourceDigest = hashCanonical(
    Object.entries(f.manifest.sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
  )
  f.manifest.producerSourceSha256 = sourceDigest
  f.summary.producerSourceSha256 = sourceDigest
  f.summary.sourceAfterSha256 = sourceDigest
  f.commitments.expectedProducerSourceSha256 = sourceDigest
  return f
}

await test('categorical DEV normalization preserves legacy 64-source profiles and the separate 68-source box profile', async () => {
  for (const profile of [
    {
      id: 'native-luna-categorical-presence-sam-target-plus-neutral-v1',
      targetPolicy: 'target-plus-neutral-instruction-v1',
    },
    {
      id: 'native-luna-categorical-presence-sam-target-only-v1',
      targetPolicy: 'target-only-v1',
    },
  ]) {
    const f = convertToLegacyClosure(await fixture())
    const manifest = structuredClone(f.manifest),
      summary = structuredClone(f.summary)
    manifest.profileId = summary.profileId = profile.id
    manifest.targetPolicy = summary.targetPolicy = profile.targetPolicy
    const result = normalizeCategoricalFreshOutput(
      summary,
      manifest,
      f.corpus.cases,
      f.corpus.manifests,
      f.commitments,
    )
    assert.equal(result.results.length, 40)
    assert.equal(result.profileId, manifest.profileId)
    assert.equal(result.rawProposalProvenance.targetPolicy, manifest.targetPolicy)
    assert.equal(result.rawProposalProvenance.physicalCalls, 40)
  }
  const f = await fixture('box')
  f.manifest.profileId = f.summary.profileId =
    'native-luna-box-confirmation-sam-target-plus-neutral-v1'
  const boxResult = normalizeCategoricalFreshOutput(
    f.summary,
    f.manifest,
    f.corpus.cases,
    f.corpus.manifests,
    f.commitments,
  )
  assert.equal(boxResult.results.length, 40)
  assert.equal(boxResult.profileId, f.manifest.profileId)
})

await test('categorical DEV source closures cannot be relabeled across historical and box profiles', async () => {
  const legacyUnderNewId = convertToLegacyClosure(await fixture())
  legacyUnderNewId.manifest.profileId = legacyUnderNewId.summary.profileId =
    'native-luna-box-confirmation-sam-target-plus-neutral-v1'
  assert.throws(
    () =>
      normalizeCategoricalFreshOutput(
        legacyUnderNewId.summary,
        legacyUnderNewId.manifest,
        legacyUnderNewId.corpus.cases,
        legacyUnderNewId.corpus.manifests,
        legacyUnderNewId.commitments,
      ),
    /source mismatch/u,
  )

  const boxUnderLegacyId = await fixture('box')
  boxUnderLegacyId.manifest.profileId = boxUnderLegacyId.summary.profileId =
    'native-luna-categorical-presence-sam-target-plus-neutral-v1'
  assert.throws(
    () =>
      normalizeCategoricalFreshOutput(
        boxUnderLegacyId.summary,
        boxUnderLegacyId.manifest,
        boxUnderLegacyId.corpus.cases,
        boxUnderLegacyId.corpus.manifests,
        boxUnderLegacyId.commitments,
      ),
    /source mismatch/u,
  )
})

await test('box DEV validates actual before-source fields and explicit native thread metadata', async () => {
  const base = await fixture('box')
  base.manifest.profileId = base.summary.profileId =
    'native-luna-box-confirmation-sam-target-plus-neutral-v1'
  assert.deepEqual(base.manifest.policy, categoricalFreshPolicy)
  const normalize = (value: typeof base) =>
    normalizeCategoricalFreshOutput(
      value.summary,
      value.manifest,
      value.corpus.cases,
      value.corpus.manifests,
      value.commitments,
    )
  assert.equal(normalize(base).results.length, 40)
  const mutations: Array<(value: typeof base) => void> = [
    (value) => {
      delete value.manifest.sourceBeforeSha256
    },
    (value) => {
      value.summary.sourceBeforeSha256 = '0'.repeat(64)
    },
    (value) => {
      delete value.summary.sourceBeforeSha256
    },
    (value) => {
      delete value.manifest.policy.nativeThreads
    },
    (value) => {
      value.manifest.policy.nativeThreads = 1
    },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(base)
    mutate(value)
    assert.throws(() => normalize(value))
  }
})

await test('categorical evaluator rejects missing/duplicate cases, identity, task, policy and source drift', async () => {
  const f = await fixture()
  const mutations: Array<(value: Awaited<ReturnType<typeof fixture>>) => void> = [
    (v) => {
      v.summary.results.pop()
    },
    (v) => {
      v.summary.results[1] = structuredClone(v.summary.results[0]!)
    },
    (v) => {
      v.summary.profileId = 'native-mobile-sam-proposals-v1'
    },
    (v) => {
      v.manifest.phase = 'heldout'
    },
    (v) => {
      v.manifest.targetPolicy = 'target-only-v1'
    },
    (v) => {
      v.manifest.policy.timeoutMs = 45_000
    },
    (v) => {
      v.manifest.policy.latencyRankingEligible = true
    },
    (v) => {
      v.manifest.taskManifest[0]!.task.target = 'different object'
    },
    (v) => {
      v.manifest.mobileSam.encoder.sha256 = '0'.repeat(64)
    },
    (v) => {
      v.summary.sourceAfterSha256 = '0'.repeat(64)
    },
    (v) => {
      v.summary.sourceUnchanged = false
    },
    (v) => {
      v.commitments.expectedProducerSourceSha256 = '0'.repeat(64)
    },
    (v) => {
      v.summary.results[0]!.imageSha256 = '0'.repeat(64)
    },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(f)
    mutate(value)
    assert.throws(() =>
      normalizeCategoricalFreshOutput(
        value.summary,
        value.manifest,
        value.corpus.cases,
        value.corpus.manifests,
        value.commitments,
      ),
    )
  }
})

await test('categorical physical accounting reconciles wire-only and unknown cost without counting logical calls twice', async () => {
  const f = await fixture()
  const call = f.summary.physicalReceipts[0]!
  Object.assign(call, { receipt: null })
  call.wireReceipt.usageCostUsd = 0.002
  f.summary.aggregate.knownCostUsd = 0.002
  f.summary.aggregate.accountedExposureUsd = 0.002
  let result = normalizeCategoricalFreshOutput(
    f.summary,
    f.manifest,
    f.corpus.cases,
    f.corpus.manifests,
    f.commitments,
  )
  assert.equal(result.rawProposalProvenance.budget.unknownCostCalls, 0)
  Object.assign(call, { wireReceipt: null })
  f.summary.aggregate.knownCostUsd = 0
  f.summary.aggregate.unknownCostCalls = 1
  f.summary.aggregate.accountedExposureUsd = 0.05
  result = normalizeCategoricalFreshOutput(
    f.summary,
    f.manifest,
    f.corpus.cases,
    f.corpus.manifests,
    f.commitments,
  )
  assert.equal(result.rawProposalProvenance.budget.accountedExposureUsd, 0.05)
  f.summary.aggregate.accountedExposureUsd = 0
  assert.throws(
    () =>
      normalizeCategoricalFreshOutput(
        f.summary,
        f.manifest,
        f.corpus.cases,
        f.corpus.manifests,
        f.commitments,
      ),
    /receipt costs/u,
  )
})

await test('categorical evaluator rejects duplicated physical IDs, foreign cases, missing hashes and contradictory costs', async () => {
  const f = await fixture()
  const mutations: Array<(value: Awaited<ReturnType<typeof fixture>>) => void> = [
    (v) => {
      v.summary.physicalReceipts[1]!.physicalId = 1
    },
    (v) => {
      v.summary.physicalReceipts[0]!.caseId = 'foreign-case'
    },
    (v) => {
      v.summary.physicalReceipts[0]!.requestSha256 = '0'.repeat(64)
    },
    (v) => {
      v.summary.results[0]!.classify.logicalCalls = 2
    },
    (v) => {
      v.summary.physicalReceipts[0]!.wireReceipt.usageCostUsd = 0.1
    },
    (v) => {
      v.summary.aggregate.inFlightCalls = 1
    },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(f)
    mutate(value)
    assert.throws(() =>
      normalizeCategoricalFreshOutput(
        value.summary,
        value.manifest,
        value.corpus.cases,
        value.corpus.manifests,
        value.commitments,
      ),
    )
  }
})

await test('file-backed categorical evaluation preserves unknown denominators and exact hashes without image/provider access', async () => {
  const f = await fixture()
  const directory = await mkdtemp(join(tmpdir(), 'zorya-categorical-evaluation-'))
  async function pinned(name: string, value: unknown) {
    const path = join(directory, name),
      body = JSON.stringify(value) + '\n'
    await writeFile(path, body, { flag: 'wx' })
    return { path, sha256: createHash('sha256').update(body).digest('hex') }
  }
  try {
    const rawSummary = await pinned('summary.json', f.summary),
      runManifest = await pinned('manifest.json', f.manifest)
    // Authored offline truth tests accounting only. It is never real-model quality evidence.
    const truths = []
    let offset = 0
    for (const [index, count] of [20, 10, 10].entries()) {
      truths.push(
        await pinned(
          `truth-${index}.json`,
          f.corpus.cases.slice(offset, offset + count).map((item) => ({
            caseId: item.caseId,
            expectedPresence: 'absent',
            targetBoxes: [],
            negativeEvidence: { type: 'offline-authored-fixture' },
          })),
        ),
      )
      offset += count
    }
    const output = join(directory, 'evaluated.json')
    const evaluated = await evaluateCategoricalFreshRun(
      {
        rawSummary,
        runManifest,
        expectedProducerSourceSha256: f.commitments.expectedProducerSourceSha256,
        corpus: { manifests: inputFiles, imageRoot: directory },
        truths,
        derivedSummary: join(directory, 'derived.json'),
        output,
        provenanceOutput: join(directory, 'provenance.json'),
      },
      signal,
    )
    assert.equal(evaluated.profileId, f.manifest.profileId)
    assert.equal(evaluated.provenance.physicalCalls, 40)
    assert.equal(evaluated.proposalMaskMetrics.unannotatedCases, 40)
    assert.equal(evaluated.latencyRankingEligible, false)
    assert.equal(
      evaluated.provenance.evaluationSha256,
      createHash('sha256')
        .update(await readFile(output))
        .digest('hex'),
    )
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith('.tmp')),
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('categorical evaluator validates produced box/mask geometry and source-sized native metadata', async () => {
  const f = await fixture()
  const image = f.corpus.cases[0]!.image
  const native = {
    method: 'mobile-sam-nine-point-proposals-v1',
    backend: 'mobile-sam',
    durationMs: 1,
    input: { width: image.width, height: image.height },
    candidateCount: 36,
  }
  Object.assign(f.summary.results[0]!.locate, {
    status: 'located',
    region: { left: 0, top: 0, width: 2, height: 2 },
    nativeProposal: native,
  })
  Object.assign(f.summary.results[0]!.extract, {
    status: 'extracted',
    nativeProposal: native,
    segmentation: {
      method: native.method,
      backend: native.backend,
      durationMs: 1,
      input: native.input,
      qualityScore: -12,
    },
    mask: {
      file: 'mask.u8',
      sha256: '5'.repeat(64),
      format: 'binary-u8',
      width: 2,
      height: 2,
      sourceRegion: { left: 0, top: 0, width: 2, height: 2 },
      sourceOffset: { x: 0, y: 0 },
      pngFile: 'cutout.png',
      pngSha256: '6'.repeat(64),
    },
  })
  assert.doesNotThrow(() =>
    normalizeCategoricalFreshOutput(
      f.summary,
      f.manifest,
      f.corpus.cases,
      f.corpus.manifests,
      f.commitments,
    ),
  )
  const wrongNative = structuredClone(f)
  Object.assign(wrongNative.summary.results[0]!.locate, {
    nativeProposal: { ...native, input: { width: image.width + 1, height: image.height } },
  })
  assert.throws(
    () =>
      normalizeCategoricalFreshOutput(
        wrongNative.summary,
        wrongNative.manifest,
        wrongNative.corpus.cases,
        wrongNative.corpus.manifests,
        wrongNative.commitments,
      ),
    /escaped its source/u,
  )
  const escaped = structuredClone(f)
  Object.assign(escaped.summary.results[0]!.extract, {
    mask: {
      file: 'mask.u8',
      sha256: '5'.repeat(64),
      format: 'binary-u8',
      width: 2,
      height: 2,
      sourceRegion: { left: image.width - 1, top: 0, width: 2, height: 2 },
      sourceOffset: { x: image.width - 1, y: 0 },
      pngFile: 'cutout.png',
      pngSha256: '6'.repeat(64),
    },
  })
  assert.throws(
    () =>
      normalizeCategoricalFreshOutput(
        escaped.summary,
        escaped.manifest,
        escaped.corpus.cases,
        escaped.corpus.manifests,
        escaped.commitments,
      ),
    /escaped its source/u,
  )
})

await test('prefetch validation failures retain logical evidence without inventing physical calls or charges', async () => {
  const f = await fixture()
  const row = f.summary.results[0]!
  Object.assign(row.locate, {
    status: 'failed',
    errorCode: 'INVALID_INPUT',
    logicalCalls: 1,
    physicalCalls: 0,
    requestHashes: [hashCanonical('prefetch-rejected-request')],
  })
  Object.assign(row.extract, { status: 'failed', errorCode: 'INVALID_INPUT' })
  const result = normalizeCategoricalFreshOutput(
    f.summary,
    f.manifest,
    f.corpus.cases,
    f.corpus.manifests,
    f.commitments,
  )
  assert.equal(result.rawProposalProvenance.physicalCalls, 40)
  assert.equal(result.results[0]!.locate.calls, 0)
  assert.equal(result.results[0]!.locate.status, 'failed')
  assert.equal(result.results[0]!.locate.requestHashes.length, 1)
  assert.equal(result.rawProposalProvenance.budget.knownCostUsd, 0)
})
