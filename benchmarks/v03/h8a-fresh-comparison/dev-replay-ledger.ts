import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
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
import {
  PROFILE_CONTROL_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_SCOPE_CANDIDATE_ID,
  PROFILE_NATIVE_PRESENCE_CANDIDATE_ID,
  PROFILE_NATIVE_SELECTOR_CANDIDATE_ID,
  QUAL120_WORST_CASE_PHYSICAL_CALLS,
} from './constants.js'
import type { H8aFreshProfileId } from './profiles.js'
import { AUTHORED_SCOPE_STUDY_ID, replayStudyPolicy } from './dev-replay-study-policy.js'
import type { ReplayStudyId, ReplayStudyPolicy } from './dev-replay-study-policy.js'
import { parseReplayJson, readPinnedReplayFile } from './dev-replay-files.js'

const REPLAY_GLOBAL_MAX_PHYSICAL_CALLS = 2_000 as const
const LEGACY_REPLAY_POLICY = replayStudyPolicy('provider-refusal-dev40-replay-v1')
export const REPLAY_CANDIDATE_MAX_USD = LEGACY_REPLAY_POLICY.candidateUsdPerDispatch
export const REPLAY_CONTROL_MAX_USD = LEGACY_REPLAY_POLICY.controlUsdPerDispatch

const profileSchema = z.union([
  z.literal(PROFILE_FLAT_CANDIDATE_ID),
  z.literal(PROFILE_SCOPE_CANDIDATE_ID),
  z.literal(PROFILE_NATIVE_PRESENCE_CANDIDATE_ID),
  z.literal(PROFILE_NATIVE_SELECTOR_CANDIDATE_ID),
  z.literal(PROFILE_CONTROL_ID),
])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const parentFields = {
  ledgerVersion: z.number().int().nonnegative(),
  nextReservationId: z.number().int().positive(),
  nextPhysicalId: z.number().int().positive(),
  physicalDispatchCount: z.number().int().nonnegative(),
  uncertainPhysicalDispatchCount: z.literal(0),
  logicalAttemptCount: z.number().int().nonnegative(),
  knownCostUsd: z.number().finite().nonnegative(),
  unknownReserveUsd: z.literal(0.24),
  inFlightReservations: z.array(z.unknown()).length(0),
  resumeBlocked: z.literal(false),
  crashRecoveryLatched: z.literal(false),
  integrityBlocked: z.literal(false),
}
const legacyParentSchema = z
  .object({
    schema: z.literal('h8a-ui-state-dev40-successor-ledger-v1'),
    ...parentFields,
    maxPhysicalCalls: z.literal(REPLAY_GLOBAL_MAX_PHYSICAL_CALLS),
  })
  .passthrough()
const linkedReplayParentSchema = z
  .object({
    schema: z.enum([
      'h8a-provider-refusal-replay-ledger-v1',
      'h8a-authored-scope-replay-ledger-v1',
      'h8a-native-presence-replay-ledger-v1',
    ]),
    ...parentFields,
    registrationSha256: digest,
  })
  .passthrough()
const linkedReplayParentRegistrationSchema = z
  .object({
    schema: z.enum([
      'h8a-provider-refusal-replay-registration-v1',
      'h8a-authored-scope-replay-registration-v1',
      'h8a-native-presence-replay-registration-v1',
      'h8a-native-selector-replay-registration-v1',
    ]),
    studyId: z.enum([
      'provider-refusal-dev40-replay-v1',
      'authored-scope-dev40-v1',
      'native-presence-flat-dev40-v1',
    ]),
    freezeId: z.enum([
      'h8a-provider-refusal-dev40-replay-20261101-v1',
      'h8a-authored-scope-dev40-20261101-v1',
      'h8a-native-presence-flat-dev40-20261101-v1',
      'h8a-native-selector-flat-dev40-20261101-v1',
    ]),
    protocolSha256: digest,
    parentAuditSha256: digest,
    parentLedgerSha256: digest,
    parentLedgerVersion: z.number().int().nonnegative(),
    canonicalRoot: z.string().min(1),
    caseIds: z.array(z.string().min(1)).length(40),
    maxPhysicalCalls: z.literal(REPLAY_GLOBAL_MAX_PHYSICAL_CALLS),
    dev40MaxPhysicalCalls: z.number().int().positive(),
    dev40MaxIncrementalUsd: z.number().finite().positive(),
    candidateMaxUsdPerDispatch: z.number().finite().positive(),
    controlMaxUsdPerDispatch: z.number().finite().positive(),
    ownerDollarCeilingUsd: z.null(),
    retries: z.literal(0),
    registrationSha256: digest,
  })
  .strict()
type VerifiedParentBaseline = Readonly<{
  schema: string
  ledgerVersion: number
  maxPhysicalCalls: typeof REPLAY_GLOBAL_MAX_PHYSICAL_CALLS
  nextReservationId: number
  nextPhysicalId: number
  physicalDispatchCount: number
  uncertainPhysicalDispatchCount: 0
  logicalAttemptCount: number
  knownCostUsd: number
  unknownReserveUsd: 0.24
  inFlightReservations: readonly []
  resumeBlocked: false
  crashRecoveryLatched: false
  integrityBlocked: false
}>

const registrationSchema = z
  .object({
    schema: z.enum([
      'h8a-provider-refusal-replay-registration-v1',
      'h8a-authored-scope-replay-registration-v1',
      'h8a-native-presence-replay-registration-v1',
      'h8a-native-selector-replay-registration-v1',
    ]),
    studyId: z.enum([
      'provider-refusal-dev40-replay-v1',
      'authored-scope-dev40-v1',
      'native-presence-flat-dev40-v1',
      'native-selector-flat-dev40-v1',
    ]),
    freezeId: z.enum([
      'h8a-provider-refusal-dev40-replay-20261101-v1',
      'h8a-authored-scope-dev40-20261101-v1',
      'h8a-native-presence-flat-dev40-20261101-v1',
      'h8a-native-selector-flat-dev40-20261101-v1',
    ]),
    protocolSha256: digest,
    parentAuditSha256: digest,
    parentLedgerSha256: digest,
    parentLedgerVersion: z.number().int().nonnegative(),
    canonicalRoot: z.string().min(1),
    caseIds: z.array(z.string().min(1)).length(40),
    maxPhysicalCalls: z.literal(REPLAY_GLOBAL_MAX_PHYSICAL_CALLS),
    dev40MaxPhysicalCalls: z.number().int().positive(),
    dev40MaxIncrementalUsd: z.number().finite().positive(),
    candidateMaxUsdPerDispatch: z.number().finite().positive(),
    controlMaxUsdPerDispatch: z.number().finite().positive(),
    ownerDollarCeilingUsd: z.null(),
    retries: z.literal(0),
    registrationSha256: digest,
  })
  .strict()

