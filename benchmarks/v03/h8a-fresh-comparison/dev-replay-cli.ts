import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { acquireExclusiveFileLock } from './atomic-json-ledger.js'
import { assembleDev40Closeouts } from './dev-closeout-assembly.js'
import {
  executeDevScreen,
  sealDevScreenReview,
  devScreenReportSchema,
} from './dev-screen-runner.js'
import { evaluateDev40Gate, joinCloseoutsWithPrivateAnnotations } from './evaluator.js'
import { PROFILE_FLAT_CANDIDATE_ID } from './constants.js'
import {
  loadHistoricalControl,
  verifyRuntimeProof,
  assertLiveRunnerClosure,
} from './dev-screen-cli.js'
import { createH8FreshRuntimePorts } from './runtime-ports.js'
import { UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256 } from './ui-state-dev40-policy.js'
import { parseReplayProtocolForStudy, verifyDevReplayAdmission } from './dev-replay-admission.js'
import type {
  VerifiedAuthoredScopeReplayAdmission,
  VerifiedNativePresenceReplayAdmission,
  VerifiedNativeSelectorReplayAdmission,
  VerifiedProviderRefusalReplayAdmission,
} from './dev-replay-admission.js'
import { DevReplayLedger } from './dev-replay-ledger.js'
import {
  NATIVE_SELECTOR_RUNTIME_BINDING,
  nativeSelectorRuntimeFactoryOptions,
} from './native-selector-runtime-binding.js'
import { ProviderRefusalReplayLedger } from './dev-replay-ledger.js'
import { readPinnedReplayFile } from './dev-replay-files.js'
import {
  AUTHORED_SCOPE_ROOT,
  AUTHORED_SCOPE_STUDY_ID,
  NATIVE_PRESENCE_ROOT,
  NATIVE_PRESENCE_STUDY_ID,
  NATIVE_SELECTOR_ROOT,
  NATIVE_SELECTOR_STUDY_ID,
  LEGACY_REPLAY_ROOT,
  LEGACY_REPLAY_STUDY_ID,
  replayStudyPolicy,
  type ReplayStudyId,
} from './dev-replay-study-policy.js'

type ProviderRefusalReplayCommand = 'register' | 'run' | 'review' | 'closeout'
interface ProviderRefusalReplayCliOptions {
  command: ProviderRefusalReplayCommand
  screen?: 'dev8' | 'dev12' | 'dev40'
  protocolPath: string
  protocolSha256: string
  allowPaid: boolean
  judgement?: 'advance' | 'stop'
  reason?: string
}

type ReplayAdmission =
  | VerifiedProviderRefusalReplayAdmission
  | VerifiedAuthoredScopeReplayAdmission
  | VerifiedNativePresenceReplayAdmission
  | VerifiedNativeSelectorReplayAdmission

function isQueryPolicyReplayAdmission(
  admission: ReplayAdmission,
): admission is
  | VerifiedAuthoredScopeReplayAdmission
  | VerifiedNativePresenceReplayAdmission
  | VerifiedNativeSelectorReplayAdmission {
  return 'queryPolicy' in admission.protocol
}

export interface ProviderRefusalReplayOfflineCliHooks {
  offlineTestOnly: true
  namespaceRoot: string
  admission: VerifiedProviderRefusalReplayAdmission
  getApiKey: () => string | undefined
  executeScreen: (
    admission: VerifiedProviderRefusalReplayAdmission,
    stage: 'dev8' | 'dev12' | 'dev40',
  ) => Promise<z.infer<typeof devScreenReportSchema>>
  beforeRunnerLock?: (
    namespaceRoot: string,
    ledger: ProviderRefusalReplayLedger,
    admission: VerifiedProviderRefusalReplayAdmission,
    stage: 'dev8' | 'dev12' | 'dev40',
  ) => Promise<void>
  removeLaunchRoot?: (launchRoot: string) => Promise<void>
}

export interface DevReplayOfflineCliHooks {
  offlineTestOnly: true
  studyId: ReplayStudyId
  namespaceRoot: string
  admission: ReplayAdmission
  getApiKey: () => string | undefined
  executeScreen: (
    admission: ReplayAdmission,
    stage: 'dev8' | 'dev12' | 'dev40',
  ) => Promise<z.infer<typeof devScreenReportSchema>>
  beforeRunnerLock?: (
    namespaceRoot: string,
    ledger: DevReplayLedger,
    admission: ReplayAdmission,
    stage: 'dev8' | 'dev12' | 'dev40',
  ) => Promise<void>
  removeLaunchRoot?: (launchRoot: string) => Promise<void>
}

function testNamespaceRoot(studyId: ReplayStudyId, hooks?: DevReplayOfflineCliHooks): string {
  const policy = replayStudyPolicy(studyId)
  const productionRoots = new Set([
    resolve(LEGACY_REPLAY_ROOT),
    resolve(AUTHORED_SCOPE_ROOT),
    resolve(NATIVE_PRESENCE_ROOT),
    resolve(NATIVE_SELECTOR_ROOT),
  ])
  if (!hooks) return resolve(policy.canonicalRoot)
  const root = resolve(hooks.namespaceRoot)
  const relativeToTemp = relative(resolve(tmpdir()), root)
  if (
    hooks.offlineTestOnly !== true ||
    hooks.studyId !== studyId ||
    productionRoots.has(root) ||
    relativeToTemp === '' ||
    basename(root) !== basename(policy.canonicalRoot) ||
    isAbsolute(relativeToTemp) ||
    relativeToTemp === '..' ||
    relativeToTemp.startsWith(`..${sep}`)
  )
    throw new RangeError('Offline CLI hooks require a disposable temporary namespace')
  return root
}

async function assertOfflineRootIsPhysicalDirectory(root: string): Promise<void> {
  const parent = dirname(root)
  const parentInfo = await lstat(parent)
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (await realpath(parent)) !== parent
  )
    throw new RangeError('Offline CLI namespace parent is not canonical')
  try {
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(root)) !== root)
      throw new RangeError('Offline CLI namespace is not canonical')
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
  }
}

export function assertProviderRefusalReplayStageTransition(input: {
  stage: 'dev8' | 'dev12' | 'dev40'
  launchedStages: readonly ('dev8' | 'dev12' | 'dev40')[]
  reviewJudgements: Readonly<Partial<Record<'dev8' | 'dev12' | 'dev40', 'advance' | 'stop'>>>
  terminalStop: boolean
}): void {
  if (input.terminalStop) throw new RangeError('Terminal replay stop forbids additional launches')
  const order = ['dev8', 'dev12', 'dev40'] as const
  const targetIndex = order.indexOf(input.stage)
  if (input.launchedStages.some((item) => order.indexOf(item) >= targetIndex))
    throw new RangeError('A replay stage launch cannot be repeated or skipped out of order')
  for (const prior of order.slice(0, targetIndex)) {
    if (!input.launchedStages.includes(prior) || input.reviewJudgements[prior] !== 'advance')
      throw new RangeError(`${input.stage} requires reviewed advancement through ${prior}`)
  }
}

