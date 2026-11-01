import { z } from 'zod'
import {
  CAMPAIGN_MAX_COST_USD,
  CAMPAIGN_MAX_PHYSICAL_CALLS,
  DEV40_CASE_COUNT,
  DEV40_NEGATIVE_COUNT,
  DEV40_POSITIVE_COUNT,
  DEV40_STRATUM_QUOTAS,
  EVALUATOR_VERSION,
  H8A_FRESH_SCHEMA,
  PHASE_DEV40_ID,
  PHASE_FLAT_DEV40_ID,
  PHASE_FLAT_QUAL120_ID,
  PHASE_SCOPE_DEV40_ID,
  PHASE_SCOPE_QUAL120_ID,
  PHASE_QUAL120_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  QUAL120_CASE_COUNT,
  QUAL120_NEGATIVE_COUNT,
  QUAL120_POSITIVE_COUNT,
  QUAL120_STRATUM_COUNT,
  STRATUMS,
  candidateIdForPhase,
} from './constants.js'
import { providerRefusalReplayExecutionPolicySchema } from './provider-refusal-replay.js'
import { providerRefusalReplayEvidenceSchema } from './provider-refusal-replay.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u)

const profileDispatchUpperBoundSchema = z
  .object({
    profileId: z.enum([
      PROFILE_CANDIDATE_ID,
      PROFILE_FLAT_CANDIDATE_ID,
      PROFILE_SCOPE_CANDIDATE_ID,
      PROFILE_CONTROL_ID,
    ]),
    maxUsdPerPhysicalDispatch: z.number().finite().positive(),
  })
  .strict()

const conservativeCostProofSchema = z
  .object({
    schema: z.literal('h8a-fresh-conservative-cost-proof-v1'),
    proofKind: z.literal('audited-upper-bound'),
    maxUsdPerPhysicalDispatch: z.number().finite().positive(),
    profileDispatchUpperBounds: z.tuple([
      z.union([
        profileDispatchUpperBoundSchema.extend({ profileId: z.literal(PROFILE_CANDIDATE_ID) }),
        profileDispatchUpperBoundSchema.extend({ profileId: z.literal(PROFILE_FLAT_CANDIDATE_ID) }),
        profileDispatchUpperBoundSchema.extend({
          profileId: z.literal(PROFILE_SCOPE_CANDIDATE_ID),
        }),
      ]),
      profileDispatchUpperBoundSchema.extend({ profileId: z.literal(PROFILE_CONTROL_ID) }),
    ]),
    derivedFrom: z.string().min(1),
    proofSha256: sha256Hex,
  })
  .strict()

const profileBindingSchema = z
  .object({
    profileId: z.enum([
      PROFILE_CANDIDATE_ID,
      PROFILE_FLAT_CANDIDATE_ID,
      PROFILE_SCOPE_CANDIDATE_ID,
      PROFILE_CONTROL_ID,
    ]),
    recipeIdentitySha256: sha256Hex,
    requestPolicyIdentitySha256: sha256Hex,
  })
  .strict()

const phaseCountsSchema = z
  .object({
    totalCases: z.number().int().positive(),
    positiveCases: z.number().int().nonnegative(),
    negativeCases: z.number().int().nonnegative(),
  })
  .strict()

const nativeLimitsSchema = z
  .object({
    avoidConcurrentOwnedNativeWork: z.literal(true),
    maxPendingNativeJobs: z.number().int().nonnegative(),
    maxNativeWorkerThreads: z.number().int().nonnegative(),
  })
  .strict()

const timeoutRetryPolicySchema = z
  .object({
    absoluteCaseTimeoutSeconds: z.number().int().positive(),
    allowFallbacks: z.literal(false),
    allowRetries: z.literal(false),
    sharedAbsoluteTimeoutMs: z.number().int().positive(),
  })
  .strict()

const sourceStrataCommitmentSchema = z
  .object({
    stratum: z.enum(STRATUMS),
    caseCount: z.number().int().positive(),
    sourceGroupCommitmentSha256: sha256Hex,
  })
  .strict()

const producerCaseRowSchema = z
  .object({
    opaqueCaseId: z.string().min(1),
    sourceBytesSha256: sha256Hex,
    sourceCanvasWidth: z.number().int().positive(),
    sourceCanvasHeight: z.number().int().positive(),
    targetTaskText: z.string().min(1),
  })
  .strict()

const pairedScheduleRowSchema = z
  .object({
    opaqueCaseId: z.string().min(1),
    stratum: z.enum(STRATUMS),
    candidateArmFirst: z.boolean(),
  })
  .strict()

