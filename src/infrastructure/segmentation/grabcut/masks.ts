import { z } from 'zod'

import type { NativeSegmentationRequest } from '../native-protocol.js'

export function getBytes(mat: { data?: unknown }, length: number): Uint8Array {
  const bytes = z.instanceof(Uint8Array).parse(mat.data)
  if (bytes.length !== length) throw new Error('OpenCV matrix dimensions do not match')
  return bytes
}

export function initializeGrabCutMask(input: {
  flags: Uint8Array
  width: number
  height: number
  seedRegion: { left: number; top: number; width: number; height: number }
  wholeRegion: { left: number; top: number; width: number; height: number }
  roi: { left: number; top: number; width: number; height: number }
  prompt: 'whole-region' | 'seed-region'
  labels: {
    background: number
    foreground: number
    probableBackground: number
    probableForeground: number
  }
}) {
  if (input.flags.length !== input.width * input.height)
    throw new Error('GrabCut mask dimensions do not match source')
  input.flags.fill(input.labels.background)
  if (input.prompt === 'whole-region') {
    for (let y = input.wholeRegion.top; y < input.wholeRegion.top + input.wholeRegion.height; y++)
      for (
        let x = input.wholeRegion.left;
        x < input.wholeRegion.left + input.wholeRegion.width;
        x++
      )
        input.flags[y * input.width + x] = input.labels.probableForeground
  } else {
    for (let y = input.roi.top; y < input.roi.top + input.roi.height; y++)
      for (let x = input.roi.left; x < input.roi.left + input.roi.width; x++)
        input.flags[y * input.width + x] = input.labels.probableBackground
  }
  const seedLeft = Math.max(input.seedRegion.left, input.roi.left)
  const seedTop = Math.max(input.seedRegion.top, input.roi.top)
  const seedRight = Math.min(
    input.seedRegion.left + input.seedRegion.width,
    input.roi.left + input.roi.width,
  )
  const seedBottom = Math.min(
    input.seedRegion.top + input.seedRegion.height,
    input.roi.top + input.roi.height,
  )
  if (seedLeft >= seedRight || seedTop >= seedBottom)
    throw new Error('GrabCut seed region does not intersect hard ROI')
  for (let y = seedTop; y < seedBottom; y++)
    for (let x = seedLeft; x < seedRight; x++)
      input.flags[y * input.width + x] = input.labels.foreground
}

/** Run native GrabCut, then reacquire Mat.data before copying its post-call flags. */
export function runGrabCutAndCopyMask(
  mat: { data?: unknown },
  width: number,
  height: number,
  roi: { left: number; top: number; width: number; height: number },
  runNative: () => void,
  labels: { foreground: number; probableForeground: number },
): Uint8Array {
  runNative()
  const flags = getBytes(mat, width * height)
  const output = new Uint8Array(width * height)
  for (let y = roi.top; y < roi.top + roi.height; y++) {
    for (let x = roi.left; x < roi.left + roi.width; x++) {
      const at = y * width + x
      const flag = flags[at]
      if (flag === labels.foreground || flag === labels.probableForeground) output[at] = 1
    }
  }
  return output
}

export function seededComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  input: NativeSegmentationRequest & { kind: 'grabcut' },
): Uint8Array {
  const visited = new Uint8Array(mask.length)
  const output = new Uint8Array(mask.length)
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || visited[start] === 1) continue
    stack.push(start)
    visited[start] = 1
    const component: number[] = []
    let hitsSeed = false
    while (stack.length) {
      const at = stack.pop()
      if (at === undefined) continue
      component.push(at)
      const x = at % width
      const y = Math.floor(at / width)
      if (
        x >= input.seedRegion.left &&
        y >= input.seedRegion.top &&
        x < input.seedRegion.left + input.seedRegion.width &&
        y < input.seedRegion.top + input.seedRegion.height
      )
        hitsSeed = true
      const neighbors = [at - 1, at + 1, at - width, at + width]
      for (const neighbor of neighbors) {
        if (
          neighbor < 0 ||
          neighbor >= mask.length ||
          visited[neighbor] === 1 ||
          mask[neighbor] !== 1
        )
          continue
        const nx = neighbor % width
        if (Math.abs(nx - x) + Math.abs(Math.floor(neighbor / width) - y) !== 1) continue
        visited[neighbor] = 1
        stack.push(neighbor)
      }
    }
    if (hitsSeed) for (const index of component) output[index] = 1
  }
  return output
}
