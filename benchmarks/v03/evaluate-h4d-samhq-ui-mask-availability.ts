import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { wholeObjectMatch } from '../v02/metrics.js'
import type { Box } from '../v02/metrics.js'
import { loadV03PilotTruth } from './evaluate-pilot.js'

export const H4D_RUN_SHA256 = '704a7075e33b4bcc3806e15bb166cb8d088cdc1fbd2c984660c099634618f2b8'
export const H4D_FREEZE_SHA256 = 'd0fdf93348a809ad8f01eb6cf6152958baad57e4d8670ae9c9590076d6cb96e6'
export const H4D_RUN_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4d-samhq-ui-box-refinement-sequential-v2'
export const H4A_RUN_SHA256 = 'd1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1'
export const H4A_FREEZE_SHA256 = '30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boxSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
])
const runSchema = z
  .object({
    state: z.literal('complete'),
    candidate_count: z.literal(36),
    integrity_after: z.object({ unchanged: z.literal(true) }).passthrough(),
    h4a_output: z.object({ path: z.string(), sha256: hashSchema }),
    h4a_freeze: z.object({ path: z.string(), sha256: hashSchema }),
    source: z.object({ path: z.string(), sha256: hashSchema }),
    model: z.object({ repo: z.string(), revision: z.string(), license: z.string() }).passthrough(),
    protocol: z
      .object({
        clip_to_box: z.literal(false),
        decoder_batch_size: z.literal(1),
        decoder_calls: z.literal(36),
        hq_token_only: z.literal(true),
        image_encoding_calls: z.literal(1),
        mask_frame: z.literal('full original source'),
        mask_threshold: z.literal(0),
        multimask_output: z.literal(false),
        order: z.literal('frozen H4a candidate order'),
        prompt: z.literal('box XYXY'),
        prompt_count: z.literal(36),
      })
      .passthrough(),
    results: z
      .array(
        z
          .object({
            proposal_ordinal: z.number().int().nonnegative(),
            flat_index: z.number().int().nonnegative(),
            score: z.number().finite(),
            box_xyxy: boxSchema,
            mask_path: z.string(),
            mask_sha256: hashSchema,
            mask_box_xyxy: z.union([boxSchema, z.null()]),
            mask_pixel_area: z.number().int().nonnegative(),
            source_width: z.number().int().positive(),
            source_height: z.number().int().positive(),
            empty: z.boolean(),
          })
          .passthrough(),
      )
      .length(36),
  })
  .passthrough()
const freezeSchema = z
  .object({
    state: z.literal('frozen-before-inference'),
    h4a_output: z.object({ path: z.string(), sha256: hashSchema }),
    h4a_freeze: z.object({ path: z.string(), sha256: hashSchema }),
    source: z.object({ path: z.string(), sha256: hashSchema }),
    producer: z.object({ path: z.string(), sha256: hashSchema }),
    model: z.object({ repo: z.string(), revision: z.string(), license: z.string() }).passthrough(),
    proposals: z
      .array(
        z.object({
          proposal_ordinal: z.number().int().nonnegative(),
          flat_index: z.number().int().nonnegative(),
          score: z.number().finite(),
          box_xyxy: boxSchema,
        }),
      )
      .length(36),
  })
  .passthrough()
const h4aSchema = z
  .object({
    state: z.literal('complete'),
    integrity_after: z.object({ unchanged: z.literal(true) }).passthrough(),
    results: z
      .array(
        z.object({
          case_ids: z.array(z.string()).length(4),
          source: z.object({ sha256: hashSchema }),
          candidates: z
            .array(
              z.object({ flat_index: z.number().int(), score: z.number(), box_xyxy: boxSchema }),
            )
            .length(36),
        }),
      )
      .length(1),
  })
  .passthrough()

export interface H4dMaskReceipt {
  mask_path: string
  mask_sha256: string
  mask_bytes?: number
  mask_box_xyxy: number[] | null
  mask_pixel_area: number
  source_width: number
  source_height: number
  empty: boolean
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameBox(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= 1e-9)
}

