import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, mkdir, rename, rm, writeFile, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import {
  CAMPAIGN_MAX_COST_USD,
  CAMPAIGN_MAX_PHYSICAL_CALLS,
  DEV40_CASE_COUNT,
  DEV40_NEGATIVE_COUNT,
  DEV40_POSITIVE_COUNT,
  DEV40_STRATUM_QUOTAS,
  DEV40_WORST_CASE_PHYSICAL_CALLS,
  H8A_FRESH_SCHEMA,
  PHASE_DEV40_ID,
  PHASE_FLAT_DEV40_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  STRATUMS,
  candidateIdForPhase,
} from './constants.js'
import { buildDevScreenSelection, validateDevScreenSelection } from './dev-screen-sampling.js'
import { assertReferenceBoxesWithinCanvas, assertReferenceMaskDeclaration } from './evaluator.js'
import { hashIdentity } from './hash-identity.js'
import { validateConservativeCostProof, validateProfileIdentities } from './freeze-admission.js'
import { validateSourceGroupSplitSeparation } from './source-group-validation.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import {
  assertSharpRuntimeRgbMatches,
  computeUiVisibleStateFingerprint,
  uiNativeStateProofRowsSchema,
  uiCaptureStatusSchema,
  uiCaptureLedgerSchema,
  uiSourcePixelNoveltyAuditSchema,
  validateUiStateSourcePixelPolicy,
} from './ui-state-source-policy.js'
import {
  UI_STATE_DEV40_ANCESTOR_PARENT_REGISTRATION_SHA256,
  UI_STATE_DEV40_FREEZE_ID,
  UI_STATE_DEV40_EXECUTION_V2_ID,
  UI_STATE_DEV40_HISTORICAL_EXCLUSIONS_SHA256,
  UI_STATE_DEV40_HISTORICAL_PIXELS_SHA256,
  UI_STATE_DEV40_PARENT_AUDIT_SHA256,
  UI_STATE_DEV40_PARENT_LEDGER_SHA256,
  UI_STATE_DEV40_PARENT_REGISTRATION_SHA256,
  UI_STATE_DEV40_PUBLIC_COST_BOUNDS_SHA256,
  UI_STATE_DEV40_SOURCE_ADMISSION_POLICY,
  UI_STATE_DEV40_ORDER_PROTOCOL_SHA256,
  UI_STATE_DEV40_MAP_ROSTER_SHA256,
  UI_STATE_DEV40_STUDY_ID,
  UI_STATE_DEV40_ROOT,
  UI_STATE_DEV40_WORDING_SHA256,
  UI_STATE_DEV40_CAPTURE_VIEW_SHA256,
  UI_STATE_DEV40_PRECAPTURE_STABILITY_SHA256,
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_PATH,
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
  UI_STATE_DEV40_NATIVE_STATE_PROOFS_PATH,
  UI_STATE_DEV40_NATIVE_STATE_PROOFS_SHA256,
  UI_STATE_DEV40_CAPTURE_LEDGER_SHA256,
  UI_STATE_DEV40_PIXEL_NOVELTY_AUDIT_SHA256,
  UI_STATE_DEV40_BUNDLE_RECEIPT_SHA256,
  UI_STATE_DEV40_FINGERPRINT_IMPLEMENTATION_SHA256,
  UI_STATE_DEV40_SOURCE_PROVENANCE_SHA256,
  UI_STATE_DEV40_PRESERVED_HARNESS_SHA256,
  UI_STATE_DEV40_CONTACT_SHEET_SHA256,
  UI_STATE_DEV40_PRECAPTURE_ROSTER_SHA256,
  UI_STATE_DEV40_PRECAPTURE_ROSTER_PATH,
  UI_STATE_DEV40_EXTERNAL_INPUT_PINS,
} from './ui-state-dev40-policy.js'
import {
  H8A_CANDIDATE_PROFILE,
  H8A_FLAT_CANDIDATE_PROFILE,
  V02_CONTROL_PROFILE,
} from './profiles.js'
import {
  evaluatorPrivateAnnotationBundleSchema,
  phaseFreezeSchema,
  type EvaluatorPrivateAnnotationBundle,
  type PhaseFreeze,
} from './schemas.js'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const openImagesImageId = z.string().regex(/^[a-f0-9]{16}$/u)
const artifactRefSchema = z.object({ path: z.string().min(1), sha256 }).strict()
const JSON_FILE_LIMIT_BYTES = 4 * 1024 * 1024
const SOURCE_FILE_LIMIT_BYTES = 16 * 1024 * 1024
const MASK_FILE_LIMIT_BYTES = 8 * 1024 * 1024
const SOURCE_PIXEL_LIMIT = 16_000_000
const REQUIRED_PRODUCER_CLOSURE_PATHS = [
  'package-lock.json',
  'benchmarks/v03/h8a-full/factory.ts',
  'benchmarks/v03/h8a-full/native-port.ts',
  'benchmarks/v03/h8a-full/native-recipe.json',
  'benchmarks/v03/h8a-full/native-worker.py',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/paired-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/profiles.ts',
  'benchmarks/v03/h8a-fresh-comparison/schemas.ts',
] as const

const preparationAuthoritySchema = z
  .object({
    schema: z.literal('h8a-dev-freeze-preparation-v1'),
    freezeId: z.string().min(1),
    deadlineIso: z.string().datetime({ offset: true }),
    trustedRoot: z.string().min(1),
    orderProtocol: artifactRefSchema,
    mapRoster: artifactRefSchema,
    sourceClosure: artifactRefSchema,
    sourceGroupSplit: artifactRefSchema,
    priceProof: artifactRefSchema,
    runtimeEnvironment: artifactRefSchema,
    fragments: z.array(
      z.object({ fragmentId: z.string().min(1), path: z.string().min(1), sha256 }).strict(),
    ),
  })
  .strict()

const flatPreparationAuthoritySchema = preparationAuthoritySchema.extend({
  schema: z.literal('h8a-flat-dev-freeze-preparation-v1'),
  freezeId: z.literal('h8a-flat-dev40-20261101-v1'),
  priorDevAuthority: artifactRefSchema,
})
const independentDev40PreparationAuthoritySchema = z
  .object({
    schema: z.literal('h8a-independent-dev40-v2-preparation-v1'),
    studyId: z.literal(UI_STATE_DEV40_STUDY_ID),
    freezeId: z.literal(UI_STATE_DEV40_FREEZE_ID),
    parentRegistrationSha256: z.literal(UI_STATE_DEV40_PARENT_REGISTRATION_SHA256),
    sourcePolicyId: z.literal(UI_STATE_DEV40_SOURCE_ADMISSION_POLICY),
    executionId: z.literal(UI_STATE_DEV40_EXECUTION_V2_ID).optional(),
    deadlineIso: z.string().datetime({ offset: true }),
    trustedRoot: z.string().min(1),
    orderProtocol: artifactRefSchema,
    mapRoster: artifactRefSchema,
    sourceRoster: artifactRefSchema,
    sourceGroupSplit: artifactRefSchema,
    sourceClosure: artifactRefSchema,
    priceProof: artifactRefSchema,
    runtimeEnvironment: artifactRefSchema,
    parentRegistration: artifactRefSchema,
    parentLedgerAudit: artifactRefSchema,
    historicalExclusions: artifactRefSchema,
    historicalPixels: artifactRefSchema,
    sourceUnionAudit: artifactRefSchema,
    sourceStateProof: artifactRefSchema,
    nativeUiEvidence: z
      .object({
        captureLedger: artifactRefSchema,
        pixelNoveltyAudit: artifactRefSchema,
        bundleReceipt: artifactRefSchema,
        fingerprintImplementation: artifactRefSchema,
        sourceProvenance: artifactRefSchema,
        preservedHarnessAttempts: artifactRefSchema,
        sourceReviewContactSheet: artifactRefSchema,
      })
      .strict(),
    registeredSources: artifactRefSchema,
    fragments: z.array(
      z.object({ fragmentId: z.string().min(1), path: z.string().min(1), sha256 }).strict(),
    ),
  })
  .strict()
const DISJOINT_FREEZE_ID = 'h8a-flat-disjoint-dev40-20261101-v1'
const PINNED_PARENT_REGISTRATION_SHA256 =
  '5c63045a648928c9aefe12aad99464e8394b3bc42c133b39821036eb74f3bff0'
const PINNED_ACCEPTED_HISTORY_SHA256 =
  '8743d618233e84025463dbfd6f51c580388e9e053a716fbed0ff76afb9c215f4'
interface DisjointLineagePins {
  parentRegistrationSha256: string
  acceptedHistorySha256: string
}

function createDisjointPreparationAuthoritySchema(pins: DisjointLineagePins) {
  return preparationAuthoritySchema.extend({
    schema: z.literal('h8a-disjoint-dev-freeze-preparation-v1'),
    freezeId: z.literal(DISJOINT_FREEZE_ID),
    parentRegistration: artifactRefSchema.extend({
      sha256: z.literal(pins.parentRegistrationSha256),
    }),
    acceptedHistory: artifactRefSchema.extend({
      sha256: z.literal(pins.acceptedHistorySha256),
    }),
    registeredSources: artifactRefSchema,
  })
}
const PINNED_PRIOR_DEV_AUTHORITY_SHA256 =
  '0d5cc47d1759d2e276cdc3e0c44b7ef231c61cc49aa75a7cc62e9bec24bfafd2'
const INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256 = UI_STATE_DEV40_PARENT_REGISTRATION_SHA256
const INDEPENDENT_DEV40_ANCESTOR_PARENT_REGISTRATION_SHA256 =
  UI_STATE_DEV40_ANCESTOR_PARENT_REGISTRATION_SHA256
const INDEPENDENT_DEV40_PARENT_LEDGER_SHA256 = UI_STATE_DEV40_PARENT_LEDGER_SHA256
const INDEPENDENT_DEV40_COST_PROOF_SHA256 = UI_STATE_DEV40_PUBLIC_COST_BOUNDS_SHA256
const INDEPENDENT_DEV40_PARENT_AUDIT_SHA256 = UI_STATE_DEV40_PARENT_AUDIT_SHA256
const INDEPENDENT_DEV40_HISTORICAL_EXCLUSIONS_SHA256 = UI_STATE_DEV40_HISTORICAL_EXCLUSIONS_SHA256
const INDEPENDENT_DEV40_HISTORICAL_PIXELS_SHA256 = UI_STATE_DEV40_HISTORICAL_PIXELS_SHA256
const INDEPENDENT_DEV40_ORDER_PROTOCOL_SHA256 = UI_STATE_DEV40_ORDER_PROTOCOL_SHA256
const INDEPENDENT_DEV40_MAP_ROSTER_SHA256 = UI_STATE_DEV40_MAP_ROSTER_SHA256
const INDEPENDENT_DEV40_STUDY_ID = UI_STATE_DEV40_STUDY_ID

const independentSourceRosterSchema = z
  .object({
    schema: z.literal('h8a-independent-dev40-source-roster-v1'),
    studyId: z.literal(UI_STATE_DEV40_STUDY_ID),
    rows: z
      .array(
        z
          .object({
            opaqueCaseId: z.string().min(1),
            familySlug: z.string().min(1),
            predeclaredStateId: z.string().min(1),
            stratum: z.enum(STRATUMS),
            sourceGroup: z.string().min(1),
            expectedPresence: z.enum(['present', 'absent']),
            sourceSha256: sha256,
            targetTaskSha256: sha256,
          })
          .strict(),
      )
      .length(DEV40_CASE_COUNT),
  })
  .strict()

