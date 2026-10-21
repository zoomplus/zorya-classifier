import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
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
const H3_NATIVE_RUN_SHA256 = 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401'
const expectedIds = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]
const rectSchema = z.object({
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
})
const resultRowSchema = z
  .object({
    caseId: z.string().min(1),
    status: z.enum([
      'dry-run',
      'no-candidates',
      'none',
      'complete',
      'needs-expansion',
      'unknown',
      'error',
    ]),
    sourceSha256: hashSchema,
    candidateCount: z.number().int().nonnegative(),
    physicalCallCount: z.number().int().nonnegative(),
    elapsedMs: z.number().finite().nonnegative(),
    nativeElapsedMs: z.number().finite().nonnegative(),
    selectionProviderMs: z.number().finite().nonnegative().nullable(),
    boxCheckProviderMs: z.number().finite().nonnegative().nullable(),
    cutoutElapsedMs: z.number().finite().nonnegative().nullable(),
    selection: z
      .object({ choice: z.string().min(1) })
      .passthrough()
      .nullable(),
    boxCheck: z
      .object({
        verdict: z.enum(['complete', 'needs-expansion', 'unknown']),
        maskDerivedBox: rectSchema.nullable(),
      })
      .passthrough()
      .nullable(),
    selectedAlias: z.string().nullable(),
    files: z
      .object({
        mask: z.string().nullable(),
        maskSha256: hashSchema.nullable(),
        cutout: z.string().nullable(),
        cutoutSha256: hashSchema.nullable(),
      })
      .strict(),
  })
  .passthrough()
const freezeSchema = z
  .object({
    schema: z.literal('v03-grounded-mask-selection-freeze-v1'),
    nativeRun: z.object({ path: z.string(), sha256: hashSchema }).passthrough(),
    producerClosure: z.object({ sha256: hashSchema }).passthrough(),
    nativeArtifacts: z.array(z.object({ path: z.string(), sha256: hashSchema }).passthrough()),
  })
  .passthrough()
const runSchema = z
  .object({
    schema: z.literal('v03-grounded-mask-selection-pilot-v1'),
    status: z.enum(['complete', 'incomplete', 'dry-run']),
    cohort: z.literal('fixed-v03-dev-12-effc2e8'),
    replayComposition: z.literal(true),
    freezeMatched: z.boolean(),
    nativeRunSha256: hashSchema,
    initialProducerClosureSha256: hashSchema,
    finalProducerClosureSha256: hashSchema,
    initialNativeArtifacts: z.array(
      z.object({ path: z.string(), sha256: hashSchema }).passthrough(),
    ),
    finalNativeArtifacts: z.array(z.object({ path: z.string(), sha256: hashSchema }).passthrough()),
    finalNativeRunSha256: hashSchema,
    caseDeadlineMs: z.number().finite().positive(),
    budget: z
      .object({
        admittedPhysicalCalls: z.number().int().nonnegative(),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownCostCalls: z.number().int().nonnegative(),
        inFlightCalls: z.number().int().nonnegative(),
        maxPhysicalCalls: z.number().int().positive(),
        maxCostUsd: z.number().finite().positive(),
      })
      .passthrough(),
    recorder: z
      .object({
        physicalCalls: z.array(z.unknown()),
        logicalCalls: z.array(z.unknown()),
        persistenceFailures: z.array(z.unknown()),
      })
      .passthrough()
      .nullable(),
    rows: z.array(resultRowSchema).length(12),
  })
  .passthrough()

export interface SelectedMaskCaseResult {
  caseId: string
  stratum: 'photo' | 'ui' | 'map'
  presence: 'present' | 'absent'
  status: string
  finalOutputStatus: 'valid-complete' | 'missing' | 'invalid'
  artifactError: string | null
  maskSha256: string | null
  cutoutSha256: string | null
  predictedBox: Box | null
  bestIoU: number
  bestCoverage: number
  wholeBoxPass: boolean
  bestReferenceMaskIoU: number | null
  evaluableReferenceMaskCount: number
  candidateCount: number
  selected: boolean
  choseNone: boolean
  errorCode: string | null
  elapsedMs: number
  nativeElapsedMs: number
  selectionProviderMs: number | null
  boxCheckProviderMs: number | null
  cutoutElapsedMs: number | null
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function containedPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('artifact-path-absolute')
  const candidate = resolve(root, path)
  const part = relative(root, candidate)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('artifact-path-outside-run')
  return candidate
}

