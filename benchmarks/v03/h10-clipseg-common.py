#!/usr/bin/env python3
"""Shared H10 CLIPSeg benchmark helpers (no automatic download)."""

from __future__ import annotations

import hashlib
import inspect
import io
import json
import math
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

MODEL_ID = "CIDAS/clipseg-rd64-refined"
MODEL_REVISION = "999e0328d9e10b484360c477313983f9afdd7050"
EXPECTED_CLIP_CONTEXT = 77
MAX_ENCODED_BYTES = 25_165_824
MAX_ORIENTED_PIXELS = 2_097_152
LOGITS_SIZE = 352
INTERPOLATE_POS_ENCODING = True

ASSET_FILES = (
    "config.json",
    "merges.txt",
    "model.safetensors",
    "preprocessor_config.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
    "vocab.json",
)

EXPECTED_ASSETS: dict[str, tuple[str, int]] = {
    "config.json": ("c023375966d31b3b1392764f7bd91df47098ce19f62f11b0263d8eedcf708bcd", 4732),
    "merges.txt": ("9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a", 524619),
    "model.safetensors": (
        "d00ca85d6b859f9d07b7cfb8ef26fe9771cb275b34c9368f2ecf603139307f55",
        603_049_496,
    ),
    "preprocessor_config.json": (
        "4fb09ebcfd7651205ca8299b993c30088e5535ef350a72d46c5c4580eeac0440",
        380,
    ),
    "special_tokens_map.json": (
        "c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac",
        472,
    ),
    "tokenizer_config.json": (
        "4c75d57fd9bd0be8478ad2d6f8b9cebdd4a45338eb108547329c2b6333476ca6",
        974,
    ),
    "vocab.json": (
        "e089ad92ba36837a0d31433e555c8f45fe601ab5c221d4f607ded32d9f7a4349",
        1_059_962,
    ),
}

EXPECTED_PREPROCESSOR = {
    "size": {"height": 352, "width": 352},
    "resample": 2,
    "do_resize": True,
    "do_rescale": True,
    "do_normalize": True,
    "rescale_factor": 1 / 255,
    "image_mean": [0.485, 0.456, 0.406],
    "image_std": [0.229, 0.224, 0.225],
}

EXPECTED_LAUNCHER_PID_ENV = "H10_EXPECTED_LAUNCHER_PID"
PR_SET_PDEATHSIG = 1
EXPECTED_IMAGE_PROCESSOR_CLASS = "ViTImageProcessor"
EXPECTED_IMAGE_PROCESSOR_MODULE = "transformers.models.vit.image_processing_vit"
CLIPSEG_PROCESSOR_USE_FAST = False

MANIFEST_FORBIDDEN_FIELDS = frozenset(
    {
        "stratum",
        "label",
        "truth",
        "reference_mask_path",
        "reference_box",
        "expected_mask",
        "h8_selected_mask",
        "h9_output",
        "evaluator_fields",
    }
)

WHOLE_RUN_TIMEOUT_SECONDS = 600
CASE_TIMEOUT_SECONDS = 60
MINIMAL_DEV_MANIFEST_PATH = Path("/root/work/zorya-classifier/.run/v03/h10/minimal-inputs.json")
MINIMAL_DEV_MANIFEST_SHA256 = "98e8a5e767a6604a02fec0e561fa1b0128cb76783e4a405df4cb96e4b75fd084"
READ_OVERFLOW_BYTES = MAX_ENCODED_BYTES + 1


class H10Error(RuntimeError):
    pass


def _read_expected_launcher_pid() -> int:
    raw = os.environ.get(EXPECTED_LAUNCHER_PID_ENV)
    if raw is None or not str(raw).strip():
        raise H10Error(f"missing {EXPECTED_LAUNCHER_PID_ENV} for owned worker startup")
    try:
        expected = int(str(raw).strip())
    except ValueError as error:
        raise H10Error(f"invalid {EXPECTED_LAUNCHER_PID_ENV}: {raw!r}") from error
    if expected <= 0:
        raise H10Error(f"invalid {EXPECTED_LAUNCHER_PID_ENV}: must be a positive pid")
    return expected


