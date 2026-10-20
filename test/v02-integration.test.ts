import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createClassifier, createResearchClassifier } from '../src/app/create-classifier.js'
import { createTextRepresentation } from '../src/infrastructure/text-representation.js'
import { pixelRleV1Encoder } from '../benchmarks/experiments/pixel-rle-v1.js'
import type { ImageRepresentationPort } from '../src/entities/representation.js'

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
