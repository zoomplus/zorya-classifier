import sharp from 'sharp'
import { createHash } from 'node:crypto'
import type {
  ChoiceSelection,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  PixelRect,
  RasterPort,
  RasterImage,
} from '../../src/entities/contracts.js'
import { limits } from '../../src/entities/contracts.js'
import { assertActive, ClassifierError } from '../../src/entities/errors.js'
import { selection, validateDecision } from '../../src/features/choice.js'
import type { BinaryMask } from '../../src/entities/segmentation.js'

export interface GroundedMaskCandidate {
  alias: string
  mask: BinaryMask
  box: PixelRect
}

export interface GroundedMaskSelectorInput {
  image: RasterImage
  target: string
  exclusions?: readonly string[]
  candidates: readonly GroundedMaskCandidate[]
  signal: AbortSignal
}

export interface GroundedMaskSelectorOptions {
  decision: DecisionPort
  imageState: RasterPort['imageState']
}

export interface GroundedMaskSelection {
  alias: string
  candidate: GroundedMaskCandidate | null
  selection: ChoiceSelection
  metadata: DecisionResult['metadata']
  requestSha256: string
  preparedImageCount: number
  candidateTransforms: Array<{ alias: string; crop: PixelRect }>
  presentationMs: number
}

const tileWidth = 384
const tileHeight = 284
const viewWidth = 180
const viewHeight = 258
const aliases = /^C(?:0[0-9]|[12][0-9]|3[0-5])$/u
const criteria = (candidateAliases: readonly string[]) =>
  Object.fromEntries([
    ...candidateAliases.map(
      (alias) =>
        [
          alias,
          `The ${alias} candidate shows the whole visible requested target instance, with its cyan mask overlay limited to the visible instance rather than fragments or other objects.`,
        ] as const,
    ),
    ['none', 'None of the supplied candidates shows the whole visible requested target instance.'],
  ])

function foregroundBox(mask: BinaryMask): PixelRect | undefined {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const value = mask.data[y * mask.width + x]
      if (value !== 0 && value !== 1) throw new TypeError('Candidate mask pixels must be binary')
      if (!value) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return right < left ? undefined : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function paddedCrop(box: PixelRect, width: number, height: number): PixelRect {
  const padX = Math.ceil(box.width * 0.25)
  const padY = Math.ceil(box.height * 0.25)
  const left = Math.max(0, box.left - padX)
  const top = Math.max(0, box.top - padY)
  const right = Math.min(width, box.left + box.width + padX)
  const bottom = Math.min(height, box.top + box.height + padY)
  return { left, top, width: right - left, height: bottom - top }
}

async function renderTile(
  image: RasterImage,
  candidate: GroundedMaskCandidate,
  crop: PixelRect,
  signal: AbortSignal,
): Promise<Buffer> {
  assertActive(signal)
  const scale = Math.min(viewWidth / crop.width, viewHeight / crop.height)
  const width = Math.max(1, Math.floor(crop.width * scale))
  const height = Math.max(1, Math.floor(crop.height * scale))
  const cleanLeft = 6
  const overlayLeft = tileWidth - width - 6
  const top = 20 + Math.floor((viewHeight - height) / 2)
  const cropImage = await sharp(image.bytes, { limitInputPixels: limits.imagePixels })
    .extract(crop)
    .resize(width, height, { kernel: 'lanczos3' })
    .png()
    .toBuffer()
  assertActive(signal)
  const rawOverlay = await sharp(image.bytes, { limitInputPixels: limits.imagePixels })
    .extract(crop)
    .resize(width, height, { kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  assertActive(signal)
  const maskCrop = Buffer.alloc(width * height * 4)
  const sx = crop.width / width
  const sy = crop.height / height
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(crop.width - 1, Math.floor((x + 0.5) * sx)) + crop.left
      const sourceY = Math.min(crop.height - 1, Math.floor((y + 0.5) * sy)) + crop.top
      if (candidate.mask.data[sourceY * candidate.mask.width + sourceX] !== 1) continue
      const index = (y * width + x) * 4
      maskCrop[index] = 0
      maskCrop[index + 1] = 255
      maskCrop[index + 2] = 255
      maskCrop[index + 3] = 92
    }
  }
  const overlaid = await sharp(rawOverlay.data, {
    raw: { width, height, channels: 4 },
  })
    .composite([{ input: maskCrop, raw: { width, height, channels: 4 } }])
    .png()
    .toBuffer()
  assertActive(signal)
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${tileHeight}"><rect x="0" y="0" width="${tileWidth}" height="18" fill="#111827"/><text x="8" y="14" font-family="DejaVu Sans,sans-serif" font-size="12" fill="white">${candidate.alias}: context / cyan mask overlay</text><rect x="${cleanLeft}" y="${top}" width="${width}" height="${height}" fill="none" stroke="#64748b"/><rect x="${overlayLeft}" y="${top}" width="${width}" height="${height}" fill="none" stroke="#64748b"/></svg>`,
  )
  const result = await sharp({
    create: {
      width: tileWidth,
      height: tileHeight,
      channels: 4,
      background: '#f8fafc',
    },
  })
    .composite([
      { input: cropImage, left: cleanLeft, top },
      { input: overlaid, left: overlayLeft, top },
      { input: label, left: 0, top: 0 },
    ])
    .png()
    .toBuffer()
  maskCrop.fill(0)
  rawOverlay.data.fill(0)
  cropImage.fill(0)
  overlaid.fill(0)
  assertActive(signal)
  return result
}

