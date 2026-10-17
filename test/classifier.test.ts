import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { createClassifier, ClassifierError } from '../src/index.js'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/index.js'
const classes = [
  { id: 'yes', description: 'Yes' },
  { id: 'no', description: 'No' },
]
function answer(
  request: DecisionRequest,
  choose: (keys: string[]) => string = (keys) => keys[0] ?? '',
): DecisionResult {
  return {
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => {
        if (q.type === 'noul') return [id, { type: 'noul', noul: 1 }]
        const keys = Object.keys(q.criteria),
          choice = choose(keys)
        return [
          id,
          {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
          },
        ]
      }),
    ),
    metadata: {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 0,
      costUsd: null,
      attempts: 1,
    },
  }
}
const fixture: DecisionPort = {
  async decide(request) {
    return answer(request)
  },
}
await test('classify validates before dispatch and preserves unknown cost', async () => {
  let calls = 0
  const client = createClassifier({
    decision: {
      async decide(r) {
        calls++
        return answer(r)
      },
    },
  })
  try {
    await assert.rejects(client.classify({ input: 'x', classes: [classes[0]!, classes[0]!] }), {
      code: 'INVALID_INPUT',
    })
    assert.equal(calls, 0)
    const result = await client.classify({ input: 'x', classes })
    assert.equal(result.choice, 'yes')
    assert.equal(result.metadata.costUsd, null)
  } finally {
    await client.dispose()
  }
})
await test('categorical maxima below 0.8 are accepted; exact ties use supplied order', async () => {
  const client = createClassifier({
    decision: {
      async decide() {
        return {
          answers: {
            selection: {
              type: 'choice',
              choice: 'no',
              probabilities: { yes: 0.5, no: 0.5 },
              confidence: 0.01,
            },
          },
          metadata: {
            model: null,
            provider: null,
            requestId: null,
            durationMs: 0,
            costUsd: null,
            attempts: 1,
          },
        }
      },
    },
  })
  try {
    const r = await client.classify({ input: 'x', classes })
    assert.equal(r.choice, 'yes')
    assert.equal(r.nativeChoice, 'no')
    assert.deepEqual(r.tied, ['yes', 'no'])
    assert.equal(r.confidence, 0.01)
  } finally {
    await client.dispose()
  }
})
await test('contradictory native choice and missing probability are errors', async () => {
  const client = createClassifier({
    decision: {
      async decide() {
        return {
          answers: {
            selection: { type: 'choice', choice: 'no', probabilities: { yes: 0.9, no: 0.1 } },
          },
          metadata: {
            model: null,
            provider: null,
            requestId: null,
            durationMs: 0,
            costUsd: null,
            attempts: 1,
          },
        }
      },
    },
  })
  try {
    await assert.rejects(client.classify({ input: 'x', classes }), { code: 'INVALID_RESPONSE' })
  } finally {
    await client.dispose()
  }
})
await test('one absolute deadline cancels provider and does not retry', async () => {
  let calls = 0
  const client = createClassifier({
    timeoutMs: 15,
    decision: {
      async decide(r, signal) {
        calls++
        await delay(100, undefined, { signal })
        return answer(r)
      },
    },
  })
  try {
    await assert.rejects(client.classify({ input: 'x', classes }), { code: 'TIMEOUT' })
    assert.equal(calls, 1)
  } finally {
    await client.dispose()
  }
})
await test('cancelled queued operation never dispatches; physical work retains capacity', async () => {
  const releases: (() => void)[] = []
  let calls = 0
  const client = createClassifier({
    concurrency: 1,
    maxQueue: 1,
    decision: {
      async decide(r) {
        calls++
        await new Promise<void>((resolve) => releases.push(resolve))
        return answer(r)
      },
    },
  })
  const controller = new AbortController()
  const first = client.classify({ input: 'x', classes, signal: controller.signal })
  const observedFirst = assert.rejects(first, { code: 'ABORTED' })
  await delay(0)
  const secondController = new AbortController()
  const second = client.classify({ input: 'y', classes, signal: secondController.signal })
  const observedSecond = assert.rejects(second, { code: 'ABORTED' })
  secondController.abort()
  controller.abort()
  await observedSecond
  assert.equal(calls, 1)
  releases.shift()?.()
  await observedFirst
  await client.dispose()
  await assert.rejects(client.classify({ input: 'x', classes }), { code: 'DISPOSED' })
})
await test('full queue fails with CAPACITY, then returns to idle', async () => {
  let release = () => {}
  const client = createClassifier({
    concurrency: 1,
    maxQueue: 0,
    decision: {
      async decide(r) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return answer(r)
      },
    },
  })
  const first = client.classify({ input: 'x', classes })
  await delay(0)
  await assert.rejects(client.classify({ input: 'y', classes }), { code: 'CAPACITY' })
  release()
  await first
  await client.dispose()
})
await test('caller bytes are copied before queue awaits, including Buffer views', async () => {
  const original = await sharp({
    create: { width: 32, height: 32, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer()
  const client = createClassifier({ decision: fixture })
  const request = client.classify({ input: { image: original }, classes })
  original.fill(0)
  try {
    assert.equal((await request).choice, 'yes')
  } finally {
    await client.dispose()
  }
})
await test('image limits and malformed media reject without provider calls', async () => {
  let calls = 0
  const client = createClassifier({
    decision: {
      async decide(r) {
        calls++
        return answer(r)
      },
    },
  })
  try {
    await assert.rejects(
      client.classify({ input: { image: new Uint8Array([1, 2, 3]) }, classes }),
      { code: 'INVALID_INPUT' },
    )
    assert.equal(calls, 0)
  } finally {
    await client.dispose()
  }
})
await test('1000 operation/dispose cycles leave no owned timeout handles', async () => {
  const before = process.getActiveResourcesInfo().filter((v) => v === 'Timeout').length
  for (let i = 0; i < 1000; i++) {
    const client = createClassifier({ decision: fixture })
    await client.classify({ input: 'x', classes })
    await client.dispose()
  }
  const after = process.getActiveResourcesInfo().filter((v) => v === 'Timeout').length
  assert.equal(after, before)
})
await test('already aborted signal dispatches nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  const client = createClassifier({
    decision: {
      async decide() {
        throw new Error('Must not dispatch')
      },
    },
  })
  try {
    await assert.rejects(
      client.classify({ input: 'x', classes, signal: controller.signal }),
      ClassifierError,
    )
  } finally {
    await client.dispose()
  }
})

