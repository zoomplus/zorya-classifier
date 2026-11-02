import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { AtomicJsonLedgerStore } from './atomic-json-ledger.js'
import type {
  CampaignLedgerSnapshotPort,
  LedgerLogicalAttemptContext,
  LedgerPhysicalCallContext,
  SuccessorCampaignAdmissionPort,
} from './campaign-ledger-port.js'
import { PROFILE_CONTROL_ID, PROFILE_NATIVE_SELECTOR_CANDIDATE_ID } from './constants.js'
import type { H8aFreshProfileId } from './profiles.js'
import {
  NATIVE_SELECTOR_QUAL_FREEZE_ID,
  NATIVE_SELECTOR_QUAL_LEDGER_PATH,
  NATIVE_SELECTOR_QUAL_ROOT,
  NATIVE_SELECTOR_QUAL_STUDY_ID,
} from './native-selector-qual-protocol.js'
import {
  isVerifiedNativeSelectorQualAdmission,
  nativeSelectorQualAdmissionSnapshot,
} from './native-selector-qual-admission.js'
import type { VerifiedNativeSelectorQualAdmission } from './native-selector-qual-admission.js'

const GLOBAL_MAX = 2_000
const PHASE_MAX = 1_200
const PHASE_EXPOSURE = 144
const RESERVE_PER_CALL = 0.12
const PROFILE_LIMITS = Object.freeze({
  [PROFILE_NATIVE_SELECTOR_CANDIDATE_ID]: 4,
  [PROFILE_CONTROL_ID]: 6,
})
const profileSchema = z.enum([PROFILE_NATIVE_SELECTOR_CANDIDATE_ID, PROFILE_CONTROL_ID])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)

const registrationBodySchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-registration-v1'),
    studyId: z.literal(NATIVE_SELECTOR_QUAL_STUDY_ID),
    freezeId: z.literal(NATIVE_SELECTOR_QUAL_FREEZE_ID),
    protocolSha256: digest,
    parent: z
      .object({
        ledgerVersion: z.number().int().nonnegative(),
        physicalDispatchCount: z.number().int().nonnegative(),
        logicalAttemptCount: z.number().int().nonnegative(),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownReserveUsd: z.number().finite().nonnegative(),
        nextPhysicalId: z.number().int().positive(),
        nextReservationId: z.number().int().positive(),
      })
      .strict(),
    caseIds: z.array(z.string().min(1)).length(120),
    globalPhysicalCallLimit: z.literal(GLOBAL_MAX),
    phasePhysicalCallLimit: z.literal(PHASE_MAX),
    candidateMaxCallsPerCase: z.literal(4),
    controlMaxCallsPerCase: z.literal(6),
    reservedUsdPerPhysicalDispatch: z.literal(RESERVE_PER_CALL),
    phaseExposureUsd: z.literal(PHASE_EXPOSURE),
    ownerDollarCeilingUsd: z.null(),
    retries: z.literal(0),
    registrationSha256: digest,
  })
  .strict()
type Registration = z.infer<typeof registrationBodySchema>

const reservationSchema = z
  .object({
    reservationId: z.number().int().positive(),
    profileId: profileSchema,
    opaqueCaseId: z.string().min(1),
    reservedUsd: z.literal(RESERVE_PER_CALL),
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
    schema: z.literal('h8a-native-selector-qual120-ledger-v1'),
    ledgerVersion: z.number().int().nonnegative(),
    registrationSha256: digest,
    nextReservationId: z.number().int().positive(),
    nextPhysicalId: z.number().int().positive(),
    physicalDispatchCount: z.number().int().nonnegative(),
    uncertainPhysicalDispatchCount: z.number().int().nonnegative(),
    logicalAttemptCount: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownReserveUsd: z.number().finite().nonnegative(),
    phasePhysicalCalls: z.number().int().nonnegative(),
    phaseUncertainPhysicalCalls: z.number().int().nonnegative(),
    phaseKnownCostUsd: z.number().finite().nonnegative(),
    phaseUnknownReserveUsd: z.number().finite().nonnegative(),
    caseCounts: z.array(caseCountSchema),
    logicalAttempts: z.array(
      z.object({ profileId: profileSchema, opaqueCaseId: z.string().min(1) }).strict(),
    ),
    inFlightReservations: z.array(reservationSchema),
    runStarted: z.boolean(),
    resumeBlocked: z.boolean(),
    crashRecoveryLatched: z.boolean(),
    integrityBlocked: z.boolean(),
  })
  .strict()
