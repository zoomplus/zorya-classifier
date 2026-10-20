import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Classifier, ClassifierOptions } from '../../src/app/create-classifier.js'
import { createClassifier } from '../../src/app/create-classifier.js'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../../src/entities/contracts.js'
import type { ExtractionResult, SegmentationPort } from '../../src/entities/segmentation.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { createMobileSamSegmenter } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import { RunBudget } from './budget.js'
import type { BudgetSnapshot } from './budget.js'
import { freshProducerTask, loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import type { FreshCase } from './fresh-corpus.js'
import { createNativeCategoricalPresencePort } from './native-categorical-presence-port.js'
import { hashCanonical } from './protocol.js'
import { recordProvider } from './recording.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'

export const regionSeededProfile = Object.freeze({
  id: 'native-luna-region-seeded-sam-dev-v1',
  phase: 'dev',
  targetPolicy: 'target-plus-neutral-instruction-v1',
  purpose: 'full original exposed DEV photo, independent UI and independent map pass',
})

export const regionSeededNoImageProfile = Object.freeze({
  id: 'native-luna-region-no-image-control-dev-v1',
  phase: 'dev',
  purpose:
    'paired original exposed DEV region-search and classification control without image parts',
})
export const regionPresenceFirstProfile = Object.freeze({
  id: 'native-luna-presence-first-region-seeded-sam-dev-v2',
  phase: 'dev',
  targetPolicy: 'target-plus-neutral-instruction-v1',
  purpose:
    'full original exposed DEV pass with existing closed classification gating region search',
})
export const regionPresenceFirstNoImageProfile = Object.freeze({
  id: 'native-luna-presence-first-region-no-image-control-dev-v2',
  phase: 'dev',
  purpose: 'paired original exposed DEV no-image control with the same classification gate',
})
export const regionSeededHeldoutProfile = Object.freeze({
  id: 'native-luna-region-seeded-sam-heldout-v1',
  phase: 'heldout',
})
export const regionSeededNoImageHeldoutProfile = Object.freeze({
  id: 'native-luna-region-no-image-control-heldout-v1',
  phase: 'heldout',
})

export const regionSeededRecipe = Object.freeze({
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
  native: 'MobileSAM CPU segmentation, seed-region prompt on full oriented source image',
  timeoutMs: 120_000,
  maxInFlightCases: 2,
  nativeMaxActive: 1,
  nativeMaxWaiting: 2,
  nativeThreads: 2,
  regionSearchPasses: 3,
  extentCalls: 0,
  sameInstanceCalls: 0,
  maxLogicalCallsPerCase: 4,
  maxPhysicalCallsPerCase: 4,
  maxPhysicalCalls: 250,
  maxCostUsd: 5,
  unknownCostReserveUsd: 0.05,
  retries: 0,
  fallback: false,
  latencyRankingEligible: false,
})

export const regionSeededDevManifests = Object.freeze([
  {
    path: '/root/work/zorya-classifier/benchmarks/v02/corpus/dev/inputs.json',
    sha256: '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
  },
  {
    path: '/root/work/zorya-classifier/benchmarks/v02/corpus/dev-independent-ui/inputs.json',
    sha256: '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
  },
  {
    path: '/root/work/zorya-classifier/benchmarks/v02/corpus/dev-independent-map/inputs.json',
    sha256: 'b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15',
  },
] as const)

const heldoutAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().min(1).max(128),
    phase: z.literal('heldout'),
    variant: z.enum(['region-seeded-sam', 'no-image-control']),
    producerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    manifests: z
      .array(
        z
          .object({
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            cases: z.number().int().positive(),
          })
          .strict(),
      )
      .length(3),
    maxPhysicalCalls: z.number().int().positive().max(600),
    maxCostUsd: z.number().positive().max(10),
    unknownCostReserveUsd: z.literal(0.05),
  })
  .strict()

