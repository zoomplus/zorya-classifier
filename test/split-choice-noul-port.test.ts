import assert from 'node:assert/strict'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'
import { createSplitChoiceNoulPort } from '../benchmarks/v02/split-choice-noul-port.js'

const choiceOnly: DecisionRequest = {
  state: [
    'question',
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
  ],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Pick one.',
      criteria: { present: 'visible', absent: 'not visible' },
    },
  },
}

const mixed: DecisionRequest = {
  state: ['shared state'],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Pick one.',
      criteria: { a: 'A', b: 'B' },
    },
    presence: { type: 'noul', instructions: 'Is the target present?' },
  },
}

function result(
  answers: DecisionResult['answers'],
  values: Partial<DecisionResult['metadata']> = {},
): DecisionResult {
  return {
    answers,
    metadata: {
      model: 'model',
      provider: 'provider',
      requestId: 'request',
      durationMs: 4,
      costUsd: 0.01,
      attempts: 1,
      ...values,
    },
  }
}

function noopPort(decide: DecisionPort['decide']): DecisionPort {
  return { decide }
}

await test('mixed requests run only their fixed question groups in parallel and merge honest metadata', async () => {
  const called: string[] = []
  let release!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve
  })
  const mark = () => {
    if (called.length === 2) release()
  }
  const choice = noopPort(async (request) => {
    called.push('choice')
    mark()
    await bothStarted
    assert.deepEqual(Object.keys(request.questions), ['selection'])
    return result({
      selection: {
        type: 'choice',
        choice: 'a',
        probabilities: { a: 0.7, b: 0.3 },
      },
    })
  })
  const noul = noopPort(async (request) => {
    called.push('noul')
    mark()
    await bothStarted
    assert.deepEqual(Object.keys(request.questions), ['presence'])
    return result({ presence: { type: 'noul', noul: 0.8 } }, { costUsd: 0.02 })
  })
  const actual = await createSplitChoiceNoulPort(choice, noul).decide(
    mixed,
    new AbortController().signal,
  )
  assert.deepEqual(called.sort(), ['choice', 'noul'])
  assert.deepEqual(Object.keys(actual.answers).sort(), ['presence', 'selection'])
  assert.equal(actual.metadata.model, null)
  assert.equal(actual.metadata.provider, null)
  assert.equal(actual.metadata.requestId, null)
  assert.equal(actual.metadata.costUsd, 0.03)
  assert.equal(actual.metadata.attempts, 2)
  assert.ok(actual.metadata.durationMs >= 0)
})

await test('a single question group delegates once and preserves the route result unchanged', async () => {
  const expected = result({
    selection: { type: 'choice', choice: 'present', probabilities: { present: 1, absent: 0 } },
  })
  let choiceCalls = 0
  let noulCalls = 0
  const port = createSplitChoiceNoulPort(
    noopPort(async (request) => {
      choiceCalls++
      assert.deepEqual(request, choiceOnly)
      return expected
    }),
    noopPort(async () => {
      noulCalls++
      throw new Error('unexpected NoUL call')
    }),
  )
  const actual = await port.decide(choiceOnly, new AbortController().signal)
  assert.equal(actual, expected)
  assert.equal(choiceCalls, 1)
  assert.equal(noulCalls, 0)
})

await test('unknown leg cost remains unknown in mixed composite metadata', async () => {
  const port = createSplitChoiceNoulPort(
    noopPort(async () =>
      result({ selection: { type: 'ranked-choice', ranking: ['a'] } }, { costUsd: null }),
    ),
    noopPort(async () => result({ presence: { type: 'noul', noul: 0.51 } }, { costUsd: 0.02 })),
  )
  const actual = await port.decide(mixed, new AbortController().signal)
  assert.equal(actual.metadata.costUsd, null)
  assert.equal(actual.metadata.model, null)
  assert.equal(actual.metadata.provider, null)
  assert.equal(actual.metadata.requestId, null)
  assert.equal(actual.metadata.attempts, 2)
})

await test('a failed leg aborts its peer and waits for both legs to settle before rejecting', async () => {
  let peerSawAbort = false
  let peerSettled = false
  const fail = new Error('choice transport failed')
  const choice = noopPort(async () => {
    await Promise.resolve()
    throw fail
  })
  const noul = noopPort(async (_request, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        peerSawAbort = true
        resolve()
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          peerSawAbort = true
          setTimeout(resolve, 5)
        },
        { once: true },
      )
    })
    peerSettled = true
    throw new ClassifierError('ABORTED', 'peer cancelled')
  })
  await assert.rejects(
    createSplitChoiceNoulPort(choice, noul).decide(mixed, new AbortController().signal),
    (error: unknown) => error === fail,
  )
  assert.equal(peerSawAbort, true)
  assert.equal(peerSettled, true)
})

await test('parent cancellation aborts both legs and joins them before returning', async () => {
  const controller = new AbortController()
  let settled = 0
  const port = noopPort(async (_request, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => setTimeout(resolve, 5), { once: true })
    })
    settled++
    throw new ClassifierError('ABORTED', 'cancelled')
  })
  const task = createSplitChoiceNoulPort(port, port).decide(mixed, controller.signal)
  controller.abort('test cancellation')
  await assert.rejects(
    task,
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  assert.equal(settled, 2)
})
