import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Classifier } from '../../src/app/create-classifier.js'
import { createClassifier } from '../../src/app/create-classifier.js'
import type { DecisionPort } from '../../src/entities/contracts.js'
import type { SegmentationMetadata } from '../../src/entities/segmentation.js'
import type { ExtractionResult } from '../../src/entities/segmentation.js'
import type {
  ObjectProposalBatch,
  ObjectProposalInput,
  ObjectProposalPort,
} from '../../src/entities/object-proposals.js'
import type { WholeObjectLocalizationResult } from '../../src/entities/whole-object.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { createMobileSamObjectProposals } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import { RunBudget } from './budget.js'
import type { BudgetSnapshot } from './budget.js'
import { freshProducerTask, loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'
import { recordProvider } from './recording.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'

import { readOpenRouterKeyFromProcessEnv } from '../credentials.js'

export const freshProposalRoute = Object.freeze({
  id: 'openai-gpt-6-luna-decisions-openai-v1',
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
})

export const freshProposalPolicy = Object.freeze({
  timeoutMs: 45_000,
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
})

export const mobileSamProposalAssets = Object.freeze({
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
})

export const freshProposalManifestHashes = Object.freeze([
  '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
  '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
  'b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15',
] as const)

export const freshProposalHeldoutManifestHashes = Object.freeze([
  'b3afaee883990e01a464929727b7b7bb1315d6e0a70e239a10f20e2f82a3e35b',
  'ca6b4db64640bf08fffd055c3e7f6e6e85b3cc0c303c1ac8b41690c87a3d4572',
  'c259be7b00040e0c852d8a75b67655b07b9deffe5e284aca33718a921a1e2b62',
] as const)

export const freshProposalHeldoutPolicy = Object.freeze({
  ...freshProposalPolicy,
  maxPhysicalCalls: 600,
  maxCostUsd: 10,
  latencyEnvironment: 'concurrent-native-soak-unranked',
  latencyRankingEligible: false,
})

const sourceFiles = [
  './fresh-proposal-runner.ts',
  './run-fresh-proposals.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  '../credentials.ts',
  '../../package.json',
  '../../package-lock.json',
] as const

interface FreshProposalRunnerOptions {
  manifests: Array<{ path: string; sha256: string }>
  imageRoot: string
  outputRoot: string
  apiKey: string
  encoderPath: string
  decoderPath: string
  /** Test-only fixture size; production callers leave this at the full DEV denominator of 40. */
  expectedCaseCount?: number
  phase?: 'dev' | 'heldout'
  fetch?: typeof globalThis.fetch
  /** Offline fixture seam; production uses the pinned OpenRouter Decisions adapter. */
  createDecision?: (fetcher: typeof globalThis.fetch) => DecisionPort
  /** Offline fixture seam; production initializes one explicit CPU MobileSAM adapter. */
  createObjectProposals?: (input: {
    encoderPath: string
    decoderPath: string
  }) => Promise<ObjectProposalPort>
}

type StageStatus = 'ok' | 'failed' | 'located' | 'unknown' | 'not-found'
interface StageRecord {
  status: StageStatus
  durationMs: number
  physicalCalls: number
  logicalCalls: number
  requestHashes: string[]
  value?: 'present' | 'absent'
  region?: { left: number; top: number; width: number; height: number }
  reason?: string
  errorCode?: string
  nativeProposal?: {
    method: string
    backend: string
    durationMs: number
    input: { width: number; height: number }
    candidateCount: number
  }
}

interface FreshProposalResult {
  caseId: string
  imageSha256: string
  classify: StageRecord
  locate: StageRecord
  extract: ExtractRecord
}

interface ExtractRecord {
  status: 'extracted' | 'unknown' | 'not-found' | 'failed'
  durationMs: number
  reason?: string
  errorCode?: string
  nativeProposal?: NonNullable<StageRecord['nativeProposal']>
  segmentation?: {
    method: string
    backend: string
    durationMs: number
    input: { width: number; height: number }
    qualityScore?: number
  }
  mask?: {
    file: 'mask.u8'
    sha256: string
    format: 'binary-u8'
    width: number
    height: number
    sourceRegion: { left: number; top: number; width: number; height: number }
    sourceOffset: { x: number; y: number }
    pngFile: 'cutout.png'
    pngSha256: string
  }
}

const errorCodes = new Set([
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'RESOURCE_LIMIT',
  'UNSUPPORTED',
  'CAPACITY',
  'TIMEOUT',
  'ABORTED',
  'DISPOSED',
  'PROVIDER',
  'AUTHENTICATION',
  'V02_RUN_BUDGET_EXHAUSTED',
])

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' && errorCodes.has(code) ? code : 'RUNNER_FAILURE'
}

