import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createClassifier } from '../src/app/create-classifier.js'
import type { DecisionPort, DecisionResult } from '../src/entities/contracts.js'
import type { SegmentationPort } from '../src/entities/segmentation.js'
import { ClassifierError } from '../src/entities/errors.js'
import type { SegmentationBoxCheckResult } from '../src/entities/segmentation-verification.js'

await test('public extraction uses the original region search, full-source segmentation and one box check', async () => {
  let decisions = 0
  let segments = 0
  let segmenterDisposals = 0
  const decision: DecisionPort = {
    async decide(request) {
      assert.deepEqual(
        Object.keys(request.questions).sort(),
        request.questions['box_check'] ? ['box_check'] : ['presence', 'selection'],
      )
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
    assert.equal(decisions, 4)
    assert.equal(segments, 1)
    assert.equal(result.location.method, 'region-checked-segmentation-v1')
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
    assert.equal(location.method, 'region-checked-segmentation-v1')
    assert.deepEqual(location.region, result.region)
    assert.deepEqual(location.center, result.center)
    assert.equal(decisions, 8)
    assert.equal(segments, 2)
  } finally {
    await client.dispose()
    assert.equal(segmenterDisposals, 0)
    await segmenter.dispose()
  }
})

function fixtureDecision(): DecisionPort {
  return {
    async decide(request) {
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
}

function checkVerdict(verdict: 'complete' | 'unknown'): SegmentationBoxCheckResult {
  return {
    verdict,
    selection: {
      choice: verdict,
      nativeChoice: null,
      probabilities: null,
      ranking: [verdict],
      tied: [],
    },
    metadata: {
      model: 'fixture-checker',
      provider: null,
      requestId: null,
      durationMs: 0,
      costUsd: null,
      attempts: 1,
    },
  }
}

function fixtureSegmenter(onDispose: () => void = () => undefined): SegmentationPort {
  return {
    async segment(input) {
      const { width, height } = input.image
      return {
        status: 'segmented',
        mask: { data: new Uint8Array(width * height).fill(1), width, height, format: 'binary-u8' },
        metadata: {
          method: 'fixture',
          backend: 'fixture',
          durationMs: 0,
          input: { width, height },
        },
      }
    },
    async settle() {
      throw new Error('Classifier must not globally settle a shared port')
    },
    async dispose() {
      onDispose()
    },
  }
}

await test('whole-object unknown retains containment evidence and honest unknown cost', async () => {
  const image = await sharp({
    create: { width: 64, height: 48, channels: 4, background: '#778899' },
  })
    .png()
    .toBuffer()
  const segmenter = fixtureSegmenter()
  const client = createClassifier({
    decision: fixtureDecision(),
    segmentation: segmenter,
    segmentationBoxCheck: { check: async () => checkVerdict('unknown') },
  })
  try {
    const result = await client.locate({ image, target: 'object', mode: 'whole-object' })
    assert.equal(result.status, 'unknown')
    if (result.status !== 'unknown' || !('verification' in result))
      throw new Error('Expected containment unknown')
    assert.equal(result.reason, 'segmentation-uncertain')
    assert.equal(result.verification?.checks.length, 1)
    assert.equal(result.verification?.checks[0]?.verdict, 'unknown')
    assert.equal(result.metadata.stages.length, 4)
    assert.equal(result.metadata.unknownCostCount, 1)
    assert.equal('region' in result, false)
  } finally {
    await client.dispose()
    await segmenter.dispose()
  }
})

await test('classifier dispose cancels a box check but retains its slot until the physical port settles', async () => {
  const image = await sharp({
    create: { width: 64, height: 48, channels: 4, background: '#778899' },
  })
    .png()
    .toBuffer()
  let release!: () => void
  let entered!: () => void
  let checkSignal: AbortSignal | undefined
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let segmenterDisposals = 0
  const segmenter = fixtureSegmenter(() => {
    segmenterDisposals++
  })
  const client = createClassifier({
    decision: fixtureDecision(),
    segmentation: segmenter,
    concurrency: 1,
    maxQueue: 0,
    segmentationBoxCheck: {
      async check(input) {
        checkSignal = input.signal
        entered()
        await pending
        return checkVerdict('complete')
      },
    },
  })
  const request = client.extract({ image, target: 'object' })
  const rejected = assert.rejects(
    request,
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  await enteredPromise
  await assert.rejects(
    client.extract({ image, target: 'object' }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'CAPACITY',
  )
  let disposed = false
  const disposing = client.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  assert.equal(checkSignal?.aborted, true)
  assert.equal(disposed, false)
  assert.equal(segmenterDisposals, 0)
  release()
  await rejected
  await disposing
  assert.equal(disposed, true)
  assert.equal(segmenterDisposals, 0)
  await segmenter.dispose()
  assert.equal(segmenterDisposals, 1)
})
