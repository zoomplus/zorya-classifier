import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PHASE_DEV40_ID,
  PHASE_QUAL120_ID,
  PHASE_SCOPE_DEV40_ID,
  PHASE_SCOPE_QUAL120_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
} from './constants.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import {
  evaluateDev40Gate,
  evaluatePhaseGate,
  joinCloseoutsWithPrivateAnnotations,
  scorePositiveOutputRow,
  validateImmutableCloseouts,
} from './evaluator.js'
import { phaseFreezeSchema } from './schemas.js'
import { boxIoUAndReferenceCoverage, binaryMaskIoU } from './geometry-metrics.js'
import { packBinaryLsb0V1, sha256PackedBytes } from './packed-binary-lsb0.js'
import {
  buildCloseout,
  buildDev40Annotations,
  buildOutputRow,
  buildSyntheticAnnotationBundle,
  buildSyntheticPhaseFreeze,
  SYNTHETIC_SOURCE_CANVAS_HEIGHT,
  SYNTHETIC_SOURCE_CANVAS_WIDTH,
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

await test('authored-scope DEV and QUAL phases dispatch to their unchanged evaluator gates', () => {
  const dev = buildSyntheticPhaseFreeze(PHASE_SCOPE_DEV40_ID).freeze
  const devAnnotations = buildDev40Annotations(dev)
  const devCandidate = dev.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_SCOPE_CANDIDATE_ID),
  )
  const devControl = dev.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  const devJoined = joinCloseoutsWithPrivateAnnotations({
    freeze: dev,
    candidateCloseout: buildCloseout(dev, PROFILE_SCOPE_CANDIDATE_ID, devCandidate),
    controlCloseout: buildCloseout(dev, PROFILE_CONTROL_ID, devControl),
    annotations: devAnnotations,
    packedMasksBySha256: new Map(),
  })
  const devGate = evaluatePhaseGate(PHASE_SCOPE_DEV40_ID, devJoined)
  assert.equal('positiveDenominator' in devGate, true)
  if ('positiveDenominator' in devGate) assert.equal(devGate.positiveDenominator, 30)

  const qual = buildSyntheticPhaseFreeze(PHASE_SCOPE_QUAL120_ID).freeze
  const qualRows = qual.producerCases.map((row, index) => {
    const positive = index % 4 !== 3
    const stratum = qual.pairedSchedule[index]!.stratum
    return {
      opaqueCaseId: row.opaqueCaseId,
      stratum,
      sourceGroup: `scope-qual-group-${index}`,
      expectedPresence: positive ? ('present' as const) : ('absent' as const),
      independentMaskCase: index < 40 && positive,
      candidate: buildOutputRow(row.opaqueCaseId, PROFILE_SCOPE_CANDIDATE_ID),
      control: buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
      candidatePositiveSuccess: positive,
      controlPositiveSuccess: false,
      candidateNegativeFalse: false,
      controlNegativeFalse: false,
      maskIou: index < 40 && positive ? 1 : null,
      maskPredictionMissReason: null,
    }
  })
  const qualGate = evaluatePhaseGate(PHASE_SCOPE_QUAL120_ID, qualRows)
  assert.equal('independentMaskDenominator' in qualGate, true)
  if ('independentMaskDenominator' in qualGate) {
    assert.equal(qualGate.independentMaskDenominator, 30)
    assert.equal(qualGate.candidatePositiveSuccesses, 90)
  }
})

