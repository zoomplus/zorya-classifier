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
import { ClassifierError } from '../../src/entities/errors.js'
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
import type { HeldoutNoImagePlan } from './categorical-heldout-plan.js'
import { assertVerifiedHeldoutFreeze, buildHeldoutPlans } from './categorical-heldout-plan.js'

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
const neutralLocateInstruction =
  'Locate the visible physical instance of the named object; return unknown when unsupported.'

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
    unknownCostReserveUsd: 0.05,
    maxInFlight: 1,
    maxInFlightCases: 1,
    maxPhysicalCallsPerCase: 6,
    worstCasePhysicalCalls: 240,
    latencyEnvironment: 'heldout-no-image-control-unranked',
    latencyRankingEligible: false,
  })
}

export function validateFreshTextPhaseRequest(
  phase: FreshTextPhase,
  profileId: FreshTextProfileId,
  manifests: readonly { path: string; sha256: string }[],
  stages: 'classify-and-locate' | 'classify-only' = 'classify-and-locate',
  expectedHeldoutPhotoSha256 = heldoutPhotoInputSha256,
): string {
  if (phase === 'dev') return 'single-profile complete pinned fresh DEV text/no-image comparison'
  if (phase !== 'heldout') throw new TypeError('Unknown fresh text phase')
  if (profileId !== 'no-image-control')
    throw new Error('Heldout text control requires the no-image-control profile')
  if (stages !== 'classify-and-locate')
    throw new Error('Heldout text control requires classify-and-locate stages')
  if (
    manifests.length !== 1 ||
    manifests[0]?.sha256 !== expectedHeldoutPhotoSha256 ||
    manifests[0]?.path.trim().length === 0
  )
    throw new Error('Heldout text control requires the frozen 40-photo input manifest')
  return 'full frozen HELDOUT photo-only no-image text control run'
}

export function assertFreshTextPhaseCaseCount(phase: FreshTextPhase, caseIds: readonly string[]) {
  if (phase === 'heldout' && (caseIds.length !== 40 || new Set(caseIds).size !== 40))
    throw new Error('Heldout text control must contain exactly 40 unique photo cases')
}

export class FreshTextCaseBudget extends RunBudget {
  private readonly globalToLocal = new Map<number, number>()

  constructor(
    private readonly runBudget: RunBudget,
    phase: FreshTextPhase,
  ) {
    super(6, 5, 0.05, phase)
  }

  override admit(): number {
    const localId = super.admit()
    try {
      const globalId = this.runBudget.admit()
      this.globalToLocal.set(globalId, localId)
      return globalId
    } catch (error) {
      super.cancelBeforeFetch(localId)
      throw error
    }
  }

  override settle(globalId: number, costUsd: number | null): void {
    const localId = this.globalToLocal.get(globalId)
    if (localId === undefined) throw new Error('Unknown text per-case physical call')
    this.globalToLocal.delete(globalId)
    this.runBudget.settle(globalId, costUsd)
    super.settle(localId, costUsd)
  }

  override cancelBeforeFetch(globalId: number): void {
    const localId = this.globalToLocal.get(globalId)
    if (localId === undefined) throw new Error('Unknown text per-case reservation')
    this.globalToLocal.delete(globalId)
    try {
      this.runBudget.cancelBeforeFetch(globalId)
    } catch {
      this.runBudget.settle(globalId, null)
    }
    super.cancelBeforeFetch(localId)
  }
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
  /** Supplied only by the separately frozen HELDOUT no-image entry point. */
  heldoutPlan?: HeldoutNoImagePlan
  /** Offline-only failure injection for immutable result persistence and disposal. */
  testHooks?: {
    writeCaseResult?: (path: string, result: unknown) => Promise<void>
    afterClassifierDispose?: () => Promise<void>
  }
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
  profileId: string
  classify: StageResult
  locate?: StageResult
}

export interface NoImageFetchAudit {
  fetchAttempts: number
  fetchesChecked: number
  zeroImagePartsConfirmed: number
  zeroImageDerivedStateConfirmed: number
  imagePartViolations: number
  unverifiableBodies: number
}

