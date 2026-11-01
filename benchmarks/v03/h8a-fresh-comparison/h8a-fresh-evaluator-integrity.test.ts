import assert from 'node:assert/strict'
import test from 'node:test'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import {
  DEV40_POSITIVE_COUNT,
  PHASE_DEV40_ID,
  PHASE_QUAL120_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
} from './constants.js'
import {
  evaluateDev40Gate,
  evaluateQual120Gate,
  joinCloseoutsWithPrivateAnnotations,
  validateImmutableCloseouts,
  validateReceiptGraph,
} from './evaluator.js'
import {
  deriveInclusivePixelBox,
  packBinaryLsb0V1,
  sha256PackedBytes,
} from './packed-binary-lsb0.js'
import { phaseFreezeSchema } from './schemas.js'
import {
  buildCloseout,
  buildDev40Annotations,
  buildOutputRow,
  buildSyntheticAnnotationBundle,
  buildSyntheticPhaseFreeze,
  SYNTHETIC_SOURCE_CANVAS_HEIGHT,
  SYNTHETIC_SOURCE_CANVAS_WIDTH,
} from './test-fixtures.js'

await test('binary-lsb0-v1 packing enforces padding and map-key hash', () => {
  const width = 3
  const height = 3
  const pixels = new Uint8Array([1, 0, 1, 0, 1, 0, 0, 0, 0])
  const packed = packBinaryLsb0V1(width, height, pixels)
  assert.equal(packed.length, 2)
  assert.equal(packed[1]! & 0b11100000, 0)
  const key = sha256PackedBytes(packed)
  assert.equal(key.length, 64)
})

await test('mask-derived box mismatch rejects positive success while keeping denominator', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const positiveId = annotations.cases.find(
    (item) => item.expectedPresence === 'present',
  )!.opaqueCaseId
  const pixels = new Uint8Array(SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT)
  pixels[10] = 1
  pixels[11] = 1
  const packed = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    pixels,
  )
  const maskSha = sha256PackedBytes(packed)
  const derived = deriveInclusivePixelBox(
    pixels,
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
  )!
  const candidateRows = freeze.producerCases.map((row) => {
    if (row.opaqueCaseId !== positiveId) {
      return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
        caseState: 'success',
        box: { left: 1, top: 1, width: 4, height: 4 },
      })
    }
    return buildOutputRow(positiveId, PROFILE_CANDIDATE_ID, {
      caseState: 'success',
      box: { left: 0, top: 0, width: 99, height: 99 },
      maskPackedSha256: maskSha,
    })
  })
  const controlRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  const joined = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
    controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    annotations,
    packedMasksBySha256: new Map([[maskSha, packed]]),
  })
  const positiveRow = joined.find((item) => item.opaqueCaseId === positiveId)!
  assert.equal(positiveRow.candidatePositiveSuccess, false)
  assert.equal(derived.width > 0, true)
  const gate = evaluateDev40Gate(joined)
  assert.equal(gate.positiveDenominator, DEV40_POSITIVE_COUNT)
})

await test('missing predicted artifact scores zero IoU with reason and retains row', () => {
  const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(baseFreeze)
  const refPixels = new Uint8Array(SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT)
  refPixels[0] = 1
  const refPacked = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    refPixels,
  )
  const maskSha = sha256PackedBytes(refPacked)
  const targetCase = annotations.cases.find((item) => item.expectedPresence === 'present')!
  const annotationsWithMask = {
    ...annotations,
    cases: annotations.cases.map((item) =>
      item.opaqueCaseId === targetCase.opaqueCaseId
        ? {
            ...item,
            exactOriginalCanvasMaskRef: true,
            referenceMasks: [
              {
                width: SYNTHETIC_SOURCE_CANVAS_WIDTH,
                height: SYNTHETIC_SOURCE_CANVAS_HEIGHT,
                packedBinarySha256: maskSha,
              },
            ],
          }
        : item,
    ),
  }
  const freeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotationsWithMask),
  })
  const rows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
      caseState: 'success',
      box: { left: 0, top: 0, width: 1, height: 1 },
    }),
  )
  const joined = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, rows),
    controlCloseout: buildCloseout(
      freeze,
      PROFILE_CONTROL_ID,
      rows.map((row) => ({ ...row, profileId: PROFILE_CONTROL_ID })),
    ),
    annotations: annotationsWithMask,
    packedMasksBySha256: new Map([[maskSha, refPacked]]),
  })
  const scored = joined.find((item) => item.opaqueCaseId === targetCase.opaqueCaseId)!
  assert.equal(scored.maskIou, 0)
  assert.equal(scored.maskPredictionMissReason, 'prediction_mask_missing_sha256')
  assert.equal(joined.length, freeze.producerCases.length)
})

