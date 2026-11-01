import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, mkdir, rename, rm, writeFile, lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { computeEvaluatorAnnotationsSha256 } from './annotation-digest.js'
import {
  CAMPAIGN_MAX_COST_USD,
  CAMPAIGN_MAX_PHYSICAL_CALLS,
  DEV40_CASE_COUNT,
  DEV40_NEGATIVE_COUNT,
  DEV40_POSITIVE_COUNT,
  DEV40_WORST_CASE_PHYSICAL_CALLS,
  H8A_FRESH_SCHEMA,
  PHASE_DEV40_ID,
  PHASE_FLAT_DEV40_ID,
  PROFILE_CANDIDATE_ID,
  PROFILE_FLAT_CANDIDATE_ID,
  PROFILE_CONTROL_ID,
  STRATUMS,
  candidateIdForPhase,
} from './constants.js'
import { buildDevScreenSelection, validateDevScreenSelection } from './dev-screen-sampling.js'
import { assertReferenceBoxesWithinCanvas, assertReferenceMaskDeclaration } from './evaluator.js'
import { hashIdentity } from './hash-identity.js'
import { validateConservativeCostProof, validateProfileIdentities } from './freeze-admission.js'
import { validateSourceGroupSplitSeparation } from './source-group-validation.js'
import { computeSourceGroupStratumCommitmentSha256 } from './source-group-validation.js'
import {
  H8A_CANDIDATE_PROFILE,
  H8A_FLAT_CANDIDATE_PROFILE,
  V02_CONTROL_PROFILE,
} from './profiles.js'
import {
  evaluatorPrivateAnnotationBundleSchema,
  phaseFreezeSchema,
  type EvaluatorPrivateAnnotationBundle,
  type PhaseFreeze,
} from './schemas.js'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const artifactRefSchema = z.object({ path: z.string().min(1), sha256 }).strict()
const JSON_FILE_LIMIT_BYTES = 4 * 1024 * 1024
const SOURCE_FILE_LIMIT_BYTES = 16 * 1024 * 1024
const MASK_FILE_LIMIT_BYTES = 8 * 1024 * 1024
const SOURCE_PIXEL_LIMIT = 16_000_000
const REQUIRED_PRODUCER_CLOSURE_PATHS = [
  'package-lock.json',
  'benchmarks/v03/h8a-full/factory.ts',
  'benchmarks/v03/h8a-full/native-port.ts',
  'benchmarks/v03/h8a-full/native-recipe.json',
  'benchmarks/v03/h8a-full/native-worker.py',
  'benchmarks/v03/h8a-fresh-comparison/dev-screen-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/paired-runner.ts',
  'benchmarks/v03/h8a-fresh-comparison/profiles.ts',
  'benchmarks/v03/h8a-fresh-comparison/schemas.ts',
] as const

const preparationAuthoritySchema = z
  .object({
    schema: z.literal('h8a-dev-freeze-preparation-v1'),
    freezeId: z.string().min(1),
    deadlineIso: z.string().datetime({ offset: true }),
    trustedRoot: z.string().min(1),
    orderProtocol: artifactRefSchema,
    mapRoster: artifactRefSchema,
    sourceClosure: artifactRefSchema,
    sourceGroupSplit: artifactRefSchema,
    priceProof: artifactRefSchema,
    runtimeEnvironment: artifactRefSchema,
    fragments: z.array(
      z.object({ fragmentId: z.string().min(1), path: z.string().min(1), sha256 }).strict(),
    ),
  })
  .strict()

const flatPreparationAuthoritySchema = preparationAuthoritySchema.extend({
  schema: z.literal('h8a-flat-dev-freeze-preparation-v1'),
  freezeId: z.literal('h8a-flat-dev40-20261101-v1'),
  priorDevAuthority: artifactRefSchema,
})
const PINNED_PRIOR_DEV_AUTHORITY_SHA256 =
  '0d5cc47d1759d2e276cdc3e0c44b7ef231c61cc49aa75a7cc62e9bec24bfafd2'

const reviewedFragmentSchema = z
  .object({
    schema: z.literal('h8a-dev-reviewed-fragment-v1'),
    fragmentId: z.string().min(1),
    producerRows: artifactRefSchema,
    annotations: artifactRefSchema,
    controllerPathIndex: artifactRefSchema,
    provenance: artifactRefSchema,
    fragmentReceipt: artifactRefSchema,
    referenceMasks: z.array(artifactRefSchema),
    reviewReceipts: z.array(artifactRefSchema).min(1),
    rows: z.array(
      z
        .object({
          opaqueCaseId: z.string().min(1),
          fragmentId: z.string().min(1),
          accepted: z.literal(true),
          sourceSha256: sha256,
          annotationSha256: sha256,
          sourceGroup: z.string().min(1),
          provenanceSha256: sha256,
          reviewReceiptSha256: sha256,
        })
        .strict(),
    ),
  })
  .strict()

const sourceClosureSchema = z
  .object({
    schema: z.literal('h8a-producer-closure-files-v1'),
    sourceCommit: z.string().min(1),
    files: z
      .array(
        z
          .object({ path: z.string().min(1), sha256, bytes: z.number().int().nonnegative() })
          .strict(),
      )
      .min(1),
  })
  .strict()

const priceEntrySchema = z
  .object({
    profileId: z.enum([PROFILE_CANDIDATE_ID, PROFILE_FLAT_CANDIDATE_ID, PROFILE_CONTROL_ID]),
    model: z.string().min(1),
    rawCatalog: artifactRefSchema,
    inputTokenBound: z.number().finite().positive(),
    maxOutputTokens: z.number().int().nonnegative(),
    inputRateUpperUsd: z.number().finite().nonnegative(),
    outputRateUpperUsd: z.number().finite().nonnegative(),
    computedWorstUsd: z.number().finite().positive(),
    maxUsdPerPhysicalDispatch: z.number().finite().positive(),
  })
  .strict()

const priceProofSchema = z
  .object({
    schema: z.literal('h8a-public-price-proof-v2'),
    observedUtc: z.string().datetime({ offset: true }),
    maxCostUsd: z.literal(CAMPAIGN_MAX_COST_USD),
    maxPhysicalCalls: z.literal(CAMPAIGN_MAX_PHYSICAL_CALLS),
    entries: z.tuple([priceEntrySchema, priceEntrySchema]),
  })
  .strict()

const runtimeEnvironmentSchema = z
  .object({
    schema: z.literal('fresh-dev-pre-dispatch-runtime-inputs-v1'),
    status: z.literal('preflight-not-a-code-or-corpus-freeze'),
    freshDevInferenceRequests: z.literal(0),
    recordedUtc: z.string().datetime({ offset: true }),
    h8NativeRecipeFileSha256: sha256,
    node: z.object({ packageLockSha256: sha256 }).passthrough(),
    concurrency: z
      .object({
        candidateTorchIntraOp: z.literal(8),
        candidateTorchInterOp: z.literal(1),
        candidateBLASOpenMP: z.literal(1),
        mobileSamOnnxCpuThreads: z.literal(2),
        maxPending: z.literal(2),
        nativeArmsActiveAtOnce: z.literal(1),
      })
      .passthrough(),
    assets: z
      .array(
        z
          .object({
            family: z.string().min(1),
            relative: z.string().min(1),
            bytes: z.number().int().positive(),
            sha256,
          })
          .strict(),
      )
      .length(18),
  })
  .passthrough()

