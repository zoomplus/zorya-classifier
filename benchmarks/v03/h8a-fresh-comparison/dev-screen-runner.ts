import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import type { CaseArtifactIdentity, StoredCaseArtifact } from './case-artifact-store.js'
import type { CampaignLedger } from './campaign-ledger.js'
import {
  DEV_SCREEN_SEED,
  persistDevScreenSelection,
  validateDevScreenSelection,
} from './dev-screen-sampling.js'
import type { DevScreenId, DevScreenSelection } from './dev-screen-sampling.js'
import { scoreNegativeFalseOutputRow, scorePositiveOutputRow } from './evaluator.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import { hashIdentity } from './hash-identity.js'
import type { H8aFreshProfileId } from './profiles.js'
import type {
  ArmDispatchJournal,
  CaseExecutionPort,
  CaseExecutionPortResult,
  ProducerExecutionInput,
} from './paired-runner.js'
import {
  PROFILE_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  DEV40_CASE_COUNT,
  DEV40_POSITIVE_COUNT,
} from './constants.js'
import type { EvaluatorPrivateAnnotationBundle, PhaseFreeze } from './schemas.js'
import { evaluatorPrivateAnnotationBundleSchema, phaseFreezeSchema } from './schemas.js'
import type { FreshRuntimeArtifacts } from './runtime-ports.js'
import { assertFreezeAdmissionAsync } from './freeze-admission.js'
import { createPhaseDeadlineScope } from './phase-deadline.js'
import type { PhaseDeadlineScope } from './phase-deadline.js'

const reviewBodySchema = z
  .object({
    schema: z.literal('h8a-dev-screen-review-v1'),
    screenReportSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewProtocol: z.literal('no-apparent-collapse-main-review-v1'),
    reviewerId: z.literal('main-orchestrator'),
    judgement: z.enum(['advance', 'stop']),
    reason: z.string().min(1).max(1000),
  })
  .strict()

