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
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { inputManifestSchema, hashCanonical } from './protocol.js'
import type { ProducerCase, ProducerManifest } from './protocol.js'
import { RunBudget } from './budget.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { recordProvider } from './recording.js'
import { presentationVariantHash, presentationVariants } from './presentationvariants.js'
import type { PresentationVariantId } from './presentationvariants.js'
import { appendRuntimeSourceFiles } from '../runtime-source-files.js'

const manifestUrl = new URL('./input-manifest.json', import.meta.url)
const physicalCallLimit = 64
const costLimitUsd = 1
const unknownReserveUsd = 0.02

export interface PresentationPilotOptions {
  imageRoot: string
  outputRoot: string
  apiKey: string
  rendererSha256?: string
  boundaryView?: BoundaryViewPort
  fetch?: typeof globalThis.fetch
  composeClassifier: (
    decision: DecisionPort,
    variantId: PresentationVariantId,
    boundaryView: BoundaryViewPort | undefined,
    timeoutMs: number,
  ) => Classifier
}

interface CaseOutcome {
  caseId: string
  variantId: PresentationVariantId
  status: 'located' | 'unknown' | 'not-found' | 'failed' | 'not-run-budget'
  sourceSha256: string | null
  imageDimensions: { width: number; height: number } | null
  sourceRequestHashes: string[]
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

export function safeErrorCode(error: unknown): string {
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

async function readManifest(): Promise<ProducerManifest> {
  const manifest = inputManifestSchema.parse(JSON.parse(await readFile(manifestUrl, 'utf8')))
  const expectedCases = ['photo-dev-01', 'photo-dev-02', 'photo-dev-03', 'photo-dev-05']
  if (
    manifest.manifestId !== 'old-exposed-dev4-diagnostic-v1' ||
    manifest.cases.length !== expectedCases.length ||
    manifest.cases.some((item, index) => item.caseId !== expectedCases[index])
  )
    throw new TypeError('Paired pilot requires the frozen four-case exposed development manifest')
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
  return createOpenRouterDecisions({
    apiKey,
    model: presentationVariants['numeric-v1'].route.model,
    provider: presentationVariants['numeric-v1'].route.provider,
    providerName: presentationVariants['numeric-v1'].route.providerName,
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

/** Paired exposed-development comparison. This never reads evaluator truth. */
export async function runPresentationPilot(options: PresentationPilotOptions) {
  if (!options.boundaryView)
    throw new TypeError('Paired comparison requires the axis-rulers renderer')
  const variantIds: readonly PresentationVariantId[] = ['numeric-v1', 'axis-rulers-v1']
  const variantHashes = Object.fromEntries(
    variantIds.map((variantId) => [
      variantId,
      presentationVariantHash(
        variantId,
        variantId === 'axis-rulers-v1' ? options.rendererSha256 : undefined,
      ),
    ]),
  ) as Record<PresentationVariantId, string>
  const manifest = await readManifest()
  const runId = `v02-presentation-paired-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const sourceFilePrefix = [
    './presentationpilot.ts',
    './presentationvariants.ts',
    '../../src/processes/whole-object.ts',
    '../../src/processes/boundary-state.ts',
    '../../src/processes/locate.ts',
    '../../src/features/prompts.ts',
    '../../src/features/choice.ts',
    '../../src/features/choice-beam-layout.ts',
    '../../src/features/uniform-grid.ts',
    '../../src/infrastructure/openrouter.ts',
    '../experiments/boundary-view.ts',
    '../experiments/create-research-classifier.ts',
  ] as const
  const sourceFiles = await appendRuntimeSourceFiles(sourceFilePrefix, import.meta.url)
  const sourceParts = await Promise.all(
    sourceFiles.map(async (path) => ({
      path,
      source: await readFile(new URL(path, import.meta.url), 'utf8'),
    })),
  )
  const actualRendererSha256 = sha256(
    sourceParts.find(({ path }) => path === '../experiments/boundary-view.ts')!.source,
  )
  if (actualRendererSha256 !== options.rendererSha256)
    throw new TypeError('Renderer source digest does not match the supplied frozen digest')
  const producerSourceSha256 = hashCanonical(sourceParts)
  const budget = new RunBudget(physicalCallLimit, costLimitUsd, unknownReserveUsd)
  const manifestRecord = {
    schemaVersion: 1,
    runId,
    purpose: 'paired exposed old-development whole-object presentation pilot; not qualification',
    startedAt: new Date().toISOString(),
    comparisonId: 'numeric-v1-vs-axis-rulers-v1',
    variants: variantIds.map((variantId) => ({
      ...presentationVariants[variantId],
      variantSha256: variantHashes[variantId],
      rendererSha256: variantId === 'axis-rulers-v1' ? options.rendererSha256 : null,
    })),
    producerSourceSha256,
    sourceManifestSha256: hashCanonical(manifest),
    selectedCaseIds: manifest.cases.map(({ caseId }) => caseId),
    route: presentationVariants['numeric-v1'].route,
    latencyEnvironment: 'concurrent-with-linux-native-soak',
    latencyRankingEligible: false,
    wholeObject: {
      boxTolerancePx: 8,
      maxExtentPasses: 3,
      timeoutMs: 45000,
      retries: 0,
      allowFallbacks: false,
    },
    limits: {
      maxPhysicalCalls: physicalCallLimit,
      maxCostUsd: costLimitUsd,
      unknownCostReserveUsd: unknownReserveUsd,
      selectedCases: 4,
      pairedOperations: 8,
    },
    modelBoundary: {
      sourceCaseIdsAndPathsAreProducerLocalOnly: true,
      evaluatorTruthRead: false,
      retries: 0,
      fallback: false,
    },
  }
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), manifestRecord)

  const outcomes: CaseOutcome[] = []
  const physicalCalls: PhysicalCallRecord[] = []
  let budgetStopped = false
  const expectedOutcomes = manifest.cases.length * variantIds.length
  for (const input of manifest.cases) {
    let source: Awaited<ReturnType<typeof loadSource>> | undefined
    let sourceError: string | undefined
    try {
      source = await loadSource(input, options.imageRoot)
    } catch (error) {
      sourceError = safeErrorCode(error)
    }
    for (const variantId of variantIds) {
      const variant = presentationVariants[variantId]
      const caseDirectory = join(outputDirectory, input.caseId, variantId)
      await mkdir(caseDirectory, { recursive: true })
      if (budgetStopped) break
      const started = performance.now()
      let recorder: Recorder | undefined
      let outcome: CaseOutcome
      if (!source) {
        outcome = {
          caseId: input.caseId,
          variantId,
          status: 'failed',
          sourceSha256: null,
          imageDimensions: null,
          sourceRequestHashes: [],
          errorCode: sourceError ?? 'RUNNER_FAILURE',
          durationMs: performance.now() - started,
        }
      } else {
        try {
          recorder = recordProvider(
            (recordedFetch) => makeProvider(options.apiKey, recordedFetch),
            budget,
            join(caseDirectory, 'calls'),
            variant.route,
            options.fetch ?? globalThis.fetch,
          )
          const classifier = options.composeClassifier(
            recorder.port,
            variantId,
            variantId === 'axis-rulers-v1' ? options.boundaryView : undefined,
            variant.timeoutMs,
          )
          let result: WholeObjectLocalizationResult
          try {
            result = await classifier.locate({
              image: source.bytes,
              target: input.target,
              mode: 'whole-object',
              boxTolerancePx: variant.boxTolerancePx,
              maxExtentPasses: variant.maxExtentPasses,
            })
          } finally {
            await classifier.dispose()
          }
          const resultSummary = resultFields(result)
          outcome = {
            caseId: input.caseId,
            variantId,
            status: result.status,
            sourceSha256: source.sourceSha256,
            imageDimensions: { width: source.width, height: source.height },
            sourceRequestHashes: recorder.logicalCalls.map((call) => call.requestSha256),
            ...(resultSummary === undefined ? {} : { result: resultSummary }),
            durationMs: performance.now() - started,
          }
        } catch (error) {
          const code = safeErrorCode(error)
          outcome = {
            caseId: input.caseId,
            variantId,
            status: 'failed',
            sourceSha256: source.sourceSha256,
            imageDimensions: { width: source.width, height: source.height },
            sourceRequestHashes: recorder?.logicalCalls.map((call) => call.requestSha256) ?? [],
            errorCode: code,
            durationMs: performance.now() - started,
          }
          if (code === 'V02_RUN_BUDGET_EXHAUSTED') budgetStopped = true
        }
        if (recorder) physicalCalls.push(...recorder.calls)
      }
      outcomes.push(outcome)
      await writeImmutable(join(caseDirectory, 'outcome.json'), outcome)
    }
    if (budgetStopped) break
  }
  if (outcomes.length < expectedOutcomes) {
    const completed = new Set(outcomes.map(({ caseId, variantId }) => `${caseId}/${variantId}`))
    for (const input of manifest.cases)
      for (const variantId of variantIds) {
        if (completed.has(`${input.caseId}/${variantId}`)) continue
        const skipped: CaseOutcome = {
          caseId: input.caseId,
          variantId,
          status: 'not-run-budget',
          sourceSha256: null,
          imageDimensions: null,
          sourceRequestHashes: [],
          errorCode: 'V02_RUN_BUDGET_EXHAUSTED',
          durationMs: 0,
        }
        const caseDirectory = join(outputDirectory, input.caseId, variantId)
        await mkdir(caseDirectory, { recursive: true })
        outcomes.push(skipped)
        await writeImmutable(join(caseDirectory, 'outcome.json'), skipped)
      }
  }

  const aggregate = budget.snapshot()
  const summary = {
    runId,
    comparisonId: 'numeric-v1-vs-axis-rulers-v1',
    variantHashes,
    status: outcomes.every((item) => item.status !== 'failed' && item.status !== 'not-run-budget')
      ? 'complete'
      : 'incomplete',
    caseCount: outcomes.length,
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