function bbox(bits: Uint8Array, width: number, height: number): Box | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let i = 0; i < bits.length; i++) {
    const value = bits[i]
    if (value !== 0 && value !== 1) throw new Error('mask-not-binary')
    if (!value) continue
    const x = i % width
    const y = Math.floor(i / width)
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function sameBox(a: Box, b: Box): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

export function finalOutputDisposition(input: {
  status: string
  verdict: string | undefined
  selected: boolean
  maskPath: string | null
  cutoutPath: string | null
}): 'missing' | 'invalid' | 'validate-artifacts' {
  if (input.status !== 'complete' || input.verdict !== 'complete') return 'missing'
  if (!input.selected || !input.maskPath || !input.cutoutPath) return 'invalid'
  return 'validate-artifacts'
}

async function readFinalArtifact(
  runRoot: string,
  path: string,
  dimensions: { width: number; height: number },
  kind: 'mask' | 'cutout',
): Promise<{ hash: string; bits?: Uint8Array; box?: Box }> {
  const candidate = containedPath(runRoot, path)
  const realRoot = await realpath(runRoot)
  const realCandidate = await realpath(candidate)
  const part = relative(realRoot, realCandidate)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('artifact-symlink-escape')
  const bytes = await readFile(realCandidate)
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1)
    throw new Error(`${kind}-not-single-png`)
  const decoded = await sharp(bytes, { failOn: 'error' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (kind === 'mask') {
    if (metadata.width !== dimensions.width || metadata.height !== dimensions.height)
      throw new Error('mask-source-canvas-mismatch')
    if (decoded.info.channels !== 1 && decoded.info.channels !== 3)
      throw new Error('mask-channel-count-invalid')
    const bits = new Uint8Array(dimensions.width * dimensions.height)
    for (let i = 0; i < bits.length; i++) {
      const at = i * decoded.info.channels
      const v = decoded.data[at]
      if (v !== 0 && v !== 255) throw new Error('mask-pixels-not-binary')
      for (let c = 1; c < decoded.info.channels; c++)
        if (decoded.data[at + c] !== v) throw new Error('mask-channels-differ')
      bits[i] = v === 255 ? 1 : 0
    }
    const box = bbox(bits, dimensions.width, dimensions.height)
    if (!box) throw new Error('mask-has-no-foreground')
    return { hash: sha256(bytes), bits, box }
  }
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > dimensions.width ||
    metadata.height > dimensions.height ||
    decoded.info.channels !== 4 ||
    decoded.data.length !== metadata.width * metadata.height * 4
  )
    throw new Error('cutout-geometry-invalid')
  let alphaPixels = 0
  for (let i = 3; i < decoded.data.length; i += 4) if (decoded.data[i] !== 0) alphaPixels++
  if (alphaPixels === 0) throw new Error('cutout-empty')
  return { hash: sha256(bytes) }
}

async function readReferenceMask(
  imageRoot: string,
  reference: V03PilotTruth['referenceMasks'][number],
  dimensions: { width: number; height: number },
): Promise<Uint8Array> {
  const bytes = await readFile(resolve(imageRoot, reference.path))
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
    decoded.info.channels !== 1 ||
    decoded.info.width !== reference.width ||
    decoded.info.height !== reference.height
  )
    throw new Error('reference-mask-geometry-mismatch')
  const source = new Uint8Array(decoded.data.length)
  for (let i = 0; i < source.length; i++) {
    const value = decoded.data[i]
    if (value !== 0 && value !== 255) throw new Error('reference-mask-not-binary')
    source[i] = value === 255 ? 1 : 0
  }
  if (reference.width === dimensions.width && reference.height === dimensions.height) return source
  const resized = await sharp(Buffer.from(source), {
    raw: { width: reference.width, height: reference.height, channels: 1 },
  })
    .resize(dimensions.width, dimensions.height, { kernel: 'nearest' })
    .raw()
    .toBuffer()
  if (resized.length !== dimensions.width * dimensions.height)
    throw new Error('reference-mask-resampling-failed')
  const bits = new Uint8Array(resized.length)
  for (let i = 0; i < bits.length; i++) {
    const value = resized[i]
    if (value !== 0 && value !== 1) throw new Error('resampled-reference-mask-not-binary')
    bits[i] = value
  }
  return bits
}

