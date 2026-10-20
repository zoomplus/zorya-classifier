#!/usr/bin/env python3
"""Private proof helpers for controlled, source-pinned application captures."""

from __future__ import annotations

import hashlib
import struct
import zlib
from collections import deque
from pathlib import Path
from typing import Iterable


MAGENTA = (240, 0, 200)
GREEN = (0, 210, 80)


def canonicalize_calculator_evaluator_truth(
    source_document: dict,
    producer_cases: list[dict],
) -> list[dict]:
    """Convert the pinned Calculator truth wrapper to evaluator normalized XYXY.

    Source positive boxes are measured screen-pixel XYXY bounds; they are not
    interpreted as width/height. This helper intentionally copies no screenshot
    bytes and performs no annotation or target selection.
    """
    source_rows = source_document.get("cases") if isinstance(source_document, dict) else None
    if not isinstance(source_rows, list) or not isinstance(producer_cases, list):
        raise ValueError("UI truth and producer cases must be arrays")
    if not source_rows or len(source_rows) != len(producer_cases):
        raise ValueError("UI truth and producer case counts differ")
    source_by_id: dict[str, dict] = {}
    for row in source_rows:
        if not isinstance(row, dict) or not isinstance(row.get("caseId"), str) or not row["caseId"]:
            raise ValueError("UI truth case identity is invalid")
        if row["caseId"] in source_by_id:
            raise ValueError("UI truth case identities are duplicated")
        source_by_id[row["caseId"]] = row
    producer_by_id: dict[str, dict] = {}
    for row in producer_cases:
        if not isinstance(row, dict) or not isinstance(row.get("caseId"), str) or not row["caseId"]:
            raise ValueError("UI producer case identity is invalid")
        if row["caseId"] in producer_by_id:
            raise ValueError("UI producer case identities are duplicated")
        producer_by_id[row["caseId"]] = row
    if source_by_id.keys() != producer_by_id.keys():
        raise ValueError("UI truth and producer case identities differ")

    result: list[dict] = []
    for producer in producer_cases:
        case_id = producer["caseId"]
        source = source_by_id[case_id]
        image = producer.get("image")
        if not isinstance(image, dict):
            raise ValueError("UI producer image dimensions are missing")
        width, height = image.get("width"), image.get("height")
        if (
            not isinstance(width, int) or isinstance(width, bool) or width <= 0
            or not isinstance(height, int) or isinstance(height, bool) or height <= 0
        ):
            raise ValueError("UI producer image dimensions are invalid")
        present = source.get("expectedPresence")
        if not isinstance(present, bool):
            raise ValueError("UI truth expectedPresence must be boolean")
        if present:
            box = source.get("box")
            if not isinstance(box, list) or len(box) != 4:
                raise ValueError("UI positive truth must contain one XYXY pixel box")
            left, top, right, bottom = box
            if (
                any(not isinstance(value, int) or isinstance(value, bool) for value in box)
                or left < 0 or top < 0 or right <= left or bottom <= top
                or right > width or bottom > height
            ):
                raise ValueError("UI positive box lies outside its source raster")
            result.append({
                "caseId": case_id,
                "expectedPresence": "present",
                "targetBoxes": [{"xyxy": [left / width, top / height, right / width, bottom / height]}],
                "negativeEvidence": None,
            })
        else:
            if source.get("box") is not None:
                raise ValueError("UI negative truth must not contain a positive box")
            evidence = source.get("negativeEvidence", source.get("evidence"))
            if not isinstance(evidence, str) or not evidence.strip():
                raise ValueError("UI negative truth lacks independent evidence")
            result.append({
                "caseId": case_id,
                "expectedPresence": "absent",
                "targetBoxes": [],
                "negativeEvidence": evidence,
            })
    return result


def _f32(value: float) -> float:
    """Round once as a C++ `float` assignment/arithmetic operation would."""
    return struct.unpack("=f", struct.pack("=f", value))[0]


