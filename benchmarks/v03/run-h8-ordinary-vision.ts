import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import sharp from 'sharp'
import type { RasterPort } from '../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import { unpackBinaryMask } from '../../src/features/segmentation/packed-mask.js'
import { createSharpRaster } from '../../src/infrastructure/raster.js'
import { RunBudget } from '../v02/budget.js'
import {
  isRecorderBoundToBudget,
  type PhysicalCallRecord,
  type Recorder,
} from '../v02/recording.js'
import {
  createH6ContextComposer,
  createSharpH6Presentation,
  H6_LIMITS,
} from './h6-context-composer.js'
import type {
  H6ComposerFailure,
  H6DecisionBudgetRecordPort,
  H6DecisionStage,
  H6Family,
  H6NominationEvidence,
  H6PresenceEvidence,
} from './h6-context-composer.js'
import {
  decodeH6NativeCase,
  executeNativeRecipeCase,
  H6_CASE_IDS,
  loadH6NativeArtifacts,
  type H6NativeCase,
  type H6NativeMaskDescriptor,
  type NativeRecipeTiming,
} from './h6-replay-kernel.js'
import { captureH8ReplaySource } from './h8-replay-source-closure.js'

export const H8_LUNA_MODEL = 'openai/gpt-6-luna'
export const H8_SOL_MODEL = 'openai/gpt-6.1-sol'
export const H8_CHAT_ENDPOINT = '/api/v1/chat/completions'

export interface H8Route {
  model: typeof H8_LUNA_MODEL | typeof H8_SOL_MODEL
  provider: 'openai'
  providerName: 'OpenAI'
  apiEndpoint: typeof H8_CHAT_ENDPOINT
  allowFallbacks: false
  responseFormat: 'json-schema'
  reasoningEffort: 'medium'
  maxOutputTokens: 4096
}

export interface H8CapabilityReceipt {
  model: H8Route['model']
  provider: 'openai'
  endpoint: typeof H8_CHAT_ENDPOINT
  capturedAt: string
  modalities: readonly string[]
  structuredOutputs: true
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  source: string
  receiptSha256: string
}

export interface H8ReplayOptions {
  repositoryRoot: string
  h5aDirectory: string
  h4eDirectory: string
  outputDirectory: string
  recorder: Recorder
  budget: RunBudget
  route: H8Route
  capabilityReceipt: H8CapabilityReceipt
  signal?: AbortSignal
  imageState?: RasterPort['imageState']
  presentation?: Parameters<typeof createH6ContextComposer>[0]['presentation']
}

interface LogicalStageReceipt {
  case_id: string
  stage: H6DecisionStage
  call_ordinal: number
  request_sha256: string
  admitted_at: string
  outcome: 'resolved' | 'failed' | 'pending'
  metadata?: unknown
  error_code?: string
}

const routeBase = {
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: H8_CHAT_ENDPOINT,
  allowFallbacks: false,
  responseFormat: 'json-schema',
  reasoningEffort: 'medium',
  maxOutputTokens: 4096,
} as const

const armPolicy = {
  [H8_LUNA_MODEL]: {
    arm: 'h8a-openai-luna-chat',
    maxCostUsd: 2.4,
    unknownReserveUsd: 0.05,
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.5,
  },
  [H8_SOL_MODEL]: {
    arm: 'h8b-openai-gpt-6.1-sol-chat',
    maxCostUsd: 5,
    unknownReserveUsd: 0.25,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
  },
} as const

/** Creates the explicitly selected arm's ledger using the shared admission limits. */
export function createH8RunBudget(model: H8Route['model']): RunBudget {
  const policy = armPolicy[model]
  if (!policy) throw new ClassifierError('INVALID_INPUT', 'H8 model is outside frozen arms')
  return new RunBudget(48, policy.maxCostUsd, policy.unknownReserveUsd)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal })
  try {
    for await (const chunk of stream) hash.update(chunk)
    signal?.throwIfAborted()
    return hash.digest('hex')
  } finally {
    stream.destroy()
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ClassifierError) return error.code
  if (error instanceof Error) return error.name.slice(0, 64)
  return 'UNKNOWN_ERROR'
}