const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u)
const screenSchema = z.enum(['dev8', 'dev12', 'dev40'])
const closureSchema = z
  .object({
    schema: z.literal('h8a-producer-closure-files-v1'),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            sha256: DIGEST,
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    sourceFiles: z
      .array(
        z
          .object({
            path: z.string().min(1),
            sha256: DIGEST,
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .passthrough()
const reviewSchema = z
  .object({
    schema: z.literal('h8a-dev-screen-review-v1'),
    screenReportSha256: DIGEST,
    reviewProtocol: z.literal('no-apparent-collapse-main-review-v1'),
    reviewerId: z.literal('main-orchestrator'),
    judgement: z.enum(['advance', 'stop']),
    reason: z.string().min(1).max(1000),
    reviewSha256: DIGEST,
  })
  .strict()
const bindingBodySchema = z
  .object({
    schema: z.enum([
      'h8a-provider-refusal-replay-study-binding-v1',
      'h8a-authored-scope-replay-study-binding-v1',
      'h8a-native-presence-replay-study-binding-v1',
      'h8a-native-selector-replay-study-binding-v1',
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
    protocolSha256: DIGEST,
    parentAuditSha256: DIGEST,
    freezeSha256: DIGEST,
    annotationSha256: DIGEST,
    selectionSha256: DIGEST,
    producerClosureSha256: DIGEST,
    runtimeProofSha256: DIGEST,
    runtimeEnvironmentSha256: DIGEST,
    policySha256: DIGEST,
    runtimeBinding: z
      .union([
        z
          .object({
            candidateProfileId: z.literal('h8a-cpu-native-presence-flat-v4'),
            recipeId: z.literal('h8a-cpu-flat-target-v2'),
            queryPolicyId: z.literal('strict-authored-scope-v1'),
            presencePolicyId: z.literal('control-binary-v1'),
          })
          .strict(),
        z
          .object({
            candidateProfileId: z.literal('h8a-cpu-native-selector-flat-v5'),
            recipeId: z.literal('h8a-cpu-flat-target-v2'),
            queryPolicyId: z.literal('strict-authored-scope-v1'),
            presencePolicyId: z.literal('control-binary-v1'),
            selectionPolicyId: z.literal('native-categorical-all-stages-v1'),
          })
          .strict(),
      ])
      .optional(),
    deadlineIso: z.string().datetime({ offset: true }),
    freezeCommitmentSha256: DIGEST,
  })
  .strict()
const bindingSchema = bindingBodySchema.extend({ bindingSha256: DIGEST }).strict()
export const REQUIRED_REPLAY_CLOSURE_PATHS = Object.freeze([
  'benchmarks/v03/h8a-fresh-comparison/dev-replay-study-policy.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-replay-files.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-replay-admission.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-replay-ledger.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-replay-cli.ts',
  'benchmarks/v03/h8a-fresh-comparison/authored-scope-replay-cli.ts',
  'benchmarks/v03/h8a-fresh-comparison/provider-refusal-replay-cli.ts',
  'benchmarks/v03/h8a-fresh-comparison/freeze-admission.ts',
  'benchmarks/v03/h8a-fresh-comparison/profiles.ts',
  'benchmarks/v03/h8a-fresh-comparison/constants.ts',
  'benchmarks/v03/h6-query-policy.ts',
  'benchmarks/v03/h6-context-composer.ts',
  'benchmarks/v03/h8a-fresh-comparison/evaluator.ts',
  'benchmarks/v03/h8a-fresh-comparison/annotation-digest.ts',
  'benchmarks/v03/h8a-fresh-comparison/freeze-commitment.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-sampling.ts',
  'benchmarks/v03/h8a-fresh-comparison/ui-state-zero-query-execution-v2.ts',
  'benchmarks/v03/h8a-fresh-comparison/provider-refusal-replay-admission.ts',
  'benchmarks/v03/h8a-fresh-comparison/provider-refusal-replay-ledger.ts',
  'benchmarks/v03/h8a-fresh-comparison/provider-refusal-replay.ts',
  'benchmarks/v03/h8a-fresh-comparison/schemas.ts',
  'benchmarks/v03/h8a-fresh-comparison/runtime-ports.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-closeout-assembly.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-cli.ts',
  'benchmarks/v03/h8a-fresh-comparison/campaign-fetch-boundary.ts',
  'benchmarks/v03/h8a-fresh-comparison/campaign-ledger-port.ts',
  'benchmarks/v03/h8a-fresh-comparison/atomic-json-ledger.ts',
] as const)
export function assertRequiredReplayClosure(
  paths: readonly string[],
  studyId?: ReplayStudyId,
): void {
  const pathSet = new Set(paths)
  const nativeRequired = [
    'benchmarks/v03/h8a-fresh-comparison/native-presence-replay-cli.ts',
    'benchmarks/v03/h8a-fresh-comparison/dev-replay-retarget.ts',
    'benchmarks/v03/h8a-fresh-comparison/runtime-recording.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-presence-evidence.ts',
    'benchmarks/v03/h6-presence-policy.ts',
    'docs/research/v03-native-presence-hypothesis.ru.md',
  ]
  const selectorRequired = [
    'benchmarks/v03/h8a-fresh-comparison/native-selector-replay-cli.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-selector-qual-cli.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-selector-qual-protocol.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-selector-qual-admission.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-selector-qual-ledger.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-selector-qual-runner.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-selector-runtime-binding.ts',
    'benchmarks/v03/h8a-fresh-comparison/native-presence-evidence.ts',
    'benchmarks/v02/native-selector-wire-evidence.ts',
    'benchmarks/v02/recording.ts',
    'benchmarks/v03/h8a-fresh-comparison/runtime-recording.ts',
    'benchmarks/v03/fresh-dev/imaging.py',
    'benchmarks/v03/fresh-dev/validation.py',
    'benchmarks/v03/h6-presence-policy.ts',
    'benchmarks/v03/h6-query-policy.ts',
    'benchmarks/v03/h6-context-composer.ts',
    'docs/research/v03-native-selector-hypothesis.ru.md',
  ]
  if (
    REQUIRED_REPLAY_CLOSURE_PATHS.some((path) => !pathSet.has(path)) ||
    (studyId === NATIVE_PRESENCE_STUDY_ID && nativeRequired.some((path) => !pathSet.has(path))) ||
    (studyId === NATIVE_SELECTOR_STUDY_ID && selectorRequired.some((path) => !pathSet.has(path)))
  )
    throw new RangeError('Replay producer closure omits a shared runner or evaluation dependency')
}
const launchSchema = z
  .object({
    schema: z.enum([
      'h8a-provider-refusal-replay-launch-intent-v1',
      'h8a-authored-scope-replay-launch-intent-v1',
      'h8a-native-presence-replay-launch-intent-v1',
      'h8a-native-selector-replay-launch-intent-v1',
    ]),
    stage: screenSchema,
    protocolSha256: DIGEST,
    freezeCommitmentSha256: DIGEST,
    startedAtIso: z.string().datetime({ offset: true }),
  })
  .strict()
const terminalSchema = z
  .object({
    schema: z.enum([
      'h8a-provider-refusal-replay-terminal-stop-v1',
      'h8a-authored-scope-replay-terminal-stop-v1',
      'h8a-native-presence-replay-terminal-stop-v1',
      'h8a-native-selector-replay-terminal-stop-v1',
    ]),
    stage: screenSchema,
    protocolSha256: DIGEST,
    stoppedAtIso: z.string().datetime({ offset: true }),
    errorCode: z.string().regex(/^[A-Z0-9_:-]{1,80}$/u),
    physicalDispatchCount: z.number().int().nonnegative(),
    uncertainPhysicalDispatchCount: z.number().int().nonnegative(),
    logicalAttemptCount: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownReserveUsd: z.number().finite().nonnegative(),
    runtimeDisposed: z.boolean(),
    temporaryCleanup: z.enum(['removed', 'unresolved']),
    ownedLaunchRoot: z.string().min(1).nullable(),
  })
  .strict()

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function replaySchemaName(studyId: ReplayStudyId, suffix: string): string {
  const name = replayStudyPolicy(studyId).ledgerSchema.replace(/ledger-v1$/u, `${suffix}-v1`)
  if (
    !/^h8a-(?:provider-refusal|authored-scope|native-presence|native-selector)-replay-[a-z0-9-]+-v1$/u.test(
      name,
    )
  )
    throw new RangeError('Replay schema family is outside the closed registry')
  return name
}
export function safeReplayErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR'
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : 'EXECUTION_FAILED'
}
export function replayRuntimeBinding(studyId: ReplayStudyId) {
  const policy = replayStudyPolicy(studyId)
  if (studyId === NATIVE_SELECTOR_STUDY_ID) return NATIVE_SELECTOR_RUNTIME_BINDING
  if (studyId === NATIVE_PRESENCE_STUDY_ID)
    return {
      candidateProfileId: policy.candidateProfileId,
      recipeId: PROFILE_FLAT_CANDIDATE_ID,
      queryPolicyId: 'strict-authored-scope-v1',
      presencePolicyId: 'control-binary-v1',
    } as const
  if (studyId === AUTHORED_SCOPE_STUDY_ID)
    return {
      candidateProfileId: policy.candidateProfileId,
      recipeId: PROFILE_FLAT_CANDIDATE_ID,
      queryPolicyId: 'strict-authored-scope-v1',
    } as const
  return {
    candidateProfileId: policy.candidateProfileId,
    recipeId: PROFILE_FLAT_CANDIDATE_ID,
    queryPolicyId: 'legacy-v1',
  } as const
}
function assertDeadline(deadlineIso: string, now = Date.now()): void {
  if (!Number.isFinite(Date.parse(deadlineIso)) || now >= Date.parse(deadlineIso))
    throw new RangeError('Replay deadline is closed')
}
function parseArgs(args: readonly string[]): ProviderRefusalReplayCliOptions {
  const command = args[0]
  if (command !== 'register' && command !== 'run' && command !== 'review' && command !== 'closeout')
    throw new RangeError('Expected register, run, review, or closeout')
  let screen: ProviderRefusalReplayCliOptions['screen']
  let protocolPath: string | undefined
  let protocolSha256: string | undefined
  let allowPaid = false
  let judgement: ProviderRefusalReplayCliOptions['judgement']
  let reason: string | undefined
  for (let index = 1; index < args.length; index++) {
    const token = args[index]
    if (
      (command === 'run' || command === 'review') &&
      !screen &&
      (token === 'dev8' || token === 'dev12' || token === 'dev40')
    )
      screen = token
    else if (token === '--protocol') protocolPath = args[++index]
    else if (token === '--protocol-sha256') protocolSha256 = args[++index]
    else if (token === '--allow-paid') allowPaid = true
    else if (token === '--judgement') {
      const value = args[++index]
      if (value !== 'advance' && value !== 'stop')
        throw new RangeError('Review judgement must be advance or stop')
      judgement = value
    } else if (token === '--reason') reason = args[++index]
    else throw new RangeError('Unknown replay CLI argument')
  }
  if (!protocolPath || !protocolSha256 || !DIGEST.safeParse(protocolSha256).success)
    throw new RangeError('An explicit pinned --protocol and --protocol-sha256 are required')
  if ((command === 'run') !== allowPaid)
    throw new RangeError('Only run requires the explicit --allow-paid switch')
  if ((command === 'run' || command === 'review') !== Boolean(screen))
    throw new RangeError('Run and review require exactly one DEV screen')
  if (command === 'review' && (!judgement || !reason))
    throw new RangeError('Review requires a judgement and reason')
  if (command !== 'review' && (judgement || reason))
    throw new RangeError('Review fields are only valid for review')
  return {
    command,
    ...(screen ? { screen } : {}),
    protocolPath,
    protocolSha256,
    allowPaid,
    ...(judgement ? { judgement } : {}),
    ...(reason ? { reason } : {}),
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
async function writeImmutable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = `${JSON.stringify(value)}\n`
  try {
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if ((await readFile(path, 'utf8')) !== bytes)
      throw new RangeError('Replay artifact is immutable and conflicts with existing bytes')
  }
}

export async function writePinnedReplayArtifact(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  const ownedBytes = Uint8Array.from(bytes)
  if (!DIGEST.safeParse(expectedSha256).success || sha256(ownedBytes) !== expectedSha256)
    throw new RangeError('Pinned replay artifact bytes do not match their declared digest')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, ownedBytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if (!(await readFile(path)).equals(ownedBytes))
      throw new RangeError('Replay artifact is immutable and conflicts with existing bytes')
  }
}

async function verifyClosure(admission: ReplayAdmission, repositoryRoot: string): Promise<void> {
  const closureBytes = await readPinnedReplayFile(
    admission.protocol.producerClosure.path,
    admission.protocol.producerClosure.sha256,
    4 * 1024 * 1024,
  )
  const raw = JSON.parse(closureBytes.toString('utf8')) as unknown
  const closure = closureSchema.parse(raw)
  const files = closure.files ?? closure.sourceFiles ?? []
  const paths = files.map((item) => item.path)
  if (files.length === 0 || new Set(paths).size !== paths.length)
    throw new RangeError('Replay producer closure is empty or repeats a source path')
  assertLiveRunnerClosure(paths)
  assertRequiredReplayClosure(paths, admission.protocol.studyId)
  const repository = resolve(repositoryRoot)
  if ((await realpath(repository)) !== repository)
    throw new RangeError('Replay source root is symlinked or aliased')
  const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()
  if (currentCommit !== closure.sourceCommit)
    throw new RangeError('Replay producer closure commit differs from the current checkout')
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repository,
    encoding: 'utf8',
  })
  if (status.trim().length > 0) throw new RangeError('Replay source checkout is not clean')
  for (const item of files) {
    if (isAbsolute(item.path) || item.path.split(/[\\/]/u).some((part) => part === '..'))
      throw new RangeError('Replay producer closure contains an escaping source path')
    const absolute = resolve(repository, item.path)
    const relativePath = relative(repository, absolute)
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`))
      throw new RangeError('Replay producer closure source path escaped repository root')
    const bytes = await readPinnedReplayFile(absolute, item.sha256, 16 * 1024 * 1024)
    if (bytes.length !== item.bytes)
      throw new RangeError('Replay producer closure differs from current source bytes')
  }
}

/** Verify the exact live source tree for the selected V5 DEV/QUAL producer closure. */
export async function verifyNativeSelectorQualSourceClosure(input: {
  closurePath: string
  closureSha256: string
  expectedSourceCommit: string
  repositoryRoot: string
}): Promise<void> {
  const bytes = await readPinnedReplayFile(input.closurePath, input.closureSha256, 4 * 1024 * 1024)
  const closure = closureSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
  if (closure.sourceCommit !== input.expectedSourceCommit)
    throw new RangeError('QUAL producer closure commit differs from its selected DEV parent')
  const files = closure.files ?? closure.sourceFiles ?? []
  const paths = files.map((item) => item.path)
  if (files.length === 0 || new Set(paths).size !== paths.length)
    throw new RangeError('QUAL producer closure is empty or repeats a source path')
  assertLiveRunnerClosure(paths)
  assertRequiredReplayClosure(paths, NATIVE_SELECTOR_STUDY_ID)
  const repository = resolve(input.repositoryRoot)
  if ((await realpath(repository)) !== repository)
    throw new RangeError('QUAL source root is symlinked or aliased')
  const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()
  if (currentCommit !== closure.sourceCommit)
    throw new RangeError('QUAL producer closure commit differs from the current checkout')
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repository,
    encoding: 'utf8',
  })
  if (status.trim().length > 0) throw new RangeError('QUAL source checkout is not clean')
  for (const item of files) {
    if (isAbsolute(item.path) || item.path.split(/[\\/]/u).some((part) => part === '..'))
      throw new RangeError('QUAL producer closure contains an escaping source path')
    const absolute = resolve(repository, item.path)
    const relativePath = relative(repository, absolute)
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`))
      throw new RangeError('QUAL producer closure source path escaped repository root')
    const current = await readPinnedReplayFile(absolute, item.sha256, 16 * 1024 * 1024)
    if (current.length !== item.bytes)
      throw new RangeError('QUAL producer closure differs from current source bytes')
  }
}

async function writeRegistration(
  admission: ReplayAdmission,
  repositoryRoot: string,
  root: string,
  offlineTestOnly: boolean,
): Promise<void> {
  const policy = replayStudyPolicy(admission.protocol.studyId)
  assertDeadline(admission.protocol.deadlineIso)
  if (!offlineTestOnly) await verifyClosure(admission, repositoryRoot)
  assertDeadline(admission.protocol.deadlineIso)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await realpath(root)) !== root) throw new RangeError('Replay namespace is aliased')
  const admissionRoot = join(root, 'admission')
  await mkdir(admissionRoot, { recursive: true, mode: 0o700 })
  const freezeRoot = join(admissionRoot, 'freeze')
  await mkdir(freezeRoot, { recursive: true, mode: 0o700 })
  const registration = {
    schema: replaySchemaName(policy.studyId, 'study-binding'),
    studyId: admission.protocol.studyId,
    freezeId: admission.protocol.freezeId,
    protocolSha256: admission.protocolSha256,
    parentAuditSha256: admission.protocol.parentAudit.sha256,
    freezeSha256: admission.protocol.freeze.sha256,
    annotationSha256: admission.protocol.annotations.sha256,
    selectionSha256: admission.protocol.selection.sha256,
    producerClosureSha256: admission.protocol.producerClosure.sha256,
    runtimeProofSha256: admission.protocol.runtimeProof.sha256,
    runtimeEnvironmentSha256: admission.protocol.runtimeEnvironment.sha256,
    policySha256: admission.protocol.executionPolicy,
    ...(admission.protocol.studyId === NATIVE_PRESENCE_STUDY_ID ||
    admission.protocol.studyId === NATIVE_SELECTOR_STUDY_ID
      ? { runtimeBinding: replayRuntimeBinding(admission.protocol.studyId) }
      : {}),
    deadlineIso: admission.protocol.deadlineIso,
    freezeCommitmentSha256: admission.freezeCommitmentSha256,
  }
  const bindingHash = sha256(JSON.stringify(registration))
  for (const item of [
    admission.protocol.freeze,
    admission.protocol.annotations,
    admission.protocol.selection,
  ]) {
    const bytes = await readPinnedReplayFile(item.path, item.sha256, 16 * 1024 * 1024)
    const name =
      item === admission.protocol.freeze
        ? 'phase-freeze.json'
        : item === admission.protocol.annotations
          ? 'evaluator-private-annotations.json'
          : 'dev-screen-selection.json'
    await writePinnedReplayArtifact(join(freezeRoot, name), bytes, item.sha256)
  }
  await writeImmutable(join(admissionRoot, 'study-binding.json'), {
    ...registration,
    bindingSha256: bindingHash,
  })
  await DevReplayLedger.register({
    studyId: policy.studyId,
    root: join(root, 'admission', 'successor-campaign'),
    ...(offlineTestOnly ? { offlineTestOnly: true } : {}),
    protocolSha256: admission.protocolSha256,
    caseIds: admission.freeze.producerCases.map((row) => row.opaqueCaseId),
  })
}