export const regionSeededAssets = Object.freeze({
  method: 'mobile-sam-seed-region-v1',
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

const route = Object.freeze({
  model: regionSeededRecipe.model,
  provider: regionSeededRecipe.provider,
  providerName: regionSeededRecipe.providerName,
  apiEndpoint: regionSeededRecipe.apiEndpoint,
  allowFallbacks: false as const,
})

export interface RegionSeededRunnerOptions {
  manifests: Array<{ path: string; sha256: string }>
  imageRoot: string
  outputRoot: string
  apiKey: string
  encoderPath: string
  decoderPath: string
  profileId: string
  variant: 'region-seeded-sam' | 'no-image-control'
  requireClassifiedPresence?: boolean
  phase: 'dev' | 'heldout'
  expectedCaseCount: number
  maxPhysicalCalls: number
  maxCostUsd: number
  unknownCostReserveUsd: number
  authorization?: unknown
  fetch?: typeof globalThis.fetch
  createSegmentation?: (paths: {
    encoderPath: string
    decoderPath: string
  }) => Promise<SegmentationPort>
  createClassifier?: (options: ClassifierOptions) => Classifier
}

export interface SeedRecord {
  status: 'located' | 'unknown' | 'not-found' | 'failed' | 'not-reached'
  region?: { left: number; top: number; width: number; height: number }
  sourceWidth?: number
  sourceHeight?: number
  prompt?: 'seed-region'
  searchLimit?: { left: number; top: number; width: number; height: number }
  durationMs: number
  physicalCalls: number
  logicalCalls: number
  requestHashes: string[]
  errorCode?: string
}

export interface RegionExtractionRecord {
  status: 'extracted' | 'region-only' | 'unknown' | 'not-found' | 'failed'
  reason?: string
  errorCode?: string
  durationMs: number
  physicalCalls: number
  logicalCalls: number
  requestHashes: string[]
  seed: SeedRecord
  mask?: {
    file: 'mask.u8'
    sha256: string
    width: number
    height: number
    sourceRegion: { left: number; top: number; width: number; height: number }
    sourceOffset: { x: number; y: number }
    pngFile: 'cutout.png'
    pngSha256: string
    center: { x: number; y: number }
    segmentation: {
      method: string
      backend: string
      durationMs: number
      input: { width: number; height: number }
      qualityScore?: number
    }
  }
  segmentation?: {
    method: string
    backend: string
    durationMs: number
    input: { width: number; height: number }
    qualityScore?: number
  }
}

export interface RegionSeededCaseResult {
  caseId: string
  imageSha256: string
  classify: {
    status: 'ok' | 'failed'
    value?: 'present' | 'absent'
    durationMs: number
    physicalCalls: number
    logicalCalls: number
    requestHashes: string[]
    errorCode?: string
  }
  extraction: RegionExtractionRecord
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function immutable(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
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
    'PERSISTENCE_FAILURE',
  ])
  return typeof code === 'string' && allowed.has(code) ? code : 'RUNNER_FAILURE'
}

export function assertRecorderHealthy(recorder: Recorder): void {
  if (recorder.persistenceFailures?.length) {
    throw Object.assign(new Error('Required benchmark receipt persistence failed'), {
      code: 'PERSISTENCE_FAILURE',
    })
  }
}

function safeReason(value: unknown): string | undefined {
  const allowed = new Set([
    'absent-in-evaluated-region',
    'uncertain-presence',
    'candidate-union-empty',
    'contradictory-evidence',
    'layout-limit',
    'segmentation-uncertain',
    'classification-absent',
    'classification-failed',
  ])
  return typeof value === 'string' && allowed.has(value) ? value : undefined
}

export async function regionSeededProducerSourceManifest(): Promise<Record<string, string>> {
  const benchmark = [
    './region-seeded-runner.ts',
    './run-region-seeded-dev.ts',
    './fresh-corpus.ts',
    './recording.ts',
    './budget.ts',
    './protocol.ts',
    './native-categorical-presence-port.ts',
    './categorical-presence-port.ts',
    './region-seeded-runner.md',
    '../../package.json',
    '../../package-lock.json',
  ]
  const entries: Array<[string, string]> = await Promise.all(
    benchmark.map(async (path) => [path, sha256(await readFile(new URL(path, import.meta.url)))]),
  )
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url))
  async function walk(directory: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
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
  const source = await Promise.all(
    (await walk(srcRoot))
      .sort()
      .map(
        async (path) =>
          [`src/${relative(srcRoot, path).split(sep).join('/')}`, sha256(await readFile(path))] as [
            string,
            string,
          ],
      ),
  )
  return Object.fromEntries([...entries, ...source])
}

function taskFor(item: FreshCase) {
  const task = freshProducerTask(item)
  const sourceIdentity = `${item.caseId}${item.image.path}${item.image.sha256}`
  if (
    JSON.stringify(task).includes(sourceIdentity) ||
    JSON.stringify(task).includes(item.caseId) ||
    JSON.stringify(task).includes(item.image.path) ||
    JSON.stringify(task).includes(item.image.sha256)
  )
    throw Object.assign(new Error('Producer task contains controller identity'), {
      code: 'INVALID_INPUT',
    })
  if (
    item.locate.instruction !== undefined &&
    item.locate.instruction !==
      'Locate the visible physical instance of the named object; return unknown when unsupported.'
  )
    throw Object.assign(new Error('Unapproved producer instruction'), { code: 'INVALID_INPUT' })
  return task
}

function classifyRecord(
  recorder: Recorder,
  physicalStart: number,
  logicalStart: number,
  durationMs: number,
  value?: 'present' | 'absent',
  errorCode?: string,
) {
  return {
    status: errorCode ? ('failed' as const) : ('ok' as const),
    ...(value ? { value } : {}),
    durationMs,
    physicalCalls: recorder.calls.length - physicalStart,
    logicalCalls: recorder.logicalCalls.length - logicalStart,
    requestHashes: recorder.logicalCalls.slice(logicalStart).map((call) => call.requestSha256),
    ...(errorCode ? { errorCode } : {}),
  }
}

export function removeImagesAtDecisionBoundary(port: DecisionPort): DecisionPort {
  return {
    async decide(request: DecisionRequest, signal): Promise<DecisionResult> {
      const state = request.state.filter((part): part is string => typeof part === 'string')
      return port.decide({ state, questions: structuredClone(request.questions) }, signal)
    },
  }
}

export interface NoImageFetchAudit {
  checkedFetches: number
  imagePartFetches: number
}

