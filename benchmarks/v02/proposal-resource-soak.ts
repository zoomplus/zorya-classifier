import { channel } from 'node:diagnostics_channel'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'

import { createClassifier, type Classifier, type ClassifierOptions } from '../../src/index.js'
import { ClassifierError } from '../../src/entities/errors.js'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  PixelRect,
} from '../../src/entities/contracts.js'
import type { ObjectProposalPort } from '../../src/entities/object-proposals.js'
import type { ExtractInput } from '../../src/entities/segmentation.js'
import type { WholeObjectLocateInput } from '../../src/entities/whole-object.js'
import { createMobileSamObjectProposals } from '../../src/infrastructure/segmentation/mobile-sam/index.js'
import { ResourceRunner, runMonotonicPhase, type ResourceReport } from './resource-runner.js'

interface CliOptions {
  encoderPath: string
  decoderPath: string
  sourceManifestPath: string
  sourceManifestSha256: string
  archiveReferenceSha256: string
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
  unknownReason?: string
  errorCode?: string
  outputBytes?: number
}

const resourceChannel = channel('zorya.segmentation.child-resource')
const sourceWidth = 256
const sourceHeight = 256
const targetRegion: PixelRect = { left: 8, top: 8, width: 48, height: 48 }

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
  return {
    encoderPath: resolve(encoderPath),
    decoderPath: resolve(decoderPath),
    sourceManifestPath: resolve(sourceManifestPath),
    sourceManifestSha256,
    archiveReferenceSha256,
    ...(outputPath ? { outputPath: resolve(outputPath) } : {}),
    warmupSeconds: integerOption('warmup-seconds', smoke ? 0 : 600, 0),
    durationSeconds: integerOption('duration-seconds', smoke ? 1 : 6540, 1),
    idleSeconds: integerOption('idle-seconds', smoke ? 1 : 30, 1),
    sampleMs: integerOption('sample-ms', 5000, 250),
    smoke,
    parentLossChild,
  }
}

function syntheticRgba() {
  const data = new Uint8Array(sourceWidth * sourceHeight * 4)
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      const offset = (y * sourceWidth + x) * 4
      const foreground =
        x >= targetRegion.left &&
        x < targetRegion.left + targetRegion.width &&
        y >= targetRegion.top &&
        y < targetRegion.top + targetRegion.height
      data[offset] = foreground ? 226 : 228
      data[offset + 1] = foreground ? 36 : 228
      data[offset + 2] = foreground ? 42 : 228
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

interface SourceManifest {
  revision: string
  files: Record<string, string>
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
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('revision' in parsed) ||
    typeof parsed.revision !== 'string' ||
    !('files' in parsed) ||
    typeof parsed.files !== 'object' ||
    parsed.files === null ||
    Array.isArray(parsed.files)
  )
    throw new Error('Source manifest must contain revision and files mapping')
  const manifest = parsed as SourceManifest
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const required = [
    ...(await listSourceFiles(resolve(projectRoot, 'src'))),
    resolve(projectRoot, 'benchmarks/v02/proposal-resource-soak.ts'),
    resolve(projectRoot, 'benchmarks/v02/resource-runner.ts'),
  ]
  const requiredRelative = required.map((file) => relative(projectRoot, file).split(sep).join('/'))
  const entries = Object.entries(manifest.files)
  if (requiredRelative.some((file) => !(file in manifest.files)))
    throw new Error('Source manifest omits one or more runtime source files')
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
      const answers: DecisionResult['answers'] = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') {
          answers[id] = { type: 'noul', noul: 1 }
        } else {
          const choices = Object.keys(question.criteria)
          if (!choices.length) throw new Error('Fixture received a choice question with no choices')
          const marker = request.state.indexOf('CANDIDATE MASK CONTACT SHEETS')
          const imageParts =
            marker < 0
              ? []
              : request.state
                  .slice(marker + 1)
                  .filter(
                    (
                      part,
                    ): part is Extract<(typeof request.state)[number], { type: 'image_url' }> =>
                      typeof part === 'object' && part !== null && part.type === 'image_url',
                  )
          let selected = choices[0]!
          if (marker >= 0) {
            const scores = await scorePresentedForeground(imageParts)
            const winner = choices
              .filter((choice) => /^C\d{2}$/.test(choice))
              .map((choice) => ({ choice, score: scores.get(choice) ?? 0 }))
              .sort(
                (left, right) =>
                  right.score - left.score || left.choice.localeCompare(right.choice),
              )[0]
            selected =
              winner && winner.score > 0
                ? winner.choice
                : choices.includes('none')
                  ? 'none'
                  : selected
          } else if (choices.includes('C00')) {
            selected = 'C00'
          }
          answers[id] = {
            type: 'choice',
            choice: selected,
            probabilities: Object.fromEntries(
              choices.map((choice) => [choice, choice === selected ? 1 : 0]),
            ),
          }
        }
      }
      return {
        answers,
        metadata: {
          model: null,
          provider: null,
          requestId: null,
          durationMs: 0,
          costUsd: 0,
          attempts: 1,
        },
      }
    },
  }
  return { decision, calls: () => calls }
}

