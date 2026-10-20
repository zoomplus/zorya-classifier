import sharp from 'sharp'

import { ClassifierError, assertActive } from '../../entities/errors.js'
import type { PixelRect } from '../../entities/contracts.js'
import type {
  ObjectProposalPresentationPort,
  PackedBinaryMask,
  PresentedObjectProposal,
} from '../../entities/object-proposals.js'
import { objectProposalLimits } from '../../entities/object-proposals.js'
import type { RgbaRaster } from '../../entities/representation.js'
import { unpackBinaryMask } from '../../features/segmentation/packed-mask.js'

const columns = 4
const rows = 3
const tileWidth = 300
const tileHeight = 240
const sheetWidth = columns * tileWidth
const sheetHeight = rows * tileHeight
const previewWidth = 142
const previewHeight = 200
const previewTop = 28
const previewLeft = 4

type ProposalSnapshot = {
  id: string
  data: Uint8Array
  region: PixelRect | null
  bounds: PixelRect | null
}

/** Generic, bounded rendering for already-validated object mask aliases. */
export function createSharpObjectProposalPresentation(): ObjectProposalPresentationPort {
  return {
    async render(input) {
      const signal = input.signal
      assertSignal(signal)
      const callerImage = input.image
      assertImage(callerImage)
      const callerSeedRegion = input.seedRegion
      assertRect(callerSeedRegion, callerImage.width, callerImage.height, 'seedRegion')
      const image: RgbaRaster = {
        data: new Uint8Array(callerImage.data),
        width: callerImage.width,
        height: callerImage.height,
        format: callerImage.format,
      }
      const seedRegion = { ...callerSeedRegion }
      const proposals = input.proposals
      if (
        !Array.isArray(proposals) ||
        proposals.length < 1 ||
        proposals.length > objectProposalLimits.candidates
      )
        throw invalid('Expected 1..36 object proposals')

      // Own every buffer synchronously, before the first Sharp await.
      const source = image.data
      let previousAlias = -1
      for (const proposal of proposals) {
        const match = typeof proposal.id === 'string' ? /^C(\d{2})$/.exec(proposal.id) : null
        const alias = match ? Number(match[1]) : -1
        if (alias < 0 || alias >= objectProposalLimits.candidates || alias <= previousAlias)
          throw invalid('Proposal aliases must be unique and retain source order')
        previousAlias = alias
      }
      const snapshots = proposals.map((proposal) => snapshotProposal(proposal, image))
      if (
        snapshots.reduce((sum, item) => sum + item.data.byteLength, 0) >
        objectProposalLimits.packedBytes
      )
        throw invalid('Packed proposal data exceeds the byte limit')
      assertActive(signal)

      const output: Uint8Array[] = []
      let totalBytes = 0
      const pushPng = (bytes: Buffer) => {
        assertActive(signal)
        if (bytes.byteLength > objectProposalLimits.presentationBytes)
          throw invalid('Proposal presentation image exceeds the byte limit')
        totalBytes += bytes.byteLength
        if (totalBytes > objectProposalLimits.presentationBytes)
          throw invalid('Proposal presentation exceeds the total byte limit')
        output.push(new Uint8Array(bytes))
      }

      const seedSvg = Buffer.from(
        `<svg width="${image.width}" height="${image.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${seedRegion.left}" y="${seedRegion.top}" width="${seedRegion.width}" height="${seedRegion.height}" fill="none" stroke="#1677ff" stroke-width="2"/></svg>`,
      )
      const seedPng = await encode(
        sharp(source, {
          raw: { width: image.width, height: image.height, channels: 4 },
          limitInputPixels: objectProposalLimits.imagePixels,
        })
          .composite([{ input: seedSvg }])
          .png({ compressionLevel: 6 }),
        signal,
      )
      pushPng(seedPng)

      const sourcePreview = await encode(
        sharp(source, {
          raw: { width: image.width, height: image.height, channels: 4 },
          limitInputPixels: objectProposalLimits.imagePixels,
        })
          .resize(previewWidth, previewHeight, {
            fit: 'contain',
            background: { r: 20, g: 24, b: 32, alpha: 1 },
          })
          .png(),
        signal,
      )

      const sheetCount = Math.ceil(snapshots.length / 12)
      for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
        assertActive(signal)
        const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4, 0)
        const layers: sharp.OverlayOptions[] = []
        const countOnSheet = Math.min(12, snapshots.length - sheetIndex * 12)
        for (let position = 0; position < countOnSheet; position++) {
          const proposal = snapshots[sheetIndex * 12 + position]
          if (!proposal) throw invalid('Proposal list changed during presentation')
          assertActive(signal)
          const tileX = (position % columns) * tileWidth
          const tileY = Math.floor(position / columns) * tileHeight
          const rectangle = proposal.bounds
            ? `RECT [${proposal.bounds.left}, ${proposal.bounds.top}, ${proposal.bounds.width}, ${proposal.bounds.height}]`
            : 'RECT empty'
          const title = svg(
            tileWidth,
            40,
            `<rect width="300" height="40" fill="#f2f4f7"/><text x="8" y="16" font-family="sans-serif" font-size="14" fill="#111">${proposal.id}</text><text x="8" y="33" font-family="sans-serif" font-size="12" fill="#111">${rectangle}</text>`,
          )
          layers.push({ input: title, left: tileX, top: tileY })

          const raster = unpackBinaryMask({
            data: proposal.data,
            width: image.width,
            height: image.height,
            format: 'binary-lsb0',
          })
          const bounds = proposal.bounds

          if (bounds !== null) {
            const maskOverlay = makeOverlay(source, raster, image.width, image.height, bounds)
            const overlayPreview = await encode(
              sharp(maskOverlay, {
                raw: { width: image.width, height: image.height, channels: 4 },
                limitInputPixels: objectProposalLimits.imagePixels,
              })
                .resize(previewWidth, previewHeight, {
                  fit: 'contain',
                  background: { r: 20, g: 24, b: 32, alpha: 1 },
                })
                .png(),
              signal,
            )
            assertActive(signal)
            layers.push({
              input: sourcePreview,
              left: tileX + previewLeft,
              top: tileY + previewTop + 12,
            })
            layers.push({
              input: overlayPreview,
              left: tileX + previewLeft,
              top: tileY + previewTop + 12,
            })

            const cutout = makeCutout(source, raster, image.width, image.height, bounds)
            const cutoutPng = await encode(
              sharp(cutout.data, {
                raw: { width: cutout.width, height: cutout.height, channels: 4 },
              })
                .resize(previewWidth, previewHeight, {
                  fit: 'contain',
                  background: { r: 20, g: 24, b: 32, alpha: 0 },
                })
                .png(),
              signal,
            )
            assertActive(signal)
            layers.push({
              input: cutoutPng,
              left: tileX + previewLeft + previewWidth + 8,
              top: tileY + previewTop + 12,
            })
          } else {
            layers.push({
              input: sourcePreview,
              left: tileX + previewLeft,
              top: tileY + previewTop + 12,
            })
            layers.push({
              input: svg(
                previewWidth,
                previewHeight,
                '<rect width="142" height="200" fill="#f2f4f7"/><text x="71" y="104" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#555">empty</text>',
              ),
              left: tileX + previewLeft + previewWidth + 8,
              top: tileY + previewTop,
            })
          }
        }
        const sheetPng = await encode(
          sharp(sheet, {
            raw: { width: sheetWidth, height: sheetHeight, channels: 4 },
          })
            .composite(layers)
            .png({ compressionLevel: 6 }),
          signal,
        )
        pushPng(sheetPng)
      }
      if (
        output.length !== sheetCount + 1 ||
        output.length > objectProposalLimits.presentationImages
      )
        throw invalid('Proposal presentation returned an invalid image count')
      return output
    },
  }
}

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw invalid('signal must be an AbortSignal')
  assertActive(signal)
}

