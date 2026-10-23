import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export const H5_REPLAY_SOURCE_FILES = [
  'benchmarks/v03/h5-proposal-composer.ts',
  'benchmarks/v03/integrity-receipts.ts',
  'benchmarks/v03/run-h5b-paid-replay.ts',
  'benchmarks/v03/replay-source-closure.ts',
  'benchmarks/v02/recording.ts',
  'benchmarks/v02/budget.ts',
  'benchmarks/v02/protocol.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
] as const

export interface ReplaySourceClosure {
  sha256: string
  files: Array<{ path: string; sha256: string }>
}

async function hashSource(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Replay source must be a regular file')
  const hash = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal })
  try {
    for await (const chunk of stream) hash.update(chunk)
    signal?.throwIfAborted()
    return hash.digest('hex')
  } finally {
    stream.destroy()
  }
}

async function walkSource(directory: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Replay source directory cannot be a symlink')
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    signal?.throwIfAborted()
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Replay source tree cannot contain symlinks')
    if (entry.isDirectory()) files.push(...(await walkSource(path, signal)))
    else if (entry.isFile()) files.push(path)
    else throw new Error('Replay source tree contains a non-regular entry')
  }
  return files
}

/** No truth, assets or credentials: this captures only the executable replay source. */
export async function captureH5ReplaySource(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<ReplaySourceClosure> {
  const root = await realpath(repositoryRoot)
  const sourceFiles = (await walkSource(join(root, 'src'), signal)).map((path) =>
    relative(root, path).split('\\').join('/'),
  )
  const paths = [...new Set([...sourceFiles, ...H5_REPLAY_SOURCE_FILES])].sort()
  const files: ReplaySourceClosure['files'] = []
  for (const path of paths) {
    signal?.throwIfAborted()
    const absolute = resolve(root, path)
    if ((await realpath(absolute)) !== absolute)
      throw new Error('Replay source path traverses a symlink')
    files.push({ path, sha256: await hashSource(absolute, signal) })
  }
  return {
    // Historical benchmark identities deliberately use ordered JSON.stringify bytes.
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  }
}
