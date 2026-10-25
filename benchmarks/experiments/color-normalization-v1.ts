import { gzipSync, gunzipSync } from 'node:zlib'
import {
  COLOR_NORMALIZATION_ACHROMATIC_SATURATION_BELOW,
  COLOR_NORMALIZATION_ACHROMATIC_WHITE_VALUE_AT_LEAST,
  COLOR_NORMALIZATION_BLACK_VALUE_BELOW,
  COLOR_NORMALIZATION_HUE_BINS,
  COLOR_NORMALIZATION_MAX_PIXELS,
} from '../v03/color-normalization-contract.js'

export const COMPONENT_MAP_MAGIC = Buffer.from('ZCNMAP1\0', 'ascii')
export const COMPONENT_MAP_PROFILE_CONTROL_RGB = 1 as const
export const COMPONENT_MAP_PROFILE_HSV12 = 2 as const

type ComponentMapProfileKind =
  | typeof COMPONENT_MAP_PROFILE_CONTROL_RGB
  | typeof COMPONENT_MAP_PROFILE_HSV12

interface CanonicalRgbaView {
  data: Uint8Array
  width: number
  height: number
}

interface ProfileImageStats {
  distinctCanonicalColors: number
  componentCount: number
  adjacentDifferingColorEdges: number
  changedAdjacentEdgesVsSourceRgb: number
  sourcePixels: number
}

interface ProcessedColorNormalizationImage {
  normalizedRgba: Uint8Array
  controlComponentIds: Uint32Array
  hsv12ComponentIds: Uint32Array
  stats: {
    controlRgb: ProfileImageStats
    hsv12: ProfileImageStats
  }
}

function modHueBin(hueDegrees: number): number {
  const raw = Math.floor((hueDegrees + 15) / 30)
  return (
    ((raw % COLOR_NORMALIZATION_HUE_BINS) + COLOR_NORMALIZATION_HUE_BINS) %
    COLOR_NORMALIZATION_HUE_BINS
  )
}

/** RGB 0..255 → HSV with hue in degrees 0..360, s and v in 0..1. */
export function rgbToHsv(
  red: number,
  green: number,
  blue: number,
): { hueDegrees: number; saturation: number; value: number } {
  const rn = red / 255
  const gn = green / 255
  const bn = blue / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  let hueDegrees = 0
  const value = max
  const saturation = max === 0 ? 0 : delta / max
  if (delta !== 0) {
    if (max === rn) hueDegrees = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) hueDegrees = ((bn - rn) / delta + 2) * 60
    else hueDegrees = ((rn - gn) / delta + 4) * 60
  }
  if (hueDegrees < 0) hueDegrees += 360
  if (hueDegrees >= 360) hueDegrees %= 360
  return { hueDegrees, saturation, value }
}

/** HSV to 8-bit RGB with standard sector math and Math.round on each channel. */
function hsvToRgb8(
  hueDegrees: number,
  saturation: number,
  value: number,
): readonly [number, number, number] {
  const c = value * saturation
  const sector = (hueDegrees % 360) / 60
  const x = c * (1 - Math.abs((sector % 2) - 1))
  const m = value - c
  let rp = 0
  let gp = 0
  let bp = 0
  const index = Math.floor(sector) % 6
  switch (index) {
    case 0:
      rp = c
      gp = x
      break
    case 1:
      rp = x
      gp = c
      break
    case 2:
      gp = c
      bp = x
      break
    case 3:
      gp = x
      bp = c
      break
    case 4:
      rp = x
      bp = c
      break
    default:
      rp = c
      bp = x
      break
  }
  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ] as const
}

export function normalizePixelHsv12(
  red: number,
  green: number,
  blue: number,
): readonly [number, number, number] {
  const { hueDegrees, saturation, value } = rgbToHsv(red, green, blue)
  if (value < COLOR_NORMALIZATION_BLACK_VALUE_BELOW) return [0, 0, 0] as const
  if (saturation < COLOR_NORMALIZATION_ACHROMATIC_SATURATION_BELOW) {
    if (value < COLOR_NORMALIZATION_ACHROMATIC_WHITE_VALUE_AT_LEAST) return [128, 128, 128] as const
    return [255, 255, 255] as const
  }
  const bin = modHueBin(hueDegrees)
  const centerHue = bin * 30
  return hsvToRgb8(centerHue, 1, 1)
}

