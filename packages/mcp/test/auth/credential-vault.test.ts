import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CredentialModelProfile } from '../../src/contracts.js'
import {
  assertEncryptedFileVaultPlatform,
  createCredentialVault,
} from '../../src/auth/credential-vault.js'

const profile: CredentialModelProfile = {
  id: 'primary',
  adapter: 'openrouter-vision',
  model: 'example/vision-model',
  provider: 'example-provider',
  credentialMode: 'byok',
}

await test(
  'encrypted credential vault isolates owners and survives restart without plaintext on disk',
  {
    skip:
      process.platform === 'win32'
        ? 'POSIX private-file permissions are unavailable on Windows.'
        : false,
  },
  async (context) => {
    const temp = await mkdtemp(join(tmpdir(), 'zorya-mcp-vault-'))
    const filePath = join(temp, 'private', 'credentials.json')
    const encryptionKey = Buffer.alloc(32, 21)
    context.after(async () => rm(temp, { recursive: true, force: true }))
    const first = await createCredentialVault({ mode: 'encrypted-file', filePath, encryptionKey })
    assert.equal(first.persistence, 'encrypted-file')
    await first.save({ ownerId: 'owner-a', profileId: 'primary', apiKey: 'fake-provider-key-a' })
    await first.save({ ownerId: 'owner-b', profileId: 'primary', apiKey: 'fake-provider-key-b' })
    await Promise.all([
      first.save({ ownerId: 'owner-c', profileId: 'primary', apiKey: 'example-provider-key-old' }),
      first.remove({ ownerId: 'owner-a', profileId: 'primary' }),
      first.save({ ownerId: 'owner-c', profileId: 'primary', apiKey: 'example-provider-key-new' }),
    ])
    const file = await readFile(filePath, 'utf8')
    assert.doesNotMatch(file, /fake-provider-key/u)
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    await first.dispose()
    const restarted = await createCredentialVault({
      mode: 'encrypted-file',
      filePath,
      encryptionKey,
    })
    context.after(() => restarted.dispose())
    const input = (ownerId: string) => ({
      profile,
      principal: { ownerId, transport: 'stdio' as const },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    })
    assert.deepEqual(await restarted.resolve(input('owner-b')), { apiKey: 'fake-provider-key-b' })
    assert.deepEqual(await restarted.resolve(input('owner-c')), {
      apiKey: 'example-provider-key-new',
    })
    await assert.rejects(restarted.resolve(input('owner-a')), /No provider credential/u)
    await restarted.remove({ ownerId: 'owner-a', profileId: 'primary' })
    await assert.rejects(restarted.resolve(input('owner-a')), /No provider credential/u)
  },
)

await test('memory-only vault is explicitly nonpersistent and validates its encryption key configuration', async () => {
  const memory = await createCredentialVault({ mode: 'memory-only' })
  assert.equal(memory.persistence, 'memory-only')
  await memory.save({ ownerId: 'owner-a', profileId: 'primary', apiKey: 'fake-memory-key' })
  await memory.dispose()
  await assert.rejects(
    memory.save({ ownerId: 'owner-a', profileId: 'primary', apiKey: 'fake-next-key' }),
    /closed/u,
  )
  await assert.rejects(
    createCredentialVault({
      mode: 'encrypted-file',
      filePath: '/tmp/should-not-be-created',
      encryptionKey: new Uint8Array(16),
    }),
    /exactly 32 bytes/u,
  )
})

await test('memory-only vault enforces the shared credential record capacity', async () => {
  const memory = await createCredentialVault({ mode: 'memory-only' })
  try {
    await Promise.all(
      Array.from({ length: 1_024 }, (_, index) =>
        memory.save({
          ownerId: 'bounded-owner',
          profileId: `profile-${index}`,
          apiKey: 'fake-key',
        }),
      ),
    )
    await assert.rejects(
      memory.save({ ownerId: 'bounded-owner', profileId: 'profile-over-cap', apiKey: 'fake-key' }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CAPACITY_LIMIT',
    )
    await memory.save({ ownerId: 'bounded-owner', profileId: 'profile-0', apiKey: 'replacement' })
    await memory.remove({ ownerId: 'bounded-owner', profileId: 'profile-0' })
    await memory.save({
      ownerId: 'bounded-owner',
      profileId: 'profile-over-cap',
      apiKey: 'fake-key',
    })
  } finally {
    await memory.dispose()
  }
})

await test('encrypted file vault rejects Windows where POSIX private-file mode checks are unavailable', () => {
  assert.throws(
    () => assertEncryptedFileVaultPlatform('win32'),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'UNSUPPORTED_OPERATION',
  )
  assert.doesNotThrow(() => assertEncryptedFileVaultPlatform('linux'))
})

await test(
  'encrypted vault startup rejects Windows with a typed unsupported-operation error',
  {
    skip: process.platform === 'win32' ? false : 'This startup rejection is specific to Windows.',
  },
  async () => {
    await assert.rejects(
      createCredentialVault({
        mode: 'encrypted-file',
        filePath: join(tmpdir(), 'must-not-be-created', 'credentials.json'),
        encryptionKey: Buffer.alloc(32, 11),
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'UNSUPPORTED_OPERATION',
    )
  },
)
