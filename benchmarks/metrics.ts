/** Pure evaluator helpers. These DTOs and ground truth must never enter model requests. */
export interface ClassificationAttempt {
  expectedClassId: string
  /** A semantic class named "unknown" is an ordinary ok choice, never this status. */
  outcome: { status: 'ok'; choice: string } | { status: 'unknown' } | { status: 'failed' }
  latencyMs: number
}

/** Coordinates are fractions of the oriented source image, not pixels or segmentation. */
export interface NormalizedRect {
  left: number
  top: number
  width: number
  height: number
}

export interface LocalizationAttempt {
  expected:
    | { presence: 'present'; boxes: readonly NormalizedRect[] }
    | { presence: 'absent'; verified: true }
  outcome:
    | { status: 'located'; region: NormalizedRect }
    | { status: 'not-found' }
    | { status: 'unknown' }
    | { status: 'failed' }
  latencyMs: number
}

export interface ParityAttempt {
  /** null means failed/unavailable. Two missing answers do not constitute parity. */
  library: { choice: string; probabilities?: Readonly<Record<string, number>> } | null
  native: { choice: string; probabilities?: Readonly<Record<string, number>> } | null
}

function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new RangeError(message)
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function distribution(values: readonly number[]) {
  requireValue(
    values.every((value) => Number.isFinite(value) && value >= 0),
    'Expected finite nonnegative measurements',
  )
  const sorted = values.toSorted((a, b) => a - b)
  let mean = 0
  sorted.forEach((value, index) => {
    mean += (value - mean) / (index + 1)
  })
  const quantile = (fraction: number) => sorted[Math.ceil(fraction * sorted.length) - 1] ?? null
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    mean: sorted.length === 0 ? null : mean,
    p50: quantile(0.5),
    p95: quantile(0.95),
  }
}

/** Nearest-rank quantiles; include elapsed time for every attempt, including failures. */
export function latencyMetrics(milliseconds: readonly number[]) {
  const result = distribution(milliseconds)
  return {
    count: result.count,
    minMs: result.min,
    maxMs: result.max,
    meanMs: result.mean,
    p50Ms: result.p50,
    p95Ms: result.p95,
    quantileMethod: 'nearest-rank' as const,
  }
}

/** Macro-F1 includes every supplied class with zero-division=0; empty runs yield null. */
export function classificationMetrics(
  classes: readonly string[],
  attempts: readonly ClassificationAttempt[],
) {
  requireValue(
    classes.length > 0 &&
      classes.every((id) => id.length > 0) &&
      new Set(classes).size === classes.length,
    'Expected unique nonempty class IDs',
  )
  const classSet = new Set(classes)
  const confusion = classes.map((expectedClassId) => ({
    expectedClassId,
    predictions: classes.map((classId) => ({ classId, count: 0 })),
    operationalUnknown: 0,
    failed: 0,
  }))
  let correct = 0
  let failed = 0
  let operationalUnknown = 0
  for (const attempt of attempts) {
    const row = confusion.find((item) => item.expectedClassId === attempt.expectedClassId)
    requireValue(row !== undefined, 'Expected class is outside the supplied taxonomy')
    if (attempt.outcome.status === 'failed') {
      row.failed++
      failed++
    } else if (attempt.outcome.status === 'unknown') {
      row.operationalUnknown++
      operationalUnknown++
    } else {
      const choice = attempt.outcome.choice
      requireValue(classSet.has(choice), 'Predicted class is outside the supplied taxonomy')
      const prediction = row.predictions.find((item) => item.classId === choice)
      requireValue(prediction !== undefined, 'Predicted class is outside the supplied taxonomy')
      prediction.count++
      if (choice === attempt.expectedClassId) correct++
    }
  }
  const perClass = confusion.map((row) => {
    const tp = row.predictions.find((item) => item.classId === row.expectedClassId)?.count ?? 0
    const support = row.predictions.reduce(
      (sum, item) => sum + item.count,
      row.failed + row.operationalUnknown,
    )
    const fp = confusion.reduce(
      (sum, other) =>
        sum +
        (other === row
          ? 0
          : (other.predictions.find((item) => item.classId === row.expectedClassId)?.count ?? 0)),
      0,
    )
    const fn = support - tp
    return {
      classId: row.expectedClassId,
      support,
      tp,
      fp,
      fn,
      precision: ratio(tp, tp + fp) ?? 0,
      recall: ratio(tp, support) ?? 0,
      f1: ratio(2 * tp, 2 * tp + fp + fn) ?? 0,
    }
  })
  return {
    attempted: attempts.length,
    classified: attempts.length - failed - operationalUnknown,
    correct,
    failed,
    operationalUnknown,
    accuracy: ratio(correct, attempts.length),
    macroF1:
      attempts.length === 0
        ? null
        : perClass.reduce((sum, item) => sum + item.f1, 0) / classes.length,
    zeroDivision: 0,
    confusion,
    perClass,
    latency: latencyMetrics(attempts.map((attempt) => attempt.latencyMs)),
  }
}

