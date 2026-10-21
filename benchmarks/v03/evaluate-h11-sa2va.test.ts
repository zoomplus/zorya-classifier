import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { z } from 'zod'
import type { Box } from '../v02/metrics.js'
import { wholeObjectMatch } from '../v02/metrics.js'
import {
  EXPECTED_H11_OVERLAY_WHEELS,
  H11_CONTRACT_SHA256,
  H11_FALSE_OUTPUTS_MAXIMUM,
  H11_GENERATION_MAX_NEW_TOKENS,
  H11_NATIVE_MASK_MAX_BYTES_PER_ROW,
  H11_NATIVE_MASK_MAX_COUNT,
  H11_POSITIVE_SUCCESS_MINIMUM,
  H11_REPOSITORY_CONTRACT_PATH,
  auditH11CandidateMask,
  deriveH11RunStatus,
  evaluateH11Sa2vaRun,
  freezeRuntimeSchema,
  h11FreezeSchema,
  h11RowSchema,
  h11RunSchema,
  maskForegroundBounds,
  validateApprovedH11ContractShape,
  validateH11ProducerOutcomeRowFields,
  verifyFirstNonemptyMaskSelection,
  hashH11AssetFileOnDisk,
  verifyH11AssetFileReceiptOnDisk,
  verifyH11AssetReceiptMetadata,
  verifyH11EmittedMaskInventory,
  verifyH11InputImageReceipts,
  verifyH11OverlayWheelsMetadata,
  verifyH11RunRecordProducerBindings,
  verifyH11RunRuntimeReceiptConsistency,
  verifyH11RunStatusConsistency,
  verifyH11RowInputReceiptIdentity,
  recomputeH11ComposedPromptSha256,
} from './evaluate-h11-sa2va.js'
import {
  buildExpectedH10PilotRows,
  foregroundBoundsToBox,
  H10_REAL_RUN_DEVICE,
  MINIMAL_DEV_MANIFEST_SHA256,
  type ExpectedH10PilotRow,
} from './evaluate-h10-clipseg.js'

const H11_PROMPT_TEMPLATE =
  '<image>Segment one visible object matching the description below. If no such object is visible, answer not found and do not produce a segmentation mask. If several objects match, segment one of them.\nObject description: {authored_target}'
const H11_PROMPT_TEMPLATE_SHA256 = createHash('sha256')
  .update(H11_PROMPT_TEMPLATE, 'utf8')
  .digest('hex')
const SYNTHETIC_CUDA_VERSION = '12.4'

const CANVAS = 100

type H11GenerationDiagnostics = {
  actual_max_new_tokens_applied: typeof H11_GENERATION_MAX_NEW_TOKENS
  do_sample_applied: false
  generated_token_count: number
  stopped_on_eos: boolean
}

function alignedGenerationDiagnostics(input: {
  generation_token_count: number
  generation_truncated: boolean
}): H11GenerationDiagnostics {
  if (input.generation_truncated) {
    return {
      actual_max_new_tokens_applied: H11_GENERATION_MAX_NEW_TOKENS,
      do_sample_applied: false,
      generated_token_count: Math.max(input.generation_token_count, H11_GENERATION_MAX_NEW_TOKENS),
      stopped_on_eos: false,
    }
  }
  return {
    actual_max_new_tokens_applied: H11_GENERATION_MAX_NEW_TOKENS,
    do_sample_applied: false,
    generated_token_count: input.generation_token_count,
    stopped_on_eos: true,
  }
}

function syntheticExpectedRows(): ExpectedH10PilotRow[] {
  const standardReference: Box = { left: 10, top: 10, width: 20, height: 20 }
  const rows: ExpectedH10PilotRow[] = []
  for (let row_index = 0; row_index < 12; row_index++) {
    const stratum = row_index < 4 ? 'photo' : row_index < 8 ? 'ui' : 'map'
    const presence = row_index === 3 || row_index === 7 || row_index === 11 ? 'absent' : 'present'
    rows.push({
      row_index,
      row_key: `fixture-${String(row_index).padStart(2, '0')}`,
      caseId: `fixture-${String(row_index).padStart(2, '0')}`,
      authored_target: `target-${row_index}`,
      expectedSourceSha256: createHash('sha256').update(`source-${row_index}`).digest('hex'),
      sourceWidth: CANVAS,
      sourceHeight: CANVAS,
      stratum,
      presence,
      referenceBoxes: presence === 'present' ? [standardReference] : [],
    })
  }
  return rows
}

async function writeMaskU8(
  path: string,
  width: number,
  height: number,
  paint: (x: number, y: number) => boolean,
): Promise<{
  sha256: string
  byte_count: number
  bounds: { x_min: number; y_min: number; x_max: number; y_max: number } | null
}> {
  const bits = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      bits[y * width + x] = paint(x, y) ? 1 : 0
    }
  }
  await writeFile(path, bits)
  const bounds = maskForegroundBounds(bits, width, height)
  return {
    sha256: createHash('sha256').update(bits).digest('hex'),
    byte_count: bits.length,
    bounds,
  }
}

type RowSpec = {
  outcome_kind: 'candidate' | 'unresolved_no_mask' | 'technical_error' | 'integrity_failure'
  paints?: Array<(x: number, y: number) => boolean>
  paint?: (x: number, y: number) => boolean
  tamperSelectedSha?: boolean
  wrongSelectedBytes?: boolean
  wrongDimensions?: boolean
  wrongBounds?: boolean
  wrongSourceSha?: boolean
  wrongTarget?: boolean
  wrongKey?: boolean
  falseEmptyFields?: boolean
  native_mask_count?: number
  selected_mask_index?: number | null
  generation_truncated?: boolean
  omit?: boolean
  omitCandidateFile?: number
  omitSelectedAlias?: boolean
  error_code?: string | null
  error_message?: string | null
}

function technicalNullShell(expectedRow: ExpectedH10PilotRow, spec: RowSpec) {
  return {
    row_index: expectedRow.row_index,
    row_key: spec.wrongKey ? 'wrong-key' : expectedRow.row_key,
    authored_target: spec.wrongTarget ? 'wrong-target' : expectedRow.authored_target,
    outcome_kind: spec.outcome_kind,
    source_width: null,
    source_height: null,
    source_sha256: spec.wrongSourceSha ? 'f'.repeat(64) : expectedRow.expectedSourceSha256,
    oriented_rgb_sha256: null,
    composed_prompt_sha256: null,
    prediction_text: null,
    generation_token_count: null,
    generation_truncated: null,
    native_mask_count: null,
    candidate_masks: [],
    selected_mask_index: null,
    mask_path: null,
    mask_sha256: null,
    foreground_bounds: null,
    error_code: spec.error_code ?? 'H11_ERROR',
    error_message: spec.error_message ?? 'fixture-technical',
    wall_ms: null,
    peak_vram_allocated_bytes: null,
    peak_vram_reserved_bytes: null,
    generation_diagnostics: null,
  }
}

