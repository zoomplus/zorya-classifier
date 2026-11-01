import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleNativePresenceEvidence } from './native-presence-evidence.js'

await test('route-local logical collisions map in explicit presence then vision order', () => {
  const native = {
    sourceId: 'native-presence' as const,
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: 'opaque-case',
        profileId: 'h8a-cpu-native-presence-flat-v4' as const,
        requestSha256: 'a'.repeat(64),
        physicalIds: [101],
        outcome: 'resolved' as const,
      },
    ],
    physicalReceipts: [
      {
        receiptId: 101,
        physicalId: 21,
        logicalId: 1,
        dispatchState: 'confirmed' as const,
        settled: true,
        costUsd: 0.01,
        chargeState: 'known' as const,
      },
    ],
  }
  const vision = {
    sourceId: 'vision' as const,
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: 'opaque-case',
        profileId: 'h8a-cpu-native-presence-flat-v4' as const,
        requestSha256: 'b'.repeat(64),
        physicalIds: [102, 103, 104],
        outcome: 'resolved' as const,
      },
    ],
    physicalReceipts: [102, 103, 104].map((receiptId, index) => ({
      receiptId,
      physicalId: index + 22,
      logicalId: 1,
      dispatchState: 'confirmed' as const,
      settled: true,
      costUsd: null,
      chargeState: 'unknown' as const,
    })),
  }
  const nativeBefore = structuredClone(native)
  const visionBefore = structuredClone(vision)
  const result = assembleNativePresenceEvidence([native, vision])
  assert.deepEqual(result.mappings, [
    { sourceId: 'native-presence', localLogicalId: 1, combinedLogicalId: 1 },
    { sourceId: 'vision', localLogicalId: 1, combinedLogicalId: 2 },
  ])
  assert.deepEqual(
    result.logicalReceipts.map((receipt) => receipt.logicalId),
    [1, 2],
  )
  assert.deepEqual(
    result.physicalReceipts.map((receipt) => receipt.logicalId),
    [1, 2, 2, 2],
  )
  assert.deepEqual(
    result.physicalReceipts.map((receipt) => receipt.receiptId),
    [101, 102, 103, 104],
  )
  assert.deepEqual(
    result.physicalReceipts.map((receipt) => receipt.physicalId),
    [21, 22, 23, 24],
  )
  assert.deepEqual(native, nativeBefore)
  assert.deepEqual(vision, visionBefore)
})

await test('no-fetch route failures remain logical evidence without invented physical calls', () => {
  const result = assembleNativePresenceEvidence([
    {
      sourceId: 'native-presence',
      logicalReceipts: [
        {
          logicalId: 1,
          opaqueCaseId: 'opaque-case',
          profileId: 'h8a-cpu-native-presence-flat-v4',
          requestSha256: 'c'.repeat(64),
          physicalIds: [],
          outcome: 'preflight_failed',
          errorCode: 'INVALID_REQUEST',
        },
      ],
      physicalReceipts: [],
    },
    { sourceId: 'vision', logicalReceipts: [], physicalReceipts: [] },
  ])
  assert.equal(result.logicalReceipts[0]?.outcome, 'preflight_failed')
  assert.deepEqual(result.logicalReceipts[0]?.physicalIds, [])
  assert.deepEqual(result.physicalReceipts, [])
})

await test('combined evidence rejects duplicated global reservation IDs', () => {
  const receipt = {
    receiptId: 7,
    physicalId: 1,
    logicalId: 1,
    dispatchState: 'confirmed' as const,
    settled: true,
    costUsd: null,
    chargeState: 'unknown' as const,
  }
  assert.throws(
    () =>
      assembleNativePresenceEvidence([
        {
          sourceId: 'native-presence',
          logicalReceipts: [
            {
              logicalId: 1,
              opaqueCaseId: 'opaque-case',
              profileId: 'h8a-cpu-native-presence-flat-v4',
              requestSha256: 'd'.repeat(64),
              physicalIds: [7],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [receipt],
        },
        {
          sourceId: 'vision',
          logicalReceipts: [
            {
              logicalId: 1,
              opaqueCaseId: 'opaque-case',
              profileId: 'h8a-cpu-native-presence-flat-v4',
              requestSha256: 'e'.repeat(64),
              physicalIds: [7],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [receipt],
        },
      ]),
    /Global physical reservation IDs/u,
  )
})

await test('combined evidence rejects duplicated global physical dispatch IDs', () => {
  const makeSource = (sourceId: 'native-presence' | 'vision', receiptId: number) => ({
    sourceId,
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: 'opaque-case',
        profileId: 'h8a-cpu-native-presence-flat-v4' as const,
        requestSha256: String(receiptId).repeat(64),
        physicalIds: [receiptId],
        outcome: 'resolved' as const,
      },
    ],
    physicalReceipts: [
      {
        receiptId,
        physicalId: 8,
        logicalId: 1,
        dispatchState: 'confirmed' as const,
        settled: true,
        costUsd: null,
        chargeState: 'unknown' as const,
      },
    ],
  })
  assert.throws(
    () =>
      assembleNativePresenceEvidence([makeSource('native-presence', 41), makeSource('vision', 42)]),
    /Global physical dispatch IDs/u,
  )
})
