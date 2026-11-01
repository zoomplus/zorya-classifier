import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { assembleDev40Closeouts } from './dev-closeout-assembly.js'
import {
  acquireRunnerLock,
  assertLiveRunnerClosure,
  loadHistoricalControl,
  verifyRuntimeProof,
} from './dev-screen-cli.js'
import type { VerifiedRuntimeProof } from './dev-screen-cli.js'
import {
  sealDevScreenReview,
  devScreenReportSchema,
  executeDevScreen,
} from './dev-screen-runner.js'
import type { DevScreenId } from './dev-screen-sampling.js'
import {
  assertSuccessorFreezeAdmission,
  assembleIndependentDev40V2FromDisk,
  verifyPersistedIndependentDev40V2,
} from './independent-dev40-freeze.js'
import { SuccessorCampaignLedger } from './successor-campaign-ledger.js'
import { createH8FreshRuntimePorts } from './runtime-ports.js'
import type { SuccessorCampaignAdmissionPort } from './campaign-ledger-port.js'
import { ImmutableCaseArtifactStore } from './case-artifact-store.js'
import { buildCaseArtifactIdentity } from './dev-screen-runner.js'
import {
  PHASE_FLAT_DEV40_ID,
  PROFILE_CONTROL_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  candidateIdForPhase,
} from './constants.js'
import { hashIdentity } from './hash-identity.js'
import { immutableCloseoutSchema } from './schemas.js'

const STUDY_ROOT =
  '/root/.codex/artifacts/zorya-classifier-mcp-20261101/original-h8a-independent-dev40-v2'
const PARENT_ROOT = resolve(dirname(STUDY_ROOT), 'h8a-fresh-dev-qual-campaign-v1')
const PARENT_LEDGER_PATH = join(PARENT_ROOT, 'campaign-ledger.json')
const AUTHORITY_PATH = join(STUDY_ROOT, 'admission', 'independent-dev40-v2-preparation.json')
const FREEZE_DIRECTORY = join(STUDY_ROOT, 'admission', 'freeze-v2')
const SUCCESSOR_ROOT = join(STUDY_ROOT, 'admission', 'successor-campaign-v1')
const RUNTIME_PROOF_PATH = resolve(
  dirname(STUDY_ROOT),
  'main-flat-compare-v2',
  'checked-runtime-files-v2.json',
)
const RUNTIME_PROOF_SHA256 = '278015e2d7a9bbd7f308c865c01a9dc2277ec48d89d118524940f6e0ec389'
const RUNTIME_ENVIRONMENT_SHA256 =
  '1941f16dfb906f54331cc06c8b58bed15b86b65d86f16f7f708b49bc60680ba6'
