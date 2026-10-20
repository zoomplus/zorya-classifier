import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import type { DecisionPort, DecisionRequest } from '../src/entities/contracts.js'
import { createOpenRouterVision } from '../src/infrastructure/openrouter-vision.js'
import { parseOrdinaryVisionPilotArgs } from '../benchmarks/v02/run-ordinary-vision-axis-pilot.js'
import {
  ordinaryVisionAxisVariant,
  ordinaryVisionAxisVariantHash,
} from '../benchmarks/v02/ordinaryvisionvariant.js'
import { shouldRunConditionalOrdinaryVisionCases } from '../benchmarks/v02/ordinaryvisionpilot.js'

await test('ordinary Luna axis variant pins route, JSON schema, reasoning, and budgets', () => {
  assert.equal(ordinaryVisionAxisVariant.id, 'ordinary-luna-axis-v1')
  assert.equal(ordinaryVisionAxisVariant.promptId, 'ordinary-vision-closed-choice-v1')
  assert.equal(ordinaryVisionAxisVariant.model, 'openai/gpt-6-luna')
  assert.equal(ordinaryVisionAxisVariant.provider, 'openai')
  assert.equal(ordinaryVisionAxisVariant.providerName, 'OpenAI')
  assert.equal(
    ordinaryVisionAxisVariant.apiEndpoint,
    'https://openrouter.ai/api/v1/chat/completions',
  )
  assert.equal(ordinaryVisionAxisVariant.allowFallbacks, false)
  assert.equal(ordinaryVisionAxisVariant.responseFormat, 'json-schema')
  assert.equal(ordinaryVisionAxisVariant.reasoningEffort, 'none')
  assert.equal(ordinaryVisionAxisVariant.maxOutputTokens, 1024)
  assert.equal(ordinaryVisionAxisVariant.boxTolerancePx, 8)
  assert.equal(ordinaryVisionAxisVariant.timeoutMs, 45000)
  assert.equal(ordinaryVisionAxisVariant.retries, 0)
})

await test('ordinary Luna variant hash requires and freezes source/prompt hashes', () => {
  const sourceHashes = { 'src/infrastructure/vision-chat.ts': 'a'.repeat(64) }
  assert.equal(
    ordinaryVisionAxisVariantHash(sourceHashes),
    ordinaryVisionAxisVariantHash(sourceHashes),
  )
  assert.notEqual(
    ordinaryVisionAxisVariantHash(sourceHashes),
    ordinaryVisionAxisVariantHash({
      ...sourceHashes,
      'src/infrastructure/vision-chat.ts': 'b'.repeat(64),
    }),
  )
  assert.throws(() => ordinaryVisionAxisVariantHash({}))
  assert.throws(() => ordinaryVisionAxisVariantHash({ invalid: 'not-a-sha256' }))
})

await test('ordinary vision provider serializes a pinned JSON-schema request with reasoning disabled', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const decision: DecisionPort = createOpenRouterVision({
    apiKey: 'fixture-key',
    model: ordinaryVisionAxisVariant.model,
    provider: ordinaryVisionAxisVariant.provider,
    providerName: ordinaryVisionAxisVariant.providerName,
    responseFormat: ordinaryVisionAxisVariant.responseFormat,
    reasoningEffort: ordinaryVisionAxisVariant.reasoningEffort,
    maxOutputTokens: ordinaryVisionAxisVariant.maxOutputTokens,
    fetch: async (url, init) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(
        JSON.stringify({
          id: 'fixture-id',
          model: 'openai/gpt-6-luna-20261006',
          provider: 'OpenAI',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  answers: {
                    selection: { ranking: ['left00'] },
                    presence: { presence: 'unknown' },
                  },
                }),
              },
            },
          ],
          usage: { cost: 0.0001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const request: DecisionRequest = {
    state: ['ORIGINAL fixture image state'],
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'choose a closed option',
        criteria: { left00: '[0, 10)', left01: '[10, 20)' },
      },
      presence: { type: 'noul', instructions: 'evaluate presence' },
    },
  }
  const result = await decision.decide(request, new AbortController().signal)
  assert.equal(capturedUrl, ordinaryVisionAxisVariant.apiEndpoint)
  assert.ok(capturedInit)
  const body = JSON.parse(String(capturedInit.body)) as Record<string, unknown>
  assert.equal(body.model, ordinaryVisionAxisVariant.model)
  assert.deepEqual(body.provider, {
    only: ['openai'],
    allow_fallbacks: false,
    require_parameters: true,
  })
  assert.equal(body.max_tokens, 1024)
  assert.deepEqual(body.reasoning, { effort: 'none' })
  assert.equal((body.response_format as { type: string }).type, 'json_schema')
  assert.equal((result.answers.selection as { type: string }).type, 'ranked-choice')
})

await test('ordinary Luna CLI requires explicit paid intent and only exposes fixed variant options', () => {
  assert.throws(() => parseOrdinaryVisionPilotArgs([]), /explicit --allow-paid/u)
  const parsed = parseOrdinaryVisionPilotArgs(['--allow-paid', '--image-root', './photos'])
  assert.equal(parsed.imageRoot, resolve('./photos'))
  assert.throws(
    () => parseOrdinaryVisionPilotArgs(['--allow-paid', '--model', 'other']),
    /Unknown option/u,
  )
})

await test('conditional old cases are gated on at least one located initial positive', () => {
  assert.equal(
    shouldRunConditionalOrdinaryVisionCases([
      { caseId: 'photo-dev-02', status: 'unknown' },
      { caseId: 'photo-dev-03', status: 'failed' },
    ]),
    false,
  )
  assert.equal(
    shouldRunConditionalOrdinaryVisionCases([
      { caseId: 'photo-dev-02', status: 'located' },
      { caseId: 'photo-dev-03', status: 'unknown' },
    ]),
    true,
  )
})
