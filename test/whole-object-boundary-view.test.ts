import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  RasterImage,
  RasterPort,
} from '../src/entities/contracts.js'
import type { BoundaryViewInput, BoundaryViewPort } from '../src/entities/boundary-view.js'
import type { ImageRepresentationPort } from '../src/entities/representation.js'
import { ClassifierError } from '../src/entities/errors.js'
import { locateWholeObjectInput } from '../src/processes/whole-object.js'

const metadata = {
  model: 'fixture',
  provider: 'fixture',
  requestId: null,
  durationMs: 1,
  costUsd: 0,
  attempts: 1,
}
const outputPng = await sharp({
  create: { width: 280, height: 280, channels: 4, background: '#777777' },
})
  .png()
  .toBuffer()

function makeRaster(onImageState?: (image: RasterImage) => void): RasterPort {
  const makeImage = (width: number, height: number): RasterImage => ({
    bytes: new Uint8Array([1]),
    width,
    height,
  })
  return {
    async normalize() {
      return makeImage(1200, 900)
    },
    async crop(_image, region) {
      return makeImage(Math.max(1, region.width), Math.max(1, region.height))
    },
    async imageState(image) {
      onImageState?.(image)
      return [
        {
          type: 'image_url' as const,
          image_url: { url: 'data:image/png;base64,AA==', detail: 'high' as const },
        },
      ]
    },
    async grid(_image, region) {
      return makeImage(region.width, region.height)
    },
  }
}

function choose(request: DecisionRequest): DecisionResult {
  const answers: DecisionResult['answers'] = {}
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: 1 }
      continue
    }
    const keys = Object.keys(question.criteria)
    let choice = keys[0]!
    if (id === 'instance') choice = 'same'
    else if (id === 'right') choice = keys.at(-2)!
    else if (id === 'bottom') choice = keys.at(-2)!
    answers[id] = {
      type: 'choice',
      choice,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
    }
  }
  return { answers, metadata }
}

function extentRequest(request: DecisionRequest) {
  return Object.hasOwn(request.questions, 'left')
}

function baseInput(roi?: { left: number; top: number; width: number; height: number }) {
  return {
    image: new Uint8Array([1]),
    target: 'fixture target',
    mode: 'whole-object' as const,
    ...(roi === undefined ? {} : { roi }),
  }
}

function fakeBoundaryView(
  onRender: (input: BoundaryViewInput) => void,
  mutate?: (input: BoundaryViewInput) => Partial<Awaited<ReturnType<BoundaryViewPort['render']>>>,
): BoundaryViewPort {
  return {
    async render(input) {
      onRender(input)
      return {
        image: { bytes: new Uint8Array(outputPng), width: 280, height: 280 },
        sourceRegion: { ...input.sourceRegion },
        content: { left: 0, top: 0, width: 280, height: 280 },
        scaleX: 280 / input.sourceRegion.width,
        scaleY: 280 / input.sourceRegion.height,
        candidates: input.candidates.map((candidate) => ({
          ...candidate,
          interval: { ...candidate.interval },
        })),
        ...mutate?.(input),
      }
    },
  }
}

