import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import type {
  DecisionMetadata,
  DecisionPort,
  DecisionRequest,
  PixelRect,
  RasterImage,
} from '../../src/entities/contracts.js'
import { limits } from '../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import { createSegmentationBoxCheck } from '../../src/features/segmentation/box-check.js'
import { maskedRgba } from '../../src/features/segmentation/mask.js'
import { createOpenRouterDecisions } from '../../src/openrouter.js'
import { createSharpCutoutRaster } from '../../src/infrastructure/segmentation/cutout-raster.js'
import { createSharpSegmentationBoxPresentation } from '../../src/infrastructure/segmentation/box-presentation.js'
import { createSharpRaster, readCanonicalPixels } from '../../src/infrastructure/raster.js'
import { RunBudget } from '../v02/budget.js'
import { recordProvider, type Recorder } from '../v02/recording.js'
import { hashCanonical } from '../v02/protocol.js'
import {
  createGroundedMaskSelector,
  type GroundedMaskCandidate,
  type GroundedMaskSelection,
} from './grounded-mask-selector.js'
import { createH3cVerifier, type H3cVerificationResult } from './h3c-verifier.js'
import type { SegmentationBoxCheckResult } from '../../src/entities/segmentation-verification.js'

// This isolated benchmark process loads one case at a time; keep libvips caches bounded.
sharp.cache({ memory: 32, files: 0, items: 0 })
sharp.concurrency(1)

export const GROUNDED_MASK_RUN_SHA256 =
  'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401'
export const GROUNDED_MASK_RUN_RELATIVE = '.run/v03/grounded-proposals-h3-run-02'
export const GROUNDED_MASK_MODEL = 'openai/gpt-6-luna-decisions'
export const GROUNDED_MASK_CASE_DEADLINE_MS = 120_000

