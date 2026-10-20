import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertHeldoutFreezeDigest,
  buildHeldoutPlans,
  categoricalMethodSelectionSha256,
  freshProposalHeldoutPhotoManifestSha256,
  freshProposalHeldoutUiManifestSha256,
  heldoutTargetPolicies,
} from '../benchmarks/v02/categorical-heldout-plan.js'
import type { HeldoutRunFreeze } from '../benchmarks/v02/categorical-heldout-plan.js'

function freeze(
  targetPolicy: HeldoutRunFreeze['targetPolicy'] = 'target-plus-neutral-instruction-v1',
): HeldoutRunFreeze {
  return {
    schema: 'categorical-heldout-run-freeze-v1',
    phase: 'heldout',
    targetPolicy,
    methodSelectionSha256: categoricalMethodSelectionSha256,
    manifests: [
      { group: 'photo', sha256: freshProposalHeldoutPhotoManifestSha256, cases: 40 },
      { group: 'ui', sha256: freshProposalHeldoutUiManifestSha256, cases: 20 },
      { group: 'map', sha256: '2'.repeat(64), cases: 20 },
    ],
    producerSourceSha256: '3'.repeat(64),
    noImageProducerSourceSha256: '5'.repeat(64),
    candidateBudget: { maxPhysicalCalls: 600, maxCostUsd: 10, unknownCostReserveUsd: 0.05 },
    noImageBudget: { maxPhysicalCalls: 300, maxCostUsd: 5, unknownCostReserveUsd: 0.05 },
  }
}

await test('heldout plans use distinct exact-denominator profiles and separate ledgers', () => {
  const plans = buildHeldoutPlans(freeze())
  assert.deepEqual(heldoutTargetPolicies, ['target-plus-neutral-instruction-v1'])
  assert.equal(plans.candidate.phase, 'heldout')
  assert.equal(plans.candidate.expectedCases.total, 80)
  assert.equal(plans.candidate.expectedCases.photo, 40)
  assert.equal(plans.candidate.expectedCases.ui, 20)
  assert.equal(plans.candidate.expectedCases.map, 20)
  assert.equal(plans.candidate.budget.maxPhysicalCalls, 600)
  assert.equal(plans.candidate.budget.worstCasePhysicalCalls, 480)
  assert.equal(plans.candidate.budget.maxCostUsd, 10)
  assert.equal(plans.candidate.budget.unknownCostReserveUsd, 0.05)
  assert.equal(plans.candidate.budget.timeoutMs, 120_000)
  assert.equal(plans.candidate.budget.maxInFlightCases, 2)
  assert.equal(plans.candidate.budget.nativeMaxWaiting, 2)
  assert.equal(plans.candidate.budget.nativeThreads, 2)
  assert.equal(plans.candidate.targetPolicy, 'target-plus-neutral-instruction-v1')
  assert.equal(plans.candidate.sourceRole, 'producer-only')
  assert.equal(plans.candidate.producerSourceSha256, '3'.repeat(64))
  assert.equal(plans.candidate.noImageProducerSourceSha256, '5'.repeat(64))

  assert.equal(plans.noImage.phase, 'heldout')
  assert.equal(plans.noImage.expectedCases, 40)
  assert.equal(plans.noImage.manifest.group, 'photo')
  assert.equal(plans.noImage.targetPolicy, plans.candidate.targetPolicy)
  assert.equal(plans.noImage.sourceRole, 'producer-only')
  assert.equal(plans.noImage.producerSourceSha256, '3'.repeat(64))
  assert.equal(plans.noImage.noImageProducerSourceSha256, '5'.repeat(64))
  assert.equal(plans.noImage.budget.maxPhysicalCalls, 300)
  assert.equal(plans.noImage.budget.maxCostUsd, 5)
  assert.equal(plans.noImage.route.provider, 'together')
  assert.equal(plans.noImage.route.providerName, 'Together')
  assert.equal(plans.noImage.route.responseFormat, 'json-schema')
  assert.equal(plans.noImage.route.reasoningEffort, 'none')
  assert.equal(plans.noImage.route.imagePartsRemoved, true)
  assert.equal(plans.noImage.route.imageEncoder, null)
  assert.equal(plans.noImage.route.objectProposals, null)
  assert.equal(plans.noImage.route.segmentation, false)
})

await test('heldout plan rejects old pins, wrong group sizes, and unselected target policy', () => {
  const valid = freeze()
  const oldPins: HeldoutRunFreeze = {
    ...valid,
    manifests: [
      {
        group: 'photo',
        sha256: 'b3afaee883990e01a464929727b7b7bb1315d6e0a70e239a10f20e2f82a3e35b',
        cases: 40,
      },
      ...valid.manifests.slice(1),
    ],
  }
  assert.throws(() => buildHeldoutPlans(oldPins), /frozen 40-photo/u)

  const wrongCounts: HeldoutRunFreeze = {
    ...valid,
    manifests: [valid.manifests[0]!, { ...valid.manifests[1]!, cases: 10 }, valid.manifests[2]!],
  }
  assert.throws(() => buildHeldoutPlans(wrongCounts), /frozen 40-photo/u)

  const invalidPolicy = {
    ...valid,
    targetPolicy: 'unreviewed-profile',
  } as unknown as HeldoutRunFreeze
  assert.throws(() => buildHeldoutPlans(invalidPolicy), /Invalid literal value/u)

  assert.throws(
    () => buildHeldoutPlans({ ...valid, unexpected: 'private-field' }),
    /Unrecognized key/u,
  )
  assert.throws(() => buildHeldoutPlans({ ...valid, methodSelectionSha256: '4'.repeat(64) }))
})

await test('freeze digest must equal the independent external SHA pin', () => {
  assert.doesNotThrow(() => assertHeldoutFreezeDigest('a'.repeat(64), 'a'.repeat(64)))
  assert.throws(() => assertHeldoutFreezeDigest('a'.repeat(64), 'b'.repeat(64)), /external/u)
  assert.throws(() => assertHeldoutFreezeDigest('unsafe', 'a'.repeat(64)), /external/u)
})
