import os
import signal
import subprocess
import time
from pathlib import Path
from typing import BinaryIO


class BoundedLogWriter:
    def __init__(self, streams: dict[str, BinaryIO], limit: int):
        self._streams = streams
        self._limit = limit
        self.bytes_written = 0
        self.overflowed = False

    def write(self, name: str, data: bytes) -> None:
        remaining = max(0, self._limit - self.bytes_written)
        kept = data[:remaining]
        self._streams[name].write(kept)
        self.bytes_written += len(kept)
        if len(kept) < len(data):
            self.overflowed = True


def stop_owned_group(process: subprocess.Popen[bytes], grace_seconds: float = 4.0) -> dict[str, object]:
    pgid = process.pid
    process.poll()  # Reap an exited leader before deciding whether a live group remains.
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        try:
            process.wait(timeout=0)
        except subprocess.TimeoutExpired:
            pass
        return {"processGroup": pgid, "closed": process.poll() is not None, "alreadyExited": True}

    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        process.poll()
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return {"processGroup": pgid, "closed": process.poll() is not None, "signal": "TERM"}
        time.sleep(0.05)

    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        pass
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        process.poll()
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return {"processGroup": pgid, "closed": process.poll() is not None, "signal": "TERM-then-KILL"}
        time.sleep(0.05)
    return {"processGroup": pgid, "closed": False, "signal": "TERM-then-KILL"}


def bounded_tail(path: Path, maximum_bytes: int) -> bytes:
    if not path.is_file() or path.is_symlink():
        return b""
    size = path.stat().st_size
    with path.open("rb") as stream:
        stream.seek(max(0, size - maximum_bytes))
        return stream.read(maximum_bytes)
