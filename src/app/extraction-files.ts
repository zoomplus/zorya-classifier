import { open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { ExtractionResult } from '../entities/segmentation.js'

/** Reserve every destination exclusively before writing; never overwrite an existing artifact. */
export async function writeExtractionFiles(
  prefix: string,
  result: Extract<ExtractionResult, { status: 'extracted' }>,
): Promise<{ png: string; mask: string; descriptor: string }> {
  const files = { png: `${prefix}.png`, mask: `${prefix}.mask.u8`, descriptor: `${prefix}.json` }
  const { png, mask, ...description } = result
  const descriptor = JSON.stringify(
    {
      ...description,
      mask: { width: mask.width, height: mask.height, format: mask.format },
      files,
    },
    null,
    2,
  )
  const owned: { path: string; handle: FileHandle }[] = []
  try {
    for (const path of Object.values(files)) owned.push({ path, handle: await open(path, 'wx') })
    for (const [index, bytes] of [png, mask.data, descriptor].entries())
      await owned[index]!.handle.writeFile(bytes)
    await Promise.all(owned.map(({ handle }) => handle.close()))
    return files
  } catch (error) {
    const closed = await Promise.allSettled(owned.map(({ handle }) => handle.close()))
    const removed = await Promise.allSettled(owned.map(({ path }) => unlink(path)))
    const cleanupErrors = [...closed, ...removed].flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    )
    if (cleanupErrors.length)
      throw new AggregateError([error, ...cleanupErrors], 'Extraction output and cleanup failed')
    throw error
  }
}
