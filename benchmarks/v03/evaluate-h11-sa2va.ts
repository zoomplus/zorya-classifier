import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Box } from '../v02/metrics.js'
import { wholeObjectMatch } from '../v02/metrics.js'
import { evaluateV03Pilot, loadV03PilotTruth, type V03PilotTruth } from './evaluate-pilot.js'
import {
  H10_REAL_RUN_DEVICE,
  H10_RUN_WORKER_STDERR_TAIL_MAX_CHARS,
  MINIMAL_DEV_MANIFEST_SHA256,
  buildExpectedH10PilotRows,
  compareLockedManifestToFreezeRows,
  expectedManifestRowsMatch,
  foregroundBoundsToBox,
  maskForegroundBounds,
  resolveMaskPathWithinRunRoot,
  verifyCudaDevRunReceiptConsistency,
  verifyFrozenManifestSources,
  verifyLockedSourcePathClosure,
  verifyMinimalDevManifestFile,
  verifyRunDeviceAndFreezePath,
  verifyScriptPathHash,
  type ExpectedH10PilotRow,
} from './evaluate-h10-clipseg.js'
import { loadV03PilotCorpus, v03PilotRepositoryRoot } from './pilot-manifest.js'

/** Frozen H11 producer contract digest (Wave 1 lock). */
export const H11_CONTRACT_SHA256 =
  '14281b417d8fc2838cd52ff6bf05cb63aae493bc9968b5a4f20b6b482d58ccdd'

/** Frozen H11b direct-GPU producer contract digest (Wave 1 lock). */
export const H11B_CONTRACT_SHA256 =
  'ee623e58181f5db22d77720760438b0b34342c708a9f5f99037446d4d3846908'

export const H11_REPOSITORY_CONTRACT_PATH = fileURLToPath(
  new URL('./h11-sa2va-contract.json', import.meta.url),
)

export const H11B_REPOSITORY_CONTRACT_PATH = fileURLToPath(
  new URL('./h11b-sa2va-direct-gpu-contract.json', import.meta.url),
)

export const H11B_RUNTIME_PROFILE_ID = 'h11b-direct-cuda-v1'

const H11B_APPROVED_LOADER_DEVICE_MAP = Object.freeze({ '': 'cuda:0' } as const)

const h11LoaderDeviceMapSchema = z.object({ '': z.literal('cuda:0') }).strict()

export function isApprovedH11ContractSha256(digest: string): boolean {
  return digest === H11_CONTRACT_SHA256 || digest === H11B_CONTRACT_SHA256
}

export const H11_POSITIVE_DENOMINATOR = 9
export const H11_NEGATIVE_DENOMINATOR = 3
export const H11_POSITIVE_SUCCESS_MINIMUM = 7
export const H11_FALSE_OUTPUTS_MAXIMUM = 0
export const H11_NATIVE_MASK_MAX_COUNT = 8
export const H11_NATIVE_MASK_MAX_BYTES_PER_ROW = 16 * 1024 * 1024
export const H11_GENERATION_MAX_NEW_TOKENS = 128

export const H11_REFERENCE_BASELINE_H10 = Object.freeze({
  positiveSuccesses: 0,
  falseOutputs: 1,
})

export type H11EvaluationMode = 'dev-run' | 'synthetic-fixture'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boundsSchema = z
  .object({
    x_min: z.number().int().nonnegative(),
    y_min: z.number().int().nonnegative(),
    x_max: z.number().int().nonnegative(),
    y_max: z.number().int().nonnegative(),
  })
  .strict()

const manifestRowSchema = z
  .object({
    row_index: z.number().int().min(0).max(11),
    row_key: z.string().min(1),
    source_path: z.string().min(1),
    authored_target: z.string().min(1),
    source_sha256: digestSchema,
  })
  .strict()

const rowOutcomeSchema = z.enum([
  'candidate',
  'unresolved_no_mask',
  'technical_error',
  'integrity_failure',
])

export const h11RunStatusSchema = z.enum([
  'completed',
  'completed_with_integrity_errors',
  'completed_with_technical_errors',
  'worker_cleanup_failed',
  'cancelled',
])

const candidateMaskSchema = z
  .object({
    emission_index: z.number().int().nonnegative(),
    path: z.string().min(1),
    sha256: digestSchema,
    byte_count: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    foreground_bounds: boundsSchema.nullable(),
  })
  .strict()

const runTimingMsSchema = z.number().finite().nonnegative()

const generationDiagnosticsSchema = z
  .object({
    actual_max_new_tokens_applied: z.literal(H11_GENERATION_MAX_NEW_TOKENS),
    do_sample_applied: z.literal(false),
    generated_token_count: z.number().int().nonnegative(),
    stopped_on_eos: z.boolean(),
  })
  .strict()

const h11RowSchema = z
  .object({
    row_index: z.number().int().min(0).max(11),
    row_key: z.string().min(1),
    authored_target: z.string().min(1),
    outcome_kind: rowOutcomeSchema,
    source_width: z.number().int().positive().nullable(),
    source_height: z.number().int().positive().nullable(),
    source_sha256: digestSchema,
    oriented_rgb_sha256: digestSchema.nullable(),
    composed_prompt_sha256: digestSchema.nullable(),
    prediction_text: z.string().nullable(),
    native_mask_count: z.number().int().nonnegative().nullable(),
    candidate_masks: z.array(candidateMaskSchema),
    selected_mask_index: z.number().int().nonnegative().nullable(),
    generation_token_count: z.number().int().nonnegative().nullable(),
    generation_truncated: z.boolean().nullable(),
    mask_path: z.string().nullable(),
    mask_sha256: digestSchema.nullable(),
    foreground_bounds: boundsSchema.nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    wall_ms: runTimingMsSchema.nullable(),
    peak_vram_allocated_bytes: z.number().int().nonnegative().nullable(),
    peak_vram_reserved_bytes: z.number().int().nonnegative().nullable(),
    generation_diagnostics: generationDiagnosticsSchema.nullable(),
  })
  .strict()

const processorAttestationSchema = z
  .object({
    processor_class: z.literal('Qwen3VLProcessor'),
    processor_module: z.literal('transformers.models.qwen3_vl.processing_qwen3_vl'),
    image_processor_class: z.literal('Qwen2VLImageProcessor'),
    image_processor_module: z.literal('transformers.models.qwen2_vl.image_processing_qwen2_vl'),
    load_argument_use_fast: z.literal(false),
  })
  .strict()

const h11RecipeSchema = z
  .object({
    model_id: z.literal('ByteDance/Sa2VA-Qwen3-VL-2B'),
    revision: z.literal('173fb6512b3ad6f3c1fe25efa09e723d01d5b6d4'),
    torch_dtype: z.literal('bfloat16'),
    eval_mode: z.literal(true),
    inference_mode: z.literal(true),
    requested_device: z.string().min(1),
    attention_eager: z.literal(true),
    use_flash_attn: z.literal(false),
    prompt_template: z.string().min(1),
    prompt_template_sha256: digestSchema,
    generation_max_new_tokens: z.literal(H11_GENERATION_MAX_NEW_TOKENS),
    generation_do_sample: z.literal(false),
    sam2_fill_hole_area: z.literal(0),
    sam2_compile_image_encoder: z.literal(false),
    max_encoded_bytes: z.literal(25_165_824),
    max_oriented_pixels: z.literal(2_097_152),
    retain_native_masks_max_count: z.literal(H11_NATIVE_MASK_MAX_COUNT),
    retain_native_masks_max_bytes_per_row: z.literal(H11_NATIVE_MASK_MAX_BYTES_PER_ROW),
    loader_device_map: h11LoaderDeviceMapSchema.optional(),
  })
  .strict()

const h11ScriptReceiptsSchema = z
  .object({
    h11_common_script_path: z.string().min(1),
    h11_common_script_sha256: digestSchema,
    h11_runner_script_path: z.string().min(1),
    h11_runner_script_sha256: digestSchema,
    h11_worker_script_path: z.string().min(1),
    h11_worker_script_sha256: digestSchema,
    h10_common_script_path: z.string().min(1),
    h10_common_script_sha256: digestSchema,
    h10_runner_script_path: z.string().min(1),
    h10_runner_script_sha256: digestSchema,
    contract_path: z.string().min(1),
    contract_sha256: digestSchema,
  })
  .strict()

const cudaRuntimeUnavailableSchema = z.object({ cuda_available: z.literal(false) }).strict()
const cudaRuntimeAvailableSchema = z
  .object({
    cuda_available: z.literal(true),
    cuda_device_index: z.number().int().nonnegative(),
    cuda_device_name: z.string().min(1).max(512),
    cuda_version: z.union([z.string().max(64), z.null()]),
  })
  .strict()
const cudaRuntimeSchema = z.discriminatedUnion('cuda_available', [
  cudaRuntimeUnavailableSchema,
  cudaRuntimeAvailableSchema,
])

const freezeRuntimeReceiptSchema = z
  .object({
    python_executable: z.string().min(1),
    python_version: z.string().min(1),
    torch: z.string().min(1),
    transformers: z.string().min(1),
    torchvision: z.string().min(1),
    pillow: z.string().min(1),
    numpy: z.string().min(1),
    platform: z.string().min(1),
    cuda_available: z.boolean(),
    cuda_version: z.string(),
  })
  .strict()

const freezeRuntimeSchema = freezeRuntimeReceiptSchema
  .extend({ cuda_device: cudaRuntimeSchema })
  .strict()

const inputImageReceiptSchema = z
  .object({
    row_index: z.number().int().min(0).max(11),
    row_key: z.string().min(1),
    source_path: z.string().min(1),
    manifest_source_sha256: digestSchema,
    actual_source_sha256: digestSchema,
    encoded_bytes: z.number().int().nonnegative(),
    oriented_rgb_sha256: digestSchema,
    source_width: z.number().int().positive(),
    source_height: z.number().int().positive(),
  })
  .strict()

const overlayWheelSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    filename: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: digestSchema,
  })
  .strict()

