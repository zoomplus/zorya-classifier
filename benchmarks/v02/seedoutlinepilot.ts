import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import type { Classifier } from '../../src/app/create-classifier.js'
import type { DecisionPort } from '../../src/entities/contracts.js'
import type { BoundaryViewPort } from '../../src/entities/boundary-view.js'
import type { WholeObjectLocalizationResult } from '../../src/entities/whole-object.js'
import type { WholeObjectIntervalPolicy } from '../../src/processes/whole-object.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { createSharpBoundaryView } from '../../src/infrastructure/boundary-view.js'
import { inputManifestSchema, hashCanonical } from './protocol.js'
import type { ProducerCase, ProducerManifest } from './protocol.js'
import { RunBudget } from './budget.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { recordProvider } from './recording.js'
import { safeErrorCode } from './presentationpilot.js'
import { withSeedUnboundedPrompt } from './seedunboundedprompt.js'
import { withSeedOutlinePresentation } from './seedoutlinepresentation.js'

const manifestUrl = new URL('./input-manifest.json', import.meta.url)
const caseIds = ['photo-dev-02', 'photo-dev-03'] as const
const route = Object.freeze({
  id: 'native-luna-axis-seed-outline-v1',
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
})
const policy = Object.freeze({
  promptId: 'seed-unbounded-v1',
  presentationId: 'original-seed-outline-v1',
  boxTolerancePx: 8,
  maxExtentPasses: 3,
  timeoutMs: 45000,
  retries: 0,
  allowFallbacks: false,
  maxPhysicalCalls: 32,
  maxCostUsd: 1,
  unknownCostReserveUsd: 0.02,
  latencyEnvironment: 'concurrent-with-linux-native-soak',
  latencyRankingEligible: false,
})
const sourceFiles = [
  './seedoutlinepilot.ts',
  './intervalpolicy-pilot.ts',
  './seedoutlinepresentation.ts',
  './seedunboundedprompt.ts',
  './protocol.ts',
  './recording.ts',
  './presentationpilot.ts',
  '../../src/app/create-classifier.ts',
  '../../src/processes/whole-object.ts',
  '../../src/processes/boundary-state.ts',
  '../../src/processes/locate.ts',
  '../../src/features/prompts.ts',
  '../../src/features/choice.ts',
  '../../src/features/choice-beam-layout.ts',
  '../../src/features/uniform-grid.ts',
  '../../src/infrastructure/openrouter.ts',
  '../../src/infrastructure/boundary-view.ts',
] as const

export interface SeedOutlinePilotOptions {
  imageRoot: string
  outputRoot: string
  apiKey: string
  rendererSha256: string
  fetch?: typeof globalThis.fetch
  composeClassifier: (
    decision: DecisionPort,
    boundaryView: BoundaryViewPort,
    intervalPolicy: WholeObjectIntervalPolicy,
  ) => Classifier
  intervalPolicy?: WholeObjectIntervalPolicy
  sharedBudget?: RunBudget
  variantId?: string
}

interface Outcome {
  caseId: string
  intervalPolicy?: WholeObjectIntervalPolicy
  variantId?: string
  status: 'located' | 'unknown' | 'not-found' | 'failed' | 'not-run-budget'
  sourceSha256: string | null
  imageDimensions: { width: number; height: number } | null
  requestHashes: string[]
  result?: unknown
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
  if (
    manifest.manifestId !== 'old-exposed-dev4-diagnostic-v1' ||
    caseIds.some((id) => !manifest.cases.some((item) => item.caseId === id))
  )
    throw new TypeError('seed-outline-v1 requires the frozen exposed Car/Boat inputs')
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

function latencySummary(values: readonly number[]) {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1] ?? null
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1)! }
}

function resultSummary(result: WholeObjectLocalizationResult): unknown {
  if (result.status === 'located')
    return {
      region: result.region,
      seedRegion: result.seedRegion,
      bounds: result.bounds,
      completeness: result.completeness,
    }
  return 'reason' in result ? { reason: result.reason } : undefined
}