type State = z.infer<typeof stateSchema>

function bodyHash(registration: Omit<Registration, 'registrationSha256'>): string {
  return createHash('sha256').update(JSON.stringify(registration)).digest('hex')
}
function registrationWithHash(value: Omit<Registration, 'registrationSha256'>): Registration {
  return registrationBodySchema.parse({ ...value, registrationSha256: bodyHash(value) })
}
function initialState(registration: Registration): State {
  return stateSchema.parse({
    schema: 'h8a-native-selector-qual120-ledger-v1',
    ledgerVersion: 0,
    registrationSha256: registration.registrationSha256,
    nextReservationId: registration.parent.nextReservationId,
    nextPhysicalId: registration.parent.nextPhysicalId,
    physicalDispatchCount: registration.parent.physicalDispatchCount,
    uncertainPhysicalDispatchCount: 0,
    logicalAttemptCount: registration.parent.logicalAttemptCount,
    knownCostUsd: registration.parent.knownCostUsd,
    unknownReserveUsd: registration.parent.unknownReserveUsd,
    phasePhysicalCalls: 0,
    phaseUncertainPhysicalCalls: 0,
    phaseKnownCostUsd: 0,
    phaseUnknownReserveUsd: 0,
    caseCounts: [],
    logicalAttempts: [],
    inFlightReservations: [],
    runStarted: false,
    resumeBlocked: false,
    crashRecoveryLatched: false,
    integrityBlocked: false,
  })
}

function assertRegistration(registration: Registration): void {
  const { registrationSha256, ...body } = registration
  if (registrationSha256 !== bodyHash(body) || new Set(registration.caseIds).size !== 120)
    throw new NativeSelectorQualLedgerError('QUAL registration hash or case IDs are invalid')
}

function assertState(state: State, registration: Registration): void {
  const allowedCases = new Set(registration.caseIds)
  const pending = state.inFlightReservations.filter((row) => !row.dispatched && !row.uncertain)
  const uncertain = state.inFlightReservations.filter((row) => row.uncertain)
  const slots = state.physicalDispatchCount + state.uncertainPhysicalDispatchCount + pending.length
  const phaseSlots = state.phasePhysicalCalls + state.phaseUncertainPhysicalCalls + pending.length
  const phaseExposure =
    state.phaseKnownCostUsd +
    state.phaseUnknownReserveUsd +
    state.inFlightReservations
      .filter((row) => !row.uncertain)
      .reduce((sum, row) => sum + row.reservedUsd, 0)
  if (
    state.registrationSha256 !== registration.registrationSha256 ||
    state.physicalDispatchCount !==
      registration.parent.physicalDispatchCount + state.phasePhysicalCalls ||
    state.logicalAttemptCount !==
      registration.parent.logicalAttemptCount + state.logicalAttempts.length ||
    state.uncertainPhysicalDispatchCount !== uncertain.length ||
    state.phaseUncertainPhysicalCalls !== uncertain.length ||
    slots > GLOBAL_MAX ||
    phaseSlots > PHASE_MAX ||
    (!state.integrityBlocked && phaseExposure > PHASE_EXPOSURE + 1e-9) ||
    state.nextPhysicalId !==
      state.physicalDispatchCount + state.uncertainPhysicalDispatchCount + 1 ||
    state.knownCostUsd < registration.parent.knownCostUsd ||
    state.unknownReserveUsd < registration.parent.unknownReserveUsd ||
    Math.abs(state.knownCostUsd - registration.parent.knownCostUsd - state.phaseKnownCostUsd) >
      1e-9 ||
    Math.abs(
      state.unknownReserveUsd -
        registration.parent.unknownReserveUsd -
        state.phaseUnknownReserveUsd,
    ) > 1e-9
  )
    throw new NativeSelectorQualLedgerError('QUAL ledger counters or budgets do not reconcile')
  const caseKeys = new Set<string>()
  for (const row of state.caseCounts) {
    const key = `${row.profileId}\0${row.opaqueCaseId}`
    const pendingForCase = state.inFlightReservations.filter(
      (item) =>
        !item.dispatched &&
        item.profileId === row.profileId &&
        item.opaqueCaseId === row.opaqueCaseId,
    ).length
    if (
      !allowedCases.has(row.opaqueCaseId) ||
      caseKeys.has(key) ||
      row.physicalCalls + pendingForCase > PROFILE_LIMITS[row.profileId]
    )
      throw new NativeSelectorQualLedgerError('QUAL per-profile case call limit exceeded')
    caseKeys.add(key)
  }
  if (
    state.logicalAttempts.some((row) => !allowedCases.has(row.opaqueCaseId)) ||
    new Set(state.logicalAttempts.map((row) => `${row.profileId}\0${row.opaqueCaseId}`)).size !==
      state.logicalAttempts.length ||
    state.inFlightReservations.some(
      (row) =>
        !allowedCases.has(row.opaqueCaseId) ||
        row.reservedUsd !== RESERVE_PER_CALL ||
        (row.uncertain && (!row.intent || row.dispatched || row.physicalId !== null)),
    )
  )
    throw new NativeSelectorQualLedgerError('QUAL ledger contains an invalid case or reservation')
}

