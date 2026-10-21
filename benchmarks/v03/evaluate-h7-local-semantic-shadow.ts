import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { H5AvailabilityReport } from './evaluate-h5-selection.js'

const H5A_RUN_SHA256 = '86d0aab4f7fad3ce0fae182b840ddd540275309471b27cb091dc4e85866d56f0'
const H5A_FREEZE_SHA256 = 'b808985a17b150c1adbc2467bd0df4797a3a6b242db2ba99b174c2fb0f9e6566'
const H3B_RUN_SHA256 = 'df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401'
const H4E_RUN_SHA256 = 'dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4'
const H5A_EVALUATION_SHA256 = 'f0e3bfc0512da194d9a835c1241a8269988c14ea226199976c18f9de2f866397'
const MODEL_SHA256 = 'fe0e601c625e69eed8e73500d39e9b6164403fe03db8048e87913c3cefbbb3fe'
const TOKENIZER_SHA256 = 'cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322'
const ASSET_FILE_NAMES = [
  'config.json',
  'model.safetensors',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
]

const CASE_IDS = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
]
const PILOT_INPUT_PATHS = [
  'benchmarks/v03/pilot-inputs/photo.json',
  'benchmarks/v03/pilot-inputs/ui.json',
  'benchmarks/v03/pilot-inputs/map.json',
]

export type H7Candidate = {
  family: 'D' | 'U'
  ordinal: number
  alias: string
  source_family: 'h3b-dino-sam2' | 'omni-sam2' | 'h4e-sam2'
  source_alias: string
  source_mask_path: string
  source_mask_sha256: string
  crop_xyxy: [number, number, number, number] | null
  resize_geometry: {
    crop_xyxy: [number, number, number, number]
    source_crop_size: [number, number]
    resized_size: [number, number]
    pad_ltrb: [number, number, number, number]
    output_size: [number, number]
  } | null
  clean_cosine: number | null
  masked_cosine: number | null
  mean_cosine: number | null
  global_rank: number | null
  family_rank: number | null
}

export type H7Row = {
  case_id: string
  status: 'complete' | 'error' | 'timeout'
  target: string
  source_sha256: string
  source_width: number
  source_height: number
  candidates: H7Candidate[]
  timing_ms?: Record<string, number>
  memory?: { allocated_peak_bytes: number | null; reserved_peak_bytes: number | null }
  error_code?: string | null
}

export type H7SourceLocks = {
  h5a_run_sha256: string
  h5a_freeze_sha256: string
  h5a_integrity_sha256: string
  h5a_worker_closure_sha256: string
  h3b_run_sha256: string
  h4e_run_sha256: string
}

export type H7AssetLock = {
  model_id: string
  revision: string
  license: string
  asset_directory: string
  files: Array<{ path: string; sha256: string; bytes: number }>
}

export type H7SourceRoots = {
  h5a_run_directory: string
  h3b_run_directory: string
  h4e_run_directory: string
  source_image_root: string
}

export type H7Freeze = {
  schema: 'v03-h7-local-semantic-shadow-freeze-v1'
  status: 'frozen-before-inference'
  source_locks: H7SourceLocks
  asset_lock: H7AssetLock
  source_roots: H7SourceRoots
  source_closure: Array<{ path: string; sha256: string; bytes: number }>
  input_json: { path: string; sha256: string; bytes: number }
  case_ids: string[]
  limits: Record<string, unknown>
  recipe: Record<string, unknown>
  python_runtime: Record<string, unknown>
}

export type H7LocalSemanticShadowRun = {
  schema: 'v03-h7-local-semantic-shadow-run-v1'
  status: string
  freeze_sha256: string
  case_ids: string[]
  rows: H7Row[]
  source_closure_post: H7Freeze['source_closure']
  asset_lock_post: H7AssetLock
  worker: { pid: number | null; exit_code: number | null; closed: boolean }
  runtime?: Record<string, unknown> | null
  elapsed_ms?: number
  error?: string | null
  integrity_errors?: string[]
  input_artifacts_unchanged?: boolean
}

type CandidateReceipt = {
  family: 'h3-dino-sam2' | 'omni-sam2' | 'h4e-sam2'
  id: string
  maskSha256: string
  box: { left: number; top: number; width: number; height: number }
  score: { pass: boolean } | null
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk)
    bytes += chunk.byteLength
  }
  return { sha256: digest.digest('hex'), bytes }
}

