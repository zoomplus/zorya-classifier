import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { z } from 'zod'
import { wholeObjectMatch } from '../v02/metrics.js'
import type { Box } from '../v02/metrics.js'
import {
  decodeH4dMask,
  H4A_FREEZE_SHA256,
  H4A_RUN_SHA256,
} from './evaluate-h4d-samhq-ui-mask-availability.js'
import { loadV03PilotTruth } from './evaluate-pilot.js'

export const H4E_RUN_SHA256 = 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4'
export const H4E_FREEZE_SHA256 = 'ea905f6e2468b0776207056d51b6c96d0eed9e6c8a6b2626b388fb14974032a2'
export const H4E_RUN_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1'

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boxSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
])
const modelSchema = z
  .object({
    repo: z.string(),
    revision: z.string(),
    license: z.string(),
    assets: z.array(
      z.object({
        bytes: z.number().int().positive(),
        name: z.string(),
        path: z.string(),
        sha256: shaSchema,
      }),
    ),
  })
  .passthrough()
const runSchema = z
  .object({
    state: z.literal('complete'),
    candidate_count: z.literal(36),
    integrity_after: z.object({ unchanged: z.literal(true) }).passthrough(),
    h4a_output: z.object({ path: z.string(), sha256: shaSchema }),
    h4a_freeze: z.object({ path: z.string(), sha256: shaSchema }),
    source: z.object({ path: z.string(), sha256: shaSchema }),
    model: modelSchema,
    protocol: z
      .object({
        clip_to_box: z.literal(false),
        image_encoding_calls: z.literal(1),
        mask_frame: z.literal('full original source'),
        mask_threshold: z.literal(0),
        multimask_output: z.literal(false),
        order: z.literal('frozen H4a candidate order'),
        prompt: z.literal('box XYXY expanded 25% per original side and clipped to source'),
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
            expanded_prompt_xyxy: boxSchema,
            mask_path: z.string(),
            mask_sha256: shaSchema,
            mask_bytes: z.number().int().positive(),
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
    h4a_output: z.object({ path: z.string(), sha256: shaSchema }),
    h4a_freeze: z.object({ path: z.string(), sha256: shaSchema }),
    source: z.object({ path: z.string(), sha256: shaSchema }),
    producer: z.object({ path: z.string(), sha256: shaSchema }),
    model: modelSchema,
    recipe: z
      .object({
        clip_to_box: z.literal(false),
        image_encoding_calls: z.literal(1),
        mask_frame: z.literal('full original source'),
        mask_threshold: z.literal(0),
        multimask_output: z.literal(false),
        ordered_box_prompts: z.literal(36),
        prompt_expansion: z
          .object({
            clipped_to_source: z.literal(true),
            fraction_per_original_side: z.literal(0.25),
          })
          .passthrough(),
      })
      .passthrough(),
    proposals: z
      .array(
        z.object({
          proposal_ordinal: z.number().int().nonnegative(),
          flat_index: z.number().int().nonnegative(),
          score: z.number().finite(),
          box_xyxy: boxSchema,
          expanded_prompt_xyxy: boxSchema,
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
          source: z.object({ sha256: shaSchema }),
          candidates: z
            .array(
              z.object({
                flat_index: z.number().int(),
                score: z.number().finite(),
                box_xyxy: boxSchema,
              }),
            )
            .length(36),
        }),
      )
      .length(1),
  })
  .passthrough()

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - right[index]!) <= 1e-9)
  )
}

function toBox(values: readonly number[]): Box {
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
    right > 1280 ||
    bottom > 800
  )
    throw new Error('box-outside-source-canvas')
  return { left, top, width: right - left, height: bottom - top }
}

function expectedExpandedBox(values: readonly number[]): number[] {
  const [left, top, right, bottom] = values
  if (left === undefined || top === undefined || right === undefined || bottom === undefined)
    throw new Error('proposal-box-invalid')
  const width = right - left
  const height = bottom - top
  return [
    Math.max(0, left - width * 0.25),
    Math.max(0, top - height * 0.25),
    Math.min(1280, right + width * 0.25),
    Math.min(800, bottom + height * 0.25),
  ]
}

