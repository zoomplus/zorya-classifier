import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { RunBudget, RunBudgetExhausted } from '../benchmarks/v02/budget.js'
import { inputManifestSchema, modelRequestManifest } from '../benchmarks/v02/protocol.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { applyPromptVariant, promptVariants } from '../benchmarks/v02/promptvariants.js'
import {
  createLunaDecisionProvider,
  createTextProviderForVariant,
} from '../benchmarks/v02/runner.js'
import { parseV02RunnerArgs } from '../benchmarks/v02/run.js'
import { evaluateDiagnostic } from '../benchmarks/v02/evaluate-diagnostic.js'

await test('Luna native control uses the typed Decisions endpoint and preserves returned probabilities', async () => {
  let calls = 0
  const decision = createLunaDecisionProvider('fixture-key', async (url, init) => {
    calls++
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(body.model, 'openai/gpt-6-luna-decisions')
    assert.deepEqual(body.provider, { only: ['openai'], allow_fallbacks: false })
    assert.equal(Object.hasOwn(body, 'messages'), false)
    return new Response(
      JSON.stringify({
        id: 'fixture-id',
        model: 'openai/gpt-6-luna-decisions-20261006',
        provider: 'OpenAI',
        answers: {
          selection: {
            type: 'choice',
            choice: 'present',
            probabilities: { present: 0.8, absent: 0.2 },
          },
        },
        usage: { cost: 0.0001 },
      }),
    )
  })
  const result = await decision.decide(
    {
      state: ['Classify the image.'],
      questions: {
        selection: {
          type: 'choice',
          instructions: 'Choose the best answer.',
          criteria: { present: 'A target is visible.', absent: 'No target is visible.' },
        },
      },
    },
    AbortSignal.timeout(1000),
  )
  assert.equal(calls, 1)
  assert.deepEqual(
    result.answers.selection?.type === 'choice' && result.answers.selection.probabilities,
    { present: 0.8, absent: 0.2 },
  )
  assert.equal(result.metadata.costUsd, 0.0001)
})

await test('none reasoning probe freezes its exact text transport and limits dispatch to one call', async () => {
  const options = parseV02RunnerArgs([
    '--allow-paid',
    '--max-physical-calls',
    '1',
    '--max-cost-usd',
    '0.10',
    '--transport-probe',
    '--transport-variant',
    'none-json-schema',
  ])
  assert.equal(options.transportProbe, true)
  assert.equal(options.maxPhysicalCalls, 1)
  assert.equal(options.maxCostUsd, 0.1)
  assert.throws(() =>
    parseV02RunnerArgs([
      '--allow-paid',
      '--max-physical-calls',
      '2',
      '--max-cost-usd',
      '0.10',
      '--transport-probe',
      '--transport-variant',
      'none-json-schema',
    ]),
  )

  let calls = 0
  const provider = createTextProviderForVariant(
    'fixture-key',
    1024,
    async (url, init) => {
      calls++
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.model, 'deepseek/deepseek-v4.1-flash')
      assert.equal(body.max_tokens, 1024)
      assert.deepEqual(body.reasoning, { effort: 'none' })
      assert.deepEqual(body.provider, {
        only: ['together'],
        allow_fallbacks: false,
        require_parameters: true,
      })
      const format = body.response_format as Record<string, unknown>
      assert.equal(format.type, 'json_schema')
      assert.equal(body.stream, false)
      return new Response(
        JSON.stringify({
          id: 'fixture-id',
          model: 'deepseek/deepseek-v4.1-flash',
          provider: 'Together',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                content: '{"answers":{"selection":{"ranking":["present","absent"]}}}',
              },
            },
          ],
          usage: { cost: 0.0001 },
        }),
      )
    },
    'none-json-schema',
  )
  const result = await provider.decide(
    {
      state: ['encoded fixture'],
      questions: {
        selection: {
          type: 'choice',
          instructions: 'Rank the options.',
          criteria: { present: 'Present.', absent: 'Absent.' },
        },
      },
    },
    AbortSignal.timeout(1000),
  )
  assert.equal(calls, 1)
  assert.equal(result.answers.selection?.type, 'ranked-choice')
})

