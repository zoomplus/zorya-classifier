import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DecisionRequest, DecisionResult } from '../src/index.js'
import { ClassifierError } from '../src/index.js'
import { BenchmarkBudget } from '../benchmarks/budget.js'
import {
  recordProvider,
  offlineProvider,
  ArtifactWriteError,
  failure,
} from '../benchmarks/recording.js'
import type { CallRecord } from '../benchmarks/recording.js'
import { nativeSelection, prefixResult } from '../benchmarks/ablations.js'
import { parseBenchmarkArgs } from '../benchmarks/run.js'

const request: DecisionRequest = {
  state: ['plain evaluator-independent input'],
  questions: {
    selection: { type: 'choice', instructions: 'choose', criteria: { A: 'first', B: 'second' } },
    presence: { type: 'noul', instructions: 'visible in selected union' },
  },
}
function answer(choice = 'B', noul = 1): DecisionResult {
  return {
    answers: {
      selection: { type: 'choice', choice, probabilities: { A: 0.2, B: 0.8 } },
      presence: { type: 'noul', noul },
    },
    metadata: {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 1,
      costUsd: 0,
      attempts: 1,
    },
  }
}
function call(index: number, req: DecisionRequest, result: DecisionResult): CallRecord {
  return {
    ordinal: index,
    request: req,
    requestSha256: 'fixture',
    startedMs: 0,
    finishedMs: 1,
    result,
    dispatched: true,
  }
}
function geometry(): DecisionRequest {
  return {
    ...request,
    state: [
      ...request.state,
      JSON.stringify({
        panel: 'p0',
        sourceRegion: { left: 0, top: 0, width: 100, height: 100 },
        labels: [
          { id: 'A', sourceRegion: { left: 0, top: 0, width: 50, height: 50 } },
          { id: 'B', sourceRegion: { left: 50, top: 20, width: 30, height: 40 } },
        ],
      }),
    ],
  }
}
await test('prefix ablation resolves recorded labels to canonical source pixels, never generated coordinates', () => {
  assert.deepEqual(prefixResult([call(1, geometry(), answer())], 1), {
    status: 'located',
    region: { left: 50, top: 20, width: 30, height: 40 },
  })
  assert.equal(prefixResult([call(1, request, answer())], 1).status, 'failed')
  assert.equal(prefixResult([call(1, geometry(), answer())], 2).status, 'failed')
})
await test('prefix presence is independent of spatial Choice, and absence at fine union is not global absence', () => {
  assert.equal(prefixResult([call(1, geometry(), answer('B', 0))], 2).status, 'not-found')
  assert.equal(
    prefixResult([call(1, geometry(), answer()), call(2, geometry(), answer('B', 0))], 2).status,
    'unknown',
  )
  assert.equal(prefixResult([call(1, geometry(), answer('B', 0.5))], 1).status, 'unknown')
  const duplicate = geometry()
  duplicate.state.push(
    JSON.stringify({
      panel: 'other',
      sourceRegion: { left: 0, top: 0, width: 100, height: 100 },
      labels: [{ id: 'B', sourceRegion: { left: 0, top: 0, width: 10, height: 10 } }],
    }),
  )
  assert.equal(prefixResult([call(1, duplicate, answer())], 1).status, 'failed')
})
await test('baseline maxima use stable supplied order for equal probabilities and validate native winner', () => {
  const result = answer()
  result.answers.selection = { type: 'choice', choice: 'B', probabilities: { A: 0.5, B: 0.5 } }
  assert.equal(nativeSelection(request, result).choice, 'A')
  assert.throws(() => nativeSelection(request, answer('A')))
})
await test('live CLI requires three explicit budget/admission flags; offline requires explicit artifact directory', () => {
  assert.throws(() => parseBenchmarkArgs(['--mode', 'live', '--out', '/tmp/test']))
  assert.throws(() =>
    parseBenchmarkArgs([
      '--mode',
      'live',
      '--allow-paid',
      '--max-calls',
      '360',
      '--out',
      '/tmp/test',
    ]),
  )
  assert.throws(() => parseBenchmarkArgs(['--mode', 'offline']))
  assert.throws(() =>
    parseBenchmarkArgs([
      '--mode',
      'live',
      '--allow-paid',
      '--max-calls',
      '361',
      '--max-cost-usd',
      '1',
      '--out',
      '/tmp/test',
    ]),
  )
  assert.deepEqual(
    parseBenchmarkArgs([
      '--mode',
      'offline',
      '--out',
      '/tmp/test',
      '--split',
      'dev',
      '--limit',
      '2',
    ]).splits,
    ['dev'],
  )
})
await test('recording retains failed attempt and unknown-cost reservation without retry or credential logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classifier-record-'))
  const budget = new BenchmarkBudget(2, 0.04)
  let calls = 0
  try {
    const recorder = recordProvider(
      {
        async decide() {
          calls++
          throw new ClassifierError('PROVIDER', 'OpenRouter transport failed')
        },
      },
      budget,
      directory,
      performance.now(),
    )
    await assert.rejects(recorder.port.decide(request, new AbortController().signal))
    assert.equal(calls, 1)
    assert.equal(budget.snapshot().unknownCostCalls, 1)
    assert.match(
      await readFile(join(directory, 'call-1', 'receipt.json'), 'utf8'),
      /"code": "PROVIDER"/u,
    )
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, 'call-1', 'request.json'), 'utf8')),
      request,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
