import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { evaluateV03Pilot, loadV03PilotTruth } from '../benchmarks/v03/evaluate-pilot.js'
import type { V03PilotTruth } from '../benchmarks/v03/evaluate-pilot.js'
import { loadV03PilotCorpus, v03PilotManifests } from '../benchmarks/v03/pilot-manifest.js'

const imageRoot = process.cwd()
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

await test('v0.3 pilot manifest loads 12 opaque DEV cases without evaluator data', async () => {
  const corpus = await loadV03PilotCorpus(imageRoot, new AbortController().signal)
  assert.equal(corpus.cases.length, 12)
  assert.deepEqual(
    corpus.manifests.map((item) => item.sha256),
    v03PilotManifests.map((item) => item.sha256),
  )
  assert.equal(new Set(corpus.cases.map((item) => item.caseId)).size, 12)
  assert.ok(corpus.cases.every((item) => item.caseId.startsWith('pilot-v03-')))
  assert.deepEqual(
    corpus.cases.map((item) => item.caseId.split('-')[2]),
    ['photo', 'photo', 'photo', 'photo', 'ui', 'ui', 'ui', 'ui', 'map', 'map', 'map', 'map'],
  )
})

await test('pilot evaluator counts missing outputs, errors, seed hits, whole boxes and negatives separately', async () => {
  const corpus = await loadV03PilotCorpus(imageRoot, new AbortController().signal)
  const originalTruth = await loadV03PilotTruth()
  const temp = await mkdtemp(join(tmpdir(), 'v03-pilot-eval-'))
  const refs = join(temp, 'refs')
  const outputs = join(temp, 'outputs')
  await mkdir(refs)
  await mkdir(join(outputs, corpus.cases[0]!.caseId), { recursive: true })
  await mkdir(join(outputs, corpus.cases[3]!.caseId), { recursive: true })
  try {
    const testCorpus = corpus.cases.map((item) => ({
      ...item,
      image: { ...item.image, width: 20, height: 20 },
    }))
    const truth: V03PilotTruth[] = originalTruth.map((item) => ({
      ...item,
      sourceWidth: 20,
      sourceHeight: 20,
      boxes: item.presence === 'present' ? [{ left: 5, top: 5, width: 2, height: 2 }] : [],
      referenceMasks: [],
    }))
    const positive = truth[0]!
    const negative = truth[3]!
    const referenceBits = new Uint8Array(20 * 20)
    for (let y = 5; y < 7; y++) for (let x = 5; x < 7; x++) referenceBits[y * 20 + x] = 255
    const referencePng = await sharp(Buffer.from(referenceBits), {
      raw: { width: 20, height: 20, channels: 1 },
    })
      .png()
      .toBuffer()
    await writeFile(join(refs, 'reference.png'), referencePng)
    const reducedReferenceBits = new Uint8Array(10 * 10)
    reducedReferenceBits[2 * 10 + 2] = 255
    const reducedReferencePng = await sharp(Buffer.from(reducedReferenceBits), {
      raw: { width: 10, height: 10, channels: 1 },
    })
      .png()
      .toBuffer()
    await writeFile(join(refs, 'reference-small.png'), reducedReferencePng)
    positive.referenceMasks = [
      {
        path: 'reference.png',
        sha256: hash(referencePng),
        width: 20,
        height: 20,
        resampling: 'nearest-neighbor to acquired synthetic raster',
      },
      {
        path: 'reference-small.png',
        sha256: hash(reducedReferencePng),
        width: 10,
        height: 10,
        resampling: 'nearest-neighbor to acquired synthetic raster',
      },
    ]
    const predicted = new Uint8Array([1, 1, 1, 1])
    await writeFile(join(outputs, positive.caseId, 'mask.u8'), predicted)
    const rows = [
      {
        caseId: positive.caseId,
        imageSha256: positive.imageSha256,
        classify: { status: 'classified', choice: 'present', durationMs: 4 },
        extraction: {
          status: 'extracted',
          durationMs: 7,
          seed: {
            status: 'located',
            region: { left: 5, top: 5, width: 1, height: 1 },
            sourceWidth: 20,
            sourceHeight: 20,
          },
          mask: {
            file: 'mask.u8',
            sha256: hash(predicted),
            width: 2,
            height: 2,
            sourceRegion: { left: 5, top: 5, width: 2, height: 2 },
            sourceOffset: { x: 5, y: 5 },
          },
        },
      },
      {
        caseId: negative.caseId,
        imageSha256: negative.imageSha256,
        classify: { status: 'failed' },
        extraction: {
          status: 'failed',
          reason: 'test',
          seed: {
            status: 'located',
            region: { left: 1, top: 1, width: 2, height: 2 },
            sourceWidth: 20,
            sourceHeight: 20,
          },
          cutout: true,
          mask: {
            file: 'mask.u8',
            sha256: hash(predicted),
            width: 2,
            height: 2,
            sourceRegion: { left: 1, top: 1, width: 2, height: 2 },
            sourceOffset: { x: 1, y: 1 },
          },
        },
      },
      ...truth.slice(1, 3).map((item) => ({
        caseId: item.caseId,
        imageSha256: item.imageSha256,
        classify: { status: 'classified', choice: 'present' },
        extraction: { status: 'unknown', seed: { status: 'unknown' } },
      })),
    ]
    const report = await evaluateV03Pilot({
      corpus: testCorpus,
      rows,
      truth,
      imageRoot: refs,
      outputRoot: outputs,
    })
    assert.equal(report.denominators.plannedCases, 12)
    assert.equal(report.denominators.returnedRows, 4)
    assert.equal(report.denominators.missingRows, 8)
    assert.equal(report.denominators.positives, 9)
    assert.equal(report.denominators.positiveSuccesses, 1)
    assert.equal(report.denominators.negatives, 3)
    assert.equal(report.denominators.falseSeeds, 1)
    assert.equal(report.denominators.falseBoxes, 1)
    assert.equal(report.denominators.falseCutouts, 1)
    assert.equal(report.denominators.falseRegionOrCutoutCases, 1)
    assert.equal(report.denominators.positiveBoxesMeasured, 1)
    assert.equal(report.wholeObjectLocalization.status, 'measured')
    assert.equal(report.wholeObjectLocalization.rateAmongAllPositives, 1 / 9)
    assert.equal(
      report.cases.find((row) => row.caseId === truth[1]!.caseId)?.wholeBoxStatus,
      'not-measured-no-mask-box',
    )
    assert.equal(report.denominators.unknownExtractions, 2)
    assert.equal(report.denominators.failedExtractions, 1)
    assert.equal(report.denominators.failedClassifications, 1)
    assert.equal(report.seedDiagnostic.positiveLocatedSeeds, 1)
    assert.equal(report.seedDiagnostic.positiveSeedHits, 1)
    assert.equal(report.masks.independentReferenceCount, 2)
    assert.equal(report.masks.predictionsPresent, 2)
    assert.equal(report.masks.iouAtLeast080, 1)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

await test('forged boxes and invalid mask canvases cannot count as localization successes', async () => {
  const corpus = await loadV03PilotCorpus(imageRoot, new AbortController().signal)
  const originalTruth = await loadV03PilotTruth()
  const truth = originalTruth.map((item) => ({
    ...item,
    sourceWidth: 20,
    sourceHeight: 20,
    boxes: item.presence === 'present' ? [{ left: 5, top: 5, width: 2, height: 2 }] : [],
    referenceMasks: [],
  }))
  const testCorpus = corpus.cases.map((item) => ({
    ...item,
    image: { ...item.image, width: 20, height: 20 },
  }))
  const forged = truth[0]!
  const wrongCanvas = truth[1]!
  const seedOnly = truth[2]!
  const common = { status: 'located', sourceWidth: 20, sourceHeight: 20 }
  const rows = [
    {
      caseId: forged.caseId,
      imageSha256: forged.imageSha256,
      classify: { status: 'classified', choice: 'present' },
      extraction: {
        status: 'located',
        seed: { ...common, region: { left: 5, top: 5, width: 2, height: 2 } },
        mask: {
          file: 'mask.u8',
          sha256: '1'.repeat(64),
          width: 2,
          height: 2,
          sourceRegion: { left: 5, top: 5, width: 2, height: 2 },
          sourceOffset: { x: 5, y: 5 },
        },
      },
    },
    {
      caseId: wrongCanvas.caseId,
      imageSha256: wrongCanvas.imageSha256,
      classify: { status: 'classified', choice: 'present' },
      extraction: {
        status: 'located',
        seed: { ...common, region: { left: 5, top: 5, width: 2, height: 2 } },
        mask: {
          file: 'mask.u8',
          sha256: '2'.repeat(64),
          width: 21,
          height: 2,
          sourceRegion: { left: 5, top: 5, width: 2, height: 2 },
          sourceOffset: { x: 5, y: 5 },
        },
      },
    },
    {
      caseId: seedOnly.caseId,
      imageSha256: seedOnly.imageSha256,
      classify: { status: 'classified', choice: 'present' },
      extraction: {
        status: 'located',
        seed: { ...common, sourceWidth: 19, region: { left: 5, top: 5, width: 1, height: 1 } },
      },
    },
  ]
  const report = await evaluateV03Pilot({
    corpus: testCorpus,
    rows,
    truth,
    imageRoot: '/missing-reference-root-unused-when-no-mask-truth',
    outputRoot: '/missing-output-root',
  })
  assert.equal(report.denominators.positiveSuccesses, 0)
  assert.equal(report.denominators.positiveBoxesMeasured, 0)
  assert.equal(report.wholeObjectLocalization.status, 'not-measured-seed-only-or-no-boxes')
  assert.equal(report.wholeObjectLocalization.rateAmongAllPositives, null)
  assert.equal(report.denominators.invalidMaskArtifacts, 2)
  assert.equal(report.seedDiagnostic.positiveLocatedSeeds, 3)
  assert.equal(report.seedDiagnostic.positiveSeedHits, 2)
  assert.equal(
    report.cases.find((row) => row.caseId === forged.caseId)?.maskArtifactReason,
    'mask-file-unreadable',
  )
  assert.equal(
    report.cases.find((row) => row.caseId === wrongCanvas.caseId)?.maskArtifactReason,
    'mask-canvas-outside-source',
  )
  assert.equal(
    report.cases.find((row) => row.caseId === seedOnly.caseId)?.wholeBoxStatus,
    'not-measured-no-mask-box',
  )
})

await test('full-source masks use their actual support as the whole-object box', async () => {
  const corpus = await loadV03PilotCorpus(imageRoot, new AbortController().signal)
  const originalTruth = await loadV03PilotTruth()
  const truth = originalTruth.map((item) => ({
    ...item,
    sourceWidth: 20,
    sourceHeight: 20,
    boxes: item.presence === 'present' ? [{ left: 5, top: 5, width: 2, height: 2 }] : [],
    referenceMasks: [],
  }))
  const testCorpus = corpus.cases.map((item) => ({
    ...item,
    image: { ...item.image, width: 20, height: 20 },
  }))
  const item = truth[0]!
  const temp = await mkdtemp(join(tmpdir(), 'v03-pilot-full-mask-'))
  await mkdir(join(temp, item.caseId), { recursive: true })
  try {
    const pixels = new Uint8Array(20 * 20)
    for (let y = 5; y < 7; y++) for (let x = 5; x < 7; x++) pixels[y * 20 + x] = 1
    await writeFile(join(temp, item.caseId, 'mask.u8'), pixels)
    const report = await evaluateV03Pilot({
      corpus: testCorpus,
      truth,
      rows: [
        {
          caseId: item.caseId,
          imageSha256: item.imageSha256,
          classify: { status: 'classified', choice: 'present' },
          extraction: {
            status: 'extracted',
            seed: { status: 'unknown' },
            mask: {
              file: 'mask.u8',
              sha256: hash(pixels),
              width: 20,
              height: 20,
              sourceRegion: { left: 5, top: 5, width: 2, height: 2 },
              sourceOffset: { x: 0, y: 0 },
            },
          },
        },
      ],
      imageRoot: temp,
      outputRoot: temp,
    })
    assert.equal(report.denominators.positiveSuccesses, 1)
    assert.equal(report.denominators.positiveBoxesMeasured, 1)
    assert.equal(report.denominators.invalidMaskArtifacts, 0)
    assert.deepEqual(report.cases[0]?.finalBox, { left: 5, top: 5, width: 2, height: 2 })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