async function readRegisteredBinding(root: string, admission: ReplayAdmission): Promise<void> {
  const binding = bindingSchema.parse(await readJson(join(root, 'admission', 'study-binding.json')))
  const { bindingSha256, ...body } = binding
  if (
    binding.studyId !== admission.protocol.studyId ||
    binding.freezeId !== admission.protocol.freezeId ||
    binding.schema !== replaySchemaName(admission.protocol.studyId, 'study-binding') ||
    binding.protocolSha256 !== admission.protocolSha256 ||
    (admission.protocol.studyId === NATIVE_PRESENCE_STUDY_ID &&
      JSON.stringify(binding.runtimeBinding) !==
        JSON.stringify(replayRuntimeBinding(NATIVE_PRESENCE_STUDY_ID))) ||
    (admission.protocol.studyId === NATIVE_SELECTOR_STUDY_ID &&
      JSON.stringify(binding.runtimeBinding) !==
        JSON.stringify(replayRuntimeBinding(NATIVE_SELECTOR_STUDY_ID))) ||
    (admission.protocol.studyId !== NATIVE_PRESENCE_STUDY_ID &&
      admission.protocol.studyId !== NATIVE_SELECTOR_STUDY_ID &&
      binding.runtimeBinding !== undefined) ||
    sha256(JSON.stringify(body)) !== bindingSha256
  )
    throw new RangeError('Replay namespace binding does not match the supplied protocol')
}

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path)
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return undefined
    throw error
  }
}

