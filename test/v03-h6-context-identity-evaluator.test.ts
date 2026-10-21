import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  evaluateH6ContextIdentity,
  verifyH6DecisionTraceArtifacts,
  type H6CandidateRosterEntry,
  type H6ChoiceSelection,
  type H6Nomination,
  type H6PresenceChoice,
  type H6ReplayEnvelope,
  type H6ReplayRow,
} from '../benchmarks/v03/evaluate-h6-context-identity.js'
import type { H5AvailabilityReport } from '../benchmarks/v03/evaluate-h5-selection.js'

const caseIds = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]

const digest = (symbol: string) => symbol.repeat(64)

function truthFixture(): H5AvailabilityReport {
  const perCase = caseIds.map((caseId, index) => {
    const absent = caseId.endsWith('-04')
    const available = !absent && caseId !== 'pilot-v03-map-02'
    const family = caseId.startsWith('pilot-v03-ui-') ? 'h4e-sam2' : 'h3-dino-sam2'
    const alias = family === 'h4e-sam2' ? `candidate-${String(index).padStart(3, '0')}` : 'C00'
    const candidateReceipts = [
      {
        family,
        id: alias,
        maskSha256: digest(String(index % 10)),
        score: { pass: available },
      },
    ]
    return {
      caseId,
      presence: absent ? ('absent' as const) : ('present' as const),
      sourceSha256: digest(String((index + 1) % 10)),
      sourceDimensions: { width: 12, height: 8 },
      families: {
        'h3-dino-sam2': {
          available: available && family === 'h3-dino-sam2',
          candidateReceipts: family === 'h3-dino-sam2' ? candidateReceipts : [],
        },
        'omni-sam2': { available: false, candidateReceipts: [] },
        'h4e-sam2': {
          available: available && family === 'h4e-sam2',
          candidateReceipts: family === 'h4e-sam2' ? candidateReceipts : [],
        },
        union: { available, candidateReceipts: [] },
      },
    }
  })
  return {
    schema: 'v03-h5a-native-proposal-availability-evaluation-v1',
    runSha256: '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0',
    freezeSha256: 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566',
    gate: { iouAtLeast: 0.5, referenceCoverageAtLeast: 0.9, sameCandidateAndReference: true },
    perCase,
  }
}

function presenceSelection(choice: H6PresenceChoice): H6ChoiceSelection {
  const probabilities = {
    present: choice === 'present' ? 0.8 : 0.1,
    absent: choice === 'absent' ? 0.8 : 0.1,
    uncertain: choice === 'uncertain' ? 0.8 : 0.1,
  }
  return { choice, nativeChoice: choice, probabilities, tied: [choice] }
}