const expectedIds = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]
const runSchema = z
  .object({
    schema: z.literal('v03-grounded-proposals-probe-v1'),
    status: z.literal('complete'),
    cohort: z.literal('fixed-v03-dev-12-effc2e8'),
    candidate_semantics: z.string(),
    case_ids: z.array(z.string()),
    cases: z.array(
      z.object({
        case_id: z.string(),
        row_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        status: z.string(),
        elapsed_ms: z.number().finite().nonnegative(),
      }),
    ),
    image_root: z.string(),
    manifest_sha256: z.record(z.string().regex(/^[a-f0-9]{64}$/u)),
    model_assets: z
      .object({
        files: z.array(
          z.object({
            repo: z.string(),
            revision: z.string(),
            filename: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            size: z.number().int().positive(),
            directory: z.string(),
          }),
        ),
      })
      .passthrough(),
    source_freeze: z.object({
      producer_script_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      environment_freeze_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  })
  .passthrough()

const manifestCaseSchema = z
  .object({
    caseId: z.string(),
    image: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
    locate: z.object({ target: z.string().min(1).max(200) }).passthrough(),
  })
  .passthrough()
const manifestSchema = z.array(manifestCaseSchema)

const rowSchema = z
  .object({
    case_id: z.string(),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    source_dimensions: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    authored_target: z.string().min(1).max(200),
    detector_candidate_count: z.number().int().min(0).max(36),
    candidate_cap: z.literal(36),
    mask_candidates: z
      .array(
        z
          .object({
            id: z.string().regex(/^C(?:0[0-9]|[12][0-9]|3[0-5])$/u),
            mask_path: z.string(),
            mask_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            mask_box_xyxy: z.tuple([
              z.number().int().nonnegative(),
              z.number().int().nonnegative(),
              z.number().int().positive(),
              z.number().int().positive(),
            ]),
          })
          .passthrough(),
      )
      .max(36),
  })
  .passthrough()

export interface GroundedMaskPilotOptions {
  repositoryRoot: string
  dataRoot: string
  outputDirectory: string
  dispatch?: boolean
  decision?: DecisionPort
  recorder?: Recorder
  budget?: RunBudget
  signal?: AbortSignal
  /** Test hook. It does not change the default closed fixed cohort. */
  caseLimit?: number
  now?: () => number
  /** Benchmark-only verifier choice. H3b remains the default frozen profile. */
  verificationProfile?: 'h3b' | 'h3c'
}

interface LoadedCandidate extends GroundedMaskCandidate {
  maskSha256: string
}

interface CandidateDescriptor {
  alias: string
  maskPath: string
  maskSha256: string
  box: PixelRect
}

interface CaseDescriptor {
  caseId: string
  target: string
  nativeElapsedMs: number
  sourcePath: string
  sourceSha256: string
  width: number
  height: number
  candidateDescriptors: CandidateDescriptor[]
}

interface LoadedCase extends CaseDescriptor {
  image: RasterImage
  candidates: LoadedCandidate[]
}

interface LoadedInputs {
  cases: CaseDescriptor[]
  nativeArtifacts: Array<{ path: string; sha256: string }>
}

interface CaseResult {
  caseId: string
  status:
    | 'dry-run'
    | 'no-candidates'
    | 'none'
    | 'complete'
    | 'needs-expansion'
    | 'unknown'
    | 'error'
  target: string
  sourceSha256: string
  candidateCount: number
  selectedAlias: string | null
  selection: GroundedMaskSelection['selection'] | null
  selectionMetadata: DecisionMetadata | null
  boxCheck: unknown
  errorCode: string | null
  elapsedMs: number
  nativeElapsedMs: number
  candidatePresentationMs: number | null
  selectionProviderMs: number | null
  boxCheckProviderMs: number | null
  boxCheckElapsedMs: number | null
  cutoutElapsedMs: number | null
  physicalCallCount: number
  requestSha256: string | null
  candidateTransforms: Array<{ alias: string; crop: PixelRect }> | null
  files: {
    mask: string | null
    maskSha256: string | null
    cutout: string | null
    cutoutSha256: string | null
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  const digest = createHash('sha256')
  try {
    for await (const chunk of stream) digest.update(chunk)
    return digest.digest('hex')
  } finally {
    stream.destroy()
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await walkFiles(path)))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

async function producerFreeze(
  root: string,
  verificationProfile: 'h3b' | 'h3c' = 'h3b',
): Promise<{ sha256: string; files: Array<{ path: string; sha256: string }> }> {
  const src = (await walkFiles(join(root, 'src'))).map((path) => relative(root, path))
  const tracked = [
    ...src,
    'benchmarks/v03/grounded-proposals-probe.py',
    'benchmarks/v03/grounded-mask-selector.ts',
    'benchmarks/v03/run-grounded-mask-pilot.ts',
    'benchmarks/v02/recording.ts',
    'benchmarks/v02/budget.ts',
    'benchmarks/v02/protocol.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ]
  if (verificationProfile === 'h3c') tracked.push('benchmarks/v03/h3c-verifier.ts')
  const files: Array<{ path: string; sha256: string }> = []
  for (const path of [...new Set(tracked)].sort()) {
    const fullPath = join(root, path)
    files.push({ path, sha256: await hashFile(fullPath) })
  }
  return { sha256: hashCanonical(files), files }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function loadFrozenInputs(
  root: string,
  dataRoot: string,
  runDirectory: string,
): Promise<LoadedInputs> {
  const runPath = join(runDirectory, 'run.json')
  const nativeArtifacts: Array<{ path: string; sha256: string }> = []
  const runSha256 = await hashFile(runPath)
  if (runSha256 !== GROUNDED_MASK_RUN_SHA256)
    throw new ClassifierError('INVALID_INPUT', 'Pinned H3 run manifest hash mismatch')
  nativeArtifacts.push({ path: runPath, sha256: runSha256 })
  const run = runSchema.parse(await readJson(runPath))
  if (
    JSON.stringify(run.case_ids) !== JSON.stringify(expectedIds) ||
    JSON.stringify(run.cases.map((entry) => entry.case_id)) !== JSON.stringify(expectedIds) ||
    run.cases.some((entry) => entry.status !== 'complete') ||
    run.source_freeze.producer_script_sha256 !==
      '7695cb42cd6e4e583f6cb5bab08d93d40c18d08c188651948b4fed0b43fdc8b5'
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Pinned H3 run closure is incomplete or inconsistent',
    )
  const scriptPath = join(root, 'benchmarks/v03/grounded-proposals-probe.py')
  if ((await hashFile(scriptPath)) !== run.source_freeze.producer_script_sha256)
    throw new ClassifierError('INVALID_INPUT', 'Pinned H3 producer source hash mismatch')
  const assetsRoot = resolve(dataRoot, '..', 'zorya-classifier-models', 'v03')
  const freezePath = join(assetsRoot, 'python-freeze.txt')
  if ((await hashFile(freezePath)) !== run.source_freeze.environment_freeze_sha256)
    throw new ClassifierError('INVALID_INPUT', 'Pinned H3 environment hash mismatch')
  nativeArtifacts.push(
    { path: scriptPath, sha256: run.source_freeze.producer_script_sha256 },
    { path: freezePath, sha256: run.source_freeze.environment_freeze_sha256 },
  )
  for (const asset of run.model_assets.files) {
    if (!/^[A-Za-z0-9._-]+$/u.test(asset.directory) || !/^[A-Za-z0-9._-]+$/u.test(asset.filename))
      throw new ClassifierError('INVALID_INPUT', 'Unsafe pinned asset path')
    const path = join(assetsRoot, asset.directory, asset.filename)
    const assetStat = await stat(path)
    if (assetStat.size !== asset.size || (await hashFile(path)) !== asset.sha256)
      throw new ClassifierError('INVALID_INPUT', 'Pinned H3 model asset mismatch')
    nativeArtifacts.push({ path, sha256: asset.sha256 })
  }
  const inputDirectory = join(dataRoot, 'benchmarks/v03/pilot-inputs')
  const inputs: Array<z.infer<typeof manifestSchema>> = []
  for (const file of ['photo.json', 'ui.json', 'map.json']) {
    const path = join(inputDirectory, file)
    const manifestSha256 = await hashFile(path)
    if (manifestSha256 !== run.manifest_sha256[file])
      throw new ClassifierError('INVALID_INPUT', 'Pinned twelve-case input manifest mismatch')
    nativeArtifacts.push({ path, sha256: manifestSha256 })
    inputs.push(manifestSchema.parse(await readJson(path)))
  }
  const authored = new Map(
    inputs.flatMap((manifest) => manifest.map((item) => [item.caseId, item] as const)),
  )
  const imageRoot = resolve(run.image_root)
  const loaded: CaseDescriptor[] = []
  for (const expectedId of expectedIds) {
    const manifestCase = authored.get(expectedId)
    const runCase = run.cases.find((item) => item.case_id === expectedId)
    if (!manifestCase || !runCase) throw new ClassifierError('INVALID_INPUT', 'Missing frozen case')
    const rowPath = join(runDirectory, 'cases', `${expectedId}.json`)
    const rowSha256 = await hashFile(rowPath)
    if (rowSha256 !== runCase.row_sha256)
      throw new ClassifierError('INVALID_INPUT', 'Pinned H3 case row hash mismatch')
    nativeArtifacts.push({ path: rowPath, sha256: rowSha256 })
    const row = rowSchema.parse(await readJson(rowPath))
    if (row.case_id !== expectedId || row.authored_target !== manifestCase.locate.target)
      throw new ClassifierError('INVALID_INPUT', 'H3 row does not match authored input')
    const sourcePath = resolve(imageRoot, manifestCase.image.path)
    if (
      !inside(imageRoot, sourcePath) ||
      (await hashFile(sourcePath)) !== manifestCase.image.sha256 ||
      row.source_sha256 !== manifestCase.image.sha256
    )
      throw new ClassifierError('INVALID_INPUT', 'Frozen source image hash mismatch')
    nativeArtifacts.push({ path: sourcePath, sha256: manifestCase.image.sha256 })
    const source = await readFile(sourcePath)
    let dimensions: { width: number; height: number }
    try {
      const image = await createSharpRaster().normalize(
        new Uint8Array(source),
        new AbortController().signal,
      )
      dimensions = { width: image.width, height: image.height }
      image.bytes.fill(0)
    } finally {
      source.fill(0)
    }
    if (
      dimensions.width !== row.source_dimensions.width ||
      dimensions.height !== row.source_dimensions.height
    )
      throw new ClassifierError('INVALID_INPUT', 'Source image dimensions differ from native run')
    const candidateDescriptors: CandidateDescriptor[] = []
    for (const native of row.mask_candidates) {
      const maskPath = resolve(runDirectory, native.mask_path)
      if (!inside(runDirectory, maskPath))
        throw new ClassifierError('INVALID_INPUT', 'Unsafe native mask path')
      const rawMask = await readFile(maskPath)
      try {
        if (sha256(rawMask) !== native.mask_sha256)
          throw new ClassifierError('INVALID_INPUT', 'Pinned native mask hash mismatch')
        const decoded = await sharp(rawMask, { limitInputPixels: limits.imagePixels })
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true })
        try {
          if (
            decoded.info.width !== dimensions.width ||
            decoded.info.height !== dimensions.height ||
            decoded.info.channels !== 1
          )
            throw new ClassifierError('INVALID_INPUT', 'Native mask dimensions mismatch source')
          let left = dimensions.width
          let top = dimensions.height
          let right = -1
          let bottom = -1
          for (let index = 0; index < decoded.data.length; index++) {
            const pixel = decoded.data[index]
            if (pixel !== 0 && pixel !== 255)
              throw new ClassifierError('INVALID_INPUT', 'Native mask is not binary PNG')
            if (pixel === 255) {
              const x = index % dimensions.width
              const y = Math.floor(index / dimensions.width)
              left = Math.min(left, x)
              top = Math.min(top, y)
              right = Math.max(right, x)
              bottom = Math.max(bottom, y)
            }
          }
          if (
            right < left ||
            left !== native.mask_box_xyxy[0] ||
            top !== native.mask_box_xyxy[1] ||
            right + 1 !== native.mask_box_xyxy[2] ||
            bottom + 1 !== native.mask_box_xyxy[3]
          )
            throw new ClassifierError(
              'INVALID_INPUT',
              'Native declared mask box differs from foreground pixels',
            )
        } finally {
          decoded.data.fill(0)
        }
      } finally {
        rawMask.fill(0)
      }
      const box = {
        left: native.mask_box_xyxy[0],
        top: native.mask_box_xyxy[1],
        width: native.mask_box_xyxy[2] - native.mask_box_xyxy[0],
        height: native.mask_box_xyxy[3] - native.mask_box_xyxy[1],
      }
      candidateDescriptors.push({ alias: native.id, maskPath, maskSha256: native.mask_sha256, box })
      nativeArtifacts.push({ path: maskPath, sha256: native.mask_sha256 })
    }
    if (candidateDescriptors.length !== row.detector_candidate_count)
      throw new ClassifierError('INVALID_INPUT', 'Native candidate count mismatch')
    if (
      new Set(candidateDescriptors.map((candidate) => candidate.alias)).size !==
      candidateDescriptors.length
    )
      throw new ClassifierError('INVALID_INPUT', 'Native candidate aliases are not unique')
    loaded.push({
      caseId: expectedId,
      target: manifestCase.locate.target,
      nativeElapsedMs: runCase.elapsed_ms,
      sourcePath,
      sourceSha256: manifestCase.image.sha256,
      width: dimensions.width,
      height: dimensions.height,
      candidateDescriptors,
    })
  }
  return { cases: loaded, nativeArtifacts }
}

async function loadCaseBuffers(
  descriptor: CaseDescriptor,
  signal: AbortSignal,
): Promise<LoadedCase> {
  assertActive(signal)
  const source = await readFile(descriptor.sourcePath)
  assertActive(signal)
  let image: RasterImage
  try {
    if (sha256(source) !== descriptor.sourceSha256)
      throw new ClassifierError('INVALID_INPUT', 'Source image changed after preflight')
    image = await createSharpRaster().normalize(new Uint8Array(source), signal)
    assertActive(signal)
  } finally {
    source.fill(0)
  }
  const candidates: LoadedCandidate[] = []
  try {
    if (image.width !== descriptor.width || image.height !== descriptor.height)
      throw new ClassifierError('INVALID_INPUT', 'Source dimensions changed after preflight')
    for (const native of descriptor.candidateDescriptors) {
      const rawMask = await readFile(native.maskPath)
      assertActive(signal)
      try {
        if (sha256(rawMask) !== native.maskSha256)
          throw new ClassifierError('INVALID_INPUT', 'Native mask changed after preflight')
        const decoded = await sharp(rawMask, { limitInputPixels: limits.imagePixels })
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true })
        try {
          assertActive(signal)
          if (
            decoded.info.width !== descriptor.width ||
            decoded.info.height !== descriptor.height ||
            decoded.info.channels !== 1
          )
            throw new ClassifierError(
              'INVALID_INPUT',
              'Native mask dimensions changed after preflight',
            )
          const data = new Uint8Array(decoded.data.length)
          for (let index = 0; index < decoded.data.length; index++) {
            const pixel = decoded.data[index]
            if (pixel !== 0 && pixel !== 255)
              throw new ClassifierError('INVALID_INPUT', 'Native mask is no longer binary')
            data[index] = pixel === 255 ? 1 : 0
          }
          candidates.push({
            alias: native.alias,
            box: { ...native.box },
            mask: {
              data,
              width: descriptor.width,
              height: descriptor.height,
              format: 'binary-u8',
            },
            maskSha256: native.maskSha256,
          })
        } finally {
          decoded.data.fill(0)
        }
      } finally {
        rawMask.fill(0)
      }
    }
    return { ...descriptor, image, candidates }
  } catch (error) {
    image.bytes.fill(0)
    for (const candidate of candidates) candidate.mask.data.fill(0)
    throw error
  }
}

function sourceWitness(mask: BinaryMaskLike): { x: number; y: number } {
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) if (mask.data[y * mask.width + x] === 1) return { x, y }
  }
  throw new ClassifierError('INVALID_INPUT', 'Selected native mask has no foreground pixel')
}