await test('boundary presentation deduplicates first-pass X/Y views and maps display labels to exact choices', async () => {
  const renders: BoundaryViewInput[] = []
  const extentRequests: DecisionRequest[] = []
  const decision: DecisionPort = {
    async decide(request) {
      if (extentRequest(request)) extentRequests.push(request)
      return choose(request)
    },
  }
  const result = await locateWholeObjectInput(
    {
      ...baseInput({ left: 10, top: 20, width: 1024, height: 768 }),
      boxTolerancePx: 64,
      maxExtentPasses: 1,
    },
    decision,
    makeRaster(),
    new AbortController().signal,
    undefined,
    fakeBoundaryView((input) => renders.push(input)),
  )
  assert.equal(result.status, 'located')
  assert.equal(renders.length, 2)
  assert.deepEqual(
    renders.map((view) => view.axis),
    ['left', 'top'],
  )
  assert.deepEqual(
    renders.map((view) => view.sourceRegion),
    [
      { left: 10, top: 20, width: 1024, height: 768 },
      { left: 10, top: 20, width: 1024, height: 768 },
    ],
  )
  const request = extentRequests[0]!
  assert.deepEqual(Object.keys(request.questions), ['left', 'right', 'top', 'bottom', 'instance'])
  assert.match(
    request.questions['left']!.type === 'choice'
      ? request.questions['left']!.criteria['left00']!
      : '',
    /^Integer boundary coordinates/u,
  )
  assert.match(
    request.questions['left']!.type === 'choice' ? request.questions['left']!.instructions : '',
    /X\/Y display labels/u,
  )
  const images = request.state.filter((part) => typeof part !== 'string')
  assert.equal(images.length, 4)
  const metadata = request.state
    .filter((part): part is string => typeof part === 'string')
    .map((part) => {
      try {
        return JSON.parse(part) as Record<string, unknown>
      } catch {
        return undefined
      }
    })
    .filter((part) => part && Object.hasOwn(part, 'boundaryView'))
  const xView = metadata.find((part) => (part?.['boundaryView'] as { axis?: string }).axis === 'X')
  assert.ok(xView)
  const choices = (
    xView['boundaryView'] as {
      choices: { questionId: string; choiceId: string; display: string }[]
    }
  ).choices
  assert.ok(
    choices.some(
      (item) => item.questionId === 'left' && item.choiceId === 'left00' && item.display === 'X0',
    ),
  )
  assert.ok(
    choices.some(
      (item) => item.questionId === 'right' && item.choiceId === 'right00' && item.display === 'X0',
    ),
  )
})

await test('boundary presentation zooms independently to four later views and clips context to ROI', async () => {
  const renders: BoundaryViewInput[] = []
  const extentRequests: DecisionRequest[] = []
  const result = await locateWholeObjectInput(
    {
      ...baseInput({ left: 10, top: 20, width: 1024, height: 768 }),
      boxTolerancePx: 8,
      maxExtentPasses: 2,
    },
    {
      async decide(request) {
        if (extentRequest(request)) extentRequests.push(request)
        return choose(request)
      },
    },
    makeRaster(),
    new AbortController().signal,
    undefined,
    fakeBoundaryView((input) => renders.push(input)),
  )
  assert.equal(result.status, 'located')
  assert.equal(renders.length, 6)
  assert.deepEqual(
    renders.slice(0, 2).map((view) => view.sourceRegion),
    [
      { left: 10, top: 20, width: 1024, height: 768 },
      { left: 10, top: 20, width: 1024, height: 768 },
    ],
  )
  assert.deepEqual(
    renders.slice(2).map((view) => view.sourceRegion),
    [
      { left: 10, top: 20, width: 80, height: 768 },
      { left: 954, top: 20, width: 80, height: 768 },
      { left: 10, top: 20, width: 1024, height: 60 },
      { left: 10, top: 728, width: 1024, height: 60 },
    ],
  )
  assert.equal(extentRequests.length, 2)
  assert.equal(extentRequests[1]!.state.filter((part) => typeof part !== 'string').length, 6)
})

