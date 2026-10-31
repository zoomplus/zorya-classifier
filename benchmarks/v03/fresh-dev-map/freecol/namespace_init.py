#!/usr/bin/env python3
"""PID-namespace init that supervises and reaps its complete process tree."""

import ctypes
import json
import os
import selectors
import signal
import sys
import time
from pathlib import Path


shutdown_signal: int | None = None
MAX_WORKER_OUTPUT = 8192
ORPHAN_GRACE_SECONDS = 2.0


def request_shutdown(signum: int, _frame: object) -> None:
    global shutdown_signal
    shutdown_signal = signum


def enable_subreaper() -> None:
    # PID 1 already adopts namespace orphans. This also makes the fixture exercise
    # that exact waitpid(-1) path without requiring a nested PID namespace.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def status_code(wait_status: int) -> tuple[int | None, int | None]:
    if os.WIFEXITED(wait_status):
        return os.WEXITSTATUS(wait_status), None
    if os.WIFSIGNALED(wait_status):
        return None, os.WTERMSIG(wait_status)
    return None, None


def append_bounded(target: bytearray, block: bytes) -> bool:
    room = max(0, MAX_WORKER_OUTPUT - len(target))
    target.extend(block[:room])
    return len(block) > room


def main() -> int:
    if len(sys.argv) not in (5, 7):
        return 64
    session_script = Path(sys.argv[1])
    run_dir = Path(sys.argv[2])
    timeout_seconds = sys.argv[3]
    seed = sys.argv[4]
    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    enable_subreaper()

    pipes: list[tuple[int, str, bytearray]] = []
    for name in ("stdout", "stderr"):
        read_fd, write_fd = os.pipe()
        pipes.append((read_fd, name, bytearray()))
        if name == "stdout":
            stdout_read, stdout_write = read_fd, write_fd
        else:
            stderr_read, stderr_write = read_fd, write_fd

    worker_pid = os.fork()
    if worker_pid == 0:
        try:
            os.close(stdout_read)
            os.close(stderr_read)
            os.setsid()
            os.dup2(stdout_write, 1)
            os.dup2(stderr_write, 2)
            os.close(stdout_write)
            os.close(stderr_write)
            os.execv(sys.executable, [sys.executable, str(session_script), str(run_dir), timeout_seconds, seed, *sys.argv[5:]])
        except BaseException as error:
            os.write(2, f"namespace-init exec failed: {type(error).__name__}\n".encode("utf-8"))
            os._exit(127)
    os.close(stdout_write)
    os.close(stderr_write)

    selector = selectors.DefaultSelector()
    output_truncated = {"stdout": False, "stderr": False}
    for read_fd, name, buffer in pipes:
        os.set_blocking(read_fd, False)
        selector.register(read_fd, selectors.EVENT_READ, (name, buffer))

    worker_status: int | None = None
    worker_return_code: int | None = None
    worker_signal: int | None = None
    reaped_other_children: list[int] = []
    all_children_reaped = False
    shutdown_started: float | None = None
    forced_namespace_kill = False
    idle_polls = 0

    while True:
        if shutdown_signal is not None and shutdown_started is None:
            shutdown_started = time.monotonic()
            try:
                os.killpg(worker_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

        for key, _ in selector.select(timeout=0.05):
            try:
                block = os.read(key.fd, 4096)
            except BlockingIOError:
                continue
            if not block:
                selector.unregister(key.fd)
                os.close(key.fd)
            else:
                name, buffer = key.data
                output_truncated[name] = append_bounded(buffer, block) or output_truncated[name]

        reaped_any = False
        while True:
            try:
                pid, wait_status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                all_children_reaped = True
                break
            if pid == 0:
                all_children_reaped = False
                break
            reaped_any = True
            if pid == worker_pid:
                worker_status = wait_status
                worker_return_code, worker_signal = status_code(wait_status)
            elif len(reaped_other_children) < 64:
                reaped_other_children.append(pid)

        if reaped_any:
            idle_polls = 0
        else:
            idle_polls += 1

        worker_done = worker_status is not None
        if worker_done and not all_children_reaped and idle_polls >= int(ORPHAN_GRACE_SECONDS / 0.05) and not forced_namespace_kill:
            # Every process in this private PID namespace belongs to this run.
            # This is only a bounded fallback for a leaked descendant after the
            # worker claims it has closed its owned process groups.
            try:
                os.kill(-1, signal.SIGTERM)
            except ProcessLookupError:
                pass
            forced_namespace_kill = True
            idle_polls = 0
        elif worker_done and forced_namespace_kill and not all_children_reaped and idle_polls >= 20:
            try:
                os.kill(-1, signal.SIGKILL)
            except ProcessLookupError:
                pass
            idle_polls = 0

        if worker_done and all_children_reaped and not selector.get_map():
            break

    selector.close()
    all_output = {name: buffer.decode("utf-8", errors="replace") for _, name, buffer in pipes}
    receipt = {
        "schemaVersion": 2,
        "status": "session-worker-exited",
        "managedWorkerPid": worker_pid,
        "sessionWorkerReturnCode": worker_return_code,
        "sessionWorkerSignal": worker_signal,
        "sessionWorkerStdout": all_output["stdout"],
        "sessionWorkerStderr": all_output["stderr"],
        "sessionWorkerOutputTruncated": any(output_truncated.values()),
        "reapedOrphanChildCount": len(reaped_other_children),
        "reapedOrphanChildPids": reaped_other_children,
        "allNamespaceChildrenReaped": all_children_reaped,
        "forcedNamespaceCleanup": forced_namespace_kill,
        "shutdownSignal": shutdown_signal,
    }
    (run_dir / "namespace-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": receipt["status"], "sessionWorkerReturnCode": worker_return_code, "reapedOrphanChildCount": len(reaped_other_children), "allNamespaceChildrenReaped": all_children_reaped}, sort_keys=True), flush=True)
    return worker_return_code if worker_return_code is not None else (128 + worker_signal if worker_signal is not None else 1)


if __name__ == "__main__":
    raise SystemExit(main())
