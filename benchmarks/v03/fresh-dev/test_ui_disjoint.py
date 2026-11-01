from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("fresh_dev_ui_disjoint", ROOT / "ui_disjoint.py")
assert spec and spec.loader
ui_disjoint = importlib.util.module_from_spec(spec)
sys.modules["fresh_dev_ui_disjoint"] = ui_disjoint
spec.loader.exec_module(ui_disjoint)


def sample_inventory(nodes: list[dict[str, object]], *, complete: bool = True) -> dict[str, object]:
    frame = {"x": 100, "y": 80, "width": 640, "height": 480}
    return {
        "complete": complete,
        "traversalErrors": [] if complete else ["child enumeration failed"],
        "expectedApplicationName": "gnumeric",
        "applicationMatchCount": 1,
        "nodes": nodes,
        "appFrameExtents": frame,
        "visibleAuxiliaryWindowExtents": [{"x": 250, "y": 180, "width": 360, "height": 260}],
        "viewport": {"x": 0, "y": 0, "width": 1280, "height": 1024},
    }


class RosterTests(unittest.TestCase):
    def manifest(self) -> dict[str, object]:
        rows = []
        for index, case in enumerate(ui_disjoint.CASES):
            rows.append({
                "caseId": f"case-{index}",
                "sourceStateId": f"state-{index}",
                "sourceGroup": case["app"],
                "expectedPresence": case["presence"],
                "target": {"role": case["role"], "name": case["name"], "query": case["query"]},
                "authored": {"sourceSha256": f"{index:064x}"},
            })
        return {"rows": rows}

    def test_fixed_quota_and_unique_identity_roster(self) -> None:
        manifest = self.manifest()
        ui_disjoint.validate_roster(manifest)
        rows = manifest["rows"]
        self.assertEqual(len({row["caseId"] for row in rows}), 10)
        self.assertEqual(len({row["sourceStateId"] for row in rows}), 10)

    def test_roster_rejects_case_or_state_reuse(self) -> None:
        manifest = self.manifest()
        manifest["rows"][1]["caseId"] = manifest["rows"][0]["caseId"]
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.validate_roster(manifest)
        manifest = self.manifest()
        manifest["rows"][1]["sourceStateId"] = manifest["rows"][0]["sourceStateId"]
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.validate_roster(manifest)

    def test_roster_rejects_quota_drift_and_missing_target_contract(self) -> None:
        manifest = self.manifest()
        manifest["rows"][0]["expectedPresence"] = "absent"
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.validate_roster(manifest)
        manifest = self.manifest()
        manifest["rows"][0]["target"].pop("query")
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.validate_roster(manifest)


class OracleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.row = {"expectedPresence": "present", "target": {"role": "push button", "name": "Cancel"}}
        self.target = {"applicationIndex": 0, "depth": 5, "role": "push button", "name": "Cancel", "showing": True, "visible": True, "extents": {"x": 400, "y": 300, "width": 60, "height": 24}}

    def test_positive_target_must_be_unique_and_inside_visible_app_or_dialog(self) -> None:
        inventory = sample_inventory([copy.deepcopy(self.target)])
        proof = ui_disjoint.evaluate_oracle(inventory, self.row)
        self.assertEqual(proof["matchCount"], 1)
        inventory = sample_inventory([copy.deepcopy(self.target), copy.deepcopy(self.target)])
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.evaluate_oracle(inventory, self.row)
        outside = copy.deepcopy(self.target)
        outside["extents"] = {"x": 900, "y": 900, "width": 60, "height": 24}
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.evaluate_oracle(sample_inventory([outside]), self.row)

    def test_negative_requires_complete_inventory_and_no_visible_matches(self) -> None:
        row = {"expectedPresence": "absent", "target": self.row["target"]}
        self.assertEqual(ui_disjoint.evaluate_oracle(sample_inventory([]), row)["matchCount"], 0)
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.evaluate_oracle(sample_inventory([], complete=False), row)
        hidden = copy.deepcopy(self.target)
        hidden["showing"] = False
        self.assertEqual(ui_disjoint.evaluate_oracle(sample_inventory([hidden]), row)["matchCount"], 0)

    def test_negative_rejects_any_positive_area_partial_viewport_intersection(self) -> None:
        row = {"expectedPresence": "absent", "target": self.row["target"]}
        frame = {"x": 0, "y": 0, "width": 1280, "height": 1024}
        node = copy.deepcopy(self.target)
        node["extents"] = {"x": 1197, "y": -1, "width": 36, "height": 46}
        inventory = sample_inventory([node])
        inventory["appFrameExtents"] = frame
        inventory["visibleAuxiliaryWindowExtents"] = []
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.evaluate_oracle(inventory, row)

    def test_positive_rejects_partial_match_even_when_another_match_is_fully_inside(self) -> None:
        frame = {"x": 0, "y": 0, "width": 1280, "height": 1024}
        partial = copy.deepcopy(self.target)
        partial["extents"] = {"x": 1197, "y": -1, "width": 36, "height": 46}
        inventory = sample_inventory([copy.deepcopy(self.target), partial])
        inventory["appFrameExtents"] = frame
        inventory["visibleAuxiliaryWindowExtents"] = []
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.evaluate_oracle(inventory, self.row)

    def test_positive_does_not_treat_incomplete_tree_as_a_match(self) -> None:
        with self.assertRaises(ui_disjoint.UiDisjointError):
            ui_disjoint.evaluate_oracle(sample_inventory([self.target], complete=False), self.row)


