import assert from 'node:assert/strict'
import test from 'node:test'
import { BOOTSTRAP_SEED } from './constants.js'
import {
  bootstrapGroupDrawCountPerStratum,
  clusteredSourceGroupBootstrap,
  sampleBootstrapReplicateRows,
} from './clustered-bootstrap.js'

const baseRows = [
  {
    opaqueCaseId: 'p1',
    stratum: 'photo' as const,
    sourceGroup: 'g-photo-a',
    candidateSuccess: true,
    controlSuccess: false,
  },
  {
    opaqueCaseId: 'p2',
    stratum: 'photo' as const,
    sourceGroup: 'g-photo-a',
    candidateSuccess: true,
    controlSuccess: true,
  },
  {
    opaqueCaseId: 'u1',
    stratum: 'ui' as const,
    sourceGroup: 'g-ui-a',
    candidateSuccess: true,
    controlSuccess: false,
  },
  {
    opaqueCaseId: 'm1',
    stratum: 'map' as const,
    sourceGroup: 'g-map-a',
    candidateSuccess: false,
    controlSuccess: false,
  },
]

await test('clustered bootstrap uses fixed seed and strict lower bound gate', () => {
  const first = clusteredSourceGroupBootstrap(baseRows)
  const second = clusteredSourceGroupBootstrap(baseRows)
  assert.equal(first.seed, BOOTSTRAP_SEED)
  assert.equal(first.lower95, second.lower95)
  assert.equal(first.upper95, second.upper95)
  assert.equal(typeof first.passesStrictlyPositiveLower, 'boolean')
})

await test('bootstrap resamples entire chosen source group within stratum', () => {
  const rows = [
    ...baseRows,
    {
      opaqueCaseId: 'p3',
      stratum: 'photo' as const,
      sourceGroup: 'g-photo-b',
      candidateSuccess: false,
      controlSuccess: true,
    },
    {
      opaqueCaseId: 'u2',
      stratum: 'ui' as const,
      sourceGroup: 'g-ui-b',
      candidateSuccess: true,
      controlSuccess: false,
    },
    {
      opaqueCaseId: 'm2',
      stratum: 'map' as const,
      sourceGroup: 'g-map-b',
      candidateSuccess: true,
      controlSuccess: false,
    },
  ]
  const result = clusteredSourceGroupBootstrap(rows)
  assert.ok(result.replicates === 10_000)
  assert.ok(result.lower95 <= result.observedMeanGain)
})

await test('bootstrap draws one resampled cluster per original distinct group per stratum', () => {
  const rows = [
    ...baseRows,
    {
      opaqueCaseId: 'p3',
      stratum: 'photo' as const,
      sourceGroup: 'g-photo-b',
      candidateSuccess: false,
      controlSuccess: true,
    },
    {
      opaqueCaseId: 'u2',
      stratum: 'ui' as const,
      sourceGroup: 'g-ui-b',
      candidateSuccess: true,
      controlSuccess: false,
    },
    {
      opaqueCaseId: 'm2',
      stratum: 'map' as const,
      sourceGroup: 'g-map-b',
      candidateSuccess: true,
      controlSuccess: false,
    },
  ]
  const drawCounts = bootstrapGroupDrawCountPerStratum(rows)
  assert.deepEqual(drawCounts, { photo: 2, ui: 2, map: 2 })
  const alwaysFirstGroup = () => 0
  const sampled = sampleBootstrapReplicateRows(rows, alwaysFirstGroup)
  const photoRows = sampled.filter((item) => item.stratum === 'photo')
  const uiRows = sampled.filter((item) => item.stratum === 'ui')
  const mapRows = sampled.filter((item) => item.stratum === 'map')
  assert.equal(photoRows.length, 4)
  assert.equal(uiRows.length, 2)
  assert.equal(mapRows.length, 2)
  assert.ok(photoRows.every((item) => item.sourceGroup === 'g-photo-a'))
  const duplicateGroupSample = sampleBootstrapReplicateRows(rows, () => 0)
  assert.equal(duplicateGroupSample.filter((item) => item.stratum === 'photo').length, 4)
})