async function readStageReport(
  root: string,
  admission: ReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
) {
  const report = devScreenReportSchema.parse(
    await readJson(join(root, 'execution', 'reports', `${stage}-report.json`)),
  )
  const { reportSha256, ...body } = report
  if (
    report.screen !== stage ||
    report.freezeCommitmentSha256 !== admission.freezeCommitmentSha256 ||
    report.selectionCommitmentSha256 !== admission.selection.selectionCommitmentSha256 ||
    sha256(JSON.stringify(body)) !== reportSha256
  )
    throw new RangeError('Stage report does not match the active freeze and selection')
  return report
}

async function readStageReview(
  root: string,
  admission: ReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
) {
  const report = await readStageReport(root, admission, stage)
  const review = reviewSchema.parse(
    await readJson(join(root, 'execution', 'reviews', `${stage}-review.json`)),
  )
  const { reviewSha256, ...body } = review
  if (
    review.screenReportSha256 !== report.reportSha256 ||
    sha256(JSON.stringify(body)) !== reviewSha256
  )
    throw new RangeError('Stage review hash or report binding is invalid')
  return { report, review }
}

async function assertStageLaunch(
  root: string,
  admission: ReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
): Promise<boolean> {
  const raw = await optionalJson(join(root, 'execution', 'launch-intents', `${stage}.json`))
  if (raw === undefined) return false
  const launch = launchSchema.parse(raw)
  if (
    launch.schema !== replaySchemaName(admission.protocol.studyId, 'launch-intent') ||
    launch.stage !== stage ||
    launch.protocolSha256 !== admission.protocolSha256 ||
    launch.freezeCommitmentSha256 !== admission.freezeCommitmentSha256
  )
    throw new RangeError('Launch intent does not match current protocol and freeze')
  return true
}