const h11FreezeSchema = z
  .object({
    schema: z.literal('v03-h11-sa2va-freeze-v1'),
    prepared_at_unix_ms: z.number().int().nonnegative(),
    manifest_path: z.string().min(1),
    manifest_sha256: digestSchema,
    contract_path: z.string().min(1),
    contract_sha256: digestSchema,
    asset_dir: z.string().min(1),
    asset_receipts: z.record(
      z.object({ sha256: digestSchema, bytes: z.number().int().nonnegative() }).strict(),
    ),
    rows: z.array(manifestRowSchema).length(12),
    recipe: h11RecipeSchema,
    processor_attestation: processorAttestationSchema,
    runtime: freezeRuntimeSchema,
    script_receipts: h11ScriptReceiptsSchema,
    requested_device: z.literal(H10_REAL_RUN_DEVICE),
    input_image_receipts: z.array(inputImageReceiptSchema).length(12),
    overlay_wheels: z.array(overlayWheelSchema),
  })
  .strict()

const h11RunSchema = z
  .object({
    schema: z.literal('v03-h11-sa2va-run-v1'),
    status: h11RunStatusSchema,
    freeze_path: z.string().min(1),
    freeze_sha256: digestSchema,
    manifest_sha256: digestSchema,
    contract_sha256: digestSchema,
    device: z.literal(H10_REAL_RUN_DEVICE),
    cuda_runtime: cudaRuntimeSchema,
    runtime: freezeRuntimeSchema,
    script_receipts: h11ScriptReceiptsSchema,
    load_ms: runTimingMsSchema.nullable(),
    wall_ms: runTimingMsSchema,
    worker_pid: z.number().int().positive().nullable(),
    worker_stderr_tail: z.string().max(H10_RUN_WORKER_STDERR_TAIL_MAX_CHARS),
    row_count: z.number().int(),
    cleanup_failed: z.boolean(),
    cancelled: z.boolean(),
  })
  .strict()

/** Pinned companion artifacts from benchmarks/v03/h11-sa2va-contract.json required_model_files. */
export const EXPECTED_H11_ASSET_RECEIPTS: Record<string, { sha256: string; bytes: number }> =
  Object.freeze({
    'README.md': {
      sha256: 'a869c2d4e3c2420604d8bc654e039b1399be34bd1180988df2e853e8de2ab267',
      bytes: 7920,
    },
    'added_tokens.json': {
      sha256: 'cdece9724d3292a6449f2c0a7024e618630fa1ea03761da5f2a34232708ce3b5',
      bytes: 798,
    },
    'chat_template.jinja': {
      sha256: '3636d0f0bd6bef02654cdffdc447b79cb2cef8ab02cc75267345946291a489e4',
      bytes: 5292,
    },
    'config.json': {
      sha256: 'ca996334e8ec5d2bc3881edb97c92f54d638f2ae6b3f56a216e28b26e35fd44c',
      bytes: 1721,
    },
    'configuration_sa2va_chat.py': {
      sha256: '146aaa1001fb23e64b85481eb230792b42a3b361a27797f1101de3e0be08facb',
      bytes: 908,
    },
    'merges.txt': {
      sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',
      bytes: 1_671_853,
    },
    'model.safetensors.index.json': {
      sha256: 'a1dbe0d08dd3e22dd8efb7416ba2a5e1d44c4829bf2afe62a599d5de1bc47d76',
      bytes: 167_576,
    },
    'model-00001-of-00003.safetensors': {
      sha256: '7cc03916bae54cfcbfa2980babd51aa76f7b9f4cc32b9750db461a0fd07e96c3',
      bytes: 4_984_499_384,
    },
    'model-00002-of-00003.safetensors': {
      sha256: '0f3fccf6fca3f76881f2f001787fe3e1642cf00377a7d17a882920de2b9eeda0',
      bytes: 4_998_015_368,
    },
    'model-00003-of-00003.safetensors': {
      sha256: '7ce4070a6ff44f7e37a960a7049849590ce6b1557394178d906a296d34654414',
      bytes: 684_797_432,
    },
    'modeling_sa2va_qwen.py': {
      sha256: '67984fe54e96dd483518db42761220cfff4f47b53663ba45c27efb4118705ece',
      bytes: 9407,
    },
    'preprocessor_config.json': {
      sha256: '93585062a80db5e8ca038efc7726a3e6411d9db948472d81d63c6303993be8c5',
      bytes: 782,
    },
    'sam2.py': {
      sha256: 'c891b540bf92e102895c5eac17de64c14b7ea6184ded6d2359f24e8b46593fcc',
      bytes: 176_490,
    },
    'special_tokens_map.json': {
      sha256: '76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd',
      bytes: 613,
    },
    'templates.py': {
      sha256: '585663d5c3cf9bba1ee095ae45f88af0866129d70436cbc2ef8aefe957db38d2',
      bytes: 6956,
    },
    'tokenizer.json': {
      sha256: 'ade4f08c34dfcbd3b4d11082162940b785e27af18f916549aa4bc223155c91b8',
      bytes: 11_423_560,
    },
    'tokenizer_config.json': {
      sha256: '5b0d78def291c852daf8a28ed334384019dd561bb877102140364c976fe33264',
      bytes: 6328,
    },
    'video_preprocessor_config.json': {
      sha256: '59c5c9eb52182eb14c06ffb10ca9effd29adce5f238a95de23ca14a38dbd2cb1',
      bytes: 817,
    },
    'vocab.json': {
      sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      bytes: 2_776_833,
    },
  })

/** Pinned overlay installer wheels from benchmarks/v03/h11-sa2va-contract.json. */
export const EXPECTED_H11_OVERLAY_WHEELS: ReadonlyArray<z.infer<typeof overlayWheelSchema>> =
  Object.freeze([
    {
      name: 'qwen-vl-utils',
      version: '0.0.14',
      filename: 'qwen_vl_utils-0.0.14-py3-none-any.whl',
      bytes: 8120,
      sha256: '5e28657bfd031e56bd447c5901b58ddfc3835285ed100f4c56580e0ade054e96',
    },
    {
      name: 'av',
      version: '16.0.1',
      filename: 'av-16.0.1-cp312-cp312-manylinux_2_28_x86_64.whl',
      bytes: 40_549_383,
      sha256: 'daecc2072b82b6a942acbdaa9a2e00c05234c61fef976b22713983c020b07992',
    },
    {
      name: 'accelerate',
      version: '1.11.0',
      filename: 'accelerate-1.11.0-py3-none-any.whl',
      bytes: 375_777,
      sha256: 'a628fa6beb069b8e549460fc449135d5bd8d73e7a11fd09f0bc9fc4ace7f06f1',
    },
    {
      name: 'psutil',
      version: '7.1.0',
      filename:
        'psutil-7.1.0-cp36-abi3-manylinux_2_12_x86_64.manylinux2010_x86_64.manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
      bytes: 291_163,
      sha256: '8c70e113920d51e89f212dd7be06219a9b88014e63a4cec69b684c327bc474e3',
    },
  ])

export type H11MaskAudit = {
  status: 'not_applicable' | 'valid' | 'invalid'
  reason: string | null
  maskDerivedBox: Box | null
  recomputedBounds: z.infer<typeof boundsSchema> | null
}

export type H11EvaluatedRow = {
  row_index: number
  row_key: string
  caseId: string
  stratum: V03PilotTruth['stratum']
  presence: V03PilotTruth['presence']
  outcome_kind: z.infer<typeof rowOutcomeSchema> | 'missing'
  positiveSuccess: boolean
  negativeFalseOutput: boolean
  wholeObjectMatched: boolean
  bestIoU: number
  bestCoverage: number
  maskAudit: H11MaskAudit
  nativeMaskCount: number | null
  selectedMaskIndex: number | null
  joinErrors: string[]
  rowErrors: string[]
}

export type H11EvaluationReport = {
  schema: 'v03-h11-sa2va-evaluation-v1'
  hypothesis: 'h11-sa2va-text-mask'
  integrityErrors: string[]
  gate: {
    positiveDenominator: number
    positiveSuccessesMinimum: number
    positiveSuccesses: number
    negativeDenominator: number
    falseOutputsMaximum: number
    falseOutputs: number
    technicalOrIntegrityDefects: number
    cleanPass: boolean
  }
  referenceBaselineH10: typeof H11_REFERENCE_BASELINE_H10
  diagnostics: {
    rowsWithMultipleNativeMasks: number
    maxNativeMaskCount: number | null
  }
  pilotEvaluation: Awaited<ReturnType<typeof evaluateV03Pilot>> | null
  stratumSummary: Record<
    V03PilotTruth['stratum'],
    {
      positives: number
      positiveSuccesses: number
      negatives: number
      falseOutputs: number
    }
  >
  perRow: H11EvaluatedRow[]
}

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Bounded read chunk size for H11 on-disk asset SHA-256 (must stay below Node buffer limits). */
const H11_ASSET_STREAM_HIGH_WATER_MARK = 1048576

export type H11AssetFileDigest = { sha256: string; bytes: number }

export type H11AssetFileVerifyResult = 'ok' | 'bytes-mismatch' | 'missing' | 'unreadable'

function isH11AssetPathMissingError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function hashH11AssetFileOnDisk(path: string): Promise<H11AssetFileDigest> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createReadStream(path, { highWaterMark: H11_ASSET_STREAM_HIGH_WATER_MARK })
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += buf.byteLength
      hash.update(buf)
    })
    stream.on('error', reject)
    stream.on('end', () => {
      resolve({ sha256: hash.digest('hex'), bytes })
    })
  })
}

export async function verifyH11AssetFileReceiptOnDisk(
  filePath: string,
  expected: { sha256: string; bytes: number },
): Promise<H11AssetFileVerifyResult> {
  let link: Awaited<ReturnType<typeof lstat>>
  try {
    link = await lstat(filePath)
  } catch (error: unknown) {
    return isH11AssetPathMissingError(error) ? 'missing' : 'unreadable'
  }
  if (link.isDirectory() || (!link.isFile() && !link.isSymbolicLink())) return 'unreadable'
  let digest: H11AssetFileDigest
  try {
    digest = await hashH11AssetFileOnDisk(filePath)
  } catch (error: unknown) {
    return isH11AssetPathMissingError(error) ? 'missing' : 'unreadable'
  }
  if (digest.sha256 !== expected.sha256 || digest.bytes !== expected.bytes) return 'bytes-mismatch'
  return 'ok'
}

