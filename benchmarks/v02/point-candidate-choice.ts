import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  ImagePart,
} from '../../src/entities/contracts.js'
import { limits } from '../../src/entities/contracts.js'
import { ClassifierError } from '../../src/entities/errors.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import { RunBudget } from './budget.js'
import type { PhysicalCallRecord, Recorder } from './recording.js'
import { recordProvider } from './recording.js'
import { hashCanonical } from './protocol.js'

const envFile = '/root/work/element/.env.local'
const route = Object.freeze({
  id: 'openai-gpt-6-luna-native-decisions-v1',
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false as const,
})
export const pointCandidatePolicy = Object.freeze({
  timeoutMs: 45_000,
  retries: 0,
  fallback: false,
  maxPhysicalCalls: 24,
  maxCostUsd: 2,
  unknownCostReserveUsd: 0.02,
  maximumImageBytes: 16 * 1024 * 1024,
  maximumImagePixels: limits.imagePixels,
  latencyEnvironment: 'candidate-selection-development-unranked',
  latencyRankingEligible: false,
})

export interface PointCandidateManifestPin {
  path: string
  sha256: string
}
export interface PointCandidateRunnerOptions {
  contactSheetManifests: PointCandidateManifestPin[]
  inputManifests: PointCandidateManifestPin[]
  imageRoot: string
  outputRoot: string
  apiKey: string
  fetch?: typeof globalThis.fetch
  /** Offline fixture only. */
  createDecision?: (fetcher: typeof globalThis.fetch) => DecisionPort
  minimumCases?: number
  maximumCases?: number
}

const choiceAlias = z.string().regex(/^C(?:0[0-9]|[12][0-9]|3[0-5])$/u)
const publicPresentationSchema = z
  .object({
    choiceIds: z
      .array(z.union([z.literal('none'), choiceAlias]))
      .min(2)
      .max(37),
    originalImagePath: z.string().min(1).max(2048),
    sheets: z
      .array(z.object({ path: z.string().min(1).max(2048) }).passthrough())
      .min(1)
      .max(3),
  })
  .passthrough()
const localCaseSchema = z
  .object({
    caseAlias: z.string().regex(/^case-[0-9]{2}$/u),
    presentation: publicPresentationSchema,
    internal: z.object({ caseId: z.string().min(1).max(128) }).passthrough(),
  })
  .passthrough()
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: z.array(z.unknown()).min(1).max(5),
  })
  .passthrough()

interface ImageDescriptor {
  file: string
  role: 'original' | 'contact-sheet'
  sha256: string
  width: number
  height: number
  bytes: number
}
interface CandidateCase {
  caseKey: string
  choiceIds: string[]
  target: string
  imageRoot: string
  imageDescriptors: ImageDescriptor[]
}
interface CandidateOutcome {
  caseKey: string
  status: 'complete' | 'failed'
  choice: null | {
    selected: string
    nativeChoice: string
    probabilities: Record<string, number>
    receiptCostUsd: number | null
  }
  wholeTarget: null | { score: number; receiptCostUsd: number | null }
  errorCode?: string
  physicalCalls: number
  requestHashes: string[]
}

const candidateQuestion = Object.freeze({
  id: 'selection',
  taskInstructions:
    'Choose exactly one supplied candidate alias for the entire visible target instance. Compare the candidate overlays and cutouts with the original image. A fragment, background, or different instance is not the whole target. Choose none if no mask covers the full target. Do not invent coordinates or aliases.',
  optionDescription:
    'Select this candidate only if the displayed mask covers the entire visible target instance in the original image; reject fragments, background, and other instances.',
  noneDescription: 'No candidate mask covers the entire visible target instance.',
})

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function immutable(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function hashSources(): Promise<Record<string, string>> {
  const files = [
    './point-candidate-choice.ts',
    './run-point-candidate-choice.ts',
    './recording.ts',
    './budget.ts',
    './protocol.ts',
  ] as const
  const bench = await Promise.all(
    files.map(
      async (path) => [path, sha256(await readFile(new URL(path, import.meta.url)))] as const,
    ),
  )
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url))
  async function walk(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const path = resolve(directory, entry.name)
          return entry.isDirectory()
            ? walk(path)
            : entry.isFile() && entry.name.endsWith('.ts')
              ? [path]
              : []
        }),
      )
    ).flat()
  }
  const paths = (await walk(srcRoot)).sort()
  const src = await Promise.all(
    paths.map(
      async (path) =>
        [
          `src/${relative(srcRoot, path).split(sep).join('/')}`,
          sha256(await readFile(path)),
        ] as const,
    ),
  )
  return Object.fromEntries([...bench, ...src])
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

