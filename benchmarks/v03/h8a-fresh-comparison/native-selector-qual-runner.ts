import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import type { CaseArtifactIdentity } from './case-artifact-store.js'
import {
  PROFILE_CONTROL_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
  PHASE_NATIVE_SELECTOR_QUAL120_ID,
} from './constants.js'
import { joinCloseoutsWithPrivateAnnotations, evaluateQual120Gate } from './evaluator.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { hashIdentity } from './hash-identity.js'
import type { CaseExecutionPort, CaseExecutionPortResult } from './paired-runner.js'
import { runPairedPhase } from './paired-runner.js'
import { remapProviderRefusalReplayEvidence } from './provider-refusal-replay.js'
import type { FreshRuntimeArtifacts } from './runtime-ports.js'
import {
  evaluatorPrivateAnnotationBundleSchema,
  immutableCloseoutSchema,
  phaseFreezeSchema,
} from './schemas.js'
import type { EvaluatorPrivateAnnotationBundle, ImmutableCloseout, PhaseFreeze } from './schemas.js'
import {
  isVerifiedNativeSelectorQualAdmission,
  nativeSelectorQualAdmissionSnapshot,
} from './native-selector-qual-admission.js'
import type { VerifiedNativeSelectorQualAdmission } from './native-selector-qual-admission.js'
import { NativeSelectorQualLedger } from './native-selector-qual-ledger.js'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function buildNativeSelectorQualCaseArtifactIdentity(
  admission: VerifiedNativeSelectorQualAdmission,
  producer: PhaseFreeze['producerCases'][number],
  profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
): CaseArtifactIdentity {
  return buildIdentity(admission.freeze, admission.selectionCommitmentSha256, producer, profileId)
}

function buildIdentity(
  freeze: PhaseFreeze,
  selectionCommitmentSha256: string,
  producer: PhaseFreeze['producerCases'][number],
  profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
): CaseArtifactIdentity {
  const binding = freeze.profileBindings.find((item) => item.profileId === profileId)
  if (!binding) throw new RangeError('QUAL profile binding is missing from its freeze')
  return {
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
    sourceManifestSha256: freeze.sourceBytesManifestSha256,
    recipeIdentitySha256: binding.recipeIdentitySha256,
    requestPolicyIdentitySha256: binding.requestPolicyIdentitySha256,
    pairedScheduleSha256: hashIdentity(freeze.pairedSchedule),
    selectionCommitmentSha256,
    opaqueCaseId: producer.opaqueCaseId,
    profileId,
    sourceBytesSha256: producer.sourceBytesSha256,
    targetTaskSha256: hashIdentity(producer.targetTaskText),
    sourceCanvasWidth: producer.sourceCanvasWidth,
    sourceCanvasHeight: producer.sourceCanvasHeight,
    ...(freeze.executionPolicy
      ? { executionPolicySha256: freeze.executionPolicy.policySha256 }
      : {}),
  }
}

function artifactsForResult(
  result: CaseExecutionPortResult,
  artifacts: FreshRuntimeArtifacts,
): ReadonlyMap<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>()
  if (result.outputRow.maskPackedSha256) {
    const mask = artifacts.masksBySha256.get(result.outputRow.maskPackedSha256)
    if (mask) blobs.set(mask.sha256, new Uint8Array(mask.packedBytes))
  }
  for (const sidecar of result.caseArtifactSidecars ?? []) {
    const cutout = artifacts.cutoutsBySha256.get(sidecar.sha256)
    if (cutout) blobs.set(cutout.sha256, new Uint8Array(cutout.bytes))
  }
  return blobs
}

function immutableCloseoutBytes(closeoutValue: unknown, freeze: PhaseFreeze): Buffer {
  const closeout = immutableCloseoutSchema.parse(closeoutValue)
  const binding = freeze.profileBindings.find((item) => item.profileId === closeout.profileId)
  if (
    closeout.phaseId !== PHASE_NATIVE_SELECTOR_QUAL120_ID ||
    closeout.freezeId !== freeze.freezeId ||
    closeout.producerClosureSha256 !== freeze.producerClosureSha256 ||
    !binding ||
    closeout.recipeIdentitySha256 !== binding.recipeIdentitySha256 ||
    closeout.requestPolicyIdentitySha256 !== binding.requestPolicyIdentitySha256 ||
    closeout.outputRows.length !== 120
  )
    throw new RangeError('QUAL closeout is not complete or does not match the frozen producer')
  return Buffer.from(`${JSON.stringify(closeout)}\n`)
}

