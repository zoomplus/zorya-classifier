import { randomUUID, createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, mkdir, lstat, realpath, writeFile, unlink, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { CampaignLedger } from './campaign-ledger.js'
import { verifyPersistedDevFreeze } from './dev-freeze-assembly.js'
import { hashIdentity } from './hash-identity.js'
import { immutableCloseoutSchema } from './schemas.js'
import { validateReceiptGraph } from './evaluator.js'
import {
  CAMPAIGN_MAX_COST_USD,
  CAMPAIGN_MAX_PHYSICAL_CALLS,
  candidateIdForPhase,
  PHASE_FLAT_DEV40_ID,
  PROFILE_FLAT_CANDIDATE_ID,
} from './constants.js'
import type { createH8FreshRuntimePorts } from './runtime-ports.js'
import type {
  processRegionSeededCase,
  assertRecorderHealthy,
} from '../../v02/region-seeded-runner.js'
import type { createClassifier } from '../../../src/app/create-classifier.js'
import type { createOpenRouterDecisions } from '../../../src/openrouter.js'
import type { createNativeCategoricalPresencePort } from '../../v02/native-categorical-presence-port.js'
import type { createMobileSamSegmenter } from '../../../src/segmentation.js'
import type { executeDevScreen } from './dev-screen-runner.js'

const PINNED_RUNTIME_PROOF_SHA256 =
  '5a75be16864e3b9560aa21ca79511f74bccf10360804e539040ae8751e402697'
const PINNED_FLAT_RUNTIME_PROOF_SHA256 =
  '278015e2d7a9bbd7f308c865c01a9dc2277ec48d89d11852400940ef6e0ec389'
const PINNED_FLAT_RUNTIME_ENVIRONMENT_SHA256 =
  '1941f16dfb906f54331cc06c8b58bed15b86b65d86f16f7f708b49bc60680ba6'
const PINNED_CAMPAIGN_CONFIG_SHA256 =
  '12da3eb42a9f8dae52ff678241686af2775c0592539827df6801996ed48ee076'
const PINNED_HISTORICAL_RECEIPT_SHA256 =
  '0422a3e62925bb33f4fe41480d6554887ae9c888681125f8b8522d9174361f71'
const HISTORICAL_CONTROL_CLOSURE_SHA256 =
  'be43090b13951e9a6ffa65daffb9413a6a539d8dae335925dc885733a467fb20'
const PINNED_V1_BINDING_SHA256 = 'f568d1a1be7d1e84008052a16a4e2698778d2a2684acf93bad2de3c3228effcf'
const PINNED_V1_DEV8_REPORT_SHA256 =
  'a1be577f669cb256f0efa476c2f34d85db5305a52858ee612471d5cd05c3dabd'
const PINNED_V1_DEV8_REVIEW_SHA256 =
  '278366d5ccb900352ddcb61bc2a2e324726740ae5335cf00b249861732eaf2f6'
const PINNED_V1_CANDIDATE_CLOSEOUT_SHA256 =
  '48e2bb88b7f08a26b0aada1537191eaed6b7218c79f6573b174692851fe279cb'
const PINNED_V1_CONTROL_CLOSEOUT_SHA256 =
  '470ba940432cf5a5a823f5c70b1eccff6878d77cd15f2b0cbcd67bed201a113f'
const PINNED_V2_BINDING_SHA256 = 'a6d8945a52bb6e6054dbba1dcbba6425ce8efc4cb6d9ede242c71f40081aefa0'
const PINNED_V2_DEV8_REPORT_SHA256 =
  '8f5d28f43edc23ba96ead729ecc854ad47f6390da67e4b1848f7efb6ab2de8d3'
const PINNED_V2_DEV8_REVIEW_SHA256 =
  'd84e18b5e3dff393b35fd45467f4dd521e96e86e8defa9c33d287108da496e9a'
const PINNED_V2_CANDIDATE_CLOSEOUT_SHA256 =
  'cc13f0674248c7920f6ed16557f89d6608bf46b8a09eba14f6b84e7039be5c27'
const PINNED_V2_CONTROL_CLOSEOUT_SHA256 =
  '52a63701820c055e984cc5e085d0ab6e752eb07f7e40686363afff8c6ef74322'
const DISJOINT_FREEZE_ID = 'h8a-flat-disjoint-dev40-20261101-v1'
const FLAT_EXPERIMENT_DIRECTORY = join('experiments', 'h8a-flat-dev40-v1')
const DISJOINT_EXPERIMENT_DIRECTORY = join('experiments', 'flat-disjoint-replication-v1')
const RUN_ROOT_MARKER = '.h8a-shared-campaign.json'
const RUN_ROOT_LOCK = '.h8a-native-runner.lock'
const JSON_LIMIT = 4 * 1024 * 1024
const MAX_PINNED_FILE_BYTES = 1_500_000_000
const REQUIRED_LIVE_CLOSURE_PATHS = [
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-cli.ts',
  'benchmarks/v03/h8a-fresh-comparison/runtime-ports.ts',
  'benchmarks/v03/h8a-fresh-comparison/campaign-ledger.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-sampling.ts',
  'benchmarks/v03/h8a-fresh-comparison/paired-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/case-artifact-store.ts',
  'benchmarks/v03/h8a-fresh-comparison/profiles.ts',
  'benchmarks/v03/h8a-fresh-comparison/schemas.ts',
  'benchmarks/v03/h8a-fresh-comparison/hash-identity.ts',
  'benchmarks/v03/h8a-fresh-comparison/constants.ts',
  'benchmarks/v03/h8a-fresh-comparison/phase-deadline.ts',
  'benchmarks/v03/h8a-fresh-comparison/freeze-admission.ts',
  'benchmarks/v03/h8a-fresh-comparison/evaluator.ts',
  'benchmarks/v03/h8a-fresh-comparison/packed-binary-lsb0.ts',
  'benchmarks/v03/h8a-fresh-comparison/annotation-digest.ts',
  'benchmarks/v03/h8a-fresh-comparison/freeze-commitment.ts',
  'benchmarks/v03/h8a-fresh-comparison/source-group-validation.ts',
  'benchmarks/v03/h8a-fresh-comparison/physical-dispatch.ts',
  'benchmarks/v03/h8a-fresh-comparison/campaign-fetch-boundary.ts',
]

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const cliOptionsSchema = z
  .object({
    authorityPath: z.string().min(1),
    authoritySha256: digestSchema,
    freezeDirectory: z.string().min(1),
    sourceRoot: z.string().min(1),
    runtimeFilesPath: z.string().min(1),
    runtimeFilesSha256: digestSchema,
    campaignConfigPath: z.string().min(1),
    campaignConfigSha256: z.literal(PINNED_CAMPAIGN_CONFIG_SHA256),
    runRoot: z.string().min(1),
    screen: z.enum(['dev8', 'dev12', 'dev40']).optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/u)
      .optional(),
  })
  .strict()

const runtimeFileSchema = z
  .object({ path: z.string().min(1), sha256: digestSchema, bytes: z.number().int().nonnegative() })
  .strict()

const runtimeProofSchema = z
  .object({
    schema: z.literal('h8a-dev-ready-runtime-files-v1'),
    checkedUtc: z.string().datetime({ offset: true }),
    candidateAndControlAssets: z.array(runtimeFileSchema).length(18),
    candidateAssetsRoot: z.string().min(1),
    historicalSourceRoot: z.string().min(1),
    historicalSourceReceiptSha256: z.literal(PINNED_HISTORICAL_RECEIPT_SHA256),
    historicalIndividuallyMatchedSources: z.literal(68),
    nativeRuntimeInputReceiptSha256: digestSchema,
    nodeExecutable: z.string().min(1),
    nodeSha256: digestSchema,
    pythonExecutable: z.string().min(1),
    pythonSha256: digestSchema,
    packageLockSha256: digestSchema,
    liveInferenceCalls: z.literal(0),
    reference: z.string().min(1),
  })
  .strict()

const historicalSnapshotSchema = z
  .object({
    schema: z.literal('historical-v02-final-v3-source-snapshot-v1'),
    sourceClosureIdentityFromFreeze: z.literal(HISTORICAL_CONTROL_CLOSURE_SHA256),
    fileCount: z.literal(68),
    sourceFiles: z
      .array(
        z
          .object({
            bytes: z.number().int().nonnegative(),
            historicKey: z.string().min(1),
            path: z.string().min(1),
            sha256: digestSchema,
          })
          .strict(),
      )
      .length(68),
    dependencyLock: z
      .object({
        currentFileSha256: digestSchema,
        historicalFileSha256: digestSchema,
        installedDependencyLookup: z.literal('explicit symlink to repo node_modules'),
        matchingNonRootDependencyRows: z.number().int().positive(),
        nonRootDependencyVersionIntegrityUrlMatched: z.literal(true),
        rootPackageMetadataAndAnyNonidentityLockFieldsMayDiffer: z.literal(true),
      })
      .strict(),
  })
  .passthrough()

const campaignConfigSchema = z
  .object({
    schema: z.literal('h8a-shared-campaign-config-v1'),
    campaignId: z.string().min(1).max(120),
    canonicalRoot: z.string().min(1),
    maxCostUsd: z.literal(CAMPAIGN_MAX_COST_USD),
    maxPhysicalCalls: z.literal(CAMPAIGN_MAX_PHYSICAL_CALLS),
  })
  .strict()