/** Independent, same-candidate whole-box availability; no FP/semantic claim. */
export async function evaluateH4eSam2ContextPrompt(args: {
  runRoot: string
  expectedRunSha256?: string
  expectedFreezeSha256?: string
  h4aRunPath: string
  h4aFreezePath: string
}) {
  const evaluatorBytes = await readFile(fileURLToPath(import.meta.url))
  const evaluatorSha256 = sha256(evaluatorBytes)
  const runRoot = await realpath(args.runRoot)
  const runBytes = await readFile(resolve(runRoot, 'run.json'))
  const freezeBytes = await readFile(resolve(runRoot, 'freeze.json'))
  const h4aBytes = await readFile(args.h4aRunPath)
  const h4aFreezeBytes = await readFile(args.h4aFreezePath)
  const runSha256 = sha256(runBytes)
  const freezeSha256 = sha256(freezeBytes)
  if (
    runSha256 !== H4E_RUN_SHA256 ||
    (args.expectedRunSha256 && args.expectedRunSha256 !== runSha256)
  )
    throw new Error('H4e-run-lock-mismatch')
  if (
    freezeSha256 !== H4E_FREEZE_SHA256 ||
    (args.expectedFreezeSha256 && args.expectedFreezeSha256 !== freezeSha256)
  )
    throw new Error('H4e-freeze-lock-mismatch')
  if (sha256(h4aBytes) !== H4A_RUN_SHA256 || sha256(h4aFreezeBytes) !== H4A_FREEZE_SHA256)
    throw new Error('H4a-source-lock-mismatch')
  const run = runSchema.parse(JSON.parse(runBytes.toString('utf8')))
  const freeze = freezeSchema.parse(JSON.parse(freezeBytes.toString('utf8')))
  const h4a = h4aSchema.parse(JSON.parse(h4aBytes.toString('utf8')))
  if (sha256(await readFile(freeze.producer.path)) !== freeze.producer.sha256)
    throw new Error('H4e-producer-source-hash-mismatch')
  const sourceSha256 = '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09'
  if (
    run.h4a_output.sha256 !== H4A_RUN_SHA256 ||
    run.h4a_freeze.sha256 !== H4A_FREEZE_SHA256 ||
    freeze.h4a_output.sha256 !== H4A_RUN_SHA256 ||
    freeze.h4a_freeze.sha256 !== H4A_FREEZE_SHA256 ||
    run.source.sha256 !== sourceSha256 ||
    freeze.source.sha256 !== sourceSha256 ||
    run.model.repo !== 'facebook/sam2-hiera-tiny' ||
    run.model.revision !== '7c218beaf0bb87874785f32b582f640134fc1c09' ||
    run.model.license !== 'Apache-2.0' ||
    freeze.model.repo !== run.model.repo ||
    freeze.model.revision !== run.model.revision ||
    freeze.model.license !== run.model.license ||
    !sameNumbers(
      freeze.model.assets.map((asset) => asset.bytes),
      run.model.assets.map((asset) => asset.bytes),
    ) ||
    freeze.model.assets.some((asset, index) => {
      const actual = run.model.assets[index]
      return (
        asset.name !== actual?.name || asset.sha256 !== actual.sha256 || asset.path !== actual.path
      )
    })
  )
    throw new Error('H4e-run-freeze-profile-mismatch')
  const h4aResult = h4a.results[0]!
  if (
    h4aResult.source.sha256 !== sourceSha256 ||
    JSON.stringify(h4aResult.case_ids) !==
      JSON.stringify(['pilot-v03-ui-01', 'pilot-v03-ui-02', 'pilot-v03-ui-03', 'pilot-v03-ui-04'])
  )
    throw new Error('H4e-source-identity-mismatch')
  const truth = await loadV03PilotTruth()
  const truthById = new Map(
    truth.filter((item) => item.stratum === 'ui').map((item) => [item.caseId, item]),
  )
  const masks = [] as Array<{
    ordinal: number
    flatIndex: number
    proposalBox: Box
    promptBox: Box
    box: Box
    area: number
    sha256: string
  }>
  for (let index = 0; index < 36; index++) {
    const candidate = h4aResult.candidates[index]!
    const proposal = freeze.proposals[index]!
    const result = run.results[index]!
    if (
      proposal.proposal_ordinal !== index ||
      result.proposal_ordinal !== index ||
      proposal.flat_index !== candidate.flat_index ||
      result.flat_index !== candidate.flat_index ||
      proposal.score !== candidate.score ||
      result.score !== candidate.score ||
      !sameNumbers(proposal.box_xyxy, candidate.box_xyxy) ||
      !sameNumbers(result.box_xyxy, candidate.box_xyxy) ||
      !sameNumbers(proposal.expanded_prompt_xyxy, result.expanded_prompt_xyxy) ||
      !sameNumbers(result.expanded_prompt_xyxy, expectedExpandedBox(candidate.box_xyxy)) ||
      result.source_width !== 1280 ||
      result.source_height !== 800
    )
      throw new Error(`H4e-prompt-order-or-box-mismatch-${index}`)
    toBox(candidate.box_xyxy)
    const decoded = await decodeH4dMask(runRoot, result)
    masks.push({
      ordinal: index,
      flatIndex: result.flat_index,
      proposalBox: toBox(result.box_xyxy),
      promptBox: toBox(result.expanded_prompt_xyxy),
      box: decoded.bounds,
      area: decoded.area,
      sha256: decoded.sha256,
    })
  }
  const candidateScores = [] as Array<{
    caseId: string
    presence: 'present' | 'absent'
    ordinal: number
    iou: number
    coverage: number
    pass: boolean
  }>
  const rows = h4aResult.case_ids.map((caseId) => {
    const expected = truthById.get(caseId)
    if (
      !expected ||
      expected.imageSha256 !== sourceSha256 ||
      expected.sourceWidth !== 1280 ||
      expected.sourceHeight !== 800
    )
      throw new Error(`H4e-truth-source-identity-mismatch-${caseId}`)
    const scores = masks.map((mask) => {
      const matches =
        expected.presence === 'present' ? wholeObjectMatch(mask.box, expected.boxes).instances : []
      const best = matches.reduce((prior, current) => (current.iou > prior.iou ? current : prior), {
        iou: 0,
        coverage: 0,
        matched: false,
      })
      return {
        caseId,
        presence: expected.presence,
        ordinal: mask.ordinal,
        iou: best.iou,
        coverage: Math.min(1, best.coverage),
        pass: matches.some((item) => item.matched),
      }
    })
    candidateScores.push(...scores)
    const best = scores.reduce((prior, current) => (current.iou > prior.iou ? current : prior))
    return {
      caseId,
      presence: expected.presence,
      candidateCount: masks.length,
      sameCandidateGatePasses: scores.filter((score) => score.pass).length,
      candidateAvailabilityPass: scores.some((score) => score.pass),
      bestCandidateOrdinal: best.ordinal,
      bestCandidateIoU: best.iou,
      bestCandidateCoverage: best.coverage,
      referenceCount: expected.boxes.length,
    }
  })
  const positives = rows.filter((row) => row.presence === 'present')
  const negatives = rows.filter((row) => row.presence === 'absent')
  return {
    schema: 'v03-h4e-sam2-context-prompt-independent-evaluation-v1',
    evaluationType: 'same-candidate-whole-box-availability',
    productionResult: false,
    wholeObjectGate: { sameMaskDerivedBox: true, minimumIoU: 0.5, minimumReferenceCoverage: 0.9 },
    sourceSha256,
    negativeInterpretation:
      'mask availability on negatives is not a false-positive or semantic-selection judgment',
    runSha256,
    freezeSha256,
    evaluatorSha256,
    h4aRunSha256: H4A_RUN_SHA256,
    h4aFreezeSha256: H4A_FREEZE_SHA256,
    model: {
      repo: run.model.repo,
      revision: run.model.revision,
      license: run.model.license,
      assets: run.model.assets.map(({ bytes, name, sha256 }) => ({ bytes, name, sha256 })),
    },
    protocol: run.protocol,
    integrityUnchanged: run.integrity_after.unchanged,
    validMaskCount: masks.length,
    emptyMaskCount: 0,
    positiveDenominator: positives.length,
    positiveCandidatesPassing: positives.filter((row) => row.candidateAvailabilityPass).length,
    negativeDenominator: negatives.length,
    negativesWithMasks: negatives.length,
    rows,
    candidateScores,
    masks,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {
    runRoot: H4E_RUN_ROOT,
    h4aRunPath:
      '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.json',
    h4aFreezePath:
      '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.freeze.json',
  }
  evaluateH4eSam2ContextPrompt(args)
    .then(async (report) => {
      const output = resolve('docs/evidence/v03/h4e-sam2-context-prompt-evaluation.json')
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
      process.stdout.write(
        `${JSON.stringify({ output, validMaskCount: report.validMaskCount, positives: report.positiveDenominator, positivesPassing: report.positiveCandidatesPassing })}\n`,
      )
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'H4e evaluation failed'}\n`)
      process.exitCode = 1
    })
}