function fixture() {
  const availability = truthFixture()
  const rows: H6ReplayRow[] = caseIds.map((case_id, index) => {
    const truth = availability.perCase[index]!
    const source_family = case_id.startsWith('pilot-v03-ui-')
      ? ('h4e-sam2' as const)
      : ('h3b-dino-sam2' as const)
    const family = source_family === 'h4e-sam2' ? ('U' as const) : ('D' as const)
    const reference =
      truth.families[source_family === 'h4e-sam2' ? 'h4e-sam2' : 'h3-dino-sam2']!
        .candidateReceipts[0]
    const source_alias = reference?.id ?? 'C00'
    const candidate_mask_sha256 = reference?.maskSha256 ?? digest('f')
    const candidate_roster: H6CandidateRosterEntry[] = [
      {
        family,
        composer_alias: `${family}00`,
        source_family,
        source_alias,
        candidate_mask_sha256,
        source_mask_path: 'candidate.png',
        roster_ordinal: 0,
      },
    ]
    const presenceChoice: H6PresenceChoice =
      case_id === 'pilot-v03-photo-04'
        ? 'present'
        : case_id === 'pilot-v03-ui-04'
          ? 'absent'
          : case_id === 'pilot-v03-map-04' || case_id === 'pilot-v03-photo-03'
            ? 'uncertain'
            : 'present'
    const earlyPresenceExit = presenceChoice === 'absent' || presenceChoice === 'uncertain'
    const top_four =
      case_id === 'pilot-v03-ui-03' || case_id === 'pilot-v03-map-01'
        ? ['none']
        : [candidate_roster[0]!.composer_alias]
    const nominee_aliases = top_four.filter((alias) => alias !== 'none')
    const nomination: H6Nomination = {
      family,
      top_four,
      nominee_aliases,
      selection: {
        choice: top_four[0]!,
        nativeChoice: null,
        probabilities: null,
        tied: [],
        ranking: top_four,
      },
      metadata: { model: 'mock' },
    }
    const hasNomination = !earlyPresenceExit
    const selected =
      case_id === 'pilot-v03-photo-01' ||
      case_id === 'pilot-v03-ui-01' ||
      case_id === 'pilot-v03-photo-04'
    const finalNone =
      case_id === 'pilot-v03-photo-02' ||
      case_id === 'pilot-v03-ui-02' ||
      case_id === 'pilot-v03-map-03'
    const status: H6ReplayRow['status'] = earlyPresenceExit
      ? 'unknown'
      : selected
        ? 'located'
        : 'unknown'
    return {
      case_id,
      status,
      presence: { selection: presenceSelection(presenceChoice), metadata: { model: 'mock' } },
      physical_call_count: 0,
      logical_calls: [],
      candidate_roster,
      nominations: hasNomination ? [nomination] : [],
      ...(selected
        ? {
            selected_family: family,
            selected_alias: candidate_roster[0]!.composer_alias,
            source_family,
            source_alias,
            candidate_mask_sha256,
            selected_mask_path: 'selected.png',
            selected_mask_sha256: digest('a'),
            final_selection: {
              choice: candidate_roster[0]!.composer_alias,
              nativeChoice: null,
              probabilities: null,
              tied: [],
              ranking: [candidate_roster[0]!.composer_alias],
            },
            final_metadata: { model: 'mock' },
          }
        : finalNone
          ? {
              unknown_reason: 'none-selected',
              final_selection: {
                choice: 'none',
                nativeChoice: null,
                probabilities: null,
                tied: [],
                ranking: ['none'],
              },
              final_metadata: { model: 'mock' },
            }
          : earlyPresenceExit
            ? {
                unknown_reason:
                  presenceChoice === 'absent' ? 'target-absent' : 'presence-unresolved',
              }
            : {}),
    }
  })
  const replay: H6ReplayEnvelope = {
    schema: 'v03-h6-context-identity-run-v1',
    status: 'complete',
    case_ids: caseIds,
    route: {
      model: 'openai/gpt-6-luna-decisions',
      provider: 'openai',
      providerName: 'OpenAI',
      apiEndpoint: '/api/alpha/decisions',
      allowFallbacks: false,
    },
    h5a: {
      run_sha256: availability.runSha256,
      freeze_sha256: availability.freezeSha256,
      postrun_integrity_sha256: '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50',
      worker_closure_sha256: 'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f',
      h3b_run_sha256: 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401',
      h4e_run_sha256: 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4',
    },
    source_closure: [],
    budget: {
      admitted_physical_calls: 0,
      known_cost_usd: 0,
      unknown_cost_calls: 0,
      in_flight_calls: 0,
      accounted_exposure_usd: 0,
      max_physical_calls: 48,
      max_cost_usd: 2,
      unknown_reserve_usd_per_call: 0.1,
    },
    physical_call_count: 0,
    physical_calls: [],
    logical_call_count: 0,
    logical_calls: [],
    executable_source: { sha256: digest('b'), files: [] },
    executable_source_after: { sha256: digest('b'), files: [] },
    rows,
  }
  return { availability, replay }
}

await test('H6 scoring separates union, presence, nomination, and final loss across all 12 cases', () => {
  const { availability, replay } = fixture()
  const verified = new Set(['pilot-v03-photo-01', 'pilot-v03-ui-01', 'pilot-v03-photo-04'])
  const result = evaluateH6ContextIdentity(availability, replay, verified)
  assert.equal(result.positiveSummary.denominator, 9)
  assert.equal(result.positiveSummary.unionAvailable, 8)
  assert.equal(result.positiveSummary.presenceAdmittedAfterUnion, 7)
  assert.equal(result.positiveSummary.nominatedAvailable, 5)
  assert.equal(result.positiveSummary.selectedSameMaskPass, 2)
  assert.deepEqual(result.positiveSummary.generationLoss, ['pilot-v03-map-02'])
  assert.deepEqual(result.positiveSummary.presenceLoss, ['pilot-v03-photo-03'])
  assert.deepEqual(result.positiveSummary.nominationLoss, ['pilot-v03-ui-03', 'pilot-v03-map-01'])
  assert.deepEqual(result.positiveSummary.finalSelectionLoss, [
    'pilot-v03-photo-02',
    'pilot-v03-ui-02',
    'pilot-v03-map-03',
  ])
  assert.deepEqual(result.negativeSummary.falseAtPresence, ['pilot-v03-photo-04'])
  assert.deepEqual(result.negativeSummary.correctTargetAbsent, ['pilot-v03-ui-04'])
  assert.deepEqual(result.negativeSummary.uncertain, ['pilot-v03-map-04'])
  assert.deepEqual(result.negativeSummary.falseOutputs, ['pilot-v03-photo-04'])
  assert.equal(result.negativeSummary.correctUnknown, 2)
})