type BinaryMaskLike = GroundedMaskCandidate['mask']

function boxCheckDecision(decision: DecisionPort): DecisionPort {
  return {
    async decide(request: DecisionRequest, signal: AbortSignal) {
      const state = request.state.map((part) =>
        typeof part === 'string'
          ? part.replace(
              'The magenta outline is the mask-derived box. The cyan cross marks the original seed of one target instance. Other instances do not count.',
              'The magenta outline is the mask-derived box. The cyan cross marks a one-pixel witness selected deterministically from foreground pixels in the same supplied candidate mask; it is not a prior grid seed. Other instances do not count.',
            )
          : part,
      )
      return decision.decide({ ...request, state }, signal)
    },
  }
}

async function runCase(
  input: LoadedCase,
  decision: DecisionPort,
  outputDirectory: string,
  signal: AbortSignal,
  now: () => number,
  verificationProfile: 'h3b' | 'h3c' = 'h3b',
): Promise<CaseResult> {
  const started = now()
  let selectedMaskData: Uint8Array | undefined
  let rgbaData: Uint8Array | undefined
  try {
    assertActive(signal)
    if (input.candidates.length === 0)
      return {
        caseId: input.caseId,
        status: 'no-candidates',
        target: input.target,
        sourceSha256: input.sourceSha256,
        candidateCount: 0,
        selectedAlias: null,
        selection: null,
        selectionMetadata: null,
        boxCheck: null,
        errorCode: null,
        elapsedMs: now() - started,
        nativeElapsedMs: input.nativeElapsedMs,
        candidatePresentationMs: null,
        selectionProviderMs: null,
        boxCheckProviderMs: null,
        boxCheckElapsedMs: null,
        cutoutElapsedMs: null,
        physicalCallCount: 0,
        requestSha256: null,
        candidateTransforms: null,
        files: { mask: null, maskSha256: null, cutout: null, cutoutSha256: null },
      }
    const selector = createGroundedMaskSelector({
      decision,
      imageState: createSharpRaster().imageState,
    })
    const selected = await selector.select({
      image: input.image,
      target: input.target,
      candidates: input.candidates,
      signal,
    })
    if (!selected.candidate)
      return {
        caseId: input.caseId,
        status: 'none',
        target: input.target,
        sourceSha256: input.sourceSha256,
        candidateCount: input.candidates.length,
        selectedAlias: 'none',
        selection: selected.selection,
        selectionMetadata: selected.metadata,
        boxCheck: null,
        errorCode: null,
        elapsedMs: now() - started,
        nativeElapsedMs: input.nativeElapsedMs,
        candidatePresentationMs: selected.presentationMs,
        selectionProviderMs: selected.metadata.durationMs,
        boxCheckProviderMs: null,
        boxCheckElapsedMs: null,
        cutoutElapsedMs: null,
        physicalCallCount: 0,
        requestSha256: selected.requestSha256,
        candidateTransforms: selected.candidateTransforms,
        files: { mask: null, maskSha256: null, cutout: null, cutoutSha256: null },
      }
    selectedMaskData = selected.candidate.mask.data
    const rgba = await readCanonicalPixels(input.image, signal)
    rgbaData = rgba.data
    const point = sourceWitness(selected.candidate.mask)
    const region = selected.candidate.box
    const boxStarted = now()
    const checked: H3cVerificationResult | SegmentationBoxCheckResult =
      verificationProfile === 'h3c'
        ? await createH3cVerifier({ decision, imageState: createSharpRaster().imageState }).verify({
            image: { ...rgba, format: 'rgba8' },
            mask: selected.candidate.mask,
            box: region,
            alias: selected.alias,
            target: input.target,
            exclusions: [],
            signal,
          })
        : await createSegmentationBoxCheck({
            decision: boxCheckDecision(decision),
            presentation: createSharpSegmentationBoxPresentation(),
            imageState: createSharpRaster().imageState,
          }).check({
            image: { ...rgba, format: 'rgba8' },
            region,
            seedRegion: { left: point.x, top: point.y, width: 1, height: 1 },
            roi: { left: 0, top: 0, width: input.image.width, height: input.image.height },
            target: input.target,
            exclusions: [],
            signal,
          })
    const boxCheckElapsedMs = Math.max(0, now() - boxStarted)
    assertActive(signal)
    const maskPath = join(outputDirectory, `${input.caseId}-${selected.alias}-mask.png`)
    const maskPng = await sharp(selected.candidate.mask.data, {
      raw: { width: input.image.width, height: input.image.height, channels: 1 },
    })
      .linear(255, 0)
      .png()
      .toBuffer()
    const maskSha256 = sha256(maskPng)
    await writeFile(maskPath, maskPng, { flag: 'wx' })
    maskPng.fill(0)
    assertActive(signal)
    let cutoutPath: string | null = null
    let cutoutSha256: string | null = null
    let cutoutElapsedMs: number | null = null
    const isH3c = 'witness' in checked
    const completes = isH3c
      ? checked.verdict === 'match-complete-pure'
      : checked.verdict === 'complete'
    if (completes) {
      const cutoutStarted = now()
      const cutout = maskedRgba(
        { ...rgba, format: 'rgba8' },
        selected.candidate.mask,
        selected.candidate.box,
      )
      try {
        const png = await createSharpCutoutRaster().png(
          { data: cutout, width: region.width, height: region.height, format: 'rgba8' },
          signal,
        )
        cutoutPath = join(outputDirectory, `${input.caseId}-${selected.alias}-cutout.png`)
        cutoutSha256 = sha256(png)
        await writeFile(cutoutPath, png, { flag: 'wx' })
        png.fill(0)
        assertActive(signal)
      } finally {
        cutout.fill(0)
      }
      cutoutElapsedMs = Math.max(0, now() - cutoutStarted)
    }
    assertActive(signal)
    return {
      caseId: input.caseId,
      status: isH3c ? (completes ? 'complete' : 'unknown') : checked.verdict,
      target: input.target,
      sourceSha256: input.sourceSha256,
      candidateCount: input.candidates.length,
      selectedAlias: selected.alias,
      selection: selected.selection,
      selectionMetadata: selected.metadata,
      boxCheck: {
        verdict: checked.verdict,
        selection: checked.selection,
        metadata: checked.metadata,
        maskDerivedBox: isH3c ? region : completes ? region : null,
        sourceWitness: isH3c
          ? checked.witness
          : { ...point, origin: 'selected-candidate-mask-foreground' },
      },
      errorCode: null,
      elapsedMs: now() - started,
      nativeElapsedMs: input.nativeElapsedMs,
      candidatePresentationMs: selected.presentationMs,
      selectionProviderMs: selected.metadata.durationMs,
      boxCheckProviderMs: checked.metadata.durationMs,
      boxCheckElapsedMs,
      cutoutElapsedMs,
      physicalCallCount: 0,
      requestSha256: selected.requestSha256,
      candidateTransforms: selected.candidateTransforms,
      files: {
        mask: relative(outputDirectory, maskPath),
        maskSha256,
        cutout: cutoutPath ? relative(outputDirectory, cutoutPath) : null,
        cutoutSha256,
      },
    }
  } catch (error) {
    return {
      caseId: input.caseId,
      status: 'error',
      target: input.target,
      sourceSha256: input.sourceSha256,
      candidateCount: input.candidates.length,
      selectedAlias: null,
      selection: null,
      selectionMetadata: null,
      boxCheck: null,
      errorCode: error instanceof ClassifierError ? error.code : 'TECHNICAL_ERROR',
      elapsedMs: now() - started,
      nativeElapsedMs: input.nativeElapsedMs,
      candidatePresentationMs: null,
      selectionProviderMs: null,
      boxCheckProviderMs: null,
      boxCheckElapsedMs: null,
      cutoutElapsedMs: null,
      physicalCallCount: 0,
      requestSha256: null,
      candidateTransforms: null,
      files: { mask: null, maskSha256: null, cutout: null, cutoutSha256: null },
    }
  } finally {
    selectedMaskData?.fill(0)
    rgbaData?.fill(0)
    input.image.bytes.fill(0)
    for (const candidate of input.candidates) {
      candidate.mask.data.fill(0)
    }
  }
}

