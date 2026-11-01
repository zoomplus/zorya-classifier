import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { DEV_SCREEN_SEED } from './dev-screen-sampling.js'
import {
  buildDevScreenSelection,
  persistDevScreenSelection,
  validateDevScreenSelection,
} from './dev-screen-sampling.js'
import { PHASE_DEV40_ID, PHASE_FLAT_DEV40_ID } from './constants.js'
import { buildSyntheticAnnotationBundle, buildSyntheticPhaseFreeze } from './test-fixtures.js'
import type { EvaluatorPrivateAnnotationBundle } from './schemas.js'

function makeFixture() {
  const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildSyntheticAnnotationBundle(
    baseFreeze.phaseId,
    baseFreeze.freezeId,
    baseFreeze.producerCases,
    baseFreeze.pairedSchedule,
  )
  const committedFreeze = {
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  }
  return { freeze: committedFreeze, annotations }
}

await test('DEV8 and DEV12 use fixed nested six-cell quotas and probabilities', () => {
  const { freeze, annotations } = makeFixture()
  const selection = buildDevScreenSelection(freeze, annotations)
  assert.equal(selection.seed, DEV_SCREEN_SEED)
  assert.equal(selection.dev8CaseIds.length, 8)
  assert.equal(selection.dev12CaseIds.length, 12)
  assert.ok(selection.dev8CaseIds.every((id) => selection.dev12CaseIds.includes(id)))
  assert.deepEqual(
    selection.cells.map((cell) => [
      cell.stratum,
      cell.expectedPresence,
      cell.populationCount,
      cell.dev8Quota,
      cell.dev8InclusionProbability,
      cell.dev12Quota,
      cell.dev12InclusionProbability,
    ]),
    [
      ['photo', 'present', 16, 2, 2 / 16, 3, 3 / 16],
      ['photo', 'absent', 4, 1, 1 / 4, 1, 1 / 4],
      ['ui', 'present', 7, 2, 2 / 7, 3, 3 / 7],
      ['ui', 'absent', 3, 1, 1 / 3, 1, 1 / 3],
      ['map', 'present', 7, 1, 1 / 7, 3, 3 / 7],
      ['map', 'absent', 3, 1, 1 / 3, 1, 1 / 3],
    ],
  )
  assert.deepEqual(selection, buildDevScreenSelection(freeze, annotations))
  assert.deepEqual(validateDevScreenSelection(selection, freeze, annotations), selection)
})

await test('screen selection rejects annotation truth changed under the existing freeze', () => {
  const { freeze, annotations } = makeFixture()
  const changed: EvaluatorPrivateAnnotationBundle = {
    ...annotations,
    cases: annotations.cases.map((item, index) =>
      index === 0 ? { ...item, expectedPresence: 'absent' as const } : item,
    ),
  }
  assert.notEqual(computeEvaluatorAnnotationsSha256(changed), freeze.evaluatorAnnotationsSha256)
  assert.throws(() => buildDevScreenSelection(freeze, changed), /annotation commitment/u)
})

await test('persisted selection is byte-immutable and retains both draws before outcomes', async () => {
  const { freeze, annotations } = makeFixture()
  const selection = buildDevScreenSelection(freeze, annotations)
  const root = await mkdtemp(join(tmpdir(), 'h8a-screen-selection-'))
  const path = join(root, 'selection.json')
  try {
    await persistDevScreenSelection(path, selection)
    const bytes = await readFile(path, 'utf8')
    const stored: unknown = JSON.parse(bytes)
    assert.deepEqual(stored, selection)
    assert.equal(bytes.endsWith('\n'), true)
    await persistDevScreenSelection(path, selection)
    const otherAnnotations = { ...annotations, freezeId: 'other-screen-freeze' }
    const otherFreezeBase = { ...freeze, freezeId: 'other-screen-freeze' }
    const otherFreeze = {
      ...otherFreezeBase,
      evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(otherAnnotations),
    }
    const otherSelection = buildDevScreenSelection(otherFreeze, otherAnnotations)
    await assert.rejects(() => persistDevScreenSelection(path, otherSelection), /immutable/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('flat DEV profile gets a separately committed freeze with the same seeded nested case positions', () => {
  const makeFlatFixture = () => {
    const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_FLAT_DEV40_ID)
    const annotations = buildSyntheticAnnotationBundle(
      baseFreeze.phaseId,
      baseFreeze.freezeId,
      baseFreeze.producerCases,
      baseFreeze.pairedSchedule,
    )
    const freeze = {
      ...baseFreeze,
      evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
    }
    return { freeze, annotations }
  }
  const legacy = makeFixture()
  const flat = makeFlatFixture()
  const legacySelection = buildDevScreenSelection(legacy.freeze, legacy.annotations)
  const flatSelection = buildDevScreenSelection(flat.freeze, flat.annotations)
  const positions = (ids: readonly string[], prefix: string) =>
    ids.map((id) => Number(id.slice(prefix.length).replace('-case-', '')))
  assert.deepEqual(
    positions(flatSelection.dev8CaseIds, PHASE_FLAT_DEV40_ID),
    positions(legacySelection.dev8CaseIds, PHASE_DEV40_ID),
  )
  assert.deepEqual(
    positions(flatSelection.dev12CaseIds, PHASE_FLAT_DEV40_ID),
    positions(legacySelection.dev12CaseIds, PHASE_DEV40_ID),
  )
  assert.notEqual(
    flatSelection.selectionCommitmentSha256,
    legacySelection.selectionCommitmentSha256,
  )
  assert.deepEqual(
    validateDevScreenSelection(flatSelection, flat.freeze, flat.annotations),
    flatSelection,
  )
})
