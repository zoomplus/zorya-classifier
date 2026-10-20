import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { createClassifier } from '../src/app/create-classifier.js'
import type { DecisionPort } from '../src/entities/contracts.js'
import type { SegmentationPort } from '../src/entities/segmentation.js'
import { createOpenRouterDecisions } from '../src/infrastructure/openrouter.js'
import { createNativeCategoricalPresencePort } from '../benchmarks/v02/native-categorical-presence-port.js'
import { RunBudget } from '../benchmarks/v02/budget.js'
import { evaluateRegionSeededRun } from '../benchmarks/v02/evaluate-region-seeded.js'
import { recordProvider } from '../benchmarks/v02/recording.js'
import { processRegionSeededCase } from '../benchmarks/v02/region-seeded-runner.js'
import type { PhysicalCallRecord } from '../benchmarks/v02/recording.js'
import { createRegionSeededEvaluatorFixture } from './fixtures/region-seeded-evaluation.js'

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

await test('actual public producer row and receipts normalize through the independent evaluator', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'region-seeded-producer-evaluator-'))
  const fixture = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
    checkedRegion: true,
  })
  t.after(async () => rm(directory, { recursive: true, force: true }))

  const caseId = fixture.ids[0]!
  const image = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 80, g: 120, b: 160 } },
  })
    .jpeg()
    .toBuffer()
  const imageHash = sha256(image)
  const imagePath = join(fixture.options.corpus.imageRoot, `${caseId}.jpg`)
  await writeFile(imagePath, image)
  const inputManifestPath = fixture.options.corpus.manifests[0]!.path
  const inputRows = JSON.parse(await readFile(inputManifestPath, 'utf8')) as Array<{
    caseId: string
    image: { path: string; sha256: string; width: number; height: number }
    locate: { target: string }
    classify: { question?: string; options: ['present', 'absent'] }
  }>
  inputRows[0]!.image = { path: `${caseId}.jpg`, sha256: imageHash, width: 10, height: 10 }
  await writeFile(inputManifestPath, JSON.stringify(inputRows))
  fixture.options.corpus.manifests[0]!.sha256 = sha256(await readFile(inputManifestPath))
  const runManifest = JSON.parse(await readFile(fixture.options.runManifest.path, 'utf8')) as {
    manifests: Array<{ sha256: string; cases: number }>
  }
  runManifest.manifests[0]!.sha256 = fixture.options.corpus.manifests[0]!.sha256
  await writeFile(fixture.options.runManifest.path, JSON.stringify(runManifest))
  fixture.options.runManifest.sha256 = sha256(await readFile(fixture.options.runManifest.path))

  const item = inputRows[0]!
  const caseDirectory = join(fixture.options.runDirectory, caseId)
  await rm(caseDirectory, { recursive: true, force: true })
  const route = {
    model: 'fixture-model',
    provider: 'fixture',
    providerName: 'Fixture',
    apiEndpoint: '/fixture',
    allowFallbacks: false as const,
  }
  const budget = new RunBudget(250, 5, 0.05, 'dev')
  let fetchCalls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    fetchCalls++
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<
        string,
        { type: string; criteria?: Record<string, string>; instructions?: string }
      >
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => {
        assert.equal(question.type, 'choice')
        const keys = Object.keys(question.criteria ?? {})
        assert.ok(keys.length >= 2, `question ${id} has closed criteria`)
        const choice = keys[0]!
        return [
          id,
          {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
          },
        ]
      }),
    )
    return new Response(
      JSON.stringify({
        model: 'fixture-model',
        provider: 'Fixture',
        id: `offline-${fetchCalls}`,
        answers,
        usage: { cost: 0.0001 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const recorder = recordProvider(
    (trackedFetch) =>
      createOpenRouterDecisions({
        apiKey: 'dummy-offline-fixture-key',
        model: route.model,
        provider: route.provider,
        providerName: route.providerName,
        fetch: trackedFetch,
      }),
    budget,
    join(caseDirectory, 'calls'),
    route,
    fetcher,
  )
  const decision: DecisionPort = createNativeCategoricalPresencePort(recorder.port)
  const rgba = await sharp(image).ensureAlpha().raw().toBuffer()
  const segmentation: SegmentationPort = {
    async segment(input) {
      assert.equal(input.prompt, 'seed-region')
      assert.equal(input.image.width, 10)
      assert.equal(input.image.height, 10)
      assert.equal(input.image.data.byteLength, rgba.byteLength)
      assert.equal(Buffer.compare(Buffer.from(input.image.data), rgba), 0)
      const data = new Uint8Array(input.image.width * input.image.height)
      data.fill(1)
      return {
        status: 'segmented',
        mask: { data, width: input.image.width, height: input.image.height, format: 'binary-u8' },
        metadata: {
          method: 'fixture-mobile-sam',
          backend: 'mobile-sam',
          durationMs: 1,
          input: { width: input.image.width, height: input.image.height },
        },
      }
    },
    async settle() {},
    async dispose() {},
  }

  const actual = await processRegionSeededCase({
    item,
    root: fixture.options.corpus.imageRoot,
    caseDirectory,
    classifierFactory: (options) => createClassifier(options),
    decision,
    segmentation,
    variant: 'region-seeded-sam',
    requireClassifiedPresence: true,
    checkedRegion: true,
    recorder,
    signal: new AbortController().signal,
  })
  rgba.fill(0)

  assert.equal(actual.classify.status, 'ok')
  assert.equal(actual.classify.value, 'present')
  assert.equal(actual.extraction.status, 'extracted', JSON.stringify(actual))
  assert.equal(actual.extraction.seed.status, 'located')
  assert.ok(actual.extraction.boxChecks?.some((attempt) => attempt.status === 'ok'))
  assert.equal(
    actual.extraction.verification?.checks.length,
    actual.extraction.boxChecks?.filter((attempt) => attempt.status === 'ok').length,
  )
  assert.equal(fetchCalls, recorder.calls.length)
  assert.equal(fetchCalls, actual.classify.physicalCalls + actual.extraction.physicalCalls)

  fixture.results[0] = actual
  fixture.summary.results = fixture.results
  fixture.summary.physicalReceipts = recorder.calls.map((call) => physicalSummary(call, caseId))
  const snapshot = budget.snapshot()
  fixture.summary.aggregate = {
    admittedPhysicalCalls: snapshot.admittedPhysicalCalls,
    knownCostUsd: snapshot.knownCostUsd,
    unknownCostCalls: snapshot.unknownCostCalls,
    inFlightCalls: snapshot.inFlightCalls,
    accountedExposureUsd: snapshot.accountedExposureUsd,
    maxPhysicalCalls: 250,
    maxCostUsd: 5,
  }
  const pins = await fixture.refreshSummaryAndSeal()
  fixture.options.summary = pins.summary
  fixture.options.completionSeal = pins.completionSeal

  const report = await evaluateRegionSeededRun(fixture.options, new AbortController().signal)
  assert.equal(report.schema, 'region-seeded-independent-evaluation-v3')
  assert.equal(report.complete, true)
  assert.equal(report.physical.count, recorder.calls.length)
  assert.equal(report.rows.find((row) => row.caseId === caseId)?.extractionStatus, 'extracted')
})

function physicalSummary(call: PhysicalCallRecord, caseId: string) {
  if (call.httpStatus !== 200 || !call.receipt || !call.wireReceipt)
    throw new Error('Offline producer fixture expected a completed, receipted fake fetch')
  return {
    caseId,
    physicalId: call.physicalId,
    logicalId: call.logicalId,
    requestSha256: call.requestSha256,
    requestBodySha256: call.requestBodySha256,
    admittedAt: call.admittedAt,
    durationMs: call.durationMs,
    httpStatus: call.httpStatus,
    route: call.route,
    receipt: call.receipt ? { costUsd: call.receipt.costUsd } : null,
    wireReceipt: call.wireReceipt ? { usageCostUsd: call.wireReceipt.usageCostUsd } : null,
    errorCode: call.errorCode ?? null,
  }
}
