from __future__ import annotations

import gzip
import hashlib
import json
import os
import subprocess
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import lincity_oracle as oracle


def save_fixture(construction_lines: list[str]) -> bytes:
    rows = "\n".join(construction_lines)
    count = len(construction_lines)
    text = f"""<?xml version="1.0" encoding="ISO-8859-15"?>
<SaveGame>
<loadsave_version>1328</loadsave_version>
<world_side_len>100</world_side_len>
<main_screen_originx>26</main_screen_originx>
<main_screen_originy>45</main_screen_originy>
<constructions>{count}</constructions>
<ConstructionSection>
{rows}
</ConstructionSection>
</SaveGame>
"""
    return gzip.compress(text.encode("iso-8859-15"), mtime=0)


class SaveMetadataTests(unittest.TestCase):
    def test_reads_tagged_construction_metadata_without_xml_tag_assumptions(self) -> None:
        metadata = oracle.parse_save(
            save_fixture(["<Farm>5\t32\t50\t187\t5\t0</Farm>", "<Water tower>41\t42\t54\t4000\t0</Water tower>"])
        )
        self.assertEqual(metadata["constructionCount"], 2)
        self.assertEqual(metadata["constructions"][0]["type"], "Farm")
        self.assertEqual(metadata["constructions"][0]["group"], 5)
        self.assertEqual(metadata["constructions"][0]["remainingFields"], ["187", "5", "0"])
        self.assertEqual(metadata["constructions"][1]["type"], "Water tower")
        self.assertEqual(metadata["cameraOrigin"], {"x": 26, "y": 45})

    def test_rejects_truncated_gzip_and_declared_construction_mismatch(self) -> None:
        valid = save_fixture(["<Farm>5\t32\t50\t187\t5\t0</Farm>"])
        with self.assertRaises(oracle.OracleError):
            oracle.parse_save(valid[:-3])
        mismatch = gzip.compress(
            valid and gzip.decompress(valid).replace(b"<constructions>1</constructions>", b"<constructions>2</constructions>"),
            mtime=0,
        )
        with self.assertRaisesRegex(oracle.OracleError, "count"):
            oracle.parse_save(mismatch)

    def test_camera_derived_digest_requires_its_frozen_input_path(self) -> None:
        with self.assertRaisesRegex(oracle.OracleError, "frozen diagnostic inputs"):
            oracle.verify_save_lineage(Path("/tmp/unrelated-save.scn.gz"), oracle.EXPECTED_CAMERA_SAVE_SHA256)

    def test_camera_derived_input_requires_closed_same_inventory_parent_receipt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="lincity-lineage-test-") as directory:
            root = Path(directory)
            save = root / "private-save.scn.gz"
            save.write_bytes(b"derived save bytes")
            digest = oracle.sha256_bytes(save.read_bytes())
            receipt = root / "receipt.json"
            receipt.write_text(
                __import__("json").dumps({
                    "schemaVersion": "lincity-draw-preflight-v1",
                    "status": "completed",
                    "ownedProcessGroupClosed": True,
                    "screenshots": 0,
                    "modelCalls": 0,
                    "inputSaveSha256": oracle.EXPECTED_CAMERA_SAVE_SHA256,
                    "inputSaveLineage": {"sha256": oracle.EXPECTED_CAMERA_SAVE_SHA256},
                    "postrunPrivateSaveSha256": digest,
                    "expectedCameraOrigin": {"x": 35, "y": 54},
                    "postrunCameraOrigin": {"x": 35, "y": 54},
                    "cameraOriginMatchesExpected": True,
                    "postrunConstructionInventoryMatchesInput": True,
                }),
                encoding="utf-8",
            )
            with patch.object(oracle, "ARTIFACT_ROOT", root):
                lineage = oracle.verify_save_lineage(save, digest, receipt)
                self.assertEqual(lineage["kind"], "independently-derived-camera-save")
                receipt.write_text(receipt.read_text(encoding="utf-8").replace('"ownedProcessGroupClosed": true', '"ownedProcessGroupClosed": false'), encoding="utf-8")
                with self.assertRaisesRegex(oracle.OracleError, "does not authorize"):
                    oracle.verify_save_lineage(save, digest, receipt)


