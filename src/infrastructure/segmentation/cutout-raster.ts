import sharp from 'sharp'

import { ClassifierError, assertActive } from '../../entities/errors.js'
import type { CutoutRasterPort } from '../../entities/cutout-raster.js'
import type { RasterImage } from '../../entities/contracts.js'
import type { RgbaRaster } from '../../entities/representation.js'

const maxPixels = 16_777_216

/** Sharp-backed decoder/encoder isolated behind the extraction raster port. */
export function createSharpCutoutRaster(): CutoutRasterPort {
  return {
    async rgba(image: RasterImage, signal: AbortSignal): Promise<RgbaRaster> {
      assertActive(signal)
      validateRasterImage(image)
      const pipeline = sharp(image.bytes, { limitInputPixels: maxPixels, failOn: 'error' })
      try {
        const output = await pipeline
          .toColourspace('srgb')
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        assertActive(signal)
        if (
          output.info.width !== image.width ||
          output.info.height !== image.height ||
          output.info.channels !== 4 ||
          output.data.length !== image.width * image.height * 4
        )
          throw new ClassifierError(
            'INVALID_RESPONSE',
            'Cutout raster decoder returned invalid canonical RGBA pixels',
          )
        return {
          data: new Uint8Array(output.data),
          width: image.width,
          height: image.height,
          format: 'rgba8',
        }
      } catch (error) {
        if (error instanceof ClassifierError) throw error
        throw new ClassifierError('INVALID_RESPONSE', 'Cutout raster decoder failed')
      } finally {
        pipeline.destroy()
      }
    },

    async png(image: RgbaRaster, signal: AbortSignal): Promise<Uint8Array> {
      assertActive(signal)
      validateRgbaRaster(image)
      const pipeline = sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 4 },
      })
      try {
        const png = await pipeline.png().toBuffer()
        assertActive(signal)
        return new Uint8Array(png)
      } catch (error) {
        if (error instanceof ClassifierError) throw error
        throw new ClassifierError('PROVIDER', 'Cutout PNG encoder failed')
      } finally {
        pipeline.destroy()
      }
    },
  }
}

function validateRasterImage(image: RasterImage): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > maxPixels ||
    image.bytes.byteLength < 1
  )
    throw new ClassifierError('INVALID_RESPONSE', 'Raster normalizer returned invalid source data')
}

function validateRgbaRaster(image: RgbaRaster): void {
  if (
    image.format !== 'rgba8' ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > maxPixels ||
    image.data.length !== image.width * image.height * 4
  )
    throw new ClassifierError(
      'INVALID_RESPONSE',
      'Extraction returned invalid canonical RGBA pixels',
    )
}
