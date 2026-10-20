import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { parseFreshProposalArgs } from '../benchmarks/v02/run-fresh-proposals.js'
import {
  freshProposalHeldoutManifestHashes,
  freshProposalHeldoutPolicy,
  freshProposalPolicy,
  freshProposalRoute,
  mobileSamProposalAssets,
} from '../benchmarks/v02/fresh-proposal-runner.js'

await test('fresh proposal CLI fixes the forty-case strata and requires explicit paid options', () => {
  assert.throws(() => parseFreshProposalArgs([]), /explicit --allow-paid/u)
  assert.throws(() => parseFreshProposalArgs(['--allow-paid']), /--encoder and --decoder/u)
  const args = parseFreshProposalArgs([
    '--allow-paid',
    '--encoder=/private/encoder.onnx',
    '--decoder=/private/decoder.onnx',
  ])
  assert.deepEqual(
    args.manifests.map((item) => item.sha256),
    [
      '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a',
      '6013a54bebba277f6457765cd8ef78e12e2dd5bab4453a752967233ebb429bfc',
      'b04ba6cac5b39c927281f61e4af7dcc7a5c5c2272a637aa9676ab3009fbd5d15',
    ],
  )
  assert.equal(args.manifests.length, 3)
  assert.equal(args.encoderPath, resolve('/private/encoder.onnx'))
  assert.equal(args.decoderPath, resolve('/private/decoder.onnx'))
  assert.equal(parseFreshProposalArgs(['--dry-run']).dryRun, true)
  assert.equal(freshProposalPolicy.maxPhysicalCalls, 300)
  assert.equal(freshProposalPolicy.maxCostUsd, 5)
  assert.equal(freshProposalPolicy.timeoutMs, 45_000)
  assert.equal(freshProposalPolicy.boxTolerancePx, 8)
  assert.equal(freshProposalPolicy.retries, 0)
  assert.equal(freshProposalPolicy.fallback, false)
  assert.equal(freshProposalPolicy.latencyRankingEligible, true)
  assert.equal(freshProposalRoute.model, 'openai/gpt-6-luna-decisions')
  assert.equal(freshProposalRoute.provider, 'openai')
  assert.equal(freshProposalRoute.apiEndpoint, '/api/alpha/decisions')
  assert.equal(mobileSamProposalAssets.executionProvider, 'cpu')
})

await test('HELDOUT CLI requires explicit manifest paths and freezes the 80-case cohort metadata', () => {
  assert.throws(() => parseFreshProposalArgs(['--phase=heldout', '--dry-run']), /image-root/u)
  const args = parseFreshProposalArgs([
    '--phase=heldout',
    '--dry-run',
    '--image-root=/frozen/images',
    '--photo-inputs=/frozen/photo.json',
    '--ui-inputs=/frozen/ui.json',
    '--map-inputs=/frozen/map.json',
  ])
  assert.equal(args.phase, 'heldout')
  assert.equal(args.imageRoot, '/frozen/images')
  assert.deepEqual(
    args.manifests.map((item) => item.sha256),
    [...freshProposalHeldoutManifestHashes],
  )
  assert.equal(freshProposalHeldoutPolicy.maxPhysicalCalls, 600)
  assert.equal(freshProposalHeldoutPolicy.maxCostUsd, 10)
  assert.equal(freshProposalHeldoutPolicy.latencyRankingEligible, false)
})
