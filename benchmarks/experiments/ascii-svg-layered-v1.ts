import { assertActive } from '../../src/entities/errors.js'
import type {
  TextPixelView,
  TextRepresentationEncoder,
} from '../../src/infrastructure/text-representation.js'
import { asciiContoursV1MaxEncodedBytes, encodeAsciiContoursV1 } from './ascii-contours-v1.js'
import { svgContoursV1MaxEncodedBytes, encodeSvgContoursV1 } from './svg-contours-v1.js'
import { utf8Size } from './encoder-common.js'

const header = 'ASCII_SVG_LAYERED_V1'

export function encodeAsciiSvgLayeredV1(view: TextPixelView): string {
  const ascii = encodeAsciiContoursV1(view)
  const svg = encodeSvgContoursV1(view)
  return `${header}\nwidth=${view.width} height=${view.height}\nascii:\n${ascii}\nsvg:\n${svg}`
}

export function asciiSvgLayeredV1MaxEncodedBytes(width: number, height: number): number {
  return (
    utf8Size(`${header}\nwidth=${width} height=${height}\nascii:\n`) +
    asciiContoursV1MaxEncodedBytes(width, height) +
    utf8Size('\nsvg:\n') +
    svgContoursV1MaxEncodedBytes(width, height)
  )
}

export const asciiSvgLayeredV1Encoder: TextRepresentationEncoder = {
  profile: 'ascii-svg-layered-v1',
  maxEncodedBytes: asciiSvgLayeredV1MaxEncodedBytes,
  async encode(view, signal) {
    assertActive(signal)
    return encodeAsciiSvgLayeredV1(view)
  },
}
