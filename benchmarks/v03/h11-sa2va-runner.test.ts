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
const RUNNER = join(BENCHMARK_DIR, 'h11-sa2va-runner.py')
const COMMON = join(BENCHMARK_DIR, 'h11-sa2va-common.py')
const WORKER = join(BENCHMARK_DIR, 'h11-sa2va-worker.py')
const CONTRACT = join(BENCHMARK_DIR, 'h11-sa2va-contract.json')
const H11B_CONTRACT = join(BENCHMARK_DIR, 'h11b-sa2va-direct-gpu-contract.json')
const H11B_CONTRACT_SHA = 'ee623e58181f5db22d77720760438b0b34342c708a9f5f99037446d4d3846908'
const H11_LEGACY_CONTRACT_SHA = '14281b417d8fc2838cd52ff6bf05cb63aae493bc9968b5a4f20b6b482d58ccdd'
const H10_COMMON = join(BENCHMARK_DIR, 'h10-clipseg-common.py')
const MINIMAL_MANIFEST = '/root/work/zorya-classifier/.run/v03/h10/minimal-inputs.json'
const MINIMAL_MANIFEST_SHA = '98e8a5e767a6604a02fec0e561fa1b0128cb76783e4a405df4cb96e4b75fd084'

function resolvePython(): string {
  const fromEnv = process.env.H11_PYTHON_EXECUTABLE?.trim()
  if (!fromEnv) {
    throw new Error('H11_PYTHON_EXECUTABLE is required for H11 offline tests')
  }
  return fromEnv
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

function runPythonScript(
  python: string,
  script: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(python, ['-c', script], {
    cwd: BENCHMARK_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONPATH: process.env.PYTHONPATH ?? '',
    },
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
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
    leakH10?: boolean
    duplicateIndex?: boolean
  } = {},
): Promise<{ directory: string; manifestPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'zorya-h11-manifest-'))
  const rows = options.rows ?? 12
  const manifestRows = []
  for (let index = 0; index < rows; index += 1) {
    const imagePath = join(directory, `source-${String(index).padStart(2, '0')}.png`)
    await writeSyntheticPng(imagePath, 80 + index, 60 + index, python)
    const row: Record<string, unknown> = {
      row_index: options.duplicateIndex && index === 1 ? 0 : index,
      row_key: `row-${String(index).padStart(2, '0')}`,
      source_path: imagePath,
      source_sha256: sha256File(imagePath, python),
      authored_target: `target ${index}`,
    }
    if (options.leakTruth && index === 0) row.truth = 'leak'
    if (options.leakH10 && index === 0) row.h10_output = 'leak'
    manifestRows.push(row)
  }
  const manifestPath = join(directory, 'manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify({ schema: 'v03-h10-input-manifest-v1', rows: manifestRows }, null, 2),
    'utf8',
  )
  return { directory, manifestPath }
}

await test('validate-manifest rejects truth, h10_output, wrong counts, and minimal SHA mismatch', async () => {
  const python = resolvePython()
  const twelve = await buildManifestDirectory(python)
  const leakTruth = await buildManifestDirectory(python, { leakTruth: true })
  const leakH10 = await buildManifestDirectory(python, { leakH10: true })
  const dup = await buildManifestDirectory(python, { duplicateIndex: true })
  try {
    const ok = await runRunner(python, [
      'validate-manifest',
      '--manifest',
      twelve.manifestPath,
      '--contract',
      CONTRACT,
    ])
    assert.equal(ok.code, 0)
    for (const badManifest of [leakTruth.manifestPath, leakH10.manifestPath, dup.manifestPath]) {
      const bad = await runRunner(python, [
        'validate-manifest',
        '--manifest',
        badManifest,
        '--contract',
        CONTRACT,
      ])
      assert.notEqual(bad.code, 0, badManifest)
    }
    const short = await buildManifestDirectory(python, { rows: 11 })
    try {
      const shortResult = await runRunner(python, [
        'validate-manifest',
        '--manifest',
        short.manifestPath,
        '--contract',
        CONTRACT,
      ])
      assert.notEqual(shortResult.code, 0)
    } finally {
      await rm(short.directory, { recursive: true, force: true })
    }
    const tamperedDir = await mkdtemp(join(tmpdir(), 'zorya-h11-minimal-tamper-'))
    try {
      const tamperedPath = join(tamperedDir, 'minimal.json')
      await writeFile(tamperedPath, '{"schema":"v03-h10-input-manifest-v1","rows":[]}\n', 'utf8')
      const wrongSha = await runRunner(python, [
        'validate-manifest',
        '--manifest',
        MINIMAL_MANIFEST,
        '--contract',
        CONTRACT,
      ])
      assert.equal(wrongSha.code, 0)
      const digest = createHash('sha256')
        .update(await readFile(MINIMAL_MANIFEST))
        .digest('hex')
      assert.equal(digest, MINIMAL_MANIFEST_SHA)
      const badMinimal = await runRunner(python, [
        'validate-manifest',
        '--manifest',
        tamperedPath,
        '--contract',
        CONTRACT,
      ])
      assert.notEqual(badMinimal.code, 0)
    } finally {
      await rm(tamperedDir, { recursive: true, force: true })
    }
  } finally {
    await rm(twelve.directory, { recursive: true, force: true })
    await rm(leakTruth.directory, { recursive: true, force: true })
    await rm(leakH10.directory, { recursive: true, force: true })
    await rm(dup.directory, { recursive: true, force: true })
  }
})

