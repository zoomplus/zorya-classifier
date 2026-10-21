#!/usr/bin/env python3
"""Controllable stand-in worker for H10 runner lifecycle tests (no model)."""

from __future__ import annotations


def _bootstrap_linux_parent_death_guard() -> None:
    import ctypes
    import os
    import signal
    import sys

    env_key = "H10_EXPECTED_LAUNCHER_PID"
    pr_set_pdeathsig = 1
    if sys.platform != "linux":
        raise RuntimeError("parent-death registration requires Linux")
    raw = os.environ.get(env_key)
    if raw is None or not str(raw).strip():
        raise RuntimeError(f"missing {env_key} for owned worker startup")
    try:
        expected_launcher_pid = int(str(raw).strip())
    except ValueError as error:
        raise RuntimeError(f"invalid {env_key}: {raw!r}") from error
    if expected_launcher_pid <= 0:
        raise RuntimeError(f"invalid {env_key}: must be a positive pid")
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.prctl(pr_set_pdeathsig, signal.SIGKILL) != 0:
        errno = ctypes.get_errno()
        raise RuntimeError(f"prctl(PR_SET_PDEATHSIG, SIGKILL) failed: errno {errno}")
    if os.getppid() != expected_launcher_pid:
        os.kill(os.getpid(), signal.SIGKILL)


_bootstrap_linux_parent_death_guard()

import importlib.util
import json
import sys
import time
from pathlib import Path
from typing import Any

_COMMON_PATH = Path(__file__).with_name("h10-clipseg-common.py")
_spec = importlib.util.spec_from_file_location("h10_clipseg_common", _COMMON_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError("failed to load h10-clipseg-common.py")
h10 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = h10
_spec.loader.exec_module(h10)


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    init_line = sys.stdin.readline()
    if not init_line:
        emit({"type": "fatal", "message": "missing init"})
        return 2
    init = json.loads(init_line)
    if init.get("command") != "init":
        emit({"type": "fatal", "message": "expected init"})
        return 2
    masks_dir = Path(init["masks_dir"]).resolve()
    emit(
        {
            "type": "ready",
            "load_ms": 0.0,
            "device": "fake",
            "model_max_length": h10.EXPECTED_CLIP_CONTEXT,
            "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
        }
    )
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        message = json.loads(line)
        command = message.get("command")
        if command == "close":
            emit({"type": "closed"})
            break
        if command != "row":
            emit({"type": "fatal", "message": "unsupported command"})
            return 2
        row = message["row"]
        wall_start = time.perf_counter()
        target = row["authored_target"]
        if target == "__SLEEP_120__":
            time.sleep(120)
            emit(
                {
                    "type": "row",
                    "row_index": row["row_index"],
                    "row_key": row["row_key"],
                    "authored_target": target,
                    "outcome_kind": "technical_error",
                    "error_code": "SLEEP_COMPLETED",
                    "error_message": "should have timed out",
                }
            )
            continue
        if target.startswith("__SLEEP_MS__:"):
            ms = int(target.split(":", 1)[1])
            time.sleep(ms / 1000.0)
        source_path = Path(row["source_path"])
        try:
            expected_hash = row.get("expected_source_sha256")
            oriented = h10.read_oriented_source(
                source_path,
                expected_raw_sha256=expected_hash if isinstance(expected_hash, str) else None,
            )
            mask_result = h10.logits_to_mask(
                h10.synthetic_logits_for_target(target, oriented.width, oriented.height),
                oriented.height,
                oriented.width,
            )
            if mask_result.foreground_bounds is None:
                wall_ms = (time.perf_counter() - wall_start) * 1000.0
                emit(
                    {
                        "type": "row",
                        "row_index": row["row_index"],
                        "row_key": row["row_key"],
                        "authored_target": target,
                        "source_width": oriented.width,
                        "source_height": oriented.height,
                        "source_sha256": oriented.raw_source_sha256,
                        "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
                        "model_max_length": h10.EXPECTED_CLIP_CONTEXT,
                        "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
                        "outcome_kind": "unresolved_empty",
                        "mask_path": None,
                        "wall_ms": wall_ms,
                        "peak_allocated_bytes": None,
                        "peak_reserved_bytes": None,
                    }
                )
            else:
                mask_path = masks_dir / f"{row['row_key']}.png"
                mask_sha256 = h10.write_mask_png(mask_path, mask_result.mask_u8)
                wall_ms = (time.perf_counter() - wall_start) * 1000.0
                emit(
                    {
                        "type": "row",
                        "row_index": row["row_index"],
                        "row_key": row["row_key"],
                        "authored_target": target,
                        "source_width": oriented.width,
                        "source_height": oriented.height,
                        "source_sha256": oriented.raw_source_sha256,
                        "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
                        "model_max_length": h10.EXPECTED_CLIP_CONTEXT,
                        "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
                        "outcome_kind": "candidate",
                        "mask_path": str(mask_path),
                        "mask_sha256": mask_sha256,
                        "foreground_bounds": mask_result.foreground_bounds,
                        "wall_ms": wall_ms,
                        "peak_allocated_bytes": None,
                        "peak_reserved_bytes": None,
                    }
                )
            oriented.rgb.close()
        except h10.H10Error as error:
            emit(
                {
                    "type": "row",
                    "row_index": row["row_index"],
                    "row_key": row["row_key"],
                    "authored_target": target,
                    "outcome_kind": "technical_error",
                    "error_code": "H10_ERROR",
                    "error_message": str(error),
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
