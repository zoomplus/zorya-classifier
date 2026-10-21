import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import { wholeObjectMatch, binaryMaskIoU } from '../v02/metrics.js'
import type { Box } from '../v02/metrics.js'
import { loadV03PilotTruth } from './evaluate-pilot.js'

export const H4A_OUTPUT_SHA256 = 'd1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1'
export const H4A_FREEZE_SHA256 = '30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753'

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const xyxySchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
])
const sizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

const h4cRowSchema = z
  .object({
    proposal_ordinal: z.number().int().nonnegative(),
    flat_index: z.number().int().nonnegative(),
    score: z.number().finite(),
    box_xyxy: xyxySchema,
    status: z.enum(['complete', 'error', 'timeout']).optional(),
    mask_path: z.string().min(1).optional(),
    mask_sha256: shaSchema.optional(),
    mask_bytes: z.number().int().positive().optional(),
    source_width: z.number().int().positive().optional(),
    source_height: z.number().int().positive().optional(),
    mask_pixel_area: z.number().int().nonnegative().optional(),
    empty: z.boolean().optional(),
    mask_box_xyxy: z.union([xyxySchema, z.null()]).optional(),
  })
  .passthrough()

const h4aCandidateSchema = z
  .object({
    flat_index: z.number().int().nonnegative(),
    score: z.number().finite(),
    box_canvas_xyxy: xyxySchema,
    box_xyxy: xyxySchema,
  })
  .passthrough()