function containsImagePayload(value: unknown): boolean {
  if (typeof value === 'string')
    return (
      /^(?:data:image\/|data:application\/octet-stream;base64,)/iu.test(value) ||
      (value.length > 32 * 1024 && /^[A-Za-z0-9+/=\s]+$/u.test(value))
    )
  if (Array.isArray(value)) return value.some(containsImagePayload)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, nested]) =>
      /image|input_image/iu.test(key) ||
      (key === 'type' &&
        typeof nested === 'string' &&
        /^(?:image|image_url|input_image)$/iu.test(nested)) ||
      containsImagePayload(nested),
  )
}

export function auditNoImageFetch(
  fetcher: typeof globalThis.fetch,
  audit: NoImageFetchAudit,
): typeof globalThis.fetch {
  return async (input, init) => {
    audit.fetchAttempts += 1
    const body = init?.body
    if (typeof body !== 'string') {
      audit.unverifiableBodies += 1
      throw new ClassifierError('INVALID_RESPONSE', 'No-image request body was not auditable')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      audit.unverifiableBodies += 1
      throw new ClassifierError('INVALID_RESPONSE', 'No-image request body was not valid JSON')
    }
    audit.fetchesChecked += 1
    if (containsImagePayload(parsed)) {
      audit.imagePartViolations += 1
      throw new ClassifierError('INVALID_RESPONSE', 'No-image request contained image payload')
    }
    audit.zeroImagePartsConfirmed += 1
    audit.zeroImageDerivedStateConfirmed += 1
    return fetcher(input, init)
  }
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

export async function freshTextProducerSourceSha256(): Promise<string> {
  const hashes = await sourceHashes()
  return hashCanonical(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
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
  signal: AbortSignal,
  budget: RunBudget,
  outputDirectory: string,
  fetcher: typeof globalThis.fetch,
  policy: ReturnType<typeof freshTextPolicyForPhase>,
  outputProfileId: string = profileId,
  noImageAudit?: NoImageFetchAudit,
  recordersByCase?: Map<string, Array<{ stage: 'classify' | 'locate'; recorder: Recorder }>>,
): Promise<{ result: ResultRow; calls: PhysicalCallRecord[] }> {
  const task = freshProducerTask(item)
  const caseBudget = new FreshTextCaseBudget(budget, options.phase ?? 'dev')
  const caseDirectory = join(outputDirectory, item.caseId)
  await mkdir(caseDirectory, { recursive: false })
  let classify: StageResult
  let locate: StageResult | undefined
  const calls: PhysicalCallRecord[] = []
  {
    const noImage = profileId === 'no-image-control'
    const encoder = noImage ? undefined : textEncodersV1[profileId]
    const auditedFetcher = noImageAudit ? auditNoImageFetch(fetcher, noImageAudit) : fetcher
    const classifyRecorder = recordProvider(
      (fetchImpl) => providerFor(options, fetchImpl, policy.classifyMaxOutputTokens),
      caseBudget,
      join(caseDirectory, 'classify'),
      route,
      auditedFetcher,
    )
    if (recordersByCase) {
      const recorders = recordersByCase.get(item.caseId) ?? []
      recorders.push({ stage: 'classify', recorder: classifyRecorder })
      recordersByCase.set(item.caseId, recorders)
    }
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
        signal,
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
      await options.testHooks?.afterClassifierDispose?.()
    }

    calls.push(...classifyRecorder.calls)
    if (options.stages !== 'classify-only' && !signal.aborted) {
      const locateRecorder = recordProvider(
        (fetchImpl) => providerFor(options, fetchImpl, policy.locateMaxOutputTokens),
        caseBudget,
        join(caseDirectory, 'locate'),
        route,
        auditedFetcher,
      )
      if (recordersByCase) {
        const recorders = recordersByCase.get(item.caseId) ?? []
        recorders.push({ stage: 'locate', recorder: locateRecorder })
        recordersByCase.set(item.caseId, recorders)
      }
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
          signal,
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
        await options.testHooks?.afterClassifierDispose?.()
      }
      calls.push(...locateRecorder.calls)
    } else if (options.stages !== 'classify-only' && signal.aborted) {
      locate = {
        status: 'failed',
        durationMs: 0,
        calls: 0,
        requestHashes: [],
        errorCode: 'ABORTED',
      }
    }
  }
  const row: ResultRow = {
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    profileId: outputProfileId,
    classify,
    ...(locate ? { locate } : {}),
  }
  const resultPath = join(caseDirectory, 'result.json')
  if (options.testHooks?.writeCaseResult) await options.testHooks.writeCaseResult(resultPath, row)
  else await writeImmutable(resultPath, row)
  bytes.fill(0)
  return { result: row, calls }
}

