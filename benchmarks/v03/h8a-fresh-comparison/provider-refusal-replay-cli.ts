import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import {
  providerRefusalReplayProtocolSchema,
  verifyProviderRefusalReplayAdmission,
} from './provider-refusal-replay-admission.js'
import type { VerifiedProviderRefusalReplayAdmission } from './provider-refusal-replay-admission.js'
import { ProviderRefusalReplayLedger } from './provider-refusal-replay-ledger.js'

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

const PRODUCTION_NAMESPACE_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/provider-refusal-dev40-replay-v1'

function testNamespaceRoot(hooks?: ProviderRefusalReplayOfflineCliHooks): string {
  if (!hooks) return PRODUCTION_NAMESPACE_ROOT
  const root = resolve(hooks.namespaceRoot)
  const relativeToTemp = relative(resolve(tmpdir()), root)
  if (
    hooks.offlineTestOnly !== true ||
    root === resolve(PRODUCTION_NAMESPACE_ROOT) ||
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
    schema: z.literal('h8a-provider-refusal-replay-study-binding-v1'),
    studyId: z.literal('provider-refusal-dev40-replay-v1'),
    freezeId: z.literal('h8a-provider-refusal-dev40-replay-20261101-v1'),
    protocolSha256: DIGEST,
    parentAuditSha256: DIGEST,
    freezeSha256: DIGEST,
    annotationSha256: DIGEST,
    selectionSha256: DIGEST,
    producerClosureSha256: DIGEST,
    runtimeProofSha256: DIGEST,
    runtimeEnvironmentSha256: DIGEST,
    policySha256: DIGEST,
    deadlineIso: z.string().datetime({ offset: true }),
    freezeCommitmentSha256: DIGEST,
  })
  .strict()
const bindingSchema = bindingBodySchema.extend({ bindingSha256: DIGEST }).strict()
const REQUIRED_REPLAY_CLOSURE_PATHS = [
  'benchmarks/v03/h8a-fresh-comparison/provider-refusal-replay-cli.ts',
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
] as const
const launchSchema = z
  .object({
    schema: z.literal('h8a-provider-refusal-replay-launch-intent-v1'),
    stage: screenSchema,
    protocolSha256: DIGEST,
    freezeCommitmentSha256: DIGEST,
    startedAtIso: z.string().datetime({ offset: true }),
  })
  .strict()
const terminalSchema = z
  .object({
    schema: z.literal('h8a-provider-refusal-replay-terminal-stop-v1'),
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
function safeCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR'
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : 'EXECUTION_FAILED'
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
  if (!DIGEST.safeParse(expectedSha256).success || sha256(bytes) !== expectedSha256)
    throw new RangeError('Pinned replay artifact bytes do not match their declared digest')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if (!(await readFile(path)).equals(bytes))
      throw new RangeError('Replay artifact is immutable and conflicts with existing bytes')
  }
}

async function verifyClosure(
  admission: VerifiedProviderRefusalReplayAdmission,
  repositoryRoot: string,
): Promise<void> {
  const raw = await readJson(admission.protocol.producerClosure.path)
  const closure = closureSchema.parse(raw)
  const files = closure.files ?? closure.sourceFiles ?? []
  const paths = files.map((item) => item.path)
  if (files.length === 0 || new Set(paths).size !== paths.length)
    throw new RangeError('Replay producer closure is empty or repeats a source path')
  assertLiveRunnerClosure(paths)
  const pathSet = new Set(paths)
  if (REQUIRED_REPLAY_CLOSURE_PATHS.some((path) => !pathSet.has(path)))
    throw new RangeError('Replay producer closure omits a refusal-policy or stage runner source')
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
    const info = await lstat(absolute)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 16 * 1024 * 1024 ||
      info.size !== item.bytes ||
      (await realpath(absolute)) !== absolute ||
      sha256(await readFile(absolute)) !== item.sha256
    )
      throw new RangeError('Replay producer closure differs from current source bytes')
  }
}

