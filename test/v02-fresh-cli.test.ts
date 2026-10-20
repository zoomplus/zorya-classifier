import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseFreshDevArgs } from '../benchmarks/v02/run-fresh-dev.js'
import { freshProfilePolicy, freshProfileVariants } from '../benchmarks/v02/fresh-runner.js'

await test('fresh DEV CLI pins only photo and independent UI inputs and requires explicit paid intent', () => {
  assert.throws(() => parseFreshDevArgs([]), /explicit --allow-paid/u)
  const args = parseFreshDevArgs(['--allow-paid', '--image-root', './corpus'])
  assert.equal(args.manifests.length, 2)
  assert.deepEqual(
    args.manifests.map((item) => item.sha256),
    [
      '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
      '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
    ],
  )
  assert.equal(args.imageRoot, resolve('./corpus'))
  assert.equal(freshProfilePolicy.maxPhysicalCalls, 250)
  assert.equal(freshProfilePolicy.maxCostUsd, 5)
  assert.equal(freshProfilePolicy.boxTolerancePx, 8)
  assert.equal(freshProfilePolicy.latencyRankingEligible, false)
  assert.deepEqual(
    freshProfileVariants.map((profile) => profile.id),
    ['native-numeric-v1', 'native-seed-outline-axis-fixed16-v1'],
  )
  assert.equal(
    parseFreshDevArgs(['--allow-paid', '--profile', 'native-seed-outline-axis-fixed16-v1']).profile,
    'native-seed-outline-axis-fixed16-v1',
  )
  assert.throws(() => parseFreshDevArgs(['--allow-paid', '--profile', 'unknown-profile']))
  assert.equal(parseFreshDevArgs(['--dry-run']).dryRun, true)
})