await test('verify-assets fails closed on tampered mini fixture before model load', async () => {
  const python = resolvePython()
  const directory = await mkdtemp(join(tmpdir(), 'zorya-h11-bad-assets-'))
  try {
    await writeFile(join(directory, 'config.json'), '{}', 'utf8')
    const result = await runRunner(python, [
      'verify-assets',
      '--assets',
      directory,
      '--contract',
      CONTRACT,
    ])
    assert.notEqual(result.code, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('generate interceptor enforces 128 greedy tokens and records truncation', () => {
  const python = resolvePython()
  const script = `
import importlib.util, sys, torch
from pathlib import Path
spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

calls = []
def fake_generate(*args, **kwargs):
    calls.append(dict(kwargs))
    input_ids = kwargs["input_ids"]
    in_len = int(input_ids.shape[-1])
    out = torch.cat([input_ids, torch.ones((1, mod.GENERATION_MAX_NEW_TOKENS), dtype=torch.long)], dim=1)
    class Out:
        sequences = out
    return Out()

inner, recorder = mod.wrap_generate_callable(fake_generate, eos_token_id=999, input_length=3)
inner.generate(input_ids=torch.ones((1, 3), dtype=torch.long))
assert calls[0]["max_new_tokens"] == 128
assert calls[0]["do_sample"] is False
gen = recorder["generation"]
assert gen.token_count == mod.GENERATION_MAX_NEW_TOKENS
assert gen.truncated is True
diag = mod.generation_record_to_diagnostics(gen)
assert diag["actual_max_new_tokens_applied"] == calls[0]["max_new_tokens"]
assert diag["do_sample_applied"] is calls[0]["do_sample"]
assert diag["generated_token_count"] == mod.GENERATION_MAX_NEW_TOKENS
assert diag["stopped_on_eos"] is False
print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /ok/)
})

await test('first-nonempty mask emission ordering ignores prediction text', () => {
  const python = resolvePython()
  const script = `
import importlib.util, numpy as np, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

tmpdir = Path(tempfile.mkdtemp(prefix="h11-mask-order-"))
masks_dir = tmpdir / "masks"
height, width = 4, 5
empty = np.zeros((1, height, width), dtype=np.uint8)
nonempty = np.zeros((1, height, width), dtype=np.uint8)
nonempty[0, 1, 2] = 1
candidates, selected, bounds = mod.retain_native_masks(
    [empty, nonempty], height=height, width=width, masks_dir=masks_dir, row_key="case-a"
)
assert selected == 1
assert bounds == {"x_min": 2, "y_min": 1, "x_max": 2, "y_max": 1}
assert (tmpdir / "masks/case-a/mask.u8").is_file()
print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr)
})

await test('mask plane validation rejects alpha, multichannel, nonbinary, and bad shapes', () => {
  const python = resolvePython()
  const script = `
import importlib.util, numpy as np, sys
spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

def expect_fail(fn):
    try:
        fn()
    except mod.H11Error:
        return
    raise AssertionError("expected H11Error")

expect_fail(lambda: mod.mask_plane_to_u8(np.zeros((2, 3, 3), dtype=np.uint8), 3, 3))
expect_fail(lambda: mod.mask_plane_to_u8(np.zeros((1, 2, 2), dtype=np.uint8), 3, 3))
expect_fail(lambda: mod.mask_plane_to_u8(np.full((1, 2, 2), 2, dtype=np.uint8), 2, 2))
expect_fail(lambda: mod.mask_plane_to_u8(np.zeros((1, 2, 2), dtype=np.float32), 2, 2))
good = np.zeros((1, 2, 2), dtype=np.uint8)
good[0, 0, 1] = 1
plane = mod.mask_plane_to_u8(good, 2, 2)
assert plane.tobytes() == bytes([0, 1, 0, 0])
print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr)
})

await test('mask retention enforces eight-mask and sixteen-mib caps', () => {
  const python = resolvePython()
  const script = `
import importlib.util, numpy as np, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

tmpdir = Path(tempfile.mkdtemp(prefix="h11-mask-cap-"))
masks_dir = tmpdir / "masks"
height, width = 2, 2
nine = [np.zeros((1, height, width), dtype=np.uint8) for _ in range(9)]
try:
    mod.retain_native_masks(nine, height=height, width=width, masks_dir=masks_dir, row_key="cap")
except mod.H11Error:
    pass
else:
    raise AssertionError("expected mask count cap failure")
huge = np.zeros((1, 4097, 4097), dtype=np.uint8)
try:
    mod.retain_native_masks([huge], height=4097, width=4097, masks_dir=masks_dir, row_key="bytes")
except mod.H11Error:
    pass
else:
    raise AssertionError("expected byte cap failure")
print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr)
})

await test('H11 normalization strips H10-only metadata and preserves manifest source sha on technical rows', () => {
  const python = resolvePython()
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

manifest_row = {
    "row_index": 0,
    "row_key": "row-00",
    "authored_target": "widget",
    "source_sha256": "a" * 64,
}
raw = {
    "type": "row",
    "row_index": 0,
    "row_key": "row-00",
    "authored_target": "widget",
    "outcome_kind": "technical_error",
    "interpolate_pos_encoding": True,
    "prep_ms": 1.0,
    "forward_ms": 2.0,
    "post_ms": 3.0,
    "model_max_length": 4096,
    "wall_ms": 42.5,
    "peak_vram_allocated_bytes": 1000,
    "peak_vram_reserved_bytes": 2000,
    "generation_diagnostics": None,
    "error_code": "INIT_FAILURE",
    "error_message": "boom",
}
normalized = mod.normalize_terminal_row(raw, manifest_row)
for h10_key in ("interpolate_pos_encoding", "prep_ms", "forward_ms", "post_ms", "model_max_length", "type"):
    assert h10_key not in normalized, h10_key
assert normalized["source_sha256"] == manifest_row["source_sha256"]
assert normalized["candidate_masks"] == []
assert normalized["wall_ms"] == 42.5
assert normalized["peak_vram_allocated_bytes"] == 1000
assert normalized["peak_vram_reserved_bytes"] == 2000
assert normalized["generation_diagnostics"] is None
shell = mod.empty_row_shell(manifest_row)
assert shell["wall_ms"] is None
assert shell["peak_vram_allocated_bytes"] is None
assert shell["peak_vram_reserved_bytes"] is None
assert shell["generation_diagnostics"] is None
print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr)
})

await test('cuda_runtime_details child source keeps loader work outside the spec guard', async () => {
  const python = resolvePython()
  const script = `
import ast, importlib.util, sys
from pathlib import Path

COMMON = Path(${JSON.stringify(COMMON)})
H10_COMMON = Path(${JSON.stringify(H10_COMMON)})

spec = importlib.util.spec_from_file_location("h11_cuda_child_ast", COMMON)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

child_source = mod._cuda_runtime_details_child_source()
compile(child_source, "<cuda_runtime_details_child>", "exec")
module = ast.parse(child_source)

def stmt_text(node: ast.AST) -> str:
    return ast.get_source_segment(child_source, node) or ""

if_nodes = [node for node in module.body if isinstance(node, ast.If)]
assert len(if_nodes) == 1, "child source must have a single spec guard"
guard = if_nodes[0]
assert len(guard.body) == 1 and isinstance(guard.body[0], ast.Raise), guard.body
assert guard.orelse == []

guard_index = module.body.index(guard)
after_guard = module.body[guard_index + 1 :]
joined_after = "\\n".join(stmt_text(node) for node in after_guard)
assert "module_from_spec" in joined_after
assert "exec_module" in joined_after
assert "cuda_runtime_details" in joined_after

after_texts = [stmt_text(node) for node in after_guard]
mod_from_idx = next(i for i, t in enumerate(after_texts) if "module_from_spec" in t)
sys_mod_idx = next(
    i for i, t in enumerate(after_texts) if "sys.modules" in t and "spec.name" in t
)
exec_idx = next(i for i, t in enumerate(after_texts) if "exec_module" in t)
assert mod_from_idx < sys_mod_idx < exec_idx, after_texts

buggy = (
    "import importlib.util, json, sys; "
    f"p = {repr(str(H10_COMMON.resolve()))}; "
    "spec = importlib.util.spec_from_file_location('h10_cuda_runtime_probe', p); "
    "if spec is None or spec.loader is None: "
    "raise RuntimeError('cuda probe child failed to load h10 common'); "
    "mod = importlib.util.module_from_spec(spec); "
    "spec.loader.exec_module(mod); "
    "sys.stdout.write(json.dumps(mod.cuda_runtime_details()))"
)
try:
    ast.parse(buggy)
except SyntaxError:
    pass
else:
    raise AssertionError("semicolon-packed module-level if must be invalid syntax")

nested_bug = (
    "if True: "
    "raise RuntimeError('cuda probe child failed to load h10 common'); "
    "mod = importlib.util.module_from_spec(spec)"
)
nested_module = ast.parse(nested_bug)
nested_if = next(node for node in nested_module.body if isinstance(node, ast.If))
assert len(nested_if.body) > 1, "semicolon one-liner incorrectly nests loader work under the guard"

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})

await test('cuda_runtime_details probes CUDA metadata in a short-lived child only', async () => {
  const python = resolvePython()
  const script = `
import importlib.util, json, subprocess, sys
from pathlib import Path
from unittest.mock import patch

COMMON = Path(${JSON.stringify(COMMON)})
H10_COMMON = Path(${JSON.stringify(H10_COMMON)})

spec = importlib.util.spec_from_file_location("h11_cuda_probe", COMMON)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

def forbid_h10_cuda_probe(*args, **kwargs):
    raise AssertionError("parent must not call h10.cuda_runtime_details")

mod.h10.cuda_runtime_details = forbid_h10_cuda_probe

probe_calls: list[tuple[list[str], dict]] = []

class Completed:
    def __init__(self, stdout) -> None:
        self.stdout = stdout
        self.stderr = ""

def record_run(argv, **kwargs):
    probe_calls.append((list(argv), dict(kwargs)))
    return Completed(json.dumps({"cuda_available": False}))

def expect_h11_error(fn):
    try:
        fn()
    except mod.H11Error:
        return
    raise AssertionError("expected H11Error")

with patch.object(subprocess, "run", side_effect=record_run):
    false_only = mod.cuda_runtime_details()
assert false_only == {"cuda_available": False}

argv, kwargs = probe_calls[-1]
assert argv[0] == sys.executable
assert argv[1] == "-c"
assert str(H10_COMMON.resolve()) in argv[2]
assert kwargs.get("capture_output") is True
assert kwargs.get("text") is True
assert kwargs.get("check") is True
assert kwargs.get("timeout") == mod.CUDA_RUNTIME_PROBE_TIMEOUT_SECONDS

true_payload = {
    "cuda_available": True,
    "cuda_device_index": 0,
    "cuda_device_name": "fixture GPU",
    "cuda_version": "12.4",
}

def record_true(argv, **kwargs):
    probe_calls.append((list(argv), dict(kwargs)))
    return Completed(json.dumps(true_payload))

with patch.object(subprocess, "run", side_effect=record_true):
    true_details = mod.cuda_runtime_details()
assert true_details == true_payload

def raise_timeout(*args, **kwargs):
    raise subprocess.TimeoutExpired(cmd=args[0] if args else [], timeout=1)

with patch.object(subprocess, "run", side_effect=raise_timeout):
    expect_h11_error(mod.cuda_runtime_details)

def raise_nonzero(*args, **kwargs):
    raise subprocess.CalledProcessError(1, args[0] if args else [])

with patch.object(subprocess, "run", side_effect=raise_nonzero):
    expect_h11_error(mod.cuda_runtime_details)

def bad_json(*args, **kwargs):
    return Completed("not-json")

with patch.object(subprocess, "run", side_effect=bad_json):
    expect_h11_error(mod.cuda_runtime_details)

def missing_flag(*args, **kwargs):
    return Completed(json.dumps({"cuda_device_index": 0}))

with patch.object(subprocess, "run", side_effect=missing_flag):
    expect_h11_error(mod.cuda_runtime_details)

def non_bool_flag(*args, **kwargs):
    return Completed(json.dumps({"cuda_available": "yes"}))

with patch.object(subprocess, "run", side_effect=non_bool_flag):
    expect_h11_error(mod.cuda_runtime_details)

def non_dict(*args, **kwargs):
    return Completed(json.dumps([{"cuda_available": True}]))

with patch.object(subprocess, "run", side_effect=non_dict):
    expect_h11_error(mod.cuda_runtime_details)

def raise_oserror(*args, **kwargs):
    raise OSError("launch blocked")

with patch.object(subprocess, "run", side_effect=raise_oserror):
    expect_h11_error(mod.cuda_runtime_details)

def non_string_stdout(*args, **kwargs):
    return Completed(None)

with patch.object(subprocess, "run", side_effect=non_string_stdout):
    expect_h11_error(mod.cuda_runtime_details)

def oversize_stdout(*args, **kwargs):
    payload = "x" * (mod.CUDA_RUNTIME_PROBE_MAX_STDOUT_BYTES + 1)
    return Completed(payload)

with patch.object(subprocess, "run", side_effect=oversize_stdout):
    expect_h11_error(mod.cuda_runtime_details)

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})

await test('owned worker bootstrap requires Linux parent-death guard before imports', async () => {
  const python = resolvePython()
  const script = `
import os, subprocess, sys, textwrap
worker = ${JSON.stringify(WORKER)}
env = os.environ.copy()
env.pop("H10_EXPECTED_LAUNCHER_PID", None)
proc = subprocess.run([sys.executable, worker], input=b"", capture_output=True, env=env)
assert proc.returncode != 0
print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr)
})

await test('verify_sam2_runtime uses nested sam2_model, pinned sam2.py AST, and compile markers', async () => {
  const python = resolvePython()
  const script = `
import hashlib, importlib.util, json, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

GOOD_SAM2_SOURCE = '''
class SAM2VideoPredictor:
    def __init__(self, fill_hole_area=0):
        self.fill_hole_area = fill_hole_area

class SAM2:
    def __init__(self):
        SAM2VideoPredictor(compile_image_encoder=False)
'''

BAD_FILL_DEFAULT = '''
class SAM2VideoPredictor:
    def __init__(self, fill_hole_area=1):
        pass

class SAM2:
    def __init__(self):
        SAM2VideoPredictor(compile_image_encoder=False)
'''

BAD_COMPILE_KW = '''
class SAM2VideoPredictor:
    def __init__(self, fill_hole_area=0):
        pass

class SAM2:
    def __init__(self):
        SAM2VideoPredictor(compile_image_encoder=True)
'''

def contract_for_source(source: str) -> dict:
    payload = source.encode("utf-8")
    return {
        "required_model_files": [
            {
                "path": "sam2.py",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "bytes": len(payload),
            }
        ]
    }

def write_asset(source: str) -> tuple[Path, dict]:
    directory = Path(tempfile.mkdtemp(prefix="h11-sam2-guard-"))
    (directory / "sam2.py").write_text(source, encoding="utf-8")
    return directory, contract_for_source(source)

class ImageEncoder:
    def __init__(self, compiled=False):
        self._compiled = compiled
    def forward(self):
        return None

class Sam2Model:
    def __init__(self, fill_hole_area=0, compiled_encoder=False):
        self.fill_hole_area = fill_hole_area
        enc = ImageEncoder(compiled=compiled_encoder)
        if compiled_encoder:
            enc._orig_mod = object()
        self.image_encoder = enc

class GroundingEncoder:
    def __init__(self, sam2_model):
        self.sam2_model = sam2_model

def model_with(asset_dir: Path, sam2_model) -> object:
    return type(
        "FakeSa2VA",
        (),
        {"grounding_encoder": GroundingEncoder(sam2_model), "name_or_path": str(asset_dir)},
    )()

def expect_fail(fn):
    try:
        fn()
    except mod.H11Error:
        return
    raise AssertionError("expected H11Error")

asset_dir, contract = write_asset(GOOD_SAM2_SOURCE)
try:
    attestation = mod.attest_pinned_sam2_source(GOOD_SAM2_SOURCE)
    assert attestation["sam2_init_calls_sam2_video_predictor_compile_false"] is True
    assert attestation["sam2_video_predictor_fill_hole_area_default_zero"] is True

    pinned = mod.verify_pinned_sam2_asset(asset_dir, contract)
    assert pinned["sha256"] == contract["required_model_files"][0]["sha256"]
    assert pinned["bytes"] == contract["required_model_files"][0]["bytes"]

    sam2_model = Sam2Model(fill_hole_area=0)
    ok = mod.verify_sam2_runtime(model_with(asset_dir, sam2_model), asset_dir=asset_dir, contract=contract)
    assert ok["runtime_evidence"]["fill_hole_area"] == 0
    assert ok["runtime_evidence"]["compiled_wrapper_markers_absent"] is True
    assert ok["source_evidence"]["compile_image_encoder_false_from_pinned_sam2_py"] is True
    assert ok["runtime_evidence"]["grounding_encoder_compile_image_encoder_attr_present"] is False

    wrapper_only = Sam2Model(fill_hole_area=0)
    nested_ok = mod.verify_sam2_runtime(
        model_with(asset_dir, wrapper_only), asset_dir=asset_dir, contract=contract
    )
    assert nested_ok["runtime_evidence"]["predictor_path"] == "grounding_encoder.sam2_model"

    missing_fill = Sam2Model()
    del missing_fill.fill_hole_area
    expect_fail(
        lambda: mod.verify_sam2_runtime(
            model_with(asset_dir, missing_fill), asset_dir=asset_dir, contract=contract
        )
    )

    compiled = Sam2Model(fill_hole_area=0, compiled_encoder=True)
    expect_fail(
        lambda: mod.verify_sam2_runtime(
            model_with(asset_dir, compiled), asset_dir=asset_dir, contract=contract
        )
    )

    bad_dir, bad_contract = write_asset(BAD_FILL_DEFAULT)
    try:
        expect_fail(lambda: mod.verify_pinned_sam2_asset(bad_dir, bad_contract))
    finally:
        import shutil
        shutil.rmtree(bad_dir)

    bad_compile_dir, bad_compile_contract = write_asset(BAD_COMPILE_KW)
    try:
        expect_fail(lambda: mod.verify_pinned_sam2_asset(bad_compile_dir, bad_compile_contract))
    finally:
        import shutil
        shutil.rmtree(bad_compile_dir)
finally:
    import shutil
    shutil.rmtree(asset_dir)

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})

await test('build_recipe preserves legacy recipe and adds loader_device_map only for H11b', async () => {
  const python = resolvePython()
  const script = `
import importlib.util, json, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

legacy = mod.build_recipe(requested_device="cuda:0")
baseline = mod.build_recipe(requested_device="cuda:0", contract=None)
assert legacy == baseline
assert "loader_device_map" not in legacy

legacy_contract = json.loads(Path(${JSON.stringify(CONTRACT)}).read_text(encoding="utf-8"))
legacy_with_contract = mod.build_recipe(requested_device="cuda:0", contract=legacy_contract)
assert legacy_with_contract == legacy

h11b_contract = json.loads(Path(${JSON.stringify(H11B_CONTRACT)}).read_text(encoding="utf-8"))
h11b_recipe = mod.build_recipe(requested_device="cuda:0", contract=h11b_contract)
assert h11b_recipe != legacy
assert set(h11b_recipe.keys()) - set(legacy.keys()) == {"loader_device_map"}
assert h11b_recipe["loader_device_map"] == mod.H11B_AUTHORIZED_LOADER_DEVICE_MAP

def expect_fail(fn):
    try:
        fn()
    except mod.H11Error:
        return
    raise AssertionError("expected H11Error")

bad_profile = dict(h11b_contract)
bad_profile["runtime_profile_id"] = "unknown-profile"
expect_fail(lambda: mod.build_recipe(requested_device="cuda:0", contract=bad_profile))

bad_map = dict(h11b_contract)
bad_map["model"] = dict(h11b_contract["model"])
bad_map["model"]["loader"] = dict(h11b_contract["model"]["loader"])
bad_map["model"]["loader"]["from_pretrained"] = dict(
    h11b_contract["model"]["loader"]["from_pretrained"]
)
bad_map["model"]["loader"]["from_pretrained"]["device_map"] = {"": "cuda:1"}
expect_fail(lambda: mod.build_recipe(requested_device="cuda:0", contract=bad_map))

auto_map = dict(h11b_contract)
auto_map["model"] = dict(h11b_contract["model"])
auto_map["model"]["loader"] = dict(h11b_contract["model"]["loader"])
auto_map["model"]["loader"]["from_pretrained"] = dict(
    h11b_contract["model"]["loader"]["from_pretrained"]
)
auto_map["model"]["loader"]["from_pretrained"]["device_map"] = "auto"
expect_fail(lambda: mod.build_recipe(requested_device="cuda:0", contract=auto_map))

orphan_map = dict(legacy_contract)
orphan_map["model"] = dict(legacy_contract["model"])
orphan_map["model"]["loader"] = dict(legacy_contract["model"]["loader"])
orphan_map["model"]["loader"]["from_pretrained"] = dict(
    legacy_contract["model"]["loader"]["from_pretrained"]
)
orphan_map["model"]["loader"]["from_pretrained"]["device_map"] = {"": "cuda:0"}
expect_fail(lambda: mod.build_recipe(requested_device="cuda:0", contract=orphan_map))

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
  assert.equal(sha256File(H11B_CONTRACT, python), H11B_CONTRACT_SHA)
  assert.equal(sha256File(CONTRACT, python), H11_LEGACY_CONTRACT_SHA)
})

await test('load_contract whitelists exact legacy and H11b contract bytes only', async () => {
  const python = resolvePython()
  const script = `
import importlib.util, json, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

legacy_path = Path(${JSON.stringify(CONTRACT)})
h11b_path = Path(${JSON.stringify(H11B_CONTRACT)})

legacy = mod.load_contract(legacy_path)
h11b = mod.load_contract(h11b_path)
assert legacy.get("runtime_profile_id") is None or "runtime_profile_id" not in legacy or legacy["runtime_profile_id"] != mod.H11B_RUNTIME_PROFILE_ID
assert h11b["runtime_profile_id"] == mod.H11B_RUNTIME_PROFILE_ID

tampered_dir = Path(tempfile.mkdtemp(prefix="h11-contract-bytes-"))
try:
    tampered_path = tampered_dir / "contract.json"
    raw = legacy_path.read_bytes()
    tampered_path.write_bytes(raw + b" ")
    try:
        mod.load_contract(tampered_path)
    except mod.H11Error as error:
        assert "unsupported H11 producer contract bytes" in str(error)
    else:
        raise AssertionError("expected tampered contract bytes to be rejected")
finally:
    import shutil
    shutil.rmtree(tampered_dir)

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})

await test('runtime profile validation rejects present-null or empty device_map but accepts legacy absence', async () => {
  const python = resolvePython()
  const script = `
import importlib.util, json, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

legacy_contract = json.loads(Path(${JSON.stringify(CONTRACT)}).read_text(encoding="utf-8"))
mod.validate_contract_runtime_profile(legacy_contract)
mod.build_recipe(requested_device="cuda:0", contract=legacy_contract)

h11b_contract = json.loads(Path(${JSON.stringify(H11B_CONTRACT)}).read_text(encoding="utf-8"))
mod.validate_contract_runtime_profile(h11b_contract)
recipe = mod.build_recipe(requested_device="cuda:0", contract=h11b_contract)
assert recipe["loader_device_map"] == mod.H11B_AUTHORIZED_LOADER_DEVICE_MAP

def expect_fail(fn):
    try:
        fn()
    except mod.H11Error:
        return
    raise AssertionError("expected H11Error")

def contract_with_device_map(base: dict, device_map) -> dict:
    out = dict(base)
    model = dict(out.get("model") or {})
    loader = dict(model.get("loader") or {})
    fp = dict(loader.get("from_pretrained") or {})
    fp["device_map"] = device_map
    loader["from_pretrained"] = fp
    model["loader"] = loader
    out["model"] = model
    return out

present_null_map = contract_with_device_map(legacy_contract, None)
expect_fail(lambda: mod.validate_contract_runtime_profile(present_null_map))
expect_fail(lambda: mod.build_recipe(requested_device="cuda:0", contract=present_null_map))

present_empty_map = contract_with_device_map(legacy_contract, {})
expect_fail(lambda: mod.validate_contract_runtime_profile(present_empty_map))

profile_null = dict(h11b_contract)
profile_null["runtime_profile_id"] = None
expect_fail(lambda: mod.validate_contract_runtime_profile(profile_null))
expect_fail(lambda: mod.build_recipe(requested_device="cuda:0", contract=profile_null))

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})

await test('load_stack uses device_map without to() for H11b and legacy to() without device_map (metadata-only FakeTensor offline)', async () => {
  const python = resolvePython()
  const script = `
import hashlib, importlib.util, json, os, sys, tempfile, types
from pathlib import Path
import torch
from torch._subclasses.fake_tensor import FakeTensorMode

_REAL_CUDA_IS_AVAILABLE = torch.cuda.is_available

def offline_metadata_tensor(shape, *, device, dtype):
    # Metadata-only offline: FakeTensor cuda/cpu placement without real CUDA storage.
    patched = torch.cuda.is_available
    try:
        torch.cuda.is_available = _REAL_CUDA_IS_AVAILABLE
        with FakeTensorMode():
            return torch.zeros(shape, device=device, dtype=dtype)
    finally:
        torch.cuda.is_available = patched

def offline_metadata_parameter(shape, *, device="cuda:0", dtype=torch.bfloat16):
    patched = torch.cuda.is_available
    try:
        torch.cuda.is_available = _REAL_CUDA_IS_AVAILABLE
        with FakeTensorMode():
            return torch.nn.Parameter(torch.zeros(shape, device=device, dtype=dtype))
    finally:
        torch.cuda.is_available = patched

os.environ["H10_EXPECTED_LAUNCHER_PID"] = str(os.getppid())

BENCHMARK = Path(${JSON.stringify(BENCHMARK_DIR)})
COMMON = BENCHMARK / "h11-sa2va-common.py"
WORKER = BENCHMARK / "h11-sa2va-worker.py"
H11B_CONTRACT = Path(${JSON.stringify(H11B_CONTRACT)})
LEGACY_CONTRACT = Path(${JSON.stringify(CONTRACT)})

def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod

h11 = load_module(COMMON, "h11_loader_common")
worker = load_module(WORKER, "h11_loader_worker")

GOOD_SAM2 = '''
class SAM2VideoPredictor:
    def __init__(self, fill_hole_area=0):
        self.fill_hole_area = fill_hole_area

class SAM2:
    def __init__(self):
        SAM2VideoPredictor(compile_image_encoder=False)
'''

def sam2_contract(source: str) -> dict:
    payload = source.encode("utf-8")
    return {
        "required_model_files": [
            {"path": "sam2.py", "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}
        ]
    }

class ImageEncoder:
    def forward(self):
        return None

class Sam2Runtime:
    def __init__(self):
        self.fill_hole_area = 0
        self.image_encoder = ImageEncoder()

class GroundingEncoder:
    def __init__(self, sam2_model):
        self.sam2_model = sam2_model

class Sa2VAChatConfigQwen:
    def __init__(self):
        self._attn_implementation = "eager"
        self.use_flash_attn = False

class Sa2VAChatModelQwen(torch.nn.Module):
    def __init__(self, *, direct: bool, asset_dir: Path):
        super().__init__()
        self.config = Sa2VAChatConfigQwen()
        self.grounding_encoder = GroundingEncoder(Sam2Runtime())
        self.name_or_path = str(asset_dir)
        self.hf_device_map = {"": "cuda:0"}
        self._direct = direct
        self._device_storage = torch.device("cpu")
        self.weight = offline_metadata_parameter(2)
        self.register_buffer("buf", offline_metadata_tensor(2, device="cuda:0", dtype=torch.int32))

    def eval(self):
        return self

    def to(self, device):
        if self._direct:
            raise AssertionError("h11b load must not call model.to")
        self._device_storage = torch.device(device)
        return self

class Qwen2VLImageProcessor:
    pass

class Qwen3VLProcessor:
    def __init__(self):
        self.image_processor = Qwen2VLImageProcessor()
        self.tokenizer = types.SimpleNamespace(eos_token_id=2)

Qwen3VLProcessor.__module__ = "transformers.models.qwen3_vl.processing_qwen3_vl"
Qwen2VLImageProcessor.__module__ = "transformers.models.qwen2_vl.image_processing_qwen2_vl"

from_pretrained_calls: list[dict] = []

def fake_processor_from_pretrained(*args, **kwargs):
    return Qwen3VLProcessor()

def fake_model_from_pretrained(*args, **kwargs):
    from_pretrained_calls.append(dict(kwargs))
    direct = "device_map" in kwargs
    return Sa2VAChatModelQwen(direct=direct, asset_dir=Path(args[0]))

asset_dir = Path(tempfile.mkdtemp(prefix="h11-loader-"))
(asset_dir / "sam2.py").write_text(GOOD_SAM2, encoding="utf-8")
local_contract = sam2_contract(GOOD_SAM2)
original_verify_assets = h11.verify_asset_directory
h11.verify_asset_directory = lambda directory, c: {"sam2.py": {"sha256": local_contract["required_model_files"][0]["sha256"], "bytes": local_contract["required_model_files"][0]["bytes"]}}

import transformers
transformers.AutoProcessor.from_pretrained = fake_processor_from_pretrained
transformers.AutoModel.from_pretrained = fake_model_from_pretrained

if not torch.cuda.is_available():
    torch.cuda.is_available = lambda: True

legacy_contract = json.loads(LEGACY_CONTRACT.read_text(encoding="utf-8"))
legacy_contract = {**legacy_contract, **local_contract}
h11b_contract = json.loads(H11B_CONTRACT.read_text(encoding="utf-8"))
h11b_contract = {**h11b_contract, **local_contract}

try:
    from_pretrained_calls.clear()
    worker.load_stack(asset_dir, "cuda:0", legacy_contract)
    assert "device_map" not in from_pretrained_calls[-1]
    assert worker._pending_ready_loader_placement is None

    from_pretrained_calls.clear()
    worker.load_stack(asset_dir, "cuda:0", h11b_contract)
    assert from_pretrained_calls[-1]["device_map"] == h11.H11B_AUTHORIZED_LOADER_DEVICE_MAP
    placement = worker._pending_ready_loader_placement
    assert placement["hf_device_map"] == h11.H11B_AUTHORIZED_LOADER_DEVICE_MAP
    assert placement["parameter_count"] == 1
    assert placement["buffer_count"] == 1
    assert placement["all_parameters_cuda0"] is True
    assert placement["floating_parameters_bfloat16"] is True
finally:
    h11.verify_asset_directory = original_verify_assets

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})

await test('verify_h11b_loader_placement accepts cuda0 and rejects drift meta cpu and dtype (metadata-only FakeTensor offline)', async () => {
  const python = resolvePython()
  const script = `
import importlib.util, sys, types
import torch
from torch import nn
from torch._subclasses.fake_tensor import FakeTensorMode

def offline_metadata_tensor(shape, *, device, dtype):
    # Metadata-only offline: FakeTensor placement checks without real CUDA storage.
    with FakeTensorMode():
        return torch.zeros(shape, device=device, dtype=dtype)

def offline_metadata_parameter(shape, *, device="cuda:0", dtype=torch.bfloat16):
    with FakeTensorMode():
        return nn.Parameter(torch.zeros(shape, device=device, dtype=dtype))

spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

class FakeModel(nn.Module):
    def __init__(self, hf_device_map, param, buf):
        super().__init__()
        self.hf_device_map = hf_device_map
        self.weight = param
        self.register_buffer("buf", buf)

def expect_fail(fn):
    try:
        fn()
    except mod.H11Error:
        return
    raise AssertionError("expected H11Error")

good = FakeModel(
    {"": "cuda:0"},
    offline_metadata_parameter(2),
    offline_metadata_tensor(2, device="cuda:0", dtype=torch.int32),
)
attestation = mod.verify_h11b_loader_placement(good)
assert attestation["parameter_count"] == 1
assert attestation["buffer_count"] == 1

int_map = FakeModel(
    {"": 0},
    offline_metadata_parameter(2),
    offline_metadata_tensor(2, device="cuda:0", dtype=torch.int32),
)
assert mod.verify_h11b_loader_placement(int_map)["hf_device_map"] == mod.H11B_AUTHORIZED_LOADER_DEVICE_MAP

expect_fail(lambda: mod.verify_h11b_loader_placement(FakeModel({"": "cpu"}, nn.Parameter(torch.zeros(2)), torch.zeros(2))))
expect_fail(lambda: mod.verify_h11b_loader_placement(FakeModel({"layer": "cuda:0", "": "cuda:0"}, offline_metadata_parameter(2), offline_metadata_tensor(2, device="cuda:0", dtype=torch.int32))))
expect_fail(lambda: mod.verify_h11b_loader_placement(FakeModel({"": "cuda:0"}, nn.Parameter(torch.zeros(2, device="cpu", dtype=torch.bfloat16)), offline_metadata_tensor(2, device="cuda:0", dtype=torch.int32))))
unindexed_cuda = torch.device("cuda")
assert unindexed_cuda.index is None
assert not mod._tensor_on_cuda0(types.SimpleNamespace(device=unindexed_cuda))
expect_fail(lambda: mod.verify_h11b_loader_placement(FakeModel({"": "cuda:0"}, nn.Parameter(torch.zeros(2, device="meta", dtype=torch.bfloat16)), offline_metadata_tensor(2, device="cuda:0", dtype=torch.int32))))
expect_fail(lambda: mod.verify_h11b_loader_placement(FakeModel({"": "cuda:0"}, offline_metadata_parameter(2, dtype=torch.float32), offline_metadata_tensor(2, device="cuda:0", dtype=torch.int32))))

class EmptyModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.hf_device_map = {"": "cuda:0"}

expect_fail(lambda: mod.verify_h11b_loader_placement(EmptyModel()))

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})

await test('prepare-freeze and revalidate bind H11b contract recipe loader_device_map', async () => {
  const python = resolvePython()
  const h11bContract = JSON.parse(await readFile(H11B_CONTRACT, 'utf8')) as Record<string, unknown>
  const legacyRecipeScript = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)
print(json.dumps(mod.build_recipe(requested_device="cuda:0")))
`
  const legacyRecipeResult = runPythonScript(python, legacyRecipeScript)
  assert.equal(legacyRecipeResult.code, 0, legacyRecipeResult.stderr)
  const legacyRecipe = JSON.parse(legacyRecipeResult.stdout.trim()) as Record<string, unknown>

  const h11bRecipeScript = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)
contract = json.loads(Path(${JSON.stringify(H11B_CONTRACT)}).read_text(encoding="utf-8"))
print(json.dumps(mod.build_recipe(requested_device="cuda:0", contract=contract)))
`
  const h11bRecipeResult = runPythonScript(python, h11bRecipeScript)
  assert.equal(h11bRecipeResult.code, 0, h11bRecipeResult.stderr)
  const h11bRecipe = JSON.parse(h11bRecipeResult.stdout.trim()) as Record<string, unknown>
  assert.deepEqual(h11bRecipe.loader_device_map, { '': 'cuda:0' })
  assert.deepEqual(
    Object.keys(h11bRecipe).filter((key) => !(key in legacyRecipe)),
    ['loader_device_map'],
  )

  const revalidateScript = `
import importlib.util, json, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("h11c", ${JSON.stringify(COMMON)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

contract_path = Path(${JSON.stringify(H11B_CONTRACT)})
contract = mod.load_contract(contract_path)
freeze = {
    "schema": mod.FREEZE_SCHEMA,
    "manifest_path": "/tmp/unused-manifest.json",
    "manifest_sha256": "0" * 64,
    "asset_dir": "/tmp/unused-assets",
    "requested_device": "cuda:0",
    "recipe": json.loads(${JSON.stringify(JSON.stringify(h11bRecipe))}),
    "contract_sha256": mod.file_digest_hex(contract_path),
    "processor_attestation": mod.processor_attestation_from_contract(contract),
}
expected = mod.build_recipe(requested_device="cuda:0", contract=contract)
assert freeze["recipe"] == expected
assert mod.build_recipe(requested_device="cuda:0", contract=contract) != mod.build_recipe(requested_device="cuda:0")

legacy_path = Path(${JSON.stringify(CONTRACT)})
legacy_contract = mod.load_contract(legacy_path)
legacy_freeze_recipe = mod.build_recipe(requested_device="cuda:0", contract=legacy_contract)
assert "loader_device_map" not in legacy_freeze_recipe
print("ok")
`
  const revalidateResult = runPythonScript(python, revalidateScript)
  assert.equal(revalidateResult.code, 0, revalidateResult.stderr + revalidateResult.stdout)
  assert.match(revalidateResult.stdout, /ok/)
  assert.equal(h11bContract.runtime_profile_id, 'h11b-direct-cuda-v1')
})

await test('composed offline fake-native regression: run_row, eager load pins, and run finalization', async () => {
  const python = resolvePython()
  const script = `
import hashlib, importlib.util, json, os, shutil, sys, tempfile, types
from pathlib import Path
import numpy as np
import torch
from PIL import Image

os.environ["H10_EXPECTED_LAUNCHER_PID"] = str(os.getppid())

BENCHMARK = Path(${JSON.stringify(BENCHMARK_DIR)})
COMMON = BENCHMARK / "h11-sa2va-common.py"
WORKER = BENCHMARK / "h11-sa2va-worker.py"
RUNNER = BENCHMARK / "h11-sa2va-runner.py"

def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod

h11 = load_module(COMMON, "h11_composed_common")
worker = load_module(WORKER, "h11_composed_worker")
runner = load_module(RUNNER, "h11_composed_runner")

GOOD_SAM2 = '''
class SAM2VideoPredictor:
    def __init__(self, fill_hole_area=0):
        self.fill_hole_area = fill_hole_area

class SAM2:
    def __init__(self):
        SAM2VideoPredictor(compile_image_encoder=False)
'''

def sam2_contract(source: str) -> dict:
    payload = source.encode("utf-8")
    return {
        "required_model_files": [
            {"path": "sam2.py", "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}
        ]
    }

class ImageEncoder:
    def forward(self):
        return None

class Sam2Runtime:
    def __init__(self):
        self.fill_hole_area = 0
        self.image_encoder = ImageEncoder()

class GroundingEncoder:
    def __init__(self):
        self.sam2_model = Sam2Runtime()

class Sa2VAChatConfigQwen:
    def __init__(self, attn: str = "eager", flash: bool = False):
        self._attn_implementation = attn
        self.use_flash_attn = flash

generate_calls: list[dict] = []

class Sa2VAChatModelQwen:
    def __init__(self, asset_dir: Path, attn: str = "eager", flash: bool = False):
        self._device_storage = torch.device("cpu")
        self.config = Sa2VAChatConfigQwen(attn=attn, flash=flash)
        self.grounding_encoder = GroundingEncoder()
        self.name_or_path = str(asset_dir)
        inner = types.SimpleNamespace()
        inner.config = Sa2VAChatConfigQwen(attn=attn, flash=flash)

        def inner_generate(*args, **kwargs):
            generate_calls.append(dict(kwargs))
            input_ids = kwargs.get("input_ids")
            if input_ids is None and args:
                input_ids = args[0]
            in_len = int(input_ids.shape[-1])
            out = torch.cat([input_ids, torch.tensor([[2]], dtype=torch.long)], dim=1)
            result = types.SimpleNamespace(sequences=out)
            return result

        inner.generate = inner_generate
        self.model = inner

    @property
    def device(self):
        return self._device_storage

    def eval(self):
        return self

    def to(self, device):
        self._device_storage = torch.device(device)
        return self

    def predict_forward(self, image, text, processor, tokenizer):
        input_ids = torch.ones((1, 4), dtype=torch.long)
        self.model.generate(input_ids=input_ids)
        width, height = image.size
        mask = np.zeros((1, height, width), dtype=np.uint8)
        mask[0, 0, 0] = 1
        return {"prediction": "diagnostic-only", "prediction_masks": [mask]}

class Qwen2VLImageProcessor:
    pass

class Qwen3VLProcessor:
    def __init__(self):
        self.image_processor = Qwen2VLImageProcessor()
        self.tokenizer = types.SimpleNamespace(eos_token_id=2)

Qwen3VLProcessor.__module__ = "transformers.models.qwen3_vl.processing_qwen3_vl"
Qwen2VLImageProcessor.__module__ = "transformers.models.qwen2_vl.image_processing_qwen2_vl"

from_pretrained_calls: list[dict] = []

def fake_processor_from_pretrained(*args, **kwargs):
    assert kwargs.get("use_fast") is h11.PROCESSOR_USE_FAST
    assert kwargs.get("local_files_only") is True
    assert kwargs.get("revision") == h11.MODEL_REVISION
    return Qwen3VLProcessor()

def fake_model_from_pretrained(*args, **kwargs):
    from_pretrained_calls.append(dict(kwargs))
    assert kwargs.get("attn_implementation") == "eager"
    assert kwargs.get("use_flash_attn") is False
    assert kwargs.get("local_files_only") is True
    assert kwargs.get("revision") == h11.MODEL_REVISION
    return Sa2VAChatModelQwen(asset_dir=Path(args[0]))

asset_dir = Path(tempfile.mkdtemp(prefix="h11-compose-assets-"))
(asset_dir / "sam2.py").write_text(GOOD_SAM2, encoding="utf-8")
contract = sam2_contract(GOOD_SAM2)
original_verify_assets = h11.verify_asset_directory
h11.verify_asset_directory = lambda directory, c: {"sam2.py": {"sha256": contract["required_model_files"][0]["sha256"], "bytes": contract["required_model_files"][0]["bytes"]}}

import transformers
transformers.AutoProcessor.from_pretrained = fake_processor_from_pretrained
transformers.AutoModel.from_pretrained = fake_model_from_pretrained

if not torch.cuda.is_available():
    _orig_sync = torch.cuda.synchronize
    _orig_max_alloc = torch.cuda.max_memory_allocated
    _orig_max_reserved = torch.cuda.max_memory_reserved
    torch.cuda.is_available = lambda: True
    torch.cuda.synchronize = lambda device=None: None
    torch.cuda.reset_peak_memory_stats = lambda device=None: None
    torch.cuda.max_memory_allocated = lambda device=None: 0
    torch.cuda.max_memory_reserved = lambda device=None: 0

try:
    processor, model, torch_device = worker.load_stack(asset_dir, "cuda:0", contract)
    h11.verify_attention_runtime(model)
    assert from_pretrained_calls[-1]["attn_implementation"] == "eager"
    assert from_pretrained_calls[-1]["use_flash_attn"] is False
    try:
        model.device = torch.device("cuda:0")
        raise AssertionError("expected readonly device assignment to fail")
    except AttributeError:
        pass

    work_dir = Path(tempfile.mkdtemp(prefix="h11-compose-run-"))
    masks_dir = work_dir / "masks"
    masks_dir.mkdir(parents=True)
    manifest_rows = []
    worker_rows = []
    for index in range(12):
        image_path = work_dir / f"src-{index:02d}.png"
        Image.new("RGB", (8, 6), (10, 20, 30)).save(image_path)
        digest = hashlib.sha256(image_path.read_bytes()).hexdigest()
        row = {
            "row_index": index,
            "row_key": f"case-{index:02d}",
            "source_path": str(image_path),
            "expected_source_sha256": digest,
            "authored_target": f"object {index}",
        }
        manifest_rows.append(
            {
                "row_index": index,
                "row_key": f"case-{index:02d}",
                "source_path": str(image_path),
                "source_sha256": digest,
                "authored_target": f"object {index}",
            }
        )
        generate_calls.clear()
        terminal = worker.run_row(processor, model, torch_device, row, masks_dir)
        assert isinstance(terminal.get("wall_ms"), float)
        assert "peak_vram_allocated_bytes" in terminal
        assert "peak_vram_reserved_bytes" in terminal
        assert terminal["outcome_kind"] == "candidate"
        assert terminal["mask_path"] == f"masks/case-{index:02d}/mask.u8"
        assert (work_dir / terminal["mask_path"]).is_file()
        assert generate_calls[-1]["max_new_tokens"] == 128
        assert generate_calls[-1]["do_sample"] is False
        gen_diag = terminal.get("generation_diagnostics")
        assert isinstance(gen_diag, dict)
        assert gen_diag["actual_max_new_tokens_applied"] == generate_calls[-1]["max_new_tokens"]
        assert gen_diag["do_sample_applied"] is generate_calls[-1]["do_sample"]
        assert gen_diag["generated_token_count"] == 1
        assert gen_diag["stopped_on_eos"] is True
        assert terminal["generation_token_count"] == gen_diag["generated_token_count"]
        assert terminal["generation_truncated"] is False
        worker_rows.append(terminal)

    raw_result = {
        "worker_pid": 4242,
        "load_ms": 12.5,
        "wall_ms": 99.0,
        "rows": worker_rows,
        "worker_stderr_tail": "",
        "cleanup_failed": False,
        "cancelled": False,
    }
    rows = manifest_rows
    normalized = runner.normalize_execute_rows_result(raw_result, rows)
    assert len(normalized["rows"]) == 12
    for left, right in zip(normalized["rows"], rows, strict=True):
        assert left["row_index"] == right["row_index"]
        assert left["row_key"] == right["row_key"]
        assert isinstance(left.get("wall_ms"), float)
        assert left["wall_ms"] >= 0.0
        peak_alloc = left.get("peak_vram_allocated_bytes")
        peak_reserved = left.get("peak_vram_reserved_bytes")
        assert peak_alloc is None or isinstance(peak_alloc, int)
        assert peak_reserved is None or isinstance(peak_reserved, int)
        gen_diag = left.get("generation_diagnostics")
        assert isinstance(gen_diag, dict)
        assert gen_diag["actual_max_new_tokens_applied"] == 128
        assert gen_diag["do_sample_applied"] is False
        assert left["generation_token_count"] == gen_diag["generated_token_count"]
        assert left["generation_truncated"] is False
        for h10_key in ("prep_ms", "forward_ms", "post_ms", "model_max_length", "interpolate_pos_encoding", "type"):
            assert h10_key not in left, h10_key
        assert left["outcome_kind"] == "candidate"
        assert left["mask_path"] == f"masks/{right['row_key']}/mask.u8"

    rows_path = work_dir / "rows.jsonl"
    run_path = work_dir / "run.json"
    runner.write_jsonl_atomic(rows_path, normalized["rows"])
    status = h11.derive_run_status(normalized["rows"], cleanup_failed=False, cancelled=False)
    runner.write_json_atomic(
        run_path,
        {
            "schema": h11.RUN_SCHEMA,
            "status": status,
            "row_count": len(normalized["rows"]),
            "load_ms": normalized["load_ms"],
            "wall_ms": normalized["wall_ms"],
        },
    )
    written = [json.loads(line) for line in rows_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(written) == 12
    run_record = json.loads(run_path.read_text(encoding="utf-8"))
    assert run_record["row_count"] == 12
finally:
    h11.verify_asset_directory = original_verify_assets
    shutil.rmtree(asset_dir, ignore_errors=True)
    if "work_dir" in locals():
        shutil.rmtree(work_dir, ignore_errors=True)

print("ok")
`
  const result = runPythonScript(python, script)
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /ok/)
})
