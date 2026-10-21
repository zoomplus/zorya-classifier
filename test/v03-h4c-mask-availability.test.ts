import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import sharp from 'sharp'
import type { V03PilotTruth } from '../benchmarks/v03/evaluate-pilot.js'
import {
  evaluateH4cMaskAvailability,
  H4A_FREEZE_SHA256,
  H4A_OUTPUT_SHA256,
} from '../benchmarks/v03/evaluate-h4c-sam2-ui-mask-availability.js'

const sourceSha = '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09'
const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'v03-h4c-mask-eval-'))
  const runRoot = join(root, 'h4c')
  await mkdir(join(runRoot, 'masks'), { recursive: true })
  const rows: Array<Record<string, unknown>> = []
  const candidates: Array<Record<string, unknown>> = []
  const proposals: Array<Record<string, unknown>> = []
  for (let ordinal = 0; ordinal < 36; ordinal++) {
    const box: [number, number, number, number] = ordinal === 0 ? [1, 1, 2, 2] : [0, 0, 1, 1]
    const candidate = {
      flat_index: 100 + ordinal,
      score: 0.9 - ordinal / 100,
      box_canvas_xyxy: box,
      box_xyxy: box,
    }
    candidates.push(candidate)
    proposals.push({
      proposal_ordinal: ordinal,
      flat_index: candidate.flat_index,
      score: candidate.score,
      box_xyxy: box,
    })
    const pixels = Buffer.alloc(16)
    if (ordinal === 0) {
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) pixels[y * 4 + x] = 255
    }
    const maskBytes = await sharp(pixels, { raw: { width: 4, height: 4, channels: 1 } })
      .greyscale()
      .png()
      .toBuffer()
    const maskPath = `masks/candidate-${String(ordinal).padStart(3, '0')}-mask.png`
    await writeFile(join(runRoot, maskPath), maskBytes)
    rows.push({
      proposal_ordinal: ordinal,
      flat_index: candidate.flat_index,
      score: candidate.score,
      box_xyxy: box,
      mask_path: maskPath,
      mask_sha256: hex(maskBytes),
      mask_bytes: maskBytes.length,
      source_width: 4,
      source_height: 4,
      mask_pixel_area: ordinal === 0 ? 9 : 0,
      empty: ordinal !== 0,
      mask_box_xyxy: ordinal === 0 ? [0, 0, 3, 3] : null,
    })
  }
  const h4aRecord = {
    state: 'complete',
    integrity_after: { unchanged: true },
    results: [
      {
        case_ids: ['ui-case-01', 'ui-case-02', 'ui-case-03', 'ui-case-04'],
        source: { sha256: sourceSha },
        source_geometry: { width: 4, height: 4 },
        transform: {
          source_width: 4,
          source_height: 4,
          scale_x: 1,
          scale_y: 1,
          pad_left: 0,
          pad_top: 0,
        },
        candidates,
      },
    ],
  }
  const h4cFreezeRecord = {
    state: 'frozen-before-inference',
    h4a_output: { sha256: H4A_OUTPUT_SHA256 },
    h4a_freeze: { sha256: H4A_FREEZE_SHA256 },
    source: { sha256: sourceSha },
    recipe: {
      clip_to_box: false,
      ordered_box_prompts: 36,
      image_encoding_calls: 1,
      multimask_output: false,
      mask_frame: 'full original source',
    },
    producer: { sha256: '94ad6b131f077a4f954443063ba945c8141f64ba56b737c420a805ca4bee68da' },
    model: {
      repo: 'facebook/sam2-hiera-tiny',
      revision: '7c218beaf0bb87874785f32b582f640134fc1c09',
      license: 'Apache-2.0',
    },
    proposals,
  }
  const h4cRecord = {
    state: 'complete',
    integrity_after: { unchanged: true },
    h4a_output: { sha256: H4A_OUTPUT_SHA256 },
    h4a_freeze: { sha256: H4A_FREEZE_SHA256 },
    source: { sha256: sourceSha },
    candidate_count: 36,
    protocol: {
      clip_to_box: false,
      multimask_output: false,
      image_encoding_calls: 1,
      prompt_count: 36,
      mask_frame: 'full original source',
      order: 'frozen H4a candidate order',
    },
    model: {
      repo: 'facebook/sam2-hiera-tiny',
      revision: '7c218beaf0bb87874785f32b582f640134fc1c09',
      license: 'Apache-2.0',
    },
    results: rows,
  }
  const truth: V03PilotTruth[] = [
    {
      caseId: 'ui-case-01',
      sourceCaseId: 'source1',
      stratum: 'ui',
      presence: 'present',
      imageSha256: sourceSha,
      sourceWidth: 4,
      sourceHeight: 4,
      boxes: [{ left: 0, top: 0, width: 3, height: 3 }],
      referenceMasks: [],
    },
    {
      caseId: 'ui-case-02',
      sourceCaseId: 'source2',
      stratum: 'ui',
      presence: 'present',
      imageSha256: sourceSha,
      sourceWidth: 4,
      sourceHeight: 4,
      boxes: [{ left: 0, top: 0, width: 3, height: 3 }],
      referenceMasks: [],
    },
    {
      caseId: 'ui-case-03',
      sourceCaseId: 'source3',
      stratum: 'ui',
      presence: 'present',
      imageSha256: sourceSha,
      sourceWidth: 4,
      sourceHeight: 4,
      boxes: [{ left: 0, top: 0, width: 3, height: 3 }],
      referenceMasks: [],
    },
    {
      caseId: 'ui-case-04',
      sourceCaseId: 'source4',
      stratum: 'ui',
      presence: 'absent',
      imageSha256: sourceSha,
      sourceWidth: 4,
      sourceHeight: 4,
      boxes: [],
      referenceMasks: [],
    },
  ]
  const input = {
    h4aRecord,
    h4aRunSha256: H4A_OUTPUT_SHA256,
    expectedH4aRunSha256: H4A_OUTPUT_SHA256,
    h4aFreezeSha256: H4A_FREEZE_SHA256,
    expectedH4aFreezeSha256: H4A_FREEZE_SHA256,
    h4cRecord,
    h4cRunSha256: 'a'.repeat(64),
    expectedH4cRunSha256: 'a'.repeat(64),
    h4cFreezeRecord,
    h4cFreezeSha256: 'b'.repeat(64),
    expectedH4cFreezeSha256: 'b'.repeat(64),
    rows,
    truth,
    runRoot,
    imageRoot: root,
  }
  return { input, root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

await test('H4c scores actual full-source pixels and retains empty masks and negative candidates', async () => {
  const fixture = await makeFixture()
  try {
    const report = await evaluateH4cMaskAvailability(fixture.input)
    assert.equal(report.plannedCases, 4)
    assert.equal(report.positives, 3)
    assert.equal(report.negatives, 1)
    assert.equal(report.positiveBoxAvailabilityPasses, 3)
    assert.equal(report.invalidMasks, 0)
    assert.equal(report.emptyMasks, 35)
    assert.equal(report.negativesWithMaskCandidates, 1)
    assert.equal(report.perCase[0]?.candidates[0]?.wholeBoxPass, true)
    assert.equal(report.perCase[0]?.candidates[0]?.bestTargetCoverage, 1)
    assert.deepEqual(report.perCase[0]?.candidates[0]?.maskBox, {
      left: 0,
      top: 0,
      width: 3,
      height: 3,
    })
    assert.equal(report.perCase[0]?.candidates[0]?.promptBox?.left, 1)
    assert.equal(report.perCase[0]?.candidates[0]?.foregroundPixels, 9)
    assert.equal(report.perCase[0]?.candidates[1]?.artifactStatus, 'valid')
    assert.equal(report.perCase[0]?.candidates[1]?.foregroundPixels, 0)
  } finally {
    await fixture.cleanup()
  }
})

await test('H4c rejects forged pixel geometry descriptors and excludes invalid masks from availability', async () => {
  const fixture = await makeFixture()
  try {
    const rows = fixture.input.rows as Array<Record<string, unknown>>
    rows[0]!.mask_box_xyxy = [1, 1, 2, 2]
    const report = await evaluateH4cMaskAvailability(fixture.input)
    assert.equal(report.positiveBoxAvailabilityPasses, 0)
    assert.equal(report.invalidMasks, 1)
    assert.equal(report.perCase[0]?.candidates[0]?.artifactError, 'mask-box-descriptor-mismatch')
  } finally {
    await fixture.cleanup()
  }
})

await test('H4c requires the external run hash and exact H4a pre-inference linkage', async () => {
  const fixture = await makeFixture()
  try {
    await assert.rejects(
      evaluateH4cMaskAvailability({ ...fixture.input, expectedH4cRunSha256: 'c'.repeat(64) }),
      /External H4c run.json hash lock mismatch/u,
    )
    const freeze = fixture.input.h4cFreezeRecord as unknown as {
      proposals: Array<{ flat_index: number }>
    }
    freeze.proposals[0]!.flat_index++
    await assert.rejects(evaluateH4cMaskAvailability(fixture.input), /freeze proposal mismatch/u)
  } finally {
    await fixture.cleanup()
  }
})
