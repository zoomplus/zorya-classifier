import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { z } from 'zod'
import {
  acceptsResponseModel,
  unexpectedResponseProvider,
} from '../../src/infrastructure/decision-transport/route-identity.js'
import { createSharpRaster } from '../../src/infrastructure/raster.js'
import { binaryMaskIoU, wholeObjectMatch, type Box } from '../v02/metrics.js'
import { hashCanonical } from '../v02/protocol.js'
import { loadV03PilotTruth, type V03PilotTruth } from './evaluate-pilot.js'
import {
  JEV_NATIVE_BOX_EVALUATION_SCHEMA,
  JEV_NATIVE_BOX_EXPECTED_CASE_IDS,
  JEV_NATIVE_BOX_MANIFEST_LOCKS,
  JEV_NATIVE_BOX_MAX_COST_USD,
  JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS,
  JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256,
  JEV_NATIVE_BOX_PROFILE_ID,
  JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD,
  assertProducerInputOrder,
  authoredTargetStateLine,
  extractPreparedImagePart,
  jevNativeBoxProducerRowSchema,
  jevNativeBoxWireBodySchema,
  mapNoulScoreToPresence,
  overlayRoundedBox,
  parseJevNativeBoxResponse,
  parseSourceImageTransformFromImageState,
  parseJevNativeBoxResponseEnvelope,
  validateJevNativeBoxResponseMetadata,
  type JevNativeBoxFreeze,
  type JevNativeBoxProducerRow,
  type NormalizedProviderBox,
  type SourceImageTransformMetadata,
} from './jev-native-box.js'
import {
  hashJevNativeBoxSourceClosure,
  jevNativeBoxRunManifestSchema,
  readJevNativeBoxFreeze,
  type JevNativeBoxRunManifest,
} from './run-jev-native-box.js'

export const JEV_BOX_IOU_GATE = 0.5 as const
export const JEV_BOX_COVERAGE_GATE = 0.9 as const

export const JEV_NATIVE_BOX_EVALUATOR_TRUTH_SHA256 =
  'af5bf46d19c7c7dd418f6da0b2d26b7708bf7e4ca659ea378641c424e2f3a1dd' as const
export const JEV_NATIVE_BOX_H8A_RUN_SHA256 =
  '1def8b64894f520e6e3ddd9c432212e1333684ae5db1e7c5747485c185cbb98a' as const
export const JEV_NATIVE_BOX_H8A_EVALUATION_SHA256 =
  '1a6850b69d4f5ce52d0531594ede845ba0aeb3698b844f5946c33da46c3fbab2' as const
export const JEV_NATIVE_BOX_H8A_RUN_PATH =
  '/root/projects/Zorya/.migration/20261022-r1/classifier/aux/runs/v03/h8a-luna-chat-8633fe55-47af-441b-9265-a159d3e4efc8/run.json' as const
export const JEV_NATIVE_BOX_H8A_EVALUATION_RELATIVE =
  'docs/evidence/v03/h8a-ordinary-vision-independent-evaluation.json' as const
export const JEV_NATIVE_BOX_PHOTO02_MASK_IOU = 0.9020429943588961 as const

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)

const physicalAdmissionSchema = z
  .object({
    physicalId: z.number().int().positive(),
    caseId: z.string().min(1),
    requestBodySha256: digestSchema,
    admittedAtMs: z.number().finite(),
  })
  .strict()

const physicalReceiptFileSchema = z
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
  .strict()

const h8EvaluationSchema = z
  .object({
    schema: z.literal('v03-h8-ordinary-vision-independent-evaluation-v1'),
    production: z
      .object({
        runSha256: z.literal(JEV_NATIVE_BOX_H8A_RUN_SHA256),
      })
      .passthrough(),
    negativeSummary: z
      .object({
        denominator: z.literal(3),
        presenceChoices: z
          .object({
            present: z.literal(2),
            absent: z.literal(1),
            uncertain: z.literal(0),
          })
          .strict(),
        falseAtPresence: z.array(z.string().min(1)),
        correctTargetAbsent: z.array(z.string().min(1)),
        uncertain: z.array(z.string()),
        falseOutputs: z.array(z.string().min(1)),
        errors: z.array(z.string()),
      })
      .strict(),
    rows: z.array(
      z.object({ caseId: z.string().min(1), truth: z.enum(['present', 'absent']) }).passthrough(),
    ),
  })
  .passthrough()

const h8RunRowSchema = z
  .object({
    case_id: z.string().min(1),
    target: z.string().min(1),
    source_sha256: digestSchema,
    source_width: z.number().int().positive(),
    source_height: z.number().int().positive(),
    status: z.string().min(1),
    selected_mask_path: z.string().min(1).nullable().optional(),
    selected_mask_sha256: digestSchema.nullable().optional(),
  })
  .passthrough()

const h8RunSchema = z
  .object({
    rows: z.array(h8RunRowSchema).length(12),
  })
  .passthrough()

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stratumFromCaseId(caseId: string): 'photo' | 'ui' | 'map' {
  if (caseId.startsWith('pilot-v03-photo-')) return 'photo'
  if (caseId.startsWith('pilot-v03-ui-')) return 'ui'
  if (caseId.startsWith('pilot-v03-map-')) return 'map'
  throw new Error('unknown-stratum')
}

async function loadEvaluatorProducerRows(
  repositoryRoot: string,
): Promise<JevNativeBoxProducerRow[]> {
  const rows: JevNativeBoxProducerRow[] = []
  for (const lock of JEV_NATIVE_BOX_MANIFEST_LOCKS) {
    const bytes = await readFile(join(repositoryRoot, lock.path))
    if (sha256Bytes(bytes) !== lock.sha256) throw new Error('producer-manifest-lock-hash-mismatch')
    const parsed = z.array(jevNativeBoxProducerRowSchema).parse(JSON.parse(bytes.toString('utf8')))
    rows.push(...parsed)
  }
  assertProducerInputOrder(rows)
  return rows
}

function validateRunManifestRowOrder(
  run: JevNativeBoxRunManifest,
): Map<string, JevNativeBoxRunManifest['rows'][number]> {
  if (run.rows.length !== JEV_NATIVE_BOX_EXPECTED_CASE_IDS.length)
    throw new Error('run-row-count-mismatch')
  const byCaseId = new Map<string, JevNativeBoxRunManifest['rows'][number]>()
  for (let index = 0; index < run.rows.length; index += 1) {
    const row = run.rows[index]!
    if (JEV_NATIVE_BOX_EXPECTED_CASE_IDS[index] !== row.caseId)
      throw new Error('run-order-mismatch')
    if (byCaseId.has(row.caseId)) throw new Error('run-duplicate-case')
    byCaseId.set(row.caseId, row)
  }
  return byCaseId
}

