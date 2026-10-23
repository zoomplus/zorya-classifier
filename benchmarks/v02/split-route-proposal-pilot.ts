import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Classifier } from '../../src/app/create-classifier.js'
import { createClassifier } from '../../src/app/create-classifier.js'
import type { DecisionPort } from '../../src/entities/contracts.js'
import type { ExtractionResult } from '../../src/entities/segmentation.js'
import type {
  ObjectProposalBatch,
  ObjectProposalInput,
  ObjectProposalPort,
} from '../../src/entities/object-proposals.js'
import type { WholeObjectLocalizationResult } from '../../src/entities/whole-object.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { createOpenRouterVision } from '../../src/infrastructure/openrouter-vision.js'
import { createMobileSamObjectProposals } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import { RunBudget } from './budget.js'
import type { BudgetSnapshot } from './budget.js'
import { freshProducerTask, loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'
import { recordProvider } from './recording.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { createSplitChoiceNoulPort } from './split-choice-noul-port.js'

import { readOpenRouterKeyFromProcessEnv } from '../credentials.js'

export const splitPilotRoutes = Object.freeze({
  choice: Object.freeze({
    id: 'openai-gpt-6-sol-choice-json-schema-v1',
    model: 'openai/gpt-6-sol',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/v1/chat/completions',
    allowFallbacks: false,
    responseFormat: 'json-schema',
    reasoningEffort: 'none',
  }),
  noul: Object.freeze({
    id: 'openai-gpt-6-luna-decisions-noul-v1',
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/alpha/decisions',
    allowFallbacks: false,
  }),
})

export const splitPilotPolicy = Object.freeze({
  timeoutMs: 120_000,
  maxInFlightCases: 2,
  nativeMaxActive: 1,
  nativeMaxWaiting: 2,
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 100,
  maxCostUsd: 5,
  unknownCostReserveUsd: 0.05,
  latencyRankingEligible: false,
  latencyEnvironment: 'concurrent-development-screen-unranked',
})

export const splitPilotCaseIds = Object.freeze([
  'photo-dev-present-01',
  'photo-dev-present-02',
  'photo-dev-absent-01',
  'photo-dev-absent-02',
  'photo-dev-absent-03',
  'photo-dev-absent-04',
] as const)

export const splitPilotInput = Object.freeze({
  path: 'benchmarks/v02/corpus/dev/inputs.json',
  sha256: '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
})

export const splitPilotAssets = Object.freeze({
  method: 'mobile-sam-nine-point-proposals-v1',
  encoder: {
    bytes: 28_157_093,
    sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
  },
  decoder: {
    bytes: 16_496_559,
    sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
  },
})

const sourceFiles = [
  './split-route-proposal-pilot.ts',
  './run-split-route-pilot.ts',
  './split-route-proposal-pilot.md',
  './split-choice-noul-port.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  '../credentials.ts',
  '../../package.json',
  '../../package-lock.json',
] as const

export interface SplitPilotOptions {
  inputManifestPath: string
  imageRoot: string
  outputRoot: string
  apiKey: string
  encoderPath: string
  decoderPath: string
  fetch?: typeof globalThis.fetch
  createChoicePort?: (fetcher: typeof globalThis.fetch) => DecisionPort
  createNoulPort?: (fetcher: typeof globalThis.fetch) => DecisionPort
  createObjectProposals?: (paths: {
    encoderPath: string
    decoderPath: string
  }) => Promise<ObjectProposalPort>
}

export async function preflightSplitRoutePilot(
  inputManifestPath: string,
  imageRoot: string,
  signal: AbortSignal = new AbortController().signal,
) {
  const corpus = await loadFreshCorpus(
    { manifests: [{ path: inputManifestPath, sha256: splitPilotInput.sha256 }], imageRoot },
    signal,
  )
  if (corpus.cases.length !== 20 || corpus.manifests[0]?.sha256 !== splitPilotInput.sha256)
    throw new TypeError('Split-route pilot requires the pinned exposed 20-photo DEV input manifest')
  const byId = new Map(corpus.cases.map((item) => [item.caseId, item]))
  const cases = splitPilotCaseIds.map((caseId) => {
    const item = byId.get(caseId)
    if (!item) throw new TypeError('Pinned exposed DEV pilot selector did not match its inputs')
    return item
  })
  const verified: string[] = []
  const failures: Array<{ caseId: string; errorCode: string }> = []
  for (const item of cases) {
    try {
      const bytes = await loadFreshImage(item, corpus.imageRoot, signal)
      bytes.fill(0)
      verified.push(item.caseId)
    } catch (error) {
      if (signal.aborted) throw error
      failures.push({ caseId: item.caseId, errorCode: safeErrorCode(error) })
    }
  }
  return { imageRoot: corpus.imageRoot, cases, verifiedCaseIds: verified, failures }
}

export function createRecordedSplitDecision(
  options: SplitPilotOptions,
  budget: RunBudget,
  directory: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
) {
  const choice = recordProvider(
    (fetch) => providerFor(splitPilotRoutes.choice, options, fetch),
    budget,
    join(directory, 'choice-sol'),
    splitPilotRoutes.choice,
    fetcher,
  )
  const noul = recordProvider(
    (fetch) => providerFor(splitPilotRoutes.noul, options, fetch),
    budget,
    join(directory, 'noul-luna'),
    splitPilotRoutes.noul,
    fetcher,
  )
  return {
    port: createSplitChoiceNoulPort(choice.port, noul.port),
    recorders: { choice, noul },
  }
}

type StageStatus = 'ok' | 'failed' | 'located' | 'unknown' | 'not-found'
interface StageRecord {
  status: StageStatus
  durationMs: number
  physicalCalls: number
  logicalCalls: number
  requestHashes: string[]
  routes: {
    choice: { physicalCalls: number; logicalCalls: number; requestHashes: string[] }
    noul: { physicalCalls: number; logicalCalls: number; requestHashes: string[] }
  }
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

interface CaseResult {
  caseId: string
  imageSha256: string
  classify: StageRecord
  locate: StageRecord
  extract: ExtractRecord
}

const safeErrors = new Set([
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
  const value = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof value === 'string' && safeErrors.has(value) ? value : 'RUNNER_FAILURE'
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
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
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) return walk(path)
          return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
        }),
      )
    ).flat()
  }
  const paths = (await walk(srcRoot)).sort()
  const source = await Promise.all(
    paths.map(
      async (path) =>
        [
          `src/${relative(srcRoot, path).split(sep).join('/')}`,
          sha256(await readFile(path)),
        ] as const,
    ),
  )
  return Object.fromEntries([...bench, ...source])
}