function assertImage(image: RgbaRaster): void {
  if (
    image.format !== 'rgba8' ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > objectProposalLimits.imagePixels ||
    image.data.length !== image.width * image.height * 4
  )
    throw invalid('Expected canonical RGBA image within proposal limits')
}

function assertRect(rect: PixelRect, width: number, height: number, name: string): void {
  if (
    !rect ||
    !Number.isSafeInteger(rect.left) ||
    !Number.isSafeInteger(rect.top) ||
    !Number.isSafeInteger(rect.width) ||
    !Number.isSafeInteger(rect.height) ||
    rect.left < 0 ||
    rect.top < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.left + rect.width > width ||
    rect.top + rect.height > height
  )
    throw invalid(`${name} is outside the source image`)
}

function snapshotProposal(proposal: PresentedObjectProposal, image: RgbaRaster): ProposalSnapshot {
  const id = proposal.id
  const mask: PackedBinaryMask = proposal.mask
  const expectedBytes = Math.ceil((image.width * image.height) / 8)
  if (
    !/^C(?:0[0-9]|[12][0-9]|3[0-5])$/.test(id) ||
    !mask ||
    mask.format !== 'binary-lsb0' ||
    mask.width !== image.width ||
    mask.height !== image.height ||
    !(mask.data instanceof Uint8Array) ||
    mask.data.byteLength !== expectedBytes
  )
    throw invalid('Object proposal aliases or packed mask dimensions are invalid')
  const data = new Uint8Array(mask.data)
  const decoded = unpackBinaryMask({
    data,
    width: image.width,
    height: image.height,
    format: 'binary-lsb0',
  })
  const bounds = maskBounds(decoded, image.width, image.height)
  if (bounds === null) {
    if (proposal.region !== null) throw invalid('Empty proposal must have a null pixel region')
  } else if (proposal.region !== null) {
    assertRect(proposal.region, image.width, image.height, 'proposal region')
    if (
      proposal.region.left !== bounds.left ||
      proposal.region.top !== bounds.top ||
      proposal.region.width !== bounds.width ||
      proposal.region.height !== bounds.height
    )
      throw invalid('Proposal region does not match packed mask support')
  }
  return {
    id,
    data,
    region: bounds ? { ...bounds } : null,
    bounds: bounds ? { ...bounds } : null,
  }
}

