import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { z } from 'zod'

import { ClassifierError } from '../../src/entities/errors.js'
import type { SegmentationInput, SegmentationPort } from '../../src/entities/segmentation.js'
import {
  createGrabCutSegmenter,
  createMobileSamSegmenter,
} from '../../src/infrastructure/segmentation/index.js'
import { extractObject } from '../../src/processes/extract.js'
import type { RasterImage, RasterPort, PixelRect } from '../../src/entities/contracts.js'
import { createSharpCutoutRaster } from '../../src/infrastructure/segmentation/cutout-raster.js'
import { binaryMaskIoU } from './metrics.js'
import { ResourceRunner } from './resource-runner.js'

const rectSchema = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
const fixtureSchema = z
  .object({
    id: z.string().min(1),
    imagePath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceUrl: z.string().url(),
    license: z.string().min(1),
    target: z.string().min(1),
    seedRegion: rectSchema,
    wholeRegion: rectSchema,
    roi: rectSchema.optional(),
    referenceMaskPath: z.string().min(1).optional(),
    referenceMaskFormat: z.enum(['binary-u8', 'png-binary']).optional(),
    referenceMaskSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if ((item.referenceMaskPath === undefined) !== (item.referenceMaskSha256 === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Reference mask path and SHA256 must be supplied together',
      })
    if (item.referenceMaskFormat !== undefined && item.referenceMaskPath === undefined)
      context.addIssue({
        code: 'custom',
        message: 'Reference mask format requires a reference mask path',
      })
  })

interface SampleCase {
  id: string
  target: string
  image: SegmentationInput['image']
  seedRegion: PixelRect
  wholeRegion: PixelRect
  roi: PixelRect
  bounds: SegmentationInput['bounds']
  referenceMask?: Uint8Array
  provenance?: { sha256: string; sourceUrl: string; license: string }
}
interface RunRecord {
  caseId: string
  status: 'segmented' | 'unknown' | 'failed'
  durationMs: number
  maskPixels?: number
  maskIoU?: number
  errorCode?: string
}
interface CliOptions {
  backend: 'mobile-sam' | 'grabcut'
  encoderPath?: string
  decoderPath?: string
  opencvPath?: string
  fixtureManifest?: string
  outputPath?: string
  warmupSeconds: number
  durationSeconds: number
  idleSeconds: number
  sampleMs: number
}

function parseOptions(argv: readonly string[]): CliOptions {
  const value = new Map<string, string>()
  for (const arg of argv) {
    if (!arg.startsWith('--') || !arg.includes('='))
      throw new Error(`Expected --name=value, got ${arg}`)
    const separator = arg.indexOf('=')
    value.set(arg.slice(2, separator), arg.slice(separator + 1))
  }
  const backend = value.get('backend')
  if (backend !== 'mobile-sam' && backend !== 'grabcut')
    throw new Error('--backend=mobile-sam|grabcut is required')
  const integerOption = (key: string, fallback: number, minimum: number) => {
    const number = Number(value.get(key) ?? fallback)
    if (!Number.isSafeInteger(number) || number < minimum)
      throw new Error(`--${key} must be an integer >= ${minimum}`)
    return number
  }
  const encoderPath = value.get('encoder')
  const decoderPath = value.get('decoder')
  const opencvPath = value.get('opencv')
  const fixtureManifest = value.get('fixtures')
  const outputPath = value.get('out')
  return {
    backend,
    ...(encoderPath ? { encoderPath } : {}),
    ...(decoderPath ? { decoderPath } : {}),
    ...(opencvPath ? { opencvPath } : {}),
    ...(fixtureManifest ? { fixtureManifest } : {}),
    ...(outputPath ? { outputPath } : {}),
    warmupSeconds: integerOption('warmup-seconds', 600, 0),
    durationSeconds: integerOption('duration-seconds', 6540, 1),
    idleSeconds: integerOption('idle-seconds', 30, 1),
    sampleMs: integerOption('sample-ms', 5000, 250),
  }
}

function createSegmenter(options: CliOptions): Promise<SegmentationPort> {
  if (options.backend === 'mobile-sam') {
    if (!options.encoderPath || !options.decoderPath)
      throw new Error('MobileSAM requires --encoder and --decoder paths')
    return createMobileSamSegmenter({
      encoderPath: options.encoderPath,
      decoderPath: options.decoderPath,
    })
  }
  if (!options.opencvPath) throw new Error('GrabCut requires --opencv path')
  return createGrabCutSegmenter({ assetPath: options.opencvPath })
}

