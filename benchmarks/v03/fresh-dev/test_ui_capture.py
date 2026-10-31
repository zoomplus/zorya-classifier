#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[2]


def load_ui_capture():
    spec = importlib.util.spec_from_file_location("fresh_dev_ui_capture", ROOT / "ui_capture.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["fresh_dev_ui_capture"] = module
    spec.loader.exec_module(module)
    return module


ui_capture = load_ui_capture()


def external_temp_dir() -> Path:
    parent = Path(tempfile.mkdtemp(prefix="zorya-ui-parent-", dir="/tmp"))
    bundle = parent / "bundle"
    if ui_capture.path_is_inside_repo(bundle):
        raise RuntimeError("temp dir must be outside repository")
    return bundle


def external_pictures_base() -> Path:
    base = Path(tempfile.mkdtemp(prefix="zorya-ui-pictures-", dir="/tmp"))
    if str(base.resolve()).startswith("/root"):
        raise RuntimeError("pictures base must resolve outside /root")
    return base


def remove_owned_temp_root(path: Path, prefix: str) -> None:
    """Remove one exact tempfile root created by this test module."""
    resolved = path.absolute()
    if resolved.parent != Path("/tmp") or not resolved.name.startswith(prefix):
        raise AssertionError(f"refusing to remove non-owned temp root: {path}")
    if resolved.is_symlink():
        raise AssertionError(f"refusing to remove symlink temp root: {path}")
    if resolved.exists():
        shutil.rmtree(resolved)


def remove_owned_bundle(bundle: Path) -> None:
    parent = bundle.parent
    if bundle.name != "bundle":
        raise AssertionError(f"refusing to remove unexpected bundle path: {bundle}")
    remove_owned_temp_root(parent, "zorya-ui-parent-")


class ImportHygieneTests(unittest.TestCase):
    def test_module_import_does_not_load_pyatspi(self) -> None:
        self.assertNotIn("pyatspi", sys.modules)


class PrepareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pictures_base = external_pictures_base()
        ui_capture.set_outside_root_pictures_base_for_tests(self.pictures_base)

    def tearDown(self) -> None:
        ui_capture.set_outside_root_pictures_base_for_tests(None)
        remove_owned_temp_root(self.pictures_base, "zorya-ui-pictures-")

    def test_prepare_creates_deterministic_manifest(self) -> None:
        out_a = external_temp_dir()
        out_b = external_temp_dir()
        try:
            code_a = ui_capture.main(["prepare", "--output-dir", str(out_a)])
            code_b = ui_capture.main(["prepare", "--output-dir", str(out_b)])
            self.assertEqual(code_a, 0)
            self.assertEqual(code_b, 0)
            raw_a = (out_a / "private" / "state-manifest.json").read_bytes()
            raw_b = (out_b / "private" / "state-manifest.json").read_bytes()
            self.assertEqual(raw_a, raw_b)
            manifest = json.loads(raw_a.decode("utf-8"))
            ui_capture.validate_quota_manifest(manifest)
            self.assertEqual(manifest["quotas"]["present"], 7)
            self.assertEqual(manifest["quotas"]["absent"], 3)
            case_ids = [row["caseId"] for row in manifest["rows"]]
            self.assertEqual(len(case_ids), len(set(case_ids)))
        finally:
            remove_owned_bundle(out_a)
            remove_owned_bundle(out_b)

    def test_prepare_rejects_existing_output_dir(self) -> None:
        out = external_temp_dir()
        out.mkdir(parents=True, exist_ok=True)
        try:
            with self.assertRaises(ui_capture.UiCaptureError):
                ui_capture.cmd_prepare(argparse_namespace(output_dir=str(out)))
        finally:
            remove_owned_bundle(out)

    def test_prepare_rejects_repo_path(self) -> None:
        out = REPO_ROOT / ".ui-capture-should-not-create"
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.require_external_new_directory(out, "prepare output directory")


class OracleTests(unittest.TestCase):
    def _frame(self) -> dict[str, int]:
        return {"x": 100, "y": 80, "width": 640, "height": 480}

    def _inventory(self, nodes: list[dict[str, object]]) -> dict[str, object]:
        return {
            "complete": True,
            "traversalErrors": [],
            "nodes": nodes,
            "appFrameExtents": self._frame(),
            "viewport": {"width": 1280, "height": 1024},
        }

    def test_positive_requires_exactly_one_match(self) -> None:
        target = ui_capture.TargetSpec("push button", "Back")
        nodes = [
            {
                "role": "push button",
                "name": "Back",
                "showing": True,
                "visible": True,
                "extents": {"x": 120, "y": 90, "width": 40, "height": 24},
            }
        ]
        result = ui_capture.evaluate_case_oracle(
            inventory=self._inventory(nodes),
            expected_presence="present",
            target_role=target.role,
            target_name=target.name,
        )
        self.assertEqual(result["matchCount"], 1)

    def test_positive_rejects_zero_or_many(self) -> None:
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.evaluate_case_oracle(
                inventory=self._inventory([]),
                expected_presence="present",
                target_role="push button",
                target_name="Back",
            )
        nodes = [
            {
                "role": "push button",
                "name": "Back",
                "showing": True,
                "visible": True,
                "extents": {"x": 120, "y": 90, "width": 40, "height": 24},
            },
            {
                "role": "push button",
                "name": "Back",
                "showing": True,
                "visible": True,
                "extents": {"x": 200, "y": 90, "width": 40, "height": 24},
            },
        ]
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.evaluate_case_oracle(
                inventory=self._inventory(nodes),
                expected_presence="present",
                target_role="push button",
                target_name="Back",
            )

    def test_negative_requires_zero_matches_in_frame(self) -> None:
        nodes = [
            {
                "role": "push button",
                "name": "Fullscreen",
                "showing": True,
                "visible": True,
                "extents": {"x": 900, "y": 90, "width": 40, "height": 24},
            }
        ]
        frame = self._frame()
        target = ui_capture.TargetSpec("push button", "Fullscreen")
        outside = collect_matches(nodes, target, frame)
        self.assertEqual(len(outside), 0)
        ui_capture.evaluate_case_oracle(
            inventory=self._inventory(nodes),
            expected_presence="absent",
            target_role=target.role,
            target_name=target.name,
        )

    def test_incomplete_inventory_rejected(self) -> None:
        inv = self._inventory([])
        inv["complete"] = False
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.evaluate_case_oracle(
                inventory=inv,
                expected_presence="present",
                target_role="push button",
                target_name="Zoom In",
            )


class AtspiInventoryTests(unittest.TestCase):
    class States:
        def __init__(self, values: set[int]) -> None:
            self.values = values

        def contains(self, value: int) -> bool:
            return value in self.values

    class Extents:
        def __init__(self, x: int, y: int, width: int, height: int) -> None:
            self.x = x
            self.y = y
            self.width = width
            self.height = height

    class Accessible:
        def __init__(
            self,
            role: str,
            name: str,
            *,
            children: list["AtspiInventoryTests.Accessible"] | None = None,
            extents: "AtspiInventoryTests.Extents | None" = None,
            showing: bool = True,
            visible: bool = True,
        ) -> None:
            self.role = role
            self.name = name
            self.children = children or []
            self.extents = extents
            self.showing = showing
            self.visible = visible

        @property
        def childCount(self) -> int:
            return len(self.children)

        def getChildAtIndex(self, index: int) -> "AtspiInventoryTests.Accessible":
            return self.children[index]

        def getRoleName(self) -> str:
            return self.role

        def getState(self) -> "AtspiInventoryTests.States":
            values = set()
            if self.showing:
                values.add(1)
            if self.visible:
                values.add(2)
            return AtspiInventoryTests.States(values)

        def queryComponent(self) -> "AtspiInventoryTests.Accessible":
            if self.extents is None:
                raise NotImplementedError("accessible has no component")
            return self

        def getExtents(self, coordinate_type: int) -> "AtspiInventoryTests.Extents":
            if coordinate_type != 3 or self.extents is None:
                raise AssertionError("wrong coordinate type or no extents")
            return self.extents

    def _collect(
        self,
        app_names: list[str],
        *,
        source_group: str = "thunar",
        frame_counts: list[int] | None = None,
    ) -> dict[str, object]:
        applications = []
        counts = frame_counts or [1] * len(app_names)
        for name, frame_count in zip(app_names, counts, strict=True):
            frames = [
                self.Accessible(
                    "frame",
                    f"{name} window {index}",
                    extents=self.Extents(100 + index, 80, 640, 480),
                )
                for index in range(frame_count)
            ]
            app = self.Accessible("application", name, children=frames, showing=False, visible=False)
            applications.append(app)
        desktop = self.Accessible("desktop frame", "main", children=applications)
        pyatspi = SimpleNamespace(
            Registry=SimpleNamespace(getDesktop=lambda index: desktop),
            STATE_SHOWING=1,
            STATE_VISIBLE=2,
            DESKTOP_COORDS=3,
        )
        with patch.dict(sys.modules, {"pyatspi": pyatspi}):
            return ui_capture._collect_atspi_inventory({"sourceGroup": source_group})

    def _row(self) -> dict[str, str]:
        return {
            "caseId": "d" * 36,
            "sourceGroup": "thunar",
            "expectedPresence": "present",
            "targetRole": "push button",
            "targetName": "Back",
        }

    def test_real_app_name_uses_unique_visible_child_frame(self) -> None:
        inventory = self._collect(["thunar"])
        self.assertTrue(inventory["complete"])
        self.assertEqual(inventory["applicationNames"], ["thunar"])
        self.assertEqual(inventory["applicationMatchCount"], 1)
        self.assertEqual(
            inventory["appFrameExtents"],
            {"x": 100, "y": 80, "width": 640, "height": 480},
        )
        self.assertEqual(len(inventory["frameCandidates"]), 1)
        self.assertIsNone(inventory["nodes"][0].get("extents"))

    def test_unknown_application_name_is_not_a_negative_case(self) -> None:
        inventory = self._collect(["Thunar"])
        self.assertEqual(inventory["applicationMatchCount"], 0)
        self.assertIsNone(inventory["appFrameExtents"])
        with self.assertRaisesRegex(ui_capture.UiCaptureError, "exactly one expected application"):
            ui_capture.evaluate_case_oracle(
                inventory=inventory,
                expected_presence="absent",
                target_role="push button",
                target_name="Back",
            )

    def test_duplicate_expected_application_is_rejected(self) -> None:
        inventory = self._collect(["thunar", "thunar"])
        self.assertEqual(inventory["applicationMatchCount"], 2)
        self.assertEqual(len(inventory["frameCandidates"]), 2)
        with self.assertRaisesRegex(ui_capture.UiCaptureError, "exactly one expected application"):
            ui_capture.evaluate_case_oracle(
                inventory=inventory,
                expected_presence="present",
                target_role="push button",
                target_name="Back",
            )

    def test_multiple_visible_frames_are_rejected(self) -> None:
        inventory = self._collect(["thunar"], frame_counts=[2])
        self.assertEqual(inventory["applicationMatchCount"], 1)
        self.assertEqual(len(inventory["frameCandidates"]), 2)
        self.assertIsNone(inventory["appFrameExtents"])
        self.assertEqual(
            ui_capture._atspi_inventory_readiness_error(
                inventory,
                self._row(),
                require_target=False,
            ),
            "expected exactly one visible in-viewport application frame",
        )

    def test_eog_exact_application_name_uses_frame_child(self) -> None:
        inventory = self._collect(["eog"], source_group="eog")
        self.assertEqual(inventory["expectedApplicationName"], "eog")
        self.assertEqual(inventory["applicationMatchCount"], 1)
        self.assertEqual(len(inventory["frameCandidates"]), 1)

    def test_inventory_uses_expected_source_group_name(self) -> None:
        inventory = self._collect(["thunar"])
        row = self._row()
        self.assertIsNone(ui_capture._atspi_inventory_readiness_error(inventory, row, require_target=False))


def collect_matches(
    nodes: list[dict[str, object]],
    target: ui_capture.TargetSpec,
    frame: dict[str, int],
) -> list[dict[str, object]]:
    return ui_capture.collect_target_matches(nodes, target, app_frame=frame)


class CaptureGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pictures_base = external_pictures_base()
        ui_capture.set_outside_root_pictures_base_for_tests(self.pictures_base)

    def tearDown(self) -> None:
        ui_capture.set_outside_root_pictures_base_for_tests(None)
        remove_owned_temp_root(self.pictures_base, "zorya-ui-pictures-")

    def test_capture_rejects_wrong_approved_hash(self) -> None:
        out = external_temp_dir()
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(out)]), 0)
            _, digest = ui_capture.load_frozen_state_manifest(out)
            wrong = "0" * 64
            self.assertNotEqual(wrong, digest)
            code = ui_capture.main(
                [
                    "capture",
                    "--bundle",
                    str(out),
                    "--approved-manifest-sha256",
                    wrong,
                    "--approved-preflight-summary-sha256",
                    "a" * 64,
                ]
            )
            self.assertEqual(code, 2)
        finally:
            remove_owned_bundle(out)

    def test_capture_rejects_invalid_hash_format(self) -> None:
        out = external_temp_dir()
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(out)]), 0)
            code = ui_capture.main(
                [
                    "capture",
                    "--bundle",
                    str(out),
                    "--approved-manifest-sha256",
                    "not-a-hash",
                    "--approved-preflight-summary-sha256",
                    "a" * 64,
                ]
            )
            self.assertEqual(code, 2)
        finally:
            remove_owned_bundle(out)