await test('boundary renderer metadata mismatch fails before its extent decision', async () => {
  let extentCalls = 0
  await assert.rejects(
    locateWholeObjectInput(
      { ...baseInput(), boxTolerancePx: 64, maxExtentPasses: 1 },
      {
        async decide(request) {
          if (extentRequest(request)) extentCalls++
          return choose(request)
        },
      },
      makeRaster(),
      new AbortController().signal,
      undefined,
      fakeBoundaryView(
        () => undefined,
        (input) => ({ sourceRegion: { ...input.sourceRegion, left: input.sourceRegion.left + 1 } }),
      ),
    ),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
  assert.equal(extentCalls, 0)
})

await test('boundary renderer rejects invalid bytes, size, content, scale, and candidates before dispatch', async () => {
  const invalidViews = [
    (_input: BoundaryViewInput) => ({
      image: { bytes: new Uint8Array([1]), width: 280, height: 280 },
    }),
    (_input: BoundaryViewInput) => ({
      image: { bytes: new Uint8Array(outputPng), width: 279, height: 280 },
    }),
    () => ({ content: { left: 1, top: 1, width: 280, height: 280 } }),
    () => ({ scaleX: 1 }),
    () => ({ candidates: [] }),
  ]
  for (const mutate of invalidViews) {
    let extentCalls = 0
    await assert.rejects(
      locateWholeObjectInput(
        { ...baseInput(), boxTolerancePx: 64, maxExtentPasses: 1 },
        {
          async decide(request) {
            if (extentRequest(request)) extentCalls++
            return choose(request)
          },
        },
        makeRaster(),
        new AbortController().signal,
        undefined,
        fakeBoundaryView(() => undefined, mutate),
      ),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
    )
    assert.equal(extentCalls, 0)
  }
})

await test('abort after boundary rendering prevents the extent provider call', async () => {
  const controller = new AbortController()
  let extentCalls = 0
  await assert.rejects(
    locateWholeObjectInput(
      { ...baseInput(), boxTolerancePx: 64, maxExtentPasses: 1 },
      {
        async decide(request) {
          if (extentRequest(request)) extentCalls++
          return choose(request)
        },
      },
      makeRaster(),
      controller.signal,
      undefined,
      fakeBoundaryView((input) => {
        if (input.axis === 'left') controller.abort(new Error('fixture abort'))
      }),
    ),
  )
  assert.equal(extentCalls, 0)
})

await test('boundary path returns extent-inconsistent when its first coarse intervals miss the seed', async () => {
  let extentCalls = 0
  const result = await locateWholeObjectInput(
    { ...baseInput(), boxTolerancePx: 64, maxExtentPasses: 3 },
    {
      async decide(request) {
        if (!extentRequest(request)) return choose(request)
        extentCalls++
        const response = choose(request)
        const left = request.questions['left']
        const right = request.questions['right']
        assert.ok(left?.type === 'choice' && right?.type === 'choice')
        const leftKeys = Object.keys(left.criteria)
        const rightKeys = Object.keys(right.criteria)
        const leftChoice = leftKeys.at(-2)!
        const rightChoice = rightKeys[0]!
        response.answers['left'] = {
          type: 'choice',
          choice: leftChoice,
          probabilities: Object.fromEntries(
            leftKeys.map((key) => [key, key === leftChoice ? 1 : 0]),
          ),
        }
        response.answers['right'] = {
          type: 'choice',
          choice: rightChoice,
          probabilities: Object.fromEntries(
            rightKeys.map((key) => [key, key === rightChoice ? 1 : 0]),
          ),
        }
        return response
      },
    },
    makeRaster(),
    new AbortController().signal,
    undefined,
    fakeBoundaryView(() => undefined),
  )
  assert.equal(result.status, 'unknown')
  assert.equal(result.status === 'unknown' ? result.reason : undefined, 'extent-inconsistent')
  assert.equal(extentCalls, 1)
})

await test('text representation ignores boundary renderer and keeps extent requests image-free', async () => {
  let renders = 0
  let imageStates = 0
  let extentRequests = 0
  const raster = makeRaster(() => imageStates++)
  const representation: ImageRepresentationPort = {
    async prepare() {
      return {
        state: ['text-only geometry metadata'],
        metadata: { profile: 'fixture-text', bytes: 0, views: [] },
      }
    },
  }
  const result = await locateWholeObjectInput(
    {
      ...baseInput(),
      representation: { type: 'experimental-text', profile: 'text-image-v1' },
      boxTolerancePx: 64,
      maxExtentPasses: 1,
    },
    {
      async decide(request) {
        if (extentRequest(request)) {
          extentRequests++
          assert.equal(request.state.filter((part) => typeof part !== 'string').length, 0)
          assert.equal(JSON.parse(request.state.at(-1) as string)['pass'], 1)
        }
        return choose(request)
      },
    },
    raster,
    new AbortController().signal,
    representation,
    fakeBoundaryView(() => renders++),
  )
  assert.equal(result.status, 'unknown')
  assert.equal(renders, 0)
  assert.equal(imageStates, 0)
  assert.equal(extentRequests, 1)
})
