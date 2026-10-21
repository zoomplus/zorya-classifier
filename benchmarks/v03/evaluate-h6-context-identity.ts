import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertSameBinaryMask, type H5AvailabilityReport } from './evaluate-h5-selection.js'

const H5A_RUN_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h5a-native-proposals-v2'
const H3_NATIVE_ROOT = '/root/work/zorya-classifier/.run/v03/grounded-proposals-h3-run-02'
const H4E_ROOT =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1'
const IMAGE_ROOT = '/root/work/zorya-classifier-worktrees/v02/corpus'
const H5A_RUN_SHA256 = '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0'
const H5A_FREEZE_SHA256 = 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566'
const H5A_INTEGRITY_SHA256 = '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50'
const H5A_WORKER_CLOSURE_SHA256 = 'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f'
const CASE_IDS = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]

export type H6PresenceChoice = 'present' | 'absent' | 'uncertain'
export type H6SourceFamily = 'h3b-dino-sam2' | 'omni-sam2' | 'h4e-sam2'
export type H6Family = 'D' | 'U'

export type H6ChoiceSelection = {
  choice: string
  nativeChoice: string | null
  probabilities: Record<string, number> | null
  tied: string[]
  ranking?: string[]
  confidence?: number
  probabilityRoundingStep?: number
}

export type H6CandidateRosterEntry = {
  family: H6Family
  composer_alias: string
  source_family: H6SourceFamily
  source_alias: string
  candidate_mask_sha256: string
  source_mask_path: string
  roster_ordinal: number
}

export type H6Nomination = {
  family: H6Family
  top_four: string[]
  nominee_aliases: string[]
  selection: H6ChoiceSelection
  metadata: unknown
}

export type H6ReplayRow = {
  case_id: string
  status: 'located' | 'unknown' | 'error' | 'timeout'
  presence: { selection: H6ChoiceSelection | null; metadata: unknown | null }
  physical_call_count: number
  logical_calls: Array<{
    case_id: string
    stage: 'presence' | 'nominate-D' | 'nominate-U' | 'final-select'
    call_ordinal: number
    request_sha256: string
    logical_id?: number
    outcome: 'resolved' | 'failed' | 'pending'
    error_code?: string
  }>
  candidate_roster: H6CandidateRosterEntry[]
  nominations: H6Nomination[]
  selected_family?: H6Family | null
  selected_alias?: string | null
  source_family?: H6SourceFamily | null
  source_alias?: string | null
  candidate_mask_sha256?: string | null
  selected_mask_path?: string | null
  selected_mask_sha256?: string | null
  final_selection?: H6ChoiceSelection | null
  final_metadata?: unknown | null
  unknown_reason?: string | null
  error_code?: string | null
}

export type H6ReplayEnvelope = {
  schema: 'v03-h6-context-identity-run-v1'
  status: string
  case_ids: string[]
  route: {
    model: string
    provider: string
    providerName: string
    apiEndpoint: string
    allowFallbacks: false
  }
  h5a: {
    run_sha256: string
    freeze_sha256: string
    postrun_integrity_sha256: string
    worker_closure_sha256: string
    h3b_run_sha256: string
    h4e_run_sha256: string
  }
  source_closure: Array<{ path: string; sha256: string }>
  budget: {
    admitted_physical_calls: number
    known_cost_usd: number
    unknown_cost_calls: number
    in_flight_calls: number
    accounted_exposure_usd: number
    max_physical_calls: number
    max_cost_usd: number
    unknown_reserve_usd_per_call?: number
  }
  physical_call_count: number
  physical_calls: Array<{
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
    route: H6ReplayEnvelope['route']
    receipt: { costUsd: number | null } | null
    errorCode?: string
  }>
  logical_call_count: number
  logical_calls: unknown[]
  executable_source: { sha256: string; files: Array<{ path: string; sha256: string }> }
  executable_source_after: { sha256: string; files: Array<{ path: string; sha256: string }> }
  logical_stage_receipts?: unknown[]
  rows: H6ReplayRow[]
}

type CandidateScore = {
  family: string
  id: string
  maskSha256: string
  score: { pass: boolean } | null
}

type CandidateReference = {
  sourceFamily: H6SourceFamily
  sourceAlias: string
  maskSha256: string
  pass: boolean
}