type FrozenInputCase = {
  case_id?: string
  caseId?: string
  target?: string
  source_path?: string
  source_sha256?: string
  source_width?: number
  source_height?: number
  source_roots?: H7SourceRoots
  image?: { path: string; sha256: string; width: number; height: number }
  locate?: { target: string }
}

async function validateH7Inputs(
  inputJson: unknown,
  availability: H5AvailabilityReport,
  freeze: H7Freeze,
  repositoryRoot: string,
): Promise<void> {
  assert(inputJson !== null && typeof inputJson === 'object', 'h7-input-json-object')
  const payload = inputJson as { cases?: FrozenInputCase[]; source_roots?: H7SourceRoots }
  assert(Array.isArray(payload.cases), 'h7-input-cases')
  assert(payload.source_roots, 'h7-input-source-roots')
  assert(
    isDeepStrictEqual(payload.source_roots, freeze.source_roots),
    'h7-input-source-roots-mismatch',
  )
  const frozenManifests = []
  for (const path of PILOT_INPUT_PATHS) {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8')) as Array<{
      caseId: string
      image: { path: string; sha256: string; width: number; height: number }
      locate: { target: string }
    }>
    frozenManifests.push(...manifest)
  }
  const expectedById = new Map(frozenManifests.map((item) => [item.caseId, item]))
  assert(
    JSON.stringify(payload.cases.map((item) => item.case_id ?? item.caseId)) ===
      JSON.stringify(CASE_IDS),
    'h7-input-case-order',
  )
  const availabilityById = new Map(availability.perCase.map((item) => [item.caseId, item]))
  const sourceRoot = await realpath(freeze.source_roots.source_image_root)
  for (const item of payload.cases) {
    const caseId = item.case_id ?? item.caseId
    assert(caseId, 'h7-input-case-id')
    const expected = expectedById.get(caseId)
    const truth = availabilityById.get(caseId)
    assert(expected && truth, `h7-input-unexpected-case-${caseId}`)
    if (item.source_roots)
      assert(
        isDeepStrictEqual(item.source_roots, freeze.source_roots),
        `h7-case-source-roots-${caseId}`,
      )
    const target = item.target ?? item.locate?.target
    const sourceSha256 = item.source_sha256 ?? item.image?.sha256
    const sourceWidth = item.source_width ?? item.image?.width
    const sourceHeight = item.source_height ?? item.image?.height
    assert(target === expected.locate.target, `h7-input-target-mismatch-${caseId}`)
    assert(sourceSha256 === expected.image.sha256, `h7-input-source-hash-mismatch-${caseId}`)
    assert(
      sourceSha256 === truth.sourceSha256 &&
        sourceWidth === expected.image.width &&
        sourceHeight === expected.image.height,
      `h7-input-source-identity-mismatch-${caseId}`,
    )
    const suppliedSourcePath = item.source_path ?? item.image?.path
    assert(
      typeof suppliedSourcePath === 'string' && suppliedSourcePath.length > 0,
      `h7-input-source-path-${caseId}`,
    )
    const expectedPath = resolve(sourceRoot, expected.image.path)
    const actualPath = resolve(sourceRoot, suppliedSourcePath)
    const [expectedReal, actualReal] = await Promise.all([
      realpath(expectedPath),
      realpath(actualPath),
    ])
    assert(actualReal === expectedReal, `h7-input-source-path-mismatch-${caseId}`)
    const sourceReceipt = await hashFile(actualReal)
    assert(
      sourceReceipt.sha256 === expected.image.sha256,
      `h7-input-source-bytes-mismatch-${caseId}`,
    )
  }
}

function sourceFamily(name: CandidateReceipt['family']): H7Candidate['source_family'] {
  if (name === 'h3-dino-sam2') return 'h3b-dino-sam2'
  return name
}

function candidateReferences(truth: H5AvailabilityReport['perCase'][number]) {
  const byKey = new Map<string, CandidateReceipt>()
  for (const family of ['h3-dino-sam2', 'omni-sam2', 'h4e-sam2'] as const) {
    for (const item of truth.families[family]?.candidateReceipts ?? []) {
      const key = `${sourceFamily(item.family as CandidateReceipt['family'])}\0${item.id}`
      assert(!byKey.has(key), `h7-truth-duplicate-reference-${truth.caseId}-${key}`)
      byKey.set(key, item as CandidateReceipt)
    }
  }
  return byKey
}

