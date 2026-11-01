import { createHash } from 'node:crypto'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import {
  DEV40_CASE_COUNT,
  DEV40_NEGATIVE_COUNT,
  DEV40_POSITIVE_COUNT,
  DEV40_STRATUM_QUOTAS,
  H8A_FRESH_SCHEMA,
  PHASE_DEV40_ID,
  PHASE_QUAL120_ID,
  PHASE_FLAT_DEV40_ID,
  PHASE_FLAT_QUAL120_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  candidateIdForPhase,
  PROFILE_CONTROL_ID,
  type H8aFreshPhaseId,
  QUAL120_CASE_COUNT,
  QUAL120_NEGATIVE_COUNT,
  QUAL120_POSITIVE_COUNT,
  QUAL120_STRATUM_COUNT,
} from './constants.js'
import { hashIdentity } from './hash-identity.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import {
  H8A_CANDIDATE_PROFILE,
  H8A_FLAT_CANDIDATE_PROFILE,
  V02_CONTROL_PROFILE,
} from './profiles.js'
import type {
  EvaluatorPrivateAnnotationBundle,
  ImmutableCloseout,
  OutputRow,
  PhaseFreeze,
} from './schemas.js'
import { phaseFreezeSchema } from './schemas.js'

export const SYNTHETIC_SOURCE_CANVAS_WIDTH = 8 as const
export const SYNTHETIC_SOURCE_CANVAS_HEIGHT = 8 as const

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function recipeIdentity(
  profileId:
    | typeof PROFILE_CANDIDATE_ID
    | typeof PROFILE_FLAT_CANDIDATE_ID
    | typeof PROFILE_CONTROL_ID,
): string {
  const profile =
    profileId === PROFILE_CANDIDATE_ID
      ? H8A_CANDIDATE_PROFILE
      : profileId === PROFILE_FLAT_CANDIDATE_ID
        ? H8A_FLAT_CANDIDATE_PROFILE
        : V02_CONTROL_PROFILE
  return hashIdentity({
    profileId: profile.profileId,
    recipeKind: profile.recipeKind,
    requestPolicyIdentitySha256: profile.requestPolicyIdentitySha256,
  })
}

export function buildConservativeCostProof(
  maxUsdPerPhysicalDispatch: number,
  profileBounds?: {
    candidateMaxUsdPerPhysicalDispatch?: number
    controlMaxUsdPerPhysicalDispatch?: number
    candidateProfileId?: typeof PROFILE_CANDIDATE_ID | typeof PROFILE_FLAT_CANDIDATE_ID
  },
): PhaseFreeze['conservativeCostProof'] {
  const candidateMax =
    profileBounds?.candidateMaxUsdPerPhysicalDispatch ?? maxUsdPerPhysicalDispatch
  const controlMax = profileBounds?.controlMaxUsdPerPhysicalDispatch ?? maxUsdPerPhysicalDispatch
  const aggregateMax = Math.max(candidateMax, controlMax)
  const profileDispatchUpperBounds: PhaseFreeze['conservativeCostProof']['profileDispatchUpperBounds'] =
    [
      {
        profileId: profileBounds?.candidateProfileId ?? PROFILE_CANDIDATE_ID,
        maxUsdPerPhysicalDispatch: candidateMax,
      },
      {
        profileId: PROFILE_CONTROL_ID,
        maxUsdPerPhysicalDispatch: controlMax,
      },
    ]
  const body = {
    schema: 'h8a-fresh-conservative-cost-proof-v1' as const,
    proofKind: 'audited-upper-bound' as const,
    maxUsdPerPhysicalDispatch: aggregateMax,
    profileDispatchUpperBounds,
    derivedFrom: 'synthetic-test-proof',
  }
  return { ...body, proofSha256: hashIdentity(body) }
}