def enable_parent_death_signal() -> None:
    """Register SIGKILL on launcher death; exit immediately if launcher pid mismatches."""
    if sys.platform != "linux":
        raise H10Error("parent-death registration requires Linux")
    expected_launcher_pid = _read_expected_launcher_pid()
    import ctypes

    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL) != 0:
        errno = ctypes.get_errno()
        raise H10Error(f"prctl(PR_SET_PDEATHSIG, SIGKILL) failed: errno {errno}")
    if os.getppid() != expected_launcher_pid:
        os.kill(os.getpid(), signal.SIGKILL)


def load_clipseg_processor(asset_dir: Path | str) -> Any:
    from transformers import CLIPSegProcessor

    return CLIPSegProcessor.from_pretrained(
        str(asset_dir),
        local_files_only=True,
        trust_remote_code=False,
        use_fast=CLIPSEG_PROCESSOR_USE_FAST,
    )


@dataclass(frozen=True)
class OrientedSource:
    rgb: Image.Image
    width: int
    height: int
    raw_source_sha256: str
    oriented_rgb_sha256: str
    encoded_bytes: int


@dataclass(frozen=True)
class MaskResult:
    mask_u8: np.ndarray
    foreground_bounds: dict[str, int] | None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest_hex(path: Path) -> str:
    digest, _size = sha256_file(path)
    return digest


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def verify_asset_directory(asset_dir: Path) -> dict[str, dict[str, int | str]]:
    if not asset_dir.is_dir():
        raise H10Error(f"asset directory missing: {asset_dir}")
    receipts: dict[str, dict[str, int | str]] = {}
    for name in ASSET_FILES:
        path = asset_dir / name
        if not path.is_file():
            raise H10Error(f"missing pinned asset file: {name}")
        digest, size = sha256_file(path)
        expected_digest, expected_size = EXPECTED_ASSETS[name]
        if digest != expected_digest or size != expected_size:
            raise H10Error(
                f"byte lock mismatch for {name}: got {digest} {size}, "
                f"expected {expected_digest} {expected_size}"
            )
        receipts[name] = {"sha256": digest, "bytes": size}
    return receipts


def verify_preprocessor_config_on_disk(asset_dir: Path) -> dict[str, str]:
    """Hash raw JSON and verify fields present in the pinned checkpoint file."""
    config_path = asset_dir / "preprocessor_config.json"
    raw = config_path.read_bytes()
    config = json.loads(raw.decode("utf-8"))
    size = config.get("size") or {}
    if size.get("height") != 352 or size.get("width") != 352:
        raise H10Error("preprocessor size must be 352x352")
    if config.get("resample") != 2:
        raise H10Error("preprocessor resample must be 2 (PIL bilinear)")
    if config.get("do_resize") is not True:
        raise H10Error("preprocessor do_resize must be true")
    if config.get("image_mean") != EXPECTED_PREPROCESSOR["image_mean"]:
        raise H10Error("preprocessor image_mean mismatch")
    if config.get("image_std") != EXPECTED_PREPROCESSOR["image_std"]:
        raise H10Error("preprocessor image_std mismatch")
    return {"preprocessor_config_sha256": sha256_bytes(raw)}