async function buildFixtureRun(expected: ExpectedH10PilotRow[], specs: RowSpec[]) {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h11-eval-'))
  const masksDir = join(runRoot, 'masks')
  await mkdir(masksDir, { recursive: true })
  const rows = []
  for (const expectedRow of expected) {
    const spec = specs[expectedRow.row_index] ?? { outcome_kind: 'unresolved_no_mask' as const }
    if (spec.omit) continue
    if (spec.outcome_kind === 'technical_error' || spec.outcome_kind === 'integrity_failure') {
      rows.push(technicalNullShell(expectedRow, spec))
      continue
    }
    const rowKey = spec.wrongKey ? 'wrong-key' : expectedRow.row_key
    const caseDir = join(masksDir, rowKey)
    await mkdir(caseDir, { recursive: true })
    const width = spec.wrongDimensions ? expectedRow.sourceWidth - 1 : expectedRow.sourceWidth
    const height = spec.wrongDimensions ? expectedRow.sourceHeight - 1 : expectedRow.sourceHeight
    const defaultPaint = (x: number, y: number) => x >= 10 && x < 30 && y >= 10 && y < 30
    const paints =
      spec.paints ??
      (spec.outcome_kind === 'unresolved_no_mask'
        ? [() => false]
        : spec.paint
          ? [spec.paint]
          : [defaultPaint])
    const candidate_masks: Array<{
      emission_index: number
      path: string
      sha256: string
      byte_count: number
      width: number
      height: number
      foreground_bounds: { x_min: number; y_min: number; x_max: number; y_max: number } | null
    }> = []
    let selectedIndex: number | null = null
    let selectedRecord: (typeof candidate_masks)[number] | null = null
    const writtenBytesByEmission = new Map<number, Buffer>()
    for (let emission_index = 0; emission_index < paints.length; emission_index++) {
      const paint = paints[emission_index]!
      const rel = join('masks', rowKey, `candidate-${emission_index}.u8`)
      const abs = join(runRoot, rel)
      const written = await writeMaskU8(abs, width, height, paint)
      writtenBytesByEmission.set(emission_index, await readFile(abs))
      if (spec.omitCandidateFile === emission_index) await unlink(abs)
      const record = {
        emission_index,
        path: rel.replaceAll('\\', '/'),
        sha256: written.sha256,
        byte_count: written.byte_count,
        width: expectedRow.sourceWidth,
        height: expectedRow.sourceHeight,
        foreground_bounds: written.bounds,
      }
      candidate_masks.push(record)
      if (selectedIndex === null && written.bounds !== null) {
        selectedIndex = emission_index
        selectedRecord = record
      }
    }
    if (spec.selected_mask_index !== undefined) selectedIndex = spec.selected_mask_index
    if (selectedIndex !== null) {
      selectedRecord =
        candidate_masks.find((item) => item.emission_index === selectedIndex) ?? selectedRecord
    }
    let mask_path: string | null = null
    let mask_sha256: string | null = null
    let foreground_bounds: (typeof candidate_masks)[number]['foreground_bounds'] = null
    if (spec.outcome_kind === 'candidate' && selectedRecord !== null && !spec.falseEmptyFields) {
      mask_path = join('masks', rowKey, 'mask.u8').replaceAll('\\', '/')
      mask_sha256 = spec.tamperSelectedSha ? '0'.repeat(64) : selectedRecord.sha256
      foreground_bounds = spec.wrongBounds
        ? { x_min: 0, y_min: 0, x_max: 1, y_max: 1 }
        : selectedRecord.foreground_bounds
      if (!spec.omitSelectedAlias) {
        const aliasPath = join(caseDir, 'mask.u8')
        if (spec.wrongSelectedBytes) {
          const wrong = new Uint8Array(expectedRow.sourceWidth * expectedRow.sourceHeight)
          wrong.fill(1)
          await writeFile(aliasPath, wrong)
        } else {
          const bytes = writtenBytesByEmission.get(selectedRecord.emission_index)
          assert.ok(bytes)
          await writeFile(aliasPath, bytes)
        }
      }
    }
    if (spec.falseEmptyFields) {
      mask_path = join('masks', rowKey, 'mask.u8').replaceAll('\\', '/')
      mask_sha256 = 'a'.repeat(64)
      foreground_bounds = { x_min: 0, y_min: 0, x_max: 1, y_max: 1 }
    }
    rows.push({
      row_index: expectedRow.row_index,
      row_key: rowKey,
      authored_target: spec.wrongTarget ? 'wrong-target' : expectedRow.authored_target,
      outcome_kind: spec.outcome_kind,
      source_width: expectedRow.sourceWidth,
      source_height: expectedRow.sourceHeight,
      source_sha256: spec.wrongSourceSha ? 'f'.repeat(64) : expectedRow.expectedSourceSha256,
      oriented_rgb_sha256: createHash('sha256')
        .update(`rgb-${expectedRow.row_index}`)
        .digest('hex'),
      composed_prompt_sha256: createHash('sha256')
        .update(`prompt-${expectedRow.row_index}`)
        .digest('hex'),
      prediction_text: 'diagnostic-only',
      native_mask_count:
        spec.native_mask_count ??
        (spec.outcome_kind === 'candidate' || spec.outcome_kind === 'unresolved_no_mask'
          ? paints.length
          : 0),
      candidate_masks,
      selected_mask_index: spec.outcome_kind === 'candidate' ? selectedIndex : null,
      generation_token_count: 4,
      generation_truncated: spec.generation_truncated ?? false,
      generation_diagnostics: alignedGenerationDiagnostics({
        generation_token_count: 4,
        generation_truncated: spec.generation_truncated ?? false,
      }),
      mask_path:
        spec.outcome_kind === 'candidate' ? mask_path : spec.falseEmptyFields ? mask_path : null,
      mask_sha256:
        spec.outcome_kind === 'candidate'
          ? mask_sha256
          : spec.falseEmptyFields
            ? mask_sha256
            : null,
      foreground_bounds:
        spec.outcome_kind === 'candidate'
          ? foreground_bounds
          : spec.falseEmptyFields
            ? foreground_bounds
            : null,
      error_code: null,
      error_message: null,
      wall_ms: null,
      peak_vram_allocated_bytes: null,
      peak_vram_reserved_bytes: null,
    })
  }
  rows.sort((left, right) => left.row_index - right.row_index)
  await writeFile(
    join(runRoot, 'rows.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  )
  return { runRoot, rows }
}

function syntheticProducerRuntimeReceipt() {
  return {
    python_executable: '/tmp/synthetic-h11/.venv/bin/python',
    python_version: '3.12.7',
    torch: '2.6.0+cu124',
    transformers: '4.57.3',
    torchvision: '0.21.0+cu124',
    pillow: '11.1.0',
    numpy: '2.2.3',
    platform: 'Linux-6.6.87.2-microsoft-standard-WSL2-x86_64-with-glibc2.39',
    cuda_available: true as const,
    cuda_version: SYNTHETIC_CUDA_VERSION,
    cuda_device: {
      cuda_available: true as const,
      cuda_device_index: 0,
      cuda_device_name: 'Synthetic Offline GPU',
      cuda_version: SYNTHETIC_CUDA_VERSION,
    },
  }
}

function syntheticScriptReceipts() {
  const digest = (label: string) => createHash('sha256').update(label).digest('hex')
  return {
    h11_common_script_path: '/tmp/synthetic-h11/h11-sa2va-common.py',
    h11_common_script_sha256: digest('h11-common'),
    h11_runner_script_path: '/tmp/synthetic-h11/h11-sa2va-runner.py',
    h11_runner_script_sha256: digest('h11-runner'),
    h11_worker_script_path: '/tmp/synthetic-h11/h11-sa2va-worker.py',
    h11_worker_script_sha256: digest('h11-worker'),
    h10_common_script_path: '/tmp/synthetic-h11/h10-clipseg-common.py',
    h10_common_script_sha256: digest('h10-common'),
    h10_runner_script_path: '/tmp/synthetic-h11/h10-clipseg-runner.py',
    h10_runner_script_sha256: digest('h10-runner'),
    contract_path: '/tmp/synthetic-h11/h11-sa2va-contract.json',
    contract_sha256: H11_CONTRACT_SHA256,
  }
}

function syntheticManifestRows(): Array<{
  row_index: number
  row_key: string
  source_path: string
  authored_target: string
  source_sha256: string
}> {
  return Array.from({ length: 12 }, (_, row_index) => ({
    row_index,
    row_key: `pilot-v03-fixture-${String(row_index).padStart(2, '0')}`,
    source_path: `/tmp/synthetic-h11/sources/${String(row_index).padStart(2, '0')}.png`,
    authored_target: `target ${row_index}`,
    source_sha256: createHash('sha256').update(`source-${row_index}`).digest('hex'),
  }))
}

function syntheticInputImageReceipts(
  manifestRows: ReturnType<typeof syntheticManifestRows>,
): Array<{
  row_index: number
  row_key: string
  source_path: string
  manifest_source_sha256: string
  actual_source_sha256: string
  encoded_bytes: number
  oriented_rgb_sha256: string
  source_width: number
  source_height: number
}> {
  return manifestRows.map((row) => ({
    row_index: row.row_index,
    row_key: row.row_key,
    source_path: row.source_path,
    manifest_source_sha256: row.source_sha256,
    actual_source_sha256: row.source_sha256,
    encoded_bytes: 4096 + row.row_index,
    oriented_rgb_sha256: createHash('sha256').update(`rgb-${row.row_index}`).digest('hex'),
    source_width: 640,
    source_height: 480,
  }))
}

function syntheticProducerFreezeRecord() {
  const manifestRows = syntheticManifestRows()
  const runtime = syntheticProducerRuntimeReceipt()
  return {
    schema: 'v03-h11-sa2va-freeze-v1' as const,
    prepared_at_unix_ms: 1_730_000_000_000,
    manifest_path: '/tmp/synthetic-h11/manifest.json',
    manifest_sha256: MINIMAL_DEV_MANIFEST_SHA256,
    contract_path: '/tmp/synthetic-h11/h11-sa2va-contract.json',
    contract_sha256: H11_CONTRACT_SHA256,
    asset_dir: '/tmp/synthetic-h11/assets',
    asset_receipts: {},
    rows: manifestRows,
    recipe: {
      model_id: 'ByteDance/Sa2VA-Qwen3-VL-2B' as const,
      revision: '173fb6512b3ad6f3c1fe25efa09e723d01d5b6d4' as const,
      torch_dtype: 'bfloat16' as const,
      eval_mode: true as const,
      inference_mode: true as const,
      requested_device: H10_REAL_RUN_DEVICE,
      attention_eager: true as const,
      use_flash_attn: false as const,
      prompt_template: H11_PROMPT_TEMPLATE,
      prompt_template_sha256: H11_PROMPT_TEMPLATE_SHA256,
      generation_max_new_tokens: H11_GENERATION_MAX_NEW_TOKENS,
      generation_do_sample: false as const,
      sam2_fill_hole_area: 0 as const,
      sam2_compile_image_encoder: false as const,
      max_encoded_bytes: 25_165_824 as const,
      max_oriented_pixels: 2_097_152 as const,
      retain_native_masks_max_count: H11_NATIVE_MASK_MAX_COUNT,
      retain_native_masks_max_bytes_per_row: H11_NATIVE_MASK_MAX_BYTES_PER_ROW,
    },
    processor_attestation: {
      processor_class: 'Qwen3VLProcessor' as const,
      processor_module: 'transformers.models.qwen3_vl.processing_qwen3_vl' as const,
      image_processor_class: 'Qwen2VLImageProcessor' as const,
      image_processor_module: 'transformers.models.qwen2_vl.image_processing_qwen2_vl' as const,
      load_argument_use_fast: false as const,
    },
    runtime,
    script_receipts: syntheticScriptReceipts(),
    requested_device: H10_REAL_RUN_DEVICE,
    input_image_receipts: syntheticInputImageReceipts(manifestRows),
    overlay_wheels: [...EXPECTED_H11_OVERLAY_WHEELS],
  }
}

function syntheticProducerRunRecord(freezeRecord: z.infer<typeof h11FreezeSchema>) {
  return {
    schema: 'v03-h11-sa2va-run-v1' as const,
    status: 'completed' as const,
    freeze_path: '/tmp/synthetic-h11/freeze.json',
    freeze_sha256: createHash('sha256').update('synthetic-freeze').digest('hex'),
    manifest_sha256: freezeRecord.manifest_sha256,
    contract_sha256: freezeRecord.contract_sha256,
    device: H10_REAL_RUN_DEVICE,
    row_count: 12,
    load_ms: 120.5,
    wall_ms: 45_000.25,
    worker_pid: 42_424,
    worker_stderr_tail: 'synthetic stderr tail (offline fixture only)',
    cleanup_failed: false,
    cancelled: false,
    cuda_runtime: freezeRecord.runtime.cuda_device,
    runtime: freezeRecord.runtime,
    script_receipts: freezeRecord.script_receipts,
  }
}

await test('repository H11 contract matches pinned SHA-256 lock', async () => {
  const bytes = await readFile(H11_REPOSITORY_CONTRACT_PATH)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), H11_CONTRACT_SHA256)
  assert.equal(validateApprovedH11ContractShape(JSON.parse(bytes.toString('utf8'))).length, 0)
})

