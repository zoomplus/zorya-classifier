import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import type { Classifier } from '../../src/app/create-classifier.js'
import type { DecisionPort } from '../../src/entities/contracts.js'
import type { BoundaryViewPort } from '../../src/entities/boundary-view.js'
import type {
  ObjectBounds,
  WholeObjectLocalizationResult,
} from '../../src/entities/whole-object.js'
import { createOpenRouterVision } from '../../src/infrastructure/openrouter-vision.js'
import { createSharpBoundaryView } from '../experiments/boundary-view.js'
import { inputManifestSchema, hashCanonical } from './protocol.js'
import type { ProducerCase, ProducerManifest } from './protocol.js'
import { RunBudget } from './budget.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { recordProvider } from './recording.js'
import { safeErrorCode } from './presentationpilot.js'
import {
  ordinaryVisionAxisVariant,
  ordinaryVisionAxisVariantHash,
} from './ordinaryvisionvariant.js'
import { appendRuntimeSourceFiles } from '../runtime-source-files.js'

const manifestUrl = new URL('./input-manifest.json', import.meta.url)
const physicalCallLimit = 32
const costLimitUsd = 1
const unknownReserveUsd = 0.02
const initialCaseIds = ['photo-dev-02', 'photo-dev-03'] as const
const conditionalCaseIds = ['photo-dev-01', 'photo-dev-05'] as const
const sourceFiles = [
  './ordinaryvisionpilot.ts',
  './ordinaryvisionvariant.ts',
  './run-ordinary-vision-axis-pilot.ts',
  './presentationpilot.ts',
  './protocol.ts',
  './recording.ts',
  '../credentials.ts',
  '../../src/app/create-classifier.ts',
  '../../src/processes/whole-object.ts',
  '../../src/processes/boundary-state.ts',
  '../../src/processes/locate.ts',
  '../../src/features/prompts.ts',
  '../../src/features/choice.ts',
  '../../src/features/choice-beam-layout.ts',
  '../../src/features/uniform-grid.ts',
  '../../src/infrastructure/vision-chat.ts',
  '../../src/infrastructure/vision-chat/options.ts',
  '../../src/infrastructure/vision-chat/request.ts',
  '../../src/infrastructure/vision-chat/response.ts',
  '../../src/infrastructure/openrouter-vision.ts',
  '../../src/infrastructure/decision-transport/errors.ts',
  '../../src/infrastructure/decision-transport/request.ts',
  '../../src/infrastructure/decision-transport/images.ts',
  '../../src/infrastructure/decision-transport/response.ts',
  '../../src/infrastructure/decision-transport/route-identity.ts',
  '../experiments/boundary-view.ts',
] as const

export interface OrdinaryVisionPilotOptions {
  imageRoot: string
  outputRoot: string
  apiKey: string
  rendererSha256: string
  fetch?: typeof globalThis.fetch
  composeClassifier: (decision: DecisionPort, boundaryView: BoundaryViewPort) => Classifier
}

interface CaseOutcome {
  caseId: string
  status: 'located' | 'unknown' | 'not-found' | 'failed' | 'not-run-early-stop' | 'not-run-budget'
  sourceSha256: string | null
  imageDimensions: { width: number; height: number } | null
  requestHashes: string[]
  result?: {
    region?: { left: number; top: number; width: number; height: number }
    seedRegion?: { left: number; top: number; width: number; height: number }
    bounds?: ObjectBounds
    completeness?: string
    reason?: string
  }
  errorCode?: string
  durationMs: number
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeImmutable(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

async function readManifest(): Promise<ProducerManifest> {
  const manifest = inputManifestSchema.parse(JSON.parse(await readFile(manifestUrl, 'utf8')))
  const expected = [...initialCaseIds, ...conditionalCaseIds]
  if (
    manifest.manifestId !== 'old-exposed-dev4-diagnostic-v1' ||
    manifest.cases.length !== expected.length ||
    expected.some((caseId) => !manifest.cases.some((item) => item.caseId === caseId))
  )
    throw new TypeError(
      'Ordinary vision pilot requires the frozen old exposed development manifest',
    )
  return manifest
}

async function loadSource(input: ProducerCase, root: string) {
  const rootPath = resolve(root)
  const path = resolve(rootPath, input.image.path)
  const rel = relative(rootPath, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Image escaped configured root')
  const bytes = new Uint8Array(await readFile(path))
  const sourceSha256 = sha256(bytes)
  if (sourceSha256 !== input.image.sha256) throw new Error('Source hash mismatch')
  const metadata = await sharp(bytes, { limitInputPixels: 20_000_000 }).metadata()
  if (metadata.width !== input.image.width || metadata.height !== input.image.height)
    throw new Error('Source dimensions mismatch')
  return { bytes, sourceSha256, width: metadata.width!, height: metadata.height! }
}

function makeProvider(apiKey: string, fetch: typeof globalThis.fetch): DecisionPort {
  return createOpenRouterVision({
    apiKey,
    model: ordinaryVisionAxisVariant.model,
    provider: ordinaryVisionAxisVariant.provider,
    providerName: ordinaryVisionAxisVariant.providerName,
    responseFormat: ordinaryVisionAxisVariant.responseFormat,
    reasoningEffort: ordinaryVisionAxisVariant.reasoningEffort,
    maxOutputTokens: ordinaryVisionAxisVariant.maxOutputTokens,
    fetch,
  })
}

function resultFields(result: WholeObjectLocalizationResult): CaseOutcome['result'] {
  if (result.status === 'located')
    return {
      region: result.region,
      seedRegion: result.seedRegion,
      bounds: result.bounds,
      completeness: result.completeness,
    }
  return 'reason' in result ? { reason: result.reason } : undefined
}

function latencySummary(values: readonly number[]) {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1] ?? null
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1)! }
}

