import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Node as TsNode } from 'typescript'
import sharp from 'sharp'
import { z } from 'zod'
import type { RasterImage, RasterPort } from '../../src/entities/contracts.js'
import { createSharpRaster } from '../../src/infrastructure/raster.js'
import { readOpenRouterKeyFromEnvFile, readOpenRouterKeyFromProcessEnv } from '../credentials.js'
import { RunBudget, RunBudgetExhausted } from '../v02/budget.js'
import { hashCanonical } from '../v02/protocol.js'
import {
  JEV_NATIVE_BOX_API_PATH,
  JEV_NATIVE_BOX_CASE_DEADLINE_MS,
  JEV_NATIVE_BOX_FREEZE_SCHEMA,
  JEV_NATIVE_BOX_ENDPOINT,
  JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION,
  JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION,
  JEV_NATIVE_BOX_MANIFEST_LOCKS,
  JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS,
  JEV_NATIVE_BOX_MAX_COST_USD,
  JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
  JEV_NATIVE_BOX_MAX_REQUEST_BYTES,
  JEV_NATIVE_BOX_MAX_RESPONSE_BYTES,
  JEV_NATIVE_BOX_MAX_SOURCE_ENCODED_BYTES,
  JEV_NATIVE_BOX_PREPARED_MAX_SIDE,
  JEV_NATIVE_BOX_PREPARED_MIN_SIDE,
  JEV_NATIVE_BOX_PROFILE_ID,
  JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256,
  JEV_NATIVE_BOX_RUN_SCHEMA,
  JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD,
  assertProducerInputOrder,
  buildJevNativeBoxWireBody,
  computeJevNativeBoxFreezeSha256,
  extractPreparedImagePart,
  jevNativeBoxFreezeSchema,
  jevNativeBoxProducerRowSchema,
  parseJevNativeBoxResponse,
  parseJevNativeBoxResponseEnvelope,
  parseSourceImageTransformFromImageState,
  sha256Bytes,
  validateCapabilityArtifacts,
  type JevNativeBoxFreeze,
  type JevNativeBoxProducerRow,
  validateJevNativeBoxResponseMetadata,
} from './jev-native-box.js'

const JEV_NATIVE_BOX_H8A_RUN_SHA256 =
  '1def8b64894f520e6e3ddd9c432212e1333684ae5db1e7c5747485c185cbb98a' as const
const JEV_NATIVE_BOX_H8A_EVALUATION_SHA256 =
  '1a6850b69d4f5ce52d0531594ede845ba0aeb3698b844f5946c33da46c3fbab2' as const

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRootFromModule = resolve(moduleDirectory, '../..')

const FIXED_SOURCE_PATHS = [
  'package.json',
  'package-lock.json',
  'docs/research/v03-jev-native-box-comparison-plan.ru.md',
  ...JEV_NATIVE_BOX_MANIFEST_LOCKS.map((lock) => lock.path),
] as const

function localSpecifierCandidates(source: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return []
  const base = resolve(dirname(source), specifier)
  return [
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.mjs$/u, '.mts'),
    base,
    `${base}.ts`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ]
}

export async function hashJevNativeBoxSourceClosure(repositoryRoot = repositoryRootFromModule) {
  const root = resolve(repositoryRoot)
  const pending = [
    ...new Set([
      join(root, 'benchmarks/v03/jev-native-box.ts'),
      join(root, 'benchmarks/v03/run-jev-native-box.ts'),
      ...FIXED_SOURCE_PATHS.map((path) => join(root, path)),
    ]),
  ]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const path = pending.pop()!
    if (visited.has(path)) continue
    visited.add(path)
    const bytes = await readFile(path)
    if (!/\.(?:[cm]?ts|[cm]?js)$/u.test(path)) {
      bytes.fill(0)
      continue
    }
    const ts = await import('typescript')
    const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true)
    const specifiers: string[] = []
    const visit = (node: TsNode) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const first = node.arguments[0]
        if (first && ts.isStringLiteral(first)) specifiers.push(first.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    bytes.fill(0)
    for (const specifier of specifiers) {
      const candidates = localSpecifierCandidates(path, specifier)
      if (candidates.length === 0) continue
      let found: string | undefined
      for (const candidate of candidates) {
        try {
          await access(candidate)
          found = candidate
          break
        } catch {
          // try next candidate
        }
      }
      if (!found) throw new Error(`Missing source dependency ${specifier} from ${path}`)
      pending.push(found)
    }
  }
  const files = []
  for (const path of [...visited].sort()) {
    const bytes = await readFile(path)
    files.push({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: sha256Bytes(bytes),
      bytes: bytes.byteLength,
    })
    bytes.fill(0)
  }
  return { files, sha256: hashCanonical(files) }
}

async function verifySourceClosure(
  repositoryRoot: string,
  expected: JevNativeBoxFreeze['sourceClosure'],
  expectedSha256: string,
): Promise<void> {
  const actual = await hashJevNativeBoxSourceClosure(repositoryRoot)
  if (actual.sha256 !== expectedSha256) throw new Error('source-closure-digest-mismatch')
  if (actual.files.length !== expected.length) throw new Error('source-closure-count-mismatch')
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index]!
    const right = actual.files[index]!
    if (left.path !== right.path || left.sha256 !== right.sha256 || left.bytes !== right.bytes)
      throw new Error('source-closure-entry-mismatch')
    const bytes = await readFile(join(repositoryRoot, left.path))
    if (sha256Bytes(bytes) !== left.sha256) throw new Error('source-closure-bytes-mismatch')
    bytes.fill(0)
  }
}

const ARTIFACT_LOG_ROOT = '/root/.codex/artifacts/zorya-classifier-jev-native-box-20261025' as const

