import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { RunBudget, RunBudgetExhausted } from '../benchmarks/v02/budget.js'
import { inputManifestSchema, modelRequestManifest } from '../benchmarks/v02/protocol.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { applyPromptVariant, promptVariants } from '../benchmarks/v02/promptvariants.js'

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
