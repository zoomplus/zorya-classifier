import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import sharp from 'sharp'

const H5A_RUN_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h5a-native-proposals-v2'
const H3_NATIVE_ROOT = '/root/work/zorya-classifier/.run/v03/grounded-proposals-h3-run-02'
const H4E_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1'
const IMAGE_ROOT = '/root/work/zorya-classifier-worktrees/v02/corpus'
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
  composer_alias: string
  source_family: SourceFamily
  source_alias: string
  candidate_mask_sha256: string
  source_mask_path: string
  roster_ordinal: number
}
export type H5Nomination = {
  family: H5Family
  top_four: string[]
  nominee_aliases: string[]
}
export type H5ReplayRow = {
  case_id: string
  status: 'located' | 'unknown' | 'error' | 'timeout'
  physical_call_count: number
  logical_calls: unknown[]
  nominations: H5Nomination[]
  candidate_roster: H5CandidateRosterEntry[]
  selected_family?: H5Family | null
  selected_alias?: string | null
  source_family?: SourceFamily | null
  source_alias?: string | null
  candidate_mask_sha256?: string | null
  selected_mask_path?: string | null
  selected_mask_sha256?: string | null
  error_code?: string | null
}
export type H5ReplayEnvelope = {
  schema: 'v03-h5b-paid-replay-run-v1'
  status: string
  case_ids: string[]
  route: {
    model: string
    provider: string
    providerName: string
    apiEndpoint: string
    allowFallbacks: false
  }
  h5a: { run_sha256: string; freeze_sha256: string }
  source_closure: Array<{ path: string; sha256: string }>
  budget: {
    admitted_physical_calls: number
    known_cost_usd: number
    unknown_cost_calls: number
    in_flight_calls: number
    accounted_exposure_usd: number
    max_physical_calls: number
    max_cost_usd: number
  }
  physical_call_count: number
  physical_calls: Array<{
    route: {
      model: string
      provider: string
      providerName: string
      apiEndpoint: string
      allowFallbacks: false
    }
    receipt: { costUsd: number | null } | null
  }>
  logical_call_count: number
  logical_calls: unknown[]
  executable_source: { sha256: string; files: Array<{ path: string; sha256: string }> }
  executable_source_after: { sha256: string; files: Array<{ path: string; sha256: string }> }
  rows: H5ReplayRow[]
}