export function recomputeH11ComposedPromptSha256(
  promptTemplate: string,
  authoredTarget: string,
): string {
  const composed = promptTemplate.replace('{authored_target}', authoredTarget)
  return sha256(Buffer.from(composed, 'utf8'))
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function resolveReadablePath(path: string): Promise<string> {
  const resolved = resolve(path)
  await stat(resolved)
  return realpath(resolved)
}

function boundsEqual(
  left: z.infer<typeof boundsSchema>,
  right: z.infer<typeof boundsSchema>,
): boolean {
  return (
    left.x_min === right.x_min &&
    left.y_min === right.y_min &&
    left.x_max === right.x_max &&
    left.y_max === right.y_max
  )
}

export function verifyH11AssetReceiptMetadata(
  receipts: Record<string, { sha256: string; bytes: number }>,
): string[] {
  const errors: string[] = []
  for (const [path, expected] of Object.entries(EXPECTED_H11_ASSET_RECEIPTS)) {
    const actual = receipts[path]
    if (!actual) {
      errors.push(`asset-receipt-missing-${path}`)
      continue
    }
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      errors.push(`asset-receipt-metadata-mismatch-${path}`)
  }
  return errors
}

export async function verifyH11AssetDirectoryOnDisk(
  assetDir: string,
  integrityErrors: string[],
): Promise<void> {
  let root: string
  try {
    root = await resolveReadablePath(assetDir)
  } catch {
    integrityErrors.push('asset-dir-unreadable')
    return
  }
  for (const [name, expected] of Object.entries(EXPECTED_H11_ASSET_RECEIPTS)) {
    const candidate = resolve(root, name)
    const part = relative(root, candidate)
    if (!part || part.startsWith(`..${sep}`) || isAbsolute(part)) {
      integrityErrors.push(`asset-path-escape-${name}`)
      continue
    }
    const receiptStatus = await verifyH11AssetFileReceiptOnDisk(candidate, expected)
    if (receiptStatus === 'bytes-mismatch') integrityErrors.push(`asset-bytes-mismatch-${name}`)
    if (receiptStatus === 'missing') {
      integrityErrors.push(`asset-file-missing-${name}`)
      continue
    }
    if (receiptStatus === 'unreadable') {
      integrityErrors.push(`asset-file-unreadable-${name}`)
      continue
    }
    try {
      const link = await lstat(candidate)
      const resolved = await realpath(candidate)
      const escaped = relative(root, resolved)
      if (!escaped || escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
        integrityErrors.push(`asset-symlink-escape-${name}`)
      if (link.isSymbolicLink() && resolved !== candidate)
        integrityErrors.push(`asset-symlink-redirect-${name}`)
    } catch {
      integrityErrors.push(`asset-file-unreadable-${name}`)
    }
  }
}

function readContractFromPretrainedLoaderArgs(
  contract: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const model = contract.model as
    | { loader?: { from_pretrained?: Record<string, unknown> } }
    | undefined
  return model?.loader?.from_pretrained
}

function hasContractLoaderDeviceMapProperty(contract: Record<string, unknown>): boolean {
  const fromPretrained = readContractFromPretrainedLoaderArgs(contract)
  if (fromPretrained === undefined) return false
  return Object.prototype.hasOwnProperty.call(fromPretrained, 'device_map')
}

function readContractLoaderDeviceMap(
  contract: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const fromPretrained = readContractFromPretrainedLoaderArgs(contract)
  if (fromPretrained === undefined) return undefined
  return fromPretrained.device_map as Record<string, unknown> | null | undefined
}

function contractLoaderDeviceMapMatchesApproved(
  deviceMap: Record<string, unknown> | null,
): boolean {
  const keys = Object.keys(deviceMap ?? {})
  if (keys.length !== 1 || keys[0] !== '') return false
  return deviceMap?.[''] === H11B_APPROVED_LOADER_DEVICE_MAP['']
}

export function validateApprovedH11ContractShape(contract: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (contract.schema !== 'v03-h11-sa2va-producer-contract-v1')
    errors.push('contract-schema-mismatch')
  if (contract.hypothesis !== 'h11-sa2va-text-mask') errors.push('contract-hypothesis-mismatch')
  const payload = contract.model_conditioning_payload as { fields?: string[] } | undefined
  const conditioning = payload?.fields ?? []
  if (
    conditioning.length !== 2 ||
    conditioning[0] !== 'oriented_source_rgb' ||
    conditioning[1] !== 'composed_prompt_with_authored_target'
  )
    errors.push('contract-model-conditioning-fields-mismatch')
  const maskHandling = contract.mask_handling as
    | { retain_native_masks_max_count?: number; retain_native_masks_max_bytes_per_row?: number }
    | undefined
  if (maskHandling?.retain_native_masks_max_count !== H11_NATIVE_MASK_MAX_COUNT)
    errors.push('contract-native-mask-count-cap-mismatch')
  if (maskHandling?.retain_native_masks_max_bytes_per_row !== H11_NATIVE_MASK_MAX_BYTES_PER_ROW)
    errors.push('contract-native-mask-bytes-cap-mismatch')
  return errors
}

export function validateH11ContractProfileIdentity(
  contractSha256: string,
  contract: Record<string, unknown>,
): string[] {
  const errors: string[] = []
  if (!isApprovedH11ContractSha256(contractSha256)) {
    errors.push('contract-sha256-not-approved')
    return errors
  }
  const runtimeProfileId = contract.runtime_profile_id
  const deviceMap = readContractLoaderDeviceMap(contract)
  const hasRuntimeProfileId = Object.prototype.hasOwnProperty.call(contract, 'runtime_profile_id')
  const hasDeviceMapProperty = hasContractLoaderDeviceMapProperty(contract)

  if (contractSha256 === H11_CONTRACT_SHA256) {
    if (hasRuntimeProfileId) errors.push('contract-runtime-profile-id-unexpected')
    if (hasDeviceMapProperty) errors.push('contract-loader-device-map-unexpected')
    return errors
  }

  if (!hasRuntimeProfileId) errors.push('contract-runtime-profile-id-missing')
  else if (runtimeProfileId !== H11B_RUNTIME_PROFILE_ID)
    errors.push('contract-runtime-profile-id-mismatch')
  if (!hasDeviceMapProperty) errors.push('contract-loader-device-map-missing')
  else if (!contractLoaderDeviceMapMatchesApproved(deviceMap ?? null))
    errors.push('contract-loader-device-map-mismatch')
  return errors
}

export function verifyH11RecipeProfileBinding(
  recipe: z.infer<typeof h11RecipeSchema>,
  contractSha256: string,
): string[] {
  const errors: string[] = []
  if (!isApprovedH11ContractSha256(contractSha256)) {
    errors.push('recipe-contract-sha256-not-approved')
    return errors
  }
  const hasLoaderDeviceMap = recipe.loader_device_map !== undefined
  if (contractSha256 === H11_CONTRACT_SHA256) {
    if (hasLoaderDeviceMap) errors.push('recipe-loader-device-map-unexpected-for-legacy-profile')
    return errors
  }
  if (!hasLoaderDeviceMap) errors.push('recipe-loader-device-map-missing-for-h11b-profile')
  else if (
    recipe.loader_device_map?.[''] !== H11B_APPROVED_LOADER_DEVICE_MAP[''] ||
    Object.keys(recipe.loader_device_map).length !== 1
  )
    errors.push('recipe-loader-device-map-mismatch')
  return errors
}

export async function verifyH11ContractFile(
  contractPath: string,
  expectedSha256: string,
  integrityErrors: string[],
): Promise<Record<string, unknown> | null> {
  let path: string
  try {
    path = await resolveReadablePath(contractPath)
  } catch {
    integrityErrors.push('contract-path-unreadable')
    return null
  }
  try {
    const bytes = await readFile(path)
    if (sha256(bytes) !== expectedSha256) integrityErrors.push('contract-bytes-sha256-mismatch')
    const contract = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    integrityErrors.push(...validateApprovedH11ContractShape(contract))
    integrityErrors.push(...validateH11ContractProfileIdentity(expectedSha256, contract))
    return contract
  } catch {
    integrityErrors.push('contract-bytes-unreadable')
    return null
  }
}

export function verifyProcessorAttestation(
  attestation: z.infer<typeof processorAttestationSchema>,
): string[] {
  const errors: string[] = []
  if (attestation.processor_class !== 'Qwen3VLProcessor') errors.push('processor-class-mismatch')
  if (attestation.processor_module !== 'transformers.models.qwen3_vl.processing_qwen3_vl')
    errors.push('processor-module-mismatch')
  if (attestation.image_processor_class !== 'Qwen2VLImageProcessor')
    errors.push('image-processor-class-mismatch')
  if (
    attestation.image_processor_module !== 'transformers.models.qwen2_vl.image_processing_qwen2_vl'
  )
    errors.push('image-processor-module-mismatch')
  if (attestation.load_argument_use_fast !== false)
    errors.push('processor-load-argument-use-fast-not-false')
  return errors
}

export function verifyH11Recipe(recipe: z.infer<typeof h11RecipeSchema>): string[] {
  const errors: string[] = []
  if (recipe.requested_device !== H10_REAL_RUN_DEVICE)
    errors.push('recipe-requested-device-mismatch')
  if (recipe.sam2_fill_hole_area !== 0) errors.push('recipe-sam2-fill-hole-area-not-zero')
  if (recipe.sam2_compile_image_encoder !== false)
    errors.push('recipe-sam2-compile-image-encoder-not-false')
  if (recipe.generation_max_new_tokens !== H11_GENERATION_MAX_NEW_TOKENS)
    errors.push('recipe-generation-max-new-tokens-mismatch')
  if (recipe.retain_native_masks_max_count !== H11_NATIVE_MASK_MAX_COUNT)
    errors.push('recipe-native-mask-count-cap-mismatch')
  if (recipe.retain_native_masks_max_bytes_per_row !== H11_NATIVE_MASK_MAX_BYTES_PER_ROW)
    errors.push('recipe-native-mask-bytes-cap-mismatch')
  return errors
}

export function verifyH11OverlayWheelsMetadata(
  wheels: z.infer<typeof overlayWheelSchema>[],
): string[] {
  const errors: string[] = []
  if (wheels.length !== EXPECTED_H11_OVERLAY_WHEELS.length)
    errors.push('overlay-wheels-count-mismatch')
  for (let index = 0; index < EXPECTED_H11_OVERLAY_WHEELS.length; index++) {
    const expected = EXPECTED_H11_OVERLAY_WHEELS[index]
    const actual = wheels[index]
    if (!expected || !actual) continue
    if (
      actual.name !== expected.name ||
      actual.version !== expected.version ||
      actual.filename !== expected.filename ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    )
      errors.push(`overlay-wheel-metadata-mismatch-${expected.name}`)
  }
  return errors
}

export function verifyH11InputImageReceipts(
  receipts: z.infer<typeof inputImageReceiptSchema>[],
  freezeRows: z.infer<typeof manifestRowSchema>[],
  expectedRows: ExpectedH10PilotRow[],
  maxEncodedBytes: number,
): string[] {
  const errors: string[] = []
  if (receipts.length !== 12) errors.push('input-image-receipt-count-not-12')
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index]
    const freezeRow = freezeRows[index]
    const expected = expectedRows[index]
    if (!receipt || !freezeRow || !expected) continue
    if (receipt.row_index !== index) errors.push(`input-image-receipt-order-index-${index}`)
    if (freezeRow.row_index !== index) errors.push(`freeze-row-order-index-${index}`)
    if (receipt.row_index !== freezeRow.row_index)
      errors.push(`input-image-receipt-row-index-${receipt.row_key}`)
    if (receipt.row_key !== freezeRow.row_key)
      errors.push(`input-image-receipt-row-key-${receipt.row_index}`)
    if (receipt.row_key !== expected.row_key)
      errors.push(`input-image-receipt-expected-row-key-${receipt.row_index}`)
    if (receipt.manifest_source_sha256 !== freezeRow.source_sha256)
      errors.push(`input-image-receipt-manifest-sha-${receipt.row_key}`)
    if (receipt.manifest_source_sha256 !== expected.expectedSourceSha256)
      errors.push(`input-image-receipt-pilot-sha-${receipt.row_key}`)
    if (receipt.actual_source_sha256 !== receipt.manifest_source_sha256)
      errors.push(`input-image-receipt-actual-manifest-mismatch-${receipt.row_key}`)
    if (receipt.encoded_bytes > maxEncodedBytes)
      errors.push(`input-image-receipt-encoded-bytes-cap-${receipt.row_key}`)
    if (receipt.source_width !== expected.sourceWidth)
      errors.push(`input-image-receipt-source-width-${receipt.row_key}`)
    if (receipt.source_height !== expected.sourceHeight)
      errors.push(`input-image-receipt-source-height-${receipt.row_key}`)
  }
  return errors
}

