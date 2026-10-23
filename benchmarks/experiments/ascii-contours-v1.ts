import { assertActive } from '../../src/entities/errors.js'
import type { TextPixelView, TextRepresentationEncoder } from './text-representation.js'
import { assertPixelView, luma, rgbaAt, utf8Size } from './encoder-common.js'

const header = 'ASCII_CONTOURS_V1'
const sobelThreshold = 128

interface Planes {
  binary: string[]
  edges: string[]
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0
}

function otsu(histogram: Uint32Array, count: number): number {
  let totalWeighted = 0
  for (let value = 0; value < histogram.length; value += 1)
    totalWeighted += value * (histogram[value] ?? 0)
  let backgroundWeight = 0
  let backgroundWeighted = 0
  let bestVariance = -1
  let bestThreshold = 0
  for (let threshold = 0; threshold < histogram.length - 1; threshold += 1) {
    const binCount = histogram[threshold] ?? 0
    backgroundWeight += binCount
    backgroundWeighted += threshold * binCount
    const foregroundWeight = count - backgroundWeight
    if (backgroundWeight === 0 || foregroundWeight === 0) continue
    const backgroundMean = backgroundWeighted / backgroundWeight
    const foregroundMean = (totalWeighted - backgroundWeighted) / foregroundWeight
    const difference = backgroundMean - foregroundMean
    const variance = backgroundWeight * foregroundWeight * difference * difference
    if (variance > bestVariance) {
      bestVariance = variance
      bestThreshold = threshold
    }
  }
  return bestThreshold
}

function preparePlanes(view: TextPixelView): Planes {
  const pixelCount = view.width * view.height
  const lumas = new Uint8Array(pixelCount)
  const transparent = new Uint8Array(pixelCount)
  const opaqueLumas: number[] = []
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const [red, green, blue, alpha] = rgbaAt(view.data, pixel)
    if (alpha === 0) {
      transparent[pixel] = 1
      continue
    }
    const value = luma(red, green, blue)
    lumas[pixel] = value
    opaqueLumas.push(value)
  }
  opaqueLumas.sort((left, right) => left - right)
  const low = percentile(opaqueLumas, 0.01)
  const high = percentile(opaqueLumas, 0.99)
  const normalized = new Uint8Array(pixelCount)
  const histogram = new Uint32Array(256)
  let opaqueCount = 0
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (transparent[pixel] === 1) continue
    const value = lumas[pixel] ?? 0
    const contrast = high <= low ? 0 : Math.round(((value - low) * 255) / (high - low))
    const clamped = Math.max(0, Math.min(255, contrast))
    normalized[pixel] = clamped
    histogram[clamped] = (histogram[clamped] ?? 0) + 1
    opaqueCount += 1
  }
  const threshold = otsu(histogram, opaqueCount)
  const binary: string[] = []
  for (let y = 0; y < view.height; y += 1) {
    let row = ''
    for (let x = 0; x < view.width; x += 1) {
      const pixel = y * view.width + x
      row += transparent[pixel] === 1 ? 'T' : (normalized[pixel] ?? 0) > threshold ? '1' : '0'
    }
    binary.push(`y${y}: ${row}`)
  }

  const sample = (x: number, y: number): number => {
    const boundedX = Math.max(0, Math.min(view.width - 1, x))
    const boundedY = Math.max(0, Math.min(view.height - 1, y))
    return normalized[boundedY * view.width + boundedX] ?? 0
  }
  const edges: string[] = []
  for (let y = 0; y < view.height; y += 1) {
    let row = ''
    for (let x = 0; x < view.width; x += 1) {
      const pixel = y * view.width + x
      if (transparent[pixel] === 1) {
        row += 'T'
        continue
      }
      const horizontal =
        -sample(x - 1, y - 1) +
        sample(x + 1, y - 1) -
        2 * sample(x - 1, y) +
        2 * sample(x + 1, y) -
        sample(x - 1, y + 1) +
        sample(x + 1, y + 1)
      const vertical =
        -sample(x - 1, y - 1) -
        2 * sample(x, y - 1) -
        sample(x + 1, y - 1) +
        sample(x - 1, y + 1) +
        2 * sample(x, y + 1) +
        sample(x + 1, y + 1)
      row += Math.hypot(horizontal, vertical) >= sobelThreshold ? '#' : '.'
    }
    edges.push(`y${y}: ${row}`)
  }
  return { binary, edges }
}

export function encodeAsciiContoursV1(view: TextPixelView): string {
  assertPixelView(view)
  const planes = preparePlanes(view)
  return `${header}\nwidth=${view.width} height=${view.height}\nluma=p1-p99\nbinary: Otsu\n${planes.binary.join('\n')}\nedges: Sobel-magnitude>=${sobelThreshold}\n${planes.edges.join('\n')}`
}

export function asciiContoursV1MaxEncodedBytes(width: number, height: number): number {
  let bytes = utf8Size(`${header}\nwidth=${width} height=${height}\nluma=p1-p99\nbinary: Otsu\n`)
  for (let y = 0; y < height; y += 1) bytes += utf8Size(`y${y}: `) + width
  bytes += Math.max(0, height - 1)
  bytes += utf8Size(`\nedges: Sobel-magnitude>=${sobelThreshold}\n`)
  for (let y = 0; y < height; y += 1) bytes += utf8Size(`y${y}: `) + width
  return bytes + Math.max(0, height - 1)
}

export const asciiContoursV1Encoder: TextRepresentationEncoder = {
  profile: 'ascii-contours-v1',
  maxEncodedBytes: asciiContoursV1MaxEncodedBytes,
  async encode(view, signal) {
    assertActive(signal)
    return encodeAsciiContoursV1(view)
  },
}
