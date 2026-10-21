import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { DecisionPort, DecisionRequest, DecisionResult } from '../src/entities/contracts.js'
import { createOpenRouterDecisions } from '../src/infrastructure/openrouter.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { executeNativeRecipeCase } from '../benchmarks/v03/h6-replay-kernel.js'
import {
  H6_MODEL,
  runH6ContextIdentityReplay,
  type H6Route,
} from '../benchmarks/v03/run-h6-context-identity.js'
import {
  verifyH6DecisionTraceArtifacts,
  verifyH6PhysicalReceiptArtifacts,
  type H6ReplayEnvelope,
  type H6ReplayRow,
} from '../benchmarks/v03/evaluate-h6-context-identity.js'

const repositoryRoot = resolve('.')
const h5aDirectory =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h5a-native-proposals-v2'
const h4eDirectory =
  '/root/work/zorya-classifier-worktrees/v03/segmentation-research/.run/v03/h4e-sam2-context-prompt-v1'
const route: H6Route = {
  model: H6_MODEL,
  provider: 'openai',
  providerName: 'OpenAI',
  apiEndpoint: '/api/alpha/decisions',
  allowFallbacks: false,
}
const expectedPresence: Record<string, 'present' | 'absent' | 'uncertain'> = {
  'pilot-v03-photo-01': 'present',
  'pilot-v03-photo-02': 'present',
  'pilot-v03-photo-03': 'uncertain',
  'pilot-v03-photo-04': 'absent',
  'pilot-v03-ui-01': 'present',
  'pilot-v03-ui-02': 'present',
  'pilot-v03-ui-03': 'present',
  'pilot-v03-ui-04': 'absent',
  'pilot-v03-map-01': 'present',
  'pilot-v03-map-02': 'present',
  'pilot-v03-map-03': 'present',
  'pilot-v03-map-04': 'uncertain',
}

function result(
  request: DecisionRequest,
  answer: DecisionResult['answers'][string],
): DecisionResult {
  const id = Object.keys(request.questions)[0]!
  return {
    answers: { [id]: answer },
    metadata: {
      model: H6_MODEL,
      provider: 'openai',
      requestId: `mock-${id}`,
      durationMs: 1,
      costUsd: 0,
      attempts: 1,
    },
  }
}

function targetFrom(request: DecisionRequest) {
  const line = request.state.filter((part): part is string => typeof part === 'string').at(-1)!
  const match = /^Authored target: (".*")\. Authored exclusions:/u.exec(line)
  if (!match) throw new Error('Mock could not read target from request')
  return JSON.parse(match[1]!) as string
}

function mockDecisionPort(options: {
  cases: Array<{ case_id: string; target: string }>
  failUi03?: boolean
  delayMs?: number
  onCall?: () => void
}): DecisionPort {
  const caseByTarget = new Map(options.cases.map((item) => [item.target, item.case_id]))
  return {
    async decide(request, signal) {
      options.onCall?.()
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      signal.throwIfAborted()
      const caseId = caseByTarget.get(targetFrom(request))
      if (!caseId) throw new Error('Mock received an unknown target')
      const questionId = Object.keys(request.questions)[0]!
      if (questionId === 'presence') {
        const choice = expectedPresence[caseId]!
        return result(request, {
          type: 'choice',
          choice,
          probabilities: {
            present: choice === 'present' ? 0.9 : 0.05,
            absent: choice === 'absent' ? 0.9 : 0.05,
            uncertain: choice === 'uncertain' ? 0.9 : 0.05,
          },
        })
      }
      if (options.failUi03 && caseId === 'pilot-v03-ui-03')
        throw new Error('synthetic provider failure')
      const question = request.questions[questionId]!
      if (question.type !== 'choice') throw new Error('Mock expected a Choice question')
      const aliases = Object.keys(question.criteria)
      const selected =
        caseId === 'pilot-v03-map-01' || caseId === 'pilot-v03-map-03' ? 'none' : aliases[0]!
      return result(request, {
        type: 'choice',
        choice: selected,
        probabilities: Object.fromEntries(
          aliases.map((alias) => [alias, alias === selected ? 0.9 : 0.1 / (aliases.length - 1)]),
        ),
      })
    },
  }
}

