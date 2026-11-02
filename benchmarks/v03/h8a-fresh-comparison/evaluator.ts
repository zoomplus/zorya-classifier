import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { assertNoForbiddenEvaluatorFields } from './forbidden-leakage.js'
import { hashIdentity } from './hash-identity.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import {
  DEV40_NEGATIVE_COUNT,
  DEV40_CASE_COUNT,
  DEV40_POSITIVE_COUNT,
  DEV40_STRATUM_QUOTAS,
  isDevPhase,
  PHASE_SCOPE_DEV40_ID,
  PHASE_SCOPE_QUAL120_ID,
  PHASE_NATIVE_PRESENCE_DEV40_ID,
  PHASE_NATIVE_PRESENCE_QUAL120_ID,
  PHASE_NATIVE_SELECTOR_DEV40_ID,
  PHASE_NATIVE_SELECTOR_QUAL120_ID,
  PROFILE_CANDIDATE_ID,
  candidateIdForPhase,
  PROFILE_CONTROL_ID,
  QUAL120_CASE_COUNT,
  QUAL120_NEGATIVE_COUNT,
  QUAL120_POSITIVE_COUNT,
  QUAL120_STRATUM_COUNT,
  STRATUMS,
} from './constants.js'
import type { H8aFreshPhaseId, H8aFreshCandidateId } from './constants.js'
import { clusteredSourceGroupBootstrap } from './clustered-bootstrap.js'
import {
  boxIoUAndReferenceCoverage,
  binaryMaskIoU,
  missingPredictionMaskIoU,
  type BoxRect,
} from './geometry-metrics.js'
import {
  assertArtifactMapKeyMatchesBytes,
  boxesExactlyEqual,
  countForegroundPixels,
  deriveInclusivePixelBox,
  unpackBinaryLsb0V1,
} from './packed-binary-lsb0.js'
import type {
  EvaluatorPrivateAnnotationBundle,
  ImmutableCloseout,
  OutputRow,
  PhaseFreeze,
} from './schemas.js'
import { assertProviderRefusalReplayEvidence } from './provider-refusal-replay.js'
import {
  evaluatorPrivateAnnotationBundleSchema,
  immutableCloseoutSchema,
  outputRowSchema,
  phaseFreezeSchema,
} from './schemas.js'

type MaskPredictionMissReason =
  | 'prediction_execution_invalid'
  | 'prediction_not_success'
  | 'prediction_box_missing'
  | 'prediction_mask_bytes_absent'
  | 'prediction_mask_hash_mismatch'
  | 'prediction_mask_geometry_mismatch'
  | 'prediction_mask_invalid_packing'
  | 'prediction_mask_zero_foreground'
  | 'prediction_mask_box_mismatch'
  | 'prediction_mask_missing_sha256'

interface ReceiptValidationContext {
  freeze: PhaseFreeze
  candidateCloseout: ImmutableCloseout
  controlCloseout: ImmutableCloseout
}

function assertCloseoutIntegrity(closeout: ImmutableCloseout): void {
  immutableCloseoutSchema.parse(closeout)
  for (const row of closeout.outputRows) {
    assertNoForbiddenEvaluatorFields(row, 'Closeout output row')
    outputRowSchema.parse(row)
  }
  const recomputed = hashIdentity({
    freezeId: closeout.freezeId,
    freezeCommitmentSha256: closeout.freezeCommitmentSha256,
    phaseId: closeout.phaseId,
    profileId: closeout.profileId,
    closedAtIso: closeout.closedAtIso,
    cohortCommitmentSha256: closeout.cohortCommitmentSha256,
    producerClosureSha256: closeout.producerClosureSha256,
    recipeIdentitySha256: closeout.recipeIdentitySha256,
    requestPolicyIdentitySha256: closeout.requestPolicyIdentitySha256,
    outputRows: closeout.outputRows,
    logicalReceipts: closeout.logicalReceipts,
    physicalReceipts: closeout.physicalReceipts,
    logicalAttemptCount: closeout.logicalAttemptCount,
    physicalDispatchCount: closeout.physicalDispatchCount,
    uncertainDispatchCount: closeout.uncertainDispatchCount,
  })
  if (recomputed !== closeout.closeoutSha256)
    throw new RangeError('Closeout integrity hash mismatch')
}

function assertCloseoutMatchesFreeze(freeze: PhaseFreeze, closeout: ImmutableCloseout): void {
  phaseFreezeSchema.parse(freeze)
  if (closeout.freezeId !== freeze.freezeId) throw new RangeError('Closeout freezeId mismatch')
  if (closeout.freezeCommitmentSha256 !== computePhaseFreezeCommitmentSha256(freeze))
    throw new RangeError('Closeout freeze commitment mismatch')
  if (closeout.phaseId !== freeze.phaseId) throw new RangeError('Closeout phaseId mismatch')
  if (closeout.cohortCommitmentSha256 !== freeze.cohortCommitmentSha256)
    throw new RangeError('Closeout cohort commitment mismatch')
  if (closeout.producerClosureSha256 !== freeze.producerClosureSha256)
    throw new RangeError('Closeout producer closure mismatch')
  const binding = freeze.profileBindings.find((item) => item.profileId === closeout.profileId)
  if (!binding) throw new RangeError('Closeout profile binding missing from freeze')
  if (closeout.recipeIdentitySha256 !== binding.recipeIdentitySha256)
    throw new RangeError('Closeout recipe identity mismatch')
  if (closeout.requestPolicyIdentitySha256 !== binding.requestPolicyIdentitySha256)
    throw new RangeError('Closeout request policy identity mismatch')
  if (closeout.outputRows.length !== freeze.producerCases.length)
    throw new RangeError('Closeout row count mismatch with freeze producerCases')
  for (let index = 0; index < freeze.producerCases.length; index++) {
    const expectedId = freeze.producerCases[index]!.opaqueCaseId
    if (closeout.outputRows[index]?.opaqueCaseId !== expectedId)
      throw new RangeError('Closeout output row order mismatch with freeze')
  }
}