function configureSharp(): void {
  sharp.cache({ memory: 32, files: 0, items: 0 })
  sharp.concurrency(1)
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (!('code' in error)) return false
  return error.code === code
}

export interface JevNativeBoxRunGuard {
  deadlineAt: number
  signal: AbortSignal
  now: () => number
}

export function assertJevNativeBoxRunContinues(guard: JevNativeBoxRunGuard): void {
  if (guard.now() > guard.deadlineAt) throw new Error('deadline-exceeded')
  if (guard.signal.aborted) throw new Error('aborted')
}

function resolveContained(root: string, candidatePath: string): string {
  if (isAbsolute(candidatePath)) throw new Error('path-absolute')
  const resolved = resolve(root, candidatePath)
  const part = relative(root, resolved)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('path-outside-root')
  return resolved
}

async function loadProducerRows(repositoryRoot: string): Promise<JevNativeBoxProducerRow[]> {
  const rows: JevNativeBoxProducerRow[] = []
  for (const lock of JEV_NATIVE_BOX_MANIFEST_LOCKS) {
    const path = join(repositoryRoot, lock.path)
    const bytes = await readFile(path)
    if (sha256Bytes(bytes) !== lock.sha256) throw new Error('manifest-hash-mismatch')
    const parsed = z.array(jevNativeBoxProducerRowSchema).parse(JSON.parse(bytes.toString('utf8')))
    rows.push(...parsed)
  }
  assertProducerInputOrder(rows)
  return rows
}

function validateFreezeRowsAgainstProducerRows(
  freezeRows: readonly JevNativeBoxFreeze['rows'][number][],
  producerRows: readonly JevNativeBoxProducerRow[],
): void {
  if (freezeRows.length !== producerRows.length)
    throw new Error('freeze-producer-row-count-mismatch')
  if (producerRows.length !== JEV_NATIVE_BOX_MANIFEST_LOCKS.length * 4)
    throw new Error('producer-manifest-row-count-mismatch')
  const producerByCaseId = new Map(producerRows.map((row) => [row.caseId, row]))
  for (let index = 0; index < producerRows.length; index += 1) {
    const producer = producerRows[index]!
    const freezeRow = freezeRows[index]!
    const matchedProducer = producerByCaseId.get(freezeRow.caseId)
    if (!matchedProducer || matchedProducer !== producer)
      throw new Error('freeze-producer-case-missing')
    if (freezeRow.caseId !== producer.caseId) throw new Error('freeze-producer-case-mismatch')
    if (freezeRow.target !== producer.locate.target)
      throw new Error('freeze-producer-target-mismatch')
    if (freezeRow.imagePath !== producer.image.path)
      throw new Error('freeze-producer-image-path-mismatch')
    if (freezeRow.sourceSha256 !== producer.image.sha256)
      throw new Error('freeze-producer-source-hash-mismatch')
    if (freezeRow.sourceWidth !== producer.image.width)
      throw new Error('freeze-producer-width-mismatch')
    if (freezeRow.sourceHeight !== producer.image.height)
      throw new Error('freeze-producer-height-mismatch')
  }
}

