import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { ClassifierError } from '../src/entities/errors.js'
import { createOpenRouterDecisions } from '../src/infrastructure/openrouter.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import {
  categoricalPresenceRequest,
  createCategoricalPresencePort,
} from '../benchmarks/v02/categorical-presence-port.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'
import { recordProvider } from '../benchmarks/v02/recording.js'

const choiceOnly: DecisionRequest = {
  state: [
    'spatial task',
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
  ],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Select one supplied spatial interval.',
      criteria: { left00: 'Integer coordinates in [0, 8).', unknown: 'Cannot determine.' },
    },
  },
}

const mixed: DecisionRequest = {
  state: [
    'Exact proposition context.',
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
  ],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Select one supplied spatial interval.',
      criteria: { left00: 'Integer coordinates in [0, 8).', unknown: 'Cannot determine.' },
    },
    presence: {
      type: 'noul',
      instructions: 'Does the same physical object cross this exact interval?',
    },
  },
}

const presenceOnly: DecisionRequest = {
  state: structuredClone(mixed.state),
  questions: { presence: structuredClone(mixed.questions.presence!) },
}

function result(
  answers: DecisionResult['answers'],
  values: Partial<DecisionResult['metadata']> = {},
): DecisionResult {
  return {
    answers,
    metadata: {
      model: 'fixture-model',
      provider: 'fixture-provider',
      requestId: 'fixture-request',
      durationMs: 5,
      costUsd: 0.01,
      attempts: 1,
      ...values,
    },
  }
}

function port(decide: DecisionPort['decide']): DecisionPort {
  return { decide }
}

function spatialAnswer(): DecisionResult {
  return result({ selection: { type: 'ranked-choice', ranking: ['left00'] } })
}

function categoricalAnswer(
  choice: 'present' | 'absent' | 'unknown',
  probabilities: Record<string, number> = { present: 0.1, absent: 0.2, unknown: 0.7 },
  values: Partial<DecisionResult['metadata']> = {},
): DecisionResult {
  return result({ presence: { type: 'choice', choice, probabilities } }, values)
}

await test('noul conversion preserves question identity, predicate text, state and images', () => {
  const partitioned = categoricalPresenceRequest(mixed)
  assert.deepEqual(partitioned.choice.questions, { selection: mixed.questions.selection })
  assert.deepEqual(partitioned.choice.state, mixed.state)
  assert.deepEqual(partitioned.categorical.state, mixed.state)
  const question = partitioned.categorical.questions.presence
  assert.ok(question?.type === 'choice')
  assert.equal(question.rankingSize, 1)
  assert.deepEqual(Object.keys(question.criteria), ['present', 'absent', 'unknown'])
  assert.ok(question.instructions.endsWith(mixed.questions.presence!.instructions))
  assert.equal(
    partitioned.categorical.questions.presence &&
      'type' in partitioned.categorical.questions.presence
      ? partitioned.categorical.questions.presence.type
      : '',
    'choice',
  )
})

await test('mixed request uses native categorical Choice, applies stable validated winner, and merges metadata honestly', async () => {
  const called: string[] = []
  let release!: () => void
  const both = new Promise<void>((resolve) => {
    release = resolve
  })
  const decision = createCategoricalPresencePort(
    port(async (request) => {
      called.push('spatial')
      assert.deepEqual(Object.keys(request.questions), ['selection'])
      await both
      return spatialAnswer()
    }),
    port(async (request) => {
      called.push('categorical')
      const q = request.questions.presence
      assert.ok(q?.type === 'choice')
      assert.equal(q.rankingSize, 1)
      assert.deepEqual(Object.keys(q.criteria), ['present', 'absent', 'unknown'])
      await both
      return categoricalAnswer(
        'absent',
        { present: 0.5, absent: 0.5, unknown: 0 },
        {
          durationMs: 9000,
          costUsd: 0.02,
        },
      )
    }),
  )
  const pending = decision.decide(mixed, new AbortController().signal)
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const actual = await pending
  assert.deepEqual(called.sort(), ['categorical', 'spatial'])
  assert.deepEqual(actual.answers.selection, { type: 'ranked-choice', ranking: ['left00'] })
  assert.deepEqual(actual.answers.presence, { type: 'presence', presence: 'present' })
  assert.equal(actual.metadata.model, null)
  assert.equal(actual.metadata.provider, null)
  assert.equal(actual.metadata.requestId, null)
  assert.equal(actual.metadata.costUsd, 0.03)
  assert.equal(actual.metadata.attempts, 2)
  assert.ok(actual.metadata.durationMs >= 0 && actual.metadata.durationMs < 9005)
})