function parseTerminalStop(admission: ReplayAdmission, value: unknown) {
  const terminal = terminalSchema.parse(value)
  if (
    terminal.schema !== replaySchemaName(admission.protocol.studyId, 'terminal-stop') ||
    terminal.protocolSha256 !== admission.protocolSha256
  )
    throw new RangeError('Terminal stop belongs to a different replay study or protocol')
  return terminal
}

async function runStage(
  admission: ReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
  repositoryRoot: string,
  root: string,
  hooks?: DevReplayOfflineCliHooks,
): Promise<void> {
  assertDeadline(admission.protocol.deadlineIso)
  if (!hooks) await verifyClosure(admission, repositoryRoot)
  await readRegisteredBinding(root, admission)
  const terminalRaw = await optionalJson(join(root, 'execution', 'terminal-stop.json'))
  const terminal = terminalRaw === undefined ? undefined : parseTerminalStop(admission, terminalRaw)
  if (terminal) throw new RangeError('A terminal replay stop forbids a new stage launch')
  const stages = ['dev8', 'dev12', 'dev40'] as const
  const reviews = new Map<string, z.infer<typeof reviewSchema>>()
  const launchedStages: Array<'dev8' | 'dev12' | 'dev40'> = []
  for (const current of stages) {
    const launched = await assertStageLaunch(root, admission, current)
    if (launched) launchedStages.push(current)
    const reportRaw = await optionalJson(
      join(root, 'execution', 'reports', `${current}-report.json`),
    )
    const reviewRaw = await optionalJson(
      join(root, 'execution', 'reviews', `${current}-review.json`),
    )
    if ((reportRaw !== undefined || reviewRaw !== undefined) && !launched)
      throw new RangeError('Replay report or review exists without its bound launch intent')
    if (launched && reportRaw === undefined) {
      const ledger = await DevReplayLedger.register({
        studyId: admission.protocol.studyId,
        root: join(root, 'admission', 'successor-campaign'),
        ...(hooks ? { offlineTestOnly: true } : {}),
        protocolSha256: admission.protocolSha256,
        caseIds: admission.freeze.producerCases.map((row) => row.opaqueCaseId),
      })
      const releaseOrphanLock = await acquireExclusiveFileLock(
        join(root, '.provider-refusal-replay-runner.lock'),
        true,
      )
      try {
        const currentTerminal = await optionalJson(join(root, 'execution', 'terminal-stop.json'))
        if (currentTerminal !== undefined)
          throw new RangeError('A terminal replay stop forbids another launch')
        const stillLaunched = await assertStageLaunch(root, admission, current)
        const currentReport = await optionalJson(
          join(root, 'execution', 'reports', `${current}-report.json`),
        )
        if (stillLaunched && currentReport === undefined) {
          await ledger.markCrashWithPendingDispatch()
          const snapshot = ledger.snapshot()
          await writeImmutable(
            join(root, 'execution', 'terminal-stop.json'),
            parseTerminalStop(admission, {
              schema: replaySchemaName(admission.protocol.studyId, 'terminal-stop'),
              stage: current,
              protocolSha256: admission.protocolSha256,
              stoppedAtIso: new Date().toISOString(),
              errorCode: 'ORPHAN_LAUNCH_INTENT',
              physicalDispatchCount: snapshot.physicalDispatchCount,
              uncertainPhysicalDispatchCount: ledger.uncertainDispatchCount(),
              logicalAttemptCount: snapshot.logicalAttemptCount,
              knownCostUsd: snapshot.knownCostUsd,
              unknownReserveUsd: snapshot.unknownReserveUsd,
              runtimeDisposed: false,
              temporaryCleanup: 'unresolved',
              ownedLaunchRoot: null,
            }),
          )
        }
      } finally {
        await releaseOrphanLock()
      }
      throw new RangeError('An orphan launch intent was sealed or stage state changed')
    }
    if (reportRaw !== undefined) await readStageReport(root, admission, current)
    if (reviewRaw !== undefined) {
      const verified = await readStageReview(root, admission, current)
      reviews.set(current, verified.review)
    }
  }
  assertProviderRefusalReplayStageTransition({
    stage,
    launchedStages,
    reviewJudgements: Object.fromEntries([...reviews].map(([id, item]) => [id, item.judgement])),
    terminalStop: false,
  })
  assertDeadline(admission.protocol.deadlineIso)
  const ledger = await DevReplayLedger.register({
    studyId: admission.protocol.studyId,
    root: join(root, 'admission', 'successor-campaign'),
    ...(hooks ? { offlineTestOnly: true } : {}),
    protocolSha256: admission.protocolSha256,
    caseIds: admission.freeze.producerCases.map((row) => row.opaqueCaseId),
  })
  assertDeadline(admission.protocol.deadlineIso)
  ledger.assertResumeAllowed()
  const runtime = hooks?.executeScreen
    ? undefined
    : await verifyRuntimeProof(
        {
          runtimeFilesPath: admission.protocol.runtimeProof.path,
          runtimeFilesSha256: admission.protocol.runtimeProof.sha256,
        },
        UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
        repositoryRoot,
        true,
        {
          runtimeFilesSha256: admission.protocol.runtimeProof.sha256,
          runtimeEnvironmentSha256: admission.protocol.runtimeEnvironment.sha256,
        },
      )
  assertDeadline(admission.protocol.deadlineIso)
  const apiKey = hooks ? hooks.getApiKey() : process.env.OPENROUTER_API_KEY
  if (!apiKey)
    throw new RangeError('Required provider key environment variable OPENROUTER_API_KEY is unset')
  assertDeadline(admission.protocol.deadlineIso)
  await hooks?.beforeRunnerLock?.(root, ledger, admission, stage)
  const release = await acquireExclusiveFileLock(
    join(root, '.provider-refusal-replay-runner.lock'),
    true,
  )
  let launchRoot: string
  try {
    assertDeadline(admission.protocol.deadlineIso)
    await readRegisteredBinding(root, admission)
    if ((await optionalJson(join(root, 'execution', 'terminal-stop.json'))) !== undefined)
      throw new RangeError('A terminal replay stop forbids a new stage launch')
    const lockedLaunches: Array<'dev8' | 'dev12' | 'dev40'> = []
    const lockedReviews: Partial<Record<'dev8' | 'dev12' | 'dev40', 'advance' | 'stop'>> = {}
    for (const current of ['dev8', 'dev12', 'dev40'] as const) {
      if (await assertStageLaunch(root, admission, current)) lockedLaunches.push(current)
      const reportRaw = await optionalJson(
        join(root, 'execution', 'reports', `${current}-report.json`),
      )
      if (lockedLaunches.includes(current) && reportRaw === undefined) {
        await ledger.markCrashWithPendingDispatch()
        const snapshot = ledger.snapshot()
        const orphanStop = parseTerminalStop(admission, {
          schema: replaySchemaName(admission.protocol.studyId, 'terminal-stop'),
          stage: current,
          protocolSha256: admission.protocolSha256,
          stoppedAtIso: new Date().toISOString(),
          errorCode: 'ORPHAN_LAUNCH_INTENT',
          physicalDispatchCount: snapshot.physicalDispatchCount,
          uncertainPhysicalDispatchCount: ledger.uncertainDispatchCount(),
          logicalAttemptCount: snapshot.logicalAttemptCount,
          knownCostUsd: snapshot.knownCostUsd,
          unknownReserveUsd: snapshot.unknownReserveUsd,
          runtimeDisposed: false,
          temporaryCleanup: 'unresolved',
          ownedLaunchRoot: null,
        })
        await writeImmutable(join(root, 'execution', 'terminal-stop.json'), orphanStop)
        throw new RangeError('An orphan launch intent was sealed as a terminal replay stop')
      }
      if (reportRaw !== undefined) await readStageReport(root, admission, current)
      const reviewRaw = await optionalJson(
        join(root, 'execution', 'reviews', `${current}-review.json`),
      )
      if (reviewRaw !== undefined)
        lockedReviews[current] = (await readStageReview(root, admission, current)).review.judgement
    }
    assertProviderRefusalReplayStageTransition({
      stage,
      launchedStages: lockedLaunches,
      reviewJudgements: lockedReviews,
      terminalStop: false,
    })
    launchRoot = await mkdtemp(join(root, '.provider-refusal-replay-launch-'))
  } catch (error) {
    await release()
    throw error
  }
  const executionRoot = join(root, 'execution')
  const controller = new AbortController()
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('Process interrupted'))
  }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  const launch = launchSchema.parse({
    schema: replaySchemaName(admission.protocol.studyId, 'launch-intent'),
    stage,
    protocolSha256: admission.protocolSha256,
    freezeCommitmentSha256: admission.freezeCommitmentSha256,
    startedAtIso: new Date().toISOString(),
  })
  let failure: unknown
  let runtimePorts: Awaited<ReturnType<typeof createH8FreshRuntimePorts>> | undefined
  let runtimeDisposed = false
  let temporaryCleanup: 'removed' | 'unresolved' = 'unresolved'
  let retainedLaunchRoot: string | null = launchRoot
  try {
    assertDeadline(admission.protocol.deadlineIso)
    await writeImmutable(join(root, 'execution', 'launch-intents', `${stage}.json`), launch)
    await mkdir(executionRoot, { recursive: true, mode: 0o700 })
    let report: z.infer<typeof devScreenReportSchema>
    if (hooks) report = await hooks.executeScreen(admission, stage)
    else {
      const verifiedRuntime = runtime
      if (!verifiedRuntime) throw new RangeError('Verified runtime proof is missing')
      const historical = await loadHistoricalControl(verifiedRuntime.proof.historicalSourceRoot)
      assertDeadline(admission.protocol.deadlineIso)
      const runtimeBinding = replayRuntimeBinding(admission.protocol.studyId)
      const selectorFactoryOptions =
        admission.protocol.studyId === NATIVE_SELECTOR_STUDY_ID
          ? nativeSelectorRuntimeFactoryOptions()
          : undefined
      if (
        selectorFactoryOptions &&
        JSON.stringify(runtimeBinding) !== JSON.stringify(NATIVE_SELECTOR_RUNTIME_BINDING)
      )
        throw new RangeError('Native-selector runtime binding differs from its closed factory map')
      const candidateProfileId =
        selectorFactoryOptions?.candidateProfileId ?? runtimeBinding.candidateProfileId
      const factoryNativeBinding = selectorFactoryOptions?.nativeRuntime ?? runtimeBinding
      runtimePorts = await createH8FreshRuntimePorts({
        apiKey,
        artifactRoot: executionRoot,
        temporaryRoot: launchRoot,
        maskArtifactDirectory: join(executionRoot, 'masks'),
        cutoutArtifactDirectory: join(executionRoot, 'cutouts'),
        candidateProfileId,
        nativeRuntime: {
          recipeId: factoryNativeBinding.recipeId,
          queryPolicyId: factoryNativeBinding.queryPolicyId,
          ...('presencePolicyId' in factoryNativeBinding
            ? { presencePolicyId: factoryNativeBinding.presencePolicyId }
            : {}),
          pythonExecutable: verifiedRuntime.pythonExecutable,
          assetRoot: verifiedRuntime.candidateAssetsRoot,
        },
        mobileSam: {
          encoderPath: verifiedRuntime.mobileSamEncoderPath,
          decoderPath: verifiedRuntime.mobileSamDecoderPath,
        },
        sourceCanvasByOpaqueCaseId: new Map(
          admission.freeze.producerCases.map((item) => [
            item.opaqueCaseId,
            { width: item.sourceCanvasWidth, height: item.sourceCanvasHeight },
          ]),
        ),
        controlEngine: historical,
        ...(selectorFactoryOptions
          ? { selectionPolicyId: selectorFactoryOptions.selectionPolicyId }
          : {}),
      })
      report = await executeDevScreen({
        freeze: admission.freeze,
        annotations: admission.annotations,
        sourceBytesByCaseId: admission.sourceBytes,
        selection: admission.selection,
        screen: stage,
        selectionPath: join(executionRoot, 'dev-screen-selection.json'),
        artifactRoot: executionRoot,
        ledger,
        candidatePort: runtimePorts.candidatePort,
        controlPort: runtimePorts.controlPort,
        runtimeArtifacts: runtimePorts.artifacts,
        signal: controller.signal,
      })
    }
    const { reportSha256, ...reportBody } = report
    if (sha256(JSON.stringify(reportBody)) !== reportSha256)
      throw new RangeError('Screen report digest failed after execution')
    await writeImmutable(join(executionRoot, 'reports', `${stage}-report.json`), report)
    if (report.completedPairs !== report.expectedPairs || report.hardBlockers.length > 0)
      throw new RangeError('Screen ended incomplete or with hard blockers')
  } catch (error) {
    failure = error
  }
  try {
    await runtimePorts?.dispose()
    runtimeDisposed = true
  } catch (error) {
    failure ??= error
  }
  if (runtimeDisposed) {
    try {
      if (hooks?.removeLaunchRoot) await hooks.removeLaunchRoot(launchRoot)
      else await rm(launchRoot, { recursive: true, force: false })
      temporaryCleanup = 'removed'
      retainedLaunchRoot = null
    } catch (error) {
      failure ??= error
    }
  }
  try {
    if (failure !== undefined) {
      await ledger.markCrashWithPendingDispatch()
      const snapshot = ledger.snapshot()
      const terminal = parseTerminalStop(admission, {
        schema: replaySchemaName(admission.protocol.studyId, 'terminal-stop'),
        stage,
        protocolSha256: admission.protocolSha256,
        stoppedAtIso: new Date().toISOString(),
        errorCode: safeReplayErrorCode(failure),
        physicalDispatchCount: snapshot.physicalDispatchCount,
        uncertainPhysicalDispatchCount: ledger.uncertainDispatchCount(),
        logicalAttemptCount: snapshot.logicalAttemptCount,
        knownCostUsd: snapshot.knownCostUsd,
        unknownReserveUsd: snapshot.unknownReserveUsd,
        runtimeDisposed,
        temporaryCleanup,
        ownedLaunchRoot: retainedLaunchRoot,
      })
      await writeImmutable(join(root, 'execution', 'terminal-stop.json'), terminal)
      throw failure
    }
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    await release()
  }
}