export async function readBoundedJevNativeBoxResponseBody(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<{ status: number; bodyText: string }> {
  const status = response.status
  const reader = response.body?.getReader()
  if (!reader) {
    if (signal.aborted) throw new Error('aborted')
    return { status, bodyText: '' }
  }
  let cancelTask: Promise<boolean> | undefined
  const cancel = (): void => {
    cancelTask ??= reader.cancel().then(
      () => true,
      () => false,
    )
  }
  signal.addEventListener('abort', cancel, { once: true })
  let caught: unknown
  let bodyText = ''
  let complete = false
  try {
    if (signal.aborted) throw new Error('aborted')
    const storage = Buffer.allocUnsafe(limit)
    let bytes = 0
    while (true) {
      if (signal.aborted) throw new Error('aborted')
      const next = await reader.read()
      if (signal.aborted) throw new Error('aborted')
      if (next.done) break
      if (next.value.byteLength > limit - bytes) throw new Error('response-body-limit')
      storage.set(next.value, bytes)
      bytes += next.value.byteLength
    }
    complete = true
    bodyText = new TextDecoder('utf-8', { fatal: true }).decode(storage.subarray(0, bytes))
  } catch (error) {
    caught = error
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    if (cancelTask) await cancelTask
    reader.releaseLock()
  }
  if (caught !== undefined) throw caught
  return { status, bodyText }
}

async function normalizeOrientedSource(
  raster: ReturnType<typeof createSharpRaster>,
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
  signal: AbortSignal,
): Promise<RasterImage> {
  if (signal.aborted) throw new Error('aborted')
  if (bytes.byteLength > JEV_NATIVE_BOX_MAX_SOURCE_ENCODED_BYTES)
    throw new Error('encoded-bytes-limit')
  const normalized = await raster.normalize(bytes, signal)
  if (normalized.width !== expectedWidth || normalized.height !== expectedHeight)
    throw new Error('oriented-dimensions-mismatch')
  return normalized
}

function preparedImageSha256FromPart(
  imagePart: ReturnType<typeof extractPreparedImagePart>,
): string {
  const prefix = 'data:image/png;base64,'
  const url = imagePart.image_url.url
  if (!url.startsWith(prefix)) throw new Error('prepared-image-encoding')
  return sha256Bytes(Buffer.from(url.slice(prefix.length), 'base64'))
}

function validatePreparedSides(
  transform: ReturnType<typeof parseSourceImageTransformFromImageState>,
): void {
  const { width, height } = transform.output
  if (
    width < JEV_NATIVE_BOX_PREPARED_MIN_SIDE ||
    height < JEV_NATIVE_BOX_PREPARED_MIN_SIDE ||
    width > JEV_NATIVE_BOX_PREPARED_MAX_SIDE ||
    height > JEV_NATIVE_BOX_PREPARED_MAX_SIDE
  )
    throw new Error('prepared-side-out-of-range')
}

export interface PrepareJevNativeBoxOptions {
  repositoryRoot: string
  dataRoot: string
  capabilityReceiptPath: string
  capabilitySourcePath?: string
  outputDirectory: string
  imageState?: RasterPort['imageState']
  signal?: AbortSignal
  now?: () => number
}

export async function prepareJevNativeBoxFreeze(
  options: PrepareJevNativeBoxOptions,
): Promise<{ freeze: JevNativeBoxFreeze; outputDirectory: string }> {
  configureSharp()
  const repositoryRoot = resolve(options.repositoryRoot)
  const dataRoot = resolve(options.dataRoot)
  const outputDirectory = resolve(options.outputDirectory)
  const signal = options.signal ?? new AbortController().signal
  const now = options.now ?? (() => performance.now())
  const raster = createSharpRaster()
  const imageState = options.imageState ?? raster.imageState

  try {
    await mkdir(outputDirectory, { recursive: false })
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) throw new Error('output-exists')
    throw error
  }

  const capabilitySourcePath =
    options.capabilitySourcePath ??
    join(dirname(resolve(options.capabilityReceiptPath)), 'capability-source.json')
  const capabilityReceipt = await validateCapabilityArtifacts({
    receiptPath: resolve(options.capabilityReceiptPath),
    sourcePath: capabilitySourcePath,
    readFile: async (path) => new Uint8Array(await readFile(path)),
  })

  const rows = await loadProducerRows(repositoryRoot)
  const sourceClosure = await hashJevNativeBoxSourceClosure(repositoryRoot)
  await mkdir(join(outputDirectory, 'payloads'), { recursive: true })
  const freezeRows: JevNativeBoxFreeze['rows'] = []

  for (const row of rows) {
    if (signal.aborted) throw new Error('aborted')
    const encodedPath = resolveContained(dataRoot, row.image.path)
    const fileStat = await stat(encodedPath)
    if (fileStat.size > JEV_NATIVE_BOX_MAX_SOURCE_ENCODED_BYTES)
      throw new Error('source-encoded-bytes-limit')
    const encodedBytes = new Uint8Array(await readFile(encodedPath))
    if (sha256Bytes(encodedBytes) !== row.image.sha256) throw new Error('source-hash-mismatch')
    const normalized = await normalizeOrientedSource(
      raster,
      encodedBytes,
      row.image.width,
      row.image.height,
      signal,
    )
    encodedBytes.fill(0)
    const preparedState = await imageState(normalized, signal)
    const preparedImage = extractPreparedImagePart(preparedState)
    const transform = parseSourceImageTransformFromImageState(preparedState)
    validatePreparedSides(transform)
    const wireBody = buildJevNativeBoxWireBody(row.locate.target, preparedImage)
    const bodyText = `${JSON.stringify(wireBody)}\n`
    const bodyBytes = Buffer.byteLength(bodyText, 'utf8')
    if (bodyBytes > JEV_NATIVE_BOX_MAX_REQUEST_BYTES) throw new Error('request-body-limit')
    if (wireBody.questions.presence.instructions !== JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION)
      throw new Error('presence-instruction-mismatch')
    if (wireBody.questions.object.instructions !== JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION)
      throw new Error('object-instruction-mismatch')
    const payloadRelativePath = join('payloads', `${row.caseId}.request.json`).replaceAll('\\', '/')
    await writeFile(join(outputDirectory, payloadRelativePath), bodyText, { flag: 'wx' })
    const targetLine = wireBody.state[1]
    freezeRows.push({
      caseId: row.caseId,
      target: row.locate.target,
      imagePath: row.image.path,
      sourceSha256: row.image.sha256,
      sourceWidth: row.image.width,
      sourceHeight: row.image.height,
      preparedImageSha256: preparedImageSha256FromPart(preparedImage),
      preparedWidth: transform.output.width,
      preparedHeight: transform.output.height,
      sourceImageTransform: transform,
      requestBodySha256: sha256Bytes(Buffer.from(bodyText, 'utf8')),
      requestBodyBytes: bodyBytes,
      requestPayloadRelativePath: payloadRelativePath,
      authoredTargetLine: targetLine,
      presenceInstructions: JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION,
      objectInstructions: JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION,
    })
    normalized.bytes.fill(0)
  }

  const freezeWithoutDigest = {
    schema: JEV_NATIVE_BOX_FREEZE_SCHEMA,
    status: 'frozen-before-dispatch' as const,
    profileId: JEV_NATIVE_BOX_PROFILE_ID,
    producerInputsSha256: JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256,
    producerCodeSha256: sourceClosure.sha256,
    sourceClosureSha256: sourceClosure.sha256,
    sourceClosure: sourceClosure.files,
    capabilitySourceSha256: capabilityReceipt.sha256,
    capabilityReceipt,
    h8aRunSha256: JEV_NATIVE_BOX_H8A_RUN_SHA256,
    h8aEvaluationSha256: JEV_NATIVE_BOX_H8A_EVALUATION_SHA256,
    route: {
      model: 'typesafe/jev-1.14' as const,
      provider: 'typesafe' as const,
      providerName: 'TypeSafe' as const,
      apiEndpoint: JEV_NATIVE_BOX_API_PATH,
      allowFallbacks: false as const,
      dangerZoneImagesHeader: true as const,
    },
    budget: {
      maxPhysicalCalls: JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
      maxCostUsd: JEV_NATIVE_BOX_MAX_COST_USD,
      unknownReserveUsdPerCall: JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD,
    },
    limits: {
      caseDeadlineMs: JEV_NATIVE_BOX_CASE_DEADLINE_MS,
      maxRequestBytes: JEV_NATIVE_BOX_MAX_REQUEST_BYTES,
      maxResponseBytes: JEV_NATIVE_BOX_MAX_RESPONSE_BYTES,
      maxSourceEncodedBytes: JEV_NATIVE_BOX_MAX_SOURCE_ENCODED_BYTES,
      preparedMinSide: JEV_NATIVE_BOX_PREPARED_MIN_SIDE,
      preparedMaxSide: JEV_NATIVE_BOX_PREPARED_MAX_SIDE,
    },
    manifestLocks: [...JEV_NATIVE_BOX_MANIFEST_LOCKS],
    rows: freezeRows,
  }
  const freezeSha256 = computeJevNativeBoxFreezeSha256(freezeWithoutDigest)
  const freeze = jevNativeBoxFreezeSchema.parse({ ...freezeWithoutDigest, freezeSha256 })
  await writeFile(join(outputDirectory, 'freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, {
    flag: 'wx',
  })
  void now
  return { freeze, outputDirectory }
}

