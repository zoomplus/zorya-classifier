import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createClassifier } from '../src/index.js'

await test('source dimensions fit the public source-rectangle limit before any provider dispatch', async () => {
  let calls = 0
  const classifier = createClassifier({
    decision: {
      async decide() {
        calls++
        throw new Error('Unexpected provider call')
      },
    },
  })
  try {
    for (const size of [
      { width: 16385, height: 1 },
      { width: 1, height: 16385 },
    ]) {
      const image = await sharp({ create: { ...size, channels: 3, background: '#fff' } })
        .png()
        .toBuffer()
      await assert.rejects(classifier.locate({ image, target: 'object', mode: 'whole-object' }), {
        code: 'RESOURCE_LIMIT',
      })
    }
    assert.equal(calls, 0)
  } finally {
    await classifier.dispose()
  }
})
