import sharp from 'sharp'
import type { InferenceSession } from 'onnxruntime-node'

import type { NativeObjectProposalReply, NativeSegmentationRequest } from '../native-protocol.js'
import { objectProposalLimits } from '../../../entities/object-proposals.js'
import { decoderIdentity, encoderIdentity, verifiedBytes } from './worker-models.js'
import { mobileSamProposalPoints, packMobileSamProposalCandidates } from './proposal-masks.js'

type ProposalRequest = Extract<NativeSegmentationRequest, { kind: 'mobile-sam-proposals' }>

/** One encoder pass followed by a profile-bounded set of positive-point decoder calls. */
export async function runMobileSamObjectProposalTask(
  request: ProposalRequest,
): Promise<NativeObjectProposalReply> {
  const ort = await import('onnxruntime-node')
  if (!ort.listSupportedBackends().some((item) => item.name === 'cpu' && item.bundled))
    throw new Error('Explicitly requested ONNX CPU execution provider is unavailable')
  const sessionOptions: InferenceSession.SessionOptions = {
    executionProviders: ['cpu'],
    intraOpNumThreads: request.options.threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    enableMemPattern: true,
    graphOptimizationLevel: 'all',
  }
  const encoder = await ort.InferenceSession.create(
    await verifiedBytes(request.options.encoderPath, encoderIdentity),
    sessionOptions,
  )
  let decoder: InferenceSession | undefined
  let embeddingTensor: InstanceType<typeof ort.Tensor> | undefined
  let reply: NativeObjectProposalReply | undefined
  let releaseFailed = false
  try {
    decoder = await ort.InferenceSession.create(
      await verifiedBytes(request.options.decoderPath, decoderIdentity),
      sessionOptions,
    )
    const rgba = Buffer.from(request.rgba, 'base64')
    const pixels = request.width * request.height
    if (rgba.length !== pixels * 4 || pixels > 2_097_152)
      throw new Error('Invalid or oversized RGBA proposal input')
    const scale = 1024 / Math.max(request.width, request.height)
    const resizedWidth = Math.round(request.width * scale)
    const resizedHeight = Math.round(request.height * scale)
    const pipeline = sharp(rgba, {
      raw: { width: request.width, height: request.height, channels: 4 },
    })
    let rgb: Buffer
    try {
      rgb = await pipeline
        .removeAlpha()
        .resize(resizedWidth, resizedHeight, { fit: 'fill', kernel: 'linear' })
        .raw()
        .toBuffer()
    } finally {
      pipeline.destroy()
    }
    if (rgb.length !== resizedWidth * resizedHeight * 3)
      throw new Error('Invalid resized RGB proposal input')
    const imageTensor = new ort.Tensor('float32', Float32Array.from(rgb), [
      resizedHeight,
      resizedWidth,
      3,
    ])
    try {
      const encoded = await encoder.run({ input_image: imageTensor })
      const embedding = encoded.image_embeddings
      if (embedding instanceof ort.Tensor) embeddingTensor = embedding
      if (
        !(embedding instanceof ort.Tensor) ||
        embedding.type !== 'float32' ||
        JSON.stringify(embedding.dims) !== JSON.stringify([1, 256, 64, 64]) ||
        !(embedding.data instanceof Float32Array)
      )
        throw new Error('Unexpected MobileSAM encoder output')
      const xScale = resizedWidth / request.width
      const yScale = resizedHeight / request.height
      const proposals: NativeObjectProposalReply['proposals'] = []
      let packedBytes = 0
      const points = mobileSamProposalPoints(request.seedRegion, request.sampling)
      for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
        const point = points[pointIndex]
        if (!point) throw new Error('Missing MobileSAM proposal point')
        let coordinates: InstanceType<typeof ort.Tensor> | undefined
        let labels: InstanceType<typeof ort.Tensor> | undefined
        let maskInput: InstanceType<typeof ort.Tensor> | undefined
        let hasMaskInput: InstanceType<typeof ort.Tensor> | undefined
        let originalSize: InstanceType<typeof ort.Tensor> | undefined
        let decoded: Awaited<ReturnType<InferenceSession['run']>> | undefined
        try {
          coordinates = new ort.Tensor(
            'float32',
            Float32Array.of(point.x * xScale, point.y * yScale, point.x * xScale, point.y * yScale),
            [1, 2, 2],
          )
          labels = new ort.Tensor('float32', Float32Array.of(1, -1), [1, 2])
          maskInput = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256])
          hasMaskInput = new ort.Tensor('float32', Float32Array.of(0), [1])
          originalSize = new ort.Tensor('float32', Float32Array.of(request.height, request.width), [
            2,
          ])
          decoded = await decoder.run({
            image_embeddings: embedding,
            point_coords: coordinates,
            point_labels: labels,
            mask_input: maskInput,
            has_mask_input: hasMaskInput,
            orig_im_size: originalSize,
          })
          const masks = decoded.masks
          const scores = decoded.iou_predictions
          if (
            !(masks instanceof ort.Tensor) ||
            masks.type !== 'float32' ||
            JSON.stringify(masks.dims) !== JSON.stringify([1, 4, request.height, request.width]) ||
            !(masks.data instanceof Float32Array) ||
            !(scores instanceof ort.Tensor) ||
            scores.type !== 'float32' ||
            JSON.stringify(scores.dims) !== JSON.stringify([1, 4]) ||
            !(scores.data instanceof Float32Array) ||
            !scores.data.every(Number.isFinite)
          )
            throw new Error('Unexpected MobileSAM proposal decoder output')
          const candidates = packMobileSamProposalCandidates({
            width: request.width,
            height: request.height,
            rgba,
            roi: request.roi,
            pointIndex,
            logits: masks.data,
            scores: scores.data,
          })
          for (const candidate of candidates) {
            packedBytes += Buffer.from(candidate.mask, 'base64').byteLength
            if (packedBytes > objectProposalLimits.packedBytes)
              throw new Error('Packed MobileSAM proposals exceed the aggregate byte limit')
            proposals.push(candidate)
          }
        } finally {
          coordinates?.dispose()
          labels?.dispose()
          maskInput?.dispose()
          hasMaskInput?.dispose()
          originalSize?.dispose()
          if (decoded)
            for (const tensor of Object.values(decoded))
              if (tensor instanceof ort.Tensor) tensor.dispose()
        }
      }
      reply = {
        id: request.id,
        status: 'proposals',
        width: request.width,
        height: request.height,
        proposals,
      }
    } finally {
      embeddingTensor?.dispose()
      imageTensor.dispose()
    }
  } finally {
    const releases = await Promise.allSettled([
      encoder.release(),
      ...(decoder ? [decoder.release()] : []),
    ])
    releaseFailed = releases.some((release) => release.status === 'rejected')
  }
  if (releaseFailed) throw new Error('MobileSAM proposal session release failed')
  if (!reply) throw new Error('MobileSAM completed without proposals')
  return reply
}