def verify_effective_image_processor(image_processor: Any) -> dict[str, Any]:
    """Verify loaded processor class/backend and effective behavior."""
    from transformers import ViTImageProcessor

    processor_type = type(image_processor)
    if processor_type.__name__ != EXPECTED_IMAGE_PROCESSOR_CLASS:
        raise H10Error(
            f"loaded image processor class must be {EXPECTED_IMAGE_PROCESSOR_CLASS}, "
            f"got {processor_type.__name__}"
        )
    if processor_type.__module__ != EXPECTED_IMAGE_PROCESSOR_MODULE:
        raise H10Error(
            f"loaded image processor module must be {EXPECTED_IMAGE_PROCESSOR_MODULE}, "
            f"got {processor_type.__module__}"
        )
    if not isinstance(image_processor, ViTImageProcessor):
        raise H10Error(
            f"loaded image processor must be ViTImageProcessor instance, got {processor_type!r}"
        )
    size = getattr(image_processor, "size", None) or {}
    height = size.get("height") if isinstance(size, dict) else getattr(size, "height", None)
    width = size.get("width") if isinstance(size, dict) else getattr(size, "width", None)
    if height != 352 or width != 352:
        raise H10Error(f"loaded image processor size must be 352x352, got {height}x{width}")
    resample = getattr(image_processor, "resample", None)
    if int(resample) != 2:
        raise H10Error("loaded image processor resample must be 2 (PIL bilinear)")
    if getattr(image_processor, "do_resize", None) is not True:
        raise H10Error("loaded image processor do_resize must be true")
    do_rescale = getattr(image_processor, "do_rescale", True)
    do_normalize = getattr(image_processor, "do_normalize", True)
    if do_rescale is not True or do_normalize is not True:
        raise H10Error("loaded image processor must rescale and normalize")
    rescale_factor = float(getattr(image_processor, "rescale_factor", 1 / 255))
    if not math.isclose(rescale_factor, 1 / 255, rel_tol=0, abs_tol=1e-12):
        raise H10Error("loaded image processor rescale_factor must be 1/255")
    mean = list(getattr(image_processor, "image_mean", []))
    std = list(getattr(image_processor, "image_std", []))
    if mean != EXPECTED_PREPROCESSOR["image_mean"] or std != EXPECTED_PREPROCESSOR["image_std"]:
        raise H10Error("loaded image processor mean/std mismatch")
    return {
        "image_processor_class": EXPECTED_IMAGE_PROCESSOR_CLASS,
        "image_processor_module": EXPECTED_IMAGE_PROCESSOR_MODULE,
        "use_fast": CLIPSEG_PROCESSOR_USE_FAST,
        "size": {"height": 352, "width": 352},
        "resample": 2,
        "do_resize": True,
        "do_rescale": do_rescale,
        "do_normalize": do_normalize,
        "rescale_factor": rescale_factor,
        "image_mean": mean,
        "image_std": std,
    }


def verify_preprocessor_config(asset_dir: Path) -> None:
    verify_preprocessor_config_on_disk(asset_dir)


def assert_forward_accepts_interpolate_pos_encoding() -> None:
    from transformers import CLIPSegForImageSegmentation

    signature = inspect.signature(CLIPSegForImageSegmentation.forward)
    if "interpolate_pos_encoding" not in signature.parameters:
        raise H10Error("installed CLIPSeg forward lacks interpolate_pos_encoding parameter")


def load_contract(contract_path: Path) -> dict[str, Any]:
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    if contract.get("schema") != "v03-h10-clipseg-producer-contract-v1":
        raise H10Error("unsupported producer contract schema")
    return contract


