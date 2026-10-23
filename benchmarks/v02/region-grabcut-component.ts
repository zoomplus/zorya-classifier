import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { RasterImage } from '../../src/entities/contracts.js'
import type { BinaryMask, SegmentationInput } from '../../src/entities/segmentation.js'
import { createSharpRaster, readCanonicalPixels } from '../../src/infrastructure/raster.js'
import { createGrabCutSegmenter } from '../../src/infrastructure/segmentation/grabcut/index.js'
import { createSharpCutoutRaster } from '../../src/infrastructure/segmentation/cutout-raster.js'
import { cropMask, maskedRgba, validateMask } from '../../src/features/segmentation/mask.js'
import { freshProducerTask, loadFreshCorpus, loadFreshImage } from './fresh-corpus.js'
import { regionSeededDevManifests } from './region-seeded-runner.js'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const rectSchema = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
const seedSchema = z
  .object({
    status: z.string(),
    region: rectSchema.optional(),
    sourceWidth: z.number().int().positive().optional(),
    sourceHeight: z.number().int().positive().optional(),
    searchLimit: rectSchema.optional(),
  })
  .passthrough()
const summaryRowSchema = z
  .object({
    caseId: z.string().min(1),
    imageSha256: hashSchema,
    extraction: z
      .object({
        status: z.string(),
        seed: seedSchema,
        mask: z
          .object({
            file: z.literal('mask.u8'),
            sha256: hashSchema,
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            sourceRegion: rectSchema,
            sourceOffset: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()
const summarySchema = z
  .object({
    runId: z.string().min(1),
    profileId: z.literal('native-luna-region-seeded-sam-dev-v1'),
    phase: z.literal('dev'),
    status: z.literal('complete'),
    plannedCaseIds: z.array(z.string()).length(40),
    completedCaseIds: z.array(z.string()).length(40),
    results: z.array(summaryRowSchema).length(40),
  })
  .passthrough()
const candidateRunId = 'v02-region-seeded-dev-2026-10-20T215428247Z-57df1119'
const candidateSummarySha256 = 'dc48416d0d189bdd3856c6719d055fbb4c36f426d014cc8a231a1df98a761d6c'

interface ComponentBounds {
  left: { start: number; endExclusive: number }
  right: { start: number; endExclusive: number }
  top: { start: number; endExclusive: number }
  bottom: { start: number; endExclusive: number }
}

export function fullRoiBounds(width: number, height: number): ComponentBounds {
  return {
    left: { start: 0, endExclusive: width },
    right: { start: 0, endExclusive: width },
    top: { start: 0, endExclusive: height },
    bottom: { start: 0, endExclusive: height },
  }
}

export function foregroundRect(
  mask: BinaryMask,
): { left: number; top: number; width: number; height: number } | undefined {
  if (
    mask.format !== 'binary-u8' ||
    !Number.isSafeInteger(mask.width) ||
    !Number.isSafeInteger(mask.height) ||
    mask.width < 1 ||
    mask.height < 1 ||
    mask.data.length !== mask.width * mask.height
  )
    throw new TypeError('Invalid full-frame binary mask')
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const value = mask.data[y * mask.width + x]
      if (value !== 0 && value !== 1) throw new TypeError('Mask values must be binary 0 or 1')
      if (value !== 1) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return right < left ? undefined : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeImmutable(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
    bytes.fill(0)
  }
}

function roiFor(width: number, height: number) {
  return { left: 0, top: 0, width, height }
}

function safeCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = error.code
    return /^[A-Z_]{2,64}$/u.test(code) ? code : 'ERROR'
  }
  return 'ERROR'
}

interface GrabCutComponentOptions {
  summaryPath: string
  originalRunDir: string
  imageRoot: string
  corpusRoot: string
  assetPath: string
  outputRoot: string
}

export async function runRegionGrabCutComponent(options: GrabCutComponentOptions): Promise<string> {
  const scriptBytes = await readFile(fileURLToPath(import.meta.url))
  const scriptSha256 = sha(scriptBytes)
  scriptBytes.fill(0)
  const summaryBytes = await readFile(options.summaryPath)
  const parsedSummary = summarySchema.parse(JSON.parse(summaryBytes.toString('utf8')))
  if (
    parsedSummary.runId !== candidateRunId ||
    new Set(parsedSummary.plannedCaseIds).size !== 40 ||
    new Set(parsedSummary.completedCaseIds).size !== 40 ||
    new Set(parsedSummary.results.map((row) => row.caseId)).size !== 40 ||
    parsedSummary.results.some((row) => !parsedSummary.plannedCaseIds.includes(row.caseId))
  )
    throw new TypeError('Candidate DEV summary does not contain its exact 40-case denominator')
  const sourceSummarySha256 = sha(summaryBytes)
  if (sourceSummarySha256 !== candidateSummarySha256)
    throw new TypeError('Candidate DEV summary hash does not match the selected immutable run')
  summaryBytes.fill(0)

  const manifestInputs = regionSeededDevManifests.map((manifest, index) => ({
    path: join(
      options.corpusRoot,
      'benchmarks/v02/corpus',
      ['dev/inputs.json', 'dev-independent-ui/inputs.json', 'dev-independent-map/inputs.json'][
        index
      ]!,
    ),
    sha256: manifest.sha256,
  }))
  const abort = new AbortController()
  const corpus = await loadFreshCorpus(
    { manifests: manifestInputs, imageRoot: options.imageRoot },
    abort.signal,
  )
  if (corpus.cases.length !== 40) throw new TypeError('Pinned DEV corpus must contain 40 cases')
  for (const item of corpus.cases) {
    const sourceBytes = await loadFreshImage(item, corpus.imageRoot, abort.signal)
    sourceBytes.fill(0)
  }

  const summaryById = new Map(parsedSummary.results.map((row) => [row.caseId, row]))
  if (corpus.cases.some((item) => !summaryById.has(item.caseId)))
    throw new TypeError('Candidate summary and pinned DEV corpus IDs differ')
  if (
    corpus.cases.some((item) => !parsedSummary.plannedCaseIds.includes(item.caseId)) ||
    parsedSummary.plannedCaseIds.some(
      (caseId) => !corpus.cases.some((item) => item.caseId === caseId),
    )
  )
    throw new TypeError('Candidate summary and pinned DEV corpus case sets differ')

  const asset = await readFile(options.assetPath)
  const assetStat = await stat(options.assetPath)
  const assetSha256 = sha(asset)
  asset.fill(0)
  if (
    assetStat.size !== 10_964_323 ||
    assetSha256 !== '63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0'
  )
    throw new TypeError('GrabCut OpenCV asset does not match the pinned component asset')

  const originalRunDir = await realpath(options.originalRunDir)
  const descriptors: Array<Record<string, unknown>> = []
  for (const item of corpus.cases) {
    const row = summaryById.get(item.caseId)!
    const seed = row.extraction.seed
    const descriptor: Record<string, unknown> = {
      caseId: item.caseId,
      imageSha256: item.image.sha256,
      width: item.image.width,
      height: item.image.height,
      seedStatus: seed.status,
    }
    if (seed.status === 'located') {
      if (
        !seed.region ||
        seed.sourceWidth !== item.image.width ||
        seed.sourceHeight !== item.image.height ||
        seed.searchLimit?.left !== 0 ||
        seed.searchLimit?.top !== 0 ||
        seed.searchLimit?.width !== item.image.width ||
        seed.searchLimit?.height !== item.image.height
      )
        throw new TypeError(`Invalid recorded full-source seed geometry for ${item.caseId}`)
      descriptor.seedRegion = seed.region
      descriptor.samMask = row.extraction.mask
        ? {
            file: join(options.originalRunDir, item.caseId, 'mask.u8'),
            sha256: row.extraction.mask.sha256,
            width: row.extraction.mask.width,
            height: row.extraction.mask.height,
            sourceRegion: row.extraction.mask.sourceRegion,
          }
        : null
      if (row.extraction.mask) {
        const samPath = join(originalRunDir, item.caseId, 'mask.u8')
        const samBytes = await readFile(samPath)
        try {
          if (
            sha(samBytes) !== row.extraction.mask.sha256 ||
            samBytes.byteLength !== row.extraction.mask.width * row.extraction.mask.height
          )
            throw new TypeError(`Recorded SAM mask artifact mismatch for ${item.caseId}`)
        } finally {
          samBytes.fill(0)
        }
      }
    } else {
      descriptor.samMask = row.extraction.mask ? { sha256: row.extraction.mask.sha256 } : null
    }
    descriptors.push(descriptor)
  }

  const assetReal = await realpath(options.assetPath)
  if (isAbsolute(assetReal) === false) throw new TypeError('GrabCut asset path must be absolute')
  const id = `region-grabcut-component-${new Date().toISOString().replaceAll(/[-:.]/gu, '')}-${randomUUID().slice(0, 8)}`
  const outputDir = join(options.outputRoot, id)
  await mkdir(options.outputRoot, { recursive: true })
  await mkdir(outputDir, { recursive: false })
  const manifest = {
    schemaVersion: 1,
    runId: id,
    profileId: 'grabcut-region-seed-component-dev-v1',
    phase: 'dev-component-only',
    purpose:
      'Compare a caller-owned GrabCut segmentation component on recorded model-predicted DEV seeds; no model/provider calls.',
    sourceSummary: {
      path: options.summaryPath,
      sha256: sourceSummarySha256,
      runId: parsedSummary.runId,
    },
    componentScriptSha256: scriptSha256,
    corpus: corpus.manifests,
    plannedCaseIds: corpus.cases.map((item) => item.caseId),
    cases: descriptors,
    asset: { path: assetReal, bytes: assetStat.size, sha256: assetSha256 },
    policy: {
      modelCalls: 0,
      providerCalls: 0,
      seedSource: 'candidate DEV extraction.seed.region only when status=located',
      image: 'oriented full source RGBA',
      prompt: 'seed-region',
      wholeRegion: 'full source image hard ROI',
      concurrency: { maxActiveNative: 1, maxWaitingNative: 2, casesInFlight: 3 },
      nativeJobTimeoutMs: 10_000,
      fallback: false,
      retries: 0,
      latencyRankingEligible: false,
    },
  }
  const manifestPath = join(outputDir, 'run-manifest.json')
  await writeImmutable(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const manifestBytes = await readFile(manifestPath)
  const manifestSha256 = sha(manifestBytes)
  manifestBytes.fill(0)
  process.stdout.write(
    `${JSON.stringify({ event: 'component-frozen', runId: id, manifestSha256 })}\n`,
  )

  const rows: Record<string, unknown>[] = []
  let segmenter: Awaited<ReturnType<typeof createGrabCutSegmenter>> | undefined
  let adapterInitialized = false
  let settleAttempted = false
  let disposeAttempted = false
  let settleSucceeded = false
  let disposeSucceeded = false
  let primaryFailure: unknown
  let settleFailure: unknown
  let disposeFailure: unknown
  const raster = createSharpRaster()
  const cutout = createSharpCutoutRaster()
  try {
    segmenter = await createGrabCutSegmenter({ assetPath: assetReal })
    adapterInitialized = true
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < corpus.cases.length) {
        const caseIndex = cursor++
        const item = corpus.cases[caseIndex]!
        const candidate = summaryById.get(item.caseId)!
        const seed = candidate.extraction.seed
        const row: Record<string, unknown> = {
          caseId: item.caseId,
          imageSha256: item.image.sha256,
          source: { width: item.image.width, height: item.image.height },
          seed:
            seed.status === 'located'
              ? { status: 'located', region: seed.region }
              : { status: seed.status },
          samBaseline: candidate.extraction.mask
            ? {
                status: 'available',
                sha256: candidate.extraction.mask.sha256,
                width: candidate.extraction.mask.width,
                height: candidate.extraction.mask.height,
                sourceRegion: candidate.extraction.mask.sourceRegion,
                originalArtifact: join(options.originalRunDir, item.caseId, 'mask.u8'),
              }
            : { status: 'unavailable' },
          status: seed.status === 'located' ? 'pending' : 'unknown',
        }
        rows[caseIndex] = row
        if (seed.status !== 'located') continue
        let sourceBytes: Uint8Array | undefined
        let source: RasterImage | undefined
        let rgba: Uint8Array | undefined
        let segmentRgba: Uint8Array | undefined
        let rawMask: Uint8Array | undefined
        let nativeMaskData: Uint8Array | undefined
        let cropped: BinaryMask | undefined
        let cropRgba: Uint8Array | undefined
        try {
          const signal = AbortSignal.timeout(30_000)
          sourceBytes = await loadFreshImage(item, corpus.imageRoot, signal)
          source = await raster.normalize(sourceBytes, signal)
          if (source.width !== item.image.width || source.height !== item.image.height)
            throw new TypeError('Normalized source dimensions changed')
          const decoded = await readCanonicalPixels(source, signal)
          rgba = decoded.data
          const full = roiFor(source.width, source.height)
          const seedRegion = rectSchema.parse(seed.region)
          const task = freshProducerTask(item)
          const started = performance.now()
          segmentRgba = new Uint8Array(rgba)
          const segmentation = await segmenter!.segment({
            image: {
              data: segmentRgba,
              width: source.width,
              height: source.height,
              format: 'rgba8',
            },
            seedRegion,
            prompt: 'seed-region',
            wholeRegion: full,
            bounds: fullRoiBounds(source.width, source.height),
            roi: full,
            target: task.target,
            exclusions: [],
            completeness: 'visible-object',
            signal,
          } satisfies SegmentationInput)
          const elapsed = Math.max(0, performance.now() - started)
          row.durationMs = elapsed
          if (segmentation.status === 'unknown') {
            row.status = 'unknown'
            row.reason = 'segmenter-unknown'
            row.segmentation = segmentation.metadata
            continue
          }
          nativeMaskData = segmentation.mask.data
          rawMask = new Uint8Array(segmentation.mask.data)
          const mask: BinaryMask = {
            data: rawMask,
            width: source.width,
            height: source.height,
            format: 'binary-u8',
          }
          let region: ReturnType<typeof foregroundRect>
          try {
            region = validateMask(
              mask,
              { data: rgba, width: source.width, height: source.height, format: 'rgba8' },
              full,
              seedRegion,
            )
          } catch (error) {
            row.status = 'failed'
            row.errorCode = safeCode(error)
            continue
          }
          const unfilteredBox = foregroundRect(mask)
          if (!region || !unfilteredBox) {
            row.status = 'unknown'
            row.reason = 'empty-or-seed-disjoint-mask'
            row.segmentation = segmentation.metadata
            continue
          }
          cropped = cropMask(mask, region)
          cropRgba = maskedRgba(
            { data: rgba, width: source.width, height: source.height, format: 'rgba8' },
            mask,
            region,
          )
          const png = await cutout.png(
            { data: cropRgba, width: region.width, height: region.height, format: 'rgba8' },
            AbortSignal.timeout(30_000),
          )
          const caseDir = join(outputDir, item.caseId)
          await mkdir(caseDir, { recursive: false })
          const fullPath = join(caseDir, 'grabcut-full-mask.u8')
          const cropPath = join(caseDir, 'grabcut-mask.u8')
          const pngPath = join(caseDir, 'grabcut-cutout.png')
          await writeImmutable(fullPath, rawMask)
          await writeImmutable(cropPath, cropped.data)
          await writeImmutable(pngPath, png)
          row.status = 'segmented'
          row.fullMask = {
            file: fullPath,
            sha256: sha(rawMask),
            width: source.width,
            height: source.height,
            format: 'binary-u8',
          }
          row.mask = {
            file: cropPath,
            sha256: sha(cropped.data),
            width: cropped.width,
            height: cropped.height,
            sourceRegion: region,
            sourceOffset: { x: region.left, y: region.top },
            center: { x: region.left + region.width / 2, y: region.top + region.height / 2 },
          }
          row.cutout = { file: pngPath, sha256: sha(png), bytes: png.byteLength }
          row.foregroundExtent = unfilteredBox
          row.segmentation = segmentation.metadata
          png.fill(0)
        } catch (error) {
          row.status = error instanceof Error && error.name === 'TimeoutError' ? 'failed' : 'failed'
          row.errorCode = safeCode(error)
        } finally {
          sourceBytes?.fill(0)
          source?.bytes.fill(0)
          rgba?.fill(0)
          segmentRgba?.fill(0)
          rawMask?.fill(0)
          nativeMaskData?.fill(0)
          cropped?.data.fill(0)
          cropRgba?.fill(0)
        }
      }
    }
    const workers = await Promise.allSettled([worker(), worker(), worker()])
    const rejected = workers.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') primaryFailure = rejected.reason
  } catch (error) {
    primaryFailure = error
  } finally {
    try {
      settleAttempted = true
      await segmenter?.settle()
      settleSucceeded = true
    } catch (error) {
      settleFailure = error
    }
    try {
      disposeAttempted = true
      await segmenter?.dispose()
      disposeSucceeded = true
    } catch (error) {
      disposeFailure = error
    }
    if (!primaryFailure && (settleFailure || disposeFailure))
      primaryFailure = settleFailure ?? disposeFailure
  }

  const completeRows = Array.from(
    { length: 40 },
    (_, index) =>
      rows[index] ?? {
        caseId: corpus.cases[index]!.caseId,
        imageSha256: corpus.cases[index]!.image.sha256,
        status: 'not-run',
      },
  )
  const sourceAfterBytes = await readFile(options.summaryPath)
  const sourceAfter = sha(sourceAfterBytes)
  sourceAfterBytes.fill(0)
  const statusCounts: Record<string, number> = {}
  for (const row of completeRows) {
    const status = typeof row.status === 'string' ? row.status : 'invalid'
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
  }
  const terminal = {
    schemaVersion: 1,
    runId: id,
    profileId: manifest.profileId,
    phase: manifest.phase,
    status: primaryFailure ? 'incomplete' : 'complete',
    sourceSummarySha256Before: sourceSummarySha256,
    sourceSummarySha256After: sourceAfter,
    sourceUnchanged: sourceSummarySha256 === sourceAfter,
    manifestSha256,
    plannedCaseIds: corpus.cases.map((item) => item.caseId),
    completedCaseIds: completeRows
      .filter((row) => row.status !== 'not-run')
      .map((row) => row.caseId),
    missingCaseIds: completeRows.filter((row) => row.status === 'not-run').map((row) => row.caseId),
    results: completeRows,
    aggregate: {
      statusCounts,
      seedLocated: descriptors.filter((row) => row.seedStatus === 'located').length,
    },
    cleanup: {
      adapterInitialized,
      settleAttempted,
      settleSucceeded,
      disposeAttempted,
      disposeSucceeded,
      settleError: settleErrorCode(settleFailure),
      disposeError: settleErrorCode(disposeFailure),
    },
    failureCode: primaryFailure ? safeCode(primaryFailure) : null,
  }
  const terminalPath = join(outputDir, primaryFailure ? 'incomplete-evidence.json' : 'summary.json')
  await writeImmutable(terminalPath, JSON.stringify(terminal, null, 2) + '\n')
  const terminalHash = sha(await readFile(terminalPath))
  await writeImmutable(
    join(outputDir, 'run-complete.json'),
    JSON.stringify(
      {
        runId: id,
        status: terminal.status,
        manifestSha256,
        terminalFile: terminalPath.split('/').at(-1),
        terminalSha256: terminalHash,
      },
      null,
      2,
    ) + '\n',
  )
  if (primaryFailure) throw primaryFailure
  return outputDir
}

function settleErrorCode(error: unknown): string | null {
  return error ? safeCode(error) : null
}
