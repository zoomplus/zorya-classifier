import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import sharp from 'sharp'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
import { H6_PRESENCE_POLICY_SHA256 } from '../h6-presence-policy.js'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import { phaseFreezeSchema, evaluatorPrivateAnnotationBundleSchema } from './schemas.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { unpackBinaryLsb0V1 } from './packed-binary-lsb0.js'
import { assertReferenceBoxesWithinCanvas, assertReferenceMaskDeclaration } from './evaluator.js'
import {
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_PATH,
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
  UI_STATE_DEV40_RUNTIME_PROOF_PATH,
  UI_STATE_DEV40_RUNTIME_PROOF_SHA256,
} from './ui-state-dev40-policy.js'
import { buildDevScreenSelection } from './dev-screen-sampling.js'
import {
  PHASE_FLAT_DEV40_ID,
  PHASE_SCOPE_DEV40_ID,
  PHASE_NATIVE_PRESENCE_DEV40_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  STRATUMS,
} from './constants.js'
import type { PhaseFreeze, EvaluatorPrivateAnnotationBundle } from './schemas.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import { profileById } from './profiles.js'
import { hashIdentity } from './hash-identity.js'
import { validateConservativeCostProof } from './freeze-admission.js'
import { validateAuthoredScopeReplayParentPair } from './dev-replay-ledger.js'
import { assertClosedReplayRetargetIdentity } from './dev-replay-retarget.js'
import {
  isWithinDirectory,
  parseReplayJson,
  readPinnedReplayFile,
  replaySha256,
} from './dev-replay-files.js'
import {
  LEGACY_REPLAY_FREEZE_ID,
  LEGACY_REPLAY_ROOT,
  LEGACY_REPLAY_STUDY_ID,
  AUTHORED_SCOPE_STUDY_ID,
  NATIVE_PRESENCE_STUDY_ID,
  NATIVE_PRESENCE_FREEZE_ID,
  NATIVE_PRESENCE_POLICY,
  REPLAY_STUDY_REGISTRY,
  replayStudyPolicy,
} from './dev-replay-study-policy.js'

export const PROVIDER_REFUSAL_REPLAY_STUDY_ID = LEGACY_REPLAY_STUDY_ID
export const PROVIDER_REFUSAL_REPLAY_FREEZE_ID = LEGACY_REPLAY_FREEZE_ID
export const PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO = '2026-11-02T12:11:51.738Z' as const
const PROVIDER_REFUSAL_REPLAY_PROTOCOL_SCHEMA = 'h8a-provider-refusal-replay-protocol-v1' as const
export const PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256 =
  '5e7f8db8bbdd59c39d04bd78536fead6dd269568f5816872e0cbfef48e18736a' as const
export const PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/refusal-policy/admission-parent-audit-v1.json' as const
export const PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/refusal-policy/replay-input-byte-audit-v1.json' as const
export const PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256 =
  'e02247808e499bc34b59bb3b7d6588899d5202d939a38c13dec35436d181ba56' as const
export const PROVIDER_REFUSAL_REPLAY_ROOT = LEGACY_REPLAY_ROOT
export const PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH = resolve(
  '/root/.codex/artifacts',
  UI_STATE_DEV40_RUNTIME_PROOF_PATH,
)
export const PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH = resolve(
  '/root/.codex/artifacts',
  UI_STATE_DEV40_RUNTIME_ENVIRONMENT_PATH,
)

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const refSchema = z.object({ path: z.string().min(1), sha256: digest }).strict()
const sourceRefSchema = refSchema
  .extend({ caseId: z.string().min(1), bytes: z.number().int().nonnegative() })
  .strict()
const maskRefSchema = refSchema.extend({ packedBinarySha256: digest }).strict()
const budgetSchema = z
  .object({
    globalPhysicalCallLimit: z.literal(2_000),
    dev40PhysicalCallLimit: z.literal(400),
    candidateMaxCallsPerCase: z.literal(4),
    controlMaxCallsPerCase: z.literal(6),
    candidateMaxUsdPerDispatch: z.literal(0.55),
    controlMaxUsdPerDispatch: z.literal(0.12),
    ownerDollarCeilingUsd: z.null(),
  })
  .strict()

export const providerRefusalReplayProtocolSchema = z
  .object({
    schema: z.literal(PROVIDER_REFUSAL_REPLAY_PROTOCOL_SCHEMA),
    studyId: z.literal(PROVIDER_REFUSAL_REPLAY_STUDY_ID),
    freezeId: z.literal(PROVIDER_REFUSAL_REPLAY_FREEZE_ID),
    deadlineIso: z.literal(PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO),
    parentAudit: z
      .object({
        path: z.literal(PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH),
        sha256: z.literal(PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256),
      })
      .strict(),
    sourceAudit: z
      .object({
        path: z.literal(PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH),
        sha256: z.literal(PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256),
      })
      .strict(),
    freeze: refSchema,
    annotations: refSchema,
    selection: refSchema,
    producerClosure: refSchema,
    runtimeProof: z
      .object({
        path: z.literal(PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH),
        sha256: z.literal(UI_STATE_DEV40_RUNTIME_PROOF_SHA256),
      })
      .strict(),
    runtimeEnvironment: z
      .object({
        path: z.literal(PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH),
        sha256: z.literal(UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256),
      })
      .strict(),
    sourceBytes: z.array(sourceRefSchema).length(40),
    referenceMasks: z.array(maskRefSchema).length(16),
    executionPolicy: z.literal(PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256),
    budget: budgetSchema,
    noRetryOrFallback: z.literal(true),
    physicalCallsAt: z.literal('fetch'),
  })
  .strict()

type ProviderRefusalReplayProtocol = z.infer<typeof providerRefusalReplayProtocolSchema>
export interface VerifiedProviderRefusalReplayAdmission {
  protocol: ProviderRefusalReplayProtocol
  protocolSha256: string
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  selection: ReturnType<typeof buildDevScreenSelection>
  sourceBytes: ReadonlyMap<string, Uint8Array>
  referenceMaskBytes: ReadonlyMap<string, Uint8Array>
  freezeCommitmentSha256: string
}

const parentRefs = [
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/campaign-ledger.json',
    'b3c2348e09d8459ebc8b6935b03753c6b1082ce1f0f6584656bd8f39c4ca727b',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/registration.json',
    'b424367e0d588b71119a08934357cced87ec4f455997345123819365d785b882',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/terminal-stop.json',
    '653a03a34a5b06d5957e95726f494f58c1ef7acf78ec9ce6b790522881aa0f48',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/reviews/dev40-review.json',
    'f195f8d66c68321bc792f8c4063e31f478f77f65a095ffc5273dcfd8b4e4592c',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/closeouts/successor-study-closeout.json',
    'd85e742de02161b8bca18aa644b8758628709ec737d530baf8521b588c9b66f0',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/closeouts/dev40-candidate-closeout.json',
    'fef904dbfb3dcc8b0bb4f8d8a3240c08e461f1ee3c45722e38a247cc8a838db0',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/successor-campaign/closeouts/dev40-control-closeout.json',
    'ad9ef8a5802d24756c5958d0d543a95dc6263928dbac4e9c07dce0d119b23fb7',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/freeze/phase-freeze.json',
    'c39ba4e8dc8bb01dd5066baec878555d3332b3f8dd0d7742ccb2cd29ce27ebd5',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/ui-state-dev40-v1/admission/execution-v2/freeze/evaluator-private-annotations.json',
    '319135bbf6f4b3b7fc4e2bf718c7fa57c06312f168091c378851d1536f54cf3c',
  ],
  [
    '/root/.codex/artifacts/zorya-classifier-mcp-20261101/h8a-fresh-dev-qual-campaign-v1/campaign-ledger.json',
    '839ad2eaa441eafbc85a998e6f89df053ff616d8109fa1d92909cd1cefd99d9a',
  ],
] as const

export function assertBeforeDeadline(deadlineIso: string, now = Date.now()): void {
  const deadline = Date.parse(deadlineIso)
  if (!Number.isFinite(deadline) || now >= deadline)
    throw new RangeError('Provider refusal replay deadline is closed')
}