const normalizeSourceGroup = (value: string): string => value.replace(/\/+$/u, '')

interface FragmentRows {
  producerRows: z.infer<typeof producerRowsSchema>
  annotations: z.infer<typeof privateAnnotationRowsSchema>
  annotationDigests: ReadonlyMap<string, string>
  rawAnnotationRows: ReadonlyMap<string, unknown>
  controllerPathIndex: Record<string, string>
  provenance: Record<string, unknown>
  provenanceDigests: ReadonlyMap<string, string>
  review: z.infer<typeof reviewedFragmentSchema>
}

const producerRowsSchema = z.array(
  z
    .object({
      opaqueCaseId: z.string().min(1),
      sourceBytesSha256: sha256,
      sourceCanvasWidth: z.number().int().positive(),
      sourceCanvasHeight: z.number().int().positive(),
      targetTaskText: z.string().min(1),
    })
    .strict(),
)

const privateAnnotationRowsSchema = z.array(
  z
    .object({
      opaqueCaseId: z.string().min(1),
      stratum: z.enum(STRATUMS),
      sourceGroup: z.string().min(1),
      expectedPresence: z.enum(['present', 'absent']),
      referenceBoxes: z.array(
        z
          .object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() })
          .strict(),
      ),
      referenceMasks: z.array(
        z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            packedBinarySha256: sha256,
          })
          .strict(),
      ),
      exactOriginalCanvasMaskRef: z.boolean(),
    })
    .strict(),
)

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  trustedRoot?: string,
): Promise<Buffer> {
  const expectedPath = resolve(path)
  const actualPath = await realpath(expectedPath)
  if (actualPath !== expectedPath)
    throw new RangeError('Symlinked or aliased input path is not permitted')
  if (trustedRoot && !isWithin(resolve(trustedRoot), actualPath))
    throw new RangeError('Input file escapes its trusted root')
  const beforePath = await lstat(expectedPath)
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > maxBytes)
    throw new RangeError('Input must be a bounded regular file')
  const handle = await open(expectedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new RangeError('Opened input is not a bounded regular file')
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const actualPathAfterRead = await realpath(expectedPath)
    const pathStatAfterRead = await lstat(expectedPath)
    if (
      bytes.byteLength !== Number(before.size) ||
      actualPathAfterRead !== expectedPath ||
      BigInt(beforePath.dev) !== before.dev ||
      BigInt(beforePath.ino) !== before.ino ||
      BigInt(pathStatAfterRead.dev) !== after.dev ||
      BigInt(pathStatAfterRead.ino) !== after.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new RangeError('Input changed while it was being verified')
    return bytes
  } finally {
    await handle.close()
  }
}

function resolveArtifact(root: string, path: string): string {
  const base = resolve(root)
  const full = resolve(base, path)
  if (!isWithin(base, full)) throw new RangeError('Artifact path escapes trustedRoot')
  return full
}

async function readPinnedJson<T>(
  root: string,
  ref: z.infer<typeof artifactRefSchema>,
  schema: z.ZodType<T>,
): Promise<{ value: T; raw: Buffer; path: string }> {
  const path = resolveArtifact(root, ref.path)
  const raw = await readBoundedRegularFile(path, JSON_FILE_LIMIT_BYTES, root)
  if (digestBytes(raw) !== ref.sha256)
    throw new RangeError(`Pinned artifact digest mismatch: ${ref.path}`)
  return { value: schema.parse(JSON.parse(raw.toString('utf8'))), raw, path }
}

async function readPinnedBytes(
  root: string,
  ref: z.infer<typeof artifactRefSchema>,
): Promise<Buffer> {
  const limit = ref.path.endsWith('.binary-lsb0') ? MASK_FILE_LIMIT_BYTES : JSON_FILE_LIMIT_BYTES
  const bytes = await readBoundedRegularFile(resolveArtifact(root, ref.path), limit, root)
  if (digestBytes(bytes) !== ref.sha256)
    throw new RangeError(`Pinned artifact digest mismatch: ${ref.path}`)
  return bytes
}

function verifyOrderProtocol(protocol: unknown): asserts protocol is {
  schema: 'h8a-fresh-paired-order-protocol-v1'
  seedHex: '76303308'
  hashAlgorithm: 'SHA-256'
  hashInput: string
} {
  const body = z
    .object({
      schema: z.literal('h8a-fresh-paired-order-protocol-v1'),
      seedHex: z.literal('76303308'),
      hashAlgorithm: z.literal('SHA-256'),
      hashInput: z.string().min(1),
      caseOrdering: z.object({
        primary: z.string(),
        tie: z.string(),
        include: z.string(),
      }),
      armFirst: z.object({
        firstBit: z.string(),
        forCase: z.string(),
        groupBy: z.literal('stratum only, no expected presence or outcome'),
      }),
    })
    .passthrough()
    .parse(protocol)
  if (
    body.caseOrdering.primary !== 'ascending hash(seedHex, case-order-v1, opaqueCaseId)' ||
    body.caseOrdering.tie !== 'ascending opaqueCaseId' ||
    body.caseOrdering.include !== 'all 40 producer rows; derive pairedSchedule in same order' ||
    body.armFirst.firstBit !==
      'integer value of final hex digit of hash(seedHex, first-arm-v1, stratum) modulo 2' ||
    body.armFirst.forCase !==
      'candidate first iff (zero-based rank within stratum + firstBit) modulo 2 equals zero'
  )
    throw new RangeError(
      'Registered paired-order protocol differs from the supported DEV40 protocol',
    )
}

function protocolHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')
}

function expectedMapOpaqueId(seedHex: string, familySlug: string, stateId: string): string {
  return protocolHash([seedHex, 'map-id-v1', familySlug, stateId]).slice(0, 32)
}