function maskBounds(mask: Uint8Array, width: number, height: number): PixelRect | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right < left || bottom < top
    ? null
    : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function makeOverlay(
  source: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  bounds: PixelRect | null,
): Uint8Array {
  const output = new Uint8Array(source.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const offset = index * 4
      output[offset] = source[offset]!
      output[offset + 1] = source[offset + 1]!
      output[offset + 2] = source[offset + 2]!
      output[offset + 3] = source[offset + 3]!
      if (mask[index] === 0) continue
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        mask[index - 1] === 0 ||
        mask[index + 1] === 0 ||
        mask[index - width] === 0 ||
        mask[index + width] === 0
      if (edge) {
        output[offset] = 0
        output[offset + 1] = 255
        output[offset + 2] = 255
        output[offset + 3] = 255
      } else {
        output[offset] = Math.round(source[offset]! * 0.65 + 255 * 0.35)
        output[offset + 1] = Math.round(source[offset + 1]! * 0.65 + 32 * 0.35)
        output[offset + 2] = Math.round(source[offset + 2]! * 0.65 + 32 * 0.35)
      }
    }
  }
  if (bounds !== null) {
    const right = bounds.left + bounds.width - 1
    const bottom = bounds.top + bounds.height - 1
    for (let x = bounds.left; x <= right; x++) {
      paintRectanglePixel(output, width, x, bounds.top)
      paintRectanglePixel(output, width, x, bottom)
    }
    for (let y = bounds.top; y <= bottom; y++) {
      paintRectanglePixel(output, width, bounds.left, y)
      paintRectanglePixel(output, width, right, y)
    }
  }
  return output
}

function paintRectanglePixel(output: Uint8Array, width: number, x: number, y: number): void {
  const offset = (y * width + x) * 4
  output[offset] = 255
  output[offset + 1] = 220
  output[offset + 2] = 0
  output[offset + 3] = 255
}

function makeCutout(
  source: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  bounds: PixelRect,
): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(bounds.width * bounds.height * 4)
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const sourceIndex = (bounds.top + y) * width + bounds.left + x
      const outputIndex = (y * bounds.width + x) * 4
      if (mask[sourceIndex] === 0) continue
      data[outputIndex] = source[sourceIndex * 4]!
      data[outputIndex + 1] = source[sourceIndex * 4 + 1]!
      data[outputIndex + 2] = source[sourceIndex * 4 + 2]!
      data[outputIndex + 3] = source[sourceIndex * 4 + 3]!
    }
  }
  return { data, width: bounds.width, height: bounds.height }
}

function svg(width: number, height: number, body: string): Buffer {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
  )
}

async function encode(pipeline: ReturnType<typeof sharp>, signal: AbortSignal): Promise<Buffer> {
  try {
    const bytes = await pipeline.toBuffer()
    assertActive(signal)
    return bytes
  } catch (error) {
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError('PROVIDER', 'Object proposal presentation failed')
  } finally {
    pipeline.destroy()
  }
}

function invalid(message: string): ClassifierError {
  return new ClassifierError('INVALID_RESPONSE', message)
}
