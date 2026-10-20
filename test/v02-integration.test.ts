import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createClassifier, createResearchClassifier } from '../src/app/create-classifier.js'
import { createTextRepresentation } from '../src/infrastructure/text-representation.js'
import { pixelRleV1Encoder } from '../benchmarks/experiments/pixel-rle-v1.js'
import type { ImageRepresentationPort } from '../src/entities/representation.js'
import type { SegmentationInput, SegmentationPort } from '../src/entities/segmentation.js'
import { writeExtractionFiles } from '../src/app/extraction-files.js'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const representation = { type: 'experimental-text', profile: 'text-image-v1' } as const
const classes = [
  { id: 'present', description: 'object visible' },
  { id: 'absent', description: 'object absent' },
]
const metadata = {
  model: 'fixture',
  provider: 'fixture',
  requestId: null,
  durationMs: 0,
  costUsd: 0,
  attempts: 1,
}
function fixtureAnswer(request: DecisionRequest): DecisionResult {
  return {
    metadata,
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        if (question.type === 'noul') return [id, { type: 'presence', presence: 'present' }]
        const keys = Object.keys(question.criteria)
        if (id === 'instance') return [id, { type: 'ranked-choice', ranking: ['same'] }]
        const coordinate = id === 'right' ? 99 : id === 'bottom' ? 79 : 0
        const boundary = Object.entries(question.criteria).find(([, text]) => {
          const match = /^Integer boundary coordinates in \[(\d+), (\d+)\)\.$/u.exec(text)
          return match !== null && coordinate >= Number(match[1]) && coordinate < Number(match[2])
        })?.[0]
        return [
          id,
          {
            type: 'ranked-choice',
            ranking: boundary ? [boundary] : keys.slice(0, question.rankingSize ?? 4),
          },
        ]
      }),
    ),
  }
}
await test('text image workflow emits zero images through classification, seed and extent passes', async () => {
  const image = await sharp({
    create: { width: 512, height: 384, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls++
      assert.equal(
        request.state.every((part) => typeof part === 'string'),
        true,
      )
      assert.equal(JSON.stringify(request).includes('image_url'), false)
      assert.ok(
        request.state.some((part) => typeof part === 'string' && part.startsWith('PIXEL_RLE_V1')),
      )
      return fixtureAnswer(request)
    },
  }
  const classifier = createResearchClassifier(
    { decision },
    createTextRepresentation(pixelRleV1Encoder),
  )
  try {
    const classified = await classifier.classify({ input: { image }, classes, representation })
    assert.equal(classified.choice, 'present')
    const region = await classifier.locate({ image, target: 'fixture object', representation })
    assert.equal(region.status, 'located')
    const whole = await classifier.locate({
      image,
      target: 'fixture object',
      mode: 'whole-object',
      representation,
    })
    assert.equal(whole.status, 'located')
    if (whole.status === 'located') {
      assert.equal(whole.kind, 'whole-object')
      assert.equal(whole.region.left, 0)
      assert.ok(whole.region.width >= 100 && whole.region.width <= 108)
      assert.ok(whole.region.height >= 80 && whole.region.height <= 88)
    }
    assert.equal(calls, 9)
  } finally {
    await classifier.dispose()
  }
})

await test('unqualified public image profile rejects before dispatch while text-only classification stays usable', async () => {
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls++
      return fixtureAnswer(request)
    },
  }
  const classifier = createClassifier({ decision })
  try {
    await assert.rejects(
      classifier.classify({ input: { image: new Uint8Array([1]) }, classes, representation }),
      { code: 'UNSUPPORTED' },
    )
    await assert.rejects(
      classifier.locate({ image: new Uint8Array([1]), target: 'object', representation }),
      { code: 'UNSUPPORTED' },
    )
    assert.equal(calls, 0)
    assert.equal(
      (await classifier.classify({ input: 'object', classes, representation })).choice,
      'present',
    )
    assert.equal(calls, 1)
  } finally {
    await classifier.dispose()
  }
})

await test('custom research representation cannot smuggle an image to a vision-capable port', async () => {
  let calls = 0
  const malicious: ImageRepresentationPort = {
    async prepare(input) {
      return {
        state: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
        ],
        metadata: {
          profile: 'malformed',
          bytes: 1,
          views: [
            {
              id: 'x',
              sourceRegion: {
                left: 0,
                top: 0,
                width: input.source.width,
                height: input.source.height,
              },
              width: 1,
              height: 1,
              scaleX: 1,
              scaleY: 1,
            },
          ],
        },
      }
    },
  }
  const classifier = createResearchClassifier(
    {
      decision: {
        async decide(request) {
          calls++
          return fixtureAnswer(request)
        },
      },
    },
    malicious,
  )
  try {
    const image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer()
    await assert.rejects(classifier.classify({ input: { image }, classes, representation }), {
      code: 'INVALID_RESPONSE',
    })
    assert.equal(calls, 0)
  } finally {
    await classifier.dispose()
  }
})