export function controlRgbKey(red: number, green: number, blue: number): number {
  return ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)
}

function validateView(view: CanonicalRgbaView): void {
  if (
    !Number.isSafeInteger(view.width) ||
    !Number.isSafeInteger(view.height) ||
    view.width < 1 ||
    view.height < 1 ||
    view.width * view.height > COLOR_NORMALIZATION_MAX_PIXELS ||
    view.data.byteLength !== view.width * view.height * 4
  )
    throw new RangeError('canonical RGBA view exceeds limits or has invalid dimensions')
}

function isVisibleAlpha(alpha: number): boolean {
  return alpha > 0
}

function countDistinctKeys(keys: Int32Array): number {
  const seen = new Set<number>()
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    if (key >= 0) seen.add(key)
  }
  return seen.size
}

function adjacentDifferingEdges(
  width: number,
  height: number,
  keyAt: (pixelIndex: number) => number | null,
): number {
  let edges = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const key = keyAt(index)
      if (key === null) continue
      if (x + 1 < width) {
        const right = keyAt(index + 1)
        if (right !== null && key !== right) edges += 1
      }
      if (y + 1 < height) {
        const down = keyAt(index + width)
        if (down !== null && key !== down) edges += 1
      }
    }
  }
  return edges
}

function changedAdjacencyVsSource(
  width: number,
  height: number,
  sourceKeyAt: (pixelIndex: number) => number | null,
  hsvKeyAt: (pixelIndex: number) => number | null,
): number {
  let changed = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const source = sourceKeyAt(index)
      if (source === null) continue
      if (x + 1 < width) {
        const rightSource = sourceKeyAt(index + 1)
        const rightHsv = hsvKeyAt(index + 1)
        if (rightSource !== null && rightHsv !== null) {
          const sourceSame = source === rightSource
          const hsvSame = hsvKeyAt(index) === rightHsv
          if (sourceSame !== hsvSame) changed += 1
        }
      }
      if (y + 1 < height) {
        const downSource = sourceKeyAt(index + width)
        const downHsv = hsvKeyAt(index + width)
        if (downSource !== null && downHsv !== null) {
          const sourceSame = source === downSource
          const hsvSame = hsvKeyAt(index) === downHsv
          if (sourceSame !== hsvSame) changed += 1
        }
      }
    }
  }
  return changed
}

class UnionFind {
  private readonly parent: Int32Array

  constructor(size: number) {
    this.parent = new Int32Array(size)
    for (let index = 0; index < size; index += 1) this.parent[index] = index
  }

  find(index: number): number {
    let current = index
    while (this.parent[current] !== current) {
      this.parent[current] = this.parent[this.parent[current]!]!
      current = this.parent[current]!
    }
    return current
  }

  union(a: number, b: number): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent[rootB] = rootA
  }
}

/** 4-connected components on alpha>0 pixels sharing the same color key. */
export function computeComponentIds(
  view: CanonicalRgbaView,
  colorKeyAt: (pixelIndex: number, red: number, green: number, blue: number) => number,
): Uint32Array {
  validateView(view)
  const { width, height, data } = view
  const pixelCount = width * height
  const uf = new UnionFind(pixelCount)
  const keys = new Int32Array(pixelCount)
  keys.fill(-1)

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    const alpha = data[offset + 3]!
    if (!isVisibleAlpha(alpha)) continue
    const red = data[offset]!
    const green = data[offset + 1]!
    const blue = data[offset + 2]!
    keys[index] = colorKeyAt(index, red, green, blue)
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) {
      const left = index - 1
      if (keys[left]! >= 0 && keys[left] === keys[index]) uf.union(index, left)
    }
    if (y > 0) {
      const up = index - width
      if (keys[up]! >= 0 && keys[up] === keys[index]) uf.union(index, up)
    }
  }

  const rootToMinPixel = new Map<number, number>()
  for (let index = 0; index < pixelCount; index += 1) {
    if (keys[index]! < 0) continue
    const root = uf.find(index)
    const prior = rootToMinPixel.get(root)
    if (prior === undefined || index < prior) rootToMinPixel.set(root, index)
  }
  const orderedRoots = [...rootToMinPixel.entries()].sort((left, right) => left[1] - right[1])
  const rootToId = new Map<number, number>()
  orderedRoots.forEach(([root], position) => {
    rootToId.set(root, position + 1)
  })

  const labels = new Uint32Array(pixelCount)
  for (let index = 0; index < pixelCount; index += 1) {
    if (keys[index]! < 0) continue
    labels[index] = rootToId.get(uf.find(index)) ?? 0
  }
  return labels
}

