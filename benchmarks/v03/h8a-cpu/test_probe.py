#!/usr/bin/env python3
"""Unit tests for H8a CPU availability probe (no live native inference)."""

from __future__ import annotations

import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

PROBE_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("h8a_probe", PROBE_DIR / "probe.py")
assert _spec and _spec.loader
h8a = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = h8a
_spec.loader.exec_module(h8a)


class GeometryTests(unittest.TestCase):
    def test_u_expansion_matches_pinned_h4e(self) -> None:
        h4e = h8a.load_pinned_module(h8a.PINNED_HELPERS[2][0], h8a.PINNED_HELPERS[2][1], "test_h4e")
        box = [100.0, 200.0, 200.0, 300.0]
        expanded = h4e.expand_prompt_box(box, 1280, 800)
        self.assertEqual(expanded[0], 75.0)
        self.assertEqual(expanded[1], 175.0)
        self.assertEqual(expanded[2], 225.0)
        self.assertEqual(expanded[3], 325.0)

    def test_letterbox_rounded_geometry(self) -> None:
        omni = h8a.load_pinned_module(h8a.PINNED_HELPERS[1][0], h8a.PINNED_HELPERS[1][1], "test_omni")
        transform = omni.letterbox_transform(1280, 800, 1280)
        self.assertEqual(transform.resized_width, 1280)
        self.assertEqual(transform.resized_height, 800)
        mapped = omni.source_box_from_canvas((10.0, 20.0, 30.0, 40.0), transform)
        self.assertIsNotNone(mapped)
        assert mapped is not None
        self.assertAlmostEqual(mapped[0], 10.0)

    def test_normalize_target_photo_noun(self) -> None:
        grounded = h8a.load_pinned_module(h8a.PINNED_HELPERS[0][0], h8a.PINNED_HELPERS[0][1], "test_grounded")
        self.assertEqual(grounded.normalize_target("Car"), "Car")
        self.assertEqual(
            grounded.normalize_target(
                "the visible body sprite of unit type Explorer in the main Freeciv map canvas; "
                "exclude health bars and selection brackets"
            ),
            "Explorer unit",
        )


class PackedMaskTests(unittest.TestCase):
    def test_padding_bits_rejected(self) -> None:
        width, height = 3, 1
        packed = b"\x0f"
        with self.assertRaises(h8a.ProbeError):
            h8a.validate_packed_bytes(packed, width, height)

    def test_valid_pack_roundtrip(self) -> None:
        try:
            np = __import__("numpy")
        except ModuleNotFoundError:
            self.skipTest("numpy not installed in this interpreter")
        mask = np.array([[True, False, True], [False, True, False]], dtype=bool)
        packed = h8a.pack_mask_with_validation(mask, 3, 2)
        self.assertEqual(len(packed), h8a.packed_mask_byte_length(3, 2))

    def test_aggregate_cap(self) -> None:
        with self.assertRaises(h8a.ProbeError):
            h8a.aggregate_packed_limit(1024, 683, 36, 37)


class ManifestTests(unittest.TestCase):
    def test_rejects_unknown_manifest_hash(self) -> None:
        grounded = h8a.load_pinned_module(h8a.PINNED_HELPERS[0][0], h8a.PINNED_HELPERS[0][1], "test_grounded_m")
        with tempfile.TemporaryDirectory() as tmp:
            manifest_dir = Path(tmp) / "manifests"
            image_root = Path(tmp) / "images"
            manifest_dir.mkdir()
            image_root.mkdir()
            bad = manifest_dir / "photo.json"
            bad.write_text("[]\n", encoding="utf-8")
            with self.assertRaises(h8a.ProbeError):
                h8a.load_fixed_cases(manifest_dir, image_root, grounded)


class AssetVerificationTests(unittest.TestCase):
    def test_missing_asset_fail_closed(self) -> None:
        grounded = h8a.load_pinned_module(h8a.PINNED_HELPERS[0][0], h8a.PINNED_HELPERS[0][1], "test_grounded_a")
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            with self.assertRaises(h8a.ProbeError):
                h8a.verify_model_assets(assets, grounded)

    def test_asset_hash_mismatch_fail_closed(self) -> None:
        grounded = h8a.load_pinned_module(h8a.PINNED_HELPERS[0][0], h8a.PINNED_HELPERS[0][1], "test_grounded_b")
        item = grounded.MODEL_FILES[0]
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            path = assets / item["directory"] / item["filename"]
            path.parent.mkdir(parents=True)
            path.write_bytes(b"wrong-bytes")
            with self.assertRaises(h8a.ProbeError):
                h8a.verify_model_assets(assets, grounded)