await test('budget admits no more than its explicit physical calls and unknown receipts reserve cost', () => {
  const budget = new RunBudget(2, 0.04, 0.03)
  const first = budget.admit()
  budget.settle(first, null)
  assert.equal(budget.snapshot().unknownCostCalls, 1)
  assert.throws(() => budget.admit(), RunBudgetExhausted)
  assert.equal(budget.snapshot().admittedPhysicalCalls, 1)
})

await test('producer schema is label-free and denies traversal paths', () => {
  const good = {
    schemaVersion: 1,
    manifestId: 'old-exposed-dev4-diagnostic-v1',
    cases: Array.from({ length: 4 }, (_, index) => ({
      caseId: `photo-dev-0${index + 1}`,
      image: { path: `photos/${index}.jpg`, sha256: 'a'.repeat(64), width: 1, height: 1 },
      target: 'object',
    })),
  }
  assert.equal(inputManifestSchema.parse(good).cases.length, 4)
  assert.throws(() =>
    inputManifestSchema.parse({
      ...good,
      cases: good.cases.map((item, index) =>
        index ? item : { ...item, image: { ...item.image, path: '../secrets.jpg' } },
      ),
    }),
  )
  assert.deepEqual(modelRequestManifest.forbiddenFields.includes('ground_truth'), true)
})

await test('prompt variant has two synthetic examples and leaves the final task after all data', () => {
  const request = {
    state: ['codec grammar', 'encoded pixels', 'CLASSIFICATION_TASK choose one answer'],
  }
  const result = applyPromptVariant(request, promptVariants['grammar-plus-examples'])
  assert.equal(result.state.at(-1), 'CLASSIFICATION_TASK choose one answer')
  assert.match(result.state[1] ?? '', /SYNTHETIC DECODING EXAMPLES/u)
  assert.match(result.state[1] ?? '', /Example A/u)
  assert.match(result.state[1] ?? '', /Example B/u)
  assert.doesNotMatch(result.state.join('\n'), /photo-dev-\d|ground.truth|expected answer/iu)
})

