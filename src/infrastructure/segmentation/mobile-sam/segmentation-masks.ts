export function inside(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
) {
  return x >= rect.left && y >= rect.top && x < rect.left + rect.width && y < rect.top + rect.height
}

interface MaskCandidate {
  token: number
  score: number
  mask: Uint8Array
}

/** Sort by model quality and use decoder token order as a deterministic tie break. */
export function selectBestMaskCandidate<T extends MaskCandidate>(
  candidates: readonly T[],
): T | undefined {
  return [...candidates].sort((a, b) => b.score - a.score || a.token - b.token)[0]
}

export function mobileSamSegmentationPrompt(input: {
  prompt: 'whole-region' | 'seed-region'
  seedRegion: { left: number; top: number; width: number; height: number }
  wholeRegion: { left: number; top: number; width: number; height: number }
  xScale: number
  yScale: number
}) {
  if (input.prompt === 'whole-region')
    return {
      coordinates: Float32Array.of(
        input.wholeRegion.left * input.xScale,
        input.wholeRegion.top * input.yScale,
        (input.wholeRegion.left + input.wholeRegion.width) * input.xScale,
        (input.wholeRegion.top + input.wholeRegion.height) * input.yScale,
      ),
      labels: Float32Array.of(2, 3),
    }
  const centerX = input.seedRegion.left + (input.seedRegion.width - 1) / 2
  const centerY = input.seedRegion.top + (input.seedRegion.height - 1) / 2
  const pointX = centerX * input.xScale
  const pointY = centerY * input.yScale
  return {
    coordinates: Float32Array.of(pointX, pointY, pointX, pointY),
    labels: Float32Array.of(1, -1),
  }
}

export function collectMobileSamSegmentationCandidates(input: {
  width: number
  height: number
  rgba: Uint8Array
  logits: Float32Array
  scores: Float32Array
  roi: { left: number; top: number; width: number; height: number }
  seedRegion: { left: number; top: number; width: number; height: number }
  prompt: 'whole-region' | 'seed-region'
}): MaskCandidate[] {
  const pixels = input.width * input.height
  if (
    input.rgba.length !== pixels * 4 ||
    input.logits.length !== pixels * 4 ||
    input.scores.length !== 4
  )
    throw new Error('Invalid MobileSAM decoder output dimensions')
  const candidates: MaskCandidate[] = []
  for (let token = 0; token < 4; token++) {
    const mask = new Uint8Array(pixels)
    let seedHit = false
    for (let index = 0; index < pixels; index++) {
      const value = input.logits[token * pixels + index]
      if (value === undefined || !Number.isFinite(value)) throw new Error('Non-finite mask logit')
      if (value <= 0) continue
      const x = index % input.width
      const y = Math.floor(index / input.width)
      if (!inside(input.roi, x, y)) continue
      if (input.prompt === 'seed-region' && input.rgba[index * 4 + 3] === 0) continue
      mask[index] = 1
      if (inside(input.seedRegion, x, y)) seedHit = true
    }
    const score = input.scores[token]
    if (score === undefined || !Number.isFinite(score))
      throw new Error('Non-finite MobileSAM quality diagnostic')
    if (seedHit) candidates.push({ token, score, mask })
  }
  return candidates
}

export function selectMobileSamSegmentationMask(input: {
  candidates: readonly MaskCandidate[]
  width: number
  height: number
  prompt: 'whole-region' | 'seed-region'
}): Uint8Array {
  const best = selectBestMaskCandidate(input.candidates)
  if (best) return best.mask
  if (input.prompt === 'seed-region') return new Uint8Array(input.width * input.height)
  throw new Error('MobileSAM produced no seed-grounded mask')
}

interface EnclosingMobileSamCandidate {
  token: number
  score: number
  mask: Uint8Array
  area: number
  bounds: { left: number; top: number; right: number; bottom: number }
}

/** Full-source segmentation masks use the segmentation pixel cap, not the proposal cap. */
export function packFullSourceBinaryMask(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const pixels = Number.isSafeInteger(width) && Number.isSafeInteger(height) ? width * height : NaN
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(pixels) ||
    pixels > 16_777_216 ||
    mask.length !== pixels
  )
    throw new Error('Invalid full-source mask dimensions')
  const packed = new Uint8Array(Math.ceil(pixels / 8))
  for (let index = 0; index < pixels; index++) {
    const value = mask[index]
    if (value !== 0 && value !== 1) throw new Error('Full-source mask is not binary')
    if (value === 1) packed[index >> 3] = (packed[index >> 3] ?? 0) | (1 << (index & 7))
  }
  return packed
}

