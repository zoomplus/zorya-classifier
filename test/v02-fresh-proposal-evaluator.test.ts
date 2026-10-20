import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import sharp from 'sharp'
import {
  evaluateFreshProposalRun,
  freshProposalInputPins,
  normalizeFreshProposalOutput,
} from '../benchmarks/v02/evaluate-proposals.js'
import { freshProducerTask, loadFreshCorpus } from '../benchmarks/v02/fresh-corpus.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'

const signal = new AbortController().signal
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const inputPaths = [
  join(root, 'benchmarks/v02/corpus/dev/inputs.json'),
  join(root, 'benchmarks/v02/corpus/dev-independent-ui/inputs.json'),
  join(root, 'benchmarks/v02/corpus/dev-independent-map/inputs.json'),
]
const route = {
  id: 'openai-gpt-6-luna-decisions-openai-v1',
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
} as const

async function writePinned(path: string, bytes: Uint8Array) {
  await writeFile(path, bytes, { flag: 'wx' })
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-proposal-eval-'))
  const manifests = []
  for (let index = 0; index < inputPaths.length; index++) {
    const bytes = await readFile(inputPaths[index]!)
    manifests.push(await writePinned(join(directory, `input-${index}.json`), bytes))
  }
  const corpus = await loadFreshCorpus({ manifests, imageRoot: directory }, signal)
  assert.deepEqual(corpus.manifests, freshProposalInputPins)
  const cases = corpus.cases
  const proposalMask = Buffer.alloc(20 * 20)
  for (let y = 4; y < 13; y++) for (let x = 6; x < 15; x++) proposalMask[y * 20 + x] = 1
  const proposalPng = await sharp(proposalMask, { raw: { width: 20, height: 20, channels: 1 } })
    .png()
    .toBuffer()
  const referencePixels = Buffer.alloc(cases[2]!.image.width * cases[2]!.image.height)
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      referencePixels[(y + 12) * cases[2]!.image.width + x + 12] = proposalMask[y * 20 + x]
        ? 255
        : 0
    }
  }
  const referencePng = await sharp(referencePixels, {
    raw: { width: cases[2]!.image.width, height: cases[2]!.image.height, channels: 1 },
  })
    .png()
    .toBuffer()
  const referencePath = join(directory, 'reference-mask.png')
  await writeFile(referencePath, referencePng, { flag: 'wx' })
  const sourceHashes = Object.fromEntries(
    [
      './fresh-proposal-runner.ts',
      './run-fresh-proposals.ts',
      './fresh-corpus.ts',
      './recording.ts',
      './budget.ts',
      './protocol.ts',
      '../../package.json',
      '../../package-lock.json',
      'src/app/create-classifier.ts',
    ].map((key) => [key, '1'.repeat(64)]),
  )
  const tasks = cases.map((item) => ({ caseId: item.caseId, task: freshProducerTask(item) }))
  const runManifest = {
    schemaVersion: 1,
    runId: 'fixture-proposal-run',
    profileId: 'native-mobile-sam-proposals-v1',
    purpose: 'full fresh DEV photo, independent UI and independent map producer pass',
    startedAt: '2026-10-20T00:00:00.000Z',
    variantSha256: '2'.repeat(64),
    producerSourceSha256: hashCanonical(
      Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sourceHashes,
    manifests: corpus.manifests,
    plannedCaseIds: cases.map((item) => item.caseId),
    plannedCases: cases.map((item) => ({
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      imageDimensions: { width: item.image.width, height: item.image.height },
    })),
    route,
    mobileSam: {
      method: 'mobile-sam-nine-point-proposals-v1',
      executionProvider: 'cpu',
      encoder: {
        bytes: 28157093,
        sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
      },
      decoder: {
        bytes: 16496559,
        sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
      },
    },
    policy: {
      timeoutMs: 45000,
      concurrency: 1,
      maxQueue: 0,
      boxTolerancePx: 8,
      maxExtentPasses: 3,
      retries: 0,
      fallback: false,
      maxPhysicalCalls: 300,
      maxCostUsd: 5,
      unknownCostReserveUsd: 0.02,
      latencyEnvironment: 'single-development-runner-without-owned-native-stress',
      latencyRankingEligible: true,
    },
    classification: {
      questionSource: 'freshProducerTask.question',
      instructionSuffix: 'Use only the supplied image. Choose exactly one closed label.',
      classes: [
        { id: 'present', description: 'The target in the question is visible in this image.' },
        { id: 'absent', description: 'The target in the question is not visible in this image.' },
      ],
    },
    taskManifest: tasks,
    modelBoundary: {
      evaluatorTruthRead: false,
      groundTruthInProducer: false,
      retries: 0,
      fallback: false,
    },
  }
  const physicalRequestHash = '5'.repeat(64)
  const oneReceipt = {
    physicalId: 1,
    logicalId: 1,
    requestSha256: physicalRequestHash,
    requestBodySha256: '6'.repeat(64),
    admittedAt: '2026-10-20T00:00:01.000Z',
    durationMs: 1,
    httpStatus: 200,
    route,
    receipt: {
      model: route.model,
      provider: route.provider,
      requestId: 'fixture-request',
      costUsd: 0,
      durationMs: 1,
      attempts: 1,
    },
    wireReceipt: {
      responseModel: route.model,
      responseProvider: route.provider,
      responseId: 'fixture-response',
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
  }
  const summary = {
    runId: runManifest.runId,
    profileId: runManifest.profileId,
    variantSha256: runManifest.variantSha256,
    status: 'complete' as const,
    plannedCaseIds: cases.map((item) => item.caseId),
    completedCaseIds: cases.map((item) => item.caseId),
    missingCaseIds: [] as string[],
    results: cases.map((item, index) => ({
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      classify:
        index === 1
          ? {
              status: 'failed' as const,
              durationMs: 1,
              physicalCalls: 0,
              logicalCalls: 0,
              requestHashes: [],
              errorCode: 'PROVIDER',
            }
          : {
              status: 'ok' as const,
              value: 'present' as const,
              durationMs: 1,
              physicalCalls: index === 0 ? 1 : 0,
              logicalCalls: index === 0 ? 1 : 0,
              requestHashes: index === 0 ? [physicalRequestHash] : [],
            },
      locate:
        index === 1
          ? {
              status: 'failed' as const,
              durationMs: 1,
              physicalCalls: 0,
              logicalCalls: 0,
              requestHashes: [],
              errorCode: 'PROVIDER',
            }
          : index === 2
            ? {
                status: 'located' as const,
                region: { left: 12, top: 12, width: 20, height: 20 },
                durationMs: 1,
                physicalCalls: 0,
                logicalCalls: 0,
                requestHashes: [],
              }
            : {
                status: 'unknown' as const,
                reason: 'extent-uncertain',
                durationMs: 1,
                physicalCalls: 0,
                logicalCalls: 0,
                requestHashes: [],
              },
      extract:
        index === 2
          ? {
              status: 'extracted' as const,
              durationMs: 2,
              nativeProposal: {
                method: 'mobile-sam-nine-point-proposals-v1',
                backend: 'cpu',
                durationMs: 1,
                input: { width: 20, height: 20 },
                candidateCount: 36,
              },
              segmentation: {
                method: 'pixel-mask-proposals-v1',
                backend: 'cpu',
                durationMs: 1,
                input: { width: 20, height: 20 },
                qualityScore: 0.8,
              },
              mask: {
                file: 'mask.u8' as const,
                sha256: createHash('sha256').update(proposalMask).digest('hex'),
                format: 'binary-u8' as const,
                width: 20,
                height: 20,
                sourceRegion: { left: 12, top: 12, width: 20, height: 20 },
                sourceOffset: { x: 12, y: 12 },
                pngFile: 'cutout.png' as const,
                pngSha256: createHash('sha256').update(proposalPng).digest('hex'),
              },
            }
          : { status: 'unknown' as const, durationMs: 1, reason: 'mask-unavailable' },
    })),
    aggregate: {
      admittedPhysicalCalls: 1,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: 0,
      maxPhysicalCalls: 300,
      maxCostUsd: 5,
    },
    latencyEnvironment: 'single-development-runner-without-owned-native-stress',
    latencyRankingEligible: true,
    initializationError: null,
    shutdownError: null,
    physicalReceipts: [oneReceipt],
  }
  const truthGroups = [cases.slice(0, 20), cases.slice(20, 30), cases.slice(30)]
  const truths = []
  for (let index = 0; index < truthGroups.length; index++) {
    truths.push(
      await writePinned(
        join(directory, `truth-${index}.json`),
        Buffer.from(
          JSON.stringify(
            truthGroups[index]!.map((item) => ({
              caseId: item.caseId,
              expectedPresence: 'present',
              targetBoxes: [{ xyxy: [0.1, 0.1, 0.4, 0.4] }],
              negativeEvidence: null,
              ...(item.caseId === cases[2]!.caseId
                ? {
                    referenceMasks: [
                      {
                        path: referencePath,
                        sha256: createHash('sha256').update(referencePng).digest('hex'),
                        bytes: referencePng.length,
                        width: cases[2]!.image.width,
                        height: cases[2]!.image.height,
                      },
                    ],
                  }
                : {}),
            })),
          ),
        ),
      ),
    )
  }
  return { directory, corpus, cases, runManifest, summary, truths, proposalMask, proposalPng }
}

await test('normalizes raw physical call counts and preserves unknown/failed status', async () => {
  const fixture = await setup()
  try {
    const normalized = normalizeFreshProposalOutput(
      fixture.summary,
      fixture.runManifest,
      fixture.cases,
      fixture.corpus.manifests,
      { summarySha256: '7'.repeat(64), runManifestSha256: '8'.repeat(64) },
    )
    assert.equal(normalized.results[0]!.classify.calls, 1)
    assert.equal(normalized.results[0]!.profileId, 'native-mobile-sam-proposals-v1')
    assert.equal(normalized.results[2]!.locate.status, 'located')
    assert.equal(normalized.results[3]!.locate.status, 'unknown')
    assert.equal(normalized.results[1]!.locate.status, 'failed')
    assert.equal(normalized.proposalExtractions[2]!.status, 'extracted')
    assert.equal(normalized.proposalExtractions[2]!.mask?.sourceOffset.x, 12)
    assert.equal(normalized.rawProposalProvenance.physicalCalls, 1)
    assert.equal(normalized.rawProposalProvenance.logicalCalls, 1)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

await test('incomplete raw output retains missing cases and rejects inconsistent coverage', async () => {
  const fixture = await setup()
  try {
    const summary = structuredClone(fixture.summary) as {
      status: 'complete' | 'incomplete'
      plannedCaseIds: string[]
      completedCaseIds: string[]
      missingCaseIds: string[]
      results: typeof fixture.summary.results
    }
    const missing = summary.plannedCaseIds.at(-1)!
    summary.status = 'incomplete'
    summary.completedCaseIds = summary.completedCaseIds.filter((id) => id !== missing)
    summary.missingCaseIds = [missing]
    summary.results = summary.results.filter((row) => row.caseId !== missing)
    const normalized = normalizeFreshProposalOutput(
      summary,
      fixture.runManifest,
      fixture.cases,
      fixture.corpus.manifests,
      { summarySha256: '7'.repeat(64), runManifestSha256: '8'.repeat(64) },
    )
    assert.equal(normalized.status, 'incomplete')
    assert.deepEqual(normalized.missingCaseIds, [missing])
    assert.equal(normalized.results.length, 39)
    summary.missingCaseIds = []
    assert.throws(
      () =>
        normalizeFreshProposalOutput(
          summary,
          fixture.runManifest,
          fixture.cases,
          fixture.corpus.manifests,
          { summarySha256: '7'.repeat(64), runManifestSha256: '8'.repeat(64) },
        ),
      /coverage set mismatch/u,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

await test('rejects profile, source hash, source image, extra ID and unknown-field mismatches', async () => {
  const fixture = await setup()
  const call = (summary: unknown, manifest: unknown = fixture.runManifest) =>
    normalizeFreshProposalOutput(summary, manifest, fixture.cases, fixture.corpus.manifests, {
      summarySha256: '7'.repeat(64),
      runManifestSha256: '8'.repeat(64),
    })
  try {
    const wrongProfile = structuredClone(fixture.runManifest)
    wrongProfile.profileId = 'wrong-profile'
    assert.throws(() => call(fixture.summary, wrongProfile))

    const wrongSourceDigest = structuredClone(fixture.runManifest)
    wrongSourceDigest.producerSourceSha256 = '9'.repeat(64)
    assert.throws(() => call(fixture.summary, wrongSourceDigest), /source-hash digest/u)

    const wrongImage = structuredClone(fixture.summary)
    wrongImage.results[0]!.imageSha256 = 'a'.repeat(64)
    assert.throws(() => call(wrongImage), /source image hash mismatch/u)

    const extraCase = structuredClone(fixture.summary)
    extraCase.completedCaseIds[0] = 'unexpected-extra-case'
    assert.throws(() => call(extraCase), /completed case set mismatch/u)

    const extraField = structuredClone(fixture.summary) as Record<string, unknown>
    extraField.unrecognized = true
    assert.throws(() => call(extraField), /Unrecognized key/u)

    const extraRowField = structuredClone(fixture.summary)
    ;(extraRowField.results[0] as Record<string, unknown>).guess = 'not allowed'
    assert.throws(() => call(extraRowField), /Unrecognized key/u)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

await test('adapter writes exclusive derived artifacts and invokes the strict independent evaluator', async () => {
  const fixture = await setup()
  try {
    const rawSummary = await writePinned(
      join(fixture.directory, 'raw-summary.json'),
      Buffer.from(JSON.stringify(fixture.summary)),
    )
    const caseDirectory = join(fixture.directory, fixture.cases[2]!.caseId)
    await mkdir(caseDirectory)
    await writeFile(join(caseDirectory, 'mask.u8'), fixture.proposalMask, { flag: 'wx' })
    await writeFile(join(caseDirectory, 'cutout.png'), fixture.proposalPng, { flag: 'wx' })
    const runManifest = await writePinned(
      join(fixture.directory, 'raw-run-manifest.json'),
      Buffer.from(JSON.stringify(fixture.runManifest)),
    )
    const inputFiles = []
    for (let index = 0; index < inputPaths.length; index++) {
      const bytes = await readFile(inputPaths[index]!)
      inputFiles.push(
        await writePinned(join(fixture.directory, `adapter-input-${index}.json`), bytes),
      )
    }
    const corpus = await loadFreshCorpus(
      { manifests: inputFiles, imageRoot: fixture.directory },
      signal,
    )
    assert.deepEqual(corpus.manifests, freshProposalInputPins)
    const truthFiles = []
    for (let index = 0; index < fixture.truths.length; index++) {
      const sourceTruth = fixture.truths[index]!
      const bytes = await readFile(sourceTruth.path)
      truthFiles.push(
        await writePinned(join(fixture.directory, `adapter-truth-${index}.json`), bytes),
      )
    }
    const result = await evaluateFreshProposalRun(
      {
        rawSummary,
        runManifest,
        corpus: { manifests: inputFiles, imageRoot: fixture.directory },
        truths: truthFiles,
        derivedSummary: join(fixture.directory, 'normalized-summary.json'),
        output: join(fixture.directory, 'evaluation.json'),
        provenanceOutput: join(fixture.directory, 'adapter-provenance.json'),
      },
      signal,
    )
    assert.equal(result.complete, true)
    assert.equal(result.coverage.reported, 40)
    assert.equal(result.provenance.rawSummarySha256, rawSummary.sha256)
    assert.equal(result.provenance.runManifestSha256, runManifest.sha256)
    assert.equal(result.provenance.physicalCalls, 1)
    assert.equal(result.proposalMaskMetrics.scoredCases, 1)
    assert.equal(result.proposalMaskMetrics.passedCases, 1)
    assert.equal(result.proposalMaskMetrics.meanBestInstanceIoU, 1)
    const derived = JSON.parse(
      await readFile(join(fixture.directory, 'normalized-summary.json'), 'utf8'),
    ) as {
      results: Array<{ profileId: string; classify: { calls: number } }>
    }
    assert.equal(derived.results[0]!.profileId, 'native-mobile-sam-proposals-v1')
    assert.equal(derived.results[0]!.classify.calls, 1)
    await assert.rejects(
      evaluateFreshProposalRun(
        {
          rawSummary,
          runManifest,
          corpus: { manifests: inputFiles, imageRoot: fixture.directory },
          truths: truthFiles,
          derivedSummary: join(fixture.directory, 'normalized-summary.json'),
          output: join(fixture.directory, 'evaluation.json'),
          provenanceOutput: join(fixture.directory, 'adapter-provenance.json'),
        },
        signal,
      ),
      { code: 'EEXIST' },
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