await test('diagnostic evaluator counts a no-image unknown localization as an unknown attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-evaluator-'))
  try {
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify({
        runId: 'fixture-run',
        results: [
          {
            caseId: 'photo-dev-01',
            imageSha256: 'fixture-hash',
            encoder: 'no-image-control',
            route: 'no-image-control',
            classify: { status: 'ok', value: 'unknown' },
            locate: { status: 'ok', value: 'unknown' },
          },
        ],
      }),
    )
    const result = await evaluateDiagnostic(directory)
    const candidate = result.candidates[0]
    assert.equal(candidate?.classificationCorrect, 0)
    assert.equal(candidate?.localization.unknown, 1)
    assert.equal(candidate?.localization.failed, 0)
    assert.equal(candidate?.localization.correct, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('recorder writes sanitized append-only dispatch and receipt records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-runner-'))
  try {
    const budget = new RunBudget(1, 0.1)
    const response: DecisionResult = {
      answers: { pick: { type: 'ranked-choice', ranking: ['a'] } },
      metadata: {
        model: 'pinned/model',
        provider: 'Pinned',
        requestId: 'request-id',
        durationMs: 3,
        costUsd: null,
        attempts: 1,
      },
    }
    const recorder = recordProvider(
      (fetch) => ({
        async decide() {
          await fetch('https://provider.test/chat', { method: 'POST', body: 'private payload' })
          return response
        },
      }),
      budget,
      directory,
      {
        model: 'pinned/model',
        provider: 'provider',
        providerName: 'Pinned',
        apiEndpoint: '/chat',
        allowFallbacks: false,
      },
      async () => new Response('ok', { status: 200 }),
    )
    const request: DecisionRequest = {
      state: ['private text content'],
      questions: {
        pick: {
          type: 'choice',
          rankingSize: 1,
          instructions: 'Choose',
          criteria: { a: 'first', b: 'second' },
        },
      },
    }
    await recorder.port.decide(request, new AbortController().signal)
    const dispatch = await readFile(join(directory, 'logical-1.json'), 'utf8')
    const admission = await readFile(join(directory, 'physical-admission-1.json'), 'utf8')
    const http = await readFile(join(directory, 'physical-http-1.json'), 'utf8')
    const receipt = await readFile(join(directory, 'physical-receipt-1.json'), 'utf8')
    assert.match(admission, /"dispatched": true/u)
    assert.match(http, /"httpStatus": 200/u)
    assert.doesNotMatch(
      dispatch + admission + http + receipt,
      /private text content|private payload/u,
    )
    assert.match(receipt, /"costUsd": null/u)
    assert.equal(budget.snapshot().unknownCostCalls, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('physical ledger counts fetches, retains HTTP errors, and excludes preflight failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-http-ledger-'))
  try {
    const budget = new RunBudget(2, 0.1)
    const request: DecisionRequest = {
      state: ['closed task'],
      questions: {
        pick: {
          type: 'choice',
          rankingSize: 1,
          instructions: 'Choose one',
          criteria: { yes: 'yes', no: 'no' },
        },
      },
    }
    const route = {
      model: 'pinned/model',
      provider: 'provider',
      providerName: 'Pinned',
      apiEndpoint: '/chat',
      allowFallbacks: false as const,
    }
    const preflight = recordProvider(
      () => ({
        async decide() {
          throw new Error('local validation')
        },
      }),
      budget,
      join(directory, 'preflight'),
      route,
    )
    await assert.rejects(preflight.port.decide(request, new AbortController().signal))
    assert.equal(preflight.logicalCalls.length, 1)
    assert.equal(preflight.calls.length, 0)
    assert.equal(budget.snapshot().admittedPhysicalCalls, 0)

    const httpFailure = recordProvider(
      (fetch) => ({
        async decide() {
          const response = await fetch('https://provider.test/chat', { method: 'POST', body: '{}' })
          if (!response.ok) throw new Error('provider response rejected')
          throw new Error('expected non-success status')
        },
      }),
      budget,
      join(directory, 'http-failure'),
      route,
      async () => new Response('bounded provider error', { status: 403 }),
    )
    await assert.rejects(httpFailure.port.decide(request, new AbortController().signal))
    const http = await readFile(join(directory, 'http-failure', 'physical-http-1.json'), 'utf8')
    const receipt = await readFile(
      join(directory, 'http-failure', 'physical-receipt-1.json'),
      'utf8',
    )
    assert.match(http, /"httpStatus": 403/u)
    assert.match(receipt, /"receipt": null/u)
    assert.doesNotMatch(http + receipt, /bounded provider error/u)
    assert.equal(budget.snapshot().admittedPhysicalCalls, 1)
    assert.equal(budget.snapshot().unknownCostCalls, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('wire diagnostics classify retry scope and truncated output without retaining message text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-wire-diagnostics-'))
  const request: DecisionRequest = {
    state: ['fixture'],
    questions: { pick: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } } },
  }
  const route = {
    model: 'pinned/model',
    provider: 'provider',
    providerName: 'Pinned',
    apiEndpoint: 'https://provider.test/chat',
    allowFallbacks: false as const,
  }
  try {
    const rateLimit = recordProvider(
      (fetch) => ({
        async decide() {
          await fetch(route.apiEndpoint, { method: 'POST', body: '{}' })
          throw new Error('expected rate limit')
        },
      }),
      new RunBudget(1, 0.1),
      join(directory, 'rate-limit'),
      route,
      async () =>
        new Response(JSON.stringify({ error: { message: 'Rate limit exceeded for API key' } }), {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
    )
    await assert.rejects(rateLimit.port.decide(request, new AbortController().signal))
    const rateReceipt = await readFile(
      join(directory, 'rate-limit', 'physical-receipt-1.json'),
      'utf8',
    )
    assert.match(rateReceipt, /"errorCategory": "rate-limited"/u)
    assert.match(rateReceipt, /"rateLimitScope": "key"/u)
    assert.match(rateReceipt, /"retryAfterSeconds": 2/u)
    assert.doesNotMatch(rateReceipt, /Rate limit exceeded for API key/u)

    const malformed = recordProvider(
      (fetch) => ({
        async decide() {
          await fetch(route.apiEndpoint, { method: 'POST', body: '{}' })
          throw new Error('invalid provider response')
        },
      }),
      new RunBudget(1, 0.1),
      join(directory, 'malformed'),
      route,
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                message: { content: 'private model output that is not JSON' },
              },
            ],
          }),
          { status: 200 },
        ),
    )
    await assert.rejects(malformed.port.decide(request, new AbortController().signal))
    const malformedReceipt = await readFile(
      join(directory, 'malformed', 'physical-receipt-1.json'),
      'utf8',
    )
    assert.match(malformedReceipt, /"responseDisposition": "chat-truncated-output"/u)
    assert.match(malformedReceipt, /"finishReason": "length"/u)
    assert.doesNotMatch(malformedReceipt, /private model output/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('wire diagnostics drop unrecognized error fields instead of serializing arbitrary provider text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-wire-allowlist-'))
  const request: DecisionRequest = {
    state: ['fixture'],
    questions: { pick: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } } },
  }
  const route = {
    model: 'pinned/model',
    provider: 'provider',
    providerName: 'Pinned',
    apiEndpoint: '/chat',
    allowFallbacks: false as const,
  }
  const secretLike = 'OPENROUTER_API_KEY=private-wire-value'
  try {
    const recorder = recordProvider(
      (fetch) => ({
        async decide() {
          await fetch(route.apiEndpoint, { method: 'POST', body: '{}' })
          throw new Error('expected provider response failure')
        },
      }),
      new RunBudget(1, 0.1),
      directory,
      route,
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: secretLike,
              code: secretLike,
              param: secretLike,
              message: 'Unsupported parameter',
            },
          }),
          { status: 400 },
        ),
    )
    await assert.rejects(recorder.port.decide(request, new AbortController().signal))
    const receipt = await readFile(join(directory, 'physical-receipt-1.json'), 'utf8')
    assert.match(receipt, /"errorCategory": "unsupported-parameter"/u)
    assert.match(receipt, /"errorType": null/u)
    assert.match(receipt, /"errorCode": null/u)
    assert.match(receipt, /"errorParameter": null/u)
    assert.doesNotMatch(receipt, /OPENROUTER_API_KEY|private-wire-value/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('wire capture reads once and preserves physical receipts for oversized, stalled, and cancelled streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-wire-streams-'))
  const request: DecisionRequest = {
    state: ['fixture'],
    questions: { pick: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } } },
  }
  const route = {
    model: 'pinned/model',
    provider: 'provider',
    providerName: 'Pinned',
    apiEndpoint: '/chat',
    allowFallbacks: false as const,
  }
  const makeProvider = (signal: AbortSignal) => (fetch: typeof globalThis.fetch) => ({
    async decide() {
      const response = await fetch(route.apiEndpoint, { method: 'POST', body: '{}', signal })
      await response.arrayBuffer()
      throw new Error('expected fixture response failure')
    },
  })
  try {
    let oversizeCancelled = false
    const oversizeBudget = new RunBudget(1, 0.1)
    const oversize = recordProvider(
      makeProvider(new AbortController().signal),
      oversizeBudget,
      join(directory, 'oversize'),
      route,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1).fill(65))
            },
            cancel() {
              oversizeCancelled = true
            },
          }),
          { status: 200 },
        ),
      100,
    )
    await assert.rejects(oversize.port.decide(request, new AbortController().signal))
    const oversizeHttp = JSON.parse(
      await readFile(join(directory, 'oversize', 'physical-http-1.json'), 'utf8'),
    ) as { httpStatus: number }
    const oversizeReceipt = JSON.parse(
      await readFile(join(directory, 'oversize', 'physical-receipt-1.json'), 'utf8'),
    ) as { wireReceipt: { bodyRead: string; usageCostUsd: number | null }; receipt: unknown }
    assert.equal(oversizeHttp.httpStatus, 200)
    assert.equal(oversizeReceipt.wireReceipt.bodyRead, 'oversize')
    assert.equal(oversizeReceipt.wireReceipt.usageCostUsd, null)
    assert.equal(oversizeReceipt.receipt, null)
    assert.equal(oversizeCancelled, true)
    assert.equal(oversize.calls.length, 1)
    assert.equal(oversize.calls[0]?.dispatched, true)
    assert.equal(oversize.calls[0]?.wireReceipt?.usageCostUsd, null)
    assert.equal(oversizeBudget.snapshot().unknownCostCalls, 1)

    let stalledCancelled = false
    const stalledBudget = new RunBudget(1, 0.1)
    const stalled = recordProvider(
      makeProvider(new AbortController().signal),
      stalledBudget,
      join(directory, 'stalled'),
      route,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined)
            },
            cancel() {
              stalledCancelled = true
            },
          }),
          { status: 200 },
        ),
      10,
    )
    await assert.rejects(stalled.port.decide(request, new AbortController().signal))
    const stalledHttp = JSON.parse(
      await readFile(join(directory, 'stalled', 'physical-http-1.json'), 'utf8'),
    ) as { httpStatus: number }
    const stalledReceipt = JSON.parse(
      await readFile(join(directory, 'stalled', 'physical-receipt-1.json'), 'utf8'),
    ) as { wireReceipt: { bodyRead: string; usageCostUsd: number | null }; receipt: unknown }
    assert.equal(stalledHttp.httpStatus, 200)
    assert.equal(stalledReceipt.wireReceipt.bodyRead, 'stalled')
    assert.equal(stalledReceipt.wireReceipt.usageCostUsd, null)
    assert.equal(stalledReceipt.receipt, null)
    assert.equal(stalledCancelled, true)
    assert.equal(stalledBudget.snapshot().unknownCostCalls, 1)

    let slowStreamCancelled = false
    const slowBudget = new RunBudget(1, 0.1)
    const slowStream = recordProvider(
      makeProvider(new AbortController().signal),
      slowBudget,
      join(directory, 'slow-stream'),
      route,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise<void>((resolve) => setTimeout(resolve, 12))
              controller.enqueue(new Uint8Array([65]))
            },
            cancel() {
              slowStreamCancelled = true
            },
          }),
          { status: 200 },
        ),
      35,
    )
    await assert.rejects(slowStream.port.decide(request, new AbortController().signal))
    const slowReceipt = JSON.parse(
      await readFile(join(directory, 'slow-stream', 'physical-receipt-1.json'), 'utf8'),
    ) as { wireReceipt: { bodyRead: string; usageCostUsd: number | null }; receipt: unknown }
    assert.equal(slowReceipt.wireReceipt.bodyRead, 'stalled')
    assert.equal(slowReceipt.wireReceipt.usageCostUsd, null)
    assert.equal(slowReceipt.receipt, null)
    assert.equal(slowStreamCancelled, true)
    assert.equal(slowBudget.snapshot().unknownCostCalls, 1)

    const controller = new AbortController()
    let abortStreamCancelled = false
    const abortBudget = new RunBudget(1, 0.1)
    const cancelled = recordProvider(
      makeProvider(controller.signal),
      abortBudget,
      join(directory, 'cancelled'),
      route,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined)
            },
            cancel() {
              abortStreamCancelled = true
            },
          }),
          { status: 200 },
        ),
      1_000,
    )
    const pendingDecision = cancelled.port.decide(request, controller.signal)
    setTimeout(() => controller.abort(new Error('fixture abort')), 10)
    await assert.rejects(pendingDecision)
    const cancelledHttp = JSON.parse(
      await readFile(join(directory, 'cancelled', 'physical-http-1.json'), 'utf8'),
    ) as { httpStatus: number }
    const cancelledReceipt = JSON.parse(
      await readFile(join(directory, 'cancelled', 'physical-receipt-1.json'), 'utf8'),
    ) as { wireReceipt: { bodyRead: string; usageCostUsd: number | null }; receipt: unknown }
    assert.equal(cancelledHttp.httpStatus, 200)
    assert.equal(cancelledReceipt.wireReceipt.bodyRead, 'cancelled')
    assert.equal(cancelledReceipt.wireReceipt.usageCostUsd, null)
    assert.equal(cancelledReceipt.receipt, null)
    assert.equal(abortStreamCancelled, true)
    assert.equal(abortBudget.snapshot().unknownCostCalls, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