await test('prediction mask bytes must match the digest and frozen source canvas', () => {
  const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotationsBase = buildDev40Annotations(baseFreeze)
  const targetId = annotationsBase.cases.find(
    (item) => item.expectedPresence === 'present',
  )!.opaqueCaseId
  const referencePixels = new Uint8Array(
    SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT,
  )
  referencePixels[0] = 1
  const referencePacked = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    referencePixels,
  )
  const referenceSha = sha256PackedBytes(referencePacked)
  const annotations = {
    ...annotationsBase,
    cases: annotationsBase.cases.map((item) =>
      item.opaqueCaseId === targetId
        ? {
            ...item,
            exactOriginalCanvasMaskRef: true,
            referenceMasks: [
              {
                width: SYNTHETIC_SOURCE_CANVAS_WIDTH,
                height: SYNTHETIC_SOURCE_CANVAS_HEIGHT,
                packedBinarySha256: referenceSha,
              },
            ],
          }
        : item,
    ),
  }
  const freeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  })
  const shortPacked = new Uint8Array([1])
  const shortSha = sha256PackedBytes(shortPacked)
  const candidateRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
      caseState: 'success',
      box: { left: 0, top: 0, width: 1, height: 1 },
      ...(row.opaqueCaseId === targetId ? { maskPackedSha256: shortSha } : {}),
    }),
  )
  const controlRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  const joined = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
    controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    annotations,
    packedMasksBySha256: new Map([
      [referenceSha, referencePacked],
      [shortSha, shortPacked],
    ]),
  })
  const row = joined.find((item) => item.opaqueCaseId === targetId)!
  assert.equal(row.maskIou, 0)
  assert.equal(row.maskPredictionMissReason, 'prediction_mask_geometry_mismatch')
  assert.equal(row.candidatePositiveSuccess, false)

  const sameGeometryWrongBytes = new Uint8Array([2])
  const hashMismatchJoin = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
    controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    annotations,
    packedMasksBySha256: new Map([
      [referenceSha, referencePacked],
      [shortSha, sameGeometryWrongBytes],
    ]),
  })
  const hashMismatchRow = hashMismatchJoin.find((item) => item.opaqueCaseId === targetId)!
  assert.equal(hashMismatchRow.maskIou, 0)
  assert.equal(hashMismatchRow.maskPredictionMissReason, 'prediction_mask_hash_mismatch')

  const badReferenceAnnotations = {
    ...annotations,
    cases: annotations.cases.map((item) =>
      item.opaqueCaseId === targetId
        ? {
            ...item,
            referenceMasks: item.referenceMasks.map((ref) => ({ ...ref, width: ref.width - 1 })),
          }
        : item,
    ),
  }
  const badReferenceFreeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(badReferenceAnnotations),
  })
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze: badReferenceFreeze,
      candidateCloseout: buildCloseout(badReferenceFreeze, PROFILE_CANDIDATE_ID, candidateRows),
      controlCloseout: buildCloseout(badReferenceFreeze, PROFILE_CONTROL_ID, controlRows),
      annotations: badReferenceAnnotations,
      packedMasksBySha256: new Map([[referenceSha, referencePacked]]),
    }),
  )
})