async function reviewStage(
  admission: ReplayAdmission,
  options: ProviderRefusalReplayCliOptions,
  root: string,
): Promise<void> {
  await readRegisteredBinding(root, admission)
  const release = await acquireExclusiveFileLock(
    join(root, '.provider-refusal-replay-runner.lock'),
    true,
  )
  try {
    await reviewStageWithinLock(admission, options, root)
  } finally {
    await release()
  }
}

async function reviewStageWithinLock(
  admission: ReplayAdmission,
  options: ProviderRefusalReplayCliOptions,
  root: string,
): Promise<void> {
  await readRegisteredBinding(root, admission)
  const terminalRaw = await optionalJson(join(root, 'execution', 'terminal-stop.json'))
  const terminal = terminalRaw === undefined ? undefined : parseTerminalStop(admission, terminalRaw)
  if (
    terminal &&
    (options.judgement !== 'stop' || terminal.protocolSha256 !== admission.protocolSha256)
  )
    throw new RangeError('A terminal replay stop permits only a matching STOP review')
  const stage = screenSchema.parse(options.screen)
  if (!(await assertStageLaunch(root, admission, stage)))
    throw new RangeError('Review has no matching stage launch intent')
  const report = await readStageReport(root, admission, stage)
  await sealDevScreenReview(join(root, 'execution'), report, options.judgement!, options.reason!)
  await readStageReview(root, admission, stage)
}