function stratum(caseId: string): 'photo' | 'ui' | 'map' {
  if (caseId.startsWith('pilot-v03-photo-')) return 'photo'
  if (caseId.startsWith('pilot-v03-ui-')) return 'ui'
  if (caseId.startsWith('pilot-v03-map-')) return 'map'
  throw new Error(`h7-unknown-stratum-${caseId}`)
}

function checkRanks(row: H7Row): void {
  const ranked = row.candidates.filter(
    (candidate) => candidate.mean_cosine !== null && candidate.global_rank !== null,
  )
  const expected = [...ranked].sort(
    (a, b) =>
      b.mean_cosine! - a.mean_cosine! ||
      (a.family === b.family ? 0 : a.family === 'D' ? -1 : 1) ||
      a.ordinal - b.ordinal,
  )
  expected.forEach((candidate, index) => {
    assert(candidate.global_rank === index + 1, `h7-global-rank-mismatch-${row.case_id}`)
  })
  for (const family of ['D', 'U'] as const) {
    const familyRanked = row.candidates
      .filter(
        (candidate) =>
          candidate.family === family &&
          candidate.mean_cosine !== null &&
          candidate.family_rank !== null,
      )
      .sort((a, b) => b.mean_cosine! - a.mean_cosine! || a.ordinal - b.ordinal)
    familyRanked.forEach((candidate, index) => {
      assert(
        candidate.family_rank === index + 1,
        `h7-family-rank-mismatch-${row.case_id}-${family}`,
      )
    })
  }
}

