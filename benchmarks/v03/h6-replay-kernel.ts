import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { limits } from '../../src/entities/contracts.js'
import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import type { PackedBinaryMask } from '../../src/entities/object-proposals.js'
import type { RgbaRaster } from '../../src/entities/representation.js'
import { packBinaryMask } from '../../src/features/segmentation/packed-mask.js'
import { createSharpRaster } from '../../src/infrastructure/raster.js'

export const H6_NATIVE_LOCKS = {
  h5aRun: '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0',
  h5aFreeze: 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566',
  h5aIntegrity: '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50',
  h5aWorkerClosure: 'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f',
  h3bRun: 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401',
  h4eRun: 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4',
} as const

export const H6_CASE_IDS = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]

export interface H6NativeMaskDescriptor {
  family: 'D' | 'U'
  source_family: 'h3b-dino-sam2' | 'omni-sam2' | 'h4e-sam2'
  source_alias: string
  source_mask_path: string
  source_mask_sha256: string
  expected_box_xyxy: readonly number[]
}

export interface H6NativeCase {
  case_id: string
  target: string
  source_path: string
  source_sha256: string
  source_width: number
  source_height: number
  native_generation_ms: number | null
  masks: H6NativeMaskDescriptor[]
}

export interface H6NativeClosureEntry {
  path: string
  sha256: string
}

export interface NativeRecipeTiming {
  preparationElapsedMs: number
  compositionElapsedMs: number | null
  replayElapsedMs: number
}

export interface NativeRecipePrepared {
  dispose(): void
}

/**
 * Shared replay lifecycle for recipe experiments: the absolute case deadline
 * begins before decode, composition and result serialization share it, and
 * prepared image/mask bytes are disposed on every exit path.
 */
export async function executeNativeRecipeCase<
  TItem,
  TPrepared extends NativeRecipePrepared,
  TComposition,
  TResult,
