import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import {
  acquireExclusiveFileLock,
  AtomicJsonLedgerStore,
  atomicWriteJsonFile,
} from './atomic-json-ledger.js'
import type {
  CampaignLedgerSnapshotPort,
  LedgerLogicalAttemptContext,
  LedgerPhysicalCallContext,
  SuccessorCampaignAdmissionPort,
} from './campaign-ledger-port.js'
import type { H8aFreshProfileId } from './profiles.js'
import {
  UI_STATE_DEV40_EXECUTION_V2_ID,
  UI_STATE_DEV40_EXECUTION_V2_SUCCESSOR_ROOT,
  UI_STATE_DEV40_PARENT_LEDGER_SHA256,
  UI_STATE_DEV40_PARENT_ROOT,
  UI_STATE_DEV40_PARENT_REGISTRATION_SHA256,
  UI_STATE_DEV40_FREEZE_ID,
  UI_STATE_DEV40_PUBLIC_COST_BOUNDS_SHA256,
  UI_STATE_DEV40_STUDY_ID,
  UI_STATE_DEV40_ROOT,
} from './ui-state-dev40-policy.js'
import { verifyZeroQueryExecutionV2Preconditions } from './ui-state-zero-query-execution-v2.js'

const INDEPENDENT_DEV40_STUDY_ID = UI_STATE_DEV40_STUDY_ID
export const SUCCESSOR_REGISTRATION_RELATIVE_PATH = join('admission', 'successor-campaign-v1')
export const DEV40_SUCCESSOR_MAX_CALLS = 400 as const
const SUCCESSOR_GLOBAL_MAX_CALLS = 2_000 as const
export const SUCCESSOR_DEV40_MAX_INCREMENTAL_USD = 116.8 as const
export const CANDIDATE_MAX_USD_PER_DISPATCH = 0.55 as const
export const CONTROL_MAX_USD_PER_DISPATCH = 0.12 as const

export const INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256 =
  UI_STATE_DEV40_PARENT_REGISTRATION_SHA256
export const INDEPENDENT_DEV40_PARENT_LEDGER_SHA256 = UI_STATE_DEV40_PARENT_LEDGER_SHA256
export const INDEPENDENT_DEV40_COST_PROOF_SHA256 = UI_STATE_DEV40_PUBLIC_COST_BOUNDS_SHA256

const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u)
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const candidateProfileSchema = z.literal(PROFILE_FLAT_CANDIDATE_ID)
const profileSchema = z.union([candidateProfileSchema, z.literal(PROFILE_CONTROL_ID)])
const profileCallCost = {
  [PROFILE_FLAT_CANDIDATE_ID]: CANDIDATE_MAX_USD_PER_DISPATCH,
  [PROFILE_CONTROL_ID]: CONTROL_MAX_USD_PER_DISPATCH,
} as const
type SuccessorProfileId = keyof typeof profileCallCost

const parentLedgerSchema = z
  .object({
    schema: z.literal('h8a-fresh-campaign-ledger-v1'),
    ledgerVersion: z.number().int().nonnegative(),
    maxPhysicalCalls: z.literal(SUCCESSOR_GLOBAL_MAX_CALLS),
    maxCostUsd: z.literal(10),
    nextReservationId: z.number().int().positive(),
    physicalDispatchCount: z.number().int().nonnegative(),
    logicalAttemptCount: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownReserveUsd: z.number().finite().nonnegative(),
    inFlightReservations: z.array(z.unknown()),
    resumeBlocked: z.boolean(),
    crashRecoveryLatched: z.boolean().optional(),
  })
  .strict()

const registrationSchema = z
  .object({
    schema: z.enum([
      'h8a-ui-state-dev40-successor-registration-v1',
      'h8a-ui-state-dev40-execution-v2-successor-registration-v1',
    ]),
    studyId: z.literal(INDEPENDENT_DEV40_STUDY_ID),
    executionId: z.literal(UI_STATE_DEV40_EXECUTION_V2_ID).optional(),
    parentRegistrationSha256: z.literal(INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256),
    parentLedgerSha256: z.literal(INDEPENDENT_DEV40_PARENT_LEDGER_SHA256),
    publicCostProofSha256: z.literal(INDEPENDENT_DEV40_COST_PROOF_SHA256),
    canonicalStudyRoot: z.string().min(1),
    canonicalParentRoot: z.string().min(1),
    canonicalSuccessorRoot: z.string().min(1),
    ownerDollarCeilingUsd: z.null(),
    globalPhysicalCallLimit: z.literal(SUCCESSOR_GLOBAL_MAX_CALLS),
    dev40PhysicalCallLimit: z.literal(DEV40_SUCCESSOR_MAX_CALLS),
    dev40IncrementalExposureUsd: z.literal(SUCCESSOR_DEV40_MAX_INCREMENTAL_USD),
    candidateMaxUsdPerDispatch: z.literal(CANDIDATE_MAX_USD_PER_DISPATCH),
    controlMaxUsdPerDispatch: z.literal(CONTROL_MAX_USD_PER_DISPATCH),
    candidateMaxCallsPerCase: z.literal(4),
    controlMaxCallsPerCase: z.literal(6),
    paidRetries: z.literal(0),
    inherited: z
      .object({
        ledgerVersion: z.number().int().nonnegative(),
        nextReservationId: z.number().int().positive(),
        physicalDispatchCount: z.number().int().nonnegative(),
        logicalAttemptCount: z.number().int().nonnegative(),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownReserveUsd: z.number().finite().nonnegative(),
      })
      .strict(),
    registrationSha256: DIGEST,
  })
  .strict()
  .superRefine((registration, context) => {
    const executionV2 =
      registration.schema === 'h8a-ui-state-dev40-execution-v2-successor-registration-v1'
    if (executionV2 !== (registration.executionId === UI_STATE_DEV40_EXECUTION_V2_ID))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Registration execution identity is inconsistent',
      })
  })

