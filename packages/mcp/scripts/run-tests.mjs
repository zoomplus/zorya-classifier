import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { extname, join, resolve } from 'node:path'

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const matches = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) matches.push(...(await collect(path)))
    else if (entry.isFile() && extname(entry.name) === '.ts' && entry.name.endsWith('.test.ts'))
      matches.push(path)
    else if (entry.isFile() && extname(entry.name) === '.mjs' && entry.name.endsWith('.test.mjs'))
      matches.push(path)
    else if (!entry.isFile()) throw new Error('Unexpected test directory entry.')
  }
  return matches
}

const files = (await collect(resolve('test'))).sort()
if (files.length === 0) throw new Error('No MCP package tests were found.')
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
})
if (result.error) throw result.error
if (result.status === null) throw new Error('MCP test runner did not exit.')
process.exitCode = result.status
