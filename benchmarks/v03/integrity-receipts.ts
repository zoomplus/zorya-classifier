import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ClassifierError, assertActive } from '../../src/entities/errors.js'

export type IntegrityReceiptFileEntry = {
  path: string
  sha256: string
  bytes: number
  label: string
}

/** Indexes frozen integrity receipts by resolved file identity so directory aliases match lookups. */
export async function buildIntegrityReceiptByRealPath(
  files: readonly IntegrityReceiptFileEntry[],
  signal: AbortSignal,
): Promise<Map<string, IntegrityReceiptFileEntry>> {
  const integrityByRealPath = new Map<string, IntegrityReceiptFileEntry>()
  for (const entry of files) {
    assertActive(signal)
    let realKey: string
    try {
      realKey = await realpath(resolve(entry.path))
    } catch (error) {
      assertActive(signal)
      const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw new ClassifierError(
          'INVALID_INPUT',
          'Integrity receipt path does not resolve to a file',
        )
      throw error
    }
    assertActive(signal)
    const prior = integrityByRealPath.get(realKey)
    if (prior) {
      // Path and label are alias bookkeeping; one physical file must agree on sha256 and bytes.
      if (prior.sha256 !== entry.sha256 || prior.bytes !== entry.bytes)
        throw new ClassifierError(
          'INVALID_INPUT',
          'Conflicting integrity receipts share one file identity',
        )
      continue
    }
    integrityByRealPath.set(realKey, entry)
  }
  assertActive(signal)
  return integrityByRealPath
}

export function assertIntegrityReceiptForRealPath(
  integrityByRealPath: Map<string, IntegrityReceiptFileEntry>,
  realPath: string,
  digest: string,
  absentMessage = 'Native mask is absent from its independent integrity receipt',
): void {
  const receipt = integrityByRealPath.get(realPath)
  if (!receipt || receipt.sha256 !== digest)
    throw new ClassifierError('INVALID_INPUT', absentMessage)
}
