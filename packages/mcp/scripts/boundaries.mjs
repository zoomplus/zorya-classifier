import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

const sourceRoot = resolve('src')
const allowedLibraryExports = new Set([
  'zorya-classifier',
  'zorya-classifier/openrouter',
  'zorya-classifier/openai-compatible',
  'zorya-classifier/segmentation',
])
const restrictedImports = new Map([
  ['core', new Set(['auth', 'http', 'media', 'viewer'])],
  ['library', new Set(['auth', 'http', 'media', 'tools', 'viewer'])],
  ['tools', new Set(['auth', 'http', 'media', 'viewer'])],
  ['stdio', new Set(['auth', 'http', 'media', 'viewer'])],
])

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (entry.isFile() && extname(entry.name) === '.ts') files.push(path)
    else if (!entry.isFile())
      throw new Error(`Unexpected source entry: ${relative(sourceRoot, path)}`)
  }
  return files
}

const failures = []
for (const path of await sourceFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, path)
  const layer = relativePath.split(sep)[0]
  const text = await readFile(path, 'utf8')
  for (const match of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/gu)) {
    const specifier = match[1]
    if (specifier === undefined) continue
    if (specifier.startsWith('zorya-classifier') && !allowedLibraryExports.has(specifier)) {
      failures.push(`${relativePath}: unpublished zorya-classifier subpath ${specifier}`)
    }
    if (specifier.startsWith('/') || specifier.startsWith('file:') || specifier.includes('/src/')) {
      failures.push(`${relativePath}: external source-tree import ${specifier}`)
    }
    if (!specifier.startsWith('.')) continue
    const destination = resolve(join(path, '..'), specifier)
    const destinationRelative = relative(sourceRoot, destination)
    if (destinationRelative === '..' || destinationRelative.startsWith(`..${sep}`)) {
      failures.push(`${relativePath}: import escapes package source ${specifier}`)
      continue
    }
    const topSegment = destinationRelative.split(sep)[0]
    if (restrictedImports.get(layer)?.has(topSegment)) {
      failures.push(
        `${relativePath}: ${layer} layer imports ${topSegment} implementation ${specifier}`,
      )
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `MCP package boundary violations (${failures.length}):\n${failures.join('\n')}\n`,
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    `MCP package boundaries passed for ${await sourceFiles(sourceRoot).then((files) => files.length)} source files.\n`,
  )
}
