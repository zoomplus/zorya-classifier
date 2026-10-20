import sharp from 'sharp'
import { z } from 'zod'
import type { PixelRect, RasterImage } from '../entities/contracts.js'
import { limits, pixelRectSchema } from '../entities/contracts.js'
import type {
  BoundaryAxis,
  BoundaryCandidate,
  BoundaryViewInput,
  BoundaryViewPort,
} from '../entities/boundary-view.js'
import { ClassifierError, assertActive } from '../entities/errors.js'

const sourceSchema = z
  .object({
    bytes: z
      .custom<Uint8Array>((v) => v instanceof Uint8Array)
      .refine((v) => v.byteLength > 0 && v.byteLength <= limits.imageBytes),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
  })
  .strict()
const candidateSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    display: z
      .string()
      .min(1)
      .max(8)
      .regex(/^[A-Za-z0-9_-]+$/),
    interval: z
      .object({
        start: z.number().int().nonnegative().safe(),
        endExclusive: z.number().int().positive().safe(),
      })
      .strict()
      .refine((v) => v.start < v.endExclusive),
  })
  .strict()
const inputSchema = z
  .object({
    source: sourceSchema,
    sourceRegion: pixelRectSchema,
    axis: z.enum(['left', 'right', 'top', 'bottom']),
    candidates: z.array(candidateSchema).min(1).max(16),
    signal: z.custom<AbortSignal>((v) => v instanceof AbortSignal),
  })
  .strict()

const maxContentSide = 1280
const maxOutputSide = 1567
const axisGutter = 210
const outerGutter = 10
const maxRenderedBytes = limits.imageBytes

function contained(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  )
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

function failInput(message: string): never {
  throw new ClassifierError('INVALID_INPUT', message, { component: 'boundary-view' })
}

function validate(input: BoundaryViewInput): BoundaryViewInput {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) failInput('Invalid boundary-view request')
  const value = parsed.data
  if (value.source.width * value.source.height > limits.imagePixels)
    throw new ClassifierError('RESOURCE_LIMIT', 'Source raster exceeds pixel limits', {
      component: 'boundary-view',
    })
  const full = { left: 0, top: 0, width: value.source.width, height: value.source.height }
  if (!contained(full, value.sourceRegion))
    failInput('Source region lies outside the oriented image')
  const xAxis = value.axis === 'left' || value.axis === 'right'
  const axisSize = xAxis ? value.source.width : value.source.height
  const axisStart = xAxis ? value.sourceRegion.left : value.sourceRegion.top
  const axisEnd = axisStart + (xAxis ? value.sourceRegion.width : value.sourceRegion.height)
  const ids = new Set<string>()
  const displays = new Set<string>()
  let priorEnd = -1
  for (const candidate of value.candidates) {
    if (ids.has(candidate.id) || displays.has(candidate.display))
      failInput('Boundary candidate IDs and display labels must be unique')
    ids.add(candidate.id)
    displays.add(candidate.display)
    if (candidate.interval.endExclusive > axisSize)
      failInput('Boundary interval lies outside the oriented source')
    if (candidate.interval.start < axisStart || candidate.interval.endExclusive > axisEnd)
      failInput('Boundary interval lies outside the source region')
    if (candidate.interval.start < priorEnd)
      failInput('Boundary intervals must be ordered and non-overlapping')
    priorEnd = candidate.interval.endExclusive
  }
  return value
}

