import { performance } from 'node:perf_hooks'
import { ClassifierError, assertActive } from '../../../entities/errors.js'

import type {
  ObjectProposalBatch,
  ObjectProposalInput,
  ObjectProposalPort,
} from '../../../entities/object-proposals.js'
import { objectProposalLimits } from '../../../entities/object-proposals.js'
import { NativeChildPool } from '../native-child.js'
import { verifyPinnedAsset } from '../verify-asset.js'
import { probeBackend } from '../probe-backend.js'
import {
  nativeErrorReplySchema,
  nativeObjectProposalReplySchema,
  type NativeSegmentationRequest,
} from '../native-protocol.js'
import { decoderIdentity, encoderIdentity } from './model-assets.js'
import { proposalOptionsSchema, type MobileSamObjectProposalsOptions } from './options.js'
import { snapshotProposalInput } from './input.js'

interface SerializedProposalTask
  extends Omit<
    Extract<NativeSegmentationRequest, { kind: 'mobile-sam-proposals' }>,
    'id' | 'rgba'
  > {
  rgba: string
}

/**
 * Explicit CPU-only proposals: historical 3x3/36 default or opt-in seed-center/four.
 * @experimental Native proposal adapter; unqualified for general spatial or mask accuracy.
 */
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
  await verifyPinnedAsset(parsed.encoderPath, encoderIdentity, 'MobileSAM encoder')
  await verifyPinnedAsset(parsed.decoderPath, decoderIdentity, 'MobileSAM decoder')
  const sourceWorker = import.meta.url.endsWith('.ts')
  const workerUrl = new URL(
    sourceWorker ? '../native-worker.ts' : '../native-worker.js',
    import.meta.url,
  )
  // Probe the explicitly requested CPU provider in an owned child, disposing it before return.
  const modelOptions = {
    encoderPath: parsed.encoderPath,
    decoderPath: parsed.decoderPath,
    executionProvider: 'cpu' as const,
    threads: parsed.threads,
  }
  await probeBackend(workerUrl, 'mobile-sam', { options: modelOptions })
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
          sampling: parsed.sampling,
          options: modelOptions,
        }
      })
      const reply = nativeObjectProposalReplySchema.parse(raw)
      const expectedCount = parsed.sampling === 'seed-center' ? 4 : 36
      if (
        reply.width !== image.width ||
        reply.height !== image.height ||
        reply.proposals.length !== expectedCount
      )
        throw new ClassifierError(
          'INVALID_RESPONSE',
          'Proposal dimensions or candidate count do not match the request',
        )
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
          method:
            parsed.sampling === 'seed-center'
              ? 'mobile-sam-seed-center-proposals-v1'
              : 'mobile-sam-nine-point-proposals-v1',
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