export function assertAdmissionDeadline(
  deadlineIso: string,
  now: number,
  allowExpiredReadOnly: boolean,
): void {
  if (!Number.isFinite(Date.parse(deadlineIso))) throw new RangeError('Replay deadline is invalid')
  if (!allowExpiredReadOnly) assertBeforeDeadline(deadlineIso, now)
}

const inside = isWithinDirectory
const readRegularPinned = readPinnedReplayFile
const parseJson = parseReplayJson

interface ReplaySourcePin {
  caseId: string
  path: string
  sha256: string
  bytes: number
}

interface ReplayProducerSource {
  opaqueCaseId: string
  sourceBytesSha256: string
  sourceCanvasWidth: number
  sourceCanvasHeight: number
  targetTaskText: string
}

interface ReplaySourceAuditRow {
  opaqueCaseId: string
  sourceBytesSha256: string
  sourceCanvasWidth: number
  sourceCanvasHeight: number
  targetTaskText: string
  sourcePath: string
  encodedBytes: number
  sharpRuntimeDecodedRgbSha256: string
  pillowCanonicalRgbSha256: string
}

/** Shared source-byte, independent audit, and Sharp runtime RGB qualification. */
async function verifyReplaySourceBundle(
  producerCases: readonly ReplayProducerSource[],
  sourcePins: readonly ReplaySourcePin[],
  auditRows: readonly ReplaySourceAuditRow[],
): Promise<Map<string, Uint8Array>> {
  const sources = new Map<string, ReplaySourcePin>()
  for (const source of sourcePins) {
    const absolute = resolve(source.path)
    if (!inside(resolve('/root/.codex/artifacts'), absolute) || sources.has(source.caseId))
      throw new RangeError('Replay source is outside trusted artifacts or repeats a case identity')
    sources.set(source.caseId, source)
  }
  const auditedRows = new Map(auditRows.map((row) => [row.opaqueCaseId, row]))
  if (sources.size !== producerCases.length || auditedRows.size !== producerCases.length)
    throw new RangeError('Replay source bytes and independent audit must cover the frozen cohort')

  const sourceBytes = new Map<string, Uint8Array>()
  for (const producer of producerCases) {
    const source = sources.get(producer.opaqueCaseId)
    const audit = auditedRows.get(producer.opaqueCaseId)
    if (
      !source ||
      !audit ||
      source.sha256 !== producer.sourceBytesSha256 ||
      audit.sourceBytesSha256 !== producer.sourceBytesSha256 ||
      audit.sourceCanvasWidth !== producer.sourceCanvasWidth ||
      audit.sourceCanvasHeight !== producer.sourceCanvasHeight ||
      audit.targetTaskText !== producer.targetTaskText ||
      audit.sourcePath !== source.path ||
      producer.sourceCanvasWidth * producer.sourceCanvasHeight > 2_097_152
    )
      throw new RangeError(
        'Replay source differs from the frozen producer row or independent audit',
      )
    const bytes = await readRegularPinned(source.path, source.sha256, 16 * 1024 * 1024)
    if (bytes.length !== source.bytes || bytes.length !== audit.encodedBytes)
      throw new RangeError('Replay source byte length differs from its frozen audit')
    const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 2_097_152 }).metadata()
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.orientation !== undefined && metadata.orientation !== 1) ||
      metadata.width !== producer.sourceCanvasWidth ||
      metadata.height !== producer.sourceCanvasHeight
    )
      throw new RangeError('Replay image dimensions or orientation differ from the frozen canvas')
    const decoded = await sharp(bytes, { failOn: 'error', limitInputPixels: 2_097_152 })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (
      decoded.info.channels !== 3 ||
      decoded.info.width !== producer.sourceCanvasWidth ||
      decoded.info.height !== producer.sourceCanvasHeight ||
      replaySha256(decoded.data) !== audit.sharpRuntimeDecodedRgbSha256
    )
      throw new RangeError('Replay Sharp RGB differs from the separately pinned runtime decode')
    sourceBytes.set(producer.opaqueCaseId, new Uint8Array(bytes))
  }
  return sourceBytes
}

/** Shared packed-mask digest, uniqueness, and LSB0 dimensions/padding qualification. */
async function verifyReplayReferenceMasks(
  annotations: EvaluatorPrivateAnnotationBundle,
  references: readonly { path: string; sha256: string; packedBinarySha256: string }[],
): Promise<Map<string, Uint8Array>> {
  validateReplayMaskSet(annotations, references)
  const bytesByHash = new Map<string, Uint8Array>()
  for (const reference of references) {
    const absolute = resolve(reference.path)
    if (!inside(resolve('/root/.codex/artifacts'), absolute))
      throw new RangeError('Replay reference mask is outside trusted artifacts')
    const bytes = await readRegularPinned(absolute, reference.sha256, 8 * 1024 * 1024)
    if (replaySha256(bytes) !== reference.packedBinarySha256)
      throw new RangeError('Replay packed mask digest differs from its private annotation')
    assertPackedReplayMaskBytes(annotations, reference.packedBinarySha256, bytes)
    bytesByHash.set(reference.packedBinarySha256, new Uint8Array(bytes))
  }
  return bytesByHash
}

export function validateReplayMaskSet(
  annotations: EvaluatorPrivateAnnotationBundle,
  references: readonly { packedBinarySha256: string }[],
): void {
  const maskRefs = new Map(references.map((reference) => [reference.packedBinarySha256, reference]))
  const requiredHashes = new Set(
    annotations.cases.flatMap((row) => row.referenceMasks.map((mask) => mask.packedBinarySha256)),
  )
  if (
    maskRefs.size !== references.length ||
    requiredHashes.size !== references.length ||
    [...requiredHashes].some((hash) => !maskRefs.has(hash))
  )
    throw new RangeError('Replay protocol mask set differs from private annotations')
}

export function assertPackedReplayMaskBytes(
  annotations: EvaluatorPrivateAnnotationBundle,
  packedBinarySha256: string,
  bytes: Uint8Array,
): void {
  if (replaySha256(bytes) !== packedBinarySha256)
    throw new RangeError('Replay packed mask digest differs from its private annotation')
  const matchingMasks = annotations.cases
    .flatMap((row) => row.referenceMasks)
    .filter((mask) => mask.packedBinarySha256 === packedBinarySha256)
  if (matchingMasks.length !== 1)
    throw new RangeError('Replay packed mask must bind exactly one private annotation')
  unpackBinaryLsb0V1(matchingMasks[0]!.width, matchingMasks[0]!.height, bytes)
}

function semanticFreeze(freeze: PhaseFreeze): unknown {
  const {
    freezeId: _freezeId,
    producerClosureSha256: _closure,
    evaluatorAnnotationsSha256: _annotations,
    executionPolicy: _policy,
    deadlineIso: _deadlineIso,
    ...retained
  } = freeze
  return retained
}

function semanticAnnotations(annotations: EvaluatorPrivateAnnotationBundle): unknown {
  const { freezeId: _freezeId, ...retained } = annotations
  return retained
}