const profileCounterSchema = z
  .object({
    profileId: profileSchema,
    confirmedCalls: z.number().int().nonnegative(),
    uncertainCalls: z.number().int().nonnegative(),
  })
  .strict()

const caseArmCounterSchema = z
  .object({
    profileId: profileSchema,
    opaqueCaseId: z.string().min(1).max(200),
    calls: z.number().int().positive(),
  })
  .strict()

const logicalAttemptSchema = z
  .object({
    profileId: profileSchema,
    opaqueCaseId: z.string().min(1).max(200),
  })
  .strict()

const reservationSchema = z
  .object({
    reservationId: z.number().int().positive(),
    reservedUsd: z.number().finite().positive(),
    profileId: profileSchema,
    opaqueCaseId: z.string().min(1).max(200),
    dispatchIntentRecorded: z.boolean(),
    dispatched: z.boolean(),
    physicalId: z.number().int().positive().nullable(),
  })
  .strict()

const stateSchema = z
  .object({
    schema: z.literal('h8a-ui-state-dev40-successor-ledger-v1'),
    ledgerVersion: z.number().int().nonnegative(),
    registrationSha256: DIGEST,
    maxOwnerCostUsd: z.null(),
    maxPhysicalCalls: z.literal(SUCCESSOR_GLOBAL_MAX_CALLS),
    dev40MaxPhysicalCalls: z.literal(DEV40_SUCCESSOR_MAX_CALLS),
    nextReservationId: z.number().int().positive(),
    nextPhysicalId: z.number().int().positive(),
    physicalDispatchCount: z.number().int().nonnegative(),
    uncertainPhysicalDispatchCount: z.number().int().nonnegative(),
    logicalAttemptCount: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownReserveUsd: z.number().finite().nonnegative(),
    dev40KnownCostUsd: z.number().finite().nonnegative(),
    dev40UnknownReserveUsd: z.number().finite().nonnegative(),
    dev40ConfirmedPhysicalCalls: z.number().int().nonnegative(),
    dev40UncertainPhysicalCalls: z.number().int().nonnegative(),
    profileCounters: z.array(profileCounterSchema).length(2),
    caseArmCounters: z.array(caseArmCounterSchema),
    logicalAttempts: z.array(logicalAttemptSchema),
    inFlightReservations: z.array(reservationSchema),
    resumeBlocked: z.boolean(),
    crashRecoveryLatched: z.boolean(),
    integrityBlocked: z.boolean(),
  })
  .strict()

type SuccessorLedgerState = z.infer<typeof stateSchema>
type SuccessorRegistration = z.infer<typeof registrationSchema>
type Reservation = z.infer<typeof reservationSchema>

export interface SuccessorCampaignLedgerOptions {
  studyRoot: string
  parentRoot: string
  parentLedgerPath: string
  executionId?: typeof UI_STATE_DEV40_EXECUTION_V2_ID
  offlineTestOnly?: boolean
}

export class SuccessorCampaignLedgerBlockedError extends Error {
  readonly code = 'H8A_SUCCESSOR_LEDGER_BLOCKED'
  constructor(message: string) {
    super(message)
    this.name = 'SuccessorCampaignLedgerBlockedError'
  }
}

