import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  assertNativeSelectorQualParentRoot,
  assertNativeSelectorQualDevGroupCoverage,
  isVerifiedNativeSelectorQualAdmission,
  readNativeSelectorQualParentGraph,
  verifyNativeSelectorQualParentExclusions,
  verifyNativeSelectorQualParentGraphForOfflineTest,
} from './native-selector-qual-admission.js'
import {
  NATIVE_SELECTOR_POLICY,
  NATIVE_SELECTOR_PRICE_PROOF,
  NATIVE_SELECTOR_ROOT,
  NATIVE_SELECTOR_STUDY_ID,
  NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  NATIVE_SELECTOR_CORRECTED_FREEZE_ID,
  NATIVE_SELECTOR_CORRECTED_ROOT,
  NATIVE_PRESENCE_POLICY,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'
import {
  PHASE_NATIVE_SELECTOR_DEV40_ID,
  PROFILE_CONTROL_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
} from './constants.js'
import {
  buildCloseout,
  buildOutputRow,
  buildSyntheticAnnotationBundle,
  buildSyntheticPhaseFreeze,
} from './test-fixtures.js'
import { buildDevScreenSelection, DEV_SCREEN_SEED } from './dev-screen-sampling.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import { validateNativeSelectorCorrectedDev40LedgerForQual } from './dev-replay-ledger.js'
import { evaluateDev40Gate, joinCloseoutsWithPrivateAnnotations } from './evaluator.js'
import { hashIdentity } from './hash-identity.js'
import { packBinaryLsb0V1, sha256PackedBytes } from './packed-binary-lsb0.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import { buildCaseArtifactIdentity } from './dev-screen-runner.js'
import { NATIVE_SELECTOR_QUAL_FREEZE_ID } from './native-selector-qual-protocol.js'

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')

async function writePinned(
  root: string,
  name: string,
  bytes: Uint8Array,
): Promise<{
  path: string
  sha256: string
  bytes: number
}> {
  const path = join(root, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes, { flag: 'wx' })
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength }
}

