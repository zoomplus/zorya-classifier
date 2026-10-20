import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { limits } from '../../src/entities/contracts.js'
import { assertActive, ClassifierError } from '../../src/entities/errors.js'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u)
  .refine((value) => value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''))

export const freshCaseSchema = z
  .object({
    caseId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    image: z
      .object({
        path: relativePathSchema,
        sha256: hashSchema,
        width: z.number().int().min(1).max(16384),
        height: z.number().int().min(1).max(16384),
      })
      .strict()
      .refine((image) => image.width * image.height <= limits.imagePixels),
    locate: z
      .object({
        target: z.string().min(1).max(2000),
        instruction: z.string().min(1).max(4000).optional(),
      })
      .strict(),
    classify: z
      .object({
        question: z.string().min(1).max(4000).optional(),
        options: z.tuple([z.literal('present'), z.literal('absent')]),
      })
      .strict(),
  })
  .strict()
export type FreshCase = z.infer<typeof freshCaseSchema>

const inputSchema = z.array(freshCaseSchema).min(1).max(120)
const optionsSchema = z
  .object({
    manifests: z
      .array(z.object({ path: z.string().min(1), sha256: hashSchema }).strict())
      .min(1)
      .max(6),
    imageRoot: z.string().min(1),
  })
  .strict()

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** One descriptor, bounded allocation, and detection of growth while reading. */
export async function readBoundedCorpusFile(
  path: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  assertActive(signal)
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > limits.imageBytes)
    throw new RangeError('Invalid corpus file byte budget')
  const handle = await open(path, 'r')
  let bytes: Buffer | undefined
  try {
    assertActive(signal)
    const info = await handle.stat()
    assertActive(signal)
    if (!info.isFile() || info.size < 1 || info.size > maximumBytes)
      throw new ClassifierError('RESOURCE_LIMIT', 'Corpus input exceeds its regular-file budget')
    bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      assertActive(signal)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== info.size)
      throw new ClassifierError('INVALID_INPUT', 'Corpus file changed while being read')
    return bytes.subarray(0, offset)
  } catch (error) {
    bytes?.fill(0)
    throw error
  } finally {
    await handle.close()
  }
}

function assertWithin(root: string, path: string): void {
  const value = relative(root, path)
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value))
    throw new ClassifierError('INVALID_INPUT', 'Corpus image escaped its configured root')
}

export interface FreshCorpus {
  cases: FreshCase[]
  imageRoot: string
  manifests: { sha256: string; cases: number }[]
}

/** Reads only explicitly pinned producer arrays. There is no ground-truth or ledger input. */
export async function loadFreshCorpus(
  input: z.input<typeof optionsSchema>,
  signal: AbortSignal,
): Promise<FreshCorpus> {
  assertActive(signal)
  const options = optionsSchema.parse(input)
  const imageRoot = await realpath(options.imageRoot)
  assertActive(signal)
  const cases: FreshCase[] = []
  const manifests: FreshCorpus['manifests'] = []
  const ids = new Set<string>()
  for (const manifest of options.manifests) {
    const bytes = await readBoundedCorpusFile(manifest.path, 1024 * 1024, signal)
    try {
      if (digest(bytes) !== manifest.sha256)
        throw new ClassifierError('INVALID_INPUT', 'Producer manifest hash mismatch')
      const parsed = inputSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (cases.length + parsed.length > 120)
        throw new ClassifierError('RESOURCE_LIMIT', 'Corpus exceeds 120 cases')
      for (const item of parsed) {
        if (ids.has(item.caseId))
          throw new ClassifierError('INVALID_INPUT', 'Producer case IDs must be unique')
        ids.add(item.caseId)
        cases.push(item)
      }
      manifests.push({ sha256: manifest.sha256, cases: parsed.length })
    } finally {
      bytes.fill(0)
    }
  }
  return { cases, imageRoot, manifests }
}

/** The controller retains IDs and hashes; model-facing tasks contain only the authored questions. */
export function freshProducerTask(input: FreshCase): {
  target: string
  instruction?: string
  question: string
  classes: ['present', 'absent']
} {
  const item = freshCaseSchema.parse(input)
  return {
    target: item.locate.target,
    ...(item.locate.instruction ? { instruction: item.locate.instruction } : {}),
    question: item.classify.question ?? `Does this image contain ${item.locate.target}?`,
    classes: [...item.classify.options],
  }
}

/** Own and verify the actual raster bytes before any paid dispatch. */
export async function loadFreshImage(
  input: FreshCase,
  imageRoot: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  assertActive(signal)
  const item = freshCaseSchema.parse(input)
  const root = await realpath(imageRoot)
  assertActive(signal)
  const path = await realpath(resolve(root, item.image.path))
  assertActive(signal)
  assertWithin(root, path)
  const bytes = await readBoundedCorpusFile(path, limits.imageBytes, signal)
  const pipeline = sharp(bytes, { limitInputPixels: limits.imagePixels, failOn: 'error' })
  try {
    if (digest(bytes) !== item.image.sha256)
      throw new ClassifierError('INVALID_INPUT', 'Producer image hash mismatch')
    const metadata = await pipeline.metadata()
    assertActive(signal)
    if (
      !['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation ?? 1) !== 1 ||
      metadata.width !== item.image.width ||
      metadata.height !== item.image.height
    )
      throw new ClassifierError('INVALID_INPUT', 'Producer raster geometry does not match manifest')
    return bytes
  } catch (error) {
    bytes.fill(0)
    throw error
  } finally {
    pipeline.destroy()
  }
}
