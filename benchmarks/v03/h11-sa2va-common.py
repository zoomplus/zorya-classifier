#!/usr/bin/env python3
"""Shared H11 Sa2VA benchmark helpers (no automatic download)."""

from __future__ import annotations

import ast
import fnmatch
import hashlib
import importlib.util
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

import numpy as np

_H10_COMMON_PATH = Path(__file__).with_name("h10-clipseg-common.py")
_h10_spec = importlib.util.spec_from_file_location("h10_clipseg_common_h11", _H10_COMMON_PATH)
if _h10_spec is None or _h10_spec.loader is None:
    raise RuntimeError("failed to load h10-clipseg-common.py")
h10 = importlib.util.module_from_spec(_h10_spec)
sys.modules[_h10_spec.name] = h10
_h10_spec.loader.exec_module(h10)

CONTRACT_SCHEMA = "v03-h11-sa2va-producer-contract-v1"
FREEZE_SCHEMA = "v03-h11-sa2va-freeze-v1"
RUN_SCHEMA = "v03-h11-sa2va-run-v1"

MODEL_ID = "ByteDance/Sa2VA-Qwen3-VL-2B"
MODEL_REVISION = "173fb6512b3ad6f3c1fe25efa09e723d01d5b6d4"

SAM2_PINNED_REL_PATH = "sam2.py"
CONTRACT_PATH = Path(__file__).with_name("h11-sa2va-contract.json")

MINIMAL_DEV_MANIFEST_PATH = Path("/root/work/zorya-classifier/.run/v03/h10/minimal-inputs.json")
MINIMAL_DEV_MANIFEST_SHA256 = "98e8a5e767a6604a02fec0e561fa1b0128cb76783e4a405df4cb96e4b75fd084"

MAX_ENCODED_BYTES = h10.MAX_ENCODED_BYTES
MAX_ORIENTED_PIXELS = h10.MAX_ORIENTED_PIXELS
WHOLE_RUN_TIMEOUT_SECONDS = 600
CASE_TIMEOUT_SECONDS = 60

GENERATION_MAX_NEW_TOKENS = 128
GENERATION_DO_SAMPLE = False

RETAIN_MASK_MAX_COUNT = 8
RETAIN_MASK_MAX_BYTES_PER_ROW = 16 * 1024 * 1024

PROMPT_TEMPLATE = (
    "<image>Segment one visible object matching the description below. "
    "If no such object is visible, answer not found and do not produce a segmentation mask. "
    "If several objects match, segment one of them.\n"
    "Object description: {authored_target}"
)
PROMPT_TEMPLATE_SHA256 = hashlib.sha256(PROMPT_TEMPLATE.encode("utf-8")).hexdigest()

EXPECTED_PROCESSOR_CLASS = "Qwen3VLProcessor"
EXPECTED_PROCESSOR_MODULE = "transformers.models.qwen3_vl.processing_qwen3_vl"
EXPECTED_IMAGE_PROCESSOR_CLASS = "Qwen2VLImageProcessor"
EXPECTED_IMAGE_PROCESSOR_MODULE = "transformers.models.qwen2_vl.image_processing_qwen2_vl"
PROCESSOR_USE_FAST = False

EXPECTED_PYTHON_VERSION = "3.12.3"
EXPECTED_TORCH_VERSION = "2.6.0+cu124"
EXPECTED_TRANSFORMERS_VERSION = "4.57.3"

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
        "h10_output",
        "evaluator_fields",
    }
)

SAFE_ROW_KEY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

H11_STRIP_WORKER_FIELDS = frozenset(
    {
        "interpolate_pos_encoding",
        "type",
        "encoded_bytes",
        "model_max_length",
        "prep_ms",
        "forward_ms",
        "post_ms",
        "retained_mask_indices",
        "traceback",
    }
)


class H11Error(RuntimeError):
    pass


@dataclass(frozen=True)
class GenerationRecord:
    token_count: int
    stopped_on_eos: bool
    truncated: bool
    max_new_tokens_applied: int
    do_sample_applied: bool


@dataclass(frozen=True)
class CandidateMaskRecord:
    emission_index: int
    path: str
    sha256: str
    byte_count: int
    width: int
    height: int
    foreground_bounds: dict[str, int] | None


def sha256_bytes(data: bytes) -> str:
    return h10.sha256_bytes(data)


def sha256_file(path: Path) -> tuple[str, int]:
    return h10.sha256_file(path)


def file_digest_hex(path: Path) -> str:
    return h10.file_digest_hex(path)


def read_oriented_source(source_path: Path, expected_raw_sha256: str | None = None) -> h10.OrientedSource:
    return h10.read_oriented_source(source_path, expected_raw_sha256=expected_raw_sha256)


def read_bounded_file_bytes(source_path: Path) -> bytes:
    return h10.read_bounded_file_bytes(source_path)


def load_contract(contract_path: Path) -> dict[str, Any]:
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    if contract.get("schema") != CONTRACT_SCHEMA:
        raise H11Error("unsupported H11 producer contract schema")
    return contract