await test('budget rejection is recorded and never dispatches another provider attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classifier-budget-'))
  const budget = new BenchmarkBudget(1, 0.02)
  budget.settle(budget.reserve(), null)
  let calls = 0
  try {
    const recorder = recordProvider(
      {
        async decide() {
          calls++
          return answer()
        },
      },
      budget,
      directory,
      performance.now(),
    )
    await assert.rejects(recorder.port.decide(request, new AbortController().signal))
    assert.equal(calls, 0)
    assert.equal(recorder.calls[0]?.dispatched, false)
    assert.equal(recorder.calls[0]?.error?.code, 'BENCHMARK_BUDGET_EXHAUSTED')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
await test('late provider result is joined and recorded but cannot become a successful outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classifier-late-')),
    controller = new AbortController()
  let release: ((result: DecisionResult) => void) | undefined
  const pending = new Promise<DecisionResult>((resolve) => {
    release = resolve
  })
  let signalEntered: (() => void) | undefined
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  try {
    const recorder = recordProvider(
      {
        decide() {
          signalEntered?.()
          return pending
        },
      },
      new BenchmarkBudget(1, 1),
      directory,
      performance.now(),
    )
    const task = recorder.port.decide(request, controller.signal)
    await entered
    controller.abort()
    release?.(answer())
    await assert.rejects(task)
    assert.equal(recorder.calls[0]?.error?.code, 'ABORTED')
    assert.ok(recorder.calls[0]?.result)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
await test('fixture response is content-blind and identical captured request baseline retains byte hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classifier-parity-'))
  try {
    await mkdir(join(directory, 'a'))
    await mkdir(join(directory, 'b'))
    const budget = new BenchmarkBudget(2, 1),
      provider = offlineProvider()
    const first = recordProvider(provider, budget, join(directory, 'a'), performance.now()),
      second = recordProvider(provider, budget, join(directory, 'b'), performance.now())
    const result = await first.port.decide(request, new AbortController().signal)
    const captured = first.calls[0]?.request
    assert.ok(captured)
    assert.deepEqual(await second.port.decide(captured, new AbortController().signal), result)
    assert.equal(first.calls[0]?.requestSha256, second.calls[0]?.requestSha256)
    assert.equal(
      result.answers.selection?.type === 'choice' ? result.answers.selection.choice : null,
      'A',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('receipt persistence failure is fatal and retains the primary provider failure and budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classifier-evidence-'))
  const budget = new BenchmarkBudget(2, 0.04)
  try {
    const recorder = recordProvider(
      {
        async decide() {
          await writeFile(join(directory, 'call-1', 'receipt.json'), 'pre-existing evidence', {
            flag: 'wx',
          })
          throw new ClassifierError('PROVIDER', 'OpenRouter transport failed')
        },
      },
      budget,
      directory,
      performance.now(),
    )
    await assert.rejects(recorder.port.decide(request, new AbortController().signal), (error) => {
      assert.ok(error instanceof ArtifactWriteError)
      assert.equal(failure(error).code, 'BENCHMARK_ARTIFACT_FAILURE')
      assert.equal(failure(error).primaryFailure?.code, 'PROVIDER')
      return true
    })
    assert.equal(budget.snapshot().unknownCostCalls, 1)
    assert.equal(budget.snapshot().inFlightCalls, 0)
    assert.equal(
      await readFile(join(directory, 'call-1', 'receipt.json'), 'utf8'),
      'pre-existing evidence',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('late timeout plus receipt failure retains an independent terminal evidence marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classifier-timeout-evidence-')),
    controller = new AbortController()
  const budget = new BenchmarkBudget(2, 0.04)
  try {
    const recorder = recordProvider(
      {
        async decide() {
          await writeFile(join(directory, 'call-1', 'receipt.json'), 'keep', { flag: 'wx' })
          controller.abort(new ClassifierError('TIMEOUT', 'Operation deadline exceeded'))
          return answer()
        },
      },
      budget,
      directory,
      performance.now(),
    )
    await assert.rejects(recorder.port.decide(request, controller.signal), ArtifactWriteError)
    assert.equal(recorder.calls[0]?.artifactFailure?.code, 'BENCHMARK_ARTIFACT_FAILURE')
    assert.equal(recorder.calls[0]?.artifactFailure?.primaryFailure?.code, 'TIMEOUT')
    assert.equal(recorder.calls[0]?.error?.code, 'TIMEOUT')
    assert.equal(budget.snapshot().inFlightCalls, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('annotated rounded native distribution keeps raw values and stable ties; unannotated mass is rejected', () => {
  const input: DecisionRequest = {
    state: ['fixture'],
    questions: {
      selection: {
        type: 'choice',
        instructions: 'choose',
        criteria: { A: 'first', B: 'second', C: 'third' },
      },
    },
  }
  const result = answer()
  result.answers.selection = {
    type: 'choice',
    choice: 'C',
    probabilities: { A: 0.33, B: 0.33, C: 0.33 },
    probabilityRoundingStep: 0.01,
  }
  const before = structuredClone(result)
  assert.deepEqual(nativeSelection(input, result), {
    choice: 'A',
    probabilities: { A: 0.33, B: 0.33, C: 0.33 },
  })
  assert.deepEqual(result, before)
  result.answers.selection = {
    type: 'choice',
    choice: 'C',
    probabilities: { A: 0.33, B: 0.33, C: 0.33 },
  }
  assert.throws(() => nativeSelection(input, result), /Invalid categorical distribution/u)
  result.answers.selection = {
    type: 'choice',
    choice: 'C',
    probabilities: { A: 0.1, B: 0.1, C: 0.1 },
    probabilityRoundingStep: 0.01,
  }
  assert.throws(() => nativeSelection(input, result), /Invalid categorical distribution/u)
})
await test('prefix ablation accepts only explicitly annotated rounded scores without altering canonical geometry', () => {
  const result = answer()
  result.answers.selection = {
    type: 'choice',
    choice: 'B',
    probabilities: { A: 0.4, B: 0.59 },
    probabilityRoundingStep: 0.01,
  }
  assert.deepEqual(prefixResult([call(1, geometry(), result)], 1), {
    status: 'located',
    region: { left: 50, top: 20, width: 30, height: 40 },
  })
  result.answers.selection = { type: 'choice', choice: 'B', probabilities: { A: 0.4, B: 0.59 } }
  assert.equal(prefixResult([call(1, geometry(), result)], 1).status, 'failed')
})
