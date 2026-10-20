import { channel } from 'node:diagnostics_channel'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { z } from 'zod'

import { createClassifier, type Classifier, type ClassifierOptions } from '../../src/index.js'
import { ClassifierError } from '../../src/entities/errors.js'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  PixelRect,
} from '../../src/entities/contracts.js'
import type { SegmentationInput, SegmentationPort } from '../../src/entities/segmentation.js'
import type { ExtractInput } from '../../src/entities/segmentation.js'
import type { WholeObjectLocateInput } from '../../src/entities/whole-object.js'
import { createMobileSamSegmenter } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import {
  ResourceRunner,
  disposeInOrder,
  runMonotonicPhase,
  type ResourceReport,
  validateFullSoakDurations,
} from './resource-runner.js'

interface CliOptions {
  encoderPath: string
  decoderPath: string
  sourceManifestPath: string
  sourceManifestSha256: string
  archiveReferenceSha256: string
  threads: number
  outputPath?: string
  warmupSeconds: number
  durationSeconds: number
  idleSeconds: number
  sampleMs: number
  smoke: boolean
  parentLossChild: boolean
}

interface CycleRecord {
  operation: 'locate' | 'extract'
  status: string
  durationMs: number
  seedRegion?: PixelRect
  seedIntersectsTarget?: boolean
  seedCenterInsideTarget?: boolean
  unknownReason?: string
  errorCode?: string
  outputBytes?: number
}

const sourceManifestSchema = z
  .object({ revision: z.string(), files: z.record(z.string()) })
  .strict()

const resourceChannel = channel('zorya.segmentation.child-resource')
const sourceWidth = 256
const sourceHeight = 256
const fullRegion: PixelRect = { left: 0, top: 0, width: sourceWidth, height: sourceHeight }
// Its center (32,32) is inside the target, including the actual final-grid seed cell.
const targetRegion: PixelRect = { left: 24, top: 24, width: 16, height: 16 }

function parseOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  let smoke = false
  let parentLossChild = false
  for (const arg of argv) {
    if (arg === '--smoke') {
      smoke = true
      continue
    }
    if (arg === '--parentloss-child') {
      parentLossChild = true
      continue
    }
    if (!arg.startsWith('--') || !arg.includes('='))
      throw new Error(`Expected --name=value, got ${arg}`)
    const separator = arg.indexOf('=')
    values.set(arg.slice(2, separator), arg.slice(separator + 1))
  }
  const encoderPath = values.get('encoder')
  const decoderPath = values.get('decoder')
  const sourceManifestPath = values.get('source-manifest')
  const sourceManifestSha256 = values.get('source-manifest-sha256')
  const archiveReferenceSha256 = values.get('archive-sha')
  if (!encoderPath || !decoderPath) throw new Error('--encoder and --decoder are required')
  if (!sourceManifestPath || !sourceManifestSha256 || !/^[a-f0-9]{64}$/.test(sourceManifestSha256))
    throw new Error('--source-manifest and its pinned --source-manifest-sha256 are required')
  if (!archiveReferenceSha256 || !/^[a-f0-9]{64}$/.test(archiveReferenceSha256))
    throw new Error('--archive-sha must be a reference SHA256 (the harness does not install it)')
  const integerOption = (key: string, fallback: number, minimum: number) => {
    const value = Number(values.get(key) ?? fallback)
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(`--${key} must be an integer >= ${minimum}`)
    return value
  }
  const outputPath = values.get('out')
  if (!smoke && !parentLossChild && !outputPath) throw new Error('--out is required for a soak run')
  const warmupSeconds = integerOption('warmup-seconds', smoke ? 0 : 600, 0)
  const durationSeconds = integerOption('duration-seconds', smoke ? 1 : 6540, 1)
  const idleSeconds = integerOption('idle-seconds', smoke ? 1 : 30, 1)
  const threads = integerOption('threads', 2, 1)
  if (threads > 4) throw new Error('--threads must be an integer from 1 through 4')
  if (
    !smoke &&
    !parentLossChild &&
    !validateFullSoakDurations({ warmupSeconds, durationSeconds, idleSeconds })
  )
    throw new Error(
      'Qualified soak requires at least 600s warmup, 6540s busy, 30s per idle window, and 7200s total',
    )
  return {
    encoderPath: resolve(encoderPath),
    decoderPath: resolve(decoderPath),
    sourceManifestPath: resolve(sourceManifestPath),
    sourceManifestSha256,
    archiveReferenceSha256,
    threads,
    ...(outputPath ? { outputPath: resolve(outputPath) } : {}),
    warmupSeconds,
    durationSeconds,
    idleSeconds,
    sampleMs: integerOption('sample-ms', 5000, 250),
    smoke,
    parentLossChild,
  }
}