def contract_required_files(contract: Mapping[str, Any]) -> dict[str, tuple[str, int]]:
    files = contract.get("required_model_files")
    if not isinstance(files, list):
        raise H11Error("contract missing required_model_files")
    receipts: dict[str, tuple[str, int]] = {}
    for entry in files:
        if not isinstance(entry, dict):
            raise H11Error("required_model_files entry must be an object")
        rel = entry.get("path")
        digest = entry.get("sha256")
        size = entry.get("bytes")
        if not isinstance(rel, str) or not rel:
            raise H11Error("required_model_files.path must be a non-empty string")
        if not isinstance(digest, str) or len(digest) != 64:
            raise H11Error(f"required_model_files sha256 invalid for {rel}")
        if not isinstance(size, int) or size < 0:
            raise H11Error(f"required_model_files bytes invalid for {rel}")
        receipts[rel] = (digest, size)
    return receipts


def _path_matches_forbidden(rel_posix: str, pattern: str) -> bool:
    if "**" in pattern:
        return fnmatch.fnmatch(rel_posix, pattern)
    if pattern.startswith("**"):
        return fnmatch.fnmatch(Path(rel_posix).name, pattern.replace("**/", ""))
    return fnmatch.fnmatch(rel_posix, pattern) or fnmatch.fnmatch(Path(rel_posix).name, pattern)


def verify_asset_directory(asset_dir: Path, contract: Mapping[str, Any]) -> dict[str, dict[str, int | str]]:
    if not asset_dir.is_dir():
        raise H11Error(f"asset directory missing: {asset_dir}")
    expected = contract_required_files(contract)
    excluded = contract.get("explicitly_excluded_artifacts")
    patterns: list[str] = []
    if isinstance(excluded, dict):
        raw = excluded.get("patterns")
        if isinstance(raw, list):
            patterns = [str(item) for item in raw]

    observed: set[str] = set()
    for root, dirnames, filenames in os.walk(asset_dir):
        dirnames[:] = [name for name in dirnames if name != "__pycache__"]
        for name in filenames:
            full = Path(root) / name
            rel = full.relative_to(asset_dir).as_posix()
            if "__pycache__" in rel.split("/"):
                raise H11Error(f"forbidden artifact under asset tree: {rel}")
            for pattern in patterns:
                if _path_matches_forbidden(rel, pattern):
                    raise H11Error(f"forbidden artifact present: {rel}")
            if full.is_symlink():
                raise H11Error(f"symlink not allowed in asset tree: {rel}")
            observed.add(rel)

    if observed != set(expected.keys()):
        missing = sorted(set(expected.keys()) - observed)
        extra = sorted(observed - set(expected.keys()))
        if missing:
            raise H11Error(f"missing pinned asset files: {missing}")
        if extra:
            raise H11Error(f"unexpected asset files: {extra}")

    receipts: dict[str, dict[str, int | str]] = {}
    for rel, (expected_digest, expected_size) in sorted(expected.items()):
        path = asset_dir / rel
        if not path.is_file() or path.is_symlink():
            raise H11Error(f"pinned asset must be a regular file: {rel}")
        digest, size = sha256_file(path)
        if digest != expected_digest or size != expected_size:
            raise H11Error(
                f"byte lock mismatch for {rel}: got {digest} {size}, "
                f"expected {expected_digest} {expected_size}"
            )
        receipts[rel] = {"sha256": digest, "bytes": size}
    return receipts


def compose_prompt(authored_target: str) -> str:
    if not isinstance(authored_target, str) or not authored_target:
        raise H11Error("authored_target must be a non-empty string")
    return PROMPT_TEMPLATE.format(authored_target=authored_target)


def composed_prompt_sha256(authored_target: str) -> str:
    return sha256_bytes(compose_prompt(authored_target).encode("utf-8"))


def processor_attestation_from_contract(contract: Mapping[str, Any]) -> dict[str, Any]:
    expected = contract.get("processor", {}).get("expected_runtime_classes")
    if not isinstance(expected, dict):
        raise H11Error("contract missing processor.expected_runtime_classes")
    return {
        "processor_class": str(expected.get("processor_class")),
        "processor_module": str(expected.get("processor_module")),
        "image_processor_class": str(expected.get("image_processor_class")),
        "image_processor_module": str(expected.get("image_processor_module")),
        "load_argument_use_fast": bool(expected.get("load_argument_use_fast")),
    }


def _read_config_attn_implementation(config: Any) -> str | None:
    for key in ("_attn_implementation", "attn_implementation"):
        value = getattr(config, key, None)
        if isinstance(value, str) and value:
            return value
    return None


def _read_config_use_flash_attn(config: Any) -> bool | None:
    if not hasattr(config, "use_flash_attn"):
        return None
    value = getattr(config, "use_flash_attn")
    if isinstance(value, bool):
        return value
    raise H11Error("config use_flash_attn must be a bool when present")


def _attention_configs_for_model(model: Any) -> list[tuple[str, Any]]:
    configs: list[tuple[str, Any]] = []
    outer = getattr(model, "config", None)
    if outer is not None:
        configs.append(("outer", outer))
        text_config = getattr(outer, "text_config", None)
        if text_config is not None:
            configs.append(("outer.text_config", text_config))
        vision_config = getattr(outer, "vision_config", None)
        if vision_config is not None:
            configs.append(("outer.vision_config", vision_config))
    inner = getattr(model, "model", None)
    inner_config = getattr(inner, "config", None) if inner is not None else None
    if inner_config is not None and inner_config is not outer:
        configs.append(("inner.model.config", inner_config))
    return configs


