import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PHASE_DEV40_ID,
  PHASE_QUAL120_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
} from './constants.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import {
  evaluateDev40Gate,
  evaluatePhaseGate,
  joinCloseoutsWithPrivateAnnotations,
  validateImmutableCloseouts,
} from './evaluator.js'
import { phaseFreezeSchema } from './schemas.js'
import { boxIoUAndReferenceCoverage, binaryMaskIoU } from './geometry-metrics.js'
import {
  buildCloseout,
  buildDev40Annotations,
  buildOutputRow,
  buildSyntheticAnnotationBundle,
  buildSyntheticPhaseFreeze,
} from './test-fixtures.js'

await test('positive box thresholds require IoU and reference coverage together', () => {
  const reference = { left: 0, top: 0, width: 10, height: 10 }
  const lowIou = boxIoUAndReferenceCoverage({ left: 8, top: 8, width: 2, height: 2 }, reference)
  assert.equal(lowIou.matched, false)
  const matched = boxIoUAndReferenceCoverage({ left: 0, top: 0, width: 10, height: 10 }, reference)
  assert.equal(matched.matched, true)
})

await test('missing prediction mask scores zero IoU while staying in denominator', () => {
  const reference = new Uint8Array(16).fill(0)
  reference[0] = 1
  reference[1] = 1
  const predicted = new Uint8Array(16).fill(0)
  assert.equal(binaryMaskIoU(predicted, reference).iou, 0)
})

await test('evaluator rejects corrupted closeout hash and duplicate receipts', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const rows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  const candidate = buildCloseout(freeze, PROFILE_CANDIDATE_ID, rows)
  const control = buildCloseout(
    freeze,
    PROFILE_CONTROL_ID,
    rows.map((row) => ({ ...row, profileId: PROFILE_CONTROL_ID })),
  )
  validateImmutableCloseouts({ freeze, candidateCloseout: candidate, controlCloseout: control })
  const corrupted = {
    ...candidate,
    closeoutSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }
  assert.throws(() =>
    validateImmutableCloseouts({ freeze, candidateCloseout: corrupted, controlCloseout: control }),
  )
  const duplicateLogical = {
    ...control,
    logicalReceipts: [
      ...control.logicalReceipts,
      { ...control.logicalReceipts[0]!, logicalId: control.logicalReceipts[0]!.logicalId },
    ],
  }
  assert.throws(() =>
    validateImmutableCloseouts({
      freeze,
      candidateCloseout: candidate,
      controlCloseout: duplicateLogical,
    }),
  )
})

await test('DEV40 gate counts false box/cutout negatives and full positive denominator', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const presentIds = new Set(
    annotations.cases
      .filter((item) => item.expectedPresence === 'present')
      .map((item) => item.opaqueCaseId),
  )
  const candidateRows = freeze.producerCases.map((row) => {
    const present = presentIds.has(row.opaqueCaseId)
    if (!present) {
      return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
        caseState: 'success',
        box: { left: 1, top: 1, width: 2, height: 2 },
        cutoutPresent: true,
      })
    }
    return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
      caseState: 'success',
      box: { left: 1, top: 1, width: 4, height: 4 },
    })
  })
  const controlRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  const candidateCloseout = buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows)
  const controlCloseout = buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows)
  const joined = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout,
    controlCloseout,
    annotations,
    packedMasksBySha256: new Map(),
  })
  const gate = evaluateDev40Gate(joined)
  assert.deepEqual(evaluatePhaseGate(PHASE_DEV40_ID, joined), gate)
  assert.equal(gate.positiveDenominator, 30)
  assert.equal(gate.falseNegativeOutputs, 10)
  assert.equal(gate.observedNegativeDenominator, 10)
  assert.equal(gate.qualityPass, false)
  assert.equal(gate.positiveSuccesses, 30)
})

await test('invalid negative with box counts as false output', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const negativeId = annotations.cases.find(
    (item) => item.expectedPresence === 'absent',
  )!.opaqueCaseId
  const candidateRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  const negativeIndex = freeze.producerCases.findIndex((row) => row.opaqueCaseId === negativeId)
  candidateRows[negativeIndex] = buildOutputRow(negativeId, PROFILE_CANDIDATE_ID, {
    executionValidity: 'invalid',
    caseState: 'malformed',
    box: { left: 0, top: 0, width: 2, height: 2 },
    cutoutPresent: false,
  })
  const controlRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  const joined = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
    controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    annotations,
    packedMasksBySha256: new Map(),
  })
  const gate = evaluateDev40Gate(joined)
  assert.equal(gate.falseNegativeOutputs, 1)
  assert.equal(gate.executionValid, false)
  assert.equal(gate.qualityPass, false)
})

await test('closeout freeze mismatch fails before scoring', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const rows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  rows.pop()
  const candidate = buildCloseout(freeze, PROFILE_CANDIDATE_ID, rows)
  const control = buildCloseout(
    freeze,
    PROFILE_CONTROL_ID,
    freeze.producerCases.map((row) => buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID)),
  )
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze,
      candidateCloseout: candidate,
      controlCloseout: control,
      annotations: buildDev40Annotations(freeze),
      packedMasksBySha256: new Map(),
    }),
  )
})

await test('missing reference mask bytes fail closed for qualification masks', () => {
  const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  const maskSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  let photoPositiveMaskSlots = 0
  const annotationsBase = buildSyntheticAnnotationBundle(
    PHASE_QUAL120_ID,
    baseFreeze.freezeId,
    baseFreeze.producerCases,
    baseFreeze.pairedSchedule,
  )
  const annotations = {
    ...annotationsBase,
    cases: annotationsBase.cases.map((item) => {
      const exactMask =
        item.expectedPresence === 'present' &&
        item.stratum === 'photo' &&
        photoPositiveMaskSlots++ < 30
      const producer = baseFreeze.producerCases.find(
        (row) => row.opaqueCaseId === item.opaqueCaseId,
      )!
      return {
        ...item,
        referenceMasks: exactMask
          ? [
              {
                width: producer.sourceCanvasWidth,
                height: producer.sourceCanvasHeight,
                packedBinarySha256: maskSha,
              },
            ]
          : [],
        exactOriginalCanvasMaskRef: exactMask,
      }
    }),
  }
  const freeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  })
  const rows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  const candidate = buildCloseout(freeze, PROFILE_CANDIDATE_ID, rows)
  const control = buildCloseout(
    freeze,
    PROFILE_CONTROL_ID,
    rows.map((row) => ({ ...row, profileId: PROFILE_CONTROL_ID })),
  )
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze,
      candidateCloseout: candidate,
      controlCloseout: control,
      annotations,
      packedMasksBySha256: new Map(),
    }),
  )
})

await test('evaluator rejects truth leakage in closeout rows', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const rows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  rows[0] = {
    ...rows[0]!,
    stratum: 'photo',
  } as (typeof rows)[0]
  const candidate = buildCloseout(freeze, PROFILE_CANDIDATE_ID, rows)
  const control = buildCloseout(freeze, PROFILE_CONTROL_ID, rows)
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze,
      candidateCloseout: candidate,
      controlCloseout: control,
      annotations: buildDev40Annotations(freeze),
      packedMasksBySha256: new Map(),
    }),
  )
})