function validateLocks(args: {
  run: unknown
  freeze: unknown
  runSha256: string
  expectedRunSha256: string
  freezeSha256: string
  expectedFreezeSha256: string
}) {
  if (args.runSha256 !== args.expectedRunSha256 || args.freezeSha256 !== args.expectedFreezeSha256)
    throw new Error('external-run-or-freeze-lock-mismatch')
  const freeze = freezeSchema.parse(args.freeze)
  const run = runSchema.parse(args.run)
  if (
    !run.freezeMatched ||
    run.nativeRunSha256 !== H3_NATIVE_RUN_SHA256 ||
    freeze.nativeRun.sha256 !== run.nativeRunSha256 ||
    run.initialProducerClosureSha256 !== freeze.producerClosure.sha256 ||
    run.finalProducerClosureSha256 !== freeze.producerClosure.sha256 ||
    run.finalNativeRunSha256 !== run.nativeRunSha256 ||
    JSON.stringify(run.initialNativeArtifacts) !== JSON.stringify(freeze.nativeArtifacts) ||
    JSON.stringify(run.finalNativeArtifacts) !== JSON.stringify(freeze.nativeArtifacts)
  )
    throw new Error('producer-freeze-mismatch')
  if (run.status !== 'complete') throw new Error('pilot-run-not-complete')
  if (run.rows.some((row, i) => row.caseId !== expectedIds[i]))
    throw new Error('case-order-mismatch')
  if (run.budget.inFlightCalls !== 0 || run.budget.unknownCostCalls > 0)
    throw new Error('run-accounting-unresolved')
  if (
    run.budget.admittedPhysicalCalls > run.budget.maxPhysicalCalls ||
    run.budget.knownCostUsd > run.budget.maxCostUsd
  )
    throw new Error('run-budget-exceeded')
  if (!run.recorder || run.recorder.persistenceFailures.length > 0)
    throw new Error('provider-recorder-incomplete')
  if (run.budget.admittedPhysicalCalls !== run.recorder.physicalCalls.length)
    throw new Error('physical-call-accounting-mismatch')
  if (
    run.rows.reduce((total, row) => total + row.physicalCallCount, 0) !==
    run.budget.admittedPhysicalCalls
  )
    throw new Error('per-case-call-accounting-mismatch')
  return { run, freeze }
}

