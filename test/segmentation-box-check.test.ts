import assert from 'node:assert/strict'
import sharp from 'sharp'
import test from 'node:test'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  RasterImage,
} from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'
import type {
  SegmentationBoxCheckInput,
  SegmentationBoxPresentationPort,
} from '../src/entities/segmentation-verification.js'
import {
  createSegmentationBoxCheck,
  validateSegmentationBoxCheckResult,
} from '../src/features/segmentation/box-check.js'
import { createSharpSegmentationBoxPresentation } from '../src/infrastructure/segmentation/box-presentation.js'

const width = 64
const height = 48
const geometry = {
  region: { left: 15, top: 10, width: 20, height: 18 },
  seedRegion: { left: 20, top: 14, width: 8, height: 8 },
  roi: { left: 4, top: 4, width: 56, height: 40 },
}
function input(signal = new AbortController().signal): SegmentationBoxCheckInput {
  const data = new Uint8Array(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = 110
    data[pixel * 4 + 1] = 120
    data[pixel * 4 + 2] = 130
    data[pixel * 4 + 3] = 255
  }
  return {
    image: { data, width, height, format: 'rgba8' },
    ...structuredClone(geometry),
    target: 'Car',
    exclusions: ['toy car'],
    signal,
  }
}
async function png(): Promise<RasterImage> {
  const bytes = await sharp({
    create: { width, height, channels: 4, background: { r: 70, g: 80, b: 90, alpha: 1 } },
  })
    .png()
    .toBuffer()
  return { bytes: Uint8Array.from(bytes), width, height }
}
function response(choice: string, probabilities: Record<string, number>): DecisionResult {
  return {
    answers: { box_check: { type: 'choice', choice, probabilities } },
    metadata: {
      model: 'fake-model',
      provider: 'fake-provider',
      requestId: 'fake-request',
      durationMs: 3,
      costUsd: 0,
      attempts: 1,
    },
  }
}
function ports(
  decide: (request: DecisionRequest, signal: AbortSignal) => Promise<DecisionResult>,
  render: (value: SegmentationBoxCheckInput) => Promise<RasterImage>,
) {
  const decision: DecisionPort = { decide }
  const presentation: SegmentationBoxPresentationPort = { render }
  return { decision, presentation }
}

