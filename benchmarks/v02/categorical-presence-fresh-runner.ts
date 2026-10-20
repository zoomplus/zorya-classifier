import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Classifier } from '../../src/app/create-classifier.js'
import { createClassifier } from '../../src/app/create-classifier.js'
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
import { createNativeCategoricalPresencePort } from './native-categorical-presence-port.js'
import type { HeldoutCandidatePlan } from './categorical-heldout-plan.js'
import { assertVerifiedHeldoutFreeze, buildHeldoutPlans } from './categorical-heldout-plan.js'
import type { BoxHeldoutCandidatePlan } from './categorical-box-heldout-plan.js'
import {
  assertVerifiedBoxHeldoutFreeze,
  buildBoxHeldoutPlans,
  boxHeldoutCandidatePolicy,
} from './categorical-box-heldout-plan.js'
import { categoricalBoxHeldoutProducerSourceManifest as boxHeldoutSourceManifest } from './categorical-box-heldout-source.js'

type CategoricalTargetPolicy = 'target-plus-neutral-instruction-v1' | 'target-only-v1'

const keyFile = '/root/work/element/.env.local'

export const CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE = 6
export const CATEGORICAL_FRESH_MAX_PHYSICAL_PER_PROFILE =
  40 * CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE

export const freshProposalRoute = Object.freeze({
  id: 'openai-gpt-6-luna-decisions-openai-v1',
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
})

export const categoricalFreshPolicy = Object.freeze({
  timeoutMs: 120_000,
  maxInFlight: 2,
  maxInFlightCases: 2,
  nativeMaxActive: 1,
  nativeMaxWaiting: 2,
  nativeThreads: 2,
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  maxPhysicalCallsPerCase: CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE,
  worstCaseCallsAcross40: CATEGORICAL_FRESH_MAX_PHYSICAL_PER_PROFILE,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 300,
  maxCostUsd: 5,
  unknownCostReserveUsd: 0.05,
  latencyEnvironment: 'concurrent-development-runner-unranked',
  latencyRankingEligible: false,
})

export const categoricalHeldoutPolicy = Object.freeze({
  timeoutMs: categoricalFreshPolicy.timeoutMs,
  maxInFlight: categoricalFreshPolicy.maxInFlight,
  maxInFlightCases: categoricalFreshPolicy.maxInFlightCases,
  nativeMaxActive: categoricalFreshPolicy.nativeMaxActive,
  nativeMaxWaiting: categoricalFreshPolicy.nativeMaxWaiting,
  nativeThreads: categoricalFreshPolicy.nativeThreads,
  boxTolerancePx: categoricalFreshPolicy.boxTolerancePx,
  maxExtentPasses: categoricalFreshPolicy.maxExtentPasses,
  maxPhysicalCallsPerCase: categoricalFreshPolicy.maxPhysicalCallsPerCase,
  expectedCaseCount: 80,
  worstCasePhysicalCalls: 480,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 600,
  maxCostUsd: 10,
  unknownCostReserveUsd: 0.05,
  latencyEnvironment: 'heldout-development-soak-unranked',
  latencyRankingEligible: false,
})

export const categoricalTargetInstruction =
  'Locate the visible physical instance of the named object; return unknown when unsupported.'

export const categoricalFreshProfiles = Object.freeze({
  preserveInstruction: Object.freeze({
    id: 'native-luna-categorical-presence-sam-target-plus-neutral-v1',
    targetPolicy: 'target-plus-neutral-instruction-v1',
  }),
  targetOnly: Object.freeze({
    id: 'native-luna-categorical-presence-sam-target-only-v1',
    targetPolicy: 'target-only-v1',
  }),
  boxConfirmation: Object.freeze({
    id: 'native-luna-box-confirmation-sam-target-plus-neutral-v1',
    targetPolicy: 'target-plus-neutral-instruction-v1',
  }),
})

type CategoricalFreshProfile =
  (typeof categoricalFreshProfiles)[keyof typeof categoricalFreshProfiles]

function heldoutProfile(plan: HeldoutCandidatePlan): {
  id: string
  targetPolicy: CategoricalTargetPolicy
} {
  return {
    id: plan.profileId,
    targetPolicy: plan.targetPolicy,
  }
}

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

