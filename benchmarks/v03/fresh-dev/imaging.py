"""Orientation-normalized JPEG decode, RGB fingerprints, and deterministic pHash."""
from __future__ import annotations

import hashlib
import io
import math
import struct
import zlib

from validation import (
    CurateError,
    PERCEPTUAL_HASH_ALGORITHM_ID,
    PERCEPTUAL_HASH_RESAMPLER,
)

MAX_JPEG_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 2_097_152
PHASH_SIZE = 32
PHASH_DCT_LOW = 8


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def perceptual_hash_contract_id() -> str:
    return PERCEPTUAL_HASH_ALGORITHM_ID


def perceptual_hash_resampler_id() -> str:
    return PERCEPTUAL_HASH_RESAMPLER


def _require_pillow():
    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        raise CurateError("Pillow is required for image decode") from error
    return Image, ImageOps


def runtime_pillow_version() -> str:
    try:
        import PIL
    except ImportError as error:
        raise CurateError("Pillow is required for image decode") from error
    _require_pillow()
    return PIL.__version__


def _inspect_jpeg_canvas_before_transpose(jpeg_bytes: bytes) -> tuple[int, int]:
    if len(jpeg_bytes) > MAX_JPEG_BYTES:
        raise CurateError("JPEG exceeds byte cap")
    if not jpeg_bytes.startswith(b"\xff\xd8"):
        raise CurateError("not a JPEG")
    Image, _ImageOps = _require_pillow()
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as image:
            width, height = image.size
    except OSError as error:
        raise CurateError("JPEG header inspection failed") from error
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise CurateError("decoded JPEG canvas exceeds pixel cap")
    return width, height


def decode_jpeg_rgb_normalized(jpeg_bytes: bytes) -> tuple[bytes, int, int]:
    _inspect_jpeg_canvas_before_transpose(jpeg_bytes)
    Image, ImageOps = _require_pillow()
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as image:
            oriented = ImageOps.exif_transpose(image)
            rgb = oriented.convert("RGB")
            width, height = rgb.size
    except OSError as error:
        raise CurateError("JPEG decode failed") from error
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise CurateError("decoded JPEG canvas exceeds pixel cap")
    return rgb.tobytes(), width, height


def decoded_rgb_sha256(jpeg_bytes: bytes) -> tuple[str, int, int]:
    rgb, width, height = decode_jpeg_rgb_normalized(jpeg_bytes)
    return sha256_bytes(rgb), width, height


def _dct1(values: list[float]) -> list[float]:
    size = len(values)
    out: list[float] = []
    factor = math.pi / (2.0 * size)
    for k in range(size):
        total = 0.0
        for index, value in enumerate(values):
            total += value * math.cos((2 * index + 1) * k * factor)
        scale = math.sqrt(1.0 / size) if k == 0 else math.sqrt(2.0 / size)
        out.append(total * scale)
    return out


def _dct2(block: list[list[float]]) -> list[list[float]]:
    rows = len(block)
    cols = len(block[0])
    temp = [_dct1(row) for row in block]
    transposed = [[temp[row][col] for row in range(rows)] for col in range(cols)]
    result_cols = [_dct1(col) for col in transposed]
    return [[result_cols[col][row] for col in range(cols)] for row in range(rows)]


def _grayscale_32x32(rgb_bytes: bytes, width: int, height: int) -> list[list[float]]:
    if len(rgb_bytes) != width * height * 3:
        raise CurateError("RGB buffer length mismatch")
    Image, _ImageOps = _require_pillow()
    image = Image.frombytes("RGB", (width, height), rgb_bytes)
    resized = image.resize((PHASH_SIZE, PHASH_SIZE), Image.Resampling.BICUBIC)
    pixels = list(resized.getdata())
    block: list[list[float]] = []
    for row in range(PHASH_SIZE):
        start = row * PHASH_SIZE
        block.append([float(sum(pixel) / 3.0) for pixel in pixels[start : start + PHASH_SIZE]])
    return block


