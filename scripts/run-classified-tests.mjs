import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listGroup, validateCatalog } from './test-catalog.ts'

const groups = ['portable', 'local-evidence', 'python-native']
const group = process.argv[2] ?? 'portable'
if (!groups.includes(group)) {
  console.error(`Usage: node scripts/run-classified-tests.mjs [${groups.join('|')}]`)
  process.exit(2)
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const catalog = await validateCatalog()
const files = await listGroup(group, catalog)
const prerequisites = catalog.prerequisites?.[group]
if (prerequisites?.summary) console.error(`Prerequisites: ${prerequisites.summary}`)
if (prerequisites?.knownFailures)
  console.error(`Known failures without prerequisites: ${prerequisites.knownFailures}`)

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=2', ...files],
  { cwd: repositoryRoot, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
