import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'
import {
  COMPONENT_MAP_PROFILE_CONTROL_RGB,
  COMPONENT_MAP_PROFILE_HSV12,
  compressComponentMap,
  encodeComponentMap,
  processColorNormalizationImage,
} from '../experiments/color-normalization-v1.js'
import {
  COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS,
  COLOR_NORMALIZATION_MAX_ENCODED_BYTES,
  COLOR_NORMALIZATION_MAX_PIXELS,
  COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256,
  COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
  COLOR_NORMALIZATION_PROFILE_ID,
  COLOR_NORMALIZATION_RUN_DEADLINE_MS,
  COLOR_NORMALIZATION_RUN_SCHEMA,
  COLOR_NORMALIZATION_SOURCE_COMMIT,
  colorNormalizationProducerInputsSchema,
  type ColorNormalizationRunManifest,
} from './color-normalization-contract.js'

function configureSharpForColorNormalizationRun(): void {
  sharp.cache({ memory: 32, files: 0, items: 0 })
  sharp.concurrency(1)
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('code' in error)) return false
  return error.code === code
}

const PRODUCER_CLOSURE = [
  'benchmarks/experiments/color-normalization-v1.ts',
  'benchmarks/v03/color-normalization-contract.ts',
  'benchmarks/v03/run-color-normalization.ts',
] as const

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface ColorNormalizationRunGuard {
  deadlineAt: number
  signal: AbortSignal
  now: () => number
}

export function assertColorNormalizationRunContinues(guard: ColorNormalizationRunGuard): void {
  if (guard.now() > guard.deadlineAt) throw new Error('deadline-exceeded')
  if (guard.signal.aborted) throw new Error('aborted')
}

export async function writeColorNormalizationCompleteManifest(
  outputDirectory: string,
  manifest: ColorNormalizationRunManifest,
  guard: ColorNormalizationRunGuard,
): Promise<void> {
  assertColorNormalizationRunContinues(guard)
  await writeFile(join(outputDirectory, 'run-manifest.json'), JSON.stringify(manifest, null, 2))
  assertColorNormalizationRunContinues(guard)
}

