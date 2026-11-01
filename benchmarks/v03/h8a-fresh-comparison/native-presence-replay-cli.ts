import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  runDevReplayCli,
  safeReplayErrorCode,
  type DevReplayOfflineCliHooks,
} from './dev-replay-cli.js'
import { NATIVE_PRESENCE_STUDY_ID } from './dev-replay-study-policy.js'

export async function runNativePresenceReplayCli(
  args: readonly string[],
  repositoryRoot: string,
  hooks?: DevReplayOfflineCliHooks,
): Promise<void> {
  const ownedArgs = Array.from(args)
  const ownedRoot = `${repositoryRoot}`
  if (hooks && hooks.studyId !== NATIVE_PRESENCE_STUDY_ID)
    throw new RangeError('Offline hooks are bound to a different replay study')
  const boundHooks = hooks ? { ...hooks, studyId: NATIVE_PRESENCE_STUDY_ID } : undefined
  return runDevReplayCli(NATIVE_PRESENCE_STUDY_ID, ownedArgs, ownedRoot, boundHooks)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  runNativePresenceReplayCli(process.argv.slice(2), repositoryRoot).catch((error: unknown) => {
    process.stderr.write(`${safeReplayErrorCode(error)}\n`)
    process.exitCode = 1
  })
}