async function persistImmutable(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if (!(await readFile(path)).equals(bytes)) throw new RangeError('QUAL closeout is immutable')
  }
}

interface NativeSelectorQualRunnerOptions {
  admission: VerifiedNativeSelectorQualAdmission
  candidatePort: CaseExecutionPort
  controlPort: CaseExecutionPort
  runtimeArtifacts: FreshRuntimeArtifacts
  disposeRuntime(): Promise<void>
  signal?: AbortSignal
  now?: () => string
}

/** Runs one admitted QUAL120 pair and writes per-arm receipts before advancing. */
export async function runNativeSelectorQual120(options: NativeSelectorQualRunnerOptions): Promise<{
  candidateCloseout: ImmutableCloseout
  controlCloseout: ImmutableCloseout
  gate: ReturnType<typeof evaluateQual120Gate>
}> {
  const disposeRuntime = options.disposeRuntime
  try {
    const admission = options.admission
    const candidatePort = options.candidatePort
    const controlPort = options.controlPort
    const runtimeArtifacts = options.runtimeArtifacts
    const signal = options.signal
    const now = options.now
    if (!isVerifiedNativeSelectorQualAdmission(admission))
      throw new RangeError('QUAL runner requires a verified immutable admission')
    const freeze = phaseFreezeSchema.parse(admission.freeze)
    const annotations: EvaluatorPrivateAnnotationBundle =
      evaluatorPrivateAnnotationBundleSchema.parse(admission.annotations)
    const sourceBytes = new Map<string, Uint8Array>()
    for (const producer of freeze.producerCases) {
      const bytes = admission.sourceBytes.get(producer.opaqueCaseId)
      if (!bytes || sha256(bytes) !== producer.sourceBytesSha256)
        throw new RangeError('QUAL runner source snapshot differs from its frozen producer')
      sourceBytes.set(producer.opaqueCaseId, new Uint8Array(bytes))
    }
    const referenceMaskBytes = new Map<string, Uint8Array>(
      [...admission.referenceMaskBytes].map(([digest, bytes]) => [digest, new Uint8Array(bytes)]),
    )
    const selectionCommitmentSha256 = `${admission.selectionCommitmentSha256}`
    if (freeze.phaseId !== PHASE_NATIVE_SELECTOR_QUAL120_ID || freeze.producerCases.length !== 120)
      throw new RangeError('QUAL runner requires the frozen 120-case selector phase')
    const authority = nativeSelectorQualAdmissionSnapshot(admission)
    const namespaceRoot = authority.namespaceRoot
    const executionRoot = join(namespaceRoot, 'execution')
    const store = new ImmutableCaseArtifactStore(executionRoot)
    const ledger =
      authority.authority === 'offlineTestOnly'
        ? await NativeSelectorQualLedger.openOfflineAdmissionForTest(
            join(namespaceRoot, 'campaign-ledger.json'),
            namespaceRoot,
            admission,
          )
        : await NativeSelectorQualLedger.open(
            join(namespaceRoot, 'admission', 'campaign-ledger.json'),
            admission,
          )
    const wrappedPort = (
      port: CaseExecutionPort,
      profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
    ): CaseExecutionPort => ({
      async execute(input, context) {
        if (context.profileId !== profileId)
          throw new RangeError('QUAL runner arm profile mismatch')
        const producer = freeze.producerCases.find((row) => row.opaqueCaseId === input.opaqueCaseId)
        const source = sourceBytes.get(input.opaqueCaseId)
        if (!producer || !source || sha256(source) !== producer.sourceBytesSha256)
          throw new RangeError('QUAL runner source bytes do not match their frozen producer')
        const identity = buildIdentity(freeze, selectionCommitmentSha256, producer, profileId)
        const startedAtIso = (now ?? (() => new Date().toISOString()))()
        const started = performance.now()
        const opened = await store.begin(identity, startedAtIso)
        if (opened.existing)
          throw new RangeError('QUAL artifact intent already exists; resume is forbidden')
        const ownedInput = {
          opaqueCaseId: input.opaqueCaseId,
          sourceBytes: new Uint8Array(source),
          targetTaskText: `${producer.targetTaskText}`,
        }
        let result: CaseExecutionPortResult
        try {
          result = await port.execute(ownedInput, {
            ...context,
            caseExecutionIdentitySha256: opened.identitySha256,
          })
        } catch (error) {
          const partial = context.dispatchJournal?.lastPartialResult
          if (partial)
            await persistResult(
              opened.identity,
              opened.identitySha256,
              partial,
              startedAtIso,
              started,
              runtimeArtifacts,
              store,
            )
          throw error
        }
        await persistResult(
          opened.identity,
          opened.identitySha256,
          result,
          startedAtIso,
          started,
          runtimeArtifacts,
          store,
        )
        return result
      },
    })
    const result = await runPairedPhase({
      freeze,
      ledger,
      candidatePort: wrappedPort(candidatePort, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID),
      controlPort: wrappedPort(controlPort, PROFILE_CONTROL_ID),
      sourceBytesByCaseId: sourceBytes,
      ...(signal ? { signal } : {}),
      ...(now ? { now } : {}),
    })
    const candidateBytes = immutableCloseoutBytes(result.candidateCloseout, freeze)
    const controlBytes = immutableCloseoutBytes(result.controlCloseout, freeze)
    await persistImmutable(
      join(executionRoot, 'closeouts', 'candidate-closeout.json'),
      candidateBytes,
    )
    await persistImmutable(join(executionRoot, 'closeouts', 'control-closeout.json'), controlBytes)
    const candidateCloseout = immutableCloseoutSchema.parse(
      JSON.parse(candidateBytes.toString('utf8')),
    )
    const controlCloseout = immutableCloseoutSchema.parse(JSON.parse(controlBytes.toString('utf8')))
    const packedMasksBySha256 = new Map<string, Uint8Array>(referenceMaskBytes)
    for (const profileId of [PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, PROFILE_CONTROL_ID] as const) {
      for (const producer of freeze.producerCases) {
        const identity = buildIdentity(freeze, selectionCommitmentSha256, producer, profileId)
        const stored = await store.load(hashIdentity(identity), identity)
        if (!stored?.result.outputRow.maskPackedSha256) continue
        const mask = stored.blobsBySha256.get(stored.result.outputRow.maskPackedSha256)
        if (mask)
          packedMasksBySha256.set(stored.result.outputRow.maskPackedSha256, new Uint8Array(mask))
      }
    }
    const rows = joinCloseoutsWithPrivateAnnotations({
      freeze,
      candidateCloseout,
      controlCloseout,
      annotations,
      packedMasksBySha256,
    })
    return {
      candidateCloseout,
      controlCloseout,
      gate: evaluateQual120Gate(rows, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID),
    }
  } finally {
    await disposeRuntime()
  }
}