function svgOverlay(
  axis: BoundaryAxis,
  candidates: readonly BoundaryCandidate[],
  region: PixelRect,
  contentWidth: number,
  contentHeight: number,
  contentLeft: number,
  contentTop: number,
  outputWidth: number,
  outputHeight: number,
): Buffer {
  const vertical = axis === 'left' || axis === 'right'
  const axisLength = vertical ? region.width : region.height
  const outputLength = vertical ? contentWidth : contentHeight
  const sourceOffset = vertical ? region.left : region.top
  const unit = outputLength / axisLength
  const strokes: string[] = []
  // Presentation is tied to the coordinate dimension, never to the semantic side being located.
  const color = vertical ? '#ff6b5f' : '#49d6a1'
  const title = vertical ? 'X coordinates' : 'Y coordinates'
  strokes.push(
    vertical
      ? `<text x="${outputWidth - outerGutter - 2}" y="${outerGutter + 10}" text-anchor="end" font-family="DejaVu Sans,sans-serif" font-size="9" fill="#f3f4f6">${title}</text>`
      : `<text x="${outerGutter}" y="${outerGutter + 10}" font-family="DejaVu Sans,sans-serif" font-size="9" fill="#f3f4f6">${title}</text>`,
  )
  const positions = candidates.map((candidate) => {
    const begin = (candidate.interval.start - sourceOffset) * unit
    const end = (candidate.interval.endExclusive - sourceOffset) * unit
    return (begin + end) / 2
  })
  const labelBaselines = vertical
    ? (() => {
        const pitch = 12
        const lanes: number[] = []
        const rightEdges: number[] = []
        return candidates.map((candidate, index) => {
          const center = contentLeft + (positions[index] ?? 0)
          const width = candidate.display.length * 7 + 6
          let lane = rightEdges.findIndex((right) => right + 3 <= center - width / 2)
          if (lane < 0) {
            lane = rightEdges.length
            rightEdges.push(Number.NEGATIVE_INFINITY)
          }
          rightEdges[lane] = center + width / 2
          lanes[index] = lane
          return contentTop - 5 - (lane + 1) * pitch
        })
      })()
    : (() => {
        const min = outerGutter + 10
        const max = outputHeight - outerGutter - 3
        const pitch = 12
        const desired = positions.map((position) => contentTop + position + 4)
        const placed = desired.map((position) => Math.max(min, Math.min(max, position)))
        for (let index = 1; index < placed.length; index++)
          placed[index] = Math.max(placed[index] ?? min, (placed[index - 1] ?? min) + pitch)
        if ((placed.at(-1) ?? max) > max) {
          placed[placed.length - 1] = max
          for (let index = placed.length - 2; index >= 0; index--)
            placed[index] = Math.min(placed[index] ?? max, (placed[index + 1] ?? max) - pitch)
        }
        return placed
      })()
  for (const [index, candidate] of candidates.entries()) {
    const start = (candidate.interval.start - sourceOffset) * unit
    const end = (candidate.interval.endExclusive - sourceOffset) * unit
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    const midpoint = (lo + hi) / 2
    const label = escapeXml(candidate.display)
    if (vertical) {
      const center = contentLeft + midpoint
      const halfWidth = candidate.display.length * 3.5 + 3
      const labelCenter = Math.max(
        contentLeft + halfWidth,
        Math.min(contentLeft + contentWidth - halfWidth, center),
      )
      const baseline = labelBaselines[index] ?? contentTop - 17
      strokes.push(
        `<rect x="${contentLeft + lo}" y="${contentTop}" width="${Math.max(1, hi - lo)}" height="${contentHeight}" fill="${color}" fill-opacity="0.045"/>`,
        `<line x1="${contentLeft + start}" y1="${contentTop}" x2="${contentLeft + start}" y2="${contentTop + contentHeight}" stroke="${color}" stroke-opacity="0.9" stroke-width="2"/>`,
        `<line x1="${contentLeft + end}" y1="${contentTop}" x2="${contentLeft + end}" y2="${contentTop + contentHeight}" stroke="${color}" stroke-opacity="0.9" stroke-width="2"/>`,
        `<path d="M ${center} ${contentTop} L ${center} ${baseline + 4} L ${labelCenter} ${baseline + 4}" fill="none" stroke="${color}" stroke-width="1"/>`,
        `<text x="${labelCenter}" y="${baseline}" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="10" font-weight="bold" fill="${color}">${label}</text>`,
      )
    } else {
      const midpointY = contentTop + midpoint
      const baseline = labelBaselines[index] ?? midpointY + 4
      const elbowX = contentLeft - 12 - index * 3
      const labelX = contentLeft - 82
      strokes.push(
        `<rect x="${contentLeft}" y="${contentTop + lo}" width="${contentWidth}" height="${Math.max(1, hi - lo)}" fill="${color}" fill-opacity="0.045"/>`,
        `<line x1="${contentLeft}" y1="${contentTop + start}" x2="${contentLeft + contentWidth}" y2="${contentTop + start}" stroke="${color}" stroke-opacity="0.9" stroke-width="2"/>`,
        `<line x1="${contentLeft}" y1="${contentTop + end}" x2="${contentLeft + contentWidth}" y2="${contentTop + end}" stroke="${color}" stroke-opacity="0.9" stroke-width="2"/>`,
        `<path d="M ${contentLeft} ${midpointY} L ${elbowX} ${midpointY} L ${elbowX} ${baseline} L ${labelX + 4} ${baseline}" fill="none" stroke="${color}" stroke-width="1"/>`,
        `<text x="${labelX}" y="${baseline}" text-anchor="end" font-family="DejaVu Sans,sans-serif" font-size="10" font-weight="bold" fill="${color}">${label}</text>`,
      )
    }
  }
  const sourceBounds = `<rect x="${contentLeft}" y="${contentTop}" width="${contentWidth}" height="${contentHeight}" fill="none" stroke="#f3f4f6" stroke-opacity="0.65" stroke-width="1"/>`
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}">${sourceBounds}${strokes.join('')}</svg>`,
  )
}

