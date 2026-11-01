from __future__ import annotations

import json
import os
import gzip
import io
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import crimson_map_oracle as oracle


class SourceUnitFixtureTests(unittest.TestCase):
    def test_ordered_units_keep_inherited_type_and_ignore_other_sections(self) -> None:
        source = b"""[mission]\nname = fixture\n[unit]\ntype = Artillery\nplayer = 1\nid = 97\npos = 14/23\n[unit]\nplayer = 2\nid = 98\npos = 2/3\n[player]\nname = other\n[unit]\ntype = Submarines\nplayer = 2\nid = 99\npos = 4/5\n"""
        rows = oracle.parse_level_units(source)
        self.assertEqual(rows, [
            {"type": "Artillery", "player": 1, "unitId": 97, "hex": [14, 23]},
            {"type": "Artillery", "player": 2, "unitId": 98, "hex": [2, 3]},
            {"type": "Submarines", "player": 2, "unitId": 99, "hex": [4, 5]},
        ])

    def test_rejects_first_unit_without_type(self) -> None:
        with self.assertRaisesRegex(oracle.OracleError, "no explicit type"):
            oracle.parse_level_units(b"[unit]\nplayer=1\nid=2\npos=1/2\n")

    def test_rejects_invalid_coordinates(self) -> None:
        with self.assertRaisesRegex(oracle.OracleError, "valid player/id/pos"):
            oracle.parse_level_units(b"[unit]\ntype=Infantry\nplayer=1\nid=2\npos=1,x\n")

    def test_parses_private_facing_without_changing_unit_identity(self) -> None:
        rows = oracle.parse_level_units(
            b"[unit]\ntype=Artillery\nplayer=1\nid=97\npos=14/23\nface = 2\n"
        )
        self.assertEqual(rows, [{"type": "Artillery", "player": 1, "unitId": 97, "hex": [14, 23], "face": 2}])

    def test_parses_initial_creation_events_without_crossing_section_boundaries(self) -> None:
        source = b"""[event]\nid = 8\ntype = createunit\ntrigger = handicap\nthandicap = 5\nunit = Artillery\nplayer = 1\npos = 16/23\n[event]\nid = 9\ntype = message\ntrigger = timer\nttime = 0\n[unit]\ntype = Infantry\nplayer = 1\nid = 1\npos = 0/0\n"""
        rows = oracle.parse_level_events(source)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["unit"], "Artillery")
        self.assertEqual(rows[0]["thandicap"], "5")
        self.assertNotIn("unit", rows[1])


