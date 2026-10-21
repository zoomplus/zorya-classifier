import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharpDependency from 'sharp'
import type { DecisionRequest, ImagePart } from '../../src/entities/contracts.js'
import { createOpenRouterDecisions } from '../../src/infrastructure/openrouter.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import { RunBudget } from '../v02/budget.js'
import { recordProvider } from '../v02/recording.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const imageRoot =
  '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/imageRoot'
const inputManifest =
  '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/photo-inputs.json'
const probeRoot = resolve(repoRoot, '.run/v03/segmentation-prompt-probe-v1')
const outputRoot = resolve(repoRoot, '.run/v03/semantic-mask-probe-v1')
const envFile = '/root/work/element/.env.local'
const route = Object.freeze({
  id: 'openai-gpt-6-luna-native-decisions-v1',
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false as const,
})
const budgetPolicy = Object.freeze({ maxPhysicalCalls: 5, maxCostUsd: 1, unknownReserveUsd: 0.05 })
const caseIds = [
  'photo-heldout-present-01',
  'photo-heldout-present-02',
  'photo-heldout-present-04',
  'photo-heldout-present-16',
  'photo-heldout-present-18',
] as const
const ids = ['A', 'B', 'C', 'D', 'none'] as const
const prompt = Object.freeze({
  task: 'Compare four candidate masks with the original photograph. Choose exactly one candidate that covers the entire visible requested object, not merely a part. Exclude unrelated objects and background. Choose none if no candidate covers the entire requested object. Do not infer hidden object parts or invent a candidate.',
  question:
    'Which candidate mask covers the entire visible requested object in the original photograph?',
  criteria: {
    A: 'Candidate A overlay. Select only if it covers the entire visible requested object, excluding unrelated objects and background.',
    B: 'Candidate B overlay. Select only if it covers the entire visible requested object, excluding unrelated objects and background.',
    C: 'Candidate C overlay. Select only if it covers the entire visible requested object, excluding unrelated objects and background.',
    D: 'Candidate D overlay. Select only if it covers the entire visible requested object, excluding unrelated objects and background.',
    none: 'No candidate covers the entire visible requested object.',
  },
})

const rasterModule = await import('../../src/infrastructure/raster.js')
const raster = rasterModule.createSharpRaster()

type Rect = { left: number; top: number; width: number; height: number }
type CasePin = {
  caseId: string
  target: string
  source: { path: string; sha256: string; width: number; height: number }
  originalPresentation: { path: string; sha256: string }
  seed: Rect
  candidates: Array<{ id: 'A' | 'B' | 'C' | 'D'; path: string; sha256: string; maskSha256: string }>
}
type Freeze = {
  schema: 'v03-semantic-mask-probe-freeze-v1'
  sourceSha256: string
  evaluatorSha256: string
  prompt: typeof prompt
  promptSha256: string
  route: typeof route
  budgetPolicy: typeof budgetPolicy
  inputManifestSha256: string
  segmentationSummarySha256: string
  segmentationFreezeSha256: string
  cases: CasePin[]
}

