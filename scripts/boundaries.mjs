import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, dirname, relative, sep, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDir, '..')
const root = resolve(process.cwd(), 'src')
const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
const packageName = packageJson.name
const declaredPackages = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
])

const layerTargets = {
  app: new Set(['app', 'processes', 'features', 'entities', 'shared', 'infrastructure']),
  processes: new Set(['processes', 'features', 'entities', 'shared']),
  features: new Set(['features', 'entities', 'shared']),
  infrastructure: new Set(['infrastructure', 'features', 'entities', 'shared']),
  entities: new Set(['entities', 'shared']),
  shared: new Set(['shared']),
}

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
      ),
    )
  )
    .flat()
    .filter((path) => path.endsWith('.ts'))
}

function layerOf(relativePath) {
  return relativePath.split(sep)[0]
}

function isSrcRootFile(relativePath) {
  return !relativePath.includes(sep)
}

const sharedEntitiesErrorsPath = join('entities', 'errors.ts')

function sharedMayImportEntities(relativeFrom, relativeTarget) {
  return layerOf(relativeFrom) === 'shared' && relativeTarget === sharedEntitiesErrorsPath
}

async function resolveTsModule(fromPath, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromPath), spec)
  const candidates = [
    base,
    `${base}.ts`,
    join(base, 'index.ts'),
    base.replace(/\.js$/u, '.ts'),
    join(base.replace(/\.js$/u, ''), 'index.ts'),
  ]
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}

function moduleStringFromImportTypeNode(node) {
  if (!ts.isImportTypeNode(node) || !node.argument) return null
  if (ts.isStringLiteral(node.argument)) return node.argument.text
  if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
    return node.argument.literal.text
  }
  return null
}

function relativeImportEscapesSrc(fromPath, spec) {
  if (!spec.startsWith('.')) return false
  const resolved = normalize(resolve(dirname(fromPath), spec))
  return !resolved.startsWith(root + sep)
}

function collectModuleSpecifiers(source) {
  const specs = []
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push({ spec: node.moduleSpecifier.text, kind: 'static' })
    }
    if (ts.isImportTypeNode(node)) {
      const importTypeSpec = moduleStringFromImportTypeNode(node)
      if (importTypeSpec) specs.push({ spec: importTypeSpec, kind: 'import-type' })
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push({ spec: node.arguments[0].text, kind: 'dynamic-import' })
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push({ spec: node.arguments[0].text, kind: 'require' })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specs
}

function packageNameFromSpecifier(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec
  }
  return spec.split('/')[0] ?? spec
}

function isPackageSelfImport(spec) {
  return spec === packageName || spec.startsWith(`${packageName}/`)
}

function checkPrivateImport(relativePath, spec) {
  if (
    spec.startsWith('@element/') ||
    spec.includes('/root/') ||
    spec.includes('workspace:') ||
    isAbsolute(spec) ||
    /^[A-Za-z]:[\\/]/u.test(spec)
  ) {
    return `${relativePath}: private import ${spec}`
  }
  return null
}

function checkPackageSelfImport(relativePath, spec) {
  if (!isPackageSelfImport(spec)) return null
  if (relativePath === join('app', 'cli-route.ts')) return null
  return `${relativePath}: package self-import ${spec} (root barrel bypass)`
}

function checkLayerEdge(relativeFrom, relativeTarget) {
  if (isSrcRootFile(relativeFrom) && isSrcRootFile(relativeTarget)) return null
  const fromLayer = layerOf(relativeFrom)
  if (isSrcRootFile(relativeTarget)) {
    if (fromLayer === 'app' || isSrcRootFile(relativeFrom)) return null
    return `${relativeFrom}: root barrel bypass via ${relativeTarget}`
  }
  const toLayer = layerOf(relativeTarget)
  if (!layerTargets[fromLayer]) return null
  if (sharedMayImportEntities(relativeFrom, relativeTarget)) return null
  if (!layerTargets[fromLayer].has(toLayer)) {
    if (fromLayer === 'entities' && !['entities', 'shared'].includes(toLayer)) {
      return `Entities dependency: ${relativeFrom} -> ${relativeTarget}`
    }
    if (
      ['entities', 'shared', 'features', 'processes'].includes(fromLayer) &&
      toLayer === 'infrastructure'
    ) {
      return `${fromLayer} must not import infrastructure: ${relativeFrom}`
    }
    if (fromLayer === 'infrastructure' && (toLayer === 'app' || toLayer === 'processes')) {
      return `infrastructure must not import ${toLayer}: ${relativeFrom}`
    }
    if (fromLayer !== toLayer) {
      return `${fromLayer} must not import ${toLayer}: ${relativeFrom} -> ${relativeTarget}`
    }
  }
  return null
}

const graph = new Map()
const violations = []

for (const path of await files(root)) {
  const text = await readFile(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const dependencies = []
  const relativePath = relative(root, path)

  for (const { spec, kind } of collectModuleSpecifiers(source)) {
    const privateViolation = checkPrivateImport(relativePath, spec)
    if (privateViolation) violations.push(privateViolation)

    const selfImportViolation = checkPackageSelfImport(relativePath, spec)
    if (selfImportViolation) violations.push(selfImportViolation)

    if (!spec.startsWith('.')) {
      if (spec.startsWith('node:')) continue
      if (isPackageSelfImport(spec)) continue
      const declared = declaredPackages.has(packageNameFromSpecifier(spec))
      if (!declared && (spec.startsWith('@') || spec.includes('*'))) {
        violations.push(`${relativePath}: unresolved alias import ${spec} (${kind})`)
      }
      continue
    }

    if (relativeImportEscapesSrc(path, spec)) {
      violations.push(`Import escapes src: ${relativePath} (${spec})`)
      continue
    }

    const target = await resolveTsModule(path, spec)
    if (!target) {
      violations.push(`${relativePath}: unresolved local module ${spec} (${kind})`)
      continue
    }
    const normalizedTarget = normalize(target)
    if (!normalizedTarget.startsWith(root + sep)) {
      violations.push(`Import escapes src: ${relativePath} (${spec})`)
      continue
    }
    dependencies.push(normalizedTarget)
    const relativeTarget = relative(root, normalizedTarget)
    const layerViolation = checkLayerEdge(relativePath, relativeTarget)
    if (layerViolation) violations.push(layerViolation)
  }

  graph.set(path, dependencies)
}

const done = new Set()
const visiting = new Set()

function walk(path) {
  if (visiting.has(path)) {
    violations.push(`Import cycle: ${relative(root, path)}`)
    return
  }
  if (done.has(path)) return
  visiting.add(path)
  for (const next of graph.get(path) ?? []) walk(next)
  visiting.delete(path)
  done.add(path)
}

for (const path of graph.keys()) walk(path)

if (violations.length) throw new Error([...new Set(violations)].join('\n'))
console.log(`Boundaries and import cycles passed (${graph.size} modules)`)