export function validateImmutableCloseouts(context: ReceiptValidationContext): void {
  assertCloseoutIntegrity(context.candidateCloseout)
  assertCloseoutIntegrity(context.controlCloseout)
  assertCloseoutMatchesFreeze(context.freeze, context.candidateCloseout)
  assertCloseoutMatchesFreeze(context.freeze, context.controlCloseout)
  if (context.candidateCloseout.freezeId !== context.controlCloseout.freezeId)
    throw new RangeError('Paired closeouts must share freezeId')
  if (context.candidateCloseout.phaseId !== context.controlCloseout.phaseId)
    throw new RangeError('Paired closeouts must share phaseId')
  if (
    context.candidateCloseout.cohortCommitmentSha256 !==
    context.controlCloseout.cohortCommitmentSha256
  )
    throw new RangeError('Paired closeouts must share cohort commitment')
  if (context.candidateCloseout.profileId !== candidateIdForPhase(context.freeze.phaseId))
    throw new RangeError('Candidate closeout profile mismatch')
  if (context.controlCloseout.profileId !== PROFILE_CONTROL_ID)
    throw new RangeError('Control closeout profile mismatch')

  const candidateIds = context.candidateCloseout.outputRows.map((item) => item.opaqueCaseId)
  const controlIds = context.controlCloseout.outputRows.map((item) => item.opaqueCaseId)
  if (candidateIds.length !== controlIds.length)
    throw new RangeError('Paired closeouts must contain the same case count')
  if (new Set(candidateIds).size !== candidateIds.length)
    throw new RangeError('Duplicate candidate case IDs in closeout')
  if (new Set(controlIds).size !== controlIds.length)
    throw new RangeError('Duplicate control case IDs in closeout')
  for (let index = 0; index < candidateIds.length; index++) {
    if (candidateIds[index] !== controlIds[index])
      throw new RangeError('Candidate/control case order mismatch')
  }

  validateReceiptGraph(context.candidateCloseout)
  validateReceiptGraph(context.controlCloseout)
  for (const closeout of [context.candidateCloseout, context.controlCloseout]) {
    for (const output of closeout.outputRows) {
      if (!output.providerRefusalEvidence) continue
      if (!context.freeze.executionPolicy)
        throw new RangeError('Refusal evidence is not declared by the immutable execution policy')
      assertProviderRefusalReplayEvidence({
        evidence: output.providerRefusalEvidence,
        executionPolicy: context.freeze.executionPolicy,
        opaqueCaseId: output.opaqueCaseId,
        profileId: output.profileId,
        output,
        logicalReceipts: closeout.logicalReceipts,
        physicalReceipts: closeout.physicalReceipts,
      })
    }
  }

  const observedPhysicalIds = [
    ...context.candidateCloseout.physicalReceipts,
    ...context.controlCloseout.physicalReceipts,
  ]
    .filter((receipt) => receipt.dispatchState === 'confirmed')
    .map((receipt) => receipt.physicalId)
  if (observedPhysicalIds.length !== new Set(observedPhysicalIds).size)
    throw new RangeError('Paired closeouts contain duplicate observed physical IDs')
}

function countReceiptsByDispatchState(closeout: ImmutableCloseout): {
  confirmed: number
  uncertain: number
} {
  let confirmed = 0
  let uncertain = 0
  for (const receipt of closeout.physicalReceipts) {
    if (receipt.dispatchState === 'confirmed') confirmed++
    else if (receipt.dispatchState === 'uncertain') uncertain++
  }
  return { confirmed, uncertain }
}

