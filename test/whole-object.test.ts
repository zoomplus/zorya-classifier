import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  RasterImage,
  RasterPort,
} from '../src/entities/contracts.js'
import type { ImageRepresentationPort } from '../src/entities/representation.js'
import { ClassifierError } from '../src/entities/errors.js'
import { locateWholeObjectInput } from '../src/processes/whole-object.js'

const meta = {
  model: 'fixture',
  provider: 'fixture',
  requestId: null,
  durationMs: 1,
  costUsd: 0,
  attempts: 1,
}
function answer(
  request: DecisionRequest,
  pick: (id: string, criteria: Record<string, string>) => string,
): DecisionResult {
  return {
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        if (question.type === 'noul') return [id, { type: 'noul' as const, noul: 1 }]
        const keys = Object.keys(question.criteria)
        const choice = pick(id, question.criteria)
        return [
          id,
          {
            type: 'choice' as const,
            choice,
            probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
          },
        ]
      }),
    ),
    metadata: meta,
  }
}
function fakeRaster(width: number, height: number): RasterPort {
  const make = (w: number, h: number): RasterImage => ({
    bytes: new Uint8Array([1]),
    width: w,
    height: h,
  })
  return {
    async normalize() {
      return make(width, height)
    },
    async crop(_image, region, _signal, scale = 1) {
      return make(
        Math.max(1, Math.floor(region.width * scale)),
        Math.max(1, Math.floor(region.height * scale)),
      )
    },
    async imageState() {
      return ['fixture image']
    },
    async grid(_image, region) {
      return make(region.width, region.height)
    },
  }
}
function seedDrivenDecision(onExtent?: (request: DecisionRequest) => DecisionResult): DecisionPort {
  let calls = 0
  return {
    async decide(request) {
      calls++
      if (calls <= 3) {
        return answer(request, (_id, criteria) => Object.keys(criteria)[0]!)
      }
      return (
        onExtent?.(request) ??
        answer(request, (id, criteria) => (id === 'instance' ? 'same' : Object.keys(criteria)[0]!))
      )
    },
  }
}
function chooseContainingCoordinate(
  request: DecisionRequest,
  id: string,
  coordinate: number,
): string {
  const question = request.questions[id]
  assert.ok(question?.type === 'choice')
  return (
    Object.entries(question.criteria).find(([, text]) => {
      const match = /^Integer boundary coordinates in \[(\d+), (\d+)\)\.$/.exec(text)
      return match !== null && coordinate >= Number(match[1]) && coordinate < Number(match[2])
    })?.[0] ?? 'unknown'
  )
}
function lastObject(request: DecisionRequest): Record<string, unknown> {
  const value = request.state.at(-1)
  assert.equal(typeof value, 'string')
  return JSON.parse(value as string) as Record<string, unknown>
}

await test('whole-object narrows all four boundaries for a large source and preserves the seed', async () => {
  const raster = fakeRaster(2048, 1024)
  let extentCalls = 0
  const decision = seedDrivenDecision((request) => {
    extentCalls++
    const context = lastObject(request)
    const seed = context['seedRegion'] as {
      left: number
      top: number
      width: number
      height: number
    }
    return answer(request, (id) => {
      if (id === 'instance') return 'same'
      const coordinate =
        id === 'left'
          ? seed.left
          : id === 'right'
            ? seed.left + seed.width - 1
            : id === 'top'
              ? seed.top
              : seed.top + seed.height - 1
      return chooseContainingCoordinate(request, id, coordinate)
    })
  })
  const result = await locateWholeObjectInput(
    {
      image: new Uint8Array([1]),
      target: 'object',
      mode: 'whole-object',
      boxTolerancePx: 8,
      maxExtentPasses: 3,
    },
    decision,
    raster,
    new AbortController().signal,
  )
  assert.equal(result.status, 'located')
  if (result.status === 'located') {
    assert.equal(result.kind, 'whole-object')
    assert.ok(result.region.left <= result.seedRegion.left)
    assert.ok(
      result.region.left + result.region.width >= result.seedRegion.left + result.seedRegion.width,
    )
    assert.ok(result.bounds.left.endExclusive - result.bounds.left.start <= 8)
    assert.ok(result.bounds.right.endExclusive - result.bounds.right.start <= 8)
    assert.ok(extentCalls >= 2)
    assert.equal(result.metadata.stages.length, 3 + extentCalls)
  }
})

