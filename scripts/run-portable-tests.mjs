import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listGroup, validateCatalog } from './test-catalog.ts'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

await validateCatalog()
const files = await listGroup('portable')
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=2', ...files],
  { cwd: repositoryRoot, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
