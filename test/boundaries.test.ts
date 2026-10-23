import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/boundaries.mjs', import.meta.url))

async function check(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'zorya-boundaries-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, 'src', name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    }
    return await exec(process.execPath, [script], { cwd: root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await test('architecture gate accepts allowed layer edges cross-platform', async () => {
  await check({
    'entities/errors.ts': 'export class ClassifierError extends Error {}',
    'entities/value.ts': 'export const value=1',
    'shared/gate.ts': "import { ClassifierError } from '../entities/errors.js'",
    'features/use.ts': "import {value} from '../entities/value.js';export {value}",
    'processes/run.ts': "import {value} from '../features/use.js'",
    'infrastructure/raster.ts': "import {value} from '../features/use.js'",
    'app/cli-route.ts': "import { createOpenRouterVision } from '../openrouter.js'; export {}",
    'openrouter.ts': 'export { value } from "./infrastructure/openrouter.js"',
    'infrastructure/openrouter.ts': 'export const value=1',
  })
})

await test('architecture gate rejects reversed dependencies', async () => {
  await assert.rejects(
    check({
      'entities/bad.ts': "import '../infrastructure/adapter.js'",
      'infrastructure/adapter.ts': 'export {}',
    }),
    /Entities dependency|must not import infrastructure/,
  )
  await assert.rejects(
    check({
      'features/bad.ts': "import '../processes/run.js'",
      'processes/run.ts': 'export {}',
    }),
    /features must not import processes/,
  )
  await assert.rejects(
    check({
      'infrastructure/bad.ts': "import '../app/cli.js'",
      'app/cli.ts': 'export {}',
    }),
    /infrastructure must not import app/,
  )
})

await test('architecture gate rejects private, escaped, alias and cyclic imports', async () => {
  await assert.rejects(check({ 'app/bad.ts': "import '@element/private'" }), /private import/)
  await assert.rejects(check({ 'app/bad.ts': "import '../../private.js'" }), /escapes src/)
  await assert.rejects(
    check({ 'app/bad.ts': "import '@unknown-scope/not-in-package-json'" }),
    /unresolved alias/,
  )
  await assert.rejects(
    check({ 'features/a.ts': "import './b.js'", 'features/b.ts': "import './a.js'" }),
    /Import cycle/,
  )
})

await test('architecture gate rejects type-only and dynamic import bypasses', async () => {
  await assert.rejects(
    check({
      'entities/bad.ts': "import type { X } from '../infrastructure/x.js'",
      'infrastructure/x.ts': 'export type X = number',
    }),
    /Entities dependency|must not import infrastructure/,
  )
  await assert.rejects(
    check({
      'entities/bad.ts': 'export type Remote = import("../infrastructure/x.js").X',
      'infrastructure/x.ts': 'export type X = number',
    }),
    /Entities dependency|must not import infrastructure/,
  )
  await assert.rejects(
    check({
      'features/bad.ts': "type T = import('../infrastructure/x.js').X",
      'infrastructure/x.ts': 'export type X = number',
    }),
    /features must not import infrastructure/,
  )
  await assert.rejects(
    check({
      'shared/bad.ts': 'async function load(){await import("../infrastructure/x.js")}',
      'infrastructure/x.ts': 'export {}',
    }),
    /shared must not import infrastructure/,
  )
  await assert.rejects(
    check({
      'features/bad.ts': "const req = require('./req.js'); export { req }",
      'features/req.ts': "require('./bad.js')",
    }),
    /Import cycle/,
  )
})

await test('architecture gate rejects root barrel bypass outside app', async () => {
  await assert.rejects(
    check({
      'features/bad.ts': "import { createOpenRouterVision } from '../openrouter.js'",
      'openrouter.ts': "export { createOpenRouterVision } from './infrastructure/openrouter.js'",
      'infrastructure/openrouter.ts': 'export const createOpenRouterVision = () => null',
    }),
    /root barrel bypass/,
  )
})

await test('architecture gate rejects package self-imports outside cli-route', async () => {
  await assert.rejects(
    check({
      'features/bad.ts': "import { createOpenRouterVision } from 'zorya-classifier/openrouter'",
    }),
    /package self-import/,
  )
  await check({
    'app/cli-route.ts':
      "import { createOpenRouterVision } from 'zorya-classifier/openrouter'; export {}",
  })
})

await test('architecture gate rejects unresolved local modules', async () => {
  await assert.rejects(
    check({ 'features/bad.ts': "import { x } from './missing-target.js'" }),
    /unresolved local module/,
  )
})

await test('architecture gate accepts declared scoped external dependencies', async () => {
  await check({
    'shared/eslint-types.ts':
      "import type { Linter } from '@eslint/js'; export type T = Linter.Config",
  })
})

await test('architecture gate resolves .js specifiers to .ts sources', async () => {
  await check({
    'entities/errors.ts': 'export class ClassifierError extends Error {}',
    'shared/scope.ts': "import { ClassifierError } from '../entities/errors.js'",
  })
})
