import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadFreshCorpus } from '../v02/fresh-corpus.js'
import type { FreshCorpus } from '../v02/fresh-corpus.js'

const directory = dirname(fileURLToPath(import.meta.url))

/** Producer-safe inputs only. Ground truth and evaluator modules are intentionally absent. */
export const v03PilotManifests = Object.freeze([
  Object.freeze({
    path: resolve(directory, 'pilot-inputs/photo.json'),
    sha256: 'daa1759c5a08b7abf827641843df80e6b777fae8c0c04ac651fa7435235003fa',
  }),
  Object.freeze({
    path: resolve(directory, 'pilot-inputs/ui.json'),
    sha256: '7b1038e6ecb32b7ddce0af7fabe1b9afbcc63e6aaa075b77591357a28681b1bb',
  }),
  Object.freeze({
    path: resolve(directory, 'pilot-inputs/map.json'),
    sha256: '602844b8c2add14ec6d96424dc03a8c0a39c4cb15a0397f78a9d29778d805d81',
  }),
] as const)

/** Loads the frozen twelve-case DEV-only pilot with the usual byte/hash/path checks. */
export function loadV03PilotCorpus(imageRoot: string, signal: AbortSignal): Promise<FreshCorpus> {
  return loadFreshCorpus({ manifests: [...v03PilotManifests], imageRoot }, signal)
}

/** Convenience for local runner defaults; roots may be supplied explicitly by callers. */
export const v03PilotRepositoryRoot = resolve(directory, '../..')