await test('authored-scope positive boxes require actual mask pixels for both paired profiles', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_SCOPE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const positives = annotations.cases.filter((item) => item.expectedPresence === 'present')
  const targetId = positives[0]!.opaqueCaseId
  const pixels = new Uint8Array(SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT)
  for (let y = 1; y < 5; y++) {
    for (let x = 1; x < 5; x++) pixels[y * SYNTHETIC_SOURCE_CANVAS_WIDTH + x] = 1
  }
  const packed = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    pixels,
  )
  const maskSha = sha256PackedBytes(packed)
  const outputRows = (
    profileId: typeof PROFILE_SCOPE_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    maskMode: 'valid' | 'maskless' | 'mismatch',
  ) =>
    freeze.producerCases.map((producer) => {
      const truth = annotations.cases.find((item) => item.opaqueCaseId === producer.opaqueCaseId)!
      if (truth.expectedPresence === 'absent')
        return buildOutputRow(producer.opaqueCaseId, profileId)
      const mask = maskMode !== 'maskless'
      return buildOutputRow(producer.opaqueCaseId, profileId, {
        caseState: 'success',
        box:
          maskMode === 'mismatch' && producer.opaqueCaseId === targetId
            ? { left: 0, top: 0, width: 5, height: 5 }
            : { left: 1, top: 1, width: 4, height: 4 },
        ...(mask ? { maskPackedSha256: maskSha } : {}),
      })
    })
  const join = (
    candidateMode: 'valid' | 'maskless' | 'mismatch',
    controlMode: 'valid' | 'maskless',
  ) =>
    joinCloseoutsWithPrivateAnnotations({
      freeze,
      candidateCloseout: buildCloseout(
        freeze,
        PROFILE_SCOPE_CANDIDATE_ID,
        outputRows(PROFILE_SCOPE_CANDIDATE_ID, candidateMode),
      ),
      controlCloseout: buildCloseout(
        freeze,
        PROFILE_CONTROL_ID,
        outputRows(PROFILE_CONTROL_ID, controlMode),
      ),
      annotations,
      packedMasksBySha256: new Map([[maskSha, packed]]),
    })

  const maskless = join('maskless', 'maskless')
  assert.equal(maskless.filter((item) => item.expectedPresence === 'present').length, 30)
  assert.equal(
    maskless.filter((item) => item.expectedPresence === 'present' && item.candidatePositiveSuccess)
      .length,
    0,
  )
  assert.equal(
    maskless.filter((item) => item.expectedPresence === 'present' && item.controlPositiveSuccess)
      .length,
    0,
  )

  const valid = join('valid', 'valid')
  assert.equal(
    valid.filter((item) => item.expectedPresence === 'present' && item.candidatePositiveSuccess)
      .length,
    30,
  )
  assert.equal(
    valid.filter((item) => item.expectedPresence === 'present' && item.controlPositiveSuccess)
      .length,
    30,
  )

  const mismatched = join('mismatch', 'valid').find((item) => item.opaqueCaseId === targetId)!
  assert.equal(mismatched.candidate.maskPackedSha256, maskSha)
  assert.equal(mismatched.candidatePositiveSuccess, false)
  assert.equal(mismatched.controlPositiveSuccess, true)

  const targetTruth = positives[0]!
  const validTarget = buildOutputRow(targetId, PROFILE_SCOPE_CANDIDATE_ID, {
    caseState: 'success',
    box: { left: 1, top: 1, width: 4, height: 4 },
    maskPackedSha256: maskSha,
  })
  assert.equal(
    scorePositiveOutputRow(
      validTarget,
      targetTruth.referenceBoxes,
      targetTruth,
      SYNTHETIC_SOURCE_CANVAS_WIDTH,
      SYNTHETIC_SOURCE_CANVAS_HEIGHT,
      new Map(),
      true,
    ),
    false,
  )
  const malformedPacked = new Uint8Array([0])
  const malformedSha = sha256PackedBytes(malformedPacked)
  assert.equal(
    scorePositiveOutputRow(
      { ...validTarget, maskPackedSha256: malformedSha },
      targetTruth.referenceBoxes,
      targetTruth,
      SYNTHETIC_SOURCE_CANVAS_WIDTH,
      SYNTHETIC_SOURCE_CANVAS_HEIGHT,
      new Map([[malformedSha, malformedPacked]]),
      true,
    ),
    false,
  )
  const emptyPixels = new Uint8Array(SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT)
  const emptyPacked = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    emptyPixels,
  )
  const emptySha = sha256PackedBytes(emptyPacked)
  assert.equal(
    scorePositiveOutputRow(
      { ...validTarget, maskPackedSha256: emptySha },
      targetTruth.referenceBoxes,
      targetTruth,
      SYNTHETIC_SOURCE_CANVAS_WIDTH,
      SYNTHETIC_SOURCE_CANVAS_HEIGHT,
      new Map([[emptySha, emptyPacked]]),
      true,
    ),
    false,
  )
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
