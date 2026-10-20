#!/usr/bin/env python3
"""Verify the local, ignored OpenTTD renderer-oracle holdout corpus.

This offline verifier reads no candidate outputs and makes no network requests.
The pixel boxes are regenerated from the pinned OpenGFX palette-key support and
OpenTTD's complete DrawSpriteViewport trace, including later-draw occlusion.
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
import zlib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[4]
BASE = ROOT / ".run/v02-heldout-openttd-independent-v1"
DATA = BASE / "frozen-v1"
TRANSPARENT_RGB = (0, 0, 255)
MAP_CLIP = (0, 24, 640, 468)
TREE_SPRITES = range(1576, 2004)
MIN_VISIBLE_PIXELS = 32
MIN_BOX_SIDE = 4
NEGATIVE_TYPES = {"train", "bus", "truck", "ship", "aircraft"}


class VerificationError(RuntimeError):
    """Raised when an input, trace, source asset, or annotation is inconsistent."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_repo_path(value: str) -> Path:
    candidate = (ROOT / value).resolve()
    require(candidate == ROOT or ROOT in candidate.parents, f"path escapes repository: {value}")
    return candidate


def png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"not a PNG: {path}")
    require(data[12:16] == b"IHDR", f"missing IHDR: {path}")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def decode_palette_png(path: Path) -> tuple[int, int, list[bytes], list[tuple[int, int, int]], list[int]]:
    """Decode an 8-bit indexed PNG using only the Python standard library."""
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"not a PNG: {path}")
    offset = 8
    compressed = bytearray()
    width = height = bit_depth = color_type = interlace = -1
    palette_bytes: bytes | None = None
    transparency: bytes | None = None
    while offset < len(data):
        require(offset + 12 <= len(data), f"truncated PNG chunk: {path}")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        end = offset + 8 + length
        require(end + 4 <= len(data), f"truncated PNG payload: {path}")
        payload = data[offset + 8 : end]
        crc = struct.unpack(">I", data[end : end + 4])[0]
        require(zlib.crc32(kind + payload) & 0xFFFFFFFF == crc, f"bad PNG CRC: {path}")
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            require(compression == 0 and filtering == 0, f"unsupported PNG compression/filter: {path}")
        elif kind == b"PLTE":
            palette_bytes = payload
        elif kind == b"tRNS":
            transparency = payload
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
        offset = end + 4
    require(bit_depth == 8 and color_type == 3 and interlace == 0, f"expected indexed 8-bit PNG: {path}")
    require(palette_bytes is not None and len(palette_bytes) % 3 == 0, f"missing palette: {path}")
    palette = [tuple(palette_bytes[i : i + 3]) for i in range(0, len(palette_bytes), 3)]
    alpha = list(transparency) if transparency is not None else [255] * len(palette)
    alpha.extend([255] * (len(palette) - len(alpha)))
    row_bytes = width
    raw = zlib.decompress(compressed)
    require(len(raw) == height * (row_bytes + 1), f"unexpected decoded size: {path}")

    def paeth(left: int, above: int, upper_left: int) -> int:
        estimate = left + above - upper_left
        dl = abs(estimate - left)
        da = abs(estimate - above)
        dul = abs(estimate - upper_left)
        return left if dl <= da and dl <= dul else above if da <= dul else upper_left

    rows: list[bytes] = []
    previous = bytearray(row_bytes)
    for y in range(height):
        base = y * (row_bytes + 1)
        filter_type = raw[base]
        encoded = raw[base + 1 : base + 1 + row_bytes]
        row = bytearray(row_bytes)
        for x, value in enumerate(encoded):
            left = row[x - 1] if x else 0
            above = previous[x]
            upper_left = previous[x - 1] if x else 0
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
        rows.append(bytes(row))
        previous = row
    return width, height, rows, palette, alpha


def source_sprite_masks(atlas_dir: Path, nfo_path: Path) -> dict[int, set[tuple[int, int]]]:
    atlases = {
        name: decode_palette_png(atlas_dir / name)
        for name in ("ogfx1_base00.png", "ogfx1_base01.png")
    }
    metadata: dict[int, dict[str, Any]] = {}
    for line in nfo_path.read_text(encoding="latin1").splitlines():
        fields = line.split()
        if len(fields) < 10 or not fields[0].isdigit() or Path(fields[1]).name not in atlases:
            continue
        metadata[int(fields[0])] = {
            "file": Path(fields[1]).name,
            "x": int(fields[3]),
            "y": int(fields[4]),
            "width": int(fields[5]),
            "height": int(fields[6]),
            "xoff": int(fields[7]),
            "yoff": int(fields[8]),
        }
    masks: dict[int, set[tuple[int, int]]] = {}
    for sprite_id, item in metadata.items():
        width, height, rows, palette, alpha = atlases[item["file"]]
        points: set[tuple[int, int]] = set()
        for y in range(item["height"]):
            require(item["y"] + y < height, f"sprite {sprite_id} exceeds source atlas height")
            for x in range(item["width"]):
                require(item["x"] + x < width, f"sprite {sprite_id} exceeds source atlas width")
                palette_id = rows[item["y"] + y][item["x"] + x]
                rgb = palette[palette_id]
                if alpha[palette_id] != 0 and rgb != TRANSPARENT_RGB:
                    points.add((x + item["xoff"], y + item["yoff"]))
        if points:
            masks[sprite_id] = points
    return masks


