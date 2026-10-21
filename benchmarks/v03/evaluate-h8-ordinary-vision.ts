import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { H5AvailabilityReport } from './evaluate-h5-selection.js'
import {
  verifyH6DecisionTraceArtifacts,
  verifyH6PhysicalReceiptArtifacts,
  verifyH6SelectedMaskArtifacts,
  type H6ReplayEnvelope,
} from './evaluate-h6-context-identity.js'

const H5A_RUN_SHA256 = '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0'
const H5A_FREEZE_SHA256 = 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566'
const CASE_IDS = [
  ...Array.from({ length: 4 }, (_, i) => `pilot-v03-photo-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, i) => `pilot-v03-ui-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, i) => `pilot-v03-map-${String(i + 1).padStart(2, '0')}`),
]
const ARMS = {
  'h8a-openai-luna-chat': {
    model: 'openai/gpt-6-luna',
    maxCost: 2.4,
    reserve: 0.05,
    inputPrice: 0.1,
    outputPrice: 0.5,
    capabilityFile: 'gpt-6-luna.receipt.json',
  },
  'h8b-openai-gpt-6.1-sol-chat': {
    model: 'openai/gpt-6.1-sol',
    maxCost: 12,
    reserve: 0.25,
    inputPrice: 2,
    outputPrice: 10,
    capabilityFile: 'gpt-6.1-sol.receipt.json',
  },
} as const

export type H8RankOnlySelection = {
  choice: string
  ranking?: string[]
  probabilities: null
  nativeChoice: null
  tied: string[]
}
type H8Row = Omit<
  H6ReplayEnvelope['rows'][number],
  'presence' | 'nominations' | 'final_selection'
> & {
  source_sha256: string
  nominations: Array<{
    family: 'D' | 'U'
    top_four: string[]
    nominee_aliases: string[]
    selection: H8RankOnlySelection
  }>
  presence: { selection: H8RankOnlySelection | null; metadata: unknown | null }
  final_selection: H8RankOnlySelection | null
}
type H8Envelope = Omit<
  H6ReplayEnvelope,
  'schema' | 'route' | 'h5a' | 'budget' | 'physical_calls' | 'rows'
