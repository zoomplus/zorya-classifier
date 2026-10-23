import sharp from 'sharp'
import type { InferenceSession } from 'onnxruntime-node'

import type { NativeSegmentationReply, NativeSegmentationRequest } from '../native-protocol.js'
import {
  buildMobileSamSessionOptions,
  decoderIdentity,
  encoderIdentity,
  verifiedBytes,
} from './worker-models.js'
import {
  collectMobileSamSegmentationCandidates,
  mobileSamSegmentationPrompt,
  selectMobileSamSegmentationMask,
} from './segmentation-masks.js'

export async function runMobileSamTask(
  request: Extract<NativeSegmentationRequest, { kind: 'mobile-sam' }>,
): Promise<NativeSegmentationReply> {
  // Deliberately loaded inside the owned child. Core/entry imports never initialize ONNX Runtime.
  const ort = await import('onnxruntime-node')
  const providers = ort.listSupportedBackends()
  if (!providers.some((item) => item.name === request.options.executionProvider && item.bundled))
    throw new Error('Explicitly requested ONNX execution provider is unavailable')

  const sessionOptions = buildMobileSamSessionOptions(request.options)
  const encoder = await ort.InferenceSession.create(
    await verifiedBytes(request.options.encoderPath, encoderIdentity),
    sessionOptions,
  )
  let decoder: InferenceSession | undefined
  let result: NativeSegmentationReply | undefined
  let releaseFailed = false
  try {
    decoder = await ort.InferenceSession.create(
      await verifiedBytes(request.options.decoderPath, decoderIdentity),
      sessionOptions,
    )
    const rgba = Buffer.from(request.rgba, 'base64')
    if (rgba.length !== request.width * request.height * 4)
      throw new Error('Invalid RGBA input size')
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
    const imageTensor = new ort.Tensor('float32', Float32Array.from(rgb), [
      resizedHeight,
      resizedWidth,
      3,
    ])
    try {
      const encoded = await encoder.run({ input_image: imageTensor })
      const embedding = encoded.image_embeddings
      if (
        !(embedding instanceof ort.Tensor) ||
        embedding.type !== 'float32' ||
        JSON.stringify(embedding.dims) !== JSON.stringify([1, 256, 64, 64]) ||
        !(embedding.data instanceof Float32Array)
      )
        throw new Error('Unexpected MobileSAM encoder output')
      const xScale = resizedWidth / request.width
      const yScale = resizedHeight / request.height
      const prompt = mobileSamSegmentationPrompt({
        prompt: request.prompt,
        seedRegion: request.seedRegion,
        wholeRegion: request.wholeRegion,
        xScale,
        yScale,
      })
      const decoded = await decoder.run({
        image_embeddings: embedding,
        point_coords: new ort.Tensor('float32', prompt.coordinates, [1, 2, 2]),
        point_labels: new ort.Tensor('float32', prompt.labels, [1, 2]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', Float32Array.of(0), [1]),
        orig_im_size: new ort.Tensor('float32', Float32Array.of(request.height, request.width), [
          2,
        ]),
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
        throw new Error('Unexpected MobileSAM decoder output')

      const candidates = collectMobileSamSegmentationCandidates({
        width: request.width,
        height: request.height,
        rgba,
        logits: masks.data,
        scores: scores.data,
        roi: request.roi,
        seedRegion: request.seedRegion,
        prompt: request.prompt,
      })
      const mask = selectMobileSamSegmentationMask({
        candidates,
        width: request.width,
        height: request.height,
        prompt: request.prompt,
      })
      result = {
        id: request.id,
        status: 'segmented',
        width: request.width,
        height: request.height,
        mask: Buffer.from(mask).toString('base64'),
        method:
          request.prompt === 'seed-region' ? 'mobile-sam-seed-point-v1' : 'mobile-sam-box-prompt',
      }
    } finally {
      imageTensor.dispose()
    }
  } finally {
    const releases = await Promise.allSettled([
      encoder.release(),
      ...(decoder ? [decoder.release()] : []),
    ])
    releaseFailed = releases.some((release) => release.status === 'rejected')
  }
  if (releaseFailed) throw new Error('MobileSAM native session release failed')
  if (!result) throw new Error('MobileSAM completed without a mask result')
  return result
}
