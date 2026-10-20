/** Evaluator-only data. Neither reference boxes nor masks belong in provider requests. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new RangeError(message)
}

function validateBox(box: Box): void {
  requireValue(
    [box.left, box.top, box.width, box.height].every(Number.isFinite) &&
      box.left >= 0 &&
      box.top >= 0 &&
      box.width > 0 &&
      box.height > 0 &&
      Number.isFinite(box.left + box.width) &&
      Number.isFinite(box.top + box.height),
    'Expected a finite positive box in a common coordinate space',
  )
}

/** IoU and visible-reference coverage must pass together, for the same instance. */
export function wholeObjectMatch(predicted: Box, references: readonly Box[]) {
  validateBox(predicted)
  requireValue(references.length > 0, 'Present target requires a reference instance')
  const instances = references.map((reference, index) => {
    validateBox(reference)
    const width = Math.max(
      0,
      Math.min(predicted.left + predicted.width, reference.left + reference.width) -
        Math.max(predicted.left, reference.left),
    )
    const height = Math.max(
      0,
      Math.min(predicted.top + predicted.height, reference.top + reference.height) -
        Math.max(predicted.top, reference.top),
    )
    const intersection = width * height
    const referenceArea = reference.width * reference.height
    const union = predicted.width * predicted.height + referenceArea - intersection
    requireValue(Number.isFinite(union) && union > 0, 'Box area overflow')
    const iou = intersection / union
    const coverage = intersection / referenceArea
    return { index, iou, coverage, matched: iou >= 0.5 && coverage >= 0.9 }
  })
  return { matched: instances.some((instance) => instance.matched), instances }
}

/** Source-sized binary masks only. Empty-reference masks are not positive targets. */
export function binaryMaskIoU(predicted: Uint8Array, reference: Uint8Array) {
  requireValue(
    predicted.length > 0 && predicted.length === reference.length,
    'Masks must have equal nonempty dimensions',
  )
  let intersection = 0
  let union = 0
  let referencePixels = 0
  for (let index = 0; index < predicted.length; index++) {
    const prediction = predicted[index]
    const expected = reference[index]
    requireValue(
      (prediction === 0 || prediction === 1) && (expected === 0 || expected === 1),
      'Masks must contain binary 0/1 values',
    )
    if (expected === 1) referencePixels++
    if (prediction === 1 || expected === 1) union++
    if (prediction === 1 && expected === 1) intersection++
  }
  requireValue(referencePixels > 0, 'Positive mask ground truth cannot be empty')
  const iou = intersection / union
  return { intersection, union, iou, matched: iou >= 0.8 }
}

export interface LocalizationCase {
  caseId: string
  expected: { presence: 'present'; boxes: readonly Box[] } | { presence: 'absent'; verified: true }
  outcome: { status: 'located'; region: Box } | { status: 'not-found' | 'unknown' | 'failed' }
}

/** Failures and unknowns remain in the all-attempts and positive denominators. */
export function wholeObjectMetrics(cases: readonly LocalizationCase[]) {
  requireValue(new Set(cases.map((item) => item.caseId)).size === cases.length, 'Duplicate case ID')
  const rows = cases.map((item) => {
    requireValue(item.caseId.length > 0, 'Empty case ID')
    if (item.expected.presence === 'present') {
      requireValue(item.expected.boxes.length > 0, 'Missing positive boxes')
      item.expected.boxes.forEach(validateBox)
      return {
        caseId: item.caseId,
        presence: item.expected.presence,
        status: item.outcome.status,
        correct:
          item.outcome.status === 'located' &&
          wholeObjectMatch(item.outcome.region, item.expected.boxes).matched,
      }
    }
    requireValue(item.expected.verified === true, 'Unverified negative')
    if (item.outcome.status === 'located') validateBox(item.outcome.region)
    return {
      caseId: item.caseId,
      presence: item.expected.presence,
      status: item.outcome.status,
      correct: item.outcome.status === 'not-found',
    }
  })
  const positives = rows.filter((item) => item.presence === 'present')
  const negatives = rows.filter((item) => item.presence === 'absent')
  const matched = positives.filter((item) => item.correct).length
  const falseLocations = negatives.filter((item) => item.status === 'located').length
  return {
    attempted: rows.length,
    positives: positives.length,
    negatives: negatives.length,
    matched,
    localizationRate: positives.length === 0 ? null : matched / positives.length,
    falseLocations,
    falseLocationRate: negatives.length === 0 ? null : falseLocations / negatives.length,
    unknown: rows.filter((item) => item.status === 'unknown').length,
    failed: rows.filter((item) => item.status === 'failed').length,
    correct: rows.filter((item) => item.correct).length,
    rows,
  }
}

export interface PairedOutcome {
  caseId: string
  candidate: boolean
  control: boolean
}

/** Fixed seeded paired bootstrap; resample paired cases, never independent outcomes. */
export function pairedBootstrap(outcomes: readonly PairedOutcome[]) {
  requireValue(outcomes.length > 0, 'Bootstrap needs paired cases')
  requireValue(
    outcomes.every((item) => item.caseId.length > 0) &&
      new Set(outcomes.map((item) => item.caseId)).size === outcomes.length,
    'Expected unique nonempty paired IDs',
  )
  // Canonical order makes the frozen seed independent of collection scheduling.
  const values = outcomes
    .toSorted((left, right) => left.caseId.localeCompare(right.caseId, 'en'))
    .map((item) => Number(item.candidate) - Number(item.control))
  let state = 0x5a4f5259
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
  const samples: number[] = []
  for (let iteration = 0; iteration < 10_000; iteration++) {
    let sum = 0
    for (let draw = 0; draw < values.length; draw++) {
      const value = values[Math.floor(random() * values.length)]
      requireValue(value !== undefined, 'Invalid bootstrap draw')
      sum += value
    }
    samples.push(sum / values.length)
  }
  samples.sort((left, right) => left - right)
  const lower = samples[249]
  const upper = samples[9749]
  requireValue(lower !== undefined && upper !== undefined, 'Missing bootstrap bounds')
  return {
    pairs: values.length,
    iterations: 10_000,
    seed: '0x5a4f5259',
    method: 'paired-percentile-nearest-rank' as const,
    difference: values.reduce((sum, value) => sum + value, 0) / values.length,
    confidence: 0.95,
    lower,
    upper,
    passes: lower > 0,
  }
}
