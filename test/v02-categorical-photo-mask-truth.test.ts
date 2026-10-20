import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import sharp from 'sharp'
import type { FreshCase } from '../benchmarks/v02/fresh-corpus.js'
import { joinCategoricalPhotoMaskTruth } from '../benchmarks/v02/categorical-photo-mask-truth.js'
import {
  proposalArtifactSchemas,
  scoreProposalMasks,
} from '../benchmarks/v02/evaluate-proposals.js'
import { hashCanonical } from '../benchmarks/v02/protocol.js'

function fixtures() {
  const cases: FreshCase[] = Array.from({ length: 40 }, (_, index) => {
    const imageId = (index + 1).toString(16).padStart(16, '0')
    return {
      caseId: `photo-case-${index + 1}`,
      image: {
        path: `photos/${imageId}.jpg`,
        sha256: imageId.repeat(4),
        width: 2,
        height: 2,
      },
      locate: { target: `object ${index + 1}` },
      classify: { options: ['present', 'absent'] },
    }
  })
  const canonicalTruth = cases.map((item) => ({
    caseId: item.caseId,
    targetClassId: '/m/object',
    expectedPresence: 'present',
    targetBoxes: [{ xyxy: [0, 0, 1, 1] }],
  }))
  const rows = []
  let sourceCsvRow = 1000
  for (let caseIndex = 0; caseIndex < 21; caseIndex++) {
    const item = cases[caseIndex]!
    const imageId = (caseIndex + 1).toString(16).padStart(16, '0')
    const count = caseIndex > 0 && caseIndex <= 11 ? 2 : 1 // 1 + 11 * 2 + 9 = 32 masks.
    for (let instance = 0; instance < count; instance++) {
      const maskPath = `${imageId}_mobject_${(sourceCsvRow + instance).toString(16).padStart(8, '0')}.png`
      rows.push({
        caseId: item.caseId,
        imageId,
        targetClassId: '/m/object',
        maskPath,
        sourceCsvRow,
        maskFormat: '',
        width: 2,
        height: 2,
        file: `sealed/masks/${item.caseId}/${maskPath}`,
        sha256: createHash('sha256').update(maskPath).digest('hex'),
        bytes: 100,
      })
      sourceCsvRow++
    }
  }
  const maskIndex = {
    sourceUrl:
      'https://storage.googleapis.com/openimages/v5/validation-annotations-object-segmentation.csv',
    sourceCsvSha256: 'a876ff7a1a68de771e668baa9886f0ca2331992cd4af5497401be41828a5de89',
    annotationLicense: 'https://creativecommons.org/licenses/by/4.0/',
    caseCount: 21,
    maskInstanceCount: 32,
    rows,
    downloadMethod:
      'official per-leading-character archive; only selected mask PNG entries retained',
  }
  return { cases, canonicalTruth, maskIndex }
}

await test('joins all pinned photo masks to matching case, image, class and geometry metadata', () => {
  const input = fixtures()
  const originalTruth = structuredClone(input.canonicalTruth)
  const originalIndex = structuredClone(input.maskIndex)
  const joined = joinCategoricalPhotoMaskTruth({
    canonicalPhotoTruth: input.canonicalTruth,
    canonicalPhotoTruthSha256: '1'.repeat(64),
    maskIndex: input.maskIndex,
    maskIndexSha256: '2'.repeat(64),
    producerImageBindings: input.cases,
  })
  assert.deepEqual(input.canonicalTruth, originalTruth)
  assert.deepEqual(input.maskIndex, originalIndex)
  assert.equal(joined.truth.length, 40)
  assert.equal(joined.provenance.caseCount, 21)
  assert.equal(joined.provenance.maskInstanceCount, 32)
  assert.equal(
    joined.truth.reduce((sum, row) => sum + (row.referenceMasks?.length ?? 0), 0),
    32,
  )
  assert.equal(joined.provenance.maskIndexSha256, '2'.repeat(64))
})

await test('rejects duplicate, unmatched, wrong-image, wrong-class and wrong-geometry references', () => {
  const original = fixtures()
  const mutations: Array<(fixture: ReturnType<typeof fixtures>) => void> = [
    (fixture) => {
      fixture.maskIndex.rows[1]!.sourceCsvRow = fixture.maskIndex.rows[0]!.sourceCsvRow
    },
    (fixture) => {
      fixture.maskIndex.rows[0]!.caseId = 'unmatched-photo-case'
    },
    (fixture) => {
      fixture.maskIndex.rows[0]!.imageId = 'f'.repeat(16)
    },
    (fixture) => {
      fixture.maskIndex.rows[0]!.targetClassId = '/m/other'
    },
    (fixture) => {
      fixture.maskIndex.rows[0]!.width = 3
    },
  ]
  for (const mutate of mutations) {
    const fixture = structuredClone(original)
    mutate(fixture)
    assert.throws(() =>
      joinCategoricalPhotoMaskTruth({
        canonicalPhotoTruth: fixture.canonicalTruth,
        canonicalPhotoTruthSha256: '1'.repeat(64),
        maskIndex: fixture.maskIndex,
        maskIndexSha256: '2'.repeat(64),
        producerImageBindings: fixture.cases,
      }),
    )
  }
})

