import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import test from 'node:test'
import type { Classifier } from '../src/app/create-classifier.js'
import type { SegmentationPort } from '../src/entities/segmentation.js'
import type { ObjectProposalPort } from '../src/entities/object-proposals.js'
import type { RegionSeededCaseResult } from '../benchmarks/v02/region-seeded-runner.js'
import type { FreshCase, FreshCorpus } from '../benchmarks/v02/fresh-corpus.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'
import {
  assertSemanticPilotCallLimits,
  buildSemanticPilotOrder,
  hashSemanticPilotSourceClosure,
  runSemanticSegmentationPilot,
} from '../benchmarks/v03/run-semantic-segmentation-pilot.js'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function freshCase(index: number, imageSha256: string): FreshCase {
  return {
    caseId: `pilot-v03-test-${String(index + 1).padStart(2, '0')}`,
    image: { path: `${index}.png`, sha256: imageSha256, width: 1, height: 1 },
    locate: { target: 'a test object' },
    classify: { options: ['present', 'absent'] },
  }
}

await test('H2c pair order alternates and keeps each pair complete', () => {
  const cases = Array.from({ length: 4 }, (_, index) => ({ caseId: `case-${index}` }))
  assert.deepEqual(buildSemanticPilotOrder(cases), [
    { caseId: 'case-0', first: 'baseline', second: 'semantic' },
    { caseId: 'case-1', first: 'semantic', second: 'baseline' },
    { caseId: 'case-2', first: 'baseline', second: 'semantic' },
    { caseId: 'case-3', first: 'semantic', second: 'baseline' },
  ])
})

await test('H2c runner rejects any profile/case call count above six', () => {
  const row = {
    classify: { physicalCalls: 1, logicalCalls: 1 },
    extraction: { physicalCalls: 5, logicalCalls: 5 },
  } as RegionSeededCaseResult
  assert.throws(() => assertSemanticPilotCallLimits(row, { physical: 7, logical: 6 }), /call cap/u)
  assert.throws(() => assertSemanticPilotCallLimits(row, { physical: 6, logical: 7 }), /call cap/u)
  assert.throws(() =>
    assertSemanticPilotCallLimits(
      { ...row, extraction: { physicalCalls: 6, logicalCalls: 5 } } as RegionSeededCaseResult,
      { physical: 6, logical: 6 },
    ),
  )
  assert.doesNotThrow(() => assertSemanticPilotCallLimits(row, { physical: 6, logical: 6 }))
})

await test('source closure hashes imports and does not include evaluator truth', async () => {
  const closure = await hashSemanticPilotSourceClosure()
  assert.ok(closure.files.some((file) => file.path.endsWith('run-semantic-segmentation-pilot.ts')))
  assert.ok(closure.files.some((file) => file.path.endsWith('semantic-mask-segmenter.ts')))
  assert.ok(closure.files.some((file) => file.path.endsWith('worker-inference.ts')))
  assert.ok(closure.files.some((file) => file.path === 'package-lock.json'))
  assert.ok(closure.files.some((file) => file.path === 'package.json'))
  assert.ok(closure.files.some((file) => file.path.endsWith('pilot-inputs/photo.json')))
  assert.ok(closure.files.every((file) => !file.path.includes('evaluator-data')))
  assert.equal(closure.sha256, hashCanonical(closure.files))
})