async function scorePresentedForeground(
  parts: readonly { type: 'image_url'; image_url: { url: string; detail: 'high' } }[],
): Promise<Map<string, number>> {
  const scores = new Map<string, number>()
  for (const part of parts) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url.url)
    if (!match) continue
    const decoded = await sharp(Buffer.from(match[1]!, 'base64'), { limitInputPixels: 1_000_000 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (decoded.info.width !== 1200 || decoded.info.height !== 720 || decoded.info.channels !== 4)
      continue
    const pixels = decoded.data
    for (let local = 0; local < 12; local++) {
      const candidateIndex = scores.size
      const tileX = (local % 4) * 300
      const tileY = Math.floor(local / 4) * 240
      let foregroundPixels = 0
      for (let y = tileY + 28; y < tileY + 228; y++) {
        for (let x = tileX + 154; x < tileX + 296; x++) {
          const offset = (y * 1200 + x) * 4
          if (
            pixels[offset]! > 150 &&
            pixels[offset + 1]! < 100 &&
            pixels[offset + 2]! < 110 &&
            pixels[offset + 3]! > 0
          )
            foregroundPixels++
        }
      }
      scores.set(`C${candidateIndex.toString().padStart(2, '0')}`, foregroundPixels)
    }
  }
  return scores
}

function classifierOptions(
  decision: DecisionPort,
  objectProposals: ObjectProposalPort,
  timeoutMs = 45_000,
): ClassifierOptions & { objectProposals: ObjectProposalPort } {
  return { decision, objectProposals, timeoutMs, concurrency: 1, maxQueue: 2 }
}

function classifierInput(image: Uint8Array, signal: AbortSignal): WholeObjectLocateInput {
  return {
    image: new Uint8Array(image),
    target: 'the red square in the first cell',
    exclusions: [],
    mode: 'whole-object',
    signal,
  }
}

