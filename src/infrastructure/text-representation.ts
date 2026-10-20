import sharp from 'sharp'
import type { PixelRect, RasterImage } from '../entities/contracts.js'
import { limits } from '../entities/contracts.js'
import { ClassifierError, assertActive } from '../entities/errors.js'
import type {
  ImageRepresentationPort,
  RepresentationMetadata,
  RepresentationView,
} from '../entities/representation.js'
import { representationLimits } from '../entities/representation.js'
import { readCanonicalPixels } from './raster.js'

export interface TextPixelView {
  id: string
  role: RepresentationView['role']
  sourceRegion: PixelRect
  width: number
  height: number
  /** Clean, resized, row-major RGBA8. Grid labels remain separately available as metadata. */
  data: Uint8Array
  grid?: RepresentationView['grid']
}

export interface TextRepresentationEncoder {
  readonly profile: string
  encode(view: TextPixelView, signal: AbortSignal): Promise<string>
}

function isContained(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  )
}

function key(region: PixelRect): string {
  return `${region.left},${region.top},${region.width},${region.height}`
}

function gridKey(view: RepresentationView): string | undefined {
  if (!view.grid) return undefined
  return JSON.stringify(
    view.grid.cells.map((cell) => ({
      id: cell.id,
      region: key(cell.region),
      label: view.grid?.labels.get(cell.id),
    })),
  )
}

function dimensions(region: PixelRect): { width: number; height: number } {
  const scale = Math.min(1, representationLimits.maxSide / Math.max(region.width, region.height))
  return {
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
  }
}

function assertGridGeometry(view: RepresentationView, width: number, height: number): void {
  if (!view.grid) return
  const map = (rect: PixelRect): PixelRect => ({
    left: Math.round(((rect.left - view.sourceRegion.left) * width) / view.sourceRegion.width),
    top: Math.round(((rect.top - view.sourceRegion.top) * height) / view.sourceRegion.height),
    width: Math.round((rect.width * width) / view.sourceRegion.width),
    height: Math.round((rect.height * height) / view.sourceRegion.height),
  })
  const mapped = view.grid.cells.map((cell) => map(cell.region))
  if (view.grid.cells.some((cell) => !isContained(view.sourceRegion, cell.region)))
    throw new ClassifierError('INVALID_INPUT', 'Grid geometry lies outside its source region')
  if (mapped.some((rect) => rect.width < 1 || rect.height < 1))
    throw new ClassifierError(
      'RESOURCE_LIMIT',
      'Distinct grid geometry is indistinguishable at the allocated resolution',
      { component: 'representation' },
    )
  const sourceKeys = new Set(view.grid.cells.map((cell) => key(cell.region)))
  const mappedKeys = new Set(mapped.map((rect) => key(rect)))
  if (sourceKeys.size !== mappedKeys.size)
    throw new ClassifierError(
      'RESOURCE_LIMIT',
      'Distinct grid geometry collapses at the allocated resolution',
      {
        component: 'representation',
      },
    )
}

async function cleanPixels(
  source: RasterImage,
  sourcePixels: Uint8Array,
  view: RepresentationView,
  signal: AbortSignal,
): Promise<TextPixelView> {
  const region = view.sourceRegion
  if (!isContained({ left: 0, top: 0, width: source.width, height: source.height }, region))
    throw new ClassifierError(
      'INVALID_INPUT',
      'Representation view lies outside the oriented source',
    )
  const size = dimensions(region)
  assertGridGeometry(view, size.width, size.height)
  const raw = Buffer.from(sourcePixels)
  const pipeline = sharp(raw, {
    raw: { width: source.width, height: source.height, channels: 4 },
    limitInputPixels: limits.imagePixels,
  })
    .extract(region)
    .resize(size.width, size.height, { kernel: 'nearest' })
    .raw()
  try {
    const result = await pipeline.toBuffer({ resolveWithObject: true })
    assertActive(signal)
    if (result.info.channels !== 4 || result.data.byteLength !== size.width * size.height * 4)
      throw new ClassifierError(
        'INVALID_RESPONSE',
        'Sharp returned an invalid canonical pixel view',
      )
    return {
      id: view.id,
      role: view.role,
      sourceRegion: region,
      width: size.width,
      height: size.height,
      data: result.data,
      ...(view.grid ? { grid: view.grid } : {}),
    }
  } finally {
    pipeline.destroy()
  }
}

/**
 * Build request-wide text representations from clean canonical pixels. The injected encoder
 * is intentionally internal so research codecs do not become public package exports.
 */
export function createTextRepresentation(
  encoder: TextRepresentationEncoder,
): ImageRepresentationPort {
  return {
    async prepare(input) {
      assertActive(input.signal)
      if (input.views.length > representationLimits.maxViews)
        throw new ClassifierError(
          'RESOURCE_LIMIT',
          'A representation request may contain at most nine views',
          {
            component: 'representation',
          },
        )
      const decoded = await readCanonicalPixels(input.source, input.signal)
      const unique = new Map<string, RepresentationView>()
      for (const view of input.views) {
        const regionKey = key(view.sourceRegion)
        const prior = unique.get(regionKey)
        if (prior?.grid && view.grid && gridKey(prior) !== gridKey(view))
          throw new ClassifierError(
            'INVALID_INPUT',
            'Duplicate grid regions have inconsistent metadata',
          )
        if (!prior) unique.set(regionKey, view)
        else if (!prior.grid && view.grid) unique.set(regionKey, { ...prior, grid: view.grid })
      }
      const allocated = [...unique.values()].map((view) => ({
        view,
        ...dimensions(view.sourceRegion),
      }))
      const pixelViews: TextPixelView[] = []
      for (const item of allocated)
        pixelViews.push(await cleanPixels(input.source, decoded.data, item.view, input.signal))
      const encoded: string[] = []
      const metadata: RepresentationMetadata = { profile: encoder.profile, bytes: 0, views: [] }
      for (const view of pixelViews) {
        assertActive(input.signal)
        let text: string
        try {
          text = await encoder.encode(view, input.signal)
        } catch (error) {
          if (error instanceof ClassifierError && error.code === 'RESOURCE_LIMIT')
            throw new ClassifierError(error.code, error.message, {
              ...error.details,
              component: 'representation',
            })
          throw error
        }
        const bytes = Buffer.byteLength(text, 'utf8')
        if (text.length > representationLimits.partCharacters)
          throw new ClassifierError(
            'RESOURCE_LIMIT',
            'Encoded view exceeds the UTF-16 character limit',
            {
              component: 'representation',
            },
          )
        if (metadata.bytes + bytes > representationLimits.totalBytes)
          throw new ClassifierError(
            'RESOURCE_LIMIT',
            'Encoded request exceeds the aggregate UTF-8 byte limit',
            {
              component: 'representation',
            },
          )
        metadata.bytes += bytes
        encoded.push(text)
        metadata.views.push({
          id: view.id,
          sourceRegion: view.sourceRegion,
          width: view.width,
          height: view.height,
          scaleX: view.width / view.sourceRegion.width,
          scaleY: view.height / view.sourceRegion.height,
          content: { left: 0, top: 0, width: view.width, height: view.height },
        })
      }
      return { state: encoded, metadata }
    },
  }
}
