import { mkdir, readFile, readdir } from 'node:fs/promises'
import { z } from 'zod'
import { join, resolve } from 'node:path'
import { createClassifier, ClassifierError } from '../src/index.js'
import type {
  ClassificationResult,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  LocalizationResult,
  PixelRect,
} from '../src/index.js'
import { createOpenRouterJev } from '../src/openrouter.js'
import { BenchmarkBudget } from './budget.js'
import { loadCorpus, photoBytes, sha256 } from './corpus.js'
import type { PhotoCase, PhotoTruth, Split } from './corpus.js'
import { failure, offlineProvider, recordProvider, writeJson } from './recording.js'
import type { CallRecord, Failure } from './recording.js'
import { nativeSelection, prefixLatency, prefixResult } from './ablations.js'
import { classificationMetrics, localizationMetrics, parityMetrics } from './metrics.js'
import type { ClassificationAttempt, LocalizationAttempt, ParityAttempt } from './metrics.js'
import { writeOverlay } from './overlay.js'

interface RunOptions {
  mode: 'offline' | 'live'
  allowPaid: boolean
  maxCalls: number
  maxCostUsd: number
  corpusDirectory: string
  outputDirectory: string
  splits: readonly Split[]
  limit?: number
}
interface Outcome<T> {
  result?: T
  error?: Failure
  durationMs: number
  calls: CallRecord[]
}
interface Sample {
  caseId: string
  split: Split
  kind: 'photo' | 'text'
  library?: ClassificationAttempt
  native?: ClassificationAttempt
  parity?: ParityAttempt
  locate?: LocalizationAttempt
  oneStage?: LocalizationAttempt
  twoStage?: LocalizationAttempt
}
interface NetworkEvent {
  ordinal: number
  startedAt: string
  durationMs: number
  durationScope: 'fetch-until-response-headers'
  status?: number
  failed: boolean
}
interface RunContext {
  provider: DecisionPort
  budget: BenchmarkBudget
  directory: string
  samples: Sample[]
  control: RunControl
}
class RunControl {
  private halted = false
  reason: Failure | undefined
  get stopped(): boolean {
    return this.halted
  }
  stop(reason: Failure): void {
    this.halted = true
    this.reason ??= reason
  }
}
const deadlineMs = 45_000