export function verifyH11RowInputReceiptIdentity(input: {
  rows: z.infer<typeof h11RowSchema>[]
  freezeRecord: z.infer<typeof h11FreezeSchema>
  expectedRows: ExpectedH10PilotRow[]
}): string[] {
  const errors: string[] = []
  const { rows, freezeRecord, expectedRows } = input
  const receiptByIndex = new Map<number, z.infer<typeof inputImageReceiptSchema>>()
  for (const receipt of freezeRecord.input_image_receipts) {
    if (receiptByIndex.has(receipt.row_index)) {
      errors.push(`input-image-receipt-duplicate-row-index-${receipt.row_index}`)
      continue
    }
    receiptByIndex.set(receipt.row_index, receipt)
  }
  for (let index = 0; index < 12; index++) {
    if (!receiptByIndex.has(index)) errors.push(`input-image-receipt-missing-row-index-${index}`)
  }

  for (const row of rows) {
    const prefix = row.row_key
    const receipt = receiptByIndex.get(row.row_index)
    if (!receipt) {
      errors.push(`${prefix}:row-input-receipt-missing`)
      continue
    }
    const freezeRow = freezeRecord.rows.find((item) => item.row_index === row.row_index)
    const expected = expectedRows.find((item) => item.row_index === row.row_index)
    if (!freezeRow) {
      errors.push(`${prefix}:freeze-manifest-row-missing`)
      continue
    }
    if (!expected) {
      errors.push(`${prefix}:expected-pilot-row-missing`)
      continue
    }
    if (receipt.row_index !== row.row_index)
      errors.push(`${prefix}:input-receipt-row-index-mismatch`)
    if (receipt.row_key !== row.row_key) errors.push(`${prefix}:input-receipt-row-key-mismatch`)
    if (receipt.row_key !== freezeRow.row_key)
      errors.push(`${prefix}:input-receipt-freeze-row-key-mismatch`)
    if (receipt.row_key !== expected.row_key)
      errors.push(`${prefix}:input-receipt-expected-row-key-mismatch`)
    if (row.row_key !== freezeRow.row_key) errors.push(`${prefix}:row-freeze-row-key-mismatch`)
    if (row.row_key !== expected.row_key) errors.push(`${prefix}:row-expected-row-key-mismatch`)
    if (row.authored_target !== expected.authored_target)
      errors.push(`${prefix}:row-authored-target-expected-mismatch`)
    if (row.authored_target !== freezeRow.authored_target)
      errors.push(`${prefix}:row-authored-target-freeze-mismatch`)
    if (row.source_sha256 !== expected.expectedSourceSha256)
      errors.push(`${prefix}:row-source-sha256-expected-mismatch`)
    if (row.source_sha256 !== freezeRow.source_sha256)
      errors.push(`${prefix}:row-source-sha256-freeze-mismatch`)
    if (row.source_sha256 !== receipt.manifest_source_sha256)
      errors.push(`${prefix}:row-source-sha256-receipt-manifest-mismatch`)
    if (row.source_sha256 !== receipt.actual_source_sha256)
      errors.push(`${prefix}:row-source-sha256-receipt-actual-mismatch`)

    const requiresInferenceFacts =
      row.outcome_kind === 'candidate' || row.outcome_kind === 'unresolved_no_mask'
    if (requiresInferenceFacts) {
      if (row.source_width === null) errors.push(`${prefix}:row-source-width-null`)
      if (row.source_height === null) errors.push(`${prefix}:row-source-height-null`)
      if (row.oriented_rgb_sha256 === null) errors.push(`${prefix}:row-oriented-rgb-sha256-null`)
      if (row.composed_prompt_sha256 === null)
        errors.push(`${prefix}:row-composed-prompt-sha256-null`)
    }

    if (row.source_width !== null) {
      if (row.source_width !== receipt.source_width)
        errors.push(`${prefix}:row-source-width-receipt-mismatch`)
      if (row.source_width !== expected.sourceWidth)
        errors.push(`${prefix}:row-source-width-expected-mismatch`)
    }
    if (row.source_height !== null) {
      if (row.source_height !== receipt.source_height)
        errors.push(`${prefix}:row-source-height-receipt-mismatch`)
      if (row.source_height !== expected.sourceHeight)
        errors.push(`${prefix}:row-source-height-expected-mismatch`)
    }
    if (row.oriented_rgb_sha256 !== null) {
      if (row.oriented_rgb_sha256 !== receipt.oriented_rgb_sha256)
        errors.push(`${prefix}:row-oriented-rgb-sha256-receipt-mismatch`)
    }
    if (row.composed_prompt_sha256 !== null) {
      const expectedPromptSha = recomputeH11ComposedPromptSha256(
        freezeRecord.recipe.prompt_template,
        row.authored_target,
      )
      if (row.composed_prompt_sha256 !== expectedPromptSha)
        errors.push(`${prefix}:row-composed-prompt-sha256-mismatch`)
    }
  }

  return errors
}

export async function verifyH11InputImageReceiptSourcePaths(
  receipts: z.infer<typeof inputImageReceiptSchema>[],
  freezeRows: z.infer<typeof manifestRowSchema>[],
  integrityErrors: string[],
): Promise<void> {
  for (const receipt of receipts) {
    const freezeRow = freezeRows.find((row) => row.row_index === receipt.row_index)
    if (!freezeRow) continue
    try {
      const resolved = await resolveReadablePath(freezeRow.source_path)
      if (receipt.source_path !== resolved)
        integrityErrors.push(`input-image-receipt-source-path-${receipt.row_key}`)
    } catch {
      integrityErrors.push(`input-image-receipt-source-path-unverifiable-${receipt.row_key}`)
    }
  }
}

export function deriveH11RunStatus(
  rows: z.infer<typeof h11RowSchema>[],
  cleanupFailed: boolean,
  cancelled: boolean,
): z.infer<typeof h11RunStatusSchema> {
  if (cleanupFailed) return 'worker_cleanup_failed'
  if (cancelled) return 'cancelled'
  if (rows.some((row) => row.outcome_kind === 'integrity_failure'))
    return 'completed_with_integrity_errors'
  if (rows.some((row) => row.outcome_kind === 'technical_error'))
    return 'completed_with_technical_errors'
  return 'completed'
}

export function verifyH11RunStatusConsistency(
  runRecord: z.infer<typeof h11RunSchema>,
  rows: z.infer<typeof h11RowSchema>[],
): string[] {
  const errors: string[] = []
  const derived = deriveH11RunStatus(rows, runRecord.cleanup_failed, runRecord.cancelled)
  if (runRecord.status !== derived)
    errors.push(`run-status-derived-mismatch:${runRecord.status}:${derived}`)
  return errors
}

