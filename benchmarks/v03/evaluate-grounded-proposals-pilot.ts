import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import { loadFreshCorpus } from '../v02/fresh-corpus.js'
import type { FreshCase } from '../v02/fresh-corpus.js'
import { wholeObjectMatch, binaryMaskIoU } from '../v02/metrics.js'
import type { Box } from '../v02/metrics.js'
import { loadV03PilotTruth } from './evaluate-pilot.js'
import type { V03PilotTruth } from './evaluate-pilot.js'
import { v03PilotManifests, v03PilotRepositoryRoot } from './pilot-manifest.js'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boxArraySchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
])
const sourceDimensionsSchema = z
  .object({ width: z.number().int().positive(), height: z.number().int().positive() })
  .strict()
const runSchema = z
  .object({
    schema: z.literal('v03-grounded-proposals-probe-v1'),
    status: z.enum(['complete', 'incomplete']),
    cohort: z.literal('fixed-v03-dev-12-effc2e8'),
    case_ids: z.array(z.string().min(1)).length(12),
    manifest_sha256: z.record(z.string(), hashSchema),
    source_freeze: z
      .object({
        producer_script_sha256: hashSchema,
        environment_freeze_sha256: hashSchema,
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            case_id: z.string().min(1),
            status: z.enum(['not_started', 'complete', 'error', 'timeout']),
            row_sha256: hashSchema.optional(),
          })
          .passthrough(),
      )
      .length(12),
    model_assets: z.unknown(),
  })
  .passthrough()

const runRowSchema = z
  .object({
    case_id: z.string().min(1),
    status: z.enum(['complete', 'error', 'timeout']),
    source_sha256: hashSchema.optional(),
    source_dimensions: sourceDimensionsSchema.optional(),
    detector_candidate_count: z.number().int().nonnegative().optional(),
    candidate_cap: z.number().int().positive().optional(),
    truncated_detector_count: z.number().int().nonnegative().optional(),
    detector_candidates: z.array(z.unknown()).optional(),
    mask_candidates: z.array(z.unknown()).optional(),
    error: z.string().optional(),
    elapsed_ms: z.number().nonnegative().optional(),
  })
  .passthrough()

const detectorSchema = z
  .object({
    detector_index: z.number().int().nonnegative(),
    box_xyxy: boxArraySchema,
    score: z.number().finite(),
    label: z.string(),
  })
  .passthrough()

const maskCandidateSchema = z
  .object({
    id: z.string().regex(/^C\d{2}$/u),
    detector_index: z.number().int().nonnegative(),
    box_xyxy: boxArraySchema,
    score: z.number().finite(),
    mask_path: z.string().min(1),
    mask_sha256: hashSchema,
    mask_box_xyxy: z.union([boxArraySchema, z.null()]),
    sam2_mask_threshold: z.number().finite(),
  })
  .passthrough()

export interface H3RunLock {
  expectedRunSha256: string
  runJsonBytes: Uint8Array
  runRecord: unknown
}

export interface H3CaseCandidateResult {
  id: string
  detectorIndex: number
  detectorBox: Box
  detectorMaxBoxIoU: number
  detectorWholeBoxPass: boolean
  maskPath: string
  artifactStatus: 'valid' | 'invalid'
  artifactError: string | null
  maskBox: Box | null
  maskMaxBoxIoU: number
  maskWholeBoxPass: boolean
  referenceMaskIoUs: Array<{ reference: string; iou: number | null; error: string | null }>
}

