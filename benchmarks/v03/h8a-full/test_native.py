#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

MODULE_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("h8af_common_test", MODULE_DIR / "native-common.py")
assert _spec and _spec.loader
common = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = common
_spec.loader.exec_module(common)


class TargetTests(unittest.TestCase):
    def test_dino_prompt_is_generic_prefix_plus_verbatim_target(self) -> None:
        target = "the visible body sprite of unit type Explorer in the main Freeciv map canvas"
        self.assertEqual(common.build_dino_prompt(target), f"a {target}")
        self.assertEqual(common.build_dino_prompt("Car"), "a Car")

    def test_freeciv_string_is_not_normalized(self) -> None:
        grounded = common.load_pinned_module(
            common.PINNED_HELPERS[0][0], common.PINNED_HELPERS[0][1], "test_grounded_target"
        )
        raw = (
            "the visible body sprite of unit type Explorer in the main Freeciv map canvas; "
            "exclude health bars and selection brackets"
        )
        self.assertEqual(common.build_dino_prompt(raw), f"a {raw}")
        self.assertNotEqual(common.build_dino_prompt(raw), f"a {grounded.normalize_target(raw)}")

    def test_recipe_specific_processor_text_preserves_v1_and_flattens_only_v2(self) -> None:
        prompt = "a toolbar button for Search for Files..."
        self.assertEqual(
            common.build_processor_text("h8a-cpu-raw-target-v1", prompt), [[prompt]]
        )
        self.assertEqual(
            common.build_processor_text("h8a-cpu-flat-target-v2", prompt),
            "a toolbar button for search for files...",
        )
        self.assertEqual(
            common.build_processor_text("h8a-cpu-flat-target-v2", "a Thing, e.g. UI"),
            "a thing, e.g. ui.",
        )
        with self.assertRaises(common.WorkerError):
            common.build_processor_text("h8a-unsupported", prompt)

    def test_v1_and_v2_recipe_json_are_pinned_to_distinct_target_policies(self) -> None:
        v1 = common.load_pinned_recipe("h8a-cpu-raw-target-v1")
        v2 = common.load_pinned_recipe("h8a-cpu-flat-target-v2")
        self.assertEqual(v1["target_policy"], {"dino_prefix": "a ", "verbatim_authored_target": True})
        self.assertEqual(
            v2["target_policy"],
            {
                "dino_prefix": "a ",
                "verbatim_authored_target": True,
                "processor_text": "stripped-lower-terminal-period",
            },
        )
        with self.assertRaises(common.WorkerError):
            common.load_pinned_recipe("h8a-unsupported")


class HeaderValidationTests(unittest.TestCase):
    def test_header_validation_before_full_decode(self) -> None:
        from PIL import Image
        import io

        image = Image.new("RGB", (640, 480), (10, 20, 30))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        encoded = buffer.getvalue()
        width, height = common.oriented_dimensions_from_header(encoded)
        self.assertEqual((width, height), (640, 480))

    def test_oversized_dimensions_rejected(self) -> None:
        with self.assertRaises(common.WorkerError):
            common.oriented_dimensions_from_header(b"\x89PNG\r\n\x1a\n" + b"x" * 32)


class GeometryTests(unittest.TestCase):
    def test_u_expansion_matches_pinned_h4e(self) -> None:
        h4e = common.load_pinned_module(common.PINNED_HELPERS[2][0], common.PINNED_HELPERS[2][1], "test_h4e")
        expanded = h4e.expand_prompt_box([100.0, 200.0, 200.0, 300.0], 1280, 800)
        self.assertEqual(expanded[0], 75.0)
        self.assertEqual(expanded[1], 175.0)

    def test_letterbox_rounded_geometry(self) -> None:
        omni = common.load_pinned_module(common.PINNED_HELPERS[1][0], common.PINNED_HELPERS[1][1], "test_omni")
        transform = omni.letterbox_transform(1280, 800, 1280)
        self.assertEqual(transform.resized_width, 1280)
        mapped = omni.source_box_from_canvas((10.0, 20.0, 30.0, 40.0), transform)
        self.assertIsNotNone(mapped)


class PackedMaskTests(unittest.TestCase):
    def test_padding_bits_rejected(self) -> None:
        with self.assertRaises(common.WorkerError):
            common.validate_packed_bytes(b"\x0f", 3, 1)

    def test_valid_pack_roundtrip(self) -> None:
        try:
            np = __import__("numpy")
        except ModuleNotFoundError:
            self.skipTest("numpy not installed")
        mask = np.array([[True, False, True], [False, True, False]], dtype=bool)
        packed = common.pack_mask_with_validation(mask, 3, 2)
        self.assertEqual(len(packed), common.packed_mask_byte_length(3, 2))