async function writeRegistration(
  admission: VerifiedProviderRefusalReplayAdmission,
  repositoryRoot: string,
  root: string,
  offlineTestOnly: boolean,
): Promise<void> {
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
    schema: 'h8a-provider-refusal-replay-study-binding-v1',
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
    deadlineIso: admission.protocol.deadlineIso,
    freezeCommitmentSha256: admission.freezeCommitmentSha256,
  }
  const bindingHash = sha256(JSON.stringify(registration))
  for (const item of [
    admission.protocol.freeze,
    admission.protocol.annotations,
    admission.protocol.selection,
  ]) {
    const bytes = await readFile(item.path)
    if (sha256(bytes) !== item.sha256)
      throw new RangeError('Pinned freeze input changed during registration')
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
  await ProviderRefusalReplayLedger.register({
    root: join(root, 'admission', 'successor-campaign'),
    ...(offlineTestOnly ? { offlineTestOnly: true } : {}),
    protocolSha256: admission.protocolSha256,
    caseIds: admission.freeze.producerCases.map((row) => row.opaqueCaseId),
  })
}

async function readRegisteredBinding(root: string, protocolSha256: string): Promise<void> {
  const binding = bindingSchema.parse(await readJson(join(root, 'admission', 'study-binding.json')))
  const { bindingSha256, ...body } = binding
  if (binding.protocolSha256 !== protocolSha256 || sha256(JSON.stringify(body)) !== bindingSha256)
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
  admission: VerifiedProviderRefusalReplayAdmission,
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
  admission: VerifiedProviderRefusalReplayAdmission,
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
  admission: VerifiedProviderRefusalReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
): Promise<boolean> {
  const raw = await optionalJson(join(root, 'execution', 'launch-intents', `${stage}.json`))
  if (raw === undefined) return false
  const launch = launchSchema.parse(raw)
  if (
    launch.stage !== stage ||
    launch.protocolSha256 !== admission.protocolSha256 ||
    launch.freezeCommitmentSha256 !== admission.freezeCommitmentSha256
  )
    throw new RangeError('Launch intent does not match current protocol and freeze')
  return true
}