const campaignMarkerSchema = z
  .object({
    schema: z.literal('h8a-shared-campaign-root-v1'),
    campaignId: z.string().min(1).max(120),
    canonicalRoot: z.string().min(1),
    campaignConfigSha256: digestSchema,
    maxCostUsd: z.literal(CAMPAIGN_MAX_COST_USD),
    maxPhysicalCalls: z.literal(CAMPAIGN_MAX_PHYSICAL_CALLS),
  })
  .strict()

const devPhaseBindingSchema = z
  .object({
    schema: z.literal('h8a-phase-campaign-binding-v1'),
    phaseId: z.enum(['h8a-fresh-paired-dev40-v1', PHASE_FLAT_DEV40_ID]),
    authoritySha256: digestSchema,
    freezeId: z.string().min(1),
    freezeCommitmentSha256: digestSchema,
  })
  .strict()

const screenReviewSchema = z
  .object({
    schema: z.literal('h8a-dev-screen-review-v1'),
    screenReportSha256: digestSchema,
    reviewProtocol: z.literal('no-apparent-collapse-main-review-v1'),
    reviewerId: z.literal('main-orchestrator'),
    judgement: z.enum(['advance', 'stop']),
    reason: z.string().min(1).max(1000),
    reviewSha256: digestSchema,
  })
  .strict()

type CliOptions = z.infer<typeof cliOptionsSchema>

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function parseArguments(argv: readonly string[]):
  | { command: 'init'; options: CliOptions }
  | { command: 'register'; options: CliOptions }
  | {
      command: 'run'
      options: CliOptions & { screen: NonNullable<CliOptions['screen']>; apiKeyEnv: string }
    } {
  const [command, ...args] = argv
  if (command !== 'init' && command !== 'register' && command !== 'run')
    throw new TypeError(
      'Usage: dev-screen-cli.ts <init|register|run> --authority PATH --authority-sha256 HEX --freeze-dir DIR --source-root DIR --runtime-files PATH --runtime-files-sha256 HEX --campaign-config PATH --campaign-config-sha256 HEX --run-root DIR [--screen dev8|dev12|dev40 --api-key-env OPENROUTER_API_KEY]',
    )
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || !value || values.has(key))
      throw new TypeError('Invalid or duplicate CLI argument')
    values.set(key, value)
  }
  const allowed = new Set([
    '--authority',
    '--authority-sha256',
    '--freeze-dir',
    '--source-root',
    '--runtime-files',
    '--runtime-files-sha256',
    '--campaign-config',
    '--campaign-config-sha256',
    '--run-root',
    ...(command === 'run' ? ['--screen', '--api-key-env'] : []),
  ])
  for (const key of values.keys())
    if (!allowed.has(key)) throw new TypeError('Unexpected CLI argument')
  const parsed = cliOptionsSchema.parse({
    authorityPath: values.get('--authority'),
    authoritySha256: values.get('--authority-sha256'),
    freezeDirectory: values.get('--freeze-dir'),
    sourceRoot: values.get('--source-root'),
    runtimeFilesPath: values.get('--runtime-files'),
    runtimeFilesSha256: values.get('--runtime-files-sha256'),
    campaignConfigPath: values.get('--campaign-config'),
    campaignConfigSha256: values.get('--campaign-config-sha256'),
    runRoot: values.get('--run-root'),
    ...(values.has('--screen') ? { screen: values.get('--screen') } : {}),
    ...(values.has('--api-key-env') ? { apiKeyEnv: values.get('--api-key-env') } : {}),
  })
  if (command === 'init') {
    if (parsed.screen || parsed.apiKeyEnv)
      throw new TypeError('init does not accept stage or key options')
    return { command, options: parsed }
  }
  if (command === 'register') {
    if (parsed.screen || parsed.apiKeyEnv)
      throw new TypeError('register does not accept stage or key options')
    return { command, options: parsed }
  }
  if (!parsed.screen || !parsed.apiKeyEnv)
    throw new TypeError('run requires --screen and --api-key-env')
  return { command, options: { ...parsed, screen: parsed.screen, apiKeyEnv: parsed.apiKeyEnv } }
}

async function verifyPinnedFile(
  path: string,
  expectedSha256: string,
  expectedBytes?: number,
  maxBytes = MAX_PINNED_FILE_BYTES,
  allowExecutableAlias = false,
): Promise<string> {
  const target = resolve(path)
  const real = await realpath(target)
  if (target !== real && !allowExecutableAlias)
    throw new RangeError('Pinned runtime path is symlinked or aliased')
  const beforePath = await lstat(real)
  if (
    !beforePath.isFile() ||
    beforePath.isSymbolicLink() ||
    (expectedBytes !== undefined && beforePath.size !== expectedBytes) ||
    beforePath.size > maxBytes
  )
    throw new RangeError('Pinned runtime file size or type mismatch')
  const expectedSize = expectedBytes ?? beforePath.size
  const handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(expectedSize) || before.size > BigInt(maxBytes))
      throw new RangeError('Opened runtime file is not the pinned regular file')
    const hash = createHash('sha256')
    let bytesRead = 0
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesRead += value.byteLength
      if (bytesRead > maxBytes) throw new RangeError('Pinned runtime file exceeds byte cap')
      hash.update(value)
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(real)
    if (
      bytesRead !== expectedSize ||
      BigInt(beforePath.dev) !== before.dev ||
      BigInt(beforePath.ino) !== before.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(pathAfter.dev) !== after.dev ||
      BigInt(pathAfter.ino) !== after.ino ||
      (await realpath(target)) !== real
    )
      throw new RangeError('Pinned runtime file changed during verification')
    if (hash.digest('hex') !== expectedSha256)
      throw new RangeError('Pinned runtime file SHA-256 mismatch')
    return allowExecutableAlias ? target : real
  } finally {
    await handle.close()
  }
}

async function readVerifiedRegularFile(
  path: string,
  expectedSha256: string | undefined,
  trustedRoot: string | undefined,
  maxBytes: number,
): Promise<Buffer> {
  const target = resolve(path)
  const real = await realpath(target)
  if (target !== real || (trustedRoot && !within(resolve(trustedRoot), real)))
    throw new RangeError('Pinned input path is symlinked, aliased, or outside its root')
  const beforePath = await lstat(target)
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > maxBytes)
    throw new RangeError('Pinned input must be a bounded regular file')
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new RangeError('Opened input must be a bounded regular file')
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(target)
    if (
      bytes.byteLength !== Number(before.size) ||
      BigInt(beforePath.dev) !== before.dev ||
      BigInt(beforePath.ino) !== before.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(pathAfter.dev) !== after.dev ||
      BigInt(pathAfter.ino) !== after.ino ||
      (await realpath(target)) !== target
    )
      throw new RangeError('Pinned input changed while it was read')
    if (expectedSha256 && digest(bytes) !== expectedSha256)
      throw new RangeError('Pinned input SHA-256 mismatch')
    return bytes
  } finally {
    await handle.close()
  }
}

async function readVerifiedJson<T>(
  path: string,
  expectedSha256: string,
  trustedRoot: string | undefined,
  schema: z.ZodType<T>,
): Promise<T> {
  const bytes = await readVerifiedRegularFile(path, expectedSha256, trustedRoot, JSON_LIMIT)
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  return schema.parse(parsed)
}

function absoluteCanonicalPath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value)
    throw new RangeError(`${label} must be an absolute normalized path`)
  return value
}

function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new RangeError('Pinned relative path must not be absolute')
  const target = resolve(root, relativePath)
  if (!within(resolve(root), target)) throw new RangeError('Pinned relative path escapes its root')
  return target
}

export interface VerifiedRuntimeProof {
  proof: z.infer<typeof runtimeProofSchema>
  candidateAssetsRoot: string
  mobileSamEncoderPath: string
  mobileSamDecoderPath: string
  pythonExecutable: string
}

interface RuntimeProofPins {
  runtimeFilesSha256: string
  runtimeEnvironmentSha256: string
}

