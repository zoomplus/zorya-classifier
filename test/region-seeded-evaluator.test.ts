import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  compareRegionSeededPhotoSeeds,
  evaluateRegionSeededRun,
  measureSeedRegion,
} from '../benchmarks/v02/evaluate-region-seeded.js'
import { createRegionSeededEvaluatorFixture } from './fixtures/region-seeded-evaluation.js'

const signal = new AbortController().signal

function digest(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

await test('seed-region box overlap counts edge fragments as a coarse proxy, never whole-object success', () => {
  const seed = {
    status: 'located' as const,
    region: { left: 2, top: 4, width: 2, height: 2 },
    sourceWidth: 100,
    sourceHeight: 100,
    durationMs: 1,
    physicalCalls: 0,
    logicalCalls: 0,
    requestHashes: [],
  }
  const target = { left: 3.5, top: 5.5, width: 20, height: 20 }
  const result = measureSeedRegion(seed, 'present', [target], 100, 100)
  assert.equal(result.boxOverlap, true)
  assert.equal(result.centerInsideReferenceBox, false)
  assert.deepEqual(result.seedRegion, seed.region)
  assert.equal('matched' in result, false)
  const absent = measureSeedRegion(seed, 'absent', [target], 100, 100)
  assert.equal(absent.boxOverlap, true)
  assert.equal(absent.positiveBoxIntersection, false)
  assert.equal(absent.located, true)
})

await test('v3 checked-region candidate reports check verdicts without changing box or mask scoring', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-checked-v3-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      checkedRegion: true,
    })
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.schema, 'region-seeded-independent-evaluation-v3')
    assert.equal(report.denominator, 40)
    assert.equal(report.wholeObjectLocalization?.attempted, 40)
    assert.equal(report.wholeObjectLocalization?.matched, 1)
    assert.equal(report.mask.referenceInstances, 1)
    assert.equal(report.mask.scored, 1)
    assert.equal(report.mask.passedAtIoU08, 1)
    assert.deepEqual(report.boxVerification?.verdicts, {
      complete: 1,
      'needs-expansion': 0,
      unknown: 0,
    })
    assert.equal(report.boxVerification?.casesWithAttempt, 1)
    assert.equal(report.boxVerification?.casesWithoutAttempt, 39)
    assert.equal(report.boxVerification?.expansionOutcomes['not-needed'], 1)
    assert.equal(report.boxVerification?.extractionStatuses.failed, 39)
    assert.equal(report.physical.count, 2)
    assert.equal(report.physical.knownCostUsd, 0.02)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v3 checked-region no-image profile requires zero box-check attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-checked-v3-control-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'no-image-control', {
      checkedRegion: true,
    })
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.schema, 'region-seeded-independent-evaluation-v3')
    assert.equal(report.boxVerification?.applicable, false)
    assert.equal(report.boxVerification?.denominator, 40)
    assert.equal(report.boxVerification?.casesWithoutAttempt, 40)
    assert.equal(report.boxVerification?.successfulAttempts, 0)
    assert.equal(report.physical.count, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v3 checked-region attempts must reconcile to the actual physical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-checked-v3-receipt-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      checkedRegion: true,
    })
    const first = value.summary.results[0]!
    const extraction = first.extraction as unknown as {
      boxChecks: Array<{ physicalIds: number[] }>
    }
    extraction.boxChecks[0]!.physicalIds = [999]
    const refreshedPins = await value.refreshSummaryAndSeal()
    value.options.summary = refreshedPins.summary
    value.options.completionSeal = refreshedPins.completionSeal
    await assert.rejects(
      evaluateRegionSeededRun(value.options, signal),
      /Box-check physical receipt attribution mismatch/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v3 checked-region retains a render failure before any request was dispatched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-checked-v3-undispatched-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      checkedRegion: true,
    })
    const firstRow = value.summary.results[0]!
    const extraction = firstRow.extraction as unknown as {
      status: string
      reason?: string
      errorCode?: string
      mask?: unknown
      segmentation?: unknown
      verification?: unknown
      physicalCalls: number
      logicalCalls: number
      requestHashes: string[]
      boxChecks: Array<Record<string, unknown>>
    }
    extraction.status = 'failed'
    extraction.reason = 'provider-failure'
    extraction.errorCode = 'PROVIDER'
    delete extraction.mask
    delete extraction.segmentation
    delete extraction.verification
    extraction.physicalCalls = 0
    extraction.logicalCalls = 0
    extraction.requestHashes = []
    extraction.boxChecks = [
      {
        index: 0,
        status: 'failed',
        requestHash: null,
        logicalId: null,
        physicalIds: [],
        physicalCalls: 0,
        errorCode: 'PROVIDER',
      },
    ]
    value.summary.physicalReceipts = value.summary.physicalReceipts.filter(
      (receipt) => receipt.caseId !== firstRow.caseId || receipt.logicalId !== 2,
    )
    value.summary.aggregate.admittedPhysicalCalls = 1
    value.summary.aggregate.knownCostUsd = 0.01
    value.summary.aggregate.accountedExposureUsd = 0.01
    const refreshedPins = await value.refreshSummaryAndSeal()
    value.options.summary = refreshedPins.summary
    value.options.completionSeal = refreshedPins.completionSeal
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.rows[0]!.extractionStatus, 'failed')
    assert.deepEqual(report.rows[0]!.boxCheckAttempts, [
      { status: 'failed', errorCode: 'PROVIDER' },
    ])
    assert.equal(report.physical.count, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v3 checked-region rejects an extracted cutout after a non-complete box verdict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-checked-v3-cutout-verdict-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      checkedRegion: true,
    })
    const firstRow = value.summary.results[0]!
    const extraction = firstRow.extraction as unknown as {
      boxChecks: Array<Record<string, unknown>>
      verification: { checks: Array<Record<string, unknown>>; expansion: string }
    }
    const unresolved = {
      verdict: 'unknown',
      selection: {
        choice: 'unknown',
        nativeChoice: 'unknown',
        probabilities: { complete: 0, 'needs-expansion': 0, unknown: 1 },
        tied: ['unknown'],
      },
      metadata: {
        model: 'fixture-model',
        provider: 'fixture',
        requestId: 'fixture-box-check-unknown',
        durationMs: 1,
        costUsd: 0.01,
        attempts: 1,
      },
    }
    extraction.boxChecks[0] = {
      index: 0,
      status: 'ok',
      requestHash: '7'.repeat(64),
      logicalId: 2,
      physicalIds: [2],
      physicalCalls: 1,
      ...unresolved,
    }
    extraction.verification = { checks: [unresolved], expansion: 'not-needed' }
    const refreshedPins = await value.refreshSummaryAndSeal()
    value.options.summary = refreshedPins.summary
    value.options.completionSeal = refreshedPins.completionSeal
    await assert.rejects(
      evaluateRegionSeededRun(value.options, signal),
      /A cutout was published without a final complete box verdict/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v3 checked-region preserves unresolved second verdicts after a valid expansion', async () => {
  for (const finalVerdict of ['needs-expansion', 'unknown'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-checked-v3-expansion-'))
    try {
      const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
        checkedRegion: true,
      })
      const firstRow = value.summary.results[0]!
      const extraction = firstRow.extraction as unknown as {
        status: string
        mask?: unknown
        physicalCalls: number
        logicalCalls: number
        requestHashes: string[]
        boxChecks: Array<Record<string, unknown>>
        verification: { checks: Array<Record<string, unknown>>; expansion: string }
      }
      const verdictResult = (verdict: 'needs-expansion' | 'unknown') => ({
        verdict,
        selection: {
          choice: verdict,
          nativeChoice: verdict,
          probabilities: {
            complete: 0,
            'needs-expansion': verdict === 'needs-expansion' ? 1 : 0,
            unknown: verdict === 'unknown' ? 1 : 0,
          },
          tied: [verdict],
        },
        metadata: {
          model: 'fixture-model',
          provider: 'fixture',
          requestId: `fixture-box-check-${verdict}`,
          durationMs: 1,
          costUsd: 0.01,
          attempts: 1,
        },
      })
      const firstVerdict = verdictResult('needs-expansion')
      const secondVerdict = verdictResult(finalVerdict)
      extraction.status = 'unknown'
      delete extraction.mask
      extraction.physicalCalls = 2
      extraction.logicalCalls = 2
      extraction.requestHashes = ['7'.repeat(64), '8'.repeat(64)]
      extraction.boxChecks[0] = {
        index: 0,
        status: 'ok',
        requestHash: '7'.repeat(64),
        logicalId: 2,
        physicalIds: [2],
        physicalCalls: 1,
        ...firstVerdict,
      }
      extraction.boxChecks.push({
        index: 1,
        status: 'ok',
        requestHash: '8'.repeat(64),
        logicalId: 3,
        physicalIds: [3],
        physicalCalls: 1,
        ...secondVerdict,
      })
      extraction.verification = {
        checks: [firstVerdict, secondVerdict],
        expansion: 'expanded',
      }
      value.summary.physicalReceipts.push({
        caseId: firstRow.caseId,
        physicalId: 3,
        logicalId: 3,
        requestSha256: '8'.repeat(64),
        requestBodySha256: 'a'.repeat(64),
        admittedAt: '2026-10-21T00:00:02.000Z',
        durationMs: 1,
        httpStatus: 200,
        route: value.options.expectedRoute,
        receipt: { costUsd: 0.01 },
        wireReceipt: { usageCostUsd: 0.01 },
        errorCode: null,
      })
      value.summary.aggregate.admittedPhysicalCalls = 3
      value.summary.aggregate.knownCostUsd = 0.03
      value.summary.aggregate.accountedExposureUsd = 0.03
      const refreshedPins = await value.refreshSummaryAndSeal()
      value.options.summary = refreshedPins.summary
      value.options.completionSeal = refreshedPins.completionSeal
      const report = await evaluateRegionSeededRun(value.options, signal)
      assert.equal(report.rows[0]!.extractionStatus, 'unknown')
      assert.equal(report.rows[0]!.boxCheckAttempts?.length, 2)
      assert.equal(report.boxVerification?.expansionOutcomes.expanded, 1)
      assert.equal(
        report.boxVerification?.verdicts[finalVerdict],
        finalVerdict === 'unknown' ? 1 : 2,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

await test('stage failures remain in the full denominator and receipt accounting includes known wire costs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-failed-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      receipt: true,
    })
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.denominator, 40)
    assert.equal(report.classification.denominator, 40)
    assert.equal(report.classification.answered, 0)
    assert.equal(report.classification.accuracy, 0)
    assert.equal(report.classification.unanswered, 40)
    assert.equal(report.classification.errors, 40)
    assert.equal(report.wholeObjectLocalization?.attempted, 40)
    assert.equal(report.wholeObjectLocalization?.matched, 1)
    assert.equal(report.mask.scored, 1)
    assert.equal(report.mask.passedAtIoU08, 1)
    assert.equal(report.physical.knownCostUsd, 0.01)
    assert.equal(report.seedRegionCoarseProxy.positiveCellIsNotWholeObject, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('failed prefetch validation keeps its logical request without inventing a physical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-prefetch-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      prefetchFailure: true,
    })
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.denominator, 40)
    assert.equal(report.classification.answered, 0)
    assert.equal(report.classification.errors, 40)
    assert.equal(report.physical.receipts, 0)
    assert.equal(report.physical.count, 0)
    assert.equal(report.physical.knownCostUsd, 0)
    assert.equal(report.physical.unknownCostCalls, 0)
    assert.equal(report.rows[0]!.classifyStatus, 'failed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('a successful logical request cannot omit its physical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-unreceipted-success-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      prefetchSuccess: true,
    })
    await assert.rejects(
      evaluateRegionSeededRun(value.options, signal),
      /logical request without a physical fetch/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v2 classified-absent skip keeps its pinned policy and zero-call seed status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-v2-skip-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      classifiedAbsentSkip: true,
    })
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.denominator, 40)
    assert.equal(report.rows[0]!.classifyStatus, 'ok')
    assert.equal(report.rows[0]!.extractionStatus, 'not-found')
    assert.equal(report.rows[0]!.seedStatus, 'not-reached')
    assert.equal(report.rows[0]!.seedRegion, null)
    assert.equal(report.physical.count, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v2 classified-failure skip is limited to a zero-call failed extraction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-v2-failure-skip-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      classifiedFailureSkip: true,
    })
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.denominator, 40)
    assert.equal(report.rows[0]!.classifyStatus, 'failed')
    assert.equal(report.rows[0]!.extractionStatus, 'failed')
    assert.equal(report.rows[0]!.seedStatus, 'not-reached')
    assert.equal(report.rows[0]!.seedRegion, null)
    assert.equal(report.rows[0]!.wholeObjectBox, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('v2 present classification cannot claim a classification skip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-v2-mismatched-skip-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      classifiedAbsentSkip: true,
      mismatchSkipClassifier: true,
    })
    await assert.rejects(
      evaluateRegionSeededRun(value.options, signal),
      /Present classification is mislabeled/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('counts a located seed and an extracted mask as false positives on a verified negative', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-negative-seed-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam', {
      injectNegativeSeed: true,
    })
    const report = await evaluateRegionSeededRun(value.options, signal)
    assert.equal(report.seedRegionCoarseProxy.falseSeedLocations, 1)
    assert.equal(report.seedRegionCoarseProxy.falseExtractions, 1)
    assert.equal(report.strata['ui']!.seed.falseSeedLocations, 1)
    assert.equal(report.strata['ui']!.maskDerivedBoxes.falseExtractions, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('no-image control has no masks and paired comparison uses same-semantic seed rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-control-'))
  try {
    const control = await createRegionSeededEvaluatorFixture(directory, 'no-image-control')
    const report = await evaluateRegionSeededRun(control.options, signal)
    assert.equal(report.wholeObjectLocalization, null)
    assert.equal(report.mask.referenceInstances, 1)
    assert.equal(report.mask.unavailable, 1)
    const child = join(directory, 'candidate')
    await mkdir(child)
    const candidate = await createRegionSeededEvaluatorFixture(child, 'region-seeded-sam')
    const candidateReport = await evaluateRegionSeededRun(candidate.options, signal)
    const paired = compareRegionSeededPhotoSeeds(candidateReport, report)
    assert.equal(paired.photoPositivePairs, 16)
    assert.equal(paired.coarseBoxIntersectionSeedProxy.seed, '0x5a4f5259')
    assert.equal(paired.exactReferenceMaskForegroundSeedHit?.pairs, 1)
    assert.match(paired.interpretation, /not whole-object localization/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('duplicate producer IDs and changed source pins fail before evaluation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-pins-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory)
    await assert.rejects(
      evaluateRegionSeededRun(
        { ...value.options, expectedProducerSourceSha256: '9'.repeat(64) },
        signal,
      ),
      /identity\/source\/completion seal/u,
    )
    const second = value.options.corpus.manifests[1]!
    const parsed = JSON.parse((await readFile(second.path)).toString('utf8')) as Array<
      Record<string, unknown>
    >
    parsed[0]!.caseId = value.ids[0]
    const bytes = Buffer.from(JSON.stringify(parsed))
    await writeFile(second.path, bytes)
    const duplicateOptions = {
      ...value.options,
      corpus: {
        ...value.options.corpus,
        manifests: value.options.corpus.manifests.map((item, index) =>
          index === 1 ? { path: second.path, sha256: digest(bytes) } : item,
        ),
      },
    }
    await assert.rejects(
      evaluateRegionSeededRun(duplicateOptions, signal),
      /case IDs must be unique/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('mask evidence distinguishes wrong reference canvas, rejects bad prediction hashes and offsets, and blocks masks in control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-mask-integrity-'))
  try {
    const wrongCanvasDir = join(directory, 'wrong-canvas')
    await mkdir(wrongCanvasDir)
    const wrongCanvas = await createRegionSeededEvaluatorFixture(
      wrongCanvasDir,
      'region-seeded-sam',
      {
        wrongReferenceCanvas: true,
      },
    )
    const unavailable = await evaluateRegionSeededRun(wrongCanvas.options, signal)
    assert.equal(unavailable.mask.scored, 0)
    assert.equal(unavailable.mask.unavailable, 1)
    assert.equal(unavailable.mask.rows[0]!.scores[0]!.status, 'unavailable-wrong-reference-canvas')

    const badHashDir = join(directory, 'bad-hash')
    await mkdir(badHashDir)
    const badHash = await createRegionSeededEvaluatorFixture(badHashDir, 'region-seeded-sam', {
      badMaskHash: true,
    })
    await assert.rejects(evaluateRegionSeededRun(badHash.options, signal), /mask hash/u)

    const badOffsetDir = join(directory, 'bad-offset')
    await mkdir(badOffsetDir)
    const badOffset = await createRegionSeededEvaluatorFixture(badOffsetDir, 'region-seeded-sam', {
      badOffset: true,
    })
    await assert.rejects(evaluateRegionSeededRun(badOffset.options, signal), /offset/u)

    const controlDir = join(directory, 'control-mask')
    await mkdir(controlDir)
    const control = await createRegionSeededEvaluatorFixture(controlDir, 'no-image-control', {
      injectControlMask: true,
    })
    await assert.rejects(
      evaluateRegionSeededRun(control.options, signal),
      /No-image control contains segmentation/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('reference masks may omit byte-count metadata while retaining bounded hash and pixel validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-reference-bytes-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam')
    const truth = value.options.truths[0]!
    const rows = JSON.parse((await readFile(truth.path)).toString('utf8')) as Array<{
      referenceMasks?: Array<Record<string, unknown>>
    }>
    assert.equal(rows[0]?.referenceMasks?.length, 1)
    delete rows[0]!.referenceMasks![0]!.bytes
    const truthBytes = Buffer.from(JSON.stringify(rows))
    await writeFile(truth.path, truthBytes)
    const options = {
      ...value.options,
      truths: value.options.truths.map((item, index) =>
        index === 0 ? { path: item.path, sha256: digest(truthBytes) } : item,
      ),
    }

    const report = await evaluateRegionSeededRun(options, signal)
    assert.equal(report.mask.referenceInstances, 1)
    assert.equal(report.mask.scored, 1)
    assert.equal(report.mask.passedAtIoU08, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('reference masks with supplied incorrect byte counts remain rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'region-evaluator-reference-bad-bytes-'))
  try {
    const value = await createRegionSeededEvaluatorFixture(directory, 'region-seeded-sam')
    const truth = value.options.truths[0]!
    const rows = JSON.parse((await readFile(truth.path)).toString('utf8')) as Array<{
      referenceMasks?: Array<Record<string, unknown>>
    }>
    assert.equal(rows[0]?.referenceMasks?.length, 1)
    const referenceBytes = await readFile(join(value.options.referenceRoot, 'ref.png'))
    rows[0]!.referenceMasks![0]!.bytes = referenceBytes.length + 1
    const truthBytes = Buffer.from(JSON.stringify(rows))
    await writeFile(truth.path, truthBytes)
    const options = {
      ...value.options,
      truths: value.options.truths.map((item, index) =>
        index === 0 ? { path: item.path, sha256: digest(truthBytes) } : item,
      ),
    }

    await assert.rejects(evaluateRegionSeededRun(options, signal), /size or digest mismatch/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