class ProcParserTests(unittest.TestCase):
    def test_parse_pgrp_after_comm_with_spaces(self) -> None:
        stat = "4242 (sleep (extra)) S 1 4242 4242 0 -1 4194560 103 0 0 0 0 0 0 0 20 0 1 0"
        self.assertEqual(h8a.parse_proc_stat_pgrp(stat), 4242)

    def test_parse_pgrp_field_not_ppid(self) -> None:
        stat = "99 (proc) R 10 20 30 40 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
        self.assertEqual(h8a.parse_proc_stat_pgrp(stat), 20)

class WorkerPayloadValidationTests(unittest.TestCase):
    def test_traversal_case_id_rejected(self) -> None:
        with self.assertRaises(h8a.ProbeError):
            h8a.validate_case_id("../pilot-v03-photo-01")

    def test_output_dir_inside_repo_rejected(self) -> None:
        inside = h8a.REPO_ROOT / "benchmarks" / "outside-test-output"
        with self.assertRaises(h8a.ProbeError):
            h8a.require_external_output_path(inside, "--output")

    def test_worker_payload_rejects_repo_output_dir(self) -> None:
        payload = {
            "case_id": "pilot-v03-photo-01",
            "output_dir": str(h8a.REPO_ROOT / "tmp-worker-out"),
            "assets_dir": "/tmp/assets",
            "source_path": "/tmp/source.png",
            "source_sha256": "a" * 64,
            "width": 10,
            "height": 10,
            "normalized_target": "Car",
        }
        with self.assertRaises(h8a.ProbeError):
            h8a.validate_worker_payload(payload)

    def test_worker_payload_missing_source_path_rejected(self) -> None:
        payload = {
            "case_id": "pilot-v03-photo-01",
            "output_dir": "/tmp/out",
            "assets_dir": "/tmp/assets",
            "source_sha256": "a" * 64,
            "width": 10,
            "height": 10,
            "normalized_target": "Car",
        }
        with self.assertRaises(h8a.ProbeError) as ctx:
            h8a.validate_worker_payload(payload)
        self.assertIn("source_path must be a string", str(ctx.exception))

    def test_worker_payload_non_string_assets_dir_rejected(self) -> None:
        payload = {
            "case_id": "pilot-v03-photo-01",
            "output_dir": "/tmp/out",
            "assets_dir": 42,
            "source_path": "/tmp/source.png",
            "source_sha256": "a" * 64,
            "width": 10,
            "height": 10,
            "normalized_target": "Car",
        }
        with self.assertRaises(h8a.ProbeError) as ctx:
            h8a.validate_worker_payload(payload)
        self.assertIn("assets_dir must be a string", str(ctx.exception))


class VerifiedAssetSessionTests(unittest.TestCase):
    def test_close_attempts_all_fds_on_single_close_failure(self) -> None:
        session = h8a.VerifiedAssetSession()
        with tempfile.NamedTemporaryFile(delete=False) as first:
            first.write(b"one")
            first_path = Path(first.name)
        with tempfile.NamedTemporaryFile(delete=False) as second:
            second.write(b"two")
            second_path = Path(second.name)
        try:
            opened_first = session.open_verified(first_path)
            opened_second = session.open_verified(second_path)
            real_close = os.close
            calls: list[int] = []

            def flaky_close(fd: int) -> None:
                calls.append(fd)
                if fd == opened_first.fd:
                    raise OSError(9, "bad fd")
                real_close(fd)

            with mock.patch("os.close", side_effect=flaky_close):
                with self.assertRaises(h8a.ProbeError) as ctx:
                    session.close()
            self.assertIn("fd close failed", str(ctx.exception))
            self.assertEqual(calls, [opened_first.fd, opened_second.fd])
        finally:
            first_path.unlink(missing_ok=True)
            second_path.unlink(missing_ok=True)


class ManifestValidationTests(unittest.TestCase):
    def test_bool_dimension_rejected(self) -> None:
        with self.assertRaises(h8a.ProbeError):
            h8a.require_positive_int(True, "image.width")

    def test_malformed_manifest_row_type(self) -> None:
        with self.assertRaises(h8a.ProbeError):
            h8a.require_json_object([], "manifest row")