export function verifyH11RunRuntimeReceiptConsistency(
  runRecord: z.infer<typeof h11RunSchema>,
  freezeRecord: z.infer<typeof h11FreezeSchema>,
): string[] {
  const errors: string[] = []
  if (JSON.stringify(runRecord.runtime) !== JSON.stringify(freezeRecord.runtime))
    errors.push('run-runtime-freeze-mismatch')
  if (JSON.stringify(runRecord.cuda_runtime) !== JSON.stringify(runRecord.runtime.cuda_device))
    errors.push('run-cuda-runtime-not-runtime-cuda-device')
  errors.push(...verifyCudaDevRunReceiptConsistency(freezeRecord.runtime, runRecord.cuda_runtime))
  return errors
}

export function verifyH11RunRecordProducerBindings(
  runRecord: z.infer<typeof h11RunSchema>,
  freezeRecord: z.infer<typeof h11FreezeSchema>,
): string[] {
  const errors: string[] = []
  if (runRecord.manifest_sha256 !== freezeRecord.manifest_sha256)
    errors.push('run-manifest-sha256-mismatch')
  if (runRecord.contract_sha256 !== freezeRecord.contract_sha256)
    errors.push('run-contract-sha256-mismatch')
  if (
    runRecord.script_receipts.h11_worker_script_sha256 !==
    freezeRecord.script_receipts.h11_worker_script_sha256
  )
    errors.push('run-worker-script-sha256-mismatch')
  if (JSON.stringify(runRecord.script_receipts) !== JSON.stringify(freezeRecord.script_receipts))
    errors.push('run-script-receipts-mismatch')
  return errors
}

export async function verifyH11ScriptReceipts(
  receipts: z.infer<typeof h11ScriptReceiptsSchema>,
): Promise<string[]> {
  const errors: string[] = []
  const pairs: Array<[string, string, string]> = [
    ['h11_common_script_path', 'h11_common_script_sha256', 'h11-common'],
    ['h11_runner_script_path', 'h11_runner_script_sha256', 'h11-runner'],
    ['h11_worker_script_path', 'h11_worker_script_sha256', 'h11-worker'],
    ['h10_common_script_path', 'h10_common_script_sha256', 'h10-common'],
    ['h10_runner_script_path', 'h10_runner_script_sha256', 'h10-runner'],
    ['contract_path', 'contract_sha256', 'contract'],
  ]
  for (const [pathKey, shaKey, label] of pairs) {
    const scriptPath = receipts[pathKey as keyof typeof receipts]
    const expectedSha = receipts[shaKey as keyof typeof receipts]
    if (typeof scriptPath !== 'string' || typeof expectedSha !== 'string') continue
    errors.push(...(await verifyScriptPathHash(scriptPath, expectedSha, label)))
  }
  return errors
}

function firstNonemptyCandidate(
  candidates: z.infer<typeof candidateMaskSchema>[],
): z.infer<typeof candidateMaskSchema> | null {
  for (const candidate of candidates) {
    if (candidate.foreground_bounds !== null) return candidate
  }
  return null
}

export function verifyFirstNonemptyMaskSelection(row: z.infer<typeof h11RowSchema>): string[] {
  const errors: string[] = []
  const prefix = row.row_key
  const candidates = row.candidate_masks
  if (candidates.length > H11_NATIVE_MASK_MAX_COUNT)
    errors.push(`${prefix}:retained-candidate-count-exceeds-cap`)
  if (row.native_mask_count !== null && row.native_mask_count > H11_NATIVE_MASK_MAX_COUNT)
    errors.push(`${prefix}:native-mask-count-exceeds-cap`)
  for (let index = 0; index < candidates.length; index++) {
    if (candidates[index]?.emission_index !== index)
      errors.push(`${prefix}:candidate-emission-order-mismatch`)
  }
  const retainedBytes = candidates.reduce((sum, item) => sum + item.byte_count, 0)
  if (retainedBytes > H11_NATIVE_MASK_MAX_BYTES_PER_ROW)
    errors.push(`${prefix}:retained-mask-payload-exceeds-cap`)
  const selected = firstNonemptyCandidate(candidates)
  if (row.outcome_kind === 'candidate') {
    if (row.selected_mask_index === null)
      errors.push(`${prefix}:candidate-missing-selected-mask-index`)
    else if (selected === null) errors.push(`${prefix}:candidate-no-nonempty-mask`)
    else if (row.selected_mask_index !== selected.emission_index)
      errors.push(`${prefix}:selected-mask-index-not-first-nonempty-emission`)
    const expectedAlias = `masks/${row.row_key}/mask.u8`
    if (row.mask_path !== expectedAlias)
      errors.push(`${prefix}:candidate-mask-path-not-canonical-alias`)
    if (selected !== null && row.mask_sha256 !== selected.sha256)
      errors.push(`${prefix}:selected-mask-sha256-not-first-nonempty`)
    if (
      selected !== null &&
      row.foreground_bounds !== null &&
      selected.foreground_bounds !== null
    ) {
      if (!boundsEqual(row.foreground_bounds, selected.foreground_bounds))
        errors.push(`${prefix}:selected-foreground-bounds-not-first-nonempty`)
    }
  }
  if (row.outcome_kind === 'unresolved_no_mask') {
    if (row.selected_mask_index !== null)
      errors.push(`${prefix}:unresolved-has-selected-mask-index`)
    if (row.mask_path !== null) errors.push(`${prefix}:unresolved-has-mask-path`)
    if (selected !== null) errors.push(`${prefix}:unresolved-has-nonempty-candidate`)
  }
  return errors
}

export function validateH11ProducerOutcomeRowFields(
  row: z.infer<typeof h11RowSchema>,
  contract: Record<string, unknown> | null,
): string[] {
  const errors: string[] = []
  const prefix = row.row_key
  const maskFree = ['unresolved_no_mask', 'technical_error', 'integrity_failure'] as const
  if (maskFree.includes(row.outcome_kind as (typeof maskFree)[number])) {
    if (row.mask_path) errors.push(`${prefix}:${row.outcome_kind}-has-mask-path`)
    if (row.mask_sha256) errors.push(`${prefix}:${row.outcome_kind}-has-mask-sha256`)
    if (row.foreground_bounds) errors.push(`${prefix}:${row.outcome_kind}-has-foreground-bounds`)
  }
  if (row.outcome_kind === 'candidate') {
    if (!row.mask_path) errors.push(`${prefix}:candidate-missing-mask-path`)
    if (!row.mask_sha256) errors.push(`${prefix}:candidate-missing-mask-sha256`)
    if (!row.foreground_bounds) errors.push(`${prefix}:candidate-missing-foreground-bounds`)
  }
  if (row.outcome_kind === 'technical_error') errors.push(`${prefix}:technical-error-outcome`)
  if (row.outcome_kind === 'integrity_failure') errors.push(`${prefix}:integrity-failure-outcome`)
  const requiresGenerationFacts =
    row.outcome_kind === 'candidate' || row.outcome_kind === 'unresolved_no_mask'
  if (requiresGenerationFacts) {
    if (row.generation_token_count === null) errors.push(`${prefix}:generation-token-count-null`)
    if (row.generation_truncated === null) errors.push(`${prefix}:generation-truncated-null`)
    if (row.generation_diagnostics === null) errors.push(`${prefix}:generation-diagnostics-null`)
  }
  if (row.generation_diagnostics !== null) {
    const diagnostics = row.generation_diagnostics
    if (
      row.generation_token_count !== null &&
      diagnostics.generated_token_count !== row.generation_token_count
    )
      errors.push(`${prefix}:generation-diagnostics-token-count-mismatch`)
    if (diagnostics.actual_max_new_tokens_applied !== H11_GENERATION_MAX_NEW_TOKENS)
      errors.push(`${prefix}:generation-diagnostics-max-new-tokens-mismatch`)
    if (diagnostics.do_sample_applied !== false)
      errors.push(`${prefix}:generation-diagnostics-do-sample-mismatch`)
    const capTruncated =
      diagnostics.generated_token_count >= H11_GENERATION_MAX_NEW_TOKENS &&
      !diagnostics.stopped_on_eos
    if (row.generation_truncated !== null && row.generation_truncated !== capTruncated)
      errors.push(`${prefix}:generation-diagnostics-truncation-mismatch`)
    if (capTruncated) errors.push(`${prefix}:generation-truncated`)
  } else if (row.generation_truncated === true) {
    errors.push(`${prefix}:generation-truncated`)
  }
  if (
    (row.outcome_kind === 'technical_error' || row.outcome_kind === 'integrity_failure') &&
    (row.source_width !== null || row.source_height !== null)
  ) {
    if (row.source_width === null || row.source_height === null)
      errors.push(`${prefix}:technical-partial-source-dimensions`)
  }
  if (
    row.outcome_kind !== 'technical_error' &&
    row.outcome_kind !== 'integrity_failure' &&
    (row.source_width === null || row.source_height === null)
  )
    errors.push(`${prefix}:source-dimensions-null`)
  errors.push(...verifyFirstNonemptyMaskSelection(row))
  if (contract) {
    const rowOutput = contract.row_output as { required_fields?: string[] } | undefined
    for (const field of rowOutput?.required_fields ?? []) {
      if (!(field in row)) errors.push(`${prefix}:contract-required-field-missing-${field}`)
    }
  }
  return errors
}

async function listMaskBinaryRealPaths(
  masksDir: string,
  integrityErrors: string[],
): Promise<Set<string>> {
  const actualRealPaths = new Set<string>()
  async function walk(currentDir: string, relativePrefix: string, depth: number): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relativeName = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name
      const absolutePath = resolve(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= 1) integrityErrors.push(`masks-nested-directory-${relativeName}`)
        await walk(absolutePath, relativeName, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        actualRealPaths.add(await realpath(absolutePath))
      } catch {
        integrityErrors.push(`mask-file-unresolvable-${relativeName}`)
      }
    }
  }
  await walk(masksDir, '', 0)
  return actualRealPaths
}

async function resolveInventoryMaskPath(runRoot: string, maskPath: string): Promise<string> {
  const candidate = isAbsolute(maskPath) ? maskPath : resolve(runRoot, maskPath)
  const realRoot = await realpath(runRoot)
  const normalized = resolve(candidate)
  const part = relative(realRoot, normalized)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('mask-path-outside-run')
  try {
    return await realpath(normalized)
  } catch {
    return normalized
  }
}