export class SuccessorCampaignBudgetExhaustedError extends Error {
  readonly code = 'H8A_SUCCESSOR_BUDGET_EXHAUSTED'
  constructor(message: string) {
    super(message)
    this.name = 'SuccessorCampaignBudgetExhaustedError'
  }
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function hashRegistrationBody(body: Omit<SuccessorRegistration, 'registrationSha256'>): string {
  return hash(JSON.stringify(body))
}

function registrationBody(options: {
  studyRoot: string
  parentRoot: string
  successorRoot: string
  parentLedger: z.infer<typeof parentLedgerSchema>
  executionId?: typeof UI_STATE_DEV40_EXECUTION_V2_ID
}): Omit<SuccessorRegistration, 'registrationSha256'> {
  return {
    schema: options.executionId
      ? 'h8a-ui-state-dev40-execution-v2-successor-registration-v1'
      : 'h8a-ui-state-dev40-successor-registration-v1',
    studyId: INDEPENDENT_DEV40_STUDY_ID,
    ...(options.executionId ? { executionId: options.executionId } : {}),
    parentRegistrationSha256: INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256,
    parentLedgerSha256: INDEPENDENT_DEV40_PARENT_LEDGER_SHA256,
    publicCostProofSha256: INDEPENDENT_DEV40_COST_PROOF_SHA256,
    canonicalStudyRoot: options.studyRoot,
    canonicalParentRoot: options.parentRoot,
    canonicalSuccessorRoot: options.successorRoot,
    ownerDollarCeilingUsd: null,
    globalPhysicalCallLimit: SUCCESSOR_GLOBAL_MAX_CALLS,
    dev40PhysicalCallLimit: DEV40_SUCCESSOR_MAX_CALLS,
    dev40IncrementalExposureUsd: SUCCESSOR_DEV40_MAX_INCREMENTAL_USD,
    candidateMaxUsdPerDispatch: CANDIDATE_MAX_USD_PER_DISPATCH,
    controlMaxUsdPerDispatch: CONTROL_MAX_USD_PER_DISPATCH,
    candidateMaxCallsPerCase: 4,
    controlMaxCallsPerCase: 6,
    paidRetries: 0,
    inherited: {
      ledgerVersion: options.parentLedger.ledgerVersion,
      nextReservationId: options.parentLedger.nextReservationId,
      physicalDispatchCount: options.parentLedger.physicalDispatchCount,
      logicalAttemptCount: options.parentLedger.logicalAttemptCount,
      knownCostUsd: options.parentLedger.knownCostUsd,
      unknownReserveUsd: options.parentLedger.unknownReserveUsd,
    },
  }
}

function sameProfile(left: H8aFreshProfileId, right: SuccessorProfileId): boolean {
  return left === right
}

function profileCost(profileId: SuccessorProfileId): number {
  return profileCallCost[profileId]
}

function callIdentity(context: LedgerPhysicalCallContext): string {
  return `${context.profileId}\u0000${context.opaqueCaseId}`
}

function allowedProfile(profileId: H8aFreshProfileId): profileId is SuccessorProfileId {
  return profileId === PROFILE_FLAT_CANDIDATE_ID || profileId === PROFILE_CONTROL_ID
}

function profileCalls(state: SuccessorLedgerState, profileId: SuccessorProfileId): number {
  const counter = state.profileCounters.find((item) => item.profileId === profileId)
  if (!counter) throw new RangeError('Successor ledger profile counter is missing')
  return counter.confirmedCalls + counter.uncertainCalls
}

function caseCalls(
  state: SuccessorLedgerState,
  profileId: SuccessorProfileId,
  opaqueCaseId: string,
): number {
  return (
    state.caseArmCounters.find(
      (item) => item.profileId === profileId && item.opaqueCaseId === opaqueCaseId,
    )?.calls ?? 0
  )
}

function baseExposure(registration: SuccessorRegistration): number {
  return registration.inherited.knownCostUsd + registration.inherited.unknownReserveUsd
}

function exposure(state: SuccessorLedgerState): number {
  return (
    state.knownCostUsd +
    state.unknownReserveUsd +
    state.inFlightReservations.reduce((sum, item) => sum + item.reservedUsd, 0)
  )
}

function assertResumeState(state: SuccessorLedgerState): void {
  if (state.resumeBlocked || state.crashRecoveryLatched || state.integrityBlocked)
    throw new SuccessorCampaignLedgerBlockedError('Successor campaign requires manual recovery')
  if (state.inFlightReservations.length > 0)
    throw new SuccessorCampaignLedgerBlockedError('Successor campaign has unresolved reservations')
}

function initialState(registration: SuccessorRegistration): SuccessorLedgerState {
  const parent = registration.inherited
  return stateSchema.parse({
    schema: 'h8a-ui-state-dev40-successor-ledger-v1',
    ledgerVersion: 0,
    registrationSha256: registration.registrationSha256,
    maxOwnerCostUsd: null,
    maxPhysicalCalls: SUCCESSOR_GLOBAL_MAX_CALLS,
    dev40MaxPhysicalCalls: DEV40_SUCCESSOR_MAX_CALLS,
    nextReservationId: parent.nextReservationId,
    nextPhysicalId: parent.physicalDispatchCount + 1,
    physicalDispatchCount: parent.physicalDispatchCount,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: parent.logicalAttemptCount,
    knownCostUsd: parent.knownCostUsd,
    unknownReserveUsd: parent.unknownReserveUsd,
    dev40KnownCostUsd: 0,
    dev40UnknownReserveUsd: 0,
    dev40ConfirmedPhysicalCalls: 0,
    dev40UncertainPhysicalCalls: 0,
    profileCounters: [
      { profileId: PROFILE_FLAT_CANDIDATE_ID, confirmedCalls: 0, uncertainCalls: 0 },
      { profileId: PROFILE_CONTROL_ID, confirmedCalls: 0, uncertainCalls: 0 },
    ],
    caseArmCounters: [],
    logicalAttempts: [],
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
    integrityBlocked: false,
  })
}

function assertState(state: SuccessorLedgerState, registration: SuccessorRegistration): void {
  const inherited = registration.inherited
  if (
    state.registrationSha256 !== registration.registrationSha256 ||
    state.maxOwnerCostUsd !== null ||
    state.physicalDispatchCount !==
      inherited.physicalDispatchCount + state.dev40ConfirmedPhysicalCalls ||
    state.logicalAttemptCount !== inherited.logicalAttemptCount + state.logicalAttempts.length ||
    state.knownCostUsd < inherited.knownCostUsd ||
    state.unknownReserveUsd < inherited.unknownReserveUsd ||
    state.dev40ConfirmedPhysicalCalls + state.dev40UncertainPhysicalCalls >
      DEV40_SUCCESSOR_MAX_CALLS ||
    state.physicalDispatchCount +
      state.uncertainPhysicalDispatchCount +
      state.inFlightReservations.length >
      SUCCESSOR_GLOBAL_MAX_CALLS ||
    state.uncertainPhysicalDispatchCount !== state.dev40UncertainPhysicalCalls ||
    state.nextPhysicalId !== state.physicalDispatchCount + state.uncertainPhysicalDispatchCount + 1
  )
    throw new RangeError('Successor ledger counters violate their registered bounds')

  const candidate = state.profileCounters.find(
    (item) => item.profileId === PROFILE_FLAT_CANDIDATE_ID,
  )!
  const control = state.profileCounters.find((item) => item.profileId === PROFILE_CONTROL_ID)!
  if (
    candidate.confirmedCalls + candidate.uncertainCalls > 160 ||
    control.confirmedCalls + control.uncertainCalls > 240 ||
    candidate.confirmedCalls +
      candidate.uncertainCalls +
      control.confirmedCalls +
      control.uncertainCalls !==
      state.dev40ConfirmedPhysicalCalls + state.dev40UncertainPhysicalCalls
  )
    throw new RangeError('Successor profile dispatch totals violate their per-arm ceilings')

  const cases = new Set<string>()
  const counts = new Set<string>()
  for (const item of state.caseArmCounters) {
    const key = callIdentity(item)
    if (counts.has(key) || item.calls > (item.profileId === PROFILE_FLAT_CANDIDATE_ID ? 4 : 6))
      throw new RangeError('Successor per-case dispatch counters violate their ceilings')
    counts.add(key)
    cases.add(item.opaqueCaseId)
  }
  for (const reservation of state.inFlightReservations) {
    cases.add(reservation.opaqueCaseId)
    if (
      !sameProfile(reservation.profileId, PROFILE_FLAT_CANDIDATE_ID) &&
      !sameProfile(reservation.profileId, PROFILE_CONTROL_ID)
    )
      throw new RangeError('Successor reservation has a non-study profile')
  }
  for (const attempt of state.logicalAttempts) cases.add(attempt.opaqueCaseId)
  if (
    cases.size > 40 ||
    exposure(state) > baseExposure(registration) + SUCCESSOR_DEV40_MAX_INCREMENTAL_USD + 1e-9
  )
    throw new RangeError('Successor cumulative technical exposure exceeded DEV40 envelope')

  const caseCountByProfile = new Map<SuccessorProfileId, number>([
    [PROFILE_FLAT_CANDIDATE_ID, 0],
    [PROFILE_CONTROL_ID, 0],
  ])
  for (const row of state.caseArmCounters) {
    const total = caseCountByProfile.get(row.profileId) ?? 0
    caseCountByProfile.set(row.profileId, total + row.calls)
  }
  if (
    caseCountByProfile.get(PROFILE_FLAT_CANDIDATE_ID) !==
      candidate.confirmedCalls + candidate.uncertainCalls ||
    caseCountByProfile.get(PROFILE_CONTROL_ID) !==
      control.confirmedCalls + control.uncertainCalls ||
    state.dev40KnownCostUsd + state.dev40UnknownReserveUsd >
      SUCCESSOR_DEV40_MAX_INCREMENTAL_USD + 1e-9 ||
    Math.abs(state.knownCostUsd - inherited.knownCostUsd - state.dev40KnownCostUsd) > 1e-9 ||
    Math.abs(state.unknownReserveUsd - inherited.unknownReserveUsd - state.dev40UnknownReserveUsd) >
      1e-9
  )
    throw new RangeError('Successor costs and profile counters do not reconcile')

  const reservationIds = state.inFlightReservations.map((item) => item.reservationId)
  if (new Set(reservationIds).size !== reservationIds.length)
    throw new RangeError('Successor reservation IDs are not unique')
  if (state.inFlightReservations.some((item) => item.reservedUsd !== profileCost(item.profileId)))
    throw new RangeError('Successor reservation does not use its registered per-request bound')
}

function parseCostProof(raw: unknown): void {
  const proof = z
    .object({
      registeredStudySha256: z.literal(INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256),
      ownerDollarCeiling: z.null(),
      physicalCallLimit: z.literal(SUCCESSOR_GLOBAL_MAX_CALLS),
      perCaseTechnicalExposureUsd: z.literal('2.92'),
      devMaximumIncrementalExposureUsd: z.literal('116.80'),
      conditionalQualMaximumIncrementalExposureUsd: z.literal('350.40'),
      entries: z.tuple([
        z
          .object({ profileId: candidateProfileSchema, maxUsdPerPhysicalDispatch: z.literal(0.55) })
          .passthrough(),
        z
          .object({
            profileId: z.literal(PROFILE_CONTROL_ID),
            maxUsdPerPhysicalDispatch: z.literal(0.12),
          })
          .passthrough(),
      ]),
    })
    .passthrough()
    .parse(raw)
  if (
    proof.entries[0].maxUsdPerPhysicalDispatch * 4 +
      proof.entries[1].maxUsdPerPhysicalDispatch * 6 !==
      2.92 ||
    proof.entries[0].maxUsdPerPhysicalDispatch * 160 +
      proof.entries[1].maxUsdPerPhysicalDispatch * 240 !==
      SUCCESSOR_DEV40_MAX_INCREMENTAL_USD
  )
    throw new RangeError('Registered public cost bounds fail their arithmetic check')
}

async function readPinnedRegularFile(path: string, expectedSha256: string): Promise<Buffer> {
  const target = resolve(path)
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink())
    throw new SuccessorCampaignLedgerBlockedError(
      'A pinned registration input is not a regular file',
    )
  const bytes = await readFile(target)
  if (hash(bytes) !== expectedSha256)
    throw new SuccessorCampaignLedgerBlockedError('A pinned registration input hash changed')
  return bytes
}