class ProducerSanitizeTests(unittest.TestCase):
    def test_producer_row_forbids_truth_keys(self) -> None:
        row = ui_capture.sanitize_producer_row(
            {
                "caseId": "00000000-0000-4000-8000-000000000001",
                "target": "Back",
                "image": {
                    "path": "private/screenshots/x.png",
                    "sha256": "a" * 64,
                    "width": 1280,
                    "height": 1024,
                },
            },
            screenshot_rel="private/screenshots/x.png",
            screenshot_sha="a" * 64,
            width=1280,
            height=1024,
        )
        self.assertEqual(set(row.keys()), {"caseId", "target", "image"})
        self.assertNotIn("expectedPresence", row)
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.sanitize_producer_row(
                {
                    "caseId": "x",
                    "target": "Back",
                    "expectedPresence": "present",
                    "image": {"path": "p", "sha256": "a" * 64, "width": 1, "height": 1},
                },
                screenshot_rel="p",
                screenshot_sha="a" * 64,
                width=1,
                height=1,
            )


class RosterTests(unittest.TestCase):
    def test_case_specs_match_accepted_roster(self) -> None:
        by_slot = {spec.slot_key: spec for spec in ui_capture.CASE_SPECS}
        self.assertEqual(
            by_slot["thunar-p1"].target,
            ui_capture.TargetSpec("push button", "Back"),
        )
        self.assertEqual(
            by_slot["thunar-p4"].target,
            ui_capture.TargetSpec("toggle button", "Search for Files..."),
        )
        self.assertEqual(
            by_slot["thunar-n1"].target,
            ui_capture.TargetSpec("push button", "Fullscreen"),
        )
        self.assertEqual(
            by_slot["eog-p1"].target,
            ui_capture.TargetSpec("push button", "Zoom In"),
        )
        self.assertEqual(
            by_slot["eog-n1"].target,
            ui_capture.TargetSpec("toggle button", "Search for Files..."),
        )
        self.assertEqual(
            by_slot["eog-n2"].target,
            ui_capture.TargetSpec("push button", "Open Parent"),
        )