export async function readFreshTextOpenRouterKey(): Promise<string> {
  const key = parseEnv(await readFile(keyFile, 'utf8')).OPENROUTER_API_KEY
  if (!key) throw new Error('Configured OpenRouter credential is absent')
  return key
}

/** Separate explicit HELDOUT entry point. It accepts only the strict frozen plan. */
export async function runCategoricalHeldoutNoImageControl(
  options: Omit<FreshTextRunnerOptions, 'phase' | 'heldoutPlan'>,
  freezeInput: unknown,
  signal: AbortSignal = new AbortController().signal,
) {
  assertVerifiedHeldoutFreeze(freezeInput)
  const plans = buildHeldoutPlans(freezeInput)
  return runFreshTextProfile(
    { ...options, phase: 'heldout', heldoutPlan: plans.noImage },
    'no-image-control',
    signal,
  )
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
    options.heldoutPlan?.manifest.sha256,
  )
  if (phase === 'heldout' && !options.heldoutPlan)
    throw new TypeError('A strict frozen HELDOUT no-image plan is required')
  if (
    phase === 'heldout' &&
    options.heldoutPlan?.profileId !== 'deepseek-flash-no-image-photo-heldout-v1'
  )
    throw new TypeError('HELDOUT no-image control profile identity is invalid')
  const policy = freshTextPolicyForPhase(phase)
  const outputProfileId = options.heldoutPlan?.profileId ?? profileId
  const runPurpose =
    options.stages === 'classify-only'
      ? 'classification-only follow-up for pinned fresh DEV text profiles'
      : purpose
  const source = await sourceHashes()
  const producerSourceSha256 = hashCanonical(
    Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
  )
  if (
    phase === 'heldout' &&
    producerSourceSha256 !== options.heldoutPlan?.noImageProducerSourceSha256
  )
    throw new TypeError('HELDOUT no-image producer source does not match frozen source digest')
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    signal,
  )
  if (
    phase === 'heldout' &&
    (corpus.manifests.length !== 1 ||
      corpus.manifests[0]?.sha256 !== options.heldoutPlan?.manifest.sha256 ||
      corpus.manifests[0]?.cases !== 40)
  )
    throw new TypeError('HELDOUT no-image control requires the frozen 40-photo manifest')
  assertFreshTextPhaseCaseCount(
    phase,
    corpus.cases.map((item) => item.caseId),
  )
  if (
    phase === 'heldout' &&
    corpus.cases.some(
      (item) =>
        item.locate.instruction !== undefined &&
        item.locate.instruction !== neutralLocateInstruction,
    )
  )
    throw new TypeError('HELDOUT no-image case contains an unapproved locate instruction')
  for (const item of corpus.cases) (await loadFreshImage(item, corpus.imageRoot, signal)).fill(0)
  const manifestCases = corpus.cases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    imageDimensions: { width: item.image.width, height: item.image.height },
  }))
  const variantSha256 = hashCanonical({
    outputProfileId,
    encoderSha256:
      profileId === 'no-image-control' ? null : hashCanonical(textEncodersV1[profileId]),
    route,
    routePolicy:
      phase === 'heldout'
        ? {
            responseFormat: transport.responseFormat,
            reasoningEffort: transport.reasoningEffort,
            promptVariant: 'grammar-plus-examples',
            transportVariant: 'none-json-schema',
            imagePartsRemoved: true,
            textEncoder: null,
            objectProposals: null,
            segmentation: false,
            ocr: false,
          }
        : undefined,
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
    phase === 'heldout'
      ? (options.heldoutPlan?.runIdPrefix ?? 'v02-heldout-no-image')
      : options.stages === 'classify-only'
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
    profileId: outputProfileId,
    stages: options.stages ?? 'classify-and-locate',
    variantSha256,
    sourceHashes: source,
    producerSourceSha256,
    sourceBeforeSha256: producerSourceSha256,
    ...(phase === 'heldout'
      ? {
          targetPolicy: options.heldoutPlan?.targetPolicy,
          methodSelectionSha256: options.heldoutPlan?.methodSelectionSha256,
          heldoutProducerSourceSha256: options.heldoutPlan?.producerSourceSha256,
          producerSourceRole: 'producer-only',
        }
      : {}),
    manifests: corpus.manifests,
    plannedCaseIds: manifestCases.map((item) => item.caseId),
    plannedCases: manifestCases,
    route,
    ...(phase === 'heldout'
      ? {
          routePolicy: {
            responseFormat: transport.responseFormat,
            reasoningEffort: transport.reasoningEffort,
            promptVariant: 'grammar-plus-examples',
            transportVariant: 'none-json-schema',
            imagePartsRemoved: true,
            textEncoder: null,
            objectProposals: null,
            segmentation: false,
            ocr: false,
          },
        }
      : {}),
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
    ...(phase === 'heldout' && profileId === 'no-image-control'
      ? {
          imagePartAudit: {
            method: 'inspect-every-serialized-provider-request-before-fetch-v1',
            expectedImageParts: 0,
            expectedEncodedImageState: false,
            rawBodiesPersisted: false,
          },
        }
      : {}),
  })
  const results: ResultRow[] = []
  const recordersByCase = new Map<
    string,
    Array<{ stage: 'classify' | 'locate'; recorder: Recorder }>
  >()
  let fatalCaseFailure:
    | { caseId: string; errorCode: string; artifactErrorCode?: string }
    | undefined
  const noImageAudit: NoImageFetchAudit | undefined =
    phase === 'heldout' && profileId === 'no-image-control'
      ? {
          fetchAttempts: 0,
          fetchesChecked: 0,
          zeroImagePartsConfirmed: 0,
          zeroImageDerivedStateConfirmed: 0,
          imagePartViolations: 0,
          unverifiableBodies: 0,
        }
      : undefined
  for (const item of corpus.cases) {
    if (signal.aborted) break
    let bytes: Uint8Array | undefined
    try {
      bytes = await loadFreshImage(item, corpus.imageRoot, signal)
      const outcome = await persistCase(
        options,
        profileId,
        item,
        bytes,
        signal,
        budget,
        outputDirectory,
        options.fetch ?? globalThis.fetch,
        policy,
        outputProfileId,
        noImageAudit,
        recordersByCase,
      )
      results.push(outcome.result)
      if (signal.aborted) break
    } catch (error) {
      bytes?.fill(0)
      const errorCode = safeErrorCode(error)
      const caseRecorders = recordersByCase.get(item.caseId) ?? []
      const classifyRecorder = caseRecorders.find((entry) => entry.stage === 'classify')?.recorder
      const locateRecorder = caseRecorders.find((entry) => entry.stage === 'locate')?.recorder
      const classifyCalls = classifyRecorder?.calls.length ?? 0
      const locateCalls = locateRecorder?.calls.length ?? 0
      const failed: ResultRow = {
        caseId: item.caseId,
        imageSha256: item.image.sha256,
        profileId: outputProfileId,
        classify: {
          status: 'failed',
          errorCode,
          durationMs: 0,
          calls: classifyCalls,
          requestHashes:
            classifyRecorder?.logicalCalls.map((logical) => logical.requestSha256) ?? [],
        },
        ...(options.stages === 'classify-only'
          ? {}
          : {
              locate: {
                status: 'failed' as const,
                errorCode,
                durationMs: 0,
                calls: locateCalls,
                requestHashes:
                  locateRecorder?.logicalCalls.map((logical) => logical.requestSha256) ?? [],
              },
            }),
      }
      results.push(failed)
      let artifactErrorCode: string | undefined
      try {
        await mkdir(join(outputDirectory, item.caseId), { recursive: true })
        await writeImmutable(join(outputDirectory, item.caseId, 'result.json'), failed)
      } catch (artifactError) {
        // Existing success artifacts and any failed immutable writes are preserved verbatim.
        artifactErrorCode = safeErrorCode(artifactError)
      }
      fatalCaseFailure = {
        caseId: item.caseId,
        errorCode,
        ...(artifactErrorCode ? { artifactErrorCode } : {}),
      }
      break
    }
  }
  const plannedCaseIds = manifestCases.map((item) => item.caseId)
  const completedCaseIds = results.map((item) => item.caseId)
  const completeSet = new Set(completedCaseIds)
  const missingCaseIds = plannedCaseIds.filter((id) => !completeSet.has(id))
  const sourceAfter = await sourceHashes()
  const sourceAfterSha256 = hashCanonical(
    Object.entries(sourceAfter).sort(([a], [b]) => a.localeCompare(b)),
  )
  const sourceUnchanged = sourceAfterSha256 === producerSourceSha256
  const receiptCases = [...recordersByCase.entries()].flatMap(([caseId, recorders]) =>
    recorders.flatMap(({ stage, recorder }) =>
      recorder.calls.map((call) => ({ caseId, stage, call })),
    ),
  )
  const noImageAuditComplete =
    !noImageAudit ||
    (noImageAudit.fetchAttempts === noImageAudit.zeroImagePartsConfirmed &&
      noImageAudit.fetchesChecked === noImageAudit.zeroImagePartsConfirmed &&
      noImageAudit.fetchAttempts === noImageAudit.zeroImageDerivedStateConfirmed &&
      noImageAudit.imagePartViolations === 0 &&
      noImageAudit.unverifiableBodies === 0 &&
      noImageAudit.fetchAttempts === receiptCases.filter((entry) => entry.call.dispatched).length)
  const summary = {
    runId,
    profileId: outputProfileId,
    phase,
    purpose: runPurpose,
    variantSha256,
    ...(phase === 'heldout'
      ? {
          targetPolicy: options.heldoutPlan?.targetPolicy,
          methodSelectionSha256: options.heldoutPlan?.methodSelectionSha256,
        }
      : {}),
    producerSourceSha256,
    sourceBeforeSha256: producerSourceSha256,
    sourceAfterSha256,
    sourceUnchanged,
    status:
      missingCaseIds.length === 0 &&
      sourceUnchanged &&
      noImageAuditComplete &&
      fatalCaseFailure === undefined &&
      !signal.aborted
        ? 'complete'
        : 'incomplete',
    plannedCaseIds,
    completedCaseIds,
    missingCaseIds,
    failure: fatalCaseFailure ?? (signal.aborted ? { errorCode: 'ABORTED' } : null),
    results,
    aggregate: budget.snapshot(),
    policy,
    latencyEnvironment: policy.latencyEnvironment,
    latencyRankingEligible: policy.latencyRankingEligible,
    physicalReceipts: receiptCases.map(({ caseId, stage, call }) => ({
      caseId,
      stage,
      physicalId: call.physicalId,
      logicalId: call.logicalId,
      requestSha256: call.requestSha256,
      requestBodySha256: call.requestBodySha256,
      admittedAt: call.admittedAt,
      httpStatus: call.httpStatus,
      route: call.route,
      receipt: call.receipt,
      wireReceipt: call.wireReceipt,
      errorCode: call.errorCode ?? null,
      durationMs: call.durationMs,
    })),
    ...(phase === 'heldout' && noImageAudit
      ? {
          imagePartAudit: {
            fetchesChecked: noImageAudit.fetchesChecked,
            fetchAttempts: noImageAudit.fetchAttempts,
            zeroImagePartsConfirmed: noImageAudit.zeroImagePartsConfirmed,
            zeroImageDerivedStateConfirmed: noImageAudit.zeroImageDerivedStateConfirmed,
            imagePartViolations: noImageAudit.imagePartViolations,
            unverifiableBodies: noImageAudit.unverifiableBodies,
            complete: noImageAuditComplete,
          },
        }
      : {}),
  }
  await writeImmutable(join(outputDirectory, 'summary.json'), summary)
  if (summary.status === 'complete') {
    await writeImmutable(join(outputDirectory, 'run-complete.json'), {
      runId,
      completedAt: new Date().toISOString(),
      summarySha256: sha256(JSON.stringify(summary)),
      producerSourceSha256,
      sourceBeforeSha256: producerSourceSha256,
      sourceAfterSha256,
      sourceUnchanged,
    })
  } else {
    await writeImmutable(join(outputDirectory, 'incomplete-evidence.json'), {
      runId,
      phase,
      status: 'incomplete',
      failure: summary.failure,
      summarySha256: sha256(JSON.stringify(summary)),
      plannedCaseIds,
      completedCaseIds,
      missingCaseIds,
      aggregate: summary.aggregate,
      physicalReceiptCount: receiptCases.length,
      imagePartAudit: summary.imagePartAudit ?? null,
    })
  }
  return { ...summary, outputDirectory }
}