function buildScheduledCases(phaseId: H8aFreshPhaseId): {
  producerCases: PhaseFreeze['producerCases']
  pairedSchedule: PhaseFreeze['pairedSchedule']
} {
  const producerCases: PhaseFreeze['producerCases'] = []
  const pairedSchedule: PhaseFreeze['pairedSchedule'] = []
  let globalIndex = 0

  const pushCase = (stratum: 'photo' | 'ui' | 'map') => {
    const opaqueCaseId = `${phaseId}-case-${String(globalIndex + 1).padStart(3, '0')}`
    const bytes = new Uint8Array([globalIndex + 1, stratum.length, 0])
    producerCases.push({
      opaqueCaseId,
      sourceBytesSha256: sha256Bytes(bytes),
      sourceCanvasWidth: SYNTHETIC_SOURCE_CANVAS_WIDTH,
      sourceCanvasHeight: SYNTHETIC_SOURCE_CANVAS_HEIGHT,
      targetTaskText: `target-${opaqueCaseId}`,
    })
    pairedSchedule.push({
      opaqueCaseId,
      stratum,
      candidateArmFirst: globalIndex % 2 === 0,
    })
    globalIndex++
  }

  if (phaseId === PHASE_DEV40_ID || phaseId === PHASE_FLAT_DEV40_ID) {
    for (const stratum of ['photo', 'ui', 'map'] as const) {
      const quota = DEV40_STRATUM_QUOTAS[stratum]
      for (let index = 0; index < quota.present; index++) pushCase(stratum)
      for (let index = 0; index < quota.absent; index++) pushCase(stratum)
    }
    if (globalIndex !== DEV40_CASE_COUNT) throw new RangeError('DEV40 schedule length mismatch')
  } else {
    for (const stratum of ['photo', 'ui', 'map'] as const) {
      for (let index = 0; index < QUAL120_STRATUM_COUNT; index++) pushCase(stratum)
      for (let index = 0; index < QUAL120_NEGATIVE_COUNT / 3; index++) pushCase(stratum)
    }
    if (globalIndex !== QUAL120_CASE_COUNT) throw new RangeError('QUAL120 schedule length mismatch')
  }

  return { producerCases, pairedSchedule }
}

export function buildSyntheticAnnotationBundle(
  phaseId: H8aFreshPhaseId,
  freezeId: string,
  producerCases: PhaseFreeze['producerCases'],
  pairedSchedule: PhaseFreeze['pairedSchedule'],
): EvaluatorPrivateAnnotationBundle {
  const stratumPresentRemaining: Record<'photo' | 'ui' | 'map', number> =
    phaseId === PHASE_DEV40_ID || phaseId === PHASE_FLAT_DEV40_ID
      ? {
          photo: DEV40_STRATUM_QUOTAS.photo.present,
          ui: DEV40_STRATUM_QUOTAS.ui.present,
          map: DEV40_STRATUM_QUOTAS.map.present,
        }
      : { photo: QUAL120_STRATUM_COUNT, ui: QUAL120_STRATUM_COUNT, map: QUAL120_STRATUM_COUNT }

  const cases = producerCases.map((row, index) => {
    const stratum = pairedSchedule[index]!.stratum
    let present = false
    const remaining = stratumPresentRemaining[stratum] ?? 0
    if (remaining > 0) {
      stratumPresentRemaining[stratum] = remaining - 1
      present = true
    }
    const groupBucket = Math.floor(index / 3)
    return {
      opaqueCaseId: row.opaqueCaseId,
      stratum,
      sourceGroup: `${phaseId}-group-${stratum}-${groupBucket}`,
      expectedPresence: present ? ('present' as const) : ('absent' as const),
      referenceBoxes: present ? [{ left: 1, top: 1, width: 4, height: 4 }] : [],
      referenceMasks: [],
      exactOriginalCanvasMaskRef: false,
    }
  })

  const independentMaskCaseIds =
    phaseId === PHASE_QUAL120_ID || phaseId === PHASE_FLAT_QUAL120_ID
      ? cases
          .filter((item) => item.stratum === 'photo' && item.expectedPresence === 'present')
          .slice(0, 30)
          .map((item) => item.opaqueCaseId)
      : []
  const independentMaskCaseIdSet = new Set(independentMaskCaseIds)
  for (const item of cases) {
    if (independentMaskCaseIdSet.has(item.opaqueCaseId)) item.exactOriginalCanvasMaskRef = true
  }

  return {
    schema: 'h8a-fresh-evaluator-private-v1',
    phaseId,
    freezeId,
    independentMaskCaseIds,
    cases,
  }
}

