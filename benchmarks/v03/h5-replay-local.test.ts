import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DecisionRequest } from '../../src/entities/contracts.js'
import { createOpenRouterDecisions } from '../../src/openrouter.js'
import { RunBudget } from '../v02/budget.js'
import { recordProvider } from '../v02/recording.js'
import { H5_MODEL, runH5bPaidReplay } from './run-h5b-paid-replay.js'

const H5A_DIRECTORY =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h5a-native-proposals-v2'
const H4E_DIRECTORY =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1'
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ROUTE = {
  model: H5_MODEL,
  provider: 'openai' as const,
  providerName: 'OpenAI' as const,
  apiEndpoint: '/api/alpha/decisions' as const,
  allowFallbacks: false,
} as const
const CASE_IDS = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]

type ReplayCase = {
  case_id: string
  status: string
  physical_call_count: number
  logical_calls: unknown[]
  selected_mask_path: string | null
  selected_mask_sha256: string | null
  nominations: unknown[]
}
type ReplayRecord = {
  schema: string
  status: string
  case_ids: string[]
  physical_call_count: number
  physical_calls: unknown[]
  budget: { admitted_physical_calls: number; in_flight_calls: number }
  rows: ReplayCase[]
}

function mockAnswer(profile: 'positive-first' | 'final-none') {
  let calls = 0
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    calls++
    const wire = JSON.parse(String(init?.body)) as DecisionRequest & {
      model: string
      provider: { only: string[]; allow_fallbacks: boolean }
    }
    assert.equal(wire.model, H5_MODEL)
    assert.deepEqual(wire.provider, { only: ['openai'], allow_fallbacks: false })
    const question = wire.questions.selection
    assert.ok(question?.type === 'choice')
    const keys = Object.keys(question.criteria)
    const isFinal = question.rankingSize !== 4
    const winner =
      profile === 'final-none' && isFinal ? 'none' : (keys.find((key) => key !== 'none') ?? 'none')
    const remaining = keys.filter((key) => key !== winner)
    const probabilities = Object.fromEntries([
      [winner, 0.7],
      ...remaining.map((key) => [key, remaining.length === 0 ? 0 : 0.3 / remaining.length]),
    ])
    return new Response(
      JSON.stringify({
        id: `mock-${calls}`,
        model: H5_MODEL,
        provider: 'OpenAI',
        answers: { selection: { type: 'choice', choice: winner, probabilities } },
        usage: { input_tokens: 4, output_tokens: 3, cost: 0 },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  return { mockFetch, calls: () => calls }
}

async function runProfile(
  profile: 'positive-first' | 'final-none',
  h4eDirectory: string = H4E_DIRECTORY,
) {
  const temporary = await mkdtemp(join(tmpdir(), 'zorya-h5b-replay-smoke-'))
  const outputDirectory = join(temporary, 'run')
  const budget = new RunBudget(36, 2, 0.1)
  const mock = mockAnswer(profile)
  const recorder = recordProvider(
    (fetcher) =>
      createOpenRouterDecisions({
        apiKey: 'test-only-not-a-secret',
        model: H5_MODEL,
        provider: 'openai',
        providerName: 'OpenAI',
        fetch: fetcher,
      }),
    budget,
    join(outputDirectory, 'provider-calls'),
    ROUTE,
    mock.mockFetch,
  )
  try {
    const result = (await runH5bPaidReplay({
      repositoryRoot: REPOSITORY_ROOT,
      h5aDirectory: H5A_DIRECTORY,
      h4eDirectory,
      outputDirectory,
      recorder,
      budget,
      route: ROUTE,
    })) as ReplayRecord
    assert.equal(result.schema, 'v03-h5b-paid-replay-run-v1')
    assert.equal(result.status, 'complete')
    assert.deepEqual(result.case_ids, CASE_IDS)
    assert.deepEqual(
      result.rows.map((row) => row.case_id),
      CASE_IDS,
    )
    assert.equal(result.rows.length, 12)
    assert.equal(result.physical_call_count, mock.calls())
    assert.equal(result.physical_call_count, recorder.calls.length)
    assert.ok(result.physical_call_count <= 36)
    assert.equal(result.budget.admitted_physical_calls, result.physical_call_count)
    assert.equal(result.budget.in_flight_calls, 0)
    for (const row of result.rows) {
      assert.ok(row.physical_call_count <= 3, `${row.case_id} exceeded three calls`)
      assert.ok(row.logical_calls.length <= 3, `${row.case_id} exceeded three logical operations`)
      if (profile === 'positive-first' && row.status === 'located') {
        assert.ok(row.selected_mask_path)
        assert.match(row.selected_mask_sha256 ?? '', /^[a-f0-9]{64}$/u)
      }
      if (profile === 'final-none') {
        assert.equal(row.status, 'unknown', `${row.case_id}: ${JSON.stringify(row)}`)
        assert.equal(row.selected_mask_path, null)
        assert.equal(row.selected_mask_sha256, null)
      }
    }
    if (profile === 'positive-first') {
      const located = result.rows.filter((row) => row.status === 'located')
      assert.ok(located.length > 0)
      for (const selected of located) {
        const mask = await readFile(join(outputDirectory, selected.selected_mask_path!))
        try {
          assert.ok(mask.byteLength > 0)
          assert.equal(
            createHash('sha256').update(mask).digest('hex'),
            selected.selected_mask_sha256,
          )
        } finally {
          mask.fill(0)
        }
      }
    }
    return { result, recorder, outputDirectory }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await test('frozen H5 artifacts replay through the mock adapter with first actual mask selection', async () => {
  const { result, recorder } = await runProfile('positive-first', await realpath(H4E_DIRECTORY))
  assert.ok(result.rows.every((row) => row.status === 'located'))
  assert.equal(recorder.calls.length, result.physical_call_count)
})

await test('frozen H5 artifacts preserve explicit final none as unknown without mask output', async () => {
  const { result } = await runProfile('final-none')
  assert.ok(result.rows.every((row) => row.status === 'unknown'))
})

await test('frozen H5 replay retains all 12 rows when each mock request returns a provider error', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'zorya-h5b-replay-error-'))
  const outputDirectory = join(temporary, 'run')
  const budget = new RunBudget(36, 2, 0.1)
  let calls = 0
  const mockFetch: typeof globalThis.fetch = async () => {
    calls++
    return new Response(
      JSON.stringify({
        error: {
          message: 'intentional mock invalid request',
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  const recorder = recordProvider(
    (fetcher) =>
      createOpenRouterDecisions({
        apiKey: 'test-only-not-a-secret',
        model: H5_MODEL,
        provider: 'openai',
        providerName: 'OpenAI',
        fetch: fetcher,
      }),
    budget,
    join(outputDirectory, 'provider-calls'),
    ROUTE,
    mockFetch,
  )
  try {
    const result = (await runH5bPaidReplay({
      repositoryRoot: REPOSITORY_ROOT,
      h5aDirectory: H5A_DIRECTORY,
      h4eDirectory: H4E_DIRECTORY,
      outputDirectory,
      recorder,
      budget,
      route: ROUTE,
    })) as ReplayRecord
    assert.deepEqual(
      result.rows.map((row) => row.case_id),
      CASE_IDS,
    )
    assert.equal(result.rows.length, 12)
    assert.equal(result.physical_call_count, calls)
    assert.equal(result.physical_call_count, recorder.calls.length)
    assert.ok(result.rows.every((row) => row.status === 'error' || row.status === 'unknown'))
    assert.ok(result.rows.every((row) => row.physical_call_count <= 3))
    assert.equal(result.budget.in_flight_calls, 0)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