def parse_trace(path: Path) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    viewport_pattern = re.compile(
        r"VP (-?\d+) (-?\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) "
        r"COUNT (\d+) FIRST (\d+) VT (0x[0-9a-f]+)"
    )
    sprite_pattern = re.compile(
        r"S (\d+) (\d+) (-?\d+) (-?\d+) SCREEN (-?\d+) (-?\d+) "
        r"VIEWPORT (\d+) (\d+) (-?\d+) (-?\d+) (\d+) SUB (\S+)"
    )
    for line in path.read_text(errors="replace").splitlines():
        match = viewport_pattern.match(line)
        if match:
            if current is not None:
                groups.append(current)
            left, top, width, height, virtual_left, virtual_top, zoom, count, first_unused = map(
                int, match.groups()[:9]
            )
            current = {
                "viewport": {
                    "left": left,
                    "top": top,
                    "width": width,
                    "height": height,
                    "virtualLeft": virtual_left,
                    "virtualTop": virtual_top,
                    "zoom": zoom,
                },
                "vehiclePoolCount": count,
                "vehiclePoolFirstUnused": first_unused,
                "vehiclePoolVtable": match.group(10),
                "calls": [],
            }
            continue
        match = sprite_pattern.match(line)
        if match is not None and current is not None:
            sprite_id, palette_id, raw_x, raw_y, screen_x, screen_y, _, _, _, _, zoom, subsprite = match.groups()
            current["calls"].append(
                {
                    "spriteId": int(sprite_id),
                    "paletteId": int(palette_id),
                    "rawX": int(raw_x),
                    "rawY": int(raw_y),
                    "screenAnchorX": int(screen_x),
                    "screenAnchorY": int(screen_y),
                    "zoom": int(zoom),
                    "subsprite": subsprite,
                }
            )
    if current is not None:
        groups.append(current)
    return groups


def visible_tree_boxes(group: dict[str, Any], masks: dict[int, set[tuple[int, int]]]) -> list[dict[str, Any]]:
    require(group["viewport"]["zoom"] == 0, "frozen target view must be 1:1")
    require(group["viewport"]["width"] == 640 and group["viewport"]["height"] == 480, "viewport dimensions changed")
    for call in group["calls"]:
        require(call["zoom"] == 0, "draw-call zoom does not match viewport")
        require(call["subsprite"] == "(nil)", "unexpected subsprite crop; source mask needs a new transform")
        require(call["spriteId"] in masks, f"sprite missing source alpha mask: {call['spriteId']}")

    covered: set[tuple[int, int]] = set()
    visible_boxes: list[dict[str, Any]] = []
    x_min, y_min, x_max, y_max = MAP_CLIP
    for call_index in range(len(group["calls"]) - 1, -1, -1):
        call = group["calls"][call_index]
        screen_x = call["screenAnchorX"]
        screen_y = call["screenAnchorY"]
        support = {
            (screen_x + x, screen_y + y)
            for x, y in masks[call["spriteId"]]
            if x_min <= screen_x + x < x_max and y_min <= screen_y + y < y_max
        }
        if call["spriteId"] in TREE_SPRITES:
            visible = support - covered
            if visible and len(visible) >= MIN_VISIBLE_PIXELS:
                xs = [x for x, _ in visible]
                ys = [y for _, y in visible]
                box = [min(xs), min(ys), max(xs) + 1, max(ys) + 1]
                if box[2] - box[0] >= MIN_BOX_SIDE and box[3] - box[1] >= MIN_BOX_SIDE:
                    visible_boxes.append(
                        {
                            "sourceSpriteId": call["spriteId"],
                            "sourceDrawCallIndex": call_index,
                            "pixelXYXY": box,
                            "visiblePixelCount": len(visible),
                        }
                    )
        covered.update(support)
    visible_boxes.reverse()
    return visible_boxes


