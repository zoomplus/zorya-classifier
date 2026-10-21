import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import type { PixelRect, RasterPort } from '../../src/entities/contracts.js'
import { limits } from '../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import type { PackedBinaryMask } from '../../src/entities/object-proposals.js'
import type { RgbaRaster } from '../../src/entities/representation.js'
import { packBinaryMask, unpackBinaryMask } from '../../src/features/segmentation/packed-mask.js'
import { createSharpRaster } from '../../src/infrastructure/raster.js'
import {
  createH5ProposalComposer,
  createSharpH5Presentation,
  type H5DecisionStage,
  type H5Family,
  type H5ProposalCandidate,
} from './h5-proposal-composer.js'
import type { RunBudget } from '../v02/budget.js'
import type { Recorder } from '../v02/recording.js'
import { captureH5ReplaySource } from './replay-source-closure.js'

export const H5A_RUN_SHA256 = '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0'
export const H5A_FREEZE_SHA256 = 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566'
export const H5A_INTEGRITY_SHA256 =
  '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50'
export const H5A_WORKER_CLOSURE_SHA256 =
  'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f'
export const H3B_RUN_SHA256 = 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401'
export const H4E_RUN_SHA256 = 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4'
export const H5_MODEL = 'openai/gpt-6-luna-decisions'

const expectedIds = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]
const caseDeadlineMs = 240_000
const routeExpected = {
  model: H5_MODEL,
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
} as const

const receiptSchema = z
  .object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .passthrough()
const freezeSchema = z
  .object({
    state: z.literal('frozen-before-generation'),
    cases: z.array(
      z
        .object({
          case_id: z.string(),
          source: z.object({
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            bytes: z.number().int().positive(),
          }),
          target: z.string().min(1).max(2000),
        })
        .passthrough(),
    ),
  })
  .passthrough()
const runCaseSchema = z
  .object({
    case_id: z.string(),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    target: z.string().min(1).max(2000),
    status: z.string(),
    packed_mask_bytes_combined: z.number().int().nonnegative(),
    dino_candidates: z
      .array(
        z
          .object({
            id: z.string(),
            mask_path: z.string(),
            mask_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            mask_box_xyxy: z.tuple([
              z.number().int(),
              z.number().int(),
              z.number().int(),
              z.number().int(),
            ]),
          })
          .passthrough(),
      )
      .max(36),
    omni_source_result: z.string().nullable(),
  })
  .passthrough()
const runSchema = z
  .object({
    state: z.literal('complete'),
    native_generation_ms: z.number().finite().nonnegative(),
    cases: z.array(runCaseSchema),
    h3b: z.object({ run: receiptSchema }),
    h4e_ui_cache: z.object({ run: receiptSchema }),
    paid_calls: z.literal(0),
  })
  .passthrough()
const maskCandidateSchema = z
  .object({
    id: z.string().optional(),
    mask_path: z.string(),
    mask_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    mask_box_xyxy: z.tuple([
      z.number().int(),
      z.number().int(),
      z.number().int(),
      z.number().int(),
    ]),
    cached_h4e: z.boolean().optional(),
  })
  .passthrough()
const sourceResultSchema = z
  .object({
    status: z.literal('complete'),
    source: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough(),
    elapsed_ms_including_child_startup: z.number().finite().nonnegative().optional(),
    timing_ms: z
      .object({ generation: z.number().finite().nonnegative().optional() })
      .passthrough()
      .optional(),
    dimensions: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    sam2: z.object({ candidates: z.array(maskCandidateSchema).max(36) }).passthrough(),
  })
  .passthrough()
const h4eSchema = z
  .object({
    state: z.literal('complete'),
    source: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough(),
    results: z
      .array(
        z
          .object({
            mask_path: z.string(),
            mask_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            mask_box_xyxy: z.tuple([
              z.number().int(),
              z.number().int(),
              z.number().int(),
              z.number().int(),
            ]),
            source_width: z.number().int().positive(),
            source_height: z.number().int().positive(),
          })
          .passthrough(),
      )
      .max(36),
  })
  .passthrough()
