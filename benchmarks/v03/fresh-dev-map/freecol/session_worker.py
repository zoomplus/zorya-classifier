#!/usr/bin/env python3
"""Non-PID1 worker for private tmpfs, Xvfb readiness, DBus, and FreeCol."""

import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

from preflight_runtime import BoundedLogWriter, bounded_tail, stop_owned_group


MAX_LOG_BYTES = 2_000_000
MAX_FREECOL_TAIL_BYTES = 64 * 1024
DISPLAY_TIMEOUT_SECONDS = 12


class WorkerError(RuntimeError):
    pass


def mount_private_tmpfs(run_dir: Path) -> None:
    private_mount_log = run_dir / "private-tmpfs.log"
    commands = (
        ["/usr/bin/mount", "--make-rprivate", "/"],
        ["/usr/bin/mount", "-t", "tmpfs", "-o", "size=64m,nosuid,nodev", "zorya-preflight", "/tmp"],
    )
    receipts = []
    for command in commands:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=8, check=False)
        receipts.append({"command": command, "returnCode": result.returncode, "output": result.stdout[:1024].decode("utf-8", errors="replace")})
        if result.returncode != 0:
            private_mount_log.write_text(json.dumps(receipts, indent=2) + "\n", encoding="utf-8")
            raise WorkerError(f"private /tmp setup failed at {Path(command[1]).name}")
    private_mount_log.write_text(json.dumps(receipts, indent=2) + "\n", encoding="utf-8")