def verify() -> dict[str, int | str]:
    manifest_path = DATA / "manifest.json"
    input_path = DATA / "inputs.json"
    truth_path = DATA / "ground-truth.json"
    ledger_path = DATA / "source-ledger.json"
    for path in (manifest_path, input_path, truth_path, ledger_path):
        require(path.is_file(), f"missing ignored corpus file: {path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    inputs = json.loads(input_path.read_text(encoding="utf-8"))
    truths = json.loads(truth_path.read_text(encoding="utf-8"))
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    require(sha256(input_path) == manifest["inputManifestSha256"], "input manifest hash mismatch")
    require(sha256(truth_path) == manifest["groundTruthSha256"], "ground-truth hash mismatch")
    require(sha256(ledger_path) == manifest["sourceLedgerSha256"], "source-ledger hash mismatch")
    require(len(inputs) == len(truths) == 20, "expected 20 heldout cases")
    require(manifest["present"] == 15 and manifest["absent"] == 5, "manifest quota mismatch")
    require(manifest["stratum"] == "controlled-real-game-map-independent-renderer-geometry-and-runtime-inventory", "unexpected stratum")
    require(manifest["admittedAsNaturalCapture"] is False, "controlled screenshots must not be called natural captures")
    require(len({item["caseId"] for item in inputs}) == 20, "duplicate input case IDs")
    require(len({item["caseId"] for item in truths}) == 20, "duplicate truth case IDs")
    truth_by_id = {item["caseId"]: item for item in truths}
    source_by_id = ledger["cases"]
    require(set(truth_by_id) == set(source_by_id) == {item["caseId"] for item in inputs}, "case joins differ")
    require(len({item["image"]["sha256"] for item in inputs}) == 20, "input images are not byte-distinct")

    source = ledger["source"]
    require(source["application"]["version"] == "13.4", "unexpected OpenTTD version")
    require(source["graphicsAssets"]["version"] == "7.1", "unexpected OpenGFX version")
    nfo = BASE / "oracle01/opengfx-base/ogfx1_base.nfo"
    nfo_hash = source["graphicsAssets"]["baseNfoSha256"]
    require(sha256(nfo) == nfo_hash, "OpenGFX sprite layout NFO hash mismatch")
    for name, key in (("ogfx1_base00.png", "base00Sha256"), ("ogfx1_base01.png", "base01Sha256")):
        require(sha256(BASE / "oracle01/opengfx-base" / name) == source["graphicsAssets"][key], f"asset hash mismatch: {name}")
    masks = source_sprite_masks(BASE / "oracle01/opengfx-base", nfo)

    positive_count = negative_count = 0
    for case in inputs:
        case_id = case["caseId"]
        truth = truth_by_id[case_id]
        evidence = source_by_id[case_id]
        image_path = safe_repo_path(case["image"]["path"])
        require(sha256(image_path) == case["image"]["sha256"], f"image hash mismatch: {case_id}")
        require(png_dimensions(image_path) == (640, 480), f"image dimensions differ: {case_id}")
        require(case["classify"]["options"] == ["present", "absent"], f"class options differ: {case_id}")
        require(truth["sourceGroup"] == manifest["sourceGroup"], f"source group mismatch: {case_id}")
        run = evidence["sourceRun"]
        trace_path = BASE / run / "drawview.log"
        require(sha256(trace_path) == evidence["traceSha256"], f"renderer trace hash mismatch: {case_id}")
        groups = parse_trace(trace_path)
        ordinal = evidence["sourceViewportOrdinal"]
        require(1 <= ordinal <= len(groups), f"viewport ordinal outside trace: {case_id}")
        group = groups[ordinal - 1]
        require(group["viewport"]["zoom"] == 0, f"wrong zoom at input viewport: {case_id}")
        require(group["vehiclePoolCount"] == group["vehiclePoolFirstUnused"] == 7, f"vehicle pool count differs: {case_id}")
        require(group["vehiclePoolVtable"] == groups[0]["vehiclePoolVtable"], f"vehicle pool class changed: {case_id}")
        require(group["vehiclePoolVtable"].startswith("0x"), f"missing vehicle pool vtable: {case_id}")

        if truth["expectedPresence"] == "present":
            positive_count += 1
            expected = visible_tree_boxes(group, masks)
            actual = [
                {
                    "sourceSpriteId": box["sourceSpriteId"],
                    "sourceDrawCallIndex": box["sourceDrawCallIndex"],
                    "pixelXYXY": box["pixelXYXY"],
                    "visiblePixelCount": box["sourceAlphaVisiblePixels"],
                }
                for box in truth["targetBoxes"]
            ]
            require(actual == expected, f"source-alpha boxes differ from frozen truth: {case_id}")
            require(bool(actual), f"positive case lacks a visible tree source instance: {case_id}")
        else:
            negative_count += 1
            target_class = truth["targetClassId"].removesuffix("-vehicle-body")
            require(target_class in NEGATIVE_TYPES, f"unsupported negative target: {case_id}")
            require(not truth["targetBoxes"], f"negative case has target boxes: {case_id}")
            items = [line for line in trace_path.read_text(errors="replace").splitlines() if line.startswith("ITEM ")]
            require(len(items) == 7, f"incomplete vehicle pool inventory: {case_id}")
            require(all("vtable for EffectVehicle" in line for line in items), f"non-effect vehicle in pool: {case_id}")
            require(truth["negativeEvidence"]["poolSlots"] == [
                {"slot": index, "runtimeClass": "EffectVehicle"} for index in range(7)
            ], f"negative inventory evidence differs: {case_id}")
    require(positive_count == 15 and negative_count == 5, "case truth counts differ")
    return {
        "cases": len(inputs),
        "present": positive_count,
        "absent": negative_count,
        "uniqueImages": len({item["image"]["sha256"] for item in inputs}),
        "inputManifestSha256": sha256(input_path),
        "groundTruthSha256": sha256(truth_path),
    }


def main() -> int:
    try:
        report = verify()
    except (OSError, ValueError, KeyError, TypeError, VerificationError, AssertionError) as error:
        print(f"OpenTTD independent map corpus verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
