import { readdir, readFile } from 'node:fs/promises'
import { resolve, dirname, relative, sep, isAbsolute } from 'node:path'
import ts from 'typescript'
const root = resolve('src')
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((e) => (e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)])),
    )
  )
    .flat()
    .filter((p) => p.endsWith('.ts'))
}
const graph = new Map()
const violations = []
for (const path of await files(root)) {
  const text = await readFile(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const dependencies = []
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text
      if (
        spec.startsWith('@element/') ||
        spec.includes('/root/') ||
        spec.includes('workspace:') ||
        isAbsolute(spec) ||
        /^[A-Za-z]:[\\/]/.test(spec)
      )
        violations.push(`${relative(root, path)}: private import ${spec}`)
      if (spec.startsWith('.')) {
        const target = resolve(dirname(path), spec.replace(/\.js$/, '.ts'))
        if (!target.startsWith(root + sep)) violations.push(`Import escapes src: ${path}`)
        dependencies.push(target)
        const from = relative(root, path).split(sep)[0],
          to = relative(root, target).split(sep)[0]
        if (
          ['entities', 'shared', 'features', 'processes'].includes(from) &&
          to === 'infrastructure'
        )
          violations.push(`${from} must not import infrastructure: ${path}`)
        if (from === 'entities' && !['entities', 'shared'].includes(to))
          violations.push(`Entities dependency: ${path}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  graph.set(path, dependencies)
}
const done = new Set(),
  visiting = new Set()
function walk(path) {
  if (visiting.has(path)) {
    violations.push(`Import cycle: ${path}`)
    return
  }
  if (done.has(path)) return
  visiting.add(path)
  for (const next of graph.get(path) ?? []) walk(next)
  visiting.delete(path)
  done.add(path)
}
for (const path of graph.keys()) walk(path)
if (violations.length) throw new Error(violations.join('\n'))
console.log(`Boundaries and import cycles passed (${graph.size} modules)`)
