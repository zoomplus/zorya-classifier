import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Node as TsNode } from 'typescript'
import { createClassifier } from '../../src/app/create-classifier.js'
import type { Classifier, ClassifierOptions } from '../../src/app/create-classifier.js'
import type { DecisionPort } from '../../src/entities/contracts.js'
import type { SegmentationPort } from '../../src/entities/segmentation.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { createMobileSamSegmenter } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import { createMobileSamObjectProposals } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import type { ObjectProposalPort } from '../../src/entities/object-proposals.js'
import { RunBudget } from '../v02/budget.js'
import type { BudgetSnapshot } from '../v02/budget.js'
import { assertRecorderHealthy, processRegionSeededCase } from '../v02/region-seeded-runner.js'
import type { RegionSeededCaseResult } from '../v02/region-seeded-runner.js'
import { createNativeCategoricalPresencePort } from '../v02/native-categorical-presence-port.js'
import { recordProvider } from '../v02/recording.js'
import type { Recorder } from '../v02/recording.js'
import { hashCanonical } from '../v02/protocol.js'
import { loadFreshImage } from '../v02/fresh-corpus.js'
import type { FreshCase, FreshCorpus } from '../v02/fresh-corpus.js'
import { loadV03PilotCorpus } from './pilot-manifest.js'

export const semanticPilotRecipe = Object.freeze({
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false as const,
  phase: 'dev',
  variant: 'region-seeded-sam' as const,
  requireClassifiedPresence: true as const,
  checkedRegion: true as const,
  timeoutMs: 120_000,
  regionSearchPasses: 3,
  maxPhysicalCallsPerCase: 6,
  maxLogicalCallsPerCase: 6,
  maxPhysicalCallsPerProfile: 72,
  maxCostUsdPerProfile: 4,
  unknownCostReserveUsd: 0.05,
  nativeExecutionProvider: 'cpu',
  nativeThreads: 2,
  baselineMethod: 'mobile-sam-seed-region-v1',
  candidateMethod: 'mobile-sam-seed-center-proposals-v1',
  candidateSampling: 'seed-center',
  pairOrder: 'alternating-baseline-first-by-zero-based-case-index-v1',
})

const route = Object.freeze({
  model: semanticPilotRecipe.model,
  provider: semanticPilotRecipe.provider,
  providerName: semanticPilotRecipe.providerName,
  apiEndpoint: semanticPilotRecipe.apiEndpoint,
  allowFallbacks: false as const,
})

const expectedAssets = Object.freeze({
  encoder: {
    bytes: 28_157_093,
    sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
  },
  decoder: {
    bytes: 16_496_559,
    sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
  },
})

export interface SemanticPilotOptions {
  imageRoot: string
  outputRoot: string
  encoderPath: string
  decoderPath: string
  apiKey?: string
  allowPaid?: boolean
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  createClassifier?: (options: ClassifierOptions) => Classifier
  createBaseline?: (paths: {
    encoderPath: string
    decoderPath: string
  }) => Promise<SegmentationPort>
  createProposals?: (options: {
    encoderPath: string
    decoderPath: string
    executionProvider: 'cpu'
    threads: 2
    sampling: 'seed-center'
  }) => Promise<ObjectProposalPort>
  createSemanticWrapper?: (args: {
    proposals: ObjectProposalPort
    decision: DecisionPort
  }) => SegmentationPort
  /** Test seam; production always uses the pinned v0.3 DEV12 loader. */
  loadCorpus?: (imageRoot: string, signal: AbortSignal) => Promise<FreshCorpus>
  /** Test seam for pinned asset verification; production hashes the exact model files. */
  verifyAssets?: (
    encoderPath: string,
    decoderPath: string,
  ) => Promise<{
    encoder: { bytes: number; sha256: string }
    decoder: { bytes: number; sha256: string }
  }>
  /** Test-only/integration hook to close over exactly the source roots that were reviewed. */
  sourceEntries?: string[]
}

export interface SemanticPilotPlan {
  schemaVersion: 1
  runId: string
  mode: 'dry-run' | 'paid'
  profileIds: [string, string]
  manifests: Array<{ sha256: string; cases: number }>
  cases: Array<{ caseId: string; imageSha256: string }>
  route: typeof route
  recipe: typeof semanticPilotRecipe
  assets: {
    encoder: { bytes: number; sha256: string }
    decoder: { bytes: number; sha256: string }
  }
  sourceClosure: Array<{ path: string; sha256: string; bytes: number }>
  sourceClosureSha256: string
  order: Array<{ caseId: string; first: 'baseline' | 'semantic'; second: 'baseline' | 'semantic' }>
  budgetPerProfile: { maxPhysicalCalls: 72; maxCostUsd: 4; unknownReserveUsd: 0.05 }
}

