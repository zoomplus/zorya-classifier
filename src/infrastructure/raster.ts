import sharp from 'sharp'
import type {
  DecisionState,
  GridCell,
  ImagePart,
  PixelRect,
  RasterImage,
  RasterPort,
} from '../entities/contracts.js'
import { limits } from '../entities/contracts.js'
import { ClassifierError, assertActive } from '../entities/errors.js'

function contains(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  )
}
async function normalizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<RasterImage> {
  assertActive(signal)
  const pipeline = sharp(bytes, { limitInputPixels: limits.imagePixels, failOn: 'error' })
  try {
    const metadata = await pipeline.metadata()
    assertActive(signal)
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
      throw new ClassifierError('INVALID_INPUT', 'Use a single PNG, JPEG or WebP image')
    const normalized = await pipeline.rotate().png().toBuffer({ resolveWithObject: true })
    assertActive(signal)
    if (normalized.data.byteLength > limits.imageBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'Decoded presentation exceeds image byte limit')
    return { bytes: normalized.data, width: normalized.info.width, height: normalized.info.height }
  } catch (error) {
    assertActive(signal)
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError('INVALID_INPUT', 'Image cannot be decoded within pixel limits')
  } finally {
    pipeline.destroy()
  }
}
async function cropImage(
  image: RasterImage,
  region: PixelRect,
  signal: AbortSignal,
  scale = 1,
): Promise<RasterImage> {
  assertActive(signal)
  if (!contains({ left: 0, top: 0, width: image.width, height: image.height }, region))
    throw new ClassifierError('INVALID_INPUT', 'ROI lies outside oriented source image')
  const pipeline = sharp(image.bytes, { limitInputPixels: limits.imagePixels })
    .extract(region)
    .resize(region.width * scale, region.height * scale, { kernel: 'nearest' })
  try {
    const data = await pipeline.png().toBuffer()
    assertActive(signal)
    return { bytes: data, width: region.width * scale, height: region.height * scale }
  } finally {
    pipeline.destroy()
  }
}
async function imageState(image: RasterImage, signal: AbortSignal): Promise<DecisionState> {
  assertActive(signal)
  const scale = Math.min(
    1568 / Math.max(image.width, image.height),
    Math.max(1, 280 / Math.min(image.width, image.height)),
  )
  const width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale))
  const outWidth = Math.max(280, width),
    outHeight = Math.max(280, height)
  const left = Math.floor((outWidth - width) / 2),
    top = Math.floor((outHeight - height) / 2)
  const pipeline = sharp(image.bytes, { limitInputPixels: limits.imagePixels })
    .resize(width, height, { kernel: 'nearest' })
    .extend({
      left,
      top,
      right: outWidth - width - left,
      bottom: outHeight - height - top,
      background: '#000000',
    })
  try {
    const bytes = await pipeline.png().toBuffer()
    assertActive(signal)
    if (bytes.length > limits.imageBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'Prepared image is too large')
    const part: ImagePart = {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' },
    }
    return [
      part,
      JSON.stringify({
        sourceImageTransform: {
          source: { width: image.width, height: image.height },
          output: { width: outWidth, height: outHeight },
          content: { left, top, width, height },
          scaleX: width / image.width,
          scaleY: height / image.height,
        },
      }),
    ]
  } finally {
    pipeline.destroy()
  }
}
async function renderGrid(
  image: RasterImage,
  region: PixelRect,
  cells: readonly GridCell[],
  labels: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<RasterImage> {
  const crop = await cropImage(image, region, signal)
  const scale = Math.min(
    1512 / Math.max(crop.width, crop.height),
    Math.max(1, 900 / Math.min(crop.width, crop.height)),
  )
  const width = Math.max(1, Math.round(crop.width * scale)),
    height = Math.max(1, Math.round(crop.height * scale))
  const rectangles = cells
    .map((cell) => {
      const label = labels.get(cell.id)
      if (!label || !/^[PC][0-9]{2,3}$/.test(label))
        throw new ClassifierError('INVALID_INPUT', 'Invalid grid label')
      const x = ((cell.region.left - region.left) * width) / region.width,
        y = ((cell.region.top - region.top) * height) / region.height
      const w = (cell.region.width * width) / region.width,
        h = (cell.region.height * height) / region.height
      const font = Math.max(3, Math.min(18, w / (label.length * 0.7), h / 2))
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="white" stroke-width="1"/><rect x="${x + 1}" y="${y + 1}" width="${Math.min(w - 1, font * label.length * 0.7)}" height="${font + 2}" fill="#111827" fill-opacity="0.78"/><text x="${x + 2}" y="${y + font}" font-family="DejaVu Sans,sans-serif" font-size="${font}" fill="white">${label}</text>`
    })
    .join('')
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangles}</svg>`,
  )
  const pipeline = sharp(crop.bytes, { limitInputPixels: limits.imagePixels })
    .resize(width, height, { kernel: 'nearest' })
    .composite([{ input: svg }])
  try {
    const bytes = await pipeline.png().toBuffer()
    assertActive(signal)
    return { bytes, width, height }
  } finally {
    pipeline.destroy()
  }
}

export function createSharpRaster(): RasterPort {
  return { normalize: normalizeImage, crop: cropImage, imageState, grid: renderGrid }
}
