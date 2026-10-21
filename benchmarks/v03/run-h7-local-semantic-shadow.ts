import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { z } from 'zod'
import { assertActive, ClassifierError } from '../../src/entities/errors.js'
import { H7OwnedChild } from './h7-owned-child.js'
import { captureH6ReplaySource } from './h6-replay-source-closure.js'
import {
  executeNativeRecipeCase,
  loadH6NativeArtifacts,
  type H6NativeCase,
} from './h6-replay-kernel.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const receiptSchema = z.object({
  path: z.string(),
  sha256: digest,
  bytes: z.number().int().positive(),
})
const assetSchema = z.object({
  model_id: z.literal('google/siglip2-base-patch16-512'),
  revision: z.literal('a89f5c5093f902bf39d3cd4d81d2c09867f0724b'),
  license: z.literal('apache-2.0'),
  asset_directory: z.string(),
  files: z.array(receiptSchema).length(6),
})
const readySchema = z.object({
  type: z.literal('ready'),
  model_lock: assetSchema,
  runtime: z.record(z.unknown()),
  memory: z.record(z.number().finite().nonnegative()),
})
const candidateSchema = z.object({
  family: z.enum(['D', 'U']),
  ordinal: z.number().int().nonnegative(),
  alias: z.string(),
  source_family: z.enum(['h3b-dino-sam2', 'omni-sam2', 'h4e-sam2']),
  source_alias: z.string(),
  source_mask_path: z.string(),
  source_mask_sha256: digest,
  crop_xyxy: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  resize_geometry: z.record(z.unknown()).nullable(),
  clean_cosine: z.number().finite().nullable(),
  masked_cosine: z.number().finite().nullable(),
  mean_cosine: z.number().finite().nullable(),
  global_rank: z.number().int().positive().nullable(),
  family_rank: z.number().int().positive().nullable(),
})
const rowSchema = z.object({
  case_id: z.string(),
  target: z.string(),
  source_sha256: digest,
  source_width: z.number().int().positive(),
  source_height: z.number().int().positive(),
  status: z.enum(['complete', 'error', 'timeout']),
  error_code: z.string().nullable(),
  error: z.string().nullable(),
  timing_ms: z.record(z.number().finite().nonnegative()),
  memory: z.record(z.number().finite().nonnegative().nullable()),
  candidates: z.array(candidateSchema).max(72),
})
const responseSchema = z.object({
  type: z.literal('case_result'),
  case_id: z.string(),
  row: rowSchema,
})
type Row = z.infer<typeof rowSchema>
type FileReceipt = z.infer<typeof receiptSchema>

export interface H7ShadowOptions {
  repositoryRoot: string
  pythonPath: string
  assetDirectory: string
  outputDirectory: string
  launcherPath: string
  sourceRoots: {
    h5a_run_directory: string
    h3b_run_directory: string
    h4e_run_directory: string
    source_image_root: string
  }
  signal?: AbortSignal
}

const extraSources = [
  'benchmarks/v03/run-h7-local-semantic-shadow.ts',
  'benchmarks/v03/h7-owned-child.ts',
  'benchmarks/v03/h7_siglip2_shadow.py',
  'benchmarks/v03/h7-siglip2-asset-lock.json',
  'docs/research/v03-h7-local-semantic-reranking-plan.md',
]

async function fileReceipt(path: string): Promise<FileReceipt> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('H7 receipt requires an unaliased regular file')
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  let bytes = 0
  try {
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += data.byteLength
      hash.update(data)
    }
  } finally {
    stream.destroy()
  }
  if (bytes !== info.size) throw new Error('H7 file changed while hashing')
  return { path, sha256: hash.digest('hex'), bytes }
}

async function sourceClosure(root: string, launcherPath: string): Promise<FileReceipt[]> {
  const existing = await captureH6ReplaySource(root)
  const paths = [...new Set([...existing.files.map((file) => file.path), ...extraSources])].sort()
  const files = []
  for (const path of paths) files.push(await fileReceipt(resolve(root, path)))
  files.push(await fileReceipt(resolve(launcherPath)))
  return files
}

async function modelLock(root: string, directory: string) {
  const expected = assetSchema.parse(
    JSON.parse(await readFile(resolve(root, 'benchmarks/v03/h7-siglip2-asset-lock.json'), 'utf8')),
  )
  const asset_directory = await realpath(directory)
  const files = []
  for (const entry of expected.files) {
    if (entry.path.includes('/') || entry.path.includes('\\'))
      throw new Error('H7 asset name is invalid')
    const actual = await fileReceipt(resolve(asset_directory, entry.path))
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes)
      throw new Error('H7 asset differs from its pinned bytes')
    files.push({ ...actual, path: entry.path })
  }
  return { ...expected, asset_directory, files }
}

