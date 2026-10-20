import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createClassifier } from '../src/app/create-classifier.js'
import type { DecisionPort, DecisionResult } from '../src/entities/contracts.js'
import type { SegmentationPort } from '../src/entities/segmentation.js'

await test('public extraction uses the original region search then one full-source segmentation', async () => {
  let decisions = 0
  let segments = 0
  let segmenterDisposals = 0
  const decision: DecisionPort = {
    async decide(request) {
      assert.deepEqual(Object.keys(request.questions).sort(), ['presence', 'selection'])
      decisions++
      const answers: DecisionResult['answers'] = {}
      for (const [id, question] of Object.entries(request.questions))
        answers[id] =
          question.type === 'noul'
            ? { type: 'presence', presence: 'present' }
            : {
                type: 'ranked-choice',
                ranking: Object.keys(question.criteria).slice(0, question.rankingSize ?? 4),
              }
      return {
        answers,
        metadata: {
          model: 'fixture',
          provider: null,
          requestId: null,
          durationMs: 0,
          costUsd: 0,
          attempts: 1,
        },
      }
    },
  }
  const segmenter: SegmentationPort = {
    async segment(input) {
      segments++
      assert.equal(input.prompt, 'seed-region')
      assert.deepEqual([input.image.width, input.image.height], [64, 48])
      assert.equal(input.image.data.length, 64 * 48 * 4)
      assert.deepEqual(input.wholeRegion, { left: 0, top: 0, width: 64, height: 48 })
      assert.ok(input.seedRegion.width < 40 && input.seedRegion.height < 30)
      const mask = new Uint8Array(64 * 48)
      for (let y = 0; y < 30; y++) mask.fill(1, y * 64, y * 64 + 40)
      return {
        status: 'segmented',
        mask: { data: mask, width: 64, height: 48, format: 'binary-u8' },
        metadata: {
          method: 'fixture-full-source',
          backend: 'fixture',
          durationMs: 0,
          input: { width: 64, height: 48 },
        },
      }
    },
    async settle() {},
    async dispose() {
      segmenterDisposals++
    },
  }
  const image = await sharp({
    create: { width: 64, height: 48, channels: 4, background: '#44aa33' },
  })
    .png()
    .toBuffer()
  const client = createClassifier({ decision, segmentation: segmenter })
  try {
    const result = await client.extract({ image, target: 'the fixture object' })
    assert.equal(result.status, 'extracted')
    if (result.status !== 'extracted') throw new Error('Expected fixture cutout')
    assert.equal(decisions, 3)
    assert.equal(segments, 1)
    assert.equal(result.location.method, 'region-segmentation-v1')
    assert.deepEqual(result.region, { left: 0, top: 0, width: 40, height: 30 })
    assert.deepEqual(result.center, { x: 20, y: 15 })
    assert.deepEqual(result.offset, { x: 0, y: 0 })
    assert.deepEqual([result.mask.width, result.mask.height], [40, 30])
    const location = await client.locate({
      image,
      target: 'the fixture object',
      mode: 'whole-object',
    })
    assert.equal(location.status, 'located')
    if (location.status !== 'located') throw new Error('Expected mask-derived bounds')
    assert.equal(location.method, 'region-segmentation-v1')
    assert.deepEqual(location.region, result.region)
    assert.deepEqual(location.center, result.center)
    assert.equal(decisions, 6)
    assert.equal(segments, 2)
  } finally {
    await client.dispose()
    assert.equal(segmenterDisposals, 0)
    await segmenter.dispose()
  }
})
