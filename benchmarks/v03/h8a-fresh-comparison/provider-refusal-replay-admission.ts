import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import sharp from 'sharp'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'
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
import { PHASE_FLAT_DEV40_ID, PROFILE_FLAT_CANDIDATE_ID, PROFILE_CONTROL_ID } from './constants.js'
import type { PhaseFreeze, EvaluatorPrivateAnnotationBundle } from './schemas.js'

export const PROVIDER_REFUSAL_REPLAY_STUDY_ID = 'provider-refusal-dev40-replay-v1' as const
export const PROVIDER_REFUSAL_REPLAY_FREEZE_ID =
  'h8a-provider-refusal-dev40-replay-20261101-v1' as const
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
export const PROVIDER_REFUSAL_REPLAY_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1' as const
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertBeforeDeadline(deadlineIso: string, now = Date.now()): void {
  const deadline = Date.parse(deadlineIso)
  if (!Number.isFinite(deadline) || now >= deadline)
    throw new RangeError('Provider refusal replay deadline is closed')
}

function inside(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

async function readRegularPinned(
  path: string,
  expectedSha256: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<Buffer> {
  const absolute = resolve(path)
  const info = await lstat(absolute)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maxBytes ||
    (await realpath(absolute)) !== absolute
  )
    throw new RangeError('Pinned replay input is not a bounded canonical file')
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new RangeError('Pinned replay input exceeds its bounded file size')
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes)
      throw new RangeError('Pinned replay input grew beyond its bounded file size')
    const bytes = buffer.subarray(0, offset)
    const after = await handle.stat({ bigint: true })
    const afterPath = await lstat(absolute)
    if (
      sha256(bytes) !== expectedSha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.length !== Number(before.size) ||
      BigInt(afterPath.dev) !== after.dev ||
      BigInt(afterPath.ino) !== after.ino ||
      (await realpath(absolute)) !== absolute
    )
      throw new RangeError('Pinned replay input changed while being read')
    return Buffer.from(bytes)
  } finally {
    await handle.close()
  }
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
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
  const protocolBytes = await readRegularPinned(
    input.protocolPath,
    input.protocolSha256,
    2 * 1024 * 1024,
  )
  const protocol = providerRefusalReplayProtocolSchema.parse(parseJson(protocolBytes))
  if (!input.allowExpiredReadOnly)
    assertBeforeDeadline(protocol.deadlineIso, input.now?.() ?? Date.now())
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
  const sourceBytes = new Map<string, Uint8Array>()
  for (const source of protocol.sourceBytes) {
    const absolute = resolve(source.path)
    if (!inside(resolve('/root/.codex/artifacts'), absolute))
      throw new RangeError('A source path is outside the trusted artifact root')
    const bytes = await readRegularPinned(absolute, source.sha256, 16 * 1024 * 1024)
    if (source.bytes !== undefined && bytes.length !== source.bytes)
      throw new RangeError('Source byte length differs from protocol')
    if (sourceBytes.has(source.caseId))
      throw new RangeError('Protocol repeats a source case identity')
    sourceBytes.set(source.caseId, new Uint8Array(bytes))
  }
  const oldFreezeBytes = await readRegularPinned(parentRefs[7][0], parentRefs[7][1])
  const oldFreeze = phaseFreezeSchema.parse(parseJson(oldFreezeBytes))
  const nextFreeze = phaseFreezeSchema.parse(
    parseJson(await readRegularPinned(protocol.freeze.path, protocol.freeze.sha256)),
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
  if (
    sourceBytes.size !== nextFreeze.producerCases.length ||
    nextFreeze.producerCases.some((row) => {
      const bytes = sourceBytes.get(row.opaqueCaseId)
      return !bytes || sha256(bytes) !== row.sourceBytesSha256
    })
  )
    throw new RangeError('Protocol source bytes do not exactly cover the frozen 40-case cohort')
  const auditedRows = new Map(sourceAudit.rows.map((row) => [row.opaqueCaseId, row]))
  if (
    auditedRows.size !== nextFreeze.producerCases.length ||
    nextFreeze.producerCases.some((row) => {
      const auditRow = auditedRows.get(row.opaqueCaseId)
      return (
        !auditRow ||
        auditRow.sourceBytesSha256 !== row.sourceBytesSha256 ||
        auditRow.sourceCanvasWidth !== row.sourceCanvasWidth ||
        auditRow.sourceCanvasHeight !== row.sourceCanvasHeight ||
        auditRow.targetTaskText !== row.targetTaskText
      )
    })
  )
    throw new RangeError(
      'New DEV40 producer rows differ from the independently audited disclosed source rows',
    )
  for (const producer of nextFreeze.producerCases) {
    const auditRow = auditedRows.get(producer.opaqueCaseId)!
    const encoded = sourceBytes.get(producer.opaqueCaseId)!
    if (
      encoded.length !== auditRow.encodedBytes ||
      auditRow.sourcePath !==
        protocol.sourceBytes.find((ref) => ref.caseId === producer.opaqueCaseId)?.path ||
      producer.sourceCanvasWidth * producer.sourceCanvasHeight > 2_097_152
    )
      throw new RangeError('Replay source bytes differ from the audited encoded source identity')
    const metadata = await sharp(encoded, {
      failOn: 'error',
      limitInputPixels: 2_097_152,
    }).metadata()
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.orientation !== undefined && metadata.orientation !== 1) ||
      metadata.width !== producer.sourceCanvasWidth ||
      metadata.height !== producer.sourceCanvasHeight
    )
      throw new RangeError(
        'Replay image dimensions or orientation differ from the frozen producer row',
      )
    const decoded = await sharp(encoded, { failOn: 'error', limitInputPixels: 2_097_152 })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (
      decoded.info.channels !== 3 ||
      decoded.info.width !== producer.sourceCanvasWidth ||
      decoded.info.height !== producer.sourceCanvasHeight ||
      sha256(decoded.data) !== auditRow.sharpRuntimeDecodedRgbSha256
    )
      throw new RangeError('Replay Sharp RGB differs from the separately pinned runtime decode')
  }
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
  const maskRefs = new Map(protocol.referenceMasks.map((ref) => [ref.packedBinarySha256, ref]))
  if (maskRefs.size !== protocol.referenceMasks.length)
    throw new RangeError('Reference mask protocol repeats a hash')
  const requiredMaskHashes = new Set(
    annotations.cases.flatMap((row) => row.referenceMasks.map((mask) => mask.packedBinarySha256)),
  )
  if (
    requiredMaskHashes.size !== protocol.referenceMasks.length ||
    [...requiredMaskHashes].some((maskHash) => !maskRefs.has(maskHash))
  )
    throw new RangeError('Protocol reference mask set differs from private annotations')
  const referenceMaskBytes = new Map<string, Uint8Array>()
  for (const ref of protocol.referenceMasks) {
    if (!inside(trustedArtifactRoot, resolve(ref.path)))
      throw new RangeError('Reference mask path is outside the trusted artifact root')
    const bytes = await readRegularPinned(ref.path, ref.sha256, 8 * 1024 * 1024)
    if (sha256(bytes) !== ref.packedBinarySha256)
      throw new RangeError('Packed reference mask bytes do not match the private annotation digest')
    const references = annotations.cases
      .flatMap((row) => row.referenceMasks)
      .filter((mask) => mask.packedBinarySha256 === ref.packedBinarySha256)
    if (references.length !== 1)
      throw new RangeError('Reference mask hash must identify exactly one annotation mask')
    const mask = references[0]!
    unpackBinaryLsb0V1(mask.width, mask.height, bytes)
    referenceMaskBytes.set(ref.packedBinarySha256, new Uint8Array(bytes))
  }
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
  if (!input.allowExpiredReadOnly)
    assertBeforeDeadline(protocol.deadlineIso, input.now?.() ?? Date.now())
  return {
    protocol,
    protocolSha256: input.protocolSha256,
    freeze: nextFreeze,
    annotations,
    selection,
    sourceBytes,
    referenceMaskBytes,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(nextFreeze),
  }
}