export async function verifyRuntimeProof(
  options: Pick<CliOptions, 'runtimeFilesPath' | 'runtimeFilesSha256'>,
  runtimeEnvironmentSha256: string,
  repositoryRoot: string,
  flat = false,
  pins?: RuntimeProofPins,
): Promise<VerifiedRuntimeProof> {
  const expectedRuntimeProofSha256 =
    pins?.runtimeFilesSha256 ??
    (flat ? PINNED_FLAT_RUNTIME_PROOF_SHA256 : PINNED_RUNTIME_PROOF_SHA256)
  if (options.runtimeFilesSha256 !== expectedRuntimeProofSha256)
    throw new RangeError('Runtime files receipt differs from the selected frozen profile')
  if (pins && runtimeEnvironmentSha256 !== pins.runtimeEnvironmentSha256)
    throw new RangeError('Runtime environment differs from the caller-supplied trusted proof pins')
  if (flat && runtimeEnvironmentSha256 !== PINNED_FLAT_RUNTIME_ENVIRONMENT_SHA256)
    throw new RangeError('Flat runtime proof is not bound to the frozen V2 environment digest')
  const proof = await readVerifiedJson(
    options.runtimeFilesPath,
    options.runtimeFilesSha256,
    undefined,
    runtimeProofSchema,
  )
  if (proof.nativeRuntimeInputReceiptSha256 !== runtimeEnvironmentSha256)
    throw new RangeError('Runtime files receipt differs from the pinned freeze environment input')
  const candidateAssetsRoot = absoluteCanonicalPath(
    proof.candidateAssetsRoot,
    'Candidate asset root',
  )
  const historicalSourceRoot = absoluteCanonicalPath(
    proof.historicalSourceRoot,
    'Historical source root',
  )
  if ((await realpath(candidateAssetsRoot)) !== candidateAssetsRoot)
    throw new RangeError('Candidate asset root is symlinked or aliased')
  if ((await realpath(historicalSourceRoot)) !== historicalSourceRoot)
    throw new RangeError('Historical source root is symlinked or aliased')

  const nodePath = absoluteCanonicalPath(proof.nodeExecutable, 'Node executable')
  if ((await realpath(nodePath)) !== (await realpath(process.execPath)))
    throw new RangeError('Running Node executable differs from the pinned runtime executable')
  await verifyPinnedFile(nodePath, proof.nodeSha256)
  const pythonProofPath = absoluteCanonicalPath(proof.pythonExecutable, 'Python executable')
  const pythonExecutable = await verifyPinnedFile(
    pythonProofPath,
    proof.pythonSha256,
    undefined,
    MAX_PINNED_FILE_BYTES,
    true,
  )
  await verifyPinnedFile(join(repositoryRoot, 'package-lock.json'), proof.packageLockSha256)

  let mobileSamEncoderPath: string | undefined
  let mobileSamDecoderPath: string | undefined
  const candidateAssetPaths: string[] = []
  for (const asset of proof.candidateAndControlAssets) {
    const assetPath = absoluteCanonicalPath(asset.path, 'Runtime asset path')
    await verifyPinnedFile(assetPath, asset.sha256, asset.bytes)
    if (assetPath.endsWith('/mobile_sam_image_encoder.onnx')) mobileSamEncoderPath = assetPath
    else if (assetPath.endsWith('/sam_mask_decoder_multi.onnx')) mobileSamDecoderPath = assetPath
    else {
      if (!within(candidateAssetsRoot, assetPath))
        throw new RangeError('Candidate model asset lies outside its pinned asset root')
      candidateAssetPaths.push(assetPath)
    }
  }
  if (
    candidateAssetPaths.length !== 16 ||
    !mobileSamEncoderPath ||
    !mobileSamDecoderPath ||
    new Set(proof.candidateAndControlAssets.map((asset) => asset.path)).size !== 18
  )
    throw new RangeError('Pinned runtime asset inventory is incomplete or duplicated')

  const receiptPath = resolve(historicalSourceRoot, '..', 'snapshot-receipt.json')
  const receiptBytes = await readVerifiedRegularFile(
    receiptPath,
    proof.historicalSourceReceiptSha256,
    undefined,
    JSON_LIMIT,
  )
  const receiptUnknown: unknown = JSON.parse(receiptBytes.toString('utf8'))
  const receipt = historicalSnapshotSchema.parse(receiptUnknown)
  if (receipt.dependencyLock.currentFileSha256 !== proof.packageLockSha256)
    throw new RangeError(
      'Historical snapshot dependency receipt differs from the pinned package lock',
    )
  const historicalNodeModules = join(historicalSourceRoot, 'node_modules')
  const historicalModulesLink = await lstat(historicalNodeModules)
  if (!historicalModulesLink.isSymbolicLink())
    throw new RangeError(
      'Historical dependencies are not mounted through the pinned node_modules link',
    )
  if (
    (await realpath(historicalNodeModules)) !==
    (await realpath(join(repositoryRoot, 'node_modules')))
  )
    throw new RangeError(
      'Historical source resolves dependencies from a different node_modules tree',
    )
  const uniqueHistoricalPaths = new Set<string>()
  const aggregateBytes = receipt.sourceFiles.reduce((sum, file) => sum + file.bytes, 0)
  if (aggregateBytes > 32 * 1024 * 1024)
    throw new RangeError('Historical source closure exceeds cap')
  const requiredHistoricalPaths = new Set([
    'benchmarks/v02/region-seeded-runner.ts',
    'src/app/create-classifier.ts',
    'src/infrastructure/openrouter.ts',
    'benchmarks/v02/native-categorical-presence-port.ts',
    'src/segmentation.ts',
  ])
  for (const entry of receipt.sourceFiles) {
    if (uniqueHistoricalPaths.has(entry.path))
      throw new RangeError('Historical source path is duplicated')
    uniqueHistoricalPaths.add(entry.path)
    await verifyPinnedFile(
      resolveInside(historicalSourceRoot, entry.path),
      entry.sha256,
      entry.bytes,
      4 * 1024 * 1024,
    )
    requiredHistoricalPaths.delete(entry.path)
  }
  if (requiredHistoricalPaths.size > 0)
    throw new RangeError('Historical control entrypoint is absent from the pinned source receipt')
  return {
    proof,
    candidateAssetsRoot,
    mobileSamEncoderPath,
    mobileSamDecoderPath,
    pythonExecutable,
  }
}

interface VerifiedCampaignConfig {
  campaignId: string
  canonicalRoot: string
  sha256: string
}

export async function verifyCampaignConfig(options: {
  campaignConfigPath: string
  campaignConfigSha256: string
  runRoot: string
}): Promise<VerifiedCampaignConfig> {
  if (options.campaignConfigSha256 !== PINNED_CAMPAIGN_CONFIG_SHA256)
    throw new RangeError('Campaign config digest differs from the registered campaign pin')
  const config = await readVerifiedJson(
    options.campaignConfigPath,
    options.campaignConfigSha256,
    undefined,
    campaignConfigSchema,
  )
  const runRoot = absoluteCanonicalPath(options.runRoot, 'Campaign root')
  if (config.canonicalRoot !== runRoot)
    throw new RangeError('Campaign root differs from the pinned campaign config')
  if ((await realpath(dirname(runRoot))) !== dirname(runRoot))
    throw new RangeError('Campaign root parent is symlinked or aliased')
  return {
    campaignId: config.campaignId,
    canonicalRoot: runRoot,
    sha256: options.campaignConfigSha256,
  }
}

async function verifyFreeze(options: CliOptions, repositoryRoot: string) {
  const sourceRoot = absoluteCanonicalPath(options.sourceRoot, 'Source root')
  if ((await realpath(sourceRoot)) !== repositoryRoot || sourceRoot !== repositoryRoot)
    throw new RangeError('Source root must be the checkout executing this CLI')
  return await verifyPersistedDevFreeze(options.freezeDirectory, {
    authorityPath: options.authorityPath,
    authoritySha256: options.authoritySha256,
    sourceRoot,
  })
}

function parsePinnedExport<T>(moduleValue: unknown, field: string, schema: z.ZodType<T>): T {
  const exportsRecord = z.record(z.string(), z.unknown()).parse(moduleValue)
  return schema.parse(exportsRecord[field])
}

const pinnedFunction = <T extends (...args: never[]) => unknown>() =>
  z.custom<T>((value) => typeof value === 'function')

export async function loadHistoricalControl(root: string) {
  const importPinned = async (path: string): Promise<unknown> =>
    await import(pathToFileURL(join(root, path)).href)
  const [kernelRaw, classifierRaw, decisionsRaw, categoricalRaw, segmentationRaw] =
    await Promise.all([
      importPinned('benchmarks/v02/region-seeded-runner.ts'),
      importPinned('src/app/create-classifier.ts'),
      importPinned('src/infrastructure/openrouter.ts'),
      importPinned('benchmarks/v02/native-categorical-presence-port.ts'),
      importPinned('src/segmentation.ts'),
    ])
  return {
    kind: 'verified-historical-v02' as const,
    sourceClosureSha256: HISTORICAL_CONTROL_CLOSURE_SHA256,
    snapshotReceiptSha256: PINNED_HISTORICAL_RECEIPT_SHA256,
    processRegionSeededCase: parsePinnedExport(
      kernelRaw,
      'processRegionSeededCase',
      pinnedFunction<typeof processRegionSeededCase>(),
    ),
    assertRecorderHealthy: parsePinnedExport(
      kernelRaw,
      'assertRecorderHealthy',
      pinnedFunction<typeof assertRecorderHealthy>(),
    ),
    createClassifier: parsePinnedExport(
      classifierRaw,
      'createClassifier',
      pinnedFunction<typeof createClassifier>(),
    ),
    createOpenRouterDecisions: parsePinnedExport(
      decisionsRaw,
      'createOpenRouterDecisions',
      pinnedFunction<typeof createOpenRouterDecisions>(),
    ),
    createNativeCategoricalPresencePort: parsePinnedExport(
      categoricalRaw,
      'createNativeCategoricalPresencePort',
      pinnedFunction<typeof createNativeCategoricalPresencePort>(),
    ),
    createMobileSamSegmenter: parsePinnedExport(
      segmentationRaw,
      'createMobileSamSegmenter',
      pinnedFunction<typeof createMobileSamSegmenter>(),
    ),
  }
}

