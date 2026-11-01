import { createHash } from 'node:crypto'
import { assertNoForbiddenEvaluatorFields } from './forbidden-leakage.js'
import type { CampaignLedgerPort } from './campaign-ledger-port.js'
import { hashIdentity } from './hash-identity.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { createPhaseDeadlineScope } from './phase-deadline.js'
import { assertFreezeAdmissionAsync, reservedUsdUpperBoundForProfile } from './freeze-admission.js'
import {
  cancelUnstartedPhysicalReservation,
  finalizeObservedPhysicalDispatch,
  invokeInjectedWork,
  PhysicalDispatchConfirmFailedError,
} from './physical-dispatch.js'
import { PROFILE_CONTROL_ID, candidateIdForPhase } from './constants.js'
import type { H8aFreshProfileId } from './profiles.js'
import type { ImmutableCloseout, OutputRow, PhaseFreeze } from './schemas.js'
import {
  immutableCloseoutSchema,
  logicalReceiptSchema,
  outputRowSchema,
  phaseFreezeSchema,
  physicalReceiptSchema,
} from './schemas.js'

export interface ProducerExecutionInput {
  opaqueCaseId: string
  sourceBytes: Uint8Array
  targetTaskText: string
}

export interface CaseExecutionPortResult {
  outputRow: OutputRow
  caseError?: string
  logicalReceipts: Array<{
    logicalId: number
    opaqueCaseId: string
    profileId: H8aFreshProfileId
    requestSha256: string
    physicalIds: number[]
    outcome: 'resolved' | 'failed' | 'cancelled' | 'timeout' | 'unknown' | 'preflight_failed'
    errorCode?: string
  }>
  physicalReceipts: Array<{
    receiptId: number
    physicalId: number | null
    logicalId: number
    dispatchState: 'confirmed' | 'uncertain' | 'prefetch_cancelled'
    settled: boolean
    costUsd: number | null
    chargeState: 'known' | 'unknown' | 'reserved_prefetch_cancelled'
  }>
  caseArtifactSidecars?: Array<{
    opaqueCaseId: string
    profileId: H8aFreshProfileId
    kind: 'candidate-cutout-rgba' | 'control-cutout-png'
    sha256: string
    byteLength: number
    width: number
    height: number
    sourceCanvasWidth: number
    sourceCanvasHeight: number
    sourceRegion: { left: number; top: number; width: number; height: number }
    sourceOffset: { x: number; y: number }
  }>
}

export interface ArmDispatchJournal {
  lastPartialResult: CaseExecutionPortResult | null
}

export interface CaseExecutionPort {
  execute(
    input: ProducerExecutionInput,
    context: {
      profileId: H8aFreshProfileId
      reservedUsdPerFetch: number
      ledger: CampaignLedgerPort
      caseExecutionIdentitySha256?: string
      dispatchJournal?: ArmDispatchJournal
      signal?: AbortSignal
    },
  ): Promise<CaseExecutionPortResult>
}

interface PairedRunnerOptions {
  freeze: PhaseFreeze
  ledger: CampaignLedgerPort
  candidatePort: CaseExecutionPort
  controlPort: CaseExecutionPort
  sourceBytesByCaseId: ReadonlyMap<string, Uint8Array>
  reservedUsdPerFetch?: number
  signal?: AbortSignal
  /** @deprecated use `now` */
  closeAtIso?: string
  now?: () => string
}

type InjectedFetchCaseHandlerResult = {
  output: Partial<OutputRow>
  costUsd?: number | null
}

type InjectedFetchCaseHandlerReturn = Partial<OutputRow> | InjectedFetchCaseHandlerResult

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function ownSourceBytes(bytes: Uint8Array): Uint8Array {
  const owned = new Uint8Array(bytes.length)
  owned.set(bytes)
  return owned
}

function validateProducerInput(
  freeze: PhaseFreeze,
  input: ProducerExecutionInput,
  sourceBytesByCaseId: ReadonlyMap<string, Uint8Array>,
): void {
  assertNoForbiddenEvaluatorFields(input, 'Producer execution input')
  const row = freeze.producerCases.find((item) => item.opaqueCaseId === input.opaqueCaseId)
  if (!row) throw new RangeError('Unknown opaque case ID')
  if (row.targetTaskText !== input.targetTaskText) throw new RangeError('Target task text mismatch')
  const bytes = sourceBytesByCaseId.get(input.opaqueCaseId)
  if (!bytes) throw new RangeError('Missing owned source bytes')
  if (sha256Bytes(bytes) !== row.sourceBytesSha256)
    throw new RangeError('Source bytes hash mismatch')
}