function locationFromExtraction(result: ExtractionResult): WholeObjectLocalizationResult {
  if (result.status === 'extracted') return result.location
  if (result.status === 'unknown' && 'location' in result) return result.location
  return result
}

function summarizeLocation(result: WholeObjectLocalizationResult) {
  if (result.status === 'located') return { status: 'located' as const, region: result.region }
  if (result.status === 'not-found') return { status: 'not-found' as const, reason: result.reason }
  return { status: 'unknown' as const, reason: result.reason }
}

function providerFor(
  route: typeof splitPilotRoutes.choice | typeof splitPilotRoutes.noul,
  options: SplitPilotOptions,
  fetcher: typeof globalThis.fetch,
): DecisionPort {
  if (route === splitPilotRoutes.choice) {
    return (
      options.createChoicePort?.(fetcher) ??
      createOpenRouterVision({
        apiKey: options.apiKey,
        model: splitPilotRoutes.choice.model,
        provider: splitPilotRoutes.choice.provider,
        providerName: splitPilotRoutes.choice.providerName,
        responseFormat: 'json-schema',
        reasoningEffort: 'none',
        fetch: fetcher,
      })
    )
  }
  return (
    options.createNoulPort?.(fetcher) ??
    createOpenRouterDecisions({
      apiKey: options.apiKey,
      model: splitPilotRoutes.noul.model,
      provider: splitPilotRoutes.noul.provider,
      providerName: splitPilotRoutes.noul.providerName,
      fetch: fetcher,
    })
  )
}

function makeObserver(
  port: ObjectProposalPort,
  onBatch: (batch: ObjectProposalBatch, input: ObjectProposalInput) => void,
): ObjectProposalPort {
  return {
    async propose(input) {
      const batch = await port.propose(input)
      onBatch(batch, input)
      return batch
    },
    settle: () => port.settle(),
    async dispose() {},
  }
}