export async function verifyProviderRefusalReplayAdmission(input: {
  protocolPath: string
  protocolSha256: string
  repositoryRoot: string
  now?: () => number
  allowExpiredReadOnly?: boolean
}): Promise<VerifiedProviderRefusalReplayAdmission> {
  const protocolPath = input.protocolPath
  const protocolSha256 = input.protocolSha256
  const repositoryRoot = input.repositoryRoot
  const now = input.now
  const allowExpiredReadOnly = input.allowExpiredReadOnly
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot))
    throw new RangeError('Replay repository root must be absolute')
  if (allowExpiredReadOnly !== undefined && typeof allowExpiredReadOnly !== 'boolean')
    throw new RangeError('Expired-read-only selector must be boolean')
  if (now !== undefined && typeof now !== 'function')
    throw new RangeError('Replay clock must be a function')
  if (
    typeof protocolPath !== 'string' ||
    typeof protocolSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(protocolSha256)
  )
    throw new RangeError('Replay protocol pin is invalid')
  const protocolBytes = await readRegularPinned(protocolPath, protocolSha256, 2 * 1024 * 1024)
  const protocol = providerRefusalReplayProtocolSchema.parse(parseJson(protocolBytes))
  assertAdmissionDeadline(
    protocol.deadlineIso,
    now?.() ?? Date.now(),
    allowExpiredReadOnly === true,
  )
  const parentAuditBytes = await readRegularPinned(
    protocol.parentAudit.path,
    protocol.parentAudit.sha256,
  )
  const parentAudit = z
    .object({
      schema: z.literal('h8a-provider-refusal-replay-parent-audit-v1'),
      priorStudyStatus: z.literal('sealed-terminal-stop'),
      inputPending: z.literal(false),
      references: z.array(z.object({ path: z.string(), sha256: digest }).strict()).length(10),
      baseline: z
        .object({
          physicalDispatchCount: z.literal(202),
          logicalCaseAttemptCount: z.literal(63),
          knownCostUsd: z.literal(0.11840506499999993),
          unknownReserveUsd: z.literal(0.24),
          nextPhysicalId: z.literal(203),
          nextReservationId: z.literal(203),
          uncertainPhysicalDispatchCount: z.literal(0),
          inFlightReservations: z.literal(0),
        })
        .strict(),
      sourceCases: z.literal(40),
      qual120Eligible: z.literal(false),
      qualificationResult: z.null(),
      reclassificationsPerformed: z.literal(0),
      providerCallsPerformed: z.literal(0),
    })
    .passthrough()
    .parse(parseJson(parentAuditBytes))
  for (const expected of parentRefs) {
    const ref = parentAudit.references.find((candidate) => candidate.path === expected[0])
    if (!ref || ref.sha256 !== expected[1])
      throw new RangeError('Pinned parent audit lineage differs from the preregistered study')
    await readRegularPinned(ref.path, ref.sha256, 4 * 1024 * 1024)
  }
  const sourceAuditBytes = await readRegularPinned(
    protocol.sourceAudit.path,
    protocol.sourceAudit.sha256,
    16 * 1024 * 1024,
  )
  const sourceAudit = z
    .object({
      schema: z.literal('h8a-replay-original-input-byte-audit-v1'),
      sourceClaim: z.literal('same-disclosed-development-inputs'),
      sourceRosterTargetHashContract: z.literal('sha256-raw-utf8'),
      decodedRgbContract: z.literal(
        'pillow-rgb-canonical-identity-and-sharp-srgb-runtime-decoder-v1',
      ),
      freezeId: z.literal('h8a-ui-native-state-dev40-20261101-v1'),
      sourceCases: z.literal(40),
      referenceMasksVerified: z.literal(16),
      allEncodedBytesAndRuntimeRgbMatch: z.literal(true),
      providerCalls: z.literal(0),
      nativeInferenceCalls: z.literal(0),
      references: z
        .array(z.object({ path: z.string().min(1), sha256: digest }).strict())
        .length(15),
      rows: z
        .array(
          z
            .object({
              opaqueCaseId: z.string().min(1),
              sourceBytesSha256: digest,
              sourceCanvasWidth: z.number().int().positive(),
              sourceCanvasHeight: z.number().int().positive(),
              targetTaskText: z.string().min(1),
              sourcePath: z.string().min(1),
              encodedBytes: z.number().int().positive(),
              sharpRuntimeDecodedRgbSha256: digest,
              pillowCanonicalRgbSha256: digest,
            })
            .strict(),
        )
        .length(40),
    })
    .passthrough()
    .parse(parseJson(sourceAuditBytes))
  const trustedArtifactRoot = resolve('/root/.codex/artifacts')
  for (const reference of sourceAudit.references) {
    const path = resolve(reference.path)
    if (!inside(trustedArtifactRoot, path))
      throw new RangeError(
        'Pinned source acceptance reference is outside the trusted artifact root',
      )
    await readRegularPinned(path, reference.sha256, 16 * 1024 * 1024)
  }
  const protocolFiles = [
    protocol.freeze,
    protocol.annotations,
    protocol.selection,
    protocol.producerClosure,
    protocol.runtimeProof,
    protocol.runtimeEnvironment,
  ]
  for (const file of protocolFiles) {
    const absolute = resolve(file.path)
    if (!inside(trustedArtifactRoot, absolute))
      throw new RangeError('Protocol metadata path is outside the trusted artifact root')
    await readRegularPinned(
      absolute,
      file.sha256,
      file === protocol.producerClosure ? 16 * 1024 * 1024 : 4 * 1024 * 1024,
    )
  }
  const oldFreezeBytes = await readRegularPinned(parentRefs[7][0], parentRefs[7][1])
  const oldFreeze = phaseFreezeSchema.parse(parseJson(oldFreezeBytes))
  const nextFreeze = phaseFreezeSchema.parse(
    parseJson(await readRegularPinned(protocol.freeze.path, protocol.freeze.sha256)),
  )
  const sourceBytes = await verifyReplaySourceBundle(
    nextFreeze.producerCases,
    protocol.sourceBytes,
    sourceAudit.rows,
  )
  if (
    nextFreeze.freezeId !== protocol.freezeId ||
    nextFreeze.phaseId !== PHASE_FLAT_DEV40_ID ||
    nextFreeze.deadlineIso !== protocol.deadlineIso ||
    JSON.stringify(nextFreeze.executionPolicy) !==
      JSON.stringify(PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY)
  )
    throw new RangeError('New DEV40 freeze does not bind the registered refusal replay policy')
  if (nextFreeze.producerClosureSha256 !== protocol.producerClosure.sha256)
    throw new RangeError('New DEV40 freeze closure digest differs from the pinned producer closure')
  if (Date.parse(oldFreeze.deadlineIso) !== Date.parse(nextFreeze.deadlineIso))
    throw new RangeError('Replay deadline differs from the original frozen absolute deadline')
  if (JSON.stringify(semanticFreeze(nextFreeze)) !== JSON.stringify(semanticFreeze(oldFreeze)))
    throw new RangeError('DEV40 source cohort, schedule, recipe, or execution limits changed')
  const oldAnnotations = evaluatorPrivateAnnotationBundleSchema.parse(
    parseJson(await readRegularPinned(parentRefs[8][0], parentRefs[8][1])),
  )
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(
    parseJson(await readRegularPinned(protocol.annotations.path, protocol.annotations.sha256)),
  )
  if (
    annotations.freezeId !== nextFreeze.freezeId ||
    JSON.stringify(semanticAnnotations(annotations)) !==
      JSON.stringify(semanticAnnotations(oldAnnotations)) ||
    computeEvaluatorAnnotationsSha256(annotations) !== nextFreeze.evaluatorAnnotationsSha256
  )
    throw new RangeError('Private DEV40 annotations changed beyond their new freeze binding')
  const producerByCaseId = new Map(nextFreeze.producerCases.map((row) => [row.opaqueCaseId, row]))
  for (const annotation of annotations.cases) {
    const producer = producerByCaseId.get(annotation.opaqueCaseId)
    if (!producer) throw new RangeError('Private annotation references an unknown replay case')
    assertReferenceBoxesWithinCanvas(
      annotation,
      producer.sourceCanvasWidth,
      producer.sourceCanvasHeight,
    )
    assertReferenceMaskDeclaration(
      annotation,
      producer.sourceCanvasWidth,
      producer.sourceCanvasHeight,
    )
    if (
      annotation.referenceMasks.some(
        (mask) =>
          mask.width !== producer.sourceCanvasWidth || mask.height !== producer.sourceCanvasHeight,
      )
    )
      throw new RangeError('Reference mask dimensions differ from the source canvas')
  }
  const referenceMaskBytes = await verifyReplayReferenceMasks(annotations, protocol.referenceMasks)
  const selection = buildDevScreenSelection(nextFreeze, annotations)
  const suppliedSelection = parseJson(
    await readRegularPinned(protocol.selection.path, protocol.selection.sha256),
  )
  if (JSON.stringify(selection) !== JSON.stringify(suppliedSelection))
    throw new RangeError(
      'Nested DEV8/DEV12 selection differs from deterministic freeze-derived selection',
    )
  if (
    nextFreeze.profileBindings[0].profileId !== PROFILE_FLAT_CANDIDATE_ID ||
    nextFreeze.profileBindings[1].profileId !== PROFILE_CONTROL_ID
  )
    throw new RangeError(
      'Replay freeze must retain the explicit flat candidate and historical control',
    )
  assertAdmissionDeadline(
    protocol.deadlineIso,
    now?.() ?? Date.now(),
    allowExpiredReadOnly === true,
  )
  return {
    protocol,
    protocolSha256,
    freeze: nextFreeze,
    annotations,
    selection,
    sourceBytes,
    referenceMaskBytes,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(nextFreeze),
  }
}

