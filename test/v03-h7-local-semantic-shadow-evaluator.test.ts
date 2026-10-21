import assert from 'node:assert/strict'
import test from 'node:test'
import type { H5AvailabilityReport } from '../benchmarks/v03/evaluate-h5-selection.js'
import {
  evaluateH7LocalSemanticShadow,
  type H7Candidate,
  type H7Freeze,
  type H7LocalSemanticShadowRun,
  type H7Row,
} from '../benchmarks/v03/evaluate-h7-local-semantic-shadow.js'

const caseIds = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]
const digest = (char: string) => char.repeat(64)

function fixture() {
  const perCase = caseIds.map((caseId, index) => {
    const negative = caseId.endsWith('-04')
    const mapNoUnion = caseId === 'pilot-v03-map-02'
    const h3Pass = !negative && !mapNoUnion && caseId !== 'pilot-v03-map-01'
    const h4ePass = !negative && !mapNoUnion
    const h3 = {
      family: 'h3-dino-sam2',
      id: `C${String(index).padStart(2, '0')}`,
      maskSha256: digest(String(index % 10)),
      box: { left: 10, top: 10, width: 10, height: 10 },
      score: { pass: h3Pass },
    }
    const h4e = {
      family: 'h4e-sam2',
      id: `U${String(index).padStart(2, '0')}`,
      maskSha256: digest(String((index + 1) % 10)),
      box: { left: 30, top: 12, width: 10, height: 10 },
      score: { pass: h4ePass },
    }
    const omni = {
      family: 'omni-sam2',
      id: `O${String(index).padStart(2, '0')}`,
      maskSha256: digest(String((index + 3) % 10)),
      box: { left: 10, top: 10, width: 10, height: 10 },
      score: { pass: h4ePass },
    }
    return {
      caseId,
      presence: negative ? ('absent' as const) : ('present' as const),
      sourceSha256: digest(String((index + 2) % 10)),
      sourceDimensions: { width: 64, height: 48 },
      families: {
        'h3-dino-sam2': { available: h3Pass, candidateReceipts: [h3] },
        'omni-sam2': { available: h4ePass, candidateReceipts: [omni] },
        'h4e-sam2': { available: h4ePass, candidateReceipts: [h4e] },
        union: { available: h3Pass || h4ePass, candidateReceipts: [] },
      },
    }
  })
  const availability: H5AvailabilityReport = {
    schema: 'v03-h5a-native-proposal-availability-evaluation-v1',
    runSha256: '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0',
    freezeSha256: 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566',
    gate: { iouAtLeast: 0.5, referenceCoverageAtLeast: 0.9, sameCandidateAndReference: true },
    perCase,
  }
  const rows: H7Row[] = perCase.map((truth) => {
    const index = caseIds.indexOf(truth.caseId)
    const failed = truth.caseId === 'pilot-v03-photo-03'
    const candidates: H7Candidate[] = [
      {
        family: 'D',
        ordinal: 0,
        alias: 'D00',
        source_family: 'h3b-dino-sam2',
        source_alias: `C${String(index).padStart(2, '0')}`,
        source_mask_path: 'h3b/C00.png',
        source_mask_sha256: digest(String(index % 10)),
        crop_xyxy: failed ? null : [7, 7, 23, 23],
        resize_geometry: failed
          ? null
          : {
              crop_xyxy: [7, 7, 23, 23],
              source_crop_size: [16, 16],
              resized_size: [512, 512],
              pad_ltrb: [0, 0, 0, 0],
              output_size: [512, 512],
            },
        clean_cosine: failed ? null : 0.8,
        masked_cosine: failed ? null : 0.6,
        mean_cosine: failed ? null : 0.7,
        global_rank: failed ? null : 1,
        family_rank: failed ? null : 1,
      },
      {
        family: 'U',
        ordinal: 0,
        alias: 'U00',
        source_family: 'omni-sam2',
        source_alias: `O${String(index).padStart(2, '0')}`,
        source_mask_path: 'omni/U00.png',
        source_mask_sha256: digest(String((index + 3) % 10)),
        crop_xyxy: failed ? null : [7, 7, 23, 23],
        resize_geometry: failed
          ? null
          : {
              crop_xyxy: [7, 7, 23, 23],
              source_crop_size: [16, 16],
              resized_size: [512, 512],
              pad_ltrb: [0, 0, 0, 0],
              output_size: [512, 512],
            },
        clean_cosine: failed ? null : 0.75,
        masked_cosine: failed ? null : 0.55,
        mean_cosine: failed ? null : 0.65,
        global_rank: failed ? null : 2,
        family_rank: failed ? null : 1,
      },
      {
        family: 'U',
        ordinal: 1,
        alias: 'U01',
        source_family: 'h4e-sam2',
        source_alias: `U${String(index).padStart(2, '0')}`,
        source_mask_path: 'h4e/U00.png',
        source_mask_sha256: digest(String((index + 1) % 10)),
        crop_xyxy: failed ? null : [27, 9, 43, 25],
        resize_geometry: failed
          ? null
          : {
              crop_xyxy: [27, 9, 43, 25],
              source_crop_size: [16, 16],
              resized_size: [512, 512],
              pad_ltrb: [0, 0, 0, 0],
              output_size: [512, 512],
            },
        clean_cosine: failed ? null : 0.7,
        masked_cosine: failed ? null : 0.5,
        mean_cosine: failed ? null : 0.6,
        global_rank: failed ? null : 3,
        family_rank: failed ? null : 2,
      },
    ]
    return {
      case_id: truth.caseId,
      status: failed ? 'error' : 'complete',
      target: 'authored target',
      source_sha256: truth.sourceSha256,
      source_width: 64,
      source_height: 48,
      candidates,
      ...(failed ? { error_code: 'test-error' } : {}),
    }
  })
  const freeze: H7Freeze = {
    schema: 'v03-h7-local-semantic-shadow-freeze-v1',
    status: 'frozen-before-inference',
    source_locks: {
      h5a_run_sha256: availability.runSha256,
      h5a_freeze_sha256: availability.freezeSha256,
      h5a_integrity_sha256: '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50',
      h5a_worker_closure_sha256: 'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f',
      h3b_run_sha256: 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401',
      h4e_run_sha256: 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4',
    },
    asset_lock: {
      model_id: 'google/siglip2-base-patch16-512',
      revision: 'a89f5c5093f902bf39d3cd4d81d2c09867f0724b',
      license: 'apache-2.0',
      asset_directory: '/tmp/h7-assets',
      files: [
        { path: 'config.json', sha256: digest('a'), bytes: 1 },
        {
          path: 'model.safetensors',
          sha256: 'fe0e601c625e69eed8e73500d39e9b6164403fe03db8048e87913c3cefbbb3fe',
          bytes: 1503344520,
        },
        { path: 'preprocessor_config.json', sha256: digest('b'), bytes: 1 },
        { path: 'special_tokens_map.json', sha256: digest('c'), bytes: 1 },
        {
          path: 'tokenizer.json',
          sha256: 'cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322',
          bytes: 1,
        },
        { path: 'tokenizer_config.json', sha256: digest('d'), bytes: 1 },
      ],
    },
    source_roots: {
      h5a_run_directory: '/tmp/h5a',
      h3b_run_directory: '/tmp/h3b',
      h4e_run_directory: '/tmp/h4e',
      source_image_root: '/tmp/images',
    },
    source_closure: [],
    input_json: { path: '/tmp/h7-input.json', sha256: digest('e'), bytes: 1 },
    case_ids: [...caseIds],
    limits: {
      initialization_ms: 120_000,
      case_ms: 240_000,
      candidates: 72,
      per_family: 36,
      packed_bytes: 19 * 1024 * 1024,
      cuda_allocated_bytes: 10 * 1024 ** 3,
      batch_candidates: 2,
    },
    recipe: {
      context_fraction: 0.25,
      view_weights: [0.5, 0.5],
      input_size: 512,
      padding_rgb: [128, 128, 128],
      text_padding: 'max_length',
      truncate: false,
      processor_resize: false,
      normalize_dtype: 'float32',
      presence: 'not-a-presence-decision',
    },
    python_runtime: {},
  }
  const replay: H7LocalSemanticShadowRun = {
    schema: 'v03-h7-local-semantic-shadow-run-v1',
    status: 'complete',
    freeze_sha256: digest('f'),
    case_ids: [...caseIds],
    rows,
    source_closure_post: [],
    asset_lock_post: freeze.asset_lock,
    worker: { pid: 123, exit_code: 0, closed: true },
  }
  return { availability, freeze, replay }
}

