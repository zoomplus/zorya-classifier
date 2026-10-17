import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { createClassifier } from '../src/index.js'
import type { ClassificationResult, LocalizationResult } from '../src/index.js'
import { createOpenRouterVision, createOpenRouterDecisions } from '../src/openrouter.js'
import type { OpenRouterVisionOptions } from '../src/openrouter.js'
import { readResponse } from '../src/infrastructure/openrouter-common.js'
import { BenchmarkBudget, BudgetExhausted } from './budget.js'
import { loadCorpus, photoBytes, sha256 } from './corpus.js'
import type { PhotoCase, TextCase } from './corpus.js'
import { ArtifactWriteError, failure, recordProvider, writeJson } from './recording.js'

interface Route {
  id: string
  model: string
  provider: string
  providerName: string
  inputPerMillion: number
  outputPerMillion: number
}
const routes: Route[] = [
  {
    id: 'nex',
    model: 'nex-agi/nex-n2.5-mini',
    provider: 'nex-agi/bf16',
    providerName: 'Nex AGI',
    inputPerMillion: 0.025,
    outputPerMillion: 0.1,
  },
  {
    id: 'qwen',
    model: 'qwen/qwen3.7-flash',
    provider: 'alibaba',
    providerName: 'Alibaba',
    inputPerMillion: 0.03,
    outputPerMillion: 0.13,
  },
  {
    id: 'luna',
    model: 'openai/gpt-6-luna',
    provider: 'openai',
    providerName: 'OpenAI',
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
  },
]
const classes = [
  {
    id: 'present',
    description:
      'The photograph contains at least one visible physical instance of the named object.',
  },
  {
    id: 'absent',
    description: 'The photograph contains no visible physical instance of the named object.',
  },
]
interface Row {
  route: string
  caseId: string
  split: string
  kind: 'photo' | 'text' | 'locate'
  durationMs: number
  correct?: boolean
  expected?: string
  result?: ClassificationResult | LocalizationResult
  error?: ReturnType<typeof failure>
}
async function hashes(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { withFileTypes: true }),
    output: Record<string, string> = {}
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) Object.assign(output, await hashes(path))
    else if (entry.name.endsWith('.ts'))
      output[path.replaceAll('\\', '/')] = sha256(await readFile(path))
  }
  return output
}
async function completedBudget(directory: string) {
  const raw = await readFile('.run/decisions-selection-v1/report.json', 'utf8')
  const previous = z
    .object({
      aggregatePhysicalCalls: z.literal(288),
      budget: z.object({
        admittedProviderCalls: z.literal(288),
        knownCostUsd: z.number().finite().nonnegative(),
        unknownCostCalls: z.literal(8),
        inFlightCalls: z.literal(0),
      }),
    })
    .parse(JSON.parse(raw))
  const seed = { ...previous.budget, unknownCostCalls: Number(previous.budget.unknownCostCalls) }
  const reconciled: { path: string; sha256: string; costUsd: number }[] = []
  const invalidCases = [
    ['vision-selection-v1', 'qwen', 'photo', 'photo-dev-01'],
    ['vision-selection-v1', 'qwen', 'photo', 'photo-dev-17'],
    ['vision-selection-v1', 'qwen', 'photo', 'photo-heldout-09'],
    ['vision-selection-v2', 'haiku', 'photo', 'photo-dev-16'],
    ['vision-selection-v2', 'haiku', 'text', 'support-heldout-016'],
  ] as const
  for (const parts of invalidCases) {
    const path = join('.run', ...parts, 'wire-response-1.json'),
      raw = await readFile(path, 'utf8')
    const wire = z
      .object({ usage: z.object({ cost: z.number().finite().nonnegative() }) })
      .parse(JSON.parse(raw))
    seed.knownCostUsd += wire.usage.cost
    seed.unknownCostCalls--
    reconciled.push({ path, sha256: sha256(raw), costUsd: wire.usage.cost })
  }
  const budget = new BenchmarkBudget(1000, 0.5, 0.05, seed)
  const prior = { sha256: sha256(raw), physicalCalls: 288, budget: budget.snapshot() }
  await writeJson(join(directory, 'cost-reconciliation.json'), {
    priorReportSha256: sha256(raw),
    reconciled,
    seed,
    note: 'Billing metadata only; failed classifications remain failures. Two auth errors and one provider error still retain unknown-cost reservations.',
  })
  return { budget, prior }
}