function summary<T>(outcome: Outcome<T>) {
  return { ...outcome, calls: outcome.calls.map(({ request: _request, ...call }) => call) }
}
async function execute<T>(
  context: RunContext,
  name: string,
  task: (port: DecisionPort) => Promise<T>,
): Promise<Outcome<T>> {
  const directory = join(context.directory, name)
  await mkdir(directory, { recursive: true })
  const started = performance.now(),
    recorder = recordProvider(context.provider, context.budget, directory, started)
  let result: T | undefined, error: Failure | undefined
  try {
    result = await task(recorder.port)
  } catch (caught) {
    error = failure(caught)
  }
  // Library cancellation may replace a thrown error; evidence loss is independently terminal.
  error = recorder.calls.find((call) => call.artifactFailure)?.artifactFailure ?? error
  const outcome: Outcome<T> = {
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    durationMs: performance.now() - started,
    calls: recorder.calls,
  }
  await writeJson(join(directory, 'summary.json'), summary(outcome))
  if (
    error?.code === 'BENCHMARK_BUDGET_EXHAUSTED' ||
    error?.code === 'BENCHMARK_ARTIFACT_FAILURE' ||
    context.budget.snapshot().exceededByReportedCost
  )
    context.control.stop(
      error ?? {
        name: 'BudgetExhausted',
        code: 'BENCHMARK_BUDGET_EXHAUSTED',
        message: 'Reported cost exceeded admission budget',
      },
    )
  return outcome
}
async function libraryCall<T>(
  port: DecisionPort,
  task: (classifier: ReturnType<typeof createClassifier>) => Promise<T>,
): Promise<T> {
  const classifier = createClassifier({
    decision: port,
    timeoutMs: deadlineMs,
    concurrency: 1,
    maxQueue: 0,
  })
  try {
    return await task(classifier)
  } finally {
    await classifier.dispose()
  }
}
async function nativeCall(port: DecisionPort, request: DecisionRequest): Promise<DecisionResult> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new ClassifierError('TIMEOUT', 'Native benchmark deadline exceeded')),
    deadlineMs,
  )
  try {
    const result = await port.decide(request, controller.signal)
    if (controller.signal.aborted) throw controller.signal.reason
    return result
  } finally {
    clearTimeout(timer)
  }
}
function categorical(
  expected: string,
  outcome: Outcome<{ choice: string }>,
): ClassificationAttempt {
  return {
    expectedClassId: expected,
    outcome:
      outcome.result === undefined
        ? { status: 'failed' }
        : { status: 'ok', choice: outcome.result.choice },
    latencyMs: outcome.durationMs,
  }
}
function normalized(region: PixelRect, input: PhotoCase): PixelRect {
  return {
    left: region.left / input.image.width,
    top: region.top / input.image.height,
    width: region.width / input.image.width,
    height: region.height / input.image.height,
  }
}
function locateAttempt(
  input: PhotoCase,
  truth: PhotoTruth,
  result: { status: 'located'; region: PixelRect } | { status: 'unknown' | 'not-found' | 'failed' },
  duration: number,
): LocalizationAttempt {
  const expected: LocalizationAttempt['expected'] =
    truth.expectedPresence === 'absent'
      ? { presence: 'absent', verified: true }
      : {
          presence: 'present',
          boxes: truth.targetBoxes.map(({ xyxy: [x0, y0, x1, y1] }) => ({
            left: x0,
            top: y0,
            width: x1 - x0,
            height: y1 - y0,
          })),
        }
  return {
    expected,
    outcome:
      result.status === 'located'
        ? { status: 'located', region: normalized(result.region, input) }
        : { status: result.status },
    latencyMs: duration,
  }
}
async function classifyPair(
  context: RunContext,
  name: string,
  expected: string,
  task: (classifier: ReturnType<typeof createClassifier>) => Promise<ClassificationResult>,
) {
  const library = await execute(context, `${name}/classify-library`, (port) =>
    libraryCall(port, task),
  )
  const request = library.calls[0]?.request
  if (!request || context.control.stopped) return { library: categorical(expected, library) }
  const native = await execute(context, `${name}/classify-native`, async (port) => {
    const result = await nativeCall(port, request)
    return { ...nativeSelection(request, result), metadata: result.metadata }
  })
  if (library.calls[0]?.requestSha256 !== native.calls[0]?.requestSha256)
    throw new Error('Native baseline request diverged from the captured library request')
  const parity: ParityAttempt = { library: library.result ?? null, native: native.result ?? null }
  return { library: categorical(expected, library), native: categorical(expected, native), parity }
}
async function runPhoto(
  context: RunContext,
  input: PhotoCase,
  truth: PhotoTruth,
  bytes: Uint8Array,
): Promise<void> {
  const name = `${input.split}/${input.caseId}`
  const pair = await classifyPair(context, name, truth.expectedPresence, (classifier) =>
    classifier.classify({
      input: { image: bytes, text: input.classify.question },
      classes: [
        {
          id: 'present',
          description:
            'The photograph contains at least one visible physical instance of the named object.',
        },
        {
          id: 'absent',
          description: 'The photograph contains no visible physical instance of the named object.',
        },
      ],
    }),
  )
  const sample: Sample = { caseId: input.caseId, split: input.split, kind: 'photo', ...pair }
  context.samples.push(sample)
  if (context.control.stopped) return
  const locate = await execute<LocalizationResult>(context, `${name}/locate`, (port) =>
    libraryCall(port, (classifier) =>
      classifier.locate({ image: bytes, target: input.locate.target }),
    ),
  )
  if (
    locate.result &&
    (locate.result.metadata.image.width !== input.image.width ||
      locate.result.metadata.image.height !== input.image.height)
  )
    throw new Error('Oriented source dimensions differ from annotated fixture')
  sample.locate = locateAttempt(
    input,
    truth,
    locate.result ?? { status: 'failed' },
    locate.durationMs,
  )
  const one = prefixResult(locate.calls, 1),
    two = prefixResult(locate.calls, 2)
  sample.oneStage = locateAttempt(
    input,
    truth,
    one,
    prefixLatency(locate.calls, 1, locate.durationMs),
  )
  sample.twoStage = locateAttempt(
    input,
    truth,
    two,
    prefixLatency(locate.calls, 2, locate.durationMs),
  )
  await writeJson(join(context.directory, name, 'prefix-ablations.json'), {
    scope: 'same-run recorded prefix, no additional calls; no final candidate confirmation',
    oneStage: one,
    twoStage: two,
  })
  await writeOverlay(
    bytes,
    truth,
    [
      { label: 'one-stage', ...(one.status === 'located' ? { region: one.region } : {}) },
      { label: 'two-stage', ...(two.status === 'located' ? { region: two.region } : {}) },
      {
        label: 'three-stage',
        ...(locate.result?.status === 'located' ? { region: locate.result.region } : {}),
      },
    ],
    join(context.directory, name, 'overlay.png'),
  )
}
function metrics(samples: readonly Sample[], textClasses: readonly string[]) {
  const result: Record<string, unknown> = {}
  for (const split of ['dev', 'heldout'] as const) {
    const photos = samples.filter((s) => s.split === split && s.kind === 'photo'),
      texts = samples.filter((s) => s.split === split && s.kind === 'text')
    result[split] = {
      photo: {
        library: classificationMetrics(
          ['present', 'absent'],
          photos.flatMap((s) => (s.library ? [s.library] : [])),
        ),
        native: classificationMetrics(
          ['present', 'absent'],
          photos.flatMap((s) => (s.native ? [s.native] : [])),
        ),
        parity: parityMetrics(photos.flatMap((s) => (s.parity ? [s.parity] : []))),
      },
      text: {
        library: classificationMetrics(
          textClasses,
          texts.flatMap((s) => (s.library ? [s.library] : [])),
        ),
        native: classificationMetrics(
          textClasses,
          texts.flatMap((s) => (s.native ? [s.native] : [])),
        ),
        parity: parityMetrics(texts.flatMap((s) => (s.parity ? [s.parity] : []))),
      },
      localization: {
        oneStagePrefix: localizationMetrics(
          photos.flatMap((s) => (s.oneStage ? [s.oneStage] : [])),
        ),
        twoStagePrefix: localizationMetrics(
          photos.flatMap((s) => (s.twoStage ? [s.twoStage] : [])),
        ),
        threeStage: localizationMetrics(photos.flatMap((s) => (s.locate ? [s.locate] : []))),
      },
    }
  }
  return result
}
const runOptionsSchema = z
  .object({
    mode: z.enum(['offline', 'live']),
    allowPaid: z.boolean(),
    maxCalls: z.number().int().min(1).max(360),
    maxCostUsd: z.number().positive().max(1),
    corpusDirectory: z.string().min(1),
    outputDirectory: z.string().min(1),
    splits: z
      .array(z.enum(['dev', 'heldout']))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length),
    limit: z.number().int().min(1).max(60).optional(),
  })
  .strict()
