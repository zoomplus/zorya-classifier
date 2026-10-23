import type { TextRepresentationEncoder } from './text-representation.js'
import { asciiContoursV1Encoder } from './ascii-contours-v1.js'
import { asciiLumaV1Encoder } from './ascii-luma-v1.js'
import { asciiSvgLayeredV1Encoder } from './ascii-svg-layered-v1.js'
import { paletteGridV1Encoder } from './palette-grid-v1.js'
import { pixelRleV1Encoder } from './pixel-rle-v1.js'
import { svgContoursV1Encoder } from './svg-contours-v1.js'

/** Research-only registry; public package exports deliberately do not import this module. */
export const textEncodersV1: Readonly<Record<string, TextRepresentationEncoder>> = Object.freeze({
  'ascii-luma-v1': asciiLumaV1Encoder,
  'palette-grid-v1': paletteGridV1Encoder,
  'svg-contours-v1': svgContoursV1Encoder,
  'pixel-rle-v1': pixelRleV1Encoder,
  'ascii-contours-v1': asciiContoursV1Encoder,
  'ascii-svg-layered-v1': asciiSvgLayeredV1Encoder,
})
