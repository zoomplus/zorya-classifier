import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertCategoricalFreshDevCorpusShape,
  parseCategoricalFreshArgs,
} from '../benchmarks/v02/run-categorical-presence-fresh.js'
import { freshProposalManifestHashes } from '../benchmarks/v02/categorical-presence-fresh-runner.js'

await test('CLI requires explicit dry-run or paid mode and pins the three DEV inputs', () => {
  assert.throws(() => parseCategoricalFreshArgs([]), /requires explicit/u)
  const parsed = parseCategoricalFreshArgs(['--dry-run'])
  assert.equal(parsed.dryRun, true)
  assert.equal(parsed.manifests.length, 3)
  assert.deepEqual(
    parsed.manifests.map((manifest) => manifest.sha256),
    freshProposalManifestHashes,
  )
  assert.equal(parsed.manifests[0]?.path.endsWith(join('dev', 'inputs.json')), true)
  assert.equal(parsed.manifests[1]?.path.endsWith(join('dev-independent-ui', 'inputs.json')), true)
  assert.equal(parsed.manifests[2]?.path.endsWith(join('dev-independent-map', 'inputs.json')), true)
})

await test('CLI DEV gate requires exactly forty cases split 20 photo, 10 UI and 10 map', () => {
  const corpus = {
    cases: Array.from({ length: 40 }, (_, index) => `case-${index}`),
    manifests: [
      { sha256: freshProposalManifestHashes[0], cases: 20 },
      { sha256: freshProposalManifestHashes[1], cases: 10 },
      { sha256: freshProposalManifestHashes[2], cases: 10 },
    ],
  }
  assert.doesNotThrow(() => assertCategoricalFreshDevCorpusShape(corpus))
  assert.throws(
    () =>
      assertCategoricalFreshDevCorpusShape({
        ...corpus,
        cases: corpus.cases.slice(0, 39),
      }),
    /20 photo, 10 UI and 10 map/u,
  )
  assert.throws(
    () =>
      assertCategoricalFreshDevCorpusShape({
        ...corpus,
        manifests: [{ ...corpus.manifests[0]!, cases: 19 }, ...corpus.manifests.slice(1)],
      }),
    /20 photo, 10 UI and 10 map/u,
  )
})