function profileBindingFor(freeze: PhaseFreeze, profileId: H8aFreshProfileId) {
  const binding = freeze.profileBindings.find((item) => item.profileId === profileId)
  if (!binding) throw new RangeError('Missing profile binding')
  return binding
}

function remapPortResult(
  result: CaseExecutionPortResult,
  nextLogicalId: number,
  nextPhysicalId: number,
): {
  result: CaseExecutionPortResult
  nextLogicalId: number
  nextPhysicalId: number
} {
  const logicalIdMap = new Map<number, number>()
  let logicalCursor = nextLogicalId
  for (const receipt of result.logicalReceipts) {
    logicalIdMap.set(receipt.logicalId, logicalCursor++)
  }
  const receiptIdMap = new Map<number, number>()
  let physicalCursor = nextPhysicalId
  for (const receipt of result.physicalReceipts) {
    if (!receiptIdMap.has(receipt.receiptId)) {
      receiptIdMap.set(receipt.receiptId, physicalCursor++)
    }
  }

  const logicalReceipts = result.logicalReceipts.map((receipt) => ({
    ...receipt,
    logicalId: logicalIdMap.get(receipt.logicalId)!,
    physicalIds: receipt.physicalIds.map((receiptId) => receiptIdMap.get(receiptId) ?? receiptId),
  }))
  const physicalReceipts = result.physicalReceipts.map((receipt) => ({
    ...receipt,
    logicalId: logicalIdMap.get(receipt.logicalId)!,
    receiptId: receiptIdMap.get(receipt.receiptId) ?? receipt.receiptId,
  }))
  const outputRow = {
    ...result.outputRow,
    logicalReceiptIds: result.outputRow.logicalReceiptIds.map((id) => logicalIdMap.get(id)!),
    physicalReceiptIds: result.outputRow.physicalReceiptIds.map((id) => receiptIdMap.get(id) ?? id),
  }
  return {
    result: {
      outputRow,
      logicalReceipts,
      physicalReceipts,
      ...(result.caseError ? { caseError: result.caseError } : {}),
      ...(result.caseArtifactSidecars ? { caseArtifactSidecars: result.caseArtifactSidecars } : {}),
    },
    nextLogicalId: logicalCursor,
    nextPhysicalId: physicalCursor,
  }
}

function validateRemappedGraph(result: CaseExecutionPortResult): void {
  outputRowSchema.parse(result.outputRow)
  for (const receipt of result.logicalReceipts) logicalReceiptSchema.parse(receipt)
  for (const receipt of result.physicalReceipts) physicalReceiptSchema.parse(receipt)
  const logicalById = new Map(result.logicalReceipts.map((item) => [item.logicalId, item]))
  const physicalByReceiptId = new Map(result.physicalReceipts.map((item) => [item.receiptId, item]))
  for (const logicalId of result.outputRow.logicalReceiptIds) {
    if (!logicalById.has(logicalId))
      throw new RangeError('Remapped output row missing logical receipt')
  }
  for (const receiptId of result.outputRow.physicalReceiptIds) {
    const physical = physicalByReceiptId.get(receiptId)
    if (!physical) throw new RangeError('Remapped output row missing physical receipt')
    if (!logicalById.has(physical.logicalId))
      throw new RangeError('Remapped physical receipt missing logical link')
  }
  for (const logical of result.logicalReceipts) {
    for (const receiptId of logical.physicalIds) {
      const physical = physicalByReceiptId.get(receiptId)
      if (!physical || physical.logicalId !== logical.logicalId)
        throw new RangeError('Remapped logical/physical graph mismatch')
    }
  }
}

function countConfirmedPhysicalDispatches(
  receipts: CaseExecutionPortResult['physicalReceipts'],
): number {
  return receipts.filter((item) => item.dispatchState === 'confirmed').length
}

function countUncertainPhysicalDispatches(
  receipts: CaseExecutionPortResult['physicalReceipts'],
): number {
  return receipts.filter((item) => item.dispatchState === 'uncertain').length
}