async function closeReplay(
  admission: ReplayAdmission,
  root: string,
  offlineTestOnly: boolean,
): Promise<void> {
  await readRegisteredBinding(root, admission)
  const release = await acquireExclusiveFileLock(
    join(root, '.provider-refusal-replay-runner.lock'),
    true,
  )
  try {
    await closeReplayWithinLock(admission, root, offlineTestOnly)
  } finally {
    await release()
  }
}

async function closeReplayWithinLock(
  admission: ReplayAdmission,
  root: string,
  offlineTestOnly: boolean,
): Promise<void> {
  await readRegisteredBinding(root, admission)
  const terminalRaw = await optionalJson(join(root, 'execution', 'terminal-stop.json'))
  let terminal = terminalRaw === undefined ? undefined : parseTerminalStop(admission, terminalRaw)
  if (terminal && terminal.protocolSha256 !== admission.protocolSha256)
    throw new RangeError('Terminal stop belongs to a different replay protocol')
  const stages = ['dev8', 'dev12', 'dev40'] as const
  const ledger = await DevReplayLedger.register({
    studyId: admission.protocol.studyId,
    root: join(root, 'admission', 'successor-campaign'),
    ...(offlineTestOnly ? { offlineTestOnly: true } : {}),
    protocolSha256: admission.protocolSha256,
    caseIds: admission.freeze.producerCases.map((row) => row.opaqueCaseId),
  })
  if (!terminal) {
    for (const stage of stages) {
      const launched = await assertStageLaunch(root, admission, stage)
      if (!launched) continue
      const reportRaw = await optionalJson(
        join(root, 'execution', 'reports', `${stage}-report.json`),
      )
      if (reportRaw !== undefined) continue
      await ledger.markCrashWithPendingDispatch()
      const snapshot = ledger.snapshot()
      terminal = parseTerminalStop(admission, {
        schema: replaySchemaName(admission.protocol.studyId, 'terminal-stop'),
        stage,
        protocolSha256: admission.protocolSha256,
        stoppedAtIso: new Date().toISOString(),
        errorCode: 'ORPHAN_LAUNCH_INTENT',
        physicalDispatchCount: snapshot.physicalDispatchCount,
        uncertainPhysicalDispatchCount: ledger.uncertainDispatchCount(),
        logicalAttemptCount: snapshot.logicalAttemptCount,
        knownCostUsd: snapshot.knownCostUsd,
        unknownReserveUsd: snapshot.unknownReserveUsd,
        runtimeDisposed: false,
        temporaryCleanup: 'unresolved',
        ownedLaunchRoot: null,
      })
      await writeImmutable(join(root, 'execution', 'terminal-stop.json'), terminal)
      break
    }
  }
  const reviews = new Map<string, z.infer<typeof reviewSchema>>()
  let anyStageLaunched = false
  for (const [index, stage] of stages.entries()) {
    const launched = await assertStageLaunch(root, admission, stage)
    anyStageLaunched ||= launched
    const reportRaw = await optionalJson(join(root, 'execution', 'reports', `${stage}-report.json`))
    const reviewRaw = await optionalJson(join(root, 'execution', 'reviews', `${stage}-review.json`))
    if ((reportRaw !== undefined || reviewRaw !== undefined) && !launched)
      throw new RangeError('Replay report or review exists without its bound launch intent')
    if (launched && reportRaw === undefined && terminal?.stage !== stage)
      throw new RangeError('Replay launch has no report or matching terminal stop')
    if (reportRaw !== undefined) await readStageReport(root, admission, stage)
    if (reviewRaw !== undefined) {
      const verified = await readStageReview(root, admission, stage)
      reviews.set(stage, verified.review)
    }
    if (launched && index > 0 && reviews.get(stages[index - 1]!)?.judgement !== 'advance')
      throw new RangeError('A later stage exists without the immediately preceding advance review')
    if (
      terminal &&
      index > stages.indexOf(terminal.stage) &&
      (launched || reportRaw !== undefined || reviewRaw !== undefined)
    )
      throw new RangeError('Replay stage was launched after terminal stop')
  }
  if (!anyStageLaunched) throw new RangeError('Cannot close a replay with no stage launch intent')
  if (terminal) {
    const snapshot = ledger.snapshot()
    if (
      terminal.physicalDispatchCount !== snapshot.physicalDispatchCount ||
      terminal.uncertainPhysicalDispatchCount !== ledger.uncertainDispatchCount() ||
      terminal.logicalAttemptCount !== snapshot.logicalAttemptCount ||
      terminal.knownCostUsd !== snapshot.knownCostUsd ||
      terminal.unknownReserveUsd !== snapshot.unknownReserveUsd
    )
      throw new RangeError('Terminal stop counters differ from the durable campaign ledger')
  }
  const assembly = await assembleDev40Closeouts({
    freeze: admission.freeze,
    annotations: admission.annotations,
    selection: admission.selection,
    artifactRoot: join(root, 'execution'),
    ledger,
  })
  const candidate = assembly.candidateCloseout
  const control = assembly.controlCloseout
  const masks = new Map(admission.referenceMaskBytes)
  for (const [hash, bytes] of assembly.packedMasksBySha256) masks.set(hash, bytes)
  const rows = joinCloseoutsWithPrivateAnnotations({
    freeze: admission.freeze,
    candidateCloseout: candidate,
    controlCloseout: control,
    annotations: admission.annotations,
    packedMasksBySha256: masks,
  })
  const dev40Gate = evaluateDev40Gate(
    rows,
    replayStudyPolicy(admission.protocol.studyId).candidateProfileId,
  )
  const allStagesReviewedAdvance =
    reviews.size === 3 && [...reviews.values()].every((item) => item.judgement === 'advance')
  const result = {
    schema: replaySchemaName(admission.protocol.studyId, 'dev40-closeout'),
    studyId: admission.protocol.studyId,
    freezeId: admission.protocol.freezeId,
    protocolSha256: admission.protocolSha256,
    candidateCloseoutSha256: candidate.closeoutSha256,
    controlCloseoutSha256: control.closeoutSha256,
    missingPredictionRows: assembly.missingPredictionRows,
    dev40Gate,
    allStageReviewsAdvance: allStagesReviewedAdvance,
    terminalStop: terminal ?? null,
    qualEligible:
      !terminal &&
      assembly.missingPredictionRows === 0 &&
      dev40Gate.qualityPass &&
      allStagesReviewedAdvance,
  }
  await writeImmutable(join(root, 'execution', 'closeout', 'dev40-closeout.json'), result)
}

