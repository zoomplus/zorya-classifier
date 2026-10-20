import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createClassifier } from '../src/app/create-classifier.js'
import type { ObjectProposalBatch, ObjectProposalPort } from '../src/entities/object-proposals.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import { createSplitChoiceNoulPort } from '../benchmarks/v02/split-choice-noul-port.js'
import {
  createRecordedSplitDecision,
  splitPilotRoutes,
} from '../benchmarks/v02/split-route-proposal-pilot.js'

const request: DecisionRequest = {
  state: ['fixture request'],
  questions: {
    selection: {
      type: 'choice',
      rankingSize: 1,
      instructions: 'Choose one.',
      criteria: { present: 'visible', absent: 'not visible' },
    },
    presence: { type: 'noul', instructions: 'Is it present?' },
  },
}

function fakeFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    await new Promise((resolve) => setTimeout(resolve, url.endsWith('/decisions') ? 8 : 2))
    if (url.endsWith('/decisions')) {
      const questions = body.questions as Record<string, { type: string }>
      const answers = Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.7 }]),
      )
      return new Response(
        JSON.stringify({
          id: 'native-receipt',
          model: splitPilotRoutes.noul.model,
          provider: 'OpenAI',
          usage: { cost: 0.002 },
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
    const taskText = content.at(-1)?.text
    assert.ok(taskText?.startsWith('CLASSIFICATION_TASK\n'))
    if (!taskText) throw new Error('Fixture request did not contain its classification schema')
    const task = JSON.parse(taskText.slice('CLASSIFICATION_TASK\n'.length)) as {
      questions: Record<
        string,
        { kind: string; rankingSize: number; options: Record<string, string> }
      >
    }
    const answers = Object.fromEntries(
      Object.entries(task.questions).map(([id, q]) => [
        id,
        {
          ranking: Object.keys(q.options).slice(0, q.rankingSize),
        },
      ]),
    )
    return new Response(
      JSON.stringify({
        id: 'ordinary-receipt',
        model: splitPilotRoutes.choice.model,
        provider: 'OpenAI',
        usage: { cost: 0.001 },
        choices: [
          { index: 0, finish_reason: 'stop', message: { content: JSON.stringify({ answers }) } },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

await test('two per-case recorders share one physical budget without cross-case attribution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-split-ledger-'))
  try {
    const budget = new RunBudget(10, 1, 0.05, 'dev')
    const options = {
      apiKey: 'offline-test-key',
      inputManifestPath: '',
      imageRoot: '',
      outputRoot: '',
      encoderPath: '',
      decoderPath: '',
    }
    const fetch = fakeFetch()
    const first = createRecordedSplitDecision(
      options,
      budget,
      join(root, 'case-one', 'calls'),
      fetch,
    )
    const second = createRecordedSplitDecision(
      options,
      budget,
      join(root, 'case-two', 'calls'),
      fetch,
    )
    const [a, b] = await Promise.all([
      first.port.decide(request, new AbortController().signal),
      second.port.decide(request, new AbortController().signal),
    ])
    assert.deepEqual(Object.keys(a.answers).sort(), ['presence', 'selection'])
    assert.deepEqual(Object.keys(b.answers).sort(), ['presence', 'selection'])
    assert.equal(budget.snapshot().admittedPhysicalCalls, 4)
    assert.equal(budget.snapshot().knownCostUsd, 0.006)
    assert.equal(budget.snapshot().unknownCostCalls, 0)
    assert.equal(budget.snapshot().inFlightCalls, 0)
    assert.equal(first.recorders.choice.calls.length, 1)
    assert.equal(first.recorders.noul.calls.length, 1)
    assert.equal(second.recorders.choice.calls.length, 1)
    assert.equal(second.recorders.noul.calls.length, 1)
    assert.notEqual(
      first.recorders.choice.calls[0]?.physicalId,
      second.recorders.choice.calls[0]?.physicalId,
    )
    for (const routeDir of ['choice-sol', 'noul-luna']) {
      for (const caseDir of ['case-one', 'case-two']) {
        const names = await readdir(join(root, caseDir, 'calls', routeDir))
        assert.ok(names.some((name) => name.startsWith('physical-receipt-')))
        assert.equal(
          names.some((name) => name.includes('offline-test-key')),
          false,
        )
        for (const name of names) {
          const text = await readFile(join(root, caseDir, 'calls', routeDir, name), 'utf8')
          assert.equal(text.includes('offline-test-key'), false)
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('public classify and extraction route Choice and NoUL legs to only their injected ports', async () => {
  const routed: Array<{ route: string; types: string[] }> = []
  const choicePort: DecisionPort = {
    async decide(request) {
      const questions = Object.entries(request.questions)
      routed.push({ route: 'choice', types: questions.map(([, q]) => q.type) })
      assert.ok(questions.every(([, q]) => q.type === 'choice'))
      const answers = Object.fromEntries(
        questions.map(([id, question]) => {
          assert.equal(question.type, 'choice')
          return [
            id,
            {
              type: 'ranked-choice' as const,
              ranking: Object.keys(question.criteria).slice(0, question.rankingSize ?? 4),
            },
          ]
        }),
      )
      return fixtureResult(answers)
    },
  }
  const noulPort: DecisionPort = {
    async decide(request) {
      const questions = Object.entries(request.questions)
      routed.push({ route: 'noul', types: questions.map(([, q]) => q.type) })
      assert.ok(questions.every(([, q]) => q.type === 'noul'))
      return fixtureResult(
        Object.fromEntries(questions.map(([id]) => [id, { type: 'noul' as const, noul: 0.99 }])),
      )
    },
  }
  const proposals: ObjectProposalPort = {
    async propose(input): Promise<ObjectProposalBatch> {
      const size = Math.ceil((input.image.width * input.image.height) / 8)
      const data = new Uint8Array(size).fill(255)
      const remainder = (input.image.width * input.image.height) % 8
      if (remainder) data[data.length - 1] = (1 << remainder) - 1
      return {
        proposals: [
          {
            id: 'C00',
            mask: {
              data,
              width: input.image.width,
              height: input.image.height,
              format: 'binary-lsb0',
            },
          },
        ],
        metadata: {
          method: 'mobile-sam-nine-point-proposals-v1',
          backend: 'mobile-sam',
          durationMs: 1,
          input: { width: input.image.width, height: input.image.height },
        },
      }
    },
    async settle() {},
    async dispose() {},
  }
  const client = createClassifier({
    decision: createSplitChoiceNoulPort(choicePort, noulPort),
    objectProposals: proposals,
    timeoutMs: 10_000,
    concurrency: 1,
    maxQueue: 0,
  })
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#dddddd' } })
    .png()
    .toBuffer()
  try {
    const classification = await client.classify({
      input: { image: png },
      classes: [
        { id: 'present', description: 'Visible.' },
        { id: 'absent', description: 'Not visible.' },
      ],
      instructions: 'Choose one label.',
    })
    assert.equal(classification.choice, 'present')
    assert.deepEqual(routed.splice(0), [{ route: 'choice', types: ['choice'] }])
    const extraction = await client.extract({
      image: png,
      target: 'the whole visible target',
      mode: 'whole-object',
      boxTolerancePx: 8,
      maxExtentPasses: 3,
    })
    assert.notEqual(extraction.status, 'failed')
    assert.ok(routed.length >= 2)
    assert.ok(
      routed.every((entry) =>
        entry.types.every((type) => type === (entry.route === 'choice' ? 'choice' : 'noul')),
      ),
    )
    assert.ok(routed.some((entry) => entry.route === 'choice'))
    assert.ok(routed.some((entry) => entry.route === 'noul'))
  } finally {
    await client.dispose()
  }
})

function fixtureResult(answers: DecisionResult['answers']): DecisionResult {
  return {
    answers,
    metadata: {
      model: 'offline-fixture',
      provider: 'offline',
      requestId: null,
      durationMs: 1,
      costUsd: 0,
      attempts: 1,
    },
  }
}