function mergeCloseout(
  freeze: PhaseFreeze,
  profileId: H8aFreshProfileId,
  rows: OutputRow[],
  logicalReceipts: CaseExecutionPortResult['logicalReceipts'],
  physicalReceipts: CaseExecutionPortResult['physicalReceipts'],
  logicalAttemptCount: number,
  physicalDispatchCount: number,
  closedAtIso: string,
): ImmutableCloseout {
  const binding = profileBindingFor(freeze, profileId)
  const body = {
    schema: 'h8a-fresh-immutable-closeout-v1' as const,
    freezeId: freeze.freezeId,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
    phaseId: freeze.phaseId,
    profileId,
    closedAtIso,
    cohortCommitmentSha256: freeze.cohortCommitmentSha256,
    producerClosureSha256: freeze.producerClosureSha256,
    recipeIdentitySha256: binding.recipeIdentitySha256,
    requestPolicyIdentitySha256: binding.requestPolicyIdentitySha256,
    outputRows: rows,
    logicalReceipts,
    physicalReceipts,
    logicalAttemptCount,
    physicalDispatchCount,
    uncertainDispatchCount: countUncertainPhysicalDispatches(physicalReceipts),
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
  return immutableCloseoutSchema.parse({ ...body, closeoutSha256 })
}

function buildSyntheticCancelledResult(
  input: ProducerExecutionInput,
  profileId: H8aFreshProfileId,
  caseState: 'cancelled' | 'unstarted',
  outcome: 'cancelled' | 'unknown',
): CaseExecutionPortResult {
  return {
    outputRow: outputRowSchema.parse({
      schema: 'h8a-fresh-output-row-v1',
      opaqueCaseId: input.opaqueCaseId,
      profileId,
      executionValidity: 'valid',
      caseState,
      box: null,
      cutoutPresent: false,
      maskPackedSha256: null,
      logicalReceiptIds: [1],
      physicalReceiptIds: [],
    }),
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: input.opaqueCaseId,
        profileId,
        requestSha256: hashIdentity({
          opaqueCaseId: input.opaqueCaseId,
          profileId,
          cancelled: true,
        }),
        physicalIds: [],
        outcome,
      },
    ],
    physicalReceipts: [],
  }
}

function buildSyntheticPreflightFailureResult(
  input: ProducerExecutionInput,
  profileId: H8aFreshProfileId,
  error: unknown,
): CaseExecutionPortResult {
  const message = error instanceof Error ? error.message : 'preflight_failed'
  const requestSha256 = hashIdentity({
    opaqueCaseId: input.opaqueCaseId,
    profileId,
    preflightFailed: true,
    error: message,
  })
  return {
    outputRow: outputRowSchema.parse({
      schema: 'h8a-fresh-output-row-v1',
      opaqueCaseId: input.opaqueCaseId,
      profileId,
      executionValidity: 'valid',
      caseState: 'preflight_failed',
      box: null,
      cutoutPresent: false,
      maskPackedSha256: null,
      logicalReceiptIds: [1],
      physicalReceiptIds: [],
    }),
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: input.opaqueCaseId,
        profileId,
        requestSha256,
        physicalIds: [],
        outcome: 'preflight_failed',
        errorCode: message,
      },
    ],
    physicalReceipts: [],
  }
}

function buildSyntheticErrorResult(
  input: ProducerExecutionInput,
  profileId: H8aFreshProfileId,
  error: unknown,
): CaseExecutionPortResult {
  const message = error instanceof Error ? error.message : 'execution_failed'
  return {
    outputRow: outputRowSchema.parse({
      schema: 'h8a-fresh-output-row-v1',
      opaqueCaseId: input.opaqueCaseId,
      profileId,
      executionValidity: 'invalid',
      caseState: 'error',
      box: null,
      cutoutPresent: false,
      maskPackedSha256: null,
      logicalReceiptIds: [1],
      physicalReceiptIds: [],
    }),
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: input.opaqueCaseId,
        profileId,
        requestSha256: hashIdentity({
          opaqueCaseId: input.opaqueCaseId,
          profileId,
          error: message,
        }),
        physicalIds: [],
        outcome: 'failed',
        errorCode: message,
      },
    ],
    physicalReceipts: [],
  }
}

function resolveReservedUsdPerFetch(
  freeze: PhaseFreeze,
  profileId: H8aFreshProfileId,
  override: number | undefined,
): number {
  const frozenBound = reservedUsdUpperBoundForProfile(freeze, profileId)
  if (override === undefined) return frozenBound
  if (!Number.isFinite(override) || override + 1e-12 < frozenBound)
    throw new RangeError('Reserved USD override cannot be below frozen profile dispatch bound')
  return override
}