async function sourceSnapshot(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(new URL(`../${path}/`, import.meta.url), {
      withFileTypes: true,
    })) {
      const relative = `${path}/${entry.name}`
      if (entry.isDirectory() && path.startsWith('src')) await visit(relative)
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        hashes[relative] = sha256(await readFile(new URL(`../${relative}`, import.meta.url)))
    }
  }
  await visit('src')
  await visit('benchmarks')
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json'])
    hashes[file] = sha256(await readFile(new URL(`../${file}`, import.meta.url)))
  return hashes
}
/** No provider is constructed before explicit live admission validation and corpus validation. */
export async function runBenchmark(
  input: RunOptions,
  offlineNeighbor?: DecisionPort,
): Promise<{ status: string; reportPath: string }> {
  const options = runOptionsSchema.parse(input)
  // Controlled test neighbors cannot produce a report labelled real-provider. CLI never supplies one.
  if (offlineNeighbor && options.mode !== 'offline')
    throw new Error('Custom neighbors are fixture-only')
  if (options.mode === 'live' && !options.allowPaid)
    throw new Error('Live mode requires --allow-paid')
  const budget = new BenchmarkBudget(options.maxCalls, options.maxCostUsd)
  const corpus = await loadCorpus(resolve(options.corpusDirectory), options.splits, options.limit)
  const directory = resolve(options.outputDirectory)
  // A run directory must not already exist; previous evidence is never overwritten.
  await mkdir(directory, { recursive: false })
  const startedAt = new Date().toISOString(),
    started = performance.now(),
    network: NetworkEvent[] = []
  let provider: DecisionPort
  if (options.mode === 'offline') provider = offlineNeighbor ?? offlineProvider()
  else {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required; its value is never recorded')
    provider = createOpenRouterJev({
      apiKey,
      fetch: async (input, init) => {
        const event: NetworkEvent = {
            ordinal: network.length + 1,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            durationScope: 'fetch-until-response-headers',
            failed: true,
          },
          before = performance.now()
        network.push(event)
        try {
          const response = await fetch(input, init)
          event.status = response.status
          event.failed = !response.ok
          return response
        } finally {
          event.durationMs = performance.now() - before
        }
      },
    })
  }
  const context: RunContext = {
    provider,
    budget,
    directory,
    samples: [],
    control: new RunControl(),
  }
  const sourceHashes = await sourceSnapshot()
  await writeJson(join(directory, 'manifest.json'), {
    version: 1,
    startedAt,
    mode: options.mode,
    evidence:
      options.mode === 'offline'
        ? 'mechanics-fixture-only; not model accuracy, latency, or cost evidence'
        : 'real-provider; route and metadata recorded per call',
    options: { ...options, outputDirectory: directory },
    node: process.version,
    platform: process.platform,
    model: 'typesafe/jev-1.14',
    provider: 'typesafe',
    fallbacks: false,
    operationTimeoutMs: deadlineMs,
    retries: 0,
    maximumPlannedCalls: corpus.photos.length * 5 + corpus.texts.length * 2,
    planned: { photos: corpus.photos.length, texts: corpus.texts.length },
    corpus: corpus.manifests,
    sourceHashes,
    limitations: [
      'Public photos may overlap training data; heldout is only held out from local development.',
      'Text fixtures and labels are assistant-authored, not independent human annotations.',
      'Locate returns one region; center-inside-any-box is not all-object recall or segmentation accuracy.',
      'Prefix ablations reuse exact stage answers; they lack third-stage confirmation.',
      'Request preparation and artifact writes are included in measured operation latency.',
      'Known cost plus $0.02 per incomplete or unknown-cost provider invocation is an admission estimate, not a provider-enforced spending limit.',
      'Public DecisionResult contains cost and route metadata; raw HTTP token usage is unavailable.',
      'Photographs do not validate gaming UI, maps, OCR, or temporal tracking.',
    ],
  })
  let fatal: Failure | undefined
  try {
    for (const photo of corpus.photos) {
      if (context.control.stopped) break
      const truth = corpus.photoTruth.get(photo.caseId)
      if (!truth) throw new Error('Missing joined photo truth')
      await runPhoto(context, photo, truth, await photoBytes(options.corpusDirectory, photo))
    }
    const classes = corpus.policy.classes.map((c) => ({ id: c.id, description: c.definition })),
      instructions = [corpus.policy.task, ...corpus.policy.rules].join('\n')
    for (const text of corpus.texts) {
      if (context.control.stopped) break
      const truth = corpus.textTruth.get(text.caseId)
      if (!truth) throw new Error('Missing joined text truth')
      const pair = await classifyPair(
        context,
        `${text.split}/${text.caseId}`,
        truth.expected,
        (classifier) => classifier.classify({ input: text.text, classes, instructions }),
      )
      context.samples.push({ caseId: text.caseId, split: text.split, kind: 'text', ...pair })
    }
  } catch (error) {
    fatal = failure(error)
  }
  const complete =
    !context.control.stopped &&
    !fatal &&
    context.samples.length === corpus.photos.length + corpus.texts.length
  const reportPath = join(directory, 'report.json'),
    report = {
      version: 1,
      status: complete ? 'complete' : 'incomplete',
      mode: options.mode,
      evidence: options.mode === 'offline' ? 'mechanics-fixture-only' : 'real-provider',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      planned: { photos: corpus.photos.length, texts: corpus.texts.length },
      startedCases: context.samples.length,
      unstartedCases: corpus.photos.length + corpus.texts.length - context.samples.length,
      reason: fatal ?? context.control.reason ?? null,
      budget: budget.snapshot(),
      physicalHttpCalls: network.length,
      network,
      metrics: metrics(
        context.samples,
        corpus.policy.classes.map((c) => c.id),
      ),
      samples: context.samples,
    }
  await writeJson(reportPath, report)
  return { status: report.status, reportPath }
}