class FakePreflightSummaryTests(unittest.TestCase):
    def _fixture(self) -> tuple[dict[str, object], dict[str, object]]:
        rows: list[dict[str, str]] = []
        for spec in ui_capture.CASE_SPECS:
            rows.append(
                {
                    "caseId": ui_capture.deterministic_uuid(f"case:{spec.slot_key}"),
                    "sourceStateId": ui_capture.deterministic_uuid(f"state:{spec.slot_key}"),
                    "sourceGroup": spec.source_group,
                    "expectedPresence": spec.expected_presence,
                    "targetRole": spec.target.role,
                    "targetName": spec.target.name,
                }
            )
        manifest: dict[str, object] = {"rows": rows}
        frame = {"x": 100, "y": 80, "width": 640, "height": 480}
        cases: list[dict[str, object]] = []
        for row in rows:
            nodes: list[dict[str, object]] = [
                {
                    "role": "frame",
                    "name": "fixture window",
                    "showing": True,
                    "visible": True,
                    "extents": frame,
                    "applicationIndex": 0,
                }
            ]
            if row["expectedPresence"] == "present":
                nodes.append(
                    {
                        "role": row["targetRole"],
                        "name": row["targetName"],
                        "showing": True,
                        "visible": True,
                        "extents": {"x": 120, "y": 100, "width": 40, "height": 24},
                        "applicationIndex": 0,
                    }
                )
            inventory = {
                "complete": True,
                "traversalErrors": [],
                "applicationNames": [row["sourceGroup"]],
                "expectedApplicationName": row["sourceGroup"],
                "applicationMatchCount": 1,
                "frameCandidates": [{"applicationIndex": 0, "name": "fixture window", "extents": frame}],
                "nodes": nodes,
                "appFrameExtents": frame,
                "viewport": {"width": 1280, "height": 1024},
            }
            oracle = ui_capture.evaluate_case_oracle(
                inventory=inventory,
                expected_presence=row["expectedPresence"],
                target_role=row["targetRole"],
                target_name=row["targetName"],
            )
            cases.append(
                {
                    "schemaVersion": ui_capture.PREFLIGHT_RECEIPT_SCHEMA,
                    "caseId": row["caseId"],
                    "sourceStateId": row["sourceStateId"],
                    "preInventory": inventory,
                    "postInventory": inventory,
                    "preOracle": oracle,
                    "postOracle": oracle,
                    "screenshot": None,
                    "viewport": {"width": 1280, "height": 1024},
                }
            )
        case_ids = [row["caseId"] for row in rows]
        summary = {
            "schemaVersion": ui_capture.PREFLIGHT_RECEIPT_SCHEMA,
            "status": "complete",
            "stateManifestSha256": "b" * 64,
            "caseCount": len(cases),
            "caseIds": case_ids,
            "resourceReceipts": {},
            "cases": cases,
            "viewport": {"width": 1280, "height": 1024},
        }
        return manifest, summary

    def test_preflight_summary_requires_complete_exact_roster_and_oracles(self) -> None:
        manifest, summary = self._fixture()
        ui_capture.validate_preflight_summary_document(
            summary, manifest, state_manifest_sha256="b" * 64
        )
        wrong_count = dict(summary, caseCount=9)
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.validate_preflight_summary_document(
                wrong_count, manifest, state_manifest_sha256="b" * 64
            )
        wrong_app = json.loads(json.dumps(summary))
        wrong_app["cases"][0]["preInventory"]["applicationNames"] = ["unrelated"]
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.validate_preflight_summary_document(
                wrong_app, manifest, state_manifest_sha256="b" * 64
            )

    def test_capture_requires_matching_successful_preflight_before_outputs(self) -> None:
        bundle = external_temp_dir()
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle)]), 0)
            _manifest, digest = ui_capture.load_frozen_state_manifest(bundle)
            args = SimpleNamespace(
                bundle=str(bundle),
                approved_manifest_sha256=digest,
                approved_preflight_summary_sha256="a" * 64,
            )
            with self.assertRaisesRegex(ui_capture.UiCaptureError, "preflight summary"):
                ui_capture.cmd_capture(args)
            self.assertFalse((bundle / "private" / "screenshots").exists())
            self.assertFalse((bundle / "private" / "capture").exists())
        finally:
            remove_owned_bundle(bundle)

    def test_capture_refuses_unreviewed_summary_digest(self) -> None:
        bundle = external_temp_dir()
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle)]), 0)
            manifest, state_hash = ui_capture.load_frozen_state_manifest(bundle)
            _manifest, summary = self._fixture()
            summary["stateManifestSha256"] = state_hash
            summary_path = bundle / "private" / "preflight" / "summary.json"
            summary_path.parent.mkdir(parents=True)
            summary_path.write_text(json.dumps(summary), encoding="utf-8")
            args = SimpleNamespace(
                bundle=str(bundle),
                approved_manifest_sha256=state_hash,
                approved_preflight_summary_sha256="0" * 64,
            )
            with self.assertRaisesRegex(ui_capture.UiCaptureError, "hash mismatch"):
                ui_capture.cmd_capture(args)
            self.assertFalse((bundle / "private" / "screenshots").exists())
        finally:
            remove_owned_bundle(bundle)

    def test_visible_inventory_signature_binds_frame_and_target_geometry(self) -> None:
        manifest, summary = self._fixture()
        receipt = summary["cases"][0]
        before = receipt["preInventory"]
        changed = json.loads(json.dumps(before))
        changed["nodes"][0]["extents"]["width"] += 1
        changed["frameCandidates"][0]["extents"]["width"] += 1
        changed["appFrameExtents"]["width"] += 1
        self.assertNotEqual(
            ui_capture._visible_inventory_signature(before),
            ui_capture._visible_inventory_signature(changed),
        )
        positive = next(case for case in summary["cases"] if case["preOracle"]["matchCount"] == 1)
        target_changed = json.loads(json.dumps(positive["preInventory"]))
        target_node = next(
            node for node in target_changed["nodes"] if node["role"] != "frame"
        )
        target_node["extents"]["x"] += 1
        self.assertNotEqual(
            ui_capture._visible_inventory_signature(positive["preInventory"]),
            ui_capture._visible_inventory_signature(target_changed),
        )
        self.assertEqual(len(manifest["rows"]), 10)

    def test_loader_rejects_duplicate_summary_keys(self) -> None:
        bundle = external_temp_dir()
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle)]), 0)
            manifest, state_hash = ui_capture.load_frozen_state_manifest(bundle)
            summary_path = bundle / "private" / "preflight" / "summary.json"
            summary_path.parent.mkdir(parents=True)
            summary_path.write_text('{"status":"complete","status":"failed"}', encoding="utf-8")
            with self.assertRaisesRegex(ui_capture.UiCaptureError, "duplicate JSON"):
                ui_capture.load_validated_preflight_summary(
                    bundle, manifest, state_manifest_sha256=state_hash
                )
        finally:
            remove_owned_bundle(bundle)