class RenderAnalysisTests(unittest.TestCase):
    def _save_metadata(self) -> dict[str, object]:
        return {
            "worldSide": 100,
            "cameraOrigin": {"x": 26, "y": 45},
            "constructions": [{"type": "Farm", "group": 5, "x": 32, "y": 50}],
        }

    def _asset_roster(self) -> list[dict[str, object]]:
        return [
            {
                "frames": [
                    {
                        "filename": "farm7.png",
                        "rgbaSha256": "a" * 64,
                        "width": 512,
                        "height": 512,
                        "alphaBBoxHalfOpen": [0, 247, 512, 512],
                    }
                ]
            }
        ]

    def test_requires_exact_source_projection_and_pixel_fingerprint_match(self) -> None:
        candidates = oracle._farm_target_rects(self._save_metadata(), self._asset_roster())
        expected = next(row for row in candidates if row["candidateSizeFromDrawGeometry"] == 4)
        record = {
            "type": "render_copy",
            "seq": 41,
            "frame": 3,
            "rgbaSha256": "a" * 64,
            "dst": expected["expectedRect"],
            "renderer": "0x11",
            "targetSurface": "0x22",
            "clip": [0, 0, 1024, 768],
            "blend": 1,
        }
        analysis = oracle.analyze_trace(self._save_metadata(), self._asset_roster(), [record])
        self.assertEqual(analysis["status"], "matched-one-farm-draw")
        self.assertEqual(analysis["matchedTargetGeometryCount"], 1)
        self.assertEqual(analysis["matchedCallCount"], 1)
        self.assertEqual(analysis["matches"][0]["coordinate"], [32, 50])
        self.assertFalse(analysis["selectedFrameComplete"])
        self.assertEqual(analysis["visibilityConclusion"], "not-established-without-complete-selected-frame-and-manual-review")

    def test_analyzes_only_the_complete_selected_present_window(self) -> None:
        save = self._save_metadata()
        assets = self._asset_roster()
        expected = next(row for row in oracle._farm_target_rects(save, assets) if row["candidateSizeFromDrawGeometry"] == 4)
        draw = {
            "type": "render_copy",
            "frame": 11,
            "renderer": "renderer-a",
            "targetSurface": None,
            "rgbaSha256": "a" * 64,
            "dst": expected["expectedRect"],
            "clip": [0, 0, 1024, 768],
            "alphaNonzero": 100,
            "alpha": 255,
            "blend": 1,
        }
        records = [
            dict(draw, seq=1),
            {"type": "capture_start", "seq": 10, "renderer": "renderer-a", "width": 1024, "height": 768},
            dict(draw, seq=11),
            {"type": "render_copy", "seq": 12, "frame": 11, "renderer": "renderer-a", "dst": [330, 700, 4, 4], "alphaNonzero": 0, "rgbaSha256": "unavailable"},
            {"type": "render_fill_rect", "seq": 13, "frame": 11, "renderer": "renderer-a", "rect": [330, 700, 10, 8], "alpha": 255},
            {"type": "render_line", "seq": 14, "frame": 11, "renderer": "renderer-a", "from": [321, 700], "to": [328, 710], "alpha": 255},
            {"type": "filled_polygon", "seq": 15, "frame": 11, "renderer": "renderer-a", "bbox": [400, 700, 410, 710], "alpha": 255},
            {"type": "render_geometry", "seq": 16, "frame": 11, "renderer": "renderer-a"},
            {"type": "native_frame_capture", "seq": 17, "frame": 11, "renderer": "renderer-a", "readResult": 0},
            {"type": "render_present", "seq": 18, "renderer": "renderer-a", "frame": 12},
            {"type": "capture_complete", "seq": 19, "renderer": "renderer-a", "frame": 12},
            dict(draw, seq=20),
        ]
        analysis = oracle.analyze_trace(save, assets, records)
        self.assertEqual(analysis["matchedCallCount"], 1)
        self.assertTrue(analysis["selectedFrameComplete"])
        self.assertEqual(analysis["selectedFrameStartSeq"], 10)
        self.assertEqual(analysis["selectedFrameCompleteSeq"], 19)
        self.assertEqual(analysis["possibleLaterOverdrawCount"], 4)
        self.assertEqual(analysis["unparsedLaterDrawCount"], 1)
        self.assertEqual(analysis["unparsedLaterDrawExamples"][0]["type"], "render_geometry")
        self.assertEqual(analysis["possibleLaterOverdrawExamples"][0]["texturePixels"], "unresolved")
        self.assertTrue(analysis["captureWindowExactlyOne"])

    def test_repeated_capture_windows_do_not_claim_single_frame_completion(self) -> None:
        save = self._save_metadata()
        assets = self._asset_roster()
        expected = next(row for row in oracle._farm_target_rects(save, assets) if row["candidateSizeFromDrawGeometry"] == 4)
        draw = {"type": "render_copy", "frame": 1, "renderer": "renderer-a", "rgbaSha256": "a" * 64, "dst": expected["expectedRect"], "clip": [0, 0, 1024, 768]}
        records = [
            {"type": "capture_start", "seq": 1, "renderer": "renderer-a", "width": 1024, "height": 768},
            dict(draw, seq=2),
            {"type": "render_present", "seq": 3, "renderer": "renderer-a", "frame": 2},
            {"type": "capture_complete", "seq": 4, "renderer": "renderer-a", "frame": 2},
            {"type": "capture_start", "seq": 5, "renderer": "renderer-a", "width": 1024, "height": 768},
        ]
        analysis = oracle.analyze_trace(save, assets, records)
        self.assertEqual(analysis["captureWindowCount"], 2)
        self.assertFalse(analysis["captureWindowExactlyOne"])
        self.assertFalse(analysis["selectedFrameComplete"])

    def test_incomplete_selected_frame_never_claims_complete_visibility(self) -> None:
        save = self._save_metadata()
        assets = self._asset_roster()
        expected = next(row for row in oracle._farm_target_rects(save, assets) if row["candidateSizeFromDrawGeometry"] == 4)
        records = [
            {"type": "capture_start", "seq": 1, "renderer": "renderer-a", "width": 1024, "height": 768},
            {"type": "render_copy", "seq": 2, "frame": 1, "renderer": "renderer-a", "rgbaSha256": "a" * 64, "dst": expected["expectedRect"], "clip": [0, 0, 1024, 768]},
            {"type": "trace_cap", "events": 50000, "bytes": 16777216},
        ]
        analysis = oracle.analyze_trace(save, assets, records)
        self.assertFalse(analysis["selectedFrameComplete"])
        self.assertEqual(analysis["visibilityConclusion"], "not-established-without-complete-selected-frame-and-manual-review")

    def test_does_not_call_missing_or_ambiguous_draw_a_match(self) -> None:
        assets = self._asset_roster()
        save = self._save_metadata()
        self.assertEqual(oracle.analyze_trace(save, assets, [])["status"], "unresolved")
        candidates = oracle._farm_target_rects(save, assets)
        expected = next(row for row in candidates if row["candidateSizeFromDrawGeometry"] == 4)
        record = {
            "type": "render_copy",
            "seq": 41,
            "frame": 3,
            "rgbaSha256": "a" * 64,
            "dst": expected["expectedRect"],
            "renderer": "0x11",
            "targetSurface": "0x22",
            "clip": [0, 0, 1024, 768],
            "blend": 1,
        }
        duplicated = dict(record, seq=42)
        repeated_frame = oracle.analyze_trace(save, assets, [record, duplicated])
        self.assertEqual(repeated_frame["status"], "matched-one-farm-draw")
        self.assertEqual(repeated_frame["matchedCallCount"], 2)
        two_farms = dict(save, constructions=[*save["constructions"], {"type": "Farm", "group": 5, "x": 43, "y": 50}])
        second_expected = next(
            row for row in oracle._farm_target_rects(two_farms, assets)
            if row["coordinate"] == [43, 50] and row["candidateSizeFromDrawGeometry"] == 4
        )
        second_draw = dict(record, seq=43, dst=second_expected["expectedRect"])
        multiple = oracle.analyze_trace(two_farms, assets, [record, second_draw])
        self.assertEqual(multiple["status"], "matched-farm-draw-set")
        self.assertEqual([row["coordinate"] for row in multiple["sourceObjects"]], [[32, 50], [43, 50]])
        other_size = next(
            row for row in oracle._farm_target_rects(save, assets)
            if row["coordinate"] == [32, 50] and row["candidateSizeFromDrawGeometry"] == 3
        )
        ambiguous = dict(record, seq=44, dst=other_size["expectedRect"])
        self.assertEqual(oracle.analyze_trace(save, assets, [record, ambiguous])["status"], "unresolved")

    def test_trace_parser_requires_ordered_jsonl_and_boundaries(self) -> None:
        with tempfile.TemporaryDirectory(prefix="lincity-trace-test-") as directory:
            path = Path(directory) / "trace.jsonl"
            path.write_text('{"type":"renderer_window","seq":1}\n', encoding="utf-8")
            self.assertEqual(oracle.parse_trace(path)[0]["seq"], 1)
            path.write_text('{"type":"renderer_window","seq":2}\n{"type":"render_present","seq":1}\n', encoding="utf-8")
            with self.assertRaisesRegex(oracle.OracleError, "increasing"):
                oracle.parse_trace(path)
            path.write_text('{"type":"trace_cap","events":50000,"bytes":16777216}\n', encoding="utf-8")
            self.assertEqual(oracle.parse_trace(path)[0]["type"], "trace_cap")
            path.write_text('{"type":"renderer_window"}', encoding="utf-8")
            with self.assertRaisesRegex(oracle.OracleError, "truncated"):
                oracle.parse_trace(path)

    def test_viewport_dimensions_are_validated_and_legacy_defaults_remain(self) -> None:
        self.assertEqual(oracle.validate_viewport(280, 240), (280, 240))
        self.assertEqual(oracle.validate_viewport(4096, 4096), (4096, 4096))
        for dimensions in ((279, 600), (800, 239), (4097, 600), (800, 4097), (True, 600)):
            with self.subTest(dimensions=dimensions), self.assertRaises(oracle.OracleError):
                oracle.validate_viewport(*dimensions)
        self.assertEqual(
            oracle.project_construction_draw(
                {"x": 35, "y": 54}, {"x": 35, "y": 54}, 100, 2, 266, 210, 131, 210
            ),
            [381, 270, 266, 210],
        )

    def test_800_by_600_projection_uses_full_viewport_offsets(self) -> None:
        cases = [
            ((35, 54), (35, 54), 266, 210, 131, 210, [269, 186, 266, 210]),
            ((40, 54), (38, 53), 256, 256, 128, 256, [336, 236, 256, 256]),
            ((42, 54), (39, 53), 258, 215, 129, 215, [399, 309, 258, 215]),
        ]
        for target, camera, width, height, x_offset, y_offset, expected in cases:
            with self.subTest(target=target):
                actual = oracle.project_construction_draw(
                    {"x": target[0], "y": target[1]},
                    {"x": camera[0], "y": camera[1]},
                    world_side=100,
                    footprint_size=2,
                    image_width=width,
                    image_height=height,
                    image_x_offset=x_offset,
                    image_y_offset=y_offset,
                    viewport_width=800,
                    viewport_height=600,
                )
                self.assertEqual(actual, expected)

    def test_continue_click_is_derived_from_pinned_table_geometry(self) -> None:
        layout = b'''<gui><TableLayout rows="8" cols="3">
            <colsize col="1" relative="1"/><colsize col="2" relative="0.5"/><colsize col="3" relative="1"/>
            <rowsize row="1" relative="2.5"/><rowsize row="2" relative="1"/>
            <cell row="2" col="3"><Button name="ContinueButton"/></cell>
        </TableLayout></gui>'''
        self.assertEqual(oracle.continue_button_center(layout, 800, 600), (640, 189))
        with self.assertRaisesRegex(oracle.OracleError, "missing or ambiguous"):
            oracle.continue_button_center(b"<gui><TableLayout rows='1' cols='1'/></gui>", 800, 600)

    def test_construction_frame_with_trace_cap_is_not_complete(self) -> None:
        save = {
            "worldSide": 100,
            "cameraOrigin": {"x": 35, "y": 54},
            "constructions": [{"type": "Pottery", "group": 29, "x": 35, "y": 54}],
        }
        asset = {
            "rgbaSha256": "b" * 64,
            "width": 266,
            "height": 210,
            "xOffset": 131,
            "yOffset": 210,
            "alphaBBoxHalfOpen": [0, 48, 266, 210],
        }
        destination = oracle.project_construction_draw(
            save["constructions"][0], save["cameraOrigin"], 100, 2, 266, 210, 131, 210,
        )
        records = [
            {"type": "capture_start", "seq": 1},
            {"type": "render_copy", "seq": 2, "rgbaSha256": "b" * 64, "dst": destination, "result": 0},
            {"type": "render_present", "seq": 3},
            {"type": "capture_complete", "seq": 4},
            {"type": "trace_cap", "events": 50000, "bytes": 16777216},
        ]
        analysis = oracle.analyze_construction_trace(save, "Pottery", asset, 2, records)
        self.assertTrue(analysis["traceCapReached"])
        self.assertFalse(analysis["selectedFrameComplete"])

    def test_camera_origins_project_frozen_farms_into_full_viewport(self) -> None:
        assets = self._asset_roster()
        save = self._save_metadata()
        save["constructions"].append({"type": "Farm", "group": 5, "x": 43, "y": 50})
        farm32_camera = dict(save, cameraOrigin={"x": 31, "y": 49})
        farm32 = next(
            row for row in oracle._farm_target_rects(farm32_camera, assets)
            if row["coordinate"] == [32, 50] and row["candidateSizeFromDrawGeometry"] == 4
        )
        self.assertEqual(farm32["expectedRect"], [256, 160, 512, 512])
        farm43_camera = dict(save, cameraOrigin={"x": 41, "y": 49})
        farm43 = next(
            row for row in oracle._farm_target_rects(farm43_camera, assets)
            if row["coordinate"] == [43, 50] and row["candidateSizeFromDrawGeometry"] == 4
        )
        self.assertEqual(farm43["expectedRect"], [320, 192, 512, 512])

    def test_projector_uses_authoritative_size_two_and_viewport_half_height(self) -> None:
        cases = [
            ({"x": 35, "y": 54}, {"x": 31, "y": 49}, 266, 210, 131, 210, [317, 558, 266, 210]),
            ({"x": 35, "y": 54}, {"x": 35, "y": 54}, 266, 210, 131, 210, [381, 270, 266, 210]),
            ({"x": 40, "y": 54}, {"x": 31, "y": 49}, 256, 256, 128, 256, [640, 672, 256, 256]),
            ({"x": 40, "y": 54}, {"x": 40, "y": 54}, 256, 256, 128, 256, [384, 224, 256, 256]),
            ({"x": 42, "y": 54}, {"x": 31, "y": 49}, 258, 215, 129, 215, [767, 777, 258, 215]),
            ({"x": 42, "y": 54}, {"x": 42, "y": 54}, 258, 215, 129, 215, [383, 265, 258, 215]),
        ]
        coords = ((35, 54), (35, 54), (40, 54), (40, 54), (42, 54), (42, 54))
        for values, coordinate in zip(cases, coords, strict=True):
            _, camera, width, height, x_offset, y_offset, expected = values
            actual = oracle.project_construction_draw(
                {"x": coordinate[0], "y": coordinate[1]},
                camera,
                world_side=100,
                footprint_size=2,
                image_width=width,
                image_height=height,
                image_x_offset=x_offset,
                image_y_offset=y_offset,
            )
            self.assertEqual(actual, expected)

    def test_viewport_gate_uses_capture_start_renderer_dimensions(self) -> None:
        records = [{"type": "capture_start", "width": 800, "height": 600}]
        self.assertEqual(oracle.verify_observed_viewport(records, 800, 600), (True, [[800, 600]]))
        self.assertFalse(oracle.verify_observed_viewport(records, 1024, 768)[0])
        self.assertFalse(oracle.verify_observed_viewport([], 800, 600)[0])
        self.assertFalse(oracle.verify_observed_viewport([
            *records, {"type": "renderer_window", "width": 1024, "height": 768}
        ], 800, 600)[0])

    def test_generic_target_analysis_uses_source_footprint_and_flags_clipping(self) -> None:
        save = {
            "worldSide": 100,
            "cameraOrigin": {"x": 35, "y": 51},
            "constructions": [{"type": "Pottery", "group": 29, "x": 35, "y": 54}],
        }
        asset = {
            "rgbaSha256": "b" * 64,
            "width": 266,
            "height": 210,
            "xOffset": 131,
            "yOffset": 210,
            "alphaBBoxHalfOpen": [0, 48, 266, 210],
        }
        expected = oracle.project_construction_draw(save["constructions"][0], save["cameraOrigin"], 100, 2, 266, 210, 131, 210)
        records = [
            {"type": "capture_start", "seq": 1, "renderer": "renderer-a"},
            {"type": "render_copy", "seq": 2, "frame": 7, "renderer": "renderer-a", "rgbaSha256": "b" * 64, "dst": expected, "clip": [0, 0, 0, 0], "result": 0},
            {"type": "render_fill_rect", "seq": 3, "frame": 7, "renderer": "renderer-a", "rect": [200, 420, 5, 5], "alpha": 255},
            {"type": "native_frame_capture", "seq": 4, "frame": 7, "renderer": "renderer-a", "readResult": 0},
            {"type": "render_present", "seq": 5, "frame": 8, "renderer": "renderer-a"},
            {"type": "capture_complete", "seq": 6, "renderer": "renderer-a"},
        ]
        analysis = oracle.analyze_construction_trace(save, "Pottery", asset, 2, records)
        self.assertEqual(analysis["status"], "matched-one-source-draw")
        self.assertTrue(analysis["selectedFrameComplete"])
        self.assertEqual(analysis["visibleAlphaBBoxHalfOpenInViewport"], [189, 414, 455, 576])
        self.assertTrue(analysis["alphaUnclipped"])
        self.assertEqual(analysis["possibleLaterOverdrawIntersections"], 1)
        self.assertEqual(analysis["unparsedLaterDrawCount"], 0)
        with self.assertRaisesRegex(oracle.OracleError, "pinned upstream group size"):
            oracle.analyze_construction_trace(save, "Pottery", asset, 8, records)


