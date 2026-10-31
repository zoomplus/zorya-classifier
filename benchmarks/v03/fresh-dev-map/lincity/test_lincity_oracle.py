from __future__ import annotations

import gzip
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
            {"type": "render_present", "seq": 17, "renderer": "renderer-a", "frame": 12},
            {"type": "capture_complete", "seq": 18, "renderer": "renderer-a", "frame": 12},
            dict(draw, seq=19),
        ]
        analysis = oracle.analyze_trace(save, assets, records)
        self.assertEqual(analysis["matchedCallCount"], 1)
        self.assertTrue(analysis["selectedFrameComplete"])
        self.assertEqual(analysis["selectedFrameStartSeq"], 10)
        self.assertEqual(analysis["selectedFrameCompleteSeq"], 18)
        self.assertEqual(analysis["possibleLaterOverdrawCount"], 4)
        self.assertEqual(analysis["unparsedLaterDrawCount"], 1)
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
            {"type": "render_present", "seq": 4, "frame": 8, "renderer": "renderer-a"},
            {"type": "capture_complete", "seq": 5, "renderer": "renderer-a"},
        ]
        analysis = oracle.analyze_construction_trace(save, "Pottery", asset, 2, records)
        self.assertEqual(analysis["status"], "matched-one-source-draw")
        self.assertTrue(analysis["selectedFrameComplete"])
        self.assertEqual(analysis["visibleAlphaBBoxHalfOpenInViewport"], [189, 414, 455, 576])
        self.assertTrue(analysis["alphaUnclipped"])
        self.assertEqual(analysis["possibleLaterOverdrawIntersections"], 1)
        with self.assertRaisesRegex(oracle.OracleError, "pinned upstream group size"):
            oracle.analyze_construction_trace(save, "Pottery", asset, 8, records)


class CameraActionScriptTests(unittest.TestCase):
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