export function validateReceiptGraph(closeout: ImmutableCloseout): void {
  if (
    closeout.logicalReceipts.length !==
    new Set(closeout.logicalReceipts.map((item) => item.logicalId)).size
  )
    throw new RangeError('Duplicate logical receipt IDs')
  if (
    closeout.physicalReceipts.length !==
    new Set(closeout.physicalReceipts.map((item) => item.receiptId)).size
  )
    throw new RangeError('Duplicate physical receipt IDs')

  const logicalById = new Map(closeout.logicalReceipts.map((item) => [item.logicalId, item]))
  const physicalByReceiptId = new Map(
    closeout.physicalReceipts.map((item) => [item.receiptId, item]),
  )

  const referencedLogical = new Set<number>()
  const referencedPhysical = new Set<number>()
  const logicalRowReferenceCount = new Map<number, number>()
  const physicalRowReferenceCount = new Map<number, number>()
  const physicalLogicalReferenceCount = new Map<number, number>()

  if (closeout.logicalAttemptCount !== closeout.logicalReceipts.length)
    throw new RangeError('Closeout logical attempt count mismatch')

  for (const row of closeout.outputRows) {
    if (row.profileId !== closeout.profileId) throw new RangeError('Output row profile mismatch')
    if (row.logicalReceiptIds.length !== new Set(row.logicalReceiptIds).size)
      throw new RangeError('Output row contains duplicate logical receipt references')
    if (row.physicalReceiptIds.length !== new Set(row.physicalReceiptIds).size)
      throw new RangeError('Output row contains duplicate physical receipt references')
    for (const logicalId of row.logicalReceiptIds) {
      referencedLogical.add(logicalId)
      logicalRowReferenceCount.set(logicalId, (logicalRowReferenceCount.get(logicalId) ?? 0) + 1)
      const logical = logicalById.get(logicalId)
      if (!logical) throw new RangeError('Output row references missing logical receipt')
      if (logical.opaqueCaseId !== row.opaqueCaseId)
        throw new RangeError('Logical receipt case mismatch')
      if (logical.profileId !== row.profileId)
        throw new RangeError('Logical receipt profile mismatch')
    }
    for (const receiptId of row.physicalReceiptIds) {
      referencedPhysical.add(receiptId)
      physicalRowReferenceCount.set(receiptId, (physicalRowReferenceCount.get(receiptId) ?? 0) + 1)
      const physical = physicalByReceiptId.get(receiptId)
      if (!physical) throw new RangeError('Output row references missing physical receipt')
      if (physical.dispatchState === 'prefetch_cancelled')
        throw new RangeError('Output row references prefetch-cancelled receipt')
      const linkedLogical = logicalById.get(physical.logicalId)
      if (!linkedLogical) throw new RangeError('Physical receipt missing logical link')
      if (linkedLogical.opaqueCaseId !== row.opaqueCaseId)
        throw new RangeError('Physical receipt case mismatch')
      if (!row.logicalReceiptIds.includes(physical.logicalId))
        throw new RangeError('Physical receipt not linked through row logical receipt')
    }
  }

  for (const logical of closeout.logicalReceipts) {
    if (logical.profileId !== closeout.profileId)
      throw new RangeError('Logical receipt profile mismatch')
    if (logical.physicalIds.length !== new Set(logical.physicalIds).size)
      throw new RangeError('Logical receipt contains duplicate physical references')
    for (const receiptId of logical.physicalIds) {
      referencedPhysical.add(receiptId)
      physicalLogicalReferenceCount.set(
        receiptId,
        (physicalLogicalReferenceCount.get(receiptId) ?? 0) + 1,
      )
      const physical = physicalByReceiptId.get(receiptId)
      if (!physical) throw new RangeError('Logical receipt references missing physical receipt')
      if (physical.logicalId !== logical.logicalId)
        throw new RangeError('Physical/logical receipt linkage mismatch')
    }
  }

  if (referencedLogical.size !== closeout.logicalReceipts.length)
    throw new RangeError('Unused or orphan logical receipts')
  for (const logical of closeout.logicalReceipts) {
    if (logicalRowReferenceCount.get(logical.logicalId) !== 1)
      throw new RangeError('Logical receipt must be referenced by exactly one output row')
  }
  if (referencedPhysical.size !== closeout.physicalReceipts.length)
    throw new RangeError('Unused or orphan physical receipts')

  for (const receipt of closeout.physicalReceipts) {
    if (physicalLogicalReferenceCount.get(receipt.receiptId) !== 1)
      throw new RangeError('Physical receipt must be referenced by exactly one logical receipt')
    const expectedRowReferenceCount = receipt.dispatchState === 'prefetch_cancelled' ? 0 : 1
    if ((physicalRowReferenceCount.get(receipt.receiptId) ?? 0) !== expectedRowReferenceCount)
      throw new RangeError('Physical receipt output-row reference count mismatch')
    if (receipt.dispatchState === 'uncertain' && receipt.physicalId !== null)
      throw new RangeError('Uncertain receipt must have null observed physicalId')
    if (receipt.dispatchState === 'confirmed' && receipt.physicalId === null)
      throw new RangeError('Confirmed receipt requires observed physicalId')
  }

  const { confirmed, uncertain } = countReceiptsByDispatchState(closeout)
  if (closeout.physicalDispatchCount !== confirmed)
    throw new RangeError('Closeout confirmed physical dispatch count mismatch')
  if (closeout.uncertainDispatchCount !== uncertain)
    throw new RangeError('Closeout uncertain dispatch count mismatch')
  const rowPhysicalReferenceCountTotal = [...physicalRowReferenceCount.values()].reduce(
    (sum, count) => sum + count,
    0,
  )
  if (rowPhysicalReferenceCountTotal !== confirmed + uncertain)
    throw new RangeError('Closeout row physical receipt totals mismatch')
}

interface CaseQualityRow {
  opaqueCaseId: string
  stratum: EvaluatorPrivateAnnotationBundle['cases'][number]['stratum']
  sourceGroup: string
  expectedPresence: 'present' | 'absent'
  independentMaskCase: boolean
  candidate: OutputRow
  control: OutputRow
  candidatePositiveSuccess: boolean
  controlPositiveSuccess: boolean
  candidateNegativeFalse: boolean
  controlNegativeFalse: boolean
  maskIou: number | null
  maskPredictionMissReason: MaskPredictionMissReason | null
}