function ownPhaseFreezeInputs(
  freeze: PhaseFreeze,
  sourceBytesByCaseId: ReadonlyMap<string, Uint8Array>,
): {
  freeze: PhaseFreeze
  sourceBytesByCaseId: ReadonlyMap<string, Uint8Array>
} {
  // Zod parsing synchronously validates and clones every nested object/array before
  // the runner reaches its first await. A shallow copy leaves policy and budget
  // fields vulnerable to caller mutation while freeze admission is pending.
  const ownedFreeze = phaseFreezeSchema.parse(freeze)
  const ownedSourceBytesByCaseId = new Map<string, Uint8Array>()
  for (const row of ownedFreeze.producerCases) {
    const bytes = sourceBytesByCaseId.get(row.opaqueCaseId)
    if (!bytes) continue
    const owned = ownSourceBytes(bytes)
    if (sha256Bytes(owned) !== row.sourceBytesSha256)
      throw new RangeError('Source bytes hash mismatch during freeze intake')
    ownedSourceBytesByCaseId.set(row.opaqueCaseId, owned)
  }
  return { freeze: ownedFreeze, sourceBytesByCaseId: ownedSourceBytesByCaseId }
}

export async function runPairedPhase(options: PairedRunnerOptions): Promise<{
  candidateCloseout: ImmutableCloseout
  controlCloseout: ImmutableCloseout
}> {
  const {
    ledger,
    candidatePort,
    controlPort,
    reservedUsdPerFetch,
    signal,
    closeAtIso: closeAtIsoOverride,
    now: nowOverride,
  } = options

  const { freeze, sourceBytesByCaseId } = ownPhaseFreezeInputs(
    options.freeze,
    options.sourceBytesByCaseId,
  )
  const candidateId = candidateIdForPhase(freeze.phaseId)
  const phaseDeadline = createPhaseDeadlineScope(freeze.deadlineIso, signal)
  const now =
    nowOverride ?? (closeAtIsoOverride ? () => closeAtIsoOverride : () => new Date().toISOString())

  try {
    if (freeze.producerCases.length !== freeze.pairedSchedule.length)
      throw new RangeError('Incomplete paired schedule')

    const candidateRows: OutputRow[] = []
    const controlRows: OutputRow[] = []
    const candidateLogical: CaseExecutionPortResult['logicalReceipts'] = []
    const controlLogical: CaseExecutionPortResult['logicalReceipts'] = []
    const candidatePhysical: CaseExecutionPortResult['physicalReceipts'] = []
    const controlPhysical: CaseExecutionPortResult['physicalReceipts'] = []

    let candidateLogicalAttempts = 0
    let controlLogicalAttempts = 0
    let nextLogicalId = 1
    let nextPhysicalId = 1
    let scheduleIndex = 0
    let cancelled = false
    let freezeRejected = false

    try {
      await assertFreezeAdmissionAsync(freeze, ledger)
    } catch {
      freezeRejected = true
      scheduleIndex = 0
    }

    const collectPreflightArm = async (
      executionInput: ProducerExecutionInput,
      profileId: H8aFreshProfileId,
      preflightError: unknown,
    ): Promise<void> => {
      await ledger.recordLogicalAttempt({
        profileId,
        opaqueCaseId: executionInput.opaqueCaseId,
      })
      const synthetic = buildSyntheticPreflightFailureResult(
        executionInput,
        profileId,
        preflightError,
      )
      const remapped = remapPortResult(synthetic, nextLogicalId, nextPhysicalId)
      nextLogicalId = remapped.nextLogicalId
      nextPhysicalId = remapped.nextPhysicalId
      validateRemappedGraph(remapped.result)
      if (profileId === candidateId) {
        candidateLogicalAttempts++
        candidateRows.push(remapped.result.outputRow)
        candidateLogical.push(...remapped.result.logicalReceipts)
      } else {
        controlLogicalAttempts++
        controlRows.push(remapped.result.outputRow)
        controlLogical.push(...remapped.result.logicalReceipts)
      }
    }

    const appendPreflightFailureForSchedule = async (
      fromIndex: number,
      startArmIndex: number,
      preflightError: unknown,
    ): Promise<void> => {
      for (let index = fromIndex; index < freeze.pairedSchedule.length; index++) {
        const scheduleRow = freeze.pairedSchedule[index]!
        const producerRow = freeze.producerCases.find(
          (item) => item.opaqueCaseId === scheduleRow.opaqueCaseId,
        )
        if (!producerRow) throw new RangeError('Schedule references missing producer row')
        const executionInput: ProducerExecutionInput = {
          opaqueCaseId: producerRow.opaqueCaseId,
          sourceBytes: ownSourceBytes(
            sourceBytesByCaseId.get(producerRow.opaqueCaseId) ?? new Uint8Array(),
          ),
          targetTaskText: producerRow.targetTaskText,
        }
        const armProfiles = scheduleRow.candidateArmFirst
          ? [candidateId, PROFILE_CONTROL_ID]
          : [PROFILE_CONTROL_ID, candidateId]
        const firstArm = index === fromIndex ? startArmIndex : 0
        for (let armIndex = firstArm; armIndex < armProfiles.length; armIndex++) {
          await collectPreflightArm(executionInput, armProfiles[armIndex]!, preflightError)
        }
      }
    }

    if (freezeRejected) {
      await appendPreflightFailureForSchedule(0, 0, new RangeError('freeze_admission_rejected'))
      const closedAtIso = now()
      const candidateCloseout = mergeCloseout(
        freeze,
        candidateId,
        candidateRows,
        candidateLogical,
        candidatePhysical,
        candidateLogicalAttempts,
        countConfirmedPhysicalDispatches(candidatePhysical),
        closedAtIso,
      )
      const controlCloseout = mergeCloseout(
        freeze,
        PROFILE_CONTROL_ID,
        controlRows,
        controlLogical,
        controlPhysical,
        controlLogicalAttempts,
        countConfirmedPhysicalDispatches(controlPhysical),
        closedAtIso,
      )
      return { candidateCloseout, controlCloseout }
    }

    const collectSyntheticArm = (
      executionInput: ProducerExecutionInput,
      profileId: H8aFreshProfileId,
      caseState: 'cancelled' | 'unstarted',
      outcome: 'cancelled' | 'unknown',
    ): void => {
      const synthetic = buildSyntheticCancelledResult(executionInput, profileId, caseState, outcome)
      const remapped = remapPortResult(synthetic, nextLogicalId, nextPhysicalId)
      nextLogicalId = remapped.nextLogicalId
      nextPhysicalId = remapped.nextPhysicalId
      validateRemappedGraph(remapped.result)
      if (profileId === candidateId) {
        candidateRows.push(remapped.result.outputRow)
        candidateLogical.push(...remapped.result.logicalReceipts)
      } else {
        controlRows.push(remapped.result.outputRow)
        controlLogical.push(...remapped.result.logicalReceipts)
      }
    }

    const appendSyntheticForSchedule = (
      fromIndex: number,
      startArmIndex: number,
      caseState: 'cancelled' | 'unstarted',
      outcome: 'cancelled' | 'unknown',
    ): void => {
      for (let index = fromIndex; index < freeze.pairedSchedule.length; index++) {
        const scheduleRow = freeze.pairedSchedule[index]!
        const producerRow = freeze.producerCases.find(
          (item) => item.opaqueCaseId === scheduleRow.opaqueCaseId,
        )
        if (!producerRow) throw new RangeError('Schedule references missing producer row')
        const executionInput: ProducerExecutionInput = {
          opaqueCaseId: producerRow.opaqueCaseId,
          sourceBytes: ownSourceBytes(
            sourceBytesByCaseId.get(producerRow.opaqueCaseId) ?? new Uint8Array(),
          ),
          targetTaskText: producerRow.targetTaskText,
        }
        const armProfiles = scheduleRow.candidateArmFirst
          ? [candidateId, PROFILE_CONTROL_ID]
          : [PROFILE_CONTROL_ID, candidateId]
        const firstArm = index === fromIndex ? startArmIndex : 0
        for (let armIndex = firstArm; armIndex < armProfiles.length; armIndex++) {
          collectSyntheticArm(executionInput, armProfiles[armIndex]!, caseState, outcome)
        }
      }
    }

    for (; scheduleIndex < freeze.pairedSchedule.length; scheduleIndex++) {
      if (cancelled) break
      try {
        phaseDeadline.assertOpen()
      } catch {
        cancelled = true
        appendSyntheticForSchedule(scheduleIndex, 0, 'cancelled', 'cancelled')
        break
      }

      const scheduleRow = freeze.pairedSchedule[scheduleIndex]!
      const producerRow = freeze.producerCases.find(
        (item) => item.opaqueCaseId === scheduleRow.opaqueCaseId,
      )
      if (!producerRow) throw new RangeError('Schedule references missing producer row')
      const executionInput: ProducerExecutionInput = {
        opaqueCaseId: producerRow.opaqueCaseId,
        sourceBytes: ownSourceBytes(
          sourceBytesByCaseId.get(producerRow.opaqueCaseId) ?? new Uint8Array(),
        ),
        targetTaskText: producerRow.targetTaskText,
      }
      try {
        validateProducerInput(freeze, executionInput, sourceBytesByCaseId)
      } catch (error) {
        await appendPreflightFailureForSchedule(scheduleIndex, 0, error)
        break
      }

      const arms: Array<{
        profileId: H8aFreshProfileId
        port: CaseExecutionPort
        collectRow: (row: OutputRow) => void
        collectLogical: (rows: CaseExecutionPortResult['logicalReceipts']) => void
        collectPhysical: (rows: CaseExecutionPortResult['physicalReceipts']) => void
        onLogicalAttempt: () => void
      }> = scheduleRow.candidateArmFirst
        ? [
            {
              profileId: candidateId,
              port: candidatePort,
              collectRow: (row) => candidateRows.push(row),
              collectLogical: (rows) => candidateLogical.push(...rows),
              collectPhysical: (rows) => candidatePhysical.push(...rows),
              onLogicalAttempt: () => {
                candidateLogicalAttempts++
              },
            },
            {
              profileId: PROFILE_CONTROL_ID,
              port: controlPort,
              collectRow: (row) => controlRows.push(row),
              collectLogical: (rows) => controlLogical.push(...rows),
              collectPhysical: (rows) => controlPhysical.push(...rows),
              onLogicalAttempt: () => {
                controlLogicalAttempts++
              },
            },
          ]
        : [
            {
              profileId: PROFILE_CONTROL_ID,
              port: controlPort,
              collectRow: (row) => controlRows.push(row),
              collectLogical: (rows) => controlLogical.push(...rows),
              collectPhysical: (rows) => controlPhysical.push(...rows),
              onLogicalAttempt: () => {
                controlLogicalAttempts++
              },
            },
            {
              profileId: candidateId,
              port: candidatePort,
              collectRow: (row) => candidateRows.push(row),
              collectLogical: (rows) => candidateLogical.push(...rows),
              collectPhysical: (rows) => candidatePhysical.push(...rows),
              onLogicalAttempt: () => {
                candidateLogicalAttempts++
              },
            },
          ]

      for (let armIndex = 0; armIndex < arms.length; armIndex++) {
        const arm = arms[armIndex]!
        if (cancelled) break
        try {
          phaseDeadline.assertOpen()
        } catch {
          cancelled = true
          appendSyntheticForSchedule(scheduleIndex, armIndex, 'cancelled', 'cancelled')
          break
        }

        await ledger.recordLogicalAttempt({
          profileId: arm.profileId,
          opaqueCaseId: executionInput.opaqueCaseId,
        })
        arm.onLogicalAttempt()
        const sharedInput: ProducerExecutionInput = {
          opaqueCaseId: executionInput.opaqueCaseId,
          sourceBytes: ownSourceBytes(executionInput.sourceBytes),
          targetTaskText: executionInput.targetTaskText,
        }
        const profileReservedUsd = resolveReservedUsdPerFetch(
          freeze,
          arm.profileId,
          reservedUsdPerFetch,
        )
        const dispatchJournal: ArmDispatchJournal = { lastPartialResult: null }
        const executionContext = {
          profileId: arm.profileId,
          reservedUsdPerFetch: profileReservedUsd,
          ledger,
          dispatchJournal,
          signal: phaseDeadline.signal,
        }

        let inFlight: Promise<CaseExecutionPortResult> | null = null
        try {
          phaseDeadline.assertOpen()
          inFlight = arm.port.execute(sharedInput, executionContext)
          const rawResult = await inFlight
          inFlight = null
          assertNoForbiddenEvaluatorFields(rawResult, 'Case execution result')
          if (rawResult.outputRow.profileId !== arm.profileId)
            throw new RangeError('Output row profile mismatch')
          const remapped = remapPortResult(rawResult, nextLogicalId, nextPhysicalId)
          nextLogicalId = remapped.nextLogicalId
          nextPhysicalId = remapped.nextPhysicalId
          validateRemappedGraph(remapped.result)
          arm.collectRow(remapped.result.outputRow)
          arm.collectLogical(remapped.result.logicalReceipts)
          arm.collectPhysical(remapped.result.physicalReceipts)
        } catch (error) {
          if (inFlight) {
            await inFlight.catch(() => undefined)
          }
          if (phaseDeadline.signal.aborted) {
            cancelled = true
            const partial = dispatchJournal.lastPartialResult
            if (partial) {
              const remapped = remapPortResult(partial, nextLogicalId, nextPhysicalId)
              nextLogicalId = remapped.nextLogicalId
              nextPhysicalId = remapped.nextPhysicalId
              validateRemappedGraph(remapped.result)
              arm.collectRow(remapped.result.outputRow)
              arm.collectLogical(remapped.result.logicalReceipts)
              arm.collectPhysical(remapped.result.physicalReceipts)
            } else {
              appendSyntheticForSchedule(scheduleIndex, armIndex, 'cancelled', 'cancelled')
            }
            break
          }
          const partial = dispatchJournal.lastPartialResult
          if (partial) {
            const remapped = remapPortResult(partial, nextLogicalId, nextPhysicalId)
            nextLogicalId = remapped.nextLogicalId
            nextPhysicalId = remapped.nextPhysicalId
            validateRemappedGraph(remapped.result)
            arm.collectRow(remapped.result.outputRow)
            arm.collectLogical(remapped.result.logicalReceipts)
            arm.collectPhysical(remapped.result.physicalReceipts)
          } else {
            const synthetic = buildSyntheticErrorResult(sharedInput, arm.profileId, error)
            const remapped = remapPortResult(synthetic, nextLogicalId, nextPhysicalId)
            nextLogicalId = remapped.nextLogicalId
            nextPhysicalId = remapped.nextPhysicalId
            validateRemappedGraph(remapped.result)
            arm.collectRow(remapped.result.outputRow)
            arm.collectLogical(remapped.result.logicalReceipts)
          }
          await ledger.markCrashWithPendingDispatch()
        }
      }
    }

    const closedAtIso = now()
    const candidateCloseout = mergeCloseout(
      freeze,
      candidateId,
      candidateRows,
      candidateLogical,
      candidatePhysical,
      candidateLogicalAttempts,
      countConfirmedPhysicalDispatches(candidatePhysical),
      closedAtIso,
    )
    const controlCloseout = mergeCloseout(
      freeze,
      PROFILE_CONTROL_ID,
      controlRows,
      controlLogical,
      controlPhysical,
      controlLogicalAttempts,
      countConfirmedPhysicalDispatches(controlPhysical),
      closedAtIso,
    )
    return { candidateCloseout, controlCloseout }
  } finally {
    phaseDeadline.dispose()
  }
}