class LegacyCompatibilityTests(unittest.TestCase):
    def test_legacy_farm_unresolved_analysis_keeps_camera_only_success_semantics(self) -> None:
        legacy_unresolved_farm = {
            "cameraOriginMatchesExpected": True,
            "metadataGateRequired": False,
            "metadataGatePassed": None,
            "constructionDrawAnalysis": None,
        }
        self.assertEqual(
            oracle.preflight_exit_code(
                legacy_unresolved_farm["cameraOriginMatchesExpected"],
                legacy_unresolved_farm["metadataGateRequired"],
                legacy_unresolved_farm["metadataGatePassed"],
            ),
            0,
        )
        self.assertEqual(oracle.expected_target_coordinate_for_run(None, "Farm", False), {"x": 32, "y": 50})
        self.assertIsNone(oracle.expected_target_coordinate_for_run(None, "Market", False))

    def test_strict_metadata_gate_rejects_missing_or_incomplete_evidence(self) -> None:
        with self.assertRaisesRegex(oracle.OracleError, "explicit target coordinate"):
            oracle.expected_target_coordinate_for_run(None, "Market", True)
        self.assertEqual(oracle.preflight_exit_code(True, True, False), 2)
        self.assertEqual(oracle.preflight_exit_code(True, True, True), 0)
        self.assertEqual(oracle.preflight_exit_code(False, True, True), 0)

    def test_legacy_window_keeps_original_continue_click(self) -> None:
        script = oracle._session_script(
            Path("/owned/output"), Path("/owned/observer.so"), Path("/usr/games/lincity-ng"), "none",
        )
        self.assertIn("xdotool mousemove --sync 815 242 click 1", script)


