#!/usr/bin/env python3
"""Bounded metadata and SDL draw preflight for the pinned LinCity-NG build."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import resource
import signal
import stat
import subprocess
import sys
import time
import zlib
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

MAX_COMPRESSED_SAVE_BYTES = 8 * 1024 * 1024
MAX_SAVE_BYTES = 24 * 1024 * 1024
MAX_SAVE_LINES = 20_000
MAX_CONSTRUCTIONS = 500
MAX_IMAGES_XML_BYTES = 2 * 1024 * 1024
MAX_ASSET_BYTES = 4 * 1024 * 1024
MAX_TRACE_BYTES = 16 * 1024 * 1024
MAX_TRACE_LINES = 50_001
MAX_CASE_SECONDS = 30
MAX_PROCESS_FILE_BYTES = 20 * 1024 * 1024
MAX_NATIVE_FRAME_BYTES = 1_920_000
VIEWPORT_WIDTH = 1024
VIEWPORT_HEIGHT = 768
ARTIFACT_ROOT = Path("/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-map")
RESUMPTION_ARTIFACT_ROOT = Path("/root/.codex/artifacts/zorya-classifier-mcp-20261101/lincity-resume")
EXPECTED_SAVE_SHA256 = "2cf706e580e7181bb1dc66f45d4e4c043b296249e18dcade022f2ae5ad22ad6f"
EXPECTED_CAMERA_SAVE_SHA256 = "c36b456db58f808191f961819384a6d95811c97feb76fd74369faf8f1e621e18"
EXPECTED_SAVE_SHA256S = frozenset({EXPECTED_SAVE_SHA256, EXPECTED_CAMERA_SAVE_SHA256})
CAMERA_SAVE_RECEIPT_PATH = ARTIFACT_ROOT / "luna-lincity-diagnostic-v8-farm32-camera" / "receipt.json"
CAMERA_SAVE_INPUT_PATH = ARTIFACT_ROOT / "luna-lincity-camera-save-v1.scn.gz"
EXPECTED_SAVE_VERSION = 1328
CAPTURE_TARGET_ASSETS = {
    "Farm": {
        "filename": "farm0.png",
        "pngSha256": "596ad9a654ea91e8d69ed7c12a96021dcd8abfd78923b470ffd55bf2cb3f9e33",
        "rgbaSha256": "a6d5aa264a64eca2fa54cd2e06278d7e96472ece796fda95148a9baeba0900f5",
        "resourceNames": ["Farm"],
        "xOffset": 256,
        "yOffset": 512,
    },
    "Pottery": {
        "filename": "pottery0.png",
        "pngSha256": "27442a8455796c8bb449fd3b4bbd141206d353c3e37acc89619b2913452142f5",
        "rgbaSha256": "5f44903b7d094706461829113800b28af87e35c88e5a15ddd0597deae3277efa",
        "resourceNames": ["Pottery"],
        "xOffset": 131,
        "yOffset": 210,
    },
    "Market": {
        "filename": "market-full.png",
        "pngSha256": "10d9238a752638e89c5adc516038a0f2085a007956321d07f1ec5d2d30138bfd",
        "rgbaSha256": "335b53bf686d4c4ededac5efc45671179b124dab228896defc7789b8f50260f3",
        "resourceNames": ["MarketEmpty", "MarketLow", "MarketMed", "MarketFull"],
        "xOffset": 128,
        "yOffset": 256,
    },
    "Water tower": {
        "filename": "waterwell.png",
        "pngSha256": "f3812e41eec3b67aecad727989e9a19a5fcfe2f7e1ddf42e778404337166e048",
        "rgbaSha256": "bdf08115f07bfd78bd547553f1580b55a7f70b4e5b05b1d48f39ba4bfaf88a5f",
        "resourceNames": ["Waterwell"],
        "xOffset": 129,
        "yOffset": 215,
    },
}
CONSTRUCTION_FOOTPRINTS = {"Pottery": 2, "Market": 2, "Water tower": 2}
EXPECTED_SOURCE = {
    "lincity-game-view.cpp": "2ea15613218b0cd205f3fed4bbedabdd39c3169504a6555bd5cd9c43efba5a76",
    "lincity-load-save.cpp": "2be958dcd82b87d1d870a5927ee6421fa564ffb6a0147f9a70f3150e5c98d92d",
    "PainterSDL.cpp": "68dbd15bc1ecc19dd94cd12ac98855c5091bd9f56633e5cfac6ba4312a076442",
    "TextureManagerSDL.cpp": "05da5dc6d3a20cafadc22bc893c27a7e4c1d6b67188e8fcd3b35557c42e48c1d",
}
EXPECTED_LOADSAVE_SOURCE_SHA256 = "390aed2eb3d9c697a4cf4d6d1f6cc7254bdd4f29bff1af3441cb1c5ae6dfc1ac"
EXPECTED_MENU_LAYOUT_SHA256 = "ea1e6b955a874203f467570b365cc781f85e293cce80270884f55a0f591468e0"
EXPECTED_GAME_CAMERA_CLAMP = "world-side - floor(viewport-pixels / 16) - 1"
EXPECTED_ASSET_LIST = ("farm0.png", "farm3.png", "farm7.png", "farm11.png", "farm15.png")
NON_DRAW_TRACE_EVENT_TYPES = frozenset({"render_present", "capture_complete", "native_frame_capture"})


class OracleError(RuntimeError):
    pass


def _write_exclusive(path: Path, payload: bytes, mode: int = 0o600) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, mode)
    try:
        view = memoryview(payload)
        offset = 0
        while offset < len(view):
            written = os.write(fd, view[offset:])
            if written <= 0:
                raise OracleError("exclusive output write did not complete")
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return len(payload).to_bytes(4, "big") + body + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")


def encode_rgba_png(width: int, height: int, rgba: bytes) -> bytes:
    if (width, height) != (800, 600) or len(rgba) != MAX_NATIVE_FRAME_BYTES:
        raise OracleError("native framebuffer dimensions or byte length are invalid")
    rows = b"".join(b"\x00" + rgba[row * width * 4 : (row + 1) * width * 4] for row in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00")
        + _png_chunk(b"IDAT", zlib.compress(rows, 9))
        + _png_chunk(b"IEND", b"")
    )


def validate_native_frame_capture(records: list[dict[str, Any]], target_frame: int | None, output: Path) -> dict[str, Any]:
    rows = [row for row in records if row.get("type") == "native_frame_capture"]
    base: dict[str, Any] = {
        "required": True,
        "status": "failed",
        "reason": "native-frame-record-missing" if not rows else None,
        "sameFrameAsTargetDraw": False,
        "rgbaPath": str(output / "native-frame.rgba"),
        "pngPath": None,
    }
    if len(rows) != 1:
        base["reason"] = "native-frame-record-count-mismatch"
        return base
    row = rows[0]
    base.update({
        "renderer": row.get("renderer"),
        "targetSurface": row.get("targetSurface"),
        "frame": row.get("frame"),
        "width": row.get("width"),
        "height": row.get("height"),
        "format": row.get("format"),
        "byteCount": row.get("byteCount"),
        "sha256": row.get("sha256"),
        "readResult": row.get("readResult"),
        "readStatus": row.get("status"),
        "failure": row.get("failure"),
        "errno": row.get("errno"),
    })
    start = next((item for item in records if item.get("type") == "capture_start"), None)
    target_draws = [item for item in records if item.get("type") == "render_copy" and item.get("rgbaSha256") == row.get("targetRgbaSha256")]
    base["sameFrameAsTargetDraw"] = bool(
        target_frame is not None and row.get("frame") == target_frame
        and start is not None and row.get("renderer") == start.get("renderer")
        and start.get("frame") == target_frame
        and any(
            item.get("frame") == target_frame and item.get("renderer") == row.get("renderer")
            and isinstance(item.get("seq"), int) and isinstance(row.get("seq"), int) and item["seq"] < row["seq"]
            and isinstance(start.get("seq"), int) and start["seq"] < item["seq"]
            for item in target_draws
        )
    )
    if row.get("status") != "captured" or row.get("readResult") != 0:
        base["reason"] = row.get("failure") or "native-frame-read-failed"
        return base
    if (row.get("width"), row.get("height"), row.get("format"), row.get("targetSurface")) != (800, 600, "SDL_PIXELFORMAT_RGBA32", None):
        base["reason"] = "native-frame-format-dimensions-or-window-surface-mismatch"
        return base
    if row.get("frame") != target_frame or not base["sameFrameAsTargetDraw"]:
        base["reason"] = "native-frame-identity-mismatch"
        return base
    if start is None or not isinstance(row.get("seq"), int):
        base["reason"] = "native-frame-trace-order-invalid"
        return base
    present = next((
        item for item in records
        if item.get("type") == "render_present" and item.get("renderer") == row.get("renderer")
        and item.get("frame") == row.get("frame", -2) + 1
        and isinstance(item.get("seq"), int) and item["seq"] > row["seq"]
    ), None)
    complete = next((
        item for item in records
        if item.get("type") == "capture_complete" and present is not None
        and item.get("renderer") == row.get("renderer") and item.get("frame") == present.get("frame")
        and isinstance(item.get("seq"), int) and item["seq"] > present["seq"]
    ), None)
    if present is None or complete is None:
        base["reason"] = "native-frame-trace-order-invalid"
        return base
    base["traceOrderValid"] = True
    rgba_path = output / "native-frame.rgba"
    try:
        rgba = read_bounded(rgba_path, MAX_NATIVE_FRAME_BYTES, "native framebuffer RGBA")
        mode = stat.S_IMODE(rgba_path.stat().st_mode)
    except (OracleError, OSError) as error:
        base["reason"] = f"native-frame-file-invalid:{type(error).__name__}"
        return base
    base["fileMode"] = f"{mode:04o}"
    if len(rgba) != MAX_NATIVE_FRAME_BYTES or row.get("byteCount") != MAX_NATIVE_FRAME_BYTES:
        base["reason"] = "native-frame-byte-length-mismatch"
        return base
    digest = sha256_bytes(rgba)
    if row.get("sha256") != digest:
        base["reason"] = "native-frame-sha256-mismatch"
        return base
    if mode != 0o600:
        base["reason"] = "native-frame-file-mode-mismatch"
        return base
    try:
        png = encode_rgba_png(800, 600, rgba)
        png_path = output / "native-frame.png"
        _write_exclusive(png_path, png)
        from PIL import Image

        with Image.open(png_path) as image:
            image.load()
            exact_pixels = image.mode == "RGBA" and image.size == (800, 600) and image.tobytes() == rgba
        if not exact_pixels:
            base["reason"] = "native-frame-png-pixel-verification-failed"
            return base
    except (OSError, OracleError) as error:
        base["reason"] = f"native-frame-png-validation-failed:{type(error).__name__}"
        return base
    base.update({"status": "captured-and-pixel-verified", "reason": None, "pngPath": str(png_path), "pngSha256": sha256_bytes(png)})
    return base


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_bounded(path: Path, cap: int, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise OracleError(f"{label} must be a regular non-symlink file")
    size = path.stat().st_size
    if size > cap:
        raise OracleError(f"{label} exceeds the {cap}-byte limit")
    with path.open("rb") as handle:
        payload = handle.read(cap + 1)
    if len(payload) != size or len(payload) > cap:
        raise OracleError(f"{label} changed during bounded read")
    return payload


def bounded_gzip_decompress(payload: bytes, cap: int = MAX_SAVE_BYTES) -> bytes:
    if len(payload) > MAX_COMPRESSED_SAVE_BYTES:
        raise OracleError("compressed save exceeds the byte limit")
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        expanded = decompressor.decompress(payload, cap + 1)
    except zlib.error as error:
        raise OracleError("save is not a valid gzip stream") from error
    if len(expanded) > cap or decompressor.unconsumed_tail:
        raise OracleError("decompressed save exceeds the byte limit")
    if not decompressor.eof or decompressor.unused_data:
        raise OracleError("save gzip stream is truncated or has trailing members")
    return expanded


def _number(lines: list[str], key: str) -> int:
    pattern = re.compile(rf"^<{re.escape(key)}>([0-9]+)</{re.escape(key)}>\s*$")
    found = [match.group(1) for line in lines if (match := pattern.fullmatch(line))]
    if len(found) != 1:
        raise OracleError(f"save must contain exactly one {key} field")
    return int(found[0])


def parse_save(payload: bytes) -> dict[str, Any]:
    raw = bounded_gzip_decompress(payload)
    try:
        text = raw.decode("iso-8859-15", errors="strict")
    except UnicodeDecodeError as error:
        raise OracleError("save text is not ISO-8859-15") from error
    lines = text.splitlines()
    if len(lines) > MAX_SAVE_LINES:
        raise OracleError("save exceeds the line-count limit")
    if any(len(line) > 16_384 for line in lines):
        raise OracleError("save contains an oversized line")
    if "<SaveGame>" not in lines or "</SaveGame>" not in lines:
        raise OracleError("save root framing is missing")
    version = _number(lines, "loadsave_version")
    world_side = _number(lines, "world_side_len")
    origin_x = _number(lines, "main_screen_originx")
    origin_y = _number(lines, "main_screen_originy")
    declared_count = _number(lines, "constructions")
    if version != EXPECTED_SAVE_VERSION or world_side != 100:
        raise OracleError("save version or world dimensions differ from the reviewed input")

    constructions: list[dict[str, Any]] = []
    inside = False
    for line in lines:
        if line == "<ConstructionSection>":
            if inside:
                raise OracleError("nested construction section")
            inside = True
            continue
        if line == "</ConstructionSection>":
            if not inside:
                raise OracleError("construction section closes without opening")
            inside = False
            continue
        if not inside:
            continue
        match = re.fullmatch(r"<([^<>]+)>(.*?)</([^<>]+)>\s*", line)
        if not match:
            if line.strip():
                raise OracleError("unsupported construction row syntax")
            continue
        tag, value, closing = match.groups()
        if tag != closing:
            raise OracleError("construction tag mismatch")
        fields = value.split("\t")
        if len(fields) < 3 or not all(re.fullmatch(r"[0-9]+", item) for item in fields[:3]):
            raise OracleError("construction row lacks numeric group/x/y fields")
        row = {
            "type": tag,
            "group": int(fields[0]),
            "x": int(fields[1]),
            "y": int(fields[2]),
            "remainingFields": fields[3:],
        }
        if not (0 <= row["x"] < world_side and 0 <= row["y"] < world_side):
            raise OracleError("construction coordinate is outside the world")
        constructions.append(row)
        if len(constructions) > MAX_CONSTRUCTIONS:
            raise OracleError("construction count exceeds the limit")
    if inside or len(constructions) != declared_count:
        raise OracleError("construction section count does not match global declaration")
    return {
        "schemaVersion": "lincity-save-metadata-v1",
        "compressedSha256": sha256_bytes(payload),
        "saveVersion": version,
        "worldSide": world_side,
        "cameraOrigin": {"x": origin_x, "y": origin_y},
        "constructionCount": len(constructions),
        "constructions": constructions,
    }


def verify_pinned_sources(game_source_root: Path, painter_source_root: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for filename, expected in EXPECTED_SOURCE.items():
        source_root = game_source_root if filename in {"lincity-game-view.cpp", "lincity-load-save.cpp"} else painter_source_root
        data = read_bounded(source_root / filename, 2 * 1024 * 1024, filename)
        digest = sha256_bytes(data)
        if digest != expected:
            raise OracleError(f"pinned upstream source hash mismatch: {filename}")
        hashes[filename] = digest
    return hashes


def verify_save_lineage(save_path: Path, save_sha256: str, lineage_receipt_path: Path | None = None) -> dict[str, Any]:
    if save_sha256 == EXPECTED_SAVE_SHA256:
        return {"kind": "pinned-original-save", "sha256": save_sha256}
    if save_sha256 == EXPECTED_CAMERA_SAVE_SHA256 and save_path.resolve() == CAMERA_SAVE_INPUT_PATH:
        receipt_bytes = read_bounded(CAMERA_SAVE_RECEIPT_PATH, 128 * 1024, "camera derivation receipt")
        try:
            receipt = json.loads(receipt_bytes)
        except json.JSONDecodeError as error:
            raise OracleError("camera derivation receipt is malformed") from error
        if (
            not isinstance(receipt, dict)
            or receipt.get("status") != "completed"
            or receipt.get("ownedProcessGroupClosed") is not True
            or receipt.get("screenshots") != 0
            or receipt.get("modelCalls") != 0
            or receipt.get("inputSaveSha256") != EXPECTED_SAVE_SHA256
            or receipt.get("postrunPrivateSaveSha256") != save_sha256
            or receipt.get("cameraAction") != "farm-32-centered"
            or receipt.get("postrunCameraOrigin") != {"x": 31, "y": 49}
            or receipt.get("postrunConstructionInventoryMatchesInput") is not True
        ):
            raise OracleError("camera derivation receipt does not authorize this frozen save")
        return {
            "kind": "derived-camera-save",
            "sha256": save_sha256,
            "parentSaveSha256": EXPECTED_SAVE_SHA256,
            "cameraAction": "farm-32-centered",
            "cameraOrigin": {"x": 31, "y": 49},
            "derivationReceiptSha256": sha256_bytes(receipt_bytes),
        }
    if lineage_receipt_path is None:
        raise OracleError("save is not one of the explicitly frozen diagnostic inputs")
    artifact_root = ARTIFACT_ROOT.resolve()
    if save_path.is_symlink() or not save_path.is_file() or not save_path.resolve().is_relative_to(artifact_root):
        raise OracleError("derived save must be a regular owned file under the external artifact root")
    if lineage_receipt_path.is_symlink() or not lineage_receipt_path.is_file():
        raise OracleError("derived-save receipt must be a regular file")
    receipt_path = lineage_receipt_path.resolve()
    if not receipt_path.is_relative_to(artifact_root):
        raise OracleError("derived-save receipt must remain under the external artifact root")
    receipt_bytes = read_bounded(receipt_path, 128 * 1024, "derived-save receipt")
    try:
        receipt = json.loads(receipt_bytes)
    except json.JSONDecodeError as error:
        raise OracleError("derived-save receipt is malformed") from error
    input_lineage = receipt.get("inputSaveLineage") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or receipt.get("schemaVersion") != "lincity-draw-preflight-v1"
        or receipt.get("status") != "completed"
        or receipt.get("ownedProcessGroupClosed") is not True
        or receipt.get("screenshots") != 0
        or receipt.get("modelCalls") != 0
        or receipt.get("inputSaveSha256") != EXPECTED_CAMERA_SAVE_SHA256
        or not isinstance(input_lineage, dict)
        or input_lineage.get("sha256") != EXPECTED_CAMERA_SAVE_SHA256
        or receipt.get("postrunPrivateSaveSha256") != save_sha256
        or receipt.get("postrunConstructionInventoryMatchesInput") is not True
    ):
        raise OracleError("prior preflight receipt does not authorize this derived save")
    return {
        "kind": "independently-derived-camera-save",
        "sha256": save_sha256,
        "parentSaveSha256": EXPECTED_CAMERA_SAVE_SHA256,
        "cameraOrigin": receipt.get("postrunCameraOrigin"),
        "parentCameraOriginMatchesExpected": receipt.get("cameraOriginMatchesExpected"),
        "parentExpectedCameraOrigin": receipt.get("expectedCameraOrigin"),
        "parentPreflightReceiptSha256": sha256_bytes(receipt_bytes),
    }


def collect_farm_assets(tiles_dir: Path) -> list[dict[str, Any]]:
    xml_bytes = read_bounded(tiles_dir / "images.xml", MAX_IMAGES_XML_BYTES, "tiles images.xml")
    xml_digest = sha256_bytes(xml_bytes)
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as error:
        raise OracleError("installed images.xml is malformed") from error
    farm_images: list[str] = []
    for group in root.iter("group"):
        resource_names = [node.attrib.get("name") for node in group.findall("resourceID")]
        if "Farm" in resource_names:
            farm_images.extend(node.attrib.get("file", "") for node in group.findall("image"))
    if tuple(farm_images) != EXPECTED_ASSET_LIST:
        raise OracleError("installed Farm image roster differs from the reviewed five-frame group")
    license_path = tiles_dir.parent.parent / "COPYING-data.txt"
    license_bytes = read_bounded(license_path, 512 * 1024, "installed data license")
    license_lines = license_bytes.decode("utf-8", errors="strict").splitlines()
    if len(license_lines) < 2 or "dual licensed" not in license_lines[1].lower() or "cc-by-sa-v2" not in license_lines[1].lower():
        raise OracleError("installed data license does not state the reviewed image license")
    try:
        from PIL import Image
    except ImportError as error:
        raise OracleError("Pillow is required for local asset metadata") from error
    receipts: list[dict[str, Any]] = []
    for filename in farm_images:
        if Path(filename).name != filename or not filename.endswith(".png"):
            raise OracleError("Farm image filename is unsafe")
        path = tiles_dir / filename
        data = read_bounded(path, MAX_ASSET_BYTES, f"Farm asset {filename}")
        try:
            with Image.open(path) as image:
                image.load()
                rgba = image.convert("RGBA")
                pixel_bytes = rgba.tobytes()
                alpha_box = rgba.getchannel("A").getbbox()
                receipts.append(
                    {
                        "filename": filename,
                        "path": str(path),
                        "pngSha256": sha256_bytes(data),
                        "rgbaSha256": sha256_bytes(pixel_bytes),
                        "width": rgba.width,
                        "height": rgba.height,
                        "mode": image.mode,
                        "alphaBBoxHalfOpen": list(alpha_box) if alpha_box else None,
                    }
                )
        except OSError as error:
            raise OracleError(f"Farm image cannot be decoded: {filename}") from error
    return [{
        "imagesXmlSha256": xml_digest,
        "licenseFile": str(license_path),
        "licenseFileSha256": sha256_bytes(license_bytes),
        "licenseStatement": "The models, svg-files, images, sound and music files as well as the xml data files are dual licensed under the GPL and CC-by-sa-v2.",
        "frames": receipts,
    }]


def verify_capture_target_asset(tiles_dir: Path, target_name: str) -> dict[str, Any]:
    expected = CAPTURE_TARGET_ASSETS.get(target_name)
    if expected is None:
        raise OracleError("capture target is not on the frozen local resource allowlist")
    filename = expected["filename"]
    if Path(filename).name != filename:
        raise OracleError("capture target resource filename is unsafe")
    asset_path = tiles_dir / filename
    payload = read_bounded(asset_path, MAX_ASSET_BYTES, "capture target image")
    digest = sha256_bytes(payload)
    if digest != expected["pngSha256"]:
        raise OracleError("capture target PNG does not match its frozen package bytes")
    xml_bytes = read_bounded(tiles_dir / "images.xml", MAX_IMAGES_XML_BYTES, "tiles images.xml")
    try:
        xml_root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as error:
        raise OracleError("installed images.xml is malformed") from error
    resource_rows = [
        (group, image)
        for group in xml_root.iter("group")
        for image in group.findall("image")
        if image.attrib.get("file") == filename
    ]
    if len(resource_rows) != 1:
        raise OracleError("capture target must have exactly one installed XML image mapping")
    group, image_row = resource_rows[0]
    resource_names = [row.attrib.get("name") for row in group.findall("resourceID")]
    image_x_offset = int(image_row.attrib.get("x", "-1"))
    image_y_offset = int(image_row.attrib.get("y", "-1"))
    try:
        from PIL import Image

        with Image.open(asset_path) as image:
            image.load()
            rgba = image.convert("RGBA")
            rgba_digest = sha256_bytes(rgba.tobytes())
            alpha_box = rgba.getchannel("A").getbbox()
            width, height = rgba.size
    except (ImportError, OSError) as error:
        raise OracleError("capture target cannot be decoded by the pinned Pillow runtime") from error
    if rgba_digest != expected["rgbaSha256"]:
        raise OracleError("capture target decoded RGBA digest differs from the frozen resource")
    image_x_offset = width // 2 if image_x_offset == -1 else image_x_offset
    image_y_offset = height if image_y_offset == -1 else image_y_offset
    if resource_names != expected["resourceNames"] or image_x_offset != expected["xOffset"] or image_y_offset != expected["yOffset"]:
        raise OracleError("capture target XML resource names or anchor offsets differ from the frozen mapping")
    return {
        "targetName": target_name,
        "filename": filename,
        "path": str(asset_path),
        "pngSha256": digest,
        "rgbaSha256": rgba_digest,
        "width": width,
        "height": height,
        "alphaBBoxHalfOpen": list(alpha_box) if alpha_box else None,
        "imagesXmlSha256": sha256_bytes(xml_bytes),
        "resourceNames": resource_names,
        "xOffset": image_x_offset,
        "yOffset": image_y_offset,
    }


def parse_camera_origin(value: str | None) -> dict[str, int] | None:
    if value is None:
        return None
    parts = value.split(",")
    if len(parts) != 2 or not all(part.isdecimal() for part in parts):
        raise OracleError("expected camera origin must use nonnegative x,y integers")
    return {"x": int(parts[0]), "y": int(parts[1])}


def validate_viewport(width: int, height: int) -> tuple[int, int]:
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, int) or not isinstance(height, int):
        raise OracleError("viewport dimensions must be integers")
    if not (280 <= width <= 4096 and 240 <= height <= 4096):
        raise OracleError("viewport dimensions are outside the supported diagnostic range")
    return width, height


def continue_button_center(layout_bytes: bytes, width: int, height: int) -> tuple[int, int]:
    width, height = validate_viewport(width, height)
    try:
        root = ElementTree.fromstring(layout_bytes)
    except ElementTree.ParseError as error:
        raise OracleError("installed main menu layout is malformed") from error
    table = root.find("TableLayout")
    if table is None:
        raise OracleError("installed main menu has no table layout")
    rows, cols = int(table.attrib.get("rows", "0")), int(table.attrib.get("cols", "0"))
    if rows < 1 or cols < 1:
        raise OracleError("installed main menu table dimensions are invalid")

    def weights(tag: str, limit: int) -> list[float]:
        result = [1.0] * limit
        for item in table.findall(tag):
            index = int(item.attrib.get("row" if tag == "rowsize" else "col", "0"))
            value = float(item.attrib.get("relative", "nan"))
            if not (1 <= index <= limit) or not (value > 0):
                raise OracleError("installed main menu table proportions are invalid")
            result[index - 1] = value
        return result

    row_weights, col_weights = weights("rowsize", rows), weights("colsize", cols)
    matches = []
    for cell in table.findall("cell"):
        buttons = [node for node in list(cell) if node.tag == "Button" and node.attrib.get("name") == "ContinueButton"]
        if buttons:
            matches.append((int(cell.attrib.get("row", "0")), int(cell.attrib.get("col", "0"))))
    if len(matches) != 1:
        raise OracleError("installed main menu Continue button mapping is missing or ambiguous")
    row, col = matches[0]
    if not (1 <= row <= rows and 1 <= col <= cols):
        raise OracleError("installed main menu Continue button cell is outside the table")
    row_total, col_total = sum(row_weights), sum(col_weights)
    x = int(width * (sum(col_weights[: col - 1]) + col_weights[col - 1] / 2) / col_total)
    y = int(height * (sum(row_weights[: row - 1]) + row_weights[row - 1] / 2) / row_total)
    return x, y


def project_construction_draw(
    construction: dict[str, Any],
    camera_origin: dict[str, int],
    world_side: int,
    footprint_size: int,
    image_width: int,
    image_height: int,
    image_x_offset: int,
    image_y_offset: int,
    viewport_width: int = VIEWPORT_WIDTH,
    viewport_height: int = VIEWPORT_HEIGHT,
) -> list[int]:
    viewport_width, viewport_height = validate_viewport(viewport_width, viewport_height)
    if footprint_size < 1 or not 1 <= world_side <= 1000:
        raise OracleError("construction footprint or world dimensions are invalid")
    lower_x = construction["x"] + footprint_size - 1
    lower_y = construction["y"] + footprint_size - 1
    virtual_width = world_side * 128
    viewport_x = virtual_width / 2 + (camera_origin["x"] - camera_origin["y"]) * 64 - viewport_width / 2
    viewport_y = (camera_origin["x"] + camera_origin["y"]) * 32 + 32 - viewport_height / 2
    point_x = virtual_width / 2 + (lower_x - lower_y) * 64
    point_y = (lower_x + lower_y) * 32 + 64
    return [
        int(point_x - viewport_x - image_x_offset),
        int(point_y - viewport_y - image_y_offset),
        image_width,
        image_height,
    ]


def parse_trace(path: Path) -> list[dict[str, Any]]:
    data = read_bounded(path, MAX_TRACE_BYTES, "SDL observer trace")
    if not data.endswith(b"\n"):
        raise OracleError("SDL observer trace is truncated")
    lines = data.splitlines()
    if len(lines) > MAX_TRACE_LINES:
        raise OracleError("SDL observer trace line count exceeds the limit")
    records: list[dict[str, Any]] = []
    previous_seq = 0
    for line in lines:
        if len(line) > 4096:
            raise OracleError("SDL observer trace contains an oversized record")
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise OracleError("SDL observer trace contains invalid JSON") from error
        if not isinstance(record, dict) or not isinstance(record.get("type"), str):
            raise OracleError("SDL observer trace record shape is invalid")
        sequence = record.get("seq")
        if sequence is not None:
            if not isinstance(sequence, int) or sequence <= previous_seq:
                raise OracleError("SDL observer sequence is not strictly increasing")
            previous_seq = sequence
        records.append(record)
    return records


def _farm_target_rects(
    save: dict[str, Any], assets: list[dict[str, Any]], viewport_width: int = VIEWPORT_WIDTH,
    viewport_height: int = VIEWPORT_HEIGHT,
) -> list[dict[str, Any]]:
    viewport_width, viewport_height = validate_viewport(viewport_width, viewport_height)
    frames = assets[0]["frames"]
    if not frames:
        raise OracleError("Farm frame list is empty")
    farms = [row for row in save["constructions"] if row["type"] == "Farm"]
    if not farms:
        raise OracleError("reviewed save contains no Farm construction")
    camera = save["cameraOrigin"]
    virtual_width = save["worldSide"] * 128
    viewport_x = virtual_width / 2 + (camera["x"] - camera["y"]) * 64 - viewport_width / 2
    viewport_y = (camera["x"] + camera["y"]) * 32 + 32 - viewport_height / 2
    rects: list[dict[str, Any]] = []
    for farm in farms:
        for size in range(1, 9):
            lower_x = farm["x"] + size - 1
            lower_y = farm["y"] + size - 1
            point_x = virtual_width / 2 + (lower_x - lower_y) * 64
            point_y = (lower_x + lower_y) * 32 + 64
            for frame in frames:
                width, height = frame["width"], frame["height"]
                rects.append(
                    {
                        "type": "Farm",
                        "group": farm["group"],
                        "coordinate": [farm["x"], farm["y"]],
                        "candidateSizeFromDrawGeometry": size,
                        "expectedTextureRgbaSha256": frame["rgbaSha256"],
                        "expectedRect": [
                            int(point_x - viewport_x - width / 2),
                            int(point_y - viewport_y - height),
                            width,
                            height,
                        ],
                        "frameFilename": frame["filename"],
                    }
                )
    return rects


def analyze_trace(
    save: dict[str, Any], assets: list[dict[str, Any]], records: list[dict[str, Any]],
    viewport_width: int = VIEWPORT_WIDTH, viewport_height: int = VIEWPORT_HEIGHT,
) -> dict[str, Any]:
    viewport_width, viewport_height = validate_viewport(viewport_width, viewport_height)
    capture_start_rows = [row for row in records if row.get("type") == "capture_start"]
    capture_complete_rows = [row for row in records if row.get("type") == "capture_complete"]
    capture_start = capture_start_rows[0] if capture_start_rows else None
    capture_start_seq = capture_start.get("seq") if capture_start else None
    capture_complete = next(
        (
            row for row in records
            if row.get("type") == "capture_complete"
            and isinstance(capture_start_seq, int)
            and isinstance(row.get("seq"), int)
            and row["seq"] > capture_start_seq
        ),
        None,
    )
    capture_complete_seq = capture_complete.get("seq") if capture_complete else None
    selected_records = [
        row for row in records
        if isinstance(capture_start_seq, int)
        and isinstance(row.get("seq"), int)
        and row["seq"] > capture_start_seq
        and (not isinstance(capture_complete_seq, int) or row["seq"] <= capture_complete_seq)
    ]
    if not selected_records:
        selected_records = records
    expected = _farm_target_rects(save, assets, viewport_width, viewport_height)
    farm_hashes = {frame["rgbaSha256"]: frame for frame in assets[0]["frames"]}
    draw_matches: list[dict[str, Any]] = []
    for record in selected_records:
        if record.get("type") != "render_copy" or record.get("rgbaSha256") not in farm_hashes:
            continue
        dst = record.get("dst")
        if not isinstance(dst, list) or len(dst) != 4:
            continue
        for candidate in expected:
            if (
                record["rgbaSha256"] == candidate["expectedTextureRgbaSha256"]
                and dst == candidate["expectedRect"]
            ):
                draw_matches.append(
                    {
                        **candidate,
                        "traceSeq": record.get("seq"),
                        "frame": record.get("frame"),
                        "renderer": record.get("renderer"),
                        "targetSurface": record.get("targetSurface"),
                        "observedRect": dst,
                        "clip": record.get("clip"),
                        "blend": record.get("blend"),
                        "textureSha256": record["rgbaSha256"],
                    }
                )
    unique = {
        (
            item["coordinate"][0],
            item["coordinate"][1],
            item["candidateSizeFromDrawGeometry"],
            item["frameFilename"],
            tuple(item["expectedRect"]),
            item["renderer"],
        )
        for item in draw_matches
    }


    representative = draw_matches[0] if draw_matches else None
    visible_alpha_bbox: list[int] | None = None
    later_overlap_events: list[dict[str, Any]] = []
    later_unknown_events: list[dict[str, Any]] = []
    if representative is not None:
        asset = farm_hashes[representative["expectedTextureRgbaSha256"]]
        alpha = asset["alphaBBoxHalfOpen"]
        if alpha:
            x, y, target_width, target_height = representative["expectedRect"]
            ax0, ay0, ax1, ay1 = alpha
            clip = representative.get("clip")
            if not (isinstance(clip, list) and len(clip) == 4 and clip[2] > 0 and clip[3] > 0):
                clip = [0, 0, viewport_width, viewport_height]
            left = max(x + ax0, clip[0], 0)
            top = max(y + ay0, clip[1], 0)
            right = min(x + ax1, clip[0] + clip[2], viewport_width)
            bottom = min(y + ay1, clip[1] + clip[3], viewport_height)
            if right > left and bottom > top:
                visible_alpha_bbox = [left, top, right, bottom]
            same_renderer_matches = [
                row for row in draw_matches
                if row["renderer"] == representative["renderer"] and row["targetSurface"] == representative["targetSurface"]
                and row["frame"] == representative["frame"]
            ]
            match_sequences = sorted(row["traceSeq"] for row in same_renderer_matches if isinstance(row.get("traceSeq"), int))
            first_seq = match_sequences[0] if match_sequences else representative.get("traceSeq")
            if visible_alpha_bbox and isinstance(first_seq, int):
                bx0, by0, bx1, by1 = visible_alpha_bbox
                for row in selected_records:
                    seq = row.get("seq")
                    if not isinstance(seq, int) or seq <= first_seq or row.get("type") in NON_DRAW_TRACE_EVENT_TYPES:
                        continue
                    if row.get("renderer") != representative["renderer"]:
                        continue
                    if row.get("frame") != representative["frame"]:
                        continue
                    if row.get("type") == "render_copy":
                        rect = row.get("dst")
                        if not isinstance(rect, list) or len(rect) != 4:
                            continue
                        rx0, ry0, rw, rh = rect
                        if rw > 0 and rh > 0 and rx0 < bx1 and bx0 < rx0 + rw and ry0 < by1 and by0 < ry0 + rh:
                            later_overlap_events.append({
                                "seq": seq,
                                "type": "render_copy",
                                "rect": rect,
                                "texturePixels": "unresolved" if row.get("rgbaSha256") in {None, "unavailable"} else "fingerprinted",
                            })
                    elif row.get("type") == "render_fill_rect":
                        rect = row.get("rect")
                        if isinstance(rect, list) and len(rect) == 4 and row.get("alpha", 255) > 0:
                            rx, ry, rw, rh = rect
                            if rw > 0 and rh > 0 and rx < bx1 and bx0 < rx + rw and ry < by1 and by0 < ry + rh:
                                later_overlap_events.append({"seq": seq, "type": "render_fill_rect", "rect": [rx, ry, rx + rw, ry + rh]})
                    elif row.get("type") == "filled_polygon":
                        rect = row.get("bbox")
                        if isinstance(rect, list) and len(rect) == 4 and row.get("alpha", 255) > 0:
                            rx0, ry0, rx1, ry1 = rect
                            if rx0 < bx1 and bx0 < rx1 and ry0 < by1 and by0 < ry1:
                                later_overlap_events.append({"seq": seq, "type": "filled_polygon", "rect": rect})
                    elif row.get("type") == "render_line":
                        endpoints = row.get("from"), row.get("to")
                        if all(isinstance(point, list) and len(point) == 2 for point in endpoints) and row.get("alpha", 255) > 0:
                            x1, y1 = endpoints[0]
                            x2, y2 = endpoints[1]
                            rect = [min(x1, x2), min(y1, y2), max(x1, x2) + 1, max(y1, y2) + 1]
                            if rect[0] < bx1 and bx0 < rect[2] and rect[1] < by1 and by0 < rect[3]:
                                later_overlap_events.append({"seq": seq, "type": "render_line", "rect": rect})
                    elif row.get("type") not in NON_DRAW_TRACE_EVENT_TYPES:
                        later_unknown_events.append({"seq": seq, "type": row.get("type")})
    sizes_by_coordinate: dict[tuple[int, int], set[int]] = {}
    for item in unique:
        coordinate = (item[0], item[1])
        sizes_by_coordinate.setdefault(coordinate, set()).add(item[2])
    source_assignment_unambiguous = bool(unique) and all(len(sizes) == 1 for sizes in sizes_by_coordinate.values())
    if source_assignment_unambiguous and len(unique) == 1:
        status = "matched-one-farm-draw"
    elif source_assignment_unambiguous:
        status = "matched-farm-draw-set"
    else:
        status = "unresolved"
    return {
        "schemaVersion": "lincity-sdl-draw-analysis-v1",
        "status": status,
        "matchedTargetGeometryCount": len(unique),
        "matchedCallCount": len(draw_matches),
        "sourceObjects": [
            {
                "type": "Farm",
                "coordinate": [coordinate[0], coordinate[1]],
                "candidateSizeFromDrawGeometry": next(iter(sizes)),
            }
            for coordinate, sizes in sorted(sizes_by_coordinate.items())
            if len(sizes) == 1
        ],
        "matches": draw_matches[:32],
        "visibleAlphaBBoxHalfOpenInViewport": visible_alpha_bbox,
        "possibleLaterOverdrawCount": len(later_overlap_events),
        "possibleLaterOverdrawExamples": later_overlap_events[:24],
        "unparsedLaterDrawCount": len(later_unknown_events),
        "unparsedLaterDrawExamples": later_unknown_events[:24],
        "captureWindowCount": len(capture_start_rows),
        "captureWindowExactlyOne": len(capture_start_rows) == 1 and len(capture_complete_rows) == 1,
        "selectedFrameComplete": capture_start is not None and capture_complete is not None and len(capture_start_rows) == 1 and len(capture_complete_rows) == 1,
        "selectedFrameStartSeq": capture_start_seq,
        "selectedFrameCompleteSeq": capture_complete_seq,
        "traceCapReached": any(row.get("type") == "trace_cap" for row in records),
        "negativeInventory": "not-collected",
        "visibilityConclusion": (
            "one-complete-render-frame-collected-but-visible-pixels-not-reviewed"
            if capture_start is not None and capture_complete is not None
            else "not-established-without-complete-selected-frame-and-manual-review"
        ),
    }


def expected_target_coordinate_for_run(
    value: str | None, target_name: str, metadata_gate_required: bool,
) -> dict[str, int] | None:
    coordinate = parse_camera_origin(value)
    if coordinate is None and target_name == "Farm" and not metadata_gate_required:
        return {"x": 32, "y": 50}
    if metadata_gate_required and coordinate is None:
        raise OracleError("strict metadata gate requires an explicit target coordinate")
    return coordinate


def preflight_exit_code(
    camera_origin_matches_expected: bool, metadata_gate_required: bool,
    metadata_gate_passed: bool | None,
) -> int:
    if metadata_gate_required:
        return 0 if metadata_gate_passed is True else 2
    return 0 if camera_origin_matches_expected else 2


def verify_observed_viewport(
    records: list[dict[str, Any]], viewport_width: int, viewport_height: int,
) -> tuple[bool, list[list[int]]]:
    viewport_width, viewport_height = validate_viewport(viewport_width, viewport_height)
    starts = [row for row in records if row.get("type") == "capture_start"]
    capture_dimensions = [(row.get("width"), row.get("height")) for row in starts]
    window_dimensions = [
        (row.get("width"), row.get("height"))
        for row in records if row.get("type") == "renderer_window"
    ]
    matches = (
        len(starts) == 1
        and capture_dimensions == [(viewport_width, viewport_height)]
        and all(dimensions == (viewport_width, viewport_height) for dimensions in window_dimensions)
    )
    return matches, [list(dimensions) for dimensions in sorted(set(capture_dimensions))]


def analyze_construction_trace(
    save: dict[str, Any],
    target_name: str,
    target_asset: dict[str, Any],
    footprint_size: int,
    records: list[dict[str, Any]],
    viewport_width: int = VIEWPORT_WIDTH,
    viewport_height: int = VIEWPORT_HEIGHT,
) -> dict[str, Any]:
    viewport_width, viewport_height = validate_viewport(viewport_width, viewport_height)
    if target_name not in CONSTRUCTION_FOOTPRINTS or footprint_size != CONSTRUCTION_FOOTPRINTS[target_name]:
        raise OracleError("construction footprint must match its pinned upstream group size")
    starts = [row for row in records if row.get("type") == "capture_start"]
    completes = [row for row in records if row.get("type") == "capture_complete"]
    start_seq = starts[0].get("seq") if len(starts) == 1 else None
    end_seq = completes[0].get("seq") if len(completes) == 1 else None
    selected = [
        row for row in records
        if isinstance(start_seq, int) and isinstance(end_seq, int)
        and isinstance(row.get("seq"), int) and start_seq < row["seq"] <= end_seq
    ]
    present_count = sum(1 for row in selected if row.get("type") == "render_present")
    trace_capped = any(row.get("type") == "trace_cap" for row in records)
    constructions = [row for row in save["constructions"] if row["type"] == target_name]
    expected_hash = target_asset["rgbaSha256"]
    x_offset = target_asset["xOffset"]
    y_offset = target_asset["yOffset"]
    alpha = target_asset["alphaBBoxHalfOpen"]
    matches: list[dict[str, Any]] = []
    for construction in constructions:
        expected_rect = project_construction_draw(
            construction,
            save["cameraOrigin"],
            save["worldSide"],
            footprint_size,
            target_asset["width"],
            target_asset["height"],
            x_offset,
            y_offset,
            viewport_width,
            viewport_height,
        )
        for row in selected:
            if (
                row.get("type") == "render_copy"
                and row.get("rgbaSha256") == expected_hash
                and row.get("dst") == expected_rect
                and row.get("result") == 0
            ):
                matches.append({
                    "sourceCoordinate": [construction["x"], construction["y"]],
                    "sourceGroup": construction["group"],
                    "sourceType": target_name,
                    "sourceFootprintSize": footprint_size,
                    "sequence": row.get("seq"),
                    "frame": row.get("frame"),
                    "renderer": row.get("renderer"),
                    "targetSurface": row.get("targetSurface"),
                    "expectedDestination": expected_rect,
                    "observedDestination": row.get("dst"),
                    "clip": row.get("clip"),
                    "alphaBBoxHalfOpenInResource": alpha,
                })
    unique_matches = {
        (row["sourceCoordinate"][0], row["sourceCoordinate"][1], tuple(row["expectedDestination"]), row["renderer"], row["frame"])
        for row in matches
    }
    representative = matches[0] if matches else None
    visible_alpha: list[int] | None = None
    later_intersections: list[dict[str, Any]] = []
    unknown_later: list[dict[str, Any]] = []
    if representative is not None and isinstance(alpha, list) and len(alpha) == 4:
        x, y, width, height = representative["expectedDestination"]
        ax0, ay0, ax1, ay1 = alpha
        clip = representative["clip"]
        if not (isinstance(clip, list) and len(clip) == 4 and clip[2] > 0 and clip[3] > 0):
            clip = [0, 0, viewport_width, viewport_height]
        visible_alpha = [
            max(x + ax0, clip[0], 0),
            max(y + ay0, clip[1], 0),
            min(x + ax1, clip[0] + clip[2], viewport_width),
            min(y + ay1, clip[1] + clip[3], viewport_height),
        ]
        if visible_alpha[2] <= visible_alpha[0] or visible_alpha[3] <= visible_alpha[1]:
            visible_alpha = None
        first_seq = min(row["sequence"] for row in matches if row["renderer"] == representative["renderer"] and row["frame"] == representative["frame"])
        if visible_alpha is not None:
            bx0, by0, bx1, by1 = visible_alpha
            for row in selected:
                seq = row.get("seq")
                if not isinstance(seq, int) or seq <= first_seq or row.get("renderer") != representative["renderer"] or row.get("frame") != representative["frame"]:
                    continue
                rect: list[int] | None = None
                kind = row.get("type")
                if kind == "render_copy":
                    dst = row.get("dst")
                    if isinstance(dst, list) and len(dst) == 4:
                        rx, ry, rw, rh = dst
                        if rw > 0 and rh > 0:
                            rect = [rx, ry, rx + rw, ry + rh]
                elif kind == "render_fill_rect":
                    dst = row.get("rect")
                    if isinstance(dst, list) and len(dst) == 4 and row.get("alpha", 255) > 0:
                        rx, ry, rw, rh = dst
                        if rw > 0 and rh > 0:
                            rect = [rx, ry, rx + rw, ry + rh]
                elif kind == "filled_polygon":
                    dst = row.get("bbox")
                    if isinstance(dst, list) and len(dst) == 4 and row.get("alpha", 255) > 0:
                        rect = dst
                elif kind == "render_line":
                    endpoints = row.get("from"), row.get("to")
                    if all(isinstance(point, list) and len(point) == 2 for point in endpoints) and row.get("alpha", 255) > 0:
                        x1, y1 = endpoints[0]
                        x2, y2 = endpoints[1]
                        rect = [min(x1, x2), min(y1, y2), max(x1, x2) + 1, max(y1, y2) + 1]
                elif kind not in NON_DRAW_TRACE_EVENT_TYPES:
                    unknown_later.append({"seq": seq, "type": kind})
                if rect is not None and rect[0] < bx1 and bx0 < rect[2] and rect[1] < by1 and by0 < rect[3]:
                    later_intersections.append({"seq": seq, "type": kind, "rect": rect})
    if len(constructions) != 1:
        status = "ambiguous-source-inventory" if constructions else "target-absent-in-source-inventory"
    elif len(unique_matches) != 1:
        status = "unresolved-source-draw"
    else:
        status = "matched-one-source-draw"
    return {
        "schemaVersion": "lincity-construction-draw-analysis-v1",
        "status": status,
        "target": target_name,
        "viewport": {"width": viewport_width, "height": viewport_height},
        "sourceInventoryCount": len(constructions),
        "sourceUnique": len(constructions) == 1,
        "exactMatchCount": len(unique_matches),
        "matchedCalls": matches[:16],
        "selectedFrameComplete": len(starts) == 1 and len(completes) == 1 and present_count == 1 and not trace_capped and isinstance(start_seq, int) and isinstance(end_seq, int) and end_seq > start_seq,
        "selectedFramePresentCount": present_count,
        "traceCapReached": trace_capped,
        "selectedFrameStartSeq": start_seq,
        "selectedFrameCompleteSeq": end_seq,
        "visibleAlphaBBoxHalfOpenInViewport": visible_alpha,
        "alphaUnclipped": visible_alpha == [
            representative["expectedDestination"][0] + alpha[0],
            representative["expectedDestination"][1] + alpha[1],
            representative["expectedDestination"][0] + alpha[2],
            representative["expectedDestination"][1] + alpha[3],
        ] if representative is not None and visible_alpha is not None else False,
        "possibleLaterOverdrawIntersections": len(later_intersections),
        "possibleLaterOverdrawExamples": later_intersections[:24],
        "unparsedLaterDrawCount": len(unknown_later),
        "unparsedLaterDrawExamples": unknown_later[:24],
        "interpretation": "rectangle intersections and unknown later draw APIs are possible overdraw only; full-frame review is still required",
    }



def verify_owned_output(path: Path, artifact_root: Path = ARTIFACT_ROOT) -> Path:
    output = path.absolute()
    requested_root = artifact_root.absolute()
    allowed_roots = (ARTIFACT_ROOT.resolve(), RESUMPTION_ARTIFACT_ROOT.resolve())
    if requested_root.is_symlink() or requested_root.resolve() not in allowed_roots:
        raise OracleError("artifact root must be one of the two frozen external diagnostic roots")
    root = requested_root.resolve()
    if output.exists() or output.is_symlink():
        raise OracleError("diagnostic output already exists; use a new uniquely named path")
    parent = output.parent.resolve()
    if parent != root and root not in parent.parents:
        raise OracleError("diagnostic output must be under the external fresh-map artifact root")
    return output


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    if path.is_symlink() or path.exists():
        raise OracleError(f"refusing to overwrite diagnostic evidence: {path.name}")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _quoted(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _session_script(
    output: Path, observer: Path, app: Path, camera_action: str,
    viewport_width: int = VIEWPORT_WIDTH, viewport_height: int = VIEWPORT_HEIGHT,
    continue_x: int | None = None, continue_y: int | None = None,
    capture_native_frame: bool = False,
) -> str:
    viewport_width, viewport_height = validate_viewport(viewport_width, viewport_height)
    if continue_x is None or continue_y is None:
        if viewport_width == VIEWPORT_WIDTH and viewport_height == VIEWPORT_HEIGHT:
            continue_x, continue_y = 815, 242
        else:
            continue_x, continue_y = continue_button_center(
                read_bounded(Path("/usr/share/lincity-ng/gui/mainmenu.xml"), MAX_IMAGES_XML_BYTES, "main menu layout"),
                viewport_width, viewport_height,
            )
    if not (0 <= continue_x < viewport_width and 0 <= continue_y < viewport_height):
        raise OracleError("Continue button center is outside the viewport")
    trace = output / "sdl-trace.jsonl"
    control = output / "capture-control"
    display_file = output / "display-number"
    log = output / "app.log"
    xvfb_log = output / "xvfb.log"
    inner_lines = [
        "set -eu",
        "XVFB_PID=",
        "APP_PID=",
        "cleanup() {",
        "  status=$?",
        "  trap - EXIT INT TERM HUP",
        '  for pid in "$APP_PID" "$XVFB_PID"; do if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi; done',
        '  for pid in "$APP_PID" "$XVFB_PID"; do if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi; done',
        '  exit "$status"',
        "}",
        "trap cleanup EXIT",
        "trap 'exit 130' INT",
        "trap 'exit 143' TERM",
        "trap 'exit 129' HUP",
        f"Xvfb -displayfd 3 -screen 0 {viewport_width}x{viewport_height}x24 -noreset -nolisten tcp 3>{_quoted(str(display_file))} >{_quoted(str(xvfb_log))} 2>&1 &",
        "XVFB_PID=$!",
        "DISPLAY_ATTEMPT=0",
        f"while [ \"$DISPLAY_ATTEMPT\" -lt 50 ]; do if [ -s {_quoted(str(display_file))} ]; then break; fi; if ! kill -0 \"$XVFB_PID\" 2>/dev/null; then wait \"$XVFB_PID\" || true; exit 71; fi; DISPLAY_ATTEMPT=$((DISPLAY_ATTEMPT + 1)); sleep 0.1; done",
        f"DISPLAY_NUMBER=$(cat {_quoted(str(display_file))})",
        'case "$DISPLAY_NUMBER" in ""|*[!0-9]*) exit 72 ;; esac',
        'export DISPLAY=":$DISPLAY_NUMBER"',
        f"env LD_PRELOAD={_quoted(str(observer))} ZORYA_LINCITY_TRACE_JSONL={_quoted(str(trace))} ZORYA_LINCITY_CAPTURE_CONTROL={_quoted(str(control))} {'ZORYA_LINCITY_CAPTURE_NATIVE_FRAME=1 ZORYA_LINCITY_NATIVE_FRAME_RGBA_PATH=' + _quoted(str(output / 'native-frame.rgba')) if capture_native_frame else ''} {_quoted(str(app))} --sdl --size {viewport_width}x{viewport_height} --window --mute >{_quoted(str(log))} 2>&1 &",
        "APP_PID=$!",
        "sleep 3",
        f"xdotool mousemove --sync {continue_x} {continue_y} click 1",
    ]
    if camera_action == "none":
        inner_lines.append("sleep 3")
    elif camera_action == "farm-32-centered":
        inner_lines.extend([
            "sleep 1",
            "xdotool keydown Down",
            "sleep 0.576",
            "xdotool keyup Down",
            "xdotool keydown Right",
            "sleep 0.064",
            "xdotool keyup Right",
            "sleep 2",
        ])
    elif camera_action == "farm-43-centered":
        inner_lines.extend([
            "sleep 1",
            "xdotool keydown Down",
            "sleep 1.216",
            "xdotool keyup Down",
            "xdotool keydown Right",
            "sleep 0.704",
            "xdotool keyup Right",
            "sleep 2",
        ])
    elif camera_action == "pottery-camera-v1":
        inner_lines.extend([
            "sleep 1",
            "xdotool keydown Down",
            "sleep 0.576",
            "xdotool keyup Down",
            "xdotool keydown Left",
            "sleep 0.064",
            "xdotool keyup Left",
            "sleep 2",
        ])
    elif camera_action == "market-camera-v1":
        inner_lines.extend([
            "sleep 1",
            "xdotool keydown Down",
            "sleep 0.720",
            "xdotool keyup Down",
            "xdotool keydown Right",
            "sleep 0.256",
            "xdotool keyup Right",
            "sleep 2",
        ])
    elif camera_action == "water-tower-camera-v1":
        inner_lines.extend([
            "sleep 1",
            "xdotool keydown Down",
            "sleep 0.720",
            "xdotool keyup Down",
            "xdotool keydown Right",
            "sleep 0.384",
            "xdotool keyup Right",
            "sleep 2",
        ])
    else:
        raise OracleError("unsupported frozen camera action")
    inner_lines.extend([
        f": >{_quoted(str(control))}",
        "sleep 2",
        'kill "$APP_PID" 2>/dev/null || true',
        'wait "$APP_PID"',
        'kill "$XVFB_PID"',
        'wait "$XVFB_PID" || true',
    ])
    return "\n".join(
        [
            "#!/bin/sh",
            "set -eu",
            "mount --make-rprivate /",
            "mount -t tmpfs -o size=64m,mode=700,nosuid,nodev tmpfs /tmp",
            "mkdir -m 1777 /tmp/.X11-unix",
            f"dbus-run-session -- sh -c {_quoted(chr(10).join(inner_lines))}",
            "",
        ]
    )


def _process_group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_group_closed(pgid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _process_group_exists(pgid):
            return True
        time.sleep(0.05)
    return not _process_group_exists(pgid)


def run_preflight(args: argparse.Namespace) -> int:
    viewport_width, viewport_height = validate_viewport(args.viewport_width, args.viewport_height)
    if args.require_metadata_gate and (
        not args.expected_camera_origin or not args.expected_target_coordinate or not args.loadsave_source
        or args.camera_action != "none" or (viewport_width, viewport_height) != (800, 600)
    ):
        raise OracleError("strict metadata gate requires explicit camera, target, pinned clamp source, no camera action, and 800x600")
    if args.capture_native_frame and (not args.require_metadata_gate or (viewport_width, viewport_height) != (800, 600)):
        raise OracleError("native framebuffer capture requires the strict 800x600 metadata gate")
    output = verify_owned_output(Path(args.output), Path(args.artifact_root))
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    output.chmod(0o700)
    process: subprocess.Popen[bytes] | None = None
    try:
        save_bytes = read_bounded(Path(args.save), MAX_COMPRESSED_SAVE_BYTES, "pinned save")
        save_sha = sha256_bytes(save_bytes)
        if save_sha != args.expected_save_sha256:
            raise OracleError("pinned save digest mismatch")
        expected_camera_origin = parse_camera_origin(args.expected_camera_origin)
        save_lineage = verify_save_lineage(
            Path(args.save), save_sha, Path(args.lineage_receipt) if args.lineage_receipt else None,
        )
        save = parse_save(save_bytes)
        if save_lineage.get("cameraOrigin") is not None and save_lineage.get("cameraOrigin") != save["cameraOrigin"]:
            raise OracleError("derived save camera origin differs from its parent receipt")
        source_hashes = verify_pinned_sources(Path(args.source_root), Path(args.painter_source_root))
        loadsave_source_sha = None
        if args.loadsave_source:
            loadsave_source_bytes = read_bounded(Path(args.loadsave_source), 64 * 1024, "upstream loadsave.cpp")
            loadsave_source_sha = sha256_bytes(loadsave_source_bytes)
            if loadsave_source_sha != EXPECTED_LOADSAVE_SOURCE_SHA256:
                raise OracleError("pinned upstream loadsave.cpp hash mismatch")
        menu_layout_sha = None
        if args.require_metadata_gate:
            menu_layout_bytes = read_bounded(Path(args.main_menu_layout), MAX_IMAGES_XML_BYTES, "installed main menu layout")
            menu_layout_sha = sha256_bytes(menu_layout_bytes)
            if menu_layout_sha != EXPECTED_MENU_LAYOUT_SHA256:
                raise OracleError("pinned installed main menu layout hash mismatch")
            continue_x, continue_y = continue_button_center(menu_layout_bytes, viewport_width, viewport_height)
        elif (viewport_width, viewport_height) == (VIEWPORT_WIDTH, VIEWPORT_HEIGHT):
            continue_x, continue_y = 815, 242
        else:
            menu_layout_bytes = read_bounded(Path(args.main_menu_layout), MAX_IMAGES_XML_BYTES, "installed main menu layout")
            menu_layout_sha = sha256_bytes(menu_layout_bytes)
            continue_x, continue_y = continue_button_center(menu_layout_bytes, viewport_width, viewport_height)
        assets_nested = collect_farm_assets(Path(args.tiles_dir))
        assets = assets_nested[0]["frames"]
        capture_target_asset = verify_capture_target_asset(Path(args.tiles_dir), args.capture_target)
        license_path = Path(args.license_file)
        license_bytes = read_bounded(license_path, 512 * 1024, "installed data license")
        if license_path.resolve() != Path(assets_nested[0]["licenseFile"]).resolve():
            raise OracleError("license file path differs from the one that covers the Farm image roster")
        package_version = subprocess.run(
            ["dpkg-query", "-W", "-f=${Version}", "lincity-ng"],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        ).stdout.strip()
        if package_version != "2.10.2-1":
            raise OracleError("installed LinCity-NG package differs from the pinned version")
        farm_target = [row for row in save["constructions"] if row["type"] == "Farm" and row["x"] == 32 and row["y"] == 50]
        if len(farm_target) != 1:
            raise OracleError("the frozen diagnostic Farm target is missing or ambiguous")
        expected_target_coordinate = expected_target_coordinate_for_run(
            args.expected_target_coordinate, args.capture_target, args.require_metadata_gate,
        )
        all_target_constructions = [row for row in save["constructions"] if row["type"] == args.capture_target]
        if expected_target_coordinate is not None:
            target_constructions = [
                row for row in all_target_constructions
                if [row["x"], row["y"]] == [expected_target_coordinate["x"], expected_target_coordinate["y"]]
            ]
            if len(target_constructions) != 1 or (args.require_metadata_gate and len(all_target_constructions) != 1):
                raise OracleError("the frozen diagnostic target must be unique in the source inventory")
        observer_source = Path(args.observer_source).resolve()
        observer_digest = sha256_bytes(read_bounded(observer_source, 64 * 1024, "observer source"))
        compiler = Path(args.tcc).resolve()
        sdl_include = Path(args.sdl_include).resolve()
        tcc_libroot = Path(args.tcc_libroot).resolve()
        observer_binary = output / "sdl_observer.so"
        command = [
            str(compiler),
            f"-B{tcc_libroot}",
            "-DSDL_DISABLE_IMMINTRIN_H",
            "-shared",
            "-fPIC",
            f"-I{sdl_include.parent}",
            f"-I{sdl_include.parent / 'x86_64-linux-gnu'}",
            f"-I{sdl_include}",
            "-o",
            str(observer_binary),
            str(observer_source),
            "-ldl",
            "-lpthread",
            "/usr/lib/x86_64-linux-gnu/libSDL2-2.0.so.0",
        ]
        compile_result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=10)
        if compile_result.returncode != 0:
            _write_json(output / "compile-failure.json", {
                "status": "compile-failed",
                "exitCode": compile_result.returncode,
                "stdout": compile_result.stdout[:16_384],
                "stderr": compile_result.stderr[:16_384],
                "observerSourceSha256": observer_digest,
            })
            raise OracleError("observer compilation failed; compiler receipt retained")
        observer_sha = sha256_bytes(read_bounded(observer_binary, 4 * 1024 * 1024, "compiled observer"))
        app = Path(args.game_binary).resolve()
        app_sha = sha256_bytes(read_bounded(app, 64 * 1024 * 1024, "game binary"))
        profile = output / "private"
        home = profile / "home"
        data = profile / "data"
        config = profile / "config"
        cache = profile / "cache"
        state = profile / "state"
        data_home = data / "lincity-ng"
        for directory in (profile, home, data, config, cache, state, data_home):
            directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        save_path = data_home / "9_currentGameNG.scn.gz"
        with save_path.open("xb") as handle:
            handle.write(save_bytes)
        save_path.chmod(0o400)
        script_path = output / "session.sh"
        script_path.write_text(
            _session_script(output, observer_binary, app, args.camera_action, viewport_width, viewport_height, continue_x, continue_y, args.capture_native_frame),
            encoding="utf-8",
        )
        script_path.chmod(0o700)
        trace_path = output / "sdl-trace.jsonl"
        env = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(config),
            "XDG_DATA_HOME": str(data),
            "XDG_CACHE_HOME": str(cache),
            "XDG_STATE_HOME": str(state),
            "SDL_AUDIODRIVER": "dummy",
            "GTK_THEME": "Adwaita",
            "PYTHONDONTWRITEBYTECODE": "1",
            "ZORYA_LINCITY_TARGET_RGBA_SHA256": capture_target_asset["rgbaSha256"],
        }
        def set_child_file_limit() -> None:
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PROCESS_FILE_BYTES, MAX_PROCESS_FILE_BYTES))

        with (output / "driver.stdout").open("xb") as stdout_handle, (output / "driver.stderr").open("xb") as stderr_handle:
            process = subprocess.Popen(
                ["unshare", "--user", "--map-root-user", "--net", "--pid", "--mount", "--fork", "--kill-child", "--mount-proc", "--", "sh", str(script_path)],
                cwd=str(output),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=stdout_handle,
                stderr=stderr_handle,
                start_new_session=True,
                preexec_fn=set_child_file_limit,
            )
            timed_out = False
            try:
                try:
                    exit_code = process.wait(timeout=MAX_CASE_SECONDS)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        exit_code = process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        exit_code = process.wait(timeout=3)
            except BaseException:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=3)
                raise
        closed = _wait_group_closed(process.pid, 3)
        if not closed:
            os.killpg(process.pid, signal.SIGKILL)
            closed = _wait_group_closed(process.pid, 3)
        trace_records = parse_trace(trace_path) if trace_path.exists() and trace_path.stat().st_size else []
        postrun_save_bytes = read_bounded(save_path, MAX_COMPRESSED_SAVE_BYTES, "private save after run")
        postrun_save = parse_save(postrun_save_bytes)
        state_signature = lambda metadata: sorted(
            (row["type"], row["group"], row["x"], row["y"])
            for row in metadata["constructions"]
        )
        inventory_stable = state_signature(save) == state_signature(postrun_save)
        camera_origin_matches_expected = expected_camera_origin is None or postrun_save["cameraOrigin"] == expected_camera_origin
        analysis = analyze_trace(postrun_save, assets_nested, trace_records, viewport_width, viewport_height) if trace_records and inventory_stable else {
            "schemaVersion": "lincity-sdl-draw-analysis-v1",
            "status": "unresolved",
            "reason": "no observer records" if not trace_records else "construction inventory changed during diagnostic",
            "negativeInventory": "not-collected",
            "visibilityConclusion": "not-established",
        }
        construction_analysis = None
        if args.capture_target in CONSTRUCTION_FOOTPRINTS:
            construction_analysis = analyze_construction_trace(
                postrun_save,
                args.capture_target,
                capture_target_asset,
                CONSTRUCTION_FOOTPRINTS[args.capture_target],
                trace_records,
                viewport_width,
                viewport_height,
            )
        native_frame_capture = None
        native_frame_gate_passed = None
        if args.capture_native_frame:
            matched_calls = construction_analysis.get("matchedCalls", []) if construction_analysis else []
            target_frame = matched_calls[0].get("frame") if len(matched_calls) == 1 else None
            native_frame_capture = validate_native_frame_capture(trace_records, target_frame, output)
            native_frame_gate_passed = native_frame_capture.get("status") == "captured-and-pixel-verified"
        renderer_windows = [row for row in trace_records if row.get("type") == "renderer_window"]
        actual_viewport_matches, capture_dimensions = verify_observed_viewport(
            trace_records, viewport_width, viewport_height,
        )
        observed_dimensions = sorted({(row.get("width"), row.get("height")) for row in renderer_windows})
        expected_destination_match = bool(construction_analysis) and expected_target_coordinate is not None and any(
            row.get("sourceCoordinate") == [expected_target_coordinate["x"], expected_target_coordinate["y"]]
            and row.get("expectedDestination") == row.get("observedDestination")
            for row in construction_analysis.get("matchedCalls", [])
        )
        target_draw_matches = bool(construction_analysis) and construction_analysis.get("status") == "matched-one-source-draw" and expected_destination_match
        metadata_gate_passed = None
        if args.require_metadata_gate:
            metadata_gate_passed = (
                not timed_out and exit_code == 0 and closed and camera_origin_matches_expected and inventory_stable
                and actual_viewport_matches and target_draw_matches
                and save["constructionCount"] == 54 and postrun_save["constructionCount"] == 54
                and construction_analysis is not None
                and construction_analysis.get("selectedFrameComplete") is True
                and construction_analysis.get("traceCapReached") is False
                and construction_analysis.get("selectedFramePresentCount") == 1
                and construction_analysis.get("alphaUnclipped") is True
            )
        receipt = {
            "schemaVersion": "lincity-draw-preflight-v1",
            "status": "timed-out" if timed_out else "completed" if exit_code == 0 else "failed",
            "exitCode": exit_code,
            "ownedProcessGroupClosed": closed,
            "networkNamespaceRequested": True,
            "screenshots": 0,
            "modelCalls": 0,
            "inputSaveSha256": save_sha,
            "inputSaveLineage": save_lineage,
            "postrunPrivateSaveSha256": sha256_bytes(postrun_save_bytes),
            "cameraAction": args.camera_action,
            "inputCameraOrigin": save["cameraOrigin"],
            "postrunCameraOrigin": postrun_save["cameraOrigin"],
            "expectedCameraOrigin": expected_camera_origin,
            "cameraOriginMatchesExpected": camera_origin_matches_expected,
            "viewport": {"width": viewport_width, "height": viewport_height},
            "actualViewportMatchesRequest": actual_viewport_matches,
            "rendererWindowDimensions": [list(size) for size in observed_dimensions],
            "captureStartDimensions": capture_dimensions,
            "captureStartUsesSDLRendererOutputSize": True,
            "continueButtonCenter": {"x": continue_x, "y": continue_y},
            "mainMenuLayoutSha256": menu_layout_sha,
            "loadsaveSourceSha256": loadsave_source_sha,
            "cameraClampSource": "src/lincity/loadsave.cpp:612-617",
            "cameraClampFormula": EXPECTED_GAME_CAMERA_CLAMP,
            "expectedTarget": {
                "type": args.capture_target,
                "coordinate": [expected_target_coordinate["x"], expected_target_coordinate["y"]] if expected_target_coordinate else None,
            },
            "expectedDestinationMatchesObserved": expected_destination_match,
            "metadataGateRequired": args.require_metadata_gate,
            "metadataGatePassed": metadata_gate_passed,
            "nativeFrameCaptureRequired": args.capture_native_frame,
            "nativeFrameCapturePassed": native_frame_gate_passed,
            "nativeFrameCapture": native_frame_capture,
            "postrunConstructionInventoryMatchesInput": inventory_stable,
            "inputConstructionCount": save["constructionCount"],
            "postrunConstructionCount": postrun_save["constructionCount"],
            "packageVersion": package_version,
            "gameBinarySha256": app_sha,
            "sourceHashes": source_hashes,
            "observerSourceSha256": observer_digest,
            "observerBinarySha256": observer_sha,
            "captureTargetAsset": capture_target_asset,
            "constructionDrawAnalysis": construction_analysis,
            "licenseFileSha256": sha256_bytes(license_bytes),
            "farmAssetReceipts": assets_nested,
            "saveMetadata": save,
            "traceRecords": len(trace_records),
            "traceSha256": sha256_bytes(read_bounded(trace_path, MAX_TRACE_BYTES, "SDL observer trace")) if trace_path.exists() else None,
            "drawAnalysis": analysis,
            "limitations": [
                "This diagnostic made no screenshot or corpus case.",
                "Construction destinations are evaluated from upstream draw formulas and must not be treated as independent visibility proof.",
                "Window composition, later overlapping draw calls, and manual visual review remain required for an eventual positive case.",
                "Native framebuffer capture, when explicitly requested, proves only that the exact SDL output pixels were retained; it does not establish that the target is visible or unobstructed.",
                "No negative inventory was collected.",
            ],
        }
        _write_json(output / "receipt.json", receipt)
        if not closed:
            raise OracleError("owned process group did not close; receipt retained")
        if timed_out or exit_code != 0:
            return 2
        if args.capture_native_frame and not native_frame_gate_passed:
            return 2
        return preflight_exit_code(camera_origin_matches_expected, args.require_metadata_gate, metadata_gate_passed)
    except BaseException as error:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
        if process is not None and not _wait_group_closed(process.pid, 3):
            os.killpg(process.pid, signal.SIGKILL)
            _wait_group_closed(process.pid, 3)
        if not (output / "failure.json").exists():
            _write_json(output / "failure.json", {"status": "failed", "errorType": type(error).__name__, "message": str(error)[:2048]})
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lincity_oracle.py")
    sub = parser.add_subparsers(dest="command", required=True)
    audit = sub.add_parser("audit-save")
    audit.add_argument("--save", required=True)
    audit.add_argument("--expected-save-sha256", default=EXPECTED_SAVE_SHA256)
    audit.add_argument("--output", required=True)
    analyze = sub.add_parser("analyze-trace")
    analyze.add_argument("--save", required=True)
    analyze.add_argument("--expected-save-sha256", required=True)
    analyze.add_argument("--lineage-receipt")
    analyze.add_argument("--trace", required=True)
    analyze.add_argument("--tiles-dir", default="/usr/share/lincity-ng/images/tiles")
    analyze.add_argument("--output", required=True)
    preflight = sub.add_parser("preflight")
    preflight.add_argument("--save", required=True)
    preflight.add_argument("--expected-save-sha256", required=True)
    preflight.add_argument("--lineage-receipt")
    preflight.add_argument("--expected-camera-origin")
    preflight.add_argument("--capture-target", choices=tuple(CAPTURE_TARGET_ASSETS), default="Farm")
    preflight.add_argument("--expected-target-coordinate")
    preflight.add_argument("--require-metadata-gate", action="store_true")
    preflight.add_argument("--capture-native-frame", action="store_true")
    preflight.add_argument("--viewport-width", type=int, default=VIEWPORT_WIDTH)
    preflight.add_argument("--viewport-height", type=int, default=VIEWPORT_HEIGHT)
    preflight.add_argument("--artifact-root", default=str(ARTIFACT_ROOT))
    preflight.add_argument("--loadsave-source")
    preflight.add_argument("--main-menu-layout", default="/usr/share/lincity-ng/gui/mainmenu.xml")
    preflight.add_argument("--output", required=True)
    preflight.add_argument("--source-root", required=True)
    preflight.add_argument("--painter-source-root", required=True)
    preflight.add_argument("--tiles-dir", default="/usr/share/lincity-ng/images/tiles")
    preflight.add_argument("--license-file", default="/usr/share/lincity-ng/COPYING-data.txt")
    preflight.add_argument("--game-binary", default="/usr/games/lincity-ng")
    preflight.add_argument("--observer-source", default=str(Path(__file__).with_name("sdl_observer.c")))
    preflight.add_argument("--tcc", required=True)
    preflight.add_argument("--tcc-libroot", required=True)
    preflight.add_argument("--sdl-include", required=True)
    preflight.add_argument("--camera-action", choices=("none", "farm-32-centered", "farm-43-centered", "pottery-camera-v1", "market-camera-v1", "water-tower-camera-v1"), default="none")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "audit-save":
            path = Path(args.save)
            data = read_bounded(path, MAX_COMPRESSED_SAVE_BYTES, "pinned save")
            if sha256_bytes(data) != args.expected_save_sha256:
                raise OracleError("pinned save digest mismatch")
            metadata = parse_save(data)
            target = [row for row in metadata["constructions"] if row["type"] == "Farm" and [row["x"], row["y"]] == [32, 50]]
            if len(target) != 1:
                raise OracleError("frozen diagnostic Farm coordinate is missing or ambiguous")
            output = verify_owned_output(Path(args.output))
            output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            _write_json(output, {"save": metadata, "target": target[0]})
            return 0
        if args.command == "analyze-trace":
            save_path = Path(args.save)
            save_bytes = read_bounded(save_path, MAX_COMPRESSED_SAVE_BYTES, "pinned save")
            if sha256_bytes(save_bytes) != args.expected_save_sha256:
                raise OracleError("pinned save digest mismatch")
            verify_save_lineage(save_path, args.expected_save_sha256, Path(args.lineage_receipt) if args.lineage_receipt else None)
            save = parse_save(save_bytes)
            assets = collect_farm_assets(Path(args.tiles_dir))
            trace_path = Path(args.trace)
            trace_data = read_bounded(trace_path, MAX_TRACE_BYTES, "SDL observer trace")
            records = parse_trace(trace_path)
            analysis = analyze_trace(save, assets, records)
            output = verify_owned_output(Path(args.output))
            output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            _write_json(output, {
                "schemaVersion": "lincity-draw-analysis-receipt-v1",
                "saveSha256": save["compressedSha256"],
                "traceSha256": sha256_bytes(trace_data),
                "traceRecordCount": len(records),
                "farmAssetReceipt": assets[0],
                "analysis": analysis,
            })
            return 0
        return run_preflight(args)
    except OracleError as error:
        sys.stderr.write(f"lincity-oracle error: {error}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