function scheduleCases(
  producerCases: PhaseFreeze['producerCases'],
  strataById: ReadonlyMap<string, (typeof STRATUMS)[number]>,
): PhaseFreeze['pairedSchedule'] {
  const order = [...producerCases].sort((left, right) => {
    const leftHash = protocolHash(['76303308', 'case-order-v1', left.opaqueCaseId])
    const rightHash = protocolHash(['76303308', 'case-order-v1', right.opaqueCaseId])
    return leftHash.localeCompare(rightHash) || left.opaqueCaseId.localeCompare(right.opaqueCaseId)
  })
  const rankByStratum = new Map<(typeof STRATUMS)[number], number>()
  const firstBitByStratum = new Map(
    STRATUMS.map((stratum) => [
      stratum,
      Number.parseInt(protocolHash(['76303308', 'first-arm-v1', stratum]).at(-1)!, 16) % 2,
    ]),
  )
  return order.map((row) => {
    const stratum = strataById.get(row.opaqueCaseId)
    if (!stratum) throw new RangeError('Scheduled producer row has no reviewed stratum')
    const rank = rankByStratum.get(stratum) ?? 0
    rankByStratum.set(stratum, rank + 1)
    return {
      opaqueCaseId: row.opaqueCaseId,
      stratum,
      candidateArmFirst: (rank + firstBitByStratum.get(stratum)!) % 2 === 0,
    }
  })
}

async function verifySourceClosure(
  sourceRoot: string,
  rawClosure: z.infer<typeof sourceClosureSchema>,
): Promise<string> {
  const root = resolve(sourceRoot)
  if ((await realpath(root)) !== root) throw new RangeError('Symlinked sourceRoot is not permitted')
  const seen = new Set<string>()
  for (const file of rawClosure.files) {
    const path = resolve(root, file.path)
    if (!isWithin(root, path) || path === root)
      throw new RangeError('Source closure path escapes sourceRoot')
    if (isAbsolute(file.path) || relative(root, path) !== file.path)
      throw new RangeError('Source closure path must be a normalized relative path')
    if (seen.has(file.path)) throw new RangeError('Duplicate source closure path')
    seen.add(file.path)
    const bytes = await readBoundedRegularFile(path, SOURCE_FILE_LIMIT_BYTES, root)
    if (bytes.length !== file.bytes || digestBytes(bytes) !== file.sha256)
      throw new RangeError(`Source closure file mismatch: ${file.path}`)
  }
  const closurePaths = new Set(rawClosure.files.map((file) => file.path))
  if (REQUIRED_PRODUCER_CLOSURE_PATHS.some((path) => !closurePaths.has(path)))
    throw new RangeError(
      'Producer source closure is missing a required native worker, entry, or policy file',
    )
  return hashIdentity(rawClosure)
}

function verifyRuntimeEnvironment(
  runtime: z.infer<typeof runtimeEnvironmentSchema>,
  closure: z.infer<typeof sourceClosureSchema>,
  variant: FreezeVariant = 'v1',
): void {
  if (new Set(runtime.assets.map((item) => item.relative)).size !== runtime.assets.length)
    throw new RangeError('Runtime input manifest contains duplicate model assets')
  const closureByPath = new Map(closure.files.map((file) => [file.path, file]))
  const nativeRecipePath =
    variant === 'flat-v2'
      ? 'benchmarks/v03/h8a-full/native-recipe-flat-target-v2.json'
      : 'benchmarks/v03/h8a-full/native-recipe.json'
  const nativeRecipe = closureByPath.get(nativeRecipePath)
  const packageLock = closureByPath.get('package-lock.json')
  if (!nativeRecipe || nativeRecipe.sha256 !== runtime.h8NativeRecipeFileSha256)
    throw new RangeError('Runtime H8 native recipe hash does not match the verified code closure')
  if (!packageLock || packageLock.sha256 !== runtime.node.packageLockSha256)
    throw new RangeError('Runtime package-lock hash does not match the verified code closure')
}

function assertOpenAiCatalogRates(
  raw: unknown,
  expectedModel: string,
  inputTokenBound: number,
  maxOutputTokens: number,
  inputRateUpperUsd: number,
  outputRateUpperUsd: number,
): void {
  const catalog = z
    .object({ data: z.object({ id: z.string(), endpoints: z.array(z.unknown()) }).passthrough() })
    .passthrough()
    .parse(raw)
  if (catalog.data.id !== expectedModel)
    throw new RangeError(`Raw price catalog model mismatch for ${expectedModel}`)
  const eligible = catalog.data.endpoints.flatMap((value) => {
    const endpoint = z.record(z.string(), z.unknown()).safeParse(value)
    if (!endpoint.success) return []
    const tag = z.string().safeParse(endpoint.data.tag)
    const model = z.string().safeParse(endpoint.data.model_id)
    if (
      !model.success ||
      model.data !== expectedModel ||
      !tag.success ||
      !(tag.data === 'openai' || tag.data.startsWith('openai/'))
    )
      return []
    const pricing = z.record(z.string(), z.unknown()).safeParse(endpoint.data.pricing)
    if (!pricing.success) throw new RangeError('OpenAI route is missing raw pricing')
    const contextLength = z.number().int().positive().safeParse(endpoint.data.context_length)
    if (!contextLength.success)
      throw new RangeError(`OpenAI route context is missing for ${expectedModel}`)
    const promptLimit = z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .safeParse(endpoint.data.max_prompt_tokens)
    const completionLimit = z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .safeParse(endpoint.data.max_completion_tokens)
    if (!promptLimit.success || !completionLimit.success)
      throw new RangeError(`OpenAI route token caps are malformed for ${expectedModel}`)
    const maxReachableInput = Math.min(promptLimit.data ?? contextLength.data, contextLength.data)
    const maxOutput = completionLimit.data ?? contextLength.data
    if (inputTokenBound < maxReachableInput || maxOutputTokens > maxOutput)
      throw new RangeError(
        `Frozen price envelope understates a raw OpenAI route token limit for ${expectedModel}`,
      )
    if (expectedModel === 'openai/gpt-6-luna' && maxOutputTokens !== 4096)
      throw new RangeError('Candidate output token bound differs from the frozen recipe cap')
    if (expectedModel === 'openai/gpt-6-luna-decisions' && maxOutputTokens !== 0)
      throw new RangeError('Control decision route must retain its zero generated-output budget')
    const base = pricing.data
    const rateAsNumber = (rate: unknown): number =>
      typeof rate === 'string' || typeof rate === 'number' ? Number(rate) : Number.NaN
    const numbers = [
      base.prompt,
      base.completion,
      base.input_cache_read,
      base.input_cache_write,
    ].map(rateAsNumber)
    if (numbers.some((rate) => !Number.isFinite(rate) || rate < 0))
      throw new RangeError('Raw OpenAI route has invalid token pricing')
    const overrides = Array.isArray(base.overrides) ? base.overrides : []
    for (const override of overrides) {
      const record = z.record(z.string(), z.unknown()).safeParse(override)
      if (!record.success) throw new RangeError('Raw OpenAI route override is malformed')
      const unsupportedOverrideCharge = Object.entries(record.data).some(([key, value]) => {
        if (
          [
            'min_prompt_tokens',
            'prompt',
            'completion',
            'input_cache_read',
            'input_cache_write',
            'discount',
            'web_search',
          ].includes(key)
        )
          return false
        const amount = rateAsNumber(value)
        return Number.isFinite(amount) && amount > 0
      })
      if (unsupportedOverrideCharge)
        throw new RangeError('OpenAI route override contains a positive unsupported fee')
      for (const [field, index] of [
        ['prompt', 0],
        ['completion', 1],
        ['input_cache_read', 2],
        ['input_cache_write', 3],
      ] as const) {
        if (record.data[field] !== undefined) {
          const rate = rateAsNumber(record.data[field])
          if (!Number.isFinite(rate) || rate < 0)
            throw new RangeError('Raw OpenAI route override has invalid pricing')
          numbers[index] = Math.max(numbers[index]!, rate)
        }
      }
    }
    const unsupportedPositiveCharge = Object.entries(base).some(([key, value]) => {
      // The frozen request policies provide no web-search tool, so this catalog-only optional feature is unreachable.
      if (
        [
          'prompt',
          'completion',
          'input_cache_read',
          'input_cache_write',
          'discount',
          'overrides',
          'web_search',
        ].includes(key)
      )
        return false
      const amount = rateAsNumber(value)
      return Number.isFinite(amount) && amount > 0
    })
    if (unsupportedPositiveCharge)
      throw new RangeError('Raw OpenAI route contains a positive unsupported fee')
    return [numbers]
  })
  if (eligible.length === 0)
    throw new RangeError(`Raw price catalog lacks a qualifying OpenAI route for ${expectedModel}`)
  if (
    eligible.some(
      ([prompt, completion, cacheRead, cacheWrite]) =>
        inputRateUpperUsd + 1e-15 < Math.max(prompt!, cacheRead!, cacheWrite!) ||
        outputRateUpperUsd + 1e-15 < completion!,
    )
  )
    throw new RangeError(
      `Pinned price rates do not bound every eligible OpenAI route for ${expectedModel}`,
    )
}

