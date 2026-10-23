import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { Script } from 'node:vm'
import { z } from 'zod'

import { grabcutOpenCvArtifact } from './model-asset.js'

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
    if (!stat.isFile() || stat.size !== grabcutOpenCvArtifact.bytes)
      throw new Error('Pinned OpenCV size mismatch')
    const source = Buffer.alloc(grabcutOpenCvArtifact.bytes)
    let offset = 0
    while (offset < source.length) {
      const read = await handle.read(source, offset, source.length - offset, null)
      if (!read.bytesRead) throw new Error('Pinned OpenCV asset read was incomplete')
      offset += read.bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0)
      throw new Error('Pinned OpenCV asset changed while being read')
    if (createHash('sha256').update(source).digest('hex') !== grabcutOpenCvArtifact.sha256)
      throw new Error('Pinned OpenCV SHA256 mismatch')
    return source.toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function loadOpenCv(path: string) {
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

export function matrix(cv: z.infer<typeof cvSchema>, args: number[] = []) {
  return matSchema.parse(Reflect.construct(cv.Mat, args))
}
