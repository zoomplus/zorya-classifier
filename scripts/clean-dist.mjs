import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Only the package's generated output, independent of the invoking directory.
await rm(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true, force: true })
