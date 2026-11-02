import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { acquireExclusiveFileLock } from './atomic-json-ledger.js'
import { loadHistoricalControl, verifyRuntimeProof } from './dev-screen-cli.js'
import { verifyNativeSelectorQualSourceClosure } from './dev-replay-cli.js'
import { createH8FreshRuntimePorts } from './runtime-ports.js'
import type { createH8FreshRuntimePortsForOfflineFixture } from './runtime-ports.js'
import { nativeSelectorRuntimeFactoryOptions } from './native-selector-runtime-binding.js'
import {
  assembleNativeSelectorQualCloseouts,
  runNativeSelectorQual120,
} from './native-selector-qual-runner.js'
import {
  isVerifiedNativeSelectorQualAdmission,
  nativeSelectorQualAdmissionSnapshot,
  assertNativeSelectorQualParentRoot,
  verifyNativeSelectorQualAdmission,
} from './native-selector-qual-admission.js'
import type { VerifiedNativeSelectorQualAdmission } from './native-selector-qual-admission.js'
import { computePhaseFreezeCommitmentSha256 } from './freeze-commitment.js'
import {
  NativeSelectorQualLedger,
  createNativeSelectorQualRegistration,
} from './native-selector-qual-ledger.js'
import { NATIVE_SELECTOR_QUAL_ROOT } from './native-selector-qual-protocol.js'
import { UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256 } from './ui-state-dev40-policy.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const optionsSchema = z
  .object({
    command: z.enum(['register', 'run', 'closeout']),
    protocolPath: z.string().min(1),
    protocolSha256: digest,
    allowPaid: z.boolean(),
  })
  .strict()
type NativeSelectorQualCliOptions = z.infer<typeof optionsSchema>

interface NativeSelectorQualOfflineCliHooks {
  offlineTestOnly: true
  namespaceRoot: string
  protocolPath: string
  admission: VerifiedNativeSelectorQualAdmission
  createRuntime: (input: {
    executionRoot: string
    temporaryRoot: string
    admission: VerifiedNativeSelectorQualAdmission
  }) => Promise<Awaited<ReturnType<typeof createH8FreshRuntimePortsForOfflineFixture>>>
  removeLaunchRoot?: (path: string) => Promise<void>
}

const completedRunSchema = z
  .object({
    schema: z.literal('h8a-native-selector-qual120-result-v1'),
    protocolSha256: digest,
    candidateCloseoutSha256: digest,
    controlCloseoutSha256: digest,
    gate: z.unknown(),
    runtimeDisposed: z.literal(true),
    cleanupComplete: z.literal(true),
  })
  .strict()

export function nativeSelectorQualCompletedRunMatches(input: {
  completedRun: unknown
  runFailure: unknown | null
  protocolSha256: string
  candidateCloseoutSha256: string
  controlCloseoutSha256: string
  gate: unknown
}): boolean {
  const completed = completedRunSchema.safeParse(input.completedRun)
  return (
    input.runFailure === null &&
    completed.success &&
    completed.data.protocolSha256 === input.protocolSha256 &&
    completed.data.candidateCloseoutSha256 === input.candidateCloseoutSha256 &&
    completed.data.controlCloseoutSha256 === input.controlCloseoutSha256 &&
    JSON.stringify(completed.data.gate) === JSON.stringify(input.gate)
  )
}

export function parseNativeSelectorQualCliArgs(
  args: readonly string[],
): NativeSelectorQualCliOptions {
  let command: NativeSelectorQualCliOptions['command'] | undefined
  let protocolPath: string | undefined
  let protocolSha256: string | undefined
  let allowPaid = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!command && (token === 'register' || token === 'run' || token === 'closeout'))
      command = token
    else if (token === '--protocol') protocolPath = args[++index]
    else if (token === '--protocol-sha256') protocolSha256 = args[++index]
    else if (token === '--allow-paid') allowPaid = true
    else throw new RangeError('Unknown QUAL CLI argument')
  }
  if (!command || !protocolPath || !protocolSha256)
    throw new RangeError('QUAL CLI requires a command and explicit pinned protocol')
  if ((command === 'run') !== allowPaid)
    throw new RangeError('Only QUAL run accepts the explicit --allow-paid switch')
  return optionsSchema.parse({ command, protocolPath, protocolSha256, allowPaid })
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
    if (!(await readFile(path)).equals(bytes)) throw new RangeError('QUAL artifact is immutable')
  }
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'QUAL_EXECUTION_FAILED'
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(code)
    ? code
    : 'QUAL_EXECUTION_FAILED'
}