function loadReferenceMaskPixels(
  ref: { width: number; height: number; packedBinarySha256: string },
  canvasWidth: number,
  canvasHeight: number,
  packedMasksBySha256: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  if (ref.width !== canvasWidth || ref.height !== canvasHeight)
    throw new RangeError('Reference mask geometry mismatch with source canvas')
  const referencePacked = packedMasksBySha256.get(ref.packedBinarySha256)
  if (!referencePacked) throw new RangeError('Missing reference packed mask bytes')
  assertArtifactMapKeyMatchesBytes(ref.packedBinarySha256, referencePacked)
  const pixels = unpackBinaryLsb0V1(canvasWidth, canvasHeight, referencePacked)
  if (countForegroundPixels(pixels) === 0)
    throw new RangeError('Reference mask cannot be empty for a positive case')
  return pixels
}

function scorePredictionMask(
  row: OutputRow,
  canvasWidth: number,
  canvasHeight: number,
  referencePixels: Uint8Array,
  packedMasksBySha256: ReadonlyMap<string, Uint8Array>,
): { iou: number; missReason: MaskPredictionMissReason | null } {
  if (row.executionValidity !== 'valid')
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_execution_invalid' }
  if (row.caseState !== 'success')
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_not_success' }
  if (row.box === null)
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_box_missing' }
  if (!row.maskPackedSha256)
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_mask_missing_sha256' }
  const predictedPacked = packedMasksBySha256.get(row.maskPackedSha256)
  if (!predictedPacked)
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_mask_bytes_absent' }
  try {
    assertArtifactMapKeyMatchesBytes(row.maskPackedSha256, predictedPacked)
  } catch {
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_mask_hash_mismatch' }
  }
  let predictedPixels: Uint8Array
  try {
    predictedPixels = unpackBinaryLsb0V1(canvasWidth, canvasHeight, predictedPacked)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('length') || message.includes('geometry'))
      return {
        iou: missingPredictionMaskIoU().iou,
        missReason: 'prediction_mask_geometry_mismatch',
      }
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_mask_invalid_packing' }
  }
  if (countForegroundPixels(predictedPixels) === 0)
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_mask_zero_foreground' }
  const predictedBox = deriveInclusivePixelBox(predictedPixels, canvasWidth, canvasHeight)
  if (!predictedBox || !boxesExactlyEqual(row.box, predictedBox))
    return { iou: missingPredictionMaskIoU().iou, missReason: 'prediction_mask_box_mismatch' }
  return { iou: binaryMaskIoU(predictedPixels, referencePixels).iou, missReason: null }
}

export function assertReferenceBoxesWithinCanvas(
  truth: EvaluatorPrivateAnnotationBundle['cases'][number],
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (truth.expectedPresence === 'present' && truth.referenceBoxes.length === 0)
    throw new RangeError('Positive annotation requires at least one reference box')
  if (truth.expectedPresence === 'absent' && truth.referenceBoxes.length !== 0)
    throw new RangeError('Negative annotation cannot contain reference boxes')
  for (const box of truth.referenceBoxes) {
    if (
      ![box.left, box.top, box.width, box.height].every(Number.isFinite) ||
      box.left < 0 ||
      box.top < 0 ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.left + box.width > canvasWidth ||
      box.top + box.height > canvasHeight
    )
      throw new RangeError('Reference box is invalid or outside source canvas')
  }
}

export function assertReferenceMaskDeclaration(
  truth: EvaluatorPrivateAnnotationBundle['cases'][number],
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (truth.expectedPresence === 'absent' && truth.exactOriginalCanvasMaskRef)
    throw new RangeError('Negative annotation cannot declare an object reference mask')
  if (truth.exactOriginalCanvasMaskRef && truth.referenceMasks.length === 0)
    throw new RangeError('Exact original-canvas annotation requires reference mask metadata')
  if (!truth.exactOriginalCanvasMaskRef && truth.referenceMasks.length !== 0)
    throw new RangeError('Reference mask metadata requires exact original-canvas declaration')
  for (const reference of truth.referenceMasks) {
    if (reference.width !== canvasWidth || reference.height !== canvasHeight)
      throw new RangeError('Reference mask geometry mismatch with source canvas')
  }
}

function isValidBoxWithinCanvas(box: BoxRect, canvasWidth: number, canvasHeight: number): boolean {
  return (
    [box.left, box.top, box.width, box.height].every(Number.isFinite) &&
    box.left >= 0 &&
    box.top >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.left + box.width <= canvasWidth &&
    box.top + box.height <= canvasHeight
  )
}