function normalizeInjectedHandlerResult(value: InjectedFetchCaseHandlerReturn): {
  partial: Partial<OutputRow>
  explicitCostUsd: number | null | undefined
} {
  if (typeof value === 'object' && value !== null && 'output' in value) {
    return { partial: value.output, explicitCostUsd: value.costUsd }
  }
  return { partial: value, explicitCostUsd: undefined }
}

function buildInjectedPortFailureResult(
  input: ProducerExecutionInput,
  context: {
    profileId: H8aFreshProfileId
  },
  requestSha256: string,
  receiptId: number | null,
  observedPhysicalId: number | null,
  error: unknown,
  options?: {
    caseState?: OutputRow['caseState']
    executionValidity?: OutputRow['executionValidity']
    costUsd?: number | null
    chargeState?: CaseExecutionPortResult['physicalReceipts'][number]['chargeState']
    dispatchState?: CaseExecutionPortResult['physicalReceipts'][number]['dispatchState']
    outcome?: CaseExecutionPortResult['logicalReceipts'][number]['outcome']
  },
): CaseExecutionPortResult {
  const message = error instanceof Error ? error.message : 'failed'
  const costUsd = options?.costUsd ?? null
  const chargeState = options?.chargeState ?? (costUsd === null ? 'unknown' : 'known')
  const caseState = options?.caseState ?? 'error'
  const executionValidity = options?.executionValidity ?? 'valid'
  const outcome = options?.outcome ?? 'failed'
  return {
    outputRow: outputRowSchema.parse({
      schema: 'h8a-fresh-output-row-v1',
      opaqueCaseId: input.opaqueCaseId,
      profileId: context.profileId,
      executionValidity,
      caseState,
      box: null,
      cutoutPresent: false,
      maskPackedSha256: null,
      logicalReceiptIds: [1],
      physicalReceiptIds: receiptId === null ? [] : [receiptId],
    }),
    logicalReceipts: [
      {
        logicalId: 1,
        opaqueCaseId: input.opaqueCaseId,
        profileId: context.profileId,
        requestSha256,
        physicalIds: receiptId === null ? [] : [receiptId],
        outcome,
        errorCode: message,
      },
    ],
    physicalReceipts:
      receiptId === null
        ? []
        : [
            {
              receiptId,
              physicalId: observedPhysicalId,
              logicalId: 1,
              dispatchState:
                options?.dispatchState ??
                (observedPhysicalId === null ? ('uncertain' as const) : ('confirmed' as const)),
              settled: true,
              costUsd,
              chargeState,
            },
          ],
  }
}

