import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  buildConservativeCostProof,
  buildSyntheticPhaseFreeze,
  buildSyntheticAnnotationBundle,
} from './test-fixtures.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import { hashIdentity } from './hash-identity.js'
import {
  PHASE_NATIVE_SELECTOR_QUAL120_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
} from './constants.js'
import { NATIVE_SELECTOR_PRICE_PROOF } from './dev-replay-study-policy.js'
import {
  NATIVE_SELECTOR_QUAL_FREEZE_ID,
  NATIVE_SELECTOR_QUAL_STUDY_ID,
  nativeSelectorQualProtocolSchema,
} from './native-selector-qual-protocol.js'
import { createNativeSelectorQualOfflineTestAdmission } from './native-selector-qual-admission.js'
import { sha256PackedBytes } from './packed-binary-lsb0.js'

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

export async function buildOfflineAdmission(namespaceRoot: string, photoNearHash = false) {
  const { freeze: initialFreeze, sourceBytesByCaseId: _syntheticSourceBytes } =
    buildSyntheticPhaseFreeze(PHASE_NATIVE_SELECTOR_QUAL120_ID)
  const sourceBytesByCaseId = new Map<string, Uint8Array>()
  const producerCases = await Promise.all(
    initialFreeze.producerCases.map(async (row, index) => {
      const bytes = await sharp({
        create: {
          width: row.sourceCanvasWidth,
          height: row.sourceCanvasHeight,
          channels: 3,
          background: { r: index % 256, g: (index * 3) % 256, b: (index * 7) % 256 },
        },
      })
        .jpeg()
        .toBuffer()
      sourceBytesByCaseId.set(row.opaqueCaseId, new Uint8Array(bytes))
      return { ...row, sourceBytesSha256: sha256(bytes) }
    }),
  )
  const baseFreeze = {
    ...initialFreeze,
    producerCases,
    sourceBytesManifestSha256: hashIdentity(producerCases.map((row) => row.sourceBytesSha256)),
    producerClosureSha256: hashIdentity({
      phaseId: PHASE_NATIVE_SELECTOR_QUAL120_ID,
      producerCases,
    }),
  }
  const deadlineIso = new Date(Date.now() + 60 * 60_000).toISOString()
  const maskBytes = new Uint8Array(8).fill(255)
  const packedMask = sha256PackedBytes(maskBytes)
  const maskCaseIds = new Set(baseFreeze.qualificationIndependentMaskCaseIds)
  const baselineAnnotations = buildSyntheticAnnotationBundle(
    PHASE_NATIVE_SELECTOR_QUAL120_ID,
    NATIVE_SELECTOR_QUAL_FREEZE_ID,
    baseFreeze.producerCases,
    baseFreeze.pairedSchedule,
  )
  const annotationBundle = {
    schema: 'h8a-fresh-evaluator-private-v1' as const,
    phaseId: PHASE_NATIVE_SELECTOR_QUAL120_ID,
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    independentMaskCaseIds: [...baseFreeze.qualificationIndependentMaskCaseIds],
    cases: baseFreeze.producerCases.map((row, index) => {
      const baseline = baselineAnnotations.cases[index]!
      const scheduled = baseFreeze.pairedSchedule[index]!
      const isMasked = maskCaseIds.has(row.opaqueCaseId)
      const group = `offline-qual-${scheduled.stratum}-${index}`
      return {
        opaqueCaseId: row.opaqueCaseId,
        stratum: scheduled.stratum,
        sourceGroup: group,
        expectedPresence: baseline.expectedPresence,
        referenceBoxes: baseline.referenceBoxes,
        referenceMasks: isMasked ? [{ width: 8, height: 8, packedBinarySha256: packedMask }] : [],
        exactOriginalCanvasMaskRef: isMasked,
      }
    }),
  }
  const annotationsById = new Map(annotationBundle.cases.map((row) => [row.opaqueCaseId, row]))
  const sourceStrataCommitments = (['photo', 'ui', 'map'] as const).map((stratum) => {
    const groups = annotationBundle.cases
      .filter((row) => row.stratum === stratum)
      .map((row) => row.sourceGroup)
    return {
      stratum,
      caseCount: groups.length,
      sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
        PHASE_NATIVE_SELECTOR_QUAL120_ID,
        stratum,
        groups,
      ),
    }
  })
  const priceProofSha256 = '433b8c9f8d91c3b52fd2cb08ceb6443a612124349aa3ea6425463e41002e1b4d'
  const baseCostProof = buildConservativeCostProof(0.12, {
    candidateProfileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
    candidateMaxUsdPerPhysicalDispatch: 0.12,
    controlMaxUsdPerPhysicalDispatch: 0.12,
  })
  const { proofSha256: _discardedProof, ...costBody } = baseCostProof
  const conservativeCostProof = {
    ...costBody,
    derivedFrom: `pinned-price-proof-sha256:${priceProofSha256}`,
  }
  const freeze = {
    ...baseFreeze,
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    deadlineIso,
    producerCases,
    sourceStrataCommitments,
    evaluatorAnnotationsSha256: computeEvaluatorAnnotationsSha256(annotationBundle),
    conservativeCostProof: {
      ...conservativeCostProof,
      proofSha256: hashIdentity(conservativeCostProof),
    },
  }
  const sourceDirectory = join(namespaceRoot, 'sources')
  const maskDirectory = join(namespaceRoot, 'masks')
  await mkdir(sourceDirectory, { recursive: true })
  await mkdir(maskDirectory, { recursive: true })
  const sourceManifest = {
    schema: 'h8a-native-selector-qual120-source-manifest-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    sources: producerCases.map((producer) => {
      const bytes = sourceBytesByCaseId.get(producer.opaqueCaseId)!
      const annotation = annotationsById.get(producer.opaqueCaseId)!
      return {
        caseId: producer.opaqueCaseId,
        path: join(sourceDirectory, `${producer.sourceBytesSha256}.jpg`),
        sha256: producer.sourceBytesSha256,
        rgbPixelsSha256: sha256(`rgb-${producer.opaqueCaseId}`),
        pillowCanonicalRgbSha256: sha256(`pillow-${producer.opaqueCaseId}`),
        bytes: bytes.byteLength,
        perceptualHash:
          annotation.stratum === 'ui' || (photoNearHash && annotation.stratum === 'photo')
            ? 'ffffffffffffffff'
            : '0000000000000000',
        sourceGroup: annotation.sourceGroup,
        rightsCommitmentSha256: sha256(`rights-${producer.opaqueCaseId}`),
        annotationProvenanceSha256: sha256(`annotation-${producer.opaqueCaseId}`),
      }
    }),
  }
  for (const source of sourceManifest.sources)
    await writeFile(source.path, sourceBytesByCaseId.get(source.caseId)!, { flag: 'wx' })
  const maskManifest = {
    schema: 'h8a-native-selector-qual120-mask-manifest-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    masks: freeze.qualificationIndependentMaskCaseIds.map((caseId) => {
      const producer = producerCases.find((row) => row.opaqueCaseId === caseId)!
      return {
        caseId,
        path: join(maskDirectory, `${packedMask}.bin`),
        sha256: sha256(maskBytes),
        bytes: maskBytes.byteLength,
        width: producer.sourceCanvasWidth,
        height: producer.sourceCanvasHeight,
        packedBinarySha256: packedMask,
      }
    }),
  }
  await writeFile(maskManifest.masks[0]!.path, maskBytes, { flag: 'wx' })
  const devGroups = Array.from({ length: 40 }, (_, index) => `offline-dev-group-${index}`)
  const devCaseIds = Array.from({ length: 40 }, (_, index) => `offline-dev-case-${index}`)
  const exposed = {
    schema: 'h8a-native-selector-qual120-exposed-exclusion-sources-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    sources: [
      {
        caseId: 'offline-excluded-case',
        sourceBytesSha256: sha256('excluded-source'),
        sharpRuntimeDecodedRgbSha256: sha256('excluded-rgb'),
        pillowCanonicalRgbSha256: sha256('excluded-pillow'),
        perceptualHash: 'ffffffffffffffff',
        sourceGroup: 'offline-excluded-group',
      },
    ],
  }
  const parentSourceAuditSha256 = sha256('synthetic-parent-source-audit')
  const exposedBytes = Buffer.from(JSON.stringify(exposed))
  const exclusionAudit = {
    schema: 'h8a-native-selector-qual120-exclusion-audit-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    checkedSourceCommit: 'f'.repeat(40),
    devCaseIds,
    excludedCaseIds: [exposed.sources[0]!.caseId],
    devSourceGroups: devGroups,
    excludedSourceGroups: [exposed.sources[0]!.sourceGroup],
    qualSourceGroups: sourceManifest.sources.map((row) => row.sourceGroup),
    devEncodedHashes: devCaseIds.map((id) => sha256(`dev-${id}`)),
    excludedEncodedHashes: [exposed.sources[0]!.sourceBytesSha256],
    devRgbHashes: devCaseIds.flatMap((id) => [sha256(`dev-rgb-${id}`), sha256(`dev-pillow-${id}`)]),
    excludedRgbHashes: [
      exposed.sources[0]!.sharpRuntimeDecodedRgbSha256,
      exposed.sources[0]!.pillowCanonicalRgbSha256,
    ],
    devPerceptualHashes: devCaseIds.map(() => 'ffffffffffffffff'),
    excludedPerceptualHashes: [exposed.sources[0]!.perceptualHash],
    allEncodedHashesDisjoint: true as const,
    allRgbHashesDisjoint: true as const,
    perceptualHashPolicy:
      'photo-map-hamming-distance-greater-than-4;ui-diagnostic-only-v1' as const,
    allSourceGroupsDisjoint: true as const,
    qualificationGroupsMayRepeatWithinSplit: true as const,
    parentDevSourceAuditSha256: parentSourceAuditSha256,
    exposedExclusionAuditSha256: sha256(exposedBytes),
  }
  const rightsPolicy = {
    schema: 'h8a-native-selector-qual120-source-rights-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    sources: sourceManifest.sources.map((source) => ({
      caseId: source.caseId,
      sourceSha256: source.sha256,
      rightsEvidenceSha256: source.rightsCommitmentSha256,
      permittedUse: 'offline-benchmark-evaluation' as const,
    })),
  }
  const annotationProvenancePolicy = {
    schema: 'h8a-native-selector-qual120-annotation-provenance-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    annotations: sourceManifest.sources.map((source) => ({
      caseId: source.caseId,
      sourceSha256: source.sha256,
      provenanceSha256: source.annotationProvenanceSha256,
      annotationMethod: 'independent-human-review-v1' as const,
      packedMaskSha256:
        annotationsById.get(source.caseId)?.referenceMasks[0]?.packedBinarySha256 ?? null,
    })),
  }
  const acquisitionPolicy = {
    schema: 'h8a-native-selector-qual120-acquisition-policy-v1',
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    selectedRecipeSha256: freeze.profileBindings[0]!.recipeIdentitySha256,
    selectionMethod: 'blind-stratified-source-selection-v1' as const,
    outcomesUnavailableDuringSelection: true as const,
    noCaseSelectionByCandidateOutcome: true as const,
    sourceBytesRemainUnmodified: true as const,
    augmentationsOrLabelFitting: false as const,
    exactStrata: {
      photo: { present: 30, absent: 10 },
      ui: { present: 30, absent: 10 },
      map: { present: 30, absent: 10 },
    },
    independentMaskCaseCount: 30 as const,
    sourceGroupRepeatsWithinSplitAllowed: true as const,
    crossSplitGroupOverlapAllowed: false as const,
  }
  const refsRoot = join(namespaceRoot, 'metadata')
  await mkdir(refsRoot, { recursive: true })
  const childValues = [
    freeze,
    annotationBundle,
    sourceManifest,
    maskManifest,
    exclusionAudit,
    exposed,
    acquisitionPolicy,
    rightsPolicy,
    annotationProvenancePolicy,
  ]
  const childNames = [
    'freeze',
    'annotations',
    'sources',
    'masks',
    'exclusion',
    'exposed',
    'acquisition',
    'rights',
    'provenance',
  ]
  const childRefs = childValues.map((value, index) => {
    const bytes = Buffer.from(JSON.stringify(value))
    return {
      path: join(refsRoot, `${childNames[index]}.json`),
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }
  })
  for (let index = 0; index < childValues.length; index++)
    await writeFile(childRefs[index]!.path, JSON.stringify(childValues[index]), { flag: 'wx' })
  const [
    freezeRef,
    annotationRef,
    sourceRef,
    maskRef,
    exclusionRef,
    exposedRef,
    acquisitionRef,
    rightsRef,
    provenanceRef,
  ] = childRefs
  const dummyRef = (name: string) => ({
    path: join(namespaceRoot, `${name}.json`),
    sha256: sha256(name),
    bytes: name.length + 1,
  })
  const offlineParentRoot = join(namespaceRoot, 'parent')
  await mkdir(offlineParentRoot, { recursive: true })
  const protocol = nativeSelectorQualProtocolSchema.parse({
    schema: 'h8a-native-selector-qual120-protocol-v1',
    studyId: NATIVE_SELECTOR_QUAL_STUDY_ID,
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    phaseId: PHASE_NATIVE_SELECTOR_QUAL120_ID,
    parentDev: {
      root: offlineParentRoot,
      protocol: dummyRef('parent-protocol'),
      freeze: dummyRef('parent-freeze'),
      annotations: dummyRef('parent-annotations'),
      sourceAudit: {
        path: join(offlineParentRoot, 'source-audit.json'),
        sha256: parentSourceAuditSha256,
        bytes: 1,
      },
      producerClosure: dummyRef('parent-closure'),
      candidateCloseout: dummyRef('parent-candidate'),
      controlCloseout: dummyRef('parent-control'),
      dev40Closeout: dummyRef('parent-closeout'),
      ledger: dummyRef('parent-ledger'),
      registration: dummyRef('parent-registration'),
      stageReports: [dummyRef('report8'), dummyRef('report12'), dummyRef('report40')],
      stageReviews: [dummyRef('review8'), dummyRef('review12'), dummyRef('review40')],
    },
    freeze: freezeRef,
    annotations: annotationRef,
    sourceManifest: sourceRef,
    referenceMaskManifest: maskRef,
    exclusionAudit: exclusionRef,
    exposedExclusions: exposedRef,
    acquisitionPolicy: acquisitionRef,
    rightsPolicy: rightsRef,
    annotationProvenancePolicy: provenanceRef,
    producerClosure: dummyRef('qual-closure'),
    runtimeProof: dummyRef('runtime-proof'),
    runtimeEnvironment: dummyRef('runtime-env'),
    nativeAssetsProof: dummyRef('assets'),
    priceProof: { path: NATIVE_SELECTOR_PRICE_PROOF.path, sha256: priceProofSha256, bytes: 1 },
    policy: {
      selectionPolicyId: 'native-categorical-all-stages-v1',
      selectionPolicySha256: '67593b86c44a23231a191b04b2b453d608a2a79161080de7594050d1b4c7b4e0',
      recipeIdentitySha256: freeze.profileBindings[0]!.recipeIdentitySha256,
      controlRecipeIdentitySha256: freeze.profileBindings[1]!.recipeIdentitySha256,
      producerSourceCommit: 'f'.repeat(40),
      producerClosureSha256: freeze.producerClosureSha256,
      queryPolicySha256: '8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc',
      presencePolicySha256: '0a59411c518355279f60dba58f3d26b7910b81ad88cd3238f91214654a8c4fac',
      priceProofSha256,
    },
    budget: {
      globalPhysicalCallLimit: 2000,
      phasePhysicalCallLimit: 1200,
      candidateMaxCallsPerCase: 4,
      controlMaxCallsPerCase: 6,
      reservedUsdPerPhysicalDispatch: 0.12,
      phaseExposureUsd: 144,
      ownerDollarCeilingUsd: null,
      retries: 0,
    },
    acquisitionPolicyFrozenBeforeOutcomes: true,
    annotationPolicyFrozenBeforeOutcomes: true,
    noRealQualificationDataOpenedAtProtocolAuthoring: true,
  })
  const protocolBytes = Buffer.from(JSON.stringify(protocol))
  const protocolPath = join(namespaceRoot, 'protocol.json')
  await writeFile(protocolPath, protocolBytes, { flag: 'wx' })
  const metadata = {
    freezeValue: freeze,
    annotationsValue: annotationBundle,
    sourceManifestValue: sourceManifest,
    maskManifestValue: maskManifest,
    exclusionAuditValue: exclusionAudit,
    exposedExclusionsValue: exposed,
    acquisitionPolicyValue: acquisitionPolicy,
    rightsPolicyValue: rightsPolicy,
    annotationProvenancePolicyValue: annotationProvenancePolicy,
  }
  const sourceBytes = new Map(sourceBytesByCaseId)
  const referenceMaskBytes = new Map([[packedMask, maskBytes]])
  const admission = await createNativeSelectorQualOfflineTestAdmission({
    offlineTestOnly: true,
    namespaceRoot,
    protocolBytes,
    protocolSha256: sha256(protocolBytes),
    offlineTestDeadlineIso: deadlineIso,
    offlineTestNow: Date.now(),
    ...metadata,
    parentFreezePolicyValue: freeze,
    sourceBytes,
    referenceMaskBytes,
    parent: {
      parentLedgerVersion: 317,
      parentPhysicalDispatchCount: 317,
      parentLogicalAttemptCount: 100,
      parentKnownCostUsd: 100,
      parentUnknownReserveUsd: 1,
      parentNextPhysicalId: 318,
      parentNextReservationId: 500,
    },
  })
  return { admission, sourceBytes, protocolBytes, protocolPath, metadata, namespaceRoot }
}