> & {
  schema: 'v03-h8-ordinary-vision-run-v1'
  arm: keyof typeof ARMS
  route: {
    model: string
    provider: string
    providerName: string
    apiEndpoint: string
    allowFallbacks: false
    responseFormat: string
    reasoningEffort: string
    maxOutputTokens: number
  }
  capability_receipt: Record<string, unknown>
  h5a: H6ReplayEnvelope['h5a']
  budget: H6ReplayEnvelope['budget']
  physical_calls: Array<
    H6ReplayEnvelope['physical_calls'][number] & { chat_parameters: Record<string, unknown> }
  >
  replay_elapsed_ms: number
  rows: H8Row[]
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function hashFile(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function sourceFamily(name: string) {
  if (name === 'h3-dino-sam2') return 'h3b-dino-sam2'
  if (name === 'omni-sam2' || name === 'h4e-sam2') return name
  throw new Error(`h8-unexpected-source-family-${name}`)
}

function references(row: H5AvailabilityReport['perCase'][number]) {
  return ['h3-dino-sam2', 'omni-sam2', 'h4e-sam2'].flatMap((family) =>
    (row.families[family]?.candidateReceipts ?? []).map((candidate) => ({
      source_family: sourceFamily(candidate.family),
      source_alias: candidate.id,
      candidate_mask_sha256: candidate.maskSha256,
      pass: candidate.score?.pass === true,
    })),
  )
}

export function validateH8RankOnlySelection(
  selection: H8RankOnlySelection | null,
  allowed: string[],
  label = 'fixture',
) {
  assert(selection && typeof selection === 'object', `h8-selection-missing-${label}`)
  assert(selection.nativeChoice === null, `h8-native-choice-not-null-${label}`)
  assert(selection.probabilities === null, `h8-probabilities-not-null-${label}`)
  assert(
    typeof selection.choice === 'string' && allowed.includes(selection.choice),
    `h8-choice-${label}`,
  )
  assert(Array.isArray(selection.ranking), `h8-ranking-missing-${label}`)
  assert(
    selection.ranking.length >= 1 && selection.ranking.length <= allowed.length,
    `h8-ranking-size-${label}`,
  )
  assert(
    new Set(selection.ranking).size === selection.ranking.length,
    `h8-ranking-duplicate-${label}`,
  )
  assert(
    selection.ranking.every((alias) => allowed.includes(alias)),
    `h8-ranking-alias-${label}`,
  )
  assert(selection.choice === selection.ranking[0], `h8-choice-rank-mismatch-${label}`)
  assert(isDeepStrictEqual(selection.tied, []), `h8-rank-only-tied-${label}`)
}

function validateRun(availability: H5AvailabilityReport, replay: H8Envelope) {
  assert(
    availability.schema === 'v03-h5a-native-proposal-availability-evaluation-v1',
    'h8-h5a-schema',
  )
  assert(
    availability.runSha256 === H5A_RUN_SHA256 && availability.freezeSha256 === H5A_FREEZE_SHA256,
    'h8-h5a-lock',
  )
  assert(
    availability.gate.iouAtLeast === 0.5 &&
      availability.gate.referenceCoverageAtLeast === 0.9 &&
      availability.gate.sameCandidateAndReference,
    'h8-gate-changed',
  )
  assert(
    replay.schema === 'v03-h8-ordinary-vision-run-v1' && replay.status === 'complete',
    'h8-run-status',
  )
  assert(Object.hasOwn(ARMS, replay.arm), 'h8-arm')
  const arm = ARMS[replay.arm]
  assert(
    replay.route.model === arm.model &&
      replay.route.provider === 'openai' &&
      replay.route.providerName === 'OpenAI' &&
      replay.route.apiEndpoint === '/api/v1/chat/completions' &&
      replay.route.allowFallbacks === false,
    'h8-route',
  )
  assert(
    replay.route.responseFormat === 'json-schema' &&
      replay.route.reasoningEffort === 'medium' &&
      replay.route.maxOutputTokens === 4096,
    'h8-chat-parameters',
  )
  assert(
    replay.h5a.run_sha256 === H5A_RUN_SHA256 && replay.h5a.freeze_sha256 === H5A_FREEZE_SHA256,
    'h8-embedded-h5a-lock',
  )
  assert(
    isDeepStrictEqual(replay.case_ids, CASE_IDS) && replay.rows.length === CASE_IDS.length,
    'h8-case-order',
  )
  assert(
    replay.budget.max_physical_calls === 48 &&
      replay.budget.max_cost_usd === arm.maxCost &&
      replay.budget.unknown_reserve_usd_per_call === arm.reserve,
    'h8-budget-policy',
  )
  assert(
    replay.physical_call_count === replay.physical_calls.length && replay.physical_call_count <= 48,
    'h8-physical-count',
  )
  assert(
    replay.budget.admitted_physical_calls === replay.physical_call_count &&
      replay.budget.in_flight_calls === 0,
    'h8-budget-counts',
  )
  assert(
    replay.budget.known_cost_usd <= arm.maxCost &&
      replay.budget.accounted_exposure_usd <= arm.maxCost,
    'h8-budget-cost',
  )
  assert(replay.logical_call_count === replay.logical_calls.length, 'h8-logical-count')
  const callsCost = replay.physical_calls.reduce(
    (sum, item) => sum + (item.receipt?.costUsd ?? 0),
    0,
  )
  const unknownCost = replay.physical_calls.filter((item) => item.receipt?.costUsd == null).length
  assert(
    Math.abs(callsCost - replay.budget.known_cost_usd) < 1e-9 &&
      unknownCost === replay.budget.unknown_cost_calls,
    'h8-cost-receipts',
  )
  assert(
    Math.abs(
      replay.budget.accounted_exposure_usd -
        replay.budget.known_cost_usd -
        unknownCost * arm.reserve,
    ) < 1e-9,
    'h8-accounted-exposure',
  )
  for (const call of replay.physical_calls) {
    assert(
      isDeepStrictEqual(call.route, {
        model: arm.model,
        provider: 'openai',
        providerName: 'OpenAI',
        apiEndpoint: '/api/v1/chat/completions',
        allowFallbacks: false,
        responseFormat: 'json-schema',
        reasoningEffort: 'medium',
        maxOutputTokens: 4096,
      }),
      'h8-physical-route',
    )
    assert(
      isDeepStrictEqual(call.chat_parameters, {
        response_format: 'json-schema',
        reasoning_effort: 'medium',
        max_output_tokens: 4096,
      }),
      'h8-physical-chat-parameters',
    )
    assert(
      call.receipt === null || (call.receipt as { attempts?: number }).attempts === 1,
      'h8-physical-retry',
    )
  }
  assert(
    replay.rows.reduce((n, row) => n + row.physical_call_count, 0) === replay.physical_call_count,
    'h8-row-physical-total',
  )
  assert(
    replay.rows.every((row) => row.physical_call_count <= 4 && row.logical_calls.length <= 4),
    'h8-row-call-cap',
  )
  assert(
    replay.rows.reduce((n, row) => n + row.logical_calls.length, 0) === replay.logical_call_count,
    'h8-row-logical-total',
  )

  const truthByCase = new Map(availability.perCase.map((row) => [row.caseId, row]))
  const metrics = replay.rows.map((row, index) => {
    const caseId = CASE_IDS[index]!
    const truth = truthByCase.get(caseId)
    assert(row.case_id === caseId && truth, `h8-row-order-${caseId}`)
    assert(row.source_sha256 === truth.sourceSha256, `h8-source-hash-${caseId}`)
    const expected = references(truth)
    const roster = row.candidate_roster
    assert(roster.length === expected.length && roster.length <= 72, `h8-roster-count-${caseId}`)
    const ordinal = { D: 0, U: 0 }
    expected.forEach((ref, i) => {
      const family = ref.source_family === 'h3b-dino-sam2' ? 'D' : 'U'
      const item = roster[i]!
      const n = ordinal[family]++
      assert(
        item.family === family &&
          item.roster_ordinal === i &&
          item.composer_alias === `${family}${String(n).padStart(2, '0')}`,
        `h8-roster-order-${caseId}-${i}`,
      )
      assert(
        item.source_family === ref.source_family &&
          item.source_alias === ref.source_alias &&
          item.candidate_mask_sha256 === ref.candidate_mask_sha256,
        `h8-roster-join-${caseId}-${i}`,
      )
    })
    const present = row.presence.selection
    if (present)
      validateH8RankOnlySelection(present, ['present', 'absent', 'uncertain'], `${caseId}-presence`)
    assert(Boolean(present) === (row.presence.metadata !== null), `h8-presence-metadata-${caseId}`)
    const presenceChoice = present?.choice ?? null
    assert(
      presenceChoice === null || ['present', 'absent', 'uncertain'].includes(presenceChoice),
      `h8-presence-choice-${caseId}`,
    )
    if (presenceChoice === 'absent' || presenceChoice === 'uncertain') {
      assert(
        row.status === 'unknown' &&
          row.unknown_reason ===
            (presenceChoice === 'absent' ? 'target-absent' : 'presence-unresolved'),
        `h8-presence-short-circuit-${caseId}`,
      )
      assert(
        row.nominations.length === 0 &&
          !row.selected_alias &&
          !row.selected_mask_path &&
          !row.selected_mask_sha256,
        `h8-short-circuit-output-${caseId}`,
      )
    }
    if (!present)
      assert(
        row.status === 'error' || row.status === 'timeout',
        `h8-missing-presence-not-error-${caseId}`,
      )
    const nominated = new Set<string>()
    const nominatedFamilies = new Set<string>()
    let nominatedAvailable = false
    for (const nomination of row.nominations) {
      assert(!nominatedFamilies.has(nomination.family), `h8-duplicate-nomination-${caseId}`)
      nominatedFamilies.add(nomination.family)
      assert(
        nomination.top_four.length <= 4 &&
          new Set(nomination.top_four).size === nomination.top_four.length,
        `h8-top-four-${caseId}`,
      )
      validateH8RankOnlySelection(
        nomination.selection,
        [...nomination.top_four],
        `${caseId}-${nomination.family}-nomination`,
      )
      assert(
        nomination.selection.ranking!.join('\0') === nomination.top_four.join('\0'),
        `h8-rank-top-four-${caseId}`,
      )
      assert(
        isDeepStrictEqual(
          nomination.nominee_aliases,
          nomination.top_four.filter((id) => id !== 'none'),
        ),
        `h8-nominee-aliases-${caseId}`,
      )
      for (const alias of nomination.nominee_aliases) {
        const candidate = roster.find(
          (entry) => entry.family === nomination.family && entry.composer_alias === alias,
        )
        assert(candidate, `h8-nominee-roster-${caseId}-${alias}`)
        const key = `${candidate.source_family}:${candidate.source_alias}:${candidate.candidate_mask_sha256}`
        assert(!nominated.has(key), `h8-nominee-duplicate-source-${caseId}`)
        nominated.add(key)
        if (
          expected.some(
            (ref) =>
              ref.pass &&
              `${ref.source_family}:${ref.source_alias}:${ref.candidate_mask_sha256}` === key,
          )
        )
          nominatedAvailable = true
      }
    }
    const unionAvailable = expected.some((item) => item.pass)
    assert(
      unionAvailable === (truth.families.union?.available === true),
      `h8-union-truth-${caseId}`,
    )
    const selected = row.status === 'located'
    let selectedSameMaskPass = false
    if (selected) {
      assert(presenceChoice === 'present', `h8-located-without-presence-${caseId}`)
      const nomination = row.nominations.find((item) => item.family === row.selected_family)
      assert(
        nomination?.nominee_aliases.includes(row.selected_alias ?? ''),
        `h8-selected-not-nominated-${caseId}`,
      )
      const candidate = roster.find(
        (item) => item.composer_alias === row.selected_alias && item.family === row.selected_family,
      )
      assert(
        candidate &&
          candidate.source_family === row.source_family &&
          candidate.source_alias === row.source_alias &&
          candidate.candidate_mask_sha256 === row.candidate_mask_sha256,
        `h8-selected-source-${caseId}`,
      )
      assert(row.final_selection?.choice === row.selected_alias, `h8-final-choice-${caseId}`)
      validateH8RankOnlySelection(row.final_selection, [row.selected_alias!], `${caseId}-final`)
      selectedSameMaskPass = expected.some(
        (ref) =>
          ref.pass &&
          ref.source_family === candidate.source_family &&
          ref.source_alias === candidate.source_alias &&
          ref.candidate_mask_sha256 === candidate.candidate_mask_sha256,
      )
    } else {
      assert(
        !row.selected_alias &&
          !row.selected_family &&
          !row.source_alias &&
          !row.selected_mask_path &&
          !row.selected_mask_sha256,
        `h8-unlocated-mask-${caseId}`,
      )
      if (row.final_selection)
        validateH8RankOnlySelection(
          row.final_selection,
          row.final_selection.ranking ?? [],
          `${caseId}-nonlocated-final`,
        )
      if (row.unknown_reason === 'none-selected')
        assert(row.final_selection?.choice === 'none', `h8-none-choice-${caseId}`)
    }
    return {
      caseId,
      stratum: caseId.includes('-photo-') ? 'photo' : caseId.includes('-ui-') ? 'ui' : 'map',
      truth: truth.presence,
      status: row.status,
      presenceChoice,
      unionAvailable,
      presenceAdmitted: presenceChoice === 'present',
      nominatedAvailable,
      selected,
      selectedSameMaskPass,
      selectedMaskArtifactValid: false,
      errorCode: row.error_code ?? null,
      unknownReason: row.unknown_reason ?? null,
      physicalCalls: row.physical_call_count,
    }
  })
  return metrics
}

export async function evaluateH8OrdinaryVisionRun(
  runRoot: string,
  availability: H5AvailabilityReport,
  capabilityDirectory: string,
  repositoryRoot: string,
  recordingRoot = resolve(runRoot, 'provider-calls'),
) {
  const root = resolve(runRoot)
  const replay = JSON.parse(await readFile(resolve(root, 'run.json'), 'utf8')) as H8Envelope
  const freeze = JSON.parse(await readFile(resolve(root, 'freeze.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const arm = ARMS[replay.arm]
  assert(
    freeze.schema === 'v03-h8-ordinary-vision-freeze-v1' &&
      freeze.status === 'frozen-before-replay',
    'h8-freeze',
  )
  assert(
    freeze.arm === replay.arm &&
      isDeepStrictEqual(freeze.route, replay.route) &&
      isDeepStrictEqual(freeze.capability_receipt, replay.capability_receipt),
    'h8-freeze-run-mismatch',
  )
  assert(
    isDeepStrictEqual(freeze.source_closure, replay.source_closure) &&
      isDeepStrictEqual(freeze.executable_source, replay.executable_source),
    'h8-freeze-source-mismatch',
  )
  assert(
    isDeepStrictEqual(freeze.h5a, replay.h5a) &&
      isDeepStrictEqual(freeze.budget, {
        max_physical_calls: 48,
        max_cost_usd: arm.maxCost,
        unknown_reserve_usd_per_call: arm.reserve,
      }),
    'h8-freeze-input-locks',
  )
  assert(isDeepStrictEqual(freeze.case_ids, CASE_IDS), 'h8-freeze-cases')
  const capability = JSON.parse(
    await readFile(resolve(capabilityDirectory, arm.capabilityFile), 'utf8'),
  ) as Record<string, unknown>
  assert(
    replay.capability_receipt.receiptSha256 === capability.receiptSha256 &&
      replay.capability_receipt.source === capability.source &&
      replay.capability_receipt.capturedAt === capability.capturedAt,
    'h8-capability-receipt-match',
  )
  assert(
    replay.capability_receipt.model === arm.model &&
      replay.capability_receipt.provider === 'openai' &&
      replay.capability_receipt.endpoint === '/api/v1/chat/completions' &&
      replay.capability_receipt.inputUsdPerMillion === arm.inputPrice &&
      replay.capability_receipt.outputUsdPerMillion === arm.outputPrice,
    'h8-capability-claims',
  )
  const receiptPath = replay.capability_receipt.receiptPath
  assert(typeof receiptPath === 'string', 'h8-capability-path-missing')
  assert(
    (await hashFile(receiptPath)) === replay.capability_receipt.receiptSha256,
    'h8-capability-content-hash',
  )
  const rawCapability = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    data?: {
      architecture?: { input_modalities?: string[] }
      endpoints?: Array<{
        model_id?: string
        provider_name?: string
        pricing?: { prompt?: string; completion?: string }
        supported_parameters?: string[]
      }>
    }
  }
  assert(
    rawCapability.data?.architecture?.input_modalities?.includes('image'),
    'h8-capability-image-input',
  )
  assert(
    rawCapability.data?.endpoints?.some(
      (endpoint) =>
        endpoint.model_id === arm.model &&
        endpoint.provider_name === 'OpenAI' &&
        Math.abs(Number(endpoint.pricing?.prompt) * 1_000_000 - arm.inputPrice) < 1e-9 &&
        Math.abs(Number(endpoint.pricing?.completion) * 1_000_000 - arm.outputPrice) < 1e-9 &&
        endpoint.supported_parameters?.includes('response_format') &&
        endpoint.supported_parameters.includes('structured_outputs') &&
        endpoint.supported_parameters.includes('reasoning_effort'),
    ),
    'h8-capability-route-parameters',
  )
  const onDisk = JSON.parse(await readFile(resolve(root, 'run.json'), 'utf8')) as H8Envelope
  assert(isDeepStrictEqual(onDisk, replay), 'h8-run-read-stability')
  const sourceFiles = [
    ...replay.source_closure,
    ...replay.executable_source.files,
    ...replay.executable_source_after.files,
  ]
  const checked = new Map<string, string>()
  for (const file of sourceFiles) {
    const previous = checked.get(file.path)
    if (previous) assert(previous === file.sha256, `h8-source-hash-conflict-${file.path}`)
    else checked.set(file.path, file.sha256)
  }
  for (const [path, expected] of checked) {
    const absolutePath = resolve(repositoryRoot, path)
    assert((await hashFile(absolutePath)) === expected, `h8-source-hash-${path}`)
  }
  assert(
    isDeepStrictEqual(replay.executable_source, replay.executable_source_after),
    'h8-executable-source-changed',
  )
  const artifactRows = await verifyH6SelectedMaskArtifacts(
    root,
    replay as unknown as H6ReplayEnvelope,
    availability,
  )
  const physicalReceiptReplay = {
    ...replay,
    physical_calls: replay.physical_calls.map(({ chat_parameters: _chat, ...call }) => call),
  }
  const physical = await verifyH6PhysicalReceiptArtifacts(
    recordingRoot,
    physicalReceiptReplay as unknown as H6ReplayEnvelope,
  )
  const traces = await verifyH6DecisionTraceArtifacts(
    recordingRoot,
    replay as unknown as H6ReplayEnvelope,
  )
  const rows = validateRun(availability, replay)
  for (const row of rows) row.selectedMaskArtifactValid = artifactRows.has(row.caseId)
  const positives = rows.filter((row) => row.truth === 'present')
  const negatives = rows.filter((row) => row.truth === 'absent')
  const union = positives.filter((row) => row.unionAvailable)
  const admitted = union.filter((row) => row.presenceAdmitted)
  const nominated = admitted.filter((row) => row.nominatedAvailable)
  const final = nominated.filter(
    (row) => row.selected && row.selectedSameMaskPass && row.selectedMaskArtifactValid,
  )
  const stratumSuccesses: Record<'photo' | 'ui' | 'map', number> = {
    photo: final.filter((row) => row.stratum === 'photo').length,
    ui: final.filter((row) => row.stratum === 'ui').length,
    map: final.filter((row) => row.stratum === 'map').length,
  }
  const falseOutputs = negatives.filter((row) => row.selected)
  return {
    schema: 'v03-h8-ordinary-vision-independent-evaluation-v1',
    production: {
      status: replay.status,
      runSha256: await hashFile(resolve(root, 'run.json')),
      freezeSha256: await hashFile(resolve(root, 'freeze.json')),
      arm: replay.arm,
      route: replay.route,
      capabilityReceipt: replay.capability_receipt,
      capabilityArtifactSha256: replay.capability_receipt.receiptSha256,
      capabilityArtifactVerifiedAgainstReceipt: true,
      budget: replay.budget,
      replayElapsedMs: replay.replay_elapsed_ms,
      physicalCallCount: replay.physical_call_count,
      logicalCallCount: replay.logical_call_count,
      physicalReceiptAudit: physical,
      rawDecisionTraceAudit: traces,
      selectedMaskArtifactsVerified: artifactRows.size,
      selectedMaskArtifactsExpected: rows.filter((row) => row.selected).length,
      sourceFilesHashed: checked.size,
      advancementGate: {
        pass:
          stratumSuccesses.photo === 3 &&
          stratumSuccesses.ui === 3 &&
          stratumSuccesses.map >= 1 &&
          falseOutputs.length === 0,
        successesByStratum: stratumSuccesses,
        falseOutputCount: falseOutputs.length,
      },
    },
    positiveSummary: {
      denominator: positives.length,
      unionAvailable: union.length,
      presenceAdmittedAfterUnion: admitted.length,
      nominatedAvailable: nominated.length,
      selectedSameMaskPass: final.length,
      byStratum: Object.fromEntries(
        ['photo', 'ui', 'map'].map((stratum) => {
          const values = final.filter((row) => row.stratum === stratum)
          return [
            stratum,
            {
              denominator: positives.filter((row) => row.stratum === stratum).length,
              successes: values.length,
              cases: values.map((row) => row.caseId),
            },
          ]
        }),
      ),
      generationLoss: positives.filter((row) => !row.unionAvailable).map((row) => row.caseId),
      presenceLoss: union.filter((row) => !row.presenceAdmitted).map((row) => row.caseId),
      nominationLoss: admitted.filter((row) => !row.nominatedAvailable).map((row) => row.caseId),
      finalSelectionLoss: nominated
        .filter(
          (row) => !(row.selected && row.selectedSameMaskPass && row.selectedMaskArtifactValid),
        )
        .map((row) => row.caseId),
    },
    negativeSummary: {
      denominator: negatives.length,
      presenceChoices: Object.fromEntries(
        ['present', 'absent', 'uncertain'].map((choice) => [
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
      falseOutputs: falseOutputs.map((row) => row.caseId),
      errors: negatives.filter((row) => row.status === 'error' || row.status === 'timeout'),
    },
    rows,
  }
}

async function main() {
  const [runRoot, outputPath, capabilityDirectory, repositoryRoot, recordingRoot] =
    process.argv.slice(2)
  assert(
    runRoot && outputPath && capabilityDirectory && repositoryRoot,
    'usage: evaluate-h8-ordinary-vision <run-root> <output-json> <capability-directory> <repository-root> [provider-calls-root]',
  )
  const availability = JSON.parse(
    await readFile(
      resolve('docs/evidence/v03/h5a-native-proposal-availability-evaluation.json'),
      'utf8',
    ),
  ) as H5AvailabilityReport
  const result = await evaluateH8OrdinaryVisionRun(
    runRoot,
    availability,
    capabilityDirectory,
    repositoryRoot,
    recordingRoot,
  )
  await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(
    `${JSON.stringify({ arm: result.production.arm, production: result.production, positiveSummary: result.positiveSummary, negativeSummary: result.negativeSummary, outputPath: resolve(outputPath) })}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