class NativeSelectorQualLedgerError extends Error {
  readonly code = 'H8A_NATIVE_SELECTOR_QUAL_LEDGER'
  constructor(message: string) {
    super(message)
    this.name = 'NativeSelectorQualLedgerError'
  }
}
class NativeSelectorQualBudgetError extends Error {
  readonly code = 'H8A_NATIVE_SELECTOR_QUAL_BUDGET'
  constructor(message: string) {
    super(message)
    this.name = 'NativeSelectorQualBudgetError'
  }
}

export function createNativeSelectorQualRegistration(
  admission: VerifiedNativeSelectorQualAdmission,
): Registration {
  if (!isVerifiedNativeSelectorQualAdmission(admission))
    throw new NativeSelectorQualLedgerError('QUAL registration requires verified admission')
  const verified = nativeSelectorQualAdmissionSnapshot(admission)
  return registrationWithHash({
    schema: 'h8a-native-selector-qual120-registration-v1',
    studyId: NATIVE_SELECTOR_QUAL_STUDY_ID,
    freezeId: admission.protocol.freezeId,
    protocolSha256: verified.protocolSha256,
    parent: {
      ledgerVersion: verified.parentLedgerVersion,
      physicalDispatchCount: verified.parentPhysicalDispatchCount,
      logicalAttemptCount: verified.parentLogicalAttemptCount,
      knownCostUsd: verified.parentKnownCostUsd,
      unknownReserveUsd: verified.parentUnknownReserveUsd,
      nextPhysicalId: verified.parentNextPhysicalId,
      nextReservationId: verified.parentNextReservationId,
    },
    caseIds: [...verified.caseIds],
    globalPhysicalCallLimit: GLOBAL_MAX,
    phasePhysicalCallLimit: PHASE_MAX,
    candidateMaxCallsPerCase: 4,
    controlMaxCallsPerCase: 6,
    reservedUsdPerPhysicalDispatch: RESERVE_PER_CALL,
    phaseExposureUsd: PHASE_EXPOSURE,
    ownerDollarCeilingUsd: null,
    retries: 0,
  })
}

interface NativeSelectorQualOfflineLedgerOptions {
  offlineTestOnly: true
  namespaceRoot: string
  caseIds: readonly string[]
  parent: Registration['parent']
}