await test('joined reference metadata produces nonzero evaluator coverage instead of silent zero masks', async () => {
  const fixture = fixtures()
  const referencePng = await sharp(Buffer.from([255, 255, 255, 255]), {
    raw: { width: 2, height: 2, channels: 1 },
  })
    .png()
    .toBuffer()
  fixture.maskIndex.rows[0]!.sha256 = createHash('sha256').update(referencePng).digest('hex')
  fixture.maskIndex.rows[0]!.bytes = referencePng.byteLength
  const joined = joinCategoricalPhotoMaskTruth({
    canonicalPhotoTruth: fixture.canonicalTruth,
    canonicalPhotoTruthSha256: '1'.repeat(64),
    maskIndex: fixture.maskIndex,
    maskIndexSha256: '2'.repeat(64),
    producerImageBindings: fixture.cases,
  })
  const directory = await mkdtemp(join(tmpdir(), 'zorya-categorical-mask-join-'))
  try {
    const firstCase = fixture.cases[0]!
    const firstTruth = joined.truth[0]!
    const reference = firstTruth.referenceMasks![0]!
    const referenceRoot = join(directory, 'references')
    const referencePath = join(referenceRoot, reference.path)
    const referenceDirectory = join(referencePath, '..')
    await mkdir(referenceDirectory, { recursive: true })
    await writeFile(referencePath, referencePng, { flag: 'wx' })
    const truthPath = join(directory, 'derived-photo-truth.json')
    const truthBytes = Buffer.from(JSON.stringify(joined.truth))
    await writeFile(truthPath, truthBytes, { flag: 'wx' })

    const runDirectory = join(directory, 'run')
    const caseDirectory = join(runDirectory, firstCase.caseId)
    await mkdir(caseDirectory, { recursive: true })
    const predicted = Buffer.from([1, 1, 1, 1])
    const cutout = await sharp(Buffer.from([255, 255, 255, 255]), {
      raw: { width: 2, height: 2, channels: 1 },
    })
      .png()
      .toBuffer()
    await writeFile(join(caseDirectory, 'mask.u8'), predicted, { flag: 'wx' })
    await writeFile(join(caseDirectory, 'cutout.png'), cutout, { flag: 'wx' })
    const result = proposalArtifactSchemas.result.parse({
      caseId: firstCase.caseId,
      imageSha256: firstCase.image.sha256,
      classify: {
        status: 'ok',
        durationMs: 1,
        physicalCalls: 1,
        logicalCalls: 1,
        requestHashes: [hashCanonical('classify')],
        value: 'present',
      },
      locate: {
        status: 'located',
        durationMs: 1,
        physicalCalls: 1,
        logicalCalls: 1,
        requestHashes: [hashCanonical('locate')],
        region: { left: 0, top: 0, width: 2, height: 2 },
      },
      extract: {
        status: 'extracted',
        durationMs: 1,
        nativeProposal: {
          method: 'fixture',
          backend: 'fixture',
          durationMs: 1,
          input: { width: 2, height: 2 },
          candidateCount: 1,
        },
        segmentation: {
          method: 'fixture',
          backend: 'fixture',
          durationMs: 1,
          input: { width: 2, height: 2 },
        },
        mask: {
          file: 'mask.u8',
          sha256: createHash('sha256').update(predicted).digest('hex'),
          format: 'binary-u8',
          width: 2,
          height: 2,
          sourceRegion: { left: 0, top: 0, width: 2, height: 2 },
          sourceOffset: { x: 0, y: 0 },
          pngFile: 'cutout.png',
          pngSha256: createHash('sha256').update(cutout).digest('hex'),
        },
      },
    })
    const noReferences = await scoreProposalMasks(
      { results: [result] },
      fixture.cases.slice(0, 1),
      [],
      runDirectory,
      referenceRoot,
      new AbortController().signal,
    )
    const scored = await scoreProposalMasks(
      { results: [result] },
      fixture.cases.slice(0, 1),
      [{ path: truthPath, sha256: createHash('sha256').update(truthBytes).digest('hex') }],
      runDirectory,
      referenceRoot,
      new AbortController().signal,
    )
    assert.equal(noReferences.truthCases, 0)
    assert.equal(scored.truthCases, 1)
    assert.equal(scored.scoredCases, 1)
    assert.equal(scored.meanBestInstanceIoU, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