export const categoricalFreshProducerSourceFiles = [
  './categorical-presence-fresh-runner.ts',
  './run-categorical-presence-fresh.ts',
  './run-categorical-box-confirmation-dev.ts',
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
] as const

export interface FreshProposalRunnerOptions {
  manifests: Array<{ path: string; sha256: string }>
  imageRoot: string
  outputRoot: string
  apiKey: string
  encoderPath: string
  decoderPath: string
  /** Test-only fixture size; production callers leave this at the full DEV denominator of 40. */
  expectedCaseCount?: number
  fetch?: typeof globalThis.fetch
  /** Offline fixture seam; production initializes one explicit CPU MobileSAM adapter. */
  createObjectProposals?: (input: {
    encoderPath: string
    decoderPath: string
  }) => Promise<ObjectProposalPort>
  /** Offline-only failure injection for persistence lifecycle tests. */
  testHooks?: {
    makeCaseDirectory?: (path: string) => Promise<void>
    writeCaseResult?: (path: string, value: unknown) => Promise<void>
  }
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

export interface FreshProposalResult {
  caseId: string
  imageSha256: string
  classify: StageRecord
  locate: StageRecord
  extract: ExtractRecord
}

export interface ExtractRecord {
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

export async function categoricalFreshProducerSourceManifest(): Promise<Record<string, string>> {
  return categoricalProducerSourceManifest(categoricalFreshProducerSourceFiles)
}

/** Separate closure for the box-confirmation heldout profile; legacy closure stays unchanged. */
export async function categoricalBoxHeldoutProducerSourceManifest(): Promise<
  Record<string, string>
> {
  return boxHeldoutSourceManifest()
}

export async function categoricalBoxHeldoutProducerSourceSha256(): Promise<string> {
  const hashes = await categoricalBoxHeldoutProducerSourceManifest()
  return hashCanonical(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
}

async function categoricalProducerSourceManifest(
  benchmarkFiles: readonly string[],
): Promise<Record<string, string>> {
  const bench = await Promise.all(
    [...new Set(benchmarkFiles)].map(
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

export async function categoricalFreshProducerSourceSha256(): Promise<string> {
  const hashes = await categoricalFreshProducerSourceManifest()
  return hashCanonical(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
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

export function validateTargetPolicyTasks(items: readonly FreshCase[]): void {
  for (const item of items) {
    const instruction = item.locate.instruction
    if (instruction !== undefined && instruction !== categoricalTargetInstruction)
      throw Object.assign(new Error('Fresh case has an unapproved locate instruction'), {
        code: 'INVALID_INPUT',
      })
  }
}

export function targetForProfile(
  item: FreshCase,
  profile: { id: string; targetPolicy: CategoricalTargetPolicy },
): string {
  const task = taskFor(item)
  validateTargetPolicyTasks([item])
  return profile.targetPolicy === 'target-only-v1' || !task.instruction
    ? task.target
    : `${task.target}\n${task.instruction}`
}

export function assertCategoricalFreshCallBound(maxPhysicalCalls: number): void {
  if (
    maxPhysicalCalls < CATEGORICAL_FRESH_MAX_PHYSICAL_PER_PROFILE ||
    maxPhysicalCalls > categoricalFreshPolicy.maxPhysicalCalls
  )
    throw new RangeError('Full DEV profile budget must cover 40 six-call cases and stay under cap')
}

export function assertCategoricalHeldoutCallBound(maxPhysicalCalls: number): void {
  if (maxPhysicalCalls < 80 * CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE || maxPhysicalCalls > 600)
    throw new RangeError('HELDOUT profile budget must cover 80 six-call cases and stay under cap')
}

/** Reserves against the shared run ledger while enforcing a per-case six-fetch ceiling. */
export class CategoricalFreshCaseBudget extends RunBudget {
  private readonly globalToLocal = new Map<number, number>()

  constructor(
    private readonly runBudget: RunBudget,
    phase: 'dev' | 'heldout' = 'dev',
  ) {
    super(CATEGORICAL_FRESH_MAX_PHYSICAL_PER_CASE, phase === 'heldout' ? 10 : 5, 0.05, phase)
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
    if (localId === undefined) throw new Error('Unknown per-case physical call')
    this.globalToLocal.delete(globalId)
    this.runBudget.settle(globalId, costUsd)
    super.settle(localId, costUsd)
  }

  override cancelBeforeFetch(globalId: number): void {
    const localId = this.globalToLocal.get(globalId)
    if (localId === undefined) throw new Error('Unknown per-case reservation')
    this.globalToLocal.delete(globalId)
    try {
      this.runBudget.cancelBeforeFetch(globalId)
    } catch {
      // A concurrent case may have admitted a later call. Keep the abandoned reservation charged.
      this.runBudget.settle(globalId, null)
    }
    super.cancelBeforeFetch(localId)
  }
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
  return createOpenRouterDecisions({
    apiKey: options.apiKey,
    model: freshProposalRoute.model,
    provider: freshProposalRoute.provider,
    providerName: freshProposalRoute.providerName,
    fetch: fetcher,
  })
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
export async function runCategoricalPresenceFreshDev(
  options: FreshProposalRunnerOptions,
  profile: CategoricalFreshProfile,
  signal: AbortSignal = new AbortController().signal,
) {
  return runCategoricalFreshProfile(options, profile, signal)
}

/** Runs the separately named box-confirmation DEV recipe without changing the paired profiles. */
export async function runCategoricalPresenceFreshBoxConfirmationDev(
  options: FreshProposalRunnerOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  return runCategoricalFreshProfile(options, categoricalFreshProfiles.boxConfirmation, signal)
}

/** The distinct HELDOUT path requires a frozen config before it can read producer inputs. */
export async function runCategoricalPresenceFreshHeldout(
  options: FreshProposalRunnerOptions,
  freezeInput: unknown,
  signal: AbortSignal = new AbortController().signal,
) {
  assertVerifiedHeldoutFreeze(freezeInput)
  const plans = buildHeldoutPlans(freezeInput)
  const source = await categoricalFreshProducerSourceManifest()
  const actualSourceSha256 = hashCanonical(
    Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
  )
  if (actualSourceSha256 !== plans.candidate.producerSourceSha256)
    throw new TypeError('HELDOUT producer source does not match frozen source digest')
  if (options.expectedCaseCount !== undefined && options.expectedCaseCount !== 80)
    throw new TypeError('HELDOUT candidate requires exactly 80 cases')
  const profile = heldoutProfile(plans.candidate)
  return runCategoricalFreshProfile(
    { ...options, expectedCaseCount: 80 },
    profile,
    signal,
    actualSourceSha256,
    'heldout',
    plans.candidate,
  )
}

/** Separate heldout recipe bound to the box-confirmation method-selection digest. */
export async function runCategoricalPresenceBoxHeldout(
  options: FreshProposalRunnerOptions,
  freezeInput: unknown,
  signal: AbortSignal = new AbortController().signal,
) {
  assertVerifiedBoxHeldoutFreeze(freezeInput)
  const plans = buildBoxHeldoutPlans(freezeInput)
  const source = await categoricalBoxHeldoutProducerSourceManifest()
  const actualSourceSha256 = hashCanonical(
    Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
  )
  if (actualSourceSha256 !== plans.candidate.producerSourceSha256)
    throw new TypeError('Box HELDOUT producer source does not match frozen source digest')
  if (options.expectedCaseCount !== undefined && options.expectedCaseCount !== 80)
    throw new TypeError('Box HELDOUT candidate requires exactly 80 cases')
  return runCategoricalFreshProfile(
    { ...options, expectedCaseCount: 80 },
    { id: plans.candidate.profileId, targetPolicy: plans.candidate.targetPolicy },
    signal,
    actualSourceSha256,
    'heldout',
    plans.candidate,
    true,
  )
}

/** Runs the two predeclared target-policy profiles serially, each with its own hard budget. */
export async function runCategoricalPresenceFreshPair(
  options: FreshProposalRunnerOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  const pairedSource = await categoricalFreshProducerSourceManifest()
  const expectedSourceSha256 = hashCanonical(
    Object.entries(pairedSource).sort(([a], [b]) => a.localeCompare(b)),
  )
  const preserve = await runCategoricalFreshProfile(
    options,
    categoricalFreshProfiles.preserveInstruction,
    signal,
    expectedSourceSha256,
  )
  if (preserve.status !== 'complete' || !preserve.sourceUnchanged)
    return { preserve, targetOnly: null }
  const targetOnly = await runCategoricalFreshProfile(
    options,
    categoricalFreshProfiles.targetOnly,
    signal,
    expectedSourceSha256,
  )
  return { preserve, targetOnly }
}

async function runCategoricalFreshProfile(
  options: FreshProposalRunnerOptions,
  profile: { id: string; targetPolicy: CategoricalTargetPolicy },
  signal: AbortSignal,
  expectedSourceSha256?: string,
  phase: 'dev' | 'heldout' = 'dev',
  heldoutPlan?: HeldoutCandidatePlan | BoxHeldoutCandidatePlan,
  boxHeldout = false,
) {
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    signal,
  )
  const source = await (boxHeldout
    ? categoricalBoxHeldoutProducerSourceManifest()
    : categoricalFreshProducerSourceManifest())
  const producerSourceSha256 = hashCanonical(
    Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
  )
  if (expectedSourceSha256 && producerSourceSha256 !== expectedSourceSha256)
    throw new TypeError('Profile producer source does not match its frozen source digest')
  const caseManifest = corpus.cases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    imageDimensions: { width: item.image.width, height: item.image.height },
  }))
  const taskManifest = corpus.cases.map((item) => ({
    caseId: item.caseId,
    task: taskFor(item),
  }))
  const expectedCaseCount = options.expectedCaseCount ?? (phase === 'heldout' ? 80 : 40)
  if (!Number.isInteger(expectedCaseCount) || expectedCaseCount < 1 || expectedCaseCount > 120)
    throw new TypeError('Expected fresh corpus case count must be between 1 and 120')
  if (corpus.cases.length !== expectedCaseCount)
    throw new TypeError(`Fresh DEV manifest set must contain exactly ${expectedCaseCount} cases`)
  if (phase === 'heldout') {
    if (
      !heldoutPlan ||
      expectedCaseCount !== 80 ||
      corpus.manifests.length !== 3 ||
      corpus.manifests.some(
        (manifest, index) =>
          manifest.sha256 !== heldoutPlan.manifests[index]?.sha256 ||
          manifest.cases !== heldoutPlan.manifests[index]?.cases,
      ) ||
      corpus.manifests[0]?.cases !== 40 ||
      corpus.manifests[1]?.cases !== 20 ||
      corpus.manifests[2]?.cases !== 20
    )
      throw new TypeError('HELDOUT profile requires its frozen 40-photo/20-UI/20-map set')
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
  validateTargetPolicyTasks(corpus.cases)
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
  const profileId = profile.id
  const policy =
    phase === 'heldout'
      ? boxHeldout
        ? boxHeldoutCandidatePolicy
        : categoricalHeldoutPolicy
      : categoricalFreshPolicy
  const frozenProfile = {
    profileId,
    ...(phase === 'heldout' ? { phase: 'heldout' as const } : { phase: 'dev' as const }),
    targetPolicy: profile.targetPolicy,
    ...(heldoutPlan
      ? {
          heldoutFreeze: {
            methodSelectionSha256: heldoutPlan.methodSelectionSha256,
            producerSourceSha256: heldoutPlan.producerSourceSha256,
            inputManifests: heldoutPlan.manifests,
          },
        }
      : {}),
    instructionValidation: {
      accepted: ['absent', categoricalTargetInstruction],
      omittedOnlyForTargetOnlyProfile: profile.targetPolicy === 'target-only-v1',
    },
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
  const runId = `${phase === 'heldout' ? 'v02-categorical-heldout' : 'v02-fresh'}-${profileId}-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(
    policy.maxPhysicalCalls,
    policy.maxCostUsd,
    policy.unknownCostReserveUsd,
    phase,
  )
  const plannedCaseIds = caseManifest.map((item) => item.caseId)
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    profileId,
    ...(phase === 'heldout' ? { phase: 'heldout' as const } : { phase: 'dev' as const }),
    purpose:
      phase === 'heldout'
        ? (heldoutPlan?.purpose ??
          'full frozen HELDOUT photo, independent UI and independent map producer pass')
        : 'full fresh DEV photo, independent UI and independent map producer pass',
    startedAt: new Date().toISOString(),
    variantSha256,
    producerSourceSha256: hashCanonical(
      Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sourceBeforeSha256: hashCanonical(
      Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sourceHashes: source,
    manifests: corpus.manifests,
    plannedCaseIds,
    plannedCases: caseManifest,
    route: freshProposalRoute,
    mobileSam: mobileSamProposalAssets,
    policy,
    targetPolicy: profile.targetPolicy,
    ...(heldoutPlan
      ? {
          methodSelectionSha256: heldoutPlan.methodSelectionSha256,
          heldoutInputManifests: heldoutPlan.manifests,
        }
      : {}),
    classification: frozenProfile.classification,
    taskManifest,
    modelBoundary: {
      evaluatorTruthRead: false,
      groundTruthInProducer: false,
      retries: 0,
      fallback: false,
    },
  })

  if (phase === 'heldout') assertCategoricalHeldoutCallBound(policy.maxPhysicalCalls)
  else assertCategoricalFreshCallBound(policy.maxPhysicalCalls)
  const fetcher = options.fetch ?? globalThis.fetch
  let proposalPort: ObjectProposalPort | undefined
  let initializationError: string | undefined
  try {
    proposalPort = await createProposals(options)
  } catch (error) {
    initializationError = safeErrorCode(error)
  }
  const recorders = new Map<string, Recorder>()
  const results = new Array<FreshProposalResult>(corpus.cases.length)
  const runController = new AbortController()
  const abortRun = () => runController.abort(signal.reason)
  if (signal.aborted) abortRun()
  else signal.addEventListener('abort', abortRun, { once: true })
  let next = 0
  let firstWorkerFailure: unknown
  const worker = async () => {
    while (!runController.signal.aborted && next < corpus.cases.length) {
      const index = next++
      const item = corpus.cases[index]
      if (!item) continue
      try {
        results[index] = await processFreshCase({
          item,
          profile,
          policy,
          options,
          corpusRoot: corpus.imageRoot,
          imageCheck: imageChecks.get(item.caseId),
          caseDirectory: join(outputDirectory, item.caseId),
          fetcher,
          budget,
          proposalPort,
          recorders,
          initializationError,
          signal: runController.signal,
          phase,
        })
      } catch (error) {
        firstWorkerFailure ??= error
        runController.abort(error)
        throw error
      }
    }
  }
  let workerResults: PromiseSettledResult<void>[] = []
  let settleError: string | undefined
  let disposeError: string | undefined
  try {
    workerResults = await Promise.allSettled(
      Array.from({ length: policy.maxInFlightCases }, worker),
    )
  } finally {
    signal.removeEventListener('abort', abortRun)
    try {
      await proposalPort?.settle()
    } catch (error) {
      settleError = safeErrorCode(error)
    }
    try {
      await proposalPort?.dispose()
    } catch (error) {
      disposeError = safeErrorCode(error)
    }
  }
  const workerFailures = workerResults.flatMap((result) =>
    result.status === 'rejected' ? [safeErrorCode(result.reason)] : [],
  )

  const completedCaseIds = results.flatMap((row) => (row ? [row.caseId] : []))
  const completed = new Set(completedCaseIds)
  const missingCaseIds = plannedCaseIds.filter((caseId) => !completed.has(caseId))
  const aggregate = budget.snapshot() satisfies BudgetSnapshot
  const sourceAfter = await (boxHeldout
    ? categoricalBoxHeldoutProducerSourceManifest()
    : categoricalFreshProducerSourceManifest())
  const sourceAfterSha256 = hashCanonical(
    Object.entries(sourceAfter).sort(([a], [b]) => a.localeCompare(b)),
  )
  const sourceUnchanged = sourceAfterSha256 === producerSourceSha256
  if (firstWorkerFailure !== undefined || missingCaseIds.length > 0) {
    const evidence = {
      runId,
      profileId,
      ...(phase === 'heldout' ? { phase: 'heldout' as const } : { phase: 'dev' as const }),
      status: 'incomplete' as const,
      producerSourceSha256,
      sourceBeforeSha256: producerSourceSha256,
      sourceAfterSha256,
      sourceUnchanged,
      ...(heldoutPlan
        ? {
            purpose: heldoutPlan.purpose,
            targetPolicy: heldoutPlan.targetPolicy,
            methodSelectionSha256: heldoutPlan.methodSelectionSha256,
          }
        : {}),
      plannedCaseIds,
      completedCaseIds,
      missingCaseIds,
      workerFailureCodes: workerFailures,
      firstWorkerFailureCode: firstWorkerFailure ? safeErrorCode(firstWorkerFailure) : null,
      settleError: settleError ?? null,
      disposeError: disposeError ?? null,
      aggregate,
      physicalReceipts: corpus.cases.flatMap((item) =>
        (recorders.get(item.caseId)?.calls ?? []).map((call) => ({
          caseId: item.caseId,
          ...physicalSummary(call),
        })),
      ),
    }
    await writeImmutable(join(outputDirectory, 'incomplete-evidence.json'), evidence)
    return { ...evidence, outputDirectory }
  }
  const summary = {
    runId,
    profileId,
    ...(phase === 'heldout' ? { phase: 'heldout' as const } : { phase: 'dev' as const }),
    targetPolicy: profile.targetPolicy,
    ...(heldoutPlan
      ? {
          purpose: heldoutPlan.purpose,
          methodSelectionSha256: heldoutPlan.methodSelectionSha256,
          heldoutInputManifests: heldoutPlan.manifests,
        }
      : {}),
    variantSha256,
    producerSourceSha256,
    sourceBeforeSha256: producerSourceSha256,
    sourceAfterSha256,
    sourceUnchanged,
    status:
      missingCaseIds.length === 0 &&
      sourceUnchanged &&
      !settleError &&
      !disposeError &&
      aggregate.inFlightCalls === 0
        ? 'complete'
        : 'incomplete',
    plannedCaseIds,
    completedCaseIds,
    missingCaseIds,
    results,
    aggregate,
    latencyEnvironment: policy.latencyEnvironment,
    latencyRankingEligible: policy.latencyRankingEligible,
    initializationError: initializationError ?? null,
    shutdownError: settleError ?? disposeError ?? null,
    settleError: settleError ?? null,
    disposeError: disposeError ?? null,
    physicalReceipts: corpus.cases.flatMap((item) =>
      (recorders.get(item.caseId)?.calls ?? []).map((call) => ({
        caseId: item.caseId,
        ...physicalSummary(call),
      })),
    ),
  }
  await writeImmutable(join(outputDirectory, 'summary.json'), summary)
  await writeImmutable(join(outputDirectory, 'run-complete.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
    producerSourceSha256,
    sourceBeforeSha256: producerSourceSha256,
    sourceAfterSha256,
    sourceUnchanged,
  })
  return { ...summary, outputDirectory }
}

interface ProcessFreshCaseOptions {
  item: FreshCase
  profile: { id: string; targetPolicy: CategoricalTargetPolicy }
  policy: typeof categoricalFreshPolicy | typeof categoricalHeldoutPolicy
  phase: 'dev' | 'heldout'
  options: FreshProposalRunnerOptions
  corpusRoot: string
  imageCheck: { ok: true } | { ok: false; errorCode: string } | undefined
  caseDirectory: string
  fetcher: typeof globalThis.fetch
  budget: RunBudget
  proposalPort: ObjectProposalPort | undefined
  recorders: Map<string, Recorder>
  initializationError: string | undefined
  signal: AbortSignal
}

async function processFreshCase(options: ProcessFreshCaseOptions): Promise<FreshProposalResult> {
  const {
    item,
    profile,
    policy,
    options: runner,
    corpusRoot,
    imageCheck,
    caseDirectory,
    fetcher,
    budget,
    proposalPort,
    recorders,
    initializationError,
    signal,
    phase,
  } = options
  await (runner.testHooks?.makeCaseDirectory ?? ((path) => mkdir(path, { recursive: false })))(
    caseDirectory,
  )
  const errorCode = initializationError
  let image: Uint8Array | undefined
  let classifier: Classifier | undefined
  let recorder: Recorder | undefined
  let proposalMetadata: NonNullable<StageRecord['nativeProposal']> | undefined
  const failed = (code: string): FreshProposalResult => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    classify: {
      status: 'failed',
      durationMs: 0,
      physicalCalls: 0,
      logicalCalls: 0,
      requestHashes: [],
      errorCode: code,
    },
    locate: {
      status: 'failed',
      durationMs: 0,
      physicalCalls: 0,
      logicalCalls: 0,
      requestHashes: [],
      errorCode: code,
    },
    extract: { status: 'failed', durationMs: 0, errorCode: code },
  })
  try {
    if (errorCode) {
      const row = failed(errorCode)
      await (runner.testHooks?.writeCaseResult ?? writeImmutable)(
        join(caseDirectory, 'result.json'),
        row,
      )
      return row
    }
    if (!proposalPort) {
      const row = failed('RUNNER_FAILURE')
      await (runner.testHooks?.writeCaseResult ?? writeImmutable)(
        join(caseDirectory, 'result.json'),
        row,
      )
      return row
    }
    if (!imageCheck?.ok) {
      const row = failed(imageCheck?.errorCode ?? 'INVALID_INPUT')
      await (runner.testHooks?.writeCaseResult ?? writeImmutable)(
        join(caseDirectory, 'result.json'),
        row,
      )
      return row
    }
    const task = taskFor(item)
    image = await loadFreshImage(item, corpusRoot, signal)
    const caseBudget = new CategoricalFreshCaseBudget(budget, phase)
    recorder = recordProvider(
      (trackedFetch) => createProvider(runner, trackedFetch),
      caseBudget,
      join(caseDirectory, 'calls'),
      freshProposalRoute,
      fetcher,
    )
    recorders.set(item.caseId, recorder)
    const observedProposalPort = observeProposals(proposalPort, (batch, input) => {
      proposalMetadata = captureNativeProposal(batch, input)
    })
    classifier = createClassifier({
      decision: createNativeCategoricalPresencePort(recorder.port),
      objectProposals: observedProposalPort,
      timeoutMs: policy.timeoutMs,
      concurrency: 1,
      maxQueue: 0,
    })

    const classifyStarted = performance.now()
    const classPhysicalStart = recorder.calls.length
    const classLogicalStart = recorder.logicalCalls.length
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
    const extractPhysicalStart = recorder.calls.length
    const extractLogicalStart = recorder.logicalCalls.length
    let locate: StageRecord
    let extract: ExtractRecord
    try {
      const result = await classifier.extract({
        image,
        target: targetForProfile(item, profile),
        mode: 'whole-object',
        boxTolerancePx: policy.boxTolerancePx,
        maxExtentPasses: policy.maxExtentPasses,
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
        ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
      }
      if (result.status === 'extracted') {
        let segmentation: ExtractRecord['segmentation']
        try {
          segmentation = captureSegmentation(result.segmentation, item.image)
          const mask = await persistExtractedMask(caseDirectory, result, {
            width: item.image.width,
            height: item.image.height,
          })
          extract = {
            status: 'extracted',
            durationMs: elapsedMs,
            ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
            segmentation,
            mask,
          }
        } catch (error) {
          result.mask.data.fill(0)
          result.png.fill(0)
          extract = {
            status: 'failed',
            durationMs: elapsedMs,
            errorCode: safeErrorCode(error),
            ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
            ...(segmentation ? { segmentation } : {}),
          }
        }
      } else if (result.status === 'unknown' && 'location' in result) {
        extract = {
          status: 'unknown',
          durationMs: elapsedMs,
          reason: 'segmentation-uncertain',
          ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
          segmentation: captureSegmentation(result.segmentation, item.image),
        }
      } else if (result.status === 'not-found') {
        const reason = safeReason(result.reason)
        extract = {
          status: 'not-found',
          durationMs: elapsedMs,
          ...(reason ? { reason } : {}),
          ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
        }
      } else {
        const reason = safeReason(result.reason)
        extract = {
          status: 'unknown',
          durationMs: elapsedMs,
          ...(reason ? { reason } : {}),
          ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
        }
      }
    } catch (error) {
      const elapsedMs = performance.now() - extractStarted
      locate = {
        ...stageRecord(recorder, extractPhysicalStart, extractLogicalStart, elapsedMs, {
          status: 'failed',
          errorCode: safeErrorCode(error),
        }),
        ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
      }
      extract = {
        status: 'failed',
        durationMs: elapsedMs,
        errorCode: safeErrorCode(error),
        ...(proposalMetadata ? { nativeProposal: proposalMetadata } : {}),
      }
    }
    const row = {
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      classify,
      locate,
      extract,
    }
    await (runner.testHooks?.writeCaseResult ?? writeImmutable)(
      join(caseDirectory, 'result.json'),
      row,
    )
    return row
  } finally {
    image?.fill(0)
    try {
      await classifier?.dispose()
    } catch {
      // Individual operation failure is already recorded; global pool is disposed after workers join.
    }
  }
}

export async function readFreshProposalOpenRouterKey(): Promise<string> {
  const key = parseEnv(await readFile(keyFile, 'utf8')).OPENROUTER_API_KEY
  if (!key) throw new Error('Configured OpenRouter credential is absent')
  return key
}
