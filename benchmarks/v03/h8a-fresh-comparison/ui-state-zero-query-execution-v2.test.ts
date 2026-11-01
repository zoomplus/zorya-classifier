import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertExecutionV2DeadlineScope,
  validateZeroQueryExecutionV2Protocol,
  verifyZeroQueryExecutionV2Preconditions,
} from './ui-state-zero-query-execution-v2.js'

await test('the immutable first-execution audit proves zero new calls and receipts', async () => {
  const protocol = await verifyZeroQueryExecutionV2Preconditions()
  assert.equal(protocol.priorExecution.counters.inheritedLogicalAttempts, 32)
  assert.equal(protocol.priorExecution.counters.inheritedPhysicalDispatches, 100)
  assert.equal(protocol.priorExecution.counters.newLogicalCaseAttempts, 0)
  assert.equal(protocol.priorExecution.counters.newPhysicalCalls, 0)
  assert.equal(protocol.priorExecution.counters.inFlightReservations, 0)
})

await test('execution-v2 refuses nonzero prior logical and physical call counters', async () => {
  const protocol = await verifyZeroQueryExecutionV2Preconditions()
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

await test('execution-v2 refuses altered predecessor evidence pins', async () => {
  const protocol = await verifyZeroQueryExecutionV2Preconditions()
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

await test('execution-v2 refuses a deadline extension and the original sub-millisecond form', async () => {
  const protocol = await verifyZeroQueryExecutionV2Preconditions()
  for (const deadlineIso of ['2026-11-02T12:11:51.739Z', '2026-11-02T12:11:51.738058Z']) {
    assert.throws(() =>
      validateZeroQueryExecutionV2Protocol({ ...protocol, canonicalDeadlineIso: deadlineIso }),
    )
    assert.throws(() => assertExecutionV2DeadlineScope(deadlineIso), /deadline/u)
  }
  assertExecutionV2DeadlineScope(protocol.canonicalDeadlineIso)
})