export interface SemanticPilotResult extends SemanticPilotPlan {
  status: 'dry-run-complete' | 'complete' | 'failed' | 'source-changed'
  sourceUnchanged: boolean
  profileResults: Record<string, Array<RegionSeededCaseResult | null>>
  profileBudgets: Record<string, BudgetSnapshot>
  cleanupErrors: string[]
  errorCode?: string
  outputDirectory: string
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const defaultSourceEntries = [
  fileURLToPath(import.meta.url),
  join(moduleDirectory, 'semantic-mask-segmenter.ts'),
  join(moduleDirectory, 'pilot-manifest.ts'),
  join(moduleDirectory, 'pilot-inputs/photo.json'),
  join(moduleDirectory, 'pilot-inputs/ui.json'),
  join(moduleDirectory, 'pilot-inputs/map.json'),
  join(moduleDirectory, '../v02/region-seeded-runner.ts'),
  join(moduleDirectory, '../v02/recording.ts'),
  join(moduleDirectory, '../v02/budget.ts'),
  join(moduleDirectory, '../v02/fresh-corpus.ts'),
  join(moduleDirectory, '../v02/native-categorical-presence-port.ts'),
  join(moduleDirectory, '../v02/protocol.ts'),
  join(moduleDirectory, '../../src/infrastructure/segmentation/mobile-sam/index.ts'),
  join(moduleDirectory, '../../src/infrastructure/segmentation/mobile-sam/worker-inference.ts'),
  join(moduleDirectory, '../../src/infrastructure/segmentation/native-worker.ts'),
  join(moduleDirectory, '../../src/app/create-classifier.ts'),
  join(moduleDirectory, '../../package-lock.json'),
  join(moduleDirectory, '../../package.json'),
]

export function buildSemanticPilotOrder(cases: readonly Pick<FreshCase, 'caseId'>[]) {
  return cases.map((item, index) => ({
    caseId: item.caseId,
    first: (index % 2 === 0 ? 'baseline' : 'semantic') as 'baseline' | 'semantic',
    second: (index % 2 === 0 ? 'semantic' : 'baseline') as 'baseline' | 'semantic',
  }))
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function immutable(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function verifyAsset(path: string, expected: { bytes: number; sha256: string }) {
  const bytes = await readFile(path)
  try {
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256)
      throw Object.assign(new Error('Pinned MobileSAM asset mismatch'), { code: 'INVALID_INPUT' })
    return { bytes: bytes.byteLength, sha256: expected.sha256 }
  } finally {
    bytes.fill(0)
  }
}

function localSpecifierCandidates(source: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return []
  const base = resolve(dirname(source), specifier)
  return [
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.mjs$/u, '.mts'),
    base,
    `${base}.ts`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ]
}

/** Hash the local static-import closure, plus the frozen producer files and lockfile. */
export async function hashSemanticPilotSourceClosure(entries = defaultSourceEntries) {
  const manifestEntries = ['photo', 'ui', 'map'].map((name) =>
    join(moduleDirectory, `pilot-inputs/${name}.json`),
  )
  const pending = [
    ...new Set([
      ...entries,
      ...manifestEntries,
      resolve(moduleDirectory, '../../package-lock.json'),
    ]),
  ].map((path) => resolve(path))
  const visited = new Set<string>()
  while (pending.length > 0) {
    const path = pending.pop()!
    if (visited.has(path)) continue
    visited.add(path)
    const bytes = await readFile(path)
    if (!/\.(?:[cm]?ts|[cm]?js)$/u.test(path)) {
      bytes.fill(0)
      continue
    }
    const ts = await import('typescript')
    const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true)
    const specifiers: string[] = []
    const visit = (node: TsNode) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const first = node.arguments[0]
        if (first && ts.isStringLiteral(first)) specifiers.push(first.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    bytes.fill(0)
    for (const specifier of specifiers) {
      const candidates = localSpecifierCandidates(path, specifier)
      if (candidates.length > 0) {
        let found: string | undefined
        for (const candidate of candidates) {
          try {
            await access(candidate)
            found = candidate
            break
          } catch {
            // Try the next extension/index candidate.
          }
        }
        if (!found) throw new Error(`Missing source dependency ${specifier} from ${path}`)
        pending.push(found)
      }
    }
  }
  const root = resolve(moduleDirectory, '../..')
  const files = []
  for (const path of [...visited].sort()) {
    const bytes = await readFile(path)
    files.push({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    })
    bytes.fill(0)
  }
  return { files, sha256: hashCanonical(files) }
}

class CaseBudget extends RunBudget {
  private readonly mapping = new Map<number, number>()
  constructor(private readonly shared: RunBudget) {
    super(semanticPilotRecipe.maxPhysicalCallsPerCase, 4, 0.05, 'dev')
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
    if (local === undefined) throw new Error('Unknown case budget admission')
    this.mapping.delete(global)
    this.shared.settle(global, cost)
    super.settle(local, cost)
  }
  override cancelBeforeFetch(global: number): void {
    const local = this.mapping.get(global)
    if (local === undefined) throw new Error('Unknown case budget admission')
    this.mapping.delete(global)
    try {
      this.shared.cancelBeforeFetch(global)
    } catch {
      this.shared.settle(global, null)
    }
    super.cancelBeforeFetch(local)
  }
}

function pathExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  )
}

