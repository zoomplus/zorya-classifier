import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  PHASE_NATIVE_SELECTOR_QUAL120_ID,
  PROFILE_CONTROL_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
  QUAL120_CASE_COUNT,
  QUAL120_NEGATIVE_COUNT,
  QUAL120_POSITIVE_COUNT,
  QUAL120_STRATUM_COUNT,
  STRATUMS,
} from './constants.js'
import { phaseFreezeSchema, evaluatorPrivateAnnotationBundleSchema } from './schemas.js'
import type { PhaseFreeze, EvaluatorPrivateAnnotationBundle } from './schemas.js'
import type { VerifiedHistoricalExclusionSets } from './native-selector-qual-historical-exclusions.js'
import { nativeSelectorQualHistoricalExclusionsSchema } from './native-selector-qual-historical-exclusions.js'
import {
  computeSourceGroupStratumCommitmentSha256,
  validateSourceGroupSplitSeparation,
} from './source-group-validation.js'

export const NATIVE_SELECTOR_QUAL_STUDY_ID = 'native-selector-flat-qual120-v1' as const
export const NATIVE_SELECTOR_QUAL_FREEZE_ID =
  'h8a-native-selector-flat-qual120-20261102-v1' as const
export const NATIVE_SELECTOR_QUAL_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/native-selector-flat-qual120-v1' as const
export const NATIVE_SELECTOR_QUAL_LEDGER_PATH =
  `${NATIVE_SELECTOR_QUAL_ROOT}/admission/campaign-ledger.json` as const
export const NATIVE_SELECTOR_QUAL_DEADLINE_ISO = '2026-11-02T12:11:51.738Z' as const

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const fileRefSchema = z
  .object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().positive() })
  .strict()
const parentGraphSchema = z
  .object({
    root: z.string().min(1),
    protocol: fileRefSchema,
    freeze: fileRefSchema,
    annotations: fileRefSchema,
    sourceAudit: fileRefSchema,
    producerClosure: fileRefSchema,
    candidateCloseout: fileRefSchema,
    controlCloseout: fileRefSchema,
    dev40Closeout: fileRefSchema,
    ledger: fileRefSchema,
    registration: fileRefSchema,
    stageReports: z.tuple([fileRefSchema, fileRefSchema, fileRefSchema]),
    stageReviews: z.tuple([fileRefSchema, fileRefSchema, fileRefSchema]),
  })
  .strict()
const acquisitionPolicySchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-acquisition-policy-v1'),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    selectedRecipeSha256: digest,
    selectionMethod: z.enum(['blind-stratified-source-selection-v1']),
    outcomesUnavailableDuringSelection: z.literal(true),
    noCaseSelectionByCandidateOutcome: z.literal(true),
    sourceBytesRemainUnmodified: z.literal(true),
    augmentationsOrLabelFitting: z.literal(false),
    exactStrata: z
      .object({
        photo: z.object({ present: z.literal(30), absent: z.literal(10) }).strict(),
        ui: z.object({ present: z.literal(30), absent: z.literal(10) }).strict(),
        map: z.object({ present: z.literal(30), absent: z.literal(10) }).strict(),
      })
      .strict(),
    independentMaskCaseCount: z.literal(30),
    sourceGroupRepeatsWithinSplitAllowed: z.literal(true),
    crossSplitGroupOverlapAllowed: z.literal(false),
  })
  .strict()
const rightsPolicySchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-source-rights-v1'),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    sources: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            sourceSha256: digest,
            rightsEvidenceSha256: digest,
            permittedUse: z.literal('offline-benchmark-evaluation'),
          })
          .strict(),
      )
      .length(QUAL120_CASE_COUNT),
  })
  .strict()