function profileStatsFromKeys(
  view: CanonicalRgbaView,
  keys: Int32Array,
  componentLabels: Uint32Array,
  sourceKeys: Int32Array,
  hsvKeys: Int32Array,
  includeChangedEdges: boolean,
): ProfileImageStats {
  validateView(view)
  const { width, height } = view
  const keyAt = (pixelIndex: number): number | null =>
    keys[pixelIndex]! < 0 ? null : keys[pixelIndex]!
  const sourceKeyAt = (pixelIndex: number): number | null =>
    sourceKeys[pixelIndex]! < 0 ? null : sourceKeys[pixelIndex]!
  const hsvKeyAt = (pixelIndex: number): number | null =>
    hsvKeys[pixelIndex]! < 0 ? null : hsvKeys[pixelIndex]!

  let sourcePixels = 0
  const componentIds = new Set<number>()
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index]! >= 0) sourcePixels += 1
  }
  for (const label of componentLabels) if (label > 0) componentIds.add(label)

  return {
    distinctCanonicalColors: countDistinctKeys(keys),
    componentCount: componentIds.size,
    adjacentDifferingColorEdges: adjacentDifferingEdges(width, height, keyAt),
    changedAdjacentEdgesVsSourceRgb: includeChangedEdges
      ? changedAdjacencyVsSource(width, height, sourceKeyAt, hsvKeyAt)
      : 0,
    sourcePixels,
  }
}

export function processColorNormalizationImage(
  view: CanonicalRgbaView,
): ProcessedColorNormalizationImage {
  validateView(view)
  const owned = new Uint8Array(view.data)
  const sourceView: CanonicalRgbaView = { data: owned, width: view.width, height: view.height }
  const normalized = new Uint8Array(owned)
  const pixelCount = sourceView.width * sourceView.height
  const sourceKeys = new Int32Array(pixelCount)
  const controlKeys = new Int32Array(pixelCount)
  const hsvKeys = new Int32Array(pixelCount)
  sourceKeys.fill(-1)
  controlKeys.fill(-1)
  hsvKeys.fill(-1)

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    const alpha = owned[offset + 3]!
    const red = owned[offset]!
    const green = owned[offset + 1]!
    const blue = owned[offset + 2]!
    normalized[offset + 3] = alpha
    if (!isVisibleAlpha(alpha)) {
      normalized[offset] = red
      normalized[offset + 1] = green
      normalized[offset + 2] = blue
      continue
    }
    sourceKeys[index] = controlRgbKey(red, green, blue)
    controlKeys[index] = sourceKeys[index]!
    const [nr, ng, nb] = normalizePixelHsv12(red, green, blue)
    normalized[offset] = nr
    normalized[offset + 1] = ng
    normalized[offset + 2] = nb
    hsvKeys[index] = controlRgbKey(nr, ng, nb)
  }

  const controlComponentIds = computeComponentIds(sourceView, (_index, red, green, blue) =>
    controlRgbKey(red, green, blue),
  )

  const hsvView: CanonicalRgbaView = {
    data: normalized,
    width: sourceView.width,
    height: sourceView.height,
  }
  const hsv12ComponentIds = computeComponentIds(hsvView, (_index, red, green, blue) =>
    controlRgbKey(red, green, blue),
  )

  const controlStats = profileStatsFromKeys(
    sourceView,
    controlKeys,
    controlComponentIds,
    sourceKeys,
    hsvKeys,
    false,
  )
  const hsvStats = profileStatsFromKeys(
    hsvView,
    hsvKeys,
    hsv12ComponentIds,
    sourceKeys,
    hsvKeys,
    true,
  )

  return {
    normalizedRgba: normalized,
    controlComponentIds,
    hsv12ComponentIds,
    stats: {
      controlRgb: controlStats,
      hsv12: hsvStats,
    },
  }
}

