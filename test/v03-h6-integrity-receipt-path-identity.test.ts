import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { ClassifierError } from '../src/entities/errors.js'
import {
  assertIntegrityReceiptForRealPath,
  buildIntegrityReceiptByRealPath,
} from '../benchmarks/v03/h6-replay-kernel.js'

const directoryLinkType = process.platform === 'win32' ? ('junction' as const) : ('dir' as const)

function conflictingIdentity(error: unknown): boolean {
  return (
    error instanceof ClassifierError &&
    error.code === 'INVALID_INPUT' &&
    error.message === 'Conflicting integrity receipts share one file identity'
  )
}

async function withDirectoryAliasFixture(
  run: (paths: {
    root: string
    canonicalDir: string
    aliasDir: string
    maskName: string
    maskBytes: Buffer
    digest: string
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'h6-integrity-receipt-path-'))
  try {
    const canonicalDir = join(root, 'canonical')
    const aliasDir = join(root, 'alias')
    await mkdir(canonicalDir, { recursive: true })
    const maskBytes = Buffer.from('h6-integrity-receipt-path-identity-fixture')
    const digest = createHash('sha256').update(maskBytes).digest('hex')
    const maskName = 'mask.png'
    await writeFile(join(canonicalDir, maskName), maskBytes)
    await symlink(canonicalDir, aliasDir, directoryLinkType)
    await run({ root, canonicalDir, aliasDir, maskName, maskBytes, digest })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await test('integrity receipts match symlink directory aliases by real file identity', async () => {
  await withDirectoryAliasFixture(
    async ({ aliasDir, canonicalDir, maskName, maskBytes, digest }) => {
      const receiptPath = resolve(aliasDir, maskName)
      const candidateRealPath = await realpath(resolve(canonicalDir, maskName))
      const integrityByRealPath = await buildIntegrityReceiptByRealPath(
        [{ path: receiptPath, sha256: digest, bytes: maskBytes.length, label: 'mask' }],
        AbortSignal.timeout(5_000),
      )

      assert.doesNotThrow(() =>
        assertIntegrityReceiptForRealPath(integrityByRealPath, candidateRealPath, digest),
      )

      assert.throws(
        () =>
          assertIntegrityReceiptForRealPath(integrityByRealPath, candidateRealPath, 'f'.repeat(64)),
        (error: unknown) =>
          error instanceof ClassifierError &&
          error.code === 'INVALID_INPUT' &&
          error.message === 'Native mask is absent from its independent integrity receipt',
      )

      await writeFile(join(canonicalDir, 'unreceipted.png'), Buffer.from('unreceipted'))
      const unreceiptedRealPath = await realpath(resolve(canonicalDir, 'unreceipted.png'))
      assert.throws(
        () => assertIntegrityReceiptForRealPath(integrityByRealPath, unreceiptedRealPath, digest),
        (error: unknown) =>
          error instanceof ClassifierError &&
          error.code === 'INVALID_INPUT' &&
          error.message === 'Native mask is absent from its independent integrity receipt',
      )
    },
  )
})

await test('duplicate directory aliases reject conflicting integrity digests', async () => {
  await withDirectoryAliasFixture(
    async ({ aliasDir, canonicalDir, maskName, maskBytes, digest }) => {
      await assert.rejects(
        () =>
          buildIntegrityReceiptByRealPath(
            [
              {
                path: resolve(aliasDir, maskName),
                sha256: digest,
                bytes: maskBytes.length,
                label: 'alias',
              },
              {
                path: resolve(canonicalDir, maskName),
                sha256: '0'.repeat(64),
                bytes: maskBytes.length,
                label: 'canonical',
              },
            ],
            AbortSignal.timeout(5_000),
          ),
        conflictingIdentity,
      )
    },
  )
})

await test('duplicate directory aliases reject conflicting integrity byte counts', async () => {
  await withDirectoryAliasFixture(
    async ({ aliasDir, canonicalDir, maskName, maskBytes, digest }) => {
      await assert.rejects(
        () =>
          buildIntegrityReceiptByRealPath(
            [
              {
                path: resolve(aliasDir, maskName),
                sha256: digest,
                bytes: maskBytes.length,
                label: 'alias',
              },
              {
                path: resolve(canonicalDir, maskName),
                sha256: digest,
                bytes: maskBytes.length + 1,
                label: 'canonical',
              },
            ],
            AbortSignal.timeout(5_000),
          ),
        conflictingIdentity,
      )
    },
  )
})

await test('buildIntegrityReceiptByRealPath rejects a pre-aborted signal before realpath', async () => {
  const controller = new AbortController()
  controller.abort(new ClassifierError('ABORTED', 'Operation cancelled'))
  await assert.rejects(
    () =>
      buildIntegrityReceiptByRealPath(
        [
          {
            path: resolve(tmpdir(), 'h6-integrity-receipt-never-realpathed'),
            sha256: 'a'.repeat(64),
            bytes: 1,
            label: 'mask',
          },
        ],
        controller.signal,
      ),
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
})

await test('buildIntegrityReceiptByRealPath rejects a missing receipt path explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'h6-integrity-receipt-missing-'))
  try {
    const missingPath = resolve(root, 'missing-mask.png')
    await assert.rejects(
      () =>
        buildIntegrityReceiptByRealPath(
          [{ path: missingPath, sha256: 'b'.repeat(64), bytes: 0, label: 'mask' }],
          AbortSignal.timeout(5_000),
        ),
      (error: unknown) =>
        error instanceof ClassifierError &&
        error.code === 'INVALID_INPUT' &&
        error.message === 'Integrity receipt path does not resolve to a file',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
