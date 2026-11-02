import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function replaySha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function isWithinDirectory(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

/** Read a bounded pin from one descriptor and reject path swaps and aliases. */
export async function readPinnedReplayFile(
  path: string,
  expectedSha256: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<Buffer> {
  const absolute = resolve(path)
  const info = await lstat(absolute)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maxBytes ||
    (await realpath(absolute)) !== absolute
  )
    throw new RangeError('Pinned replay input is not a bounded canonical file')
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new RangeError('Pinned replay input exceeds its bounded file size')
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes)
      throw new RangeError('Pinned replay input grew beyond its bounded file size')
    const bytes = buffer.subarray(0, offset)
    const after = await handle.stat({ bigint: true })
    const afterPath = await lstat(absolute, { bigint: true })
    if (
      replaySha256(bytes) !== expectedSha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.length !== Number(before.size) ||
      afterPath.dev !== after.dev ||
      afterPath.ino !== after.ino ||
      (await realpath(absolute)) !== absolute
    )
      throw new RangeError('Pinned replay input changed while being read')
    return Buffer.from(bytes)
  } finally {
    await handle.close()
  }
}

export function parseReplayJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
}
