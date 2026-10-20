import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  categoricalFreshProducerSourceFiles,
  categoricalFreshProducerSourceManifest,
  categoricalFreshProfiles,
  freshProposalManifestHashes,
} from '../benchmarks/v02/categorical-presence-fresh-runner.js'
import { parseCategoricalBoxConfirmationDevArgs } from '../benchmarks/v02/run-categorical-box-confirmation-dev.js'

await test('dedicated box-confirmation CLI freezes one distinct full-DEV profile', () => {
  assert.throws(() => parseCategoricalBoxConfirmationDevArgs([]), /requires explicit/u)
  const dry = parseCategoricalBoxConfirmationDevArgs(['--dry-run'])
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.profile, categoricalFreshProfiles.boxConfirmation)
  assert.deepEqual(
    dry.manifests.map((manifest) => manifest.sha256),
    freshProposalManifestHashes,
  )
  const paid = parseCategoricalBoxConfirmationDevArgs(['--allow-paid'])
  assert.equal(paid.dryRun, false)
  assert.equal(paid.profile.id, 'native-luna-box-confirmation-sam-target-plus-neutral-v1')
  assert.throws(() =>
    parseCategoricalBoxConfirmationDevArgs(['--dry-run', '--profile', 'target-only']),
  )
})

await test('producer closure directly hashes the executable box-confirmation CLI', async () => {
  const relativePath = './run-categorical-box-confirmation-dev.ts'
  assert.ok(categoricalFreshProducerSourceFiles.includes(relativePath))
  const manifest = await categoricalFreshProducerSourceManifest()
  const source = await readFile(
    fileURLToPath(
      new URL('../benchmarks/v02/run-categorical-box-confirmation-dev.ts', import.meta.url),
    ),
  )
  const directHash = createHash('sha256').update(source).digest('hex')
  assert.equal(manifest[relativePath], directHash)
  assert.equal(Object.keys(manifest).filter((path) => path.startsWith('src/')).length, 54)
  assert.ok(Object.hasOwn(manifest, 'src/processes/extract-from-region.ts'))
})