function validateRow(row: H7Row, truth: H5AvailabilityReport['perCase'][number]): void {
  assert(['complete', 'error', 'timeout'].includes(row.status), `h7-row-status-${row.case_id}`)
  assert(typeof row.target === 'string' && row.target.length > 0, `h7-target-row-${row.case_id}`)
  assert(row.source_sha256 === truth.sourceSha256, `h7-source-hash-${row.case_id}`)
  assert(
    row.source_width === truth.sourceDimensions.width &&
      row.source_height === truth.sourceDimensions.height,
    `h7-source-dimensions-${row.case_id}`,
  )
  const references = candidateReferences(truth)
  const orderedReferenceKeys = [...references.keys()]
  const actual = new Set<string>()
  let lastFamily: 'D' | 'U' = 'D'
  let lastOrdinal = -1
  for (const [candidateIndex, candidate] of row.candidates.entries()) {
    const expectedFamily = candidate.source_family === 'h3b-dino-sam2' ? 'D' : 'U'
    assert(candidate.family === expectedFamily, `h7-candidate-family-${row.case_id}`)
    assert(candidate.family === 'D' || candidate.family === 'U', `h7-family-${row.case_id}`)
    assert(
      candidate.ordinal >= 0 && Number.isInteger(candidate.ordinal),
      `h7-ordinal-${row.case_id}`,
    )
    assert(
      candidate.family === lastFamily || (lastFamily === 'D' && candidate.family === 'U'),
      `h7-roster-family-order-${row.case_id}`,
    )
    if (candidate.family !== lastFamily) {
      lastFamily = candidate.family
      lastOrdinal = -1
    }
    assert(candidate.ordinal === lastOrdinal + 1, `h7-roster-ordinal-order-${row.case_id}`)
    lastOrdinal = candidate.ordinal
    assert(
      candidate.alias === `${candidate.family}${String(candidate.ordinal).padStart(2, '0')}`,
      `h7-alias-${row.case_id}`,
    )
    assert(candidate.source_mask_path.length > 0, `h7-mask-path-${row.case_id}`)
    const key = `${candidate.source_family}\0${candidate.source_alias}`
    assert(key === orderedReferenceKeys[candidateIndex], `h7-roster-source-order-${row.case_id}`)
    assert(!actual.has(key), `h7-candidate-duplicate-${row.case_id}-${key}`)
    actual.add(key)
    const reference = references.get(key)
    assert(reference, `h7-candidate-not-in-native-roster-${row.case_id}-${key}`)
    assert(
      candidate.source_mask_sha256 === reference.maskSha256,
      `h7-candidate-mask-hash-${row.case_id}-${key}`,
    )
    if (row.status === 'complete') {
      const box = reference.box
      const expectedCrop: [number, number, number, number] = [
        Math.max(0, Math.floor(box.left - 0.25 * box.width)),
        Math.max(0, Math.floor(box.top - 0.25 * box.height)),
        Math.min(truth.sourceDimensions.width, Math.ceil(box.left + box.width + 0.25 * box.width)),
        Math.min(
          truth.sourceDimensions.height,
          Math.ceil(box.top + box.height + 0.25 * box.height),
        ),
      ]
      assert(
        JSON.stringify(candidate.crop_xyxy) === JSON.stringify(expectedCrop),
        `h7-crop-does-not-match-foreground-${row.case_id}-${key}`,
      )
      const cropWidth = expectedCrop[2] - expectedCrop[0]
      const cropHeight = expectedCrop[3] - expectedCrop[1]
      const scale = Math.min(512 / cropWidth, 512 / cropHeight)
      const resizedWidth = Math.min(512, Math.max(1, Math.floor(cropWidth * scale + 0.5)))
      const resizedHeight = Math.min(512, Math.max(1, Math.floor(cropHeight * scale + 0.5)))
      const padLeft = Math.floor((512 - resizedWidth) / 2)
      const padTop = Math.floor((512 - resizedHeight) / 2)
      const expectedGeometry = {
        crop_xyxy: expectedCrop,
        source_crop_size: [cropWidth, cropHeight],
        resized_size: [resizedWidth, resizedHeight],
        pad_ltrb: [padLeft, padTop, 512 - resizedWidth - padLeft, 512 - resizedHeight - padTop],
        output_size: [512, 512],
      }
      assert(
        JSON.stringify(candidate.resize_geometry) === JSON.stringify(expectedGeometry),
        `h7-resize-geometry-${row.case_id}-${key}`,
      )
    } else {
      assert(
        candidate.crop_xyxy === null && candidate.resize_geometry === null,
        `h7-error-row-geometry-must-be-null-${row.case_id}`,
      )
    }
    const components = [candidate.clean_cosine, candidate.masked_cosine, candidate.mean_cosine]
    if (components.every((value) => value !== null)) {
      assert(
        components.every(
          (value) => Number.isFinite(value) && value! >= -1.000001 && value! <= 1.000001,
        ),
        `h7-cosine-range-${row.case_id}`,
      )
      assert(
        Math.abs(
          candidate.mean_cosine! - (candidate.clean_cosine! + candidate.masked_cosine!) / 2,
        ) < 1e-9,
        `h7-mean-cosine-${row.case_id}`,
      )
    } else {
      assert(
        components.every((value) => value === null),
        `h7-partial-cosine-${row.case_id}`,
      )
      assert(
        candidate.global_rank === null && candidate.family_rank === null,
        `h7-null-score-rank-${row.case_id}`,
      )
    }
  }
  assert(actual.size === references.size, `h7-roster-count-${row.case_id}`)
  for (const key of references.keys())
    assert(actual.has(key), `h7-native-candidate-omitted-${row.case_id}-${key}`)
  if (row.status === 'complete') {
    assert(
      row.candidates.every((candidate) => candidate.mean_cosine !== null),
      `h7-complete-missing-score-${row.case_id}`,
    )
    assert(
      row.candidates.every(
        (candidate) => candidate.global_rank !== null && candidate.family_rank !== null,
      ),
      `h7-complete-missing-rank-${row.case_id}`,
    )
    checkRanks(row)
  } else {
    assert(
      row.candidates.every(
        (candidate) =>
          candidate.clean_cosine === null &&
          candidate.masked_cosine === null &&
          candidate.mean_cosine === null &&
          candidate.global_rank === null &&
          candidate.family_rank === null,
      ),
      `h7-error-row-must-retain-null-scores-${row.case_id}`,
    )
  }
}