export const nativeSelectorQualAnnotationProvenancePolicySchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-annotation-provenance-v1'),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    annotations: z
      .array(
        z.discriminatedUnion('annotationMethod', [
          z
            .object({
              caseId: z.string().min(1),
              sourceSha256: digest,
              provenanceSha256: digest,
              annotationMethod: z.literal('independent-human-review-v1'),
              packedMaskSha256: digest.nullable(),
            })
            .strict(),
          z
            .object({
              caseId: z.string().min(1),
              sourceSha256: digest,
              provenanceSha256: digest,
              annotationMethod: z.literal('published-ground-truth-v1'),
              packedMaskSha256: digest.nullable(),
            })
            .strict(),
          z
            .object({
              caseId: z.string().min(1),
              sourceSha256: digest,
              provenanceSha256: digest,
              annotationMethod: z.literal('independent-source-oracle-v1'),
              packedMaskSha256: z.null(),
              sourceOracleProof: fileRefSchema,
            })
            .strict(),
        ]),
      )
      .length(QUAL120_CASE_COUNT),
  })
  .strict()

export const nativeSelectorQualProtocolSchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-protocol-v1'),
    studyId: z.literal(NATIVE_SELECTOR_QUAL_STUDY_ID),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    phaseId: z.literal(PHASE_NATIVE_SELECTOR_QUAL120_ID),
    parentDev: parentGraphSchema,
    freeze: fileRefSchema,
    annotations: fileRefSchema,
    sourceManifest: fileRefSchema,
    referenceMaskManifest: fileRefSchema,
    exclusionAudit: fileRefSchema,
    exposedExclusions: fileRefSchema,
    acquisitionPolicy: fileRefSchema,
    rightsPolicy: fileRefSchema,
    annotationProvenancePolicy: fileRefSchema,
    producerClosure: fileRefSchema,
    runtimeProof: fileRefSchema,
    runtimeEnvironment: fileRefSchema,
    nativeAssetsProof: fileRefSchema,
    priceProof: fileRefSchema
      .extend({
        sha256: z.literal('433b8c9f8d91c3b52fd2cb08ceb6443a612124349aa3ea6425463e41002e1b4d'),
      })
      .strict(),
    policy: z
      .object({
        selectionPolicyId: z.literal('native-categorical-all-stages-v1'),
        selectionPolicySha256: z.literal(
          '67593b86c44a23231a191b04b2b453d608a2a79161080de7594050d1b4c7b4e0',
        ),
        recipeIdentitySha256: digest,
        controlRecipeIdentitySha256: digest,
        producerSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
        producerClosureSha256: digest,
        queryPolicySha256: z.literal(
          '8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc',
        ),
        presencePolicySha256: z.literal(
          '0a59411c518355279f60dba58f3d26b7910b81ad88cd3238f91214654a8c4fac',
        ),
        priceProofSha256: z.literal(
          '433b8c9f8d91c3b52fd2cb08ceb6443a612124349aa3ea6425463e41002e1b4d',
        ),
      })
      .strict(),
    budget: z
      .object({
        globalPhysicalCallLimit: z.literal(2_000),
        phasePhysicalCallLimit: z.literal(1_200),
        candidateMaxCallsPerCase: z.literal(4),
        controlMaxCallsPerCase: z.literal(6),
        reservedUsdPerPhysicalDispatch: z.literal(0.12),
        phaseExposureUsd: z.literal(144),
        ownerDollarCeilingUsd: z.null(),
        retries: z.literal(0),
      })
      .strict(),
    acquisitionPolicyFrozenBeforeOutcomes: z.literal(true),
    annotationPolicyFrozenBeforeOutcomes: z.literal(true),
    noRealQualificationDataOpenedAtProtocolAuthoring: z.literal(true),
  })
  .strict()

type NativeSelectorQualProtocol = z.infer<typeof nativeSelectorQualProtocolSchema>
export const nativeSelectorQualSourceManifestSchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-source-manifest-v1'),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    sources: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            path: z.string().min(1),
            sha256: digest,
            rgbPixelsSha256: digest,
            pillowCanonicalRgbSha256: digest,
            bytes: z.number().int().positive(),
            perceptualHash: z.string().regex(/^[a-f0-9]{16}$/u),
            sourceGroup: z.string().min(1),
            rightsCommitmentSha256: digest,
            annotationProvenanceSha256: digest,
          })
          .strict(),
      )
      .length(QUAL120_CASE_COUNT),
  })
  .strict()

export const nativeSelectorQualMaskManifestSchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-mask-manifest-v1'),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    masks: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            path: z.string().min(1),
            sha256: digest,
            bytes: z.number().int().positive(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            packedBinarySha256: digest,
          })
          .strict(),
      )
      .length(30),
  })
  .strict()

export const nativeSelectorQualExclusionAuditSchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-exclusion-audit-v1'),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    checkedSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    devCaseIds: z.array(z.string().min(1)).length(40),
    excludedCaseIds: z.array(z.string().min(1)),
    devSourceGroups: z.array(z.string().min(1)),
    excludedSourceGroups: z.array(z.string().min(1)),
    qualSourceGroups: z.array(z.string().min(1)).length(QUAL120_CASE_COUNT),
    devEncodedHashes: z.array(digest),
    excludedEncodedHashes: z.array(digest),
    devRgbHashes: z.array(digest),
    excludedRgbHashes: z.array(digest),
    devPerceptualHashes: z.array(z.string().min(1)),
    excludedPerceptualHashes: z.array(z.string().min(1)),
    allEncodedHashesDisjoint: z.literal(true),
    allRgbHashesDisjoint: z.literal(true),
    perceptualHashPolicy: z.literal(
      'photo-map-hamming-distance-greater-than-4;ui-diagnostic-only-v1',
    ),
    allSourceGroupsDisjoint: z.literal(true),
    qualificationGroupsMayRepeatWithinSplit: z.literal(true),
    parentDevSourceAuditSha256: digest,
    exposedExclusionAuditSha256: digest,
  })
  .strict()

export const nativeSelectorQualExposedExclusionsSchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-exposed-exclusion-sources-v1'),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    sources: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            sourceBytesSha256: digest,
            sharpRuntimeDecodedRgbSha256: digest,
            pillowCanonicalRgbSha256: digest,
            perceptualHash: z.string().regex(/^[a-f0-9]{16}$/u),
            sourceGroup: z.string().min(1),
          })
          .strict(),
      )
      .min(0),
    historical: nativeSelectorQualHistoricalExclusionsSchema.optional(),
  })
  .strict()

export interface VerifiedNativeSelectorQualProtocol {
  protocol: NativeSelectorQualProtocol
  protocolSha256: string
  selectionCommitmentSha256: string
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  sourceManifest: z.infer<typeof nativeSelectorQualSourceManifestSchema>
  maskManifest: z.infer<typeof nativeSelectorQualMaskManifestSchema>
  exclusionAudit: z.infer<typeof nativeSelectorQualExclusionAuditSchema>
  exposedExclusions: z.infer<typeof nativeSelectorQualExposedExclusionsSchema>
}

function hammingDistance64(left: string, right: string): number {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let count = 0
  while (bits !== 0n) {
    count += Number(bits & 1n)
    bits >>= 1n
  }
  return count
}

export function hashQualProtocolFileBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

type QualExclusionAuditRows = Pick<
  z.infer<typeof nativeSelectorQualExclusionAuditSchema>,
  | 'devSourceGroups'
  | 'excludedEncodedHashes'
  | 'excludedRgbHashes'
  | 'excludedPerceptualHashes'
  | 'excludedSourceGroups'
>
type QualExplicitExclusion = z.infer<
  typeof nativeSelectorQualExposedExclusionsSchema
>['sources'][number]