export function buildSyntheticPhaseFreeze(phaseId: H8aFreshPhaseId): {
  freeze: PhaseFreeze
  sourceBytesByCaseId: Map<string, Uint8Array>
} {
  const totalCases =
    phaseId === PHASE_DEV40_ID || phaseId === PHASE_FLAT_DEV40_ID
      ? DEV40_CASE_COUNT
      : QUAL120_CASE_COUNT
  const positiveCases =
    phaseId === PHASE_DEV40_ID || phaseId === PHASE_FLAT_DEV40_ID
      ? DEV40_POSITIVE_COUNT
      : QUAL120_POSITIVE_COUNT
  const negativeCases =
    phaseId === PHASE_DEV40_ID || phaseId === PHASE_FLAT_DEV40_ID
      ? DEV40_NEGATIVE_COUNT
      : QUAL120_NEGATIVE_COUNT
  const { producerCases, pairedSchedule } = buildScheduledCases(phaseId)
  const freezeId = `${phaseId}-freeze-test`
  const annotationBundle = buildSyntheticAnnotationBundle(
    phaseId,
    freezeId,
    producerCases,
    pairedSchedule,
  )
  const evaluatorAnnotationsSha256 = computeEvaluatorAnnotationsSha256(annotationBundle)

  const strata = ['photo', 'ui', 'map'] as const
  const perStratumCaseCount =
    phaseId === PHASE_DEV40_ID || phaseId === PHASE_FLAT_DEV40_ID
      ? {
          photo: DEV40_STRATUM_QUOTAS.photo.total,
          ui: DEV40_STRATUM_QUOTAS.ui.total,
          map: DEV40_STRATUM_QUOTAS.map.total,
        }
      : {
          photo: QUAL120_STRATUM_COUNT + QUAL120_NEGATIVE_COUNT / 3,
          ui: QUAL120_STRATUM_COUNT + QUAL120_NEGATIVE_COUNT / 3,
          map: QUAL120_STRATUM_COUNT + QUAL120_NEGATIVE_COUNT / 3,
        }

  const freezeWithoutProof = {
    schema: H8A_FRESH_SCHEMA,
    freezeId,
    phaseId,
    phaseCounts: { totalCases, positiveCases, negativeCases },
    cohortCommitmentSha256: hashIdentity({ phaseId, totalCases }),
    producerClosureSha256: hashIdentity({ phaseId, producerCases }),
    sourceBytesManifestSha256: hashIdentity(producerCases.map((item) => item.sourceBytesSha256)),
    sourceStrataCommitments: strata.map((stratum) => ({
      stratum,
      caseCount: perStratumCaseCount[stratum],
      sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
        phaseId,
        stratum,
        annotationBundle.cases
          .filter((item) => item.stratum === stratum)
          .map((item) => item.sourceGroup),
      ),
    })),
    profileBindings: [
      {
        profileId: candidateIdForPhase(phaseId),
        recipeIdentitySha256: recipeIdentity(candidateIdForPhase(phaseId)),
        requestPolicyIdentitySha256:
          candidateIdForPhase(phaseId) === PROFILE_FLAT_CANDIDATE_ID
            ? H8A_FLAT_CANDIDATE_PROFILE.requestPolicyIdentitySha256
            : H8A_CANDIDATE_PROFILE.requestPolicyIdentitySha256,
      },
      {
        profileId: PROFILE_CONTROL_ID,
        recipeIdentitySha256: recipeIdentity(PROFILE_CONTROL_ID),
        requestPolicyIdentitySha256: V02_CONTROL_PROFILE.requestPolicyIdentitySha256,
      },
    ] as PhaseFreeze['profileBindings'],
    pairedSchedule,
    producerCases,
    qualificationIndependentMaskCaseIds: annotationBundle.independentMaskCaseIds,
    callLimits: {
      candidateMaxPhysicalCallsPerCase: 4,
      controlMaxPhysicalCallsPerCase: 6,
      phaseWorstCasePhysicalCalls:
        phaseId === PHASE_DEV40_ID || phaseId === PHASE_FLAT_DEV40_ID ? 400 : 1200,
    },
    nativeLimits: {
      avoidConcurrentOwnedNativeWork: true as const,
      maxPendingNativeJobs: 2,
      maxNativeWorkerThreads: 2,
    },
    deadlineIso: '2030-01-01T00:00:00.000Z',
    timeoutRetryPolicy: {
      absoluteCaseTimeoutSeconds: 240,
      allowFallbacks: false as const,
      allowRetries: false as const,
      sharedAbsoluteTimeoutMs: 240_000,
    },
    outputRowSchemaId: 'h8a-fresh-output-row-v1' as const,
    evaluatorVersion: 'h8a-fresh-evaluator-v1' as const,
    conservativeCostProof: buildConservativeCostProof(0.005, {
      candidateProfileId: candidateIdForPhase(phaseId),
    }),
    enforceQualificationSourceGroupSeparation:
      phaseId === PHASE_QUAL120_ID || phaseId === PHASE_FLAT_QUAL120_ID,
    evaluatorAnnotationsSha256,
  }
  const freeze = phaseFreezeSchema.parse(freezeWithoutProof)
  const sourceBytesByCaseId = new Map<string, Uint8Array>()
  for (let index = 0; index < producerCases.length; index++) {
    const stratum = pairedSchedule[index]!.stratum
    const opaqueCaseId = producerCases[index]!.opaqueCaseId
    sourceBytesByCaseId.set(opaqueCaseId, new Uint8Array([index + 1, stratum.length, 0]))
  }
  return { freeze, sourceBytesByCaseId }
}