const reservationSchema = z
  .object({
    reservationId: z.number().int().positive(),
    profileId: profileSchema,
    opaqueCaseId: z.string().min(1),
    reservedUsd: z.number().finite().positive(),
    intent: z.boolean(),
    dispatched: z.boolean(),
    uncertain: z.boolean(),
    physicalId: z.number().int().positive().nullable(),
  })
  .strict()
const caseCountSchema = z
  .object({
    profileId: profileSchema,
    opaqueCaseId: z.string().min(1),
    physicalCalls: z.number().int().nonnegative(),
  })
  .strict()
const stateSchema = z
  .object({
    schema: z.enum([
      'h8a-provider-refusal-replay-ledger-v1',
      'h8a-authored-scope-replay-ledger-v1',
      'h8a-native-presence-replay-ledger-v1',
      'h8a-native-selector-replay-ledger-v1',
    ]),
    ledgerVersion: z.number().int().nonnegative(),
    registrationSha256: digest,
    nextReservationId: z.number().int().positive(),
    nextPhysicalId: z.number().int().positive(),
    physicalDispatchCount: z.number().int().nonnegative(),
    uncertainPhysicalDispatchCount: z.number().int().nonnegative(),
    logicalAttemptCount: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownReserveUsd: z.number().finite().nonnegative(),
    dev40PhysicalCalls: z.number().int().nonnegative(),
    dev40KnownCostUsd: z.number().finite().nonnegative(),
    dev40UnknownReserveUsd: z.number().finite().nonnegative(),
    caseCounts: z.array(caseCountSchema),
    logicalAttempts: z.array(
      z.object({ profileId: profileSchema, opaqueCaseId: z.string().min(1) }).strict(),
    ),
    inFlightReservations: z.array(reservationSchema),
    resumeBlocked: z.boolean(),
    crashRecoveryLatched: z.boolean(),
    integrityBlocked: z.boolean(),
  })
  .strict()
type Registration = z.infer<typeof registrationSchema>
type State = z.infer<typeof stateSchema>
const latestLedgerStates = new Map<string, State>()