/** Match historical exclusions as sets; preserve the legacy explicit-row multiset contract. */
export function assertNativeSelectorQualExclusionAuditCoverage(input: {
  audit: QualExclusionAuditRows
  explicitSources: readonly QualExplicitExclusion[]
  historical?: VerifiedHistoricalExclusionSets
}): void {
  const history = input.historical
  const expectedEncoded = [
    ...input.explicitSources.map((row) => row.sourceBytesSha256),
    ...(history?.encodedHashes ?? []),
  ]
  const expectedRgb = input.explicitSources
    .flatMap((row) => [row.sharpRuntimeDecodedRgbSha256, row.pillowCanonicalRgbSha256])
    .concat(history?.pillowRgbHashes ?? [])
  const expectedPerceptual = [
    ...input.explicitSources.map((row) => row.perceptualHash),
    ...(history?.perceptualHashes ?? []),
  ]
  const expectedGroups = history
    ? [
        ...input.explicitSources.map((row) => row.sourceGroup.replace(/\/+$/u, '')),
        ...history.sourceGroups.map((group) => group.replace(/\/+$/u, '')),
      ]
    : input.explicitSources.map((row) => row.sourceGroup)
  if (history) {
    if (
      !sameSet(
        input.audit.devSourceGroups.map((group) => group.replace(/\/+$/u, '')),
        history.devSourceGroups,
      ) ||
      !sameSet(input.audit.excludedEncodedHashes, expectedEncoded) ||
      !sameSet(input.audit.excludedRgbHashes, expectedRgb) ||
      !sameSet(input.audit.excludedPerceptualHashes, expectedPerceptual) ||
      !sameSet(input.audit.excludedSourceGroups, expectedGroups)
    )
      throw new RangeError('QUAL exclusions do not match their pinned source manifest')
    return
  }
  if (
    !sameMultiset(input.audit.excludedEncodedHashes, expectedEncoded) ||
    !sameMultiset(input.audit.excludedRgbHashes, expectedRgb) ||
    !sameMultiset(input.audit.excludedPerceptualHashes, expectedPerceptual) ||
    !sameMultiset(input.audit.excludedSourceGroups, expectedGroups)
  )
    throw new RangeError('QUAL exclusions do not match their pinned source manifest')
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return (
    leftSet.size === left.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  )
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  )
}

