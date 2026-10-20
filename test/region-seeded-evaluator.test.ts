import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import {
  compareRegionSeededPhotoSeeds,
  evaluateRegionSeededRun,
  measureSeedRegion,
  checkedRegionDevProfileIds,
} from '../benchmarks/v02/evaluate-region-seeded.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'

const signal = new AbortController().signal
const profileId = 'fixture-region-profile'
const sourceFiles = { 'src/fake.ts': '1'.repeat(64) }
const producerSourceSha256 = hashCanonical(Object.entries(sourceFiles))
const variantSha256 = '2'.repeat(64)
const route = {
  model: 'fixture-model',
  provider: 'fixture',
  providerName: 'Fixture',
  apiEndpoint: '/fixture',
  allowFallbacks: false as const,
}
const policy = {
  ...route,
  timeoutMs: 120_000 as const,
  maxInFlightCases: 2 as const,
  nativeMaxActive: 1 as const,
  nativeMaxWaiting: 2 as const,
  nativeThreads: 2 as const,
  native: 'CPU MobileSAM seed-region full-source segmentation',
  regionSearchPasses: 3 as const,
  extentCalls: 0 as const,
  sameInstanceCalls: 0 as const,
  maxLogicalCallsPerCase: 4 as const,
  maxPhysicalCallsPerCase: 4 as const,
  maxPhysicalCalls: 250,
  maxCostUsd: 5,
  unknownCostReserveUsd: 0.05,
  retries: 0 as const,
  fallback: false as const,
  latencyRankingEligible: false as const,
}

function digest(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex')
}
function presentAt(global: number) {
  return global < 16 || (global >= 20 && global < 27) || (global >= 30 && global < 37)
}
async function putJson(directory: string, name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  const path = join(directory, name)
  await writeFile(path, bytes, { flag: 'wx' })
  return { path, sha256: digest(bytes) }
}

