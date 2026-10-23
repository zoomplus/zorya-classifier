import assert from 'node:assert/strict'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { appendRuntimeSourceFiles } from '../benchmarks/runtime-source-files.js'
import { currentRuntimeSourcePaths } from './fixtures/current-runtime-sources.js'

const callerUrl = import.meta.url
const callerDirectory = resolve(fileURLToPath(callerUrl), '..')
const projectRoot = resolve(callerDirectory, '..')
const helperRelativeFromTest = '../benchmarks/runtime-source-files.ts'

function callerRelativeSrcKey(projectRelativeSrcPath: string): string {
  return relative(callerDirectory, resolve(projectRoot, projectRelativeSrcPath))
    .split(sep)
    .join('/')
}

await test('appendRuntimeSourceFiles keeps prefix order and completes runtime src inventory', async () => {
  const inventory = await currentRuntimeSourcePaths()
  const prefix = ['../benchmarks/v02/protocol.ts', '../src/app/create-classifier.ts'] as const
  const resolved = await appendRuntimeSourceFiles(prefix, callerUrl)

  assert.deepEqual(resolved.slice(0, prefix.length), prefix)

  for (const srcPath of inventory) {
    const key = callerRelativeSrcKey(srcPath)
    assert.ok(resolved.includes(key), `missing runtime source ${key}`)
  }

  const suffix = resolved.slice(prefix.length)
  const runtimeSuffix = suffix.filter((entry) => entry.startsWith('../src/'))
  assert.deepEqual(
    runtimeSuffix,
    [...runtimeSuffix].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  )

  assert.equal(suffix.filter((entry) => entry === helperRelativeFromTest).length, 1)
})

await test('appendRuntimeSourceFiles deduplicates path-equivalent prefix spellings', async () => {
  const prefix = ['../src/app/../app/create-classifier.ts', helperRelativeFromTest] as const
  const resolved = await appendRuntimeSourceFiles(prefix, callerUrl)

  assert.deepEqual(resolved.slice(0, prefix.length), prefix)
  assert.equal(
    resolved.filter(
      (entry) =>
        resolve(callerDirectory, entry) === resolve(projectRoot, 'src/app/create-classifier.ts'),
    ).length,
    1,
  )
  assert.equal(resolved.filter((entry) => entry === helperRelativeFromTest).length, 1)
})