async function preflight(
  root: string,
  dataRoot: string,
  runDirectory: string,
  verificationProfile: 'h3b' | 'h3c',
): Promise<{
  runHash: string
  closure: { sha256: string; files: Array<{ path: string; sha256: string }> }
  artifacts: Array<{ path: string; sha256: string }>
  cases: CaseDescriptor[]
}> {
  const loaded = await loadFrozenInputs(root, dataRoot, runDirectory)
  const artifacts = loaded.nativeArtifacts
  return {
    runHash: await hashFile(join(runDirectory, 'run.json')),
    closure: await producerFreeze(root, verificationProfile),
    artifacts,
    cases: loaded.cases,
  }
}

async function hashArtifacts(
  artifacts: readonly { path: string; sha256: string }[],
): Promise<Array<{ path: string; sha256: string }>> {
  const result: Array<{ path: string; sha256: string }> = []
  for (const artifact of artifacts)
    result.push({ path: artifact.path, sha256: await hashFile(artifact.path) })
  return result
}

function descriptorRow(
  descriptor: CaseDescriptor,
  status: 'dry-run' | 'no-candidates' | 'error',
  errorCode: string | null = null,
): CaseResult {
  return {
    caseId: descriptor.caseId,
    status,
    target: descriptor.target,
    sourceSha256: descriptor.sourceSha256,
    candidateCount: descriptor.candidateDescriptors.length,
    selectedAlias: null,
    selection: null,
    selectionMetadata: null,
    boxCheck: null,
    errorCode,
    elapsedMs: 0,
    nativeElapsedMs: descriptor.nativeElapsedMs,
    candidatePresentationMs: null,
    selectionProviderMs: null,
    boxCheckProviderMs: null,
    boxCheckElapsedMs: null,
    cutoutElapsedMs: null,
    physicalCallCount: 0,
    requestSha256: null,
    candidateTransforms: null,
    files: { mask: null, maskSha256: null, cutout: null, cutoutSha256: null },
  }
}