function serializedError(error: unknown): { code: string; message: string } {
  return {
    code: errorCode(error),
    message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown replay error',
  }
}

function validateOptions(options: H8ReplayOptions): void {
  if (!options?.recorder || !options.budget || !options.route || !options.capabilityReceipt)
    throw new ClassifierError(
      'INVALID_INPUT',
      'H8 requires caller-owned recorder, budget, route, and capability receipt',
    )
  const policy = armPolicy[options.route.model]
  if (!policy) throw new ClassifierError('INVALID_INPUT', 'H8 model is outside frozen arms')
  if (
    Object.keys(routeBase).some(
      (key) => options.route[key as keyof H8Route] !== routeBase[key as keyof typeof routeBase],
    )
  )
    throw new ClassifierError('INVALID_INPUT', 'H8 route parameters differ from the frozen recipe')
  if (
    options.budget.maxPhysicalCalls !== 48 ||
    options.budget.maxCostUsd !== policy.maxCostUsd ||
    options.budget.unknownReserveUsd !== policy.unknownReserveUsd
  )
    throw new ClassifierError('INVALID_INPUT', 'H8 budget differs from the selected frozen arm')
  if (!isRecorderBoundToBudget(options.recorder, options.budget))
    throw new ClassifierError('INVALID_INPUT', 'H8 recorder is not bound to the supplied budget')
  if (!options.recorder.port || typeof options.recorder.port.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'H8 requires a recorded DecisionPort')
  if (
    options.recorder.calls.length !== 0 ||
    options.recorder.logicalCalls.length !== 0 ||
    options.budget.snapshot().admittedPhysicalCalls !== 0 ||
    options.budget.snapshot().inFlightCalls !== 0
  )
    throw new ClassifierError('INVALID_INPUT', 'H8 requires a fresh arm-scoped recorder and budget')
  const receipt = options.capabilityReceipt
  if (
    receipt.model !== options.route.model ||
    receipt.provider !== 'openai' ||
    receipt.endpoint !== H8_CHAT_ENDPOINT ||
    !receipt.capturedAt ||
    !Array.isArray(receipt.modalities) ||
    receipt.modalities.length !== 2 ||
    !receipt.modalities.includes('text') ||
    !receipt.modalities.includes('image') ||
    receipt.structuredOutputs !== true ||
    receipt.inputUsdPerMillion !== policy.inputUsdPerMillion ||
    receipt.outputUsdPerMillion !== policy.outputUsdPerMillion ||
    !receipt.source ||
    !/^[a-f0-9]{64}$/u.test(receipt.receiptSha256)
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'H8 capability receipt does not match the selected model/provider/endpoint',
    )
}

function routeMatches(call: PhysicalCallRecord, route: H8Route): boolean {
  return (
    call.route.model === route.model &&
    call.route.provider === route.provider &&
    call.route.providerName === route.providerName &&
    call.route.apiEndpoint === route.apiEndpoint &&
    call.route.allowFallbacks === false
  )
}

function rosterFor(item: H6NativeCase, h5aDirectory: string) {
  const familyOrdinal: Record<H6Family, number> = { D: 0, U: 0 }
  return item.masks.map((candidate, rosterOrdinal) => {
    const ordinal = familyOrdinal[candidate.family]
    familyOrdinal[candidate.family] = ordinal + 1
    return {
      family: candidate.family,
      composer_alias: `${candidate.family}${String(ordinal).padStart(2, '0')}`,
      source_family: candidate.source_family,
      source_alias: candidate.source_alias,
      source_mask_path: relative(resolve(h5aDirectory), candidate.source_mask_path)
        .split('\\')
        .join('/'),
      candidate_mask_sha256: candidate.source_mask_sha256,
      roster_ordinal: rosterOrdinal,
    }
  })
}

