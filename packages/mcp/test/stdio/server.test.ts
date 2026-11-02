import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const fixturePath = fileURLToPath(new URL('./child-server.ts', import.meta.url))
const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const harnessTimeoutMs = 10_000
const expectedTools = [
  'zorya_cancel_job',
  'zorya_capabilities',
  'zorya_classify',
  'zorya_extract',
  'zorya_get_job',
  'zorya_locate',
]

await test('stdio subprocess negotiates the modern SDK protocol', { timeout: 15_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fixturePath],
    cwd: packageRoot,
    stderr: 'ignore',
    maxBufferSize: 32 * 1024 * 1024,
  })
  const client = new Client(
    { name: 'zorya-stdio-modern-test', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  )
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedTools)
  } finally {
    await client.close()
  }
})

await test(
  'stdio subprocess serves the frozen legacy SDK protocol',
  { timeout: 15_000 },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fixturePath],
      cwd: packageRoot,
      stderr: 'ignore',
      maxBufferSize: 32 * 1024 * 1024,
    })
    const client = new Client(
      { name: 'zorya-stdio-legacy-test', version: '0.1.0' },
      { versionNegotiation: { mode: 'legacy' } },
    )
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedTools)
    } finally {
      await client.close()
    }
  },
)

await test(
  'stdio EOF performs graceful shutdown without protocol stdout noise',
  { timeout: 15_000 },
  async () => {
    const eofFixture = startFixture()
    const eofOutput = captureStdout(eofFixture.child)
    await Promise.all([waitForSpawn(eofFixture.child), eofFixture.ready])
    eofFixture.child.stdin.end()
    await waitForExit(eofFixture.child)
    assert.equal(eofFixture.child.exitCode, 0)
    assert.equal(eofOutput(), '')
  },
)

await test(
  'stdio SIGTERM performs graceful shutdown without protocol stdout noise',
  {
    timeout: 15_000,
    skip:
      process.platform === 'win32'
        ? 'Windows terminates child processes for SIGTERM instead of delivering a catchable POSIX signal.'
        : false,
  },
  async () => {
    const signalFixture = startFixture()
    const signalOutput = captureStdout(signalFixture.child)
    await Promise.all([waitForSpawn(signalFixture.child), signalFixture.ready])
    signalFixture.child.kill('SIGTERM')
    await waitForExit(signalFixture.child)
    assert.equal(signalFixture.child.exitCode, 0)
    assert.equal(signalOutput(), '')
  },
)

function startFixture(): { child: ChildProcessWithoutNullStreams; ready: Promise<void> } {
  const child = spawn(process.execPath, ['--import', 'tsx', fixturePath], {
    cwd: packageRoot,
    stdio: 'pipe',
    env: { PATH: process.env['PATH'] ?? '' },
  })
  let stderr = ''
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const readyTimer = setTimeout(() => {
    rejectReady?.(new Error('The stdio fixture did not become ready in time.'))
    child.kill('SIGKILL')
  }, harnessTimeoutMs)
  const resolveReadyAndClearTimer = (): void => {
    clearTimeout(readyTimer)
    resolveReady?.()
  }
  const rejectReadyAndClearTimer = (error: Error): void => {
    clearTimeout(readyTimer)
    rejectReady?.(error)
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (stderr.includes('MCP_READY\n')) resolveReadyAndClearTimer()
  })
  child.once('error', rejectReadyAndClearTimer)
  child.once('exit', (code, signal) => {
    if (code !== 0 || signal !== null) {
      rejectReadyAndClearTimer(new Error('The stdio fixture exited before readiness.'))
    }
  })
  return { child, ready }
}

function captureStdout(child: ChildProcessWithoutNullStreams): () => string {
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
  })
  return () => output
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (await exitWithin(child, harnessTimeoutMs)) return
  child.kill('SIGKILL')
  await exitWithin(child, 2_000)
  throw new Error('The stdio fixture did not exit before the harness timeout.')
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      once(child, 'spawn'),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('The stdio fixture did not spawn before the harness timeout.')),
          harnessTimeoutMs,
        )
      }),
    ])
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function exitWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      once(child, 'exit').then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