class NativeDisplayPaletteTests(unittest.TestCase):
    def test_x11_input_witness_proves_scroll_key_and_rejects_numlock_variant(self) -> None:
        audit = oracle.audit_native_key_input()
        self.assertEqual(audit["status"], "fixed-key-input-reaches-native-scroll-branch")
        self.assertEqual(audit["fixedKeyEvents"], [(13, 0), (13, 0), (258, 0)])
        self.assertEqual(audit["pixelsRead"], False)

    def test_sdl16_xcb_palette_is_exact_and_all_registered_sprites_avoid_key(self) -> None:
        audit = oracle.audit_native_palette_display()
        self.assertEqual(audit["status"], "native-sdl16-palette-xcb-map-verified")
        self.assertEqual(audit["independentRuns"], 2)
        self.assertEqual(audit["pixelTolerance"], 0)
        self.assertEqual(audit["colorkeyIndex"], 0)
        self.assertEqual(len(audit["paletteEntries"]), 126)
        self.assertEqual(audit["healthBarOuterBorderRgb"], [0, 0, 0])
        self.assertEqual(audit["healthBarColorSourceSha256"],
                         "6b2a7761ab4ce2921aef0eb51018f5cd71d46e3a3f6fb1b4d9f7688b20d73a61")
        self.assertEqual(audit["sdlPackageSha256"], oracle.RUNTIME_PACKAGE_HASHES[
            "libsdl1.2debian_1.2.68-2_amd64.deb"
        ])

    def test_native_frame_sprite_uses_the_pinned_exact_sdl_xcb_colors(self) -> None:
        from PIL import Image

        display = oracle.audit_native_palette_display()
        source = gzip.decompress(oracle.read_pinned(
            oracle.DATA / "default.units", oracle.ASSET_HASHES["default.units"], oracle.MAX_EXTRACTED_BYTES,
        ))
        width, _height, _bpp, _flags, _palette_count = struct.unpack_from(
            "<HHBBH", source, oracle.ATLAS_HEADER_OFFSET,
        )
        palette_offset = oracle.ATLAS_HEADER_OFFSET + 11
        raster_offset = palette_offset + 126 * 3
        raster = source[raster_offset:]
        item = oracle.ROSTER[0]
        expected_draw = oracle.audit_roster()["defaultCameraProjection"][0]
        sprite = next(row for row in oracle.audit_native_unit_atlas()["sprites"] if row["type"] == item["type"])
        source_x, source_y, tile_width, tile_height = sprite["sourceRect"]
        dest_x, dest_y = expected_draw["tileTopLeftXY"]
        image = Image.new("RGB", (800, 600), (0, 0, 0))
        opaque = []
        for local_y in range(tile_height):
            for local_x in range(tile_width):
                atlas_index = raster[(source_y + local_y) * width + source_x + local_x]
                if atlas_index:
                    image.putpixel((dest_x + local_x, dest_y + local_y), tuple(display["paletteXcbRgb"][atlas_index]))
                    opaque.append((dest_x + local_x, dest_y + local_y))
        frame = io.BytesIO()
        image.save(frame, format="PNG", optimize=False)
        result = oracle.verify_native_frame_sprite(frame.getvalue(), item, expected_draw)
        self.assertEqual(result["comparedOpaquePixels"], sprite["nonColorkeyPixels"])
        self.assertEqual(result["mismatchCount"], 0)
        x, y = opaque[0]
        original = image.getpixel((x, y))
        image.putpixel((x, y), ((original[0] + 1) % 256, original[1], original[2]))
        frame = io.BytesIO()
        image.save(frame, format="PNG", optimize=False)
        with self.assertRaisesRegex(oracle.OracleError, "differs from exact SDL16/XCB palette output"):
            oracle.verify_native_frame_sprite(frame.getvalue(), item, expected_draw)

    def test_negative_native_anchor_pixels_use_the_named_medium_tank_faces(self) -> None:
        from PIL import Image

        display = oracle.audit_native_palette_display()
        source = gzip.decompress(oracle.read_pinned(
            oracle.DATA / "default.units", oracle.ASSET_HASHES["default.units"], oracle.MAX_EXTRACTED_BYTES,
        ))
        width, _height, _bpp, _flags, _palette_count = struct.unpack_from(
            "<HHBBH", source, oracle.ATLAS_HEADER_OFFSET,
        )
        raster_offset = oracle.ATLAS_HEADER_OFFSET + 11 + 126 * 3
        raster = source[raster_offset:]
        plan = oracle.audit_roster()["prospectiveCapturePlan"]
        for row in (plan[3], plan[4]):
            item = next(case for case in oracle.ROSTER if case["caseId"] == row["caseId"])
            anchor = row["nativeAnchor"]
            source_x, source_y, tile_width, tile_height = anchor["sourceRect"]
            dest_x, dest_y = anchor["tileTopLeftXY"]
            image = Image.new("RGB", (800, 600), (0, 0, 0))
            for local_y in range(tile_height):
                for local_x in range(tile_width):
                    atlas_index = raster[(source_y + local_y) * width + source_x + local_x]
                    if atlas_index:
                        image.putpixel(
                            (dest_x + local_x, dest_y + local_y),
                            tuple(display["paletteXcbRgb"][atlas_index]),
                        )
            overlay = oracle.NEGATIVE_HEALTHBAR_OVERLAP[item["level"]]
            if overlay is not None:
                image.putpixel((dest_x + overlay[0], dest_y + overlay[1]), (0, 0, 0))
            frame = io.BytesIO()
            image.save(frame, format="PNG", optimize=False)
            result = oracle.verify_native_frame_anchor(frame.getvalue(), item, anchor)
            self.assertEqual(result["comparedOpaquePixels"], 245)
            if overlay is not None:
                self.assertTrue(result["healthbarOverlap"]["pixelCompared"])
                self.assertEqual(result["expectedRgbOverrides"], [
                    {"sourceLocalXY": overlay, "xcbRgb": [0, 0, 0]},
                ])
            else:
                self.assertEqual(result["healthbarOverlap"]["overlapPixelCount"], 0)
            self.assertEqual(result["mismatchCount"], 0)
            visible = next(
                (local_x, local_y)
                for local_y in range(tile_height) for local_x in range(tile_width)
                if raster[(source_y + local_y) * width + source_x + local_x] != 0
                and (local_x, local_y) != tuple(overlay or [])
            )
            image.putpixel((dest_x + visible[0], dest_y + visible[1]), (255, 0, 255))
            frame = io.BytesIO()
            image.save(frame, format="PNG", optimize=False)
            with self.assertRaisesRegex(oracle.OracleError, "differs from exact SDL16/XCB palette output"):
                oracle.verify_native_frame_anchor(frame.getvalue(), item, anchor)
            if overlay is not None:
                image.putpixel((dest_x + overlay[0], dest_y + overlay[1]), (255, 0, 255))
                frame = io.BytesIO()
                image.save(frame, format="PNG", optimize=False)
                with self.assertRaisesRegex(oracle.OracleError, "differs from exact SDL16/XCB palette output"):
                    oracle.verify_native_frame_anchor(frame.getvalue(), item, anchor)