export async function readJevNativeBoxFreeze(path: string): Promise<JevNativeBoxFreeze> {
  const bytes = await readFile(path)
  const parsed = jevNativeBoxFreezeSchema.parse(JSON.parse(bytes.toString('utf8')))
  const { freezeSha256, ...rest } = parsed
  if (computeJevNativeBoxFreezeSha256(rest) !== freezeSha256)
    throw new Error('freeze-digest-mismatch')
  return parsed
}

export interface JevNativeBoxPhysicalReceipt {
  physicalId: number
  caseId: string
  requestBodySha256: string
  httpStatus: number | null
  responseBodySha256: string | null
  responseModel: string | null
  responseProvider: string | null
  costUsd: number | null
  durationMs: number
  outcome: 'resolved' | 'transport-error' | 'protocol-error' | 'not-run' | 'blocked'
  errorCode: string | null
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)

export const jevNativeBoxRunManifestSchema = z
  .object({
    schema: z.literal(JEV_NATIVE_BOX_RUN_SCHEMA),
    status: z.enum(['complete', 'blocked', 'failed']),
    profileId: z.literal(JEV_NATIVE_BOX_PROFILE_ID),
    freezeSha256: digestSchema,
    sourceClosureSha256: digestSchema,
    sourceClosureSha256After: digestSchema,
    dataRoot: z.string().min(1),
    freezeDirectory: z.string().min(1),
    rows: z.array(
      z
        .object({
          caseId: z.string().min(1),
          status: z.enum(['resolved', 'transport-error', 'protocol-error', 'not-run', 'blocked']),
          presenceNoul: z.number().min(0).max(1).nullable(),
          rawBox: z
            .object({
              left: z.number().finite(),
              top: z.number().finite(),
              right: z.number().finite(),
              bottom: z.number().finite(),
            })
            .strict()
            .nullable(),
          responseBodySha256: digestSchema.nullable(),
          errorCode: z.string().nullable(),
        })
        .strict(),
    ),
    physicalReceipts: z.array(
      z
        .object({
          physicalId: z.number().int().positive(),
          caseId: z.string().min(1),
          requestBodySha256: digestSchema,
          httpStatus: z.number().int().nullable(),
          responseBodySha256: digestSchema.nullable(),
          responseModel: z.string().nullable(),
          responseProvider: z.string().nullable(),
          costUsd: z.number().finite().nonnegative().nullable(),
          durationMs: z.number().finite().nonnegative(),
          outcome: z.enum(['resolved', 'transport-error', 'protocol-error', 'not-run', 'blocked']),
          errorCode: z.string().nullable(),
        })
        .strict(),
    ),
    budget: z
      .object({
        admittedPhysicalCalls: z.number().int().nonnegative(),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownCostCalls: z.number().int().nonnegative(),
        inFlightCalls: z.number().int().nonnegative(),
        accountedExposureUsd: z.number().finite().nonnegative(),
        maxPhysicalCalls: z.number().int().positive(),
        maxCostUsd: z.number().finite().positive(),
      })
      .strict(),
    consecutiveTransportErrors: z.number().int().nonnegative(),
  })
  .strict()

export type JevNativeBoxRunManifest = z.infer<typeof jevNativeBoxRunManifestSchema>

export interface ExecuteJevNativeBoxOptions {
  repositoryRoot: string
  dataRoot: string
  freezePath: string
  expectedFreezeSha256: string
  outputDirectory: string
  apiKey: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  now?: () => number
}

async function verifyDispatchCaseInputs(input: {
  dataRoot: string
  freezeDirectory: string
  freezeRow: JevNativeBoxFreeze['rows'][number]
  raster: ReturnType<typeof createSharpRaster>
  imageState: RasterPort['imageState']
  signal: AbortSignal
}): Promise<string> {
  const encodedPath = resolveContained(input.dataRoot, input.freezeRow.imagePath)
  const encodedBytes = new Uint8Array(await readFile(encodedPath))
  if (sha256Bytes(encodedBytes) !== input.freezeRow.sourceSha256)
    throw new Error('source-hash-mismatch')
  const normalized = await normalizeOrientedSource(
    input.raster,
    encodedBytes,
    input.freezeRow.sourceWidth,
    input.freezeRow.sourceHeight,
    input.signal,
  )
  encodedBytes.fill(0)
  const preparedState = await input.imageState(normalized, input.signal)
  const preparedImage = extractPreparedImagePart(preparedState)
  const transform = parseSourceImageTransformFromImageState(preparedState)
  if (
    sha256Bytes(
      Buffer.from(preparedImage.image_url.url.slice('data:image/png;base64,'.length), 'base64'),
    ) !== input.freezeRow.preparedImageSha256
  )
    throw new Error('prepared-image-hash-mismatch')
  if (
    transform.output.width !== input.freezeRow.preparedWidth ||
    transform.output.height !== input.freezeRow.preparedHeight
  )
    throw new Error('prepared-dimensions-mismatch')
  if (hashCanonical(transform) !== hashCanonical(input.freezeRow.sourceImageTransform))
    throw new Error('prepared-transform-mismatch')
  const rebuilt = `${JSON.stringify(buildJevNativeBoxWireBody(input.freezeRow.target, preparedImage))}\n`
  if (sha256Bytes(Buffer.from(rebuilt, 'utf8')) !== input.freezeRow.requestBodySha256)
    throw new Error('request-body-hash-mismatch')
  normalized.bytes.fill(0)
  const payloadPath = join(input.freezeDirectory, input.freezeRow.requestPayloadRelativePath)
  const payloadBytes = new Uint8Array(await readFile(payloadPath))
  const payloadText = new TextDecoder().decode(payloadBytes)
  if (sha256Bytes(payloadBytes) !== input.freezeRow.requestBodySha256)
    throw new Error('payload-file-hash-mismatch')
  if (payloadText !== rebuilt) throw new Error('payload-bytes-mismatch')
  return payloadText
}