def enable_loopback(run_dir: Path) -> None:
    result = subprocess.run(
        ["/usr/sbin/ip", "link", "set", "lo", "up"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=5,
        check=False,
    )
    (run_dir / "private-network.json").write_text(
        json.dumps(
            {
                "networkNamespace": True,
                "externalNetworkDisabled": True,
                "loopbackEnabled": result.returncode == 0,
                "commandReturnCode": result.returncode,
                "boundedOutput": result.stdout[:1024].decode("utf-8", errors="replace"),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    if result.returncode != 0:
        raise WorkerError("could not enable loopback inside the owned network namespace")


def start_xvfb(env: dict[str, str], log_path: Path) -> tuple[subprocess.Popen[bytes], str]:
    read_fd, write_fd = os.pipe()
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            ["/usr/bin/Xvfb", "-displayfd", str(write_fd), "-screen", "0", "1024x768x24", "-nolisten", "tcp"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(write_fd,),
            start_new_session=True,
        )
        os.close(write_fd)
        write_fd = -1
        selector = selectors.DefaultSelector()
        selector.register(read_fd, selectors.EVENT_READ)
        received = bytearray()
        deadline = time.monotonic() + DISPLAY_TIMEOUT_SECONDS
        display: str | None = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            for _, _ in selector.select(timeout=0.1):
                block = os.read(read_fd, 32)
                if not block:
                    break
                received.extend(block)
                if len(received) > 32:
                    raise WorkerError("Xvfb displayfd response exceeded 32 bytes")
                if b"\n" in received:
                    line = bytes(received).split(b"\n", 1)[0]
                    if not line.isdigit():
                        raise WorkerError("Xvfb returned a malformed display number")
                    display = ":" + line.decode("ascii")
                    break
            if display is not None:
                break
        selector.close()
        os.close(read_fd)
        read_fd = -1
        if display is None:
            log_path.write_text(json.dumps({"status": "xvfb-readiness-failed", "returnCode": process.poll(), "displayfdBytes": received.hex()}, indent=2) + "\n", encoding="utf-8")
            raise WorkerError("Xvfb -displayfd did not become ready within the bound")
        return process, display
    except Exception:
        if process is not None and process.poll() is None:
            stop_owned_group(process, grace_seconds=1.0)
        raise
    finally:
        if write_fd >= 0:
            os.close(write_fd)
        if read_fd >= 0:
            os.close(read_fd)


def copy_freecol_log(run_dir: Path, private_root: Path) -> dict[str, object] | None:
    log = private_root / "user-cache" / "FreeCol.log"
    data = bounded_tail(log, MAX_FREECOL_TAIL_BYTES)
    if not data:
        return None
    target = run_dir / "freecol-log-tail.txt"
    target.write_bytes(data)
    return {"path": str(target), "bytes": len(data), "truncatedToTail": log.stat().st_size > len(data)}


def main() -> int:
    if len(sys.argv) not in (4, 6):
        return 64
    run_dir = Path(sys.argv[1])
    timeout_seconds = int(sys.argv[2])
    seed = int(sys.argv[3])
    operation = sys.argv[4] if len(sys.argv) == 6 else "fresh"
    state_path = sys.argv[5] if len(sys.argv) == 6 else "-"
    if operation not in ("fresh", "save", "load") or (operation == "fresh") != (state_path == "-"):
        return 64
    private_root = run_dir / "private"
    output_path = run_dir / "live-state.json"
    stdout_path = run_dir / "freecol.stdout.log"
    stderr_path = run_dir / "freecol.stderr.log"
    xvfb_log_path = run_dir / "xvfb-startup.json"
    app_process: subprocess.Popen[bytes] | None = None
    xvfb_process: subprocess.Popen[bytes] | None = None
    app_close: dict[str, object] = {"closed": True, "notStarted": True}
    xvfb_close: dict[str, object] = {"closed": True, "notStarted": True}
    status = "startup-error"
    with stdout_path.open("wb") as stdout_log, stderr_path.open("wb") as stderr_log:
        sink = BoundedLogWriter({"stdout": stdout_log, "stderr": stderr_log}, MAX_LOG_BYTES)
        try:
            mount_private_tmpfs(run_dir)
            enable_loopback(run_dir)
            Path("/tmp/runtime").mkdir(mode=0o700)
            env = dict(os.environ)
            env["DISPLAY"] = ""
            xvfb_process, display = start_xvfb(env, xvfb_log_path)
            env["DISPLAY"] = display
            command = [
                "/usr/bin/dbus-run-session", "--", "/usr/games/freecol",
                "--no-intro", "--no-sound", "--no-splash", "--no-memory-check", "--no-java-check",
                "--fast", "--private", "--server-ip", "127.0.0.1",
                "--user-data-directory", str(private_root / "user-data"),
                "--user-config-directory", str(private_root / "user-config"),
                "--user-cache-directory", str(private_root / "user-cache"), "--windowed", "1024x768",
            ]
            if operation == "load":
                command.extend(("--load-savegame", state_path))
            else:
                command.extend(("--debug-start", "--seed", str(seed)))
            app_process = subprocess.Popen(
                command,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            assert app_process.stdout is not None and app_process.stderr is not None
            selector = selectors.DefaultSelector()
            selector.register(app_process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(app_process.stderr, selectors.EVENT_READ, "stderr")
            deadline = time.monotonic() + timeout_seconds
            status = "timeout"
            while time.monotonic() < deadline:
                if xvfb_process.poll() is not None:
                    status = "xvfb-exited-before-result"
                    break
                for key, _ in selector.select(timeout=0.1):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        sink.write(key.data, block)
                if sink.overflowed:
                    status = "output-limit-exceeded"
                    break
                if output_path.is_file():
                    status = "receipt-created"
                    break
                if app_process.poll() is not None and not selector.get_map():
                    status = "app-exited-before-receipt"
                    break
            app_close = stop_owned_group(app_process, grace_seconds=4.0)
            xvfb_close = stop_owned_group(xvfb_process, grace_seconds=4.0)
            drain_deadline = time.monotonic() + 2.0
            while selector.get_map() and time.monotonic() < drain_deadline:
                for key, _ in selector.select(timeout=0.1):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        sink.write(key.data, block)
            post_stop_drain_completed = not selector.get_map()
            selector.close()
            for stream in (app_process.stdout, app_process.stderr):
                if stream is not None:
                    stream.close()
            if not app_close.get("closed") or not xvfb_close.get("closed"):
                status = "owned-child-group-not-confirmed-closed"
            elif not post_stop_drain_completed:
                status = "owned-child-output-pipe-not-closed"
            elif sink.overflowed:
                status = "output-limit-exceeded"
            if status == "receipt-created":
                try:
                    live = json.loads(output_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    live = {}
                if not (
                    live.get("status") == "live-map-observed"
                    and live.get("sourceStateFeasibility") == "source-metadata-observed"
                    and live.get("visibleTileFrontInventoryComplete") is True
                    and int(live.get("spriteIntersectingViewportCount", 0)) > 0
                ):
                    status = "source-state-not-feasible"
            (run_dir / "xvfb-startup.json").touch(exist_ok=True)
            freecol_tail = copy_freecol_log(run_dir, private_root)
            result = {
                "schemaVersion": 1,
                "status": status,
                "appReturnCode": app_process.returncode,
                "xvfbReturnCode": xvfb_process.returncode,
                "appProcessGroupClosure": app_close,
                "xvfbProcessGroupClosure": xvfb_close,
                "logBytes": sink.bytes_written,
                "outputLimitBytes": MAX_LOG_BYTES,
                "postStopOutputDrainCompleted": post_stop_drain_completed,
                "freecolLogTail": freecol_tail,
                "screenshotCreated": False,
                "corpusCaseCreated": False,
            }
            (run_dir / "session-receipt.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps({"status": status, "appReturnCode": app_process.returncode, "xvfbReturnCode": xvfb_process.returncode}, sort_keys=True), flush=True)
            return 0 if status == "receipt-created" and app_close.get("closed") and xvfb_close.get("closed") and post_stop_drain_completed and not sink.overflowed else 1
        except Exception as error:
            if app_process is not None and app_process.poll() is None:
                app_close = stop_owned_group(app_process, grace_seconds=1.0)
            if xvfb_process is not None and xvfb_process.poll() is None:
                xvfb_close = stop_owned_group(xvfb_process, grace_seconds=1.0)
            if app_process is not None:
                for stream in (app_process.stdout, app_process.stderr):
                    if stream is not None:
                        stream.close()
            freecol_tail = copy_freecol_log(run_dir, private_root)
            failure = {
                "schemaVersion": 1,
                "status": "session-worker-error",
                "errorType": type(error).__name__,
                "errorMessage": str(error)[:400],
                "appProcessGroupClosure": app_close,
                "xvfbProcessGroupClosure": xvfb_close,
                "freecolLogTail": freecol_tail,
            }
            (run_dir / "session-failure.json").write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps({"status": failure["status"], "errorType": failure["errorType"]}, sort_keys=True), flush=True)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