function payloadFor(item: H6NativeCase, source_roots: H7ShadowOptions['sourceRoots']) {
  const ordinals = { D: 0, U: 0 }
  return {
    case_id: item.case_id,
    target: item.target,
    source_path: item.source_path,
    source_sha256: item.source_sha256,
    source_width: item.source_width,
    source_height: item.source_height,
    source_roots,
    candidates: item.masks.map((mask) => {
      const ordinal = ordinals[mask.family]++
      return {
        family: mask.family,
        ordinal,
        alias: `${mask.family}${String(ordinal).padStart(2, '0')}`,
        source_family: mask.source_family,
        source_alias: mask.source_alias,
        source_mask_path: relative(source_roots.h5a_run_directory, mask.source_mask_path)
          .split('\\')
          .join('/'),
        source_mask_sha256: mask.source_mask_sha256,
        resolved_source_mask_path: mask.source_mask_path,
      }
    }),
  }
}

function errorRow(payload: ReturnType<typeof payloadFor>, error: unknown): Row {
  const code = error instanceof ClassifierError ? error.code : 'PROVIDER'
  return {
    case_id: payload.case_id,
    target: payload.target,
    source_sha256: payload.source_sha256,
    source_width: payload.source_width,
    source_height: payload.source_height,
    status: code === 'TIMEOUT' ? 'timeout' : 'error',
    error_code: code,
    error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown H7 worker error',
    timing_ms: {},
    memory: {},
    candidates: payload.candidates.map(({ resolved_source_mask_path: _path, ...candidate }) => ({
      ...candidate,
      crop_xyxy: null,
      resize_geometry: null,
      clean_cosine: null,
      masked_cosine: null,
      mean_cosine: null,
      global_rank: null,
      family_rank: null,
    })),
  }
}

function validateResult(value: unknown, payload: ReturnType<typeof payloadFor>): Row {
  const result = responseSchema.parse(value)
  const row = result.row
  if (
    result.case_id !== payload.case_id ||
    row.case_id !== payload.case_id ||
    row.target !== payload.target ||
    row.source_sha256 !== payload.source_sha256 ||
    row.source_width !== payload.source_width ||
    row.source_height !== payload.source_height ||
    row.candidates.length !== payload.candidates.length
  )
    throw new ClassifierError('INVALID_RESPONSE', 'H7 worker changed the frozen case identity')
  for (const [index, candidate] of row.candidates.entries()) {
    const expected = payload.candidates[index]
    if (
      !expected ||
      Object.entries(expected).some(
        ([key, val]) =>
          key !== 'resolved_source_mask_path' && candidate[key as keyof typeof candidate] !== val,
      )
    )
      throw new ClassifierError('INVALID_RESPONSE', 'H7 worker changed a candidate identity')
  }
  return row
}

async function writeJson(path: string, value: unknown, signal?: AbortSignal, exclusive = false) {
  const data = JSON.stringify(value, null, 2) + '\n'
  await writeFile(path, data, { flag: exclusive ? 'wx' : 'w', ...(signal ? { signal } : {}) })
}