function captureProposal(
  batch: ObjectProposalBatch,
  input: ObjectProposalInput,
): NonNullable<StageRecord['nativeProposal']> {
  if (
    batch.metadata.method !== splitPilotAssets.method ||
    batch.metadata.backend !== 'mobile-sam' ||
    batch.metadata.input.width !== input.image.width ||
    batch.metadata.input.height !== input.image.height ||
    !Number.isFinite(batch.metadata.durationMs) ||
    batch.metadata.durationMs < 0 ||
    batch.proposals.length < 1 ||
    batch.proposals.length > 36
  )
    throw Object.assign(new Error('Native proposal metadata invalid'), { code: 'INVALID_RESPONSE' })
  return {
    method: batch.metadata.method,
    backend: batch.metadata.backend,
    durationMs: batch.metadata.durationMs,
    input: { ...batch.metadata.input },
    candidateCount: batch.proposals.length,
  }
}

function routeDelta(recorder: Recorder, physicalStart: number, logicalStart: number) {
  const calls = recorder.calls.slice(physicalStart)
  const logical = recorder.logicalCalls.slice(logicalStart)
  return {
    physicalCalls: calls.length,
    logicalCalls: logical.length,
    requestHashes: logical.map((item) => item.requestSha256),
  }
}

function stage(
  before: { choice: { calls: number; logical: number }; noul: { calls: number; logical: number } },
  recorders: { choice: Recorder; noul: Recorder },
  durationMs: number,
  value: Pick<
    StageRecord,
    'status' | 'value' | 'region' | 'reason' | 'errorCode' | 'nativeProposal'
  >,
): StageRecord {
  const routes = {
    choice: routeDelta(recorders.choice, before.choice.calls, before.choice.logical),
    noul: routeDelta(recorders.noul, before.noul.calls, before.noul.logical),
  }
  const requestHashes = [...routes.choice.requestHashes, ...routes.noul.requestHashes]
  return {
    ...value,
    durationMs,
    physicalCalls: routes.choice.physicalCalls + routes.noul.physicalCalls,
    logicalCalls: routes.choice.logicalCalls + routes.noul.logicalCalls,
    requestHashes,
    routes,
  }
}