function writeImmutable(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function sourceHashes(): Promise<Record<string, string>> {
  const bench = await Promise.all(
    sourceFiles.map(
      async (path) => [path, sha256(await readFile(new URL(path, import.meta.url)))] as const,
    ),
  )
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url))
  async function walk(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return walk(path)
        return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
      }),
    )
    return nested.flat()
  }
  const files = (await walk(srcRoot)).sort()
  const src = await Promise.all(
    files.map(
      async (path) =>
        [
          `src/${relative(srcRoot, path).split(sep).join('/')}`,
          sha256(await readFile(path)),
        ] as const,
    ),
  )
  return Object.fromEntries([...bench, ...src])
}

function taskFor(item: FreshCase) {
  const task = freshProducerTask(item)
  const serialized = JSON.stringify(task)
  if (
    serialized.includes(item.caseId) ||
    serialized.includes(item.image.path) ||
    serialized.includes(item.image.sha256)
  )
    throw Object.assign(new Error('Producer task includes controller-only identity'), {
      code: 'INVALID_INPUT',
    })
  return task
}

function summarizeLocation(
  result: WholeObjectLocalizationResult,
): Pick<StageRecord, 'status' | 'region' | 'reason'> {
  if (result.status === 'located') return { status: 'located', region: result.region }
  if (result.status === 'not-found') return { status: 'not-found', reason: result.reason }
  return { status: 'unknown', reason: result.reason }
}

function locationFromExtraction(result: ExtractionResult): WholeObjectLocalizationResult {
  if (result.status === 'extracted') return result.location
  if (result.status === 'unknown' && 'location' in result) return result.location
  return result
}

function safeReason(reason: string): string | undefined {
  const allowed = new Set([
    'absent-in-evaluated-region',
    'uncertain-presence',
    'candidate-union-empty',
    'contradictory-evidence',
    'layout-limit',
    'instance-ambiguous',
    'extent-uncertain',
    'extent-inconsistent',
    'representation-limit',
    'segmentation-uncertain',
  ])
  return allowed.has(reason) ? reason : undefined
}

async function persistExtractedMask(
  caseDirectory: string,
  result: ExtractedResult,
  source: { width: number; height: number },
): Promise<NonNullable<ExtractRecord['mask']>> {
  const { mask, region, offset, png, location } = result
  if (
    mask.format !== 'binary-u8' ||
    !Number.isSafeInteger(mask.width) ||
    !Number.isSafeInteger(mask.height) ||
    mask.width !== region.width ||
    mask.height !== region.height ||
    mask.data.length !== mask.width * mask.height ||
    offset.x !== region.left ||
    offset.y !== region.top ||
    region.left < 0 ||
    region.top < 0 ||
    region.left + region.width > source.width ||
    region.top + region.height > source.height ||
    location.metadata.image.width !== source.width ||
    location.metadata.image.height !== source.height ||
    mask.data.some((value) => value !== 0 && value !== 1) ||
    png.length < 8 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => png[index] === byte)
  )
    throw Object.assign(new Error('Extracted mask geometry or bytes are invalid'), {
      code: 'INVALID_RESPONSE',
    })

  const maskBytes = new Uint8Array(mask.data)
  const pngBytes = new Uint8Array(png)
  try {
    const maskHash = sha256(maskBytes)
    const pngHash = sha256(pngBytes)
    await writeFile(join(caseDirectory, 'mask.u8'), maskBytes, { flag: 'wx' })
    await writeFile(join(caseDirectory, 'cutout.png'), pngBytes, { flag: 'wx' })
    return {
      file: 'mask.u8',
      sha256: maskHash,
      format: 'binary-u8',
      width: mask.width,
      height: mask.height,
      sourceRegion: { ...region },
      sourceOffset: { x: offset.x, y: offset.y },
      pngFile: 'cutout.png',
      pngSha256: pngHash,
    }
  } finally {
    maskBytes.fill(0)
    pngBytes.fill(0)
    mask.data.fill(0)
    png.fill(0)
  }
}