export function buildOutputRow(
  opaqueCaseId: string,
  profileId:
    | typeof PROFILE_CANDIDATE_ID
    | typeof PROFILE_FLAT_CANDIDATE_ID
    | typeof PROFILE_CONTROL_ID,
  overrides?: Partial<OutputRow>,
): OutputRow {
  return {
    schema: 'h8a-fresh-output-row-v1',
    opaqueCaseId,
    profileId,
    executionValidity: 'valid',
    caseState: 'not_found',
    box: null,
    cutoutPresent: false,
    maskPackedSha256: null,
    logicalReceiptIds: [1],
    physicalReceiptIds: [],
    ...overrides,
  }
}

export function buildCloseout(
  freeze: PhaseFreeze,
  profileId:
    | typeof PROFILE_CANDIDATE_ID
    | typeof PROFILE_FLAT_CANDIDATE_ID
    | typeof PROFILE_CONTROL_ID,
  rows: OutputRow[],
): ImmutableCloseout {
  const binding = freeze.profileBindings.find((item) => item.profileId === profileId)
  if (!binding) throw new RangeError('Missing profile binding for closeout fixture')
  const outputRows = rows.map((row, index) => ({
    ...row,
    logicalReceiptIds: [index + 1],
  }))
  const physicalReceipts: ImmutableCloseout['physicalReceipts'] = rows.flatMap((row, rowIndex) =>
    row.physicalReceiptIds.map((receiptId) => ({
      receiptId,
      physicalId: receiptId,
      logicalId: rowIndex + 1,
      dispatchState: 'confirmed' as const,
      settled: true,
      costUsd: 0.001,
      chargeState: 'known' as const,
    })),
  )
  const body = {
    schema: 'h8a-fresh-immutable-closeout-v1' as const,
    freezeId: freeze.freezeId,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
    phaseId: freeze.phaseId,
    profileId,
    closedAtIso: '2030-01-01T00:00:00.000Z',
    cohortCommitmentSha256: freeze.cohortCommitmentSha256,
    producerClosureSha256: freeze.producerClosureSha256,
    recipeIdentitySha256: binding.recipeIdentitySha256,
    requestPolicyIdentitySha256: binding.requestPolicyIdentitySha256,
    outputRows,
    logicalReceipts: outputRows.map((row, index) => ({
      logicalId: index + 1,
      opaqueCaseId: row.opaqueCaseId,
      profileId,
      requestSha256: hashIdentity({ row: row.opaqueCaseId, profileId }),
      physicalIds: row.physicalReceiptIds,
      outcome: 'resolved' as const,
    })),
    physicalReceipts,
    logicalAttemptCount: rows.length,
    physicalDispatchCount: physicalReceipts.filter((item) => item.dispatchState === 'confirmed')
      .length,
    uncertainDispatchCount: physicalReceipts.filter((item) => item.dispatchState === 'uncertain')
      .length,
    closeoutSha256: '0000000000000000000000000000000000000000000000000000000000000000',
  }
  const closeoutSha256 = hashIdentity({
    freezeId: body.freezeId,
    freezeCommitmentSha256: body.freezeCommitmentSha256,
    phaseId: body.phaseId,
    profileId: body.profileId,
    closedAtIso: body.closedAtIso,
    cohortCommitmentSha256: body.cohortCommitmentSha256,
    producerClosureSha256: body.producerClosureSha256,
    recipeIdentitySha256: body.recipeIdentitySha256,
    requestPolicyIdentitySha256: body.requestPolicyIdentitySha256,
    outputRows: body.outputRows,
    logicalReceipts: body.logicalReceipts,
    physicalReceipts: body.physicalReceipts,
    logicalAttemptCount: body.logicalAttemptCount,
    physicalDispatchCount: body.physicalDispatchCount,
    uncertainDispatchCount: body.uncertainDispatchCount,
  })
  return { ...body, closeoutSha256 }
}

export function buildDev40Annotations(freeze: PhaseFreeze): EvaluatorPrivateAnnotationBundle {
  return buildSyntheticAnnotationBundle(
    freeze.phaseId,
    freeze.freezeId,
    freeze.producerCases,
    freeze.pairedSchedule,
  )
}