const geometryEpsilon = 1e-12
function validateRect(rect: NormalizedRect): void {
  requireValue(
    [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite),
    'Expected finite normalized rectangle',
  )
  requireValue(
    rect.left >= 0 &&
      rect.top >= 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left + rect.width <= 1 + geometryEpsilon &&
      rect.top + rect.height <= 1 + geometryEpsilon,
    'Expected positive rectangle within the normalized image',
  )
}

function scoreLocalization(attempt: LocalizationAttempt) {
  if (attempt.expected.presence === 'present') {
    requireValue(
      attempt.expected.boxes.length > 0,
      'Present ground truth requires at least one box',
    )
    attempt.expected.boxes.forEach(validateRect)
  } else {
    requireValue(
      attempt.expected.verified === true,
      'Negative ground truth must be explicitly verified',
    )
  }
  if (attempt.outcome.status !== 'located') {
    return {
      presence: attempt.expected.presence,
      status: attempt.outcome.status,
      center: null,
      areaFraction: null,
      distanceToNearestBox: null,
      pointInsideAnyBox: attempt.expected.presence === 'present' ? false : null,
    }
  }
  const region = attempt.outcome.region
  validateRect(region)
  const center = { x: region.left + region.width / 2, y: region.top + region.height / 2 }
  const areaFraction = Math.min(1, region.width * region.height)
  if (attempt.expected.presence === 'absent') {
    return {
      presence: 'absent' as const,
      status: 'located' as const,
      center,
      areaFraction,
      distanceToNearestBox: null,
      pointInsideAnyBox: null,
    }
  }
  const distances = attempt.expected.boxes.map((box) => {
    const dx = Math.max(box.left - center.x, 0, center.x - box.left - box.width)
    const dy = Math.max(box.top - center.y, 0, center.y - box.top - box.height)
    return Math.hypot(dx <= geometryEpsilon ? 0 : dx, dy <= geometryEpsilon ? 0 : dy) / Math.SQRT2
  })
  const distanceToNearestBox = Math.min(...distances)
  return {
    presence: 'present' as const,
    status: 'located' as const,
    center,
    areaFraction,
    distanceToNearestBox,
    pointInsideAnyBox: distanceToNearestBox === 0,
  }
}

/**
 * Uses the returned cell's center, not object-center error or segmentation IoU.
 * Box edges are inclusive (1e-12 arithmetic tolerance). Distance is normalized XY
 * Euclidean distance to the nearest box, divided by sqrt(2), hence lies in [0,1].
 * Failure/unknown/not-found are misses for positives. Only not-found is a correct
 * negative rejection. Missing geometry stays null and is never assigned distance 0.
 */