await test('bad positive reference geometry or empty truth mask fails before prediction scoring', () => {
  const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const baseAnnotations = buildDev40Annotations(baseFreeze)
  const targetId = baseAnnotations.cases.find(
    (item) => item.expectedPresence === 'present',
  )!.opaqueCaseId
  const rows = baseFreeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  const controlRows = baseFreeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )

  const invalidBoxAnnotations = {
    ...baseAnnotations,
    cases: baseAnnotations.cases.map((item) =>
      item.opaqueCaseId === targetId
        ? { ...item, referenceBoxes: [{ left: -1, top: 0, width: 1, height: 1 }] }
        : item,
    ),
  }
  const invalidBoxFreeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(invalidBoxAnnotations),
  })
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze: invalidBoxFreeze,
      candidateCloseout: buildCloseout(invalidBoxFreeze, PROFILE_CANDIDATE_ID, rows),
      controlCloseout: buildCloseout(invalidBoxFreeze, PROFILE_CONTROL_ID, controlRows),
      annotations: invalidBoxAnnotations,
      packedMasksBySha256: new Map(),
    }),
  )

  const emptyPixels = new Uint8Array(SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT)
  const emptyPacked = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    emptyPixels,
  )
  const emptySha = sha256PackedBytes(emptyPacked)
  const emptyMaskAnnotations = {
    ...baseAnnotations,
    cases: baseAnnotations.cases.map((item) =>
      item.opaqueCaseId === targetId
        ? {
            ...item,
            exactOriginalCanvasMaskRef: true,
            referenceMasks: [
              {
                width: SYNTHETIC_SOURCE_CANVAS_WIDTH,
                height: SYNTHETIC_SOURCE_CANVAS_HEIGHT,
                packedBinarySha256: emptySha,
              },
            ],
          }
        : item,
    ),
  }
  const emptyMaskFreeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(emptyMaskAnnotations),
  })
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze: emptyMaskFreeze,
      candidateCloseout: buildCloseout(emptyMaskFreeze, PROFILE_CANDIDATE_ID, rows),
      controlCloseout: buildCloseout(emptyMaskFreeze, PROFILE_CONTROL_ID, controlRows),
      annotations: emptyMaskAnnotations,
      packedMasksBySha256: new Map([[emptySha, emptyPacked]]),
    }),
  )
})

await test('non-success rows and mask-box mismatch remain zero-score prediction misses', () => {
  const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const baseAnnotations = buildDev40Annotations(baseFreeze)
  const targetId = baseAnnotations.cases.find(
    (item) => item.expectedPresence === 'present',
  )!.opaqueCaseId
  const pixels = new Uint8Array(SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT)
  pixels[0] = 1
  const packed = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    pixels,
  )
  const maskSha = sha256PackedBytes(packed)
  const annotations = {
    ...baseAnnotations,
    cases: baseAnnotations.cases.map((item) =>
      item.opaqueCaseId === targetId
        ? {
            ...item,
            exactOriginalCanvasMaskRef: true,
            referenceMasks: [
              {
                width: SYNTHETIC_SOURCE_CANVAS_WIDTH,
                height: SYNTHETIC_SOURCE_CANVAS_HEIGHT,
                packedBinarySha256: maskSha,
              },
            ],
            referenceBoxes: [{ left: 0, top: 0, width: 1, height: 1 }],
          }
        : item,
    ),
  }
  const freeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  })
  const candidateRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
      caseState: row.opaqueCaseId === targetId ? 'error' : 'not_found',
      box: row.opaqueCaseId === targetId ? { left: 0, top: 0, width: 1, height: 1 } : null,
      maskPackedSha256: row.opaqueCaseId === targetId ? maskSha : null,
    }),
  )
  const controlRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  const input = {
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
    controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    annotations,
    packedMasksBySha256: new Map([[maskSha, packed]]),
  }
  const nonSuccess = joinCloseoutsWithPrivateAnnotations(input).find(
    (item) => item.opaqueCaseId === targetId,
  )!
  assert.equal(nonSuccess.maskIou, 0)
  assert.equal(nonSuccess.maskPredictionMissReason, 'prediction_not_success')

  const malformedCandidateRows = candidateRows.map((row) =>
    row.opaqueCaseId === targetId
      ? { ...row, caseState: 'success' as const, box: { left: 1, top: 0, width: 1, height: 1 } }
      : row,
  )
  const malformed = joinCloseoutsWithPrivateAnnotations({
    ...input,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, malformedCandidateRows),
  }).find((item) => item.opaqueCaseId === targetId)!
  assert.equal(malformed.maskIou, 0)
  assert.equal(malformed.maskPredictionMissReason, 'prediction_mask_box_mismatch')
  assert.equal(malformed.candidatePositiveSuccess, false)
})

await test('invalid no-mask UI boxes become misses without aborting the phase report', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const targetId = annotations.cases.find(
    (item) => item.stratum === 'ui' && item.expectedPresence === 'present',
  )!.opaqueCaseId
  const candidateRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
      caseState: 'success',
      box: { left: -1, top: 0, width: 1, height: 1 },
    }),
  )
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
  assert.equal(joined.length, freeze.producerCases.length)
  assert.equal(
    joined.find((item) => item.opaqueCaseId === targetId)?.candidatePositiveSuccess,
    false,
  )
})

