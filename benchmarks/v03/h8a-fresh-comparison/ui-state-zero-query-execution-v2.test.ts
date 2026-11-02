import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertExecutionV2DeadlineScope,
  validateZeroQueryExecutionV2Protocol,
} from './ui-state-zero-query-execution-v2.js'
import { createSyntheticZeroQueryExecutionV2Protocol } from './ui-state-zero-query-execution-v2-fixture.js'

await test('synthetic schema fixture preserves zero-query counters in protocol validation', () => {
  const protocol = validateZeroQueryExecutionV2Protocol(
    createSyntheticZeroQueryExecutionV2Protocol(),
  )
  assert.equal(protocol.priorExecution.counters.inheritedLogicalAttempts, 32)
  assert.equal(protocol.priorExecution.counters.inheritedPhysicalDispatches, 100)
  assert.equal(protocol.priorExecution.counters.newLogicalCaseAttempts, 0)
  assert.equal(protocol.priorExecution.counters.newPhysicalCalls, 0)
  assert.equal(protocol.priorExecution.counters.inFlightReservations, 0)
})

await test('synthetic schema fixture rejects nonzero prior logical and physical counters', () => {
  const protocol = validateZeroQueryExecutionV2Protocol(
    createSyntheticZeroQueryExecutionV2Protocol(),
  )
  assert.throws(
    () =>
      validateZeroQueryExecutionV2Protocol({
        ...protocol,
        priorExecution: {
          ...protocol.priorExecution,
          counters: { ...protocol.priorExecution.counters, newLogicalCaseAttempts: 1 },
        },
      }),
    /literal value/u,
  )
  assert.throws(
    () =>
      validateZeroQueryExecutionV2Protocol({
        ...protocol,
        priorExecution: {
          ...protocol.priorExecution,
          counters: { ...protocol.priorExecution.counters, newPhysicalCalls: 1 },
        },
      }),
    /literal value/u,
  )
})

await test('synthetic schema fixture rejects altered predecessor evidence pins', () => {
  const protocol = validateZeroQueryExecutionV2Protocol(
    createSyntheticZeroQueryExecutionV2Protocol(),
  )
  assert.throws(
    () =>
      validateZeroQueryExecutionV2Protocol({
        ...protocol,
        priorExecution: {
          ...protocol.priorExecution,
          campaignLedger: {
            ...protocol.priorExecution.campaignLedger,
            sha256: 'a'.repeat(64),
          },
        },
      }),
    /prior execution identity/u,
  )
})

await test('synthetic schema fixture refuses deadline extension and sub-millisecond form', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00.000Z') })
  const protocol = validateZeroQueryExecutionV2Protocol(
    createSyntheticZeroQueryExecutionV2Protocol(),
  )
  for (const deadlineIso of ['2026-11-02T12:11:51.739Z', '2026-11-02T12:11:51.738058Z']) {
    assert.throws(() =>
      validateZeroQueryExecutionV2Protocol({ ...protocol, canonicalDeadlineIso: deadlineIso }),
    )
    assert.throws(() => assertExecutionV2DeadlineScope(deadlineIso), /deadline/u)
  }
  assertExecutionV2DeadlineScope(protocol.canonicalDeadlineIso)
})
