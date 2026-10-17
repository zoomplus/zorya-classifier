import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classificationMetrics,
  latencyMetrics,
  localizationMetrics,
  parityMetrics,
} from '../benchmarks/metrics.js'
import type {
  ClassificationAttempt,
  LocalizationAttempt,
  NormalizedRect,
  ParityAttempt,
} from '../benchmarks/metrics.js'

function close(actual: number | null, expected: number): void {
  assert.notEqual(actual, null)
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
}

await test('classification keeps failures and operational unknown distinct from the semantic unknown class', () => {
  const attempts: ClassificationAttempt[] = [
    { expectedClassId: 'billing', outcome: { status: 'ok', choice: 'billing' }, latencyMs: 1 },
    { expectedClassId: 'billing', outcome: { status: 'failed' }, latencyMs: 200 },
    { expectedClassId: 'billing', outcome: { status: 'unknown' }, latencyMs: 300 },
    { expectedClassId: 'technical', outcome: { status: 'ok', choice: 'billing' }, latencyMs: 4 },
    { expectedClassId: 'unknown', outcome: { status: 'ok', choice: 'unknown' }, latencyMs: 5 },
    { expectedClassId: 'unknown', outcome: { status: 'ok', choice: 'technical' }, latencyMs: 6 },
  ]
  const snapshot = structuredClone(attempts)
  const result = classificationMetrics(['billing', 'technical', 'unknown'], attempts)
  assert.equal(result.attempted, 6)
  assert.equal(result.classified, 4)
  assert.equal(result.correct, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.operationalUnknown, 1)
  close(result.accuracy, 1 / 3)
  close(result.macroF1, 16 / 45)
  assert.deepEqual(result.confusion[0], {
    expectedClassId: 'billing',
    predictions: [
      { classId: 'billing', count: 1 },
      { classId: 'technical', count: 0 },
      { classId: 'unknown', count: 0 },
    ],
    operationalUnknown: 1,
    failed: 1,
  })
  assert.deepEqual(result.perClass[0], {
    classId: 'billing',
    support: 3,
    tp: 1,
    fp: 1,
    fn: 2,
    precision: 0.5,
    recall: 1 / 3,
    f1: 0.4,
  })
  assert.equal(result.latency.p50Ms, 5)
  assert.equal(result.latency.p95Ms, 300)
  assert.deepEqual(attempts, snapshot)
})

await test('all failed classifications produce zero accuracy and F1, not an empty successful denominator', () => {
  const result = classificationMetrics(
    ['a', 'b'],
    [
      { expectedClassId: 'a', outcome: { status: 'failed' }, latencyMs: 50 },
      { expectedClassId: 'b', outcome: { status: 'unknown' }, latencyMs: 70 },
    ],
  )
  assert.equal(result.accuracy, 0)
  assert.equal(result.macroF1, 0)
  assert.equal(result.latency.count, 2)
  assert.deepEqual(
    result.perClass.map((item) => item.fn),
    [1, 1],
  )
})

await test('macro F1 includes a declared class with no examples using zero-division zero', () => {
  const result = classificationMetrics(
    ['a', 'unused'],
    [{ expectedClassId: 'a', outcome: { status: 'ok', choice: 'a' }, latencyMs: 0 }],
  )
  assert.equal(result.accuracy, 1)
  assert.equal(result.macroF1, 0.5)
  assert.equal(result.perClass[1]?.support, 0)
})

await test('empty classification runs report null aggregate rates and preserve explicit zero confusion', () => {
  const result = classificationMetrics(['unknown', 'failed'], [])
  assert.equal(result.attempted, 0)
  assert.equal(result.accuracy, null)
  assert.equal(result.macroF1, null)
  assert.deepEqual(
    result.perClass.map((item) => item.support),
    [0, 0],
  )
  assert.equal(result.latency.count, 0)
  assert.equal(result.latency.p50Ms, null)
  assert.equal(result.latency.p95Ms, null)
})

await test('class IDs cannot collide with evaluator buckets or object prototypes', () => {
  const ids = ['unknown', 'failed', 'constructor', '__proto__']
  const result = classificationMetrics(
    ids,
    ids.map((id) => ({
      expectedClassId: id,
      outcome: { status: 'ok' as const, choice: id },
      latencyMs: 1,
    })),
  )
  assert.equal(result.accuracy, 1)
  assert.equal(result.macroF1, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.operationalUnknown, 0)
})

await test('classification rejects missing/duplicate taxonomy and unrecognized labels', () => {
  assert.throws(() => classificationMetrics([], []), RangeError)
  assert.throws(() => classificationMetrics(['a', 'a'], []), RangeError)
  assert.throws(() => classificationMetrics([''], []), RangeError)
  assert.throws(
    () =>
      classificationMetrics(
        ['a'],
        [{ expectedClassId: 'other', outcome: { status: 'failed' }, latencyMs: 0 }],
      ),
    RangeError,
  )
  assert.throws(
    () =>
      classificationMetrics(
        ['a'],
        [{ expectedClassId: 'a', outcome: { status: 'ok', choice: 'other' }, latencyMs: 0 }],
      ),
    RangeError,
  )
})