async function runStage(
  admission: VerifiedProviderRefusalReplayAdmission,
  stage: 'dev8' | 'dev12' | 'dev40',
  repositoryRoot: string,
  root: string,
  hooks?: ProviderRefusalReplayOfflineCliHooks,
): Promise<void> {
  assertDeadline(admission.protocol.deadlineIso)
  if (!hooks) await verifyClosure(admission, repositoryRoot)
  await readRegisteredBinding(root, admission.protocolSha256)
  const terminalRaw = await optionalJson(join(root, 'execution', 'terminal-stop.json'))
  const terminal = terminalRaw === undefined ? undefined : terminalSchema.parse(terminalRaw)
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
      const ledger = await ProviderRefusalReplayLedger.register({
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
            terminalSchema.parse({
              schema: 'h8a-provider-refusal-replay-terminal-stop-v1',
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
  const ledger = await ProviderRefusalReplayLedger.register({
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
    await readRegisteredBinding(root, admission.protocolSha256)
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
        const orphanStop = terminalSchema.parse({
          schema: 'h8a-provider-refusal-replay-terminal-stop-v1',
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
    schema: 'h8a-provider-refusal-replay-launch-intent-v1',
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
      runtimePorts = await createH8FreshRuntimePorts({
        apiKey,
        artifactRoot: executionRoot,
        temporaryRoot: launchRoot,
        maskArtifactDirectory: join(executionRoot, 'masks'),
        cutoutArtifactDirectory: join(executionRoot, 'cutouts'),
        nativeRuntime: {
          recipeId: PROFILE_FLAT_CANDIDATE_ID,
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
      const terminal = terminalSchema.parse({
        schema: 'h8a-provider-refusal-replay-terminal-stop-v1',
        stage,
        protocolSha256: admission.protocolSha256,
        stoppedAtIso: new Date().toISOString(),
        errorCode: safeCode(failure),
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
  admission: VerifiedProviderRefusalReplayAdmission,
  options: ProviderRefusalReplayCliOptions,
  root: string,
): Promise<void> {
  await readRegisteredBinding(root, admission.protocolSha256)
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
  admission: VerifiedProviderRefusalReplayAdmission,
  options: ProviderRefusalReplayCliOptions,
  root: string,
): Promise<void> {
  await readRegisteredBinding(root, admission.protocolSha256)
  const terminalRaw = await optionalJson(join(root, 'execution', 'terminal-stop.json'))
  const terminal = terminalRaw === undefined ? undefined : terminalSchema.parse(terminalRaw)
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
  admission: VerifiedProviderRefusalReplayAdmission,
  root: string,
  offlineTestOnly: boolean,
): Promise<void> {
  await readRegisteredBinding(root, admission.protocolSha256)
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
  admission: VerifiedProviderRefusalReplayAdmission,
  root: string,
  offlineTestOnly: boolean,
): Promise<void> {
  await readRegisteredBinding(root, admission.protocolSha256)
  const terminalRaw = await optionalJson(join(root, 'execution', 'terminal-stop.json'))
  let terminal = terminalRaw === undefined ? undefined : terminalSchema.parse(terminalRaw)
  if (terminal && terminal.protocolSha256 !== admission.protocolSha256)
    throw new RangeError('Terminal stop belongs to a different replay protocol')
  const stages = ['dev8', 'dev12', 'dev40'] as const
  const ledger = await ProviderRefusalReplayLedger.register({
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
      terminal = terminalSchema.parse({
        schema: 'h8a-provider-refusal-replay-terminal-stop-v1',
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
  const dev40Gate = evaluateDev40Gate(rows, PROFILE_FLAT_CANDIDATE_ID)
  const allStagesReviewedAdvance =
    reviews.size === 3 && [...reviews.values()].every((item) => item.judgement === 'advance')
  const result = {
    schema: 'h8a-provider-refusal-replay-dev40-closeout-v1',
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
  const options = parseArgs(args)
  const root = testNamespaceRoot(hooks)
  if (hooks) await assertOfflineRootIsPhysicalDirectory(root)
  const protocolBytes = await readFile(options.protocolPath)
  if (sha256(protocolBytes) !== options.protocolSha256)
    throw new RangeError('Protocol digest does not match explicit CLI pin')
  const protocol = providerRefusalReplayProtocolSchema.parse(
    JSON.parse(protocolBytes.toString('utf8')) as unknown,
  )
  const admission = hooks
    ? hooks.admission
    : await verifyProviderRefusalReplayAdmission({
        protocolPath: options.protocolPath,
        protocolSha256: options.protocolSha256,
        repositoryRoot,
        ...(options.command === 'review' || options.command === 'closeout'
          ? { allowExpiredReadOnly: true }
          : {}),
      })
  if (
    admission.protocolSha256 !== options.protocolSha256 ||
    JSON.stringify(admission.protocol) !== JSON.stringify(protocol)
  )
    throw new RangeError('Verified admission differs from the explicitly pinned protocol')
  if (options.command === 'register' || options.command === 'run')
    assertDeadline(protocol.deadlineIso)
  if (options.command === 'register')
    await writeRegistration(admission, repositoryRoot, root, hooks !== undefined)
  else if (options.command === 'run')
    await runStage(admission, options.screen!, repositoryRoot, root, hooks)
  else if (options.command === 'review') await reviewStage(admission, options, root)
  else await closeReplay(admission, root, hooks !== undefined)
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
    process.stderr.write(`${safeCode(error)}\n`)
    process.exitCode = 1
  })
}