async function renderSheet(
  image: RasterImage,
  group: readonly GroundedMaskCandidate[],
  crops: ReadonlyMap<string, PixelRect>,
  signal: AbortSignal,
): Promise<RasterImage> {
  const composites: sharp.OverlayOptions[] = []
  for (let index = 0; index < group.length; index++) {
    const candidate = group[index]
    if (!candidate) continue
    const crop = crops.get(candidate.alias)
    if (!crop) throw new TypeError('Candidate crop transform is missing')
    const tile = await renderTile(image, candidate, crop, signal)
    composites.push({
      input: tile,
      left: (index % 3) * tileWidth,
      top: Math.floor(index / 3) * tileHeight,
    })
  }
  const sheet = await sharp({
    create: {
      width: tileWidth * 3,
      height: tileHeight * 2,
      channels: 4,
      background: '#e2e8f0',
    },
  })
    .composite(composites)
    .png()
    .toBuffer()
  assertActive(signal)
  return { bytes: new Uint8Array(sheet), width: tileWidth * 3, height: tileHeight * 2 }
}

export function createGroundedMaskSelector(options: GroundedMaskSelectorOptions): {
  select(input: GroundedMaskSelectorInput): Promise<GroundedMaskSelection>
} {
  if (
    !options ||
    typeof options.decision?.decide !== 'function' ||
    typeof options.imageState !== 'function'
  )
    throw new ClassifierError('INVALID_INPUT', 'Grounded mask selector requires caller-owned ports')
  return {
    async select(input) {
      const presentationStarted = performance.now()
      assertActive(input.signal)
      if (
        !input.image?.bytes ||
        input.image.bytes.byteLength > limits.imageBytes ||
        !Number.isSafeInteger(input.image.width) ||
        !Number.isSafeInteger(input.image.height) ||
        input.image.width * input.image.height > limits.imagePixels ||
        input.candidates.length > 36 ||
        input.target.trim().length < 1 ||
        input.target.length > 200 ||
        (input.exclusions?.length ?? 0) > 16
      )
        throw new ClassifierError('INVALID_INPUT', 'Invalid grounded mask selection input')
      // Snapshot all caller-owned buffers synchronously, before image preparation yields.
      const image: RasterImage = { ...input.image, bytes: Uint8Array.from(input.image.bytes) }
      const candidates: GroundedMaskCandidate[] = input.candidates.map((candidate) => ({
        alias: candidate.alias,
        box: { ...candidate.box },
        mask: { ...candidate.mask, data: Uint8Array.from(candidate.mask.data) },
      }))
      const target = input.target
      const exclusions = [...(input.exclusions ?? [])]
      const aliasesInOrder = candidates.map((candidate) => candidate.alias)
      const crops = new Map<string, PixelRect>()
      try {
        if (
          new Set(aliasesInOrder).size !== aliasesInOrder.length ||
          aliasesInOrder.some((alias) => !aliases.test(alias))
        )
          throw new ClassifierError(
            'INVALID_INPUT',
            'Candidate aliases must be unique C00-C35 values',
          )
        for (const candidate of candidates) {
          if (
            candidate.mask.width !== image.width ||
            candidate.mask.height !== image.height ||
            candidate.mask.data.byteLength !== image.width * image.height ||
            candidate.mask.format !== 'binary-u8'
          )
            throw new ClassifierError(
              'INVALID_INPUT',
              'Candidate mask geometry does not match source',
            )
          const box = foregroundBox(candidate.mask)
          if (!box || JSON.stringify(box) !== JSON.stringify(candidate.box))
            throw new ClassifierError(
              'INVALID_INPUT',
              'Candidate mask box does not match mask pixels',
            )
          crops.set(candidate.alias, paddedCrop(box, image.width, image.height))
        }
      } catch (error) {
        image.bytes.fill(0)
        for (const candidate of candidates) candidate.mask.data.fill(0)
        throw error
      }
      let selectedCopy: GroundedMaskCandidate | null = null
      try {
        const state = await options.imageState(image, input.signal)
        assertActive(input.signal)
        const images: RasterImage[] = []
        const transforms: Array<{ alias: string; crop: PixelRect }> = []
        for (const candidate of candidates) {
          const crop = crops.get(candidate.alias)
          if (crop) transforms.push({ alias: candidate.alias, crop: { ...crop } })
        }
        for (let offset = 0; offset < candidates.length; offset += 6) {
          assertActive(input.signal)
          const group = candidates.slice(offset, offset + 6)
          images.push(await renderSheet(image, group, crops, input.signal))
        }
        const request: DecisionRequest = {
          state: [
            `Requested target label: ${JSON.stringify(target)}.`,
            `Exclusion labels: ${JSON.stringify(exclusions)}.`,
            `Candidate crop transforms in full-source pixels: ${JSON.stringify(transforms.map(({ alias, crop }) => ({ alias, crop })))}`,
            'The first image is the unmodified full source. Each following fixed contact sheet shows only real candidate crops: unmodified context on the left and the same context with the candidate mask overlaid in cyan on the right. Labels are outside source pixels. Candidate aliases map to the corresponding visible tile. Select the candidate that contains the whole visible requested instance, excluding fragments, other objects, and background. Choose none if no candidate shows the whole instance. Do not infer or draw coordinates.',
            ...state,
            ...images.map((image) => ({
              type: 'image_url' as const,
              image_url: {
                url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
                detail: 'high' as const,
              },
            })),
          ],
          questions: {
            selection: {
              type: 'choice',
              rankingSize: 1,
              instructions:
                'Choose the single supplied candidate alias whose actual cyan mask is the whole visible requested target instance, or none. Return only one supplied answer.',
              criteria: criteria(aliasesInOrder),
            },
          },
        }
        const presentationMs = Math.max(0, performance.now() - presentationStarted)
        try {
          assertActive(input.signal)
          const raw = await options.decision.decide(request, input.signal)
          assertActive(input.signal)
          const checked = validateDecision(request, raw)
          const chosen = selection(checked, [...aliasesInOrder, 'none'], 1, 'selection')
          const alias = chosen.choice
          const picked =
            alias === 'none' ? undefined : candidates.find((item) => item.alias === alias)
          selectedCopy = picked
            ? {
                ...picked,
                box: { ...picked.box },
                mask: { ...picked.mask, data: Uint8Array.from(picked.mask.data) },
              }
            : null
          return {
            alias,
            candidate: selectedCopy,
            selection: chosen,
            metadata: { ...checked.metadata },
            requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
            preparedImageCount: images.length + 1,
            candidateTransforms: transforms,
            presentationMs,
          }
        } finally {
          for (const image of images) image.bytes.fill(0)
          image.bytes.fill(0)
          for (const candidate of candidates) candidate.mask.data.fill(0)
          for (const part of state) {
            if (typeof part !== 'string') {
              const match = /^data:image\/png;base64,(.*)$/u.exec(part.image_url.url)
              if (match?.[1]) Buffer.from(match[1], 'base64').fill(0)
            }
          }
        }
      } finally {
        for (const candidate of candidates) candidate.mask.data.fill(0)
        image.bytes.fill(0)
      }
    },
  }
}