function controlledDecisionsFetch(cases: Array<{ case_id: string; target: string }>) {
  const seen: Array<{ stage: string; imageCount: number }> = []
  let currentCaseIndex = -1
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://openrouter.ai/api/alpha/decisions')
    assert.equal(init?.method, 'POST')
    const body = JSON.parse(String(init?.body)) as {
      model: string
      provider: { only: string[]; allow_fallbacks: boolean }
      state: Array<string | { type: 'image_url'; image_url: { url: string; detail: string } }>
      questions: Record<string, { type: 'choice'; criteria: Record<string, string> }>
    }
    assert.equal(body.model, H6_MODEL)
    assert.deepEqual(body.provider, { only: ['openai'], allow_fallbacks: false })
    const imageParts = body.state.filter((part) => typeof part !== 'string')
    for (const part of imageParts) {
      assert.equal(part.type, 'image_url')
      assert.equal(part.image_url.detail, 'high')
      assert.match(part.image_url.url, /^data:image\/png;base64,/u)
    }
    const instruction = body.state.find((part): part is string => typeof part === 'string')!
    const stage = instruction.startsWith('Determine whether')
      ? 'presence'
      : instruction.startsWith('Rank up to four')
        ? 'nomination'
        : 'final'
    assert.ok(imageParts.length <= (stage === 'nomination' ? 5 : stage === 'final' ? 9 : 1))
    seen.push({ stage, imageCount: imageParts.length })
    const targetLine = body.state.filter((part): part is string => typeof part === 'string').at(-1)!
    const targetMatch = /^Authored target: (".*")\. Authored exclusions:/u.exec(targetLine)
    assert.ok(targetMatch)
    const target = JSON.parse(targetMatch[1]!) as string
    if (stage === 'presence') currentCaseIndex++
    const currentCase = cases[currentCaseIndex]
    const caseId = currentCase?.case_id
    assert.ok(caseId)
    assert.equal(target, currentCase.target)
    if (caseId === 'pilot-v03-ui-03' && stage === 'nomination')
      return new Response(JSON.stringify({ error: { message: 'synthetic provider failure' } }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    const questionId = Object.keys(body.questions)[0]!
    const keys = Object.keys(body.questions[questionId]!.criteria)
    let selected: string
    if (stage === 'presence') selected = expectedPresence[caseId]!
    else if (stage === 'nomination' && caseId === 'pilot-v03-map-01') selected = 'none'
    else if (stage === 'final' && caseId === 'pilot-v03-map-03') selected = 'none'
    else selected = keys[0]!
    const answers = {
      [questionId]: {
        type: 'choice',
        choice: selected,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, key === selected ? 0.9 : 0.1 / (keys.length - 1)]),
        ),
      },
    }
    return new Response(
      JSON.stringify({
        id: `offline-${seen.length}`,
        model: H6_MODEL,
        provider: 'OpenAI',
        answers,
        usage: { cost: 0.0001 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { fetcher, seen }
}

async function hasNativeArtifacts() {
  try {
    await Promise.all([
      access(join(h5aDirectory, 'run.json')),
      access(join(h4eDirectory, 'run.json')),
      access(resolve(repositoryRoot, 'benchmarks/v03/run-h6-context-identity.ts')),
    ])
    return true
  } catch {
    return false
  }
}

await test(
  'H6 mocked replay covers all 12 cases, early presence exits, final none, and provider error',
  {
    skip: !(await hasNativeArtifacts()),
  },
  async () => {
    const native = JSON.parse(await readFile(join(h5aDirectory, 'run.json'), 'utf8')) as {
      cases: Array<{ case_id: string; target: string }>
    }
    const outputParent = await mkdtemp(join(tmpdir(), 'h6-mock-replay-'))
    const outputDirectory = join(outputParent, 'run')
    const budget = new RunBudget(48, 2, 0.1)
    const controlled = controlledDecisionsFetch(native.cases)
    const recorder = recordProvider(
      (trackedFetch) =>
        createOpenRouterDecisions({
          apiKey: 'dummy-offline-fixture-key',
          model: H6_MODEL,
          provider: 'openai',
          providerName: 'OpenAI',
          fetch: trackedFetch,
        }),
      budget,
      join(outputDirectory, 'provider-calls'),
      route,
      controlled.fetcher,
    )
    try {
      const replay = (await runH6ContextIdentityReplay({
        repositoryRoot,
        h5aDirectory,
        h4eDirectory,
        outputDirectory,
        recorder,
        budget,
        route,
      })) as {
        status: string
        rows: H6ReplayRow[]
        logical_call_count: number
        physical_call_count: number
      }
      assert.equal(replay.status, 'complete')
      assert.equal(replay.rows.length, 12)
      const rows = replay.rows
      for (const [caseId, choice] of Object.entries(expectedPresence)) {
        const row = rows.find((item) => item.case_id === caseId)!
        assert.equal(row.presence?.selection?.choice, choice, JSON.stringify(row))
        if (choice !== 'present') {
          assert.equal(row.status, 'unknown')
          assert.deepEqual(row.nominations, [])
          assert.equal(row.selected_mask_path, null)
        }
      }
      assert.equal(rows.find((row) => row.case_id === 'pilot-v03-ui-03')?.status, 'error')
      assert.equal(
        rows.find((row) => row.case_id === 'pilot-v03-ui-03')?.presence.selection?.choice,
        'present',
      )
      assert.equal(
        rows.find((row) => row.case_id === 'pilot-v03-map-01')?.nominations[0]?.top_four[0],
        'none',
        JSON.stringify(rows.find((row) => row.case_id === 'pilot-v03-map-01')),
      )
      assert.equal(
        rows.find((row) => row.case_id === 'pilot-v03-map-03')?.unknown_reason,
        'none-selected',
      )
      assert.ok(
        controlled.seen.some((entry) => entry.stage === 'nomination' && entry.imageCount > 1),
      )
      assert.ok(controlled.seen.some((entry) => entry.stage === 'final' && entry.imageCount > 1))
      assert.equal(recorder.logicalCalls.length, replay.logical_call_count)
      assert.equal(budget.snapshot().admittedPhysicalCalls, replay.physical_call_count)
      const recordingRoot = join(outputDirectory, 'provider-calls')
      assert.equal(
        (await verifyH6PhysicalReceiptArtifacts(recordingRoot, replay as H6ReplayEnvelope))
          .verifiedPhysicalCalls,
        replay.physical_call_count,
      )
      assert.ok(
        (await verifyH6DecisionTraceArtifacts(recordingRoot, replay as H6ReplayEnvelope))
          .verifiedStages > 0,
      )
    } finally {
      await rm(outputParent, { recursive: true, force: true })
    }
  },
)

await test('H6 rejects a recorder bound to a different budget before creating output or dispatching', async () => {
  const outputParent = await mkdtemp(join(tmpdir(), 'h6-budget-mismatch-'))
  const outputDirectory = join(outputParent, 'never-created')
  const captured = new RunBudget(48, 2, 0.1)
  const supplied = new RunBudget(48, 2, 0.1)
  let dispatched = false
  const recorder = recordProvider(
    () => ({
      async decide() {
        dispatched = true
        throw new Error('must not dispatch')
      },
    }),
    captured,
    join(outputDirectory, 'provider-calls'),
    route,
  )
  try {
    await assert.rejects(
      runH6ContextIdentityReplay({
        repositoryRoot,
        h5aDirectory,
        h4eDirectory,
        outputDirectory,
        recorder,
        budget: supplied,
        route,
      }),
      /not bound to the supplied run budget/u,
    )
    assert.equal(dispatched, false)
    await assert.rejects(access(outputDirectory))
  } finally {
    await rm(outputParent, { recursive: true, force: true })
  }
})

await test(
  'H6 cancellation during the first mock decision is retained as a timeout row',
  {
    skip: !(await hasNativeArtifacts()),
  },
  async () => {
    const native = JSON.parse(await readFile(join(h5aDirectory, 'run.json'), 'utf8')) as {
      cases: Array<{ case_id: string; target: string }>
    }
    const outputParent = await mkdtemp(join(tmpdir(), 'h6-mock-cancel-'))
    const outputDirectory = join(outputParent, 'run')
    const budget = new RunBudget(48, 2, 0.1)
    const recorder = recordProvider(
      () =>
        mockDecisionPort({
          cases: native.cases,
          delayMs: 100,
          onCall: () => {
            if (!controller.signal.aborted)
              setTimeout(() => controller.abort(new Error('test cancellation')), 10)
          },
        }),
      budget,
      join(outputDirectory, 'provider-calls'),
      route,
    )
    const controller = new AbortController()
    try {
      const replay = (await runH6ContextIdentityReplay({
        repositoryRoot,
        h5aDirectory,
        h4eDirectory,
        outputDirectory,
        recorder,
        budget,
        route,
        signal: controller.signal,
      })) as { rows: H6ReplayRow[] }
      assert.equal(replay.rows.length, 12)
      assert.equal(replay.rows[0]?.status, 'timeout')
      assert.equal(budget.snapshot().inFlightCalls, 0)
    } finally {
      await rm(outputParent, { recursive: true, force: true })
    }
  },
)

await test('H6 disposes a completed located composition when cancellation arrives before serialization', async () => {
  const controller = new AbortController()
  const bytes = Uint8Array.of(1, 1, 1)
  let preparedDisposed = false
  let finishCalled = false
  await assert.rejects(
    executeNativeRecipeCase({ case_id: 'mock' }, controller.signal, 10_000, {
      async prepare() {
        return {
          dispose: () => {
            preparedDisposed = true
          },
        }
      },
      async compose() {
        return { status: 'located' as const, mask: { data: bytes } }
      },
      async finish() {
        finishCalled = true
        return 'finished'
      },
      disposeComposition(composition) {
        composition.mask.data.fill(0)
      },
      onTiming(timing) {
        if (timing.compositionElapsedMs !== null)
          controller.abort(new Error('cancel between compose and serialization'))
      },
    }),
    /Operation cancelled/u,
  )
  assert.equal(finishCalled, false)
  assert.equal(preparedDisposed, true)
  assert.deepEqual(bytes, Uint8Array.of(0, 0, 0))
})
