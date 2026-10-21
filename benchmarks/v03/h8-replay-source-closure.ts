import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const H8_SOURCE_FILES = [
  'benchmarks/v03/h6-context-composer.ts',
  'benchmarks/v03/h6-replay-kernel.ts',
  'benchmarks/v03/h6-replay-source-closure.ts',
  'benchmarks/v03/run-h8-ordinary-vision.ts',
  'benchmarks/v03/h8-replay-source-closure.ts',
  'benchmarks/v02/recording.ts',
  'benchmarks/v02/budget.ts',
  'benchmarks/v02/protocol.ts',
  'docs/research/v03-h8-ordinary-vision-comparison-plan.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
] as const

export interface H8ReplaySourceClosure {
  sha256: string
  files: Array<{ path: string; sha256: string }>
}

async function hashSource(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('H8 replay source must be a regular file')
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
    throw new Error('H8 source tree cannot be a symlink')
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    signal?.throwIfAborted()
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('H8 source tree cannot contain symlinks')
    if (entry.isDirectory()) files.push(...(await walkSource(path, signal)))
    else if (entry.isFile()) files.push(path)
    else throw new Error('H8 source tree contains a non-regular entry')
  }
  return files
}

/** Captures the replay source closure, including the shared fixed H6 composer. */
export async function captureH8ReplaySource(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<H8ReplaySourceClosure> {
  const root = await realpath(repositoryRoot)
  const sourceFiles = (await walkSource(join(root, 'src'), signal)).map((path) =>
    relative(root, path).split('\\').join('/'),
  )
  const paths = [...new Set([...sourceFiles, ...H8_SOURCE_FILES])].sort()
  const files: H8ReplaySourceClosure['files'] = []
  for (const path of paths) {
    signal?.throwIfAborted()
    const absolute = resolve(root, path)
    if ((await realpath(absolute)) !== absolute)
      throw new Error('H8 replay source path traverses a symlink')
    files.push({ path, sha256: await hashSource(absolute, signal) })
  }
  return {
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  }
}