export function scorePositiveOutputRow(
  row: OutputRow,
  referenceBoxes: readonly BoxRect[],
  truth: EvaluatorPrivateAnnotationBundle['cases'][number],
  canvasWidth: number,
  canvasHeight: number,
  packedMasksBySha256: ReadonlyMap<string, Uint8Array>,
  requireMaskDerivedBox = false,
): boolean {
  if (row.executionValidity !== 'valid') return false
  if (row.caseState !== 'success' || row.box === null) return false

  const usesMaskPath =
    requireMaskDerivedBox || row.maskPackedSha256 !== null || truth.exactOriginalCanvasMaskRef
  if (!usesMaskPath) {
    if (!isValidBoxWithinCanvas(row.box, canvasWidth, canvasHeight)) return false
    return referenceBoxes.some(
      (reference) => boxIoUAndReferenceCoverage(row.box!, reference).matched,
    )
  }

  if (!row.maskPackedSha256) return false
  const predictedPacked = packedMasksBySha256.get(row.maskPackedSha256)
  if (!predictedPacked) return false
  try {
    assertArtifactMapKeyMatchesBytes(row.maskPackedSha256, predictedPacked)
    const predictedPixels = unpackBinaryLsb0V1(canvasWidth, canvasHeight, predictedPacked)
    if (countForegroundPixels(predictedPixels) === 0) return false
    const derived = deriveInclusivePixelBox(predictedPixels, canvasWidth, canvasHeight)
    if (!derived || !boxesExactlyEqual(row.box, derived)) return false
    return referenceBoxes.some(
      (reference) => boxIoUAndReferenceCoverage(derived, reference).matched,
    )
  } catch {
    return false
  }
}

export function scoreNegativeFalseOutputRow(row: OutputRow): boolean {
  return row.box !== null || row.cutoutPresent
}

function assertAnnotationBundleMatchesFreeze(
  freeze: PhaseFreeze,
  annotations: EvaluatorPrivateAnnotationBundle,
): void {
  const digest = computeEvaluatorAnnotationsSha256(annotations)
  if (digest !== freeze.evaluatorAnnotationsSha256)
    throw new RangeError('Annotation bundle digest mismatch with freeze commitment')

  if (annotations.freezeId !== freeze.freezeId) throw new RangeError('Annotation freezeId mismatch')
  if (annotations.phaseId !== freeze.phaseId) throw new RangeError('Annotation phaseId mismatch')
  if (annotations.cases.length !== freeze.producerCases.length)
    throw new RangeError('Annotation case count mismatch with freeze')
  for (let index = 0; index < freeze.producerCases.length; index++) {
    if (annotations.cases[index]?.opaqueCaseId !== freeze.producerCases[index]?.opaqueCaseId)
      throw new RangeError('Annotation case order mismatch with freeze')
  }

  const caseIds = annotations.cases.map((item) => item.opaqueCaseId)
  if (new Set(caseIds).size !== caseIds.length)
    throw new RangeError('Duplicate annotation case IDs')
  const freezeIds = new Set(freeze.producerCases.map((item) => item.opaqueCaseId))
  for (const id of caseIds) {
    if (!freezeIds.has(id)) throw new RangeError('Extraneous annotation case ID')
  }

  if (
    annotations.independentMaskCaseIds.length !== new Set(annotations.independentMaskCaseIds).size
  )
    throw new RangeError('Duplicate independent-mask annotation case IDs')
  if (
    annotations.independentMaskCaseIds.length !==
      freeze.qualificationIndependentMaskCaseIds.length ||
    annotations.independentMaskCaseIds.some(
      (id, index) => id !== freeze.qualificationIndependentMaskCaseIds[index],
    )
  )
    throw new RangeError('Independent-mask IDs mismatch with freeze commitment')

  const scheduleById = new Map(freeze.pairedSchedule.map((item) => [item.opaqueCaseId, item]))
  for (const annotation of annotations.cases) {
    const schedule = scheduleById.get(annotation.opaqueCaseId)
    if (!schedule || schedule.stratum !== annotation.stratum)
      throw new RangeError('Annotation stratum mismatch with frozen schedule')
  }

  for (const stratum of STRATUMS) {
    const committed = freeze.sourceStrataCommitments.find((item) => item.stratum === stratum)
    const stratumAnnotations = annotations.cases.filter((item) => item.stratum === stratum)
    if (!committed || committed.caseCount !== stratumAnnotations.length)
      throw new RangeError(`Annotation stratum ${stratum} count mismatch with freeze`)
    const sourceGroupsSha256 = computeSourceGroupStratumCommitmentSha256(
      annotations.phaseId,
      stratum,
      stratumAnnotations.map((item) => item.sourceGroup),
    )
    if (sourceGroupsSha256 !== committed.sourceGroupCommitmentSha256)
      throw new RangeError(`Annotation source groups mismatch with frozen ${stratum} commitment`)
  }

  const positives = annotations.cases.filter((item) => item.expectedPresence === 'present')
  const negatives = annotations.cases.filter((item) => item.expectedPresence === 'absent')
  if (isDevPhase(freeze.phaseId)) {
    if (annotations.independentMaskCaseIds.length !== 0)
      throw new RangeError('DEV40 cannot contain qualification independent-mask IDs')
    if (positives.length !== DEV40_POSITIVE_COUNT || negatives.length !== DEV40_NEGATIVE_COUNT)
      throw new RangeError('DEV40 annotation presence counts mismatch')
    for (const stratum of ['photo', 'ui', 'map'] as const) {
      const quota = DEV40_STRATUM_QUOTAS[stratum]
      const stratumRows = annotations.cases.filter((item) => item.stratum === stratum)
      const present = stratumRows.filter((item) => item.expectedPresence === 'present').length
      const absent = stratumRows.filter((item) => item.expectedPresence === 'absent').length
      if (present !== quota.present || absent !== quota.absent)
        throw new RangeError(`DEV40 annotation stratum ${stratum} quota mismatch`)
    }
  } else {
    if (positives.length !== QUAL120_POSITIVE_COUNT || negatives.length !== QUAL120_NEGATIVE_COUNT)
      throw new RangeError('QUAL120 annotation presence counts mismatch')
    for (const stratum of ['photo', 'ui', 'map'] as const) {
      const stratumRows = annotations.cases.filter((item) => item.stratum === stratum)
      const present = stratumRows.filter((item) => item.expectedPresence === 'present').length
      const absent = stratumRows.filter((item) => item.expectedPresence === 'absent').length
      if (present !== QUAL120_STRATUM_COUNT || absent !== QUAL120_NEGATIVE_COUNT / 3)
        throw new RangeError(`QUAL120 annotation stratum ${stratum} quota mismatch`)
    }
    const annotationsById = new Map(annotations.cases.map((item) => [item.opaqueCaseId, item]))
    for (const id of freeze.qualificationIndependentMaskCaseIds) {
      const annotation = annotationsById.get(id)
      if (
        !annotation ||
        annotation.stratum !== 'photo' ||
        annotation.expectedPresence !== 'present' ||
        !annotation.exactOriginalCanvasMaskRef ||
        annotation.referenceMasks.length === 0
      )
        throw new RangeError('Each independent mask must be a referenced photo-positive case')
    }
    if (
      annotations.cases.some(
        (item) =>
          item.exactOriginalCanvasMaskRef &&
          !freeze.qualificationIndependentMaskCaseIds.includes(item.opaqueCaseId),
      )
    )
      throw new RangeError('Mask references must match the preselected freeze IDs exactly')
  }
}

