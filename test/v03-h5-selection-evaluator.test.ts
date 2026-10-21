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
    const sourceFamily = caseId.startsWith('pilot-v03-ui-') ? 'h4e-sam2' : 'h3-dino-sam2'
    const sourceAlias = sourceFamily === 'h4e-sam2' ? 'candidate-013' : 'C00'
    const maskSha256 = digest(String(index % 10))
    const candidateReceipts = pass
      ? [{ family: sourceFamily, id: sourceAlias, maskSha256, score: { pass: true } }]
      : []
    return {
      caseId,
      presence,
      sourceSha256: digest(String((index + 1) % 10)),
      sourceDimensions: { width: 12, height: 8 },
      families: {
        'h3-dino-sam2': {
          available: pass && sourceFamily === 'h3-dino-sam2',
          candidateReceipts: sourceFamily === 'h3-dino-sam2' ? candidateReceipts : [],
        },
        'omni-sam2': { available: false, candidateReceipts: [] },
        'h4e-sam2': {
          available: pass && sourceFamily === 'h4e-sam2',
          candidateReceipts: sourceFamily === 'h4e-sam2' ? candidateReceipts : [],
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
    if (truth.presence === 'absent')
      return { case_id, status: 'unknown' as const, nominations: [], candidateRoster: [] }
    const sourceFamily = case_id.startsWith('pilot-v03-ui-')
      ? ('h4e-sam2' as const)
      : ('h3b-dino-sam2' as const)
    const sourceAlias = sourceFamily === 'h4e-sam2' ? 'candidate-013' : 'C00'
    const candidateMaskSha256 =
      truth.families[sourceFamily === 'h4e-sam2' ? 'h4e-sam2' : 'h3-dino-sam2']!
        .candidateReceipts[0]?.maskSha256 ?? digest('f')
    const family = sourceFamily === 'h4e-sam2' ? ('U' as const) : ('D' as const)
    const candidateRoster = [
      {
        family,
        composerAlias: family === 'D' ? 'D00' : 'U00',
        sourceFamily,
        sourceAlias,
        candidateMaskSha256,
        sourceMaskPath: 'candidate.png',
      },
    ]
    const nominates = index !== 2
    const selects = index === 0
    return {
      case_id,
      status: selects ? ('located' as const) : ('unknown' as const),
      nominations: nominates
        ? [
            {
              family,
              topFour: [candidateRoster[0]!.composerAlias],
              nomineeAliases: [candidateRoster[0]!.composerAlias],
            },
          ]
        : [],
      candidateRoster,
      ...(selects
        ? {
            family,
            composerAlias: candidateRoster[0]!.composerAlias,
            sourceFamily,
            sourceAlias,
            candidateMaskSha256,
            selectedMaskPath: 'output.png',
            selectedMaskSha256: digest('a'),
          }
        : {}),
    }
  })
  const replay: H5ReplayEnvelope = {
    schema: 'v03-h5b-paid-replay-run-v1',
    status: 'complete',
    freezeMatched: true,
    case_ids: cases,
    h5a: {
      runSha256: availability.runSha256,
      freezeSha256: availability.freezeSha256,
    },
    budget: {
      physicalCalls: 18,
      knownCostUsd: 0.5,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      persistenceFailures: 0,
      maxPhysicalCalls: 36,
      maxCostUsd: 2,
    },
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
  replay.rows[0]!.sourceAlias = 'C99'
  assert.throws(
    () => evaluateH5Selection(availability, replay, new Set(['pilot-v03-photo-01'])),
    /selected-roster-mismatch/u,
  )
})