class AuthoredStateTests(unittest.TestCase):
    def test_large_spreadsheets_and_document_layouts_are_registered_separately(self) -> None:
        csv_states = ui_disjoint._csv_rows()
        self.assertEqual(len(csv_states), 5)
        self.assertGreaterEqual(len({(len(rows), len(rows[0])) for rows in csv_states}), 5)
        sizes = (((612, 792),), ((792, 612), (792, 612)), ((540, 720),) * 3, ((720, 540),) * 4, ((600, 600),) * 5)
        pdfs = [ui_disjoint.make_pdf(pages, index) for index, pages in enumerate(sizes, start=1)]
        self.assertEqual(len(set(pdfs)), 5)
        for pdf, pages in zip(pdfs, sizes):
            self.assertTrue(pdf.startswith(b"%PDF-1.4\n"))
            self.assertTrue(pdf.endswith(b"%%EOF\n"))
            self.assertIn(f"/Count {len(pages)}".encode(), pdf)


class CanonicalExportTests(unittest.TestCase):
    def test_external_roots_are_explicit_and_configurable_in_temporary_paths(self) -> None:
        self.assertEqual(ui_disjoint.REPO_ROOT, Path(__file__).resolve().parents[3])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / "ui"
            artifact.mkdir()
            old_frames = root / "prior.json"
            old_frames.write_text(json.dumps({"cutoffInclusive": 4, "frames": []}), encoding="utf-8")
            ui_disjoint.configure_roots(artifact, root, old_frames)
            self.assertEqual(ui_disjoint.ARTIFACT_ROOT, artifact.resolve())
            self.assertEqual(ui_disjoint.PACKAGE_ROOT, artifact.resolve() / "extracted")
            self.assertEqual(ui_disjoint.OLD_FRAMES, old_frames.resolve())
            self.assertTrue(ui_disjoint._is_within(artifact, root))
            with self.assertRaises(ui_disjoint.UiDisjointError):
                ui_disjoint.configure_roots(artifact, root / "not-parent", old_frames)
            outside = Path(tmp).parent / f"{Path(tmp).name}-outside.json"
            outside.write_text("{}", encoding="utf-8")
            link = root / "linked-prior.json"
            link.symlink_to(outside)
            with self.assertRaises(ui_disjoint.UiDisjointError):
                ui_disjoint.configure_roots(artifact, root, link)
            outside.unlink()

    def _external_fixture(self, root: Path) -> tuple[Path, Path]:
        artifacts = root / "artifacts"
        study = artifacts / "ui-study"
        study.mkdir(parents=True)
        (study / "runtime-schemas").mkdir()
        (study / "package-license-lock.json").write_text("{}", encoding="utf-8")
        package_bin = study / "extracted/usr/bin"
        package_bin.mkdir(parents=True)
        for name in ("gnumeric", "evince", "ssconvert"):
            (package_bin / name).write_text("test executable placeholder", encoding="utf-8")
        prior = artifacts / "old-frames.json"
        prior.write_text(json.dumps({"cutoffInclusive": 4, "frames": [{"id": "prior", "perceptualHash": "aaaaaaaaaaaaaaaa"}]}), encoding="utf-8")
        ui_disjoint.configure_roots(study, artifacts, prior)
        bundle = study / "bundle"
        private = bundle / "private"
        private.mkdir(parents=True)
        source_root = private / "source"
        source_root.mkdir()
        manifest_rows = []
        summary_rows = []
        for index, case in enumerate(ui_disjoint.CASES):
            case_id = str(ui_disjoint.uuid.uuid5(ui_disjoint.NAMESPACE, f"{ui_disjoint.SEED}:{case['slot']}:case"))
            state_id = str(ui_disjoint.uuid.uuid5(ui_disjoint.NAMESPACE, f"{ui_disjoint.SEED}:{case['slot']}:state"))
            source_path = source_root / case["source"]
            source_bytes = f"authored-input-{index}".encode()
            source_path.write_bytes(source_bytes)
            manifest_rows.append({"caseId": case_id, "sourceStateId": state_id, "sourceGroup": case["app"], "expectedPresence": case["presence"], "target": {"role": case["role"], "name": case["name"], "query": case["query"]}, "authored": {"relativePath": f"source/{case['source']}", "sourceSha256": ui_disjoint.sha256(source_bytes)}})
            extents = {"x": 100 + index * 2, "y": 200, "width": 30, "height": 20}
            matches = [{"extents": extents}] if case["presence"] == "present" else []
            oracle = {"inventorySha256": f"{index + 1:064x}", "matchCount": len(matches), "matches": matches}
            summary_rows.append({"caseId": case_id, "status": "preflight", "screenshotsCaptured": False, "providerCalls": 0, "oracle": oracle})
        manifest = {"rows": manifest_rows}
        manifest_bytes = (json.dumps(manifest, separators=(",", ":")) + "\n").encode()
        manifest_path = private / "state-manifest.json"
        manifest_path.write_bytes(manifest_bytes)
        summary = {"manifestSha256": ui_disjoint.sha256(manifest_bytes), "rows": summary_rows}
        (private / "preflight-summary.json").write_text(json.dumps(summary), encoding="utf-8")
        return bundle, study

    def test_capture_interface_emits_only_canonical_unreviewed_source_draft(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, study = self._external_fixture(root)
            manifest_bytes = (bundle / "private/state-manifest.json").read_bytes()
            summary_bytes = (bundle / "private/preflight-summary.json").read_bytes()
            phashes = ["0000000000000000", "00000000000000ff", "000000000000ff00", "0000000000ff0000", "00000000ff000000", "000000ff00000000", "0000ff0000000000", "00ff000000000000", "ff00000000000000", "f00000000000000f"]
            rows = json.loads(manifest_bytes)["rows"]
            def fake_capture(_bundle: Path, row: dict[str, object], _phase: str, _digest: str | None) -> dict[str, object]:
                index = next(i for i, item in enumerate(rows) if item["caseId"] == row["caseId"])
                case = ui_disjoint.CASES[index]
                extents = {"x": 100 + index * 2, "y": 200, "width": 30, "height": 20}
                oracle = {"matches": [{"extents": extents}] if case["presence"] == "present" else []}
                return {"caseId": row["caseId"], "imageSha256": f"{index + 101:064x}", "rgbSha256": f"{index + 201:064x}", "perceptualHash": phashes[index], "imagePath": f"private/screenshots/{row['caseId']}.png", "oracle": oracle, "expectedPresence": case["presence"], "target": row["target"], "sourceGroup": case["app"]}
            export = study / "draft"
            args = SimpleNamespace(bundle=str(bundle), export_dir=str(export), approved_manifest_sha256=ui_disjoint.sha256(manifest_bytes), approved_preflight_summary_sha256=ui_disjoint.sha256(summary_bytes))
            with mock.patch.object(ui_disjoint, "_owned_session", side_effect=fake_capture):
                self.assertEqual(ui_disjoint.cmd_capture(args), 0)
            annotations = json.loads((export / "evaluator-private-annotations.json").read_bytes())
            required = ["opaqueCaseId", "stratum", "sourceGroup", "expectedPresence", "referenceBoxes", "referenceMasks", "exactOriginalCanvasMaskRef"]
            self.assertEqual(len(annotations), 10)
            self.assertTrue(all(list(item) == required and item["referenceMasks"] == [] and item["exactOriginalCanvasMaskRef"] is False for item in annotations))
            draft = json.loads((export / "source-draft.json").read_bytes())
            self.assertEqual(draft["schema"], "h8a-ui-source-draft-v1")
            self.assertEqual(draft["sourceReviewStatus"], "unreviewed-source-draft")
            self.assertFalse((export / "main-review-fragment.json").exists())
            self.assertTrue(all("accepted" not in row for row in draft["rows"]))
            self.assertEqual(draft["rows"][0]["annotationSha256"], ui_disjoint.ordered_json_sha256(annotations[0]))
            self.assertFalse(any("accepted" in row for row in annotations))

    def test_command_paths_reject_escape_and_existing_outputs_before_action(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, study = self._external_fixture(root)
            args = SimpleNamespace(bundle=str(bundle), export_dir=str(root / "escape"), approved_manifest_sha256="", approved_preflight_summary_sha256="")
            with mock.patch.object(ui_disjoint, "_owned_session") as owned_session:
                with self.assertRaises(ui_disjoint.UiDisjointError):
                    ui_disjoint.cmd_capture(args)
                owned_session.assert_not_called()
            existing = study / "already-there"
            existing.mkdir()
            export_args = SimpleNamespace(bundle=str(bundle), export_dir=str(existing), capture_ledger=str(root / "missing-ledger"), target_boundary_revision=None, approved_target_boundary_revision_sha256=None)
            with self.assertRaises(ui_disjoint.UiDisjointError):
                ui_disjoint.cmd_export_capture_ledger(export_args)
            self.assertEqual(list(existing.iterdir()), [])

    def test_capture_ledger_interface_emits_same_source_draft_schema_without_review_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, study = self._external_fixture(root)
            private = bundle / "private"
            manifest_path = private / "state-manifest.json"
            manifest_bytes = manifest_path.read_bytes()
            manifest = json.loads(manifest_bytes)
            summary_path = private / "preflight-summary.json"
            summary_bytes = summary_path.read_bytes()
            summary = json.loads(summary_bytes)
            summary_by_id = {row["caseId"]: row for row in summary["rows"]}
            phashes = ["0000000000000000", "00000000000000ff", "000000000000ff00", "0000000000ff0000", "00000000ff000000", "000000ff00000000", "0000ff0000000000", "00ff000000000000", "ff00000000000000", "f00000000000000f"]
            screenshot_dir = private / "screenshots"
            screenshot_dir.mkdir()
            ledger_rows = []
            for index, row in enumerate(manifest["rows"]):
                image_path = screenshot_dir / f"{row['caseId']}.png"
                image_path.write_bytes(f"synthetic-frame-{index}".encode())
                image_hash = ui_disjoint.hash_file(image_path)
                inventory_hash = summary_by_id[row["caseId"]]["oracle"]["inventorySha256"]
                ledger_rows.append({"caseId": row["caseId"], "imagePath": str(image_path), "imageSha256": image_hash, "rgbSha256": f"{index + 401:064x}", "perceptualHash": phashes[index], "dimensions": [ui_disjoint.WIDTH, ui_disjoint.HEIGHT], "preflightInventorySha256": inventory_hash, "captureInventorySha256": inventory_hash, "postCaptureInventorySha256": inventory_hash})
            recovered = manifest["rows"][6]["caseId"]
            failure = private / "runtime/capture" / recovered / "runner-failure.json"
            failure.parent.mkdir(parents=True)
            failure.write_text(json.dumps({"caseId": recovered, "stderrExcerpt": "capture AT-SPI inventory differs"}), encoding="utf-8")
            alias_capture = private / "runtime/capture-alias" / recovered / "profile-alias-capture-receipt.json"
            alias_capture.parent.mkdir(parents=True)
            alias_capture.write_text(json.dumps({"capture": {"imageSha256": ledger_rows[6]["imageSha256"]}}), encoding="utf-8")
            ledger_path = study / "complete-capture-ledger.json"
            ledger = {"schema": "h8a-ui-r17-complete-capture-ledger-v1", "manifestSha256": ui_disjoint.sha256(manifest_bytes), "preflightSha256": ui_disjoint.sha256(summary_bytes), "captureCount": 10, "caseCount": 10, "providerCalls": 0, "violations": [], "rows": ledger_rows}
            ledger_path.write_text(json.dumps(ledger), encoding="utf-8")
            alias_verification = study / "row7-profile-path-alias-verification-r17.json"
            alias_verification.write_text(json.dumps({"originalPreflightProfileImmutable": True}), encoding="utf-8")
            args = SimpleNamespace(
                bundle=str(bundle), export_dir=str(study / "from-ledger"), capture_ledger=str(ledger_path),
                target_boundary_revision=None, approved_target_boundary_revision_sha256=None,
                approved_manifest_sha256=ui_disjoint.sha256(manifest_bytes),
                approved_preflight_summary_sha256=ui_disjoint.sha256(summary_bytes),
                approved_capture_ledger_sha256=ui_disjoint.hash_file(ledger_path),
            )
            self.assertEqual(ui_disjoint.cmd_export_capture_ledger(args), 0)
            export = Path(args.export_dir)
            annotations = json.loads((export / "evaluator-private-annotations.json").read_bytes())
            capture_schema = ["opaqueCaseId", "stratum", "sourceGroup", "expectedPresence", "referenceBoxes", "referenceMasks", "exactOriginalCanvasMaskRef"]
            self.assertTrue(all(list(row) == capture_schema for row in annotations))
            draft = json.loads((export / "source-draft.json").read_bytes())
            self.assertEqual(draft["schema"], "h8a-ui-source-draft-v1")
            self.assertFalse((export / "main-review-fragment.json").exists())
            self.assertTrue(all("accepted" not in row for row in draft["rows"]))

    def test_output_symlink_escape_is_rejected_before_native_action(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, study = self._external_fixture(root)
            outside = root / "outside"
            outside.mkdir()
            link = study / "link-out"
            link.symlink_to(outside, target_is_directory=True)
            args = SimpleNamespace(bundle=str(bundle), export_dir=str(link / "draft"), approved_manifest_sha256="", approved_preflight_summary_sha256="")
            with mock.patch.object(ui_disjoint, "_owned_session") as owned_session:
                with self.assertRaises(ui_disjoint.UiDisjointError):
                    ui_disjoint.cmd_capture(args)
                owned_session.assert_not_called()
            self.assertEqual(list(outside.iterdir()), [])

    def test_annotation_has_exact_canonical_fields_and_insertion_order(self) -> None:
        row = {"caseId": "opaque-1", "sourceGroup": "gnumeric", "expectedPresence": "present"}
        annotation = ui_disjoint._canonical_annotation(row, {"left": 10, "top": 20, "width": 30, "height": 40})
        self.assertEqual(list(annotation), ["opaqueCaseId", "stratum", "sourceGroup", "expectedPresence", "referenceBoxes", "referenceMasks", "exactOriginalCanvasMaskRef"])
        self.assertEqual(annotation["referenceMasks"], [])
        self.assertIs(annotation["exactOriginalCanvasMaskRef"], False)
        self.assertNotIn("targetRole", annotation)
        self.assertNotIn("targetName", annotation)

    def test_target_revision_must_bind_to_exact_source_and_image(self) -> None:
        capture = {
            "caseId": "case-a", "sourceStateId": "state-a", "sourceSha256": "a" * 64, "imageSha256": "b" * 64,
            "expectedPresence": "present", "sourceGroup": "gnumeric", "target": {"role": "push button", "name": "Save", "query": "Save"},
            "oracle": {"matches": [{"extents": {"x": 238, "y": 161, "width": 37, "height": 35}}]},
        }
        revision = {
            "schema": "h8a-ui-target-boundary-revisions-v2", "sourceOnlyCorrection": True,
            "screenshotsCaptured": False, "providerCalls": 0,
            "rows": [{"caseId": "case-a", "sourceStateId": "state-a", "sourceSha256": "a" * 64, "imageSha256": "b" * 64,
                "target": capture["target"], "originalAtspiBounds": {"left": 238, "top": 161, "width": 37, "height": 35},
                "correctedXtestBounds": {"left": 238, "top": 161, "width": 36, "height": 34}, "evidence": {"probe": {"sha256": "c" * 64}}}],
        }
        raw = (ui_disjoint.json.dumps(revision, separators=(",", ":")) + "\n").encode()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "revision.json"
            path.write_bytes(raw)
            corrections, loaded = ui_disjoint._load_target_boundary_revision(path, ui_disjoint.sha256(raw), [capture])
            self.assertEqual(corrections["case-a"], revision["rows"][0]["correctedXtestBounds"])
            self.assertEqual(loaded["schema"], revision["schema"])
            capture["imageSha256"] = "d" * 64
            with self.assertRaises(ui_disjoint.UiDisjointError):
                ui_disjoint._load_target_boundary_revision(path, ui_disjoint.sha256(raw), [capture])


if __name__ == "__main__":
    unittest.main()
