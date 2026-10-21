import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromInstalledWorkspace = createRequire(
  '/root/work/zorya-classifier/node_modules/package.json',
)
const sharp = requireFromInstalledWorkspace('sharp') as typeof import('sharp')
const artifactRoot = resolve(repoRoot, '.run/v03/segmentation-prompt-probe-v1')
const imageRoot =
  '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/imageRoot'
const inputManifest =
  '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/photo-inputs.json'
const truthManifest =
  '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/photoTruth.json'
const inferenceSource = resolve(repoRoot, 'benchmarks/v03/segmentation-prompt-probe.ts')

type Rect = { left: number; top: number; width: number; height: number }
type TruthMask = { path: string; sha256: string; width: number; height: number }
type CandidateProfile = {
  profile: 'point-seed' | 'seed-plus-box'
  maskFile: string
  maskSha256: string
  nativeChosenIndex: number | null
  seedHits: boolean[]
}
type ProbeCase = {
  caseId: string
  imageSha256: string
  dimensions: { width: number; height: number }
  seed: Rect
  profiles: CandidateProfile[]
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function readMask(reference: TruthMask, width: number, height: number) {
  assert(reference.width === width && reference.height === height, 'Truth mask dimensions differ')
  const sourceBytes = await readFile(resolve(imageRoot, reference.path))
  assert(digest(sourceBytes) === reference.sha256, 'Truth mask SHA-256 mismatch')
  const pipeline = sharp(sourceBytes, { limitInputPixels: 1_048_576, failOn: 'error' })
  try {
    const decoded = await pipeline.greyscale().raw().toBuffer({ resolveWithObject: true })
    assert(
      decoded.info.width === width && decoded.info.height === height,
      'Decoded truth dimensions differ',
    )
    const mask = new Uint8Array(decoded.data.length)
    for (let index = 0; index < mask.length; index++) {
      const value = decoded.data[index]
      assert(value === 0 || value === 255, 'Truth mask must be binary')
      mask[index] = value === 255 ? 1 : 0
    }
    return { sourceBytes, mask }
  } finally {
    pipeline.destroy()
  }
}

function maskMetrics(predicted: Uint8Array, reference: Uint8Array) {
  assert(predicted.length === reference.length, 'Mask canvases differ')
  let intersection = 0
  let union = 0
  let referencePixels = 0
  for (let index = 0; index < predicted.length; index++) {
    const a = predicted[index] === 1
    const b = reference[index] === 1
    if (a && b) intersection++
    if (a || b) union++
    if (b) referencePixels++
  }
  return {
    iou: union > 0 ? intersection / union : 1,
    referenceCoverage: referencePixels > 0 ? intersection / referencePixels : 1,
    intersection,
    union,
    referencePixels,
  }
}

function tightBox(mask: Uint8Array, width: number, height: number): Rect | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x] === 1) {
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
  return right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function boxMetrics(predicted: Rect | null, reference: Rect | null) {
  if (!predicted || !reference) return { iou: 0, referenceCoverage: 0 }
  const left = Math.max(predicted.left, reference.left)
  const top = Math.max(predicted.top, reference.top)
  const right = Math.min(predicted.left + predicted.width, reference.left + reference.width)
  const bottom = Math.min(predicted.top + predicted.height, reference.top + reference.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union =
    predicted.width * predicted.height + reference.width * reference.height - intersection
  return {
    iou: union > 0 ? intersection / union : 0,
    referenceCoverage: intersection / (reference.width * reference.height),
  }
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

async function main() {
  const freezeBytes = await readFile(resolve(artifactRoot, 'freeze.json'))
  const freezeSha256 = digest(freezeBytes)
  const freeze = JSON.parse(freezeBytes.toString('utf8')) as {
    scriptSha256: string
    manifests: { photoInputsSha256: string; v3SummarySha256: string }
    selectedCaseIds: string[]
    images: Array<{ caseId: string; sha256: string }>
  }
  const sourceBytes = await readFile(inferenceSource)
  assert(digest(sourceBytes) === freeze.scriptSha256, 'Frozen probe source changed')
  const evaluatorBytes = await readFile(fileURLToPath(import.meta.url))
  const inputBytes = await readFile(inputManifest)
  assert(
    digest(inputBytes) === freeze.manifests.photoInputsSha256,
    'Frozen source manifest changed',
  )
  const inferenceBytes = await readFile(resolve(artifactRoot, 'summary.json'))
  const inference = JSON.parse(inferenceBytes.toString('utf8')) as {
    status: string
    freezeSha256: string
    physicalProviderHttpCalls: number
    nativeEncoderRuns: number
    nativeDecoderRuns: number
    cases: ProbeCase[]
  }
  assert(inference.status === 'complete', 'Inference result is incomplete')
  assert(inference.freezeSha256 === freezeSha256, 'Inference result has another freeze')
  assert(inference.physicalProviderHttpCalls === 0, 'Probe unexpectedly made an HTTP provider call')
  assert(
    inference.nativeEncoderRuns === 5 && inference.nativeDecoderRuns === 10,
    'Native inference count differs from freeze',
  )
  assert(
    inference.cases.length === freeze.selectedCaseIds.length,
    'Inference case count differs from freeze',
  )

  // Truth is deliberately loaded only after the complete inference summary and all masks exist.
  const truthBytes = await readFile(truthManifest)
  const truths = JSON.parse(truthBytes.toString('utf8')) as Array<{
    caseId: string
    referenceMasks: TruthMask[]
  }>
  const truthById = new Map(truths.map((row) => [row.caseId, row]))
  const caseRows = [] as Array<Record<string, unknown>>
  for (const item of inference.cases) {
    assert(
      freeze.selectedCaseIds.includes(item.caseId),
      `Unexpected case in inference results: ${item.caseId}`,
    )
    const expectedImage = freeze.images.find((image) => image.caseId === item.caseId)
    assert(
      expectedImage?.sha256 === item.imageSha256,
      `Source image digest differs: ${item.caseId}`,
    )
    const truth = truthById.get(item.caseId)
    assert(
      truth && truth.referenceMasks.length === 1,
      `Expected one instance mask for ${item.caseId}`,
    )
    const reference = await readMask(
      truth.referenceMasks[0]!,
      item.dimensions.width,
      item.dimensions.height,
    )
    try {
      const referenceBox = tightBox(reference.mask, item.dimensions.width, item.dimensions.height)
      assert(referenceBox, `Empty reference mask: ${item.caseId}`)
      for (const profile of item.profiles) {
        const planeBytes = item.dimensions.width * item.dimensions.height
        const rawMaskBytes = await readFile(resolve(artifactRoot, profile.maskFile))
        assert(
          digest(rawMaskBytes) === profile.maskSha256,
          `Prediction masks changed: ${item.caseId}/${profile.profile}`,
        )
        assert(
          rawMaskBytes.length === planeBytes * 4,
          `Four candidate masks required: ${item.caseId}/${profile.profile}`,
        )
        const candidates = Array.from({ length: 4 }, (_, index) =>
          rawMaskBytes.subarray(index * planeBytes, (index + 1) * planeBytes),
        )
        const metrics = candidates.map((candidate) => maskMetrics(candidate, reference.mask))
        const boxes = candidates.map((candidate) =>
          tightBox(candidate, item.dimensions.width, item.dimensions.height),
        )
        const boxMetricsByCandidate = boxes.map((box) => boxMetrics(box, referenceBox))
        const oracleBestIndex = metrics.reduce(
          (best, current, index, all) => (current.iou > all[best]!.iou ? index : best),
          0,
        )
        const nativeChosenIndex = profile.nativeChosenIndex
        const nativeMask =
          nativeChosenIndex === null
            ? maskMetrics(new Uint8Array(planeBytes), reference.mask)
            : metrics[nativeChosenIndex]!
        const nativeBox =
          nativeChosenIndex === null
            ? { iou: 0, referenceCoverage: 0 }
            : boxMetricsByCandidate[nativeChosenIndex]!
        caseRows.push({
          caseId: item.caseId,
          profile: profile.profile,
          seed: item.seed,
          candidateCount: 4,
          seedHit: profile.seedHits.some(Boolean),
          nativeChosenIndex,
          nativeChosen: {
            ...nativeMask,
            boxIoU: nativeBox.iou,
            boxCoverage: nativeBox.referenceCoverage,
          },
          oracleBestIndex,
          oracleBestDiagnostic: {
            ...metrics[oracleBestIndex]!,
            boxIoU: boxMetricsByCandidate[oracleBestIndex]!.iou,
            boxCoverage: boxMetricsByCandidate[oracleBestIndex]!.referenceCoverage,
          },
          candidates: metrics.map((mask, index) => ({
            ...mask,
            boxIoU: boxMetricsByCandidate[index]!.iou,
            boxCoverage: boxMetricsByCandidate[index]!.referenceCoverage,
          })),
        })
        rawMaskBytes.fill(0)
      }
    } finally {
      reference.mask.fill(0)
      reference.sourceBytes.fill(0)
    }
  }
  const aggregates = (['point-seed', 'seed-plus-box'] as const).map((profile) => {
    const rows = caseRows.filter((row) => row.profile === profile) as Array<{
      nativeChosen: { iou: number; referenceCoverage: number; boxIoU: number; boxCoverage: number }
      nativeChosenIndex: number | null
      oracleBestDiagnostic: {
        iou: number
        referenceCoverage: number
        boxIoU: number
        boxCoverage: number
      }
      seed: Rect
      caseId: string
    }>
    const numeric = (
      key: keyof (typeof rows)[number]['nativeChosen'],
      selector: 'nativeChosen' | 'oracleBestDiagnostic',
    ) => mean(rows.map((row) => row[selector][key]))
    return {
      profile,
      caseCount: rows.length,
      nativeChosen: {
        seedHitCases: rows.filter((row) => row.nativeChosenIndex !== null).length,
        meanMaskIoU: numeric('iou', 'nativeChosen'),
        meanMaskCoverage: numeric('referenceCoverage', 'nativeChosen'),
        meanBoxIoU: numeric('boxIoU', 'nativeChosen'),
        meanBoxCoverage: numeric('boxCoverage', 'nativeChosen'),
      },
      oracleBestDiagnostic: {
        meanMaskIoU: numeric('iou', 'oracleBestDiagnostic'),
        meanMaskCoverage: numeric('referenceCoverage', 'oracleBestDiagnostic'),
        meanBoxIoU: numeric('boxIoU', 'oracleBestDiagnostic'),
        meanBoxCoverage: numeric('boxCoverage', 'oracleBestDiagnostic'),
      },
    }
  })
  const report = {
    schema: 'v03-segmentation-prompt-probe-evaluation-v1',
    evaluationSourceSha256: digest(evaluatorBytes),
    inferenceSourceSha256: freeze.scriptSha256,
    freezeSha256,
    inferenceSummarySha256: digest(inferenceBytes),
    truthManifestSha256: digest(truthBytes),
    caseCount: caseRows.length,
    physicalProviderHttpCalls: inference.physicalProviderHttpCalls,
    nativeEncoderRuns: inference.nativeEncoderRuns,
    nativeDecoderRuns: inference.nativeDecoderRuns,
    aggregates,
    cases: caseRows,
  }
  await writeFile(
    resolve(artifactRoot, 'evaluation.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: 'wx' },
  )
  process.stdout.write(
    `${JSON.stringify({ status: 'evaluated', caseRows: caseRows.length, aggregates })}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Evaluation failed'}\n`)
    process.exitCode = 1
  })
}