async function producerCodeSha256(repositoryRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const relativePath of PRODUCER_CLOSURE) {
    const bytes = await readFile(join(repositoryRoot, relativePath))
    hash.update(relativePath)
    hash.update('\0')
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function resolveContained(root: string, candidatePath: string): string {
  if (isAbsolute(candidatePath)) throw new Error('path-absolute')
  const resolved = resolve(root, candidatePath)
  const part = relative(root, resolved)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('path-outside-root')
  return resolved
}

function rowsEqual(
  left: readonly (typeof COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS)[number][],
  right: readonly (typeof COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS)[number][],
): boolean {
  if (left.length !== right.length) return false
  return left.every((row, index) => {
    const other = right[index]
    return (
      row.caseId === other?.caseId &&
      row.image.path === other.image.path &&
      row.image.sha256 === other.image.sha256 &&
      row.image.width === other.image.width &&
      row.image.height === other.image.height
    )
  })
}

async function validateProducerInputs(
  path: string,
): Promise<typeof COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS> {
  const inputStat = await stat(path)
  if (inputStat.size > COLOR_NORMALIZATION_MAX_ENCODED_BYTES)
    throw new Error('producer-inputs-bytes-limit')
  const bytes = await readFile(path)
  if (sha256Bytes(bytes) !== COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256)
    throw new Error('producer-inputs-hash-mismatch')
  const parsed = colorNormalizationProducerInputsSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (!rowsEqual(parsed, COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS))
    throw new Error('producer-inputs-row-mismatch')
  return parsed
}

async function decodeOrientedRgba(
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  if (signal.aborted) throw new Error('aborted')
  if (bytes.byteLength > COLOR_NORMALIZATION_MAX_ENCODED_BYTES)
    throw new Error('encoded-bytes-limit')
  const pipeline = sharp(bytes, {
    limitInputPixels: COLOR_NORMALIZATION_MAX_PIXELS,
    failOn: 'error',
  })
    .rotate()
    .ensureAlpha()
    .raw()
  try {
    const decoded = await pipeline.toBuffer({ resolveWithObject: true })
    if (signal.aborted) throw new Error('aborted')
    if (
      decoded.info.width !== expectedWidth ||
      decoded.info.height !== expectedHeight ||
      decoded.info.channels !== 4
    )
      throw new Error('oriented-dimensions-mismatch')
    if (decoded.info.width * decoded.info.height > COLOR_NORMALIZATION_MAX_PIXELS)
      throw new Error('pixel-limit')
    return {
      data: new Uint8Array(decoded.data),
      width: decoded.info.width,
      height: decoded.info.height,
    }
  } finally {
    pipeline.destroy()
  }
}

export interface RunColorNormalizationOptions {
  repositoryRoot: string
  inputsPath: string
  dataRoot: string
  outputDirectory: string
  signal?: AbortSignal
  now?: () => number
}

export interface RunColorNormalizationProducerResult {
  manifest: ColorNormalizationRunManifest
  outputDirectoryOwned: boolean
}

export async function runColorNormalizationProducer(
  options: RunColorNormalizationOptions,
): Promise<RunColorNormalizationProducerResult> {
  configureSharpForColorNormalizationRun()
  const now = options.now ?? (() => performance.now())
  const started = now()
  const deadlineAt = started + COLOR_NORMALIZATION_RUN_DEADLINE_MS
  const signal = options.signal ?? new AbortController().signal
  const guard: ColorNormalizationRunGuard = { deadlineAt, signal, now }
  const repositoryRoot = resolve(options.repositoryRoot)
  const dataRoot = resolve(options.dataRoot)
  const outputDirectory = resolve(options.outputDirectory)

  let outputDirectoryOwned = false
  try {
    await mkdir(outputDirectory, { recursive: false })
    outputDirectoryOwned = true
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) throw new Error('output-exists')
    throw error
  }

  try {
    return await runColorNormalizationProducerBody(options, {
      repositoryRoot,
      dataRoot,
      outputDirectory,
      outputDirectoryOwned,
      guard,
    })
  } catch (error) {
    if (outputDirectoryOwned) {
      const message = error instanceof Error ? error.message : 'run-failed'
      try {
        const producerCodeSha256Value = await producerCodeSha256(repositoryRoot)
        await writeColorNormalizationFailureManifest(outputDirectory, {
          schema: COLOR_NORMALIZATION_RUN_SCHEMA,
          status: 'failed',
          profileId: COLOR_NORMALIZATION_PROFILE_ID,
          prospectiveFreezeSha256: COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
          sourceCommit: COLOR_NORMALIZATION_SOURCE_COMMIT,
          producerInputsSha256: COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256,
          producerCodeSha256: producerCodeSha256Value,
          dataRoot,
          deadlineMs: COLOR_NORMALIZATION_RUN_DEADLINE_MS,
          rows: [],
          uniqueImages: [],
          failure: { code: 'producer-failed', message },
        })
      } catch (secondary) {
        throw new AggregateError(
          [error, secondary],
          'producer-failed-and-failure-evidence-write-failed',
        )
      }
    }
    throw error
  }
}