export function shouldRunConditionalOrdinaryVisionCases(
  outcomes: readonly Pick<CaseOutcome, 'caseId' | 'status'>[],
): boolean {
  return outcomes.some(
    (item) =>
      initialCaseIds.includes(item.caseId as (typeof initialCaseIds)[number]) &&
      item.status === 'located',
  )
}

/** Ordinary Luna axis-view probe; evaluator truth never enters this producer. */
export async function runOrdinaryVisionPilot(options: OrdinaryVisionPilotOptions) {
  const renderer = await readFile(new URL('../experiments/boundary-view.ts', import.meta.url))
  const rendererSha256 = sha256(renderer)
  if (rendererSha256 !== options.rendererSha256)
    throw new TypeError('Boundary renderer source digest changed since the pilot was frozen')
  const resolvedSourceFiles = await appendRuntimeSourceFiles(
    [...sourceFiles, '../experiments/create-research-classifier.ts'],
    import.meta.url,
  )
  const sources = await Promise.all(
    resolvedSourceFiles.map(async (path) => ({
      path,
      sha256: sha256(await readFile(new URL(path, import.meta.url))),
    })),
  )
  const sourceHashes = Object.fromEntries(sources.map(({ path, sha256: digest }) => [path, digest]))
  const variantSha256 = ordinaryVisionAxisVariantHash(sourceHashes)
  const manifest = await readManifest()
  const inputs = new Map(manifest.cases.map((input) => [input.caseId, input]))
  const orderedCaseIds = [...initialCaseIds, ...conditionalCaseIds]
  const runId = `v02-ordinary-luna-axis-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(physicalCallLimit, costLimitUsd, unknownReserveUsd)
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    purpose:
      'ordinary Luna vision adapter on boundary-axis presentation; exposed diagnostic, not qualification',
    startedAt: new Date().toISOString(),
    variant: ordinaryVisionAxisVariant,
    variantSha256,
    sourceHashes,
    producerSourceSha256: hashCanonical(sources),
    sourceManifestSha256: hashCanonical(manifest),
    selectedCaseIds: orderedCaseIds,
    initialPositiveCaseIds: initialCaseIds,
    conditionalCaseIds,
    route: {
      model: ordinaryVisionAxisVariant.model,
      provider: ordinaryVisionAxisVariant.provider,
      providerName: ordinaryVisionAxisVariant.providerName,
      apiEndpoint: '/api/v1/chat/completions',
      allowFallbacks: false,
    },
    transport: {
      responseFormat: ordinaryVisionAxisVariant.responseFormat,
      reasoningEffort: ordinaryVisionAxisVariant.reasoningEffort,
      maxOutputTokens: ordinaryVisionAxisVariant.maxOutputTokens,
      promptId: ordinaryVisionAxisVariant.promptId,
      promptSource: 'src/infrastructure/vision-chat/request.ts',
      promptSourceSha256: sourceHashes['../../src/infrastructure/vision-chat/request.ts'],
      modelEvidence: 'https://openrouter.ai/openai/gpt-6-luna',
      transportEvidence:
        'https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request?explorer=true',
    },
    wholeObject: {
      boxTolerancePx: ordinaryVisionAxisVariant.boxTolerancePx,
      maxExtentPasses: ordinaryVisionAxisVariant.maxExtentPasses,
      timeoutMs: ordinaryVisionAxisVariant.timeoutMs,
      retries: ordinaryVisionAxisVariant.retries,
      allowFallbacks: false,
    },
    limits: {
      maxPhysicalCalls: physicalCallLimit,
      maxCostUsd: costLimitUsd,
      unknownCostReserveUsd: unknownReserveUsd,
      firstPairCalls: 2,
      totalOperations: orderedCaseIds.length,
    },
    latencyEnvironment: 'concurrent-with-linux-native-soak',
    latencyRankingEligible: false,
    modelBoundary: {
      evaluatorTruthRead: false,
      retries: 0,
      fallback: false,
      conditionalPairRunsOnlyIfOneInitialPositiveLocates: true,
    },
  })

  const outcomes: CaseOutcome[] = []
  const physicalCalls: PhysicalCallRecord[] = []
  let stoppedAfterInitialPair = false
  let budgetStopped = false
  for (const caseId of orderedCaseIds) {
    if (
      conditionalCaseIds.includes(caseId as (typeof conditionalCaseIds)[number]) &&
      !shouldRunConditionalOrdinaryVisionCases(outcomes)
    ) {
      stoppedAfterInitialPair = true
      break
    }
    const input = inputs.get(caseId)
    if (!input) throw new TypeError('Frozen pilot input is absent')
    const caseDirectory = join(outputDirectory, caseId)
    await mkdir(caseDirectory, { recursive: true })
    const started = performance.now()
    let source: Awaited<ReturnType<typeof loadSource>> | undefined
    let sourceError: string | undefined
    try {
      source = await loadSource(input, options.imageRoot)
    } catch (error) {
      sourceError = safeErrorCode(error)
    }
    let recorder: Recorder | undefined
    let outcome: CaseOutcome
    if (!source) {
      outcome = {
        caseId,
        status: 'failed',
        sourceSha256: null,
        imageDimensions: null,
        requestHashes: [],
        errorCode: sourceError ?? 'RUNNER_FAILURE',
        durationMs: performance.now() - started,
      }
    } else {
      try {
        recorder = recordProvider(
          (recordedFetch) => makeProvider(options.apiKey, recordedFetch),
          budget,
          join(caseDirectory, 'calls'),
          {
            model: ordinaryVisionAxisVariant.model,
            provider: ordinaryVisionAxisVariant.provider,
            providerName: ordinaryVisionAxisVariant.providerName,
            apiEndpoint: '/api/v1/chat/completions',
            allowFallbacks: false,
          },
          options.fetch ?? globalThis.fetch,
        )
        const classifier = options.composeClassifier(recorder.port, createSharpBoundaryView())
        let result: WholeObjectLocalizationResult
        try {
          result = await classifier.locate({
            image: source.bytes,
            target: input.target,
            mode: 'whole-object',
            boxTolerancePx: ordinaryVisionAxisVariant.boxTolerancePx,
            maxExtentPasses: ordinaryVisionAxisVariant.maxExtentPasses,
          })
        } finally {
          await classifier.dispose()
        }
        const resultSummary = resultFields(result)
        outcome = {
          caseId,
          status: result.status,
          sourceSha256: source.sourceSha256,
          imageDimensions: { width: source.width, height: source.height },
          requestHashes: recorder.logicalCalls.map((call) => call.requestSha256),
          ...(resultSummary === undefined ? {} : { result: resultSummary }),
          durationMs: performance.now() - started,
        }
      } catch (error) {
        outcome = {
          caseId,
          status: 'failed',
          sourceSha256: source.sourceSha256,
          imageDimensions: { width: source.width, height: source.height },
          requestHashes: recorder?.logicalCalls.map((call) => call.requestSha256) ?? [],
          errorCode: safeErrorCode(error),
          durationMs: performance.now() - started,
        }
        if (outcome.errorCode === 'V02_RUN_BUDGET_EXHAUSTED') budgetStopped = true
      }
      if (recorder) physicalCalls.push(...recorder.calls)
    }
    outcomes.push(outcome)
    await writeImmutable(join(caseDirectory, 'outcome.json'), outcome)
    if (budgetStopped) break
  }

  for (const caseId of orderedCaseIds) {
    if (outcomes.some((item) => item.caseId === caseId)) continue
    const status = stoppedAfterInitialPair ? 'not-run-early-stop' : 'not-run-budget'
    const skipped: CaseOutcome = {
      caseId,
      status,
      sourceSha256: null,
      imageDimensions: null,
      requestHashes: [],
      ...(status === 'not-run-budget' ? { errorCode: 'V02_RUN_BUDGET_EXHAUSTED' } : {}),
      durationMs: 0,
    }
    const caseDirectory = join(outputDirectory, caseId)
    await mkdir(caseDirectory, { recursive: true })
    outcomes.push(skipped)
    await writeImmutable(join(caseDirectory, 'outcome.json'), skipped)
  }

  const aggregate = budget.snapshot()
  const summary = {
    runId,
    variantId: ordinaryVisionAxisVariant.id,
    variantSha256,
    status: outcomes.every((item) => !['failed', 'not-run-budget'].includes(item.status))
      ? 'complete'
      : 'incomplete',
    stopReason: stoppedAfterInitialPair ? 'neither-initial-positive-located' : null,
    outcomes,
    aggregate,
    latency: latencySummary(physicalCalls.map((call) => call.durationMs)),
    latencyEnvironment: 'concurrent-with-linux-native-soak',
    latencyRankingEligible: false,
    physicalReceipts: physicalCalls.map((call) => ({
      physicalId: call.physicalId,
      requestSha256: call.requestSha256,
      requestBodySha256: call.requestBodySha256,
      route: call.route,
      receipt: call.receipt,
      wireReceipt: call.wireReceipt,
      errorCode: call.errorCode ?? null,
      durationMs: call.durationMs,
    })),
  }
  await writeImmutable(join(outputDirectory, 'summary.json'), summary)
  await writeImmutable(join(outputDirectory, 'run-complete.json'), {
    endedAt: new Date().toISOString(),
    aggregate,
  })
  return { ...summary, outputDirectory }
}