async function validatePriceProof(
  artifactRoot: string,
  rawProof: z.infer<typeof priceProofSchema>,
  priceProofSha256: string,
  flat = false,
): Promise<PhaseFreeze['conservativeCostProof']> {
  const candidateProfileId = flat ? PROFILE_FLAT_CANDIDATE_ID : PROFILE_CANDIDATE_ID
  const expected = [
    { profileId: candidateProfileId, model: 'openai/gpt-6-luna' },
    { profileId: PROFILE_CONTROL_ID, model: 'openai/gpt-6-luna-decisions' },
  ] as const
  const bounds: PhaseFreeze['conservativeCostProof']['profileDispatchUpperBounds'] = [
    {
      profileId: candidateProfileId,
      maxUsdPerPhysicalDispatch: rawProof.entries[0].maxUsdPerPhysicalDispatch,
    },
    {
      profileId: PROFILE_CONTROL_ID,
      maxUsdPerPhysicalDispatch: rawProof.entries[1].maxUsdPerPhysicalDispatch,
    },
  ]
  for (const [index, expectedRow] of expected.entries()) {
    const entry = rawProof.entries[index]!
    if (entry.profileId !== expectedRow.profileId || entry.model !== expectedRow.model)
      throw new RangeError('Price proof profile/model order mismatch')
    const rawCatalog: unknown = JSON.parse(
      (await readPinnedBytes(artifactRoot, entry.rawCatalog)).toString('utf8'),
    )
    assertOpenAiCatalogRates(
      rawCatalog,
      entry.model,
      entry.inputTokenBound,
      entry.maxOutputTokens,
      entry.inputRateUpperUsd,
      entry.outputRateUpperUsd,
    )
    const computed =
      entry.inputTokenBound * entry.inputRateUpperUsd +
      entry.maxOutputTokens * entry.outputRateUpperUsd
    if (computed > entry.computedWorstUsd + 1e-9)
      throw new RangeError(
        `Price proof undercounts the token-price worst case for ${entry.profileId}`,
      )
    if (entry.maxUsdPerPhysicalDispatch < entry.computedWorstUsd)
      throw new RangeError(
        `Price dispatch bound is below the computed worst case for ${entry.profileId}`,
      )
  }
  const maxUsdPerPhysicalDispatch = Math.max(
    ...bounds.map((item) => item.maxUsdPerPhysicalDispatch),
  )
  const proofBody: Omit<PhaseFreeze['conservativeCostProof'], 'proofSha256'> = {
    schema: 'h8a-fresh-conservative-cost-proof-v1',
    proofKind: 'audited-upper-bound',
    maxUsdPerPhysicalDispatch,
    profileDispatchUpperBounds: bounds,
    derivedFrom: `pinned-price-proof-sha256:${priceProofSha256}`,
  }
  return { ...proofBody, proofSha256: hashIdentity(proofBody) }
}

function validatePackedMask(
  bytes: Uint8Array,
  width: number,
  height: number,
  digest: string,
): void {
  const expectedLength = Math.ceil((width * height) / 8)
  if (bytes.length !== expectedLength || digestBytes(bytes) !== digest)
    throw new RangeError('Reference mask byte length or digest mismatch')
  const usedBits = (width * height) % 8
  if (usedBits !== 0 && (bytes.at(-1)! & (0xff << usedBits)) !== 0)
    throw new RangeError('Reference mask has nonzero packed padding bits')
}

interface DevFreezeAssemblyOptions {
  authorityPath: string
  authoritySha256: string
  sourceRoot: string
  outputDirectory: string
}

type FreezeVariant = 'v1' | 'flat-v2'

const getAuthorityVariant = (schema: unknown): FreezeVariant => {
  if (schema === 'h8a-dev-freeze-preparation-v1') return 'v1'
  if (schema === 'h8a-flat-dev-freeze-preparation-v1') return 'flat-v2'
  throw new RangeError('Unsupported DEV freeze preparation authority schema')
}

const sourceGroupSplitDigestSchema = z
  .object({
    schema: z.literal('h8a-dev-source-group-split-v1'),
    devSourceGroupIds: z.array(z.string().min(1)),
    qualificationSourceGroupIds: z.array(z.string().min(1)),
    exclusionSourceGroupIds: z.array(z.string().min(1)),
    devCommitmentSha256: sha256,
    qualificationCommitmentSha256: sha256,
    exclusionCommitmentSha256: sha256,
  })
  .strict()