function rehashCloseout(closeout: ReturnType<typeof buildCloseout>) {
  const closeoutSha256 = hashIdentity({
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
  return { ...closeout, closeoutSha256 }
}

async function buildOfflineParentGraph(
  namespaceRoot: string,
  parentStudyId:
    | typeof NATIVE_SELECTOR_STUDY_ID
    | typeof NATIVE_SELECTOR_CORRECTED_STUDY_ID = NATIVE_SELECTOR_STUDY_ID,
) {
  const parentPolicy = replayStudyPolicy(parentStudyId)
  const root = join(namespaceRoot, 'parent')
  await mkdir(root, { recursive: true })
  const { freeze: rawSeed, sourceBytesByCaseId } = buildSyntheticPhaseFreeze(
    PHASE_NATIVE_SELECTOR_DEV40_ID,
  )
  const freezeId = parentPolicy.freezeId
  const baseAnnotations = buildSyntheticAnnotationBundle(
    PHASE_NATIVE_SELECTOR_DEV40_ID,
    freezeId,
    rawSeed.producerCases,
    rawSeed.pairedSchedule,
  )
  const annotations =
    parentStudyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID
      ? {
          ...baseAnnotations,
          cases: baseAnnotations.cases.map((item, index) => ({
            ...item,
            sourceGroup: `corrected-dev-group-${index % 24}`,
          })),
        }
      : baseAnnotations
  const seed =
    parentStudyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID
      ? {
          ...rawSeed,
          sourceStrataCommitments: rawSeed.sourceStrataCommitments.map((commitment) => ({
            ...commitment,
            sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
              baseAnnotations.phaseId,
              commitment.stratum,
              annotations.cases
                .filter((item) => item.stratum === commitment.stratum)
                .map((item) => item.sourceGroup),
            ),
          })),
        }
      : rawSeed
  const producerClosureValue = {
    schema: 'h8a-producer-closure-files-v1',
    sourceCommit:
      parentStudyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID
        ? '77fa1d75a53df945237dcf820871e3c30764a58f'
        : 'f33f7a10e2860e839be6aee74804c1336fa5ad91',
    files: [],
  }
  const producerClosureBytes = Buffer.from(JSON.stringify(producerClosureValue))
  const producerClosureSha256 = sha256(producerClosureBytes)
  const freeze = {
    ...seed,
    freezeId,
    producerClosureSha256,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotations),
  }
  const selection = buildDevScreenSelection(freeze, annotations)
  const freezeRef = await writePinned(root, 'freeze.json', Buffer.from(JSON.stringify(freeze)))
  const annotationsRef = await writePinned(
    root,
    'annotations.json',
    Buffer.from(JSON.stringify(annotations)),
  )
  const selectionRef = await writePinned(
    root,
    'selection.json',
    Buffer.from(JSON.stringify(selection)),
  )
  const closureRef = await writePinned(root, 'producer-closure.json', producerClosureBytes)
  const blobRoot = join(root, 'execution', 'case-blobs')
  const packedMasks = new Map<string, Uint8Array>()
  const predictionMaskFor = (caseId: string) => {
    const producer = freeze.producerCases.find((row) => row.opaqueCaseId === caseId)!
    const annotation = annotations.cases.find((row) => row.opaqueCaseId === caseId)!
    const pixels = new Uint8Array(producer.sourceCanvasWidth * producer.sourceCanvasHeight)
    const box = annotation.referenceBoxes[0]
    if (!box) throw new RangeError('Synthetic positive parent case lacks its reference box')
    for (let y = box.top; y < box.top + box.height; y++)
      pixels.fill(
        1,
        y * producer.sourceCanvasWidth + box.left,
        y * producer.sourceCanvasWidth + box.left + box.width,
      )
    const packed = packBinaryLsb0V1(producer.sourceCanvasWidth, producer.sourceCanvasHeight, pixels)
    const packedHash = sha256PackedBytes(packed)
    packedMasks.set(packedHash, packed)
    return { packedHash, packed }
  }
  const outputRows = (
    profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
  ) =>
    freeze.producerCases.map((producer, index) => {
      const physicalReceiptIds =
        (profileId === PROFILE_NATIVE_SELECTOR_CANDIDATE_ID && index === 0) ||
        (profileId === PROFILE_CONTROL_ID && index === 1)
          ? [1]
          : []
      const annotation = annotations.cases.find(
        (row) => row.opaqueCaseId === producer.opaqueCaseId,
      )!
      if (annotation.expectedPresence === 'absent')
        return buildOutputRow(producer.opaqueCaseId, profileId, { physicalReceiptIds })
      const { packedHash } = predictionMaskFor(producer.opaqueCaseId)
      return buildOutputRow(producer.opaqueCaseId, profileId, {
        caseState: 'success',
        box: { ...annotation.referenceBoxes[0]! },
        maskPackedSha256: packedHash,
        physicalReceiptIds,
      })
    })
  const candidateRows = outputRows(PROFILE_NATIVE_SELECTOR_CANDIDATE_ID)
  const controlRows = outputRows(PROFILE_CONTROL_ID)
  for (const [packedHash, packed] of packedMasks) {
    const path = join(blobRoot, packedHash.slice(0, 2), packedHash)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, packed, { flag: 'wx' })
  }
  const bindGlobalPhysicalId = (closeout: ReturnType<typeof buildCloseout>, physicalId: number) => {
    return rehashCloseout({
      ...closeout,
      physicalReceipts: closeout.physicalReceipts.map((row) => ({ ...row, physicalId })),
    })
  }
  const candidate = bindGlobalPhysicalId(
    buildCloseout(freeze, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, candidateRows),
    parentPolicy.inheritedPhysicalCalls + 1,
  )
  const control = bindGlobalPhysicalId(
    buildCloseout(freeze, PROFILE_CONTROL_ID, controlRows),
    parentPolicy.inheritedPhysicalCalls + 2,
  )
  const evaluationRows = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout: candidate,
    controlCloseout: control,
    annotations,
    packedMasksBySha256: packedMasks,
  })
  const dev40Gate = evaluateDev40Gate(evaluationRows, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID)
  assert.equal(dev40Gate.qualityPass, true)

  const reportValues: unknown[] = []
  const reviewValues: unknown[] = []
  const stages = [
    { stage: 'dev8' as const, ids: selection.dev8CaseIds, expectedPairs: 8 },
    { stage: 'dev12' as const, ids: selection.dev12CaseIds, expectedPairs: 12 },
    {
      stage: 'dev40' as const,
      ids: selection.cells.flatMap((cell) => cell.seededPermutationCaseIds),
      expectedPairs: 40,
    },
  ]
  const annotationById = new Map(annotations.cases.map((row) => [row.opaqueCaseId, row]))
  const evaluationById = new Map(evaluationRows.map((row) => [row.opaqueCaseId, row]))
  for (const stage of stages) {
    const stageRows = stage.ids.map((opaqueCaseId) => {
      const annotation = annotationById.get(opaqueCaseId)!
      const evaluation = evaluationById.get(opaqueCaseId)!
      const producer = freeze.producerCases.find((row) => row.opaqueCaseId === opaqueCaseId)!
      return {
        opaqueCaseId,
        stratum: annotation.stratum,
        expectedPresence: annotation.expectedPresence,
        candidateCaseState: evaluation.candidate.caseState,
        controlCaseState: evaluation.control.caseState,
        candidatePositiveSuccess: evaluation.candidatePositiveSuccess,
        controlPositiveSuccess: evaluation.controlPositiveSuccess,
        candidateNegativeFalse: evaluation.candidateNegativeFalse,
        controlNegativeFalse: evaluation.controlNegativeFalse,
        candidateIdentitySha256: hashIdentity(
          buildCaseArtifactIdentity(
            freeze,
            selection,
            producer,
            PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
          ),
        ),
        controlIdentitySha256: hashIdentity(
          buildCaseArtifactIdentity(freeze, selection, producer, PROFILE_CONTROL_ID),
        ),
      }
    })
    const positiveCount = stageRows.filter((row) => row.candidatePositiveSuccess).length
    const stageCaseIds = new Set(stage.ids)
    const summarizeArm = (closeout: ReturnType<typeof buildCloseout>) => {
      const logicals = closeout.logicalReceipts.filter((row) => stageCaseIds.has(row.opaqueCaseId))
      const logicalIds = new Set(logicals.map((row) => row.logicalId))
      const physicals = closeout.physicalReceipts.filter((row) => logicalIds.has(row.logicalId))
      return {
        knownCostUsd: physicals.reduce(
          (sum, row) => sum + (row.chargeState === 'known' ? (row.costUsd ?? 0) : 0),
          0,
        ),
        unknownReservedUsd: physicals.filter((row) => row.chargeState === 'unknown').length * 0.12,
        confirmedPhysicalCalls: physicals.filter((row) => row.dispatchState === 'confirmed').length,
        logicalAttempts: logicals.length,
      }
    }
    const candidateSummary = summarizeArm(candidate)
    const controlSummary = summarizeArm(control)
    const perCell = selection.cells.map((cell) => {
      const includedIds =
        stage.stage === 'dev8'
          ? cell.dev8CaseIds
          : stage.stage === 'dev12'
            ? cell.dev12CaseIds
            : cell.seededPermutationCaseIds
      const count = includedIds.length
      const positive = cell.expectedPresence === 'present' ? count : 0
      return {
        stratum: cell.stratum,
        expectedPresence: cell.expectedPresence,
        quota: count,
        inclusionProbability: count / cell.populationCount,
        candidatePositiveSuccesses: positive,
        controlPositiveSuccesses: positive,
        candidateNegativeFalse: 0,
        controlNegativeFalse: 0,
        weightedCandidatePositiveSuccessTotal: positive / (count / cell.populationCount),
        weightedControlPositiveSuccessTotal: positive / (count / cell.populationCount),
        weightedCandidatePositiveFailureTotal: 0,
        weightedControlPositiveFailureTotal: 0,
        weightedCandidateNegativeFalseTotal: 0,
        weightedControlNegativeFalseTotal: 0,
        observedPositivePairs: cell.expectedPresence === 'present' ? count : 0,
        observedNegativePairs: cell.expectedPresence === 'absent' ? count : 0,
        observedCandidatePositiveRows: positive,
        observedControlPositiveRows: positive,
        observedCandidateNegativeRows: cell.expectedPresence === 'absent' ? count : 0,
        observedControlNegativeRows: cell.expectedPresence === 'absent' ? count : 0,
      }
    })
    const body = {
      schema: 'h8a-dev-screen-report-v1' as const,
      screen: stage.stage,
      freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
      selectionCommitmentSha256: selection.selectionCommitmentSha256,
      seed: DEV_SCREEN_SEED,
      completedPairs: stage.expectedPairs,
      expectedPairs: stage.expectedPairs,
      hardBlockers: [],
      qualitativeReviewProtocol: 'no-apparent-collapse-main-review-v1' as const,
      qualitativeReviewOwner: 'main-orchestrator' as const,
      perCell,
      rawCandidatePositiveSuccesses: positiveCount,
      rawControlPositiveSuccesses: positiveCount,
      candidatePositiveDenominator: positiveCount,
      controlPositiveDenominator: positiveCount,
      weightedCandidatePositiveRate: positiveCount > 0 ? 1 : null,
      weightedControlPositiveRate: positiveCount > 0 ? 1 : null,
      weightedPairedPositiveDifference: positiveCount > 0 ? 0 : null,
      weightedEstimateComplete: true,
      candidateNegativeFalseOutputs: 0,
      rawDurationMs: Array.from({ length: stage.expectedPairs }, () => 1),
      nearestRankP50Ms: 1,
      nearestRankP95Ms: 1,
      knownCostUsd: candidateSummary.knownCostUsd + controlSummary.knownCostUsd,
      unknownReservedUsd: candidateSummary.unknownReservedUsd + controlSummary.unknownReservedUsd,
      successfulPositiveKnownCostUsd:
        positiveCount > 0 ? candidateSummary.knownCostUsd / positiveCount : null,
      candidate: {
        knownCostUsd: candidateSummary.knownCostUsd,
        unknownReservedUsd: candidateSummary.unknownReservedUsd,
        confirmedPhysicalCalls: candidateSummary.confirmedPhysicalCalls,
        logicalAttempts: candidateSummary.logicalAttempts,
        unknownDurationCount: 0,
        durationsMs: Array.from({ length: stage.expectedPairs }, () => 1),
        p50Ms: 1,
        p95Ms: 1,
        successfulPositiveKnownCostUsd:
          positiveCount > 0 ? candidateSummary.knownCostUsd / positiveCount : null,
      },
      control: {
        knownCostUsd: controlSummary.knownCostUsd,
        unknownReservedUsd: controlSummary.unknownReservedUsd,
        confirmedPhysicalCalls: controlSummary.confirmedPhysicalCalls,
        logicalAttempts: controlSummary.logicalAttempts,
        unknownDurationCount: 0,
        durationsMs: Array.from({ length: stage.expectedPairs }, () => 1),
        p50Ms: 1,
        p95Ms: 1,
        successfulPositiveKnownCostUsd:
          positiveCount > 0 ? controlSummary.knownCostUsd / positiveCount : null,
      },
      outputs: stageRows,
    }
    const reportSha256 = hashIdentity(body)
    reportValues.push({ ...body, reportSha256 })
    const reviewBody = {
      schema: 'h8a-dev-screen-review-v1' as const,
      screenReportSha256: reportSha256,
      reviewProtocol: 'no-apparent-collapse-main-review-v1' as const,
      reviewerId: 'main-orchestrator' as const,
      judgement: 'advance' as const,
      reason: 'Synthetic graph validator fixture only.',
    }
    reviewValues.push({ ...reviewBody, reviewSha256: hashIdentity(reviewBody) })
  }
  const reportRefs: [
    Awaited<ReturnType<typeof writePinned>>,
    Awaited<ReturnType<typeof writePinned>>,
    Awaited<ReturnType<typeof writePinned>>,
  ] = [
    await writePinned(root, 'report-0.json', Buffer.from(JSON.stringify(reportValues[0]))),
    await writePinned(root, 'report-1.json', Buffer.from(JSON.stringify(reportValues[1]))),
    await writePinned(root, 'report-2.json', Buffer.from(JSON.stringify(reportValues[2]))),
  ]
  const reviewRefs: [
    Awaited<ReturnType<typeof writePinned>>,
    Awaited<ReturnType<typeof writePinned>>,
    Awaited<ReturnType<typeof writePinned>>,
  ] = [
    await writePinned(root, 'review-0.json', Buffer.from(JSON.stringify(reviewValues[0]))),
    await writePinned(root, 'review-1.json', Buffer.from(JSON.stringify(reviewValues[1]))),
    await writePinned(root, 'review-2.json', Buffer.from(JSON.stringify(reviewValues[2]))),
  ]
  const candidateRef = await writePinned(
    root,
    'candidate-closeout.json',
    Buffer.from(JSON.stringify(candidate)),
  )
  const controlRef = await writePinned(
    root,
    'control-closeout.json',
    Buffer.from(JSON.stringify(control)),
  )
  const sourceAuditRows = freeze.producerCases.map((producer, index) => ({
    opaqueCaseId: producer.opaqueCaseId,
    sourceBytesSha256: producer.sourceBytesSha256,
    encodedBytes: sourceBytesByCaseId.get(producer.opaqueCaseId)!.byteLength,
    sourceCanvasWidth: producer.sourceCanvasWidth,
    sourceCanvasHeight: producer.sourceCanvasHeight,
    sharpRuntimeDecodedRgbSha256: sha256(`sharp-rgb-${index}`),
    pillowCanonicalRgbSha256: sha256(`pillow-rgb-${index}`),
    sourcePath: join(root, 'source-fixtures', `${producer.opaqueCaseId}.jpg`),
  }))
  const sourceUnionRows = sourceAuditRows.map((row, index) => ({
    opaqueCaseId: row.opaqueCaseId,
    encodedSha256: row.sourceBytesSha256,
    sharpRuntimeDecodedRgbSha256: row.sharpRuntimeDecodedRgbSha256,
    decodedRgbSha256: row.pillowCanonicalRgbSha256,
    perceptualHash64: index % 3 === 1 ? 'ffffffffffffffff' : index.toString(16).padStart(16, '0'),
  }))
  const sourceUnion = {
    schema: 'h8a-ui-state-dev40-source-union-audit-v1',
    algorithm: 'benchmarks/v03/fresh-dev/imaging.py:perceptual_hash64_from_rgb',
    sha256Implementation: 'ea06f305375ced9341d07ef5afcdc615f0b93afc340939a2bc2c654bd97495f1',
    decodedRgbContract: 'pillow-rgb-canonical-identity-and-sharp-srgb-runtime-decoder-v1',
    nearestHammingContract:
      'minimum diagnostic distance to all 348 historical and other 39 study source pHashes; reject at <=4 only for photo/map',
    rows: sourceUnionRows,
  }
  const sourceUnionRef = await writePinned(
    root,
    'source-union.json',
    Buffer.from(JSON.stringify(sourceUnion)),
  )
  const sourceAudit = {
    schema: 'h8a-replay-original-input-byte-audit-v1',
    sourceCases: 40,
    references: [{ path: sourceUnionRef.path, sha256: sourceUnionRef.sha256 }],
    rows: sourceAuditRows,
  }
  const sourceAuditRef = await writePinned(
    root,
    'source-audit.json',
    Buffer.from(JSON.stringify(sourceAudit)),
  )
  const sourceBytesRefs = freeze.producerCases.map((producer) => ({
    path: join(root, 'source-fixtures', `${producer.opaqueCaseId}.jpg`),
    sha256: producer.sourceBytesSha256,
    caseId: producer.opaqueCaseId,
    bytes: sourceBytesByCaseId.get(producer.opaqueCaseId)!.byteLength,
  }))
  for (const source of sourceBytesRefs) {
    await mkdir(join(source.path, '..'), { recursive: true })
    await writeFile(source.path, sourceBytesByCaseId.get(source.caseId)!, { flag: 'wx' })
  }
  const referenceMaskBytes = Buffer.from([0])
  const referenceMaskFile = await writePinned(root, 'reference-mask.bin', referenceMaskBytes)
  const referenceMasks = Array.from({ length: 16 }, () => ({
    path: referenceMaskFile.path,
    sha256: referenceMaskFile.sha256,
    packedBinarySha256: sha256PackedBytes(referenceMaskBytes),
  }))
  const corrected = parentStudyId === NATIVE_SELECTOR_CORRECTED_STUDY_ID
  const parentProtocol = {
    schema: corrected
      ? 'h8a-native-selector-corrected-replay-protocol-v1'
      : 'h8a-native-selector-replay-protocol-v1',
    studyId: parentStudyId,
    freezeId,
    deadlineIso: '2026-11-02T12:11:51.738Z',
    parentAudit: { path: join(root, 'parent-audit.json'), sha256: '1'.repeat(64) },
    sourceAudit: { path: sourceAuditRef.path, sha256: sourceAuditRef.sha256 },
    freeze: { path: freezeRef.path, sha256: freezeRef.sha256 },
    annotations: { path: annotationsRef.path, sha256: annotationsRef.sha256 },
    selection: { path: selectionRef.path, sha256: selectionRef.sha256 },
    producerClosure: { path: closureRef.path, sha256: closureRef.sha256 },
    runtimeProof: { path: join(root, 'runtime-proof.json'), sha256: '2'.repeat(64) },
    runtimeEnvironment: { path: join(root, 'runtime-environment.json'), sha256: '3'.repeat(64) },
    sourceBytes: sourceBytesRefs,
    referenceMasks,
    executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256,
    queryPolicy: {
      policyId: 'strict-authored-scope-v1',
      sha256: '8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc',
      hypothesisSha256: 'dac1bf0eeecfaa204a70e3a89d5e16d7c64ced576a972923a3a1665287426ab2',
    },
    selectionPolicy: {
      policyId: NATIVE_SELECTOR_POLICY.policyId,
      sha256: NATIVE_SELECTOR_POLICY.sha256,
      hypothesisSha256: NATIVE_SELECTOR_POLICY.hypothesisSha256,
    },
    presencePolicy: {
      policyId: NATIVE_PRESENCE_POLICY.policyId,
      sha256: NATIVE_PRESENCE_POLICY.sha256,
      hypothesisSha256: NATIVE_PRESENCE_POLICY.hypothesisSha256,
    },
    priceProof: {
      path: NATIVE_SELECTOR_PRICE_PROOF.path,
      sha256: NATIVE_SELECTOR_PRICE_PROOF.sha256,
    },
    budget: {
      globalPhysicalCallLimit: 2_000,
      dev40PhysicalCallLimit: 400,
      candidateMaxCallsPerCase: 4,
      controlMaxCallsPerCase: 6,
      candidateMaxUsdPerDispatch: 0.12,
      controlMaxUsdPerDispatch: 0.12,
      ownerDollarCeilingUsd: null,
    },
    noRetryOrFallback: true,
    physicalCallsAt: 'fetch',
  }
  const parentProtocolRef = await writePinned(
    root,
    'protocol.json',
    Buffer.from(JSON.stringify(parentProtocol)),
  )
  const registrationBody = {
    schema: parentPolicy.registrationSchema,
    studyId: parentPolicy.studyId,
    freezeId: parentPolicy.freezeId,
    protocolSha256: parentProtocolRef.sha256,
    parentAuditSha256: parentPolicy.parentAuditSha256,
    parentLedgerSha256: parentPolicy.parentLedgerSha256,
    parentLedgerVersion: parentPolicy.parentLedgerVersion,
    canonicalRoot: resolve(parentPolicy.canonicalRoot, 'admission', 'successor-campaign'),
    caseIds: freeze.producerCases.map((row) => row.opaqueCaseId),
    maxPhysicalCalls: 2_000,
    dev40MaxPhysicalCalls: parentPolicy.incrementalCallLimit,
    dev40MaxIncrementalUsd: parentPolicy.incrementalExposureUsd,
    candidateMaxUsdPerDispatch: parentPolicy.candidateUsdPerDispatch,
    controlMaxUsdPerDispatch: parentPolicy.controlUsdPerDispatch,
    ownerDollarCeilingUsd: null,
    retries: 0,
  }
  const registration = {
    ...registrationBody,
    registrationSha256: sha256(JSON.stringify(registrationBody)),
  }
  const physicalCalls = 2
  const logicalAttempts = freeze.producerCases.flatMap((row) => [
    { profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, opaqueCaseId: row.opaqueCaseId },
    { profileId: PROFILE_CONTROL_ID, opaqueCaseId: row.opaqueCaseId },
  ])
  const state = {
    schema: parentPolicy.ledgerSchema,
    ledgerVersion: parentPolicy.parentLedgerVersion + physicalCalls,
    registrationSha256: registration.registrationSha256,
    nextReservationId: parentPolicy.inheritedPhysicalCalls + physicalCalls + 1,
    nextPhysicalId: parentPolicy.inheritedPhysicalCalls + physicalCalls + 1,
    physicalDispatchCount: parentPolicy.inheritedPhysicalCalls + physicalCalls,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: parentPolicy.inheritedLogicalAttempts + logicalAttempts.length,
    knownCostUsd: parentPolicy.inheritedKnownCostUsd + physicalCalls * 0.001,
    unknownReserveUsd: parentPolicy.inheritedUnknownReserveUsd,
    dev40PhysicalCalls: physicalCalls,
    dev40KnownCostUsd: physicalCalls * 0.001,
    dev40UnknownReserveUsd: 0,
    caseCounts: [
      {
        profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
        opaqueCaseId: freeze.producerCases[0]!.opaqueCaseId,
        physicalCalls: 1,
      },
      {
        profileId: PROFILE_CONTROL_ID,
        opaqueCaseId: freeze.producerCases[1]!.opaqueCaseId,
        physicalCalls: 1,
      },
    ],
    logicalAttempts,
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
    integrityBlocked: false,
  }
  const ledgerRef = await writePinned(root, 'ledger.json', Buffer.from(JSON.stringify(state)))
  const registrationRef = await writePinned(
    root,
    'registration.json',
    Buffer.from(JSON.stringify(registration)),
  )
  const parentCloseout = {
    schema: corrected
      ? 'h8a-native-selector-corrected-replay-dev40-closeout-v1'
      : 'h8a-native-selector-replay-dev40-closeout-v1',
    studyId: parentStudyId,
    freezeId,
    protocolSha256: parentProtocolRef.sha256,
    candidateCloseoutSha256: candidate.closeoutSha256,
    controlCloseoutSha256: control.closeoutSha256,
    dev40Gate,
    allStageReviewsAdvance: true,
    terminalStop: null,
    qualEligible: true,
  }
  const parentCloseoutRef = await writePinned(
    root,
    'dev40-closeout.json',
    Buffer.from(JSON.stringify(parentCloseout)),
  )
  const graph = {
    root,
    protocol: parentProtocolRef,
    freeze: freezeRef,
    annotations: annotationsRef,
    sourceAudit: sourceAuditRef,
    producerClosure: closureRef,
    candidateCloseout: candidateRef,
    controlCloseout: controlRef,
    dev40Closeout: parentCloseoutRef,
    ledger: ledgerRef,
    registration: registrationRef,
    stageReports: reportRefs,
    stageReviews: reviewRefs,
  } satisfies Parameters<typeof verifyNativeSelectorQualParentGraphForOfflineTest>[0]['graph']
  return { graph, state, registration, sourceUnionRows, candidate, control, parentCloseout }
}