function validateTruthProducerFreezeJoin(
  truth: V03PilotTruth[],
  freeze: JevNativeBoxFreeze,
  producerRows: readonly JevNativeBoxProducerRow[],
): void {
  if (producerRows.length !== freeze.rows.length || truth.length !== freeze.rows.length)
    throw new Error('join-row-count')
  const producerByCaseId = new Map(producerRows.map((row) => [row.caseId, row]))
  for (let index = 0; index < freeze.rows.length; index += 1) {
    const freezeRow = freeze.rows[index]!
    const truthRow = truth[index]
    const producerRow = producerRows[index]
    if (!truthRow || truthRow.caseId !== freezeRow.caseId)
      throw new Error('truth-freeze-case-mismatch')
    if (!producerRow || producerRow.caseId !== freezeRow.caseId)
      throw new Error('producer-freeze-case-mismatch')
    const matchedProducer = producerByCaseId.get(freezeRow.caseId)
    if (!matchedProducer || matchedProducer !== producerRow)
      throw new Error('producer-case-id-map-mismatch')
    if (JEV_NATIVE_BOX_EXPECTED_CASE_IDS[index] !== freezeRow.caseId)
      throw new Error('expected-case-order-mismatch')
    if (truthRow.stratum !== stratumFromCaseId(freezeRow.caseId))
      throw new Error('truth-stratum-mismatch')
    if (truthRow.sourceCaseId.length === 0) throw new Error('truth-source-case-id-empty')
    if (producerRow.locate.target !== freezeRow.target)
      throw new Error('producer-freeze-target-mismatch')
    if (producerRow.image.path !== freezeRow.imagePath)
      throw new Error('producer-freeze-image-path-mismatch')
    if (producerRow.image.sha256 !== freezeRow.sourceSha256)
      throw new Error('producer-freeze-source-hash-mismatch')
    if (
      producerRow.image.width !== freezeRow.sourceWidth ||
      producerRow.image.height !== freezeRow.sourceHeight
    )
      throw new Error('producer-freeze-dimensions-mismatch')
    if (
      truthRow.imageSha256 !== freezeRow.sourceSha256 ||
      truthRow.sourceWidth !== freezeRow.sourceWidth ||
      truthRow.sourceHeight !== freezeRow.sourceHeight
    )
      throw new Error('truth-freeze-image-identity-mismatch')
  }
}

/** Builds RGBA overlay bytes for H8 foreground mask pixels (separate from bbox stroke). */
export function buildH8MaskOverlayRgba(bits: Uint8Array, width: number, height: number): Buffer {
  if (bits.length !== width * height) throw new Error('mask-dimensions')
  const overlay = Buffer.alloc(width * height * 4)
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] !== 1) continue
    const offset = index * 4
    overlay[offset] = 59
    overlay[offset + 1] = 130
    overlay[offset + 2] = 246
    overlay[offset + 3] = 140
  }
  return overlay
}

/** Evaluator-owned mapper; must not import producer geometry helpers. */
export function mapEvaluatorNormalizedBoxToSource(
  box: NormalizedProviderBox,
  transform: SourceImageTransformMetadata,
): Box {
  const { left, top, right, bottom } = box
  if (![left, top, right, bottom].every(Number.isFinite)) throw new Error('box-nonfinite')
  if (
    left < 0 ||
    top < 0 ||
    right < 0 ||
    bottom < 0 ||
    left > 1 ||
    top > 1 ||
    right > 1 ||
    bottom > 1
  )
    throw new Error('box-out-of-unit-range')
  if (!(left < right) || !(top < bottom)) throw new Error('box-unordered')
  if (right - left <= 0 || bottom - top <= 0) throw new Error('box-zero-area')

  const { output, content, scaleX, scaleY, source } = transform
  const canvasLeft = left * output.width
  const canvasTop = top * output.height
  const canvasRight = right * output.width
  const canvasBottom = bottom * output.height
  const contentRight = content.left + content.width
  const contentBottom = content.top + content.height
  if (
    canvasLeft < content.left ||
    canvasTop < content.top ||
    canvasRight > contentRight ||
    canvasBottom > contentBottom
  )
    throw new Error('box-padding-only')
  const sourceLeft = (canvasLeft - content.left) / scaleX
  const sourceTop = (canvasTop - content.top) / scaleY
  const sourceRight = (canvasRight - content.left) / scaleX
  const sourceBottom = (canvasBottom - content.top) / scaleY
  if (sourceLeft < 0 || sourceTop < 0 || sourceRight > source.width || sourceBottom > source.height)
    throw new Error('box-out-of-source')
  const width = sourceRight - sourceLeft
  const height = sourceBottom - sourceTop
  if (!(width > 0) || !(height > 0)) throw new Error('box-zero-area-source')
  return { left: sourceLeft, top: sourceTop, width, height }
}

