import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProviderRefusalReplayCli, safeReplayErrorCode } from './dev-replay-cli.js'

export {
  assertProviderRefusalReplayStageTransition,
  parseProviderRefusalReplayArgs,
  runProviderRefusalReplayCli,
  writePinnedReplayArtifact,
} from './dev-replay-cli.js'
export type { ProviderRefusalReplayOfflineCliHooks } from './dev-replay-cli.js'

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  runProviderRefusalReplayCli(process.argv.slice(2), repositoryRoot).catch((error: unknown) => {
    process.stderr.write(`${safeReplayErrorCode(error)}\n`)
    process.exitCode = 1
  })
}