/** Score candidate ranks against already-verified H5a mask availability receipts. */
export function evaluateH7LocalSemanticShadow(
  availability: H5AvailabilityReport,
  freeze: H7Freeze,
  replay: H7LocalSemanticShadowRun,
) {
  assert(
    availability.schema === 'v03-h5a-native-proposal-availability-evaluation-v1',
    'h7-h5a-schema',
  )
  assert(availability.runSha256 === H5A_RUN_SHA256, 'h7-h5a-run-lock')
  assert(availability.freezeSha256 === H5A_FREEZE_SHA256, 'h7-h5a-freeze-lock')
  assert(freeze.schema === 'v03-h7-local-semantic-shadow-freeze-v1', 'h7-freeze-schema')
  assert(freeze.status === 'frozen-before-inference', 'h7-freeze-status')
  assert(
    isDeepStrictEqual(freeze.limits, {
      initialization_ms: 120_000,
      case_ms: 240_000,
      candidates: 72,
      per_family: 36,
      packed_bytes: 19 * 1024 * 1024,
      cuda_allocated_bytes: 10 * 1024 ** 3,
      batch_candidates: 2,
    }),
    'h7-freeze-limits',
  )
  assert(
    isDeepStrictEqual(freeze.recipe, {
      context_fraction: 0.25,
      view_weights: [0.5, 0.5],
      input_size: 512,
      padding_rgb: [128, 128, 128],
      text_padding: 'max_length',
      truncate: false,
      processor_resize: false,
      normalize_dtype: 'float32',
      presence: 'not-a-presence-decision',
    }),
    'h7-freeze-recipe',
  )
  assert(freeze.source_locks.h5a_run_sha256 === H5A_RUN_SHA256, 'h7-native-run-lock')
  assert(freeze.source_locks.h5a_freeze_sha256 === H5A_FREEZE_SHA256, 'h7-native-freeze-lock')
  assert(
    freeze.source_locks.h5a_integrity_sha256 ===
      '43b6502dae3a0303a4700cc9692e1cb59a618fa645a110cfd40474f1a4825f50',
    'h7-native-integrity-lock',
  )
  assert(
    freeze.source_locks.h5a_worker_closure_sha256 ===
      'd899e970aee5e893e1d0bcac97eefe6b15831936c6d6bb20723e95942293a76f',
    'h7-native-worker-closure-lock',
  )
  assert(freeze.source_locks.h3b_run_sha256 === H3B_RUN_SHA256, 'h7-h3b-run-lock')
  assert(freeze.source_locks.h4e_run_sha256 === H4E_RUN_SHA256, 'h7-h4e-run-lock')
  assert(freeze.asset_lock.model_id === 'google/siglip2-base-patch16-512', 'h7-model-id')
  assert(
    freeze.asset_lock.revision === 'a89f5c5093f902bf39d3cd4d81d2c09867f0724b',
    'h7-model-revision',
  )
  assert(freeze.asset_lock.license === 'apache-2.0', 'h7-model-license')
  assert(
    JSON.stringify(freeze.asset_lock.files.map((file) => file.path)) ===
      JSON.stringify(ASSET_FILE_NAMES),
    'h7-model-files',
  )
  const assetPaths = new Set<string>()
  for (const file of freeze.asset_lock.files) {
    assert(
      file.path.length > 0 && !file.path.includes('/') && !file.path.includes('\\'),
      'h7-model-path',
    )
    assert(/^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0, 'h7-model-file-receipt')
    assert(!assetPaths.has(file.path), 'h7-model-file-duplicate')
    assetPaths.add(file.path)
  }
  assert(
    freeze.asset_lock.files.some(
      (file) =>
        file.path === 'model.safetensors' &&
        file.sha256 === MODEL_SHA256 &&
        file.bytes === 1_503_344_520,
    ),
    'h7-model-checkpoint-missing',
  )
  assert(
    freeze.asset_lock.files.some(
      (file) => file.path === 'tokenizer.json' && file.sha256 === TOKENIZER_SHA256,
    ),
    'h7-tokenizer-hash-mismatch',
  )
  for (const key of [
    'h5a_run_directory',
    'h3b_run_directory',
    'h4e_run_directory',
    'source_image_root',
  ] as const)
    assert(isAbsolute(freeze.source_roots[key]), `h7-source-root-${key}`)
  assert(replay.schema === 'v03-h7-local-semantic-shadow-run-v1', 'h7-schema')
  assert(JSON.stringify(freeze.case_ids) === JSON.stringify(CASE_IDS), 'h7-freeze-case-order')
  assert(JSON.stringify(replay.case_ids) === JSON.stringify(CASE_IDS), 'h7-run-case-order')
  assert(replay.worker.pid === null || Number.isInteger(replay.worker.pid), 'h7-worker-pid')
  assert(
    replay.worker.exit_code === null || Number.isInteger(replay.worker.exit_code),
    'h7-worker-exit-code',
  )
  assert(typeof replay.worker.closed === 'boolean', 'h7-worker-closed-state')
  assert(
    isDeepStrictEqual(replay.source_closure_post, freeze.source_closure),
    'h7-source-closure-postrun-mismatch',
  )
  assert(
    isDeepStrictEqual(replay.asset_lock_post, freeze.asset_lock),
    'h7-asset-lock-postrun-mismatch',
  )
  assert(
    JSON.stringify(availability.perCase.map((row) => row.caseId)) === JSON.stringify(CASE_IDS),
    'h7-h5a-case-order',
  )
  assert(
    JSON.stringify(replay.rows.map((row) => row.case_id)) === JSON.stringify(CASE_IDS),
    'h7-row-case-order',
  )
  assert(['complete', 'incomplete'].includes(replay.status), 'h7-run-status')

  const truthByCase = new Map(availability.perCase.map((row) => [row.caseId, row]))
  const candidateAvailability = new Map<string, boolean>()
  for (const truth of availability.perCase) {
    for (const [name, family] of Object.entries(truth.families)) {
      if (name === 'union') continue
      for (const receipt of family.candidateReceipts) {
        const key = `${truth.caseId}\0${sourceFamily(receipt.family as CandidateReceipt['family'])}\0${receipt.id}\0${receipt.maskSha256}`
        candidateAvailability.set(key, receipt.score?.pass === true)
      }
    }
  }
  const perCase = replay.rows.map((row) => {
    const truth = truthByCase.get(row.case_id)
    assert(truth, `h7-row-without-truth-${row.case_id}`)
    validateRow(row, truth)
    const isPositive = truth.presence === 'present'
    const ranked =
      row.status === 'complete'
        ? [...row.candidates].sort((a, b) => a.global_rank! - b.global_rank!)
        : []
    const eligible = (candidate: H7Candidate) =>
      candidateAvailability.get(
        `${row.case_id}\0${candidate.source_family}\0${candidate.source_alias}\0${candidate.source_mask_sha256}`,
      ) === true
    const top1 = ranked[0] && eligible(ranked[0]) ? ranked[0] : null
    const top4 = ranked.slice(0, 4).find(eligible) ?? null
    const familyTop = (family: H7Candidate['family']) => {
      const familyRanked = ranked
        .filter((candidate) => candidate.family === family)
        .sort((a, b) => a.family_rank! - b.family_rank!)
      return familyRanked.find(eligible) ?? null
    }
    return {
      caseId: row.case_id,
      stratum: stratum(row.case_id),
      presenceTruth: truth.presence,
      rowStatus: row.status,
      errorCode: row.error_code ?? null,
      timingMs: row.timing_ms ?? null,
      memory: row.memory ?? null,
      candidateCount: row.candidates.length,
      topOneAvailable: isPositive ? Boolean(top1) : null,
      topFourAvailable: isPositive ? Boolean(top4) : null,
      topOneCandidate: top1
        ? { family: top1.family, alias: top1.alias, meanCosine: top1.mean_cosine }
        : null,
      topFourCandidate: top4
        ? { family: top4.family, alias: top4.alias, meanCosine: top4.mean_cosine }
        : null,
      rankedCandidates: [...row.candidates]
        .sort(
          (a, b) =>
            (a.global_rank ?? Number.MAX_SAFE_INTEGER) - (b.global_rank ?? Number.MAX_SAFE_INTEGER),
        )
        .map((candidate) => ({
          family: candidate.family,
          alias: candidate.alias,
          sourceFamily: candidate.source_family,
          sourceAlias: candidate.source_alias,
          sourceMaskSha256: candidate.source_mask_sha256,
          cleanCosine: candidate.clean_cosine,
          maskedCosine: candidate.masked_cosine,
          meanCosine: candidate.mean_cosine,
          globalRank: candidate.global_rank,
          familyRank: candidate.family_rank,
          passesNativeAvailabilityGate: eligible(candidate),
        })),
      bestAvailableByFamily: {
        D: familyTop('D')
          ? { alias: familyTop('D')!.alias, rank: familyTop('D')!.family_rank }
          : null,
        U: familyTop('U')
          ? { alias: familyTop('U')!.alias, rank: familyTop('U')!.family_rank }
          : null,
      },
      negativeTopFour: !isPositive
        ? ranked.slice(0, 4).map((candidate) => ({
            family: candidate.family,
            alias: candidate.alias,
            meanCosine: candidate.mean_cosine,
          }))
        : null,
    }
  })
  const byStratum = Object.fromEntries(
    (['photo', 'ui', 'map'] as const).map((name) => {
      const rows = perCase.filter((row) => row.stratum === name && row.presenceTruth === 'present')
      return [
        name,
        {
          denominator: rows.length,
          completedRows: rows.filter((row) => row.rowStatus === 'complete').length,
          topOne: rows.filter((row) => row.topOneAvailable).length,
          topFour: rows.filter((row) => row.topFourAvailable).length,
          errorsOrTimeouts: rows
            .filter((row) => row.rowStatus !== 'complete')
            .map((row) => row.caseId),
        },
      ]
    }),
  )
  const positives = perCase.filter((row) => row.presenceTruth === 'present')
  const topFourAvailableCaseIds = positives
    .filter((row) => row.topFourAvailable)
    .map((row) => row.caseId)
  const h6Losses = {
    nativeCandidateUnion: ['pilot-v03-map-02'],
    nomination: ['pilot-v03-map-01'],
    finalSelection: ['pilot-v03-map-03'],
  }
  const h6LossCases = Object.values(h6Losses).flat()
  return {
    schema: 'v03-h7-local-semantic-shadow-independent-evaluation-v1',
    profile: 'h7-local-semantic-shadow-v1',
    negativeInterpretation: 'Rank-only evidence; H7 scores make no detection or absence decision.',
    positives: {
      denominator: positives.length,
      topOne: positives.filter((row) => row.topOneAvailable).length,
      topFour: positives.filter((row) => row.topFourAvailable).length,
      byStratum,
    },
    h6Comparison: {
      h6Losses,
      h7TopFourRecoversH6Losses: h6LossCases.filter((caseId) =>
        topFourAvailableCaseIds.includes(caseId),
      ),
      mapTopOneAtLeastOne: perCase.some(
        (row) => row.stratum === 'map' && row.topOneAvailable === true,
      ),
    },
    negativeRows: perCase.filter((row) => row.presenceTruth === 'absent'),
    perCase,
  }
}