function nominationRows(nominations: readonly H6NominationEvidence[]) {
  return nominations.map((entry) => ({
    family: entry.family,
    top_four: entry.topFour,
    nominee_aliases: entry.nomineeAliases,
    selection: entry.selection,
    metadata: entry.metadata,
  }))
}

function nullSelection() {
  return {
    selected_alias: null,
    selected_family: null,
    source_family: null,
    source_alias: null,
    candidate_mask_sha256: null,
    selected_region: null,
    selected_mask_path: null,
    selected_mask_sha256: null,
  }
}

function packPartial(error: unknown): {
  presence: H6PresenceEvidence | null
  nominations: H6NominationEvidence[]
} {
  const partial = (error as Partial<H6ComposerFailure>)?.partial
  return partial && typeof partial === 'object'
    ? { presence: partial.presence ?? null, nominations: partial.nominations ?? [] }
    : { presence: null, nominations: [] }
}

function selectionColumns(
  composition: {
    alias: string
    family: H6Family
    sourceAlias: string
    region: { left: number; top: number; width: number; height: number }
  },
  candidate: H6NativeMaskDescriptor,
  outputPath: string,
  outputHash: string,
) {
  return {
    selected_alias: composition.alias,
    selected_family: composition.family,
    source_family: candidate.source_family,
    source_alias: composition.sourceAlias,
    candidate_mask_sha256: candidate.source_mask_sha256,
    selected_region: composition.region,
    selected_mask_path: outputPath,
    selected_mask_sha256: outputHash,
  }
}