async function fixture(
  directory: string,
  variant: 'region-seeded-sam' | 'no-image-control' = 'region-seeded-sam',
  altered?: {
    badMaskHash?: boolean
    badOffset?: boolean
    wrongReferenceCanvas?: boolean
    injectControlMask?: boolean
    injectNegativeSeed?: boolean
    receipt?: boolean
    prefetchFailure?: boolean
    prefetchSuccess?: boolean
    classifiedAbsentSkip?: boolean
    classifiedFailureSkip?: boolean
    mismatchSkipClassifier?: boolean
    checkedRegion?: boolean
  },
) {
  const checkedRegion = altered?.checkedRegion === true
  const fixtureProfileId = checkedRegion
    ? variant === 'region-seeded-sam'
      ? checkedRegionDevProfileIds.candidate
      : checkedRegionDevProfileIds.control
    : profileId
  const fixturePolicy = checkedRegion
    ? {
        ...policy,
        maxLogicalCallsPerCase: variant === 'region-seeded-sam' ? (6 as const) : (4 as const),
        maxPhysicalCallsPerCase: variant === 'region-seeded-sam' ? (6 as const) : (4 as const),
        maxBoxCheckCalls: variant === 'region-seeded-sam' ? (2 as const) : (0 as const),
        boxCheckPolicy:
          variant === 'region-seeded-sam'
            ? ('up-to-two-closed-visible-box-containment-checks-v1' as const)
            : ('none-no-segmenter-configured' as const),
        requireClassifiedPresence: true as const,
      }
    : altered?.classifiedAbsentSkip ||
        altered?.classifiedFailureSkip ||
        altered?.mismatchSkipClassifier
      ? { ...policy, requireClassifiedPresence: true as const }
      : policy
  const ids = Array.from({ length: 40 }, (_, i) =>
    i < 20
      ? `photo-${String(i).padStart(2, '0')}`
      : i < 30
        ? `ui-${String(i).padStart(2, '0')}`
        : `map-${String(i).padStart(2, '0')}`,
  )
  const groups = [ids.slice(0, 20), ids.slice(20, 30), ids.slice(30)]
  const imageRoot = join(directory, 'images')
  const referenceRoot = join(directory, 'references')
  const runDirectory = join(directory, 'run')
  await Promise.all([mkdir(imageRoot), mkdir(referenceRoot), mkdir(runDirectory)])
  const imageHash = 'a'.repeat(64)
  const manifests = await Promise.all(
    groups.map((group, index) =>
      putJson(
        directory,
        `input-${index}.json`,
        group.map((caseId) => ({
          caseId,
          image: { path: `${caseId}.jpg`, sha256: imageHash, width: 10, height: 10 },
          locate: { target: 'fixture target' },
          classify: { options: ['present', 'absent'] },
        })),
      ),
    ),
  )
  const truths = await Promise.all(
    groups.map((group, index) =>
      putJson(
        directory,
        `truth-${index}.json`,
        group.map((caseId, local) => {
          const global = index === 0 ? local : index === 1 ? local + 20 : local + 30
          const present = presentAt(global)
          return {
            caseId,
            expectedPresence: present ? 'present' : 'absent',
            targetBoxes: present ? [{ xyxy: [0.3, 0.3, 0.5, 0.5] }] : [],
            negativeEvidence: present ? null : { method: 'complete fixture inventory' },
            ...(global === 0
              ? {
                  referenceMasks: [
                    { path: 'ref.png', sha256: '3'.repeat(64), bytes: 1, width: 4, height: 4 },
                  ],
                }
              : {}),
          }
        }),
      ),
    ),
  )
  const results = ids.map((caseId, index) => {
    const hasPresencePolicy =
      altered?.classifiedAbsentSkip === true ||
      altered?.classifiedFailureSkip === true ||
      altered?.mismatchSkipClassifier === true
    const classifiedAbsentSkip = altered?.classifiedAbsentSkip === true && index === 0
    const classifiedFailureSkip =
      (altered?.classifiedFailureSkip === true && index === 0) || (hasPresencePolicy && index > 0)
    const seed =
      index === 0 || (index === 27 && altered?.injectNegativeSeed)
        ? {
            status: 'located' as const,
            region: { left: 3, top: 3, width: 2, height: 2 },
            sourceWidth: 10,
            sourceHeight: 10,
            prompt: 'seed-region' as const,
            searchLimit: { left: 0, top: 0, width: 10, height: 10 },
            durationMs: 1,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
          }
        : {
            status: 'unknown' as const,
            durationMs: 1,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
          }
    const fixtureMask = {
      file: 'mask.u8' as const,
      sha256: '4'.repeat(64),
      width: 2,
      height: 2,
      sourceRegion: { left: 3, top: 3, width: 2, height: 2 },
      sourceOffset: { x: altered?.badOffset ? 2 : 3, y: 3 },
      pngFile: 'cutout.png' as const,
      pngSha256: '5'.repeat(64),
      center: { x: 4, y: 4 },
      segmentation: {
        method: 'mobile-sam-seed-region-v1',
        backend: 'mobile-sam',
        durationMs: 1,
        input: { width: 10, height: 10 },
        qualityScore: 0.7,
      },
    }
    const extraction =
      classifiedAbsentSkip || classifiedFailureSkip
        ? {
            status: classifiedAbsentSkip ? ('not-found' as const) : ('failed' as const),
            reason: classifiedAbsentSkip ? 'classification-absent' : 'classification-failed',
            durationMs: 0,
            physicalCalls: 0,
            logicalCalls: 0,
            requestHashes: [],
            seed: {
              status: 'not-reached' as const,
              durationMs: 0,
              physicalCalls: 0,
              logicalCalls: 0,
              requestHashes: [],
            },
          }
        : (index === 0 || (index === 27 && altered?.injectNegativeSeed)) &&
            variant === 'region-seeded-sam'
          ? {
              status: 'extracted' as const,
              durationMs: 2,
              physicalCalls: 0,
              logicalCalls: 0,
              requestHashes: [],
              seed,
              mask: fixtureMask,
            }
          : variant === 'no-image-control' && index === 0
            ? altered?.injectControlMask
              ? {
                  status: 'extracted' as const,
                  durationMs: 1,
                  physicalCalls: 0,
                  logicalCalls: 0,
                  requestHashes: [],
                  seed,
                  mask: fixtureMask,
                }
              : {
                  status: 'region-only' as const,
                  durationMs: 1,
                  physicalCalls: 0,
                  logicalCalls: 0,
                  requestHashes: [],
                  seed,
                }
            : {
                status: 'failed' as const,
                errorCode: 'TIMEOUT',
                durationMs: 1,
                physicalCalls: 0,
                logicalCalls: 0,
                requestHashes: [],
                seed,
              }
    return {
      caseId,
      imageSha256: imageHash,
      classify: {
        status:
          altered?.classifiedAbsentSkip && index === 0
            ? ('ok' as const)
            : altered?.mismatchSkipClassifier && index === 0
              ? ('ok' as const)
              : altered?.prefetchSuccess && index === 0
                ? ('ok' as const)
                : ('failed' as const),
        ...(altered?.mismatchSkipClassifier && index === 0
          ? { value: 'present' as const }
          : altered?.classifiedAbsentSkip && index === 0
            ? { value: 'absent' as const }
            : altered?.prefetchSuccess && index === 0
              ? { value: 'present' as const }
              : {}),
        ...((altered?.prefetchFailure || altered?.prefetchSuccess) && index === 0
          ? { errorCode: 'INVALID_INPUT' }
          : { errorCode: 'TIMEOUT' }),
        durationMs: 1,
        physicalCalls: (altered?.receipt || altered?.classifiedAbsentSkip) && index === 0 ? 1 : 0,
        logicalCalls:
          (altered?.receipt ||
            altered?.prefetchFailure ||
            altered?.prefetchSuccess ||
            altered?.classifiedAbsentSkip) &&
          index === 0
            ? 1
            : 0,
        requestHashes:
          altered?.receipt && index === 0
            ? ['6'.repeat(64)]
            : (altered?.prefetchFailure || altered?.prefetchSuccess) && index === 0
              ? ['8'.repeat(64)]
              : altered?.classifiedAbsentSkip && index === 0
                ? ['9'.repeat(64)]
                : [],
      },
      extraction,
    }
  })
  if (checkedRegion) {
    const firstFixtureExtraction = results[0]!.extraction
    const skipped = () => ({
      status: 'failed' as const,
      reason: 'classification-failed',
      durationMs: 0,
      physicalCalls: 0,
      logicalCalls: 0,
      requestHashes: [],
      seed: {
        status: 'not-reached' as const,
        durationMs: 0,
        physicalCalls: 0,
        logicalCalls: 0,
        requestHashes: [],
      },
      boxChecks: [],
    })
    for (const row of results) {
      row.classify = {
        status: 'failed',
        durationMs: 1,
        physicalCalls: 0,
        logicalCalls: 0,
        requestHashes: [],
        errorCode: 'TIMEOUT',
      }
      row.extraction = skipped() as typeof row.extraction
    }
    if (variant === 'region-seeded-sam') {
      const first = results[0]!
      first.classify = {
        status: 'ok',
        value: 'present',
        durationMs: 1,
        physicalCalls: 1,
        logicalCalls: 1,
        requestHashes: ['6'.repeat(64)],
      } as unknown as typeof first.classify
      const selected = {
        verdict: 'complete' as const,
        selection: {
          choice: 'complete' as const,
          nativeChoice: 'complete' as const,
          probabilities: { complete: 1, 'needs-expansion': 0, unknown: 0 },
          tied: ['complete' as const],
        },
        metadata: {
          model: 'fixture-model',
          provider: 'fixture',
          requestId: 'fixture-box-check',
          durationMs: 1,
          costUsd: 0.01,
          attempts: 1,
        },
      }
      const extracted = {
        ...(firstFixtureExtraction as Record<string, unknown>),
        status: 'extracted' as const,
        durationMs: 2,
        physicalCalls: 1,
        logicalCalls: 1,
        requestHashes: ['7'.repeat(64)],
        seed: {
          status: 'located' as const,
          region: { left: 3, top: 3, width: 2, height: 2 },
          sourceWidth: 10,
          sourceHeight: 10,
          prompt: 'seed-region' as const,
          searchLimit: { left: 0, top: 0, width: 10, height: 10 },
          durationMs: 1,
          physicalCalls: 0,
          logicalCalls: 0,
          requestHashes: [],
        },
        boxChecks: [
          {
            index: 0,
            status: 'ok' as const,
            requestHash: '7'.repeat(64),
            logicalId: 2,
            physicalIds: [2],
            physicalCalls: 1 as const,
            ...selected,
          },
        ],
        verification: { checks: [selected], expansion: 'not-needed' as const },
      }
      first.extraction = extracted as unknown as typeof first.extraction
    }
  }
  const receipts =
    altered?.checkedRegion && variant === 'region-seeded-sam'
      ? [
          {
            caseId: ids[0]!,
            physicalId: 1,
            logicalId: 1,
            requestSha256: '6'.repeat(64),
            requestBodySha256: '7'.repeat(64),
            admittedAt: '2026-10-21T00:00:00.000Z',
            durationMs: 1,
            httpStatus: 200,
            route,
            receipt: { costUsd: 0.01 },
            wireReceipt: { usageCostUsd: 0.01 },
            errorCode: null,
          },
          {
            caseId: ids[0]!,
            physicalId: 2,
            logicalId: 2,
            requestSha256: '7'.repeat(64),
            requestBodySha256: '8'.repeat(64),
            admittedAt: '2026-10-21T00:00:01.000Z',
            durationMs: 1,
            httpStatus: 200,
            route,
            receipt: { costUsd: 0.01 },
            wireReceipt: { usageCostUsd: 0.01 },
            errorCode: null,
          },
        ]
      : altered?.checkedRegion
        ? []
        : altered?.receipt || altered?.classifiedAbsentSkip
          ? [
              {
                caseId: ids[0]!,
                physicalId: 1,
                logicalId: 1,
                requestSha256: altered?.classifiedAbsentSkip ? '9'.repeat(64) : '6'.repeat(64),
                requestBodySha256: '7'.repeat(64),
                admittedAt: '2026-10-21T00:00:00.000Z',
                durationMs: 1,
                httpStatus: 200,
                route,
                receipt: { costUsd: 0.01 },
                wireReceipt: { usageCostUsd: 0.01 },
                errorCode: null,
              },
            ]
          : []
  const summary = {
    runId: 'fixture-run',
    profileId: fixtureProfileId,
    phase: 'dev',
    status: 'complete',
    producerSourceSha256,
    sourceBeforeSha256: producerSourceSha256,
    sourceAfterSha256: producerSourceSha256,
    sourceUnchanged: true,
    plannedCaseIds: ids,
    imageChecks: ids.map((caseId) => ({ caseId, status: 'verified', errorCode: null })),
    completedCaseIds: ids,
    missingCaseIds: [],
    results,
    aggregate: {
      admittedPhysicalCalls: receipts.length,
      knownCostUsd: receipts.length * 0.01,
      unknownCostCalls: 0,
      inFlightCalls: 0,
      accountedExposureUsd: receipts.length * 0.01,
      maxPhysicalCalls: 250,
      maxCostUsd: 5,
    },
    shutdownError: null,
    physicalReceipts: receipts,
    ...(variant === 'no-image-control'
      ? {
          imageFetchAudit: {
            checkedFetches: receipts.length,
            imagePartFetches: 0,
            allRequestsVerifiedImageFree: true,
          },
        }
      : {}),
  }
  const summaryFile = await putJson(directory, 'summary.json', summary)
  const run = {
    runId: 'fixture-run',
    profileId: fixtureProfileId,
    phase: 'dev',
    purpose: 'fixture purpose',
    targetPolicy: 'target-plus-neutral-instruction-v1',
    producerSourceSha256,
    producerSourceFiles: sourceFiles,
    manifests: manifests.map((item, index) => ({
      sha256: item.sha256,
      cases: groups[index]!.length,
    })),
    plannedCaseIds: ids,
    imageChecks: ids.map((caseId) => ({ caseId, status: 'verified', errorCode: null })),
    variantSha256,
    route,
    variant,
    policy: fixturePolicy,
    budget: { maxPhysicalCalls: 250, maxCostUsd: 5, unknownCostReserveUsd: 0.05 },
  }
  const runFile = await putJson(directory, 'run.json', run)
  const sealFile = await putJson(directory, 'seal.json', {
    runId: 'fixture-run',
    status: 'complete',
    summarySha256: digest(JSON.stringify(summary)),
    sourceBeforeSha256: producerSourceSha256,
    sourceAfterSha256: producerSourceSha256,
    sourceUnchanged: true,
  })
  const mask = Buffer.from([1, 1, 0, 1])
  const rgba = Buffer.from([20, 50, 90, 255, 20, 50, 90, 255, 20, 50, 90, 0, 20, 50, 90, 255])
  const png = await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } })
    .png()
    .toBuffer()
  if (variant === 'region-seeded-sam') {
    for (const row of results) {
      if (row.extraction.status !== 'extracted' || !row.extraction.mask) continue
      const caseDir = join(runDirectory, row.caseId)
      await mkdir(caseDir)
      await writeFile(join(caseDir, 'mask.u8'), mask, { flag: 'wx' })
      await writeFile(join(caseDir, 'cutout.png'), png, { flag: 'wx' })
      row.extraction.mask.sha256 =
        altered?.badMaskHash && row.caseId === ids[0] ? '8'.repeat(64) : digest(mask)
      row.extraction.mask.pngSha256 = digest(png)
    }
  }
  const ref = Buffer.alloc(100)
  ref[33] = 255
  ref[34] = 255
  ref[44] = 255
  const refPng = await sharp(ref, { raw: { width: 10, height: 10, channels: 1 } })
    .png()
    .toBuffer()
  await writeFile(join(referenceRoot, 'ref.png'), refPng)
  const refWidth = altered?.wrongReferenceCanvas ? 9 : 10
  await writeFile(
    truths[0]!.path,
    JSON.stringify(
      groups[0]!.map((caseId, local) => {
        const present = presentAt(local)
        return {
          caseId,
          expectedPresence: present ? 'present' : 'absent',
          targetBoxes: present ? [{ xyxy: [0.3, 0.3, 0.5, 0.5] }] : [],
          negativeEvidence: present ? null : { method: 'complete fixture inventory' },
          ...(local === 0
            ? {
                referenceMasks: [
                  {
                    path: 'ref.png',
                    sha256: digest(refPng),
                    bytes: refPng.length,
                    width: refWidth,
                    height: 10,
                  },
                ],
              }
            : {}),
        }
      }),
    ),
  )
  const { readFile } = await import('node:fs/promises')
  truths[0] = { ...truths[0]!, sha256: digest(await readFile(truths[0]!.path)) }
  const summaryBytes = JSON.stringify(summary)
  await writeFile(summaryFile.path, summaryBytes)
  const frozenSummaryFile = { path: summaryFile.path, sha256: digest(summaryBytes) }
  const seal = {
    runId: 'fixture-run',
    status: 'complete',
    summarySha256: frozenSummaryFile.sha256,
    sourceBeforeSha256: producerSourceSha256,
    sourceAfterSha256: producerSourceSha256,
    sourceUnchanged: true,
  }
  const sealBytes = JSON.stringify(seal)
  await writeFile(sealFile.path, sealBytes)
  const frozenSealFile = { path: sealFile.path, sha256: digest(sealBytes) }
  return {
    ids,
    results,
    summary,
    async refreshSummaryAndSeal() {
      const refreshedSummaryBytes = JSON.stringify(summary)
      await writeFile(frozenSummaryFile.path, refreshedSummaryBytes)
      const refreshedSummaryFile = {
        path: frozenSummaryFile.path,
        sha256: digest(refreshedSummaryBytes),
      }
      const refreshedSeal = {
        runId: 'fixture-run',
        status: 'complete',
        summarySha256: refreshedSummaryFile.sha256,
        sourceBeforeSha256: producerSourceSha256,
        sourceAfterSha256: producerSourceSha256,
        sourceUnchanged: true,
      }
      const sealBytes = JSON.stringify(refreshedSeal)
      await writeFile(frozenSealFile.path, sealBytes)
      return {
        summary: refreshedSummaryFile,
        completionSeal: { path: frozenSealFile.path, sha256: digest(sealBytes) },
      }
    },
    options: {
      phase: 'dev' as const,
      variant,
      profileId: fixtureProfileId,
      purpose: 'fixture purpose',
      expectedProducerSourceSha256: producerSourceSha256,
      expectedVariantSha256: variantSha256,
      expectedRoute: route,
      expectedPolicy: fixturePolicy,
      expectedTargetPolicy: 'target-plus-neutral-instruction-v1' as const,
      summary: frozenSummaryFile,
      runManifest: runFile,
      completionSeal: frozenSealFile,
      corpus: { manifests, imageRoot },
      truths,
      referenceRoot,
      runDirectory,
      output: join(directory, `evaluation-${variant}.json`),
    },
  }
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
    const value = await fixture(directory, 'region-seeded-sam', { checkedRegion: true })
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
    const value = await fixture(directory, 'no-image-control', { checkedRegion: true })
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
    const value = await fixture(directory, 'region-seeded-sam', { checkedRegion: true })
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
    const value = await fixture(directory, 'region-seeded-sam', { checkedRegion: true })
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
    const value = await fixture(directory, 'region-seeded-sam', { checkedRegion: true })
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
      const value = await fixture(directory, 'region-seeded-sam', { checkedRegion: true })
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
        route,
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
    const value = await fixture(directory, 'region-seeded-sam', { receipt: true })
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
    const value = await fixture(directory, 'region-seeded-sam', { prefetchFailure: true })
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
    const value = await fixture(directory, 'region-seeded-sam', { prefetchSuccess: true })
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
    const value = await fixture(directory, 'region-seeded-sam', { classifiedAbsentSkip: true })
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
    const value = await fixture(directory, 'region-seeded-sam', { classifiedFailureSkip: true })
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
    const value = await fixture(directory, 'region-seeded-sam', {
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
    const value = await fixture(directory, 'region-seeded-sam', { injectNegativeSeed: true })
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
    const control = await fixture(directory, 'no-image-control')
    const report = await evaluateRegionSeededRun(control.options, signal)
    assert.equal(report.wholeObjectLocalization, null)
    assert.equal(report.mask.referenceInstances, 1)
    assert.equal(report.mask.unavailable, 1)
    const child = join(directory, 'candidate')
    await mkdir(child)
    const candidate = await fixture(child, 'region-seeded-sam')
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
    const value = await fixture(directory)
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
    const wrongCanvas = await fixture(wrongCanvasDir, 'region-seeded-sam', {
      wrongReferenceCanvas: true,
    })
    const unavailable = await evaluateRegionSeededRun(wrongCanvas.options, signal)
    assert.equal(unavailable.mask.scored, 0)
    assert.equal(unavailable.mask.unavailable, 1)
    assert.equal(unavailable.mask.rows[0]!.scores[0]!.status, 'unavailable-wrong-reference-canvas')

    const badHashDir = join(directory, 'bad-hash')
    await mkdir(badHashDir)
    const badHash = await fixture(badHashDir, 'region-seeded-sam', { badMaskHash: true })
    await assert.rejects(evaluateRegionSeededRun(badHash.options, signal), /mask hash/u)

    const badOffsetDir = join(directory, 'bad-offset')
    await mkdir(badOffsetDir)
    const badOffset = await fixture(badOffsetDir, 'region-seeded-sam', { badOffset: true })
    await assert.rejects(evaluateRegionSeededRun(badOffset.options, signal), /offset/u)

    const controlDir = join(directory, 'control-mask')
    await mkdir(controlDir)
    const control = await fixture(controlDir, 'no-image-control', { injectControlMask: true })
    await assert.rejects(
      evaluateRegionSeededRun(control.options, signal),
      /No-image control contains segmentation/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
