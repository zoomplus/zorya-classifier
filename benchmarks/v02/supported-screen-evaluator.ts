import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { assertActive } from '../../src/entities/errors.js'
import { evaluateFreshRun } from './evaluate-fresh.js'
import { loadFreshCorpus, readBoundedCorpusFile } from './fresh-corpus.js'
import {
  normalizeVisionScreenRow,
  scoreVisionScreenMasks,
  visionScreenMaskTruthSchema,
  visionScreenResultRowSchema,
} from './evaluate-vision-screen.js'
import { hashCanonical } from './protocol.js'

export const supportedScreenRunId =
  'v02-vision-supported-route-screen-2026-10-20T140717451Z-90fa41cb'
export const supportedScreenManifestSha256 =
  'b97b44e9640ab37ae7269e24a91df4c84ba4b8e1c6f2ad0189440c0052ee0208'
export const supportedScreenControllerSha256 =
  '6442a38e24e51eefc12cf8e88bc21acf78f9723bb881c2c53bb8d1f735251c6b'
export const supportedScreenInputSha256 =
  '6c9ed29d8586c7887ae0861fc853baf203cb43790df4959390da4b5cc9ac679a'
export const supportedScreenTruthSha256 =
  '793e26845deaa2cb56748ef270b8cb02877218d680068573f02e5af92b26af6a'

export const supportedScreenProfiles = [
  {
    id: 'ordinary-qwen37-json-object-mobile-sam-screen-v1',
    model: 'qwen/qwen3.7-flash',
    provider: 'alibaba',
    providerName: 'Alibaba',
    responseFormat: 'json-object',
  },
  {
    id: 'ordinary-gpt6-sol-json-schema-mobile-sam-screen-v1',
    model: 'openai/gpt-6-sol',
    provider: 'openai',
    providerName: 'OpenAI',
    responseFormat: 'json-schema',
  },
] as const