function syntheticCase(): SampleCase {
  const width = 256
  const height = 256
  const data = new Uint8Array(width * height * 4)
  const referenceMask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const foreground = x >= 90 && x < 164 && y >= 54 && y < 206
      data[index * 4] = foreground ? 226 : 228
      data[index * 4 + 1] = foreground ? 36 : 228
      data[index * 4 + 2] = foreground ? 42 : 228
      data[index * 4 + 3] = 255
      if (foreground) referenceMask[index] = 1
    }
  }
  return {
    id: 'synthetic-red-panel-v1',
    target: 'red rectangle',
    image: { data, width, height, format: 'rgba8' },
    seedRegion: { left: 111, top: 90, width: 30, height: 30 },
    wholeRegion: { left: 76, top: 40, width: 100, height: 180 },
    roi: { left: 0, top: 0, width, height },
    bounds: {
      left: { start: 90, endExclusive: 91 },
      right: { start: 163, endExclusive: 164 },
      top: { start: 54, endExclusive: 55 },
      bottom: { start: 205, endExclusive: 206 },
    },
    referenceMask,
    provenance: {
      sha256: createHash('sha256').update(data).digest('hex'),
      sourceUrl: 'synthetic://red-panel-v1',
      license: 'authored fixture',
    },
  }
}

async function readFixtures(path: string): Promise<SampleCase[]> {
  const manifestPath = resolve(path)
  const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const items = z.array(fixtureSchema).min(1).parse(raw)
  const root = dirname(manifestPath)
  const cases: SampleCase[] = []
  for (const item of items) {
    const imagePath = resolve(root, item.imagePath)
    const bytes = await readFile(imagePath)
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw new Error(`Fixture ${item.id} image hash does not match its manifest`)
    const decoded = await sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'error' })
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const image = {
      data: new Uint8Array(decoded.data),
      width: decoded.info.width,
      height: decoded.info.height,
      format: 'rgba8' as const,
    }
    const roi = item.roi ?? { left: 0, top: 0, width: image.width, height: image.height }
    for (const region of [item.seedRegion, item.wholeRegion, roi])
      if (region.left + region.width > image.width || region.top + region.height > image.height)
        throw new Error(`Fixture ${item.id} geometry is outside the oriented image`)
    let referenceMask: Uint8Array | undefined
    if (item.referenceMaskPath && item.referenceMaskSha256) {
      const maskBytes = await readFile(resolve(root, item.referenceMaskPath))
      if (createHash('sha256').update(maskBytes).digest('hex') !== item.referenceMaskSha256)
        throw new Error(`Fixture ${item.id} mask hash does not match its manifest`)
      if (item.referenceMaskFormat === 'png-binary') {
        const decodedMask = await sharp(maskBytes, {
          limitInputPixels: 16_777_216,
          failOn: 'error',
        })
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true })
        if (
          decodedMask.info.width !== image.width ||
          decodedMask.info.height !== image.height ||
          [...decodedMask.data].some((value) => value !== 0 && value !== 255)
        )
          throw new Error(
            `Fixture ${item.id} PNG reference mask must be source-sized with binary 0/255 values`,
          )
        referenceMask = Uint8Array.from(decodedMask.data, (value) => (value === 255 ? 1 : 0))
      } else {
        if (
          maskBytes.length !== image.width * image.height ||
          [...maskBytes].some((value) => value !== 0 && value !== 1)
        )
          throw new Error(
            `Fixture ${item.id} reference mask must be oriented source-sized binary bytes`,
          )
        referenceMask = new Uint8Array(maskBytes)
      }
    }
    cases.push({
      id: item.id,
      target: item.target,
      image,
      seedRegion: item.seedRegion,
      wholeRegion: item.wholeRegion,
      roi,
      bounds: boundsFromRect(item.wholeRegion),
      ...(referenceMask ? { referenceMask } : {}),
      provenance: { sha256: item.sha256, sourceUrl: item.sourceUrl, license: item.license },
    })
  }
  return cases
}

function boundsFromRect(rect: PixelRect): SegmentationInput['bounds'] {
  return {
    left: { start: rect.left, endExclusive: rect.left + 1 },
    right: { start: rect.left + rect.width - 1, endExclusive: rect.left + rect.width },
    top: { start: rect.top, endExclusive: rect.top + 1 },
    bottom: { start: rect.top + rect.height - 1, endExclusive: rect.top + rect.height },
  }
}