await test('changed annotations under same freeze commitment are rejected', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const tampered = {
    ...annotations,
    cases: annotations.cases.map((item, index) =>
      index === 0
        ? {
            ...item,
            referenceBoxes: [{ left: 9, top: 9, width: 1, height: 1 }],
          }
        : item,
    ),
  }
  const rows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze,
      candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, rows),
      controlCloseout: buildCloseout(
        freeze,
        PROFILE_CONTROL_ID,
        rows.map((row) => ({ ...row, profileId: PROFILE_CONTROL_ID })),
      ),
      annotations: tampered,
      packedMasksBySha256: new Map(),
    }),
  )
})

await test('changing truth and annotation digest cannot reuse the original frozen closeouts', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const tampered = {
    ...annotations,
    cases: annotations.cases.map((item, index) =>
      index === 0 ? { ...item, referenceBoxes: [{ left: 7, top: 7, width: 1, height: 1 }] } : item,
    ),
  }
  const changedFreeze = phaseFreezeSchema.parse({
    ...freeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(tampered),
  })
  const candidateRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  const controlRows = freeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze: changedFreeze,
      candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
      controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
      annotations: tampered,
      packedMasksBySha256: new Map(),
    }),
  )
})

await test('frozen source strata and source-group commitments reject changed private labels', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const tampered = {
    ...annotations,
    cases: annotations.cases.map((item, index) =>
      index === 0 ? { ...item, sourceGroup: `${item.sourceGroup}-changed` } : item,
    ),
  }
  const changedFreeze = phaseFreezeSchema.parse({
    ...freeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(tampered),
  })
  const candidateRows = changedFreeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  const controlRows = changedFreeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze: changedFreeze,
      candidateCloseout: buildCloseout(changedFreeze, PROFILE_CANDIDATE_ID, candidateRows),
      controlCloseout: buildCloseout(changedFreeze, PROFILE_CONTROL_ID, controlRows),
      annotations: tampered,
      packedMasksBySha256: new Map(),
    }),
  )
})

await test('qualification freezes and annotations share exactly 30 photo-positive mask IDs', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  const annotations = buildSyntheticAnnotationBundle(
    PHASE_QUAL120_ID,
    freeze.freezeId,
    freeze.producerCases,
    freeze.pairedSchedule,
  )
  assert.equal(freeze.qualificationIndependentMaskCaseIds.length, 30)
  assert.deepEqual(annotations.independentMaskCaseIds, freeze.qualificationIndependentMaskCaseIds)
  assert.ok(
    freeze.qualificationIndependentMaskCaseIds.every((id) => {
      const annotation = annotations.cases.find((item) => item.opaqueCaseId === id)
      return annotation?.stratum === 'photo' && annotation.expectedPresence === 'present'
    }),
  )
})

await test('qualification annotation cannot substitute mask IDs under the same freeze ID', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  const annotations = buildSyntheticAnnotationBundle(
    PHASE_QUAL120_ID,
    freeze.freezeId,
    freeze.producerCases,
    freeze.pairedSchedule,
  )
  const uiId = freeze.pairedSchedule.find((item) => item.stratum === 'ui')!.opaqueCaseId
  const tamperedAnnotations = {
    ...annotations,
    independentMaskCaseIds: [uiId, ...annotations.independentMaskCaseIds.slice(1)],
  }
  const changedFreeze = phaseFreezeSchema.parse({
    ...freeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(tamperedAnnotations),
  })
  const candidateRows = changedFreeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID),
  )
  const controlRows = changedFreeze.producerCases.map((row) =>
    buildOutputRow(row.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  assert.throws(() =>
    joinCloseoutsWithPrivateAnnotations({
      freeze: changedFreeze,
      candidateCloseout: buildCloseout(changedFreeze, PROFILE_CANDIDATE_ID, candidateRows),
      controlCloseout: buildCloseout(changedFreeze, PROFILE_CONTROL_ID, controlRows),
      annotations: tamperedAnnotations,
      packedMasksBySha256: new Map(),
    }),
  )
})