def verify_attention_runtime(model: Any) -> dict[str, Any]:
    configs = _attention_configs_for_model(model)
    if not configs:
        raise H11Error("attention attestation requires at least one model config")
    evidence: dict[str, Any] = {}
    for label, config in configs:
        attn = _read_config_attn_implementation(config)
        if attn is None:
            raise H11Error(f"{label} config missing attn_implementation")
        if attn != "eager":
            raise H11Error(f"{label} attn_implementation must be eager, got {attn!r}")
        flash = _read_config_use_flash_attn(config)
        if flash is True:
            raise H11Error(f"{label} use_flash_attn must not be true")
        evidence[label] = {"attn_implementation": attn, "use_flash_attn": flash}
    return {"configs": evidence}


def read_cuda_row_peak_bytes(device: Any) -> dict[str, int | None]:
    import torch

    if not isinstance(device, torch.device):
        raise H11Error("CUDA peak read requires a torch.device")
    if device.type != "cuda" or not torch.cuda.is_available():
        return {"peak_vram_allocated_bytes": None, "peak_vram_reserved_bytes": None}
    return {
        "peak_vram_allocated_bytes": int(torch.cuda.max_memory_allocated(device)),
        "peak_vram_reserved_bytes": int(torch.cuda.max_memory_reserved(device)),
    }


def generation_record_to_diagnostics(record: GenerationRecord) -> dict[str, Any]:
    return {
        "actual_max_new_tokens_applied": record.max_new_tokens_applied,
        "do_sample_applied": record.do_sample_applied,
        "generated_token_count": record.token_count,
        "stopped_on_eos": record.stopped_on_eos,
    }


def verify_live_processor(processor: Any) -> dict[str, Any]:
    processor_type = type(processor)
    if processor_type.__name__ != EXPECTED_PROCESSOR_CLASS:
        raise H11Error(
            f"processor class must be {EXPECTED_PROCESSOR_CLASS}, got {processor_type.__name__}"
        )
    if processor_type.__module__ != EXPECTED_PROCESSOR_MODULE:
        raise H11Error(
            f"processor module must be {EXPECTED_PROCESSOR_MODULE}, got {processor_type.__module__}"
        )
    image_processor = getattr(processor, "image_processor", None)
    if image_processor is None:
        raise H11Error("processor missing image_processor")
    ip_type = type(image_processor)
    if ip_type.__name__ != EXPECTED_IMAGE_PROCESSOR_CLASS:
        raise H11Error(
            f"image processor class must be {EXPECTED_IMAGE_PROCESSOR_CLASS}, got {ip_type.__name__}"
        )
    if ip_type.__module__ != EXPECTED_IMAGE_PROCESSOR_MODULE:
        raise H11Error(
            f"image processor module must be {EXPECTED_IMAGE_PROCESSOR_MODULE}, got {ip_type.__module__}"
        )
    return processor_attestation_from_contract(
        {
            "processor": {
                "expected_runtime_classes": {
                    "processor_class": EXPECTED_PROCESSOR_CLASS,
                    "processor_module": EXPECTED_PROCESSOR_MODULE,
                    "image_processor_class": EXPECTED_IMAGE_PROCESSOR_CLASS,
                    "image_processor_module": EXPECTED_IMAGE_PROCESSOR_MODULE,
                    "load_argument_use_fast": PROCESSOR_USE_FAST,
                }
            }
        }
    )


def validate_row_key(row_key: str) -> None:
    if not isinstance(row_key, str) or not row_key:
        raise H11Error("row_key must be a non-empty string")
    if "/" in row_key or "\\" in row_key or row_key in {".", ".."}:
        raise H11Error("row_key must be a single safe path component")
    if not SAFE_ROW_KEY_PATTERN.fullmatch(row_key):
        raise H11Error(f"row_key failed safe path validation: {row_key!r}")