await test('latencies use nearest rank without mutating samples and include the slow failure tail', () => {
  const values = Object.freeze([1000, 30, 20, 10, 40])
  const result = latencyMetrics(values)
  assert.deepEqual(result, {
    count: 5,
    minMs: 10,
    maxMs: 1000,
    meanMs: 220,
    p50Ms: 30,
    p95Ms: 1000,
    quantileMethod: 'nearest-rank',
  })
  assert.deepEqual(values, [1000, 30, 20, 10, 40])
  assert.equal(latencyMetrics([1, 2]).p50Ms, 1)
  assert.equal(latencyMetrics([0]).p95Ms, 0)
  assert.equal(latencyMetrics([]).meanMs, null)
  for (const value of [-1, NaN, Infinity]) assert.throws(() => latencyMetrics([value]), RangeError)
})

const target: NormalizedRect = { left: 0.2, top: 0.2, width: 0.2, height: 0.2 }
const secondTarget: NormalizedRect = { left: 0.7, top: 0.7, width: 0.2, height: 0.2 }
const present = (
  outcome: LocalizationAttempt['outcome'],
  latencyMs: number,
  boxes: readonly NormalizedRect[] = [target],
): LocalizationAttempt => ({ expected: { presence: 'present', boxes }, outcome, latencyMs })
const negative = (
  outcome: LocalizationAttempt['outcome'],
  latencyMs: number,
): LocalizationAttempt => ({ expected: { presence: 'absent', verified: true }, outcome, latencyMs })

await test('localization scores edge hits, any GT instance, distance, negatives and failed attempts separately', () => {
  const attempts = [
    present({ status: 'located', region: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 } }, 1),
    present({ status: 'located', region: { left: 0.75, top: 0.75, width: 0.1, height: 0.1 } }, 2, [
      target,
      secondTarget,
    ]),
    present({ status: 'located', region: { left: 0.8, top: 0.8, width: 0.1, height: 0.1 } }, 3),
    present({ status: 'failed' }, 4),
    present({ status: 'unknown' }, 5),
    present({ status: 'not-found' }, 6),
    negative({ status: 'located', region: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 } }, 7),
    negative({ status: 'not-found' }, 8),
    negative({ status: 'unknown' }, 9),
    negative({ status: 'failed' }, 10),
  ]
  const snapshot = structuredClone(attempts)
  const result = localizationMetrics(attempts)
  assert.equal(result.attempted, 10)
  assert.equal(result.successful, 3)
  close(result.overallSuccessRate, 0.3)
  assert.deepEqual(result.present, {
    attempted: 6,
    located: 3,
    hits: 2,
    misses: 4,
    failed: 1,
    unknown: 1,
    notFound: 1,
    hitRate: 1 / 3,
  })
  assert.deepEqual(result.negative, {
    attempted: 4,
    falsePositives: 1,
    correctRejections: 1,
    failed: 1,
    unknown: 1,
    falsePositiveRate: 0.25,
    correctRejectionRate: 0.25,
  })
  assert.equal(result.cases[0]?.pointInsideAnyBox, true)
  assert.equal(result.cases[1]?.pointInsideAnyBox, true)
  close(result.cases[2]?.distanceToNearestBox ?? null, 0.45)
  assert.equal(result.cases[3]?.distanceToNearestBox, null)
  assert.equal(result.cases[3]?.pointInsideAnyBox, false)
  assert.equal(result.cases[6]?.pointInsideAnyBox, null)
  assert.equal(result.cases[6]?.distanceToNearestBox, null)
  assert.equal(result.locatedAreaFraction.count, 4)
  close(result.locatedAreaFraction.mean, 0.025)
  assert.equal(result.presentLocatedDistance.count, 3)
  close(result.presentLocatedDistance.mean, 0.15)
  close(result.presentLocatedDistance.p95, 0.45)
  close(result.geometryCoverage, 0.4)
  assert.equal(result.latency.p50Ms, 5)
  assert.equal(result.latency.p95Ms, 10)
  assert.deepEqual(attempts, snapshot)
})

await test('localization uses region center, not any region overlap or enclosing union of GT boxes', () => {
  const result = localizationMetrics([
    present({ status: 'located', region: { left: 0, top: 0, width: 1, height: 1 } }, 1, [
      target,
      secondTarget,
    ]),
  ])
  assert.equal(result.present.hits, 0)
  assert.equal(result.locatedAreaFraction.mean, 1)
  close(result.presentLocatedDistance.mean, 0.1)
})

