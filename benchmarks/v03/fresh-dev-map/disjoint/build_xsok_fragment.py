#!/usr/bin/env python3
"""Export the preregistered XSok frames to a fresh external fragment directory."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

from fragment_tools import parse_export_args, select_predeclared_cell_box, study_input, write_immutable_json


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def readjson(path: Path):
    return json.loads(path.read_text())


def main() -> None:
    study, output, repo = parse_export_args(
        "Export the frozen XSok native frames into a new external fragment directory", __file__
    )
    sys.path.insert(0, str(repo / "benchmarks/v03/fresh-dev"))
    import imaging

    roster_path = study_input(study, "maps/pre-capture-v4/roster.json")
    proof_path = study_input(study, "maps/xsok/source-render-proof-v1.json")
    inherited_path = study_input(study, "inherited-dev-frame-fingerprints.json")
    roster = readjson(roster_path)
    proof = readjson(proof_path)
    inherited = readjson(inherited_path)
    assert sha(study_input(study, "parent-registration.json").read_bytes()) == "5c63045a648928c9aefe12aad99464e8394b3bc42c133b39821036eb74f3bff0"
    proofs = {item["opaqueCaseId"]: item for item in proof["cases"]}
    cases = [case for case in roster["cases"] if case["familySlug"] == "xsok"]
    rows = []
    annotations = []
    paths = {}
    provenance = {}
    frames = []

    for case in cases:
        case_id = case["opaqueCaseId"]
        frame_path = study_input(study, f"maps/xsok/frames/{case_id}.png")
        raw = frame_path.read_bytes()
        with Image.open(frame_path) as image:
            rgb = image.convert("RGB")
            width, height = rgb.size
            pixels = rgb.tobytes()
        encoded_sha = sha(raw)
        rgb_sha = sha(pixels)
        perceptual_hash = imaging.perceptual_hash64_from_rgb(pixels, width, height)
        references = [
            (f"inherited:{item['id']}", item["perceptualHash"], item["encodedSha256"], item["decodedRgbSha256"])
            for item in inherited["frames"]
        ]
        for peer in frames:
            references.append((f"peer:{peer['id']}", peer["perceptualHash"], peer["encodedSha256"], peer["decodedRgbSha256"]))
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
        frames.append(frame)
        rows.append({
            "opaqueCaseId": case_id,
            "sourceBytesSha256": encoded_sha,
            "sourceCanvasWidth": width,
            "sourceCanvasHeight": height,
            "targetTaskText": case["targetTaskText"],
        })

        proof_case = proofs[case_id]
        boxes = select_predeclared_cell_box(
            case["targetCellXY"], proof_case["targetPixelProofs"], box_width=32, box_height=32
        )
        positive = case["expectedLabel"] == "positive"
        if positive and len(boxes) != 1:
            raise ValueError(f"{case_id}: expected the single predeclared target box, got {boxes}")
        if not positive and boxes:
            raise ValueError(f"{case_id}: absent case unexpectedly has a reference box")
        source_oracle = {
            "sourceLevelPath": case["source"]["levelPath"],
            "sourceLevelSha256": case["source"]["levelSha256"],
            "completeVisibleClassInventory": case["completeVisibleClassInventory"],
            "targetId": case["targetId"],
            "targetCellXY": case["targetCellXY"],
            "targetCount": case["targetCount"],
            "nativeSpriteIndex": 9,
            "nativeSpriteCanvas": [32, 32],
            "visibleSpritePixelCount": 1000,
            "transparentSpritePixelCount": 24,
            "viewportComplete": True,
        }
        annotations.append({
            "opaqueCaseId": case_id,
            "stratum": "map",
            "sourceGroup": "game:xsok",
            "expectedPresence": "present" if positive else "absent",
            "referenceBoxes": boxes,
            "referenceMasks": [],
            "exactOriginalCanvasMaskRef": False,
        })
        paths[case_id] = str(frame_path)
        provenance[case_id] = {
            "familySlug": "xsok",
            "predeclaredStateId": case["stateId"],
            "sourceGroup": "game:xsok",
            "registrationSha256": roster["parentRegistrationSha256"],
            "sourceLevelSet": "Xsok",
            "sourceLevel": case["source"]["level"],
            "sourceLevelSha256": case["source"]["levelSha256"],
            "definitionSha256": case["source"]["levelDefinitionSha256"],
            "nativeCellPixels": case["source"]["nativeCellPixels"],
            "levelAuthor": case["source"]["levelAuthor"],
            "rights": case["rights"],
            "packageDebSha256": "bfb50557cc607ded7a87187f933f25a38e67918507f9f08d40ea8c3ae1d80113",
            "sourceArchiveSha256": "e3c87fb81ed32285c18d22665ee2752c8fdb1332cacb723fea8813affb289f38",
            "captureProof": {
                "path": str(proof_path),
                "sha256": sha(proof_path.read_bytes()),
                "caseFrameEncodedSha256": encoded_sha,
                "caseFrameRgbSha256": rgb_sha,
                "targetTaskText": case["targetTaskText"],
            },
            "privateSourceOracle": source_oracle,
        }

    files = {
        "producer-input-rows.json": rows,
        "evaluator-private-annotations.json": annotations,
        "controller-path-index.json": paths,
        "curator-source-provenance.json": provenance,
        "frame-fingerprints.json": {
            "algorithm": inherited["algorithm"],
            "inheritedFingerprintsSha256": sha(inherited_path.read_bytes()),
            "cutoffInclusiveHamming": 4,
            "frames": frames,
        },
    }
    for filename, value in files.items():
        write_immutable_json(output, filename, value)
    file_hashes = {name: sha((output / name).read_bytes()) for name in files if name != "frame-fingerprints.json"}
    receipt = {
        "schema": "private-dev-source-fragment-v1",
        "notPhaseFreeze": True,
        "modelCalls": 0,
        "caseCount": 5,
        "positiveCases": 4,
        "negativeCases": 1,
        "maskCount": 0,
        "sourceGroupCounts": {"map": 1},
        "familySlug": "xsok",
        "rosterSha256": sha(roster_path.read_bytes()),
        "sourcePreflightSha256": sha(study_input(study, "maps/pre-capture-v4/source-preflight.json").read_bytes()),
        "renderProofSha256": sha(proof_path.read_bytes()),
        "duplicateAuditSha256": sha((output / "frame-fingerprints.json").read_bytes()),
        "sha256": file_hashes,
    }
    write_immutable_json(output, "fragment-receipt.json", receipt)
    print(json.dumps({"path": str(output), "receipt": receipt}, indent=2))


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
