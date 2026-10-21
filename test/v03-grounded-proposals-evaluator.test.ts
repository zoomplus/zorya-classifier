import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import sharp from 'sharp'
import type { FreshCase } from '../benchmarks/v02/fresh-corpus.js'
import type { V03PilotTruth } from '../benchmarks/v03/evaluate-pilot.js'
import {
  evaluateGroundedProposalAvailability,
  type EvaluateGroundedProposalInput,
} from '../benchmarks/v03/evaluate-grounded-proposals-pilot.js'
import { v03PilotManifests } from '../benchmarks/v03/pilot-manifest.js'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const sourceHash = 'a'.repeat(64)
const pin = 'b'.repeat(64)

async function fixture(): Promise<{
  input: EvaluateGroundedProposalInput
  root: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'v03-h3-evaluator-'))
  const runRoot = join(root, 'run')
  const imageRoot = join(root, 'images')
  await mkdir(join(runRoot, 'cases'), { recursive: true })
  await mkdir(join(runRoot, 'masks'), { recursive: true })
  await mkdir(join(imageRoot, 'refs'), { recursive: true })
  const corpus: FreshCase[] = []
  const truth: V03PilotTruth[] = []
  const caseRecords: Array<{ case_id: string; status: string; row_sha256?: string }> = []
  const refBits = Buffer.alloc(16)
  const maskBits = Buffer.alloc(16)
  for (let y = 1; y < 3; y++) {
    for (let x = 1; x < 3; x++) {
      refBits[y * 4 + x] = 255
      maskBits[y * 4 + x] = 255
    }
  }
  const referenceBytes = await sharp(refBits, { raw: { width: 4, height: 4, channels: 1 } })
    .png()
    .toBuffer()
  await writeFile(join(imageRoot, 'refs', 'ref.png'), referenceBytes)
  const candidateBytes = await sharp(maskBits, { raw: { width: 4, height: 4, channels: 1 } })
    .greyscale()
    .png()
    .toBuffer()
  await mkdir(join(runRoot, 'masks', 'photo-case-00'), { recursive: true })
  await writeFile(join(runRoot, 'masks', 'photo-case-00', 'C00.png'), candidateBytes)

  for (let index = 0; index < 12; index++) {
    const caseId =
      index < 4
        ? `photo-case-${String(index).padStart(2, '0')}`
        : index < 8
          ? `ui-case-${String(index).padStart(2, '0')}`
          : `map-case-${String(index).padStart(2, '0')}`
    const stratum = index < 4 ? 'photo' : index < 8 ? 'ui' : 'map'
    const presence = index % 4 === 3 ? 'absent' : 'present'
    corpus.push({
      caseId,
      image: { path: `${caseId}.png`, sha256: sourceHash, width: 4, height: 4 },
      locate: { target: 'object' },
      classify: { options: ['present', 'absent'] },
    })
    truth.push({
      caseId,
      sourceCaseId: caseId,
      stratum,
      presence,
      imageSha256: sourceHash,
      sourceWidth: 4,
      sourceHeight: 4,
      boxes: presence === 'present' ? [{ left: 1, top: 1, width: 2, height: 2 }] : [],
      referenceMasks:
        index === 0
          ? [
              {
                path: 'refs/ref.png',
                sha256: digest(referenceBytes),
                width: 4,
                height: 4,
                resampling:
                  'nearest-neighbor to the acquired Open Images JPEG raster; verified 0/255 binary values',
              },
            ]
          : [],
    })
    const status = index === 1 ? 'error' : index === 2 ? 'not_started' : 'complete'
    if (status === 'not_started') {
      caseRecords.push({ case_id: caseId, status })
      continue
    }
    const isCandidate = index === 0
    const row = {
      case_id: caseId,
      status,
      source_sha256: status === 'complete' ? sourceHash : undefined,
      source_dimensions: status === 'complete' ? { width: 4, height: 4 } : undefined,
      detector_candidate_count: isCandidate ? 1 : 0,
      candidate_cap: 36,
      truncated_detector_count: 0,
      detector_candidates: isCandidate
        ? [{ detector_index: 0, box_xyxy: [1, 1, 3, 3], score: 0.9, label: 'object' }]
        : [],
      mask_candidates: isCandidate
        ? [
            {
              id: 'C00',
              detector_index: 0,
              box_xyxy: [1, 1, 3, 3],
              score: 0.9,
              mask_path: `masks/${caseId}/C00.png`,
              mask_sha256: digest(candidateBytes),
              mask_box_xyxy: [1, 1, 3, 3],
              sam2_mask_threshold: 0,
            },
          ]
        : [],
      error: status === 'error' ? 'mock-worker-failure' : undefined,
    }
    const bytes = Buffer.from(JSON.stringify(row))
    await writeFile(join(runRoot, 'cases', `${caseId}.json`), bytes)
    caseRecords.push({ case_id: caseId, status, row_sha256: digest(bytes) })
  }

  const runRecord = {
    schema: 'v03-grounded-proposals-probe-v1',
    status: 'incomplete',
    cohort: 'fixed-v03-dev-12-effc2e8',
    case_ids: corpus.map((item) => item.caseId),
    manifest_sha256: Object.fromEntries(
      v03PilotManifests.map((manifest) => [manifest.path.split(/[\\/]/u).at(-1)!, manifest.sha256]),
    ),
    source_freeze: { producer_script_sha256: pin, environment_freeze_sha256: pin },
    cases: caseRecords,
    model_assets: {},
  }
  const runSha256 = digest(Buffer.from(JSON.stringify(runRecord)))
  return {
    root,
    input: {
      corpus,
      truth,
      runRecord,
      runSha256,
      expectedRunSha256: runSha256,
      runRoot,
      imageRoot,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

await test('H3 availability uses decoded mask pixels and retains failures and negatives', async () => {
  const data = await fixture()
  try {
    const result = await evaluateGroundedProposalAvailability(data.input)
    assert.equal(result.plannedCases, 12)
    assert.equal(result.positives, 9)
    assert.equal(result.negatives, 3)
    assert.equal(result.positiveMaskBoxPasses, 1)
    assert.equal(result.failedOrMissingCases, 2)
    assert.equal(result.zeroMaskCandidateCases, 11)
    assert.equal(result.negativesWithCandidates, 0)
    assert.equal(result.perCase[0]?.candidates[0]?.artifactStatus, 'valid')
    assert.equal(result.perCase[0]?.candidates[0]?.maskWholeBoxPass, true)
    assert.equal(result.perCase[0]?.candidates[0]?.detectorWholeBoxPass, true)
    assert.equal(result.perCase[0]?.bestMaskIoU, 1)
    assert.equal(result.stratumSummary['photo']?.positives, 3)
  } finally {
    await data.cleanup()
  }
})

await test('H3 rejects a forged mask box descriptor and never counts it as available', async () => {
  const data = await fixture()
  try {
    const candidatePath = join(data.input.runRoot, 'cases', 'photo-case-00.json')
    const row = JSON.parse(await readFile(candidatePath, 'utf8')) as {
      mask_candidates: Array<{ mask_box_xyxy: number[] }>
    }
    row.mask_candidates[0]!.mask_box_xyxy = [0, 0, 4, 4]
    const bytes = Buffer.from(JSON.stringify(row))
    await writeFile(candidatePath, bytes)
    const runRecord = data.input.runRecord as {
      cases: Array<{ case_id: string; row_sha256?: string }>
    }
    runRecord.cases[0]!.row_sha256 = digest(bytes)
    data.input.runSha256 = digest(Buffer.from(JSON.stringify(runRecord)))
    data.input.expectedRunSha256 = data.input.runSha256
    const result = await evaluateGroundedProposalAvailability(data.input)
    assert.equal(result.positiveMaskBoxPasses, 0)
    assert.equal(result.perCase[0]?.candidates[0]?.artifactStatus, 'invalid')
    assert.equal(
      result.perCase[0]?.candidateErrors.includes('C00:mask-box-descriptor-mismatch'),
      true,
    )
  } finally {
    await data.cleanup()
  }
})

await test('H3 requires an externally matching closed-run hash and all attempted row hashes', async () => {
  const data = await fixture()
  try {
    await assert.rejects(
      evaluateGroundedProposalAvailability({ ...data.input, expectedRunSha256: 'c'.repeat(64) }),
      /external freeze lock/u,
    )
    const runRecord = structuredClone(data.input.runRecord) as {
      cases: Array<{ case_id: string; status: string; row_sha256?: string }>
    }
    delete runRecord.cases[0]!.row_sha256
    data.input.runRecord = runRecord
    data.input.runSha256 = digest(Buffer.from(JSON.stringify(runRecord)))
    data.input.expectedRunSha256 = data.input.runSha256
    await assert.rejects(
      evaluateGroundedProposalAvailability(data.input),
      /missing its pinned row hash/u,
    )
  } finally {
    await data.cleanup()
  }
})