export async function acquireRunnerLock(root: string): Promise<() => Promise<void>> {
  const lockPath = join(root, RUN_ROOT_LOCK)
  const ownerToken = randomUUID()
  const handle = await open(lockPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, ownerToken, acquiredAt: Date.now() }))
    await handle.sync()
  } catch (error) {
    await handle.close()
    throw error
  }
  return async () => {
    try {
      const bytes = await readVerifiedRegularFile(lockPath, undefined, root, 4096)
      const lockValue: unknown = JSON.parse(bytes.toString('utf8'))
      const lock = z
        .object({
          pid: z.number().int().nonnegative(),
          ownerToken: z.string().min(1),
          acquiredAt: z.number().finite(),
        })
        .strict()
        .parse(lockValue)
      const [ownedFile, currentPath] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(lockPath),
      ])
      if (
        lock.ownerToken !== ownerToken ||
        BigInt(currentPath.dev) !== ownedFile.dev ||
        BigInt(currentPath.ino) !== ownedFile.ino
      )
        throw new RangeError('Runner lock ownership changed')
      await unlink(lockPath)
    } finally {
      await handle.close()
    }
  }
}

async function validateRunRoot(
  config: VerifiedCampaignConfig,
  authoritySha256: string,
  freeze: Awaited<ReturnType<typeof verifyFreeze>>['freeze'],
): Promise<void> {
  const root = config.canonicalRoot
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(root)) !== root)
    throw new RangeError('Shared campaign root must be an existing real directory')
  const markerPath = join(root, RUN_ROOT_MARKER)
  const markerBytes = await readVerifiedRegularFile(markerPath, undefined, root, JSON_LIMIT)
  const marker = campaignMarkerSchema.parse(JSON.parse(markerBytes.toString('utf8')) as unknown)
  const ledgerPath = join(root, 'campaign-ledger.json')
  const ledgerInfo = await lstat(ledgerPath)
  if (!ledgerInfo.isFile() || ledgerInfo.isSymbolicLink() || ledgerInfo.size > JSON_LIMIT)
    throw new RangeError('Shared campaign ledger must already exist as a bounded regular file')
  if (
    marker.campaignId !== config.campaignId ||
    marker.canonicalRoot !== root ||
    marker.campaignConfigSha256 !== config.sha256 ||
    marker.maxCostUsd !== CAMPAIGN_MAX_COST_USD ||
    marker.maxPhysicalCalls !== CAMPAIGN_MAX_PHYSICAL_CALLS
  )
    throw new RangeError('Shared campaign marker differs from its pinned campaign config')
  await verifyDevPhaseBinding(root, authoritySha256, freeze)
}

export async function verifyDevPhaseBinding(
  root: string,
  authoritySha256: string,
  freeze: Awaited<ReturnType<typeof verifyFreeze>>['freeze'],
): Promise<void> {
  const bindingBytes = await readVerifiedRegularFile(
    join(root, 'phase-bindings', 'dev40-binding.json'),
    undefined,
    root,
    JSON_LIMIT,
  )
  const binding = devPhaseBindingSchema.parse(JSON.parse(bindingBytes.toString('utf8')) as unknown)
  if (
    binding.authoritySha256 !== authoritySha256 ||
    binding.freezeId !== freeze.freezeId ||
    binding.freezeCommitmentSha256 !== freeze.cohortCommitmentSha256
  )
    throw new RangeError('DEV40 run root is bound to a different immutable authority or freeze')
}

function flatExperimentRoot(campaignRoot: string): string {
  const path = resolve(campaignRoot, FLAT_EXPERIMENT_DIRECTORY)
  if (!within(resolve(campaignRoot), path) || path === resolve(campaignRoot))
    throw new RangeError('Flat experiment namespace escapes the registered campaign root')
  return path
}

async function assertPinnedFileDigest(path: string, expectedSha256: string): Promise<Buffer> {
  const bytes = await readVerifiedRegularFile(path, expectedSha256, undefined, JSON_LIMIT)
  return bytes
}

async function verifyPriorV1StopEvidence(campaignRoot: string): Promise<number> {
  const bindingBytes = await assertPinnedFileDigest(
    join(campaignRoot, 'phase-bindings', 'dev40-binding.json'),
    PINNED_V1_BINDING_SHA256,
  )
  const binding = devPhaseBindingSchema.parse(JSON.parse(bindingBytes.toString('utf8')) as unknown)
  if (
    binding.phaseId !== 'h8a-fresh-paired-dev40-v1' ||
    binding.freezeId !== 'h8a-fresh-dev40-20261101-v1'
  )
    throw new RangeError('Existing V1 campaign registration differs from the fixed prior freeze')

  const reportBytes = await assertPinnedFileDigest(
    join(campaignRoot, 'reports', 'dev8-report.json'),
    PINNED_V1_DEV8_REPORT_SHA256,
  )
  const reviewBytes = await assertPinnedFileDigest(
    join(campaignRoot, 'reviews', 'dev8-review.json'),
    PINNED_V1_DEV8_REVIEW_SHA256,
  )
  const runner = await import('./dev-screen-runner.js')
  const report = runner.devScreenReportSchema.parse(JSON.parse(reportBytes.toString('utf8')))
  const review = screenReviewSchema.parse(JSON.parse(reviewBytes.toString('utf8')) as unknown)
  const { reportSha256, ...reportBody } = report
  const { reviewSha256, ...reviewBody } = review
  if (
    report.screen !== 'dev8' ||
    hashIdentity(reportBody) !== reportSha256 ||
    report.completedPairs >= report.expectedPairs ||
    report.hardBlockers.length === 0 ||
    review.judgement !== 'stop' ||
    review.screenReportSha256 !== reportSha256 ||
    hashIdentity(reviewBody) !== reviewSha256
  )
    throw new RangeError('Prior V1 DEV8 stop report or review is invalid')

  const candidateBytes = await assertPinnedFileDigest(
    join(campaignRoot, 'closeouts', 'dev40-candidate-closeout.json'),
    PINNED_V1_CANDIDATE_CLOSEOUT_SHA256,
  )
  const controlBytes = await assertPinnedFileDigest(
    join(campaignRoot, 'closeouts', 'dev40-control-closeout.json'),
    PINNED_V1_CONTROL_CLOSEOUT_SHA256,
  )
  let priorKnownCostUsd = 0
  for (const [bytes, profileId] of [
    [candidateBytes, 'h8a-cpu-raw-target-v1'],
    [controlBytes, 'v02-final-v3-fresh-cohort-replay-v1'],
  ] as const) {
    const closeout = immutableCloseoutSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
    validateReceiptGraph(closeout)
    if (
      closeout.phaseId !== 'h8a-fresh-paired-dev40-v1' ||
      closeout.freezeId !== 'h8a-fresh-dev40-20261101-v1' ||
      closeout.profileId !== profileId
    )
      throw new RangeError('Prior V1 closeout does not match its pinned phase and profile')
    priorKnownCostUsd += closeout.physicalReceipts.reduce(
      (sum, receipt) => sum + (receipt.chargeState === 'known' ? (receipt.costUsd ?? 0) : 0),
      0,
    )
  }
  if (Math.abs(priorKnownCostUsd - 0.00599665) > 1e-12)
    throw new RangeError('Pinned prior V1 closeouts no longer prove the settled campaign spend')
  return priorKnownCostUsd
}