const scopeDigest = z.string().regex(/^[a-f0-9]{64}$/u)
const scopeRef = z.object({ path: z.string().min(1), sha256: scopeDigest }).strict()
const scopeSourceRef = scopeRef
  .extend({ caseId: z.string().min(1), bytes: z.number().int().positive() })
  .strict()
const scopeMaskRef = scopeRef.extend({ packedBinarySha256: scopeDigest }).strict()
const nativePresenceParentAuditSchema = z
  .object({
    schema: z.literal('main-native-presence-prospective-parent-audit-v1'),
    priorStudyId: z.literal(AUTHORED_SCOPE_STUDY_ID),
    priorStudyStatus: z.literal('sealed-terminal-stop'),
    references: z
      .array(
        z
          .object({
            path: z.string().min(1),
            sha256: scopeDigest,
            bytes: z.number().int().positive(),
          })
          .strict(),
      )
      .length(15),
    baseline: z
      .object({
        ledgerVersion: z.literal(161),
        registrationSha256: z.literal(
          'c4063132a0686713d7165aa1ff797a6cccd18b49755d493b2b9ef454aef1a17a',
        ),
        physicalDispatchCount: z.literal(276),
        logicalAttemptCount: z.literal(87),
        knownCostUsd: z.literal(0.17121459),
        unknownReserveUsd: z.literal(0.24),
        nextPhysicalId: z.literal(277),
        nextReservationId: z.literal(277),
        uncertainPhysicalDispatchCount: z.literal(0),
      })
      .strict(),
    inFlightReservations: z.literal(0),
    resumeBlocked: z.literal(false),
    crashRecoveryLatched: z.literal(false),
    integrityBlocked: z.literal(false),
    qualEligible: z.literal(false),
    qualificationResult: z.null(),
    newProviderCalls: z.literal(0),
    newNativeInferenceCalls: z.literal(0),
    currentQualityStopPreserved: z.literal(true),
    noPendingUserInput: z.literal(true),
    newStudyRegistered: z.literal(false),
  })
  .strict()

export const authoredScopeReplayProtocolSchema = z
  .object({
    schema: z.literal('h8a-authored-scope-replay-protocol-v1'),
    studyId: z.literal('authored-scope-dev40-v1'),
    freezeId: z.literal('h8a-authored-scope-dev40-20261101-v1'),
    deadlineIso: z.literal('2026-11-02T12:11:51.738Z'),
    parentAudit: z
      .object({
        path: z.literal(
          '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/parent-admission-audit-v1.json',
        ),
        sha256: z.literal('80bdf20178c11f1e578ecaae24d177099c414500874a485a0e64e5d974bfdac7'),
      })
      .strict(),
    sourceAudit: z
      .object({
        path: z.literal(PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_PATH),
        sha256: z.literal(PROVIDER_REFUSAL_REPLAY_INPUT_AUDIT_SHA256),
      })
      .strict(),
    freeze: scopeRef,
    annotations: scopeRef,
    selection: scopeRef,
    producerClosure: scopeRef,
    runtimeProof: z
      .object({
        path: z.literal(PROVIDER_REFUSAL_REPLAY_RUNTIME_PROOF_PATH),
        sha256: z.literal(UI_STATE_DEV40_RUNTIME_PROOF_SHA256),
      })
      .strict(),
    runtimeEnvironment: z
      .object({
        path: z.literal(PROVIDER_REFUSAL_REPLAY_RUNTIME_ENVIRONMENT_PATH),
        sha256: z.literal(UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256),
      })
      .strict(),
    sourceBytes: z.array(scopeSourceRef).length(40),
    referenceMasks: z.array(scopeMaskRef).length(16),
    executionPolicy: z.literal(PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256),
    queryPolicy: z
      .object({
        policyId: z.literal('strict-authored-scope-v1'),
        sha256: z.literal('8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc'),
        hypothesisSha256: z.literal(
          'dac1bf0eeecfaa204a70e3a89d5e16d7c64ced576a972923a3a1665287426ab2',
        ),
      })
      .strict(),
    budget: z
      .object({
        globalPhysicalCallLimit: z.literal(2_000),
        dev40PhysicalCallLimit: z.literal(400),
        candidateMaxCallsPerCase: z.literal(4),
        controlMaxCallsPerCase: z.literal(6),
        candidateMaxUsdPerDispatch: z.literal(0.55),
        controlMaxUsdPerDispatch: z.literal(0.12),
        ownerDollarCeilingUsd: z.null(),
      })
      .strict(),
    noRetryOrFallback: z.literal(true),
    physicalCallsAt: z.literal('fetch'),
  })
  .strict()

export const nativePresenceReplayProtocolSchema = authoredScopeReplayProtocolSchema.extend({
  schema: z.literal('h8a-native-presence-replay-protocol-v1'),
  studyId: z.literal(NATIVE_PRESENCE_STUDY_ID),
  freezeId: z.literal(NATIVE_PRESENCE_FREEZE_ID),
  parentAudit: z
    .object({
      path: z.literal(
        '/root/.codex/artifacts/zorya-classifier-mcp-20261101/query-scope-research-v1/native-presence-parent-audit-v1.json',
      ),
      sha256: z.literal('81354ec6f7607f3044553fecf94ba0b63d93c171ae3339cdc2debe0cfd24e053'),
    })
    .strict(),
  queryPolicy: z
    .object({
      policyId: z.literal('strict-authored-scope-v1'),
      sha256: z.literal('8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc'),
      hypothesisSha256: z.literal(
        'dac1bf0eeecfaa204a70e3a89d5e16d7c64ced576a972923a3a1665287426ab2',
      ),
    })
    .strict(),
  presencePolicy: z
    .object({
      policyId: z.literal(NATIVE_PRESENCE_POLICY.policyId),
      sha256: z.literal(NATIVE_PRESENCE_POLICY.sha256),
      hypothesisSha256: z.literal(NATIVE_PRESENCE_POLICY.hypothesisSha256),
    })
    .strict(),
})

type AuthoredScopeReplayProtocol = z.infer<typeof authoredScopeReplayProtocolSchema>
type NativePresenceReplayProtocol = z.infer<typeof nativePresenceReplayProtocolSchema>
type ClosedReplayProtocol =
  | AuthoredScopeReplayProtocol
  | NativePresenceReplayProtocol
  | z.infer<typeof providerRefusalReplayProtocolSchema>

export function parseReplayProtocolForStudy(studyId: string, value: unknown): ClosedReplayProtocol {
  if (!Object.hasOwn(REPLAY_STUDY_REGISTRY, studyId))
    throw new RangeError('Replay study is outside the closed registry')
  try {
    if (studyId === NATIVE_PRESENCE_STUDY_ID) {
      const protocol = nativePresenceReplayProtocolSchema.parse(value)
      if (protocol.studyId !== studyId)
        throw new RangeError('Replay protocol study identity mismatch')
      return protocol
    }
    if (studyId === AUTHORED_SCOPE_STUDY_ID) {
      const protocol = authoredScopeReplayProtocolSchema.parse(value)
      if (protocol.studyId !== studyId)
        throw new RangeError('Replay protocol study identity mismatch')
      return protocol
    }
    const protocol = providerRefusalReplayProtocolSchema.parse(value)
    if (protocol.studyId !== studyId)
      throw new RangeError('Replay protocol study identity mismatch')
    return protocol
  } catch {
    throw new RangeError('Replay protocol does not match the explicitly selected registered study')
  }
}

