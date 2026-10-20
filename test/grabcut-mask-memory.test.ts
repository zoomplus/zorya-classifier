import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runGrabCutAndCopyMask } from '../src/infrastructure/segmentation/grabcut/worker-inference.js'

await test('GrabCut copies the replacement Mat.data after native memory changes', () => {
  const staleBeforeNative = new Uint8Array(12)
  const mat: { data: unknown } = { data: staleBeforeNative }
  const labels = { foreground: 1, probableForeground: 3 }

  const output = runGrabCutAndCopyMask(
    mat,
    4,
    3,
    { left: 1, top: 0, width: 2, height: 2 },
    () => {
      const replacementAfterNative = new Uint8Array(12)
      replacementAfterNative[1] = labels.foreground
      replacementAfterNative[6] = labels.probableForeground
      replacementAfterNative[11] = labels.foreground
      mat.data = replacementAfterNative
    },
    labels,
  )

  assert.deepEqual(output, Uint8Array.of(0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0))
  assert.notEqual(output, mat.data)
})