const independentUiPreCaptureRosterSchema = z
  .object({
    schema: z.literal('original-h8a-independent-dev40-v2-ui-preregistered-roster-v1'),
    parentRegistrationSha256: z.literal(INDEPENDENT_DEV40_ANCESTOR_PARENT_REGISTRATION_SHA256),
    historicalPixelRegistrySha256: z.literal(INDEPENDENT_DEV40_HISTORICAL_PIXELS_SHA256),
    rows: z
      .array(
        z
          .object({
            opaqueCaseId: z.string().min(1),
            order: z.number().int().min(1).max(10),
            sourceGroup: z.enum(['gthumb', 'file-roller']),
            application: z.string().min(1),
            applicationVersion: z.string().min(1),
            stateId: z.string().min(1),
            source: z.union([
              z
                .object({
                  kind: z.literal('directory'),
                  path: z.string().min(1),
                  assets: z.record(z.string(), sha256),
                })
                .passthrough(),
              z
                .object({
                  kind: z.enum(['image', 'archive']),
                  path: z.string().min(1),
                  sha256,
                })
                .passthrough(),
            ]),
            expectedPresence: z.enum(['present', 'absent']),
            targetQuery: z.object({ role: z.string(), name: z.string() }).passthrough(),
            preCaptureOracle: z
              .object({
                inventoryComplete: z.literal(true),
                queryMatchCount: z.number().int().nonnegative(),
                bounds: z
                  .object({
                    x: z.number().int(),
                    y: z.number().int(),
                    width: z.number().int().nonnegative(),
                    height: z.number().int().nonnegative(),
                  })
                  .strict()
                  .nullable(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .length(10),
  })
  .passthrough()

const independentUiSourceProvenanceSchema = z.record(
  z.string().min(1),
  z
    .object({
      opaqueCaseId: z.string().min(1),
      sourceGroup: z.enum(['gthumb', 'file-roller']),
      sourceStateId: z.string().min(1),
      sourceContentSha256ByBasename: z.record(z.string(), sha256),
      application: z.string().min(1),
      applicationVersion: z.string().min(1),
      targetRole: z.string().min(1),
      targetName: z.string(),
      targetAccessibleMatchCount: z.number().int().nonnegative(),
      capturePath: z.string().min(1),
      captureSha256: sha256,
      captureRgbSha256: sha256,
      nativeStateFingerprintSha256: sha256,
      captureView: z.literal(
        'whole 1280x1024 Xvfb root drawable at original coordinates; no crop/scale/overlay/pointer drawing',
      ),
      preCaptureStabilitySha256: z.literal(UI_STATE_DEV40_PRECAPTURE_STABILITY_SHA256),
      captureLogPath: z.string().min(1),
      captureLogSha256: sha256,
      captureStderrPath: z.string().min(1),
      captureStderrSha256: sha256,
    })
    .passthrough(),
)

export function validateIndependentDev40SourceRoster(
  value: unknown,
): z.infer<typeof independentSourceRosterSchema> {
  return independentSourceRosterSchema.parse(value)
}

const independentRegisteredSourcesSchema = z
  .object({
    schema: z.literal('h8a-ui-state-dev40-source-registration-v1'),
    parentRegistrationSha256: z.literal(INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256),
    orderProtocolSha256: z.literal(INDEPENDENT_DEV40_ORDER_PROTOCOL_SHA256),
    mapRosterSha256: z.literal(INDEPENDENT_DEV40_MAP_ROSTER_SHA256),
    sourceRosterSha256: sha256,
    sourceGroupSplitSha256: sha256,
    sourceStateProofSha256: sha256,
    sourceEvidence: z.array(artifactRefSchema).min(1),
    rows: z
      .array(
        z
          .object({
            opaqueCaseId: z.string().min(1),
            familySlug: z.string().min(1),
            predeclaredStateId: z.string().min(1),
            stratum: z.enum(STRATUMS),
            sourceGroup: z.string().min(1),
            expectedPresence: z.enum(['present', 'absent']),
            sourceSha256: sha256,
            targetTaskSha256: sha256,
          })
          .strict(),
      )
      .length(DEV40_CASE_COUNT),
  })
  .strict()

const independentParentRegistrationSchema = z
  .object({
    schema: z.literal('h8a-ui-native-state-dev40-registration-v1'),
    studyId: z.literal(UI_STATE_DEV40_STUDY_ID),
    freezeId: z.literal(UI_STATE_DEV40_FREEZE_ID),
    ownerDollarCeiling: z.null(),
    sourceAdmissionPolicy: z
      .object({
        id: z.literal(UI_STATE_DEV40_SOURCE_ADMISSION_POLICY),
        exactEncodedDuplicates: z.literal('reject'),
        exactDecodedRgbDuplicates: z.literal('reject'),
        photoAndMapNearHashMaxInclusiveRejected: z.literal(4),
        uiNearHash: z.literal('record-diagnostic'),
        uiStateProofRequired: z.literal(true),
        uiStateFingerprint: z.literal(
          'sha256-json-visible-showing-ordered-native-tree-role-name-bounds-states-and-window-stack-v1',
        ),
        uiExcludeDynamicFingerprintFields: z.tuple([
          z.literal('pid'),
          z.literal('environment'),
          z.literal('capturePath'),
          z.literal('opaqueCaseId'),
          z.literal('targetQuery'),
          z.literal('expectedPresence'),
        ]),
        uiSameVisibleState: z.literal('reject'),
        uiDifferentTaskAlone: z.literal('insufficient'),
        uiRequiredProofs: z.tuple([
          z.literal('complete-native-inventory'),
          z.literal('same-state-pre-and-post-capture'),
          z.literal('unique-visible-state-fingerprint'),
          z.literal('source-app-version-and-input-shas'),
          z.literal('target-role-name-uniqueness-or-complete-absence'),
          z.literal('original-screen-transform'),
          z.literal('actual-source-pixel-review'),
        ]),
        uiRecapture: z.literal(
          'same-predeclared-ten-states-fixed-content-no-substitution-env-whitelist-repair',
        ),
      })
      .strict(),
    parentFiles: z.record(z.string(), sha256),
  })
  .passthrough()

const independentParentAuditSchema = z
  .object({
    immutableFilesVerified: z.literal(739),
    parentLedgerSha256: z.literal(INDEPENDENT_DEV40_PARENT_LEDGER_SHA256),
    historicalPixelIdentities: z.literal(348),
    scopes: z.array(z.unknown()).length(3),
    priorCharges: z.record(z.string(), z.unknown()),
  })
  .strict()

const independentHistoricalExclusionsSchema = z
  .object({
    parentRegistrationSha256: z.literal(INDEPENDENT_DEV40_ANCESTOR_PARENT_REGISTRATION_SHA256),
    sources: z.record(z.string(), sha256),
    caseIds: z.array(z.string().min(1)).length(226),
    imageIds: z.array(openImagesImageId).length(423),
    sourceGroups: z.array(z.string().min(1)).length(440),
    priorFileSha256: z.literal(INDEPENDENT_DEV40_HISTORICAL_PIXELS_SHA256),
    unrolledRawLedgerUnionSha256: sha256,
  })
  .strict()

const independentHistoricalPixelsSchema = z
  .object({
    schema: z.literal('study2-prior-pixel-exclusion-index-v1'),
    algorithm: z.string().min(1),
    sha256Implementation: sha256,
    maximumDistanceRejected: z.literal(4),
    rows: z
      .array(
        z
          .object({
            encodedSha256: sha256,
            decodedRgbSha256: sha256,
            perceptualHash64: z.string().regex(/^[a-f0-9]{16}$/u),
          })
          .strict(),
      )
      .length(348),
  })
  .strict()

const independentSourceUnionAuditSchema = z
  .object({
    schema: z.literal('h8a-ui-state-dev40-source-union-audit-v1'),
    parentRegistrationSha256: z.literal(INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256),
    historicalPixelsSha256: z.literal(INDEPENDENT_DEV40_HISTORICAL_PIXELS_SHA256),
    decodedRgbContract: z.literal(
      'pillow-rgb-canonical-identity-and-sharp-srgb-runtime-decoder-v1',
    ),
    algorithm: z.string().min(1),
    sha256Implementation: sha256,
    nearestHammingContract: z.literal(
      'minimum diagnostic distance to all 348 historical and other 39 study source pHashes; reject at <=4 only for photo/map',
    ),
    rows: z
      .array(
        z
          .object({
            opaqueCaseId: z.string().min(1),
            stratum: z.enum(STRATUMS),
            encodedSha256: sha256,
            decodedRgbSha256: sha256,
            sharpRuntimeDecodedRgbSha256: sha256,
            perceptualHash64: z.string().regex(/^[a-f0-9]{16}$/u),
            nearestHamming: z.number().int().min(0).max(64),
          })
          .strict(),
      )
      .length(DEV40_CASE_COUNT),
  })
  .strict()

const reviewedFragmentSchema = z
  .object({
    schema: z.literal('h8a-dev-reviewed-fragment-v1'),
    fragmentId: z.string().min(1),
    producerRows: artifactRefSchema,
    annotations: artifactRefSchema,
    controllerPathIndex: artifactRefSchema,
    provenance: artifactRefSchema,
    fragmentReceipt: artifactRefSchema,
    referenceMasks: z.array(artifactRefSchema),
    reviewReceipts: z.array(artifactRefSchema).min(1),
    rows: z.array(
      z
        .object({
          opaqueCaseId: z.string().min(1),
          fragmentId: z.string().min(1),
          accepted: z.literal(true),
          sourceSha256: sha256,
          annotationSha256: sha256,
          sourceGroup: z.string().min(1),
          provenanceSha256: sha256,
          reviewReceiptSha256: sha256,
        })
        .strict(),
    ),
  })
  .strict()

const sourceClosureSchema = z
  .object({
    schema: z.literal('h8a-producer-closure-files-v1'),
    sourceCommit: z.string().min(1),
    files: z
      .array(
        z
          .object({ path: z.string().min(1), sha256, bytes: z.number().int().nonnegative() })
          .strict(),
      )
      .min(1),
  })
  .strict()

const priceEntrySchema = z
  .object({
    profileId: z.enum([PROFILE_CANDIDATE_ID, PROFILE_FLAT_CANDIDATE_ID, PROFILE_CONTROL_ID]),
    model: z.string().min(1),
    rawCatalog: artifactRefSchema,
    inputTokenBound: z.number().finite().positive(),
    maxOutputTokens: z.number().int().nonnegative(),
    inputRateUpperUsd: z.number().finite().nonnegative(),
    outputRateUpperUsd: z.number().finite().nonnegative(),
    computedWorstUsd: z.number().finite().positive(),
    maxUsdPerPhysicalDispatch: z.number().finite().positive(),
  })
  .strict()

const priceProofSchema = z
  .object({
    schema: z.literal('h8a-public-price-proof-v2'),
    observedUtc: z.string().datetime({ offset: true }),
    maxCostUsd: z.literal(CAMPAIGN_MAX_COST_USD),
    maxPhysicalCalls: z.literal(CAMPAIGN_MAX_PHYSICAL_CALLS),
    entries: z.tuple([priceEntrySchema, priceEntrySchema]),
  })
  .strict()

const independentPriceProofSchema = z
  .object({
    registeredStudySha256: z.literal(INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256),
    observedUtc: z.string().datetime({ offset: true }),
    ownerDollarCeiling: z.null(),
    physicalCallLimit: z.literal(CAMPAIGN_MAX_PHYSICAL_CALLS),
    perCaseTechnicalExposureUsd: z.literal('2.92'),
    devMaximumIncrementalExposureUsd: z.literal('116.80'),
    conditionalQualMaximumIncrementalExposureUsd: z.literal('350.40'),
    entries: z.tuple([priceEntrySchema, priceEntrySchema]),
  })
  .strict()

const runtimeEnvironmentSchema = z
  .object({
    schema: z.literal('fresh-dev-pre-dispatch-runtime-inputs-v1'),
    status: z.literal('preflight-not-a-code-or-corpus-freeze'),
    freshDevInferenceRequests: z.literal(0),
    recordedUtc: z.string().datetime({ offset: true }),
    h8NativeRecipeFileSha256: sha256,
    node: z.object({ packageLockSha256: sha256 }).passthrough(),
    concurrency: z
      .object({
        candidateTorchIntraOp: z.literal(8),
        candidateTorchInterOp: z.literal(1),
        candidateBLASOpenMP: z.literal(1),
        mobileSamOnnxCpuThreads: z.literal(2),
        maxPending: z.literal(2),
        nativeArmsActiveAtOnce: z.literal(1),
      })
      .passthrough(),
    assets: z
      .array(
        z
          .object({
            family: z.string().min(1),
            relative: z.string().min(1),
            bytes: z.number().int().positive(),
            sha256,
          })
          .strict(),
      )
      .length(18),
  })
  .passthrough()

const normalizeSourceGroup = (value: string): string => value.replace(/\/+$/u, '')

function sameDigestMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  )
}

interface FragmentRows {
  producerRows: z.infer<typeof producerRowsSchema>
  annotations: z.infer<typeof privateAnnotationRowsSchema>
  annotationDigests: ReadonlyMap<string, string>
  rawAnnotationRows: ReadonlyMap<string, unknown>
  controllerPathIndex: Record<string, string>
  provenance: Record<string, unknown>
  provenanceDigests: ReadonlyMap<string, string>
  review: z.infer<typeof reviewedFragmentSchema>
}

const producerRowsSchema = z.array(
  z
    .object({
      opaqueCaseId: z.string().min(1),
      sourceBytesSha256: sha256,
      sourceCanvasWidth: z.number().int().positive(),
      sourceCanvasHeight: z.number().int().positive(),
      targetTaskText: z.string().min(1),
    })
    .strict(),
)

const privateAnnotationRowsSchema = z.array(
  z
    .object({
      opaqueCaseId: z.string().min(1),
      stratum: z.enum(STRATUMS),
      sourceGroup: z.string().min(1),
      expectedPresence: z.enum(['present', 'absent']),
      referenceBoxes: z.array(
        z
          .object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() })
          .strict(),
      ),
      referenceMasks: z.array(
        z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            packedBinarySha256: sha256,
          })
          .strict(),
      ),
      exactOriginalCanvasMaskRef: z.boolean(),
    })
    .strict(),
)

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  trustedRoot?: string,
): Promise<Buffer> {
  const expectedPath = resolve(path)
  const actualPath = await realpath(expectedPath)
  if (actualPath !== expectedPath)
    throw new RangeError('Symlinked or aliased input path is not permitted')
  if (trustedRoot && !isWithin(resolve(trustedRoot), actualPath))
    throw new RangeError('Input file escapes its trusted root')
  const beforePath = await lstat(expectedPath)
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > maxBytes)
    throw new RangeError('Input must be a bounded regular file')
  const handle = await open(expectedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new RangeError('Opened input is not a bounded regular file')
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const actualPathAfterRead = await realpath(expectedPath)
    const pathStatAfterRead = await lstat(expectedPath)
    if (
      bytes.byteLength !== Number(before.size) ||
      actualPathAfterRead !== expectedPath ||
      BigInt(beforePath.dev) !== before.dev ||
      BigInt(beforePath.ino) !== before.ino ||
      BigInt(pathStatAfterRead.dev) !== after.dev ||
      BigInt(pathStatAfterRead.ino) !== after.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new RangeError('Input changed while it was being verified')
    return bytes
  } finally {
    await handle.close()
  }
}

function resolveArtifact(root: string, path: string): string {
  const base = resolve(root)
  const full = resolve(base, path)
  if (!isWithin(base, full)) throw new RangeError('Artifact path escapes trustedRoot')
  return full
}

function artifactRefFromAbsolutePath(
  root: string,
  absolutePath: string,
  sha256Value: string,
): z.infer<typeof artifactRefSchema> {
  if (!isAbsolute(absolutePath)) throw new RangeError('Evidence path must be absolute')
  const full = resolve(absolutePath)
  const rel = relative(resolve(root), full)
  if (
    !isWithin(resolve(root), full) ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    resolve(root, rel) !== full
  )
    throw new RangeError('Evidence path escapes its pinned artifact root')
  return artifactRefSchema.parse({ path: rel, sha256: sha256Value })
}

async function readPinnedJson<T>(
  root: string,
  ref: z.infer<typeof artifactRefSchema>,
  schema: z.ZodType<T>,
): Promise<{ value: T; raw: Buffer; path: string }> {
  const path = resolveArtifact(root, ref.path)
  const raw = await readBoundedRegularFile(path, JSON_FILE_LIMIT_BYTES, root)
  if (digestBytes(raw) !== ref.sha256)
    throw new RangeError(`Pinned artifact digest mismatch: ${ref.path}`)
  return { value: schema.parse(JSON.parse(raw.toString('utf8'))), raw, path }
}

async function readPinnedBytes(
  root: string,
  ref: z.infer<typeof artifactRefSchema>,
): Promise<Buffer> {
  const limit = ref.path.endsWith('.binary-lsb0') ? MASK_FILE_LIMIT_BYTES : JSON_FILE_LIMIT_BYTES
  const bytes = await readBoundedRegularFile(resolveArtifact(root, ref.path), limit, root)
  if (digestBytes(bytes) !== ref.sha256)
    throw new RangeError(`Pinned artifact digest mismatch: ${ref.path}`)
  return bytes
}

function verifyOrderProtocol(protocol: unknown): asserts protocol is {
  schema: 'h8a-fresh-paired-order-protocol-v1'
  seedHex: '76303308'
  hashAlgorithm: 'SHA-256'
  hashInput: string
} {
  const body = z
    .object({
      schema: z.literal('h8a-fresh-paired-order-protocol-v1'),
      seedHex: z.literal('76303308'),
      hashAlgorithm: z.literal('SHA-256'),
      hashInput: z.string().min(1),
      caseOrdering: z.object({
        primary: z.string(),
        tie: z.string(),
        include: z.string(),
      }),
      armFirst: z.object({
        firstBit: z.string(),
        forCase: z.string(),
        groupBy: z.literal('stratum only, no expected presence or outcome'),
      }),
    })
    .passthrough()
    .parse(protocol)
  if (
    body.caseOrdering.primary !== 'ascending hash(seedHex, case-order-v1, opaqueCaseId)' ||
    body.caseOrdering.tie !== 'ascending opaqueCaseId' ||
    body.caseOrdering.include !== 'all 40 producer rows; derive pairedSchedule in same order' ||
    body.armFirst.firstBit !==
      'integer value of final hex digit of hash(seedHex, first-arm-v1, stratum) modulo 2' ||
    body.armFirst.forCase !==
      'candidate first iff (zero-based rank within stratum + firstBit) modulo 2 equals zero'
  )
    throw new RangeError(
      'Registered paired-order protocol differs from the supported DEV40 protocol',
    )
}

function protocolHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')
}

function expectedMapOpaqueId(seedHex: string, familySlug: string, stateId: string): string {
  return protocolHash([seedHex, 'map-id-v1', familySlug, stateId]).slice(0, 32)
}

function scheduleCases(
  producerCases: PhaseFreeze['producerCases'],
  strataById: ReadonlyMap<string, (typeof STRATUMS)[number]>,
): PhaseFreeze['pairedSchedule'] {
  const order = [...producerCases].sort((left, right) => {
    const leftHash = protocolHash(['76303308', 'case-order-v1', left.opaqueCaseId])
    const rightHash = protocolHash(['76303308', 'case-order-v1', right.opaqueCaseId])
    return leftHash.localeCompare(rightHash) || left.opaqueCaseId.localeCompare(right.opaqueCaseId)
  })
  const rankByStratum = new Map<(typeof STRATUMS)[number], number>()
  const firstBitByStratum = new Map(
    STRATUMS.map((stratum) => [
      stratum,
      Number.parseInt(protocolHash(['76303308', 'first-arm-v1', stratum]).at(-1)!, 16) % 2,
    ]),
  )
  return order.map((row) => {
    const stratum = strataById.get(row.opaqueCaseId)
    if (!stratum) throw new RangeError('Scheduled producer row has no reviewed stratum')
    const rank = rankByStratum.get(stratum) ?? 0
    rankByStratum.set(stratum, rank + 1)
    return {
      opaqueCaseId: row.opaqueCaseId,
      stratum,
      candidateArmFirst: (rank + firstBitByStratum.get(stratum)!) % 2 === 0,
    }
  })
}

async function verifySourceClosure(
  sourceRoot: string,
  rawClosure: z.infer<typeof sourceClosureSchema>,
): Promise<string> {
  const root = resolve(sourceRoot)
  if ((await realpath(root)) !== root) throw new RangeError('Symlinked sourceRoot is not permitted')
  const seen = new Set<string>()
  for (const file of rawClosure.files) {
    const path = resolve(root, file.path)
    if (!isWithin(root, path) || path === root)
      throw new RangeError('Source closure path escapes sourceRoot')
    const wireRelativePath = relative(root, path).split(sep).join('/')
    if (isAbsolute(file.path) || wireRelativePath !== file.path)
      throw new RangeError('Source closure path must be a normalized relative path')
    if (seen.has(file.path)) throw new RangeError('Duplicate source closure path')
    seen.add(file.path)
    const bytes = await readBoundedRegularFile(path, SOURCE_FILE_LIMIT_BYTES, root)
    if (bytes.length !== file.bytes || digestBytes(bytes) !== file.sha256)
      throw new RangeError(`Source closure file mismatch: ${file.path}`)
  }
  const closurePaths = new Set(rawClosure.files.map((file) => file.path))
  if (REQUIRED_PRODUCER_CLOSURE_PATHS.some((path) => !closurePaths.has(path)))
    throw new RangeError(
      'Producer source closure is missing a required native worker, entry, or policy file',
    )
  return hashIdentity(rawClosure)
}