async function verifyPriorDisjointStopEvidence(campaignRoot: string): Promise<number> {
  await verifyPriorV1StopEvidence(campaignRoot)
  const priorFlatRoot = resolve(campaignRoot, FLAT_EXPERIMENT_DIRECTORY)
  const priorFlatBinding = await assertPinnedFileDigest(
    join(priorFlatRoot, 'phase-binding.json'),
    PINNED_V2_BINDING_SHA256,
  )
  const flatBinding = devPhaseBindingSchema.parse(
    JSON.parse(priorFlatBinding.toString('utf8')) as unknown,
  )
  if (
    flatBinding.phaseId !== PHASE_FLAT_DEV40_ID ||
    flatBinding.freezeId !== 'h8a-flat-dev40-20261101-v1'
  )
    throw new RangeError('Existing flat V2 binding differs from the fixed historical freeze')

  const reportBytes = await assertPinnedFileDigest(
    join(priorFlatRoot, 'reports', 'dev8-report.json'),
    PINNED_V2_DEV8_REPORT_SHA256,
  )
  const reviewBytes = await assertPinnedFileDigest(
    join(priorFlatRoot, 'reviews', 'dev8-review.json'),
    PINNED_V2_DEV8_REVIEW_SHA256,
  )
  const runner = await import('./dev-screen-runner.js')
  const report = runner.devScreenReportSchema.parse(JSON.parse(reportBytes.toString('utf8')))
  const review = screenReviewSchema.parse(JSON.parse(reviewBytes.toString('utf8')) as unknown)
  const { reportSha256, ...reportBody } = report
  const { reviewSha256, ...reviewBody } = review
  if (
    report.screen !== 'dev8' ||
    hashIdentity(reportBody) !== reportSha256 ||
    report.completedPairs >= report.expectedPairs ||
    report.hardBlockers.length === 0 ||
    review.judgement !== 'stop' ||
    review.screenReportSha256 !== reportSha256 ||
    hashIdentity(reviewBody) !== reviewSha256
  )
    throw new RangeError('Prior flat V2 DEV8 stop report or review is invalid')

  const closeouts = await Promise.all([
    assertPinnedFileDigest(
      join(campaignRoot, 'closeouts', 'dev40-candidate-closeout.json'),
      PINNED_V1_CANDIDATE_CLOSEOUT_SHA256,
    ),
    assertPinnedFileDigest(
      join(campaignRoot, 'closeouts', 'dev40-control-closeout.json'),
      PINNED_V1_CONTROL_CLOSEOUT_SHA256,
    ),
    assertPinnedFileDigest(
      join(priorFlatRoot, 'closeouts', 'dev40-candidate-closeout.json'),
      PINNED_V2_CANDIDATE_CLOSEOUT_SHA256,
    ),
    assertPinnedFileDigest(
      join(priorFlatRoot, 'closeouts', 'dev40-control-closeout.json'),
      PINNED_V2_CONTROL_CLOSEOUT_SHA256,
    ),
  ])
  const expected = [
    {
      phaseId: 'h8a-fresh-paired-dev40-v1',
      freezeId: 'h8a-fresh-dev40-20261101-v1',
      profileId: 'h8a-cpu-raw-target-v1',
    },
    {
      phaseId: 'h8a-fresh-paired-dev40-v1',
      freezeId: 'h8a-fresh-dev40-20261101-v1',
      profileId: 'v02-final-v3-fresh-cohort-replay-v1',
    },
    {
      phaseId: PHASE_FLAT_DEV40_ID,
      freezeId: 'h8a-flat-dev40-20261101-v1',
      profileId: PROFILE_FLAT_CANDIDATE_ID,
    },
    {
      phaseId: PHASE_FLAT_DEV40_ID,
      freezeId: 'h8a-flat-dev40-20261101-v1',
      profileId: 'v02-final-v3-fresh-cohort-replay-v1',
    },
  ] as const
  const receiptIds = new Set<number>()
  let knownCostUsd = 0
  for (const [index, bytes] of closeouts.entries()) {
    const closeout = immutableCloseoutSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
    validateReceiptGraph(closeout)
    const binding = expected[index]!
    if (
      closeout.phaseId !== binding.phaseId ||
      closeout.freezeId !== binding.freezeId ||
      closeout.profileId !== binding.profileId
    )
      throw new RangeError('Historical V1/V2 closeout differs from its pinned phase or profile')
    for (const receipt of closeout.physicalReceipts) {
      if (
        !receipt.settled ||
        receipt.chargeState !== 'known' ||
        receipt.costUsd === null ||
        receipt.physicalId === null ||
        receiptIds.has(receipt.receiptId)
      )
        throw new RangeError('Historical physical receipts are not unique, settled, and known')
      receiptIds.add(receipt.receiptId)
      knownCostUsd += receipt.costUsd
    }
  }
  if (receiptIds.size !== 14 || Math.abs(knownCostUsd - 0.009603065) > 1e-12)
    throw new RangeError('Historical V1/V2 evidence does not prove 14 distinct settled charges')
  return knownCostUsd
}

interface FlatRegistration {
  schema: 'h8a-flat-dev40-registration-v1'
  authoritySha256: string
  freezeId: string
  phaseId: typeof PHASE_FLAT_DEV40_ID
  freezeCommitmentSha256: string
  priorV1BindingSha256: string
  priorV1StopReportSha256: string
  priorV1StopReviewSha256: string
  priorV1CandidateCloseoutSha256: string
  priorV1ControlCloseoutSha256: string
}

const flatRegistrationSchema = z
  .object({
    schema: z.literal('h8a-flat-dev40-registration-v1'),
    authoritySha256: digestSchema,
    freezeId: z.literal('h8a-flat-dev40-20261101-v1'),
    phaseId: z.literal(PHASE_FLAT_DEV40_ID),
    freezeCommitmentSha256: digestSchema,
    priorV1BindingSha256: z.literal(PINNED_V1_BINDING_SHA256),
    priorV1StopReportSha256: z.literal(PINNED_V1_DEV8_REPORT_SHA256),
    priorV1StopReviewSha256: z.literal(PINNED_V1_DEV8_REVIEW_SHA256),
    priorV1CandidateCloseoutSha256: z.literal(PINNED_V1_CANDIDATE_CLOSEOUT_SHA256),
    priorV1ControlCloseoutSha256: z.literal(PINNED_V1_CONTROL_CLOSEOUT_SHA256),
  })
  .strict()

const disjointRegistrationSchema = z
  .object({
    schema: z.literal('h8a-disjoint-dev40-registration-v1'),
    studyId: z.literal('flat-disjoint-replication-v1'),
    authoritySha256: digestSchema,
    freezeId: z.literal(DISJOINT_FREEZE_ID),
    phaseId: z.literal(PHASE_FLAT_DEV40_ID),
    freezeCommitmentSha256: digestSchema,
    parentRegistrationSha256: z.literal(
      '5c63045a648928c9aefe12aad99464e8394b3bc42c133b39821036eb74f3bff0',
    ),
    acceptedHistorySha256: z.literal(
      '8743d618233e84025463dbfd6f51c580388e9e053a716fbed0ff76afb9c215f4',
    ),
    priorV1BindingSha256: z.literal(PINNED_V1_BINDING_SHA256),
    priorV1StopReportSha256: z.literal(PINNED_V1_DEV8_REPORT_SHA256),
    priorV1StopReviewSha256: z.literal(PINNED_V1_DEV8_REVIEW_SHA256),
    priorV1CandidateCloseoutSha256: z.literal(PINNED_V1_CANDIDATE_CLOSEOUT_SHA256),
    priorV1ControlCloseoutSha256: z.literal(PINNED_V1_CONTROL_CLOSEOUT_SHA256),
    priorV2BindingSha256: z.literal(PINNED_V2_BINDING_SHA256),
    priorV2StopReportSha256: z.literal(PINNED_V2_DEV8_REPORT_SHA256),
    priorV2StopReviewSha256: z.literal(PINNED_V2_DEV8_REVIEW_SHA256),
    priorV2CandidateCloseoutSha256: z.literal(PINNED_V2_CANDIDATE_CLOSEOUT_SHA256),
    priorV2ControlCloseoutSha256: z.literal(PINNED_V2_CONTROL_CLOSEOUT_SHA256),
  })
  .strict()

async function writeExclusiveOrVerifyExact(path: string, expected: Buffer): Promise<void> {
  try {
    await writeFile(path, expected, { flag: 'wx', mode: 0o600 })
    return
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
  }
  const existing = await readVerifiedRegularFile(path, undefined, dirname(path), JSON_LIMIT)
  if (!existing.equals(expected))
    throw new RangeError('Existing flat registration file conflicts with frozen bytes')
}

async function writeImmutableRegistrationFiles(
  artifactRoot: string,
  binding: z.infer<typeof devPhaseBindingSchema>,
  registration: Buffer,
  label: 'flat' | 'disjoint',
): Promise<void> {
  await ensureRealDirectory(artifactRoot)
  const registrationFiles = new Map([
    ['phase-binding.json', Buffer.from(`${JSON.stringify(binding)}\n`)],
    ['registration.json', registration],
  ])
  const existing = await readdir(artifactRoot)
  if (existing.some((name) => !registrationFiles.has(name)))
    throw new RangeError(`${label} namespace contains stale artifacts before registration`)
  for (const name of existing) {
    const bytes = await readVerifiedRegularFile(
      join(artifactRoot, name),
      undefined,
      artifactRoot,
      JSON_LIMIT,
    )
    if (!bytes.equals(registrationFiles.get(name)!))
      throw new RangeError(`Existing ${label} registration conflicts with frozen bytes`)
  }
  await writeExclusiveOrVerifyExact(
    join(artifactRoot, 'phase-binding.json'),
    registrationFiles.get('phase-binding.json')!,
  )
  await writeExclusiveOrVerifyExact(
    join(artifactRoot, 'registration.json'),
    registrationFiles.get('registration.json')!,
  )
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'EEXIST')) throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new RangeError('Flat campaign path component must be a real directory')
}

async function withCampaignRegistrationLock<T>(
  root: string,
  acquireLock: ScreenRunDependencies['acquireLock'],
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(root)
  try {
    return await operation()
  } finally {
    await release()
  }
}

async function readCampaignRegistrationLedger(
  root: string,
  openLedger: ScreenRunDependencies['openLedger'],
) {
  const ledger = await openLedger(join(root, 'campaign-ledger.json'))
  ledger.assertResumeAllowed()
  return ledger.snapshot()
}

function hasCampaignBudgetCaps(snapshot: ReturnType<CampaignLedger['snapshot']>): boolean {
  return (
    snapshot.maxCostUsd === CAMPAIGN_MAX_COST_USD &&
    snapshot.maxPhysicalCalls === CAMPAIGN_MAX_PHYSICAL_CALLS
  )
}