async function assertPhysicalDirectory(path: string, mustExist: boolean): Promise<string> {
  const absolute = resolve(path)
  try {
    const info = await lstat(absolute)
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(absolute)) !== absolute)
      throw new SuccessorCampaignLedgerBlockedError('Campaign root must be a physical directory')
  } catch (error) {
    if (error instanceof SuccessorCampaignLedgerBlockedError) throw error
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT' && !mustExist)
      return absolute
    throw error
  }
  return absolute
}

async function validateRegistrationInputs(options: SuccessorCampaignLedgerOptions): Promise<{
  studyRoot: string
  parentRoot: string
  successorRoot: string
  registration: SuccessorRegistration
}> {
  const studyRoot = await assertPhysicalDirectory(options.studyRoot, true)
  const parentRoot = await assertPhysicalDirectory(options.parentRoot, true)
  const offlineTestOnly = options.offlineTestOnly === true
  const temporaryRoot = resolve(tmpdir())
  if (
    offlineTestOnly &&
    (options.executionId !== undefined ||
      studyRoot === UI_STATE_DEV40_ROOT ||
      parentRoot === UI_STATE_DEV40_PARENT_ROOT ||
      studyRoot === temporaryRoot ||
      parentRoot === temporaryRoot ||
      !isInside(temporaryRoot, studyRoot) ||
      !isInside(temporaryRoot, parentRoot))
  )
    throw new SuccessorCampaignLedgerBlockedError(
      'Offline test mode requires disposable temporary roots without a live execution identity',
    )
  const expectedParentLedger = resolve(options.parentLedgerPath)
  const expectedParentRoot = resolve(studyRoot, '..', 'h8a-fresh-dev-qual-campaign-v1')
  if (options.executionId && options.executionId !== UI_STATE_DEV40_EXECUTION_V2_ID)
    throw new SuccessorCampaignLedgerBlockedError('Unknown successor execution identity')
  if (options.executionId) await verifyZeroQueryExecutionV2Preconditions()
  const canonicalRootsMatch = options.executionId
    ? studyRoot === UI_STATE_DEV40_ROOT &&
      parentRoot === UI_STATE_DEV40_PARENT_ROOT &&
      expectedParentLedger === join(UI_STATE_DEV40_PARENT_ROOT, 'campaign-ledger.json')
    : true
  if (
    basename(studyRoot) !== INDEPENDENT_DEV40_STUDY_ID ||
    basename(parentRoot) !== 'h8a-fresh-dev-qual-campaign-v1' ||
    parentRoot !== expectedParentRoot ||
    isInside(REPOSITORY_ROOT, studyRoot) ||
    isInside(REPOSITORY_ROOT, parentRoot) ||
    expectedParentLedger !== join(parentRoot, 'campaign-ledger.json') ||
    isInside(studyRoot, parentRoot) ||
    isInside(parentRoot, studyRoot) ||
    !canonicalRootsMatch
  )
    throw new SuccessorCampaignLedgerBlockedError('Parent and successor roots are not distinct')

  const parentRegistrationPath = join(studyRoot, 'parent-registration.json')
  const costProofPath = join(studyRoot, 'main', 'public-cost-bounds.json')
  const parentRegistrationBytes = await readPinnedRegularFile(
    parentRegistrationPath,
    INDEPENDENT_DEV40_PARENT_REGISTRATION_SHA256,
  )
  const parentRegistration = z
    .object({
      schema: z.literal('h8a-ui-native-state-dev40-registration-v1'),
      studyId: z.literal(INDEPENDENT_DEV40_STUDY_ID),
      freezeId: z.literal(UI_STATE_DEV40_FREEZE_ID),
      ownerDollarCeiling: z.null(),
      scientificPolicy: z
        .object({
          boundedCalls: z.object({
            global: z.literal(SUCCESSOR_GLOBAL_MAX_CALLS),
            dev40WorstCaseBoth: z.literal(DEV40_SUCCESSOR_MAX_CALLS),
            qual120WorstCaseBoth: z.literal(1_200),
            candidatePerCase: z.literal(4),
            controlPerCase: z.literal(6),
          }),
          paidRetries: z.literal(0),
        })
        .passthrough(),
      parentFiles: z.record(z.string(), DIGEST),
    })
    .passthrough()
    .parse(JSON.parse(parentRegistrationBytes.toString('utf8')) as unknown)
  if (
    parentRegistration.parentFiles['h8a-fresh-dev-qual-campaign-v1/campaign-ledger.json'] !==
    INDEPENDENT_DEV40_PARENT_LEDGER_SHA256
  )
    throw new SuccessorCampaignLedgerBlockedError('Registered parent ledger pin is missing')

  const ledgerBytes = await readPinnedRegularFile(
    expectedParentLedger,
    INDEPENDENT_DEV40_PARENT_LEDGER_SHA256,
  )
  const parentLedger = parentLedgerSchema.parse(JSON.parse(ledgerBytes.toString('utf8')) as unknown)
  if (
    parentLedger.ledgerVersion !== 497 ||
    parentLedger.nextReservationId !== 101 ||
    parentLedger.physicalDispatchCount !== 100 ||
    parentLedger.logicalAttemptCount !== 32 ||
    parentLedger.knownCostUsd !== 0.059908515 ||
    parentLedger.unknownReserveUsd !== 0.12 ||
    parentLedger.inFlightReservations.length !== 0 ||
    parentLedger.resumeBlocked
  )
    throw new SuccessorCampaignLedgerBlockedError(
      'Parent ledger counters differ from registered audit',
    )

  const costBytes = await readPinnedRegularFile(costProofPath, INDEPENDENT_DEV40_COST_PROOF_SHA256)
  parseCostProof(JSON.parse(costBytes.toString('utf8')) as unknown)
  const successorRoot = options.executionId
    ? UI_STATE_DEV40_EXECUTION_V2_SUCCESSOR_ROOT
    : resolve(studyRoot, SUCCESSOR_REGISTRATION_RELATIVE_PATH)
  const registrationBodyValue = registrationBody({
    studyRoot,
    parentRoot,
    successorRoot,
    parentLedger,
    ...(options.executionId ? { executionId: options.executionId } : {}),
  })
  const registration = registrationSchema.parse({
    ...registrationBodyValue,
    registrationSha256: hashRegistrationBody(registrationBodyValue),
  })
  return { studyRoot, parentRoot, successorRoot, registration }
}