function verifyRuntimeEnvironment(
  runtime: z.infer<typeof runtimeEnvironmentSchema>,
  closure: z.infer<typeof sourceClosureSchema>,
  variant: FreezeVariant = 'v1',
): void {
  if (new Set(runtime.assets.map((item) => item.relative)).size !== runtime.assets.length)
    throw new RangeError('Runtime input manifest contains duplicate model assets')
  const closureByPath = new Map(closure.files.map((file) => [file.path, file]))
  const nativeRecipePath =
    variant !== 'v1'
      ? 'benchmarks/v03/h8a-full/native-recipe-flat-target-v2.json'
      : 'benchmarks/v03/h8a-full/native-recipe.json'
  const nativeRecipe = closureByPath.get(nativeRecipePath)
  const packageLock = closureByPath.get('package-lock.json')
  if (!nativeRecipe || nativeRecipe.sha256 !== runtime.h8NativeRecipeFileSha256)
    throw new RangeError('Runtime H8 native recipe hash does not match the verified code closure')
  if (!packageLock || packageLock.sha256 !== runtime.node.packageLockSha256)
    throw new RangeError('Runtime package-lock hash does not match the verified code closure')
}

function assertOpenAiCatalogRates(
  raw: unknown,
  expectedModel: string,
  inputTokenBound: number,
  maxOutputTokens: number,
  inputRateUpperUsd: number,
  outputRateUpperUsd: number,
): void {
  const catalog = z
    .object({ data: z.object({ id: z.string(), endpoints: z.array(z.unknown()) }).passthrough() })
    .passthrough()
    .parse(raw)
  if (catalog.data.id !== expectedModel)
    throw new RangeError(`Raw price catalog model mismatch for ${expectedModel}`)
  const eligible = catalog.data.endpoints.flatMap((value) => {
    const endpoint = z.record(z.string(), z.unknown()).safeParse(value)
    if (!endpoint.success) return []
    const tag = z.string().safeParse(endpoint.data.tag)
    const model = z.string().safeParse(endpoint.data.model_id)
    if (
      !model.success ||
      model.data !== expectedModel ||
      !tag.success ||
      !(tag.data === 'openai' || tag.data.startsWith('openai/'))
    )
      return []
    const pricing = z.record(z.string(), z.unknown()).safeParse(endpoint.data.pricing)
    if (!pricing.success) throw new RangeError('OpenAI route is missing raw pricing')
    const contextLength = z.number().int().positive().safeParse(endpoint.data.context_length)
    if (!contextLength.success)
      throw new RangeError(`OpenAI route context is missing for ${expectedModel}`)
    const promptLimit = z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .safeParse(endpoint.data.max_prompt_tokens)
    const completionLimit = z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .safeParse(endpoint.data.max_completion_tokens)
    if (!promptLimit.success || !completionLimit.success)
      throw new RangeError(`OpenAI route token caps are malformed for ${expectedModel}`)
    const maxReachableInput = Math.min(promptLimit.data ?? contextLength.data, contextLength.data)
    const maxOutput = completionLimit.data ?? contextLength.data
    if (inputTokenBound < maxReachableInput || maxOutputTokens > maxOutput)
      throw new RangeError(
        `Frozen price envelope understates a raw OpenAI route token limit for ${expectedModel}`,
      )
    if (expectedModel === 'openai/gpt-6-luna' && maxOutputTokens !== 4096)
      throw new RangeError('Candidate output token bound differs from the frozen recipe cap')
    if (expectedModel === 'openai/gpt-6-luna-decisions' && maxOutputTokens !== 0)
      throw new RangeError('Control decision route must retain its zero generated-output budget')
    const base = pricing.data
    const rateAsNumber = (rate: unknown): number =>
      typeof rate === 'string' || typeof rate === 'number' ? Number(rate) : Number.NaN
    const numbers = [
      base.prompt,
      base.completion,
      base.input_cache_read,
      base.input_cache_write,
    ].map(rateAsNumber)
    if (numbers.some((rate) => !Number.isFinite(rate) || rate < 0))
      throw new RangeError('Raw OpenAI route has invalid token pricing')
    const overrides = Array.isArray(base.overrides) ? base.overrides : []
    for (const override of overrides) {
      const record = z.record(z.string(), z.unknown()).safeParse(override)
      if (!record.success) throw new RangeError('Raw OpenAI route override is malformed')
      const unsupportedOverrideCharge = Object.entries(record.data).some(([key, value]) => {
        if (
          [
            'min_prompt_tokens',
            'prompt',
            'completion',
            'input_cache_read',
            'input_cache_write',
            'discount',
            'web_search',
          ].includes(key)
        )
          return false
        const amount = rateAsNumber(value)
        return Number.isFinite(amount) && amount > 0
      })
      if (unsupportedOverrideCharge)
        throw new RangeError('OpenAI route override contains a positive unsupported fee')
      for (const [field, index] of [
        ['prompt', 0],
        ['completion', 1],
        ['input_cache_read', 2],
        ['input_cache_write', 3],
      ] as const) {
        if (record.data[field] !== undefined) {
          const rate = rateAsNumber(record.data[field])
          if (!Number.isFinite(rate) || rate < 0)
            throw new RangeError('Raw OpenAI route override has invalid pricing')
          numbers[index] = Math.max(numbers[index]!, rate)
        }
      }
    }
    const unsupportedPositiveCharge = Object.entries(base).some(([key, value]) => {
      // The frozen request policies provide no web-search tool, so this catalog-only optional feature is unreachable.
      if (
        [
          'prompt',
          'completion',
          'input_cache_read',
          'input_cache_write',
          'discount',
          'overrides',
          'web_search',
        ].includes(key)
      )
        return false
      const amount = rateAsNumber(value)
      return Number.isFinite(amount) && amount > 0
    })
    if (unsupportedPositiveCharge)
      throw new RangeError('Raw OpenAI route contains a positive unsupported fee')
    return [numbers]
  })
  if (eligible.length === 0)
    throw new RangeError(`Raw price catalog lacks a qualifying OpenAI route for ${expectedModel}`)
  if (
    eligible.some(
      ([prompt, completion, cacheRead, cacheWrite]) =>
        inputRateUpperUsd + 1e-15 < Math.max(prompt!, cacheRead!, cacheWrite!) ||
        outputRateUpperUsd + 1e-15 < completion!,
    )
  )
    throw new RangeError(
      `Pinned price rates do not bound every eligible OpenAI route for ${expectedModel}`,
    )
}

async function validatePriceProof(
  artifactRoot: string,
  rawProof: z.infer<typeof priceProofSchema>,
  priceProofSha256: string,
  flat = false,
): Promise<PhaseFreeze['conservativeCostProof']> {
  const candidateProfileId = flat ? PROFILE_FLAT_CANDIDATE_ID : PROFILE_CANDIDATE_ID
  const expected = [
    { profileId: candidateProfileId, model: 'openai/gpt-6-luna' },
    { profileId: PROFILE_CONTROL_ID, model: 'openai/gpt-6-luna-decisions' },
  ] as const
  const bounds: PhaseFreeze['conservativeCostProof']['profileDispatchUpperBounds'] = [
    {
      profileId: candidateProfileId,
      maxUsdPerPhysicalDispatch: rawProof.entries[0].maxUsdPerPhysicalDispatch,
    },
    {
      profileId: PROFILE_CONTROL_ID,
      maxUsdPerPhysicalDispatch: rawProof.entries[1].maxUsdPerPhysicalDispatch,
    },
  ]
  for (const [index, expectedRow] of expected.entries()) {
    const entry = rawProof.entries[index]!
    if (entry.profileId !== expectedRow.profileId || entry.model !== expectedRow.model)
      throw new RangeError('Price proof profile/model order mismatch')
    const rawCatalog: unknown = JSON.parse(
      (await readPinnedBytes(artifactRoot, entry.rawCatalog)).toString('utf8'),
    )
    assertOpenAiCatalogRates(
      rawCatalog,
      entry.model,
      entry.inputTokenBound,
      entry.maxOutputTokens,
      entry.inputRateUpperUsd,
      entry.outputRateUpperUsd,
    )
    const computed =
      entry.inputTokenBound * entry.inputRateUpperUsd +
      entry.maxOutputTokens * entry.outputRateUpperUsd
    if (computed > entry.computedWorstUsd + 1e-9)
      throw new RangeError(
        `Price proof undercounts the token-price worst case for ${entry.profileId}`,
      )
    if (entry.maxUsdPerPhysicalDispatch < entry.computedWorstUsd)
      throw new RangeError(
        `Price dispatch bound is below the computed worst case for ${entry.profileId}`,
      )
  }
  const maxUsdPerPhysicalDispatch = Math.max(
    ...bounds.map((item) => item.maxUsdPerPhysicalDispatch),
  )
  const proofBody: Omit<PhaseFreeze['conservativeCostProof'], 'proofSha256'> = {
    schema: 'h8a-fresh-conservative-cost-proof-v1',
    proofKind: 'audited-upper-bound',
    maxUsdPerPhysicalDispatch,
    profileDispatchUpperBounds: bounds,
    derivedFrom: `pinned-price-proof-sha256:${priceProofSha256}`,
  }
  return { ...proofBody, proofSha256: hashIdentity(proofBody) }
}

async function validateIndependentPriceProof(
  artifactRoot: string,
  rawUnknown: unknown,
  priceProofSha256: string,
): Promise<PhaseFreeze['conservativeCostProof']> {
  const proof = independentPriceProofSchema.parse(rawUnknown)
  if (proof.registeredStudySha256 !== INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256)
    throw new RangeError('Successor public-cost proof belongs to a different study')
  const entries = proof.entries.map((entry, index) => {
    const catalogPath = resolve(entry.rawCatalog.path)
    const relativePath = relative(resolve(artifactRoot), catalogPath)
    const expectedFilename =
      index === 0 ? 'gpt-6-luna-endpoints.json' : 'gpt-6-luna-decisions-endpoints.json'
    const expectedCatalogPath = resolve(UI_STATE_DEV40_ROOT, 'main', expectedFilename)
    const expectedRelativePath = relative(resolve(artifactRoot), expectedCatalogPath)
    if (
      isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath !== expectedRelativePath
    )
      throw new RangeError('Successor public-cost catalog path differs from its pinned study input')
    return { ...entry, rawCatalog: { path: relativePath, sha256: entry.rawCatalog.sha256 } }
  })
  if (
    entries[0]!.profileId !== PROFILE_FLAT_CANDIDATE_ID ||
    entries[0]!.model !== 'openai/gpt-6-luna' ||
    entries[0]!.inputTokenBound !== 1_050_000 ||
    entries[0]!.maxOutputTokens !== 4_096 ||
    entries[0]!.inputRateUpperUsd !== 0.0000005 ||
    entries[0]!.outputRateUpperUsd !== 0.0000015 ||
    entries[0]!.computedWorstUsd !== 0.531144 ||
    entries[0]!.maxUsdPerPhysicalDispatch !== 0.55 ||
    entries[1]!.profileId !== PROFILE_CONTROL_ID ||
    entries[1]!.model !== 'openai/gpt-6-luna-decisions' ||
    entries[1]!.inputTokenBound !== 1_050_000 ||
    entries[1]!.maxOutputTokens !== 0 ||
    entries[1]!.inputRateUpperUsd !== 0.0000001 ||
    entries[1]!.outputRateUpperUsd !== 0 ||
    entries[1]!.computedWorstUsd !== 0.105 ||
    entries[1]!.maxUsdPerPhysicalDispatch !== 0.12 ||
    entries[0]!.maxUsdPerPhysicalDispatch * 4 + entries[1]!.maxUsdPerPhysicalDispatch * 6 !==
      2.92 ||
    entries[0]!.maxUsdPerPhysicalDispatch * 160 + entries[1]!.maxUsdPerPhysicalDispatch * 240 !==
      116.8 ||
    entries[0]!.maxUsdPerPhysicalDispatch * 480 + entries[1]!.maxUsdPerPhysicalDispatch * 720 !==
      350.4
  )
    throw new RangeError(
      'Successor public-cost bounds differ from the registered per-request ceiling',
    )
  const legacyProof = priceProofSchema.parse({
    schema: 'h8a-public-price-proof-v2',
    observedUtc: proof.observedUtc,
    maxCostUsd: CAMPAIGN_MAX_COST_USD,
    maxPhysicalCalls: proof.physicalCallLimit,
    entries,
  })
  return validatePriceProof(artifactRoot, legacyProof, priceProofSha256, true)
}

function validatePackedMask(
  bytes: Uint8Array,
  width: number,
  height: number,
  digest: string,
): void {
  const expectedLength = Math.ceil((width * height) / 8)
  if (bytes.length !== expectedLength || digestBytes(bytes) !== digest)
    throw new RangeError('Reference mask byte length or digest mismatch')
  const usedBits = (width * height) % 8
  if (usedBits !== 0 && (bytes.at(-1)! & (0xff << usedBits)) !== 0)
    throw new RangeError('Reference mask has nonzero packed padding bits')
}

function hamming64(left: string, right: string): number {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let count = 0
  while (bits !== 0n) {
    count++
    bits &= bits - 1n
  }
  return count
}

interface DevFreezeAssemblyOptions {
  authorityPath: string
  authoritySha256: string
  sourceRoot: string
  outputDirectory: string
  testOnlyDisjointLineagePins?: DisjointLineagePins
}

type FreezeVariant = 'v1' | 'flat-v2' | 'flat-disjoint-v1' | 'independent-v2'

type FreezeAuthority =
  | z.infer<typeof preparationAuthoritySchema>
  | z.infer<typeof flatPreparationAuthoritySchema>
  | z.infer<ReturnType<typeof createDisjointPreparationAuthoritySchema>>
  | z.infer<typeof independentDev40PreparationAuthoritySchema>

const getAuthorityVariant = (schema: unknown): FreezeVariant => {
  if (schema === 'h8a-dev-freeze-preparation-v1') return 'v1'
  if (schema === 'h8a-flat-dev-freeze-preparation-v1') return 'flat-v2'
  if (schema === 'h8a-disjoint-dev-freeze-preparation-v1') return 'flat-disjoint-v1'
  if (schema === 'h8a-independent-dev40-v2-preparation-v1') return 'independent-v2'
  throw new RangeError('Unsupported DEV freeze preparation authority schema')
}

const sourceGroupSplitDigestSchema = z
  .object({
    schema: z.literal('h8a-dev-source-group-split-v1'),
    devSourceGroupIds: z.array(z.string().min(1)),
    qualificationSourceGroupIds: z.array(z.string().min(1)),
    exclusionSourceGroupIds: z.array(z.string().min(1)),
    devCommitmentSha256: sha256,
    qualificationCommitmentSha256: sha256,
    exclusionCommitmentSha256: sha256,
  })
  .strict()

function createDisjointSourceRegistrationSchema(parentRegistrationSha256: string) {
  return z
    .object({
      schema: z.literal('h8a-disjoint-source-registration-v1'),
      parentRegistrationSha256: z.literal(parentRegistrationSha256),
      orderProtocolSha256: sha256,
      mapRosterSha256: sha256,
      sourceGroupSplitSha256: sha256,
      sourceEvidence: z.array(artifactRefSchema).min(1),
      rows: z
        .array(
          z
            .object({
              opaqueCaseId: z.string().min(1),
              stratum: z.enum(STRATUMS),
              sourceGroup: z.string().min(1),
              expectedPresence: z.enum(['present', 'absent']),
              sourceSha256: sha256,
            })
            .strict(),
        )
        .length(DEV40_CASE_COUNT),
    })
    .strict()
}