class PrivateUiProfileTests(unittest.TestCase):
    def test_profiles_are_fresh_and_environment_excludes_host_secrets_and_sessions(self) -> None:
        bundle = external_temp_dir()
        bundle.mkdir(parents=True)
        case_id = "00000000-0000-4000-8000-000000000099"
        try:
            preflight = ui_capture.create_private_ui_profile(bundle, "preflight", "worker", case_id)
            capture = ui_capture.create_private_ui_profile(bundle, "capture", "worker", case_id)
            env = ui_capture.build_ui_process_environment(preflight)
            self.assertNotEqual(preflight["home"], capture["home"])
            self.assertEqual(Path(env["HOME"]), preflight["home"])
            self.assertEqual(env["PATH"], "/usr/bin:/bin")
            self.assertNotIn("DBUS_SESSION_BUS_ADDRESS", env)
            self.assertNotIn("DISPLAY", env)
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("CURSOR_API_KEY", env)
            self.assertEqual(preflight["home"].stat().st_mode & 0o777, 0o700)
        finally:
            remove_owned_bundle(bundle)


class PrivateNeutralPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pictures_base = external_pictures_base()
        ui_capture.set_outside_root_pictures_base_for_tests(self.pictures_base)

    def tearDown(self) -> None:
        ui_capture.set_outside_root_pictures_base_for_tests(None)
        remove_owned_temp_root(self.pictures_base, "zorya-ui-pictures-")

    def test_thunar_launch_and_ctrl_l_use_neutral_tmpfs_paths_only(self) -> None:
        bundle = external_temp_dir()
        neutral_root = bundle.parent / "neutral"
        neutral_root.mkdir(mode=0o700)
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle)]), 0)
            manifest, _digest = ui_capture.load_frozen_state_manifest(bundle)
            row = next(row for row in manifest["rows"] if row["slotKey"] == "thunar-p1")
            with patch.object(ui_capture, "_is_private_tmpfs_mount", return_value=True):
                launch_path = ui_capture.copy_neutral_case_input(bundle, row, neutral_root)
            self.assertEqual(launch_path.relative_to(neutral_root).as_posix(), "roots/archive")
            forbidden = (str(bundle), row["caseId"], row["sourceStateId"])

            popen_args: list[list[str]] = []

            def fake_popen(command: list[str]) -> object:
                popen_args.append(command)
                return object()

            with patch.object(ui_capture.subprocess, "Popen", fake_popen):
                ui_capture._launch_app_for_row(row, launch_path)
            self.assertEqual(len(popen_args), 1)
            self.assertTrue(str(launch_path) in popen_args[0])
            self.assertTrue(all(value not in " ".join(popen_args[0]) for value in forbidden))

            xdotool_calls: list[list[str]] = []
            with patch.object(ui_capture, "_xdotool", side_effect=xdotool_calls.append):
                with patch.object(ui_capture.time, "sleep"):
                    ui_capture._drive_thunar(row, launch_path, neutral_root)
            typed_paths = [call[1] for call in xdotool_calls if call[:1] == ["type"]]
            self.assertEqual(len(typed_paths), 1)
            self.assertEqual(
                Path(typed_paths[0]).relative_to(neutral_root / "roots").as_posix(),
                "archive/work",
            )
            self.assertTrue(all(value not in " ".join(typed_paths) for value in forbidden))
        finally:
            if neutral_root.exists():
                shutil.rmtree(neutral_root)
            remove_owned_bundle(bundle)

    def test_owned_session_script_mounts_only_private_neutral_subdirectory(self) -> None:
        neutral_root = Path("/tmp/zui-12345678/n")
        script = ui_capture.build_owned_session_wrapper_script(
            display_file=Path("/tmp/zui-12345678/display"),
            worker_argv=[sys.executable, "worker.py"],
            neutral_root=neutral_root,
        )
        self.assertIn("mount --make-rprivate /", script)
        self.assertIn("mount -t tmpfs -o size=32m,mode=700,nosuid,nodev tmpfs '/tmp/zui-12345678/n'", script)
        self.assertNotIn("mount -t tmpfs /tmp ", script)
        parsed = subprocess.run(["sh", "-n"], input=script, text=True, capture_output=True)
        self.assertEqual(parsed.returncode, 0, parsed.stderr)


class CapturePipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pictures_base = external_pictures_base()
        ui_capture.set_outside_root_pictures_base_for_tests(self.pictures_base)

    def tearDown(self) -> None:
        ui_capture.set_outside_root_pictures_base_for_tests(None)
        remove_owned_temp_root(self.pictures_base, "zorya-ui-pictures-")

    def _prepare_bundle_with_preflight(self, bundle: Path) -> tuple[dict[str, object], str, str]:
        self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle)]), 0)
        manifest, state_hash = ui_capture.load_frozen_state_manifest(bundle)
        frame = {"x": 100, "y": 80, "width": 640, "height": 480}
        cases: list[dict[str, object]] = []
        for row in manifest["rows"]:
            nodes: list[dict[str, object]] = [
                {
                    "role": "frame",
                    "name": "fixture window",
                    "showing": True,
                    "visible": True,
                    "extents": frame,
                    "applicationIndex": 0,
                }
            ]
            if row["expectedPresence"] == "present":
                nodes.append(
                    {
                        "role": row["targetRole"],
                        "name": row["targetName"],
                        "showing": True,
                        "visible": True,
                        "extents": {"x": 120, "y": 100, "width": 40, "height": 24},
                        "applicationIndex": 0,
                    }
                )
            expected_app = "thunar" if row["sourceGroup"] == "thunar" else "eog"
            inventory = {
                "complete": True,
                "traversalErrors": [],
                "applicationNames": [expected_app],
                "expectedApplicationName": expected_app,
                "applicationMatchCount": 1,
                "frameCandidates": [{"applicationIndex": 0, "name": "fixture window", "extents": frame}],
                "nodes": nodes,
                "appFrameExtents": frame,
                "viewport": {"width": 1280, "height": 1024},
            }
            oracle = ui_capture.evaluate_case_oracle(
                inventory=inventory,
                expected_presence=row["expectedPresence"],
                target_role=row["targetRole"],
                target_name=row["targetName"],
            )
            cases.append(
                {
                    "schemaVersion": ui_capture.PREFLIGHT_RECEIPT_SCHEMA,
                    "caseId": row["caseId"],
                    "sourceStateId": row["sourceStateId"],
                    "preInventory": inventory,
                    "postInventory": inventory,
                    "preOracle": oracle,
                    "postOracle": oracle,
                    "screenshot": None,
                    "viewport": {"width": 1280, "height": 1024},
                }
            )
        summary = {
            "schemaVersion": ui_capture.PREFLIGHT_RECEIPT_SCHEMA,
            "status": "complete",
            "stateManifestSha256": state_hash,
            "caseCount": len(cases),
            "caseIds": [row["caseId"] for row in manifest["rows"]],
            "resourceReceipts": {},
            "cases": cases,
            "viewport": {"width": 1280, "height": 1024},
        }
        ui_capture.validate_preflight_summary_document(
            summary, manifest, state_manifest_sha256=state_hash
        )
        summary_path = bundle / "private" / "preflight" / "summary.json"
        summary_path.parent.mkdir(parents=True)
        summary_bytes = json.dumps(summary, ensure_ascii=False, separators=(",", ":")).encode()
        summary_path.write_bytes(summary_bytes)
        return manifest, state_hash, ui_capture.sha256_bytes(summary_bytes)

    def _png(self, *, corrupt: bool = False) -> bytes:
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (1280, 1024), (23, 41, 59)).save(buffer, format="PNG")
        payload = buffer.getvalue()
        if corrupt:
            return payload[:-8]
        return payload

    def _run_capture_with_stub(self, bundle: Path, state_hash: str, summary_hash: str, png: bytes) -> int:
        class StubRunner:
            def __init__(self, command: list[str], *, env: dict[str, str], cwd: Path) -> None:
                self.command = command
                self.cwd = cwd
                self.stdout = b""
                self.stderr = b""
                self.stdout_total_bytes = 0
                self.stderr_total_bytes = 0

            def start(self) -> None:
                return None

            def wait(self, timeout: float) -> int:
                case_id = self.command[self.command.index("--case-id") + 1]
                case_row = next(
                    row for row in manifest["rows"] if row["caseId"] == case_id
                )
                relative = (Path("private") / "screenshots" / f"{case_id}.png").as_posix()
                screenshot_path = bundle / relative
                screenshot_path.write_bytes(png)
                receipt = {
                    "preflightSummarySha256": summary_hash,
                    "screenshotRelative": relative,
                    "screenshot": {
                        "sha256": ui_capture.sha256_bytes(png),
                        "width": 1280,
                        "height": 1024,
                    },
                }
                receipt_path = bundle / "private" / "capture" / "cases" / f"{case_id}.json"
                receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
                return 0

        manifest, loaded_state_hash = ui_capture.load_frozen_state_manifest(bundle)
        self.assertEqual(state_hash, loaded_state_hash)
        args = SimpleNamespace(
            bundle=str(bundle),
            approved_manifest_sha256=state_hash,
            approved_preflight_summary_sha256=summary_hash,
        )
        with patch.object(ui_capture, "ProcessGroupRunner", StubRunner):
            return ui_capture.cmd_capture(args)

    def test_capture_pipeline_reads_png_validates_dimensions_and_writes_producer_manifest(self) -> None:
        bundle = external_temp_dir()
        try:
            manifest, state_hash, summary_hash = self._prepare_bundle_with_preflight(bundle)
            code = self._run_capture_with_stub(bundle, state_hash, summary_hash, self._png())
            self.assertEqual(code, 0)
            producer = json.loads((bundle / "producer-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(len(producer["rows"]), 10)
            self.assertEqual(len(manifest["rows"]), 10)
            for row in producer["rows"]:
                self.assertEqual(row["image"]["width"], 1280)
                self.assertEqual(row["image"]["height"], 1024)
                self.assertNotIn("expectedPresence", row)
                self.assertNotIn("sourceStateId", row)
        finally:
            remove_owned_bundle(bundle)

    def test_capture_pipeline_rejects_corrupt_png_and_preserves_failure_bytes(self) -> None:
        bundle = external_temp_dir()
        try:
            _manifest, state_hash, summary_hash = self._prepare_bundle_with_preflight(bundle)
            with self.assertRaisesRegex(ui_capture.UiCaptureError, "PNG"):
                self._run_capture_with_stub(bundle, state_hash, summary_hash, self._png(corrupt=True))
            case_ids = json.loads(
                (bundle / "private" / "state-manifest.json").read_text(encoding="utf-8")
            )["rows"]
            first_case_id = case_ids[0]["caseId"]
            screenshot = bundle / "private" / "screenshots" / f"{first_case_id}.png"
            self.assertTrue(screenshot.is_file())
            self.assertFalse((bundle / "producer-manifest.json").exists())
        finally:
            remove_owned_bundle(bundle)


class CaptureFailureEvidenceTests(unittest.TestCase):
    def test_changed_inventory_failure_receipt_is_bounded_and_not_overwritten(self) -> None:
        bundle = external_temp_dir()
        bundle.mkdir(parents=True)
        before = {
            "complete": True,
            "applicationNames": ["eog"],
            "nodes": [{"role": "frame", "name": "Image Viewer", "showing": True, "visible": True}],
        }
        after = json.loads(json.dumps(before))
        after["nodes"][0]["name"] = "Changed frame"
        try:
            receipt_path = ui_capture._write_capture_inventory_failure(
                bundle,
                "00000000-0000-4000-8000-000000000099",
                reason="visible AT-SPI inventory changed across screenshot capture",
                before=before,
                after=after,
                screenshot={"sha256": "a" * 64, "width": 1280, "height": 1024},
            )
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["before"], before)
            self.assertEqual(receipt["after"], after)
            self.assertEqual(receipt["screenshot"]["width"], 1280)
            with self.assertRaisesRegex(ui_capture.UiCaptureError, "already exists"):
                ui_capture._write_capture_inventory_failure(
                    bundle,
                    "00000000-0000-4000-8000-000000000099",
                    reason="second attempt",
                    before=before,
                    after=after,
                    screenshot=None,
                )
        finally:
            remove_owned_bundle(bundle)


class OutsideRootPicturesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pictures_base = external_pictures_base()
        ui_capture.set_outside_root_pictures_base_for_tests(self.pictures_base)

    def tearDown(self) -> None:
        ui_capture.set_outside_root_pictures_base_for_tests(None)
        remove_owned_temp_root(self.pictures_base, "zorya-ui-pictures-")

    def test_p3_runtime_paths_unique_per_bundle_and_outside_root(self) -> None:
        bundle_a = external_temp_dir()
        bundle_b = external_temp_dir()
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle_a)]), 0)
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle_b)]), 0)
            manifest_a = json.loads(
                (bundle_a / "private" / "state-manifest.json").read_text(encoding="utf-8")
            )
            row_a = next(row for row in manifest_a["rows"] if row["slotKey"] == "thunar-p3")
            row_b = next(
                row
                for row in json.loads(
                    (bundle_b / "private" / "state-manifest.json").read_text(encoding="utf-8")
                )["rows"]
                if row["slotKey"] == "thunar-p3"
            )
            path_a = ui_capture.resolve_case_launch_path(bundle_a, row_a)
            path_b = ui_capture.resolve_case_launch_path(bundle_b, row_b)
            self.assertNotEqual(path_a, path_b)
            self.assertFalse(str(path_a).startswith("/root"))
            self.assertFalse(str(path_b).startswith("/root"))
            self.assertTrue(str(path_a).startswith(str(self.pictures_base.resolve())))
            self.assertTrue(str(path_b).startswith(str(self.pictures_base.resolve())))
        finally:
            remove_owned_bundle(bundle_a)
            remove_owned_bundle(bundle_b)

    def test_p3_manifest_has_no_absolute_outside_paths(self) -> None:
        bundle = external_temp_dir()
        try:
            self.assertEqual(ui_capture.main(["prepare", "--output-dir", str(bundle)]), 0)
            raw = (bundle / "private" / "state-manifest.json").read_bytes().decode("utf-8")
            self.assertNotIn(str(self.pictures_base), raw)
            self.assertNotIn(str(bundle.resolve()), raw)
            row = next(
                row
                for row in json.loads(raw)["rows"]
                if row["slotKey"] == "thunar-p3"
            )
            self.assertEqual(row["authored"], {"launchOutsideRootPictures": True})
        finally:
            remove_owned_bundle(bundle)

    def test_p3_refuses_existing_pictures_tree(self) -> None:
        bundle = external_temp_dir()
        state_id = ui_capture.deterministic_uuid("state:thunar-p3")
        try:
            ui_capture.materialize_outside_root_pictures_tree(bundle, state_id)
            with self.assertRaises(ui_capture.UiCaptureError):
                ui_capture.materialize_outside_root_pictures_tree(bundle, state_id)
        finally:
            remove_owned_bundle(bundle)

    def test_p3_rejects_symlinked_base_before_resolving_it(self) -> None:
        bundle = external_temp_dir()
        linked_base = bundle.parent / "pictures-link"
        linked_base.symlink_to(self.pictures_base, target_is_directory=True)
        ui_capture.set_outside_root_pictures_base_for_tests(linked_base)
        try:
            with self.assertRaises(ui_capture.UiCaptureError):
                ui_capture.outside_root_pictures_runtime_path(
                    bundle, ui_capture.deterministic_uuid("state:thunar-p3")
                )
        finally:
            ui_capture.set_outside_root_pictures_base_for_tests(self.pictures_base)
            remove_owned_bundle(bundle)

    def test_cleanup_removes_only_exact_owned_temp_root(self) -> None:
        owned = external_pictures_base()
        sibling = Path(tempfile.mkdtemp(prefix="zorya-ui-pictures-sibling-", dir="/tmp"))
        marker = sibling / "keep.txt"
        marker.write_text("preserve", encoding="utf-8")
        try:
            remove_owned_temp_root(owned, "zorya-ui-pictures-")
            self.assertFalse(owned.exists())
            self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")
        finally:
            remove_owned_temp_root(sibling, "zorya-ui-pictures-sibling-")

    def test_cleanup_rejects_tmp_before_rmtree(self) -> None:
        with patch.object(shutil, "rmtree") as remove_tree:
            with self.assertRaises(AssertionError):
                remove_owned_temp_root(Path("/tmp"), "zorya-ui-")
        remove_tree.assert_not_called()