export function joinCloseoutsWithPrivateAnnotations(input: {
  freeze: PhaseFreeze
  candidateCloseout: ImmutableCloseout
  controlCloseout: ImmutableCloseout
  annotations: EvaluatorPrivateAnnotationBundle
  packedMasksBySha256: ReadonlyMap<string, Uint8Array>
}): CaseQualityRow[] {
  validateImmutableCloseouts({
    freeze: input.freeze,
    candidateCloseout: input.candidateCloseout,
    controlCloseout: input.controlCloseout,
  })
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(input.annotations)
  assertAnnotationBundleMatchesFreeze(input.freeze, annotations)

  const producerById = new Map(input.freeze.producerCases.map((item) => [item.opaqueCaseId, item]))
  const candidateById = new Map(
    input.candidateCloseout.outputRows.map((item) => [item.opaqueCaseId, item]),
  )
  const controlById = new Map(
    input.controlCloseout.outputRows.map((item) => [item.opaqueCaseId, item]),
  )
  const independentMaskCaseIds = new Set(annotations.independentMaskCaseIds)
  const requireMaskDerivedBox =
    input.freeze.phaseId === PHASE_SCOPE_DEV40_ID ||
    input.freeze.phaseId === PHASE_SCOPE_QUAL120_ID ||
    input.freeze.phaseId === PHASE_NATIVE_PRESENCE_DEV40_ID ||
    input.freeze.phaseId === PHASE_NATIVE_PRESENCE_QUAL120_ID ||
    input.freeze.phaseId === PHASE_NATIVE_SELECTOR_DEV40_ID ||
    input.freeze.phaseId === PHASE_NATIVE_SELECTOR_QUAL120_ID

  const joined: CaseQualityRow[] = []
  for (const truth of annotations.cases) {
    const producerRow = producerById.get(truth.opaqueCaseId)
    if (!producerRow) throw new RangeError('Annotation references unknown producer case')
    const canvasWidth = producerRow.sourceCanvasWidth
    const canvasHeight = producerRow.sourceCanvasHeight

    const candidate = candidateById.get(truth.opaqueCaseId)
    const control = controlById.get(truth.opaqueCaseId)
    if (!candidate || !control) throw new RangeError('Missing closeout row for annotated case')

    assertReferenceBoxesWithinCanvas(truth, canvasWidth, canvasHeight)
    assertReferenceMaskDeclaration(truth, canvasWidth, canvasHeight)
    const referencePixelsList = truth.exactOriginalCanvasMaskRef
      ? truth.referenceMasks.map((ref) =>
          loadReferenceMaskPixels(ref, canvasWidth, canvasHeight, input.packedMasksBySha256),
        )
      : []

    let maskIou: number | null = null
    let maskPredictionMissReason: MaskPredictionMissReason | null = null

    if (truth.exactOriginalCanvasMaskRef) {
      const primaryReference = referencePixelsList[0]!
      if (truth.expectedPresence === 'present') {
        const scored = scorePredictionMask(
          candidate,
          canvasWidth,
          canvasHeight,
          primaryReference,
          input.packedMasksBySha256,
        )
        maskIou = scored.iou
        maskPredictionMissReason = scored.missReason
      }
    }

    joined.push({
      opaqueCaseId: truth.opaqueCaseId,
      stratum: truth.stratum,
      sourceGroup: truth.sourceGroup,
      expectedPresence: truth.expectedPresence,
      independentMaskCase: independentMaskCaseIds.has(truth.opaqueCaseId),
      candidate,
      control,
      candidatePositiveSuccess: scorePositiveOutputRow(
        candidate,
        truth.referenceBoxes,
        truth,
        canvasWidth,
        canvasHeight,
        input.packedMasksBySha256,
        requireMaskDerivedBox,
      ),
      controlPositiveSuccess: scorePositiveOutputRow(
        control,
        truth.referenceBoxes,
        truth,
        canvasWidth,
        canvasHeight,
        input.packedMasksBySha256,
        requireMaskDerivedBox,
      ),
      candidateNegativeFalse:
        truth.expectedPresence === 'absent' && scoreNegativeFalseOutputRow(candidate),
      controlNegativeFalse:
        truth.expectedPresence === 'absent' && scoreNegativeFalseOutputRow(control),
      maskIou,
      maskPredictionMissReason,
    })
  }

  if (joined.length !== input.candidateCloseout.outputRows.length)
    throw new RangeError('Annotation case set must match closeout row set exactly')
  return joined
}