export const supportedScreenProfileIds = supportedScreenProfiles.map((profile) => profile.id)
export const supportedScreenCaseIds = [
  ...Array.from(
    { length: 16 },
    (_, index) => `photo-dev-present-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from(
    { length: 4 },
    (_, index) => `photo-dev-absent-${String(index + 1).padStart(2, '0')}`,
  ),
] as const

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const caseSource = z
  .object({
    caseId: z.string().min(1),
    sourceSha256: digest,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    targetTaskSha256: digest,
    classifyTaskSha256: digest,
    validatedStages: z.array(z.enum(['classify', 'whole-object', 'extract'])),
  })
  .strict()
const profile = z
  .object({
    id: z.string(),
    model: z.string(),
    provider: z.string(),
    providerName: z.string(),
    responseFormat: z.enum(['json-object', 'json-schema']),
    reasoningEffort: z.literal('none'),
    apiEndpoint: z.literal('https://openrouter.ai/api/v1/chat/completions'),
    allowFallbacks: z.literal(false),
    maxOutputTokens: z.literal(1024),
    timeoutMs: z.literal(120000),
    maxExtentPasses: z.literal(3),
    boxTolerancePx: z.literal(8),
    retries: z.literal(0),
    concurrency: z.literal(1),
    maxQueue: z.literal(0),
    presentation: z.literal('original-image-numeric-v1'),
    route: z
      .object({
        model: z.string(),
        provider: z.string(),
        providerName: z.string(),
        apiEndpoint: z.literal('/api/v1/chat/completions'),
        allowFallbacks: z.literal(false),
      })
      .strict(),
  })
  .strict()
const sourceHashes = z.record(z.string(), digest)
const manifest = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.literal(supportedScreenRunId),
    profileId: z.literal('ordinary-supported-vision-mobile-sam-screen-pair-v1'),
    startedAt: z.string().datetime(),
    sourceHead: z.string().regex(/^[a-f0-9]{40}$/u),
    workingTreeClean: z.literal(true),
    workingTreeStatusSha256: digest,
    variantSha256: digest,
    sourceHashes,
    input: z
      .object({
        manifestSha256: z.literal(supportedScreenInputSha256),
        plannedCaseIds: z.array(z.string()).length(20),
        cases: z.array(caseSource).length(20),
      })
      .strict(),
    mobileSam: z
      .object({
        method: z.literal('mobile-sam-nine-point-proposals-v1'),
        executionProvider: z.literal('cpu'),
        encoderSha256: digest,
        decoderSha256: digest,
      })
      .strict(),
    profiles: z.array(profile).length(2),
    policy: z
      .object({
        screenMaxPhysicalCalls: z.literal(300),
        screenMaxCostUsd: z.literal(10),
        historicalExposure: z
          .object({
            priorScreenAdmissions: z.literal(37),
            priorScreenAccountedExposureUsd: z.literal(0.187881325),
            capabilityProbeAdmissions: z.literal(2),
            capabilityProbeKnownCostUsd: z.literal(0.00434684),
            supportedScreenV2Admissions: z.literal(120),
            supportedScreenV2AccountedExposureUsd: z.literal(1.293623795),
          })
          .strict(),
        independentLedger: z.literal(true),
        availablePhysicalCalls: z.literal(300),
        availableCostUsd: z.literal(10),
        budgetCapSelector: z.literal(
          'heldout maximum only; inputs remain DEV; actual cap is 300 calls/$10',
        ),
        unknownCostReserveUsd: z.literal(0.1),
        timeoutMs: z.literal(120000),
        maxExtentPasses: z.literal(3),
        boxTolerancePx: z.literal(8),
        retries: z.literal(0),
        fallback: z.literal(false),
        concurrency: z.literal(1),
        maxQueue: z.literal(0),
        latencyEnvironment: z.literal('unranked-concurrent-resource-soak'),
        latencyRankingEligible: z.literal(false),
      })
      .passthrough(),
  })
  .passthrough()

export type SupportedScreenManifest = z.infer<typeof manifest>

export function parseSupportedScreenManifest(value: unknown): SupportedScreenManifest {
  const parsed = manifest.parse(value)
  if (
    parsed.input.plannedCaseIds.join('\0') !== supportedScreenCaseIds.join('\0') ||
    parsed.input.cases.map((item) => item.caseId).join('\0') !== supportedScreenCaseIds.join('\0')
  )
    throw new Error('Supported SCREEN frozen case order differs')
  if (
    parsed.profiles.some((candidate, index) => {
      const expected = supportedScreenProfiles[index]!
      return (
        candidate.id !== expected.id ||
        candidate.model !== expected.model ||
        candidate.provider !== expected.provider ||
        candidate.providerName !== expected.providerName ||
        candidate.responseFormat !== expected.responseFormat ||
        candidate.route.model !== candidate.model ||
        candidate.route.provider !== candidate.provider ||
        candidate.route.providerName !== candidate.providerName
      )
    })
  )
    throw new Error('Supported SCREEN profile contract differs from its frozen routes')
  const byPath = new Map(Object.entries(parsed.sourceHashes))
  if (
    byPath.get('.run/v02/vision-screen-supported-routes-v1.ts') !== supportedScreenControllerSha256
  )
    throw new Error('Supported SCREEN controller source hash differs')
  return parsed
}

export function computeSupportedScreenVariant(manifestValue: unknown, profileId: string) {
  const parsedManifest = manifest.parse(manifestValue)
  const selected = parsedManifest.profiles.find((item) => item.id === profileId)
  if (!selected) throw new Error('Unsupported SCREEN profile')
  const rawManifest = z
    .object({
      profiles: z.array(z.record(z.string(), z.unknown())),
      policy: z.unknown(),
      sourceHashes: z.record(z.string(), digest),
      input: z.object({ cases: z.array(z.unknown()) }).passthrough(),
      mobileSam: z.object({ encoderSha256: digest, decoderSha256: digest }).passthrough(),
    })
    .passthrough()
    .parse(manifestValue)
  const rawSelected = rawManifest.profiles.find((item) => item.id === profileId)
  if (!rawSelected) throw new Error('Unsupported SCREEN raw profile')
  const {
    id,
    model,
    provider,
    providerName,
    responseFormat,
    reasoningEffort,
    route: _route,
    ...presentation
  } = rawSelected
  const routeIdentity = { id, model, provider, providerName, responseFormat, reasoningEffort }
  return hashCanonical({
    route: routeIdentity,
    presentation,
    policy: rawManifest.policy,
    manifestHash: supportedScreenInputSha256,
    sourceHashes: rawManifest.sourceHashes,
    assetHashes: [rawManifest.mobileSam.encoderSha256, rawManifest.mobileSam.decoderSha256],
    cases: rawManifest.input.cases,
  })
}

export interface SupportedPairSeal {
  runId: string
  completedAt: string
  aggregate: unknown
  profileIds: string[]
  sourceHeadBefore: string
  sourceHeadAfter: string
  workingTreeCleanBefore: boolean
  workingTreeCleanAfter: boolean
  workingTreeStatusSha256Before: string
  workingTreeStatusSha256After: string
  sourceHashesUnchanged: boolean
}

export function assertSupportedPairSeal(value: unknown): SupportedPairSeal {
  const parsed = z
    .object({
      runId: z.literal(supportedScreenRunId),
      completedAt: z.string().datetime(),
      aggregate: z.record(z.string(), z.unknown()),
      profileIds: z.array(z.string()).length(2),
      sourceHeadBefore: z.string().regex(/^[a-f0-9]{40}$/u),
      sourceHeadAfter: z.string().regex(/^[a-f0-9]{40}$/u),
      workingTreeCleanBefore: z.literal(true),
      workingTreeCleanAfter: z.literal(true),
      workingTreeStatusSha256Before: digest,
      workingTreeStatusSha256After: digest,
      sourceHashesUnchanged: z.literal(true),
    })
    .strict()
    .parse(value)
  if (
    new Set(parsed.profileIds).size !== 2 ||
    parsed.profileIds.some((id, index) => id !== supportedScreenProfileIds[index]) ||
    parsed.workingTreeStatusSha256Before !== parsed.workingTreeStatusSha256After
  )
    throw new Error('Supported SCREEN pair seal is incomplete or inconsistent')
  return parsed
}

export function receiptEffectiveCost(receipt: {
  receipt: { costUsd: number | null } | null
  wireReceipt: Record<string, unknown> | null
}): number | null {
  const parsedCost = receipt.receipt?.costUsd ?? null
  const wireValue = receipt.wireReceipt?.usageCostUsd
  if (wireValue !== undefined && wireValue !== null && typeof wireValue !== 'number')
    throw new Error('Wire usage cost is not numeric')
  const wireCost =
    typeof wireValue === 'number' && Number.isFinite(wireValue) && wireValue >= 0 ? wireValue : null
  if (parsedCost !== null && wireCost !== null && Math.abs(parsedCost - wireCost) > 1e-9)
    throw new Error('Parsed provider receipt conflicts with wire usage cost')
  return parsedCost ?? wireCost
}

export const supportedReceiptSchema = z
  .object({
    physicalId: z.number().int().positive(),
    logicalId: z.number().int().positive(),
    requestSha256: digest,
    requestBodySha256: digest,
    admittedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    route: z
      .object({
        model: z.string().min(1),
        provider: z.string().min(1),
        providerName: z.string().min(1),
        apiEndpoint: z.literal('/api/v1/chat/completions'),
        allowFallbacks: z.literal(false),
      })
      .strict(),
    receipt: z
      .object({
        model: z.string().nullable(),
        provider: z.string().nullable(),
        requestId: z.string().nullable(),
        costUsd: z.number().finite().nonnegative().nullable(),
        durationMs: z.number().finite().nonnegative(),
        attempts: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    wireReceipt: z.record(z.string(), z.unknown()).nullable(),
    errorCode: z.string().max(100).nullable(),
  })
  .strict()

export function reconcileSupportedReceipts(
  values: unknown,
  expected: { physicalCalls: number; knownCostUsd: number; unknownCostCalls: number },
): z.infer<typeof supportedReceiptSchema>[] {
  const receipts = z.array(supportedReceiptSchema).max(300).parse(values)
  const physicalIds = new Set<number>()
  let knownCostUsd = 0
  let unknownCostCalls = 0
  for (const receipt of receipts) {
    if (physicalIds.has(receipt.physicalId)) throw new Error('Duplicate physical receipt ID')
    physicalIds.add(receipt.physicalId)
    const cost = receiptEffectiveCost(receipt)
    if (receipt.receipt && receipt.receipt.attempts !== 1)
      throw new Error('Supported SCREEN receipt violates the frozen no-retry policy')
    if (cost === null) unknownCostCalls++
    else knownCostUsd += cost
  }
  if (
    receipts.length !== expected.physicalCalls ||
    unknownCostCalls !== expected.unknownCostCalls ||
    Math.abs(knownCostUsd - expected.knownCostUsd) > 1e-9
  )
    throw new Error('Supported SCREEN receipts do not reconcile with the provider budget ledger')
  return receipts
}

export function assertSupportedBudgetPolicy(value: unknown): void {
  const budget = z
    .object({
      admittedPhysicalCalls: z.number().int().nonnegative(),
      knownCostUsd: z.number().finite().nonnegative(),
      unknownCostCalls: z.number().int().nonnegative(),
      inFlightCalls: z.number().int().nonnegative(),
      accountedExposureUsd: z.number().finite().nonnegative(),
      maxPhysicalCalls: z.literal(300),
      maxCostUsd: z.literal(10),
    })
    .strict()
    .parse(value)
  if (
    budget.admittedPhysicalCalls > 300 ||
    budget.inFlightCalls !== 0 ||
    budget.accountedExposureUsd > 10 + 1e-9 ||
    budget.unknownCostCalls * 0.1 + budget.knownCostUsd > 10 + 1e-9
  )
    throw new Error('Supported SCREEN budget exceeds its frozen cap or leaves calls unsettled')
}

const budget = z
  .object({
    admittedPhysicalCalls: z.number().int().nonnegative(),
    knownCostUsd: z.number().finite().nonnegative(),
    unknownCostCalls: z.number().int().nonnegative(),
    inFlightCalls: z.number().int().nonnegative(),
    accountedExposureUsd: z.number().finite().nonnegative(),
    maxPhysicalCalls: z.literal(300),
    maxCostUsd: z.literal(10),
  })
  .strict()

export function assertSupportedCumulativeLedger(
  value: unknown,
  receipts: readonly z.infer<typeof supportedReceiptSchema>[],
): void {
  const snapshot = budget.parse(value)
  const knownCostUsd = receipts.reduce(
    (sum, receipt) => sum + (receiptEffectiveCost(receipt) ?? 0),
    0,
  )
  const unknownCostCalls = receipts.filter(
    (receipt) => receiptEffectiveCost(receipt) === null,
  ).length
  if (
    snapshot.admittedPhysicalCalls !== receipts.length ||
    snapshot.unknownCostCalls !== unknownCostCalls ||
    Math.abs(snapshot.knownCostUsd - knownCostUsd) > 1e-9 ||
    Math.abs(snapshot.accountedExposureUsd - knownCostUsd - unknownCostCalls * 0.1) > 1e-9
  )
    throw new Error('Supported SCREEN cumulative route budget differs from completed receipts')
}
const summaryRow = visionScreenResultRowSchema
const summary = z
  .object({
    runId: z.literal(supportedScreenRunId),
    profileId: z.enum(supportedScreenProfileIds as unknown as [string, ...string[]]),
    variantSha256: digest,
    status: z.enum(['complete', 'incomplete']),
    plannedCaseIds: z.array(z.string()).length(20),
    completedCaseIds: z.array(z.string()).max(20),
    missingCaseIds: z.array(z.string()).max(20),
    results: z.array(summaryRow).max(20),
    aggregate: budget,
    screenAggregate: budget,
    latencyEnvironment: z.literal('unranked-concurrent-resource-soak'),
    latencyRankingEligible: z.literal(false),
    shutdownError: z.string().max(100).nullable(),
    physicalReceipts: z.array(supportedReceiptSchema).max(300),
  })
  .strict()

const routeCompletion = z
  .object({
    profileId: z.enum(supportedScreenProfileIds as unknown as [string, ...string[]]),
    completedAt: z.string().datetime(),
    summarySha256: digest,
  })
  .strict()

export interface SupportedScreenEvaluationOptions {
  runDirectory: string
  sourceRoot: string
  imageRoot: string
  inputManifestPath: string
  truthPath: string
  outputDirectory: string
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readPinned(path: string, expected: string, signal: AbortSignal) {
  const bytes = await readBoundedCorpusFile(path, 16 * 1024 * 1024, signal)
  const actual = sha256(bytes)
  if (actual !== expected) {
    bytes.fill(0)
    throw new Error(`Pinned supported SCREEN input hash mismatch: ${path}`)
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, sha256: actual }
  } finally {
    bytes.fill(0)
  }
}

function sameIds(expected: readonly string[], actual: readonly string[], label: string): void {
  if (
    expected.length !== actual.length ||
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((id) => !actual.includes(id))
  )
    throw new Error(`Supported SCREEN ${label} set differs from the frozen inputs`)
}

async function verifySourceHashes(sourceRoot: string, hashes: Record<string, string>) {
  for (const [name, expected] of Object.entries(hashes)) {
    const bytes = await readFile(resolve(sourceRoot, name))
    if (sha256(bytes) !== expected) throw new Error(`Supported SCREEN source changed: ${name}`)
  }
}

async function writeExclusive(path: string, value: unknown): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  await writeFile(path, bytes, { flag: 'wx' })
  return sha256(bytes)
}

/** Evaluate only a closed, fully sealed pair. It does not dispatch or alter producer outputs. */
export async function evaluateSupportedVisionScreen(
  options: SupportedScreenEvaluationOptions,
  signal: AbortSignal,
) {
  assertActive(signal)
  const runDirectory = resolve(options.runDirectory)
  const manifestBytes = await readBoundedCorpusFile(
    resolve(runDirectory, 'run-manifest.json'),
    8 * 1024 * 1024,
    signal,
  )
  const rawManifestSha = sha256(manifestBytes)
  let manifestValue: unknown
  try {
    if (rawManifestSha !== supportedScreenManifestSha256)
      throw new Error('Supported SCREEN run-manifest bytes differ from their frozen pin')
    manifestValue = JSON.parse(manifestBytes.toString('utf8')) as unknown
  } finally {
    manifestBytes.fill(0)
  }
  const frozen = parseSupportedScreenManifest(manifestValue)
  const manifestSource = z
    .object({
      profiles: z.array(z.unknown()),
      policy: z.unknown(),
      input: z.object({ cases: z.array(z.unknown()) }).passthrough(),
      mobileSam: z.object({ encoderSha256: digest, decoderSha256: digest }).passthrough(),
      offlineSmoke: z.unknown(),
    })
    .passthrough()
    .parse(manifestValue)
  const globalVariant = hashCanonical({
    profiles: manifestSource.profiles,
    policy: manifestSource.policy,
    manifestHash: supportedScreenInputSha256,
    sourceHashes: frozen.sourceHashes,
    assetHashes: [manifestSource.mobileSam.encoderSha256, manifestSource.mobileSam.decoderSha256],
    cases: manifestSource.input.cases,
    offlineSmokeResult: manifestSource.offlineSmoke,
  })
  if (globalVariant !== frozen.variantSha256)
    throw new Error('Supported SCREEN global manifest variant digest is inconsistent')
  await verifySourceHashes(options.sourceRoot, frozen.sourceHashes)

  const inputFile = await readPinned(options.inputManifestPath, supportedScreenInputSha256, signal)
  const corpus = await loadFreshCorpus(
    {
      manifests: [{ path: options.inputManifestPath, sha256: supportedScreenInputSha256 }],
      imageRoot: options.imageRoot,
    },
    signal,
  )
  sameIds(
    supportedScreenCaseIds,
    corpus.cases.map((item) => item.caseId),
    'producer case',
  )
  const inputValue = z.array(z.unknown()).parse(inputFile.value)
  if (inputValue.length !== corpus.cases.length)
    throw new Error('Supported SCREEN input array changed')
  sameIds(supportedScreenCaseIds, frozen.input.plannedCaseIds, 'manifest case')
  sameIds(
    supportedScreenCaseIds,
    frozen.input.cases.map((item) => item.caseId),
    'source case',
  )
  for (const item of corpus.cases) {
    const manifestCase = frozen.input.cases.find((candidate) => candidate.caseId === item.caseId)!
    if (
      item.image.sha256 !== manifestCase.sourceSha256 ||
      item.image.width !== manifestCase.width ||
      item.image.height !== manifestCase.height
    )
      throw new Error('Supported SCREEN input metadata differs from the frozen run manifest')
  }
  const pairBytes = await readBoundedCorpusFile(
    resolve(runDirectory, 'run-complete.json'),
    1024 * 1024,
    signal,
  )
  let pairRaw: unknown
  const pairSha256 = sha256(pairBytes)
  try {
    pairRaw = JSON.parse(pairBytes.toString('utf8')) as unknown
  } finally {
    pairBytes.fill(0)
  }
  const pair = assertSupportedPairSeal(pairRaw)
  assertSupportedBudgetPolicy(pair.aggregate)
  if (
    pair.sourceHeadBefore !== frozen.sourceHead ||
    pair.workingTreeStatusSha256Before !== frozen.workingTreeStatusSha256
  )
    throw new Error('Supported SCREEN source boundary differs from its frozen manifest')
  const routeResults = []
  const allReceipts: z.infer<typeof supportedReceiptSchema>[] = []
  for (const profileId of supportedScreenProfileIds) {
    assertActive(signal)
    const routeDirectory = resolve(runDirectory, profileId)
    const completionBytes = await readBoundedCorpusFile(
      resolve(routeDirectory, 'run-complete.json'),
      1024 * 1024,
      signal,
    )
    const completionSha256 = sha256(completionBytes)
    let completionValue: unknown
    try {
      completionValue = JSON.parse(completionBytes.toString('utf8')) as unknown
    } finally {
      completionBytes.fill(0)
    }
    const completion = routeCompletion.parse(completionValue)
    if (completion.profileId !== profileId)
      throw new Error('Supported SCREEN route marker profile mismatch')
    const summaryBytes = await readBoundedCorpusFile(
      resolve(routeDirectory, 'summary.json'),
      16 * 1024 * 1024,
      signal,
    )
    let summaryValue: unknown
    const summaryFileSha = sha256(summaryBytes)
    try {
      summaryValue = JSON.parse(summaryBytes.toString('utf8')) as unknown
    } finally {
      summaryBytes.fill(0)
    }
    if (hashCanonical(summaryValue) !== completion.summarySha256)
      throw new Error('Supported SCREEN route summary differs from its completion marker')
    const result = summary.parse(summaryValue)
    if (
      result.profileId !== profileId ||
      result.variantSha256 !== computeSupportedScreenVariant(manifestValue, profileId) ||
      result.status !== 'complete' ||
      result.shutdownError !== null ||
      result.latencyRankingEligible !== false
    )
      throw new Error('Supported SCREEN route summary is incomplete or differs from frozen profile')
    sameIds(supportedScreenCaseIds, result.plannedCaseIds, 'planned case')
    sameIds(supportedScreenCaseIds, result.completedCaseIds, 'completed case')
    if (result.missingCaseIds.length) throw new Error('Supported SCREEN route has missing cases')
    sameIds(
      supportedScreenCaseIds,
      result.results.map((row) => row.caseId),
      'result case',
    )
    for (const row of result.results) {
      const source = corpus.cases.find((item) => item.caseId === row.caseId)!
      if (
        row.imageSha256 !== source.image.sha256 ||
        (row.locate.region &&
          (row.locate.region.left + row.locate.region.width > source.image.width ||
            row.locate.region.top + row.locate.region.height > source.image.height))
      )
        throw new Error(
          'Supported SCREEN row image or predicted region differs from source geometry',
        )
      const durableBytes = await readBoundedCorpusFile(
        resolve(routeDirectory, row.caseId, 'result.json'),
        1024 * 1024,
        signal,
      )
      try {
        const durable = visionScreenResultRowSchema.parse(
          JSON.parse(durableBytes.toString('utf8')) as unknown,
        )
        if (JSON.stringify(durable) !== JSON.stringify(row))
          throw new Error('Supported SCREEN durable row differs from route summary')
      } finally {
        durableBytes.fill(0)
      }
    }
    const stageCalls = result.results.reduce(
      (sum, row) => sum + row.classify.physicalCalls + row.locate.physicalCalls,
      0,
    )
    if (stageCalls !== result.physicalReceipts.length)
      throw new Error('Supported SCREEN stage call counts differ from receipt ledger')
    const stageLogicalHashes = result.results.flatMap((row) => [
      ...row.classify.requestHashes,
      ...row.locate.requestHashes,
    ])
    const receiptLogicalHashes = result.physicalReceipts.map((receipt) => receipt.requestSha256)
    if (
      stageLogicalHashes.length !==
        result.results.reduce(
          (sum, row) => sum + row.classify.logicalCalls + row.locate.logicalCalls,
          0,
        ) ||
      [...stageLogicalHashes].sort().join('\0') !== [...receiptLogicalHashes].sort().join('\0')
    )
      throw new Error('Supported SCREEN stage request hashes differ from physical receipts')
    const routeKnownCostUsd = result.physicalReceipts.reduce(
      (sum, receipt) => sum + (receiptEffectiveCost(receipt) ?? 0),
      0,
    )
    const routeUnknownCostCalls = result.physicalReceipts.filter(
      (receipt) => receiptEffectiveCost(receipt) === null,
    ).length
    const reconciled = reconcileSupportedReceipts(result.physicalReceipts, {
      physicalCalls: stageCalls,
      knownCostUsd: routeKnownCostUsd,
      unknownCostCalls: routeUnknownCostCalls,
    })
    for (const receipt of reconciled) {
      const frozenProfile = frozen.profiles.find((profile) => profile.id === profileId)!
      if (
        receipt.route.model !== frozenProfile.model ||
        receipt.route.provider !== frozenProfile.provider ||
        receipt.route.providerName !== frozenProfile.providerName
      )
        throw new Error('Supported SCREEN receipt route differs from frozen profile')
      allReceipts.push(receipt)
    }
    assertSupportedBudgetPolicy(result.aggregate)
    if (JSON.stringify(result.aggregate) !== JSON.stringify(result.screenAggregate))
      throw new Error('Supported SCREEN route snapshots disagree about the shared budget')
    assertSupportedCumulativeLedger(result.aggregate, allReceipts)
    routeResults.push({
      profileId,
      summary: result,
      summaryFileSha,
      completion,
      completionSha256,
      routeDirectory,
    })
  }
  if (routeResults.length !== supportedScreenProfileIds.length)
    throw new Error('Supported SCREEN pair is incomplete')
  const aggregate = budget.parse(pair.aggregate)
  const finalRouteAggregate = routeResults.at(-1)!.summary.screenAggregate
  if (JSON.stringify(aggregate) !== JSON.stringify(finalRouteAggregate))
    throw new Error('Supported SCREEN pair ledger differs from final route ledger')
  assertSupportedCumulativeLedger(aggregate, allReceipts)
  const totalKnown = allReceipts.reduce(
    (sum, receipt) => sum + (receiptEffectiveCost(receipt) ?? 0),
    0,
  )
  const unknownCount = allReceipts.filter(
    (receipt) => receiptEffectiveCost(receipt) === null,
  ).length
  const physicalIds = allReceipts.map((receipt) => receipt.physicalId).sort((a, b) => a - b)
  if (physicalIds.some((id, index) => id !== index + 1))
    throw new Error('Supported SCREEN pair total ledger differs from current-run receipts')

  const truthFile = await readPinned(options.truthPath, supportedScreenTruthSha256, signal)
  const truthRows = visionScreenMaskTruthSchema.parse(truthFile.value)
  sameIds(
    supportedScreenCaseIds,
    truthRows.map((item) => item.caseId),
    'truth case',
  )
  const outputDirectory = resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: false })
  const evaluations = []
  const truthArray = z.array(z.unknown()).parse(truthFile.value)
  for (const route of routeResults) {
    const routeOutput = resolve(outputDirectory, route.profileId)
    await mkdir(routeOutput, { recursive: false })
    const normalizedSummary = {
      runId: supportedScreenRunId,
      status: 'complete' as const,
      completedCaseIds: supportedScreenCaseIds,
      missingCaseIds: [],
      results: route.summary.results.map((row) => normalizeVisionScreenRow(row, route.profileId)),
    }
    const normalizedManifest = {
      runId: supportedScreenRunId,
      profileId: route.profileId,
      plannedCaseIds: supportedScreenCaseIds,
    }
    const normalizedSummaryPath = resolve(routeOutput, 'summary.json')
    const normalizedManifestPath = resolve(routeOutput, 'run-manifest.json')
    const normalizedTruthPath = resolve(routeOutput, 'truth.json')
    const normalizedSummarySha = await writeExclusive(normalizedSummaryPath, normalizedSummary)
    const normalizedManifestSha = await writeExclusive(normalizedManifestPath, normalizedManifest)
    const filteredTruth = truthArray.filter((item) => {
      if (!item || typeof item !== 'object' || !('caseId' in item)) return false
      return (
        typeof item.caseId === 'string' && supportedScreenCaseIds.includes(item.caseId as never)
      )
    })
    const normalizedTruthSha = await writeExclusive(normalizedTruthPath, filteredTruth)
    const wholeObject = await evaluateFreshRun(
      {
        summary: { path: normalizedSummaryPath, sha256: normalizedSummarySha },
        runManifest: { path: normalizedManifestPath, sha256: normalizedManifestSha },
        corpus: {
          manifests: [{ path: options.inputManifestPath, sha256: supportedScreenInputSha256 }],
          imageRoot: options.imageRoot,
        },
        truths: [{ path: normalizedTruthPath, sha256: normalizedTruthSha }],
        output: resolve(routeOutput, 'whole-object-evaluation.json'),
      },
      signal,
    )
    const masks = await scoreVisionScreenMasks(
      route.summary.results,
      corpus.cases,
      truthRows,
      route.routeDirectory,
      options.imageRoot,
      signal,
    )
    const evaluation = {
      profileId: route.profileId,
      rawRunManifestSha256: rawManifestSha,
      rawRunCompleteSha256: pairSha256,
      rawSummarySha256: route.summaryFileSha,
      routeCompleteSha256: route.completionSha256,
      wholeObject,
      masks,
      latencyRankingEligible: false,
      sourceHeadBefore: pair.sourceHeadBefore,
      sourceHeadAfter: pair.sourceHeadAfter,
      sourceHashesUnchanged: pair.sourceHashesUnchanged,
      profileBudget: route.summary.aggregate,
      pairBudget: aggregate,
    }
    await writeExclusive(resolve(routeOutput, 'evaluation.json'), evaluation)
    evaluations.push(evaluation)
  }
  const final = {
    schema: 'ordinary-supported-vision-screen-independent-evaluation-v1',
    runId: supportedScreenRunId,
    rawRunManifestSha256: rawManifestSha,
    rawRunCompleteSha256: pairSha256,
    inputManifestSha256: supportedScreenInputSha256,
    truthSha256: supportedScreenTruthSha256,
    paired: true,
    latencyRankingEligible: false,
    latencyEnvironment: frozen.policy.latencyEnvironment,
    sourceHeadBefore: pair.sourceHeadBefore,
    sourceHeadAfter: pair.sourceHeadAfter,
    sourceHashesUnchanged: pair.sourceHashesUnchanged,
    historicalExposure: frozen.policy.historicalExposure,
    budgetCap: {
      physicalCalls: frozen.policy.screenMaxPhysicalCalls,
      costUsd: frozen.policy.screenMaxCostUsd,
    },
    totalReceipts: allReceipts.length,
    totalKnownCallCostUsd: totalKnown,
    totalUnknownCostCalls: unknownCount,
    pairBudget: aggregate,
    profiles: evaluations,
  }
  await writeExclusive(resolve(outputDirectory, 'evaluation.json'), final)
  return final
}