await test('single categorical request maps each native option to a categorical answer without inventing scores', async () => {
  let calls = 0
  const expected = categoricalAnswer('unknown')
  const decision = createCategoricalPresencePort(
    port(async () => {
      throw new Error('unexpected spatial route')
    }),
    port(async (request) => {
      calls++
      assert.ok(request.questions.presence?.type === 'choice')
      return expected
    }),
  )
  const actual = await decision.decide(presenceOnly, new AbortController().signal)
  assert.equal(calls, 1)
  assert.deepEqual(actual.answers.presence, { type: 'presence', presence: 'unknown' })
  assert.deepEqual(actual.metadata, expected.metadata)
})

await test('single spatial Choice passes through to its original route and preserves metadata', async () => {
  const expected = spatialAnswer()
  let spatialCalls = 0
  const decision = createCategoricalPresencePort(
    port(async (request) => {
      spatialCalls++
      assert.deepEqual(request, choiceOnly)
      return expected
    }),
    port(async () => {
      throw new Error('unexpected categorical route')
    }),
  )
  const actual = await decision.decide(choiceOnly, new AbortController().signal)
  assert.equal(spatialCalls, 1)
  assert.deepEqual(actual, expected)
})

await test('unknown child cost remains unknown in composite metadata', async () => {
  const decision = createCategoricalPresencePort(
    port(async () => spatialAnswer()),
    port(async () =>
      categoricalAnswer('absent', { present: 0.1, absent: 0.8, unknown: 0.1 }, { costUsd: null }),
    ),
  )
  const actual = await decision.decide(mixed, new AbortController().signal)
  assert.equal(actual.metadata.costUsd, null)
})

await test('invalid categorical label fails closed', async () => {
  const decision = createCategoricalPresencePort(
    port(async () => spatialAnswer()),
    port(async () =>
      result({
        presence: {
          type: 'choice',
          choice: 'other',
          probabilities: { present: 0, absent: 0, unknown: 1 },
        },
      }),
    ),
  )
  await assert.rejects(
    decision.decide(presenceOnly, new AbortController().signal),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
})

await test('mixed-leg failure cancels and joins its peer before rejection', async () => {
  const expected = new Error('spatial call failed')
  let peerSettled = false
  const categorical = port(async (_request, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => setTimeout(resolve, 5), { once: true })
    })
    peerSettled = true
    throw new ClassifierError('ABORTED', 'categorical peer cancelled')
  })
  const decision = createCategoricalPresencePort(
    port(async () => {
      throw expected
    }),
    categorical,
  )
  await assert.rejects(
    decision.decide(mixed, new AbortController().signal),
    (error: unknown) => error === expected,
  )
  assert.equal(peerSettled, true)
})

await test('parent abort settles both legs and removes its abort listener', async () => {
  const parent = new AbortController()
  let listenerAdds = 0
  let listenerRemoves = 0
  const observedSignal = new Proxy(parent.signal, {
    get(target, property) {
      if (property === 'addEventListener')
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (type === 'abort') listenerAdds++
          target.addEventListener(type, listener, options)
        }
      if (property === 'removeEventListener')
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions,
        ) => {
          if (type === 'abort') listenerRemoves++
          target.removeEventListener(type, listener, options)
        }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  const started = new Set<string>()
  let resolveBothStarted!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    resolveBothStarted = resolve
  })
  let settled = 0
  const waitingPort = (name: string): DecisionPort =>
    port(async (_request, signal) => {
      started.add(name)
      if (started.size === 2) resolveBothStarted()
      await new Promise<void>((resolve) => {
        const finish = () => setTimeout(resolve, 2)
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      })
      settled++
      throw new ClassifierError('ABORTED', `${name} fixture canceled`)
    })
  const decision = createCategoricalPresencePort(waitingPort('spatial'), waitingPort('presence'))
  const pending = decision.decide(mixed, observedSignal)
  await bothStarted
  parent.abort('fixture parent cancellation')
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  assert.equal(settled, 2)
  assert.equal(listenerAdds, 1)
  assert.equal(listenerRemoves, 1)
})