class DpkgQueryTests(unittest.TestCase):
    def tearDown(self) -> None:
        ui_capture.set_dpkg_query_runner_for_tests(None)

    def test_owner_version_two_step_lookup(self) -> None:
        target = Path("/usr/share/example/asset.bin")

        def runner(argv: list[str]) -> object:
            if argv[:2] == ["dpkg-query", "-S"]:
                return subprocess_result(0, f"example-pkg: {target}\n", "")
            if argv[:2] == ["dpkg-query", "-W"]:
                return subprocess_result(0, "1.2.3\n", "")
            raise AssertionError(f"unexpected argv: {argv}")

        ui_capture.set_dpkg_query_runner_for_tests(runner)
        package, version = ui_capture.dpkg_file_owner_version(target)
        self.assertEqual((package, version), ("example-pkg", "1.2.3"))

    def test_rejects_ambiguous_owners(self) -> None:
        target = Path("/usr/share/example/asset.bin")

        def runner(argv: list[str]) -> object:
            if argv[:2] == ["dpkg-query", "-S"]:
                return subprocess_result(
                    0,
                    f"pkg-a: {target}\npkg-b: {target}\n",
                    "",
                )
            raise AssertionError(f"unexpected argv: {argv}")

        ui_capture.set_dpkg_query_runner_for_tests(runner)
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.dpkg_file_owner_version(target)

    def test_rejects_malformed_search_output(self) -> None:
        ui_capture.set_dpkg_query_runner_for_tests(
            lambda argv: subprocess_result(0, "not-a-valid-line\n", "")
        )
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.dpkg_file_owner_version(Path("/usr/bin/example"))