function syntheticRgba(): Uint8Array {
  const data = new Uint8Array(sourceWidth * sourceHeight * 4)
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      const offset = (y * sourceWidth + x) * 4
      const foreground =
        x >= targetRegion.left &&
        x < targetRegion.left + targetRegion.width &&
        y >= targetRegion.top &&
        y < targetRegion.top + targetRegion.height
      data[offset] = foreground ? 226 : 224
      data[offset + 1] = foreground ? 36 : 224
      data[offset + 2] = foreground ? 42 : 224
      data[offset + 3] = 255
    }
  }
  return data
}

async function syntheticPng(): Promise<Uint8Array> {
  const png = await sharp(syntheticRgba(), {
    raw: { width: sourceWidth, height: sourceHeight, channels: 4 },
  })
    .png()
    .toBuffer()
  return new Uint8Array(png)
}

async function listSourceFiles(directory: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) output.push(...(await listSourceFiles(path)))
    else if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) output.push(path)
  }
  return output
}

async function verifySourceManifest(path: string, expectedSha256: string) {
  const bytes = await readFile(path)
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex')
  if (manifestSha256 !== expectedSha256)
    throw new Error('Source manifest bytes do not match the pinned manifest SHA256')
  const parsed = sourceManifestSchema.safeParse(JSON.parse(bytes.toString('utf8')))
  if (!parsed.success) throw new Error('Source manifest must contain revision and files mapping')
  const manifest = parsed.data
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const required = [
    ...(await listSourceFiles(resolve(projectRoot, 'src'))),
    resolve(projectRoot, 'benchmarks/v02/region-segmentation-resource-soak.ts'),
    resolve(projectRoot, 'benchmarks/v02/resource-runner.ts'),
  ]
  const requiredRelative = required.map((file) => relative(projectRoot, file).split(sep).join('/'))
  const entries = Object.entries(manifest.files)
  if (
    entries.length !== requiredRelative.length ||
    requiredRelative.some((file) => !(file in manifest.files))
  )
    throw new Error('Source manifest must pin every runtime file and exactly both harness files')
  for (const [file, expectedHash] of entries) {
    if (
      file.startsWith('/') ||
      file.split('/').includes('..') ||
      !/^[a-f0-9]{64}$/.test(expectedHash)
    )
      throw new Error(`Invalid source manifest entry: ${file}`)
    const absolutePath = resolve(projectRoot, file)
    if (!absolutePath.startsWith(`${projectRoot}${sep}`))
      throw new Error(`Source manifest path escapes project root: ${file}`)
    const actualHash = createHash('sha256')
      .update(await readFile(absolutePath))
      .digest('hex')
    if (actualHash !== expectedHash) throw new Error(`Source file hash mismatch: ${file}`)
  }
  return {
    revision: manifest.revision,
    manifestSha256,
    sourceFileCount: entries.length,
  }
}

function intersectionArea(left: PixelRect, right: PixelRect): number {
  const width = Math.max(
    0,
    Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left),
  )
  const height = Math.max(
    0,
    Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top),
  )
  return width * height
}

function geometryScores(request: DecisionRequest, labels: readonly string[]): Map<string, number> {
  const regionByLabel = new Map<string, PixelRect>()
  for (const part of request.state) {
    if (typeof part !== 'string' || !part.startsWith('{')) continue
    try {
      const value: unknown = JSON.parse(part)
      if (typeof value !== 'object' || value === null || !('labels' in value)) continue
      const listed = value.labels
      if (!Array.isArray(listed)) continue
      for (const item of listed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          'id' in item &&
          typeof item.id === 'string' &&
          'sourceRegion' in item &&
          typeof item.sourceRegion === 'object' &&
          item.sourceRegion !== null
        ) {
          const rect = item.sourceRegion
          if (
            'left' in rect &&
            typeof rect.left === 'number' &&
            'top' in rect &&
            typeof rect.top === 'number' &&
            'width' in rect &&
            typeof rect.width === 'number' &&
            'height' in rect &&
            typeof rect.height === 'number'
          )
            regionByLabel.set(item.id, {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            })
        }
      }
    } catch {
      // Other state strings, including prompt text, are not grid geometry.
    }
  }
  return new Map(
    labels.map((label) => [
      label,
      intersectionArea(regionByLabel.get(label) ?? fullRegion, targetRegion),
    ]),
  )
}