function seedIntersectsTarget(seed: PixelRect): boolean {
  return (
    seed.left < targetRegion.left + targetRegion.width &&
    seed.left + seed.width > targetRegion.left &&
    seed.top < targetRegion.top + targetRegion.height &&
    seed.top + seed.height > targetRegion.top
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
    const result =
      operation === 'locate'
        ? await classifier.locate(classifierInput(image, signal))
        : await classifier.extract(classifierInput(image, signal) satisfies ExtractInput)
    const location = 'location' in result ? result.location : result
    const seedRegion = location.status === 'located' ? location.seedRegion : undefined
    const unknownReason = 'reason' in result ? result.reason : undefined
    return {
      operation,
      status: result.status,
      durationMs: Math.max(0, performance.now() - started),
      ...(seedRegion ? { seedRegion, seedIntersectsTarget: seedIntersectsTarget(seedRegion) } : {}),
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

async function abortJoinSmoke(options: CliOptions): Promise<unknown> {
  const adapter = await createMobileSamObjectProposals({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    threads: 1,
  })
  const controller = new AbortController()
  const start = waitForNativeStart(10_000)
  const pending = adapter
    .propose({
      image: { data: syntheticRgba(), width: sourceWidth, height: sourceHeight, format: 'rgba8' },
      seedRegion: { left: 0, top: 0, width: 64, height: 64 },
      roi: { left: 0, top: 0, width: sourceWidth, height: sourceHeight },
      signal: controller.signal,
    })
    .then(
      () => 'FULFILLED',
      (error: unknown) => (error instanceof ClassifierError ? error.code : 'UNEXPECTED'),
    )
  try {
    const pid = await start
    controller.abort(new ClassifierError('ABORTED', 'Benchmark cancellation'))
    const result = await pending
    await adapter.settle()
    if (result !== 'ABORTED') throw new Error(`Abort smoke returned ${result}`)
    return { pid, result, settled: true }
  } finally {
    await adapter.dispose()
  }
}

async function queueAndDisposeSmoke(options: CliOptions): Promise<unknown> {
  const adapter = await createMobileSamObjectProposals({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    threads: 1,
  })
  const input = {
    image: {
      data: syntheticRgba(),
      width: sourceWidth,
      height: sourceHeight,
      format: 'rgba8' as const,
    },
    seedRegion: { left: 0, top: 0, width: 64, height: 64 },
    roi: { left: 0, top: 0, width: sourceWidth, height: sourceHeight },
    signal: new AbortController().signal,
  }
  const calls = Array.from({ length: 4 }, () => adapter.propose(input))
  const settled = await Promise.allSettled(calls)
  const capacity = settled.filter(
    (item) =>
      item.status === 'rejected' &&
      item.reason instanceof ClassifierError &&
      item.reason.code === 'CAPACITY',
  ).length
  const fulfilled = settled.filter((item) => item.status === 'fulfilled').length
  await adapter.dispose()
  const disposed = await adapter.propose(input).then(
    () => 'FULFILLED',
    (error: unknown) => (error instanceof ClassifierError ? error.code : 'UNEXPECTED'),
  )
  if (capacity !== 1 || fulfilled !== 3 || disposed !== 'DISPOSED')
    throw new Error('Native proposal queue/dispose smoke did not meet 1 active + 2 waiting limits')
  return { capacity, fulfilled, disposed }
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    await delay(50)
  }
  return false
}

async function runParentLossCoordinator(options: CliOptions): Promise<never> {
  const adapter = await createMobileSamObjectProposals({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    threads: 1,
  })
  const input = {
    image: {
      data: syntheticRgba(),
      width: sourceWidth,
      height: sourceHeight,
      format: 'rgba8' as const,
    },
    seedRegion: { left: 0, top: 0, width: 64, height: 64 },
    roi: { left: 0, top: 0, width: sourceWidth, height: sourceHeight },
    signal: new AbortController().signal,
  }
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
  void adapter.propose(input).catch(() => undefined)
  await delay(15_000)
  process.exit(2)
}

async function lifecycleSmoke(
  options: CliOptions,
  image: Uint8Array,
): Promise<Record<string, unknown>> {
  const abort = await abortJoinSmoke(options)
  const queue = await queueAndDisposeSmoke(options)
  const parentLoss = await parentLossSmoke(options)
  const decisionFixture = closedDecision({ rejectNext: true })
  const adapter = await createMobileSamObjectProposals({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    threads: 1,
  })
  const classifier = createClassifier(classifierOptions(decisionFixture.decision, adapter))
  const rejection = await oneCycle(classifier, image, 'locate')
  await classifier.dispose()
  await adapter.dispose()

  const timeoutDecision = closedDecision({ delayMs: 100 })
  const timeoutAdapter = await createMobileSamObjectProposals({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    threads: 1,
  })
  const timeoutClassifier = createClassifier(
    classifierOptions(timeoutDecision.decision, timeoutAdapter, 20),
  )
  const timeout = await oneCycle(timeoutClassifier, image, 'locate')
  await timeoutClassifier.dispose()
  await timeoutAdapter.dispose()
  if (rejection.errorCode !== 'PROVIDER')
    throw new Error(
      `Local decision rejection smoke returned ${rejection.errorCode ?? rejection.status}`,
    )
  if (timeout.errorCode !== 'TIMEOUT')
    throw new Error(`Classifier deadline smoke returned ${timeout.errorCode ?? timeout.status}`)
  return {
    abortAndJoin: abort,
    queueAndDispose: queue,
    parentLoss,
    localDecisionReject: rejection.errorCode ?? rejection.status,
    timeoutCode: timeout.errorCode ?? timeout.status,
    timeoutDecisionCalls: timeoutDecision.calls(),
    noProviderHttp: true,
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(
      'Usage: node --import tsx benchmarks/v02/proposal-resource-soak.ts --encoder=/path --decoder=/path --source-manifest=/path --source-manifest-sha256=<64hex> --archive-sha=<reference-64hex> [--smoke] [--warmup-seconds=600] [--duration-seconds=6540] [--idle-seconds=30] [--sample-ms=5000] [--out=new-report.json]',
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
  const adapter = await createMobileSamObjectProposals({
    encoderPath: options.encoderPath,
    decoderPath: options.decoderPath,
    threads: 1,
  })
  const decisionFixture = closedDecision()
  const classifier = createClassifier(classifierOptions(decisionFixture.decision, adapter))
  if (options.smoke) {
    const records = [
      await oneCycle(classifier, image, 'locate'),
      await oneCycle(classifier, image, 'extract'),
    ]
    await classifier.dispose()
    await adapter.dispose()
    const sourceAfter = await verifySourceManifest(
      options.sourceManifestPath,
      options.sourceManifestSha256,
    )
    const acceptance = {
      located: records.some(
        (record) => record.operation === 'locate' && record.status === 'located',
      ),
      extracted: records.some(
        (record) => record.operation === 'extract' && record.status === 'extracted',
      ),
    }
    const smokeReport = {
      schemaVersion: 1,
      benchmark: 'public-mobile-sam-object-proposal-smoke-v1',
      executionSource: 'working-tree',
      sourceManifest: { before: sourceBefore, after: sourceAfter },
      archiveReferenceSha256: options.archiveReferenceSha256,
      archiveInstalledByHarness: false,
      platform: { node: process.version, platform: process.platform, arch: process.arch },
      lifecycle,
      results: records,
      acceptance,
      fixture: { targetRegion, providerHttpCalls: 0, selectionUsesPresentedTargetPixelsOnly: true },
    }
    const json = `${JSON.stringify(smokeReport, null, 2)}\n`
    if (options.outputPath) {
      const output = await open(options.outputPath, 'wx')
      try {
        await output.writeFile(json)
      } finally {
        await output.close()
      }
    } else process.stdout.write(json)
    if (!acceptance.located || !acceptance.extracted)
      throw new Error('Diagnostic smoke did not produce both a located and an extracted result')
    return
  }
  const warmupStartedAt = new Date().toISOString()
  const warmupStartedMonotonic = performance.now()
  const warmup: CycleRecord[] = []
  const warmupDurationMs = await runMonotonicPhase(options.warmupSeconds * 1000, async () => {
    const operation = warmup.length % 2 === 0 ? 'locate' : 'extract'
    warmup.push(await oneCycle(classifier, image, operation))
  })
  const warmupObservedMs = performance.now() - warmupStartedMonotonic

  const resources = new ResourceRunner(options.sampleMs)
  resources.start()
  const measurementStartedMonotonic = performance.now()
  const controller = new AbortController()
  const onInterrupt = () => controller.abort(new ClassifierError('ABORTED', 'Soak interrupted'))
  process.once('SIGINT', onInterrupt)
  const records: CycleRecord[] = []
  const runStartedAt = new Date().toISOString()
  const idleBeforeStartedMonotonic = performance.now()
  let idleBeforeDurationMs = 0
  let busyDurationMs = 0
  let idleAfterDurationMs = 0
  let busyStartedAt = ''
  let busyStartedMonotonic = 0
  let idleAfterStartedAt = ''
  try {
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
            `proposal resource soak: ${Math.floor(busyElapsedMs / 60_000)} busy minutes, ${records.length} operations`,
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
  } finally {
    process.off('SIGINT', onInterrupt)
    await classifier.dispose()
    await adapter.dispose()
    await delay(25)
  }
  const resourceReport: ResourceReport = resources.stop()
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
  const phaseDurationValidation = {
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
  }
  const sourceProof = {
    before: sourceBefore,
    after: sourceAfter,
    unchanged:
      sourceBefore.revision === sourceAfter.revision &&
      sourceBefore.manifestSha256 === sourceAfter.manifestSha256 &&
      sourceBefore.sourceFileCount === sourceAfter.sourceFileCount,
  }
  const durationValidation = {
    ...phaseDurationValidation,
    sourceManifestUnchanged: sourceProof.unchanged,
    noOwnedChildrenRemain: resourceReport.childrenStillOwned.length === 0,
    allOwnedChildrenClosed: resourceReport.childStarts === resourceReport.childCloses,
  }
  const allDurationChecksPassed = Object.values(durationValidation).every(Boolean)
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    benchmark: 'public-mobile-sam-object-proposal-resource-v1',
    executionSource: 'working-tree',
    sourceProof,
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
      retainedSdkAndProposalAdapter: true,
      classifierTimeoutMs: 45_000,
      maxPixels: 2_097_152,
      seedCell: 'C00',
      targetRegion,
      clock: 'node:perf_hooks performance.now (monotonic); ISO timestamps are metadata only',
    },
    timestamps: {
      processStartedAt: processStartedAtIso,
      warmupStartedAt,
      measurementStartedAt: runStartedAt,
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
      extracted: records.filter((record) => record.status === 'extracted').length,
      extractedWithSeedIntersectingTarget: records.filter(
        (record) => record.status === 'extracted' && record.seedIntersectsTarget === true,
      ).length,
      extractedWithInvalidFixtureSeed: records.filter(
        (record) => record.status === 'extracted' && record.seedIntersectsTarget === false,
      ).length,
      located: records.filter((record) => record.status === 'located').length,
      notFound: records.filter((record) => record.status === 'not-found').length,
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
      seedMisses: records.filter((record) => record.seedIntersectsTarget === false).length,
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
        'Deterministic 256x256 synthetic source; red target occupies the top-left first cell.',
      providerHttpCalls: 0,
      sourceSha256: sourceImageSha256,
      targetRegion,
    },
    resources: resourceReport,
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (options.outputPath) {
    const output = await open(options.outputPath, 'wx')
    try {
      await output.writeFile(json)
    } finally {
      await output.close()
    }
  } else {
    process.stdout.write(json)
  }
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
    console.error(error instanceof Error ? error.message : 'Proposal resource harness failed')
    process.exitCode = 1
  })
}