/** Native-only outline presentation experiment. Evaluator truth never enters this producer. */
export async function runSeedOutlinePilot(options: SeedOutlinePilotOptions) {
  const intervalPolicy = options.intervalPolicy ?? 'fixed-16-v1'
  const variantId = options.variantId ?? 'original-seed-outline-v1'
  const variantPolicy = { ...policy, intervalPolicy, variantId }
  const rendererBytes = await readFile(
    new URL('../../src/infrastructure/boundary-view.ts', import.meta.url),
  )
  if (sha256(rendererBytes) !== options.rendererSha256)
    throw new TypeError('Boundary renderer digest changed since the variant was frozen')
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(
        async (path) => [path, sha256(await readFile(new URL(path, import.meta.url)))] as const,
      ),
    ),
  )
  const variantSha256 = hashCanonical({
    route,
    policy: variantPolicy,
    sourceHashes: Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
  })
  const manifest = await readManifest()
  const inputs = new Map(manifest.cases.map((input) => [input.caseId, input]))
  const runId = `v02-seed-outline-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget =
    options.sharedBudget ??
    new RunBudget(
      policy.maxPhysicalCalls,
      policy.maxCostUsd,
      policy.unknownCostReserveUsd,
    )
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    purpose:
      'native Luna original-image seed-outline presentation; old exposed development Car/Boat diagnostic only',
    startedAt: new Date().toISOString(),
    variantId,
    variantSha256,
    sourceHashes,
    producerSourceSha256: hashCanonical(
      Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sourceManifestSha256: hashCanonical(manifest),
    selectedCaseIds: caseIds,
    route,
    policy: variantPolicy,
    modelBoundary: { evaluatorTruthRead: false, retries: 0, fallback: false },
  })
  const outcomes: Outcome[] = []
  const physicalCalls: PhysicalCallRecord[] = []
  let budgetStopped = false
  for (const caseId of caseIds) {
    const input = inputs.get(caseId)
    if (!input) throw new TypeError('Frozen producer input is absent')
    let source: Awaited<ReturnType<typeof loadSource>> | undefined
    let sourceError: string | undefined
    try {
      source = await loadSource(input, options.imageRoot)
    } catch (error) {
      sourceError = safeErrorCode(error)
    }
    const directory = join(outputDirectory, caseId)
    await mkdir(directory, { recursive: true })
    const started = performance.now()
    let recorder: Recorder | undefined
    let outcome: Outcome
    if (budgetStopped) {
      outcome = {
        caseId,
        status: 'not-run-budget',
        sourceSha256: source?.sourceSha256 ?? null,
        imageDimensions: source ? { width: source.width, height: source.height } : null,
        requestHashes: [],
        errorCode: 'V02_RUN_BUDGET_EXHAUSTED',
        durationMs: 0,
      }
    } else if (!source) {
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
          (fetch) =>
            createOpenRouterDecisions({
              apiKey: options.apiKey,
              model: route.model,
              provider: route.provider,
              providerName: route.providerName,
              fetch,
            }),
          budget,
          join(directory, 'calls'),
          route,
          options.fetch ?? globalThis.fetch,
        )
        const decision = withSeedUnboundedPrompt(withSeedOutlinePresentation(recorder.port))
        const classifier = options.composeClassifier(
          decision,
          createSharpBoundaryView(),
          intervalPolicy,
        )
        let result: WholeObjectLocalizationResult
        try {
          result = await classifier.locate({
            image: source.bytes,
            target: input.target,
            mode: 'whole-object',
            boxTolerancePx: policy.boxTolerancePx,
            maxExtentPasses: policy.maxExtentPasses,
          })
        } finally {
          await classifier.dispose()
        }
        const summary = resultSummary(result)
        outcome = {
          caseId,
          status: result.status,
          sourceSha256: source.sourceSha256,
          imageDimensions: { width: source.width, height: source.height },
          requestHashes: recorder.logicalCalls.map((call) => call.requestSha256),
          ...(summary === undefined ? {} : { result: summary }),
          durationMs: performance.now() - started,
        }
      } catch (error) {
        const errorCode = safeErrorCode(error)
        outcome = {
          caseId,
          status: 'failed',
          sourceSha256: source.sourceSha256,
          imageDimensions: { width: source.width, height: source.height },
          requestHashes: recorder?.logicalCalls.map((call) => call.requestSha256) ?? [],
          errorCode,
          durationMs: performance.now() - started,
        }
        if (errorCode === 'V02_RUN_BUDGET_EXHAUSTED') budgetStopped = true
      }
      if (recorder) physicalCalls.push(...recorder.calls)
    }
    outcome.intervalPolicy = intervalPolicy
    outcome.variantId = variantId
    outcomes.push(outcome)
    await writeImmutable(join(directory, 'outcome.json'), outcome)
  }
  const summary = {
    runId,
    variantId,
    variantSha256,
    status: outcomes.every((item) => !['failed', 'not-run-budget'].includes(item.status))
      ? 'complete'
      : 'incomplete',
    outcomes,
    aggregate: budget.snapshot(),
    latency: latencySummary(physicalCalls.map((call) => call.durationMs)),
    latencyEnvironment: policy.latencyEnvironment,
    latencyRankingEligible: policy.latencyRankingEligible,
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
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
  })
  return { ...summary, outputDirectory }
}
