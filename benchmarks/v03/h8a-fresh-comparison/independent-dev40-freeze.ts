import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  assembleDevFreezeFromDisk,
  verifyPersistedDevFreeze,
  writeDevFreezeExclusive,
} from './dev-freeze-assembly.js'
import {
  CANDIDATE_MAX_USD_PER_DISPATCH,
  CONTROL_MAX_USD_PER_DISPATCH,
  DEV40_SUCCESSOR_MAX_CALLS,
  SuccessorCampaignLedgerBlockedError,
} from './successor-campaign-ledger.js'
import type { SuccessorCampaignAdmissionPort } from './campaign-ledger-port.js'
import {
  DEV40_CASE_COUNT,
  DEV40_NEGATIVE_COUNT,
  DEV40_POSITIVE_COUNT,
  PHASE_FLAT_DEV40_ID,
  PROFILE_CONTROL_ID,
  PROFILE_FLAT_CANDIDATE_ID,
} from './constants.js'
import { validateConservativeCostProof, validateProfileIdentities } from './freeze-admission.js'
import { hashIdentity } from './hash-identity.js'
import { validateDevScreenSelection } from './dev-screen-sampling.js'
import type { PhaseFreeze } from './schemas.js'
import { phaseFreezeSchema } from './schemas.js'
import {
  UI_STATE_DEV40_FREEZE_ID,
  UI_STATE_DEV40_PARENT_REGISTRATION_SHA256,
  UI_STATE_DEV40_PUBLIC_COST_BOUNDS_SHA256,
  UI_STATE_DEV40_ROOT,
  UI_STATE_DEV40_SOURCE_ADMISSION_POLICY,
  UI_STATE_DEV40_STUDY_ID,
} from './ui-state-dev40-policy.js'

const ARTIFACT_ROOT = '/root/.codex/artifacts'
const STUDY_ID = UI_STATE_DEV40_STUDY_ID
const FREEZE_ID = UI_STATE_DEV40_FREEZE_ID
const STUDY_ROOT = UI_STATE_DEV40_ROOT
const AUTHORITY_PATH = resolve(STUDY_ROOT, 'admission', 'independent-dev40-v2-preparation.json')
const FREEZE_DIRECTORY = resolve(STUDY_ROOT, 'admission', 'freeze-v2')
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u)

const optionsSchema = z
  .object({
    authorityPath: z.literal(AUTHORITY_PATH),
    authoritySha256: DIGEST,
    sourceRoot: z.literal(REPOSITORY_ROOT),
    outputDirectory: z.literal(FREEZE_DIRECTORY),
  })
  .strict()
const verifiedInputsSchema = z
  .object({
    schema: z.literal('h8a-independent-dev40-v2-preparation-v1'),
    studyId: z.literal(STUDY_ID),
    freezeId: z.literal(FREEZE_ID),
    parentRegistrationSha256: z.literal(UI_STATE_DEV40_PARENT_REGISTRATION_SHA256),
    sourcePolicyId: z.literal(UI_STATE_DEV40_SOURCE_ADMISSION_POLICY),
    deadlineIso: z.string().datetime({ offset: true }),
    trustedRoot: z.literal(ARTIFACT_ROOT),
    sourceClosure: z.object({ path: z.string().min(1), sha256: DIGEST }).strict(),
    priceProof: z.object({ path: z.string().min(1), sha256: DIGEST }).strict(),
    sourceStateProof: z.object({ path: z.string().min(1), sha256: DIGEST }).strict(),
  })
  .passthrough()
const sourceClosureSchema = z
  .object({
    schema: z.literal('h8a-producer-closure-files-v1'),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  })
  .passthrough()

