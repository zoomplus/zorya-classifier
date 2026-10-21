import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { z } from 'zod'
import type { Box } from '../v02/metrics.js'
import { wholeObjectMatch } from '../v02/metrics.js'
import { loadV03PilotTruth, type V03PilotTruth } from './evaluate-pilot.js'
import { v03PilotManifests } from './pilot-manifest.js'

/** Frozen minimal DEV input manifest digest (sha256sum-verified lock). */
export const MINIMAL_DEV_MANIFEST_SHA256 =
  '98e8a5e767a6604a02fec0e561fa1b0128cb76783e4a405df4cb96e4b75fd084'

export const MINIMAL_DEV_MANIFEST_PATH =
  '/root/work/zorya-classifier/.run/v03/h10/minimal-inputs.json'

export const H10_POSITIVE_DENOMINATOR = 9
export const H10_NEGATIVE_DENOMINATOR = 3
export const H10_POSITIVE_SUCCESS_MINIMUM = 7
export const H10_FALSE_OUTPUTS_MAXIMUM = 0
export const H10_REFERENCE_BASELINE_H8A = Object.freeze({
  positiveSuccesses: 7,
  falseOutputs: 2,
})

export const H10_REAL_RUN_DEVICE = 'cuda:0' as const

/** Frozen CLIP text context length from the approved H10 producer contract. */
export const H10_CLIP_MODEL_MAX_LENGTH = 77 as const

const EXPECTED_IMAGE_PROCESSOR_CLASS = 'ViTImageProcessor'
const EXPECTED_IMAGE_PROCESSOR_MODULE = 'transformers.models.vit.image_processing_vit'
const CLIPSEG_PROCESSOR_USE_FAST = false

/** CLI/default path always verifies on-disk receipts; tests use synthetic-fixture explicitly. */
export type H10EvaluationMode = 'dev-run' | 'synthetic-fixture'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const boundsSchema = z
  .object({
    x_min: z.number().int().nonnegative(),
    y_min: z.number().int().nonnegative(),
    x_max: z.number().int().nonnegative(),
    y_max: z.number().int().nonnegative(),
  })
  .strict()

