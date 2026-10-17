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
await test('architecture gate accepts ports and rejects reversed dependencies cross-platform', async () => {
  await check({
    'entities/value.ts': 'export const value=1',
    'features/use.ts': "import {value} from '../entities/value.js';export {value}",
  })
  await assert.rejects(
    check({
      'entities/bad.ts': "import '../infrastructure/adapter.js'",
      'infrastructure/adapter.ts': 'export {}',
    }),
    /must not import infrastructure/,
  )
})
await test('architecture gate rejects private, escaped and cyclic imports', async () => {
  await assert.rejects(check({ 'app/bad.ts': "import '@element/private'" }), /private import/)
  await assert.rejects(check({ 'app/bad.ts': "import '../../private.js'" }), /escapes src/)
  await assert.rejects(
    check({ 'features/a.ts': "import './b.js'", 'features/b.ts': "import './a.js'" }),
    /Import cycle/,
  )
})
