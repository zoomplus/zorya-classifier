import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import sharp from 'sharp'
import type { CaseExecutionPortResult } from './paired-runner.js'
import { logicalReceiptSchema, outputRowSchema, physicalReceiptSchema } from './schemas.js'
import { hashIdentity } from './hash-identity.js'
import { sha256PackedBytes, unpackBinaryLsb0V1 } from './packed-binary-lsb0.js'
import {
  PROFILE_CANDIDATE_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
} from './constants.js'
import { assertProviderRefusalReplayEvidence } from './provider-refusal-replay.js'
import { PROVIDER_REFUSAL_REPLAY_POLICY_SHA256 } from './provider-refusal-replay.js'
import { PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY } from './provider-refusal-replay.js'

const identitySchema = z.object({
  freezeCommitmentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  recipeIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  requestPolicyIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pairedScheduleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  selectionCommitmentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  opaqueCaseId: z.string().min(1),
  profileId: z.enum([
    PROFILE_CANDIDATE_ID,
    PROFILE_FLAT_CANDIDATE_ID,
    PROFILE_SCOPE_CANDIDATE_ID,
    PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
    PROFILE_CONTROL_ID,
  ]),
  sourceBytesSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  targetTaskSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceCanvasWidth: z.number().int().positive(),
  sourceCanvasHeight: z.number().int().positive(),
  executionPolicySha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
})