await test('full queue rejects before reading or copying another image', async () => {
  let release = () => {}
  let touched = 0
  const client = createClassifier({
    concurrency: 1,
    maxQueue: 0,
    decision: {
      async decide(request) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return answer(request)
      },
    },
  })
  const first = client.classify({ input: 'occupied', classes })
  await delay(0)
  try {
    await assert.rejects(
      client.locate({
        get image() {
          touched++
          return new Uint8Array(16 * 1024 * 1024)
        },
        target: 'x',
      }),
      { code: 'CAPACITY' },
    )
    assert.equal(touched, 0)
  } finally {
    release()
    await first
    await client.dispose()
  }
})

await test('rounded Jev mass needs explicit annotation and preserves raw categorical ties', async () => {
  const raw = { a: 0.33, b: 0.33, c: 0.33 }
  for (const annotated of [false, true]) {
    const client = createClassifier({
      decision: {
        async decide() {
          return {
            answers: {
              selection: {
                type: 'choice',
                choice: 'b',
                probabilities: raw,
                ...(annotated ? { probabilityRoundingStep: 0.01 as const } : {}),
              },
            },
            metadata: {
              model: 'fixture',
              provider: 'fixture',
              requestId: null,
              costUsd: null,
              durationMs: 0,
              attempts: 1,
            },
          }
        },
      },
    })
    try {
      const job = client.classify({
        input: 'sample',
        classes: ['a', 'b', 'c'].map((id) => ({ id, description: id })),
      })
      if (!annotated) await assert.rejects(job, { code: 'INVALID_RESPONSE' })
      else {
        const result = await job
        assert.deepEqual(result.probabilities, raw)
        assert.equal(result.choice, 'a')
        assert.equal(result.nativeChoice, 'b')
        assert.deepEqual(result.tied, ['a', 'b', 'c'])
        assert.equal(result.probabilityRoundingStep, 0.01)
      }
    } finally {
      await client.dispose()
    }
  }
})