await test('route recorder journals the transformed native Choice request and wire body hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'categorical-presence-record-'))
  const budget = new RunBudget(1, 1, 0.05)
  const route = {
    model: 'openai/gpt-6-luna-decisions',
    provider: 'openai',
    providerName: 'OpenAI',
    apiEndpoint: '/api/alpha/decisions',
    allowFallbacks: false as const,
  }
  let wireBody = ''
  try {
    const recorder = recordProvider(
      (fetch) =>
        createOpenRouterDecisions({
          apiKey: 'test-only-never-recorded',
          model: route.model,
          provider: route.provider,
          providerName: route.providerName,
          fetch,
        }),
      budget,
      directory,
      route,
      async (_input, init) => {
        wireBody = String(init?.body)
        return new Response(
          JSON.stringify({
            id: 'fixture-response',
            model: route.model,
            provider: route.providerName,
            usage: { cost: 0.001 },
            answers: {
              presence: {
                type: 'choice',
                choice: 'unknown',
                probabilities: { present: 0.1, absent: 0.2, unknown: 0.7 },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    )
    const recorderRequest: DecisionRequest = {
      state: ['state only'],
      questions: presenceOnly.questions,
    }
    const decision = createCategoricalPresencePort(
      port(async () => spatialAnswer()),
      recorder.port,
    )
    const actual = await decision.decide(recorderRequest, new AbortController().signal)
    assert.deepEqual(actual.answers.presence, { type: 'presence', presence: 'unknown' })
    const sent = JSON.parse(wireBody) as {
      questions: Record<string, { type: string; criteria: Record<string, string> }>
    }
    assert.equal(sent.questions.presence?.type, 'choice')
    assert.deepEqual(Object.keys(sent.questions.presence!.criteria), [
      'present',
      'absent',
      'unknown',
    ])
    assert.match(sent.questions.presence!.criteria.present!, /exact proposition/u)
    const logical = JSON.parse(await readFile(join(directory, 'logical-1.json'), 'utf8')) as {
      requestSha256: string
      request: { questions: Array<{ id: string; type: string; optionIds: string[] }> }
    }
    assert.equal(
      logical.requestSha256,
      hashCanonical({
        state: recorderRequest.state,
        questions: {
          presence: {
            type: 'choice',
            rankingSize: 1,
            instructions: sent.questions.presence
              ? (JSON.parse(wireBody).questions.presence.instructions as string)
              : '',
            criteria: sent.questions.presence!.criteria,
          },
        },
      }),
    )
    assert.deepEqual(logical.request.questions, [
      { id: 'presence', type: 'choice', optionIds: ['present', 'absent', 'unknown'] },
    ])
    const trace = JSON.parse(await readFile(join(directory, 'decision-trace-1.json'), 'utf8')) as {
      status: string
      questions?: Array<{
        questionId: string
        answerType: string
        selected: string
        probabilities: Array<{ optionId: string; value: number }>
      }>
    }
    assert.equal(trace.status, 'recorded')
    assert.deepEqual(trace.questions?.[0], {
      questionId: 'presence',
      answerType: 'choice',
      selected: 'unknown',
      probabilities: [
        { optionId: 'present', value: 0.1 },
        { optionId: 'absent', value: 0.2 },
        { optionId: 'unknown', value: 0.7 },
      ],
      intervalOptions: [],
      selectedSourceRegions: [],
    })
    assert.equal(
      recorder.calls[0]?.requestBodySha256,
      createHash('sha256').update(wireBody).digest('hex'),
    )
    assert.equal(budget.snapshot().admittedPhysicalCalls, 1)
    assert.equal(budget.snapshot().knownCostUsd, 0.001)
    assert.ok(!wireBody.includes('test-only-never-recorded'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
