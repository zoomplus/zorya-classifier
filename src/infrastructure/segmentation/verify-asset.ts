import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

import { ClassifierError } from '../../entities/errors.js'

export async function verifyPinnedAsset(
  path: string,
  expected: { bytes: number; sha256: string },
  label: string,
): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== expected.bytes)
      throw new ClassifierError('UNSUPPORTED', `${label} asset is missing or has the wrong size`)
    const bytes = Buffer.alloc(expected.bytes)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!read.bytesRead)
        throw new ClassifierError('UNSUPPORTED', `${label} asset read was incomplete`)
      offset += read.bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0)
      throw new ClassifierError('UNSUPPORTED', `${label} asset changed while being read`)
    if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
      throw new ClassifierError(
        'UNSUPPORTED',
        `${label} asset SHA256 does not match the pinned artifact`,
      )
  } catch (error) {
    if (error instanceof ClassifierError) throw error
    throw new ClassifierError('UNSUPPORTED', `${label} asset cannot be read`)
  } finally {
    await handle?.close()
  }
}