await test('buildExpectedH10PilotRows still supplies twelve-case DEV join for H11', async () => {
  const rows = await buildExpectedH10PilotRows()
  assert.equal(rows.length, 12)
  assert.equal(rows.filter((row) => row.presence === 'present').length, 9)
  assert.equal(rows.filter((row) => row.presence === 'absent').length, 3)
})

await test('mask geometry helpers derive tight foreground bounds from binary u8', () => {
  const bits = new Uint8Array(CANVAS * CANVAS)
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 30; x++) bits[y * CANVAS + x] = 1
  }
  const bounds = maskForegroundBounds(bits, CANVAS, CANVAS)
  assert.deepEqual(bounds, { x_min: 10, y_min: 10, x_max: 29, y_max: 29 })
  const box = foregroundBoundsToBox(bounds!)
  const reference: Box = { left: 10, top: 10, width: 20, height: 20 }
  assert.equal(wholeObjectMatch(box, [reference]).matched, true)
})

await test('verifyFirstNonemptyMaskSelection enforces emission-order index and caps', () => {
  const baseRow = {
    row_index: 0,
    row_key: 'k',
    authored_target: 't',
    source_width: 1,
    source_height: 1,
    source_sha256: 'a'.repeat(64),
    oriented_rgb_sha256: null,
    composed_prompt_sha256: null,
    prediction_text: null,
    generation_token_count: null,
    generation_truncated: null,
    native_mask_count: null,
    mask_path: 'masks/k/mask.u8',
    mask_sha256: 'b'.repeat(64),
    foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
    error_code: null,
    error_message: null,
    wall_ms: null,
    peak_vram_allocated_bytes: null,
    peak_vram_reserved_bytes: null,
    generation_diagnostics: null,
  }
  assert.ok(
    verifyFirstNonemptyMaskSelection({
      ...baseRow,
      outcome_kind: 'candidate',
      native_mask_count: H11_NATIVE_MASK_MAX_COUNT + 1,
      selected_mask_index: 0,
      candidate_masks: [
        {
          emission_index: 0,
          path: 'masks/k/candidate-0.u8',
          sha256: 'b'.repeat(64),
          byte_count: 1,
          width: 1,
          height: 1,
          foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
        },
      ],
    }).some((item) => item.includes('native-mask-count-exceeds-cap')),
  )
  assert.ok(
    verifyFirstNonemptyMaskSelection({
      ...baseRow,
      outcome_kind: 'candidate',
      selected_mask_index: 0,
      mask_sha256: 'c'.repeat(64),
      candidate_masks: [
        {
          emission_index: 0,
          path: 'masks/k/candidate-0.u8',
          sha256: 'b'.repeat(64),
          byte_count: 1,
          width: 1,
          height: 1,
          foreground_bounds: null,
        },
        {
          emission_index: 1,
          path: 'masks/k/candidate-1.u8',
          sha256: 'c'.repeat(64),
          byte_count: 1,
          width: 1,
          height: 1,
          foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
        },
      ],
    }).some((item) => item.includes('not-first-nonempty-emission')),
  )
  assert.ok(
    verifyFirstNonemptyMaskSelection({
      ...baseRow,
      outcome_kind: 'candidate',
      selected_mask_index: 0,
      candidate_masks: [
        {
          emission_index: 0,
          path: 'masks/k/candidate-0.u8',
          sha256: 'b'.repeat(64),
          byte_count: H11_NATIVE_MASK_MAX_BYTES_PER_ROW + 1,
          width: 1,
          height: 1,
          foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
        },
      ],
    }).some((item) => item.includes('payload-exceeds-cap')),
  )
})

