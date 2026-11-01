import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { createClassifier } from '../../../src/app/create-classifier.js'
import type { DecisionPort } from '../../../src/entities/contracts.js'
import type { SegmentationPort } from '../../../src/entities/segmentation.js'
import { createOpenRouterVision } from '../../../src/openrouter.js'
import { createSharpRaster } from '../../../src/infrastructure/raster.js'
import { createH8aFullRuntime } from '../h8a-full/factory.js'
import type { H8aFullSuccess } from '../h8a-full/contracts.js'
import type { H8aFullRecipeId } from '../h8a-full/constants.js'
import { orientedDimensionsFromHeader } from '../h8a-full/image-source.js'
import { freshCaseSchema } from '../../v02/fresh-corpus.js'
import type { FreshCase } from '../../v02/fresh-corpus.js'
import type {
  assertRecorderHealthy,
  processRegionSeededCase,
} from '../../v02/region-seeded-runner.js'
import type { RegionSeededCaseResult } from '../../v02/region-seeded-runner.js'
import { recordProvider } from '../../v02/recording.js'
import type { Recorder } from '../../v02/recording.js'
import { RunBudget } from '../../v02/budget.js'
import {
  assertIndependentProfilePolicies,
  H8A_CANDIDATE_PROFILE,
  H8A_FLAT_CANDIDATE_PROFILE,
  V02_CONTROL_PROFILE,
} from './profiles.js'
import type { H8aFreshProfileId } from './profiles.js'
import { createCampaignFetchBoundary } from './campaign-fetch-boundary.js'
import type { CampaignFetchJournalEntry, RecordedProviderCall } from './campaign-fetch-boundary.js'
import type { CampaignLedgerPort } from './campaign-ledger-port.js'
import { PROFILE_CANDIDATE_ID, PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import type { H8aFreshCandidateId } from './constants.js'
import { assertNoForbiddenEvaluatorFields } from './forbidden-leakage.js'
import type {
  ProducerExecutionInput,
  CaseExecutionPort,
  CaseExecutionPortResult,
} from './paired-runner.js'
import {
  boxesExactlyEqual,
  deriveInclusivePixelBox,
  packBinaryLsb0V1,
  sha256PackedBytes,
  unpackBinaryLsb0V1,
} from './packed-binary-lsb0.js'
import { outputRowSchema } from './schemas.js'

const MAX_OWNED_SOURCE_BYTES = 24 * 1024 * 1024
const CANDIDATE_CASE_MAX_CALLS = 4
const CONTROL_CASE_MAX_CALLS = 6

interface FreshMaskArtifact {
  sha256: string
  width: number
  height: number
  packedBytes: Uint8Array
  path: string
}

interface FreshCutoutArtifact {
  sha256: string
  width: number
  height: number
  format: 'rgba8' | 'png'
  bytes: Uint8Array
  path: string
}

export interface FreshRuntimeArtifacts {
  masksBySha256: Map<string, FreshMaskArtifact>
  cutoutsBySha256: Map<string, FreshCutoutArtifact>
  cutoutsByProfileAndCase: Map<string, FreshCutoutArtifact>
}

export interface CandidateRuntimePort {
  run(input: {
    encodedImage: Uint8Array
    authoredTarget: string
    includeCutout: true
    signal: AbortSignal
    decision: DecisionPort
    imageState: ReturnType<typeof createSharpRaster>['imageState']
  }): Promise<H8aFullSuccess>
  dispose(): Promise<void>
}

type HistoricalCaseKernel = typeof processRegionSeededCase
type HistoricalRecorderHealthCheck = typeof assertRecorderHealthy
type HistoricalClassifierFactory = typeof createClassifier
type HistoricalDecisionsFactory = (options: {
  apiKey: string
  model: string
  provider: string
  providerName: string
  fetch: typeof globalThis.fetch
}) => DecisionPort
type HistoricalCategoricalWrapper = (nativePort: DecisionPort) => DecisionPort
type HistoricalMobileSamFactory = (options: {
  encoderPath: string
  decoderPath: string
  executionProvider: 'cpu'
  threads: 2
}) => Promise<SegmentationPort>

/** Functions loaded by the caller from the individually pinned v0.2 source tree. */
interface VerifiedHistoricalV02ControlEngine {
  kind: 'verified-historical-v02'
  sourceClosureSha256: string
  snapshotReceiptSha256: string
  processRegionSeededCase: HistoricalCaseKernel
  assertRecorderHealthy: HistoricalRecorderHealthCheck
  createClassifier: HistoricalClassifierFactory
  createOpenRouterDecisions: HistoricalDecisionsFactory
  createNativeCategoricalPresencePort: HistoricalCategoricalWrapper
  createMobileSamSegmenter: HistoricalMobileSamFactory
}

/** Explicit dependency injection for offline tests; never accepted as historical evidence. */
interface OfflineFixtureControlEngine {
  kind: 'offline-fixture-only'
  processRegionSeededCase: HistoricalCaseKernel
  assertRecorderHealthy: HistoricalRecorderHealthCheck
  createClassifier: HistoricalClassifierFactory
  createOpenRouterDecisions: HistoricalDecisionsFactory
  createNativeCategoricalPresencePort: HistoricalCategoricalWrapper
  createControlSegmenter: () => SegmentationPort | Promise<SegmentationPort>
}

type H8FreshControlEngine = VerifiedHistoricalV02ControlEngine | OfflineFixtureControlEngine

interface H8FreshRuntimePortOptionsBase {
  apiKey: string
  artifactRoot: string
  temporaryRoot: string
  maskArtifactDirectory: string
  cutoutArtifactDirectory: string
  nativeRuntime: Omit<Parameters<typeof createH8aFullRuntime>[0], 'artifactRoot'>
  mobileSam: { encoderPath: string; decoderPath: string }
  sourceCanvasByOpaqueCaseId: ReadonlyMap<string, { width: number; height: number }>
  fetch?: typeof globalThis.fetch
  createCandidateRuntime?: (
    recipeId: H8aFullRecipeId,
  ) => CandidateRuntimePort | Promise<CandidateRuntimePort>
}

export type H8FreshRuntimePortOptions = H8FreshRuntimePortOptionsBase & {
  controlEngine: VerifiedHistoricalV02ControlEngine
}

export type OfflineFixtureRuntimePortOptions = H8FreshRuntimePortOptionsBase & {
  controlEngine: OfflineFixtureControlEngine
  fetch: typeof globalThis.fetch
}

type AnyFreshRuntimePortOptions = H8FreshRuntimePortOptions | OfflineFixtureRuntimePortOptions

interface H8FreshRuntimePorts {
  candidatePort: CaseExecutionPort
  controlPort: CaseExecutionPort
  artifacts: FreshRuntimeArtifacts
  fetchJournal: CampaignFetchJournalEntry[]
  dispose(): Promise<void>
}

interface DispatchEvidenceContext {
  recorder: Recorder | undefined
  journal: CampaignFetchJournalEntry[]
  ledger: CampaignLedgerPort
  reservedUsd: number
  profileId: H8aFreshProfileId
  opaqueCaseId: string
  caseExecutionIdentitySha256: string
  endpoint: CampaignFetchJournalEntry['endpoint']
  artifactRoot: string
  baseFetch: typeof globalThis.fetch
  signal?: AbortSignal
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy
}

function safeCaseError(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR'
  const code = Reflect.get(error, 'code')
  if (typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(code)) return code
  const safeMessage = error.message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/(api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 200)
  return `${error.name || 'ERROR'}:${safeMessage || 'unspecified failure'}`
}

function recorderCallForBoundary(
  context: DispatchEvidenceContext,
): RecordedProviderCall | undefined {
  const recorder = context.recorder
  const call = recorder?.calls.at(-1)
  if (!call) return undefined
  return {
    physicalId: call.physicalId,
    logicalId: call.logicalId,
    requestSha256: call.requestSha256,
    requestBodySha256: call.requestBodySha256,
  }
}

function candidateProfile(profileId: H8aFreshCandidateId) {
  return profileId === PROFILE_FLAT_CANDIDATE_ID
    ? H8A_FLAT_CANDIDATE_PROFILE
    : H8A_CANDIDATE_PROFILE
}

function isCandidateProfileId(profileId: H8aFreshProfileId): profileId is H8aFreshCandidateId {
  return profileId === PROFILE_CANDIDATE_ID || profileId === PROFILE_FLAT_CANDIDATE_ID
}

function candidateRecipeId(profileId: H8aFreshCandidateId): H8aFullRecipeId {
  return profileId === PROFILE_FLAT_CANDIDATE_ID ? PROFILE_FLAT_CANDIDATE_ID : PROFILE_CANDIDATE_ID
}

function assertCandidateResultRecipe(
  result: H8aFullSuccess,
  selectedRecipeId: H8aFullRecipeId,
): void {
  if (selectedRecipeId === PROFILE_FLAT_CANDIDATE_ID) {
    if (result.recipeId !== PROFILE_FLAT_CANDIDATE_ID)
      throw new RangeError('Candidate result recipe identity does not match the flat profile')
    return
  }
  if (result.recipeId !== undefined)
    throw new RangeError('V1 candidate result unexpectedly declares a different recipe identity')
}

function createRecordedDecision(
  context: DispatchEvidenceContext,
  apiKey: string,
  receiptDirectory: string,
  controlEngine: H8FreshControlEngine,
): Recorder {
  const boundary = createCampaignFetchBoundary({
    ledger: context.ledger,
    reservedUsd: context.reservedUsd,
    profileId: context.profileId,
    opaqueCaseId: context.opaqueCaseId,
    caseExecutionIdentitySha256: context.caseExecutionIdentitySha256,
    endpoint: context.endpoint,
    journalDirectory: join(context.artifactRoot, 'dispatch-journal'),
    baseFetch: context.baseFetch,
    readCurrentProviderCall: () => recorderCallForBoundary(context),
    journalEntries: context.journal,
    ...(context.signal ? { signal: context.signal } : {}),
  })
  const profileId = context.profileId
  const isCandidate = isCandidateProfileId(profileId)
  const selectedCandidateProfile = isCandidate ? candidateProfile(profileId) : undefined
  const route = selectedCandidateProfile
    ? {
        model: selectedCandidateProfile.requestPolicy.route.model,
        provider: selectedCandidateProfile.requestPolicy.route.provider,
        providerName: selectedCandidateProfile.requestPolicy.route.providerName,
        apiEndpoint: selectedCandidateProfile.requestPolicy.route.apiEndpoint,
        allowFallbacks: false as const,
      }
    : {
        model: V02_CONTROL_PROFILE.requestPolicy.model,
        provider: V02_CONTROL_PROFILE.requestPolicy.provider,
        providerName: V02_CONTROL_PROFILE.requestPolicy.providerName,
        apiEndpoint: V02_CONTROL_PROFILE.requestPolicy.apiEndpoint,
        allowFallbacks: false as const,
      }
  const maximumCalls = isCandidate ? CANDIDATE_CASE_MAX_CALLS : CONTROL_CASE_MAX_CALLS
  const caseBudget = new RunBudget(
    maximumCalls,
    context.reservedUsd * maximumCalls,
    context.reservedUsd,
  )
  const recorder = recordProvider(
    (fetcher) => {
      if (selectedCandidateProfile)
        return createOpenRouterVision({
          apiKey,
          model: selectedCandidateProfile.requestPolicy.route.model,
          provider: selectedCandidateProfile.requestPolicy.route.provider,
          providerName: selectedCandidateProfile.requestPolicy.route.providerName,
          responseFormat: 'prompt',
          reasoningEffort: 'medium',
          maxOutputTokens: 4096,
          fetch: fetcher,
        })
      return controlEngine.createNativeCategoricalPresencePort(
        controlEngine.createOpenRouterDecisions({
          apiKey,
          model: V02_CONTROL_PROFILE.requestPolicy.model,
          provider: V02_CONTROL_PROFILE.requestPolicy.provider,
          providerName: V02_CONTROL_PROFILE.requestPolicy.providerName,
          fetch: fetcher,
        }),
      )
    },
    caseBudget,
    receiptDirectory,
    route,
    boundary.fetch,
  )
  context.recorder = recorder
  return recorder
}

function attachDispatchEvidence(
  logicalCalls: Recorder['logicalCalls'],
  journal: CampaignFetchJournalEntry[],
  opaqueCaseId: string,
  profileId: H8aFreshProfileId,
): CaseExecutionPortResult['logicalReceipts'] {
  const usedJournal = new Set<CampaignFetchJournalEntry>()
  return logicalCalls.map((logical) => {
    const dispatches = journal.filter(
      (entry) =>
        entry.profileId === profileId &&
        entry.logicalId === logical.logicalId &&
        !usedJournal.has(entry),
    )
    for (const dispatch of dispatches) usedJournal.add(dispatch)
    const physicalIds = dispatches.map((entry) => entry.reservationId)
    const outcome = logical.errorCode
      ? dispatches.length === 0
        ? ('preflight_failed' as const)
        : ('failed' as const)
      : dispatches.length === 0
        ? ('preflight_failed' as const)
        : ('resolved' as const)
    return {
      logicalId: logical.logicalId,
      opaqueCaseId,
      profileId,
      requestSha256: logical.requestSha256,
      physicalIds,
      outcome,
      ...(logical.errorCode ? { errorCode: logical.errorCode } : {}),
      ...(!logical.errorCode && dispatches.length === 0 ? { errorCode: 'NO_PHYSICAL_FETCH' } : {}),
    }
  })
}

function ownOutputRow(
  input: ProducerExecutionInput,
  profileId: H8aFreshProfileId,
  execution: {
    caseState:
      | 'success'
      | 'not_found'
      | 'unknown'
      | 'error'
      | 'timeout'
      | 'cancelled'
      | 'preflight_failed'
    box: { left: number; top: number; width: number; height: number } | null
    cutoutPresent: boolean
    maskPackedSha256: string | null
  },
  logicalReceipts: CaseExecutionPortResult['logicalReceipts'],
  physicalReceipts: CaseExecutionPortResult['physicalReceipts'],
  executionValidity: 'valid' | 'invalid' = 'valid',
): CaseExecutionPortResult['outputRow'] {
  return outputRowSchema.parse({
    schema: 'h8a-fresh-output-row-v1',
    opaqueCaseId: input.opaqueCaseId,
    profileId,
    executionValidity,
    caseState: execution.caseState,
    box: execution.box,
    cutoutPresent: execution.cutoutPresent,
    maskPackedSha256: execution.maskPackedSha256,
    logicalReceiptIds: logicalReceipts.map((receipt) => receipt.logicalId),
    physicalReceiptIds: physicalReceipts
      .filter((receipt) => receipt.dispatchState !== 'prefetch_cancelled')
      .map((receipt) => receipt.receiptId),
  })
}

async function persistMask(
  directory: string,
  width: number,
  height: number,
  bytes: Uint8Array,
  artifacts: FreshRuntimeArtifacts,
): Promise<string> {
  const owned = copyBytes(bytes)
  const digest = sha256PackedBytes(owned)
  const pixels = unpackBinaryLsb0V1(width, height, owned)
  pixels.fill(0)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${digest}.binary-lsb0`)
  try {
    await writeFile(path, owned, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    const existing = await readFile(path)
    if (sha256PackedBytes(existing) !== digest) throw new Error('Existing mask artifact is corrupt')
  }
  artifacts.masksBySha256.set(digest, { sha256: digest, width, height, packedBytes: owned, path })
  return digest
}

async function persistCutout(
  directory: string,
  width: number,
  height: number,
  bytes: Uint8Array,
  artifacts: FreshRuntimeArtifacts,
  opaqueCaseId: string,
  profileId: H8aFreshProfileId,
): Promise<FreshCutoutArtifact> {
  if (bytes.byteLength !== width * height * 4) throw new RangeError('Cutout RGBA geometry mismatch')
  const owned = copyBytes(bytes)
  const digest = sha256(owned)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${digest}.rgba`)
  try {
    await writeFile(path, owned, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    const existing = await readFile(path)
    if (sha256(existing) !== digest) throw new Error('Existing cutout artifact is corrupt')
  }
  const artifact: FreshCutoutArtifact = {
    sha256: digest,
    width,
    height,
    format: 'rgba8',
    bytes: owned,
    path,
  }
  artifacts.cutoutsBySha256.set(digest, artifact)
  artifacts.cutoutsByProfileAndCase.set(`${profileId}:${opaqueCaseId}`, artifact)
  return artifact
}

async function persistControlCutoutPng(
  directory: string,
  descriptor: ControlMaskDescriptor,
  bytes: Uint8Array,
  artifacts: FreshRuntimeArtifacts,
  opaqueCaseId: string,
): Promise<FreshCutoutArtifact> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OWNED_SOURCE_BYTES)
    throw new RangeError('Control cutout PNG is outside the encoded byte budget')
  const owned = copyBytes(bytes)
  const digest = sha256(owned)
  if (digest !== descriptor.pngSha256)
    throw new RangeError('Control cutout PNG does not match its native descriptor digest')
  const metadata = await sharp(owned, {
    limitInputPixels: 2_097_152,
    failOn: 'error',
  }).metadata()
  if (
    metadata.format !== 'png' ||
    metadata.width !== descriptor.width ||
    metadata.height !== descriptor.height
  )
    throw new RangeError('Control cutout PNG geometry differs from its native descriptor')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${digest}.png`)
  try {
    await writeFile(path, owned, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    const existing = await readFile(path)
    if (sha256(existing) !== digest) throw new Error('Existing control cutout PNG is corrupt')
  }
  const artifact: FreshCutoutArtifact = {
    sha256: digest,
    width: descriptor.width,
    height: descriptor.height,
    format: 'png',
    bytes: owned,
    path,
  }
  artifacts.cutoutsBySha256.set(digest, artifact)
  artifacts.cutoutsByProfileAndCase.set(`${PROFILE_CONTROL_ID}:${opaqueCaseId}`, artifact)
  return artifact
}

function findLogicalCallId(
  recorder: Recorder,
  entry: CampaignFetchJournalEntry,
): number | undefined {
  const call = recorder.calls.find((item) => item.physicalId === entry.recorderPhysicalId)
  if (!call || call.logicalId !== entry.logicalId || call.requestSha256 !== entry.requestSha256)
    return undefined
  return call.logicalId
}

function mapJournalToLogical(
  recorder: Recorder | undefined,
  journal: CampaignFetchJournalEntry[],
  opaqueCaseId: string,
  profileId: H8aFreshProfileId,
): CaseExecutionPortResult['logicalReceipts'] {
  const source = recorder?.logicalCalls ?? []
  const receipts = attachDispatchEvidence(source, journal, opaqueCaseId, profileId)
  if (!recorder || receipts.length === 0) return []
  const corrected = receipts.map((receipt) => {
    const entries = journal.filter(
      (entry) =>
        entry.profileId === profileId &&
        entry.requestSha256 === receipt.requestSha256 &&
        receipt.physicalIds.includes(entry.reservationId),
    )
    if (entries.some((entry) => findLogicalCallId(recorder, entry) !== receipt.logicalId))
      return {
        ...receipt,
        physicalIds: [],
        outcome: 'failed' as const,
        errorCode: 'RECEIPT_LINK_MISMATCH',
      }
    return receipt
  })
  return corrected
}

function makePhysicalReceipts(
  recorder: Recorder | undefined,
  logicalReceipts: CaseExecutionPortResult['logicalReceipts'],
  journal: CampaignFetchJournalEntry[],
  profileId: H8aFreshProfileId,
): CaseExecutionPortResult['physicalReceipts'] {
  if (!recorder) return []
  return journal
    .filter((entry) => entry.profileId === profileId)
    .flatMap((entry) => {
      const logicalId = findLogicalCallId(recorder, entry)
      const logical = logicalReceipts.find((receipt) => receipt.logicalId === logicalId)
      if (!logical || !logical.physicalIds.includes(entry.reservationId)) return []
      return [
        {
          receiptId: entry.reservationId,
          physicalId: entry.physicalId,
          logicalId: logical.logicalId,
          dispatchState: entry.dispatchState,
          settled: entry.settled,
          costUsd: entry.costUsd,
          chargeState: entry.costUsd === null ? ('unknown' as const) : ('known' as const),
        },
      ]
    })
}

function stateForError(error: unknown, signal: AbortSignal): 'timeout' | 'cancelled' | 'error' {
  const errorCodeValue = error instanceof Error ? Reflect.get(error, 'code') : undefined
  if (errorCodeValue === 'TIMEOUT') return 'timeout'
  if (signal.aborted) {
    if (/deadline|timeout/iu.test(signal.reason instanceof Error ? signal.reason.message : ''))
      return 'timeout'
    return 'cancelled'
  }
  return 'error'
}

function makeCaseExecutionResult(
  input: ProducerExecutionInput,
  profileId: H8aFreshProfileId,
  recorder: Recorder | undefined,
  journal: CampaignFetchJournalEntry[],
  execution: Parameters<typeof ownOutputRow>[2],
  dispatchJournal?: { lastPartialResult: CaseExecutionPortResult | null },
  caseArtifactSidecars?: NonNullable<CaseExecutionPortResult['caseArtifactSidecars']>,
  caseError?: string,
): CaseExecutionPortResult {
  const logicalReceipts = mapJournalToLogical(recorder, journal, input.opaqueCaseId, profileId)
  const physicalReceipts = makePhysicalReceipts(recorder, logicalReceipts, journal, profileId)
  const result = {
    outputRow: ownOutputRow(input, profileId, execution, logicalReceipts, physicalReceipts),
    logicalReceipts,
    physicalReceipts,
    ...(caseArtifactSidecars ? { caseArtifactSidecars } : {}),
    ...(caseError ? { caseError } : {}),
  }
  if (dispatchJournal) dispatchJournal.lastPartialResult = result
  return result
}

function buildCandidatePort(
  runtime: CandidateRuntimePort,
  selectedRecipeId: H8aFullRecipeId,
  options: AnyFreshRuntimePortOptions,
  raster: ReturnType<typeof createSharpRaster>,
  artifacts: FreshRuntimeArtifacts,
  sharedJournal: CampaignFetchJournalEntry[],
): CaseExecutionPort {
  return {
    async execute(input, context) {
      assertNoForbiddenEvaluatorFields(input, 'Candidate runtime producer input')
      const profileId = context.profileId
      if (!isCandidateProfileId(profileId))
        throw new RangeError('Candidate port received a control profile')
      if (candidateRecipeId(profileId) !== selectedRecipeId)
        throw new RangeError('Selected native recipe does not match the candidate profile')
      const expectedCanvas = options.sourceCanvasByOpaqueCaseId.get(input.opaqueCaseId)
      if (!expectedCanvas) throw new RangeError('Candidate input has no frozen source canvas')
      const sourceBytes = copyBytes(input.sourceBytes)
      const originalSourceSha256 = sha256(sourceBytes)
      const caseExecutionIdentitySha256 =
        context.caseExecutionIdentitySha256 ??
        sha256(
          Buffer.from(
            JSON.stringify({
              opaqueCaseId: input.opaqueCaseId,
              profileId: context.profileId,
              originalSourceSha256,
              targetTaskSha256: sha256(Buffer.from(input.targetTaskText, 'utf8')),
            }),
            'utf8',
          ),
        )
      const signalController = new AbortController()
      const onAbort = () => signalController.abort(context.signal?.reason)
      if (context.signal?.aborted) onAbort()
      else context.signal?.addEventListener('abort', onAbort, { once: true })
      const dispatchContext: DispatchEvidenceContext = {
        recorder: undefined,
        journal: [],
        ledger: context.ledger,
        reservedUsd: context.reservedUsdPerFetch,
        profileId,
        opaqueCaseId: input.opaqueCaseId,
        caseExecutionIdentitySha256,
        endpoint: candidateProfile(profileId).requestPolicy.route.apiEndpoint,
        artifactRoot: options.artifactRoot,
        baseFetch: options.fetch ?? globalThis.fetch,
        signal: signalController.signal,
      }
      const recorder = createRecordedDecision(
        dispatchContext,
        options.apiKey,
        join(options.artifactRoot, 'provider-receipts', randomUUID()),
        options.controlEngine,
      )
      let result: H8aFullSuccess | undefined
      let caught: unknown
      let caseError: string | undefined
      try {
        result = await runtime.run({
          encodedImage: sourceBytes,
          authoredTarget: input.targetTaskText,
          includeCutout: true,
          signal: signalController.signal,
          decision: recorder.port,
          imageState: raster.imageState,
        })
        assertCandidateResultRecipe(result, selectedRecipeId)
      } catch (error) {
        caught = error
        caseError = safeCaseError(error)
        if (result?.status === 'located') {
          result.mask.data.fill(0)
          result.cutout?.data.fill(0)
        }
      } finally {
        context.signal?.removeEventListener('abort', onAbort)
        sourceBytes.fill(0)
      }
      try {
        options.controlEngine.assertRecorderHealthy(recorder)
      } catch (error) {
        caught ??= error
        caseError ??= safeCaseError(error)
      }
      sharedJournal.push(...dispatchContext.journal)
      let execution: Parameters<typeof ownOutputRow>[2]
      let cutoutSidecar:
        | NonNullable<CaseExecutionPortResult['caseArtifactSidecars']>[number]
        | undefined
      if (caught !== undefined || !result) {
        execution = {
          caseState: stateForError(caught, signalController.signal),
          box: null,
          cutoutPresent: false,
          maskPackedSha256: null,
        }
      } else if (result.status === 'unknown') {
        execution = {
          caseState: result.reason === 'target-absent' ? 'not_found' : 'unknown',
          box: null,
          cutoutPresent: false,
          maskPackedSha256: null,
        }
      } else {
        const maskBytes = copyBytes(result.mask.data)
        try {
          const pixels = unpackBinaryLsb0V1(result.mask.width, result.mask.height, maskBytes)
          const bounds = deriveInclusivePixelBox(pixels, result.mask.width, result.mask.height)
          pixels.fill(0)
          if (
            !bounds ||
            result.mask.width !== result.sourceFrame.width ||
            result.mask.height !== result.sourceFrame.height ||
            result.sourceFrame.width !== expectedCanvas.width ||
            result.sourceFrame.height !== expectedCanvas.height ||
            result.originalEncodedSha256 !== originalSourceSha256 ||
            !boxesExactlyEqual(bounds, result.region)
          )
            throw new RangeError('Candidate mask does not match the owned source frame and bounds')
          const digest = await persistMask(
            options.maskArtifactDirectory,
            result.mask.width,
            result.mask.height,
            maskBytes,
            artifacts,
          )
          if (result.cutout) {
            const artifact = await persistCutout(
              options.cutoutArtifactDirectory,
              result.cutout.width,
              result.cutout.height,
              result.cutout.data,
              artifacts,
              input.opaqueCaseId,
              profileId,
            )
            cutoutSidecar = {
              opaqueCaseId: input.opaqueCaseId,
              profileId,
              kind: 'candidate-cutout-rgba',
              sha256: artifact.sha256,
              byteLength: artifact.bytes.byteLength,
              width: artifact.width,
              height: artifact.height,
              sourceCanvasWidth: expectedCanvas.width,
              sourceCanvasHeight: expectedCanvas.height,
              sourceRegion: { ...result.region },
              sourceOffset: { x: result.region.left, y: result.region.top },
            }
          }
          execution = {
            caseState: 'success',
            box: { ...result.region },
            cutoutPresent: result.cutout !== undefined,
            maskPackedSha256: digest,
          }
        } catch (error) {
          caseError = safeCaseError(error)
          execution = {
            caseState: 'error',
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
          }
        } finally {
          maskBytes.fill(0)
          result.mask.data.fill(0)
          result.cutout?.data.fill(0)
        }
      }
      return makeCaseExecutionResult(
        input,
        profileId,
        recorder,
        dispatchContext.journal,
        execution,
        context.dispatchJournal,
        cutoutSidecar ? [cutoutSidecar] : [],
        caseError,
      )
    },
  }
}

type ControlMaskDescriptor = NonNullable<RegionSeededCaseResult['extraction']['mask']>

function embedCroppedControlMask(
  cropped: Uint8Array,
  imageSize: { width: number; height: number },
  mask: ControlMaskDescriptor,
): Uint8Array {
  if (
    cropped.length !== mask.width * mask.height ||
    mask.sourceOffset.x !== mask.sourceRegion.left ||
    mask.sourceOffset.y !== mask.sourceRegion.top ||
    mask.sourceRegion.width !== mask.width ||
    mask.sourceRegion.height !== mask.height ||
    mask.sourceRegion.left + mask.width > imageSize.width ||
    mask.sourceRegion.top + mask.height > imageSize.height ||
    cropped.some((value) => value !== 0 && value !== 1)
  )
    throw new RangeError('Control cropped mask does not fit its original source canvas')
  const full = new Uint8Array(imageSize.width * imageSize.height)
  for (let y = 0; y < mask.height; y++) {
    const sourceStart = y * mask.width
    const targetStart = (mask.sourceOffset.y + y) * imageSize.width + mask.sourceOffset.x
    full.set(cropped.subarray(sourceStart, sourceStart + mask.width), targetStart)
  }
  return packBinaryLsb0V1(imageSize.width, imageSize.height, full)
}

function buildControlPort(
  segmenter: SegmentationPort,
  options: AnyFreshRuntimePortOptions,
  artifacts: FreshRuntimeArtifacts,
  sharedJournal: CampaignFetchJournalEntry[],
): CaseExecutionPort {
  return {
    async execute(input, context) {
      assertNoForbiddenEvaluatorFields(input, 'Control runtime producer input')
      if (context.profileId !== PROFILE_CONTROL_ID)
        throw new RangeError('Control port received a candidate profile')
      if (
        input.sourceBytes.byteLength === 0 ||
        input.sourceBytes.byteLength > MAX_OWNED_SOURCE_BYTES
      )
        throw new RangeError('Control source image is outside the encoded byte budget')
      const sourceBytes = copyBytes(input.sourceBytes)
      const caseExecutionIdentitySha256 =
        context.caseExecutionIdentitySha256 ??
        sha256(
          Buffer.from(
            JSON.stringify({
              opaqueCaseId: input.opaqueCaseId,
              profileId: context.profileId,
              originalSourceSha256: sha256(sourceBytes),
              targetTaskSha256: sha256(Buffer.from(input.targetTaskText, 'utf8')),
            }),
            'utf8',
          ),
        )
      const expectedCanvas = options.sourceCanvasByOpaqueCaseId.get(input.opaqueCaseId)
      if (!expectedCanvas) {
        sourceBytes.fill(0)
        throw new RangeError('Control input has no frozen source canvas')
      }
      let dimensions: { width: number; height: number }
      let caseRoot: string | undefined
      try {
        const oriented = await orientedDimensionsFromHeader(sourceBytes)
        const sourceMetadata = await sharp(sourceBytes, {
          limitInputPixels: 2_097_152,
          failOn: 'error',
        }).metadata()
        if (oriented.orientation !== 1)
          throw new RangeError(
            'Control source is not representable by the frozen upright-image loader',
          )
        if (
          !['png', 'jpeg', 'webp'].includes(sourceMetadata.format ?? '') ||
          (sourceMetadata.pages ?? 1) !== 1
        )
          throw new RangeError('Control source format is not supported by the frozen loader')
        dimensions = { width: oriented.width, height: oriented.height }
        if (
          dimensions.width !== expectedCanvas.width ||
          dimensions.height !== expectedCanvas.height
        )
          throw new RangeError('Control source canvas differs from the frozen oriented canvas')
        caseRoot = await mkdtemp(join(options.temporaryRoot, 'fresh-case-'))
        const inputPath = join(caseRoot, 'source.bin')
        await writeFile(inputPath, sourceBytes, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        sourceBytes.fill(0)
        if (caseRoot) await rm(caseRoot, { recursive: true, force: false })
        throw error
      }
      if (!caseRoot) {
        sourceBytes.fill(0)
        throw new Error('Control owned source setup did not complete')
      }
      try {
        const caseDirectory = join(caseRoot, 'result')
        const digest = sha256(sourceBytes)
        const safeLocalId = `fresh-${randomUUID()}`
        const item = freshCaseSchema.parse({
          caseId: safeLocalId,
          image: {
            path: 'source.bin',
            sha256: digest,
            width: dimensions.width,
            height: dimensions.height,
          },
          locate: { target: input.targetTaskText },
          classify: {
            question: `Does this image contain ${input.targetTaskText}?`,
            options: ['present', 'absent'],
          },
        } satisfies FreshCase)
        const signalController = new AbortController()
        const onAbort = () => signalController.abort(context.signal?.reason)
        if (context.signal?.aborted) onAbort()
        else context.signal?.addEventListener('abort', onAbort, { once: true })
        const dispatchContext: DispatchEvidenceContext = {
          recorder: undefined,
          journal: [],
          ledger: context.ledger,
          reservedUsd: context.reservedUsdPerFetch,
          profileId: PROFILE_CONTROL_ID,
          opaqueCaseId: input.opaqueCaseId,
          caseExecutionIdentitySha256,
          endpoint: V02_CONTROL_PROFILE.requestPolicy.apiEndpoint,
          artifactRoot: options.artifactRoot,
          baseFetch: options.fetch ?? globalThis.fetch,
          signal: signalController.signal,
        }
        const recorder = createRecordedDecision(
          dispatchContext,
          options.apiKey,
          join(options.artifactRoot, 'provider-receipts', randomUUID()),
          options.controlEngine,
        )
        let caseResult: Awaited<ReturnType<typeof processRegionSeededCase>> | undefined
        let caught: unknown
        let caseError: string | undefined
        try {
          caseResult = await options.controlEngine.processRegionSeededCase({
            item,
            root: caseRoot,
            caseDirectory,
            classifierFactory: (classifierOptions) =>
              options.controlEngine.createClassifier(classifierOptions),
            decision: recorder.port,
            segmentation: segmenter,
            variant: 'region-seeded-sam',
            requireClassifiedPresence: true,
            checkedRegion: true,
            recorder,
            signal: signalController.signal,
          })
        } catch (error) {
          caught = error
          caseError = safeCaseError(error)
        } finally {
          context.signal?.removeEventListener('abort', onAbort)
        }
        try {
          options.controlEngine.assertRecorderHealthy(recorder)
        } catch (error) {
          caught ??= error
          caseError ??= safeCaseError(error)
        }
        sharedJournal.push(...dispatchContext.journal)

        let execution: Parameters<typeof ownOutputRow>[2]
        let cutoutSidecar:
          | NonNullable<CaseExecutionPortResult['caseArtifactSidecars']>[number]
          | undefined
        if (caught !== undefined || !caseResult) {
          execution = {
            caseState: stateForError(caught, signalController.signal),
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
          }
        } else if (caseResult.classify.status === 'ok' && caseResult.classify.value === 'absent') {
          execution = {
            caseState: 'not_found',
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
          }
        } else if (caseResult.classify.status !== 'ok') {
          execution = {
            caseState: caseResult.classify.errorCode === 'TIMEOUT' ? 'timeout' : 'error',
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
          }
        } else if (caseResult.extraction.status === 'unknown') {
          execution = {
            caseState: 'unknown',
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
          }
        } else if (caseResult.extraction.status === 'not-found') {
          execution = {
            caseState: 'not_found',
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
          }
        } else if (caseResult.extraction.status === 'extracted' && caseResult.extraction.mask) {
          const descriptor = caseResult.extraction.mask
          const cropped = new Uint8Array(await readFile(join(caseDirectory, descriptor.file)))
          let cutoutPng: Uint8Array | undefined
          try {
            cutoutPng = new Uint8Array(await readFile(join(caseDirectory, descriptor.pngFile)))
            const packed = embedCroppedControlMask(
              cropped,
              { width: item.image.width, height: item.image.height },
              descriptor,
            )
            const maskSha256 = await persistMask(
              options.maskArtifactDirectory,
              item.image.width,
              item.image.height,
              packed,
              artifacts,
            )
            const cutoutArtifact = await persistControlCutoutPng(
              options.cutoutArtifactDirectory,
              descriptor,
              cutoutPng,
              artifacts,
              input.opaqueCaseId,
            )
            cutoutSidecar = {
              opaqueCaseId: input.opaqueCaseId,
              profileId: PROFILE_CONTROL_ID,
              kind: 'control-cutout-png',
              sha256: cutoutArtifact.sha256,
              byteLength: cutoutArtifact.bytes.byteLength,
              width: cutoutArtifact.width,
              height: cutoutArtifact.height,
              sourceCanvasWidth: item.image.width,
              sourceCanvasHeight: item.image.height,
              sourceRegion: { ...descriptor.sourceRegion },
              sourceOffset: { ...descriptor.sourceOffset },
            }
            packed.fill(0)
            execution = {
              caseState: 'success',
              box: { ...descriptor.sourceRegion },
              cutoutPresent: true,
              maskPackedSha256: maskSha256,
            }
          } catch (error) {
            caseError = safeCaseError(error)
            execution = {
              caseState: 'error',
              box: null,
              cutoutPresent: false,
              maskPackedSha256: null,
            }
          } finally {
            cropped.fill(0)
            cutoutPng?.fill(0)
          }
        } else {
          execution = {
            caseState: 'error',
            box: null,
            cutoutPresent: false,
            maskPackedSha256: null,
          }
        }
        return makeCaseExecutionResult(
          input,
          PROFILE_CONTROL_ID,
          recorder,
          dispatchContext.journal,
          execution,
          context.dispatchJournal,
          cutoutSidecar ? [cutoutSidecar] : [],
          caseError,
        )
      } finally {
        sourceBytes.fill(0)
        await rm(caseRoot, { recursive: true, force: false })
      }
    },
  }
}

async function createH8FreshRuntimePortsInternal(
  options: AnyFreshRuntimePortOptions,
): Promise<H8FreshRuntimePorts> {
  assertIndependentProfilePolicies()
  if (!options.apiKey || !options.artifactRoot || !options.temporaryRoot)
    throw new TypeError('H8 fresh runtime ports require caller supplied key and artifact roots')
  if (!options.controlEngine || typeof options.controlEngine !== 'object')
    throw new TypeError('H8 fresh runtime ports require an explicit control-engine bundle')
  if (options.controlEngine.kind === 'verified-historical-v02') {
    if (
      options.controlEngine.sourceClosureSha256 !==
        V02_CONTROL_PROFILE.requestPolicy.sourceClosureSha256 ||
      options.controlEngine.snapshotReceiptSha256 !==
        V02_CONTROL_PROFILE.requestPolicy.snapshotReceiptSha256 ||
      typeof options.controlEngine.processRegionSeededCase !== 'function' ||
      typeof options.controlEngine.assertRecorderHealthy !== 'function' ||
      typeof options.controlEngine.createClassifier !== 'function' ||
      typeof options.controlEngine.createOpenRouterDecisions !== 'function' ||
      typeof options.controlEngine.createNativeCategoricalPresencePort !== 'function' ||
      typeof options.controlEngine.createMobileSamSegmenter !== 'function'
    )
      throw new RangeError(
        'Historical control engine identity or entrypoints do not match the freeze',
      )
  } else if (options.controlEngine.kind === 'offline-fixture-only') {
    if (
      !options.fetch ||
      typeof options.controlEngine.processRegionSeededCase !== 'function' ||
      typeof options.controlEngine.assertRecorderHealthy !== 'function' ||
      typeof options.controlEngine.createClassifier !== 'function' ||
      typeof options.controlEngine.createOpenRouterDecisions !== 'function' ||
      typeof options.controlEngine.createNativeCategoricalPresencePort !== 'function' ||
      typeof options.controlEngine.createControlSegmenter !== 'function'
    )
      throw new RangeError(
        'Offline control fixtures require explicit entrypoints and injected fetch',
      )
  } else {
    throw new RangeError('Unsupported control engine kind')
  }
  const ownedCanvasEntries = [...options.sourceCanvasByOpaqueCaseId].map(([opaqueId, canvas]) => {
    if (
      !opaqueId ||
      !Number.isSafeInteger(canvas.width) ||
      !Number.isSafeInteger(canvas.height) ||
      canvas.width < 1 ||
      canvas.height < 1 ||
      canvas.width * canvas.height > 2_097_152
    )
      throw new RangeError('Frozen source canvas map contains invalid oriented dimensions')
    return [opaqueId, Object.freeze({ width: canvas.width, height: canvas.height })] as const
  })
  if (ownedCanvasEntries.length === 0)
    throw new RangeError('Frozen source canvas map must not be empty')
  const ownedOptions: AnyFreshRuntimePortOptions = {
    ...options,
    sourceCanvasByOpaqueCaseId: new Map(ownedCanvasEntries),
  }
  await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 })
  await mkdir(options.temporaryRoot, { recursive: true, mode: 0o700 })
  const raster = createSharpRaster()
  const selectedRecipeId = options.nativeRuntime.recipeId ?? PROFILE_CANDIDATE_ID
  const candidateRuntime = options.createCandidateRuntime
    ? await options.createCandidateRuntime(selectedRecipeId)
    : createH8aFullRuntime({
        ...options.nativeRuntime,
        recipeId: selectedRecipeId,
        artifactRoot: options.artifactRoot,
      })
  let segmenter: SegmentationPort | undefined
  try {
    segmenter =
      options.controlEngine.kind === 'verified-historical-v02'
        ? await options.controlEngine.createMobileSamSegmenter({
            encoderPath: options.mobileSam.encoderPath,
            decoderPath: options.mobileSam.decoderPath,
            executionProvider: 'cpu',
            threads: 2,
          })
        : await options.controlEngine.createControlSegmenter()
  } catch (error) {
    await candidateRuntime.dispose()
    throw error
  }
  const artifacts: FreshRuntimeArtifacts = {
    masksBySha256: new Map(),
    cutoutsBySha256: new Map(),
    cutoutsByProfileAndCase: new Map(),
  }
  const fetchJournal: CampaignFetchJournalEntry[] = []
  const candidatePort = buildCandidatePort(
    candidateRuntime,
    selectedRecipeId,
    ownedOptions,
    raster,
    artifacts,
    fetchJournal,
  )
  const controlPort = buildControlPort(segmenter, ownedOptions, artifacts, fetchJournal)
  let disposed = false
  return {
    candidatePort,
    controlPort,
    artifacts,
    fetchJournal,
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await candidateRuntime.dispose()
      } finally {
        await segmenter?.dispose()
      }
    },
  }
}

export async function createH8FreshRuntimePorts(
  options: H8FreshRuntimePortOptions,
): Promise<H8FreshRuntimePorts> {
  if (options.controlEngine.kind !== 'verified-historical-v02')
    throw new RangeError('Campaign runtime ports require the verified historical control engine')
  return createH8FreshRuntimePortsInternal(options)
}

export async function createH8FreshRuntimePortsForOfflineFixture(
  options: OfflineFixtureRuntimePortOptions,
): Promise<H8FreshRuntimePorts> {
  if (options.controlEngine.kind !== 'offline-fixture-only' || !options.fetch)
    throw new RangeError('Offline fixture runtime requires the explicit fixture engine and fetch')
  return createH8FreshRuntimePortsInternal(options)
}