async function render(input: BoundaryViewInput) {
  assertActive(input.signal)
  const value = validate(input)
  assertActive(value.signal)

  // Sharp retains its input through an asynchronous pipeline; take ownership before awaiting.
  const ownedBytes = Buffer.from(value.source.bytes)
  const candidates = value.candidates.map((candidate) => ({
    id: candidate.id,
    display: candidate.display,
    interval: { ...candidate.interval },
  }))
  const { sourceRegion: region } = value
  const scale = Math.min(
    maxContentSide / Math.max(region.width, region.height),
    Math.max(1, 768 / Math.min(region.width, region.height)),
  )
  const contentWidth = Math.max(1, Math.round(region.width * scale))
  const contentHeight = Math.max(1, Math.round(region.height * scale))
  const vertical = value.axis === 'left' || value.axis === 'right'
  const contentLeft = vertical ? outerGutter : axisGutter
  const contentTop = vertical ? axisGutter : outerGutter
  const outputWidth = Math.max(280, contentLeft + contentWidth + outerGutter)
  const outputHeight = Math.max(280, contentTop + contentHeight + outerGutter)
  if (outputWidth > maxOutputSide || outputHeight > maxOutputSide)
    throw new ClassifierError('RESOURCE_LIMIT', 'Boundary view exceeds output side limit', {
      component: 'boundary-view',
    })
  const pixels = outputWidth * outputHeight
  if (pixels > limits.imagePixels)
    throw new ClassifierError('RESOURCE_LIMIT', 'Boundary view exceeds output pixel limit', {
      component: 'boundary-view',
    })
  const overlay = svgOverlay(
    value.axis,
    candidates,
    region,
    contentWidth,
    contentHeight,
    contentLeft,
    contentTop,
    outputWidth,
    outputHeight,
  )
  if (overlay.byteLength > 128 * 1024)
    throw new ClassifierError('RESOURCE_LIMIT', 'Boundary overlay exceeds byte budget', {
      component: 'boundary-view',
    })
  let pipeline: sharp.Sharp | undefined
  try {
    assertActive(value.signal)
    pipeline = sharp(ownedBytes, { limitInputPixels: limits.imagePixels, failOn: 'error' })
      .extract(region)
      .resize(contentWidth, contentHeight, { kernel: 'nearest' })
      .extend({
        left: contentLeft,
        top: contentTop,
        right: outputWidth - contentLeft - contentWidth,
        bottom: outputHeight - contentTop - contentHeight,
        background: { r: 17, g: 24, b: 39, alpha: 1 },
      })
      .composite([{ input: overlay }])
    const result = await pipeline.png().toBuffer()
    assertActive(value.signal)
    if (result.byteLength > maxRenderedBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'Rendered boundary view exceeds byte limit', {
        component: 'boundary-view',
      })
    return {
      image: { bytes: result, width: outputWidth, height: outputHeight } satisfies RasterImage,
      sourceRegion: { ...region },
      content: { left: contentLeft, top: contentTop, width: contentWidth, height: contentHeight },
      scaleX: contentWidth / region.width,
      scaleY: contentHeight / region.height,
      candidates,
    }
  } catch (error) {
    assertActive(value.signal)
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError('INVALID_INPUT', 'Boundary view could not be rendered', {
      component: 'boundary-view',
    })
  } finally {
    pipeline?.destroy()
    ownedBytes.fill(0)
    overlay.fill(0)
  }
}

export function createSharpBoundaryView(): BoundaryViewPort {
  return { render }
}