function assertSixCallLimit(row: RegionSeededCaseResult, recorder: Recorder): void {
  assertSemanticPilotCallLimits(row, {
    physical: recorder.calls.length,
    logical: recorder.logicalCalls.length,
  })
}

export function assertSemanticPilotCallLimits(
  row: RegionSeededCaseResult,
  calls: {
    physical: number
    logical: number
  },
): void {
  if (
    calls.physical > semanticPilotRecipe.maxPhysicalCallsPerCase ||
    calls.logical > semanticPilotRecipe.maxLogicalCallsPerCase ||
    row.classify.physicalCalls + row.extraction.physicalCalls > 6 ||
    row.classify.logicalCalls + row.extraction.logicalCalls > 6
  )
    throw Object.assign(new Error('Per-case H2c call cap exceeded'), { code: 'INVALID_RESPONSE' })
}

async function loadSemanticWrapper() {
  const tsPath = join(moduleDirectory, 'semantic-mask-segmenter.ts')
  const jsPath = join(moduleDirectory, 'semantic-mask-segmenter.js')
  const modulePath = (await pathExists(tsPath)) ? tsPath : jsPath
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    createSemanticMaskSegmenter?: (args: {
      proposals: ObjectProposalPort
      decision: DecisionPort
    }) => SegmentationPort
  }
  if (typeof loaded.createSemanticMaskSegmenter !== 'function')
    throw new Error('Semantic mask wrapper export is unavailable')
  return loaded.createSemanticMaskSegmenter
}

