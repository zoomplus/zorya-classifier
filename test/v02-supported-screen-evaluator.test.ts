import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSupportedBudgetPolicy,
  assertSupportedCumulativeLedger,
  assertSupportedPairSeal,
  receiptEffectiveCost,
  reconcileSupportedReceipts,
  supportedScreenProfileIds,
} from '../benchmarks/v02/supported-screen-evaluator.js'

const hash = 'a'.repeat(64)

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    physicalId: 1,
    logicalId: 1,
    requestSha256: hash,
    requestBodySha256: hash,
    admittedAt: '2026-10-20T14:00:00.000Z',
    durationMs: 1,
    httpStatus: 200,
    route: {
      model: 'qwen/qwen3.7-flash',
      provider: 'alibaba',
      providerName: 'Alibaba',
      apiEndpoint: '/api/v1/chat/completions',
      allowFallbacks: false,
    },
    receipt: null,
    wireReceipt: null,
    errorCode: null,
    ...overrides,
  }
}

await test('supported pair seal requires both frozen routes but permits docs-only HEAD changes', () => {
  const seal = {
    runId: 'v02-vision-supported-route-screen-2026-10-20T140717451Z-90fa41cb',
    completedAt: '2026-10-20T15:00:00.000Z',
    aggregate: {},
    profileIds: [...supportedScreenProfileIds],
    sourceHeadBefore: 'a'.repeat(40),
    sourceHeadAfter: 'b'.repeat(40),
    workingTreeCleanBefore: true,
    workingTreeCleanAfter: true,
    workingTreeStatusSha256Before: hash,
    workingTreeStatusSha256After: hash,
    sourceHashesUnchanged: true,
  }
  assert.equal(assertSupportedPairSeal(seal).sourceHeadAfter, 'b'.repeat(40))
  assert.throws(() =>
    assertSupportedPairSeal({ ...seal, profileIds: [supportedScreenProfileIds[0]] }),
  )
  assert.throws(
    () => assertSupportedPairSeal({ ...seal, workingTreeStatusSha256After: 'c'.repeat(64) }),
    /pair seal/u,
  )
})

await test('wire usage cost reconciles INVALID_RESPONSE receipts when parsed receipt is absent', () => {
  const partial = receipt({
    httpStatus: 200,
    errorCode: 'INVALID_RESPONSE',
    wireReceipt: { usageCostUsd: 0.00010723 },
  })
  assert.equal(
    receiptEffectiveCost(partial as Parameters<typeof receiptEffectiveCost>[0]),
    0.00010723,
  )
  assert.equal(
    reconcileSupportedReceipts([partial], {
      physicalCalls: 1,
      knownCostUsd: 0.00010723,
      unknownCostCalls: 0,
    }).length,
    1,
  )
  assert.throws(
    () =>
      receiptEffectiveCost(
        receipt({
          receipt: {
            model: null,
            provider: null,
            requestId: null,
            costUsd: 0.1,
            durationMs: 1,
            attempts: 1,
          },
          wireReceipt: { usageCostUsd: 0.2 },
        }) as Parameters<typeof receiptEffectiveCost>[0],
      ),
    /conflicts/u,
  )
})

await test('missing parsed and wire costs remain explicitly unknown', () => {
  const unknown = receipt()
  assert.equal(receiptEffectiveCost(unknown as Parameters<typeof receiptEffectiveCost>[0]), null)
  assert.throws(
    () =>
      reconcileSupportedReceipts([unknown], {
        physicalCalls: 1,
        knownCostUsd: 0,
        unknownCostCalls: 0,
      }),
    /do not reconcile/u,
  )
  assert.equal(
    reconcileSupportedReceipts([unknown], {
      physicalCalls: 1,
      knownCostUsd: 0,
      unknownCostCalls: 1,
    }).length,
    1,
  )
})

await test('supported budget guard enforces cumulative caps and settled ownership', () => {
  assertSupportedBudgetPolicy({
    admittedPhysicalCalls: 2,
    knownCostUsd: 0.01,
    unknownCostCalls: 1,
    inFlightCalls: 0,
    accountedExposureUsd: 0.11,
    maxPhysicalCalls: 300,
    maxCostUsd: 10,
  })
  assert.throws(
    () =>
      assertSupportedBudgetPolicy({
        admittedPhysicalCalls: 2,
        knownCostUsd: 10,
        unknownCostCalls: 1,
        inFlightCalls: 0,
        accountedExposureUsd: 10,
        maxPhysicalCalls: 300,
        maxCostUsd: 10,
      }),
    /budget exceeds/u,
  )
})

await test('cumulative ledger reconciles receipts across sequential profiles', () => {
  const current = [
    receipt({ physicalId: 1, logicalId: 1, wireReceipt: { usageCostUsd: 0.1 } }),
    receipt({ physicalId: 2, logicalId: 2, wireReceipt: null }),
  ]
  assertSupportedCumulativeLedger(
    {
      admittedPhysicalCalls: 2,
      knownCostUsd: 0.1,
      unknownCostCalls: 1,
      inFlightCalls: 0,
      accountedExposureUsd: 0.2,
      maxPhysicalCalls: 300,
      maxCostUsd: 10,
    },
    current as Parameters<typeof assertSupportedCumulativeLedger>[1],
  )
  assert.throws(
    () =>
      assertSupportedCumulativeLedger(
        {
          admittedPhysicalCalls: 1,
          knownCostUsd: 0.1,
          unknownCostCalls: 1,
          inFlightCalls: 0,
          accountedExposureUsd: 0.2,
          maxPhysicalCalls: 300,
          maxCostUsd: 10,
        },
        current as Parameters<typeof assertSupportedCumulativeLedger>[1],
      ),
    /cumulative/u,
  )
})