type ExtractedResult = Extract<ExtractionResult, { status: 'extracted' }>

function captureNativeProposal(batch: ObjectProposalBatch, input: ObjectProposalInput) {
  const { metadata } = batch
  if (
    metadata.method !== mobileSamProposalAssets.method ||
    metadata.backend !== 'mobile-sam' ||
    !Number.isFinite(metadata.durationMs) ||
    metadata.durationMs < 0 ||
    !Number.isSafeInteger(metadata.input.width) ||
    !Number.isSafeInteger(metadata.input.height) ||
    metadata.input.width !== input.image.width ||
    metadata.input.height !== input.image.height ||
    batch.proposals.length < 1 ||
    batch.proposals.length > 36
  )
    throw Object.assign(new Error('Native proposal metadata is malformed'), {
      code: 'INVALID_RESPONSE',
    })
  return {
    method: metadata.method,
    backend: metadata.backend,
    durationMs: metadata.durationMs,
    input: { ...metadata.input },
    candidateCount: batch.proposals.length,
  }
}

function captureSegmentation(
  metadata: SegmentationMetadata,
  source: { width: number; height: number },
) {
  if (
    metadata.method !== mobileSamProposalAssets.method ||
    metadata.backend !== 'mobile-sam' ||
    !Number.isFinite(metadata.durationMs) ||
    metadata.durationMs < 0 ||
    metadata.input.width !== source.width ||
    metadata.input.height !== source.height ||
    (metadata.qualityScore !== undefined && !Number.isFinite(metadata.qualityScore))
  )
    throw Object.assign(new Error('Segmentation metadata is malformed'), {
      code: 'INVALID_RESPONSE',
    })
  return {
    method: metadata.method,
    backend: metadata.backend,
    durationMs: metadata.durationMs,
    input: { width: metadata.input.width, height: metadata.input.height },
    ...(metadata.qualityScore !== undefined ? { qualityScore: metadata.qualityScore } : {}),
  }
}

function observeProposals(
  port: ObjectProposalPort,
  onBatch: (batch: ObjectProposalBatch, input: ObjectProposalInput) => void,
) {
  return {
    async propose(input: ObjectProposalInput): Promise<ObjectProposalBatch> {
      const batch = await port.propose(input)
      onBatch(batch, input)
      return batch
    },
    settle: () => port.settle(),
    async dispose() {},
  } satisfies ObjectProposalPort
}

function stageRecord(
  recorder: Recorder,
  physicalStart: number,
  logicalStart: number,
  durationMs: number,
  value: Pick<StageRecord, 'status' | 'value' | 'region' | 'reason' | 'errorCode'>,
): StageRecord {
  return {
    ...value,
    durationMs,
    physicalCalls: recorder.calls.length - physicalStart,
    logicalCalls: recorder.logicalCalls.length - logicalStart,
    requestHashes: recorder.logicalCalls.slice(logicalStart).map((call) => call.requestSha256),
  }
}