export async function verifyFlatDevRegistration(
  campaignRoot: string,
  authoritySha256: string,
  freeze: Awaited<ReturnType<typeof verifyFreeze>>['freeze'],
  verifyPriorEvidence: (root: string) => Promise<number> = verifyPriorV1StopEvidence,
): Promise<string> {
  if (freeze.phaseId !== PHASE_FLAT_DEV40_ID || freeze.freezeId !== 'h8a-flat-dev40-20261101-v1')
    throw new RangeError('Flat registration requires the flat DEV40 profile freeze')
  if (
    candidateIdForPhase(freeze.phaseId) !== PROFILE_FLAT_CANDIDATE_ID ||
    freeze.profileBindings[0]?.profileId !== PROFILE_FLAT_CANDIDATE_ID
  )
    throw new RangeError('Flat DEV40 freeze does not bind its registered native candidate profile')
  await verifyPriorEvidence(campaignRoot)
  const artifactRoot = flatExperimentRoot(campaignRoot)
  const rootStat = await lstat(artifactRoot)
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await realpath(artifactRoot)) !== artifactRoot
  )
    throw new RangeError('Flat experiment namespace must be an existing real directory')
  const registrationBytes = await readVerifiedRegularFile(
    join(artifactRoot, 'registration.json'),
    undefined,
    artifactRoot,
    JSON_LIMIT,
  )
  const registration = flatRegistrationSchema.parse(
    JSON.parse(registrationBytes.toString('utf8')) as unknown,
  )
  const bindingBytes = await readVerifiedRegularFile(
    join(artifactRoot, 'phase-binding.json'),
    undefined,
    artifactRoot,
    JSON_LIMIT,
  )
  const binding = devPhaseBindingSchema.parse(JSON.parse(bindingBytes.toString('utf8')) as unknown)
  if (
    registration.authoritySha256 !== authoritySha256 ||
    registration.freezeId !== freeze.freezeId ||
    registration.freezeCommitmentSha256 !== freeze.cohortCommitmentSha256 ||
    binding.phaseId !== PHASE_FLAT_DEV40_ID ||
    binding.authoritySha256 !== authoritySha256 ||
    binding.freezeId !== freeze.freezeId ||
    binding.freezeCommitmentSha256 !== freeze.cohortCommitmentSha256
  )
    throw new RangeError('Flat campaign namespace is bound to different authority or freeze bytes')
  return artifactRoot
}

function disjointExperimentRoot(campaignRoot: string): string {
  const path = resolve(campaignRoot, DISJOINT_EXPERIMENT_DIRECTORY)
  if (!within(resolve(campaignRoot), path) || path === resolve(campaignRoot))
    throw new RangeError('Disjoint experiment namespace escapes the registered campaign root')
  return path
}

export async function verifyDisjointDevRegistration(
  campaignRoot: string,
  authoritySha256: string,
  freeze: Awaited<ReturnType<typeof verifyFreeze>>['freeze'],
  verifyPriorEvidence: (root: string) => Promise<number> = verifyPriorDisjointStopEvidence,
): Promise<string> {
  if (
    freeze.phaseId !== PHASE_FLAT_DEV40_ID ||
    freeze.freezeId !== DISJOINT_FREEZE_ID ||
    candidateIdForPhase(freeze.phaseId) !== PROFILE_FLAT_CANDIDATE_ID ||
    freeze.profileBindings[0]?.profileId !== PROFILE_FLAT_CANDIDATE_ID
  )
    throw new RangeError('Disjoint registration requires its exact frozen flat DEV40 profile')
  await verifyPriorEvidence(campaignRoot)
  const artifactRoot = disjointExperimentRoot(campaignRoot)
  const rootStat = await lstat(artifactRoot)
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await realpath(artifactRoot)) !== artifactRoot
  )
    throw new RangeError('Disjoint experiment namespace must be an existing real directory')
  const [registrationBytes, bindingBytes] = await Promise.all([
    readVerifiedRegularFile(
      join(artifactRoot, 'registration.json'),
      undefined,
      artifactRoot,
      JSON_LIMIT,
    ),
    readVerifiedRegularFile(
      join(artifactRoot, 'phase-binding.json'),
      undefined,
      artifactRoot,
      JSON_LIMIT,
    ),
  ])
  const registration = disjointRegistrationSchema.parse(
    JSON.parse(registrationBytes.toString('utf8')) as unknown,
  )
  const binding = devPhaseBindingSchema.parse(JSON.parse(bindingBytes.toString('utf8')) as unknown)
  if (
    registration.authoritySha256 !== authoritySha256 ||
    registration.freezeId !== freeze.freezeId ||
    registration.freezeCommitmentSha256 !== freeze.cohortCommitmentSha256 ||
    binding.phaseId !== PHASE_FLAT_DEV40_ID ||
    binding.authoritySha256 !== authoritySha256 ||
    binding.freezeId !== freeze.freezeId ||
    binding.freezeCommitmentSha256 !== freeze.cohortCommitmentSha256
  )
    throw new RangeError('Disjoint namespace is bound to different authority or freeze bytes')
  return artifactRoot
}

export async function registerFlatDevComparison(
  options: Pick<CliOptions, 'authoritySha256'>,
  verified: VerifiedScreenInputs,
  config: VerifiedCampaignConfig,
  dependencies: Pick<ScreenRunDependencies, 'acquireLock' | 'openLedger'> & {
    verifyPriorV1Evidence?: (root: string) => Promise<number>
  } = {
    acquireLock: acquireRunnerLock,
    openLedger: (path) => CampaignLedger.open(path),
  },
): Promise<void> {
  if (
    verified.freeze.phaseId !== PHASE_FLAT_DEV40_ID ||
    verified.freeze.freezeId !== 'h8a-flat-dev40-20261101-v1'
  )
    throw new RangeError('register only accepts the separately frozen flat DEV40 profile')
  const root = config.canonicalRoot
  const verifyPriorEvidence = dependencies.verifyPriorV1Evidence ?? verifyPriorV1StopEvidence
  await validateRunRootForFlat(config)
  await verifyPriorEvidence(root)
  await withCampaignRegistrationLock(root, dependencies.acquireLock, async () => {
    await validateRunRootForFlat(config)
    const minimumPriorSpend = await verifyPriorEvidence(root)
    const snapshot = await readCampaignRegistrationLedger(root, dependencies.openLedger)
    if (
      !hasCampaignBudgetCaps(snapshot) ||
      snapshot.logicalAttemptCount < 3 ||
      snapshot.physicalDispatchCount < 7 ||
      (snapshot.nextReservationId ?? 0) < 8 ||
      snapshot.knownCostUsd + snapshot.unknownReserveUsd + 1e-12 < minimumPriorSpend
    )
      throw new RangeError('Shared campaign ledger differs from the existing global budget')
    const artifactRoot = flatExperimentRoot(root)
    await ensureRealDirectory(join(root, 'experiments'))
    await ensureRealDirectory(artifactRoot)
    const binding = devPhaseBindingSchema.parse({
      schema: 'h8a-phase-campaign-binding-v1',
      phaseId: PHASE_FLAT_DEV40_ID,
      authoritySha256: options.authoritySha256,
      freezeId: verified.freeze.freezeId,
      freezeCommitmentSha256: verified.freeze.cohortCommitmentSha256,
    })
    const registration: FlatRegistration = flatRegistrationSchema.parse({
      schema: 'h8a-flat-dev40-registration-v1',
      authoritySha256: options.authoritySha256,
      freezeId: verified.freeze.freezeId,
      phaseId: PHASE_FLAT_DEV40_ID,
      freezeCommitmentSha256: verified.freeze.cohortCommitmentSha256,
      priorV1BindingSha256: PINNED_V1_BINDING_SHA256,
      priorV1StopReportSha256: PINNED_V1_DEV8_REPORT_SHA256,
      priorV1StopReviewSha256: PINNED_V1_DEV8_REVIEW_SHA256,
      priorV1CandidateCloseoutSha256: PINNED_V1_CANDIDATE_CLOSEOUT_SHA256,
      priorV1ControlCloseoutSha256: PINNED_V1_CONTROL_CLOSEOUT_SHA256,
    })
    await writeImmutableRegistrationFiles(
      artifactRoot,
      binding,
      Buffer.from(`${JSON.stringify(registration)}\n`),
      'flat',
    )
  })
}