function toBox(values: readonly number[], width: number, height: number): Box {
  const [left, top, right, bottom] = values
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

function foregroundBounds(bits: Uint8Array, width: number, height: number): Box | null {
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1
  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i]
    if (bit !== 0 && bit !== 1) throw new Error('mask-not-binary')
    if (!bit) continue
    const x = i % width,
      y = Math.floor(i / width)
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

function toXyxy(box: Box | null): number[] | null {
  return box ? [box.left, box.top, box.left + box.width, box.top + box.height] : null
}

export async function decodeH4dMask(root: string, result: H4dMaskReceipt) {
  if (isAbsolute(result.mask_path)) throw new Error('mask-path-absolute')
  const full = resolve(root, result.mask_path)
  const rel = relative(root, full)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('mask-path-outside-run')
  const realRoot = await realpath(root),
    realFile = await realpath(full)
  const realRel = relative(realRoot, realFile)
  if (!realRel || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel))
    throw new Error('mask-symlink-escape')
  const bytes = await readFile(realFile)
  if (sha256(bytes) !== result.mask_sha256) throw new Error('mask-hash-mismatch')
  if (result.mask_bytes !== undefined && bytes.byteLength !== result.mask_bytes)
    throw new Error('mask-byte-size-mismatch')
  const meta = await sharp(bytes, { failOn: 'error' }).metadata()
  if (
    meta.format !== 'png' ||
    meta.width !== 1280 ||
    meta.height !== 800 ||
    (meta.channels !== 1 && meta.channels !== 3) ||
    (meta.pages ?? 1) !== 1
  )
    throw new Error('mask-source-canvas-mismatch')
  const raw = await sharp(bytes, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true })
  if (raw.info.channels !== 3 || raw.data.length !== 1280 * 800 * 3)
    throw new Error('mask-buffer-geometry-mismatch')
  const bits = new Uint8Array(1280 * 800)
  let area = 0
  for (let i = 0; i < bits.length; i++) {
    const value = raw.data[i * 3]
    if (
      (value !== 0 && value !== 255) ||
      raw.data[i * 3 + 1] !== value ||
      raw.data[i * 3 + 2] !== value
    )
      throw new Error('mask-not-binary-grayscale')
    bits[i] = value === 255 ? 1 : 0
    if (bits[i]) area++
  }
  const bounds = foregroundBounds(bits, 1280, 800)
  if (
    !bounds ||
    result.empty ||
    result.mask_pixel_area !== area ||
    !result.mask_box_xyxy ||
    !sameBox(result.mask_box_xyxy, toXyxy(bounds)!)
  )
    throw new Error('mask-pixel-descriptor-mismatch')
  return { bits, bounds, area, sha256: sha256(bytes) }
}