export function validateNativeSelectorQualMetadata(input: {
  freezeValue: unknown
  annotationsValue: unknown
  sourceManifestValue: unknown
  maskManifestValue: unknown
  exclusionAuditValue: unknown
  exposedExclusionsValue: unknown
  acquisitionPolicyValue: unknown
  rightsPolicyValue: unknown
  annotationProvenancePolicyValue: unknown
  protocolSha256: string
  protocolBytes: Uint8Array
  offlineTestOnly?: true
  offlineTestDeadlineIso?: string
  offlineTestNow?: number
  historicalExclusionSets?: VerifiedHistoricalExclusionSets
}): VerifiedNativeSelectorQualProtocol {
  const protocolValue: unknown = JSON.parse(Buffer.from(input.protocolBytes).toString('utf8'))
  const protocol = nativeSelectorQualProtocolSchema.parse(protocolValue)
  if (
    !digest.safeParse(input.protocolSha256).success ||
    hashQualProtocolFileBytes(input.protocolBytes) !== input.protocolSha256
  )
    throw new RangeError('QUAL protocol digest mismatch')
  const freeze = phaseFreezeSchema.parse(input.freezeValue)
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(input.annotationsValue)
  const sourceManifest = nativeSelectorQualSourceManifestSchema.parse(input.sourceManifestValue)
  const maskManifest = nativeSelectorQualMaskManifestSchema.parse(input.maskManifestValue)
  const exclusionAudit = nativeSelectorQualExclusionAuditSchema.parse(input.exclusionAuditValue)
  const exposedExclusions = nativeSelectorQualExposedExclusionsSchema.parse(
    input.exposedExclusionsValue,
  )
  if (!exposedExclusions.sources.length && !input.historicalExclusionSets)
    throw new RangeError('QUAL exclusions require explicit rows or verified parent-linked history')
  if (Boolean(exposedExclusions.historical) !== Boolean(input.historicalExclusionSets))
    throw new RangeError(
      'QUAL historical exclusion pins were not validated against the selected parent',
    )
  const acquisitionPolicy = acquisitionPolicySchema.parse(input.acquisitionPolicyValue)
  const rightsPolicy = rightsPolicySchema.parse(input.rightsPolicyValue)
  const annotationPolicy = nativeSelectorQualAnnotationProvenancePolicySchema.parse(
    input.annotationProvenancePolicyValue,
  )
  const expectedDeadline =
    input.offlineTestOnly === true
      ? z.string().datetime({ offset: true }).parse(input.offlineTestDeadlineIso)
      : NATIVE_SELECTOR_QUAL_DEADLINE_ISO
  if (
    input.offlineTestOnly === true &&
    Date.parse(expectedDeadline) <= (input.offlineTestNow ?? Date.now())
  )
    throw new RangeError('Offline QUAL test deadline must be in the future')
  if (
    freeze.freezeId !== protocol.freezeId ||
    freeze.phaseId !== protocol.phaseId ||
    freeze.phaseCounts.totalCases !== QUAL120_CASE_COUNT ||
    freeze.phaseCounts.positiveCases !== QUAL120_POSITIVE_COUNT ||
    freeze.phaseCounts.negativeCases !== QUAL120_NEGATIVE_COUNT ||
    freeze.producerCases.length !== QUAL120_CASE_COUNT ||
    freeze.qualificationIndependentMaskCaseIds.length !== 30 ||
    !freeze.enforceQualificationSourceGroupSeparation ||
    freeze.deadlineIso !== expectedDeadline ||
    freeze.callLimits.candidateMaxPhysicalCallsPerCase !==
      protocol.budget.candidateMaxCallsPerCase ||
    freeze.callLimits.controlMaxPhysicalCallsPerCase !== protocol.budget.controlMaxCallsPerCase ||
    freeze.callLimits.phaseWorstCasePhysicalCalls !== protocol.budget.phasePhysicalCallLimit ||
    annotations.freezeId !== freeze.freezeId ||
    annotations.phaseId !== freeze.phaseId ||
    annotations.cases.length !== QUAL120_CASE_COUNT ||
    annotations.independentMaskCaseIds.length !== 30 ||
    sourceManifest.freezeId !== freeze.freezeId ||
    sourceManifest.sources.length !== QUAL120_CASE_COUNT ||
    maskManifest.freezeId !== freeze.freezeId ||
    exclusionAudit.freezeId !== freeze.freezeId
  )
    throw new RangeError('QUAL metadata does not match the fixed native-selector freeze')
  const bindings = freeze.profileBindings
  if (
    bindings[0]?.profileId !== PROFILE_NATIVE_SELECTOR_CANDIDATE_ID ||
    bindings[1]?.profileId !== PROFILE_CONTROL_ID ||
    bindings[0]?.recipeIdentitySha256 !== protocol.policy.recipeIdentitySha256 ||
    bindings[1]?.recipeIdentitySha256 !== protocol.policy.controlRecipeIdentitySha256 ||
    freeze.producerClosureSha256 !== protocol.policy.producerClosureSha256 ||
    freeze.conservativeCostProof.derivedFrom !==
      `pinned-price-proof-sha256:${protocol.policy.priceProofSha256}`
  )
    throw new RangeError(
      'QUAL producer identity differs from the frozen native-selector DEV recipe',
    )
  const producerIds = freeze.producerCases.map((row) => row.opaqueCaseId)
  const sourceIds = sourceManifest.sources.map((row) => row.caseId)
  const annotationIds = annotations.cases.map((row) => row.opaqueCaseId)
  if (
    new Set(producerIds).size !== QUAL120_CASE_COUNT ||
    JSON.stringify(producerIds) !== JSON.stringify(sourceIds) ||
    JSON.stringify(producerIds) !== JSON.stringify(annotationIds) ||
    new Set(maskManifest.masks.map((row) => row.caseId)).size !== 30 ||
    JSON.stringify(freeze.qualificationIndependentMaskCaseIds) !==
      JSON.stringify(annotations.independentMaskCaseIds)
  )
    throw new RangeError('QUAL ordered case and mask commitments disagree')
  const groupIds = sourceManifest.sources.map((item) => item.sourceGroup)
  if (
    acquisitionPolicy.freezeId !== freeze.freezeId ||
    acquisitionPolicy.selectedRecipeSha256 !== protocol.policy.recipeIdentitySha256 ||
    acquisitionPolicy.exactStrata.photo.present !== QUAL120_STRATUM_COUNT ||
    acquisitionPolicy.exactStrata.ui.present !== QUAL120_STRATUM_COUNT ||
    acquisitionPolicy.exactStrata.map.present !== QUAL120_STRATUM_COUNT ||
    rightsPolicy.freezeId !== freeze.freezeId ||
    annotationPolicy.freezeId !== freeze.freezeId ||
    exposedExclusions.freezeId !== freeze.freezeId
  )
    throw new RangeError('QUAL acquisition, rights, or annotation policies do not match the freeze')
  const rightsById = new Map(rightsPolicy.sources.map((row) => [row.caseId, row]))
  const provenanceById = new Map(annotationPolicy.annotations.map((row) => [row.caseId, row]))
  if (
    rightsById.size !== QUAL120_CASE_COUNT ||
    provenanceById.size !== QUAL120_CASE_COUNT ||
    sourceManifest.sources.some((source) => {
      const rights = rightsById.get(source.caseId)
      const provenance = provenanceById.get(source.caseId)
      const annotation = annotations.cases.find((row) => row.opaqueCaseId === source.caseId)
      return (
        !rights ||
        rights.sourceSha256 !== source.sha256 ||
        rights.rightsEvidenceSha256 !== source.rightsCommitmentSha256 ||
        !provenance ||
        provenance.sourceSha256 !== source.sha256 ||
        provenance.provenanceSha256 !== source.annotationProvenanceSha256 ||
        (provenance.annotationMethod === 'independent-source-oracle-v1' &&
          (annotation?.stratum === 'photo' ||
            (annotation?.referenceMasks.length ?? 0) !== 0 ||
            provenance.packedMaskSha256 !== null ||
            provenance.sourceOracleProof.sha256 !== provenance.provenanceSha256)) ||
        provenance.packedMaskSha256 !== (annotation?.referenceMasks[0]?.packedBinarySha256 ?? null)
      )
    })
  )
    throw new RangeError(
      'QUAL source rights or annotation provenance evidence does not bind the frozen inputs',
    )
  const producerById = new Map(freeze.producerCases.map((item) => [item.opaqueCaseId, item]))
  const independentMaskIds = annotations.independentMaskCaseIds
  const maskIds = maskManifest.masks.map((item) => item.caseId)
  if (
    groupIds.some(
      (group) =>
        exclusionAudit.devSourceGroups.includes(group) ||
        exclusionAudit.excludedSourceGroups.includes(group),
    ) ||
    new Set(producerIds).size !== producerIds.length ||
    producerIds.some((id, index) => {
      const source = sourceManifest.sources[index]
      const producer = producerById.get(id)
      return !source || !producer || source.sha256 !== producer.sourceBytesSha256
    }) ||
    sourceManifest.sources.some((item) => {
      const annotation = annotations.cases.find((row) => row.opaqueCaseId === item.caseId)
      const pixelHashes = [item.rgbPixelsSha256, item.pillowCanonicalRgbSha256]
      const exactInputOverlap =
        exclusionAudit.devEncodedHashes.includes(item.sha256) ||
        exclusionAudit.excludedEncodedHashes.includes(item.sha256) ||
        pixelHashes.some(
          (hash) =>
            exclusionAudit.devRgbHashes.includes(hash) ||
            exclusionAudit.excludedRgbHashes.includes(hash),
        )
      const perceptualHashes = [
        ...exclusionAudit.devPerceptualHashes,
        ...exclusionAudit.excludedPerceptualHashes,
      ]
      const closePhotoOrMap =
        annotation?.stratum !== 'ui' &&
        perceptualHashes.some(
          (hash) =>
            /^[a-f0-9]{16}$/u.test(hash) && hammingDistance64(item.perceptualHash, hash) <= 4,
        )
      return exactInputOverlap || closePhotoOrMap
    }) ||
    JSON.stringify(maskIds) !== JSON.stringify(independentMaskIds) ||
    maskManifest.masks.some((mask) => {
      const annotation = annotations.cases.find((row) => row.opaqueCaseId === mask.caseId)
      const producer = producerById.get(mask.caseId)
      const reference = annotation?.referenceMasks[0]
      return (
        annotation?.stratum !== 'photo' ||
        annotation.expectedPresence !== 'present' ||
        !annotation.exactOriginalCanvasMaskRef ||
        !reference ||
        reference.width !== producer?.sourceCanvasWidth ||
        reference.height !== producer?.sourceCanvasHeight ||
        reference.width !== mask.width ||
        reference.height !== mask.height ||
        reference.packedBinarySha256 !== mask.packedBinarySha256
      )
    })
  )
    throw new RangeError('QUAL source groups intersect DEV or excluded groups')
  const historical = input.historicalExclusionSets
  if (exclusionAudit.exposedExclusionAuditSha256 !== protocol.exposedExclusions.sha256)
    throw new RangeError('QUAL exclusions do not match their pinned source manifest')
  assertNativeSelectorQualExclusionAuditCoverage({
    audit: exclusionAudit,
    explicitSources: exposedExclusions.sources,
    ...(historical ? { historical } : {}),
  })
  validateSourceGroupSplitSeparation({
    devSourceGroupIds: exclusionAudit.devSourceGroups,
    qualificationSourceGroupIds: groupIds,
    exclusionSourceGroupIds: exclusionAudit.excludedSourceGroups,
  })
  for (const stratum of STRATUMS) {
    const groupsForStratum = annotations.cases
      .filter((row) => row.stratum === stratum)
      .map((row) => row.sourceGroup)
    const commitment = freeze.sourceStrataCommitments.find((row) => row.stratum === stratum)
    if (
      !commitment ||
      commitment.sourceGroupCommitmentSha256 !==
        computeSourceGroupStratumCommitmentSha256(freeze.phaseId, stratum, groupsForStratum)
    )
      throw new RangeError(`QUAL ${stratum} source-group commitment mismatch`)
  }
  for (const stratum of STRATUMS) {
    const rows = annotations.cases.filter((item) => item.stratum === stratum)
    if (rows.length !== QUAL120_STRATUM_COUNT + QUAL120_NEGATIVE_COUNT / STRATUMS.length)
      throw new RangeError(`QUAL ${stratum} case count mismatch`)
    const positives = rows.filter((item) => item.expectedPresence === 'present').length
    const negatives = rows.filter((item) => item.expectedPresence === 'absent').length
    if (
      positives !== QUAL120_STRATUM_COUNT ||
      negatives !== QUAL120_NEGATIVE_COUNT / STRATUMS.length
    )
      throw new RangeError(`QUAL ${stratum} presence quota mismatch`)
  }
  return {
    protocol,
    protocolSha256: input.protocolSha256,
    selectionCommitmentSha256: createHash('sha256')
      .update(
        JSON.stringify({
          schema: 'h8a-native-selector-qual-selection-commitment-v1',
          freezeId: freeze.freezeId,
          phaseId: freeze.phaseId,
          sourceManifestSha256: protocol.sourceManifest.sha256,
          orderedCaseIds: producerIds,
        }),
      )
      .digest('hex'),
    freeze,
    annotations,
    sourceManifest,
    maskManifest,
    exclusionAudit,
    exposedExclusions,
  }
}
