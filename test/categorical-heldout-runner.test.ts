import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  categoricalMethodSelectionSha256,
  freshProposalHeldoutPhotoManifestSha256,
  freshProposalHeldoutUiManifestSha256,
  type HeldoutRunFreeze,
  verifyHeldoutFreezeBytes,
} from '../benchmarks/v02/categorical-heldout-plan.js'
import { runCategoricalPresenceFreshHeldout } from '../benchmarks/v02/categorical-presence-fresh-runner.js'
import { runCategoricalHeldoutNoImageControl } from '../benchmarks/v02/fresh-text-runner.js'
import { parseCategoricalHeldoutArgs } from '../benchmarks/v02/run-categorical-heldout.js'

function freeze(): HeldoutRunFreeze {
  return {
    schema: 'categorical-heldout-run-freeze-v1',
    phase: 'heldout',
    targetPolicy: 'target-plus-neutral-instruction-v1',
    methodSelectionSha256: categoricalMethodSelectionSha256,
    manifests: [
      { group: 'photo', sha256: freshProposalHeldoutPhotoManifestSha256, cases: 40 },
      { group: 'ui', sha256: freshProposalHeldoutUiManifestSha256, cases: 20 },
      { group: 'map', sha256: '2'.repeat(64), cases: 20 },
    ],
    producerSourceSha256: '0'.repeat(64),
    noImageProducerSourceSha256: '0'.repeat(64),
    candidateBudget: { maxPhysicalCalls: 600, maxCostUsd: 10, unknownCostReserveUsd: 0.05 },
    noImageBudget: { maxPhysicalCalls: 300, maxCostUsd: 5, unknownCostReserveUsd: 0.05 },
  }
}

function verifiedFreeze() {
  const bytes = Buffer.from(JSON.stringify(freeze()))
  return verifyHeldoutFreezeBytes(bytes, createHash('sha256').update(bytes).digest('hex'))
}

await test('heldout candidate rejects source drift before opening manifest or assets', async () => {
  let proposalFactoryCalled = false
  await assert.rejects(
    runCategoricalPresenceFreshHeldout(
      {
        manifests: [
          { path: '/missing/photo.json', sha256: freshProposalHeldoutPhotoManifestSha256 },
        ],
        imageRoot: '/missing/images',
        outputRoot: '/tmp/unused-heldout-output',
        apiKey: 'dummy-offline-fixture-key',
        encoderPath: '/missing/encoder.onnx',
        decoderPath: '/missing/decoder.onnx',
        createObjectProposals: async () => {
          proposalFactoryCalled = true
          throw new Error('must not initialize')
        },
      },
      verifiedFreeze(),
    ),
    /frozen source digest/u,
  )
  assert.equal(proposalFactoryCalled, false)
})

await test('heldout no-image control rejects source drift before opening producer inputs', async () => {
  await assert.rejects(
    runCategoricalHeldoutNoImageControl(
      {
        manifests: [
          { path: '/missing/photo.json', sha256: freshProposalHeldoutPhotoManifestSha256 },
        ],
        imageRoot: '/missing/images',
        outputRoot: '/tmp/unused-heldout-output',
        apiKey: 'dummy-offline-fixture-key',
      },
      verifiedFreeze(),
    ),
    /frozen source digest/u,
  )
})

await test('heldout CLI requires explicit paid mode and a selected profile', () => {
  assert.throws(
    () => parseCategoricalHeldoutArgs(['--profile', 'candidate']),
    /explicit allow-paid/u,
  )
  assert.throws(() =>
    parseCategoricalHeldoutArgs([
      '--allow-paid',
      '--profile',
      'candidate',
      '--freeze',
      '/tmp/freeze.json',
      '--freeze-sha256',
      'a'.repeat(64),
    ]),
  )
})