class RequestSchemaTests(unittest.TestCase):
    def test_unknown_request_fields_rejected(self) -> None:
        payload = {
            "schema": common.NATIVE_REQUEST_SCHEMA,
            "request_id": "00000000-0000-4000-8000-000000000003",
            "recipe_id": common.RECIPE_ID,
            "authored_target": "fixture target",
            "task_dir": "/tmp/h8af-task",
            "assets_dir": "/tmp/assets",
            "source_path": "/tmp/source.png",
            "source_sha256": "c" * 64,
            "width": 10,
            "height": 10,
            "unexpected_field": True,
        }
        with self.assertRaises(common.WorkerError):
            common.validate_native_request(payload)

    def test_detector_prompt_must_match_authored_target(self) -> None:
        payload = {
            "schema": common.NATIVE_REQUEST_SCHEMA,
            "request_id": "00000000-0000-4000-8000-000000000004",
            "recipe_id": common.RECIPE_ID,
            "authored_target": "fixture target",
            "task_dir": "/tmp/h8af-task",
            "assets_dir": "/tmp/assets",
            "source_path": "/tmp/source.png",
            "source_sha256": "d" * 64,
            "width": 10,
            "height": 10,
            "detector_prompt": "a wrong prompt",
        }
        with self.assertRaises(common.WorkerError):
            common.validate_native_request(payload)

    def test_repo_task_dir_rejected(self) -> None:
        payload = {
            "schema": common.NATIVE_REQUEST_SCHEMA,
            "request_id": "00000000-0000-4000-8000-000000000001",
            "recipe_id": common.RECIPE_ID,
            "authored_target": "fixture target",
            "task_dir": str(common.REPO_ROOT / "tmp-h8af"),
            "assets_dir": "/tmp/assets",
            "source_path": "/tmp/source.png",
            "source_sha256": "a" * 64,
            "width": 10,
            "height": 10,
        }
        with self.assertRaises(common.WorkerError):
            common.validate_native_request(payload)


class AssetVerificationTests(unittest.TestCase):
    def test_symlink_asset_rejected(self) -> None:
        grounded = common.load_pinned_module(
            common.PINNED_HELPERS[0][0], common.PINNED_HELPERS[0][1], "test_grounded_asset"
        )
        good_bytes = b"h8af-pinned-good-bytes"
        good_item = {
            "repo": "fixture/repo",
            "revision": "fixture-rev",
            "directory": "grounding-dino-tiny",
            "filename": "added_tokens.json",
            "size": len(good_bytes),
            "sha256": hashlib.sha256(good_bytes).hexdigest(),
        }
        bad_item = {
            "repo": "fixture/repo",
            "revision": "fixture-rev",
            "directory": "grounding-dino-tiny",
            "filename": "config.json",
            "size": 1,
            "sha256": "e" * 64,
        }
        with mock.patch.object(grounded, "MODEL_FILES", (good_item, bad_item)):
            with tempfile.TemporaryDirectory() as tmp:
                assets = Path(tmp)
                good_path = assets / good_item["directory"] / good_item["filename"]
                good_path.parent.mkdir(parents=True, exist_ok=True)
                good_path.write_bytes(good_bytes)
                link = assets / bad_item["directory"] / bad_item["filename"]
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(good_path)
                with self.assertRaises(RuntimeError) as ctx:
                    common.verify_model_assets(assets, grounded)
                self.assertIn(str(link), str(ctx.exception))


class WorkerCliTests(unittest.TestCase):
    def test_self_test_mode(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(MODULE_DIR / "native-worker.py"), "--self-test"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertIn("self_test_ok", proc.stdout)

    def test_validate_request_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            request_path = Path(tmp) / "request.json"
            task_dir = Path(tmp) / "task-out"
            task_dir.mkdir()
            request_path.write_text(
                json.dumps(
                    {
                        "schema": common.NATIVE_REQUEST_SCHEMA,
                        "request_id": "00000000-0000-4000-8000-000000000002",
                        "recipe_id": common.RECIPE_ID,
                        "authored_target": "fixture target",
                        "task_dir": str(task_dir),
                        "assets_dir": str(Path(tmp) / "assets"),
                        "source_path": str(Path(tmp) / "source.png"),
                        "source_sha256": "b" * 64,
                        "width": 12,
                        "height": 10,
                    }
                ),
                encoding="utf-8",
            )
            proc = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_DIR / "native-worker.py"),
                    "--validate-request",
                    str(request_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0)
            self.assertIn("valid", proc.stdout)


class ChildLifecycleTests(unittest.TestCase):
    def test_complete_fake_child(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [sys.executable, "-c", "import json; print(json.dumps({'status':'complete'}))"]
            result = common.run_bounded_child(command, deadline_seconds=5, stderr_path=stderr)
            self.assertEqual(result["status"], "complete")

    def test_timeout_fake_child(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = Path(tmp) / "child.stderr.log"
            command = [sys.executable, "-c", "import time; time.sleep(30)"]
            started = time.monotonic()
            result = common.run_bounded_child(
                command, deadline_seconds=0.3, stderr_path=stderr, rss_interval=0.05
            )
            self.assertEqual(result["status"], "timeout")
            self.assertLess(time.monotonic() - started, 5.0)


if __name__ == "__main__":
    unittest.main()
