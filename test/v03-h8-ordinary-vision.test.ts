import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { RunBudget } from '../benchmarks/v02/budget.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import type { PhysicalCallRecord } from '../benchmarks/v02/recording.js'
import { H6_CASE_IDS } from '../benchmarks/v03/h6-replay-kernel.js'
import { createOpenRouterVision } from '../src/infrastructure/openrouter-vision.js'
import {
  H8_CHAT_ENDPOINT,
  H8_LUNA_MODEL,
  runH8OrdinaryVisionReplay,
  type H8CapabilityReceipt,
  type H8Route,
} from '../benchmarks/v03/run-h8-ordinary-vision.js'

const repositoryRoot = process.cwd()
const nativeRoot = resolve(repositoryRoot, '../segmentation-research/.run/v03')
const h5aDirectory = resolve(nativeRoot, 'h5a-native-proposals-v2')
const h4eDirectory = resolve(nativeRoot, 'h4e-sam2-context-prompt-v1')

function fakeCapabilityReceipt(): H8CapabilityReceipt {
  return {
    model: H8_LUNA_MODEL,
    provider: 'openai',
    endpoint: H8_CHAT_ENDPOINT,
    capturedAt: '2026-10-21T00:00:00.000Z',
    modalities: ['text', 'image'],
    structuredOutputs: true,
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.5,
    source: 'https://openrouter.ai/openai/gpt-6-luna/providers',
    receiptSha256: 'a'.repeat(64),
  }
}

