import { performance } from 'node:perf_hooks'
import { ClassifierError, assertActive } from '../../../entities/errors.js'
import { z } from 'zod'

import type {
  BinaryMask,
  SegmentationInput,
  SegmentationPort,
  SegmentationResult,
} from '../../../entities/segmentation.js'
import type {
  ObjectProposalBatch,
  ObjectProposalInput,
  ObjectProposalPort,
} from '../../../entities/object-proposals.js'
import { objectProposalLimits } from '../../../entities/object-proposals.js'
import { limits, pixelRectSchema } from '../../../entities/contracts.js'
import { NativeChildPool } from '../native-child.js'
import { verifyPinnedAsset } from '../verify-asset.js'
import { probeBackend } from '../probe-backend.js'
import {
  nativeErrorReplySchema,
  nativeMobileSamExpansionReplySchema,
  nativeObjectProposalReplySchema,
  nativeSegmentationReplySchema,
  type NativeSegmentationRequest,
} from '../native-protocol.js'
import {
  packFullSourceBinaryMask,
  unpackFullSourceBinaryMask,
  validateMobileSamPreviousMask,
} from './worker-inference.js'

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

const proposalOptionsSchema = z
  .object({
    encoderPath: z.string().min(1).max(4096),
    decoderPath: z.string().min(1).max(4096),
    executionProvider: z.literal('cpu').default('cpu'),
    threads: z.number().int().min(1).max(8).default(2),
  })
  .strict()
export type MobileSamObjectProposalsOptions = z.input<typeof proposalOptionsSchema>

type SerializedTask =
  | (Omit<Extract<NativeSegmentationRequest, { kind: 'mobile-sam' }>, 'id' | 'rgba'> & {
      rgba: string
    })
  | (Omit<Extract<NativeSegmentationRequest, { kind: 'mobile-sam-expand' }>, 'id' | 'rgba'> & {
      rgba: string
    })

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
  return {
    async segment(input): Promise<SegmentationResult> {
      const started = performance.now()
      assertActive(input.signal)
      let image!: ReturnType<typeof snapshotInput>
      const raw = await pool.runLazy(input.signal, () => {
        image = snapshotInput(input)
        return {
          kind: 'mobile-sam',
          width: image.width,
          height: image.height,
          rgba: Buffer.from(image.data).toString('base64'),
          seedRegion: image.seedRegion,
          wholeRegion: image.wholeRegion,
          roi: image.roi,
          prompt: image.prompt,
          options: parsed,
        }
      })
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
    async expand(input, previousMask): Promise<SegmentationResult> {
      const started = performance.now()
      assertActive(input.signal)
      let image: ReturnType<typeof snapshotInput> | undefined
      let previous: Uint8Array | undefined
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
      }
    },
    settle: () => pool.settle(),
    dispose: () => pool.dispose(),
  }
}