async function candidateScores(request: DecisionRequest, labels: readonly string[]) {
  const imageByLabel = new Map<string, string>()
  let pendingLabel: string | undefined
  for (const part of request.state) {
    if (typeof part === 'string') {
      const match = /^CANDIDATE ([A-D])$/.exec(part)
      pendingLabel = match?.[1]
    } else if (pendingLabel) {
      imageByLabel.set(pendingLabel, part.image_url.url)
      pendingLabel = undefined
    }
  }
  const scores = new Map<string, number>()
  for (const label of labels) {
    const url = imageByLabel.get(label)
    if (!url?.startsWith('data:image/png;base64,')) {
      scores.set(label, 0)
      continue
    }
    const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    const decoded = await sharp(bytes, { limitInputPixels: 2_000_000 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let pixels = 0
    for (let offset = 0; offset < decoded.data.length; offset += decoded.info.channels) {
      if (
        decoded.data[offset]! > 150 &&
        decoded.data[offset + 1]! < 100 &&
        decoded.data[offset + 2]! < 110 &&
        decoded.data[offset + 3]! > 0
      )
        pixels++
    }
    scores.set(label, pixels)
  }
  return scores
}

function closedDecision(options: { rejectNext?: boolean; delayMs?: number } = {}) {
  let rejectNext = options.rejectNext ?? false
  let calls = 0
  const decision: DecisionPort = {
    async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      calls++
      if (options.delayMs) await delay(options.delayMs)
      if (rejectNext) {
        rejectNext = false
        throw new ClassifierError('PROVIDER', 'Benchmark fixture rejection')
      }
      if (signal.aborted) throw new ClassifierError('ABORTED', 'Benchmark decision cancelled')
      const question = request.questions.selection
      if (!question || question.type !== 'choice')
        throw new Error('Region fixture expected a closed selection question')
      const labels = Object.keys(question.criteria)
      const scores = labels.every((label) => /^[A-Z]$/.test(label))
        ? await candidateScores(request, labels)
        : geometryScores(request, labels)
      const total = [...scores.values()].reduce((sum, score) => sum + score, 0)
      const present = total > 0
      const probabilities = Object.fromEntries(
        labels.map((label) => [
          label,
          total > 0 ? (scores.get(label) ?? 0) / total : label === 'none' ? 1 : 0,
        ]),
      )
      let choice = labels[0] ?? ''
      for (const label of labels) {
        if ((scores.get(label) ?? 0) > (scores.get(choice) ?? 0)) choice = label
      }
      if (!present && labels.includes('none')) choice = 'none'
      const answers: DecisionResult['answers'] = {
        selection: { type: 'choice', choice, probabilities },
        presence: { type: 'noul', noul: present ? 1 : 0 },
      }
      return {
        answers,
        metadata: {
          model: 'closed-synthetic-fixture',
          provider: 'local',
          requestId: `region-fixture-${calls}`,
          durationMs: 0,
          costUsd: 0,
          attempts: 1,
        },
      }
    },
  }
  return { decision, calls: () => calls }
}

function classifierOptions(
  decision: DecisionPort,
  segmentation: SegmentationPort,
  timeoutMs = 45_000,
): ClassifierOptions & { segmentation: SegmentationPort } {
  return { decision, segmentation, timeoutMs, concurrency: 1, maxQueue: 2 }
}

function classifierInput(image: Uint8Array, signal: AbortSignal): WholeObjectLocateInput {
  return {
    image: new Uint8Array(image),
    target: 'the small red square in the center',
    exclusions: [],
    mode: 'whole-object',
    signal,
  }
}

function directSegmentInput(signal: AbortSignal): SegmentationInput {
  return {
    image: { data: syntheticRgba(), width: sourceWidth, height: sourceHeight, format: 'rgba8' },
    seedRegion: { left: 24, top: 24, width: 8, height: 8 },
    prompt: 'seed-region',
    wholeRegion: { ...fullRegion },
    bounds: {
      left: { start: 0, endExclusive: sourceWidth },
      right: { start: 0, endExclusive: sourceWidth },
      top: { start: 0, endExclusive: sourceHeight },
      bottom: { start: 0, endExclusive: sourceHeight },
    },
    roi: { ...fullRegion },
    target: 'the small red square in the center',
    exclusions: [],
    completeness: 'visible-object',
    signal,
  }
}

function intersects(left: PixelRect, right: PixelRect): boolean {
  return intersectionArea(left, right) > 0
}

function containsPoint(rect: PixelRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.left &&
    point.x < rect.left + rect.width &&
    point.y >= rect.top &&
    point.y < rect.top + rect.height
  )
}

