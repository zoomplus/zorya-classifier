import assert from 'node:assert/strict'
import { test } from 'node:test'

import { selectBestMaskCandidate } from '../src/infrastructure/segmentation/mobile-sam/worker-inference.js'

await test('MobileSAM keeps the first decoder mask when best quality scores tie', () => {
  const first = { token: 0, score: 0.9, mask: Uint8Array.of(1, 0, 0) }
  const tied = { token: 1, score: 0.9, mask: Uint8Array.of(0, 1, 0) }
  const lowerQuality = { token: 2, score: 0.8, mask: Uint8Array.of(0, 0, 1) }

  assert.equal(selectBestMaskCandidate([first, tied, lowerQuality]), first)
  assert.equal(selectBestMaskCandidate([tied, first]), first)
})