export async function runGroundedMaskPilot(
  options: GroundedMaskPilotOptions,
): Promise<{ runPath: string; rows: CaseResult[] }> {
  const root = resolve(options.repositoryRoot)
  const dataRoot = resolve(options.dataRoot)
  const outputDirectory = resolve(options.outputDirectory)
  const runDirectory = join(dataRoot, GROUNDED_MASK_RUN_RELATIVE)
  if (inside(root, outputDirectory))
    throw new ClassifierError('INVALID_INPUT', 'Pilot output must be outside the package worktree')
  await mkdir(outputDirectory, { recursive: false })
  const outputStat = await readdir(outputDirectory)
  if (outputStat.length !== 0)
    throw new ClassifierError('INVALID_INPUT', 'Pilot output directory must be empty')
  const initial = await preflight(
    root,
    dataRoot,
    runDirectory,
    options.verificationProfile ?? 'h3b',
  )
  try {
    const cases = initial.cases.slice(0, options.caseLimit ?? expectedIds.length)
    if (
      options.caseLimit !== undefined &&
      (!Number.isInteger(options.caseLimit) ||
        options.caseLimit < 1 ||
        options.caseLimit > expectedIds.length)
    )
      throw new ClassifierError('INVALID_INPUT', 'Invalid test case limit')
    const budget = options.budget ?? new RunBudget(24, 2, 0.05)
    if (
      budget.maxPhysicalCalls !== 24 ||
      budget.maxCostUsd !== 2 ||
      budget.snapshot().maxCostUsd !== 2
    )
      throw new ClassifierError('INVALID_INPUT', 'H3b requires the frozen 24-call / $2 budget')
    const callsDirectory = join(outputDirectory, 'provider-calls')
    await mkdir(callsDirectory)
    const decision = options.dispatch ? options.decision : undefined
    const recorder = options.dispatch ? options.recorder : undefined
    if (options.dispatch && (!decision || !recorder || !options.budget))
      throw new ClassifierError(
        'INVALID_INPUT',
        'Explicit dispatch requires caller-owned decision, recorder and budget ports',
      )
    if (
      options.dispatch &&
      (options.budget?.maxPhysicalCalls !== 24 || options.budget.maxCostUsd !== 2)
    )
      throw new ClassifierError(
        'INVALID_INPUT',
        'Explicit dispatch requires the frozen 24-call / $2 budget',
      )
    const freezeRecord = {
      schema:
        options.verificationProfile === 'h3c'
          ? 'v03-grounded-mask-h3c-freeze-v1'
          : 'v03-grounded-mask-selection-freeze-v1',
      ...(options.verificationProfile === 'h3c' ? { verificationProfile: 'h3c' } : {}),
      nativeRun: { path: join(runDirectory, 'run.json'), sha256: initial.runHash },
      producerClosure: initial.closure,
      nativeArtifacts: initial.artifacts,
      createdAt: new Date().toISOString(),
    }
    await writeFile(join(outputDirectory, 'freeze.json'), JSON.stringify(freezeRecord, null, 2), {
      flag: 'wx',
    })
    const rows: CaseResult[] = []
    for (const descriptor of cases) {
      if (!decision || !recorder) {
        const row = descriptorRow(descriptor, 'dry-run')
        rows.push(row)
        await writeFile(
          join(outputDirectory, `${descriptor.caseId}.json`),
          JSON.stringify(row, null, 2),
          { flag: 'wx' },
        )
        continue
      }
      if (descriptor.candidateDescriptors.length === 0) {
        const row = descriptorRow(descriptor, 'no-candidates')
        rows.push(row)
        await writeFile(
          join(outputDirectory, `${descriptor.caseId}.json`),
          JSON.stringify(row, null, 2),
          { flag: 'wx' },
        )
        continue
      }
      const beforePhysical = recorder.calls.length
      const beforeLogical = recorder.logicalCalls.length
      let row: CaseResult
      const caseSignal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(GROUNDED_MASK_CASE_DEADLINE_MS)])
        : AbortSignal.timeout(GROUNDED_MASK_CASE_DEADLINE_MS)
      try {
        const input = await loadCaseBuffers(descriptor, caseSignal)
        row = await runCase(
          input,
          decision,
          outputDirectory,
          caseSignal,
          options.now ?? Date.now,
          options.verificationProfile ?? 'h3b',
        )
      } catch (error) {
        row = descriptorRow(
          descriptor,
          'error',
          error instanceof ClassifierError ? error.code : 'TECHNICAL_ERROR',
        )
      }
      const logicalUsed = recorder.logicalCalls.length - beforeLogical
      const physicalUsed = recorder.calls.length - beforePhysical
      if (logicalUsed > 2 || physicalUsed > 2) {
        row.status = 'error'
        row.errorCode = 'CASE_CALL_LIMIT_EXCEEDED'
      }
      rows.push({ ...row, physicalCallCount: physicalUsed })
      await writeFile(
        join(outputDirectory, `${descriptor.caseId}.json`),
        JSON.stringify(rows.at(-1), null, 2),
        { flag: 'wx' },
      )
      try {
        assertActive(caseSignal)
      } catch (error) {
        const stored = rows.at(-1)
        if (stored) {
          stored.status = 'error'
          stored.errorCode = 'ABORTED'
          await writeFile(
            join(outputDirectory, `${descriptor.caseId}.json`),
            JSON.stringify(stored, null, 2),
          )
        }
        throw error
      }
    }
    if (budget.snapshot().inFlightCalls !== 0)
      throw new ClassifierError(
        'RESOURCE_LIMIT',
        'Provider recorder still has unsettled physical calls',
      )
    const finalClosure = await producerFreeze(root, options.verificationProfile ?? 'h3b')
    const runHash = await hashFile(join(runDirectory, 'run.json'))
    const finalArtifacts = await hashArtifacts(initial.artifacts)
    const artifactsMatched = finalArtifacts.every(
      (artifact, index) => artifact.sha256 === initial.artifacts[index]?.sha256,
    )
    const runRecord = {
      schema:
        options.verificationProfile === 'h3c'
          ? 'v03-grounded-mask-h3c-pilot-v1'
          : 'v03-grounded-mask-selection-pilot-v1',
      ...(options.verificationProfile === 'h3c' ? { verificationProfile: 'h3c' } : {}),
      status:
        rows.some((row) => row.status === 'error') ||
        rows.length !== expectedIds.length ||
        initial.runHash !== runHash ||
        initial.closure.sha256 !== finalClosure.sha256 ||
        !artifactsMatched
          ? 'incomplete'
          : options.dispatch
            ? 'complete'
            : 'dry-run',
      cohort: 'fixed-v03-dev-12-effc2e8',
      replayComposition: true,
      nativeRunSha256: initial.runHash,
      initialProducerClosureSha256: initial.closure.sha256,
      finalProducerClosureSha256: finalClosure.sha256,
      initialProducerClosure: initial.closure.files,
      finalProducerClosure: finalClosure.files,
      initialNativeArtifacts: initial.artifacts,
      finalNativeArtifacts: finalArtifacts,
      finalNativeRunSha256: runHash,
      freezeMatched:
        initial.runHash === runHash &&
        initial.closure.sha256 === finalClosure.sha256 &&
        artifactsMatched,
      model: options.dispatch ? (recorder?.calls[0]?.route.model ?? null) : null,
      provider: options.dispatch ? (recorder?.calls[0]?.route.provider ?? null) : null,
      fallbacks: false,
      caseDeadlineMs: GROUNDED_MASK_CASE_DEADLINE_MS,
      budget: budget.snapshot(),
      recorder: recorder
        ? {
            physicalCalls: recorder.calls,
            logicalCalls: recorder.logicalCalls,
            persistenceFailures: recorder.persistenceFailures,
          }
        : null,
      rows,
    }
    const runPath = join(outputDirectory, 'run.json')
    await writeFile(runPath, JSON.stringify(runRecord, null, 2), { flag: 'wx' })
    if (!runRecord.freezeMatched)
      throw new ClassifierError('INVALID_INPUT', 'Producer freeze changed during H3b pilot')
    return { runPath, rows }
  } catch (error) {
    try {
      await writeFile(
        join(outputDirectory, 'failure.json'),
        JSON.stringify(
          {
            schema: 'v03-grounded-mask-selection-failure-v1',
            errorCode: error instanceof ClassifierError ? error.code : 'TECHNICAL_ERROR',
            budget: options.budget?.snapshot() ?? null,
            recorder: options.recorder
              ? {
                  physicalCalls: options.recorder.calls,
                  logicalCalls: options.recorder.logicalCalls,
                  persistenceFailures: options.recorder.persistenceFailures,
                }
              : null,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      )
    } catch {
      // Preserve the original failure if the failure receipt itself cannot be written.
    }
    throw error
  } finally {
    // Preflight retains only source paths, boxes, aliases, and frozen hashes.
  }
}

function parseArgs(args: readonly string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {}
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === '--dispatch') parsed.dispatch = true
    else if (value?.startsWith('--') && args[index + 1] && !args[index + 1]?.startsWith('--'))
      parsed[value.slice(2)] = args[++index] ?? ''
    else throw new Error(`Invalid argument ${value ?? ''}`)
  }
  return parsed
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(String(args.root ?? process.cwd()))
  const output = resolve(String(args.output ?? join(root, '..', 'grounded-mask-pilot-dry-run')))
  const dispatch = args.dispatch === true
  const verificationProfile = args.profile === undefined ? 'h3b' : args.profile
  if (verificationProfile !== 'h3b' && verificationProfile !== 'h3c')
    throw new ClassifierError('INVALID_INPUT', 'Profile must be h3b or h3c')
  let decision: DecisionPort | undefined
  let recorder: Recorder | undefined
  const budget = new RunBudget(24, 2, 0.05)
  if (dispatch) {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey)
      throw new ClassifierError('INVALID_INPUT', '--dispatch requires OPENROUTER_API_KEY')
    recorder = recordProvider(
      (fetcher) =>
        createOpenRouterDecisions({
          apiKey,
          model: GROUNDED_MASK_MODEL,
          provider: 'openai',
          providerName: 'OpenAI',
          fetch: fetcher,
        }),
      budget,
      join(output, 'provider-calls'),
      {
        model: GROUNDED_MASK_MODEL,
        provider: 'openai',
        providerName: 'OpenAI',
        apiEndpoint: '/api/alpha/decisions',
        allowFallbacks: false,
      },
    )
    decision = recorder.port
  }
  const result = await runGroundedMaskPilot({
    repositoryRoot: root,
    dataRoot: resolve(String(args['data-root'] ?? root)),
    outputDirectory: output,
    dispatch,
    ...(decision ? { decision } : {}),
    ...(recorder ? { recorder } : {}),
    budget,
    verificationProfile,
  })
  process.stdout.write(
    `${JSON.stringify({ runPath: result.runPath, rows: result.rows.length, statuses: result.rows.map((row) => row.status) })}\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Pilot failed'}\n`)
    process.exitCode = 1
  })
}
