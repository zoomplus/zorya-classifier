import { performance } from 'node:perf_hooks'
import { ClassifierError, assertActive } from '../../../entities/errors.js'
import { z } from 'zod'

import type {
  SegmentationInput,
  SegmentationPort,
  SegmentationResult,
} from '../../../entities/segmentation.js'
import { limits, pixelRectSchema } from '../../../entities/contracts.js'
import { NativeChildPool } from '../native-child.js'
import { verifyPinnedAsset } from '../verify-asset.js'
import { probeBackend } from '../probe-backend.js'
import {
  nativeErrorReplySchema,
  nativeSegmentationReplySchema,
  type NativeSegmentationRequest,
} from '../native-protocol.js'

const optionsSchema = z
  .object({
    encoderPath: z.string().min(1).max(4096),
    decoderPath: z.string().min(1).max(4096),
    executionProvider: z.enum(['cpu', 'dml']).default('cpu'),
    deviceId: z.number().int().min(0).max(32).optional(),
    threads: z.number().int().min(1).max(8).default(2),
  })
  .strict()
export type MobileSamSegmenterOptions = z.input<typeof optionsSchema>

interface SerializedTask
  extends Omit<Extract<NativeSegmentationRequest, { kind: 'mobile-sam' }>, 'id' | 'rgba'> {
  rgba: string
}

/** Explicit pinned MobileSAM inference in a separately owned Node child process. */
export async function createMobileSamSegmenter(
  options: MobileSamSegmenterOptions,
): Promise<SegmentationPort> {
  const checked = optionsSchema.safeParse(options)
  if (!checked.success) throw new ClassifierError('INVALID_INPUT', 'Invalid MobileSAM options')
  const parsed = checked.data
  if (parsed.executionProvider === 'dml' && process.platform !== 'win32')
    throw new ClassifierError('UNSUPPORTED', 'DirectML is supported only on Windows')
  try {
    import.meta.resolve('onnxruntime-node')
  } catch {
    throw new ClassifierError('UNSUPPORTED', 'onnxruntime-node is not installed')
  }
  await verifyPinnedAsset(
    parsed.encoderPath,
    {
      bytes: 28_157_093,
      sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
    },
    'MobileSAM encoder',
  )
  await verifyPinnedAsset(
    parsed.decoderPath,
    {
      bytes: 16_496_559,
      sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
    },
    'MobileSAM decoder',
  )
  const sourceWorker = import.meta.url.endsWith('.ts')
  const workerUrl = new URL(
    sourceWorker ? '../native-worker.ts' : '../native-worker.js',
    import.meta.url,
  )
  await probeBackend(workerUrl, 'mobile-sam', { options: parsed })
  const pool = new NativeChildPool<SerializedTask>({
    workerUrl,
    maxActive: 1,
    maxWaiting: 2,
    jobTimeoutMs: 10_000,
    abortGraceMs: 250,
    encode: (job) => Buffer.from(JSON.stringify({ id: job.id, ...job.payload })),
    decode: (raw, id) => {
      const error = nativeErrorReplySchema.safeParse(raw)
      if (error.success) {
        if (error.data.id !== id)
          throw new ClassifierError('INVALID_RESPONSE', 'Native child error ID mismatch')
        throw new ClassifierError(error.data.code, error.data.message)
      }
      const reply = nativeSegmentationReplySchema.safeParse(raw)
      if (!reply.success || reply.data.id !== id)
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Native child returned an invalid or mismatched reply',
        )
      return reply.data
    },
  })
  return {
    async segment(input): Promise<SegmentationResult> {
      const started = performance.now()
      const image = snapshotInput(input)
      assertActive(input.signal)
      const raw = await pool.run(
        {
          kind: 'mobile-sam',
          width: image.width,
          height: image.height,
          rgba: Buffer.from(image.data).toString('base64'),
          seedRegion: { ...input.seedRegion },
          wholeRegion: { ...input.wholeRegion },
          roi: { ...input.roi },
          options: parsed,
        },
        input.signal,
      )
      const reply = nativeSegmentationReplySchema.parse(raw)
      const maskData = Buffer.from(reply.mask, 'base64')
      if (
        reply.width !== image.width ||
        reply.height !== image.height ||
        maskData.length !== image.width * image.height ||
        maskData.toString('base64') !== reply.mask
      )
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Native child mask dimensions or encoding are invalid',
        )
      return {
        status: 'segmented',
        mask: {
          data: new Uint8Array(maskData),
          width: image.width,
          height: image.height,
          format: 'binary-u8',
        },
        metadata: {
          method: reply.method,
          backend: 'mobile-sam',
          durationMs: Math.max(0, performance.now() - started),
          input: { width: image.width, height: image.height },
        },
      }
    },
    settle: () => pool.settle(),
    dispose: () => pool.dispose(),
  }
}

function snapshotInput(input: SegmentationInput) {
  const image = input.image
  const pixels = image.width * image.height
  if (
    image.format !== 'rgba8' ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    !Number.isSafeInteger(pixels) ||
    image.width < 1 ||
    image.height < 1 ||
    pixels > limits.imagePixels ||
    image.data.length !== pixels * 4
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Segmentation requires canonical RGBA8 within the image pixel limit',
    )
  if (
    !pixelRectSchema.safeParse(input.seedRegion).success ||
    !pixelRectSchema.safeParse(input.wholeRegion).success ||
    !pixelRectSchema.safeParse(input.roi).success
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Segmentation regions must be positive integer rectangles',
    )
  for (const region of [input.seedRegion, input.wholeRegion, input.roi])
    if (region.left + region.width > image.width || region.top + region.height > image.height)
      throw new ClassifierError(
        'INVALID_INPUT',
        'Segmentation region lies outside the source image',
      )
  return {
    data: new Uint8Array(image.data),
    width: image.width,
    height: image.height,
  }
}
