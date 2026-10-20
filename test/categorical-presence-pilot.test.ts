import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { createClassifier } from '../src/app/create-classifier.js'
import type { DecisionRequest } from '../src/entities/contracts.js'
import type { SegmentationPort } from '../src/entities/segmentation.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import {
  categoricalPilotPolicy,
  categoricalPilotRoutes,
  createRecordedCategoricalPresenceDecision,
  readCategoricalPilotOpenRouterKey,
} from '../benchmarks/v02/categorical-presence-pilot.js'

const requestImage = await sharp({
  create: { width: 280, height: 280, channels: 3, background: '#ffffff' },
})
  .png()
  .toBuffer()
const noulRequest: DecisionRequest = {
  state: [
    'Question context.',
    {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${requestImage.toString('base64')}`,
        detail: 'high',
      },
    },
  ],
  questions: {
    presence: { type: 'noul', instructions: 'Does the exact visible object cross this interval?' },
  },
}

await test('categorical DEV6 profile pins routes, budgets, timeout, zero retries and no fallback', () => {
  assert.equal(categoricalPilotRoutes.choice.model, 'openai/gpt-6-sol')
  assert.equal(categoricalPilotRoutes.choice.provider, 'openai')
  assert.equal(categoricalPilotRoutes.categorical.model, 'openai/gpt-6-luna-decisions')
  assert.equal(categoricalPilotRoutes.categorical.provider, 'openai')
  assert.equal(categoricalPilotRoutes.categorical.apiEndpoint, '/api/alpha/decisions')
  assert.equal(categoricalPilotRoutes.categorical.allowFallbacks, false)
  assert.equal(categoricalPilotPolicy.timeoutMs, 120_000)
  assert.equal(categoricalPilotPolicy.maxInFlightCases, 2)
  assert.equal(categoricalPilotPolicy.boxTolerancePx, 8)
  assert.equal(categoricalPilotPolicy.maxExtentPasses, 3)
  assert.equal(categoricalPilotPolicy.maxPhysicalCalls, 100)
  assert.equal(categoricalPilotPolicy.maxCostUsd, 5)
  assert.equal(categoricalPilotPolicy.unknownCostReserveUsd, 0.05)
  assert.equal(categoricalPilotPolicy.retries, 0)
  assert.equal(categoricalPilotPolicy.fallback, false)
})

await test('recording is inside categorical conversion and journals the native Choice request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-categorical-pilot-'))
  const budget = new RunBudget(100, 5, 0.05, 'dev')
  let sentBody = ''
  try {
    const recorded = createRecordedCategoricalPresenceDecision(
      {
        apiKey: 'offline-fixture-key',
        inputManifestPath: '',
        imageRoot: '',
        outputRoot: '',
        encoderPath: '',
        decoderPath: '',
      },
      budget,
      join(root, 'calls'),
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = String(init?.body)
        const body = JSON.parse(sentBody) as {
          model: string
          provider: { only: string[]; allow_fallbacks: boolean }
          questions: Record<string, { type: string; criteria: Record<string, string> }>
        }
        assert.equal(body.model, categoricalPilotRoutes.categorical.model)
        assert.deepEqual(body.provider, { only: ['openai'], allow_fallbacks: false })
        assert.equal(body.questions.presence?.type, 'choice')
        assert.deepEqual(Object.keys(body.questions.presence!.criteria), [
          'present',
          'absent',
          'unknown',
        ])
        return new Response(
          JSON.stringify({
            id: 'categorical-fixture-receipt',
            model: categoricalPilotRoutes.categorical.model,
            provider: categoricalPilotRoutes.categorical.providerName,
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
    const result = await recorded.port.decide(noulRequest, new AbortController().signal)
    assert.deepEqual(result.answers.presence, { type: 'presence', presence: 'unknown' })
    assert.equal(recorded.recorders.choice.logicalCalls.length, 0)
    assert.equal(recorded.recorders.categorical.logicalCalls.length, 1)
    assert.equal(recorded.recorders.categorical.calls.length, 1)
    assert.equal(
      recorded.recorders.categorical.calls[0]?.route.model,
      categoricalPilotRoutes.categorical.model,
    )
    assert.deepEqual(recorded.recorders.categorical.logicalCalls[0]?.request.questions, [
      { id: 'presence', type: 'choice', optionIds: ['present', 'absent', 'unknown'] },
    ])
    const wire = JSON.parse(sentBody) as { questions: Record<string, { type: string }> }
    assert.equal(wire.questions.presence?.type, 'choice')
    const logical = JSON.parse(
      await readFile(join(root, 'calls', 'categorical-luna', 'logical-1.json'), 'utf8'),
    ) as { request: { questions: Array<{ type: string }> } }
    assert.equal(logical.request.questions[0]?.type, 'choice')
    assert.equal(budget.snapshot().admittedPhysicalCalls, 1)
    assert.equal(budget.snapshot().knownCostUsd, 0.001)
    assert.equal(budget.snapshot().unknownCostCalls, 0)
    assert.equal(budget.snapshot().inFlightCalls, 0)
    assert.equal(sentBody.includes('offline-fixture-key'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('public classify and extract use the pinned composite with separate route ledgers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-categorical-public-flow-'))
  const budget = new RunBudget(100, 5, 0.05, 'dev')
  const image = new Uint8Array(
    await sharp({
      create: { width: 280, height: 280, channels: 3, background: '#eeeeee' },
    })
      .png()
      .toBuffer(),
  )
  const fetchRequests: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    fetchRequests.push(url)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (url.endsWith('/api/alpha/decisions')) {
      const questions = body.questions as Record<
        string,
        { type: string; criteria: Record<string, string> }
      >
      assert.ok(Object.values(questions).every((question) => question.type === 'choice'))
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          const ids = Object.keys(question.criteria)
          const probabilities = Object.fromEntries(
            ids.map((option) => [option, option === 'absent' ? 1 : 0]),
          )
          return [id, { type: 'choice', choice: 'absent', probabilities }]
        }),
      )
      return new Response(
        JSON.stringify({
          id: 'native-public-fixture',
          model: categoricalPilotRoutes.categorical.model,
          provider: categoricalPilotRoutes.categorical.providerName,
          usage: { cost: 0.001 },
          answers,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const messages = body.messages as Array<{
      content: string | Array<{ type: string; text?: string }>
    }>
    const content = messages[1]?.content
    assert.ok(Array.isArray(content))
    const taskText = content.find(
      (part) => part.type === 'text' && part.text?.startsWith('CLASSIFICATION_TASK\n'),
    )?.text
    assert.ok(taskText)
    const task = JSON.parse(taskText.slice('CLASSIFICATION_TASK\n'.length)) as {
      questions: Record<string, { rankingSize: number; options: Record<string, string> }>
    }
    const answers = Object.fromEntries(
      Object.entries(task.questions).map(([id, question]) => [
        id,
        { ranking: Object.keys(question.options).slice(0, question.rankingSize) },
      ]),
    )
    return new Response(
      JSON.stringify({
        id: 'spatial-public-fixture',
        model: categoricalPilotRoutes.choice.model,
        provider: categoricalPilotRoutes.choice.providerName,
        usage: { cost: 0.001 },
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { content: JSON.stringify({ answers }) },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const recorded = createRecordedCategoricalPresenceDecision(
    {
      apiKey: 'dummy-offline-fixture-key',
      inputManifestPath: '',
      imageRoot: '',
      outputRoot: '',
      encoderPath: '',
      decoderPath: '',
    },
    budget,
    join(root, 'calls'),
    fetch,
  )
  const forbiddenSegmenter: SegmentationPort = {
    async segment() {
      throw new Error('negative seed must stop before segmentation')
    },
    async settle() {},
    async dispose() {},
  }
  const classifier = createClassifier({
    decision: recorded.port,
    segmentation: forbiddenSegmenter,
    timeoutMs: categoricalPilotPolicy.timeoutMs,
    concurrency: 1,
    maxQueue: 0,
  })
  try {
    const classification = await classifier.classify({
      input: { image },
      classes: [
        { id: 'present', description: 'The described object is visible.' },
        { id: 'absent', description: 'The described object is not visible.' },
      ],
      instructions: 'Select one of the supplied labels.',
    })
    assert.equal(classification.choice, 'present')
    const extraction = await classifier.extract({
      image,
      target: 'the described object',
      mode: 'whole-object',
      boxTolerancePx: 8,
      maxExtentPasses: 3,
    })
    assert.equal(extraction.status, 'not-found')
    assert.equal(fetchRequests.length, 3)
    assert.deepEqual(fetchRequests.sort(), [
      'https://openrouter.ai/api/alpha/decisions',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
    ])
    assert.equal(recorded.recorders.choice.calls.length, 2)
    assert.equal(recorded.recorders.categorical.calls.length, 1)
    assert.equal(
      recorded.recorders.categorical.logicalCalls[0]?.request.questions[0]?.type,
      'choice',
    )
    assert.equal(budget.snapshot().admittedPhysicalCalls, 3)
    assert.equal(budget.snapshot().knownCostUsd, 0.003)
    assert.equal(budget.snapshot().unknownCostCalls, 0)
    assert.equal(budget.snapshot().inFlightCalls, 0)
  } finally {
    await classifier.dispose()
    image.fill(0)
    await rm(root, { recursive: true, force: true })
  }
})

await test('environment credential injection reads only the requested variable and never logs it', () => {
  const secret = 'fixture-only-secret'
  assert.equal(
    readCategoricalPilotOpenRouterKey(
      { OTHER_KEY: 'ignored', TEST_API_KEY: secret },
      'TEST_API_KEY',
    ),
    secret,
  )
  assert.throws(
    () => readCategoricalPilotOpenRouterKey({ TEST_API_KEY: secret }, 'BAD;NAME'),
    /environment variable name is invalid/u,
  )
  assert.throws(
    () => readCategoricalPilotOpenRouterKey({ OTHER_KEY: secret }, 'OPENROUTER_API_KEY'),
    /credential is absent/u,
  )
})