class ProviderRefusalReplayLedgerError extends Error {
  readonly code = 'H8A_PROVIDER_REFUSAL_REPLAY_LEDGER'
  constructor(message: string) {
    super(message)
    this.name = 'ProviderRefusalReplayLedgerError'
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}
async function assertCanonicalDirectoryChain(path: string): Promise<void> {
  let current = resolve(path)
  while (true) {
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        throw new ProviderRefusalReplayLedgerError('Replay ledger path contains an alias')
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
function cost(profile: H8aFreshProfileId, policy: ReplayStudyPolicy): number {
  if (profile === policy.candidateProfileId) return policy.candidateUsdPerDispatch
  if (profile === policy.controlProfileId) return policy.controlUsdPerDispatch
  throw new ProviderRefusalReplayLedgerError('Profile is outside the replay ledger')
}
function supportedProfile(
  profile: H8aFreshProfileId,
  policy: ReplayStudyPolicy,
):
  | typeof PROFILE_FLAT_CANDIDATE_ID
  | typeof PROFILE_SCOPE_CANDIDATE_ID
  | typeof PROFILE_NATIVE_PRESENCE_CANDIDATE_ID
  | typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID
  | typeof PROFILE_CONTROL_ID
  | undefined {
  return profile === policy.candidateProfileId || profile === policy.controlProfileId
    ? profile
    : undefined
}
function perCaseLimit(profileId: string, policy: ReplayStudyPolicy): number {
  return profileId === policy.candidateProfileId
    ? policy.candidateCallsPerCase
    : policy.controlCallsPerCase
}
function assertRegistrationPolicy(registration: Registration, policy: ReplayStudyPolicy): void {
  if (
    registration.schema !== policy.registrationSchema ||
    registration.studyId !== policy.studyId ||
    registration.freezeId !== policy.freezeId ||
    registration.parentAuditSha256 !== policy.parentAuditSha256 ||
    registration.parentLedgerSha256 !== policy.parentLedgerSha256 ||
    registration.parentLedgerVersion !== policy.parentLedgerVersion ||
    registration.maxPhysicalCalls !== REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
    registration.dev40MaxPhysicalCalls !== policy.incrementalCallLimit ||
    registration.dev40MaxIncrementalUsd !== policy.incrementalExposureUsd ||
    registration.candidateMaxUsdPerDispatch !== policy.candidateUsdPerDispatch ||
    registration.controlMaxUsdPerDispatch !== policy.controlUsdPerDispatch
  )
    throw new ProviderRefusalReplayLedgerError('Registration differs from the closed study policy')
}
function assertState(state: State, registration: Registration, policy: ReplayStudyPolicy): void {
  const allowedCases = new Set(registration.caseIds)
  const undispatchedPending = state.inFlightReservations.filter(
    (item) => !item.dispatched && !item.uncertain,
  )
  const uncertainReservations = state.inFlightReservations.filter((item) => item.uncertain)
  if (
    state.registrationSha256 !== registration.registrationSha256 ||
    state.schema !== policy.ledgerSchema ||
    registration.schema !== policy.registrationSchema ||
    registration.studyId !== policy.studyId ||
    state.physicalDispatchCount !== policy.inheritedPhysicalCalls + state.dev40PhysicalCalls ||
    state.logicalAttemptCount !== policy.inheritedLogicalAttempts + state.logicalAttempts.length ||
    state.dev40PhysicalCalls > policy.incrementalCallLimit ||
    uncertainReservations.length !== state.uncertainPhysicalDispatchCount ||
    state.physicalDispatchCount +
      state.uncertainPhysicalDispatchCount +
      undispatchedPending.length >
      REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
    state.dev40PhysicalCalls + state.uncertainPhysicalDispatchCount + undispatchedPending.length >
      policy.incrementalCallLimit ||
    state.nextPhysicalId !==
      state.physicalDispatchCount + state.uncertainPhysicalDispatchCount + 1 ||
    state.knownCostUsd < policy.inheritedKnownCostUsd ||
    state.unknownReserveUsd < policy.inheritedUnknownReserveUsd ||
    (!state.integrityBlocked &&
      state.knownCostUsd +
        state.unknownReserveUsd +
        state.inFlightReservations.reduce((sum, item) => sum + item.reservedUsd, 0) >
        policy.inheritedKnownCostUsd +
          policy.inheritedUnknownReserveUsd +
          policy.incrementalExposureUsd +
          1e-9) ||
    Math.abs(state.knownCostUsd - policy.inheritedKnownCostUsd - state.dev40KnownCostUsd) > 1e-9 ||
    Math.abs(
      state.unknownReserveUsd - policy.inheritedUnknownReserveUsd - state.dev40UnknownReserveUsd,
    ) > 1e-9
  )
    throw new ProviderRefusalReplayLedgerError(
      'Ledger counters or registered limits do not reconcile',
    )
  const seen = new Set<string>()
  for (const row of state.caseCounts) {
    const key = `${row.profileId}\0${row.opaqueCaseId}`
    const pending = undispatchedPending.filter(
      (item) => item.profileId === row.profileId && item.opaqueCaseId === row.opaqueCaseId,
    ).length
    if (
      !allowedCases.has(row.opaqueCaseId) ||
      seen.has(key) ||
      row.physicalCalls + pending > perCaseLimit(row.profileId, policy)
    )
      throw new ProviderRefusalReplayLedgerError('Per-case physical dispatch ceiling exceeded')
    seen.add(key)
  }
  const logicalKeys = state.logicalAttempts.map((item) => `${item.profileId}\0${item.opaqueCaseId}`)
  if (new Set(logicalKeys).size !== logicalKeys.length)
    throw new ProviderRefusalReplayLedgerError(
      'Duplicate case-arm logical attempts are not allowed',
    )
  const pendingCounts = new Map<string, number>()
  for (const item of undispatchedPending) {
    const key = `${item.profileId}\0${item.opaqueCaseId}`
    pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1)
  }
  for (const item of uncertainReservations) {
    const key = `${item.profileId}\0${item.opaqueCaseId}`
    pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1)
  }
  for (const [key, pending] of pendingCounts) {
    const [profileId, opaqueCaseId] = key.split('\0')
    const calls =
      state.caseCounts.find(
        (row) => row.profileId === profileId && row.opaqueCaseId === opaqueCaseId,
      )?.physicalCalls ?? 0
    if (calls + pending > perCaseLimit(profileId ?? '', policy))
      throw new ProviderRefusalReplayLedgerError(
        'Per-case pending reservations exceed their ceiling',
      )
  }
  const ids = state.inFlightReservations.map((row) => row.reservationId)
  if (
    new Set(ids).size !== ids.length ||
    state.inFlightReservations.some(
      (row) =>
        row.reservedUsd !== cost(row.profileId, policy) ||
        (row.uncertain && (!row.intent || row.dispatched || row.physicalId !== null)),
    )
  )
    throw new ProviderRefusalReplayLedgerError('Reservation identity or bound is invalid')
  if (
    state.inFlightReservations.some((item) => !allowedCases.has(item.opaqueCaseId)) ||
    state.logicalAttempts.some((item) => !allowedCases.has(item.opaqueCaseId))
  )
    throw new ProviderRefusalReplayLedgerError(
      'Ledger contains a case outside the frozen 40-case cohort',
    )
}

function initialState(registration: Registration, policy: ReplayStudyPolicy): State {
  return stateSchema.parse({
    schema: policy.ledgerSchema,
    ledgerVersion: 0,
    registrationSha256: registration.registrationSha256,
    nextReservationId: policy.nextReservationId,
    nextPhysicalId: policy.nextPhysicalId,
    physicalDispatchCount: policy.inheritedPhysicalCalls,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: policy.inheritedLogicalAttempts,
    knownCostUsd: policy.inheritedKnownCostUsd,
    unknownReserveUsd: policy.inheritedUnknownReserveUsd,
    dev40PhysicalCalls: 0,
    dev40KnownCostUsd: 0,
    dev40UnknownReserveUsd: 0,
    caseCounts: [],
    logicalAttempts: [],
    inFlightReservations: [],
    resumeBlocked: false,
    crashRecoveryLatched: false,
    integrityBlocked: false,
  })
}

function assertParentBaseline(parent: VerifiedParentBaseline, policy: ReplayStudyPolicy): void {
  if (
    parent.ledgerVersion !== policy.parentLedgerVersion ||
    parent.maxPhysicalCalls !== REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
    parent.nextReservationId !== policy.nextReservationId ||
    parent.nextPhysicalId !== policy.nextPhysicalId ||
    parent.physicalDispatchCount !== policy.inheritedPhysicalCalls ||
    parent.logicalAttemptCount !== policy.inheritedLogicalAttempts ||
    parent.knownCostUsd !== policy.inheritedKnownCostUsd ||
    parent.unknownReserveUsd !== policy.inheritedUnknownReserveUsd ||
    parent.uncertainPhysicalDispatchCount !== 0 ||
    parent.inFlightReservations.length !== 0 ||
    parent.resumeBlocked ||
    parent.crashRecoveryLatched ||
    parent.integrityBlocked
  )
    throw new ProviderRefusalReplayLedgerError(
      'Pinned parent ledger baseline differs from registry',
    )
}

function parentRegistrationDigest(registration: Record<string, unknown>): string {
  const entries = Object.entries(registration).filter(([key]) => key !== 'registrationSha256')
  if (Object.keys(registration).at(-1) !== 'registrationSha256')
    throw new ProviderRefusalReplayLedgerError('Pinned parent registration wire order is invalid')
  return sha256(JSON.stringify(Object.fromEntries(entries)))
}

function verifyAuthoredScopeParentPair(
  parentValue: unknown,
  registrationValue: unknown,
  policy: ReplayStudyPolicy,
): VerifiedParentBaseline {
  const parent = linkedReplayParentSchema.parse(parentValue)
  const rawRegistration = z.record(z.unknown()).parse(registrationValue)
  const registration = linkedReplayParentRegistrationSchema.parse(registrationValue)
  if (!policy.parentRegistrationStudyId || !policy.parentRegistrationPath)
    throw new ProviderRefusalReplayLedgerError('Parent registration wire pair is not registered')
  const parentPolicy = replayStudyPolicy(policy.parentRegistrationStudyId)
  if (
    parent.schema !== policy.parentLedgerSchema ||
    registration.schema !== policy.parentRegistrationSchema ||
    registration.studyId !== policy.parentRegistrationStudyId ||
    registration.freezeId !== policy.parentRegistrationFreezeId ||
    registration.canonicalRoot !== dirname(policy.parentRegistrationPath) ||
    registration.parentAuditSha256 !== parentPolicy.parentAuditSha256 ||
    registration.parentLedgerSha256 !== parentPolicy.parentLedgerSha256 ||
    registration.parentLedgerVersion !== parentPolicy.parentLedgerVersion ||
    new Set(registration.caseIds).size !== registration.caseIds.length ||
    registration.maxPhysicalCalls !== REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
    registration.dev40MaxPhysicalCalls !== parentPolicy.incrementalCallLimit ||
    registration.dev40MaxIncrementalUsd !== parentPolicy.incrementalExposureUsd ||
    registration.candidateMaxUsdPerDispatch !== parentPolicy.candidateUsdPerDispatch ||
    registration.controlMaxUsdPerDispatch !== parentPolicy.controlUsdPerDispatch ||
    parent.registrationSha256 !== registration.registrationSha256 ||
    parent.registrationSha256 !== parentRegistrationDigest(rawRegistration) ||
    Object.hasOwn(parent, 'maxPhysicalCalls')
  )
    throw new ProviderRefusalReplayLedgerError('Pinned parent registration and ledger do not match')
  const verified: VerifiedParentBaseline = {
    schema: parent.schema,
    ledgerVersion: parent.ledgerVersion,
    maxPhysicalCalls: registration.maxPhysicalCalls,
    nextReservationId: parent.nextReservationId,
    nextPhysicalId: parent.nextPhysicalId,
    physicalDispatchCount: parent.physicalDispatchCount,
    uncertainPhysicalDispatchCount: parent.uncertainPhysicalDispatchCount,
    logicalAttemptCount: parent.logicalAttemptCount,
    knownCostUsd: parent.knownCostUsd,
    unknownReserveUsd: parent.unknownReserveUsd,
    inFlightReservations: [],
    resumeBlocked: parent.resumeBlocked,
    crashRecoveryLatched: parent.crashRecoveryLatched,
    integrityBlocked: parent.integrityBlocked,
  }
  assertParentBaseline(verified, policy)
  return verified
}

/** Validates the closed authored-scope parent wire pair without reading or writing files. */
export function validateAuthoredScopeReplayParentPair(
  parentValue: unknown,
  registrationValue: unknown,
  studyId: ReplayStudyId,
): Readonly<{
  ledgerVersion: number
  physicalDispatchCount: number
  logicalAttemptCount: number
  knownCostUsd: number
  unknownReserveUsd: number
  maxPhysicalCalls: number
  nextPhysicalId: number
  nextReservationId: number
}> {
  const policy = replayStudyPolicy(studyId)
  if (
    studyId !== 'authored-scope-dev40-v1' &&
    studyId !== 'native-presence-flat-dev40-v1' &&
    studyId !== 'native-selector-flat-dev40-v1'
  )
    throw new ProviderRefusalReplayLedgerError('Parent registration wire pair is not registered')
  const parent = verifyAuthoredScopeParentPair(parentValue, registrationValue, policy)
  return Object.freeze({
    ledgerVersion: parent.ledgerVersion,
    physicalDispatchCount: parent.physicalDispatchCount,
    logicalAttemptCount: parent.logicalAttemptCount,
    knownCostUsd: parent.knownCostUsd,
    unknownReserveUsd: parent.unknownReserveUsd,
    maxPhysicalCalls: parent.maxPhysicalCalls,
    nextPhysicalId: parent.nextPhysicalId,
    nextReservationId: parent.nextReservationId,
  })
}

/** Read-only validation of the live V5 DEV40 registration/ledger at QUAL admission. */
export function validateNativeSelectorDev40LedgerForQual(
  parentValue: unknown,
  registrationValue: unknown,
  expected: { protocolSha256: string; caseIds: readonly string[] },
): Readonly<{
  ledgerVersion: number
  physicalDispatchCount: number
  uncertainPhysicalDispatchCount: number
  logicalAttemptCount: number
  knownCostUsd: number
  unknownReserveUsd: number
  nextPhysicalId: number
  nextReservationId: number
  maxPhysicalCalls: number
  dev40PhysicalCalls: number
  dev40KnownCostUsd: number
  dev40UnknownReserveUsd: number
  caseCounts: readonly Readonly<{
    profileId: string
    opaqueCaseId: string
    physicalCalls: number
  }>[]
  logicalAttempts: readonly Readonly<{ profileId: string; opaqueCaseId: string }>[]
}> {
  const policy = replayStudyPolicy('native-selector-flat-dev40-v1')
  const rawRegistration = z.record(z.unknown()).parse(registrationValue)
  const registration = registrationSchema.parse(registrationValue)
  const parent = stateSchema.parse(parentValue)
  assertRegistrationPolicy(registration, policy)
  assertState(parent, registration, policy)
  if (
    registration.studyId !== 'native-selector-flat-dev40-v1' ||
    registration.freezeId !== 'h8a-native-selector-flat-dev40-20261101-v1' ||
    registration.canonicalRoot !==
      resolve(policy.canonicalRoot, 'admission', 'successor-campaign') ||
    registration.caseIds.length !== 40 ||
    new Set(registration.caseIds).size !== 40 ||
    registration.protocolSha256 !== expected.protocolSha256 ||
    expected.caseIds.length !== 40 ||
    registration.caseIds.some((caseId, index) => caseId !== expected.caseIds[index]) ||
    registration.maxPhysicalCalls !== REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
    parent.schema !== policy.ledgerSchema ||
    parent.registrationSha256 !== registration.registrationSha256 ||
    parent.registrationSha256 !== parentRegistrationDigest(rawRegistration) ||
    parent.uncertainPhysicalDispatchCount !== 0 ||
    parent.inFlightReservations.length !== 0 ||
    parent.resumeBlocked ||
    parent.crashRecoveryLatched ||
    parent.integrityBlocked ||
    parent.physicalDispatchCount + QUAL120_WORST_CASE_PHYSICAL_CALLS > registration.maxPhysicalCalls
  )
    throw new ProviderRefusalReplayLedgerError(
      'Native-selector DEV40 registration/ledger cannot admit the QUAL120 successor',
    )
  return Object.freeze({
    ledgerVersion: parent.ledgerVersion,
    physicalDispatchCount: parent.physicalDispatchCount,
    uncertainPhysicalDispatchCount: parent.uncertainPhysicalDispatchCount,
    logicalAttemptCount: parent.logicalAttemptCount,
    knownCostUsd: parent.knownCostUsd,
    unknownReserveUsd: parent.unknownReserveUsd,
    nextPhysicalId: parent.nextPhysicalId,
    nextReservationId: parent.nextReservationId,
    maxPhysicalCalls: registration.maxPhysicalCalls,
    dev40PhysicalCalls: parent.dev40PhysicalCalls,
    dev40KnownCostUsd: parent.dev40KnownCostUsd,
    dev40UnknownReserveUsd: parent.dev40UnknownReserveUsd,
    caseCounts: Object.freeze(parent.caseCounts.map((row) => Object.freeze({ ...row }))),
    logicalAttempts: Object.freeze(parent.logicalAttempts.map((row) => Object.freeze({ ...row }))),
  })
}

async function readParentLedger(
  offlineTestOnly: boolean,
  policy: ReplayStudyPolicy,
): Promise<VerifiedParentBaseline> {
  if (offlineTestOnly) {
    const parent = {
      schema:
        policy.studyId === LEGACY_REPLAY_POLICY.studyId
          ? 'h8a-ui-state-dev40-successor-ledger-v1'
          : policy.parentLedgerSchema,
      ...(policy.studyId === LEGACY_REPLAY_POLICY.studyId
        ? { maxPhysicalCalls: REPLAY_GLOBAL_MAX_PHYSICAL_CALLS }
        : {}),
      ledgerVersion: policy.parentLedgerVersion,
      ...(policy.studyId === LEGACY_REPLAY_POLICY.studyId
        ? {}
        : { registrationSha256: '0'.repeat(64) }),
      nextReservationId: policy.nextReservationId,
      nextPhysicalId: policy.nextPhysicalId,
      physicalDispatchCount: policy.inheritedPhysicalCalls,
      uncertainPhysicalDispatchCount: 0,
      logicalAttemptCount: policy.inheritedLogicalAttempts,
      knownCostUsd: policy.inheritedKnownCostUsd,
      unknownReserveUsd: policy.inheritedUnknownReserveUsd,
      inFlightReservations: [],
      resumeBlocked: false,
      crashRecoveryLatched: false,
      integrityBlocked: false,
    }
    if (policy.studyId === LEGACY_REPLAY_POLICY.studyId) {
      const parsed = legacyParentSchema.parse(parent)
      const verified: VerifiedParentBaseline = { ...parsed, inFlightReservations: [] }
      assertParentBaseline(verified, policy)
      return verified
    }
    if (!policy.parentRegistrationStudyId || !policy.parentRegistrationPath)
      throw new ProviderRefusalReplayLedgerError('Parent registration wire pair is not registered')
    const parentPolicy = replayStudyPolicy(policy.parentRegistrationStudyId)
    const parentRegistrationBody = {
      schema: parentPolicy.registrationSchema,
      studyId: parentPolicy.studyId,
      freezeId: parentPolicy.freezeId,
      protocolSha256: '0'.repeat(64),
      parentAuditSha256: parentPolicy.parentAuditSha256,
      parentLedgerSha256: parentPolicy.parentLedgerSha256,
      parentLedgerVersion: parentPolicy.parentLedgerVersion,
      canonicalRoot: dirname(policy.parentRegistrationPath),
      caseIds: Array.from({ length: 40 }, (_, index) => `offline-case-${index}`),
      maxPhysicalCalls: REPLAY_GLOBAL_MAX_PHYSICAL_CALLS,
      dev40MaxPhysicalCalls: parentPolicy.incrementalCallLimit,
      dev40MaxIncrementalUsd: parentPolicy.incrementalExposureUsd,
      candidateMaxUsdPerDispatch: parentPolicy.candidateUsdPerDispatch,
      controlMaxUsdPerDispatch: parentPolicy.controlUsdPerDispatch,
      ownerDollarCeilingUsd: null,
      retries: 0,
    }
    const syntheticRegistration = {
      ...parentRegistrationBody,
      registrationSha256: sha256(JSON.stringify(parentRegistrationBody)),
    }
    const linkedParent = { ...parent, registrationSha256: syntheticRegistration.registrationSha256 }
    return verifyAuthoredScopeParentPair(linkedParent, syntheticRegistration, policy)
  }
  const auditBytes = await readPinnedReplayFile(policy.parentAuditPath, policy.parentAuditSha256)
  const parsedAudit = parseReplayJson(auditBytes)
  const selectorAudit =
    policy.studyId === 'native-selector-flat-dev40-v1'
      ? z
          .object({
            schema: z.literal('main-native-selector-prospective-parent-audit-v1'),
            parentStudyId: z.literal('native-presence-flat-dev40-v1'),
            parentClosed: z.literal(true),
            parentReviewDecision: z.literal('stop'),
            parentPhysicalDispatchCount: z.literal(317),
            parentCaseArmAttempts: z.literal(103),
            parentKnownCostUsd: z.literal(0.19184451499999994),
            parentUnknownReserveUsd: z.literal(0.24),
            globalPhysicalCallLimit: z.literal(REPLAY_GLOBAL_MAX_PHYSICAL_CALLS),
            refs: z
              .array(
                z
                  .object({
                    path: z.string().min(1),
                    sha256: digest,
                    bytes: z.number().int().positive(),
                  })
                  .strict(),
              )
              .length(14),
          })
          .passthrough()
          .parse(parsedAudit)
      : undefined
  const audit = selectorAudit
    ? { references: selectorAudit.refs }
    : z
        .object({
          references:
            policy.studyId === 'native-presence-flat-dev40-v1'
              ? z
                  .array(
                    z
                      .object({
                        path: z.string().min(1),
                        sha256: digest,
                        bytes: z.number().int().positive(),
                      })
                      .strict(),
                  )
                  .length(15)
              : z.array(z.object({ path: z.string(), sha256: digest }).strict()),
        })
        .passthrough()
        .parse(parsedAudit)
  const ref = audit.references.find((row) => row.path === policy.parentLedgerPath)
  if (!ref || ref.sha256 !== policy.parentLedgerSha256)
    throw new ProviderRefusalReplayLedgerError('Pinned parent ledger reference is missing')
  const bytes = await readPinnedReplayFile(ref.path, ref.sha256, 4 * 1024 * 1024)
  if ('bytes' in ref && bytes.byteLength !== ref.bytes)
    throw new ProviderRefusalReplayLedgerError(
      'Pinned parent ledger byte length differs from audit',
    )
  if (policy.studyId === LEGACY_REPLAY_POLICY.studyId) {
    const parent = legacyParentSchema.parse(parseReplayJson(bytes))
    const verified: VerifiedParentBaseline = { ...parent, inFlightReservations: [] }
    assertParentBaseline(verified, policy)
    return verified
  }
  if (
    policy.studyId !== AUTHORED_SCOPE_STUDY_ID &&
    policy.studyId !== 'native-presence-flat-dev40-v1' &&
    policy.studyId !== 'native-selector-flat-dev40-v1'
  )
    throw new ProviderRefusalReplayLedgerError('Parent registration wire pair is not registered')
  const registrationRef = audit.references.find((row) => row.path === policy.parentRegistrationPath)
  if (!registrationRef || registrationRef.sha256 !== policy.parentRegistrationSha256)
    throw new ProviderRefusalReplayLedgerError('Pinned parent registration reference is missing')
  const registrationBytes = await readPinnedReplayFile(
    registrationRef.path,
    registrationRef.sha256,
    64 * 1024,
  )
  if ('bytes' in registrationRef && registrationBytes.byteLength !== registrationRef.bytes)
    throw new ProviderRefusalReplayLedgerError(
      'Pinned parent registration byte length differs from audit',
    )
  return verifyAuthoredScopeParentPair(
    parseReplayJson(bytes),
    parseReplayJson(registrationBytes),
    policy,
  )
}

export class DevReplayLedger implements SuccessorCampaignAdmissionPort {
  private constructor(
    private readonly root: string,
    private readonly policy: ReplayStudyPolicy,
    private readonly registration: Registration,
    private state: State,
    private readonly store = new AtomicJsonLedgerStore(join(root, 'campaign-ledger.json'), true),
  ) {}
  /** Reads and validates the closed, pinned parent state without creating or changing files. */
  static async preflightParent(studyId: ReplayStudyId): Promise<
    Readonly<{
      ledgerVersion: number
      physicalDispatchCount: number
      logicalAttemptCount: number
      knownCostUsd: number
      unknownReserveUsd: number
      maxPhysicalCalls: number
      nextPhysicalId: number
      nextReservationId: number
    }>
  > {
    const policy = replayStudyPolicy(studyId)
    const parent = await readParentLedger(false, policy)
    return Object.freeze({
      ledgerVersion: parent.ledgerVersion,
      physicalDispatchCount: parent.physicalDispatchCount,
      logicalAttemptCount: parent.logicalAttemptCount,
      knownCostUsd: parent.knownCostUsd,
      unknownReserveUsd: parent.unknownReserveUsd,
      maxPhysicalCalls: parent.maxPhysicalCalls,
      nextPhysicalId: parent.nextPhysicalId,
      nextReservationId: parent.nextReservationId,
    })
  }
  static async register(options: {
    root?: string
    offlineTestOnly?: boolean
    studyId: ReplayStudyId
    protocolSha256: string
    caseIds: readonly string[]
  }): Promise<DevReplayLedger> {
    const requestedRoot = options.root
    const offlineTestOnly = options.offlineTestOnly === true
    const policy = replayStudyPolicy(options.studyId)
    const protocolSha256 = digest.parse(options.protocolSha256)
    const caseIds = [...options.caseIds]
    const root = resolve(
      requestedRoot ?? join(policy.canonicalRoot, 'admission', 'successor-campaign'),
    )
    const canonicalRoot = resolve(policy.canonicalRoot, 'admission', 'successor-campaign')
    if (
      offlineTestOnly
        ? root === canonicalRoot ||
          basename(resolve(root, '..', '..')) !== basename(policy.canonicalRoot)
        : root !== canonicalRoot
    )
      throw new ProviderRefusalReplayLedgerError(
        'Replay ledger must use the canonical new namespace',
      )
    if (
      caseIds.length !== 40 ||
      caseIds.some((caseId) => typeof caseId !== 'string' || caseId.length === 0) ||
      new Set(caseIds).size !== 40
    )
      throw new ProviderRefusalReplayLedgerError('Registration must bind 40 unique frozen case IDs')
    const parent = offlineTestOnly
      ? await readParentLedger(true, policy)
      : await DevReplayLedger.preflightParent(policy.studyId)
    const body = {
      schema: policy.registrationSchema,
      studyId: policy.studyId,
      freezeId: policy.freezeId,
      protocolSha256,
      parentAuditSha256: policy.parentAuditSha256,
      parentLedgerSha256: policy.parentLedgerSha256,
      parentLedgerVersion: parent.ledgerVersion,
      canonicalRoot: root,
      caseIds,
      maxPhysicalCalls: REPLAY_GLOBAL_MAX_PHYSICAL_CALLS,
      dev40MaxPhysicalCalls: policy.incrementalCallLimit,
      dev40MaxIncrementalUsd: policy.incrementalExposureUsd,
      candidateMaxUsdPerDispatch: policy.candidateUsdPerDispatch,
      controlMaxUsdPerDispatch: policy.controlUsdPerDispatch,
      ownerDollarCeilingUsd: null,
      retries: 0 as const,
    }
    const registration = registrationSchema.parse({
      ...body,
      registrationSha256: sha256(JSON.stringify(body)),
    })
    assertRegistrationPolicy(registration, policy)
    await assertCanonicalDirectoryChain(dirname(root))
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    const rootParentInfo = await lstat(dirname(root))
    if (
      !rootParentInfo.isDirectory() ||
      rootParentInfo.isSymbolicLink() ||
      (await realpath(dirname(root))) !== dirname(root)
    )
      throw new ProviderRefusalReplayLedgerError('Replay ledger parent is not canonical')
    const unlock = await acquireExclusiveFileLock(`${root}.registration.lock`, true)
    try {
      await mkdir(root, { recursive: false, mode: 0o700 }).catch(async (error: unknown) => {
        if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
      })
      const rootInfo = await lstat(root)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(root)) !== root)
        throw new ProviderRefusalReplayLedgerError('Replay ledger root is not canonical')
      const registrationPath = join(root, 'registration.json')
      let existing: Registration | undefined
      try {
        existing = registrationSchema.parse(
          JSON.parse(await readFile(registrationPath, 'utf8')) as unknown,
        )
      } catch (error) {
        if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      }
      if (existing && JSON.stringify(existing) !== JSON.stringify(registration))
        throw new ProviderRefusalReplayLedgerError(
          'Namespace is already bound to different protocol',
        )
      const store = new AtomicJsonLedgerStore(join(root, 'campaign-ledger.json'), true)
      const initial = initialState(registration, policy)
      let state = await store.read((raw) => stateSchema.parse(raw))
      if (existing && !state)
        throw new ProviderRefusalReplayLedgerError('Registered ledger file is missing')
      if (state && !existing && JSON.stringify(state) !== JSON.stringify(initial))
        throw new ProviderRefusalReplayLedgerError(
          'Unregistered ledger contains progressed or foreign state',
        )
      if (!state) {
        const contents = await readdir(root)
        if (contents.length)
          throw new ProviderRefusalReplayLedgerError(
            'Unregistered ledger root contains unknown files',
          )
        state = await store.openOrCreate((raw) => stateSchema.parse(raw), initial)
      }
      if (!existing) {
        const contents = await readdir(root)
        if (contents.some((item) => item !== 'campaign-ledger.json'))
          throw new ProviderRefusalReplayLedgerError(
            'Unregistered ledger root contains unknown files',
          )
        await atomicWriteJsonFile(registrationPath, registration, true)
      }
      assertState(state, registration, policy)
      const cached = latestLedgerStates.get(root)
      if (!cached || state.ledgerVersion >= cached.ledgerVersion)
        latestLedgerStates.set(root, structuredClone(state))
      return new DevReplayLedger(root, policy, registration, state, store)
    } finally {
      await unlock()
    }
  }
  snapshot(): CampaignLedgerSnapshotPort {
    const latest = latestLedgerStates.get(this.root)
    if (latest && latest.ledgerVersion >= this.state.ledgerVersion)
      this.state = structuredClone(latest)
    return {
      physicalDispatchCount: this.state.physicalDispatchCount,
      logicalAttemptCount: this.state.logicalAttemptCount,
      knownCostUsd: this.state.knownCostUsd,
      unknownReserveUsd: this.state.unknownReserveUsd,
      inFlightReservations: this.state.inFlightReservations.map(
        ({ reservationId, reservedUsd }) => ({ reservationId, reservedUsd }),
      ),
      resumeBlocked:
        this.state.resumeBlocked ||
        this.state.crashRecoveryLatched ||
        this.state.integrityBlocked ||
        this.state.inFlightReservations.length > 0,
    }
  }
  uncertainDispatchCount(): number {
    const latest = latestLedgerStates.get(this.root)
    if (latest && latest.ledgerVersion >= this.state.ledgerVersion)
      this.state = structuredClone(latest)
    return this.state.uncertainPhysicalDispatchCount
  }
  assertResumeAllowed(): void {
    if (this.snapshot().resumeBlocked)
      throw new ProviderRefusalReplayLedgerError(
        'Replay ledger has unresolved work and cannot resume',
      )
  }
  private async transact<T>(operation: (state: State) => T): Promise<T> {
    let committedState: State | undefined
    const result = await this.store.transact(
      (raw) => stateSchema.parse(raw),
      async (latest) => {
        assertState(latest, this.registration, this.policy)
        const next = structuredClone(latest)
        const value = operation(next)
        next.ledgerVersion++
        assertState(next, this.registration, this.policy)
        committedState = structuredClone(next)
        return { next, result: value }
      },
    )
    if (!committedState)
      throw new ProviderRefusalReplayLedgerError('Ledger transaction did not produce state')
    const latest = latestLedgerStates.get(this.root)
    if (!latest || committedState.ledgerVersion >= latest.ledgerVersion)
      latestLedgerStates.set(this.root, committedState)
    this.state = structuredClone(latestLedgerStates.get(this.root) ?? committedState)
    return result
  }
  async recordLogicalAttempt(context?: LedgerLogicalAttemptContext): Promise<void> {
    if (!context)
      throw new ProviderRefusalReplayLedgerError(
        'Logical attempts require an explicit case and profile',
      )
    const profileId = supportedProfile(context.profileId, this.policy)
    if (!profileId)
      throw new ProviderRefusalReplayLedgerError('Profile is outside the replay ledger')
    await this.transact((state) => {
      if (state.resumeBlocked || state.crashRecoveryLatched || state.integrityBlocked)
        throw new ProviderRefusalReplayLedgerError('Replay ledger is blocked')
      if (
        !this.registration.caseIds.includes(context.opaqueCaseId) ||
        state.logicalAttempts.some(
          (item) => item.profileId === profileId && item.opaqueCaseId === context.opaqueCaseId,
        )
      )
        throw new ProviderRefusalReplayLedgerError(
          'Case-arm logical attempt is foreign or already recorded',
        )
      state.logicalAttempts.push({ profileId, opaqueCaseId: context.opaqueCaseId })
      state.logicalAttemptCount++
    })
  }
  async admitPhysical(reservedUsd: number, context?: LedgerPhysicalCallContext): Promise<number> {
    if (!context || reservedUsd !== cost(context.profileId, this.policy))
      throw new ProviderRefusalReplayLedgerError(
        'Physical reservation is not bound to the explicit profile and case',
      )
    return this.transact((state) => {
      if (state.resumeBlocked || state.crashRecoveryLatched || state.integrityBlocked)
        throw new ProviderRefusalReplayLedgerError('Replay ledger is blocked')
      if (!this.registration.caseIds.includes(context.opaqueCaseId))
        throw new ProviderRefusalReplayLedgerError(
          'Physical request case is outside the frozen cohort',
        )
      const calls =
        state.caseCounts.find(
          (row) => row.profileId === context.profileId && row.opaqueCaseId === context.opaqueCaseId,
        )?.physicalCalls ?? 0
      const pending = state.inFlightReservations.filter(
        (row) =>
          !row.dispatched &&
          row.profileId === context.profileId &&
          row.opaqueCaseId === context.opaqueCaseId,
      ).length
      if (calls + pending >= perCaseLimit(context.profileId, this.policy))
        throw new ProviderRefusalReplayLedgerError('Per-case physical dispatch ceiling reached')
      if (
        state.physicalDispatchCount +
          state.uncertainPhysicalDispatchCount +
          state.inFlightReservations.filter((item) => !item.dispatched).length >=
          REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
        state.dev40PhysicalCalls +
          state.uncertainPhysicalDispatchCount +
          state.inFlightReservations.filter((item) => !item.dispatched).length >=
          this.policy.incrementalCallLimit
      )
        throw new ProviderRefusalReplayLedgerError('Physical call budget exhausted')
      if (
        state.knownCostUsd +
          state.unknownReserveUsd +
          state.inFlightReservations.reduce((sum, item) => sum + item.reservedUsd, 0) +
          reservedUsd >
        this.policy.inheritedKnownCostUsd +
          this.policy.inheritedUnknownReserveUsd +
          this.policy.incrementalExposureUsd +
          1e-9
      )
        throw new ProviderRefusalReplayLedgerError('DEV40 technical exposure cap reached')
      const id = state.nextReservationId++
      const profileId = supportedProfile(context.profileId, this.policy)
      if (!profileId)
        throw new ProviderRefusalReplayLedgerError('Profile is outside the replay ledger')
      state.inFlightReservations.push({
        reservationId: id,
        profileId,
        opaqueCaseId: context.opaqueCaseId,
        reservedUsd,
        intent: false,
        dispatched: false,
        uncertain: false,
        physicalId: null,
      })
      return id
    })
  }
  async recordDispatchIntent(reservationId: number): Promise<void> {
    await this.transact((state) => {
      const item = state.inFlightReservations.find((row) => row.reservationId === reservationId)
      if (!item || item.intent || item.dispatched)
        throw new ProviderRefusalReplayLedgerError('Dispatch intent is invalid')
      item.intent = true
    })
  }
  async markDispatched(reservationId: number): Promise<number> {
    return this.transact((state) => {
      const item = state.inFlightReservations.find((row) => row.reservationId === reservationId)
      if (!item || !item.intent || item.dispatched)
        throw new ProviderRefusalReplayLedgerError('Dispatch confirmation is invalid')
      if (item.uncertain)
        throw new ProviderRefusalReplayLedgerError('Uncertain reservation cannot be confirmed')
      item.dispatched = true
      item.physicalId = state.nextPhysicalId++
      state.physicalDispatchCount++
      state.dev40PhysicalCalls++
      const row = state.caseCounts.find(
        (candidate) =>
          candidate.profileId === item.profileId && candidate.opaqueCaseId === item.opaqueCaseId,
      )
      if (row) row.physicalCalls++
      else
        state.caseCounts.push({
          profileId: item.profileId,
          opaqueCaseId: item.opaqueCaseId,
          physicalCalls: 1,
        })
      return item.physicalId
    })
  }
  async cancelBeforeFetch(reservationId: number): Promise<void> {
    await this.transact((state) => {
      const index = state.inFlightReservations.findIndex(
        (row) => row.reservationId === reservationId,
      )
      const item = state.inFlightReservations[index]
      if (!item || item.dispatched)
        throw new ProviderRefusalReplayLedgerError('Only a prefetch reservation can be cancelled')
      state.inFlightReservations.splice(index, 1)
    })
  }
  async settle(reservationId: number, costUsd: number | null): Promise<void> {
    await this.transact((state) => {
      const index = state.inFlightReservations.findIndex(
        (row) => row.reservationId === reservationId,
      )
      const item = state.inFlightReservations[index]
      if (!item || !item.dispatched)
        throw new ProviderRefusalReplayLedgerError('Only a confirmed physical dispatch can settle')
      state.inFlightReservations.splice(index, 1)
      if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) {
        state.unknownReserveUsd += item.reservedUsd
        state.dev40UnknownReserveUsd += item.reservedUsd
      } else {
        state.knownCostUsd += costUsd
        state.dev40KnownCostUsd += costUsd
        if (costUsd > item.reservedUsd + 1e-9) state.integrityBlocked = true
      }
    })
  }
  async markCrashWithPendingDispatch(): Promise<void> {
    await this.transact((state) => {
      const ambiguous = state.inFlightReservations.filter(
        (row) => row.intent && !row.dispatched && !row.uncertain,
      )
      if (ambiguous.length > 0) {
        for (const item of ambiguous) {
          item.uncertain = true
          state.uncertainPhysicalDispatchCount++
          state.nextPhysicalId++
        }
        state.crashRecoveryLatched = true
        state.resumeBlocked = true
      } else if (state.inFlightReservations.some((row) => row.intent)) {
        state.crashRecoveryLatched = true
        state.resumeBlocked = true
      }
    })
  }
  async assertCanAdmitPhysicalReservedUsd(
    reservedUsd: number,
    context?: LedgerPhysicalCallContext,
  ): Promise<void> {
    if (!context || reservedUsd !== cost(context.profileId, this.policy))
      throw new ProviderRefusalReplayLedgerError('Reservation does not match the explicit profile')
    const state = await this.store.read((raw) => stateSchema.parse(raw))
    if (!state) throw new ProviderRefusalReplayLedgerError('Ledger is missing')
    assertState(state, this.registration, this.policy)
    if (state.resumeBlocked || state.crashRecoveryLatched || state.integrityBlocked)
      throw new ProviderRefusalReplayLedgerError('Replay ledger is blocked')
    const calls =
      state.caseCounts.find(
        (row) => row.profileId === context.profileId && row.opaqueCaseId === context.opaqueCaseId,
      )?.physicalCalls ?? 0
    const pendingForCase = state.inFlightReservations.filter(
      (row) =>
        !row.dispatched &&
        row.profileId === context.profileId &&
        row.opaqueCaseId === context.opaqueCaseId,
    ).length
    if (calls + pendingForCase >= perCaseLimit(context.profileId, this.policy))
      throw new ProviderRefusalReplayLedgerError('Per-case physical dispatch ceiling reached')
    if (
      state.physicalDispatchCount +
        state.uncertainPhysicalDispatchCount +
        state.inFlightReservations.filter((item) => !item.dispatched).length >=
        REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
      state.dev40PhysicalCalls +
        state.uncertainPhysicalDispatchCount +
        state.inFlightReservations.filter((item) => !item.dispatched).length >=
        this.policy.incrementalCallLimit
    )
      throw new ProviderRefusalReplayLedgerError('Physical call budget exhausted')
    if (
      state.knownCostUsd +
        state.unknownReserveUsd +
        state.inFlightReservations.reduce((sum, item) => sum + item.reservedUsd, 0) +
        reservedUsd >
      this.policy.inheritedKnownCostUsd +
        this.policy.inheritedUnknownReserveUsd +
        this.policy.incrementalExposureUsd +
        1e-9
    )
      throw new ProviderRefusalReplayLedgerError('DEV40 technical exposure cap reached')
  }
  async assertStudyScopeCanAdmitPhysicalReservedUsd(
    profileId: H8aFreshProfileId,
    reservedUsd: number,
  ): Promise<void> {
    if (reservedUsd !== cost(profileId, this.policy))
      throw new ProviderRefusalReplayLedgerError('Reservation does not match the study profile')
  }
  async assertExposureAllowsAdditionalUsd(additionalUsd: number): Promise<void> {
    if (!Number.isFinite(additionalUsd) || additionalUsd < 0)
      throw new ProviderRefusalReplayLedgerError('Invalid additional exposure')
    const current = await this.store.read((raw) => stateSchema.parse(raw))
    if (!current) throw new ProviderRefusalReplayLedgerError('Ledger is missing')
    assertState(current, this.registration, this.policy)
    if (
      current.knownCostUsd +
        current.unknownReserveUsd +
        current.inFlightReservations.reduce((sum, row) => sum + row.reservedUsd, 0) +
        additionalUsd >
      this.policy.inheritedKnownCostUsd +
        this.policy.inheritedUnknownReserveUsd +
        this.policy.incrementalExposureUsd +
        1e-9
    )
      throw new ProviderRefusalReplayLedgerError('DEV40 technical exposure cap reached')
  }
}