export async function assembleNativeSelectorQualCloseouts(
  admission: VerifiedNativeSelectorQualAdmission,
): Promise<{
  candidateCloseout: ImmutableCloseout
  controlCloseout: ImmutableCloseout
  gate: ReturnType<typeof evaluateQual120Gate>
}> {
  if (!isVerifiedNativeSelectorQualAdmission(admission))
    throw new RangeError('QUAL closeout requires verified immutable admission')
  const authority = nativeSelectorQualAdmissionSnapshot(admission)
  const freeze = phaseFreezeSchema.parse(admission.freeze)
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(admission.annotations)
  const sourceBytes = new Map<string, Uint8Array>()
  for (const producer of freeze.producerCases) {
    const bytes = admission.sourceBytes.get(producer.opaqueCaseId)
    if (!bytes || sha256(bytes) !== producer.sourceBytesSha256)
      throw new RangeError('QUAL closeout source snapshot differs from its frozen producer')
    sourceBytes.set(producer.opaqueCaseId, new Uint8Array(bytes))
  }
  const selectionCommitmentSha256 = `${admission.selectionCommitmentSha256}`
  const executionRoot = join(authority.namespaceRoot, 'execution')
  const store = new ImmutableCaseArtifactStore(executionRoot)
  const candidatePath = join(executionRoot, 'closeouts', 'candidate-closeout.json')
  const controlPath = join(executionRoot, 'closeouts', 'control-closeout.json')
  const candidateExisting = await readExistingCloseout(candidatePath)
  const controlExisting = await readExistingCloseout(controlPath)
  const rowsByProfile = new Map([
    [PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, [] as CaseExecutionPortResult['outputRow'][]],
    [PROFILE_CONTROL_ID, [] as CaseExecutionPortResult['outputRow'][]],
  ])
  const logicalByProfile = new Map([
    [PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, [] as CaseExecutionPortResult['logicalReceipts']],
    [PROFILE_CONTROL_ID, [] as CaseExecutionPortResult['logicalReceipts']],
  ])
  const physicalByProfile = new Map([
    [PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, [] as CaseExecutionPortResult['physicalReceipts']],
    [PROFILE_CONTROL_ID, [] as CaseExecutionPortResult['physicalReceipts']],
  ])
  const packedMasksBySha256 = new Map<string, Uint8Array>(
    [...admission.referenceMaskBytes].map(([digest, bytes]) => [digest, new Uint8Array(bytes)]),
  )
  let nextLogicalId = 1
  let nextReceiptId = 1

  for (const schedule of freeze.pairedSchedule) {
    const producer = freeze.producerCases.find((row) => row.opaqueCaseId === schedule.opaqueCaseId)
    if (!producer) throw new RangeError('QUAL closeout schedule references no frozen producer')
    const order = schedule.candidateArmFirst
      ? ([PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, PROFILE_CONTROL_ID] as const)
      : ([PROFILE_CONTROL_ID, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID] as const)
    for (const profileId of order) {
      const identity = buildIdentity(freeze, selectionCommitmentSha256, producer, profileId)
      const stored = await store.loadOrRecover(identity)
      if (stored?.result.outputRow.maskPackedSha256) {
        const packed = stored.blobsBySha256.get(stored.result.outputRow.maskPackedSha256)
        if (packed)
          packedMasksBySha256.set(stored.result.outputRow.maskPackedSha256, new Uint8Array(packed))
      }
      if (
        (profileId === PROFILE_NATIVE_SELECTOR_CANDIDATE_ID && candidateExisting) ||
        (profileId === PROFILE_CONTROL_ID && controlExisting)
      )
        continue
      if (!stored) {
        rowsByProfile.get(profileId)!.push(unstartedRow(producer.opaqueCaseId, profileId))
        continue
      }
      const result = stored.result
      const logicalMap = new Map<number, number>()
      for (const receipt of result.logicalReceipts) {
        if (logicalMap.has(receipt.logicalId))
          throw new RangeError('QUAL case artifact repeats a logical receipt ID')
        logicalMap.set(receipt.logicalId, nextLogicalId++)
      }
      const receiptMap = new Map<number, number>()
      for (const receipt of result.physicalReceipts) {
        if (!receiptMap.has(receipt.receiptId)) receiptMap.set(receipt.receiptId, nextReceiptId++)
      }
      const getLogicalId = (id: number): number => {
        const mapped = logicalMap.get(id)
        if (mapped === undefined)
          throw new RangeError('QUAL stored receipt graph has an unknown logical ID')
        return mapped
      }
      const getReceiptId = (id: number): number => {
        const mapped = receiptMap.get(id)
        if (mapped === undefined)
          throw new RangeError('QUAL stored receipt graph has an unknown local physical receipt ID')
        return mapped
      }
      const logical = result.logicalReceipts.map((receipt) => ({
        ...receipt,
        logicalId: getLogicalId(receipt.logicalId),
        physicalIds: receipt.physicalIds.map(getReceiptId),
      }))
      const physical = result.physicalReceipts.map((receipt) => ({
        ...receipt,
        receiptId: getReceiptId(receipt.receiptId),
        logicalId: getLogicalId(receipt.logicalId),
      }))
      const row = {
        ...result.outputRow,
        logicalReceiptIds: result.outputRow.logicalReceiptIds.map(getLogicalId),
        physicalReceiptIds: result.outputRow.physicalReceiptIds.map(getReceiptId),
        ...(result.outputRow.providerRefusalEvidence
          ? {
              providerRefusalEvidence: remapProviderRefusalReplayEvidence(
                result.outputRow.providerRefusalEvidence,
                logicalMap,
                receiptMap,
              ),
            }
          : {}),
      }
      rowsByProfile.get(profileId)!.push(row)
      logicalByProfile.get(profileId)!.push(...logical)
      physicalByProfile.get(profileId)!.push(...physical)
    }
  }
  const candidateCloseout =
    candidateExisting ??
    buildQualCloseout({
      freeze,
      profileId: PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
      rows: rowsByProfile.get(PROFILE_NATIVE_SELECTOR_CANDIDATE_ID)!,
      logicalReceipts: logicalByProfile.get(PROFILE_NATIVE_SELECTOR_CANDIDATE_ID)!,
      physicalReceipts: physicalByProfile.get(PROFILE_NATIVE_SELECTOR_CANDIDATE_ID)!,
    })
  const controlCloseout =
    controlExisting ??
    buildQualCloseout({
      freeze,
      profileId: PROFILE_CONTROL_ID,
      rows: rowsByProfile.get(PROFILE_CONTROL_ID)!,
      logicalReceipts: logicalByProfile.get(PROFILE_CONTROL_ID)!,
      physicalReceipts: physicalByProfile.get(PROFILE_CONTROL_ID)!,
    })
  await persistImmutable(candidatePath, immutableCloseoutBytes(candidateCloseout, freeze))
  await persistImmutable(controlPath, immutableCloseoutBytes(controlCloseout, freeze))
  const rows = joinCloseoutsWithPrivateAnnotations({
    freeze,
    candidateCloseout,
    controlCloseout,
    annotations,
    packedMasksBySha256,
  })
  return {
    candidateCloseout,
    controlCloseout,
    gate: evaluateQual120Gate(rows, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID),
  }
}

