import { randomUUID, createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, mkdir, lstat, realpath, writeFile, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { CampaignLedger } from './campaign-ledger.js'
import { CAMPAIGN_MAX_COST_USD, CAMPAIGN_MAX_PHYSICAL_CALLS } from './constants.js'
import { verifyPersistedDevFreeze } from './dev-freeze-assembly.js'
import { hashIdentity } from './hash-identity.js'
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
const PINNED_CAMPAIGN_CONFIG_SHA256 =
  '12da3eb42a9f8dae52ff678241686af2775c0592539827df6801996ed48ee076'
const PINNED_HISTORICAL_RECEIPT_SHA256 =
  '0422a3e62925bb33f4fe41480d6554887ae9c888681125f8b8522d9174361f71'
const HISTORICAL_CONTROL_CLOSURE_SHA256 =
  'be43090b13951e9a6ffa65daffb9413a6a539d8dae335925dc885733a467fb20'
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
    runtimeFilesSha256: z.literal(PINNED_RUNTIME_PROOF_SHA256),
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
    phaseId: z.literal('h8a-fresh-paired-dev40-v1'),
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
  | {
      command: 'run'
      options: CliOptions & { screen: NonNullable<CliOptions['screen']>; apiKeyEnv: string }
    } {
  const [command, ...args] = argv
  if (command !== 'init' && command !== 'run')
    throw new TypeError(
      'Usage: dev-screen-cli.ts <init|run> --authority PATH --authority-sha256 HEX --freeze-dir DIR --source-root DIR --runtime-files PATH --runtime-files-sha256 HEX --campaign-config PATH --campaign-config-sha256 HEX --run-root DIR [--screen dev8|dev12|dev40 --api-key-env OPENROUTER_API_KEY]',
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

interface VerifiedRuntimeProof {
  proof: z.infer<typeof runtimeProofSchema>
  candidateAssetsRoot: string
  mobileSamEncoderPath: string
  mobileSamDecoderPath: string
  pythonExecutable: string
}

async function verifyRuntimeProof(
  options: CliOptions,
  runtimeEnvironmentSha256: string,
  repositoryRoot: string,
): Promise<VerifiedRuntimeProof> {
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

async function loadHistoricalControl(root: string) {
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
  await validateRunRoot(config, options.authoritySha256, verified.freeze)
  await verifyPriorStageFiles(config.canonicalRoot, options.screen)

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
    await validateRunRoot(config, options.authoritySha256, verified.freeze)
    const ledgerPath = join(config.canonicalRoot, 'campaign-ledger.json')
    const ledger = await dependencies.openLedger(ledgerPath)
    ledger.assertResumeAllowed()
    const ledgerSnapshot = ledger.snapshot()
    if (
      ledgerSnapshot.maxCostUsd !== CAMPAIGN_MAX_COST_USD ||
      ledgerSnapshot.maxPhysicalCalls !== CAMPAIGN_MAX_PHYSICAL_CALLS
    )
      throw new RangeError('Existing shared ledger has unexpected campaign budget caps')

    if (controller.signal.aborted) throw new RangeError('Screen setup was interrupted')
    runtimePorts = await dependencies.createRuntime({
      apiKey,
      root: config.canonicalRoot,
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
      selectionPath: join(config.canonicalRoot, 'dev-screen-selection.json'),
      artifactRoot: config.canonicalRoot,
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
  )
  const config = await verifyCampaignConfig(parsed.options)
  if (parsed.command === 'init') {
    await createCampaignRoot(config, parsed.options.authoritySha256, verified.freeze)
    process.stdout.write(`Initialized shared campaign ${config.campaignId}\n`)
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
