import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const inputManifest =
  '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/photo-inputs.json'
const truthManifest =
  '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/photoTruth.json'
const segmentationRoot = resolve(repoRoot, '.run/v03/segmentation-prompt-probe-v1')
const outputRoot = resolve(repoRoot, '.run/v03/semantic-mask-probe-v1')

function sha256(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function binaryMask(path: string, width: number, height: number, expectedSha256: string) {
  const bytes = await readFile(path)
  assert(sha256(bytes) === expectedSha256, `Mask hash mismatch: ${path}`)
  const result = await sharp(bytes, { limitInputPixels: 1_048_576, failOn: 'error' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  assert(
    result.info.width === width && result.info.height === height,
    `Mask dimension mismatch: ${path}`,
  )
  const mask = new Uint8Array(result.data.length)
  for (let index = 0; index < mask.length; index++) {
    const value = result.data[index]
    assert(value === 0 || value === 255, `Nonbinary truth mask: ${path}`)
    mask[index] = value === 255 ? 1 : 0
  }
  bytes.fill(0)
  return mask
}

function score(predicted: Uint8Array, truth: Uint8Array) {
  assert(predicted.length === truth.length, 'Prediction and truth canvases differ')
  let intersection = 0
  let union = 0
  let truthPixels = 0
  for (let index = 0; index < truth.length; index++) {
    const p = predicted[index] === 1
    const t = truth[index] === 1
    if (p && t) intersection++
    if (p || t) union++
    if (t) truthPixels++
  }
  return {
    iou: union ? intersection / union : 1,
    referenceCoverage: truthPixels ? intersection / truthPixels : 1,
  }
}

async function main() {
  const freezeBytes = await readFile(resolve(outputRoot, 'freeze.json'))
  const freeze = JSON.parse(freezeBytes.toString('utf8')) as {
    sourceSha256: string
    evaluatorSha256: string
    inputManifestSha256: string
    segmentationSummarySha256: string
    cases: Array<{
      caseId: string
      target: string
      source: { width: number; height: number }
      candidates: Array<{ id: string; path: string; sha256: string; maskSha256: string }>
    }>
  }
  const probeBytes = await readFile(resolve(repoRoot, 'benchmarks/v03/semantic-mask-probe.ts'))
  const evaluatorBytes = await readFile(fileURLToPath(import.meta.url))
  const inputBytes = await readFile(inputManifest)
  const segmentationBytes = await readFile(resolve(segmentationRoot, 'summary.json'))
  const decisionBytes = await readFile(resolve(outputRoot, 'summary.json'))
  assert(sha256(probeBytes) === freeze.sourceSha256, 'Probe source changed after request freeze')
  assert(
    sha256(evaluatorBytes) === freeze.evaluatorSha256,
    'Evaluator source changed after request freeze',
  )
  assert(sha256(inputBytes) === freeze.inputManifestSha256, 'Input manifest changed after freeze')
  assert(
    sha256(segmentationBytes) === freeze.segmentationSummarySha256,
    'Candidate summary changed after freeze',
  )
  const decision = JSON.parse(decisionBytes.toString('utf8')) as {
    schema: string
    freezeSha256: string
    results: Array<{
      caseId: string
      status: string
      selected: string | null
      probabilities: Record<string, number> | null
    }>
    physicalCalls: number
  }
  assert(
    decision.schema === 'v03-semantic-mask-probe-results-v1',
    'Unexpected decision results schema',
  )
  assert(decision.freezeSha256 === sha256(freezeBytes), 'Decision result belongs to another freeze')
  assert(
    decision.results.length === freeze.cases.length,
    'Decision result count differs from freeze',
  )
  assert(decision.physicalCalls <= 5, 'Physical call cap exceeded')
  const inputRows = JSON.parse(inputBytes.toString('utf8')) as Array<{
    caseId: string
    image: { width: number; height: number }
  }>
  const truthRows = JSON.parse((await readFile(truthManifest)).toString('utf8')) as Array<{
    caseId: string
    referenceMasks: Array<{ path: string; sha256: string; width: number; height: number }>
  }>
  const inputById = new Map(inputRows.map((item) => [item.caseId, item]))
  const truthById = new Map(truthRows.map((item) => [item.caseId, item]))
  const segmentation = JSON.parse(segmentationBytes.toString('utf8')) as {
    cases: Array<{
      caseId: string
      profiles: Array<{ profile: string; nativeChosenIndex: number | null }>
    }>
  }
  const segmentationById = new Map(segmentation.cases.map((item) => [item.caseId, item]))
  const choiceById = new Map(decision.results.map((item) => [item.caseId, item]))
  const rows: Array<Record<string, unknown>> = []
  for (const item of freeze.cases) {
    const input = inputById.get(item.caseId)
    const truthEntry = truthById.get(item.caseId)
    const chosen = choiceById.get(item.caseId)
    const nativeIndex = segmentationById
      .get(item.caseId)
      ?.profiles.find((profile) => profile.profile === 'point-seed')?.nativeChosenIndex
    assert(
      input && truthEntry && truthEntry.referenceMasks.length === 1 && chosen,
      `Missing exposed truth or choice ${item.caseId}`,
    )
    assert(
      input.image.width === item.source.width && input.image.height === item.source.height,
      `Source dimensions changed ${item.caseId}`,
    )
    const truthInfo = truthEntry.referenceMasks[0]!
    assert(
      truthInfo.width === item.source.width && truthInfo.height === item.source.height,
      `Truth dimensions differ ${item.caseId}`,
    )
    const truthPath = resolve(
      '/root/work/zorya-classifier-worktrees/v02/independent-oracle-proof/.run/oracle-proof/combined-corpus-v1/imageRoot',
      truthInfo.path,
    )
    const truth = await binaryMask(truthPath, truthInfo.width, truthInfo.height, truthInfo.sha256)
    try {
      const candidateScores = []
      for (const candidate of item.candidates) {
        assert(candidate.maskSha256, `Candidate mask hash absent ${item.caseId}/${candidate.id}`)
        const probeSummary = JSON.parse(segmentationBytes.toString('utf8')) as {
          cases: Array<{
            caseId: string
            profiles: Array<{ profile: string; maskFile: string; maskSha256: string }>
          }>
        }
        const profile = probeSummary.cases
          .find((row) => row.caseId === item.caseId)
          ?.profiles.find((row) => row.profile === 'point-seed')
        assert(profile && profile.maskSha256, `Candidate mask profile missing ${item.caseId}`)
        const raw = await readFile(resolve(segmentationRoot, profile.maskFile))
        assert(sha256(raw) === profile.maskSha256, `Candidate planes changed ${item.caseId}`)
        const planeBytes = truth.length
        const index = ['A', 'B', 'C', 'D'].indexOf(candidate.id)
        assert(
          index >= 0 && raw.length === planeBytes * 4,
          `Candidate plane data invalid ${item.caseId}/${candidate.id}`,
        )
        const plane = raw.subarray(index * planeBytes, (index + 1) * planeBytes)
        assert(
          sha256(plane) === candidate.maskSha256,
          `Candidate mask pin changed ${item.caseId}/${candidate.id}`,
        )
        candidateScores.push({ id: candidate.id, ...score(plane, truth) })
        raw.fill(0)
      }
      const selectedScore = candidateScores.find((row) => row.id === chosen.selected) ?? null
      const nativeId =
        nativeIndex === null || nativeIndex === undefined
          ? null
          : ['A', 'B', 'C', 'D'][nativeIndex]!
      const nativeScore = candidateScores.find((row) => row.id === nativeId) ?? null
      const oracleBest = candidateScores.reduce((best, current) =>
        current.iou > best.iou ? current : best,
      )
      rows.push({
        caseId: item.caseId,
        target: item.target,
        decisionStatus: chosen.status,
        selected: chosen.selected,
        probabilities: chosen.probabilities,
        nativeScorePickedId: nativeId,
        nativeScorePicked: nativeScore,
        selectedCandidate: selectedScore,
        oracleBestDiagnostic: oracleBest,
        candidates: candidateScores,
      })
    } finally {
      truth.fill(0)
    }
  }
  const numeric = (values: Array<number | null>) => {
    const present = values.filter((value): value is number => value !== null)
    return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null
  }
  const summary = {
    schema: 'v03-semantic-mask-probe-evaluation-v1',
    decisionSummarySha256: sha256(decisionBytes),
    evaluatorSha256: sha256(evaluatorBytes),
    cases: rows.length,
    completeDecisions: rows.filter((row) => row.decisionStatus === 'complete').length,
    selectedFullCandidateCount: rows.filter((row) =>
      ['A', 'B', 'C', 'D'].includes(String(row.selected)),
    ).length,
    nativeSelectedMaskMeanIoU: numeric(
      rows.map((row) => (row.nativeScorePicked as { iou: number } | null)?.iou ?? null),
    ),
    semanticSelectedMaskMeanIoU: numeric(
      rows.map((row) => (row.selectedCandidate as { iou: number } | null)?.iou ?? null),
    ),
    oracleBestMaskMeanIoU: numeric(
      rows.map((row) => (row.oracleBestDiagnostic as { iou: number }).iou),
    ),
    rows,
  }
  await writeFile(resolve(outputRoot, 'evaluation.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    flag: 'wx',
  })
  process.stdout.write(
    `${JSON.stringify({ status: 'evaluated', cases: summary.cases, completeDecisions: summary.completeDecisions, nativeMeanIoU: summary.nativeSelectedMaskMeanIoU, semanticMeanIoU: summary.semanticSelectedMaskMeanIoU, oracleBestMeanIoU: summary.oracleBestMaskMeanIoU })}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Evaluation failed'}\n`)
    process.exitCode = 1
  })