class SessionWrapperTests(unittest.TestCase):
    def test_wrapper_cleanup_trap_and_owned_pids(self) -> None:
        display_file = Path("/tmp/ui-display-number")
        script = ui_capture.build_owned_session_wrapper_script(
            display_file=display_file,
            worker_argv=[sys.executable, "-c", "pass"],
        )
        self.assertIn("trap cleanup EXIT", script)
        self.assertIn("trap 'exit 130' INT", script)
        self.assertIn("trap 'exit 143' TERM", script)
        self.assertIn("trap 'exit 129' HUP", script)
        self.assertIn('for pid in "$WORKER_PID" "$OPENBOX_PID" "$XVFB_PID"; do', script)
        self.assertIn('kill "$pid" 2>/dev/null || true', script)
        self.assertIn('wait "$pid" 2>/dev/null || true', script)
        self.assertIn('if wait "$WORKER_PID"; then WORKER_STATUS=0; else WORKER_STATUS=$?; fi', script)
        self.assertIn("-displayfd 3", script)
        self.assertIn("-nolisten tcp", script)
        self.assertIn('exit "$WORKER_STATUS"', script)
        self.assertNotIn("kill -9", script)
        self.assertNotIn("pkill", script)
        parsed = subprocess.run(["sh", "-n"], input=script, text=True, capture_output=True)
        self.assertEqual(parsed.returncode, 0, parsed.stderr)

    def test_wrapper_runs_worker_with_dynamic_display_and_preserves_status(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zorya-ui-wrapper-test-") as temporary:
            root = Path(temporary)
            fakebin = root / "bin"
            fakebin.mkdir()
            pid_log = root / "owned-pids.txt"
            marker = root / "worker-marker.txt"
            (fakebin / "Xvfb").write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" >> \"$PID_LOG\"\nprintf '321\\n' >&3\nexec sleep 30\n",
                encoding="utf-8",
            )
            (fakebin / "openbox").write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" >> \"$PID_LOG\"\nexec sleep 30\n",
                encoding="utf-8",
            )
            (fakebin / "Xvfb").chmod(0o700)
            (fakebin / "openbox").chmod(0o700)
            script = ui_capture.build_owned_session_wrapper_script(
                display_file=root / "display-number",
                worker_argv=[
                    sys.executable,
                    "-c",
                    "import os,sys; open(sys.argv[1], 'w').write(os.environ['DISPLAY']); sys.exit(7)",
                    str(marker),
                ],
            )
            script_path = root / "session.sh"
            script_path.write_text(script, encoding="utf-8")
            env = os.environ.copy()
            env.update({"PATH": f"{fakebin}:{env['PATH']}", "PID_LOG": str(pid_log)})
            completed = subprocess.run(
                ["sh", str(script_path)], env=env, cwd=root, capture_output=True, timeout=5
            )
            self.assertEqual(completed.returncode, 7, completed.stderr.decode(errors="replace"))
            self.assertEqual(marker.read_text(encoding="utf-8"), ":321")
            pids = [int(value) for value in pid_log.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(pids), 2)
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    def test_wrapper_signal_during_xvfb_startup_closes_owned_server(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zorya-ui-wrapper-signal-") as temporary:
            root = Path(temporary)
            fakebin = root / "bin"
            fakebin.mkdir()
            pid_file = root / "xvfb.pid"
            fake_xvfb = fakebin / "Xvfb"
            fake_xvfb.write_text(
                "#!/bin/sh\nprintf '%s' \"$$\" > \"$PID_FILE\"\nexec sleep 30\n",
                encoding="utf-8",
            )
            fake_xvfb.chmod(0o700)
            script = ui_capture.build_owned_session_wrapper_script(
                display_file=root / "display-number",
                worker_argv=[sys.executable, "-c", "raise SystemExit(0)"],
            )
            script_path = root / "session.sh"
            script_path.write_text(script, encoding="utf-8")
            env = os.environ.copy()
            env.update({"PATH": f"{fakebin}:{env['PATH']}", "PID_FILE": str(pid_file)})
            process = subprocess.Popen(
                ["sh", str(script_path)], env=env, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            try:
                deadline = time.monotonic() + 3
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(pid_file.exists(), "fake Xvfb did not start")
                xvfb_pid = int(pid_file.read_text(encoding="utf-8"))
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=5)
                self.assertEqual(process.returncode, 143)
                with self.assertRaises(ProcessLookupError):
                    os.kill(xvfb_pid, 0)
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    process.communicate(timeout=5)

    def test_wrapper_rejects_xvfb_startup_failure_before_worker(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zorya-ui-wrapper-fail-") as temporary:
            root = Path(temporary)
            fakebin = root / "bin"
            fakebin.mkdir()
            worker_marker = root / "worker-ran"
            (fakebin / "Xvfb").write_text("#!/bin/sh\nexit 9\n", encoding="utf-8")
            (fakebin / "openbox").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            (fakebin / "Xvfb").chmod(0o700)
            (fakebin / "openbox").chmod(0o700)
            script = ui_capture.build_owned_session_wrapper_script(
                display_file=root / "display-number",
                worker_argv=[sys.executable, "-c", f"open({str(worker_marker)!r}, 'w').close()"],
            )
            script_path = root / "session.sh"
            script_path.write_text(script, encoding="utf-8")
            env = os.environ.copy()
            env["PATH"] = f"{fakebin}:{env['PATH']}"
            completed = subprocess.run(
                ["sh", str(script_path)], env=env, cwd=root, capture_output=True, timeout=5
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn(b"Xvfb exited before display startup", completed.stderr)
            self.assertFalse(worker_marker.exists())


class ProcessGroupRunnerTests(unittest.TestCase):
    def test_output_tail_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zorya-ui-runner-output-") as temporary:
            code = (
                "import sys; "
                f"sys.stdout.write('x' * {ui_capture.MAX_LOG_BYTES + 1024}); "
                f"sys.stderr.write('y' * {ui_capture.MAX_LOG_BYTES + 2048})"
            )
            runner = ui_capture.ProcessGroupRunner(
                [sys.executable, "-c", code], env=os.environ.copy(), cwd=Path(temporary)
            )
            runner.start()
            self.assertEqual(runner.wait(5), 0)
            self.assertEqual(len(runner.stdout), ui_capture.MAX_LOG_BYTES)
            self.assertEqual(runner.stdout[-16:], b"x" * 16)
            self.assertEqual(runner.stdout_total_bytes, ui_capture.MAX_LOG_BYTES + 1024)
            self.assertEqual(len(runner.stderr), ui_capture.MAX_LOG_BYTES)
            self.assertEqual(runner.stderr[-16:], b"y" * 16)
            self.assertEqual(runner.stderr_total_bytes, ui_capture.MAX_LOG_BYTES + 2048)
            assert runner.proc is not None
            assert runner.proc.stdout is not None and runner.proc.stderr is not None
            self.assertTrue(runner.proc.stdout.closed)
            self.assertTrue(runner.proc.stderr.closed)

    def test_failed_inner_case_persists_bounded_output_and_exit_code(self) -> None:
        bundle = external_temp_dir()
        bundle.mkdir(parents=True)
        case_id = "00000000-0000-4000-8000-000000000099"
        runtime_paths: list[Path] = []
        temp_paths: list[str] = []

        class FailedRunner:
            def __init__(self, command: list[str], *, env: dict[str, str], cwd: Path) -> None:
                runtime_paths.append(Path(env["XDG_RUNTIME_DIR"]))
                temp_paths.append(env["TMPDIR"])
                self.stdout = b"inner app startup output\n"
                self.stderr = b"inner app failed to initialize\n"
                self.stdout_total_bytes = len(self.stdout) + 100
                self.stderr_total_bytes = len(self.stderr) + 200

            def start(self) -> None:
                return None

            def wait(self, timeout: float) -> int:
                return 17

        try:
            with patch.object(ui_capture, "ProcessGroupRunner", FailedRunner):
                with self.assertRaisesRegex(ui_capture.UiCaptureError, "exit code 17"):
                    ui_capture._run_live_case(
                        bundle,
                        {},
                        {"caseId": case_id},
                        phase="preflight",
                        screenshot_path=None,
                    )
            receipt_path = bundle / "private" / "preflight" / "failures" / f"{case_id}-inner.json"
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["exitCode"], 17)
            self.assertEqual(receipt["stdout"], "inner app startup output\n")
            self.assertEqual(receipt["stderr"], "inner app failed to initialize\n")
            self.assertEqual(receipt["stdoutBytes"], len(receipt["stdout"].encode()) + 100)
            self.assertEqual(receipt["stderrBytes"], len(receipt["stderr"].encode()) + 200)
            self.assertTrue(receipt["stdoutTruncated"])
            self.assertTrue(receipt["stderrTruncated"])
            self.assertEqual(len(runtime_paths), 1)
            self.assertEqual(runtime_paths[0].parent, Path("/tmp"))
            self.assertLessEqual(len(os.fsencode(str(runtime_paths[0]))), ui_capture.MAX_RUNTIME_DIR_PATH_BYTES)
            self.assertEqual(temp_paths, [str(runtime_paths[0])])
            self.assertFalse(runtime_paths[0].exists())

            class OuterRunner:
                stdout = b"outer stdout"
                stderr = b"outer stderr"
                stdout_total_bytes = len(stdout)
                stderr_total_bytes = len(stderr)

            ui_capture._write_preflight_failure(
                bundle,
                case_id,
                "worker exit 17",
                OuterRunner(),
            )
            outer_receipt = json.loads(
                (bundle / "private" / "preflight" / "failures" / f"{case_id}.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(outer_receipt["innerFailureReceipt"], f"{case_id}-inner.json")
        finally:
            remove_owned_bundle(bundle)


class ShortRuntimeDirectoryTests(unittest.TestCase):
    def test_short_runtime_path_mode_and_exact_owned_cleanup(self) -> None:
        path, ownership_marker = ui_capture.create_short_runtime_directory()
        sibling = path.with_name(path.name + "-sibling")
        sibling.write_text("keep", encoding="ascii")
        try:
            self.assertEqual(path.parent, Path("/tmp"))
            self.assertLessEqual(len(os.fsencode(str(path))), ui_capture.MAX_RUNTIME_DIR_PATH_BYTES)
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            self.assertEqual(path.stat().st_uid, os.getuid())
            ui_capture.remove_short_runtime_directory(path, ownership_marker)
            self.assertFalse(path.exists())
            self.assertEqual(sibling.read_text(encoding="ascii"), "keep")
        finally:
            if path.exists():
                ui_capture.remove_short_runtime_directory(path, ownership_marker)
            sibling.unlink(missing_ok=True)

    def test_rejects_broad_parent_before_removal(self) -> None:
        with patch.object(ui_capture.shutil, "rmtree") as remove_tree:
            with self.assertRaises(ui_capture.UiCaptureError):
                ui_capture.remove_short_runtime_directory(Path("/tmp"), "0" * 32)
            remove_tree.assert_not_called()

    def test_reader_closes_after_parent_exits_with_inherited_pipe_child(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zorya-ui-runner-inherit-") as temporary:
            code = (
                "import os,sys,time; pid=os.fork(); "
                "(time.sleep(30), os._exit(0)) if pid == 0 else os.write(1, b'parent-finished\\n')"
            )
            runner = ui_capture.ProcessGroupRunner(
                [sys.executable, "-c", code], env=os.environ.copy(), cwd=Path(temporary)
            )
            runner.start()
            with self.assertRaisesRegex(ui_capture.UiCaptureError, "kept output streams open"):
                runner.wait(5)
            self.assertIn(b"parent-finished", runner.stdout)
            self.assertTrue(all(not thread.is_alive() for thread in runner._threads))
            assert runner.proc is not None
            self.assertIsNotNone(runner.proc.poll())

    def test_timeout_terminates_and_reaps_owned_process(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zorya-ui-runner-timeout-") as temporary:
            code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
            runner = ui_capture.ProcessGroupRunner(
                [sys.executable, "-c", code], env=os.environ.copy(), cwd=Path(temporary)
            )
            runner.start()
            with self.assertRaisesRegex(ui_capture.UiCaptureError, "time limit"):
                runner.wait(0.05)
            assert runner.proc is not None
            self.assertIsNotNone(runner.proc.poll())
            self.assertTrue(all(not thread.is_alive() for thread in runner._threads))
            assert runner.proc.stdout is not None and runner.proc.stderr is not None
            self.assertTrue(runner.proc.stdout.closed)
            self.assertTrue(runner.proc.stderr.closed)

    def test_isolated_worker_command_adds_network_and_pid_containment(self) -> None:
        command = ui_capture.isolated_ui_worker_command(["python3", "worker.py"])
        self.assertEqual(
            command[:10],
            [
                "unshare",
                "--user",
                "--map-root-user",
                "--net",
                "--pid",
                "--fork",
                "--kill-child",
                "--mount-proc",
                "--",
                "python3",
            ],
        )
        self.assertEqual(command[10:], ["worker.py"])


class CopyrightStanzaTests(unittest.TestCase):
    FIXTURE = """Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/

Files: *
Copyright: 2020 Example Authors
License: GPL-3+

Files: usr/share/icons/Adwaita/symbolic/actions/go-previous-symbolic.svg
Copyright: 2021 Icon Authors
License: LGPL-2.1+

Files: usr/bin/thunar
Copyright: 2022 Thunar Authors
License: GPL-2+
"""

    def test_matches_exact_file_stanza(self) -> None:
        path = Path("/usr/share/icons/Adwaita/symbolic/actions/go-previous-symbolic.svg")
        license_value = ui_capture.license_for_debian_copyright_file(self.FIXTURE, path)
        self.assertEqual(license_value, "LGPL-2.1+")

    def test_source_to_installed_mapping_records_matching_package_pattern(self) -> None:
        entry = ui_capture.debian_copyright_entry_for_file(
            self.FIXTURE, Path("src/symbolic/actions/go-previous-symbolic.svg")
        )
        self.assertEqual(entry, {"filesPattern": "*", "license": "GPL-3+"})

    def test_rejects_missing_stanza(self) -> None:
        fixture = (
            "Files: usr/share/icons/Adwaita/symbolic/actions/go-previous-symbolic.svg\n"
            "License: LGPL-2.1+\n"
        )
        path = Path("/usr/share/icons/Adwaita/symbolic/actions/missing-symbolic.svg")
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.license_for_debian_copyright_file(fixture, path)

    def test_rejects_ambiguous_stanzas(self) -> None:
        ambiguous = self.FIXTURE + (
            "\nFiles: usr/share/icons/Adwaita/symbolic/actions/go-previous-symbolic.svg\n"
            "Copyright: 2023 Other Authors\n"
            "License: Apache-2.0\n"
        )
        path = Path("/usr/share/icons/Adwaita/symbolic/actions/go-previous-symbolic.svg")
        with self.assertRaises(ui_capture.UiCaptureError):
            ui_capture.license_for_debian_copyright_file(ambiguous, path)


def subprocess_result(returncode: int, stdout: str, stderr: str) -> object:
    class Result:
        pass

    result = Result()
    result.returncode = returncode
    result.stdout = stdout
    result.stderr = stderr
    return result


def argparse_namespace(**kwargs: object) -> object:
    class Namespace:
        pass

    ns = Namespace()
    for key, value in kwargs.items():
        setattr(ns, key, value)
    return ns


if __name__ == "__main__":
    unittest.main()