function fixtureSegmenter(onSegment?: (input: SegmentationInput) => Promise<void>) {
  let disposals = 0
  const port: SegmentationPort = {
    async segment(input) {
      await onSegment?.(input)
      const mask = new Uint8Array(input.image.width * input.image.height)
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) mask[y * input.image.width + x] = 1
      return {
        status: 'segmented',
        mask: {
          data: mask,
          width: input.image.width,
          height: input.image.height,
          format: 'binary-u8',
        },
        metadata: {
          method: 'fixture',
          backend: 'fixture',
          durationMs: 0,
          input: { width: input.image.width, height: input.image.height },
        },
      }
    },
    settle: async () => undefined,
    async dispose() {
      disposals++
    },
  }
  return {
    port,
    get disposals() {
      return disposals
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

await test('public extract owns source bytes, writes binary artifacts and leaves a shared segmenter reusable', async () => {
  const source = await sharp({
    create: { width: 512, height: 384, channels: 4, background: '#ef8040' },
  })
    .png()
    .toBuffer()
  const segmenter = fixtureSegmenter()
  const decision: DecisionPort = { decide: async (request) => fixtureAnswer(request) }
  const first = createClassifier({ decision, segmentation: segmenter.port })
  const second = createClassifier({ decision, segmentation: segmenter.port })
  const directory = await mkdtemp(join(tmpdir(), 'zorya-extract-test-'))
  try {
    const mutable = new Uint8Array(source)
    const pending = first.extract({ image: mutable, target: 'fixture object' })
    mutable.fill(0)
    const result = await pending
    assert.equal(result.status, 'extracted')
    if (result.status !== 'extracted') return
    assert.deepEqual(result.region, { left: 0, top: 0, width: 10, height: 10 })
    assert.deepEqual(result.offset, { x: 0, y: 0 })
    const pixels = await sharp(result.png).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([pixels.info.width, pixels.info.height, pixels.info.channels], [10, 10, 4])
    assert.deepEqual([...pixels.data.subarray(0, 4)], [239, 128, 64, 255])
    const files = await writeExtractionFiles(join(directory, 'object'), result)
    assert.deepEqual(new Uint8Array(await readFile(files.png)), result.png)
    assert.deepEqual(new Uint8Array(await readFile(files.mask)), result.mask.data)
    const descriptor = JSON.parse(await readFile(files.descriptor, 'utf8')) as Record<
      string,
      unknown
    >
    assert.equal('png' in descriptor, false)
    assert.deepEqual(descriptor['mask'], { width: 10, height: 10, format: 'binary-u8' })
    const collisionPrefix = join(directory, 'collision')
    await writeFile(`${collisionPrefix}.mask.u8`, 'existing')
    await assert.rejects(writeExtractionFiles(collisionPrefix, result), { code: 'EEXIST' })
    assert.equal(await readFile(`${collisionPrefix}.mask.u8`, 'utf8'), 'existing')
    assert.equal((await readdir(directory)).includes('collision.png'), false)
    assert.equal((await readdir(directory)).includes('collision.json'), false)
    await first.dispose()
    assert.equal(segmenter.disposals, 0)
    assert.equal(
      (await second.extract({ image: source, target: 'fixture object' })).status,
      'extracted',
    )
  } finally {
    await first.dispose()
    await second.dispose()
    await segmenter.port.dispose()
    await rm(directory, { recursive: true, force: true })
  }
  assert.equal(segmenter.disposals, 1)
})

await test('public extract requires an explicit backend before sending a model request', async () => {
  let calls = 0
  const classifier = createClassifier({
    decision: {
      async decide(request) {
        calls++
        return fixtureAnswer(request)
      },
    },
  })
  try {
    await assert.rejects(classifier.extract({ image: Uint8Array.of(1), target: 'object' }), {
      code: 'UNSUPPORTED',
    })
    assert.equal(calls, 0)
  } finally {
    await classifier.dispose()
  }
})

await test('cancelled extract retains its physical slot and byte reservation until segmentation settles', async () => {
  const image = await sharp({
    create: { width: 512, height: 384, channels: 4, background: '#fff' },
  })
    .png()
    .toBuffer()
  const entered = deferred()
  const release = deferred()
  const segmenter = fixtureSegmenter(async (input) => {
    entered.resolve()
    await release.promise
    assert.equal(input.signal.aborted, true)
  })
  const classifier = createClassifier({
    decision: { decide: async (request) => fixtureAnswer(request) },
    segmentation: segmenter.port,
    concurrency: 1,
    maxQueue: 0,
    maxInputBytes: image.byteLength,
  })
  const controller = new AbortController()
  const pending = classifier.extract({ image, target: 'fixture object', signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'ABORTED' })
  try {
    await entered.promise
    controller.abort()
    await assert.rejects(classifier.extract({ image, target: 'another' }), { code: 'CAPACITY' })
    release.resolve()
    await rejected
  } finally {
    release.resolve()
    await classifier.dispose()
    await rejected
    await segmenter.port.dispose()
  }
})
