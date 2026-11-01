import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import type { PixelRect } from '../../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../../src/entities/errors.js'
import type { PackedBinaryMask } from '../../../src/entities/object-proposals.js'
import type { H6Family, H6ProposalCandidate } from '../h6-context-composer.js'
import { zoomTileRegions } from '../zoom-locator.js'
import {
  H8A_FULL_CASE_DEADLINE_MS,
  H8A_FULL_FAMILY_CANDIDATES,
  H8A_FULL_MAX_ENCODED_BYTES,
  H8A_FULL_MAX_ORIENTED_PIXELS,
  H8A_FULL_MAX_PACKED_MASK_BYTES,
  H8A_FULL_TOTAL_CANDIDATES,
} from '../h8a-full/constants.js'
import { h8aAuthoredTargetSchema } from '../h8a-full/contracts.js'
import {
  copyEncodedImageBytes,
  decodeOrientedSource,
  encodeOrientedPng,
  type OwnedOrientedSource,
} from '../h8a-full/image-source.js'
import { foregroundBounds, validatePackedMaskCopy } from '../h8a-full/mask-geometry.js'
import { defaultWorkerScriptPath, H8aFullNativePort } from '../h8a-full/native-port.js'
import type {
  H8aFullNativePortOptions,
  H8aNativeGenerationInput,
  H8aNativeGenerationOutput,
} from '../h8a-full/native-port.js'

export const H8A_TILE_PROBE_RECIPE_ID = 'h8a-cpu-flat-target-v2' as const
const H8A_TILE_PROBE_VIEW_ORDER = ['full', 'NW', 'NE', 'SW', 'SE'] as const
const H8A_TILE_PROBE_FULL_QUOTA = 16 as const
const H8A_TILE_PROBE_TILE_QUOTA = 5 as const

type ProbeView = (typeof H8A_TILE_PROBE_VIEW_ORDER)[number]
type ProbeNative = Pick<H8aFullNativePort, 'generate' | 'dispose'>

export interface TiledProposalProbeInput {
  opaqueCaseId: string
  sourceBytes: Uint8Array
  sourceBytesSha256: string
  targetTaskText: string
  outputDir: string
  artifactRoot: string
  pythonExecutable: string
  assetRoot: string
  workerScriptPath?: string
  signal: AbortSignal
}

