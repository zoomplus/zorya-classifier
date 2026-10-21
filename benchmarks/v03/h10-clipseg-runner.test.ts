import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BENCHMARK_DIR = join(REPOSITORY_ROOT, 'benchmarks/v03')
const RUNNER = join(BENCHMARK_DIR, 'h10-clipseg-runner.py')
const FAKE_WORKER = join(BENCHMARK_DIR, 'h10-clipseg-fake-worker.py')
const SILENT_WORKER = join(BENCHMARK_DIR, 'h10-clipseg-silent-worker.py')
const STDERR_FLOOD_WORKER = join(BENCHMARK_DIR, 'h10-clipseg-stderr-flood-worker.py')
const CONTRACT = join(BENCHMARK_DIR, 'h10-clipseg-producer-contract.json')
const ASSET_LOCK = join(BENCHMARK_DIR, 'h10-clipseg-asset-lock.json')

function resolvePython(): string {
  const fromEnv = process.env.H10_PYTHON_EXECUTABLE?.trim()
  if (!fromEnv) {
    throw new Error('H10_PYTHON_EXECUTABLE is required for H10 offline tests')
  }
  return fromEnv
}

async function resolveAssetsDirectory(): Promise<string> {
  const fromEnv = process.env.H10_CLIPSEG_ASSETS?.trim()
  if (fromEnv) return fromEnv
  const lock = JSON.parse(await readFile(ASSET_LOCK, 'utf8')) as { asset_directory: string }
  return lock.asset_directory
}