async function writePhysicalArtifact(
  outputDirectory: string,
  fileName: string,
  payload: unknown,
): Promise<void> {
  await writeFile(join(outputDirectory, fileName), `${JSON.stringify(payload, null, 2)}\n`, {
    flag: 'wx',
  })
}

async function persistPhysicalReceipt(
  outputDirectory: string,
  receipt: JevNativeBoxPhysicalReceipt,
): Promise<void> {
  await writePhysicalArtifact(
    outputDirectory,
    `physical-receipt-${receipt.physicalId}.json`,
    receipt,
  )
}

export function releasePhysicalBudget(
  budget: RunBudget,
  physicalId: number,
  fetchInvoked: boolean,
  costUsd: number | null,
): void {
  if (!fetchInvoked) budget.cancelBeforeFetch(physicalId)
  else budget.settle(physicalId, costUsd)
}

async function persistRunManifest(
  outputDirectory: string,
  manifest: JevNativeBoxRunManifest,
  fileName: 'run-manifest.json' | 'run-manifest.blocked.json',
): Promise<void> {
  await writeFile(join(outputDirectory, fileName), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  })
}

export async function executeJevNativeBoxRun(
  options: ExecuteJevNativeBoxOptions,
): Promise<JevNativeBoxRunManifest> {
  configureSharp()
  const repositoryRoot = resolve(options.repositoryRoot)
  const dataRoot = resolve(options.dataRoot)
  const outputDirectory = resolve(options.outputDirectory)
  const fetcher = options.fetch ?? globalThis.fetch
  const raster = createSharpRaster()
  const imageState = raster.imageState
  const budget = new RunBudget(
    JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
    JEV_NATIVE_BOX_MAX_COST_USD,
    JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD,
  )

  try {
    await mkdir(outputDirectory, { recursive: false })
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) throw new Error('output-exists')
    throw error
  }

  const freezePath = resolve(options.freezePath)
  const freezeDirectory = dirname(freezePath)
  const freeze = await readJevNativeBoxFreeze(freezePath)
  if (freeze.freezeSha256 !== options.expectedFreezeSha256)
    throw new Error('freeze-sha256-mismatch')
  if (freeze.h8aRunSha256 !== JEV_NATIVE_BOX_H8A_RUN_SHA256)
    throw new Error('h8a-run-identity-mismatch')
  if (freeze.h8aEvaluationSha256 !== JEV_NATIVE_BOX_H8A_EVALUATION_SHA256)
    throw new Error('h8a-evaluation-identity-mismatch')
  await verifySourceClosure(repositoryRoot, freeze.sourceClosure, freeze.sourceClosureSha256)
  const producerRows = await loadProducerRows(repositoryRoot)
  validateFreezeRowsAgainstProducerRows(freeze.rows, producerRows)

  const physicalReceipts: JevNativeBoxPhysicalReceipt[] = []
  const manifestRows: JevNativeBoxRunManifest['rows'] = []
  let consecutiveTransportErrors = 0
  let blocked = false
  let caseRunFailed = false
  const now = options.now ?? (() => performance.now())

  for (const freezeRow of freeze.rows) {
    if (blocked) {
      manifestRows.push({
        caseId: freezeRow.caseId,
        status: 'not-run',
        presenceNoul: null,
        rawBox: null,
        responseBodySha256: null,
        errorCode: 'admission-blocked',
      })
      continue
    }

    const caseStarted = now()
    const caseDeadlineAt = caseStarted + JEV_NATIVE_BOX_CASE_DEADLINE_MS
    const caseController = new AbortController()
    const parentSignal = options.signal ?? new AbortController().signal
    const caseSignal = AbortSignal.any([parentSignal, caseController.signal])
    const caseTimer = setTimeout(() => caseController.abort(), JEV_NATIVE_BOX_CASE_DEADLINE_MS)
    const guard: JevNativeBoxRunGuard = { deadlineAt: caseDeadlineAt, signal: caseSignal, now }

    let physicalId: number | null = null
    let settled = false
    let fetchInvoked = false
    let receiptWritten = false
    let started = now()
    let httpStatus: number | null = null
    let raw: string | undefined
    let responseBodySha256: string | null = null
    let verifiedCost: number | null = null
    let envelopeModel: string | null = null
    let envelopeProvider: string | null = null
    let parsed: ReturnType<typeof parseJevNativeBoxResponse> | undefined
    try {
      assertJevNativeBoxRunContinues(guard)
      await verifySourceClosure(repositoryRoot, freeze.sourceClosure, freeze.sourceClosureSha256)
      const bodyText = await verifyDispatchCaseInputs({
        dataRoot,
        freezeDirectory,
        freezeRow,
        raster,
        imageState,
        signal: caseSignal,
      })
      if (Buffer.byteLength(bodyText, 'utf8') > JEV_NATIVE_BOX_MAX_REQUEST_BYTES)
        throw new Error('request-body-limit')
      assertJevNativeBoxRunContinues(guard)
      physicalId = budget.admit()
      try {
        await writePhysicalArtifact(outputDirectory, `physical-admission-${physicalId}.json`, {
          physicalId,
          caseId: freezeRow.caseId,
          requestBodySha256: freezeRow.requestBodySha256,
          admittedAtMs: now(),
        })
        await writeFile(join(outputDirectory, `request-body-${physicalId}.json`), bodyText, {
          flag: 'wx',
        })
      } catch (reservationError) {
        releasePhysicalBudget(budget, physicalId, false, null)
        settled = true
        throw reservationError
      }
      assertJevNativeBoxRunContinues(guard)
      started = now()
      fetchInvoked = true
      let response: Response
      try {
        response = await fetcher(JEV_NATIVE_BOX_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            'TypeSafe-Danger-Zone-Images': 'true',
          },
          body: bodyText,
          signal: caseSignal,
          redirect: 'error',
        })
      } catch (error) {
        consecutiveTransportErrors++
        releasePhysicalBudget(budget, physicalId, true, null)
        settled = true
        const receipt: JevNativeBoxPhysicalReceipt = {
          physicalId,
          caseId: freezeRow.caseId,
          requestBodySha256: freezeRow.requestBodySha256,
          httpStatus: null,
          responseBodySha256: null,
          responseModel: null,
          responseProvider: null,
          costUsd: null,
          durationMs: Math.max(0, now() - started),
          outcome: 'transport-error',
          errorCode: error instanceof Error ? error.name : 'transport-error',
        }
        physicalReceipts.push(receipt)
        await persistPhysicalReceipt(outputDirectory, receipt)
        receiptWritten = true
        manifestRows.push({
          caseId: freezeRow.caseId,
          status: 'transport-error',
          presenceNoul: null,
          rawBox: null,
          responseBodySha256: null,
          errorCode: 'transport-error',
        })
        if (consecutiveTransportErrors >= JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
          blocked = true
        continue
      }

      try {
        const read = await readBoundedJevNativeBoxResponseBody(
          response,
          caseSignal,
          JEV_NATIVE_BOX_MAX_RESPONSE_BYTES,
        )
        httpStatus = read.status
        raw = read.bodyText
        responseBodySha256 = sha256Bytes(Buffer.from(raw, 'utf8'))
        try {
          await writeFile(join(outputDirectory, `response-body-${physicalId}.json`), raw, {
            flag: 'wx',
          })
        } catch (writeError) {
          caseRunFailed = true
          consecutiveTransportErrors++
          releasePhysicalBudget(budget, physicalId, true, null)
          settled = true
          const receipt: JevNativeBoxPhysicalReceipt = {
            physicalId,
            caseId: freezeRow.caseId,
            requestBodySha256: freezeRow.requestBodySha256,
            httpStatus,
            responseBodySha256,
            responseModel: null,
            responseProvider: null,
            costUsd: null,
            durationMs: Math.max(0, now() - started),
            outcome: 'protocol-error',
            errorCode:
              writeError instanceof Error
                ? writeError.message.slice(0, 64)
                : 'response-body-persist-failed',
          }
          physicalReceipts.push(receipt)
          await persistPhysicalReceipt(outputDirectory, receipt)
          receiptWritten = true
          manifestRows.push({
            caseId: freezeRow.caseId,
            status: 'protocol-error',
            presenceNoul: null,
            rawBox: null,
            responseBodySha256,
            errorCode: 'response-body-persist-failed',
          })
          if (consecutiveTransportErrors >= JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
            blocked = true
          continue
        }
      } catch (error) {
        consecutiveTransportErrors++
        releasePhysicalBudget(budget, physicalId, true, null)
        settled = true
        const receipt: JevNativeBoxPhysicalReceipt = {
          physicalId,
          caseId: freezeRow.caseId,
          requestBodySha256: freezeRow.requestBodySha256,
          httpStatus: response.status,
          responseBodySha256,
          responseModel: null,
          responseProvider: null,
          costUsd: null,
          durationMs: Math.max(0, now() - started),
          outcome: 'protocol-error',
          errorCode: error instanceof Error ? error.message.slice(0, 64) : 'protocol-error',
        }
        physicalReceipts.push(receipt)
        await persistPhysicalReceipt(outputDirectory, receipt)
        receiptWritten = true
        manifestRows.push({
          caseId: freezeRow.caseId,
          status: 'protocol-error',
          presenceNoul: null,
          rawBox: null,
          responseBodySha256,
          errorCode: 'protocol-error',
        })
        if (consecutiveTransportErrors >= JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
          blocked = true
        continue
      }
      try {
        const envelope = parseJevNativeBoxResponseEnvelope(raw)
        verifiedCost = envelope.usageCost
        envelopeModel = envelope.model
        envelopeProvider = envelope.provider
      } catch (error) {
        consecutiveTransportErrors++
        releasePhysicalBudget(budget, physicalId, true, null)
        settled = true
        const receipt: JevNativeBoxPhysicalReceipt = {
          physicalId,
          caseId: freezeRow.caseId,
          requestBodySha256: freezeRow.requestBodySha256,
          httpStatus,
          responseBodySha256,
          responseModel: null,
          responseProvider: null,
          costUsd: null,
          durationMs: Math.max(0, now() - started),
          outcome: 'protocol-error',
          errorCode: error instanceof Error ? error.message.slice(0, 64) : 'protocol-error',
        }
        physicalReceipts.push(receipt)
        await persistPhysicalReceipt(outputDirectory, receipt)
        receiptWritten = true
        manifestRows.push({
          caseId: freezeRow.caseId,
          status: 'protocol-error',
          presenceNoul: null,
          rawBox: null,
          responseBodySha256,
          errorCode: 'protocol-error',
        })
        if (consecutiveTransportErrors >= JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
          blocked = true
        continue
      }

      try {
        parsed = parseJevNativeBoxResponse(raw)
        validateJevNativeBoxResponseMetadata(parsed)
      } catch (error) {
        consecutiveTransportErrors++
        releasePhysicalBudget(budget, physicalId, true, verifiedCost)
        settled = true
        const receipt: JevNativeBoxPhysicalReceipt = {
          physicalId,
          caseId: freezeRow.caseId,
          requestBodySha256: freezeRow.requestBodySha256,
          httpStatus,
          responseBodySha256,
          responseModel: parsed?.model ?? envelopeModel,
          responseProvider: parsed?.provider ?? envelopeProvider,
          costUsd: verifiedCost,
          durationMs: Math.max(0, now() - started),
          outcome: 'protocol-error',
          errorCode: error instanceof Error ? error.message.slice(0, 64) : 'protocol-error',
        }
        physicalReceipts.push(receipt)
        await persistPhysicalReceipt(outputDirectory, receipt)
        receiptWritten = true
        manifestRows.push({
          caseId: freezeRow.caseId,
          status: 'protocol-error',
          presenceNoul: parsed?.answers.presence.noul ?? null,
          rawBox: parsed?.answers.object.box ?? null,
          responseBodySha256,
          errorCode: 'protocol-error',
        })
        if (consecutiveTransportErrors >= JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
          blocked = true
        continue
      }

      if (!response.ok) {
        consecutiveTransportErrors++
        releasePhysicalBudget(budget, physicalId, true, verifiedCost)
        settled = true
        const receipt: JevNativeBoxPhysicalReceipt = {
          physicalId,
          caseId: freezeRow.caseId,
          requestBodySha256: freezeRow.requestBodySha256,
          httpStatus,
          responseBodySha256,
          responseModel: parsed.model ?? envelopeModel,
          responseProvider: parsed.provider ?? envelopeProvider,
          costUsd: verifiedCost,
          durationMs: Math.max(0, now() - started),
          outcome: 'protocol-error',
          errorCode: `http-${httpStatus}`,
        }
        physicalReceipts.push(receipt)
        await persistPhysicalReceipt(outputDirectory, receipt)
        receiptWritten = true
        manifestRows.push({
          caseId: freezeRow.caseId,
          status: 'protocol-error',
          presenceNoul: null,
          rawBox: null,
          responseBodySha256,
          errorCode: `http-${httpStatus}`,
        })
        if (consecutiveTransportErrors >= JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
          blocked = true
        continue
      }

      assertJevNativeBoxRunContinues(guard)
      consecutiveTransportErrors = 0
      releasePhysicalBudget(budget, physicalId, true, verifiedCost)
      settled = true
      const metadata = validateJevNativeBoxResponseMetadata(parsed)
      const receipt: JevNativeBoxPhysicalReceipt = {
        physicalId,
        caseId: freezeRow.caseId,
        requestBodySha256: freezeRow.requestBodySha256,
        httpStatus,
        responseBodySha256,
        responseModel: metadata.model,
        responseProvider: metadata.provider,
        costUsd: verifiedCost,
        durationMs: Math.max(0, now() - started),
        outcome: 'resolved',
        errorCode: null,
      }
      physicalReceipts.push(receipt)
      await persistPhysicalReceipt(outputDirectory, receipt)
      receiptWritten = true
      manifestRows.push({
        caseId: freezeRow.caseId,
        status: 'resolved',
        presenceNoul: parsed.answers.presence.noul,
        rawBox: parsed.answers.object.box,
        responseBodySha256,
        errorCode: null,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'case-error'
      const deadlineExceeded = errorMessage === 'deadline-exceeded'
      if (physicalId !== null && !settled) {
        const settleError = error
        try {
          releasePhysicalBudget(
            budget,
            physicalId,
            fetchInvoked,
            fetchInvoked ? verifiedCost : null,
          )
        } catch (budgetError) {
          const combined = new Error('budget-settle-failed')
          combined.cause = { settleError, budgetError }
          throw combined
        }
        settled = true
      }
      if (fetchInvoked && physicalId !== null && !receiptWritten) {
        caseRunFailed = true
        const failureReceipt: JevNativeBoxPhysicalReceipt = {
          physicalId,
          caseId: freezeRow.caseId,
          requestBodySha256: freezeRow.requestBodySha256,
          httpStatus,
          responseBodySha256,
          responseModel: parsed?.model ?? envelopeModel,
          responseProvider: parsed?.provider ?? envelopeProvider,
          costUsd: verifiedCost,
          durationMs: Math.max(0, now() - started),
          outcome: 'protocol-error',
          errorCode: deadlineExceeded ? 'deadline-exceeded' : errorMessage.slice(0, 64),
        }
        physicalReceipts.push(failureReceipt)
        try {
          await persistPhysicalReceipt(outputDirectory, failureReceipt)
          receiptWritten = true
        } catch (persistError) {
          caseRunFailed = true
          const combined = new Error('physical-receipt-persist-failed')
          combined.cause = { persistError, failureReceipt }
          throw combined
        }
        manifestRows.push({
          caseId: freezeRow.caseId,
          status: 'protocol-error',
          presenceNoul: parsed?.answers.presence.noul ?? null,
          rawBox: parsed?.answers.object.box ?? null,
          responseBodySha256,
          errorCode: deadlineExceeded ? 'deadline-exceeded' : errorMessage.slice(0, 64),
        })
      } else if (!receiptWritten) {
        caseRunFailed = true
        if (error instanceof RunBudgetExhausted) {
          blocked = true
          manifestRows.push({
            caseId: freezeRow.caseId,
            status: 'blocked',
            presenceNoul: null,
            rawBox: null,
            responseBodySha256: null,
            errorCode: error.code,
          })
        } else {
          if (!deadlineExceeded) consecutiveTransportErrors++
          manifestRows.push({
            caseId: freezeRow.caseId,
            status: 'protocol-error',
            presenceNoul: null,
            rawBox: null,
            responseBodySha256: null,
            errorCode: errorMessage.slice(0, 64),
          })
          if (consecutiveTransportErrors >= JEV_NATIVE_BOX_MAX_CONSECUTIVE_TRANSPORT_ERRORS)
            blocked = true
        }
      }
    } finally {
      clearTimeout(caseTimer)
    }
  }

  let manifestStatus: 'complete' | 'blocked' | 'failed' = blocked
    ? 'blocked'
    : caseRunFailed
      ? 'failed'
      : 'complete'
  let sourceClosureAfterSha256 = freeze.sourceClosureSha256
  try {
    const sourceClosureAfter = await hashJevNativeBoxSourceClosure(repositoryRoot)
    sourceClosureAfterSha256 = sourceClosureAfter.sha256
    if (sourceClosureAfter.sha256 !== freeze.sourceClosureSha256) manifestStatus = 'failed'
  } catch {
    manifestStatus = 'failed'
  }

  const manifest = jevNativeBoxRunManifestSchema.parse({
    schema: JEV_NATIVE_BOX_RUN_SCHEMA,
    status: manifestStatus,
    profileId: JEV_NATIVE_BOX_PROFILE_ID,
    freezeSha256: freeze.freezeSha256,
    sourceClosureSha256: freeze.sourceClosureSha256,
    sourceClosureSha256After: sourceClosureAfterSha256,
    dataRoot,
    freezeDirectory,
    rows: manifestRows,
    physicalReceipts,
    budget: budget.snapshot(),
    consecutiveTransportErrors,
  })

  let primaryWriteError: unknown
  try {
    await persistRunManifest(outputDirectory, manifest, 'run-manifest.json')
  } catch (error) {
    primaryWriteError = error
    try {
      await persistRunManifest(
        outputDirectory,
        { ...manifest, status: 'failed' },
        'run-manifest.blocked.json',
      )
    } catch (fallbackError) {
      const combined = new Error('run-manifest-persist-failed')
      combined.cause = { primaryWriteError, fallbackError }
      throw combined
    }
    throw primaryWriteError
  }
  return manifest
}

async function writePreparationFailureLog(message: string): Promise<void> {
  const path = join(ARTIFACT_LOG_ROOT, 'preparation-errors.json')
  const payload = { capturedAt: new Date().toISOString(), message }
  try {
    await mkdir(ARTIFACT_LOG_ROOT, { recursive: true })
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' })
  } catch {
    await writeFile(
      join(ARTIFACT_LOG_ROOT, `preparation-errors-${Date.now()}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      { flag: 'wx' },
    )
  }
}

function usage(): never {
  console.error(
    [
      'Prepare: node --import tsx benchmarks/v03/run-jev-native-box.ts prepare --data-root <path> --output <new-directory> [--capability-receipt <path>]',
      'Execute: node --import tsx benchmarks/v03/run-jev-native-box.ts execute --allow-paid --freeze <path> --freeze-sha256 <hash> --data-root <path> --output <new-directory> [--env-file <path>]',
    ].join('\n'),
  )
  process.exitCode = 1
  throw new Error('cli-usage')
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs({
    args: argv,
    options: {
      prepare: { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      'allow-paid': { type: 'boolean', default: false },
      'data-root': { type: 'string' },
      output: { type: 'string' },
      freeze: { type: 'string' },
      'freeze-sha256': { type: 'string' },
      'env-file': { type: 'string' },
      'capability-receipt': { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  })

  const mode = args.positionals[0]
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

  if (mode === 'prepare') {
    if (!args.values['data-root'] || !args.values.output) usage()
    const capabilityReceipt =
      args.values['capability-receipt'] ?? join(ARTIFACT_LOG_ROOT, 'capability-receipt.json')
    try {
      await prepareJevNativeBoxFreeze({
        repositoryRoot,
        dataRoot: resolve(args.values['data-root']),
        capabilityReceiptPath: capabilityReceipt,
        capabilitySourcePath: join(dirname(capabilityReceipt), 'capability-source.json'),
        outputDirectory: resolve(args.values.output),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'prepare-failed'
      await writePreparationFailureLog(message)
      throw error
    }
    return
  }

  if (mode === 'execute') {
    if (
      !args.values['allow-paid'] ||
      !args.values.freeze ||
      !args.values['freeze-sha256'] ||
      !args.values['data-root'] ||
      !args.values.output
    )
      usage()
    const apiKey = args.values['env-file']
      ? await readOpenRouterKeyFromEnvFile(resolve(args.values['env-file']))
      : readOpenRouterKeyFromProcessEnv()
    await executeJevNativeBoxRun({
      repositoryRoot,
      dataRoot: resolve(args.values['data-root']),
      freezePath: resolve(args.values.freeze),
      expectedFreezeSha256: args.values['freeze-sha256'],
      outputDirectory: resolve(args.values.output),
      apiKey,
    })
    return
  }

  usage()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    if (!(error instanceof Error && error.message === 'cli-usage')) {
      console.error(error instanceof Error ? error.message : 'run-failed')
    }
    process.exitCode = 1
  })
}
