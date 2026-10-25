import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClassifyInput } from '../src/entities/contracts.js'
import type { ResearchClassifyInput } from '../benchmarks/experiments/research-representation-contract.js'

const researchSelector = { type: 'experimental-text', profile: 'text-image-v1' } as const

await test('benchmark research inputs type-check without public vision casts', () => {
  const researchInput: ResearchClassifyInput = {
    input: { image: new Uint8Array([1]) },
    classes: [
      { id: 'present', description: 'visible' },
      { id: 'absent', description: 'missing' },
    ],
    representation: researchSelector,
  }
  assert.equal(researchInput.representation?.type, 'experimental-text')

  const publicVision: ClassifyInput = {
    input: { image: new Uint8Array([1]) },
    classes: [
      { id: 'present', description: 'visible' },
      { id: 'absent', description: 'missing' },
    ],
    representation: { type: 'vision' },
  }
  assert.equal(publicVision.representation?.type, 'vision')

  const blockedPublic: ClassifyInput = {
    input: { image: new Uint8Array([1]) },
    classes: [
      { id: 'present', description: 'visible' },
      { id: 'absent', description: 'missing' },
    ],
    // @ts-expect-error retired public image-as-text selector
    representation: researchSelector,
  }
  assert.equal(blockedPublic.representation?.type, 'experimental-text')
})
