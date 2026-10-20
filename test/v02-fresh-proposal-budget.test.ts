import assert from 'node:assert/strict'
import test from 'node:test'
import { RunBudget } from '../benchmarks/v02/budget.js'

await test('run budget supports the fresh proposal profile 300-call cap and still reserves unknown charges', () => {
  const budget = new RunBudget(300, 5, 0.02)
  for (let index = 0; index < 300; index += 1) {
    const id = budget.admit()
    budget.settle(id, index === 0 ? 0.25 : 0)
  }
  assert.equal(budget.snapshot().admittedPhysicalCalls, 300)
  assert.throws(() => budget.admit(), /budget/u)

  const unknownCosts = new RunBudget(300, 0.03, 0.02)
  const first = unknownCosts.admit()
  unknownCosts.settle(first, null)
  assert.equal(unknownCosts.snapshot().accountedExposureUsd, 0.02)
  assert.throws(() => unknownCosts.admit(), /budget/u)
})