export const phaseFreezeSchema = z
  .object({
    schema: z.literal(H8A_FRESH_SCHEMA),
    freezeId: z.string().min(1),
    phaseId: z.enum([
      PHASE_DEV40_ID,
      PHASE_QUAL120_ID,
      PHASE_FLAT_DEV40_ID,
      PHASE_FLAT_QUAL120_ID,
      PHASE_SCOPE_DEV40_ID,
      PHASE_SCOPE_QUAL120_ID,
    ]),
    phaseCounts: phaseCountsSchema,
    cohortCommitmentSha256: sha256Hex,
    producerClosureSha256: sha256Hex,
    sourceBytesManifestSha256: sha256Hex,
    sourceStrataCommitments: z.array(sourceStrataCommitmentSchema),
    profileBindings: z.tuple([
      z.union([
        profileBindingSchema.extend({ profileId: z.literal(PROFILE_CANDIDATE_ID) }),
        profileBindingSchema.extend({ profileId: z.literal(PROFILE_FLAT_CANDIDATE_ID) }),
        profileBindingSchema.extend({ profileId: z.literal(PROFILE_SCOPE_CANDIDATE_ID) }),
      ]),
      profileBindingSchema.extend({ profileId: z.literal(PROFILE_CONTROL_ID) }),
    ]),
    pairedSchedule: z.array(pairedScheduleRowSchema),
    producerCases: z.array(producerCaseRowSchema),
    qualificationIndependentMaskCaseIds: z.array(z.string().min(1)),
    callLimits: z
      .object({
        candidateMaxPhysicalCallsPerCase: z.number().int().positive(),
        controlMaxPhysicalCallsPerCase: z.number().int().positive(),
        phaseWorstCasePhysicalCalls: z.number().int().positive(),
      })
      .strict(),
    nativeLimits: nativeLimitsSchema,
    deadlineIso: z.string().datetime(),
    timeoutRetryPolicy: timeoutRetryPolicySchema,
    outputRowSchemaId: z.literal('h8a-fresh-output-row-v1'),
    evaluatorVersion: z.literal(EVALUATOR_VERSION),
    conservativeCostProof: conservativeCostProofSchema,
    enforceQualificationSourceGroupSeparation: z.boolean(),
    evaluatorAnnotationsSha256: sha256Hex,
    executionPolicy: providerRefusalReplayExecutionPolicySchema.optional(),
  })
  .strict()
  .superRefine((freeze, context) => {
    const expectedStratumCounts =
      freeze.phaseId === PHASE_DEV40_ID ||
      freeze.phaseId === PHASE_FLAT_DEV40_ID ||
      freeze.phaseId === PHASE_SCOPE_DEV40_ID
        ? {
            photo: DEV40_STRATUM_QUOTAS.photo.total,
            ui: DEV40_STRATUM_QUOTAS.ui.total,
            map: DEV40_STRATUM_QUOTAS.map.total,
          }
        : {
            photo: QUAL120_STRATUM_COUNT + QUAL120_NEGATIVE_COUNT / STRATUMS.length,
            ui: QUAL120_STRATUM_COUNT + QUAL120_NEGATIVE_COUNT / STRATUMS.length,
            map: QUAL120_STRATUM_COUNT + QUAL120_NEGATIVE_COUNT / STRATUMS.length,
          }
    if (freeze.sourceStrataCommitments.length !== STRATUMS.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Freeze must commit exactly one row for each stratum',
      })
    for (const stratum of STRATUMS) {
      const rows = freeze.sourceStrataCommitments.filter((item) => item.stratum === stratum)
      if (rows.length !== 1 || rows[0]?.caseCount !== expectedStratumCounts[stratum])
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Freeze stratum ${stratum} commitment count mismatch`,
        })
    }
    if (
      freeze.phaseId === PHASE_DEV40_ID ||
      freeze.phaseId === PHASE_FLAT_DEV40_ID ||
      freeze.phaseId === PHASE_SCOPE_DEV40_ID
    ) {
      if (freeze.phaseCounts.totalCases !== DEV40_CASE_COUNT)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'DEV40 case count mismatch' })
      if (freeze.phaseCounts.positiveCases !== DEV40_POSITIVE_COUNT)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'DEV40 positive count mismatch' })
      if (freeze.phaseCounts.negativeCases !== DEV40_NEGATIVE_COUNT)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'DEV40 negative count mismatch' })
      if (freeze.enforceQualificationSourceGroupSeparation)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DEV40 must not enable qualification-only source-group separation',
        })
      if (freeze.qualificationIndependentMaskCaseIds.length !== 0)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DEV40 cannot preselect qualification independent-mask cases',
        })
    }
    if (
      freeze.phaseId === PHASE_QUAL120_ID ||
      freeze.phaseId === PHASE_FLAT_QUAL120_ID ||
      freeze.phaseId === PHASE_SCOPE_QUAL120_ID
    ) {
      if (freeze.phaseCounts.totalCases !== QUAL120_CASE_COUNT)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'QUAL120 case count mismatch' })
      if (freeze.phaseCounts.positiveCases !== QUAL120_POSITIVE_COUNT)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'QUAL120 positive count mismatch',
        })
      if (freeze.phaseCounts.negativeCases !== QUAL120_NEGATIVE_COUNT)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'QUAL120 negative count mismatch',
        })
      if (!freeze.enforceQualificationSourceGroupSeparation)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'QUAL120 must enforce source-group separation',
        })
      if (freeze.qualificationIndependentMaskCaseIds.length !== 30)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'QUAL120 must preselect exactly 30 independent-mask cases',
        })
      if (
        new Set(freeze.qualificationIndependentMaskCaseIds).size !==
        freeze.qualificationIndependentMaskCaseIds.length
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'QUAL120 independent-mask case IDs must be unique',
        })
      const photoScheduleIds = new Set(
        freeze.pairedSchedule
          .filter((item) => item.stratum === 'photo')
          .map((item) => item.opaqueCaseId),
      )
      if (freeze.qualificationIndependentMaskCaseIds.some((id) => !photoScheduleIds.has(id)))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'QUAL120 independent-mask cases must be photo cases',
        })
    }
    const caseIds = freeze.producerCases.map((item) => item.opaqueCaseId)
    if (freeze.profileBindings[0]?.profileId !== candidateIdForPhase(freeze.phaseId))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Freeze candidate binding does not match its phase identity',
      })
    if (new Set(caseIds).size !== caseIds.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate producer case IDs' })
    if (freeze.pairedSchedule.length !== freeze.producerCases.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Paired schedule length mismatch' })
    const scheduleIds = freeze.pairedSchedule.map((item) => item.opaqueCaseId)
    if (scheduleIds.some((id, index) => id !== caseIds[index]))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Paired schedule case order must match producerCases order',
      })
    if (freeze.qualificationIndependentMaskCaseIds.some((id) => !caseIds.includes(id)))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Independent-mask case ID is not in producerCases',
      })
  })

export type PhaseFreeze = z.infer<typeof phaseFreezeSchema>

export const logicalReceiptSchema = z
  .object({
    logicalId: z.number().int().positive(),
    opaqueCaseId: z.string().min(1),
    profileId: z.enum([
      PROFILE_CANDIDATE_ID,
      PROFILE_FLAT_CANDIDATE_ID,
      PROFILE_SCOPE_CANDIDATE_ID,
      PROFILE_CONTROL_ID,
    ]),
    requestSha256: sha256Hex,
    physicalIds: z.array(z.number().int().positive()),
    outcome: z.enum(['resolved', 'failed', 'cancelled', 'timeout', 'unknown', 'preflight_failed']),
    errorCode: z.string().optional(),
  })
  .strict()

export const physicalReceiptSchema = z
  .object({
    receiptId: z.number().int().positive(),
    physicalId: z.number().int().positive().nullable(),
    logicalId: z.number().int().positive(),
    dispatchState: z.enum(['confirmed', 'uncertain', 'prefetch_cancelled']),
    settled: z.boolean(),
    costUsd: z.number().finite().nonnegative().nullable(),
    chargeState: z.enum(['known', 'unknown', 'reserved_prefetch_cancelled']),
  })
  .strict()

export const outputRowSchema = z
  .object({
    schema: z.literal('h8a-fresh-output-row-v1'),
    opaqueCaseId: z.string().min(1),
    profileId: z.enum([
      PROFILE_CANDIDATE_ID,
      PROFILE_FLAT_CANDIDATE_ID,
      PROFILE_SCOPE_CANDIDATE_ID,
      PROFILE_CONTROL_ID,
    ]),
    executionValidity: z.enum(['valid', 'invalid']),
    caseState: z.enum([
      'success',
      'not_found',
      'negative_clean',
      'error',
      'timeout',
      'cancelled',
      'unknown',
      'preflight_failed',
      'unstarted',
      'malformed',
    ]),
    box: z
      .object({
        left: z.number(),
        top: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .strict()
      .nullable(),
    cutoutPresent: z.boolean(),
    maskPackedSha256: sha256Hex.nullable(),
    logicalReceiptIds: z.array(z.number().int().positive()),
    physicalReceiptIds: z.array(z.number().int().positive()),
    providerRefusalEvidence: providerRefusalReplayEvidenceSchema.optional(),
  })
  .strict()

export const immutableCloseoutSchema = z
  .object({
    schema: z.literal('h8a-fresh-immutable-closeout-v1'),
    freezeId: z.string().min(1),
    freezeCommitmentSha256: sha256Hex,
    phaseId: z.enum([
      PHASE_DEV40_ID,
      PHASE_QUAL120_ID,
      PHASE_FLAT_DEV40_ID,
      PHASE_FLAT_QUAL120_ID,
      PHASE_SCOPE_DEV40_ID,
      PHASE_SCOPE_QUAL120_ID,
    ]),
    profileId: z.enum([
      PROFILE_CANDIDATE_ID,
      PROFILE_FLAT_CANDIDATE_ID,
      PROFILE_SCOPE_CANDIDATE_ID,
      PROFILE_CONTROL_ID,
    ]),
    closedAtIso: z.string().min(1),
    cohortCommitmentSha256: sha256Hex,
    producerClosureSha256: sha256Hex,
    recipeIdentitySha256: sha256Hex,
    requestPolicyIdentitySha256: sha256Hex,
    outputRows: z.array(outputRowSchema),
    logicalReceipts: z.array(logicalReceiptSchema),
    physicalReceipts: z.array(physicalReceiptSchema),
    logicalAttemptCount: z.number().int().nonnegative(),
    physicalDispatchCount: z.number().int().nonnegative(),
    uncertainDispatchCount: z.number().int().nonnegative(),
    closeoutSha256: sha256Hex,
  })
  .strict()

const evaluatorPrivateCaseAnnotationSchema = z
  .object({
    opaqueCaseId: z.string().min(1),
    stratum: z.enum(STRATUMS),
    sourceGroup: z.string().min(1),
    expectedPresence: z.enum(['present', 'absent']),
    referenceBoxes: z.array(
      z
        .object({
          left: z.number(),
          top: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .strict(),
    ),
    referenceMasks: z.array(
      z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          packedBinarySha256: sha256Hex,
        })
        .strict(),
    ),
    exactOriginalCanvasMaskRef: z.boolean(),
  })
  .strict()

export const evaluatorPrivateAnnotationBundleSchema = z
  .object({
    schema: z.literal('h8a-fresh-evaluator-private-v1'),
    phaseId: z.enum([
      PHASE_DEV40_ID,
      PHASE_QUAL120_ID,
      PHASE_FLAT_DEV40_ID,
      PHASE_FLAT_QUAL120_ID,
      PHASE_SCOPE_DEV40_ID,
      PHASE_SCOPE_QUAL120_ID,
    ]),
    freezeId: z.string().min(1),
    independentMaskCaseIds: z.array(z.string().min(1)),
    cases: z.array(evaluatorPrivateCaseAnnotationSchema),
    qualificationSourceGroupsDistinct: z.boolean().optional(),
  })
  .strict()

export const campaignLedgerSnapshotSchema = z
  .object({
    schema: z.literal('h8a-fresh-campaign-ledger-v1'),
    ledgerVersion: z.number().int().nonnegative(),
    maxPhysicalCalls: z.literal(CAMPAIGN_MAX_PHYSICAL_CALLS),
    maxCostUsd: z.literal(CAMPAIGN_MAX_COST_USD),
    nextReservationId: z.number().int().positive().optional(),
    physicalDispatchCount: z.number().int().nonnegative(),
    logicalAttemptCount: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownReserveUsd: z.number().finite().nonnegative(),
    inFlightReservations: z.array(
      z
        .object({
          reservationId: z.number().int().positive(),
          reservedUsd: z.number().finite().positive(),
          dispatchIntentRecorded: z.boolean().optional(),
          dispatched: z.boolean(),
          physicalId: z.number().int().positive().nullable().optional(),
        })
        .strict(),
    ),
    resumeBlocked: z.boolean(),
    crashRecoveryLatched: z.boolean().optional(),
  })
  .strict()

export type OutputRow = z.infer<typeof outputRowSchema>
export type ImmutableCloseout = z.infer<typeof immutableCloseoutSchema>
export type EvaluatorPrivateAnnotationBundle = z.infer<
  typeof evaluatorPrivateAnnotationBundleSchema
>