export async function runSemanticSegmentationPilot(
  options: SemanticPilotOptions,
): Promise<SemanticPilotResult> {
  const runId = randomUUID()
  const outputDirectory = resolve(options.outputRoot, `semantic-segmentation-${runId}`)
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  let proposals: ObjectProposalPort | undefined
  let baseline: SegmentationPort | undefined
  let semantic: SegmentationPort | undefined
  const recorders = new Map<string, Recorder>()
  const profileBudgets = {
    baseline: new RunBudget(72, 4, 0.05, 'dev'),
    semantic: new RunBudget(72, 4, 0.05, 'dev'),
  }
  const profileIds: [string, string] = [
    'h2c-point-expand-baseline-dev12-v1',
    'h2c-semantic-seed-center-dev12-v1',
  ]
  let rows: Record<string, Array<RegionSeededCaseResult | null>> = { baseline: [], semantic: [] }
  let plan: SemanticPilotPlan | undefined
  let finalResult: SemanticPilotResult | undefined
  let status: SemanticPilotResult['status'] = 'failed'
  let sourceUnchanged = false
  let errorCode: string | undefined
  const cleanupErrors: string[] = []
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  try {
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const corpus = await (options.loadCorpus ?? loadV03PilotCorpus)(
      options.imageRoot,
      controller.signal,
    )
    if (corpus.cases.length !== 12)
      throw new Error('Frozen H2c pilot must contain exactly twelve cases')
    const verifiedAssets = options.verifyAssets
      ? await options.verifyAssets(options.encoderPath, options.decoderPath)
      : {
          encoder: await verifyAsset(options.encoderPath, expectedAssets.encoder),
          decoder: await verifyAsset(options.decoderPath, expectedAssets.decoder),
        }
    const { encoder, decoder } = verifiedAssets
    for (const item of corpus.cases) {
      const bytes = await loadFreshImage(item, corpus.imageRoot, controller.signal)
      bytes.fill(0)
    }
    const closure = await hashSemanticPilotSourceClosure(options.sourceEntries)
    const profilesOrder = buildSemanticPilotOrder(corpus.cases)
    plan = {
      schemaVersion: 1,
      runId,
      mode: options.allowPaid === true ? 'paid' : 'dry-run',
      profileIds,
      manifests: corpus.manifests,
      cases: corpus.cases.map((item) => ({ caseId: item.caseId, imageSha256: item.image.sha256 })),
      route,
      recipe: semanticPilotRecipe,
      assets: { encoder, decoder },
      sourceClosure: closure.files,
      sourceClosureSha256: closure.sha256,
      order: profilesOrder,
      budgetPerProfile: { maxPhysicalCalls: 72, maxCostUsd: 4, unknownReserveUsd: 0.05 },
    }
    await immutable(join(outputDirectory, 'plan.json'), plan)
    if (options.allowPaid !== true) {
      status = 'dry-run-complete'
    } else {
      if (!options.apiKey)
        throw Object.assign(new Error('API key required with --allow-paid'), {
          code: 'INVALID_INPUT',
        })
      baseline = await (
        options.createBaseline ??
        ((paths) => createMobileSamSegmenter({ ...paths, executionProvider: 'cpu', threads: 2 }))
      )({
        encoderPath: options.encoderPath,
        decoderPath: options.decoderPath,
      })
      proposals = await (
        options.createProposals ?? ((paths) => createMobileSamObjectProposals(paths))
      )({
        encoderPath: options.encoderPath,
        decoderPath: options.decoderPath,
        executionProvider: 'cpu',
        threads: 2,
        sampling: 'seed-center',
      })
      const fetcher = options.fetch ?? globalThis.fetch
      const classifierFactory = options.createClassifier ?? ((args) => createClassifier(args))
      const makeRecorder = (caseDirectory: string, profile: 'baseline' | 'semantic') => {
        const localBudget = new CaseBudget(profileBudgets[profile])
        const recorder = recordProvider(
          (trackedFetch) =>
            createOpenRouterDecisions({
              apiKey: options.apiKey!,
              model: route.model,
              provider: route.provider,
              providerName: route.providerName,
              fetch: trackedFetch,
            }),
          localBudget,
          join(caseDirectory, 'calls'),
          route,
          fetcher,
        )
        recorders.set(`${profile}:${caseDirectory}`, recorder)
        return createNativeCategoricalPresencePort(recorder.port)
      }
      let activeDecisionRecorder: DecisionPort | undefined
      const semanticWrapper = options.createSemanticWrapper ?? (await loadSemanticWrapper())
      semantic = semanticWrapper({
        proposals,
        decision: {
          async decide(request, signal) {
            // Each case gets its own recorder, swapped synchronously before that profile begins.
            const recorder = activeDecisionRecorder
            if (!recorder) throw new Error('Semantic decision recorder is not active')
            return recorder.decide(request, signal)
          },
        },
      })
      // The shared wrapper receives a case-scoped decision proxy; cases run serially, so only one is active.
      // The proxy delegates at call time to the exact per-case recorder installed below.
      const resultsByProfile: Record<string, Array<RegionSeededCaseResult | null>> = {
        baseline: new Array(corpus.cases.length).fill(null),
        semantic: new Array(corpus.cases.length).fill(null),
      }
      rows = resultsByProfile
      const runOne = async (item: FreshCase, index: number, profile: 'baseline' | 'semantic') => {
        const caseDirectory = join(outputDirectory, profile, item.caseId)
        await mkdir(dirname(caseDirectory), { recursive: true })
        const decision = makeRecorder(caseDirectory, profile)
        activeDecisionRecorder = decision
        const recorder = recorders.get(`${profile}:${caseDirectory}`)!
        const segmenter =
          profile === 'baseline'
            ? baseline!
            : {
                segment: semantic!.segment.bind(semantic),
                ...(semantic!.expand ? { expand: semantic!.expand.bind(semantic) } : {}),
                settle: semantic!.settle.bind(semantic),
                async dispose() {},
              }
        try {
          const row = await processRegionSeededCase({
            item,
            root: corpus.imageRoot,
            caseDirectory,
            classifierFactory,
            decision,
            segmentation: segmenter,
            variant: 'region-seeded-sam',
            requireClassifiedPresence: true,
            checkedRegion: true,
            recorder,
            signal: controller.signal,
          })
          assertRecorderHealthy(recorder)
          assertSixCallLimit(row, recorder)
          await immutable(join(caseDirectory, 'result.json'), row)
          resultsByProfile[profile]![index] = row
        } finally {
          activeDecisionRecorder = undefined
        }
      }
      for (const [index, item] of corpus.cases.entries()) {
        if (controller.signal.aborted) throw controller.signal.reason
        const pairOrder = profilesOrder[index]!
        await runOne(item, index, pairOrder.first)
        await runOne(item, index, pairOrder.second)
      }
      status = 'complete'
    }
  } catch (error) {
    errorCode =
      typeof error === 'object' && error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'RUNNER_FAILURE'
    status = 'failed'
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    const ownedPorts: Array<
      [string, { settle(): Promise<void>; dispose(): Promise<void> } | undefined]
    > = [
      ['baseline', baseline],
      ['semantic', semantic],
      ['proposals', proposals],
    ]
    for (const [name, port] of ownedPorts) {
      if (!port) continue
      try {
        await port.settle()
      } catch {
        cleanupErrors.push(`${name}.settle:CLEANUP_FAILURE`)
      }
    }
    for (const [name, port] of ownedPorts) {
      if (!port) continue
      try {
        await port.dispose()
      } catch {
        cleanupErrors.push(`${name}.dispose:CLEANUP_FAILURE`)
      }
    }
    for (const [key, recorder] of recorders) {
      try {
        assertRecorderHealthy(recorder)
      } catch {
        cleanupErrors.push(`${key}:RECORDER_UNHEALTHY`)
      }
    }
    for (const [name, budget] of Object.entries(profileBudgets)) {
      if (budget.snapshot().inFlightCalls !== 0)
        cleanupErrors.push(`${name}.budget:IN_FLIGHT_CALLS`)
    }
    if (plan) {
      try {
        const after = await hashSemanticPilotSourceClosure(options.sourceEntries)
        sourceUnchanged = after.sha256 === plan.sourceClosureSha256
        if (!sourceUnchanged) status = 'source-changed'
      } catch {
        sourceUnchanged = false
        status = 'source-changed'
      }
      if (cleanupErrors.length > 0) {
        status = status === 'source-changed' ? 'source-changed' : 'failed'
        errorCode ??= 'CLEANUP_FAILURE'
      }
      finalResult = {
        ...plan,
        status,
        sourceUnchanged,
        profileResults: rows,
        profileBudgets: {
          baseline: profileBudgets.baseline.snapshot(),
          semantic: profileBudgets.semantic.snapshot(),
        },
        cleanupErrors,
        ...(errorCode ? { errorCode } : {}),
        outputDirectory,
      }
      await immutable(join(outputDirectory, 'summary.json'), finalResult)
      await immutable(join(outputDirectory, 'run-complete.json'), {
        runId,
        status,
        sourceClosureSha256: plan.sourceClosureSha256,
        sourceUnchanged,
        cleanupErrors,
        summarySha256: sha256(Buffer.from(JSON.stringify(finalResult))),
      })
    }
  }
  if (finalResult) return finalResult
  throw new Error('H2c run failed before a reviewable plan could be written')
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>()
  let allowPaid = false
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (value === '--allow-paid') allowPaid = true
    else if (value.startsWith('--') && argv[index + 1] && !argv[index + 1]!.startsWith('--'))
      values.set(value.slice(2), argv[++index]!)
    else throw new Error(`Invalid argument ${value}`)
  }
  return { values, allowPaid }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, allowPaid } = parseArgs(process.argv.slice(2))
  const required = (key: string) => {
    const value = values.get(key)
    if (!value) throw new Error(`--${key} is required`)
    return resolve(value)
  }
  const outputRoot = required('output')
  const imageRoot = required('images')
  const encoderPath = required('encoder')
  const decoderPath = required('decoder')
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Process interrupted'))
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  runSemanticSegmentationPilot({
    imageRoot,
    outputRoot,
    encoderPath,
    decoderPath,
    ...(allowPaid ? { allowPaid: true } : {}),
    ...(process.env.OPENROUTER_API_KEY ? { apiKey: process.env.OPENROUTER_API_KEY } : {}),
    signal: controller.signal,
  })
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ status: result.status, outputDirectory: result.outputDirectory })}\n`,
      )
      if (result.status !== 'complete' && result.status !== 'dry-run-complete') process.exitCode = 1
    })
    .finally(() => {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'H2c runner failed'}\n`)
      process.exitCode = 1
    })
}