export function parseClosedReplayProtocol(value: unknown):
  | { studyId: 'authored-scope-dev40-v1'; protocol: AuthoredScopeReplayProtocol }
  | { studyId: typeof NATIVE_PRESENCE_STUDY_ID; protocol: NativePresenceReplayProtocol }
  | {
      studyId: typeof PROVIDER_REFUSAL_REPLAY_STUDY_ID
      protocol: z.infer<typeof providerRefusalReplayProtocolSchema>
    } {
  const candidateStudyId =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'studyId') : undefined
  if (candidateStudyId === 'authored-scope-dev40-v1')
    return {
      studyId: 'authored-scope-dev40-v1',
      protocol: authoredScopeReplayProtocolSchema.parse(value),
    }
  if (candidateStudyId === NATIVE_PRESENCE_STUDY_ID)
    return {
      studyId: NATIVE_PRESENCE_STUDY_ID,
      protocol: nativePresenceReplayProtocolSchema.parse(value),
    }
  if (candidateStudyId === PROVIDER_REFUSAL_REPLAY_STUDY_ID)
    return {
      studyId: PROVIDER_REFUSAL_REPLAY_STUDY_ID,
      protocol: providerRefusalReplayProtocolSchema.parse(value),
    }
  throw new RangeError('Replay study is outside the closed registry')
}

export interface VerifiedAuthoredScopeReplayAdmission {
  protocol: AuthoredScopeReplayProtocol
  protocolSha256: string
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  selection: ReturnType<typeof buildDevScreenSelection>
  sourceBytes: ReadonlyMap<string, Uint8Array>
  referenceMaskBytes: ReadonlyMap<string, Uint8Array>
  freezeCommitmentSha256: string
}
export interface VerifiedNativePresenceReplayAdmission {
  protocol: NativePresenceReplayProtocol
  protocolSha256: string
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  selection: ReturnType<typeof buildDevScreenSelection>
  sourceBytes: ReadonlyMap<string, Uint8Array>
  referenceMaskBytes: ReadonlyMap<string, Uint8Array>
  freezeCommitmentSha256: string
}

type ScopeProtocolRef = { path: string; sha256: string }

export function assertAuthoredScopeFreezeRetargeting(
  parentFreeze: PhaseFreeze,
  nextFreeze: PhaseFreeze,
  parentAnnotations: EvaluatorPrivateAnnotationBundle,
  annotations: EvaluatorPrivateAnnotationBundle,
  producerClosureSha256: string,
): void {
  assertClosedReplayFreezeRetargeting(
    AUTHORED_SCOPE_STUDY_ID,
    parentFreeze,
    nextFreeze,
    parentAnnotations,
    annotations,
    producerClosureSha256,
  )
}

export function assertClosedReplayFreezeRetargeting(
  studyId: typeof AUTHORED_SCOPE_STUDY_ID | typeof NATIVE_PRESENCE_STUDY_ID,
  parentFreeze: PhaseFreeze,
  nextFreeze: PhaseFreeze,
  parentAnnotations: EvaluatorPrivateAnnotationBundle,
  annotations: EvaluatorPrivateAnnotationBundle,
  producerClosureSha256: string,
): void {
  const scopePolicy = replayStudyPolicy(studyId)
  const expectedPhaseId =
    studyId === NATIVE_PRESENCE_STUDY_ID ? PHASE_NATIVE_PRESENCE_DEV40_ID : PHASE_SCOPE_DEV40_ID
  const expectedParentPhase =
    studyId === NATIVE_PRESENCE_STUDY_ID ? PHASE_SCOPE_DEV40_ID : PHASE_FLAT_DEV40_ID
  assertClosedReplayRetargetIdentity(
    studyId,
    parentFreeze.phaseId,
    nextFreeze.freezeId,
    nextFreeze.phaseId,
  )
  if (
    nextFreeze.freezeId !== scopePolicy.freezeId ||
    nextFreeze.phaseId !== expectedPhaseId ||
    nextFreeze.producerClosureSha256 !== producerClosureSha256 ||
    nextFreeze.deadlineIso !== PROVIDER_REFUSAL_REPLAY_DEADLINE_ISO ||
    JSON.stringify(nextFreeze.executionPolicy) !==
      JSON.stringify(PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY)
  )
    throw new RangeError('Authored-scope freeze does not bind its registered phase and policies')
  if (
    parentFreeze.phaseId !== expectedParentPhase ||
    parentFreeze.deadlineIso !== nextFreeze.deadlineIso
  )
    throw new RangeError('Authored-scope parent freeze is not the pinned flat DEV40 lineage')

  const candidateProfile = profileById(scopePolicy.candidateProfileId)
  const controlProfile = profileById(PROFILE_CONTROL_ID)
  const candidatePolicyIdentity = hashIdentity(candidateProfile.requestPolicy)
  const controlPolicyIdentity = hashIdentity(controlProfile.requestPolicy)
  const candidateBinding = nextFreeze.profileBindings[0]
  const expectedCandidateRecipe = hashIdentity({
    profileId: candidateProfile.profileId,
    recipeKind: candidateProfile.recipeKind,
    requestPolicyIdentitySha256: candidatePolicyIdentity,
  })
  if (
    candidateBinding.profileId !== scopePolicy.candidateProfileId ||
    candidateProfile.requestPolicyIdentitySha256 !== candidatePolicyIdentity ||
    candidateBinding.requestPolicyIdentitySha256 !== candidatePolicyIdentity ||
    candidateBinding.recipeIdentitySha256 !== expectedCandidateRecipe ||
    JSON.stringify(nextFreeze.profileBindings[1]) !==
      JSON.stringify(parentFreeze.profileBindings[1])
  )
    throw new RangeError('Authored-scope candidate or independent control binding is invalid')
  const expectedControlRecipe = hashIdentity({
    profileId: controlProfile.profileId,
    recipeKind: controlProfile.recipeKind,
    requestPolicyIdentitySha256: controlPolicyIdentity,
  })
  if (
    nextFreeze.profileBindings[1].profileId !== PROFILE_CONTROL_ID ||
    controlProfile.requestPolicyIdentitySha256 !== controlPolicyIdentity ||
    nextFreeze.profileBindings[1].requestPolicyIdentitySha256 !== controlPolicyIdentity ||
    nextFreeze.profileBindings[1].recipeIdentitySha256 !== expectedControlRecipe
  )
    throw new RangeError(
      'Authored-scope control producer policy differs from its independent profile',
    )

  const costProof = nextFreeze.conservativeCostProof
  const candidateCostBound = costProof.profileDispatchUpperBounds[0]
  const controlCostBound = costProof.profileDispatchUpperBounds[1]
  if (
    candidateCostBound.profileId !== scopePolicy.candidateProfileId ||
    candidateCostBound.maxUsdPerPhysicalDispatch !== 0.55 ||
    controlCostBound.profileId !== PROFILE_CONTROL_ID ||
    controlCostBound.maxUsdPerPhysicalDispatch !== 0.12
  )
    throw new RangeError(
      'Authored-scope cost proof does not bind the registered candidate and control',
    )
  validateConservativeCostProof(nextFreeze)

  const annotationById = new Map(annotations.cases.map((row) => [row.opaqueCaseId, row]))
  if (annotationById.size !== annotations.cases.length)
    throw new RangeError('Authored-scope annotations contain duplicate case identities')
  const scheduleById = new Map(nextFreeze.pairedSchedule.map((row) => [row.opaqueCaseId, row]))
  if (scheduleById.size !== nextFreeze.pairedSchedule.length)
    throw new RangeError('Authored-scope schedule contains duplicate case identities')
  if (
    annotationById.size !== nextFreeze.producerCases.length ||
    nextFreeze.producerCases.some((row) => {
      const annotation = annotationById.get(row.opaqueCaseId)
      const schedule = scheduleById.get(row.opaqueCaseId)
      return !annotation || !schedule || annotation.stratum !== schedule.stratum
    })
  )
    throw new RangeError('Authored-scope annotation and schedule case identities differ')
  for (const stratum of STRATUMS) {
    const annotationRows = annotations.cases.filter((row) => row.stratum === stratum)
    const sourceGroupIds = annotationRows.map((row) => row.sourceGroup)
    const commitment = nextFreeze.sourceStrataCommitments.find((row) => row.stratum === stratum)
    if (
      !commitment ||
      commitment.caseCount !== sourceGroupIds.length ||
      commitment.sourceGroupCommitmentSha256 !==
        computeSourceGroupStratumCommitmentSha256(expectedPhaseId, stratum, sourceGroupIds)
    )
      throw new RangeError(
        'Authored-scope source-stratum commitment does not match private annotations',
      )
  }

  const normalizedNext = structuredClone(nextFreeze) as Record<string, unknown>
  const normalizedParent = structuredClone(parentFreeze) as Record<string, unknown>
  normalizedNext.freezeId = normalizedParent.freezeId
  normalizedNext.phaseId = normalizedParent.phaseId
  normalizedNext.producerClosureSha256 = normalizedParent.producerClosureSha256
  normalizedNext.evaluatorAnnotationsSha256 = normalizedParent.evaluatorAnnotationsSha256
  const normalizedNextBindings = normalizedNext.profileBindings as unknown[]
  const normalizedParentBindings = normalizedParent.profileBindings as unknown[]
  normalizedNextBindings[0] = normalizedParentBindings[0]
  const normalizedNextProof = normalizedNext.conservativeCostProof as {
    profileDispatchUpperBounds: Array<Record<string, unknown>>
    proofSha256: string
  }
  const normalizedParentProof = normalizedParent.conservativeCostProof as {
    profileDispatchUpperBounds: Array<Record<string, unknown>>
    proofSha256: string
  }
  const normalizedNextCandidateBound = normalizedNextProof.profileDispatchUpperBounds[0]
  const normalizedParentCandidateBound = normalizedParentProof.profileDispatchUpperBounds[0]
  if (!normalizedNextCandidateBound || !normalizedParentCandidateBound)
    throw new RangeError('Authored-scope candidate cost proof is incomplete')
  normalizedNextCandidateBound.profileId = normalizedParentCandidateBound.profileId
  normalizedNextProof.proofSha256 = normalizedParentProof.proofSha256
  const nextStrata = normalizedNext.sourceStrataCommitments as Array<Record<string, unknown>>
  const parentStrata = normalizedParent.sourceStrataCommitments as Array<Record<string, unknown>>
  for (let index = 0; index < nextStrata.length; index++) {
    const nextRow = nextStrata[index]
    const parentRow = parentStrata[index]
    if (
      !nextRow ||
      !parentRow ||
      nextRow.stratum !== parentRow.stratum ||
      nextRow.caseCount !== parentRow.caseCount
    )
      throw new RangeError('Authored-scope source-stratum order or population changed')
    nextRow.sourceGroupCommitmentSha256 = parentRow.sourceGroupCommitmentSha256
  }
  if (JSON.stringify(normalizedNext) !== JSON.stringify(normalizedParent))
    throw new RangeError('Authored-scope freeze changes fields outside its closed retargeting set')

  const normalizedNextAnnotations = structuredClone(annotations) as Record<string, unknown>
  const normalizedParentAnnotations = structuredClone(parentAnnotations) as Record<string, unknown>
  normalizedNextAnnotations.phaseId = normalizedParentAnnotations.phaseId
  normalizedNextAnnotations.freezeId = normalizedParentAnnotations.freezeId
  if (JSON.stringify(normalizedNextAnnotations) !== JSON.stringify(normalizedParentAnnotations))
    throw new RangeError(
      'Authored-scope private annotations changed outside phase and freeze identity',
    )
  if (
    annotations.phaseId !== expectedPhaseId ||
    annotations.freezeId !== scopePolicy.freezeId ||
    computeEvaluatorAnnotationsSha256(annotations) !== nextFreeze.evaluatorAnnotationsSha256
  )
    throw new RangeError('Authored-scope private annotation commitment is invalid')
}