await test('validateH11ProducerOutcomeRowFields rejects mask fields on empty and technical rows', () => {
  const emptyErrors = validateH11ProducerOutcomeRowFields(
    {
      row_index: 0,
      row_key: 'fixture-00',
      authored_target: 't',
      outcome_kind: 'unresolved_no_mask',
      source_width: CANVAS,
      source_height: CANVAS,
      source_sha256: 'a'.repeat(64),
      oriented_rgb_sha256: 'd'.repeat(64),
      composed_prompt_sha256: 'e'.repeat(64),
      prediction_text: null,
      native_mask_count: 0,
      candidate_masks: [],
      selected_mask_index: null,
      generation_token_count: 1,
      generation_truncated: false,
      mask_path: 'masks/x/mask.u8',
      mask_sha256: 'b'.repeat(64),
      foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
      error_code: null,
      error_message: null,
      wall_ms: null,
      peak_vram_allocated_bytes: null,
      peak_vram_reserved_bytes: null,
      generation_diagnostics: alignedGenerationDiagnostics({
        generation_token_count: 1,
        generation_truncated: false,
      }),
    },
    null,
  )
  assert.ok(emptyErrors.some((item) => item.includes('unresolved_no_mask-has-mask-path')))
  const technicalErrors = validateH11ProducerOutcomeRowFields(
    {
      row_index: 1,
      row_key: 'fixture-01',
      authored_target: 't',
      outcome_kind: 'technical_error',
      source_width: null,
      source_height: null,
      source_sha256: 'a'.repeat(64),
      oriented_rgb_sha256: null,
      composed_prompt_sha256: null,
      prediction_text: null,
      native_mask_count: null,
      candidate_masks: [],
      selected_mask_index: null,
      generation_token_count: null,
      generation_truncated: null,
      mask_path: null,
      mask_sha256: null,
      foreground_bounds: null,
      error_code: 'H11_ERROR',
      error_message: 'fixture',
      wall_ms: null,
      peak_vram_allocated_bytes: null,
      peak_vram_reserved_bytes: null,
      generation_diagnostics: null,
    },
    null,
  )
  assert.ok(technicalErrors.some((item) => item.includes('technical-error-outcome')))
})

