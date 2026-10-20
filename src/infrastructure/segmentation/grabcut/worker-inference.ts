import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { Script } from 'node:vm'
import { z } from 'zod'

import type { NativeSegmentationReply, NativeSegmentationRequest } from '../native-protocol.js'

const artifact = {
  bytes: 10_964_323,
  sha256: '63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0',
} as const

const cvSchema = z.object({
  Mat: z.custom<(...args: unknown[]) => unknown>((value) => typeof value === 'function'),
  Rect: z.custom<(...args: unknown[]) => unknown>((value) => typeof value === 'function'),
  cvtColor: z.custom<(...args: unknown[]) => unknown>((value) => typeof value === 'function'),
  grabCut: z.custom<(...args: unknown[]) => unknown>((value) => typeof value === 'function'),
  COLOR_RGBA2RGB: z.number().int(),
  CV_8UC4: z.number().int(),
  CV_8UC3: z.number().int(),
  CV_8UC1: z.number().int(),
  GC_BGD: z.number().int(),
  GC_FGD: z.number().int(),
  GC_PR_BGD: z.number().int(),
  GC_PR_FGD: z.number().int(),
  GC_INIT_WITH_MASK: z.number().int(),
  GC_INIT_WITH_RECT: z.number().int(),
})

async function readVerifiedAsset(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== artifact.bytes)
      throw new Error('Pinned OpenCV size mismatch')
    const source = Buffer.alloc(artifact.bytes)
    let offset = 0
    while (offset < source.length) {
      const read = await handle.read(source, offset, source.length - offset, null)
      if (!read.bytesRead) throw new Error('Pinned OpenCV asset read was incomplete')
      offset += read.bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0)
      throw new Error('Pinned OpenCV asset changed while being read')
    if (createHash('sha256').update(source).digest('hex') !== artifact.sha256)
      throw new Error('Pinned OpenCV SHA256 mismatch')
    return source.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function loadOpenCv(path: string) {
  path = resolve(path)
  const source = await readVerifiedAsset(path)
  const wrapper: { exports: unknown } = { exports: {} }
  const factory: unknown = new Script(
    '(function(exports,require,module,__filename,__dirname){' + source + '\n})',
    { filename: path },
  ).runInThisContext()
  if (typeof factory !== 'function') throw new Error('Pinned OpenCV asset is not a module')
  Reflect.apply(factory, undefined, [
    wrapper.exports,
    createRequire(path),
    wrapper,
    path,
    dirname(path),
  ])
  const exports: unknown = wrapper.exports
  if (typeof exports === 'object' && exports !== null && 'then' in exports) {
    const then = Reflect.get(exports, 'then')
    if (typeof then === 'function') {
      return await new Promise<z.infer<typeof cvSchema>>((resolve, reject) => {
        try {
          Reflect.apply(then, exports, [
            (value: unknown) => {
              const checked = cvSchema.safeParse(value)
              if (checked.success) resolve(checked.data)
              else reject(new Error('Pinned OpenCV namespace is invalid'))
            },
            reject,
          ])
        } catch (error) {
          reject(error)
        }
      })
    }
  }
  return cvSchema.parse(exports)
}

export async function probeGrabCut(assetPath: string): Promise<void> {
  await loadOpenCv(assetPath)
}

interface CvMat {
  data?: unknown
  delete(): void
}
const matShapeSchema = z
  .object({ delete: z.custom<() => void>((value) => typeof value === 'function') })
  .passthrough()
const matSchema = z.custom<CvMat>((value) => matShapeSchema.safeParse(value).success)
function matrix(cv: z.infer<typeof cvSchema>, args: number[] = []) {
  return matSchema.parse(Reflect.construct(cv.Mat, args))
}

function getBytes(mat: { data?: unknown }, length: number): Uint8Array {
  const bytes = z.instanceof(Uint8Array).parse(mat.data)
  if (bytes.length !== length) throw new Error('OpenCV matrix dimensions do not match')
  return bytes
}

function seededComponents(
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

export async function runGrabCutTask(
  request: Extract<NativeSegmentationRequest, { kind: 'grabcut' }>,
): Promise<NativeSegmentationReply> {
  const cv = await loadOpenCv(request.assetPath)
  const pixels = request.width * request.height
  const rgbaBytes = Buffer.from(request.rgba, 'base64')
  if (rgbaBytes.length !== pixels * 4) throw new Error('Invalid GrabCut RGBA bytes')
  const rgba = matrix(cv, [request.height, request.width, cv.CV_8UC4])
  const rgb = matrix(cv)
  const mask = matrix(cv, [request.height, request.width, cv.CV_8UC1])
  const background = matrix(cv)
  const foreground = matrix(cv)
  const owned = [rgba, rgb, mask, background, foreground]
  let result: NativeSegmentationReply | undefined
  let releaseFailed = false
  try {
    getBytes(rgba, pixels * 4).set(rgbaBytes)
    Reflect.apply(cv.cvtColor, cv, [rgba, rgb, cv.COLOR_RGBA2RGB])
    const flags = getBytes(mask, pixels)
    flags.fill(cv.GC_BGD)
    for (
      let y = request.wholeRegion.top;
      y < request.wholeRegion.top + request.wholeRegion.height;
      y++
    )
      for (
        let x = request.wholeRegion.left;
        x < request.wholeRegion.left + request.wholeRegion.width;
        x++
      )
        flags[y * request.width + x] = cv.GC_PR_FGD
    for (
      let y = request.seedRegion.top;
      y < request.seedRegion.top + request.seedRegion.height;
      y++
    )
      for (
        let x = request.seedRegion.left;
        x < request.seedRegion.left + request.seedRegion.width;
        x++
      )
        flags[y * request.width + x] = cv.GC_FGD
    const rect = Reflect.construct(cv.Rect, [0, 0, 0, 0])
    Reflect.apply(cv.grabCut, cv, [
      rgb,
      mask,
      rect,
      background,
      foreground,
      3,
      cv.GC_INIT_WITH_MASK,
    ])
    const maskResult = new Uint8Array(pixels)
    for (let y = request.roi.top; y < request.roi.top + request.roi.height; y++) {
      for (let x = request.roi.left; x < request.roi.left + request.roi.width; x++) {
        const at = y * request.width + x
        const flag = flags[at]
        if (flag === cv.GC_FGD || flag === cv.GC_PR_FGD) maskResult[at] = 1
      }
    }
    const grounded = seededComponents(maskResult, request.width, request.height, request)
    if (!grounded.some((value) => value === 1))
      throw new Error('GrabCut produced no seed-grounded mask')
    result = {
      id: request.id,
      status: 'segmented',
      width: request.width,
      height: request.height,
      mask: Buffer.from(grounded).toString('base64'),
      method: 'grabcut-seeded-box-v1',
    }
  } finally {
    let failed = false
    for (const item of owned.reverse()) {
      try {
        item.delete()
      } catch {
        failed = true
      }
    }
    releaseFailed = failed
  }
  if (releaseFailed) throw new Error('OpenCV matrices could not all be released')
  if (!result) throw new Error('GrabCut completed without a mask result')
  return result
}