const disjointParentRegistrationSchema = z
  .object({
    schema: z.literal('prospective-disjoint-dev40-design-v1'),
    freezeId: z.literal(DISJOINT_FREEZE_ID),
    studyId: z.literal('flat-disjoint-replication-v1'),
    baseCommit: z.literal('c3c43084bb3ad663bb7390be7717effd33788046'),
    sourceSelectionSeed: z.literal('h8a-independent-dev40-20261101-r1'),
    candidate: z.literal(PROFILE_FLAT_CANDIDATE_ID),
    strata: z
      .object({
        photo: z.tuple([z.literal(16), z.literal(4)]),
        ui: z
          .object({
            gnumeric: z.tuple([z.literal(4), z.literal(1)]),
            evince: z.tuple([z.literal(3), z.literal(2)]),
          })
          .strict(),
        map: z
          .object({
            xsok: z.tuple([z.literal(4), z.literal(1)]),
            gnurobbo: z.tuple([z.literal(3), z.literal(2)]),
          })
          .strict(),
      })
      .strict(),
  })
  .passthrough()

function createAcceptedHistorySchema(parentRegistrationSha256: string) {
  return z
    .object({
      schema: z.literal('h8a-closed-development-lineage-v1'),
      parentRegistrationFileSha256: z.literal(parentRegistrationSha256),
      priorIds: z.array(z.string().min(1)).length(40),
      priorEncodedSha256: z.array(sha256).length(40),
      allExcludedSourceGroups: z.array(z.string().min(1)).min(382),
      campaignLedgerBeforeRegistration: sha256,
      priorCashUsd: z.literal(0.009603065),
      priorKnownConfirmed: z.literal(14),
      priorNextReservationId: z.literal(15),
      priorLogicalAttempts: z.literal(5),
      openInFlightBefore: z.literal(0),
      previousExperimentNamespace: z.literal('experiments/h8a-flat-dev40-v1'),
      newExperimentNamespace: z.literal('experiments/flat-disjoint-replication-v1'),
    })
    .passthrough()
}

async function loadFragment(
  artifactRoot: string,
  ref: { fragmentId: string; path: string; sha256: string },
): Promise<FragmentRows> {
  const raw = await readBoundedRegularFile(
    resolveArtifact(artifactRoot, ref.path),
    JSON_FILE_LIMIT_BYTES,
    artifactRoot,
  )
  if (digestBytes(raw) !== ref.sha256)
    throw new RangeError(`Fragment review manifest pin mismatch: ${ref.fragmentId}`)
  const review = reviewedFragmentSchema.parse(JSON.parse(raw.toString('utf8')))
  if (review.fragmentId !== ref.fragmentId) throw new RangeError('Fragment ID mismatch')
  const [producerRows, annotations, controllerPathIndex, provenance] = await Promise.all([
    readPinnedJson(artifactRoot, review.producerRows, producerRowsSchema),
    readPinnedJson(artifactRoot, review.annotations, privateAnnotationRowsSchema),
    readPinnedJson(artifactRoot, review.controllerPathIndex, z.record(z.string(), z.string())),
    readPinnedJson(artifactRoot, review.provenance, z.record(z.string(), z.unknown())),
  ])
  await readPinnedBytes(artifactRoot, review.fragmentReceipt)
  for (const mask of review.referenceMasks) await readPinnedBytes(artifactRoot, mask)
  for (const receipt of review.reviewReceipts) await readPinnedBytes(artifactRoot, receipt)
  const rawAnnotations: unknown = JSON.parse(annotations.raw.toString('utf8'))
  if (!Array.isArray(rawAnnotations))
    throw new RangeError('Raw annotation bundle must be an ordered row array')
  const annotationDigests = new Map<string, string>()
  const rawAnnotationRows = new Map<string, unknown>()
  for (const row of rawAnnotations) {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof Reflect.get(row, 'opaqueCaseId') !== 'string'
    )
      throw new RangeError('Raw annotation row has no opaqueCaseId')
    const id = z.string().parse(Reflect.get(row, 'opaqueCaseId'))
    if (annotationDigests.has(id)) throw new RangeError('Duplicate raw annotation row ID')
    annotationDigests.set(id, hashIdentity(row))
    rawAnnotationRows.set(id, row)
  }
  const rawProvenance = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(provenance.raw.toString('utf8')))
  const provenanceDigests = new Map(
    Object.entries(rawProvenance).map(([id, row]) => [id, hashIdentity(row)]),
  )
  const producerIds = producerRows.value.map((item) => item.opaqueCaseId)
  const annotationIds = annotations.value.map((item) => item.opaqueCaseId)
  const reviewIds = review.rows.map((item) => item.opaqueCaseId)
  for (const ids of [producerIds, annotationIds, reviewIds]) {
    if (new Set(ids).size !== ids.length)
      throw new RangeError('Duplicate ID inside a reviewed fragment')
  }
  if (
    producerIds.length !== annotationIds.length ||
    producerIds.length !== reviewIds.length ||
    producerIds.some((id, index) => id !== annotationIds[index] || id !== reviewIds[index])
  )
    throw new RangeError('Reviewed fragment producer, annotation, and review row order mismatch')
  const referencedMaskDigests = new Set(
    annotations.value.flatMap((row) => row.referenceMasks.map((mask) => mask.packedBinarySha256)),
  )
  const pinnedMaskDigests = review.referenceMasks.map((item) => item.sha256)
  if (
    new Set(pinnedMaskDigests).size !== pinnedMaskDigests.length ||
    pinnedMaskDigests.length !== referencedMaskDigests.size ||
    pinnedMaskDigests.some((digest) => !referencedMaskDigests.has(digest))
  )
    throw new RangeError('Fragment pinned mask files differ from annotation mask references')
  return {
    producerRows: producerRows.value,
    annotations: annotations.value,
    annotationDigests,
    rawAnnotationRows,
    controllerPathIndex: controllerPathIndex.value,
    provenance: provenance.value,
    provenanceDigests,
    review,
  }
}

async function verifyCaseInputs(
  artifactRoot: string,
  rows: readonly {
    fragment: FragmentRows
    reviewRow: z.infer<typeof reviewedFragmentSchema>['rows'][number]
  }[],
): Promise<{
  producerCases: PhaseFreeze['producerCases']
  sourceBytesByCaseId: Map<string, Buffer>
  sharpRuntimeDecodedRgbSha256ByCaseId: Map<string, string>
}> {
  const producerCases: PhaseFreeze['producerCases'] = []
  const sourceBytesByCaseId = new Map<string, Buffer>()
  const sharpRuntimeDecodedRgbSha256ByCaseId = new Map<string, string>()
  const seen = new Set<string>()
  for (const { fragment, reviewRow } of rows) {
    const id = reviewRow.opaqueCaseId
    if (seen.has(id)) throw new RangeError('Duplicate accepted opaqueCaseId')
    seen.add(id)
    const producer = fragment.producerRows.find((item) => item.opaqueCaseId === id)
    const annotation = fragment.annotations.find((item) => item.opaqueCaseId === id)
    const provenance = fragment.provenance[id]
    const indexedPath = fragment.controllerPathIndex[id]
    if (
      reviewRow.fragmentId !== fragment.review.fragmentId ||
      !producer ||
      !annotation ||
      provenance === undefined ||
      !indexedPath
    )
      throw new RangeError(`Fragment payload is missing a row dependency for ${id}`)
    if (
      reviewRow.sourceSha256 !== producer.sourceBytesSha256 ||
      reviewRow.annotationSha256 !== fragment.annotationDigests.get(id) ||
      normalizeSourceGroup(reviewRow.sourceGroup) !==
        normalizeSourceGroup(annotation.sourceGroup) ||
      reviewRow.provenanceSha256 !== fragment.provenanceDigests.get(id)
    )
      throw new RangeError(`Pinned review admission differs from source row ${id}`)
    const receipt = fragment.review.reviewReceipts.find(
      (item) => item.sha256 === reviewRow.reviewReceiptSha256,
    )
    if (!receipt) throw new RangeError(`Row review receipt is not pinned for ${id}`)
    const sourcePath = resolve(indexedPath)
    if (!isWithin(resolve(artifactRoot), sourcePath))
      throw new RangeError('Controller path escapes trustedRoot')
    const sourceBytes = await readBoundedRegularFile(
      sourcePath,
      SOURCE_FILE_LIMIT_BYTES,
      artifactRoot,
    )
    if (digestBytes(sourceBytes) !== producer.sourceBytesSha256)
      throw new RangeError(`Source image bytes do not match producer digest for ${id}`)
    const image = await sharp(sourceBytes, {
      failOn: 'error',
      limitInputPixels: SOURCE_PIXEL_LIMIT,
    }).metadata()
    if (
      !image.width ||
      !image.height ||
      (image.orientation !== undefined && image.orientation !== 1)
    )
      throw new RangeError(`Source image canvas/orientation is not admissible for ${id}`)
    if (
      image.width * image.height > SOURCE_PIXEL_LIMIT ||
      producer.sourceCanvasWidth !== image.width ||
      producer.sourceCanvasHeight !== image.height
    )
      throw new RangeError(`Source image canvas mismatch for ${id}`)
    const decoded = await sharp(sourceBytes, {
      failOn: 'error',
      limitInputPixels: SOURCE_PIXEL_LIMIT,
    })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (
      decoded.info.channels !== 3 ||
      decoded.info.width !== image.width ||
      decoded.info.height !== image.height
    )
      throw new RangeError(`Source RGB decoding differs from its registered canvas for ${id}`)
    sharpRuntimeDecodedRgbSha256ByCaseId.set(id, digestBytes(decoded.data))
    assertReferenceBoxesWithinCanvas(annotation, image.width, image.height)
    assertReferenceMaskDeclaration(annotation, image.width, image.height)
    for (const mask of annotation.referenceMasks) {
      const maskRef = fragment.review.referenceMasks.find(
        (item) => item.sha256 === mask.packedBinarySha256,
      )
      if (!maskRef) throw new RangeError(`Reference mask lacks a pinned path for ${id}`)
      const maskBytes = await readPinnedBytes(artifactRoot, maskRef)
      validatePackedMask(maskBytes, mask.width, mask.height, mask.packedBinarySha256)
      if (mask.width !== image.width || mask.height !== image.height)
        throw new RangeError(`Reference mask canvas mismatch for ${id}`)
    }
    producerCases.push(producer)
    sourceBytesByCaseId.set(id, sourceBytes)
  }
  if (sourceBytesByCaseId.size !== rows.length)
    throw new RangeError('Missing source bytes in complete cohort')
  return {
    producerCases,
    sourceBytesByCaseId,
    sharpRuntimeDecodedRgbSha256ByCaseId,
  }
}

function expectedRecipeIdentity(
  profile:
    | typeof H8A_CANDIDATE_PROFILE
    | typeof H8A_FLAT_CANDIDATE_PROFILE
    | typeof V02_CONTROL_PROFILE,
): string {
  return hashIdentity({
    profileId: profile.profileId,
    recipeKind: profile.recipeKind,
    requestPolicyIdentitySha256: profile.requestPolicyIdentitySha256,
  })
}