const pilotCaseSchema = z
  .object({
    caseId: z.string().min(1),
    image: z
      .object({
        path: z.string().min(1),
        sha256: digestSchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    locate: z
      .object({
        target: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough()

const manifestRowSchema = z
  .object({
    row_index: z.number().int().min(0).max(11),
    row_key: z.string().min(1),
    source_path: z.string().min(1),
    authored_target: z.string().min(1),
    source_sha256: digestSchema,
  })
  .strict()

const manifestSchema = z
  .object({
    schema: z.literal('v03-h10-input-manifest-v1'),
    rows: z.array(manifestRowSchema).length(12),
  })
  .strict()

const rowOutcomeSchema = z.enum(['candidate', 'unresolved_empty', 'technical_error'])

const h10RowSchema = z
  .object({
    row_index: z.number().int().min(0).max(11),
    row_key: z.string().min(1),
    authored_target: z.string().min(1),
    outcome_kind: rowOutcomeSchema,
    source_width: z.number().int().positive(),
    source_height: z.number().int().positive(),
    source_sha256: digestSchema,
    oriented_rgb_sha256: digestSchema.optional(),
    mask_path: z.string().nullable().optional(),
    mask_sha256: digestSchema.nullable().optional(),
    foreground_bounds: boundsSchema.nullable().optional(),
    model_max_length: z.number().int().positive().optional(),
    interpolate_pos_encoding: z.boolean().optional(),
    error_code: z.string().optional(),
    error_message: z.string().optional(),
  })
  .passthrough()

const effectiveProcessorSchema = z
  .object({
    image_processor_class: z.literal(EXPECTED_IMAGE_PROCESSOR_CLASS),
    image_processor_module: z.literal(EXPECTED_IMAGE_PROCESSOR_MODULE),
    use_fast: z.literal(CLIPSEG_PROCESSOR_USE_FAST),
    size: z.object({ height: z.literal(352), width: z.literal(352) }).strict(),
    resample: z.literal(2),
    do_resize: z.literal(true),
    do_rescale: z.literal(true),
    do_normalize: z.literal(true),
    rescale_factor: z.number(),
    image_mean: z.array(z.number()).length(3),
    image_std: z.array(z.number()).length(3),
  })
  .strict()

/** Producer caps stderr tail retention; evaluator validates bounded diagnostic text only. */
export const H10_RUN_WORKER_STDERR_TAIL_MAX_CHARS = 16_384

const cudaRuntimeUnavailableSchema = z
  .object({
    cuda_available: z.literal(false),
  })
  .strict()

const cudaRuntimeAvailableSchema = z
  .object({
    cuda_available: z.literal(true),
    cuda_device_index: z.number().int().nonnegative(),
    cuda_device_name: z.string().min(1).max(512),
    cuda_version: z.union([z.string().max(64), z.null()]),
  })
  .strict()

/** Self-reported CUDA diagnostics; never treated as independent GPU proof. */
const cudaRuntimeSchema = z.discriminatedUnion('cuda_available', [
  cudaRuntimeUnavailableSchema,
  cudaRuntimeAvailableSchema,
])

/** Producer `collect_runtime_receipt` fields embedded in freeze.runtime (schema/consistency only). */
const freezeRuntimeReceiptSchema = z
  .object({
    python_executable: z.string().min(1),
    python_version: z.string().min(1),
    torch: z.string().min(1),
    transformers: z.string().min(1),
    pillow: z.string().min(1),
    numpy: z.string().min(1),
    platform: z.string().min(1),
    cuda_available: z.boolean(),
    cuda_version: z.string(),
  })
  .strict()

const freezeRuntimeSchema = freezeRuntimeReceiptSchema
  .extend({
    cuda_device: cudaRuntimeSchema,
  })
  .strict()

const runTimingMsSchema = z.number().finite().nonnegative()

const freezeSchema = z
  .object({
    schema: z.literal('v03-h10-clipseg-freeze-v1'),
    manifest_path: z.string().min(1),
    manifest_sha256: digestSchema,
    contract_path: z.string().min(1),
    contract_sha256: digestSchema,
    asset_dir: z.string().min(1),
    asset_receipts: z.record(
      z.object({ sha256: digestSchema, bytes: z.number().int().nonnegative() }).strict(),
    ),
    rows: z.array(manifestRowSchema).length(12),
    recipe: z
      .object({
        interpolate_pos_encoding: z.literal(true),
        threshold: z.literal('logit >= 0'),
        logits_grid: z.literal(352),
        max_encoded_bytes: z.literal(25_165_824),
        max_oriented_pixels: z.literal(2_097_152),
      })
      .strict(),
    preprocessor_on_disk: z.object({ preprocessor_config_sha256: digestSchema }).strict(),
    effective_processor: effectiveProcessorSchema,
    runtime: freezeRuntimeSchema,
    worker_script_sha256: digestSchema,
    runner_script_sha256: digestSchema,
    common_script_sha256: digestSchema,
    worker_script_path: z.string().min(1),
    runner_script_path: z.string().min(1),
    common_script_path: z.string().min(1),
    requested_device: z.literal(H10_REAL_RUN_DEVICE),
  })
  .passthrough()

const runSchema = z
  .object({
    schema: z.literal('v03-h10-clipseg-run-v1'),
    status: z.string().min(1),
    freeze_path: z.string().min(1),
    freeze_sha256: digestSchema,
    manifest_sha256: digestSchema,
    contract_sha256: digestSchema,
    worker_script_sha256: digestSchema,
    device: z.literal(H10_REAL_RUN_DEVICE),
    cuda_runtime: cudaRuntimeSchema,
    load_ms: runTimingMsSchema.nullable(),
    wall_ms: runTimingMsSchema,
    worker_pid: z.number().int().positive().nullable(),
    worker_stderr_tail: z.string().max(H10_RUN_WORKER_STDERR_TAIL_MAX_CHARS),
    row_count: z.number().int(),
  })
  .strict()

const EXPECTED_ASSET_RECEIPTS: Record<string, { sha256: string; bytes: number }> = {
  'config.json': {
    sha256: 'c023375966d31b3b1392764f7bd91df47098ce19f62f11b0263d8eedcf708bcd',
    bytes: 4732,
  },
  'merges.txt': {
    sha256: '9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a',
    bytes: 524619,
  },
  'model.safetensors': {
    sha256: 'd00ca85d6b859f9d07b7cfb8ef26fe9771cb275b34c9368f2ecf603139307f55',
    bytes: 603_049_496,
  },
  'preprocessor_config.json': {
    sha256: '4fb09ebcfd7651205ca8299b993c30088e5535ef350a72d46c5c4580eeac0440',
    bytes: 380,
  },
  'special_tokens_map.json': {
    sha256: 'c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac',
    bytes: 472,
  },
  'tokenizer_config.json': {
    sha256: '4c75d57fd9bd0be8478ad2d6f8b9cebdd4a45338eb108547329c2b6333476ca6',
    bytes: 974,
  },
  'vocab.json': {
    sha256: 'e089ad92ba36837a0d31433e555c8f45fe601ab5c221d4f607ded32d9f7a4349',
    bytes: 1_059_962,
  },
}

const CASE_ORDER = [
  ...Array.from(
    { length: 4 },
    (_, index) => `pilot-v03-photo-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-ui-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `pilot-v03-map-${String(index + 1).padStart(2, '0')}`),
] as const

export type ExpectedH10PilotRow = {
  row_index: number
  row_key: string
  caseId: string
  authored_target: string
  expectedSourceSha256: string
  sourceWidth: number
  sourceHeight: number
  stratum: V03PilotTruth['stratum']
  presence: V03PilotTruth['presence']
  referenceBoxes: readonly Box[]
}

export type H10MaskAudit = {
  status: 'not_applicable' | 'valid' | 'invalid'
  reason: string | null
  maskDerivedBox: Box | null
  recomputedBounds: z.infer<typeof boundsSchema> | null
}

export type H10EvaluatedRow = {
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
  maskAudit: H10MaskAudit
  joinErrors: string[]
  rowErrors: string[]
}

export type H10EvaluationReport = {
  schema: 'v03-h10-clipseg-evaluation-v1'
  hypothesis: 'h10-clipseg-direct-mask'
  integrityErrors: string[]
  gate: {
    positiveDenominator: number
    positiveSuccessesMinimum: number
    positiveSuccesses: number
    negativeDenominator: number
    falseOutputsMaximum: number
    falseOutputs: number
    cleanPass: boolean
  }
  referenceBaselineH8a: typeof H10_REFERENCE_BASELINE_H8A
  stratumSummary: Record<
    V03PilotTruth['stratum'],
    {
      positives: number
      positiveSuccesses: number
      negatives: number
      falseOutputs: number
    }
  >
  perRow: H10EvaluatedRow[]
}

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export async function hashFileOnDisk(path: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readFile(path)
  return { sha256: sha256(bytes), bytes: bytes.byteLength }
}

async function resolveReadablePath(path: string): Promise<string> {
  const resolved = resolve(path)
  await stat(resolved)
  return realpath(resolved)
}

function manifestRowEquals(
  left: z.infer<typeof manifestRowSchema>,
  right: z.infer<typeof manifestRowSchema>,
): boolean {
  return (
    left.row_index === right.row_index &&
    left.row_key === right.row_key &&
    left.source_path === right.source_path &&
    left.authored_target === right.authored_target &&
    left.source_sha256 === right.source_sha256
  )
}

export function compareLockedManifestToFreezeRows(
  lockedRows: z.infer<typeof manifestRowSchema>[],
  freezeRows: z.infer<typeof manifestRowSchema>[],
): string[] {
  const errors: string[] = []
  if (lockedRows.length !== 12 || freezeRows.length !== 12) {
    errors.push('manifest-freeze-row-count-not-12')
    return errors
  }
  for (let index = 0; index < 12; index++) {
    const locked = lockedRows[index]
    const frozen = freezeRows[index]
    if (!locked || !frozen) {
      errors.push(`manifest-freeze-row-missing-${index}`)
      continue
    }
    if (!manifestRowEquals(locked, frozen)) errors.push(`manifest-freeze-row-drift-${index}`)
  }
  return errors
}

export async function resolveMaskPathWithinRunRoot(
  runRoot: string,
  maskPath: string,
): Promise<string> {
  const candidate = isAbsolute(maskPath) ? maskPath : resolve(runRoot, maskPath)
  const realRoot = await realpath(runRoot)
  const realCandidate = await realpath(candidate)
  const part = relative(realRoot, realCandidate)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('mask-path-outside-run')
  return realCandidate
}

export function validateApprovedContractShape(contract: Record<string, unknown>): string[] {
  const errors: string[] = []
  const processor = contract.processor as { class?: string } | undefined
  if (processor?.class !== 'CLIPSegProcessor') errors.push('contract-processor-class-mismatch')
  const payload = contract.model_conditioning_payload as { fields?: string[] } | undefined
  const conditioning = payload?.fields ?? []
  if (
    conditioning.length !== 2 ||
    conditioning[0] !== 'oriented_source_rgb' ||
    conditioning[1] !== 'authored_target_string'
  )
    errors.push('contract-model-conditioning-fields-mismatch')
  const rowOutput = contract.row_output as { required_fields?: string[] } | undefined
  const required = rowOutput?.required_fields ?? []
  if (required.includes('oriented_source_sha256'))
    errors.push('contract-stale-oriented_source_sha256-required')
  for (const field of [
    'source_sha256',
    'oriented_rgb_sha256',
    'authored_target',
    'model_max_length',
  ] as const) {
    if (!required.includes(field)) errors.push(`contract-required-field-absent-${field}`)
  }
  return errors
}

export async function verifyScriptPathHash(
  scriptPath: string,
  expectedSha256: string,
  label: string,
): Promise<string[]> {
  const errors: string[] = []
  try {
    const resolved = await resolveReadablePath(scriptPath)
    const digest = await hashFileOnDisk(resolved)
    if (digest.sha256 !== expectedSha256) errors.push(`${label}-script-sha256-mismatch`)
  } catch {
    errors.push(`${label}-script-path-unreadable`)
  }
  return errors
}

export async function verifyLockedSourcePathClosure(
  lockedRows: z.infer<typeof manifestRowSchema>[],
  freezeRows: z.infer<typeof manifestRowSchema>[],
  integrityErrors: string[],
): Promise<void> {
  const canonicalByIndex = new Map<number, string>()
  for (const row of lockedRows) {
    try {
      const resolved = await resolveReadablePath(row.source_path)
      canonicalByIndex.set(row.row_index, resolved)
      const digest = await hashFileOnDisk(resolved)
      if (digest.sha256 !== row.source_sha256)
        integrityErrors.push(`${row.row_key}:locked-manifest-source-bytes-mismatch`)
    } catch {
      integrityErrors.push(`${row.row_key}:locked-manifest-source-unreadable`)
    }
  }
  for (const row of freezeRows) {
    const locked = lockedRows.find((item) => item.row_index === row.row_index)
    if (!locked) continue
    if (row.source_path !== locked.source_path)
      integrityErrors.push(`${row.row_key}:freeze-manifest-source-path-drift`)
    try {
      const resolved = await resolveReadablePath(row.source_path)
      const canonical = canonicalByIndex.get(row.row_index)
      if (canonical !== undefined && resolved !== canonical)
        integrityErrors.push(`${row.row_key}:source-path-symlink-redirect`)
    } catch {
      integrityErrors.push(`${row.row_key}:freeze-source-path-unreadable`)
    }
  }
}

async function listMaskPngRealPaths(
  masksDir: string,
  integrityErrors: string[],
): Promise<Set<string>> {
  const actualRealPaths = new Set<string>()
  async function walk(currentDir: string, relativePrefix: string): Promise<void> {
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
        integrityErrors.push(`masks-nested-directory-${relativeName}`)
        await walk(absolutePath, relativeName)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.png')) {
        integrityErrors.push(`masks-non-png-file-${relativeName}`)
        continue
      }
      try {
        actualRealPaths.add(await realpath(absolutePath))
      } catch {
        integrityErrors.push(`mask-file-unresolvable-${relativeName}`)
      }
    }
  }
  await walk(masksDir, '')
  return actualRealPaths
}

export async function verifyEmittedMaskInventory(
  runRoot: string,
  rows: z.infer<typeof h10RowSchema>[],
  integrityErrors: string[],
): Promise<void> {
  const masksDir = resolve(runRoot, 'masks')
  const expectedRealPaths = new Set<string>()
  for (const row of rows) {
    if (row.outcome_kind !== 'candidate') continue
    if (!row.mask_path) {
      integrityErrors.push(`${row.row_key}:candidate-missing-mask-path-inventory`)
      continue
    }
    try {
      expectedRealPaths.add(await resolveMaskPathWithinRunRoot(runRoot, row.mask_path))
    } catch {
      integrityErrors.push(`${row.row_key}:candidate-mask-path-outside-run`)
    }
  }
  const actualRealPaths = await listMaskPngRealPaths(masksDir, integrityErrors)
  for (const path of actualRealPaths) {
    if (!expectedRealPaths.has(path)) integrityErrors.push(`stray-mask-file-${path}`)
  }
  for (const path of expectedRealPaths) {
    if (!actualRealPaths.has(path)) integrityErrors.push(`missing-emitted-mask-${path}`)
  }
}

/** Self-reported CUDA receipts for cuda:0 dev runs; not independent hardware attestation. */
export function verifyCudaDevRunReceiptConsistency(
  runtime: z.infer<typeof freezeRuntimeSchema>,
  runCudaRuntime: z.infer<typeof cudaRuntimeSchema>,
): string[] {
  const errors: string[] = []
  if (runtime.cuda_device.cuda_available !== runtime.cuda_available)
    errors.push('freeze-runtime-cuda-available-flag-mismatch')
  if (!runtime.cuda_available) errors.push('freeze-runtime-cuda-unavailable')
  if (!runCudaRuntime.cuda_available) errors.push('run-cuda-runtime-unavailable')
  if (runtime.cuda_available && runtime.cuda_version.length === 0)
    errors.push('freeze-runtime-cuda-version-empty')

  if (runtime.cuda_device.cuda_available) {
    const nested = runtime.cuda_device
    if (nested.cuda_device_index !== 0) errors.push('freeze-cuda-device-index-not-zero')
    if (nested.cuda_device_name.length === 0) errors.push('freeze-cuda-device-name-empty')
    if (nested.cuda_version == null || nested.cuda_version.length === 0)
      errors.push('freeze-cuda-device-version-empty')
    if (
      runtime.cuda_version.length > 0 &&
      nested.cuda_version != null &&
      runtime.cuda_version !== nested.cuda_version
    )
      errors.push('cuda-version-freeze-receipt-device-mismatch')
  }

  if (runCudaRuntime.cuda_available) {
    const runNested = runCudaRuntime
    if (runNested.cuda_device_index !== 0) errors.push('run-cuda-device-index-not-zero')
    if (runNested.cuda_device_name.length === 0) errors.push('run-cuda-device-name-empty')
    if (runNested.cuda_version == null || runNested.cuda_version.length === 0)
      errors.push('run-cuda-version-empty')
    if (runtime.cuda_device.cuda_available) {
      const freezeNested = runtime.cuda_device
      if (
        freezeNested.cuda_version != null &&
        runNested.cuda_version != null &&
        freezeNested.cuda_version !== runNested.cuda_version
      )
        errors.push('cuda-version-freeze-device-run-mismatch')
    }
    if (
      runtime.cuda_version.length > 0 &&
      runNested.cuda_version != null &&
      runtime.cuda_version !== runNested.cuda_version
    )
      errors.push('cuda-version-freeze-receipt-run-mismatch')
  }

  return errors
}

export function verifyRunRecordProducerBindings(
  runRecord: z.infer<typeof runSchema>,
  freezeRecord: z.infer<typeof freezeSchema>,
): string[] {
  const errors: string[] = []
  if (runRecord.worker_script_sha256 !== freezeRecord.worker_script_sha256)
    errors.push('run-worker-script-sha256-mismatch')
  if (runRecord.manifest_sha256 !== freezeRecord.manifest_sha256)
    errors.push('run-manifest-sha256-mismatch')
  if (runRecord.contract_sha256 !== freezeRecord.contract_sha256)
    errors.push('run-contract-sha256-mismatch')
  return errors
}

export async function verifyRunDeviceAndFreezePath(
  runRoot: string,
  freezeRecord: z.infer<typeof freezeSchema>,
  runRecord: z.infer<typeof runSchema>,
  integrityErrors: string[],
): Promise<void> {
  if (freezeRecord.requested_device !== H10_REAL_RUN_DEVICE)
    integrityErrors.push('freeze-requested-device-mismatch')
  if (runRecord.device !== freezeRecord.requested_device)
    integrityErrors.push('run-device-mismatch')
  try {
    const actualFreeze = await realpath(resolve(runRoot, 'freeze.json'))
    const recordedFreeze = await realpath(runRecord.freeze_path)
    if (actualFreeze !== recordedFreeze) integrityErrors.push('run-freeze-path-mismatch')
  } catch {
    integrityErrors.push('run-freeze-path-unverifiable')
  }
}

export function foregroundBoundsToBox(bounds: z.infer<typeof boundsSchema>): Box {
  if (bounds.x_max < bounds.x_min || bounds.y_max < bounds.y_min)
    throw new Error('foreground-bounds-inverted')
  return {
    left: bounds.x_min,
    top: bounds.y_min,
    width: bounds.x_max - bounds.x_min + 1,
    height: bounds.y_max - bounds.y_min + 1,
  }
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

export function maskForegroundBounds(
  bits: Uint8Array,
  width: number,
  height: number,
): z.infer<typeof boundsSchema> | null {
  let xMin = width
  let yMin = height
  let xMax = -1
  let yMax = -1
  for (let index = 0; index < bits.length; index++) {
    const value = bits[index]
    if (value !== 0 && value !== 1) throw new Error('mask-not-binary')
    if (!value) continue
    const x = index % width
    const y = Math.floor(index / width)
    xMin = Math.min(xMin, x)
    yMin = Math.min(yMin, y)
    xMax = Math.max(xMax, x)
    yMax = Math.max(yMax, y)
  }
  return xMax < 0 ? null : { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax }
}

export async function loadPilotInputCases(): Promise<z.infer<typeof pilotCaseSchema>[]> {
  const cases: z.infer<typeof pilotCaseSchema>[] = []
  for (const manifest of v03PilotManifests) {
    const bytes = await readFile(manifest.path)
    if (sha256(bytes) !== manifest.sha256)
      throw new Error(`pilot manifest hash mismatch: ${manifest.path}`)
    cases.push(...z.array(pilotCaseSchema).parse(JSON.parse(bytes.toString('utf8'))))
  }
  const byId = new Map(cases.map((item) => [item.caseId, item]))
  return CASE_ORDER.map((caseId) => {
    const item = byId.get(caseId)
    if (!item) throw new Error(`missing pilot case ${caseId}`)
    return item
  })
}

export async function buildExpectedH10PilotRows(
  truth?: readonly V03PilotTruth[],
): Promise<ExpectedH10PilotRow[]> {
  const resolvedTruth = truth ?? (await loadV03PilotTruth())
  assert(resolvedTruth.length === 12, 'pilot truth must contain 12 cases')
  const truthByCase = new Map(resolvedTruth.map((item) => [item.caseId, item]))
  const pilotCases = await loadPilotInputCases()
  return pilotCases.map((pilotCase, row_index) => {
    const expectedTruth = truthByCase.get(pilotCase.caseId)
    if (!expectedTruth) throw new Error(`truth missing for ${pilotCase.caseId}`)
    if (expectedTruth.imageSha256 !== pilotCase.image.sha256)
      throw new Error(`source hash mismatch for ${pilotCase.caseId}`)
    if (
      expectedTruth.sourceWidth !== pilotCase.image.width ||
      expectedTruth.sourceHeight !== pilotCase.image.height
    )
      throw new Error(`source dimensions mismatch for ${pilotCase.caseId}`)
    return {
      row_index,
      row_key: pilotCase.caseId,
      caseId: pilotCase.caseId,
      authored_target: pilotCase.locate.target,
      expectedSourceSha256: pilotCase.image.sha256,
      sourceWidth: pilotCase.image.width,
      sourceHeight: pilotCase.image.height,
      stratum: expectedTruth.stratum,
      presence: expectedTruth.presence,
      referenceBoxes: expectedTruth.boxes,
    }
  })
}

export function expectedManifestRowsMatch(
  expected: ExpectedH10PilotRow[],
  actual: z.infer<typeof manifestRowSchema>[],
): string[] {
  const errors: string[] = []
  if (actual.length !== 12) errors.push('manifest-row-count-not-12')
  for (const row of expected) {
    const match = actual.find((item) => item.row_index === row.row_index)
    if (!match) {
      errors.push(`manifest-row-missing-index-${row.row_index}`)
      continue
    }
    if (match.row_key !== row.row_key) errors.push(`manifest-row-key-${row.row_index}`)
    if (match.authored_target !== row.authored_target)
      errors.push(`manifest-authored-target-${row.row_index}`)
    if (match.source_sha256 !== row.expectedSourceSha256)
      errors.push(`manifest-source-sha-${row.row_index}`)
  }
  return errors
}

export async function verifyMinimalDevManifestFile(
  integrityErrors: string[],
): Promise<z.infer<typeof manifestSchema> | null> {
  try {
    const bytes = await readFile(MINIMAL_DEV_MANIFEST_PATH)
    const digest = sha256(bytes)
    if (digest !== MINIMAL_DEV_MANIFEST_SHA256)
      integrityErrors.push('minimal-dev-manifest-sha256-mismatch')
    return manifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  } catch {
    integrityErrors.push('minimal-dev-manifest-unreadable')
    return null
  }
}

export async function verifyFrozenManifestSources(
  manifestRows: z.infer<typeof manifestRowSchema>[],
  expectedRows: ExpectedH10PilotRow[],
  integrityErrors: string[],
): Promise<void> {
  integrityErrors.push(...expectedManifestRowsMatch(expectedRows, manifestRows))
  for (const row of manifestRows) {
    const expected = expectedRows.find((item) => item.row_index === row.row_index)
    if (!expected) continue
    let sourcePath: string
    try {
      sourcePath = await resolveReadablePath(row.source_path)
    } catch {
      integrityErrors.push(`${expected.row_key}:source-path-unreadable`)
      continue
    }
    try {
      const digest = await hashFileOnDisk(sourcePath)
      if (digest.sha256 !== row.source_sha256)
        integrityErrors.push(`${expected.row_key}:manifest-source-sha256-mismatch-bytes`)
      if (digest.sha256 !== expected.expectedSourceSha256)
        integrityErrors.push(`${expected.row_key}:source-bytes-mismatch-pilot-lock`)
    } catch {
      integrityErrors.push(`${expected.row_key}:source-bytes-unreadable`)
    }
  }
}

export function verifyAssetReceiptMetadata(
  receipts: Record<string, { sha256: string; bytes: number }>,
): string[] {
  const errors: string[] = []
  for (const [path, expected] of Object.entries(EXPECTED_ASSET_RECEIPTS)) {
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

export async function verifyAssetDirectoryOnDisk(
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
  for (const [name, expected] of Object.entries(EXPECTED_ASSET_RECEIPTS)) {
    const candidate = resolve(root, name)
    const part = relative(root, candidate)
    if (!part || part.startsWith(`..${sep}`) || isAbsolute(part)) {
      integrityErrors.push(`asset-path-escape-${name}`)
      continue
    }
    try {
      const link = await lstat(candidate)
      const digest = await hashFileOnDisk(candidate)
      if (digest.sha256 !== expected.sha256 || digest.bytes !== expected.bytes)
        integrityErrors.push(`asset-bytes-mismatch-${name}`)
      const resolved = await realpath(candidate)
      const escaped = relative(root, resolved)
      if (!escaped || escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
        integrityErrors.push(`asset-symlink-escape-${name}`)
      if (link.isSymbolicLink() && resolved !== candidate)
        integrityErrors.push(`asset-symlink-redirect-${name}`)
    } catch {
      integrityErrors.push(`asset-file-missing-${name}`)
    }
  }
}

export async function verifyContractFile(
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
    if (contract.schema !== 'v03-h10-clipseg-producer-contract-v1')
      integrityErrors.push('contract-schema-mismatch')
    integrityErrors.push(...validateApprovedContractShape(contract))
    return contract
  } catch {
    integrityErrors.push('contract-bytes-unreadable')
    return null
  }
}

export function validateProducerOutcomeRowFields(
  row: z.infer<typeof h10RowSchema>,
  contract: Record<string, unknown> | null,
): string[] {
  const errors: string[] = []
  const prefix = row.row_key
  if (!row.source_sha256) errors.push(`${prefix}:row-source-sha256-missing`)
  if (row.outcome_kind === 'unresolved_empty') {
    if (row.mask_path) errors.push(`${prefix}:unresolved-empty-has-mask-path`)
    if (row.mask_sha256) errors.push(`${prefix}:unresolved-empty-has-mask-sha256`)
    if (row.foreground_bounds) errors.push(`${prefix}:unresolved-empty-has-foreground-bounds`)
  }
  if (row.outcome_kind !== 'candidate') {
    if (row.mask_path) errors.push(`${prefix}:non-candidate-has-mask-path`)
    if (row.mask_sha256) errors.push(`${prefix}:non-candidate-has-mask-sha256`)
    if (row.foreground_bounds) errors.push(`${prefix}:non-candidate-has-foreground-bounds`)
  }
  if (row.outcome_kind === 'technical_error') errors.push(`${prefix}:technical-error`)
  if (row.source_width <= 0 || row.source_height <= 0)
    errors.push(`${prefix}:row-source-dimensions-missing`)
  if (contract) {
    const rowOutput = contract.row_output as { required_fields?: string[] } | undefined
    const required = rowOutput?.required_fields ?? []
    for (const field of required) {
      if (field === 'oriented_source_sha256') {
        errors.push(`${prefix}:contract-stale-oriented_source_sha256-required`)
        continue
      }
      if (!(field in row)) errors.push(`${prefix}:contract-required-field-missing-${field}`)
    }
    if (
      required.includes('model_max_length') &&
      row.model_max_length !== undefined &&
      row.model_max_length !== H10_CLIP_MODEL_MAX_LENGTH
    ) {
      errors.push(`${prefix}:contract-model-max-length-not-${H10_CLIP_MODEL_MAX_LENGTH}`)
    }
  }
  return errors
}

export function verifyEffectiveProcessorSnapshot(
  effective: z.infer<typeof effectiveProcessorSchema>,
): string[] {
  const errors: string[] = []
  if (effective.image_processor_class !== EXPECTED_IMAGE_PROCESSOR_CLASS)
    errors.push('effective-processor-class')
  if (effective.image_processor_module !== EXPECTED_IMAGE_PROCESSOR_MODULE)
    errors.push('effective-processor-module')
  if (effective.use_fast !== CLIPSEG_PROCESSOR_USE_FAST) errors.push('effective-processor-use-fast')
  if (effective.do_rescale !== true) errors.push('effective-processor-do-rescale')
  if (effective.do_normalize !== true) errors.push('effective-processor-do-normalize')
  if (Math.abs(effective.rescale_factor - 1 / 255) > 1e-12)
    errors.push('effective-processor-rescale-factor')
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  if (effective.image_mean.some((value, index) => value !== mean[index]))
    errors.push('effective-processor-image-mean')
  if (effective.image_std.some((value, index) => value !== std[index]))
    errors.push('effective-processor-image-std')
  return errors
}

export async function auditCandidateMask(input: {
  runRoot: string
  row: z.infer<typeof h10RowSchema>
  expectedWidth: number
  expectedHeight: number
}): Promise<H10MaskAudit> {
  const invalid = (reason: string): H10MaskAudit => ({
    status: 'invalid',
    reason,
    maskDerivedBox: null,
    recomputedBounds: null,
  })
  if (input.row.outcome_kind !== 'candidate') {
    return {
      status: 'not_applicable',
      reason: null,
      maskDerivedBox: null,
      recomputedBounds: null,
    }
  }
  if (!input.row.mask_path || !input.row.mask_sha256)
    return invalid('candidate-missing-mask-path-or-sha')
  if (!input.row.foreground_bounds) return invalid('candidate-missing-foreground-bounds')
  if (
    input.row.source_width !== input.expectedWidth ||
    input.row.source_height !== input.expectedHeight
  )
    return invalid('candidate-source-dimensions-mismatch')
  let maskPath: string
  try {
    maskPath = await resolveMaskPathWithinRunRoot(input.runRoot, input.row.mask_path)
  } catch {
    return invalid('mask-path-outside-run')
  }
  const bytes = await readFile(maskPath)
  if (sha256(bytes) !== input.row.mask_sha256) return invalid('mask-sha256-mismatch')
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1)
    return invalid('mask-not-single-png')
  if (metadata.width !== input.expectedWidth || metadata.height !== input.expectedHeight)
    return invalid('mask-decoded-dimensions-mismatch')
  if (metadata.hasAlpha === true) return invalid('mask-has-alpha')
  const channelCount = metadata.channels ?? 0
  if (channelCount >= 3) return invalid('mask-not-single-channel-l')
  if (channelCount !== 1 && metadata.space !== 'b-w') return invalid('mask-not-single-channel-l')
  const decoded = await sharp(bytes, { failOn: 'error' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (decoded.info.channels !== 1) return invalid('mask-not-single-channel-l')
  const bits = new Uint8Array(decoded.data.length)
  for (let index = 0; index < decoded.data.length; index++) {
    const value = decoded.data[index]
    if (value !== 0 && value !== 255) return invalid('mask-not-binary-png')
    bits[index] = value === 255 ? 1 : 0
  }
  const recomputedBounds = maskForegroundBounds(bits, input.expectedWidth, input.expectedHeight)
  if (!recomputedBounds) return invalid('candidate-mask-empty')
  if (!boundsEqual(recomputedBounds, input.row.foreground_bounds))
    return invalid('foreground-bounds-mismatch')
  const maskDerivedBox = foregroundBoundsToBox(recomputedBounds)
  return {
    status: 'valid',
    reason: null,
    maskDerivedBox,
    recomputedBounds,
  }
}

function scoreRow(
  expected: ExpectedH10PilotRow,
  row: z.infer<typeof h10RowSchema> | undefined,
  maskAudit: H10MaskAudit,
): H10EvaluatedRow {
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
  if (row.source_width !== expected.sourceWidth || row.source_height !== expected.sourceHeight)
    joinErrors.push('source-dimensions-mismatch')
  if (row.interpolate_pos_encoding !== undefined && row.interpolate_pos_encoding !== true)
    rowErrors.push('interpolate-pos-encoding-not-true')

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
    joinErrors,
    rowErrors,
  }
}

async function verifyDevRunReceipts(input: {
  runRoot: string
  expectedRows: ExpectedH10PilotRow[]
  freezeRecord: z.infer<typeof freezeSchema>
  runRecord: z.infer<typeof runSchema>
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
  try {
    const manifestBytes = await readFile(freezeRecord.manifest_path)
    if (sha256(manifestBytes) !== MINIMAL_DEV_MANIFEST_SHA256)
      integrityErrors.push('freeze-manifest-bytes-not-minimal-dev-lock')
    if (sha256(manifestBytes) !== freezeRecord.manifest_sha256)
      integrityErrors.push('freeze-manifest-bytes-hash-mismatch')
  } catch {
    integrityErrors.push('freeze-manifest-path-unreadable')
  }
  integrityErrors.push(...verifyAssetReceiptMetadata(freezeRecord.asset_receipts))
  await verifyAssetDirectoryOnDisk(freezeRecord.asset_dir, integrityErrors)
  const contract = await verifyContractFile(
    freezeRecord.contract_path,
    freezeRecord.contract_sha256,
    integrityErrors,
  )
  try {
    const preprocessorPath = resolve(
      await resolveReadablePath(freezeRecord.asset_dir),
      'preprocessor_config.json',
    )
    const preprocessorDigest = await hashFileOnDisk(preprocessorPath)
    if (preprocessorDigest.sha256 !== freezeRecord.preprocessor_on_disk.preprocessor_config_sha256)
      integrityErrors.push('preprocessor-on-disk-hash-mismatch')
  } catch {
    integrityErrors.push('preprocessor-on-disk-unverifiable')
  }
  integrityErrors.push(...verifyEffectiveProcessorSnapshot(freezeRecord.effective_processor))
  const expectedRecipe = {
    interpolate_pos_encoding: true as const,
    threshold: 'logit >= 0' as const,
    logits_grid: 352 as const,
    max_encoded_bytes: 25_165_824 as const,
    max_oriented_pixels: 2_097_152 as const,
  }
  if (JSON.stringify(freezeRecord.recipe) !== JSON.stringify(expectedRecipe))
    integrityErrors.push('freeze-recipe-metadata-mismatch')
  integrityErrors.push(
    ...(await verifyScriptPathHash(
      freezeRecord.worker_script_path,
      freezeRecord.worker_script_sha256,
      'worker',
    )),
  )
  integrityErrors.push(
    ...(await verifyScriptPathHash(
      freezeRecord.runner_script_path,
      freezeRecord.runner_script_sha256,
      'runner',
    )),
  )
  integrityErrors.push(
    ...(await verifyScriptPathHash(
      freezeRecord.common_script_path,
      freezeRecord.common_script_sha256,
      'common',
    )),
  )
  if (lockedManifest)
    await verifyLockedSourcePathClosure(lockedManifest.rows, freezeRecord.rows, integrityErrors)
  await verifyFrozenManifestSources(freezeRecord.rows, expectedRows, integrityErrors)
  await verifyRunDeviceAndFreezePath(runRoot, freezeRecord, runRecord, integrityErrors)
  try {
    const freezeBytes = await readFile(resolve(runRoot, 'freeze.json'))
    if (sha256(freezeBytes) !== runRecord.freeze_sha256)
      integrityErrors.push('run-freeze-sha256-mismatch')
  } catch {
    integrityErrors.push('run-freeze-hash-unverifiable')
  }
  integrityErrors.push(...verifyRunRecordProducerBindings(runRecord, freezeRecord))
  integrityErrors.push(
    ...verifyCudaDevRunReceiptConsistency(freezeRecord.runtime, runRecord.cuda_runtime),
  )
  if (runRecord.row_count !== 12) integrityErrors.push('run-row-count-not-12')
  if (runRecord.status !== 'completed')
    integrityErrors.push(`run-status-not-completed:${runRecord.status}`)
  return contract
}

export async function evaluateH10ClipsegRun(input: {
  runRoot: string
  mode?: H10EvaluationMode
  truth?: readonly V03PilotTruth[]
  expectedRows?: ExpectedH10PilotRow[]
  rows?: z.infer<typeof h10RowSchema>[]
  freeze?: unknown
  run?: unknown
}): Promise<H10EvaluationReport> {
  const mode: H10EvaluationMode = input.mode ?? 'dev-run'
  const integrityErrors: string[] = []
  const runRoot = await realpath(input.runRoot)

  let truth: readonly V03PilotTruth[]
  let expectedRows: ExpectedH10PilotRow[]
  if (mode === 'dev-run') {
    if (input.rows !== undefined) integrityErrors.push('dev-run-rejects-injected-rows')
    if (input.truth !== undefined) integrityErrors.push('dev-run-rejects-injected-truth')
    if (input.expectedRows !== undefined)
      integrityErrors.push('dev-run-rejects-injected-expected-rows')
    if (input.freeze !== undefined) integrityErrors.push('dev-run-rejects-injected-freeze')
    if (input.run !== undefined) integrityErrors.push('dev-run-rejects-injected-run')
    truth = await loadV03PilotTruth()
    expectedRows = await buildExpectedH10PilotRows(truth)
  } else {
    truth = input.truth ?? (await loadV03PilotTruth())
    expectedRows = input.expectedRows ?? (await buildExpectedH10PilotRows(truth))
  }

  let freezeRecord: z.infer<typeof freezeSchema> | null = null
  let runRecord: z.infer<typeof runSchema> | null = null
  let contract: Record<string, unknown> | null = null

  if (mode === 'dev-run') {
    try {
      freezeRecord = freezeSchema.parse(
        JSON.parse((await readFile(resolve(runRoot, 'freeze.json'))).toString('utf8')),
      )
    } catch {
      integrityErrors.push('freeze-unreadable-or-invalid')
    }
    try {
      runRecord = runSchema.parse(
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

  let rows: z.infer<typeof h10RowSchema>[]
  if (mode === 'synthetic-fixture') {
    if (!input.rows) integrityErrors.push('synthetic-fixture-requires-injected-rows')
    rows = (input.rows ?? []).map((row) => h10RowSchema.parse(row))
  } else {
    try {
      const jsonl = (await readFile(resolve(runRoot, 'rows.jsonl'))).toString('utf8').trim()
      const lines = jsonl ? jsonl.split('\n') : []
      if (lines.length !== 12) integrityErrors.push('rows-jsonl-count-not-12')
      rows = lines.map((line, index) => {
        try {
          return h10RowSchema.parse(JSON.parse(line))
        } catch {
          integrityErrors.push(`rows-jsonl-parse-failure-${index}`)
          const expected = expectedRows[index]
          return h10RowSchema.parse({
            row_index: index,
            row_key: `invalid-${index}`,
            authored_target: 'invalid',
            outcome_kind: 'technical_error',
            source_width: expected?.sourceWidth ?? 1,
            source_height: expected?.sourceHeight ?? 1,
            source_sha256: '0'.repeat(64),
          })
        }
      })
    } catch {
      integrityErrors.push('rows-jsonl-unreadable')
      rows = []
    }
  }

  if (rows.length !== 12) integrityErrors.push('terminal-row-count-not-12')
  if (mode === 'dev-run') await verifyEmittedMaskInventory(runRoot, rows, integrityErrors)

  const perRow: H10EvaluatedRow[] = []
  for (const expected of expectedRows) {
    const row = rows.find((item) => item.row_index === expected.row_index)
    const maskAudit = row
      ? await auditCandidateMask({
          runRoot,
          row,
          expectedWidth: expected.sourceWidth,
          expectedHeight: expected.sourceHeight,
        })
      : {
          status: 'not_applicable' as const,
          reason: null,
          maskDerivedBox: null,
          recomputedBounds: null,
        }
    const evaluated = scoreRow(expected, row, maskAudit)
    if (row)
      integrityErrors.push(
        ...validateProducerOutcomeRowFields(row, mode === 'dev-run' ? contract : null),
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
  assert(positives.length === H10_POSITIVE_DENOMINATOR, 'positive denominator drift')
  assert(negatives.length === H10_NEGATIVE_DENOMINATOR, 'negative denominator drift')

  const positiveSuccesses = positives.filter((row) => row.positiveSuccess).length
  const falseOutputs = negatives.filter((row) => row.negativeFalseOutput).length
  const gateThresholdMet =
    positiveSuccesses >= H10_POSITIVE_SUCCESS_MINIMUM && falseOutputs <= H10_FALSE_OUTPUTS_MAXIMUM
  const cleanPass = gateThresholdMet && integrityErrors.length === 0

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
  ) as H10EvaluationReport['stratumSummary']

  return {
    schema: 'v03-h10-clipseg-evaluation-v1',
    hypothesis: 'h10-clipseg-direct-mask',
    integrityErrors,
    gate: {
      positiveDenominator: H10_POSITIVE_DENOMINATOR,
      positiveSuccessesMinimum: H10_POSITIVE_SUCCESS_MINIMUM,
      positiveSuccesses,
      negativeDenominator: H10_NEGATIVE_DENOMINATOR,
      falseOutputsMaximum: H10_FALSE_OUTPUTS_MAXIMUM,
      falseOutputs,
      cleanPass,
    },
    referenceBaselineH8a: H10_REFERENCE_BASELINE_H8A,
    stratumSummary,
    perRow,
  }
}

async function main() {
  const runRoot = resolve(process.argv[2] ?? '')
  if (!runRoot) throw new Error('usage: evaluate-h10-clipseg.ts <runRoot>')
  const report = await evaluateH10ClipsegRun({ runRoot, mode: 'dev-run' })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.gate.cleanPass) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : 'H10 evaluation failed'}\n`,
    )
    process.exitCode = 1
  })
}

export { manifestSchema, h10RowSchema, freezeSchema, freezeRuntimeSchema, runSchema }