export async function runProviderRefusalReplayCli(
  args: readonly string[],
  repositoryRoot: string,
  hooks?: ProviderRefusalReplayOfflineCliHooks,
): Promise<void> {
  if (!hooks) return runDevReplayCli(LEGACY_REPLAY_STUDY_ID, args, repositoryRoot)
  if (hooks.offlineTestOnly !== true)
    throw new RangeError('Offline CLI hooks require explicit test-only authority')
  const namespaceRoot = `${hooks.namespaceRoot}`
  const admissionSnapshot = structuredClone(hooks.admission)
  const getApiKey = hooks.getApiKey
  const executeScreen = hooks.executeScreen
  const beforeRunnerLock = hooks.beforeRunnerLock
  const removeLaunchRoot = hooks.removeLaunchRoot
  return runDevReplayCli(LEGACY_REPLAY_STUDY_ID, args, repositoryRoot, {
    offlineTestOnly: true,
    studyId: LEGACY_REPLAY_STUDY_ID,
    namespaceRoot,
    admission: admissionSnapshot,
    getApiKey,
    executeScreen: (admission, stage) => {
      if (isQueryPolicyReplayAdmission(admission))
        throw new RangeError('Legacy replay hook received a foreign admission')
      return executeScreen(admission, stage)
    },
    ...(beforeRunnerLock
      ? {
          beforeRunnerLock: async (namespaceRoot, _ledger, admission, stage) => {
            if (isQueryPolicyReplayAdmission(admission))
              throw new RangeError('Legacy replay hook received a foreign admission')
            const ledger = await ProviderRefusalReplayLedger.register({
              root: join(namespaceRoot, 'admission', 'successor-campaign'),
              offlineTestOnly: true,
              protocolSha256: admission.protocolSha256,
              caseIds: admission.freeze.producerCases.map((row) => row.opaqueCaseId),
            })
            await beforeRunnerLock(namespaceRoot, ledger, admission, stage)
          },
        }
      : {}),
    ...(removeLaunchRoot ? { removeLaunchRoot } : {}),
  })
}

export async function runDevReplayCli(
  studyId: ReplayStudyId,
  args: readonly string[],
  repositoryRoot: string,
  hooks?: DevReplayOfflineCliHooks,
): Promise<void> {
  const ownedArgs = Array.from(args)
  const ownedRepositoryRoot = `${repositoryRoot}`
  const options = parseArgs(ownedArgs)
  const ownedHooks: DevReplayOfflineCliHooks | undefined = hooks
    ? {
        offlineTestOnly: hooks.offlineTestOnly,
        studyId: hooks.studyId,
        namespaceRoot: `${hooks.namespaceRoot}`,
        admission: structuredClone(hooks.admission),
        getApiKey: hooks.getApiKey,
        executeScreen: hooks.executeScreen,
        ...(hooks.beforeRunnerLock ? { beforeRunnerLock: hooks.beforeRunnerLock } : {}),
        ...(hooks.removeLaunchRoot ? { removeLaunchRoot: hooks.removeLaunchRoot } : {}),
      }
    : undefined
  const root = testNamespaceRoot(studyId, ownedHooks)
  if (ownedHooks && ownedHooks.studyId !== studyId)
    throw new RangeError('Offline hooks are bound to a different replay study')
  if (ownedHooks) await assertOfflineRootIsPhysicalDirectory(root)
  const protocolBytes = await readPinnedReplayFile(
    options.protocolPath,
    options.protocolSha256,
    2 * 1024 * 1024,
  ).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'Pinned replay input changed while being read')
      throw new RangeError('Protocol digest does not match explicit CLI pin')
    throw error
  })
  const protocol = parseReplayProtocolForStudy(
    studyId,
    JSON.parse(protocolBytes.toString('utf8')) as unknown,
  )
  const admission = ownedHooks
    ? ownedHooks.admission
    : await verifyDevReplayAdmission({
        studyId,
        protocolPath: options.protocolPath,
        protocolSha256: options.protocolSha256,
        repositoryRoot: ownedRepositoryRoot,
        ...(options.command === 'review' || options.command === 'closeout'
          ? { allowExpiredReadOnly: true }
          : {}),
      })
  if (
    admission.protocol.studyId !== studyId ||
    admission.protocolSha256 !== options.protocolSha256 ||
    JSON.stringify(admission.protocol) !== JSON.stringify(protocol)
  )
    throw new RangeError('Verified admission differs from the explicitly pinned protocol')
  if (options.command === 'register' || options.command === 'run')
    assertDeadline(protocol.deadlineIso)
  if (options.command === 'register')
    await writeRegistration(admission, ownedRepositoryRoot, root, ownedHooks !== undefined)
  else if (options.command === 'run')
    await runStage(admission, options.screen!, ownedRepositoryRoot, root, ownedHooks)
  else if (options.command === 'review') await reviewStage(admission, options, root)
  else await closeReplay(admission, root, ownedHooks !== undefined)
}

export function parseProviderRefusalReplayArgs(
  args: readonly string[],
): ProviderRefusalReplayCliOptions {
  return parseArgs(args)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  runProviderRefusalReplayCli(process.argv.slice(2), repositoryRoot).catch((error: unknown) => {
    process.stderr.write(`${safeReplayErrorCode(error)}\n`)
    process.exitCode = 1
  })
}