function safeTask(target: string, forbidden: readonly string[]): string {
  const text = `Target: ${target}`
  if (forbidden.some((value) => value.length > 0 && text.includes(value)))
    throw new ClassifierError('INVALID_INPUT', 'Target text contains controller-only metadata')
  return text
}

async function boundedImage(
  file: string,
  root: string,
): Promise<{ bytes: Buffer; descriptor: ImageDescriptor }> {
  const resolvedRoot = await realpath(root)
  const resolvedPath = await realpath(file)
  const rel = relative(resolvedRoot, resolvedPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new ClassifierError('INVALID_INPUT', 'Presentation image escaped its pinned root')
  const handle = await open(resolvedPath, 'r')
  let bytes: Buffer | undefined
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > pointCandidatePolicy.maximumImageBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'Presentation image exceeds its byte budget')
    bytes = Buffer.alloc(before.size + 1)
    let bytesRead = 0
    while (bytesRead < bytes.byteLength) {
      const read = await handle.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead)
      if (read.bytesRead === 0) break
      bytesRead += read.bytesRead
    }
    const after = await handle.stat()
    if (bytesRead !== before.size || after.size !== before.size)
      throw new ClassifierError('INVALID_INPUT', 'Presentation image changed while being read')
    const image = bytes.subarray(0, bytesRead)
    const decoder = sharp(image, {
      limitInputPixels: pointCandidatePolicy.maximumImagePixels,
      failOn: 'error',
    })
    try {
      const metadata = await decoder.metadata()
      if (
        metadata.format !== 'png' ||
        (metadata.pages ?? 1) !== 1 ||
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > pointCandidatePolicy.maximumImagePixels
      )
        throw new ClassifierError('INVALID_INPUT', 'Expected one bounded PNG presentation image')
      return {
        bytes: image,
        descriptor: {
          file: rel.split(sep).join('/'),
          role: basename(file) === 'original.png' ? 'original' : 'contact-sheet',
          sha256: sha256(image),
          width: metadata.width,
          height: metadata.height,
          bytes: image.byteLength,
        },
      }
    } finally {
      decoder.destroy()
    }
  } catch (error) {
    bytes?.fill(0)
    throw error
  } finally {
    await handle.close()
  }
}

async function readPinnedManifest(pin: PointCandidateManifestPin) {
  const handle = await open(pin.path, 'r')
  let bytes: Buffer | undefined
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > 2 * 1024 * 1024)
      throw new ClassifierError('RESOURCE_LIMIT', 'Contact sheet manifest exceeds its byte budget')
    bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || after.size !== before.size)
      throw new ClassifierError('INVALID_INPUT', 'Contact sheet manifest changed while being read')
    const payload = bytes.subarray(0, offset)
    if (sha256(payload) !== pin.sha256)
      throw new ClassifierError('INVALID_INPUT', 'Contact sheet manifest hash mismatch')
    return manifestSchema.parse(JSON.parse(payload.toString('utf8')))
  } finally {
    bytes?.fill(0)
    await handle.close()
  }
}

function dataImage(bytes: Uint8Array): ImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      detail: 'high',
    },
  }
}

function choiceRequest(
  targetText: string,
  ids: readonly string[],
  images: readonly Uint8Array[],
): DecisionRequest {
  const criteria = Object.fromEntries(
    ids.map((id) => [
      id,
      id === 'none'
        ? candidateQuestion.noneDescription
        : `Candidate ${id}: ${candidateQuestion.optionDescription}`,
    ]),
  )
  return {
    state: [candidateQuestion.taskInstructions, targetText, ...images.map(dataImage)],
    questions: {
      selection: {
        type: 'choice',
        instructions: candidateQuestion.taskInstructions,
        criteria,
      },
    },
  }
}