const integritySchema = z
  .object({
    h5a_run_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          bytes: z.number().int().nonnegative(),
          label: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough()

export interface H5Route {
  model: typeof H5_MODEL
  provider: 'openai'
  providerName: 'OpenAI'
  apiEndpoint: '/api/alpha/decisions'
  allowFallbacks: false
}
export interface H5bReplayOptions {
  /** Explicit repository root used to freeze executable source; never inferred from cwd. */
  repositoryRoot: string
  /** Exact completed H5a output directory. No default path or model asset discovery. */
  h5aDirectory: string
  /** Exact H4e directory containing the H4e run referenced by H5a. */
  h4eDirectory: string
  /** New, exclusive output directory. */
  outputDirectory: string
  /** Caller-owned recorded provider and its physical-call ledger. */
  recorder: Recorder
  /** Caller-owned shared 36/$2/$0.10 physical fetch budget. */
  budget: RunBudget
  /** Explicit route recorded at every physical fetch. */
  route: H5Route
  /** Optional cancellation from the private launcher. */
  signal?: AbortSignal
  /** Test hooks do not change the fixed 12-case cohort or replay behavior. */
  imageState?: RasterPort['imageState']
  presentation?: Parameters<typeof createH5ProposalComposer>[0]['presentation']
}

interface LoadedMaskDescriptor {
  family: H5Family
  sourceFamily: 'h3b-dino-sam2' | 'omni-sam2' | 'h4e-sam2'
  sourceAlias: string
  sourceMaskPath: string
  sourceMaskSha256: string
  expectedBox: readonly number[]
}
interface LoadedH5Case {
  caseId: string
  target: string
  sourcePath: string
  sourceSha256: string
  width: number
  height: number
  nativeGenerationMs: number | null
  masks: LoadedMaskDescriptor[]
}
interface LogicalReceipt {
  case_id: string
  stage: H5DecisionStage
  callOrdinal: number
  requestSha256: string
  admittedAt: string
  outcome: 'resolved' | 'failed' | 'pending'
  metadata?: unknown
  errorCode?: string
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const bytes = await readFile(path, signal ? { signal } : undefined)
  try {
    signal?.throwIfAborted()
    return hash(bytes)
  } finally {
    bytes.fill(0)
  }
}
async function safeRealFile(path: string, expectedRoot?: string): Promise<string> {
  const resolved = await realpath(path)
  const parent = await realpath(dirname(resolve(path)))
  if (!inside(parent, resolved)) fail('Frozen artifact resolves outside its containing directory')
  if (expectedRoot && !inside(await realpath(expectedRoot), resolved))
    fail('Frozen artifact resolves outside its allowed root')
  return resolved
}
async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}
function sameBox(actual: PixelRect, expected: readonly number[]): boolean {
  return (
    actual.left === expected[0] &&
    actual.top === expected[1] &&
    actual.left + actual.width === expected[2] &&
    actual.top + actual.height === expected[3]
  )
}
function fail(message: string): never {
  throw new ClassifierError('INVALID_INPUT', message)
}

async function loadMask(
  candidate: LoadedMaskDescriptor,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<PackedBinaryMask> {
  assertActive(signal)
  const bytes = await readFile(candidate.sourceMaskPath)
  try {
    assertActive(signal)
    if (hash(bytes) !== candidate.sourceMaskSha256)
      fail('Pinned H5 native candidate mask hash mismatch')
    const decoded = await sharp(bytes, { limitInputPixels: limits.imagePixels, failOn: 'error' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    try {
      assertActive(signal)
      if (
        decoded.info.width !== width ||
        decoded.info.height !== height ||
        decoded.info.channels !== 1
      )
        fail('H5 native mask dimensions differ from its source')
      const binary = new Uint8Array(decoded.data.length)
      let left = width
      let top = height
      let right = -1
      let bottom = -1
      for (let index = 0; index < decoded.data.length; index++) {
        const value = decoded.data[index]
        if (value !== 0 && value !== 255) fail('H5 native mask is not binary PNG')
        if (value === 255) {
          binary[index] = 1
          const x = index % width
          const y = Math.floor(index / width)
          left = Math.min(left, x)
          top = Math.min(top, y)
          right = Math.max(right, x)
          bottom = Math.max(bottom, y)
        }
      }
      if (right < left) fail('H5 candidate mask has no foreground pixels')
      const box = { left, top, width: right - left + 1, height: bottom - top + 1 }
      if (!sameBox(box, candidate.expectedBox))
        fail('H5 mask box differs from actual foreground pixels')
      return packBinaryMask(binary, width, height)
    } finally {
      decoded.data.fill(0)
    }
  } finally {
    bytes.fill(0)
  }
}

async function loadFrozenCases(
  h5aDirectory: string,
  h4eDirectory: string,
  signal: AbortSignal,
): Promise<{ cases: LoadedH5Case[]; closure: Array<{ path: string; sha256: string }> }> {
  const h5a = resolve(h5aDirectory)
  const h4e = resolve(h4eDirectory)
  const runPath = resolve(h5a, 'run.json')
  const freezePath = resolve(h5a, 'freeze.json')
  const integrityPath = resolve(h5a, 'postrun-integrity.json')
  const workerClosurePath = resolve(h5a, 'worker-closure.json')
  const locks = [
    [runPath, H5A_RUN_SHA256],
    [freezePath, H5A_FREEZE_SHA256],
    [integrityPath, H5A_INTEGRITY_SHA256],
    [workerClosurePath, H5A_WORKER_CLOSURE_SHA256],
  ] as const
  const closure: Array<{ path: string; sha256: string }> = []
  for (const [path, expected] of locks) {
    assertActive(signal)
    const actual = await hashFile(path)
    if (actual !== expected) fail(`Pinned H5a file changed: ${basename(path)}`)
    closure.push({ path, sha256: actual })
  }
  const run = runSchema.parse(await jsonFile(runPath))
  const freeze = freezeSchema.parse(await jsonFile(freezePath))
  const integrity = integritySchema.parse(await jsonFile(integrityPath))
  if (integrity.h5a_run_sha256 !== H5A_RUN_SHA256) fail('H5a integrity sidecar targets another run')
  const integrityByPath = new Map(integrity.files.map((entry) => [resolve(entry.path), entry]))
  const assertIntegrityReceipt = (path: string, expected: string): void => {
    const receipt = integrityByPath.get(resolve(path))
    if (!receipt || receipt.sha256 !== expected)
      fail('H5 candidate receipt is absent from the independent H5a integrity sidecar')
  }
  if (
    run.cases.length !== 12 ||
    freeze.cases.length !== 12 ||
    JSON.stringify(run.cases.map((row) => row.case_id)) !== JSON.stringify(expectedIds) ||
    JSON.stringify(freeze.cases.map((row) => row.case_id)) !== JSON.stringify(expectedIds)
  )
    fail('Pinned H5a rows do not match the fixed twelve-case order')
  if (run.h3b.run.sha256 !== H3B_RUN_SHA256 || run.h4e_ui_cache.run.sha256 !== H4E_RUN_SHA256)
    fail('Pinned H5a inherited H3b/H4e run identity mismatch')
  const h4eRunPath = resolve(h4e, 'run.json')
  if (resolve(run.h4e_ui_cache.run.path) !== h4eRunPath)
    fail('Supplied H4e directory differs from the H5a frozen receipt path')
  if ((await hashFile(h4eRunPath)) !== H4E_RUN_SHA256) fail('Pinned H4e run changed')
  const h4eRunRealPath = await safeRealFile(h4eRunPath, h4e)
  closure.push({ path: h4eRunRealPath, sha256: H4E_RUN_SHA256 })
  const h3bRunPath = resolve(run.h3b.run.path)
  const h3bRunRealPath = await safeRealFile(h3bRunPath)
  if ((await hashFile(h3bRunRealPath)) !== H3B_RUN_SHA256) fail('Pinned H3b run changed')
  closure.push({ path: h3bRunRealPath, sha256: H3B_RUN_SHA256 })
  const h4eRun = h4eSchema.parse(await jsonFile(h4eRunPath))
  const h4eCandidates = h4eRun.results.map((candidate, index) => ({
    id: basename(candidate.mask_path).replace(/-mask\.png$/u, ''),
    path: resolve(h4e, candidate.mask_path),
    sha256: candidate.mask_sha256,
    expectedBox: candidate.mask_box_xyxy,
    sourceFamily: 'h4e-sam2' as const,
    ordinal: index,
    sourceWidth: candidate.source_width,
    sourceHeight: candidate.source_height,
  }))
  const outputCases: LoadedH5Case[] = []
  for (const caseId of expectedIds) {
    assertActive(signal)
    const runCase = run.cases.find((row) => row.case_id === caseId)
    const freezeCase = freeze.cases.find((row) => row.case_id === caseId)
    if (
      !runCase ||
      !freezeCase ||
      runCase.source_sha256 !== freezeCase.source.sha256 ||
      runCase.target !== freezeCase.target ||
      runCase.status !== 'complete'
    )
      fail(`Pinned H5a source/target/result mismatch for ${caseId}`)
    const frozenSourcePath = await safeRealFile(resolve(freezeCase.source.path))
    const sourceStat = await stat(frozenSourcePath)
    if (
      !sourceStat.isFile() ||
      sourceStat.size !== freezeCase.source.bytes ||
      (await hashFile(frozenSourcePath)) !== freezeCase.source.sha256
    )
      fail(`Frozen H5 source bytes/hash mismatch for ${caseId}`)
    closure.push({ path: frozenSourcePath, sha256: freezeCase.source.sha256 })
    const sourceResultPath = runCase.omni_source_result ? resolve(runCase.omni_source_result) : null
    const masks: LoadedMaskDescriptor[] = []
    let nativeGenerationMs: number | null = null
    for (const candidate of runCase.dino_candidates) {
      const dinoIndex = masks.length
      if (candidate.id !== `C${String(dinoIndex).padStart(2, '0')}`)
        fail(`H3b DINO aliases are not in frozen stable order for ${caseId}`)
      const path = await safeRealFile(resolve(candidate.mask_path))
      assertIntegrityReceipt(path, candidate.mask_sha256)
      masks.push({
        family: 'D',
        sourceFamily: 'h3b-dino-sam2',
        sourceAlias: candidate.id,
        sourceMaskPath: path,
        sourceMaskSha256: candidate.mask_sha256,
        expectedBox: candidate.mask_box_xyxy,
      })
    }
    let omniCandidates: Array<z.infer<typeof maskCandidateSchema>> = []
    if (runCase.omni_source_result) {
      if (!sourceResultPath || !inside(h5a, sourceResultPath))
        fail('H5a per-source Omni output escaped its run root')
      const sourceResultRealPath = await safeRealFile(sourceResultPath, h5a)
      const sourceResultReceipt = integrityByPath.get(sourceResultRealPath)
      if (
        !sourceResultReceipt ||
        (await hashFile(sourceResultRealPath)) !== sourceResultReceipt.sha256
      )
        fail('H5a per-source JSON does not match the frozen integrity receipt')
      closure.push({ path: sourceResultRealPath, sha256: sourceResultReceipt.sha256 })
      const sourceResult = sourceResultSchema.parse(await jsonFile(sourceResultRealPath))
      if (sourceResult.source?.sha256 !== runCase.source_sha256)
        fail('H5a per-source result refers to another image')
      if (!sourceResult.dimensions.width || !sourceResult.dimensions.height)
        fail('H5a per-source dimensions are missing')
      const sourceWidth = sourceResult.dimensions.width
      const sourceHeight = sourceResult.dimensions.height
      omniCandidates = sourceResult.sam2.candidates
      nativeGenerationMs =
        sourceResult.elapsed_ms_including_child_startup ??
        sourceResult.timing_ms?.generation ??
        null
      for (const [index, candidate] of omniCandidates.entries()) {
        const path = await safeRealFile(resolve(candidate.mask_path), h5a)
        if (!inside(h5a, path)) fail('H5a Omni mask escaped its run root')
        assertIntegrityReceipt(path, candidate.mask_sha256)
        const id = candidate.id ?? `U${String(index).padStart(2, '0')}`
        if (id !== `U${String(index).padStart(2, '0')}`)
          fail('H5a Omni aliases are not in frozen stable order')
        masks.push({
          family: 'U',
          sourceFamily: candidate.cached_h4e ? 'h4e-sam2' : 'omni-sam2',
          sourceAlias: id,
          sourceMaskPath: path,
          sourceMaskSha256: candidate.mask_sha256,
          expectedBox: candidate.mask_box_xyxy,
        })
      }
      outputCases.push({
        caseId,
        target: freezeCase.target,
        sourcePath: frozenSourcePath,
        sourceSha256: freezeCase.source.sha256,
        width: sourceWidth,
        height: sourceHeight,
        nativeGenerationMs,
        masks,
      })
    } else {
      if (runCase.source_sha256 !== h4eRun.source.sha256)
        fail('H4e cache source does not match H5a UI source')
      nativeGenerationMs = 0
      omniCandidates = h4eCandidates.map((candidate) => ({
        id: candidate.id,
        mask_path: candidate.path,
        mask_sha256: candidate.sha256,
        mask_box_xyxy: candidate.expectedBox,
        cached_h4e: true,
      }))
      for (const [index, candidate] of h4eCandidates.entries()) {
        const path = await safeRealFile(candidate.path, h4e)
        assertIntegrityReceipt(path, candidate.sha256)
        if (candidate.id !== `candidate-${String(index).padStart(3, '0')}`)
          fail('H4e cached aliases are not in frozen stable order')
        if (sourceResultPath)
          fail('Unexpected H5a UI source result should use the pinned H4e cache')
        const sourceWidth = candidate.sourceWidth
        const sourceHeight = candidate.sourceHeight
        if (!sourceWidth || !sourceHeight) fail('H4e cached source dimensions are missing')
        masks.push({
          family: 'U',
          sourceFamily: candidate.sourceFamily,
          sourceAlias: candidate.id,
          sourceMaskPath: path,
          sourceMaskSha256: candidate.sha256,
          expectedBox: candidate.expectedBox,
        })
      }
      const sourceWidth = h4eCandidates[0]?.sourceWidth ?? 0
      const sourceHeight = h4eCandidates[0]?.sourceHeight ?? 0
      for (const candidate of h4eCandidates) {
        if (candidate.sourceWidth !== sourceWidth || candidate.sourceHeight !== sourceHeight)
          fail('H4e source dimensions changed within one cache')
      }
      outputCases.push({
        caseId,
        target: freezeCase.target,
        sourcePath: frozenSourcePath,
        sourceSha256: freezeCase.source.sha256,
        width: sourceWidth,
        height: sourceHeight,
        nativeGenerationMs,
        masks,
      })
    }
    if (runCase.dino_candidates.length > 36 || omniCandidates.length > 36 || masks.length > 72)
      fail(`H5 candidate-family ceiling exceeded for ${caseId}`)
    if (runCase.packed_mask_bytes_combined > 19 * 1024 * 1024)
      fail(`H5 packed-mask ceiling exceeded for ${caseId}`)
    for (const { sourceMaskPath, sourceMaskSha256 } of masks) {
      const path = resolve(sourceMaskPath)
      closure.push({ path, sha256: sourceMaskSha256 })
    }
    closure.push(
      { path: frozenSourcePath, sha256: freezeCase.source.sha256 },
      { path: h4eRunRealPath, sha256: H4E_RUN_SHA256 },
    )
  }
  const uniqueClosure = [
    ...new Map(closure.map((item) => [`${item.path}:${item.sha256}`, item])).values(),
  ]
  return { cases: outputCases, closure: uniqueClosure }
}

function errorCode(error: unknown): string {
  if (error instanceof ClassifierError) return error.code
  return error instanceof Error ? error.name.slice(0, 64) : 'UNKNOWN_ERROR'
}
function validateRuntimeOptions(options: H5bReplayOptions): void {
  if (!options || !options.recorder || !options.budget || !options.route)
    throw new ClassifierError(
      'INVALID_INPUT',
      'H5b replay requires caller-owned recorder, budget, and route',
    )
  if (
    options.budget.maxPhysicalCalls !== 36 ||
    options.budget.maxCostUsd !== 2 ||
    options.budget.unknownReserveUsd !== 0.1
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'H5b replay requires the frozen 36-call/$2/$0.10 budget',
    )
  if (
    Object.keys(routeExpected).some(
      (key) =>
        options.route[key as keyof H5Route] !== routeExpected[key as keyof typeof routeExpected],
    )
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'H5b replay route must be explicit OpenAI Luna Decisions without fallbacks',
    )
  if (!options.recorder.port || typeof options.recorder.port.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'H5b replay requires a recorded DecisionPort')
}

export async function runH5bPaidReplay(
  options: H5bReplayOptions,
): Promise<Record<string, unknown>> {
  validateRuntimeOptions(options)
  if (
    options.budget.snapshot().admittedPhysicalCalls !== 0 ||
    options.recorder.calls.length !== 0 ||
    options.recorder.logicalCalls.length !== 0
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'H5b requires a fresh run-scoped recorder and budget',
    )
  const outputDirectory = resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: false })
  const casesDirectory = resolve(outputDirectory, 'cases')
  await mkdir(casesDirectory, { recursive: false })
  const parentSignal = options.signal ?? new AbortController().signal
  const preflightController = new AbortController()
  const preflightTimer = setTimeout(
    () =>
      preflightController.abort(new ClassifierError('TIMEOUT', 'H5b preflight deadline exceeded')),
    caseDeadlineMs,
  )
  const preflightSignal = AbortSignal.any([parentSignal, preflightController.signal])
  let loaded: Awaited<ReturnType<typeof loadFrozenCases>>
  let executableSource: Awaited<ReturnType<typeof captureH5ReplaySource>>
  try {
    loaded = await loadFrozenCases(options.h5aDirectory, options.h4eDirectory, preflightSignal)
    for (const artifact of loaded.closure) {
      if ((await hashFile(artifact.path, preflightSignal)) !== artifact.sha256)
        throw new ClassifierError(
          'INVALID_INPUT',
          'H5 native source changed before dispatch freeze',
        )
    }
    executableSource = await captureH5ReplaySource(options.repositoryRoot, preflightSignal)
  } finally {
    clearTimeout(preflightTimer)
  }
  const freeze = {
    schema: 'v03-h5b-paid-replay-freeze-v1',
    status: 'frozen-before-replay',
    h5a: {
      run_sha256: H5A_RUN_SHA256,
      freeze_sha256: H5A_FREEZE_SHA256,
      postrun_integrity_sha256: H5A_INTEGRITY_SHA256,
      worker_closure_sha256: H5A_WORKER_CLOSURE_SHA256,
      h3b_run_sha256: H3B_RUN_SHA256,
      h4e_run_sha256: H4E_RUN_SHA256,
    },
    source_closure: loaded.closure,
    executable_source: executableSource,
    route: { ...options.route },
    budget: { max_physical_calls: 36, max_cost_usd: 2, unknown_reserve_usd: 0.1 },
    limits: {
      calls_per_case: 3,
      total_calls: 36,
      image_parts_per_nomination: 7,
      final_image_parts: 9,
      images_per_case_deadline_ms: caseDeadlineMs,
    },
    case_ids: expectedIds,
  }
  await writeFile(resolve(outputDirectory, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, {
    flag: 'wx',
  })
  const initialPhysicalCount = options.recorder.calls.length
  const initialLogicalCount = options.recorder.logicalCalls.length
  const logicalReceipts: LogicalReceipt[] = []
  const runCases: Array<Record<string, unknown>> = []
  const startedRun = performance.now()
  const presentation = options.presentation ?? createSharpH5Presentation()
  const imageState = options.imageState ?? createSharpRaster().imageState
  const composer = createH5ProposalComposer({
    decision: options.recorder.port,
    imageState,
    presentation,
    budgetRecord: {
      admit({ stage, callOrdinal, requestSha256, signal }) {
        assertActive(signal)
        assertActive(parentSignal)
        if (callOrdinal > 3) throw new ClassifierError('RESOURCE_LIMIT', 'H5 call count exceeded')
        logicalReceipts.push({
          case_id: currentCaseId,
          stage,
          callOrdinal,
          requestSha256,
          admittedAt: new Date().toISOString(),
          outcome: 'pending',
        })
      },
      settle({ stage, requestSha256, outcome, metadata, errorCode: code }) {
        const receipt = logicalReceipts.findLast(
          (item) =>
            item.stage === stage &&
            item.requestSha256 === requestSha256 &&
            item.outcome === 'pending',
        )
        if (!receipt)
          throw new ClassifierError(
            'INVALID_INPUT',
            'H5 logical settlement has no matching admission',
          )
        receipt.outcome = outcome
        if (metadata) receipt.metadata = metadata
        if (code) receipt.errorCode = code
      },
    },
  })
  let currentCaseId = ''
  for (const item of loaded.cases) {
    currentCaseId = item.caseId
    const caseDirectory = resolve(casesDirectory, item.caseId)
    await mkdir(caseDirectory, { recursive: false })
    const caseStarted = performance.now()
    const controller = new AbortController()
    const deadline = setTimeout(
      () => controller.abort(new ClassifierError('TIMEOUT', 'H5b case exceeded 240 seconds')),
      caseDeadlineMs,
    )
    deadline.unref?.()
    const signal = AbortSignal.any([parentSignal, controller.signal])
    const physicalStart = options.recorder.calls.length
    const logicalStart = logicalReceipts.length
    let image: RgbaRaster | undefined
    const loadedMasks: Array<LoadedMaskDescriptor & { mask: PackedBinaryMask }> = []
    let status: string = 'error'
    let composerResult: Awaited<ReturnType<typeof composer.compose>> | undefined
    let failure: { code: string; message: string } | undefined
    const roster = item.masks.map((candidate, index) => ({
      family: candidate.family,
      composer_alias: `${candidate.family}${String(item.masks.filter((mask) => mask.family === candidate.family).indexOf(candidate)).padStart(2, '0')}`,
      source_family: candidate.sourceFamily,
      source_alias: candidate.sourceAlias,
      source_mask_path: relative(resolve(options.h5aDirectory), candidate.sourceMaskPath),
      candidate_mask_sha256: candidate.sourceMaskSha256,
      roster_ordinal: index,
    }))
    const preparationStarted = performance.now()
    let preparationElapsedMs: number | null = null
    let compositionElapsedMs: number | null = null
    try {
      assertActive(signal)
      const sourceBytes = await readFile(item.sourcePath)
      try {
        assertActive(signal)
        if (hash(sourceBytes) !== item.sourceSha256)
          fail(`H5 source changed before replay: ${item.caseId}`)
        const normalized = await createSharpRaster().normalize(new Uint8Array(sourceBytes), signal)
        const raw = await sharp(normalized.bytes, { limitInputPixels: limits.imagePixels })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        try {
          if (
            raw.info.width !== item.width ||
            raw.info.height !== item.height ||
            raw.info.channels !== 4
          )
            fail(`H5 source dimensions changed before replay: ${item.caseId}`)
          image = {
            data: Uint8Array.from(raw.data),
            width: raw.info.width,
            height: raw.info.height,
            format: 'rgba8',
          }
          item.width = raw.info.width
          item.height = raw.info.height
        } finally {
          raw.data.fill(0)
          normalized.bytes.fill(0)
        }
      } finally {
        sourceBytes.fill(0)
      }
      if (item.width < 1 || item.height < 1)
        throw new ClassifierError('INVALID_INPUT', 'H5 source dimensions are missing')
      for (const candidate of item.masks) {
        const mask = await loadMask(candidate, item.width, item.height, signal)
        loadedMasks.push({ ...candidate, mask })
      }
      const packedBytes = loadedMasks.reduce(
        (sum, candidate) => sum + candidate.mask.data.byteLength,
        0,
      )
      if (packedBytes > 19 * 1024 * 1024)
        throw new ClassifierError('RESOURCE_LIMIT', 'H5 packed mask bytes exceed 19 MiB')
      preparationElapsedMs = performance.now() - preparationStarted
      const families: Record<H5Family, H5ProposalCandidate[]> = { D: [], U: [] }
      for (const candidate of loadedMasks)
        families[candidate.family].push({ id: candidate.sourceAlias, mask: candidate.mask })
      const compositionStarted = performance.now()
      const composition = await composer.compose({
        image,
        target: item.target,
        exclusions: [],
        families,
        signal,
      })
      composerResult = composition
      compositionElapsedMs = performance.now() - compositionStarted
      status = composition.status
      if (composition.status === 'located') {
        const selectedRoster = roster.find((entry) => entry.composer_alias === composition.alias)
        const selectedInput = loadedMasks.find(
          (candidate) =>
            candidate.family === composition.family &&
            candidate.sourceAlias === composition.sourceAlias,
        )
        if (!selectedRoster || !selectedInput)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'H5 selected alias has no frozen source mask',
          )
        const unpacked = unpackBinaryMask(composition.mask)
        const pngPixels = Uint8Array.from(unpacked, (pixel) => pixel * 255)
        const maskPng = await sharp(pngPixels, {
          raw: { width: item.width, height: item.height, channels: 1 },
          limitInputPixels: limits.imagePixels,
        })
          .png({ compressionLevel: 9, adaptiveFiltering: false })
          .toBuffer()
        try {
          const outputPath = resolve(caseDirectory, 'selected-mask.png')
          await writeFile(outputPath, maskPng, { flag: 'wx' })
          runCases.push({
            case_id: item.caseId,
            target: item.target,
            source_sha256: item.sourceSha256,
            source_width: item.width,
            source_height: item.height,
            status,
            native_generation_ms: item.nativeGenerationMs,
            replay_elapsed_ms: performance.now() - caseStarted,
            preparation_elapsed_ms: preparationElapsedMs,
            composition_elapsed_ms: compositionElapsedMs,
            candidate_roster: roster,
            nominations: composition.nominations.map((entry) => ({
              family: entry.family,
              top_four: entry.topFour,
              nominee_aliases: entry.nomineeAliases,
              selection: entry.selection,
              metadata: entry.metadata,
            })),
            selected_alias: composition.alias,
            selected_family: composition.family,
            source_family: selectedRoster.source_family,
            source_alias: composition.sourceAlias,
            candidate_mask_sha256: selectedInput.sourceMaskSha256,
            selected_region: composition.region,
            selected_mask_path: relative(outputDirectory, outputPath),
            selected_mask_sha256: hash(maskPng),
            final_selection: composition.finalSelection,
            final_metadata: composition.finalMetadata,
            physical_call_count: options.recorder.calls.length - physicalStart,
            logical_calls: logicalReceipts.slice(logicalStart),
            error_code: null,
          })
        } finally {
          unpacked.fill(0)
          pngPixels.fill(0)
          maskPng.fill(0)
        }
      } else {
        runCases.push({
          case_id: item.caseId,
          target: item.target,
          source_sha256: item.sourceSha256,
          source_width: item.width,
          source_height: item.height,
          status,
          native_generation_ms: item.nativeGenerationMs,
          replay_elapsed_ms: performance.now() - caseStarted,
          preparation_elapsed_ms: preparationElapsedMs,
          composition_elapsed_ms: compositionElapsedMs,
          candidate_roster: roster,
          nominations: composition.nominations.map((entry) => ({
            family: entry.family,
            top_four: entry.topFour,
            nominee_aliases: entry.nomineeAliases,
            selection: entry.selection,
            metadata: entry.metadata,
          })),
          selected_alias: null,
          selected_family: null,
          source_family: null,
          source_alias: null,
          candidate_mask_sha256: null,
          selected_region: null,
          selected_mask_path: null,
          selected_mask_sha256: null,
          final_selection: composerResult.finalSelection,
          final_metadata: composerResult.finalMetadata,
          unknown_reason: composition.reason,
          physical_call_count: options.recorder.calls.length - physicalStart,
          logical_calls: logicalReceipts.slice(logicalStart),
          error_code: null,
        })
      }
    } catch (error) {
      failure = {
        code: errorCode(error),
        message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown replay error',
      }
      status = signal.aborted ? 'timeout' : 'error'
      runCases.push({
        case_id: item.caseId,
        target: item.target,
        source_sha256: item.sourceSha256,
        source_width: item.width,
        source_height: item.height,
        status,
        native_generation_ms: item.nativeGenerationMs,
        replay_elapsed_ms: performance.now() - caseStarted,
        preparation_elapsed_ms: preparationElapsedMs ?? performance.now() - preparationStarted,
        composition_elapsed_ms: compositionElapsedMs,
        candidate_roster: roster,
        nominations: [],
        selected_alias: null,
        selected_family: null,
        source_family: null,
        source_alias: null,
        candidate_mask_sha256: null,
        selected_region: null,
        selected_mask_path: null,
        selected_mask_sha256: null,
        final_selection: null,
        final_metadata: null,
        unknown_reason: null,
        physical_call_count: options.recorder.calls.length - physicalStart,
        logical_calls: logicalReceipts.slice(logicalStart),
        error_code: failure.code,
        error_message: failure.message,
      })
    } finally {
      clearTimeout(deadline)
      image?.data.fill(0)
      for (const candidate of loadedMasks) candidate.mask.data.fill(0)
      if (composerResult?.status === 'located') composerResult.mask.data.fill(0)
    }
    const casePhysicalCalls = options.recorder.calls.length - physicalStart
    if (
      casePhysicalCalls > 3 ||
      options.recorder.calls.length - initialPhysicalCount > 36 ||
      options.budget.snapshot().admittedPhysicalCalls > 36
    )
      throw new ClassifierError('RESOURCE_LIMIT', 'H5b physical call ceiling exceeded')
    await writeFile(
      resolve(outputDirectory, 'progress.json'),
      `${JSON.stringify({ schema: 'v03-h5b-paid-replay-progress-v1', status: 'running', case_ids: expectedIds, completed_rows: runCases, physical_call_count: options.recorder.calls.length - initialPhysicalCount, logical_call_count: logicalReceipts.length }, null, 2)}\n`,
    )
  }
  const routeReceipts = options.recorder.calls.slice(initialPhysicalCount)
  if (
    routeReceipts.some(
      (call) =>
        call.route.model !== H5_MODEL ||
        call.route.provider !== 'openai' ||
        call.route.providerName !== 'OpenAI' ||
        call.route.apiEndpoint !== '/api/alpha/decisions' ||
        call.route.allowFallbacks !== false,
    )
  )
    throw new ClassifierError('INVALID_INPUT', 'A physical request escaped the frozen H5 route')
  const afterController = new AbortController()
  const afterTimer = setTimeout(
    () =>
      afterController.abort(new ClassifierError('TIMEOUT', 'H5 source rehash deadline exceeded')),
    30_000,
  )
  let executableSourceAfter: Awaited<ReturnType<typeof captureH5ReplaySource>>
  try {
    for (const artifact of loaded.closure) {
      if ((await hashFile(artifact.path, afterController.signal)) !== artifact.sha256)
        throw new ClassifierError('INVALID_INPUT', 'H5 native source changed during replay')
    }
    executableSourceAfter = await captureH5ReplaySource(
      options.repositoryRoot,
      afterController.signal,
    )
  } finally {
    clearTimeout(afterTimer)
  }
  if (executableSourceAfter.sha256 !== executableSource.sha256)
    throw new ClassifierError('INVALID_INPUT', 'H5 executable source changed during replay')
  const snapshot = options.budget.snapshot()
  const record = {
    schema: 'v03-h5b-paid-replay-run-v1',
    status: 'complete',
    case_ids: expectedIds,
    route: { ...options.route },
    h5a: {
      run_sha256: H5A_RUN_SHA256,
      freeze_sha256: H5A_FREEZE_SHA256,
      postrun_integrity_sha256: H5A_INTEGRITY_SHA256,
      worker_closure_sha256: H5A_WORKER_CLOSURE_SHA256,
      h3b_run_sha256: H3B_RUN_SHA256,
      h4e_run_sha256: H4E_RUN_SHA256,
    },
    source_closure: loaded.closure,
    executable_source: executableSource,
    executable_source_after: executableSourceAfter,
    budget: {
      admitted_physical_calls: snapshot.admittedPhysicalCalls,
      known_cost_usd: snapshot.knownCostUsd,
      unknown_cost_calls: snapshot.unknownCostCalls,
      in_flight_calls: snapshot.inFlightCalls,
      accounted_exposure_usd: snapshot.accountedExposureUsd,
      max_physical_calls: snapshot.maxPhysicalCalls,
      max_cost_usd: snapshot.maxCostUsd,
      unknown_reserve_usd_per_call: options.budget.unknownReserveUsd,
    },
    physical_call_count: options.recorder.calls.length - initialPhysicalCount,
    logical_call_count: logicalReceipts.length,
    physical_calls: routeReceipts,
    logical_calls: [...options.recorder.logicalCalls.slice(initialLogicalCount)],
    logical_stage_receipts: logicalReceipts,
    replay_elapsed_ms: performance.now() - startedRun,
    rows: runCases,
  }
  if (
    runCases.length !== expectedIds.length ||
    JSON.stringify(runCases.map((row) => row.case_id)) !== JSON.stringify(expectedIds)
  )
    throw new ClassifierError('INVALID_RESPONSE', 'H5b runner did not preserve every fixed row')
  await writeFile(resolve(outputDirectory, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
  })
  await writeFile(
    resolve(outputDirectory, 'progress.json'),
    `${JSON.stringify({ schema: 'v03-h5b-paid-replay-progress-v1', status: 'complete', case_ids: expectedIds, completed_rows: runCases, physical_call_count: record.physical_call_count, logical_call_count: logicalReceipts.length }, null, 2)}\n`,
  )
  return record
}