export function assertNoImagePartsAtFetch(
  fetcher: typeof globalThis.fetch,
  audit: NoImageFetchAudit = { checkedFetches: 0, imagePartFetches: 0 },
): typeof globalThis.fetch {
  const containsImage = (value: unknown): boolean => {
    if (typeof value === 'string') return /data:image\//iu.test(value) || /;base64,/iu.test(value)
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(containsImage)
    const row = value as Record<string, unknown>
    return (
      row.type === 'image_url' ||
      Object.hasOwn(row, 'image_url') ||
      Object.values(row).some(containsImage)
    )
  }
  return async (input, init) => {
    audit.checkedFetches++
    if (typeof init?.body !== 'string')
      throw Object.assign(new Error('No-image profile requires JSON transport'), {
        code: 'INVALID_INPUT',
      })
    let parsed: unknown
    try {
      parsed = JSON.parse(init.body)
    } catch {
      throw Object.assign(new Error('No-image profile request is not JSON'), {
        code: 'INVALID_INPUT',
      })
    }
    if (containsImage(parsed)) {
      audit.imagePartFetches++
      throw Object.assign(new Error('Image part reached no-image fetch boundary'), {
        code: 'INVALID_INPUT',
      })
    }
    return fetcher(input, init)
  }
}

function seedRecord(
  status: SeedRecord['status'],
  seed:
    | {
        region: { left: number; top: number; width: number; height: number }
        sourceWidth: number
        sourceHeight: number
        at: number
      }
    | undefined,
  recorder: Recorder,
  physicalStart: number,
  logicalStart: number,
  started: number,
  errorCode?: string,
): SeedRecord {
  return {
    status,
    ...(seed
      ? {
          region: { ...seed.region },
          sourceWidth: seed.sourceWidth,
          sourceHeight: seed.sourceHeight,
        }
      : {}),
    durationMs: Math.max(0, (seed?.at ?? performance.now()) - started),
    physicalCalls: recorder.calls.length - physicalStart,
    logicalCalls: recorder.logicalCalls.length - logicalStart,
    requestHashes: recorder.logicalCalls.slice(logicalStart).map((call) => call.requestSha256),
    ...(errorCode ? { errorCode } : {}),
  }
}

function persistExtracted(
  caseDirectory: string,
  result: Extracted,
  imageSize: { width: number; height: number },
): Promise<NonNullable<RegionExtractionRecord['mask']>> {
  const { mask, region, offset, png, center, segmentation } = result
  if (
    mask.format !== 'binary-u8' ||
    mask.width !== region.width ||
    mask.height !== region.height ||
    mask.data.length !== mask.width * mask.height ||
    mask.data.some((value) => value !== 0 && value !== 1) ||
    offset.x !== region.left ||
    offset.y !== region.top ||
    region.left + region.width > imageSize.width ||
    region.top + region.height > imageSize.height ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => png[index] === byte) ||
    segmentation.backend !== 'mobile-sam' ||
    !Number.isFinite(segmentation.durationMs) ||
    segmentation.input.width !== imageSize.width ||
    segmentation.input.height !== imageSize.height
  )
    throw Object.assign(
      new Error('Region extraction artifacts failed source geometry validation'),
      { code: 'INVALID_RESPONSE' },
    )
  const maskBytes = new Uint8Array(mask.data)
  const pngBytes = new Uint8Array(png)
  return (async () => {
    try {
      const maskHash = sha256(maskBytes)
      const pngHash = sha256(pngBytes)
      await writeFile(join(caseDirectory, 'mask.u8'), maskBytes, { flag: 'wx' })
      await writeFile(join(caseDirectory, 'cutout.png'), pngBytes, { flag: 'wx' })
      return {
        file: 'mask.u8' as const,
        sha256: maskHash,
        width: mask.width,
        height: mask.height,
        sourceRegion: { ...region },
        sourceOffset: { x: offset.x, y: offset.y },
        pngFile: 'cutout.png' as const,
        pngSha256: pngHash,
        center: { ...center },
        segmentation: {
          method: segmentation.method,
          backend: segmentation.backend,
          durationMs: segmentation.durationMs,
          input: { width: segmentation.input.width, height: segmentation.input.height },
          ...(segmentation.qualityScore !== undefined
            ? { qualityScore: segmentation.qualityScore }
            : {}),
        },
      }
    } finally {
      maskBytes.fill(0)
      pngBytes.fill(0)
      mask.data.fill(0)
      png.fill(0)
    }
  })()
}

type Extracted = Extract<ExtractionResult, { status: 'extracted' }>

