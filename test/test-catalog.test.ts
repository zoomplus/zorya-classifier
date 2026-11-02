import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createTestCommand,
  discoverTestFiles,
  loadCatalog,
  validateCatalog,
  type TestCatalog,
} from '../scripts/test-catalog.js'
import { join } from 'node:path'

const exec = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const validateScript = fileURLToPath(
  new URL('../scripts/validate-test-catalog.mjs', import.meta.url),
)

await test('every repository test file has exactly one catalog classification', async () => {
  await exec(process.execPath, ['--import', 'tsx', validateScript], { cwd: repositoryRoot })
  const catalog = await loadCatalog()
  const total =
    catalog.groups.portable.length +
    catalog.groups['local-evidence'].length +
    catalog.groups['python-native'].length +
    catalog.groups.mcp.length
  assert.ok(total >= 120)
})

await test('MCP package tests have a dedicated exact classification', async () => {
  const catalog = await loadCatalog()
  const discoveredMcp = (await discoverTestFiles()).filter((file) =>
    file.startsWith('packages/mcp/test/'),
  )
  assert.deepEqual(catalog.groups.mcp, discoveredMcp)
})

await test('MCP test group delegates from the package directory without root TypeScript aliases', async () => {
  const catalog = await loadCatalog()
  const command = createTestCommand('mcp', repositoryRoot, catalog.groups.mcp)
  assert.equal(command.cwd, join(repositoryRoot, 'packages/mcp'))
  assert.deepEqual(command.args, ['scripts/run-tests.mjs'])

  const portable = createTestCommand('portable', repositoryRoot, ['test/classifier.test.ts'])
  assert.equal(portable.cwd, repositoryRoot)
  assert.deepEqual(portable.args, [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=2',
    'test/classifier.test.ts',
  ])
})

await test('portable catalog includes offline v03 evaluator suites', async () => {
  const catalog = await loadCatalog()
  const portable = catalog.groups.portable
  for (const file of [
    'benchmarks/v03/evaluate-h8-ordinary-vision.test.ts',
    'benchmarks/v03/evaluate-h10-clipseg.test.ts',
    'benchmarks/v03/evaluate-h11-sa2va.test.ts',
    'test/v03-h6-integrity-receipt-path-identity.test.ts',
  ]) {
    assert.ok(portable.includes(file), file)
  }
  assert.equal(
    portable.includes('benchmarks/v03/evaluate-h10-clipseg-local-evidence.test.ts'),
    false,
  )
})

await test('catalog validator rejects duplicate classifications', async () => {
  const catalog = await loadCatalog()
  const broken: TestCatalog = {
    ...catalog,
    groups: {
      ...catalog.groups,
      portable: [...catalog.groups.portable, catalog.groups['local-evidence'][0]!],
    },
  }
  await assert.rejects(validateCatalog(broken, await discoverTestFiles()), /classified in both/)
})

await test('catalog validator rejects missing catalog files', async () => {
  const catalog = await loadCatalog()
  const broken: TestCatalog = {
    ...catalog,
    groups: {
      ...catalog.groups,
      portable: [...catalog.groups.portable, 'test/does-not-exist-catalog-fixture.test.ts'],
    },
  }
  await assert.rejects(validateCatalog(broken, await discoverTestFiles()), /missing on disk/)
})

await test('catalog validator rejects unclassified discovered tests', async () => {
  const catalog = await loadCatalog()
  const discovered = await discoverTestFiles()
  const unclassified = 'test/unclassified-catalog-fixture.test.ts'
  await assert.rejects(
    validateCatalog(catalog, [...discovered, unclassified]),
    /Discovered test lacks classification/,
  )
})

await test('catalog validator refuses an unclassified new MCP package test', async () => {
  const catalog = await loadCatalog()
  const discovered = await discoverTestFiles()
  const unclassified = 'packages/mcp/test/core/new-unclassified.test.ts'
  await assert.rejects(
    validateCatalog(catalog, [...discovered, unclassified]),
    /Discovered test lacks classification/,
  )
})

await test('catalog validator keeps MCP and root test classifications in their own groups', async () => {
  const catalog = await loadCatalog()
  const discovered = await discoverTestFiles()
  const firstMcpTest = catalog.groups.mcp[0]
  assert.ok(firstMcpTest)
  const mcpAsPortable: TestCatalog = {
    ...catalog,
    groups: {
      ...catalog.groups,
      portable: [...catalog.groups.portable, firstMcpTest],
      mcp: catalog.groups.mcp.slice(1),
    },
  }
  await assert.rejects(
    validateCatalog(mcpAsPortable, discovered),
    /MCP test classified outside mcp group/,
  )

  const rootAsMcp: TestCatalog = {
    ...catalog,
    groups: {
      ...catalog.groups,
      mcp: [...catalog.groups.mcp, 'test/boundaries.test.ts'],
    },
  }
  await assert.rejects(
    validateCatalog(rootAsMcp, discovered),
    /Non-MCP test classified in mcp group/,
  )
})

await test('version-1 catalog fixtures without an MCP group retain an empty-group default', async () => {
  const catalog = await loadCatalog()
  const { mcp: _mcp, ...legacyGroups } = catalog.groups
  const legacyFixture = { ...catalog, groups: legacyGroups }
  const rootDiscovered = (await discoverTestFiles()).filter(
    (file) => !file.startsWith('packages/mcp/test/'),
  )
  const compatible = await validateCatalog(legacyFixture, rootDiscovered)
  assert.deepEqual(compatible.groups.mcp, [])
})

await test('catalog validator rejects malformed catalog shape at parse time', async () => {
  await assert.rejects(
    validateCatalog(
      {
        version: 1,
        groups: {
          portable: ['test/boundaries.test.ts'],
        },
      },
      ['test/boundaries.test.ts'],
    ),
    /Required|Invalid|Unrecognized|local-evidence|python-native/,
  )
})

await test('catalog validator rejects unknown catalog groups at parse time', async () => {
  const catalog = await loadCatalog()
  const broken = {
    ...catalog,
    groups: {
      ...catalog.groups,
      'unknown-group': ['test/boundaries.test.ts'],
    },
  }
  await assert.rejects(validateCatalog(broken, await discoverTestFiles()), /Unrecognized/)
})

await test('catalog validator rejects unknown catalog version at parse time', async () => {
  const catalog = await loadCatalog()
  const broken = {
    ...catalog,
    version: 2,
  }
  await assert.rejects(
    validateCatalog(broken, await discoverTestFiles()),
    /Invalid literal value|Expected/,
  )
})

await test('catalog validator rejects absolute paths and traversal segments', async () => {
  const catalog = await loadCatalog()
  const discovered = await discoverTestFiles()
  const cases = [
    '/test/boundaries.test.ts',
    '../test/boundaries.test.ts',
    'test/../secrets.test.ts',
  ]
  for (const badPath of cases) {
    const broken = {
      ...catalog,
      groups: {
        ...catalog.groups,
        portable: [...catalog.groups.portable, badPath],
      },
    }
    await assert.rejects(
      validateCatalog(broken, discovered),
      /relative|forward slash|parent|empty|\.test\.ts|repository root/,
    )
  }
})