type IndependentDev40FreezeOptions = z.infer<typeof optionsSchema>
interface VerifiedIndependentDev40Authority {
  studyId: typeof STUDY_ID
  sourceAdmissionPolicy: typeof UI_STATE_DEV40_SOURCE_ADMISSION_POLICY
  sourceStateProofSha256: string
  authoritySha256: string
  sourceCommit: string
  priceProofSha256: string
  freezeCommitmentSha256: string
}
type IndependentDev40Freeze = Awaited<ReturnType<typeof assembleDevFreezeFromDisk>> & {
  verifiedAuthority: VerifiedIndependentDev40Authority
}
const verifiedFreezeAuthorities = new WeakMap<object, string>()

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readPinnedRegularFile(path: string, expectedSha256: string): Promise<Buffer> {
  const absolute = resolve(path)
  const beforePath = await lstat(absolute)
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > 4 * 1024 * 1024)
    throw new RangeError('Independent DEV40 authority input is not a regular file')
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const afterPath = await lstat(absolute)
    if (
      sha256(bytes) !== expectedSha256 ||
      bytes.length !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(afterPath.dev) !== after.dev ||
      BigInt(afterPath.ino) !== after.ino ||
      (await realpath(absolute)) !== absolute
    )
      throw new RangeError('Independent DEV40 authority input changed during verification')
    return bytes
  } finally {
    await handle.close()
  }
}

async function verifiedAuthorityFor(
  options: IndependentDev40FreezeOptions,
  freeze: PhaseFreeze,
): Promise<VerifiedIndependentDev40Authority> {
  const authorityBytes = await readPinnedRegularFile(options.authorityPath, options.authoritySha256)
  const authority = verifiedInputsSchema.parse(
    JSON.parse(authorityBytes.toString('utf8')) as unknown,
  )
  if (Date.parse(authority.deadlineIso) <= Date.now())
    throw new RangeError('Independent DEV40 preparation deadline has expired')
  const studyPrefix = STUDY_ROOT
  const closurePath = resolve(ARTIFACT_ROOT, authority.sourceClosure.path)
  const stateProofPath = resolve(ARTIFACT_ROOT, authority.sourceStateProof.path)
  if (
    !closurePath.startsWith(`${studyPrefix}${sep}`) ||
    relative(ARTIFACT_ROOT, closurePath) !== authority.sourceClosure.path ||
    !stateProofPath.startsWith(`${studyPrefix}${sep}`) ||
    relative(ARTIFACT_ROOT, stateProofPath) !== authority.sourceStateProof.path
  )
    throw new RangeError('Independent DEV40 source closure escapes its registered study root')
  const closureBytes = await readPinnedRegularFile(closurePath, authority.sourceClosure.sha256)
  const closure = sourceClosureSchema.parse(JSON.parse(closureBytes.toString('utf8')) as unknown)
  return {
    studyId: STUDY_ID,
    sourceAdmissionPolicy: UI_STATE_DEV40_SOURCE_ADMISSION_POLICY,
    sourceStateProofSha256: authority.sourceStateProof.sha256,
    authoritySha256: sha256(authorityBytes),
    sourceCommit: closure.sourceCommit,
    priceProofSha256: authority.priceProof.sha256,
    freezeCommitmentSha256: hashIdentity(freeze),
  }
}

function assertPhysicalNewChild(parent: string, target: string): void {
  const resolvedParent = resolve(parent)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedParent, resolvedTarget)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    resolve(resolvedParent, rel) !== resolvedTarget
  )
    throw new RangeError(
      'Independent DEV40 output must be a new child of its registered study root',
    )
}

async function validateFilesystemRoots(options: IndependentDev40FreezeOptions): Promise<void> {
  const [artifactReal, studyReal, rootReal] = await Promise.all([
    realpath(ARTIFACT_ROOT),
    realpath(STUDY_ROOT),
    realpath(REPOSITORY_ROOT),
  ])
  if (
    artifactReal !== ARTIFACT_ROOT ||
    studyReal !== STUDY_ROOT ||
    rootReal !== REPOSITORY_ROOT ||
    resolve(options.authorityPath) !== AUTHORITY_PATH ||
    resolve(options.sourceRoot) !== REPOSITORY_ROOT
  )
    throw new RangeError('Independent DEV40 roots are aliased or differ from the registered paths')
  assertPhysicalNewChild(resolve(STUDY_ROOT, 'admission'), options.outputDirectory)
  const outputParent = resolve(dirname(options.outputDirectory))
  if ((await realpath(outputParent)) !== outputParent)
    throw new RangeError('Independent DEV40 output parent is aliased')
  try {
    const existing = await lstat(options.outputDirectory)
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new RangeError('Independent DEV40 output path is not a physical directory')
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return
    throw error
  }
  throw new RangeError('Independent DEV40 freeze output is immutable and already exists')
}