export function localizationMetrics(attempts: readonly LocalizationAttempt[]) {
  const cases = attempts.map(scoreLocalization)
  const positives = cases.filter((item) => item.presence === 'present')
  const negatives = cases.filter((item) => item.presence === 'absent')
  const hits = positives.filter((item) => item.pointInsideAnyBox === true).length
  const correctRejections = negatives.filter((item) => item.status === 'not-found').length
  const falsePositives = negatives.filter((item) => item.status === 'located').length
  const located = cases.filter((item) => item.status === 'located').length
  const count = (items: typeof cases, status: LocalizationAttempt['outcome']['status']) =>
    items.filter((item) => item.status === status).length
  return {
    attempted: attempts.length,
    located,
    failed: count(cases, 'failed'),
    unknown: count(cases, 'unknown'),
    notFound: count(cases, 'not-found'),
    successful: hits + correctRejections,
    overallSuccessRate: ratio(hits + correctRejections, attempts.length),
    present: {
      attempted: positives.length,
      located: count(positives, 'located'),
      hits,
      misses: positives.length - hits,
      failed: count(positives, 'failed'),
      unknown: count(positives, 'unknown'),
      notFound: count(positives, 'not-found'),
      hitRate: ratio(hits, positives.length),
    },
    negative: {
      attempted: negatives.length,
      falsePositives,
      correctRejections,
      failed: count(negatives, 'failed'),
      unknown: count(negatives, 'unknown'),
      falsePositiveRate: ratio(falsePositives, negatives.length),
      correctRejectionRate: ratio(correctRejections, negatives.length),
    },
    locatedAreaFraction: distribution(
      cases.flatMap((item) => (item.areaFraction === null ? [] : [item.areaFraction])),
    ),
    presentLocatedDistance: distribution(
      positives.flatMap((item) =>
        item.distanceToNearestBox === null ? [] : [item.distanceToNearestBox],
      ),
    ),
    geometryCoverage: ratio(located, attempts.length),
    distanceUnit: 'normalized-xy-euclidean-divided-by-sqrt2' as const,
    latency: latencyMetrics(attempts.map((attempt) => attempt.latencyMs)),
    cases,
  }
}

function probabilityDifference(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): number | null {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  requireValue(
    [...Object.values(left), ...Object.values(right)].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ),
    'Expected finite probability values in [0,1]',
  )
  if (
    leftKeys.length === 0 ||
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key) => !Object.hasOwn(right, key))
  )
    return null
  return leftKeys.reduce(
    (max, key) => Math.max(max, Math.abs((left[key] ?? 0) - (right[key] ?? 0))),
    0,
  )
}

/** Native/library parity compares exact class IDs; vectors are never renormalized. */
export function parityMetrics(attempts: readonly ParityAttempt[]) {
  let paired = 0
  let classMatches = 0
  let exactProbabilityMatches = 0
  const differences: number[] = []
  for (const attempt of attempts) {
    if (attempt.library === null || attempt.native === null) continue
    requireValue(
      attempt.library.choice.length > 0 && attempt.native.choice.length > 0,
      'Expected nonempty parity choices',
    )
    paired++
    if (attempt.library.choice === attempt.native.choice) classMatches++
    if (attempt.library.probabilities !== undefined && attempt.native.probabilities !== undefined) {
      const difference = probabilityDifference(
        attempt.library.probabilities,
        attempt.native.probabilities,
      )
      if (difference !== null) {
        differences.push(difference)
        if (difference === 0) exactProbabilityMatches++
      }
    }
  }
  return {
    attempted: attempts.length,
    paired,
    missingLibrary: attempts.filter((attempt) => attempt.library === null).length,
    missingNative: attempts.filter((attempt) => attempt.native === null).length,
    classMatches,
    classMatchRateAllAttempts: ratio(classMatches, attempts.length),
    classMatchRatePaired: ratio(classMatches, paired),
    probabilityPairs: differences.length,
    unavailableProbabilityPairs: attempts.length - differences.length,
    exactProbabilityMatches,
    maxAbsoluteProbabilityDifference: distribution(differences),
  }
}