export async function assembleDevFreezeFromDisk(options: DevFreezeAssemblyOptions): Promise<{
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  selection: ReturnType<typeof buildDevScreenSelection>
  sourceBytesByCaseId: Map<string, Buffer>
  sourceClosurePaths: string[]
  runtimeEnvironmentSha256: string
}> {
  const authorityBytes = await readBoundedRegularFile(options.authorityPath, JSON_FILE_LIMIT_BYTES)
  if (digestBytes(authorityBytes) !== options.authoritySha256)
    throw new RangeError('Preparation authority SHA-256 does not match the caller-supplied pin')
  const authorityUnknown: unknown = JSON.parse(authorityBytes.toString('utf8'))
  const authorityRecord = z.record(z.string(), z.unknown()).parse(authorityUnknown)
  const variant = getAuthorityVariant(authorityRecord.schema)
  const disjointLineagePins = z
    .object({ parentRegistrationSha256: sha256, acceptedHistorySha256: sha256 })
    .strict()
    .parse(
      options.testOnlyDisjointLineagePins ?? {
        parentRegistrationSha256: PINNED_PARENT_REGISTRATION_SHA256,
        acceptedHistorySha256: PINNED_ACCEPTED_HISTORY_SHA256,
      },
    )
  const flatAuthority =
    variant === 'flat-v2' ? flatPreparationAuthoritySchema.parse(authorityUnknown) : undefined
  const disjointAuthority =
    variant === 'flat-disjoint-v1'
      ? createDisjointPreparationAuthoritySchema(disjointLineagePins).parse(authorityUnknown)
      : undefined
  const independentAuthority =
    variant === 'independent-v2'
      ? independentDev40PreparationAuthoritySchema.parse(authorityUnknown)
      : undefined
  const authority: FreezeAuthority =
    independentAuthority ??
    disjointAuthority ??
    flatAuthority ??
    preparationAuthoritySchema.parse(authorityUnknown)
  const phaseId = variant === 'v1' ? PHASE_DEV40_ID : PHASE_FLAT_DEV40_ID
  const candidateProfileId = candidateIdForPhase(phaseId)
  const candidateProfile =
    candidateProfileId === PROFILE_FLAT_CANDIDATE_ID
      ? H8A_FLAT_CANDIDATE_PROFILE
      : H8A_CANDIDATE_PROFILE
  if (!isAbsolute(authority.trustedRoot)) throw new RangeError('trustedRoot must be absolute')
  const artifactRoot = resolve(authority.trustedRoot)
  if ((await realpath(artifactRoot)) !== artifactRoot)
    throw new RangeError('trustedRoot must not be symlinked or aliased')
  if (
    new Set(authority.fragments.map((item) => item.fragmentId)).size !==
      authority.fragments.length ||
    new Set(authority.fragments.map((item) => item.path)).size !== authority.fragments.length
  )
    throw new RangeError('Preparation authority contains duplicate reviewed fragments')

  const [protocolRef, rosterRef, closureRef, splitRef, priceRef, runtimeRef] = await Promise.all([
    readPinnedJson(artifactRoot, authority.orderProtocol, z.unknown()),
    readPinnedJson(artifactRoot, authority.mapRoster, z.unknown()),
    readPinnedJson(artifactRoot, authority.sourceClosure, sourceClosureSchema),
    readPinnedJson(artifactRoot, authority.sourceGroupSplit, sourceGroupSplitDigestSchema),
    readPinnedJson(artifactRoot, authority.priceProof, z.unknown()),
    readPinnedJson(artifactRoot, authority.runtimeEnvironment, runtimeEnvironmentSchema),
  ])
  let parentRegistrationSha256: string | undefined
  let acceptedHistorySha256: string | undefined
  let registeredSourcesSha256: string | undefined
  let acceptedHistory: z.infer<ReturnType<typeof createAcceptedHistorySchema>> | undefined
  let registeredSources:
    | z.infer<ReturnType<typeof createDisjointSourceRegistrationSchema>>
    | undefined
  if (disjointAuthority) {
    const [parentRef, historyRef, sourceRegistryRef] = await Promise.all([
      readPinnedJson(
        artifactRoot,
        disjointAuthority.parentRegistration,
        disjointParentRegistrationSchema,
      ),
      readPinnedJson(
        artifactRoot,
        disjointAuthority.acceptedHistory,
        createAcceptedHistorySchema(disjointLineagePins.parentRegistrationSha256),
      ),
      readPinnedJson(
        artifactRoot,
        disjointAuthority.registeredSources,
        createDisjointSourceRegistrationSchema(disjointLineagePins.parentRegistrationSha256),
      ),
    ])
    parentRegistrationSha256 = digestBytes(parentRef.raw)
    acceptedHistorySha256 = digestBytes(historyRef.raw)
    registeredSourcesSha256 = digestBytes(sourceRegistryRef.raw)
    acceptedHistory = historyRef.value
    registeredSources = sourceRegistryRef.value
    if (
      parentRegistrationSha256 !== disjointLineagePins.parentRegistrationSha256 ||
      acceptedHistorySha256 !== disjointLineagePins.acceptedHistorySha256 ||
      acceptedHistory.parentRegistrationFileSha256 !== parentRegistrationSha256 ||
      new Set(acceptedHistory.priorIds).size !== acceptedHistory.priorIds.length ||
      new Set(acceptedHistory.priorEncodedSha256).size !==
        acceptedHistory.priorEncodedSha256.length ||
      new Set(acceptedHistory.allExcludedSourceGroups.map(normalizeSourceGroup)).size !==
        acceptedHistory.allExcludedSourceGroups.length ||
      registeredSources.parentRegistrationSha256 !== parentRegistrationSha256 ||
      registeredSources.orderProtocolSha256 !== authority.orderProtocol.sha256 ||
      registeredSources.mapRosterSha256 !== authority.mapRoster.sha256 ||
      registeredSources.sourceGroupSplitSha256 !== authority.sourceGroupSplit.sha256
    )
      throw new RangeError(
        'Disjoint source lineage or registration pins do not match the authority',
      )
    const requiredEvidence = [
      disjointAuthority.parentRegistration,
      disjointAuthority.acceptedHistory,
      authority.orderProtocol,
      authority.mapRoster,
      authority.sourceGroupSplit,
      ...authority.fragments.map(({ path, sha256 }) => ({ path, sha256 })),
    ]
    const evidencePins = new Set(
      registeredSources.sourceEvidence.map((ref) => `${ref.path}\0${ref.sha256}`),
    )
    if (
      new Set(registeredSources.sourceEvidence.map((ref) => ref.path)).size !==
        registeredSources.sourceEvidence.length ||
      requiredEvidence.some((ref) => !evidencePins.has(`${ref.path}\0${ref.sha256}`))
    )
      throw new RangeError('Disjoint source evidence omits or duplicates a pinned source input')
    await Promise.all(
      registeredSources.sourceEvidence.map((ref) => readPinnedBytes(artifactRoot, ref)),
    )
  }
  let independentRows: z.infer<typeof independentSourceRosterSchema>['rows'] | undefined
  let independentRegisteredRows:
    | z.infer<typeof independentRegisteredSourcesSchema>['rows']
    | undefined
  let independentPixels: z.infer<typeof independentHistoricalPixelsSchema> | undefined
  let independentUnionAudit: z.infer<typeof independentSourceUnionAuditSchema> | undefined
  let independentExclusions: z.infer<typeof independentHistoricalExclusionsSchema> | undefined
  let independentSourceStateProofSha256: string | undefined
  let independentStateProof: z.infer<typeof uiNativeStateProofRowsSchema> | undefined
  let independentSourceRosterSha256: string | undefined
  let independentRegisteredSourcesSha256: string | undefined
  if (independentAuthority) {
    const artifactRefs = [
      independentAuthority.orderProtocol,
      independentAuthority.mapRoster,
      independentAuthority.sourceRoster,
      independentAuthority.sourceGroupSplit,
      independentAuthority.sourceClosure,
      independentAuthority.priceProof,
      independentAuthority.runtimeEnvironment,
      independentAuthority.parentRegistration,
      independentAuthority.parentLedgerAudit,
      independentAuthority.historicalExclusions,
      independentAuthority.historicalPixels,
      independentAuthority.sourceUnionAudit,
      independentAuthority.sourceStateProof,
      independentAuthority.nativeUiEvidence.captureLedger,
      independentAuthority.nativeUiEvidence.pixelNoveltyAudit,
      independentAuthority.nativeUiEvidence.bundleReceipt,
      independentAuthority.nativeUiEvidence.fingerprintImplementation,
      independentAuthority.nativeUiEvidence.sourceProvenance,
      independentAuthority.nativeUiEvidence.preservedHarnessAttempts,
      independentAuthority.nativeUiEvidence.sourceReviewContactSheet,
      independentAuthority.registeredSources,
      ...independentAuthority.fragments,
    ]
    const artifactPrefix = join('zorya-classifier-mcp-20261101', INDEPENDENT_DEV40_STUDY_ID)
    const artifactPrefixPath = resolve(artifactRoot, artifactPrefix)
    const externalPinsByPath: ReadonlyMap<string, string> = new Map(
      Object.values(UI_STATE_DEV40_EXTERNAL_INPUT_PINS).map((pin) => [pin.path, pin.sha256]),
    )
    if (
      artifactRefs.some((ref) => {
        const fullPath = resolve(artifactRoot, ref.path)
        const exactExternalPin = externalPinsByPath.get(ref.path) === ref.sha256
        return (
          isAbsolute(ref.path) ||
          (!isWithin(artifactPrefixPath, fullPath) && !exactExternalPin) ||
          relative(artifactRoot, fullPath) !== ref.path
        )
      })
    )
      throw new RangeError(
        'Independent DEV40 artifact references must be in the registered study or an exact pinned external input',
      )
    if (
      independentAuthority.orderProtocol.sha256 !== INDEPENDENT_DEV40_ORDER_PROTOCOL_SHA256 ||
      independentAuthority.mapRoster.sha256 !== INDEPENDENT_DEV40_MAP_ROSTER_SHA256 ||
      independentAuthority.parentRegistration.sha256 !==
        INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256 ||
      independentAuthority.parentLedgerAudit.sha256 !== INDEPENDENT_DEV40_PARENT_AUDIT_SHA256 ||
      independentAuthority.historicalExclusions.sha256 !==
        INDEPENDENT_DEV40_HISTORICAL_EXCLUSIONS_SHA256 ||
      independentAuthority.historicalPixels.sha256 !== INDEPENDENT_DEV40_HISTORICAL_PIXELS_SHA256 ||
      independentAuthority.priceProof.sha256 !== INDEPENDENT_DEV40_COST_PROOF_SHA256 ||
      independentAuthority.sourceStateProof.path !== UI_STATE_DEV40_NATIVE_STATE_PROOFS_PATH ||
      independentAuthority.sourceStateProof.sha256 !== UI_STATE_DEV40_NATIVE_STATE_PROOFS_SHA256 ||
      independentAuthority.nativeUiEvidence.captureLedger.sha256 !==
        UI_STATE_DEV40_CAPTURE_LEDGER_SHA256 ||
      independentAuthority.nativeUiEvidence.pixelNoveltyAudit.sha256 !==
        UI_STATE_DEV40_PIXEL_NOVELTY_AUDIT_SHA256 ||
      independentAuthority.nativeUiEvidence.bundleReceipt.sha256 !==
        UI_STATE_DEV40_BUNDLE_RECEIPT_SHA256 ||
      independentAuthority.nativeUiEvidence.fingerprintImplementation.sha256 !==
        UI_STATE_DEV40_FINGERPRINT_IMPLEMENTATION_SHA256 ||
      independentAuthority.nativeUiEvidence.sourceProvenance.sha256 !==
        UI_STATE_DEV40_SOURCE_PROVENANCE_SHA256 ||
      independentAuthority.nativeUiEvidence.preservedHarnessAttempts.sha256 !==
        UI_STATE_DEV40_PRESERVED_HARNESS_SHA256 ||
      independentAuthority.nativeUiEvidence.sourceReviewContactSheet.sha256 !==
        UI_STATE_DEV40_CONTACT_SHEET_SHA256 ||
      independentAuthority.parentLedgerAudit.path !==
        'zorya-classifier-mcp-20261101/original-h8a-independent-dev40-v2/main/historical-receipt-audit.json' ||
      independentAuthority.historicalExclusions.path !==
        'zorya-classifier-mcp-20261101/original-h8a-independent-dev40-v2/main/historical-exclusions-canonical.json' ||
      independentAuthority.historicalPixels.path !==
        'zorya-classifier-mcp-20261101/original-h8a-independent-dev40-v2/main/historical-pixels.json' ||
      independentAuthority.runtimeEnvironment.path !== UI_STATE_DEV40_RUNTIME_ENVIRONMENT_PATH ||
      independentAuthority.runtimeEnvironment.sha256 !==
        UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256 ||
      independentAuthority.fragments.length !== 3 ||
      [
        UI_STATE_DEV40_EXTERNAL_INPUT_PINS.originalPhotoFragment,
        UI_STATE_DEV40_EXTERNAL_INPUT_PINS.originalMapFragment,
        {
          fragmentId: 'ui-native-state-dev40-ten',
          path: 'zorya-classifier-mcp-20261101/ui-state-dev40-v1/main/reviewed-ui10-fragment.json',
          sha256: 'c440632b3843430ebaa3f742e9cb9e5f9350e42f01e0709f2f8996e49055bc2d',
        },
      ].some(
        (expected) =>
          !independentAuthority.fragments.some(
            (fragment) =>
              fragment.fragmentId === expected.fragmentId &&
              fragment.path === expected.path &&
              fragment.sha256 === expected.sha256,
          ),
      ) ||
      independentAuthority.nativeUiEvidence.captureLedger.path !==
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/ui/bundle-v3/capture-ledger.json' ||
      independentAuthority.nativeUiEvidence.pixelNoveltyAudit.path !==
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/ui/bundle-v3/source-pixel-novelty-audit.json' ||
      independentAuthority.nativeUiEvidence.bundleReceipt.path !==
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/ui/bundle-v3/bundle-fragment-receipt.json' ||
      independentAuthority.nativeUiEvidence.fingerprintImplementation.path !==
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/ui/scripts/native_state_fingerprint.py' ||
      independentAuthority.nativeUiEvidence.sourceProvenance.path !==
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/ui/bundle-v3/curator-source-provenance.json' ||
      independentAuthority.nativeUiEvidence.preservedHarnessAttempts.path !==
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/ui/bundle-v3/preserved-harness-attempts.json' ||
      independentAuthority.nativeUiEvidence.sourceReviewContactSheet.path !==
        'zorya-classifier-mcp-20261101/ui-state-dev40-v1/ui/probes/source-review-contact-sheet.png' ||
      independentAuthority.sourcePolicyId !== UI_STATE_DEV40_SOURCE_ADMISSION_POLICY
    )
      throw new RangeError(
        'Independent DEV40 authority changes one or more parent registration pins',
      )
    const [
      parent,
      parentAudit,
      exclusions,
      pixels,
      sourceRoster,
      uiPreCaptureRoster,
      unionAudit,
      stateProof,
      captureLedgerBytes,
      pixelNoveltyAuditBytes,
      bundleReceiptBytes,
      fingerprintImplementationBytes,
      sourceProvenanceBytes,
      preservedHarnessBytes,
      sourceReviewContactSheetBytes,
      registry,
    ] = await Promise.all([
      readPinnedJson(
        artifactRoot,
        independentAuthority.parentRegistration,
        independentParentRegistrationSchema,
      ),
      readPinnedJson(
        artifactRoot,
        independentAuthority.parentLedgerAudit,
        independentParentAuditSchema,
      ),
      readPinnedJson(
        artifactRoot,
        independentAuthority.historicalExclusions,
        independentHistoricalExclusionsSchema,
      ),
      readPinnedJson(
        artifactRoot,
        independentAuthority.historicalPixels,
        independentHistoricalPixelsSchema,
      ),
      readPinnedJson(
        artifactRoot,
        independentAuthority.sourceRoster,
        independentSourceRosterSchema,
      ),
      readPinnedJson(
        artifactRoot,
        {
          path: UI_STATE_DEV40_PRECAPTURE_ROSTER_PATH,
          sha256: UI_STATE_DEV40_PRECAPTURE_ROSTER_SHA256,
        },
        independentUiPreCaptureRosterSchema,
      ),
      readPinnedJson(
        artifactRoot,
        independentAuthority.sourceUnionAudit,
        independentSourceUnionAuditSchema,
      ),
      readPinnedJson(
        artifactRoot,
        independentAuthority.sourceStateProof,
        uiNativeStateProofRowsSchema,
      ),
      readPinnedBytes(artifactRoot, independentAuthority.nativeUiEvidence.captureLedger),
      readPinnedBytes(artifactRoot, independentAuthority.nativeUiEvidence.pixelNoveltyAudit),
      readPinnedBytes(artifactRoot, independentAuthority.nativeUiEvidence.bundleReceipt),
      readPinnedBytes(
        artifactRoot,
        independentAuthority.nativeUiEvidence.fingerprintImplementation,
      ),
      readPinnedBytes(artifactRoot, independentAuthority.nativeUiEvidence.sourceProvenance),
      readPinnedBytes(artifactRoot, independentAuthority.nativeUiEvidence.preservedHarnessAttempts),
      readPinnedBytes(artifactRoot, independentAuthority.nativeUiEvidence.sourceReviewContactSheet),
      readPinnedJson(
        artifactRoot,
        independentAuthority.registeredSources,
        independentRegisteredSourcesSchema,
      ),
    ])
    const nativeCaptureLedger = uiCaptureLedgerSchema.parse(
      JSON.parse(captureLedgerBytes.toString('utf8')) as unknown,
    )
    const nativePixelNoveltyAudit = uiSourcePixelNoveltyAuditSchema.parse(
      JSON.parse(pixelNoveltyAuditBytes.toString('utf8')) as unknown,
    )
    const nativeSourceProvenance = independentUiSourceProvenanceSchema.parse(
      JSON.parse(sourceProvenanceBytes.toString('utf8')) as unknown,
    )
    const expectedParentLedgerHash =
      parent.value.parentFiles['h8a-fresh-dev-qual-campaign-v1/campaign-ledger.json']
    if (
      digestBytes(captureLedgerBytes) !==
        independentAuthority.nativeUiEvidence.captureLedger.sha256 ||
      digestBytes(pixelNoveltyAuditBytes) !==
        independentAuthority.nativeUiEvidence.pixelNoveltyAudit.sha256 ||
      digestBytes(bundleReceiptBytes) !==
        independentAuthority.nativeUiEvidence.bundleReceipt.sha256 ||
      digestBytes(fingerprintImplementationBytes) !==
        independentAuthority.nativeUiEvidence.fingerprintImplementation.sha256 ||
      digestBytes(sourceProvenanceBytes) !==
        independentAuthority.nativeUiEvidence.sourceProvenance.sha256 ||
      digestBytes(preservedHarnessBytes) !==
        independentAuthority.nativeUiEvidence.preservedHarnessAttempts.sha256 ||
      digestBytes(sourceReviewContactSheetBytes) !==
        independentAuthority.nativeUiEvidence.sourceReviewContactSheet.sha256
    )
      throw new RangeError('Native UI source evidence digest changed during admission')
    if (
      parent.value.studyId !== independentAuthority.studyId ||
      parent.value.freezeId !== independentAuthority.freezeId ||
      parent.value.sourceAdmissionPolicy.id !== independentAuthority.sourcePolicyId ||
      parent.value.parentFiles['original-h8a-independent-dev40-v2/parent-registration.json'] !==
        INDEPENDENT_DEV40_ANCESTOR_PARENT_REGISTRATION_SHA256 ||
      parent.value.parentFiles['original-h8a-independent-dev40-v2/main/historical-pixels.json'] !==
        INDEPENDENT_DEV40_HISTORICAL_PIXELS_SHA256 ||
      parent.value.parentFiles[
        'original-h8a-independent-dev40-v2/main/historical-exclusions-canonical.json'
      ] !== INDEPENDENT_DEV40_HISTORICAL_EXCLUSIONS_SHA256 ||
      parent.value.parentFiles[
        'original-h8a-independent-dev40-v2/ui/pre-capture-roster-v1.json'
      ] !== UI_STATE_DEV40_PRECAPTURE_ROSTER_SHA256 ||
      parent.value.parentFiles['h8a-fresh-dev-qual-campaign-v1/campaign-ledger.json'] !==
        INDEPENDENT_DEV40_PARENT_LEDGER_SHA256 ||
      expectedParentLedgerHash !== INDEPENDENT_DEV40_PARENT_LEDGER_SHA256 ||
      parentAudit.value.parentLedgerSha256 !== INDEPENDENT_DEV40_PARENT_LEDGER_SHA256 ||
      exclusions.value.parentRegistrationSha256 !==
        UI_STATE_DEV40_ANCESTOR_PARENT_REGISTRATION_SHA256 ||
      exclusions.value.priorFileSha256 !== digestBytes(pixels.raw) ||
      registry.value.parentRegistrationSha256 !== digestBytes(parent.raw) ||
      registry.value.orderProtocolSha256 !== digestBytes(protocolRef.raw) ||
      registry.value.mapRosterSha256 !== digestBytes(rosterRef.raw) ||
      registry.value.sourceRosterSha256 !== digestBytes(sourceRoster.raw) ||
      registry.value.sourceGroupSplitSha256 !== digestBytes(splitRef.raw) ||
      registry.value.sourceStateProofSha256 !== digestBytes(stateProof.raw) ||
      independentAuthority.sourceStateProof.sha256 !== digestBytes(stateProof.raw) ||
      unionAudit.value.parentRegistrationSha256 !== digestBytes(parent.raw) ||
      unionAudit.value.historicalPixelsSha256 !== digestBytes(pixels.raw) ||
      stateProof.value.registrationSha256 !== digestBytes(parent.raw) ||
      stateProof.value.sourceRosterSha256 !== UI_STATE_DEV40_PRECAPTURE_ROSTER_SHA256 ||
      stateProof.value.wordingSha256 !== UI_STATE_DEV40_WORDING_SHA256 ||
      stateProof.value.captureViewSha256 !== UI_STATE_DEV40_CAPTURE_VIEW_SHA256 ||
      stateProof.value.preCaptureStabilitySha256 !== UI_STATE_DEV40_PRECAPTURE_STABILITY_SHA256 ||
      nativePixelNoveltyAudit.historicalRegistrySha256 !==
        UI_STATE_DEV40_HISTORICAL_PIXELS_SHA256 ||
      unionAudit.value.algorithm !== pixels.value.algorithm ||
      unionAudit.value.sha256Implementation !== pixels.value.sha256Implementation ||
      new Set(exclusions.value.caseIds).size !== exclusions.value.caseIds.length ||
      new Set(exclusions.value.imageIds).size !== exclusions.value.imageIds.length ||
      new Set(exclusions.value.sourceGroups.map(normalizeSourceGroup)).size !==
        exclusions.value.sourceGroups.length ||
      new Set(pixels.value.rows.map((row) => row.encodedSha256)).size !== pixels.value.rows.length
    )
      throw new RangeError('Independent DEV40 source lineage does not match its pinned parent')
    const requiredEvidence = [
      independentAuthority.parentRegistration,
      independentAuthority.parentLedgerAudit,
      independentAuthority.historicalExclusions,
      independentAuthority.historicalPixels,
      independentAuthority.orderProtocol,
      independentAuthority.mapRoster,
      independentAuthority.sourceRoster,
      independentAuthority.sourceGroupSplit,
      independentAuthority.sourceStateProof,
      independentAuthority.nativeUiEvidence.captureLedger,
      independentAuthority.nativeUiEvidence.pixelNoveltyAudit,
      independentAuthority.nativeUiEvidence.bundleReceipt,
      independentAuthority.nativeUiEvidence.fingerprintImplementation,
      independentAuthority.nativeUiEvidence.sourceProvenance,
      independentAuthority.nativeUiEvidence.preservedHarnessAttempts,
      independentAuthority.nativeUiEvidence.sourceReviewContactSheet,
      independentAuthority.sourceClosure,
      independentAuthority.priceProof,
      independentAuthority.runtimeEnvironment,
      independentAuthority.sourceUnionAudit,
      ...independentAuthority.fragments.map(({ path, sha256 }) => ({ path, sha256 })),
    ]
    const evidenceByPath = new Map<string, string>()
    for (const ref of requiredEvidence) {
      const previous = evidenceByPath.get(ref.path)
      if (previous && previous !== ref.sha256)
        throw new RangeError('Native UI source evidence has conflicting hashes for one path')
      evidenceByPath.set(ref.path, ref.sha256)
    }
    const uniqueRequiredEvidence = [...evidenceByPath].map(([path, sha256]) => ({ path, sha256 }))
    const evidencePins = new Set(
      registry.value.sourceEvidence.map((ref) => `${ref.path}\0${ref.sha256}`),
    )
    if (
      registry.value.sourceEvidence.length !== uniqueRequiredEvidence.length ||
      new Set(registry.value.sourceEvidence.map((ref) => ref.path)).size !==
        registry.value.sourceEvidence.length ||
      uniqueRequiredEvidence.some((ref) => !evidencePins.has(`${ref.path}\0${ref.sha256}`))
    )
      throw new RangeError('Independent DEV40 source evidence omits or duplicates a required input')
    await Promise.all(
      registry.value.sourceEvidence.map((ref) => readPinnedBytes(artifactRoot, ref)),
    )
    const preCaptureById = new Map(
      uiPreCaptureRoster.value.rows.map((row) => [row.opaqueCaseId, row]),
    )
    const registryById = new Map(registry.value.rows.map((row) => [row.opaqueCaseId, row]))
    const captureLedgerById = new Map(
      nativeCaptureLedger.rows.map((row) => [row.opaqueCaseId, row]),
    )
    const noveltyById = new Map(nativePixelNoveltyAudit.rows.map((row) => [row.opaqueCaseId, row]))
    const unionById = new Map(unionAudit.value.rows.map((row) => [row.opaqueCaseId, row]))
    if (
      stateProof.value.rows.length !== 10 ||
      preCaptureById.size !== 10 ||
      registryById.size !== DEV40_CASE_COUNT ||
      captureLedgerById.size !== 10 ||
      noveltyById.size !== 10 ||
      unionById.size !== DEV40_CASE_COUNT
    )
      throw new RangeError('Native UI proof or linked source inventories are incomplete')
    for (const proofRow of stateProof.value.rows) {
      const id = proofRow.opaqueCaseId
      const preCapture = preCaptureById.get(id)
      const source = registryById.get(id)
      const ledgerRow = captureLedgerById.get(id)
      const novelty = noveltyById.get(id)
      const union = unionById.get(id)
      const provenance = nativeSourceProvenance[id]
      if (!preCapture || !source || !ledgerRow || !novelty || !union || !provenance)
        throw new RangeError(`Native UI proof row ${id} lacks a signed source lineage row`)
      const imageViewerDirectory =
        preCapture.source.kind === 'image'
          ? uiPreCaptureRoster.value.rows.find(
              (candidate) =>
                candidate.application === preCapture.application &&
                candidate.source.kind === 'directory' &&
                candidate.source.path === dirname(preCapture.source.path),
            )
          : undefined
      const sourceContentHashes =
        preCapture.source.kind === 'directory'
          ? preCapture.source.assets
          : { [basename(preCapture.source.path)]: preCapture.source.sha256 }
      const appInputHashes =
        preCapture.source.kind === 'image' && imageViewerDirectory?.source.kind === 'directory'
          ? imageViewerDirectory.source.assets
          : sourceContentHashes
      if (
        proofRow.order !== preCapture.order ||
        proofRow.sourceGroup !== preCapture.sourceGroup ||
        proofRow.stateId !== preCapture.stateId ||
        proofRow.application !== preCapture.application ||
        proofRow.applicationVersion !== preCapture.applicationVersion ||
        proofRow.targetOracle.expectedPresence !== preCapture.expectedPresence ||
        proofRow.targetOracle.role !== preCapture.targetQuery.role ||
        proofRow.targetOracle.name !== preCapture.targetQuery.name ||
        proofRow.targetOracle.preMatchCount !== preCapture.preCaptureOracle.queryMatchCount ||
        (preCapture.source.kind === 'image' &&
          (!imageViewerDirectory ||
            imageViewerDirectory.source.kind !== 'directory' ||
            imageViewerDirectory.source.assets[basename(preCapture.source.path)] !==
              preCapture.source.sha256)) ||
        (proofRow.targetOracle.uniqueMatchBounds !== null &&
          hashIdentity(proofRow.targetOracle.uniqueMatchBounds) !==
            hashIdentity(preCapture.preCaptureOracle.bounds)) ||
        !sameDigestMap(proofRow.sourceInputSha256ByBasename, appInputHashes) ||
        source.stratum !== 'ui' ||
        source.sourceGroup !== preCapture.sourceGroup ||
        source.predeclaredStateId !== preCapture.stateId ||
        source.expectedPresence !== preCapture.expectedPresence ||
        source.sourceSha256 !== proofRow.capture.pngSha256 ||
        !sameDigestMap(provenance.sourceContentSha256ByBasename, sourceContentHashes) ||
        provenance.opaqueCaseId !== id ||
        provenance.sourceGroup !== proofRow.sourceGroup ||
        provenance.sourceStateId !== proofRow.stateId ||
        provenance.application !== proofRow.application ||
        provenance.applicationVersion !== proofRow.applicationVersion ||
        provenance.targetRole !== proofRow.targetOracle.role ||
        provenance.targetName !== proofRow.targetOracle.name ||
        provenance.capturePath !== proofRow.capture.path ||
        provenance.captureSha256 !== proofRow.capture.pngSha256 ||
        provenance.captureRgbSha256 !== proofRow.capture.decodedRgbSha256 ||
        provenance.nativeStateFingerprintSha256 !== proofRow.nativeStateFingerprintSha256 ||
        ledgerRow.order !== proofRow.order ||
        ledgerRow.sourceGroup !== proofRow.sourceGroup ||
        ledgerRow.stateId !== proofRow.stateId ||
        ledgerRow.expectedPresence !== proofRow.targetOracle.expectedPresence ||
        ledgerRow.imagePath !== proofRow.capture.path ||
        ledgerRow.pngSha256 !== proofRow.capture.pngSha256 ||
        ledgerRow.decodedRgbSha256 !== proofRow.capture.decodedRgbSha256 ||
        ledgerRow.inventoryPreSha256 !== proofRow.inventory.preSha256 ||
        ledgerRow.inventoryPostSha256 !== proofRow.inventory.postSha256 ||
        ledgerRow.nativeStateFingerprintSha256 !== proofRow.nativeStateFingerprintSha256 ||
        ledgerRow.captureStatusPath !== proofRow.captureStatus.path ||
        ledgerRow.captureStatusSha256 !== proofRow.captureStatus.sha256 ||
        ledgerRow.captureLogPath !== proofRow.captureLog.path ||
        ledgerRow.captureLogSha256 !== proofRow.captureLog.sha256 ||
        novelty.order !== proofRow.order ||
        novelty.sourceBytesSha256 !== proofRow.capture.pngSha256 ||
        novelty.decodedRgbSha256 !== proofRow.capture.decodedRgbSha256 ||
        novelty.nativeStateFingerprintSha256 !== proofRow.nativeStateFingerprintSha256 ||
        union.stratum !== 'ui' ||
        union.encodedSha256 !== proofRow.capture.pngSha256 ||
        union.decodedRgbSha256 !== proofRow.capture.decodedRgbSha256 ||
        union.perceptualHash64 !== ledgerRow.perceptualHash64
      )
        throw new RangeError(`Native UI source evidence disagrees for ${id}`)
      const statusRef = artifactRefFromAbsolutePath(
        artifactRoot,
        proofRow.captureStatus.path,
        proofRow.captureStatus.sha256,
      )
      const status = await readPinnedJson(artifactRoot, statusRef, uiCaptureStatusSchema)
      if (
        status.value.order !== proofRow.order ||
        status.value.opaqueCaseId !== id ||
        status.value.stdoutPath !== proofRow.captureLog.path ||
        status.value.stdoutSha256 !== proofRow.captureLog.sha256 ||
        status.value.stderrPath !== proofRow.captureLog.stderrPath ||
        status.value.stderrSha256 !== proofRow.captureLog.stderrSha256 ||
        status.value.captureReceipt.caseId !== id ||
        status.value.captureReceipt.imagePath !== basename(proofRow.capture.path) ||
        status.value.captureReceipt.pngSha256 !== proofRow.capture.pngSha256 ||
        status.value.captureReceipt.rgbSha256 !== proofRow.capture.decodedRgbSha256 ||
        status.value.captureReceipt.preInventorySha256 !== proofRow.inventory.preSha256 ||
        status.value.captureReceipt.postInventorySha256 !== proofRow.inventory.postSha256 ||
        status.value.captureReceipt.preNativeVisibleStateSha256 !==
          proofRow.nativeStateFingerprintSha256 ||
        status.value.captureReceipt.postNativeVisibleStateSha256 !==
          proofRow.nativeStateFingerprintSha256 ||
        status.value.captureReceipt.preQueryMatchCount !== proofRow.targetOracle.preMatchCount ||
        status.value.captureReceipt.postQueryMatchCount !== proofRow.targetOracle.postMatchCount ||
        hashIdentity(status.value.captureReceipt.appBoundary.keys) !==
          hashIdentity(proofRow.appBoundary.environmentKeys) ||
        status.value.captureReceipt.appBoundary['/opt/capture'] !==
          proofRow.appBoundary.captureMountAccess ||
        status.value.captureReceipt.appBoundary['/opt/probe.py'] !==
          proofRow.appBoundary.fingerprintScriptAccess ||
        status.value.captureReceipt.appBoundary.driverEnvironment !==
          proofRow.appBoundary.driverEnvironmentAccess ||
        computeUiVisibleStateFingerprint(status.value.captureReceipt.preNativeVisibleState) !==
          proofRow.nativeStateFingerprintSha256 ||
        computeUiVisibleStateFingerprint(status.value.captureReceipt.postNativeVisibleState) !==
          proofRow.nativeStateFingerprintSha256
      )
        throw new RangeError(`Native UI capture status differs from its state proof for ${id}`)
    }
    if (
      nativePixelNoveltyAudit.rows.some((row) => {
        const distances = pixels.value.rows.map((historical) =>
          hamming64(row.perceptualHash64, historical.perceptualHash64),
        )
        return Math.min(...distances) !== row.nearestHistoricalPerceptualHashHamming
      }) ||
      nativePixelNoveltyAudit.peerPairs.some((pair) => {
        const left = captureLedgerById.get(pair.leftOpaqueCaseId)
        const right = captureLedgerById.get(pair.rightOpaqueCaseId)
        return (
          !left ||
          !right ||
          hamming64(left.perceptualHash64, right.perceptualHash64) !== pair.perceptualHashHamming
        )
      })
    )
      throw new RangeError('Native UI pHash diagnostics do not match the pinned pixels')
    independentRows = sourceRoster.value.rows
    independentRegisteredRows = registry.value.rows
    independentPixels = pixels.value
    independentUnionAudit = unionAudit.value
    independentExclusions = exclusions.value
    independentSourceStateProofSha256 = digestBytes(stateProof.raw)
    independentStateProof = stateProof.value
    independentSourceRosterSha256 = digestBytes(sourceRoster.raw)
    independentRegisteredSourcesSha256 = digestBytes(registry.raw)
  }
  if (variant === 'flat-v2') {
    if (
      !flatAuthority ||
      flatAuthority.priorDevAuthority.sha256 !== PINNED_PRIOR_DEV_AUTHORITY_SHA256
    )
      throw new RangeError('Flat comparison must name the exact original DEV authority')
    const priorRef = await readPinnedJson(
      artifactRoot,
      flatAuthority.priorDevAuthority,
      preparationAuthoritySchema,
    )
    if (
      priorRef.value.freezeId !== 'h8a-fresh-dev40-20261101-v1' ||
      priorRef.value.orderProtocol.sha256 !== authority.orderProtocol.sha256 ||
      priorRef.value.mapRoster.sha256 !== authority.mapRoster.sha256 ||
      priorRef.value.sourceGroupSplit.sha256 !== authority.sourceGroupSplit.sha256 ||
      hashIdentity(priorRef.value.fragments) !== hashIdentity(authority.fragments)
    )
      throw new RangeError('Flat DEV authority changed the original DEV40 cohort boundary')
  }
  verifyOrderProtocol(protocolRef.value)
  await verifySourceClosure(options.sourceRoot, closureRef.value)
  const closureSha256 = digestBytes(closureRef.raw)
  verifyRuntimeEnvironment(runtimeRef.value, closureRef.value, variant)
  const split = splitRef.value
  const groupCommitment = (ids: readonly string[]): string =>
    hashIdentity([...ids].map(normalizeSourceGroup).sort())
  if (
    groupCommitment(split.devSourceGroupIds) !== split.devCommitmentSha256 ||
    groupCommitment(split.qualificationSourceGroupIds) !== split.qualificationCommitmentSha256 ||
    groupCommitment(split.exclusionSourceGroupIds) !== split.exclusionCommitmentSha256
  )
    throw new RangeError('Source-group split/exclusion commitment mismatch')
  if (
    disjointAuthority &&
    (!acceptedHistory ||
      split.devSourceGroupIds.length !== 24 ||
      split.exclusionSourceGroupIds.length !== 396 ||
      split.qualificationSourceGroupIds.length !== 0 ||
      acceptedHistory.allExcludedSourceGroups.some(
        (group) => !split.exclusionSourceGroupIds.includes(normalizeSourceGroup(group)),
      ))
  )
    throw new RangeError(
      'Disjoint source split omits historical groups or changes the committed counts',
    )
  const [fragments, conservativeCostProof] = await Promise.all([
    Promise.all(authority.fragments.map((item) => loadFragment(artifactRoot, item))),
    variant === 'independent-v2'
      ? validateIndependentPriceProof(artifactRoot, priceRef.value, digestBytes(priceRef.raw))
      : validatePriceProof(
          artifactRoot,
          priceProofSchema.parse(priceRef.value),
          digestBytes(priceRef.raw),
          variant !== 'v1',
        ),
  ])
  const reviewById = new Map(
    fragments.flatMap((fragment) =>
      fragment.review.rows.map((row) => [row.opaqueCaseId, { fragment, row }] as const),
    ),
  )
  if (reviewById.size !== fragments.reduce((count, item) => count + item.review.rows.length, 0))
    throw new RangeError('Duplicate row IDs across reviewed fragments')
  const orderRoster = z
    .object({
      schema: z.literal('h8a-fresh-supplemental-source-roster-v2'),
      seedHex: z.literal('76303308'),
      hashInput: z.string().min(1),
      parentProtocolSha256: sha256,
      sourceGroupByFamily: z.record(z.string().min(1)),
      rows: z.array(
        z
          .object({
            familySlug: z.string().min(1),
            predeclaredStateId: z.string().min(1),
            opaqueCaseId: z.string().min(1),
          })
          .strict(),
      ),
    })
    .passthrough()
    .parse(rosterRef.value)
  if (
    orderRoster.parentProtocolSha256 !== authority.orderProtocol.sha256 ||
    orderRoster.rows.length !== 10 ||
    new Set(orderRoster.rows.map((row) => row.opaqueCaseId)).size !== orderRoster.rows.length
  )
    throw new RangeError('Map roster must bind the registered protocol and contain ten unique IDs')
  if (
    orderRoster.hashInput !==
    'UTF-8 bytes, components separated by a single NUL byte, no trailing NUL; lower-case hexadecimal digest'
  )
    throw new RangeError('Map roster hash input contract is unsupported')
  if (
    disjointAuthority &&
    (orderRoster.sourceGroupByFamily.xsok !== 'game:xsok' ||
      orderRoster.sourceGroupByFamily.gnurobbo !== 'game:gnurobbo')
  )
    throw new RangeError('Disjoint map roster must bind the named XSok and GNU Robbo source groups')
  const mapIds = new Set(
    orderRoster.rows.map((row) => {
      if (
        row.opaqueCaseId !==
        expectedMapOpaqueId(orderRoster.seedHex, row.familySlug, row.predeclaredStateId)
      )
        throw new RangeError(
          'Map roster contains an opaque ID that does not match its registered inputs',
        )
      return row.opaqueCaseId
    }),
  )
  for (const id of mapIds) {
    const reviewed = reviewById.get(id)
    if (!reviewed) continue
    const annotation = reviewed.fragment.annotations.find((item) => item.opaqueCaseId === id)
    if (annotation?.stratum !== 'map')
      throw new RangeError('Registered map slot has an accepted row with the wrong stratum')
    const rosterEntry = orderRoster.rows.find((item) => item.opaqueCaseId === id)!
    const groups = orderRoster.sourceGroupByFamily
    if (
      !groups ||
      typeof groups !== 'object' ||
      normalizeSourceGroup(String(Reflect.get(groups, rosterEntry.familySlug))) !==
        normalizeSourceGroup(reviewed.row.sourceGroup)
    )
      throw new RangeError('Reviewed map source group differs from registered family source group')
  }
  const mapReviewIds = [...reviewById.values()]
    .filter(
      (item) =>
        item.fragment.annotations.find((row) => row.opaqueCaseId === item.row.opaqueCaseId)
          ?.stratum === 'map',
    )
    .map((item) => item.row.opaqueCaseId)
  if (mapReviewIds.some((id) => !mapIds.has(id)))
    throw new RangeError('Accepted map rows contain an unregistered slot')
  if (
    independentAuthority &&
    independentRows &&
    independentRegisteredRows &&
    independentPixels &&
    independentUnionAudit &&
    independentExclusions
  ) {
    const mapEntries = new Map(orderRoster.rows.map((row) => [row.opaqueCaseId, row]))
    const registeredById = new Map(independentRegisteredRows.map((row) => [row.opaqueCaseId, row]))
    const historicCaseIds = new Set(independentExclusions.caseIds)
    const historicImageIds = new Set(independentExclusions.imageIds)
    const historicGroups = new Set(independentExclusions.sourceGroups.map(normalizeSourceGroup))
    const historicEncoded = new Set(independentPixels.rows.map((row) => row.encodedSha256))
    const historicHashes = independentPixels.rows.map((row) => row.perceptualHash64)
    const unionById = new Map(independentUnionAudit.rows.map((row) => [row.opaqueCaseId, row]))
    if (
      new Set(independentRows.map((row) => row.opaqueCaseId)).size !== DEV40_CASE_COUNT ||
      new Set(independentRegisteredRows.map((row) => row.opaqueCaseId)).size !== DEV40_CASE_COUNT ||
      new Set(independentUnionAudit.rows.map((row) => row.opaqueCaseId)).size !==
        DEV40_CASE_COUNT ||
      independentRows.some(
        (row, index) => index > 0 && independentRows[index - 1]!.opaqueCaseId >= row.opaqueCaseId,
      ) ||
      independentRegisteredRows.some(
        (row, index) =>
          index > 0 && independentRegisteredRows[index - 1]!.opaqueCaseId >= row.opaqueCaseId,
      ) ||
      independentUnionAudit.rows.some(
        (row, index) =>
          index > 0 && independentUnionAudit.rows[index - 1]!.opaqueCaseId >= row.opaqueCaseId,
      )
    )
      throw new RangeError(
        'Independent DEV40 roster, registry, and source union must have unique sorted IDs',
      )
    if (
      independentRows.length !== DEV40_CASE_COUNT ||
      [...reviewById.keys()].length !== DEV40_CASE_COUNT ||
      independentRegisteredRows.length !== DEV40_CASE_COUNT ||
      independentUnionAudit.rows.length !== DEV40_CASE_COUNT
    )
      throw new RangeError(
        'Independent DEV40 requires the complete forty-row reviewed source cohort',
      )
    for (const row of independentRows) {
      const registered = registeredById.get(row.opaqueCaseId)
      const reviewed = reviewById.get(row.opaqueCaseId)
      const union = unionById.get(row.opaqueCaseId)
      if (!registered || !reviewed || !union)
        throw new RangeError(
          `Independent DEV40 source row ${row.opaqueCaseId} is not fully reviewed`,
        )
      const annotation = reviewed.fragment.annotations.find(
        (item) => item.opaqueCaseId === row.opaqueCaseId,
      )!
      const producer = reviewed.fragment.producerRows.find(
        (item) => item.opaqueCaseId === row.opaqueCaseId,
      )!
      const reviewRow = reviewed.row
      const expectedRegistryRow = {
        opaqueCaseId: row.opaqueCaseId,
        familySlug: row.familySlug,
        predeclaredStateId: row.predeclaredStateId,
        stratum: row.stratum,
        sourceGroup: row.sourceGroup,
        expectedPresence: row.expectedPresence,
        sourceSha256: row.sourceSha256,
        targetTaskSha256: row.targetTaskSha256,
      }
      const expectedTaskSha256 = createHash('sha256')
        .update(producer.targetTaskText, 'utf8')
        .digest('hex')
      if (
        hashIdentity(registered) !== hashIdentity(expectedRegistryRow) ||
        annotation.stratum !== row.stratum ||
        normalizeSourceGroup(annotation.sourceGroup) !== normalizeSourceGroup(row.sourceGroup) ||
        normalizeSourceGroup(row.sourceGroup) !== row.sourceGroup ||
        annotation.expectedPresence !== row.expectedPresence ||
        producer.sourceBytesSha256 !== row.sourceSha256 ||
        reviewRow.sourceSha256 !== row.sourceSha256 ||
        expectedTaskSha256 !== row.targetTaskSha256 ||
        union.encodedSha256 !== row.sourceSha256 ||
        historicCaseIds.has(row.opaqueCaseId) ||
        historicImageIds.has(row.sourceSha256) ||
        historicEncoded.has(row.sourceSha256) ||
        historicGroups.has(normalizeSourceGroup(row.sourceGroup))
      )
        throw new RangeError(
          `Independent DEV40 row ${row.opaqueCaseId} conflicts with its reviewed or historical inputs`,
        )
      if (row.stratum === 'map') {
        const mapRow = mapEntries.get(row.opaqueCaseId)
        if (
          !mapRow ||
          row.familySlug !== mapRow.familySlug ||
          row.predeclaredStateId !== mapRow.predeclaredStateId ||
          normalizeSourceGroup(row.sourceGroup) !==
            normalizeSourceGroup(orderRoster.sourceGroupByFamily[row.familySlug] ?? '')
        )
          throw new RangeError(
            `Independent DEV40 map row ${row.opaqueCaseId} differs from its fixed map roster`,
          )
      }
      const nearestUnion = Math.min(
        ...historicHashes.map((prior) => hamming64(union.perceptualHash64, prior)),
        ...independentUnionAudit.rows
          .filter((other) => other.opaqueCaseId !== union.opaqueCaseId)
          .map((other) => hamming64(union.perceptualHash64, other.perceptualHash64)),
      )
      if (
        union.stratum !== row.stratum ||
        nearestUnion !== union.nearestHamming ||
        (row.stratum !== 'ui' && nearestUnion <= 4)
      )
        throw new RangeError(
          `Independent DEV40 source ${row.opaqueCaseId} fails the pinned source-union pixel-distance gate`,
        )
    }
    for (const stratum of STRATUMS) {
      const rows = independentRows.filter((row) => row.stratum === stratum)
      const quota = DEV40_STRATUM_QUOTAS[stratum]
      if (
        rows.length !== quota.total ||
        rows.filter((row) => row.expectedPresence === 'present').length !== quota.present ||
        rows.filter((row) => row.expectedPresence === 'absent').length !== quota.absent
      )
        throw new RangeError(`Independent DEV40 ${stratum} source quota is incomplete`)
    }
    const photoRows = [...reviewById.values()].flatMap(({ fragment, row }) => {
      const annotation = fragment.annotations.find(
        (item) => item.opaqueCaseId === row.opaqueCaseId,
      )!
      return annotation.stratum === 'photo' ? [annotation] : []
    })
    if (
      photoRows.filter(
        (row) => row.expectedPresence === 'present' && row.exactOriginalCanvasMaskRef,
      ).length !== 16 ||
      photoRows.reduce((count, row) => count + row.referenceMasks.length, 0) !== 16
    )
      throw new RangeError(
        'Independent DEV40 photo cohort must bind sixteen positive original-canvas masks',
      )
    if (
      independentExclusions.sourceGroups.some(
        (group) => !split.exclusionSourceGroupIds.includes(normalizeSourceGroup(group)),
      ) ||
      independentRows.some(
        (row) => !split.devSourceGroupIds.includes(normalizeSourceGroup(row.sourceGroup)),
      )
    )
      throw new RangeError('Independent DEV40 split omits historical or current source groups')
  }
  if (disjointAuthority && registeredSources && acceptedHistory) {
    const registeredRows = registeredSources.rows
    const registeredById = new Map(registeredRows.map((row) => [row.opaqueCaseId, row]))
    if (
      registeredById.size !== DEV40_CASE_COUNT ||
      registeredById.size !== reviewById.size ||
      [...reviewById.keys()].some((id) => !registeredById.has(id))
    )
      throw new RangeError('Disjoint source registry must match the complete reviewed DEV40 ID set')
    const priorIds = new Set(acceptedHistory.priorIds)
    const priorEncoded = new Set(acceptedHistory.priorEncodedSha256)
    const priorGroups = new Set(acceptedHistory.allExcludedSourceGroups.map(normalizeSourceGroup))
    for (const [id, { fragment, row: reviewRow }] of reviewById) {
      const registered = registeredById.get(id)!
      const annotation = fragment.annotations.find((item) => item.opaqueCaseId === id)!
      const producer = fragment.producerRows.find((item) => item.opaqueCaseId === id)!
      if (
        priorIds.has(id) ||
        priorEncoded.has(producer.sourceBytesSha256) ||
        priorGroups.has(normalizeSourceGroup(annotation.sourceGroup)) ||
        registered.stratum !== annotation.stratum ||
        registered.expectedPresence !== annotation.expectedPresence ||
        normalizeSourceGroup(registered.sourceGroup) !==
          normalizeSourceGroup(annotation.sourceGroup) ||
        registered.sourceSha256 !== producer.sourceBytesSha256 ||
        registered.sourceSha256 !== reviewRow.sourceSha256
      )
        throw new RangeError(`Disjoint source registry conflicts with or reuses source row ${id}`)
    }
    for (const stratum of STRATUMS) {
      const rows = registeredRows.filter((row) => row.stratum === stratum)
      const expected = DEV40_STRATUM_QUOTAS[stratum]
      if (
        rows.filter((row) => row.expectedPresence === 'present').length !== expected.present ||
        rows.filter((row) => row.expectedPresence === 'absent').length !== expected.absent
      )
        throw new RangeError(`Disjoint registered ${stratum} presence quotas are invalid`)
    }
    const photoRows = registeredRows.filter((row) => row.stratum === 'photo')
    if (new Set(photoRows.map((row) => normalizeSourceGroup(row.sourceGroup))).size !== 20)
      throw new RangeError('Disjoint photo rows must use twenty distinct author source groups')
    if (new Set(registeredRows.map((row) => normalizeSourceGroup(row.sourceGroup))).size !== 24)
      throw new RangeError(
        'Disjoint cohort must use separate groups for every registered source lane',
      )
    for (const stratum of ['ui', 'map'] as const) {
      const quotas =
        stratum === 'ui'
          ? [
              { sourceGroup: 'gnumeric', present: 4, absent: 1 },
              { sourceGroup: 'evince', present: 3, absent: 2 },
            ]
          : [
              { sourceGroup: 'game:xsok', present: 4, absent: 1 },
              { sourceGroup: 'game:gnurobbo', present: 3, absent: 2 },
            ]
      for (const quota of quotas) {
        const rows = registeredRows.filter(
          (row) =>
            row.stratum === stratum && normalizeSourceGroup(row.sourceGroup) === quota.sourceGroup,
        )
        if (
          rows.length !== 5 ||
          rows.filter((row) => row.expectedPresence === 'present').length !== quota.present ||
          rows.filter((row) => row.expectedPresence === 'absent').length !== quota.absent
        )
          throw new RangeError(
            `Disjoint ${stratum} group ${quota.sourceGroup} does not meet its registered quota`,
          )
      }
    }
    const photoAnnotationRows = [...reviewById.values()].flatMap(({ fragment, row }) => {
      const annotation = fragment.annotations.find(
        (item) => item.opaqueCaseId === row.opaqueCaseId,
      )!
      return annotation.stratum === 'photo' ? [annotation] : []
    })
    if (
      photoAnnotationRows.filter(
        (row) => row.expectedPresence === 'present' && row.exactOriginalCanvasMaskRef,
      ).length !== 16 ||
      photoAnnotationRows.reduce((count, row) => count + row.referenceMasks.length, 0) !== 16
    )
      throw new RangeError('Disjoint photo cohort must contain exactly sixteen positive masks')
  }
  const orderedIds = [...reviewById.keys()].sort((left, right) => {
    const leftHash = protocolHash(['76303308', 'case-order-v1', left])
    const rightHash = protocolHash(['76303308', 'case-order-v1', right])
    return leftHash.localeCompare(rightHash) || left.localeCompare(right)
  })
  const orderedRows = orderedIds.map((id) => {
    const item = reviewById.get(id)!
    return { fragment: item.fragment, reviewRow: item.row }
  })
  const { producerCases, sourceBytesByCaseId, sharpRuntimeDecodedRgbSha256ByCaseId } =
    await verifyCaseInputs(artifactRoot, orderedRows)
  if (new Set(producerCases.map((row) => row.sourceBytesSha256)).size !== producerCases.length)
    throw new RangeError('Reviewed cases must have distinct encoded source bytes')
  if (independentRows && independentUnionAudit) {
    const unionById = new Map(independentUnionAudit.rows.map((row) => [row.opaqueCaseId, row]))
    for (const producer of producerCases) {
      const source = sourceBytesByCaseId.get(producer.opaqueCaseId)
      const expected = unionById.get(producer.opaqueCaseId)
      const sharpRuntimeDecodedRgbSha256 = sharpRuntimeDecodedRgbSha256ByCaseId.get(
        producer.opaqueCaseId,
      )
      if (
        !source ||
        !expected ||
        !sharpRuntimeDecodedRgbSha256 ||
        digestBytes(source) !== expected.encodedSha256 ||
        expected.encodedSha256 !== producer.sourceBytesSha256
      )
        throw new RangeError(
          `Independent source bytes or decoded RGB do not match the pinned union audit for ${producer.opaqueCaseId}`,
        )
      assertSharpRuntimeRgbMatches(
        sharpRuntimeDecodedRgbSha256,
        expected.sharpRuntimeDecodedRgbSha256,
      )
    }
    if (!independentPixels || !independentStateProof || !independentSourceStateProofSha256)
      throw new RangeError('Independent DEV40 pixel or native UI state proof is missing')
    const rosterById = new Map(independentRows.map((row) => [row.opaqueCaseId, row]))
    const proofById = new Map(independentStateProof.rows.map((row) => [row.opaqueCaseId, row]))
    const fingerprintById = new Map<string, string>()
    for (const proofRow of independentStateProof.rows) {
      const rosterRow = rosterById.get(proofRow.opaqueCaseId)
      const producer = producerCases.find((row) => row.opaqueCaseId === proofRow.opaqueCaseId)
      const reviewed = orderedRows.find(
        ({ reviewRow }) => reviewRow.opaqueCaseId === proofRow.opaqueCaseId,
      )
      const union = unionById.get(proofRow.opaqueCaseId)
      if (
        !rosterRow ||
        rosterRow.stratum !== 'ui' ||
        !producer ||
        !reviewed ||
        !union ||
        proofRow.sourceGroup !== rosterRow.sourceGroup ||
        proofRow.stateId !== rosterRow.predeclaredStateId ||
        proofRow.targetOracle.expectedPresence !== rosterRow.expectedPresence ||
        proofRow.capture.pngSha256 !== producer.sourceBytesSha256 ||
        proofRow.capture.decodedRgbSha256 !== union.decodedRgbSha256 ||
        union.sharpRuntimeDecodedRgbSha256 !== union.decodedRgbSha256 ||
        computeUiVisibleStateFingerprint(proofRow.normalizedNativeStateDocument) !==
          proofRow.nativeStateFingerprintSha256
      )
        throw new RangeError(
          `Native UI state proof does not match registered source ${proofRow.opaqueCaseId}`,
        )
      const sourcePath = resolve(artifactRoot, proofRow.capture.path)
      const indexedPath = resolve(reviewed.fragment.controllerPathIndex[proofRow.opaqueCaseId]!)
      if (
        !isAbsolute(proofRow.capture.path) ||
        sourcePath !== proofRow.capture.path ||
        !isWithin(resolve(UI_STATE_DEV40_ROOT), sourcePath) ||
        sourcePath !== indexedPath
      )
        throw new RangeError(
          `Native UI state capture path differs from the reviewed source for ${proofRow.opaqueCaseId}`,
        )
      const captureLogPath = resolve(artifactRoot, proofRow.captureLog.path)
      if (
        !isAbsolute(proofRow.captureLog.path) ||
        captureLogPath !== proofRow.captureLog.path ||
        !isWithin(resolve(UI_STATE_DEV40_ROOT), captureLogPath)
      )
        throw new RangeError('Native UI state capture log escapes the trusted artifact root')
      const captureStderrPath = resolve(artifactRoot, proofRow.captureLog.stderrPath)
      if (
        !isAbsolute(proofRow.captureLog.stderrPath) ||
        captureStderrPath !== proofRow.captureLog.stderrPath ||
        !isWithin(resolve(UI_STATE_DEV40_ROOT), captureStderrPath)
      )
        throw new RangeError('Native UI state capture stderr escapes the registered study root')
      const captureLogRef = artifactRefFromAbsolutePath(
        artifactRoot,
        proofRow.captureLog.path,
        proofRow.captureLog.sha256,
      )
      const captureStderrRef = artifactRefFromAbsolutePath(
        artifactRoot,
        proofRow.captureLog.stderrPath,
        proofRow.captureLog.stderrSha256,
      )
      await Promise.all([
        readPinnedBytes(artifactRoot, captureLogRef),
        readPinnedBytes(artifactRoot, captureStderrRef),
      ])
      fingerprintById.set(proofRow.opaqueCaseId, proofRow.nativeStateFingerprintSha256)
    }
    if (proofById.size !== 10)
      throw new RangeError('Exactly ten registered UI rows require native visible-state proofs')
    validateUiStateSourcePixelPolicy(
      producerCases.map((producer) => {
        const row = rosterById.get(producer.opaqueCaseId)!
        const union = unionById.get(producer.opaqueCaseId)!
        return {
          opaqueCaseId: producer.opaqueCaseId,
          stratum: row.stratum,
          encodedSha256: producer.sourceBytesSha256,
          decodedRgbSha256: unionById.get(producer.opaqueCaseId)!.decodedRgbSha256,
          sharpRuntimeDecodedRgbSha256: sharpRuntimeDecodedRgbSha256ByCaseId.get(
            producer.opaqueCaseId,
          )!,
          perceptualHash64: union.perceptualHash64,
          ...(row.stratum === 'ui'
            ? { visibleStateFingerprintSha256: fingerprintById.get(producer.opaqueCaseId)! }
            : {}),
        }
      }),
      independentPixels!.rows,
    )
  }
  if (mapReviewIds.length !== mapIds.size)
    throw new RangeError(
      `DEV40 incomplete: ${mapIds.size - mapReviewIds.length} registered map rows are missing (accepted ${mapReviewIds.length}/${mapIds.size})`,
    )
  if (orderedIds.length !== DEV40_CASE_COUNT)
    throw new RangeError(
      `DEV40 incomplete: ${DEV40_CASE_COUNT - orderedIds.length} reviewed cases are missing after source-byte verification`,
    )
  const strataById = new Map(
    orderedRows.map(({ fragment, reviewRow }) => [
      reviewRow.opaqueCaseId,
      fragment.annotations.find((item) => item.opaqueCaseId === reviewRow.opaqueCaseId)!.stratum,
    ]),
  )
  const pairedSchedule = scheduleCases(producerCases, strataById)
  const annotationBody = {
    schema: 'h8a-fresh-evaluator-private-v1',
    phaseId,
    freezeId: authority.freezeId,
    independentMaskCaseIds: [],
    cases: orderedRows.map(({ fragment, reviewRow }) =>
      fragment.rawAnnotationRows.get(reviewRow.opaqueCaseId),
    ),
  }
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(annotationBody)
  const evaluatorAnnotationsSha256 = computeEvaluatorAnnotationsSha256(annotations)
  const rawAnnotationDigest = hashIdentity({
    schema: annotationBody.schema,
    phaseId: annotationBody.phaseId,
    freezeId: annotationBody.freezeId,
    independentMaskCaseIds: annotationBody.independentMaskCaseIds,
    cases: annotationBody.cases,
    qualificationSourceGroupsDistinct: null,
  })
  if (evaluatorAnnotationsSha256 !== rawAnnotationDigest)
    throw new RangeError('Annotation schema parse changed the frozen JSON property order')
  const expectedDevGroups = [
    ...new Set(annotations.cases.map((item) => normalizeSourceGroup(item.sourceGroup))),
  ].sort()
  const splitDevGroups = [...split.devSourceGroupIds]
  if (
    new Set(splitDevGroups).size !== splitDevGroups.length ||
    splitDevGroups.some((group) => normalizeSourceGroup(group) !== group) ||
    hashIdentity(expectedDevGroups) !== split.devCommitmentSha256 ||
    expectedDevGroups.length !== splitDevGroups.length ||
    expectedDevGroups.some((group, index) => group !== splitDevGroups[index])
  )
    throw new RangeError(
      'Reviewed source groups do not match the externally pinned DEV source-group set',
    )
  for (const [ids, commitment] of [
    [split.qualificationSourceGroupIds, split.qualificationCommitmentSha256],
    [split.exclusionSourceGroupIds, split.exclusionCommitmentSha256],
  ] as const) {
    const canonical = ids.map(normalizeSourceGroup)
    if (
      new Set(canonical).size !== canonical.length ||
      canonical.some((item, index) => item !== ids[index]) ||
      hashIdentity([...canonical].sort()) !== commitment
    )
      throw new RangeError('Qualification/exclusion source-group commitment is malformed')
  }
  validateSourceGroupSplitSeparation({
    devSourceGroupIds: splitDevGroups,
    qualificationSourceGroupIds: split.qualificationSourceGroupIds,
    exclusionSourceGroupIds: split.exclusionSourceGroupIds,
  })
  const sourceStrataCommitments = STRATUMS.map((stratum) => {
    const sourceGroupIds = annotations.cases
      .filter((item) => item.stratum === stratum)
      .map((item) => item.sourceGroup)
    return {
      stratum,
      caseCount: sourceGroupIds.length,
      sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
        phaseId,
        stratum,
        sourceGroupIds,
      ),
    }
  })
  const producerClosureSha256 = closureSha256
  const sourceBytesManifestSha256 = hashIdentity(
    producerCases.map((item) => item.sourceBytesSha256),
  )
  const cohortCommitmentSha256 = hashIdentity({
    phaseId,
    freezeId: authority.freezeId,
    orderProtocolSha256: authority.orderProtocol.sha256,
    mapRosterSha256: authority.mapRoster.sha256,
    sourceClosureSha256: closureSha256,
    sourceGroupSplitSha256: authority.sourceGroupSplit.sha256,
    runtimeEnvironmentSha256: digestBytes(runtimeRef.raw),
    producerCases,
    pairedSchedule,
    producerClosureSha256,
    sourceBytesManifestSha256,
    evaluatorAnnotationsSha256,
    ...(independentAuthority
      ? {
          independentStudyId: independentAuthority.studyId,
          parentRegistrationSha256: independentAuthority.parentRegistration.sha256,
          parentLedgerAuditSha256: independentAuthority.parentLedgerAudit.sha256,
          historicalExclusionsSha256: independentAuthority.historicalExclusions.sha256,
          historicalPixelsSha256: independentAuthority.historicalPixels.sha256,
          sourceUnionAuditSha256: independentAuthority.sourceUnionAudit.sha256,
          sourceStateProofSha256: independentSourceStateProofSha256,
          sourceRosterSha256: independentSourceRosterSha256,
          registeredSourcesSha256: independentRegisteredSourcesSha256,
        }
      : {}),
    ...(disjointAuthority
      ? {
          parentRegistrationSha256,
          acceptedHistorySha256,
          registeredSourcesSha256,
        }
      : {}),
  })
  const freeze = phaseFreezeSchema.parse({
    schema: H8A_FRESH_SCHEMA,
    freezeId: authority.freezeId,
    phaseId,
    phaseCounts: {
      totalCases: DEV40_CASE_COUNT,
      positiveCases: DEV40_POSITIVE_COUNT,
      negativeCases: DEV40_NEGATIVE_COUNT,
    },
    cohortCommitmentSha256,
    producerClosureSha256,
    sourceBytesManifestSha256,
    sourceStrataCommitments,
    profileBindings: [
      {
        profileId: candidateProfileId,
        recipeIdentitySha256: expectedRecipeIdentity(candidateProfile),
        requestPolicyIdentitySha256: candidateProfile.requestPolicyIdentitySha256,
      },
      {
        profileId: PROFILE_CONTROL_ID,
        recipeIdentitySha256: expectedRecipeIdentity(V02_CONTROL_PROFILE),
        requestPolicyIdentitySha256: V02_CONTROL_PROFILE.requestPolicyIdentitySha256,
      },
    ],
    pairedSchedule,
    producerCases,
    qualificationIndependentMaskCaseIds: [],
    callLimits: {
      candidateMaxPhysicalCallsPerCase: 4,
      controlMaxPhysicalCallsPerCase: 6,
      phaseWorstCasePhysicalCalls: DEV40_WORST_CASE_PHYSICAL_CALLS,
    },
    nativeLimits: {
      avoidConcurrentOwnedNativeWork: true,
      maxPendingNativeJobs: 2,
      maxNativeWorkerThreads: 8,
    },
    deadlineIso: authority.deadlineIso,
    timeoutRetryPolicy: {
      absoluteCaseTimeoutSeconds: 240,
      allowFallbacks: false,
      allowRetries: false,
      sharedAbsoluteTimeoutMs: 240_000,
    },
    outputRowSchemaId: 'h8a-fresh-output-row-v1',
    evaluatorVersion: 'h8a-fresh-evaluator-v1',
    conservativeCostProof,
    enforceQualificationSourceGroupSeparation: false,
    evaluatorAnnotationsSha256,
  })
  validateProfileIdentities(freeze)
  validateConservativeCostProof(freeze)
  const candidateBound =
    conservativeCostProof.profileDispatchUpperBounds[0].maxUsdPerPhysicalDispatch
  const controlBound = conservativeCostProof.profileDispatchUpperBounds[1].maxUsdPerPhysicalDispatch
  if (4 * candidateBound + 6 * controlBound > CAMPAIGN_MAX_COST_USD + 1e-12)
    throw new RangeError('Frozen paired-case price exposure exceeds the campaign ceiling')
  const selection = buildDevScreenSelection(freeze, annotations)
  validateDevScreenSelection(selection, freeze, annotations)
  if (sourceBytesByCaseId.size !== freeze.producerCases.length)
    throw new RangeError('Complete source byte map required before freeze')
  return {
    freeze,
    annotations,
    selection,
    sourceBytesByCaseId,
    sourceClosurePaths: closureRef.value.files.map((file) => file.path),
    runtimeEnvironmentSha256: digestBytes(runtimeRef.raw),
  }
}