export function validateScopeParentAudit(value: unknown): {
  references: Array<{ path: string; sha256: string }>
  baseline: Record<string, unknown>
} {
  try {
    return z
      .object({
        schema: z.literal('h8a-authored-scope-parent-audit-v1'),
        priorStudyId: z.literal(LEGACY_REPLAY_STUDY_ID),
        priorStudyStatus: z.literal('sealed-terminal-stop'),
        inputPending: z.literal(false),
        references: z.array(refSchema).length(14),
        baseline: z
          .object({
            parentLedgerVersion: z.literal(161),
            physicalDispatchCount: z.literal(239),
            logicalCaseAttemptCount: z.literal(75),
            knownCostUsd: z.literal(0.14494101499999998),
            unknownReserveUsd: z.literal(0.24),
            nextPhysicalId: z.literal(240),
            nextReservationId: z.literal(240),
            uncertainPhysicalDispatchCount: z.literal(0),
            inFlightReservations: z.literal(0),
          })
          .strict(),
        sourceCases: z.literal(40),
        sourceClaim: z.literal('same-disclosed-development-inputs'),
        qual120Eligible: z.literal(false),
        qualificationResult: z.null(),
        reclassificationsPerformed: z.literal(0),
        providerCallsPerformed: z.literal(0),
        frozenGroundTruthChanged: z.literal(false),
        newStudyRegistered: z.literal(false),
      })
      .passthrough()
      .parse(value)
  } catch {
    throw new RangeError('Authored-scope parent audit does not match its pinned schema')
  }
}

export function assertRequiredParentAuditReferences(
  references: readonly { path: string; sha256: string }[],
  required: readonly (readonly [string, string])[],
): void {
  for (const [path, sha256] of required) {
    const match = references.find((reference) => reference.path === path)
    if (!match || match.sha256 !== sha256)
      throw new RangeError('Authored-scope parent lineage differs from registered references')
  }
}

function parseAuthoredScopeFile<T>(schema: z.ZodType<T>, bytes: Uint8Array, label: string): T {
  try {
    return schema.parse(parseJson(bytes))
  } catch {
    throw new RangeError(label)
  }
}

function parseAuthoredScopeJson(bytes: Uint8Array): unknown {
  try {
    return parseJson(bytes)
  } catch {
    throw new RangeError('Pinned authored-scope JSON is invalid')
  }
}

/** Verify a study selected from the immutable registry; callers cannot supply policy or lineage. */
export async function verifyDevReplayAdmission(input: {
  studyId: string
  protocolPath: string
  protocolSha256: string
  repositoryRoot: string
  now?: () => number
  allowExpiredReadOnly?: boolean
}): Promise<
  | VerifiedProviderRefusalReplayAdmission
  | VerifiedAuthoredScopeReplayAdmission
  | VerifiedNativePresenceReplayAdmission