/** Compatibility facade pinned to the original provider-refusal study. */
export class ProviderRefusalReplayLedger {
  private constructor(private readonly ledger: DevReplayLedger) {}

  static async register(options: {
    root?: string
    offlineTestOnly?: boolean
    protocolSha256: string
    caseIds: readonly string[]
  }): Promise<ProviderRefusalReplayLedger> {
    const ledger = await DevReplayLedger.register({
      ...options,
      studyId: LEGACY_REPLAY_POLICY.studyId,
    })
    return new ProviderRefusalReplayLedger(ledger)
  }

  snapshot(): CampaignLedgerSnapshotPort {
    return this.ledger.snapshot()
  }

  uncertainDispatchCount(): number {
    return this.ledger.uncertainDispatchCount()
  }

  assertResumeAllowed(): void {
    this.ledger.assertResumeAllowed()
  }

  recordLogicalAttempt(context?: LedgerLogicalAttemptContext): Promise<void> {
    return this.ledger.recordLogicalAttempt(context)
  }

  admitPhysical(reservedUsd: number, context?: LedgerPhysicalCallContext): Promise<number> {
    return this.ledger.admitPhysical(reservedUsd, context)
  }

  recordDispatchIntent(reservationId: number): Promise<void> {
    return this.ledger.recordDispatchIntent(reservationId)
  }

  markDispatched(reservationId: number): Promise<number> {
    return this.ledger.markDispatched(reservationId)
  }

  cancelBeforeFetch(reservationId: number): Promise<void> {
    return this.ledger.cancelBeforeFetch(reservationId)
  }

  settle(reservationId: number, costUsd: number | null): Promise<void> {
    return this.ledger.settle(reservationId, costUsd)
  }

  markCrashWithPendingDispatch(): Promise<void> {
    return this.ledger.markCrashWithPendingDispatch()
  }

  assertCanAdmitPhysicalReservedUsd(
    reservedUsd: number,
    context?: LedgerPhysicalCallContext,
  ): Promise<void> {
    return this.ledger.assertCanAdmitPhysicalReservedUsd(reservedUsd, context)
  }

  assertStudyScopeCanAdmitPhysicalReservedUsd(
    profileId: H8aFreshProfileId,
    reservedUsd: number,
  ): Promise<void> {
    return this.ledger.assertStudyScopeCanAdmitPhysicalReservedUsd(profileId, reservedUsd)
  }

  assertExposureAllowsAdditionalUsd(additionalUsd: number): Promise<void> {
    return this.ledger.assertExposureAllowsAdditionalUsd(additionalUsd)
  }
}
