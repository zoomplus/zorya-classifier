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
import { PROFILE_CONTROL_ID, PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import type { H8aFreshProfileId } from './profiles.js'
import {
  PROVIDER_REFUSAL_REPLAY_ROOT,
  PROVIDER_REFUSAL_REPLAY_STUDY_ID,
  PROVIDER_REFUSAL_REPLAY_FREEZE_ID,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
  PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH,
} from './provider-refusal-replay-admission.js'

const REPLAY_GLOBAL_MAX_PHYSICAL_CALLS = 2_000 as const
const REPLAY_DEV40_MAX_PHYSICAL_CALLS = 400 as const
const REPLAY_DEV40_MAX_INCREMENTAL_USD = 116.8 as const
export const REPLAY_CANDIDATE_MAX_USD = 0.55 as const
export const REPLAY_CONTROL_MAX_USD = 0.12 as const

const profileSchema = z.union([z.literal(PROFILE_FLAT_CANDIDATE_ID), z.literal(PROFILE_CONTROL_ID)])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const parentSchema = z
  .object({
    schema: z.literal('h8a-ui-state-dev40-successor-ledger-v1'),
    ledgerVersion: z.literal(556),
    maxPhysicalCalls: z.literal(2_000),
    nextReservationId: z.literal(203),
    nextPhysicalId: z.literal(203),
    physicalDispatchCount: z.literal(202),
    uncertainPhysicalDispatchCount: z.literal(0),
    logicalAttemptCount: z.literal(63),
    knownCostUsd: z.literal(0.11840506499999993),
    unknownReserveUsd: z.literal(0.24),
    inFlightReservations: z.array(z.unknown()).length(0),
    resumeBlocked: z.literal(false),
    crashRecoveryLatched: z.literal(false),
    integrityBlocked: z.literal(false),
  })
  .passthrough()

const registrationSchema = z
  .object({
    schema: z.literal('h8a-provider-refusal-replay-registration-v1'),
    studyId: z.literal(PROVIDER_REFUSAL_REPLAY_STUDY_ID),
    freezeId: z.literal(PROVIDER_REFUSAL_REPLAY_FREEZE_ID),
    protocolSha256: digest,
    parentAuditSha256: z.literal(PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256),
    parentLedgerSha256: z.literal(
      'b3c2348e09d8459ebc8b6935b03753c6b1082ce1f0f6584656bd8f39c4ca727b',
    ),
    parentLedgerVersion: z.literal(556),
    canonicalRoot: z.string().min(1),
    caseIds: z.array(z.string().min(1)).length(40),
    maxPhysicalCalls: z.literal(REPLAY_GLOBAL_MAX_PHYSICAL_CALLS),
    dev40MaxPhysicalCalls: z.literal(REPLAY_DEV40_MAX_PHYSICAL_CALLS),
    dev40MaxIncrementalUsd: z.literal(REPLAY_DEV40_MAX_INCREMENTAL_USD),
    candidateMaxUsdPerDispatch: z.literal(REPLAY_CANDIDATE_MAX_USD),
    controlMaxUsdPerDispatch: z.literal(REPLAY_CONTROL_MAX_USD),
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
    schema: z.literal('h8a-provider-refusal-replay-ledger-v1'),
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
function cost(profile: H8aFreshProfileId): number {
  if (profile === PROFILE_FLAT_CANDIDATE_ID) return REPLAY_CANDIDATE_MAX_USD
  if (profile === PROFILE_CONTROL_ID) return REPLAY_CONTROL_MAX_USD
  throw new ProviderRefusalReplayLedgerError('Profile is outside the replay ledger')
}
function supportedProfile(
  profile: H8aFreshProfileId,
): typeof PROFILE_FLAT_CANDIDATE_ID | typeof PROFILE_CONTROL_ID | undefined {
  return profile === PROFILE_FLAT_CANDIDATE_ID || profile === PROFILE_CONTROL_ID
    ? profile
    : undefined
}
function assertState(state: State, registration: Registration): void {
  const allowedCases = new Set(registration.caseIds)
  const undispatchedPending = state.inFlightReservations.filter(
    (item) => !item.dispatched && !item.uncertain,
  )
  const uncertainReservations = state.inFlightReservations.filter((item) => item.uncertain)
  if (
    state.registrationSha256 !== registration.registrationSha256 ||
    state.physicalDispatchCount !== 202 + state.dev40PhysicalCalls ||
    state.logicalAttemptCount !== 63 + state.logicalAttempts.length ||
    state.dev40PhysicalCalls > REPLAY_DEV40_MAX_PHYSICAL_CALLS ||
    uncertainReservations.length !== state.uncertainPhysicalDispatchCount ||
    state.physicalDispatchCount +
      state.uncertainPhysicalDispatchCount +
      undispatchedPending.length >
      REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
    state.dev40PhysicalCalls + state.uncertainPhysicalDispatchCount + undispatchedPending.length >
      REPLAY_DEV40_MAX_PHYSICAL_CALLS ||
    state.nextPhysicalId !==
      state.physicalDispatchCount + state.uncertainPhysicalDispatchCount + 1 ||
    state.knownCostUsd < 0.11840506499999993 ||
    state.unknownReserveUsd < 0.24 ||
    (!state.integrityBlocked &&
      state.knownCostUsd +
        state.unknownReserveUsd +
        state.inFlightReservations.reduce((sum, item) => sum + item.reservedUsd, 0) >
        0.11840506499999993 + 0.24 + REPLAY_DEV40_MAX_INCREMENTAL_USD + 1e-9) ||
    Math.abs(state.knownCostUsd - 0.11840506499999993 - state.dev40KnownCostUsd) > 1e-9 ||
    Math.abs(state.unknownReserveUsd - 0.24 - state.dev40UnknownReserveUsd) > 1e-9
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
      row.physicalCalls + pending > (row.profileId === PROFILE_FLAT_CANDIDATE_ID ? 4 : 6)
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
    if (calls + pending > (profileId === PROFILE_FLAT_CANDIDATE_ID ? 4 : 6))
      throw new ProviderRefusalReplayLedgerError(
        'Per-case pending reservations exceed their ceiling',
      )
  }
  const ids = state.inFlightReservations.map((row) => row.reservationId)
  if (
    new Set(ids).size !== ids.length ||
    state.inFlightReservations.some(
      (row) =>
        row.reservedUsd !== cost(row.profileId) ||
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

function initialState(registration: Registration): State {
  return stateSchema.parse({
    schema: 'h8a-provider-refusal-replay-ledger-v1',
    ledgerVersion: 0,
    registrationSha256: registration.registrationSha256,
    nextReservationId: 203,
    nextPhysicalId: 203,
    physicalDispatchCount: 202,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: 63,
    knownCostUsd: 0.11840506499999993,
    unknownReserveUsd: 0.24,
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

async function readParentLedger(offlineTestOnly: boolean): Promise<z.infer<typeof parentSchema>> {
  if (offlineTestOnly)
    return parentSchema.parse({
      schema: 'h8a-ui-state-dev40-successor-ledger-v1',
      ledgerVersion: 556,
      maxPhysicalCalls: 2_000,
      nextReservationId: 203,
      nextPhysicalId: 203,
      physicalDispatchCount: 202,
      uncertainPhysicalDispatchCount: 0,
      logicalAttemptCount: 63,
      knownCostUsd: 0.11840506499999993,
      unknownReserveUsd: 0.24,
      inFlightReservations: [],
      resumeBlocked: false,
      crashRecoveryLatched: false,
      integrityBlocked: false,
    })
  const info = await lstat(PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH)
  if (!info.isFile() || info.isSymbolicLink())
    throw new ProviderRefusalReplayLedgerError('Parent audit is not a regular file')
  if (
    sha256(await readFile(PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH)) !==
    PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256
  )
    throw new ProviderRefusalReplayLedgerError('Parent audit changed')
  const audit = z
    .object({ references: z.array(z.object({ path: z.string(), sha256: digest }).strict()) })
    .passthrough()
    .parse(JSON.parse(await readFile(PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_PATH, 'utf8')) as unknown)
  const ref = audit.references.find((row) =>
    row.path.endsWith('/admission/execution-v2/successor-campaign/campaign-ledger.json'),
  )
  if (!ref || ref.sha256 !== 'b3c2348e09d8459ebc8b6935b03753c6b1082ce1f0f6584656bd8f39c4ca727b')
    throw new ProviderRefusalReplayLedgerError('Pinned parent ledger reference is missing')
  const bytes = await readFile(ref.path)
  if (sha256(bytes) !== ref.sha256)
    throw new ProviderRefusalReplayLedgerError('Parent ledger changed')
  return parentSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
}

export class ProviderRefusalReplayLedger implements SuccessorCampaignAdmissionPort {
  private constructor(
    private readonly root: string,
    private readonly registration: Registration,
    private state: State,
    private readonly store = new AtomicJsonLedgerStore(join(root, 'campaign-ledger.json'), true),
  ) {}
  static async register(options: {
    root?: string
    offlineTestOnly?: boolean
    protocolSha256: string
    caseIds: readonly string[]
  }): Promise<ProviderRefusalReplayLedger> {
    const root = resolve(
      options.root ?? join(PROVIDER_REFUSAL_REPLAY_ROOT, 'admission', 'successor-campaign'),
    )
    const canonicalRoot = resolve(PROVIDER_REFUSAL_REPLAY_ROOT, 'admission', 'successor-campaign')
    if (
      options.offlineTestOnly === true
        ? root === canonicalRoot ||
          basename(resolve(root, '..', '..')) !== basename(PROVIDER_REFUSAL_REPLAY_ROOT)
        : root !== canonicalRoot
    )
      throw new ProviderRefusalReplayLedgerError(
        'Replay ledger must use the canonical new namespace',
      )
    if (options.caseIds.length !== 40 || new Set(options.caseIds).size !== 40)
      throw new ProviderRefusalReplayLedgerError('Registration must bind 40 unique frozen case IDs')
    const parent = await readParentLedger(options.offlineTestOnly === true)
    const body = {
      schema: 'h8a-provider-refusal-replay-registration-v1' as const,
      studyId: PROVIDER_REFUSAL_REPLAY_STUDY_ID,
      freezeId: PROVIDER_REFUSAL_REPLAY_FREEZE_ID,
      protocolSha256: digest.parse(options.protocolSha256),
      parentAuditSha256: PROVIDER_REFUSAL_REPLAY_PARENT_AUDIT_SHA256,
      parentLedgerSha256:
        'b3c2348e09d8459ebc8b6935b03753c6b1082ce1f0f6584656bd8f39c4ca727b' as const,
      parentLedgerVersion: parent.ledgerVersion,
      canonicalRoot: root,
      caseIds: [...options.caseIds],
      maxPhysicalCalls: REPLAY_GLOBAL_MAX_PHYSICAL_CALLS,
      dev40MaxPhysicalCalls: REPLAY_DEV40_MAX_PHYSICAL_CALLS,
      dev40MaxIncrementalUsd: REPLAY_DEV40_MAX_INCREMENTAL_USD,
      candidateMaxUsdPerDispatch: REPLAY_CANDIDATE_MAX_USD,
      controlMaxUsdPerDispatch: REPLAY_CONTROL_MAX_USD,
      ownerDollarCeilingUsd: null,
      retries: 0 as const,
    }
    const registration = registrationSchema.parse({
      ...body,
      registrationSha256: sha256(JSON.stringify(body)),
    })
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
      const initial = initialState(registration)
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
      assertState(state, registration)
      const cached = latestLedgerStates.get(root)
      if (!cached || state.ledgerVersion >= cached.ledgerVersion)
        latestLedgerStates.set(root, structuredClone(state))
      return new ProviderRefusalReplayLedger(root, registration, state, store)
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
        assertState(latest, this.registration)
        const next = structuredClone(latest)
        const value = operation(next)
        next.ledgerVersion++
        assertState(next, this.registration)
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
    const profileId = supportedProfile(context.profileId)
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
    if (!context || reservedUsd !== cost(context.profileId))
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
      if (calls + pending >= (context.profileId === PROFILE_FLAT_CANDIDATE_ID ? 4 : 6))
        throw new ProviderRefusalReplayLedgerError('Per-case physical dispatch ceiling reached')
      if (
        state.physicalDispatchCount +
          state.uncertainPhysicalDispatchCount +
          state.inFlightReservations.filter((item) => !item.dispatched).length >=
          REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
        state.dev40PhysicalCalls +
          state.uncertainPhysicalDispatchCount +
          state.inFlightReservations.filter((item) => !item.dispatched).length >=
          REPLAY_DEV40_MAX_PHYSICAL_CALLS
      )
        throw new ProviderRefusalReplayLedgerError('Physical call budget exhausted')
      if (
        state.knownCostUsd +
          state.unknownReserveUsd +
          state.inFlightReservations.reduce((sum, item) => sum + item.reservedUsd, 0) +
          reservedUsd >
        0.11840506499999993 + 0.24 + REPLAY_DEV40_MAX_INCREMENTAL_USD + 1e-9
      )
        throw new ProviderRefusalReplayLedgerError('DEV40 technical exposure cap reached')
      const id = state.nextReservationId++
      const profileId =
        context.profileId === PROFILE_FLAT_CANDIDATE_ID
          ? PROFILE_FLAT_CANDIDATE_ID
          : context.profileId === PROFILE_CONTROL_ID
            ? PROFILE_CONTROL_ID
            : undefined
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
    if (!context || reservedUsd !== cost(context.profileId))
      throw new ProviderRefusalReplayLedgerError('Reservation does not match the explicit profile')
    const state = await this.store.read((raw) => stateSchema.parse(raw))
    if (!state) throw new ProviderRefusalReplayLedgerError('Ledger is missing')
    assertState(state, this.registration)
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
    if (calls + pendingForCase >= (context.profileId === PROFILE_FLAT_CANDIDATE_ID ? 4 : 6))
      throw new ProviderRefusalReplayLedgerError('Per-case physical dispatch ceiling reached')
    if (
      state.physicalDispatchCount +
        state.uncertainPhysicalDispatchCount +
        state.inFlightReservations.filter((item) => !item.dispatched).length >=
        REPLAY_GLOBAL_MAX_PHYSICAL_CALLS ||
      state.dev40PhysicalCalls +
        state.uncertainPhysicalDispatchCount +
        state.inFlightReservations.filter((item) => !item.dispatched).length >=
        REPLAY_DEV40_MAX_PHYSICAL_CALLS
    )
      throw new ProviderRefusalReplayLedgerError('Physical call budget exhausted')
    if (
      state.knownCostUsd +
        state.unknownReserveUsd +
        state.inFlightReservations.reduce((sum, item) => sum + item.reservedUsd, 0) +
        reservedUsd >
      0.11840506499999993 + 0.24 + REPLAY_DEV40_MAX_INCREMENTAL_USD + 1e-9
    )
      throw new ProviderRefusalReplayLedgerError('DEV40 technical exposure cap reached')
  }
  async assertStudyScopeCanAdmitPhysicalReservedUsd(
    profileId: H8aFreshProfileId,
    reservedUsd: number,
  ): Promise<void> {
    if (reservedUsd !== cost(profileId))
      throw new ProviderRefusalReplayLedgerError('Reservation does not match the study profile')
  }
  async assertExposureAllowsAdditionalUsd(additionalUsd: number): Promise<void> {
    if (!Number.isFinite(additionalUsd) || additionalUsd < 0)
      throw new ProviderRefusalReplayLedgerError('Invalid additional exposure')
    const current = await this.store.read((raw) => stateSchema.parse(raw))
    if (!current) throw new ProviderRefusalReplayLedgerError('Ledger is missing')
    assertState(current, this.registration)
    if (
      current.knownCostUsd +
        current.unknownReserveUsd +
        current.inFlightReservations.reduce((sum, row) => sum + row.reservedUsd, 0) +
        additionalUsd >
      0.11840506499999993 + 0.24 + REPLAY_DEV40_MAX_INCREMENTAL_USD + 1e-9
    )
      throw new ProviderRefusalReplayLedgerError('DEV40 technical exposure cap reached')
  }
}
