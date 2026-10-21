import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadFreshCorpus } from '../v02/fresh-corpus.js'
import type { FreshCorpus } from '../v02/fresh-corpus.js'

const directory = dirname(fileURLToPath(import.meta.url))

/** Producer-safe inputs only. Ground truth and evaluator modules are intentionally absent. */
export const v03PilotManifests = Object.freeze([
  Object.freeze({
    path: resolve(directory, 'pilot-inputs/photo.json'),
    sha256: 'ee1d36d254f3aeddd9b9739143754dfbdc3409e155ab76334e10cf04e0bfb44b',
  }),
  Object.freeze({
    path: resolve(directory, 'pilot-inputs/ui.json'),
    sha256: '5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f',
  }),
  Object.freeze({
    path: resolve(directory, 'pilot-inputs/map.json'),
    sha256: '6886670e7f9529805196fe8502975f78c968ff612bfa3279c323cad215ba89c4',
  }),
] as const)

/** Loads the frozen twelve-case DEV-only pilot with the usual byte/hash/path checks. */
export function loadV03PilotCorpus(imageRoot: string, signal: AbortSignal): Promise<FreshCorpus> {
  return loadFreshCorpus({ manifests: [...v03PilotManifests], imageRoot }, signal)
}

/** Convenience for local runner defaults; roots may be supplied explicitly by callers. */
export const v03PilotRepositoryRoot = resolve(directory, '../..')
