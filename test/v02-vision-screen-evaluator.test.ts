import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertVisionScreenLedger,
  parseVisionScreenMaskDescriptor,
  parseVisionScreenPairCompletion,
  normalizeVisionScreenRow,
  parseVisionScreenSummary,
} from '../benchmarks/v02/evaluate-vision-screen.js'

const profile = 'ordinary-openai-luna-mobile-sam-screen-v2'
const hash = 'a'.repeat(64)
const ids = Array.from(
  { length: 20 },
  (_, index) => `photo-dev-present-${String(index + 1).padStart(2, '0')}`,
)

function baseSummary() {
  return {
    runId: 'v02-vision-route-screen-2026-10-20T133352225Z-58d53bca',
    profileId: profile,
    variantSha256: hash,
    status: 'complete',
    plannedCaseIds: ids,
    completedCaseIds: ids,
    missingCaseIds: [],
    results: [],
    aggregate: {
      admittedPhysicalCalls: 0,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: 0,
      maxPhysicalCalls: 263,
      maxCostUsd: 4.812118675,
    },
    screenAggregate: {
      admittedPhysicalCalls: 37,
      knownCostUsd: 0.027881325,
      unknownCostCalls: 8,
      inFlightCalls: 0,
      accountedExposureUsd: 0.187881325,
      maxPhysicalCalls: 300,
      maxCostUsd: 5,
    },
    latencyEnvironment: 'screen-unranked-before-resource-soak',
    latencyRankingEligible: false,
    shutdownError: null,
    physicalReceipts: [],
  }
}

function baseRow() {
  return {
    caseId: ids[0]!,
    imageSha256: hash,
    classify: {
      status: 'ok',
      value: 'present',
      durationMs: 12,
      physicalCalls: 1,
      logicalCalls: 1,
      requestHashes: [hash],
    },
    locate: {
      status: 'located',
      region: { left: 2, top: 3, width: 20, height: 21 },
      durationMs: 30,
      physicalCalls: 2,
      logicalCalls: 2,
      requestHashes: [hash, hash],
      nativeProposal: {
        method: 'mobile-sam-nine-point-proposals-v1',
        backend: 'mobile-sam',
        durationMs: 10,
        input: { width: 100, height: 100 },
        candidateCount: 36,
      },
    },
    extract: {
      status: 'unknown',
      durationMs: 31,
      reason: 'segmentation-uncertain',
    },
  }
}

await test('SCREEN summary parser rejects incomplete-field ambiguity and unknown properties', () => {
  const summary = baseSummary()
  const withRow = { ...summary, results: [baseRow()] }
  assert.equal(parseVisionScreenSummary(withRow).results.length, 1)
  assert.throws(() => parseVisionScreenSummary({ ...summary, extra: true }))
  assert.throws(() => parseVisionScreenSummary({ ...summary, profileId: 'other' }))
  assert.throws(() =>
    parseVisionScreenSummary({ ...summary, results: [{ ...baseRow(), unrecognized: 1 }] }),
  )
  assert.throws(() =>
    parseVisionScreenSummary({
      ...summary,
      results: [{ ...baseRow(), locate: { ...baseRow().locate, region: undefined } }],
    }),
  )
})

await test('normalizer uses physical calls once and preserves independent location/extraction outcomes', () => {
  const row = baseRow()
  const parsed = parseVisionScreenSummary({ ...baseSummary(), results: [row] }).results[0]!
  const normalized = normalizeVisionScreenRow(parsed, profile)
  assert.equal(normalized.classify.calls, 1)
  assert.equal(normalized.locate.calls, 2)
  assert.equal(normalized.locate.status, 'located')
  assert.deepEqual(normalized.locate.region, row.locate.region)
})

await test('pair and aggregate ledger checks reject incomplete routes and receipt drift', () => {
  const ledger = baseSummary().screenAggregate
  assert.equal(
    parseVisionScreenPairCompletion({
      runId: 'v02-vision-route-screen-2026-10-20T133352225Z-58d53bca',
      completedAt: '2026-10-20T14:00:00.000Z',
      aggregate: ledger,
      profileIds: [
        'ordinary-openai-luna-mobile-sam-screen-v2',
        'ordinary-qwen37-flash-alibaba-mobile-sam-screen-v2',
      ],
    }).profileIds.length,
    2,
  )
  assert.throws(() =>
    parseVisionScreenPairCompletion({
      runId: 'v02-vision-route-screen-2026-10-20T133352225Z-58d53bca',
      completedAt: '2026-10-20T14:00:00.000Z',
      aggregate: ledger,
      profileIds: ['ordinary-openai-luna-mobile-sam-screen-v2'],
    }),
  )
  assert.doesNotThrow(() => assertVisionScreenLedger(ledger, [], ledger))
  assert.throws(() =>
    assertVisionScreenLedger({ ...ledger, admittedPhysicalCalls: 38 }, [], ledger),
  )
})

await test('mask artifact descriptor requires exact source crop offset geometry', () => {
  const descriptor = {
    file: 'mask.u8',
    sha256: hash,
    format: 'binary-u8',
    width: 3,
    height: 2,
    sourceRegion: { left: 4, top: 5, width: 3, height: 2 },
    sourceOffset: { x: 4, y: 5 },
    pngFile: 'cutout.png',
    pngSha256: hash,
  }
  assert.deepEqual(parseVisionScreenMaskDescriptor(descriptor), descriptor)
  assert.throws(() =>
    parseVisionScreenMaskDescriptor({ ...descriptor, sourceOffset: { x: 5, y: 5 } }),
  )
})