function sha256(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function writeImmutable(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

export async function renderCandidate(
  source: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  label: string,
) {
  const pixels = width * height
  assert(mask.length === pixels, 'Candidate mask dimensions differ from source')
  const overlay = Buffer.alloc(pixels * 4)
  for (let index = 0; index < pixels; index++) {
    if (mask[index] !== 1) continue
    const x = index % width
    const y = Math.floor(index / width)
    const edge =
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      mask[index - 1] !== 1 ||
      mask[index + 1] !== 1 ||
      mask[index - width] !== 1 ||
      mask[index + width] !== 1
    const offset = index * 4
    overlay[offset] = 0
    overlay[offset + 1] = 220
    overlay[offset + 2] = 255
    overlay[offset + 3] = edge ? 255 : 82
  }
  const banner = Buffer.from(
    `<svg width="${width}" height="42" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="42" fill="#07131dcc"/><text x="14" y="30" fill="white" font-family="Arial,sans-serif" font-size="26" font-weight="700">Candidate ${label}</text></svg>`,
  )
  const result = await sharpDependency(source, { limitInputPixels: 16_777_216 })
    .composite([
      { input: overlay, raw: { width, height, channels: 4 } },
      { input: banner, top: 0, left: 0 },
    ])
    .png()
    .toBuffer()
  overlay.fill(0)
  return result
}

async function prepare() {
  await mkdir(outputRoot, { recursive: true })
  const [inputBytes, segmentationBytes, segmentationFreezeBytes, sourceBytes, evaluatorBytes] =
    await Promise.all([
      readFile(inputManifest),
      readFile(resolve(probeRoot, 'summary.json')),
      readFile(resolve(probeRoot, 'freeze.json')),
      readFile(fileURLToPath(import.meta.url)),
      readFile(resolve(repoRoot, 'benchmarks/v03/evaluate-semantic-mask-probe.ts')),
    ])
  const rows = JSON.parse(inputBytes.toString('utf8')) as Array<{
    caseId: string
    image: { path: string; sha256: string; width: number; height: number }
    locate: { target: string }
  }>
  const inputById = new Map(rows.map((row) => [row.caseId, row]))
  const segmentation = JSON.parse(segmentationBytes.toString('utf8')) as {
    cases: Array<{
      caseId: string
      imageSha256: string
      dimensions: { width: number; height: number }
      seed: Rect
      profiles: Array<{
        profile: string
        maskFile: string
        maskSha256: string
        candidateCount: number
      }>
    }>
  }
  const segmentationById = new Map(segmentation.cases.map((row) => [row.caseId, row]))
  const cases: CasePin[] = []
  for (const caseId of caseIds) {
    const input = inputById.get(caseId)
    const result = segmentationById.get(caseId)
    const profile = result?.profiles.find((item) => item.profile === 'point-seed')
    assert(
      input && result && profile && profile.candidateCount === 4,
      `Missing fixed candidate case ${caseId}`,
    )
    assert(
      input.image.sha256 === result.imageSha256,
      `Input image hash differs from segmentation ${caseId}`,
    )
    const sourceBytes = await readFile(resolve(imageRoot, input.image.path))
    assert(sha256(sourceBytes) === input.image.sha256, `Source image hash mismatch ${caseId}`)
    const normalized = await raster.normalize(sourceBytes, new AbortController().signal)
    assert(
      normalized.width === input.image.width && normalized.height === input.image.height,
      `Source dimensions differ ${caseId}`,
    )
    const profileBytes = await readFile(resolve(probeRoot, profile.maskFile))
    assert(sha256(profileBytes) === profile.maskSha256, `Candidate mask hash mismatch ${caseId}`)
    const planeBytes = input.image.width * input.image.height
    assert(
      profileBytes.byteLength === planeBytes * 4,
      `Candidate mask plane count differs ${caseId}`,
    )
    const directory = resolve(outputRoot, caseId)
    await mkdir(directory, { recursive: false })
    const candidates: CasePin['candidates'] = []
    for (let index = 0; index < 4; index++) {
      const id = ids[index] as 'A' | 'B' | 'C' | 'D'
      const mask = profileBytes.subarray(index * planeBytes, (index + 1) * planeBytes)
      const rendered = await renderCandidate(
        normalized.bytes,
        mask,
        normalized.width,
        normalized.height,
        id,
      )
      assert(
        rendered.byteLength <= 16 * 1024 * 1024,
        `Candidate presentation too large ${caseId}/${id}`,
      )
      const state = await raster.imageState(
        { bytes: rendered, width: normalized.width, height: normalized.height },
        new AbortController().signal,
      )
      const image = state.find((part) => typeof part !== 'string')
      assert(image && image.type === 'image_url', 'Raster presentation omitted image part')
      const data = Buffer.from(image.image_url.url.slice('data:image/png;base64,'.length), 'base64')
      assert(data.byteLength <= 16 * 1024 * 1024, `Prepared candidate too large ${caseId}/${id}`)
      const renderedPath = resolve(directory, `${id}.png`)
      await writeFile(renderedPath, data, { flag: 'wx' })
      candidates.push({ id, path: renderedPath, sha256: sha256(data), maskSha256: sha256(mask) })
      data.fill(0)
      rendered.fill(0)
    }
    const originalState = await raster.imageState(normalized, new AbortController().signal)
    const originalPart = originalState.find((part) => typeof part !== 'string')
    assert(originalPart && originalPart.type === 'image_url', 'Raster original omitted image part')
    const originalData = Buffer.from(
      originalPart.image_url.url.slice('data:image/png;base64,'.length),
      'base64',
    )
    const originalPath = resolve(directory, 'original.png')
    await writeFile(originalPath, originalData, { flag: 'wx' })
    const originalPresentationSha256 = sha256(originalData)
    originalData.fill(0)
    cases.push({
      caseId,
      target: input.locate.target,
      source: {
        path: input.image.path,
        sha256: input.image.sha256,
        width: input.image.width,
        height: input.image.height,
      },
      originalPresentation: { path: originalPath, sha256: originalPresentationSha256 },
      seed: result.seed,
      candidates,
    })
    normalized.bytes.fill(0)
    profileBytes.fill(0)
    sourceBytes.fill(0)
  }
  const freeze: Freeze = {
    schema: 'v03-semantic-mask-probe-freeze-v1',
    sourceSha256: sha256(sourceBytes),
    evaluatorSha256: sha256(evaluatorBytes),
    prompt,
    promptSha256: sha256(JSON.stringify(prompt)),
    route,
    budgetPolicy,
    inputManifestSha256: sha256(inputBytes),
    segmentationSummarySha256: sha256(segmentationBytes),
    segmentationFreezeSha256: sha256(segmentationFreezeBytes),
    cases,
  }
  await writeImmutable(resolve(outputRoot, 'freeze.json'), freeze)
  process.stdout.write(
    `${JSON.stringify({ status: 'prepared', cases: cases.length, freezeSha256: sha256(await readFile(resolve(outputRoot, 'freeze.json'))) })}\n`,
  )
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

export function requestFor(target: string, images: readonly Uint8Array[]): DecisionRequest {
  return {
    state: [
      prompt.task,
      `Target: ${target}`,
      'Original photograph:',
      dataImage(images[0]!),
      'Candidate A:',
      dataImage(images[1]!),
      'Candidate B:',
      dataImage(images[2]!),
      'Candidate C:',
      dataImage(images[3]!),
      'Candidate D:',
      dataImage(images[4]!),
    ],
    questions: {
      selection: { type: 'choice', instructions: prompt.question, criteria: prompt.criteria },
    },
  }
}

async function dispatch() {
  const freezeBytes = await readFile(resolve(outputRoot, 'freeze.json'))
  const freeze = JSON.parse(freezeBytes.toString('utf8')) as Freeze
  const sourceBytes = await readFile(fileURLToPath(import.meta.url))
  const evaluatorBytes = await readFile(
    resolve(repoRoot, 'benchmarks/v03/evaluate-semantic-mask-probe.ts'),
  )
  const inputBytes = await readFile(inputManifest)
  const segmentationBytes = await readFile(resolve(probeRoot, 'summary.json'))
  assert(sha256(sourceBytes) === freeze.sourceSha256, 'Probe source changed after freeze')
  assert(sha256(evaluatorBytes) === freeze.evaluatorSha256, 'Evaluator changed after freeze')
  assert(sha256(inputBytes) === freeze.inputManifestSha256, 'Input manifest changed after freeze')
  assert(
    sha256(segmentationBytes) === freeze.segmentationSummarySha256,
    'Candidate summary changed after freeze',
  )
  assert(sha256(JSON.stringify(prompt)) === freeze.promptSha256, 'Prompt changed after freeze')
  const env = parseEnv(await readFile(envFile, 'utf8'))
  const credential = env.OPENROUTER_API_KEY
  assert(credential, 'Configured OpenRouter credential is absent')
  const prepared = [] as Array<{ item: CasePin; originalBytes: Buffer; candidateBytes: Buffer[] }>
  for (const item of freeze.cases) {
    const originalBytes = await readFile(item.originalPresentation.path)
    assert(
      sha256(originalBytes) === item.originalPresentation.sha256,
      `Original presentation changed ${item.caseId}`,
    )
    const candidateBytes: Buffer[] = []
    for (const candidate of item.candidates) {
      const bytes = await readFile(candidate.path)
      assert(
        sha256(bytes) === candidate.sha256,
        `Candidate presentation changed ${item.caseId}/${candidate.id}`,
      )
      const metadata = await sharpDependency(bytes, { limitInputPixels: 16_777_216 }).metadata()
      assert(
        metadata.width && metadata.height && metadata.width <= 16384 && metadata.height <= 16384,
        `Candidate dimensions invalid ${item.caseId}/${candidate.id}`,
      )
      candidateBytes.push(bytes)
    }
    const imageSet = [originalBytes, ...candidateBytes]
    const estimatedRequestBytes =
      imageSet.reduce((sum, bytes) => sum + 4 * Math.ceil(bytes.length / 3) + 64, 0) + 128 * 1024
    assert(
      estimatedRequestBytes <= 30 * 1024 * 1024,
      `Request image budget exceeded ${item.caseId}`,
    )
    prepared.push({ item, originalBytes, candidateBytes })
  }
  const budget = new RunBudget(5, 1, 0.05)
  const results: Array<Record<string, unknown>> = []
  for (const { item, originalBytes, candidateBytes } of prepared) {
    const directory = resolve(outputRoot, item.caseId)
    const key = resolve(outputRoot, item.caseId, 'provider')
    await mkdir(key, { recursive: false })
    const recorder = recordProvider(
      (fetch) =>
        createOpenRouterDecisions({
          apiKey: credential,
          model: route.model,
          provider: route.provider,
          providerName: route.providerName,
          fetch,
        }),
      budget,
      key,
      route,
      globalThis.fetch,
    )
    let status = 'complete'
    let selected: string | null = null
    let probabilities: Record<string, number> | null = null
    let costUsd: number | null = null
    let errorCode: string | null = null
    const abort = new AbortController()
    const timer = setTimeout(
      () => abort.abort(new Error('Semantic mask probe deadline exceeded')),
      45_000,
    )
    try {
      const request = requestFor(item.target, [originalBytes, ...candidateBytes])
      const result = await recorder.port.decide(request, abort.signal)
      const validated = validateDecision(request, result)
      const answer = validated.answers.selection
      if (
        !answer ||
        answer.type !== 'choice' ||
        !ids.includes(answer.choice as (typeof ids)[number])
      )
        throw new Error('Choice response omitted a closed alias')
      const chosen = selection(validated, ids, 1)
      selected = chosen.choice
      probabilities = chosen.probabilities
      costUsd = result.metadata.costUsd
    } catch (error) {
      status = 'failed'
      errorCode =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'RUNNER_FAILURE'
    } finally {
      clearTimeout(timer)
    }
    const resultRow = {
      caseId: item.caseId,
      status,
      selected,
      probabilities,
      costUsd,
      errorCode,
      physicalCalls: recorder.calls.length,
      requestHashes: recorder.logicalCalls.map((call) => call.requestSha256),
      sourceSha256: item.source.sha256,
      candidateMaskHashes: item.candidates.map((candidate) => candidate.maskSha256),
    }
    await writeImmutable(resolve(directory, 'result.json'), resultRow)
    results.push(resultRow)
  }
  const summary = {
    schema: 'v03-semantic-mask-probe-results-v1',
    freezeSha256: sha256(freezeBytes),
    route,
    budget: budget.snapshot(),
    results,
    physicalCalls: results.reduce((sum, row) => sum + Number(row.physicalCalls), 0),
  }
  await writeImmutable(resolve(outputRoot, 'summary.json'), summary)
  for (const { originalBytes, candidateBytes } of prepared) {
    originalBytes.fill(0)
    for (const bytes of candidateBytes) bytes.fill(0)
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'dispatched', cases: results.length, physicalCalls: summary.physicalCalls, knownCostUsd: budget.snapshot().knownCostUsd, unknownCostCalls: budget.snapshot().unknownCostCalls })}\n`,
  )
}

const mode = process.argv[2]
if (mode === '--prepare')
  prepare().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Preparation failed'}\n`)
    process.exitCode = 1
  })
else if (mode === '--dispatch')
  dispatch().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Dispatch failed'}\n`)
    process.exitCode = 1
  })
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write('Use exactly one of --prepare or --dispatch\n')
  process.exitCode = 2
}