async function loadFragment(
  artifactRoot: string,
  ref: { fragmentId: string; path: string; sha256: string },
): Promise<FragmentRows> {
  const raw = await readBoundedRegularFile(
    resolveArtifact(artifactRoot, ref.path),
    JSON_FILE_LIMIT_BYTES,
    artifactRoot,
  )
  if (digestBytes(raw) !== ref.sha256)
    throw new RangeError(`Fragment review manifest pin mismatch: ${ref.fragmentId}`)
  const review = reviewedFragmentSchema.parse(JSON.parse(raw.toString('utf8')))
  if (review.fragmentId !== ref.fragmentId) throw new RangeError('Fragment ID mismatch')
  const [producerRows, annotations, controllerPathIndex, provenance] = await Promise.all([
    readPinnedJson(artifactRoot, review.producerRows, producerRowsSchema),
    readPinnedJson(artifactRoot, review.annotations, privateAnnotationRowsSchema),
    readPinnedJson(artifactRoot, review.controllerPathIndex, z.record(z.string(), z.string())),
    readPinnedJson(artifactRoot, review.provenance, z.record(z.string(), z.unknown())),
  ])
  await readPinnedBytes(artifactRoot, review.fragmentReceipt)
  for (const mask of review.referenceMasks) await readPinnedBytes(artifactRoot, mask)
  for (const receipt of review.reviewReceipts) await readPinnedBytes(artifactRoot, receipt)
  const rawAnnotations: unknown = JSON.parse(annotations.raw.toString('utf8'))
  if (!Array.isArray(rawAnnotations))
    throw new RangeError('Raw annotation bundle must be an ordered row array')
  const annotationDigests = new Map<string, string>()
  const rawAnnotationRows = new Map<string, unknown>()
  for (const row of rawAnnotations) {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof Reflect.get(row, 'opaqueCaseId') !== 'string'
    )
      throw new RangeError('Raw annotation row has no opaqueCaseId')
    const id = z.string().parse(Reflect.get(row, 'opaqueCaseId'))
    if (annotationDigests.has(id)) throw new RangeError('Duplicate raw annotation row ID')
    annotationDigests.set(id, hashIdentity(row))
    rawAnnotationRows.set(id, row)
  }
  const rawProvenance = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(provenance.raw.toString('utf8')))
  const provenanceDigests = new Map(
    Object.entries(rawProvenance).map(([id, row]) => [id, hashIdentity(row)]),
  )
  const producerIds = producerRows.value.map((item) => item.opaqueCaseId)
  const annotationIds = annotations.value.map((item) => item.opaqueCaseId)
  const reviewIds = review.rows.map((item) => item.opaqueCaseId)
  for (const ids of [producerIds, annotationIds, reviewIds]) {
    if (new Set(ids).size !== ids.length)
      throw new RangeError('Duplicate ID inside a reviewed fragment')
  }
  if (
    producerIds.length !== annotationIds.length ||
    producerIds.length !== reviewIds.length ||
    producerIds.some((id, index) => id !== annotationIds[index] || id !== reviewIds[index])
  )
    throw new RangeError('Reviewed fragment producer, annotation, and review row order mismatch')
  const referencedMaskDigests = new Set(
    annotations.value.flatMap((row) => row.referenceMasks.map((mask) => mask.packedBinarySha256)),
  )
  const pinnedMaskDigests = review.referenceMasks.map((item) => item.sha256)
  if (
    new Set(pinnedMaskDigests).size !== pinnedMaskDigests.length ||
    pinnedMaskDigests.length !== referencedMaskDigests.size ||
    pinnedMaskDigests.some((digest) => !referencedMaskDigests.has(digest))
  )
    throw new RangeError('Fragment pinned mask files differ from annotation mask references')
  return {
    producerRows: producerRows.value,
    annotations: annotations.value,
    annotationDigests,
    rawAnnotationRows,
    controllerPathIndex: controllerPathIndex.value,
    provenance: provenance.value,
    provenanceDigests,
    review,
  }
}

async function verifyCaseInputs(
  artifactRoot: string,
  rows: readonly {
    fragment: FragmentRows
    reviewRow: z.infer<typeof reviewedFragmentSchema>['rows'][number]
  }[],
): Promise<{
  producerCases: PhaseFreeze['producerCases']
  sourceBytesByCaseId: Map<string, Buffer>
}> {
  const producerCases: PhaseFreeze['producerCases'] = []
  const sourceBytesByCaseId = new Map<string, Buffer>()
  const seen = new Set<string>()
  for (const { fragment, reviewRow } of rows) {
    const id = reviewRow.opaqueCaseId
    if (seen.has(id)) throw new RangeError('Duplicate accepted opaqueCaseId')
    seen.add(id)
    const producer = fragment.producerRows.find((item) => item.opaqueCaseId === id)
    const annotation = fragment.annotations.find((item) => item.opaqueCaseId === id)
    const provenance = fragment.provenance[id]
    const indexedPath = fragment.controllerPathIndex[id]
    if (
      reviewRow.fragmentId !== fragment.review.fragmentId ||
      !producer ||
      !annotation ||
      provenance === undefined ||
      !indexedPath
    )
      throw new RangeError(`Fragment payload is missing a row dependency for ${id}`)
    if (
      reviewRow.sourceSha256 !== producer.sourceBytesSha256 ||
      reviewRow.annotationSha256 !== fragment.annotationDigests.get(id) ||
      normalizeSourceGroup(reviewRow.sourceGroup) !==
        normalizeSourceGroup(annotation.sourceGroup) ||
      reviewRow.provenanceSha256 !== fragment.provenanceDigests.get(id)
    )
      throw new RangeError(`Pinned review admission differs from source row ${id}`)
    const receipt = fragment.review.reviewReceipts.find(
      (item) => item.sha256 === reviewRow.reviewReceiptSha256,
    )
    if (!receipt) throw new RangeError(`Row review receipt is not pinned for ${id}`)
    const sourcePath = resolve(indexedPath)
    if (!isWithin(resolve(artifactRoot), sourcePath))
      throw new RangeError('Controller path escapes trustedRoot')
    const sourceBytes = await readBoundedRegularFile(
      sourcePath,
      SOURCE_FILE_LIMIT_BYTES,
      artifactRoot,
    )
    if (digestBytes(sourceBytes) !== producer.sourceBytesSha256)
      throw new RangeError(`Source image bytes do not match producer digest for ${id}`)
    const image = await sharp(sourceBytes, {
      failOn: 'error',
      limitInputPixels: SOURCE_PIXEL_LIMIT,
    }).metadata()
    if (
      !image.width ||
      !image.height ||
      (image.orientation !== undefined && image.orientation !== 1)
    )
      throw new RangeError(`Source image canvas/orientation is not admissible for ${id}`)
    if (
      image.width * image.height > SOURCE_PIXEL_LIMIT ||
      producer.sourceCanvasWidth !== image.width ||
      producer.sourceCanvasHeight !== image.height
    )
      throw new RangeError(`Source image canvas mismatch for ${id}`)
    assertReferenceBoxesWithinCanvas(annotation, image.width, image.height)
    assertReferenceMaskDeclaration(annotation, image.width, image.height)
    for (const mask of annotation.referenceMasks) {
      const maskRef = fragment.review.referenceMasks.find(
        (item) => item.sha256 === mask.packedBinarySha256,
      )
      if (!maskRef) throw new RangeError(`Reference mask lacks a pinned path for ${id}`)
      const maskBytes = await readPinnedBytes(artifactRoot, maskRef)
      validatePackedMask(maskBytes, mask.width, mask.height, mask.packedBinarySha256)
      if (mask.width !== image.width || mask.height !== image.height)
        throw new RangeError(`Reference mask canvas mismatch for ${id}`)
    }
    producerCases.push(producer)
    sourceBytesByCaseId.set(id, sourceBytes)
  }
  if (sourceBytesByCaseId.size !== rows.length)
    throw new RangeError('Missing source bytes in complete cohort')
  return {
    producerCases,
    sourceBytesByCaseId,
  }
}

