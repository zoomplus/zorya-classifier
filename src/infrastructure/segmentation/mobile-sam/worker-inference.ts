import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import sharp from 'sharp'
import type { InferenceSession } from 'onnxruntime-node'

import type { NativeSegmentationReply, NativeSegmentationRequest } from '../native-protocol.js'
import { packBinaryMask } from '../../../features/segmentation/packed-mask.js'
import type { NativeObjectProposalReply } from '../native-protocol.js'
import { objectProposalLimits } from '../../../entities/object-proposals.js'

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

export function mobileSamSegmentationPrompt(input: {
  prompt: 'whole-region' | 'seed-region'
  seedRegion: { left: number; top: number; width: number; height: number }
  wholeRegion: { left: number; top: number; width: number; height: number }
  xScale: number
  yScale: number
}) {
  if (input.prompt === 'whole-region')
    return {
      coordinates: Float32Array.of(
        input.wholeRegion.left * input.xScale,
        input.wholeRegion.top * input.yScale,
        (input.wholeRegion.left + input.wholeRegion.width) * input.xScale,
        (input.wholeRegion.top + input.wholeRegion.height) * input.yScale,
      ),
      labels: Float32Array.of(2, 3),
    }
  const centerX = input.seedRegion.left + (input.seedRegion.width - 1) / 2
  const centerY = input.seedRegion.top + (input.seedRegion.height - 1) / 2
  const pointX = centerX * input.xScale
  const pointY = centerY * input.yScale
  return {
    coordinates: Float32Array.of(pointX, pointY, pointX, pointY),
    labels: Float32Array.of(1, -1),
  }
}

export function collectMobileSamSegmentationCandidates(input: {
  width: number
  height: number
  rgba: Uint8Array
  logits: Float32Array
  scores: Float32Array
  roi: { left: number; top: number; width: number; height: number }
  seedRegion: { left: number; top: number; width: number; height: number }
  prompt: 'whole-region' | 'seed-region'
}): MaskCandidate[] {
  const pixels = input.width * input.height
  if (
    input.rgba.length !== pixels * 4 ||
    input.logits.length !== pixels * 4 ||
    input.scores.length !== 4
  )
    throw new Error('Invalid MobileSAM decoder output dimensions')
  const candidates: MaskCandidate[] = []
  for (let token = 0; token < 4; token++) {
    const mask = new Uint8Array(pixels)
    let seedHit = false
    for (let index = 0; index < pixels; index++) {
      const value = input.logits[token * pixels + index]
      if (value === undefined || !Number.isFinite(value)) throw new Error('Non-finite mask logit')
      if (value <= 0) continue
      const x = index % input.width
      const y = Math.floor(index / input.width)
      if (!inside(input.roi, x, y)) continue
      if (input.prompt === 'seed-region' && input.rgba[index * 4 + 3] === 0) continue
      mask[index] = 1
      if (inside(input.seedRegion, x, y)) seedHit = true
    }
    const score = input.scores[token]
    if (score === undefined || !Number.isFinite(score))
      throw new Error('Non-finite MobileSAM quality diagnostic')
    if (seedHit) candidates.push({ token, score, mask })
  }
  return candidates
}

export function selectMobileSamSegmentationMask(input: {
  candidates: readonly MaskCandidate[]
  width: number
  height: number
  prompt: 'whole-region' | 'seed-region'
}): Uint8Array {
  const best = selectBestMaskCandidate(input.candidates)
  if (best) return best.mask
  if (input.prompt === 'seed-region') return new Uint8Array(input.width * input.height)
  throw new Error('MobileSAM produced no seed-grounded mask')
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

type ProposalRequest = Extract<NativeSegmentationRequest, { kind: 'mobile-sam-proposals' }>

/** Produce the fixed row-major 3x3 prompt grid from the actual seed rectangle. */
export function mobileSamProposalPoints(rect: {
  left: number
  top: number
  width: number
  height: number
}): Array<{ x: number; y: number }> {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3)
    const column = index % 3
    return {
      x: rect.left + Math.round(((rect.width - 1) * column) / 2),
      y: rect.top + Math.round(((rect.height - 1) * row) / 2),
    }
  })
}

/** Turn one decoder response into four owned packed candidates immediately. */
export function packMobileSamProposalCandidates(input: {
  width: number
  height: number
  rgba: Uint8Array
  roi: { left: number; top: number; width: number; height: number }
  pointIndex: number
  logits: Float32Array
  scores: Float32Array
}): NativeObjectProposalReply['proposals'] {
  const pixels = input.width * input.height
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    pixels > 2_097_152 ||
    input.rgba.length !== pixels * 4 ||
    input.logits.length !== pixels * 4 ||
    input.scores.length !== 4 ||
    !Number.isInteger(input.pointIndex) ||
    input.pointIndex < 0 ||
    input.pointIndex > 8 ||
    input.roi.left < 0 ||
    input.roi.top < 0 ||
    input.roi.width < 1 ||
    input.roi.height < 1 ||
    input.roi.left + input.roi.width > input.width ||
    input.roi.top + input.roi.height > input.height
  )
    throw new Error('Invalid MobileSAM proposal response dimensions')
  const proposals: NativeObjectProposalReply['proposals'] = []
  for (let token = 0; token < 4; token++) {
    const qualityScore = input.scores[token]
    if (qualityScore === undefined || !Number.isFinite(qualityScore))
      throw new Error('Invalid MobileSAM proposal quality score')
    const mask = new Uint8Array(pixels)
    const base = token * pixels
    for (let index = 0; index < pixels; index++) {
      const value = input.logits[base + index]
      if (value === undefined || !Number.isFinite(value))
        throw new Error('Non-finite MobileSAM proposal logit')
      if (value <= 0 || input.rgba[index * 4 + 3] === 0) continue
      const x = index % input.width
      const y = Math.floor(index / input.width)
      if (inside(input.roi, x, y)) mask[index] = 1
    }
    const id = `C${String(input.pointIndex * 4 + token).padStart(2, '0')}`
    const packed = packBinaryMask(mask, input.width, input.height)
    proposals.push({ id, mask: Buffer.from(packed.data).toString('base64'), qualityScore })
  }
  return proposals
}

/** One encoder pass followed by nine independent positive-point decoder calls. */
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
      const points = mobileSamProposalPoints(request.seedRegion)
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