await test('all image corners and right/bottom box boundaries count as closed edges', () => {
  for (const box of [
    { left: 0, top: 0, width: 0.2, height: 0.2 },
    { left: 0.8, top: 0.8, width: 0.2, height: 0.2 },
    { left: 0.8, top: 0, width: 0.2, height: 0.2 },
    { left: 0, top: 0.8, width: 0.2, height: 0.2 },
  ]) {
    const result = localizationMetrics([present({ status: 'located', region: box }, 0, [box])])
    assert.equal(result.present.hits, 1)
    assert.equal(result.presentLocatedDistance.max, 0)
  }
  const rightBottom = localizationMetrics([
    present({ status: 'located', region: { left: 0.3, top: 0.3, width: 0.2, height: 0.2 } }, 0),
  ])
  assert.equal(rightBottom.present.hits, 1)
})

await test('empty and all-failed localization runs do not fabricate zero distances or successes', () => {
  const empty = localizationMetrics([])
  assert.equal(empty.overallSuccessRate, null)
  assert.equal(empty.present.hitRate, null)
  assert.equal(empty.negative.falsePositiveRate, null)
  assert.equal(empty.presentLocatedDistance.mean, null)
  const failed = localizationMetrics([
    present({ status: 'failed' }, 300),
    negative({ status: 'failed' }, 400),
  ])
  assert.equal(failed.overallSuccessRate, 0)
  assert.equal(failed.present.hitRate, 0)
  assert.equal(failed.negative.correctRejectionRate, 0)
  assert.equal(failed.geometryCoverage, 0)
  assert.equal(failed.locatedAreaFraction.count, 0)
  assert.equal(failed.presentLocatedDistance.count, 0)
  assert.equal(failed.presentLocatedDistance.mean, null)
  assert.equal(failed.latency.p95Ms, 400)
})

await test('localization rejects absent verification, missing GT, invalid geometry and invalid failure latency', () => {
  const unverified = negative({ status: 'not-found' }, 0)
  Object.assign(unverified.expected, { verified: false })
  assert.throws(() => localizationMetrics([unverified]), RangeError)
  assert.throws(() => localizationMetrics([present({ status: 'unknown' }, 0, [])]), RangeError)
  for (const rect of [
    { left: -0.1, top: 0, width: 0.1, height: 0.1 },
    { left: 0, top: 0, width: 0, height: 0.1 },
    { left: 0.95, top: 0, width: 0.1, height: 0.1 },
    { left: NaN, top: 0, width: 0.1, height: 0.1 },
  ])
    assert.throws(
      () => localizationMetrics([present({ status: 'located', region: rect }, 0)]),
      RangeError,
    )
  assert.throws(() => localizationMetrics([present({ status: 'failed' }, Infinity)]), RangeError)
})

await test('native parity compares exact classes, raw probability differences and all-attempt denominator', () => {
  const attempts: ParityAttempt[] = [
    {
      library: { choice: 'a', probabilities: { a: 0.6, b: 0.4 } },
      native: { choice: 'a', probabilities: { b: 0.4, a: 0.6 } },
    },
    {
      library: { choice: 'a', probabilities: { a: 0.6, b: 0.4 } },
      native: { choice: 'b', probabilities: { a: 0.4, b: 0.6 } },
    },
    { library: null, native: null },
    { library: { choice: 'unknown' }, native: null },
    { library: { choice: 'unknown' }, native: { choice: 'unknown' } },
  ]
  const snapshot = structuredClone(attempts)
  const result = parityMetrics(attempts)
  assert.equal(result.attempted, 5)
  assert.equal(result.paired, 3)
  assert.equal(result.classMatches, 2)
  assert.equal(result.classMatchRateAllAttempts, 0.4)
  close(result.classMatchRatePaired, 2 / 3)
  assert.equal(result.missingLibrary, 1)
  assert.equal(result.missingNative, 2)
  assert.equal(result.probabilityPairs, 2)
  assert.equal(result.exactProbabilityMatches, 1)
  close(result.maxAbsoluteProbabilityDifference.max, 0.2)
  assert.deepEqual(attempts, snapshot)
})

await test('unmatched probability keys are unavailable rather than implicitly filled with zeros', () => {
  const result = parityMetrics([
    {
      library: { choice: 'a', probabilities: { a: 1 } },
      native: { choice: 'a', probabilities: { a: 1, b: 0 } },
    },
  ])
  assert.equal(result.classMatches, 1)
  assert.equal(result.probabilityPairs, 0)
  assert.equal(result.unavailableProbabilityPairs, 1)
  assert.equal(result.maxAbsoluteProbabilityDifference.max, null)
})

await test('parity preserves empty/failure cases and rejects malformed probability measurements', () => {
  const result = parityMetrics([])
  assert.equal(result.classMatchRateAllAttempts, null)
  assert.equal(result.classMatchRatePaired, null)
  assert.equal(result.maxAbsoluteProbabilityDifference.max, null)
  const failed = parityMetrics([{ library: null, native: null }])
  assert.equal(failed.classMatches, 0)
  assert.equal(failed.classMatchRateAllAttempts, 0)
  assert.equal(failed.classMatchRatePaired, null)
  assert.throws(
    () =>
      parityMetrics([
        {
          library: { choice: 'a', probabilities: { a: NaN } },
          native: { choice: 'a', probabilities: { a: 1 } },
        },
      ]),
    RangeError,
  )
})