export interface H3CaseResult {
  caseId: string
  stratum: 'photo' | 'ui' | 'map'
  presence: 'present' | 'absent'
  status: 'complete' | 'error' | 'timeout' | 'missing' | 'invalid-row'
  workerError: string | null
  detectorCandidateCount: number
  maskCandidateCount: number
  truncatedDetectorCount: number
  candidateAvailabilityPass: boolean
  bestMaskBoxIoU: number
  bestDetectorBoxIoU: number
  bestMaskIoU: number | null
  referenceMaskCount: number
  evaluableReferenceMaskCount: number
  candidateErrors: string[]
  candidates: H3CaseCandidateResult[]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
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

function equalBoxArrays(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function boxDiagnostics(box: Box, references: readonly Box[]) {
  if (references.length === 0) return { maxIoU: 0, wholeBoxPass: false }
  const scored = wholeObjectMatch(box, references).instances
  return {
    maxIoU: Math.max(...scored.map((item) => item.iou)),
    wholeBoxPass: scored.some((item) => item.matched),
  }
}

function deriveBounds(bits: Uint8Array, width: number, height: number): Box | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let index = 0; index < bits.length; index++) {
    const value = bits[index]
    if (value !== 0 && value !== 1) throw new Error('mask-not-binary')
    if (value !== 1) continue
    const x = index % width
    const y = Math.floor(index / width)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (maxX < 0 || maxY < 0) return null
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function bboxArray(box: Box | null): number[] | null {
  if (!box) return null
  return [box.left, box.top, box.left + box.width, box.top + box.height]
}

function assertContainedPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('mask-path-absolute')
  const candidate = resolve(root, path)
  const rel = relative(root, candidate)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('mask-path-outside-run')
  return candidate
}

async function decodeCandidateMask(
  runRoot: string,
  candidate: z.infer<typeof maskCandidateSchema>,
  source: { width: number; height: number },
): Promise<{ bytes: Uint8Array; box: Box | null }> {
  const path = assertContainedPath(runRoot, candidate.mask_path)
  const realRoot = await realpath(runRoot)
  const realPath = await realpath(path)
  const rel = relative(realRoot, realPath)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('mask-path-symlink-escape')
  const encoded = await readFile(realPath)
  if (sha256(encoded) !== candidate.mask_sha256) throw new Error('mask-hash-mismatch')
  const metadata = await sharp(encoded, { failOn: 'error' }).metadata()
  if (
    metadata.format !== 'png' ||
    metadata.width !== source.width ||
    metadata.height !== source.height ||
    (metadata.channels !== 1 && metadata.channels !== 3) ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error('mask-canvas-geometry-mismatch')
  const decoded = await sharp(encoded, { failOn: 'error' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (
    decoded.info.width !== source.width ||
    decoded.info.height !== source.height ||
    decoded.info.channels !== 3 ||
    decoded.data.length !== source.width * source.height * 3
  )
    throw new Error('mask-pixel-buffer-geometry-mismatch')
  const bits = new Uint8Array(source.width * source.height)
  for (let index = 0; index < bits.length; index++) {
    const pixelOffset = index * 3
    const value = decoded.data[pixelOffset]
    if (value !== 0 && value !== 255) throw new Error('mask-pixels-not-binary-0-255')
    if (decoded.data[pixelOffset + 1] !== value || decoded.data[pixelOffset + 2] !== value)
      throw new Error('mask-rgb-channels-differ')
    bits[index] = value === 255 ? 1 : 0
  }
  const box = deriveBounds(bits, source.width, source.height)
  if (!box) throw new Error('mask-empty')
  const actual = bboxArray(box)
  if (!candidate.mask_box_xyxy || !equalBoxArrays(candidate.mask_box_xyxy, actual!))
    throw new Error('mask-box-descriptor-mismatch')
  return { bytes: bits, box }
}

async function loadReferenceBits(
  root: string,
  reference: V03PilotTruth['referenceMasks'][number],
  source: { width: number; height: number },
): Promise<Uint8Array> {
  const path = resolve(root, reference.path)
  const bytes = await readFile(path)
  if (sha256(bytes) !== reference.sha256) throw new Error('reference-mask-hash-mismatch')
  if (
    reference.resampling !==
    'nearest-neighbor to the acquired Open Images JPEG raster; verified 0/255 binary values'
  )
    throw new Error('unsupported-reference-mask-resampling')
  const decoded = await sharp(bytes, { failOn: 'error' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (
    decoded.info.width !== reference.width ||
    decoded.info.height !== reference.height ||
    decoded.info.channels !== 1 ||
    decoded.data.length !== reference.width * reference.height
  )
    throw new Error('reference-mask-geometry-mismatch')
  const initial = new Uint8Array(decoded.data.length)
  for (let index = 0; index < decoded.data.length; index++) {
    const value = decoded.data[index]
    if (value !== 0 && value !== 255) throw new Error('reference-mask-not-binary')
    initial[index] = value === 255 ? 1 : 0
  }
  if (reference.width === source.width && reference.height === source.height) return initial
  const resized = await sharp(Buffer.from(initial), {
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

function validateRunLock(
  runRecord: unknown,
  expectedRunSha256: string,
  actualRunSha256: string,
  corpus: readonly FreshCase[],
) {
  if (!hashSchema.safeParse(expectedRunSha256).success || actualRunSha256 !== expectedRunSha256)
    throw new Error('H3 run.json SHA-256 does not match the external freeze lock')
  const run = runSchema.parse(runRecord)
  const ids = corpus.map((item) => item.caseId)
  if (
    JSON.stringify(run.case_ids) !== JSON.stringify(ids) ||
    JSON.stringify(run.cases.map((item) => item.case_id)) !== JSON.stringify(ids)
  )
    throw new Error('H3 run case order differs from the frozen DEV12 input')
  for (const manifest of v03PilotManifests) {
    const key = manifest.path.split(/[\\/]/u).at(-1)
    if (!key || run.manifest_sha256[key] !== manifest.sha256)
      throw new Error(`H3 run manifest pin mismatch: ${key ?? 'unknown'}`)
  }
  if (run.cases.some((item) => item.status === 'complete' && !item.row_sha256))
    throw new Error('H3 completed row is missing its pinned row hash')
  if (run.cases.some((item) => item.status !== 'not_started' && !item.row_sha256))
    throw new Error('H3 attempted row is missing its pinned row hash')
  if (run.status === 'complete' && run.cases.some((item) => item.status !== 'complete'))
    throw new Error('H3 run is marked complete with unfinished cases')
  return run
}

export interface EvaluateGroundedProposalInput {
  corpus: readonly FreshCase[]
  truth: readonly V03PilotTruth[]
  runRecord: unknown
  runSha256: string
  expectedRunSha256: string
  runRoot: string
  imageRoot: string
}

/** Evaluator-only oracle ceiling; not a production result and not a negative classifier. */
export async function evaluateGroundedProposalAvailability(input: EvaluateGroundedProposalInput) {
  if (input.corpus.length !== 12) throw new Error('Expected the exact frozen twelve-case pilot')
  const run = validateRunLock(
    input.runRecord,
    input.expectedRunSha256,
    input.runSha256,
    input.corpus,
  )
  const truthById = new Map(input.truth.map((item) => [item.caseId, item]))
  if (truthById.size !== 12 || truthById.size !== input.truth.length)
    throw new Error('Expected twelve unique evaluator truth rows')
  const statusById = new Map(run.cases.map((item) => [item.case_id, item]))
  const perCase: H3CaseResult[] = []
  for (const item of input.corpus) {
    const truth = truthById.get(item.caseId)
    if (!truth) throw new Error(`Missing truth case ${item.caseId}`)
    if (
      truth.imageSha256 !== item.image.sha256 ||
      truth.sourceWidth !== item.image.width ||
      truth.sourceHeight !== item.image.height
    )
      throw new Error(`Input and truth source identity disagree for ${item.caseId}`)
    const status = statusById.get(item.caseId)
    if (!status) throw new Error(`H3 run omitted planned status ${item.caseId}`)
    const outputPath = resolve(input.runRoot, 'cases', `${item.caseId}.json`)
    let row: z.infer<typeof runRowSchema> | undefined
    let rowStatus: H3CaseResult['status'] =
      status.status === 'not_started' ? 'missing' : status.status
    let workerError: string | null = null
    if (status.status !== 'not_started') {
      try {
        const realRunRoot = await realpath(input.runRoot)
        const realOutputPath = await realpath(outputPath)
        const rowRelative = relative(realRunRoot, realOutputPath)
        if (
          !rowRelative ||
          rowRelative === '..' ||
          rowRelative.startsWith(`..${sep}`) ||
          isAbsolute(rowRelative)
        )
          throw new Error('case-row-path-outside-run')
        const rowBytes = await readFile(realOutputPath)
        if (!status.row_sha256 || sha256(rowBytes) !== status.row_sha256)
          throw new Error('case-row-hash-mismatch')
        const parsed = runRowSchema.safeParse(JSON.parse(rowBytes.toString('utf8')))
        if (!parsed.success || parsed.data.case_id !== item.caseId)
          throw new Error('case-row-schema-or-id-mismatch')
        row = parsed.data
        if (row.status !== status.status) throw new Error('case-row-status-mismatch')
        rowStatus = row.status
        workerError = row.error ?? null
        if (row.status === 'complete') {
          if (
            row.source_sha256 !== item.image.sha256 ||
            row.source_dimensions?.width !== item.image.width ||
            row.source_dimensions.height !== item.image.height
          )
            throw new Error('case-source-identity-mismatch')
        }
      } catch (error) {
        rowStatus = 'invalid-row'
        workerError = error instanceof Error ? error.message : 'case-row-invalid'
        row = undefined
      }
    }
    const references = truth.presence === 'present' ? truth.boxes : []
    const candidates: H3CaseCandidateResult[] = []
    const candidateErrors: string[] = []
    const detectorList = row?.detector_candidates ?? []
    const masks = row?.mask_candidates ?? []
    let bestMaskIoU: number | null = null
    if (rowStatus === 'complete') {
      const detectionsByIndex = new Map<number, z.infer<typeof detectorSchema>>()
      for (const value of detectorList) {
        const detector = detectorSchema.safeParse(value)
        if (!detector.success) {
          candidateErrors.push('invalid-detector-candidate')
          continue
        }
        if (detectionsByIndex.has(detector.data.detector_index)) {
          candidateErrors.push('duplicate-detector-index')
          continue
        }
        detectionsByIndex.set(detector.data.detector_index, detector.data)
      }
      for (const value of masks) {
        const parsed = maskCandidateSchema.safeParse(value)
        if (!parsed.success) {
          candidateErrors.push('invalid-mask-candidate-descriptor')
          continue
        }
        const candidate = parsed.data
        const detector = detectionsByIndex.get(candidate.detector_index)
        if (!detector || !equalBoxArrays(detector.box_xyxy, candidate.box_xyxy)) {
          candidateErrors.push(`${candidate.id}:detector-candidate-mismatch`)
          continue
        }
        let maskBox: Box | null = null
        let artifactStatus: H3CaseCandidateResult['artifactStatus'] = 'invalid'
        let artifactError: string | null = null
        let maskBits: Uint8Array | undefined
        try {
          const decoded = await decodeCandidateMask(input.runRoot, candidate, {
            width: item.image.width,
            height: item.image.height,
          })
          maskBits = decoded.bytes
          maskBox = decoded.box
          artifactStatus = 'valid'
        } catch (error) {
          artifactError = error instanceof Error ? error.message : 'mask-artifact-invalid'
          candidateErrors.push(`${candidate.id}:${artifactError}`)
        }
        let detectorBox: Box
        let detectorScore: ReturnType<typeof boxDiagnostics>
        try {
          detectorBox = toBox(detector.box_xyxy, item.image.width, item.image.height)
          detectorScore = boxDiagnostics(detectorBox, references)
        } catch {
          candidateErrors.push(`${candidate.id}:invalid-detector-box`)
          continue
        }
        const maskScore = maskBox
          ? boxDiagnostics(maskBox, references)
          : { maxIoU: 0, wholeBoxPass: false }
        const referenceMaskIoUs: H3CaseCandidateResult['referenceMaskIoUs'] = []
        if (maskBits && truth.referenceMasks.length > 0) {
          for (const reference of truth.referenceMasks) {
            try {
              const referenceBits = await loadReferenceBits(input.imageRoot, reference, {
                width: item.image.width,
                height: item.image.height,
              })
              const score = binaryMaskIoU(maskBits, referenceBits)
              referenceMaskIoUs.push({ reference: reference.path, iou: score.iou, error: null })
              bestMaskIoU = Math.max(bestMaskIoU ?? 0, score.iou)
            } catch (error) {
              candidateErrors.push(
                `${candidate.id}:reference-mask:${error instanceof Error ? error.message : 'invalid'}`,
              )
              referenceMaskIoUs.push({
                reference: reference.path,
                iou: null,
                error: error instanceof Error ? error.message : 'invalid',
              })
            }
          }
        }
        candidates.push({
          id: candidate.id,
          detectorIndex: candidate.detector_index,
          detectorBox,
          detectorMaxBoxIoU: detectorScore.maxIoU,
          detectorWholeBoxPass: detectorScore.wholeBoxPass,
          maskPath: candidate.mask_path,
          artifactStatus,
          artifactError,
          maskBox,
          maskMaxBoxIoU: maskScore.maxIoU,
          maskWholeBoxPass: maskScore.wholeBoxPass,
          referenceMaskIoUs,
        })
      }
    }
    const maskCandidateCount = masks.length
    const detectorCandidateCount = row?.detector_candidate_count ?? 0
    const truncatedDetectorCount = row?.truncated_detector_count ?? 0
    if (row && detectorList.length !== detectorCandidateCount)
      candidateErrors.push('detector-candidate-count-mismatch')
    if (row && masks.length > (row.candidate_cap ?? 36))
      candidateErrors.push('mask-candidate-cap-exceeded')
    const candidateAvailabilityPass =
      truth.presence === 'present' &&
      candidates.some((item) => item.artifactStatus === 'valid' && item.maskWholeBoxPass)
    perCase.push({
      caseId: item.caseId,
      stratum: truth.stratum,
      presence: truth.presence,
      status: rowStatus,
      workerError,
      detectorCandidateCount,
      maskCandidateCount,
      truncatedDetectorCount,
      candidateAvailabilityPass,
      bestMaskBoxIoU: Math.max(0, ...candidates.map((item) => item.maskMaxBoxIoU)),
      bestDetectorBoxIoU: Math.max(0, ...candidates.map((item) => item.detectorMaxBoxIoU)),
      bestMaskIoU,
      referenceMaskCount: truth.referenceMasks.length,
      evaluableReferenceMaskCount: new Set(
        candidates.flatMap((candidate) =>
          candidate.referenceMaskIoUs
            .filter((score) => score.error === null)
            .map((score) => score.reference),
        ),
      ).size,
      candidateErrors,
      candidates,
    })
  }
  const positiveRows = perCase.filter((item) => item.presence === 'present')
  const negativeRows = perCase.filter((item) => item.presence === 'absent')
  const strata = ['photo', 'ui', 'map'] as const
  return {
    schema: 'v03-grounded-proposals-oracle-availability-v1',
    evaluationType: 'oracle-candidate-availability-ceiling',
    productionResult: false,
    negativeCandidateSemantics:
      'candidate presence is availability only; no false-positive judgment without downstream selection',
    runSha256: input.runSha256,
    producerScriptSha256: run.source_freeze.producer_script_sha256,
    environmentFreezeSha256: run.source_freeze.environment_freeze_sha256,
    runStatus: run.status,
    plannedCases: perCase.length,
    positives: positiveRows.length,
    negatives: negativeRows.length,
    positiveMaskBoxPasses: positiveRows.filter((item) => item.candidateAvailabilityPass).length,
    positiveMaskBoxAvailabilityRate:
      positiveRows.length === 0
        ? null
        : positiveRows.filter((item) => item.candidateAvailabilityPass).length /
          positiveRows.length,
    positiveCasesWithReferenceMasks: positiveRows.filter((item) => item.referenceMaskCount > 0)
      .length,
    positiveCasesWithEvaluableReferenceMasks: positiveRows.filter(
      (item) => item.evaluableReferenceMaskCount > 0,
    ).length,
    positiveCasesWithUnavailableReferenceMasks: positiveRows.filter(
      (item) => item.referenceMaskCount > 0 && item.evaluableReferenceMaskCount === 0,
    ).length,
    negativesWithCandidates: negativeRows.filter((item) => item.maskCandidateCount > 0).length,
    totalCandidatesOnNegatives: negativeRows.reduce(
      (sum, item) => sum + item.maskCandidateCount,
      0,
    ),
    failedOrMissingCases: perCase.filter((item) => item.status !== 'complete').length,
    zeroMaskCandidateCases: perCase.filter((item) => item.maskCandidateCount === 0).length,
    truncatedCases: perCase.filter((item) => item.truncatedDetectorCount > 0).length,
    stratumSummary: Object.fromEntries(
      strata.map((stratum) => {
        const group = perCase.filter((item) => item.stratum === stratum)
        const positivesInGroup = group.filter((item) => item.presence === 'present')
        const negativesInGroup = group.filter((item) => item.presence === 'absent')
        return [
          stratum,
          {
            cases: group.length,
            positives: positivesInGroup.length,
            positiveMaskBoxPasses: positivesInGroup.filter((item) => item.candidateAvailabilityPass)
              .length,
            negatives: negativesInGroup.length,
            negativesWithCandidates: negativesInGroup.filter((item) => item.maskCandidateCount > 0)
              .length,
            failedOrMissing: group.filter((item) => item.status !== 'complete').length,
            truncatedCases: group.filter((item) => item.truncatedDetectorCount > 0).length,
          },
        ]
      }),
    ),
    perCase,
  }
}

export async function loadAndEvaluateGroundedProposalRun(args: {
  runRoot: string
  imageRoot?: string
  expectedRunSha256: string
}) {
  const runRoot = await realpath(args.runRoot)
  const runBytes = await readFile(resolve(runRoot, 'run.json'))
  const runSha256 = sha256(runBytes)
  if (runSha256 !== args.expectedRunSha256) throw new Error('External H3 run hash lock mismatch')
  const runRecord = JSON.parse(runBytes.toString('utf8')) as unknown
  const corpus = await loadFreshCorpus(
    { manifests: [...v03PilotManifests], imageRoot: args.imageRoot ?? v03PilotRepositoryRoot },
    new AbortController().signal,
  )
  const truth = await loadV03PilotTruth()
  const result = await evaluateGroundedProposalAvailability({
    corpus: corpus.cases,
    truth,
    runRecord,
    runSha256,
    expectedRunSha256: args.expectedRunSha256,
    runRoot,
    imageRoot: corpus.imageRoot,
  })
  return result
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (value.startsWith('--') && argv[index + 1] && !argv[index + 1]!.startsWith('--'))
      values.set(value.slice(2), argv[++index]!)
    else throw new Error(`Invalid argument ${value}`)
  }
  const runRoot = values.get('run')
  const expectedRunSha256 = values.get('run-sha256')
  const output = values.get('output')
  const imageRoot = values.get('image-root')
  if (!runRoot || !expectedRunSha256 || !output)
    throw new Error('--run, --run-sha256, and --output are required')
  return {
    runRoot: resolve(runRoot),
    expectedRunSha256,
    output: resolve(output),
    ...(imageRoot ? { imageRoot: resolve(imageRoot) } : {}),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  loadAndEvaluateGroundedProposalRun(args)
    .then(async (result) => {
      await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
      process.stdout.write(`${JSON.stringify({ output: args.output, status: result.runStatus })}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'H3 evaluator failed'}\n`)
      process.exitCode = 1
    })
}