await test('validateH11ProducerOutcomeRowFields enforces generation diagnostics on inference rows', () => {
  const inferenceBase = {
    row_index: 0,
    row_key: 'fixture-00',
    authored_target: 't',
    outcome_kind: 'candidate' as const,
    source_width: CANVAS,
    source_height: CANVAS,
    source_sha256: 'a'.repeat(64),
    oriented_rgb_sha256: 'd'.repeat(64),
    composed_prompt_sha256: 'e'.repeat(64),
    prediction_text: null,
    native_mask_count: 1,
    candidate_masks: [],
    selected_mask_index: 0,
    generation_token_count: 4,
    generation_truncated: false,
    mask_path: 'masks/x/mask.u8',
    mask_sha256: 'b'.repeat(64),
    foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
    error_code: null,
    error_message: null,
    wall_ms: null,
    peak_vram_allocated_bytes: null,
    peak_vram_reserved_bytes: null,
    generation_diagnostics: alignedGenerationDiagnostics({
      generation_token_count: 4,
      generation_truncated: false,
    }),
  }
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      { ...inferenceBase, generation_diagnostics: null },
      null,
    ).some((item) => item.includes('generation-diagnostics-null')),
  )
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      { ...inferenceBase, generation_token_count: null },
      null,
    ).some((item) => item.includes('generation-token-count-null')),
  )
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      { ...inferenceBase, generation_truncated: null },
      null,
    ).some((item) => item.includes('generation-truncated-null')),
  )
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      {
        ...inferenceBase,
        generation_diagnostics: {
          ...alignedGenerationDiagnostics({
            generation_token_count: 4,
            generation_truncated: false,
          }),
          generated_token_count: 99,
        },
      },
      null,
    ).some((item) => item.includes('generation-diagnostics-token-count-mismatch')),
  )
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      {
        ...inferenceBase,
        generation_diagnostics: {
          actual_max_new_tokens_applied: 64,
          do_sample_applied: false,
          generated_token_count: 4,
          stopped_on_eos: true,
        },
      } as unknown as z.infer<typeof h11RowSchema>,
      null,
    ).some((item) => item.includes('generation-diagnostics-max-new-tokens-mismatch')),
  )
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      {
        ...inferenceBase,
        generation_diagnostics: {
          actual_max_new_tokens_applied: H11_GENERATION_MAX_NEW_TOKENS,
          do_sample_applied: true,
          generated_token_count: 4,
          stopped_on_eos: true,
        },
      } as unknown as z.infer<typeof h11RowSchema>,
      null,
    ).some((item) => item.includes('generation-diagnostics-do-sample-mismatch')),
  )
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      {
        ...inferenceBase,
        generation_truncated: false,
        generation_diagnostics: {
          actual_max_new_tokens_applied: H11_GENERATION_MAX_NEW_TOKENS,
          do_sample_applied: false,
          generated_token_count: H11_GENERATION_MAX_NEW_TOKENS,
          stopped_on_eos: false,
        },
      },
      null,
    ).some((item) => item.includes('generation-diagnostics-truncation-mismatch')),
  )
  assert.ok(
    validateH11ProducerOutcomeRowFields(
      {
        ...inferenceBase,
        generation_truncated: null,
        generation_diagnostics: {
          actual_max_new_tokens_applied: H11_GENERATION_MAX_NEW_TOKENS,
          do_sample_applied: false,
          generated_token_count: H11_GENERATION_MAX_NEW_TOKENS,
          stopped_on_eos: false,
        },
      },
      null,
    ).some((item) => item.includes('generation-truncated')),
  )
  const technicalWithDiagnostics = {
    row_index: 2,
    row_key: 'fixture-02',
    authored_target: 't',
    outcome_kind: 'technical_error' as const,
    source_width: null,
    source_height: null,
    source_sha256: 'a'.repeat(64),
    oriented_rgb_sha256: null,
    composed_prompt_sha256: null,
    prediction_text: null,
    native_mask_count: null,
    candidate_masks: [],
    selected_mask_index: null,
    generation_token_count: 4,
    generation_truncated: false,
    mask_path: null,
    mask_sha256: null,
    foreground_bounds: null,
    error_code: 'H11_ERROR',
    error_message: 'fixture',
    wall_ms: null,
    peak_vram_allocated_bytes: null,
    peak_vram_reserved_bytes: null,
    generation_diagnostics: alignedGenerationDiagnostics({
      generation_token_count: 99,
      generation_truncated: true,
    }),
  }
  const technicalDiagErrors = validateH11ProducerOutcomeRowFields(technicalWithDiagnostics, null)
  assert.ok(technicalDiagErrors.some((item) => item.includes('technical-error-outcome')))
  assert.ok(
    technicalDiagErrors.some((item) =>
      item.includes('generation-diagnostics-token-count-mismatch'),
    ),
  )
  assert.ok(
    technicalDiagErrors.some((item) => item.includes('generation-diagnostics-truncation-mismatch')),
  )
  assert.deepEqual(
    validateH11ProducerOutcomeRowFields(
      {
        row_index: 1,
        row_key: 'fixture-01',
        authored_target: 't',
        outcome_kind: 'technical_error',
        source_width: null,
        source_height: null,
        source_sha256: 'a'.repeat(64),
        oriented_rgb_sha256: null,
        composed_prompt_sha256: null,
        prediction_text: null,
        native_mask_count: null,
        candidate_masks: [],
        selected_mask_index: null,
        generation_token_count: null,
        generation_truncated: null,
        mask_path: null,
        mask_sha256: null,
        foreground_bounds: null,
        error_code: 'H11_ERROR',
        error_message: 'fixture',
        wall_ms: null,
        peak_vram_allocated_bytes: null,
        peak_vram_reserved_bytes: null,
        generation_diagnostics: null,
      },
      null,
    ).filter((item) => item.includes('generation-diagnostics')),
    [],
  )
})

await test('H11 evaluator reports clean gate pass for valid fixture run', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) =>
    row.presence === 'absent'
      ? { outcome_kind: 'unresolved_no_mask' }
      : {
          outcome_kind: 'candidate',
          paint: (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30,
        },
  )
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  try {
    const report = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.positiveSuccesses, 9)
    assert.equal(report.gate.falseOutputs, 0)
    assert.equal(report.gate.technicalOrIntegrityDefects, 0)
    assert.equal(report.gate.cleanPass, true)
    assert.equal(report.pilotEvaluation, null)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('H11 evaluator counts negative false outputs and keeps fixed denominators', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) =>
    row.row_index === 11
      ? {
          outcome_kind: 'candidate',
          paint: (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30,
        }
      : row.presence === 'absent'
        ? { outcome_kind: 'unresolved_no_mask' }
        : {
            outcome_kind: 'candidate',
            paint: (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30,
          },
  )
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  try {
    const report = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.positiveDenominator, 9)
    assert.equal(report.gate.negativeDenominator, 3)
    assert.equal(report.gate.falseOutputs, 1)
    assert.equal(report.gate.cleanPass, false)
    assert.ok(report.gate.positiveSuccesses >= H11_POSITIVE_SUCCESS_MINIMUM - 2)
    assert.ok(report.gate.falseOutputs > H11_FALSE_OUTPUTS_MAXIMUM)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('technical and integrity outcomes fail gate without shrinking denominators', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row, index) => {
    if (index === 0) return { outcome_kind: 'technical_error' as const }
    if (index === 4) return { outcome_kind: 'integrity_failure' as const }
    if (row.presence === 'absent') return { outcome_kind: 'unresolved_no_mask' as const }
    return {
      outcome_kind: 'candidate' as const,
      paint: (x: number, y: number) => x >= 10 && x < 30 && y >= 10 && y < 30,
    }
  })
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  try {
    const report = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.positiveDenominator, 9)
    assert.equal(report.gate.negativeDenominator, 3)
    assert.equal(report.gate.technicalOrIntegrityDefects, 2)
    assert.equal(report.gate.cleanPass, false)
    assert.ok(
      report.integrityErrors.some((item) =>
        item.includes('fixture-00:positive-technical-or-integrity-outcome'),
      ),
    )
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('auditH11CandidateMask rejects tampered hash, dimensions, and non-binary bytes', async () => {
  const expected = syntheticExpectedRows()
  const { runRoot, rows } = await buildFixtureRun(expected, [
    { outcome_kind: 'candidate', tamperSelectedSha: true },
    ...expected.slice(1).map((row) =>
      row.presence === 'absent'
        ? { outcome_kind: 'unresolved_no_mask' as const }
        : {
            outcome_kind: 'candidate' as const,
            paint: (x: number, y: number) => x >= 10 && x < 30 && y >= 10 && y < 30,
          },
    ),
  ])
  try {
    const tampered = await auditH11CandidateMask({
      runRoot,
      expectedWidth: CANVAS,
      expectedHeight: CANVAS,
      row: rows[0]!,
    })
    assert.equal(tampered.status, 'invalid')

    const caseDir = join(runRoot, 'masks', expected[0]!.row_key)
    const wrongSize = await writeMaskU8(
      join(caseDir, 'candidate-0.u8'),
      CANVAS - 1,
      CANVAS,
      () => true,
    )
    await writeFile(join(caseDir, 'mask.u8'), await readFile(join(caseDir, 'candidate-0.u8')))
    const dimensionRow = {
      ...rows[0]!,
      candidate_masks: [
        {
          ...rows[0]!.candidate_masks[0]!,
          sha256: wrongSize.sha256,
          byte_count: wrongSize.byte_count,
        },
      ],
      mask_sha256: wrongSize.sha256,
      foreground_bounds: wrongSize.bounds,
    }
    const dimensionAudit = await auditH11CandidateMask({
      runRoot,
      expectedWidth: CANVAS,
      expectedHeight: CANVAS,
      row: dimensionRow,
    })
    assert.equal(dimensionAudit.status, 'invalid')

    const nonBinary = Buffer.alloc(CANVAS * CANVAS, 2)
    await writeFile(join(caseDir, 'candidate-0.u8'), nonBinary)
    await writeFile(join(caseDir, 'mask.u8'), nonBinary)
    const nonBinaryAudit = await auditH11CandidateMask({
      runRoot,
      expectedWidth: CANVAS,
      expectedHeight: CANVAS,
      row: {
        ...rows[0]!,
        candidate_masks: [
          {
            ...rows[0]!.candidate_masks[0]!,
            sha256: createHash('sha256').update(nonBinary).digest('hex'),
          },
        ],
        mask_sha256: createHash('sha256').update(nonBinary).digest('hex'),
        foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
      },
    })
    assert.equal(nonBinaryAudit.status, 'invalid')
    assert.equal(nonBinaryAudit.reason, 'mask-not-binary-u8')
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('verifyH11EmittedMaskInventory rejects stray mask files', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'zorya-h11-inventory-'))
  const masksDir = join(runRoot, 'masks', 'fixture-00')
  await mkdir(masksDir, { recursive: true })
  await writeFile(join(masksDir, 'candidate-0.u8'), Uint8Array.of(0))
  await writeFile(join(runRoot, 'masks', 'stray.u8'), Uint8Array.of(1))
  const errors: string[] = []
  await verifyH11EmittedMaskInventory(
    runRoot,
    [
      {
        row_index: 0,
        row_key: 'fixture-00',
        authored_target: 't',
        outcome_kind: 'unresolved_no_mask',
        source_width: 1,
        source_height: 1,
        source_sha256: 'a'.repeat(64),
        oriented_rgb_sha256: 'b'.repeat(64),
        composed_prompt_sha256: 'c'.repeat(64),
        prediction_text: null,
        native_mask_count: 1,
        candidate_masks: [
          {
            emission_index: 0,
            path: 'masks/fixture-00/candidate-0.u8',
            sha256: createHash('sha256').update(Uint8Array.of(0)).digest('hex'),
            byte_count: 1,
            width: 1,
            height: 1,
            foreground_bounds: null,
          },
        ],
        selected_mask_index: null,
        generation_token_count: 1,
        generation_truncated: false,
        mask_path: null,
        mask_sha256: null,
        foreground_bounds: null,
        error_code: null,
        error_message: null,
        wall_ms: null,
        peak_vram_allocated_bytes: null,
        peak_vram_reserved_bytes: null,
        generation_diagnostics: alignedGenerationDiagnostics({
          generation_token_count: 1,
          generation_truncated: false,
        }),
      },
    ],
    errors,
  )
  assert.ok(errors.some((item) => item.includes('stray-mask-file')))
  await rm(runRoot, { recursive: true, force: true })
})