async function readExistingCloseout(path: string): Promise<ImmutableCloseout | null> {
  try {
    return immutableCloseoutSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  }
}

function unstartedRow(
  opaqueCaseId: string,
  profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID,
): CaseExecutionPortResult['outputRow'] {
  return {
    schema: 'h8a-fresh-output-row-v1',
    opaqueCaseId,
    profileId,
    executionValidity: 'valid',
    caseState: 'unstarted',
    box: null,
    cutoutPresent: false,
    maskPackedSha256: null,
    logicalReceiptIds: [],
    physicalReceiptIds: [],
  }
}

function buildQualCloseout(input: {
  freeze: PhaseFreeze
  profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID
  rows: CaseExecutionPortResult['outputRow'][]
  logicalReceipts: CaseExecutionPortResult['logicalReceipts']
  physicalReceipts: CaseExecutionPortResult['physicalReceipts']
}): ImmutableCloseout {
  const binding = input.freeze.profileBindings.find((row) => row.profileId === input.profileId)
  if (!binding) throw new RangeError('QUAL closeout is missing its frozen profile binding')
  const body = {
    schema: 'h8a-fresh-immutable-closeout-v1' as const,
    freezeId: input.freeze.freezeId,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(input.freeze),
    phaseId: input.freeze.phaseId,
    profileId: input.profileId,
    closedAtIso: new Date().toISOString(),
    cohortCommitmentSha256: input.freeze.cohortCommitmentSha256,
    producerClosureSha256: input.freeze.producerClosureSha256,
    recipeIdentitySha256: binding.recipeIdentitySha256,
    requestPolicyIdentitySha256: binding.requestPolicyIdentitySha256,
    outputRows: input.rows,
    logicalReceipts: input.logicalReceipts,
    physicalReceipts: input.physicalReceipts,
    logicalAttemptCount: input.logicalReceipts.length,
    physicalDispatchCount: input.physicalReceipts.filter((row) => row.dispatchState === 'confirmed')
      .length,
    uncertainDispatchCount: input.physicalReceipts.filter(
      (row) => row.dispatchState === 'uncertain',
    ).length,
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
  return immutableCloseoutSchema.parse({ ...body, closeoutSha256 })
}

async function persistResult(
  identity: CaseArtifactIdentity,
  identitySha256: string,
  result: CaseExecutionPortResult,
  startedAtIso: string,
  startedAt: number,
  artifacts: FreshRuntimeArtifacts,
  store: ImmutableCaseArtifactStore,
): Promise<void> {
  const cost = result.physicalReceipts.reduce(
    (sum, receipt) => sum + (receipt.chargeState === 'known' ? (receipt.costUsd ?? 0) : 0),
    0,
  )
  await store.complete({
    identitySha256,
    identity,
    result,
    durationMs: Math.max(0, performance.now() - startedAt),
    startedAtIso,
    completedAtIso: new Date().toISOString(),
    knownCostUsd: cost,
    unknownDispatchCount: result.physicalReceipts.filter(
      (receipt) => receipt.chargeState === 'unknown',
    ).length,
    blobs: artifactsForResult(result, artifacts),
  })
}