type PhysicalReceiptRecord = {
  physicalId: number
  reservationId: number
  logicalId: number
  requestSha256: string
  requestBodySha256: string
  admittedAt: string
  durationMs: number
  dispatched: boolean
  httpStatus: number | null
  wireReceipt: unknown
  route: H5ReplayEnvelope['route']
  receipt: unknown
  errorCode?: string
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
  assert(replay.h5a.run_sha256 === H5A_RUN_SHA256, 'h5b-h5a-run-lock')
  assert(replay.h5a.freeze_sha256 === H5A_FREEZE_SHA256, 'h5b-h5a-freeze-lock')
  assert(JSON.stringify(replay.case_ids) === JSON.stringify(CASE_IDS), 'h5b-case-order')
  assert(replay.rows.length === 12, 'h5b-row-count')
  assert(
    replay.budget.admitted_physical_calls <= replay.budget.max_physical_calls,
    'h5b-call-budget',
  )
  assert(replay.budget.max_physical_calls <= 36, 'h5b-call-cap')
  assert(replay.budget.known_cost_usd <= replay.budget.max_cost_usd, 'h5b-cost-budget')
  assert(replay.budget.max_cost_usd <= 2, 'h5b-cost-cap')
  assert(replay.status === 'complete', 'h5b-run-incomplete')
  assert(replay.physical_call_count <= 36, 'h5b-physical-call-cap')
  assert(replay.budget.max_physical_calls === 36, 'h5b-call-budget-changed')
  assert(replay.budget.max_cost_usd === 2, 'h5b-cost-budget-changed')
  assert(replay.physical_call_count === replay.physical_calls.length, 'h5b-physical-call-count')
  assert(
    replay.budget.admitted_physical_calls === replay.physical_call_count,
    'h5b-budget-call-count',
  )
  assert(replay.logical_call_count === replay.logical_calls.length, 'h5b-logical-call-count')
  assert(
    replay.route.model === 'openai/gpt-6-luna-decisions' &&
      replay.route.provider === 'openai' &&
      replay.route.providerName === 'OpenAI' &&
      replay.route.apiEndpoint === '/api/alpha/decisions' &&
      replay.route.allowFallbacks === false,
    'h5b-route-changed',
  )
  for (const call of replay.physical_calls) {
    assert(
      call.route.model === replay.route.model &&
        call.route.provider === replay.route.provider &&
        call.route.providerName === replay.route.providerName &&
        call.route.apiEndpoint === replay.route.apiEndpoint &&
        call.route.allowFallbacks === false,
      'h5b-physical-route-mismatch',
    )
  }
  const knownReceiptCosts = replay.physical_calls.reduce(
    (sum, call) => sum + (call.receipt?.costUsd ?? 0),
    0,
  )
  const unknownReceiptCosts = replay.physical_calls.filter(
    (call) => call.receipt?.costUsd == null,
  ).length
  assert(
    Math.abs(knownReceiptCosts - replay.budget.known_cost_usd) <= 1e-9,
    'h5b-receipt-cost-total-mismatch',
  )
  assert(
    unknownReceiptCosts === replay.budget.unknown_cost_calls,
    'h5b-unknown-cost-count-mismatch',
  )
  assert(replay.budget.accounted_exposure_usd <= 2, 'h5b-budget-exposure-cap')

  const truthByCase = new Map(availability.perCase.map((row) => [row.caseId, row]))
  assert(availability.perCase.length === 12, 'h5a-case-count')
  const replayByCase = new Map(replay.rows.map((row) => [row.case_id, row]))
  assert(replayByCase.size === 12, 'h5b-duplicate-case')
  assert(
    replay.rows.reduce((sum, row) => sum + row.physical_call_count, 0) ===
      replay.physical_call_count,
    'h5b-case-physical-call-count',
  )
  assert(
    replay.rows.reduce((sum, row) => sum + row.logical_calls.length, 0) ===
      replay.logical_call_count,
    'h5b-case-logical-call-count',
  )
  const rows: EvaluatedRow[] = CASE_IDS.map((caseId) => {
    const truth = truthByCase.get(caseId)
    const replayRow = replayByCase.get(caseId)
    assert(truth && replayRow, `h5b-case-missing-${caseId}`)
    const receipts = indexedReceipts(truth)
    const rosterByAlias = new Map(
      replayRow.candidate_roster.map((entry) => [entry.composer_alias, entry]),
    )
    assert(
      rosterByAlias.size === replayRow.candidate_roster.length,
      `h5b-roster-duplicate-${caseId}`,
    )
    const expectedRoster = [
      ...receipts
        .filter((item) => item.sourceFamily === 'h3b-dino-sam2')
        .map((item) => ({ family: 'D' as const, item })),
      ...receipts
        .filter((item) => item.sourceFamily !== 'h3b-dino-sam2')
        .map((item) => ({ family: 'U' as const, item })),
    ]
    assert(
      expectedRoster.length === replayRow.candidate_roster.length,
      `h5b-roster-count-${caseId}`,
    )
    assert(expectedRoster.length <= 72, `h5b-total-candidate-cap-${caseId}`)
    const familyOrdinals = { D: 0, U: 0 }
    for (let index = 0; index < expectedRoster.length; index++) {
      const expected = expectedRoster[index]!
      const entry = replayRow.candidate_roster[index]!
      const ordinal = familyOrdinals[expected.family]++
      assert(ordinal < 36, `h5b-family-candidate-cap-${caseId}`)
      assert(entry.family === expected.family, `h5b-roster-family-order-${caseId}-${index}`)
      assert(
        entry.roster_ordinal === index &&
          entry.composer_alias === `${expected.family}${String(ordinal).padStart(2, '0')}`,
        `h5b-roster-alias-order-${caseId}-${index}`,
      )
      assert(
        entry.source_family === expected.item.sourceFamily &&
          entry.source_alias === expected.item.sourceAlias &&
          entry.candidate_mask_sha256 === expected.item.maskSha256,
        `h5b-roster-source-mismatch-${caseId}-${index}`,
      )
    }
    for (const entry of replayRow.candidate_roster) {
      assert(entry.family === 'D' || entry.family === 'U', `h5b-roster-family-${caseId}`)
      assert(entry.composer_alias.length > 0, `h5b-roster-alias-${caseId}`)
      assert(/^[a-f0-9]{64}$/u.test(entry.candidate_mask_sha256), `h5b-roster-hash-${caseId}`)
    }
    let nominatedAvailable = false
    for (const nomination of replayRow.nominations) {
      assert(
        nomination.family === 'D' || nomination.family === 'U',
        `h5b-nomination-family-${caseId}`,
      )
      assert(nomination.top_four.length <= 4, `h5b-nomination-rank-cap-${caseId}`)
      assert(
        new Set(nomination.top_four).size === nomination.top_four.length,
        `h5b-nomination-rank-duplicate-${caseId}`,
      )
      assert(
        JSON.stringify(nomination.nominee_aliases) ===
          JSON.stringify(nomination.top_four.filter((alias) => alias !== 'none')),
        `h5b-nomination-alias-list-mismatch-${caseId}`,
      )
      for (const alias of nomination.nominee_aliases) {
        const candidate = rosterByAlias.get(alias)
        assert(
          candidate && candidate.family === nomination.family,
          `h5b-nominee-unmapped-${caseId}-${alias}`,
        )
        const reference = receipts.find(
          (item) =>
            item.sourceFamily === candidate.source_family &&
            item.sourceAlias === candidate.source_alias &&
            item.maskSha256 === candidate.candidate_mask_sha256,
        )
        if (reference?.pass) nominatedAvailable = true
      }
    }
    const unionAvailable = truth.families.union?.available === true
    const selected = replayRow.status === 'located'
    let selectedSameMaskPass = false
    let selectedMaskArtifactValid = false
    if (selected) {
      assert(
        replayRow.nominations.some(
          (nomination) =>
            nomination.family === replayRow.selected_family &&
            nomination.nominee_aliases.includes(replayRow.selected_alias ?? ''),
        ),
        `h5b-selected-not-nominated-${caseId}`,
      )
      const candidate = replayRow.candidate_roster.find(
        (entry) =>
          entry.family === replayRow.selected_family &&
          entry.composer_alias === replayRow.selected_alias &&
          entry.source_family === replayRow.source_family &&
          entry.source_alias === replayRow.source_alias &&
          entry.candidate_mask_sha256 === replayRow.candidate_mask_sha256,
      )
      assert(candidate, `h5b-selected-roster-mismatch-${caseId}`)
      const reference = receipts.find(
        (item) =>
          item.sourceFamily === candidate.source_family &&
          item.sourceAlias === candidate.source_alias &&
          item.maskSha256 === candidate.candidate_mask_sha256,
      )
      selectedSameMaskPass = reference?.pass === true
      selectedMaskArtifactValid = verifiedSelectedMaskRows.has(caseId)
      assert(
        replayRow.selected_mask_path && replayRow.selected_mask_sha256,
        `h5b-selected-mask-missing-${caseId}`,
      )
      assert(
        /^[a-f0-9]{64}$/u.test(replayRow.selected_mask_sha256),
        `h5b-selected-mask-hash-${caseId}`,
      )
    } else {
      assert(
        !replayRow.selected_alias &&
          !replayRow.selected_family &&
          !replayRow.source_family &&
          !replayRow.source_alias &&
          !replayRow.candidate_mask_sha256 &&
          !replayRow.selected_mask_path &&
          !replayRow.selected_mask_sha256,
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
      errorCode: replayRow.error_code ?? null,
    }
  })

  const positiveRows = rows.filter((row) => row.presence === 'present')
  const negatives = rows.filter((row) => row.presence === 'absent')
  return {
    schema: 'v03-h5b-independent-selection-evaluation-v1',
    production: {
      status: replay.status,
      h5aRunSha256: replay.h5a.run_sha256,
      h5aFreezeSha256: replay.h5a.freeze_sha256,
      budget: replay.budget,
      physicalCallCount: replay.physical_call_count,
      logicalCallCount: replay.logical_call_count,
      budgetCountersClean:
        replay.budget.unknown_cost_calls === 0 &&
        replay.budget.in_flight_calls === 0 &&
        replay.budget.admitted_physical_calls === replay.physical_call_count &&
        replay.physical_calls.length === replay.physical_call_count,
      closureInterpretation:
        'semantic adapter does not independently verify producer closure receipts',
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

export async function assertSameBinaryMask(
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
    sharp(sourcePath).raw().toBuffer({ resolveWithObject: true }),
    sharp(outputPath).raw().toBuffer({ resolveWithObject: true }),
  ])
  assert(source.info.width === width && source.info.height === height, 'h5b-source-mask-size')
  assert(output.info.width === width && output.info.height === height, 'h5b-output-mask-size')
  const binaryGray = (bytes: Buffer, channels: number): Uint8Array => {
    assert([1, 2, 3, 4].includes(channels), 'h5b-mask-channel-count')
    const colorChannels = channels === 1 || channels === 2 ? 1 : 3
    const alphaChannel = channels === 2 ? 1 : channels === 4 ? 3 : -1
    const pixels = width * height
    const gray = new Uint8Array(pixels)
    for (let pixel = 0; pixel < pixels; pixel++) {
      const offset = pixel * channels
      const value = bytes[offset]
      assert(value === 0 || value === 255, 'h5b-mask-not-binary')
      for (let channel = 1; channel < colorChannels; channel++)
        assert(bytes[offset + channel] === value, 'h5b-mask-color-channels-disagree')
      if (alphaChannel >= 0) assert(bytes[offset + alphaChannel] === 255, 'h5b-mask-not-opaque')
      gray[pixel] = value
    }
    return gray
  }
  assert(
    Buffer.from(binaryGray(source.data, source.info.channels)).equals(
      Buffer.from(binaryGray(output.data, output.info.channels)),
    ),
    'h5b-selected-mask-pixels-differ',
  )
}

export async function verifyH5bSourceClosure(replay: H5ReplayEnvelope) {
  const roots = await Promise.all(
    [H5A_RUN_ROOT, H3_NATIVE_ROOT, H4E_ROOT, IMAGE_ROOT].map((path) => realpath(path)),
  )
  const seen = new Set<string>()
  for (const receipt of replay.source_closure) {
    assert(isAbsolute(receipt.path), 'h5b-closure-path-not-absolute')
    assert(/^[a-f0-9]{64}$/u.test(receipt.sha256), 'h5b-closure-hash-format')
    const actualPath = await realpath(receipt.path)
    assert(
      roots.some((root) => {
        const part = relative(root, actualPath)
        return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      }),
      'h5b-closure-path-outside-frozen-inputs',
    )
    const actualHash = await sha256(actualPath)
    assert(actualHash === receipt.sha256, `h5b-closure-hash-mismatch-${receipt.path}`)
    const key = `${actualPath}:${receipt.sha256}`
    assert(!seen.has(key), 'h5b-closure-duplicate')
    seen.add(key)
  }
  for (const [path, expected] of [
    [resolve(H5A_RUN_ROOT, 'run.json'), H5A_RUN_SHA256],
    [resolve(H5A_RUN_ROOT, 'freeze.json'), H5A_FREEZE_SHA256],
    [
      resolve(H5A_RUN_ROOT, 'postrun-integrity.json'),
      '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50',
    ],
    [
      resolve(H5A_RUN_ROOT, 'worker-closure.json'),
      'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f',
    ],
  ] as const) {
    assert(seen.has(`${await realpath(path)}:${expected}`), 'h5b-required-h5a-closure-missing')
  }
  for (const row of replay.rows) {
    for (const candidate of row.candidate_roster) {
      assert(!isAbsolute(candidate.source_mask_path), 'h5b-source-mask-path-absolute')
      const sourcePath = await realpath(resolve(H5A_RUN_ROOT, candidate.source_mask_path))
      assert(
        seen.has(`${sourcePath}:${candidate.candidate_mask_sha256}`),
        `h5b-roster-source-missing-from-closure-${row.case_id}-${candidate.composer_alias}`,
      )
    }
  }
  return { verifiedFiles: seen.size, status: 'verified' as const }
}

export async function verifyH5bReplayFreeze(
  runRoot: string,
  repositoryRoot: string,
  replay: H5ReplayEnvelope,
) {
  const root = await realpath(runRoot)
  const repository = await realpath(repositoryRoot)
  const freezePath = resolve(root, 'freeze.json')
  const freezeRaw = await readFile(freezePath)
  const freezeSha256 = createHash('sha256').update(freezeRaw).digest('hex')
  const freeze = JSON.parse(freezeRaw.toString('utf8')) as Record<string, unknown>
  const runRaw = await readFile(resolve(root, 'run.json'))
  const runSha256 = createHash('sha256').update(runRaw).digest('hex')
  const onDiskRun = JSON.parse(runRaw.toString('utf8')) as H5ReplayEnvelope
  assert(JSON.stringify(onDiskRun) === JSON.stringify(replay), 'h5b-run-object-differs-from-disk')
  assert(freeze.schema === 'v03-h5b-paid-replay-freeze-v1', 'h5b-freeze-schema')
  assert(freeze.status === 'frozen-before-replay', 'h5b-freeze-status')
  assert(JSON.stringify(freeze.case_ids) === JSON.stringify(CASE_IDS), 'h5b-freeze-case-order')
  assert(JSON.stringify(freeze.route) === JSON.stringify(replay.route), 'h5b-freeze-route-mismatch')
  assert(
    JSON.stringify(freeze.source_closure) === JSON.stringify(replay.source_closure),
    'h5b-freeze-source-closure-mismatch',
  )
  const frozenH5a = freeze.h5a as Record<string, unknown> | undefined
  assert(frozenH5a?.run_sha256 === H5A_RUN_SHA256, 'h5b-freeze-h5a-run')
  assert(frozenH5a.freeze_sha256 === H5A_FREEZE_SHA256, 'h5b-freeze-h5a-freeze')
  assert(
    frozenH5a.postrun_integrity_sha256 ===
      '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50',
    'h5b-freeze-h5a-integrity',
  )
  assert(
    frozenH5a.worker_closure_sha256 ===
      'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f',
    'h5b-freeze-h5a-worker-closure',
  )
  const budget = freeze.budget as Record<string, unknown> | undefined
  assert(budget?.max_physical_calls === 36 && budget.max_cost_usd === 2, 'h5b-freeze-budget')
  assert(budget.unknown_reserve_usd === 0.1, 'h5b-freeze-unknown-reserve')
  const limits = freeze.limits as Record<string, unknown> | undefined
  assert(
    limits?.calls_per_case === 3 &&
      limits.total_calls === 36 &&
      limits.image_parts_per_nomination === 7 &&
      limits.final_image_parts === 9 &&
      limits.images_per_case_deadline_ms === 240_000,
    'h5b-freeze-limits',
  )
  const executable = freeze.executable_source as
    | {
        sha256?: unknown
        files?: Array<{ path: string; sha256: string }>
      }
    | undefined
  assert(executable?.sha256 === replay.executable_source.sha256, 'h5b-freeze-executable-source')
  assert(
    JSON.stringify(executable.files) === JSON.stringify(replay.executable_source.files),
    'h5b-executable-files-differ',
  )
  assert(
    replay.executable_source_after.sha256 === replay.executable_source.sha256 &&
      JSON.stringify(replay.executable_source_after.files) ===
        JSON.stringify(replay.executable_source.files),
    'h5b-executable-source-changed-during-run',
  )
  const sourceFiles = replay.executable_source.files
  assert(sourceFiles.length > 0, 'h5b-executable-source-empty')
  const sourcePaths = new Set(sourceFiles.map((entry) => entry.path))
  for (const required of [
    'benchmarks/v03/run-h5b-paid-replay.ts',
    'benchmarks/v03/h5-proposal-composer.ts',
    'benchmarks/v03/integrity-receipts.ts',
    'benchmarks/v03/replay-source-closure.ts',
    'benchmarks/v02/recording.ts',
    'benchmarks/v02/budget.ts',
    'benchmarks/v02/protocol.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
  ])
    assert(sourcePaths.has(required), `h5b-executable-source-file-missing-${required}`)
  const sourceDigests: string[] = []
  for (const entry of sourceFiles) {
    assert(!isAbsolute(entry.path), 'h5b-executable-source-path-absolute')
    assert(/^[a-f0-9]{64}$/u.test(entry.sha256), 'h5b-executable-source-hash-format')
    const path = resolve(repository, entry.path)
    const part = relative(repository, path)
    assert(
      part && part !== '..' && !part.startsWith(`..${sep}`),
      'h5b-executable-source-path-escape',
    )
    assert((await realpath(path)) === path, 'h5b-executable-source-symlink')
    const stat = await lstat(path)
    assert(stat.isFile() && !stat.isSymbolicLink(), 'h5b-executable-source-not-file')
    sourceDigests.push(await sha256(path))
  }
  assert(
    sourceDigests.every((digest, index) => digest === sourceFiles[index]?.sha256),
    'h5b-executable-source-hash-mismatch',
  )
  assert(
    createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex') ===
      replay.executable_source.sha256,
    'h5b-executable-source-closure-hash',
  )
  return { runSha256, freezeSha256, executableSourceSha256: replay.executable_source.sha256 }
}

export async function verifyH5bPhysicalReceiptArtifacts(runRoot: string, replay: H5ReplayEnvelope) {
  const providerRoot = resolve(await realpath(runRoot), 'provider-calls')
  const names = await readdir(providerRoot)
  const hashRecord = async (name: string) => {
    const path = resolve(providerRoot, name)
    const bytes = await readFile(path)
    return {
      value: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  const physicalIds = new Set<number>()
  const logicalById = new Map<number, Record<string, unknown>>()
  for (const value of replay.logical_calls) {
    assert(typeof value === 'object' && value !== null, 'h5b-logical-call-invalid')
    const logical = value as Record<string, unknown>
    assert(Number.isInteger(logical.logicalId), 'h5b-logical-id-invalid')
    const logicalId = logical.logicalId as number
    assert(!logicalById.has(logicalId), 'h5b-logical-id-duplicate')
    logicalById.set(logicalId, logical)
  }
  const admissions = names.filter((name) => /^physical-admission-\d+\.json$/u.test(name))
  const httpReceipts = names.filter((name) => /^physical-http-\d+\.json$/u.test(name))
  const providerReceipts = names.filter((name) => /^physical-receipt-\d+\.json$/u.test(name))
  assert(admissions.length === replay.physical_call_count, 'h5b-admission-file-count')
  assert(httpReceipts.length === replay.physical_call_count, 'h5b-http-file-count')
  assert(providerReceipts.length === replay.physical_call_count, 'h5b-provider-receipt-file-count')
  const fileHashes: Array<{ path: string; sha256: string }> = []
  for (const callValue of replay.physical_calls) {
    assert(typeof callValue === 'object' && callValue !== null, 'h5b-physical-call-invalid')
    const call = callValue as unknown as PhysicalReceiptRecord
    assert(Number.isInteger(call.physicalId) && call.physicalId > 0, 'h5b-physical-id-invalid')
    assert(!physicalIds.has(call.physicalId), 'h5b-physical-id-duplicate')
    physicalIds.add(call.physicalId)
    assert(call.reservationId === call.physicalId, 'h5b-reservation-id-mismatch')
    const admission = await hashRecord(`physical-admission-${call.physicalId}.json`)
    const http = await hashRecord(`physical-http-${call.physicalId}.json`)
    const provider = await hashRecord(`physical-receipt-${call.physicalId}.json`)
    assert(
      admission.value.physicalId === call.physicalId &&
        admission.value.logicalId === call.logicalId &&
        admission.value.dispatched === true &&
        admission.value.requestSha256 === call.requestSha256 &&
        admission.value.requestBodySha256 === call.requestBodySha256 &&
        admission.value.admittedAt === call.admittedAt &&
        isDeepStrictEqual(admission.value.route, call.route),
      `h5b-admission-receipt-mismatch-${call.physicalId}`,
    )
    assert(
      http.value.physicalId === call.physicalId &&
        http.value.logicalId === call.logicalId &&
        http.value.httpStatus === call.httpStatus &&
        http.value.durationMs === call.durationMs &&
        http.value.errorCode === call.errorCode,
      `h5b-http-receipt-mismatch-${call.physicalId}`,
    )
    assert(
      isDeepStrictEqual(provider.value, call),
      `h5b-provider-receipt-mismatch-${call.physicalId}`,
    )
    const logical = logicalById.get(call.logicalId)
    assert(logical, `h5b-logical-receipt-missing-${call.logicalId}`)
    assert(
      logical.requestSha256 === call.requestSha256 &&
        Array.isArray(logical.physicalIds) &&
        logical.physicalIds.includes(call.physicalId),
      `h5b-logical-physical-link-mismatch-${call.physicalId}`,
    )
    fileHashes.push(
      {
        path: `provider-calls/physical-admission-${call.physicalId}.json`,
        sha256: admission.sha256,
      },
      { path: `provider-calls/physical-http-${call.physicalId}.json`, sha256: http.sha256 },
      { path: `provider-calls/physical-receipt-${call.physicalId}.json`, sha256: provider.sha256 },
    )
  }
  return { status: 'verified' as const, verifiedPhysicalCalls: physicalIds.size, fileHashes }
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
    const selected = row.candidate_roster.find(
      (item) =>
        item.family === row.selected_family &&
        item.composer_alias === row.selected_alias &&
        item.source_family === row.source_family &&
        item.source_alias === row.source_alias &&
        item.candidate_mask_sha256 === row.candidate_mask_sha256,
    )
    assert(selected, `h5b-selected-source-missing-${row.case_id}`)
    assert(!isAbsolute(selected.source_mask_path), 'h5b-source-mask-path-absolute')
    assert(!isAbsolute(row.selected_mask_path ?? ''), 'h5b-output-mask-path-absolute')
    const sourcePath = resolve(sourceRoot, selected.source_mask_path)
    const outputPath = resolve(root, row.selected_mask_path ?? '')
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
      selected.candidate_mask_sha256,
      row.selected_mask_sha256 ?? '',
      availabilityCase.sourceDimensions.width,
      availabilityCase.sourceDimensions.height,
    )
    verified.add(row.case_id)
  }
  return verified
}

export async function evaluateH5SelectionRun(
  runRoot: string,
  repositoryRoot: string,
  availability: H5AvailabilityReport,
) {
  const absoluteRunRoot = resolve(runRoot)
  const replay = JSON.parse(
    await readFile(resolve(absoluteRunRoot, 'run.json'), 'utf8'),
  ) as H5ReplayEnvelope
  const runIdentity = await verifyH5bReplayFreeze(absoluteRunRoot, repositoryRoot, replay)
  const sourceClosure = await verifyH5bSourceClosure(replay)
  const physicalReceipts = await verifyH5bPhysicalReceiptArtifacts(absoluteRunRoot, replay)
  const selectedMasks = await verifySelectedMaskArtifacts(absoluteRunRoot, replay, availability)
  const scored = evaluateH5Selection(availability, replay, selectedMasks)
  return {
    ...scored,
    production: {
      ...scored.production,
      ...runIdentity,
      sourceClosure,
      physicalReceipts,
      closureInterpretation:
        'independently verified run/freeze bytes, executable source closure, frozen input hashes, provider-call artifacts and selected-mask pixels',
      selectedMaskArtifactsVerified: selectedMasks.size,
      selectedMaskArtifactsExpected: replay.rows.filter((row) => row.status === 'located').length,
      budgetCountersClean:
        replay.budget.unknown_cost_calls === 0 && replay.budget.in_flight_calls === 0,
      physicalReceiptsComplete:
        replay.physical_calls.length === replay.physical_call_count &&
        replay.physical_call_count === replay.budget.admitted_physical_calls,
      freezeAndExecutableClosureVerified: true,
    },
  }
}

async function main() {
  const [runRoot, repositoryRoot, outputPath] = process.argv.slice(2)
  assert(
    runRoot && repositoryRoot && outputPath,
    'usage: evaluate-h5-selection <run-root> <runner-repository-root> <output-json>',
  )
  const availabilityPath = resolve(
    process.cwd(),
    'docs/evidence/v03/h5a-native-proposal-availability-evaluation.json',
  )
  const availability = JSON.parse(await readFile(availabilityPath, 'utf8')) as H5AvailabilityReport
  const result = await evaluateH5SelectionRun(runRoot, repositoryRoot, availability)
  await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(
    `${JSON.stringify({
      schema: result.schema,
      production: result.production,
      positiveSummary: result.positiveSummary,
      negativeSummary: result.negativeSummary,
      outputPath: resolve(outputPath),
    })}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