await test('H6 raw presence maximum preserves stable tie order and rejects a forged winner', () => {
  const { availability, replay } = fixture()
  const tied = replay.rows[0]!.presence.selection!
  tied.probabilities = { present: 0.5, absent: 0.5, uncertain: 0 }
  tied.nativeChoice = 'absent'
  tied.choice = 'present'
  tied.tied = ['present', 'absent']
  assert.doesNotThrow(() => evaluateH6ContextIdentity(availability, replay, new Set()))
  tied.choice = 'absent'
  assert.throws(
    () => evaluateH6ContextIdentity(availability, replay, new Set()),
    /presence-unstable-maximum/u,
  )
})

await test('H6 preserves technical errors and cancellation without counting them as semantic unknowns', () => {
  const { availability, replay } = fixture()
  const providerFailure = replay.rows[1]!
  providerFailure.status = 'error'
  providerFailure.error_code = 'PROVIDER_ERROR'
  providerFailure.nominations = []
  providerFailure.unknown_reason = null
  providerFailure.final_selection = null
  providerFailure.final_metadata = null
  const cancelled = replay.rows[5]!
  cancelled.status = 'timeout'
  cancelled.presence = { selection: null, metadata: null }
  cancelled.error_code = 'TIMEOUT'
  cancelled.nominations = []
  cancelled.unknown_reason = null
  cancelled.final_selection = null
  cancelled.final_metadata = null
  const result = evaluateH6ContextIdentity(availability, replay, new Set())
  assert.equal(
    result.allRows.find((row) => row.caseId === providerFailure.case_id)?.errorCode,
    'PROVIDER_ERROR',
  )
  assert.equal(result.allRows.find((row) => row.caseId === cancelled.case_id)?.status, 'timeout')
  assert.deepEqual(result.negativeSummary.errorRows, [])
})

await test('H6 independently joins a resolved presence stage to its raw recorder trace', async () => {
  const { replay } = fixture()
  const row = replay.rows[0]!
  const selection = row.presence.selection!
  row.logical_calls = [
    {
      case_id: row.case_id,
      stage: 'presence',
      call_ordinal: 1,
      logical_id: 1,
      request_sha256: digest('c'),
      outcome: 'resolved',
    },
  ]
  replay.logical_calls = [
    { logicalId: 1, requestSha256: digest('c'), request: {}, physicalIds: [1] },
  ]
  const recordingRoot = await mkdtemp(resolve(tmpdir(), 'h6-decision-trace-'))
  try {
    await writeFile(
      resolve(recordingRoot, 'decision-trace-1.json'),
      JSON.stringify({
        status: 'recorded',
        questions: [
          {
            questionId: 'presence',
            answerType: 'choice',
            selected: selection.nativeChoice,
            probabilities: Object.entries(selection.probabilities!).map(([optionId, value]) => ({
              optionId,
              value,
            })),
          },
        ],
      }),
    )
    const verified = await verifyH6DecisionTraceArtifacts(recordingRoot, replay)
    assert.equal(verified.verifiedStages, 1)
    await writeFile(
      resolve(recordingRoot, 'decision-trace-1.json'),
      JSON.stringify({
        status: 'recorded',
        questions: [
          {
            questionId: 'presence',
            answerType: 'choice',
            selected: 'absent',
            probabilities: Object.entries(selection.probabilities!).map(([optionId, value]) => ({
              optionId,
              value,
            })),
          },
        ],
      }),
    )
    await assert.rejects(verifyH6DecisionTraceArtifacts(recordingRoot, replay), /native-choice/u)
  } finally {
    await rm(recordingRoot, { recursive: true, force: true })
  }
})