class NativeFramebufferTests(unittest.TestCase):
    def _capture_records(self, digest: str, **changes: object) -> list[dict[str, object]]:
        capture: dict[str, object] = {
            "type": "native_frame_capture",
            "seq": 8,
            "renderer": "renderer-a",
            "targetSurface": None,
            "frame": 7,
            "width": 800,
            "height": 600,
            "format": "SDL_PIXELFORMAT_RGBA32",
            "targetRgbaSha256": "target-pixel-sha",
            "byteCount": oracle.MAX_NATIVE_FRAME_BYTES,
            "sha256": digest,
            "readResult": 0,
            "status": "captured",
            "failure": "",
        }
        capture.update(changes)
        return [
            {"type": "capture_start", "seq": 1, "renderer": "renderer-a", "frame": 7},
            {"type": "render_copy", "seq": 3, "renderer": "renderer-a", "frame": 7, "rgbaSha256": "target-pixel-sha"},
            capture,
            {"type": "render_present", "seq": 9, "renderer": "renderer-a", "frame": 8},
            {"type": "capture_complete", "seq": 10, "renderer": "renderer-a", "frame": 8},
        ]

    def test_rgba_fullframe_validates_and_png_preserves_exact_pixels(self) -> None:
        rgba = bytes((12, 34, 56, 255)) * (800 * 600)
        digest = hashlib.sha256(rgba).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            raw_path = output / "native-frame.rgba"
            raw_path.write_bytes(rgba)
            raw_path.chmod(0o600)
            result = oracle.validate_native_frame_capture(self._capture_records(digest), 7, output)
            self.assertEqual(result["status"], "captured-and-pixel-verified")
            self.assertTrue(result["sameFrameAsTargetDraw"])
            self.assertEqual(stat.S_IMODE((output / "native-frame.png").stat().st_mode), 0o600)
            from PIL import Image

            with Image.open(output / "native-frame.png") as image:
                image.load()
                self.assertEqual(image.size, (800, 600))
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.tobytes(), rgba)

    def test_capture_failure_wrong_renderer_dimensions_and_frame_are_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            wrong_renderer = self._capture_records("", status="failed", failure="renderer-is-not-main-window-renderer", targetSurface="0x12", readResult=-1)
            self.assertEqual(oracle.validate_native_frame_capture(wrong_renderer, 7, output)["reason"], "renderer-is-not-main-window-renderer")
            wrong_dimensions = self._capture_records("", status="failed", failure="renderer-dimensions-mismatch", width=799, readResult=-1)
            self.assertEqual(oracle.validate_native_frame_capture(wrong_dimensions, 7, output)["reason"], "renderer-dimensions-mismatch")

            rgba = bytes(oracle.MAX_NATIVE_FRAME_BYTES)
            (output / "native-frame.rgba").write_bytes(rgba)
            (output / "native-frame.rgba").chmod(0o600)
            wrong_frame = self._capture_records(hashlib.sha256(rgba).hexdigest(), frame=6)
            self.assertEqual(oracle.validate_native_frame_capture(wrong_frame, 7, output)["reason"], "native-frame-identity-mismatch")

    def test_capture_must_be_between_target_draw_and_post_present_completion(self) -> None:
        rgba = bytes(oracle.MAX_NATIVE_FRAME_BYTES)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "native-frame.rgba").write_bytes(rgba)
            (output / "native-frame.rgba").chmod(0o600)
            records = self._capture_records(hashlib.sha256(rgba).hexdigest())
            records[3]["seq"] = 7
            invalid = oracle.validate_native_frame_capture(records, 7, output)
            self.assertEqual(invalid["reason"], "native-frame-trace-order-invalid")

    def test_malformed_length_hash_and_png_overwrite_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            raw_path = output / "native-frame.rgba"
            raw_path.write_bytes(b"short")
            raw_path.chmod(0o600)
            malformed = oracle.validate_native_frame_capture(self._capture_records("0" * 64), 7, output)
            self.assertEqual(malformed["reason"], "native-frame-byte-length-mismatch")

            rgba = bytes(oracle.MAX_NATIVE_FRAME_BYTES)
            raw_path.write_bytes(rgba)
            wrong_hash = oracle.validate_native_frame_capture(self._capture_records("0" * 64), 7, output)
            self.assertEqual(wrong_hash["reason"], "native-frame-sha256-mismatch")

            digest = hashlib.sha256(rgba).hexdigest()
            (output / "native-frame.png").write_bytes(b"preserve")
            no_overwrite = oracle.validate_native_frame_capture(self._capture_records(digest), 7, output)
            self.assertEqual(no_overwrite["reason"], "native-frame-png-validation-failed:FileExistsError")
            self.assertEqual((output / "native-frame.png").read_bytes(), b"preserve")

    def test_capture_record_absence_is_not_a_metadata_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = oracle.validate_native_frame_capture([], None, Path(directory))
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["reason"], "native-frame-record-count-mismatch")

    def test_native_capture_requires_explicit_strict_gate(self) -> None:
        args = oracle.build_parser().parse_args([
            "preflight", "--save", "/unused/save", "--expected-save-sha256", "0" * 64,
            "--output", "/unused/output", "--source-root", "/unused/source",
            "--painter-source-root", "/unused/painter", "--tcc", "/unused/tcc",
            "--tcc-libroot", "/unused/lib", "--sdl-include", "/unused/sdl",
            "--capture-native-frame",
        ])
        with self.assertRaisesRegex(oracle.OracleError, "requires the strict 800x600 metadata gate"):
            oracle.run_preflight(args)

    def test_output_roots_are_frozen_and_symlink_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "run"
            with self.assertRaisesRegex(oracle.OracleError, "frozen external diagnostic roots"):
                oracle.verify_owned_output(outside, Path("/"))
            with self.assertRaisesRegex(oracle.OracleError, "under the external fresh-map artifact root"):
                oracle.verify_owned_output(Path("/root/.codex/artifacts/zorya-classifier-mcp-20261101/outside-run"), oracle.RESUMPTION_ARTIFACT_ROOT)
            symlink_root = Path(directory) / "allowed-root-link"
            symlink_root.symlink_to(oracle.RESUMPTION_ARTIFACT_ROOT, target_is_directory=True)
            with self.assertRaisesRegex(oracle.OracleError, "frozen external diagnostic roots"):
                oracle.verify_owned_output(symlink_root / "run", symlink_root)

    def test_native_capture_flag_is_emitted_only_when_explicit(self) -> None:
        standard = oracle._session_script(
            Path("/owned/output"), Path("/owned/observer.so"), Path("/usr/games/lincity-ng"), "none",
        )
        captured = oracle._session_script(
            Path("/owned/output"), Path("/owned/observer.so"), Path("/usr/games/lincity-ng"), "none",
            800, 600, 400, 300, True,
        )
        self.assertNotIn("ZORYA_LINCITY_CAPTURE_NATIVE_FRAME=1", standard)
        self.assertIn("ZORYA_LINCITY_CAPTURE_NATIVE_FRAME=1", captured)
        self.assertIn("ZORYA_LINCITY_NATIVE_FRAME_RGBA_PATH", captured)

    @unittest.skipUnless(
        all(os.environ.get(name) for name in ("ZORYA_LINCITY_TCC", "ZORYA_LINCITY_TCC_LIBROOT", "ZORYA_LINCITY_SDL_INCLUDE")),
        "pinned TCC and SDL headers are required for the native SDL fixture",
    )
    def test_sdl_dummy_fixture_captures_exact_frame_and_fails_closed(self) -> None:
        root = Path(__file__).parent
        compiler = Path(os.environ["ZORYA_LINCITY_TCC"])
        libroot = Path(os.environ["ZORYA_LINCITY_TCC_LIBROOT"])
        include = Path(os.environ["ZORYA_LINCITY_SDL_INCLUDE"])
        sdl_library = Path("/usr/lib/x86_64-linux-gnu/libSDL2-2.0.so.0")
        target_hash = hashlib.sha256(bytes((90, 80, 70, 255)) * 16).hexdigest()

        def build_args(output: Path, source: Path, shared: bool) -> list[str]:
            return [
                str(compiler), f"-B{libroot}", "-DSDL_DISABLE_IMMINTRIN_H",
                *( ["-shared", "-fPIC"] if shared else [] ),
                f"-I{include.parent}", f"-I{include.parent / 'x86_64-linux-gnu'}", f"-I{include}",
                "-o", str(output), str(source), "-ldl", "-lpthread", str(sdl_library),
            ]

        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            observer = temp / "observer.so"
            fixture = temp / "fixture"
            compiled_observer = subprocess.run(build_args(observer, root / "sdl_observer.c", True), capture_output=True, text=True, timeout=10)
            self.assertEqual(compiled_observer.returncode, 0, compiled_observer.stderr)
            compiled_fixture = subprocess.run(build_args(fixture, root / "native_frame_fixture.c", False), capture_output=True, text=True, timeout=10)
            self.assertEqual(compiled_fixture.returncode, 0, compiled_fixture.stderr)

            def run_fixture(name: str, mode: str | None = None, preset_raw: bytes | None = None) -> tuple[list[dict[str, object]], Path]:
                run = temp / name
                run.mkdir(mode=0o700)
                trace = run / "trace.jsonl"
                control = run / "capture-control"
                control.write_bytes(b"go")
                control.chmod(0o600)
                raw = run / "native-frame.rgba"
                if name == "bad-output":
                    raw = run / "missing" / "native-frame.rgba"
                if preset_raw is not None:
                    raw.write_bytes(preset_raw)
                env = dict(os.environ)
                env.update({
                    "SDL_VIDEODRIVER": "dummy",
                    "LD_PRELOAD": str(observer),
                    "ZORYA_LINCITY_TRACE_JSONL": str(trace),
                    "ZORYA_LINCITY_CAPTURE_CONTROL": str(control),
                    "ZORYA_LINCITY_CAPTURE_NATIVE_FRAME": "1",
                    "ZORYA_LINCITY_NATIVE_FRAME_RGBA_PATH": str(raw),
                    "ZORYA_LINCITY_TARGET_RGBA_SHA256": target_hash,
                })
                command = [str(fixture), *([mode] if mode else [])]
                completed = subprocess.run(command, capture_output=True, text=True, env=env, timeout=10)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                records = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines()]
                return records, raw

            records, raw_path = run_fixture("window")
            self.assertEqual(len([row for row in records if row.get("type") == "capture_start"]), 1)
            self.assertEqual(len([row for row in records if row.get("type") == "native_frame_capture"]), 1)
            target_draw = next(row for row in records if row.get("type") == "render_copy" and row.get("rgbaSha256") == target_hash)
            validated = oracle.validate_native_frame_capture(records, int(target_draw["frame"]), raw_path.parent)
            self.assertEqual(validated["status"], "captured-and-pixel-verified")
            pixels = raw_path.read_bytes()
            self.assertEqual(pixels[0:4], bytes((12, 34, 56, 255)))
            self.assertEqual(pixels[(25 * 800 + 15) * 4 : (25 * 800 + 15) * 4 + 4], bytes((210, 20, 30, 255)))
            self.assertEqual(pixels[(120 * 800 + 100) * 4 : (120 * 800 + 100) * 4 + 4], bytes((90, 80, 70, 255)))

            wrong_renderer, _ = run_fixture("software", "--software")
            self.assertEqual(next(row for row in wrong_renderer if row.get("type") == "native_frame_capture")["failure"], "renderer-is-not-main-window-renderer")
            wrong_dimensions, _ = run_fixture("wrong-dimensions", "--width-799")
            self.assertEqual(next(row for row in wrong_dimensions if row.get("type") == "native_frame_capture")["failure"], "renderer-dimensions-mismatch")
            offscreen_target, _ = run_fixture("offscreen-target", "--offscreen")
            self.assertEqual(next(row for row in offscreen_target if row.get("type") == "native_frame_capture")["failure"], "renderer-has-offscreen-target")
            preserved, preserved_path = run_fixture("no-overwrite", preset_raw=b"keep")
            self.assertEqual(next(row for row in preserved if row.get("type") == "native_frame_capture")["failure"], "capture-file-open-failed")
            self.assertEqual(preserved_path.read_bytes(), b"keep")

            unwritable, _ = run_fixture("bad-output", preset_raw=None)
            failed_write = next(row for row in unwritable if row.get("type") == "native_frame_capture")
            self.assertEqual(failed_write["status"], "failed")
            self.assertEqual(failed_write["failure"], "capture-file-open-failed")


