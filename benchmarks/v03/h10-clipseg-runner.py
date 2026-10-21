#!/usr/bin/env python3
"""H10 CLIPSeg benchmark runner (explicit paths, freeze separated from --run)."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import select
import signal
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

MINIMAL_DEV_MANIFEST_PATH = Path("/root/work/zorya-classifier/.run/v03/h10/minimal-inputs.json")
MAX_WORKER_LINE_BYTES = 8 * 1024 * 1024
MAX_WORKER_STDERR_BYTES = 256 * 1024
WORKER_JOIN_TIMEOUT_SECONDS = 10.0
INIT_RESPONSE_WAIT_SECONDS = 120.0
INIT_RESPONSE_WAIT_FORCED_WRITE_FAILURE_SECONDS = 0.25
FREEZE_SCHEMA = "v03-h10-clipseg-freeze-v1"


def owned_worker_environ() -> dict[str, str]:
    env = os.environ.copy()
    env[h10.EXPECTED_LAUNCHER_PID_ENV] = str(os.getpid())
    return env


def worker_join_timeout_seconds() -> float:
    raw = os.environ.get("H10_WORKER_JOIN_TIMEOUT_SECONDS")
    if raw is None:
        return WORKER_JOIN_TIMEOUT_SECONDS
    return float(raw)

_COMMON_PATH = Path(__file__).with_name("h10-clipseg-common.py")
_spec = importlib.util.spec_from_file_location("h10_clipseg_common", _COMMON_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError("failed to load h10-clipseg-common.py")
h10 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = h10
_spec.loader.exec_module(h10)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def hash_file(path: Path) -> str:
    digest, _ = h10.sha256_file(path)
    return digest


def resolve_python_executable(value: str) -> Path:
    """Keep caller-supplied venv entrypoint; do not follow symlinks to system Python."""
    return Path(value).expanduser().absolute()


def runtime_receipt(python_executable: Path) -> dict[str, str]:
    return h10.collect_runtime_receipt(python_executable)


def assert_minimal_manifest_hash_if_applicable(manifest_path: Path) -> str:
    digest = hash_file(manifest_path)
    if manifest_path.resolve() == MINIMAL_DEV_MANIFEST_PATH.resolve():
        if digest != h10.MINIMAL_DEV_MANIFEST_SHA256:
            raise h10.H10Error(
                f"minimal DEV manifest SHA-256 mismatch: got {digest}, "
                f"expected {h10.MINIMAL_DEV_MANIFEST_SHA256}"
            )
    return digest


def model_visible_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "row_index": row["row_index"],
        "row_key": row["row_key"],
        "source_path": row["source_path"],
        "authored_target": row["authored_target"],
    }


def harness_row(row: dict[str, Any]) -> dict[str, Any]:
    payload = model_visible_row(row)
    source_sha256 = row.get("source_sha256")
    if isinstance(source_sha256, str):
        payload["expected_source_sha256"] = source_sha256
    return payload


def technical_row(row: dict[str, Any], code: str, message: str) -> dict[str, Any]:
    return {
        "type": "row",
        "row_index": row["row_index"],
        "row_key": row["row_key"],
        "authored_target": row["authored_target"],
        "outcome_kind": "technical_error",
        "error_code": code,
        "error_message": message,
        "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def write_jsonl_atomic(path: Path, rows: list[dict[str, Any]]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    os.replace(temporary, path)


class WorkerIpc:
    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self.process = process
        if process.stdout is None or process.stderr is None:
            raise RuntimeError("worker stdio pipes are required")
        self.stdout_fd = process.stdout.fileno()
        self.stderr_fd = process.stderr.fileno()
        os.set_blocking(self.stdout_fd, False)
        os.set_blocking(self.stderr_fd, False)
        self.line_buffer = bytearray()
        self.stderr_total = 0
        self.stderr_tail = bytearray()
        self.stderr_done = threading.Event()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _append_stderr(self, chunk: bytes) -> None:
        remaining = MAX_WORKER_STDERR_BYTES - self.stderr_total
        if remaining <= 0:
            return
        piece = chunk[:remaining]
        self.stderr_total += len(piece)
        self.stderr_tail.extend(piece)
        if len(self.stderr_tail) > 16_384:
            del self.stderr_tail[:-16_384]

    def _drain_stderr(self) -> None:
        if os.environ.get("H10_TEST_STALL_STDERR_DRAIN") == "1":
            while True:
                time.sleep(1.0)
        while True:
            if self.process.poll() is not None:
                try:
                    while True:
                        chunk = os.read(self.stderr_fd, 65_536)
                        if not chunk:
                            break
                        self._append_stderr(chunk)
                except OSError:
                    pass
                self.stderr_done.set()
                return
            ready, _, _ = select.select([self.stderr_fd], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(self.stderr_fd, 65_536)
            except OSError:
                continue
            if not chunk:
                if self.process.poll() is not None:
                    self.stderr_done.set()
                    return
                continue
            self._append_stderr(chunk)

    def read_json_line(self, deadline: float, cancel_event: threading.Event | None = None) -> dict[str, Any]:
        while time.perf_counter() < deadline:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("run cancelled")
            if b"\n" in self.line_buffer:
                raw_line, rest = self.line_buffer.split(b"\n", 1)
                self.line_buffer = bytearray(rest)
                if len(raw_line) > MAX_WORKER_LINE_BYTES:
                    raise RuntimeError("worker stdout line exceeded size cap")
                if not raw_line.strip():
                    continue
                try:
                    return json.loads(raw_line.decode("utf-8"))
                except json.JSONDecodeError as error:
                    raise RuntimeError(f"worker stdout JSON decode failure: {error}") from error
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"worker exited before response (code={self.process.returncode})"
                )
            timeout = max(0.0, deadline - time.perf_counter())
            ready, _, _ = select.select([self.stdout_fd], [], [], min(timeout, 0.25))
            if not ready:
                continue
            try:
                chunk = os.read(self.stdout_fd, 65_536)
            except OSError:
                continue
            if not chunk:
                if self.process.poll() is not None:
                    raise RuntimeError("worker stdout closed before newline")
                continue
            self.line_buffer.extend(chunk)
            if len(self.line_buffer) > MAX_WORKER_LINE_BYTES:
                raise RuntimeError("worker stdout buffer exceeded size cap")
        raise TimeoutError("worker response deadline exceeded")

    def write_json_line(self, payload: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("worker stdin is not available")
        data = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def stderr_text(self) -> str:
        return bytes(self.stderr_tail).decode("utf-8", errors="replace")

    def close(self) -> None:
        join_timeout = worker_join_timeout_seconds()
        cleanup_error: RuntimeError | None = None
        try:
            self._stderr_thread.join(timeout=join_timeout)
            if self._stderr_thread.is_alive() or not self.stderr_done.is_set():
                cleanup_error = RuntimeError(
                    "stderr drainer thread did not finish within bounded join"
                )
        finally:
            for stream in (self.process.stdout, self.process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
        if cleanup_error is not None:
            raise cleanup_error


def kill_owned_worker(process: subprocess.Popen[bytes]) -> None:
    if os.environ.get("H10_TEST_FORCE_CLEANUP_FAILURE") == "1":
        raise RuntimeError("forced worker cleanup failure for offline test")
    if process.poll() is not None:
        return
    pg_id = process.pid
    try:
        os.killpg(pg_id, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=worker_join_timeout_seconds())
    except subprocess.TimeoutExpired:
        pass
    if process.poll() is not None:
        return
    try:
        os.killpg(pg_id, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=worker_join_timeout_seconds())
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("owned worker did not exit after SIGKILL within join timeout") from error


def shutdown_owned_worker(process: subprocess.Popen[bytes], ipc: WorkerIpc | None) -> None:
    if process.stdin is not None:
        try:
            process.stdin.close()
        except OSError:
            pass
    errors: list[str] = []
    try:
        kill_owned_worker(process)
    except RuntimeError as error:
        errors.append(str(error))
    if ipc is not None:
        try:
            ipc.close()
        except RuntimeError as error:
            errors.append(str(error))
    if errors:
        raise RuntimeError("; ".join(errors))


def install_cancel_handlers(cancel_event: threading.Event) -> tuple[Any, Any]:
    previous_int = signal.getsignal(signal.SIGINT)
    previous_term = signal.getsignal(signal.SIGTERM)

    def _handler(_signum: int, _frame: Any) -> None:
        cancel_event.set()

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)
    return previous_int, previous_term


def restore_cancel_handlers(previous: tuple[Any, Any]) -> None:
    signal.signal(signal.SIGINT, previous[0])
    signal.signal(signal.SIGTERM, previous[1])


def derive_run_status(
    rows: list[dict[str, Any]],
    *,
    cleanup_failed: bool,
    cancelled: bool,
) -> str:
    if cleanup_failed:
        return "worker_cleanup_failed"
    if cancelled:
        return "cancelled"
    if any(row.get("outcome_kind") == "technical_error" for row in rows):
        return "completed_with_technical_errors"
    return "completed"


def fill_remaining_rows(
    rows: list[dict[str, Any]],
    terminal_rows: list[dict[str, Any]],
    code: str,
    message: str,
) -> None:
    while len(terminal_rows) < 12:
        terminal_rows.append(technical_row(rows[len(terminal_rows)], code, message))


def persist_run_artifacts(
    output_dir: Path,
    terminal_rows: list[dict[str, Any]],
    run_record: dict[str, Any],
) -> None:
    write_jsonl_atomic(output_dir / "rows.jsonl", terminal_rows)
    write_json_atomic(output_dir / "run.json", run_record)


def init_response_deadline(whole_deadline: float) -> float:
    if os.environ.get("H10_TEST_FORCE_INIT_WRITE_FAILURE") == "1":
        return time.perf_counter() + INIT_RESPONSE_WAIT_FORCED_WRITE_FAILURE_SECONDS
    return min(whole_deadline, time.perf_counter() + INIT_RESPONSE_WAIT_SECONDS)


def assert_freeze_launch_receipts(
    freeze: dict[str, Any],
    *,
    worker_script: Path,
    runner_script: Path,
    requested_device: str,
) -> None:
    frozen_device = freeze.get("requested_device")
    if frozen_device != requested_device:
        raise h10.H10Error("run --device does not match freeze requested_device")
    script_pairs: tuple[tuple[str, str, Path], ...] = (
        ("worker_script_path", "worker_script_sha256", worker_script.resolve()),
        ("runner_script_path", "runner_script_sha256", runner_script.resolve()),
        ("common_script_path", "common_script_sha256", _COMMON_PATH.resolve()),
    )
    for path_key, hash_key, expected_path in script_pairs:
        if path_key not in freeze or hash_key not in freeze:
            raise h10.H10Error(f"freeze missing required receipt field: {path_key}")
        frozen_path = Path(str(freeze[path_key])).resolve()
        if frozen_path != expected_path:
            raise h10.H10Error(f"freeze {path_key} does not match launch path {expected_path}")
        if hash_file(expected_path) != freeze[hash_key]:
            raise h10.H10Error(f"freeze {hash_key} mismatch for {path_key}")


def assert_no_prior_run_artifacts(output_dir: Path) -> None:
    """Refuse to start when prior run evidence would be overwritten or mixed."""
    run_json = output_dir / "run.json"
    rows_jsonl = output_dir / "rows.jsonl"
    if run_json.is_file() or rows_jsonl.is_file():
        raise h10.H10Error("refusing to start: run.json or rows.jsonl already exists in output directory")
    masks_dir = output_dir / "masks"
    if masks_dir.is_dir():
        for entry in masks_dir.iterdir():
            if entry.is_file():
                raise h10.H10Error(
                    "refusing to start: mask artifacts already exist in output directory masks/"
                )


def execute_rows(
    *,
    python_executable: Path,
    worker_script: Path,
    contract_path: Path,
    asset_dir: Path,
    output_dir: Path,
    rows: list[dict[str, Any]],
    device: str,
    whole_run_timeout_seconds: float,
    case_timeout_seconds: float,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    masks_dir = output_dir / "masks"
    masks_dir.mkdir(parents=True, exist_ok=True)
    run_started = time.perf_counter()
    whole_deadline = run_started + whole_run_timeout_seconds
    terminal_rows: list[dict[str, Any]] = []
    worker_pid: int | None = None
    load_ms: float | None = None
    stderr_tail = ""
    ipc: WorkerIpc | None = None
    process: subprocess.Popen[bytes] | None = None
    cleanup_failed = False
    cancelled = False
    cancel = cancel_event if cancel_event is not None else threading.Event()
    previous_handlers = install_cancel_handlers(cancel)
    try:
        process = subprocess.Popen(
            [str(python_executable), str(worker_script)],
            cwd=str(worker_script.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            start_new_session=True,
            env=owned_worker_environ(),
        )
        ipc = WorkerIpc(process)
        worker_pid = process.pid
        init_payload = {
            "command": "init",
            "asset_dir": str(asset_dir.resolve()),
            "contract_path": str(contract_path.resolve()),
            "masks_dir": str(masks_dir.resolve()),
            "device": device,
        }
        init_write_failed = False
        try:
            if os.environ.get("H10_TEST_FORCE_INIT_WRITE_FAILURE") == "1":
                raise OSError("forced init write failure for offline test")
            ipc.write_json_line(init_payload)
        except Exception as error:  # noqa: BLE001
            fill_remaining_rows(rows, terminal_rows, "INIT_WRITE_FAILURE", str(error))
            init_write_failed = True
        if not init_write_failed:
            try:
                ready = ipc.read_json_line(init_response_deadline(whole_deadline), cancel)
            except InterruptedError:
                cancelled = True
                fill_remaining_rows(rows, terminal_rows, "RUN_CANCELLED", "run cancelled during init")
            except TimeoutError:
                fill_remaining_rows(rows, terminal_rows, "INIT_TIMEOUT", "worker init response timed out")
            except RuntimeError as error:
                fill_remaining_rows(rows, terminal_rows, "INIT_FAILURE", str(error))
            else:
                if ready.get("type") != "ready":
                    fill_remaining_rows(
                        rows,
                        terminal_rows,
                        "INIT_FAILURE",
                        f"unexpected ready payload: {ready!r}",
                    )
                else:
                    load_ms = float(ready.get("load_ms") or 0.0)
                    next_index = 0
                    while next_index < len(rows) and len(terminal_rows) < 12:
                        if cancel.is_set():
                            cancelled = True
                            fill_remaining_rows(rows, terminal_rows, "RUN_CANCELLED", "run cancelled")
                            break
                        if time.perf_counter() >= whole_deadline:
                            fill_remaining_rows(
                                rows,
                                terminal_rows,
                                "WHOLE_RUN_TIMEOUT",
                                "whole run timeout exceeded",
                            )
                            break
                        row = rows[next_index]
                        case_deadline = min(whole_deadline, time.perf_counter() + case_timeout_seconds)
                        try:
                            ipc.write_json_line({"command": "row", "row": harness_row(row)})
                        except Exception as error:  # noqa: BLE001
                            terminal_rows.append(technical_row(row, "ROW_WRITE_FAILURE", str(error)))
                            fill_remaining_rows(
                                rows,
                                terminal_rows,
                                "ROW_WRITE_FAILURE",
                                "remaining rows finalized after row write failure",
                            )
                            break
                        try:
                            response = ipc.read_json_line(case_deadline, cancel)
                        except InterruptedError:
                            cancelled = True
                            terminal_rows.append(
                                technical_row(row, "RUN_CANCELLED", "run cancelled during row")
                            )
                            fill_remaining_rows(
                                rows,
                                terminal_rows,
                                "RUN_CANCELLED",
                                "remaining rows finalized after cancellation",
                            )
                            break
                        except TimeoutError:
                            terminal_rows.append(
                                technical_row(row, "CASE_TIMEOUT", "per-case timeout exceeded")
                            )
                            fill_remaining_rows(
                                rows,
                                terminal_rows,
                                "CASE_TIMEOUT",
                                "remaining rows finalized after case timeout",
                            )
                            break
                        except RuntimeError as error:
                            terminal_rows.append(technical_row(row, "WORKER_IPC_FAILURE", str(error)))
                            fill_remaining_rows(
                                rows,
                                terminal_rows,
                                "WORKER_IPC_FAILURE",
                                "remaining rows finalized after worker IPC failure",
                            )
                            break
                        if response.get("type") != "row":
                            terminal_rows.append(
                                technical_row(row, "INVALID_WORKER_RESPONSE", json.dumps(response))
                            )
                        else:
                            terminal_rows.append(response)
                        next_index += 1
                    if len(terminal_rows) < 12:
                        fill_remaining_rows(
                            rows,
                            terminal_rows,
                            "INCOMPLETE_RUN",
                            "run ended before all rows were processed",
                        )
                    if (
                        not cancelled
                        and process.poll() is None
                        and len(terminal_rows) == 12
                        and not cleanup_failed
                    ):
                        try:
                            ipc.write_json_line({"command": "close"})
                            ipc.read_json_line(time.perf_counter() + 5, cancel)
                        except InterruptedError:
                            cancelled = True
                        except Exception:  # noqa: BLE001
                            pass
    except Exception as error:  # noqa: BLE001
        if len(terminal_rows) < 12:
            fill_remaining_rows(rows, terminal_rows, "RUNNER_FAILURE", str(error))
    finally:
        restore_cancel_handlers(previous_handlers)
        if process is not None:
            try:
                shutdown_owned_worker(process, ipc)
            except RuntimeError as error:
                cleanup_failed = True
                if len(terminal_rows) < 12:
                    fill_remaining_rows(rows, terminal_rows, "WORKER_CLEANUP_FAILURE", str(error))
            else:
                if ipc is not None:
                    stderr_tail = ipc.stderr_text()
        if len(terminal_rows) < 12:
            fill_remaining_rows(rows, terminal_rows, "INCOMPLETE_RUN", "finalizer padded missing rows")
    return _finalize_execute_rows(
        run_started,
        worker_pid,
        load_ms,
        terminal_rows,
        stderr_tail,
        cleanup_failed=cleanup_failed,
        cancelled=cancelled,
    )


def _finalize_execute_rows(
    run_started: float,
    worker_pid: int | None,
    load_ms: float | None,
    terminal_rows: list[dict[str, Any]],
    stderr_tail: str,
    *,
    cleanup_failed: bool,
    cancelled: bool,
) -> dict[str, Any]:
    if len(terminal_rows) != 12:
        raise RuntimeError(f"expected 12 terminal rows, got {len(terminal_rows)}")
    wall_ms = (time.perf_counter() - run_started) * 1000.0
    return {
        "worker_pid": worker_pid,
        "load_ms": load_ms,
        "wall_ms": wall_ms,
        "rows": terminal_rows[:12],
        "worker_stderr_tail": stderr_tail,
        "cleanup_failed": cleanup_failed,
        "cancelled": cancelled,
    }


def cmd_validate_manifest(args: argparse.Namespace) -> int:
    manifest = load_json(Path(args.manifest))
    rows = h10.validate_manifest(manifest)
    print(json.dumps({"ok": True, "row_count": len(rows)}, indent=2))
    return 0


def cmd_verify_assets(args: argparse.Namespace) -> int:
    asset_dir = Path(args.assets).resolve()
    receipts = h10.verify_asset_directory(asset_dir)
    h10.verify_preprocessor_config(asset_dir)
    h10.assert_forward_accepts_interpolate_pos_encoding()
    print(json.dumps({"ok": True, "files": receipts}, indent=2))
    return 0


def cmd_record_external_manifest(args: argparse.Namespace) -> int:
    asset_dir = Path(args.assets).resolve()
    manifest_path = Path(args.output).resolve()
    digest = h10.build_external_asset_manifest(asset_dir, manifest_path)
    print(json.dumps({"ok": True, "manifest_path": str(manifest_path), "sha256": digest}, indent=2))
    return 0


def cmd_probe_source(args: argparse.Namespace) -> int:
    source_path = Path(args.source).resolve()
    expected = getattr(args, "expected_sha256", None)
    try:
        oriented = h10.read_oriented_source(
            source_path,
            expected_raw_sha256=expected if isinstance(expected, str) else None,
        )
        payload = {
            "ok": True,
            "width": oriented.width,
            "height": oriented.height,
            "encoded_bytes": oriented.encoded_bytes,
            "source_sha256": oriented.raw_source_sha256,
            "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
        }
        oriented.rgb.close()
    except h10.H10Error as error:
        payload = {"ok": False, "error": str(error)}
    print(json.dumps(payload, indent=2))
    return 0 if payload.get("ok") else 2


def cmd_probe_tokenizer(args: argparse.Namespace) -> int:
    asset_dir = Path(args.assets).resolve()
    h10.verify_asset_directory(asset_dir)
    processor = h10.load_clipseg_processor(asset_dir)
    target = str(args.target)
    try:
        _, model_max_length = h10.encode_target_or_reject(processor.tokenizer, target)
        payload = {"ok": True, "model_max_length": model_max_length}
    except h10.H10Error as error:
        payload = {"ok": False, "error": str(error)}
    print(json.dumps(payload, indent=2))
    return 0 if payload.get("ok") else 2


def cmd_probe_logits_shape(args: argparse.Namespace) -> int:
    import torch

    tensor = torch.zeros((1, h10.LOGITS_SIZE, h10.LOGITS_SIZE), dtype=torch.float32)
    plane = h10.select_logits_plane(tensor)
    payload = {
        "ok": True,
        "input_shape": list(tensor.shape),
        "plane_shape": list(plane.shape),
    }
    print(json.dumps(payload, indent=2))
    return 0


def cmd_probe_postprocess(args: argparse.Namespace) -> int:
    import torch

    cases = [
        ("zero_boundary", h10.synthetic_logits_for_target("__ZERO_BOUNDARY__", 64, 48)),
        ("pos_ramp", h10.synthetic_logits_for_target("__POS_RAMP__", 80, 50)),
        ("all_neg", h10.synthetic_logits_for_target("__ALL_NEG__", 32, 32)),
        ("zero_plane", torch.zeros((h10.LOGITS_SIZE, h10.LOGITS_SIZE), dtype=torch.float32)),
    ]
    results = []
    for name, logits in cases:
        height = int(args.height)
        width = int(args.width)
        mask = h10.logits_to_mask(logits, height, width)
        grid_center = None
        if name == "zero_boundary":
            grid_center = int((logits >= 0)[h10.LOGITS_SIZE // 2, h10.LOGITS_SIZE // 2])
        center = int(mask.mask_u8[height // 2, width // 2]) if name == "zero_plane" else None
        results.append(
            {
                "case": name,
                "shape": [height, width],
                "foreground": mask.foreground_bounds is not None,
                "grid_center_value": grid_center,
                "center_value": center,
            }
        )
    print(json.dumps({"ok": True, "results": results}, indent=2))
    return 0


def cmd_prepare_freeze(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).resolve()
    asset_dir = Path(args.assets).resolve()
    contract_path = Path(args.contract).resolve()
    output_dir = Path(args.output).resolve()
    python_executable = resolve_python_executable(args.python)
    manifest = load_json(manifest_path)
    rows = h10.validate_manifest(manifest)
    h10.load_contract(contract_path)
    asset_receipts = h10.verify_asset_directory(asset_dir)
    preprocessor_on_disk = h10.verify_preprocessor_config_on_disk(asset_dir)
    h10.assert_forward_accepts_interpolate_pos_encoding()
    processor = h10.load_clipseg_processor(asset_dir)
    effective_processor = h10.verify_effective_image_processor(processor.image_processor)
    manifest_sha256 = assert_minimal_manifest_hash_if_applicable(manifest_path)
    worker_script_path = Path(args.worker).resolve()
    runner_script_path = Path(__file__).resolve()
    common_script_path = _COMMON_PATH.resolve()
    requested_device = str(args.device)
    output_dir.mkdir(parents=True, exist_ok=True)
    freeze_path = output_dir / "freeze.json"
    if freeze_path.exists():
        raise h10.H10Error("refusing to overwrite existing freeze.json")
    freeze = {
        "schema": FREEZE_SCHEMA,
        "prepared_at_unix_ms": int(time.time() * 1000),
        "manifest_path": str(manifest_path),
        "manifest_sha256": manifest_sha256,
        "contract_path": str(contract_path),
        "contract_sha256": hash_file(contract_path),
        "asset_dir": str(asset_dir),
        "asset_receipts": asset_receipts,
        "preprocessor_on_disk": preprocessor_on_disk,
        "effective_processor": effective_processor,
        "requested_device": requested_device,
        "runtime": {
            **runtime_receipt(python_executable),
            "cuda_device": h10.cuda_runtime_details(),
        },
        "recipe": {
            "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
            "threshold": "logit >= 0",
            "logits_grid": h10.LOGITS_SIZE,
            "max_encoded_bytes": h10.MAX_ENCODED_BYTES,
            "max_oriented_pixels": h10.MAX_ORIENTED_PIXELS,
        },
        "rows": rows,
        "worker_script_path": str(worker_script_path),
        "worker_script_sha256": hash_file(worker_script_path),
        "runner_script_path": str(runner_script_path),
        "runner_script_sha256": hash_file(runner_script_path),
        "common_script_path": str(common_script_path),
        "common_script_sha256": hash_file(common_script_path),
    }
    write_json_atomic(freeze_path, freeze)
    print(json.dumps({"ok": True, "freeze_path": str(freeze_path)}, indent=2))
    return 0


def cmd_probe_header_cap(args: argparse.Namespace) -> int:
    source_path = Path(args.source).resolve()
    encoded = h10.read_bounded_file_bytes(source_path)
    raw_digest = h10.sha256_bytes(encoded)
    expected = getattr(args, "expected_sha256", None)
    if isinstance(expected, str) and raw_digest != expected:
        raise h10.H10Error("source byte SHA-256 mismatch before header inspection")
    from unittest import mock

    with mock.patch.object(h10.Image.Image, "load", side_effect=AssertionError("Image.load must not run")):
        try:
            width, height = h10.oriented_dimensions_from_header(encoded)
            payload = {"ok": True, "width": width, "height": height, "decoded": False}
        except h10.H10Error as error:
            payload = {"ok": False, "error": str(error), "decoded": False}
    print(json.dumps(payload, indent=2))
    return 0 if payload.get("ok") else 2


def cmd_run(args: argparse.Namespace) -> int:
    if not args.run:
        raise SystemExit("--run flag is required to execute inference")
    freeze_path = Path(args.freeze).resolve()
    if not freeze_path.is_file():
        raise h10.H10Error(f"freeze file missing: {freeze_path}")
    output_dir = Path(args.output).resolve()
    if freeze_path.parent != output_dir:
        raise h10.H10Error("freeze file must live inside the output directory")
    python_executable = resolve_python_executable(args.python)
    worker_script = Path(args.worker).resolve()
    freeze = load_json(freeze_path)
    runner_script = Path(__file__).resolve()
    rows = h10.revalidate_freeze_closure(
        freeze,
        freeze_path=freeze_path,
        python_executable=python_executable,
        worker_script=worker_script,
        runner_script=runner_script,
    )
    assert_freeze_launch_receipts(
        freeze,
        worker_script=worker_script,
        runner_script=runner_script,
        requested_device=str(args.device),
    )
    asset_dir = Path(str(freeze["asset_dir"])).resolve()
    contract_path = Path(str(freeze["contract_path"])).resolve()
    assert_no_prior_run_artifacts(output_dir)
    result = execute_rows(
        python_executable=python_executable,
        worker_script=worker_script,
        contract_path=contract_path,
        asset_dir=asset_dir,
        output_dir=output_dir,
        rows=rows,
        device=args.device,
        whole_run_timeout_seconds=h10.WHOLE_RUN_TIMEOUT_SECONDS,
        case_timeout_seconds=h10.CASE_TIMEOUT_SECONDS,
    )
    freeze_sha256 = hash_file(freeze_path)
    status = derive_run_status(
        result["rows"],
        cleanup_failed=bool(result["cleanup_failed"]),
        cancelled=bool(result["cancelled"]),
    )
    run_record = {
        "schema": "v03-h10-clipseg-run-v1",
        "status": status,
        "freeze_path": str(freeze_path),
        "freeze_sha256": freeze_sha256,
        "manifest_sha256": freeze["manifest_sha256"],
        "contract_sha256": freeze["contract_sha256"],
        "worker_script_sha256": hash_file(worker_script),
        "device": args.device,
        "cuda_runtime": h10.cuda_runtime_details(),
        "load_ms": result["load_ms"],
        "wall_ms": result["wall_ms"],
        "worker_pid": result["worker_pid"],
        "worker_stderr_tail": result["worker_stderr_tail"],
        "row_count": len(result["rows"]),
    }
    persist_run_artifacts(output_dir, result["rows"], run_record)
    ok = not result["cleanup_failed"]
    print(json.dumps({"ok": ok, "output_dir": str(output_dir), "status": status}, indent=2))
    return 0 if ok else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="H10 CLIPSeg benchmark runner")
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate-manifest")
    validate.add_argument("--manifest", required=True)
    validate.set_defaults(func=cmd_validate_manifest)

    verify = sub.add_parser("verify-assets")
    verify.add_argument("--assets", required=True)
    verify.set_defaults(func=cmd_verify_assets)

    record = sub.add_parser("record-external-manifest")
    record.add_argument("--assets", required=True)
    record.add_argument("--output", required=True)
    record.set_defaults(func=cmd_record_external_manifest)

    probe = sub.add_parser("probe-postprocess")
    probe.add_argument("--width", type=int, default=80)
    probe.add_argument("--height", type=int, default=50)
    probe.set_defaults(func=cmd_probe_postprocess)

    probe_logits = sub.add_parser("probe-logits-shape")
    probe_logits.set_defaults(func=cmd_probe_logits_shape)

    probe_source = sub.add_parser("probe-source")
    probe_source.add_argument("--source", required=True)
    probe_source.add_argument("--expected-sha256", default=None)
    probe_source.set_defaults(func=cmd_probe_source)

    probe_header = sub.add_parser("probe-header-cap")
    probe_header.add_argument("--source", required=True)
    probe_header.add_argument("--expected-sha256", default=None)
    probe_header.set_defaults(func=cmd_probe_header_cap)

    probe_tokenizer = sub.add_parser("probe-tokenizer")
    probe_tokenizer.add_argument("--assets", required=True)
    probe_tokenizer.add_argument("--target", required=True)
    probe_tokenizer.set_defaults(func=cmd_probe_tokenizer)

    freeze = sub.add_parser("prepare-freeze")
    freeze.add_argument("--manifest", required=True)
    freeze.add_argument("--assets", required=True)
    freeze.add_argument("--contract", required=True)
    freeze.add_argument("--output", required=True)
    freeze.add_argument("--python", required=True)
    freeze.add_argument("--worker", required=True)
    freeze.add_argument(
        "--device",
        default="cuda:0",
        help="requested worker device recorded in freeze (must match run --device)",
    )
    freeze.set_defaults(func=cmd_prepare_freeze)

    run = sub.add_parser("run")
    run.add_argument("--run", action="store_true", help="explicit authorization to execute rows")
    run.add_argument("--freeze", required=True, help="prepared freeze.json path (never overwritten)")
    run.add_argument("--output", required=True, help="run artifact directory (must contain freeze)")
    run.add_argument("--python", required=True)
    run.add_argument("--worker", required=True)
    run.add_argument("--device", default="cuda:0")
    run.set_defaults(func=cmd_run)

    orchestrate = sub.add_parser("orchestrate-fake")
    orchestrate.add_argument("--manifest", required=True)
    orchestrate.add_argument("--assets", required=True)
    orchestrate.add_argument("--contract", required=True)
    orchestrate.add_argument("--output", required=True)
    orchestrate.add_argument("--python", required=True)
    orchestrate.add_argument("--worker", required=True)
    orchestrate.add_argument("--case-timeout-seconds", type=float, default=1.0)
    orchestrate.set_defaults(func=cmd_orchestrate_fake)

    return parser


def cmd_orchestrate_fake(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).resolve()
    asset_dir = Path(args.assets).resolve()
    contract_path = Path(args.contract).resolve()
    output_dir = Path(args.output).resolve()
    python_executable = resolve_python_executable(args.python)
    worker_script = Path(args.worker).resolve()
    manifest = load_json(manifest_path)
    rows = h10.validate_manifest(manifest)
    h10.load_contract(contract_path)
    h10.verify_asset_directory(asset_dir)
    assert_no_prior_run_artifacts(output_dir)
    result = execute_rows(
        python_executable=python_executable,
        worker_script=worker_script,
        contract_path=contract_path,
        asset_dir=asset_dir,
        output_dir=output_dir,
        rows=rows,
        device="fake",
        whole_run_timeout_seconds=h10.WHOLE_RUN_TIMEOUT_SECONDS,
        case_timeout_seconds=float(args.case_timeout_seconds),
    )
    status = derive_run_status(
        result["rows"],
        cleanup_failed=bool(result["cleanup_failed"]),
        cancelled=bool(result["cancelled"]),
    )
    persist_run_artifacts(
        output_dir,
        result["rows"],
        {
            "schema": "v03-h10-clipseg-fake-run-v1",
            "status": status,
            "row_count": len(result["rows"]),
            "worker_pid": result["worker_pid"],
            "worker_stderr_tail": result["worker_stderr_tail"],
        },
    )
    ok = not result["cleanup_failed"]
    print(json.dumps({"ok": ok, "rows": len(result["rows"]), "status": status}, indent=2))
    return 0 if ok else 2


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except h10.H10Error as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2), file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001
        print(
            json.dumps(
                {"ok": False, "error": str(error), "traceback": traceback.format_exc(limit=8)},
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