def perceptual_hash64_from_rgb(rgb_bytes: bytes, width: int, height: int) -> int:
    block = _grayscale_32x32(rgb_bytes, width, height)
    coeffs = _dct2(block)
    low: list[float] = []
    for row in range(PHASH_DCT_LOW):
        for col in range(PHASH_DCT_LOW):
            if row == 0 and col == 0:
                continue
            low.append(coeffs[row][col])
    if len(low) != 63:
        raise CurateError("pHash coefficient block size mismatch")
    median = sorted(low)[len(low) // 2]
    value = 0
    bit_index = 0
    for row in range(PHASH_DCT_LOW):
        for col in range(PHASH_DCT_LOW):
            if row == 0 and col == 0:
                continue
            if coeffs[row][col] > median:
                value |= 1 << bit_index
            bit_index += 1
    if bit_index != 63:
        raise CurateError("pHash bit packing mismatch")
    return value


def perceptual_hash64_from_jpeg(jpeg_bytes: bytes) -> tuple[int, str, int, int]:
    rgb, width, height = decode_jpeg_rgb_normalized(jpeg_bytes)
    digest = sha256_bytes(rgb)
    return perceptual_hash64_from_rgb(rgb, width, height), digest, width, height


def hamming_distance64(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def png_ihdr_dimensions(png_bytes: bytes) -> tuple[int, int]:
    width, height, _bit_depth, _color_type = png_ihdr_metadata(png_bytes)
    return width, height


def png_ihdr_metadata(png_bytes: bytes) -> tuple[int, int, int, int]:
    if len(png_bytes) < 24 or png_bytes[:8] != b"\x89PNG\r\n\x1a\n":
        raise CurateError("invalid PNG signature")
    if png_bytes[12:16] != b"IHDR":
        raise CurateError("PNG missing IHDR")
    width = struct.unpack(">I", png_bytes[16:20])[0]
    height = struct.unpack(">I", png_bytes[20:24])[0]
    bit_depth = png_bytes[24]
    color_type = png_bytes[25]
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise CurateError("PNG IHDR dimensions out of bounds")
    return width, height, bit_depth, color_type


def _read_png_chunks(png_bytes: bytes) -> None:
    offset = 8
    saw_ihdr = False
    saw_iend = False
    while offset + 12 <= len(png_bytes):
        length = struct.unpack(">I", png_bytes[offset : offset + 4])[0]
        chunk_type = png_bytes[offset + 4 : offset + 8]
        data_start = offset + 8
        data_end = data_start + length
        if data_end + 4 > len(png_bytes):
            raise CurateError("truncated PNG chunk")
        chunk_data = png_bytes[data_start:data_end]
        crc_expected = struct.unpack(">I", png_bytes[data_end : data_end + 4])[0]
        crc_actual = zlib.crc32(chunk_type)
        crc_actual = zlib.crc32(chunk_data, crc_actual) & 0xFFFFFFFF
        if crc_actual != crc_expected:
            raise CurateError("PNG chunk CRC mismatch")
        if chunk_type == b"IHDR":
            if saw_ihdr:
                raise CurateError("PNG duplicate IHDR chunk")
            saw_ihdr = True
        if chunk_type == b"IEND":
            if saw_iend:
                raise CurateError("PNG duplicate IEND chunk")
            saw_iend = True
            trailing = png_bytes[data_end + 4 :]
            if trailing:
                raise CurateError("PNG trailing bytes after IEND")
            if not saw_ihdr:
                raise CurateError("PNG missing IHDR")
            return
        offset = data_end + 4
    raise CurateError("PNG missing IEND")


def _png_exif_orientation_is_identity(png_bytes: bytes) -> None:
    Image, _ImageOps = _require_pillow()
    try:
        with Image.open(io.BytesIO(png_bytes)) as image:
            exif = image.getexif()
            if not exif:
                return
            orientation = exif.get(274)
            if orientation not in (None, 1):
                raise CurateError("mask PNG EXIF orientation must be identity")
    except OSError as error:
        raise CurateError("PNG EXIF inspection failed") from error


def decode_png_grayscale_values(png_bytes: bytes) -> tuple[bytes, int, int]:
    if len(png_bytes) > 8 * 1024 * 1024:
        raise CurateError("PNG exceeds byte cap")
    _read_png_chunks(png_bytes)
    width, height, bit_depth, color_type = png_ihdr_metadata(png_bytes)
    if color_type != 0:
        raise CurateError("mask PNG IHDR color type must be grayscale")
    if bit_depth not in (1, 8):
        raise CurateError("mask PNG IHDR bit depth must be 1 or 8")
    _png_exif_orientation_is_identity(png_bytes)
    Image, _ImageOps = _require_pillow()
    try:
        with Image.open(io.BytesIO(png_bytes)) as image:
            gray = image.convert("L")
            decoded_width, decoded_height = gray.size
            if decoded_width != width or decoded_height != height:
                raise CurateError("mask PNG decode canvas mismatch")
            if decoded_width * decoded_height > MAX_IMAGE_PIXELS:
                raise CurateError("PNG decoded canvas exceeds pixel cap")
            pixels = gray.tobytes()
    except OSError as error:
        raise CurateError("PNG decode failed") from error
    if any(value not in (0, 255) for value in pixels):
        raise CurateError("mask PNG is not binary grayscale")
    return pixels, width, height


def mask_nonzero_half_open_bounds(pixels: bytes, width: int, height: int) -> list[int]:
    if len(pixels) != width * height:
        raise CurateError("mask pixel buffer length mismatch")
    xs: list[int] = []
    ys: list[int] = []
    for index, value in enumerate(pixels):
        if value == 0:
            continue
        xs.append(index % width)
        ys.append(index // width)
    if not xs:
        raise CurateError("mask has no foreground pixels")
    return [min(xs), min(ys), max(xs) + 1, max(ys) + 1]