interface Dev40GateResult {
  executionValid: boolean
  pairedCoverageComplete: boolean
  qualityPass: boolean
  falseNegativeOutputs: number
  positiveDenominator: number
  positiveSuccesses: number
  observedNegativeDenominator: number
  byStratum: Record<
    string,
    {
      positives: number
      positiveSuccesses: number
      negatives: number
      observedNegatives: number
      falseOutputs: number
    }
  >
}

export function evaluateDev40Gate(
  rows: readonly CaseQualityRow[],
  candidateId: H8aFreshCandidateId = PROFILE_CANDIDATE_ID,
): Dev40GateResult {
  if (rows.length !== DEV40_CASE_COUNT)
    throw new RangeError('DEV40 gate requires all 40 frozen cases')
  const caseIds = new Set<string>()
  const countsByStratum = new Map(STRATUMS.map((stratum) => [stratum, { present: 0, absent: 0 }]))
  for (const row of rows) {
    if (!row.opaqueCaseId || caseIds.has(row.opaqueCaseId))
      throw new RangeError('DEV40 gate requires unique nonempty case IDs')
    caseIds.add(row.opaqueCaseId)
    if (
      row.candidate.opaqueCaseId !== row.opaqueCaseId ||
      row.control.opaqueCaseId !== row.opaqueCaseId ||
      row.candidate.profileId !== candidateId ||
      row.control.profileId !== PROFILE_CONTROL_ID
    )
      throw new RangeError(
        'DEV40 gate requires one correctly bound candidate/control pair per case',
      )
    const stratumCounts = countsByStratum.get(row.stratum)
    if (!stratumCounts) throw new RangeError('DEV40 gate contains an unknown stratum')
    if (row.expectedPresence === 'present') stratumCounts.present++
    else if (row.expectedPresence === 'absent') stratumCounts.absent++
    else throw new RangeError('DEV40 gate contains an unknown expected-presence label')
  }
  for (const stratum of STRATUMS) {
    const counts = countsByStratum.get(stratum)!
    const expected = DEV40_STRATUM_QUOTAS[stratum]
    if (counts.present !== expected.present || counts.absent !== expected.absent)
      throw new RangeError(`DEV40 gate ${stratum} stratum quota mismatch`)
  }
  const positives = rows.filter((item) => item.expectedPresence === 'present')
  const negatives = rows.filter((item) => item.expectedPresence === 'absent')
  if (positives.length !== DEV40_POSITIVE_COUNT || negatives.length !== DEV40_NEGATIVE_COUNT)
    throw new RangeError('DEV40 denominator mismatch')

  const falseNegativeOutputs = negatives.filter((item) => item.candidateNegativeFalse).length
  const positiveSuccesses = positives.filter((item) => item.candidatePositiveSuccess).length
  const observedNegativeDenominator = negatives.filter((item) =>
    isCompletedSemanticOutcome(item.candidate),
  ).length
  const byStratum: Dev40GateResult['byStratum'] = {}
  for (const row of rows) {
    const bucket = byStratum[row.stratum] ?? {
      positives: 0,
      positiveSuccesses: 0,
      negatives: 0,
      observedNegatives: 0,
      falseOutputs: 0,
    }
    if (row.expectedPresence === 'present') {
      bucket.positives++
      if (row.candidatePositiveSuccess) bucket.positiveSuccesses++
    } else {
      bucket.negatives++
      if (isCompletedSemanticOutcome(row.candidate)) bucket.observedNegatives++
      if (row.candidateNegativeFalse) bucket.falseOutputs++
    }
    byStratum[row.stratum] = bucket
  }
  const executionValid = rows.every(
    (item) =>
      item.candidate.executionValidity === 'valid' && item.control.executionValidity === 'valid',
  )
  const pairedCoverageComplete = rows.every(
    (item) =>
      isTerminalCaseState(item.candidate.caseState) && isTerminalCaseState(item.control.caseState),
  )
  const qualityPass = executionValid && pairedCoverageComplete && falseNegativeOutputs === 0
  return {
    executionValid,
    pairedCoverageComplete,
    qualityPass,
    falseNegativeOutputs,
    positiveDenominator: positives.length,
    positiveSuccesses,
    observedNegativeDenominator,
    byStratum,
  }
}

function isCompletedSemanticOutcome(row: OutputRow): boolean {
  return row.executionValidity === 'valid' && isTerminalCaseState(row.caseState)
}

function isTerminalCaseState(state: OutputRow['caseState']): boolean {
  return (
    state === 'success' ||
    state === 'not_found' ||
    state === 'negative_clean' ||
    state === 'unknown'
  )
}