/** Strictly decode the LSB-first full-source mask representation used by expansion IPC. */
export function unpackFullSourceBinaryMask(
  data: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const pixels = Number.isSafeInteger(width) && Number.isSafeInteger(height) ? width * height : NaN
  const expectedBytes = Number.isSafeInteger(pixels) ? Math.ceil(pixels / 8) : NaN
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(pixels) ||
    pixels > 16_777_216 ||
    data.length !== expectedBytes
  )
    throw new Error('Invalid packed full-source mask dimensions')
  const unusedBits = expectedBytes * 8 - pixels
  if (unusedBits > 0) {
    const allowed = (1 << (8 - unusedBits)) - 1
    if (((data[expectedBytes - 1] ?? 0) & ~allowed) !== 0)
      throw new Error('Packed full-source mask has nonzero padding bits')
  }
  const output = new Uint8Array(pixels)
  for (let index = 0; index < pixels; index++)
    output[index] = ((data[index >> 3] ?? 0) >> (index & 7)) & 1
  return output
}

/** Validate a prior full-source mask and return its foreground area and bounds. */
export function validateMobileSamPreviousMask(input: {
  width: number
  height: number
  rgba: Uint8Array
  previousMask: Uint8Array
  roi: { left: number; top: number; width: number; height: number }
}): { area: number; bounds: { left: number; top: number; right: number; bottom: number } } {
  const pixels =
    Number.isSafeInteger(input.width) && Number.isSafeInteger(input.height)
      ? input.width * input.height
      : NaN
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    !Number.isSafeInteger(pixels) ||
    pixels > 16_777_216 ||
    input.rgba.length !== pixels * 4 ||
    input.previousMask.length !== pixels ||
    !Number.isSafeInteger(input.roi.left) ||
    !Number.isSafeInteger(input.roi.top) ||
    !Number.isSafeInteger(input.roi.width) ||
    !Number.isSafeInteger(input.roi.height) ||
    input.roi.left < 0 ||
    input.roi.top < 0 ||
    input.roi.width < 1 ||
    input.roi.height < 1 ||
    input.roi.left + input.roi.width > input.width ||
    input.roi.top + input.roi.height > input.height
  )
    throw new Error('Invalid previous mask dimensions or ROI')
  let area = 0
  let left = input.width
  let top = input.height
  let right = -1
  let bottom = -1
  for (let index = 0; index < pixels; index++) {
    const value = input.previousMask[index]
    if (value !== 0 && value !== 1) throw new Error('Previous mask is not binary')
    if (value === 0) continue
    const x = index % input.width
    const y = Math.floor(index / input.width)
    if (!inside(input.roi, x, y) || input.rgba[index * 4 + 3] === 0)
      throw new Error('Previous mask foreground is outside visible ROI pixels')
    area++
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  if (area === 0) throw new Error('Previous mask has no foreground')
  return { area, bounds: { left, top, right, bottom } }
}

/** Select the smallest actual decoder mask that strictly encloses prior foreground. */
export function selectEnclosingMobileSamCandidate(input: {
  width: number
  height: number
  rgba: Uint8Array
  logits: Float32Array
  scores: Float32Array
  previousMask: Uint8Array
  roi: { left: number; top: number; width: number; height: number }
}): EnclosingMobileSamCandidate | undefined {
  const pixels = input.width * input.height
  const previous = validateMobileSamPreviousMask(input)
  if (input.logits.length !== pixels * 4 || input.scores.length !== 4)
    throw new Error('Invalid MobileSAM decoder output dimensions')
  let best: EnclosingMobileSamCandidate | undefined
  let currentMask: Uint8Array | undefined
  try {
    for (let token = 0; token < 4; token++) {
      const score = input.scores[token]
      if (score === undefined || !Number.isFinite(score))
        throw new Error('Non-finite MobileSAM quality diagnostic')
      const mask = new Uint8Array(pixels)
      currentMask = mask
      let area = 0
      let left = input.width
      let top = input.height
      let right = -1
      let bottom = -1
      let containsPrevious = true
      const base = token * pixels
      for (let index = 0; index < pixels; index++) {
        const value = input.logits[base + index]
        if (value === undefined || !Number.isFinite(value))
          throw new Error('Non-finite MobileSAM mask logit')
        const x = index % input.width
        const y = Math.floor(index / input.width)
        const foreground = value > 0 && input.rgba[index * 4 + 3] !== 0 && inside(input.roi, x, y)
        if (input.previousMask[index] === 1 && !foreground) containsPrevious = false
        if (!foreground) continue
        mask[index] = 1
        area++
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
      const strictBoundsGrowth =
        left <= previous.bounds.left &&
        top <= previous.bounds.top &&
        right >= previous.bounds.right &&
        bottom >= previous.bounds.bottom &&
        (left < previous.bounds.left ||
          top < previous.bounds.top ||
          right > previous.bounds.right ||
          bottom > previous.bounds.bottom)
      if (!containsPrevious || area <= previous.area || !strictBoundsGrowth) {
        mask.fill(0)
        continue
      }
      const candidate = { token, score, mask, area, bounds: { left, top, right, bottom } }
      if (
        !best ||
        candidate.area < best.area ||
        (candidate.area === best.area && candidate.score > best.score) ||
        (candidate.area === best.area &&
          candidate.score === best.score &&
          candidate.token < best.token)
      ) {
        best?.mask.fill(0)
        best = candidate
      } else mask.fill(0)
    }
    return best
  } catch (error) {
    currentMask?.fill(0)
    best?.mask.fill(0)
    throw error
  }
}