await test('QUAL admission only accepts the selected V5 DEV40 parent namespace', () => {
  assert.doesNotThrow(() => assertNativeSelectorQualParentRoot(NATIVE_SELECTOR_ROOT))
  assert.throws(
    () =>
      assertNativeSelectorQualParentRoot(
        '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1',
      ),
    /native-selector DEV40 namespace/u,
  )
  assert.equal(isVerifiedNativeSelectorQualAdmission({}), false)
})

await test('production parent root is rejected before attempting pinned-reference reads', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-root-preflight-'))
  try {
    const { graph } = await buildOfflineParentGraph(namespaceRoot)
    await assert.rejects(
      readNativeSelectorQualParentGraph({
        ...graph,
        root: join(namespaceRoot, 'unknown-production-root'),
      }),
      /closed native-selector DEV40 namespace/u,
    )
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('offline QUAL fixture validates the complete DEV40 parent graph with the production validator', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-parent-graph-'))
  try {
    const { graph, state, control, parentCloseout } = await buildOfflineParentGraph(namespaceRoot)
    const verified = await verifyNativeSelectorQualParentGraphForOfflineTest({
      offlineTestOnly: true,
      namespaceRoot,
      graph,
    })
    assert.equal(verified.freeze.phaseId, PHASE_NATIVE_SELECTOR_DEV40_ID)
    assert.equal(verified.parentState.physicalDispatchCount, state.physicalDispatchCount)
    assert.equal(verified.parentState.nextPhysicalId, state.nextPhysicalId)
    assert.equal(verified.sourceAuditRows.length, 40)
    assert.equal(verified.sourceUnionRows.length, 40)
    await assert.rejects(
      verifyNativeSelectorQualParentGraphForOfflineTest({
        offlineTestOnly: true,
        namespaceRoot,
        graph: { ...graph, freeze: { ...graph.freeze, sha256: 'a'.repeat(64) } },
      }),
      /Pinned replay input changed while being read/u,
    )
    await assert.rejects(
      verifyNativeSelectorQualParentGraphForOfflineTest({
        offlineTestOnly: true,
        namespaceRoot,
        graph: {
          ...graph,
          sourceAudit: { ...graph.sourceAudit, path: join(namespaceRoot, 'escape.json') },
        },
      }),
      /escape|pins differ/u,
    )
    const firstReport = JSON.parse(await readFile(graph.stageReports[0]!.path, 'utf8')) as Record<
      string,
      unknown
    >
    const { reportSha256: _priorReportHash, ...firstReportBody } = firstReport
    const reportBody = {
      ...firstReportBody,
      outputs: (firstReport.outputs as Array<Record<string, unknown>>).map((row, index) =>
        index === 0 ? { ...row, candidateCaseState: 'invalid-semantics' } : row,
      ),
    }
    const reportSha256 = hashIdentity(reportBody)
    const reportRef = await writePinned(
      graph.root,
      'report-with-detached-outcome.json',
      Buffer.from(JSON.stringify({ ...reportBody, reportSha256 })),
    )
    const firstReview = JSON.parse(await readFile(graph.stageReviews[0]!.path, 'utf8')) as Record<
      string,
      unknown
    >
    const { reviewSha256: _priorReviewHash, ...reviewBody } = firstReview
    const reviewRef = await writePinned(
      graph.root,
      'review-for-detached-outcome.json',
      Buffer.from(
        JSON.stringify({
          ...reviewBody,
          screenReportSha256: reportSha256,
          reviewSha256: hashIdentity({ ...reviewBody, screenReportSha256: reportSha256 }),
        }),
      ),
    )
    const stageReports = [...graph.stageReports] as typeof graph.stageReports
    const stageReviews = [...graph.stageReviews] as typeof graph.stageReviews
    stageReports[0] = reportRef
    stageReviews[0] = reviewRef
    await assert.rejects(
      verifyNativeSelectorQualParentGraphForOfflineTest({
        offlineTestOnly: true,
        namespaceRoot,
        graph: { ...graph, stageReports, stageReviews },
      }),
      /review is not an advancing complete report/u,
    )
    const orphanLedger = {
      ...state,
      ledgerVersion: state.ledgerVersion + 1,
      nextReservationId: state.nextReservationId + 1,
      nextPhysicalId: state.nextPhysicalId + 1,
      physicalDispatchCount: state.physicalDispatchCount + 1,
      knownCostUsd: state.knownCostUsd + 0.001,
      dev40PhysicalCalls: state.dev40PhysicalCalls + 1,
      dev40KnownCostUsd: state.dev40KnownCostUsd + 0.001,
      caseCounts: [
        ...state.caseCounts,
        {
          profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
          opaqueCaseId: 'h8a-native-selector-paired-dev40-v1-case-003',
          physicalCalls: 1,
        },
      ],
    }
    const orphanLedgerRef = await writePinned(
      graph.root,
      'ledger-orphan-dispatch.json',
      Buffer.from(JSON.stringify(orphanLedger)),
    )
    await assert.rejects(
      verifyNativeSelectorQualParentGraphForOfflineTest({
        offlineTestOnly: true,
        namespaceRoot,
        graph: { ...graph, ledger: orphanLedgerRef },
      }),
      /ledger dispatches or case attempts do not reconcile/u,
    )

    const duplicateControl = rehashCloseout({
      ...control,
      physicalReceipts: control.physicalReceipts.map((row) => ({ ...row, physicalId: 318 })),
    })
    const duplicateControlRef = await writePinned(
      graph.root,
      'control-duplicate-global-id.json',
      Buffer.from(JSON.stringify(duplicateControl)),
    )
    const duplicateParentCloseoutRef = await writePinned(
      graph.root,
      'dev40-closeout-duplicate-global-id.json',
      Buffer.from(
        JSON.stringify({
          ...parentCloseout,
          controlCloseoutSha256: duplicateControl.closeoutSha256,
        }),
      ),
    )
    await assert.rejects(
      verifyNativeSelectorQualParentGraphForOfflineTest({
        offlineTestOnly: true,
        namespaceRoot,
        graph: {
          ...graph,
          controlCloseout: duplicateControlRef,
          dev40Closeout: duplicateParentCloseoutRef,
        },
      }),
      /duplicate observed physical IDs|ledger dispatches or case attempts do not reconcile/u,
    )
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('corrected QUAL admission reserves 1200 only when confirmed calls leave enough global capacity', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-budget-boundary-'))
  try {
    const {
      graph,
      state: initialState,
      registration: initialRegistration,
    } = await buildOfflineParentGraph(namespaceRoot, NATIVE_SELECTOR_CORRECTED_STUDY_ID)
    const inheritedCalls = initialState.physicalDispatchCount - initialState.dev40PhysicalCalls
    assert.equal(inheritedCalls, 413)
    const candidateId = PROFILE_NATIVE_SELECTOR_CANDIDATE_ID
    const controlId = PROFILE_CONTROL_ID
    const makeLedgerPair = (newCalls: number, reservation?: 'pending' | 'uncertain') => {
      const { registrationSha256: _oldRegistrationSha256, ...registrationBody } =
        initialRegistration
      const registrationSha256 = sha256(JSON.stringify(registrationBody))
      const registration = { ...registrationBody, registrationSha256 }
      const physicalDispatchCount = inheritedCalls + newCalls
      const candidateCalls = newCalls - 40 * 6
      const candidateBase = Math.floor(candidateCalls / 40)
      const candidateRemainder = candidateCalls % 40
      const caseCounts = registration.caseIds.flatMap((opaqueCaseId, index) => [
        {
          profileId: candidateId,
          opaqueCaseId,
          physicalCalls: candidateBase + (index < candidateRemainder ? 1 : 0),
        },
        { profileId: controlId, opaqueCaseId, physicalCalls: 6 },
      ])
      const reservationTarget = registration.caseIds.at(-1)!
      const reserveUsd = registration.candidateMaxUsdPerDispatch
      const inFlightReservations = reservation
        ? [
            {
              reservationId: initialState.nextReservationId,
              profileId: candidateId,
              opaqueCaseId: reservationTarget,
              reservedUsd: reserveUsd,
              intent: true,
              dispatched: false,
              uncertain: reservation === 'uncertain',
              physicalId: null,
            },
          ]
        : []
      const state = {
        ...initialState,
        registrationSha256,
        physicalDispatchCount,
        uncertainPhysicalDispatchCount: reservation === 'uncertain' ? 1 : 0,
        nextPhysicalId: physicalDispatchCount + (reservation === 'uncertain' ? 1 : 0) + 1,
        dev40PhysicalCalls: newCalls,
        dev40KnownCostUsd: newCalls * 0.001,
        knownCostUsd: initialState.knownCostUsd - initialState.dev40KnownCostUsd + newCalls * 0.001,
        caseCounts,
        inFlightReservations,
      }
      return { state, registration }
    }
    const expected = {
      protocolSha256: graph.protocol.sha256,
      caseIds: initialRegistration.caseIds,
    }
    const at800 = makeLedgerPair(387) // 413 inherited + 387 DEV calls leaves exactly 1200.
    assert.equal(
      validateNativeSelectorCorrectedDev40LedgerForQual(at800.state, at800.registration, expected)
        .physicalDispatchCount,
      800,
    )
    const at801 = makeLedgerPair(388) // 413 inherited + 388 DEV calls leaves only 1199.
    assert.throws(
      () =>
        validateNativeSelectorCorrectedDev40LedgerForQual(
          at801.state,
          at801.registration,
          expected,
        ),
      /cannot admit the QUAL120 successor/u,
    )
    const pendingAt800 = makeLedgerPair(386, 'pending')
    assert.throws(
      () =>
        validateNativeSelectorCorrectedDev40LedgerForQual(
          pendingAt800.state,
          pendingAt800.registration,
          expected,
        ),
      /cannot admit the QUAL120 successor/u,
    )
    const uncertainAt800 = makeLedgerPair(386, 'uncertain')
    assert.throws(
      () =>
        validateNativeSelectorCorrectedDev40LedgerForQual(
          uncertainAt800.state,
          uncertainAt800.registration,
          expected,
        ),
      /cannot admit the QUAL120 successor/u,
    )
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('QUAL parent graph accepts only a complete corrected V5 parent and rejects the old STOP', async () => {
  assert.equal(assertNativeSelectorQualParentRoot(NATIVE_SELECTOR_ROOT), NATIVE_SELECTOR_STUDY_ID)
  assert.equal(
    assertNativeSelectorQualParentRoot(NATIVE_SELECTOR_CORRECTED_ROOT),
    NATIVE_SELECTOR_CORRECTED_STUDY_ID,
  )
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-corrected-parent-'))
  try {
    const fixture = await buildOfflineParentGraph(namespaceRoot, NATIVE_SELECTOR_CORRECTED_STUDY_ID)
    const verified = await verifyNativeSelectorQualParentGraphForOfflineTest({
      offlineTestOnly: true,
      namespaceRoot,
      graph: fixture.graph,
    })
    assert.equal(verified.studyId, NATIVE_SELECTOR_CORRECTED_STUDY_ID)
    assert.equal(verified.parentState.physicalDispatchCount, 415)
    assert.equal(verified.parentState.nextPhysicalId, 416)
    assert.equal(verified.freeze.freezeId, NATIVE_SELECTOR_CORRECTED_FREEZE_ID)
    const stopped = {
      ...fixture.parentCloseout,
      allStageReviewsAdvance: false,
      terminalStop: { stage: 'dev40', errorCode: 'EXECUTION_FAILED' },
      qualEligible: false,
    }
    const stoppedRef = await writePinned(
      fixture.graph.root,
      'corrected-stop-closeout.json',
      Buffer.from(JSON.stringify(stopped)),
    )
    await assert.rejects(
      verifyNativeSelectorQualParentGraphForOfflineTest({
        offlineTestOnly: true,
        namespaceRoot,
        graph: { ...fixture.graph, dev40Closeout: stoppedRef },
      }),
      /not completely eligible for QUAL/u,
    )
    await assert.rejects(
      verifyNativeSelectorQualParentGraphForOfflineTest({
        offlineTestOnly: true,
        namespaceRoot,
        graph: { ...fixture.graph, root: join(tmpdir(), 'outside-parent-root') },
      }),
      /disposable nested namespace/u,
    )
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('corrected QUAL parent admission requires linked history before any downstream setup', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-history-required-'))
  try {
    const { graph } = await buildOfflineParentGraph(
      namespaceRoot,
      NATIVE_SELECTOR_CORRECTED_STUDY_ID,
    )
    const parent = await verifyNativeSelectorQualParentGraphForOfflineTest({
      offlineTestOnly: true,
      namespaceRoot,
      graph,
    })
    let downstreamSetupStarted = false
    await assert.rejects(async () => {
      await verifyNativeSelectorQualParentExclusions({
        parent,
        exposedExclusionsValue: {
          schema: 'h8a-native-selector-qual120-exposed-exclusion-sources-v1',
          freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
          sources: [],
        },
        offlineNamespaceRoot: namespaceRoot,
      })
      downstreamSetupStarted = true
    }, /requires both pinned historical exclusion files/u)
    assert.equal(downstreamSetupStarted, false)
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('corrected parent historical preflight and downstream DEV-group check accept the pinned set', async () => {
  const namespaceRoot = await mkdtemp(join(tmpdir(), 'native-selector-qual-history-positive-'))
  try {
    const { graph } = await buildOfflineParentGraph(
      namespaceRoot,
      NATIVE_SELECTOR_CORRECTED_STUDY_ID,
    )
    const parent = await verifyNativeSelectorQualParentGraphForOfflineTest({
      offlineTestOnly: true,
      namespaceRoot,
      graph,
    })
    const normalize = (group: string): string => group.replace(/\/+$/u, '')
    const devGroups = [
      ...new Set(parent.annotations.cases.map((row) => normalize(row.sourceGroup))),
    ].sort()
    assert.ok(devGroups.length > 0)
    assert.ok(devGroups.length < parent.annotations.cases.length)
    const excludedGroups = Array.from(
      { length: 440 },
      (_, index) => `historical-group-${index}`,
    ).sort()
    const groupSplit = {
      schema: 'h8a-dev-source-group-split-v1',
      devSourceGroupIds: devGroups,
      qualificationSourceGroupIds: [],
      exclusionSourceGroupIds: excludedGroups,
      devCommitmentSha256: hashIdentity(devGroups),
      qualificationCommitmentSha256: hashIdentity([]),
      exclusionCommitmentSha256: hashIdentity(excludedGroups),
    }
    const pixels = {
      schema: 'study2-prior-pixel-exclusion-index-v1',
      algorithm: 'benchmarks/v03/fresh-dev/imaging.py:perceptual_hash64_from_rgb',
      sha256Implementation: 'ea06f305375ced9341d07ef5afcdc615f0b93afc340939a2bc2c654bd97495f1',
      maximumDistanceRejected: 4,
      rows: Array.from({ length: 348 }, (_, index) => ({
        encodedSha256: index.toString(16).padStart(64, '0'),
        decodedRgbSha256: (index + 1).toString(16).padStart(64, '0'),
        perceptualHash64: index.toString(16).padStart(16, '0'),
      })),
    }
    const groupPath = join(namespaceRoot, 'history', 'groups.json')
    const pixelPath = join(namespaceRoot, 'history', 'pixels.json')
    const groupBytes = Buffer.from(JSON.stringify(groupSplit))
    const pixelBytes = Buffer.from(JSON.stringify(pixels))
    const groupRef = await writePinned(namespaceRoot, 'history/groups.json', groupBytes)
    const pixelRef = await writePinned(namespaceRoot, 'history/pixels.json', pixelBytes)
    const preparationRef = await writePinned(
      namespaceRoot,
      'history/preparation.json',
      Buffer.from(
        JSON.stringify({
          schema: 'h8a-independent-dev40-v2-preparation-v1',
          sourceGroupSplit: { path: 'history/groups.json', sha256: groupRef.sha256 },
          historicalPixels: { path: 'history/pixels.json', sha256: pixelRef.sha256 },
        }),
      ),
    )
    const historical = await verifyNativeSelectorQualParentExclusions({
      parent: { ...parent, sourceAuditReferences: [preparationRef] },
      offlineNamespaceRoot: namespaceRoot,
      exposedExclusionsValue: {
        schema: 'h8a-native-selector-qual120-exposed-exclusion-sources-v1',
        freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
        sources: [],
        historical: {
          sourceGroupSplit: {
            path: groupPath,
            sha256: groupRef.sha256,
            bytes: groupBytes.byteLength,
          },
          historicalPixels: {
            path: pixelPath,
            sha256: pixelRef.sha256,
            bytes: pixelBytes.byteLength,
          },
        },
      },
    })
    assert.ok(historical)
    assert.equal(historical.sourceGroups.length, 440)
    assert.equal(historical.encodedHashes.length, 348)
    assert.doesNotThrow(() =>
      assertNativeSelectorQualDevGroupCoverage({
        parentGroups: parent.annotations.cases.map((row) => row.sourceGroup),
        auditGroups: historical.devSourceGroups,
        historicalDevGroups: historical.devSourceGroups,
      }),
    )
  } finally {
    await rm(namespaceRoot, { recursive: true, force: true })
  }
})

await test('historical QUAL group coverage uses the selected parent unique-group set', () => {
  const groups = Array.from({ length: 24 }, (_, index) => `dev-group-${index}`)
  const parentGroups = Array.from({ length: 40 }, (_, index) => groups[index % groups.length]!)
  assert.doesNotThrow(() =>
    assertNativeSelectorQualDevGroupCoverage({
      parentGroups,
      auditGroups: groups,
      historicalDevGroups: groups,
    }),
  )
  assert.throws(
    () =>
      assertNativeSelectorQualDevGroupCoverage({
        parentGroups,
        auditGroups: groups.slice(1),
        historicalDevGroups: groups,
      }),
    /selected parent history/u,
  )
  assert.doesNotThrow(() =>
    assertNativeSelectorQualDevGroupCoverage({
      parentGroups,
      auditGroups: parentGroups,
    }),
  )
  assert.throws(
    () =>
      assertNativeSelectorQualDevGroupCoverage({
        parentGroups,
        auditGroups: groups,
      }),
    /selected parent/u,
  )
  assert.throws(
    () =>
      assertNativeSelectorQualDevGroupCoverage({
        parentGroups: ['legacy-group/'],
        auditGroups: ['legacy-group'],
      }),
    /selected parent/u,
  )
})