export function encodeComponentMap(
  profile: ComponentMapProfileKind,
  width: number,
  height: number,
  labels: Uint32Array,
): Uint8Array {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > COLOR_NORMALIZATION_MAX_PIXELS ||
    labels.length !== width * height
  )
    throw new RangeError('component map dimensions are invalid')
  const body = Buffer.allocUnsafe(COMPONENT_MAP_MAGIC.length + 1 + 8 + labels.length * 4)
  COMPONENT_MAP_MAGIC.copy(body, 0)
  body[COMPONENT_MAP_MAGIC.length] = profile
  body.writeUInt32LE(width, COMPONENT_MAP_MAGIC.length + 1)
  body.writeUInt32LE(height, COMPONENT_MAP_MAGIC.length + 5)
  for (let index = 0; index < labels.length; index += 1) {
    body.writeUInt32LE(labels[index]!, COMPONENT_MAP_MAGIC.length + 9 + index * 4)
  }
  return new Uint8Array(body)
}

export function compressComponentMap(encoded: Uint8Array): Uint8Array {
  return gzipSync(encoded, { level: 6 })
}

const COMPONENT_MAP_MAX_DECOMPRESSED_BYTES =
  COMPONENT_MAP_MAGIC.length + 9 + COLOR_NORMALIZATION_MAX_PIXELS * 4

export function decompressComponentMap(compressed: Uint8Array): {
  profile: ComponentMapProfileKind
  width: number
  height: number
  labels: Uint32Array
} {
  const encoded = gunzipSync(compressed, {
    maxOutputLength: COMPONENT_MAP_MAX_DECOMPRESSED_BYTES,
  })
  if (encoded.length < COMPONENT_MAP_MAGIC.length + 9)
    throw new RangeError('component map payload is truncated')
  if (!encoded.subarray(0, COMPONENT_MAP_MAGIC.length).equals(COMPONENT_MAP_MAGIC))
    throw new RangeError('component map magic mismatch')
  const profile = encoded[COMPONENT_MAP_MAGIC.length]!
  if (profile !== COMPONENT_MAP_PROFILE_CONTROL_RGB && profile !== COMPONENT_MAP_PROFILE_HSV12)
    throw new RangeError('component map profile byte is invalid')
  const width = encoded.readUInt32LE(COMPONENT_MAP_MAGIC.length + 1)
  const height = encoded.readUInt32LE(COMPONENT_MAP_MAGIC.length + 5)
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > COLOR_NORMALIZATION_MAX_PIXELS
  )
    throw new RangeError('component map dimensions exceed limits')
  const expected = COMPONENT_MAP_MAGIC.length + 9 + width * height * 4
  if (encoded.length !== expected) throw new RangeError('component map byte length mismatch')
  const labels = new Uint32Array(width * height)
  const maxLabel = width * height
  for (let index = 0; index < labels.length; index += 1) {
    const label = encoded.readUInt32LE(COMPONENT_MAP_MAGIC.length + 9 + index * 4)
    if (label > maxLabel) throw new RangeError('component map label out of range')
    labels[index] = label
  }
  return { profile: profile as ComponentMapProfileKind, width, height, labels }
}

export function buildComponentCutout(
  sourceRgba: Uint8Array,
  width: number,
  height: number,
  labels: Uint32Array,
  componentId: number,
): Uint8Array {
  if (sourceRgba.byteLength !== width * height * 4 || labels.length !== width * height)
    throw new RangeError('cutout inputs have inconsistent dimensions')
  const out = new Uint8Array(sourceRgba.byteLength)
  for (let index = 0; index < labels.length; index += 1) {
    const offset = index * 4
    if (labels[index] === componentId) {
      out[offset] = sourceRgba[offset]!
      out[offset + 1] = sourceRgba[offset + 1]!
      out[offset + 2] = sourceRgba[offset + 2]!
      out[offset + 3] = sourceRgba[offset + 3]!
    }
  }
  return out
}

export function componentBinaryMask(
  labels: Uint32Array,
  width: number,
  height: number,
  componentId: number,
): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] === componentId) mask[index] = 1
  }
  return mask
}
