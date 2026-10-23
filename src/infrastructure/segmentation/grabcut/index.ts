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
import { nativeErrorReplySchema, nativeSegmentationReplySchema } from '../native-protocol.js'
import { verifyPinnedAsset } from '../verify-asset.js'
import { probeBackend } from '../probe-backend.js'
import { grabcutOpenCvArtifact } from './model-asset.js'

const optionsSchema = z.object({ assetPath: z.string().min(1).max(4096) }).strict()
/** @experimental Options for the unqualified GrabCut segmentation factory. */
export type GrabCutSegmenterOptions = z.input<typeof optionsSchema>
interface SerializedTask {
  kind: 'grabcut'
  width: number
  height: number
  rgba: string
  seedRegion: SegmentationInput['seedRegion']
  wholeRegion: SegmentationInput['wholeRegion']
  roi: SegmentationInput['roi']
  prompt: 'whole-region' | 'seed-region'
  assetPath: string
}

/**
 * Explicit pinned OpenCV GrabCut adapter. The supplied native asset is never downloaded.
 * @experimental Native segmentation adapter; unqualified for general mask or object accuracy.
 */
export async function createGrabCutSegmenter(
  options: GrabCutSegmenterOptions,
): Promise<SegmentationPort> {
  const checked = optionsSchema.safeParse(options)
  if (!checked.success) throw new ClassifierError('INVALID_INPUT', 'Invalid GrabCut options')
  const parsed = checked.data
  await verifyPinnedAsset(parsed.assetPath, grabcutOpenCvArtifact, 'OpenCV.js')
  const workerUrl = new URL(
    import.meta.url.endsWith('.ts') ? '../native-worker.ts' : '../native-worker.js',
    import.meta.url,
  )
  await probeBackend(workerUrl, 'grabcut', { assetPath: parsed.assetPath })
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
      assertActive(input.signal)
      let image!: ReturnType<typeof snapshotInput>
      const raw = await pool.runLazy(input.signal, () => {
        image = snapshotInput(input)
        return {
          kind: 'grabcut' as const,
          width: image.width,
          height: image.height,
          rgba: Buffer.from(image.data).toString('base64'),
          seedRegion: image.seedRegion,
          wholeRegion: image.wholeRegion,
          roi: image.roi,
          prompt: image.prompt,
          assetPath: parsed.assetPath,
        }
      })
      const reply = nativeSegmentationReplySchema.parse(raw)
      const mask = Buffer.from(reply.mask, 'base64')
      if (
        reply.width !== image.width ||
        reply.height !== image.height ||
        mask.length !== image.width * image.height ||
        mask.toString('base64') !== reply.mask
      )
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Native child mask dimensions or encoding are invalid',
        )
      return {
        status: 'segmented',
        mask: {
          data: new Uint8Array(mask),
          width: image.width,
          height: image.height,
          format: 'binary-u8',
        },
        metadata: {
          method: reply.method,
          backend: 'grabcut',
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
  const prompt = input.prompt ?? 'whole-region'
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
    (prompt !== 'whole-region' && prompt !== 'seed-region') ||
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
    seedRegion: { ...input.seedRegion },
    wholeRegion: { ...input.wholeRegion },
    roi: { ...input.roi },
    prompt,
  }
}