function physicalSummary(call: PhysicalCallRecord) {
  return {
    physicalId: call.physicalId,
    logicalId: call.logicalId,
    requestSha256: call.requestSha256,
    requestBodySha256: call.requestBodySha256,
    admittedAt: call.admittedAt,
    durationMs: call.durationMs,
    httpStatus: call.httpStatus,
    route: call.route,
    receipt: call.receipt,
    wireReceipt: call.wireReceipt,
    errorCode: call.errorCode ?? null,
  }
}

function createProvider(options: FreshProposalRunnerOptions, fetcher: typeof globalThis.fetch) {
  return (
    options.createDecision?.(fetcher) ??
    createOpenRouterDecisions({
      apiKey: options.apiKey,
      model: freshProposalRoute.model,
      provider: freshProposalRoute.provider,
      providerName: freshProposalRoute.providerName,
      fetch: fetcher,
    })
  )
}

function createProposals(options: FreshProposalRunnerOptions) {
  return (
    options.createObjectProposals?.({
      encoderPath: options.encoderPath,
      decoderPath: options.decoderPath,
    }) ??
    createMobileSamObjectProposals({
      encoderPath: options.encoderPath,
      decoderPath: options.decoderPath,
      executionProvider: 'cpu',
      threads: 2,
    })
  )
}

/** One immutable 40-case DEV producer pass. It never loads truth or source-ledger files. */
export async function runFreshProposalDev(
  options: FreshProposalRunnerOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  return runFreshProposalPhase({ ...options, phase: 'dev' }, signal)
}

/** One immutable 80-case HELDOUT producer pass. It never loads truth or source-ledger files. */
export async function runFreshProposalHeldout(
  options: FreshProposalRunnerOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  return runFreshProposalPhase({ ...options, phase: 'heldout' }, signal)
}

