import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { DecisionRequest } from '../../src/entities/contracts.js'
import { createOpenRouterDecisions } from '../../src/openrouter.js'
import { RunBudget } from '../v02/budget.js'
import { recordProvider } from '../v02/recording.js'
import { GROUNDED_MASK_MODEL, runGroundedMaskPilot } from './run-grounded-mask-pilot.js'

// Local artifact replay: ZORYA_V03_DATA_ROOT=/root/work/zorya-classifier PATH=/root/.nvm/versions/node/v24.12.0/bin:$PATH ./node_modules/.bin/tsx --test benchmarks/v03/grounded-mask-replay-local.test.ts
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

for (const scenario of [
  { profile: 'h3b', verdict: 'complete', complete: true },
  { profile: 'h3c', verdict: 'match-complete-pure', complete: true },
  { profile: 'h3c', verdict: 'wrong-object-or-contaminated', complete: false },
] as const) {
  await test(`grounded mask pilot mock-fetch E2E ${scenario.profile}/${scenario.verdict} preserves output semantics`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'zorya-h3b-e2e-'))
    const outputDirectory = join(temporary, 'run')
    const budget = new RunBudget(24, 2, 0.05)
    const wireBodies: string[] = []
    let calls = 0
    const mockFetch: typeof globalThis.fetch = async (_url, init) => {
      calls++
      await stat(join(outputDirectory, 'freeze.json'))
      const raw = String(init?.body ?? '')
      wireBodies.push(raw)
      const request = JSON.parse(raw) as DecisionRequest & { model: string }
      const verifierKey = scenario.profile === 'h3c' ? 'verification' : 'box_check'
      const question = request.questions.selection ?? request.questions[verifierKey]
      assert.ok(question?.type === 'choice')
      const keys = Object.keys(question.criteria)
      const winner =
        calls === 1 ? (keys.find((key) => key.startsWith('C')) ?? 'none') : scenario.verdict
      const probabilities = Object.fromEntries(keys.map((key) => [key, Number(key === winner)]))
      return new Response(
        JSON.stringify({
          model: GROUNDED_MASK_MODEL,
          answers: {
            [calls === 1 ? 'selection' : verifierKey]: {
              type: 'choice',
              choice: winner,
              probabilities,
            },
          },
          usage: { input_tokens: 20, output_tokens: 2, cost: 0.001 },
          id: `mock-${calls}`,
          provider: 'OpenAI',
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    const recorder = recordProvider(
      (fetcher) =>
        createOpenRouterDecisions({
          apiKey: 'test-only-not-a-secret',
          model: GROUNDED_MASK_MODEL,
          provider: 'openai',
          providerName: 'OpenAI',
          fetch: fetcher,
        }),
      budget,
      join(outputDirectory, 'provider-calls'),
      {
        model: GROUNDED_MASK_MODEL,
        provider: 'openai',
        providerName: 'OpenAI',
        apiEndpoint: '/api/alpha/decisions',
        allowFallbacks: false,
      },
      mockFetch,
    )

    try {
      const result = await runGroundedMaskPilot({
        repositoryRoot,
        dataRoot: process.env.ZORYA_V03_DATA_ROOT ?? repositoryRoot,
        outputDirectory,
        dispatch: true,
        decision: recorder.port,
        recorder,
        budget,
        caseLimit: 1,
        verificationProfile: scenario.profile,
      })
      assert.equal(calls, 2)
      assert.equal(result.rows.length, 1)
      assert.equal(result.rows[0]?.status, scenario.complete ? 'complete' : 'unknown')
      assert.match(result.rows[0]?.selectedAlias ?? '', /^C\d{2}$/u)
      assert.equal(result.rows[0]?.physicalCallCount, 2)
      assert.ok(result.rows[0]?.files.mask)
      assert.equal(Boolean(result.rows[0]?.files.cutout), scenario.complete)
      const maskBytes = await readFile(join(outputDirectory, result.rows[0]!.files.mask!))
      assert.equal(
        result.rows[0]?.files.maskSha256,
        createHash('sha256').update(maskBytes).digest('hex'),
      )
      if (scenario.complete) {
        const cutoutBytes = await readFile(join(outputDirectory, result.rows[0]!.files.cutout!))
        assert.equal(
          result.rows[0]?.files.cutoutSha256,
          createHash('sha256').update(cutoutBytes).digest('hex'),
        )
      } else {
        assert.equal(result.rows[0]?.files.cutoutSha256, null)
      }
      assert.equal(recorder.calls.length, 2)
      assert.equal(budget.snapshot().admittedPhysicalCalls, 2)
      assert.equal(wireBodies.length, 2)
      for (const body of wireBodies) {
        assert.equal(body.includes('pilot-v03-'), false)
        assert.equal(body.includes('/root/work/'), false)
        assert.equal(body.includes('71b99532e14abb6098a704e9bd9c2c50'), false)
        assert.equal(body.includes('allow_fallbacks":false'), true)
      }
      const files = await readdir(outputDirectory)
      assert.ok(files.some((file) => file.endsWith('-mask.png')))
      assert.equal(
        files.some((file) => file.endsWith('-cutout.png')),
        scenario.complete,
      )
      const run = JSON.parse(await readFile(result.runPath, 'utf8')) as {
        status: string
        rows: unknown[]
      }
      assert.equal(run.status, 'incomplete')
      assert.equal(run.rows.length, 1)
      assert.deepEqual(run.rows[0], result.rows[0])
      const freeze = JSON.parse(await readFile(join(outputDirectory, 'freeze.json'), 'utf8')) as {
        nativeArtifacts: unknown[]
        producerClosure: { files: unknown[] }
      }
      assert.ok(freeze.nativeArtifacts.length >= 100)
      assert.ok(freeze.producerClosure.files.length > 10)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