/** Explicit CPU-only, caller-owned one-shot 3x3-point / 36-mask proposal adapter. */
export async function createMobileSamObjectProposals(
  options: MobileSamObjectProposalsOptions,
): Promise<ObjectProposalPort> {
  const checked = proposalOptionsSchema.safeParse(options)
  if (!checked.success)
    throw new ClassifierError('INVALID_INPUT', 'Invalid MobileSAM proposal options')
  const parsed = checked.data
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
  // Probe the explicitly requested CPU provider in an owned child, disposing it before return.
  await probeBackend(workerUrl, 'mobile-sam', { options: { ...parsed, executionProvider: 'cpu' } })
  const pool = new NativeChildPool<SerializedProposalTask>({
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
      const reply = nativeObjectProposalReplySchema.safeParse(raw)
      if (!reply.success || reply.data.id !== id)
        throw new ClassifierError('INVALID_RESPONSE', 'Native child returned invalid proposals')
      return reply.data
    },
  })
  return {
    async propose(input: ObjectProposalInput): Promise<ObjectProposalBatch> {
      const started = performance.now()
      assertActive(input.signal)
      let image!: ReturnType<typeof snapshotProposalInput>['image']
      const raw = await pool.runLazy(input.signal, () => {
        const snapshot = snapshotProposalInput(input)
        image = snapshot.image
        return {
          kind: 'mobile-sam-proposals',
          width: image.width,
          height: image.height,
          rgba: Buffer.from(image.data).toString('base64'),
          seedRegion: snapshot.seedRegion,
          roi: snapshot.roi,
          options: { ...parsed, executionProvider: 'cpu' as const },
        }
      })
      const reply = nativeObjectProposalReplySchema.parse(raw)
      if (reply.width !== image.width || reply.height !== image.height)
        throw new ClassifierError('INVALID_RESPONSE', 'Proposal dimensions do not match the input')
      const expectedBytes = Math.ceil((image.width * image.height) / 8)
      let aggregateBytes = 0
      const proposals = reply.proposals.map((proposal, index) => {
        const expectedId = `C${String(index).padStart(2, '0')}`
        const bytes = Buffer.from(proposal.mask, 'base64')
        aggregateBytes += bytes.byteLength
        if (
          proposal.id !== expectedId ||
          bytes.byteLength !== expectedBytes ||
          bytes.toString('base64') !== proposal.mask ||
          aggregateBytes > objectProposalLimits.packedBytes
        )
          throw new ClassifierError('INVALID_RESPONSE', 'Proposal masks are malformed or oversized')
        const unusedBits = expectedBytes * 8 - image.width * image.height
        const allowed = unusedBits ? (1 << (8 - unusedBits)) - 1 : 255
        if ((bytes[expectedBytes - 1]! & ~allowed) !== 0)
          throw new ClassifierError('INVALID_RESPONSE', 'Proposal mask has nonzero padding bits')
        return {
          id: proposal.id,
          mask: {
            data: new Uint8Array(bytes),
            width: image.width,
            height: image.height,
            format: 'binary-lsb0' as const,
          },
          qualityScore: proposal.qualityScore,
        }
      })
      return {
        proposals,
        metadata: {
          method: 'mobile-sam-nine-point-proposals-v1',
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
  const prompt = input.prompt ?? 'whole-region'
  if (
    image.format !== 'rgba8' ||
    !(image.data instanceof Uint8Array) ||
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

function snapshotPreviousMask(
  input: SegmentationInput,
  previousMask: BinaryMask,
  image: ReturnType<typeof snapshotInput>,
) {
  if (
    !previousMask ||
    previousMask.format !== 'binary-u8' ||
    !(previousMask.data instanceof Uint8Array) ||
    previousMask.width !== image.width ||
    previousMask.height !== image.height ||
    previousMask.data.length !== image.width * image.height
  )
    throw new ClassifierError('INVALID_INPUT', 'Expansion requires a full-source binary mask')
  try {
    validateMobileSamPreviousMask({
      width: image.width,
      height: image.height,
      rgba: image.data,
      previousMask: previousMask.data,
      roi: image.roi,
    })
  } catch {
    throw new ClassifierError(
      'INVALID_INPUT',
      'Expansion mask must be nonempty binary foreground inside visible ROI pixels',
    )
  }
  return new Uint8Array(previousMask.data)
}

interface SerializedProposalTask
  extends Omit<
    Extract<NativeSegmentationRequest, { kind: 'mobile-sam-proposals' }>,
    'id' | 'rgba'
  > {
  rgba: string
}

function snapshotProposalInput(input: ObjectProposalInput) {
  const { image } = input
  const pixels = image.width * image.height
  if (pixels > objectProposalLimits.imagePixels)
    throw new ClassifierError('RESOURCE_LIMIT', 'Proposal image exceeds the two-megapixel limit')
  if (
    image.format !== 'rgba8' ||
    !(image.data instanceof Uint8Array) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    !Number.isSafeInteger(pixels) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.length !== pixels * 4
  )
    throw new ClassifierError('INVALID_INPUT', 'Proposals require canonical RGBA8 pixels')
  for (const region of [input.seedRegion, input.roi])
    if (
      !pixelRectSchema.safeParse(region).success ||
      region.left + region.width > image.width ||
      region.top + region.height > image.height
    )
      throw new ClassifierError('INVALID_INPUT', 'Proposal region lies outside the source image')
  return {
    image: { data: new Uint8Array(image.data), width: image.width, height: image.height },
    seedRegion: { ...input.seedRegion },
    roi: { ...input.roi },
  }
}