export async function registerDisjointDevComparison(
  options: Pick<CliOptions, 'authoritySha256'>,
  verified: VerifiedScreenInputs,
  config: VerifiedCampaignConfig,
  dependencies: Pick<ScreenRunDependencies, 'acquireLock' | 'openLedger'> & {
    verifyPriorEvidence?: (root: string) => Promise<number>
  } = {
    acquireLock: acquireRunnerLock,
    openLedger: (path) => CampaignLedger.open(path),
  },
): Promise<void> {
  if (
    verified.freeze.phaseId !== PHASE_FLAT_DEV40_ID ||
    verified.freeze.freezeId !== DISJOINT_FREEZE_ID ||
    verified.freeze.profileBindings[0]?.profileId !== PROFILE_FLAT_CANDIDATE_ID
  )
    throw new RangeError('register only accepts the pinned disjoint flat DEV40 profile')
  const root = config.canonicalRoot
  const verifyPriorEvidence = dependencies.verifyPriorEvidence ?? verifyPriorDisjointStopEvidence
  await validateRunRootForFlat(config)
  const minimumPriorSpend = await verifyPriorEvidence(root)
  await withCampaignRegistrationLock(root, dependencies.acquireLock, async () => {
    await validateRunRootForFlat(config)
    const confirmedPriorSpend = await verifyPriorEvidence(root)
    const snapshot = await readCampaignRegistrationLedger(root, dependencies.openLedger)
    if (
      !hasCampaignBudgetCaps(snapshot) ||
      snapshot.logicalAttemptCount !== 5 ||
      snapshot.physicalDispatchCount !== 14 ||
      snapshot.nextReservationId !== 15 ||
      snapshot.inFlightReservations.length !== 0 ||
      snapshot.unknownReserveUsd !== 0 ||
      snapshot.knownCostUsd + 1e-12 < confirmedPriorSpend ||
      confirmedPriorSpend !== minimumPriorSpend
    )
      throw new RangeError('Shared campaign ledger does not contain the settled V1/V2 budget floor')
    const artifactRoot = disjointExperimentRoot(root)
    await ensureRealDirectory(join(root, 'experiments'))
    await ensureRealDirectory(artifactRoot)
    const binding = devPhaseBindingSchema.parse({
      schema: 'h8a-phase-campaign-binding-v1',
      phaseId: PHASE_FLAT_DEV40_ID,
      authoritySha256: options.authoritySha256,
      freezeId: verified.freeze.freezeId,
      freezeCommitmentSha256: verified.freeze.cohortCommitmentSha256,
    })
    const registration = disjointRegistrationSchema.parse({
      schema: 'h8a-disjoint-dev40-registration-v1',
      studyId: 'flat-disjoint-replication-v1',
      authoritySha256: options.authoritySha256,
      freezeId: verified.freeze.freezeId,
      phaseId: PHASE_FLAT_DEV40_ID,
      freezeCommitmentSha256: verified.freeze.cohortCommitmentSha256,
      parentRegistrationSha256: '5c63045a648928c9aefe12aad99464e8394b3bc42c133b39821036eb74f3bff0',
      acceptedHistorySha256: '8743d618233e84025463dbfd6f51c580388e9e053a716fbed0ff76afb9c215f4',
      priorV1BindingSha256: PINNED_V1_BINDING_SHA256,
      priorV1StopReportSha256: PINNED_V1_DEV8_REPORT_SHA256,
      priorV1StopReviewSha256: PINNED_V1_DEV8_REVIEW_SHA256,
      priorV1CandidateCloseoutSha256: PINNED_V1_CANDIDATE_CLOSEOUT_SHA256,
      priorV1ControlCloseoutSha256: PINNED_V1_CONTROL_CLOSEOUT_SHA256,
      priorV2BindingSha256: PINNED_V2_BINDING_SHA256,
      priorV2StopReportSha256: PINNED_V2_DEV8_REPORT_SHA256,
      priorV2StopReviewSha256: PINNED_V2_DEV8_REVIEW_SHA256,
      priorV2CandidateCloseoutSha256: PINNED_V2_CANDIDATE_CLOSEOUT_SHA256,
      priorV2ControlCloseoutSha256: PINNED_V2_CONTROL_CLOSEOUT_SHA256,
    })
    await writeImmutableRegistrationFiles(
      artifactRoot,
      binding,
      Buffer.from(`${JSON.stringify(registration)}\n`),
      'disjoint',
    )
  })
}

async function validateRunRootForFlat(config: VerifiedCampaignConfig): Promise<void> {
  const root = config.canonicalRoot
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(root)) !== root)
    throw new RangeError('Shared campaign root must be an existing real directory')
  const markerBytes = await readVerifiedRegularFile(
    join(root, RUN_ROOT_MARKER),
    undefined,
    root,
    JSON_LIMIT,
  )
  const marker = campaignMarkerSchema.parse(JSON.parse(markerBytes.toString('utf8')) as unknown)
  const ledgerInfo = await lstat(join(root, 'campaign-ledger.json'))
  if (!ledgerInfo.isFile() || ledgerInfo.isSymbolicLink() || ledgerInfo.size > JSON_LIMIT)
    throw new RangeError('Shared campaign ledger must already exist as a bounded regular file')
  if (
    marker.campaignId !== config.campaignId ||
    marker.canonicalRoot !== root ||
    marker.campaignConfigSha256 !== config.sha256 ||
    marker.maxCostUsd !== CAMPAIGN_MAX_COST_USD ||
    marker.maxPhysicalCalls !== CAMPAIGN_MAX_PHYSICAL_CALLS ||
    config.sha256 !== PINNED_CAMPAIGN_CONFIG_SHA256
  )
    throw new RangeError(
      'Flat experiment must use the existing registered campaign root and budget',
    )
}

export async function verifyPriorStageFiles(
  root: string,
  screen: NonNullable<CliOptions['screen']>,
): Promise<void> {
  const priorScreen = screen === 'dev12' ? 'dev8' : screen === 'dev40' ? 'dev12' : null
  if (!priorScreen) return
  const [reportBytes, reviewBytes] = await Promise.all([
    readVerifiedRegularFile(
      join(root, 'reports', `${priorScreen}-report.json`),
      undefined,
      root,
      JSON_LIMIT,
    ),
    readVerifiedRegularFile(
      join(root, 'reviews', `${priorScreen}-review.json`),
      undefined,
      root,
      JSON_LIMIT,
    ),
  ])
  const reportUnknown: unknown = JSON.parse(reportBytes.toString('utf8'))
  const reviewUnknown: unknown = JSON.parse(reviewBytes.toString('utf8'))
  const runner = await import('./dev-screen-runner.js')
  const report = runner.devScreenReportSchema.parse(reportUnknown)
  const review = screenReviewSchema.parse(reviewUnknown)
  const { reportSha256, ...reportBody } = report
  const { reviewSha256, ...reviewBody } = review
  const expectedPairs = priorScreen === 'dev8' ? 8 : 12
  if (
    report.screen !== priorScreen ||
    hashIdentity(reportBody) !== reportSha256 ||
    report.completedPairs !== expectedPairs ||
    report.expectedPairs !== expectedPairs ||
    report.hardBlockers.length !== 0 ||
    report.candidateNegativeFalseOutputs !== 0 ||
    !report.weightedEstimateComplete ||
    review.judgement !== 'advance' ||
    review.screenReportSha256 !== reportSha256 ||
    hashIdentity(reviewBody) !== reviewSha256
  )
    throw new RangeError(`Prior ${priorScreen} screen lacks a valid main advance review`)
}

async function createCampaignRoot(
  config: VerifiedCampaignConfig,
  authoritySha256: string,
  freeze: Awaited<ReturnType<typeof verifyFreeze>>['freeze'],
): Promise<void> {
  await mkdir(dirname(config.canonicalRoot), { recursive: true, mode: 0o700 })
  await mkdir(config.canonicalRoot, { mode: 0o700 })
  const root = config.canonicalRoot
  if ((await realpath(root)) !== root)
    throw new RangeError('New campaign root is symlinked or aliased')
  const release = await acquireRunnerLock(root)
  try {
    const ledger = await CampaignLedger.open(join(root, 'campaign-ledger.json'))
    const snapshot = ledger.snapshot()
    if (
      snapshot.maxCostUsd !== CAMPAIGN_MAX_COST_USD ||
      snapshot.maxPhysicalCalls !== CAMPAIGN_MAX_PHYSICAL_CALLS
    )
      throw new RangeError('New shared campaign ledger has unexpected budget caps')
    const marker = campaignMarkerSchema.parse({
      schema: 'h8a-shared-campaign-root-v1',
      campaignId: config.campaignId,
      canonicalRoot: root,
      campaignConfigSha256: config.sha256,
      maxCostUsd: CAMPAIGN_MAX_COST_USD,
      maxPhysicalCalls: CAMPAIGN_MAX_PHYSICAL_CALLS,
    })
    await writeFile(join(root, RUN_ROOT_MARKER), `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await mkdir(join(root, 'phase-bindings'), { mode: 0o700 })
    const phaseBinding = devPhaseBindingSchema.parse({
      schema: 'h8a-phase-campaign-binding-v1',
      phaseId: freeze.phaseId,
      authoritySha256,
      freezeId: freeze.freezeId,
      freezeCommitmentSha256: freeze.cohortCommitmentSha256,
    })
    await writeFile(
      join(root, 'phase-bindings', 'dev40-binding.json'),
      `${JSON.stringify(phaseBinding)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      },
    )
  } finally {
    await release()
  }
}

interface ScreenRuntimePorts {
  candidatePort: Awaited<ReturnType<typeof createH8FreshRuntimePorts>>['candidatePort']
  controlPort: Awaited<ReturnType<typeof createH8FreshRuntimePorts>>['controlPort']
  artifacts: Awaited<ReturnType<typeof createH8FreshRuntimePorts>>['artifacts']
  dispose(): Promise<void>
}

interface ScreenRunDependencies {
  getApiKey(): string | undefined
  acquireLock(root: string): Promise<() => Promise<void>>
  openLedger(path: string): Promise<CampaignLedger>
  createRuntime(input: {
    apiKey: string
    root: string
    runtime: ScreenRuntimeProof
    verified: Awaited<ReturnType<typeof verifyFreeze>>
  }): Promise<ScreenRuntimePorts>
  execute(input: Parameters<typeof executeDevScreen>[0]): ReturnType<typeof executeDevScreen>
  writeReport(message: string): void
  verifyPriorV1Evidence?(root: string): Promise<number>
  verifyPriorDisjointEvidence?(root: string): Promise<number>
}

