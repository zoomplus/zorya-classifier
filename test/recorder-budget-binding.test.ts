import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunBudget } from '../benchmarks/v02/budget.js'
import { isRecorderBoundToBudget, recordProvider } from '../benchmarks/v02/recording.js'

await test('physical recorder budget binding rejects a different equal-valued or copied budget owner', () => {
  const captured = new RunBudget(48, 2, 0.1)
  const other = new RunBudget(48, 2, 0.1)
  let dispatched = false
  const recorder = recordProvider(
    () => ({
      decide: async () => {
        dispatched = true
        throw new Error('No dispatch is expected during a budget binding check')
      },
    }),
    captured,
    join(tmpdir(), 'zorya-unused-budget-binding'),
    {
      model: 'test-model',
      provider: 'test-provider',
      providerName: 'Test',
      apiEndpoint: '/test',
      allowFallbacks: false,
    },
  )
  assert.equal(isRecorderBoundToBudget(recorder, captured), true)
  assert.equal(isRecorderBoundToBudget(recorder, other), false)
  assert.equal(isRecorderBoundToBudget({ ...recorder }, captured), false)
  assert.equal(dispatched, false)
  assert.equal(captured.snapshot().admittedPhysicalCalls, 0)
  assert.equal(other.snapshot().admittedPhysicalCalls, 0)
})