async function runFreshProposalPhase(
  options: FreshProposalRunnerOptions & { phase: 'dev' | 'heldout' },
  signal: AbortSignal,
) {
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    signal,
  )
  const source = await sourceHashes()
  const caseManifest = corpus.cases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    imageDimensions: { width: item.image.width, height: item.image.height },
  }))
  const taskManifest = corpus.cases.map((item) => ({
    caseId: item.caseId,
    task: taskFor(item),
  }))
  const heldout = options.phase === 'heldout'
  const expectedCaseCount = options.expectedCaseCount ?? (heldout ? 80 : 40)
  if (!Number.isInteger(expectedCaseCount) || expectedCaseCount < 1 || expectedCaseCount > 120)
    throw new TypeError('Expected fresh corpus case count must be between 1 and 120')
  if (corpus.cases.length !== expectedCaseCount)
    throw new TypeError(`Fresh DEV manifest set must contain exactly ${expectedCaseCount} cases`)
  if (heldout) {
    if (
      expectedCaseCount !== 80 ||
      corpus.manifests.length !== 3 ||
      corpus.manifests.some(
        (manifest, index) => manifest.sha256 !== freshProposalHeldoutManifestHashes[index],
      ) ||
      corpus.manifests[0]?.cases !== 40 ||
      corpus.manifests[1]?.cases !== 20 ||
      corpus.manifests[2]?.cases !== 20
    )
      throw new TypeError(
        'HELDOUT run requires 40 photo, 20 independent UI and 20 independent map cases',
      )
  } else if (
    expectedCaseCount === 40 &&
    (corpus.manifests.length !== 3 ||
      corpus.manifests.some(
        (manifest, index) => manifest.sha256 !== freshProposalManifestHashes[index],
      ) ||
      corpus.manifests[0]?.cases !== 20 ||
      corpus.manifests[1]?.cases !== 10 ||
      corpus.manifests[2]?.cases !== 10)
  )
    throw new TypeError(
      'Full DEV run requires 20 photo, 10 independent UI and 10 independent map cases',
    )
  const imageChecks = new Map<string, { ok: true } | { ok: false; errorCode: string }>()
  for (const item of corpus.cases) {
    try {
      taskFor(item)
      const image = await loadFreshImage(item, corpus.imageRoot, signal)
      image.fill(0)
      imageChecks.set(item.caseId, { ok: true })
    } catch (error) {
      if (signal.aborted) throw error
      imageChecks.set(item.caseId, { ok: false, errorCode: safeErrorCode(error) })
    }
  }
  const profileId = heldout
    ? 'native-mobile-sam-proposals-heldout-v1'
    : 'native-mobile-sam-proposals-v1'
  const policy = heldout ? freshProposalHeldoutPolicy : freshProposalPolicy
  const frozenProfile = {
    profileId,
    ...(heldout ? { phase: 'heldout' as const } : {}),
    route: freshProposalRoute,
    assets: mobileSamProposalAssets,
    policy,
    classification: {
      questionSource: 'freshProducerTask.question',
      instructionSuffix: 'Use only the supplied image. Choose exactly one closed label.',
      classes: [
        { id: 'present', description: 'The target in the question is visible in this image.' },
        { id: 'absent', description: 'The target in the question is not visible in this image.' },
      ],
    },
    taskManifest,
    expectedCaseCount,
    preflight: corpus.cases.map((item) => ({
      caseId: item.caseId,
      status: imageChecks.get(item.caseId)?.ok ? 'verified' : 'failed',
      errorCode: imageChecks.get(item.caseId)?.ok
        ? null
        : ((imageChecks.get(item.caseId) as { errorCode: string } | undefined)?.errorCode ??
          'INVALID_INPUT'),
    })),
  }
  const variantSha256 = hashCanonical({
    profile: frozenProfile,
    manifestHashes: corpus.manifests,
    cases: caseManifest,
    sourceHashes: Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
  })
  const runId = `v02-fresh-${profileId}-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(
    policy.maxPhysicalCalls,
    policy.maxCostUsd,
    policy.unknownCostReserveUsd,
    heldout ? 'heldout' : 'dev',
  )
  const plannedCaseIds = caseManifest.map((item) => item.caseId)
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    profileId,
    ...(heldout ? { phase: 'heldout' as const } : {}),
    purpose: heldout
      ? 'full frozen HELDOUT photo, independent UI and independent map producer pass'
      : 'full fresh DEV photo, independent UI and independent map producer pass',
    startedAt: new Date().toISOString(),
    variantSha256,
    producerSourceSha256: hashCanonical(
      Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sourceHashes: source,
    manifests: corpus.manifests,
    plannedCaseIds,
    plannedCases: caseManifest,
    route: freshProposalRoute,
    mobileSam: mobileSamProposalAssets,
    policy,
    classification: frozenProfile.classification,
    taskManifest,
    modelBoundary: {
      evaluatorTruthRead: false,
      groundTruthInProducer: false,
      retries: 0,
      fallback: false,
    },
  })

  const results: FreshProposalResult[] = []
  const fetcher = options.fetch ?? globalThis.fetch
  let proposalPort: ObjectProposalPort | undefined
  let currentProposalMetadata: NonNullable<StageRecord['nativeProposal']> | undefined
  let classifier: Classifier | undefined
  let recorder: Recorder | undefined
  let initializationError: string | undefined
  try {
    proposalPort = await createProposals(options)
    const observedProposalPort = observeProposals(proposalPort, (batch, input) => {
      currentProposalMetadata = captureNativeProposal(batch, input)
    })
    recorder = recordProvider(
      (trackedFetch) => createProvider(options, trackedFetch),
      budget,
      join(outputDirectory, 'calls'),
      freshProposalRoute,
      fetcher,
    )
    classifier = createClassifier({
      decision: recorder.port,
      objectProposals: observedProposalPort,
      timeoutMs: policy.timeoutMs,
      concurrency: policy.concurrency,
      maxQueue: policy.maxQueue,
    })
  } catch (error) {
    initializationError = safeErrorCode(error)
  }

  let shutdownError: string | undefined
  try {
    for (const item of corpus.cases) {
      const caseDirectory = join(outputDirectory, item.caseId)
      await mkdir(caseDirectory, { recursive: false })
      if (initializationError || !classifier || !recorder) {
        const failure: FreshProposalResult = {
          caseId: item.caseId,
          imageSha256: item.image.sha256,
          classify: {
            status: 'failed',
            durationMs: 0,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
            errorCode: initializationError ?? 'RUNNER_FAILURE',
          },
          locate: {
            status: 'failed',
            durationMs: 0,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
            errorCode: initializationError ?? 'RUNNER_FAILURE',
          },
          extract: {
            status: 'failed',
            durationMs: 0,
            errorCode: initializationError ?? 'RUNNER_FAILURE',
          },
        }
        results.push(failure)
        await writeImmutable(join(caseDirectory, 'result.json'), failure)
        continue
      }
      const checked = imageChecks.get(item.caseId)
      if (!checked?.ok) {
        const errorCode = checked?.errorCode ?? 'INVALID_INPUT'
        const failed: FreshProposalResult = {
          caseId: item.caseId,
          imageSha256: item.image.sha256,
          classify: {
            status: 'failed',
            durationMs: 0,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
            errorCode,
          },
          locate: {
            status: 'failed',
            durationMs: 0,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
            errorCode,
          },
          extract: { status: 'failed', durationMs: 0, errorCode },
        }
        results.push(failed)
        await writeImmutable(join(caseDirectory, 'result.json'), failed)
        continue
      }

      let image: Uint8Array | undefined
      try {
        image = await loadFreshImage(item, corpus.imageRoot, signal)
        const task = taskFor(item)
        const classifyStarted = performance.now()
        const classPhysicalStart = recorder.calls.length
        const classLogicalStart = recorder.logicalCalls.length
        let classify: StageRecord
        try {
          const result = await classifier.classify({
            input: { image },
            classes: frozenProfile.classification.classes,
            instructions: `${task.question}\n\n${frozenProfile.classification.instructionSuffix}`,
            signal,
          })
          if (result.choice !== 'present' && result.choice !== 'absent')
            throw Object.assign(new Error('Classifier returned an ID outside the closed labels'), {
              code: 'INVALID_RESPONSE',
            })
          classify = stageRecord(
            recorder,
            classPhysicalStart,
            classLogicalStart,
            performance.now() - classifyStarted,
            { status: 'ok', value: result.choice },
          )
        } catch (error) {
          classify = stageRecord(
            recorder,
            classPhysicalStart,
            classLogicalStart,
            performance.now() - classifyStarted,
            { status: 'failed', errorCode: safeErrorCode(error) },
          )
        }

        const extractStarted = performance.now()
        currentProposalMetadata = undefined
        const extractPhysicalStart = recorder.calls.length
        const extractLogicalStart = recorder.logicalCalls.length
        let locate: StageRecord
        let extract: ExtractRecord
        try {
          const target = task.instruction ? `${task.target}\n${task.instruction}` : task.target
          const result = await classifier.extract({
            image,
            target,
            mode: 'whole-object',
            boxTolerancePx: freshProposalPolicy.boxTolerancePx,
            maxExtentPasses: freshProposalPolicy.maxExtentPasses,
            signal,
          })
          const elapsedMs = performance.now() - extractStarted
          const location = locationFromExtraction(result)
          locate = {
            ...stageRecord(
              recorder,
              extractPhysicalStart,
              extractLogicalStart,
              elapsedMs,
              summarizeLocation(location),
            ),
            ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
          }
          if (result.status === 'extracted') {
            let segmentation: ExtractRecord['segmentation']
            try {
              segmentation = captureSegmentation(result.segmentation, item.image)
              const artifact = await persistExtractedMask(caseDirectory, result, {
                width: item.image.width,
                height: item.image.height,
              })
              extract = {
                status: 'extracted',
                durationMs: elapsedMs,
                ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
                segmentation,
                mask: artifact,
              }
            } catch (error) {
              result.mask.data.fill(0)
              result.png.fill(0)
              extract = {
                status: 'failed',
                durationMs: elapsedMs,
                errorCode: safeErrorCode(error),
                ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
                ...(segmentation ? { segmentation } : {}),
              }
            }
          } else if (result.status === 'unknown' && 'location' in result) {
            extract = {
              status: 'unknown',
              durationMs: elapsedMs,
              reason: 'segmentation-uncertain',
              ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
              segmentation: captureSegmentation(result.segmentation, item.image),
            }
          } else if (result.status === 'not-found') {
            const reason = safeReason(result.reason)
            extract = {
              status: 'not-found',
              durationMs: elapsedMs,
              ...(reason ? { reason } : {}),
              ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
            }
          } else {
            const reason = safeReason(result.reason)
            extract = {
              status: 'unknown',
              durationMs: elapsedMs,
              ...(reason ? { reason } : {}),
              ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
            }
          }
        } catch (error) {
          const elapsedMs = performance.now() - extractStarted
          locate = {
            ...stageRecord(recorder, extractPhysicalStart, extractLogicalStart, elapsedMs, {
              status: 'failed',
              errorCode: safeErrorCode(error),
            }),
            ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
          }
          extract = {
            status: 'failed',
            durationMs: elapsedMs,
            errorCode: safeErrorCode(error),
            ...(currentProposalMetadata ? { nativeProposal: currentProposalMetadata } : {}),
          }
        }
        const row = {
          caseId: item.caseId,
          imageSha256: item.image.sha256,
          classify,
          locate,
          extract,
        }
        results.push(row)
        await writeImmutable(join(caseDirectory, 'result.json'), row)
      } catch (error) {
        const errorCode = safeErrorCode(error)
        const row: FreshProposalResult = {
          caseId: item.caseId,
          imageSha256: item.image.sha256,
          classify: {
            status: 'failed',
            durationMs: 0,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
            errorCode,
          },
          locate: {
            status: 'failed',
            durationMs: 0,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
            errorCode,
          },
          extract: { status: 'failed', durationMs: 0, errorCode },
        }
        results.push(row)
        await writeImmutable(join(caseDirectory, 'result.json'), row)
      } finally {
        image?.fill(0)
      }
    }
  } finally {
    try {
      await classifier?.dispose()
    } catch (error) {
      shutdownError = safeErrorCode(error)
    }
    try {
      await proposalPort?.dispose()
    } catch (error) {
      shutdownError ??= safeErrorCode(error)
    }
  }

  const completedCaseIds = results.map((row) => row.caseId)
  const completed = new Set(completedCaseIds)
  const missingCaseIds = plannedCaseIds.filter((caseId) => !completed.has(caseId))
  const summary = {
    runId,
    profileId,
    ...(heldout ? { phase: 'heldout' as const } : {}),
    variantSha256,
    status: missingCaseIds.length === 0 ? 'complete' : 'incomplete',
    plannedCaseIds,
    completedCaseIds,
    missingCaseIds,
    results,
    aggregate: budget.snapshot() satisfies BudgetSnapshot,
    latencyEnvironment: policy.latencyEnvironment,
    latencyRankingEligible: policy.latencyRankingEligible,
    initializationError: initializationError ?? null,
    shutdownError: shutdownError ?? null,
    physicalReceipts: recorder?.calls.map(physicalSummary) ?? [],
  }
  await writeImmutable(join(outputDirectory, 'summary.json'), summary)
  await writeImmutable(join(outputDirectory, 'run-complete.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
  })
  return { ...summary, outputDirectory }
}

export async function readFreshProposalOpenRouterKey(): Promise<string> {
  return readOpenRouterKeyFromProcessEnv()
}
