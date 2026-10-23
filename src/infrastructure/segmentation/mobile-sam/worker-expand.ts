import sharp from 'sharp'
import type { InferenceSession } from 'onnxruntime-node'

import type {
  NativeMobileSamExpansionReply,
  NativeSegmentationRequest,
} from '../native-protocol.js'
import {
  buildMobileSamSessionOptions,
  decoderIdentity,
  encoderIdentity,
  verifiedBytes,
} from './worker-models.js'
import {
  mobileSamSegmentationPrompt,
  packFullSourceBinaryMask,
  selectEnclosingMobileSamCandidate,
  unpackFullSourceBinaryMask,
  validateMobileSamPreviousMask,
} from './segmentation-masks.js'

type ExpansionRequest = Extract<NativeSegmentationRequest, { kind: 'mobile-sam-expand' }>

/** Run one same-seed decode and return only the smallest strict enclosing mask. */
export async function runMobileSamExpandTask(
  request: ExpansionRequest,
): Promise<NativeMobileSamExpansionReply> {
  const ort = await import('onnxruntime-node')
  if (
    !ort
      .listSupportedBackends()
      .some((item) => item.name === request.options.executionProvider && item.bundled)
  )
    throw new Error('Explicitly requested ONNX execution provider is unavailable')
  const sessionOptions = buildMobileSamSessionOptions(request.options)
  const encoder = await ort.InferenceSession.create(
    await verifiedBytes(request.options.encoderPath, encoderIdentity),
    sessionOptions,
  )
  let decoder: InferenceSession | undefined
  let imageTensor: InstanceType<typeof ort.Tensor> | undefined
  let embedding: InstanceType<typeof ort.Tensor> | undefined
  let result: NativeMobileSamExpansionReply | undefined
  let releaseFailed = false
  let rgba: Buffer | undefined
  let packedPrevious: Buffer | undefined
  let previousMask: Uint8Array | undefined
  let selectedMask: Uint8Array | undefined
  try {
    decoder = await ort.InferenceSession.create(
      await verifiedBytes(request.options.decoderPath, decoderIdentity),
      sessionOptions,
    )
    rgba = Buffer.from(request.rgba, 'base64')
    packedPrevious = Buffer.from(request.previousMask, 'base64')
    if (rgba.length !== request.width * request.height * 4)
      throw new Error('Invalid expansion RGBA input size')
    previousMask = unpackFullSourceBinaryMask(packedPrevious, request.width, request.height)
    validateMobileSamPreviousMask({
      width: request.width,
      height: request.height,
      rgba,
      previousMask,
      roi: request.roi,
    })
    const scale = 1024 / Math.max(request.width, request.height)
    const resizedWidth = Math.round(request.width * scale)
    const resizedHeight = Math.round(request.height * scale)
    if (resizedWidth < 1 || resizedHeight < 1) throw new Error('Unrepresentable image aspect ratio')
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
    if (rgb.length !== resizedWidth * resizedHeight * 3) throw new Error('Invalid resized RGB data')
    imageTensor = new ort.Tensor('float32', Float32Array.from(rgb), [
      resizedHeight,
      resizedWidth,
      3,
    ])
    rgb.fill(0)
    const encoded = await encoder.run({ input_image: imageTensor })
    const embeddingTensor = encoded.image_embeddings
    if (
      !(embeddingTensor instanceof ort.Tensor) ||
      embeddingTensor.type !== 'float32' ||
      JSON.stringify(embeddingTensor.dims) !== JSON.stringify([1, 256, 64, 64]) ||
      !(embeddingTensor.data instanceof Float32Array)
    )
      throw new Error('Unexpected MobileSAM encoder output')
    embedding = embeddingTensor
    const prompt = mobileSamSegmentationPrompt({
      prompt: request.prompt,
      seedRegion: request.seedRegion,
      wholeRegion: request.wholeRegion,
      xScale: resizedWidth / request.width,
      yScale: resizedHeight / request.height,
    })
    const pointCoords = new ort.Tensor('float32', prompt.coordinates, [1, 2, 2])
    const pointLabels = new ort.Tensor('float32', prompt.labels, [1, 2])
    const maskInput = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256])
    const hasMaskInput = new ort.Tensor('float32', Float32Array.of(0), [1])
    const originalSize = new ort.Tensor('float32', Float32Array.of(request.height, request.width), [
      2,
    ])
    let decoded: Awaited<ReturnType<InferenceSession['run']>> | undefined
    try {
      decoded = await decoder.run({
        image_embeddings: embedding,
        point_coords: pointCoords,
        point_labels: pointLabels,
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
        !(scores.data instanceof Float32Array)
      )
        throw new Error('Unexpected MobileSAM expansion decoder output')
      const candidate = selectEnclosingMobileSamCandidate({
        width: request.width,
        height: request.height,
        rgba,
        logits: masks.data,
        scores: scores.data,
        previousMask,
        roi: request.roi,
      })
      if (candidate) {
        selectedMask = candidate.mask
        const packed = packFullSourceBinaryMask(selectedMask, request.width, request.height)
        const packedBuffer = Buffer.from(packed)
        try {
          result = {
            id: request.id,
            status: 'expanded',
            width: request.width,
            height: request.height,
            mask: packedBuffer.toString('base64'),
            method: 'mobile-sam-enclosing-mask-v1',
            qualityScore: candidate.score,
          }
        } finally {
          packedBuffer.fill(0)
          packed.fill(0)
        }
      } else {
        result = {
          id: request.id,
          status: 'unknown',
          reason: 'no-enclosing-mask',
          width: request.width,
          height: request.height,
          method: 'mobile-sam-enclosing-mask-v1',
        }
      }
    } finally {
      prompt.coordinates.fill(0)
      prompt.labels.fill(0)
      for (const tensor of [pointCoords, pointLabels, maskInput, hasMaskInput, originalSize])
        if (tensor.data instanceof Float32Array) tensor.data.fill(0)
      pointCoords.dispose()
      pointLabels.dispose()
      maskInput.dispose()
      hasMaskInput.dispose()
      originalSize.dispose()
      if (decoded)
        for (const tensor of Object.values(decoded))
          if (tensor instanceof ort.Tensor) {
            if (tensor.data instanceof Float32Array || tensor.data instanceof Uint8Array)
              tensor.data.fill(0)
            tensor.dispose()
          }
    }
  } finally {
    imageTensor?.dispose()
    if (embedding && embedding !== imageTensor) {
      if (embedding.data instanceof Float32Array) embedding.data.fill(0)
      embedding.dispose()
    }
    previousMask?.fill(0)
    selectedMask?.fill(0)
    rgba?.fill(0)
    packedPrevious?.fill(0)
    const releases = await Promise.allSettled([
      encoder.release(),
      ...(decoder ? [decoder.release()] : []),
    ])
    releaseFailed = releases.some((release) => release.status === 'rejected')
  }
  if (releaseFailed) throw new Error('MobileSAM expansion session release failed')
  if (!result) throw new Error('MobileSAM completed without an expansion result')
  return result
}