async function main() {
  if (!process.argv.includes('--allow-paid'))
    throw new Error(
      'Explicit --allow-paid is required; each fixed comparison mode enforces its call cap and a $0.50 aggregate ceiling',
    )
  const freshNative = process.argv.includes('--fresh-native')
  const completion = process.argv.includes('--complete-native')
  const extension = process.argv.includes('--extension') || completion || freshNative
  const native = process.argv.includes('--decisions') || completion || freshNative
  if (native && !extension)
    throw new Error('Native continuation must include the previous comparison budget')
  const runRoutes: Route[] = native
    ? [
        {
          id: 'luna-decisions',
          model: 'openai/gpt-6-luna-decisions',
          provider: 'openai',
          providerName: 'OpenAI',
          inputPerMillion: 0.1,
          outputPerMillion: 0,
        },
      ]
    : extension
      ? [
          {
            id: 'haiku',
            model: 'anthropic/claude-haiku-5.5',
            provider: 'anthropic',
            providerName: 'Anthropic',
            inputPerMillion: 0.1,
            outputPerMillion: 0.5,
          },
        ]
      : routes
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY outside source')
  const credential = apiKey
  const outIndex = process.argv.indexOf('--out'),
    relative = outIndex < 0 ? '.run/vision-selection-v1' : process.argv[outIndex + 1]
  if (!relative || !/^\.run\/[a-zA-Z0-9._-]+$/u.test(relative))
    throw new Error('Output must be a new .run/name directory')
  const directory = resolve(relative),
    corpusRoot = resolve('benchmarks/corpus')
  await mkdir(directory)
  const corpus = await loadCorpus(corpusRoot, ['dev', 'heldout'])
  const screen = corpus.photos.filter((photo) => photo.split === 'dev').slice(0, 10)
  const continuation = completion ? await completedBudget(directory) : undefined
  const budget =
    continuation?.budget ?? new BenchmarkBudget(freshNative ? 93 : extension ? 290 : 200, 0.5, 0.05)
  let prior:
    | { sha256: string; physicalCalls: number; budget: ReturnType<BenchmarkBudget['snapshot']> }
    | undefined = continuation?.prior
  if (extension && !completion && !freshNative) {
    const reports = native
      ? ([
          ['vision-selection-v1', 190],
          ['vision-selection-v2', 46],
        ] as const)
      : ([['vision-selection-v1', 190]] as const)
    const pins: { run: string; sha256: string }[] = []
    let priorCalls = 0
    for (const [run, count] of reports) {
      const raw = await readFile(`.run/${run}/report.json`, 'utf8')
      const report = z
        .object({
          status: z.literal('complete'),
          physicalCalls: z.number().int(),
          rows: z.array(
            z.object({
              result: z
                .object({
                  metadata: z.object({ costUsd: z.number().finite().nonnegative().nullable() }),
                })
                .optional(),
            }),
          ),
        })
        .parse(JSON.parse(raw))
      if (report.physicalCalls !== count || report.rows.length !== count)
        throw new Error('Prior paid budget does not match the approved continuation')
      for (const row of report.rows)
        budget.settle(budget.reserve(), row.result?.metadata.costUsd ?? null)
      priorCalls += count
      pins.push({ run, sha256: sha256(raw) })
    }
    prior = {
      sha256: sha256(JSON.stringify(pins)),
      physicalCalls: priorCalls,
      budget: budget.snapshot(),
    }
    await writeJson(join(directory, 'prior-reports.json'), pins)
  }

  const rows: Row[] = []
  const startedAt = new Date().toISOString()
  let physicalCalls = 0
  const originalPolicy =
    'Screen all three routes on first 10 fixed development photos. Keep Luna as quality anchor and the better cheap route (screen correct count, then published input+0.15output price). Complete remaining 50 photos and 30 texts on each finalist. Choose cheapest measured photo+text route meeting >=55/60 photos, >=37/40 heldout, 30/30 texts, zero errors. No heldout prompt tuning. Then up to three fixed-stratum locator smoke cases on the chosen route. Max199 planned generations, one spare; no retries. Two consecutive errors stop that candidate batch; unstarted cases remain unverified and cannot qualify.'
  const policy = freshNative
    ? 'Independent fresh Luna Decisions run:60 photos and30 authored texts, followed by one fixed positive locator smoke if the classifier meets>=55/60 photos,>=37/40 heldout,30/30 texts and zero errors. At most93 physical calls and $0.50, no retries; preserve all failures/unstarted cases.'
    : completion
      ? 'Complete the missing20 development photos and20 heldout texts for the same frozen Luna Decisions classifier; earlier40 heldout photos and10 development texts are retained, never replayed or repaired. No inference/prompt changes. At most40 new classification calls under expanded1000 aggregate request limit and unchanged $0.50 cap. No retries. Preserve previous locator provider error.'
      : native
        ? 'Owner prioritizes Luna Decisions over Jev/chat models. Run all40 fixed heldout photos and10 fixed development text fixtures plus one positive three-stage locator smoke. At most53 new calls, aggregate289/290 with previous236 calls and reservations retained. This is a40-photo/10-text bounded test, not full60-photo qualification. Use native typed Choice/Noul, original distributions, no chat parsing. No retries; two consecutive errors stop a batch. No per-case prompt changes.'
        : extension
          ? 'One fixed additional ordinary vision route, 60 photos and 30 text cases with single-winner protocol; threshold >=55/60 photos, >=37/40 heldout, 30/30 texts, zero errors and known cost. No per-case prompt tuning. Then three fixed-stratum locator smoke cases. Maximum99 new calls, aggregate289 planned/290 allowed with previous190 calls and unknown-cost reservations retained. No retries; two consecutive errors stop a batch, unstarted cases are unverified.'
          : originalPolicy
  await writeJson(join(directory, 'manifest.json'), {
    startedAt,
    authorization: freshNative
      ? 'Operator explicitly opted into a fresh run with up to93 calls and $0.50; no prior run budget is imported'
      : completion
        ? 'User authorized up to1000 aggregate test requests, keeping the existing $0.50 ceiling; prior288 calls and reconciled unknown costs included'
        : extension
          ? 'User expanded this comparison to 290 aggregate calls and $0.50 total; prior190 calls included'
          : 'User approved up to 200 additional provider requests and $0.50; licensed public corpus only',
    routes: runRoutes,
    prior: prior ?? null,
    protocol: native
      ? 'native-choice-v1: exact criteria and raw distributions; no chat rank protocol'
      : 'ranking-size-v2: classify/final one; spatial beam four',
    policy,
    screen: screen.map((v) => v.caseId),
    sourceHashes: await hashes('src'),
    harnessHashes: await hashes('benchmarks'),
    corpus: corpus.manifests,
    perCallReservationUsd: 0.05,
    reasoningEffort: native ? null : 'none',
    responseFormat: native ? null : 'prompt',
    timeoutMs: 45000,
  })
  async function execute(route: Route, input: PhotoCase | TextCase, kind: Row['kind']) {
    const caseDir = join(directory, route.id, kind, input.caseId)
    await mkdir(caseDir, { recursive: true })
    const started = performance.now()
    let wireCall = 0
    const fetcher: typeof globalThis.fetch = async (url, init) => {
      const call = ++wireCall
      const body = typeof init?.body === 'string' ? init.body : ''
      try {
        await writeJson(join(caseDir, `wire-request-${call}.json`), {
          url: String(url),
          body: JSON.parse(body) as unknown,
          sha256: sha256(body),
        })
      } catch {
        throw new ArtifactWriteError('request')
      }
      physicalCalls++
      const response = await globalThis.fetch(url, init)
      const signal = init?.signal
      if (!signal) throw new Error('Benchmark fetch requires deadline signal')
      const raw = await readResponse(
        new Response(response.body, { status: 200, headers: response.headers }),
        signal,
        1024 * 1024,
      )
      try {
        await writeFile(
          join(caseDir, `wire-response-${call}.json`),
          raw.replaceAll(credential, '[REDACTED]'),
          { flag: 'wx' },
        )
      } catch {
        throw new ArtifactWriteError('receipt')
      }
      await writeJson(join(caseDir, `wire-status-${call}.json`), {
        status: response.status,
        sha256: sha256(raw),
      })
      return new Response(raw, { status: response.status, headers: response.headers })
    }
    const options: OpenRouterVisionOptions = {
      apiKey: credential,
      model: route.model,
      provider: route.provider,
      providerName: route.providerName,
      reasoningEffort: 'none',
      fetch: fetcher,
    }
    const provider = native
      ? createOpenRouterDecisions({
          apiKey: credential,
          model: route.model,
          provider: route.provider,
          providerName: route.providerName,
          fetch: fetcher,
        })
      : createOpenRouterVision(options)
    const recorder = recordProvider(provider, budget, caseDir, started, {
      model: route.model,
      provider: route.provider,
      allowFallbacks: false,
    })
    const client = createClassifier({ decision: recorder.port, timeoutMs: 45000 })
    const row: Row = {
      route: route.id,
      caseId: input.caseId,
      split: input.split,
      kind,
      durationMs: 0,
    }
    let fatal: unknown
    try {
      if ('image' in input) {
        const image = await photoBytes(corpusRoot, input)
        if (kind === 'locate')
          row.result = await client.locate({ image, target: input.locate.target })
        else
          row.result = await client.classify({
            input: { image, text: input.classify.question },
            classes,
          })
      } else
        row.result = await client.classify({
          input: input.text,
          classes: corpus.policy.classes.map((v) => ({
            id: v.id,
            description: v.definition.slice(0, 300),
          })),
          instructions: [corpus.policy.task, ...corpus.policy.rules].join('\n'),
        })
    } catch (error) {
      row.error = failure(error)
      if (
        error instanceof BudgetExhausted ||
        error instanceof ArtifactWriteError ||
        recorder.calls.some((c) => c.artifactFailure)
      )
        fatal = error
    } finally {
      await client.dispose()
      row.durationMs = performance.now() - started
    }
    if (kind !== 'locate') {
      const expected =
        'image' in input
          ? corpus.photoTruth.get(input.caseId)?.expectedPresence
          : corpus.textTruth.get(input.caseId)?.expected
      if (!expected) throw new Error('Missing validated ground truth')
      row.expected = expected
      row.correct =
        row.result !== undefined && 'choice' in row.result && row.result.choice === row.expected
    }
    rows.push(row)
    await writeJson(join(caseDir, 'result.json'), row)
    await writeFile(
      join(directory, 'progress.json'),
      JSON.stringify({ rows, budget: budget.snapshot(), physicalCalls }, null, 2) + '\n',
    )
    console.log(
      JSON.stringify({
        route: route.id,
        caseId: input.caseId,
        kind,
        correct: row.correct,
        error: row.error?.code,
        status: row.result && 'status' in row.result ? row.result.status : undefined,
        ms: Math.round(row.durationMs),
        budget: budget.snapshot(),
      }),
    )
    if (fatal) throw fatal
  }
  async function batch(route: Route, inputs: readonly (PhotoCase | TextCase)[], kind: Row['kind']) {
    let consecutiveFailures = 0
    for (const input of inputs) {
      await execute(route, input, kind)
      consecutiveFailures = rows.at(-1)?.error ? consecutiveFailures + 1 : 0
      if (consecutiveFailures >= 2) break
    }
  }
  function summary(route: Route) {
    const data = rows.filter((row) => row.route === route.id),
      photos = data.filter((row) => row.kind === 'photo'),
      texts = data.filter((row) => row.kind === 'text')
    const costs = data.flatMap((row) =>
      row.result &&
      'metadata' in row.result &&
      'costUsd' in row.result.metadata &&
      row.result.metadata.costUsd !== null
        ? [row.result.metadata.costUsd]
        : [],
    )
    return {
      route: route.id,
      model: route.model,
      provider: route.provider,
      photos: photos.length,
      photoCorrect: photos.filter((row) => row.correct).length,
      heldout: photos.filter((row) => row.split === 'heldout').length,
      heldoutCorrect: photos.filter((row) => row.split === 'heldout' && row.correct).length,
      texts: texts.length,
      textCorrect: texts.filter((row) => row.correct).length,
      errors: data.filter((row) => row.error).length,
      knownCostUsd: costs.reduce((a, b) => a + b, 0),
      knownCostCount: costs.length,
      priceIndex: route.inputPerMillion + 0.15 * route.outputPerMillion,
    }
  }
  let status = 'complete',
    stopped: ReturnType<typeof failure> | undefined
  let finalists: Route[] = [],
    selected: Route | undefined
  try {
    if (extension) {
      finalists = runRoutes
      for (const route of finalists) {
        await batch(
          route,
          native && !freshNative
            ? corpus.photos.filter((v) => v.split === (completion ? 'dev' : 'heldout'))
            : corpus.photos,
          'photo',
        )
        await batch(
          route,
          native && !freshNative
            ? corpus.texts.filter((v) => v.split === (completion ? 'heldout' : 'dev'))
            : corpus.texts,
          'text',
        )
      }
    } else {
      for (const route of runRoutes) await batch(route, screen, 'photo')
      const cheap = routes
        .filter((route) => route.id !== 'luna')
        .sort(
          (a, b) =>
            summary(b).photoCorrect - summary(a).photoCorrect ||
            summary(a).errors - summary(b).errors ||
            summary(a).priceIndex - summary(b).priceIndex,
        )[0]
      const anchor = routes.find((route) => route.id === 'luna')
      if (!cheap || !anchor) throw new Error('Missing fixed selection routes')
      finalists = [cheap, anchor]
      await writeJson(join(directory, 'selection-after-dev.json'), {
        policy,
        screenSummary: routes.map(summary),
        finalists: finalists.map((route) => route.id),
      })
      for (const route of finalists) {
        await batch(
          route,
          corpus.photos.filter((photo) => !screen.some((v) => v.caseId === photo.caseId)),
          'photo',
        )
        await batch(route, corpus.texts, 'text')
      }
    }
    const qualified = finalists.filter((route) => {
      const s = summary(route)
      return (
        s.photos === (native && !freshNative ? 40 : 60) &&
        s.photoCorrect >= (native && !freshNative ? 37 : 55) &&
        s.heldoutCorrect >= 37 &&
        s.texts === (native && !freshNative ? 10 : 30) &&
        s.textCorrect === (native && !freshNative ? 10 : 30) &&
        s.errors === 0 &&
        s.knownCostCount === (native && !freshNative ? 50 : 90)
      )
    })
    selected = qualified.sort(
      (a, b) =>
        summary(a).knownCostUsd - summary(b).knownCostUsd ||
        summary(a).priceIndex - summary(b).priceIndex,
    )[0]
    if (selected && !completion) {
      const cases = (native ? ['baseline'] : ['baseline', 'negative', 'edge'])
        .map((stratum) =>
          corpus.photos.find(
            (photo) =>
              photo.split === 'dev' && corpus.photoTruth.get(photo.caseId)?.stratum === stratum,
          ),
        )
        .filter((v): v is PhotoCase => v !== undefined)
      await batch(selected, cases, 'locate')
    }
  } catch (error) {
    status = 'stopped'
    stopped = failure(error)
  }
  await writeJson(join(directory, 'report.json'), {
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    policy,
    finalists: finalists.map((route) => route.id),
    selected: selected?.id ?? null,
    summaries: runRoutes.map(summary),
    physicalCalls,
    aggregatePhysicalCalls: physicalCalls + (prior?.physicalCalls ?? 0),
    prior: prior ?? null,
    protocol: native
      ? 'native-choice-v1: exact criteria and raw distributions; no chat rank protocol'
      : 'ranking-size-v2: classify/final one; spatial beam four',
    budget: budget.snapshot(),
    stopped: stopped ?? null,
    rows,
    limitations: [
      'Public images can overlap model training',
      'Authored text fixtures are not customer traffic',
      'No accuracy guarantees outside this corpus',
      'Initial run evaluates two finalists; extension evaluates one fixed route; protocol variants are not paired comparisons',
      'Locator cases are integration smoke, not full localization quality',
      'Local cost reservations are not an account-side spending cap',
    ],
  })
  if (status !== 'complete') process.exitCode = 1
}
main().catch(() => {
  console.error('Model selection failed; inspect retained local run artifacts')
  process.exitCode = 1
})