/** Replay one H8 ordinary-vision arm. It never downloads native assets or chooses routes. */
export async function runH8OrdinaryVisionReplay(
  options: H8ReplayOptions,
): Promise<Record<string, unknown>> {
  validateOptions(options)
  const policy = armPolicy[options.route.model]
  const outputDirectory = resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: false })
  const casesDirectory = resolve(outputDirectory, 'cases')
  await mkdir(casesDirectory, { recursive: false })
  const parentSignal = options.signal ?? new AbortController().signal
  const preflightController = new AbortController()
  const preflightTimer = setTimeout(
    () =>
      preflightController.abort(
        new ClassifierError('TIMEOUT', 'H8 preflight exceeded 240 seconds'),
      ),
    H6_LIMITS.caseDeadlineMs,
  )
  preflightTimer.unref?.()
  const preflightSignal = AbortSignal.any([parentSignal, preflightController.signal])
  let loaded: Awaited<ReturnType<typeof loadH6NativeArtifacts>>
  let executableSource: Awaited<ReturnType<typeof captureH8ReplaySource>>
  try {
    loaded = await loadH6NativeArtifacts(
      options.h5aDirectory,
      options.h4eDirectory,
      preflightSignal,
    )
    for (const artifact of loaded.closure) {
      if ((await hashFile(artifact.path, preflightSignal)) !== artifact.sha256)
        throw new ClassifierError(
          'INVALID_INPUT',
          'H8 native source changed before dispatch freeze',
        )
    }
    executableSource = await captureH8ReplaySource(options.repositoryRoot, preflightSignal)
  } finally {
    clearTimeout(preflightTimer)
  }

  const budgetRecord = {
    max_physical_calls: 48,
    max_cost_usd: policy.maxCostUsd,
    unknown_reserve_usd_per_call: policy.unknownReserveUsd,
  }
  const freeze = {
    schema: 'v03-h8-ordinary-vision-freeze-v1',
    status: 'frozen-before-replay',
    arm: policy.arm,
    route: options.route,
    capability_receipt: options.capabilityReceipt,
    h5a: {
      run_sha256: loaded.locks.h5aRun,
      freeze_sha256: loaded.locks.h5aFreeze,
      postrun_integrity_sha256: loaded.locks.h5aIntegrity,
      worker_closure_sha256: loaded.locks.h5aWorkerClosure,
      h3b_run_sha256: loaded.locks.h3bRun,
      h4e_run_sha256: loaded.locks.h4eRun,
    },
    source_closure: loaded.closure,
    executable_source: executableSource,
    budget: budgetRecord,
    limits: {
      calls_per_case: 4,
      total_calls: 48,
      image_parts_per_nomination: 5,
      final_image_parts: 9,
      case_deadline_ms: H6_LIMITS.caseDeadlineMs,
      candidates_per_family: H6_LIMITS.familyCandidates,
      total_candidates: H6_LIMITS.totalCandidates,
      packed_mask_bytes: H6_LIMITS.packedMaskBytes,
    },
    case_ids: H6_CASE_IDS,
    provider_calls_directory: 'provider-calls',
  }
  await writeFile(resolve(outputDirectory, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, {
    flag: 'wx',
  })

  const initialPhysicalCount = options.recorder.calls.length
  const initialLogicalCount = options.recorder.logicalCalls.length
  const logicalStageReceipts: LogicalStageReceipt[] = []
  const rows: Array<Record<string, unknown>> = []
  let currentCaseId = ''
  const composerBudget: H6DecisionBudgetRecordPort = {
    admit({ stage, callOrdinal, requestSha256, signal }) {
      assertActive(signal)
      assertActive(parentSignal)
      if (callOrdinal > 4) throw new ClassifierError('RESOURCE_LIMIT', 'H8 call count exceeded')
      logicalStageReceipts.push({
        case_id: currentCaseId,
        stage,
        call_ordinal: callOrdinal,
        request_sha256: requestSha256,
        admitted_at: new Date().toISOString(),
        outcome: 'pending',
      })
    },
    settle({ stage, requestSha256, outcome, metadata, errorCode: code }) {
      const receipt = logicalStageReceipts.findLast(
        (entry) =>
          entry.stage === stage &&
          entry.request_sha256 === requestSha256 &&
          entry.outcome === 'pending',
      )
      if (!receipt)
        throw new ClassifierError(
          'INVALID_INPUT',
          'H8 logical settlement has no matching admission',
        )
      receipt.outcome = outcome
      if (metadata) receipt.metadata = metadata
      if (code) receipt.error_code = code
    },
  }
  const composer = createH6ContextComposer({
    decision: options.recorder.port,
    imageState: options.imageState ?? createSharpRaster().imageState,
    presentation: options.presentation ?? createSharpH6Presentation(),
    budgetRecord: composerBudget,
  })
  const startedRun = performance.now()

  for (const item of loaded.cases) {
    currentCaseId = item.case_id
    const caseDirectory = resolve(casesDirectory, item.case_id)
    await mkdir(caseDirectory, { recursive: false })
    const caseStarted = performance.now()
    const physicalStart = options.recorder.calls.length
    const logicalStart = logicalStageReceipts.length
    const recorderLogicalStart = options.recorder.logicalCalls.length
    const candidateRoster = rosterFor(item, options.h5aDirectory)
    let timing: NativeRecipeTiming = {
      preparationElapsedMs: 0,
      compositionElapsedMs: null,
      replayElapsedMs: 0,
    }
    let status = 'error'
    try {
      const completed = await executeNativeRecipeCase(
        item,
        parentSignal,
        H6_LIMITS.caseDeadlineMs,
        {
          prepare: decodeH6NativeCase,
          compose: (current, prepared, signal) =>
            composer.compose({
              image: prepared.image,
              target: current.target,
              exclusions: [],
              families: prepared.families,
              signal,
            }),
          disposeComposition(composition) {
            if (composition.status === 'located') composition.mask.data.fill(0)
          },
          onTiming(value) {
            timing = value
          },
          async finish(current, prepared, composition, elapsed, signal) {
            assertActive(signal)
            status = composition.status
            const common = {
              case_id: current.case_id,
              target: current.target,
              source_sha256: current.source_sha256,
              source_width: prepared.image.width,
              source_height: prepared.image.height,
              native_generation_ms: current.native_generation_ms,
              replay_elapsed_ms: elapsed.replayElapsedMs,
              preparation_elapsed_ms: elapsed.preparationElapsedMs,
              composition_elapsed_ms: elapsed.compositionElapsedMs,
              candidate_roster: candidateRoster,
              presence: composition.presence,
              nominations: nominationRows(composition.nominations),
              physical_call_count: options.recorder.calls.length - physicalStart,
              logical_calls: logicalStageReceipts.slice(logicalStart),
              error_code: null,
            }
            if (composition.status === 'located') {
              const source = item.masks.find(
                (candidate) =>
                  candidate.family === composition.family &&
                  candidate.source_alias === composition.sourceAlias,
              )
              const roster = candidateRoster.find(
                (candidate) => candidate.composer_alias === composition.alias,
              )
              if (!source || !roster)
                throw new ClassifierError(
                  'INVALID_RESPONSE',
                  'H8 selected alias lacks frozen provenance',
                )
              const unpacked = unpackBinaryMask(composition.mask)
              const pixels = Uint8Array.from(unpacked, (value) => value * 255)
              try {
                const png = await sharp(pixels, {
                  raw: { width: prepared.image.width, height: prepared.image.height, channels: 1 },
                })
                  .png({ compressionLevel: 9, adaptiveFiltering: false })
                  .toBuffer()
                try {
                  assertActive(signal)
                  const outputPath = resolve(caseDirectory, 'selected-mask.png')
                  await writeFile(outputPath, png, { flag: 'wx' })
                  rows.push({
                    ...common,
                    status,
                    ...selectionColumns(
                      composition,
                      source,
                      relative(outputDirectory, outputPath).split('\\').join('/'),
                      sha256(png),
                    ),
                    final_selection: composition.finalSelection,
                    final_metadata: composition.finalMetadata,
                    unknown_reason: null,
                  })
                } finally {
                  png.fill(0)
                }
              } finally {
                unpacked.fill(0)
                pixels.fill(0)
              }
            } else {
              rows.push({
                ...common,
                status: 'unknown',
                ...nullSelection(),
                final_selection: composition.finalSelection,
                final_metadata: composition.finalMetadata,
                unknown_reason: composition.reason,
              })
            }
            return composition
          },
        },
      )
      if (completed.status === 'unknown') status = 'unknown'
    } catch (error) {
      const detail = serializedError(error)
      status = parentSignal.aborted || detail.code === 'TIMEOUT' ? 'timeout' : 'error'
      const partial = packPartial(error)
      rows.push({
        case_id: item.case_id,
        target: item.target,
        source_sha256: item.source_sha256,
        source_width: item.source_width,
        source_height: item.source_height,
        native_generation_ms: item.native_generation_ms,
        replay_elapsed_ms: performance.now() - caseStarted,
        preparation_elapsed_ms: timing.preparationElapsedMs || null,
        composition_elapsed_ms: timing.compositionElapsedMs,
        candidate_roster: candidateRoster,
        presence: partial.presence,
        nominations: nominationRows(partial.nominations),
        ...nullSelection(),
        final_selection: null,
        final_metadata: null,
        unknown_reason: null,
        status,
        physical_call_count: options.recorder.calls.length - physicalStart,
        logical_calls: logicalStageReceipts.slice(logicalStart),
        error_code: detail.code,
        error_message: detail.message,
      })
    }
    const rowReceipts = rows.at(-1)?.logical_calls
    if (Array.isArray(rowReceipts)) {
      const matched = new Set<number>()
      for (const receipt of rowReceipts) {
        if (!receipt || typeof receipt !== 'object' || !('request_sha256' in receipt)) continue
        const match = options.recorder.logicalCalls
          .slice(recorderLogicalStart)
          .find(
            (call) => call.requestSha256 === receipt.request_sha256 && !matched.has(call.logicalId),
          )
        if (match) {
          matched.add(match.logicalId)
          Object.assign(receipt, { logical_id: match.logicalId })
        }
      }
    }
    if (
      options.recorder.calls.length - physicalStart > 4 ||
      options.recorder.calls.length - initialPhysicalCount > 48 ||
      options.budget.snapshot().admittedPhysicalCalls > 48
    )
      throw new ClassifierError('RESOURCE_LIMIT', 'H8 physical call ceiling exceeded')
    await writeFile(
      resolve(outputDirectory, 'progress.json'),
      `${JSON.stringify({ schema: 'v03-h8-ordinary-vision-progress-v1', status: 'running', case_ids: H6_CASE_IDS, completed_rows: rows, physical_call_count: options.recorder.calls.length - initialPhysicalCount, logical_call_count: logicalStageReceipts.length }, null, 2)}\n`,
    )
  }

  const physicalCalls = options.recorder.calls.slice(initialPhysicalCount)
  if (physicalCalls.some((call) => !routeMatches(call, options.route)))
    throw new ClassifierError(
      'INVALID_INPUT',
      'H8 physical request escaped frozen model/provider route',
    )
  const sourceAfter = await captureH8ReplaySource(options.repositoryRoot, parentSignal)
  if (sourceAfter.sha256 !== executableSource.sha256)
    throw new ClassifierError('INVALID_INPUT', 'H8 executable source changed during replay')
  for (const artifact of loaded.closure) {
    if ((await hashFile(artifact.path, parentSignal)) !== artifact.sha256)
      throw new ClassifierError('INVALID_INPUT', 'H8 native source changed during replay')
  }
  if (
    rows.length !== H6_CASE_IDS.length ||
    JSON.stringify(rows.map((row) => row.case_id)) !== JSON.stringify(H6_CASE_IDS)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'H8 runner did not preserve all fixed case rows')
  const snapshot = options.budget.snapshot()
  if (
    snapshot.inFlightCalls !== 0 ||
    snapshot.admittedPhysicalCalls !== physicalCalls.length ||
    physicalCalls.length > 48
  )
    throw new ClassifierError('INVALID_RESPONSE', 'H8 physical receipts differ from settled budget')
  const record = {
    schema: 'v03-h8-ordinary-vision-run-v1',
    status: 'complete',
    arm: policy.arm,
    case_ids: H6_CASE_IDS,
    route: options.route,
    capability_receipt: options.capabilityReceipt,
    h5a: freeze.h5a,
    source_closure: loaded.closure,
    executable_source: executableSource,
    executable_source_after: sourceAfter,
    budget: {
      admitted_physical_calls: snapshot.admittedPhysicalCalls,
      known_cost_usd: snapshot.knownCostUsd,
      unknown_cost_calls: snapshot.unknownCostCalls,
      in_flight_calls: snapshot.inFlightCalls,
      accounted_exposure_usd: snapshot.accountedExposureUsd,
      max_physical_calls: snapshot.maxPhysicalCalls,
      max_cost_usd: snapshot.maxCostUsd,
      unknown_reserve_usd_per_call: options.budget.unknownReserveUsd,
    },
    physical_call_count: physicalCalls.length,
    logical_call_count: logicalStageReceipts.length,
    physical_calls: physicalCalls.map((call) => ({
      ...call,
      chat_parameters: {
        response_format: options.route.responseFormat,
        reasoning_effort: options.route.reasoningEffort,
        max_output_tokens: options.route.maxOutputTokens,
      },
    })),
    logical_calls: [...options.recorder.logicalCalls.slice(initialLogicalCount)],
    logical_stage_receipts: logicalStageReceipts,
    replay_elapsed_ms: performance.now() - startedRun,
    provider_calls_directory: 'provider-calls',
    rows,
  }
  await writeFile(resolve(outputDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
  })
  await writeFile(
    resolve(outputDirectory, 'progress.json'),
    `${JSON.stringify({ schema: 'v03-h8-ordinary-vision-progress-v1', status: 'complete', case_ids: H6_CASE_IDS, completed_rows: rows, physical_call_count: physicalCalls.length, logical_call_count: logicalStageReceipts.length }, null, 2)}\n`,
  )
  return record
}