await test('H7 joins stable global/family ranks to exact H5a mask receipts', () => {
  const { availability, freeze, replay } = fixture()
  const result = evaluateH7LocalSemanticShadow(availability, freeze, replay)
  assert.deepEqual(result.positives.byStratum.photo, {
    denominator: 3,
    completedRows: 2,
    topOne: 2,
    topFour: 2,
    errorsOrTimeouts: ['pilot-v03-photo-03'],
  })
  assert.deepEqual(result.positives.byStratum.ui, {
    denominator: 3,
    completedRows: 3,
    topOne: 3,
    topFour: 3,
    errorsOrTimeouts: [],
  })
  assert.deepEqual(result.positives.byStratum.map, {
    denominator: 3,
    completedRows: 3,
    topOne: 1,
    topFour: 2,
    errorsOrTimeouts: [],
  })
  assert.equal(result.positives.denominator, 9)
  assert.equal(result.positives.topOne, 6)
  assert.equal(result.positives.topFour, 7)
  assert.equal(result.negativeRows.length, 3)
  assert(result.negativeRows.every((row) => row.topOneAvailable === null))
  assert(result.negativeRows.every((row) => Array.isArray(row.negativeTopFour)))
})

await test('H7 rejects mask identity drift, forged scores, and unstable ranks', () => {
  const { availability, freeze, replay } = fixture()
  replay.rows[0]!.candidates[0]!.source_mask_sha256 = digest('f')
  assert.throws(
    () => evaluateH7LocalSemanticShadow(availability, freeze, replay),
    /h7-candidate-mask-hash/,
  )

  const second = fixture()
  second.replay.rows[0]!.candidates[0]!.mean_cosine = 0.8
  assert.throws(
    () => evaluateH7LocalSemanticShadow(second.availability, second.freeze, second.replay),
    /h7-mean-cosine/,
  )

  const third = fixture()
  third.replay.rows[0]!.candidates[0]!.global_rank = 2
  assert.throws(
    () => evaluateH7LocalSemanticShadow(third.availability, third.freeze, third.replay),
    /h7-global-rank/,
  )

  const fourth = fixture()
  fourth.replay.rows[0]!.candidates[0]!.crop_xyxy = [0, 0, 64, 48]
  assert.throws(
    () => evaluateH7LocalSemanticShadow(fourth.availability, fourth.freeze, fourth.replay),
    /h7-crop-does-not-match-foreground/,
  )

  const tied = fixture()
  for (const candidate of tied.replay.rows[0]!.candidates) {
    candidate.clean_cosine = 0.5
    candidate.masked_cosine = 0.5
    candidate.mean_cosine = 0.5
  }
  assert.doesNotThrow(() =>
    evaluateH7LocalSemanticShadow(tied.availability, tied.freeze, tied.replay),
  )
  tied.replay.rows[0]!.candidates[0]!.global_rank = 2
  tied.replay.rows[0]!.candidates[1]!.global_rank = 1
  assert.throws(
    () => evaluateH7LocalSemanticShadow(tied.availability, tied.freeze, tied.replay),
    /h7-global-rank/,
  )

  const wrongOmniFamily = fixture()
  wrongOmniFamily.replay.rows[0]!.candidates[1]!.family = 'D'
  assert.throws(
    () =>
      evaluateH7LocalSemanticShadow(
        wrongOmniFamily.availability,
        wrongOmniFamily.freeze,
        wrongOmniFamily.replay,
      ),
    /h7-candidate-family/,
  )

  const errorGeometry = fixture()
  errorGeometry.replay.rows[2]!.candidates[0]!.crop_xyxy = [1, 1, 2, 2]
  assert.throws(
    () =>
      evaluateH7LocalSemanticShadow(
        errorGeometry.availability,
        errorGeometry.freeze,
        errorGeometry.replay,
      ),
    /h7-error-row-geometry-must-be-null/,
  )
})

