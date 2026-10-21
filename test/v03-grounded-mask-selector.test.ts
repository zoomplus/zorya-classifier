import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  RasterImage,
} from '../src/entities/contracts.js'
import { createSegmentationBoxCheck } from '../src/features/segmentation/box-check.js'
import { createSharpRaster } from '../src/infrastructure/raster.js'
import { readCanonicalPixels } from '../src/infrastructure/raster.js'
import { createSharpSegmentationBoxPresentation } from '../src/infrastructure/segmentation/box-presentation.js'
import { createOpenRouterDecisions } from '../src/openrouter.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { createGroundedMaskSelector } from '../benchmarks/v03/grounded-mask-selector.js'

const metadata = {
  model: 'fixture-model',
  provider: 'fixture-provider',
  requestId: null,
  durationMs: 4,
  costUsd: 0,
  attempts: 1,
} as const

async function sourceImage(): Promise<RasterImage> {
  const bytes = await sharp({
    create: { width: 40, height: 24, channels: 3, background: '#888888' },
  })
    .png()
    .toBuffer()
  return { bytes: new Uint8Array(bytes), width: 40, height: 24 }
}

function candidate(alias: string, points: Array<[number, number]>) {
  const data = new Uint8Array(40 * 24)
  for (const [x, y] of points) data[y * 40 + x] = 1
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const right = Math.max(...xs)
  const bottom = Math.max(...ys)
  return {
    alias,
    mask: { data, width: 40, height: 24, format: 'binary-u8' as const },
    box: { left, top, width: right - left + 1, height: bottom - top + 1 },
  }
}

function answer(request: DecisionRequest, mode: 'tie' | 'none'): DecisionResult {
  const keys = Object.keys(
    request.questions.selection?.type === 'choice' ? request.questions.selection.criteria : {},
  )
  const winner = mode === 'none' ? 'none' : keys[0]
  assert.ok(winner)
  return {
    answers: {
      selection: {
        type: 'choice',
        choice: winner,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, mode === 'tie' ? 1 / keys.length : Number(key === winner)]),
        ),
      },
    },
    metadata,
  }
}

await test('grounded mask selector keeps stable ties and source-coordinate crop transforms', async () => {
  const image = await sourceImage()
  let observed: DecisionRequest | undefined
  const decision: DecisionPort = {
    async decide(request) {
      observed = request
      return answer(request, 'tie')
    },
  }
  const first = candidate('C00', [
    [0, 4],
    [1, 4],
    [1, 5],
  ])
  const second = candidate('C01', [
    [26, 17],
    [27, 17],
  ])
  const raster = createSharpRaster()
  const selector = createGroundedMaskSelector({
    decision,
    imageState: async (ownedImage, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return raster.imageState(ownedImage, signal)
    },
  })
  const pending = selector.select({
    image,
    target: 'Car',
    candidates: [first, second],
    signal: new AbortController().signal,
  })
  image.bytes.fill(0)
  first.mask.data.fill(0)
  const result = await pending

  assert.equal(result.alias, 'C00')
  assert.equal(result.selection.tied?.length, 3)
  assert.deepEqual(result.candidateTransforms[0], {
    alias: 'C00',
    crop: { left: 0, top: 3, width: 3, height: 4 },
  })
  assert.equal(result.preparedImageCount, 2)
  assert.ok(result.candidate)
  assert.equal([...result.candidate.mask.data].filter((pixel) => pixel === 1).length, 3)
  assert.ok(observed)
  assert.equal(observed.state.filter((part) => typeof part !== 'string').length, 2)
  assert.ok(
    observed.state.some(
      (part) => typeof part === 'string' && part.includes('unmodified full source'),
    ),
  )
  assert.equal(JSON.stringify(observed).includes('/root/work/'), false)
  assert.equal(JSON.stringify(observed).includes('sourceSha256'), false)
})

await test('grounded mask selector accepts none and an already-aborted owner prevents provider work', async () => {
  const image = await sourceImage()
  const first = candidate('C00', [[5, 8]])
  let calls = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls++
      return answer(request, 'none')
    },
  }
  const selector = createGroundedMaskSelector({
    decision,
    imageState: createSharpRaster().imageState,
  })
  const none = await selector.select({
    image,
    target: 'Car',
    candidates: [first],
    signal: new AbortController().signal,
  })
  assert.equal(none.alias, 'none')
  assert.equal(none.candidate, null)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    selector.select({ image, target: 'Car', candidates: [first], signal: controller.signal }),
  )
  assert.equal(calls, 1)
})

await test('synthetic grounded mask path uses the real Decisions adapter and independent box check', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'zorya-grounded-mask-synthetic-'))
  const budget = new RunBudget(2, 0.5, 0.05)
  const source = await sourceImage()
  const points: Array<[number, number]> = []
  for (let y = 7; y <= 16; y++) for (let x = 12; x <= 24; x++) points.push([x, y])
  const item = candidate('C00', points)
  let calls = 0
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    calls++
    const request = JSON.parse(String(init?.body)) as DecisionRequest
    const id = request.questions.selection ? 'selection' : 'box_check'
    const question = request.questions[id]
    assert.ok(question?.type === 'choice')
    const keys = Object.keys(question.criteria)
    const choice = id === 'selection' ? 'C00' : 'complete'
    return new Response(
      JSON.stringify({
        model: 'openai/gpt-6-luna-decisions',
        answers: {
          [id]: {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(keys.map((key) => [key, Number(key === choice)])),
          },
        },
        usage: { input_tokens: 10, output_tokens: 2, cost: 0.001 },
        id: `synthetic-${calls}`,
        provider: 'OpenAI',
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const recorder = recordProvider(
    (fetch) =>
      createOpenRouterDecisions({
        apiKey: 'test-only-key',
        model: 'openai/gpt-6-luna-decisions',
        provider: 'openai',
        providerName: 'OpenAI',
        fetch,
      }),
    budget,
    join(temporary, 'calls'),
    {
      model: 'openai/gpt-6-luna-decisions',
      provider: 'openai',
      providerName: 'OpenAI',
      apiEndpoint: '/api/alpha/decisions',
      allowFallbacks: false,
    },
    mockFetch,
  )
  try {
    const selected = await createGroundedMaskSelector({
      decision: recorder.port,
      imageState: createSharpRaster().imageState,
    }).select({
      image: source,
      target: 'car',
      candidates: [item],
      signal: new AbortController().signal,
    })
    assert.ok(selected.candidate)
    const rgba = await readCanonicalPixels(source, new AbortController().signal)
    const checked = await createSegmentationBoxCheck({
      decision: recorder.port,
      presentation: createSharpSegmentationBoxPresentation(),
      imageState: createSharpRaster().imageState,
    }).check({
      image: { ...rgba, format: 'rgba8' },
      region: selected.candidate.box,
      seedRegion: { left: 12, top: 7, width: 1, height: 1 },
      roi: { left: 0, top: 0, width: source.width, height: source.height },
      target: 'car',
      exclusions: [],
      signal: new AbortController().signal,
    })
    assert.equal(checked.verdict, 'complete')
    assert.equal(calls, 2)
    assert.equal(recorder.calls.length, 2)
    assert.equal(budget.snapshot().inFlightCalls, 0)
    selected.candidate.mask.data.fill(0)
    rgba.data.fill(0)
  } finally {
    source.bytes.fill(0)
    item.mask.data.fill(0)
    await rm(temporary, { recursive: true, force: true })
  }
})