async function oneCycle(
  classifier: Classifier,
  image: Uint8Array,
  operation: 'locate' | 'extract',
  signal = new AbortController().signal,
): Promise<CycleRecord> {
  const started = performance.now()
  try {
    const input = classifierInput(image, signal)
    const result =
      operation === 'locate'
        ? await classifier.locate(input)
        : await classifier.extract(input satisfies ExtractInput)
    const location = 'location' in result ? result.location : result
    const seedRegion = location.status === 'located' ? location.seedRegion : undefined
    const unknownReason = 'reason' in result ? result.reason : undefined
    return {
      operation,
      status: result.status,
      durationMs: Math.max(0, performance.now() - started),
      ...(seedRegion
        ? {
            seedRegion,
            seedIntersectsTarget: intersects(seedRegion, targetRegion),
            seedCenterInsideTarget:
              containsPoint(seedRegion, {
                x: seedRegion.left + seedRegion.width / 2,
                y: seedRegion.top + seedRegion.height / 2,
              }) &&
              containsPoint(targetRegion, {
                x: seedRegion.left + seedRegion.width / 2,
                y: seedRegion.top + seedRegion.height / 2,
              }),
          }
        : {}),
      ...(unknownReason ? { unknownReason } : {}),
      ...(result.status === 'extracted' ? { outputBytes: result.png.byteLength } : {}),
    }
  } catch (error) {
    return {
      operation,
      status: 'failed',
      durationMs: Math.max(0, performance.now() - started),
      errorCode: error instanceof ClassifierError ? error.code : 'UNEXPECTED',
    }
  }
}

async function assetSha(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024)
      throw new Error('Model asset is not a bounded regular file')
    const hash = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function waitForNativeStart(timeoutMs: number): Promise<number> {
  return new Promise((resolvePid, reject) => {
    const timer = setTimeout(() => {
      resourceChannel.unsubscribe(listener)
      reject(new Error('Timed out waiting for owned native child start'))
    }, timeoutMs)
    const listener = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'start' &&
        'pid' in message &&
        typeof message.pid === 'number'
      ) {
        clearTimeout(timer)
        resourceChannel.unsubscribe(listener)
        resolvePid(message.pid)
      }
    }
    resourceChannel.subscribe(listener)
  })
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
      throw error
    }
    await delay(50)
  }
  return false
}

async function abortJoinSmoke(options: CliOptions): Promise<unknown> {
  const segmenter = await createMobileSamSegmenter({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    executionProvider: 'cpu',
    threads: options.threads,
  })
  const controller = new AbortController()
  const start = waitForNativeStart(10_000)
  const pending = segmenter.segment(directSegmentInput(controller.signal)).then(
    () => 'FULFILLED',
    (error: unknown) => (error instanceof ClassifierError ? error.code : 'UNEXPECTED'),
  )
  try {
    const pid = await start
    controller.abort(new ClassifierError('ABORTED', 'Benchmark cancellation'))
    const result = await pending
    await segmenter.settle()
    if (result !== 'ABORTED') throw new Error(`Abort smoke returned ${result}`)
    return { pid, result, settled: true }
  } finally {
    await segmenter.dispose()
  }
}

async function queueAndDisposeSmoke(options: CliOptions): Promise<unknown> {
  const segmenter = await createMobileSamSegmenter({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    executionProvider: 'cpu',
    threads: options.threads,
  })
  const calls = Array.from({ length: 4 }, () =>
    segmenter.segment(directSegmentInput(new AbortController().signal)),
  )
  const settled = await Promise.allSettled(calls)
  const capacity = settled.filter(
    (item) =>
      item.status === 'rejected' &&
      item.reason instanceof ClassifierError &&
      item.reason.code === 'CAPACITY',
  ).length
  const fulfilled = settled.filter((item) => item.status === 'fulfilled').length
  await segmenter.dispose()
  const disposed = await segmenter.segment(directSegmentInput(new AbortController().signal)).then(
    () => 'FULFILLED',
    (error: unknown) => (error instanceof ClassifierError ? error.code : 'UNEXPECTED'),
  )
  if (capacity !== 1 || fulfilled !== 3 || disposed !== 'DISPOSED')
    throw new Error('Native queue/dispose smoke did not meet 1 active + 2 waiting limits')
  return { capacity, fulfilled, disposed }
}

