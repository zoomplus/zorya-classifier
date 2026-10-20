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

await test('HELDOUT budget allows only its separately tagged 600-call and $10 envelope', () => {
  const heldout = new RunBudget(600, 10, 0.02, 'heldout')
  assert.equal(heldout.snapshot().maxPhysicalCalls, 600)
  assert.equal(heldout.snapshot().maxCostUsd, 10)
  assert.throws(() => new RunBudget(301, 5.01), /Invalid v0.2 run budget/u)
  assert.throws(() => new RunBudget(601, 10, 0.02, 'heldout'), /Invalid v0.2 run budget/u)
  assert.throws(() => new RunBudget(600, 10.01, 0.02, 'heldout'), /Invalid v0.2 run budget/u)
})