export async function runInjectedFetchCasePort(
  handler: (
    input: ProducerExecutionInput,
    signal?: AbortSignal,
  ) => Promise<InjectedFetchCaseHandlerReturn>,
): Promise<CaseExecutionPort> {
  return {
    async execute(input, context) {
      assertNoForbiddenEvaluatorFields(input, 'Injected port input')
      const requestSha256 = hashIdentity({
        opaqueCaseId: input.opaqueCaseId,
        targetTaskText: input.targetTaskText,
        sourceSha256: createHash('sha256').update(input.sourceBytes).digest('hex'),
        profileId: context.profileId,
      })
      if (input.sourceBytes.length === 0) {
        return buildSyntheticPreflightFailureResult(
          input,
          context.profileId,
          new RangeError('Missing source bytes'),
        )
      }

      const reservationId = await context.ledger.admitPhysical(context.reservedUsdPerFetch, {
        profileId: context.profileId,
        opaqueCaseId: input.opaqueCaseId,
      })
      try {
        await context.ledger.recordDispatchIntent(reservationId)
      } catch (intentError) {
        await cancelUnstartedPhysicalReservation(context.ledger, reservationId).catch(
          () => undefined,
        )
        const result = buildInjectedPortFailureResult(
          input,
          context,
          requestSha256,
          null,
          null,
          intentError,
        )
        if (context.dispatchJournal) context.dispatchJournal.lastPartialResult = result
        return result
      }

      const workOutcomePromise = invokeInjectedWork(() => handler(input, context.signal))
      const dispatchOutcome = await finalizeObservedPhysicalDispatch(
        context.ledger,
        reservationId,
        workOutcomePromise,
        (raw) => {
          const { explicitCostUsd } = normalizeInjectedHandlerResult(raw)
          return explicitCostUsd === undefined ? null : explicitCostUsd
        },
      )

      if (dispatchOutcome.kind === 'confirm_failed_recovery_barrier') {
        const result = buildInjectedPortFailureResult(
          input,
          context,
          requestSha256,
          reservationId,
          null,
          new PhysicalDispatchConfirmFailedError(
            dispatchOutcome.confirmCause,
            dispatchOutcome.disposition,
          ),
          { outcome: 'unknown', dispatchState: 'uncertain' },
        )
        if (context.dispatchJournal) context.dispatchJournal.lastPartialResult = result
        return result
      }

      if (dispatchOutcome.kind === 'fetch_failed_settled_unknown') {
        const result = buildInjectedPortFailureResult(
          input,
          context,
          requestSha256,
          reservationId,
          dispatchOutcome.physicalId,
          dispatchOutcome.error,
          { costUsd: null, chargeState: 'unknown', outcome: 'failed', dispatchState: 'confirmed' },
        )
        if (context.dispatchJournal) context.dispatchJournal.lastPartialResult = result
        return result
      }

      const physicalId = dispatchOutcome.physicalId
      const settlementCost = dispatchOutcome.costUsd
      const raw = dispatchOutcome.value
      const { partial } = normalizeInjectedHandlerResult(raw)
      const costUsd = settlementCost
      const chargeState = costUsd === null ? ('unknown' as const) : ('known' as const)
      try {
        const outputRow = outputRowSchema.parse({
          schema: 'h8a-fresh-output-row-v1',
          opaqueCaseId: input.opaqueCaseId,
          profileId: context.profileId,
          executionValidity: 'valid',
          caseState: partial.caseState ?? 'success',
          box: partial.box ?? null,
          cutoutPresent: partial.cutoutPresent ?? false,
          maskPackedSha256: partial.maskPackedSha256 ?? null,
          logicalReceiptIds: [1],
          physicalReceiptIds: [reservationId],
        })
        const result: CaseExecutionPortResult = {
          outputRow,
          logicalReceipts: [
            {
              logicalId: 1,
              opaqueCaseId: input.opaqueCaseId,
              profileId: context.profileId,
              requestSha256,
              physicalIds: [reservationId],
              outcome: 'resolved',
            },
          ],
          physicalReceipts: [
            {
              receiptId: reservationId,
              physicalId,
              logicalId: 1,
              dispatchState: 'confirmed',
              settled: true,
              costUsd,
              chargeState,
            },
          ],
        }
        if (context.dispatchJournal) context.dispatchJournal.lastPartialResult = result
        return result
      } catch (parseError) {
        const result = buildInjectedPortFailureResult(
          input,
          context,
          requestSha256,
          reservationId,
          physicalId,
          parseError,
          {
            caseState: 'malformed',
            executionValidity: 'invalid',
            costUsd,
            chargeState,
            outcome: 'failed',
            dispatchState: 'confirmed',
          },
        )
        if (context.dispatchJournal) context.dispatchJournal.lastPartialResult = result
        return result
      }
    },
  }
}
