import { readdir } from 'node:fs/promises'

/** Independent on-disk inventory, so a new module cannot silently escape a producer closure. */
export async function currentRuntimeSourcePaths(): Promise<string[]> {
  const files = await readdir(new URL('../../src/', import.meta.url), { recursive: true })
  return files
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `src/${file.replaceAll('\\', '/')}`)
    .sort()
}