class ChildLifecycleTests(unittest.TestCase):
    def test_complete_fake_child(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [
                sys.executable,
                "-c",
                "import json; print(json.dumps({'status':'complete'}))",
            ]
            result = h8a.run_bounded_child(command, deadline_seconds=5, stderr_path=stderr)
            self.assertEqual(result["status"], "complete")
            self.assertIn(b"complete", result["stdout"])

    def test_timeout_fake_child(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [sys.executable, "-c", "import time; time.sleep(30)"]
            started = time.monotonic()
            result = h8a.run_bounded_child(command, deadline_seconds=0.3, stderr_path=stderr, rss_interval=0.05)
            elapsed = time.monotonic() - started
            self.assertEqual(result["status"], "timeout")
            self.assertLess(elapsed, 5.0)

    def test_oversized_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'x' * 2000000)"]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=5,
                stderr_path=stderr,
                stdout_limit=1024,
                rss_interval=0.05,
            )
            self.assertEqual(result["status"], "resource_limit")

    def test_nonzero_exit_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [sys.executable, "-c", "import sys; sys.exit(9)"]
            result = h8a.run_bounded_child(command, deadline_seconds=5, stderr_path=stderr, rss_interval=0.05)
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["exit_code"], 9)

    def test_partial_stdout_then_sleep_respects_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [
                sys.executable,
                "-c",
                "import sys,time; sys.stdout.buffer.write(b'ok'); sys.stdout.flush(); time.sleep(30)",
            ]
            started = time.monotonic()
            result = h8a.run_bounded_child(command, deadline_seconds=0.4, stderr_path=stderr, rss_interval=0.05)
            elapsed = time.monotonic() - started
            self.assertEqual(result["status"], "timeout")
            self.assertLess(elapsed, 5.0)

    def test_stderr_overflow_during_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [
                sys.executable,
                "-c",
                "import sys,time; sys.stderr.buffer.write(b'x'*9000000); sys.stderr.flush(); time.sleep(10)",
            ]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=5,
                stderr_path=stderr,
                stderr_limit=1024,
                rss_interval=0.05,
            )
            self.assertEqual(result["status"], "resource_limit")
            self.assertLessEqual(stderr.stat().st_size, 1024)

    def test_stderr_overflow_after_leader_exit_downgrades_parent_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            limit = 1024
            pad = limit - 50
            command = [
                sys.executable,
                "-c",
                textwrap.dedent(
                    f"""
                    import os, sys, json
                    read_fd, write_fd = os.pipe()
                    if os.fork() == 0:
                        os.setsid()
                        os.close(write_fd)
                        os.read(read_fd, 1)
                        sys.stderr.buffer.write(b"x" * 2000)
                        sys.stderr.flush()
                        os._exit(0)
                    os.close(read_fd)
                    sys.stderr.buffer.write(b"x" * {pad})
                    sys.stderr.flush()
                    print(json.dumps({{"status": "complete"}}))
                    """
                ).strip(),
            ]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=5,
                stderr_path=stderr,
                stderr_limit=limit,
                rss_interval=0.05,
            )
            self.assertNotEqual(result["status"], "complete")
            self.assertLessEqual(stderr.stat().st_size, limit)
            self.assertIn("stderr exceeded bounded limit", result.get("error") or "")

    def test_grandchild_process_group_settled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [
                sys.executable,
                "-c",
                textwrap.dedent(
                    """
                    import os, sys, time
                    if os.fork() == 0:
                        if os.fork() == 0:
                            time.sleep(20)
                            raise SystemExit(0)
                        raise SystemExit(0)
                    time.sleep(20)
                    """
                ).strip(),
            ]
            started = time.monotonic()
            result = h8a.run_bounded_child(command, deadline_seconds=0.5, stderr_path=stderr, rss_interval=0.05)
            elapsed = time.monotonic() - started
            self.assertEqual(result["status"], "timeout")
            self.assertLess(elapsed, 8.0)

    def test_start_new_session_leader_pgrp_matches(self) -> None:
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(2)"],
            start_new_session=True,
        )
        try:
            pgrp = h8a.read_process_pgrp(proc.pid)
            self.assertIsNotNone(pgrp)
            self.assertEqual(pgrp, os.getpgid(proc.pid))
        finally:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=5)

    def test_leader_exit_grandchild_escalates_kill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [
                sys.executable,
                "-c",
                textwrap.dedent(
                    """
                    import os, signal, sys, time
                    r, w = os.pipe()
                    if os.fork() == 0:
                        os.close(w)
                        signal.signal(signal.SIGTERM, signal.SIG_IGN)
                        signal.signal(signal.SIGHUP, signal.SIG_IGN)
                        os.read(r, 1)
                        time.sleep(60)
                        raise SystemExit(0)
                    os.close(r)
                    raise SystemExit(0)
                    """
                ).strip(),
            ]
            started = time.monotonic()
            result = h8a.run_bounded_child(command, deadline_seconds=5, stderr_path=stderr, rss_interval=0.05)
            elapsed = time.monotonic() - started
            self.assertNotEqual(result["status"], "complete")
            self.assertLess(elapsed, 12.0)
            self.assertIsNotNone(result.get("error"))

    def test_stdout_at_cap_is_not_overflow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            limit = 1024
            command = [
                sys.executable,
                "-c",
                f"import sys; sys.stdout.buffer.write(b'x' * {limit})",
            ]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=5,
                stderr_path=stderr,
                stdout_limit=limit,
                rss_interval=0.05,
            )
            self.assertEqual(result["status"], "complete")
            self.assertEqual(len(result["stdout"]), limit)

    def test_worker_case_missing_payload_worker_branch(self) -> None:
        missing = Path("/definitely-missing-h8a-worker-payload.json")
        proc = subprocess.run(
            [sys.executable, str(PROBE_DIR / "probe.py"), "--worker-case", str(missing)],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        combined = f"{proc.stdout}\n{proc.stderr}"
        self.assertNotIn("--hypothesis-freeze", combined)
        self.assertIn("worker payload missing", combined.lower())

    def test_cancellation_via_sigterm_to_supervisor(self) -> None:
        script = textwrap.dedent(
            f"""
            import importlib.util
            import sys
            import tempfile
            import os
            import signal
            import time
            from pathlib import Path
            spec = importlib.util.spec_from_file_location("h8a_cancel_probe", {repr(str(PROBE_DIR / "probe.py"))})
            mod = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = mod
            spec.loader.exec_module(mod)
            with tempfile.TemporaryDirectory() as tmp:
                stderr = Path(tmp) / "child.stderr.log"
                result = mod.run_bounded_child(
                    [sys.executable, "-c", "import time; time.sleep(30)"],
                    deadline_seconds=30,
                    stderr_path=stderr,
                    rss_interval=0.05,
                )
                print(result["status"])
            """
        )
        proc = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, text=True)
        time.sleep(0.2)
        proc.send_signal(signal.SIGTERM)
        stdout, _ = proc.communicate(timeout=10)
        self.assertIn("cancelled", stdout)

    def test_rss_limit_triggers_termination(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"

            def _hot(_pgid: int) -> tuple[int | None, bool]:
                return h8a.MAX_RSS_BYTES + 1, True

            command = [sys.executable, "-c", "import time; time.sleep(30)"]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=5,
                stderr_path=stderr,
                rss_sampler=_hot,
                rss_interval=0.01,
            )
            self.assertEqual(result["status"], "resource_limit")

    def test_stderr_drainer_read_failure_surfaces(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [sys.executable, "-c", "import time; time.sleep(0.2)"]

            class BrokenStream:
                def read(self, _size: int) -> bytes:
                    raise OSError("broken stderr pipe")

                def close(self) -> None:
                    return None

            drainer = h8a.BoundedStderrDrainer(BrokenStream(), stderr, 1024)
            drainer.start()
            with self.assertRaises(h8a.ProbeError) as ctx:
                drainer.join(2.0)
            self.assertIn("stderr drainer I/O failed", str(ctx.exception))

    def test_sampler_failure_returns_structured_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"

            def _boom(_pgid: int) -> tuple[int | None, bool]:
                raise RuntimeError("sampler exploded")

            command = [sys.executable, "-c", "import time; time.sleep(30)"]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=5,
                stderr_path=stderr,
                rss_sampler=_boom,
                rss_interval=0.01,
            )
            self.assertEqual(result["status"], "error")
            self.assertIn("operational failure", result.get("error") or "")
            self.assertIn("sampler exploded", result.get("error") or "")

    def test_child_tmpdir_removed_after_kill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            case_tmp = Path(tmp) / "worker-tmp" / "case-a"
            command = [
                sys.executable,
                "-c",
                textwrap.dedent(
                    """
                    import os, tempfile, time
                    path = os.path.join(os.environ["TMPDIR"], "owned.tmp")
                    with open(path, "w", encoding="utf-8") as stream:
                        stream.write("x")
                    time.sleep(30)
                    """
                ).strip(),
            ]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=0.4,
                stderr_path=stderr,
                child_tmpdir=case_tmp,
                rss_interval=0.05,
            )
            self.assertNotEqual(result["status"], "complete")
            self.assertTrue(result["parent_observed"]["child_tmpdir_removed"])
            self.assertFalse(case_tmp.exists())

    def test_stdout_one_byte_over_cap_after_exact_fill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            limit = 1024
            command = [
                sys.executable,
                "-c",
                textwrap.dedent(
                    f"""
                    import sys, time
                    sys.stdout.buffer.write(b"x" * {limit})
                    sys.stdout.flush()
                    sys.stdout.buffer.write(b"y")
                    sys.stdout.flush()
                    time.sleep(0.5)
                    """
                ).strip(),
            ]
            result = h8a.run_bounded_child(
                command,
                deadline_seconds=5,
                stderr_path=stderr,
                stdout_limit=limit,
                rss_interval=0.05,
            )
            self.assertEqual(result["status"], "resource_limit")


if __name__ == "__main__":
    unittest.main()
