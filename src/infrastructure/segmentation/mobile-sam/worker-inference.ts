import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import sharp from 'sharp'
import type { InferenceSession } from 'onnxruntime-node'

import type { NativeSegmentationReply, NativeSegmentationRequest } from '../native-protocol.js'

const encoderIdentity = {
  bytes: 28_157_093,
  sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
} as const
const decoderIdentity = {
  bytes: 16_496_559,
  sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
} as const

async function verifiedBytes(file: string, identity: { bytes: number; sha256: string }) {
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== identity.bytes)
      throw new Error('Pinned model size mismatch')
    const bytes = Buffer.alloc(identity.bytes)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null)
      if (read.bytesRead === 0) throw new Error('Pinned model read was incomplete')
      offset += read.bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0)
      throw new Error('Pinned model changed while reading')
    if (createHash('sha256').update(bytes).digest('hex') !== identity.sha256)
      throw new Error('Pinned model SHA256 mismatch')
    return bytes
  } finally {
    await handle.close()
  }
}

export async function probeMobileSam(
  options: Extract<NativeSegmentationRequest, { kind: 'probe-mobile-sam' }>['options'],
): Promise<void> {
  const ort = await import('onnxruntime-node')
  if (
    !ort
      .listSupportedBackends()
      .some((item) => item.name === options.executionProvider && item.bundled)
  )
    throw new Error('Explicitly requested ONNX execution provider is unavailable')
  const sessionOptions: InferenceSession.SessionOptions = {
    executionProviders:
      options.executionProvider === 'dml'
        ? [{ name: 'dml', deviceId: options.deviceId ?? 0 }]
        : ['cpu'],
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    enableMemPattern: options.executionProvider !== 'dml',
    graphOptimizationLevel: 'all',
  }
  const encoderBytes = await verifiedBytes(options.encoderPath, encoderIdentity)
  const decoderBytes = await verifiedBytes(options.decoderPath, decoderIdentity)
  let encoder: InferenceSession | undefined
  let decoder: InferenceSession | undefined
  let releaseFailed = false
  try {
    encoder = await ort.InferenceSession.create(encoderBytes, sessionOptions)
    decoder = await ort.InferenceSession.create(decoderBytes, sessionOptions)
    if (
      !encoder.inputNames.includes('input_image') ||
      !encoder.outputNames.includes('image_embeddings') ||
      !decoder.inputNames.includes('image_embeddings') ||
      !decoder.outputNames.includes('masks') ||
      !decoder.outputNames.includes('iou_predictions')
    )
      throw new Error('Pinned MobileSAM graph tensor names are incompatible')
  } finally {
    const closed = await Promise.allSettled([
      ...(encoder ? [encoder.release()] : []),
      ...(decoder ? [decoder.release()] : []),
    ])
    releaseFailed = closed.some((item) => item.status === 'rejected')
  }
  if (releaseFailed) throw new Error('MobileSAM probe session release failed')
}

function inside(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
) {
  return x >= rect.left && y >= rect.top && x < rect.left + rect.width && y < rect.top + rect.height
}

interface MaskCandidate {
  token: number
  score: number
  mask: Uint8Array
}

/** Sort by model quality and use decoder token order as a deterministic tie break. */
export function selectBestMaskCandidate<T extends MaskCandidate>(
  candidates: readonly T[],
): T | undefined {
  return [...candidates].sort((a, b) => b.score - a.score || a.token - b.token)[0]
}

export async function runMobileSamTask(
  request: Extract<NativeSegmentationRequest, { kind: 'mobile-sam' }>,
): Promise<NativeSegmentationReply> {
  // Deliberately loaded inside the owned child. Core/entry imports never initialize ONNX Runtime.
  const ort = await import('onnxruntime-node')
  const providers = ort.listSupportedBackends()
  if (!providers.some((item) => item.name === request.options.executionProvider && item.bundled))
    throw new Error('Explicitly requested ONNX execution provider is unavailable')

  const sessionOptions: InferenceSession.SessionOptions = {
    executionProviders:
      request.options.executionProvider === 'dml'
        ? [{ name: 'dml', deviceId: request.options.deviceId ?? 0 }]
        : ['cpu'],
    intraOpNumThreads: request.options.threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    enableMemPattern: request.options.executionProvider !== 'dml',
    graphOptimizationLevel: 'all',
  }
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
      const coordinates = Float32Array.of(
        request.wholeRegion.left * xScale,
        request.wholeRegion.top * yScale,
        (request.wholeRegion.left + request.wholeRegion.width) * xScale,
        (request.wholeRegion.top + request.wholeRegion.height) * yScale,
      )
      const decoded = await decoder.run({
        image_embeddings: embedding,
        point_coords: new ort.Tensor('float32', coordinates, [1, 2, 2]),
        point_labels: new ort.Tensor('float32', Float32Array.of(2, 3), [1, 2]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', Float32Array.of(0), [1]),
        orig_im_size: new ort.Tensor('float32', Float32Array.of(request.height, request.width), [
          2,
        ]),
      })
      const masks = decoded.masks
      const scores = decoded.iou_predictions
      const pixels = request.width * request.height
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

      const candidates: MaskCandidate[] = []
      for (let token = 0; token < 4; token++) {
        const mask = new Uint8Array(pixels)
        let seedHit = false
        for (let index = 0; index < pixels; index++) {
          const value = masks.data[token * pixels + index]
          if (value === undefined || !Number.isFinite(value))
            throw new Error('Non-finite mask logit')
          if (value <= 0) continue
          const x = index % request.width
          const y = Math.floor(index / request.width)
          if (!inside(request.roi, x, y)) continue
          mask[index] = 1
          if (inside(request.seedRegion, x, y)) seedHit = true
        }
        const score = scores.data[token]
        if (seedHit && score !== undefined) candidates.push({ token, score, mask })
      }
      if (!candidates.length) throw new Error('MobileSAM produced no seed-grounded mask')
      const best = selectBestMaskCandidate(candidates)
      if (!best) throw new Error('MobileSAM produced no mask candidate')
      result = {
        id: request.id,
        status: 'segmented',
        width: request.width,
        height: request.height,
        mask: Buffer.from(best.mask).toString('base64'),
        method: 'mobile-sam-box-prompt',
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