export async function evaluateGroundedMaskSelection(input: {
  corpus: readonly FreshCase[]
  truth: readonly V03PilotTruth[]
  runRoot: string
  runRecord: unknown
  freezeRecord: unknown
  runSha256: string
  expectedRunSha256: string
  freezeSha256: string
  expectedFreezeSha256: string
  imageRoot: string
}) {
  if (input.corpus.length !== 12) throw new Error('Expected exact frozen DEV12 cohort')
  const { run, freeze } = validateLocks({
    run: input.runRecord,
    freeze: input.freezeRecord,
    runSha256: input.runSha256,
    expectedRunSha256: input.expectedRunSha256,
    freezeSha256: input.freezeSha256,
    expectedFreezeSha256: input.expectedFreezeSha256,
  })
  if (new Set(input.truth.map((item) => item.caseId)).size !== 12 || input.truth.length !== 12)
    throw new Error('Expected twelve unique evaluator truth rows')
  const truthById = new Map(input.truth.map((item) => [item.caseId, item]))
  const runRoot = await realpath(input.runRoot)
  const nativeRunPath = resolve(freeze.nativeRun.path)
  const nativeRunBytes = await readFile(nativeRunPath)
  if (
    sha256(nativeRunBytes) !== freeze.nativeRun.sha256 ||
    sha256(nativeRunBytes) !== H3_NATIVE_RUN_SHA256
  )
    throw new Error('native-run-artifact-hash-mismatch')
  const nativeRun = JSON.parse(nativeRunBytes.toString('utf8')) as {
    cases?: Array<{
      case_id?: string
      status?: string
      row_sha256?: string
    }>
  }
  const nativeRunRoot = dirname(nativeRunPath)
  const perCase: SelectedMaskCaseResult[] = []
  for (let index = 0; index < input.corpus.length; index++) {
    const source = input.corpus[index]!
    const truth = truthById.get(source.caseId)
    const row = run.rows[index]!
    if (!truth || truth.caseId !== row.caseId)
      throw new Error(`Truth/case join failed: ${source.caseId}`)
    if (
      truth.imageSha256 !== source.image.sha256 ||
      row.sourceSha256 !== source.image.sha256 ||
      truth.sourceWidth !== source.image.width ||
      truth.sourceHeight !== source.image.height
    )
      throw new Error(`Source identity mismatch: ${source.caseId}`)
    const rowPath = containedPath(runRoot, `${source.caseId}.json`)
    const rowBytes = await readFile(rowPath)
    const persistedRow = JSON.parse(rowBytes.toString('utf8')) as unknown
    if (!isDeepStrictEqual(persistedRow, row))
      throw new Error(`Persisted case row differs from pinned run manifest: ${source.caseId}`)
    let finalOutputStatus: SelectedMaskCaseResult['finalOutputStatus'] = 'missing'
    let artifactError: string | null = null
    let maskSha256: string | null = null
    let cutoutSha256: string | null = null
    let predictedBox: Box | null = null
    const selected = row.selection !== null && row.selection.choice !== 'none'
    const choseNone = row.selection?.choice === 'none'
    let maskBits: Uint8Array | null = null
    const disposition = finalOutputDisposition({
      status: row.status,
      verdict: row.boxCheck?.verdict,
      selected,
      maskPath: row.files.mask,
      cutoutPath: row.files.cutout,
    })
    if (disposition === 'invalid') {
      finalOutputStatus = 'invalid'
      artifactError = 'complete-row-missing-selected-artifacts'
    } else if (disposition === 'validate-artifacts') {
      try {
        if (!row.files.mask || !row.files.cutout)
          throw new Error('complete-row-missing-selected-artifacts')
        if (
          !row.files.maskSha256 ||
          !row.files.cutoutSha256 ||
          row.selection?.choice !== row.selectedAlias
        )
          throw new Error('complete-row-artifact-hash-or-selection-missing')
        const mask = await readFinalArtifact(runRoot, row.files.mask, source.image, 'mask')
        const cutout = await readFinalArtifact(runRoot, row.files.cutout, source.image, 'cutout')
        if (mask.hash !== row.files.maskSha256 || cutout.hash !== row.files.cutoutSha256)
          throw new Error('complete-row-artifact-hash-mismatch')
        if (
          !mask.box ||
          !row.boxCheck?.maskDerivedBox ||
          !sameBox(mask.box, row.boxCheck.maskDerivedBox)
        )
          throw new Error('complete-row-box-does-not-match-mask-pixels')
        const nativeCase = nativeRun.cases?.find((item) => item.case_id === source.caseId)
        if (!nativeCase || nativeCase.status !== 'complete' || !nativeCase.row_sha256)
          throw new Error('native-case-row-not-frozen-complete')
        const nativeCaseBytes = await readFile(
          resolve(nativeRunRoot, 'cases', `${source.caseId}.json`),
        )
        if (sha256(nativeCaseBytes) !== nativeCase.row_sha256)
          throw new Error('native-case-row-hash-mismatch')
        const nativeCaseRow = JSON.parse(nativeCaseBytes.toString('utf8')) as {
          mask_candidates?: Array<{ id?: string; mask_path?: string; mask_sha256?: string }>
        }
        const nativeMask = nativeCaseRow.mask_candidates?.find(
          (item) => item.id === row.selectedAlias,
        )
        if (!nativeMask?.mask_path || !nativeMask.mask_sha256 || !mask.bits)
          throw new Error('selected-native-candidate-missing')
        if (!freeze.nativeArtifacts.some((artifact) => artifact.sha256 === nativeMask.mask_sha256))
          throw new Error('selected-native-candidate-not-in-frozen-artifacts')
        const original = await readFinalArtifact(
          nativeRunRoot,
          nativeMask.mask_path,
          source.image,
          'mask',
        )
        if (
          original.hash !== nativeMask.mask_sha256 ||
          !original.bits ||
          original.bits.length !== mask.bits.length
        )
          throw new Error('selected-native-mask-hash-mismatch')
        for (let pixel = 0; pixel < mask.bits.length; pixel++)
          if (mask.bits[pixel] !== original.bits[pixel])
            throw new Error('final-mask-differs-from-selected-native-candidate')
        maskSha256 = mask.hash
        cutoutSha256 = cutout.hash
        maskBits = mask.bits ?? null
        predictedBox = mask.box
        finalOutputStatus = 'valid-complete'
      } catch (error) {
        finalOutputStatus = 'invalid'
        artifactError = error instanceof Error ? error.message : 'final-artifact-invalid'
      }
    }
    const references = truth.presence === 'present' ? truth.boxes : []
    const matches =
      predictedBox && references.length > 0
        ? wholeObjectMatch(predictedBox, references).instances
        : []
    const best = matches.reduce((value, item) => (item.iou > value.iou ? item : value), {
      iou: 0,
      coverage: 0,
      matched: false,
    })
    let bestReferenceMaskIoU: number | null = null
    let evaluableReferenceMaskCount = 0
    if (finalOutputStatus === 'valid-complete' && truth.referenceMasks.length > 0 && maskBits) {
      for (const reference of truth.referenceMasks) {
        try {
          const referenceBits = await readReferenceMask(input.imageRoot, reference, source.image)
          const score = binaryMaskIoU(maskBits, referenceBits)
          bestReferenceMaskIoU = Math.max(bestReferenceMaskIoU ?? 0, score.iou)
          evaluableReferenceMaskCount++
        } catch (error) {
          artifactError ??= `reference-mask:${error instanceof Error ? error.message : 'unavailable'}`
        }
      }
    }
    const wholeBoxPass =
      truth.presence === 'present' && finalOutputStatus === 'valid-complete' && best.matched
    perCase.push({
      caseId: source.caseId,
      stratum: truth.stratum,
      presence: truth.presence,
      status: row.status,
      finalOutputStatus,
      artifactError,
      maskSha256,
      cutoutSha256,
      predictedBox,
      bestIoU: best.iou,
      bestCoverage: Math.min(1, best.coverage),
      wholeBoxPass,
      bestReferenceMaskIoU,
      evaluableReferenceMaskCount,
      candidateCount: row.candidateCount,
      selected,
      choseNone,
      errorCode: (row as { errorCode?: string | null }).errorCode ?? null,
      elapsedMs: row.elapsedMs,
      nativeElapsedMs: row.nativeElapsedMs,
      selectionProviderMs: row.selectionProviderMs,
      boxCheckProviderMs: row.boxCheckProviderMs,
      cutoutElapsedMs: row.cutoutElapsedMs,
    })
  }
  const positives = perCase.filter((item) => item.presence === 'present')
  const negatives = perCase.filter((item) => item.presence === 'absent')
  const strata = ['photo', 'ui', 'map'] as const
  return {
    schema: 'v03-grounded-mask-selection-evaluation-v1',
    runSha256: input.runSha256,
    freezeSha256: input.freezeSha256,
    runStatus: run.status,
    plannedCases: perCase.length,
    positiveDenominator: positives.length,
    positiveWholeBoxPasses: positives.filter((row) => row.wholeBoxPass).length,
    negativeDenominator: negatives.length,
    negativeCorrectNone: negatives.filter((row) => row.status === 'none' && row.choseNone).length,
    negativeFalseCompleteBoxes: negatives.filter(
      (row) => row.finalOutputStatus === 'valid-complete',
    ).length,
    unresolvedOrMissing: perCase.filter(
      (row) => row.finalOutputStatus !== 'valid-complete' && row.status !== 'none',
    ).length,
    cost: {
      admittedPhysicalCalls: run.budget.admittedPhysicalCalls,
      knownCostUsd: run.budget.knownCostUsd,
      unknownCostCalls: run.budget.unknownCostCalls,
      inFlightCalls: run.budget.inFlightCalls,
      maxPhysicalCalls: run.budget.maxPhysicalCalls,
      maxCostUsd: run.budget.maxCostUsd,
      recorderPhysicalCalls: run.recorder?.physicalCalls.length ?? null,
      recorderPersistenceFailures: run.recorder?.persistenceFailures.length ?? null,
    },
    positiveReferenceMaskCases: positives.filter((row) => row.bestReferenceMaskIoU !== null).length,
    stratumSummary: Object.fromEntries(
      strata.map((stratum) => {
        const group = perCase.filter((row) => row.stratum === stratum)
        const groupPositives = group.filter((row) => row.presence === 'present')
        const groupNegatives = group.filter((row) => row.presence === 'absent')
        return [
          stratum,
          {
            cases: group.length,
            positives: groupPositives.length,
            positiveWholeBoxPasses: groupPositives.filter((row) => row.wholeBoxPass).length,
            negatives: groupNegatives.length,
            negativeCorrectNone: groupNegatives.filter(
              (row) => row.status === 'none' && row.choseNone,
            ).length,
            negativeFalseCompleteBoxes: groupNegatives.filter(
              (row) => row.finalOutputStatus === 'valid-complete',
            ).length,
          },
        ]
      }),
    ),
    perCase,
  }
}

