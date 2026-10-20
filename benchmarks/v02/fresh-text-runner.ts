import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { DecisionPort, DecisionRequest } from '../../src/entities/contracts.js'
import type { WholeObjectLocalizationResult } from '../../src/entities/whole-object.js'
import { createClassifier, createResearchClassifier } from '../../src/app/create-classifier.js'
import { createOpenRouterText } from '../../src/infrastructure/openrouter-vision.js'
import { createTextRepresentation } from '../../src/infrastructure/text-representation.js'
import { textEncodersV1 } from '../experiments/text-encoders-v1.js'
import type { TextRepresentationEncoder } from '../../src/infrastructure/text-representation.js'
import { RunBudget } from './budget.js'
import { freshProducerTask, loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'
import { recordProvider } from './recording.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { applyPromptVariant, promptVariants } from './promptvariants.js'
import { textTransportVariants } from './transportvariants.js'

const keyFile = '/root/work/element/.env.local'
const route = Object.freeze({
  id: 'together-deepseek-flash-text-v1',
  model: 'deepseek/deepseek-v4.1-flash',
  provider: 'together',
  providerName: 'Together',
  apiEndpoint: '/api/v1/chat/completions',
  allowFallbacks: false,
})
const prompt = promptVariants['grammar-plus-examples']
const transport = textTransportVariants['none-json-schema']

export const freshTextPolicy = Object.freeze({
  timeoutMs: 45000,
  concurrency: 1,
  maxQueue: 0,
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 250,
  maxCostUsd: 5,
  unknownCostReserveUsd: 0.02,
  classifyMaxOutputTokens: 1024,
  locateMaxOutputTokens: 4096,
  latencyEnvironment: 'concurrent-development-unranked',
  latencyRankingEligible: false,
})

export type FreshTextPhase = 'dev' | 'heldout'

export const heldoutPhotoInputSha256 =
  'b3afaee883990e01a464929727b7b7bb1315d6e0a70e239a10f20e2f82a3e35b'

export function freshTextPolicyForPhase(phase: FreshTextPhase) {
  if (phase === 'dev') return freshTextPolicy
  if (phase !== 'heldout') throw new TypeError('Unknown fresh text phase')
  return Object.freeze({
    ...freshTextPolicy,
    timeoutMs: 120000,
    maxPhysicalCalls: 300,
    maxCostUsd: 5,
    latencyEnvironment: 'heldout-no-image-control-unranked',
    latencyRankingEligible: false,
  })
}

export function validateFreshTextPhaseRequest(
  phase: FreshTextPhase,
  profileId: FreshTextProfileId,
  manifests: readonly { path: string; sha256: string }[],
  stages: 'classify-and-locate' | 'classify-only' = 'classify-and-locate',
): string {
  if (phase === 'dev') return 'single-profile complete pinned fresh DEV text/no-image comparison'
  if (phase !== 'heldout') throw new TypeError('Unknown fresh text phase')
  if (profileId !== 'no-image-control')
    throw new Error('Heldout text control requires the no-image-control profile')
  if (stages !== 'classify-and-locate')
    throw new Error('Heldout text control requires classify-and-locate stages')
  if (
    manifests.length !== 1 ||
    manifests[0]?.sha256 !== heldoutPhotoInputSha256 ||
    manifests[0]?.path.trim().length === 0
  )
    throw new Error('Heldout text control requires the frozen 40-photo input manifest')
  return 'full frozen HELDOUT photo-only no-image text control run'
}

export function assertFreshTextPhaseCaseCount(phase: FreshTextPhase, caseIds: readonly string[]) {
  if (phase === 'heldout' && (caseIds.length !== 40 || new Set(caseIds).size !== 40))
    throw new Error('Heldout text control must contain exactly 40 unique photo cases')
}

const encoderIds = [
  'ascii-luma-v1',
  'palette-grid-v1',
  'svg-contours-v1',
  'pixel-rle-v1',
  'ascii-contours-v1',
  'ascii-svg-layered-v1',
] as const
export type FreshTextProfileId = (typeof encoderIds)[number] | 'no-image-control'

export const freshTextProfiles: readonly FreshTextProfileId[] = Object.freeze([
  ...encoderIds,
  'no-image-control',
])

export interface FreshTextRunnerOptions {
  manifests: Array<{ path: string; sha256: string }>
  imageRoot: string
  outputRoot: string
  apiKey: string
  fetch?: typeof globalThis.fetch
  /** Offline-only seam used by tests; paid profiles use the pinned Together adapter. */
  createDecision?: (fetcher: typeof globalThis.fetch, maxOutputTokens: 1024 | 4096) => DecisionPort
  /** Classification-only evidence follow-up; it deliberately emits no locate stage. */
  stages?: 'classify-and-locate' | 'classify-only'
  /** Heldout is only for the frozen photo-only no-image control, after winner freeze. */
  phase?: FreshTextPhase
}

type StageStatus = 'ok' | 'failed' | 'located' | 'unknown' | 'not-found'
interface StageResult {
  status: StageStatus
  durationMs: number
  calls: number
  requestHashes: string[]
  value?: 'present' | 'absent' | 'unknown'
  region?: { left: number; top: number; width: number; height: number }
  reason?: string
  errorCode?: string
}
interface ResultRow {
  caseId: string
  imageSha256: string
  profileId: FreshTextProfileId
  classify: StageResult
  locate?: StageResult
}

const sourceFiles = [
  './fresh-text-runner.ts',
  './fresh-text-dev.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  './promptvariants.ts',
  './transportvariants.ts',
  '../experiments/text-encoders-v1.ts',
  '../experiments/ascii-luma-v1.ts',
  '../experiments/palette-grid-v1.ts',
  '../experiments/svg-contours-v1.ts',
  '../experiments/pixel-rle-v1.ts',
  '../experiments/ascii-contours-v1.ts',
  '../experiments/ascii-svg-layered-v1.ts',
] as const

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
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
  const sourceFilesInTree = (await walk(srcRoot)).sort()
  const src = await Promise.all(
    sourceFilesInTree.map(
      async (path) =>
        [
          `src/${relative(srcRoot, path).split(sep).join('/')}`,
          sha256(await readFile(path)),
        ] as const,
    ),
  )
  return Object.fromEntries([...bench, ...src])
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const allowed = new Set([
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
  return typeof code === 'string' && allowed.has(code) ? code : 'RUNNER_FAILURE'
}

function stageRequestHashes(recorder: Recorder, from: number): string[] {
  return recorder.logicalCalls.slice(from).map((item) => item.requestSha256)
}

function makeTextProvider(
  apiKey: string,
  maxOutputTokens: 1024 | 4096,
  fetcher: typeof globalThis.fetch,
): DecisionPort {
  return createOpenRouterText({
    apiKey,
    model: route.model,
    provider: route.provider,
    providerName: route.providerName,
    responseFormat: transport.responseFormat,
    maxOutputTokens,
    reasoningEffort: transport.reasoningEffort,
    fetch: fetcher,
  })
}

function providerFor(
  options: FreshTextRunnerOptions,
  fetcher: typeof globalThis.fetch,
  outputTokens: 1024 | 4096,
): DecisionPort {
  return (
    options.createDecision?.(fetcher, outputTokens) ??
    makeTextProvider(options.apiKey, outputTokens, fetcher)
  )
}

function composeTextClassifier(
  decision: DecisionPort,
  encoder: TextRepresentationEncoder | undefined,
  noImage: boolean,
  policy: ReturnType<typeof freshTextPolicyForPhase>,
) {
  const preparedDecision: DecisionPort = {
    async decide(request, signal) {
      const prompted = applyPromptVariant(request, prompt) as DecisionRequest
      const state = noImage
        ? prompted.state.filter((part) => typeof part === 'string' || part.type !== 'image_url')
        : prompted.state
      return decision.decide({ ...prompted, state }, signal)
    },
  }
  const options = {
    decision: preparedDecision,
    timeoutMs: policy.timeoutMs,
    concurrency: policy.concurrency,
    maxQueue: policy.maxQueue,
  }
  if (encoder) return createResearchClassifier(options, createTextRepresentation(encoder))
  return createClassifier(options)
}

function wholeStage(
  result: WholeObjectLocalizationResult,
): Pick<StageResult, 'status' | 'region' | 'reason'> {
  if (result.status === 'located') return { status: 'located', region: result.region }
  if (result.status === 'not-found') return { status: 'not-found', reason: result.reason }
  return { status: 'unknown', reason: result.reason }
}

async function persistCase(
  options: FreshTextRunnerOptions,
  profileId: FreshTextProfileId,
  item: FreshCase,
  bytes: Uint8Array,
  budget: RunBudget,
  outputDirectory: string,
  fetcher: typeof globalThis.fetch,
  policy: ReturnType<typeof freshTextPolicyForPhase>,
): Promise<{ result: ResultRow; calls: PhysicalCallRecord[] }> {
  const task = freshProducerTask(item)
  const caseDirectory = join(outputDirectory, item.caseId)
  await mkdir(caseDirectory, { recursive: false })
  let classify: StageResult
  let locate: StageResult | undefined
  const calls: PhysicalCallRecord[] = []
  {
    const noImage = profileId === 'no-image-control'
    const encoder = noImage ? undefined : textEncodersV1[profileId]
    const classifyRecorder = recordProvider(
      (fetchImpl) => providerFor(options, fetchImpl, policy.classifyMaxOutputTokens),
      budget,
      join(caseDirectory, 'classify'),
      route,
      fetcher,
    )
    const classifyClassifier = composeTextClassifier(
      classifyRecorder.port,
      encoder,
      noImage,
      policy,
    )
    const classifyStarted = performance.now()
    const classifyLogicalStart = classifyRecorder.logicalCalls.length
    try {
      const c = await classifyClassifier.classify({
        input: { image: bytes, text: task.question },
        classes: [
          { id: 'present', description: 'The target is visibly present in this image.' },
          { id: 'absent', description: 'The target is visibly absent from this image.' },
        ],
        instructions: 'Use only the supplied image representation. Choose one closed class.',
        ...(encoder
          ? {
              representation: {
                type: 'experimental-text' as const,
                profile: 'text-image-v1' as const,
              },
            }
          : {}),
      })
      classify = {
        status: 'ok',
        value: c.choice as 'present' | 'absent',
        durationMs: performance.now() - classifyStarted,
        calls: classifyRecorder.calls.length,
        requestHashes: stageRequestHashes(classifyRecorder, classifyLogicalStart),
      }
    } catch (error) {
      classify = {
        status: 'failed',
        durationMs: performance.now() - classifyStarted,
        calls: classifyRecorder.calls.length,
        requestHashes: stageRequestHashes(classifyRecorder, classifyLogicalStart),
        errorCode: safeErrorCode(error),
      }
    } finally {
      await classifyClassifier.dispose()
    }

    calls.push(...classifyRecorder.calls)
    if (options.stages !== 'classify-only') {
      const locateRecorder = recordProvider(
        (fetchImpl) => providerFor(options, fetchImpl, policy.locateMaxOutputTokens),
        budget,
        join(caseDirectory, 'locate'),
        route,
        fetcher,
      )
      const locateClassifier = composeTextClassifier(locateRecorder.port, encoder, noImage, policy)
      const locateStarted = performance.now()
      const locateLogicalStart = locateRecorder.logicalCalls.length
      try {
        const target = task.instruction ? `${task.target}\n${task.instruction}` : task.target
        const l = await locateClassifier.locate({
          image: bytes,
          target,
          mode: 'whole-object',
          boxTolerancePx: policy.boxTolerancePx,
          maxExtentPasses: policy.maxExtentPasses,
          ...(encoder
            ? {
                representation: {
                  type: 'experimental-text' as const,
                  profile: 'text-image-v1' as const,
                },
              }
            : {}),
        })
        const stage = wholeStage(l)
        locate = {
          ...stage,
          durationMs: performance.now() - locateStarted,
          calls: locateRecorder.calls.length,
          requestHashes: stageRequestHashes(locateRecorder, locateLogicalStart),
        }
      } catch (error) {
        locate = {
          status: 'failed',
          durationMs: performance.now() - locateStarted,
          calls: locateRecorder.calls.length,
          requestHashes: stageRequestHashes(locateRecorder, locateLogicalStart),
          errorCode: safeErrorCode(error),
        }
      } finally {
        await locateClassifier.dispose()
      }
      calls.push(...locateRecorder.calls)
    }
  }
  const row: ResultRow = {
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    profileId,
    classify,
    ...(locate ? { locate } : {}),
  }
  await writeImmutable(join(caseDirectory, 'result.json'), row)
  bytes.fill(0)
  return { result: row, calls }
}

export async function readFreshTextOpenRouterKey(): Promise<string> {
  const key = parseEnv(await readFile(keyFile, 'utf8')).OPENROUTER_API_KEY
  if (!key) throw new Error('Configured OpenRouter credential is absent')
  return key
}

export async function runFreshTextProfile(
  options: FreshTextRunnerOptions,
  profileId: FreshTextProfileId,
  signal: AbortSignal = new AbortController().signal,
) {
  if (!freshTextProfiles.includes(profileId)) throw new TypeError('Unknown fresh text profile')
  const phase = options.phase ?? 'dev'
  const purpose = validateFreshTextPhaseRequest(
    phase,
    profileId,
    options.manifests,
    options.stages ?? 'classify-and-locate',
  )
  const policy = freshTextPolicyForPhase(phase)
  const runPurpose =
    options.stages === 'classify-only'
      ? 'classification-only follow-up for pinned fresh DEV text profiles'
      : purpose
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    signal,
  )
  assertFreshTextPhaseCaseCount(
    phase,
    corpus.cases.map((item) => item.caseId),
  )
  for (const item of corpus.cases) (await loadFreshImage(item, corpus.imageRoot, signal)).fill(0)
  const source = await sourceHashes()
  const manifestCases = corpus.cases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    imageDimensions: { width: item.image.width, height: item.image.height },
  }))
  const variantSha256 = hashCanonical({
    profileId,
    encoderSha256:
      profileId === 'no-image-control' ? null : hashCanonical(textEncodersV1[profileId]),
    route,
    prompt,
    transport,
    phase,
    policy,
    stages: options.stages ?? 'classify-and-locate',
    manifestHashes: corpus.manifests,
    cases: manifestCases,
    sourceHashes: Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
  })
  const runPrefix =
    options.stages === 'classify-only'
      ? `v02-fresh-text-classify-only-${profileId}`
      : `v02-fresh-text-${profileId}`
  const runId = `${runPrefix}-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(
    policy.maxPhysicalCalls,
    policy.maxCostUsd,
    policy.unknownCostReserveUsd,
  )
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    phase,
    purpose: runPurpose,
    startedAt: new Date().toISOString(),
    profileId,
    stages: options.stages ?? 'classify-and-locate',
    variantSha256,
    sourceHashes: source,
    producerSourceSha256: hashCanonical(
      Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
    ),
    manifests: corpus.manifests,
    plannedCaseIds: manifestCases.map((item) => item.caseId),
    plannedCases: manifestCases,
    route,
    prompt,
    promptSha256: hashCanonical(prompt),
    transport,
    transportSha256: hashCanonical(transport),
    policy,
    modelBoundary: {
      evaluatorTruthRead: false,
      retries: 0,
      fallback: false,
      imagePartsRemoved: profileId === 'no-image-control',
      textEncoder: profileId === 'no-image-control' ? null : profileId,
      segmentation: false,
      ocr: false,
    },
  })
  const results: ResultRow[] = []
  const allCalls: PhysicalCallRecord[] = []
  for (const item of corpus.cases) {
    const bytes = await loadFreshImage(item, corpus.imageRoot, signal)
    try {
      const outcome = await persistCase(
        options,
        profileId,
        item,
        bytes,
        budget,
        outputDirectory,
        options.fetch ?? globalThis.fetch,
        policy,
      )
      results.push(outcome.result)
      allCalls.push(...outcome.calls)
    } catch (error) {
      bytes.fill(0)
      const failed: ResultRow = {
        caseId: item.caseId,
        imageSha256: item.image.sha256,
        profileId,
        classify: {
          status: 'failed',
          errorCode: safeErrorCode(error),
          durationMs: 0,
          calls: 0,
          requestHashes: [],
        },
        ...(options.stages === 'classify-only'
          ? {}
          : {
              locate: {
                status: 'failed' as const,
                errorCode: safeErrorCode(error),
                durationMs: 0,
                calls: 0,
                requestHashes: [],
              },
            }),
      }
      results.push(failed)
      await writeImmutable(join(outputDirectory, item.caseId, 'result.json'), failed)
    }
  }
  const plannedCaseIds = manifestCases.map((item) => item.caseId)
  const completedCaseIds = results.map((item) => item.caseId)
  const completeSet = new Set(completedCaseIds)
  const missingCaseIds = plannedCaseIds.filter((id) => !completeSet.has(id))
  const summary = {
    runId,
    profileId,
    phase,
    purpose: runPurpose,
    variantSha256,
    status: missingCaseIds.length === 0 ? 'complete' : 'incomplete',
    plannedCaseIds,
    completedCaseIds,
    missingCaseIds,
    results,
    aggregate: budget.snapshot(),
    policy,
    latencyEnvironment: policy.latencyEnvironment,
    latencyRankingEligible: policy.latencyRankingEligible,
    physicalReceipts: allCalls.map((call) => ({
      physicalId: call.physicalId,
      requestSha256: call.requestSha256,
      route: call.route,
      receipt: call.receipt,
      wireReceipt: call.wireReceipt,
      errorCode: call.errorCode ?? null,
      durationMs: call.durationMs,
    })),
  }
  await writeImmutable(join(outputDirectory, 'summary.json'), summary)
  await writeImmutable(join(outputDirectory, 'run-complete.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
  })
  return { ...summary, outputDirectory }
}