await test('qualification mask gate uses exactly the frozen photo-positive selection', () => {
  const { freeze: baseFreeze } = buildSyntheticPhaseFreeze(PHASE_QUAL120_ID)
  const annotationsBase = buildSyntheticAnnotationBundle(
    PHASE_QUAL120_ID,
    baseFreeze.freezeId,
    baseFreeze.producerCases,
    baseFreeze.pairedSchedule,
  )
  const pixels = new Uint8Array(SYNTHETIC_SOURCE_CANVAS_WIDTH * SYNTHETIC_SOURCE_CANVAS_HEIGHT)
  pixels[0] = 1
  const packed = packBinaryLsb0V1(
    SYNTHETIC_SOURCE_CANVAS_WIDTH,
    SYNTHETIC_SOURCE_CANVAS_HEIGHT,
    pixels,
  )
  const maskSha = sha256PackedBytes(packed)
  const annotations = {
    ...annotationsBase,
    cases: annotationsBase.cases.map((item) =>
      item.exactOriginalCanvasMaskRef
        ? {
            ...item,
            referenceBoxes: [{ left: 0, top: 0, width: 1, height: 1 }],
            referenceMasks: [
              {
                width: SYNTHETIC_SOURCE_CANVAS_WIDTH,
                height: SYNTHETIC_SOURCE_CANVAS_HEIGHT,
                packedBinarySha256: maskSha,
              },
            ],
          }
        : item,
    ),
  }
  const freeze = phaseFreezeSchema.parse({
    ...baseFreeze,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  })
  const independentIds = new Set(freeze.qualificationIndependentMaskCaseIds)
  const candidateRows = freeze.producerCases.map((producer) => {
    if (independentIds.has(producer.opaqueCaseId))
      return buildOutputRow(producer.opaqueCaseId, PROFILE_CANDIDATE_ID, {
        caseState: 'success',
        box: { left: 0, top: 0, width: 1, height: 1 },
        maskPackedSha256: maskSha,
      })
    const truth = annotations.cases.find((item) => item.opaqueCaseId === producer.opaqueCaseId)!
    return truth.expectedPresence === 'present'
      ? buildOutputRow(producer.opaqueCaseId, PROFILE_CANDIDATE_ID, {
          caseState: 'success',
          box: { left: 1, top: 1, width: 4, height: 4 },
        })
      : buildOutputRow(producer.opaqueCaseId, PROFILE_CANDIDATE_ID)
  })
  const controlRows = freeze.producerCases.map((producer) =>
    buildOutputRow(producer.opaqueCaseId, PROFILE_CONTROL_ID),
  )
  const joined = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
    controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    annotations,
    packedMasksBySha256: new Map([[maskSha, packed]]),
  })
  const gate = evaluateQual120Gate(joined)
  assert.equal(gate.independentMaskDenominator, 30)
  assert.equal(gate.independentMaskPassCount, 30)
  assert.equal(gate.qualityPass, true)
})

await test('uncertain receipt keeps stable receiptId with null observed physicalId', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const row = buildOutputRow(freeze.producerCases[0]!.opaqueCaseId, PROFILE_CANDIDATE_ID, {
    physicalReceiptIds: [42],
  })
  const closeout = buildCloseout(freeze, PROFILE_CANDIDATE_ID, [row])
  const uncertain = {
    ...closeout,
    physicalReceipts: [
      {
        receiptId: 42,
        physicalId: null,
        logicalId: 1,
        dispatchState: 'uncertain' as const,
        settled: false,
        costUsd: null,
        chargeState: 'unknown' as const,
      },
    ],
    physicalDispatchCount: 0,
    uncertainDispatchCount: 1,
  }
  assert.doesNotThrow(() => validateReceiptGraph(uncertain))
  assert.equal(uncertain.physicalReceipts[0]?.physicalId, null)
})

await test('receipt graph rejects duplicate row references and logical total mismatch', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const caseId = freeze.producerCases[0]!.opaqueCaseId
  const logical = buildCloseout(freeze, PROFILE_CANDIDATE_ID, [
    buildOutputRow(caseId, PROFILE_CANDIDATE_ID),
  ])
  assert.throws(() =>
    validateReceiptGraph({
      ...logical,
      outputRows: [{ ...logical.outputRows[0]!, logicalReceiptIds: [1, 1] }],
    }),
  )
  assert.throws(() =>
    validateReceiptGraph({ ...logical, logicalAttemptCount: logical.logicalAttemptCount + 1 }),
  )

  const withPhysical = buildCloseout(freeze, PROFILE_CANDIDATE_ID, [
    buildOutputRow(caseId, PROFILE_CANDIDATE_ID, { physicalReceiptIds: [42] }),
  ])
  assert.throws(() =>
    validateReceiptGraph({
      ...withPhysical,
      outputRows: [{ ...withPhysical.outputRows[0]!, physicalReceiptIds: [42, 42] }],
    }),
  )
  assert.throws(() =>
    validateReceiptGraph({
      ...withPhysical,
      logicalReceipts: [{ ...withPhysical.logicalReceipts[0]!, physicalIds: [42, 42] }],
    }),
  )
})

