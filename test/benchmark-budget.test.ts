import assert from 'node:assert/strict'
import test from 'node:test'
import { BenchmarkBudget, BudgetExhausted } from '../benchmarks/budget.js'

await test('unknown and in-flight costs are summed, and duplicate settlement is rejected', () => {
  const budget = new BenchmarkBudget(10, 0.06)
  const first = budget.reserve(),
    second = budget.reserve(),
    third = budget.reserve()
  assert.throws(() => budget.reserve(), BudgetExhausted)
  budget.settle(first, 0.01)
  budget.settle(second, null)
  assert.throws(() => budget.reserve(), BudgetExhausted)
  budget.settle(third, 0)
  const fourth = budget.reserve()
  budget.settle(fourth, null)
  assert.equal(budget.snapshot().accountedExposureUsd, 0.05)
  assert.throws(() => budget.settle(first, 0))
})
await test('reported cost overruns halt subsequent admissions and unknown errors retain reservations', () => {
  const budget = new BenchmarkBudget(2, 0.02)
  const id = budget.reserve()
  budget.settle(id, 0.03)
  assert.equal(budget.snapshot().exceededByReportedCost, true)
  assert.throws(() => budget.reserve(), BudgetExhausted)
  const unknown = new BenchmarkBudget(360, 1)
  for (let i = 0; i < 50; i++) unknown.settle(unknown.reserve(), null)
  assert.throws(() => unknown.reserve(), BudgetExhausted)
  assert.equal(unknown.snapshot().unknownCostCalls, 50)
})
await test('zero-priced fixture requests still respect physical call admission cap', () => {
  const budget = new BenchmarkBudget(1, 1)
  budget.settle(budget.reserve(), 0)
  assert.throws(() => budget.reserve(), BudgetExhausted)
})