export async function verifyH11EmittedMaskInventory(
  runRoot: string,
  rows: z.infer<typeof h11RowSchema>[],
  integrityErrors: string[],
): Promise<void> {
  const masksDir = resolve(runRoot, 'masks')
  const expectedRealPaths = new Set<string>()
  for (const row of rows) {
    for (const candidate of row.candidate_masks) {
      try {
        expectedRealPaths.add(await resolveInventoryMaskPath(runRoot, candidate.path))
      } catch {
        integrityErrors.push(`${row.row_key}:candidate-mask-path-outside-run:${candidate.path}`)
      }
    }
    if (row.outcome_kind === 'candidate') {
      if (!row.mask_path) {
        integrityErrors.push(`${row.row_key}:candidate-missing-mask-path-inventory`)
        continue
      }
      try {
        expectedRealPaths.add(await resolveInventoryMaskPath(runRoot, row.mask_path))
      } catch {
        integrityErrors.push(`${row.row_key}:selected-mask-path-outside-run`)
      }
    }
  }
  const actualRealPaths = await listMaskBinaryRealPaths(masksDir, integrityErrors)
  for (const path of actualRealPaths) {
    if (!expectedRealPaths.has(path)) integrityErrors.push(`stray-mask-file-${path}`)
  }
  for (const path of expectedRealPaths) {
    if (!actualRealPaths.has(path)) integrityErrors.push(`missing-emitted-mask-${path}`)
  }
}

async function readAndValidateMaskU8(input: {
  runRoot: string
  relativePath: string
  expectedSha256: string
  expectedByteCount: number
  expectedWidth: number
  expectedHeight: number
  expectedForegroundBounds: z.infer<typeof boundsSchema> | null
}): Promise<{ ok: true; audit: H11MaskAudit } | { ok: false; reason: string }> {
  let maskPath: string
  try {
    maskPath = await resolveMaskPathWithinRunRoot(input.runRoot, input.relativePath)
  } catch {
    return { ok: false, reason: 'mask-path-outside-run' }
  }
  let bytes: Buffer
  try {
    bytes = await readFile(maskPath)
  } catch {
    return { ok: false, reason: 'mask-file-unreadable' }
  }
  if (sha256(bytes) !== input.expectedSha256) return { ok: false, reason: 'mask-sha256-mismatch' }
  if (bytes.length !== input.expectedByteCount)
    return { ok: false, reason: 'mask-byte-length-mismatch' }
  if (bytes.length !== input.expectedWidth * input.expectedHeight)
    return { ok: false, reason: 'mask-dimensions-byte-count-mismatch' }
  const bits = new Uint8Array(bytes.length)
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index]
    if (value !== 0 && value !== 1) return { ok: false, reason: 'mask-not-binary-u8' }
    bits[index] = value
  }
  const recomputedBounds = maskForegroundBounds(bits, input.expectedWidth, input.expectedHeight)
  if (input.expectedForegroundBounds === null) {
    if (recomputedBounds !== null) return { ok: false, reason: 'empty-mask-has-foreground' }
    return {
      ok: true,
      audit: {
        status: 'valid',
        reason: null,
        maskDerivedBox: null,
        recomputedBounds: null,
      },
    }
  }
  if (!recomputedBounds) return { ok: false, reason: 'candidate-mask-empty' }
  if (!boundsEqual(recomputedBounds, input.expectedForegroundBounds))
    return { ok: false, reason: 'foreground-bounds-mismatch' }
  return {
    ok: true,
    audit: {
      status: 'valid',
      reason: null,
      maskDerivedBox: foregroundBoundsToBox(recomputedBounds),
      recomputedBounds,
    },
  }
}

async function verifyH11RowMaskArtifacts(input: {
  runRoot: string
  row: z.infer<typeof h11RowSchema>
  expectedWidth: number | null
  expectedHeight: number | null
}): Promise<{ errors: string[]; selectedAudit: H11MaskAudit }> {
  const prefix = input.row.row_key
  const errors: string[] = []
  const notApplicable: H11MaskAudit = {
    status: 'not_applicable',
    reason: null,
    maskDerivedBox: null,
    recomputedBounds: null,
  }
  if (input.row.outcome_kind !== 'candidate' && input.row.outcome_kind !== 'unresolved_no_mask') {
    return { errors, selectedAudit: notApplicable }
  }
  const sourceWidth = input.row.source_width ?? input.expectedWidth
  const sourceHeight = input.row.source_height ?? input.expectedHeight
  if (sourceWidth === null || sourceHeight === null) {
    errors.push(`${prefix}:mask-artifacts-missing-source-dimensions`)
    return { errors, selectedAudit: notApplicable }
  }
  for (const candidate of input.row.candidate_masks) {
    if (candidate.width !== sourceWidth || candidate.height !== sourceHeight) {
      errors.push(`${prefix}:candidate-${candidate.emission_index}-dimension-metadata-mismatch`)
      continue
    }
    const expectedBytes = sourceWidth * sourceHeight
    if (candidate.byte_count !== expectedBytes) {
      errors.push(`${prefix}:candidate-${candidate.emission_index}-byte-count-metadata-mismatch`)
    }
    const validated = await readAndValidateMaskU8({
      runRoot: input.runRoot,
      relativePath: candidate.path,
      expectedSha256: candidate.sha256,
      expectedByteCount: candidate.byte_count,
      expectedWidth: sourceWidth,
      expectedHeight: sourceHeight,
      expectedForegroundBounds: candidate.foreground_bounds,
    })
    if (!validated.ok)
      errors.push(`${prefix}:candidate-${candidate.emission_index}-${validated.reason}`)
  }
  if (input.row.outcome_kind !== 'candidate') {
    return { errors, selectedAudit: notApplicable }
  }
  if (!input.row.mask_path || !input.row.mask_sha256 || !input.row.foreground_bounds) {
    errors.push(`${prefix}:candidate-missing-selected-mask-fields`)
    return {
      errors,
      selectedAudit: {
        status: 'invalid',
        reason: 'candidate-missing-selected-mask-fields',
        maskDerivedBox: null,
        recomputedBounds: null,
      },
    }
  }
  const firstNonempty = firstNonemptyCandidate(input.row.candidate_masks)
  if (firstNonempty !== null) {
    if (input.row.mask_sha256 !== firstNonempty.sha256)
      errors.push(`${prefix}:selected-alias-sha256-not-first-nonempty`)
    if (
      input.row.foreground_bounds !== null &&
      firstNonempty.foreground_bounds !== null &&
      !boundsEqual(input.row.foreground_bounds, firstNonempty.foreground_bounds)
    )
      errors.push(`${prefix}:selected-alias-bounds-not-first-nonempty`)
  }
  const selectedValidated = await readAndValidateMaskU8({
    runRoot: input.runRoot,
    relativePath: input.row.mask_path,
    expectedSha256: input.row.mask_sha256,
    expectedByteCount: sourceWidth * sourceHeight,
    expectedWidth: sourceWidth,
    expectedHeight: sourceHeight,
    expectedForegroundBounds: input.row.foreground_bounds,
  })
  if (!selectedValidated.ok) {
    errors.push(`${prefix}:selected-${selectedValidated.reason}`)
    return {
      errors,
      selectedAudit: {
        status: 'invalid',
        reason: selectedValidated.reason,
        maskDerivedBox: null,
        recomputedBounds: null,
      },
    }
  }
  if (firstNonempty !== null) {
    try {
      const aliasPath = await resolveMaskPathWithinRunRoot(input.runRoot, input.row.mask_path)
      const candidatePath = await resolveMaskPathWithinRunRoot(input.runRoot, firstNonempty.path)
      const aliasBytes = await readFile(aliasPath)
      const candidateBytes = await readFile(candidatePath)
      if (!aliasBytes.equals(candidateBytes))
        errors.push(`${prefix}:selected-alias-bytes-not-first-nonempty`)
    } catch {
      errors.push(`${prefix}:selected-alias-byte-compare-unreadable`)
    }
  }
  return { errors, selectedAudit: selectedValidated.audit }
}

export async function auditH11CandidateMask(input: {
  runRoot: string
  row: z.infer<typeof h11RowSchema>
  expectedWidth: number
  expectedHeight: number
}): Promise<H11MaskAudit> {
  const { selectedAudit } = await verifyH11RowMaskArtifacts({
    runRoot: input.runRoot,
    row: input.row,
    expectedWidth: input.expectedWidth,
    expectedHeight: input.expectedHeight,
  })
  return selectedAudit
}