function assertIndependentFreeze(freeze: PhaseFreeze): void {
  phaseFreezeSchema.parse(freeze)
  if (
    freeze.freezeId !== FREEZE_ID ||
    freeze.phaseId !== PHASE_FLAT_DEV40_ID ||
    freeze.phaseCounts.totalCases !== DEV40_CASE_COUNT ||
    freeze.phaseCounts.positiveCases !== DEV40_POSITIVE_COUNT ||
    freeze.phaseCounts.negativeCases !== DEV40_NEGATIVE_COUNT ||
    freeze.producerCases.length !== DEV40_CASE_COUNT ||
    freeze.callLimits.candidateMaxPhysicalCallsPerCase !== 4 ||
    freeze.callLimits.controlMaxPhysicalCallsPerCase !== 6 ||
    freeze.callLimits.phaseWorstCasePhysicalCalls !== DEV40_SUCCESSOR_MAX_CALLS ||
    freeze.profileBindings[0].profileId !== PROFILE_FLAT_CANDIDATE_ID ||
    freeze.profileBindings[1].profileId !== PROFILE_CONTROL_ID ||
    freeze.conservativeCostProof.derivedFrom !==
      `pinned-price-proof-sha256:${UI_STATE_DEV40_PUBLIC_COST_BOUNDS_SHA256}`
  )
    throw new RangeError('Freeze differs from the registered independent DEV40 recipe and limits')
  validateProfileIdentities(freeze)
  validateConservativeCostProof(freeze)
  const candidateBound = freeze.conservativeCostProof.profileDispatchUpperBounds.find(
    (entry) => entry.profileId === PROFILE_FLAT_CANDIDATE_ID,
  )?.maxUsdPerPhysicalDispatch
  const controlBound = freeze.conservativeCostProof.profileDispatchUpperBounds.find(
    (entry) => entry.profileId === PROFILE_CONTROL_ID,
  )?.maxUsdPerPhysicalDispatch
  if (
    candidateBound !== CANDIDATE_MAX_USD_PER_DISPATCH ||
    controlBound !== CONTROL_MAX_USD_PER_DISPATCH ||
    candidateBound * 4 + controlBound * 6 !== 2.92
  )
    throw new RangeError(
      'Freeze cost bounds differ from the registered conservative request ceilings',
    )
}

export async function assembleIndependentDev40V2FromDisk(
  optionsUnknown: IndependentDev40FreezeOptions,
): Promise<IndependentDev40Freeze> {
  const options = optionsSchema.parse(optionsUnknown)
  await validateFilesystemRoots(options)
  const authorityBytes = await readPinnedRegularFile(options.authorityPath, options.authoritySha256)
  const authority = verifiedInputsSchema.parse(
    JSON.parse(authorityBytes.toString('utf8')) as unknown,
  )
  if (Date.parse(authority.deadlineIso) <= Date.now())
    throw new RangeError('Independent DEV40 preparation deadline has expired')
  const assembled = await assembleDevFreezeFromDisk(options)
  assertIndependentFreeze(assembled.freeze)
  const result: IndependentDev40Freeze = {
    ...assembled,
    verifiedAuthority: await verifiedAuthorityFor(options, assembled.freeze),
  }
  verifiedFreezeAuthorities.set(result, hashIdentity(result.verifiedAuthority))
  await writeDevFreezeExclusive(options.outputDirectory, assembled)
  return result
}