function inputFor(item: SampleCase, signal: AbortSignal): SegmentationInput {
  return {
    image: { ...item.image, data: new Uint8Array(item.image.data) },
    seedRegion: { ...item.seedRegion },
    wholeRegion: { ...item.wholeRegion },
    bounds: item.bounds,
    roi: { ...item.roi },
    target: item.target,
    exclusions: [],
    completeness: 'visible-object',
    signal,
  }
}

async function runOne(
  segmenter: SegmentationPort,
  item: SampleCase,
  signal = new AbortController().signal,
): Promise<RunRecord> {
  const started = performance.now()
  try {
    const result = await segmenter.segment(inputFor(item, signal))
    if (result.status === 'unknown')
      return { caseId: item.id, status: 'unknown', durationMs: performance.now() - started }
    const maskPixels = result.mask.data.reduce((sum, value) => sum + value, 0)
    const maskIoU = item.referenceMask
      ? binaryMaskIoU(result.mask.data, item.referenceMask).iou
      : undefined
    return {
      caseId: item.id,
      status: 'segmented',
      durationMs: performance.now() - started,
      maskPixels,
      ...(maskIoU !== undefined ? { maskIoU } : {}),
    }
  } catch (error) {
    return {
      caseId: item.id,
      status: 'failed',
      durationMs: performance.now() - started,
      errorCode: error instanceof ClassifierError ? error.code : 'UNEXPECTED',
    }
  }
}

async function runNegativeControl(
  item: SampleCase,
): Promise<{ result: string; segmentCalls: number }> {
  const png = await sharp(item.image.data, {
    raw: { width: item.image.width, height: item.image.height, channels: 4 },
  })
    .png()
    .toBuffer()
  const rasterImage: RasterImage = {
    bytes: new Uint8Array(png),
    width: item.image.width,
    height: item.image.height,
  }
  const raster: RasterPort = {
    normalize: async () => rasterImage,
    crop: async () => rasterImage,
    imageState: async () => [],
    grid: async () => rasterImage,
  }
  let segmentCalls = 0
  const segmenter: SegmentationPort = {
    async segment() {
      segmentCalls++
      throw new Error('negative control should not reach segmentation')
    },
    settle: async () => undefined,
    dispose: async () => undefined,
  }
  const result = await extractObject(
    {
      image: new Uint8Array(png),
      target: 'verified absent target',
      signal: new AbortController().signal,
    },
    {
      raster,
      image: createSharpCutoutRaster(),
      segmenter,
      locateWhole: async () => ({
        status: 'not-found',
        reason: 'absent-in-evaluated-region',
        metadata: {
          image: {
            width: item.image.width,
            height: item.image.height,
            coordinateSpace: 'oriented-source-pixels',
          },
          stages: [],
          durationMs: 0,
          knownCostUsd: 0,
          unknownCostCount: 0,
        },
      }),
    },
  )
  return { result: result.status, segmentCalls }
}