function summarizePhysical(routeId: 'choice' | 'noul', call: PhysicalCallRecord) {
  return {
    routeId,
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

function extractRecord(
  result: ExtractionResult,
  caseDirectory: string,
  source: { width: number; height: number },
  proposal?: NonNullable<StageRecord['nativeProposal']>,
): Promise<ExtractRecord> {
  return (async () => {
    if (result.status === 'extracted') {
      const { mask, region, offset, png, location } = result
      if (
        mask.format !== 'binary-u8' ||
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
        ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => png[i] === value)
      )
        throw Object.assign(new Error('Extracted artifacts failed local validation'), {
          code: 'INVALID_RESPONSE',
        })
      const maskBytes = new Uint8Array(mask.data)
      const pngBytes = new Uint8Array(png)
      try {
        const record: ExtractRecord = {
          status: 'extracted',
          durationMs: 0,
          ...(proposal ? { nativeProposal: proposal } : {}),
          segmentation: {
            method: result.segmentation.method,
            backend: result.segmentation.backend,
            durationMs: result.segmentation.durationMs,
            input: { ...result.segmentation.input },
          },
          mask: {
            file: 'mask.u8',
            sha256: sha256(maskBytes),
            format: 'binary-u8',
            width: mask.width,
            height: mask.height,
            sourceRegion: { ...region },
            sourceOffset: { x: offset.x, y: offset.y },
            pngFile: 'cutout.png',
            pngSha256: sha256(pngBytes),
          },
        }
        await writeFile(join(caseDirectory, 'mask.u8'), maskBytes, { flag: 'wx' })
        await writeFile(join(caseDirectory, 'cutout.png'), pngBytes, { flag: 'wx' })
        return record
      } finally {
        maskBytes.fill(0)
        pngBytes.fill(0)
        mask.data.fill(0)
        png.fill(0)
      }
    }
    if (result.status === 'not-found')
      return { status: 'not-found', durationMs: 0, reason: result.reason }
    if (result.status === 'unknown' && 'location' in result)
      return {
        status: 'unknown',
        durationMs: 0,
        reason: 'segmentation-uncertain',
        ...(proposal ? { nativeProposal: proposal } : {}),
        segmentation: {
          method: result.segmentation.method,
          backend: result.segmentation.backend,
          durationMs: result.segmentation.durationMs,
          input: { ...result.segmentation.input },
        },
      }
    if (result.status === 'unknown')
      return {
        status: 'unknown',
        durationMs: 0,
        reason: result.reason,
        ...(proposal ? { nativeProposal: proposal } : {}),
      }
    throw Object.assign(new Error('Unrecognized extraction result'), { code: 'INVALID_RESPONSE' })
  })()
}

export async function runSplitRouteDevPilot(
  options: SplitPilotOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  const preflight = await preflightSplitRoutePilot(
    options.inputManifestPath,
    options.imageRoot,
    signal,
  )
  const selected = preflight.cases
  const source = await sourceHashes()
  const taskManifest = selected.map((item) => ({
    caseId: item.caseId,
    task: freshProducerTask(item),
  }))
  const runId = `v02-fresh-split-choice-noul-dev6-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const selectedManifest = Buffer.from(`${JSON.stringify(selected, null, 2)}\n`)
  await writeFile(join(outputDirectory, 'selected-dev-inputs.json'), selectedManifest, {
    flag: 'wx',
  })
  const selectedManifestSha256 = sha256(selectedManifest)
  const budget = new RunBudget(
    splitPilotPolicy.maxPhysicalCalls,
    splitPilotPolicy.maxCostUsd,
    splitPilotPolicy.unknownCostReserveUsd,
    'dev',
  )
  const sourceDigest = hashCanonical(Object.entries(source).sort(([a], [b]) => a.localeCompare(b)))
  const variantSha256 = hashCanonical({
    profileId: 'split-choice-sol-noul-native-luna-sam-v1',
    routes: splitPilotRoutes,
    policy: splitPilotPolicy,
    selectedCaseIds: splitPilotCaseIds,
    parentInputSha256: splitPilotInput.sha256,
    selectedManifestSha256,
    sourceHashes: source,
  })
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    profileId: 'split-choice-sol-noul-native-luna-sam-v1',
    phase: 'dev-pilot',
    purpose:
      'six exposed DEV cases to evaluate caller-owned question-group routing; not a release qualification run',
    startedAt: new Date().toISOString(),
    variantSha256,
    producerSourceSha256: sourceDigest,
    sourceHashes: source,
    parentManifest: { sha256: splitPilotInput.sha256, caseCount: 20 },
    selectedManifest: { file: 'selected-dev-inputs.json', sha256: selectedManifestSha256 },
    plannedCaseIds: [...splitPilotCaseIds],
    plannedCases: selected.map((item) => ({
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      imageDimensions: { width: item.image.width, height: item.image.height },
    })),
    taskManifest,
    classification: {
      classOptions: [
        { id: 'present', description: 'The target in the question is visible in this image.' },
        { id: 'absent', description: 'The target in the question is not visible in this image.' },
      ],
      instructionSuffix: 'Use only the supplied image. Choose exactly one closed label.',
      assignedRoute: splitPilotRoutes.choice.id,
    },
    localization: {
      targetSource: 'freshProducerTask.target plus optional instruction',
      choiceQuestionRoute: splitPilotRoutes.choice.id,
      noulQuestionRoute: splitPilotRoutes.noul.id,
      boxTolerancePx: splitPilotPolicy.boxTolerancePx,
      maxExtentPasses: splitPilotPolicy.maxExtentPasses,
      proposalMethod: splitPilotAssets.method,
    },
    routes: splitPilotRoutes,
    mobileSam: splitPilotAssets,
    policy: splitPilotPolicy,
    modelBoundary: {
      evaluatorTruthRead: false,
      groundTruthInProducer: false,
      retries: 0,
      fallback: false,
    },
  })

  const checks = new Map<string, true | string>([
    ...preflight.verifiedCaseIds.map((caseId) => [caseId, true] as const),
    ...preflight.failures.map(({ caseId, errorCode }) => [caseId, errorCode] as const),
  ])
  await writeImmutable(
    join(outputDirectory, 'preflight.json'),
    selected.map((item) => ({
      caseId: item.caseId,
      status: checks.get(item.caseId) === true ? 'verified' : 'failed',
      errorCode: checks.get(item.caseId) === true ? null : checks.get(item.caseId),
    })),
  )
  if (preflight.failures.length > 0)
    throw Object.assign(
      new Error('Split-route pilot image preflight failed; no adapters were initialized'),
      { code: 'INVALID_INPUT' },
    )

  const fetcher = options.fetch ?? globalThis.fetch
  const proposalPort = await (options.createObjectProposals?.({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
  }) ??
    createMobileSamObjectProposals({
      encoderPath: options.encoderPath,
      decoderPath: options.decoderPath,
      executionProvider: 'cpu',
      threads: 2,
    }))
  const results = new Map<string, CaseResult>()
  const recorders = new Map<string, { choice: Recorder; noul: Recorder }>()
  let next = 0
  let fatal: unknown
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= selected.length) return
      const item = selected[index]!
      const directory = join(outputDirectory, item.caseId)
      await mkdir(directory, { recursive: false })
      if (fatal !== undefined) {
        const failed = failedCase(item, safeErrorCode(fatal))
        results.set(item.caseId, failed)
        await writeImmutable(join(directory, 'result.json'), failed)
        continue
      }
      if (checks.get(item.caseId) !== true) {
        const failed = failedCase(
          item,
          typeof checks.get(item.caseId) === 'string'
            ? (checks.get(item.caseId) as string)
            : 'INVALID_INPUT',
        )
        results.set(item.caseId, failed)
        await writeImmutable(join(directory, 'result.json'), failed)
        continue
      }
      try {
        const outcome = await runCase(
          item,
          directory,
          options,
          budget,
          fetcher,
          proposalPort,
          recorders,
          signal,
        )
        results.set(item.caseId, outcome)
        await writeImmutable(join(directory, 'result.json'), outcome)
      } catch (error) {
        const failed = failedCase(item, safeErrorCode(error))
        results.set(item.caseId, failed)
        await writeImmutable(join(directory, 'result.json'), failed)
      }
    }
  }
  const workerResults = await Promise.allSettled(
    Array.from({ length: splitPilotPolicy.maxInFlightCases }, () => worker()),
  )
  const rejectedWorker = workerResults.find((entry) => entry.status === 'rejected')
  if (rejectedWorker?.status === 'rejected') fatal = rejectedWorker.reason
  try {
    await proposalPort.settle()
  } catch (error) {
    fatal ??= error
  } finally {
    try {
      await proposalPort.dispose()
    } catch (error) {
      fatal ??= error
    }
  }
  const completedCaseIds = selected
    .filter((item) => results.has(item.caseId))
    .map((item) => item.caseId)
  const summary = {
    runId,
    profileId: 'split-choice-sol-noul-native-luna-sam-v1',
    variantSha256,
    status: completedCaseIds.length === selected.length ? 'complete' : 'incomplete',
    plannedCaseIds: [...splitPilotCaseIds],
    completedCaseIds,
    missingCaseIds: splitPilotCaseIds.filter((id) => !results.has(id)),
    results: selected.flatMap((item) => {
      const row = results.get(item.caseId)
      return row ? [row] : []
    }),
    aggregate: budget.snapshot() satisfies BudgetSnapshot,
    physicalReceipts: selected.flatMap((item) => {
      const pair = recorders.get(item.caseId)
      if (!pair) return []
      return [
        ...pair.choice.calls.map((call) => summarizePhysical('choice', call)),
        ...pair.noul.calls.map((call) => summarizePhysical('noul', call)),
      ]
    }),
    latencyEnvironment: splitPilotPolicy.latencyEnvironment,
    latencyRankingEligible: false,
    shutdownError: fatal === undefined ? null : safeErrorCode(fatal),
  }
  await writeImmutable(join(outputDirectory, 'summary.json'), summary)
  await writeImmutable(join(outputDirectory, 'run-complete.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
    sourceHashesUnchanged:
      sourceDigest ===
      hashCanonical(Object.entries(await sourceHashes()).sort(([a], [b]) => a.localeCompare(b))),
  })
  return { ...summary, outputDirectory }
}

function failedCase(item: FreshCase, errorCode: string): CaseResult {
  const empty = (): StageRecord => ({
    status: 'failed',
    durationMs: 0,
    physicalCalls: 0,
    logicalCalls: 0,
    requestHashes: [],
    routes: {
      choice: { physicalCalls: 0, logicalCalls: 0, requestHashes: [] },
      noul: { physicalCalls: 0, logicalCalls: 0, requestHashes: [] },
    },
    errorCode,
  })
  return {
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    classify: empty(),
    locate: empty(),
    extract: { status: 'failed', durationMs: 0, errorCode },
  }
}

async function runCase(
  item: FreshCase,
  directory: string,
  options: SplitPilotOptions,
  budget: RunBudget,
  fetcher: typeof globalThis.fetch,
  proposalPort: ObjectProposalPort,
  recorders: Map<string, { choice: Recorder; noul: Recorder }>,
  signal: AbortSignal,
): Promise<CaseResult> {
  const recorded = createRecordedSplitDecision(options, budget, join(directory, 'calls'), fetcher)
  const { choice, noul } = recorded.recorders
  recorders.set(item.caseId, { choice, noul })
  let proposal: NonNullable<StageRecord['nativeProposal']> | undefined
  const observed = makeObserver(proposalPort, (batch, input) => {
    proposal = captureProposal(batch, input)
  })
  const classifier: Classifier = createClassifier({
    decision: recorded.port,
    objectProposals: observed,
    timeoutMs: splitPilotPolicy.timeoutMs,
    concurrency: 1,
    maxQueue: 0,
  })
  let image: Uint8Array | undefined
  try {
    image = await loadFreshImage(item, options.imageRoot, signal)
    const task = freshProducerTask(item)
    const zero = { choice: { calls: 0, logical: 0 }, noul: { calls: 0, logical: 0 } }
    const classStart = performance.now()
    let classify: StageRecord
    try {
      const result = await classifier.classify({
        input: { image },
        classes: [
          { id: 'present', description: 'The target in the question is visible in this image.' },
          { id: 'absent', description: 'The target in the question is not visible in this image.' },
        ],
        instructions: `${task.question}\n\nUse only the supplied image. Choose exactly one closed label.`,
        signal,
      })
      if (result.choice !== 'present' && result.choice !== 'absent')
        throw Object.assign(new Error('Invalid classification label'), { code: 'INVALID_RESPONSE' })
      classify = stage(zero, { choice, noul }, performance.now() - classStart, {
        status: 'ok',
        value: result.choice,
      })
    } catch (error) {
      classify = stage(zero, { choice, noul }, performance.now() - classStart, {
        status: 'failed',
        errorCode: safeErrorCode(error),
      })
    }

    const beforeExtract = {
      choice: { calls: choice.calls.length, logical: choice.logicalCalls.length },
      noul: { calls: noul.calls.length, logical: noul.logicalCalls.length },
    }
    const extractStart = performance.now()
    let location: StageRecord
    let extracted: ExtractRecord
    proposal = undefined
    try {
      const result = await classifier.extract({
        image,
        target: task.instruction ? `${task.target}\n${task.instruction}` : task.target,
        mode: 'whole-object',
        boxTolerancePx: splitPilotPolicy.boxTolerancePx,
        maxExtentPasses: splitPilotPolicy.maxExtentPasses,
        signal,
      })
      const elapsed = performance.now() - extractStart
      const loc = locationFromExtraction(result)
      const summary = summarizeLocation(loc)
      location = stage(beforeExtract, { choice, noul }, elapsed, {
        ...summary,
        ...(proposal ? { nativeProposal: proposal } : {}),
      })
      try {
        extracted = await extractRecord(result, directory, item.image, proposal)
        extracted.durationMs = elapsed
      } catch (error) {
        extracted = {
          status: 'failed',
          durationMs: elapsed,
          errorCode: safeErrorCode(error),
          ...(proposal ? { nativeProposal: proposal } : {}),
        }
      }
    } catch (error) {
      const elapsed = performance.now() - extractStart
      location = stage(beforeExtract, { choice, noul }, elapsed, {
        status: 'failed',
        errorCode: safeErrorCode(error),
        ...(proposal ? { nativeProposal: proposal } : {}),
      })
      extracted = {
        status: 'failed',
        durationMs: elapsed,
        errorCode: safeErrorCode(error),
        ...(proposal ? { nativeProposal: proposal } : {}),
      }
    }
    return {
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      classify,
      locate: location,
      extract: extracted,
    }
  } finally {
    image?.fill(0)
    await classifier.dispose()
  }
}

export async function readSplitPilotOpenRouterKey(): Promise<string> {
  return readOpenRouterKeyFromProcessEnv()
}