export async function processRegionSeededCase(args: {
  item: FreshCase
  root: string
  caseDirectory: string
  classifierFactory: NonNullable<RegionSeededRunnerOptions['createClassifier']>
  decision: DecisionPort
  segmentation?: SegmentationPort
  variant: RegionSeededRunnerOptions['variant']
  requireClassifiedPresence?: boolean
  recorder: Recorder
  signal: AbortSignal
}): Promise<RegionSeededCaseResult> {
  const {
    item,
    root,
    caseDirectory,
    classifierFactory,
    decision,
    segmentation,
    variant,
    requireClassifiedPresence = false,
    recorder,
    signal,
  } = args
  await mkdir(caseDirectory, { recursive: false })
  const task = taskFor(item)
  const localController = new AbortController()
  const onAbort = () => localController.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(
    () => localController.abort(new Error('case deadline')),
    regionSeededRecipe.timeoutMs,
  )
  let image: Uint8Array
  try {
    image = await loadFreshImage(item, root, localController.signal)
  } catch (error) {
    clearTimeout(deadline)
    signal.removeEventListener('abort', onAbort)
    throw error
  }
  const seedCapture: {
    region: { left: number; top: number; width: number; height: number }
    sourceWidth: number
    sourceHeight: number
    at: number
  }[] = []
  const observedSegmentation: SegmentationPort | undefined = segmentation
    ? {
        async segment(input) {
          if (variant === 'region-seeded-sam') {
            seedCapture.push({
              region: { ...input.seedRegion },
              sourceWidth: input.image.width,
              sourceHeight: input.image.height,
              at: performance.now(),
            })
            if (
              input.prompt !== 'seed-region' ||
              input.image.width !== item.image.width ||
              input.image.height !== item.image.height ||
              seedCapture.length !== 1
            )
              throw Object.assign(
                new Error('Segmenter input violates the frozen seed/full-frame contract'),
                { code: 'INVALID_RESPONSE' },
              )
          }
          return segmentation.segment(input)
        },
        settle: () => segmentation.settle(),
        async dispose() {},
      }
    : undefined
  let classifier: Classifier | undefined
  const started = performance.now()
  const classPhysical = recorder.calls.length
  const classLogical = recorder.logicalCalls.length
  let classify: RegionSeededCaseResult['classify']
  let extraction: RegionExtractionRecord
  let ownedPng: Uint8Array | undefined
  let ownedMask: Uint8Array | undefined
  try {
    classifier = classifierFactory({
      decision,
      ...(observedSegmentation ? { segmentation: observedSegmentation } : {}),
      timeoutMs: regionSeededRecipe.timeoutMs,
      concurrency: 1,
      maxQueue: 0,
    })
    try {
      const result = await classifier.classify({
        input: { image },
        classes: [
          { id: 'present', description: 'The target in the question is visible in this image.' },
          { id: 'absent', description: 'The target in the question is not visible in this image.' },
        ],
        instructions: `${task.question}\n\nUse only the supplied image. Choose exactly one closed label.`,
        signal: localController.signal,
      })
      if (result.choice !== 'present' && result.choice !== 'absent')
        throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' })
      classify = classifyRecord(
        recorder,
        classPhysical,
        classLogical,
        performance.now() - started,
        result.choice,
      )
    } catch (error) {
      classify = classifyRecord(
        recorder,
        classPhysical,
        classLogical,
        performance.now() - started,
        undefined,
        safeErrorCode(error),
      )
    }
    // A provider/JSON failure is an ordinary failed case. Losing the recorder's own
    // request/receipt evidence is a run-level stop condition, before another stage.
    assertRecorderHealthy(recorder)

    if (requireClassifiedPresence && classify.status !== 'ok') {
      extraction = skippedExtraction('classification-failed')
      return { caseId: item.caseId, imageSha256: item.image.sha256, classify, extraction }
    }
    if (requireClassifiedPresence && classify.value !== 'present') {
      extraction = skippedExtraction('classification-absent')
      return { caseId: item.caseId, imageSha256: item.image.sha256, classify, extraction }
    }

    const extractionStarted = performance.now()
    const physicalStart = recorder.calls.length
    const logicalStart = recorder.logicalCalls.length
    try {
      const target = task.instruction ? `${task.target}\n${task.instruction}` : task.target
      const result =
        variant === 'region-seeded-sam'
          ? await classifier.extract({ image, target, signal: localController.signal })
          : await classifier.locate({
              image,
              target,
              mode: 'region',
              signal: localController.signal,
            })
      const captured = seedCapture[0]
      const seedResult = variant === 'no-image-control' ? result : undefined
      const selectedSeed =
        captured ??
        (seedResult?.status === 'located'
          ? {
              region: seedResult.region,
              sourceWidth: item.image.width,
              sourceHeight: item.image.height,
              at: performance.now(),
            }
          : undefined)
      const seed = seedRecord(
        selectedSeed
          ? 'located'
          : result.status === 'not-found'
            ? 'not-found'
            : result.status === 'unknown'
              ? 'unknown'
              : 'not-reached',
        selectedSeed,
        recorder,
        physicalStart,
        logicalStart,
        extractionStarted,
      )
      if (selectedSeed && variant === 'region-seeded-sam') {
        seed.prompt = 'seed-region'
        seed.searchLimit = { left: 0, top: 0, width: item.image.width, height: item.image.height }
      }
      if (variant === 'region-seeded-sam' && result.status === 'extracted') {
        const extracted = result as Extracted
        ownedPng = extracted.png
        ownedMask = extracted.mask.data
        const mask = await persistExtracted(caseDirectory, extracted, {
          width: item.image.width,
          height: item.image.height,
        })
        extraction = {
          status: 'extracted',
          durationMs: performance.now() - extractionStarted,
          physicalCalls: recorder.calls.length - physicalStart,
          logicalCalls: recorder.logicalCalls.length - logicalStart,
          requestHashes: recorder.logicalCalls
            .slice(logicalStart)
            .map((call) => call.requestSha256),
          seed,
          mask,
        }
      } else if (variant === 'no-image-control' && result.status === 'located') {
        extraction = {
          status: 'region-only',
          durationMs: performance.now() - extractionStarted,
          physicalCalls: recorder.calls.length - physicalStart,
          logicalCalls: recorder.logicalCalls.length - logicalStart,
          requestHashes: recorder.logicalCalls
            .slice(logicalStart)
            .map((call) => call.requestSha256),
          seed,
        }
      } else {
        const status =
          result.status === 'not-found'
            ? 'not-found'
            : result.status === 'unknown'
              ? 'unknown'
              : 'failed'
        extraction = {
          status,
          ...(result.status === 'not-found' || result.status === 'unknown'
            ? { reason: safeReason(result.reason) ?? 'unknown-reason' }
            : { errorCode: 'RUNNER_FAILURE' }),
          durationMs: performance.now() - extractionStarted,
          physicalCalls: recorder.calls.length - physicalStart,
          logicalCalls: recorder.logicalCalls.length - logicalStart,
          requestHashes: recorder.logicalCalls
            .slice(logicalStart)
            .map((call) => call.requestSha256),
          seed,
          ...(result.status === 'unknown' && 'segmentation' in result
            ? {
                segmentation: {
                  method: result.segmentation.method,
                  backend: result.segmentation.backend,
                  durationMs: result.segmentation.durationMs,
                  input: {
                    width: result.segmentation.input.width,
                    height: result.segmentation.input.height,
                  },
                  ...(result.segmentation.qualityScore !== undefined
                    ? { qualityScore: result.segmentation.qualityScore }
                    : {}),
                },
              }
            : {}),
        }
      }
    } catch (error) {
      const captured = seedCapture[0]
      extraction = {
        status: 'failed',
        errorCode: safeErrorCode(error),
        durationMs: performance.now() - extractionStarted,
        physicalCalls: recorder.calls.length - physicalStart,
        logicalCalls: recorder.logicalCalls.length - logicalStart,
        requestHashes: recorder.logicalCalls.slice(logicalStart).map((call) => call.requestSha256),
        seed: seedRecord(
          captured ? 'located' : 'failed',
          captured,
          recorder,
          physicalStart,
          logicalStart,
          extractionStarted,
          safeErrorCode(error),
        ),
      }
    }
    assertRecorderHealthy(recorder)
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', onAbort)
    try {
      if (classifier) await classifier.dispose()
    } finally {
      ownedMask?.fill(0)
      ownedPng?.fill(0)
      image.fill(0)
    }
  }
  return { caseId: item.caseId, imageSha256: item.image.sha256, classify, extraction }
}

