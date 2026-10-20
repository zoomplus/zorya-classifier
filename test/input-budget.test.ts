import assert from 'node:assert/strict'
import test from 'node:test'
import { InputBudget } from '../src/shared/input-budget.js'
import { createClassifier } from '../src/index.js'
import type { DecisionPort } from '../src/index.js'

await test('byte reservations reject before allocation and release idempotently', () => {
  const budget = new InputBudget(10)
  const first = budget.reserve(7)
  const second = budget.reserve(3)
  assert.throws(() => budget.reserve(1), { code: 'CAPACITY' })
  first()
  first()
  assert.throws(() => budget.reserve(8), { code: 'CAPACITY' })
  const third = budget.reserve(7)
  second()
  third()
  budget.reserve(10)()
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => budget.reserve(value), { code: 'CAPACITY' })
})

await test('pending physical provider work retains bytes after cancellation', async () => {
  let finish: (() => void) | undefined
  let started: (() => void) | undefined
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    finish = resolve
  })
  let calls = 0
  const decision: DecisionPort = {
    async decide() {
      calls++
      started?.()
      await blocked
      return {
        answers: { selection: { type: 'ranked-choice', ranking: ['a'] } },
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
  }
  const classifier = createClassifier({ decision, maxInputBytes: 4, concurrency: 2 })
  const classes = [
    { id: 'a', description: 'one' },
    { id: 'b', description: 'two' },
  ]
  const abort = new AbortController()
  const first = classifier.classify({ input: 'four', classes, signal: abort.signal })
  const rejected = assert.rejects(first, { code: 'ABORTED' })
  try {
    await began
    abort.abort()
    await assert.rejects(classifier.classify({ input: 'x', classes }), { code: 'CAPACITY' })
    assert.equal(calls, 1)
    finish?.()
    await rejected
    const next = await classifier.classify({ input: 'four', classes })
    assert.equal(next.choice, 'a')
  } finally {
    finish?.()
    await classifier.dispose()
    await rejected
  }
})
