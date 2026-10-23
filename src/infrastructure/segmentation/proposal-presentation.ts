import sharp from 'sharp'

import { ClassifierError, assertActive } from '../../entities/errors.js'
import type { ObjectProposalPresentationPort } from '../../entities/object-proposals.js'
import { objectProposalLimits } from '../../entities/object-proposals.js'
import { unpackBinaryMask } from '../../features/segmentation/packed-mask.js'
import {
  assertProposalSignal,
  proposalInvalid,
  snapshotOwnedPresentationInput,
} from './proposal-presentation-input.js'
import { makeCutout, makeOverlay } from './proposal-presentation-pixels.js'

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

/** Generic, bounded rendering for already-validated object mask aliases. */
export function createSharpObjectProposalPresentation(): ObjectProposalPresentationPort {
  return {
    async render(input) {
      const signal = input.signal
      assertProposalSignal(signal)
      const { source, image, seedRegion, snapshots } = snapshotOwnedPresentationInput(input)
      assertActive(signal)

      const output: Uint8Array[] = []
      let totalBytes = 0
      const pushPng = (bytes: Buffer) => {
        assertActive(signal)
        if (bytes.byteLength > objectProposalLimits.presentationBytes)
          throw proposalInvalid('Proposal presentation image exceeds the byte limit')
        totalBytes += bytes.byteLength
        if (totalBytes > objectProposalLimits.presentationBytes)
          throw proposalInvalid('Proposal presentation exceeds the total byte limit')
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

      if (snapshots.length === 1) {
        const proposal = snapshots[0]
        if (!proposal) throw proposalInvalid('Singleton proposal disappeared during presentation')
        const raster = unpackBinaryMask({
          data: proposal.data,
          width: image.width,
          height: image.height,
          format: 'binary-lsb0',
        })
        const overlay = makeOverlay(source, raster, image.width, image.height, proposal.bounds)
        const overlayPng = await encode(
          sharp(overlay, {
            raw: { width: image.width, height: image.height, channels: 4 },
            limitInputPixels: objectProposalLimits.imagePixels,
          }).png({ compressionLevel: 6 }),
          signal,
        )
        pushPng(overlayPng)
        if (output.length !== 2)
          throw proposalInvalid('Singleton presentation returned an invalid image count')
        return output
      }

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
          if (!proposal) throw proposalInvalid('Proposal list changed during presentation')
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
              top: tileY + previewTop + 12,
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
        throw proposalInvalid('Proposal presentation returned an invalid image count')
      return output
    },
  }
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
