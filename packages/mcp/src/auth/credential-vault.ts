import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { z } from 'zod'
import type { CredentialModelProfile, CredentialPort } from '../contracts.js'
import type { Principal } from '../contracts.js'
import { McpCoreError } from '../errors.js'

const recordSchema = z
  .record(
    z.string(),
    z
      .object({
        nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
        tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
        ciphertext: z.string().max(12_000),
      })
      .strict(),
  )
  .refine((records) => Object.keys(records).length <= 1_024)

export type CredentialVaultConfig =
  | { readonly mode: 'memory-only' }
  | {
      readonly mode: 'encrypted-file'
      readonly filePath: string
      readonly encryptionKey: Uint8Array
    }

export interface CredentialVault extends CredentialPort {
  save(input: {
    readonly ownerId: string
    readonly profileId: string
    readonly apiKey: string
  }): Promise<void>
  remove(input: { readonly ownerId: string; readonly profileId: string }): Promise<void>
  dispose(): Promise<void>
  readonly persistence: 'memory-only' | 'encrypted-file'
}

export function assertEncryptedFileVaultPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32')
    throw new McpCoreError(
      'UNSUPPORTED_OPERATION',
      'Encrypted file vault requires verified private-file permissions on this platform.',
    )
}

interface EncryptedCredential {
  readonly nonce: string
  readonly tag: string
  readonly ciphertext: string
}

function identityKey(ownerId: string, profileId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([ownerId, profileId]))
    .digest('hex')
}

function encrypt(key: Uint8Array, identity: string, apiKey: string): EncryptedCredential {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(identity))
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  try {
    return {
      nonce: nonce.toString('base64url'),
      tag: tag.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    }
  } finally {
    nonce.fill(0)
    tag.fill(0)
    ciphertext.fill(0)
  }
}

function decrypt(key: Uint8Array, identity: string, value: EncryptedCredential): string {
  const nonce = Buffer.from(value.nonce, 'base64url')
  const tag = Buffer.from(value.tag, 'base64url')
  const ciphertext = Buffer.from(value.ciphertext, 'base64url')
  if (nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength > 8_192)
    throw new Error('Stored credential is invalid.')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(identity))
  decipher.setAuthTag(tag)
  let plaintext: Buffer | undefined
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } finally {
    plaintext?.fill(0)
    nonce.fill(0)
    tag.fill(0)
    ciphertext.fill(0)
  }
}

async function loadRecords(filePath: string): Promise<Record<string, EncryptedCredential>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const pathInfo = await lstat(filePath)
    if (pathInfo.isSymbolicLink())
      throw new Error('Credential vault file cannot be a symbolic link.')
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || (info.mode & 0o077n) !== 0n || info.size > 16n * 1024n * 1024n)
      throw new Error('Credential vault file permissions or size are invalid.')
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    while (total <= 16 * 1024 * 1024) {
      const length = Math.min(buffer.byteLength, 16 * 1024 * 1024 + 1 - total)
      const { bytesRead } = await handle.read(buffer, 0, length, total)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      total += bytesRead
    }
    if (total > 16 * 1024 * 1024) throw new Error('Credential vault exceeds its storage limit.')
    const raw = Buffer.concat(chunks, total)
    try {
      const after = await handle.stat({ bigint: true })
      const pathAfter = await stat(filePath, { bigint: true })
      if (
        info.dev !== after.dev ||
        info.ino !== after.ino ||
        info.size !== after.size ||
        info.mtimeNs !== after.mtimeNs ||
        info.ctimeNs !== after.ctimeNs ||
        BigInt(raw.byteLength) !== after.size ||
        pathAfter.dev !== after.dev ||
        pathAfter.ino !== after.ino
      )
        throw new Error('Credential vault changed while it was being read.')
      const rawValue: unknown = JSON.parse(raw.toString('utf8'))
      return recordSchema.parse(rawValue)
    } finally {
      raw.fill(0)
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return {}
    throw error
  } finally {
    if (handle) await handle.close()
  }
}

