import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
import unittest
from pathlib import Path

from preflight_runtime import BoundedLogWriter


SCRIPT = Path(__file__).with_name("run_freecol_preflight.py")
NAMESPACE_INIT = Path(__file__).with_name("namespace_init.py")
JAVA = Path("/usr/lib/jvm/java-21-openjdk-amd64/bin/java")
JAR = Path("/usr/share/java/FreeCol-1.1.0.jar")
JAVAC_MODULE = "jdk.compiler/com.sun.tools.javac.Main"
SPEC = importlib.util.spec_from_file_location("freecol_preflight", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class RunDirectoryTests(unittest.TestCase):
    def test_capture_ui_gate_fixture_allows_only_safe_persistent_hud(self):
        source_dir = Path(__file__).with_name("src") / "zorya" / "mapprobe"
        sources = [source_dir / "FreeColProbe.java", source_dir / "FreeColCaptureUiGateFixture.java"]
        with tempfile.TemporaryDirectory(prefix="freecol-ui-gate-test-") as temporary:
            build = Path(temporary) / "classes"
            build.mkdir()
            compile_result = subprocess.run(
                [str(JAVA), "-m", JAVAC_MODULE, "-classpath", str(JAR), "-d", str(build), *(str(path) for path in sources)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=60,
                check=False,
            )
            self.assertEqual(compile_result.returncode, 0, compile_result.stdout.decode("utf-8", errors="replace"))
            run_result = subprocess.run(
                [str(JAVA), "-classpath", f"{build}:{JAR}", "zorya.mapprobe.FreeColCaptureUiGateFixture"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=20,
                check=False,
            )
            self.assertEqual(run_result.returncode, 0, run_result.stdout.decode("utf-8", errors="replace"))
            self.assertIn(b"capture-ui-gate-fixtures: 7 passed", run_result.stdout)

    def test_nation_selection_gate_waits_for_attempt_and_matching_player_confirmation(self):
        source_dir = Path(__file__).with_name("src") / "zorya" / "mapprobe"
        sources = [source_dir / "FreeColProbe.java", source_dir / "FreeColNationSelectionFixture.java"]
        with tempfile.TemporaryDirectory(prefix="freecol-nation-gate-test-") as temporary:
            build = Path(temporary) / "classes"
            build.mkdir()
            compile_result = subprocess.run(
                [str(JAVA), "-m", JAVAC_MODULE, "-classpath", str(JAR), "-d", str(build), *(str(path) for path in sources)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=60,
                check=False,
            )
            self.assertEqual(compile_result.returncode, 0, compile_result.stdout.decode("utf-8", errors="replace"))
            run_result = subprocess.run(
                [str(JAVA), "-classpath", f"{build}:{JAR}", "zorya.mapprobe.FreeColNationSelectionFixture"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=20,
                check=False,
            )
            self.assertEqual(run_result.returncode, 0, run_result.stdout.decode("utf-8", errors="replace"))
            self.assertIn(b"nation-selection-fixtures: 17 passed", run_result.stdout)

    def test_optional_nation_selection_ids_are_paired_and_safe(self):
        probe.validate_nation_selection(None, None)
        probe.validate_nation_selection("model.nation.english", "model.nationType.immigration")
        for nation_id, nation_type_id in (
            ("model.nation.english", None),
            (None, "model.nationType.default"),
            ("model.nation.english, --save", "model.nationType.default"),
            ("../nation", "model.nationType.default"),
            ("model.nation.english", "model.nationType.default --save"),
        ):
            with self.subTest(nation_id=nation_id, nation_type_id=nation_type_id), self.assertRaises(ValueError):
                probe.validate_nation_selection(nation_id, nation_type_id)
        with self.assertRaises(ValueError):
            probe.validate_nation_selection("model.nation.english", "model.nationType.immigration", capture_requested=True)

    def test_agent_argument_builder_preserves_legacy_forms_and_actual_selection_order(self):
        output = Path("/tmp/live-state.json")
        save = Path("/tmp/official-state.fsg")
        capture = ("/tmp/screen.png", "/tmp/sprite.png", "unit:1", "-", "a" * 64)
        nation = "model.nation.english"
        nation_type = "model.nationType.immigration"
        self.assertEqual(len(probe.build_agent_arguments(output, 1000, None, None, None, None).split(",")), 2)
        self.assertEqual(len(probe.build_agent_arguments(output, 1000, save, None, None, None).split(",")), 3)
        self.assertEqual(len(probe.build_agent_arguments(output, 1000, None, capture, None, None).split(",")), 7)
        self.assertEqual(len(probe.build_agent_arguments(output, 1000, save, capture, None, None).split(",")), 8)
        selection_only = probe.build_agent_arguments(output, 1000, None, None, nation, nation_type).split(",")
        self.assertEqual(selection_only[2:], [nation, nation_type])
        selected_save = probe.build_agent_arguments(output, 1000, save, None, nation, nation_type).split(",")
        self.assertEqual(selected_save[2:], [str(save), nation, nation_type])
        with self.assertRaises(ValueError):
            probe.build_agent_arguments(output, 1000, save, capture, nation, nation_type)

    def test_evidence_root_is_an_exact_two_path_allowlist_with_legacy_default(self):
        self.assertEqual(probe.EXPECTED_ROOT, Path("/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-map"))
        self.assertEqual(probe.ALLOWED_EVIDENCE_ROOTS, (
            Path("/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-map"),
            Path("/root/.codex/artifacts/zorya-classifier-mcp-20261101/freecol-caravel"),
        ))

    def test_official_save_inventory_counts_only_complete_dynamic_units(self):
        with tempfile.TemporaryDirectory(prefix="freecol-savegame-test-") as temporary:
            path = Path(temporary) / "state.fsg"
            xml = (
                '<savedGame><game><unit id="unit:1" unitType="model.unit.merchantman" '
                'owner="player:1" location="tile:2"/><unit id="model.unit.ship"/>'
                '<aiUnit id="unit:1" value="0"/></game></savedGame>'
            )
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("savegame.xml", xml)
            inventory = probe.inspect_official_savegame(path)
            self.assertTrue(inventory["complete"])
            self.assertEqual(inventory["dynamicUnitCount"], 1)
            self.assertEqual(inventory["unitTypeCounts"], {"model.unit.merchantman": 1})
            self.assertEqual(inventory["units"], [{
                "id": "unit:1",
                "typeId": "model.unit.merchantman",
                "ownerId": "player:1",
                "locationId": "tile:2",
            }])

    def test_source_closure_is_snapshotted_before_compile_and_hashes_exact_files(self):
        with tempfile.TemporaryDirectory(prefix="freecol-source-test-") as temporary:
            base = Path(temporary)
            source = base / "source"
            source.mkdir()
            for index, relative in enumerate(probe.SOURCE_FILES):
                target = source / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f"fixture-{index}\n", encoding="utf-8")
            run_dir = base / "run"
            run_dir.mkdir()
            snapshot, receipt = probe.snapshot_source_closure(source, run_dir)
            self.assertTrue(receipt["capturedBeforeCompile"])
            self.assertEqual(len(receipt["files"]), 9)
            self.assertEqual(receipt["closureSha256"], hashlib.sha256(
                "".join(f"{entry['path']}\0{entry['sha256']}\n" for entry in receipt["files"]).encode("utf-8")
            ).hexdigest())
            original = source / probe.SOURCE_FILES[-1]
            original.write_text("changed-after-snapshot\n", encoding="utf-8")
            self.assertEqual((snapshot / probe.SOURCE_FILES[-1]).read_text(encoding="utf-8"), f"fixture-{len(probe.SOURCE_FILES) - 1}\n")
            self.assertEqual(json.loads((snapshot / "source-snapshot.json").read_text(encoding="utf-8")), receipt)

    def test_exact_run_dir_cleanup_preserves_sibling_sentinel(self):
        with tempfile.TemporaryDirectory(prefix="freecol-preflight-test-") as temporary:
            base = Path(temporary)
            root = base / "artifacts"
            approved = base / "artifacts"
            run_dir = probe.create_owned_run_dir(root, "case-01", approved)
            sentinel = base / "sibling-sentinel.txt"
            sentinel.write_text("keep", encoding="utf-8")
            self.assertEqual(run_dir.parent, root)
            shutil.rmtree(run_dir)
            self.assertTrue(sentinel.is_file())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_refuses_broad_or_different_root(self):
        with tempfile.TemporaryDirectory(prefix="freecol-preflight-test-") as temporary:
            base = Path(temporary)
            with self.assertRaises(ValueError):
                probe.create_owned_run_dir(base, "case-01", base / "nested-owned")
            self.assertTrue(base.is_dir())

    def test_refuses_reused_run_id_and_path_traversal(self):
        with tempfile.TemporaryDirectory(prefix="freecol-preflight-test-") as temporary:
            root = Path(temporary) / "artifacts"
            root.mkdir()
            approved = root
            first = probe.create_owned_run_dir(root, "case-01", approved)
            with self.assertRaises(FileExistsError):
                probe.create_owned_run_dir(root, "case-01", approved)
            with self.assertRaises(ValueError):
                probe.create_owned_run_dir(root, "../outside", approved)
            self.assertTrue(first.is_dir())

    def test_private_cleanup_requires_marker_and_preserves_sibling(self):
        with tempfile.TemporaryDirectory(prefix="freecol-preflight-test-") as temporary:
            base = Path(temporary)
            run_dir = base / "run"
            run_dir.mkdir()
            private = probe.make_private_dirs(run_dir)
            sibling = base / "sibling-sentinel.txt"
            sibling.write_text("keep", encoding="utf-8")
            self.assertTrue(probe.remove_owned_private_root(run_dir))
            self.assertFalse((run_dir / "private").exists())
            self.assertTrue(sibling.is_file())
            self.assertEqual(sibling.read_text(encoding="utf-8"), "keep")
            self.assertIn("home", private)

    def test_private_cleanup_refuses_missing_marker(self):
        with tempfile.TemporaryDirectory(prefix="freecol-preflight-test-") as temporary:
            run_dir = Path(temporary) / "run"
            run_dir.mkdir()
            private = run_dir / "private"
            private.mkdir()
            (private / "preserve.txt").write_text("keep", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                probe.remove_owned_private_root(run_dir)
            self.assertTrue((private / "preserve.txt").is_file())

    def test_owned_group_is_terminated_and_closed(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        result = probe.stop_owned_group(child, grace_seconds=1.0)
        self.assertTrue(result["closed"])
        self.assertIsNotNone(child.poll())

    def test_owned_group_reaps_fast_exit_before_closure_check(self):
        child = subprocess.Popen(
            ["/usr/bin/true"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        child.wait(timeout=2)
        result = probe.stop_owned_group(child, grace_seconds=1.0)
        self.assertTrue(result["closed"])
        self.assertTrue(result.get("alreadyExited"))

    def test_owned_group_closes_orphaned_descendant(self):
        worker_code = (
            "import signal, subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
            "signal.signal(signal.SIGTERM, lambda *_: child.terminate())\n"
            "while child.poll() is None: time.sleep(0.02)\n"
        )
        worker = subprocess.Popen(
            [sys.executable, "-c", worker_code],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        time.sleep(0.1)
        result = probe.stop_owned_group(worker, grace_seconds=2.0)
        self.assertTrue(result["closed"])
        self.assertIsNotNone(worker.poll())

    def test_oversize_output_is_capped_and_reported(self):
        with tempfile.TemporaryDirectory(prefix="freecol-preflight-test-") as temporary:
            path = Path(temporary) / "bounded.log"
            with path.open("wb") as stream:
                sink = BoundedLogWriter({"stdout": stream}, limit=32)
                sink.write("stdout", b"a" * 24)
                sink.write("stdout", b"b" * 16)
            self.assertTrue(sink.overflowed)
            self.assertEqual(sink.bytes_written, 32)
            self.assertEqual(path.stat().st_size, 32)

    def test_namespace_init_reaps_adopted_orphan_and_preserves_worker_status(self):
        with tempfile.TemporaryDirectory(prefix="freecol-reaper-test-") as temporary:
            root = Path(temporary)
            run_dir = root / "run"
            run_dir.mkdir()
            worker = root / "orphan_worker.py"
            worker.write_text(
                "import subprocess, sys\n"
                "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(0.15)'], "
                "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)\n"
                "print('x' * 10000)\n"
                "raise SystemExit(0)\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, str(NAMESPACE_INIT), str(worker), str(run_dir), "10", "1"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=5,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
            receipt = json.loads((run_dir / "namespace-receipt.json").read_text(encoding="utf-8"))
            self.assertEqual(receipt["sessionWorkerReturnCode"], 0)
            self.assertGreaterEqual(receipt["reapedOrphanChildCount"], 1)
            self.assertTrue(receipt["allNamespaceChildrenReaped"])
            self.assertFalse(receipt["forcedNamespaceCleanup"])
            self.assertTrue(receipt["sessionWorkerOutputTruncated"])
            self.assertEqual(len(receipt["sessionWorkerStdout"]), 8192)


if __name__ == "__main__":
    unittest.main()
