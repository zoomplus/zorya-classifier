import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'

const H5A_RUN_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h5a-native-proposals-v2'
const H3_NATIVE_ROOT = '/root/work/zorya-classifier/.run/v03/grounded-proposals-h3-run-02'
const H4E_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1'
const H5A_RUN_SHA256 = '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0'
const H5A_FREEZE_SHA256 = 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566'
const CASE_IDS = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]

type SourceFamily = 'h3b-dino-sam2' | 'omni-sam2' | 'h4e-sam2'
type H5Family = 'D' | 'U'
type CandidateScore = {
  family: string
  id: string
  maskSha256: string
  score: { pass: boolean } | null
}
type AvailabilityCase = {
  caseId: string
  presence: 'present' | 'absent'
  sourceSha256: string
  sourceDimensions: { width: number; height: number }
  families: Record<string, { available: boolean; candidateReceipts: CandidateScore[] }>
}
export type H5AvailabilityReport = {
  schema: 'v03-h5a-native-proposal-availability-evaluation-v1'
  runSha256: string
  freezeSha256: string
  gate: { iouAtLeast: number; referenceCoverageAtLeast: number; sameCandidateAndReference: boolean }
  perCase: AvailabilityCase[]
}

export type H5CandidateRosterEntry = {
  family: H5Family
  composerAlias: string
  sourceFamily: SourceFamily
  sourceAlias: string
  candidateMaskSha256: string
  sourceMaskPath: string
}
export type H5Nomination = {
  family: H5Family
  topFour: string[]
  nomineeAliases: string[]
}
export type H5ReplayRow = {
  case_id: string
  status: 'located' | 'unknown' | 'error'
  nominations: H5Nomination[]
  candidateRoster: H5CandidateRosterEntry[]
  family?: H5Family
  composerAlias?: string
  sourceFamily?: SourceFamily
  sourceAlias?: string
  candidateMaskSha256?: string
  selectedMaskPath?: string
  selectedMaskSha256?: string
  errorCode?: string | null
}
export type H5ReplayEnvelope = {
  schema: 'v03-h5b-paid-replay-run-v1'
  status: string
  freezeMatched: boolean
  case_ids: string[]
  h5a: { runSha256: string; freezeSha256: string }
  budget: {
    physicalCalls: number
    knownCostUsd: number
    unknownCostCalls: number
    inFlightCalls: number
    persistenceFailures: number
    maxPhysicalCalls: number
    maxCostUsd: number
  }
  rows: H5ReplayRow[]
}