export async function evaluateH4dSamHqUi(args: {
  runRoot: string
  expectedRunSha256: string
  expectedFreezeSha256: string
  h4aRunPath: string
  h4aFreezePath: string
}) {
  const runRoot = await realpath(args.runRoot)
  const runBytes = await readFile(resolve(runRoot, 'run.json'))
  const freezeBytes = await readFile(resolve(runRoot, 'freeze.json'))
  const h4aBytes = await readFile(args.h4aRunPath)
  const h4aFreezeBytes = await readFile(args.h4aFreezePath)
  if (sha256(runBytes) !== args.expectedRunSha256 || args.expectedRunSha256 !== H4D_RUN_SHA256)
    throw new Error('H4d-run-lock-mismatch')
  if (
    sha256(freezeBytes) !== args.expectedFreezeSha256 ||
    args.expectedFreezeSha256 !== H4D_FREEZE_SHA256
  )
    throw new Error('H4d-freeze-lock-mismatch')
  if (sha256(h4aBytes) !== H4A_RUN_SHA256 || sha256(h4aFreezeBytes) !== H4A_FREEZE_SHA256)
    throw new Error('H4a-source-lock-mismatch')
  const run = runSchema.parse(JSON.parse(runBytes.toString('utf8')))
  const freeze = freezeSchema.parse(JSON.parse(freezeBytes.toString('utf8')))
  const h4a = h4aSchema.parse(JSON.parse(h4aBytes.toString('utf8')))
  if (sha256(await readFile(freeze.producer.path)) !== freeze.producer.sha256)
    throw new Error('H4d-producer-source-hash-mismatch')
  if (
    run.h4a_output.sha256 !== H4A_RUN_SHA256 ||
    run.h4a_freeze.sha256 !== H4A_FREEZE_SHA256 ||
    freeze.h4a_output.sha256 !== H4A_RUN_SHA256 ||
    freeze.h4a_freeze.sha256 !== H4A_FREEZE_SHA256 ||
    run.model.repo !== 'syscv-community/sam-hq-vit-base' ||
    run.model.revision !== 'f906a2e3f60fda2f12eb717cef18614f66c43124' ||
    run.model.license !== 'Apache-2.0' ||
    freeze.model.repo !== run.model.repo ||
    freeze.model.revision !== run.model.revision ||
    run.source.sha256 !== freeze.source.sha256 ||
    run.integrity_after.unchanged !== true
  )
    throw new Error('H4d-run-freeze-profile-mismatch')
  const sourceHash = '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09'
  const h4aResult = h4a.results[0]!
  if (
    h4aResult.source.sha256 !== sourceHash ||
    run.source.sha256 !== sourceHash ||
    freeze.source.sha256 !== sourceHash ||
    JSON.stringify(h4aResult.case_ids) !==
      JSON.stringify(['pilot-v03-ui-01', 'pilot-v03-ui-02', 'pilot-v03-ui-03', 'pilot-v03-ui-04'])
  )
    throw new Error('H4d-source-identity-mismatch')
  const candidates = h4aResult.candidates
  const proposals = freeze.proposals
  for (let index = 0; index < 36; index++) {
    const a = candidates[index]!,
      p = proposals[index]!,
      r = run.results[index]!
    if (
      p.proposal_ordinal !== index ||
      r.proposal_ordinal !== index ||
      p.flat_index !== a.flat_index ||
      r.flat_index !== a.flat_index ||
      p.score !== a.score ||
      r.score !== a.score ||
      !sameBox(p.box_xyxy, a.box_xyxy) ||
      !sameBox(r.box_xyxy, a.box_xyxy)
    )
      throw new Error(`H4d-prompt-order-or-box-mismatch-${index}`)
  }
  const truth = await loadV03PilotTruth()
  const uiTruth = new Map(
    truth.filter((item) => item.stratum === 'ui').map((item) => [item.caseId, item]),
  )
  const results = []
  const rows = []
  const candidateScores = []
  for (const row of run.results) {
    const decoded = await decodeH4dMask(runRoot, row)
    results.push({
      ordinal: row.proposal_ordinal,
      flatIndex: row.flat_index,
      sha256: decoded.sha256,
      area: decoded.area,
      maskBox: decoded.bounds,
      promptBox: toBox(row.box_xyxy, 1280, 800),
    })
  }
  for (const caseId of h4aResult.case_ids) {
    const expected = uiTruth.get(caseId)
    if (!expected) throw new Error(`H4d-truth-case-missing-${caseId}`)
    const scored = results.map((candidate) => {
      if (expected.presence !== 'present' || expected.boxes.length === 0)
        return { caseId, ordinal: candidate.ordinal, bestIoU: 0, bestCoverage: 0, pass: false }
      const matches = wholeObjectMatch(candidate.maskBox, expected.boxes).instances
      const best = matches.reduce((prior, current) => (current.iou > prior.iou ? current : prior))
      return {
        caseId,
        ordinal: candidate.ordinal,
        bestIoU: best.iou,
        bestCoverage: Math.min(1, best.coverage),
        pass: matches.some((item) => item.matched),
      }
    })
    candidateScores.push(...scored)
    const best = scored.reduce((prior, current) =>
      current.bestIoU > prior.bestIoU ? current : prior,
    )
    rows.push({
      caseId,
      presence: expected.presence,
      proposalCount: results.length,
      candidateAvailabilityPass: scored.some((candidate) => candidate.pass),
      bestCandidate: best.ordinal,
      bestCandidateIoU: best.bestIoU,
      bestCandidateCoverage: best.bestCoverage,
      sameCandidateGatePass: best.pass,
      referenceCount: expected.boxes.length,
    })
  }
  return {
    schema: 'v03-h4d-samhq-ui-mask-availability-v1',
    runSha256: args.expectedRunSha256,
    freezeSha256: args.expectedFreezeSha256,
    h4aRunSha256: H4A_RUN_SHA256,
    h4aFreezeSha256: H4A_FREEZE_SHA256,
    model: run.model,
    protocol: run.protocol,
    integrityUnchanged: run.integrity_after.unchanged,
    validMaskCount: results.length,
    emptyMaskCount: 0,
    positiveDenominator: rows.filter((row) => row.presence === 'present').length,
    positiveCandidatesPassing: rows.filter(
      (row) => row.presence === 'present' && row.candidateAvailabilityPass,
    ).length,
    negativeDenominator: rows.filter((row) => row.presence === 'absent').length,
    negativesWithCandidates: rows.filter((row) => row.presence === 'absent').length,
    interpretation:
      'candidate-mask availability ceiling; no semantic selection or false-positive judgment',
    rows,
    candidates: results,
    candidateScores,
  }
}
