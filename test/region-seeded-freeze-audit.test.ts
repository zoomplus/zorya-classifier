import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkedRegionNoImageRecipe,
  checkedRegionSeededRecipe,
  regionPresenceFirstCheckedNoImageProfile,
  regionPresenceFirstCheckedProfile,
  regionSeededAssets,
} from '../benchmarks/v02/region-seeded-runner.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'
import {
  createRegionSeededControlR2Identity,
  regionSeededV3Prompts,
  verifyRegionSeededControlR2Freeze,
} from '../benchmarks/v02/region-seeded-freeze-audit.js'

const route = {
  model: 'openai/gpt-6-luna-decisions',
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false as const,
}
const manifests = [
  { sha256: '1'.repeat(64), cases: 20 },
  { sha256: '2'.repeat(64), cases: 10 },
  { sha256: '3'.repeat(64), cases: 10 },
]
const taskHashes = Array.from({ length: 40 }, (_, index) => ({
  caseId: `fixture-${index.toString().padStart(2, '0')}`,
  taskSha256: (index + 1).toString(16).padStart(64, '0'),
}))
const source = 'a'.repeat(64)
const budget = {
  maxPhysicalCalls: 250 as const,
  maxCostUsd: 5 as const,
  unknownCostReserveUsd: 0.05 as const,
}

function hashVariant(variant: 'region-seeded-sam' | 'no-image-control') {
  return hashCanonical({
    profileId:
      variant === 'region-seeded-sam'
        ? regionPresenceFirstCheckedProfile.id
        : regionPresenceFirstCheckedNoImageProfile.id,
    phase: 'dev',
    variant,
    requireClassifiedPresence: true,
    checkedRegion: true,
    route,
    policy: {
      ...(variant === 'region-seeded-sam' ? checkedRegionSeededRecipe : checkedRegionNoImageRecipe),
      maxPhysicalCalls: budget.maxPhysicalCalls,
      maxCostUsd: budget.maxCostUsd,
      requireClassifiedPresence: true,
    },
    promptPolicy:
      variant === 'region-seeded-sam'
        ? regionSeededV3Prompts.candidate
        : regionSeededV3Prompts.control,
    manifests,
    taskHashes,
    source,
    nativeAssets: variant === 'region-seeded-sam' ? regionSeededAssets : null,
  })
}

function fixture() {
  return {
    profileId: regionPresenceFirstCheckedProfile.id,
    phase: 'dev',
    variant: 'region-seeded-sam',
    checkedRegion: true,
    producerSourceSha256: source,
    route,
    manifests,
    taskHashes,
    budget,
    variantSha256: hashVariant('region-seeded-sam'),
    promptPolicy: regionSeededV3Prompts.candidate,
  }
}

function freeze() {
  const identity = createRegionSeededControlR2Identity(fixture())
  return {
    schema: 'region-seeded-development-control-r2-freeze-v1',
    phase: 'dev',
    producerSourceSha256: source,
    route,
    inputs: manifests,
    ...identity,
  }
}

await test('control R2 freeze verifies distinct candidate and no-image payload identities', () => {
  const result = verifyRegionSeededControlR2Freeze(fixture(), freeze())
  assert.equal(result.candidateVariantSha256, hashVariant('region-seeded-sam'))
  assert.equal(result.controlVariantSha256, hashVariant('no-image-control'))
  assert.notEqual(result.candidateVariantSha256, result.controlVariantSha256)
})

await test('control R2 freeze rejects reusing the candidate extraction prompt', () => {
  const value = freeze()
  const bad = {
    ...value,
    promptPolicies: {
      ...value.promptPolicies,
      control: {
        ...regionSeededV3Prompts.candidate,
        classificationClasses: [
          { ...regionSeededV3Prompts.candidate.classificationClasses[0] },
          { ...regionSeededV3Prompts.candidate.classificationClasses[1] },
        ],
      },
    },
  }
  assert.throws(
    () => verifyRegionSeededControlR2Freeze(fixture(), bad),
    /profile-specific v3 task/u,
  )
})

await test('control R2 freeze rejects a control hash computed from candidate prompt text', () => {
  const value = freeze()
  const candidateTextAsControl = {
    ...regionSeededV3Prompts.control,
    extraction: regionSeededV3Prompts.candidate.extraction,
  }
  const bad = {
    ...value,
    promptPolicies: {
      ...value.promptPolicies,
      control: {
        ...candidateTextAsControl,
        classificationClasses: [
          { ...candidateTextAsControl.classificationClasses[0] },
          { ...candidateTextAsControl.classificationClasses[1] },
        ],
      },
    },
    variantSha256: {
      ...value.variantSha256,
      control: hashCanonical({
        profileId: regionPresenceFirstCheckedNoImageProfile.id,
        phase: 'dev',
        variant: 'no-image-control',
        requireClassifiedPresence: true,
        checkedRegion: true,
        route,
        policy: {
          ...checkedRegionNoImageRecipe,
          maxPhysicalCalls: budget.maxPhysicalCalls,
          maxCostUsd: budget.maxCostUsd,
          requireClassifiedPresence: true,
        },
        promptPolicy: candidateTextAsControl,
        manifests,
        taskHashes,
        source,
        nativeAssets: null,
      }),
    },
  }
  assert.throws(
    () => verifyRegionSeededControlR2Freeze(fixture(), bad),
    /profile-specific v3 task/u,
  )
})

await test('control R2 freeze is strict about per-profile policy structure', () => {
  const value = freeze()
  const bad = {
    ...value,
    promptPolicies: {
      ...value.promptPolicies,
      control: {
        ...regionSeededV3Prompts.control,
        classificationClasses: [
          { ...regionSeededV3Prompts.control.classificationClasses[0] },
          { ...regionSeededV3Prompts.control.classificationClasses[1] },
        ],
        secretLikeExtra: 'untrusted data',
      },
    },
  }
  assert.throws(() => verifyRegionSeededControlR2Freeze(fixture(), bad), /Unrecognized key/u)
})