function registrationForOfflineTest(options: NativeSelectorQualOfflineLedgerOptions): Registration {
  const root = resolve(options.namespaceRoot)
  const relativeTemp = relative(resolve(tmpdir()), root)
  if (
    options.offlineTestOnly !== true ||
    !relativeTemp ||
    relativeTemp === '..' ||
    relativeTemp.startsWith(`..${sep}`) ||
    root === resolve(tmpdir()) ||
    options.caseIds.length !== 120 ||
    new Set(options.caseIds).size !== 120
  )
    throw new NativeSelectorQualLedgerError(
      'Offline ledger hooks require a disposable 120-case namespace',
    )
  return registrationWithHash({
    schema: 'h8a-native-selector-qual120-registration-v1',
    studyId: NATIVE_SELECTOR_QUAL_STUDY_ID,
    freezeId: NATIVE_SELECTOR_QUAL_FREEZE_ID,
    protocolSha256: '0'.repeat(64),
    parent: options.parent,
    caseIds: [...options.caseIds],
    globalPhysicalCallLimit: GLOBAL_MAX,
    phasePhysicalCallLimit: PHASE_MAX,
    candidateMaxCallsPerCase: 4,
    controlMaxCallsPerCase: 6,
    reservedUsdPerPhysicalDispatch: RESERVE_PER_CALL,
    phaseExposureUsd: PHASE_EXPOSURE,
    ownerDollarCeilingUsd: null,
    retries: 0,
  })
}

export class NativeSelectorQualLedger implements SuccessorCampaignAdmissionPort {
  private readonly store: AtomicJsonLedgerStore
  private readonly registration: Registration
  private readonly allowedCases: ReadonlySet<string>
  private state: State
  private readonly alreadyStartedAtOpen: boolean

  private constructor(path: string, registration: Registration, state: State, durable: boolean) {
    this.store = new AtomicJsonLedgerStore(path, durable)
    this.registration = registration
    this.state = state
    this.allowedCases = new Set(registration.caseIds)
    this.alreadyStartedAtOpen = state.runStarted
    assertRegistration(registration)
    assertState(state, registration)
  }

  static async open(
    path: string,
    admission: VerifiedNativeSelectorQualAdmission,
  ): Promise<NativeSelectorQualLedger> {
    if (!isVerifiedNativeSelectorQualAdmission(admission))
      throw new NativeSelectorQualLedgerError('QUAL ledger requires verified admission')
    if (nativeSelectorQualAdmissionSnapshot(admission).authority !== 'production')
      throw new NativeSelectorQualLedgerError(
        'Production QUAL ledger rejects offline test authority',
      )
    if (resolve(path) !== resolve(NATIVE_SELECTOR_QUAL_LEDGER_PATH))
      throw new NativeSelectorQualLedgerError('QUAL ledger path is outside its closed namespace')
    const namespace = resolve(NATIVE_SELECTOR_QUAL_ROOT)
    const namespaceInfo = await lstat(namespace)
    if (
      !namespaceInfo.isDirectory() ||
      namespaceInfo.isSymbolicLink() ||
      (await realpath(namespace)) !== namespace
    )
      throw new NativeSelectorQualLedgerError('QUAL ledger namespace is not a canonical directory')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const parentInfo = await lstat(dirname(path))
    if (
      !parentInfo.isDirectory() ||
      parentInfo.isSymbolicLink() ||
      (await realpath(dirname(path))) !== dirname(path)
    )
      throw new NativeSelectorQualLedgerError('QUAL ledger directory is not canonical')
    const registration = createNativeSelectorQualRegistration(admission)
    return this.openRegistration(path, registration, true)
  }

  static async validateCloseoutState(
    path: string,
    admission: VerifiedNativeSelectorQualAdmission,
  ): Promise<void> {
    if (!isVerifiedNativeSelectorQualAdmission(admission))
      throw new NativeSelectorQualLedgerError('QUAL closeout requires verified admission')
    if (resolve(path) !== resolve(NATIVE_SELECTOR_QUAL_LEDGER_PATH))
      throw new NativeSelectorQualLedgerError('QUAL ledger path is outside its closed namespace')
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new NativeSelectorQualLedgerError('QUAL closeout ledger is not a physical regular file')
    const registration = createNativeSelectorQualRegistration(admission)
    const state = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
    assertRegistration(registration)
    assertState(state, registration)
  }