function expectedRecipeIdentity(
  profile:
    | typeof H8A_CANDIDATE_PROFILE
    | typeof H8A_FLAT_CANDIDATE_PROFILE
    | typeof V02_CONTROL_PROFILE,
): string {
  return hashIdentity({
    profileId: profile.profileId,
    recipeKind: profile.recipeKind,
    requestPolicyIdentitySha256: profile.requestPolicyIdentitySha256,
  })
}

export async function assembleDevFreezeFromDisk(options: DevFreezeAssemblyOptions): Promise<{
  freeze: PhaseFreeze
  annotations: EvaluatorPrivateAnnotationBundle
  selection: ReturnType<typeof buildDevScreenSelection>
  sourceBytesByCaseId: Map<string, Buffer>
  sourceClosurePaths: string[]
  runtimeEnvironmentSha256: string
}> {
  const authorityBytes = await readBoundedRegularFile(options.authorityPath, JSON_FILE_LIMIT_BYTES)
  if (digestBytes(authorityBytes) !== options.authoritySha256)
    throw new RangeError('Preparation authority SHA-256 does not match the caller-supplied pin')
  const authorityUnknown: unknown = JSON.parse(authorityBytes.toString('utf8'))
  const authorityRecord = z.record(z.string(), z.unknown()).parse(authorityUnknown)
  const variant = getAuthorityVariant(authorityRecord.schema)
  const flatAuthority =
    variant === 'flat-v2' ? flatPreparationAuthoritySchema.parse(authorityUnknown) : undefined
  const authority = flatAuthority ?? preparationAuthoritySchema.parse(authorityUnknown)
  const phaseId = variant === 'flat-v2' ? PHASE_FLAT_DEV40_ID : PHASE_DEV40_ID
  const candidateProfileId = candidateIdForPhase(phaseId)
  const candidateProfile =
    candidateProfileId === PROFILE_FLAT_CANDIDATE_ID
      ? H8A_FLAT_CANDIDATE_PROFILE
      : H8A_CANDIDATE_PROFILE
  if (!isAbsolute(authority.trustedRoot)) throw new RangeError('trustedRoot must be absolute')
  const artifactRoot = resolve(authority.trustedRoot)
  if ((await realpath(artifactRoot)) !== artifactRoot)
    throw new RangeError('trustedRoot must not be symlinked or aliased')
  if (
    new Set(authority.fragments.map((item) => item.fragmentId)).size !==
      authority.fragments.length ||
    new Set(authority.fragments.map((item) => item.path)).size !== authority.fragments.length
  )
    throw new RangeError('Preparation authority contains duplicate reviewed fragments')

  const [protocolRef, rosterRef, closureRef, splitRef, priceRef, runtimeRef] = await Promise.all([
    readPinnedJson(artifactRoot, authority.orderProtocol, z.unknown()),
    readPinnedJson(artifactRoot, authority.mapRoster, z.unknown()),
    readPinnedJson(artifactRoot, authority.sourceClosure, sourceClosureSchema),
    readPinnedJson(artifactRoot, authority.sourceGroupSplit, sourceGroupSplitDigestSchema),
    readPinnedJson(artifactRoot, authority.priceProof, priceProofSchema),
    readPinnedJson(artifactRoot, authority.runtimeEnvironment, runtimeEnvironmentSchema),
  ])
  if (variant === 'flat-v2') {
    if (
      !flatAuthority ||
      flatAuthority.priorDevAuthority.sha256 !== PINNED_PRIOR_DEV_AUTHORITY_SHA256
    )
      throw new RangeError('Flat comparison must name the exact original DEV authority')
    const priorRef = await readPinnedJson(
      artifactRoot,
      flatAuthority.priorDevAuthority,
      preparationAuthoritySchema,
    )
    if (
      priorRef.value.freezeId !== 'h8a-fresh-dev40-20261101-v1' ||
      priorRef.value.orderProtocol.sha256 !== authority.orderProtocol.sha256 ||
      priorRef.value.mapRoster.sha256 !== authority.mapRoster.sha256 ||
      priorRef.value.sourceGroupSplit.sha256 !== authority.sourceGroupSplit.sha256 ||
      hashIdentity(priorRef.value.fragments) !== hashIdentity(authority.fragments)
    )
      throw new RangeError('Flat DEV authority changed the original DEV40 cohort boundary')
  }
  verifyOrderProtocol(protocolRef.value)
  await verifySourceClosure(options.sourceRoot, closureRef.value)
  const closureSha256 = digestBytes(closureRef.raw)
  verifyRuntimeEnvironment(runtimeRef.value, closureRef.value, variant)
  const split = splitRef.value
  const groupCommitment = (ids: readonly string[]): string =>
    hashIdentity([...ids].map(normalizeSourceGroup).sort())
  if (
    groupCommitment(split.devSourceGroupIds) !== split.devCommitmentSha256 ||
    groupCommitment(split.qualificationSourceGroupIds) !== split.qualificationCommitmentSha256 ||
    groupCommitment(split.exclusionSourceGroupIds) !== split.exclusionCommitmentSha256
  )
    throw new RangeError('Source-group split/exclusion commitment mismatch')
  const [fragments, conservativeCostProof] = await Promise.all([
    Promise.all(authority.fragments.map((item) => loadFragment(artifactRoot, item))),
    validatePriceProof(
      artifactRoot,
      priceRef.value,
      digestBytes(priceRef.raw),
      variant === 'flat-v2',
    ),
  ])
  const reviewById = new Map(
    fragments.flatMap((fragment) =>
      fragment.review.rows.map((row) => [row.opaqueCaseId, { fragment, row }] as const),
    ),
  )
  if (reviewById.size !== fragments.reduce((count, item) => count + item.review.rows.length, 0))
    throw new RangeError('Duplicate row IDs across reviewed fragments')
  const orderRoster = z
    .object({
      schema: z.literal('h8a-fresh-supplemental-source-roster-v2'),
      seedHex: z.literal('76303308'),
      hashInput: z.string().min(1),
      parentProtocolSha256: sha256,
      sourceGroupByFamily: z.record(z.string().min(1)),
      rows: z.array(
        z
          .object({
            familySlug: z.string().min(1),
            predeclaredStateId: z.string().min(1),
            opaqueCaseId: z.string().min(1),
          })
          .strict(),
      ),
    })
    .passthrough()
    .parse(rosterRef.value)
  if (
    orderRoster.parentProtocolSha256 !== authority.orderProtocol.sha256 ||
    orderRoster.rows.length !== 10 ||
    new Set(orderRoster.rows.map((row) => row.opaqueCaseId)).size !== orderRoster.rows.length
  )
    throw new RangeError('Map roster must bind the registered protocol and contain ten unique IDs')
  if (
    orderRoster.hashInput !==
    'UTF-8 bytes, components separated by a single NUL byte, no trailing NUL; lower-case hexadecimal digest'
  )
    throw new RangeError('Map roster hash input contract is unsupported')
  const mapIds = new Set(
    orderRoster.rows.map((row) => {
      if (
        row.opaqueCaseId !==
        expectedMapOpaqueId(orderRoster.seedHex, row.familySlug, row.predeclaredStateId)
      )
        throw new RangeError(
          'Map roster contains an opaque ID that does not match its registered inputs',
        )
      return row.opaqueCaseId
    }),
  )
  for (const id of mapIds) {
    const reviewed = reviewById.get(id)
    if (!reviewed) continue
    const annotation = reviewed.fragment.annotations.find((item) => item.opaqueCaseId === id)
    if (annotation?.stratum !== 'map')
      throw new RangeError('Registered map slot has an accepted row with the wrong stratum')
    const rosterEntry = orderRoster.rows.find((item) => item.opaqueCaseId === id)!
    const groups = orderRoster.sourceGroupByFamily
    if (
      !groups ||
      typeof groups !== 'object' ||
      normalizeSourceGroup(String(Reflect.get(groups, rosterEntry.familySlug))) !==
        normalizeSourceGroup(reviewed.row.sourceGroup)
    )
      throw new RangeError('Reviewed map source group differs from registered family source group')
  }
  const mapReviewIds = [...reviewById.values()]
    .filter(
      (item) =>
        item.fragment.annotations.find((row) => row.opaqueCaseId === item.row.opaqueCaseId)
          ?.stratum === 'map',
    )
    .map((item) => item.row.opaqueCaseId)
  if (mapReviewIds.some((id) => !mapIds.has(id)))
    throw new RangeError('Accepted map rows contain an unregistered slot')
  const orderedIds = [...reviewById.keys()].sort((left, right) => {
    const leftHash = protocolHash(['76303308', 'case-order-v1', left])
    const rightHash = protocolHash(['76303308', 'case-order-v1', right])
    return leftHash.localeCompare(rightHash) || left.localeCompare(right)
  })
  const orderedRows = orderedIds.map((id) => {
    const item = reviewById.get(id)!
    return { fragment: item.fragment, reviewRow: item.row }
  })
  const { producerCases, sourceBytesByCaseId } = await verifyCaseInputs(artifactRoot, orderedRows)
  if (new Set(producerCases.map((row) => row.sourceBytesSha256)).size !== producerCases.length)
    throw new RangeError('Reviewed cases must have distinct encoded source bytes')
  if (mapReviewIds.length !== mapIds.size)
    throw new RangeError(
      `DEV40 incomplete: ${mapIds.size - mapReviewIds.length} registered map rows are missing (accepted ${mapReviewIds.length}/${mapIds.size})`,
    )
  if (orderedIds.length !== DEV40_CASE_COUNT)
    throw new RangeError(
      `DEV40 incomplete: ${DEV40_CASE_COUNT - orderedIds.length} reviewed cases are missing after source-byte verification`,
    )
  const strataById = new Map(
    orderedRows.map(({ fragment, reviewRow }) => [
      reviewRow.opaqueCaseId,
      fragment.annotations.find((item) => item.opaqueCaseId === reviewRow.opaqueCaseId)!.stratum,
    ]),
  )
  const pairedSchedule = scheduleCases(producerCases, strataById)
  const annotationBody = {
    schema: 'h8a-fresh-evaluator-private-v1',
    phaseId,
    freezeId: authority.freezeId,
    independentMaskCaseIds: [],
    cases: orderedRows.map(({ fragment, reviewRow }) =>
      fragment.rawAnnotationRows.get(reviewRow.opaqueCaseId),
    ),
  }
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(annotationBody)
  const evaluatorAnnotationsSha256 = computeEvaluatorAnnotationsSha256(annotations)
  const rawAnnotationDigest = hashIdentity({
    schema: annotationBody.schema,
    phaseId: annotationBody.phaseId,
    freezeId: annotationBody.freezeId,
    independentMaskCaseIds: annotationBody.independentMaskCaseIds,
    cases: annotationBody.cases,
    qualificationSourceGroupsDistinct: null,
  })
  if (evaluatorAnnotationsSha256 !== rawAnnotationDigest)
    throw new RangeError('Annotation schema parse changed the frozen JSON property order')
  const expectedDevGroups = [
    ...new Set(annotations.cases.map((item) => normalizeSourceGroup(item.sourceGroup))),
  ].sort()
  const splitDevGroups = [...split.devSourceGroupIds]
  if (
    new Set(splitDevGroups).size !== splitDevGroups.length ||
    splitDevGroups.some((group) => normalizeSourceGroup(group) !== group) ||
    hashIdentity(expectedDevGroups) !== split.devCommitmentSha256 ||
    expectedDevGroups.length !== splitDevGroups.length ||
    expectedDevGroups.some((group, index) => group !== splitDevGroups[index])
  )
    throw new RangeError(
      'Reviewed source groups do not match the externally pinned DEV source-group set',
    )
  for (const [ids, commitment] of [
    [split.qualificationSourceGroupIds, split.qualificationCommitmentSha256],
    [split.exclusionSourceGroupIds, split.exclusionCommitmentSha256],
  ] as const) {
    const canonical = ids.map(normalizeSourceGroup)
    if (
      new Set(canonical).size !== canonical.length ||
      canonical.some((item, index) => item !== ids[index]) ||
      hashIdentity([...canonical].sort()) !== commitment
    )
      throw new RangeError('Qualification/exclusion source-group commitment is malformed')
  }
  validateSourceGroupSplitSeparation({
    devSourceGroupIds: splitDevGroups,
    qualificationSourceGroupIds: split.qualificationSourceGroupIds,
    exclusionSourceGroupIds: split.exclusionSourceGroupIds,
  })
  const sourceStrataCommitments = STRATUMS.map((stratum) => {
    const sourceGroupIds = annotations.cases
      .filter((item) => item.stratum === stratum)
      .map((item) => item.sourceGroup)
    return {
      stratum,
      caseCount: sourceGroupIds.length,
      sourceGroupCommitmentSha256: computeSourceGroupStratumCommitmentSha256(
        phaseId,
        stratum,
        sourceGroupIds,
      ),
    }
  })
  const producerClosureSha256 = closureSha256
  const sourceBytesManifestSha256 = hashIdentity(
    producerCases.map((item) => item.sourceBytesSha256),
  )
  const cohortCommitmentSha256 = hashIdentity({
    phaseId,
    freezeId: authority.freezeId,
    orderProtocolSha256: authority.orderProtocol.sha256,
    mapRosterSha256: authority.mapRoster.sha256,
    sourceClosureSha256: closureSha256,
    sourceGroupSplitSha256: authority.sourceGroupSplit.sha256,
    runtimeEnvironmentSha256: digestBytes(runtimeRef.raw),
    producerCases,
    pairedSchedule,
    producerClosureSha256,
    sourceBytesManifestSha256,
    evaluatorAnnotationsSha256,
  })
  const freeze = phaseFreezeSchema.parse({
    schema: H8A_FRESH_SCHEMA,
    freezeId: authority.freezeId,
    phaseId,
    phaseCounts: {
      totalCases: DEV40_CASE_COUNT,
      positiveCases: DEV40_POSITIVE_COUNT,
      negativeCases: DEV40_NEGATIVE_COUNT,
    },
    cohortCommitmentSha256,
    producerClosureSha256,
    sourceBytesManifestSha256,
    sourceStrataCommitments,
    profileBindings: [
      {
        profileId: candidateProfileId,
        recipeIdentitySha256: expectedRecipeIdentity(candidateProfile),
        requestPolicyIdentitySha256: candidateProfile.requestPolicyIdentitySha256,
      },
      {
        profileId: PROFILE_CONTROL_ID,
        recipeIdentitySha256: expectedRecipeIdentity(V02_CONTROL_PROFILE),
        requestPolicyIdentitySha256: V02_CONTROL_PROFILE.requestPolicyIdentitySha256,
      },
    ],
    pairedSchedule,
    producerCases,
    qualificationIndependentMaskCaseIds: [],
    callLimits: {
      candidateMaxPhysicalCallsPerCase: 4,
      controlMaxPhysicalCallsPerCase: 6,
      phaseWorstCasePhysicalCalls: DEV40_WORST_CASE_PHYSICAL_CALLS,
    },
    nativeLimits: {
      avoidConcurrentOwnedNativeWork: true,
      maxPendingNativeJobs: 2,
      maxNativeWorkerThreads: 8,
    },
    deadlineIso: authority.deadlineIso,
    timeoutRetryPolicy: {
      absoluteCaseTimeoutSeconds: 240,
      allowFallbacks: false,
      allowRetries: false,
      sharedAbsoluteTimeoutMs: 240_000,
    },
    outputRowSchemaId: 'h8a-fresh-output-row-v1',
    evaluatorVersion: 'h8a-fresh-evaluator-v1',
    conservativeCostProof,
    enforceQualificationSourceGroupSeparation: false,
    evaluatorAnnotationsSha256,
  })
  validateProfileIdentities(freeze)
  validateConservativeCostProof(freeze)
  const candidateBound =
    conservativeCostProof.profileDispatchUpperBounds[0].maxUsdPerPhysicalDispatch
  const controlBound = conservativeCostProof.profileDispatchUpperBounds[1].maxUsdPerPhysicalDispatch
  if (4 * candidateBound + 6 * controlBound > CAMPAIGN_MAX_COST_USD + 1e-12)
    throw new RangeError('Frozen paired-case price exposure exceeds the campaign ceiling')
  const selection = buildDevScreenSelection(freeze, annotations)
  validateDevScreenSelection(selection, freeze, annotations)
  if (sourceBytesByCaseId.size !== freeze.producerCases.length)
    throw new RangeError('Complete source byte map required before freeze')
  return {
    freeze,
    annotations,
    selection,
    sourceBytesByCaseId,
    sourceClosurePaths: closureRef.value.files.map((file) => file.path),
    runtimeEnvironmentSha256: digestBytes(runtimeRef.raw),
  }
}