>(
  item: TItem,
  parentSignal: AbortSignal,
  deadlineMs: number,
  hooks: {
    prepare(item: TItem, signal: AbortSignal): Promise<TPrepared>
    compose(item: TItem, prepared: TPrepared, signal: AbortSignal): Promise<TComposition>
    finish(
      item: TItem,
      prepared: TPrepared,
      composition: TComposition,
      timing: NativeRecipeTiming,
      signal: AbortSignal,
    ): Promise<TResult>
    disposeComposition?(composition: TComposition): void
    onTiming?(timing: NativeRecipeTiming): void
  },
): Promise<TResult> {
  const startedAt = performance.now()
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new ClassifierError('TIMEOUT', 'Native recipe case deadline exceeded')),
    deadlineMs,
  )
  deadline.unref?.()
  const signal = AbortSignal.any([parentSignal, controller.signal])
  let prepared: TPrepared | undefined
  let composition: TComposition | undefined
  let compositionProduced = false
  let preparationElapsedMs = 0
  let compositionElapsedMs: number | null = null
  try {
    assertActive(signal)
    const preparationStarted = performance.now()
    prepared = await hooks.prepare(item, signal)
    preparationElapsedMs = performance.now() - preparationStarted
    hooks.onTiming?.({
      preparationElapsedMs,
      compositionElapsedMs,
      replayElapsedMs: performance.now() - startedAt,
    })
    assertActive(signal)
    const compositionStarted = performance.now()
    composition = await hooks.compose(item, prepared, signal)
    compositionProduced = true
    compositionElapsedMs = performance.now() - compositionStarted
    hooks.onTiming?.({
      preparationElapsedMs,
      compositionElapsedMs,
      replayElapsedMs: performance.now() - startedAt,
    })
    assertActive(signal)
    return await hooks.finish(
      item,
      prepared,
      composition,
      {
        preparationElapsedMs,
        compositionElapsedMs,
        replayElapsedMs: performance.now() - startedAt,
      },
      signal,
    )
  } finally {
    clearTimeout(deadline)
    try {
      if (compositionProduced) hooks.disposeComposition?.(composition as TComposition)
    } finally {
      prepared?.dispose()
    }
  }
}

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
const h5aRunSchema = z
  .object({
    state: z.literal('complete'),
    native_generation_ms: z.number().finite().nonnegative(),
    cases: z.array(
      z
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
        .passthrough(),
    ),
    h3b: z.object({ run: receiptSchema }),
    h4e_ui_cache: z.object({ run: receiptSchema }),
    paid_calls: z.literal(0),
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

type IntegrityFileEntry = z.infer<typeof integritySchema>['files'][number]

/** Indexes frozen integrity receipts by resolved file identity so directory aliases match lookups. */
export async function buildIntegrityReceiptByRealPath(
  files: readonly IntegrityFileEntry[],
  signal: AbortSignal,
): Promise<Map<string, IntegrityFileEntry>> {
  const integrityByRealPath = new Map<string, IntegrityFileEntry>()
  for (const entry of files) {
    assertActive(signal)
    let realKey: string
    try {
      realKey = await realpath(resolve(entry.path))
    } catch (error) {
      assertActive(signal)
      const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new ClassifierError(
          'INVALID_INPUT',
          'Integrity receipt path does not resolve to a file',
        )
      throw error
    }
    assertActive(signal)
    const prior = integrityByRealPath.get(realKey)
    if (prior) {
      // Path and label are alias bookkeeping; one physical file must agree on sha256 and bytes.
      if (prior.sha256 !== entry.sha256 || prior.bytes !== entry.bytes)
        throw new ClassifierError(
          'INVALID_INPUT',
          'Conflicting integrity receipts share one file identity',
        )
      continue
    }
    integrityByRealPath.set(realKey, entry)
  }
  assertActive(signal)
  return integrityByRealPath
}

export function assertIntegrityReceiptForRealPath(
  integrityByRealPath: Map<string, IntegrityFileEntry>,
  realPath: string,
  digest: string,
): void {
  const receipt = integrityByRealPath.get(realPath)
  if (!receipt || receipt.sha256 !== digest)
    throw new ClassifierError(
      'INVALID_INPUT',
      'Native mask is absent from its independent integrity receipt',
    )
}

function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const bytes = await readFile(path, signal ? { signal } : undefined)
  try {
    signal?.throwIfAborted()
    return contentHash(bytes)
  } finally {
    bytes.fill(0)
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function safeRealFile(path: string, root?: string): Promise<string> {
  const resolved = await realpath(path)
  const parent = await realpath(dirname(resolve(path)))
  if (!inside(parent, resolved))
    throw new ClassifierError(
      'INVALID_INPUT',
      'Native artifact resolves outside its containing directory',
    )
  if (root && !inside(await realpath(root), resolved))
    throw new ClassifierError('INVALID_INPUT', 'Native artifact resolves outside its pinned root')
  return resolved
}

function sameBox(
  actual: { left: number; top: number; width: number; height: number },
  expected: readonly number[],
): boolean {
  return (
    actual.left === expected[0] &&
    actual.top === expected[1] &&
    actual.left + actual.width === expected[2] &&
    actual.top + actual.height === expected[3]
  )
}

/** Loads only H5a-v2 native receipts and their source-sized candidate bytes. */
export async function loadH6NativeArtifacts(
  h5aDirectory: string,
  h4eDirectory: string,
  signal: AbortSignal,
): Promise<{
  cases: H6NativeCase[]
  closure: H6NativeClosureEntry[]
  locks: typeof H6_NATIVE_LOCKS
}> {
  const h5a = resolve(h5aDirectory)
  const h4e = resolve(h4eDirectory)
  const runPath = resolve(h5a, 'run.json')
  const freezePath = resolve(h5a, 'freeze.json')
  const integrityPath = resolve(h5a, 'postrun-integrity.json')
  const workerClosurePath = resolve(h5a, 'worker-closure.json')
  const closure: H6NativeClosureEntry[] = []
  for (const [path, digest] of [
    [runPath, H6_NATIVE_LOCKS.h5aRun],
    [freezePath, H6_NATIVE_LOCKS.h5aFreeze],
    [integrityPath, H6_NATIVE_LOCKS.h5aIntegrity],
    [workerClosurePath, H6_NATIVE_LOCKS.h5aWorkerClosure],
  ] as const) {
    assertActive(signal)
    if ((await hashFile(path, signal)) !== digest)
      throw new ClassifierError('INVALID_INPUT', `Pinned H5a file changed: ${basename(path)}`)
    closure.push({ path, sha256: digest })
  }
  const run = h5aRunSchema.parse(await readJson(runPath))
  const freeze = freezeSchema.parse(await readJson(freezePath))
  const integrity = integritySchema.parse(await readJson(integrityPath))
  if (integrity.h5a_run_sha256 !== H6_NATIVE_LOCKS.h5aRun)
    throw new ClassifierError('INVALID_INPUT', 'H5a integrity sidecar targets another run')
  const integrityByRealPath = await buildIntegrityReceiptByRealPath(integrity.files, signal)
  const assertIntegrityReceipt = (realPath: string, digest: string): void => {
    assertIntegrityReceiptForRealPath(integrityByRealPath, realPath, digest)
  }
  if (
    run.cases.length !== 12 ||
    freeze.cases.length !== 12 ||
    JSON.stringify(run.cases.map((row) => row.case_id)) !== JSON.stringify(H6_CASE_IDS) ||
    JSON.stringify(freeze.cases.map((row) => row.case_id)) !== JSON.stringify(H6_CASE_IDS)
  )
    throw new ClassifierError('INVALID_INPUT', 'H5a inputs differ from the fixed twelve-case order')
  if (
    run.h3b.run.sha256 !== H6_NATIVE_LOCKS.h3bRun ||
    run.h4e_ui_cache.run.sha256 !== H6_NATIVE_LOCKS.h4eRun
  )
    throw new ClassifierError('INVALID_INPUT', 'H5a inherited H3b/H4e identity mismatch')

  const h4eRunPath = resolve(h4e, 'run.json')
  if (
    resolve(run.h4e_ui_cache.run.path) !== h4eRunPath ||
    (await hashFile(h4eRunPath, signal)) !== H6_NATIVE_LOCKS.h4eRun
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Supplied H4e run differs from the H5a frozen receipt',
    )
  const h4eRunRealPath = await safeRealFile(h4eRunPath, h4e)
  closure.push({ path: h4eRunRealPath, sha256: H6_NATIVE_LOCKS.h4eRun })
  const h3bRunPath = await safeRealFile(resolve(run.h3b.run.path))
  if ((await hashFile(h3bRunPath, signal)) !== H6_NATIVE_LOCKS.h3bRun)
    throw new ClassifierError('INVALID_INPUT', 'Pinned H3b run changed')
  closure.push({ path: h3bRunPath, sha256: H6_NATIVE_LOCKS.h3bRun })

  const h4eRun = h4eSchema.parse(await readJson(h4eRunPath))
  const h4eCandidates = h4eRun.results.map((candidate, index) => ({
    id: basename(candidate.mask_path).replace(/-mask\.png$/u, ''),
    path: resolve(resolve(h4eDirectory), candidate.mask_path),
    sha256: candidate.mask_sha256,
    expectedBox: candidate.mask_box_xyxy,
    sourceWidth: candidate.source_width,
    sourceHeight: candidate.source_height,
    sourceFamily: 'h4e-sam2' as const,
    ordinal: index,
  }))
  const cases: H6NativeCase[] = []
  for (const case_id of H6_CASE_IDS) {
    assertActive(signal)
    const row = run.cases.find((candidate) => candidate.case_id === case_id)
    const frozen = freeze.cases.find((candidate) => candidate.case_id === case_id)
    if (
      !row ||
      !frozen ||
      row.status !== 'complete' ||
      row.source_sha256 !== frozen.source.sha256 ||
      row.target !== frozen.target
    )
      throw new ClassifierError(
        'INVALID_INPUT',
        `H5a frozen source/target/result mismatch for ${case_id}`,
      )
    const sourcePath = await safeRealFile(resolve(frozen.source.path))
    const sourceInfo = await stat(sourcePath)
    if (
      !sourceInfo.isFile() ||
      sourceInfo.size !== frozen.source.bytes ||
      (await hashFile(sourcePath, signal)) !== frozen.source.sha256
    )
      throw new ClassifierError('INVALID_INPUT', `H5a source bytes/hash mismatch for ${case_id}`)
    closure.push({ path: sourcePath, sha256: frozen.source.sha256 })

    const masks: H6NativeMaskDescriptor[] = []
    for (const [ordinal, candidate] of row.dino_candidates.entries()) {
      if (candidate.id !== `C${String(ordinal).padStart(2, '0')}`)
        throw new ClassifierError('INVALID_INPUT', 'H3b D aliases are not in frozen stable order')
      const path = await safeRealFile(resolve(candidate.mask_path))
      assertIntegrityReceipt(path, candidate.mask_sha256)
      masks.push({
        family: 'D',
        source_family: 'h3b-dino-sam2',
        source_alias: candidate.id,
        source_mask_path: path,
        source_mask_sha256: candidate.mask_sha256,
        expected_box_xyxy: candidate.mask_box_xyxy,
      })
    }

    let width = 0
    let height = 0
    let nativeGenerationMs: number | null = null
    const sourceResultPath = row.omni_source_result ? resolve(row.omni_source_result) : null
    if (sourceResultPath) {
      if (!inside(h5a, sourceResultPath))
        throw new ClassifierError('INVALID_INPUT', 'H5a source result escaped its run root')
      const resultPath = await safeRealFile(sourceResultPath, h5a)
      const receipt = integrityByRealPath.get(resultPath)
      if (!receipt || (await hashFile(resultPath, signal)) !== receipt.sha256)
        throw new ClassifierError(
          'INVALID_INPUT',
          'H5a source result JSON differs from its frozen receipt',
        )
      closure.push({ path: resultPath, sha256: receipt.sha256 })
      const sourceResult = sourceResultSchema.parse(await readJson(resultPath))
      if (sourceResult.source.sha256 !== row.source_sha256)
        throw new ClassifierError('INVALID_INPUT', 'H5a source result refers to another image')
      width = sourceResult.dimensions.width
      height = sourceResult.dimensions.height
      nativeGenerationMs =
        sourceResult.elapsed_ms_including_child_startup ??
        sourceResult.timing_ms?.generation ??
        null
      for (const [ordinal, candidate] of sourceResult.sam2.candidates.entries()) {
        const path = await safeRealFile(resolve(candidate.mask_path), h5a)
        assertIntegrityReceipt(path, candidate.mask_sha256)
        const id = candidate.id ?? `U${String(ordinal).padStart(2, '0')}`
        if (id !== `U${String(ordinal).padStart(2, '0')}`)
          throw new ClassifierError('INVALID_INPUT', 'Omni U aliases are not in frozen order')
        masks.push({
          family: 'U',
          source_family: candidate.cached_h4e ? 'h4e-sam2' : 'omni-sam2',
          source_alias: id,
          source_mask_path: path,
          source_mask_sha256: candidate.mask_sha256,
          expected_box_xyxy: candidate.mask_box_xyxy,
        })
      }
    } else {
      if (row.source_sha256 !== h4eRun.source.sha256)
        throw new ClassifierError('INVALID_INPUT', 'H4e cache source differs from H5a UI source')
      nativeGenerationMs = 0
      width = h4eCandidates[0]?.sourceWidth ?? 0
      height = h4eCandidates[0]?.sourceHeight ?? 0
      for (const [ordinal, candidate] of h4eCandidates.entries()) {
        const path = await safeRealFile(candidate.path, h4eDirectory)
        assertIntegrityReceipt(path, candidate.sha256)
        if (
          candidate.id !== `candidate-${String(ordinal).padStart(3, '0')}` ||
          candidate.sourceWidth !== width ||
          candidate.sourceHeight !== height
        )
          throw new ClassifierError('INVALID_INPUT', 'H4e cache order or source dimensions differ')
        masks.push({
          family: 'U',
          source_family: candidate.sourceFamily,
          source_alias: candidate.id,
          source_mask_path: path,
          source_mask_sha256: candidate.sha256,
          expected_box_xyxy: candidate.expectedBox,
        })
      }
    }
    if (
      width < 1 ||
      height < 1 ||
      row.dino_candidates.length > 36 ||
      masks.filter((mask) => mask.family === 'U').length > 36 ||
      masks.length > 72 ||
      row.packed_mask_bytes_combined > 19 * 1024 * 1024
    )
      throw new ClassifierError(
        'RESOURCE_LIMIT',
        `H5a source or mask limits exceeded for ${case_id}`,
      )
    for (const mask of masks)
      closure.push({ path: mask.source_mask_path, sha256: mask.source_mask_sha256 })
    cases.push({
      case_id,
      target: frozen.target,
      source_path: sourcePath,
      source_sha256: frozen.source.sha256,
      source_width: width,
      source_height: height,
      native_generation_ms: nativeGenerationMs,
      masks,
    })
  }
  return {
    cases,
    closure: [...new Map(closure.map((item) => [`${item.path}:${item.sha256}`, item])).values()],
    locks: H6_NATIVE_LOCKS,
  }
}

export async function decodeH6NativeCase(
  item: H6NativeCase,
  signal: AbortSignal,
): Promise<{
  image: RgbaRaster
  families: Record<'D' | 'U', Array<{ id: string; mask: PackedBinaryMask }>>
  dispose(): void
}> {
  assertActive(signal)
  const bytes = await readFile(item.source_path, { signal })
  let image: RgbaRaster | undefined
  const masks: PackedBinaryMask[] = []
  try {
    assertActive(signal)
    if (contentHash(bytes) !== item.source_sha256)
      throw new ClassifierError('INVALID_INPUT', 'H6 source hash changed before replay')
    const normalized = await createSharpRaster().normalize(new Uint8Array(bytes), signal)
    try {
      const raw = await sharp(normalized.bytes, { limitInputPixels: limits.imagePixels })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      try {
        if (
          raw.info.width !== item.source_width ||
          raw.info.height !== item.source_height ||
          raw.info.channels !== 4
        )
          throw new ClassifierError(
            'INVALID_INPUT',
            'H6 source dimensions differ from frozen native masks',
          )
        image = {
          data: Uint8Array.from(raw.data),
          width: raw.info.width,
          height: raw.info.height,
          format: 'rgba8',
        }
      } finally {
        raw.data.fill(0)
      }
    } finally {
      normalized.bytes.fill(0)
    }
    const families: Record<'D' | 'U', Array<{ id: string; mask: PackedBinaryMask }>> = {
      D: [],
      U: [],
    }
    let packedBytes = 0
    for (const descriptor of item.masks) {
      assertActive(signal)
      const maskBytes = await readFile(descriptor.source_mask_path, { signal })
      try {
        if (contentHash(maskBytes) !== descriptor.source_mask_sha256)
          throw new ClassifierError('INVALID_INPUT', 'H6 candidate mask hash changed')
        const decoded = await sharp(maskBytes, {
          limitInputPixels: limits.imagePixels,
          failOn: 'error',
        })
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true })
        try {
          assertActive(signal)
          if (
            decoded.info.width !== item.source_width ||
            decoded.info.height !== item.source_height ||
            decoded.info.channels !== 1
          )
            throw new ClassifierError('INVALID_INPUT', 'H6 candidate mask is not source-sized')
          const binary = new Uint8Array(decoded.data.length)
          try {
            let left = item.source_width
            let top = item.source_height
            let right = -1
            let bottom = -1
            for (let index = 0; index < decoded.data.length; index++) {
              const value = decoded.data[index]
              if (value !== 0 && value !== 255)
                throw new ClassifierError('INVALID_INPUT', 'H6 candidate mask is not binary')
              if (value === 255) {
                binary[index] = 1
                const x = index % item.source_width
                const y = Math.floor(index / item.source_width)
                left = Math.min(left, x)
                top = Math.min(top, y)
                right = Math.max(right, x)
                bottom = Math.max(bottom, y)
              }
            }
            if (
              right < left ||
              !sameBox(
                { left, top, width: right - left + 1, height: bottom - top + 1 },
                descriptor.expected_box_xyxy,
              )
            )
              throw new ClassifierError(
                'INVALID_INPUT',
                'H6 candidate foreground box differs from pinned bounds',
              )
            const packed = packBinaryMask(binary, item.source_width, item.source_height)
            packedBytes += packed.data.byteLength
            if (packedBytes > 19 * 1024 * 1024) {
              packed.data.fill(0)
              throw new ClassifierError('RESOURCE_LIMIT', 'H6 packed masks exceed 19 MiB')
            }
            masks.push(packed)
            families[descriptor.family].push({ id: descriptor.source_alias, mask: packed })
          } finally {
            binary.fill(0)
          }
        } finally {
          decoded.data.fill(0)
        }
      } finally {
        maskBytes.fill(0)
      }
    }
    return {
      image,
      families,
      dispose() {
        image?.data.fill(0)
        for (const mask of masks) mask.data.fill(0)
      },
    }
  } catch (error) {
    image?.data.fill(0)
    for (const mask of masks) mask.data.fill(0)
    throw error
  } finally {
    bytes.fill(0)
  }
}