/** Independently hash every native mask and staged model file named by H7. */
export async function verifyH7ArtifactBytes(freeze: H7Freeze, replay: H7LocalSemanticShadowRun) {
  const assetRoot = await realpath(freeze.asset_lock.asset_directory)
  const assetFiles = []
  for (const file of freeze.asset_lock.files) {
    const path = resolve(assetRoot, file.path)
    const info = await lstat(path)
    assert(info.isFile() && !info.isSymbolicLink(), `h7-model-file-type-${file.path}`)
    assert((await realpath(path)) === path, `h7-model-file-realpath-${file.path}`)
    const receipt = await hashFile(path)
    assert(receipt.bytes === file.bytes, `h7-model-file-size-${file.path}`)
    assert(receipt.sha256 === file.sha256, `h7-model-file-hash-${file.path}`)
    assetFiles.push({ path: file.path, ...receipt })
  }

  const maskFiles = []
  const sourceRoots = {
    h5a: await realpath(freeze.source_roots.h5a_run_directory),
    h3b: await realpath(freeze.source_roots.h3b_run_directory),
    h4e: await realpath(freeze.source_roots.h4e_run_directory),
  }
  const seen = new Set<string>()
  for (const row of replay.rows) {
    for (const candidate of row.candidates) {
      const expectedRoot =
        candidate.source_family === 'h3b-dino-sam2'
          ? sourceRoots.h3b
          : candidate.source_family === 'h4e-sam2'
            ? sourceRoots.h4e
            : sourceRoots.h5a
      const path = candidate.source_mask_path
      assert(!isAbsolute(path), `h7-mask-path-absolute-${row.case_id}`)
      const resolved = resolve(sourceRoots.h5a, path)
      const unresolvedInfo = await lstat(resolved)
      assert(!unresolvedInfo.isSymbolicLink(), `h7-mask-symlink-${row.case_id}`)
      const actual = await realpath(resolved)
      const actualFromRoot = relative(expectedRoot, actual)
      assert(
        actualFromRoot.length > 0 &&
          actualFromRoot !== '..' &&
          !actualFromRoot.startsWith(`..${sep}`),
        `h7-mask-realpath-wrong-source-${row.case_id}`,
      )
      const key = `${actual}\0${candidate.source_mask_sha256}`
      if (seen.has(key)) continue
      seen.add(key)
      const info = await lstat(actual)
      assert(info.isFile() && !info.isSymbolicLink(), `h7-mask-file-type-${row.case_id}`)
      const receipt = await hashFile(actual)
      assert(receipt.sha256 === candidate.source_mask_sha256, `h7-mask-file-hash-${row.case_id}`)
      maskFiles.push({ path: actual, ...receipt })
    }
  }
  return {
    status: 'verified' as const,
    verifiedAssetFiles: assetFiles.length,
    verifiedUniqueMaskFiles: maskFiles.length,
    assetFiles,
    maskFiles,
  }
}