export async function writeDevFreezeExclusive(
  outputDirectory: string,
  result: Awaited<ReturnType<typeof assembleDevFreezeFromDisk>>,
): Promise<void> {
  const target = resolve(outputDirectory)
  const parent = dirname(target)
  const staging = `${target}.staging-${process.pid}-${Date.now()}`
  const lock = `${target}.lock`
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  let stagingCreated = false
  try {
    try {
      await lstat(target)
      throw new RangeError('DEV freeze output directory already exists and is immutable')
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')) throw error
    }
    await mkdir(staging, { mode: 0o700 })
    stagingCreated = true
    await Promise.all([
      writeFile(resolve(staging, 'phase-freeze.json'), `${JSON.stringify(result.freeze)}\n`, {
        flag: 'wx',
        mode: 0o600,
      }),
      writeFile(
        resolve(staging, 'evaluator-private-annotations.json'),
        `${JSON.stringify(result.annotations)}\n`,
        { flag: 'wx', mode: 0o600 },
      ),
      writeFile(
        resolve(staging, 'dev-screen-selection.json'),
        `${JSON.stringify(result.selection)}\n`,
        { flag: 'wx', mode: 0o600 },
      ),
    ])
    await rename(staging, target)
  } catch (error) {
    if (stagingCreated) await rm(staging, { recursive: true, force: true })
    throw error
  } finally {
    await rm(lock, { force: true })
  }
}

