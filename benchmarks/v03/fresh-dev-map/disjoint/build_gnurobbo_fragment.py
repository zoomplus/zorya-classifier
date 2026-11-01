#!/usr/bin/env python3
"""Export the approved GNU Robbo frames to a fresh external fragment directory."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

from fragment_tools import parse_export_args, study_input, write_immutable_json

ROSTER_SHA256 = "36470ef2a6fa48e534f3c393d72acac446896638cf50971c21bb60e68587cd10"
PREFLIGHT_SHA256 = "a0837a9412c156ef448769cba3d9800d9c001f6d1a37bbd80dd4104c6eb0385e"
ORDER_SHA256 = "e0a5079820961fa1ece2aa8931d5f229a0706dd35f08c202036de8e718e7b479"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def readjson(path: Path):
    return json.loads(path.read_text())


def main() -> None:
    study, output, repo = parse_export_args(
        "Export the frozen GNU Robbo native frames into a new external fragment directory", __file__
    )
    sys.path.insert(0, str(repo / "benchmarks/v03/fresh-dev"))
    import imaging

    roster_path = study_input(study, "maps/pre-capture-v5-gnurobbo-proposed/roster.json")
    preflight_path = study_input(study, "maps/pre-capture-v5-gnurobbo-proposed/source-preflight.json")
    registration_path = study_input(study, "parent-registration.json")
    inherited_path = study_input(study, "inherited-dev-frame-fingerprints.json")
    xsok_path = study_input(study, "maps/xsok/canonical-fragment-v2/frame-fingerprints.json")
    audit_path = study_input(study, "integration/real-gnurobbo-five-pixel-audit.json")
    calibration_path = study_input(study, "integration/sdl-calibration/calibrated-channel-map.json")
    roster = readjson(roster_path)
    preflight = readjson(preflight_path)
    audit = readjson(audit_path)
    inherited = readjson(inherited_path)
    xsok = readjson(xsok_path)
    assert sha(roster_path.read_bytes()) == ROSTER_SHA256
    assert sha(preflight_path.read_bytes()) == PREFLIGHT_SHA256
    assert preflight["rosterSha256"] == ROSTER_SHA256
    assert sha(registration_path.read_bytes()) == "5c63045a648928c9aefe12aad99464e8394b3bc42c133b39821036eb74f3bff0"
    assert roster["sourcePackSha256"] == "6250d1b247d4c55acaba74cc0ef7b092234bec91b87721ba7eab2f001c6f70ca"
    assert roster["selectionProtocol"].startswith("SHA256 UTF-8 NUL-joined")
    assert sha(audit_path.read_bytes()) == "506a81a1fba04994b68835acf38c8f40376b5cb6f54500b6aae6b87a8e9c1ec3"
    assert sha(calibration_path.read_bytes()) == audit["framebufferCalibration"]
    assert audit["nativeColorSupportPixels"] == 112
    assert audit["viewport"] == [272, 52, 256, 496]
    assert roster["sourceSelectionSeed"] == "h8a-independent-dev40-20261101-r1"
    assert len(roster["cases"]) == 5

    main_cases = {item["id"]: item for item in audit["cases"]}
    inherited_frames = inherited["frames"]
    other_family_frames = xsok["frames"]
    rows = []
    annotations = []
    paths = {}
    provenance = {}
    frame_fingerprints = []
    maps = study / "maps"

    for case in roster["cases"]:
        case_id = case["opaqueCaseId"]
        source = case["source"]
        render_rules = case["renderRules"]
        audit_case = main_cases[case_id]
        frame_path = study_input(study, f"maps/gnurobbo/frames/{case_id}.png")
        raw = frame_path.read_bytes()
        encoded_sha = sha(raw)
        assert encoded_sha == audit_case["frameSha256"]
        assert source["level"] == audit_case["level"]
        assert source["levelPackSha256"] == roster["sourcePackSha256"]
        receipt_path = study_input(study, f"maps/capture-logs/gnurobbo-level-{source['level']:02d}-candidate-attempt3-receipt.json")
        capture = readjson(receipt_path)
        assert capture["opaqueCaseId"] == case_id
        assert capture["expectedLevelFromPrivateRC"] == source["level"]
        assert capture["encodedSha256"] == encoded_sha
        assert capture["windowGeometry"] == [800, 600]
        assert capture["packageBinarySha256"] == "f93171aadb37127e5e3642aaedf149d7b977f5f1c5d273869ac1152c90278ca6"

        with Image.open(frame_path) as image:
            rgb_image = image.convert("RGB")
            width, height = rgb_image.size
            pixels = rgb_image.tobytes()
        assert (width, height) == (800, 600)
        rgb_sha = sha(pixels)
        perceptual_hash = imaging.perceptual_hash64_from_rgb(pixels, width, height)
        references = []
        references.extend((f"inherited:{item['id']}", item["perceptualHash"], item["encodedSha256"], item["decodedRgbSha256"]) for item in inherited_frames)
        references.extend((f"xsok:{item['id']}", item["perceptualHash"], item["encodedSha256"], item["decodedRgbSha256"]) for item in other_family_frames)
        references.extend((f"peer:{prior['id']}", prior["perceptualHash"], prior["encodedSha256"], prior["decodedRgbSha256"]) for prior in frame_fingerprints)
        exact_encoded = [name for name, _, old_encoded, _ in references if encoded_sha == old_encoded]
        exact_rgb = [name for name, _, _, old_rgb in references if rgb_sha == old_rgb]
        distances = [(imaging.hamming_distance64(perceptual_hash, int(old_hash, 16)), name) for name, old_hash, _, _ in references]
        nearest = min(distances)
        if exact_encoded or exact_rgb or nearest[0] <= 4:
            raise ValueError(f"duplicate/near duplicate for {case_id}: encoded={exact_encoded}, rgb={exact_rgb}, nearest={nearest}")

        frame = {
            "id": case_id,
            "encodedSha256": encoded_sha,
            "decodedRgbSha256": rgb_sha,
            "perceptualHash": f"{perceptual_hash:016x}",
            "width": width,
            "height": height,
        }
        frame_fingerprints.append(frame)
        rows.append({
            "opaqueCaseId": case_id,
            "sourceBytesSha256": encoded_sha,
            "sourceCanvasWidth": width,
            "sourceCanvasHeight": height,
            "targetTaskText": case["targetTaskText"],
        })

        positive = case["expectedLabel"] == "positive"
        key_cells = audit_case["nativeKeyCells"]
        expected_cells = case["completeVisibleClassInventory"]
        assert key_cells == expected_cells
        assert len(expected_cells) == (1 if positive else 0)
        box = audit_case["box"]
        if positive:
            assert box is not None and box["width"] == 10 and box["height"] == 14
            assert case["targetCellXY"] == expected_cells[0]
            reference_boxes = [box]
        else:
            assert box is None and case["targetCellXY"] is None and case["targetId"] is None
            reference_boxes = []

        annotations.append({
            "opaqueCaseId": case_id,
            "stratum": "map",
            "sourceGroup": "game:gnurobbo",
            "expectedPresence": "present" if positive else "absent",
            "referenceBoxes": reference_boxes,
            "referenceMasks": [],
            "exactOriginalCanvasMaskRef": False,
        })
        paths[case_id] = str(frame_path)

        source_oracle = {
            "sourceLevelPath": source["levelPackPath"],
            "sourceLevelSet": source["levelSet"],
            "sourceLevel": source["level"],
            "sourceLevelSha256": source["levelRecordSha256"],
            "completeVisibleClassInventory": expected_cells,
            "targetId": case["targetId"],
            "targetCellXY": case["targetCellXY"],
            "targetCount": case["targetCount"],
            "nativeSpriteCanvas": [16, 16],
            "nativeVisibleSpriteBoundsInclusive": [3, 1, 12, 14],
            "nativeSpriteVisiblePixelCount": 112,
            "viewportComplete": True,
            "nativeFrameAuditSha256": sha(audit_path.read_bytes()),
        }
        provenance[case_id] = {
            "familySlug": "gnurobbo",
            "predeclaredStateId": case["stateId"],
            "sourceGroup": "game:gnurobbo",
            "registrationSha256": roster["parentRegistrationSha256"],
            "sourceLevelSet": "RobboI",
            "sourcePackPath": source["levelPackPath"],
            "sourcePackSha256": source["levelPackSha256"],
            "sourceLevel": source["level"],
            "sourceLevelRecordSha256": source["levelRecordSha256"],
            "sourceGridSha256": source["sourceGridSha256"],
            "levelAuthor": source["levelAuthor"],
            "rights": case["rights"],
            "packageDebSha256": "dda682bf4c3e5b38919bd1c3170162f9d009f79d4ec908ae77f38260df176dbe",
            "copyrightNoticePath": roster["sourceRights"]["copyrightNoticePath"],
            "copyrightNoticeSha256": roster["sourceRights"]["copyrightNoticeSha256"],
            "privateSourceOracle": source_oracle,
            "renderer": {
                "sourcePackToEngineEnum": "levels.c transform_char: % -> KEY",
                "engineEnumToSprite": "board.c set_images: KEY -> gcoord(8), gcoord(1), 16x16",
                "spriteAtlasPath": render_rules["spriteAtlas"],
                "spriteAtlasSha256": render_rules["spriteAtlasSha256"],
                "drawSourcePath": render_rules["drawSourcePath"],
                "drawSourceSha256": render_rules["drawSourceSha256"],
                "framebufferCalibrationPath": str(calibration_path),
                "framebufferCalibrationSha256": sha(calibration_path.read_bytes()),
                "independentFrameAuditPath": str(audit_path),
                "independentFrameAuditSha256": sha(audit_path.read_bytes()),
            },
            "capture": {
                "path": str(frame_path),
                "encodedSha256": encoded_sha,
                "decodedRgbSha256": rgb_sha,
                "captureReceiptPath": str(receipt_path),
                "captureReceiptSha256": sha(receipt_path.read_bytes()),
                "stockBinarySha256": capture["packageBinarySha256"],
                "argv": capture["argv"][-4:],
                "windowGeometry": capture["windowGeometry"],
                "uidGidInsideSandbox": capture["uidGidInsideSandbox"],
                "isolatedNetwork": capture["isolatedNetwork"],
                "targetTaskText": case["targetTaskText"],
            },
        }

    all_compare = inherited_frames + other_family_frames + frame_fingerprints
    nearest_refs = {}
    for frame in frame_fingerprints:
        candidates = [item for item in all_compare if item["id"] != frame["id"]]
        ranked = sorted((imaging.hamming_distance64(int(frame["perceptualHash"], 16), int(item["perceptualHash"], 16)), item["id"]) for item in candidates)
        nearest_refs[frame["id"]] = {"hamming": ranked[0][0], "referenceId": ranked[0][1]}

    files = {
        "producer-input-rows.json": rows,
        "evaluator-private-annotations.json": annotations,
        "controller-path-index.json": paths,
        "curator-source-provenance.json": provenance,
        "frame-fingerprints.json": {
            "algorithm": inherited["algorithm"],
            "inheritedFingerprintsSha256": sha(inherited_path.read_bytes()),
            "cutoffInclusiveHamming": 4,
            "frames": frame_fingerprints,
            "nearestReferenceDistances": nearest_refs,
        },
    }
    for filename, value in files.items():
        write_immutable_json(output, filename, value)
    hashes = {name: sha((output / name).read_bytes()) for name in files if name != "frame-fingerprints.json"}
    receipt = {
        "schema": "private-dev-source-fragment-v1",
        "notPhaseFreeze": True,
        "modelCalls": 0,
        "caseCount": 5,
        "positiveCases": 3,
        "negativeCases": 2,
        "maskCount": 0,
        "sourceGroupCounts": {"map": 1},
        "familySlug": "gnurobbo",
        "rosterSha256": sha(roster_path.read_bytes()),
        "sourcePreflightSha256": sha(preflight_path.read_bytes()),
        "registeredOrderSha256": ORDER_SHA256,
        "renderProofSha256": sha(audit_path.read_bytes()),
        "framebufferCalibrationSha256": sha(calibration_path.read_bytes()),
        "duplicateAuditSha256": sha((output / "frame-fingerprints.json").read_bytes()),
        "sha256": hashes,
    }
    write_immutable_json(output, "fragment-receipt.json", receipt)
    print(json.dumps({"path": str(output), "receipt": receipt, "nearestReferenceDistances": nearest_refs}, indent=2))


if __name__ == "__main__":
    main()
