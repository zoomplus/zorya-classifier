import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { z } from 'zod'
import { runBenchmark } from '../benchmarks/runner.js'
import { offlineProvider } from '../benchmarks/recording.js'
import { sha256 } from '../benchmarks/corpus.js'

async function fixtureCorpus(root: string): Promise<void> {
  for (const path of ['inputs', 'ground-truth', 'photos', 'text/inputs', 'text/ground-truth'])
    await mkdir(join(root, path), { recursive: true })
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  await writeFile(join(root, 'photos/fixture.png'), image)
  const photos = Array.from({ length: 20 }, (_, index) => ({
    caseId: `photo-dev-${index + 1}`,
    image: { path: 'photos/fixture.png', sha256: sha256(image), width: 32, height: 32 },
    locate: { target: 'square', instruction: 'fixture' },
    classify: { question: 'Is there a square?', options: ['present', 'absent'] },
  }))
  const truth = photos.map((input) => ({
    caseId: input.caseId,
    expectedPresence: 'present',
    targetBoxes: [{ xyxy: [0, 0, 1, 1] }],
    negativeEvidence: null,
    stratum: 'synthetic-fixture',
    tags: [],
  }))
  const texts = Array.from({ length: 10 }, (_, i) => ({ text: `fixture message ${i}` }))
  const files: Record<string, unknown> = {
    'corpus-manifest.json': { id: 'synthetic-test-only' },
    'photo-manifest.json': {},
    'text/text-manifest.json': {},
    'inputs/dev.json': photos,
    'ground-truth/dev.json': truth,
    'text/inputs/dev.json': texts,
    'text/ground-truth/dev.json': {
      split: 'dev',
      examples: texts.map((input, index) => ({
        input_index: index,
        id: `support-dev-${index + 1}`,
        expected_label: 'one',
        text_sha256: sha256(input.text),
      })),
    },
    'text/inputs/policy.json': {
      task: 'Fixture classification',
      rules: [],
      classes: [
        { id: 'one', definition: 'first' },
        { id: 'two', definition: 'second' },
      ],
    },
  }
  for (const [path, value] of Object.entries(files))
    await writeFile(join(root, path), JSON.stringify(value))
}
await test('runner stops before native baseline and next cases after receipt-only evidence loss', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'classifier-run-stop-')),
    corpus = join(temporary, 'corpus'),
    output = join(temporary, 'run')
  let dispatched = 0
  try {
    await fixtureCorpus(corpus)
    const fixture = offlineProvider()
    const result = await runBenchmark(
      {
        mode: 'offline',
        allowPaid: false,
        maxCalls: 20,
        maxCostUsd: 1,
        corpusDirectory: corpus,
        outputDirectory: output,
        splits: ['dev'],
        limit: 2,
      },
      {
        async decide(request, signal) {
          dispatched++
          // Corrupt only the impending receipt write, after a successful provider invocation.
          await writeFile(
            join(output, 'dev/photo-dev-1/classify-library/call-1/receipt.json'),
            'do not overwrite',
            { flag: 'wx' },
          )
          return fixture.decide(request, signal)
        },
      },
    )
    assert.equal(dispatched, 1)
    assert.equal(result.status, 'incomplete')
    const report = z
      .object({
        status: z.literal('incomplete'),
        physicalHttpCalls: z.literal(0),
        unstartedCases: z.literal(3),
        reason: z.object({ code: z.literal('BENCHMARK_ARTIFACT_FAILURE') }),
        samples: z
          .array(
            z.object({ library: z.object({ outcome: z.object({ status: z.literal('failed') }) }) }),
          )
          .length(1),
        budget: z.object({ inFlightCalls: z.literal(0) }),
      })
      .parse(JSON.parse(await readFile(result.reportPath, 'utf8')) as unknown)
    assert.equal(report.reason.code, 'BENCHMARK_ARTIFACT_FAILURE')
    await assert.rejects(access(join(output, 'dev/photo-dev-1/classify-native')))
    await assert.rejects(access(join(output, 'dev/photo-dev-2')))
    assert.equal(
      await readFile(join(output, 'dev/photo-dev-1/classify-library/call-1/receipt.json'), 'utf8'),
      'do not overwrite',
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
await test('controlled fixture neighbor cannot run under a live evidence label', async () => {
  await assert.rejects(
    runBenchmark(
      {
        mode: 'live',
        allowPaid: true,
        maxCalls: 1,
        maxCostUsd: 1,
        corpusDirectory: '/unused',
        outputDirectory: '/unused',
        splits: ['dev'],
      },
      offlineProvider(),
    ),
    /fixture-only/u,
  )
})