await test('Sharp presentation draws mask box, seed, and hard-ROI cues on full source', async () => {
  const source = input()
  source.image.data.set([11, 22, 33, 128], (32 * width + 40) * 4)
  const rendered = await createSharpSegmentationBoxPresentation().render(source)
  assert.deepEqual([rendered.width, rendered.height], [width, height])
  assert.deepEqual([...rendered.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const decoded = await sharp(rendered.bytes).raw().toBuffer({ resolveWithObject: true })
  const rgba = (x: number, y: number) => [
    ...decoded.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
  ]
  assert.deepEqual(rgba(23, 18), [0, 255, 255, 255])
  assert.deepEqual(rgba(30, 20), [110, 120, 130, 255])
  assert.deepEqual(rgba(40, 32), [11, 22, 33, 128])
  assert.ok((rgba(16, 12)[0] ?? 0) === 255 && (rgba(16, 12)[2] ?? 0) === 255)
  let amberPixels = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = rgba(x, y)
      if (red === 255 && (green ?? 0) > 150 && (blue ?? 0) < 30) amberPixels++
    }
  assert.ok(amberPixels > 0)
})

await test('Sharp renderer snapshots caller pixels and geometry before awaiting', async () => {
  const source = input()
  const pending = createSharpSegmentationBoxPresentation().render(source)
  source.image.data.fill(0)
  source.region.left = 0
  source.seedRegion.left = 1
  source.roi.left = 0
  const rendered = await pending
  const decoded = await sharp(rendered.bytes).raw().toBuffer({ resolveWithObject: true })
  const pixel = (x: number, y: number) => [
    ...decoded.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
  ]
  assert.equal(pixel(16, 12)[0], 255)
  assert.deepEqual(pixel(45, 35), [110, 120, 130, 255])
})

await test('box checker issues one closed choice, maps its stable tie, and reports provider metadata', async () => {
  let calls = 0
  let captured: DecisionRequest | undefined
  const rendered = await png()
  const factory = createSegmentationBoxCheck(
    ports(
      async (request) => {
        calls++
        captured = request
        return response('complete', { complete: 0.5, 'needs-expansion': 0.5, unknown: 0 })
      },
      async () => rendered,
    ),
  )
  const result = await factory.check(input())
  assert.equal(calls, 1)
  assert.equal(result.verdict, 'complete')
  assert.deepEqual(result.selection.tied, ['complete', 'needs-expansion'])
  assert.equal(result.selection.choice, 'complete')
  assert.equal(result.metadata.requestId, 'fake-request')
  assert.equal(captured?.questions.box_check?.type, 'choice')
  const question = captured?.questions.box_check
  assert.equal(question?.type, 'choice')
  if (question?.type !== 'choice') throw new Error('Expected one closed Choice question')
  assert.deepEqual(Object.keys(question.criteria), ['complete', 'needs-expansion', 'unknown'])
  assert.equal(question.rankingSize, 1)
  const text = captured?.state.filter((part): part is string => typeof part === 'string').join('\n')
  assert.match(text ?? '', /hard region of interest/u)
  assert.match(text ?? '', /do not infer parts beyond it/u)
  assert.match(text ?? '', /JSON string/u)
  assert.doesNotMatch(text ?? '', /15|10|20|18/u)
  assert.ok(
    captured?.state.some(
      (part) => typeof part !== 'string' && part.image_url.url.startsWith('data:image/png;base64,'),
    ),
  )
})

await test('strict result validator accepts a genuine one-item ranking and rejects mismatched verdicts', async () => {
  const ranked = validateSegmentationBoxCheckResult({
    verdict: 'needs-expansion',
    selection: {
      choice: 'needs-expansion',
      nativeChoice: null,
      probabilities: null,
      ranking: ['needs-expansion'],
      tied: [],
    },
    metadata: {
      model: null,
      provider: null,
      requestId: null,
      durationMs: 0,
      costUsd: null,
      attempts: 1,
    },
  })
  assert.equal(ranked.selection.choice, 'needs-expansion')
  assert.throws(
    () => validateSegmentationBoxCheckResult({ ...ranked, verdict: 'complete' }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
  assert.throws(
    () =>
      validateSegmentationBoxCheckResult({
        ...ranked,
        selection: {
          choice: 'needs-expansion',
          nativeChoice: 'needs-expansion',
          probabilities: { complete: 0.6, 'needs-expansion': 0.3, unknown: 0.1 },
          tied: ['needs-expansion'],
        },
      }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
  assert.throws(
    () =>
      validateSegmentationBoxCheckResult({
        ...ranked,
        extra: 'not allowed',
      }),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
})

await test('input geometry is owned before presentation awaits and caller mutation cannot change the request', async () => {
  const inputValue = input()
  let finish!: (value: RasterImage) => void
  let observed: SegmentationBoxCheckInput | undefined
  const rendered = png()
  const presentationPromise = new Promise<RasterImage>((resolve) => {
    finish = resolve
  })
  const factory = createSegmentationBoxCheck(
    ports(
      async (request) => {
        const text = request.state
          .filter((part): part is string => typeof part === 'string')
          .join('\n')
        assert.match(text, /"Car"/u)
        assert.match(text, /"toy car"/u)
        return response('unknown', { complete: 0, 'needs-expansion': 0, unknown: 1 })
      },
      async (value) => {
        observed = value
        return presentationPromise
      },
    ),
  )
  const pending = factory.check(inputValue)
  inputValue.image.data.fill(2)
  inputValue.region.left = 0
  inputValue.seedRegion.left = 1
  inputValue.roi.left = 0
  inputValue.target = 'Mutated'
  ;(inputValue.exclusions as string[])[0] = 'changed'
  assert.equal(observed?.image.data[0], 110)
  assert.deepEqual(observed?.region, geometry.region)
  assert.deepEqual(observed?.seedRegion, geometry.seedRegion)
  assert.deepEqual(observed?.roi, geometry.roi)
  assert.equal(observed?.target, 'Car')
  assert.deepEqual(observed?.exclusions, ['toy car'])
  finish(await rendered)
  const result = await pending
  assert.equal(result.verdict, 'unknown')
})

await test('abort before rendering prevents both injected ports from running', async () => {
  const controller = new AbortController()
  controller.abort()
  let renders = 0
  let decisions = 0
  const factory = createSegmentationBoxCheck(
    ports(
      async () => {
        decisions++
        return response('unknown', { complete: 0, 'needs-expansion': 0, unknown: 1 })
      },
      async () => {
        renders++
        return png()
      },
    ),
  )
  await assert.rejects(factory.check(input(controller.signal)), (error: unknown) => {
    return error instanceof ClassifierError && error.code === 'ABORTED'
  })
  assert.equal(renders, 0)
  assert.equal(decisions, 0)
})

await test('invalid geometry and extra factory options are rejected before injected calls', async () => {
  let calls = 0
  const configured = ports(
    async () => {
      calls++
      return response('unknown', { complete: 0, 'needs-expansion': 0, unknown: 1 })
    },
    async () => {
      calls++
      return png()
    },
  )
  assert.throws(
    () => createSegmentationBoxCheck({ ...configured, unexpected: true } as never),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
  const invalid = input()
  invalid.region = { left: 0, top: 0, width: 20, height: 18 }
  const checker = createSegmentationBoxCheck(configured)
  await assert.rejects(checker.check(invalid), (error: unknown) => {
    return error instanceof ClassifierError && error.code === 'INVALID_INPUT'
  })
  assert.equal(calls, 0)
})

await test('abort during a decision prevents a late answer from being returned', async () => {
  const controller = new AbortController()
  let completeDecision!: (result: DecisionResult) => void
  const decisionPromise = new Promise<DecisionResult>((resolve) => {
    completeDecision = resolve
  })
  const checker = createSegmentationBoxCheck(
    ports(
      async () => decisionPromise,
      async () => png(),
    ),
  )
  const pending = checker.check(input(controller.signal))
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  completeDecision(response('unknown', { complete: 0, 'needs-expansion': 0, unknown: 1 }))
  await assert.rejects(pending, (error: unknown) => {
    return error instanceof ClassifierError && error.code === 'ABORTED'
  })
})
