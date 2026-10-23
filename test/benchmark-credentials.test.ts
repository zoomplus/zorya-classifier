import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  readOpenRouterKeyFromEnvFile,
  readOpenRouterKeyFromProcessEnv,
} from '../benchmarks/credentials.js'

const secret = 'fixture-one'
const otherValidSecret = 'fixture-two'

function assertSafeRejectionMessage(message: string, envPath: string): void {
  assert.ok(!message.includes(secret))
  assert.ok(!message.includes(otherValidSecret))
  assert.ok(!message.includes(envPath))
}

await test('readOpenRouterKeyFromProcessEnv accepts a valid injected env value', () => {
  const key = readOpenRouterKeyFromProcessEnv({ OPENROUTER_API_KEY: secret })
  assert.equal(key, secret)
})

await test('readOpenRouterKeyFromProcessEnv rejects missing, blank, whitespace and oversized keys', () => {
  for (const env of [
    {},
    { OPENROUTER_API_KEY: '' },
    { OPENROUTER_API_KEY: '   ' },
    { OPENROUTER_API_KEY: `${secret} trailing` },
    { OPENROUTER_API_KEY: 'x'.repeat(4097) },
  ]) {
    assert.throws(() => readOpenRouterKeyFromProcessEnv(env), /unavailable/u)
  }
})

await test('readOpenRouterKeyFromEnvFile reads the explicit file when process env holds a different valid key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-cred-env-'))
  try {
    const envPath = join(directory, 'provider.env')
    await writeFile(envPath, `OPENROUTER_API_KEY=${secret}\n`, 'utf8')
    const previous = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = otherValidSecret
    try {
      assert.equal(await readOpenRouterKeyFromEnvFile(envPath), secret)
      assert.equal(process.env.OPENROUTER_API_KEY, otherValidSecret)
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = previous
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('readOpenRouterKeyFromEnvFile rejects missing and invalid explicit files despite valid process env', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-cred-bad-'))
  const previous = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = otherValidSecret
  try {
    const missing = join(directory, 'missing.env')
    await assert.rejects(readOpenRouterKeyFromEnvFile(missing), /missing or unreadable/u)

    const blankPath = join(directory, 'blank.env')
    await writeFile(blankPath, 'OPENROUTER_API_KEY=\n', 'utf8')
    await assert.rejects(readOpenRouterKeyFromEnvFile(blankPath), /does not contain a valid key/u)

    const whitespacePath = join(directory, 'whitespace.env')
    await writeFile(whitespacePath, 'OPENROUTER_API_KEY=  \n', 'utf8')
    await assert.rejects(
      readOpenRouterKeyFromEnvFile(whitespacePath),
      /does not contain a valid key/u,
    )
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previous
    await rm(directory, { recursive: true, force: true })
  }
})

await test('readOpenRouterKeyFromEnvFile rejection messages never echo secrets, invalid contents, or file paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-cred-leak-'))
  try {
    const cases = [
      { name: 'blank.env', contents: 'OPENROUTER_API_KEY=\n' },
      { name: 'whitespace.env', contents: 'OPENROUTER_API_KEY=  \n' },
      { name: 'interior-space.env', contents: 'OPENROUTER_API_KEY=sk-or-has interior-space\n' },
    ] as const
    for (const { name, contents } of cases) {
      const envPath = join(directory, name)
      await writeFile(envPath, contents, 'utf8')
      try {
        await readOpenRouterKeyFromEnvFile(envPath)
        assert.fail(`expected rejection for ${name}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /does not contain a valid key/u)
        assertSafeRejectionMessage(message, envPath)
        assert.ok(!message.includes(contents.trim()))
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