async function runMockedPaidPilot(settleFailure = false) {
  const temporary = await mkdtemp(join(tmpdir(), 'v03-h2c-process-'))
  const imageRoot = join(temporary, 'images')
  const outputRoot = join(temporary, 'runs')
  await (await import('node:fs/promises')).mkdir(imageRoot)
  const cases: FreshCase[] = []
  for (let index = 0; index < 12; index++) {
    const bytes = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: index, g: 5, b: 7, alpha: 1 },
      },
    })
      .png()
      .toBuffer()
    await writeFile(join(imageRoot, `${index}.png`), bytes)
    cases.push(freshCase(index, digest(bytes)))
  }
  const corpus: FreshCorpus = {
    cases,
    imageRoot,
    manifests: [
      { sha256: 'a'.repeat(64), cases: 4 },
      { sha256: 'b'.repeat(64), cases: 4 },
      { sha256: 'c'.repeat(64), cases: 4 },
    ],
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const runnerSource = fileURLToPath(
    new URL('../benchmarks/v03/run-semantic-segmentation-pilot.ts', import.meta.url),
  )
  const callCounts = { classify: 0, baselineSettle: 0, baselineDispose: 0 }
  const emptySegmenter = {
    async segment() {
      return {
        status: 'unknown',
        reason: 'stub',
        metadata: {
          method: 'stub',
          backend: 'stub',
          durationMs: 0,
          input: { width: 1, height: 1 },
        },
      }
    },
    async settle() {},
    async dispose() {},
  } as SegmentationPort
  const proposals = {
    async propose() {
      throw new Error('proposal inference must not run for absent classifications')
    },
    async settle() {},
    async dispose() {},
  } as unknown as ObjectProposalPort
  try {
    const result = await runSemanticSegmentationPilot({
      imageRoot,
      outputRoot,
      encoderPath: 'unused-encoder',
      decoderPath: 'unused-decoder',
      apiKey: 'test-key-never-used',
      allowPaid: true,
      sourceEntries: [runnerSource, join(repoRoot, 'package-lock.json')],
      loadCorpus: async () => corpus,
      verifyAssets: async () => ({
        encoder: { bytes: 1, sha256: 'd'.repeat(64) },
        decoder: { bytes: 1, sha256: 'e'.repeat(64) },
      }),
      createBaseline: async () => ({
        ...emptySegmenter,
        async settle() {
          callCounts.baselineSettle++
          if (settleFailure) throw new Error('stub settle failure')
        },
        async dispose() {
          callCounts.baselineDispose++
        },
      }),
      createProposals: async () => proposals,
      createSemanticWrapper: () => emptySegmenter,
      createClassifier: () =>
        ({
          async classify() {
            callCounts.classify++
            return { choice: 'absent' }
          },
          async locate() {
            throw new Error('absent classification must skip localization')
          },
          async extract() {
            throw new Error('absent classification must skip extraction')
          },
          async dispose() {},
        }) as unknown as Classifier,
    })
    return { result, callCounts }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await test('paired runner lets processRegionSeededCase create the leaf and completes all mocked profiles', async () => {
  const { result, callCounts } = await runMockedPaidPilot()
  assert.equal(result.status, 'complete')
  assert.equal(result.profileResults.baseline?.length, 12)
  assert.equal(result.profileResults.semantic?.length, 12)
  assert.ok(result.profileResults.baseline?.every((row) => row?.classify.value === 'absent'))
  assert.ok(
    result.profileResults.semantic?.every(
      (row) => row?.extraction.reason === 'classification-absent',
    ),
  )
  assert.equal(callCounts.classify, 24)
  assert.equal(callCounts.baselineSettle, 1)
  assert.equal(callCounts.baselineDispose, 1)
  assert.deepEqual(result.cleanupErrors, [])
})

await test('runner fails completion when owned-port cleanup rejects but still attempts disposal', async () => {
  const { result, callCounts } = await runMockedPaidPilot(true)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'CLEANUP_FAILURE')
  assert.ok(result.cleanupErrors.includes('baseline.settle:CLEANUP_FAILURE'))
  assert.equal(callCounts.baselineDispose, 1)
})

await test('dry run checks the frozen twelve-case producer corpus and never invokes paid or native factories', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'v03-h2c-dry-'))
  const imageRoot = join(temporary, 'images')
  const outputRoot = join(temporary, 'runs')
  await (await import('node:fs/promises')).mkdir(imageRoot)
  const cases: FreshCase[] = []
  for (let index = 0; index < 12; index++) {
    const bytes = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: index, g: 5, b: 7, alpha: 1 },
      },
    })
      .png()
      .toBuffer()
    await writeFile(join(imageRoot, `${index}.png`), bytes)
    cases.push(freshCase(index, digest(bytes)))
  }
  const corpus: FreshCorpus = {
    cases,
    imageRoot,
    manifests: [
      { sha256: 'a'.repeat(64), cases: 4 },
      { sha256: 'b'.repeat(64), cases: 4 },
      { sha256: 'c'.repeat(64), cases: 4 },
    ],
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const runnerSource = fileURLToPath(
    new URL('../benchmarks/v03/run-semantic-segmentation-pilot.ts', import.meta.url),
  )
  try {
    const result = await runSemanticSegmentationPilot({
      imageRoot,
      outputRoot,
      encoderPath: 'unused-encoder',
      decoderPath: 'unused-decoder',
      sourceEntries: [runnerSource, join(repoRoot, 'package-lock.json')],
      loadCorpus: async () => corpus,
      verifyAssets: async () => ({
        encoder: { bytes: 1, sha256: 'd'.repeat(64) },
        decoder: { bytes: 1, sha256: 'e'.repeat(64) },
      }),
      createBaseline: async () => {
        throw new Error('dry-run initialized baseline')
      },
      createProposals: async () => {
        throw new Error('dry-run initialized native proposals')
      },
    })
    assert.equal(result.status, 'dry-run-complete')
    assert.equal(result.mode, 'dry-run')
    assert.equal(result.sourceUnchanged, true)
    assert.equal(result.order.length, 12)
    assert.equal(result.order[0]?.first, 'baseline')
    assert.equal(result.order[1]?.first, 'semantic')
    assert.equal(result.profileResults.baseline?.length, 0)
    assert.equal(result.profileBudgets.baseline?.admittedPhysicalCalls, 0)
    assert.equal(result.sourceClosure.length > 0, true)
    assert.equal(
      (await readFile(join(result.outputDirectory, 'run-complete.json'), 'utf8')).includes(
        'dry-run-complete',
      ),
      true,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
