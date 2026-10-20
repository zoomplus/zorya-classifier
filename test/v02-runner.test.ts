import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import type { DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createResearchClassifier } from '../src/app/create-classifier.js'
import { createSharpBoundaryView } from '../src/infrastructure/boundary-view.js'
import { RunBudget, RunBudgetExhausted } from '../benchmarks/v02/budget.js'
import {
  createDecisionTrace,
  inputManifestSchema,
  modelRequestManifest,
} from '../benchmarks/v02/protocol.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { applyPromptVariant, promptVariants } from '../benchmarks/v02/promptvariants.js'
import {
  createLunaDecisionProvider,
  createTextProviderForVariant,
} from '../benchmarks/v02/runner.js'
import { parseV02RunnerArgs } from '../benchmarks/v02/run.js'
import { evaluateDiagnostic } from '../benchmarks/v02/evaluate-diagnostic.js'
import { withSeedUnboundedPrompt } from '../benchmarks/v02/seedunboundedprompt.js'

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

await test('decision trace stores closed grid labels, raw probabilities, and code-resolved source cells only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-decision-trace-grid-'))
  const request: DecisionRequest = {
    state: [
      '{"target":"private-target-description","exclusions":[]}',
      JSON.stringify({
        panel: 'FRAME',
        sourceRegion: { left: 0, top: 0, width: 100, height: 80 },
        labels: [
          { id: 'P01', sourceRegion: { left: 0, top: 0, width: 50, height: 40 } },
          { id: 'P02', sourceRegion: { left: 50, top: 40, width: 50, height: 40 } },
        ],
      }),
      JSON.stringify({
        representationView: {
          id: 'FRAME-grid',
          aliases: [
            {
              id: 'FRAME-grid',
              role: 'grid',
              sourceRegion: { left: 0, top: 0, width: 100, height: 80 },
            },
          ],
          sourceRegion: { left: 0, top: 0, width: 100, height: 80 },
          dimensions: { width: 50, height: 40 },
          scaleX: 0.5,
          scaleY: 0.5,
          grid: [
            {
              viewId: 'FRAME-grid',
              cells: [
                {
                  id: 'cell-02',
                  column: 1,
                  row: 1,
                  region: { left: 50, top: 40, width: 50, height: 40 },
                  label: 'P02',
                },
              ],
            },
          ],
        },
      }),
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,private-image-sentinel', detail: 'high' },
      },
    ],
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'private-instructions-sentinel',
        criteria: { P01: 'private-class-description-one', P02: 'private-class-description-two' },
      },
      presence: { type: 'noul', instructions: 'private-presence-instructions' },
    },
  }
  const result: DecisionResult = {
    answers: {
      selection: { type: 'choice', choice: 'P02', probabilities: { P01: 0.125, P02: 0.875 } },
      presence: { type: 'noul', noul: 0.7 },
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
  try {
    const recorder = recordProvider(
      () => ({
        async decide() {
          return result
        },
      }),
      new RunBudget(1, 0.1),
      directory,
      {
        model: 'fixture',
        provider: 'fixture',
        providerName: 'fixture',
        apiEndpoint: '/fixture',
        allowFallbacks: false,
      },
    )
    await recorder.port.decide(request, new AbortController().signal)
    const traceText = await readFile(join(directory, 'decision-trace-1.json'), 'utf8')
    const trace = JSON.parse(traceText) as {
      status: string
      questions: {
        questionId: string
        selected?: string
        probabilities?: { optionId: string; value: number }[]
        selectedSourceRegions?: {
          optionId: string
          region: { left: number; top: number; width: number; height: number }
        }[]
      }[]
      geometry: {
        seedRegion: unknown
        imageTransforms: {
          viewId: string | null
          role: string
          sourceRegion: { left: number; top: number; width: number; height: number } | null
          output: { width: number; height: number }
          scaleX: number
          scaleY: number
        }[]
      }
    }
    const selection = trace.questions.find((question) => question.questionId === 'selection')
    assert.equal(trace.status, 'recorded')
    assert.equal(selection?.selected, 'P02')
    assert.deepEqual(selection?.probabilities, [
      { optionId: 'P01', value: 0.125 },
      { optionId: 'P02', value: 0.875 },
    ])
    assert.deepEqual(selection?.selectedSourceRegions, [
      { optionId: 'P02', region: { left: 50, top: 40, width: 50, height: 40 } },
    ])
    assert.equal(trace.geometry.seedRegion, null)
    assert.deepEqual(trace.geometry.imageTransforms, [
      {
        viewId: 'FRAME-grid',
        role: 'grid',
        sourceRegion: { left: 0, top: 0, width: 100, height: 80 },
        source: { width: 100, height: 80 },
        output: { width: 50, height: 40 },
        content: { left: 0, top: 0, width: 50, height: 40 },
        scaleX: 0.5,
        scaleY: 0.5,
      },
    ])
    assert.doesNotMatch(
      traceText,
      /private-target-description|private-instructions-sentinel|private-class-description|private-image-sentinel|data:image|fixture-key/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('decision trace preserves closed rankings and omits requests beyond the option budget', () => {
  const rankingRequest: DecisionRequest = {
    state: [],
    questions: {
      selection: {
        type: 'choice',
        rankingSize: 4,
        instructions: 'fixture',
        criteria: { P01: 'first', P02: 'second', P03: 'third' },
      },
    },
  }
  const ranked = createDecisionTrace(rankingRequest, {
    answers: { selection: { type: 'ranked-choice', ranking: ['P02', 'P01', 'P03'] } },
    metadata: {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 1,
      costUsd: null,
      attempts: 1,
    },
  })
  assert.equal(ranked.trace.status, 'recorded')
  if (ranked.trace.status !== 'recorded') return
  assert.deepEqual(ranked.trace.questions[0], {
    questionId: 'selection',
    answerType: 'ranked-choice',
    ranking: ['P02', 'P01', 'P03'],
    selectedSourceRegions: [],
    intervalOptions: [],
  })

  const criteria = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`C${String(index).padStart(3, '0')}`, 'fixture']),
  )
  const probabilities = Object.fromEntries(
    Object.keys(criteria).map((id, index) => [id, index === 0 ? 0.5 : 0.5 / 255]),
  )
  const oversized = createDecisionTrace(
    {
      state: [],
      questions: {
        selection: { type: 'choice', rankingSize: 1, instructions: 'fixture', criteria },
      },
    },
    {
      answers: { selection: { type: 'choice', choice: 'C000', probabilities } },
      metadata: {
        model: 'fixture',
        provider: 'fixture',
        requestId: null,
        durationMs: 1,
        costUsd: null,
        attempts: 1,
      },
    },
  )
  assert.deepEqual(oversized.trace, { status: 'omitted', reason: 'option-limit-exceeded' })
})

await test('decision trace captures strict source seed, extent interval, and view transform metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-decision-trace-extent-'))
  const seedRegion = { left: 11, top: 13, width: 27, height: 29 }
  const currentBounds = {
    left: { start: 0, endExclusive: 100 },
    right: { start: 0, endExclusive: 100 },
    top: { start: 0, endExclusive: 80 },
    bottom: { start: 0, endExclusive: 80 },
  }
  const transform = (source: { width: number; height: number }) =>
    JSON.stringify({
      sourceImageTransform: {
        source,
        output: { width: 280, height: 280 },
        content: { left: 0, top: 0, width: 280, height: 280 },
        scaleX: 2,
        scaleY: 2,
      },
    })
  const request: DecisionRequest = {
    state: [
      'ORIGINAL AND SEED GEOMETRY',
      JSON.stringify({ seedRegion }),
      JSON.stringify({
        pass: 1,
        hardRoi: { left: 0, top: 0, width: 100, height: 80 },
        seedRegion,
        currentBounds,
      }),
      transform({ width: 100, height: 80 }),
      transform({ width: 27, height: 29 }),
      'private target/class description must stay out of the trace',
    ],
    questions: {
      left: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'private boundary instruction',
        criteria: {
          left00: 'Integer boundary coordinates in [0, 50).',
          unknown: 'private unknown description',
        },
      },
      right: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'private boundary instruction',
        criteria: {
          right00: 'Integer boundary coordinates in [50, 100).',
          unknown: 'private unknown description',
        },
      },
      top: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'private boundary instruction',
        criteria: {
          top00: 'Integer boundary coordinates in [0, 40).',
          unknown: 'private unknown description',
        },
      },
      bottom: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'private boundary instruction',
        criteria: {
          bottom00: 'Integer boundary coordinates in [40, 80).',
          unknown: 'private unknown description',
        },
      },
      instance: {
        type: 'choice',
        rankingSize: 1,
        instructions: 'private identity instruction',
        criteria: { same: 'same', different: 'different', ambiguous: 'ambiguous' },
      },
    },
  }
  const result: DecisionResult = {
    answers: {
      left: { type: 'choice', choice: 'left00', probabilities: { left00: 0.8, unknown: 0.2 } },
      right: { type: 'choice', choice: 'right00', probabilities: { right00: 0.8, unknown: 0.2 } },
      top: { type: 'choice', choice: 'top00', probabilities: { top00: 0.8, unknown: 0.2 } },
      bottom: {
        type: 'choice',
        choice: 'bottom00',
        probabilities: { bottom00: 0.8, unknown: 0.2 },
      },
      instance: {
        type: 'choice',
        choice: 'same',
        probabilities: { same: 0.8, different: 0.1, ambiguous: 0.1 },
      },
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
  try {
    const recorder = recordProvider(
      () => ({
        async decide() {
          return result
        },
      }),
      new RunBudget(1, 0.1),
      directory,
      {
        model: 'fixture',
        provider: 'fixture',
        providerName: 'fixture',
        apiEndpoint: '/fixture',
        allowFallbacks: false,
      },
    )
    await recorder.port.decide(request, new AbortController().signal)
    const traceText = await readFile(join(directory, 'decision-trace-1.json'), 'utf8')
    const trace = JSON.parse(traceText) as {
      geometry: {
        seedRegion: typeof seedRegion | null
        currentBounds: typeof currentBounds | null
        imageTransforms: {
          sourceRegion: typeof seedRegion | null
          scaleX: number
          scaleY: number
        }[]
      }
      questions: {
        questionId: string
        intervalOptions?: { optionId: string; start: number; endExclusive: number }[]
      }[]
    }
    assert.deepEqual(trace.geometry.seedRegion, seedRegion)
    assert.deepEqual(trace.geometry.currentBounds, currentBounds)
    assert.deepEqual(
      trace.geometry.imageTransforms.map((item) => item.sourceRegion),
      [null, null],
    )
    assert.deepEqual(
      trace.geometry.imageTransforms.map((item) => [item.scaleX, item.scaleY]),
      [
        [2, 2],
        [2, 2],
      ],
    )
    assert.deepEqual(
      trace.questions.find((question) => question.questionId === 'left')?.intervalOptions,
      [{ optionId: 'left00', start: 0, endExclusive: 50 }],
    )
    assert.doesNotMatch(
      traceText,
      /private boundary instruction|private unknown description|private target\/class/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('integrated boundary request trace resolves hard ROI, seed bounds, and strict axis-view maps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-boundary-trace-integration-'))
  const decision = {
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      const answers: DecisionResult['answers'] = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') {
          answers[id] = { type: 'noul', noul: 0.99 }
          continue
        }
        const options = Object.keys(question.criteria)
        const choice =
          id === 'instance'
            ? 'same'
            : id === 'left'
              ? options[0]!
              : id === 'right'
                ? options.at(-2)!
                : id === 'top'
                  ? options[0]!
                  : id === 'bottom'
                    ? options.at(-2)!
                    : options[0]!
        answers[id] = {
          type: 'choice',
          choice,
          probabilities: Object.fromEntries(
            options.map((option) => [option, option === choice ? 1 : 0]),
          ),
        }
      }
      return {
        answers,
        metadata: {
          model: 'fixture',
          provider: 'fixture',
          requestId: null,
          durationMs: 1,
          costUsd: 0,
          attempts: 1,
        },
      }
    },
  }
  try {
    const recorder = recordProvider(() => decision, new RunBudget(16, 1), directory, {
      model: 'fixture',
      provider: 'fixture',
      providerName: 'fixture',
      apiEndpoint: '/fixture',
      allowFallbacks: false,
    })
    const classifier = createResearchClassifier(
      { decision: recorder.port, timeoutMs: 10000 },
      undefined,
      createSharpBoundaryView(),
    )
    try {
      await classifier.locate({
        image: new Uint8Array(
          await sharp({
            create: { width: 400, height: 300, channels: 3, background: '#888888' },
          })
            .png()
            .toBuffer(),
        ),
        target: 'fixture target',
        mode: 'whole-object',
        boxTolerancePx: 8,
        maxExtentPasses: 1,
      })
    } finally {
      await classifier.dispose()
    }

    const trace = JSON.parse(await readFile(join(directory, 'decision-trace-4.json'), 'utf8')) as {
      geometry: {
        seedRegion: { left: number; top: number; width: number; height: number } | null
        currentBounds: { left: { start: number; endExclusive: number } } | null
        imageTransforms: { role: string; sourceRegion: unknown; scaleX: number; scaleY: number }[]
        boundaryViews: {
          axis: string
          sourceRegion: { left: number; top: number; width: number; height: number }
          content: { left: number; top: number; width: number; height: number }
          image: { width: number; height: number }
          choices: { questionId: string; choiceId: string; display: string; interval: unknown }[]
        }[]
      }
      questions: { questionId: string; intervalOptions?: { optionId: string }[] }[]
    }
    assert.ok(trace.geometry.seedRegion)
    assert.ok(trace.geometry.seedRegion.width > 0 && trace.geometry.seedRegion.height > 0)
    assert.ok(trace.geometry.seedRegion.left + trace.geometry.seedRegion.width <= 400)
    assert.ok(trace.geometry.seedRegion.top + trace.geometry.seedRegion.height <= 300)
    assert.deepEqual(trace.geometry.currentBounds?.left, { start: 0, endExclusive: 400 })
    assert.equal(trace.geometry.boundaryViews.length, 2)
    assert.equal(
      trace.geometry.imageTransforms.filter((item) => item.role === 'boundary-view').length,
      2,
    )
    const xView = trace.geometry.boundaryViews.find((view) => view.axis === 'X')
    assert.ok(xView)
    assert.ok(
      xView.choices.some(
        (item) => item.questionId === 'left' && item.choiceId === 'left00' && item.display === 'X0',
      ),
    )
    assert.ok(
      xView.choices.some(
        (item) =>
          item.questionId === 'right' && item.choiceId === 'right00' && item.display === 'X0',
      ),
    )
    assert.deepEqual(
      trace.questions.find((item) => item.questionId === 'left')?.intervalOptions?.[0],
      { optionId: 'left00', start: 0, endExclusive: 25 },
    )
    const traceText = await readFile(join(directory, 'decision-trace-4.json'), 'utf8')
    assert.doesNotMatch(traceText, /fixture target|boundaryInstruction|https?:/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('seed-unbounded prompt survives the real whole-object producer and ranked axis trace schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-seed-unbounded-trace-'))
  let extentState: string[] | undefined
  const decision = {
    async decide(request: DecisionRequest): Promise<DecisionResult> {
      const answers: DecisionResult['answers'] = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'noul') {
          answers[id] = { type: 'noul', noul: 0.99 }
          continue
        }
        const options = question.type === 'choice' ? Object.keys(question.criteria) : []
        if (['left', 'right', 'top', 'bottom', 'instance'].includes(id))
          extentState = request.state.filter((part): part is string => typeof part === 'string')
        answers[id] = {
          type: 'ranked-choice',
          ranking: options.slice(0, Math.min(question.rankingSize ?? 4, options.length)),
        }
      }
      return {
        answers,
        metadata: {
          model: 'fixture',
          provider: 'fixture',
          requestId: null,
          durationMs: 1,
          costUsd: null,
          attempts: 1,
        },
      }
    },
  }
  try {
    const recorder = recordProvider(() => decision, new RunBudget(8, 1), directory, {
      model: 'fixture',
      provider: 'fixture',
      providerName: 'fixture',
      apiEndpoint: '/fixture',
      allowFallbacks: false,
    })
    const classifier = createResearchClassifier(
      { decision: withSeedUnboundedPrompt(recorder.port), timeoutMs: 10000 },
      undefined,
      createSharpBoundaryView(),
    )
    try {
      await classifier.locate({
        image: new Uint8Array(
          await sharp({
            create: { width: 400, height: 300, channels: 3, background: '#888888' },
          })
            .png()
            .toBuffer(),
        ),
        target: 'fixture target',
        mode: 'whole-object',
        boxTolerancePx: 8,
        maxExtentPasses: 1,
      })
    } finally {
      await classifier.dispose()
    }
    assert.ok(extentState)
    assert.equal(
      extentState.some((part) =>
        part.includes('A matching fragment anywhere inside a cell counts; no center requirement.'),
      ),
      false,
    )
    assert.equal(
      extentState.some((part) => part.includes('SEED crop boundaries do not limit')),
      true,
    )
    const extentCall = recorder.logicalCalls.find((call) =>
      call.request.questions.some((question) => question.id === 'left'),
    )
    assert.ok(extentCall)
    const trace = JSON.parse(
      await readFile(join(directory, `decision-trace-${extentCall.logicalId}.json`), 'utf8'),
    ) as {
      status: string
      geometry: { seedRegion: unknown; currentBounds: unknown; boundaryViews: unknown[] }
      questions: { questionId: string; intervalOptions?: { optionId: string }[] }[]
    }
    assert.equal(trace.status, 'recorded')
    assert.ok(trace.geometry.seedRegion)
    assert.ok(trace.geometry.currentBounds)
    assert.equal(trace.geometry.boundaryViews.length, 2)
    for (const axis of ['left', 'right', 'top', 'bottom']) {
      const question = trace.questions.find((item) => item.questionId === axis)
      assert.ok(question)
      assert.ok((question.intervalOptions?.length ?? 0) > 0)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('decision trace omits invalid extra answers and unrecognized no-image questions without leaking state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v02-decision-trace-omitted-'))
  const route = {
    model: 'fixture',
    provider: 'fixture',
    providerName: 'fixture',
    apiEndpoint: '/fixture',
    allowFallbacks: false as const,
  }
  const baseRequest: DecisionRequest = {
    state: [
      'OPENROUTER_API_KEY=private-state-sentinel',
      'private target description',
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,private-image-sentinel', detail: 'high' },
      },
    ],
    questions: {
      selection: {
        type: 'choice',
        instructions: 'private instructions',
        criteria: { A: 'private description', B: 'private description' },
      },
    },
  }
  const validAnswer: DecisionResult = {
    answers: { selection: { type: 'choice', choice: 'A', probabilities: { A: 0.7, B: 0.3 } } },
    metadata: {
      model: 'fixture',
      provider: 'fixture',
      requestId: null,
      durationMs: 1,
      costUsd: null,
      attempts: 1,
    },
  }
  try {
    const invalid = recordProvider(
      () => ({
        async decide() {
          return {
            ...validAnswer,
            answers: {
              ...validAnswer.answers,
              ['OPENROUTER_API_KEY=secret-extra-answer']: { type: 'presence', presence: 'unknown' },
            },
          } as unknown as DecisionResult
        },
      }),
      new RunBudget(1, 0.1),
      join(directory, 'invalid'),
      route,
    )
    await assert.rejects(invalid.port.decide(baseRequest, new AbortController().signal))
    const invalidTrace = await readFile(join(directory, 'invalid', 'decision-trace-1.json'), 'utf8')
    assert.deepEqual(JSON.parse(invalidTrace), {
      status: 'omitted',
      reason: 'invalid-decision-result',
    })
    assert.doesNotMatch(
      invalidTrace,
      /OPENROUTER_API_KEY|secret-extra-answer|private-state-sentinel/u,
    )

    const noImageRequest: DecisionRequest = {
      state: baseRequest.state,
      questions: {
        classification: {
          type: 'choice',
          instructions: 'private no-image instructions',
          criteria: { unknown: 'private no-image description', present: 'secret target detail' },
        },
      },
    }
    const noImage = recordProvider(
      () => ({
        async decide() {
          return {
            answers: {
              classification: {
                type: 'choice',
                choice: 'unknown',
                probabilities: { unknown: 0.8, present: 0.2 },
              },
            },
            metadata: validAnswer.metadata,
          }
        },
      }),
      new RunBudget(1, 0.1),
      join(directory, 'no-image'),
      route,
    )
    await noImage.port.decide(noImageRequest, new AbortController().signal)
    const noImageTrace = await readFile(
      join(directory, 'no-image', 'decision-trace-1.json'),
      'utf8',
    )
    assert.deepEqual(JSON.parse(noImageTrace), {
      status: 'omitted',
      reason: 'unrecognized-question-id',
    })
    assert.doesNotMatch(
      noImageTrace,
      /OPENROUTER_API_KEY|private-state-sentinel|private-image-sentinel|private no-image|secret target/u,
    )
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