function scoreRow(
  expected: ExpectedH10PilotRow,
  row: z.infer<typeof h11RowSchema> | undefined,
  maskAudit: H11MaskAudit,
): H11EvaluatedRow {
  const joinErrors: string[] = []
  const rowErrors: string[] = []
  if (!row) {
    joinErrors.push('missing-row')
    return {
      row_index: expected.row_index,
      row_key: expected.row_key,
      caseId: expected.caseId,
      stratum: expected.stratum,
      presence: expected.presence,
      outcome_kind: 'missing',
      positiveSuccess: false,
      negativeFalseOutput: false,
      wholeObjectMatched: false,
      bestIoU: 0,
      bestCoverage: 0,
      maskAudit,
      nativeMaskCount: null,
      selectedMaskIndex: null,
      joinErrors,
      rowErrors,
    }
  }
  if (row.row_index !== expected.row_index) joinErrors.push('row-index-mismatch')
  if (row.row_key !== expected.row_key) joinErrors.push('row-key-mismatch')
  if (row.authored_target !== expected.authored_target) joinErrors.push('authored-target-mismatch')
  if (!row.source_sha256) joinErrors.push('source-sha256-missing')
  else if (row.source_sha256 !== expected.expectedSourceSha256)
    joinErrors.push('source-sha256-mismatch')
  if (row.source_width !== null && row.source_height !== null) {
    if (row.source_width !== expected.sourceWidth || row.source_height !== expected.sourceHeight)
      joinErrors.push('source-dimensions-mismatch')
  } else if (row.outcome_kind !== 'technical_error' && row.outcome_kind !== 'integrity_failure') {
    joinErrors.push('source-dimensions-null')
  }

  let wholeObjectMatched = false
  let bestIoU = 0
  let bestCoverage = 0
  if (
    expected.presence === 'present' &&
    row.outcome_kind === 'candidate' &&
    maskAudit.status === 'valid' &&
    maskAudit.maskDerivedBox &&
    expected.referenceBoxes.length > 0
  ) {
    const scored = wholeObjectMatch(maskAudit.maskDerivedBox, expected.referenceBoxes)
    wholeObjectMatched = scored.matched
    for (const instance of scored.instances) {
      if (instance.iou > bestIoU) bestIoU = instance.iou
      if (instance.coverage > bestCoverage) bestCoverage = instance.coverage
    }
  }

  const positiveSuccess =
    expected.presence === 'present' &&
    row.outcome_kind === 'candidate' &&
    maskAudit.status === 'valid' &&
    wholeObjectMatched

  const negativeFalseOutput =
    expected.presence === 'absent' &&
    row.outcome_kind === 'candidate' &&
    maskAudit.status === 'valid'

  if (
    expected.presence === 'present' &&
    row.outcome_kind === 'candidate' &&
    maskAudit.status === 'invalid'
  )
    rowErrors.push('positive-candidate-mask-invalid')

  if (
    expected.presence === 'absent' &&
    row.outcome_kind === 'candidate' &&
    maskAudit.status === 'invalid'
  )
    rowErrors.push('negative-candidate-mask-invalid')

  if (
    expected.presence === 'present' &&
    (row.outcome_kind === 'technical_error' || row.outcome_kind === 'integrity_failure')
  )
    rowErrors.push('positive-technical-or-integrity-outcome')

  if (
    expected.presence === 'absent' &&
    (row.outcome_kind === 'technical_error' || row.outcome_kind === 'integrity_failure')
  )
    rowErrors.push('negative-technical-or-integrity-outcome')

  return {
    row_index: expected.row_index,
    row_key: expected.row_key,
    caseId: expected.caseId,
    stratum: expected.stratum,
    presence: expected.presence,
    outcome_kind: row.outcome_kind,
    positiveSuccess,
    negativeFalseOutput,
    wholeObjectMatched,
    bestIoU,
    bestCoverage,
    maskAudit,
    nativeMaskCount: row.native_mask_count ?? null,
    selectedMaskIndex: row.selected_mask_index ?? null,
    joinErrors,
    rowErrors,
  }
}

function verifyTerminalRowSet(
  rows: z.infer<typeof h11RowSchema>[],
  integrityErrors: string[],
): void {
  if (rows.length !== 12) integrityErrors.push('terminal-row-count-not-12')
  const indices = rows.map((row) => row.row_index)
  const keys = rows.map((row) => row.row_key)
  if (new Set(indices).size !== rows.length) integrityErrors.push('duplicate-row-index')
  if (new Set(keys).size !== rows.length) integrityErrors.push('duplicate-row-key')
}

async function verifyDevRunReceipts(input: {
  runRoot: string
  expectedRows: ExpectedH10PilotRow[]
  freezeRecord: z.infer<typeof h11FreezeSchema>
  runRecord: z.infer<typeof h11RunSchema>
  integrityErrors: string[]
}): Promise<Record<string, unknown> | null> {
  const { integrityErrors, freezeRecord, runRecord, expectedRows, runRoot } = input
  const lockedManifest = await verifyMinimalDevManifestFile(integrityErrors)
  if (lockedManifest)
    integrityErrors.push(
      ...compareLockedManifestToFreezeRows(lockedManifest.rows, freezeRecord.rows),
    )
  if (freezeRecord.manifest_sha256 !== MINIMAL_DEV_MANIFEST_SHA256)
    integrityErrors.push('freeze-manifest-sha256-not-minimal-dev-lock')
  if (runRecord.manifest_sha256 !== MINIMAL_DEV_MANIFEST_SHA256)
    integrityErrors.push('run-manifest-sha256-not-minimal-dev-lock')
  if (!isApprovedH11ContractSha256(freezeRecord.contract_sha256))
    integrityErrors.push('freeze-contract-sha256-not-approved-h11-lock')
  if (!isApprovedH11ContractSha256(runRecord.contract_sha256))
    integrityErrors.push('run-contract-sha256-not-approved-h11-lock')
  try {
    const manifestBytes = await readFile(freezeRecord.manifest_path)
    if (sha256(manifestBytes) !== MINIMAL_DEV_MANIFEST_SHA256)
      integrityErrors.push('freeze-manifest-bytes-not-minimal-dev-lock')
    if (sha256(manifestBytes) !== freezeRecord.manifest_sha256)
      integrityErrors.push('freeze-manifest-bytes-hash-mismatch')
  } catch {
    integrityErrors.push('freeze-manifest-path-unreadable')
  }
  integrityErrors.push(...verifyH11AssetReceiptMetadata(freezeRecord.asset_receipts))
  await verifyH11AssetDirectoryOnDisk(freezeRecord.asset_dir, integrityErrors)
  const contract = await verifyH11ContractFile(
    freezeRecord.contract_path,
    freezeRecord.contract_sha256,
    integrityErrors,
  )
  integrityErrors.push(...verifyProcessorAttestation(freezeRecord.processor_attestation))
  integrityErrors.push(...verifyH11Recipe(freezeRecord.recipe))
  integrityErrors.push(
    ...verifyH11RecipeProfileBinding(freezeRecord.recipe, freezeRecord.contract_sha256),
  )
  if (contract) {
    const prompt = contract.prompt as { template?: string } | undefined
    if (prompt?.template && freezeRecord.recipe.prompt_template !== prompt.template)
      integrityErrors.push('freeze-recipe-prompt-template-mismatch')
    if (prompt?.template) {
      const promptSha = sha256(Buffer.from(prompt.template, 'utf8'))
      if (freezeRecord.recipe.prompt_template_sha256 !== promptSha)
        integrityErrors.push('freeze-recipe-prompt-template-sha256-mismatch')
    }
  }
  integrityErrors.push(...(await verifyH11ScriptReceipts(freezeRecord.script_receipts)))
  integrityErrors.push(...verifyH11OverlayWheelsMetadata(freezeRecord.overlay_wheels))
  integrityErrors.push(
    ...verifyH11InputImageReceipts(
      freezeRecord.input_image_receipts,
      freezeRecord.rows,
      expectedRows,
      freezeRecord.recipe.max_encoded_bytes,
    ),
  )
  await verifyH11InputImageReceiptSourcePaths(
    freezeRecord.input_image_receipts,
    freezeRecord.rows,
    integrityErrors,
  )
  if (lockedManifest)
    await verifyLockedSourcePathClosure(lockedManifest.rows, freezeRecord.rows, integrityErrors)
  integrityErrors.push(...expectedManifestRowsMatch(expectedRows, freezeRecord.rows))
  await verifyFrozenManifestSources(freezeRecord.rows, expectedRows, integrityErrors)
  await verifyRunDeviceAndFreezePath(
    runRoot,
    freezeRecord as unknown as Parameters<typeof verifyRunDeviceAndFreezePath>[1],
    runRecord as unknown as Parameters<typeof verifyRunDeviceAndFreezePath>[2],
    integrityErrors,
  )
  try {
    const freezeBytes = await readFile(resolve(runRoot, 'freeze.json'))
    if (sha256(freezeBytes) !== runRecord.freeze_sha256)
      integrityErrors.push('run-freeze-sha256-mismatch')
  } catch {
    integrityErrors.push('run-freeze-hash-unverifiable')
  }
  integrityErrors.push(...verifyH11RunRecordProducerBindings(runRecord, freezeRecord))
  integrityErrors.push(...(await verifyH11ScriptReceipts(runRecord.script_receipts)))
  integrityErrors.push(...verifyH11RunRuntimeReceiptConsistency(runRecord, freezeRecord))
  if (runRecord.row_count !== 12) integrityErrors.push('run-row-count-not-12')
  if (runRecord.status !== 'completed')
    integrityErrors.push(`run-status-not-completed:${runRecord.status}`)
  return contract
}

async function buildPilotEvaluation(
  expectedRows: ExpectedH10PilotRow[],
  rows: z.infer<typeof h11RowSchema>[],
  audits: Map<number, H11MaskAudit>,
  runRoot: string,
  imageRoot: string,
): Promise<Awaited<ReturnType<typeof evaluateV03Pilot>>> {
  const outputRoot = resolve(runRoot, 'masks')
  const pilotRows: unknown[] = []
  for (const expected of expectedRows) {
    const row = rows.find((item) => item.row_index === expected.row_index)
    const audit = audits.get(expected.row_index) ?? {
      status: 'not_applicable' as const,
      reason: null,
      maskDerivedBox: null,
      recomputedBounds: null,
    }
    if (
      row?.outcome_kind === 'candidate' &&
      audit.status === 'valid' &&
      row.mask_path &&
      row.mask_sha256 &&
      row.source_width !== null &&
      row.source_height !== null &&
      audit.maskDerivedBox
    ) {
      pilotRows.push({
        caseId: expected.caseId,
        imageSha256: expected.expectedSourceSha256,
        classify: {
          status: 'classified',
          choice: expected.presence === 'present' ? 'present' : 'absent',
        },
        extraction: {
          status: 'extracted',
          seed: { status: 'unknown' },
          mask: {
            file: 'mask.u8',
            sha256: row.mask_sha256,
            width: row.source_width,
            height: row.source_height,
            sourceRegion: audit.maskDerivedBox,
            sourceOffset: { x: 0, y: 0 },
          },
        },
      })
      continue
    }
    if (row?.outcome_kind === 'unresolved_no_mask') {
      pilotRows.push({
        caseId: expected.caseId,
        imageSha256: expected.expectedSourceSha256,
        classify: { status: 'ok' },
        extraction: { status: 'not-found', seed: { status: 'unknown' } },
      })
      continue
    }
    pilotRows.push({
      caseId: expected.caseId,
      imageSha256: expected.expectedSourceSha256,
      classify: { status: 'failed' },
      extraction: { status: 'failed', seed: { status: 'unknown' } },
    })
  }
  const corpus = await loadV03PilotCorpus(imageRoot, new AbortController().signal)
  const truth = await loadV03PilotTruth()
  return await evaluateV03Pilot({
    corpus: corpus.cases,
    rows: pilotRows,
    truth,
    imageRoot,
    outputRoot,
  })
}