await test('whole-object accepts edge and one-pixel boundary intervals with stable categorical ties', async () => {
  const raster = fakeRaster(500, 400)
  const decision = seedDrivenDecision((request) => {
    const { seedRegion } = lastObject(request) as {
      seedRegion: { left: number; top: number; width: number; height: number }
    }
    const result = answer(request, (id) => {
      if (id === 'instance') return 'same'
      const coordinate =
        id === 'left'
          ? seedRegion.left
          : id === 'right'
            ? seedRegion.left + seedRegion.width - 1
            : id === 'top'
              ? seedRegion.top
              : seedRegion.top + seedRegion.height - 1
      const found = chooseContainingCoordinate(request, id, coordinate)
      return found
    })
    for (const id of ['left', 'right', 'top', 'bottom']) {
      const keys = Object.keys(
        request.questions[id]!.type === 'choice' ? request.questions[id]!.criteria : {},
      )
      const probabilities = Object.fromEntries(keys.map((key) => [key, 0]))
      probabilities[keys[0]!] = 0.5
      probabilities[keys.at(-1)!] = 0.5
      result.answers[id] = { type: 'choice', choice: keys.at(-1)!, probabilities }
    }
    return result
  })
  const result = await locateWholeObjectInput(
    {
      image: new Uint8Array([1]),
      target: 'thin object',
      mode: 'whole-object',
      roi: { left: 60, top: 40, width: 320, height: 280 },
      boxTolerancePx: 64,
      maxExtentPasses: 1,
    },
    decision,
    raster,
    new AbortController().signal,
  )
  assert.equal(result.status, 'located')
  if (result.status === 'located') {
    assert.equal(result.completeness, 'boundary-limited')
    assert.ok(result.region.left >= 60 && result.region.top >= 40)
    assert.ok(result.region.left + result.region.width <= 380)
    assert.ok(result.region.top + result.region.height <= 320)
  }
})

await test('whole-object distinguishes ambiguous identity, unknown boundaries, and inconsistent extent', async () => {
  const raster = fakeRaster(320, 280)
  const negative = await locateWholeObjectInput(
    { image: new Uint8Array([1]), target: 'missing object', mode: 'whole-object' },
    {
      async decide(request) {
        const response = answer(request, (_id, criteria) => Object.keys(criteria)[0]!)
        const presence = Object.keys(request.questions).find(
          (id) => request.questions[id]?.type === 'noul',
        )
        if (presence) response.answers[presence] = { type: 'noul', noul: 0 }
        return response
      },
    },
    raster,
    new AbortController().signal,
  )
  assert.equal(negative.status, 'not-found')
  const ambiguous = await locateWholeObjectInput(
    {
      image: new Uint8Array([1]),
      target: 'object',
      mode: 'whole-object',
      boxTolerancePx: 64,
      maxExtentPasses: 1,
    },
    seedDrivenDecision((request) =>
      answer(request, (id, criteria) =>
        id === 'instance' ? 'ambiguous' : Object.keys(criteria)[0]!,
      ),
    ),
    raster,
    new AbortController().signal,
  )
  assert.deepEqual(ambiguous.status === 'unknown' ? ambiguous.reason : null, 'instance-ambiguous')
  const unknown = await locateWholeObjectInput(
    {
      image: new Uint8Array([1]),
      target: 'object',
      mode: 'whole-object',
      boxTolerancePx: 64,
      maxExtentPasses: 1,
    },
    seedDrivenDecision((request) =>
      answer(request, (id, criteria) =>
        id === 'instance' ? 'same' : id === 'left' ? 'unknown' : Object.keys(criteria)[0]!,
      ),
    ),
    raster,
    new AbortController().signal,
  )
  assert.deepEqual(unknown.status === 'unknown' ? unknown.reason : null, 'extent-uncertain')
  const inconsistent = await locateWholeObjectInput(
    {
      image: new Uint8Array([1]),
      target: 'object',
      mode: 'whole-object',
      boxTolerancePx: 64,
      maxExtentPasses: 1,
    },
    seedDrivenDecision((request) =>
      answer(request, (id, criteria) =>
        id === 'instance'
          ? 'same'
          : id === 'left'
            ? Object.keys(criteria).at(-2)!
            : id === 'right'
              ? Object.keys(criteria)[0]!
              : Object.keys(criteria)[0]!,
      ),
    ),
    raster,
    new AbortController().signal,
  )
  assert.deepEqual(
    inconsistent.status === 'unknown' ? inconsistent.reason : null,
    'extent-inconsistent',
  )
})

await test('whole-object honors late cancellation after an admitted decision settles', async () => {
  const raster = fakeRaster(320, 280)
  const controller = new AbortController()
  const decision = seedDrivenDecision((request) => {
    controller.abort(new Error('late abort'))
    return answer(request, (id, criteria) =>
      id === 'instance' ? 'same' : Object.keys(criteria)[0]!,
    )
  })
  await assert.rejects(
    locateWholeObjectInput(
      {
        image: new Uint8Array([1]),
        target: 'object',
        mode: 'whole-object',
        boxTolerancePx: 64,
        maxExtentPasses: 1,
      },
      decision,
      raster,
      controller.signal,
    ),
  )
})

await test('whole-object maps only representation preparation limits to an unknown reason', async () => {
  const representation: ImageRepresentationPort = {
    async prepare() {
      throw new ClassifierError('RESOURCE_LIMIT', 'view cannot be encoded', {
        component: 'representation',
      })
    },
  }
  const result = await locateWholeObjectInput(
    {
      image: new Uint8Array([1]),
      target: 'object',
      mode: 'whole-object',
      boxTolerancePx: 64,
      maxExtentPasses: 1,
    },
    seedDrivenDecision(),
    fakeRaster(320, 280),
    new AbortController().signal,
    representation,
  )
  assert.deepEqual(result.status === 'unknown' ? result.reason : null, 'representation-limit')
})
