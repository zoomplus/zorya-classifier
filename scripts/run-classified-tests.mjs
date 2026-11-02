import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestCommand, listGroup, validateCatalog } from './test-catalog.ts'

const groups = ['portable', 'local-evidence', 'python-native', 'mcp']
const group = process.argv[2] ?? 'portable'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

async function main() {
  if (!groups.includes(group)) {
    console.error(`Usage: node scripts/run-classified-tests.mjs [${groups.join('|')}]`)
    process.exitCode = 2
    return
  }

  const catalog = await validateCatalog()
  const files = await listGroup(group, catalog)
  const prerequisites = catalog.prerequisites?.[group]
  if (prerequisites?.summary) console.error(`Prerequisites: ${prerequisites.summary}`)
  if (prerequisites?.knownFailures)
    console.error(`Known failures without prerequisites: ${prerequisites.knownFailures}`)

  const command = createTestCommand(group, repositoryRoot, files)
  const result = spawnSync(process.execPath, command.args, {
    cwd: command.cwd,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

let invokedAsEntry = false
if (process.argv[1] !== undefined) {
  try {
    invokedAsEntry = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    invokedAsEntry = false
  }
}
if (invokedAsEntry) await main()