export async function evaluateH11Sa2vaRun(input: {
  runRoot: string
  mode?: H11EvaluationMode
  imageRoot?: string
  truth?: readonly V03PilotTruth[]
  expectedRows?: ExpectedH10PilotRow[]
  rows?: z.infer<typeof h11RowSchema>[]
  freeze?: unknown
  run?: unknown
}): Promise<H11EvaluationReport> {
  const mode: H11EvaluationMode = input.mode ?? 'dev-run'
  const imageRoot = input.imageRoot ?? v03PilotRepositoryRoot
  const integrityErrors: string[] = []
  const runRoot = await realpath(input.runRoot)

  let truth: readonly V03PilotTruth[]
  let expectedRows: ExpectedH10PilotRow[]
  if (mode === 'dev-run') {
    for (const key of ['rows', 'truth', 'expectedRows', 'freeze', 'run'] as const) {
      if (input[key] !== undefined) integrityErrors.push(`dev-run-rejects-injected-${key}`)
    }
    truth = await loadV03PilotTruth()
    expectedRows = await buildExpectedH10PilotRows(truth)
  } else {
    truth = input.truth ?? (await loadV03PilotTruth())
    expectedRows = input.expectedRows ?? (await buildExpectedH10PilotRows(truth))
  }

  let freezeRecord: z.infer<typeof h11FreezeSchema> | null = null
  let runRecord: z.infer<typeof h11RunSchema> | null = null
  let contract: Record<string, unknown> | null = null

  if (mode === 'dev-run') {
    try {
      freezeRecord = h11FreezeSchema.parse(
        JSON.parse((await readFile(resolve(runRoot, 'freeze.json'))).toString('utf8')),
      )
    } catch {
      integrityErrors.push('freeze-unreadable-or-invalid')
    }
    try {
      runRecord = h11RunSchema.parse(
        JSON.parse((await readFile(resolve(runRoot, 'run.json'))).toString('utf8')),
      )
    } catch {
      integrityErrors.push('run-unreadable-or-invalid')
    }
    if (freezeRecord && runRecord) {
      contract = await verifyDevRunReceipts({
        runRoot,
        expectedRows,
        freezeRecord,
        runRecord,
        integrityErrors,
      })
    }
  }

  let rows: z.infer<typeof h11RowSchema>[]
  if (mode === 'synthetic-fixture') {
    if (!input.rows) integrityErrors.push('synthetic-fixture-requires-injected-rows')
    rows = (input.rows ?? []).map((row) => h11RowSchema.parse(row))
  } else {
    try {
      const jsonl = (await readFile(resolve(runRoot, 'rows.jsonl'))).toString('utf8').trim()
      const lines = jsonl ? jsonl.split('\n') : []
      if (lines.length !== 12) integrityErrors.push('rows-jsonl-count-not-12')
      rows = lines.map((line, index) => {
        try {
          return h11RowSchema.parse(JSON.parse(line))
        } catch {
          integrityErrors.push(`rows-jsonl-parse-failure-${index}`)
          return h11RowSchema.parse({
            row_index: index,
            row_key: `invalid-${index}`,
            authored_target: 'invalid',
            outcome_kind: 'technical_error',
            source_width: null,
            source_height: null,
            source_sha256: '0'.repeat(64),
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
            error_code: null,
            error_message: null,
            wall_ms: null,
            peak_vram_allocated_bytes: null,
            peak_vram_reserved_bytes: null,
            generation_diagnostics: null,
          })
        }
      })
    } catch {
      integrityErrors.push('rows-jsonl-unreadable')
      rows = []
    }
  }

  verifyTerminalRowSet(rows, integrityErrors)
  if (mode === 'dev-run' && runRecord)
    integrityErrors.push(...verifyH11RunStatusConsistency(runRecord, rows))
  if (mode === 'dev-run' && freezeRecord) {
    integrityErrors.push(
      ...verifyH11RowInputReceiptIdentity({
        rows,
        freezeRecord,
        expectedRows,
      }),
    )
  }
  await verifyH11EmittedMaskInventory(runRoot, rows, integrityErrors)

  const audits = new Map<number, H11MaskAudit>()
  const perRow: H11EvaluatedRow[] = []
  for (const expected of expectedRows) {
    const row = rows.find((item) => item.row_index === expected.row_index)
    let maskAudit: H11MaskAudit = {
      status: 'not_applicable',
      reason: null,
      maskDerivedBox: null,
      recomputedBounds: null,
    }
    if (row) {
      const artifactCheck = await verifyH11RowMaskArtifacts({
        runRoot,
        row,
        expectedWidth: expected.sourceWidth,
        expectedHeight: expected.sourceHeight,
      })
      integrityErrors.push(...artifactCheck.errors)
      maskAudit = artifactCheck.selectedAudit
    }
    audits.set(expected.row_index, maskAudit)
    const evaluated = scoreRow(expected, row, maskAudit)
    if (row)
      integrityErrors.push(
        ...validateH11ProducerOutcomeRowFields(row, mode === 'dev-run' ? contract : null),
      )
    if (evaluated.joinErrors.length > 0 || evaluated.rowErrors.length > 0) {
      integrityErrors.push(
        ...evaluated.joinErrors.map((item) => `${expected.row_key}:${item}`),
        ...evaluated.rowErrors.map((item) => `${expected.row_key}:${item}`),
      )
    }
    perRow.push(evaluated)
  }

  const positives = perRow.filter((row) => row.presence === 'present')
  const negatives = perRow.filter((row) => row.presence === 'absent')
  assert(positives.length === H11_POSITIVE_DENOMINATOR, 'positive denominator drift')
  assert(negatives.length === H11_NEGATIVE_DENOMINATOR, 'negative denominator drift')

  const positiveSuccesses = positives.filter((row) => row.positiveSuccess).length
  const falseOutputs = negatives.filter((row) => row.negativeFalseOutput).length
  const technicalOrIntegrityDefects = perRow.filter(
    (row) =>
      row.outcome_kind === 'technical_error' ||
      row.outcome_kind === 'integrity_failure' ||
      row.outcome_kind === 'missing',
  ).length

  const gateThresholdMet =
    positiveSuccesses >= H11_POSITIVE_SUCCESS_MINIMUM && falseOutputs <= H11_FALSE_OUTPUTS_MAXIMUM
  const cleanPass =
    gateThresholdMet && integrityErrors.length === 0 && technicalOrIntegrityDefects === 0

  const nativeCounts = perRow
    .map((row) => row.nativeMaskCount)
    .filter((count): count is number => count !== null)
  const rowsWithMultipleNativeMasks = nativeCounts.filter((count) => count > 1).length
  const maxNativeMaskCount = nativeCounts.length === 0 ? null : Math.max(...nativeCounts)

  let pilotEvaluation: Awaited<ReturnType<typeof evaluateV03Pilot>> | null = null
  const usesFrozenPilotIdentity = expectedRows.every((row) => row.caseId.startsWith('pilot-v03-'))
  if (usesFrozenPilotIdentity) {
    try {
      pilotEvaluation = await buildPilotEvaluation(expectedRows, rows, audits, runRoot, imageRoot)
    } catch (error) {
      integrityErrors.push(
        `pilot-evaluation-failed:${error instanceof Error ? error.message : 'unknown'}`,
      )
    }
  }

  const strata = ['photo', 'ui', 'map'] as const
  const stratumSummary = Object.fromEntries(
    strata.map((stratum) => {
      const group = perRow.filter((row) => row.stratum === stratum)
      const groupPositives = group.filter((row) => row.presence === 'present')
      const groupNegatives = group.filter((row) => row.presence === 'absent')
      return [
        stratum,
        {
          positives: groupPositives.length,
          positiveSuccesses: groupPositives.filter((row) => row.positiveSuccess).length,
          negatives: groupNegatives.length,
          falseOutputs: groupNegatives.filter((row) => row.negativeFalseOutput).length,
        },
      ]
    }),
  ) as H11EvaluationReport['stratumSummary']

  return {
    schema: 'v03-h11-sa2va-evaluation-v1',
    hypothesis: 'h11-sa2va-text-mask',
    integrityErrors,
    gate: {
      positiveDenominator: H11_POSITIVE_DENOMINATOR,
      positiveSuccessesMinimum: H11_POSITIVE_SUCCESS_MINIMUM,
      positiveSuccesses,
      negativeDenominator: H11_NEGATIVE_DENOMINATOR,
      falseOutputsMaximum: H11_FALSE_OUTPUTS_MAXIMUM,
      falseOutputs,
      technicalOrIntegrityDefects,
      cleanPass,
    },
    referenceBaselineH10: H11_REFERENCE_BASELINE_H10,
    diagnostics: {
      rowsWithMultipleNativeMasks,
      maxNativeMaskCount,
    },
    pilotEvaluation,
    stratumSummary,
    perRow,
  }
}

async function main() {
  const runRoot = resolve(process.argv[2] ?? '')
  if (!runRoot) throw new Error('usage: evaluate-h11-sa2va.ts <runRoot>')
  const report = await evaluateH11Sa2vaRun({ runRoot, mode: 'dev-run' })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.gate.cleanPass) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : 'H11 evaluation failed'}\n`,
    )
    process.exitCode = 1
  })
}

export {
  boundsSchema,
  candidateMaskSchema,
  foregroundBoundsToBox,
  freezeRuntimeSchema,
  generationDiagnosticsSchema,
  h11FreezeSchema,
  h11RecipeSchema,
  h11RowSchema,
  h11RunSchema,
  h11ScriptReceiptsSchema,
  inputImageReceiptSchema,
  manifestRowSchema,
  maskForegroundBounds,
  overlayWheelSchema,
  processorAttestationSchema,
  rowOutcomeSchema,
  verifyH11RowMaskArtifacts,
}
