import { lstat, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const helperFilePath = fileURLToPath(import.meta.url)
const srcRoot = resolve(dirname(helperFilePath), '../src')

function posixRelative(fromDirectory: string, absolutePath: string): string {
  return relative(fromDirectory, absolutePath).split(sep).join('/')
}

function codeUnitLexicalCompare(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

async function walkRuntimeSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new TypeError(`Symlink under src is not allowed: ${posixRelative(srcRoot, entryPath)}`)
    }
    if (entry.isDirectory()) {
      files.push(...(await walkRuntimeSourceFiles(entryPath)))
      continue
    }
    if (entry.isFile()) {
      if (entry.name.endsWith('.ts')) files.push(entryPath)
      continue
    }
    throw new TypeError(`Non-regular entry under src is not allowed: ${entryPath}`)
  }
  return files
}

/** Appends the shared helper and every missing runtime TypeScript path under src after an unchanged prefix. */
export async function appendRuntimeSourceFiles(
  listedPaths: readonly string[],
  callerModuleUrl: string | URL,
): Promise<string[]> {
  const callerDirectory = resolve(fileURLToPath(callerModuleUrl), '..')
  const resolvedIdentities = new Set<string>()
  for (const listedPath of listedPaths) resolvedIdentities.add(resolve(callerDirectory, listedPath))

  const output = [...listedPaths]

  const helperRelative = posixRelative(callerDirectory, helperFilePath)
  if (!resolvedIdentities.has(helperFilePath)) {
    output.push(helperRelative)
    resolvedIdentities.add(helperFilePath)
  }

  const srcRootStat = await lstat(srcRoot)
  if (srcRootStat.isSymbolicLink()) {
    throw new TypeError(`Symlink src root is not allowed: ${srcRoot}`)
  }
  if (!srcRootStat.isDirectory()) {
    throw new TypeError(`src root is not a directory: ${srcRoot}`)
  }

  const runtimeFiles = (await walkRuntimeSourceFiles(srcRoot)).sort((left, right) =>
    codeUnitLexicalCompare(posixRelative(srcRoot, left), posixRelative(srcRoot, right)),
  )

  for (const absolutePath of runtimeFiles) {
    if (resolvedIdentities.has(absolutePath)) continue
    output.push(posixRelative(callerDirectory, absolutePath))
    resolvedIdentities.add(absolutePath)
  }

  return output
}
