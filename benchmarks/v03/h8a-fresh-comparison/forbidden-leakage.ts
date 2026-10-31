const FORBIDDEN_EVALUATOR_KEYS = new Set([
  'stratum',
  'sourceGroup',
  'source_group',
  'groundTruth',
  'ground_truth',
  'expectedPresence',
  'expected_presence',
  'referenceBox',
  'reference_box',
  'referenceMask',
  'reference_mask',
  'targetBoxes',
  'split',
  'heldout',
  'qualificationTruth',
  'evaluatorAnnotation',
  'url',
  'license',
  'sourceMetadata',
  'label',
  'labels',
])

function collectKeys(value: unknown, prefix: string, found: string[]): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, prefix, found)
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (FORBIDDEN_EVALUATOR_KEYS.has(key)) found.push(path)
    collectKeys(nested, path, found)
  }
}

function findForbiddenEvaluatorFields(value: unknown): readonly string[] {
  const found: string[] = []
  collectKeys(value, '', found)
  return found
}

export function assertNoForbiddenEvaluatorFields(value: unknown, context: string): void {
  const fields = findForbiddenEvaluatorFields(value)
  if (fields.length > 0)
    throw new RangeError(
      `${context} contains forbidden evaluator-only fields: ${fields.join(', ')}`,
    )
}