function foregroundBounds(bits: Uint8Array, width: number, height: number): Box | null {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  let count = 0
  for (let index = 0; index < bits.length; index += 1) {
    const bit = bits[index]
    if (bit !== 0 && bit !== 1) throw new Error('mask-not-binary')
    if (bit === 0) continue
    count += 1
    const x = index % width
    const y = Math.floor(index / width)
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  if (count === 0) return null
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

async function decodeBinaryMaskPng(
  path: string,
  expectedSha256: string,
  width: number,
  height: number,
): Promise<{ bits: Uint8Array; foregroundPixels: number }> {
  const encoded = await readFile(path)
  if (sha256Bytes(encoded) !== expectedSha256) throw new Error('mask-hash-mismatch')
  const decoded = await sharp(encoded, { failOn: 'error' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (decoded.info.width !== width || decoded.info.height !== height)
    throw new Error('mask-dimensions')
  if (decoded.info.channels !== 1) throw new Error('mask-channel-count')
  const bits = new Uint8Array(width * height)
  let foregroundPixels = 0
  for (let index = 0; index < bits.length; index += 1) {
    const value = decoded.data[index]!
    if (value !== 0 && value !== 255) throw new Error('mask-not-binary-255')
    bits[index] = value === 255 ? 1 : 0
    if (bits[index] === 1) foregroundPixels += 1
  }
  return { bits, foregroundPixels }
}

async function loadH8Evaluation(
  repositoryRoot: string,
): Promise<z.infer<typeof h8EvaluationSchema>> {
  const path = resolve(repositoryRoot, JEV_NATIVE_BOX_H8A_EVALUATION_RELATIVE)
  const bytes = await readFile(path)
  if (sha256Bytes(bytes) !== JEV_NATIVE_BOX_H8A_EVALUATION_SHA256)
    throw new Error('h8a-evaluation-hash-mismatch')
  return h8EvaluationSchema.parse(JSON.parse(bytes.toString('utf8')))
}

async function loadH8Run(): Promise<z.infer<typeof h8RunSchema>> {
  const bytes = await readFile(JEV_NATIVE_BOX_H8A_RUN_PATH)
  if (sha256Bytes(bytes) !== JEV_NATIVE_BOX_H8A_RUN_SHA256) throw new Error('h8a-run-hash-mismatch')
  return h8RunSchema.parse(JSON.parse(bytes.toString('utf8')))
}

function validateTruthAndFreezeJoin(truth: V03PilotTruth[], freeze: JevNativeBoxFreeze): void {
  if (truth.length !== freeze.rows.length) throw new Error('truth-row-count')
  let positiveCount = 0
  let negativeCount = 0
  for (let index = 0; index < freeze.rows.length; index += 1) {
    const row = freeze.rows[index]!
    const truthRow = truth[index]
    if (!truthRow || truthRow.caseId !== row.caseId) throw new Error('truth-order-mismatch')
    if (JEV_NATIVE_BOX_EXPECTED_CASE_IDS[index] !== row.caseId)
      throw new Error('freeze-order-mismatch')
    if (
      truthRow.imageSha256 !== row.sourceSha256 ||
      truthRow.sourceWidth !== row.sourceWidth ||
      truthRow.sourceHeight !== row.sourceHeight
    )
      throw new Error('truth-image-identity-mismatch')
    if (truthRow.presence === 'present') positiveCount += 1
    else negativeCount += 1
  }
  if (positiveCount !== 9 || negativeCount !== 3) throw new Error('truth-stratum-count')
}

async function verifySourceClosureEntries(
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
  }
}

async function assertEvaluatorFrozenTransform(input: {
  dataRoot: string
  freezeRow: JevNativeBoxFreeze['rows'][number]
}): Promise<void> {
  const encodedPath = resolve(input.dataRoot, input.freezeRow.imagePath)
  const encodedBytes = new Uint8Array(await readFile(encodedPath))
  if (sha256Bytes(encodedBytes) !== input.freezeRow.sourceSha256)
    throw new Error('evaluator-source-hash-mismatch')
  const raster = createSharpRaster()
  const controller = new AbortController()
  const normalized = await raster.normalize(encodedBytes, controller.signal)
  if (
    normalized.width !== input.freezeRow.sourceWidth ||
    normalized.height !== input.freezeRow.sourceHeight
  )
    throw new Error('evaluator-source-dimensions-mismatch')
  encodedBytes.fill(0)
  const preparedState = await raster.imageState(normalized, controller.signal)
  const preparedImage = extractPreparedImagePart(preparedState)
  const transform = parseSourceImageTransformFromImageState(preparedState)
  const preparedDigest = sha256Bytes(
    Buffer.from(preparedImage.image_url.url.slice('data:image/png;base64,'.length), 'base64'),
  )
  if (preparedDigest !== input.freezeRow.preparedImageSha256)
    throw new Error('evaluator-prepared-image-hash-mismatch')
  if (
    transform.output.width !== input.freezeRow.preparedWidth ||
    transform.output.height !== input.freezeRow.preparedHeight
  )
    throw new Error('evaluator-prepared-dimensions-mismatch')
  if (hashCanonical(transform) !== hashCanonical(input.freezeRow.sourceImageTransform))
    throw new Error('evaluator-transform-mismatch')
  normalized.bytes.fill(0)
}

async function verifyManifestLocks(repositoryRoot: string): Promise<void> {
  for (const lock of JEV_NATIVE_BOX_MANIFEST_LOCKS) {
    const bytes = await readFile(join(repositoryRoot, lock.path))
    if (sha256Bytes(bytes) !== lock.sha256) throw new Error('manifest-lock-hash-mismatch')
  }
}

export const JEV_NATIVE_BOX_RECEIPT_COST_TOLERANCE_USD = 1e-9 as const

const BUDGET_TOLERANCE_USD = JEV_NATIVE_BOX_RECEIPT_COST_TOLERANCE_USD

function tryParseResponseEnvelopeForReceipt(raw: string): {
  usageCost: number | null
  model: string | null
  provider: string | null
} | null {
  try {
    return parseJevNativeBoxResponseEnvelope(raw)
  } catch {
    return null
  }
}

/** When a response body parses as an envelope, receipt and envelope usage costs must agree or both be unknown. */
export function validateParseableEnvelopeReceiptCostConsistency(
  receiptCostUsd: number | null,
  envelopeUsageCost: number | null,
  toleranceUsd: number = BUDGET_TOLERANCE_USD,
): void {
  const receiptKnown = receiptCostUsd !== null
  const envelopeKnown = envelopeUsageCost !== null
  if (!receiptKnown && !envelopeKnown) return
  if (receiptKnown !== envelopeKnown) throw new Error('usage-cost-mismatch')
  if (Math.abs(envelopeUsageCost! - receiptCostUsd!) > toleranceUsd)
    throw new Error('usage-cost-mismatch')
}

/** Skips cost audit when the body is not a parseable envelope (e.g. malformed protocol error JSON). */
export function validateReceiptResponseEnvelopeCostIfParseable(
  raw: string,
  receiptCostUsd: number | null,
): void {
  const envelope = tryParseResponseEnvelopeForReceipt(raw)
  if (envelope === null) return
  validateParseableEnvelopeReceiptCostConsistency(receiptCostUsd, envelope.usageCost)
}

/** Evaluator-only frozen request semantic audit (independent of producer-side helpers). */
export function validateEvaluatorFrozenRequestPayload(
  freezeRow: JevNativeBoxFreeze['rows'][number],
  payloadText: string,
): void {
  let json: unknown
  try {
    json = JSON.parse(payloadText)
  } catch {
    throw new Error('invalid-request-json')
  }
  const body = jevNativeBoxWireBodySchema.parse(json)
  if (body.state.length !== 2) throw new Error('state-length-mismatch')
  const imagePart = body.state[0]
  const targetLine = body.state[1]
  if (typeof imagePart === 'string' || imagePart.type !== 'image_url')
    throw new Error('missing-prepared-image')
  if (targetLine !== freezeRow.authoredTargetLine) throw new Error('authored-target-line-mismatch')
  if (targetLine !== authoredTargetStateLine(freezeRow.target))
    throw new Error('authored-target-content-mismatch')
  const questionsJson = JSON.stringify(body.questions)
  if (questionsJson.includes(freezeRow.target)) throw new Error('target-leaked-into-questions')
  if (body.questions.presence.instructions !== freezeRow.presenceInstructions)
    throw new Error('presence-instructions-mismatch')
  if (body.questions.object.instructions !== freezeRow.objectInstructions)
    throw new Error('object-instructions-mismatch')
  const url = imagePart.image_url.url
  if (!url.startsWith('data:image/png;base64,')) throw new Error('prepared-image-url-format')
  const embeddedDigest = sha256Bytes(
    Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'),
  )
  if (embeddedDigest !== freezeRow.preparedImageSha256)
    throw new Error('prepared-image-embedded-hash-mismatch')
}

/** Sync receipt/cardinality rules before artifact IO. */
export function validateRunManifestReceiptCardinality(run: JevNativeBoxRunManifest): void {
  if (run.physicalReceipts.length !== run.budget.admittedPhysicalCalls)
    throw new Error('physical-receipt-admitted-count-mismatch')
  if (run.budget.admittedPhysicalCalls > JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS)
    throw new Error('budget-admitted-exceeds-max')

  const sortedIds = run.physicalReceipts
    .map((item) => item.physicalId)
    .sort((left, right) => left - right)
  const idSet = new Set<number>()
  for (let index = 0; index < sortedIds.length; index += 1) {
    const id = sortedIds[index]!
    if (idSet.has(id)) throw new Error('physical-id-duplicate')
    idSet.add(id)
    if (id !== index + 1) throw new Error('physical-id-not-sequential')
  }

  for (const row of run.rows) {
    const receiptsForCase = run.physicalReceipts.filter((receipt) => receipt.caseId === row.caseId)
    if (receiptsForCase.length > 1) throw new Error('physical-receipt-per-row-mismatch')
    switch (row.status) {
      case 'not-run':
      case 'blocked':
        if (receiptsForCase.length > 0) throw new Error('no-call-row-has-receipt')
        break
      case 'resolved':
        if (receiptsForCase.length !== 1) throw new Error('resolved-row-receipt-mismatch')
        if (receiptsForCase[0]!.outcome !== 'resolved')
          throw new Error('resolved-row-nonresolved-receipt')
        break
      case 'transport-error':
        if (receiptsForCase.length !== 1) throw new Error('transport-row-receipt-mismatch')
        if (receiptsForCase[0]!.outcome !== 'transport-error')
          throw new Error('transport-row-receipt-outcome-mismatch')
        break
      case 'protocol-error':
        if (receiptsForCase.length > 1) throw new Error('protocol-row-receipt-overflow')
        if (receiptsForCase.length === 1 && receiptsForCase[0]!.outcome !== 'protocol-error')
          throw new Error('protocol-row-receipt-outcome-mismatch')
        break
      default:
        throw new Error('unknown-row-status')
    }
  }

  for (const receipt of run.physicalReceipts) {
    const row = run.rows.find((item) => item.caseId === receipt.caseId)
    if (!row) throw new Error('receipt-case-missing-from-run')
    if (row.status === 'resolved' && receipt.outcome !== 'resolved')
      throw new Error('receipt-row-resolved-outcome-mismatch')
    if (row.status === 'transport-error' && receipt.outcome !== 'transport-error')
      throw new Error('receipt-row-transport-outcome-mismatch')
    if (row.status === 'protocol-error' && receipt.outcome !== 'protocol-error')
      throw new Error('receipt-row-protocol-outcome-mismatch')
    if ((row.status === 'not-run' || row.status === 'blocked') && receipt.caseId === row.caseId)
      throw new Error('receipt-row-no-call-mismatch')
  }
}

function validateRunBudget(run: JevNativeBoxRunManifest): void {
  const { budget } = run
  if (budget.maxPhysicalCalls !== JEV_NATIVE_BOX_MAX_PHYSICAL_CALLS)
    throw new Error('budget-max-calls-mismatch')
  if (budget.maxCostUsd !== JEV_NATIVE_BOX_MAX_COST_USD) throw new Error('budget-max-cost-mismatch')
  if (budget.inFlightCalls !== 0) throw new Error('budget-in-flight-leftover')
  validateRunManifestReceiptCardinality(run)

  let known = 0
  let unknownCalls = 0
  for (const receipt of run.physicalReceipts) {
    if (receipt.costUsd === null) unknownCalls += 1
    else known += receipt.costUsd
  }
  if (budget.knownCostUsd + BUDGET_TOLERANCE_USD < known - BUDGET_TOLERANCE_USD)
    throw new Error('budget-known-cost-mismatch')
  if (budget.knownCostUsd > known + BUDGET_TOLERANCE_USD)
    throw new Error('budget-known-cost-mismatch')
  if (budget.unknownCostCalls !== unknownCalls)
    throw new Error('budget-unknown-cost-count-mismatch')

  const expectedExposure =
    budget.knownCostUsd + budget.unknownCostCalls * JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD
  if (Math.abs(budget.accountedExposureUsd - expectedExposure) > BUDGET_TOLERANCE_USD)
    throw new Error('budget-exposure-reconciliation-mismatch')
  if (budget.accountedExposureUsd > budget.maxCostUsd + BUDGET_TOLERANCE_USD)
    throw new Error('budget-exposure-exceeded')
}

async function verifyRunArtifacts(input: {
  run: JevNativeBoxRunManifest
  freeze: JevNativeBoxFreeze
  runDirectory: string
  freezeDirectory: string
}): Promise<void> {
  validateRunManifestRowOrder(input.run)
  validateRunManifestReceiptCardinality(input.run)

  for (const receipt of input.run.physicalReceipts) {
    const admissionPath = join(input.runDirectory, `physical-admission-${receipt.physicalId}.json`)
    const admissionBytes = await readFile(admissionPath)
    const admission = physicalAdmissionSchema.parse(JSON.parse(admissionBytes.toString('utf8')))
    if (
      admission.physicalId !== receipt.physicalId ||
      admission.caseId !== receipt.caseId ||
      admission.requestBodySha256 !== receipt.requestBodySha256
    )
      throw new Error('admission-receipt-mismatch')

    const requestPath = join(input.runDirectory, `request-body-${receipt.physicalId}.json`)
    const requestBytes = await readFile(requestPath)
    if (sha256Bytes(requestBytes) !== receipt.requestBodySha256)
      throw new Error('request-body-hash-mismatch')

    const freezeRow = input.freeze.rows.find((row) => row.caseId === receipt.caseId)
    if (!freezeRow) throw new Error('receipt-case-missing-from-freeze')
    if (receipt.requestBodySha256 !== freezeRow.requestBodySha256)
      throw new Error('receipt-request-hash-freeze-mismatch')

    const frozenPayloadPath = join(input.freezeDirectory, freezeRow.requestPayloadRelativePath)
    const frozenPayloadBytes = await readFile(frozenPayloadPath)
    if (sha256Bytes(frozenPayloadBytes) !== freezeRow.requestBodySha256)
      throw new Error('frozen-payload-hash-mismatch')
    if (!requestBytes.equals(frozenPayloadBytes)) throw new Error('request-body-bytes-mismatch')
    validateEvaluatorFrozenRequestPayload(freezeRow, frozenPayloadBytes.toString('utf8'))

    const receiptPath = join(input.runDirectory, `physical-receipt-${receipt.physicalId}.json`)
    const receiptBytes = await readFile(receiptPath)
    const receiptFile = physicalReceiptFileSchema.parse(JSON.parse(receiptBytes.toString('utf8')))
    if (JSON.stringify(receiptFile) !== JSON.stringify(receipt))
      throw new Error('receipt-file-mismatch')

    if (receipt.responseBodySha256) {
      const responsePath = join(input.runDirectory, `response-body-${receipt.physicalId}.json`)
      const responseBytes = await readFile(responsePath)
      if (responseBytes.byteLength > 1024 * 1024) throw new Error('response-body-limit')
      if (sha256Bytes(responseBytes) !== receipt.responseBodySha256)
        throw new Error('response-body-hash-mismatch')
      const raw = responseBytes.toString('utf8')
      if (receipt.outcome === 'resolved') {
        if (receipt.httpStatus === null || receipt.httpStatus < 200 || receipt.httpStatus >= 300)
          throw new Error('resolved-non-2xx')
        const envelope = parseJevNativeBoxResponseEnvelope(raw)
        validateParseableEnvelopeReceiptCostConsistency(receipt.costUsd, envelope.usageCost)
        const parsed = parseJevNativeBoxResponse(raw)
        const metadata = validateJevNativeBoxResponseMetadata(parsed)
        if (receipt.responseModel !== metadata.model)
          throw new Error('receipt-response-model-mismatch')
        if (receipt.responseProvider !== metadata.provider)
          throw new Error('receipt-response-provider-mismatch')
        if (
          !acceptsResponseModel(metadata.model, {
            model: input.freeze.route.model,
            responseModelIds: [],
          })
        )
          throw new Error('response-model-route-mismatch')
        if (
          unexpectedResponseProvider(metadata.provider, {
            provider: input.freeze.route.provider,
            providerName: input.freeze.route.providerName,
          })
        )
          throw new Error('response-provider-route-mismatch')
        const runRow = input.run.rows.find((row) => row.caseId === receipt.caseId)
        if (!runRow || runRow.status !== 'resolved')
          throw new Error('resolved-receipt-row-mismatch')
        if (runRow.presenceNoul !== parsed.answers.presence.noul)
          throw new Error('row-noul-mismatch')
        if (hashCanonical(runRow.rawBox) !== hashCanonical(parsed.answers.object.box))
          throw new Error('row-box-mismatch')
        if (runRow.responseBodySha256 !== receipt.responseBodySha256)
          throw new Error('row-response-hash-mismatch')
      } else {
        const envelope = tryParseResponseEnvelopeForReceipt(raw)
        if (envelope !== null) {
          validateParseableEnvelopeReceiptCostConsistency(receipt.costUsd, envelope.usageCost)
          if (
            receipt.responseModel !== null &&
            envelope.model !== null &&
            receipt.responseModel !== envelope.model
          )
            throw new Error('receipt-response-model-mismatch')
          if (
            receipt.responseProvider !== null &&
            envelope.provider !== null &&
            receipt.responseProvider !== envelope.provider
          )
            throw new Error('receipt-response-provider-mismatch')
        }
      }
    } else if (receipt.outcome === 'resolved') {
      throw new Error('resolved-receipt-missing-response-hash')
    }
  }
}

export interface JevInstanceDiagnostic {
  index: number
  iou: number
  coverage: number
  geometryGatePass: boolean
}

export interface JevNativeBoxEvaluationRow {
  caseId: string
  stratum: 'photo' | 'ui' | 'map'
  truthPresence: 'present' | 'absent'
  derivedPresence: 'present' | 'absent' | 'uncertain' | null
  jevRunStatus: JevNativeBoxRunManifest['rows'][number]['status']
  rawBox: NormalizedProviderBox | null
  rawBoxRetained: boolean
  sourceBox: Box | null
  geometryError: string | null
  geometryGatePass: boolean | null
  positiveTaskPass: boolean | null
  /** Back-compat alias for portable producer tests. */
  boxGatePass: boolean | null
  jevInstanceDiagnostics: JevInstanceDiagnostic[]
  jevNegativeOutcome:
    | 'present-false-output'
    | 'absent-correct'
    | 'uncertain'
    | 'error-or-no-call'
    | null
  h8aBoxGatePass: boolean | null
  h8aFalseOutput: boolean | null
  h8aMaskIoU: number | null
  h8SelectedMaskSha256: string | null
  h8SelectedMaskRelativePath: string | null
  h8MaskSourceWidth: number | null
  h8MaskSourceHeight: number | null
  h8MaskDerivedBox: Box | null
  h8InstanceDiagnostics: JevInstanceDiagnostic[]
  h8EvaluationCrossCheckFalseOutput: boolean | null
}

export type JevNativeBoxEvaluationCompletionStatus = 'complete' | 'partial'

export interface JevNativeBoxNegativeOutcomeSummary {
  negativeDenominator: 3
  presentFalseOutput: number
  absentCorrect: number
  uncertain: number
  errorOrNoCall: number
}

export interface JevNativeBoxStratumNegativeSummary {
  negativeDenominator: number
  presentFalseOutput: number
  absentCorrect: number
  uncertain: number
  errorOrNoCall: number
}

export interface JevNativeBoxEvaluation {
  schema: typeof JEV_NATIVE_BOX_EVALUATION_SCHEMA
  status: JevNativeBoxEvaluationCompletionStatus
  runStatus: JevNativeBoxRunManifest['status']
  phase: 'dev-exposed-pilot'
  freezeSha256: string
  runManifestSha256: string
  producerInputsSha256: typeof JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256
  truthSha256: typeof JEV_NATIVE_BOX_EVALUATOR_TRUTH_SHA256
  h8aRunSha256: typeof JEV_NATIVE_BOX_H8A_RUN_SHA256
  h8aEvaluationSha256: typeof JEV_NATIVE_BOX_H8A_EVALUATION_SHA256
  sourceClosureSha256Before: string
  sourceClosureSha256After: string
  jevNegativeSummary: JevNativeBoxNegativeOutcomeSummary
  summary: {
    positiveCount: 9
    negativeCount: 3
    jevPositiveTaskPasses: number
    jevGeometryPassesOnPositives: number
    h8aPositiveBoxGatePasses: number
    h8aNegativeFalseOutputs: number
    byStratum: Record<
      'photo' | 'ui' | 'map',
      {
        jevPositiveTaskPasses: number
        jevAbsentOrUncertain: number
        jevErrorsOrNoCall: number
        h8aPositiveBoxGatePasses: number
        h8aFalseOutputs: number
        jevNegativeSummary: JevNativeBoxStratumNegativeSummary
      }
    >
  }
  rows: JevNativeBoxEvaluationRow[]
}

function summarizeJevNegativeOutcomes(
  negativeRows: readonly JevNativeBoxEvaluationRow[],
): Omit<JevNativeBoxNegativeOutcomeSummary, 'negativeDenominator'> {
  return {
    presentFalseOutput: negativeRows.filter(
      (row) => row.jevNegativeOutcome === 'present-false-output',
    ).length,
    absentCorrect: negativeRows.filter((row) => row.jevNegativeOutcome === 'absent-correct').length,
    uncertain: negativeRows.filter((row) => row.jevNegativeOutcome === 'uncertain').length,
    errorOrNoCall: negativeRows.filter((row) => row.jevNegativeOutcome === 'error-or-no-call')
      .length,
  }
}

export async function reconstructH8Comparison(input: {
  truth: V03PilotTruth
  h8Row: z.infer<typeof h8RunRowSchema>
  freezeTarget: string
  dataRoot: string
  h8EvaluationFalseOutputs: readonly string[]
}): Promise<{
  h8aBoxGatePass: boolean | null
  h8aFalseOutput: boolean | null
  h8aMaskIoU: number | null
  h8SelectedMaskSha256: string | null
  h8SelectedMaskRelativePath: string | null
  h8MaskSourceWidth: number | null
  h8MaskSourceHeight: number | null
  h8MaskDerivedBox: Box | null
  h8InstanceDiagnostics: JevInstanceDiagnostic[]
  h8EvaluationCrossCheckFalseOutput: boolean | null
}> {
  if (input.h8Row.case_id !== input.truth.caseId) throw new Error('h8-case-id-mismatch')
  if (input.h8Row.source_sha256 !== input.truth.imageSha256)
    throw new Error('h8-source-hash-mismatch')
  if (
    input.h8Row.source_width !== input.truth.sourceWidth ||
    input.h8Row.source_height !== input.truth.sourceHeight
  )
    throw new Error('h8-source-dimensions-mismatch')
  if (input.h8Row.target !== input.freezeTarget) throw new Error('h8-target-mismatch')

  const runRoot = dirname(JEV_NATIVE_BOX_H8A_RUN_PATH)
  const crossCheckFalse = input.h8EvaluationFalseOutputs.includes(input.truth.caseId)

  const resolveContainedMaskPath = (maskPath: string): string => {
    if (isAbsolute(maskPath)) throw new Error('h8-mask-path-absolute')
    const resolved = resolve(runRoot, maskPath)
    const rel = relative(runRoot, resolved)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error('h8-mask-path-outside-run')
    return resolved
  }

  if (input.truth.presence === 'absent') {
    if (
      input.h8Row.status === 'located' &&
      input.h8Row.selected_mask_path &&
      input.h8Row.selected_mask_sha256
    ) {
      const resolved = resolveContainedMaskPath(input.h8Row.selected_mask_path)
      const rel = relative(runRoot, resolved)
      const { foregroundPixels } = await decodeBinaryMaskPng(
        resolved,
        input.h8Row.selected_mask_sha256,
        input.truth.sourceWidth,
        input.truth.sourceHeight,
      )
      const falseOutput = foregroundPixels > 0
      return {
        h8aBoxGatePass: null,
        h8aFalseOutput: falseOutput,
        h8aMaskIoU: null,
        h8SelectedMaskSha256: input.h8Row.selected_mask_sha256,
        h8SelectedMaskRelativePath: rel,
        h8MaskSourceWidth: input.truth.sourceWidth,
        h8MaskSourceHeight: input.truth.sourceHeight,
        h8MaskDerivedBox: null,
        h8InstanceDiagnostics: [],
        h8EvaluationCrossCheckFalseOutput: crossCheckFalse,
      }
    }
    return {
      h8aBoxGatePass: null,
      h8aFalseOutput: false,
      h8aMaskIoU: null,
      h8SelectedMaskSha256: null,
      h8SelectedMaskRelativePath: null,
      h8MaskSourceWidth: null,
      h8MaskSourceHeight: null,
      h8MaskDerivedBox: null,
      h8InstanceDiagnostics: [],
      h8EvaluationCrossCheckFalseOutput: crossCheckFalse,
    }
  }

  if (
    input.h8Row.status !== 'located' ||
    !input.h8Row.selected_mask_path ||
    !input.h8Row.selected_mask_sha256
  )
    return {
      h8aBoxGatePass: false,
      h8aFalseOutput: false,
      h8aMaskIoU: null,
      h8SelectedMaskSha256: input.h8Row.selected_mask_sha256 ?? null,
      h8SelectedMaskRelativePath: null,
      h8MaskSourceWidth: null,
      h8MaskSourceHeight: null,
      h8MaskDerivedBox: null,
      h8InstanceDiagnostics: [],
      h8EvaluationCrossCheckFalseOutput: crossCheckFalse,
    }

  const resolved = resolveContainedMaskPath(input.h8Row.selected_mask_path)
  const rel = relative(runRoot, resolved)
  const { bits, foregroundPixels } = await decodeBinaryMaskPng(
    resolved,
    input.h8Row.selected_mask_sha256,
    input.truth.sourceWidth,
    input.truth.sourceHeight,
  )
  if (foregroundPixels === 0)
    return {
      h8aBoxGatePass: false,
      h8aFalseOutput: false,
      h8aMaskIoU: null,
      h8SelectedMaskSha256: input.h8Row.selected_mask_sha256,
      h8SelectedMaskRelativePath: rel,
      h8MaskSourceWidth: input.truth.sourceWidth,
      h8MaskSourceHeight: input.truth.sourceHeight,
      h8MaskDerivedBox: null,
      h8InstanceDiagnostics: [],
      h8EvaluationCrossCheckFalseOutput: crossCheckFalse,
    }

  const maskBox = foregroundBounds(bits, input.truth.sourceWidth, input.truth.sourceHeight)
  if (!maskBox)
    return {
      h8aBoxGatePass: false,
      h8aFalseOutput: false,
      h8aMaskIoU: null,
      h8SelectedMaskSha256: input.h8Row.selected_mask_sha256,
      h8SelectedMaskRelativePath: rel,
      h8MaskSourceWidth: input.truth.sourceWidth,
      h8MaskSourceHeight: input.truth.sourceHeight,
      h8MaskDerivedBox: null,
      h8InstanceDiagnostics: [],
      h8EvaluationCrossCheckFalseOutput: crossCheckFalse,
    }

  const match = wholeObjectMatch(maskBox, input.truth.boxes)
  const h8InstanceDiagnostics = match.instances.map((item) => ({
    index: item.index,
    iou: item.iou,
    coverage: item.coverage,
    geometryGatePass: item.iou >= JEV_BOX_IOU_GATE && item.coverage >= JEV_BOX_COVERAGE_GATE,
  }))
  const h8aBoxGatePass = h8InstanceDiagnostics.some((item) => item.geometryGatePass)

  let h8aMaskIoU: number | null = null
  if (input.truth.caseId === 'pilot-v03-photo-02' && input.truth.referenceMasks[0]) {
    const reference = input.truth.referenceMasks[0]
    const referencePath = resolve(input.dataRoot, reference.path)
    const { bits: referenceBits } = await decodeBinaryMaskPng(
      referencePath,
      reference.sha256,
      input.truth.sourceWidth,
      input.truth.sourceHeight,
    )
    const maskIoU = binaryMaskIoU(bits, referenceBits)
    h8aMaskIoU = maskIoU.iou
    if (Math.abs(maskIoU.iou - JEV_NATIVE_BOX_PHOTO02_MASK_IOU) > 1e-9)
      throw new Error('photo02-mask-iou-mismatch')
  }

  return {
    h8aBoxGatePass,
    h8aFalseOutput: false,
    h8aMaskIoU,
    h8SelectedMaskSha256: input.h8Row.selected_mask_sha256,
    h8SelectedMaskRelativePath: rel,
    h8MaskSourceWidth: input.truth.sourceWidth,
    h8MaskSourceHeight: input.truth.sourceHeight,
    h8MaskDerivedBox: maskBox,
    h8InstanceDiagnostics,
    h8EvaluationCrossCheckFalseOutput: crossCheckFalse,
  }
}

export function scoreJevNativeBoxRow(input: {
  truth: V03PilotTruth
  freezeRow: JevNativeBoxFreeze['rows'][number]
  runRow: JevNativeBoxRunManifest['rows'][number] | undefined
  h8Comparison: Awaited<ReturnType<typeof reconstructH8Comparison>>
}): JevNativeBoxEvaluationRow {
  const { truth, freezeRow, runRow, h8Comparison } = input
  let derivedPresence: 'present' | 'absent' | 'uncertain' | null = null
  let sourceBox: Box | null = null
  let geometryError: string | null = null
  let geometryGatePass: boolean | null = null
  let positiveTaskPass: boolean | null = null
  let rawBoxRetained = false
  const jevInstanceDiagnostics: JevInstanceDiagnostic[] = []

  const jevRunStatus = runRow?.status ?? 'not-run'
  if (runRow?.rawBox) rawBoxRetained = true
  if (runRow?.presenceNoul !== null && runRow?.presenceNoul !== undefined)
    derivedPresence = mapNoulScoreToPresence(runRow.presenceNoul)

  if (truth.presence === 'present') {
    geometryGatePass = false
    positiveTaskPass = false
    if (runRow?.rawBox) {
      try {
        sourceBox = mapEvaluatorNormalizedBoxToSource(runRow.rawBox, freezeRow.sourceImageTransform)
        const match = wholeObjectMatch(sourceBox, truth.boxes)
        for (const item of match.instances) {
          jevInstanceDiagnostics.push({
            index: item.index,
            iou: item.iou,
            coverage: item.coverage,
            geometryGatePass:
              item.iou >= JEV_BOX_IOU_GATE && item.coverage >= JEV_BOX_COVERAGE_GATE,
          })
        }
        geometryGatePass = jevInstanceDiagnostics.some((item) => item.geometryGatePass)
        positiveTaskPass =
          jevRunStatus === 'resolved' && derivedPresence === 'present' && geometryGatePass === true
      } catch (error) {
        geometryError = error instanceof Error ? error.message : 'geometry-map-failed'
        sourceBox = null
        geometryGatePass = false
        positiveTaskPass = false
      }
    }
  }

  let jevNegativeOutcome: JevNativeBoxEvaluationRow['jevNegativeOutcome'] = null
  if (truth.presence === 'absent') {
    if (jevRunStatus === 'not-run' || jevRunStatus === 'blocked')
      jevNegativeOutcome = 'error-or-no-call'
    else if (jevRunStatus !== 'resolved') jevNegativeOutcome = 'error-or-no-call'
    else if (derivedPresence === 'present') jevNegativeOutcome = 'present-false-output'
    else if (derivedPresence === 'absent') jevNegativeOutcome = 'absent-correct'
    else jevNegativeOutcome = 'uncertain'
    if (runRow?.rawBox) {
      try {
        sourceBox = mapEvaluatorNormalizedBoxToSource(runRow.rawBox, freezeRow.sourceImageTransform)
      } catch (error) {
        geometryError = error instanceof Error ? error.message : 'geometry-map-failed'
        sourceBox = null
      }
    }
  }

  return {
    caseId: truth.caseId,
    stratum: stratumFromCaseId(truth.caseId),
    truthPresence: truth.presence,
    derivedPresence,
    jevRunStatus,
    rawBox: runRow?.rawBox ?? null,
    rawBoxRetained,
    sourceBox,
    geometryError,
    geometryGatePass,
    positiveTaskPass,
    boxGatePass: positiveTaskPass,
    jevInstanceDiagnostics,
    jevNegativeOutcome,
    h8aBoxGatePass: h8Comparison.h8aBoxGatePass,
    h8aFalseOutput: h8Comparison.h8aFalseOutput,
    h8aMaskIoU: h8Comparison.h8aMaskIoU,
    h8SelectedMaskSha256: h8Comparison.h8SelectedMaskSha256,
    h8SelectedMaskRelativePath: h8Comparison.h8SelectedMaskRelativePath,
    h8MaskSourceWidth: h8Comparison.h8MaskSourceWidth,
    h8MaskSourceHeight: h8Comparison.h8MaskSourceHeight,
    h8MaskDerivedBox: h8Comparison.h8MaskDerivedBox,
    h8InstanceDiagnostics: h8Comparison.h8InstanceDiagnostics,
    h8EvaluationCrossCheckFalseOutput: h8Comparison.h8EvaluationCrossCheckFalseOutput,
  }
}

async function loadH8MaskBitsForVisualRow(
  row: JevNativeBoxEvaluationRow,
): Promise<Uint8Array | null> {
  if (
    !row.h8SelectedMaskRelativePath ||
    !row.h8SelectedMaskSha256 ||
    row.h8MaskSourceWidth === null ||
    row.h8MaskSourceHeight === null
  )
    return null
  const runRoot = dirname(JEV_NATIVE_BOX_H8A_RUN_PATH)
  const resolved = resolve(runRoot, row.h8SelectedMaskRelativePath)
  const rel = relative(runRoot, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('visual-h8-mask-path-outside-run')
  const normalizedStored = row.h8SelectedMaskRelativePath.replaceAll('\\', '/')
  const normalizedResolved = rel.replaceAll('\\', '/')
  if (normalizedResolved !== normalizedStored) throw new Error('visual-h8-mask-path-mismatch')
  const { bits } = await decodeBinaryMaskPng(
    resolved,
    row.h8SelectedMaskSha256,
    row.h8MaskSourceWidth,
    row.h8MaskSourceHeight,
  )
  return bits
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function svgRect(box: Box, stroke: string, strokeWidth: number): string {
  return `<rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" />`
}

export async function writeJevNativeBoxVisualReport(input: {
  evaluation: JevNativeBoxEvaluation
  truth: V03PilotTruth[]
  freeze: JevNativeBoxFreeze
  dataRoot: string
  outputDirectory: string
}): Promise<void> {
  await mkdir(input.outputDirectory, { recursive: true })
  const cards: string[] = []

  for (let index = 0; index < input.evaluation.rows.length; index += 1) {
    const row = input.evaluation.rows[index]!
    const truthRow = input.truth[index]!
    const freezeRow = input.freeze.rows[index]!
    const sourcePath = resolve(input.dataRoot, freezeRow.imagePath)
    const sourceBytes = await readFile(sourcePath)
    if (sha256Bytes(sourceBytes) !== freezeRow.sourceSha256)
      throw new Error('overlay-source-hash-mismatch')

    const shapes: string[] = []
    if (truthRow.presence === 'present') {
      for (const box of truthRow.boxes) {
        shapes.push(svgRect(overlayRoundedBox(box), '#22c55e', 3))
      }
    }
    if (row.sourceBox) shapes.push(svgRect(overlayRoundedBox(row.sourceBox), '#ef4444', 3))
    if (row.h8MaskDerivedBox)
      shapes.push(svgRect(overlayRoundedBox(row.h8MaskDerivedBox), '#3b82f6', 2))

    const svg = `<svg width="${freezeRow.sourceWidth}" height="${freezeRow.sourceHeight}" xmlns="http://www.w3.org/2000/svg">${shapes.join('')}</svg>`
    const overlayName = `overlay-${row.caseId}.png`
    const overlayPath = join(input.outputDirectory, overlayName)
    const composites: sharp.OverlayOptions[] = []
    const maskBits = await loadH8MaskBitsForVisualRow(row)
    if (maskBits) {
      composites.push({
        input: buildH8MaskOverlayRgba(maskBits, freezeRow.sourceWidth, freezeRow.sourceHeight),
        raw: {
          width: freezeRow.sourceWidth,
          height: freezeRow.sourceHeight,
          channels: 4,
        },
        blend: 'over',
      })
    }
    composites.push({ input: Buffer.from(svg), blend: 'over' })
    await sharp(sourceBytes).composite(composites).png().toFile(overlayPath)

    const bestJev = row.jevInstanceDiagnostics.reduce<{ iou: number; coverage: number } | null>(
      (best, item) => {
        if (!best || item.iou > best.iou) return { iou: item.iou, coverage: item.coverage }
        return best
      },
      null,
    )

    cards.push(`<section class="card">
  <h2>${escapeHtml(row.caseId)}</h2>
  <p><strong>Источник SHA-256:</strong> <code>${escapeHtml(freezeRow.sourceSha256)}</code></p>
  <p><strong>H8a (исторический прогон):</strong> маска <code>${escapeHtml(row.h8SelectedMaskSha256 ?? '—')}</code>,
    рамка из маски IoU/покрытие ${row.h8InstanceDiagnostics.map((d) => `[${d.index}] IoU=${d.iou.toFixed(3)} cov=${d.coverage.toFixed(3)}`).join(', ') || '—'},
    ложный выход на отрицательном: ${row.h8aFalseOutput === true ? 'да' : 'нет'}</p>
  <p><strong>Jev native Box:</strong> Noul→${escapeHtml(row.derivedPresence ?? '—')}, статус ${escapeHtml(row.jevRunStatus)},
    геометрия ${row.geometryGatePass === true ? 'прошла порог' : row.geometryGatePass === false ? 'не прошла' : '—'},
    итог на положительном ${row.positiveTaskPass === true ? 'да' : 'нет'}${bestJev ? ` (лучший IoU=${bestJev.iou.toFixed(3)}, покрытие=${bestJev.coverage.toFixed(3)})` : ''}</p>
  <img src="${escapeHtml(overlayName)}" alt="${escapeHtml(row.caseId)}" />
  <p class="legend">Зелёный — эталонные рамки (только положительные). Голубая заливка — фактические пиксели foreground-маски H8a (бинарная 0/255). Синий контур — ограничивающая рамка, выведенная из той же маски (не подменяет маску). Красный — native Box Jev (рамка, не маска).${row.caseId === 'pilot-v03-photo-02' ? ` IoU маски H8a к пиксельной эталонной маке птицы: ${row.h8aMaskIoU?.toFixed(6) ?? '—'}.` : ''}</p>
</section>`)
  }

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Сравнение H8a и Jev native Box (DEV12)</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; line-height: 1.45; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
    img { max-width: 100%; height: auto; border: 1px solid #ddd; }
    .legend { font-size: 0.9rem; color: #444; }
    code { font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Сравнение H8a (исторический) и Jev native Box</h1>
  <p>Фаза: открытый DEV12-пилот. Это аудит по эталону, не выбор модели. H8a и Jev выполнялись в разное время — задержку и стоимость здесь не сравниваем.</p>
  <p>Freeze SHA-256: <code>${escapeHtml(input.evaluation.freezeSha256)}</code></p>
  ${cards.join('\n')}
</body>
</html>
`
  await writeFile(join(input.outputDirectory, 'comparison.html'), html, { flag: 'wx' })
}

export async function evaluateJevNativeBoxRun(input: {
  repositoryRoot: string
  freezePath: string
  runManifestPath: string
  dataRoot?: string
  writeVisualReport?: boolean
  visualOutputDirectory?: string
}): Promise<JevNativeBoxEvaluation> {
  const repositoryRoot = resolve(input.repositoryRoot)
  const freeze = await readJevNativeBoxFreeze(resolve(input.freezePath))
  if (freeze.profileId !== JEV_NATIVE_BOX_PROFILE_ID) throw new Error('profile-mismatch')
  if (freeze.producerInputsSha256 !== JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256)
    throw new Error('producer-inputs-mismatch')

  const runBytes = await readFile(resolve(input.runManifestPath))
  const runManifestSha256 = sha256Bytes(runBytes)
  const run = jevNativeBoxRunManifestSchema.parse(JSON.parse(runBytes.toString('utf8')))
  if (run.status === 'failed') throw new Error('run-failed-not-evaluable')
  if (run.profileId !== JEV_NATIVE_BOX_PROFILE_ID) throw new Error('run-profile-mismatch')
  if (run.freezeSha256 !== freeze.freezeSha256) throw new Error('run-freeze-mismatch')
  if (run.rows.length !== freeze.rows.length) throw new Error('run-row-count')
  const runRowsByCaseId = validateRunManifestRowOrder(run)

  await verifyManifestLocks(repositoryRoot)
  const producerRows = await loadEvaluatorProducerRows(repositoryRoot)
  if (producerRows.length !== freeze.rows.length) throw new Error('producer-freeze-row-count')
  await verifySourceClosureEntries(repositoryRoot, freeze.sourceClosure, freeze.sourceClosureSha256)
  if (run.sourceClosureSha256 !== freeze.sourceClosureSha256)
    throw new Error('run-source-closure-before-mismatch')
  const sourceClosureAfter = await hashJevNativeBoxSourceClosure(repositoryRoot)
  if (sourceClosureAfter.sha256 !== run.sourceClosureSha256After)
    throw new Error('source-closure-after-mismatch')
  if (freeze.h8aRunSha256 !== JEV_NATIVE_BOX_H8A_RUN_SHA256)
    throw new Error('freeze-h8-run-mismatch')
  if (freeze.h8aEvaluationSha256 !== JEV_NATIVE_BOX_H8A_EVALUATION_SHA256)
    throw new Error('freeze-h8-eval-mismatch')

  validateRunBudget(run)
  const runDirectory = dirname(resolve(input.runManifestPath))
  const freezeDirectory = resolve(run.freezeDirectory)
  await verifyRunArtifacts({ run, freeze, runDirectory, freezeDirectory })

  const truth = await loadV03PilotTruth()
  if (truth.length !== 12) throw new Error('truth-length')
  validateTruthAndFreezeJoin(truth, freeze)
  validateTruthProducerFreezeJoin(truth, freeze, producerRows)

  const h8Evaluation = await loadH8Evaluation(repositoryRoot)
  const h8Run = await loadH8Run()
  if (
    h8Run.rows.map((row) => row.case_id).join('\0') !== JEV_NATIVE_BOX_EXPECTED_CASE_IDS.join('\0')
  )
    throw new Error('h8-order-mismatch')
  const h8ByCase = new Map(h8Run.rows.map((item) => [item.case_id, item]))
  const dataRoot = resolve(input.dataRoot ?? run.dataRoot)

  const rows: JevNativeBoxEvaluationRow[] = []
  for (let index = 0; index < truth.length; index += 1) {
    const truthRow = truth[index]!
    const freezeRow = freeze.rows[index]!
    await assertEvaluatorFrozenTransform({ dataRoot, freezeRow })
    const h8Row = h8ByCase.get(truthRow.caseId)
    if (!h8Row) throw new Error('h8-row-missing')
    const h8Comparison = await reconstructH8Comparison({
      truth: truthRow,
      h8Row,
      freezeTarget: freezeRow.target,
      dataRoot,
      h8EvaluationFalseOutputs: h8Evaluation.negativeSummary.falseOutputs,
    })
    if (
      h8Comparison.h8EvaluationCrossCheckFalseOutput !== null &&
      h8Comparison.h8EvaluationCrossCheckFalseOutput !== h8Comparison.h8aFalseOutput
    )
      throw new Error('h8-evaluation-false-output-cross-check')
    rows.push(
      scoreJevNativeBoxRow({
        truth: truthRow,
        freezeRow,
        runRow: runRowsByCaseId.get(truthRow.caseId),
        h8Comparison,
      }),
    )
  }

  const positives = rows.filter((row) => row.truthPresence === 'present')
  const negatives = rows.filter((row) => row.truthPresence === 'absent')

  const h8aPositiveBoxGatePasses = positives.filter((row) => row.h8aBoxGatePass === true).length
  const h8aNegativeFalseOutputs = negatives.filter((row) => row.h8aFalseOutput === true).length
  if (h8aPositiveBoxGatePasses !== 7) throw new Error('h8a-positive-baseline-mismatch')
  if (h8aNegativeFalseOutputs !== 2) throw new Error('h8a-negative-baseline-mismatch')

  const byStratum = (['photo', 'ui', 'map'] as const).reduce(
    (accumulator, stratum) => {
      const stratumRows = rows.filter((row) => row.stratum === stratum)
      const stratumNegatives = stratumRows.filter((row) => row.truthPresence === 'absent')
      const stratumNegativeCounts = summarizeJevNegativeOutcomes(stratumNegatives)
      accumulator[stratum] = {
        jevPositiveTaskPasses: stratumRows.filter((row) => row.positiveTaskPass === true).length,
        jevAbsentOrUncertain: stratumRows.filter(
          (row) => row.derivedPresence === 'absent' || row.derivedPresence === 'uncertain',
        ).length,
        jevErrorsOrNoCall: stratumRows.filter(
          (row) => row.jevRunStatus !== 'resolved' || row.jevNegativeOutcome === 'error-or-no-call',
        ).length,
        h8aPositiveBoxGatePasses: stratumRows.filter((row) => row.h8aBoxGatePass === true).length,
        h8aFalseOutputs: stratumRows.filter((row) => row.h8aFalseOutput === true).length,
        jevNegativeSummary: {
          negativeDenominator: stratumNegatives.length,
          ...stratumNegativeCounts,
        },
      }
      return accumulator
    },
    {} as JevNativeBoxEvaluation['summary']['byStratum'],
  )

  const negativeSummaryCounts = summarizeJevNegativeOutcomes(negatives)
  const allRowsResolved =
    run.status === 'complete' && run.rows.every((row) => row.status === 'resolved')
  const evaluationStatus: JevNativeBoxEvaluationCompletionStatus = allRowsResolved
    ? 'complete'
    : 'partial'

  const evaluation: JevNativeBoxEvaluation = {
    schema: JEV_NATIVE_BOX_EVALUATION_SCHEMA,
    status: evaluationStatus,
    runStatus: run.status,
    phase: 'dev-exposed-pilot',
    freezeSha256: freeze.freezeSha256,
    runManifestSha256,
    producerInputsSha256: JEV_NATIVE_BOX_PRODUCER_INPUTS_SHA256,
    truthSha256: JEV_NATIVE_BOX_EVALUATOR_TRUTH_SHA256,
    h8aRunSha256: JEV_NATIVE_BOX_H8A_RUN_SHA256,
    h8aEvaluationSha256: JEV_NATIVE_BOX_H8A_EVALUATION_SHA256,
    sourceClosureSha256Before: run.sourceClosureSha256,
    sourceClosureSha256After: run.sourceClosureSha256After,
    jevNegativeSummary: {
      negativeDenominator: 3,
      ...negativeSummaryCounts,
    },
    summary: {
      positiveCount: 9,
      negativeCount: 3,
      jevPositiveTaskPasses: positives.filter((row) => row.positiveTaskPass === true).length,
      jevGeometryPassesOnPositives: positives.filter((row) => row.geometryGatePass === true).length,
      h8aPositiveBoxGatePasses,
      h8aNegativeFalseOutputs,
      byStratum,
    },
    rows,
  }

  if (input.writeVisualReport) {
    const visualDirectory = resolve(input.visualOutputDirectory ?? runDirectory)
    await writeJevNativeBoxVisualReport({
      evaluation,
      truth,
      freeze,
      dataRoot,
      outputDirectory: visualDirectory,
    })
  }

  return evaluation
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs({
    args: argv,
    options: {
      freeze: { type: 'string' },
      run: { type: 'string' },
      output: { type: 'string' },
      'data-root': { type: 'string' },
      'visual-report': { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (!args.values.freeze || !args.values.run || !args.values.output) {
    console.error(
      'Usage: node --import tsx benchmarks/v03/evaluate-jev-native-box.ts --freeze <path> --run <run-manifest.json> --output <directory> [--data-root <path>] [--visual-report]',
    )
    process.exitCode = 1
    return
  }
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const outputDirectory = resolve(args.values.output)
  await mkdir(outputDirectory, { recursive: true })
  const evaluation = await evaluateJevNativeBoxRun({
    repositoryRoot,
    freezePath: resolve(args.values.freeze),
    runManifestPath: resolve(args.values.run),
    ...(args.values['data-root'] ? { dataRoot: resolve(args.values['data-root']) } : {}),
    writeVisualReport: args.values['visual-report'] ?? false,
    visualOutputDirectory: outputDirectory,
  })
  await writeFile(
    join(outputDirectory, 'evaluation.json'),
    `${JSON.stringify(evaluation, null, 2)}\n`,
    { flag: 'wx' },
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'evaluation-failed')
    process.exitCode = 1
  })
}
