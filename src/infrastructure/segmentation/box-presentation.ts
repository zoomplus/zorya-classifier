import sharp from 'sharp'
import { z } from 'zod'
import type { PixelRect } from '../../entities/contracts.js'
import { limits, pixelRectSchema } from '../../entities/contracts.js'
import { ClassifierError, assertActive } from '../../entities/errors.js'
import type {
  SegmentationBoxCheckInput,
  SegmentationBoxPresentationPort,
} from '../../entities/segmentation-verification.js'
import type { RgbaRaster } from '../../entities/representation.js'

const rasterSchema = z
  .object({
    data: z.instanceof(Uint8Array),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    format: z.literal('rgba8'),
  })
  .strict()
const inputSchema = z
  .object({
    image: rasterSchema,
    region: pixelRectSchema,
    seedRegion: pixelRectSchema,
    roi: pixelRectSchema,
    target: z.string().trim().min(1).max(2000),
    exclusions: z.array(z.string().trim().min(1).max(500)).max(16),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict()

function inside(rect: PixelRect, width: number, height: number): boolean {
  return rect.left + rect.width <= width && rect.top + rect.height <= height
}
function overlaps(first: PixelRect, second: PixelRect): boolean {
  return (
    first.left < second.left + second.width &&
    second.left < first.left + first.width &&
    first.top < second.top + second.height &&
    second.top < first.top + first.height
  )
}
function cloneRect(rect: PixelRect): PixelRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}
function snapshot(value: unknown): SegmentationBoxCheckInput {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success)
    throw new ClassifierError('INVALID_INPUT', 'Invalid segmentation box presentation input', {
      paths: parsed.error.issues.map((issue) => issue.path.join('.')),
    })
  const input = parsed.data
  const pixels = input.image.width * input.image.height
  if (
    !Number.isSafeInteger(pixels) ||
    pixels < 1 ||
    pixels > limits.imagePixels ||
    input.image.data.byteLength !== pixels * 4 ||
    !inside(input.region, input.image.width, input.image.height) ||
    !inside(input.seedRegion, input.image.width, input.image.height) ||
    !inside(input.roi, input.image.width, input.image.height) ||
    input.region.left < input.roi.left ||
    input.region.top < input.roi.top ||
    input.region.left + input.region.width > input.roi.left + input.roi.width ||
    input.region.top + input.region.height > input.roi.top + input.roi.height ||
    !overlaps(input.seedRegion, input.region) ||
    !overlaps(input.seedRegion, input.roi)
  )
    throw new ClassifierError('INVALID_INPUT', 'Box, seed, image, and hard ROI geometry disagree')
  const image: RgbaRaster = {
    data: Uint8Array.from(input.image.data),
    width: input.image.width,
    height: input.image.height,
    format: 'rgba8',
  }
  return {
    image,
    region: cloneRect(input.region),
    seedRegion: cloneRect(input.seedRegion),
    roi: cloneRect(input.roi),
    target: input.target,
    exclusions: [...input.exclusions],
    signal: input.signal,
  }
}

function overlaySvg(input: SegmentationBoxCheckInput): Buffer {
  const { image, region, seedRegion, roi } = input
  const x = region.left + Math.min(1.5, region.width / 2)
  const y = region.top + Math.min(1.5, region.height / 2)
  const w = Math.max(0, region.width - Math.min(3, region.width))
  const h = Math.max(0, region.height - Math.min(3, region.height))
  const roiX = roi.left + 1
  const roiY = roi.top + 1
  const roiW = Math.max(0, roi.width - 2)
  const roiH = Math.max(0, roi.height - 2)
  const cx = seedRegion.left + seedRegion.width / 2
  const cy = seedRegion.top + seedRegion.height / 2
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff00ff" stroke-width="3"/><rect x="${roiX}" y="${roiY}" width="${roiW}" height="${roiH}" fill="none" stroke="#ffbf00" stroke-width="2" stroke-dasharray="7 5"/><path d="M ${cx - 5} ${cy} H ${cx + 5} M ${cx} ${cy - 5} V ${cy + 5}" fill="none" stroke="#00ffff" stroke-width="2"/></svg>`,
  )
}

export function createSharpSegmentationBoxPresentation(): SegmentationBoxPresentationPort {
  return {
    async render(value: SegmentationBoxCheckInput) {
      const input = snapshot(value)
      const owned = input.image.data
      const pipeline = sharp(owned, {
        raw: { width: input.image.width, height: input.image.height, channels: 4 },
        limitInputPixels: limits.imagePixels,
        failOn: 'error',
      })
        .composite([{ input: overlaySvg(input) }])
        .png({ compressionLevel: 6 })
      const abort = () => pipeline.destroy()
      input.signal.addEventListener('abort', abort, { once: true })
      try {
        assertActive(input.signal)
        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
        assertActive(input.signal)
        if (
          info.width !== input.image.width ||
          info.height !== input.image.height ||
          data.byteLength < 1 ||
          data.byteLength > limits.imageBytes
        )
          throw new ClassifierError(
            'RESOURCE_LIMIT',
            'Rendered box presentation exceeds image limits',
          )
        return { bytes: Uint8Array.from(data), width: info.width, height: info.height }
      } catch (error) {
        assertActive(input.signal)
        throw error
      } finally {
        input.signal.removeEventListener('abort', abort)
        pipeline.destroy()
        owned.fill(0)
      }
    },
  }
}
