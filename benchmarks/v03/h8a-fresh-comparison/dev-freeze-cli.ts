import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assembleDevFreezeFromDisk,
  verifyPersistedDevFreeze,
  writeDevFreezeExclusive,
} from './dev-freeze-assembly.js'
interface CliOptions {
  authorityPath: string
  authoritySha256: string
  sourceRoot: string
  outputDirectory: string
}

function parseArguments(argv: readonly string[]): {
  command: 'assemble' | 'verify'
  options: CliOptions
} {
  const [command, ...args] = argv
  if (command !== 'assemble' && command !== 'verify')
    throw new TypeError(
      'Usage: dev-freeze-cli.ts <assemble|verify> --authority PATH --authority-sha256 HEX --source-root DIR --output-dir DIR',
    )
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || !value || values.has(key))
      throw new TypeError('Invalid or duplicate CLI argument')
    values.set(key, value)
  }
  const required = (key: string): string => {
    const value = values.get(key)
    if (!value) throw new TypeError(`Missing required argument ${key}`)
    return value
  }
  if (values.size !== 4) throw new TypeError('Unexpected CLI arguments')
  return {
    command,
    options: {
      authorityPath: required('--authority'),
      authoritySha256: required('--authority-sha256'),
      sourceRoot: required('--source-root'),
      outputDirectory: required('--output-dir'),
    },
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2))
  if (command === 'assemble') {
    const result = await assembleDevFreezeFromDisk(options)
    await writeDevFreezeExclusive(options.outputDirectory, result)
    process.stdout.write(`Verified and wrote DEV40 freeze ${result.freeze.freezeId}\n`)
    return
  }
  await verifyPersistedDevFreeze(options.outputDirectory, options)
  process.stdout.write('Persisted DEV40 freeze, source bytes, annotations, and draw verified\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown freeze preparation error'
    process.stderr.write(`DEV freeze refused: ${message}\n`)
    process.exitCode = 1
  })
}
