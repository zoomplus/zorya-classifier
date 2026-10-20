import { ClassifierError, assertActive } from '../../src/entities/errors.js'
import type {
  TextPixelView,
  TextRepresentationEncoder,
} from '../../src/infrastructure/text-representation.js'
import { assertPixelView, hexRgba, rgbaAt, utf8Size } from './encoder-common.js'

const header = 'SVG_CONTOURS_V1'
const maxContours = 512
const maxVertices = 2048

interface RectContour {
  x: number
  y: number
  width: number
  height: number
  rgba: [number, number, number, number]
  hex: string
}

function contourKey(x: number, width: number, hex: string): string {
  return `${x},${width},${hex}`
}

function collectContours(view: TextPixelView): RectContour[] {
  let active = new Map<string, RectContour>()
  const complete: RectContour[] = []
  for (let y = 0; y < view.height; y += 1) {
    const next = new Map<string, RectContour>()
    let x = 0
    while (x < view.width) {
      const rgba = rgbaAt(view.data, y * view.width + x)
      const hex = hexRgba(rgba)
      let end = x + 1
      while (end < view.width && hexRgba(rgbaAt(view.data, y * view.width + end)) === hex) end += 1
      const key = contourKey(x, end - x, hex)
      const prior = active.get(key)
      next.set(
        key,
        prior
          ? { ...prior, height: prior.height + 1 }
          : { x, y, width: end - x, height: 1, rgba, hex },
      )
      x = end
    }
    for (const [key, contour] of active) if (!next.has(key)) complete.push(contour)
    active = next
    if (complete.length + active.size > maxContours) throwContourLimit()
  }
  complete.push(...active.values())
  if (complete.length > maxContours || complete.length * 4 > maxVertices) throwContourLimit()
  return complete
}

function throwContourLimit(): never {
  throw new ClassifierError(
    'RESOURCE_LIMIT',
    'SVG contours exceed the 512 contour or 2048 vertex representation limit',
    { component: 'representation' },
  )
}

export function encodeSvgContoursV1(view: TextPixelView): string {
  assertPixelView(view)
  const contours = collectContours(view)
  const shapes = contours
    .map((shape) => {
      const redGreenBlue = shape.hex.slice(0, 6)
      const alpha = (shape.rgba[3] / 255).toString()
      return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="#${redGreenBlue}" fill-opacity="${alpha}"/>`
    })
    .join('')
  return `${header}\n<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="0 0 ${view.width} ${view.height}">${shapes}</svg>`
}

export function svgContoursV1MaxEncodedBytes(width: number, height: number): number {
  const maxShapes = Math.min(width * height, maxContours)
  return (
    utf8Size(
      `${header}\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`,
    ) +
    maxShapes * 96
  )
}

export const svgContoursV1Encoder: TextRepresentationEncoder = {
  profile: 'svg-contours-v1',
  maxEncodedBytes: svgContoursV1MaxEncodedBytes,
  async encode(view, signal) {
    assertActive(signal)
    return encodeSvgContoursV1(view)
  },
}
