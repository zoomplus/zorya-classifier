#!/usr/bin/env python3
"""Benchmark-only H8a CPU float32 D/U availability probe (not quality evidence)."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import os
import re
import resource
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[3]
RECIPE_ID = "h8a-cpu-fp32-availability-v1"
HYPOTHESIS_FREEZE_SHA256 = "4731a835ce84e3764fc06d8924c9fc6a6948a600852b51ca82390f8b2d93b9ac"
RUN_FREEZE_SCHEMA = "zorya-classifier-h8a-cpu-run-freeze-v2"

PINNED_HELPERS: tuple[tuple[str, str], ...] = (
    ("benchmarks/v03/grounded-proposals-probe.py", "7695cb42cd6e4e583f6cb5bab08d93d40c18d08c188651948b4fed0b43fdc8b5"),
    ("benchmarks/v03/ui-proposal-probe.py", "fd1cc46823913e143219dcb4e2faf28393f21324b146e14d9feebbb6d58d217d"),
    ("benchmarks/v03/h4e-sam2-context-prompt.py", "4b74661b0fe156c4f1da46a24fc25e313150ac9d0f83076a1eae441425fb3582"),
    ("benchmarks/v03/h5a-native-proposals.py", "ae6abe229a4646c87d46f4d3e9a7066503b020bc4b93a86dac9509cd327b52f8"),
)

EXPECTED_CASE_IDS = tuple(
    [f"pilot-v03-photo-{i:02d}" for i in range(1, 5)]
    + [f"pilot-v03-ui-{i:02d}" for i in range(1, 5)]
    + [f"pilot-v03-map-{i:02d}" for i in range(1, 5)]
)
EXPECTED_CASE_ID_SET = frozenset(EXPECTED_CASE_IDS)
SHA256_HEX_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MAX_NORMALIZED_TARGET_CHARS = 2048

MANIFEST_ACCEPTED_SHA256: dict[str, frozenset[str]] = {
    "photo.json": frozenset({"ee1d36d254f3aeddd9b9739143754dfbdc3409e155ab76334e10cf04e0bfb44b"}),
    "ui.json": frozenset({"5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f"}),
    "map.json": frozenset({"6886670e7f9529805196fe8502975f78c968ff612bfa3279c323cad215ba89c4"}),
}

MANIFEST_CASE_IDS: dict[str, tuple[str, ...]] = {
    "photo.json": tuple(f"pilot-v03-photo-{i:02d}" for i in range(1, 5)),
    "ui.json": tuple(f"pilot-v03-ui-{i:02d}" for i in range(1, 5)),
    "map.json": tuple(f"pilot-v03-map-{i:02d}" for i in range(1, 5)),
}

OMNI_MODEL_SHA256 = "11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c"
OMNI_MODEL_BYTES = 281_182_680
OMNI_LICENSE_SHA256 = "646f8936b8ddcd14e13e578ff6857e368780b0d1a4f6066bee89211923a373e2"
OMNI_LICENSE_BYTES = 1_073
ASSET_MANIFEST_SHA256 = "104894178f539428d0c5ea48c043277a500734905e36f3c4f95d9d96cfb2d4df"

EXPECTED_PYTHON = "3.12.3"
EXPECTED_TORCH = "2.6.0+cu124"
EXPECTED_TRANSFORMERS = "4.57.3"
PINNED_RUNTIME_PACKAGES = (
    "torch",
    "torchvision",
    "transformers",
    "numpy",
    "Pillow",
    "safetensors",
)
O_RDONLY_NOFOLLOW = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)

CASE_DEADLINE_SECONDS = 240
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_IMAGE_PIXELS = 2_097_152
MAX_CANDIDATES_PER_FAMILY = 36
MAX_CANDIDATES_TOTAL = 72
MAX_PACKED_BYTES = 19 * 1024 * 1024
MAX_STDOUT_BYTES = 1_048_576
MAX_STDERR_BYTES = 8_388_608
MAX_RSS_BYTES = 16 * 1024**3
RSS_SAMPLE_INTERVAL_SECONDS = 0.1
TERMINATION_GRACE_SECONDS = 2.0

BOX_THRESHOLD = 0.15
TEXT_THRESHOLD = 0.15


class ProbeError(RuntimeError):
    pass


def path_is_inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
        return True
    except ValueError:
        return False


def require_external_output_path(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if path_is_inside_repo(resolved):
        raise ProbeError(f"{label} must resolve outside repository: {resolved}")
    return resolved


def validate_sha256_hex(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not SHA256_HEX_PATTERN.fullmatch(value):
        raise ProbeError(f"{field_name} must be a lowercase SHA-256 hex digest")
    return value


def validate_case_id(value: Any) -> str:
    if not isinstance(value, str):
        raise ProbeError("case_id must be a string")
    if value != value.strip() or "/" in value or "\\" in value or ".." in value:
        raise ProbeError("case_id must not contain path traversal")
    if value not in EXPECTED_CASE_ID_SET:
        raise ProbeError(f"unknown case_id: {value}")
    return value


def require_string_field(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ProbeError(f"{field_name} must be a string")
    return value


def validate_worker_payload(raw: Any) -> dict[str, Any]:
    payload = require_json_object(raw, "worker payload")
    case_id = validate_case_id(payload.get("case_id"))
    output_dir = require_external_output_path(
        Path(require_string_field(payload.get("output_dir"), "output_dir")),
        "worker output_dir",
    )
    assets_dir = Path(require_string_field(payload.get("assets_dir"), "assets_dir")).resolve()
    source_path = Path(require_string_field(payload.get("source_path"), "source_path")).resolve()
    source_sha256 = validate_sha256_hex(payload.get("source_sha256"), "source_sha256")
    width = require_positive_int(payload.get("width"), "width")
    height = require_positive_int(payload.get("height"), "height")
    if width * height > MAX_IMAGE_PIXELS:
        raise ProbeError("width*height exceeds pixel cap")
    normalized_target = payload.get("normalized_target")
    if not isinstance(normalized_target, str):
        raise ProbeError("normalized_target must be a string")
    if not normalized_target or len(normalized_target) > MAX_NORMALIZED_TARGET_CHARS:
        raise ProbeError("normalized_target length out of bounds")
    return {
        "case_id": case_id,
        "output_dir": output_dir,
        "assets_dir": assets_dir,
        "source_path": source_path,
        "source_sha256": source_sha256,
        "width": width,
        "height": height,
        "normalized_target": normalized_target,
    }


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def file_receipt(path: Path, expected_sha256: str | None = None) -> dict[str, Any]:
    digest, size = sha256_file(path)
    if expected_sha256 is not None and digest != expected_sha256:
        raise ProbeError(f"pinned digest mismatch: {path}")
    return {"path": str(path.resolve()), "sha256": digest, "bytes": size}


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def reserve_new_directory(path: Path) -> None:
    if path.exists():
        raise ProbeError(f"output directory already exists: {path}")
    path.mkdir(parents=True)


@dataclass(frozen=True)
class VerifiedOpenFile:
    path: Path
    fd: int
    sha256: str
    size: int

    @property
    def proc_fd_path(self) -> str:
        return f"/proc/self/fd/{self.fd}"

    def read_all_bytes(self) -> bytes:
        os.lseek(self.fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        chunks: list[bytes] = []
        size = 0
        while True:
            piece = os.read(self.fd, 1024 * 1024)
            if not piece:
                break
            digest.update(piece)
            size += len(piece)
            chunks.append(piece)
        os.lseek(self.fd, 0, os.SEEK_SET)
        if size != self.size or digest.hexdigest() != self.sha256:
            raise ProbeError(f"pinned asset integrity check failed: {self.path}")
        return b"".join(chunks)

    def verify_snapshot_unchanged(self) -> None:
        os.lseek(self.fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        size = 0
        while True:
            piece = os.read(self.fd, 1024 * 1024)
            if not piece:
                break
            digest.update(piece)
            size += len(piece)
        os.lseek(self.fd, 0, os.SEEK_SET)
        if size != self.size or digest.hexdigest() != self.sha256:
            raise ProbeError(f"pinned asset mutated after verify: {self.path}")


def verified_open_receipt(opened: VerifiedOpenFile) -> dict[str, Any]:
    return {"path": str(opened.path.resolve()), "sha256": opened.sha256, "bytes": opened.size}


def enforce_owned_bytes_digest(data: bytes, expected_sha256: str) -> None:
    digest = sha256_bytes(data)
    if digest != expected_sha256:
        raise ProbeError("owned byte digest differs from verified descriptor")


class VerifiedAssetSession:
    def __init__(self) -> None:
        self._opens: list[VerifiedOpenFile] = []
        self._temp_dirs: list[tempfile.TemporaryDirectory[str]] = []

    def open_verified(
        self,
        path: Path,
        *,
        expected_sha256: str | None = None,
        expected_size: int | None = None,
    ) -> VerifiedOpenFile:
        if path.is_symlink():
            raise ProbeError(f"refusing symlink asset path: {path}")
        try:
            fd = os.open(path, O_RDONLY_NOFOLLOW)
        except OSError as error:
            raise ProbeError(f"cannot open pinned asset: {path}") from error
        resolved = path.resolve()
        digest = hashlib.sha256()
        size = 0
        try:
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
            os.lseek(fd, 0, os.SEEK_SET)
        except OSError as error:
            os.close(fd)
            raise ProbeError(f"cannot read pinned asset: {resolved}") from error
        hexdigest = digest.hexdigest()
        if expected_sha256 is not None and hexdigest != expected_sha256:
            os.close(fd)
            raise ProbeError(f"pinned digest mismatch: {resolved}")
        if expected_size is not None and size != expected_size:
            os.close(fd)
            raise ProbeError(f"pinned size mismatch: {resolved}")
        opened = VerifiedOpenFile(resolved, fd, hexdigest, size)
        self._opens.append(opened)
        return opened

    def materialize_small_file(self, opened: VerifiedOpenFile, *, suffix: str = "") -> Path:
        temp_dir = tempfile.TemporaryDirectory(prefix="h8a-verified-")
        self._temp_dirs.append(temp_dir)
        target = Path(temp_dir.name) / f"asset{suffix}"
        target.write_bytes(opened.read_all_bytes())
        return target

    def materialize_fd_tree(self, files: list[tuple[Path, VerifiedOpenFile]]) -> Path:
        temp_dir = tempfile.TemporaryDirectory(prefix="h8a-model-")
        self._temp_dirs.append(temp_dir)
        root = Path(temp_dir.name)
        for relative, opened in files:
            dest = root / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(opened.proc_fd_path, dest)
        return root

    def close(self) -> None:
        errors: list[str] = []
        for opened in self._opens:
            try:
                opened.verify_snapshot_unchanged()
            except ProbeError as error:
                errors.append(str(error))
            try:
                os.close(opened.fd)
            except OSError as error:
                errors.append(f"fd close failed for {opened.path}: {error}")
        self._opens.clear()
        for temp_dir in self._temp_dirs:
            try:
                temp_dir.cleanup()
            except OSError as error:
                errors.append(f"temporary directory cleanup failed: {error}")
        self._temp_dirs.clear()
        if errors:
            raise ProbeError("; ".join(errors))


def load_pinned_module(relative_path: str, expected_sha256: str, module_name: str) -> Any:
    path = (REPO_ROOT / relative_path).resolve()
    session = VerifiedAssetSession()
    try:
        opened = session.open_verified(path, expected_sha256=expected_sha256)
        source = opened.read_all_bytes().decode("utf-8")
        code = compile(source, str(path), "exec", dont_inherit=True)
        module = types.ModuleType(module_name)
        module.__file__ = str(path)
        module.__dict__["__name__"] = module_name
        sys.modules[module_name] = module
        exec(code, module.__dict__)
        return module
    finally:
        session.close()


def load_all_pinned_helpers() -> tuple[Any, Any, Any, Any]:
    grounded = load_pinned_module(PINNED_HELPERS[0][0], PINNED_HELPERS[0][1], "h8a_grounded")
    omni = load_pinned_module(PINNED_HELPERS[1][0], PINNED_HELPERS[1][1], "h8a_omni")
    h4e = load_pinned_module(PINNED_HELPERS[2][0], PINNED_HELPERS[2][1], "h8a_h4e")
    h5a = load_pinned_module(PINNED_HELPERS[3][0], PINNED_HELPERS[3][1], "h8a_h5a")
    return grounded, omni, h4e, h5a


def packed_mask_byte_length(width: int, height: int) -> int:
    if width <= 0 or height <= 0:
        raise ProbeError("packed mask dimensions must be positive")
    return (width * height + 7) // 8


def aggregate_packed_limit(width: int, height: int, d_count: int, u_count: int) -> int:
    if d_count > MAX_CANDIDATES_PER_FAMILY or u_count > MAX_CANDIDATES_PER_FAMILY:
        raise ProbeError("family candidate cap exceeded")
    if d_count + u_count > MAX_CANDIDATES_TOTAL:
        raise ProbeError("combined candidate cap exceeded")
    return packed_mask_byte_length(width, height) * (d_count + u_count)


def pack_mask_with_validation(mask_bool: Any, width: int, height: int) -> bytes:
    import numpy as np

    array = np.asarray(mask_bool, dtype=bool)
    if array.shape != (height, width):
        raise ProbeError("mask shape differs from source dimensions")
    flat = array.reshape(-1)
    pixel_count = width * height
    if flat.size != pixel_count:
        raise ProbeError("mask pixel count mismatch")
    packed = np.packbits(flat, bitorder="little").tobytes()
    if len(packed) != packed_mask_byte_length(width, height):
        raise ProbeError("packed mask length mismatch")
    if pixel_count % 8 and packed[-1] & ~((1 << (pixel_count % 8)) - 1):
        raise ProbeError("packed mask has nonzero padding bits")
    return packed


def validate_packed_bytes(packed: bytes, width: int, height: int) -> None:
    pixel_count = width * height
    if len(packed) != packed_mask_byte_length(width, height):
        raise ProbeError("packed mask byte length differs from source dimensions")
    if pixel_count % 8 and packed[-1] & ~((1 << (pixel_count % 8)) - 1):
        raise ProbeError("packed mask has nonzero padding bits")


def mask_bbox_np(binary: Any) -> list[int] | None:
    import numpy as np

    ys, xs = np.nonzero(binary)
    if len(xs) == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def parse_proc_stat_pgrp(stat: str) -> int | None:
    close_paren = stat.rfind(")")
    if close_paren < 0:
        return None
    fields = stat[close_paren + 2 :].split()
    if len(fields) < 3:
        return None
    try:
        return int(fields[2])
    except ValueError:
        return None


def read_process_pgrp(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return parse_proc_stat_pgrp(stat)


def parse_proc_stat_cpu_jiffies(stat: str) -> int | None:
    close_paren = stat.rfind(")")
    if close_paren < 0:
        return None
    fields = stat[close_paren + 2 :].split()
    if len(fields) < 15:
        return None
    try:
        return int(fields[11]) + int(fields[12])
    except ValueError:
        return None


def read_process_cpu_jiffies(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return parse_proc_stat_cpu_jiffies(stat)


def proc_metrics_available() -> bool:
    return Path("/proc/self/stat").is_file()


def list_process_group_pids(pgid: int) -> list[int]:
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return []
    members: list[int] = []
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if read_process_pgrp(pid) == pgid:
            members.append(pid)
    return members


def read_process_state(pid: int) -> str | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    close_paren = stat.rfind(")")
    if close_paren < 0:
        return None
    fields = stat[close_paren + 2 :].split()
    return fields[0] if fields else None


def process_group_alive(pgid: int) -> bool:
    for pid in list_process_group_pids(pgid):
        state = read_process_state(pid)
        if state is None:
            continue
        if state != "Z":
            return True
    return False


def wait_process_group_settled(pgid: int, deadline: float) -> bool:
    while time.monotonic() < deadline:
        if not process_group_alive(pgid):
            return True
        time.sleep(0.05)
    return not process_group_alive(pgid)


def read_process_rss_bytes(pid: int) -> int | None:
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1]) * 1024
    return None


def sample_process_group_rss(pgid: int) -> tuple[int | None, bool]:
    total = 0
    found = False
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return None, False
    for pid in list_process_group_pids(pgid):
        rss = read_process_rss_bytes(pid)
        if rss is None:
            continue
        found = True
        total += rss
    if not found:
        return None, False
    return total, True


def sample_process_group_cpu_jiffies(pgid: int) -> tuple[int | None, bool]:
    total = 0
    found = False
    if not proc_metrics_available():
        return None, False
    for pid in list_process_group_pids(pgid):
        jiffies = read_process_cpu_jiffies(pid)
        if jiffies is None:
            continue
        found = True
        total += jiffies
    if not found:
        return None, False
    return total, True


def kill_owned_process_group(
    process: subprocess.Popen[bytes],
    pgid: int | None = None,
    grace_seconds: float = TERMINATION_GRACE_SECONDS,
) -> None:
    group_id = pgid if pgid is not None else process.pid
    if not process_group_alive(group_id):
        if process.poll() is None:
            try:
                process.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired as error:
                raise ProbeError("owned process leader did not exit after process group settlement") from error
        return
    try:
        os.killpg(group_id, signal.SIGTERM)
    except ProcessLookupError:
        pass
    term_deadline = time.monotonic() + grace_seconds
    if not wait_process_group_settled(group_id, term_deadline):
        try:
            os.killpg(group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
        kill_deadline = time.monotonic() + grace_seconds
        if not wait_process_group_settled(group_id, kill_deadline):
            raise ProbeError("owned process group did not settle after SIGKILL")
    if process.poll() is None:
        try:
            process.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired as error:
            raise ProbeError("owned process leader did not exit after process group settlement") from error
    if process_group_alive(group_id):
        raise ProbeError("owned process group still has live members after SIGKILL")


def finalize_owned_child_cleanup(
    process: subprocess.Popen[bytes],
    pgid: int,
    stdout_fd: int,
    stderr_drainer: BoundedStderrDrainer | None,
    *,
    grace_seconds: float = TERMINATION_GRACE_SECONDS,
) -> str | None:
    cleanup_error: str | None = None
    try:
        kill_owned_process_group(process, pgid, grace_seconds=grace_seconds)
    except ProbeError as error:
        cleanup_error = str(error)
    if process_group_alive(pgid):
        cleanup_error = cleanup_error or "owned process group still has live members after cleanup"
    if stderr_drainer is not None:
        try:
            stderr_drainer.join(grace_seconds)
        except ProbeError as error:
            cleanup_error = cleanup_error or str(error)
    if process.stderr is not None:
        try:
            process.stderr.close()
        except OSError as error:
            cleanup_error = cleanup_error or f"stderr close failed: {error}"
    if process.stdout is not None:
        try:
            process.stdout.close()
        except OSError as error:
            cleanup_error = cleanup_error or f"stdout close failed: {error}"
    elif stdout_fd >= 0:
        try:
            os.close(stdout_fd)
        except OSError as error:
            cleanup_error = cleanup_error or f"stdout fd close failed: {error}"
    return cleanup_error


class BoundedStderrDrainer:
    def __init__(self, stream: Any, path: Path, limit: int) -> None:
        self._stream = stream
        self._path = path
        self._limit = limit
        self.overflow = threading.Event()
        self._done = threading.Event()
        self._io_error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="h8a-stderr-drainer", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        total = 0
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("wb") as log:
                while True:
                    try:
                        chunk = self._stream.read(65536)
                    except OSError as error:
                        self._io_error = error
                        break
                    if not chunk:
                        break
                    remaining = self._limit - total
                    if remaining <= 0:
                        self.overflow.set()
                        break
                    if len(chunk) > remaining:
                        log.write(chunk[:remaining])
                        total += remaining
                        self.overflow.set()
                        break
                    log.write(chunk)
                    total += len(chunk)
        except OSError as error:
            self._io_error = error
        finally:
            self._done.set()

    def join(self, timeout: float) -> None:
        self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            raise ProbeError("stderr drainer thread did not terminate")
        if not self._done.wait(timeout=0.1):
            raise ProbeError("stderr drainer did not finish")
        if self._io_error is not None:
            raise ProbeError(f"stderr drainer I/O failed: {self._io_error}") from self._io_error


def stderr_drainer_terminal_error(drainer: BoundedStderrDrainer | None) -> str | None:
    if drainer is None:
        return None
    if drainer.overflow.is_set():
        return "stderr exceeded bounded limit"
    if drainer._io_error is not None:
        return f"stderr drainer I/O failed: {drainer._io_error}"
    return None


def _read_available_stdout(stdout_fd: int, limit_remaining: int) -> bytes:
    if limit_remaining <= 0:
        return b""
    try:
        return os.read(stdout_fd, min(65536, limit_remaining))
    except BlockingIOError:
        return b""
    except OSError:
        return b""


def stdout_exceeds_bounded_limit(stdout_fd: int, current_len: int, stdout_limit: int) -> bool:
    if current_len > stdout_limit:
        return True
    if current_len < stdout_limit:
        return False
    ready, _, _ = select.select([stdout_fd], [], [], 0)
    if not ready:
        return False
    extra = _read_available_stdout(stdout_fd, 1)
    return len(extra) > 0


def run_bounded_child(
    command: list[str],
    *,
    deadline_seconds: float,
    stderr_path: Path,
    stdout_limit: int = MAX_STDOUT_BYTES,
    stderr_limit: int = MAX_STDERR_BYTES,
    rss_limit: int = MAX_RSS_BYTES,
    rss_interval: float = RSS_SAMPLE_INTERVAL_SECONDS,
    rss_sampler: Callable[[int], tuple[int | None, bool]] | None = None,
    cpu_sampler: Callable[[int], tuple[int | None, bool]] | None = None,
    child_tmpdir: Path | None = None,
) -> dict[str, Any]:
    rss_sample = rss_sampler or sample_process_group_rss
    cpu_sample = cpu_sampler or sample_process_group_cpu_jiffies
    started = time.monotonic()
    absolute_deadline = started + deadline_seconds
    stderr_path.parent.mkdir(parents=True, exist_ok=True)
    child_env = {
        **os.environ,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }
    process: subprocess.Popen[bytes] | None = None
    stderr_drainer: BoundedStderrDrainer | None = None
    pgid = 0
    peak_rss: int | None = None
    peak_cpu_jiffies: int | None = None
    rss_available = False
    cpu_available = False
    stdout = b""
    cancel_requested = threading.Event()
    terminal = "error"
    error_message = "worker failed"
    stdout_fd = -1
    cleanup_started = False
    tmpdir_removed = False
    tmpdir_cleanup_error: str | None = None

    def _run_bounded_child_loop() -> None:
        nonlocal stderr_drainer, pgid, peak_rss, peak_cpu_jiffies, rss_available, cpu_available
        nonlocal stdout, terminal, error_message, stdout_fd, cleanup_started
        assert process is not None
        if process.stdout is None or process.stderr is None:
            raise ProbeError("child pipes were not created")
        stderr_drainer = BoundedStderrDrainer(process.stderr, stderr_path, stderr_limit)
        stderr_drainer.start()
        pgid = process.pid
        stdout_fd = process.stdout.fileno()
        os.set_blocking(stdout_fd, False)
        while True:
            now = time.monotonic()
            if cancel_requested.is_set() and not cleanup_started:
                terminal = "cancelled"
                error_message = "parent cancellation"
                cleanup_started = True
                kill_owned_process_group(process, pgid)
                break
            if now >= absolute_deadline and not cleanup_started:
                terminal = "timeout"
                error_message = "case exceeded absolute deadline"
                cleanup_started = True
                kill_owned_process_group(process, pgid)
                break
            if stderr_drainer.overflow.is_set() and not cleanup_started:
                terminal = "resource_limit"
                error_message = "stderr exceeded bounded limit"
                cleanup_started = True
                kill_owned_process_group(process, pgid)
                break
            sampled, ok = rss_sample(pgid)
            if ok and sampled is not None:
                rss_available = True
                peak_rss = sampled if peak_rss is None else max(peak_rss, sampled)
                if sampled > rss_limit and not cleanup_started:
                    terminal = "resource_limit"
                    error_message = "process group RSS exceeded 16 GiB cap"
                    cleanup_started = True
                    kill_owned_process_group(process, pgid)
                    break
            cpu_sampled, cpu_ok = cpu_sample(pgid)
            if cpu_ok and cpu_sampled is not None:
                cpu_available = True
                peak_cpu_jiffies = (
                    cpu_sampled if peak_cpu_jiffies is None else max(peak_cpu_jiffies, cpu_sampled)
                )
            remaining = max(0.0, min(rss_interval, absolute_deadline - now))
            ready, _, _ = select.select([stdout_fd], [], [], remaining)
            if ready:
                if len(stdout) >= stdout_limit and stdout_exceeds_bounded_limit(
                    stdout_fd, len(stdout), stdout_limit
                ):
                    if not cleanup_started:
                        terminal = "resource_limit"
                        error_message = "stdout exceeded bounded limit"
                        cleanup_started = True
                        kill_owned_process_group(process, pgid)
                        break
                piece = _read_available_stdout(stdout_fd, stdout_limit - len(stdout))
                if piece:
                    if len(stdout) + len(piece) > stdout_limit and not cleanup_started:
                        terminal = "resource_limit"
                        error_message = "stdout exceeded bounded limit"
                        cleanup_started = True
                        kill_owned_process_group(process, pgid)
                        break
                    stdout += piece
                    if stdout_exceeds_bounded_limit(stdout_fd, len(stdout), stdout_limit) and not cleanup_started:
                        terminal = "resource_limit"
                        error_message = "stdout exceeded bounded limit"
                        cleanup_started = True
                        kill_owned_process_group(process, pgid)
                        break
            if process.poll() is not None:
                while True:
                    remaining_out = stdout_limit - len(stdout)
                    if remaining_out <= 0:
                        if stdout_exceeds_bounded_limit(stdout_fd, len(stdout), stdout_limit):
                            terminal = "resource_limit"
                            error_message = "stdout exceeded bounded limit"
                        break
                    piece = _read_available_stdout(stdout_fd, remaining_out)
                    if not piece:
                        if len(stdout) >= stdout_limit and stdout_exceeds_bounded_limit(
                            stdout_fd, len(stdout), stdout_limit
                        ):
                            terminal = "resource_limit"
                            error_message = "stdout exceeded bounded limit"
                        break
                    if len(piece) > remaining_out:
                        terminal = "resource_limit"
                        error_message = "stdout exceeded bounded limit"
                        stdout += piece[:remaining_out]
                        break
                    stdout += piece
                if len(stdout) > stdout_limit or stdout_exceeds_bounded_limit(stdout_fd, len(stdout), stdout_limit):
                    terminal = "resource_limit"
                    error_message = "stdout exceeded bounded limit"
                if cleanup_started or terminal in {"timeout", "cancelled", "resource_limit"}:
                    break
                leader_cleanup_violation = (
                    process.returncode == 0
                    and terminal != "resource_limit"
                    and process_group_alive(pgid)
                )
                if process.returncode == 0 and terminal != "resource_limit" and not leader_cleanup_violation:
                    terminal = "complete"
                    error_message = ""
                elif leader_cleanup_violation:
                    terminal = "error"
                    error_message = "owned process group remained live after leader exit"
                elif terminal != "resource_limit":
                    terminal = "error"
                    error_message = f"worker exited with status {process.returncode}"
                break

    def _handle_signal(_signum: int, _frame: Any) -> None:
        cancel_requested.set()

    prior_term = signal.getsignal(signal.SIGTERM)
    prior_int = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    if child_tmpdir is not None:
        child_tmpdir.mkdir(parents=True, exist_ok=True)
        child_env["TMPDIR"] = str(child_tmpdir)
    try:
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
                env=child_env,
            )
        except OSError as error:
            terminal = "error"
            error_message = f"child spawn failed: {error}"
            process = None
        if process is not None:
            _run_bounded_child_loop()
    except Exception as error:
        terminal = "error"
        error_message = f"operational failure: {error}"
        if process is not None and not cleanup_started:
            cleanup_started = True
            try:
                kill_owned_process_group(process, pgid if pgid else process.pid)
            except ProbeError as kill_error:
                error_message = f"{error_message}; {kill_error}"
    finally:
        signal.signal(signal.SIGTERM, prior_term)
        signal.signal(signal.SIGINT, prior_int)
        if process is not None:
            leader_left_live_group = (
                process.poll() is not None
                and process.returncode == 0
                and process_group_alive(pgid if pgid else process.pid)
            )
            cleanup_error = finalize_owned_child_cleanup(
                process,
                pgid if pgid else process.pid,
                stdout_fd,
                stderr_drainer,
            )
            if leader_left_live_group:
                cleanup_error = cleanup_error or "owned process group remained live after leader exit"
            if cleanup_error:
                if terminal == "complete":
                    terminal = "error"
                    error_message = cleanup_error
                elif not error_message:
                    error_message = cleanup_error
                elif cleanup_error not in error_message:
                    error_message = f"{error_message}; {cleanup_error}"
            drainer_error = stderr_drainer_terminal_error(stderr_drainer)
            if drainer_error:
                if terminal == "complete":
                    terminal = "error"
                    error_message = drainer_error
                elif drainer_error not in (error_message or ""):
                    error_message = f"{error_message}; {drainer_error}" if error_message else drainer_error
        if child_tmpdir is not None and child_tmpdir.exists():
            try:
                shutil.rmtree(child_tmpdir)
                tmpdir_removed = True
            except OSError as error:
                tmpdir_cleanup_error = f"child tmpdir removal failed: {error}"
                if terminal == "complete":
                    terminal = "error"
                    error_message = tmpdir_cleanup_error
                elif tmpdir_cleanup_error not in (error_message or ""):
                    error_message = (
                        f"{error_message}; {tmpdir_cleanup_error}" if error_message else tmpdir_cleanup_error
                    )

    if process is None:
        elapsed_ms = (time.monotonic() - started) * 1000
        return {
            "status": terminal,
            "elapsed_ms": elapsed_ms,
            "exit_code": None,
            "stdout": b"",
            "error": error_message or None,
            "parent_observed": {
                "peak_rss_bytes": peak_rss,
                "rss_sampling_available": rss_available,
                "rss_sample_interval_seconds": rss_interval,
                "cpu_sampling_available": cpu_available,
                "cpu_sample_interval_seconds": rss_interval,
                "peak_cpu_jiffies": peak_cpu_jiffies,
                "child_tmpdir": str(child_tmpdir) if child_tmpdir else None,
                "child_tmpdir_removed": tmpdir_removed,
                "child_tmpdir_cleanup_error": tmpdir_cleanup_error,
            },
        }

    if time.monotonic() > absolute_deadline and terminal == "complete":
        terminal = "timeout"
        error_message = "cleanup crossed absolute deadline"

    elapsed_ms = (time.monotonic() - started) * 1000
    return {
        "status": terminal,
        "elapsed_ms": elapsed_ms,
        "exit_code": process.returncode,
        "stdout": stdout[:stdout_limit],
        "error": error_message or None,
        "parent_observed": {
            "peak_rss_bytes": peak_rss,
            "rss_sampling_available": rss_available,
            "rss_sample_interval_seconds": rss_interval,
            "cpu_sampling_available": cpu_available,
            "cpu_sample_interval_seconds": rss_interval,
            "peak_cpu_jiffies": peak_cpu_jiffies,
            "child_tmpdir": str(child_tmpdir) if child_tmpdir else None,
            "child_tmpdir_removed": tmpdir_removed,
            "child_tmpdir_cleanup_error": tmpdir_cleanup_error,
        },
    }


def require_positive_int(value: Any, field_name: str) -> int:
    if type(value) is not int or isinstance(value, bool):
        raise ProbeError(f"{field_name} must be a positive integer")
    if value <= 0:
        raise ProbeError(f"{field_name} must be positive")
    return value


def require_json_object(value: Any, field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProbeError(f"{field_name} must be a JSON object")
    return value


def validate_owned_source_image(
    data: bytes,
    *,
    expected_sha256: str,
    width: int,
    height: int,
    case_id: str,
) -> None:
    enforce_owned_bytes_digest(data, expected_sha256)
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        if image.format not in {"PNG", "JPEG", "WEBP"}:
            raise ProbeError(f"unsupported source image format for {case_id}")
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ProbeError(f"source pixel cap exceeded for {case_id}")
        if (image.width, image.height) != (width, height):
            raise ProbeError(f"decoded source dimensions differ from manifest for {case_id}")
        if image.getexif().get(274, 1) != 1:
            raise ProbeError(f"source orientation is not already normalized for {case_id}")


def load_fixed_cases(
    manifest_dir: Path, image_root: Path, grounded_mod: Any
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, dict[str, Any]]]:
    cases: list[dict[str, Any]] = []
    manifest_hashes: dict[str, str] = {}
    manifest_receipts: dict[str, dict[str, Any]] = {}
    root = image_root.resolve(strict=True)
    manifest_dir = manifest_dir.resolve(strict=True)
    for name, accepted in MANIFEST_ACCEPTED_SHA256.items():
        path = manifest_dir / name
        session = VerifiedAssetSession()
        try:
            opened = session.open_verified(path)
            raw = opened.read_all_bytes()
            digest = opened.sha256
            if sha256_bytes(raw) != digest:
                raise ProbeError(f"manifest reread digest mismatch: {name}")
        finally:
            session.close()
        if digest not in accepted:
            raise ProbeError(f"fixed manifest hash mismatch: {name}")
        manifest_receipts[name] = {
            "path": str(opened.path.resolve()),
            "sha256": digest,
            "bytes": opened.size,
        }
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, list):
            raise ProbeError(f"manifest must be a list: {name}")
        rows: list[dict[str, Any]] = []
        for index, row in enumerate(parsed):
            if not isinstance(row, dict):
                raise ProbeError(f"manifest row must be object in {name}[{index}]")
            rows.append(row)
        if tuple(row.get("caseId") for row in rows) != MANIFEST_CASE_IDS[name]:
            raise ProbeError(f"manifest case order differs: {name}")
        for row in rows:
            case_id = row.get("caseId")
            if not isinstance(case_id, str):
                raise ProbeError(f"manifest caseId must be a string in {name}")
            locate = require_json_object(row.get("locate"), f"locate in {name}/{case_id}")
            image = require_json_object(row.get("image"), f"image in {name}/{case_id}")
            target = locate.get("target")
            if not isinstance(target, str):
                raise ProbeError(f"missing authored target in {name}")
            image_path = image.get("path")
            if not isinstance(image_path, str):
                raise ProbeError(f"image.path must be a string in {name}/{case_id}")
            image_sha = image.get("sha256")
            if not isinstance(image_sha, str):
                raise ProbeError(f"image.sha256 must be a string in {name}/{case_id}")
            width = require_positive_int(image.get("width"), f"image.width in {name}/{case_id}")
            height = require_positive_int(image.get("height"), f"image.height in {name}/{case_id}")
            if width * height > MAX_IMAGE_PIXELS:
                raise ProbeError(f"source pixel cap exceeded for {case_id}")
            normalized = grounded_mod.normalize_target(target)
            source_path = (root / image_path).resolve(strict=True)
            try:
                source_path.relative_to(root)
            except ValueError as error:
                raise ProbeError("source path escaped configured image root") from error
            session = VerifiedAssetSession()
            try:
                opened = session.open_verified(source_path, expected_sha256=image_sha)
                if opened.size > MAX_IMAGE_BYTES:
                    raise ProbeError(f"source byte cap exceeded for {case_id}")
                owned_source = opened.read_all_bytes()
                validate_owned_source_image(
                    owned_source,
                    expected_sha256=image_sha,
                    width=width,
                    height=height,
                    case_id=case_id,
                )
                digest_source = opened.sha256
                size = opened.size
            finally:
                session.close()
            cases.append(
                {
                    "case_id": case_id,
                    "manifest_file": name,
                    "source_path": str(source_path),
                    "source_sha256": digest_source,
                    "source_bytes": size,
                    "width": width,
                    "height": height,
                    "authored_target": target,
                    "normalized_target": normalized,
                }
            )
        manifest_hashes[name] = digest
    if tuple(item["case_id"] for item in cases) != EXPECTED_CASE_IDS:
        raise ProbeError("twelve-case DEV cohort mismatch")
    return cases, manifest_hashes, manifest_receipts


def parse_python_freeze_pins(text: str) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "==" not in stripped:
            continue
        name, version = stripped.split("==", 1)
        pins[name.strip().lower()] = version.strip()
    return pins


def verify_model_assets(assets_dir: Path, grounded_mod: Any) -> dict[str, Any]:
    assets_dir = assets_dir.resolve(strict=True)
    session = VerifiedAssetSession()
    verified: list[dict[str, Any]] = []
    try:
        for item in grounded_mod.MODEL_FILES:
            path = assets_dir / item["directory"] / item["filename"]
            if path.is_symlink() or not path.is_file():
                raise ProbeError(f"missing pinned model file: {path}")
            opened = session.open_verified(path, expected_sha256=item["sha256"], expected_size=item["size"])
            verified.append(
                {
                    "path": str(path),
                    "sha256": opened.sha256,
                    "bytes": opened.size,
                    "filename": item["filename"],
                    "verified_fd": opened.fd,
                }
            )
        omni_model = assets_dir / "omniparser-v3" / "model.pt"
        omni_license = assets_dir / "omniparser-v3" / "LICENSE"
        omni_open = session.open_verified(
            omni_model, expected_sha256=OMNI_MODEL_SHA256, expected_size=OMNI_MODEL_BYTES
        )
        license_open = session.open_verified(
            omni_license, expected_sha256=OMNI_LICENSE_SHA256, expected_size=OMNI_LICENSE_BYTES
        )
        verified.append({**verified_open_receipt(omni_open), "filename": "omniparser-v3/model.pt"})
        verified.append({**verified_open_receipt(license_open), "filename": "omniparser-v3/LICENSE"})
        manifest_path = assets_dir / "asset-manifest.json"
        manifest_open = session.open_verified(manifest_path, expected_sha256=ASSET_MANIFEST_SHA256)
        manifest_receipt = verified_open_receipt(manifest_open)
        runtime_freeze = assets_dir / "python-freeze.txt"
        if not runtime_freeze.is_file():
            raise ProbeError("missing python-freeze.txt in assets directory")
        freeze_open = session.open_verified(runtime_freeze)
        runtime_receipt = {
            **verified_open_receipt(freeze_open),
            "pins": parse_python_freeze_pins(freeze_open.read_all_bytes().decode("utf-8")),
        }
        return {
            "assets_dir": str(assets_dir),
            "asset_manifest": manifest_receipt,
            "python_freeze": runtime_receipt,
            "verified_files": [{k: v for k, v in item.items() if k != "verified_fd"} for item in verified],
        }
    finally:
        session.close()


def prepare_verified_loader_paths(assets_dir: Path, grounded_mod: Any, session: VerifiedAssetSession) -> dict[str, Path]:
    assets_dir = assets_dir.resolve(strict=True)
    model_dirs: dict[str, list[tuple[Path, VerifiedOpenFile]]] = {}
    for item in grounded_mod.MODEL_FILES:
        path = assets_dir / item["directory"] / item["filename"]
        if path.is_symlink() or not path.is_file():
            raise ProbeError(f"missing pinned model file: {path}")
        opened = session.open_verified(path, expected_sha256=item["sha256"], expected_size=item["size"])
        model_dirs.setdefault(item["directory"], []).append((Path(item["filename"]), opened))
    prepared: dict[str, Path] = {}
    for directory, files in model_dirs.items():
        prepared[directory] = session.materialize_fd_tree(files)
    omni_model = assets_dir / "omniparser-v3" / "model.pt"
    omni_open = session.open_verified(
        omni_model, expected_sha256=OMNI_MODEL_SHA256, expected_size=OMNI_MODEL_BYTES
    )
    prepared["omniparser-v3"] = session.materialize_fd_tree([(Path("model.pt"), omni_open)])
    manifest_path = assets_dir / "asset-manifest.json"
    session.open_verified(manifest_path, expected_sha256=ASSET_MANIFEST_SHA256)
    runtime_freeze = assets_dir / "python-freeze.txt"
    freeze_open = session.open_verified(runtime_freeze)
    prepared["python-freeze.txt"] = session.materialize_small_file(freeze_open, suffix=".txt")
    return prepared


def distribution_receipt(package_name: str) -> dict[str, Any] | None:
    try:
        dist = importlib.metadata.distribution(package_name)
    except importlib.metadata.PackageNotFoundError:
        return None
    receipt: dict[str, Any] = {"name": dist.metadata["Name"], "version": dist.version}
    try:
        direct_url = dist.read_text("direct_url.json")
        if direct_url:
            receipt["direct_url_sha256"] = sha256_bytes(direct_url.encode("utf-8"))
    except (FileNotFoundError, OSError, KeyError):
        pass
    return receipt


def collect_runtime_receipt(require_pinned: bool, *, freeze_pins: dict[str, str] | None = None) -> dict[str, Any]:
    receipt: dict[str, Any] = {
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "python_implementation": sys.implementation.name,
        "proc_metrics_available": proc_metrics_available(),
    }
    if require_pinned and receipt["python"] != EXPECTED_PYTHON:
        raise ProbeError(f"python version pin mismatch: {receipt['python']}")
    packages: dict[str, Any] = {}
    for package_name in PINNED_RUNTIME_PACKAGES:
        dist = distribution_receipt(package_name)
        if dist is None:
            if require_pinned:
                raise ProbeError(f"runtime package missing: {package_name}")
            packages[package_name] = None
            continue
        packages[package_name] = dist
        if require_pinned and freeze_pins is not None:
            pin_key = package_name.lower()
            expected = freeze_pins.get(pin_key)
            if expected is not None and dist["version"] != expected:
                raise ProbeError(f"{package_name} pin mismatch: {dist['version']} != {expected}")
    receipt["packages"] = packages
    try:
        import torch
        import transformers

        receipt["torch"] = torch.__version__
        receipt["transformers"] = transformers.__version__
        receipt["cuda_available"] = bool(torch.cuda.is_available())
        if require_pinned:
            if receipt["torch"] != EXPECTED_TORCH:
                raise ProbeError(f"torch pin mismatch: {receipt['torch']}")
            if receipt["transformers"] != EXPECTED_TRANSFORMERS:
                raise ProbeError(f"transformers pin mismatch: {receipt['transformers']}")
            if receipt["cuda_available"]:
                raise ProbeError("CUDA must be unavailable for CPU recipe")
    except ImportError as error:
        if require_pinned:
            raise ProbeError(f"runtime import failed: {error}") from error
        receipt["torch"] = None
        receipt["transformers"] = None
        receipt["cuda_available"] = None
    return receipt


def collect_run_freeze_code_receipts() -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    session = VerifiedAssetSession()
    try:
        probe_open = session.open_verified(Path(__file__).resolve())
        probe_receipt = verified_open_receipt(probe_open)
        helpers: list[dict[str, Any]] = []
        code_sources: list[dict[str, Any]] = [probe_receipt]
        for relative, digest in PINNED_HELPERS:
            helper_open = session.open_verified(REPO_ROOT / relative, expected_sha256=digest)
            entry = {"relative_path": relative, **verified_open_receipt(helper_open)}
            helpers.append(entry)
            code_sources.append(entry)
        return probe_receipt, helpers, code_sources
    finally:
        session.close()


def runtime_closure_digest() -> str:
    _, _, code_sources = collect_run_freeze_code_receipts()
    return sha256_bytes(json.dumps(code_sources, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def assert_runtime_closure_unchanged(expected_digest: str) -> None:
    if runtime_closure_digest() != expected_digest:
        raise ProbeError("runtime/input closure changed since run start")


def build_run_freeze_v2(
    *,
    hypothesis_receipt: dict[str, Any],
    assets_dir: Path,
    manifest_dir: Path,
    image_root: Path,
    cases: list[dict[str, Any]],
    manifest_receipts: dict[str, dict[str, Any]],
    asset_receipts: dict[str, Any],
    runtime: dict[str, Any],
    probe_receipt: dict[str, Any],
    helper_receipts: list[dict[str, Any]],
    code_sources: list[dict[str, Any]],
) -> dict[str, Any]:
    runtime_closure = {
        "code_sources": code_sources,
        "closure_sha256": sha256_bytes(
            json.dumps(code_sources, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ),
    }
    sources = [
        {
            "case_id": case["case_id"],
            "source": {
                "path": case["source_path"],
                "sha256": case["source_sha256"],
                "bytes": case["source_bytes"],
            },
            "normalized_target": case["normalized_target"],
        }
        for case in cases
    ]
    manifests = [{"file": name, **manifest_receipts[name]} for name in MANIFEST_ACCEPTED_SHA256]
    return {
        "schema": RUN_FREEZE_SCHEMA,
        "recipe_id": RECIPE_ID,
        "hypothesis_freeze": hypothesis_receipt,
        "probe_script": probe_receipt,
        "pinned_helpers": helper_receipts,
        "manifests": manifests,
        "sources": sources,
        "assets_dir": str(assets_dir.resolve()),
        "manifest_dir": str(manifest_dir.resolve()),
        "image_root": str(image_root.resolve()),
        "asset_receipts": asset_receipts,
        "runtime": runtime,
        "runtime_closure": runtime_closure,
        "limits": {
            "per_case_deadline_seconds": CASE_DEADLINE_SECONDS,
            "max_rss_bytes": MAX_RSS_BYTES,
            "rss_sample_interval_seconds": RSS_SAMPLE_INTERVAL_SECONDS,
            "max_stdout_bytes": MAX_STDOUT_BYTES,
            "max_stderr_bytes": MAX_STDERR_BYTES,
            "max_source_bytes": MAX_IMAGE_BYTES,
            "max_source_pixels": MAX_IMAGE_PIXELS,
            "max_candidates_per_family": MAX_CANDIDATES_PER_FAMILY,
            "max_candidates_total": MAX_CANDIDATES_TOTAL,
            "max_packed_mask_bytes": MAX_PACKED_BYTES,
            "source_byte_ownership": True,
        },
        "device": "cpu",
        "dtype": "float32",
        "torch_intraop_threads": 8,
        "torch_interop_threads": 1,
        "blas_openmp_threads": 1,
    }


def open_hypothesis_receipt(path: Path) -> dict[str, Any]:
    session = VerifiedAssetSession()
    try:
        opened = session.open_verified(path, expected_sha256=HYPOTHESIS_FREEZE_SHA256)
        return verified_open_receipt(opened)
    finally:
        session.close()


def rebuild_run_freeze_v2(
    *,
    hypothesis_receipt: dict[str, Any],
    assets_dir: Path,
    manifest_dir: Path,
    image_root: Path,
    grounded_mod: Any,
) -> dict[str, Any]:
    cases, _manifest_hashes, manifest_receipts = load_fixed_cases(manifest_dir, image_root, grounded_mod)
    probe_receipt, helper_receipts, code_sources = collect_run_freeze_code_receipts()
    asset_receipts = verify_model_assets(assets_dir, grounded_mod)
    runtime = collect_runtime_receipt(require_pinned=True, freeze_pins=asset_receipts["python_freeze"]["pins"])
    return build_run_freeze_v2(
        hypothesis_receipt=hypothesis_receipt,
        assets_dir=assets_dir,
        manifest_dir=manifest_dir,
        image_root=image_root,
        cases=cases,
        manifest_receipts=manifest_receipts,
        asset_receipts=asset_receipts,
        runtime=runtime,
        probe_receipt=probe_receipt,
        helper_receipts=helper_receipts,
        code_sources=code_sources,
    )


def assert_run_freeze_document_unchanged(
    expected_document: dict[str, Any],
    *,
    hypothesis_receipt: dict[str, Any],
    assets_dir: Path,
    manifest_dir: Path,
    image_root: Path,
    grounded_mod: Any,
) -> None:
    current = rebuild_run_freeze_v2(
        hypothesis_receipt=hypothesis_receipt,
        assets_dir=assets_dir,
        manifest_dir=manifest_dir,
        image_root=image_root,
        grounded_mod=grounded_mod,
    )
    if json.dumps(current, sort_keys=True) != json.dumps(expected_document, sort_keys=True):
        raise ProbeError("run-freeze closure changed since run start")


def validate_run_freeze_document(
    document: dict[str, Any],
    *,
    assets_dir: Path,
    manifest_dir: Path,
    image_root: Path,
    grounded_mod: Any,
) -> None:
    if document.get("schema") != RUN_FREEZE_SCHEMA:
        raise ProbeError("run-freeze schema mismatch")
    if document.get("recipe_id") != RECIPE_ID:
        raise ProbeError("run-freeze recipe_id mismatch")
    if document.get("hypothesis_freeze", {}).get("sha256") != HYPOTHESIS_FREEZE_SHA256:
        raise ProbeError("run-freeze hypothesis freeze mismatch")
    hypothesis_receipt = open_hypothesis_receipt(Path(str(document["hypothesis_freeze"]["path"])))
    assert_run_freeze_document_unchanged(
        document,
        hypothesis_receipt=hypothesis_receipt,
        assets_dir=assets_dir,
        manifest_dir=manifest_dir,
        image_root=image_root,
        grounded_mod=grounded_mod,
    )


def worker_case(payload_path: Path) -> int:
    try:
        payload_path = payload_path.resolve(strict=True)
    except OSError as error:
        raise ProbeError(f"worker payload missing: {payload_path}") from error
    os.environ.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
        }
    )
    payload = validate_worker_payload(json.loads(payload_path.read_text(encoding="utf-8")))
    output_dir = payload["output_dir"]
    case_id = payload["case_id"]
    timings: dict[str, float] = {}
    started = time.monotonic()
    error_type: str | None = None
    error_message: str | None = None
    result: dict[str, Any] = {"case_id": case_id, "status": "error"}

    asset_session = VerifiedAssetSession()
    try:
        grounded, omni_mod, h4e, h5a = load_all_pinned_helpers()
        import numpy as np
        import torch
        from PIL import Image
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor

        if torch.cuda.is_available():
            raise ProbeError("CUDA must be unavailable for CPU recipe")
        torch.set_num_threads(8)
        torch.set_num_interop_threads(1)
        device = torch.device("cpu")

        assets_dir = payload["assets_dir"]
        assets_dir = assets_dir.resolve(strict=True)
        verify_model_assets(assets_dir, grounded)
        loader_paths = prepare_verified_loader_paths(assets_dir, grounded, asset_session)
        freeze_pins = parse_python_freeze_pins(loader_paths["python-freeze.txt"].read_text(encoding="utf-8"))
        collect_runtime_receipt(require_pinned=True, freeze_pins=freeze_pins)

        source_path = payload["source_path"]
        source_path = source_path.resolve(strict=True)
        source_open = asset_session.open_verified(source_path, expected_sha256=payload["source_sha256"])
        if source_open.size > MAX_IMAGE_BYTES:
            raise ProbeError("source byte ownership or hash check failed")
        owned_source = source_open.read_all_bytes()
        enforce_owned_bytes_digest(owned_source, payload["source_sha256"])
        enforce_owned_bytes_digest(owned_source, source_open.sha256)
        with Image.open(io.BytesIO(owned_source)) as opened:
            image = opened.convert("RGB")
        width, height = image.size
        if (width, height) != (payload["width"], payload["height"]):
            raise ProbeError("decoded source dimensions differ from producer input")

        dino_dir = loader_paths["grounding-dino-tiny"]
        sam_dir = loader_paths["sam2-hiera-tiny"]
        omni_model = loader_paths["omniparser-v3"] / "model.pt"

        load_started = time.monotonic()
        dino_processor = AutoProcessor.from_pretrained(dino_dir, local_files_only=True)
        dino_model = AutoModelForZeroShotObjectDetection.from_pretrained(
            dino_dir, local_files_only=True, use_safetensors=True, torch_dtype=torch.float32
        ).to(device).eval()
        sam_processor = Sam2Processor.from_pretrained(sam_dir, local_files_only=True)
        sam_model = Sam2Model.from_pretrained(
            sam_dir, local_files_only=True, use_safetensors=True, torch_dtype=torch.float32
        ).to(device).eval()
        timings["load_ms"] = (time.monotonic() - load_started) * 1000

        normalized_target = payload["normalized_target"]
        if not isinstance(normalized_target, str):
            raise ProbeError("normalized_target must be a string")
        detector_prompt = f"a {normalized_target}"

        dino_started = time.monotonic()
        inputs = dino_processor(images=image, text=[[detector_prompt]], return_tensors="pt").to(device)
        with torch.inference_mode():
            raw_outputs = dino_model(**inputs)
        detections = dino_processor.post_process_grounded_object_detection(
            raw_outputs,
            inputs.input_ids,
            threshold=BOX_THRESHOLD,
            text_threshold=TEXT_THRESHOLD,
            target_sizes=[(height, width)],
        )[0]
        raw_boxes = detections["boxes"].detach().float().cpu().tolist()
        raw_scores = detections["scores"].detach().float().cpu().tolist()
        all_detections: list[dict[str, Any]] = []
        for index, (box, score) in enumerate(zip(raw_boxes, raw_scores, strict=True)):
            all_detections.append(
                {
                    "detector_index": index,
                    "box_xyxy": grounded.validate_box(box, width, height),
                    "score": float(score),
                }
            )
        d_bounded, d_truncated = grounded.bound_detections(all_detections)
        timings["dino_ms"] = (time.monotonic() - dino_started) * 1000

        omni_started = time.monotonic()
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(owned_source)
            tmp_path = Path(tmp.name)
        try:
            source_record = {
                "source": tmp_path,
                "receipt": {"sha256": payload["source_sha256"], "bytes": len(owned_source)},
                "width": width,
                "height": height,
                "case_ids": [],
            }
            omni_result = omni_mod.run_inference(source_record, omni_model, "cpu")
        finally:
            tmp_path.unlink(missing_ok=True)
        u_candidates = omni_result["candidates"]
        timings["omni_ms"] = (time.monotonic() - omni_started) * 1000

        d_count = len(d_bounded)
        u_count = len(u_candidates)
        h5a.validate_mask_count(width, height, d_count, u_count)
        prospective_packed = aggregate_packed_limit(width, height, d_count, u_count)
        if prospective_packed > MAX_PACKED_BYTES:
            raise ProbeError("aggregate packed-mask limit exceeded before SAM2 decode")

        sam_started = time.monotonic()
        image_inputs = sam_processor(images=image, return_tensors="pt").to(device)
        with torch.inference_mode():
            image_embeddings = sam_model.get_image_embeddings(image_inputs["pixel_values"])

        def decode_serial(boxes: list[list[float]], family: str, detector_meta: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
            records: list[dict[str, Any]] = []
            for index, box in enumerate(boxes):
                box_inputs = sam_processor(images=image, input_boxes=[[box]], return_tensors="pt").to(device)
                with torch.inference_mode():
                    outputs = sam_model(
                        image_embeddings=image_embeddings,
                        input_boxes=box_inputs["input_boxes"],
                        multimask_output=False,
                    )
                masks = sam_processor.post_process_masks(outputs.pred_masks.cpu(), box_inputs["original_sizes"])[0]
                array = np.squeeze(masks[0].detach().float().cpu().numpy())
                if array.shape != (height, width):
                    raise ProbeError("SAM2 mask is not source-sized")
                binary = array > 0.0
                packed = pack_mask_with_validation(binary, width, height)
                meta: dict[str, Any] = {
                    "id": f"{family}{index:02d}",
                    "family": family,
                    "ordinal": index,
                    "box_xyxy": box,
                    "packed_sha256": sha256_bytes(packed),
                    "packed_bytes": len(packed),
                    "mask_box_xyxy": mask_bbox_np(binary),
                    "empty": not bool(np.any(binary)),
                    "sam2_mask_threshold": 0.0,
                }
                if detector_meta is not None:
                    meta.update(
                        {
                            "detector_index": detector_meta[index]["detector_index"],
                            "score": detector_meta[index]["score"],
                        }
                    )
                elif family == "U":
                    src = u_candidates[index]
                    meta.update({"flat_index": src["flat_index"], "score": src["score"], "omni_box_xyxy": src["box_xyxy"]})
                records.append({**meta, "_packed": packed})
            return records

        d_boxes = [item["box_xyxy"] for item in d_bounded]
        u_boxes = [h4e.expand_prompt_box(item["box_xyxy"], width, height) for item in u_candidates]
        d_records = decode_serial(d_boxes, "D", d_bounded)
        u_records = decode_serial(u_boxes, "U", None)
        timings["sam2_ms"] = (time.monotonic() - sam_started) * 1000

        pack_started = time.monotonic()
        mask_dir = output_dir / "packed-masks" / case_id
        mask_dir.mkdir(parents=True, exist_ok=True)
        total_packed = 0
        written: list[dict[str, Any]] = []
        for record in d_records + u_records:
            packed_bytes = record.pop("_packed")
            validate_packed_bytes(packed_bytes, width, height)
            total_packed += len(packed_bytes)
            if total_packed > MAX_PACKED_BYTES:
                raise ProbeError("aggregate packed-mask limit exceeded")
            packed_path = mask_dir / f"{record['id']}.bin"
            packed_path.write_bytes(packed_bytes)
            written.append({**record, "packed_path": str(packed_path.relative_to(output_dir))})
        timings["pack_ms"] = (time.monotonic() - pack_started) * 1000

        usage = resource.getrusage(resource.RUSAGE_SELF)
        child_cpu_ms = (usage.ru_utime + usage.ru_stime) * 1000
        result = {
            "case_id": case_id,
            "status": "complete",
            "child_status": "complete",
            "parent_status": None,
            "semantic_decision_executed": False,
            "quality_measured": False,
            "quality_evidence": False,
            "detector_masks_generated": True,
            "proposal_masks_generated": True,
            "producer_input": {
                "source_sha256": payload["source_sha256"],
                "source_dimensions": {"width": width, "height": height},
                "normalized_target": normalized_target,
                "detector_prompt": detector_prompt,
            },
            "dino": {
                "candidate_count": len(all_detections),
                "retained": d_count,
                "truncated": d_truncated,
                "candidates": [{k: v for k, v in item.items() if k != "_packed"} for item in d_records],
            },
            "omni": {
                "candidate_count": u_count,
                "truncated": omni_result.get("truncated", 0),
                "candidates": [{k: v for k, v in item.items() if k != "_packed"} for item in u_records],
            },
            "packed_masks": written,
            "packed_mask_bytes_total": total_packed,
            "timing_ms": {
                **timings,
                "child_total_ms": (time.monotonic() - started) * 1000,
                "child_cpu_ms": child_cpu_ms,
            },
            "runtime": collect_runtime_receipt(require_pinned=True, freeze_pins=freeze_pins),
        }
        write_json_atomic(output_dir / "cases" / f"{case_id}.json", result)
        print(json.dumps({"case_id": case_id, "status": "complete", "packed_mask_bytes_total": total_packed}), flush=True)
        return 0
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            raise
        error_type = type(error).__name__
        error_message = str(error)[:1000]
        status = "error"
        result = {
            "case_id": case_id,
            "status": status,
            "child_status": status,
            "parent_status": None,
            "semantic_decision_executed": False,
            "quality_measured": False,
            "quality_evidence": False,
            "detector_masks_generated": False,
            "proposal_masks_generated": False,
            "error_type": error_type,
            "error": error_message,
            "timing_ms": {"child_total_ms": (time.monotonic() - started) * 1000},
        }
        write_json_atomic(output_dir / "cases" / f"{case_id}.json", result)
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"case_id": case_id, "status": status, "error_type": error_type, "error": error_message}), flush=True)
        return 1
    finally:
        asset_session.close()


def merge_parent_case_row(
    case_id: str,
    child: dict[str, Any],
    existing: dict[str, Any] | None,
) -> dict[str, Any]:
    row = dict(existing or {"case_id": case_id})
    child_status = row.get("child_status", row.get("status", "unknown"))
    parent_status = child["status"]
    if parent_status == "complete" and child_status != "complete":
        parent_status = "error"
    row["child_status"] = child_status
    row["parent_status"] = parent_status
    row["status"] = parent_status
    row["semantic_decision_executed"] = False
    row["quality_measured"] = False
    row["quality_evidence"] = False
    row.setdefault("detector_masks_generated", parent_status == "complete" and bool(row.get("dino")))
    row.setdefault("proposal_masks_generated", parent_status == "complete" and bool(row.get("omni")))
    row["parent_elapsed_ms"] = child["elapsed_ms"]
    row["parent_observed"] = child["parent_observed"]
    row["exit_code"] = child["exit_code"]
    if parent_status != "complete":
        row["parent_error"] = child.get("error")
    return row


def mark_remaining_not_run(output_dir: Path, cases: list[dict[str, Any]], after_index: int, failed_case_id: str) -> None:
    for index in range(after_index + 1, len(cases)):
        case_id = cases[index]["case_id"]
        row = {"case_id": case_id, "status": "not_run_after_first_error", "after_case_id": failed_case_id}
        write_json_atomic(output_dir / "cases" / f"{case_id}.json", row)


def run_parent(args: argparse.Namespace) -> int:
    grounded, _, _, _ = load_all_pinned_helpers()

    hypothesis_path = args.hypothesis_freeze.resolve(strict=True)
    hypothesis_receipt = open_hypothesis_receipt(hypothesis_path)

    assets_dir = args.assets_dir.resolve(strict=True)
    manifest_dir = args.manifest_dir.resolve(strict=True)
    image_root = args.image_root.resolve(strict=True)
    cases, _manifest_hashes, manifest_receipts = load_fixed_cases(manifest_dir, image_root, grounded)
    asset_receipts = verify_model_assets(assets_dir, grounded)
    probe_receipt, helper_receipts, code_sources = collect_run_freeze_code_receipts()

    if args.case_id:
        validate_case_id(args.case_id)
        cases = [case for case in cases if case["case_id"] == args.case_id]
        if not cases:
            raise ProbeError(f"unknown case id: {args.case_id}")

    if args.write_run_freeze_v2 and args.output:
        raise ProbeError("cannot combine --write-run-freeze-v2 with --output in one invocation")

    runtime_receipt = collect_runtime_receipt(require_pinned=True, freeze_pins=asset_receipts["python_freeze"]["pins"])

    if args.write_run_freeze_v2:
        freeze_path = require_external_output_path(args.write_run_freeze_v2, "--write-run-freeze-v2")
        if freeze_path.exists():
            raise ProbeError("run-freeze output path already exists")
        freeze_cases = cases
        freeze_manifest_receipts = manifest_receipts
        if args.case_id:
            freeze_cases, _, freeze_manifest_receipts = load_fixed_cases(manifest_dir, image_root, grounded)
        freeze_doc = build_run_freeze_v2(
            hypothesis_receipt=hypothesis_receipt,
            assets_dir=assets_dir,
            manifest_dir=manifest_dir,
            image_root=image_root,
            cases=freeze_cases,
            manifest_receipts=freeze_manifest_receipts,
            asset_receipts=asset_receipts,
            runtime=runtime_receipt,
            probe_receipt=probe_receipt,
            helper_receipts=helper_receipts,
            code_sources=code_sources,
        )
        write_json_atomic(freeze_path, freeze_doc)
        print(json.dumps({"status": "run-freeze-v2-written", "path": str(freeze_path)}))
        return 0

    if not args.output:
        raise ProbeError("--output is required for native execution")
    if not args.run_freeze:
        raise ProbeError("--run-freeze is required for native execution")
    if not proc_metrics_available():
        raise ProbeError("/proc metrics unavailable; refusing native launch with RSS cap")

    run_freeze_path = args.run_freeze.resolve(strict=True)
    run_freeze_doc = json.loads(run_freeze_path.read_text(encoding="utf-8"))
    validate_run_freeze_document(
        run_freeze_doc,
        assets_dir=assets_dir,
        manifest_dir=manifest_dir,
        image_root=image_root,
        grounded_mod=grounded,
    )

    output_dir = require_external_output_path(args.output, "--output")
    reserve_new_directory(output_dir)
    for sub in ("cases", "worker-input", "worker-logs", "packed-masks"):
        (output_dir / sub).mkdir()

    all_cases, _, _ = load_fixed_cases(manifest_dir, image_root, grounded)
    selected_cases = cases
    case_status: dict[str, str] = {case["case_id"]: "not_started" for case in all_cases}
    run_freeze_closure_error: str | None = None

    run_record: dict[str, Any] = {
        "schema": "zorya-classifier-h8a-cpu-run-v1",
        "recipe_id": RECIPE_ID,
        "status": "running",
        "benchmark_only": True,
        "semantic_decision_executed": False,
        "quality_measured": False,
        "quality_evidence": False,
        "hypothesis_freeze_sha256": HYPOTHESIS_FREEZE_SHA256,
        "runtime_closure_sha256": runtime_closure_digest(),
        "run_freeze": file_receipt(run_freeze_path),
        "case_ids": list(EXPECTED_CASE_IDS),
        "cases": [{"case_id": case_id, "status": "not_started"} for case_id in EXPECTED_CASE_IDS],
    }
    write_json_atomic(output_dir / "run.json", run_record)
    closure_digest = run_record["runtime_closure_sha256"]

    failed_case_id: str | None = None
    for case in selected_cases:
        try:
            assert_runtime_closure_unchanged(closure_digest)
            assert_run_freeze_document_unchanged(
                run_freeze_doc,
                hypothesis_receipt=hypothesis_receipt,
                assets_dir=assets_dir,
                manifest_dir=manifest_dir,
                image_root=image_root,
                grounded_mod=grounded,
            )
        except ProbeError as error:
            run_freeze_closure_error = str(error)
            failed_case_id = case["case_id"]
            case_status[case["case_id"]] = "error"
            write_json_atomic(
                output_dir / "cases" / f"{case['case_id']}.json",
                {
                    "case_id": case["case_id"],
                    "status": "error",
                    "parent_error": run_freeze_closure_error,
                    "semantic_decision_executed": False,
                    "quality_measured": False,
                    "quality_evidence": False,
                },
            )
            if args.case_id is None:
                global_index = next(index for index, item in enumerate(all_cases) if item["case_id"] == case["case_id"])
                mark_remaining_not_run(output_dir, all_cases, global_index, case["case_id"])
                for remaining in all_cases[global_index + 1 :]:
                    case_status[remaining["case_id"]] = "not_run_after_first_error"
            break
        payload = {
            "case_id": case["case_id"],
            "output_dir": str(output_dir),
            "assets_dir": str(assets_dir),
            "source_path": case["source_path"],
            "source_sha256": case["source_sha256"],
            "width": case["width"],
            "height": case["height"],
            "normalized_target": case["normalized_target"],
        }
        payload_path = output_dir / "worker-input" / f"{case['case_id']}.json"
        write_json_atomic(payload_path, payload)
        stderr_path = output_dir / "worker-logs" / f"{case['case_id']}.stderr.log"
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--worker-case",
            str(payload_path),
        ]
        case_tmpdir = output_dir / "worker-tmp" / case["case_id"]
        child = run_bounded_child(
            command,
            deadline_seconds=CASE_DEADLINE_SECONDS,
            stderr_path=stderr_path,
            child_tmpdir=case_tmpdir,
        )
        payload_path.unlink(missing_ok=True)

        parent_status = child["status"]
        if parent_status == "complete" and child["stdout"]:
            try:
                message = json.loads(child["stdout"].decode("utf-8").splitlines()[-1])
                if message.get("status") != "complete":
                    parent_status = str(message.get("status", "error"))
            except (UnicodeDecodeError, json.JSONDecodeError, IndexError):
                parent_status = "error"

        case_row_path = output_dir / "cases" / f"{case['case_id']}.json"
        existing = json.loads(case_row_path.read_text(encoding="utf-8")) if case_row_path.exists() else None
        row = merge_parent_case_row(case["case_id"], {**child, "status": parent_status}, existing)
        write_json_atomic(case_row_path, row)
        case_status[case["case_id"]] = row["status"]

        if row["status"] != "complete":
            failed_case_id = case["case_id"]
            if args.case_id is None:
                global_index = next(index for index, item in enumerate(all_cases) if item["case_id"] == case["case_id"])
                mark_remaining_not_run(output_dir, all_cases, global_index, case["case_id"])
                for remaining in all_cases[global_index + 1 :]:
                    case_status[remaining["case_id"]] = "not_run_after_first_error"
            break

        try:
            assert_runtime_closure_unchanged(closure_digest)
            assert_run_freeze_document_unchanged(
                run_freeze_doc,
                hypothesis_receipt=hypothesis_receipt,
                assets_dir=assets_dir,
                manifest_dir=manifest_dir,
                image_root=image_root,
                grounded_mod=grounded,
            )
        except ProbeError as error:
            run_freeze_closure_error = str(error)
            failed_case_id = case["case_id"]
            case_status[case["case_id"]] = "error"
            write_json_atomic(
                output_dir / "cases" / f"{case['case_id']}.json",
                {
                    **row,
                    "status": "error",
                    "parent_status": "error",
                    "parent_error": run_freeze_closure_error,
                },
            )
            if args.case_id is None:
                global_index = next(index for index, item in enumerate(all_cases) if item["case_id"] == case["case_id"])
                mark_remaining_not_run(output_dir, all_cases, global_index, case["case_id"])
                for remaining in all_cases[global_index + 1 :]:
                    case_status[remaining["case_id"]] = "not_run_after_first_error"
            break

    for case in all_cases:
        case_path = output_dir / "cases" / f"{case['case_id']}.json"
        if case_path.exists():
            continue
        status = case_status[case["case_id"]]
        if status == "not_started":
            status = "not_run"
        payload = {"case_id": case["case_id"], "status": status}
        if status == "not_run_after_first_error" and failed_case_id:
            payload["after_case_id"] = failed_case_id
        write_json_atomic(case_path, payload)
        case_status[case["case_id"]] = status

    try:
        assert_runtime_closure_unchanged(closure_digest)
        assert_run_freeze_document_unchanged(
            run_freeze_doc,
            hypothesis_receipt=hypothesis_receipt,
            assets_dir=assets_dir,
            manifest_dir=manifest_dir,
            image_root=image_root,
            grounded_mod=grounded,
        )
    except ProbeError as error:
        run_freeze_closure_error = str(error)

    all_complete = all(case_status[case_id] == "complete" for case_id in EXPECTED_CASE_IDS)
    if run_freeze_closure_error:
        run_record["status"] = "incomplete"
        run_record["closure_error"] = run_freeze_closure_error
    else:
        run_record["status"] = "complete" if all_complete else "incomplete"
    run_record["cases"] = [{"case_id": case_id, "status": case_status[case_id]} for case_id in EXPECTED_CASE_IDS]
    run_record["finished_monotonic"] = time.monotonic()
    write_json_atomic(output_dir / "run.json", run_record)
    print(
        json.dumps(
            {
                "output_dir": str(output_dir),
                "status": run_record["status"],
                "cases": run_record["cases"],
            }
        )
    )
    return 0 if run_record["status"] == "complete" else 2


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--worker-case" in argv:
        worker_parser = argparse.ArgumentParser(description=__doc__)
        worker_parser.add_argument("--worker-case", type=Path, required=True)
        return worker_parser.parse_args(argv)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hypothesis-freeze", type=Path, required=True)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--manifest-dir", type=Path, required=True)
    parser.add_argument("--image-root", type=Path, required=True)
    parser.add_argument("--run-freeze", type=Path, help="Required closed run-freeze v2 for native execution")
    parser.add_argument("--write-run-freeze-v2", type=Path, help="Write prospective run-freeze v2 JSON to this new path")
    parser.add_argument("--output", type=Path, help="New external output directory")
    parser.add_argument("--case-id", type=str, help="Optional single DEV row smoke restriction")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    try:
        if getattr(args, "worker_case", None):
            return worker_case(args.worker_case)
        if not args.run_freeze and not args.write_run_freeze_v2:
            raise ProbeError("provide --run-freeze for execution and/or --write-run-freeze-v2")
        return run_parent(args)
    except ProbeError as error:
        print(json.dumps({"status": "error", "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
