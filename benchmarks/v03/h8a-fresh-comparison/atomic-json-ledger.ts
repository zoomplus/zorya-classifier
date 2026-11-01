import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class JsonLedgerStorageError extends Error {
  readonly code = 'H8A_JSON_LEDGER_STORAGE'
  constructor(message: string) {
    super(message)
    this.name = 'JsonLedgerStorageError'
  }
}

async function readRegularJson<T>(path: string, parse: (raw: unknown) => T): Promise<T | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new JsonLedgerStorageError('Ledger state is not a physical regular file')
    return parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  }
}

interface JsonLedgerTransaction<TState, TResult> {
  next: TState
  result: TResult
}

export async function acquireExclusiveFileLock(
  lockPath: string,
  durable = false,
): Promise<() => Promise<void>> {
  const token = randomBytes(16).toString('hex')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  await mkdir(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      handle = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      )
      break
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, 'code') === 'EEXIST') {
        if (attempt === 199) throw new JsonLedgerStorageError('Ledger lock acquisition timed out')
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5 + attempt))
        continue
      }
      throw new JsonLedgerStorageError('Ledger lock acquisition failed')
    }
  }
  if (!handle) throw new JsonLedgerStorageError('Ledger lock acquisition timed out')
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, ownerToken: token, acquiredAt: Date.now() }),
    )
    if (durable) await handle.sync()
  } catch {
    await handle.close()
    await unlink(lockPath).catch(() => undefined)
    throw new JsonLedgerStorageError('Ledger lock initialization failed')
  }
  return async () => {
    let failure: unknown
    try {
      const payload: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
      if (
        !payload ||
        typeof payload !== 'object' ||
        Reflect.get(payload, 'ownerToken') !== token ||
        typeof Reflect.get(payload, 'pid') !== 'number' ||
        typeof Reflect.get(payload, 'acquiredAt') !== 'number'
      )
        throw new Error('Ledger lock ownership changed')
      await unlink(lockPath)
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
      if (code !== 'ENOENT') failure = error
    } finally {
      await handle?.close()
    }
    if (failure !== undefined) throw new JsonLedgerStorageError('Ledger lock release failed')
  }
}

export async function atomicWriteJsonFile(
  path: string,
  value: unknown,
  durable = false,
): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = join(
    directory,
    `.ledger-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  )
  let renamed = false
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      if (durable) await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
    renamed = true
    if (durable) {
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }
  } finally {
    if (!renamed) await unlink(temporaryPath).catch(() => undefined)
  }
}

export class AtomicJsonLedgerStore {
  private mutex: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly durable = false,
  ) {}

  async assertNoLockFile(): Promise<void> {
    try {
      await readFile(`${this.path}.lock`, 'utf8')
      throw new JsonLedgerStorageError('Ledger lock file is present')
    } catch (error) {
      if (error instanceof JsonLedgerStorageError) throw error
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
    }
  }

  async openOrCreate<T>(parse: (raw: unknown) => T, initial: T): Promise<T> {
    const unlock = await acquireExclusiveFileLock(`${this.path}.lock`, this.durable)
    try {
      const existing = await readRegularJson(this.path, parse)
      if (existing !== null) return existing
      await atomicWriteJsonFile(this.path, initial, this.durable)
      return initial
    } finally {
      await unlock()
    }
  }

  async read<T>(parse: (raw: unknown) => T): Promise<T | null> {
    return readRegularJson(this.path, parse)
  }

  async transact<TState, TResult>(
    parse: (raw: unknown) => TState,
    operation: (current: TState) => Promise<JsonLedgerTransaction<TState, TResult>>,
  ): Promise<TResult> {
    let releaseMutex!: () => void
    const prior = this.mutex
    this.mutex = new Promise<void>((resolveMutex) => {
      releaseMutex = resolveMutex
    })
    await prior
    let unlock: (() => Promise<void>) | undefined
    try {
      unlock = await acquireExclusiveFileLock(`${this.path}.lock`, this.durable)
      const current = await readRegularJson(this.path, parse)
      if (current === null) throw new JsonLedgerStorageError('Ledger state file disappeared')
      const transaction = await operation(current)
      await atomicWriteJsonFile(this.path, transaction.next, this.durable)
      return transaction.result
    } finally {
      try {
        await unlock?.()
      } finally {
        releaseMutex()
      }
    }
  }
}