interface Qual120GateResult {
  executionValid: boolean
  qualityPass: boolean
  candidatePositiveSuccesses: number
  candidatePositiveRate: number
  controlPositiveRate: number
  pairedGainPoints: number
  stratumPositiveSuccesses: Record<string, number>
  candidateFalseOutputs: number
  independentMaskPassCount: number
  independentMaskDenominator: number
  bootstrapLower95: number
}

export function evaluateQual120Gate(
  rows: readonly CaseQualityRow[],
  candidateId: H8aFreshCandidateId = PROFILE_CANDIDATE_ID,
): Qual120GateResult {
  const positives = rows.filter((item) => item.expectedPresence === 'present')
  const negatives = rows.filter((item) => item.expectedPresence === 'absent')
  if (positives.length !== QUAL120_POSITIVE_COUNT || negatives.length !== QUAL120_NEGATIVE_COUNT)
    throw new RangeError('QUAL120 denominator mismatch')

  const candidatePositiveSuccesses = positives.filter(
    (item) => item.candidatePositiveSuccess,
  ).length
  const controlPositiveSuccesses = positives.filter((item) => item.controlPositiveSuccess).length
  const candidatePositiveRate = candidatePositiveSuccesses / positives.length
  const controlPositiveRate = controlPositiveSuccesses / positives.length
  const pairedGainPoints = (candidatePositiveRate - controlPositiveRate) * 100

  const stratumPositiveSuccesses: Record<string, number> = {}
  for (const stratum of ['photo', 'ui', 'map'] as const) {
    const stratumRows = positives.filter((item) => item.stratum === stratum)
    if (stratumRows.length !== QUAL120_STRATUM_COUNT)
      throw new RangeError(`Qualification stratum ${stratum} count mismatch`)
    stratumPositiveSuccesses[stratum] = stratumRows.filter(
      (item) => item.candidatePositiveSuccess,
    ).length
  }

  const candidateFalseOutputs = negatives.filter((item) => item.candidateNegativeFalse).length
  const independentMaskRows = rows.filter((item) => item.independentMaskCase)
  const independentMaskDenominator = 30
  if (
    independentMaskRows.length !== independentMaskDenominator ||
    independentMaskRows.some(
      (item) =>
        item.stratum !== 'photo' || item.expectedPresence !== 'present' || item.maskIou === null,
    )
  )
    throw new RangeError('QUAL120 independent mask denominator mismatch')
  const independentMaskPassCount = independentMaskRows.filter(
    (item) => (item.maskIou ?? 0) >= 0.8,
  ).length

  const bootstrap = clusteredSourceGroupBootstrap(
    positives.map((item) => ({
      opaqueCaseId: item.opaqueCaseId,
      stratum: item.stratum,
      sourceGroup: item.sourceGroup,
      candidateSuccess: item.candidatePositiveSuccess,
      controlSuccess: item.controlPositiveSuccess,
    })),
  )

  const caseIds = new Set<string>()
  const stratumCounts = new Map(STRATUMS.map((stratum) => [stratum, 0]))
  const completeSemanticPairs =
    rows.length === QUAL120_CASE_COUNT &&
    rows.every((item) => {
      if (!item.opaqueCaseId || caseIds.has(item.opaqueCaseId)) return false
      caseIds.add(item.opaqueCaseId)
      const stratumCount = stratumCounts.get(item.stratum)
      if (stratumCount === undefined) return false
      stratumCounts.set(item.stratum, stratumCount + 1)
      return (
        item.candidate.opaqueCaseId === item.opaqueCaseId &&
        item.control.opaqueCaseId === item.opaqueCaseId &&
        item.candidate.profileId === candidateId &&
        item.control.profileId === PROFILE_CONTROL_ID &&
        isCompletedSemanticOutcome(item.candidate) &&
        isCompletedSemanticOutcome(item.control)
      )
    }) &&
    STRATUMS.every((stratum) => stratumCounts.get(stratum) === QUAL120_CASE_COUNT / STRATUMS.length)
  const executionValid =
    completeSemanticPairs &&
    rows.every(
      (item) =>
        item.candidate.executionValidity === 'valid' && item.control.executionValidity === 'valid',
    )
  const qualityPass =
    executionValid &&
    candidatePositiveSuccesses >= 54 &&
    (['photo', 'ui', 'map'] as const).every(
      (stratum) => (stratumPositiveSuccesses[stratum] ?? 0) >= 12,
    ) &&
    pairedGainPoints >= 20 &&
    bootstrap.passesStrictlyPositiveLower &&
    candidateFalseOutputs <= 1 &&
    independentMaskPassCount >= 15

  return {
    executionValid,
    qualityPass,
    candidatePositiveSuccesses,
    candidatePositiveRate,
    controlPositiveRate,
    pairedGainPoints,
    stratumPositiveSuccesses,
    candidateFalseOutputs,
    independentMaskPassCount,
    independentMaskDenominator,
    bootstrapLower95: bootstrap.lower95,
  }
}

export function evaluatePhaseGate(
  phaseId: H8aFreshPhaseId,
  rows: readonly CaseQualityRow[],
): Dev40GateResult | Qual120GateResult {
  const candidateId = candidateIdForPhase(phaseId)
  if (isDevPhase(phaseId)) return evaluateDev40Gate(rows, candidateId)
  return evaluateQual120Gate(rows, candidateId)
}