const SOURCE_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const BINDING_PATH = join(STUDY_ROOT, 'admission', 'successor-study-binding.json')
const JSON_LIMIT = 4 * 1024 * 1024

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const reviewInputSchema = z
  .object({
    screen: z.enum(['dev8', 'dev12', 'dev40']),
    judgement: z.enum(['advance', 'stop']),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
const terminalStopSchema = z
  .object({
    schema: z.literal('h8a-independent-dev40-terminal-stop-v1'),
    screen: z.enum(['dev8', 'dev12', 'dev40']),
    reportSha256: digestSchema.nullable().optional(),
    reviewSha256: digestSchema.optional(),
    ledgerSnapshot: z.unknown().optional(),
    reason: z.string().min(1).optional(),
    errorCode: z.string().min(1).optional(),
    launchIntent: z.unknown().optional(),
    terminalSha256: digestSchema,
  })
  .strict()
const terminalStopBodySchema = terminalStopSchema.omit({ terminalSha256: true })

type VerifiedStudy = Awaited<ReturnType<typeof verifyPersistedIndependentDev40V2>>
type ScreenReport = z.infer<typeof devScreenReportSchema>

interface SuccessorOptions {
  studyRoot: string
  parentRoot: string
  parentLedgerPath: string
}

interface RuntimePorts {
  candidatePort: Awaited<ReturnType<typeof createH8FreshRuntimePorts>>['candidatePort']
  controlPort: Awaited<ReturnType<typeof createH8FreshRuntimePorts>>['controlPort']
  artifacts: Awaited<ReturnType<typeof createH8FreshRuntimePorts>>['artifacts']
  dispose(): Promise<void>
}

interface SuccessorRuntimeProof {
  proof: Pick<VerifiedRuntimeProof['proof'], 'historicalSourceRoot'>
  candidateAssetsRoot: string
  mobileSamEncoderPath: string
  mobileSamDecoderPath: string
  pythonExecutable: string
}

export interface SuccessorDependencies {
  getApiKey(): string | undefined
  openLedger(options: SuccessorOptions): Promise<SuccessorCampaignAdmissionPort>
  assertFreezeAdmission(
    verified: VerifiedStudy,
    ledger: SuccessorCampaignAdmissionPort,
  ): Promise<void>
  createRuntime(input: {
    apiKey: string
    artifactRoot: string
    runtime: SuccessorRuntimeProof
    verified: VerifiedStudy
  }): Promise<RuntimePorts>
  execute(input: Parameters<typeof executeDevScreen>[0]): ReturnType<typeof executeDevScreen>
  acquireLock(root: string): Promise<() => Promise<void>>
  verifyBinding?(verified: VerifiedStudy, authoritySha256: string, root: string): Promise<void>
  verifyPriorStages?(screen: DevScreenId, root: string, verified: VerifiedStudy): Promise<void>
  verifyStageNotStarted?(screen: DevScreenId, root: string): Promise<void>
  verifyNoTerminalStop?(root: string): Promise<void>
  assertSourceClosure?(paths: readonly string[]): void
  verifyRuntime?(verified: VerifiedStudy, runtime: SuccessorRuntimeProof | null): Promise<void>
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalOptions(): SuccessorOptions {
  return { studyRoot: STUDY_ROOT, parentRoot: PARENT_ROOT, parentLedgerPath: PARENT_LEDGER_PATH }
}

async function readAuthority(): Promise<{ sha256: string }> {
  const info = await lstat(AUTHORITY_PATH)
  if (!info.isFile() || info.isSymbolicLink() || info.size > JSON_LIMIT)
    throw new RangeError('Independent DEV40 authority must be a bounded regular file')
  const bytes = await readFile(AUTHORITY_PATH)
  return { sha256: sha256(bytes) }
}

function assertFullFreeze(
  verified: VerifiedStudy,
  assertSourceClosure: (paths: readonly string[]) => void = assertLiveRunnerClosure,
): void {
  const { freeze, annotations, sourceBytesByCaseId, sourceClosurePaths } = verified
  if (
    freeze.phaseId !== PHASE_FLAT_DEV40_ID ||
    freeze.producerCases.length !== 40 ||
    freeze.pairedSchedule.length !== 40 ||
    freeze.qualificationIndependentMaskCaseIds.length !== 0 ||
    annotations.cases.length !== 40 ||
    sourceBytesByCaseId.size !== 40 ||
    new Set(freeze.producerCases.map((item) => item.opaqueCaseId)).size !== 40
  )
    throw new RangeError('Independent DEV40 assembly is incomplete or has the wrong phase')
  assertSourceClosure(sourceClosurePaths)
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = `${JSON.stringify(value)}\n`
  try {
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if ((await readFile(path, 'utf8')) !== bytes)
      throw new RangeError('Immutable successor evidence conflicts with existing bytes')
  }
}

async function writeTerminalStop(
  root: string,
  body: Omit<z.infer<typeof terminalStopSchema>, 'terminalSha256'>,
): Promise<void> {
  const parsedBody = terminalStopBodySchema.parse(body)
  await writeImmutableJson(join(root, 'terminal-stop.json'), {
    ...parsedBody,
    terminalSha256: hashIdentity(parsedBody),
  })
}

async function readTerminalStop(root: string): Promise<z.infer<typeof terminalStopSchema> | null> {
  try {
    const stop = terminalStopSchema.parse(
      await readBoundedJson(join(root, 'terminal-stop.json'), root),
    )
    const { terminalSha256, ...input } = stop
    const body = terminalStopBodySchema.parse(input)
    if (hashIdentity(body) !== terminalSha256)
      throw new RangeError('Terminal stop digest is invalid')
    return stop
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  }
}

async function readBoundedJson(path: string, root: string): Promise<unknown> {
  const info = await lstat(path)
  const resolved = await realpath(path)
  const rel = relative(root, resolved)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > JSON_LIMIT ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${sep}`)
  )
    throw new RangeError('Successor evidence is not a bounded regular file in its trusted root')
  return JSON.parse((await readFile(path, 'utf8')) as string) as unknown
}

async function verifyRegisteredBinding(
  verified: VerifiedStudy,
  authoritySha256: string,
  root = STUDY_ROOT,
): Promise<void> {
  const raw = await readBoundedJson(
    join(root, 'admission', 'successor-study-binding.json'),
    join(root, 'admission'),
  )
  const bindingSchema = z
    .object({
      schema: z.literal('h8a-independent-dev40-successor-study-binding-v1'),
      studyId: z.literal('original-h8a-independent-dev40-v2'),
      authoritySha256: digestSchema,
      freezeId: z.string().min(1),
      freezeCommitmentSha256: digestSchema,
      producerClosureSha256: digestSchema,
      sourceBytesManifestSha256: digestSchema,
      runtimeEnvironmentSha256: digestSchema,
      sourceClosurePathsSha256: digestSchema,
      sourceCommit: z.string().min(1),
      priceProofSha256: digestSchema,
      successorLedgerRegistrationSha256: digestSchema,
      bindingSha256: digestSchema,
    })
    .strict()
  const binding = bindingSchema.parse(raw)
  const { bindingSha256, ...body } = binding
  if (
    hashIdentity(body) !== bindingSha256 ||
    binding.authoritySha256 !== authoritySha256 ||
    binding.freezeId !== verified.freeze.freezeId ||
    binding.freezeCommitmentSha256 !== verified.freeze.cohortCommitmentSha256 ||
    binding.producerClosureSha256 !== verified.freeze.producerClosureSha256 ||
    binding.sourceBytesManifestSha256 !== verified.freeze.sourceBytesManifestSha256 ||
    binding.runtimeEnvironmentSha256 !== verified.runtimeEnvironmentSha256 ||
    binding.sourceClosurePathsSha256 !== hashIdentity(verified.sourceClosurePaths) ||
    binding.sourceCommit !== verified.verifiedAuthority.sourceCommit ||
    binding.priceProofSha256 !== verified.verifiedAuthority.priceProofSha256
  )
    throw new RangeError('Registered successor binding differs from the verified freeze inputs')
  const registrationBytes = await readFile(
    join(root, 'admission', 'successor-campaign-v1', 'registration.json'),
  )
  if (sha256(registrationBytes) !== binding.successorLedgerRegistrationSha256)
    throw new RangeError(
      'Successor ledger registration bytes differ from the immutable study binding',
    )
}

async function writeStudyBinding(
  verified: VerifiedStudy,
  authoritySha256: string,
  registrationSha256: string,
): Promise<void> {
  const body = {
    schema: 'h8a-independent-dev40-successor-study-binding-v1' as const,
    studyId: 'original-h8a-independent-dev40-v2' as const,
    authoritySha256,
    freezeId: verified.freeze.freezeId,
    freezeCommitmentSha256: verified.freeze.cohortCommitmentSha256,
    producerClosureSha256: verified.freeze.producerClosureSha256,
    sourceBytesManifestSha256: verified.freeze.sourceBytesManifestSha256,
    runtimeEnvironmentSha256: verified.runtimeEnvironmentSha256,
    sourceClosurePathsSha256: hashIdentity(verified.sourceClosurePaths),
    sourceCommit: verified.verifiedAuthority.sourceCommit,
    priceProofSha256: verified.verifiedAuthority.priceProofSha256,
    successorLedgerRegistrationSha256: registrationSha256,
  }
  await writeImmutableJson(BINDING_PATH, { ...body, bindingSha256: hashIdentity(body) })
}

async function registerSuccessor(): Promise<void> {
  const authority = await readAuthority()
  const verified = await assembleIndependentDev40V2FromDisk({
    authorityPath: AUTHORITY_PATH,
    authoritySha256: authority.sha256,
    sourceRoot: SOURCE_ROOT,
    outputDirectory: FREEZE_DIRECTORY,
  })
  assertFullFreeze(verified)
  await verifyRuntimeProof(
    { runtimeFilesPath: RUNTIME_PROOF_PATH, runtimeFilesSha256: RUNTIME_PROOF_SHA256 },
    verified.runtimeEnvironmentSha256,
    SOURCE_ROOT,
    false,
    {
      runtimeFilesSha256: RUNTIME_PROOF_SHA256,
      runtimeEnvironmentSha256: RUNTIME_ENVIRONMENT_SHA256,
    },
  )
  const ledger = await SuccessorCampaignLedger.register(canonicalOptions())
  await assertSuccessorFreezeAdmission(verified, ledger)
  const registrationBytes = await readFile(join(SUCCESSOR_ROOT, 'registration.json'))
  if (verified.freeze.profileBindings[0].profileId !== PROFILE_FLAT_CANDIDATE_ID)
    throw new RangeError('Successor candidate identity differs from the authorized CPU flat recipe')
  await writeStudyBinding(verified, authority.sha256, sha256(registrationBytes))
  process.stdout.write(`Registered ${verified.freeze.freezeId} at ${SUCCESSOR_ROOT}\n`)
}

const productionDependencies = (): SuccessorDependencies => ({
  getApiKey: () => undefined,
  openLedger: async (options) => await SuccessorCampaignLedger.open(options),
  assertFreezeAdmission: async (verified, ledger) =>
    await assertSuccessorFreezeAdmission(verified, ledger),
  verifyBinding: async (verified, authoritySha256, studyRoot) => {
    const authority = await readAuthority()
    if (authority.sha256 !== authoritySha256)
      throw new RangeError('Independent DEV40 authority changed after runner preflight')
    const persisted = await verifyPersistedIndependentDev40V2(FREEZE_DIRECTORY, {
      authorityPath: AUTHORITY_PATH,
      authoritySha256,
      sourceRoot: SOURCE_ROOT,
    })
    assertFullFreeze(persisted)
    if (
      hashIdentity(persisted.freeze) !== hashIdentity(verified.freeze) ||
      hashIdentity(persisted.verifiedAuthority) !== hashIdentity(verified.verifiedAuthority) ||
      hashIdentity(persisted.sourceClosurePaths) !== hashIdentity(verified.sourceClosurePaths)
    )
      throw new RangeError('Independent DEV40 inputs changed after runner preflight')
    await verifyRegisteredBinding(persisted, authoritySha256, studyRoot)
  },
  verifyRuntime: async (verified, runtime) => {
    if (!runtime) throw new RangeError('Verified runtime proof is required before provider access')
    const current = await verifyRuntimeProof(
      { runtimeFilesPath: RUNTIME_PROOF_PATH, runtimeFilesSha256: RUNTIME_PROOF_SHA256 },
      verified.runtimeEnvironmentSha256,
      SOURCE_ROOT,
      false,
      {
        runtimeFilesSha256: RUNTIME_PROOF_SHA256,
        runtimeEnvironmentSha256: RUNTIME_ENVIRONMENT_SHA256,
      },
    )
    if (hashIdentity(current) !== hashIdentity(runtime))
      throw new RangeError('Pinned runtime proof changed after runner preflight')
  },
  acquireLock: acquireRunnerLock,
  createRuntime: async ({ apiKey, artifactRoot, runtime, verified }) => {
    const controlEngine = await loadHistoricalControl(runtime.proof.historicalSourceRoot)
    return await createH8FreshRuntimePorts({
      apiKey,
      artifactRoot,
      temporaryRoot: join(artifactRoot, 'temporary'),
      maskArtifactDirectory: join(artifactRoot, 'masks'),
      cutoutArtifactDirectory: join(artifactRoot, 'cutouts'),
      nativeRuntime: {
        recipeId: PROFILE_FLAT_CANDIDATE_ID,
        pythonExecutable: runtime.pythonExecutable,
        assetRoot: runtime.candidateAssetsRoot,
      },
      mobileSam: {
        encoderPath: runtime.mobileSamEncoderPath,
        decoderPath: runtime.mobileSamDecoderPath,
      },
      sourceCanvasByOpaqueCaseId: new Map(
        verified.freeze.producerCases.map((item) => [
          item.opaqueCaseId,
          { width: item.sourceCanvasWidth, height: item.sourceCanvasHeight },
        ]),
      ),
      fetch: globalThis.fetch,
      controlEngine,
    })
  },
  execute: async (input) => await executeDevScreen(input),
})

async function assertNoTerminalStop(root: string): Promise<void> {
  if (await readTerminalStop(root))
    throw new RangeError('Successor study has a terminal stop record; paid retry is forbidden')
}

async function priorStages(
  screen: DevScreenId,
  root: string,
  verified: VerifiedStudy,
): Promise<void> {
  const { verifyPriorStageFiles } = await import('./dev-screen-cli.js')
  if (screen === 'dev12') {
    await verifyPriorStageFiles(root, 'dev12')
    await verifyReceiptReviewBinding('dev8', root, verified)
  }
  if (screen === 'dev40') {
    await verifyPriorStageFiles(root, 'dev12')
    await verifyPriorStageFiles(root, 'dev40')
    await verifyReceiptReviewBinding('dev8', root, verified)
    await verifyReceiptReviewBinding('dev12', root, verified)
  }
}

async function receiptDigestForReport(
  verified: VerifiedStudy,
  report: ScreenReport,
  root: string,
): Promise<string> {
  const candidateId = candidateIdForPhase(verified.freeze.phaseId)
  const producerById = new Map(
    verified.freeze.producerCases.map((item) => [item.opaqueCaseId, item]),
  )
  const store = new ImmutableCaseArtifactStore(root)
  const arms = []
  for (const output of report.outputs) {
    const producer = producerById.get(output.opaqueCaseId)
    if (!producer) throw new RangeError('Screen report includes a case outside the frozen cohort')
    for (const profileId of [candidateId, PROFILE_CONTROL_ID] as const) {
      const identity = buildCaseArtifactIdentity(
        verified.freeze,
        verified.selection,
        producer,
        profileId,
      )
      const identityDigest = store.identity(identity).sha256
      const stored = await store.load(identityDigest, identity)
      arms.push({
        opaqueCaseId: output.opaqueCaseId,
        profileId,
        identitySha256: identityDigest,
        logicalReceipts: stored?.result.logicalReceipts ?? [],
        physicalReceipts: stored?.result.physicalReceipts ?? [],
      })
    }
  }
  return hashIdentity(arms)
}

async function verifyReceiptReviewBinding(
  screen: DevScreenId,
  root: string,
  verified: VerifiedStudy,
  requiredJudgement: 'advance' | 'any' = 'advance',
): Promise<void> {
  await verifyLaunchIntent(screen, root, verified)
  const bindingPath = join(root, 'reviews', `${screen}-receipt-binding.json`)
  const bindingSchema = z
    .object({
      schema: z.literal('h8a-dev-screen-receipt-review-binding-v1'),
      screen: z.enum(['dev8', 'dev12', 'dev40']),
      reportSha256: digestSchema,
      reviewSha256: digestSchema,
      receiptsSha256: digestSchema,
      bindingSha256: digestSchema,
    })
    .strict()
  const binding = bindingSchema.parse(await readBoundedJson(bindingPath, root))
  const { bindingSha256, ...body } = binding
  if (binding.screen !== screen || hashIdentity(body) !== bindingSha256)
    throw new RangeError(`Prior ${screen} receipt review binding is invalid`)
  const report = devScreenReportSchema.parse(
    await readBoundedJson(join(root, 'reports', `${screen}-report.json`), root),
  )
  const { reportSha256, ...reportBody } = report
  if (hashIdentity(reportBody) !== reportSha256)
    throw new RangeError(`Prior ${screen} report digest is invalid`)
  const reviewPath = join(root, 'reviews', `${screen}-review.json`)
  const reviewRaw = await readBoundedJson(reviewPath, root)
  const reviewSchema = z
    .object({
      schema: z.literal('h8a-dev-screen-review-v1'),
      screenReportSha256: digestSchema,
      reviewProtocol: z.literal('no-apparent-collapse-main-review-v1'),
      reviewerId: z.literal('main-orchestrator'),
      judgement: z.enum(['advance', 'stop']),
      reason: z.string().min(1),
      reviewSha256: digestSchema,
    })
    .strict()
  const review = reviewSchema.parse(reviewRaw)
  const { reviewSha256, ...reviewBody } = review
  if (hashIdentity(reviewBody) !== reviewSha256)
    throw new RangeError(`Prior ${screen} review digest is invalid`)
  if (
    binding.reportSha256 !== report.reportSha256 ||
    binding.reviewSha256 !== review.reviewSha256 ||
    review.screenReportSha256 !== report.reportSha256 ||
    (requiredJudgement === 'advance' && review.judgement !== 'advance')
  )
    throw new RangeError(`Prior ${screen} review is not an advance bound to its report`)
  if ((await receiptDigestForReport(verified, report, root)) !== binding.receiptsSha256)
    throw new RangeError(`Prior ${screen} receipt digest differs from immutable arm artifacts`)
}

async function verifyLaunchIntent(
  screen: DevScreenId,
  root: string,
  verified: VerifiedStudy,
): Promise<void> {
  const launchSchema = z
    .object({
      schema: z.literal('h8a-independent-dev40-screen-launch-v1'),
      screen: z.enum(['dev8', 'dev12', 'dev40']),
      studyId: z.literal('original-h8a-independent-dev40-v2'),
      authoritySha256: digestSchema,
      freezeId: z.string().min(1),
      freezeCommitmentSha256: digestSchema,
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      producerClosureSha256: digestSchema,
      sourceBytesManifestSha256: digestSchema,
      priceProofSha256: digestSchema,
      runtimeEnvironmentSha256: digestSchema,
      sourceClosurePathsSha256: digestSchema,
      startedAtIso: z.string().datetime({ offset: true }),
      launchSha256: digestSchema,
    })
    .strict()
  const launch = launchSchema.parse(
    await readBoundedJson(join(root, 'launch-intents', `${screen}-launch.json`), root),
  )
  const { launchSha256, ...body } = launch
  if (
    hashIdentity(body) !== launchSha256 ||
    launch.screen !== screen ||
    launch.authoritySha256 !== verified.verifiedAuthority.authoritySha256 ||
    launch.freezeId !== verified.freeze.freezeId ||
    launch.freezeCommitmentSha256 !== verified.freeze.cohortCommitmentSha256 ||
    launch.sourceCommit !== verified.verifiedAuthority.sourceCommit ||
    launch.producerClosureSha256 !== verified.freeze.producerClosureSha256 ||
    launch.sourceBytesManifestSha256 !== verified.freeze.sourceBytesManifestSha256 ||
    launch.priceProofSha256 !== verified.verifiedAuthority.priceProofSha256 ||
    launch.runtimeEnvironmentSha256 !== verified.runtimeEnvironmentSha256 ||
    launch.sourceClosurePathsSha256 !== hashIdentity(verified.sourceClosurePaths)
  )
    throw new RangeError(`DEV ${screen} launch intent is invalid or belongs to a different freeze`)
}

async function assertStageHasNotStarted(screen: DevScreenId, root = SUCCESSOR_ROOT): Promise<void> {
  for (const directory of ['reports', 'reviews', 'launch-intents']) {
    const name =
      directory === 'reports'
        ? `${screen}-report.json`
        : directory === 'reviews'
          ? `${screen}-review.json`
          : `${screen}-launch.json`
    try {
      await lstat(join(root, directory, name))
      throw new RangeError(
        `DEV screen ${screen} already has immutable output; do not retry or resubmit`,
      )
    } catch (error) {
      if (error instanceof RangeError) throw error
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
    }
  }
}

async function runSuccessorDevScreen(
  input: { screen: DevScreenId; apiKeyEnv: string },
  dependencies: SuccessorDependencies = {
    ...productionDependencies(),
    getApiKey: () => process.env[input.apiKeyEnv],
  },
): Promise<ScreenReport> {
  const authority = await readAuthority()
  const verified = await verifyPersistedIndependentDev40V2(FREEZE_DIRECTORY, {
    authorityPath: AUTHORITY_PATH,
    authoritySha256: authority.sha256,
    sourceRoot: SOURCE_ROOT,
  })
  assertFullFreeze(verified)
  const runtime = await verifyRuntimeProof(
    { runtimeFilesPath: RUNTIME_PROOF_PATH, runtimeFilesSha256: RUNTIME_PROOF_SHA256 },
    verified.runtimeEnvironmentSha256,
    SOURCE_ROOT,
    false,
    {
      runtimeFilesSha256: RUNTIME_PROOF_SHA256,
      runtimeEnvironmentSha256: RUNTIME_ENVIRONMENT_SHA256,
    },
  )
  return await runVerifiedSuccessorDevScreen(
    {
      ...input,
      verified,
      runtime,
      authoritySha256: authority.sha256,
      artifactRoot: SUCCESSOR_ROOT,
    },
    canonicalOptions(),
    dependencies,
  )
}

export async function runVerifiedSuccessorDevScreen(
  input: {
    screen: DevScreenId
    apiKeyEnv: string
    verified: VerifiedStudy
    runtime: SuccessorRuntimeProof | null
    authoritySha256: string
    artifactRoot: string
  },
  ledgerOptions: SuccessorOptions,
  dependencies: SuccessorDependencies,
): Promise<ScreenReport> {
  const { verified, runtime, artifactRoot } = input
  assertFullFreeze(verified, dependencies.assertSourceClosure)
  const release = await dependencies.acquireLock(artifactRoot)
  const controller = new AbortController()
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('Process interruption'))
  }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  let runtimePorts: RuntimePorts | undefined
  let ledger: SuccessorCampaignAdmissionPort | undefined
  let launchIntentWritten = false
  try {
    await (dependencies.verifyBinding ?? verifyRegisteredBinding)(
      verified,
      input.authoritySha256,
      ledgerOptions.studyRoot,
    )
    ledger = await dependencies.openLedger(ledgerOptions)
    ledger.assertResumeAllowed()
    await dependencies.assertFreezeAdmission(verified, ledger)
    await (dependencies.verifyNoTerminalStop ?? assertNoTerminalStop)(artifactRoot)
    await (dependencies.verifyPriorStages ?? priorStages)(input.screen, artifactRoot, verified)
    await (dependencies.verifyStageNotStarted ?? assertStageHasNotStarted)(
      input.screen,
      artifactRoot,
    )
    await dependencies.verifyRuntime?.(verified, runtime)
    const key = dependencies.getApiKey()
    if (!key)
      throw new RangeError(
        `Required provider key environment variable is unset: ${input.apiKeyEnv}`,
      )
    if (!runtime) throw new RangeError('Verified runtime proof is required before runtime creation')
    const launchBody = {
      schema: 'h8a-independent-dev40-screen-launch-v1' as const,
      screen: input.screen,
      studyId: 'original-h8a-independent-dev40-v2' as const,
      authoritySha256: input.authoritySha256,
      freezeId: verified.freeze.freezeId,
      freezeCommitmentSha256: verified.freeze.cohortCommitmentSha256,
      sourceCommit: verified.verifiedAuthority.sourceCommit,
      producerClosureSha256: verified.freeze.producerClosureSha256,
      sourceBytesManifestSha256: verified.freeze.sourceBytesManifestSha256,
      priceProofSha256: verified.verifiedAuthority.priceProofSha256,
      runtimeEnvironmentSha256: verified.runtimeEnvironmentSha256,
      sourceClosurePathsSha256: hashIdentity(verified.sourceClosurePaths),
      startedAtIso: new Date().toISOString(),
    }
    await writeImmutableJson(join(artifactRoot, 'launch-intents', `${input.screen}-launch.json`), {
      ...launchBody,
      launchSha256: hashIdentity(launchBody),
    })
    launchIntentWritten = true
    ledger = await dependencies.openLedger(ledgerOptions)
    ledger.assertResumeAllowed()
    await dependencies.assertFreezeAdmission(verified, ledger)
    const activeLedger = ledger
    runtimePorts = await dependencies.createRuntime({
      apiKey: key,
      artifactRoot,
      runtime,
      verified,
    })
    const report = await dependencies.execute({
      freeze: verified.freeze,
      annotations: verified.annotations,
      sourceBytesByCaseId: verified.sourceBytesByCaseId,
      selection: verified.selection,
      screen: input.screen,
      selectionPath: join(artifactRoot, 'dev-screen-selection.json'),
      artifactRoot,
      ledger: activeLedger,
      candidatePort: runtimePorts.candidatePort,
      controlPort: runtimePorts.controlPort,
      runtimeArtifacts: runtimePorts.artifacts,
      signal: controller.signal,
      assertFreezeAdmission: async (freeze, callbackLedger) => {
        if (
          hashIdentity(freeze) !== hashIdentity(verified.freeze) ||
          callbackLedger !== activeLedger
        )
          throw new RangeError('DEV screen admission callback received different frozen inputs')
        await dependencies.assertFreezeAdmission(verified, activeLedger)
      },
    })
    if (!meetsScreenAdvancePrerequisites(report)) {
      await writeTerminalStop(artifactRoot, {
        schema: 'h8a-independent-dev40-terminal-stop-v1',
        screen: input.screen,
        reportSha256: report.reportSha256,
        ledgerSnapshot: ledger?.snapshot() ?? null,
        reason: 'incomplete-or-blocked-screen',
      })
    }
    return report
  } catch (error) {
    if (!launchIntentWritten) throw error
    let reportSha256: string | null = null
    try {
      const raw = await readFile(
        join(artifactRoot, 'reports', `${input.screen}-report.json`),
        'utf8',
      )
      reportSha256 = devScreenReportSchema.parse(JSON.parse(raw) as unknown).reportSha256
    } catch (reportError) {
      if (!(reportError instanceof Error && Reflect.get(reportError, 'code') === 'ENOENT'))
        throw reportError
    }
    await writeTerminalStop(artifactRoot, {
      schema: 'h8a-independent-dev40-terminal-stop-v1',
      screen: input.screen,
      reportSha256,
      ledgerSnapshot: ledger?.snapshot() ?? null,
      errorCode: safeFailureCode(error),
    })
    throw error
  } finally {
    try {
      if (runtimePorts) await runtimePorts.dispose()
    } finally {
      try {
        await release()
      } finally {
        process.removeListener('SIGINT', abort)
        process.removeListener('SIGTERM', abort)
      }
    }
  }
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'EXECUTION_FAILED'
  const code = Reflect.get(error, 'code')
  if (typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(code)) return code
  return /^[A-Za-z][A-Za-z0-9_]{0,59}$/u.test(error.name) ? error.name : 'EXECUTION_FAILED'
}

function meetsScreenAdvancePrerequisites(report: ScreenReport): boolean {
  return (
    report.completedPairs === report.expectedPairs &&
    report.hardBlockers.length === 0 &&
    report.candidateNegativeFalseOutputs === 0 &&
    report.rawCandidatePositiveSuccesses > 0 &&
    report.weightedEstimateComplete
  )
}

async function reviewScreen(input: z.infer<typeof reviewInputSchema>): Promise<void> {
  const release = await acquireRunnerLock(SUCCESSOR_ROOT)
  try {
    await reviewScreenLocked(input)
  } finally {
    await release()
  }
}

async function reviewScreenLocked(input: z.infer<typeof reviewInputSchema>): Promise<void> {
  const authority = await readAuthority()
  const verified = await verifyPersistedIndependentDev40V2(FREEZE_DIRECTORY, {
    authorityPath: AUTHORITY_PATH,
    authoritySha256: authority.sha256,
    sourceRoot: SOURCE_ROOT,
  })
  assertFullFreeze(verified)
  await verifyRegisteredBinding(verified, authority.sha256)
  await priorStages(input.screen, SUCCESSOR_ROOT, verified)
  await verifyLaunchIntent(input.screen, SUCCESSOR_ROOT, verified)
  const report = devScreenReportSchema.parse(
    await readBoundedJson(
      join(SUCCESSOR_ROOT, 'reports', `${input.screen}-report.json`),
      SUCCESSOR_ROOT,
    ),
  )
  const expectedPairs = input.screen === 'dev8' ? 8 : input.screen === 'dev12' ? 12 : 40
  if (report.screen !== input.screen || report.expectedPairs !== expectedPairs)
    throw new RangeError('Screen report identity or cumulative pair count is invalid')
  const terminalStop = await readTerminalStop(SUCCESSOR_ROOT)
  if (terminalStop !== null) {
    if (
      input.judgement !== 'stop' ||
      terminalStop.screen !== input.screen ||
      (terminalStop.reportSha256 !== undefined &&
        terminalStop.reportSha256 !== null &&
        terminalStop.reportSha256 !== report.reportSha256)
    )
      throw new RangeError('Existing terminal stop prevents this review from advancing')
  }
  if (input.judgement === 'advance' && report.rawCandidatePositiveSuccesses === 0)
    throw new RangeError('A clean screen with zero strict positive localizations cannot advance')
  const review = await sealDevScreenReview(SUCCESSOR_ROOT, report, input.judgement, input.reason)
  const receiptsSha256 = await receiptDigestForReport(verified, report, SUCCESSOR_ROOT)
  const reviewBinding = {
    schema: 'h8a-dev-screen-receipt-review-binding-v1' as const,
    screen: input.screen,
    reportSha256: report.reportSha256,
    reviewSha256: hashIdentity(review),
    receiptsSha256,
  }
  await writeImmutableJson(
    join(SUCCESSOR_ROOT, 'reviews', `${input.screen}-receipt-binding.json`),
    { ...reviewBinding, bindingSha256: hashIdentity(reviewBinding) },
  )
  if (review.judgement === 'stop' && terminalStop === null) {
    await writeTerminalStop(SUCCESSOR_ROOT, {
      schema: 'h8a-independent-dev40-terminal-stop-v1',
      screen: input.screen,
      reportSha256: report.reportSha256,
      reviewSha256: hashIdentity(review),
      reason: 'main-review-stop',
    })
  }
  process.stdout.write(`Recorded ${input.judgement} review for ${input.screen}\n`)
}

async function closeoutSuccessor(): Promise<void> {
  const release = await acquireRunnerLock(SUCCESSOR_ROOT)
  try {
    await closeoutSuccessorLocked()
  } finally {
    await release()
  }
}

async function closeoutSuccessorLocked(): Promise<void> {
  const authority = await readAuthority()
  const verified = await verifyPersistedIndependentDev40V2(FREEZE_DIRECTORY, {
    authorityPath: AUTHORITY_PATH,
    authoritySha256: authority.sha256,
    sourceRoot: SOURCE_ROOT,
  })
  assertFullFreeze(verified)
  await verifyRegisteredBinding(verified, authority.sha256)
  const ledger = await SuccessorCampaignLedger.open(canonicalOptions())
  let terminalStop = await readTerminalStop(SUCCESSOR_ROOT)
  const stageReports: Record<string, ScreenReport | null> = {}
  const stageReviews: Record<string, unknown | null> = {}
  for (const screen of ['dev8', 'dev12', 'dev40'] as const) {
    try {
      const report = devScreenReportSchema.parse(
        await readBoundedJson(
          join(SUCCESSOR_ROOT, 'reports', `${screen}-report.json`),
          SUCCESSOR_ROOT,
        ),
      )
      const expectedPairs = screen === 'dev8' ? 8 : screen === 'dev12' ? 12 : 40
      if (report.screen !== screen || report.expectedPairs !== expectedPairs)
        throw new RangeError(`DEV ${screen} report identity or pair count is invalid`)
      const { reportSha256, ...reportBody } = report
      if (hashIdentity(reportBody) !== reportSha256)
        throw new RangeError(`DEV ${screen} report digest is invalid`)
      await verifyLaunchIntent(screen, SUCCESSOR_ROOT, verified)
      stageReports[screen] = report
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      stageReports[screen] = null
    }
    try {
      stageReviews[screen] = await readBoundedJson(
        join(SUCCESSOR_ROOT, 'reviews', `${screen}-review.json`),
        SUCCESSOR_ROOT,
      )
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      stageReviews[screen] = null
    }
    if (stageReviews[screen] !== null)
      await verifyReceiptReviewBinding(screen, SUCCESSOR_ROOT, verified, 'any')
  }
  if (terminalStop === null) {
    for (const screen of ['dev8', 'dev12', 'dev40'] as const) {
      if (stageReports[screen] !== null) continue
      try {
        const launch = await readBoundedJson(
          join(SUCCESSOR_ROOT, 'launch-intents', `${screen}-launch.json`),
          SUCCESSOR_ROOT,
        )
        const orphanedStopBody: Omit<z.infer<typeof terminalStopSchema>, 'terminalSha256'> = {
          schema: 'h8a-independent-dev40-terminal-stop-v1',
          screen,
          launchIntent: launch,
          reason: 'stage-launched-without-a-valid-report',
        }
        const parsedOrphanedStop = terminalStopBodySchema.parse(orphanedStopBody)
        terminalStop = {
          ...parsedOrphanedStop,
          terminalSha256: hashIdentity(parsedOrphanedStop),
        }
        break
      } catch (error) {
        if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      }
    }
  }
  if (terminalStop === null && (stageReports.dev40 === null || stageReviews.dev40 === null))
    throw new RangeError('DEV40 closeout requires a terminal stop or an explicit dev40 review')
  const assembled = await assembleDev40Closeouts({
    freeze: verified.freeze,
    annotations: verified.annotations,
    selection: verified.selection,
    artifactRoot: SUCCESSOR_ROOT,
    ledger,
    closedAtIso: await existingCloseoutTimestamp(SUCCESSOR_ROOT),
  })
  const complete = assembled.missingPredictionRows === 0
  if (
    assembled.candidateCloseout.outputRows.length !== 40 ||
    assembled.controlCloseout.outputRows.length !== 40
  )
    throw new RangeError('DEV40 closeout must preserve all 40 expected rows for both arms')
  const allStagesReviewedForAdvance = (['dev8', 'dev12', 'dev40'] as const).every((screen) => {
    const report = stageReports[screen]
    const review = stageReviews[screen]
    return Boolean(
      report &&
        report.completedPairs === report.expectedPairs &&
        report.hardBlockers.length === 0 &&
        report.candidateNegativeFalseOutputs === 0 &&
        report.rawCandidatePositiveSuccesses > 0 &&
        report.weightedEstimateComplete &&
        review &&
        typeof review === 'object' &&
        Reflect.get(review, 'judgement') === 'advance',
    )
  })
  const finalReport = {
    schema: 'h8a-independent-dev40-closeout-v1',
    freezeId: verified.freeze.freezeId,
    freezeCommitmentSha256: verified.freeze.cohortCommitmentSha256,
    candidateCloseoutSha256: assembled.candidateCloseout.closeoutSha256,
    controlCloseoutSha256: assembled.controlCloseout.closeoutSha256,
    expectedRowsPerArm: verified.freeze.producerCases.length,
    candidateRows: assembled.candidateCloseout.outputRows.length,
    controlRows: assembled.controlCloseout.outputRows.length,
    pairedCoverageComplete: complete,
    missingPredictionRows: assembled.missingPredictionRows,
    terminalStop,
    stageReports,
    stageReviews,
    ledgerSnapshot: ledger.snapshot(),
    qual120Eligible: complete && terminalStop === null && allStagesReviewedForAdvance,
    qualificationResult: null,
  }
  const reportWithHash = { ...finalReport, closeoutSha256: hashIdentity(finalReport) }
  await writeImmutableJson(
    join(SUCCESSOR_ROOT, 'closeouts', 'successor-study-closeout.json'),
    reportWithHash,
  )
  process.stdout.write(
    `Closed DEV40 artifacts: ${finalReport.candidateRows} candidate and ${finalReport.controlRows} control rows; coverage ${complete ? 'complete' : 'incomplete'}\n`,
  )
}

async function existingCloseoutTimestamp(root: string): Promise<string> {
  const candidatePath = join(root, 'closeouts', 'dev40-candidate-closeout.json')
  const controlPath = join(root, 'closeouts', 'dev40-control-closeout.json')
  const readExisting = async (path: string): Promise<unknown | null> => {
    try {
      return await readBoundedJson(path, root)
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
      throw error
    }
  }
  const [candidateRaw, controlRaw] = await Promise.all([
    readExisting(candidatePath),
    readExisting(controlPath),
  ])
  if (candidateRaw === null && controlRaw === null) return new Date().toISOString()
  if (candidateRaw === null || controlRaw === null)
    throw new RangeError('Only one immutable DEV40 closeout exists')
  const candidate = immutableCloseoutSchema.parse(candidateRaw)
  const control = immutableCloseoutSchema.parse(controlRaw)
  if (candidate.closedAtIso !== control.closedAtIso)
    throw new RangeError('Paired DEV40 closeouts have different immutable closure times')
  return candidate.closedAtIso
}

function parseArguments(
  argv: readonly string[],
):
  | { command: 'register' | 'closeout' }
  | { command: 'run'; screen: DevScreenId; apiKeyEnv: string }
  | { command: 'review'; input: z.infer<typeof reviewInputSchema> } {
  const [command, ...args] = argv
  if (command === 'register' || command === 'closeout') {
    if (args.length !== 0) throw new TypeError('Unexpected command arguments')
    return { command }
  }
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (!key?.startsWith('--') || !value || values.has(key))
      throw new TypeError('Invalid or duplicate command argument')
    values.set(key, value)
  }
  if (command === 'run') {
    if (values.size !== 2 || !values.has('--screen') || !values.has('--api-key-env'))
      throw new TypeError('Usage: run --screen dev8|dev12|dev40 --api-key-env OPENROUTER_API_KEY')
    const screen = z.enum(['dev8', 'dev12', 'dev40']).parse(values.get('--screen'))
    const apiKeyEnv = z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/u)
      .parse(values.get('--api-key-env'))
    return { command, screen, apiKeyEnv }
  }
  if (command === 'review') {
    if (
      values.size !== 3 ||
      !values.has('--screen') ||
      !values.has('--judgement') ||
      !values.has('--reason')
    )
      throw new TypeError(
        'Usage: review --screen dev8|dev12|dev40 --judgement advance|stop --reason TEXT',
      )
    return {
      command,
      input: reviewInputSchema.parse({
        screen: values.get('--screen'),
        judgement: values.get('--judgement'),
        reason: values.get('--reason'),
      }),
    }
  }
  throw new TypeError('Usage: successor-dev-screen-cli.ts <register|run|review|closeout>')
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2))
  const root = await realpath(SOURCE_ROOT)
  if (root !== SOURCE_ROOT) throw new RangeError('Source checkout is aliased or symlinked')
  if (parsed.command === 'register') return await registerSuccessor()
  if (parsed.command === 'run') {
    const report = await runSuccessorDevScreen(parsed, {
      ...productionDependencies(),
      getApiKey: () => process.env[parsed.apiKeyEnv],
    })
    const eligible = meetsScreenAdvancePrerequisites(report)
    process.stdout.write(
      `${eligible ? 'Completed' : 'Stopped'} ${report.screen}: ${report.completedPairs}/${report.expectedPairs} pairs; ${report.hardBlockers.length} blockers\n`,
    )
    if (!eligible) process.exitCode = 1
    return
  }
  if (parsed.command === 'review') return await reviewScreen(parsed.input)
  await closeoutSuccessor()
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Successor DEV screen refused: ${safeFailureCode(error)}\n`)
    process.exitCode = 1
  })
}