async function runColorNormalizationProducerBody(
  options: RunColorNormalizationOptions,
  ctx: {
    repositoryRoot: string
    dataRoot: string
    outputDirectory: string
    outputDirectoryOwned: boolean
    guard: ColorNormalizationRunGuard
  },
): Promise<RunColorNormalizationProducerResult> {
  const producerCodeSha = await producerCodeSha256(ctx.repositoryRoot)
  const rows = await validateProducerInputs(resolve(options.inputsPath))

  const uniqueBySha = new Map<
    string,
    (typeof COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS)[number]['image'] & { path: string }
  >()
  for (const row of rows) {
    const prior = uniqueBySha.get(row.image.sha256)
    if (
      prior &&
      (prior.path !== row.image.path ||
        prior.width !== row.image.width ||
        prior.height !== row.image.height)
    )
      throw new Error('unique-image-metadata-conflict')
    uniqueBySha.set(row.image.sha256, row.image)
  }

  const imageArtifacts = new Map<
    string,
    {
      normalizedHsv12Png: string
      normalizedHsv12Sha256: string
      componentMapRgb: string
      componentMapRgbSha256: string
      componentMapHsv12: string
      componentMapHsv12Sha256: string
      profiles: ColorNormalizationRunManifest['rows'][number]['profiles']
    }
  >()

  for (const [sha, image] of uniqueBySha) {
    assertColorNormalizationRunContinues(ctx.guard)
    const imageStarted = ctx.guard.now()
    const encodedPath = resolveContained(ctx.dataRoot, image.path)
    const fileStat = await stat(encodedPath)
    if (fileStat.size > COLOR_NORMALIZATION_MAX_ENCODED_BYTES)
      throw new Error('encoded-bytes-limit')
    const encodedBytes = new Uint8Array(await readFile(encodedPath))
    if (sha256Bytes(encodedBytes) !== sha) throw new Error('source-hash-mismatch')
    const decoded = await decodeOrientedRgba(
      encodedBytes,
      image.width,
      image.height,
      ctx.guard.signal,
    )
    assertColorNormalizationRunContinues(ctx.guard)
    encodedBytes.fill(0)
    const processed = processColorNormalizationImage(decoded)
    assertColorNormalizationRunContinues(ctx.guard)
    decoded.data.fill(0)

    const imageDir = join(ctx.outputDirectory, 'images', sha)
    await mkdir(imageDir, { recursive: true })
    const normalizedPath = join(imageDir, 'normalized-hsv12.png')
    const normalizedPng = await sharp(processed.normalizedRgba, {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .png()
      .toBuffer()
    assertColorNormalizationRunContinues(ctx.guard)
    await writeFile(normalizedPath, normalizedPng)
    const normalizedSha = sha256Bytes(normalizedPng)

    const rgbMapBytes = compressComponentMap(
      encodeComponentMap(
        COMPONENT_MAP_PROFILE_CONTROL_RGB,
        image.width,
        image.height,
        processed.controlComponentIds,
      ),
    )
    const hsvMapBytes = compressComponentMap(
      encodeComponentMap(
        COMPONENT_MAP_PROFILE_HSV12,
        image.width,
        image.height,
        processed.hsv12ComponentIds,
      ),
    )
    const rgbMapPath = join(imageDir, 'component-map-rgb.cmap.gz')
    const hsvMapPath = join(imageDir, 'component-map-hsv12.cmap.gz')
    assertColorNormalizationRunContinues(ctx.guard)
    await writeFile(rgbMapPath, rgbMapBytes)
    await writeFile(hsvMapPath, hsvMapBytes)

    const elapsedMs = ctx.guard.now() - imageStarted
    imageArtifacts.set(sha, {
      normalizedHsv12Png: relative(ctx.outputDirectory, normalizedPath),
      normalizedHsv12Sha256: normalizedSha,
      componentMapRgb: relative(ctx.outputDirectory, rgbMapPath),
      componentMapRgbSha256: sha256Bytes(rgbMapBytes),
      componentMapHsv12: relative(ctx.outputDirectory, hsvMapPath),
      componentMapHsv12Sha256: sha256Bytes(hsvMapBytes),
      profiles: {
        controlRgb: { ...processed.stats.controlRgb, elapsedMs },
        hsv12: { ...processed.stats.hsv12, elapsedMs },
      },
    })
    processed.normalizedRgba.fill(0)
  }

  const manifestRows = rows.map((row) => {
    const artifacts = imageArtifacts.get(row.image.sha256)
    if (!artifacts) throw new Error('missing-artifacts')
    return {
      caseId: row.caseId,
      imageSha256: row.image.sha256,
      imagePath: row.image.path,
      sourceWidth: row.image.width,
      sourceHeight: row.image.height,
      uniqueImageKey: row.image.sha256,
      artifacts: {
        normalizedHsv12Png: artifacts.normalizedHsv12Png,
        normalizedHsv12Sha256: artifacts.normalizedHsv12Sha256,
        componentMapRgb: artifacts.componentMapRgb,
        componentMapRgbSha256: artifacts.componentMapRgbSha256,
        componentMapHsv12: artifacts.componentMapHsv12,
        componentMapHsv12Sha256: artifacts.componentMapHsv12Sha256,
      },
      profiles: artifacts.profiles,
    }
  })

  const manifest: ColorNormalizationRunManifest = {
    schema: COLOR_NORMALIZATION_RUN_SCHEMA,
    status: 'complete',
    profileId: COLOR_NORMALIZATION_PROFILE_ID,
    prospectiveFreezeSha256: COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256,
    sourceCommit: COLOR_NORMALIZATION_SOURCE_COMMIT,
    producerInputsSha256: COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256,
    producerCodeSha256: producerCodeSha,
    dataRoot: ctx.dataRoot,
    deadlineMs: COLOR_NORMALIZATION_RUN_DEADLINE_MS,
    rows: manifestRows,
    uniqueImages: [...uniqueBySha.entries()].map(([key, image]) => ({
      key,
      sha256: key,
      width: image.width,
      height: image.height,
      path: image.path,
    })),
  }

  await writeColorNormalizationCompleteManifest(ctx.outputDirectory, manifest, ctx.guard)
  return { manifest, outputDirectoryOwned: ctx.outputDirectoryOwned }
}

export async function writeColorNormalizationFailureManifest(
  outputDirectory: string,
  partial: Omit<ColorNormalizationRunManifest, 'status'> & {
    status: 'failed' | 'incomplete'
    failure: NonNullable<ColorNormalizationRunManifest['failure']>
  },
): Promise<void> {
  await writeFile(join(outputDirectory, 'run-manifest.json'), JSON.stringify(partial, null, 2))
}

function usage(): never {
  console.error(
    'Usage: node --import tsx benchmarks/v03/run-color-normalization.ts --inputs <path> --data-root <path> --output <new-directory>',
  )
  process.exitCode = 1
  throw new Error('cli-usage')
}

async function main(argv: string[]): Promise<void> {
  let parsed: { inputs: string; dataRoot: string; output: string } | undefined
  try {
    const args = parseArgs({
      args: argv,
      options: {
        inputs: { type: 'string' },
        'data-root': { type: 'string' },
        output: { type: 'string' },
      },
      strict: true,
    })
    if (!args.values.inputs || !args.values['data-root'] || !args.values.output) usage()
    parsed = {
      inputs: args.values.inputs,
      dataRoot: args.values['data-root'],
      output: args.values.output,
    }
  } catch {
    usage()
  }

  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COLOR_NORMALIZATION_RUN_DEADLINE_MS)
  try {
    await runColorNormalizationProducer({
      repositoryRoot,
      inputsPath: resolve(parsed!.inputs),
      dataRoot: resolve(parsed!.dataRoot),
      outputDirectory: resolve(parsed!.output),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function logCliFailure(error: unknown): void {
  if (error instanceof Error && error.message === 'cli-usage') return
  const message =
    error instanceof AggregateError
      ? error.errors.map((item) => (item instanceof Error ? item.message : String(item))).join('; ')
      : error instanceof Error
        ? error.message
        : 'producer-failed'
  console.error(message)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    logCliFailure(error)
    process.exitCode = 1
  })
}