export async function loadAndEvaluateGroundedMaskSelection(args: {
  runRoot: string
  imageRoot?: string
  expectedRunSha256: string
  expectedFreezeSha256: string
}) {
  const runRoot = await realpath(args.runRoot)
  const runBytes = await readFile(resolve(runRoot, 'run.json'))
  const freezeBytes = await readFile(resolve(runRoot, 'freeze.json'))
  const runSha256 = sha256(runBytes)
  const freezeSha256 = sha256(freezeBytes)
  const corpus = await loadFreshCorpus(
    { manifests: [...v03PilotManifests], imageRoot: args.imageRoot ?? v03PilotRepositoryRoot },
    new AbortController().signal,
  )
  const result = await evaluateGroundedMaskSelection({
    corpus: corpus.cases,
    truth: await loadV03PilotTruth(),
    runRoot,
    runRecord: JSON.parse(runBytes.toString('utf8')) as unknown,
    freezeRecord: JSON.parse(freezeBytes.toString('utf8')) as unknown,
    runSha256,
    expectedRunSha256: args.expectedRunSha256,
    freezeSha256,
    expectedFreezeSha256: args.expectedFreezeSha256,
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
  const expectedFreezeSha256 = values.get('freeze-sha256')
  const output = values.get('output')
  const imageRoot = values.get('image-root')
  if (!runRoot || !expectedRunSha256 || !expectedFreezeSha256 || !output)
    throw new Error('--run, --run-sha256, --freeze-sha256, and --output are required')
  return {
    runRoot: resolve(runRoot),
    expectedRunSha256,
    expectedFreezeSha256,
    output: resolve(output),
    ...(imageRoot ? { imageRoot: resolve(imageRoot) } : {}),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  loadAndEvaluateGroundedMaskSelection(args)
    .then(async (result) => {
      await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
      process.stdout.write(`${JSON.stringify({ output: args.output, status: result.runStatus })}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'H3b evaluator failed'}\n`)
      process.exitCode = 1
    })
}