type CandidateReference = {
  sourceFamily: SourceFamily
  sourceAlias: string
  maskSha256: string
  pass: boolean
}
type EvaluatedRow = {
  caseId: string
  presence: 'present' | 'absent'
  status: H5ReplayRow['status']
  unionAvailable: boolean
  nominatedAvailable: boolean
  selectedSameMaskPass: boolean
  selectedMaskArtifactValid: boolean
  selected: boolean
  correctNegativeUnknown: boolean | null
  errorCode: string | null
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function toSourceFamily(name: string): SourceFamily {
  if (name === 'h3-dino-sam2') return 'h3b-dino-sam2'
  if (name === 'omni-sam2' || name === 'h4e-sam2') return name
  throw new Error(`unexpected-candidate-family-${name}`)
}

function isPass(receipt: CandidateScore): boolean {
  return receipt.score?.pass === true
}

function indexedReceipts(row: AvailabilityCase): CandidateReference[] {
  return ['h3-dino-sam2', 'omni-sam2', 'h4e-sam2'].flatMap((name) =>
    (row.families[name]?.candidateReceipts ?? []).map((receipt) => ({
      sourceFamily: toSourceFamily(receipt.family),
      sourceAlias: receipt.id,
      maskSha256: receipt.maskSha256,
      pass: isPass(receipt),
    })),
  )
}

export function evaluateH5Selection(
  availability: H5AvailabilityReport,
  replay: H5ReplayEnvelope,
  verifiedSelectedMaskRows: ReadonlySet<string>,
) {
  assert(availability.schema === 'v03-h5a-native-proposal-availability-evaluation-v1', 'h5a-schema')
  assert(availability.runSha256 === H5A_RUN_SHA256, 'h5a-run-lock')
  assert(availability.freezeSha256 === H5A_FREEZE_SHA256, 'h5a-freeze-lock')
  assert(availability.gate.iouAtLeast === 0.5, 'h5a-iou-gate-changed')
  assert(availability.gate.referenceCoverageAtLeast === 0.9, 'h5a-coverage-gate-changed')
  assert(availability.gate.sameCandidateAndReference, 'h5a-gate-instance-changed')
  assert(replay.schema === 'v03-h5b-paid-replay-run-v1', 'h5b-schema')
  assert(replay.h5a.runSha256 === H5A_RUN_SHA256, 'h5b-h5a-run-lock')
  assert(replay.h5a.freezeSha256 === H5A_FREEZE_SHA256, 'h5b-h5a-freeze-lock')
  assert(JSON.stringify(replay.case_ids) === JSON.stringify(CASE_IDS), 'h5b-case-order')
  assert(replay.rows.length === 12, 'h5b-row-count')
  assert(replay.budget.physicalCalls <= replay.budget.maxPhysicalCalls, 'h5b-call-budget')
  assert(replay.budget.maxPhysicalCalls <= 36, 'h5b-call-cap')
  assert(replay.budget.knownCostUsd <= replay.budget.maxCostUsd, 'h5b-cost-budget')
  assert(replay.budget.maxCostUsd <= 2, 'h5b-cost-cap')

  const truthByCase = new Map(availability.perCase.map((row) => [row.caseId, row]))
  assert(availability.perCase.length === 12, 'h5a-case-count')
  const replayByCase = new Map(replay.rows.map((row) => [row.case_id, row]))
  assert(replayByCase.size === 12, 'h5b-duplicate-case')
  const rows: EvaluatedRow[] = CASE_IDS.map((caseId) => {
    const truth = truthByCase.get(caseId)
    const replayRow = replayByCase.get(caseId)
    assert(truth && replayRow, `h5b-case-missing-${caseId}`)
    const receipts = indexedReceipts(truth)
    const rosterByAlias = new Map(
      replayRow.candidateRoster.map((entry) => [entry.composerAlias, entry]),
    )
    assert(
      rosterByAlias.size === replayRow.candidateRoster.length,
      `h5b-roster-duplicate-${caseId}`,
    )
    for (const entry of replayRow.candidateRoster) {
      assert(entry.family === 'D' || entry.family === 'U', `h5b-roster-family-${caseId}`)
      assert(entry.composerAlias.length > 0, `h5b-roster-alias-${caseId}`)
      assert(/^[a-f0-9]{64}$/u.test(entry.candidateMaskSha256), `h5b-roster-hash-${caseId}`)
    }
    let nominatedAvailable = false
    for (const nomination of replayRow.nominations) {
      assert(
        nomination.family === 'D' || nomination.family === 'U',
        `h5b-nomination-family-${caseId}`,
      )
      for (const alias of nomination.nomineeAliases) {
        const candidate = rosterByAlias.get(alias)
        assert(
          candidate && candidate.family === nomination.family,
          `h5b-nominee-unmapped-${caseId}-${alias}`,
        )
        const reference = receipts.find(
          (item) =>
            item.sourceFamily === candidate.sourceFamily &&
            item.sourceAlias === candidate.sourceAlias &&
            item.maskSha256 === candidate.candidateMaskSha256,
        )
        if (reference?.pass) nominatedAvailable = true
      }
    }
    const unionAvailable = truth.families.union?.available === true
    const selected = replayRow.status === 'located'
    let selectedSameMaskPass = false
    let selectedMaskArtifactValid = false
    if (selected) {
      const candidate = replayRow.candidateRoster.find(
        (entry) =>
          entry.family === replayRow.family &&
          entry.composerAlias === replayRow.composerAlias &&
          entry.sourceFamily === replayRow.sourceFamily &&
          entry.sourceAlias === replayRow.sourceAlias &&
          entry.candidateMaskSha256 === replayRow.candidateMaskSha256,
      )
      assert(candidate, `h5b-selected-roster-mismatch-${caseId}`)
      const reference = receipts.find(
        (item) =>
          item.sourceFamily === candidate.sourceFamily &&
          item.sourceAlias === candidate.sourceAlias &&
          item.maskSha256 === candidate.candidateMaskSha256,
      )
      selectedSameMaskPass = reference?.pass === true
      selectedMaskArtifactValid = verifiedSelectedMaskRows.has(caseId)
      assert(
        replayRow.selectedMaskPath && replayRow.selectedMaskSha256,
        `h5b-selected-mask-missing-${caseId}`,
      )
      assert(
        /^[a-f0-9]{64}$/u.test(replayRow.selectedMaskSha256),
        `h5b-selected-mask-hash-${caseId}`,
      )
    } else {
      assert(
        !replayRow.selectedMaskPath && !replayRow.selectedMaskSha256,
        `h5b-nonlocated-has-selected-mask-${caseId}`,
      )
    }
    const correctNegativeUnknown =
      truth.presence === 'absent' ? replayRow.status === 'unknown' && !selected : null
    return {
      caseId,
      presence: truth.presence,
      status: replayRow.status,
      unionAvailable,
      nominatedAvailable,
      selectedSameMaskPass,
      selectedMaskArtifactValid,
      selected,
      correctNegativeUnknown,
      errorCode: replayRow.errorCode ?? null,
    }
  })

  const positiveRows = rows.filter((row) => row.presence === 'present')
  const negatives = rows.filter((row) => row.presence === 'absent')
  return {
    schema: 'v03-h5b-independent-selection-evaluation-v1',
    production: {
      status: replay.status,
      freezeMatched: replay.freezeMatched,
      h5aRunSha256: replay.h5a.runSha256,
      h5aFreezeSha256: replay.h5a.freezeSha256,
      budget: replay.budget,
      integrityPass:
        replay.freezeMatched &&
        replay.budget.unknownCostCalls === 0 &&
        replay.budget.inFlightCalls === 0 &&
        replay.budget.persistenceFailures === 0,
    },
    positiveSummary: {
      denominator: positiveRows.length,
      unionAvailable: positiveRows.filter((row) => row.unionAvailable).length,
      nominatedAvailable: positiveRows.filter((row) => row.nominatedAvailable).length,
      selectedSameMaskPass: positiveRows.filter(
        (row) => row.selected && row.selectedSameMaskPass && row.selectedMaskArtifactValid,
      ).length,
      generationLoss: positiveRows.filter((row) => !row.unionAvailable).map((row) => row.caseId),
      nominationLoss: positiveRows
        .filter((row) => row.unionAvailable && !row.nominatedAvailable)
        .map((row) => row.caseId),
      finalSelectionLoss: positiveRows
        .filter(
          (row) =>
            row.nominatedAvailable &&
            !(row.selected && row.selectedSameMaskPass && row.selectedMaskArtifactValid),
        )
        .map((row) => row.caseId),
    },
    negativeSummary: {
      denominator: negatives.length,
      correctUnknown: negatives.filter((row) => row.correctNegativeUnknown).length,
      selectedOutputs: negatives.filter((row) => row.selected).map((row) => row.caseId),
      rows: negatives,
    },
    allRows: rows,
  }
}

async function sha256(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function assertSameBinaryMask(
  sourcePath: string,
  outputPath: string,
  expectedSourceSha256: string,
  expectedOutputSha256: string,
  width: number,
  height: number,
) {
  assert((await sha256(sourcePath)) === expectedSourceSha256, 'h5b-source-mask-hash')
  assert((await sha256(outputPath)) === expectedOutputSha256, 'h5b-selected-mask-hash')
  const [source, output] = await Promise.all([
    sharp(sourcePath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(outputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  assert(source.info.width === width && source.info.height === height, 'h5b-source-mask-size')
  assert(output.info.width === width && output.info.height === height, 'h5b-output-mask-size')
  assert(source.info.channels === 1 && output.info.channels === 1, 'h5b-mask-channel-count')
  assert(source.data.equals(output.data), 'h5b-selected-mask-pixels-differ')
}

export async function verifySelectedMaskArtifacts(
  runRoot: string,
  replay: H5ReplayEnvelope,
  availability: H5AvailabilityReport,
): Promise<Set<string>> {
  const root = await realpath(runRoot)
  const sourceRoot = await realpath(H5A_RUN_ROOT)
  const verified = new Set<string>()
  for (const row of replay.rows) {
    if (row.status !== 'located') continue
    const selected = row.candidateRoster.find(
      (item) =>
        item.family === row.family &&
        item.composerAlias === row.composerAlias &&
        item.sourceFamily === row.sourceFamily &&
        item.sourceAlias === row.sourceAlias &&
        item.candidateMaskSha256 === row.candidateMaskSha256,
    )
    assert(selected, `h5b-selected-source-missing-${row.case_id}`)
    assert(!isAbsolute(selected.sourceMaskPath), 'h5b-source-mask-path-absolute')
    assert(!isAbsolute(row.selectedMaskPath ?? ''), 'h5b-output-mask-path-absolute')
    const sourcePath = resolve(sourceRoot, selected.sourceMaskPath)
    const outputPath = resolve(root, row.selectedMaskPath ?? '')
    for (const [base, candidate] of [[root, outputPath]] as const) {
      const part = relative(base, candidate)
      assert(part && part !== '..' && !part.startsWith(`..${sep}`), 'h5b-mask-path-escape')
      const actual = await realpath(candidate)
      const actualPart = relative(base, actual)
      assert(
        actualPart && actualPart !== '..' && !actualPart.startsWith(`..${sep}`),
        'h5b-mask-symlink-escape',
      )
    }
    const sourcePathActual = await realpath(sourcePath)
    const outputPathActual = await realpath(outputPath)
    const allowedSourceRoots = await Promise.all(
      [sourceRoot, realpath(H3_NATIVE_ROOT), realpath(H4E_ROOT)].map((path) => path),
    )
    assert(
      allowedSourceRoots.some((base) => {
        const part = relative(base, sourcePathActual)
        return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      }),
      'h5b-source-mask-outside-pinned-roots',
    )
    const availabilityCase = availability.perCase.find((item) => item.caseId === row.case_id)
    assert(availabilityCase, `h5b-source-dimensions-missing-${row.case_id}`)
    await assertSameBinaryMask(
      sourcePathActual,
      outputPathActual,
      selected.candidateMaskSha256,
      row.selectedMaskSha256 ?? '',
      availabilityCase.sourceDimensions.width,
      availabilityCase.sourceDimensions.height,
    )
    verified.add(row.case_id)
  }
  return verified
}