class CameraActionScriptTests(unittest.TestCase):
    def test_800_by_600_session_uses_layout_derived_continue_click(self) -> None:
        script = oracle._session_script(
            Path("/owned/output"), Path("/owned/observer.so"), Path("/usr/games/lincity-ng"),
            "none", viewport_width=800, viewport_height=600,
        )
        self.assertIn("-screen 0 800x600x24", script)
        self.assertIn("--size 800x600", script)
        self.assertIn("xdotool mousemove --sync 640 189 click 1", script)
        self.assertNotIn("xdotool keydown", script)

    def test_camera_action_script_uses_game_keys_before_capture_marker(self) -> None:
        script = oracle._session_script(Path("/owned/output"), Path("/owned/observer.so"), Path("/usr/games/lincity-ng"), "farm-32-centered")
        self.assertLess(script.index("click 1"), script.index("xdotool keydown Down"))
        self.assertLess(script.index("xdotool keyup Right"), script.rindex(": >"))
        self.assertIn("sleep 0.576", script)
        self.assertIn("sleep 0.064", script)

    def test_frozen_building_camera_actions_execute_before_capture_marker(self) -> None:
        actions = {
            "pottery-camera-v1": ("sleep 0.576", "xdotool keydown Left", "sleep 0.064", "xdotool keyup Left"),
            "market-camera-v1": ("sleep 0.720", "xdotool keydown Right", "sleep 0.256", "xdotool keyup Right"),
            "water-tower-camera-v1": ("sleep 0.720", "xdotool keydown Right", "sleep 0.384", "xdotool keyup Right"),
        }
        for action, fragments in actions.items():
            with self.subTest(action=action):
                script = oracle._session_script(Path("/owned/output"), Path("/owned/observer.so"), Path("/usr/games/lincity-ng"), action)
                marker = script.rindex(": >")
                for fragment in fragments:
                    self.assertLess(script.index(fragment), marker)


if __name__ == "__main__":
    unittest.main()