  static async validateOfflineAdmissionState(
    path: string,
    namespaceRoot: string,
    admission: VerifiedNativeSelectorQualAdmission,
  ): Promise<void> {
    if (
      !isVerifiedNativeSelectorQualAdmission(admission) ||
      nativeSelectorQualAdmissionSnapshot(admission).authority !== 'offlineTestOnly' ||
      nativeSelectorQualAdmissionSnapshot(admission).namespaceRoot !== resolve(namespaceRoot)
    )
      throw new NativeSelectorQualLedgerError(
        'Offline QUAL closeout requires offline test authority',
      )
    const root = resolve(namespaceRoot)
    const ownedPath = resolve(path)
    const canonicalTempRoot = resolve(await realpath(tmpdir()))
    const relativeTemp = relative(canonicalTempRoot, root)
    const info = await lstat(root)
    if (
      !relativeTemp ||
      relativeTemp === '..' ||
      relativeTemp.startsWith(`..${sep}`) ||
      root === canonicalTempRoot ||
      dirname(ownedPath) !== root ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(root)) !== root
    )
      throw new NativeSelectorQualLedgerError(
        'Offline QUAL ledger escapes its canonical temp namespace',
      )
    const ledgerInfo = await lstat(ownedPath)
    if (
      !ledgerInfo.isFile() ||
      ledgerInfo.isSymbolicLink() ||
      (await realpath(ownedPath)) !== ownedPath
    )
      throw new NativeSelectorQualLedgerError('Offline QUAL ledger is not a physical regular file')
    const registration = createNativeSelectorQualRegistration(admission)
    const state = stateSchema.parse(JSON.parse(await readFile(ownedPath, 'utf8')) as unknown)
    assertRegistration(registration)
    assertState(state, registration)
  }

  static async openOfflineAdmissionForTest(
    path: string,
    namespaceRoot: string,
    admission: VerifiedNativeSelectorQualAdmission,
  ): Promise<NativeSelectorQualLedger> {
    if (
      !isVerifiedNativeSelectorQualAdmission(admission) ||
      nativeSelectorQualAdmissionSnapshot(admission).authority !== 'offlineTestOnly' ||
      nativeSelectorQualAdmissionSnapshot(admission).namespaceRoot !== resolve(namespaceRoot)
    )
      throw new NativeSelectorQualLedgerError('Offline QUAL ledger requires offline test authority')
    const root = resolve(namespaceRoot)
    const ownedPath = resolve(path)
    const canonicalTempRoot = resolve(await realpath(tmpdir()))
    const relativeTemp = relative(canonicalTempRoot, root)
    const info = await lstat(root)
    if (
      !relativeTemp ||
      relativeTemp === '..' ||
      relativeTemp.startsWith(`..${sep}`) ||
      root === canonicalTempRoot ||
      dirname(ownedPath) !== root ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(root)) !== root
    )
      throw new NativeSelectorQualLedgerError(
        'Offline QUAL ledger escapes its canonical temp namespace',
      )
    return this.openRegistration(path, createNativeSelectorQualRegistration(admission), false)
  }

  static async openOfflineForTest(
    path: string,
    options: NativeSelectorQualOfflineLedgerOptions,
  ): Promise<NativeSelectorQualLedger> {
    const registration = registrationForOfflineTest(options)
    const root = resolve(options.namespaceRoot)
    const ownedPath = resolve(path)
    const namespaceInfo = await lstat(root)
    if (
      dirname(ownedPath) !== root ||
      !namespaceInfo.isDirectory() ||
      namespaceInfo.isSymbolicLink() ||
      (await realpath(root)) !== root
    )
      throw new NativeSelectorQualLedgerError(
        'Offline ledger path escapes its canonical test namespace',
      )
    return this.openRegistration(path, registration, false)
  }

  private static async openRegistration(
    path: string,
    registration: Registration,
    durable: boolean,
  ): Promise<NativeSelectorQualLedger> {
    assertRegistration(registration)
    const store = new AtomicJsonLedgerStore(resolve(path), durable)
    const state = await store.openOrCreate((value) => {
      const parsed = stateSchema.parse(value)
      assertState(parsed, registration)
      return parsed
    }, initialState(registration))
    const ledger = new NativeSelectorQualLedger(resolve(path), registration, state, durable)
    if (state.runStarted)
      throw new NativeSelectorQualLedgerError(
        'QUAL execution already launched; resume is forbidden',
      )
    return ledger
  }

  private async transact<T>(fn: (state: State) => { next: State; result: T }): Promise<T> {
    const result = await this.store.transact(
      (value) => stateSchema.parse(value),
      async (current) => {
        assertState(current, this.registration)
        const changed = fn(current)
        changed.next.ledgerVersion = current.ledgerVersion + 1
        const parsed = stateSchema.parse(changed.next)
        assertState(parsed, this.registration)
        return { next: parsed, result: changed.result }
      },
    )
    this.state = (await this.store.read((value) => stateSchema.parse(value))) ?? this.state
    return result
  }

  snapshot(): CampaignLedgerSnapshotPort {
    return Object.freeze({
      physicalDispatchCount: this.state.physicalDispatchCount,
      logicalAttemptCount: this.state.logicalAttemptCount,
      knownCostUsd: this.state.knownCostUsd,
      unknownReserveUsd: this.state.unknownReserveUsd,
      inFlightReservations: this.state.inFlightReservations.map((row) => ({
        reservationId: row.reservationId,
        reservedUsd: row.reservedUsd,
      })),
      resumeBlocked: this.state.resumeBlocked || this.alreadyStartedAtOpen,
    })
  }

  assertResumeAllowed(): void {
    if (this.state.resumeBlocked || this.state.runStarted || this.alreadyStartedAtOpen)
      throw new NativeSelectorQualLedgerError('QUAL run cannot resume after launch')
  }

  async recordLogicalAttempt(context?: LedgerLogicalAttemptContext): Promise<void> {
    if (!context)
      throw new NativeSelectorQualLedgerError('QUAL logical attempts require case-arm identity')
    await this.transact((state) => {
      this.assertContext(context)
      if (state.integrityBlocked || state.crashRecoveryLatched)
        throw new NativeSelectorQualLedgerError('QUAL ledger is blocked')
      const key = `${context.profileId}\0${context.opaqueCaseId}`
      if (state.logicalAttempts.some((row) => `${row.profileId}\0${row.opaqueCaseId}` === key))
        throw new NativeSelectorQualLedgerError('QUAL case-arm logical attempt already exists')
      return {
        next: {
          ...state,
          runStarted: true,
          resumeBlocked: true,
          logicalAttemptCount: state.logicalAttemptCount + 1,
          logicalAttempts: [
            ...state.logicalAttempts,
            { profileId: context.profileId, opaqueCaseId: context.opaqueCaseId },
          ],
        },
        result: undefined,
      }
    })
  }

  async admitPhysical(reservedUsd: number, context?: LedgerPhysicalCallContext): Promise<number> {
    if (!context)
      throw new NativeSelectorQualLedgerError('QUAL physical reservation requires case identity')
    return this.transact((state) => {
      this.assertContext(context)
      if (state.integrityBlocked || state.crashRecoveryLatched || reservedUsd !== RESERVE_PER_CALL)
        throw new NativeSelectorQualBudgetError('QUAL physical reserve is not admitted')
      this.assertCapacity(state, context)
      const reservationId = state.nextReservationId
      const next: State = {
        ...state,
        nextReservationId: reservationId + 1,
        inFlightReservations: [
          ...state.inFlightReservations,
          {
            reservationId,
            profileId: context.profileId,
            opaqueCaseId: context.opaqueCaseId,
            reservedUsd: RESERVE_PER_CALL,
            intent: false,
            dispatched: false,
            uncertain: false,
            physicalId: null,
          },
        ],
      }
      return { next, result: reservationId }
    })
  }

  async recordDispatchIntent(reservationId: number): Promise<void> {
    await this.transact((state) => {
      const row = state.inFlightReservations.find((item) => item.reservationId === reservationId)
      if (!row || row.intent || row.dispatched || row.uncertain)
        throw new NativeSelectorQualLedgerError('QUAL dispatch intent is invalid')
      return {
        next: {
          ...state,
          runStarted: true,
          resumeBlocked: true,
          inFlightReservations: state.inFlightReservations.map((item) =>
            item.reservationId === reservationId ? { ...item, intent: true } : item,
          ),
        },
        result: undefined,
      }
    })
  }

  async markDispatched(reservationId: number): Promise<number> {
    return this.transact((state) => {
      const row = state.inFlightReservations.find((item) => item.reservationId === reservationId)
      if (!row?.intent || row.dispatched || row.uncertain)
        throw new NativeSelectorQualLedgerError('QUAL dispatch confirmation is invalid')
      const physicalId = state.nextPhysicalId
      const key = `${row.profileId}\0${row.opaqueCaseId}`
      const existing = state.caseCounts.find(
        (item) => `${item.profileId}\0${item.opaqueCaseId}` === key,
      )
      const caseCounts = existing
        ? state.caseCounts.map((item) =>
            `${item.profileId}\0${item.opaqueCaseId}` === key
              ? { ...item, physicalCalls: item.physicalCalls + 1 }
              : item,
          )
        : [
            ...state.caseCounts,
            { profileId: row.profileId, opaqueCaseId: row.opaqueCaseId, physicalCalls: 1 },
          ]
      const next = {
        ...state,
        nextPhysicalId: physicalId + 1,
        physicalDispatchCount: state.physicalDispatchCount + 1,
        phasePhysicalCalls: state.phasePhysicalCalls + 1,
        caseCounts,
        inFlightReservations: state.inFlightReservations.map((item) =>
          item.reservationId === reservationId ? { ...item, dispatched: true, physicalId } : item,
        ),
      }
      return { next, result: physicalId }
    })
  }

  async cancelBeforeFetch(reservationId: number): Promise<void> {
    await this.transact((state) => {
      const row = state.inFlightReservations.find((item) => item.reservationId === reservationId)
      if (!row || row.dispatched || row.uncertain)
        throw new NativeSelectorQualLedgerError('Cannot cancel a dispatched QUAL reservation')
      return {
        next: {
          ...state,
          inFlightReservations: state.inFlightReservations.filter(
            (item) => item.reservationId !== reservationId,
          ),
        },
        result: undefined,
      }
    })
  }

  async settle(reservationId: number, costUsd: number | null): Promise<void> {
    await this.transact((state) => {
      const row = state.inFlightReservations.find((item) => item.reservationId === reservationId)
      if (!row?.dispatched || row.uncertain)
        throw new NativeSelectorQualLedgerError('QUAL settlement lacks a confirmed dispatch')
      if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0))
        throw new NativeSelectorQualLedgerError('QUAL settlement charge is invalid')
      const known = costUsd === null ? 0 : costUsd
      const unknown = costUsd === null ? row.reservedUsd : 0
      const overReserve = known > row.reservedUsd + 1e-12
      const next = {
        ...state,
        knownCostUsd: state.knownCostUsd + known,
        unknownReserveUsd: state.unknownReserveUsd + unknown,
        phaseKnownCostUsd: state.phaseKnownCostUsd + known,
        phaseUnknownReserveUsd: state.phaseUnknownReserveUsd + unknown,
        integrityBlocked: state.integrityBlocked || overReserve,
        inFlightReservations: state.inFlightReservations.filter(
          (item) => item.reservationId !== reservationId,
        ),
      }
      return { next, result: undefined }
    })
  }

  async markCrashWithPendingDispatch(): Promise<void> {
    await this.transact((state) => {
      const pending = state.inFlightReservations.filter(
        (row) => row.intent && !row.dispatched && !row.uncertain,
      )
      const uncertainReserve = pending.reduce((sum, row) => sum + row.reservedUsd, 0)
      return {
        next: {
          ...state,
          runStarted: true,
          resumeBlocked: true,
          crashRecoveryLatched: true,
          nextPhysicalId: state.nextPhysicalId + pending.length,
          uncertainPhysicalDispatchCount: state.uncertainPhysicalDispatchCount + pending.length,
          phaseUncertainPhysicalCalls: state.phaseUncertainPhysicalCalls + pending.length,
          unknownReserveUsd: state.unknownReserveUsd + uncertainReserve,
          phaseUnknownReserveUsd: state.phaseUnknownReserveUsd + uncertainReserve,
          inFlightReservations: state.inFlightReservations.map((row) =>
            row.intent && !row.dispatched ? { ...row, uncertain: true } : row,
          ),
        },
        result: undefined,
      }
    })
  }

  async assertCanAdmitPhysicalReservedUsd(
    reservedUsd: number,
    context?: LedgerPhysicalCallContext,
  ): Promise<void> {
    if (!context || reservedUsd !== RESERVE_PER_CALL)
      throw new NativeSelectorQualBudgetError('QUAL reserve is outside its closed policy')
    const state = await this.store.read((value) => stateSchema.parse(value))
    if (!state) throw new NativeSelectorQualLedgerError('QUAL ledger disappeared')
    this.assertContext(context)
    this.assertCapacity(state, context)
  }

  async assertStudyScopeCanAdmitPhysicalReservedUsd(
    profileId: H8aFreshProfileId,
    reservedUsd: number,
  ): Promise<void> {
    if (profileId !== PROFILE_NATIVE_SELECTOR_CANDIDATE_ID && profileId !== PROFILE_CONTROL_ID)
      throw new NativeSelectorQualBudgetError('Profile is outside the QUAL selector pair')
    if (reservedUsd !== RESERVE_PER_CALL)
      throw new NativeSelectorQualBudgetError(
        'QUAL reserve differs from the registered dispatch amount',
      )
    const state = await this.store.read((value) => stateSchema.parse(value))
    if (!state || state.integrityBlocked || state.crashRecoveryLatched)
      throw new NativeSelectorQualLedgerError('QUAL ledger is blocked')
    const pending = state.inFlightReservations.filter(
      (row) => !row.dispatched && !row.uncertain,
    ).length
    if (
      state.physicalDispatchCount + state.uncertainPhysicalDispatchCount + pending + PHASE_MAX >
      GLOBAL_MAX
    )
      throw new NativeSelectorQualBudgetError('Global campaign has insufficient QUAL headroom')
  }

  async assertExposureAllowsAdditionalUsd(additionalUsd: number): Promise<void> {
    if (!Number.isFinite(additionalUsd) || additionalUsd < 0)
      throw new NativeSelectorQualBudgetError('QUAL exposure is invalid')
    const state = await this.store.read((value) => stateSchema.parse(value))
    if (
      !state ||
      state.phaseKnownCostUsd +
        state.phaseUnknownReserveUsd +
        state.inFlightReservations.reduce((sum, row) => sum + row.reservedUsd, 0) +
        additionalUsd >
        PHASE_EXPOSURE + 1e-9
    )
      throw new NativeSelectorQualBudgetError('QUAL phase exposure ceiling would be exceeded')
  }

  private assertContext(
    context: LedgerPhysicalCallContext,
  ): asserts context is LedgerPhysicalCallContext & {
    profileId: typeof PROFILE_NATIVE_SELECTOR_CANDIDATE_ID | typeof PROFILE_CONTROL_ID
  } {
    if (
      !this.allowedCases.has(context.opaqueCaseId) ||
      (context.profileId !== PROFILE_NATIVE_SELECTOR_CANDIDATE_ID &&
        context.profileId !== PROFILE_CONTROL_ID)
    )
      throw new NativeSelectorQualLedgerError('QUAL case-arm identity is not registered')
  }

  private assertCapacity(state: State, context: LedgerPhysicalCallContext): void {
    const pending = state.inFlightReservations.filter(
      (row) => !row.dispatched && !row.uncertain,
    ).length
    if (
      state.physicalDispatchCount + state.uncertainPhysicalDispatchCount + pending >= GLOBAL_MAX ||
      state.phasePhysicalCalls + state.phaseUncertainPhysicalCalls + pending >= PHASE_MAX ||
      state.phaseKnownCostUsd +
        state.phaseUnknownReserveUsd +
        state.inFlightReservations.reduce((sum, row) => sum + row.reservedUsd, 0) +
        RESERVE_PER_CALL >
        PHASE_EXPOSURE + 1e-9
    )
      throw new NativeSelectorQualBudgetError('QUAL global, phase, or exposure budget exhausted')
    const contextProfile = profileSchema.parse(context.profileId)
    const used =
      state.caseCounts.find(
        (row) => row.profileId === contextProfile && row.opaqueCaseId === context.opaqueCaseId,
      )?.physicalCalls ?? 0
    const pendingForCase = state.inFlightReservations.filter(
      (row) =>
        !row.dispatched &&
        row.profileId === contextProfile &&
        row.opaqueCaseId === context.opaqueCaseId,
    ).length
    if (used + pendingForCase >= PROFILE_LIMITS[contextProfile])
      throw new NativeSelectorQualBudgetError('QUAL per-case physical call cap exhausted')
  }
}
