import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Classifier } from '../../src/app/create-classifier.js'
import { createClassifier } from '../../src/app/create-classifier.js'
import { createResearchClassifier } from '../experiments/create-research-classifier.js'
import type { DecisionPort } from '../../src/entities/contracts.js'
import type { WholeObjectLocalizationResult } from '../../src/entities/whole-object.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { createSharpBoundaryView } from '../experiments/boundary-view.js'
import { RunBudget } from './budget.js'
import { freshProducerTask, loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { hashCanonical } from './protocol.js'
import { recordProvider } from './recording.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { withSeedOutlinePresentation } from './seedoutlinepresentation.js'
import { withSeedUnboundedPrompt } from './seedunboundedprompt.js'

import { readOpenRouterKeyFromProcessEnv } from '../credentials.js'
const route = Object.freeze({
  id: 'openai-gpt-6-luna-native-decisions-v1',
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
})
export const freshProfilePolicy = Object.freeze({
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
  latencyEnvironment: 'concurrent-development-unranked',
  latencyRankingEligible: false,
})

export const freshProfileVariants = Object.freeze([
  Object.freeze({ id: 'native-numeric-v1', presentation: 'numeric-v1' }),
  Object.freeze({
    id: 'native-seed-outline-axis-fixed16-v1',
    presentation: 'seed-outline-axis-fixed16-v1',
  }),
])

const sourceFiles = [
  './fresh-runner.ts',
  './run-fresh-dev.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  '../credentials.ts',
  './seedoutlinepresentation.ts',
  './seedunboundedprompt.ts',
  '../experiments/boundary-view.ts',
  '../experiments/create-research-classifier.ts',
] as const

type FreshProfileId = (typeof freshProfileVariants)[number]['id']
type FreshStageStatus = 'ok' | 'located' | 'unknown' | 'not-found' | 'failed'

interface FreshStage {
  status: FreshStageStatus
  durationMs: number
  calls: number
  requestHashes: string[]
  value?: 'present' | 'absent'
  region?: { left: number; top: number; width: number; height: number }
  reason?: string
  errorCode?: string
}

interface FreshResultRow {
  caseId: string
  imageSha256: string
  profileId: FreshProfileId
  classify: FreshStage
  locate: FreshStage
}

interface FreshRunnerOptions {
  manifests: Array<{ path: string; sha256: string }>
  imageRoot: string
  outputRoot: string
  apiKey: string
  fetch?: typeof globalThis.fetch
  /** Offline seam used by fixture tests. Production always uses the pinned native adapter. */
  createDecision?: (fetcher: typeof globalThis.fetch) => DecisionPort
}

interface FreshPreflight {
  corpus: Awaited<ReturnType<typeof loadFreshCorpus>>
  imageChecks: Map<string, { ok: true } | { ok: false; errorCode: string }>
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function allSourceHashes(): Promise<Record<string, string>> {
  const hashes = await Promise.all(
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
  const sourcePaths = (await walk(srcRoot)).sort()
  const sourceHashes = await Promise.all(
    sourcePaths.map(
      async (path) =>
        [
          `src/${relative(srcRoot, path).split(sep).join('/')}`,
          sha256(await readFile(path)),
        ] as const,
    ),
  )
  return Object.fromEntries([...hashes, ...sourceHashes])
}

async function writeImmutable(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
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

function summarizeWholeObject(
  result: WholeObjectLocalizationResult,
): Pick<FreshStage, 'status' | 'region' | 'reason'> {
  if (result.status === 'located') return { status: 'located', region: result.region }
  if (result.status === 'not-found') return { status: 'not-found', reason: result.reason }
  return { status: 'unknown', reason: result.reason }
}

function requestHashes(recorder: Recorder, start: number): string[] {
  return recorder.logicalCalls.slice(start).map((call) => call.requestSha256)
}

function assertTaskSeparated(
  item: FreshCase,
  task: ReturnType<typeof freshProducerTask>,
  imageRoot?: string,
): void {
  const text = JSON.stringify(task)
  if (
    text.includes(item.caseId) ||
    text.includes(item.image.path) ||
    text.includes(item.image.sha256) ||
    (imageRoot !== undefined && text.includes(imageRoot))
  )
    throw Object.assign(
      new Error('Producer task contains controller-only identity or source metadata'),
      { code: 'INVALID_INPUT' },
    )
}

function makeDecision(options: FreshRunnerOptions, fetcher: typeof globalThis.fetch): DecisionPort {
  if (options.createDecision) return options.createDecision(fetcher)
  return createOpenRouterDecisions({
    apiKey: options.apiKey,
    model: route.model,
    provider: route.provider,
    providerName: route.providerName,
    fetch: fetcher,
  })
}

/** Fully validate pinned DEV images before paid runs; never reads evaluator truth. */
export async function preflightFreshCorpus(
  options: Pick<FreshRunnerOptions, 'manifests' | 'imageRoot'>,
  signal: AbortSignal = new AbortController().signal,
): Promise<FreshPreflight> {
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    signal,
  )
  const imageChecks = new Map<string, { ok: true } | { ok: false; errorCode: string }>()
  for (const item of corpus.cases) {
    try {
      const task = freshProducerTask(item)
      assertTaskSeparated(item, task, corpus.imageRoot)
      const bytes = await loadFreshImage(item, corpus.imageRoot, signal)
      bytes.fill(0)
      imageChecks.set(item.caseId, { ok: true })
    } catch (error) {
      imageChecks.set(item.caseId, { ok: false, errorCode: safeErrorCode(error) })
    }
  }
  return { corpus, imageChecks }
}

function composeClassifier(decision: DecisionPort, profileId: FreshProfileId): Classifier {
  const options = {
    decision,
    timeoutMs: freshProfilePolicy.timeoutMs,
    concurrency: freshProfilePolicy.concurrency,
    maxQueue: freshProfilePolicy.maxQueue,
  }
  if (profileId === 'native-numeric-v1') return createClassifier(options)
  const decorated = withSeedUnboundedPrompt(withSeedOutlinePresentation(decision))
  return createResearchClassifier(
    { ...options, decision: decorated },
    undefined,
    createSharpBoundaryView(),
    'fixed-16-v1',
  )
}

function summarizePhysical(call: PhysicalCallRecord) {
  return {
    physicalId: call.physicalId,
    requestSha256: call.requestSha256,
    requestBodySha256: call.requestBodySha256,
    route: call.route,
    receipt: call.receipt,
    wireReceipt: call.wireReceipt,
    errorCode: call.errorCode ?? null,
    durationMs: call.durationMs,
  }
}

/** Runs one complete DEV profile. The model receives only task fields and image bytes. */
export async function runFreshCorpusProfile(
  options: FreshRunnerOptions,
  profileId: FreshProfileId,
  signal: AbortSignal = new AbortController().signal,
) {
  const { corpus, imageChecks: preflight } = await preflightFreshCorpus(options, signal)
  const sourceHashes = await allSourceHashes()
  const profiles = freshProfileVariants.find((item) => item.id === profileId)
  if (!profiles) throw new TypeError('Fresh profile is not in the frozen profile registry')

  const caseManifest = corpus.cases.map((item) => ({
    caseId: item.caseId,
    imageSha256: item.image.sha256,
    imageDimensions: { width: item.image.width, height: item.image.height },
  }))
  const variantSha256 = hashCanonical({
    route,
    profile: profiles,
    policy: freshProfilePolicy,
    manifestHashes: corpus.manifests,
    cases: caseManifest,
    sourceHashes: Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
  })
  const runId = `v02-fresh-${profileId}-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(
    freshProfilePolicy.maxPhysicalCalls,
    freshProfilePolicy.maxCostUsd,
    freshProfilePolicy.unknownCostReserveUsd,
  )
  await writeImmutable(join(outputDirectory, 'run-manifest.json'), {
    schemaVersion: 1,
    runId,
    purpose: 'full pinned DEV photo and independent UI producer pass',
    startedAt: new Date().toISOString(),
    profileId,
    variantSha256,
    sourceHashes,
    producerSourceSha256: hashCanonical(
      Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    manifests: corpus.manifests,
    plannedCaseIds: caseManifest.map((item) => item.caseId),
    plannedCases: caseManifest,
    route,
    policy: freshProfilePolicy,
    modelBoundary: { evaluatorTruthRead: false, retries: 0, fallback: false },
  })

  const results: FreshResultRow[] = []
  const physicalCalls: PhysicalCallRecord[] = []
  for (const item of corpus.cases) {
    const caseDirectory = join(outputDirectory, item.caseId)
    await mkdir(caseDirectory, { recursive: false })
    const checked = preflight.get(item.caseId)
    if (!checked?.ok) {
      const errorCode = checked?.errorCode ?? 'INVALID_INPUT'
      const row: FreshResultRow = {
        caseId: item.caseId,
        imageSha256: item.image.sha256,
        profileId,
        classify: { status: 'failed', durationMs: 0, calls: 0, requestHashes: [], errorCode },
        locate: { status: 'failed', durationMs: 0, calls: 0, requestHashes: [], errorCode },
      }
      results.push(row)
      await writeImmutable(join(caseDirectory, 'result.json'), row)
      continue
    }

    const task = freshProducerTask(item)
    let bytes: Uint8Array
    try {
      bytes = await loadFreshImage(item, corpus.imageRoot, signal)
    } catch (error) {
      const errorCode = safeErrorCode(error)
      const row: FreshResultRow = {
        caseId: item.caseId,
        imageSha256: item.image.sha256,
        profileId,
        classify: { status: 'failed', durationMs: 0, calls: 0, requestHashes: [], errorCode },
        locate: { status: 'failed', durationMs: 0, calls: 0, requestHashes: [], errorCode },
      }
      results.push(row)
      await writeImmutable(join(caseDirectory, 'result.json'), row)
      continue
    }
    let recorder: Recorder | undefined
    let classifier: Classifier | undefined
    const controller = new AbortController()
    const parentAbort = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', parentAbort, { once: true })
    try {
      recorder = recordProvider(
        (fetcher) => makeDecision(options, fetcher),
        budget,
        join(caseDirectory, 'calls'),
        route,
        options.fetch ?? globalThis.fetch,
      )
      classifier = composeClassifier(recorder.port, profileId)
      const classStart = performance.now()
      const classPhysicalStart = recorder.calls.length
      const classLogicalStart = recorder.logicalCalls.length
      let classify: FreshStage
      try {
        const result = await classifier.classify({
          input: { image: bytes },
          classes: [
            { id: 'present', description: 'The target in the question is visible in this image.' },
            {
              id: 'absent',
              description: 'The target in the question is not visible in this image.',
            },
          ],
          instructions: task.question,
          signal: controller.signal,
        })
        if (result.choice !== 'present' && result.choice !== 'absent')
          throw Object.assign(new Error('Classifier returned a label outside the pinned classes'), {
            code: 'INVALID_RESPONSE',
          })
        classify = {
          status: 'ok',
          value: result.choice,
          durationMs: performance.now() - classStart,
          calls: recorder.calls.length - classPhysicalStart,
          requestHashes: requestHashes(recorder, classLogicalStart),
        }
      } catch (error) {
        classify = {
          status: 'failed',
          durationMs: performance.now() - classStart,
          calls: recorder.calls.length - classPhysicalStart,
          requestHashes: requestHashes(recorder, classLogicalStart),
          errorCode: safeErrorCode(error),
        }
      }

      const locateStart = performance.now()
      const locatePhysicalStart = recorder.calls.length
      const locateLogicalStart = recorder.logicalCalls.length
      let locate: FreshStage
      try {
        const locateTarget = task.instruction ? `${task.target}\n${task.instruction}` : task.target
        const result = await classifier.locate({
          image: bytes,
          target: locateTarget,
          mode: 'whole-object',
          boxTolerancePx: freshProfilePolicy.boxTolerancePx,
          maxExtentPasses: freshProfilePolicy.maxExtentPasses,
          signal: controller.signal,
        })
        const stage = summarizeWholeObject(result)
        locate = {
          ...stage,
          durationMs: performance.now() - locateStart,
          calls: recorder.calls.length - locatePhysicalStart,
          requestHashes: requestHashes(recorder, locateLogicalStart),
        }
      } catch (error) {
        locate = {
          status: 'failed',
          durationMs: performance.now() - locateStart,
          calls: recorder.calls.length - locatePhysicalStart,
          requestHashes: requestHashes(recorder, locateLogicalStart),
          errorCode: safeErrorCode(error),
        }
      }
      const row: FreshResultRow = {
        caseId: item.caseId,
        imageSha256: item.image.sha256,
        profileId,
        classify,
        locate,
      }
      results.push(row)
      await writeImmutable(join(caseDirectory, 'result.json'), row)
    } finally {
      controller.abort()
      signal.removeEventListener('abort', parentAbort)
      bytes.fill(0)
      if (classifier) await classifier.dispose()
      if (recorder) physicalCalls.push(...recorder.calls)
    }
  }

  const plannedCaseIds = caseManifest.map((item) => item.caseId)
  const completedCaseIds = results.map((item) => item.caseId)
  const completed = new Set(completedCaseIds)
  const missingCaseIds = plannedCaseIds.filter((id) => !completed.has(id))
  const summary = {
    runId,
    profileId,
    variantSha256,
    status: missingCaseIds.length === 0 ? 'complete' : 'incomplete',
    plannedCaseIds,
    completedCaseIds,
    missingCaseIds,
    results,
    aggregate: budget.snapshot(),
    latencyEnvironment: freshProfilePolicy.latencyEnvironment,
    latencyRankingEligible: false,
    physicalReceipts: physicalCalls.map(summarizePhysical),
  }
  await writeImmutable(join(outputDirectory, 'summary.json'), summary)
  await writeImmutable(join(outputDirectory, 'run-complete.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
  })
  return { ...summary, outputDirectory }
}

export async function readFreshOpenRouterKey(): Promise<string> {
  return readOpenRouterKeyFromProcessEnv()
}