export async function verifyPersistedIndependentDev40V2(
  freezeDirectory: string,
  optionsUnknown: Omit<IndependentDev40FreezeOptions, 'outputDirectory'>,
): Promise<IndependentDev40Freeze> {
  const options = optionsSchema.parse({ ...optionsUnknown, outputDirectory: FREEZE_DIRECTORY })
  if (resolve(freezeDirectory) !== FREEZE_DIRECTORY)
    throw new RangeError('Persisted independent DEV40 freeze is not in its registered directory')
  const root = await realpath(freezeDirectory)
  if (root !== FREEZE_DIRECTORY) throw new RangeError('Persisted freeze directory is aliased')
  const assembled = await verifyPersistedDevFreeze(freezeDirectory, options)
  assertIndependentFreeze(assembled.freeze)
  const result: IndependentDev40Freeze = {
    ...assembled,
    verifiedAuthority: await verifiedAuthorityFor(options, assembled.freeze),
  }
  verifiedFreezeAuthorities.set(result, hashIdentity(result.verifiedAuthority))
  return result
}

export async function assertSuccessorFreezeAdmission(
  verified: IndependentDev40Freeze,
  ledger: SuccessorCampaignAdmissionPort,
): Promise<void> {
  const verifiedAuthorityDigest = verifiedFreezeAuthorities.get(verified)
  if (!verifiedAuthorityDigest)
    throw new SuccessorCampaignLedgerBlockedError(
      'Freeze was not verified by the independent DEV40 loader',
    )
  const freeze = phaseFreezeSchema.parse(verified.freeze)
  assertIndependentFreeze(freeze)
  validateDevScreenSelection(verified.selection, freeze, verified.annotations)
  if (
    verified.verifiedAuthority.studyId !== STUDY_ID ||
    verified.verifiedAuthority.sourceAdmissionPolicy !== UI_STATE_DEV40_SOURCE_ADMISSION_POLICY ||
    !DIGEST.safeParse(verified.verifiedAuthority.sourceStateProofSha256).success ||
    hashIdentity(verified.verifiedAuthority) !== verifiedAuthorityDigest ||
    !DIGEST.safeParse(verified.verifiedAuthority.authoritySha256).success ||
    !/^[a-f0-9]{40}$/u.test(verified.verifiedAuthority.sourceCommit) ||
    !DIGEST.safeParse(verified.verifiedAuthority.priceProofSha256).success ||
    verified.verifiedAuthority.freezeCommitmentSha256 !== hashIdentity(freeze) ||
    verified.sourceBytesByCaseId.size !== freeze.producerCases.length ||
    freeze.producerCases.some((producer) => {
      const bytes = verified.sourceBytesByCaseId.get(producer.opaqueCaseId)
      return !bytes || sha256(bytes) !== producer.sourceBytesSha256
    }) ||
    freeze.conservativeCostProof.derivedFrom !==
      `pinned-price-proof-sha256:${verified.verifiedAuthority.priceProofSha256}`
  )
    throw new SuccessorCampaignLedgerBlockedError(
      'Verified independent DEV40 source, selection, or authority was changed',
    )
  if (
    !Number.isFinite(Date.parse(freeze.deadlineIso)) ||
    Date.parse(freeze.deadlineIso) <= Date.now()
  )
    throw new RangeError('Independent DEV40 freeze deadline is expired')
  ledger.assertResumeAllowed()
  await ledger.assertStudyScopeCanAdmitPhysicalReservedUsd(
    PROFILE_FLAT_CANDIDATE_ID,
    CANDIDATE_MAX_USD_PER_DISPATCH,
  )
  await ledger.assertStudyScopeCanAdmitPhysicalReservedUsd(
    PROFILE_CONTROL_ID,
    CONTROL_MAX_USD_PER_DISPATCH,
  )
  await ledger.assertExposureAllowsAdditionalUsd(2.92)
}