await test('H7 rejects changed source locks and post-run asset or source closure drift', () => {
  const keyOrderOnly = fixture()
  const { model_id, revision, license, asset_directory, files } =
    keyOrderOnly.replay.asset_lock_post
  keyOrderOnly.replay.asset_lock_post = { files, asset_directory, license, revision, model_id }
  assert.doesNotThrow(() =>
    evaluateH7LocalSemanticShadow(
      keyOrderOnly.availability,
      keyOrderOnly.freeze,
      keyOrderOnly.replay,
    ),
  )

  const wrongLock = fixture()
  wrongLock.freeze.source_locks.h4e_run_sha256 = digest('f')
  assert.throws(
    () => evaluateH7LocalSemanticShadow(wrongLock.availability, wrongLock.freeze, wrongLock.replay),
    /h7-h4e-run-lock/,
  )

  const changedAsset = fixture()
  changedAsset.replay.asset_lock_post = {
    ...changedAsset.replay.asset_lock_post,
    revision: 'changed',
  }
  assert.throws(
    () =>
      evaluateH7LocalSemanticShadow(
        changedAsset.availability,
        changedAsset.freeze,
        changedAsset.replay,
      ),
    /h7-asset-lock-postrun-mismatch/,
  )

  const changedSource = fixture()
  changedSource.freeze.source_closure.push({
    path: '/tmp/source.py',
    sha256: digest('a'),
    bytes: 1,
  })
  assert.throws(
    () =>
      evaluateH7LocalSemanticShadow(
        changedSource.availability,
        changedSource.freeze,
        changedSource.replay,
      ),
    /h7-source-closure-postrun-mismatch/,
  )
})
