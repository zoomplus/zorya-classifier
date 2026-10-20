import sharp from 'sharp'
import type { DecisionState, PixelRect, RasterImage } from '../entities/contracts.js'
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
  /** Hard UTF-8 upper bound for one encoded view at these dimensions. */
  maxEncodedBytes(width: number, height: number): number
  encode(view: TextPixelView, signal: AbortSignal): Promise<string>
}

interface ViewAlias {
  id: string
  role: RepresentationView['role']
  sourceRegion: PixelRect
  grid?: RepresentationView['grid']
}

interface ViewGroup {
  sourceRegion: PixelRect
  aliases: ViewAlias[]
  primary: RepresentationView
}

interface PlannedView {
  group: ViewGroup
  width: number
  height: number
  metadataText: string
  maxEncodedBytes: number
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

function dimensions(region: PixelRect, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(region.width, region.height))
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
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<TextPixelView> {
  const region = view.sourceRegion
  if (!isContained({ left: 0, top: 0, width: source.width, height: source.height }, region))
    throw new ClassifierError(
      'INVALID_INPUT',
      'Representation view lies outside the oriented source',
    )
  const raw = Buffer.from(sourcePixels.buffer, sourcePixels.byteOffset, sourcePixels.byteLength)
  const pipeline = sharp(raw, {
    raw: { width: source.width, height: source.height, channels: 4 },
    limitInputPixels: limits.imagePixels,
  })
    .extract(region)
    .resize(width, height, { kernel: 'nearest' })
    .raw()
  try {
    const result = await pipeline.toBuffer({ resolveWithObject: true })
    assertActive(signal)
    if (result.info.channels !== 4 || result.data.byteLength !== width * height * 4)
      throw new ClassifierError(
        'INVALID_RESPONSE',
        'Sharp returned an invalid canonical pixel view',
      )
    return {
      id: view.id,
      role: view.role,
      sourceRegion: region,
      width,
      height,
      data: result.data,
      ...(view.grid ? { grid: view.grid } : {}),
    }
  } finally {
    pipeline.destroy()
  }
}

function aliasesFor(view: RepresentationView): ViewAlias {
  return {
    id: view.id,
    role: view.role,
    sourceRegion: view.sourceRegion,
    ...(view.grid ? { grid: view.grid } : {}),
  }
}

function gridMetadata(grid: RepresentationView['grid']):
  | {
      cells: {
        id: string
        column: number
        row: number
        region: PixelRect
        label: string | null
      }[]
    }
  | undefined {
  if (!grid) return undefined
  return {
    cells: grid.cells.map((cell) => ({
      id: cell.id,
      column: cell.column,
      row: cell.row,
      region: cell.region,
      label: grid.labels.get(cell.id) ?? null,
    })),
  }
}

function makePlan(
  groups: readonly ViewGroup[],
  maxSide: number,
  encoder: TextRepresentationEncoder,
): PlannedView[] | undefined {
  const plan: PlannedView[] = []
  let totalBytes = 0
  for (const group of groups) {
    const size = dimensions(group.sourceRegion, maxSide)
    const metadataText = JSON.stringify({
      representationView: {
        id: group.aliases[0]?.id ?? group.primary.id,
        aliases: group.aliases.map((alias) => ({
          id: alias.id,
          role: alias.role,
          sourceRegion: alias.sourceRegion,
          ...(alias.grid ? { grid: gridMetadata(alias.grid) } : {}),
        })),
        sourceRegion: group.sourceRegion,
        dimensions: size,
        scaleX: size.width / group.sourceRegion.width,
        scaleY: size.height / group.sourceRegion.height,
        grid: group.aliases.flatMap((alias) => {
          const value = gridMetadata(alias.grid)
          return value === undefined ? [] : [{ viewId: alias.id, cells: value.cells }]
        }),
      },
    })
    const bound = encoder.maxEncodedBytes(size.width, size.height)
    const metadataBytes = Buffer.byteLength(metadataText, 'utf8')
    if (
      !Number.isSafeInteger(bound) ||
      bound < 0 ||
      bound > representationLimits.partCharacters ||
      metadataText.length > representationLimits.partCharacters
    )
      return undefined
    totalBytes += metadataBytes + bound
    plan.push({ group, ...size, metadataText, maxEncodedBytes: bound })
  }
  return totalBytes <= representationLimits.totalBytes ? plan : undefined
}

function buildGroups(views: readonly RepresentationView[]): ViewGroup[] {
  const groups = new Map<string, ViewGroup>()
  for (const view of views) {
    const regionKey = key(view.sourceRegion)
    const prior = groups.get(regionKey)
    if (!prior) {
      groups.set(regionKey, {
        sourceRegion: view.sourceRegion,
        primary: view,
        aliases: [aliasesFor(view)],
      })
    } else {
      prior.aliases.push(aliasesFor(view))
    }
  }
  return [...groups.values()]
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
      const groups = buildGroups(input.views)
      for (const group of groups) {
        if (
          !isContained(
            { left: 0, top: 0, width: input.source.width, height: input.source.height },
            group.sourceRegion,
          )
        )
          throw new ClassifierError(
            'INVALID_INPUT',
            'Representation view lies outside the oriented source',
          )
      }
      let plan: PlannedView[] | undefined
      for (let side = representationLimits.maxSide; side >= 1 && plan === undefined; side -= 1)
        plan = makePlan(groups, side, encoder)
      if (!plan)
        throw new ClassifierError(
          'RESOURCE_LIMIT',
          'No bounded text representation allocation fits the request',
          {
            component: 'representation',
          },
        )
      for (const item of plan)
        for (const alias of item.group.aliases)
          if (alias.grid)
            assertGridGeometry(
              { ...item.group.primary, sourceRegion: item.group.sourceRegion, grid: alias.grid },
              item.width,
              item.height,
            )

      const decoded = await readCanonicalPixels(input.source, input.signal)
      const pixelViews: TextPixelView[] = []
      for (const item of plan)
        pixelViews.push(
          await cleanPixels(
            input.source,
            decoded.data,
            item.group.primary,
            item.width,
            item.height,
            input.signal,
          ),
        )
      const state: DecisionState = []
      const metadata: RepresentationMetadata = { profile: encoder.profile, bytes: 0, views: [] }
      for (let index = 0; index < pixelViews.length; index += 1) {
        const view = pixelViews[index]
        const allocation = plan[index]
        if (!view || !allocation)
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Text representation allocation was incomplete',
          )
        assertActive(input.signal)
        state.push(allocation.metadataText)
        metadata.bytes += Buffer.byteLength(allocation.metadataText, 'utf8')
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
        if (text.length > representationLimits.partCharacters || bytes > allocation.maxEncodedBytes)
          throw new ClassifierError(
            'RESOURCE_LIMIT',
            'Encoder output exceeds its declared per-view bound',
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
        state.push(text)
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
      return { state, metadata }
    },
  }
}