def validate_manifest(manifest: Mapping[str, Any], *, contract: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    harness = contract.get("harness_input_manifest") if contract else None
    expected_schema = (
        str(harness.get("schema")) if isinstance(harness, dict) else "v03-h10-input-manifest-v1"
    )
    if manifest.get("schema") != expected_schema:
        raise H11Error("unsupported input manifest schema")
    rows = manifest.get("rows")
    required_count = 12
    if isinstance(harness, dict) and isinstance(harness.get("required_row_count"), int):
        required_count = int(harness["required_row_count"])
    if not isinstance(rows, list) or len(rows) != required_count:
        raise H11Error(f"manifest must contain exactly {required_count} rows")
    normalized: list[dict[str, Any]] = []
    seen_index: set[int] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise H11Error("manifest row must be an object")
        forbidden = MANIFEST_FORBIDDEN_FIELDS.intersection(row.keys())
        if forbidden:
            raise H11Error(f"manifest row contains forbidden fields: {sorted(forbidden)}")
        extra_keys = set(row.keys()) - {"row_index", "row_key", "source_path", "source_sha256", "authored_target"}
        if extra_keys:
            raise H11Error(f"manifest row contains unexpected fields: {sorted(extra_keys)}")
        row_index = row.get("row_index")
        row_key = row.get("row_key")
        source_path = row.get("source_path")
        authored_target = row.get("authored_target")
        source_sha256 = row.get("source_sha256")
        if not isinstance(row_index, int) or row_index < 0 or row_index > required_count - 1:
            raise H11Error("row_index out of range")
        if row_index in seen_index:
            raise H11Error("duplicate row_index in manifest")
        seen_index.add(row_index)
        if not isinstance(row_key, str) or not row_key:
            raise H11Error("row_key must be a non-empty string")
        validate_row_key(row_key)
        if not isinstance(source_path, str) or not source_path:
            raise H11Error("source_path must be a non-empty string")
        if not isinstance(authored_target, str) or not authored_target:
            raise H11Error("authored_target must be a non-empty string")
        if not isinstance(source_sha256, str) or len(source_sha256) != 64:
            raise H11Error("source_sha256 must be a 64-char hex string")
        normalized.append(
            {
                "row_index": row_index,
                "row_key": row_key,
                "source_path": source_path,
                "source_sha256": source_sha256,
                "authored_target": authored_target,
            }
        )
    if seen_index != set(range(required_count)):
        raise H11Error("manifest row_index must cover required range exactly once")
    normalized.sort(key=lambda item: item["row_index"])
    return normalized


def assert_minimal_manifest_hash_if_applicable(manifest_path: Path) -> str:
    digest = file_digest_hex(manifest_path)
    if manifest_path.resolve() == MINIMAL_DEV_MANIFEST_PATH.resolve():
        if digest != MINIMAL_DEV_MANIFEST_SHA256:
            raise H11Error(
                f"minimal DEV manifest SHA-256 mismatch: got {digest}, expected {MINIMAL_DEV_MANIFEST_SHA256}"
            )
    return digest


def collect_runtime_receipt(python_executable: Path) -> dict[str, Any]:
    import subprocess

    completed = subprocess.run(
        [
            str(python_executable),
            "-c",
            (
                "import platform, numpy, PIL, torch, transformers, torchvision; "
                "print(platform.python_version()); "
                "print(torch.__version__); "
                "print(transformers.__version__); "
                "print(PIL.__version__); "
                "print(numpy.__version__); "
                "print(torchvision.__version__); "
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
        "torchvision": lines[5] if len(lines) > 5 else "unknown",
        "platform": __import__("platform").platform(),
        "cuda_available": (lines[6] if len(lines) > 6 else "0") == "1",
        "cuda_version": lines[7] if len(lines) > 7 else "",
    }
    return receipt


def cuda_runtime_details() -> dict[str, Any]:
    import torch

    return h10.cuda_runtime_details()


def assert_runtime_pins(runtime: Mapping[str, Any]) -> None:
    if runtime.get("python_version") != EXPECTED_PYTHON_VERSION:
        raise H11Error(
            f"python version pin mismatch: got {runtime.get('python_version')}, expected {EXPECTED_PYTHON_VERSION}"
        )
    if runtime.get("torch") != EXPECTED_TORCH_VERSION:
        raise H11Error(f"torch pin mismatch: got {runtime.get('torch')}, expected {EXPECTED_TORCH_VERSION}")
    if runtime.get("transformers") != EXPECTED_TRANSFORMERS_VERSION:
        raise H11Error(
            f"transformers pin mismatch: got {runtime.get('transformers')}, "
            f"expected {EXPECTED_TRANSFORMERS_VERSION}"
        )
    if not runtime.get("torchvision"):
        raise H11Error("torchvision must be present in runtime receipt")


def build_recipe(*, requested_device: str) -> dict[str, Any]:
    return {
        "model_id": MODEL_ID,
        "revision": MODEL_REVISION,
        "torch_dtype": "bfloat16",
        "eval_mode": True,
        "inference_mode": True,
        "requested_device": requested_device,
        "attention_eager": True,
        "use_flash_attn": False,
        "prompt_template": PROMPT_TEMPLATE,
        "prompt_template_sha256": PROMPT_TEMPLATE_SHA256,
        "generation_max_new_tokens": GENERATION_MAX_NEW_TOKENS,
        "generation_do_sample": GENERATION_DO_SAMPLE,
        "sam2_fill_hole_area": 0,
        "sam2_compile_image_encoder": False,
        "max_encoded_bytes": MAX_ENCODED_BYTES,
        "max_oriented_pixels": MAX_ORIENTED_PIXELS,
        "retain_native_masks_max_count": RETAIN_MASK_MAX_COUNT,
        "retain_native_masks_max_bytes_per_row": RETAIN_MASK_MAX_BYTES_PER_ROW,
    }


def overlay_wheels_from_contract(contract: Mapping[str, Any]) -> list[dict[str, Any]]:
    overlay = contract.get("overlay_installer_wheels")
    if not isinstance(overlay, dict):
        return []
    wheels = overlay.get("wheels")
    if not isinstance(wheels, list):
        return []
    copied: list[dict[str, Any]] = []
    for wheel in wheels:
        if not isinstance(wheel, dict):
            continue
        copied.append(
            {
                "name": wheel.get("name"),
                "version": wheel.get("version"),
                "filename": wheel.get("filename"),
                "bytes": wheel.get("bytes"),
                "sha256": wheel.get("sha256"),
            }
        )
    return copied


def build_input_image_receipts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    receipts: list[dict[str, Any]] = []
    for row in rows:
        source_path = Path(row["source_path"])
        expected_sha = row["source_sha256"]
        digest, encoded_bytes = sha256_file(source_path)
        if digest != expected_sha:
            raise H11Error(
                f"source SHA-256 mismatch for {row['row_key']}: got {digest}, expected {expected_sha}"
            )
        if encoded_bytes > MAX_ENCODED_BYTES:
            raise H11Error(f"source exceeds encoded byte cap: {source_path}")
        oriented = read_oriented_source(source_path, expected_raw_sha256=expected_sha)
        try:
            receipts.append(
                {
                    "row_index": row["row_index"],
                    "row_key": row["row_key"],
                    "source_path": str(source_path.resolve()),
                    "manifest_source_sha256": expected_sha,
                    "actual_source_sha256": digest,
                    "encoded_bytes": encoded_bytes,
                    "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
                    "source_width": oriented.width,
                    "source_height": oriented.height,
                }
            )
        finally:
            oriented.rgb.close()
    return receipts


def write_bytes_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def foreground_bounds_from_u8(mask_u8: np.ndarray) -> dict[str, int] | None:
    if mask_u8.ndim != 2:
        raise H11Error("mask must be 2D for bounds derivation")
    foreground = np.argwhere(mask_u8 > 0)
    if foreground.size == 0:
        return None
    ys = foreground[:, 0]
    xs = foreground[:, 1]
    return {
        "x_min": int(xs.min()),
        "y_min": int(ys.min()),
        "x_max": int(xs.max()),
        "y_max": int(ys.max()),
    }


def mask_plane_to_u8(mask: Any, height: int, width: int) -> np.ndarray:
    if hasattr(mask, "detach"):
        array = mask.detach().cpu().numpy()
    else:
        array = np.asarray(mask)
    if array.ndim != 3 or array.shape[0] != 1:
        raise H11Error(f"native mask must have shape [1,H,W], got {tuple(array.shape)}")
    plane = array[0]
    if plane.shape != (height, width):
        raise H11Error(
            f"native mask spatial shape {tuple(plane.shape)} != oriented source ({height}, {width})"
        )
    if array.dtype == np.bool_ or plane.dtype == np.bool_:
        converted = plane.astype(np.uint8)
    elif plane.dtype == np.uint8:
        unique = np.unique(plane)
        if unique.size == 0:
            converted = plane
        elif not np.all(np.isin(unique, [0, 1])):
            raise H11Error("uint8 native mask must be binary 0/1")
        else:
            converted = plane
    else:
        raise H11Error(f"unsupported native mask dtype: {array.dtype}")
    if converted.shape != (height, width):
        raise H11Error("mask plane shape mismatch after conversion")
    return np.ascontiguousarray(converted, dtype=np.uint8)


def retain_native_masks(
    native_masks: list[Any],
    *,
    height: int,
    width: int,
    masks_dir: Path,
    row_key: str,
) -> tuple[list[CandidateMaskRecord], int | None, dict[str, int] | None]:
    validate_row_key(row_key)
    case_dir = masks_dir / row_key
    total_bytes = 0
    candidates: list[CandidateMaskRecord] = []
    selected_index: int | None = None
    selected_bounds: dict[str, int] | None = None
    if len(native_masks) > RETAIN_MASK_MAX_COUNT:
        raise H11Error(f"native mask count {len(native_masks)} exceeds cap {RETAIN_MASK_MAX_COUNT}")
    for emission_index, native in enumerate(native_masks):
        plane_u8 = mask_plane_to_u8(native, height, width)
        byte_count = int(plane_u8.size)
        total_bytes += byte_count
        if total_bytes > RETAIN_MASK_MAX_BYTES_PER_ROW:
            raise H11Error(
                f"retained mask bytes {total_bytes} exceed per-row cap {RETAIN_MASK_MAX_BYTES_PER_ROW}"
            )
        bounds = foreground_bounds_from_u8(plane_u8)
        rel_path = f"masks/{row_key}/candidate-{emission_index}.u8"
        abs_path = masks_dir.parent / rel_path
        write_bytes_atomic(abs_path, plane_u8.tobytes())
        digest = sha256_bytes(plane_u8.tobytes())
        record = CandidateMaskRecord(
            emission_index=emission_index,
            path=rel_path,
            sha256=digest,
            byte_count=byte_count,
            width=width,
            height=height,
            foreground_bounds=bounds,
        )
        candidates.append(record)
        if selected_index is None and bounds is not None:
            selected_index = emission_index
            selected_bounds = bounds
            selected_rel = f"masks/{row_key}/mask.u8"
            write_bytes_atomic(masks_dir.parent / selected_rel, plane_u8.tobytes())
    return candidates, selected_index, selected_bounds


def candidate_record_to_json(record: CandidateMaskRecord) -> dict[str, Any]:
    return {
        "emission_index": record.emission_index,
        "path": record.path,
        "sha256": record.sha256,
        "byte_count": record.byte_count,
        "width": record.width,
        "height": record.height,
        "foreground_bounds": record.foreground_bounds,
    }


def install_generate_interceptor(
    inner_model: Any,
    *,
    eos_token_id: int | None,
    input_length: int | None = None,
) -> tuple[Callable[..., Any], dict[str, Any]]:
    recorder: dict[str, Any] = {}
    original_generate = inner_model.generate

    def wrapped_generate(*args: Any, **kwargs: Any) -> Any:
        kwargs["max_new_tokens"] = GENERATION_MAX_NEW_TOKENS
        kwargs["do_sample"] = GENERATION_DO_SAMPLE
        recorder["max_new_tokens"] = kwargs["max_new_tokens"]
        recorder["do_sample"] = kwargs["do_sample"]
        effective_input_length = input_length
        if effective_input_length is None:
            input_ids = kwargs.get("input_ids")
            if input_ids is None and args:
                input_ids = args[0]
            if input_ids is None:
                raise H11Error("generate call missing input_ids for length accounting")
            effective_input_length = int(input_ids.shape[-1])
        result = original_generate(*args, **kwargs)
        sequences = getattr(result, "sequences", None)
        if sequences is None:
            raise H11Error("generate result missing sequences")
        seq = sequences[0]
        generated = seq[effective_input_length:]
        token_count = int(generated.numel())
        stopped_on_eos = False
        if eos_token_id is not None and token_count > 0:
            stopped_on_eos = int(generated[-1].item()) == int(eos_token_id)
        truncated = token_count >= int(kwargs["max_new_tokens"]) and not stopped_on_eos
        recorder["generation"] = GenerationRecord(
            token_count=token_count,
            stopped_on_eos=stopped_on_eos,
            truncated=truncated,
            max_new_tokens_applied=int(kwargs["max_new_tokens"]),
            do_sample_applied=bool(kwargs["do_sample"]),
        )
        return result

    inner_model.generate = wrapped_generate  # type: ignore[method-assign]
    return original_generate, recorder


def wrap_generate_callable(
    generate_fn: Callable[..., Any],
    *,
    eos_token_id: int | None,
    input_length: int,
) -> tuple[Callable[..., Any], dict[str, Any]]:
    class _Inner:
        def __init__(self, fn: Callable[..., Any]) -> None:
            self.generate = fn

    inner = _Inner(generate_fn)
    _original, recorder = install_generate_interceptor(
        inner, eos_token_id=eos_token_id, input_length=input_length
    )
    return inner, recorder


def _class_def_map(module: ast.Module) -> dict[str, ast.ClassDef]:
    mapping: dict[str, ast.ClassDef] = {}
    for node in module.body:
        if isinstance(node, ast.ClassDef):
            mapping[node.name] = node
    return mapping


def _function_def(class_node: ast.ClassDef, name: str) -> ast.FunctionDef:
    for item in class_node.body:
        if isinstance(item, ast.FunctionDef) and item.name == name:
            return item
    raise H11Error(f"pinned sam2.py {class_node.name} missing {name}")


def _literal_false(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value is False


def _literal_zero(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value == 0


def _default_arg_value(func: ast.FunctionDef, param_name: str) -> ast.AST | None:
    positional = func.args.args
    defaults = func.args.defaults
    if not defaults:
        return None
    defaults_offset = len(positional) - len(defaults)
    for index, arg in enumerate(positional):
        if arg.arg != param_name:
            continue
        if index < defaults_offset:
            return None
        return defaults[index - defaults_offset]
    return None


def attest_pinned_sam2_source(source: str) -> dict[str, Any]:
    try:
        module = ast.parse(source)
    except SyntaxError as error:
        raise H11Error(f"pinned sam2.py is not valid Python: {error}") from error
    classes = _class_def_map(module)
    sam2_cls = classes.get("SAM2")
    if sam2_cls is None:
        raise H11Error("pinned sam2.py missing SAM2 class")
    sam2_init = _function_def(sam2_cls, "__init__")
    predictor_call_found = False
    for node in ast.walk(sam2_init):
        if not isinstance(node, ast.Call):
            continue
        callee = node.func
        callee_name: str | None = None
        if isinstance(callee, ast.Name):
            callee_name = callee.id
        elif isinstance(callee, ast.Attribute):
            callee_name = callee.attr
        if callee_name != "SAM2VideoPredictor":
            continue
        compile_kw: ast.keyword | None = None
        for keyword in node.keywords:
            if keyword.arg == "compile_image_encoder":
                compile_kw = keyword
                break
        if compile_kw is None:
            raise H11Error(
                "pinned sam2.py SAM2.__init__ must call SAM2VideoPredictor(..., compile_image_encoder=False)"
            )
        if not _literal_false(compile_kw.value):
            raise H11Error("pinned sam2.py SAM2.__init__ must pass compile_image_encoder=False")
        predictor_call_found = True
        break
    if not predictor_call_found:
        raise H11Error("pinned sam2.py SAM2.__init__ must call SAM2VideoPredictor")

    predictor_cls = classes.get("SAM2VideoPredictor")
    if predictor_cls is None:
        raise H11Error("pinned sam2.py missing SAM2VideoPredictor class")
    predictor_init = _function_def(predictor_cls, "__init__")
    fill_default = _default_arg_value(predictor_init, "fill_hole_area")
    if fill_default is None:
        raise H11Error("pinned sam2.py SAM2VideoPredictor.__init__ must default fill_hole_area=0")
    if not _literal_zero(fill_default):
        raise H11Error("pinned sam2.py SAM2VideoPredictor.__init__ must default fill_hole_area=0")
    return {
        "sam2_init_calls_sam2_video_predictor_compile_false": True,
        "sam2_video_predictor_fill_hole_area_default_zero": True,
    }


def verify_pinned_sam2_asset(asset_dir: Path, contract: Mapping[str, Any]) -> dict[str, Any]:
    expected = contract_required_files(contract)
    if SAM2_PINNED_REL_PATH not in expected:
        raise H11Error("contract missing sam2.py byte lock")
    expected_digest, expected_size = expected[SAM2_PINNED_REL_PATH]
    sam2_path = asset_dir / SAM2_PINNED_REL_PATH
    if not sam2_path.is_file() or sam2_path.is_symlink():
        raise H11Error(f"pinned sam2.py missing under asset directory: {sam2_path}")
    digest, size = sha256_file(sam2_path)
    if digest != expected_digest or size != expected_size:
        raise H11Error(
            f"sam2.py byte lock mismatch: got {digest} {size}, "
            f"expected {expected_digest} {expected_size}"
        )
    source = sam2_path.read_text(encoding="utf-8")
    source_attestation = attest_pinned_sam2_source(source)
    return {
        "path": SAM2_PINNED_REL_PATH,
        "sha256": digest,
        "bytes": size,
        **source_attestation,
    }


def _resolve_asset_dir_from_model(model: Any) -> Path:
    raw_path = getattr(model, "name_or_path", None)
    if not isinstance(raw_path, str) or not raw_path:
        config = getattr(model, "config", None)
        candidate = getattr(config, "_name_or_path", None) if config is not None else None
        raw_path = candidate if isinstance(candidate, str) else None
    if not isinstance(raw_path, str) or not raw_path:
        raise H11Error("SAM2 guard requires asset_dir or a model with name_or_path")
    return Path(raw_path)


def _is_optimized_module(module: Any) -> bool:
    mod_type = type(module)
    qualname = mod_type.__qualname__
    module_name = mod_type.__module__ or ""
    if qualname == "OptimizedModule" or qualname.endswith(".OptimizedModule"):
        return True
    if module_name.endswith("OptimizedModule") or module_name.endswith(".OptimizedModule"):
        return True
    if "torch._dynamo.OptimizedModule" in module_name:
        return True
    return False


def _assert_image_encoder_uncompiled(image_encoder: Any) -> dict[str, Any]:
    if _is_optimized_module(image_encoder):
        raise H11Error("SAM2 image_encoder must not be a torch._dynamo OptimizedModule wrapper")
    if getattr(image_encoder, "_orig_mod", None) is not None:
        raise H11Error("SAM2 image_encoder exposes _orig_mod compile wrapper marker")
    forward = getattr(image_encoder, "forward", None)
    if forward is None:
        raise H11Error("SAM2 image_encoder missing forward")
    if getattr(forward, "_torchdynamo_orig_callable", None) is not None:
        raise H11Error("SAM2 image_encoder.forward exposes _torchdynamo_orig_callable compile marker")
    mod_type = type(image_encoder)
    return {
        "image_encoder_type": f"{mod_type.__module__}.{mod_type.__qualname__}",
        "compiled_wrapper_markers_absent": True,
    }


def verify_sam2_runtime(
    model: Any,
    *,
    asset_dir: Path | None = None,
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_contract = contract if contract is not None else load_contract(CONTRACT_PATH)
    resolved_asset_dir = asset_dir if asset_dir is not None else _resolve_asset_dir_from_model(model)
    pinned_asset = verify_pinned_sam2_asset(resolved_asset_dir, resolved_contract)

    encoder = getattr(model, "grounding_encoder", None)
    if encoder is None:
        raise H11Error("model missing grounding_encoder for SAM2 guard")
    if not hasattr(encoder, "sam2_model"):
        raise H11Error("grounding_encoder missing sam2_model nested SAM2VideoPredictor")
    sam2_model = encoder.sam2_model
    if not hasattr(sam2_model, "fill_hole_area"):
        raise H11Error("sam2_model missing fill_hole_area attribute")
    fill_hole_area = sam2_model.fill_hole_area
    if fill_hole_area != 0:
        raise H11Error(f"SAM2 fill_hole_area must be exactly 0, got {fill_hole_area!r}")

    if not hasattr(sam2_model, "image_encoder"):
        raise H11Error("sam2_model missing image_encoder")
    image_encoder_evidence = _assert_image_encoder_uncompiled(sam2_model.image_encoder)

    wrapper_has_compile_attr = hasattr(encoder, "compile_image_encoder")
    return {
        "pinned_sam2_py": pinned_asset,
        "source_evidence": {
            "compile_image_encoder_false_from_pinned_sam2_py": True,
            "note": "SAM2Base wrapper does not retain compile_image_encoder; source pin is authoritative",
        },
        "runtime_evidence": {
            "predictor_path": "grounding_encoder.sam2_model",
            "fill_hole_area": fill_hole_area,
            **image_encoder_evidence,
            "grounding_encoder_compile_image_encoder_attr_present": wrapper_has_compile_attr,
            "note": (
                "Missing compile_image_encoder on grounding_encoder is expected and is not proof of false; "
                "use pinned-source and uncompiled image_encoder evidence"
            ),
        },
    }


def empty_row_shell(manifest_row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "row_index": manifest_row["row_index"],
        "row_key": manifest_row["row_key"],
        "authored_target": manifest_row["authored_target"],
        "outcome_kind": "technical_error",
        "source_width": None,
        "source_height": None,
        "source_sha256": manifest_row.get("source_sha256"),
        "oriented_rgb_sha256": None,
        "composed_prompt_sha256": None,
        "prediction_text": None,
        "generation_token_count": None,
        "generation_truncated": None,
        "generation_diagnostics": None,
        "native_mask_count": None,
        "candidate_masks": [],
        "selected_mask_index": None,
        "mask_path": None,
        "mask_sha256": None,
        "foreground_bounds": None,
        "error_code": None,
        "error_message": None,
        "wall_ms": None,
        "peak_vram_allocated_bytes": None,
        "peak_vram_reserved_bytes": None,
    }


def normalize_terminal_row(raw: Mapping[str, Any], manifest_row: Mapping[str, Any]) -> dict[str, Any]:
    shell = empty_row_shell(manifest_row)
    outcome = raw.get("outcome_kind")
    if outcome == "unresolved_empty":
        outcome = "unresolved_no_mask"
    if isinstance(outcome, str):
        shell["outcome_kind"] = outcome
    for key in (
        "source_width",
        "source_height",
        "source_sha256",
        "oriented_rgb_sha256",
        "composed_prompt_sha256",
        "prediction_text",
        "generation_token_count",
        "generation_truncated",
        "generation_diagnostics",
        "native_mask_count",
        "candidate_masks",
        "selected_mask_index",
        "mask_path",
        "mask_sha256",
        "foreground_bounds",
        "error_code",
        "error_message",
        "wall_ms",
        "peak_vram_allocated_bytes",
        "peak_vram_reserved_bytes",
    ):
        if key in raw and key not in H11_STRIP_WORKER_FIELDS:
            shell[key] = raw[key]
    if shell["source_sha256"] is None:
        shell["source_sha256"] = manifest_row.get("source_sha256")
    if not isinstance(shell.get("candidate_masks"), list):
        shell["candidate_masks"] = []
    return shell


def derive_run_status(
    rows: list[Mapping[str, Any]],
    *,
    cleanup_failed: bool,
    cancelled: bool,
) -> str:
    if cleanup_failed:
        return "worker_cleanup_failed"
    if cancelled:
        return "cancelled"
    if any(row.get("outcome_kind") == "integrity_failure" for row in rows):
        return "completed_with_integrity_errors"
    if any(row.get("outcome_kind") == "technical_error" for row in rows):
        return "completed_with_technical_errors"
    return "completed"


def build_script_receipts(
    *,
    h11_common: Path,
    h11_runner: Path,
    h11_worker: Path,
    h10_common: Path,
    h10_runner: Path,
    contract_path: Path,
) -> dict[str, Any]:
    return {
        "h11_common_script_path": str(h11_common.resolve()),
        "h11_common_script_sha256": file_digest_hex(h11_common),
        "h11_runner_script_path": str(h11_runner.resolve()),
        "h11_runner_script_sha256": file_digest_hex(h11_runner),
        "h11_worker_script_path": str(h11_worker.resolve()),
        "h11_worker_script_sha256": file_digest_hex(h11_worker),
        "h10_common_script_path": str(h10_common.resolve()),
        "h10_common_script_sha256": file_digest_hex(h10_common),
        "h10_runner_script_path": str(h10_runner.resolve()),
        "h10_runner_script_sha256": file_digest_hex(h10_runner),
        "contract_path": str(contract_path.resolve()),
        "contract_sha256": file_digest_hex(contract_path),
    }


def revalidate_freeze_closure(
    freeze: Mapping[str, Any],
    *,
    freeze_path: Path,
    python_executable: Path,
    contract_path: Path,
    h11_worker: Path,
    h11_runner: Path,
    h11_common: Path,
    h10_runner: Path,
    h10_common: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if freeze.get("schema") != FREEZE_SCHEMA:
        raise H11Error("unsupported freeze schema")
    contract = load_contract(contract_path)
    if file_digest_hex(contract_path) != freeze.get("contract_sha256"):
        raise H11Error("contract bytes changed since freeze")
    manifest_path = Path(str(freeze["manifest_path"])).resolve()
    if file_digest_hex(manifest_path) != freeze.get("manifest_sha256"):
        raise H11Error("manifest bytes changed since freeze")
    asset_dir = Path(str(freeze["asset_dir"])).resolve()
    live_assets = verify_asset_directory(asset_dir, contract)
    if live_assets != freeze.get("asset_receipts"):
        raise H11Error("asset receipts changed since freeze")
    runtime = {
        **collect_runtime_receipt(python_executable),
        "cuda_device": cuda_runtime_details(),
    }
    assert_runtime_pins(runtime)
    if runtime != freeze.get("runtime"):
        raise H11Error("runtime versions changed since freeze")
    expected_scripts = build_script_receipts(
        h11_common=h11_common,
        h11_runner=h11_runner,
        h11_worker=h11_worker,
        h10_common=h10_common,
        h10_runner=h10_runner,
        contract_path=contract_path,
    )
    frozen_scripts = freeze.get("script_receipts")
    if expected_scripts != frozen_scripts:
        raise H11Error("script receipts changed since freeze")
    if freeze.get("recipe") != build_recipe(requested_device=str(freeze.get("requested_device"))):
        raise H11Error("immutable recipe differs from accepted H11 method")
    attestation = processor_attestation_from_contract(contract)
    if freeze.get("processor_attestation") != attestation:
        raise H11Error("processor attestation changed since freeze")
    manifest_payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = validate_manifest(manifest_payload, contract=contract)
    if rows != freeze.get("rows"):
        raise H11Error("manifest rows differ from frozen row snapshot")
    live_inputs = build_input_image_receipts(rows)
    if live_inputs != freeze.get("input_image_receipts"):
        raise H11Error("input image receipts changed since freeze")
    from transformers import AutoProcessor

    processor = AutoProcessor.from_pretrained(
        str(asset_dir),
        trust_remote_code=True,
        local_files_only=True,
        use_fast=PROCESSOR_USE_FAST,
        revision=MODEL_REVISION,
    )
    live_attestation = verify_live_processor(processor)
    if live_attestation != freeze.get("processor_attestation"):
        raise H11Error("processor smoke attestation mismatch at run closure")
    return rows, contract