async function lifecycleChecks(options: CliOptions, item: SampleCase) {
  const segmenter = await createSegmenter(options)
  const positive = await runOne(segmenter, item)
  const negative = await runNegativeControl(item)
  const controller = new AbortController()
  const cancellation = segmenter.segment(inputFor(item, controller.signal))
  const abortTimer = setTimeout(
    () => controller.abort(new ClassifierError('ABORTED', 'Benchmark cancellation')),
    50,
  )
  let cancellationCode = 'NOT_CANCELLED'
  try {
    await cancellation
  } catch (error) {
    cancellationCode = error instanceof ClassifierError ? error.code : 'UNEXPECTED'
  }
  clearTimeout(abortTimer)
  const overloadInputs = Array.from({ length: 4 }, () =>
    segmenter.segment(inputFor(item, new AbortController().signal)),
  )
  const overload = await Promise.allSettled(overloadInputs)
  const capacityRejected = overload.filter(
    (entry) =>
      entry.status === 'rejected' &&
      entry.reason instanceof ClassifierError &&
      entry.reason.code === 'CAPACITY',
  ).length
  const badInput = inputFor(item, new AbortController().signal)
  badInput.image.data = Uint8Array.of(1)
  let invalidInputCode = 'NOT_REJECTED'
  try {
    await segmenter.segment(badInput)
  } catch (error) {
    invalidInputCode = error instanceof ClassifierError ? error.code : 'UNEXPECTED'
  }
  await segmenter.dispose()
  await segmenter.dispose()
  const brokenOptions: CliOptions =
    options.backend === 'mobile-sam'
      ? { ...options, encoderPath: resolve('.missing-mobile-sam-encoder.onnx') }
      : { ...options, opencvPath: resolve('.missing-opencv.js') }
  let assetFaultCode = 'NOT_REJECTED'
  try {
    await createSegmenter(brokenOptions)
  } catch (error) {
    assetFaultCode = error instanceof ClassifierError ? error.code : 'UNEXPECTED'
  }
  return {
    positive,
    negative,
    cancellationCode,
    overloadCapacityRejected: capacityRejected,
    invalidInputCode,
    assetFaultCode,
    disposedTwice: true,
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(
      'Usage: node --import tsx benchmarks/v02/native-smoke.ts --backend=mobile-sam --encoder=/path --decoder=/path [--fixtures=/manifest.json] [--warmup-seconds=600] [--duration-seconds=6540] [--idle-seconds=30] [--sample-ms=5000] [--out=result.json]',
    )
    return
  }
  const options = parseOptions(process.argv.slice(2))
  const samples = [
    syntheticCase(),
    ...(options.fixtureManifest ? await readFixtures(options.fixtureManifest) : []),
  ]
  const lifecycle = await lifecycleChecks(options, samples[0]!)
  const adapter = await createSegmenter(options)
  const warmupStarted = Date.now()
  const warmupUntil = warmupStarted + options.warmupSeconds * 1000
  let warmupCount = 0
  while (Date.now() < warmupUntil) {
    await runOne(adapter, samples[warmupCount % samples.length]!)
    warmupCount++
  }
  const resources = new ResourceRunner(options.sampleMs)
  resources.start()
  const control = new AbortController()
  const onInterrupt = () => control.abort(new ClassifierError('ABORTED', 'Benchmark interrupted'))
  process.once('SIGINT', onInterrupt)
  const records: RunRecord[] = []
  const measurementStarted = Date.now()
  let measuredStarted = measurementStarted
  try {
    await delay(options.idleSeconds * 1000, undefined, { signal: control.signal }).catch(
      () => undefined,
    )
    resources.setPhase('busy')
    measuredStarted = Date.now()
    const until = measuredStarted + options.durationSeconds * 1000
    while (Date.now() < until && !control.signal.aborted) {
      for (const sample of samples) {
        if (Date.now() >= until || control.signal.aborted) break
        records.push(await runOne(adapter, sample!, control.signal))
      }
    }
    resources.setPhase('idle-after')
    await delay(options.idleSeconds * 1000, undefined, { signal: control.signal }).catch(
      () => undefined,
    )
  } finally {
    process.off('SIGINT', onInterrupt)
  }
  await adapter.dispose()
  await adapter.dispose()
  await delay(25)
  const resourceReport = resources.stop()
  const endedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    backend: options.backend,
    startedAt: new Date(measurementStarted).toISOString(),
    busyStartedAt: new Date(measuredStarted).toISOString(),
    endedAt,
    parameters: {
      warmupSeconds: options.warmupSeconds,
      durationSeconds: options.durationSeconds,
      idleSeconds: options.idleSeconds,
      sampleMs: options.sampleMs,
      warmupCount,
      operationCount: records.length,
      forcedGc: false,
    },
    lifecycle,
    results: {
      segmented: records.filter((record) => record.status === 'segmented').length,
      unknown: records.filter((record) => record.status === 'unknown').length,
      failed: records.filter((record) => record.status === 'failed').length,
      durationP50Ms: percentile(
        records.map((record) => record.durationMs),
        0.5,
      ),
      durationP95Ms: percentile(
        records.map((record) => record.durationMs),
        0.95,
      ),
      maskIoUByCase: Object.fromEntries(
        samples
          .filter((sample) => sample.referenceMask)
          .map((sample) => [
            sample.id,
            records
              .filter((record) => record.caseId === sample.id && record.maskIoU !== undefined)
              .map((record) => record.maskIoU),
          ]),
      ),
    },
    fixtures: samples.map((sample) => ({
      id: sample.id,
      ...(sample.provenance ?? { license: 'authored fixture' }),
    })),
    resources: resourceReport,
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (options.outputPath) await writeFile(resolve(options.outputPath), json)
  else process.stdout.write(json)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Native smoke benchmark failed')
    process.exitCode = 1
  })
}
