import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const packageRoot = process.argv[2]
const npmCli = process.argv[3]
if (packageRoot === undefined || npmCli === undefined)
  throw new Error('Installed package paths are required.')
const temporary = await mkdtemp(join(tmpdir(), 'zorya-mcp-cli-consumer-'))
const configPath = join(temporary, 'runtime.json')
const configuration = {
  transport: 'stdio',
  core: {
    profiles: {
      explicit: {
        id: 'explicit',
        adapter: 'openai-compatible-vision',
        credentialMode: 'none',
        endpoint: 'https://provider.example.test/v1/chat/completions',
        model: 'fixture/explicit-model',
      },
    },
    defaultProfileId: 'explicit',
  },
  credentialVault: { mode: 'memory-only' },
  remoteImageHosts: [],
}
await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' })
const childEnvironment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)
childEnvironment['ZORYA_MCP_CONFIG'] = configPath

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    npmCli,
    'exec',
    '--offline',
    '--silent',
    '--prefix',
    packageRoot,
    '--',
    'zorya-classifier-mcp',
  ],
  cwd: packageRoot,
  env: childEnvironment,
  stderr: 'pipe',
})
const client = new Client(
  { name: 'installed-cli-consumer-smoke', version: '0.1.0' },
  {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  },
)
try {
  await client.connect(transport)
  const result = await client.callTool({ name: 'zorya_capabilities', arguments: {} })
  assert.notEqual(result.isError, true)
  assert.ok(result.structuredContent)
  assert.equal(result.structuredContent.profiles[0].id, 'explicit')
} finally {
  try {
    await client.close()
  } finally {
    await rm(temporary, { recursive: true })
  }
}
