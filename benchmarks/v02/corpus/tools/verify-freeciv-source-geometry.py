#!/usr/bin/env python3
"""Verify the pinned dev-only Freeciv renderer and saved-world map oracle."""

from __future__ import annotations

import csv
import hashlib
import json
import lzma
import re
import struct
import zlib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / "benchmarks/v02/corpus/dev-independent-map"
DEFAULT_EVIDENCE = ROOT / ".run/v02-freeciv-independent-map"
DEFAULT_RULESET = DEFAULT_EVIDENCE / "source/civ2civ3-units.ruleset"
BODY_FNV64 = "1eda0932a4a65377"
HEALTHBAR_FNV64 = "323b7936a09935f8"
EXPECTED_BOX = [709, 382, 749, 425]
EXPECTED_ORIGIN = {"x": 166, "y": 52, "width": 1111, "height": 708}


class VerificationError(RuntimeError):
    """Raised when a pinned corpus or evidence invariant fails."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_repo_path(value: str) -> Path:
    candidate = (ROOT / value).resolve()
    require(candidate == ROOT or ROOT in candidate.parents, f"path escapes repo: {value}")
    return candidate


def decode_png_digest(path: Path) -> tuple[int, int, str, bytes, int]:
    """Decode 8-bit non-interlaced RGB/RGBA PNG scanlines to check pixel uniqueness."""
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"not a PNG: {path}")
    offset = 8
    compressed = bytearray()
    width = height = bit_depth = color_type = interlace = -1
    while offset < len(data):
        require(offset + 12 <= len(data), f"truncated PNG chunk: {path}")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        stop = offset + 8 + length
        require(stop + 4 <= len(data), f"truncated PNG payload: {path}")
        payload = data[offset + 8 : stop]
        crc = struct.unpack(">I", data[stop : stop + 4])[0]
        require(zlib.crc32(kind + payload) & 0xFFFFFFFF == crc, f"bad PNG CRC: {path}")
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            require(compression == 0 and filtering == 0, f"unsupported PNG encoding: {path}")
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
        offset = stop + 4
    require(width > 0 and height > 0, f"missing PNG dimensions: {path}")
    require(bit_depth == 8 and color_type in (2, 6) and interlace == 0, f"unsupported PNG pixel format: {path}")
    bpp = 3 if color_type == 2 else 4
    row_bytes = width * bpp
    decoded = zlib.decompress(compressed)
    require(len(decoded) == height * (row_bytes + 1), f"unexpected PNG decoded size: {path}")

    def paeth(left: int, above: int, upper_left: int) -> int:
        estimate = left + above - upper_left
        dl, da, dul = abs(estimate - left), abs(estimate - above), abs(estimate - upper_left)
        return left if dl <= da and dl <= dul else above if da <= dul else upper_left

    previous = bytearray(row_bytes)
    pixels = hashlib.sha256()
    decoded_pixels = bytearray()
    for y in range(height):
        base = y * (row_bytes + 1)
        filter_type = decoded[base]
        encoded = decoded[base + 1 : base + 1 + row_bytes]
        row = bytearray(row_bytes)
        for x, value in enumerate(encoded):
            left = row[x - bpp] if x >= bpp else 0
            above = previous[x]
            upper_left = previous[x - bpp] if x >= bpp else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            elif filter_type == 4:
                predictor = paeth(left, above, upper_left)
            else:
                raise VerificationError(f"invalid PNG filter {filter_type}: {path}")
            row[x] = (value + predictor) & 0xFF
        pixels.update(row)
        decoded_pixels.extend(row)
        previous = row
    return width, height, pixels.hexdigest(), bytes(decoded_pixels), bpp


def alpha_bounds(path: Path, width: int, height: int, stride: int) -> list[int]:
    data = path.read_bytes()
    require(len(data) == stride * height, f"invalid raw surface length: {path}")
    points = [
        (x, y)
        for y in range(height)
        for x in range(width)
        if data[y * stride + x * 4 + 3] != 0
    ]
    require(bool(points), f"surface has no visible pixels: {path}")
    return [
        min(x for x, _ in points),
        min(y for _, y in points),
        max(x for x, _ in points) + 1,
        max(y for _, y in points) + 1,
    ]


def overlaps(a: list[int], b: list[int]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def parse_world_inventory(path: Path) -> dict[str, Any]:
    lines = path.read_text(encoding="utf-8").splitlines()
    nplayers = int(next(line.split("=", 1)[1] for line in lines if line.startswith("nplayers=")))
    turn = int(next(line.split("=", 1)[1] for line in lines if line.startswith("turn=")))
    year = int(next(line.split("=", 1)[1] for line in lines if line.startswith("year=")))
    ruleset = next(line.split("=", 1)[1].strip('"') for line in lines if line.startswith("rulesetdir="))
    save_players = next(line.split("=", 1)[1].strip() for line in lines if line.startswith("save_players="))
    units: list[str] = []
    player_counts: list[int] = []
    for index, line in enumerate(lines):
        if not re.fullmatch(r"\[player\d+\]", line):
            continue
        cursor = index + 1
        declared = None
        table_index = None
        while cursor < len(lines) and not lines[cursor].startswith("["):
            if lines[cursor].startswith("nunits="):
                declared = int(lines[cursor].split("=", 1)[1])
                table_index = next(
                    item for item in range(cursor + 1, len(lines)) if lines[item].startswith("u={")
                )
                break
            cursor += 1
        require(declared is not None and table_index is not None, f"incomplete units table after {line}")
        header = next(csv.reader([lines[table_index][3:-1]]))
        type_column = header.index("type_by_name")
        rows = lines[table_index + 1 : table_index + 1 + declared]
        require(len(rows) == declared, f"truncated unit rows for {line}")
        parsed = [next(csv.reader([row]))[type_column] for row in rows]
        require(len(parsed) == declared, f"unit count mismatch for {line}")
        units.extend(parsed)
        player_counts.append(declared)
    require(save_players == "TRUE", "saved world does not contain all player data")
    require(len(player_counts) == nplayers, f"declared {nplayers} players, parsed {len(player_counts)}")
    return {
        "turn": turn,
        "year": year,
        "rulesetdir": ruleset,
        "playerCount": nplayers,
        "playerUnitCounts": player_counts,
        "unitCount": len(units),
        "unitTypes": units,
    }


def ruleset_name(path: Path, section: str) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index(f"[{section}]")
    except ValueError as error:
        raise VerificationError(f"ruleset section not found: {section}") from error
    for line in lines[start + 1 :]:
        if line.startswith("["):
            break
        match = re.match(r'\s*name\s*=\s*_\("([^"]+)"\)', line)
        if match:
            return match.group(1)
    raise VerificationError(f"ruleset name not found: {section}")


def verify() -> dict[str, Any]:
    manifest = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
    inputs_path, truth_path, ledger_path = (
        DATA / "inputs.json",
        DATA / "ground-truth.json",
        DATA / "source-ledger.json",
    )
    inputs = json.loads(inputs_path.read_text(encoding="utf-8"))
    truth = json.loads(truth_path.read_text(encoding="utf-8"))
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    require(manifest["split"] == "dev", "only dev corpus is accepted by this verifier")
    require(manifest["inputsSha256"] == sha256(inputs_path), "input manifest hash mismatch")
    require(manifest["groundTruthSha256"] == sha256(truth_path), "ground truth hash mismatch")
    require(manifest["sourceLedgerSha256"] == sha256(ledger_path), "source ledger hash mismatch")
    require(manifest["cases"] == len(inputs) == len(truth) == len(ledger["captures"]), "case count mismatch")
    require(manifest["present"] == 7 and manifest["absent"] == 3, "expected 7 positives and 3 negatives")
    require(len({case["caseId"] for case in inputs}) == len(inputs), "duplicate input case ID")
    require(len({case["caseId"] for case in truth}) == len(truth), "duplicate truth case ID")
    require(all(set(case) == {"caseId", "image", "locate", "classify"} for case in inputs), "truth leaked into producer inputs")
    truth_by_id = {case["caseId"]: case for case in truth}
    capture_by_id = {case["caseId"]: case for case in ledger["captures"]}
    require(set(truth_by_id) == set(capture_by_id), "truth/source ledger IDs differ")
    require(sha256(DEFAULT_RULESET) == "5068a8b45472e42ccbf7812462e6431be44378e96087d37f6a3bcf6888026b08", "ruleset bytes changed")
    require(sha256(DEFAULT_EVIDENCE / "source/freeciv-data-copyright") == "a7595f514302728b9cf82de272a7f647cfa4049b254cacea9e2e30ee06dd5850", "license evidence changed")
    for name, expected in {
        "mapview.c": "706752d989d0a928b180262112fcc50d70344f1c3c0c28af742bfaf5be1e4c88",
        "canvas.c": "7f0812139ce778a0647f326e3e0867896e448794f4debbc95076358aed760a28",
        "mapview_common.c": "30f8a4d7073e51bfa3150aa82cb2641d6afea8cb24d679acccaada5c92ff619c",
        "assets/units.png": "d326676b3a69dc00845207ba3edcbdf141881777fb91f0410477c1ab2189159c",
        "assets/units.spec": "942fdb5391a4dd2315889f53bd45d9d1365fdacf8b4a1d7de67462271d344da7",
        "assets/hexemplio.tilespec": "e158fb3ddd50125efc323ab46b07cf6d45b8ca7d0876a14d9923652f1dad9b2f",
    }.items():
        require(sha256(DEFAULT_EVIDENCE / "source" / name) == expected, f"pinned upstream source/asset changed: {name}")

    image_hashes: set[str] = set()
    decoded_hashes: set[str] = set()
    result: dict[str, Any] = {"present": [], "absent": []}
    for input_case in inputs:
        case_id = input_case["caseId"]
        gt = truth_by_id[case_id]
        evidence = capture_by_id[case_id]
        image_path = resolve_repo_path(input_case["image"]["path"])
        require(sha256(image_path) == input_case["image"]["sha256"] == evidence["imageSha256"], f"image hash mismatch: {case_id}")
        width, height, decoded_hash, _, _ = decode_png_digest(image_path)
        require([width, height] == [input_case["image"]["width"], input_case["image"]["height"]] == [1280, 800], f"image dimensions mismatch: {case_id}")
        require(sha256(image_path) not in image_hashes, f"duplicate image bytes: {case_id}")
        require(decoded_hash not in decoded_hashes, f"duplicate decoded image pixels: {case_id}")
        image_hashes.add(sha256(image_path))
        decoded_hashes.add(decoded_hash)
        capture_evidence = resolve_repo_path(evidence["captureEvidencePath"])
        trace_path = resolve_repo_path(evidence["drawTracePath"])
        atspi_path = resolve_repo_path(evidence["accessibilityTreePath"])
        require(sha256(capture_evidence) == evidence["captureEvidenceSha256"], f"capture evidence hash mismatch: {case_id}")
        require(sha256(trace_path) == evidence["drawTraceSha256"], f"draw trace hash mismatch: {case_id}")
        require(sha256(atspi_path) == evidence["accessibilityTreeSha256"], f"AT-SPI hash mismatch: {case_id}")
        run_record = json.loads(capture_evidence.read_text(encoding="utf-8"))
        require(run_record["captureSha256"] == sha256(image_path), f"capture record image mismatch: {case_id}")
        require(run_record["drawTraceSha256"] == sha256(trace_path), f"capture record trace mismatch: {case_id}")
        require(run_record["atspiSha256"] == sha256(atspi_path), f"capture record AT-SPI mismatch: {case_id}")
        require(run_record["shimSourceSha256"] == sha256(capture_evidence.parent / "trace-cairo.c"), f"shim source hash mismatch: {case_id}")
        require(run_record["driverSha256"] == sha256(capture_evidence.parent / "driver.py"), f"driver hash mismatch: {case_id}")
        atspi = json.loads(atspi_path.read_text(encoding="utf-8"))
        if gt["expectedPresence"] == "present":
            require(gt["targetClassId"] == "explorer-unit-body", f"unexpected positive target: {case_id}")
            require(len(gt["targetBoxes"]) == 1, f"positive target box missing: {case_id}")
            body = gt["targetBoxes"][0]["pixelXYXY"]
            require(body == EXPECTED_BOX, f"positive target box mismatch: {case_id}")
            require(gt["targetBoxes"][0]["xyxy"] == [709 / width, 382 / height, 749 / width, 425 / height], f"normalized box mismatch: {case_id}")
            require(any(node.get("name") == "Explorer" for node in atspi["nodes"]), f"Explorer selection not in AT-SPI tree: {case_id}")
            origins = [node["bounds"] for node in atspi["nodes"] if node.get("role") == "drawing area" and node.get("showing") and node.get("bounds") == EXPECTED_ORIGIN]
            require(len(origins) == 1, f"map drawing-area origin missing: {case_id}")
            records = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()]
            body_rows = [index for index, row in enumerate(records) if row.get("surfaceHashFnv64") == BODY_FNV64 and row.get("target") == [1134, 768]]
            require(bool(body_rows), f"Explorer sprite draw missing: {case_id}")
            body_index = body_rows[-1]
            body_record = records[body_index]
            overlay_record = records[body_index + 1]
            require(body_record["seq"] == evidence["rendererBodySequence"], f"body draw sequence mismatch: {case_id}")
            require(body_record["source"] == [64, 48] and body_record["sourceAt"] == [527.0, 328.0] and body_record["rect"] == [527.0, 328.0, 64.0, 48.0], f"body draw geometry mismatch: {case_id}")
            require(body_record["clipUser"] == [0, 0, 1134, 768] and body_record["ctm"] == [1, 0, 0, 1, 0, 0], f"body clip/transform mismatch: {case_id}")
            sprite_path = resolve_repo_path(evidence["sourceSurfacePath"])
            hp_path = resolve_repo_path(evidence["healthBarSurfacePath"])
            require(sha256(sprite_path) == evidence["sourceSurfaceSha256"], f"sprite surface hash mismatch: {case_id}")
            require(sha256(hp_path) == evidence["healthBarSurfaceSha256"], f"health-bar surface hash mismatch: {case_id}")
            sprite_bytes = sprite_path.read_bytes()
            sprite_alpha = alpha_bounds(sprite_path, 64, 48, 256)
            hp_alpha = alpha_bounds(hp_path, 126, 82, 504)
            require(sprite_alpha == [16, 2, 56, 45], f"sprite alpha support mismatch: {case_id}")
            asset_path = DEFAULT_EVIDENCE / "source/assets/units.png"
            asset_w, asset_h, _, asset_pixels, asset_bpp = decode_png_digest(asset_path)
            require(asset_bpp == 4 and asset_w >= 910 and asset_h >= 98, "official unit atlas dimensions/alpha format changed")
            atlas_alpha = [asset_pixels[(y + 50) * asset_w * asset_bpp + (x + 846) * asset_bpp + 3] for y in range(48) for x in range(64)]
            sprite_alpha_bytes = [sprite_bytes[y * 256 + x * 4 + 3] for y in range(48) for x in range(64)]
            require(atlas_alpha == sprite_alpha_bytes, f"rendered sprite alpha differs from official Explorer atlas crop: {case_id}")
            spec = (DEFAULT_EVIDENCE / "source/assets/units.spec").read_text(encoding="utf-8")
            require('1, 13, "u.explorer"' in spec, "official atlas spec no longer identifies Explorer at row 1, column 13")
            require(overlay_record.get("surfaceHashFnv64") == HEALTHBAR_FNV64 and overlay_record["seq"] == evidence["rendererHealthbarSequence"], f"later draw is not recorded health bar: {case_id}")
            require(overlay_record["sourceAt"] == [493.0, 290.0] and overlay_record["ctm"] == [1, 0, 0, 1, 0, 0], f"health-bar draw geometry mismatch: {case_id}")
            hp_store_box = [493 + hp_alpha[0], 290 + hp_alpha[1], 493 + hp_alpha[2], 290 + hp_alpha[3]]
            sprite_store_box = [527 + sprite_alpha[0], 328 + sprite_alpha[1], 527 + sprite_alpha[2], 328 + sprite_alpha[3]]
            require(hp_alpha == [45, 32, 74, 39] and not overlaps(hp_store_box, sprite_store_box), f"health bar occludes body: {case_id}")
            require([166 + sprite_store_box[0], 52 + sprite_store_box[1], 166 + sprite_store_box[2], 52 + sprite_store_box[3]] == EXPECTED_BOX, f"source-to-screen transform mismatch: {case_id}")
            result["present"].append(case_id)
        else:
            require(gt["expectedPresence"] == "absent" and not gt["targetBoxes"], f"invalid negative truth: {case_id}")
            state_path = resolve_repo_path(evidence["savedWorldPath"])
            compressed_path = resolve_repo_path(evidence["compressedSavedWorldPath"])
            require(sha256(state_path) == evidence["savedWorldSha256"], f"saved world hash mismatch: {case_id}")
            require(sha256(compressed_path) == evidence["compressedSavedWorldSha256"], f"compressed saved world hash mismatch: {case_id}")
            require(lzma.decompress(compressed_path.read_bytes()) == state_path.read_bytes(), f"saved-world compression mismatch: {case_id}")
            inventory = parse_world_inventory(state_path)
            recorded = evidence["worldInventory"]
            require(run_record["savegameSha256"] == sha256(state_path), f"capture evidence saved-world hash mismatch: {case_id}")
            require(run_record["savegameCompressedSha256"] == sha256(compressed_path), f"capture evidence compressed save hash mismatch: {case_id}")
            require(sorted(set(inventory["unitTypes"])) == evidence["unitTypesPresent"], f"complete unit type list mismatch: {case_id}")
            for key in ("turn", "year", "rulesetdir", "playerCount", "playerUnitCounts", "unitCount"):
                require(inventory[key] == recorded[key], f"inventory ledger mismatch for {key}: {case_id}")
            require(inventory["turn"] == 1 and inventory["year"] == -4000 and inventory["rulesetdir"] == "civ2civ3", f"unexpected saved world: {case_id}")
            require(inventory["playerCount"] == 6 and inventory["playerUnitCounts"] == [4] * 6 and inventory["unitCount"] == 24, f"incomplete world inventory: {case_id}")
            target = gt["targetClassId"].removeprefix("freeciv-unit-")
            target_name = {"bomber": "Bomber", "battleship": "Battleship", "fighter": "Fighter"}.get(target)
            require(target_name is not None, f"unknown absent target type: {case_id}")
            require(target_name not in inventory["unitTypes"], f"target type present in full world: {case_id}")
            require(ruleset_name(DEFAULT_RULESET, f"unit_{target}") == target_name, f"ruleset type mapping mismatch: {case_id}")
            require(evidence["absentTargetType"] == target_name, f"absence evidence target mismatch: {case_id}")
            result["absent"].append(case_id)

    require(len(result["present"]) == 7 and len(result["absent"]) == 3, "verified corpus counts differ")
    require(len(decoded_hashes) == 10, "some cases reuse decoded pixels")
    return {"result": "PASS", "cases": len(inputs), "present": result["present"], "absent": result["absent"], "distinctDecodedImages": len(decoded_hashes), "heldoutRead": False}


def main() -> int:
    print(json.dumps(verify(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
