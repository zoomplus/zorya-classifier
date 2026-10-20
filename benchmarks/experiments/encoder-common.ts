import { ClassifierError } from '../../src/entities/errors.js'
import type { TextPixelView } from '../../src/infrastructure/text-representation.js'

export function assertPixelView(view: TextPixelView): void {
  if (
    !Number.isSafeInteger(view.width) ||
    !Number.isSafeInteger(view.height) ||
    view.width < 1 ||
    view.height < 1 ||
    view.width > 64 ||
    view.height > 64 ||
    view.data.byteLength !== view.width * view.height * 4
  )
    throw new ClassifierError(
      'INVALID_INPUT',
      'Encoder expects canonical RGBA8 pixels up to 64 by 64',
    )
}

export function utf8Size(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function rgbaAt(data: Uint8Array, pixel: number): [number, number, number, number] {
  const offset = pixel * 4
  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, data[offset + 3] ?? 0]
}

export function hexRgba(color: readonly number[]): string {
  return color.map((value) => value.toString(16).padStart(2, '0').toUpperCase()).join('')
}

export function luma(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
}
