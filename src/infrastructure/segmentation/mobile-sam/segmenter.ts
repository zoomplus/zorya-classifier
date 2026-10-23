import { performance } from 'node:perf_hooks'
import { ClassifierError, assertActive } from '../../../entities/errors.js'
import type { z } from 'zod'

import type { SegmentationPort, SegmentationResult } from '../../../entities/segmentation.js'
import { NativeChildPool } from '../native-child.js'
import { verifyPinnedAsset } from '../verify-asset.js'
import { probeBackend } from '../probe-backend.js'
import {
  nativeErrorReplySchema,
  nativeMobileSamExpansionReplySchema,
  nativeSegmentationReplySchema,
  type NativeSegmentationRequest,
} from '../native-protocol.js'
import { decoderIdentity, encoderIdentity } from './model-assets.js'
import { optionsSchema, type MobileSamSegmenterOptions } from './options.js'
import { snapshotInput, snapshotPreviousMask } from './input.js'
import {
  packFullSourceBinaryMask,
  unpackFullSourceBinaryMask,
  validateMobileSamPreviousMask,
} from './segmentation-masks.js'

type SerializedTask =
  | (Omit<Extract<NativeSegmentationRequest, { kind: 'mobile-sam' }>, 'id' | 'rgba'> & {
      rgba: string
    })
  | (Omit<Extract<NativeSegmentationRequest, { kind: 'mobile-sam-expand' }>, 'id' | 'rgba'> & {
      rgba: string
    })

/**
 * Explicit pinned MobileSAM inference in a separately owned Node child process.
 * @experimental Native segmentation adapter; unqualified for general mask or object accuracy.
 */
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
  await verifyPinnedAsset(parsed.encoderPath, encoderIdentity, 'MobileSAM encoder')
  await verifyPinnedAsset(parsed.decoderPath, decoderIdentity, 'MobileSAM decoder')
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
      if (reply.success && reply.data.id === id) return reply.data
      const expansion = nativeMobileSamExpansionReplySchema.safeParse(raw)
      if (!expansion.success || expansion.data.id !== id)
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Native child returned an invalid or mismatched reply',
        )
      return expansion.data
    },
  })
  return createMobileSamPortForPool(pool, parsed)
}