def wesnoth_float32_sample_indices(source_size: int, destination_size: int) -> list[int]:
    """Match `scale_surface_sharp`'s accumulated float coordinate sequence.

    Wesnoth 1.16.11 stores the ratio and running source coordinate as `float`
    and increments the latter on each output pixel. Replacing this with
    `floor(i * ratio)` loses boundary samples (for 864→212, output index 53
    samples source 215, not 216).
    """
    if not isinstance(source_size, int) or isinstance(source_size, bool) or source_size < 1:
        raise ValueError("source_size must be a positive integer")
    if not isinstance(destination_size, int) or isinstance(destination_size, bool) or destination_size < 1:
        raise ValueError("destination_size must be a positive integer")
    ratio = _f32(_f32(source_size) / _f32(destination_size))
    source = _f32(0.0)
    result: list[int] = []
    for _ in range(destination_size):
        index = int(source)
        if index < 0 or index >= source_size:
            raise ValueError("float32 sample escaped source bounds")
        result.append(index)
        source = _f32(source + ratio)
    return result


def wesnoth_project_village_support(
    villages: Iterable[tuple[int, int]],
    *,
    map_width: int,
    map_height: int,
    scale: int,
    area: tuple[int, int, int, int],
) -> set[tuple[int, int]]:
    """Project source map village fills through the pinned 1.16.11 scaler.

    Village coordinates are zero-based raw `map_data` (column,row) indices.
    The one-cell map border is removed before the source game coordinates are
    calculated. The result is only the requested source fill support; later
    row-major terrain drawing can occlude projected pixels.
    """
    if any(not isinstance(v, int) or isinstance(v, bool) for v in (map_width, map_height, scale)):
        raise ValueError("map dimensions and scale must be integers")
    if map_width < 3 or map_height < 3 or scale < 1:
        raise ValueError("map dimensions or scale are invalid")
    if len(area) != 4 or any(not isinstance(v, int) or isinstance(v, bool) for v in area):
        raise ValueError("area must be an integer x,y,width,height tuple")
    area_x, area_y, area_width, area_height = area
    if area_x < 0 or area_y < 0 or area_width < 1 or area_height < 1:
        raise ValueError("area is invalid")
    inner_width, inner_height = map_width - 2, map_height - 2
    canvas_width = inner_width * scale * 3 // 4
    canvas_height = inner_height * scale
    ratio = min(area_width / canvas_width, area_height / canvas_height)
    bitmap_width = int(canvas_width * ratio)
    bitmap_height = int(canvas_height * ratio)
    if bitmap_width < 1 or bitmap_height < 1:
        raise ValueError("projected minimap is empty")
    origin_x = area_x + (area_width - bitmap_width) // 2
    origin_y = area_y + (area_height - bitmap_height) // 2
    sampled_x = wesnoth_float32_sample_indices(canvas_width, bitmap_width)
    sampled_y = wesnoth_float32_sample_indices(canvas_height, bitmap_height)
    support: set[tuple[int, int]] = set()
    for raw_col, raw_row in villages:
        if (
            not isinstance(raw_col, int)
            or isinstance(raw_col, bool)
            or not isinstance(raw_row, int)
            or isinstance(raw_row, bool)
            or not 1 <= raw_col < map_width - 1
            or not 1 <= raw_row < map_height - 1
        ):
            raise ValueError("village must be inside the one-cell map border")
        game_x, game_y = raw_col - 1, raw_row - 1
        left = game_x * scale * 3 // 4 - scale // 4
        top = game_y * scale + (scale // 4) * (1 if game_x % 2 else -1) - scale // 4
        for output_y, source_y in enumerate(sampled_y):
            if not top <= source_y < top + scale:
                continue
            for output_x, source_x in enumerate(sampled_x):
                if left <= source_x < left + scale * 3 // 4:
                    support.add((origin_x + output_x, origin_y + output_y))
    return support


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_png_rgb(path: str | Path) -> tuple[int, int, bytes]:
    """Decode non-interlaced 8-bit RGB/RGBA PNGs without image heuristics."""
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    width = height = color_type = bit_depth = None
    compressed = bytearray()
    while pos < len(data):
        length = struct.unpack_from(">I", data, pos)[0]
        kind = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if bit_depth != 8 or color_type not in (2, 6) or compression or filtering or interlace:
                raise ValueError("only non-interlaced 8-bit RGB/RGBA PNG is supported")
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    if width is None or height is None or color_type is None:
        raise ValueError("PNG has no IHDR")
    channels = 3 if color_type == 2 else 4
    stride = width * channels
    raw = zlib.decompress(compressed)
    if len(raw) != (stride + 1) * height:
        raise ValueError("unexpected PNG data length")
    pixels = bytearray(stride * height)
    offset = 0
    for y in range(height):
        filter_type = raw[offset]
        offset += 1
        row = raw[offset : offset + stride]
        offset += stride
        prior = pixels[(y - 1) * stride : y * stride] if y else bytearray(stride)
        out = pixels[y * stride : (y + 1) * stride]
        for x, value in enumerate(row):
            left = out[x - channels] if x >= channels else 0
            above = prior[x]
            upper_left = prior[x - channels] if x >= channels else 0
            if filter_type == 1:
                value = (value + left) & 255
            elif filter_type == 2:
                value = (value + above) & 255
            elif filter_type == 3:
                value = (value + ((left + above) // 2)) & 255
            elif filter_type == 4:
                p = left + above - upper_left
                pa, pb, pc = abs(p - left), abs(p - above), abs(p - upper_left)
                predictor = left if pa <= pb and pa <= pc else above if pb <= pc else upper_left
                value = (value + predictor) & 255
            elif filter_type != 0:
                raise ValueError(f"unsupported PNG filter {filter_type}")
            out[x] = value
        pixels[y * stride : (y + 1) * stride] = out
    if channels == 3:
        return width, height, bytes(pixels)
    rgb = bytearray(width * height * 3)
    for i in range(width * height):
        rgb[i * 3 : i * 3 + 3] = pixels[i * 4 : i * 4 + 3]
    return width, height, bytes(rgb)


def exact_color_components(
    width: int, height: int, rgb: bytes, color: tuple[int, int, int]
) -> list[tuple[int, int, int, int]]:
    """Return exact-color 4-connected component boxes in x1,y1,x2,y2 form."""
    if len(rgb) != width * height * 3:
        raise ValueError("RGB buffer size mismatch")
    target = bytes(color)
    seen = bytearray(width * height)
    components: list[tuple[int, int, int, int]] = []
    for start in range(width * height):
        at = start * 3
        if seen[start] or rgb[at : at + 3] != target:
            continue
        seen[start] = 1
        queue = deque([start])
        min_x = max_x = start % width
        min_y = max_y = start // width
        while queue:
            i = queue.popleft()
            x, y = i % width, i // width
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < 0 or ny < 0 or nx >= width or ny >= height:
                    continue
                ni = ny * width + nx
                na = ni * 3
                if not seen[ni] and rgb[na : na + 3] == target:
                    seen[ni] = 1
                    queue.append(ni)
        components.append((min_x, min_y, max_x + 1, max_y + 1))
    return components


def _is_full_border(
    width: int,
    rgb: bytes,
    box: tuple[int, int, int, int],
    color: tuple[int, int, int],
    thickness: int,
) -> bool:
    x1, y1, x2, y2 = box
    if x2 - x1 <= 2 * thickness or y2 - y1 <= 2 * thickness:
        return False
    expected = bytes(color)
    for y in range(y1, y2):
        for x in range(x1, x2):
            edge = x < x1 + thickness or x >= x2 - thickness or y < y1 + thickness or y >= y2 - thickness
            if edge and rgb[(y * width + x) * 3 : (y * width + x) * 3 + 3] != expected:
                return False
    return True


def calculator_target_box(
    screenshot: str | Path,
    ui_file: str | Path,
    *,
    expected_ui_sha256: str,
    expected_screenshot_sha256: str,
    border_thickness: int = 3,
) -> tuple[int, int, int, int]:
    """Bind calc_7_button via GtkBuilder row/column and verify painted edges."""
    import xml.etree.ElementTree as ET

    if sha256_file(ui_file) != expected_ui_sha256:
        raise ValueError("GtkBuilder source hash mismatch")
    if sha256_file(screenshot) != expected_screenshot_sha256:
        raise ValueError("screenshot hash mismatch")
    root = ET.parse(ui_file).getroot()
    node = root.find(".//object[@id='calc_7_button']")
    if node is None or node.attrib.get("class") != "GtkButton":
        raise ValueError("source target widget not found")
    layout = node.find("layout")
    if layout is None:
        raise ValueError("source widget has no grid layout")
    row = int(layout.findtext("property[@name='row']", "-1"))
    col = int(layout.findtext("property[@name='column']", "-1"))
    if (row, col) != (1, 0):
        raise ValueError("pinned target grid position changed")

    width, height, rgb = read_png_rgb(screenshot)
    components = exact_color_components(width, height, rgb, MAGENTA)
    boxes = [box for box in components if _is_full_border(width, rgb, box, MAGENTA, border_thickness)]
    boxes.sort(key=lambda b: (b[1], b[0]))
    # Buttons in the keypad are the dense 5-column set in the lower window.
    keypad = [box for box in boxes if box[1] >= 250 and box[2] - box[0] > 40 and box[3] - box[1] > 35]
    ys = sorted({box[1] for box in keypad})
    if len(ys) != 5 or len(keypad) != 24:
        raise ValueError(f"expected 24 painted keypad buttons in 5 rows; got {len(keypad)} / {len(ys)}")
    row_boxes = sorted((box for box in keypad if box[1] == ys[row]), key=lambda b: b[0])
    if len(row_boxes) != 5:
        raise ValueError("target source row does not resolve to five painted buttons")
    return row_boxes[col]


def wesnoth_delta_box(
    before_png: str | Path,
    present_png: str | Path,
    after_png: str | Path,
    *,
    crop: tuple[int, int, int, int],
    expected_hashes: tuple[str, str, str],
) -> tuple[int, int, int, int]:
    """Require identical A frames and return exact changed-pixel support in B."""
    paths = (before_png, present_png, after_png)
    if tuple(sha256_file(path) for path in paths) != expected_hashes:
        raise ValueError("Wesnoth capture hash mismatch")
    frames = [read_png_rgb(path) for path in paths]
    if len({(w, h) for w, h, _ in frames}) != 1:
        raise ValueError("Wesnoth capture dimensions differ")
    width, height, first = frames[0]
    _, _, middle = frames[1]
    _, _, last = frames[2]
    x1, y1, x2, y2 = crop
    if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
        raise ValueError("invalid minimap crop")
    for y in range(y1, y2):
        start, end = (y * width + x1) * 3, (y * width + x2) * 3
        if first[start:end] != last[start:end]:
            raise ValueError("A→B→A minimap crop endpoints are not pixel-identical")
    changed: list[tuple[int, int]] = []
    for y in range(y1, y2):
        for x in range(x1, x2):
            i = (y * width + x) * 3
            if first[i : i + 3] != middle[i : i + 3]:
                changed.append((x, y))
    if not changed:
        raise ValueError("source state change produced no minimap pixel delta")
    return (
        min(x for x, _ in changed),
        min(y for _, y in changed),
        max(x for x, _ in changed) + 1,
        max(y for _, y in changed) + 1,
    )