export interface TiledProposalProbeDependencies {
  createNative?: (options: H8aFullNativePortOptions) => ProbeNative
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const rectSchema = z
  .object({
    left: z.number().int().nonnegative().safe(),
    top: z.number().int().nonnegative().safe(),
    width: z.number().int().positive().safe(),
    height: z.number().int().positive().safe(),
  })
  .strict()

const retainedMaskSchema = z
  .object({
    pool: z.enum(['baseline', 'candidate']),
    family: z.enum(['D', 'U']),
    id: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    origin: z
      .object({
        view: z.enum(H8A_TILE_PROBE_VIEW_ORDER),
        viewIndex: z.number().int().min(0).max(4),
        tileRegion: rectSchema,
        nativeCandidateId: z.string().min(1),
        nativeOrdinal: z.number().int().nonnegative(),
        localPackedMaskSha256: digestSchema,
      })
      .strict(),
    packedMask: z
      .object({
        relativePath: z.string().min(1),
        packedBytes: z.number().int().positive(),
        sha256: digestSchema,
      })
      .strict(),
    sourceBounds: rectSchema.nullable(),
  })
  .strict()

const viewReceiptSchema = z
  .object({
    view: z.enum(H8A_TILE_PROBE_VIEW_ORDER),
    viewIndex: z.number().int().min(0).max(4),
    sourceRegion: rectSchema,
    sourceSha256: digestSchema,
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    durationMs: z.number().finite().nonnegative(),
    nativeProposalCounts: z
      .object({ D: z.number().int().nonnegative(), U: z.number().int().nonnegative() })
      .strict(),
  })
  .strict()

const probeBodySchema = z
  .object({
    schema: z.literal('h8a-tiled-proposal-availability-v1'),
    recipeId: z.literal(H8A_TILE_PROBE_RECIPE_ID),
    opaqueCaseId: z.string().min(1),
    sourceBytesSha256: digestSchema,
    sourceFrameSha256: digestSchema,
    targetTaskSha256: digestSchema,
    sourceCanvas: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    deadlineMs: z.literal(H8A_FULL_CASE_DEADLINE_MS),
    viewOrder: z.array(z.enum(H8A_TILE_PROBE_VIEW_ORDER)).length(5),
    views: z.array(viewReceiptSchema).length(5),
    baseline: z
      .object({
        entries: z.array(retainedMaskSchema),
        packedBytesTotal: z.number().int().nonnegative(),
      })
      .strict(),
    candidate: z
      .object({
        entries: z.array(retainedMaskSchema),
        packedBytesTotal: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export const tiledProposalProbeEvidenceSchema = probeBodySchema
  .extend({ evidenceSha256: digestSchema })
  .strict()

export type TiledProposalProbeEvidence = z.infer<typeof tiledProposalProbeEvidenceSchema>

interface RetainedMask {
  pool: 'baseline' | 'candidate'
  family: H6Family
  id: string
  ordinal: number
  view: ProbeView
  viewIndex: number
  tileRegion: PixelRect
  nativeCandidateId: string
  nativeOrdinal: number
  localPackedMaskSha256: string
  packed: PackedBinaryMask
  sourceBounds: PixelRect | null
}

interface RetentionState {
  baselineByFamily: Record<H6Family, RetainedMask[]>
  candidateByFamily: Record<H6Family, RetainedMask[]>
  seenByFamily: Record<H6Family, Map<string, Uint8Array[]>>
  allRetained: RetainedMask[]
  baselineBytes: number
  candidateBytes: number
}

interface EncodedView {
  bytes: Uint8Array
  sha256: string
  width: number
  height: number
  dispose(): void
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function classifyFailure(error: unknown): ClassifierError {
  if (error instanceof ClassifierError) return error
  if (error instanceof Error && error.name === 'AbortError')
    return new ClassifierError('ABORTED', 'Tiled proposal availability probe was cancelled', {
      cause: error,
    })
  return new ClassifierError('PROVIDER', 'Tiled proposal availability probe failed', {
    cause: error,
  })
}

function assertDigestMatches(bytes: Uint8Array, expected: string): void {
  if (!digestSchema.safeParse(expected).success || sha256(bytes) !== expected)
    throw new ClassifierError('INVALID_INPUT', 'Source bytes differ from the declared digest')
}

function fullRegion(width: number, height: number): PixelRect {
  return { left: 0, top: 0, width, height }
}

async function encodeTilePng(source: OwnedOrientedSource, region: PixelRect): Promise<EncodedView> {
  const pipeline = sharp(source.raster.data, {
    raw: { width: source.width, height: source.height, channels: 4 },
    limitInputPixels: H8A_FULL_MAX_ORIENTED_PIXELS,
    failOn: 'error',
  }).extract(region)
  try {
    const png = await pipeline.png({ compressionLevel: 6 }).toBuffer()
    if (png.byteLength === 0 || png.byteLength > H8A_FULL_MAX_ENCODED_BYTES)
      throw new ClassifierError('RESOURCE_LIMIT', 'Tile PNG exceeds the H8a source byte limit')
    const bytes = Uint8Array.from(png)
    const result = {
      bytes,
      sha256: sha256(bytes),
      width: region.width,
      height: region.height,
      dispose() {
        bytes.fill(0)
        png.fill(0)
      },
    }
    return result
  } finally {
    pipeline.destroy()
  }
}

export function maskTouchesInternalTileEdge(
  mask: PackedBinaryMask,
  region: PixelRect,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  const owned = validatePackedMaskCopy(mask, region.width, region.height)
  try {
    return maskTouchesInternalTileEdgeOwned(owned, region, sourceWidth, sourceHeight)
  } finally {
    owned.data.fill(0)
  }
}

function maskTouchesInternalTileEdgeOwned(
  mask: PackedBinaryMask,
  region: PixelRect,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  const touches = (x: number, y: number): boolean =>
    ((mask.data[(y * mask.width + x) >> 3] ?? 0) & (1 << ((y * mask.width + x) & 7))) !== 0
  for (let x = 0; x < mask.width; x++) {
    if (region.top > 0 && touches(x, 0)) return true
    if (region.top + region.height < sourceHeight && touches(x, mask.height - 1)) return true
  }
  for (let y = 0; y < mask.height; y++) {
    if (region.left > 0 && touches(0, y)) return true
    if (region.left + region.width < sourceWidth && touches(mask.width - 1, y)) return true
  }
  return false
}

function assertTileProjectionBounds(
  region: PixelRect,
  sourceWidth: number,
  sourceHeight: number,
): void {
  if (
    !Number.isSafeInteger(sourceWidth) ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    !Number.isSafeInteger(sourceWidth * sourceHeight) ||
    sourceWidth * sourceHeight > H8A_FULL_MAX_ORIENTED_PIXELS ||
    region.left < 0 ||
    region.top < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.left + region.width > sourceWidth ||
    region.top + region.height > sourceHeight
  )
    throw new ClassifierError('INVALID_INPUT', 'Tile projection region is outside the source frame')
}

function projectOwnedTileMaskToSource(
  mask: PackedBinaryMask,
  region: PixelRect,
  sourceWidth: number,
  sourceHeight: number,
): PackedBinaryMask {
  assertTileProjectionBounds(region, sourceWidth, sourceHeight)
  if (mask.width !== region.width || mask.height !== region.height)
    throw new ClassifierError('INVALID_INPUT', 'Tile mask dimensions differ from its crop region')
  const sourceBytes = Math.ceil((sourceWidth * sourceHeight) / 8)
  const projected: PackedBinaryMask = {
    format: 'binary-lsb0',
    width: sourceWidth,
    height: sourceHeight,
    data: new Uint8Array(sourceBytes),
  }
  try {
    for (let localY = 0; localY < region.height; localY++) {
      for (let localX = 0; localX < region.width; localX++) {
        const localIndex = localY * region.width + localX
        if (((mask.data[localIndex >> 3] ?? 0) & (1 << (localIndex & 7))) === 0) continue
        const sourceIndex = (region.top + localY) * sourceWidth + region.left + localX
        projected.data[sourceIndex >> 3] =
          (projected.data[sourceIndex >> 3] ?? 0) | (1 << (sourceIndex & 7))
      }
    }
    return projected
  } catch (error) {
    projected.data.fill(0)
    throw error
  }
}

export function projectTileMaskToSource(
  mask: PackedBinaryMask,
  region: PixelRect,
  sourceWidth: number,
  sourceHeight: number,
): PackedBinaryMask {
  assertTileProjectionBounds(region, sourceWidth, sourceHeight)
  const owned = validatePackedMaskCopy(mask, region.width, region.height)
  try {
    return projectOwnedTileMaskToSource(owned, region, sourceWidth, sourceHeight)
  } finally {
    owned.data.fill(0)
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function deriveBounds(mask: PackedBinaryMask): PixelRect | null {
  return foregroundBounds(mask) ?? null
}

function recordCandidate(
  retainedByFamily: Record<H6Family, RetainedMask[]>,
  seenByFamily: Record<H6Family, Map<string, Uint8Array[]>>,
  input: Omit<RetainedMask, 'id' | 'ordinal' | 'sourceBounds' | 'pool' | 'relativePath'>,
  perViewQuota: number,
  knownDigest?: string,
  knownSourceBounds?: PixelRect,
): boolean {
  const familyRecords = retainedByFamily[input.family]
  if (familyRecords.length >= H8A_FULL_FAMILY_CANDIDATES) {
    input.packed.data.fill(0)
    throw new ClassifierError('RESOURCE_LIMIT', 'Candidate family exceeded its frozen proposal cap')
  }
  if (familyRecords.filter((row) => row.view === input.view).length >= perViewQuota) {
    input.packed.data.fill(0)
    return false
  }
  const packed = input.packed
  const sourceBounds = knownSourceBounds ?? deriveBounds(packed)
  if (!sourceBounds) {
    packed.data.fill(0)
    return false
  }
  const digest = knownDigest ?? sha256(packed.data)
  const familySeen = seenByFamily[input.family]
  const sameDigest = familySeen.get(digest) ?? []
  if (sameDigest.some((prior) => sameBytes(prior, packed.data))) {
    packed.data.fill(0)
    return false
  }
  familySeen.set(digest, [...sameDigest, packed.data])
  const ordinal = familyRecords.length
  familyRecords.push({
    ...input,
    pool: 'candidate',
    id: `${input.family}_${input.view}_${String(ordinal).padStart(2, '0')}`,
    ordinal,
    sourceBounds,
  })
  return true
}

function createRetentionState(): RetentionState {
  return {
    baselineByFamily: { D: [], U: [] },
    candidateByFamily: { D: [], U: [] },
    seenByFamily: { D: new Map(), U: new Map() },
    allRetained: [],
    baselineBytes: 0,
    candidateBytes: 0,
  }
}

function enforceCandidatePoolLimits(state: RetentionState): void {
  const totalCandidates = state.candidateByFamily.D.length + state.candidateByFamily.U.length
  if (
    totalCandidates > H8A_FULL_TOTAL_CANDIDATES ||
    state.candidateBytes > H8A_FULL_MAX_PACKED_MASK_BYTES
  )
    throw new ClassifierError('RESOURCE_LIMIT', 'Candidate output pool exceeded its frozen cap')
}

function retainFullView(
  output: H8aNativeGenerationOutput,
  region: PixelRect,
  viewIndex: number,
  width: number,
  height: number,
  state: RetentionState,
): void {
  for (const family of ['D', 'U'] as const) {
    const familyCandidates = output.families[family]
    for (let nativeOrdinal = 0; nativeOrdinal < familyCandidates.length; nativeOrdinal++) {
      const candidate = familyCandidates[nativeOrdinal]!
      const packed = copyFullCandidate(candidate)
      const localPackedMaskSha256 = sha256(packed.data)
      const baselineRecord: RetainedMask = {
        pool: 'baseline',
        family,
        id: `${family}${String(nativeOrdinal).padStart(2, '0')}`,
        ordinal: state.baselineByFamily[family].length,
        view: 'full',
        viewIndex,
        tileRegion: region,
        nativeCandidateId: candidate.id,
        nativeOrdinal,
        localPackedMaskSha256,
        packed,
        sourceBounds: deriveBounds(packed),
      }
      state.baselineBytes += packed.data.byteLength
      if (
        state.baselineByFamily.D.length + state.baselineByFamily.U.length >=
          H8A_FULL_TOTAL_CANDIDATES ||
        state.baselineBytes > H8A_FULL_MAX_PACKED_MASK_BYTES
      ) {
        packed.data.fill(0)
        throw new ClassifierError('RESOURCE_LIMIT', 'Baseline output pool exceeded its frozen cap')
      }
      state.baselineByFamily[family].push(baselineRecord)
      state.allRetained.push(baselineRecord)

      if (!baselineRecord.sourceBounds) continue
      if (
        state.candidateByFamily[family].filter((row) => row.view === 'full').length >=
        H8A_TILE_PROBE_FULL_QUOTA
      )
        continue
      const candidatePacked = Uint8Array.from(packed.data)
      const accepted = recordCandidate(
        state.candidateByFamily,
        state.seenByFamily,
        {
          family,
          view: 'full',
          viewIndex,
          tileRegion: region,
          nativeCandidateId: candidate.id,
          nativeOrdinal,
          localPackedMaskSha256,
          packed: { format: 'binary-lsb0', width, height, data: candidatePacked },
        },
        H8A_TILE_PROBE_FULL_QUOTA,
        localPackedMaskSha256,
        baselineRecord.sourceBounds,
      )
      if (!accepted) continue
      const retained = state.candidateByFamily[family].at(-1)!
      state.candidateBytes += retained.packed.data.byteLength
      state.allRetained.push(retained)
      enforceCandidatePoolLimits(state)
    }
  }
}

function retainTileView(
  output: H8aNativeGenerationOutput,
  region: PixelRect,
  view: Exclude<ProbeView, 'full'>,
  viewIndex: number,
  sourceWidth: number,
  sourceHeight: number,
  state: RetentionState,
): void {
  for (const family of ['D', 'U'] as const) {
    const familyCandidates = output.families[family]
    for (let nativeOrdinal = 0; nativeOrdinal < familyCandidates.length; nativeOrdinal++) {
      const candidate = familyCandidates[nativeOrdinal]!
      if (
        state.candidateByFamily[family].filter((row) => row.view === view).length >=
        H8A_TILE_PROBE_TILE_QUOTA
      ) {
        candidate.mask.data.fill(0)
        continue
      }
      const local = validatePackedMaskCopy(candidate.mask, region.width, region.height)
      const localPackedMaskSha256 = sha256(local.data)
      if (maskTouchesInternalTileEdgeOwned(local, region, sourceWidth, sourceHeight)) {
        local.data.fill(0)
        continue
      }
      const localBounds = deriveBounds(local)
      if (!localBounds) {
        local.data.fill(0)
        continue
      }
      const sourceBounds = {
        ...localBounds,
        left: localBounds.left + region.left,
        top: localBounds.top + region.top,
      }
      const projected = projectOwnedTileMaskToSource(local, region, sourceWidth, sourceHeight)
      local.data.fill(0)
      const accepted = recordCandidate(
        state.candidateByFamily,
        state.seenByFamily,
        {
          family,
          view,
          viewIndex,
          tileRegion: region,
          nativeCandidateId: candidate.id,
          nativeOrdinal,
          localPackedMaskSha256,
          packed: projected,
        },
        H8A_TILE_PROBE_TILE_QUOTA,
        undefined,
        sourceBounds,
      )
      if (!accepted) continue
      const retained = state.candidateByFamily[family].at(-1)!
      state.candidateBytes += retained.packed.data.byteLength
      state.allRetained.push(retained)
      enforceCandidatePoolLimits(state)
    }
  }
}

async function persistMaskPool(
  outputDir: string,
  pool: RetainedMask['pool'],
  recordsByFamily: Record<H6Family, RetainedMask[]>,
): Promise<{ entries: z.infer<typeof retainedMaskSchema>[]; packedBytesTotal: number }> {
  const entries: z.infer<typeof retainedMaskSchema>[] = []
  let packedBytesTotal = 0
  for (const family of ['D', 'U'] as const) {
    const familyRecords = recordsByFamily[family]
    if (familyRecords.length === 0) continue
    const maskDirectory = join(outputDir, 'masks', pool, family)
    await ensureOwnedSubdirectory(outputDir, maskDirectory)
    for (const retained of familyRecords) {
      const filename = `${String(retained.ordinal).padStart(3, '0')}.bin`
      const maskPath = join(maskDirectory, filename)
      await writeOwnedFile(maskPath, retained.packed.data)
      packedBytesTotal += retained.packed.data.byteLength
      entries.push(
        retainedMaskSchema.parse({
          pool,
          family,
          id: retained.id,
          ordinal: retained.ordinal,
          origin: {
            view: retained.view,
            viewIndex: retained.viewIndex,
            tileRegion: retained.tileRegion,
            nativeCandidateId: retained.nativeCandidateId,
            nativeOrdinal: retained.nativeOrdinal,
            localPackedMaskSha256: retained.localPackedMaskSha256,
          },
          packedMask: {
            relativePath: pathForManifest(outputDir, maskPath),
            packedBytes: retained.packed.data.byteLength,
            sha256: sha256(retained.packed.data),
          },
          sourceBounds: retained.sourceBounds,
        }),
      )
    }
  }
  return { entries, packedBytesTotal }
}

function copyFullCandidate(candidate: H6ProposalCandidate): PackedBinaryMask {
  return validatePackedMaskCopy(candidate.mask, candidate.mask.width, candidate.mask.height)
}

function assertPerViewNativeLimits(
  output: H8aNativeGenerationOutput,
  width: number,
  height: number,
): void {
  if (output.recipeId !== H8A_TILE_PROBE_RECIPE_ID)
    throw new ClassifierError('INVALID_RESPONSE', 'Native view used a different frozen recipe')
  let total = 0
  const expected = Math.ceil((width * height) / 8)
  for (const family of ['D', 'U'] as const) {
    const candidates = output.families[family]
    if (candidates.length > H8A_FULL_FAMILY_CANDIDATES)
      throw new ClassifierError(
        'RESOURCE_LIMIT',
        `Native family exceeded ${H8A_FULL_FAMILY_CANDIDATES} proposals`,
      )
    total += candidates.length
    for (let ordinal = 0; ordinal < candidates.length; ordinal++) {
      const candidate = candidates[ordinal]!
      if (candidate.id !== `${family}${String(ordinal).padStart(2, '0')}`)
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Native family candidate order is not canonical',
        )
      if (
        candidate.mask.width !== width ||
        candidate.mask.height !== height ||
        candidate.mask.data.byteLength !== expected
      )
        throw new ClassifierError('INVALID_RESPONSE', 'Native mask geometry differs from its view')
    }
  }
  if (total > H8A_FULL_TOTAL_CANDIDATES)
    throw new ClassifierError('RESOURCE_LIMIT', 'Native view exceeded the 72-proposal cap')
}

function pathForManifest(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

async function ensureOwnedSubdirectory(root: string, path: string): Promise<void> {
  const childPath = relative(root, path)
  if (
    childPath === '' ||
    childPath === '..' ||
    childPath.startsWith(`..${sep}`) ||
    isAbsolute(childPath)
  )
    throw new ClassifierError('INVALID_INPUT', 'Output subdirectory escapes its owned root')
  let current = root
  for (const component of childPath.split(sep)) {
    current = join(current, component)
    try {
      await mkdir(current, { recursive: false, mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    }
    const stats = await lstat(current)
    if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(current)) !== current)
      throw new ClassifierError('INVALID_INPUT', 'Output subdirectory traverses a symlink')
  }
}

async function assertNewPhysicalOutputDirectory(outputDir: string): Promise<void> {
  const parent = dirname(outputDir)
  if ((await realpath(parent)) !== parent)
    throw new ClassifierError(
      'INVALID_INPUT',
      'Output directory parent must not traverse a symlink',
    )
  try {
    await lstat(outputDir)
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return
    throw error
  }
  throw new ClassifierError('INVALID_INPUT', 'Output directory already exists')
}

async function assertExternalArtifactLayout(
  outputDir: string,
  artifactRoot: string,
): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const artifactRelativeToProject = relative(projectRoot, artifactRoot)
  if (
    artifactRelativeToProject === '' ||
    (artifactRelativeToProject !== '..' && !artifactRelativeToProject.startsWith(`..${sep}`)) ||
    isAbsolute(artifactRelativeToProject) ||
    (await realpath(projectRoot)) !== projectRoot
  )
    throw new ClassifierError('INVALID_INPUT', 'Artifact root must be outside the project tree')
  const outputRelativeToArtifact = relative(artifactRoot, outputDir)
  if (
    outputRelativeToArtifact === '' ||
    outputRelativeToArtifact === '..' ||
    outputRelativeToArtifact.startsWith(`..${sep}`) ||
    isAbsolute(outputRelativeToArtifact)
  )
    throw new ClassifierError('INVALID_INPUT', 'Output directory must be a child of artifactRoot')
  const stats = await lstat(artifactRoot)
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (await realpath(artifactRoot)) !== artifactRoot
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Artifact root must be an existing physical directory',
    )
}

async function captureOwnedDirectory(path: string): Promise<{ dev: number; ino: number }> {
  const stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ClassifierError('INVALID_INPUT', 'Owned output path changed physical identity')
  return { dev: stats.dev, ino: stats.ino }
}

async function removeOwnedDirectory(
  path: string,
  expected: { dev: number; ino: number },
): Promise<void> {
  const stats = await lstat(path)
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== expected.dev ||
    stats.ino !== expected.ino ||
    (await realpath(path)) !== path
  )
    throw new ClassifierError('INVALID_INPUT', 'Refusing to remove a changed output directory')
  await rm(path, { recursive: true, force: false })
}

function cleanupFailure(previous: unknown, cleanup: unknown): ClassifierError {
  if (previous === undefined) return classifyFailure(cleanup)
  return new ClassifierError('PROVIDER', 'Probe failed and owned cleanup also failed', {
    cause: new AggregateError([previous, cleanup], 'Probe and cleanup failures', {
      cause: previous,
    }),
  })
}

async function writeOwnedFile(path: string, bytes: Uint8Array | string): Promise<void> {
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
}

export async function runTiledProposalAvailabilityProbe(
  rawInput: TiledProposalProbeInput,
  dependencies: TiledProposalProbeDependencies = {},
): Promise<TiledProposalProbeEvidence> {
  if (!rawInput || typeof rawInput !== 'object')
    throw new ClassifierError('INVALID_INPUT', 'Tiled probe input must be an object')
  const sourceBytes = copyEncodedImageBytes(rawInput.sourceBytes)
  let expectedSourceBytesSha256: string
  let opaqueCaseId: string
  let targetTaskText: string
  let outputDir: string
  let artifactRoot: string
  let pythonExecutable: string
  let assetRoot: string
  let workerScriptPath: string
  try {
    expectedSourceBytesSha256 = rawInput.sourceBytesSha256
    assertDigestMatches(sourceBytes, expectedSourceBytesSha256)
    opaqueCaseId = z.string().min(1).max(200).parse(rawInput.opaqueCaseId)
    targetTaskText = h8aAuthoredTargetSchema.parse(rawInput.targetTaskText)
    outputDir = resolve(z.string().min(1).parse(rawInput.outputDir))
    artifactRoot = resolve(z.string().min(1).parse(rawInput.artifactRoot))
    pythonExecutable = z.string().min(1).parse(rawInput.pythonExecutable)
    assetRoot = resolve(z.string().min(1).parse(rawInput.assetRoot))
    workerScriptPath = rawInput.workerScriptPath
      ? resolve(rawInput.workerScriptPath)
      : defaultWorkerScriptPath()
    if (!(rawInput.signal instanceof AbortSignal))
      throw new ClassifierError('INVALID_INPUT', 'Tiled probe requires AbortSignal')
  } catch (error) {
    sourceBytes.fill(0)
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError('INVALID_INPUT', 'Tiled probe input validation failed', {
      cause: error,
    })
  }
  const callerSignal = rawInput.signal
  const startedAt = performance.now()
  const deadlineAt = startedAt + H8A_FULL_CASE_DEADLINE_MS
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort(callerSignal.reason)
  callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  if (callerSignal.aborted) onCallerAbort()
  const deadlineTimer = setTimeout(
    () => controller.abort(new ClassifierError('TIMEOUT', 'Tiled native probe deadline expired')),
    Math.max(0, deadlineAt - performance.now()),
  )
  let outputCreated = false
  let outputIdentity: { dev: number; ino: number } | undefined
  let temporaryViewIdentity: { dev: number; ino: number } | undefined
  let source: OwnedOrientedSource | undefined
  let orientedPng: Awaited<ReturnType<typeof encodeOrientedPng>> | undefined
  let native: ProbeNative | undefined
  let nativeDisposed = false
  const temporaryViewRoot = join(outputDir, 'h8a-full-runs')
  const retention = createRetentionState()
  const viewReceipts: Array<z.infer<typeof viewReceiptSchema>> = []
  let failure: unknown
  let evidence: TiledProposalProbeEvidence | undefined
  try {
    assertActive(controller.signal)
    await assertExternalArtifactLayout(outputDir, artifactRoot)
    await assertNewPhysicalOutputDirectory(outputDir)
    await mkdir(outputDir, { recursive: false, mode: 0o700 })
    outputCreated = true
    outputIdentity = await captureOwnedDirectory(outputDir)
    await mkdir(temporaryViewRoot, { recursive: false, mode: 0o700 })
    temporaryViewIdentity = await captureOwnedDirectory(temporaryViewRoot)
    const nativeOptions: H8aFullNativePortOptions = {
      pythonExecutable,
      assetRoot,
      artifactRoot,
      workerScriptPath,
      recipeId: H8A_TILE_PROBE_RECIPE_ID,
    }
    native = dependencies.createNative?.(nativeOptions) ?? new H8aFullNativePort(nativeOptions)
    assertActive(controller.signal)
    source = await decodeOrientedSource(sourceBytes)
    assertActive(controller.signal)
    orientedPng = await encodeOrientedPng(source)
    assertActive(controller.signal)
    if (source.width * source.height > H8A_FULL_MAX_ORIENTED_PIXELS)
      throw new ClassifierError('RESOURCE_LIMIT', 'Oriented source exceeds the H8a pixel cap')
    const full = fullRegion(source.width, source.height)
    const tiles = zoomTileRegions(full)
    if (tiles.length !== 4)
      throw new ClassifierError(
        'INVALID_INPUT',
        'Source is too small for the four frozen tile views',
      )
    const regions: PixelRect[] = [full, ...tiles]
    for (let viewIndex = 0; viewIndex < H8A_TILE_PROBE_VIEW_ORDER.length; viewIndex++) {
      assertActive(controller.signal)
      if (performance.now() >= deadlineAt)
        throw new ClassifierError('TIMEOUT', 'Tiled native probe deadline expired')
      const view = H8A_TILE_PROBE_VIEW_ORDER[viewIndex]!
      const region = regions[viewIndex]!
      const encodedView =
        view === 'full'
          ? {
              bytes: Uint8Array.from(orientedPng.bytes),
              sha256: orientedPng.sha256,
              width: source.width,
              height: source.height,
              dispose() {},
            }
          : await encodeTilePng(source, region)
      const viewDirectory = join(temporaryViewRoot, randomUUID())
      let viewOutput: H8aNativeGenerationOutput | undefined
      let viewDirectoryIdentity: { dev: number; ino: number } | undefined
      const viewStarted = performance.now()
      try {
        assertActive(controller.signal)
        await mkdir(viewDirectory, { recursive: false, mode: 0o700 })
        viewDirectoryIdentity = await captureOwnedDirectory(viewDirectory)
        const sourcePath = join(viewDirectory, 'oriented-source.png')
        await writeOwnedFile(sourcePath, encodedView.bytes)
        assertActive(controller.signal)
        viewOutput = await native.generate({
          authoredTarget: targetTaskText,
          sourcePath,
          sourceSha256: encodedView.sha256,
          width: encodedView.width,
          height: encodedView.height,
          deadlineAt,
          signal: controller.signal,
        } satisfies H8aNativeGenerationInput)
        assertActive(controller.signal)
        assertPerViewNativeLimits(viewOutput, encodedView.width, encodedView.height)
        if (view === 'full')
          retainFullView(viewOutput, region, viewIndex, source.width, source.height, retention)
        else
          retainTileView(
            viewOutput,
            region,
            view,
            viewIndex,
            source.width,
            source.height,
            retention,
          )
        viewReceipts.push({
          view,
          viewIndex,
          sourceRegion: region,
          sourceSha256: encodedView.sha256,
          sourceWidth: encodedView.width,
          sourceHeight: encodedView.height,
          durationMs: Math.max(0, performance.now() - viewStarted),
          nativeProposalCounts: {
            D: viewOutput.families.D.length,
            U: viewOutput.families.U.length,
          },
        })
      } finally {
        if (viewOutput) {
          for (const family of ['D', 'U'] as const)
            for (const candidate of viewOutput.families[family]) candidate.mask.data.fill(0)
        }
        encodedView.dispose()
        if (viewDirectoryIdentity) await removeOwnedDirectory(viewDirectory, viewDirectoryIdentity)
      }
    }

    await native.dispose()
    nativeDisposed = true
    if (temporaryViewIdentity) {
      await removeOwnedDirectory(temporaryViewRoot, temporaryViewIdentity)
      temporaryViewIdentity = undefined
    }
    assertActive(controller.signal)
    if (performance.now() >= deadlineAt)
      throw new ClassifierError('TIMEOUT', 'Tiled native probe deadline expired')

    const baseline = await persistMaskPool(outputDir, 'baseline', retention.baselineByFamily)
    const candidate = await persistMaskPool(outputDir, 'candidate', retention.candidateByFamily)
    assertActive(controller.signal)
    const body = probeBodySchema.parse({
      schema: 'h8a-tiled-proposal-availability-v1',
      recipeId: H8A_TILE_PROBE_RECIPE_ID,
      opaqueCaseId,
      sourceBytesSha256: expectedSourceBytesSha256,
      sourceFrameSha256: source.frameSha256,
      targetTaskSha256: sha256Text(targetTaskText),
      sourceCanvas: { width: source.width, height: source.height },
      deadlineMs: H8A_FULL_CASE_DEADLINE_MS,
      viewOrder: [...H8A_TILE_PROBE_VIEW_ORDER],
      views: viewReceipts,
      baseline,
      candidate,
    })
    evidence = tiledProposalProbeEvidenceSchema.parse({
      ...body,
      evidenceSha256: sha256Text(JSON.stringify(body)),
    })
    await writeOwnedFile(join(outputDir, 'manifest.json'), `${JSON.stringify(evidence)}\n`)
    assertActive(controller.signal)
  } catch (error) {
    failure = classifyFailure(error)
  } finally {
    if (native && !nativeDisposed) {
      try {
        await native.dispose()
        nativeDisposed = true
      } catch (error) {
        failure = cleanupFailure(failure, error)
      }
    }
    for (const retained of retention.allRetained) retained.packed.data.fill(0)
    orientedPng?.dispose()
    source?.dispose()
    sourceBytes.fill(0)
    if (temporaryViewIdentity) {
      try {
        await removeOwnedDirectory(temporaryViewRoot, temporaryViewIdentity)
      } catch (error) {
        failure = cleanupFailure(failure, error)
      }
    }
    if (failure === undefined && controller.signal.aborted) {
      try {
        assertActive(controller.signal)
      } catch (error) {
        failure = classifyFailure(error)
      }
    }
    if (failure === undefined && performance.now() >= deadlineAt)
      failure = new ClassifierError('TIMEOUT', 'Tiled native probe deadline expired')
    if (outputCreated && failure && outputIdentity) {
      try {
        await removeOwnedDirectory(outputDir, outputIdentity)
      } catch (error) {
        failure = cleanupFailure(failure, error)
      }
    }
    clearTimeout(deadlineTimer)
    callerSignal.removeEventListener('abort', onCallerAbort)
  }
  if (failure) throw failure
  if (!evidence) throw new ClassifierError('PROVIDER', 'Tiled probe ended without evidence')
  return evidence
}