async function runRunner(
  python: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(python, [RUNNER, ...args], {
      cwd: BENCHMARK_DIR,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function runRunnerWithSignal(
  python: string,
  args: string[],
  signal: NodeJS.Signals,
  delayMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(python, [RUNNER, ...args], {
      cwd: BENCHMARK_DIR,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill(signal)
    }, delayMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function processAlive(pid: number, python: string): boolean {
  const script = `
import os, sys
pid = int(sys.argv[1])
try:
    os.kill(pid, 0)
except ProcessLookupError:
    sys.exit(1)
sys.exit(0)
`
  const result = spawnSync(python, ['-c', script, String(pid)], { encoding: 'utf8' })
  return result.status === 0
}

function sha256File(path: string, python: string): string {
  const script = `import hashlib; print(hashlib.sha256(open(${JSON.stringify(path)}, "rb").read()).hexdigest())`
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function writeSyntheticPng(
  path: string,
  width: number,
  height: number,
  python: string,
): Promise<void> {
  const script = `
from PIL import Image
image = Image.new("RGB", (${width}, ${height}), (120, 80, 40))
image.save(${JSON.stringify(path)}, format="PNG")
image.close()
`
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

async function buildManifestDirectory(
  python: string,
  options: {
    rows?: number
    leakTruth?: boolean
    sleepFirst?: boolean
    slowFirstRow?: boolean
  } = {},
): Promise<{ directory: string; manifestPath: string; imagePaths: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-h10-manifest-'))
  const imagePaths: string[] = []
  const rows = options.rows ?? 12
  const manifestRows = []
  for (let index = 0; index < rows; index += 1) {
    const imagePath = join(directory, `source-${String(index).padStart(2, '0')}.png`)
    const width = index % 2 === 0 ? 120 : 80
    const height = index % 2 === 0 ? 90 : 140
    await writeSyntheticPng(imagePath, width, height, python)
    imagePaths.push(imagePath)
    const target =
      index === 0 && options.slowFirstRow
        ? '__SLEEP_MS__:120000'
        : index === 11 && options.sleepFirst
          ? '__SLEEP_MS__:5000'
          : index === 1
            ? '__ZERO_BOUNDARY__'
            : index === 2
              ? '__POS_RAMP__'
              : index === 3
                ? '__ALL_NEG__'
                : 'fixture target'
    const row: Record<string, unknown> = {
      row_index: index,
      row_key: `row-${String(index).padStart(2, '0')}`,
      source_path: imagePath,
      source_sha256: sha256File(imagePath, python),
      authored_target: target,
    }
    if (options.leakTruth && index === 0) row.truth = 'leak'
    manifestRows.push(row)
  }
  const manifestPath = join(directory, 'manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify({ schema: 'v03-h10-input-manifest-v1', rows: manifestRows }, null, 2),
    'utf8',
  )
  return { directory, manifestPath, imagePaths }
}

await test('validate-manifest rejects truth leakage and wrong row counts', async () => {
  const python = resolvePython()
  const twelve = await buildManifestDirectory(python)
  const leak = await buildManifestDirectory(python, { leakTruth: true })
  try {
    const ok = await runRunner(python, ['validate-manifest', '--manifest', twelve.manifestPath])
    assert.equal(ok.code, 0)
    const bad = await runRunner(python, ['validate-manifest', '--manifest', leak.manifestPath])
    assert.notEqual(bad.code, 0)
    const short = await buildManifestDirectory(python, { rows: 11 })
    try {
      const shortResult = await runRunner(python, [
        'validate-manifest',
        '--manifest',
        short.manifestPath,
      ])
      assert.notEqual(shortResult.code, 0)
    } finally {
      await rm(short.directory, { recursive: true, force: true })
    }
  } finally {
    await rm(twelve.directory, { recursive: true, force: true })
    await rm(leak.directory, { recursive: true, force: true })
  }
})

await test('verify-assets fails on hash mismatch before model load', async () => {
  const python = resolvePython()
  const directory = await mkdtemp(join(tmpdir(), 'zorya-h10-bad-assets-'))
  try {
    await writeFile(join(directory, 'config.json'), '{}', 'utf8')
    const result = await runRunner(python, ['verify-assets', '--assets', directory])
    assert.notEqual(result.code, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('probe-logits-shape accepts Transformers [1,352,352] batch output', async () => {
  const python = resolvePython()
  const result = await runRunner(python, ['probe-logits-shape'])
  assert.equal(result.code, 0)
  const payload = JSON.parse(result.stdout) as {
    input_shape: number[]
    plane_shape: number[]
  }
  assert.deepEqual(payload.input_shape, [1, 352, 352])
  assert.deepEqual(payload.plane_shape, [352, 352])
})

await test('probe-postprocess includes zero logit boundary as foreground', async () => {
  const python = resolvePython()
  const result = await runRunner(python, ['probe-postprocess', '--width', '64', '--height', '48'])
  assert.equal(result.code, 0)
  const payload = JSON.parse(result.stdout) as {
    results: Array<{ case: string; center_value: number | null; foreground: boolean }>
  }
  const zero = payload.results.find((entry) => entry.case === 'zero_boundary')
  assert.ok(zero)
  assert.equal(zero.center_value, 1)
  const plane = payload.results.find((entry) => entry.case === 'zero_plane')
  assert.ok(plane)
  assert.equal(plane.center_value, 1)
  assert.equal(plane.foreground, true)
  const empty = payload.results.find((entry) => entry.case === 'all_neg')
  assert.ok(empty)
  assert.equal(empty.foreground, false)
})

await test('probe-source rejects source hash mismatch before decode expansion', async () => {
  const python = resolvePython()
  const directory = await mkdtemp(join(tmpdir(), 'zorya-h10-hash-'))
  try {
    const okPath = join(directory, 'ok.png')
    await writeSyntheticPng(okPath, 50, 40, python)
    const mismatch = await runRunner(python, [
      'probe-source',
      '--source',
      okPath,
      '--expected-sha256',
      '0'.repeat(64),
    ])
    assert.notEqual(mismatch.code, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('probe-source enforces byte and oriented pixel bounds', async () => {
  const python = resolvePython()
  const directory = await mkdtemp(join(tmpdir(), 'zorya-h10-bounds-'))
  try {
    const oversizeBytes = join(directory, 'too-large.bin')
    await writeFile(oversizeBytes, Buffer.alloc(25_165_825))
    const byteProbe = await runRunner(python, ['probe-source', '--source', oversizeBytes])
    assert.notEqual(byteProbe.code, 0)

    const widePath = join(directory, 'too-many-pixels.png')
    await writeSyntheticPng(widePath, 2048, 1025, python)
    const pixelProbe = await runRunner(python, ['probe-source', '--source', widePath])
    assert.notEqual(pixelProbe.code, 0)

    const okPath = join(directory, 'ok.png')
    await writeSyntheticPng(okPath, 100, 100, python)
    const okProbe = await runRunner(python, ['probe-source', '--source', okPath])
    assert.equal(okProbe.code, 0)
    const okPayload = JSON.parse(okProbe.stdout) as { width: number; height: number }
    assert.equal(okPayload.width, 100)
    assert.equal(okPayload.height, 100)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('probe-tokenizer rejects overlength targets without truncation', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const short = await runRunner(python, [
    'probe-tokenizer',
    '--assets',
    assets,
    '--target',
    'short authored target',
  ])
  assert.equal(short.code, 0)
  const overlong = 'word '.repeat(200)
  const long = await runRunner(python, [
    'probe-tokenizer',
    '--assets',
    assets,
    '--target',
    overlong,
  ])
  assert.notEqual(long.code, 0)
})

await test('silent owned worker times out and still finalizes twelve rows', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-silent-run-'))
  try {
    const result = await runRunner(python, [
      'orchestrate-fake',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      SILENT_WORKER,
      '--case-timeout-seconds',
      '0.35',
    ])
    assert.equal(result.code, 0)
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('stderr flood worker does not deadlock IPC', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-stderr-run-'))
  try {
    const result = await runRunner(python, [
      'orchestrate-fake',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      STDERR_FLOOD_WORKER,
      '--case-timeout-seconds',
      '5',
    ])
    assert.equal(result.code, 0)
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('owned worker receives parent-death signal on Linux', async () => {
  const python = resolvePython()
  const script = `
import os, subprocess, sys, time
worker = ${JSON.stringify(join(BENCHMARK_DIR, 'h10-clipseg-silent-worker.py'))}
launcher_script = '''
import os, subprocess, sys, time
worker = sys.argv[1]
launcher_pid = os.getpid()
env = os.environ.copy()
env["H10_EXPECTED_LAUNCHER_PID"] = str(launcher_pid)
child = subprocess.Popen(
    [sys.executable, worker],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
    env=env,
)
print(child.pid, flush=True)
time.sleep(0.3)
os._exit(0)
'''
launcher = subprocess.Popen([sys.executable, "-c", launcher_script, worker], stdout=subprocess.PIPE, text=True)
worker_pid_line = launcher.stdout.readline().strip()
launcher.wait(timeout=5)
if launcher.returncode != 0 or not worker_pid_line.isdigit():
    sys.exit(2)
worker_pid = int(worker_pid_line)
deadline = time.time() + 3.0
while time.time() < deadline:
    try:
        os.kill(worker_pid, 0)
    except ProcessLookupError:
        sys.exit(0)
    time.sleep(0.1)
sys.exit(3)
`
  const probe = spawnSync(python, ['-c', script], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(probe.status, 0, probe.stderr)
})

await test('owned worker exits when expected launcher pid mismatches', async () => {
  const python = resolvePython()
  const script = `
import os, signal, subprocess, sys, time
worker = ${JSON.stringify(join(BENCHMARK_DIR, 'h10-clipseg-silent-worker.py'))}
env = os.environ.copy()
env["H10_EXPECTED_LAUNCHER_PID"] = "1"
child = subprocess.Popen(
    [sys.executable, worker],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
    env=env,
)
deadline = time.time() + 3.0
while time.time() < deadline:
    code = child.poll()
    if code is not None:
        sys.exit(0 if code != 0 else 4)
    time.sleep(0.05)
try:
    os.kill(child.pid, signal.SIGKILL)
except ProcessLookupError:
    pass
sys.exit(5)
`
  const probe = spawnSync(python, ['-c', script], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(probe.status, 0, probe.stderr)
})

await test('prepare-freeze records slow ViTImageProcessor backend in effective_processor', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-processor-backend-'))
  try {
    const result = await runRunner(python, [
      'prepare-freeze',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      FAKE_WORKER,
      '--device',
      'fake',
    ])
    assert.equal(result.code, 0)
    const freeze = JSON.parse(await readFile(join(outputDirectory, 'freeze.json'), 'utf8')) as {
      effective_processor: {
        use_fast: boolean
        image_processor_class: string
        image_processor_module: string
      }
      requested_device: string
    }
    assert.equal(freeze.requested_device, 'fake')
    assert.equal(freeze.effective_processor.use_fast, false)
    assert.equal(freeze.effective_processor.image_processor_class, 'ViTImageProcessor')
    assert.equal(
      freeze.effective_processor.image_processor_module,
      'transformers.models.vit.image_processing_vit',
    )
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('orchestrate-fake finalizes exactly twelve rows and kills slow owned child', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python, { sleepFirst: true })
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-fake-run-'))
  try {
    const started = Date.now()
    const result = await runRunner(python, [
      'orchestrate-fake',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      FAKE_WORKER,
      '--case-timeout-seconds',
      '0.75',
    ])
    assert.equal(result.code, 0)
    assert.ok(Date.now() - started < 30_000)
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
    const rows = lines.map(
      (line) => JSON.parse(line) as { outcome_kind: string; row_index: number },
    )
    assert.deepEqual(
      rows.map((row) => row.row_index),
      Array.from({ length: 12 }, (_, index) => index),
    )
    const last = rows[11]
    assert.ok(last)
    assert.equal(last.outcome_kind, 'technical_error')
    const empty = rows.find((row) => row.outcome_kind === 'unresolved_empty')
    assert.ok(empty)
    const candidate = rows.find((row) => row.outcome_kind === 'candidate')
    assert.ok(candidate)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('asset lock matches producer contract weight pin', async () => {
  const lock = JSON.parse(await readFile(ASSET_LOCK, 'utf8')) as {
    files: Array<{ path: string; sha256: string; bytes: number }>
  }
  const contract = JSON.parse(await readFile(CONTRACT, 'utf8')) as {
    model: { expected_weight_pin: { path: string; sha256: string; bytes: number } }
  }
  const weight = lock.files.find((file) => file.path === 'model.safetensors')
  assert.ok(weight)
  assert.deepEqual(weight, contract.model.expected_weight_pin)
})

await test('external asset manifest records canonical revision receipts', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifestPath = join(
    tmpdir(),
    `zorya-h10-asset-manifest-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}.json`,
  )
  const result = await runRunner(python, [
    'record-external-manifest',
    '--assets',
    assets,
    '--output',
    manifestPath,
  ])
  assert.equal(result.code, 0)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    revision: string
    files: Array<{ path: string; sha256: string; bytes: number }>
  }
  assert.equal(manifest.revision, '999e0328d9e10b484360c477313983f9afdd7050')
  const weight = manifest.files.find((file) => file.path === 'model.safetensors')
  assert.equal(weight?.sha256, 'd00ca85d6b859f9d07b7cfb8ef26fe9771cb275b34c9368f2ecf603139307f55')
  await rm(manifestPath, { force: true })
})

await test('probe-header-cap rejects oversized headers without decoding pixels', async () => {
  const python = resolvePython()
  const directory = await mkdtemp(join(tmpdir(), 'zorya-h10-header-cap-'))
  try {
    const widePath = join(directory, 'too-many-pixels.png')
    await writeSyntheticPng(widePath, 2048, 1025, python)
    const reject = await runRunner(python, ['probe-header-cap', '--source', widePath])
    assert.notEqual(reject.code, 0)
    const okPath = join(directory, 'ok.png')
    await writeSyntheticPng(okPath, 100, 100, python)
    const accept = await runRunner(python, ['probe-header-cap', '--source', okPath])
    assert.equal(accept.code, 0)
    const payload = JSON.parse(accept.stdout) as { decoded: boolean }
    assert.equal(payload.decoded, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('prepare-freeze refuses to overwrite an existing freeze.json', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-freeze-overwrite-'))
  try {
    const commonArgs = [
      'prepare-freeze',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      FAKE_WORKER,
      '--device',
      'fake',
    ]
    const first = await runRunner(python, commonArgs)
    assert.equal(first.code, 0)
    const second = await runRunner(python, commonArgs)
    assert.notEqual(second.code, 0)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('prepare-freeze then run binds freeze closure and completes twelve fake rows', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-freeze-run-'))
  try {
    const freezeResult = await runRunner(python, [
      'prepare-freeze',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      FAKE_WORKER,
      '--device',
      'fake',
    ])
    assert.equal(freezeResult.code, 0)
    const freezePath = join(outputDirectory, 'freeze.json')
    const freezeShaBefore = sha256File(freezePath, python)
    const freezeRecord = JSON.parse(await readFile(freezePath, 'utf8')) as {
      requested_device: string
      worker_script_path: string
      runner_script_path: string
      common_script_path: string
    }
    assert.equal(freezeRecord.requested_device, 'fake')
    assert.equal(freezeRecord.worker_script_path, FAKE_WORKER)
    const runResult = await runRunner(python, [
      'run',
      '--run',
      '--freeze',
      freezePath,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      FAKE_WORKER,
      '--device',
      'fake',
    ])
    assert.equal(runResult.code, 0)
    assert.equal(sha256File(freezePath, python), freezeShaBefore)
    const runRecord = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8')) as {
      status: string
      freeze_sha256: string
      row_count: number
    }
    assert.equal(runRecord.status, 'completed')
    assert.equal(runRecord.freeze_sha256, freezeShaBefore)
    assert.equal(runRecord.row_count, 12)
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('INIT_WRITE_FAILURE still runs worker cleanup and preserves twelve INIT errors', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-init-write-fail-'))
  try {
    const started = Date.now()
    const result = await runRunner(
      python,
      [
        'orchestrate-fake',
        '--manifest',
        manifest.manifestPath,
        '--assets',
        assets,
        '--contract',
        CONTRACT,
        '--output',
        outputDirectory,
        '--python',
        python,
        '--worker',
        FAKE_WORKER,
      ],
      { H10_TEST_FORCE_INIT_WRITE_FAILURE: '1' },
    )
    assert.equal(result.code, 0)
    assert.ok(
      Date.now() - started < 10_000,
      'INIT_WRITE_FAILURE fixture must not block on init read',
    )
    const runRecord = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8')) as {
      status: string
      worker_pid: number | null
    }
    assert.equal(runRecord.status, 'completed_with_technical_errors')
    assert.ok(typeof runRecord.worker_pid === 'number')
    assert.equal(processAlive(runRecord.worker_pid as number, python), false)
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
    for (const line of lines) {
      const row = JSON.parse(line) as { error_code: string }
      assert.equal(row.error_code, 'INIT_WRITE_FAILURE')
    }
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('INIT_WRITE_FAILURE with forced cleanup failure keeps INIT rows and reports worker_cleanup_failed', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-init-write-cleanup-'))
  try {
    const started = Date.now()
    const result = await runRunner(
      python,
      [
        'orchestrate-fake',
        '--manifest',
        manifest.manifestPath,
        '--assets',
        assets,
        '--contract',
        CONTRACT,
        '--output',
        outputDirectory,
        '--python',
        python,
        '--worker',
        FAKE_WORKER,
      ],
      {
        H10_TEST_FORCE_INIT_WRITE_FAILURE: '1',
        H10_TEST_FORCE_CLEANUP_FAILURE: '1',
      },
    )
    assert.notEqual(result.code, 0)
    assert.ok(Date.now() - started < 10_000)
    const runRecord = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8')) as {
      status: string
    }
    assert.equal(runRecord.status, 'worker_cleanup_failed')
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
    for (const line of lines) {
      const row = JSON.parse(line) as { error_code: string }
      assert.equal(row.error_code, 'INIT_WRITE_FAILURE')
    }
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('stalled stderr drainer fails cleanup within bounded join', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-stderr-stall-'))
  try {
    const result = await runRunner(
      python,
      [
        'orchestrate-fake',
        '--manifest',
        manifest.manifestPath,
        '--assets',
        assets,
        '--contract',
        CONTRACT,
        '--output',
        outputDirectory,
        '--python',
        python,
        '--worker',
        FAKE_WORKER,
      ],
      {
        H10_TEST_STALL_STDERR_DRAIN: '1',
        H10_WORKER_JOIN_TIMEOUT_SECONDS: '0.35',
      },
    )
    assert.notEqual(result.code, 0)
    const runRecord = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8')) as {
      status: string
    }
    assert.equal(runRecord.status, 'worker_cleanup_failed')
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
    const first = JSON.parse(lines[0] ?? '{}') as { outcome_kind: string }
    assert.equal(first.outcome_kind, 'candidate')
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('orchestrate-fake refuses to start when prior run artifacts exist', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-prior-artifacts-'))
  try {
    const first = await runRunner(python, [
      'orchestrate-fake',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      FAKE_WORKER,
    ])
    assert.equal(first.code, 0)
    const runJsonPath = join(outputDirectory, 'run.json')
    const runShaBefore = sha256File(runJsonPath, python)
    const second = await runRunner(python, [
      'orchestrate-fake',
      '--manifest',
      manifest.manifestPath,
      '--assets',
      assets,
      '--contract',
      CONTRACT,
      '--output',
      outputDirectory,
      '--python',
      python,
      '--worker',
      FAKE_WORKER,
    ])
    assert.notEqual(second.code, 0)
    assert.match(second.stderr, /run\.json or rows\.jsonl already exists/)
    assert.equal(sha256File(runJsonPath, python), runShaBefore)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('producer contract matches loaded processor and row hash field names', async () => {
  const contract = JSON.parse(await readFile(CONTRACT, 'utf8')) as {
    processor: { class: string }
    model_conditioning_payload: { fields: string[] }
    row_output: { required_fields: string[] }
  }
  assert.equal(contract.processor.class, 'CLIPSegProcessor')
  assert.deepEqual(contract.model_conditioning_payload.fields, [
    'oriented_source_rgb',
    'authored_target_string',
  ])
  assert.ok(contract.row_output.required_fields.includes('source_sha256'))
  assert.ok(contract.row_output.required_fields.includes('oriented_rgb_sha256'))
  assert.equal(contract.row_output.required_fields.includes('oriented_source_sha256'), false)
})

await test('forced worker cleanup failure reports worker_cleanup_failed with twelve rows', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-cleanup-fail-'))
  try {
    const result = await runRunner(
      python,
      [
        'orchestrate-fake',
        '--manifest',
        manifest.manifestPath,
        '--assets',
        assets,
        '--contract',
        CONTRACT,
        '--output',
        outputDirectory,
        '--python',
        python,
        '--worker',
        FAKE_WORKER,
      ],
      { H10_TEST_FORCE_CLEANUP_FAILURE: '1' },
    )
    assert.notEqual(result.code, 0)
    const runRecord = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8')) as {
      status: string
    }
    assert.equal(runRecord.status, 'worker_cleanup_failed')
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('SIGINT cancels a slow owned worker, closes output, and reaps the child', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python, { slowFirstRow: true })
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-sigint-'))
  try {
    const result = await runRunnerWithSignal(
      python,
      [
        'orchestrate-fake',
        '--manifest',
        manifest.manifestPath,
        '--assets',
        assets,
        '--contract',
        CONTRACT,
        '--output',
        outputDirectory,
        '--python',
        python,
        '--worker',
        FAKE_WORKER,
        '--case-timeout-seconds',
        '120',
      ],
      'SIGINT',
      1500,
    )
    assert.equal(result.code, 0)
    const runRecord = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8')) as {
      status: string
      worker_pid: number | null
    }
    assert.equal(runRecord.status, 'cancelled')
    assert.ok(typeof runRecord.worker_pid === 'number')
    assert.equal(processAlive(runRecord.worker_pid as number, python), false)
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

await test('SIGTERM cancels a slow owned worker and reaps the child process group', async () => {
  const python = resolvePython()
  const assets = await resolveAssetsDirectory()
  const manifest = await buildManifestDirectory(python, { slowFirstRow: true })
  const outputDirectory = await mkdtemp(join(tmpdir(), 'zorya-h10-sigterm-'))
  try {
    const result = await runRunnerWithSignal(
      python,
      [
        'orchestrate-fake',
        '--manifest',
        manifest.manifestPath,
        '--assets',
        assets,
        '--contract',
        CONTRACT,
        '--output',
        outputDirectory,
        '--python',
        python,
        '--worker',
        FAKE_WORKER,
        '--case-timeout-seconds',
        '120',
      ],
      'SIGTERM',
      1500,
    )
    assert.equal(result.code, 0)
    const runRecord = JSON.parse(await readFile(join(outputDirectory, 'run.json'), 'utf8')) as {
      status: string
      worker_pid: number | null
    }
    assert.equal(runRecord.status, 'cancelled')
    assert.ok(typeof runRecord.worker_pid === 'number')
    assert.equal(processAlive(runRecord.worker_pid as number, python), false)
    const lines = (await readFile(join(outputDirectory, 'rows.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 12)
  } finally {
    await rm(manifest.directory, { recursive: true, force: true })
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