function responseFor(body: Record<string, unknown>, model: string, cost = 0.001): Response {
  const messages = body.messages as Array<{ content: unknown }>
  const content = messages?.[1]?.content
  assert.ok(Array.isArray(content))
  const parts = content as Array<{ type: string; text?: string }>
  const taskPart = parts.find(
    (part) => part.type === 'text' && part.text?.startsWith('CLASSIFICATION_TASK\n'),
  )
  assert.ok(taskPart?.text)
  const task = JSON.parse(taskPart.text.slice('CLASSIFICATION_TASK\n'.length)) as {
    questions: Record<
      string,
      | { kind: 'categorical'; rankingSize: number; options: Record<string, string> }
      | { kind: 'presence' }
    >
  }
  const answers: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(task.questions)) {
    if (question.kind === 'presence') {
      answers[id] = { presence: 'present' }
    } else {
      answers[id] = { ranking: Object.keys(question.options).slice(0, question.rankingSize) }
    }
  }
  return new Response(
    JSON.stringify({
      id: 'h8-controlled-fetch',
      model,
      provider: 'OpenAI',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { content: JSON.stringify({ answers }) },
        },
      ],
      usage: { cost },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

await test('H8 uses recorded strict chat requests on the fixed H6 cases and retains a failed row', async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'zorya-h8-smoke-'))
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }))

  const route: H8Route = {
    model: H8_LUNA_MODEL,
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: H8_CHAT_ENDPOINT,
    allowFallbacks: false,
    responseFormat: 'json-schema',
    reasoningEffort: 'medium',
    maxOutputTokens: 4096,
  }
  const budget = new RunBudget(48, 2.4, 0.05)
  const requestBodies: Array<Record<string, unknown>> = []
  let fetchCount = 0
  const controlledFetch: typeof globalThis.fetch = async (input, init) => {
    fetchCount++
    assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-key')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requestBodies.push(body)
    assert.equal(body.model, route.model)
    assert.deepEqual(body.provider, {
      only: ['openai'],
      allow_fallbacks: false,
      require_parameters: true,
    })
    assert.deepEqual(body.reasoning, { effort: 'medium' })
    assert.equal(body.max_tokens, 4096)
    assert.equal(body.stream, false)
    assert.equal((body.response_format as { type: string }).type, 'json_schema')
    assert.equal(
      (body.response_format as { json_schema: { strict: boolean } }).json_schema.strict,
      true,
    )
    const content = (body.messages as Array<{ content: unknown }>)[1]?.content
    assert.ok(Array.isArray(content))
    const parts = content as Array<{ type: string; text?: string }>
    const imageCount = parts.filter((part) => part.type === 'image_url').length
    const taskPart = parts.find(
      (part) => part.type === 'text' && part.text?.startsWith('CLASSIFICATION_TASK\n'),
    )
    assert.ok(taskPart?.text)
    const task = JSON.parse(taskPart.text.slice('CLASSIFICATION_TASK\n'.length)) as {
      questions: Record<string, { rankingSize: number }>
    }
    if (Object.hasOwn(task.questions, 'presence')) {
      assert.equal(task.questions.presence?.rankingSize, 1)
      assert.equal(imageCount, 1)
    } else {
      const stateText = parts
        .filter(
          (part): part is { type: 'text'; text: string } => part.type === 'text' && !!part.text,
        )
        .map((part) => part.text)
        .join('\n')
      if (stateText.includes('Rank up to four candidate aliases')) {
        assert.equal(task.questions.selection?.rankingSize, 4)
        assert.ok(imageCount >= 2 && imageCount <= 5)
      } else {
        assert.equal(task.questions.selection?.rankingSize, 1)
        assert.ok(imageCount >= 2 && imageCount <= 9)
      }
    }
    if (fetchCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'mock upstream unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    return responseFor(body, route.model)
  }

  const recorder = recordProvider(
    (fetch) =>
      createOpenRouterVision({
        apiKey: 'fixture-key',
        model: route.model,
        provider: route.provider,
        providerName: route.providerName,
        responseFormat: route.responseFormat,
        reasoningEffort: route.reasoningEffort,
        maxOutputTokens: route.maxOutputTokens,
        fetch,
      }),
    budget,
    resolve(temporaryRoot, 'run', 'provider-calls'),
    {
      model: route.model,
      provider: route.provider,
      providerName: route.providerName,
      apiEndpoint: route.apiEndpoint,
      allowFallbacks: false,
    },
    controlledFetch,
  )
  const outputDirectory = resolve(temporaryRoot, 'run')
  const run = await runH8OrdinaryVisionReplay({
    repositoryRoot,
    h5aDirectory,
    h4eDirectory,
    outputDirectory,
    recorder,
    budget,
    route,
    capabilityReceipt: fakeCapabilityReceipt(),
  })

  const rows = run.rows as Array<Record<string, unknown>>
  assert.equal(run.status, 'complete')
  assert.equal(run.arm, 'h8a-openai-luna-chat')
  assert.equal(rows.length, 12)
  assert.deepEqual(
    rows.map((row) => row.case_id),
    H6_CASE_IDS,
  )
  assert.equal(rows[0]?.status, 'error')
  assert.equal(rows[0]?.physical_call_count, 1)
  assert.equal(
    rows.slice(1).every((row) => row.status === 'located'),
    true,
  )
  const expectedSuccessfulCallCounts = rows.slice(1).map((row) => {
    const roster = row.candidate_roster as Array<{ family: string }>
    return 2 + new Set(roster.map((candidate) => candidate.family)).size
  })
  assert.deepEqual(
    rows.slice(1).map((row) => row.physical_call_count),
    expectedSuccessfulCallCounts,
  )
  const expectedPhysicalCalls =
    1 + expectedSuccessfulCallCounts.reduce((sum, value) => sum + value, 0)
  assert.equal(run.physical_call_count, expectedPhysicalCalls)
  assert.equal(fetchCount, expectedPhysicalCalls)
  assert.equal(requestBodies.length, expectedPhysicalCalls)
  assert.equal(
    recorder.calls.every((call: PhysicalCallRecord) => call.route.apiEndpoint === H8_CHAT_ENDPOINT),
    true,
  )
  assert.equal(
    recorder.calls.every((call: PhysicalCallRecord) => call.route.model === route.model),
    true,
  )
  assert.equal(budget.snapshot().unknownCostCalls, 1)

  const successfulRows = rows.slice(1)
  for (const row of successfulRows) {
    const presence = row.presence as {
      selection: { probabilities: unknown; nativeChoice: unknown }
    }
    assert.equal(presence.selection.probabilities, null)
    assert.equal(presence.selection.nativeChoice, null)
    const nominations = row.nominations as Array<{
      family: string
      selection: { probabilities: unknown; nativeChoice: unknown; ranking?: string[] }
      top_four: string[]
    }>
    const roster = row.candidate_roster as Array<{ family: string }>
    const families = new Set(roster.map((candidate) => candidate.family))
    assert.equal(nominations.length, families.size)
    for (const nomination of nominations) {
      const available = roster.filter((candidate) => candidate.family === nomination.family).length
      assert.equal(nomination.selection.probabilities, null)
      assert.equal(nomination.selection.nativeChoice, null)
      assert.equal(nomination.selection.ranking?.length, Math.min(4, available + 1))
      assert.equal(nomination.top_four.length, Math.min(4, available + 1))
    }
    const final = row.final_selection as {
      probabilities: unknown
      nativeChoice: unknown
      ranking?: string[]
    }
    assert.equal(final.probabilities, null)
    assert.equal(final.nativeChoice, null)
    assert.equal(final.ranking?.length, 1)
    const finalMetadata = row.final_metadata as { model: string; provider: string }
    assert.equal(finalMetadata.model, route.model)
    assert.equal(finalMetadata.provider, 'OpenAI')
    const selectedPath = row.selected_mask_path as string
    const selectedHash = row.selected_mask_sha256 as string
    const selectedBytes = await readFile(resolve(outputDirectory, selectedPath))
    assert.equal(createHash('sha256').update(selectedBytes).digest('hex'), selectedHash)
  }

  const freeze = JSON.parse(await readFile(resolve(outputDirectory, 'freeze.json'), 'utf8')) as {
    route: H8Route
    capability_receipt: H8CapabilityReceipt
  }
  assert.deepEqual(freeze.route, route)
  assert.deepEqual(freeze.capability_receipt, fakeCapabilityReceipt())
  assert.match(freeze.capability_receipt.receiptSha256, /^[a-f0-9]{64}$/u)
})
