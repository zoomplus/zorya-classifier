import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { InferenceSession } from 'onnxruntime-node'

import type { NativeSegmentationRequest } from '../native-protocol.js'
import { decoderIdentity, encoderIdentity } from './model-assets.js'

export async function verifiedBytes(file: string, identity: { bytes: number; sha256: string }) {
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

export function buildMobileSamSessionOptions(
  options: Extract<NativeSegmentationRequest, { kind: 'mobile-sam' }>['options'],
): InferenceSession.SessionOptions {
  return {
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
  const sessionOptions = buildMobileSamSessionOptions(options)
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

export { encoderIdentity, decoderIdentity }