function skippedExtraction(
  reason: 'classification-absent' | 'classification-failed',
): RegionExtractionRecord {
  return {
    status: reason === 'classification-absent' ? 'not-found' : 'failed',
    reason,
    durationMs: 0,
    physicalCalls: 0,
    logicalCalls: 0,
    requestHashes: [],
    seed: {
      status: 'not-reached',
      durationMs: 0,
      physicalCalls: 0,
      logicalCalls: 0,
      requestHashes: [],
    },
  }
}

export async function runRegionSeededProfile(options: RegionSeededRunnerOptions) {
  const requireClassifiedPresence = options.requireClassifiedPresence === true
  if (requireClassifiedPresence && options.phase !== 'dev')
    throw new TypeError('Presence-first gating is a separate DEV-only recipe')
  const expectedProfile = requireClassifiedPresence
    ? options.variant === 'region-seeded-sam'
      ? regionPresenceFirstProfile.id
      : regionPresenceFirstNoImageProfile.id
    : options.variant === 'region-seeded-sam'
      ? options.phase === 'dev'
        ? regionSeededProfile.id
        : regionSeededHeldoutProfile.id
      : options.phase === 'dev'
        ? regionSeededNoImageProfile.id
        : regionSeededNoImageHeldoutProfile.id
  if (!['dev', 'heldout'].includes(options.phase) || options.profileId !== expectedProfile)
    throw new TypeError('Unknown region-seeded recipe identity')
  if (
    !Number.isInteger(options.expectedCaseCount) ||
    options.expectedCaseCount < 1 ||
    options.expectedCaseCount > 80
  )
    throw new RangeError('Region-seeded profile needs a bounded expected case count')
  const phaseMaxCalls = options.phase === 'heldout' ? 600 : 300
  const phaseMaxCost = options.phase === 'heldout' ? 10 : 5
  if (
    options.maxPhysicalCalls < 1 ||
    options.maxPhysicalCalls > phaseMaxCalls ||
    options.maxCostUsd <= 0 ||
    options.maxCostUsd > phaseMaxCost ||
    options.unknownCostReserveUsd <= 0
  )
    throw new RangeError('Region-seeded run budget exceeds phase limits')
  const authorization =
    options.phase === 'heldout'
      ? heldoutAuthorizationSchema.parse(options.authorization)
      : undefined
  if (
    authorization &&
    (authorization.profileId !== options.profileId ||
      authorization.variant !== options.variant ||
      authorization.maxPhysicalCalls !== options.maxPhysicalCalls ||
      authorization.maxCostUsd !== options.maxCostUsd ||
      authorization.unknownCostReserveUsd !== options.unknownCostReserveUsd)
  )
    throw new TypeError('HELDOUT options do not match the external frozen authorization')
  if (
    options.maxPhysicalCalls !== (options.phase === 'heldout' ? 600 : 250) ||
    options.maxCostUsd !== (options.phase === 'heldout' ? 10 : 5) ||
    options.unknownCostReserveUsd !== 0.05
  )
    throw new TypeError('Run budget must match the frozen region-seeded phase policy')

  const runId = `v02-region-seeded-${options.phase}-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = join(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const before = await regionSeededProducerSourceManifest()
  const sourceBeforeSha256 = hashCanonical(
    Object.entries(before).sort(([a], [b]) => a.localeCompare(b)),
  )
  if (authorization && authorization.producerSourceSha256 !== sourceBeforeSha256)
    throw new TypeError('HELDOUT source closure does not match its external freeze')
  const controller = new AbortController()
  const corpus = await loadFreshCorpus(
    { manifests: options.manifests, imageRoot: options.imageRoot },
    controller.signal,
  )
  if (corpus.cases.length !== options.expectedCaseCount)
    throw new TypeError('Input count does not match declared phase')
  if (options.expectedCaseCount !== (options.phase === 'dev' ? 40 : 80))
    throw new TypeError(
      'Region-seeded recipe requires the full declared DEV or HELDOUT denominator',
    )
  const expectedCounts = options.phase === 'dev' ? [20, 10, 10] : [40, 20, 20]
  const expectedHashes =
    options.phase === 'dev'
      ? regionSeededDevManifests.map((manifest) => manifest.sha256)
      : authorization?.manifests.map((manifest) => manifest.sha256)
  if (
    corpus.manifests.length !== 3 ||
    corpus.manifests.some(
      (manifest, index) =>
        manifest.sha256 !== expectedHashes?.[index] || manifest.cases !== expectedCounts[index],
    ) ||
    (authorization &&
      authorization.manifests.some(
        (manifest, index) =>
          manifest.sha256 !== corpus.manifests[index]?.sha256 ||
          manifest.cases !== corpus.manifests[index]?.cases,
      ))
  )
    throw new TypeError('Input manifest groups do not match the frozen phase profile')
  if (
    authorization &&
    authorization.manifests.reduce((total, manifest) => total + manifest.cases, 0) !==
      options.expectedCaseCount
  )
    throw new TypeError('Frozen HELDOUT case count does not match its manifest groups')
  const imageChecks = []
  for (const item of corpus.cases) {
    try {
      const bytes = await loadFreshImage(item, corpus.imageRoot, controller.signal)
      bytes.fill(0)
      imageChecks.push({ caseId: item.caseId, status: 'verified', errorCode: null })
    } catch {
      imageChecks.push({ caseId: item.caseId, status: 'failed', errorCode: 'INVALID_INPUT' })
    }
  }
  let verifiedAssetManifest: typeof regionSeededAssets | undefined
  if (options.variant === 'region-seeded-sam') {
    const readAsset = async (path: string) => {
      const bytes = await readFile(path)
      const value = { bytes: bytes.byteLength, sha256: sha256(bytes) }
      bytes.fill(0)
      return value
    }
    const [encoder, decoder] = await Promise.all([
      readAsset(options.encoderPath),
      readAsset(options.decoderPath),
    ])
    if (
      encoder.bytes !== regionSeededAssets.encoder.bytes ||
      encoder.sha256 !== regionSeededAssets.encoder.sha256 ||
      decoder.bytes !== regionSeededAssets.decoder.bytes ||
      decoder.sha256 !== regionSeededAssets.decoder.sha256
    )
      throw new TypeError('Pinned MobileSAM assets failed verification')
    verifiedAssetManifest = regionSeededAssets
  }
  const taskHashes = corpus.cases.map((item) => ({
    caseId: item.caseId,
    taskSha256: hashCanonical(taskFor(item)),
  }))
  const promptPolicy = {
    targetPolicy: requireClassifiedPresence
      ? regionPresenceFirstProfile.targetPolicy
      : regionSeededProfile.targetPolicy,
    classificationClasses: [
      { id: 'present', description: 'The target in the question is visible in this image.' },
      { id: 'absent', description: 'The target in the question is not visible in this image.' },
    ],
    classificationInstruction: 'Use only the supplied image. Choose exactly one closed label.',
    extraction:
      'Original three-choice region search once; full-source MobileSAM seed-region extraction once; no extent or whole-object model confirmation.',
    noImageControl:
      'Remove all image parts at DecisionPort boundary; assert no image part at actual fetch; no segmentation, OCR, or hidden CV.',
    ...(requireClassifiedPresence
      ? {
          presenceFirstGate:
            'Reuse the existing closed classification result. Run no region search or segmentation unless classification succeeded with value present; absent and failed classifications are retained with extraction skipped.',
        }
      : {}),
  }
  const variantSha256 = hashCanonical({
    profileId: options.profileId,
    phase: options.phase,
    variant: options.variant,
    ...(requireClassifiedPresence ? { requireClassifiedPresence: true as const } : {}),
    route,
    policy: regionSeededRecipe,
    promptPolicy,
    manifests: corpus.manifests,
    taskHashes,
    source: sourceBeforeSha256,
    nativeAssets: options.variant === 'region-seeded-sam' ? regionSeededAssets : null,
  })
  const manifest = {
    runId,
    profileId: options.profileId,
    phase: options.phase,
    purpose:
      options.phase === 'dev'
        ? requireClassifiedPresence
          ? options.variant === 'region-seeded-sam'
            ? regionPresenceFirstProfile.purpose
            : regionPresenceFirstNoImageProfile.purpose
          : options.variant === 'region-seeded-sam'
            ? regionSeededProfile.purpose
            : regionSeededNoImageProfile.purpose
        : 'frozen heldout photo, independent UI and independent map pass',
    targetPolicy: regionSeededProfile.targetPolicy,
    producerSourceSha256: sourceBeforeSha256,
    producerSourceFiles: before,
    manifests: corpus.manifests,
    plannedCaseIds: corpus.cases.map((item) => item.caseId),
    taskHashes,
    variantSha256,
    promptPolicy,
    imageChecks,
    route,
    variant: options.variant,
    policy: requireClassifiedPresence
      ? { ...regionSeededRecipe, requireClassifiedPresence: true }
      : regionSeededRecipe,
    ...(verifiedAssetManifest
      ? { nativeAssets: verifiedAssetManifest }
      : { native: 'none; image parts are removed before recording and asserted absent at fetch' }),
    budget: {
      maxPhysicalCalls: options.maxPhysicalCalls,
      maxCostUsd: options.maxCostUsd,
      unknownCostReserveUsd: options.unknownCostReserveUsd,
    },
    ...(authorization !== undefined
      ? { authorizationSha256: sha256(JSON.stringify(authorization)) }
      : {}),
    actualPhysicalCallBasis: 'recordProvider fetch admission only',
    noRetries: true,
    noFallback: true,
  }
  await immutable(join(outputDirectory, 'run-manifest.json'), manifest)
  if (imageChecks.some((row) => row.status !== 'verified'))
    throw new TypeError('Image preflight failed; immutable manifest preserved')

  const budget = new RunBudget(
    options.maxPhysicalCalls,
    options.maxCostUsd,
    options.unknownCostReserveUsd,
    options.phase,
  )
  const results: Array<RegionSeededCaseResult | undefined> = new Array(corpus.cases.length)
  const recorders = new Map<string, Recorder>()
  const noImageAudits = new Map<string, NoImageFetchAudit>()
  let segmenter: SegmentationPort | undefined
  let shutdownError: string | undefined
  let next = 0
  let failed: unknown
  try {
    if (options.variant === 'region-seeded-sam')
      segmenter = await (
        options.createSegmentation ??
        ((paths) => createMobileSamSegmenter({ ...paths, executionProvider: 'cpu', threads: 2 }))
      )({ encoderPath: options.encoderPath, decoderPath: options.decoderPath })
    const fetcher = options.fetch ?? globalThis.fetch
    const workers = Array.from({ length: Math.min(2, corpus.cases.length) }, async () => {
      while (!controller.signal.aborted) {
        const index = next++
        if (index >= corpus.cases.length) return
        const item = corpus.cases[index]!
        const caseDir = join(outputDirectory, item.caseId)
        const localBudget = new CaseBudget(budget)
        const audit = { checkedFetches: 0, imagePartFetches: 0 }
        if (options.variant === 'no-image-control') noImageAudits.set(item.caseId, audit)
        const actualFetch =
          options.variant === 'no-image-control'
            ? assertNoImagePartsAtFetch(fetcher, audit)
            : fetcher
        const recorder = recordProvider(
          (trackedFetch) =>
            createOpenRouterDecisions({
              apiKey: options.apiKey,
              model: route.model,
              provider: route.provider,
              providerName: route.providerName,
              fetch: trackedFetch,
            }),
          localBudget,
          join(caseDir, 'calls'),
          route,
          actualFetch,
        )
        recorders.set(item.caseId, recorder)
        try {
          const nativeDecision = createNativeCategoricalPresencePort(recorder.port)
          const apiDecision =
            options.variant === 'no-image-control'
              ? removeImagesAtDecisionBoundary(nativeDecision)
              : nativeDecision
          const factory =
            options.createClassifier ?? ((classifierOptions) => createClassifier(classifierOptions))
          results[index] = await processRegionSeededCase({
            item,
            root: corpus.imageRoot,
            caseDirectory: caseDir,
            classifierFactory: factory,
            decision: apiDecision,
            ...(segmenter ? { segmentation: segmenter } : {}),
            variant: options.variant,
            ...(requireClassifiedPresence ? { requireClassifiedPresence: true } : {}),
            recorder,
            signal: controller.signal,
          })
          assertRecorderHealthy(recorder)
          const row = results[index]!
          if (
            row.classify.logicalCalls > 1 ||
            row.extraction.logicalCalls > 3 ||
            row.classify.physicalCalls > 1 ||
            row.extraction.physicalCalls > 3 ||
            row.classify.logicalCalls + row.extraction.logicalCalls > 4 ||
            row.classify.physicalCalls + row.extraction.physicalCalls > 4
          )
            throw Object.assign(
              new Error('Case exceeded its frozen classification/region-search call bound'),
              { code: 'INVALID_RESPONSE' },
            )
          await immutable(join(caseDir, 'result.json'), results[index])
        } catch (error) {
          failed ??= error
          controller.abort(error)
          throw error
        }
      }
    })
    const settled = await Promise.allSettled(workers)
    if (settled.some((item) => item.status === 'rejected') && failed === undefined)
      failed = settled.find(
        (item): item is PromiseRejectedResult => item.status === 'rejected',
      )?.reason
  } catch (error) {
    failed ??= error
    controller.abort(error)
  } finally {
    if (segmenter) {
      try {
        await segmenter.settle()
      } catch (error) {
        shutdownError = safeErrorCode(error)
      }
      try {
        await segmenter.dispose()
      } catch (error) {
        shutdownError ??= safeErrorCode(error)
      }
    }
  }
  const after = await regionSeededProducerSourceManifest()
  const sourceAfterSha256 = hashCanonical(
    Object.entries(after).sort(([a], [b]) => a.localeCompare(b)),
  )
  const completedCaseIds = results.flatMap((result) => (result ? [result.caseId] : []))
  const completed = new Set(completedCaseIds)
  const missingCaseIds = corpus.cases
    .filter((item) => !completed.has(item.caseId))
    .map((item) => item.caseId)
  const aggregate = budget.snapshot() satisfies BudgetSnapshot
  const recorderPersistenceFailures = corpus.cases.flatMap((item) =>
    (recorders.get(item.caseId)?.persistenceFailures ?? []).map((failure) => ({
      caseId: item.caseId,
      ...failure,
    })),
  )
  const caseWorkersSettled = true // Both workers are joined with Promise.allSettled above.
  const nativeCleanupComplete = !segmenter || shutdownError === undefined
  const classifierCleanupComplete = failed === undefined
  const summary = {
    runId,
    profileId: options.profileId,
    phase: options.phase,
    ...(requireClassifiedPresence ? { requireClassifiedPresence: true as const } : {}),
    ...(requireClassifiedPresence ? { requireClassifiedPresence: true } : {}),
    status:
      failed ||
      missingCaseIds.length ||
      shutdownError ||
      aggregate.inFlightCalls ||
      recorderPersistenceFailures.length ||
      !caseWorkersSettled ||
      !nativeCleanupComplete ||
      !classifierCleanupComplete ||
      sourceAfterSha256 !== sourceBeforeSha256
        ? 'incomplete'
        : 'complete',
    producerSourceSha256: sourceBeforeSha256,
    sourceBeforeSha256,
    sourceAfterSha256,
    sourceUnchanged: sourceAfterSha256 === sourceBeforeSha256,
    plannedCaseIds: corpus.cases.map((item) => item.caseId),
    completedCaseIds,
    missingCaseIds,
    results: results.filter((row): row is RegionSeededCaseResult => row !== undefined),
    aggregate,
    shutdownError: shutdownError ?? null,
    caseWorkersSettled,
    nativeCleanupComplete,
    classifierCleanupComplete,
    recorderPersistenceFailures,
    ...(options.variant === 'no-image-control'
      ? {
          imageFetchAudit: {
            checkedFetches: [...noImageAudits.values()].reduce(
              (sum, row) => sum + row.checkedFetches,
              0,
            ),
            imagePartFetches: [...noImageAudits.values()].reduce(
              (sum, row) => sum + row.imagePartFetches,
              0,
            ),
            allRequestsVerifiedImageFree: [...noImageAudits.values()].every(
              (row) => row.imagePartFetches === 0,
            ),
            perCase: Object.fromEntries(noImageAudits),
          },
        }
      : {}),
    workerFailureCode: failed === undefined ? null : safeErrorCode(failed),
    physicalReceipts: corpus.cases.flatMap((item) =>
      (recorders.get(item.caseId)?.calls ?? []).map((call) => ({
        caseId: item.caseId,
        ...physicalSummary(call),
      })),
    ),
  }
  const summaryPath = join(outputDirectory, 'summary.json')
  await immutable(summaryPath, summary)
  await immutable(join(outputDirectory, 'run-complete.json'), {
    runId,
    status: summary.status,
    summarySha256: sha256(JSON.stringify(summary)),
    sourceBeforeSha256,
    sourceAfterSha256,
    sourceUnchanged: summary.sourceUnchanged,
  })
  return { ...summary, outputDirectory }
}

class CaseBudget extends RunBudget {
  private readonly mapping = new Map<number, number>()
  constructor(private readonly shared: RunBudget) {
    super(4, 5, 0.05, 'dev')
  }
  override admit(): number {
    const local = super.admit()
    try {
      const global = this.shared.admit()
      this.mapping.set(global, local)
      return global
    } catch (error) {
      super.cancelBeforeFetch(local)
      throw error
    }
  }
  override settle(global: number, cost: number | null): void {
    const local = this.mapping.get(global)
    if (local === undefined) throw new Error('Unknown per-case admission')
    this.mapping.delete(global)
    this.shared.settle(global, cost)
    super.settle(local, cost)
  }
  override cancelBeforeFetch(global: number): void {
    const local = this.mapping.get(global)
    if (local === undefined) throw new Error('Unknown per-case admission')
    this.mapping.delete(global)
    try {
      this.shared.cancelBeforeFetch(global)
    } catch {
      this.shared.settle(global, null)
    }
    super.cancelBeforeFetch(local)
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
