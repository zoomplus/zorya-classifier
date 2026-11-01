import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CampaignLedgerPort } from './campaign-ledger-port.js'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import { PROFILE_CONTROL_ID, isDevPhase, candidateIdForPhase } from './constants.js'
import type { H8aFreshProfileId } from './profiles.js'
import { validateImmutableCloseouts } from './evaluator.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { hashIdentity } from './hash-identity.js'
import { buildCaseArtifactIdentity } from './dev-screen-runner.js'
import { validateDevScreenSelection } from './dev-screen-sampling.js'
import type { DevScreenSelection } from './dev-screen-sampling.js'
import type { EvaluatorPrivateAnnotationBundle } from './schemas.js'
import type { CaseExecutionPortResult } from './paired-runner.js'
import type { ImmutableCloseout, OutputRow, PhaseFreeze } from './schemas.js'
import { immutableCloseoutSchema, outputRowSchema, phaseFreezeSchema } from './schemas.js'
import { remapProviderRefusalReplayEvidence } from './provider-refusal-replay.js'

interface Dev40CloseoutAssembly {
  candidateCloseout: ImmutableCloseout
  controlCloseout: ImmutableCloseout
  packedMasksBySha256: ReadonlyMap<string, Uint8Array>
  missingPredictionRows: number
}