await test('paired receipt graph rejects duplicate observed physical IDs across recipes', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const candidateRows = freeze.producerCases.map((item, index) =>
    buildOutputRow(
      item.opaqueCaseId,
      PROFILE_CANDIDATE_ID,
      index === 0 ? { physicalReceiptIds: [42] } : undefined,
    ),
  )
  const controlRows = freeze.producerCases.map((item, index) =>
    buildOutputRow(
      item.opaqueCaseId,
      PROFILE_CONTROL_ID,
      index === 0 ? { physicalReceiptIds: [42] } : undefined,
    ),
  )
  assert.throws(
    () =>
      validateImmutableCloseouts({
        freeze,
        candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
        controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
      }),
    /duplicate observed physical IDs/u,
  )
})

await test('DEV gate does not require all positive successes', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const positiveIds = annotations.cases
    .filter((item) => item.expectedPresence === 'present')
    .map((item) => item.opaqueCaseId)
  const candidateRows = freeze.producerCases.map((row) => {
    if (row.opaqueCaseId === positiveIds[0]) {
      return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
        caseState: 'unknown',
        box: null,
      })
    }
    if (row.opaqueCaseId === positiveIds[1])
      return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, { caseState: 'not_found' })
    if (!positiveIds.includes(row.opaqueCaseId))
      return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID)
    return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
      caseState: 'success',
      box: { left: 1, top: 1, width: 4, height: 4 },
    })
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
  assert.equal(gate.positiveDenominator, DEV40_POSITIVE_COUNT)
  assert.equal(gate.positiveSuccesses, DEV40_POSITIVE_COUNT - 2)
  assert.equal(gate.executionValid, true)
  assert.equal(gate.pairedCoverageComplete, true)
  assert.equal(gate.qualityPass, true)
})

await test('DEV40 gate blocks an incomplete paired run without claiming unobserved negative coverage', () => {
  const { freeze } = buildSyntheticPhaseFreeze(PHASE_DEV40_ID)
  const annotations = buildDev40Annotations(freeze)
  const positiveIds = annotations.cases
    .filter((item) => item.expectedPresence === 'present')
    .map((item) => item.opaqueCaseId)
  const successId = positiveIds[0]!
  const errorId = positiveIds[1]!
  const candidateRows = freeze.producerCases.map((row) => {
    if (row.opaqueCaseId === successId)
      return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, {
        caseState: 'success',
        box: { left: 1, top: 1, width: 1, height: 1 },
      })
    if (row.opaqueCaseId === errorId)
      return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, { caseState: 'error' })
    return buildOutputRow(row.opaqueCaseId, PROFILE_CANDIDATE_ID, { caseState: 'unstarted' })
  })
  const controlRows = freeze.producerCases.map((row) =>
    buildOutputRow(
      row.opaqueCaseId,
      PROFILE_CONTROL_ID,
      row.opaqueCaseId === successId ? { caseState: 'unknown' } : { caseState: 'unstarted' },
    ),
  )
  const joined = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: buildCloseout(freeze, PROFILE_CANDIDATE_ID, candidateRows),
    controlCloseout: buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    annotations,
    packedMasksBySha256: new Map(),
  })
  const gate = evaluateDev40Gate(joined)
  assert.equal(candidateRows.filter((row) => row.caseState === 'unstarted').length, 38)
  assert.equal(candidateRows.filter((row) => row.caseState === 'success').length, 1)
  assert.equal(candidateRows.filter((row) => row.caseState === 'error').length, 1)
  assert.equal(controlRows.filter((row) => row.caseState === 'unstarted').length, 39)
  assert.equal(controlRows.filter((row) => row.caseState === 'unknown').length, 1)
  assert.equal(gate.executionValid, true)
  assert.equal(gate.pairedCoverageComplete, false)
  assert.equal(gate.qualityPass, false)
  assert.equal(gate.observedNegativeDenominator, 0)
  assert.equal(gate.falseNegativeOutputs, 0)
  assert.equal(
    Object.values(gate.byStratum).reduce((sum, item) => sum + item.observedNegatives, 0),
    0,
  )
  assert.throws(() => evaluateDev40Gate(joined.slice(0, -1)), /all 40 frozen cases/u)
})