class ProspectiveRosterTests(unittest.TestCase):
    def test_roster_is_fixed_three_positive_two_negative_and_queries_are_neutral(self) -> None:
        self.assertEqual([row["caseId"] for row in oracle.ROSTER], [
            "crimson-anthill-p1", "crimson-beachraid-p1", "crimson-clippedwings-p1",
            "crimson-armsrace-n1", "crimson-baptism-n1",
        ])
        self.assertEqual(sum(row["label"] == "positive" for row in oracle.ROSTER), 3)
        self.assertEqual(sum(row["label"] == "negative" for row in oracle.ROSTER), 2)
        for row in oracle.ROSTER:
            self.assertNotIn(row["level"], row["query"])
            self.assertIn("on the play map", row["query"])
            if row["label"] == "positive":
                self.assertIn("yellow", row["query"])
            if row.get("selection") == "westernmost":
                self.assertIn("westernmost", row["query"])
            if "unitId" in row:
                self.assertNotIn(str(row["unitId"]), row["query"])
            if "hex" in row:
                self.assertNotIn(str(row["hex"]), row["query"])

    def test_registered_map_ids_and_facing_variants_are_fixed(self) -> None:
        self.assertEqual([row["mapId"] for row in oracle.ROSTER], [
            "a9fc2cddf65b5d3d8e11c1d5dd8d5011", "f57a524407ce9c570749d60ced201405",
            "68194e1fe9c3e86f1d81948f935c2da5", "e748eab70e95ed69c66950aacc285860",
            "dfebd59e01fbd7034a16d3a6de1ef993",
        ])
        self.assertEqual(oracle.ROSTER[0]["face"], 2)
        self.assertEqual(oracle.ROSTER[1]["face"], 1)
        self.assertEqual(oracle.ROSTER[2]["face"], 2)

    def test_baptism_event_proof_uses_handicap_mask_and_exact_unit_counts(self) -> None:
        audit = oracle.audit_roster()
        cases = {row["caseId"]: row for row in audit["cases"]}
        self.assertEqual([cases[case_id]["postInitializationUnitCount"] for case_id in (
            "crimson-anthill-p1", "crimson-beachraid-p1", "crimson-clippedwings-p1",
            "crimson-armsrace-n1", "crimson-baptism-n1",
        )], [150, 67, 67, 62, 217])
        anthill = cases["crimson-anthill-p1"]
        self.assertEqual(anthill["initialTurnEventAudit"]["missionHandicapByte"], 1)
        self.assertEqual(anthill["sourceTruth"]["status"], "source-target-exact-and-westmost-among-owner-type")
        self.assertEqual(anthill["sourceTargetPlacement"]["status"], "source-order-target-is-a-play-map-unit")
        self.assertFalse(anthill["sourceTargetPlacement"]["buildingAtHex"])
        self.assertFalse(anthill["sourceTargetPlacement"]["earlierUnitAtHex"])
        baptism = cases["crimson-baptism-n1"]
        self.assertTrue(baptism["metadataRunEligible"])
        self.assertEqual(baptism["sourceTruth"]["worldTargetCount"], 0)
        self.assertEqual([unit["createdByEventId"] for unit in baptism["initialTurnEventAudit"]["createdUnits"]], ["31", "32"])

    def test_baptism_reenabled_root_and_missing_dependency_refuse(self) -> None:
        source = oracle.read_pinned(
            oracle.SOURCE / "levels/Baptism.src", oracle.SOURCE_HASHES["levels/Baptism.src"],
        )
        events = oracle.parse_level_events(source)
        units = oracle.parse_level_units(source)
        buildings = oracle.parse_level_buildings(source)
        root_reenabled = [dict(event) for event in events]
        next(event for event in root_reenabled if event["id"] == "0")["flags"] = "0"
        with self.assertRaises(oracle.OracleError):
            oracle.simulate_initial_unit_inventory(root_reenabled, [dict(unit) for unit in units], buildings, 1, "Baptism")
        missing_dependency = [dict(event) for event in events]
        next(event for event in missing_dependency if event["id"] == "1").pop("depend")
        with self.assertRaisesRegex(oracle.OracleError, "spawn dependency graph differs"):
            oracle.simulate_initial_unit_inventory(missing_dependency, [dict(unit) for unit in units], buildings, 1, "Baptism")

    def test_compiled_native_event_queue_proves_source_execution_order(self) -> None:
        audit = oracle.audit_roster()
        cases = {row["caseId"]: row for row in audit["cases"]}
        for row in cases.values():
            proof = row["initialTurnEventAudit"]["compiledEventQueue"]
            self.assertEqual(proof["status"], "compiled-event-queue-matches-source-order")
            self.assertEqual(proof["matchingStartCount"], 1)
        baptism = cases["crimson-baptism-n1"]["initialTurnEventAudit"]["compiledEventQueue"]
        self.assertIn(31, baptism["eventIdsInNativeOrder"])
        self.assertIn(32, baptism["eventIdsInNativeOrder"])

    def test_compiled_event_queue_rejects_reordered_source_records(self) -> None:
        level = oracle.read_pinned(
            oracle.DATA / "levels/Baptism.lev", oracle.ASSET_HASHES["levels/Baptism.lev"],
        )
        header = oracle.read_pinned(
            oracle.SOURCE / "src/common/gamedefs.h", oracle.SOURCE_HASHES["src/common/gamedefs.h"],
        )
        events = oracle.parse_level_events(oracle.read_pinned(
            oracle.SOURCE / "levels/Baptism.src", oracle.SOURCE_HASHES["levels/Baptism.src"],
        ))
        with self.assertRaisesRegex(oracle.OracleError, "source-ordered native event queue"):
            oracle.verify_compiled_event_order(level, list(reversed(events)), header)

    def test_registered_variants_and_all_five_post_event_inventories_are_proven(self) -> None:
        audit = oracle.audit_roster()
        self.assertEqual(audit["registeredMapOrderSha256"], oracle.REGISTERED_MAP_ORDER_SHA256)
        cases = {row["caseId"]: row for row in audit["cases"]}
        self.assertTrue(cases["crimson-anthill-p1"]["metadataRunEligible"])
        self.assertTrue(cases["crimson-beachraid-p1"]["metadataRunEligible"])
        self.assertTrue(cases["crimson-clippedwings-p1"]["metadataRunEligible"])
        self.assertTrue(cases["crimson-armsrace-n1"]["metadataRunEligible"])
        self.assertTrue(cases["crimson-baptism-n1"]["metadataRunEligible"])
        expected_offsets = {
            "crimson-anthill-p1": [10886], "crimson-beachraid-p1": [7590],
            "crimson-clippedwings-p1": [12775],
        }
        for case_id, offsets in expected_offsets.items():
            variant = cases[case_id]["privateFacingVariant"]
            self.assertEqual(variant["compiledChangedOffsets"], offsets)
            self.assertEqual(variant["completeUnitInventoryUnchanged"], True)

    def test_native_atlas_masks_match_pinned_source_and_have_no_healthbar_overlap(self) -> None:
        audit = oracle.audit_native_unit_atlas()
        self.assertEqual(audit["status"], "native-atlas-and-clean-target-masks-verified")
        self.assertEqual(audit["rasterOffset"], 3907)
        self.assertEqual(audit["colorKey"], {"index": 0, "rgb": [210, 2, 252]})
        self.assertEqual(
            [(row["atlasTile"], row["nonColorkeyPixels"], row["localMaskBoxXYXY"], row["healthBarOverlapPixels"])
             for row in audit["sprites"]],
            [(26, 272, [4, 3, 27, 23], 0), (229, 286, [4, 3, 27, 24], 0),
             (158, 246, [6, 3, 26, 23], 0)],
        )
        self.assertFalse(audit["screenVisibilityProven"])

    def test_capture_camera_is_source_derived_and_moves_anthill_cursor_off_target(self) -> None:
        audit = oracle.audit_roster()
        cases = {row["caseId"]: row for row in audit["cases"]}
        anthill_source = oracle.read_pinned(
            oracle.FACING_VARIANTS / oracle.FACING_RECIPE_PINS["Anthill"]["source"][0],
            oracle.FACING_RECIPE_PINS["Anthill"]["source"][1],
        )
        plan = oracle.derive_capture_camera(
            anthill_source, cases["crimson-anthill-p1"]["sourceInventory"], scroll_south_once=True,
        )
        self.assertEqual(plan["firstPlayerUnitHex"], [7, 12])
        self.assertEqual(plan["cameraAfterNativeTurnStart"], [0, 64])
        self.assertEqual(plan["cameraForCapture"], [0, 114])
        self.assertFalse(plan["preCaptureScroll"]["cursorIsPositiveTarget"])
        draw = oracle.target_draw_expectation(oracle.ROSTER[0], tuple(plan["cameraForCapture"]))
        self.assertEqual(draw["tileTopLeftXY"], [322, 530])
        self.assertTrue(draw["opaqueMaskFullyInsideViewport"])
        self.assertEqual(oracle.project_hex_to_view([1, 10], (0, 0), (0, 0, 800, 600)), (23, 294))

    def test_native_blit_trace_requires_map_stage_and_exact_target_projection(self) -> None:
        plan = oracle.audit_roster()["defaultCameraProjection"][0]
        rows = []
        for index in range(30):
            rows.append({
                "sourceWidth": 256, "sourceHeight": 256, "sourceFlags": 0,
                "sourceRect": [0, 0, 32, 28],
                "destinationRect": [(index % 10) * 23, (index // 10) * 28, 32, 28],
                "destinationWidth": 800, "destinationHeight": 600, "result": 0,
            })
        rows.append({
            "sourceWidth": 768, "sourceHeight": 336, "sourceFlags": 0x1000,
            "sourceRect": plan["sourceRect"],
            "destinationRect": [*plan["tileTopLeftXY"], 32, 28],
            "destinationWidth": 800, "destinationHeight": 600, "result": 0,
        })
        trace = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
        result = oracle.verify_native_blit_trace(trace, oracle.ROSTER[0], plan)
        self.assertEqual(result["status"], "native-target-sprite-final-complete-source-and-destination-observed")
        self.assertTrue(result["targetSpriteBlitMatched"])
        self.assertTrue(result["finalTargetDrawComplete"])

        rows.append({
            "sourceWidth": 768, "sourceHeight": 336, "sourceFlags": 0x1000,
            "sourceRect": [plan["sourceRect"][0], plan["sourceRect"][1], 32, 20],
            "destinationRect": [plan["tileTopLeftXY"][0], plan["tileTopLeftXY"][1], 32, 20],
            "destinationWidth": 800, "destinationHeight": 600, "result": 0,
        })
        bad_trace = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
        with self.assertRaisesRegex(oracle.OracleError, "final native target draw is clipped"):
            oracle.verify_native_blit_trace(bad_trace, oracle.ROSTER[0], plan)

        rows.pop()
        rows[-1]["destinationRect"][0] += 1
        bad_trace = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
        with self.assertRaisesRegex(oracle.OracleError, "source-to-destination transform"):
            oracle.verify_native_blit_trace(bad_trace, oracle.ROSTER[0], plan)

    def test_negative_map_trace_requires_named_visible_unit_anchor(self) -> None:
        plan = oracle.audit_roster()["prospectiveCapturePlan"][3]
        anchor = plan["nativeAnchor"]
        rows = [
            {
                "sourceWidth": 256, "sourceHeight": 256, "sourceFlags": 0,
                "sourceRect": [0, 0, 32, 28],
                "destinationRect": [(index % 10) * 23, (index // 10) * 28, 32, 28],
                "destinationWidth": 800, "destinationHeight": 600, "result": 0,
            }
            for index in range(30)
        ]
        rows.append({
            "sourceWidth": 768, "sourceHeight": 336, "sourceFlags": 0x1000,
            "sourceRect": anchor["sourceRect"],
            "destinationRect": [*anchor["tileTopLeftXY"], 32, 28],
            "destinationWidth": 800, "destinationHeight": 600, "result": 0,
        })
        trace = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
        result = oracle.verify_native_blit_trace(trace, oracle.ROSTER[3], expected_anchor=anchor)
        self.assertEqual(result["status"], "native-negative-map-anchor-and-draw-stage-observed")
        self.assertTrue(result["nativeAnchorBlitObserved"])
        rows.append({
            "sourceWidth": 768, "sourceHeight": 336, "sourceFlags": 0x1000,
            "sourceRect": [anchor["sourceRect"][0], anchor["sourceRect"][1], 32, 20],
            "destinationRect": [*anchor["tileTopLeftXY"], 32, 20],
            "destinationWidth": 800, "destinationHeight": 600, "result": 0,
        })
        clipped_trace = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
        with self.assertRaisesRegex(oracle.OracleError, "final negative-map anchor draw is clipped"):
            oracle.verify_native_blit_trace(clipped_trace, oracle.ROSTER[3], expected_anchor=anchor)
        rows.pop()
        rows[-1]["sourceRect"] = [0, 0, 32, 28]
        wrong_face_trace = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
        with self.assertRaisesRegex(oracle.OracleError, "predeclared negative-map anchor"):
            oracle.verify_native_blit_trace(wrong_face_trace, oracle.ROSTER[3], expected_anchor=anchor)
        with self.assertRaisesRegex(oracle.OracleError, "predeclared visible source anchor"):
            oracle.verify_native_blit_trace(trace, oracle.ROSTER[3])

    def test_five_case_capture_plan_has_fixed_actions_and_no_adaptive_retries(self) -> None:
        audit = oracle.audit_roster()
        self.assertEqual(audit["nativeKeyInputAudit"]["status"], "fixed-key-input-reaches-native-scroll-branch")
        plan = audit["prospectiveCapturePlan"]
        self.assertEqual(len(plan), 5)
        self.assertEqual(sum(row["captureCount"] for row in plan), 5)
        self.assertEqual([row["fixedActions"] for row in plan], [
            ["Return", "Return", "KP_Down mapped to SDL_KP2 with NumLock clear"],
            ["Return", "Return"], ["Return", "Return"], ["Return", "Return"], ["Return", "Return"],
        ])
        self.assertEqual(sum(len(row["fixedActions"]) for row in plan), 11)
        self.assertTrue(all(row["nativeAnchor"] for row in plan))
        self.assertEqual(plan[3]["nativeAnchor"]["sourceRect"], [64, 0, 32, 28])
        self.assertEqual(plan[4]["nativeAnchor"]["sourceRect"], [160, 0, 32, 28])
        self.assertTrue(all(row["waitAfterLastActionMs"] == 1000 for row in plan))
        self.assertTrue(all(len(row["controllerArgv"]) == len(row["fixedActions"]) for row in plan))
        self.assertEqual(plan[0]["controllerArgv"][2], ["/usr/bin/xdotool", "key", "KP_Down"])
        self.assertIn("SDL_KP2 key event whose NumLock bit is clear", plan[0]["actionPurposes"][2])
        self.assertEqual(plan[0]["cameraPlan"]["cameraForCapture"], [0, 114])
        self.assertTrue(all(row["nativeArgv"][-4:] == ["--fullscreen", "0", "--sound", "0"] for row in plan))
        expected_plan_hash = oracle.sha256(
            json.dumps(plan, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
        self.assertEqual(audit["prospectiveCapturePlanSha256"], expected_plan_hash)

    def test_capture_entry_requires_exact_reviewed_plan_digest_before_startup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crimson-capture-release-fixture-") as directory:
            root = Path(directory)
            with self.assertRaisesRegex(oracle.OracleError, "parent-approved exact prospective plan digest"):
                oracle.run_metadata_case(
                    oracle.ROSTER[0], root / "capture-run-v1", root / "capture-run-v1.ledger.json",
                    1, capture=True, approved_plan_sha256="0" * 64,
                )
            self.assertFalse((root / "capture-run-v1").exists())

    def test_trace_barrier_refuses_missing_or_failed_post_capture_footer(self) -> None:
        complete = b'{"event":"trace-start","schema":1}\n{"event":"capture-barrier","complete":true}\n'
        result = oracle.verify_blit_trace_status(complete)
        self.assertEqual(result["status"], "native-trace-complete-through-capture-barrier")
        with self.assertRaisesRegex(oracle.OracleError, "post-capture barrier"):
            oracle.verify_blit_trace_status(b'{"event":"trace-start","schema":1}\n')
        failed = b'{"event":"trace-start","schema":1}\n{"event":"trace-error"}\n{"event":"capture-barrier","complete":false}\n'
        with self.assertRaisesRegex(oracle.OracleError, "one complete post-capture barrier"):
            oracle.verify_blit_trace_status(failed)


class X11ControllerEnvironmentTests(unittest.TestCase):
    def test_client_and_every_controller_probe_use_the_same_private_display(self) -> None:
        display = ":117"
        with patch.dict(os.environ, {"DISPLAY": ":host-display"}, clear=True):
            controller_env = oracle._controller_environment(display)
            self.assertEqual(controller_env, {
                "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                "DISPLAY": display,
            })
            self.assertEqual(oracle._display_binding(display), ["--setenv", "DISPLAY", display])
            fake = subprocess.CompletedProcess(
                ["xdotool", "search"], 0, stdout=b"123\n", stderr=b"fixture stderr",
            )
            diagnostics = []
            with patch.object(oracle.subprocess, "run", return_value=fake) as run:
                result = oracle._xdotool(display, ["search", "--onlyvisible", "--name", ".*"], diagnostics)
            self.assertIs(result, fake)
            self.assertEqual(run.call_args.kwargs["env"], controller_env)
            self.assertEqual(run.call_args.kwargs["env"]["DISPLAY"], display)
            self.assertEqual(diagnostics[0]["returncode"], 0)
            self.assertEqual(diagnostics[0]["stdout"], "123\n")
            self.assertEqual(diagnostics[0]["stderr"], "fixture stderr")

    def test_controller_rejects_non_numeric_display(self) -> None:
        with self.assertRaisesRegex(oracle.OracleError, "invalid dynamically allocated display"):
            oracle._controller_environment(":host")

    def test_same_type_owner_uniqueness_is_mandatory_for_positive(self) -> None:
        units = [
            {"type": "Artillery", "player": 1, "unitId": 97, "hex": [14, 23]},
            {"type": "Artillery", "player": 1, "unitId": 98, "hex": [13, 23]},
        ]
        matching = [row for row in units if row["type"] == "Artillery" and row["player"] == 1]
        exact = [row for row in matching if row["unitId"] == 97 and row["hex"] == [14, 23]]
        self.assertEqual(len(matching), 2)
        self.assertEqual(len(exact), 1)

    def test_receipt_writer_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crimson-oracle-fixture-") as directory:
            path = Path(directory) / "receipt.json"
            oracle._exclusive_json(path, {"pixelsRead": False, "screenshotCount": 0})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["pixelsRead"], False)
            with self.assertRaises(FileExistsError):
                oracle._exclusive_json(path, {"pixelsRead": True})

    def test_level_trace_requires_successful_open_and_nonempty_read(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crimson-trace-fixture-") as directory:
            root = Path(directory)
            trace = root / "strace.42"
            trace.write_text(
                'openat(AT_FDCWD, "/usr/share/games/crimson/levels/Anthill.lev", O_RDONLY) = 3</usr/share/games/crimson/levels/Anthill.lev>\n'
                'read(3</usr/share/games/crimson/levels/Anthill.lev>, "", 4096) = 8134\n',
                encoding="utf-8",
            )
            readback = oracle._read_target_level_trace(root, "/usr/share/games/crimson/levels/Anthill.lev", 42)
            self.assertEqual(readback["status"], "exact-level-opened-and-read")
            self.assertEqual(readback["nativePid"], 42)
            trace.write_text(
                'openat(AT_FDCWD, "/usr/share/games/crimson/levels/Anthill.lev", O_RDONLY) = 3</usr/share/games/crimson/levels/Anthill.lev>\n'
                'read(3</usr/share/games/crimson/levels/Anthill.lev>, "", 4096) = 0\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(oracle.OracleError, "open and read"):
                oracle._read_target_level_trace(root, "/usr/share/games/crimson/levels/Anthill.lev", 42)

    def test_level_trace_must_belong_to_exact_native_elf_pid(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crimson-trace-fixture-") as directory:
            trace = Path(directory) / "strace.42"
            trace.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(oracle.OracleError, "native ELF process syscall trace is missing"):
                oracle._read_target_level_trace(Path(directory), "/usr/share/games/crimson/levels/Anthill.lev", 43)


class MetadataRunPersistenceTests(unittest.TestCase):
    def test_fresh_run_journal_isolated_from_old_receipt_and_counts_only_new_actions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crimson-run-store-fixture-") as directory:
            base = Path(directory)
            old_run = base / "old-run"
            old_run.mkdir()
            old_receipt = old_run / "receipt.json"
            old_payload = json.dumps({"status": "failed", "startupInput": {"count": 1}}).encode()
            old_receipt.write_bytes(old_payload)
            old_digest = oracle.sha256(old_receipt.read_bytes())

            run_dir, ledger_path = oracle._metadata_run_paths(base, "metadata-run-v4")
            store = oracle.MetadataRunStore(run_dir, ledger_path, "crimson-anthill-p1", 4)
            self.assertEqual(store.action_count, 0)
            store.milestone("app-owned-window", {"display": ":117", "windowId": "123", "nativePid": 44})
            self.assertEqual(store.input_invoked("Return"), 1)
            store.milestone("native-level-read", {"nativePid": 44, "status": "exact-level-opened-and-read"})

            child = subprocess.Popen(["/usr/bin/sleep", "30"])
            child.terminate()
            child.wait(timeout=3)
            physically_closed = child.poll() is not None
            store.milestone("process-closure", {
                "clientExitStatus": child.returncode, "xvfbExitStatus": 0,
                "ownedProcessesClosed": physically_closed,
            })
            store.write_receipt({
                "status": "completed", "startupInput": {"count": store.action_count},
                "ownedProcessesClosed": physically_closed, "pixelsRead": False, "screenshotCount": 0,
            })
            store.close()

            saved_receipt = json.loads((run_dir / "receipt.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_receipt["startupInput"]["count"], 1)
            self.assertTrue(saved_receipt["ownedProcessesClosed"])
            events = [json.loads(line) for line in (run_dir / "milestones.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual([event["milestone"] for event in events], [
                "run-started", "app-owned-window", "input-invoked", "native-level-read", "process-closure",
            ])
            closure = events[-1]["details"]
            self.assertTrue(closure["ownedProcessesClosed"])
            self.assertEqual(ledger_path.parent, base)
            self.assertNotEqual(ledger_path, run_dir / "attempt-ledger.json")
            self.assertEqual(oracle.sha256(old_receipt.read_bytes()), old_digest)
            for path in (run_dir / "receipt.json", run_dir / "milestones.jsonl", ledger_path):
                self.assertNotIn(str(old_run.resolve()), path.read_text(encoding="utf-8"))

            no_action_dir, no_action_ledger = oracle._metadata_run_paths(base, "metadata-run-no-action")
            no_action = oracle.MetadataRunStore(no_action_dir, no_action_ledger, "crimson-anthill-p1", 5)
            self.assertEqual(no_action.action_count, 0)
            no_action.milestone("process-closure", {"ownedProcessesClosed": True})
            no_action.write_receipt({"startupInput": {"count": no_action.action_count}})
            no_action.close()
            self.assertEqual(json.loads((no_action_dir / "receipt.json").read_text())["startupInput"]["count"], 0)

    def test_metadata_run_id_cannot_escape_the_external_artifact_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crimson-run-path-fixture-") as directory:
            with self.assertRaisesRegex(oracle.OracleError, "bounded lowercase path component"):
                oracle._metadata_run_paths(Path(directory), "../old-run")


if __name__ == "__main__":
    unittest.main()