> {
  const studyId = input.studyId
  const protocolPath = input.protocolPath
  const protocolSha256 = input.protocolSha256
  const repositoryRoot = input.repositoryRoot
  const now = input.now
  const allowExpiredReadOnly = input.allowExpiredReadOnly
  if (allowExpiredReadOnly !== undefined && typeof allowExpiredReadOnly !== 'boolean')
    throw new RangeError('Expired-read-only selector must be boolean')
  if (typeof studyId !== 'string' || !Object.hasOwn(REPLAY_STUDY_REGISTRY, studyId))
    throw new RangeError('Replay study is outside the closed registry')
  if (
    typeof protocolPath !== 'string' ||
    typeof protocolSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(protocolSha256)
  )
    throw new RangeError('Replay protocol pin is invalid')
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot))
    throw new RangeError('Replay repository root must be absolute')
  if (now !== undefined && typeof now !== 'function')
    throw new RangeError('Replay clock must be a function')
  if (studyId === LEGACY_REPLAY_STUDY_ID) {
    return verifyProviderRefusalReplayAdmission({
      protocolPath,
      protocolSha256,
      repositoryRoot,
      ...(now ? { now } : {}),
      ...(allowExpiredReadOnly === undefined ? {} : { allowExpiredReadOnly }),
    })
  }
  if (studyId !== AUTHORED_SCOPE_STUDY_ID && studyId !== NATIVE_PRESENCE_STUDY_ID)
    throw new RangeError('Replay study is outside the closed registry')
  const isNativePresence = studyId === NATIVE_PRESENCE_STUDY_ID
  const policy = replayStudyPolicy(studyId)
  if (
    isNativePresence &&
    (!('presencePolicy' in policy) || H6_PRESENCE_POLICY_SHA256 !== policy.presencePolicy.sha256)
  )
    throw new RangeError('Native-presence policy hash differs from the implemented H6 policy')
  const expectedProtocolPath = resolve(policy.canonicalRoot, 'protocol-inputs', 'protocol.json')
  if (resolve(protocolPath) !== expectedProtocolPath)
    throw new RangeError('Replay protocol must use its registered production path')

  const protocolBytes = await readPinnedReplayFile(protocolPath, protocolSha256, 2 * 1024 * 1024)
  const protocol = parseReplayProtocolForStudy(studyId, parseAuthoredScopeJson(protocolBytes))
  if (!('queryPolicy' in protocol))
    throw new RangeError('Pinned replay protocol does not match its registered schema')
  if (protocol.studyId !== studyId || protocol.freezeId !== policy.freezeId)
    throw new RangeError('Replay protocol does not match the explicit registered study')
  assertAdmissionDeadline(
    protocol.deadlineIso,
    now?.() ?? Date.now(),
    allowExpiredReadOnly === true,
  )

  const trustedRoot = resolve('/root/.codex/artifacts')
  const parentAuditBytes = await readPinnedReplayFile(
    policy.parentAuditPath,
    policy.parentAuditSha256,
  )
  const parentAudit = isNativePresence
    ? nativePresenceParentAuditSchema.parse(parseAuthoredScopeJson(parentAuditBytes))
    : validateScopeParentAudit(parseAuthoredScopeJson(parentAuditBytes))
  const referencePaths = new Set<string>()
  const nativeParentEvidence = new Map<string, Uint8Array>()
  const parentReferences: readonly { path: string; sha256: string }[] = parentAudit.references
  for (const reference of parentReferences) {
    const absolute = resolve(reference.path)
    if (!inside(trustedRoot, absolute) || referencePaths.has(absolute))
      throw new RangeError('Authored-scope parent audit contains an invalid reference')
    referencePaths.add(absolute)
    const referenceBytes = await readPinnedReplayFile(absolute, reference.sha256, 16 * 1024 * 1024)
    const expectedLength = Reflect.get(reference, 'bytes')
    if (typeof expectedLength === 'number' && referenceBytes.byteLength !== expectedLength)
      throw new RangeError('Native-presence parent reference byte length differs from its pin')
    if (isNativePresence) nativeParentEvidence.set(absolute, referenceBytes)
  }
  if (isNativePresence) {
    const parentRoot = resolve(
      '/root/.codex/artifacts/zorya-classifier-mcp-20261101/authored-scope-dev40-v1',
    )
    const readParentEvidence = (relativePath: string): Record<string, unknown> => {
      const bytes = nativeParentEvidence.get(resolve(parentRoot, relativePath))
      if (!bytes) throw new RangeError('Native-presence sealed parent evidence is incomplete')
      return z.record(z.unknown()).parse(parseAuthoredScopeJson(bytes))
    }
    const report = readParentEvidence('execution/reports/dev8-report.json')
    const review = readParentEvidence('execution/reviews/dev8-review.json')
    const terminal = readParentEvidence('execution/terminal-stop.json')
    const closeout = readParentEvidence('reports/main-closeout-audit-v2.json')
    const reportDigest = Reflect.get(report, 'reportSha256')
    const reviewDigest = Reflect.get(review, 'reviewSha256')
    const reportBody = Object.fromEntries(
      Object.entries(report).filter(([key]) => key !== 'reportSha256'),
    )
    const reviewBody = Object.fromEntries(
      Object.entries(review).filter(([key]) => key !== 'reviewSha256'),
    )
    const parentProtocolRef = parentAudit.references.find(
      (reference) => reference.path === resolve(parentRoot, 'protocol-inputs/protocol.json'),
    )
    if (
      report.schema !== 'h8a-dev-screen-report-v1' ||
      report.screen !== 'dev8' ||
      report.completedPairs !== 6 ||
      report.expectedPairs !== 8 ||
      reportDigest !== hashIdentity(reportBody) ||
      review.schema !== 'h8a-dev-screen-review-v1' ||
      review.judgement !== 'stop' ||
      review.screenReportSha256 !== reportDigest ||
      reviewDigest !== hashIdentity(reviewBody) ||
      terminal.schema !== 'h8a-authored-scope-replay-terminal-stop-v1' ||
      terminal.stage !== 'dev8' ||
      terminal.protocolSha256 !== parentProtocolRef?.sha256 ||
      terminal.physicalDispatchCount !== parentAudit.baseline.physicalDispatchCount ||
      terminal.logicalAttemptCount !== parentAudit.baseline.logicalAttemptCount ||
      terminal.uncertainPhysicalDispatchCount !== 0 ||
      closeout.schema !== 'main-authored-scope-closeout-audit-v1' ||
      closeout.reportSha256 !== reportDigest ||
      closeout.reviewSha256 !== reviewDigest ||
      closeout.qualEligible !== false ||
      closeout.sealedParentUnchanged !== true
    )
      throw new RangeError('Native-presence parent lacks a hash-bound terminal DEV stop')
  }
  const requiredRefs = [
    [policy.parentLedgerPath, policy.parentLedgerSha256],
    [policy.parentFreezePath!, policy.parentFreezeSha256!],
    [policy.parentAnnotationsPath!, policy.parentAnnotationsSha256!],
  ] as const
  assertRequiredParentAuditReferences(parentAudit.references, requiredRefs)
  const ledgerBytes = await readPinnedReplayFile(policy.parentLedgerPath, policy.parentLedgerSha256)
  if (isNativePresence) {
    const registrationRef = parentAudit.references.find(
      (reference) => reference.path === policy.parentRegistrationPath,
    )
    if (!registrationRef || registrationRef.sha256 !== policy.parentRegistrationSha256)
      throw new RangeError('Native-presence parent registration reference is missing')
    const registrationBytes = await readPinnedReplayFile(
      registrationRef.path,
      registrationRef.sha256,
      64 * 1024,
    )
    if (
      typeof Reflect.get(registrationRef, 'bytes') !== 'number' ||
      registrationBytes.byteLength !== Reflect.get(registrationRef, 'bytes')
    )
      throw new RangeError('Native-presence parent registration byte length differs from its pin')
    const linked = validateAuthoredScopeReplayParentPair(
      parseAuthoredScopeJson(ledgerBytes),
      parseAuthoredScopeJson(registrationBytes),
      NATIVE_PRESENCE_STUDY_ID,
    )
    if (
      linked.ledgerVersion !== parentAudit.baseline.ledgerVersion ||
      linked.physicalDispatchCount !== parentAudit.baseline.physicalDispatchCount ||
      linked.logicalAttemptCount !== parentAudit.baseline.logicalAttemptCount ||
      linked.knownCostUsd !== parentAudit.baseline.knownCostUsd ||
      linked.unknownReserveUsd !== parentAudit.baseline.unknownReserveUsd ||
      linked.nextPhysicalId !== parentAudit.baseline.nextPhysicalId ||
      linked.nextReservationId !== parentAudit.baseline.nextReservationId
    )
      throw new RangeError('Native-presence parent pair differs from its frozen audit baseline')
  }
  const parentLedger = isNativePresence
    ? null
    : z
        .object({
          schema: z.literal('h8a-provider-refusal-replay-ledger-v1'),
          ledgerVersion: z.literal(161),
          nextReservationId: z.literal(240),
          nextPhysicalId: z.literal(240),
          physicalDispatchCount: z.literal(239),
          uncertainPhysicalDispatchCount: z.literal(0),
          logicalAttemptCount: z.literal(75),
          knownCostUsd: z.literal(0.14494101499999998),
          unknownReserveUsd: z.literal(0.24),
          inFlightReservations: z.array(z.unknown()).length(0),
          resumeBlocked: z.literal(false),
          crashRecoveryLatched: z.literal(false),
          integrityBlocked: z.literal(false),
        })
        .passthrough()
        .parse(parseAuthoredScopeJson(ledgerBytes))
  const expectedParentLedgerVersion = Reflect.get(
    parentAudit.baseline,
    isNativePresence ? 'ledgerVersion' : 'parentLedgerVersion',
  )
  if (parentLedger && parentLedger.ledgerVersion !== expectedParentLedgerVersion)
    throw new RangeError('Authored-scope parent ledger differs from the frozen audit baseline')

  const sourceAuditBytes = await readPinnedReplayFile(
    protocol.sourceAudit.path,
    protocol.sourceAudit.sha256,
    16 * 1024 * 1024,
  )
  const sourceAudit = z
    .object({
      schema: z.literal('h8a-replay-original-input-byte-audit-v1'),
      sourceClaim: z.literal('same-disclosed-development-inputs'),
      sourceRosterTargetHashContract: z.literal('sha256-raw-utf8'),
      decodedRgbContract: z.literal(
        'pillow-rgb-canonical-identity-and-sharp-srgb-runtime-decoder-v1',
      ),
      freezeId: z.literal('h8a-ui-native-state-dev40-20261101-v1'),
      sourceCases: z.literal(40),
      referenceMasksVerified: z.literal(16),
      allEncodedBytesAndRuntimeRgbMatch: z.literal(true),
      providerCalls: z.literal(0),
      nativeInferenceCalls: z.literal(0),
      references: z.array(refSchema).length(15),
      rows: z
        .array(
          z
            .object({
              opaqueCaseId: z.string().min(1),
              sourceBytesSha256: digest,
              sourceCanvasWidth: z.number().int().positive(),
              sourceCanvasHeight: z.number().int().positive(),
              targetTaskText: z.string().min(1),
              sourcePath: z.string().min(1),
              encodedBytes: z.number().int().positive(),
              sharpRuntimeDecodedRgbSha256: digest,
              pillowCanonicalRgbSha256: digest,
            })
            .strict(),
        )
        .length(40),
    })
    .passthrough()
    .parse(parseAuthoredScopeJson(sourceAuditBytes))
  for (const reference of sourceAudit.references) {
    const absolute = resolve(reference.path)
    if (!inside(trustedRoot, absolute))
      throw new RangeError('Source audit reference is outside trusted artifacts')
    await readPinnedReplayFile(absolute, reference.sha256, 16 * 1024 * 1024)
  }
  for (const metadataRef of [protocol.runtimeProof, protocol.runtimeEnvironment]) {
    const absolute = resolve(metadataRef.path)
    if (!inside(trustedRoot, absolute))
      throw new RangeError('Runtime metadata is outside trusted artifacts')
    const bytes = await readPinnedReplayFile(absolute, metadataRef.sha256, 4 * 1024 * 1024)
    parseAuthoredScopeJson(bytes)
  }

  const outputRefs: ScopeProtocolRef[] = [
    protocol.freeze,
    protocol.annotations,
    protocol.selection,
    protocol.producerClosure,
  ]
  for (const reference of outputRefs) {
    const absolute = resolve(reference.path)
    if (!inside(resolve(policy.canonicalRoot), absolute))
      throw new RangeError(
        'Authored-scope protocol output is outside its registered production namespace',
      )
  }
  const [freezeBytes, annotationBytes, closureBytes] = await Promise.all([
    readPinnedReplayFile(protocol.freeze.path, protocol.freeze.sha256, 4 * 1024 * 1024),
    readPinnedReplayFile(protocol.annotations.path, protocol.annotations.sha256, 4 * 1024 * 1024),
    readPinnedReplayFile(
      protocol.producerClosure.path,
      protocol.producerClosure.sha256,
      16 * 1024 * 1024,
    ),
  ])
  const parentFreeze = parseAuthoredScopeFile(
    phaseFreezeSchema,
    await readPinnedReplayFile(policy.parentFreezePath, policy.parentFreezeSha256),
    'Pinned authored-scope parent freeze does not match its schema',
  )
  const parentAnnotations = parseAuthoredScopeFile(
    evaluatorPrivateAnnotationBundleSchema,
    await readPinnedReplayFile(policy.parentAnnotationsPath, policy.parentAnnotationsSha256),
    'Pinned authored-scope parent annotations do not match their schema',
  )
  const freeze = parseAuthoredScopeFile(
    phaseFreezeSchema,
    freezeBytes,
    'Pinned authored-scope freeze does not match its schema',
  )
  const annotations = parseAuthoredScopeFile(
    evaluatorPrivateAnnotationBundleSchema,
    annotationBytes,
    'Pinned authored-scope annotations do not match their schema',
  )
  const closure = z
    .object({
      schema: z.literal('h8a-producer-closure-files-v1'),
      sourceCommit: z.string().min(1),
      files: z
        .array(
          z
            .object({
              path: z.string().min(1),
              sha256: digest,
              bytes: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict()
    .parse(parseAuthoredScopeJson(closureBytes))
  if (replaySha256(closureBytes) !== protocol.producerClosure.sha256 || !closure.sourceCommit)
    throw new RangeError('Authored-scope producer closure bytes are invalid')
  if (isNativePresence) {
    const hypothesis = closure.files.find(
      (file) => file.path === 'docs/research/v03-native-presence-hypothesis.ru.md',
    )
    if (
      !('presencePolicy' in policy) ||
      !hypothesis ||
      hypothesis.sha256 !== policy.presencePolicy.hypothesisSha256
    )
      throw new RangeError('Native-presence closure does not bind its registered hypothesis')
  }
  assertClosedReplayFreezeRetargeting(
    studyId,
    parentFreeze,
    freeze,
    parentAnnotations,
    annotations,
    protocol.producerClosure.sha256,
  )

  if (
    freeze.producerCases.length !== 40 ||
    protocol.sourceBytes.some(
      (source, index) => source.caseId !== freeze.producerCases[index]?.opaqueCaseId,
    )
  )
    throw new RangeError('Authored-scope inputs do not cover exactly 40 producer cases')
  const sourceBytes = await verifyReplaySourceBundle(
    freeze.producerCases,
    protocol.sourceBytes,
    sourceAudit.rows,
  )

  const producerByCase = new Map(freeze.producerCases.map((item) => [item.opaqueCaseId, item]))
  for (const annotation of annotations.cases) {
    const producer = producerByCase.get(annotation.opaqueCaseId)
    if (!producer) throw new RangeError('Authored-scope annotation references an unknown case')
    assertReferenceBoxesWithinCanvas(
      annotation,
      producer.sourceCanvasWidth,
      producer.sourceCanvasHeight,
    )
    assertReferenceMaskDeclaration(
      annotation,
      producer.sourceCanvasWidth,
      producer.sourceCanvasHeight,
    )
    if (
      annotation.referenceMasks.some(
        (mask) =>
          mask.width !== producer.sourceCanvasWidth || mask.height !== producer.sourceCanvasHeight,
      )
    )
      throw new RangeError('Authored-scope reference mask differs from the source canvas')
  }
  if (protocol.referenceMasks.length !== 16)
    throw new RangeError('Authored-scope admission requires the frozen 16-mask set')
  const referenceMaskBytes = await verifyReplayReferenceMasks(annotations, protocol.referenceMasks)
  const selection = buildDevScreenSelection(freeze, annotations)
  const suppliedSelection = parseAuthoredScopeJson(
    await readPinnedReplayFile(protocol.selection.path, protocol.selection.sha256, 4 * 1024 * 1024),
  )
  if (JSON.stringify(selection) !== JSON.stringify(suppliedSelection))
    throw new RangeError(
      'Authored-scope nested selection differs from its deterministic freeze-derived value',
    )
  if (
    protocol.executionPolicy !== PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY.policySha256 ||
    JSON.stringify(protocol.queryPolicy) !== JSON.stringify(policy.queryPolicy) ||
    (isNativePresence &&
      (!('presencePolicy' in protocol) ||
        !('presencePolicy' in policy) ||
        JSON.stringify(protocol.presencePolicy) !== JSON.stringify(policy.presencePolicy)))
  )
    throw new RangeError(
      'Authored-scope execution or query policy differs from the closed registry',
    )
  assertAdmissionDeadline(
    protocol.deadlineIso,
    now?.() ?? Date.now(),
    allowExpiredReadOnly === true,
  )
  const admission = {
    protocol,
    protocolSha256,
    freeze,
    annotations,
    selection,
    sourceBytes,
    referenceMaskBytes,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
  }
  if (protocol.studyId === NATIVE_PRESENCE_STUDY_ID) return { ...admission, protocol }
  return { ...admission, protocol }
}