/** Internal adapter seam: pool ownership stays with the caller. */
export function createMobileSamPortForPool(
  pool: Pick<NativeChildPool<SerializedTask>, 'runLazy' | 'settle' | 'dispose'>,
  parsed: z.output<typeof optionsSchema>,
): SegmentationPort & Required<Pick<SegmentationPort, 'expand'>> {
  return {
    async segment(input): Promise<SegmentationResult> {
      const started = performance.now()
      assertActive(input.signal)
      let image: ReturnType<typeof snapshotInput> | undefined
      let maskData: Buffer | undefined
      try {
        const raw = await pool.runLazy(input.signal, () => {
          image = snapshotInput(input)
          const rgba = Buffer.from(image.data)
          let rgbaBase64: string
          try {
            rgbaBase64 = rgba.toString('base64')
          } finally {
            rgba.fill(0)
          }
          return {
            kind: 'mobile-sam',
            width: image.width,
            height: image.height,
            rgba: rgbaBase64,
            seedRegion: image.seedRegion,
            wholeRegion: image.wholeRegion,
            roi: image.roi,
            prompt: image.prompt,
            options: parsed,
          }
        })
        if (!image)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Native segmentation omitted its input snapshot',
          )
        const checkedReply = nativeSegmentationReplySchema.safeParse(raw)
        if (
          !checkedReply.success ||
          checkedReply.data.width !== image.width ||
          checkedReply.data.height !== image.height
        )
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Native child returned an invalid segmentation reply',
          )
        maskData = Buffer.from(checkedReply.data.mask, 'base64')
        if (
          maskData.length !== image.width * image.height ||
          maskData.toString('base64') !== checkedReply.data.mask
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
            method: checkedReply.data.method,
            backend: 'mobile-sam',
            durationMs: Math.max(0, performance.now() - started),
            input: { width: image.width, height: image.height },
          },
        }
      } finally {
        maskData?.fill(0)
        image?.data.fill(0)
      }
    },
    async expand(input, previousMask): Promise<SegmentationResult> {
      const started = performance.now()
      assertActive(input.signal)
      let image: ReturnType<typeof snapshotInput> | undefined
      let previous: Uint8Array | undefined
      let resultData: Uint8Array | undefined
      let transferred = false
      try {
        const raw = await pool.runLazy(input.signal, () => {
          image = snapshotInput(input)
          previous = snapshotPreviousMask(input, previousMask, image)
          const packedPrevious = packFullSourceBinaryMask(previous, image.width, image.height)
          let previousMaskBase64: string
          try {
            const packedBuffer = Buffer.from(packedPrevious)
            try {
              previousMaskBase64 = packedBuffer.toString('base64')
            } finally {
              packedBuffer.fill(0)
            }
          } finally {
            packedPrevious.fill(0)
          }
          const rgbaBuffer = Buffer.from(image.data)
          let rgbaBase64: string
          try {
            rgbaBase64 = rgbaBuffer.toString('base64')
          } finally {
            rgbaBuffer.fill(0)
          }
          return {
            kind: 'mobile-sam-expand',
            width: image.width,
            height: image.height,
            rgba: rgbaBase64,
            previousMask: previousMaskBase64,
            seedRegion: image.seedRegion,
            wholeRegion: image.wholeRegion,
            roi: image.roi,
            prompt: image.prompt,
            options: parsed,
          }
        })
        if (!image || !previous)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Native expansion omitted its input snapshot',
          )
        const checkedReply = nativeMobileSamExpansionReplySchema.safeParse(raw)
        if (
          !checkedReply.success ||
          checkedReply.data.width !== image.width ||
          checkedReply.data.height !== image.height
        )
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Native child returned an invalid expansion reply',
          )
        if (checkedReply.data.status === 'unknown')
          return {
            status: 'unknown',
            reason: 'no-enclosing-mask',
            metadata: {
              method: checkedReply.data.method,
              backend: 'mobile-sam',
              durationMs: Math.max(0, performance.now() - started),
              input: { width: image.width, height: image.height },
            },
          }
        const packedBytes = Buffer.from(checkedReply.data.mask, 'base64')
        let data: Uint8Array
        try {
          if (packedBytes.toString('base64') !== checkedReply.data.mask)
            throw new ClassifierError(
              'INVALID_RESPONSE',
              'Native expansion mask encoding is invalid',
            )
          try {
            data = unpackFullSourceBinaryMask(packedBytes, image.width, image.height)
            resultData = data
          } catch {
            throw new ClassifierError('INVALID_RESPONSE', 'Native expansion packed mask is invalid')
          }
        } finally {
          packedBytes.fill(0)
        }
        let oldStats: ReturnType<typeof validateMobileSamPreviousMask>
        let newStats: ReturnType<typeof validateMobileSamPreviousMask>
        try {
          oldStats = validateMobileSamPreviousMask({
            width: image.width,
            height: image.height,
            rgba: image.data,
            previousMask: previous,
            roi: image.roi,
          })
          newStats = validateMobileSamPreviousMask({
            width: image.width,
            height: image.height,
            rgba: image.data,
            previousMask: data,
            roi: image.roi,
          })
        } catch {
          data.fill(0)
          throw new ClassifierError('INVALID_RESPONSE', 'Native expanded mask is invalid')
        }
        let hasNewForeground = false
        for (let index = 0; index < data.length; index++) {
          if (previous[index] === 1 && data[index] !== 1) {
            data.fill(0)
            throw new ClassifierError('INVALID_RESPONSE', 'Native expansion lost prior foreground')
          }
          if (data[index] === 1 && previous[index] === 0) hasNewForeground = true
        }
        if (
          !hasNewForeground ||
          newStats.area <= oldStats.area ||
          newStats.bounds.left > oldStats.bounds.left ||
          newStats.bounds.top > oldStats.bounds.top ||
          newStats.bounds.right < oldStats.bounds.right ||
          newStats.bounds.bottom < oldStats.bounds.bottom ||
          (newStats.bounds.left === oldStats.bounds.left &&
            newStats.bounds.top === oldStats.bounds.top &&
            newStats.bounds.right === oldStats.bounds.right &&
            newStats.bounds.bottom === oldStats.bounds.bottom)
        ) {
          data.fill(0)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Native expansion is not a strict enclosing mask',
          )
        }
        transferred = true
        return {
          status: 'segmented',
          mask: { data, width: image.width, height: image.height, format: 'binary-u8' },
          metadata: {
            method: checkedReply.data.method,
            backend: 'mobile-sam',
            durationMs: Math.max(0, performance.now() - started),
            input: { width: image.width, height: image.height },
            qualityScore: checkedReply.data.qualityScore,
          },
        }
      } finally {
        image?.data.fill(0)
        previous?.fill(0)
        if (resultData && !transferred) resultData.fill(0)
      }
    },
    settle: () => pool.settle(),
    dispose: () => pool.dispose(),
  }
}