const h4cRunSchema = z
  .object({
    state: z.enum(['complete', 'incomplete', 'failed', 'timeout']).optional(),
    status: z.enum(['complete', 'incomplete', 'failed', 'timeout']).optional(),
    results: z.array(z.unknown()),
    integrity_after: z.object({ unchanged: z.boolean() }).passthrough().optional(),
    source: z
      .object({ sha256: shaSchema, path: z.string().min(1).optional() })
      .passthrough()
      .optional(),
    h4a_output: z.object({ sha256: shaSchema }).passthrough(),
    h4a_freeze: z.object({ sha256: shaSchema }).passthrough(),
    candidate_count: z.number().int().positive(),
    protocol: z.record(z.string(), z.unknown()).optional(),
    model: z
      .object({ repo: z.string(), revision: z.string(), license: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough()

const h4aRunSchema = z
  .object({
    state: z.literal('complete'),
    integrity_after: z.object({ unchanged: z.literal(true) }).passthrough(),
    results: z
      .array(
        z
          .object({
            case_ids: z.array(z.string()).length(4),
            source: z.object({ sha256: shaSchema }).passthrough(),
            source_geometry: sizeSchema,
            transform: z
              .object({
                source_width: z.number().int().positive(),
                source_height: z.number().int().positive(),
                scale_x: z.number().positive(),
                scale_y: z.number().positive(),
                pad_left: z.number().finite(),
                pad_top: z.number().finite(),
              })
              .passthrough(),
            candidates: z.array(h4aCandidateSchema).length(36),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough()

export interface H4cCandidateAudit {
  proposalOrdinal: number
  flatIndex: number
  score: number
  promptBox: Box | null
  status: 'complete' | 'error' | 'timeout' | 'missing'
  artifactStatus: 'valid' | 'invalid' | 'missing'
  artifactError: string | null
  maskPath: string | null
  foregroundPixels: number | null
  maskBox: Box | null
  bestBoxIoU: number
  bestTargetCoverage: number
  wholeBoxPass: boolean
  referenceMaskIoUs: Array<{ reference: string; iou: number | null; error: string | null }>
}

export interface H4cCaseAudit {
  caseId: string
  presence: 'present' | 'absent'
  status: 'complete' | 'incomplete' | 'failed' | 'timeout'
  proposalCount: number
  validMaskCount: number
  emptyMaskCount: number
  invalidMaskCount: number
  boxAvailabilityPass: boolean
  bestMaskBoxIoU: number
  bestMaskBoxCoverage: number
  bestPixelMaskIoU: number | null
  referenceMaskCount: number
  evaluableReferenceMaskCount: number
  candidates: H4cCandidateAudit[]
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function toBox(xyxy: readonly number[], width: number, height: number): Box {
  const [left, top, right, bottom] = xyxy
  if (
    left === undefined ||
    top === undefined ||
    right === undefined ||
    bottom === undefined ||
    left < 0 ||
    top < 0 ||
    right <= left ||
    bottom <= top ||
    right > width ||
    bottom > height
  )
    throw new Error('box-outside-source-canvas')
  return { left, top, width: right - left, height: bottom - top }
}

function sameNumbers(left: readonly number[], right: readonly number[], tolerance = 1e-9): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - right[index]!) <= tolerance)
  )
}

function foregroundBounds(bits: Uint8Array, width: number, height: number): Box | null {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let index = 0; index < bits.length; index++) {
    const bit = bits[index]
    if (bit !== 0 && bit !== 1) throw new Error('mask-not-binary')
    if (bit === 0) continue
    const x = index % width
    const y = Math.floor(index / width)
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

function xyxy(box: Box | null): number[] | null {
  return box ? [box.left, box.top, box.left + box.width, box.top + box.height] : null
}

function isContained(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('mask-path-absolute')
  const resolved = resolve(root, path)
  const rel = relative(root, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('mask-path-outside-run')
  return resolved
}

async function decodeMask(
  runRoot: string,
  row: z.infer<typeof h4cRowSchema>,
  source: { width: number; height: number },
): Promise<{ bits: Uint8Array; box: Box | null; area: number }> {
  if (!row.mask_path || !row.mask_sha256) throw new Error('mask-receipt-missing')
  const path = isContained(runRoot, row.mask_path)
  const realRoot = await realpath(runRoot)
  const realMask = await realpath(path)
  const rel = relative(realRoot, realMask)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('mask-path-symlink-escape')
  const encoded = await readFile(realMask)
  if (digest(encoded) !== row.mask_sha256) throw new Error('mask-hash-mismatch')
  if (row.mask_bytes !== undefined && encoded.byteLength !== row.mask_bytes)
    throw new Error('mask-byte-size-mismatch')
  if (row.source_width !== source.width || row.source_height !== source.height)
    throw new Error('mask-source-geometry-receipt-mismatch')
  const meta = await sharp(encoded, { failOn: 'error' }).metadata()
  if (
    meta.format !== 'png' ||
    meta.width !== source.width ||
    meta.height !== source.height ||
    (meta.channels !== 1 && meta.channels !== 3) ||
    (meta.pages ?? 1) !== 1
  )
    throw new Error('mask-canvas-geometry-mismatch')
  const raw = await sharp(encoded, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true })
  if (
    raw.info.width !== source.width ||
    raw.info.height !== source.height ||
    raw.info.channels !== 3 ||
    raw.data.byteLength !== source.width * source.height * 3
  )
    throw new Error('mask-pixel-buffer-geometry-mismatch')
  const bits = new Uint8Array(source.width * source.height)
  let area = 0
  for (let index = 0; index < bits.length; index++) {
    const offset = index * 3
    const value = raw.data[offset]
    if (value !== 0 && value !== 255) throw new Error('mask-pixels-not-binary-0-255')
    if (raw.data[offset + 1] !== value || raw.data[offset + 2] !== value)
      throw new Error('mask-rgb-channels-differ')
    const bit = value === 255 ? 1 : 0
    bits[index] = bit
    area += bit
  }
  const box = foregroundBounds(bits, source.width, source.height)
  if (row.mask_pixel_area !== undefined && row.mask_pixel_area !== area)
    throw new Error('mask-pixel-area-descriptor-mismatch')
  if (row.empty !== undefined && row.empty !== (area === 0))
    throw new Error('mask-empty-descriptor-mismatch')
  if (row.mask_box_xyxy !== undefined) {
    const bounds = xyxy(box)
    if (
      bounds === null
        ? row.mask_box_xyxy !== null
        : !row.mask_box_xyxy || !sameNumbers(row.mask_box_xyxy, bounds, 0)
    )
      throw new Error('mask-box-descriptor-mismatch')
  }
  return { bits, box, area }
}

async function loadReferenceMask(
  imageRoot: string,
  reference: { path: string; sha256: string; width: number; height: number; resampling: string },
  source: { width: number; height: number },
): Promise<Uint8Array> {
  const bytes = await readFile(resolve(imageRoot, reference.path))
  if (digest(bytes) !== reference.sha256) throw new Error('reference-mask-hash-mismatch')
  if (
    reference.resampling !==
    'nearest-neighbor to the acquired Open Images JPEG raster; verified 0/255 binary values'
  )
    throw new Error('unsupported-reference-mask-resampling')
  const raw = await sharp(bytes, { failOn: 'error' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (
    raw.info.width !== reference.width ||
    raw.info.height !== reference.height ||
    raw.info.channels !== 1 ||
    raw.data.byteLength !== reference.width * reference.height
  )
    throw new Error('reference-mask-geometry-mismatch')
  const sourceBits = new Uint8Array(raw.data.byteLength)
  for (let index = 0; index < raw.data.byteLength; index++) {
    const value = raw.data[index]
    if (value !== 0 && value !== 255) throw new Error('reference-mask-not-binary-0-255')
    sourceBits[index] = value === 255 ? 1 : 0
  }
  if (reference.width === source.width && reference.height === source.height) return sourceBits
  const resized = await sharp(Buffer.from(sourceBits), {
    raw: { width: reference.width, height: reference.height, channels: 1 },
  })
    .resize(source.width, source.height, { kernel: 'nearest' })
    .raw()
    .toBuffer()
  if (resized.length !== source.width * source.height)
    throw new Error('reference-mask-resampling-failed')
  const result = new Uint8Array(resized.length)
  for (let index = 0; index < resized.length; index++) {
    const value = resized[index]
    if (value !== 0 && value !== 1) throw new Error('resampled-reference-mask-not-binary')
    result[index] = value
  }
  return result
}

function assertH4aSourceBoxes(record: unknown, expectedSha256: string, actualSha256: string) {
  if (actualSha256 !== expectedSha256 || expectedSha256 !== H4A_OUTPUT_SHA256)
    throw new Error('H4a output receipt does not match the frozen box-screen hash')
  const run = h4aRunSchema.parse(record)
  const sourceResult = run.results[0]!
  const width = sourceResult.source_geometry.width
  const height = sourceResult.source_geometry.height
  if (
    sourceResult.source.sha256 !==
    '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09'
  )
    throw new Error('H4a source identity changed')
  const transform = sourceResult.transform
  if (transform.source_width !== width || transform.source_height !== height)
    throw new Error('H4a transform source dimensions mismatch')
  for (const [index, candidate] of sourceResult.candidates.entries()) {
    const [left, top, right, bottom] = candidate.box_canvas_xyxy
    const recovered = [
      Math.min(Math.max((left - transform.pad_left) / transform.scale_x, 0), width),
      Math.min(Math.max((top - transform.pad_top) / transform.scale_y, 0), height),
      Math.min(Math.max((right - transform.pad_left) / transform.scale_x, 0), width),
      Math.min(Math.max((bottom - transform.pad_top) / transform.scale_y, 0), height),
    ]
    if (!sameNumbers(recovered, candidate.box_xyxy))
      throw new Error(`H4a candidate source-coordinate transform mismatch at ${index}`)
    toBox(candidate.box_xyxy, width, height)
  }
  return { run, result: sourceResult, width, height }
}

export interface EvaluateH4cInput {
  h4aRecord: unknown
  h4aRunSha256: string
  expectedH4aRunSha256: string
  h4aFreezeSha256: string
  expectedH4aFreezeSha256: string
  h4cRecord: unknown
  h4cRunSha256: string
  expectedH4cRunSha256: string
  h4cFreezeRecord: unknown
  h4cFreezeSha256: string
  expectedH4cFreezeSha256: string
  rows: readonly unknown[]
  truth: readonly Awaited<ReturnType<typeof loadV03PilotTruth>>[number][]
  runRoot: string
  imageRoot: string
}

function validateH4cLock(
  input: EvaluateH4cInput,
  h4aCandidates: readonly z.infer<typeof h4aCandidateSchema>[],
) {
  if (
    input.h4aFreezeSha256 !== input.expectedH4aFreezeSha256 ||
    input.h4aFreezeSha256 !== H4A_FREEZE_SHA256
  )
    throw new Error('H4a pre-inference freeze hash mismatch')
  if (
    input.h4cRunSha256 !== input.expectedH4cRunSha256 ||
    !shaSchema.safeParse(input.expectedH4cRunSha256).success
  )
    throw new Error('External H4c run.json hash lock mismatch')
  if (
    input.h4cFreezeSha256 !== input.expectedH4cFreezeSha256 ||
    !shaSchema.safeParse(input.expectedH4cFreezeSha256).success
  )
    throw new Error('External H4c freeze.json hash lock mismatch')
  const run = h4cRunSchema.parse(input.h4cRecord)
  if ((run.state ?? run.status) !== 'complete')
    throw new Error('H4c run must be closed and complete')
  if (run.candidate_count !== 36)
    throw new Error('H4c run does not report the frozen 36-prompt cohort')
  if (run.integrity_after?.unchanged !== true)
    throw new Error('H4c producer integrity check is not clean')
  if (run.h4a_output.sha256 !== H4A_OUTPUT_SHA256 || run.h4a_freeze.sha256 !== H4A_FREEZE_SHA256)
    throw new Error('H4c run does not bind the frozen H4a source artifacts')
  if (run.source?.sha256 !== '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09')
    throw new Error('H4c run source image identity mismatch')
  if (
    run.protocol?.clip_to_box !== false ||
    run.protocol?.multimask_output !== false ||
    run.protocol?.image_encoding_calls !== 1 ||
    run.protocol?.prompt_count !== 36 ||
    run.protocol?.mask_frame !== 'full original source' ||
    run.protocol?.order !== 'frozen H4a candidate order'
  )
    throw new Error('H4c run protocol differs from the frozen one-box/one-mask recipe')
  if (
    run.model?.repo !== 'facebook/sam2-hiera-tiny' ||
    run.model.revision !== '7c218beaf0bb87874785f32b582f640134fc1c09' ||
    run.model.license !== 'Apache-2.0'
  )
    throw new Error('H4c run model identity differs from the pinned SAM2 checkpoint')
  const freeze = input.h4cFreezeRecord as Record<string, unknown>
  if (!freeze || typeof freeze !== 'object') throw new Error('H4c freeze record is invalid')
  const freezeRecord = freeze as {
    state?: string
    h4a_output?: { sha256?: string }
    h4a_freeze?: { sha256?: string }
    source?: { sha256?: string }
    proposals?: unknown[]
    recipe?: Record<string, unknown>
    producer?: { sha256?: string }
    model?: { repo?: string; revision?: string; license?: string }
  }
  if (
    freezeRecord.state !== 'frozen-before-inference' ||
    freezeRecord.h4a_output?.sha256 !== H4A_OUTPUT_SHA256 ||
    freezeRecord.h4a_freeze?.sha256 !== H4A_FREEZE_SHA256 ||
    freezeRecord.source?.sha256 !==
      '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09' ||
    freezeRecord.recipe?.clip_to_box !== false ||
    freezeRecord.recipe?.ordered_box_prompts !== 36 ||
    freezeRecord.recipe?.image_encoding_calls !== 1 ||
    freezeRecord.recipe?.multimask_output !== false ||
    freezeRecord.recipe?.mask_frame !== 'full original source' ||
    freezeRecord.producer?.sha256 !==
      '94ad6b131f077a4f954443063ba945c8141f64ba56b737c420a805ca4bee68da' ||
    freezeRecord.model?.repo !== 'facebook/sam2-hiera-tiny' ||
    freezeRecord.model?.revision !== '7c218beaf0bb87874785f32b582f640134fc1c09' ||
    freezeRecord.model?.license !== 'Apache-2.0' ||
    freezeRecord.proposals?.length !== 36
  )
    throw new Error('H4c freeze does not bind the frozen H4a proposal list and source')
  const frozenProposals = freezeRecord.proposals as Array<{
    proposal_ordinal?: number
    flat_index?: number
    score?: number
    box_xyxy?: number[]
  }>
  for (let ordinal = 0; ordinal < 36; ordinal++) {
    const proposal = frozenProposals[ordinal]
    const candidate = h4aCandidates[ordinal]
    if (!candidate) throw new Error(`Missing H4a candidate at ordinal ${ordinal}`)
    if (
      proposal?.proposal_ordinal !== ordinal ||
      proposal.flat_index !== candidate.flat_index ||
      proposal.score !== candidate.score ||
      !proposal.box_xyxy ||
      !sameNumbers(proposal.box_xyxy, candidate.box_xyxy)
    )
      throw new Error(`H4c pre-inference freeze proposal mismatch at ordinal ${ordinal}`)
  }
  return run
}

/** H4c candidate-mask availability ceiling; never treats proposals as classification. */
export async function evaluateH4cMaskAvailability(input: EvaluateH4cInput) {
  const h4a = assertH4aSourceBoxes(input.h4aRecord, input.expectedH4aRunSha256, input.h4aRunSha256)
  const run = validateH4cLock(input, h4a.result.candidates)
  if (input.rows.length !== 36)
    throw new Error('H4c must retain one visible result row for each of 36 proposals')
  const truth = input.truth.filter((item) => h4a.result.case_ids.includes(item.caseId))
  if (truth.length !== 4 || new Set(truth.map((item) => item.caseId)).size !== 4)
    throw new Error('H4c truth join must contain the four fixed UI queries')
  if (
    truth.some(
      (item) =>
        item.imageSha256 !== h4a.result.source.sha256 ||
        item.sourceWidth !== h4a.width ||
        item.sourceHeight !== h4a.height,
    )
  )
    throw new Error('H4c source and evaluator truth identity mismatch')
  const parsedRows = new Map<number, z.infer<typeof h4cRowSchema>>()
  const rowErrors: string[] = []
  for (const raw of input.rows) {
    const parsed = h4cRowSchema.safeParse(raw)
    if (!parsed.success) {
      rowErrors.push('invalid-h4c-row-schema')
      continue
    }
    const row = parsed.data
    if (parsedRows.has(row.proposal_ordinal)) {
      rowErrors.push(`duplicate-proposal-ordinal:${row.proposal_ordinal}`)
      continue
    }
    parsedRows.set(row.proposal_ordinal, row)
  }
  const candidates = [] as Array<{
    ordinal: number
    h4aBox: Box
    row: z.infer<typeof h4cRowSchema> | undefined
    status: H4cCandidateAudit['status']
    artifactStatus: H4cCandidateAudit['artifactStatus']
    artifactError: string | null
    maskBits?: Uint8Array
    maskBox: Box | null
    foregroundPixels: number | null
  }>
  for (let ordinal = 0; ordinal < 36; ordinal++) {
    const sourceCandidate = h4a.result.candidates[ordinal]!
    const h4aBox = toBox(sourceCandidate.box_xyxy, h4a.width, h4a.height)
    const row = parsedRows.get(ordinal)
    if (!row) {
      candidates.push({
        ordinal,
        h4aBox,
        row: undefined,
        status: 'missing',
        artifactStatus: 'missing',
        artifactError: 'missing-h4c-row',
        maskBox: null,
        foregroundPixels: null,
      })
      continue
    }
    if (
      row.flat_index !== sourceCandidate.flat_index ||
      row.score !== sourceCandidate.score ||
      !sameNumbers(row.box_xyxy, sourceCandidate.box_xyxy)
    ) {
      candidates.push({
        ordinal,
        h4aBox,
        row,
        status: row.status ?? 'error',
        artifactStatus: 'invalid',
        artifactError: 'h4a-candidate-identity-mismatch',
        maskBox: null,
        foregroundPixels: null,
      })
      continue
    }
    if (row.status && row.status !== 'complete') {
      candidates.push({
        ordinal,
        h4aBox,
        row,
        status: row.status,
        artifactStatus: 'missing',
        artifactError: null,
        maskBox: null,
        foregroundPixels: null,
      })
      continue
    }
    try {
      const mask = await decodeMask(input.runRoot, row, { width: h4a.width, height: h4a.height })
      candidates.push({
        ordinal,
        h4aBox,
        row,
        status: 'complete',
        artifactStatus: 'valid',
        artifactError: null,
        maskBits: mask.bits,
        maskBox: mask.box,
        foregroundPixels: mask.area,
      })
    } catch (error) {
      candidates.push({
        ordinal,
        h4aBox,
        row,
        status: 'complete',
        artifactStatus: 'invalid',
        artifactError: error instanceof Error ? error.message : 'mask-artifact-invalid',
        maskBox: null,
        foregroundPixels: null,
      })
    }
  }
  const perCase: H4cCaseAudit[] = []
  for (const item of truth) {
    const boxes = item.presence === 'present' ? item.boxes : []
    const candidateAudit: H4cCandidateAudit[] = []
    let bestPixelMaskIoU: number | null = null
    for (const candidate of candidates) {
      const maskBox = candidate.maskBox
      let bestBoxIoU = 0
      let bestTargetCoverage = 0
      let wholeBoxPass = false
      if (maskBox && boxes.length > 0) {
        const scored = wholeObjectMatch(maskBox, boxes).instances
        bestBoxIoU = Math.max(...scored.map((score) => score.iou))
        bestTargetCoverage = Math.max(...scored.map((score) => score.coverage))
        wholeBoxPass = scored.some((score) => score.matched)
      }
      const referenceMaskIoUs: H4cCandidateAudit['referenceMaskIoUs'] = []
      if (candidate.maskBits && item.referenceMasks.length > 0) {
        for (const reference of item.referenceMasks) {
          try {
            const referenceBits = await loadReferenceMask(input.imageRoot, reference, {
              width: h4a.width,
              height: h4a.height,
            })
            const score = binaryMaskIoU(candidate.maskBits, referenceBits)
            bestPixelMaskIoU = Math.max(bestPixelMaskIoU ?? 0, score.iou)
            referenceMaskIoUs.push({ reference: reference.path, iou: score.iou, error: null })
          } catch (error) {
            referenceMaskIoUs.push({
              reference: reference.path,
              iou: null,
              error: error instanceof Error ? error.message : 'reference-mask-invalid',
            })
          }
        }
      }
      candidateAudit.push({
        proposalOrdinal: candidate.ordinal,
        flatIndex:
          candidate.row?.flat_index ?? h4a.result.candidates[candidate.ordinal]!.flat_index,
        score: candidate.row?.score ?? h4a.result.candidates[candidate.ordinal]!.score,
        promptBox: candidate.h4aBox,
        status: candidate.status,
        artifactStatus: candidate.artifactStatus,
        artifactError: candidate.artifactError,
        maskPath: candidate.row?.mask_path ?? null,
        foregroundPixels: candidate.foregroundPixels,
        maskBox,
        bestBoxIoU,
        bestTargetCoverage,
        wholeBoxPass,
        referenceMaskIoUs,
      })
    }
    perCase.push({
      caseId: item.caseId,
      presence: item.presence,
      status: (run.state ?? run.status) as H4cCaseAudit['status'],
      proposalCount: candidateAudit.length,
      validMaskCount: candidateAudit.filter((candidate) => candidate.artifactStatus === 'valid')
        .length,
      emptyMaskCount: candidateAudit.filter(
        (candidate) => candidate.artifactStatus === 'valid' && candidate.foregroundPixels === 0,
      ).length,
      invalidMaskCount: candidateAudit.filter((candidate) => candidate.artifactStatus === 'invalid')
        .length,
      boxAvailabilityPass:
        item.presence === 'present' && candidateAudit.some((candidate) => candidate.wholeBoxPass),
      bestMaskBoxIoU: Math.max(0, ...candidateAudit.map((candidate) => candidate.bestBoxIoU)),
      bestMaskBoxCoverage: Math.max(
        0,
        ...candidateAudit.map((candidate) => candidate.bestTargetCoverage),
      ),
      bestPixelMaskIoU,
      referenceMaskCount: item.referenceMasks.length,
      evaluableReferenceMaskCount: new Set(
        candidateAudit.flatMap((candidate) =>
          candidate.referenceMaskIoUs
            .filter((score) => score.error === null)
            .map((score) => score.reference),
        ),
      ).size,
      candidates: candidateAudit,
    })
  }
  const positives = perCase.filter((item) => item.presence === 'present')
  const negatives = perCase.filter((item) => item.presence === 'absent')
  return {
    schema: 'v03-h4c-sam2-ui-mask-availability-v1',
    evaluationType: 'oracle-candidate-mask-availability-ceiling',
    productionResult: false,
    negativeCandidateSemantics:
      'candidate masks are availability only; no false-positive judgment without semantic selection',
    h4aRunSha256: input.h4aRunSha256,
    h4aFreezeSha256: input.h4aFreezeSha256,
    h4cRunSha256: input.h4cRunSha256,
    h4cFreezeSha256: input.h4cFreezeSha256,
    h4cStatus: run.state ?? run.status,
    plannedCases: perCase.length,
    positives: positives.length,
    negatives: negatives.length,
    positiveBoxAvailabilityPasses: positives.filter((item) => item.boxAvailabilityPass).length,
    positiveBoxAvailabilityRate:
      positives.length === 0
        ? null
        : positives.filter((item) => item.boxAvailabilityPass).length / positives.length,
    negativesWithMaskCandidates: negatives.filter((item) => item.validMaskCount > 0).length,
    validMasksOnNegatives: negatives.reduce((sum, item) => sum + item.validMaskCount, 0),
    failedOrMissingRows: candidates.filter((candidate) => candidate.status !== 'complete').length,
    invalidMasks: candidates.filter((candidate) => candidate.artifactStatus === 'invalid').length,
    emptyMasks: candidates.filter(
      (candidate) => candidate.artifactStatus === 'valid' && candidate.foregroundPixels === 0,
    ).length,
    rowErrors,
    strata: {
      ui: {
        positiveCases: positives.length,
        positiveBoxAvailabilityPasses: positives.filter((item) => item.boxAvailabilityPass).length,
        negativeCases: negatives.length,
        negativeCasesWithMasks: negatives.filter((item) => item.validMaskCount > 0).length,
      },
    },
    perCase,
  }
}

export async function loadAndEvaluateH4c(args: {
  runRoot: string
  h4aOutputPath: string
  h4aFreezePath: string
  imageRoot: string
  h4aRunSha256: string
  h4aFreezeSha256: string
  h4cRunSha256: string
  h4cFreezeSha256: string
}) {
  const runRoot = await realpath(args.runRoot)
  const h4aOutputBytes = await readFile(args.h4aOutputPath)
  const h4aFreezeBytes = await readFile(args.h4aFreezePath)
  const runBytes = await readFile(resolve(runRoot, 'run.json'))
  const freezeBytes = await readFile(resolve(runRoot, 'freeze.json'))
  const hashes = {
    h4aRunSha256: digest(h4aOutputBytes),
    h4aFreezeSha256: digest(h4aFreezeBytes),
    h4cRunSha256: digest(runBytes),
    h4cFreezeSha256: digest(freezeBytes),
  }
  const h4aRunSha256 = args.h4aRunSha256
  const h4aFreezeSha256 = args.h4aFreezeSha256
  const h4cRecord = JSON.parse(runBytes.toString('utf8')) as unknown
  const h4cFreezeRecord = JSON.parse(freezeBytes.toString('utf8')) as unknown
  const runParsed = h4cRunSchema.parse(h4cRecord)
  const rows = runParsed.results
  if (!runParsed.source?.path) throw new Error('H4c run is missing its source file receipt')
  const sourceBytes = await readFile(runParsed.source.path)
  if (digest(sourceBytes) !== runParsed.source.sha256)
    throw new Error('H4c source file hash mismatch')
  const h4aRecord = JSON.parse(h4aOutputBytes.toString('utf8')) as unknown
  const truth = await loadV03PilotTruth()
  const report = await evaluateH4cMaskAvailability({
    h4aRecord,
    h4aRunSha256,
    expectedH4aRunSha256: H4A_OUTPUT_SHA256,
    h4aFreezeSha256,
    expectedH4aFreezeSha256: H4A_FREEZE_SHA256,
    h4cRecord,
    h4cRunSha256: hashes.h4cRunSha256,
    expectedH4cRunSha256: args.h4cRunSha256,
    h4cFreezeRecord,
    h4cFreezeSha256: hashes.h4cFreezeSha256,
    expectedH4cFreezeSha256: args.h4cFreezeSha256,
    rows,
    truth,
    runRoot,
    imageRoot: args.imageRoot,
  })
  return report
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!
    if (key.startsWith('--') && argv[index + 1] && !argv[index + 1]!.startsWith('--'))
      values.set(key.slice(2), argv[++index]!)
    else throw new Error(`Invalid argument ${key}`)
  }
  const required = [
    'run',
    'run-sha256',
    'freeze-sha256',
    'h4a-run',
    'h4a-sha256',
    'h4a-freeze',
    'h4a-freeze-sha256',
    'image-root',
    'output',
  ]
  if (required.some((name) => !values.has(name)))
    throw new Error(`Required arguments: ${required.join(', ')}`)
  return {
    runRoot: resolve(values.get('run')!),
    h4cRunSha256: values.get('run-sha256')!,
    h4cFreezeSha256: values.get('freeze-sha256')!,
    h4aOutputPath: resolve(values.get('h4a-run')!),
    h4aRunSha256: values.get('h4a-sha256')!,
    h4aFreezePath: resolve(values.get('h4a-freeze')!),
    h4aFreezeSha256: values.get('h4a-freeze-sha256')!,
    imageRoot: resolve(values.get('image-root')!),
    output: resolve(values.get('output')!),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  loadAndEvaluateH4c(args)
    .then(async (report) => {
      await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
      process.stdout.write(`${JSON.stringify({ output: args.output, status: report.h4cStatus })}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'H4c evaluator failed'}\n`)
      process.exitCode = 1
    })
}