export async function verifyPersistedDevFreeze(
  inputDirectory: string,
  options: Omit<DevFreezeAssemblyOptions, 'outputDirectory'>,
): Promise<Awaited<ReturnType<typeof assembleDevFreezeFromDisk>>> {
  const expected = await assembleDevFreezeFromDisk({ ...options, outputDirectory: inputDirectory })
  const root = resolve(inputDirectory)
  if ((await realpath(root)) !== root)
    throw new RangeError('Persisted output directory is symlinked or aliased')
  const [freezeRaw, annotationsRaw, selectionRaw] = await Promise.all([
    readBoundedRegularFile(resolve(root, 'phase-freeze.json'), JSON_FILE_LIMIT_BYTES, root).then(
      (bytes) => bytes.toString('utf8'),
    ),
    readBoundedRegularFile(
      resolve(root, 'evaluator-private-annotations.json'),
      JSON_FILE_LIMIT_BYTES,
      root,
    ).then((bytes) => bytes.toString('utf8')),
    readBoundedRegularFile(
      resolve(root, 'dev-screen-selection.json'),
      JSON_FILE_LIMIT_BYTES,
      root,
    ).then((bytes) => bytes.toString('utf8')),
  ])
  const freeze = phaseFreezeSchema.parse(JSON.parse(freezeRaw))
  const annotations = evaluatorPrivateAnnotationBundleSchema.parse(JSON.parse(annotationsRaw))
  const selection = validateDevScreenSelection(JSON.parse(selectionRaw), freeze, annotations)
  if (hashIdentity(freeze) !== hashIdentity(expected.freeze))
    throw new RangeError('Persisted freeze differs from current pinned inputs')
  if (hashIdentity(annotations) !== hashIdentity(expected.annotations))
    throw new RangeError('Persisted annotations differ from current pinned inputs')
  if (hashIdentity(selection) !== hashIdentity(expected.selection))
    throw new RangeError('Persisted draw differs from deterministic nested draw')
  return expected
}
