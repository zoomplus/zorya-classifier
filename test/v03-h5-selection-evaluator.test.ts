import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateH5Selection,
  type H5AvailabilityReport,
  type H5ReplayEnvelope,
} from '../benchmarks/v03/evaluate-h5-selection.js'

const cases = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]
const digest = (symbol: string) => symbol.repeat(64)

function fixture() {
  const perCase = cases.map((caseId, index) => {
    const presence = ['pilot-v03-photo-04', 'pilot-v03-ui-04', 'pilot-v03-map-04'].includes(caseId)
      ? ('absent' as const)
      : ('present' as const)
    const pass = presence === 'present' && caseId !== 'pilot-v03-map-02'
    const source_family = caseId.startsWith('pilot-v03-ui-') ? 'h4e-sam2' : 'h3-dino-sam2'
    const source_alias = source_family === 'h4e-sam2' ? 'candidate-013' : 'C00'
    const maskSha256 = digest(String(index % 10))
    const candidateReceipts = [
      { family: source_family, id: source_alias, maskSha256, score: { pass } },
    ]
    return {
      caseId,
      presence,
      sourceSha256: digest(String((index + 1) % 10)),
      sourceDimensions: { width: 12, height: 8 },
      families: {
        'h3-dino-sam2': {
          available: pass && source_family === 'h3-dino-sam2',
          candidateReceipts: source_family === 'h3-dino-sam2' ? candidateReceipts : [],
        },
        'omni-sam2': { available: false, candidateReceipts: [] },
        'h4e-sam2': {
          available: pass && source_family === 'h4e-sam2',
          candidateReceipts: source_family === 'h4e-sam2' ? candidateReceipts : [],
        },
        union: { available: pass, candidateReceipts: [] },
      },
    }
  })
  const availability: H5AvailabilityReport = {
    schema: 'v03-h5a-native-proposal-availability-evaluation-v1',
    runSha256: '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0',
    freezeSha256: 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566',
    gate: { iouAtLeast: 0.5, referenceCoverageAtLeast: 0.9, sameCandidateAndReference: true },
    perCase,
  }
  const rows = cases.map((case_id, index) => {
    const truth = perCase[index]!
    const source_family = case_id.startsWith('pilot-v03-ui-')
      ? ('h4e-sam2' as const)
      : ('h3b-dino-sam2' as const)
    const source_alias = source_family === 'h4e-sam2' ? 'candidate-013' : 'C00'
    const candidate_mask_sha256 =
      truth.families[source_family === 'h4e-sam2' ? 'h4e-sam2' : 'h3-dino-sam2']!
        .candidateReceipts[0]?.maskSha256 ?? digest('f')
    const family = source_family === 'h4e-sam2' ? ('U' as const) : ('D' as const)
    const candidate_roster = [
      {
        family,
        composer_alias: family === 'D' ? 'D00' : 'U00',
        source_family,
        source_alias,
        candidate_mask_sha256,
        source_mask_path: 'candidate.png',
        roster_ordinal: 0,
      },
    ]
    if (truth.presence === 'absent')
      return {
        case_id,
        status: 'unknown' as const,
        physical_call_count: 0,
        logical_calls: [],
        nominations: [],
        candidate_roster,
      }
    const nominates = index !== 2
    const selects = index === 0
    return {
      case_id,
      status: selects ? ('located' as const) : ('unknown' as const),
      physical_call_count: 0,
      logical_calls: [],
      nominations: nominates
        ? [
            {
              family,
              top_four: [candidate_roster[0]!.composer_alias],
              nominee_aliases: [candidate_roster[0]!.composer_alias],
            },
          ]
        : [],
      candidate_roster,
      ...(selects
        ? {
            selected_family: family,
            selected_alias: candidate_roster[0]!.composer_alias,
            source_family: source_family,
            source_alias: source_alias,
            candidate_mask_sha256: candidate_mask_sha256,
            selected_mask_path: 'output.png',
            selected_mask_sha256: digest('a'),
          }
        : {}),
    }
  })
  const replay: H5ReplayEnvelope = {
    schema: 'v03-h5b-paid-replay-run-v1',
    status: 'complete',
    case_ids: cases,
    h5a: {
      run_sha256: availability.runSha256,
      freeze_sha256: availability.freezeSha256,
    },
    budget: {
      admitted_physical_calls: 0,
      known_cost_usd: 0,
      unknown_cost_calls: 0,
      in_flight_calls: 0,
      accounted_exposure_usd: 0,
      max_physical_calls: 36,
      max_cost_usd: 2,
    },
    route: {
      model: 'openai/gpt-6-luna-decisions',
      provider: 'openai',
      providerName: 'OpenAI',
      apiEndpoint: '/api/alpha/decisions',
      allowFallbacks: false,
    },
    source_closure: [],
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

await test('H5 selection evaluation separates generation, nomination and final-selection loss', () => {
  const { availability, replay } = fixture()
  const result = evaluateH5Selection(availability, replay, new Set(['pilot-v03-photo-01']))
  assert.equal(result.positiveSummary.denominator, 9)
  assert.equal(result.positiveSummary.generationLoss[0], 'pilot-v03-map-02')
  assert.equal(result.positiveSummary.nominationLoss[0], 'pilot-v03-photo-03')
  assert.equal(result.positiveSummary.finalSelectionLoss.length, 6)
  assert.equal(result.negativeSummary.correctUnknown, 3)
})

await test('H5 selected output must match a closed candidate roster entry', () => {
  const { availability, replay } = fixture()
  replay.rows[0]!.source_alias = 'C99'
  assert.throws(
    () => evaluateH5Selection(availability, replay, new Set(['pilot-v03-photo-01'])),
    /selected-roster-mismatch/u,
  )
})