export async function writeDevFreezeExclusive(
  outputDirectory: string,
  result: Awaited<ReturnType<typeof assembleDevFreezeFromDisk>>,
): Promise<void> {
  const target = resolve(outputDirectory)
  const parent = dirname(target)
  const staging = `${target}.staging-${process.pid}-${Date.now()}`
  const lock = `${target}.lock`
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  let stagingCreated = false
  try {
    try {
      await lstat(target)
      throw new RangeError('DEV freeze output directory already exists and is immutable')
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
    }
    await mkdir(staging, { mode: 0o700 })
    stagingCreated = true
    await Promise.all([
      writeFile(resolve(staging, 'phase-freeze.json'), `${JSON.stringify(result.freeze)}\n`, {
        flag: 'wx',
        mode: 0o600,
      }),
      writeFile(
        resolve(staging, 'evaluator-private-annotations.json'),
        `${JSON.stringify(result.annotations)}\n`,
        { flag: 'wx', mode: 0o600 },
      ),
      writeFile(
        resolve(staging, 'dev-screen-selection.json'),
        `${JSON.stringify(result.selection)}\n`,
        { flag: 'wx', mode: 0o600 },
      ),
    ])
    await rename(staging, target)
  } catch (error) {
    if (stagingCreated) await rm(staging, { recursive: true, force: true })
    throw error
  } finally {
    await rm(lock, { force: true })
  }
}

