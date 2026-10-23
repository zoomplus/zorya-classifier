import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dispatcherEntries = ['./run-categorical-box-heldout.ts'] as const
const includedBenchmarkFiles = [
  './categorical-presence-fresh-runner.ts',
  './run-categorical-presence-fresh.ts',
  './run-categorical-box-confirmation-dev.ts',
  './categorical-presence-fresh-pair.md',
  './categorical-presence-port.ts',
  './native-categorical-presence-port.ts',
  './categorical-heldout-plan.ts',
  './run-categorical-heldout.ts',
  './fresh-corpus.ts',
  './recording.ts',
  './budget.ts',
  './protocol.ts',
  '../credentials.ts',
  './fresh-text-runner.ts',
  './fresh-text-dev.ts',
  './promptvariants.ts',
  './transportvariants.ts',
  '../experiments/text-encoders-v1.ts',
  '../experiments/ascii-luma-v1.ts',
  '../experiments/palette-grid-v1.ts',
  '../experiments/svg-contours-v1.ts',
  '../experiments/pixel-rle-v1.ts',
  '../experiments/ascii-contours-v1.ts',
  '../experiments/ascii-svg-layered-v1.ts',
  '../experiments/text-representation.ts',
  '../experiments/boundary-view.ts',
  '../experiments/create-research-classifier.ts',
  '../../package.json',
  '../../package-lock.json',
  './categorical-box-heldout-plan.ts',
  './categorical-box-heldout-source.ts',
  './run-categorical-box-heldout.ts',
] as const

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function resolveTypescriptImport(parentPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(parentPath), specifier)
  const extension = extname(base)
  if (extension === '.json' || extension === '.node') return undefined
  const candidates = extension
    ? [extension === '.js' ? `${base.slice(0, -3)}.ts` : base]
    : [`${base}.ts`, join(base, 'index.ts')]
  return candidates[0]
}

function importsOf(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\bimport\s*['"]([^'"]+)['"]/gu,
  ]
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) specifiers.push(specifier)
    }
  return [...new Set(specifiers)]
}

/** Hashes the new dispatcher’s complete local import graph plus historical runner receipts. */
export async function categoricalBoxHeldoutProducerSourceManifest(): Promise<
  Record<string, string>
> {
  const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
  const projectRoot = resolve(benchmarkRoot, '../..')
  const sourcePaths = new Set<string>()
  const visited = new Set<string>()
  const queue = dispatcherEntries.map((entry) => resolve(benchmarkRoot, entry))
  for (const entry of includedBenchmarkFiles) {
    const path = resolve(benchmarkRoot, entry)
    sourcePaths.add(path)
    if (entry.endsWith('.ts')) queue.push(path)
  }

  while (queue.length > 0) {
    const current = queue.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)
    sourcePaths.add(current)
    const source = await readFile(current, 'utf8')
    for (const specifier of importsOf(source)) {
      const imported = resolveTypescriptImport(current, specifier)
      if (!imported) continue
      const relativeToRoot = relative(projectRoot, imported)
      if (relativeToRoot.startsWith(`src${sep}`)) continue
      try {
        await readFile(imported)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          throw new TypeError(`Unresolved local benchmark import: ${specifier}`)
        throw error
      }
      queue.push(imported)
    }
  }

  const srcRoot = resolve(projectRoot, 'src')
  async function sourceFilesUnder(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const children = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return sourceFilesUnder(path)
        return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
      }),
    )
    return children.flat()
  }
  const files = [...sourcePaths, ...(await sourceFilesUnder(srcRoot))].sort()
  const output: Record<string, string> = {}
  for (const path of files) {
    const projectRelative = relative(projectRoot, path).split(sep).join('/')
    const label = projectRelative.startsWith('src/')
      ? projectRelative
      : relative(benchmarkRoot, path).split(sep).join('/')
    const normalizedLabel =
      label.startsWith('src/') || label.startsWith('../') ? label : `./${label}`
    output[normalizedLabel] = sha256(await readFile(path))
  }
  return output
}

export function boxHeldoutImportSpecifiers(source: string): readonly string[] {
  return importsOf(source)
}
