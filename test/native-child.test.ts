import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { NativeChildPool } from '../src/infrastructure/segmentation/native-child.js'

interface Payload {
  logPath: string
  delayMs: number
}

await test('running cancellation retains capacity and its promise until owned child close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-native-child-'))
  const logPath = join(directory, 'starts.txt')
  const workerPath = join(directory, 'worker.mjs')
  await writeFile(
    workerPath,
    "import { appendFileSync } from 'node:fs'; let text=''; for await (const c of process.stdin) text+=c; const input=JSON.parse(text); appendFileSync(input.logPath, input.id+'\\n'); setTimeout(()=>process.stdout.write(JSON.stringify({id:input.id})), input.delayMs);",
  )
  const pool = new NativeChildPool<Payload>({
    workerUrl: pathToFileURL(workerPath),
    maxActive: 1,
    maxWaiting: 2,
    abortGraceMs: 250,
    jobTimeoutMs: 5000,
    encode: (job) => Buffer.from(JSON.stringify({ id: job.id, ...job.payload })),
    decode: (value, id) => {
      assert.deepEqual(value, { id })
      return id
    },
  })
  const controller = new AbortController()
  const started = Date.now()
  const first = pool.run({ logPath, delayMs: 2000 }, controller.signal)
  const second = pool.run({ logPath, delayMs: 0 }, new AbortController().signal)
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort(new Error('fixture cancellation'))
  const early = await Promise.race([
    first.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 180)),
  ])
  assert.equal(early, 'waiting')
  await assert.rejects(first, /fixture cancellation/)
  assert.ok(Date.now() - started >= 250)
  await second
  await pool.settle()
  const starts = (await readFile(logPath, 'utf8')).trim().split('\n')
  assert.equal(starts.length, 2)
  await pool.dispose()
  await rm(directory, { recursive: true, force: true })
})

await test('malformed child replies are fenced to that job and settle before reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-native-child-fault-'))
  const workerPath = join(directory, 'worker.mjs')
  await writeFile(
    workerPath,
    "let text=''; for await (const c of process.stdin) text+=c; const input=JSON.parse(text); if(input.bad) process.stdout.write('{'); else process.stdout.write(JSON.stringify({id:input.id}));",
  )
  const pool = new NativeChildPool<{ bad: boolean }>({
    workerUrl: pathToFileURL(workerPath),
    encode: (job) => Buffer.from(JSON.stringify({ id: job.id, ...job.payload })),
    decode: (value, id) => {
      assert.deepEqual(value, { id })
      return id
    },
  })
  await assert.rejects(pool.run({ bad: true }, new AbortController().signal))
  await pool.settle()
  assert.match(
    String(await pool.run({ bad: false }, new AbortController().signal)),
    /^[0-9a-f-]{36}$/,
  )
  await pool.dispose()
  await rm(directory, { recursive: true, force: true })
})

await test('native worker exits when its parent IPC channel is lost', async () => {
  const workerPath = fileURLToPath(
    new URL('../src/infrastructure/segmentation/native-worker.ts', import.meta.url),
  )
  const child = fork(workerPath, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  const ready = new Promise<unknown>((resolve) => child.once('message', resolve))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.deepEqual(await ready, { type: 'ready' })
  child.stdin?.end()
  child.disconnect()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Native child did not exit after parent disconnect')),
      1000,
    )
  })
  const outcome = await Promise.race([exited, timeout]).finally(() => clearTimeout(timer))
  assert.equal(outcome.code, 1)
})

await test('early child exit rejects and drains queued work without leaking stdin errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-native-child-early-exit-'))
  const workerPath = join(directory, 'worker.mjs')
  await writeFile(workerPath, 'process.stdin.destroy(); setTimeout(() => process.exit(1), 20)')
  const pool = new NativeChildPool<{ value: number }>({
    workerUrl: pathToFileURL(workerPath),
    maxActive: 1,
    maxWaiting: 2,
    encode: (job) => Buffer.from(JSON.stringify({ id: job.id, ...job.payload })),
    decode: (value) => value,
  })
  const first = pool.run({ value: 1 }, new AbortController().signal)
  const second = pool.run({ value: 2 }, new AbortController().signal)
  await assert.rejects(first)
  await assert.rejects(second)
  await pool.settle()
  await pool.dispose()
  await rm(directory, { recursive: true, force: true })
})