export async function verifyPersistedDevFreeze(
  inputDirectory: string,
  options: Omit<DevFreezeAssemblyOptions, 'outputDirectory'>,
): Promise<Awaited<ReturnType<typeof assembleDevFreezeFromDisk>>> {
  const expected = await assembleDevFreezeFromDisk({ ...options, outputDirectory: inputDirectory })
  const root = resolve(inputDirectory)
  if ((await realpath(root)) !== root)
    throw new RangeError('Persisted output directory is symlinked or aliased')
  const [freezeRaw, annotationsRaw, selectionRaw] = await Promise.all([
    readBoundedRegularFile(resolve(root, 'phase-freeze.json'), JSON_FILE_LIMIT_BYTES, root).then(
      (bytes) => bytes.toString('utf8'),
    ),
    readBoundedRegularFile(
      resolve(root, 'evaluator-private-annotations.json'),
      JSON_FILE_LIMIT_BYTES,
      root,
    ).then((bytes) => bytes.toString('utf8')),
    readBoundedRegularFile(
      resolve(root, 'dev-screen-selection.json'),
      JSON_FILE_LIMIT_BYTES,
      root,
    ).then((bytes) => bytes.toString('utf8')),
  ])
  const freeze = phaseFreezeSchema.parse(JSON.parse(freezeRaw))
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(JSON.parse(annotationsRaw))
  const selection = validateDevScreenSelection(JSON.parse(selectionRaw), freeze, annotations)
  if (hashIdentity(freeze) !== hashIdentity(expected.freeze))
    throw new RangeError('Persisted freeze differs from current pinned inputs')
  if (hashIdentity(annotations) !== hashIdentity(expected.annotations))
    throw new RangeError('Persisted annotations differ from current pinned inputs')
  if (hashIdentity(selection) !== hashIdentity(expected.selection))
    throw new RangeError('Persisted draw differs from deterministic nested draw')
  return expected
}