function wholeTargetRequest(
  targetText: string,
  selected: string,
  images: readonly Uint8Array[],
): DecisionRequest {
  return {
    state: [
      'Judge the selected candidate against the whole target in the original image.',
      targetText,
      `The model selected ${selected}. The candidate image shows this mask and its cutout.`,
      ...images.map(dataImage),
    ],
    questions: {
      presence: {
        type: 'noul',
        instructions:
          'How likely is it that the selected mask covers the entire visible target instance? Score the whole instance, not a fragment, background, or another instance.',
      },
    },
  }
}

function makePort(apiKey: string, fetcher: typeof globalThis.fetch): DecisionPort {
  return createOpenRouterDecisions({
    apiKey,
    model: route.model,
    provider: route.provider,
    providerName: route.providerName,
    fetch: fetcher,
  })
}

async function runOneDecision(
  recorder: Recorder,
  request: DecisionRequest,
  signal: AbortSignal,
): Promise<DecisionResult> {
  return recorder.port.decide(request, signal)
}

/**
 * Research-only native choice replay over alias-safe contact sheets. It reads only the
 * manifest's local case ID to select the authored DEV target; only aliases, target prose,
 * and presentation PNG image parts are sent through DecisionPort.
 */
export async function runPointCandidateChoice(options: PointCandidateRunnerOptions) {
  const signal = new AbortController().signal
  if (options.contactSheetManifests.length !== 3)
    throw new ClassifierError('INVALID_INPUT', 'Expected exactly three pinned candidate batches')
  const corpus = await import('./fresh-corpus.js').then(({ loadFreshCorpus }) =>
    loadFreshCorpus({ manifests: options.inputManifests, imageRoot: options.imageRoot }, signal),
  )
  const inputById = new Map(corpus.cases.map((item) => [item.caseId, item]))
  const usedInputIds = new Set<string>()
  const cases: CandidateCase[] = []
  const presentationHashes = new Map<string, string>()
  for (let batch = 0; batch < options.contactSheetManifests.length; batch += 1) {
    const pin = options.contactSheetManifests[batch]!
    const manifest = await readPinnedManifest(pin)
    const manifestRoot = resolve(dirname(pin.path), basename(pin.path, '.json'))
    for (const raw of manifest.cases) {
      const entry = localCaseSchema.parse(raw)
      const input = inputById.get(entry.internal.caseId)
      if (!input || usedInputIds.has(input.caseId))
        throw new ClassifierError(
          'INVALID_INPUT',
          'Candidate seed is absent or duplicated in pinned DEV input',
        )
      usedInputIds.add(input.caseId)
      const presentation = entry.presentation
      if (
        new Set(presentation.choiceIds).size !== presentation.choiceIds.length ||
        presentation.choiceIds[0] !== 'none' ||
        presentation.sheets.length < 1
      )
        throw new ClassifierError('INVALID_INPUT', 'Candidate presentation choices are not closed')
      const filePaths = [
        presentation.originalImagePath,
        ...presentation.sheets.map((item) => item.path),
      ]
      const descriptors: ImageDescriptor[] = []
      for (const file of filePaths) {
        const loaded = await boundedImage(file, manifestRoot)
        descriptors.push(loaded.descriptor)
        loaded.bytes.fill(0)
      }
      const estimatedRequestBytes =
        descriptors.reduce((sum, image) => sum + 4 * Math.ceil(image.bytes / 3) + 64, 0) +
        128 * 1024
      if (estimatedRequestBytes > 30 * 1024 * 1024)
        throw new ClassifierError(
          'RESOURCE_LIMIT',
          'Candidate image set exceeds the request byte budget',
        )
      const caseKey = `batch-${batch + 1}-${entry.caseAlias}`
      const targetText = safeTask(input.locate.target, [
        input.caseId,
        input.image.path,
        input.image.sha256,
        corpus.imageRoot,
      ])
      cases.push({
        caseKey,
        choiceIds: presentation.choiceIds,
        target: targetText,
        imageRoot: manifestRoot,
        imageDescriptors: descriptors,
      })
      presentationHashes.set(
        caseKey,
        hashCanonical({ pin: pin.sha256, caseAlias: entry.caseAlias, descriptors }),
      )
    }
  }
  const minimum = options.minimumCases ?? 12
  const maximum = options.maximumCases ?? 12
  if (cases.length < minimum || cases.length > maximum)
    throw new ClassifierError('INVALID_INPUT', 'Pinned candidate set has an unexpected case count')
  const source = await hashSources()
  const runId = `v02-point-candidate-choice-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(options.outputRoot, runId)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: false })
  const budget = new RunBudget(
    pointCandidatePolicy.maxPhysicalCalls,
    pointCandidatePolicy.maxCostUsd,
    pointCandidatePolicy.unknownCostReserveUsd,
  )
  const runManifest = {
    schemaVersion: 1,
    runId,
    profileId: 'native-luna-point-candidate-choice-v1',
    presentationRendererCommit: 'fec462b08b21f2c46472a493c7ed8664d1529d47',
    purpose:
      'DEV-only closed candidate-mask selection diagnostic; no segmentation quality labels in prompts',
    startedAt: new Date().toISOString(),
    route,
    candidateQuestion,
    policy: pointCandidatePolicy,
    contactSheetManifests: options.contactSheetManifests.map((item) => ({ sha256: item.sha256 })),
    inputManifests: corpus.manifests,
    sourceHashes: source,
    sourceSnapshotSha256: hashCanonical(
      Object.entries(source).sort(([a], [b]) => a.localeCompare(b)),
    ),
    plannedCaseAliases: cases.map((item) => item.caseKey),
    presentationHashes: Object.fromEntries(presentationHashes),
    modelBoundary: { evaluatorTruthRead: false, retries: 0, fallback: false },
  }
  await immutable(resolve(outputDirectory, 'run-manifest.json'), runManifest)

  const results: CandidateOutcome[] = []
  const physicalCalls: PhysicalCallRecord[] = []
  for (const item of cases) {
    const caseDir = resolve(outputDirectory, item.caseKey)
    await mkdir(caseDir, { recursive: false })
    const imageBytes: Buffer[] = []
    try {
      const files = [
        ...item.imageDescriptors.map((descriptor) => resolve(item.imageRoot, descriptor.file)),
      ]
      for (let index = 0; index < files.length; index += 1) {
        const expected = item.imageDescriptors[index]!
        const loaded = await boundedImage(files[index]!, item.imageRoot)
        if (
          loaded.bytes.byteLength !== expected.bytes ||
          loaded.descriptor.sha256 !== expected.sha256 ||
          loaded.descriptor.width !== expected.width ||
          loaded.descriptor.height !== expected.height ||
          loaded.descriptor.role !== expected.role
        ) {
          loaded.bytes.fill(0)
          throw new ClassifierError(
            'INVALID_INPUT',
            'Pinned presentation image changed after preflight',
          )
        }
        imageBytes.push(loaded.bytes)
      }
      const targetText = item.target
      const ids = item.choiceIds
      const budgetForCase = budget
      const choiceRecorder = recordProvider(
        (fetcher) => options.createDecision?.(fetcher) ?? makePort(options.apiKey, fetcher),
        budgetForCase,
        resolve(caseDir, 'choice'),
        route,
        options.fetch ?? globalThis.fetch,
      )
      let choice: CandidateOutcome['choice'] = null
      let wholeTarget: CandidateOutcome['wholeTarget'] = null
      let errorCode: string | undefined
      let status: CandidateOutcome['status'] = 'complete'
      let caseCallCount = 0
      const caseRequestHashes: string[] = []
      const requestScope = new AbortController()
      const requestTimer = setTimeout(
        () => requestScope.abort(new Error('Candidate selection deadline exceeded')),
        pointCandidatePolicy.timeoutMs,
      )
      try {
        const request = choiceRequest(targetText, ids, imageBytes)
        const decision = await runOneDecision(choiceRecorder, request, requestScope.signal)
        caseCallCount += choiceRecorder.calls.length
        caseRequestHashes.push(...choiceRecorder.logicalCalls.map((call) => call.requestSha256))
        const validated = validateDecision(request, decision)
        const answer = validated.answers.selection
        if (!answer || answer.type !== 'choice' || !ids.includes(answer.choice))
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Choice result omitted its closed selected alias',
          )
        const stableSelection = selection(validated, ids, 1)
        choice = {
          selected: stableSelection.choice,
          nativeChoice: answer.choice,
          probabilities: answer.probabilities,
          receiptCostUsd: decision.metadata.costUsd,
        }
        if (stableSelection.choice !== 'none') {
          const noulRecorder = recordProvider(
            (fetcher) => options.createDecision?.(fetcher) ?? makePort(options.apiKey, fetcher),
            budget,
            resolve(caseDir, 'whole-target'),
            route,
            options.fetch ?? globalThis.fetch,
          )
          try {
            const judge = await runOneDecision(
              noulRecorder,
              wholeTargetRequest(targetText, stableSelection.choice, imageBytes),
              requestScope.signal,
            )
            caseCallCount += noulRecorder.calls.length
            caseRequestHashes.push(...noulRecorder.logicalCalls.map((call) => call.requestSha256))
            const score = judge.answers.presence
            if (!score || score.type !== 'noul')
              throw new ClassifierError('INVALID_RESPONSE', 'Whole-target Noul response was absent')
            wholeTarget = { score: score.noul, receiptCostUsd: judge.metadata.costUsd }
          } catch (error) {
            status = 'failed'
            errorCode = safeErrorCode(error)
            caseCallCount += noulRecorder.calls.length
            caseRequestHashes.push(...noulRecorder.logicalCalls.map((call) => call.requestSha256))
          } finally {
            physicalCalls.push(...noulRecorder.calls)
          }
        }
      } catch (error) {
        status = 'failed'
        errorCode = safeErrorCode(error)
        caseCallCount += choiceRecorder.calls.length
        caseRequestHashes.push(...choiceRecorder.logicalCalls.map((call) => call.requestSha256))
      } finally {
        clearTimeout(requestTimer)
        physicalCalls.push(...choiceRecorder.calls)
      }
      const outcome: CandidateOutcome = {
        caseKey: item.caseKey,
        status,
        choice,
        wholeTarget,
        ...(errorCode ? { errorCode } : {}),
        physicalCalls: caseCallCount,
        requestHashes: caseRequestHashes,
      }
      await immutable(resolve(caseDir, 'result.json'), outcome)
      results.push(outcome)
    } catch (error) {
      const outcome: CandidateOutcome = {
        caseKey: item.caseKey,
        status: 'failed',
        choice: null,
        wholeTarget: null,
        errorCode: safeErrorCode(error),
        physicalCalls: 0,
        requestHashes: [],
      }
      await immutable(resolve(caseDir, 'result.json'), outcome)
      results.push(outcome)
    } finally {
      for (const bytes of imageBytes) bytes.fill(0)
    }
  }
  const summary = {
    runId,
    status: results.length === cases.length ? 'complete' : 'incomplete',
    plannedCaseAliases: cases.map((item) => item.caseKey),
    completedCaseAliases: results.map((item) => item.caseKey),
    missingCaseAliases: cases
      .map((item) => item.caseKey)
      .filter((id) => !results.some((row) => row.caseKey === id)),
    results,
    aggregate: budget.snapshot(),
    physicalReceipts: [...physicalCalls]
      .sort((a, b) => a.physicalId - b.physicalId)
      .map((call) => ({
        physicalId: call.physicalId,
        requestSha256: call.requestSha256,
        route: call.route,
        receipt: call.receipt,
        wireReceipt: call.wireReceipt,
        errorCode: call.errorCode ?? null,
        durationMs: call.durationMs,
      })),
    latencyEnvironment: pointCandidatePolicy.latencyEnvironment,
    latencyRankingEligible: false,
  }
  await immutable(resolve(outputDirectory, 'summary.json'), summary)
  await immutable(resolve(outputDirectory, 'run-complete.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summarySha256: sha256(JSON.stringify(summary)),
  })
  return { ...summary, outputDirectory }
}

/** Verify all pinned producer inputs and presentation assets without constructing a provider. */
export async function preflightPointCandidateChoice(
  options: Pick<
    PointCandidateRunnerOptions,
    'contactSheetManifests' | 'inputManifests' | 'imageRoot' | 'minimumCases' | 'maximumCases'
  >,
) {
  if (options.contactSheetManifests.length !== 3)
    throw new ClassifierError('INVALID_INPUT', 'Expected exactly three pinned candidate batches')
  const signal = new AbortController().signal
  const { loadFreshCorpus } = await import('./fresh-corpus.js')
  const corpus = await loadFreshCorpus(
    { manifests: options.inputManifests, imageRoot: options.imageRoot },
    signal,
  )
  const inputById = new Map(corpus.cases.map((item) => [item.caseId, item]))
  const usedInputIds = new Set<string>()
  const aliases: string[] = []
  const imageSetHashes: string[] = []
  let candidateChoices = 0
  let imageCount = 0
  for (let batch = 0; batch < options.contactSheetManifests.length; batch += 1) {
    const pin = options.contactSheetManifests[batch]!
    const manifest = await readPinnedManifest(pin)
    const manifestRoot = resolve(dirname(pin.path), basename(pin.path, '.json'))
    for (const raw of manifest.cases) {
      const entry = localCaseSchema.parse(raw)
      const input = inputById.get(entry.internal.caseId)
      if (!input || usedInputIds.has(input.caseId))
        throw new ClassifierError(
          'INVALID_INPUT',
          'Candidate seed is absent or duplicated in pinned DEV input',
        )
      usedInputIds.add(input.caseId)
      const presentation = entry.presentation
      if (
        new Set(presentation.choiceIds).size !== presentation.choiceIds.length ||
        presentation.choiceIds[0] !== 'none' ||
        presentation.sheets.length < 1
      )
        throw new ClassifierError('INVALID_INPUT', 'Candidate presentation choices are not closed')
      safeTask(input.locate.target, [
        input.caseId,
        input.image.path,
        input.image.sha256,
        corpus.imageRoot,
      ])
      const descriptors: ImageDescriptor[] = []
      for (const file of [
        presentation.originalImagePath,
        ...presentation.sheets.map((item) => item.path),
      ]) {
        const loaded = await boundedImage(file, manifestRoot)
        descriptors.push(loaded.descriptor)
        loaded.bytes.fill(0)
      }
      const estimatedRequestBytes =
        descriptors.reduce((sum, image) => sum + 4 * Math.ceil(image.bytes / 3) + 64, 0) +
        128 * 1024
      if (estimatedRequestBytes > 30 * 1024 * 1024)
        throw new ClassifierError(
          'RESOURCE_LIMIT',
          'Candidate image set exceeds the request byte budget',
        )
      aliases.push(`batch-${batch + 1}-${entry.caseAlias}`)
      candidateChoices += presentation.choiceIds.length
      imageCount += descriptors.length
      imageSetHashes.push(
        hashCanonical({ manifestSha256: pin.sha256, alias: entry.caseAlias, descriptors }),
      )
    }
  }
  const minimum = options.minimumCases ?? 12
  const maximum = options.maximumCases ?? 12
  if (aliases.length < minimum || aliases.length > maximum)
    throw new ClassifierError('INVALID_INPUT', 'Pinned candidate set has an unexpected case count')
  return {
    plannedCases: aliases.length,
    candidateChoices,
    presentationImages: imageCount,
    contactSheetManifestHashes: options.contactSheetManifests.map((item) => item.sha256),
    imageSetHashes,
  }
}

export async function readPointCandidateOpenRouterKey(): Promise<string> {
  const key = parseEnv(await readFile(envFile, 'utf8')).OPENROUTER_API_KEY
  if (!key) throw new Error('Configured OpenRouter credential is absent')
  return key
}