async function runParentLossCoordinator(options: CliOptions): Promise<never> {
  const segmenter = await createMobileSamSegmenter({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    executionProvider: 'cpu',
    threads: options.threads,
  })
  const listener = (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'start' &&
      'pid' in message &&
      typeof message.pid === 'number'
    ) {
      resourceChannel.unsubscribe(listener)
      process.stdout.write(`${message.pid}\n`, () => process.exit(0))
    }
  }
  resourceChannel.subscribe(listener)
  void segmenter.segment(directSegmentInput(new AbortController().signal)).catch(() => undefined)
  await delay(15_000)
  process.exit(2)
}

async function parentLossSmoke(options: CliOptions): Promise<unknown> {
  const scriptPath = fileURLToPath(import.meta.url)
  const coordinator = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      scriptPath,
      '--parentloss-child',
      `--encoder=${options.encoderPath}`,
      `--decoder=${options.decoderPath}`,
      `--source-manifest=${options.sourceManifestPath}`,
      `--source-manifest-sha256=${options.sourceManifestSha256}`,
      `--archive-sha=${options.archiveReferenceSha256}`,
      `--threads=${options.threads}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  coordinator.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  coordinator.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    coordinator.once('error', reject)
    coordinator.once('close', (code) => resolveExit(code))
    const timer = setTimeout(() => {
      coordinator.kill('SIGKILL')
      reject(new Error('Parent-loss coordinator did not exit'))
    }, 20_000)
    coordinator.once('close', () => clearTimeout(timer))
  })
  const pid = Number(stdout.trim())
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error(`Parent-loss coordinator failed: ${stderr.slice(0, 300)}`)
  const exited = await waitForProcessExit(pid, 5000)
  if (exitCode !== 0 || !exited)
    throw new Error('Owned native child survived coordinator parent loss')
  return { coordinatorExitCode: exitCode, nativeChildPid: pid, nativeChildExited: exited }
}

async function lifecycleSmoke(
  options: CliOptions,
  image: Uint8Array,
): Promise<Record<string, unknown>> {
  const abortAndJoin = await abortJoinSmoke(options)
  const queueAndDispose = await queueAndDisposeSmoke(options)
  const parentLoss = await parentLossSmoke(options)

  const rejectDecision = closedDecision({ rejectNext: true })
  const rejectSegmenter = await createMobileSamSegmenter({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    executionProvider: 'cpu',
    threads: options.threads,
  })
  const rejectClassifier = createClassifier(
    classifierOptions(rejectDecision.decision, rejectSegmenter),
  )
  const rejection = await oneCycle(rejectClassifier, image, 'locate')
  await disposeInOrder([() => rejectClassifier.dispose(), () => rejectSegmenter.dispose()])

  const timeoutDecision = closedDecision({ delayMs: 100 })
  const timeoutSegmenter = await createMobileSamSegmenter({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    executionProvider: 'cpu',
    threads: options.threads,
  })
  const timeoutClassifier = createClassifier(
    classifierOptions(timeoutDecision.decision, timeoutSegmenter, 20),
  )
  const timeout = await oneCycle(timeoutClassifier, image, 'locate')
  await disposeInOrder([() => timeoutClassifier.dispose(), () => timeoutSegmenter.dispose()])
  if (rejection.errorCode !== 'PROVIDER')
    throw new Error(`Local decision rejection returned ${rejection.errorCode ?? rejection.status}`)
  if (timeout.errorCode !== 'TIMEOUT')
    throw new Error(`Classifier deadline returned ${timeout.errorCode ?? timeout.status}`)
  return {
    abortAndJoin,
    queueAndDispose,
    parentLoss,
    localDecisionReject: rejection.errorCode ?? rejection.status,
    timeoutCode: timeout.errorCode ?? timeout.status,
    timeoutDecisionCalls: timeoutDecision.calls(),
    providerHttpCalls: 0,
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx')
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
  } finally {
    await file.close()
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(
      'Usage: node --import tsx benchmarks/v02/region-segmentation-resource-soak.ts --encoder=/path --decoder=/path --source-manifest=/path --source-manifest-sha256=<64hex> --archive-sha=<reference-64hex> [--threads=1..4] [--smoke] [--warmup-seconds=600] [--duration-seconds=6540] [--idle-seconds=30] [--sample-ms=5000] [--out=new-report.json]',
    )
    return
  }
  const options = parseOptions(process.argv.slice(2))
  const processStartedAtIso = new Date().toISOString()
  const processStartedMonotonic = performance.now()
  const sourceBefore = await verifySourceManifest(
    options.sourceManifestPath,
    options.sourceManifestSha256,
  )
  if (options.parentLossChild) await runParentLossCoordinator(options)
  if (process.platform !== 'linux')
    throw new Error('This resource harness measures the requested Linux CPU path only')
  const image = await syntheticPng()
  const sourceImageSha256 = createHash('sha256').update(image).digest('hex')
  const assets = {
    encoderSha256: await assetSha(options.encoderPath),
    decoderSha256: await assetSha(options.decoderPath),
  }
  const lifecycle = await lifecycleSmoke(options, image)
  const segmenter = await createMobileSamSegmenter({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    executionProvider: 'cpu',
    threads: options.threads,
  })
  const decision = closedDecision()
  const classifier = createClassifier(classifierOptions(decision.decision, segmenter))
  if (options.smoke) {
    const records = [
      await oneCycle(classifier, image, 'locate'),
      await oneCycle(classifier, image, 'extract'),
    ]
    await disposeInOrder([() => classifier.dispose(), () => segmenter.dispose()])
    const sourceAfter = await verifySourceManifest(
      options.sourceManifestPath,
      options.sourceManifestSha256,
    )
    const acceptance = {
      locatedWithForegroundSeed: records.some(
        (record) =>
          record.operation === 'locate' &&
          record.status === 'located' &&
          record.seedCenterInsideTarget,
      ),
      extractedWithForegroundSeed: records.some(
        (record) =>
          record.operation === 'extract' &&
          record.status === 'extracted' &&
          record.seedCenterInsideTarget,
      ),
    }
    const smokeReport = {
      schemaVersion: 1,
      benchmark: 'public-mobile-sam-region-segmentation-smoke-v1',
      workflow: 'region-segmentation',
      executionSource: 'working-tree',
      sourceManifest: { before: sourceBefore, after: sourceAfter },
      archiveReferenceSha256: options.archiveReferenceSha256,
      archiveInstalledByHarness: false,
      platform: { node: process.version, platform: process.platform, arch: process.arch },
      assets,
      lifecycle,
      results: records,
      acceptance,
      fixture: {
        description:
          '256x256 source; red 16x16 square centered at (32,32), inside the selected grid seed cell.',
        targetRegion,
        sourceSha256: sourceImageSha256,
        decisionCalls: decision.calls(),
        providerHttpCalls: 0,
      },
    }
    if (options.outputPath) await writeJson(options.outputPath, smokeReport)
    else process.stdout.write(`${JSON.stringify(smokeReport, null, 2)}\n`)
    if (!acceptance.locatedWithForegroundSeed || !acceptance.extractedWithForegroundSeed)
      throw new Error('Smoke did not locate and extract with an actual foreground-interior seed')
    return
  }

  const controller = new AbortController()
  const onInterrupt = () => controller.abort(new ClassifierError('ABORTED', 'Soak interrupted'))
  process.once('SIGINT', onInterrupt)
  const warmupStartedAt = new Date().toISOString()
  const warmupStartedMonotonic = performance.now()
  const warmup: CycleRecord[] = []
  let warmupDurationMs = 0
  let warmupObservedMs = 0
  let measurementStartedMonotonic = 0
  let idleBeforeDurationMs = 0
  let busyDurationMs = 0
  let idleAfterDurationMs = 0
  let busyStartedAt = ''
  let busyStartedMonotonic = 0
  let idleAfterStartedAt = ''
  let resources: ResourceRunner | undefined
  let resourceReport: ResourceReport | undefined
  let phaseFailure: unknown
  const cleanupFailures: unknown[] = []
  const records: CycleRecord[] = []
  let measurementStartedAt = ''
  try {
    warmupDurationMs = await runMonotonicPhase(
      options.warmupSeconds * 1000,
      async () => {
        const operation = warmup.length % 2 === 0 ? 'locate' : 'extract'
        warmup.push(await oneCycle(classifier, image, operation, controller.signal))
      },
      { shouldStop: () => controller.signal.aborted },
    )
    warmupObservedMs = performance.now() - warmupStartedMonotonic
    resources = new ResourceRunner(options.sampleMs)
    resources.start()
    measurementStartedMonotonic = performance.now()
    measurementStartedAt = new Date().toISOString()
    const idleBeforeStartedMonotonic = performance.now()
    await delay(options.idleSeconds * 1000, undefined, { signal: controller.signal }).catch(
      () => undefined,
    )
    idleBeforeDurationMs = performance.now() - idleBeforeStartedMonotonic
    resources.setPhase('busy')
    busyStartedAt = new Date().toISOString()
    busyStartedMonotonic = performance.now()
    let nextProgressAt = 5 * 60 * 1000
    busyDurationMs = await runMonotonicPhase(
      options.durationSeconds * 1000,
      async () => {
        const operation = records.length % 2 === 0 ? 'locate' : 'extract'
        records.push(await oneCycle(classifier, image, operation, controller.signal))
        const busyElapsedMs = performance.now() - busyStartedMonotonic
        if (busyElapsedMs >= nextProgressAt) {
          console.error(
            `region-segmentation soak: ${Math.floor(busyElapsedMs / 60_000)} busy minutes, ${records.length} operations`,
          )
          nextProgressAt += 5 * 60 * 1000
        }
      },
      { shouldStop: () => controller.signal.aborted },
    )
    resources.setPhase('idle-after')
    idleAfterStartedAt = new Date().toISOString()
    const idleAfterStartedMonotonic = performance.now()
    await delay(options.idleSeconds * 1000, undefined, { signal: controller.signal }).catch(
      () => undefined,
    )
    idleAfterDurationMs = performance.now() - idleAfterStartedMonotonic
  } catch (error) {
    phaseFailure = error
  } finally {
    process.off('SIGINT', onInterrupt)
    try {
      await disposeInOrder([() => classifier.dispose(), () => segmenter.dispose()])
    } catch (error) {
      cleanupFailures.push(error)
    }
    await delay(25)
    if (resources) {
      try {
        resourceReport = resources.stop()
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
  }
  if (phaseFailure !== undefined || cleanupFailures.length > 0) {
    console.error(
      JSON.stringify({
        soakFailure: phaseFailure instanceof Error ? phaseFailure.message : phaseFailure,
        cleanupFailures: cleanupFailures.map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
      }),
    )
    throw phaseFailure ?? new AggregateError(cleanupFailures, 'Resource soak cleanup failed')
  }
  if (!resourceReport || measurementStartedMonotonic === 0)
    throw new Error('Resource soak phases did not initialize monitoring')
  const measurementObservedMs = performance.now() - measurementStartedMonotonic
  if (
    resourceReport.childStarts !== resourceReport.childCloses ||
    resourceReport.childrenStillOwned.length > 0
  )
    throw new Error('Resource sampling found native children still owned or missing close events')
  const sourceAfter = await verifySourceManifest(
    options.sourceManifestPath,
    options.sourceManifestSha256,
  )
  const endedAt = new Date().toISOString()
  const totalObservedMs = performance.now() - processStartedMonotonic
  const requestedDurationsMs = {
    warmup: options.warmupSeconds * 1000,
    idleBefore: options.idleSeconds * 1000,
    busy: options.durationSeconds * 1000,
    idleAfter: options.idleSeconds * 1000,
  }
  const durationValidation = {
    warmupReachedDeadline:
      warmupDurationMs >= requestedDurationsMs.warmup &&
      warmupObservedMs >= requestedDurationsMs.warmup,
    idleBeforeReachedDeadline: idleBeforeDurationMs >= requestedDurationsMs.idleBefore,
    busyReachedDeadline: busyDurationMs >= requestedDurationsMs.busy,
    idleAfterReachedDeadline: idleAfterDurationMs >= requestedDurationsMs.idleAfter,
    measurementReachedRequested:
      measurementObservedMs >=
      requestedDurationsMs.idleBefore + requestedDurationsMs.busy + requestedDurationsMs.idleAfter,
    totalObservedReachedRequested:
      totalObservedMs >= Object.values(requestedDurationsMs).reduce((a, b) => a + b, 0),
    sourceManifestUnchanged:
      sourceBefore.revision === sourceAfter.revision &&
      sourceBefore.manifestSha256 === sourceAfter.manifestSha256 &&
      sourceBefore.sourceFileCount === sourceAfter.sourceFileCount,
    noOwnedChildrenRemain: resourceReport.childrenStillOwned.length === 0,
    allOwnedChildrenClosed: resourceReport.childStarts === resourceReport.childCloses,
  }
  const allDurationChecksPassed = Object.values(durationValidation).every(Boolean)
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    benchmark: 'public-mobile-sam-region-segmentation-resource-v1',
    workflow: 'region-segmentation',
    executionSource: 'working-tree',
    sourceProof: {
      before: sourceBefore,
      after: sourceAfter,
      unchanged: durationValidation.sourceManifestUnchanged,
    },
    archiveReferenceSha256: options.archiveReferenceSha256,
    archiveInstalledByHarness: false,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sourceImageSha256,
      ...assets,
    },
    configuration: {
      warmupSeconds: options.warmupSeconds,
      durationSeconds: options.durationSeconds,
      idleSeconds: options.idleSeconds,
      sampleMs: options.sampleMs,
      forcedGc: false,
      retainedSdkAndSegmenter: true,
      classifierTimeoutMs: 45_000,
      maxPixels: 2_097_152,
      nativeThreads: options.threads,
      prompt: 'seed-region on full oriented source image',
      targetRegion,
      clock: 'node:perf_hooks performance.now (monotonic); ISO timestamps are metadata only',
    },
    timestamps: {
      processStartedAt: processStartedAtIso,
      warmupStartedAt,
      measurementStartedAt,
      busyStartedAt,
      idleAfterStartedAt,
      endedAt,
    },
    monotonicDurationsMs: {
      processObservedMs: totalObservedMs,
      measurementObservedMs,
      warmupMs: warmupDurationMs,
      measurementMs: resourceReport.observedDurationMs,
      warmupObservedMs,
      idleBeforeMs: idleBeforeDurationMs,
      busyMs: busyDurationMs,
      idleAfterMs: idleAfterDurationMs,
      requestedTotalMs: Object.values(requestedDurationsMs).reduce((a, b) => a + b, 0),
      resourcePhaseTransitions: resourceReport.phaseTransitions,
    },
    durationValidation,
    durationAccepted: allDurationChecksPassed,
    lifecycle,
    warmup: { count: warmup.length, records: warmup },
    results: {
      operationCount: records.length,
      locateCount: records.filter((record) => record.operation === 'locate').length,
      extractCount: records.filter((record) => record.operation === 'extract').length,
      located: records.filter(
        (record) => record.operation === 'locate' && record.status === 'located',
      ).length,
      extracted: records.filter((record) => record.status === 'extracted').length,
      extractedWithForegroundSeed: records.filter(
        (record) => record.status === 'extracted' && record.seedCenterInsideTarget === true,
      ).length,
      seedCenterInsideTarget: records.filter((record) => record.seedCenterInsideTarget === true)
        .length,
      unknown: records.filter((record) => record.status === 'unknown').length,
      unknownByReason: Object.fromEntries(
        [
          ...new Set(
            records.filter((record) => record.unknownReason).map((record) => record.unknownReason!),
          ),
        ].map((reason) => [
          reason,
          records.filter((record) => record.unknownReason === reason).length,
        ]),
      ),
      failed: records.filter((record) => record.status === 'failed').length,
      timeouts: records.filter((record) => record.errorCode === 'TIMEOUT').length,
      durationP50Ms: percentile(
        records.map((record) => record.durationMs),
        0.5,
      ),
      durationP95Ms: percentile(
        records.map((record) => record.durationMs),
        0.95,
      ),
      records,
    },
    fixture: {
      description:
        'A deterministic 256x256 scene with one 16x16 red square centered at (32,32); each original region-search choice is selected from supplied source geometry, and the final candidate from its PNG pixels.',
      sourceSha256: sourceImageSha256,
      targetRegion,
      providerHttpCalls: 0,
      decisionCalls: decision.calls(),
    },
    resources: resourceReport,
  }
  await writeJson(options.outputPath!, report)
  if (!allDurationChecksPassed) {
    console.error('Resource soak did not meet every monotonic duration/source/cleanup check')
    process.exitCode = 1
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)] ?? null
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Region segmentation resource harness failed',
    )
    process.exitCode = 1
  })
}