function hashCloseout(closeout: Omit<ImmutableCloseout, 'closeoutSha256'>): string {
  return hashIdentity({
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
}

function emptyRow(caseId: string, profileId: H8aFreshProfileId): OutputRow {
  return outputRowSchema.parse({
    schema: 'h8a-fresh-output-row-v1',
    opaqueCaseId: caseId,
    profileId,
    executionValidity: 'valid',
    caseState: 'unstarted',
    box: null,
    cutoutPresent: false,
    maskPackedSha256: null,
    logicalReceiptIds: [],
    physicalReceiptIds: [],
  })
}

function remapResult(
  result: CaseExecutionPortResult,
  nextLogicalId: number,
): {
  row: OutputRow
  logical: CaseExecutionPortResult['logicalReceipts']
  physical: CaseExecutionPortResult['physicalReceipts']
  nextLogicalId: number
} {
  const logicalIdMap = new Map<number, number>()
  for (const receipt of result.logicalReceipts) logicalIdMap.set(receipt.logicalId, nextLogicalId++)
  const physicalReceiptIdMap = new Map<number, number>()
  for (const receipt of result.physicalReceipts)
    if (!physicalReceiptIdMap.has(receipt.receiptId))
      physicalReceiptIdMap.set(receipt.receiptId, receipt.receiptId)
  const logical = result.logicalReceipts.map((receipt) => ({
    ...receipt,
    logicalId: logicalIdMap.get(receipt.logicalId)!,
    physicalIds: receipt.physicalIds.map((id) => physicalReceiptIdMap.get(id) ?? id),
  }))
  const physical = result.physicalReceipts.map((receipt) => ({
    ...receipt,
    logicalId: logicalIdMap.get(receipt.logicalId)!,
    receiptId: physicalReceiptIdMap.get(receipt.receiptId)!,
  }))
  const row = outputRowSchema.parse({
    ...result.outputRow,
    logicalReceiptIds: result.outputRow.logicalReceiptIds.map((id) => logicalIdMap.get(id)!),
    physicalReceiptIds: result.outputRow.physicalReceiptIds.map(
      (id) => physicalReceiptIdMap.get(id) ?? id,
    ),
    ...(result.outputRow.providerRefusalEvidence
      ? {
          providerRefusalEvidence: remapProviderRefusalReplayEvidence(
            result.outputRow.providerRefusalEvidence,
            logicalIdMap,
            physicalReceiptIdMap,
          ),
        }
      : {}),
  })
  return { row, logical, physical, nextLogicalId }
}

function buildCloseout(input: {
  freeze: PhaseFreeze
  profileId: H8aFreshProfileId
  rows: OutputRow[]
  logicalReceipts: CaseExecutionPortResult['logicalReceipts']
  physicalReceipts: CaseExecutionPortResult['physicalReceipts']
  closedAtIso: string
}): ImmutableCloseout {
  const binding = input.freeze.profileBindings.find((item) => item.profileId === input.profileId)
  if (!binding) throw new RangeError('DEV40 closeout profile is not committed by freeze')
  const base = {
    schema: 'h8a-fresh-immutable-closeout-v1' as const,
    freezeId: input.freeze.freezeId,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(input.freeze),
    phaseId: input.freeze.phaseId,
    profileId: input.profileId,
    closedAtIso: input.closedAtIso,
    cohortCommitmentSha256: input.freeze.cohortCommitmentSha256,
    producerClosureSha256: input.freeze.producerClosureSha256,
    recipeIdentitySha256: binding.recipeIdentitySha256,
    requestPolicyIdentitySha256: binding.requestPolicyIdentitySha256,
    outputRows: input.rows,
    logicalReceipts: input.logicalReceipts,
    physicalReceipts: input.physicalReceipts,
    logicalAttemptCount: input.logicalReceipts.length,
    physicalDispatchCount: input.physicalReceipts.filter(
      (item) => item.dispatchState === 'confirmed',
    ).length,
    uncertainDispatchCount: input.physicalReceipts.filter(
      (item) => item.dispatchState === 'uncertain',
    ).length,
  }
  return immutableCloseoutSchema.parse({ ...base, closeoutSha256: hashCloseout(base) })
}

async function persistCloseout(path: string, closeout: ImmutableCloseout): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = `${JSON.stringify(closeout)}\n`
  try {
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if ((await readFile(path, 'utf8')) !== bytes)
      throw new RangeError('DEV40 closeout is immutable and conflicts with existing file')
  }
}

export async function assembleDev40Closeouts(input: {
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  selection: DevScreenSelection
  artifactRoot: string
  ledger: CampaignLedgerPort
  closedAtIso?: string
}): Promise<Dev40CloseoutAssembly> {
  const freeze = phaseFreezeSchema.parse(input.freeze)
  const candidateId = candidateIdForPhase(freeze.phaseId)
  const annotations = input.annotations
  const selection = validateDevScreenSelection(input.selection, freeze, annotations)
  if (!isDevPhase(freeze.phaseId))
    throw new RangeError('Full DEV40 assembly requires a DEV40 freeze')
  if (selection.devFreezeCommitmentSha256 !== computePhaseFreezeCommitmentSha256(freeze))
    throw new RangeError('DEV40 assembly selection is bound to a different freeze')
  const snapshot = input.ledger.snapshot()
  const store = new ImmutableCaseArtifactStore(input.artifactRoot)
  const rowsByProfile = new Map([
    [candidateId, [] as OutputRow[]],
    [PROFILE_CONTROL_ID, [] as OutputRow[]],
  ])
  const logicalByProfile = new Map([
    [candidateId, [] as CaseExecutionPortResult['logicalReceipts']],
    [PROFILE_CONTROL_ID, [] as CaseExecutionPortResult['logicalReceipts']],
  ])
  const physicalByProfile = new Map([
    [candidateId, [] as CaseExecutionPortResult['physicalReceipts']],
    [PROFILE_CONTROL_ID, [] as CaseExecutionPortResult['physicalReceipts']],
  ])
  const packedMasksBySha256 = new Map<string, Uint8Array>()
  let nextLogicalId = 1
  let missingPredictionRows = 0

  for (const producer of freeze.producerCases) {
    for (const profileId of [candidateId, PROFILE_CONTROL_ID] as const) {
      const identity = buildCaseArtifactIdentity(freeze, selection, producer, profileId)
      const stored = await store.loadOrRecover(identity)
      if (!stored) {
        rowsByProfile.get(profileId)!.push(emptyRow(producer.opaqueCaseId, profileId))
        missingPredictionRows++
        continue
      }
      const remapped = remapResult(stored.result, nextLogicalId)
      nextLogicalId = remapped.nextLogicalId
      rowsByProfile.get(profileId)!.push(remapped.row)
      logicalByProfile.get(profileId)!.push(...remapped.logical)
      physicalByProfile.get(profileId)!.push(...remapped.physical)
      if (stored.result.outputRow.maskPackedSha256) {
        const packed = stored.blobsBySha256.get(stored.result.outputRow.maskPackedSha256)
        if (!packed) throw new RangeError('Persisted DEV40 mask bytes are missing')
        packedMasksBySha256.set(stored.result.outputRow.maskPackedSha256, new Uint8Array(packed))
      }
    }
  }

  const candidateCloseout = buildCloseout({
    freeze,
    profileId: candidateId,
    rows: rowsByProfile.get(candidateId)!,
    logicalReceipts: logicalByProfile.get(candidateId)!,
    physicalReceipts: physicalByProfile.get(candidateId)!,
    closedAtIso: input.closedAtIso ?? new Date().toISOString(),
  })
  const controlCloseout = buildCloseout({
    freeze,
    profileId: PROFILE_CONTROL_ID,
    rows: rowsByProfile.get(PROFILE_CONTROL_ID)!,
    logicalReceipts: logicalByProfile.get(PROFILE_CONTROL_ID)!,
    physicalReceipts: physicalByProfile.get(PROFILE_CONTROL_ID)!,
    closedAtIso: input.closedAtIso ?? candidateCloseout.closedAtIso,
  })
  validateImmutableCloseouts({ freeze, candidateCloseout, controlCloseout })
  const confirmed = candidateCloseout.physicalDispatchCount + controlCloseout.physicalDispatchCount
  const caseAttempts = [...candidateCloseout.outputRows, ...controlCloseout.outputRows].filter(
    (row) => row.caseState !== 'unstarted',
  ).length
  if (confirmed > snapshot.physicalDispatchCount || caseAttempts > snapshot.logicalAttemptCount)
    throw new RangeError(
      'DEV40 physical receipts or executed case arms exceed persisted campaign ledger totals',
    )
  const allPhysicalReceipts = [
    ...candidateCloseout.physicalReceipts,
    ...controlCloseout.physicalReceipts,
  ]
  if (
    allPhysicalReceipts.length !==
    new Set(allPhysicalReceipts.map((receipt) => receipt.receiptId)).size
  )
    throw new RangeError('DEV40 paired closeouts contain duplicate campaign reservation IDs')
  const representedInFlight = new Set(
    allPhysicalReceipts
      .filter((receipt) => receipt.dispatchState === 'uncertain' && !receipt.settled)
      .map((receipt) => receipt.receiptId),
  )
  if (
    snapshot.inFlightReservations.some(
      (reservation) => !representedInFlight.has(reservation.reservationId),
    )
  )
    throw new RangeError('DEV40 assembly cannot correlate every in-flight campaign reservation')
  if (snapshot.resumeBlocked && snapshot.inFlightReservations.length === 0)
    throw new RangeError('DEV40 assembly is blocked by an uncorrelated campaign recovery latch')
  const phaseKnownCostUsd = allPhysicalReceipts.reduce(
    (sum, receipt) => sum + (receipt.chargeState === 'known' ? (receipt.costUsd ?? 0) : 0),
    0,
  )
  const profileForReceiptId = new Map<number, H8aFreshProfileId>()
  for (const receipt of candidateCloseout.physicalReceipts)
    profileForReceiptId.set(receipt.receiptId, candidateId)
  for (const receipt of controlCloseout.physicalReceipts)
    profileForReceiptId.set(receipt.receiptId, PROFILE_CONTROL_ID)
  const phaseUnknownReserveUsd = allPhysicalReceipts.reduce((sum, receipt) => {
    if (receipt.chargeState !== 'unknown') return sum
    const profileId = profileForReceiptId.get(receipt.receiptId)
    const bound = freeze.conservativeCostProof.profileDispatchUpperBounds.find(
      (item) => item.profileId === profileId,
    )?.maxUsdPerPhysicalDispatch
    return sum + (bound ?? 0)
  }, 0)
  const inFlightReserveUsd = snapshot.inFlightReservations.reduce(
    (sum, reservation) => sum + reservation.reservedUsd,
    0,
  )
  if (
    phaseKnownCostUsd > snapshot.knownCostUsd + 1e-12 ||
    phaseUnknownReserveUsd > snapshot.unknownReserveUsd + inFlightReserveUsd + 1e-12
  )
    throw new RangeError('DEV40 receipt cost exposure exceeds persisted campaign ledger totals')
  const outputDirectory = join(input.artifactRoot, 'closeouts')
  await persistCloseout(join(outputDirectory, 'dev40-candidate-closeout.json'), candidateCloseout)
  await persistCloseout(join(outputDirectory, 'dev40-control-closeout.json'), controlCloseout)
  return { candidateCloseout, controlCloseout, packedMasksBySha256, missingPredictionRows }
}