await test('verifyH11AssetReceiptMetadata requires full Sa2VA companion lock set', () => {
  const errors = verifyH11AssetReceiptMetadata({})
  assert.ok(errors.some((item) => item.startsWith('asset-receipt-missing-')))
})

const H11_ASSET_STREAM_CHUNK_BYTES = 8192

await test('hashH11AssetFileOnDisk streams multi-chunk files without whole-file buffering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-h11-asset-hash-'))
  const filePath = join(dir, 'multi-chunk.bin')
  const payload = Buffer.alloc(H11_ASSET_STREAM_CHUNK_BYTES + 1, 0x5a)
  await writeFile(filePath, payload)
  try {
    const streamed = await hashH11AssetFileOnDisk(filePath)
    const reference = createHash('sha256').update(payload).digest('hex')
    assert.equal(streamed.sha256, reference)
    assert.equal(streamed.bytes, payload.byteLength)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('verifyH11AssetFileReceiptOnDisk distinguishes digest, size, missing, and unreadable paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-h11-asset-verify-'))
  const filePath = join(dir, 'receipt.bin')
  const payload = Buffer.alloc(H11_ASSET_STREAM_CHUNK_BYTES + 1, 0xab)
  const expected = {
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: payload.byteLength,
  }
  await writeFile(filePath, payload)
  try {
    assert.equal(await verifyH11AssetFileReceiptOnDisk(filePath, expected), 'ok')
    assert.equal(
      await verifyH11AssetFileReceiptOnDisk(filePath, {
        ...expected,
        sha256: '0'.repeat(64),
      }),
      'bytes-mismatch',
    )
    assert.equal(
      await verifyH11AssetFileReceiptOnDisk(filePath, {
        ...expected,
        bytes: expected.bytes - 1,
      }),
      'bytes-mismatch',
    )
    assert.equal(
      await verifyH11AssetFileReceiptOnDisk(join(dir, 'absent.bin'), expected),
      'missing',
    )
    await mkdir(join(dir, 'as-directory'), { recursive: true })
    assert.equal(
      await verifyH11AssetFileReceiptOnDisk(join(dir, 'as-directory'), expected),
      'unreadable',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('diagnostics report multiple native mask counts without affecting selection', async () => {
  const expected = syntheticExpectedRows()
  const specs: RowSpec[] = expected.map((row) =>
    row.presence === 'absent'
      ? { outcome_kind: 'unresolved_no_mask' }
      : {
          outcome_kind: 'candidate',
          native_mask_count: 3,
          paints: [() => false, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30, () => false],
        },
  )
  const { runRoot, rows } = await buildFixtureRun(expected, specs)
  try {
    const report = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.diagnostics.rowsWithMultipleNativeMasks, 9)
    assert.equal(report.diagnostics.maxNativeMaskCount, 3)
    assert.equal(report.gate.cleanPass, true)
    assert.equal(report.perRow[0]?.selectedMaskIndex, 1)
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('evaluator enforces first-empty then first-nonempty candidate selection', async () => {
  const expected = syntheticExpectedRows()
  const { runRoot, rows } = await buildFixtureRun(expected, [
    {
      outcome_kind: 'candidate',
      paints: [() => false, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30],
    },
    ...expected.slice(1).map((row) =>
      row.presence === 'absent'
        ? { outcome_kind: 'unresolved_no_mask' as const }
        : {
            outcome_kind: 'candidate' as const,
            paint: (x: number, y: number) => x >= 10 && x < 30 && y >= 10 && y < 30,
          },
    ),
  ])
  try {
    assert.equal(rows[0]?.selected_mask_index, 1)
    const report = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.cleanPass, true)
    const badSelection = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows: rows.map((row, index) => (index === 0 ? { ...row, selected_mask_index: 0 } : row)),
    })
    assert.equal(badSelection.gate.cleanPass, false)
    assert.ok(
      badSelection.integrityErrors.some((item) =>
        item.includes('selected-mask-index-not-first-nonempty-emission'),
      ),
    )
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('evaluator rejects selected alias bytes that diverge from first nonempty candidate', async () => {
  const expected = syntheticExpectedRows()
  const { runRoot, rows } = await buildFixtureRun(expected, [
    { outcome_kind: 'candidate', wrongSelectedBytes: true },
    ...expected.slice(1).map((row) =>
      row.presence === 'absent'
        ? { outcome_kind: 'unresolved_no_mask' as const }
        : {
            outcome_kind: 'candidate' as const,
            paint: (x: number, y: number) => x >= 10 && x < 30 && y >= 10 && y < 30,
          },
    ),
  ])
  try {
    const report = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(report.gate.cleanPass, false)
    assert.ok(
      report.integrityErrors.some(
        (item) =>
          item.includes('selected-alias-bytes-not-first-nonempty') ||
          item.includes('selected-foreground-bounds-mismatch') ||
          item.includes('selected-mask-sha256-mismatch'),
      ),
    )
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('evaluator flags missing retained candidate artifacts and path escape attempts', async () => {
  const expected = syntheticExpectedRows()
  const { runRoot, rows } = await buildFixtureRun(expected, [
    { outcome_kind: 'candidate', omitCandidateFile: 0 },
    ...expected.slice(1).map((row) =>
      row.presence === 'absent'
        ? { outcome_kind: 'unresolved_no_mask' as const }
        : {
            outcome_kind: 'candidate' as const,
            paint: (x: number, y: number) => x >= 10 && x < 30 && y >= 10 && y < 30,
          },
    ),
  ])
  try {
    const missing = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows,
    })
    assert.equal(missing.gate.cleanPass, false)
    assert.ok(
      missing.integrityErrors.some(
        (item) =>
          item.includes('missing-emitted-mask') ||
          item.includes('candidate-0-mask-file-unreadable'),
      ),
    )

    const escaped = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            candidate_masks: row.candidate_masks.map((candidate) => ({
              ...candidate,
              path: '../outside.u8',
            })),
          }
        : row,
    )
    const escapeReport = await evaluateH11Sa2vaRun({
      runRoot,
      mode: 'synthetic-fixture',
      expectedRows: expected,
      rows: escaped,
    })
    assert.ok(
      escapeReport.integrityErrors.some((item) => item.includes('candidate-mask-path-outside-run')),
    )
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
})

await test('h11FreezeSchema and h11RunSchema accept current producer-shaped receipts', () => {
  const freezeRecord = h11FreezeSchema.parse(syntheticProducerFreezeRecord())
  const runRecord = h11RunSchema.parse(syntheticProducerRunRecord(freezeRecord))
  assert.deepEqual(verifyH11RunRecordProducerBindings(runRecord, freezeRecord), [])
  assert.deepEqual(verifyH11RunRuntimeReceiptConsistency(runRecord, freezeRecord), [])
  assert.deepEqual(verifyH11OverlayWheelsMetadata(freezeRecord.overlay_wheels), [])
  assert.throws(() =>
    h11FreezeSchema.parse({
      ...syntheticProducerFreezeRecord(),
      prepared_at_unix_ms: -1,
    }),
  )
  assert.throws(() =>
    h11RunSchema.parse({
      ...syntheticProducerRunRecord(h11FreezeSchema.parse(syntheticProducerFreezeRecord())),
      worker_stderr_tail: 'x'.repeat(16_385),
    }),
  )
})

await test('freezeRuntimeSchema and run runtime bindings reject malformed CUDA receipts', () => {
  const valid = syntheticProducerRuntimeReceipt()
  assert.doesNotThrow(() => freezeRuntimeSchema.parse(valid))
  const freezeRecord = h11FreezeSchema.parse(syntheticProducerFreezeRecord())
  const runRecord = h11RunSchema.parse(syntheticProducerRunRecord(freezeRecord))
  const runtimeDrift = {
    ...runRecord,
    runtime: { ...runRecord.runtime, torch: '2.7.0+cu124' },
  }
  assert.ok(
    verifyH11RunRuntimeReceiptConsistency(runtimeDrift, freezeRecord).includes(
      'run-runtime-freeze-mismatch',
    ),
  )
  const cudaMirrorBreak = {
    ...runRecord,
    cuda_runtime: { ...runRecord.cuda_runtime, cuda_device_index: 1 },
  }
  assert.ok(
    verifyH11RunRuntimeReceiptConsistency(cudaMirrorBreak, freezeRecord).includes(
      'run-cuda-runtime-not-runtime-cuda-device',
    ),
  )
})

await test('verifyH11InputImageReceipts aligns receipts with manifest and caps', () => {
  const freezeRecord = syntheticProducerFreezeRecord()
  const expectedRows = syntheticExpectedRows()
  const receipts = freezeRecord.input_image_receipts.map((receipt, index) =>
    index === 0
      ? { ...receipt, actual_source_sha256: createHash('sha256').update('tampered').digest('hex') }
      : receipt,
  )
  assert.ok(
    verifyH11InputImageReceipts(
      receipts,
      freezeRecord.rows,
      expectedRows,
      freezeRecord.recipe.max_encoded_bytes,
    ).some((item) => item.includes('actual-manifest-mismatch')),
  )
  assert.ok(
    verifyH11OverlayWheelsMetadata([]).some((item) =>
      item.includes('overlay-wheels-count-mismatch'),
    ),
  )
})

await test('deriveH11RunStatus and verifyH11RunStatusConsistency match producer flags', () => {
  const baseRow = {
    row_index: 0,
    row_key: 'k',
    authored_target: 't',
    outcome_kind: 'candidate' as const,
    source_width: 1,
    source_height: 1,
    source_sha256: 'a'.repeat(64),
    oriented_rgb_sha256: 'b'.repeat(64),
    composed_prompt_sha256: 'c'.repeat(64),
    prediction_text: null,
    native_mask_count: 1,
    candidate_masks: [],
    selected_mask_index: 0,
    generation_token_count: 1,
    generation_truncated: false,
    mask_path: 'masks/k/mask.u8',
    mask_sha256: 'd'.repeat(64),
    foreground_bounds: { x_min: 0, y_min: 0, x_max: 0, y_max: 0 },
    error_code: null,
    error_message: null,
    wall_ms: null,
    peak_vram_allocated_bytes: null,
    peak_vram_reserved_bytes: null,
    generation_diagnostics: alignedGenerationDiagnostics({
      generation_token_count: 1,
      generation_truncated: false,
    }),
  }
  assert.equal(deriveH11RunStatus([baseRow], false, false), 'completed')
  assert.equal(
    deriveH11RunStatus(
      [{ ...baseRow, outcome_kind: 'technical_error', generation_diagnostics: null }],
      false,
      false,
    ),
    'completed_with_technical_errors',
  )
  const freezeRecord = h11FreezeSchema.parse(syntheticProducerFreezeRecord())
  const runRecord = h11RunSchema.parse({
    ...syntheticProducerRunRecord(freezeRecord),
    cleanup_failed: true,
    status: 'worker_cleanup_failed',
  })
  assert.deepEqual(verifyH11RunStatusConsistency(runRecord, [baseRow]), [])
  const mismatch = h11RunSchema.parse({
    ...runRecord,
    status: 'completed',
  })
  assert.ok(
    verifyH11RunStatusConsistency(mismatch, [baseRow]).some((item) =>
      item.includes('derived-mismatch'),
    ),
  )
})

await test('h11RowSchema accepts row diagnostics and rejects normalized-out worker fields', () => {
  const baseRow = {
    row_index: 0,
    row_key: 'k',
    authored_target: 't',
    outcome_kind: 'candidate' as const,
    source_width: 1,
    source_height: 1,
    source_sha256: 'a'.repeat(64),
    oriented_rgb_sha256: null,
    composed_prompt_sha256: null,
    prediction_text: null,
    native_mask_count: 0,
    candidate_masks: [],
    selected_mask_index: null,
    generation_token_count: null,
    generation_truncated: null,
    mask_path: null,
    mask_sha256: null,
    foreground_bounds: null,
    error_code: null,
    error_message: null,
    wall_ms: null,
    peak_vram_allocated_bytes: null,
    peak_vram_reserved_bytes: null,
    generation_diagnostics: null,
  }
  assert.doesNotThrow(() => h11RowSchema.parse(baseRow))
  assert.doesNotThrow(() =>
    h11RowSchema.parse({
      ...baseRow,
      wall_ms: 12.5,
      peak_vram_allocated_bytes: 4096,
      peak_vram_reserved_bytes: 8192,
      generation_diagnostics: alignedGenerationDiagnostics({
        generation_token_count: 2,
        generation_truncated: false,
      }),
    }),
  )
  assert.throws(() =>
    h11RowSchema.parse({
      ...baseRow,
      generation_diagnostics: {
        actual_max_new_tokens_applied: 64,
        do_sample_applied: false,
        generated_token_count: 1,
        stopped_on_eos: true,
      },
    }),
  )
  assert.throws(() => h11RowSchema.parse({ ...baseRow, peak_allocated_bytes: 1 }))
  assert.throws(() => h11RowSchema.parse({ ...baseRow, prep_ms: 12 }))
  assert.throws(() => h11RowSchema.parse({ ...baseRow, interpolate_pos_encoding: true }))
  assert.throws(() => h11RowSchema.parse({ ...baseRow, type: 'candidate' }))
})

function rowInputReceiptIdentityFixture() {
  const expectedRows = syntheticExpectedRows()
  const manifestRows = expectedRows.map((row) => ({
    row_index: row.row_index,
    row_key: row.row_key,
    source_path: `/tmp/fixture/${row.row_key}.png`,
    authored_target: row.authored_target,
    source_sha256: row.expectedSourceSha256,
  }))
  const input_image_receipts = expectedRows.map((row) => ({
    row_index: row.row_index,
    row_key: row.row_key,
    source_path: `/tmp/fixture/${row.row_key}.png`,
    manifest_source_sha256: row.expectedSourceSha256,
    actual_source_sha256: row.expectedSourceSha256,
    encoded_bytes: 1000 + row.row_index,
    oriented_rgb_sha256: createHash('sha256').update(`rgb-${row.row_index}`).digest('hex'),
    source_width: row.sourceWidth,
    source_height: row.sourceHeight,
  }))
  const freezeRecord = h11FreezeSchema.parse({
    ...syntheticProducerFreezeRecord(),
    rows: manifestRows,
    input_image_receipts,
  })
  return { expectedRows, freezeRecord, input_image_receipts }
}

function boundIdentityRow(
  expectedRow: ExpectedH10PilotRow,
  input_image_receipts: ReturnType<typeof rowInputReceiptIdentityFixture>['input_image_receipts'],
  outcome_kind: 'unresolved_no_mask' | 'technical_error' = 'unresolved_no_mask',
) {
  const receipt = input_image_receipts[expectedRow.row_index]!
  return {
    row_index: expectedRow.row_index,
    row_key: expectedRow.row_key,
    authored_target: expectedRow.authored_target,
    outcome_kind,
    source_width: outcome_kind === 'technical_error' ? null : expectedRow.sourceWidth,
    source_height: outcome_kind === 'technical_error' ? null : expectedRow.sourceHeight,
    source_sha256: expectedRow.expectedSourceSha256,
    oriented_rgb_sha256: outcome_kind === 'technical_error' ? null : receipt.oriented_rgb_sha256,
    composed_prompt_sha256:
      outcome_kind === 'technical_error'
        ? null
        : recomputeH11ComposedPromptSha256(H11_PROMPT_TEMPLATE, expectedRow.authored_target),
    prediction_text: null,
    native_mask_count: outcome_kind === 'technical_error' ? null : 0,
    candidate_masks: [],
    selected_mask_index: null,
    generation_token_count: outcome_kind === 'technical_error' ? null : 0,
    generation_truncated: outcome_kind === 'technical_error' ? null : false,
    mask_path: null,
    mask_sha256: null,
    foreground_bounds: null,
    error_code: outcome_kind === 'technical_error' ? 'H11_ERROR' : null,
    error_message: outcome_kind === 'technical_error' ? 'fixture' : null,
    wall_ms: null,
    peak_vram_allocated_bytes: null,
    peak_vram_reserved_bytes: null,
    generation_diagnostics:
      outcome_kind === 'technical_error'
        ? null
        : alignedGenerationDiagnostics({ generation_token_count: 0, generation_truncated: false }),
  }
}

await test('verifyH11RowInputReceiptIdentity accepts bound inference rows', () => {
  const { expectedRows, freezeRecord, input_image_receipts } = rowInputReceiptIdentityFixture()
  const row = boundIdentityRow(expectedRows[0]!, input_image_receipts)
  assert.deepEqual(
    verifyH11RowInputReceiptIdentity({ rows: [row], freezeRecord, expectedRows }),
    [],
  )
})

await test('verifyH11RowInputReceiptIdentity rejects altered authored target', () => {
  const { expectedRows, freezeRecord, input_image_receipts } = rowInputReceiptIdentityFixture()
  const row = {
    ...boundIdentityRow(expectedRows[0]!, input_image_receipts),
    authored_target: 'tampered-target',
  }
  assert.ok(
    verifyH11RowInputReceiptIdentity({ rows: [row], freezeRecord, expectedRows }).some((item) =>
      item.includes('row-authored-target-expected-mismatch'),
    ),
  )
})

await test('verifyH11RowInputReceiptIdentity rejects composed prompt hash drift', () => {
  const { expectedRows, freezeRecord, input_image_receipts } = rowInputReceiptIdentityFixture()
  const row = {
    ...boundIdentityRow(expectedRows[0]!, input_image_receipts),
    composed_prompt_sha256: '0'.repeat(64),
  }
  assert.ok(
    verifyH11RowInputReceiptIdentity({ rows: [row], freezeRecord, expectedRows }).some((item) =>
      item.includes('row-composed-prompt-sha256-mismatch'),
    ),
  )
})

await test('verifyH11RowInputReceiptIdentity rejects oriented rgb hash drift', () => {
  const { expectedRows, freezeRecord, input_image_receipts } = rowInputReceiptIdentityFixture()
  const row = {
    ...boundIdentityRow(expectedRows[0]!, input_image_receipts),
    oriented_rgb_sha256: '0'.repeat(64),
  }
  assert.ok(
    verifyH11RowInputReceiptIdentity({ rows: [row], freezeRecord, expectedRows }).some((item) =>
      item.includes('row-oriented-rgb-sha256-receipt-mismatch'),
    ),
  )
})

await test('verifyH11RowInputReceiptIdentity accepts technical rows with explicit null inference facts', () => {
  const { expectedRows, freezeRecord, input_image_receipts } = rowInputReceiptIdentityFixture()
  const row = boundIdentityRow(expectedRows[0]!, input_image_receipts, 'technical_error')
  assert.deepEqual(
    verifyH11RowInputReceiptIdentity({ rows: [row], freezeRecord, expectedRows }),
    [],
  )
})