/** Offline benchmark. No imported module loads an encoder or starts a child. */
export async function runH7LocalSemanticShadow(options: H7ShadowOptions) {
  const signal = options.signal ?? new AbortController().signal
  assertActive(signal)
  const root = await realpath(options.repositoryRoot)
  const output = resolve(options.outputDirectory)
  const native = await loadH6NativeArtifacts(
    options.sourceRoots.h5a_run_directory,
    options.sourceRoots.h4e_run_directory,
    signal,
  )
  const inputs = native.cases.map((item) => payloadFor(item, options.sourceRoots))
  const assets = await modelLock(root, options.assetDirectory)
  const closure = await sourceClosure(root, options.launcherPath)
  const python = await promisify(execFile)(
    options.pythonPath,
    [
      '-c',
      'import sys,json,importlib.metadata as m; print(json.dumps({"python":sys.version.split()[0],"executable":sys.executable,"torch":m.version("torch"),"transformers":m.version("transformers"),"numpy":m.version("numpy"),"pillow":m.version("Pillow")}))',
    ],
    { cwd: root, timeout: 10_000, maxBuffer: 65_536, signal },
  )
  const pythonRuntime = z.record(z.string()).parse(JSON.parse(python.stdout))
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  await mkdir(resolve(output, 'cases'))
  const inputPath = resolve(output, 'input.json')
  await writeJson(inputPath, { cases: inputs, source_roots: options.sourceRoots }, signal, true)
  const inputReceipt = await fileReceipt(inputPath)
  const freeze = {
    schema: 'v03-h7-local-semantic-shadow-freeze-v1',
    status: 'frozen-before-inference',
    created_at: new Date().toISOString(),
    source_locks: {
      h5a_run_sha256: native.locks.h5aRun,
      h5a_freeze_sha256: native.locks.h5aFreeze,
      h5a_integrity_sha256: native.locks.h5aIntegrity,
      h5a_worker_closure_sha256: native.locks.h5aWorkerClosure,
      h3b_run_sha256: native.locks.h3bRun,
      h4e_run_sha256: native.locks.h4eRun,
    },
    asset_lock: assets,
    source_roots: options.sourceRoots,
    source_closure: closure,
    input_json: { ...inputReceipt, path: 'input.json' },
    input_artifacts: native.closure,
    case_ids: inputs.map((item) => item.case_id),
    python_runtime: pythonRuntime,
    python_executable: await fileReceipt(await realpath(options.pythonPath)),
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
  }
  const freezePath = resolve(output, 'freeze.json')
  await writeJson(freezePath, freeze, signal, true)
  const freezeReceipt = await fileReceipt(freezePath)
  const rows: Row[] = []
  const started = performance.now()
  let worker: H7OwnedChild | undefined
  let ready: z.infer<typeof readySchema> | undefined
  let terminalError: unknown
  try {
    worker = new H7OwnedChild(
      options.pythonPath,
      [
        '-u',
        resolve(root, 'benchmarks/v03/h7_siglip2_shadow.py'),
        '--asset-dir',
        assets.asset_directory,
        '--worker',
      ],
      root,
    )
    ready = readySchema.parse(await worker.exchange(undefined, started + 120_000, signal))
    if (!isDeepStrictEqual(ready.model_lock, assets))
      throw new Error('Worker loaded different H7 assets')
    for (const key of ['python', 'torch', 'transformers', 'numpy', 'pillow'])
      if (ready.runtime[key] !== pythonRuntime[key])
        throw new Error('H7 Python runtime changed after freeze')
    await writeJson(resolve(output, 'worker-ready.json'), ready, signal, true)
    for (const input of inputs) {
      let row: Row
      try {
        if (worker.receipt.closed)
          throw new ClassifierError('PROVIDER', 'H7 worker already closed; no restart')
        const child = worker
        row = await executeNativeRecipeCase(input, signal, 240_000, {
          prepare: async () => ({
            dispose() {
              /* descriptors contain no decoded buffers */
            },
          }),
          compose: async (item, _prepared, caseSignal) =>
            validateResult(
              await child.exchange(
                { command: 'case', payload: item },
                performance.now() + 240_000,
                caseSignal,
              ),
              item,
            ),
          finish: async (item, _prepared, result, _timing, caseSignal) => {
            await writeJson(resolve(output, 'cases', item.case_id + '.json'), result, caseSignal)
            assertActive(caseSignal)
            return result
          },
        })
      } catch (error) {
        row = errorRow(input, error)
        await writeJson(resolve(output, 'cases', input.case_id + '.json'), row)
      }
      rows.push(row)
    }
    if (!worker.receipt.closed) await worker.finish(signal)
  } catch (error) {
    terminalError = error
  } finally {
    await worker?.dispose()
  }
  for (const input of inputs.slice(rows.length)) {
    const row = errorRow(input, terminalError ?? new Error('H7 initialization failed'))
    rows.push(row)
    await writeJson(resolve(output, 'cases', input.case_id + '.json'), row)
  }
  let closurePost: FileReceipt[] = []
  let assetPost: z.infer<typeof assetSchema> | null = null
  const artifactPost: FileReceipt[] = []
  const integrityErrors: string[] = []
  let inputPost: FileReceipt | undefined
  let pythonPost: FileReceipt | undefined
  try {
    closurePost = await sourceClosure(root, options.launcherPath)
    assetPost = await modelLock(root, options.assetDirectory)
    for (const entry of native.closure) artifactPost.push(await fileReceipt(entry.path))
    inputPost = await fileReceipt(inputPath)
    pythonPost = await fileReceipt(freeze.python_executable.path)
  } catch (error) {
    integrityErrors.push(error instanceof Error ? error.message : 'H7 postrun verification failed')
  }
  const inputsUnchanged =
    artifactPost.every((entry, index) => entry.sha256 === native.closure[index]?.sha256) &&
    isDeepStrictEqual(inputPost, inputReceipt)
  const consistent =
    integrityErrors.length === 0 &&
    inputsUnchanged &&
    isDeepStrictEqual(pythonPost, freeze.python_executable) &&
    isDeepStrictEqual(closurePost, closure) &&
    isDeepStrictEqual(assetPost, assets)
  const receipt = worker?.receipt
  const run = {
    schema: 'v03-h7-local-semantic-shadow-run-v1',
    status: terminalError || !consistent || receipt?.code !== 0 ? 'incomplete' : 'complete',
    freeze_sha256: freezeReceipt.sha256,
    case_ids: freeze.case_ids,
    rows,
    source_closure_post: closurePost,
    asset_lock_post: assetPost,
    input_artifacts_unchanged: inputsUnchanged,
    worker: {
      pid: receipt?.pid ?? null,
      exit_code: receipt?.code ?? null,
      signal: receipt?.signal ?? null,
      closed: receipt?.closed ?? false,
    },
    runtime: ready?.runtime ?? null,
    elapsed_ms: performance.now() - started,
    error: terminalError instanceof Error ? terminalError.message.slice(0, 500) : null,
    integrity_errors: integrityErrors,
    presence_decision: 'not-a-presence-decision',
  }
  await writeJson(resolve(output, 'postrun-integrity.json'), artifactPost, undefined, true)
  await writeFile(resolve(output, 'worker-stderr.txt'), worker?.stderr ?? '', { flag: 'wx' })
  await writeJson(resolve(output, 'run.json'), run, undefined, true)
  return run
}