def validate_manifest(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    if manifest.get("schema") != "v03-h10-input-manifest-v1":
        raise H10Error("unsupported input manifest schema")
    rows = manifest.get("rows")
    if not isinstance(rows, list) or len(rows) != 12:
        raise H10Error("manifest must contain exactly 12 rows")
    normalized: list[dict[str, Any]] = []
    seen_index: set[int] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise H10Error("manifest row must be an object")
        forbidden = MANIFEST_FORBIDDEN_FIELDS.intersection(row.keys())
        if forbidden:
            raise H10Error(f"manifest row contains forbidden fields: {sorted(forbidden)}")
        row_index = row.get("row_index")
        row_key = row.get("row_key")
        source_path = row.get("source_path")
        authored_target = row.get("authored_target")
        source_sha256 = row.get("source_sha256")
        if not isinstance(row_index, int) or row_index < 0 or row_index > 11:
            raise H10Error("row_index must be integer 0..11")
        if row_index in seen_index:
            raise H10Error("duplicate row_index in manifest")
        seen_index.add(row_index)
        if not isinstance(row_key, str) or not row_key:
            raise H10Error("row_key must be a non-empty string")
        if not isinstance(source_path, str) or not source_path:
            raise H10Error("source_path must be a non-empty string")
        if not isinstance(authored_target, str) or not authored_target:
            raise H10Error("authored_target must be a non-empty string")
        if source_sha256 is not None:
            if not isinstance(source_sha256, str) or len(source_sha256) != 64:
                raise H10Error("source_sha256 must be a 64-char hex string when present")
        entry: dict[str, Any] = {
            "row_index": row_index,
            "row_key": row_key,
            "source_path": source_path,
            "authored_target": authored_target,
        }
        if source_sha256 is not None:
            entry["source_sha256"] = source_sha256
        normalized.append(entry)
    if seen_index != set(range(12)):
        raise H10Error("manifest row_index must cover 0..11 exactly once")
    normalized.sort(key=lambda item: item["row_index"])
    return normalized


def read_bounded_file_bytes(source_path: Path) -> bytes:
    with source_path.open("rb") as handle:
        encoded = handle.read(READ_OVERFLOW_BYTES)
    if len(encoded) > MAX_ENCODED_BYTES:
        raise H10Error(
            f"encoded source exceeds {MAX_ENCODED_BYTES} bytes before decode: {len(encoded)}"
        )
    return encoded


def exif_orientation_tag(image: Image.Image) -> int:
    """Read orientation without decoding pixel buffers when possible."""
    if image.format == "PNG" and "exif" not in image.info:
        return 1
    try:
        exif = image.getexif()
        if exif:
            return int(exif.get(274, 1) or 1)
    except (AttributeError, TypeError, ValueError):
        return 1
    return 1


def oriented_dimensions_from_header(encoded: bytes) -> tuple[int, int]:
    """Inspect container header + EXIF orientation only; do not decode pixel buffers."""
    try:
        with Image.open(io.BytesIO(encoded)) as image:
            width, height = image.size
            orientation = exif_orientation_tag(image)
    except OSError as error:
        raise H10Error(f"corrupt or unreadable source image header: {error}") from error
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    pixels = width * height
    if pixels > MAX_ORIENTED_PIXELS:
        raise H10Error(
            f"oriented source pixels {pixels} exceed cap {MAX_ORIENTED_PIXELS} ({width}x{height})"
        )
    return width, height


def oriented_dimensions_from_encoded(encoded: bytes) -> tuple[int, int]:
    return oriented_dimensions_from_header(encoded)


def read_oriented_source(
    source_path: Path,
    expected_raw_sha256: str | None = None,
) -> OrientedSource:
    encoded = read_bounded_file_bytes(source_path)
    raw_source_sha256 = sha256_bytes(encoded)
    if expected_raw_sha256 is not None and raw_source_sha256 != expected_raw_sha256:
        raise H10Error(
            f"source byte SHA-256 mismatch: got {raw_source_sha256}, expected {expected_raw_sha256}"
        )
    oriented_dimensions_from_header(encoded)
    try:
        with Image.open(io.BytesIO(encoded)) as image:
            rgb = ImageOps.exif_transpose(image.convert("RGB"))
            rgb.load()
    except OSError as error:
        raise H10Error(f"corrupt or unreadable source image: {error}") from error
    width, height = rgb.size
    pixels = width * height
    if pixels > MAX_ORIENTED_PIXELS:
        raise H10Error(
            f"oriented source pixels {pixels} exceed cap {MAX_ORIENTED_PIXELS} ({width}x{height})"
        )
    oriented_rgb_sha256 = sha256_bytes(np.asarray(rgb, dtype=np.uint8).tobytes())
    return OrientedSource(
        rgb=rgb,
        width=width,
        height=height,
        raw_source_sha256=raw_source_sha256,
        oriented_rgb_sha256=oriented_rgb_sha256,
        encoded_bytes=len(encoded),
    )


def select_logits_plane(logits: torch.Tensor) -> torch.Tensor:
    if logits.shape != (1, LOGITS_SIZE, LOGITS_SIZE):
        raise H10Error(f"logits must be shape [1,{LOGITS_SIZE},{LOGITS_SIZE}], got {tuple(logits.shape)}")
    plane = logits[0]
    if plane.shape != (LOGITS_SIZE, LOGITS_SIZE):
        raise H10Error(f"logits batch element must be {LOGITS_SIZE}x{LOGITS_SIZE}")
    return plane


def encode_target_or_reject(tokenizer: Any, authored_target: str) -> tuple[Any, int]:
    model_max_length = int(getattr(tokenizer, "model_max_length", 0) or 0)
    if model_max_length <= 0:
        raise H10Error("tokenizer model_max_length is missing")
    if model_max_length != EXPECTED_CLIP_CONTEXT:
        raise H10Error(
            f"tokenizer model_max_length {model_max_length} != expected {EXPECTED_CLIP_CONTEXT}"
        )
    encoded = tokenizer(
        authored_target,
        truncation=False,
        padding=False,
        return_attention_mask=True,
        return_tensors=None,
    )
    input_ids = encoded["input_ids"]
    if input_ids and isinstance(input_ids[0], list):
        length = len(input_ids[0])
    else:
        length = len(input_ids)
    if length > model_max_length:
        raise H10Error(
            f"authored target token length {length} exceeds model_max_length {model_max_length}"
        )
    padded = tokenizer(
        authored_target,
        truncation=False,
        padding="max_length",
        max_length=model_max_length,
        return_tensors="pt",
    )
    return padded, model_max_length


def synthetic_logits_for_target(target: str, width: int, height: int) -> torch.Tensor:
    """Deterministic 352x352 logits for offline tests (not model output)."""
    del width, height
    grid = torch.zeros((LOGITS_SIZE, LOGITS_SIZE), dtype=torch.float32)
    if target == "__ALL_NEG__":
        grid.fill_(-1.0)
        return grid
    if target == "__ZERO_BOUNDARY__":
        grid.fill_(-1.0)
        grid[LOGITS_SIZE // 2, LOGITS_SIZE // 2] = 0.0
        return grid
    if target == "__POS_RAMP__":
        ys = torch.linspace(-1.0, 1.0, LOGITS_SIZE)
        xs = torch.linspace(-1.0, 1.0, LOGITS_SIZE)
        yy, xx = torch.meshgrid(ys, xs, indexing="ij")
        return yy + xx
    if target == "__CORRUPT__":
        raise H10Error("synthetic corrupt marker")
    grid.fill_(-2.0)
    grid[8:40, 8:40] = 1.0
    return grid


def logits_to_mask(logits_352: torch.Tensor, height: int, width: int) -> MaskResult:
    if logits_352.ndim != 2:
        raise H10Error(f"logits must be 2D, got shape {tuple(logits_352.shape)}")
    if logits_352.shape != (LOGITS_SIZE, LOGITS_SIZE):
        raise H10Error(f"logits must be {LOGITS_SIZE}x{LOGITS_SIZE}, got {tuple(logits_352.shape)}")
    if not torch.isfinite(logits_352).all():
        raise H10Error("logits contain non-finite values")
    tensor = logits_352.unsqueeze(0).unsqueeze(0).to(dtype=torch.float32)
    resized = F.interpolate(tensor, size=(height, width), mode="bilinear", align_corners=False)
    flat = resized.squeeze(0).squeeze(0)
    mask = (flat >= 0).to(dtype=torch.uint8).cpu().numpy()
    if mask.shape != (height, width):
        raise H10Error("mask shape mismatch after resize")
    foreground = np.argwhere(mask > 0)
    if foreground.size == 0:
        return MaskResult(mask_u8=mask, foreground_bounds=None)
    ys = foreground[:, 0]
    xs = foreground[:, 1]
    bounds = {
        "x_min": int(xs.min()),
        "y_min": int(ys.min()),
        "x_max": int(xs.max()),
        "y_max": int(ys.max()),
    }
    return MaskResult(mask_u8=mask, foreground_bounds=bounds)


def write_mask_png(path: Path, mask_u8: np.ndarray) -> str:
    if mask_u8.dtype != np.uint8:
        raise H10Error("mask must be uint8")
    png = Image.fromarray(mask_u8 * 255, mode="L")
    path.parent.mkdir(parents=True, exist_ok=True)
    png.save(path, format="PNG")
    png.close()
    digest, _ = sha256_file(path)
    return digest


def cuda_runtime_details() -> dict[str, Any]:
    if not torch.cuda.is_available():
        return {"cuda_available": False}
    device_index = torch.cuda.current_device()
    return {
        "cuda_available": True,
        "cuda_device_index": device_index,
        "cuda_device_name": torch.cuda.get_device_name(device_index),
        "cuda_version": torch.version.cuda,
    }


def read_cuda_peak_bytes(device: torch.device) -> dict[str, int | None]:
    if device.type != "cuda" or not torch.cuda.is_available():
        return {"peak_allocated_bytes": None, "peak_reserved_bytes": None}
    return {
        "peak_allocated_bytes": int(torch.cuda.max_memory_allocated(device)),
        "peak_reserved_bytes": int(torch.cuda.max_memory_reserved(device)),
    }


def reset_cuda_peak(device: torch.device) -> None:
    if device.type == "cuda" and torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats(device)


def collect_runtime_receipt(python_executable: Path) -> dict[str, Any]:
    import subprocess

    completed = subprocess.run(
        [
            str(python_executable),
            "-c",
            (
                "import platform, numpy, PIL, torch, transformers; "
                "print(platform.python_version()); "
                "print(torch.__version__); "
                "print(transformers.__version__); "
                "print(PIL.__version__); "
                "print(numpy.__version__); "
                "print('1' if torch.cuda.is_available() else '0'); "
                "print(torch.version.cuda or '')"
            ),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    lines = completed.stdout.strip().splitlines()
    receipt: dict[str, Any] = {
        "python_executable": str(python_executable),
        "python_version": lines[0] if lines else "unknown",
        "torch": lines[1] if len(lines) > 1 else "unknown",
        "transformers": lines[2] if len(lines) > 2 else "unknown",
        "pillow": lines[3] if len(lines) > 3 else "unknown",
        "numpy": lines[4] if len(lines) > 4 else "unknown",
        "platform": __import__("platform").platform(),
        "cuda_available": (lines[5] if len(lines) > 5 else "0") == "1",
        "cuda_version": lines[6] if len(lines) > 6 else "",
    }
    return receipt


def validate_frozen_sources(rows: list[dict[str, Any]]) -> dict[str, str]:
    receipts: dict[str, str] = {}
    for row in rows:
        source_path = Path(row["source_path"])
        expected = row.get("source_sha256")
        digest, size = sha256_file(source_path)
        if size > MAX_ENCODED_BYTES:
            raise H10Error(f"frozen source exceeds byte cap: {source_path}")
        if isinstance(expected, str) and digest != expected:
            raise H10Error(
                f"frozen source SHA-256 mismatch for {row['row_key']}: got {digest}, expected {expected}"
            )
        oriented_dimensions_from_header(read_bounded_file_bytes(source_path))
        receipts[str(source_path)] = digest
    return receipts


def revalidate_freeze_closure(
    freeze: Mapping[str, Any],
    *,
    freeze_path: Path,
    python_executable: Path,
    worker_script: Path,
    runner_script: Path,
    contract_path: Path | None = None,
) -> list[dict[str, Any]]:
    if freeze.get("schema") != "v03-h10-clipseg-freeze-v1":
        raise H10Error("unsupported freeze schema")
    expected_recipe = {
        "interpolate_pos_encoding": INTERPOLATE_POS_ENCODING,
        "threshold": "logit >= 0",
        "logits_grid": LOGITS_SIZE,
        "max_encoded_bytes": MAX_ENCODED_BYTES,
        "max_oriented_pixels": MAX_ORIENTED_PIXELS,
    }
    if freeze.get("recipe") != expected_recipe:
        raise H10Error("immutable recipe differs from accepted H10 method")
    manifest_path = Path(str(freeze["manifest_path"])).resolve()
    if file_digest_hex(manifest_path) != freeze["manifest_sha256"]:
        raise H10Error("manifest bytes changed since freeze")
    if manifest_path.resolve() == MINIMAL_DEV_MANIFEST_PATH.resolve():
        if freeze["manifest_sha256"] != MINIMAL_DEV_MANIFEST_SHA256:
            raise H10Error("minimal DEV manifest SHA-256 mismatch")
    contract = Path(str(freeze["contract_path"])).resolve()
    if contract_path is not None and contract_path.resolve() != contract:
        raise H10Error("contract path does not match freeze")
    if file_digest_hex(contract) != freeze["contract_sha256"]:
        raise H10Error("contract bytes changed since freeze")
    load_contract(contract)
    asset_dir = Path(str(freeze["asset_dir"])).resolve()
    live_assets = verify_asset_directory(asset_dir)
    if live_assets != freeze["asset_receipts"]:
        raise H10Error("asset receipts changed since freeze")
    on_disk = verify_preprocessor_config_on_disk(asset_dir)
    if on_disk != freeze["preprocessor_on_disk"]:
        raise H10Error("preprocessor on-disk hash changed since freeze")
    assert_forward_accepts_interpolate_pos_encoding()
    processor = load_clipseg_processor(asset_dir)
    effective = verify_effective_image_processor(processor.image_processor)
    if effective != freeze["effective_processor"]:
        raise H10Error("effective processor changed since freeze")
    runtime = {
        **collect_runtime_receipt(python_executable),
        "cuda_device": cuda_runtime_details(),
    }
    if runtime != freeze["runtime"]:
        raise H10Error("runtime versions changed since freeze")
    if file_digest_hex(Path(__file__).resolve()) != freeze["common_script_sha256"]:
        raise H10Error("common script changed since freeze")
    if file_digest_hex(runner_script) != freeze["runner_script_sha256"]:
        raise H10Error("runner script changed since freeze")
    if file_digest_hex(worker_script) != freeze["worker_script_sha256"]:
        raise H10Error("worker script changed since freeze")
    manifest_payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = validate_manifest(manifest_payload)
    frozen_rows = freeze.get("rows")
    if rows != frozen_rows:
        raise H10Error("manifest rows differ from frozen row snapshot")
    validate_frozen_sources(rows)
    return rows


def build_external_asset_manifest(asset_dir: Path, manifest_path: Path) -> str:
    receipts = verify_asset_directory(asset_dir)
    verify_preprocessor_config(asset_dir)
    payload = {
        "schema": "v03-h10-clipseg-external-asset-manifest-v1",
        "model_id": MODEL_ID,
        "revision": MODEL_REVISION,
        "canonical_base_url": "https://huggingface.co/CIDAS/clipseg-rd64-refined",
        "revision_tree_url": (
            "https://huggingface.co/CIDAS/clipseg-rd64-refined/tree/"
            + MODEL_REVISION
        ),
        "asset_directory": str(asset_dir.resolve()),
        "files": [
            {
                "path": name,
                **receipts[name],
                "resolve_url": (
                    f"https://huggingface.co/CIDAS/clipseg-rd64-refined/resolve/"
                    f"{MODEL_REVISION}/{name}"
                ),
            }
            for name in ASSET_FILES
        ],
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    manifest_path.write_text(text, encoding="utf-8")
    return sha256_bytes(text.encode("utf-8"))