const productionScreenDependencies: ScreenRunDependencies = {
  getApiKey: () => undefined,
  acquireLock: acquireRunnerLock,
  openLedger: (path) => CampaignLedger.open(path),
  createRuntime: async ({ apiKey, root, runtime, verified }) => {
    const historical = await loadHistoricalControl(runtime.proof.historicalSourceRoot)
    const runtimePortsModule = await import('./runtime-ports.js')
    return await runtimePortsModule.createH8FreshRuntimePorts({
      apiKey,
      artifactRoot: root,
      temporaryRoot: join(root, 'temporary'),
      maskArtifactDirectory: join(root, 'masks'),
      cutoutArtifactDirectory: join(root, 'cutouts'),
      nativeRuntime: {
        recipeId: verified.freeze.profileBindings[0]!.profileId,
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
      controlEngine: historical,
    })
  },
  execute: async (input) => (await import('./dev-screen-runner.js')).executeDevScreen(input),
  writeReport: (message) => process.stdout.write(message),
}

interface VerifiedScreenInputs {
  freeze: Awaited<ReturnType<typeof verifyFreeze>>['freeze']
  annotations: Awaited<ReturnType<typeof verifyFreeze>>['annotations']
  selection: Awaited<ReturnType<typeof verifyFreeze>>['selection']
  sourceBytesByCaseId: Awaited<ReturnType<typeof verifyFreeze>>['sourceBytesByCaseId']
  sourceClosurePaths: Awaited<ReturnType<typeof verifyFreeze>>['sourceClosurePaths']
  runtimeEnvironmentSha256: string
}

export function assertLiveRunnerClosure(paths: readonly string[]): void {
  const closurePaths = new Set(paths)
  if (REQUIRED_LIVE_CLOSURE_PATHS.some((path) => !closurePaths.has(path)))
    throw new RangeError('Verified producer closure omits a DEV live runner or required loader')
}

interface ScreenRuntimeProof {
  proof: Pick<VerifiedRuntimeProof['proof'], 'historicalSourceRoot'>
  candidateAssetsRoot: string
  mobileSamEncoderPath: string
  mobileSamDecoderPath: string
  pythonExecutable: string
}

export async function runVerifiedDevScreen(
  options: Pick<CliOptions, 'authoritySha256' | 'screen' | 'apiKeyEnv'> & {
    screen: NonNullable<CliOptions['screen']>
    apiKeyEnv: string
  },
  verified: VerifiedScreenInputs,
  runtime: ScreenRuntimeProof,
  config: VerifiedCampaignConfig,
  dependencies: ScreenRunDependencies = {
    ...productionScreenDependencies,
    getApiKey: () => process.env[options.apiKeyEnv],
  },
): Promise<void> {
  // This is called only after the complete frozen inputs and runtime proof have passed.
  const flat = verified.freeze.phaseId === PHASE_FLAT_DEV40_ID
  const disjoint = verified.freeze.freezeId === DISJOINT_FREEZE_ID
  const verifyDisjointEvidence =
    dependencies.verifyPriorDisjointEvidence ?? verifyPriorDisjointStopEvidence
  if (flat) await validateRunRootForFlat(config)
  else await validateRunRoot(config, options.authoritySha256, verified.freeze)
  const artifactRoot = disjoint
    ? await verifyDisjointDevRegistration(
        config.canonicalRoot,
        options.authoritySha256,
        verified.freeze,
        verifyDisjointEvidence,
      )
    : flat
      ? await verifyFlatDevRegistration(
          config.canonicalRoot,
          options.authoritySha256,
          verified.freeze,
          dependencies.verifyPriorV1Evidence,
        )
      : config.canonicalRoot
  const minimumPriorSpend = disjoint
    ? await verifyDisjointEvidence(config.canonicalRoot)
    : flat
      ? await (dependencies.verifyPriorV1Evidence ?? verifyPriorV1StopEvidence)(
          config.canonicalRoot,
        )
      : 0
  await verifyPriorStageFiles(artifactRoot, options.screen)

  const apiKey = dependencies.getApiKey()
  if (!apiKey)
    throw new RangeError(
      `Required provider key environment variable is unset: ${options.apiKeyEnv}`,
    )

  const release = await dependencies.acquireLock(config.canonicalRoot)
  let runtimePorts: ScreenRuntimePorts | undefined
  const controller = new AbortController()
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('Process interruption'))
  }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    if (flat) {
      await validateRunRootForFlat(config)
      if (disjoint)
        await verifyDisjointDevRegistration(
          config.canonicalRoot,
          options.authoritySha256,
          verified.freeze,
          verifyDisjointEvidence,
        )
      else
        await verifyFlatDevRegistration(
          config.canonicalRoot,
          options.authoritySha256,
          verified.freeze,
          dependencies.verifyPriorV1Evidence,
        )
    } else await validateRunRoot(config, options.authoritySha256, verified.freeze)
    const ledgerPath = join(config.canonicalRoot, 'campaign-ledger.json')
    const ledger = await dependencies.openLedger(ledgerPath)
    ledger.assertResumeAllowed()
    const ledgerSnapshot = ledger.snapshot()
    if (
      ledgerSnapshot.maxCostUsd !== CAMPAIGN_MAX_COST_USD ||
      ledgerSnapshot.maxPhysicalCalls !== CAMPAIGN_MAX_PHYSICAL_CALLS ||
      (flat &&
        (ledgerSnapshot.logicalAttemptCount < (disjoint ? 5 : 3) ||
          ledgerSnapshot.physicalDispatchCount < (disjoint ? 14 : 7) ||
          (ledgerSnapshot.nextReservationId ?? 0) < (disjoint ? 15 : 8) ||
          (disjoint && ledgerSnapshot.inFlightReservations.length !== 0) ||
          ledgerSnapshot.knownCostUsd + ledgerSnapshot.unknownReserveUsd + 1e-12 <
            minimumPriorSpend))
    )
      throw new RangeError('Existing shared ledger has unexpected campaign budget caps')

    if (controller.signal.aborted) throw new RangeError('Screen setup was interrupted')
    runtimePorts = await dependencies.createRuntime({
      apiKey,
      root: artifactRoot,
      runtime,
      verified,
    })
    if (controller.signal.aborted) throw new RangeError('Screen setup was interrupted')
    const report = await dependencies.execute({
      freeze: verified.freeze,
      annotations: verified.annotations,
      sourceBytesByCaseId: verified.sourceBytesByCaseId,
      selection: verified.selection,
      screen: options.screen,
      selectionPath: join(artifactRoot, 'dev-screen-selection.json'),
      artifactRoot,
      ledger,
      candidatePort: runtimePorts.candidatePort,
      controlPort: runtimePorts.controlPort,
      runtimeArtifacts: runtimePorts.artifacts,
      signal: controller.signal,
    })
    dependencies.writeReport(
      `Completed ${report.screen}: ${report.completedPairs}/${report.expectedPairs} pairs; ${report.hardBlockers.length} blockers\n`,
    )
    if (report.completedPairs !== report.expectedPairs || report.hardBlockers.length > 0)
      throw new RangeError(`Screen ${report.screen} was recorded incomplete or with hard blockers`)
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

function safeErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return 'Input failed strict schema validation'
  if (!(error instanceof Error)) return 'unknown failure'
  return error.message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/(api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 240)
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2))
  const repositoryRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
  if ((await realpath(repositoryRoot)) !== repositoryRoot)
    throw new RangeError('CLI source checkout is symlinked or aliased')
  const verified = await verifyFreeze(parsed.options, repositoryRoot)
  assertLiveRunnerClosure(verified.sourceClosurePaths)
  const runtime = await verifyRuntimeProof(
    parsed.options,
    verified.runtimeEnvironmentSha256,
    repositoryRoot,
    verified.freeze.phaseId === PHASE_FLAT_DEV40_ID,
  )
  const config = await verifyCampaignConfig(parsed.options)
  if (parsed.command === 'init') {
    if (verified.freeze.phaseId !== 'h8a-fresh-paired-dev40-v1')
      throw new RangeError('init remains reserved for the existing V1 campaign registration')
    await createCampaignRoot(config, parsed.options.authoritySha256, verified.freeze)
    process.stdout.write(`Initialized shared campaign ${config.campaignId}\n`)
    return
  }
  if (parsed.command === 'register') {
    if (verified.freeze.phaseId !== PHASE_FLAT_DEV40_ID)
      throw new RangeError('register only accepts the separately frozen flat DEV40 profile')
    if (verified.freeze.freezeId === DISJOINT_FREEZE_ID) {
      await registerDisjointDevComparison(parsed.options, verified, config)
      process.stdout.write(
        `Registered disjoint DEV comparison in ${DISJOINT_EXPERIMENT_DIRECTORY}\n`,
      )
    } else {
      await registerFlatDevComparison(parsed.options, verified, config)
      process.stdout.write(`Registered flat DEV comparison in ${FLAT_EXPERIMENT_DIRECTORY}\n`)
    }
    return
  }
  await runVerifiedDevScreen(parsed.options, verified, runtime, config)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`DEV screen refused: ${safeErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}
