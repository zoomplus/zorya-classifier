import sharp from 'sharp'
import type { DecisionPort, DecisionRequest, PixelRect } from '../../src/entities/contracts.js'

interface SourceTransform {
  source: { width: number; height: number }
  output: { width: number; height: number }
  content: PixelRect
  scaleX: number
  scaleY: number
}

interface SeedOutlineTransform extends SourceTransform {
  seedRegion: PixelRect
  lineWidthPx: number
}

function isImagePart(
  value: DecisionRequest['state'][number],
): value is Extract<DecisionRequest['state'][number], { type: 'image_url' }> {
  return typeof value !== 'string' && value.type === 'image_url'
}

function parseSourceTransform(value: unknown): SourceTransform | undefined {
  if (!value || typeof value !== 'object' || !('sourceImageTransform' in value)) return undefined
  const transform = value.sourceImageTransform
  if (!transform || typeof transform !== 'object') return undefined
  const item = transform as Partial<SourceTransform>
  const size = (value: unknown): value is { width: number; height: number } =>
    !!value &&
    typeof value === 'object' &&
    'width' in value &&
    'height' in value &&
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    Number(value.width) > 0 &&
    Number(value.height) > 0
  if (
    !size(item.source) ||
    !size(item.output) ||
    !item.content ||
    !Number.isSafeInteger(item.content.left) ||
    !Number.isSafeInteger(item.content.top) ||
    !Number.isSafeInteger(item.content.width) ||
    !Number.isSafeInteger(item.content.height) ||
    typeof item.scaleX !== 'number' ||
    !Number.isFinite(item.scaleX) ||
    item.scaleX <= 0 ||
    typeof item.scaleY !== 'number' ||
    !Number.isFinite(item.scaleY) ||
    item.scaleY <= 0
  )
    return undefined
  return item as SourceTransform
}

function parseSeedRegion(state: DecisionRequest['state']): PixelRect | undefined {
  for (const part of state) {
    if (typeof part !== 'string' || !part.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(part)
      if (!parsed || typeof parsed !== 'object' || !('seedRegion' in parsed)) continue
      const region = parsed.seedRegion as Record<string, unknown> | null
      if (
        region &&
        typeof region === 'object' &&
        Number.isSafeInteger(region.left) &&
        Number.isSafeInteger(region.top) &&
        Number.isSafeInteger(region.width) &&
        Number.isSafeInteger(region.height) &&
        Number(region.left) >= 0 &&
        Number(region.top) >= 0 &&
        Number(region.width) > 0 &&
        Number(region.height) > 0
      )
        return region as PixelRect
    } catch {
      continue
    }
  }
  return undefined
}

function isExtentRequest(request: DecisionRequest): boolean {
  return ['left', 'right', 'top', 'bottom'].every((id) => Object.hasOwn(request.questions, id))
}

async function addSeedOutline(
  imagePart: Extract<DecisionRequest['state'][number], { type: 'image_url' }>,
  transform: SourceTransform,
  seedRegion: PixelRect,
): Promise<{ imagePart: typeof imagePart; metadata: SeedOutlineTransform }> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(imagePart.image_url.url)
  if (!match) throw new TypeError('Original image state is not a PNG data URL')
  const imageBytes = Buffer.from(match[1]!, 'base64')
  const metadata = await sharp(imageBytes, { limitInputPixels: 20_000_000 }).metadata()
  if (metadata.width !== transform.output.width || metadata.height !== transform.output.height)
    throw new TypeError('Original image dimensions do not match the source transform')
  const x = transform.content.left + seedRegion.left * transform.scaleX
  const y = transform.content.top + seedRegion.top * transform.scaleY
  const width = seedRegion.width * transform.scaleX
  const height = seedRegion.height * transform.scaleY
  const right = transform.content.left + transform.content.width
  const bottom = transform.content.top + transform.content.height
  if (
    x < transform.content.left ||
    y < transform.content.top ||
    x + width > right ||
    y + height > bottom ||
    width <= 0 ||
    height <= 0
  )
    throw new TypeError('Seed outline escaped the displayed source content')
  const lineWidthPx = 3
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${transform.output.width}" height="${transform.output.height}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#00ffff" stroke-width="${lineWidthPx}"/></svg>`,
  )
  const output = await sharp(imageBytes, { limitInputPixels: 20_000_000 })
    .composite([{ input: svg }])
    .png()
    .toBuffer()
  return {
    imagePart: {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${output.toString('base64')}`, detail: 'high' },
    },
    metadata: { ...transform, seedRegion, lineWidthPx },
  }
}

/** Replace only the extent-stage seed crop with a source-space outline on ORIGINAL. */
export function withSeedOutlinePresentation(delegate: DecisionPort): DecisionPort {
  return {
    async decide(request, signal) {
      if (!isExtentRequest(request)) return delegate.decide(request, signal)
      const originalIndex = request.state.findIndex((part) => part === 'ORIGINAL')
      const seedIndex = request.state.findIndex((part) => part === 'SEED')
      if (originalIndex < 0 || seedIndex < 0 || seedIndex <= originalIndex)
        throw new TypeError('Whole-object extent request lacks ORIGINAL/SEED markers')
      const originalImage = request.state[originalIndex + 1]
      const seedImage = request.state[seedIndex + 1]
      if (
        originalImage === undefined ||
        seedImage === undefined ||
        !isImagePart(originalImage) ||
        !isImagePart(seedImage)
      )
        throw new TypeError('Whole-object extent request lacks original or seed image part')
      const transformIndex = originalIndex + 2
      const transformText = request.state[transformIndex]
      if (typeof transformText !== 'string')
        throw new TypeError('Original source transform metadata is absent')
      const transform = parseSourceTransform(JSON.parse(transformText))
      const seedRegion = parseSeedRegion(request.state)
      const seedTransformIndex = seedIndex + 2
      const seedTransformText = request.state[seedTransformIndex]
      const hasSeedTransform =
        typeof seedTransformText === 'string' &&
        parseSourceTransform(JSON.parse(seedTransformText)) !== undefined
      if (!transform || !seedRegion)
        throw new TypeError('Whole-object extent geometry is incomplete')
      const outlined = await addSeedOutline(originalImage, transform, seedRegion)
      const state: DecisionRequest['state'] = []
      for (let index = 0; index < request.state.length; index++) {
        if (index === originalIndex) {
          state.push('ORIGINAL WITH SEED CROP OUTLINE (INTERIOR WITNESS ONLY)', outlined.imagePart)
          continue
        }
        if (
          index === originalIndex + 1 ||
          index === seedIndex ||
          index === seedIndex + 1 ||
          (hasSeedTransform && index === seedTransformIndex)
        )
          continue
        if (index === transformIndex && typeof request.state[index] === 'string') {
          state.push(request.state[index] as string)
          state.push(JSON.stringify({ seedOutlineView: outlined.metadata }))
          continue
        }
        state.push(request.state[index]!)
      }
      return delegate.decide({ state, questions: request.questions }, signal)
    },
  }
}