async function saveRecords(
  filePath: string,
  records: Record<string, EncryptedCredential>,
): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (
    directoryInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory() ||
    (directoryInfo.mode & 0o077) !== 0
  )
    throw new Error('Credential vault directory permissions are too broad.')
  const serialized = JSON.stringify(records)
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
    throw new Error('Credential vault exceeds its storage limit.')
  const temporary = join(directory, `.${basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  let handleOpen = true
  try {
    await handle.writeFile(serialized, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handleOpen = false
    await rename(temporary, filePath)
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (handleOpen) {
      try {
        await handle.close()
      } catch (closeError) {
        cleanupErrors.push(closeError)
      }
    }
    try {
      await rm(temporary, { force: true })
    } catch (removeError) {
      cleanupErrors.push(removeError)
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Credential vault write failed and cleanup was incomplete.',
      )
    throw error
  }
}

export async function createCredentialVault(
  config: CredentialVaultConfig,
): Promise<CredentialVault> {
  if (config.mode === 'encrypted-file' && config.encryptionKey.byteLength !== 32)
    throw new Error('Credential vault encryption key must contain exactly 32 bytes.')
  if (config.mode === 'encrypted-file') assertEncryptedFileVaultPlatform()
  const key =
    config.mode === 'encrypted-file' ? Uint8Array.from(config.encryptionKey) : randomBytes(32)
  let records: Record<string, EncryptedCredential>
  try {
    records = config.mode === 'encrypted-file' ? await loadRecords(config.filePath) : {}
  } catch (error) {
    key.fill(0)
    throw error
  }
  let disposed = false
  let mutationQueue: Promise<void> = Promise.resolve()
  const ensureActive = (): void => {
    if (disposed) throw new McpCoreError('DISPOSED', 'Credential vault is closed.', true)
  }
  const persist = async (): Promise<void> => {
    if (config.mode === 'encrypted-file') await saveRecords(config.filePath, records)
  }
  const mutateAndPersist = (mutate: () => void): Promise<void> => {
    ensureActive()
    const operation = mutationQueue.then(async () => {
      ensureActive()
      const previous = { ...records }
      mutate()
      try {
        await persist()
      } catch {
        for (const identity of Object.keys(records)) delete records[identity]
        Object.assign(records, previous)
        try {
          await persist()
        } catch {
          throw new McpCoreError(
            'CREDENTIAL_UNAVAILABLE',
            'Provider credential storage failed and rollback could not be confirmed.',
            true,
          )
        }
        throw new McpCoreError(
          'CREDENTIAL_UNAVAILABLE',
          'Provider credential storage failed.',
          true,
        )
      }
    })
    mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
  return {
    persistence: config.mode,
    async save(input) {
      ensureActive()
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(input.profileId) ||
        input.ownerId.length < 1 ||
        input.ownerId.length > 256 ||
        input.apiKey.length < 1 ||
        Buffer.byteLength(input.apiKey) > 8_192
      ) {
        throw new Error('Provider credential is invalid.')
      }
      const identity = identityKey(input.ownerId, input.profileId)
      await mutateAndPersist(() => {
        if (!records[identity] && Object.keys(records).length >= 1_024)
          throw new McpCoreError(
            'CAPACITY_LIMIT',
            'Provider credential storage reached its configured record limit.',
          )
        records[identity] = encrypt(key, identity, input.apiKey)
      })
    },
    async remove(input) {
      const identity = identityKey(input.ownerId, input.profileId)
      await mutateAndPersist(() => {
        delete records[identity]
      })
    },
    async resolve(input: {
      readonly profile: CredentialModelProfile
      readonly principal: Principal
      readonly signal: AbortSignal
      readonly deadlineAt: number
    }) {
      ensureActive()
      if (input.signal.aborted)
        throw new McpCoreError('CANCELLED', 'Credential lookup was cancelled.', true)
      if (Date.now() >= input.deadlineAt)
        throw new McpCoreError('TIMEOUT', 'Credential lookup deadline expired.', true)
      await mutationQueue
      ensureActive()
      if (input.signal.aborted)
        throw new McpCoreError('CANCELLED', 'Credential lookup was cancelled.', true)
      if (Date.now() >= input.deadlineAt)
        throw new McpCoreError('TIMEOUT', 'Credential lookup deadline expired.', true)
      const identity = identityKey(input.principal.ownerId, input.profile.id)
      const value = records[identity]
      if (!value)
        throw new McpCoreError(
          'CREDENTIAL_UNAVAILABLE',
          'No provider credential is configured for this owner and profile.',
        )
      return { apiKey: decrypt(key, identity, value) }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await mutationQueue
      key.fill(0)
      for (const identity of Object.keys(records)) delete records[identity]
    },
  }
}