export async function evaluateH7LocalSemanticShadowRun(
  runDirectory: string,
  repositoryRoot: string,
  availabilityPath = resolve(
    repositoryRoot,
    'docs/evidence/v03/h5a-native-proposal-availability-evaluation.json',
  ),
) {
  const availabilityBytes = await readFile(availabilityPath)
  assert(sha256(availabilityBytes) === H5A_EVALUATION_SHA256, 'h7-h5a-evaluation-hash')
  const availability = JSON.parse(availabilityBytes.toString('utf8')) as H5AvailabilityReport
  const freezePath = resolve(runDirectory, 'freeze.json')
  const runPath = resolve(runDirectory, 'run.json')
  const freezeBytes = await readFile(freezePath)
  const freeze = JSON.parse(freezeBytes.toString('utf8')) as H7Freeze
  const replay = JSON.parse(await readFile(runPath, 'utf8')) as H7LocalSemanticShadowRun
  assert(replay.freeze_sha256 === sha256(freezeBytes), 'h7-freeze-file-hash')
  assert(freeze.input_json.bytes > 0, 'h7-input-json-size')
  assert(freeze.input_json.path === 'input.json', 'h7-input-json-path')
  const inputPath = resolve(runDirectory, freeze.input_json.path)
  const inputReceipt = await hashFile(inputPath)
  assert(inputReceipt.bytes === freeze.input_json.bytes, 'h7-input-json-size-mismatch')
  assert(inputReceipt.sha256 === freeze.input_json.sha256, 'h7-input-json-hash-mismatch')
  const inputJson = JSON.parse(await readFile(inputPath, 'utf8')) as unknown
  await validateH7Inputs(inputJson, availability, freeze, repositoryRoot)
  const frozenInputCases = (inputJson as { cases: FrozenInputCase[] }).cases
  const frozenTargetByCase = new Map(
    frozenInputCases.map((item) => [
      item.case_id ?? item.caseId!,
      item.target ?? item.locate?.target,
    ]),
  )
  for (const row of replay.rows) {
    assert(
      row.target === frozenTargetByCase.get(row.case_id),
      `h7-row-target-mismatch-${row.case_id}`,
    )
  }
  const closureVerification = []
  for (const item of freeze.source_closure) {
    assert(isAbsolute(item.path), 'h7-source-closure-path')
    const receipt = await hashFile(item.path)
    assert(item.bytes === undefined || receipt.bytes === item.bytes, 'h7-source-closure-size')
    assert(receipt.sha256 === item.sha256, 'h7-source-closure-hash')
    closureVerification.push({ path: item.path, ...receipt })
  }
  const scored = evaluateH7LocalSemanticShadow(availability, freeze, replay)
  const artifacts = await verifyH7ArtifactBytes(freeze, replay)
  return {
    ...scored,
    production: {
      status: replay.status,
      worker: replay.worker,
      runtime: replay.runtime ?? null,
      elapsedMs: replay.elapsed_ms ?? null,
      error: replay.error ?? null,
      integrityErrors: replay.integrity_errors ?? [],
      inputArtifactsUnchanged: replay.input_artifacts_unchanged ?? null,
      artifactBytesVerified: artifacts.status === 'verified',
      verifiedAssetFiles: artifacts.verifiedAssetFiles,
      verifiedUniqueMaskFiles: artifacts.verifiedUniqueMaskFiles,
      sourceLocks: freeze.source_locks,
      assetLock: freeze.asset_lock,
      artifactVerification: artifacts,
      sourceClosureVerified: closureVerification.length,
      sourceClosureSha256: sha256(Buffer.from(JSON.stringify(freeze.source_closure))),
      inputJsonSha256: freeze.input_json.sha256,
    },
  }
}

async function main() {
  const [runDirectory, repositoryRoot, outputPath] = process.argv.slice(2)
  assert(
    runDirectory && repositoryRoot && outputPath,
    'usage: evaluate-h7-local-semantic-shadow <run-directory> <repository-root> <output-json>',
  )
  const result = await evaluateH7LocalSemanticShadowRun(
    resolve(runDirectory),
    resolve(repositoryRoot),
  )
  await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(
    `${JSON.stringify({
      schema: result.schema,
      positives: result.positives,
      h6Comparison: result.h6Comparison,
      negativeRows: result.negativeRows,
      production: {
        ...result.production,
        artifactVerification: undefined,
        assetLock: undefined,
      },
      outputPath: resolve(outputPath),
    })}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