type EvaluatedRow = {
  caseId: string
  presence: H5AvailabilityReport['perCase'][number]['presence']
  presenceChoice: H6PresenceChoice | null
  status: H6ReplayRow['status']
  unknownReason: string | null
  unionAvailable: boolean
  nominatedAvailable: boolean
  selectedSameMaskPass: boolean
  selectedMaskArtifactValid: boolean
  selected: boolean
  errorCode: string | null
  physicalCallCount: number
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sourceFamily(name: string): H6SourceFamily {
  if (name === 'h3-dino-sam2') return 'h3b-dino-sam2'
  if (name === 'omni-sam2' || name === 'h4e-sam2') return name
  throw new Error(`h6-unexpected-candidate-family-${name}`)
}

function indexedReceipts(row: H5AvailabilityReport['perCase'][number]): CandidateReference[] {
  return ['h3-dino-sam2', 'omni-sam2', 'h4e-sam2'].flatMap((name) =>
    (row.families[name]?.candidateReceipts ?? []).map((receipt: CandidateScore) => ({
      sourceFamily: sourceFamily(receipt.family),
      sourceAlias: receipt.id,
      maskSha256: receipt.maskSha256,
      pass: receipt.score?.pass === true,
    })),
  )
}

function aliasSetHas(roster: H6CandidateRosterEntry[], family: H6Family, alias: string) {
  return roster.some((entry) => entry.family === family && entry.composer_alias === alias)
}

const PRESENCE_CHOICES: readonly H6PresenceChoice[] = ['present', 'absent', 'uncertain']

function validatePresenceSelection(selection: H6ChoiceSelection, caseId: string) {
  assert(selection && typeof selection === 'object', `h6-presence-selection-invalid-${caseId}`)
  assert(
    selection.probabilities && typeof selection.probabilities === 'object',
    `h6-presence-probabilities-missing-${caseId}`,
  )
  const probabilities = selection.probabilities
  assert(
    isDeepStrictEqual(Object.keys(probabilities).sort(), [...PRESENCE_CHOICES].sort()),
    `h6-presence-choice-keys-${caseId}`,
  )
  for (const choice of PRESENCE_CHOICES) {
    const score = probabilities[choice]
    assert(
      typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1,
      `h6-presence-score-${caseId}`,
    )
  }
  const maxScore = Math.max(...PRESENCE_CHOICES.map((choice) => probabilities[choice] ?? -1))
  const tied = PRESENCE_CHOICES.filter((choice) => probabilities[choice] === maxScore)
  assert(tied.length > 0, `h6-presence-no-maximum-${caseId}`)
  assert(
    selection.choice === tied[0] && selection.tied.join('\0') === tied.join('\0'),
    `h6-presence-unstable-maximum-${caseId}`,
  )
  assert(
    typeof selection.nativeChoice === 'string' &&
      tied.includes(selection.nativeChoice as H6PresenceChoice),
    `h6-presence-native-choice-not-maximum-${caseId}`,
  )
}

function validateH6Availability(availability: H5AvailabilityReport) {
  assert(
    availability.schema === 'v03-h5a-native-proposal-availability-evaluation-v1',
    'h6-h5a-schema',
  )
  assert(availability.runSha256 === H5A_RUN_SHA256, 'h6-h5a-run-lock')
  assert(availability.freezeSha256 === H5A_FREEZE_SHA256, 'h6-h5a-freeze-lock')
  assert(availability.gate.iouAtLeast === 0.5, 'h6-iou-gate-changed')
  assert(availability.gate.referenceCoverageAtLeast === 0.9, 'h6-coverage-gate-changed')
  assert(availability.gate.sameCandidateAndReference, 'h6-same-candidate-gate-changed')
  assert(availability.perCase.length === 12, 'h6-h5a-case-count')
  assert(
    JSON.stringify(availability.perCase.map((row) => row.caseId)) === JSON.stringify(CASE_IDS),
    'h6-h5a-case-order',
  )
}

export function evaluateH6ContextIdentity(
  availability: H5AvailabilityReport,
  replay: H6ReplayEnvelope,
  verifiedSelectedMaskRows: ReadonlySet<string>,
) {
  validateH6Availability(availability)
  assert(replay.schema === 'v03-h6-context-identity-run-v1', 'h6-schema')
  assert(replay.h5a.run_sha256 === H5A_RUN_SHA256, 'h6-h5a-run-lock')
  assert(replay.h5a.freeze_sha256 === H5A_FREEZE_SHA256, 'h6-h5a-freeze-lock')
  assert(JSON.stringify(replay.case_ids) === JSON.stringify(CASE_IDS), 'h6-case-order')
  assert(replay.rows.length === 12, 'h6-row-count')
  assert(replay.status === 'complete', 'h6-run-incomplete')
  assert(replay.budget.max_physical_calls === 48, 'h6-call-budget-changed')
  assert(replay.budget.max_cost_usd === 2, 'h6-cost-budget-changed')
  assert(replay.budget.unknown_reserve_usd_per_call === 0.1, 'h6-unknown-reserve-changed')
  assert(replay.physical_call_count <= 48, 'h6-physical-call-cap')
  assert(replay.physical_call_count === replay.physical_calls.length, 'h6-physical-call-count')
  assert(
    replay.budget.admitted_physical_calls === replay.physical_call_count,
    'h6-budget-call-count',
  )
  assert(replay.budget.known_cost_usd <= 2, 'h6-cost-budget')
  assert(replay.budget.accounted_exposure_usd <= 2, 'h6-cost-exposure')
  assert(replay.logical_call_count === replay.logical_calls.length, 'h6-logical-call-count')
  assert(
    replay.route.model === 'openai/gpt-6-luna-decisions' &&
      replay.route.provider === 'openai' &&
      replay.route.providerName === 'OpenAI' &&
      replay.route.apiEndpoint === '/api/alpha/decisions' &&
      replay.route.allowFallbacks === false,
    'h6-route-changed',
  )
  for (const call of replay.physical_calls) {
    assert(
      call.route.model === replay.route.model &&
        call.route.provider === replay.route.provider &&
        call.route.providerName === replay.route.providerName &&
        call.route.apiEndpoint === replay.route.apiEndpoint &&
        call.route.allowFallbacks === false,
      'h6-physical-route-mismatch',
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
    'h6-receipt-cost-total-mismatch',
  )
  assert(unknownReceiptCosts === replay.budget.unknown_cost_calls, 'h6-unknown-cost-count-mismatch')
  assert(
    replay.rows.reduce((sum, row) => sum + row.physical_call_count, 0) ===
      replay.physical_call_count,
    'h6-row-physical-call-count',
  )
  assert(
    replay.rows.reduce((sum, row) => sum + row.logical_calls.length, 0) ===
      replay.logical_call_count,
    'h6-row-logical-call-count',
  )
  const availabilityByCase = new Map(availability.perCase.map((row) => [row.caseId, row]))
  const replayByCase = new Map(replay.rows.map((row) => [row.case_id, row]))
  assert(replayByCase.size === 12, 'h6-duplicate-case')
  const rows: EvaluatedRow[] = CASE_IDS.map((caseId) => {
    const truth = availabilityByCase.get(caseId)
    const replayRow = replayByCase.get(caseId)
    assert(truth && replayRow, `h6-case-missing-${caseId}`)
    const receipts = indexedReceipts(truth)
    const expectedRoster = [
      ...receipts
        .filter((item) => item.sourceFamily === 'h3b-dino-sam2')
        .map((item) => ({ family: 'D' as const, item })),
      ...receipts
        .filter((item) => item.sourceFamily !== 'h3b-dino-sam2')
        .map((item) => ({ family: 'U' as const, item })),
    ]
    assert(expectedRoster.length === replayRow.candidate_roster.length, `h6-roster-count-${caseId}`)
    assert(expectedRoster.length <= 72, `h6-total-candidate-cap-${caseId}`)
    const familyOrdinal: Record<H6Family, number> = { D: 0, U: 0 }
    for (let index = 0; index < expectedRoster.length; index++) {
      const expected = expectedRoster[index]!
      const entry = replayRow.candidate_roster[index]!
      const ordinal = familyOrdinal[expected.family]++
      assert(ordinal < 36, `h6-family-candidate-cap-${caseId}`)
      assert(entry.family === expected.family, `h6-roster-family-order-${caseId}-${index}`)
      assert(
        entry.roster_ordinal === index &&
          entry.composer_alias === `${expected.family}${String(ordinal).padStart(2, '0')}`,
        `h6-roster-alias-order-${caseId}-${index}`,
      )
      assert(
        entry.source_family === expected.item.sourceFamily &&
          entry.source_alias === expected.item.sourceAlias &&
          entry.candidate_mask_sha256 === expected.item.maskSha256,
        `h6-roster-source-mismatch-${caseId}-${index}`,
      )
      assert(/^[a-f0-9]{64}$/u.test(entry.candidate_mask_sha256), `h6-roster-mask-hash-${caseId}`)
    }
    const selection = replayRow.presence.selection
    if (selection) validatePresenceSelection(selection, caseId)
    assert(
      selection ? replayRow.presence.metadata !== null : replayRow.presence.metadata === null,
      `h6-presence-metadata-mismatch-${caseId}`,
    )
    const presenceChoice = (selection?.choice as H6PresenceChoice | undefined) ?? null
    assert(
      presenceChoice === null || PRESENCE_CHOICES.includes(presenceChoice),
      `h6-presence-choice-${caseId}`,
    )
    if (presenceChoice === 'absent' || presenceChoice === 'uncertain') {
      assert(replayRow.status === 'unknown', `h6-presence-short-circuit-status-${caseId}`)
      assert(
        replayRow.unknown_reason ===
          (presenceChoice === 'absent' ? 'target-absent' : 'presence-unresolved'),
        `h6-presence-short-circuit-reason-${caseId}`,
      )
      assert(replayRow.nominations.length === 0, `h6-presence-short-circuit-nominated-${caseId}`)
      assert(
        !replayRow.selected_alias &&
          !replayRow.selected_family &&
          !replayRow.source_family &&
          !replayRow.source_alias &&
          !replayRow.candidate_mask_sha256 &&
          !replayRow.selected_mask_path &&
          !replayRow.selected_mask_sha256,
        `h6-presence-short-circuit-selected-${caseId}`,
      )
    }
    if (selection === null)
      assert(
        replayRow.status === 'error' || replayRow.status === 'timeout',
        `h6-missing-presence-not-error-${caseId}`,
      )

    let nominatedAvailable = false
    const nominationsByFamily = new Set<H6Family>()
    for (const nomination of replayRow.nominations) {
      assert(
        nomination.family === 'D' || nomination.family === 'U',
        `h6-nomination-family-${caseId}`,
      )
      assert(
        !nominationsByFamily.has(nomination.family),
        `h6-nomination-duplicate-family-${caseId}`,
      )
      nominationsByFamily.add(nomination.family)
      assert(nomination.top_four.length <= 4, `h6-nomination-cap-${caseId}`)
      assert(
        new Set(nomination.top_four).size === nomination.top_four.length,
        `h6-nomination-duplicates-${caseId}`,
      )
      assert(
        nomination.top_four.every(
          (alias) =>
            alias === 'none' || aliasSetHas(replayRow.candidate_roster, nomination.family, alias),
        ),
        `h6-nomination-rank-unmapped-${caseId}`,
      )
      assert(
        nomination.selection.choice === nomination.top_four[0],
        `h6-nomination-choice-rank-mismatch-${caseId}`,
      )
      if (nomination.selection.ranking)
        assert(
          isDeepStrictEqual(nomination.selection.ranking, nomination.top_four),
          `h6-nomination-ranking-mismatch-${caseId}`,
        )
      assert(
        isDeepStrictEqual(
          nomination.nominee_aliases,
          nomination.top_four.filter((alias) => alias !== 'none'),
        ),
        `h6-nomination-aliases-${caseId}`,
      )
      const nominatedIds = new Set<string>()
      for (const alias of nomination.nominee_aliases) {
        const candidate = replayRow.candidate_roster.find(
          (entry) => entry.composer_alias === alias && entry.family === nomination.family,
        )
        assert(candidate, `h6-nominee-not-in-roster-${caseId}-${alias}`)
        nominatedIds.add(
          `${candidate.source_family}:${candidate.source_alias}:${candidate.candidate_mask_sha256}`,
        )
        const reference = receipts.find(
          (item) =>
            item.sourceFamily === candidate.source_family &&
            item.sourceAlias === candidate.source_alias &&
            item.maskSha256 === candidate.candidate_mask_sha256,
        )
        if (reference?.pass) nominatedAvailable = true
      }
      assert(
        nominatedIds.size === nomination.nominee_aliases.length,
        `h6-nominee-duplicate-source-${caseId}`,
      )
    }
    const selected = replayRow.status === 'located'
    const unionAvailable = receipts.some((receipt) => receipt.pass)
    assert(
      unionAvailable === (truth.families.union?.available === true),
      `h6-union-receipt-mismatch-${caseId}`,
    )
    let selectedSameMaskPass = false
    let selectedMaskArtifactValid = false
    if (selected) {
      assert(presenceChoice === 'present', `h6-located-without-presence-${caseId}`)
      assert(
        replayRow.nominations.some(
          (nomination) =>
            nomination.family === replayRow.selected_family &&
            nomination.nominee_aliases.includes(replayRow.selected_alias ?? ''),
        ),
        `h6-selected-not-nominated-${caseId}`,
      )
      const candidate = replayRow.candidate_roster.find(
        (entry) =>
          entry.family === replayRow.selected_family &&
          entry.composer_alias === replayRow.selected_alias &&
          entry.source_family === replayRow.source_family &&
          entry.source_alias === replayRow.source_alias &&
          entry.candidate_mask_sha256 === replayRow.candidate_mask_sha256,
      )
      assert(candidate, `h6-selected-roster-mismatch-${caseId}`)
      selectedSameMaskPass = receipts.some(
        (receipt) =>
          receipt.pass &&
          receipt.sourceFamily === candidate.source_family &&
          receipt.sourceAlias === candidate.source_alias &&
          receipt.maskSha256 === candidate.candidate_mask_sha256,
      )
      selectedMaskArtifactValid = verifiedSelectedMaskRows.has(caseId)
      assert(
        replayRow.selected_mask_path && replayRow.selected_mask_sha256,
        `h6-selected-mask-missing-${caseId}`,
      )
      assert(
        /^[a-f0-9]{64}$/u.test(replayRow.selected_mask_sha256),
        `h6-selected-mask-hash-${caseId}`,
      )
      assert(
        replayRow.final_selection?.choice === replayRow.selected_alias,
        `h6-final-choice-mismatch-${caseId}`,
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
        `h6-nonlocated-has-selected-mask-${caseId}`,
      )
      if (replayRow.unknown_reason === 'none-selected')
        assert(
          replayRow.final_selection?.choice === 'none',
          `h6-final-none-choice-mismatch-${caseId}`,
        )
    }
    return {
      caseId,
      presence: truth.presence,
      presenceChoice,
      status: replayRow.status,
      unknownReason: replayRow.unknown_reason ?? null,
      unionAvailable,
      nominatedAvailable,
      selectedSameMaskPass,
      selectedMaskArtifactValid,
      selected,
      errorCode: replayRow.error_code ?? null,
      physicalCallCount: replayRow.physical_call_count,
    }
  })
  const positives = rows.filter((row) => row.presence === 'present')
  const negatives = rows.filter((row) => row.presence === 'absent')
  const unionRows = positives.filter((row) => row.unionAvailable)
  const presenceAdmittedRows = unionRows.filter((row) => row.presenceChoice === 'present')
  const nominatedRows = presenceAdmittedRows.filter((row) => row.nominatedAvailable)
  const successfulRows = nominatedRows.filter(
    (row) => row.selected && row.selectedSameMaskPass && row.selectedMaskArtifactValid,
  )
  return {
    schema: 'v03-h6-context-identity-independent-evaluation-v1',
    production: {
      status: replay.status,
      h5aRunSha256: replay.h5a.run_sha256,
      h5aFreezeSha256: replay.h5a.freeze_sha256,
      route: replay.route,
      budget: replay.budget,
      physicalCallCount: replay.physical_call_count,
      logicalCallCount: replay.logical_call_count,
      budgetCountersClean:
        replay.budget.admitted_physical_calls === replay.physical_call_count &&
        replay.budget.in_flight_calls === 0,
      unknownCostCalls: replay.budget.unknown_cost_calls,
      closureInterpretation: 'semantic evaluator scores independently verified frozen receipts',
    },
    positiveSummary: {
      denominator: positives.length,
      unionAvailable: unionRows.length,
      presenceAdmittedAfterUnion: presenceAdmittedRows.length,
      nominatedAvailable: nominatedRows.length,
      selectedSameMaskPass: successfulRows.length,
      presenceChoices: Object.fromEntries(
        PRESENCE_CHOICES.map((choice) => [
          choice,
          positives.filter((row) => row.presenceChoice === choice).length,
        ]),
      ),
      generationLoss: positives.filter((row) => !row.unionAvailable).map((row) => row.caseId),
      presenceLoss: unionRows
        .filter((row) => row.presenceChoice !== 'present')
        .map((row) => row.caseId),
      nominationLoss: presenceAdmittedRows
        .filter((row) => !row.nominatedAvailable)
        .map((row) => row.caseId),
      finalSelectionLoss: nominatedRows
        .filter(
          (row) => !(row.selected && row.selectedSameMaskPass && row.selectedMaskArtifactValid),
        )
        .map((row) => row.caseId),
    },
    negativeSummary: {
      denominator: negatives.length,
      presenceChoices: Object.fromEntries(
        PRESENCE_CHOICES.map((choice) => [
          choice,
          negatives.filter((row) => row.presenceChoice === choice).length,
        ]),
      ),
      falseAtPresence: negatives
        .filter((row) => row.presenceChoice === 'present')
        .map((row) => row.caseId),
      correctTargetAbsent: negatives
        .filter((row) => row.presenceChoice === 'absent')
        .map((row) => row.caseId),
      uncertain: negatives
        .filter((row) => row.presenceChoice === 'uncertain')
        .map((row) => row.caseId),
      correctUnknown: negatives.filter((row) => row.status === 'unknown').length,
      falseOutputs: negatives.filter((row) => row.selected).map((row) => row.caseId),
      errorRows: negatives.filter((row) => row.status === 'error' || row.status === 'timeout'),
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

export async function verifyH6SelectedMaskArtifacts(
  runRoot: string,
  replay: H6ReplayEnvelope,
  availability: H5AvailabilityReport,
): Promise<Set<string>> {
  const root = await realpath(runRoot)
  const h5aRoot = await realpath(H5A_RUN_ROOT)
  const allowedSourceRoots = await Promise.all(
    [H5A_RUN_ROOT, H3_NATIVE_ROOT, H4E_ROOT].map((path) => realpath(path)),
  )
  const verified = new Set<string>()
  for (const row of replay.rows) {
    if (row.status !== 'located') continue
    const candidate = row.candidate_roster.find(
      (entry) =>
        entry.family === row.selected_family &&
        entry.composer_alias === row.selected_alias &&
        entry.source_family === row.source_family &&
        entry.source_alias === row.source_alias &&
        entry.candidate_mask_sha256 === row.candidate_mask_sha256,
    )
    assert(candidate, `h6-selected-source-missing-${row.case_id}`)
    assert(!isAbsolute(candidate.source_mask_path), 'h6-source-mask-path-absolute')
    assert(!isAbsolute(row.selected_mask_path ?? ''), 'h6-output-mask-path-absolute')
    const sourcePath = resolve(h5aRoot, candidate.source_mask_path)
    const outputPath = resolve(root, row.selected_mask_path ?? '')
    const within = async (base: string, path: string, label: string) => {
      const part = relative(base, path)
      assert(part && part !== '..' && !part.startsWith(`..${sep}`), `${label}-path-escape`)
      const actual = await realpath(path)
      const actualPart = relative(base, actual)
      assert(
        actualPart && actualPart !== '..' && !actualPart.startsWith(`..${sep}`),
        `${label}-symlink-escape`,
      )
      return actual
    }
    const sourceActual = await realpath(sourcePath)
    assert(
      allowedSourceRoots.some((base) => {
        const part = relative(base, sourceActual)
        return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      }),
      `h6-source-mask-outside-roots-${row.case_id}`,
    )
    const outputActual = await within(root, outputPath, `h6-output-mask-${row.case_id}`)
    const truth = availability.perCase.find((item) => item.caseId === row.case_id)
    assert(truth, `h6-source-dimensions-missing-${row.case_id}`)
    await assertSameBinaryMask(
      sourceActual,
      outputActual,
      candidate.candidate_mask_sha256,
      row.selected_mask_sha256 ?? '',
      truth.sourceDimensions.width,
      truth.sourceDimensions.height,
    )
    verified.add(row.case_id)
  }
  return verified
}

export async function verifyH6SourceClosure(replay: H6ReplayEnvelope) {
  const roots = await Promise.all(
    [H5A_RUN_ROOT, H3_NATIVE_ROOT, H4E_ROOT, IMAGE_ROOT].map((path) => realpath(path)),
  )
  const seen = new Set<string>()
  for (const receipt of replay.source_closure) {
    assert(isAbsolute(receipt.path), 'h6-closure-path-not-absolute')
    assert(/^[a-f0-9]{64}$/u.test(receipt.sha256), 'h6-closure-hash-format')
    const path = await realpath(receipt.path)
    assert(
      roots.some((base) => {
        const part = relative(base, path)
        return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      }),
      'h6-closure-path-outside-frozen-inputs',
    )
    assert((await sha256(path)) === receipt.sha256, `h6-closure-hash-mismatch-${receipt.path}`)
    const key = `${path}:${receipt.sha256}`
    assert(!seen.has(key), 'h6-closure-duplicate')
    seen.add(key)
  }
  for (const [path, hash] of [
    [resolve(H5A_RUN_ROOT, 'run.json'), H5A_RUN_SHA256],
    [resolve(H5A_RUN_ROOT, 'freeze.json'), H5A_FREEZE_SHA256],
    [resolve(H5A_RUN_ROOT, 'postrun-integrity.json'), H5A_INTEGRITY_SHA256],
    [resolve(H5A_RUN_ROOT, 'worker-closure.json'), H5A_WORKER_CLOSURE_SHA256],
  ] as const)
    assert(seen.has(`${await realpath(path)}:${hash}`), 'h6-required-h5a-closure-missing')
  for (const row of replay.rows) {
    for (const candidate of row.candidate_roster) {
      assert(!isAbsolute(candidate.source_mask_path), 'h6-source-mask-path-absolute')
      const source = await realpath(resolve(H5A_RUN_ROOT, candidate.source_mask_path))
      assert(
        seen.has(`${source}:${candidate.candidate_mask_sha256}`),
        `h6-candidate-mask-not-closed-${row.case_id}-${candidate.composer_alias}`,
      )
    }
  }
  return { status: 'verified' as const, verifiedFiles: seen.size }
}

async function hashExecutableFiles(
  repository: string,
  entries: Array<{ path: string; sha256: string }>,
) {
  const srcRoot = resolve(repository, 'src')
  const walk = async (directory: string): Promise<string[]> => {
    const stat = await lstat(directory)
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'h6-executable-source-src-root')
    const files: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      assert(!entry.isSymbolicLink(), 'h6-executable-source-symlink')
      if (entry.isDirectory()) files.push(...(await walk(path)))
      else {
        const fileStat = await lstat(path)
        assert(entry.isFile() && fileStat.isFile(), 'h6-executable-source-non-file')
        files.push(path)
      }
    }
    return files
  }
  const requiredFiles = [
    'benchmarks/v03/h6-context-composer.ts',
    'benchmarks/v03/h6-replay-kernel.ts',
    'benchmarks/v03/run-h6-context-identity.ts',
    'benchmarks/v03/h6-replay-source-closure.ts',
    'benchmarks/v02/recording.ts',
    'benchmarks/v02/budget.ts',
    'benchmarks/v02/protocol.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
  ].map((path) => resolve(repository, path))
  const expectedPaths = [...new Set([...(await walk(srcRoot)), ...requiredFiles])]
    .map((path) => relative(repository, path).split('\\').join('/'))
    .sort()
  assert(
    isDeepStrictEqual(
      entries.map((entry) => entry.path),
      expectedPaths,
    ),
    'h6-executable-source-file-set-mismatch',
  )
  const actualHashes: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    assert(!isAbsolute(entry.path), 'h6-executable-source-absolute-path')
    assert(/^[a-f0-9]{64}$/u.test(entry.sha256), 'h6-executable-source-hash-format')
    const path = resolve(repository, entry.path)
    const part = relative(repository, path)
    assert(
      part && part !== '..' && !part.startsWith(`..${sep}`),
      'h6-executable-source-path-escape',
    )
    assert((await realpath(path)) === path, 'h6-executable-source-realpath')
    actualHashes.push(await sha256(path))
  }
  assert(
    actualHashes.every((hash, index) => hash === entries[index]?.sha256),
    'h6-executable-source-hash-mismatch',
  )
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export async function verifyH6ReplayFreeze(
  runRoot: string,
  repositoryRoot: string,
  replay: H6ReplayEnvelope,
) {
  const root = await realpath(runRoot)
  const repository = await realpath(repositoryRoot)
  const freezeRaw = await readFile(resolve(root, 'freeze.json'))
  const freezeSha256 = createHash('sha256').update(freezeRaw).digest('hex')
  const freeze = JSON.parse(freezeRaw.toString('utf8')) as Record<string, unknown>
  const runRaw = await readFile(resolve(root, 'run.json'))
  const runSha256 = createHash('sha256').update(runRaw).digest('hex')
  const onDiskRun = JSON.parse(runRaw.toString('utf8')) as H6ReplayEnvelope
  assert(isDeepStrictEqual(onDiskRun, replay), 'h6-run-differs-from-disk')
  assert(freeze.schema === 'v03-h6-context-identity-freeze-v1', 'h6-freeze-schema')
  assert(freeze.status === 'frozen-before-replay', 'h6-freeze-status')
  assert(isDeepStrictEqual(freeze.case_ids, CASE_IDS), 'h6-freeze-case-order')
  assert(isDeepStrictEqual(freeze.route, replay.route), 'h6-freeze-route-mismatch')
  assert(
    isDeepStrictEqual(freeze.source_closure, replay.source_closure),
    'h6-freeze-closure-mismatch',
  )
  const h5a = freeze.h5a as Record<string, unknown> | undefined
  assert(h5a?.run_sha256 === H5A_RUN_SHA256, 'h6-freeze-h5a-run')
  assert(h5a.freeze_sha256 === H5A_FREEZE_SHA256, 'h6-freeze-h5a-freeze')
  assert(h5a.postrun_integrity_sha256 === H5A_INTEGRITY_SHA256, 'h6-freeze-h5a-integrity')
  assert(h5a.worker_closure_sha256 === H5A_WORKER_CLOSURE_SHA256, 'h6-freeze-h5a-worker-closure')
  assert(
    h5a.h3b_run_sha256 === 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401',
    'h6-freeze-h3b-run',
  )
  assert(
    h5a.h4e_run_sha256 === 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4',
    'h6-freeze-h4e-run',
  )
  const budget = freeze.budget as Record<string, unknown> | undefined
  assert(
    budget?.max_physical_calls === 48 &&
      budget.max_cost_usd === 2 &&
      budget.unknown_reserve_usd === 0.1,
    'h6-freeze-budget',
  )
  const limits = freeze.limits as Record<string, unknown> | undefined
  assert(
    limits?.calls_per_case === 4 &&
      limits.total_calls === 48 &&
      limits.image_parts_per_nomination === 5 &&
      limits.final_image_parts === 9 &&
      limits.images_per_case_deadline_ms === 240_000 &&
      limits.candidates_per_family === 36 &&
      limits.total_candidates === 72 &&
      limits.packed_mask_bytes === 19 * 1024 * 1024,
    'h6-freeze-limits',
  )
  assert(
    isDeepStrictEqual(freeze.executable_source, replay.executable_source),
    'h6-freeze-executable-source',
  )
  assert(
    isDeepStrictEqual(replay.executable_source_after, replay.executable_source),
    'h6-executable-source-changed-during-run',
  )
  const executableSourceSha256 = await hashExecutableFiles(
    repository,
    replay.executable_source.files,
  )
  assert(
    executableSourceSha256 === replay.executable_source.sha256,
    'h6-executable-source-closure-hash',
  )
  return { runSha256, freezeSha256, executableSourceSha256 }
}

export async function verifyH6PhysicalReceiptArtifacts(
  recordingRoot: string,
  replay: H6ReplayEnvelope,
) {
  const names = await readdir(recordingRoot)
  const readRecord = async (name: string) => {
    const bytes = await readFile(resolve(recordingRoot, name))
    return {
      value: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  assert(
    names.filter((name) => /^physical-admission-\d+\.json$/u.test(name)).length ===
      replay.physical_call_count,
    'h6-physical-admission-file-count',
  )
  assert(
    names.filter((name) => /^physical-http-\d+\.json$/u.test(name)).length ===
      replay.physical_call_count,
    'h6-physical-http-file-count',
  )
  assert(
    names.filter((name) => /^physical-receipt-\d+\.json$/u.test(name)).length ===
      replay.physical_call_count,
    'h6-physical-receipt-file-count',
  )
  const logicalById = new Map<number, Record<string, unknown>>()
  for (const value of replay.logical_calls) {
    assert(typeof value === 'object' && value !== null, 'h6-logical-call-invalid')
    const logical = value as Record<string, unknown>
    assert(Number.isInteger(logical.logicalId), 'h6-logical-id-invalid')
    const id = logical.logicalId as number
    assert(!logicalById.has(id), 'h6-logical-id-duplicate')
    logicalById.set(id, logical)
  }
  const seenIds = new Set<number>()
  const fileHashes: Array<{ path: string; sha256: string }> = []
  for (const call of replay.physical_calls) {
    assert(Number.isInteger(call.physicalId) && call.physicalId > 0, 'h6-physical-id-invalid')
    assert(!seenIds.has(call.physicalId), 'h6-physical-id-duplicate')
    seenIds.add(call.physicalId)
    const admission = await readRecord(`physical-admission-${call.physicalId}.json`)
    const http = await readRecord(`physical-http-${call.physicalId}.json`)
    const receipt = await readRecord(`physical-receipt-${call.physicalId}.json`)
    assert(
      admission.value.physicalId === call.physicalId &&
        admission.value.logicalId === call.logicalId &&
        admission.value.dispatched === true &&
        admission.value.requestSha256 === call.requestSha256 &&
        admission.value.requestBodySha256 === call.requestBodySha256 &&
        admission.value.admittedAt === call.admittedAt &&
        isDeepStrictEqual(admission.value.route, call.route),
      `h6-admission-mismatch-${call.physicalId}`,
    )
    assert(
      http.value.physicalId === call.physicalId &&
        http.value.logicalId === call.logicalId &&
        http.value.httpStatus === call.httpStatus &&
        http.value.durationMs === call.durationMs &&
        (call.httpStatus === null
          ? http.value.errorCode === call.errorCode
          : !Object.hasOwn(http.value, 'errorCode')),
      `h6-http-mismatch-${call.physicalId}`,
    )
    assert(
      isDeepStrictEqual(receipt.value, call),
      `h6-provider-receipt-mismatch-${call.physicalId}`,
    )
    const logical = logicalById.get(call.logicalId)
    assert(logical, `h6-logical-receipt-missing-${call.logicalId}`)
    assert(
      logical.requestSha256 === call.requestSha256 &&
        Array.isArray(logical.physicalIds) &&
        logical.physicalIds.includes(call.physicalId),
      `h6-logical-physical-link-mismatch-${call.physicalId}`,
    )
    fileHashes.push(
      { path: `physical-admission-${call.physicalId}.json`, sha256: admission.sha256 },
      { path: `physical-http-${call.physicalId}.json`, sha256: http.sha256 },
      { path: `physical-receipt-${call.physicalId}.json`, sha256: receipt.sha256 },
    )
  }
  return { status: 'verified' as const, verifiedPhysicalCalls: seenIds.size, fileHashes }
}

/** Join each resolved stage to the recorder's raw, independently persisted Choice trace. */
export async function verifyH6DecisionTraceArtifacts(
  recordingRoot: string,
  replay: H6ReplayEnvelope,
) {
  const logicalById = new Map<number, Record<string, unknown>>()
  for (const value of replay.logical_calls) {
    const logical = value as Record<string, unknown>
    assert(Number.isInteger(logical.logicalId), 'h6-trace-logical-id-invalid')
    logicalById.set(logical.logicalId as number, logical)
  }
  const expectedQuestion: Record<H6ReplayRow['logical_calls'][number]['stage'], string> = {
    presence: 'presence',
    'nominate-D': 'selection',
    'nominate-U': 'selection',
    'final-select': 'selection',
  }
  let verifiedStages = 0
  const fileHashes: Array<{ path: string; sha256: string }> = []
  for (const row of replay.rows) {
    const stages = row.logical_calls
    assert(stages.length <= 4, `h6-trace-stage-cap-${row.case_id}`)
    assert(
      stages.every(
        (stage, index) =>
          stage.case_id === row.case_id &&
          stage.call_ordinal === index + 1 &&
          /^[a-f0-9]{64}$/u.test(stage.request_sha256),
      ),
      `h6-trace-stage-order-${row.case_id}`,
    )
    for (const stage of stages) {
      if (stage.outcome !== 'resolved') continue
      assert(Number.isInteger(stage.logical_id), `h6-trace-stage-logical-id-missing-${row.case_id}`)
      const logicalId = stage.logical_id!
      const logical = logicalById.get(logicalId)
      assert(logical, `h6-trace-logical-record-missing-${logicalId}`)
      assert(
        logical.requestSha256 === stage.request_sha256,
        `h6-trace-logical-request-mismatch-${logicalId}`,
      )
      const traceBytes = await readFile(resolve(recordingRoot, `decision-trace-${logicalId}.json`))
      const traceHash = createHash('sha256').update(traceBytes).digest('hex')
      const trace = JSON.parse(traceBytes.toString('utf8')) as {
        status?: string
        reason?: string
        questions?: Array<Record<string, unknown>>
      }
      assert(
        trace.status === 'recorded',
        `h6-raw-decision-trace-omitted-${logicalId}-${trace.reason}`,
      )
      assert(Array.isArray(trace.questions), `h6-raw-decision-trace-questions-${logicalId}`)
      const questionId = expectedQuestion[stage.stage]
      const matches = trace.questions.filter((question) => question.questionId === questionId)
      assert(matches.length === 1, `h6-raw-decision-trace-question-${logicalId}`)
      const answer = matches[0]!
      assert(
        answer.answerType === 'choice' || answer.answerType === 'ranked-choice',
        `h6-raw-decision-trace-answer-type-${logicalId}`,
      )
      let selection: H6ChoiceSelection | null = null
      if (stage.stage === 'presence') selection = row.presence.selection
      else if (stage.stage === 'nominate-D' || stage.stage === 'nominate-U') {
        const family = stage.stage === 'nominate-D' ? 'D' : 'U'
        selection =
          row.nominations.find((nomination) => nomination.family === family)?.selection ?? null
      } else selection = row.final_selection ?? null
      assert(selection, `h6-raw-decision-trace-stage-selection-missing-${logicalId}`)
      if (answer.answerType === 'choice') {
        assert(
          answer.selected === selection.nativeChoice,
          `h6-raw-decision-trace-native-choice-${logicalId}`,
        )
      } else {
        assert(
          selection.nativeChoice === null && isDeepStrictEqual(answer.ranking, selection.ranking),
          `h6-raw-decision-trace-native-ranking-${logicalId}`,
        )
      }
      const traceProbabilities = answer.answerType === 'choice' ? answer.probabilities : undefined
      if (selection.probabilities && answer.answerType === 'choice') {
        assert(
          Array.isArray(traceProbabilities),
          `h6-raw-decision-trace-probabilities-missing-${logicalId}`,
        )
        const fromTrace = Object.fromEntries(
          traceProbabilities.map((item) => {
            const probability = item as { optionId: string; value: number }
            return [probability.optionId, probability.value]
          }),
        )
        assert(
          isDeepStrictEqual(fromTrace, selection.probabilities),
          `h6-raw-decision-trace-probabilities-mismatch-${logicalId}`,
        )
      }
      if (stage.stage === 'nominate-D' || stage.stage === 'nominate-U') {
        const family = stage.stage === 'nominate-D' ? 'D' : 'U'
        const nomination = row.nominations.find((item) => item.family === family)!
        if (Array.isArray(answer.ranking))
          assert(
            isDeepStrictEqual(answer.ranking, nomination.top_four),
            `h6-raw-decision-trace-ranking-mismatch-${logicalId}`,
          )
        else if (selection.probabilities) {
          const stableOrder = Object.keys(selection.probabilities).sort((first, second) => {
            const delta = selection.probabilities![second]! - selection.probabilities![first]!
            return (
              delta ||
              Object.keys(selection.probabilities!).indexOf(first) -
                Object.keys(selection.probabilities!).indexOf(second)
            )
          })
          assert(
            stableOrder
              .slice(0, nomination.top_four.length)
              .every((alias, index) => alias === nomination.top_four[index]),
            `h6-raw-decision-trace-top-four-mismatch-${logicalId}`,
          )
        }
      }
      verifiedStages++
      fileHashes.push({ path: `decision-trace-${logicalId}.json`, sha256: traceHash })
    }
  }
  return { status: 'verified' as const, verifiedStages, fileHashes }
}

export async function evaluateH6ContextIdentityRun(
  runRoot: string,
  repositoryRoot: string,
  availability: H5AvailabilityReport,
  recordingRoot = resolve(runRoot, 'provider-calls'),
) {
  const absoluteRunRoot = resolve(runRoot)
  const replay = JSON.parse(
    await readFile(resolve(absoluteRunRoot, 'run.json'), 'utf8'),
  ) as H6ReplayEnvelope
  const runIdentity = await verifyH6ReplayFreeze(absoluteRunRoot, repositoryRoot, replay)
  const sourceClosure = await verifyH6SourceClosure(replay)
  const physicalReceipts = await verifyH6PhysicalReceiptArtifacts(recordingRoot, replay)
  const decisionTraces = await verifyH6DecisionTraceArtifacts(recordingRoot, replay)
  const selectedMaskRows = await verifyH6SelectedMaskArtifacts(
    absoluteRunRoot,
    replay,
    availability,
  )
  const scored = evaluateH6ContextIdentity(availability, replay, selectedMaskRows)
  return {
    ...scored,
    production: {
      ...scored.production,
      ...runIdentity,
      sourceClosure,
      physicalReceipts,
      decisionTraces,
      selectedMaskArtifactsVerified: selectedMaskRows.size,
      selectedMaskArtifactsExpected: replay.rows.filter((row) => row.status === 'located').length,
      freezeAndExecutableClosureVerified: true,
      physicalReceiptsComplete:
        physicalReceipts.verifiedPhysicalCalls === replay.physical_call_count,
    },
  }
}

async function main() {
  const [runRoot, repositoryRoot, outputPath, recordingRoot] = process.argv.slice(2)
  assert(
    runRoot && repositoryRoot && outputPath,
    'usage: evaluate-h6-context-identity <run-root> <runner-repository-root> <output-json> [provider-calls-root]',
  )
  const availabilityPath = resolve(
    process.cwd(),
    'docs/evidence/v03/h5a-native-proposal-availability-evaluation.json',
  )
  const availability = JSON.parse(await readFile(availabilityPath, 'utf8')) as H5AvailabilityReport
  const result = await evaluateH6ContextIdentityRun(
    runRoot,
    repositoryRoot,
    availability,
    recordingRoot,
  )
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
