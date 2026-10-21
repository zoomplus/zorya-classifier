#!/usr/bin/env python3
"""Worker that acknowledges init then never responds (IPC silence test)."""

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

_COMMON_PATH = Path(__file__).with_name("h10-clipseg-common.py")
_spec = importlib.util.spec_from_file_location("h10_clipseg_common", _COMMON_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError("failed to load h10-clipseg-common.py")
h10 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = h10
_spec.loader.exec_module(h10)


def main() -> int:
    line = sys.stdin.readline()
    if not line:
        return 2
    init = json.loads(line)
    if init.get("command") != "init":
        return 2
    sys.stdout.write(
        json.dumps(
            {
                "type": "ready",
                "load_ms": 0.0,
                "device": "silent",
                "model_max_length": h10.EXPECTED_CLIP_CONTEXT,
                "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
            }
        )
        + "\n"
    )
    sys.stdout.flush()
    while True:
        command_line = sys.stdin.readline()
        if not command_line:
            break
        message = json.loads(command_line)
        if message.get("command") == "close":
            sys.stdout.write(json.dumps({"type": "closed"}) + "\n")
            sys.stdout.flush()
            break
        time.sleep(3600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