export async function runNativeSelectorQualCli(
  args: readonly string[],
  repositoryRoot: string,
  hooks?: NativeSelectorQualOfflineCliHooks,
): Promise<void> {
  const options = parseNativeSelectorQualCliArgs(Array.from(args))
  let namespaceRoot: string = NATIVE_SELECTOR_QUAL_ROOT
  let admission: VerifiedNativeSelectorQualAdmission
  if (hooks) {
    namespaceRoot = resolve(hooks.namespaceRoot)
    const canonicalTempRoot = resolve(await realpath(tmpdir()))
    const tempRelative = relative(canonicalTempRoot, namespaceRoot)
    const namespaceInfo = await lstat(namespaceRoot)
    const admissionSnapshot = isVerifiedNativeSelectorQualAdmission(hooks.admission)
      ? nativeSelectorQualAdmissionSnapshot(hooks.admission)
      : undefined
    if (
      hooks.offlineTestOnly !== true ||
      admissionSnapshot?.authority !== 'offlineTestOnly' ||
      admissionSnapshot.namespaceRoot !== namespaceRoot ||
      !isAbsolute(hooks.protocolPath) ||
      resolve(options.protocolPath) !== resolve(hooks.protocolPath) ||
      options.protocolSha256 !== hooks.admission.protocolSha256 ||
      !tempRelative ||
      tempRelative === '..' ||
      tempRelative.startsWith(`..${sep}`) ||
      namespaceRoot === canonicalTempRoot ||
      !namespaceInfo.isDirectory() ||
      namespaceInfo.isSymbolicLink() ||
      (await realpath(namespaceRoot)) !== namespaceRoot
    )
      throw new RangeError(
        'Offline QUAL CLI requires matching verified admission in a temp namespace',
      )
    admission = hooks.admission
  } else {
    admission = await verifyNativeSelectorQualAdmission({
      protocolPath: options.protocolPath,
      protocolSha256: options.protocolSha256,
      action: options.command,
    })
  }
  const registrationPath = join(namespaceRoot, 'admission', 'registration.json')
  const ledgerPath = hooks
    ? join(namespaceRoot, 'campaign-ledger.json')
    : join(namespaceRoot, 'admission', 'campaign-ledger.json')
  const executionRoot = join(namespaceRoot, 'execution')
  if (options.command === 'register') {
    if (!hooks)
      await verifyNativeSelectorQualSourceClosure({
        closurePath: admission.protocol.producerClosure.path,
        closureSha256: admission.protocol.producerClosure.sha256,
        expectedSourceCommit: admission.protocol.policy.producerSourceCommit,
        parentStudyId: assertNativeSelectorQualParentRoot(admission.protocol.parentDev.root),
        repositoryRoot,
      })
    const release = await acquireExclusiveFileLock(join(executionRoot, '.qual-runner.lock'), true)
    try {
      const registration = createNativeSelectorQualRegistration(admission)
      const ledger = hooks
        ? await NativeSelectorQualLedger.openOfflineAdmissionForTest(
            ledgerPath,
            dirname(ledgerPath),
            admission,
          )
        : await NativeSelectorQualLedger.open(ledgerPath, admission)
      ledger.assertResumeAllowed()
      await writeImmutable(registrationPath, registration)
    } finally {
      await release()
    }
    return
  }
  if (options.command === 'closeout') {
    if (!hooks)
      await verifyNativeSelectorQualSourceClosure({
        closurePath: admission.protocol.producerClosure.path,
        closureSha256: admission.protocol.producerClosure.sha256,
        expectedSourceCommit: admission.protocol.policy.producerSourceCommit,
        parentStudyId: assertNativeSelectorQualParentRoot(admission.protocol.parentDev.root),
        repositoryRoot,
      })
    const release = await acquireExclusiveFileLock(join(executionRoot, '.qual-runner.lock'), true)
    try {
      const registered = JSON.parse(await readFile(registrationPath, 'utf8')) as unknown
      const expectedRegistration = createNativeSelectorQualRegistration(admission)
      if (JSON.stringify(registered) !== JSON.stringify(expectedRegistration))
        throw new RangeError('QUAL registration does not match the pinned protocol and freeze')
      if (hooks)
        await NativeSelectorQualLedger.validateOfflineAdmissionState(
          ledgerPath,
          dirname(ledgerPath),
          admission,
        )
      else await NativeSelectorQualLedger.validateCloseoutState(ledgerPath, admission)
      const result = await assembleNativeSelectorQualCloseouts(admission)
      const resultPath = join(executionRoot, 'qualification-result.json')
      const failurePath = join(executionRoot, 'run-failure.json')
      let completedRun: unknown = null
      let runFailure: unknown = null
      try {
        completedRun = JSON.parse(await readFile(resultPath, 'utf8')) as unknown
      } catch (error) {
        if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      }
      try {
        runFailure = JSON.parse(await readFile(failurePath, 'utf8')) as unknown
      } catch (error) {
        if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
      }
      const hasVerifiedRun = nativeSelectorQualCompletedRunMatches({
        completedRun,
        runFailure,
        protocolSha256: admission.protocolSha256,
        candidateCloseoutSha256: result.candidateCloseout.closeoutSha256,
        controlCloseoutSha256: result.controlCloseout.closeoutSha256,
        gate: result.gate,
      })
      await writeImmutable(join(executionRoot, 'qualification-closeout-review.json'), {
        schema: 'h8a-native-selector-qual120-closeout-review-v1',
        protocolSha256: admission.protocolSha256,
        candidateCloseoutSha256: result.candidateCloseout.closeoutSha256,
        controlCloseoutSha256: result.controlCloseout.closeoutSha256,
        gate: result.gate,
        executionValidity: hasVerifiedRun ? 'valid' : 'incomplete',
        runtimeDisposed: hasVerifiedRun,
      })
    } finally {
      await release()
    }
    return
  }

  const release = await acquireExclusiveFileLock(join(executionRoot, '.qual-runner.lock'), true)
  let launchRoot: string | undefined
  const controller = new AbortController()
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('QUAL process interrupted'))
  }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  let ports: Awaited<ReturnType<typeof createH8FreshRuntimePorts>> | undefined
  let runnerOwnsRuntime = false
  const runtimeStatus = { disposed: false }
  const runOutcome: { completed?: Awaited<ReturnType<typeof runNativeSelectorQual120>> } = {}
  const runErrors: unknown[] = []
  const cleanupErrors: unknown[] = []
  try {
    if (!hooks)
      await verifyNativeSelectorQualSourceClosure({
        closurePath: admission.protocol.producerClosure.path,
        closureSha256: admission.protocol.producerClosure.sha256,
        expectedSourceCommit: admission.protocol.policy.producerSourceCommit,
        parentStudyId: assertNativeSelectorQualParentRoot(admission.protocol.parentDev.root),
        repositoryRoot,
      })
    const registered = JSON.parse(await readFile(registrationPath, 'utf8')) as unknown
    const expectedRegistration = createNativeSelectorQualRegistration(admission)
    if (JSON.stringify(registered) !== JSON.stringify(expectedRegistration))
      throw new RangeError('QUAL registration does not match the pinned protocol and freeze')
    await readFile(ledgerPath)
    const ledger = hooks
      ? await NativeSelectorQualLedger.openOfflineAdmissionForTest(
          ledgerPath,
          dirname(ledgerPath),
          admission,
        )
      : await NativeSelectorQualLedger.open(ledgerPath, admission)
    ledger.assertResumeAllowed()
    const launchIntentPath = join(executionRoot, 'qualification-launch-intent.json')
    await writeImmutable(launchIntentPath, {
      schema: 'h8a-native-selector-qual120-launch-intent-v1',
      protocolSha256: admission.protocolSha256,
      freezeCommitmentSha256: computePhaseFreezeCommitmentSha256(admission.freeze),
      startedAtIso: new Date().toISOString(),
    })
    if (Date.now() >= Date.parse(admission.freeze.deadlineIso))
      throw new RangeError('QUAL execution deadline has passed')
    let apiKey: string | undefined
    if (!hooks) {
      apiKey = process.env.OPENROUTER_API_KEY
      if (!apiKey)
        throw new RangeError(
          'Required provider key environment variable OPENROUTER_API_KEY is unset',
        )
    }
    if (hooks) {
      launchRoot = await mkdtemp(join(executionRoot, '.native-selector-qual-launch-'))
      ports = await hooks.createRuntime({ executionRoot, temporaryRoot: launchRoot, admission })
    } else {
      const runtime = await verifyRuntimeProof(
        {
          runtimeFilesPath: admission.protocol.runtimeProof.path,
          runtimeFilesSha256: admission.protocol.runtimeProof.sha256,
        },
        UI_STATE_DEV40_RUNTIME_ENVIRONMENT_SHA256,
        resolve(repositoryRoot),
        true,
        {
          runtimeFilesSha256: admission.protocol.runtimeProof.sha256,
          runtimeEnvironmentSha256: admission.protocol.runtimeEnvironment.sha256,
        },
      )
      const historical = await loadHistoricalControl(runtime.proof.historicalSourceRoot)
      const runtimeBinding = nativeSelectorRuntimeFactoryOptions()
      launchRoot = await mkdtemp(join(NATIVE_SELECTOR_QUAL_ROOT, '.native-selector-qual-launch-'))
      ports = await createH8FreshRuntimePorts({
        apiKey: apiKey!,
        artifactRoot: executionRoot,
        temporaryRoot: launchRoot,
        maskArtifactDirectory: join(executionRoot, 'masks'),
        cutoutArtifactDirectory: join(executionRoot, 'cutouts'),
        candidateProfileId: runtimeBinding.candidateProfileId,
        nativeRuntime: {
          ...runtimeBinding.nativeRuntime,
          pythonExecutable: runtime.pythonExecutable,
          assetRoot: runtime.candidateAssetsRoot,
        },
        selectionPolicyId: runtimeBinding.selectionPolicyId,
        mobileSam: {
          encoderPath: runtime.mobileSamEncoderPath,
          decoderPath: runtime.mobileSamDecoderPath,
        },
        sourceCanvasByOpaqueCaseId: new Map(
          admission.freeze.producerCases.map((item) => [
            item.opaqueCaseId,
            { width: item.sourceCanvasWidth, height: item.sourceCanvasHeight },
          ]),
        ),
        controlEngine: historical,
      })
    }
    runnerOwnsRuntime = true
    runOutcome.completed = await runNativeSelectorQual120({
      admission,
      candidatePort: ports.candidatePort,
      controlPort: ports.controlPort,
      runtimeArtifacts: ports.artifacts,
      disposeRuntime: async () => {
        await ports!.dispose()
        Object.assign(runtimeStatus, { disposed: true })
      },
      signal: controller.signal,
    })
  } catch (error) {
    runErrors.push(error)
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    if (ports && !runnerOwnsRuntime) {
      try {
        await ports.dispose()
        Object.assign(runtimeStatus, { disposed: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (launchRoot) {
      try {
        if (hooks?.removeLaunchRoot) await hooks.removeLaunchRoot(launchRoot)
        else await rm(launchRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await release()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  const failure = cleanupErrors[0] ?? runErrors[0]
  if (failure !== undefined) {
    await writeImmutable(join(executionRoot, 'run-failure.json'), {
      schema: 'h8a-native-selector-qual120-run-failure-v1',
      protocolSha256: admission.protocolSha256,
      errorCode: safeErrorCode(failure),
      stoppedAtIso: new Date().toISOString(),
      runtimeDisposed: runtimeStatus.disposed,
      cleanupComplete: cleanupErrors.length === 0,
    })
    throw failure
  }
  const completed = runOutcome.completed
  if (!completed) throw new RangeError('QUAL runner completed without a closeout result')
  await writeImmutable(join(executionRoot, 'qualification-result.json'), {
    schema: 'h8a-native-selector-qual120-result-v1',
    protocolSha256: admission.protocolSha256,
    candidateCloseoutSha256: completed.candidateCloseout.closeoutSha256,
    controlCloseoutSha256: completed.controlCloseout.closeoutSha256,
    gate: completed.gate,
    runtimeDisposed: runtimeStatus.disposed,
    cleanupComplete: true,
  })
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  runNativeSelectorQualCli(process.argv.slice(2), repositoryRoot).catch((error: unknown) => {
    process.stderr.write(`${safeErrorCode(error)}\n`)
    process.exitCode = 1
  })
}