function exactRegistration(left: SuccessorRegistration, right: SuccessorRegistration): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function readRegistration(successorRoot: string): Promise<SuccessorRegistration> {
  const path = join(successorRoot, 'registration.json')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new SuccessorCampaignLedgerBlockedError('Successor registration is not a physical file')
  return registrationSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

function ledgerSnapshot(state: SuccessorLedgerState): CampaignLedgerSnapshotPort {
  return {
    physicalDispatchCount: state.physicalDispatchCount,
    logicalAttemptCount: state.logicalAttemptCount,
    knownCostUsd: state.knownCostUsd,
    unknownReserveUsd: state.unknownReserveUsd,
    inFlightReservations: state.inFlightReservations.map((item) => ({ ...item })),
    resumeBlocked:
      state.resumeBlocked ||
      state.crashRecoveryLatched ||
      state.integrityBlocked ||
      state.inFlightReservations.length > 0,
  }
}

export class SuccessorCampaignLedger implements SuccessorCampaignAdmissionPort {
  private constructor(
    private readonly root: string,
    private readonly registration: SuccessorRegistration,
    private state: SuccessorLedgerState,
    private readonly storage = new AtomicJsonLedgerStore(join(root, 'campaign-ledger.json'), true),
  ) {}

  static async register(options: SuccessorCampaignLedgerOptions): Promise<SuccessorCampaignLedger> {
    const ownedOptions = { ...options }
    const durable = ownedOptions.offlineTestOnly !== true
    const validated = await validateRegistrationInputs(ownedOptions)
    const admissionRoot = join(validated.studyRoot, 'admission')
    await mkdir(admissionRoot, { recursive: false, mode: 0o700 }).catch(async (error: unknown) => {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
      const info = await lstat(admissionRoot)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(admissionRoot)) !== admissionRoot
      )
        throw new SuccessorCampaignLedgerBlockedError(
          'Successor admission root is not a physical directory',
        )
    })
    const admissionRootReal = await realpath(admissionRoot)
    if (admissionRootReal !== admissionRoot)
      throw new SuccessorCampaignLedgerBlockedError('Successor admission root is aliased')
    const unlock = await acquireExclusiveFileLock(
      join(admissionRoot, 'successor-registration.lock'),
      durable,
    )
    try {
      let rootExists = false
      try {
        const info = await lstat(validated.successorRoot)
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new SuccessorCampaignLedgerBlockedError(
            'Existing successor root is not a directory',
          )
        rootExists = true
      } catch (error) {
        if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      }
      if (!rootExists) await mkdir(validated.successorRoot, { recursive: false, mode: 0o700 })
      if ((await realpath(validated.successorRoot)) !== validated.successorRoot)
        throw new SuccessorCampaignLedgerBlockedError('Successor root is aliased')

      const registrationPath = join(validated.successorRoot, 'registration.json')
      const ledgerPath = join(validated.successorRoot, 'campaign-ledger.json')
      const storage = new AtomicJsonLedgerStore(ledgerPath, durable)
      const expectedState = initialState(validated.registration)
      let existingRegistration: SuccessorRegistration | undefined
      try {
        existingRegistration = await readRegistration(validated.successorRoot)
      } catch (error) {
        if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      }
      if (existingRegistration && !exactRegistration(existingRegistration, validated.registration))
        throw new SuccessorCampaignLedgerBlockedError(
          'Successor root is bound to a different registration',
        )

      let existingState = await storage.read((raw) => stateSchema.parse(raw))
      if (existingRegistration && !existingState)
        throw new SuccessorCampaignLedgerBlockedError('Registered successor ledger is missing')
      if (existingState) assertState(existingState, validated.registration)
      if (existingState && !existingRegistration) {
        if (JSON.stringify(existingState) !== JSON.stringify(expectedState))
          throw new SuccessorCampaignLedgerBlockedError(
            'Unregistered successor root contains noninitial state',
          )
        await atomicWriteJsonFile(registrationPath, validated.registration, durable)
      } else if (!existingState) {
        const existingEntries = await readdir(validated.successorRoot)
        if (existingEntries.length > 0)
          throw new SuccessorCampaignLedgerBlockedError(
            'Unregistered successor root contains unknown files',
          )
        existingState = await storage.openOrCreate((raw) => stateSchema.parse(raw), expectedState)
        await atomicWriteJsonFile(registrationPath, validated.registration, durable)
      }
      return new SuccessorCampaignLedger(
        validated.successorRoot,
        validated.registration,
        existingState!,
        storage,
      )
    } finally {
      await unlock()
    }
  }

  static async open(options: SuccessorCampaignLedgerOptions): Promise<SuccessorCampaignLedger> {
    const ownedOptions = { ...options }
    const durable = ownedOptions.offlineTestOnly !== true
    const validated = await validateRegistrationInputs(ownedOptions)
    const registration = await readRegistration(validated.successorRoot)
    if (!exactRegistration(registration, validated.registration))
      throw new SuccessorCampaignLedgerBlockedError(
        'Successor registration differs from current pins',
      )
    const storage = new AtomicJsonLedgerStore(
      join(validated.successorRoot, 'campaign-ledger.json'),
      durable,
    )
    const state = await storage.read((raw) => stateSchema.parse(raw))
    if (!state)
      throw new SuccessorCampaignLedgerBlockedError('Registered successor ledger is missing')
    assertState(state, registration)
    return new SuccessorCampaignLedger(validated.successorRoot, registration, state, storage)
  }

  snapshot(): CampaignLedgerSnapshotPort {
    return ledgerSnapshot(this.state)
  }

  assertResumeAllowed(): void {
    assertResumeState(this.state)
  }

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    let rollbackState: SuccessorLedgerState | undefined
    try {
      return await this.storage.transact(
        (raw) => stateSchema.parse(raw),
        async (latest) => {
          assertState(latest, this.registration)
          this.state = structuredClone(latest)
          rollbackState = structuredClone(this.state)
          try {
            const result = await operation()
            assertState(this.state, this.registration)
            this.state.ledgerVersion++
            return { next: this.state, result }
          } catch (error) {
            this.state = rollbackState
            throw error
          }
        },
      )
    } catch (error) {
      if (rollbackState) this.state = rollbackState
      throw error
    }
  }

  async recordLogicalAttempt(context?: LedgerLogicalAttemptContext): Promise<void> {
    return this.transaction(async () => {
      assertResumeState(this.state)
      if (!context || !allowedProfile(context.profileId) || !context.opaqueCaseId)
        throw new RangeError('Successor logical attempt requires a frozen case and profile')
      const identity = callIdentity(context)
      if (this.state.logicalAttempts.some((item) => callIdentity(item) === identity))
        throw new SuccessorCampaignLedgerBlockedError(
          'Successor logical case arm was already attempted',
        )
      if (this.state.logicalAttempts.length >= 80)
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 logical attempt ceiling reached')
      this.state.logicalAttempts.push({
        profileId: context.profileId,
        opaqueCaseId: context.opaqueCaseId,
      })
      this.state.logicalAttemptCount++
    })
  }

  async admitPhysical(reservedUsd: number, context?: LedgerPhysicalCallContext): Promise<number> {
    return this.transaction(async () => {
      assertResumeState(this.state)
      if (!context || !allowedProfile(context.profileId) || !context.opaqueCaseId)
        throw new RangeError('Successor physical admission requires a frozen case and profile')
      const expected = profileCost(context.profileId)
      if (!Number.isFinite(reservedUsd) || reservedUsd !== expected)
        throw new SuccessorCampaignLedgerBlockedError(
          'Physical reserve differs from the registered model bound',
        )
      const pending = this.state.inFlightReservations.length
      if (
        this.state.dev40ConfirmedPhysicalCalls + this.state.dev40UncertainPhysicalCalls + pending >=
        DEV40_SUCCESSOR_MAX_CALLS
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 physical call ceiling reached')
      const profileLimit = context.profileId === PROFILE_FLAT_CANDIDATE_ID ? 160 : 240
      if (
        profileCalls(this.state, context.profileId) +
          pendingForProfile(this.state, context.profileId) >=
        profileLimit
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 profile call ceiling reached')
      const caseLimit = context.profileId === PROFILE_FLAT_CANDIDATE_ID ? 4 : 6
      if (
        caseCalls(this.state, context.profileId, context.opaqueCaseId) +
          pendingForCaseProfile(this.state, context.profileId, context.opaqueCaseId) >=
        caseLimit
      )
        throw new SuccessorCampaignBudgetExhaustedError('Per-case profile call ceiling reached')
      const knownPossible =
        this.state.physicalDispatchCount + this.state.uncertainPhysicalDispatchCount + pending
      if (knownPossible >= SUCCESSOR_GLOBAL_MAX_CALLS)
        throw new SuccessorCampaignBudgetExhaustedError('Global physical call ceiling reached')
      if (
        exposure(this.state) + reservedUsd >
        baseExposure(this.registration) + SUCCESSOR_DEV40_MAX_INCREMENTAL_USD + 1e-9
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 technical exposure envelope reached')
      const reservationId = this.state.nextReservationId++
      const reservation: Reservation = {
        reservationId,
        reservedUsd,
        profileId: context.profileId,
        opaqueCaseId: context.opaqueCaseId,
        dispatchIntentRecorded: false,
        dispatched: false,
        physicalId: null,
      }
      this.state.inFlightReservations.push(reservation)
      return reservationId
    })
  }

  async recordDispatchIntent(reservationId: number): Promise<void> {
    return this.transaction(async () => {
      const item = this.state.inFlightReservations.find(
        (reservation) => reservation.reservationId === reservationId,
      )
      if (!item) throw new RangeError('Unknown successor reservation')
      if (item.dispatchIntentRecorded)
        throw new SuccessorCampaignLedgerBlockedError('Duplicate dispatch intent')
      item.dispatchIntentRecorded = true
    })
  }

  async markDispatched(reservationId: number): Promise<number> {
    return this.transaction(async () => {
      const item = this.state.inFlightReservations.find(
        (reservation) => reservation.reservationId === reservationId,
      )
      if (!item || !item.dispatchIntentRecorded)
        throw new RangeError('Successor fetch confirmation requires durable dispatch intent')
      if (item.dispatched) {
        if (item.physicalId === null)
          throw new RangeError('Confirmed reservation has no physical ID')
        return item.physicalId
      }
      item.dispatched = true
      item.physicalId = this.state.nextPhysicalId++
      this.state.physicalDispatchCount++
      this.state.dev40ConfirmedPhysicalCalls++
      const profile = this.state.profileCounters.find((row) => row.profileId === item.profileId)!
      profile.confirmedCalls++
      this.incrementCaseArm(item.profileId, item.opaqueCaseId)
      return item.physicalId
    })
  }

  async cancelBeforeFetch(reservationId: number): Promise<void> {
    return this.transaction(async () => {
      const index = this.state.inFlightReservations.findIndex(
        (item) => item.reservationId === reservationId,
      )
      if (index < 0) throw new RangeError('Unknown successor reservation')
      if (this.state.inFlightReservations[index]!.dispatched)
        throw new RangeError('Fetched successor request cannot be cancelled')
      this.state.inFlightReservations.splice(index, 1)
    })
  }

  async settle(reservationId: number, costUsd: number | null): Promise<void> {
    return this.transaction(async () => {
      const index = this.state.inFlightReservations.findIndex(
        (item) => item.reservationId === reservationId,
      )
      if (index < 0) throw new RangeError('Unknown successor reservation')
      const [item] = this.state.inFlightReservations.splice(index, 1)
      if (!item!.dispatched || item!.physicalId === null)
        throw new RangeError('Successor reservation cannot settle before fetch confirmation')
      if (
        costUsd === null ||
        !Number.isFinite(costUsd) ||
        costUsd < 0 ||
        costUsd > item!.reservedUsd
      ) {
        this.state.unknownReserveUsd += item!.reservedUsd
        this.state.dev40UnknownReserveUsd += item!.reservedUsd
        if (costUsd !== null && costUsd > item!.reservedUsd) this.state.integrityBlocked = true
      } else {
        this.state.knownCostUsd += costUsd
        this.state.dev40KnownCostUsd += costUsd
      }
    })
  }

  async markCrashWithPendingDispatch(): Promise<void> {
    return this.transaction(async () => {
      let ambiguous = false
      for (const item of this.state.inFlightReservations) {
        if (!item.dispatchIntentRecorded && !item.dispatched) continue
        ambiguous = true
        this.state.dev40UnknownReserveUsd += item.reservedUsd
        this.state.unknownReserveUsd += item.reservedUsd
        if (item.dispatched) continue
        this.state.uncertainPhysicalDispatchCount++
        this.state.dev40UncertainPhysicalCalls++
        const profile = this.state.profileCounters.find((row) => row.profileId === item.profileId)!
        profile.uncertainCalls++
        this.incrementCaseArm(item.profileId, item.opaqueCaseId)
        this.state.nextPhysicalId++
      }
      this.state.inFlightReservations = []
      if (ambiguous) {
        this.state.crashRecoveryLatched = true
        this.state.resumeBlocked = true
      }
    })
  }

  async assertCanAdmitPhysicalReservedUsd(
    reservedUsd: number,
    context?: LedgerPhysicalCallContext,
  ): Promise<void> {
    return this.transaction(async () => {
      assertResumeState(this.state)
      if (
        !context ||
        !allowedProfile(context.profileId) ||
        reservedUsd !== profileCost(context.profileId)
      )
        throw new SuccessorCampaignLedgerBlockedError(
          'Preflight reserve is not bound to the study profile',
        )
      if (
        this.state.dev40ConfirmedPhysicalCalls +
          this.state.dev40UncertainPhysicalCalls +
          this.state.inFlightReservations.length >=
        DEV40_SUCCESSOR_MAX_CALLS
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 physical call ceiling reached')
      if (
        exposure(this.state) + reservedUsd >
        baseExposure(this.registration) + SUCCESSOR_DEV40_MAX_INCREMENTAL_USD + 1e-9
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 technical exposure envelope reached')
    })
  }

  async assertStudyScopeCanAdmitPhysicalReservedUsd(
    profileId: H8aFreshProfileId,
    reservedUsd: number,
  ): Promise<void> {
    return this.transaction(async () => {
      assertResumeState(this.state)
      if (!allowedProfile(profileId) || reservedUsd !== profileCost(profileId))
        throw new SuccessorCampaignLedgerBlockedError(
          'Study preflight reserve is not bound to a registered model profile',
        )
      const profile = this.state.profileCounters.find((row) => row.profileId === profileId)!
      const profileLimit = profileId === PROFILE_FLAT_CANDIDATE_ID ? 160 : 240
      if (profile.confirmedCalls + profile.uncertainCalls >= profileLimit)
        throw new SuccessorCampaignBudgetExhaustedError('Successor profile call ceiling reached')
      if (
        this.state.dev40ConfirmedPhysicalCalls +
          this.state.dev40UncertainPhysicalCalls +
          this.state.inFlightReservations.length >=
        DEV40_SUCCESSOR_MAX_CALLS
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 physical call ceiling reached')
      if (
        this.state.physicalDispatchCount +
          this.state.uncertainPhysicalDispatchCount +
          this.state.inFlightReservations.length >=
        SUCCESSOR_GLOBAL_MAX_CALLS
      )
        throw new SuccessorCampaignBudgetExhaustedError('Global physical call ceiling reached')
      if (
        exposure(this.state) + reservedUsd >
        baseExposure(this.registration) + SUCCESSOR_DEV40_MAX_INCREMENTAL_USD + 1e-9
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 technical exposure envelope reached')
    })
  }

  async assertExposureAllowsAdditionalUsd(additionalUsd: number): Promise<void> {
    return this.transaction(async () => {
      assertResumeState(this.state)
      if (!Number.isFinite(additionalUsd) || additionalUsd < 0)
        throw new RangeError('Additional exposure must be finite and non-negative')
      if (
        exposure(this.state) + additionalUsd >
        baseExposure(this.registration) + SUCCESSOR_DEV40_MAX_INCREMENTAL_USD + 1e-9
      )
        throw new SuccessorCampaignBudgetExhaustedError('DEV40 technical exposure envelope reached')
    })
  }

  private incrementCaseArm(profileId: SuccessorProfileId, opaqueCaseId: string): void {
    const row = this.state.caseArmCounters.find(
      (item) => item.profileId === profileId && item.opaqueCaseId === opaqueCaseId,
    )
    if (row) row.calls++
    else this.state.caseArmCounters.push({ profileId, opaqueCaseId, calls: 1 })
  }
}

function pendingForProfile(state: SuccessorLedgerState, profileId: SuccessorProfileId): number {
  return state.inFlightReservations.filter((item) => item.profileId === profileId).length
}

function pendingForCaseProfile(
  state: SuccessorLedgerState,
  profileId: SuccessorProfileId,
  opaqueCaseId: string,
): number {
  return state.inFlightReservations.filter(
    (item) => item.profileId === profileId && item.opaqueCaseId === opaqueCaseId,
  ).length
}