const screenReportBodySchema = z
  .object({
    schema: z.literal('h8a-dev-screen-report-v1'),
    screen: z.enum(['dev8', 'dev12', 'dev40']),
    freezeCommitmentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    selectionCommitmentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    seed: z.literal(DEV_SCREEN_SEED),
    completedPairs: z.number().int().nonnegative(),
    expectedPairs: z.number().int().positive(),
    hardBlockers: z.array(z.string()),
    qualitativeReviewProtocol: z.literal('no-apparent-collapse-main-review-v1'),
    qualitativeReviewOwner: z.literal('main-orchestrator'),
    perCell: z
      .array(
        z
          .object({
            stratum: z.enum(['photo', 'ui', 'map']),
            expectedPresence: z.enum(['present', 'absent']),
            quota: z.number().int().positive(),
            inclusionProbability: z.number().finite().positive().max(1),
            candidatePositiveSuccesses: z.number().int().nonnegative(),
            controlPositiveSuccesses: z.number().int().nonnegative(),
            candidateNegativeFalse: z.number().int().nonnegative(),
            controlNegativeFalse: z.number().int().nonnegative(),
            weightedCandidatePositiveSuccessTotal: z.number().finite().nonnegative(),
            weightedControlPositiveSuccessTotal: z.number().finite().nonnegative(),
            weightedCandidatePositiveFailureTotal: z.number().finite().nonnegative(),
            weightedControlPositiveFailureTotal: z.number().finite().nonnegative(),
            weightedCandidateNegativeFalseTotal: z.number().finite().nonnegative(),
            weightedControlNegativeFalseTotal: z.number().finite().nonnegative(),
            observedPositivePairs: z.number().int().nonnegative(),
            observedNegativePairs: z.number().int().nonnegative(),
            observedCandidatePositiveRows: z.number().int().nonnegative(),
            observedControlPositiveRows: z.number().int().nonnegative(),
            observedCandidateNegativeRows: z.number().int().nonnegative(),
            observedControlNegativeRows: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .length(6),
    rawCandidatePositiveSuccesses: z.number().int().nonnegative(),
    rawControlPositiveSuccesses: z.number().int().nonnegative(),
    candidatePositiveDenominator: z.number().int().nonnegative(),
    controlPositiveDenominator: z.number().int().nonnegative(),
    weightedCandidatePositiveRate: z.number().finite().min(0).max(1).nullable(),
    weightedControlPositiveRate: z.number().finite().min(0).max(1).nullable(),
    weightedPairedPositiveDifference: z.number().finite().min(-1).max(1).nullable(),
    weightedEstimateComplete: z.boolean(),
    candidateNegativeFalseOutputs: z.number().int().nonnegative(),
    rawDurationMs: z.array(z.number().finite().nonnegative()),
    nearestRankP50Ms: z.number().finite().nonnegative().nullable(),
    nearestRankP95Ms: z.number().finite().nonnegative().nullable(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownReservedUsd: z.number().finite().nonnegative(),
    successfulPositiveKnownCostUsd: z.number().finite().nonnegative().nullable(),
    candidate: z
      .object({
        knownCostUsd: z.number().finite().nonnegative(),
        unknownReservedUsd: z.number().finite().nonnegative(),
        confirmedPhysicalCalls: z.number().int().nonnegative(),
        logicalAttempts: z.number().int().nonnegative(),
        unknownDurationCount: z.number().int().nonnegative(),
        durationsMs: z.array(z.number().finite().nonnegative()),
        p50Ms: z.number().finite().nonnegative().nullable(),
        p95Ms: z.number().finite().nonnegative().nullable(),
        successfulPositiveKnownCostUsd: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    control: z
      .object({
        knownCostUsd: z.number().finite().nonnegative(),
        unknownReservedUsd: z.number().finite().nonnegative(),
        confirmedPhysicalCalls: z.number().int().nonnegative(),
        logicalAttempts: z.number().int().nonnegative(),
        unknownDurationCount: z.number().int().nonnegative(),
        durationsMs: z.array(z.number().finite().nonnegative()),
        p50Ms: z.number().finite().nonnegative().nullable(),
        p95Ms: z.number().finite().nonnegative().nullable(),
        successfulPositiveKnownCostUsd: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    outputs: z.array(
      z
        .object({
          opaqueCaseId: z.string().min(1),
          stratum: z.enum(['photo', 'ui', 'map']),
          expectedPresence: z.enum(['present', 'absent']),
          candidateCaseState: z.string(),
          controlCaseState: z.string(),
          candidatePositiveSuccess: z.boolean(),
          controlPositiveSuccess: z.boolean(),
          candidateNegativeFalse: z.boolean(),
          controlNegativeFalse: z.boolean(),
          candidateIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
          controlIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
    ),
  })
  .strict()

export const devScreenReportSchema = screenReportBodySchema
  .extend({ reportSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict()
type DevScreenReport = z.infer<typeof devScreenReportSchema>
type DevScreenReview = z.infer<typeof reviewBodySchema>

interface DevScreenRunnerOptions {
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  sourceBytesByCaseId: ReadonlyMap<string, Uint8Array>
  selection: DevScreenSelection
  screen: DevScreenId
  selectionPath: string
  artifactRoot: string
  ledger: CampaignLedger
  candidatePort: CaseExecutionPort
  controlPort: CaseExecutionPort
  runtimeArtifacts: FreshRuntimeArtifacts
  signal?: AbortSignal
  now?: () => string
  clockNow?: () => number
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'EXECUTION_FAILED'
  const code = Reflect.get(error, 'code')
  if (typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(code)) return code
  return /^[A-Za-z][A-Za-z0-9_]{0,59}$/u.test(error.name)
    ? error.name.toUpperCase()
    : 'EXECUTION_FAILED'
}

function percentileNearestRank(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

export function buildCaseArtifactIdentity(
  freeze: PhaseFreeze,
  selection: DevScreenSelection,
  producer: PhaseFreeze['producerCases'][number],
  profileId: H8aFreshProfileId,
): CaseArtifactIdentity {
  const binding = freeze.profileBindings.find((item) => item.profileId === profileId)
  if (!binding) throw new RangeError('Screen profile binding missing from freeze')
  return {
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
    sourceManifestSha256: freeze.sourceBytesManifestSha256,
    recipeIdentitySha256: binding.recipeIdentitySha256,
    requestPolicyIdentitySha256: binding.requestPolicyIdentitySha256,
    pairedScheduleSha256: hashIdentity(freeze.pairedSchedule),
    selectionCommitmentSha256: selection.selectionCommitmentSha256,
    opaqueCaseId: producer.opaqueCaseId,
    profileId,
    sourceBytesSha256: producer.sourceBytesSha256,
    targetTaskSha256: hashIdentity(producer.targetTaskText),
    sourceCanvasWidth: producer.sourceCanvasWidth,
    sourceCanvasHeight: producer.sourceCanvasHeight,
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

function errorResult(
  input: ProducerExecutionInput,
  profileId: H8aFreshProfileId,
  error: unknown,
): CaseExecutionPortResult {
  const code = safeFailureCode(error)
  const logicalId = 1
  return {
    outputRow: {
      schema: 'h8a-fresh-output-row-v1',
      opaqueCaseId: input.opaqueCaseId,
      profileId,
      executionValidity: 'invalid',
      caseState: 'error',
      box: null,
      cutoutPresent: false,
      maskPackedSha256: null,
      logicalReceiptIds: [logicalId],
      physicalReceiptIds: [],
    },
    logicalReceipts: [
      {
        logicalId,
        opaqueCaseId: input.opaqueCaseId,
        profileId,
        requestSha256: hashIdentity({ input: input.opaqueCaseId, profileId, errorCode: code }),
        physicalIds: [],
        outcome: 'failed',
        errorCode: code,
      },
    ],
    physicalReceipts: [],
    caseError: code,
  }
}

async function runArm(input: {
  freeze: PhaseFreeze
  selection: DevScreenSelection
  producer: PhaseFreeze['producerCases'][number]
  bytes: Uint8Array
  profileId: H8aFreshProfileId
  port: CaseExecutionPort
  ledger: CampaignLedger
  store: ImmutableCaseArtifactStore
  artifacts: FreshRuntimeArtifacts
  phaseDeadline: PhaseDeadlineScope
  now: () => string
  clockNow: () => number
}): Promise<StoredCaseArtifact> {
  const identity = buildCaseArtifactIdentity(
    input.freeze,
    input.selection,
    input.producer,
    input.profileId,
  )
  const cached = await input.store.loadOrRecover(identity)
  if (cached) return cached
  input.phaseDeadline.assertOpen()
  await assertFreezeAdmissionAsync(input.freeze, input.ledger)
  input.phaseDeadline.assertOpen()
  const startedAtIso = input.now()
  const started = input.clockNow()
  const opened = await input.store.begin(identity, startedAtIso)
  if (opened.existing) return opened.existing
  await input.ledger.recordLogicalAttempt()
  const dispatchJournal: ArmDispatchJournal = { lastPartialResult: null }
  let result: CaseExecutionPortResult
  try {
    const executionInput: ProducerExecutionInput = {
      opaqueCaseId: input.producer.opaqueCaseId,
      sourceBytes: new Uint8Array(input.bytes),
      targetTaskText: input.producer.targetTaskText,
    }
    const context = {
      profileId: input.profileId,
      reservedUsdPerFetch: input.freeze.conservativeCostProof.profileDispatchUpperBounds.find(
        (item) => item.profileId === input.profileId,
      )!.maxUsdPerPhysicalDispatch,
      ledger: input.ledger,
      caseExecutionIdentitySha256: opened.identitySha256,
      dispatchJournal,
      signal: input.phaseDeadline.signal,
    }
    input.phaseDeadline.assertOpen()
    result = await input.port.execute(executionInput, context)
  } catch (error) {
    if (dispatchJournal.lastPartialResult) result = dispatchJournal.lastPartialResult
    else
      result = errorResult(
        {
          opaqueCaseId: input.producer.opaqueCaseId,
          sourceBytes: input.bytes,
          targetTaskText: input.producer.targetTaskText,
        },
        input.profileId,
        error,
      )
  }
  const elapsed = Math.max(0, input.clockNow() - started)
  const completedAtIso = input.now()
  const knownCostUsd = result.physicalReceipts.reduce(
    (sum, item) => sum + (item.chargeState === 'known' ? (item.costUsd ?? 0) : 0),
    0,
  )
  const unknownDispatchCount = result.physicalReceipts.filter(
    (item) => item.chargeState === 'unknown',
  ).length
  const stored = await input.store.complete({
    identitySha256: opened.identitySha256,
    identity: opened.identity,
    result,
    durationMs: elapsed,
    startedAtIso,
    completedAtIso,
    knownCostUsd,
    unknownDispatchCount,
    blobs: artifactsForResult(result, input.artifacts),
  })
  return stored
}

function blockReason(result: CaseExecutionPortResult): string | null {
  const row = result.outputRow
  if (row.executionValidity !== 'valid')
    return `invalid-output:${row.opaqueCaseId}:${row.profileId}`
  if (
    ['error', 'timeout', 'cancelled', 'preflight_failed', 'malformed', 'unstarted'].includes(
      row.caseState,
    )
  )
    return `technical-state:${row.opaqueCaseId}:${row.profileId}:${row.caseState}`
  if (
    result.physicalReceipts.some(
      (receipt) => receipt.dispatchState === 'uncertain' || !receipt.settled,
    )
  )
    return `unresolved-physical-receipt:${row.opaqueCaseId}:${row.profileId}`
  return null
}

async function assertPriorScreenAdvance(
  artifactRoot: string,
  priorScreen: 'dev8' | 'dev12',
  freeze: PhaseFreeze,
  selection: DevScreenSelection,
  expectedPairs: number,
  annotations: EvaluatorPrivateAnnotationBundle,
): Promise<void> {
  const report = devScreenReportSchema.parse(
    JSON.parse(
      await readFile(`${artifactRoot}/reports/${priorScreen}-report.json`, 'utf8'),
    ) as unknown,
  )
  const { reportSha256, ...reportBody } = report
  if (hashIdentity(reportBody) !== reportSha256 || report.screen !== priorScreen)
    throw new RangeError(`${priorScreen} report integrity or phase mismatch`)
  if (
    report.freezeCommitmentSha256 !== computePhaseFreezeCommitmentSha256(freeze) ||
    report.selectionCommitmentSha256 !== selection.selectionCommitmentSha256
  )
    throw new RangeError(`${priorScreen} report is bound to a different freeze or selection`)
  const ids = priorScreen === 'dev8' ? selection.dev8CaseIds : selection.dev12CaseIds
  if (
    report.completedPairs !== expectedPairs ||
    report.expectedPairs !== expectedPairs ||
    report.outputs.length !== expectedPairs ||
    report.hardBlockers.length ||
    report.candidateNegativeFalseOutputs !== 0
  )
    throw new RangeError(`${priorScreen} report is incomplete or contains a hard blocker`)
  const store = new ImmutableCaseArtifactStore(artifactRoot)
  const producerById = new Map(freeze.producerCases.map((row) => [row.opaqueCaseId, row]))
  const truthById = new Map(annotations.cases.map((row) => [row.opaqueCaseId, row]))
  const expectedOutputs = new Map<
    string,
    {
      row: DevScreenReport['outputs'][number]
      candidate: StoredCaseArtifact
      control: StoredCaseArtifact
      positiveCandidate: boolean
      positiveControl: boolean
      negativeCandidate: boolean
      negativeControl: boolean
    }
  >()
  for (const id of ids) {
    const producer = producerById.get(id)
    const truth = truthById.get(id)
    if (!producer || !truth)
      throw new RangeError(`${priorScreen} selection references a missing private row`)
    const candidateIdentity = buildCaseArtifactIdentity(
      freeze,
      selection,
      producer,
      PROFILE_CANDIDATE_ID,
    )
    const controlIdentity = buildCaseArtifactIdentity(
      freeze,
      selection,
      producer,
      PROFILE_CONTROL_ID,
    )
    const candidate = await store.load(hashIdentity(candidateIdentity), candidateIdentity)
    const control = await store.load(hashIdentity(controlIdentity), controlIdentity)
    if (!candidate || !control)
      throw new RangeError(`${priorScreen} report has an incomplete artifact pair`)
    if (blockReason(candidate.result) || blockReason(control.result))
      throw new RangeError(
        `${priorScreen} contains an invalid or technically blocked immutable result`,
      )
    const candidateSuccess =
      truth.expectedPresence === 'present' &&
      scorePositiveOutputRow(
        candidate.result.outputRow,
        truth.referenceBoxes,
        truth,
        producer.sourceCanvasWidth,
        producer.sourceCanvasHeight,
        candidate.blobsBySha256,
      )
    const controlSuccess =
      truth.expectedPresence === 'present' &&
      scorePositiveOutputRow(
        control.result.outputRow,
        truth.referenceBoxes,
        truth,
        producer.sourceCanvasWidth,
        producer.sourceCanvasHeight,
        control.blobsBySha256,
      )
    const candidateFalse =
      truth.expectedPresence === 'absent' && scoreNegativeFalseOutputRow(candidate.result.outputRow)
    const controlFalse =
      truth.expectedPresence === 'absent' && scoreNegativeFalseOutputRow(control.result.outputRow)
    const matching = report.outputs.find((row) => row.opaqueCaseId === id)
    if (
      !matching ||
      matching.candidateIdentitySha256 !== candidate.identitySha256 ||
      matching.controlIdentitySha256 !== control.identitySha256 ||
      matching.candidateCaseState !== candidate.result.outputRow.caseState ||
      matching.controlCaseState !== control.result.outputRow.caseState ||
      matching.candidatePositiveSuccess !== candidateSuccess ||
      matching.controlPositiveSuccess !== controlSuccess ||
      matching.candidateNegativeFalse !== candidateFalse ||
      matching.controlNegativeFalse !== controlFalse
    )
      throw new RangeError(`${priorScreen} report outcome does not match immutable case artifacts`)
    expectedOutputs.set(id, {
      row: matching,
      candidate,
      control,
      positiveCandidate: candidateSuccess,
      positiveControl: controlSuccess,
      negativeCandidate: candidateFalse,
      negativeControl: controlFalse,
    })
  }
  if (
    new Set(report.outputs.map((row) => row.opaqueCaseId)).size !== expectedPairs ||
    report.outputs.some((row) => !expectedOutputs.has(row.opaqueCaseId))
  )
    throw new RangeError(`${priorScreen} report has duplicate or foreign rows`)
  const expectedCells = selection.cells.map((cell) => {
    const idsForCell = priorScreen === 'dev8' ? cell.dev8CaseIds : cell.dev12CaseIds
    const observed = idsForCell.map((id) => expectedOutputs.get(id)!).filter(Boolean)
    const positives = observed.filter(
      (item) => truthById.get(item.row.opaqueCaseId)!.expectedPresence === 'present',
    )
    const negatives = observed.filter(
      (item) => truthById.get(item.row.opaqueCaseId)!.expectedPresence === 'absent',
    )
    const candidatePositiveSuccesses = positives.filter((item) => item.positiveCandidate).length
    const controlPositiveSuccesses = positives.filter((item) => item.positiveControl).length
    const candidateNegativeFalse = negatives.filter((item) => item.negativeCandidate).length
    const controlNegativeFalse = negatives.filter((item) => item.negativeControl).length
    const quota = priorScreen === 'dev8' ? cell.dev8Quota : cell.dev12Quota
    const probability =
      priorScreen === 'dev8' ? cell.dev8InclusionProbability : cell.dev12InclusionProbability
    return {
      stratum: cell.stratum,
      expectedPresence: cell.expectedPresence,
      quota,
      inclusionProbability: probability,
      candidatePositiveSuccesses,
      controlPositiveSuccesses,
      candidateNegativeFalse,
      controlNegativeFalse,
      weightedCandidatePositiveSuccessTotal:
        cell.expectedPresence === 'present' ? candidatePositiveSuccesses / probability : 0,
      weightedControlPositiveSuccessTotal:
        cell.expectedPresence === 'present' ? controlPositiveSuccesses / probability : 0,
      weightedCandidatePositiveFailureTotal:
        cell.expectedPresence === 'present'
          ? (positives.length - candidatePositiveSuccesses) / probability
          : 0,
      weightedControlPositiveFailureTotal:
        cell.expectedPresence === 'present'
          ? (positives.length - controlPositiveSuccesses) / probability
          : 0,
      weightedCandidateNegativeFalseTotal:
        cell.expectedPresence === 'absent' ? candidateNegativeFalse / probability : 0,
      weightedControlNegativeFalseTotal:
        cell.expectedPresence === 'absent' ? controlNegativeFalse / probability : 0,
      observedPositivePairs: positives.length,
      observedNegativePairs: negatives.length,
      observedCandidatePositiveRows: positives.length,
      observedControlPositiveRows: positives.length,
      observedCandidateNegativeRows: negatives.length,
      observedControlNegativeRows: negatives.length,
    }
  })
  if (hashIdentity(expectedCells) !== hashIdentity(report.perCell))
    throw new RangeError(`${priorScreen} weighted cell report does not match immutable outputs`)
  const candidatePositiveSuccesses = [...expectedOutputs.values()].filter(
    (item) => item.positiveCandidate,
  ).length
  const controlPositiveSuccesses = [...expectedOutputs.values()].filter(
    (item) => item.positiveControl,
  ).length
  const candidateFalseOutputs = [...expectedOutputs.values()].filter(
    (item) => item.negativeCandidate,
  ).length
  if (
    candidatePositiveSuccesses !== report.rawCandidatePositiveSuccesses ||
    controlPositiveSuccesses !== report.rawControlPositiveSuccesses ||
    candidateFalseOutputs !== report.candidateNegativeFalseOutputs ||
    candidateFalseOutputs !== 0
  )
    throw new RangeError(`${priorScreen} raw report totals do not match immutable outputs`)
  const positivePopulation = selection.cells
    .filter((cell) => cell.expectedPresence === 'present')
    .reduce((sum, cell) => sum + cell.populationCount, 0)
  const weightedCandidate = expectedCells.reduce(
    (sum, cell) => sum + cell.weightedCandidatePositiveSuccessTotal,
    0,
  )
  const weightedControl = expectedCells.reduce(
    (sum, cell) => sum + cell.weightedControlPositiveSuccessTotal,
    0,
  )
  if (
    report.weightedCandidatePositiveRate !== weightedCandidate / positivePopulation ||
    report.weightedControlPositiveRate !== weightedControl / positivePopulation ||
    report.weightedPairedPositiveDifference !==
      (weightedCandidate - weightedControl) / positivePopulation ||
    !report.weightedEstimateComplete
  )
    throw new RangeError(`${priorScreen} weighted report totals do not match frozen cell weights`)
  const armStats = (
    profileId: H8aFreshProfileId,
    successField: 'positiveCandidate' | 'positiveControl',
  ) => {
    const rows = ids.map(
      (id) =>
        expectedOutputs.get(id)![profileId === PROFILE_CANDIDATE_ID ? 'candidate' : 'control'],
    )
    const bound = freeze.conservativeCostProof.profileDispatchUpperBounds.find(
      (item) => item.profileId === profileId,
    )!.maxUsdPerPhysicalDispatch
    const knownCostUsd = rows.reduce((sum, item) => sum + item.knownCostUsd, 0)
    const unknownReservedUsd = rows.reduce(
      (sum, item) => sum + item.unknownDispatchCount * bound,
      0,
    )
    const durationsMs = rows.flatMap((item) => (item.durationMs === null ? [] : [item.durationMs]))
    const successes = [...expectedOutputs.values()].filter(
      (item) =>
        truthById.get(item.row.opaqueCaseId)!.expectedPresence === 'present' && item[successField],
    ).length
    return {
      knownCostUsd,
      unknownReservedUsd,
      confirmedPhysicalCalls: rows.reduce(
        (sum, item) =>
          sum +
          item.result.physicalReceipts.filter((receipt) => receipt.dispatchState === 'confirmed')
            .length,
        0,
      ),
      logicalAttempts: rows.reduce((sum, item) => sum + item.result.logicalReceipts.length, 0),
      unknownDurationCount: rows.filter((item) => item.durationMs === null).length,
      durationsMs,
      p50Ms: percentileNearestRank(durationsMs, 0.5),
      p95Ms: percentileNearestRank(durationsMs, 0.95),
      successfulPositiveKnownCostUsd: successes > 0 ? knownCostUsd / successes : null,
    }
  }
  const expectedCandidate = armStats(PROFILE_CANDIDATE_ID, 'positiveCandidate')
  const expectedControl = armStats(PROFILE_CONTROL_ID, 'positiveControl')
  if (
    hashIdentity(expectedCandidate) !== hashIdentity(report.candidate) ||
    hashIdentity(expectedControl) !== hashIdentity(report.control)
  )
    throw new RangeError(`${priorScreen} arm metrics do not match immutable case records`)
  const expectedDuration = [...expectedCandidate.durationsMs, ...expectedControl.durationsMs]
  if (
    hashIdentity(expectedDuration) !== hashIdentity(report.rawDurationMs) ||
    expectedCandidate.knownCostUsd + expectedControl.knownCostUsd !== report.knownCostUsd ||
    expectedCandidate.unknownReservedUsd + expectedControl.unknownReservedUsd !==
      report.unknownReservedUsd
  )
    throw new RangeError(
      `${priorScreen} total cost or latency does not match immutable case records`,
    )
  const review = validateDevScreenReview(
    JSON.parse(
      await readFile(`${artifactRoot}/reviews/${priorScreen}-review.json`, 'utf8'),
    ) as unknown,
  )
  if (review.judgement !== 'advance' || review.screenReportSha256 !== reportSha256)
    throw new RangeError(`${priorScreen} review does not authorize this continuation`)
}

export async function executeDevScreen(options: DevScreenRunnerOptions): Promise<DevScreenReport> {
  // Own and validate all nested freeze/truth/source inputs before the first await.
  const freeze = phaseFreezeSchema.parse(options.freeze)
  const phaseDeadline = createPhaseDeadlineScope(freeze.deadlineIso, options.signal)
  try {
    return await executeDevScreenWithinDeadline(options, freeze, phaseDeadline)
  } finally {
    phaseDeadline.dispose()
  }
}

async function executeDevScreenWithinDeadline(
  options: DevScreenRunnerOptions,
  freeze: PhaseFreeze,
  phaseDeadline: PhaseDeadlineScope,
): Promise<DevScreenReport> {
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(options.annotations)
  const ownedSources = new Map<string, Uint8Array>()
  for (const producer of freeze.producerCases) {
    const bytes = options.sourceBytesByCaseId.get(producer.opaqueCaseId)
    if (!bytes || digestBytes(bytes) !== producer.sourceBytesSha256)
      throw new RangeError('Screen source bytes differ from frozen manifest')
    ownedSources.set(producer.opaqueCaseId, new Uint8Array(bytes))
  }
  const selection = validateDevScreenSelection(options.selection, freeze, annotations)
  const now = options.now ?? (() => new Date().toISOString())
  const clockNow = options.clockNow ?? (() => performance.now())
  const selectedIds = new Set(
    options.screen === 'dev8'
      ? selection.dev8CaseIds
      : options.screen === 'dev12'
        ? selection.dev12CaseIds
        : freeze.producerCases.map((row) => row.opaqueCaseId),
  )
  const producerById = new Map(freeze.producerCases.map((row) => [row.opaqueCaseId, row]))
  const truthById = new Map(annotations.cases.map((row) => [row.opaqueCaseId, row]))
  const store = new ImmutableCaseArtifactStore(options.artifactRoot)
  await persistDevScreenSelection(options.selectionPath, selection)

  if (options.screen === 'dev12')
    await assertPriorScreenAdvance(options.artifactRoot, 'dev8', freeze, selection, 8, annotations)
  if (options.screen === 'dev40')
    await assertPriorScreenAdvance(
      options.artifactRoot,
      'dev12',
      freeze,
      selection,
      12,
      annotations,
    )

  const storedByCase = new Map<
    string,
    { candidate: StoredCaseArtifact; control: StoredCaseArtifact }
  >()
  const storedArmsByCase = new Map<string, Partial<Record<H8aFreshProfileId, StoredCaseArtifact>>>()
  const hardBlockers: string[] = []
  const candidateDurations: number[] = []
  const controlDurations: number[] = []
  let candidateUnknownDurationCount = 0
  let controlUnknownDurationCount = 0
  let candidateKnownCostUsd = 0
  let controlKnownCostUsd = 0
  let candidateUnknownReservedUsd = 0
  let controlUnknownReservedUsd = 0
  let candidatePhysicalCalls = 0
  let controlPhysicalCalls = 0
  let candidateLogicalAttempts = 0
  let controlLogicalAttempts = 0
  let completedPairs = 0
  const selectedInOrder = freeze.pairedSchedule.filter((row) => selectedIds.has(row.opaqueCaseId))
  for (const schedule of selectedInOrder) {
    const producer = producerById.get(schedule.opaqueCaseId)
    const truth = truthById.get(schedule.opaqueCaseId)
    const sourceBytes = ownedSources.get(schedule.opaqueCaseId)
    if (!producer || !truth || !sourceBytes)
      throw new RangeError('Selected screen case is incomplete')
    const armOrder: H8aFreshProfileId[] = schedule.candidateArmFirst
      ? [PROFILE_CANDIDATE_ID, PROFILE_CONTROL_ID]
      : [PROFILE_CONTROL_ID, PROFILE_CANDIDATE_ID]
    const byProfile = new Map<H8aFreshProfileId, StoredCaseArtifact>()
    for (const profileId of armOrder) {
      try {
        phaseDeadline.assertOpen()
        const stored = await runArm({
          freeze,
          selection,
          producer,
          bytes: sourceBytes,
          profileId,
          port: profileId === PROFILE_CANDIDATE_ID ? options.candidatePort : options.controlPort,
          ledger: options.ledger,
          store,
          artifacts: options.runtimeArtifacts,
          phaseDeadline,
          now,
          clockNow,
        })
        byProfile.set(profileId, stored)
        const attempts = storedArmsByCase.get(schedule.opaqueCaseId) ?? {}
        attempts[profileId] = stored
        storedArmsByCase.set(schedule.opaqueCaseId, attempts)
        const isCandidate = profileId === PROFILE_CANDIDATE_ID
        if (stored.durationMs === null) {
          if (isCandidate) candidateUnknownDurationCount++
          else controlUnknownDurationCount++
        } else (isCandidate ? candidateDurations : controlDurations).push(stored.durationMs)
        if (isCandidate) {
          candidateKnownCostUsd += stored.knownCostUsd
          candidateLogicalAttempts += stored.result.logicalReceipts.length
          candidatePhysicalCalls += stored.result.physicalReceipts.filter(
            (receipt) => receipt.dispatchState === 'confirmed',
          ).length
        } else {
          controlKnownCostUsd += stored.knownCostUsd
          controlLogicalAttempts += stored.result.logicalReceipts.length
          controlPhysicalCalls += stored.result.physicalReceipts.filter(
            (receipt) => receipt.dispatchState === 'confirmed',
          ).length
        }
        const bound = freeze.conservativeCostProof.profileDispatchUpperBounds.find(
          (item) => item.profileId === profileId,
        )!.maxUsdPerPhysicalDispatch
        if (isCandidate) candidateUnknownReservedUsd += stored.unknownDispatchCount * bound
        else controlUnknownReservedUsd += stored.unknownDispatchCount * bound
        const blocker = blockReason(stored.result)
        if (blocker) {
          hardBlockers.push(blocker)
          break
        }
        if (phaseDeadline.signal.aborted) {
          hardBlockers.push(
            `phase-execution-stopped:${safeFailureCode(phaseDeadline.signal.reason)}`,
          )
          break
        }
      } catch (error) {
        hardBlockers.push(
          `artifact-or-execution-blocked:${schedule.opaqueCaseId}:${profileId}:${safeFailureCode(error)}`,
        )
        break
      }
    }
    const candidate = byProfile.get(PROFILE_CANDIDATE_ID)
    const control = byProfile.get(PROFILE_CONTROL_ID)
    if (candidate && control) {
      completedPairs++
      storedByCase.set(schedule.opaqueCaseId, { candidate, control })
      if (
        truth.expectedPresence === 'absent' &&
        scoreNegativeFalseOutputRow(candidate.result.outputRow)
      )
        hardBlockers.push(`candidate-negative-false-output:${schedule.opaqueCaseId}`)
    }
    if (hardBlockers.length > 0) break
  }

  const campaignState = options.ledger.snapshot()
  if (campaignState.resumeBlocked || campaignState.inFlightReservations.length > 0)
    hardBlockers.push('campaign-ledger-has-unresolved-dispatch-or-reservation')

  const perCell = selection.cells.map((cell) => {
    const ids =
      options.screen === 'dev8'
        ? cell.dev8CaseIds
        : options.screen === 'dev12'
          ? cell.dev12CaseIds
          : cell.seededPermutationCaseIds
    let candidatePositiveSuccesses = 0
    let controlPositiveSuccesses = 0
    let candidateNegativeFalse = 0
    let controlNegativeFalse = 0
    let observedPositivePairs = 0
    let observedNegativePairs = 0
    let observedCandidatePositiveRows = 0
    let observedControlPositiveRows = 0
    let observedCandidateNegativeRows = 0
    let observedControlNegativeRows = 0
    for (const id of ids) {
      const arms = storedArmsByCase.get(id)
      if (!arms) continue
      const truth = truthById.get(id)!
      const producer = producerById.get(id)!
      if (truth.expectedPresence === 'present') {
        if (arms[PROFILE_CANDIDATE_ID]) {
          observedCandidatePositiveRows++
          if (
            scorePositiveOutputRow(
              arms[PROFILE_CANDIDATE_ID].result.outputRow,
              truth.referenceBoxes,
              truth,
              producer.sourceCanvasWidth,
              producer.sourceCanvasHeight,
              arms[PROFILE_CANDIDATE_ID].blobsBySha256,
            )
          )
            candidatePositiveSuccesses++
        }
        if (arms[PROFILE_CONTROL_ID]) {
          observedControlPositiveRows++
          if (
            scorePositiveOutputRow(
              arms[PROFILE_CONTROL_ID].result.outputRow,
              truth.referenceBoxes,
              truth,
              producer.sourceCanvasWidth,
              producer.sourceCanvasHeight,
              arms[PROFILE_CONTROL_ID].blobsBySha256,
            )
          )
            controlPositiveSuccesses++
        }
        if (arms[PROFILE_CANDIDATE_ID] && arms[PROFILE_CONTROL_ID]) observedPositivePairs++
      } else {
        if (arms[PROFILE_CANDIDATE_ID]) {
          observedCandidateNegativeRows++
          if (scoreNegativeFalseOutputRow(arms[PROFILE_CANDIDATE_ID].result.outputRow))
            candidateNegativeFalse++
        }
        if (arms[PROFILE_CONTROL_ID]) {
          observedControlNegativeRows++
          if (scoreNegativeFalseOutputRow(arms[PROFILE_CONTROL_ID].result.outputRow))
            controlNegativeFalse++
        }
        if (arms[PROFILE_CANDIDATE_ID] && arms[PROFILE_CONTROL_ID]) observedNegativePairs++
      }
    }
    const quota =
      options.screen === 'dev8'
        ? cell.dev8Quota
        : options.screen === 'dev12'
          ? cell.dev12Quota
          : cell.populationCount
    const inclusionProbability =
      options.screen === 'dev8'
        ? cell.dev8InclusionProbability
        : options.screen === 'dev12'
          ? cell.dev12InclusionProbability
          : 1
    return {
      stratum: cell.stratum,
      expectedPresence: cell.expectedPresence,
      quota,
      inclusionProbability,
      candidatePositiveSuccesses,
      controlPositiveSuccesses,
      candidateNegativeFalse,
      controlNegativeFalse,
      weightedCandidatePositiveSuccessTotal:
        cell.expectedPresence === 'present' ? candidatePositiveSuccesses / inclusionProbability : 0,
      weightedControlPositiveSuccessTotal:
        cell.expectedPresence === 'present' ? controlPositiveSuccesses / inclusionProbability : 0,
      weightedCandidatePositiveFailureTotal:
        cell.expectedPresence === 'present'
          ? Math.max(0, observedCandidatePositiveRows - candidatePositiveSuccesses) /
            inclusionProbability
          : 0,
      weightedControlPositiveFailureTotal:
        cell.expectedPresence === 'present'
          ? Math.max(0, observedControlPositiveRows - controlPositiveSuccesses) /
            inclusionProbability
          : 0,
      weightedCandidateNegativeFalseTotal:
        cell.expectedPresence === 'absent' ? candidateNegativeFalse / inclusionProbability : 0,
      weightedControlNegativeFalseTotal:
        cell.expectedPresence === 'absent' ? controlNegativeFalse / inclusionProbability : 0,
      observedPositivePairs,
      observedNegativePairs,
      observedCandidatePositiveRows,
      observedControlPositiveRows,
      observedCandidateNegativeRows,
      observedControlNegativeRows,
    }
  })
  const positivePopulation = selection.cells
    .filter((cell) => cell.expectedPresence === 'present')
    .reduce((sum, cell) => sum + cell.populationCount, 0)
  const weightedCandidateTotal = perCell.reduce(
    (sum, cell) => sum + cell.weightedCandidatePositiveSuccessTotal,
    0,
  )
  const weightedControlTotal = perCell.reduce(
    (sum, cell) => sum + cell.weightedControlPositiveSuccessTotal,
    0,
  )
  const rawCandidatePositiveSuccesses = perCell.reduce(
    (sum, cell) => sum + cell.candidatePositiveSuccesses,
    0,
  )
  const rawControlPositiveSuccesses = perCell.reduce(
    (sum, cell) => sum + cell.controlPositiveSuccesses,
    0,
  )
  const positiveDenominator =
    options.screen === 'dev8' ? 5 : options.screen === 'dev12' ? 9 : DEV40_POSITIVE_COUNT
  const expectedPairs =
    options.screen === 'dev8' ? 8 : options.screen === 'dev12' ? 12 : DEV40_CASE_COUNT
  const weightedEstimateComplete = completedPairs === expectedPairs
  if (!weightedEstimateComplete)
    hardBlockers.push(`incomplete-${options.screen}-pairs:${completedPairs}/${expectedPairs}`)
  const candidateSuccessesFromRows = [...storedArmsByCase.values()].filter((arms) => {
    const stored = arms[PROFILE_CANDIDATE_ID]
    if (!stored) return false
    const row = stored.result.outputRow
    const truth = truthById.get(row.opaqueCaseId)!
    const producer = producerById.get(row.opaqueCaseId)!
    return (
      truth.expectedPresence === 'present' &&
      scorePositiveOutputRow(
        row,
        truth.referenceBoxes,
        truth,
        producer.sourceCanvasWidth,
        producer.sourceCanvasHeight,
        stored.blobsBySha256,
      )
    )
  }).length
  const controlSuccessesFromRows = [...storedArmsByCase.values()].filter((arms) => {
    const stored = arms[PROFILE_CONTROL_ID]
    if (!stored) return false
    const row = stored.result.outputRow
    const truth = truthById.get(row.opaqueCaseId)!
    const producer = producerById.get(row.opaqueCaseId)!
    return (
      truth.expectedPresence === 'present' &&
      scorePositiveOutputRow(
        row,
        truth.referenceBoxes,
        truth,
        producer.sourceCanvasWidth,
        producer.sourceCanvasHeight,
        stored.blobsBySha256,
      )
    )
  }).length
  const allDurations = [...candidateDurations, ...controlDurations]
  const knownCostUsd = candidateKnownCostUsd + controlKnownCostUsd
  const unknownReservedUsd = candidateUnknownReservedUsd + controlUnknownReservedUsd
  const reportBody = screenReportBodySchema.parse({
    schema: 'h8a-dev-screen-report-v1',
    screen: options.screen,
    freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(freeze),
    selectionCommitmentSha256: selection.selectionCommitmentSha256,
    seed: DEV_SCREEN_SEED,
    completedPairs,
    expectedPairs,
    hardBlockers: [...new Set(hardBlockers)],
    qualitativeReviewProtocol: selection.qualitativeReviewProtocol,
    qualitativeReviewOwner: selection.qualitativeReviewOwner,
    perCell,
    rawCandidatePositiveSuccesses,
    rawControlPositiveSuccesses,
    candidatePositiveDenominator: positiveDenominator,
    controlPositiveDenominator: positiveDenominator,
    weightedCandidatePositiveRate:
      weightedEstimateComplete && positivePopulation
        ? weightedCandidateTotal / positivePopulation
        : null,
    weightedControlPositiveRate:
      weightedEstimateComplete && positivePopulation
        ? weightedControlTotal / positivePopulation
        : null,
    weightedPairedPositiveDifference:
      weightedEstimateComplete && positivePopulation
        ? (weightedCandidateTotal - weightedControlTotal) / positivePopulation
        : null,
    weightedEstimateComplete,
    candidateNegativeFalseOutputs: perCell.reduce(
      (sum, cell) => sum + cell.candidateNegativeFalse,
      0,
    ),
    rawDurationMs: allDurations,
    nearestRankP50Ms: percentileNearestRank(allDurations, 0.5),
    nearestRankP95Ms: percentileNearestRank(allDurations, 0.95),
    knownCostUsd,
    unknownReservedUsd,
    successfulPositiveKnownCostUsd:
      candidateSuccessesFromRows > 0 ? candidateKnownCostUsd / candidateSuccessesFromRows : null,
    candidate: {
      knownCostUsd: candidateKnownCostUsd,
      unknownReservedUsd: candidateUnknownReservedUsd,
      confirmedPhysicalCalls: candidatePhysicalCalls,
      logicalAttempts: candidateLogicalAttempts,
      unknownDurationCount: candidateUnknownDurationCount,
      durationsMs: candidateDurations,
      p50Ms: percentileNearestRank(candidateDurations, 0.5),
      p95Ms: percentileNearestRank(candidateDurations, 0.95),
      successfulPositiveKnownCostUsd:
        candidateSuccessesFromRows > 0 ? candidateKnownCostUsd / candidateSuccessesFromRows : null,
    },
    control: {
      knownCostUsd: controlKnownCostUsd,
      unknownReservedUsd: controlUnknownReservedUsd,
      confirmedPhysicalCalls: controlPhysicalCalls,
      logicalAttempts: controlLogicalAttempts,
      unknownDurationCount: controlUnknownDurationCount,
      durationsMs: controlDurations,
      p50Ms: percentileNearestRank(controlDurations, 0.5),
      p95Ms: percentileNearestRank(controlDurations, 0.95),
      successfulPositiveKnownCostUsd:
        controlSuccessesFromRows > 0 ? controlKnownCostUsd / controlSuccessesFromRows : null,
    },
    outputs: selectedInOrder.map((scheduled) => {
      const opaqueCaseId = scheduled.opaqueCaseId
      const arms = storedArmsByCase.get(opaqueCaseId) ?? {}
      const candidate = arms[PROFILE_CANDIDATE_ID]
      const control = arms[PROFILE_CONTROL_ID]
      const truth = truthById.get(opaqueCaseId)!
      const producer = producerById.get(opaqueCaseId)!
      return {
        opaqueCaseId,
        stratum: scheduled.stratum,
        expectedPresence: truth.expectedPresence,
        candidateCaseState: candidate?.result.outputRow.caseState ?? 'unstarted',
        controlCaseState: control?.result.outputRow.caseState ?? 'unstarted',
        candidatePositiveSuccess: Boolean(
          candidate &&
            truth.expectedPresence === 'present' &&
            scorePositiveOutputRow(
              candidate.result.outputRow,
              truth.referenceBoxes,
              truth,
              producer.sourceCanvasWidth,
              producer.sourceCanvasHeight,
              candidate.blobsBySha256,
            ),
        ),
        controlPositiveSuccess: Boolean(
          control &&
            truth.expectedPresence === 'present' &&
            scorePositiveOutputRow(
              control.result.outputRow,
              truth.referenceBoxes,
              truth,
              producer.sourceCanvasWidth,
              producer.sourceCanvasHeight,
              control.blobsBySha256,
            ),
        ),
        candidateNegativeFalse: Boolean(
          candidate &&
            truth.expectedPresence === 'absent' &&
            scoreNegativeFalseOutputRow(candidate.result.outputRow),
        ),
        controlNegativeFalse: Boolean(
          control &&
            truth.expectedPresence === 'absent' &&
            scoreNegativeFalseOutputRow(control.result.outputRow),
        ),
        candidateIdentitySha256:
          candidate?.identitySha256 ??
          store.identity(
            buildCaseArtifactIdentity(freeze, selection, producer, PROFILE_CANDIDATE_ID),
          ).sha256,
        controlIdentitySha256:
          control?.identitySha256 ??
          store.identity(buildCaseArtifactIdentity(freeze, selection, producer, PROFILE_CONTROL_ID))
            .sha256,
      }
    }),
  })
  const report = devScreenReportSchema.parse({
    ...reportBody,
    reportSha256: hashIdentity(reportBody),
  })
  const reportPath = `${options.artifactRoot}/reports/${options.screen}-report.json`
  await persistImmutableJson(reportPath, report)
  return report
}

function validateDevScreenReview(raw: unknown): DevScreenReview {
  const parsed = reviewBodySchema
    .extend({ reviewSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
    .strict()
    .parse(raw)
  const { reviewSha256, ...body } = parsed
  if (hashIdentity(body) !== reviewSha256) throw new RangeError('DEV screen review digest mismatch')
  return body
}

export async function sealDevScreenReview(
  artifactRoot: string,
  report: DevScreenReport,
  judgement: 'advance' | 'stop',
  reason: string,
): Promise<DevScreenReview> {
  const validated = devScreenReportSchema.parse(report)
  const { reportSha256, ...reportBody } = validated
  if (hashIdentity(reportBody) !== reportSha256)
    throw new RangeError('DEV screen report digest mismatch')
  if (
    judgement === 'advance' &&
    (validated.hardBlockers.length > 0 ||
      validated.completedPairs !== validated.expectedPairs ||
      validated.candidateNegativeFalseOutputs > 0 ||
      !validated.weightedEstimateComplete)
  )
    throw new RangeError('An incomplete screen or one with hard blockers cannot be advanced')
  const body = reviewBodySchema.parse({
    schema: 'h8a-dev-screen-review-v1',
    screenReportSha256: reportSha256,
    reviewProtocol: 'no-apparent-collapse-main-review-v1',
    reviewerId: 'main-orchestrator',
    judgement,
    reason,
  })
  const review = { ...body, reviewSha256: hashIdentity(body) }
  await persistImmutableJson(`${artifactRoot}/reviews/${validated.screen}-review.json`, review)
  return body
}

async function persistImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = `${JSON.stringify(value)}\n`
  try {
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if ((await readFile(path, 'utf8')) !== bytes)
      throw new RangeError('Persisted screen artifact is immutable')
  }
}