const resultSchema = z
  .object({
    outputRow: outputRowSchema,
    caseError: z.string().optional(),
    logicalReceipts: z.array(logicalReceiptSchema),
    physicalReceipts: z.array(physicalReceiptSchema),
    caseArtifactSidecars: z
      .array(
        z
          .object({
            opaqueCaseId: z.string().min(1),
            profileId: z.string().min(1),
            kind: z.enum(['candidate-cutout-rgba', 'control-cutout-png']),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            byteLength: z.number().int().positive(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            sourceCanvasWidth: z.number().int().positive(),
            sourceCanvasHeight: z.number().int().positive(),
            sourceRegion: z
              .object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() })
              .strict(),
            sourceOffset: z.object({ x: z.number(), y: z.number() }).strict(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export type CaseArtifactIdentity = z.infer<typeof identitySchema>

export interface StoredCaseArtifact {
  identitySha256: string
  result: CaseExecutionPortResult
  durationMs: number | null
  startedAtIso: string
  completedAtIso: string
  knownCostUsd: number
  unknownDispatchCount: number
  artifactPaths: string[]
  blobsBySha256: ReadonlyMap<string, Uint8Array>
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function recordPath(root: string, identitySha256: string): string {
  return join(root, 'case-artifacts', identitySha256.slice(0, 2), `${identitySha256}.json`)
}

function intentPath(root: string, identitySha256: string): string {
  return join(root, 'case-intents', identitySha256.slice(0, 2), `${identitySha256}.json`)
}

function artifactPath(root: string, digest: string): string {
  return join(root, 'case-blobs', digest.slice(0, 2), digest)
}

function isCandidateProfile(profileId: CaseArtifactIdentity['profileId']): boolean {
  return (
    profileId === PROFILE_CANDIDATE_ID ||
    profileId === PROFILE_FLAT_CANDIDATE_ID ||
    profileId === PROFILE_SCOPE_CANDIDATE_ID ||
    profileId === PROFILE_NATIVE_PRESENCE_CANDIDATE_ID
  )
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  }
}

const intentSchema = z
  .object({
    schema: z.literal('h8a-case-intent-v1'),
    identity: identitySchema,
    identitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    startedAtIso: z.string().datetime({ offset: true }),
    token: z.string().uuid(),
  })
  .strict()

const dispatchBaseSchema = z.object({
  reservationId: z.number().int().positive(),
  profileId: z.enum([
    PROFILE_CANDIDATE_ID,
    PROFILE_FLAT_CANDIDATE_ID,
    PROFILE_SCOPE_CANDIDATE_ID,
    PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
    PROFILE_CONTROL_ID,
  ]),
  opaqueCaseId: z.string().min(1),
  caseExecutionIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  logicalId: z.number().int().positive(),
  recorderPhysicalId: z.number().int().positive(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  endpoint: z.enum(['/api/v1/chat/completions', '/api/alpha/decisions']),
})
const admittedDispatchSchema = dispatchBaseSchema
  .extend({ state: z.literal('admitted') })
  .passthrough()
const completedDispatchSchema = dispatchBaseSchema
  .extend({
    physicalId: z.number().int().positive().nullable(),
    dispatchState: z.enum(['confirmed', 'uncertain']),
    settled: z.boolean(),
    costUsd: z.number().finite().nonnegative().nullable(),
    httpStatus: z.number().int().nullable(),
    errorCode: z.string().optional(),
  })
  .passthrough()

function validateResultIdentity(
  result: CaseExecutionPortResult,
  identity: CaseArtifactIdentity,
): void {
  if (
    result.outputRow.opaqueCaseId !== identity.opaqueCaseId ||
    result.outputRow.profileId !== identity.profileId
  )
    throw new RangeError('Stored case output row does not match its arm identity')
  const sidecars = result.caseArtifactSidecars ?? []
  if (sidecars.length !== (result.outputRow.cutoutPresent ? 1 : 0))
    throw new RangeError('Cutout presence does not match exactly one immutable sidecar')
  for (const sidecar of sidecars) {
    if (sidecar.opaqueCaseId !== identity.opaqueCaseId || sidecar.profileId !== identity.profileId)
      throw new RangeError('Cutout sidecar case/profile differs from its arm identity')
    const candidate = isCandidateProfile(identity.profileId)
    if (
      (candidate && sidecar.kind !== 'candidate-cutout-rgba') ||
      (!candidate && sidecar.kind !== 'control-cutout-png')
    )
      throw new RangeError('Cutout sidecar kind differs from its frozen profile')
    if (
      sidecar.sourceCanvasWidth !== identity.sourceCanvasWidth ||
      sidecar.sourceCanvasHeight !== identity.sourceCanvasHeight
    )
      throw new RangeError('Cutout sidecar source canvas differs from freeze identity')
    const region = sidecar.sourceRegion
    if (
      region.left < 0 ||
      region.top < 0 ||
      region.width !== sidecar.width ||
      region.height !== sidecar.height ||
      region.left + region.width > identity.sourceCanvasWidth ||
      region.top + region.height > identity.sourceCanvasHeight
    )
      throw new RangeError('Cutout sidecar region is outside its original source canvas')
    if (sidecar.sourceOffset.x !== region.left || sidecar.sourceOffset.y !== region.top)
      throw new RangeError('Cutout sidecar offset differs from source region')
    if (
      result.outputRow.box === null ||
      hashIdentity(result.outputRow.box) !== hashIdentity(region)
    )
      throw new RangeError('Cutout sidecar source region differs from output box')
    if (candidate && sidecar.byteLength !== sidecar.width * sidecar.height * 4)
      throw new RangeError('Candidate RGBA cutout byte length differs from its geometry')
  }
  if (result.outputRow.providerRefusalEvidence) {
    if (identity.executionPolicySha256 !== PROVIDER_REFUSAL_REPLAY_POLICY_SHA256)
      throw new RangeError('Refusal evidence requires its opted-in immutable execution policy')
    assertProviderRefusalReplayEvidence({
      evidence: result.outputRow.providerRefusalEvidence,
      executionPolicy: PROVIDER_REFUSAL_REPLAY_EXECUTION_POLICY,
      opaqueCaseId: identity.opaqueCaseId,
      profileId: identity.profileId,
      output: result.outputRow,
      logicalReceipts: result.logicalReceipts,
      physicalReceipts: result.physicalReceipts,
      identitySha256: hashIdentity(identity),
    })
  }
}

function validateReceiptReferences(result: CaseExecutionPortResult): void {
  const logicalById = new Map(result.logicalReceipts.map((item) => [item.logicalId, item]))
  const physicalById = new Map(result.physicalReceipts.map((item) => [item.receiptId, item]))
  if (
    logicalById.size !== result.logicalReceipts.length ||
    physicalById.size !== result.physicalReceipts.length
  )
    throw new RangeError('Case result contains duplicate receipt IDs')
  if (
    result.outputRow.logicalReceiptIds.length !==
      new Set(result.outputRow.logicalReceiptIds).size ||
    result.outputRow.physicalReceiptIds.length !== new Set(result.outputRow.physicalReceiptIds).size
  )
    throw new RangeError('Case output row contains duplicate receipt references')
  if (
    result.outputRow.logicalReceiptIds.length !== logicalById.size ||
    result.outputRow.logicalReceiptIds.some((id) => !logicalById.has(id))
  )
    throw new RangeError('Case output row does not reference every logical receipt exactly once')
  const expectedPhysicalRowIds = result.physicalReceipts
    .filter((item) => item.dispatchState !== 'prefetch_cancelled')
    .map((item) => item.receiptId)
  if (
    result.outputRow.physicalReceiptIds.length !== expectedPhysicalRowIds.length ||
    result.outputRow.physicalReceiptIds.some((id) => !physicalById.has(id)) ||
    expectedPhysicalRowIds.some((id) => !result.outputRow.physicalReceiptIds.includes(id))
  )
    throw new RangeError('Case output row physical receipt references mismatch')
  for (const logical of result.logicalReceipts) {
    if (
      logical.opaqueCaseId !== result.outputRow.opaqueCaseId ||
      logical.profileId !== result.outputRow.profileId
    )
      throw new RangeError('Case logical receipt identity mismatch')
    if (logical.physicalIds.length !== new Set(logical.physicalIds).size)
      throw new RangeError('Case logical receipt duplicates physical references')
    for (const receiptId of logical.physicalIds) {
      const physical = physicalById.get(receiptId)
      if (!physical || physical.logicalId !== logical.logicalId)
        throw new RangeError('Case physical/logical receipt link mismatch')
    }
  }
  for (const physical of result.physicalReceipts) {
    const logical = logicalById.get(physical.logicalId)
    if (!logical || !logical.physicalIds.includes(physical.receiptId))
      throw new RangeError('Case physical receipt has no logical link')
    if (
      physical.dispatchState !== 'prefetch_cancelled' &&
      !result.outputRow.physicalReceiptIds.includes(physical.receiptId)
    )
      throw new RangeError('Case physical receipt is not linked through output row')
  }
}

function validateArtifactMap(
  result: CaseExecutionPortResult,
  blobs: ReadonlyMap<string, Uint8Array>,
  identity: CaseArtifactIdentity,
): void {
  const required = new Set<string>()
  if (result.outputRow.maskPackedSha256) {
    required.add(result.outputRow.maskPackedSha256)
    const packed = blobs.get(result.outputRow.maskPackedSha256)
    if (!packed || sha256PackedBytes(packed) !== result.outputRow.maskPackedSha256)
      throw new RangeError('Case packed mask is missing or differs from its digest')
    unpackBinaryLsb0V1(identity.sourceCanvasWidth, identity.sourceCanvasHeight, packed)
  }
  for (const sidecar of result.caseArtifactSidecars ?? []) required.add(sidecar.sha256)
  if (required.size !== blobs.size || [...required].some((digest) => !blobs.has(digest)))
    throw new RangeError('Case artifact blob set contains missing or unreferenced content')
}

async function validateSidecarBytes(
  result: CaseExecutionPortResult,
  blobs: ReadonlyMap<string, Uint8Array>,
  identity: CaseArtifactIdentity,
): Promise<void> {
  if ((result.caseArtifactSidecars?.length ?? 0) > 0 && !result.outputRow.maskPackedSha256)
    throw new RangeError('Cutout sidecar requires its source-aligned packed mask')
  const packedMask = result.outputRow.maskPackedSha256
    ? blobs.get(result.outputRow.maskPackedSha256)
    : undefined
  const maskPixels =
    packedMask && result.outputRow.maskPackedSha256
      ? unpackBinaryLsb0V1(identity.sourceCanvasWidth, identity.sourceCanvasHeight, packedMask)
      : undefined
  if (
    packedMask &&
    result.outputRow.maskPackedSha256 &&
    sha256PackedBytes(packedMask) !== result.outputRow.maskPackedSha256
  )
    throw new RangeError('Cutout reference mask bytes do not match output digest')
  for (const sidecar of result.caseArtifactSidecars ?? []) {
    const bytes = blobs.get(sidecar.sha256)
    if (!bytes || bytes.byteLength !== sidecar.byteLength || sha256(bytes) !== sidecar.sha256)
      throw new RangeError('Cutout sidecar bytes are missing or do not match their digest')
    if (!maskPixels)
      throw new RangeError('Cutout alpha cannot be checked without a source-aligned packed mask')
    if (sidecar.width * sidecar.height > 24 * 1024 * 1024)
      throw new RangeError('Cutout exceeds bounded decode pixel count')
    const candidate = isCandidateProfile(identity.profileId)
    const decoded = await (
      candidate
        ? sharp(bytes, {
            raw: { width: sidecar.width, height: sidecar.height, channels: 4 },
            failOn: 'error',
            limitInputPixels: 24 * 1024 * 1024,
          })
        : sharp(bytes, { failOn: 'error', limitInputPixels: 24 * 1024 * 1024 })
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (
      decoded.info.width !== sidecar.width ||
      decoded.info.height !== sidecar.height ||
      decoded.info.channels !== 4
    )
      throw new RangeError('Decoded cutout dimensions/channels differ from sidecar geometry')
    if (candidate && bytes.byteLength !== sidecar.width * sidecar.height * 4)
      throw new RangeError('Candidate RGBA sidecar byte length differs from geometry')
    for (let y = 0; y < sidecar.height; y++) {
      for (let x = 0; x < sidecar.width; x++) {
        const alpha = decoded.data[(y * sidecar.width + x) * 4 + 3]! > 0
        const foreground =
          maskPixels[
            (sidecar.sourceOffset.y + y) * identity.sourceCanvasWidth + sidecar.sourceOffset.x + x
          ] === 1
        if (alpha !== foreground)
          throw new RangeError('Decoded cutout alpha does not match source mask crop')
      }
    }
  }
}

export class ImmutableCaseArtifactStore {
  constructor(readonly root: string) {}

  identity(rawIdentity: CaseArtifactIdentity): { value: CaseArtifactIdentity; sha256: string } {
    const value = identitySchema.parse(rawIdentity)
    return { value, sha256: hashIdentity(value) }
  }

  async load(
    identitySha256: string,
    expectedIdentity?: CaseArtifactIdentity,
  ): Promise<StoredCaseArtifact | null> {
    const expected =
      expectedIdentity === undefined ? undefined : identitySchema.parse(expectedIdentity)
    if (expected && hashIdentity(expected) !== identitySha256)
      throw new RangeError('Requested case identity digest mismatch')
    const rawIntent = await readOptional(intentPath(this.root, identitySha256))
    if (rawIntent === null) {
      if (await readOptional(recordPath(this.root, identitySha256)))
        throw new RangeError('Case artifact record has no matching durable intent')
      return null
    }
    const intent = intentSchema.parse(JSON.parse(rawIntent) as unknown)
    if (
      intent.identitySha256 !== identitySha256 ||
      hashIdentity(intent.identity) !== identitySha256
    )
      throw new RangeError('Case intent identity commitment mismatch')
    const validationIdentity = expected ?? intent.identity
    if (expected && hashIdentity(expected) !== hashIdentity(intent.identity))
      throw new RangeError('Persisted case intent differs from requested identity')
    const path = recordPath(this.root, identitySha256)
    const raw = await readOptional(path)
    if (raw === null)
      throw new RangeError('Case execution has an immutable pending intent; refusing replay')
    const parsed = z
      .object({
        schema: z.literal('h8a-case-artifact-v1'),
        identitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
        result: resultSchema,
        durationMs: z.number().finite().nonnegative().nullable(),
        startedAtIso: z.string().datetime({ offset: true }),
        completedAtIso: z.string().datetime({ offset: true }),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownDispatchCount: z.number().int().nonnegative(),
        blobs: z.array(
          z
            .object({
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              byteLength: z.number().int().positive(),
            })
            .strict(),
        ),
        recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .parse(JSON.parse(raw) as unknown)
    if (parsed.identitySha256 !== identitySha256)
      throw new RangeError('Case artifact identity mismatch')
    const { recordSha256, ...body } = parsed
    if (hashIdentity(body) !== recordSha256)
      throw new RangeError('Case artifact record digest mismatch')
    const result = resultSchema.parse(parsed.result) as CaseExecutionPortResult
    validateReceiptReferences(result)
    validateResultIdentity(result, validationIdentity)
    const artifactPaths: string[] = []
    const blobsBySha256 = new Map<string, Uint8Array>()
    for (const blob of parsed.blobs) {
      const blobPath = artifactPath(this.root, blob.sha256)
      const bytes = await readFile(blobPath)
      if (bytes.byteLength !== blob.byteLength || sha256(bytes) !== blob.sha256)
        throw new RangeError('Immutable case artifact blob is missing or corrupt')
      artifactPaths.push(blobPath)
      blobsBySha256.set(blob.sha256, new Uint8Array(bytes))
    }
    for (const sidecar of result.caseArtifactSidecars ?? []) {
      const matching = parsed.blobs.find(
        (item) => item.sha256 === sidecar.sha256 && item.byteLength === sidecar.byteLength,
      )
      if (!matching)
        throw new RangeError('Case cutout sidecar is not committed by the artifact record')
    }
    validateArtifactMap(result, blobsBySha256, validationIdentity)
    await validateSidecarBytes(result, blobsBySha256, validationIdentity)
    if (
      result.outputRow.maskPackedSha256 !== null &&
      !parsed.blobs.some((item) => item.sha256 === result.outputRow.maskPackedSha256)
    )
      throw new RangeError('Case mask artifact is missing from immutable record')
    return {
      identitySha256,
      result,
      durationMs: parsed.durationMs,
      startedAtIso: parsed.startedAtIso,
      completedAtIso: parsed.completedAtIso,
      knownCostUsd: parsed.knownCostUsd,
      unknownDispatchCount: parsed.unknownDispatchCount,
      artifactPaths,
      blobsBySha256,
    }
  }

  async loadOrRecover(identity: CaseArtifactIdentity): Promise<StoredCaseArtifact | null> {
    const parsed = identitySchema.parse(identity)
    const identitySha256 = hashIdentity(parsed)
    try {
      return await this.load(identitySha256, parsed)
    } catch (error) {
      if (!(error instanceof RangeError && error.message.includes('immutable pending intent')))
        throw error
    }
    const intentRaw = await readOptional(intentPath(this.root, identitySha256))
    if (intentRaw === null) throw new RangeError('Case recovery has no durable intent')
    const intent = intentSchema.parse(JSON.parse(intentRaw) as unknown)
    if (
      hashIdentity(intent.identity) !== identitySha256 ||
      hashIdentity(intent.identity) !== hashIdentity(parsed)
    )
      throw new RangeError('Pending case intent differs from recovery identity')
    const journalDirectory = join(this.root, 'dispatch-journal')
    let fileNames: string[]
    try {
      fileNames = await readdir(journalDirectory)
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')
        throw new RangeError('Pending case has no dispatch journal; refusing to infer a result')
      throw error
    }
    const entries: Array<
      z.infer<typeof completedDispatchSchema> | z.infer<typeof admittedDispatchSchema>
    > = []
    for (const fileName of fileNames) {
      if (!/^dispatch-[1-9][0-9]*\.json$/u.test(fileName)) continue
      const raw = await readOptional(join(journalDirectory, fileName))
      if (raw === null) continue
      const unknownEntry: unknown = JSON.parse(raw)
      const completed = completedDispatchSchema.safeParse(unknownEntry)
      const admitted = completed.success ? null : admittedDispatchSchema.safeParse(unknownEntry)
      const data = completed.success ? completed.data : admitted?.success ? admitted.data : null
      if (!data || data.caseExecutionIdentitySha256 !== identitySha256) continue
      if (data.opaqueCaseId !== parsed.opaqueCaseId || data.profileId !== parsed.profileId)
        throw new RangeError('Dispatch journal case/profile does not match pending identity')
      const expectedEndpoint =
        parsed.profileId === PROFILE_CANDIDATE_ID ||
        parsed.profileId === PROFILE_FLAT_CANDIDATE_ID ||
        parsed.profileId === PROFILE_SCOPE_CANDIDATE_ID
          ? ['/api/v1/chat/completions']
          : parsed.profileId === PROFILE_NATIVE_PRESENCE_CANDIDATE_ID
            ? ['/api/alpha/decisions', '/api/v1/chat/completions']
            : ['/api/alpha/decisions']
      if (!expectedEndpoint.includes(data.endpoint))
        throw new RangeError('Dispatch journal endpoint differs from frozen profile route')
      entries.push(data)
    }
    if (entries.length === 0)
      throw new RangeError(
        'Pending case has no correlated physical dispatch evidence; refusing recovery',
      )
    entries.sort((a, b) => {
      if (parsed.profileId === PROFILE_NATIVE_PRESENCE_CANDIDATE_ID) {
        const sourceOrder = (endpoint: typeof a.endpoint) =>
          endpoint === '/api/alpha/decisions' ? 0 : 1
        const bySource = sourceOrder(a.endpoint) - sourceOrder(b.endpoint)
        if (bySource !== 0) return bySource
      }
      return a.reservationId - b.reservationId
    })
    if (new Set(entries.map((entry) => entry.reservationId)).size !== entries.length)
      throw new RangeError('Pending dispatch journal contains duplicate reservation IDs')
    const sourceLogicalKey = (entry: (typeof entries)[number]) =>
      parsed.profileId === PROFILE_NATIVE_PRESENCE_CANDIDATE_ID
        ? `${entry.endpoint}:${entry.logicalId}`
        : `single:${entry.logicalId}`
    const localByRecorderLogicalId = new Map<string, number>()
    for (const entry of entries) {
      const key = sourceLogicalKey(entry)
      if (!localByRecorderLogicalId.has(key))
        localByRecorderLogicalId.set(key, localByRecorderLogicalId.size + 1)
    }
    const physicalReceipts = entries.map((entry) => {
      const completed = completedDispatchSchema.safeParse(entry)
      const final = completed.success ? completed.data : null
      return {
        receiptId: entry.reservationId,
        physicalId: final?.dispatchState === 'confirmed' ? final.physicalId : null,
        logicalId: localByRecorderLogicalId.get(sourceLogicalKey(entry))!,
        dispatchState:
          final?.dispatchState === 'confirmed' && final.settled
            ? ('confirmed' as const)
            : ('uncertain' as const),
        settled: final?.settled ?? false,
        costUsd: final?.costUsd ?? null,
        chargeState:
          final?.settled && final.costUsd !== null ? ('known' as const) : ('unknown' as const),
      }
    })
    const logicalReceipts = [...localByRecorderLogicalId.entries()].map(
      ([recorderLogicalKey, logicalId]) => {
        const related = entries.filter((entry) => sourceLogicalKey(entry) === recorderLogicalKey)
        return {
          logicalId,
          opaqueCaseId: parsed.opaqueCaseId,
          profileId: parsed.profileId,
          requestSha256: related[0]!.requestSha256,
          physicalIds: related.map((entry) => entry.reservationId),
          outcome: 'unknown' as const,
          errorCode: 'RECOVERED_AFTER_DISPATCH_WITHOUT_OUTPUT',
        }
      },
    )
    const result: CaseExecutionPortResult = {
      outputRow: {
        schema: 'h8a-fresh-output-row-v1',
        opaqueCaseId: parsed.opaqueCaseId,
        profileId: parsed.profileId,
        executionValidity: 'invalid',
        caseState: 'unknown',
        box: null,
        cutoutPresent: false,
        maskPackedSha256: null,
        logicalReceiptIds: logicalReceipts.map((row) => row.logicalId),
        physicalReceiptIds: physicalReceipts.map((row) => row.receiptId),
      },
      caseError: 'RECOVERED_AFTER_DISPATCH_WITHOUT_OUTPUT',
      logicalReceipts,
      physicalReceipts,
    }
    const completedAtIso = new Date().toISOString()
    return this.complete({
      identitySha256,
      identity: parsed,
      result,
      durationMs: null,
      startedAtIso: intent.startedAtIso,
      completedAtIso,
      knownCostUsd: physicalReceipts.reduce(
        (sum, receipt) => sum + (receipt.chargeState === 'known' ? (receipt.costUsd ?? 0) : 0),
        0,
      ),
      unknownDispatchCount: physicalReceipts.filter((receipt) => receipt.chargeState === 'unknown')
        .length,
      blobs: new Map(),
    })
  }

  async begin(
    rawIdentity: CaseArtifactIdentity,
    startedAtIso: string,
  ): Promise<{
    identitySha256: string
    identity: CaseArtifactIdentity
    existing: StoredCaseArtifact | null
  }> {
    const identity = this.identity(rawIdentity)
    const existing = await this.load(identity.sha256, identity.value)
    if (existing) return { identitySha256: identity.sha256, identity: identity.value, existing }
    const path = intentPath(this.root, identity.sha256)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const intent =
      JSON.stringify({
        schema: 'h8a-case-intent-v1',
        identity: identity.value,
        identitySha256: identity.sha256,
        startedAtIso,
        token: randomUUID(),
      }) + '\n'
    try {
      await writeFile(path, intent, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
      const existingRecord = await this.load(identity.sha256, identity.value)
      if (existingRecord)
        return {
          identitySha256: identity.sha256,
          identity: identity.value,
          existing: existingRecord,
        }
      throw new RangeError('Case execution has an immutable pending intent; refusing replay')
    }
    return { identitySha256: identity.sha256, identity: identity.value, existing: null }
  }

  async complete(input: {
    identitySha256: string
    result: CaseExecutionPortResult
    durationMs: number | null
    startedAtIso: string
    completedAtIso: string
    knownCostUsd: number
    unknownDispatchCount: number
    identity: CaseArtifactIdentity
    blobs: ReadonlyMap<string, Uint8Array>
  }): Promise<StoredCaseArtifact> {
    const result = resultSchema.parse(input.result) as CaseExecutionPortResult
    validateReceiptReferences(result)
    const identity = identitySchema.parse(input.identity)
    if (hashIdentity(identity) !== input.identitySha256)
      throw new RangeError('Completed case identity digest mismatch')
    validateResultIdentity(result, identity)
    const intentRaw = await readOptional(intentPath(this.root, input.identitySha256))
    if (intentRaw === null) throw new RangeError('Case completion has no durable intent')
    const intent = intentSchema.parse(JSON.parse(intentRaw) as unknown)
    if (
      hashIdentity(intent.identity) !== hashIdentity(identity) ||
      intent.identitySha256 !== input.identitySha256
    )
      throw new RangeError('Case completion does not match durable intent')
    const blobEntries: Array<{ sha256: string; byteLength: number }> = []
    for (const [declaredSha, bytes] of input.blobs) {
      if (sha256(bytes) !== declaredSha)
        throw new RangeError('Case artifact bytes do not match their digest')
      const path = artifactPath(this.root, declaredSha)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      let isPresent = true
      try {
        await readFile(path)
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') isPresent = false
        else throw error
      }
      if (!isPresent) {
        try {
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
        }
      }
      const saved = await readFile(path)
      if (sha256(saved) !== declaredSha || saved.byteLength !== bytes.byteLength)
        throw new RangeError('Content-addressed case artifact conflicts with existing bytes')
      blobEntries.push({ sha256: declaredSha, byteLength: bytes.byteLength })
    }
    validateArtifactMap(result, input.blobs, identity)
    await validateSidecarBytes(result, input.blobs, identity)
    for (const sidecar of result.caseArtifactSidecars ?? []) {
      if (
        !blobEntries.some(
          (item) => item.sha256 === sidecar.sha256 && item.byteLength === sidecar.byteLength,
        )
      )
        throw new RangeError('Cutout sidecar bytes were not supplied for persistence')
    }
    if (
      result.outputRow.maskPackedSha256 !== null &&
      !blobEntries.some((item) => item.sha256 === result.outputRow.maskPackedSha256)
    )
      throw new RangeError('Mask bytes were not supplied for persistence')
    const body = {
      schema: 'h8a-case-artifact-v1' as const,
      identitySha256: input.identitySha256,
      result,
      durationMs: input.durationMs,
      startedAtIso: input.startedAtIso,
      completedAtIso: input.completedAtIso,
      knownCostUsd: input.knownCostUsd,
      unknownDispatchCount: input.unknownDispatchCount,
      blobs: blobEntries,
    }
    const record = { ...body, recordSha256: hashIdentity(body) }
    const path = recordPath(this.root, input.identitySha256)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      await writeFile(path, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
      throw new RangeError('Immutable case artifact record already exists')
    }
    const artifactPaths = blobEntries.map((blob) => artifactPath(this.root, blob.sha256))
    const blobsBySha256 = new Map<string, Uint8Array>()
    for (const blob of blobEntries)
      blobsBySha256.set(
        blob.sha256,
        new Uint8Array(await readFile(artifactPath(this.root, blob.sha256))),
      )
    return {
      identitySha256: input.identitySha256,
      result,
      durationMs: input.durationMs,
      startedAtIso: input.startedAtIso,
      completedAtIso: input.completedAtIso,
      knownCostUsd: input.knownCostUsd,
      unknownDispatchCount: input.unknownDispatchCount,
      artifactPaths,
      blobsBySha256,
    }
  }
}
