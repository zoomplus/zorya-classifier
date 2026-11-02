import { lstat, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve('dist')
try {
  const info = await lstat(output)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Refusing to remove a non-directory build output.')
  }
  await rm(output, { recursive: true })
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') process.exit(0)
  throw error
}
