#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import tempfile
import types
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
RECIPE_IDS = {
    "h8a-cpu-raw-target-v1": (
        "benchmarks/v03/h8a-full/native-recipe.json",
        "2490bef2738cc50b7a9731e47d5774dd4a2387887c35359939cf9757c58ffa4b",
        "verbatim",
    ),
    "h8a-cpu-flat-target-v2": (
        "benchmarks/v03/h8a-full/native-recipe-flat-target-v2.json",
        "a3d333cf34959a833f528ca098b239d819a29e626156adf00e429b0f172ee5f6",
        "flat",
    ),
}
RECIPE_ID = "h8a-cpu-raw-target-v1"
HYPOTHESIS_FREEZE_SHA256 = "62a713b6c4ad82fec4e595567632378ae75321375fd7cc7a9f29552564fb7c4f"

FROZEN_PROBE = (
    "benchmarks/v03/h8a-cpu/probe.py",
    "233daa59917174682846b7aa2f54ad7605d30d9fe91fe619e1a9cd13edbc466e",
)

PINNED_HELPERS: tuple[tuple[str, str], ...] = (
    ("benchmarks/v03/grounded-proposals-probe.py", "7695cb42cd6e4e583f6cb5bab08d93d40c18d08c188651948b4fed0b43fdc8b5"),
    ("benchmarks/v03/ui-proposal-probe.py", "fd1cc46823913e143219dcb4e2faf28393f21324b146e14d9feebbb6d58d217d"),
    ("benchmarks/v03/h4e-sam2-context-prompt.py", "4b74661b0fe156c4f1da46a24fc25e313150ac9d0f83076a1eae441425fb3582"),
)

SHA256_HEX_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MAX_AUTHORED_TARGET_CHARS = 2000
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_IMAGE_PIXELS = 2_097_152
MAX_CANDIDATES_PER_FAMILY = 36
MAX_CANDIDATES_TOTAL = 72
MAX_PACKED_BYTES = 19 * 1024 * 1024
BOX_THRESHOLD = 0.15
TEXT_THRESHOLD = 0.15
O_RDONLY_NOFOLLOW = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
NATIVE_REQUEST_SCHEMA = "h8a-full-native-request-v1"
NATIVE_RESPONSE_SCHEMA = "h8a-full-native-response-v1"
NATIVE_REQUEST_ALLOWED_KEYS = frozenset(
    {
        "schema",
        "request_id",
        "recipe_id",
        "authored_target",
        "task_dir",
        "assets_dir",
        "source_path",
        "source_sha256",
        "width",
        "height",
        "detector_prompt",
    }
)


class WorkerError(RuntimeError):
    pass


ProbeError = WorkerError


def _pinned_module_leaf(relative_path: str) -> Path:
    normalized = Path(relative_path)
    if normalized.is_absolute() or ".." in normalized.parts:
        raise WorkerError(f"pinned module path escapes repository: {relative_path}")
    leaf = REPO_ROOT / normalized
    try:
        leaf.relative_to(REPO_ROOT)
    except ValueError as error:
        raise WorkerError(f"pinned module path escapes repository: {relative_path}") from error
    return leaf


def _bootstrap_frozen_probe(relative_path: str, expected_sha256: str, module_name: str) -> Any:
    leaf = _pinned_module_leaf(relative_path)
    if leaf.is_symlink():
        raise WorkerError(f"refusing symlink module path: {leaf}")
    try:
        fd = os.open(leaf, O_RDONLY_NOFOLLOW)
    except OSError as error:
        raise WorkerError(f"cannot open pinned module: {leaf}") from error
    digest = hashlib.sha256()
    chunks: list[bytes] = []
    try:
        while True:
            piece = os.read(fd, 1024 * 1024)
            if not piece:
                break
            digest.update(piece)
            chunks.append(piece)
    except OSError as error:
        os.close(fd)
        raise WorkerError(f"cannot read pinned module: {leaf}") from error
    os.close(fd)
    if digest.hexdigest() != expected_sha256:
        raise WorkerError(f"pinned module digest mismatch: {leaf}")
    source = b"".join(chunks).decode("utf-8")
    code = compile(source, str(leaf), "exec", dont_inherit=True)
    module = types.ModuleType(module_name)
    module.__file__ = str(leaf)
    module.__dict__["__name__"] = module_name
    sys.modules[module_name] = module
    exec(code, module.__dict__)
    return module


_PROBE = _bootstrap_frozen_probe(FROZEN_PROBE[0], FROZEN_PROBE[1], "h8af_frozen_probe")

VerifiedAssetSession = _PROBE.VerifiedAssetSession
VerifiedOpenFile = _PROBE.VerifiedOpenFile
enforce_owned_bytes_digest = _PROBE.enforce_owned_bytes_digest
sha256_bytes = _PROBE.sha256_bytes
sha256_file = _PROBE.sha256_file
write_json_atomic = _PROBE.write_json_atomic
load_pinned_module = _PROBE.load_pinned_module
run_bounded_child = _PROBE.run_bounded_child
packed_mask_byte_length = _PROBE.packed_mask_byte_length
aggregate_packed_limit = _PROBE.aggregate_packed_limit
pack_mask_with_validation = _PROBE.pack_mask_with_validation
_probe_validate_packed_bytes = _PROBE.validate_packed_bytes


def validate_packed_bytes(data: bytes, width: int, height: int) -> bytes:
    try:
        return _probe_validate_packed_bytes(data, width, height)
    except Exception as error:
        raise WorkerError(str(error)) from error
mask_bbox_np = _PROBE.mask_bbox_np
parse_python_freeze_pins = _PROBE.parse_python_freeze_pins
verify_model_assets = _PROBE.verify_model_assets
prepare_verified_loader_paths = _PROBE.prepare_verified_loader_paths


def build_dino_prompt(authored_target: str) -> str:
    if not isinstance(authored_target, str):
        raise WorkerError("authored_target must be a string")
    stripped = authored_target.strip("\ufeff")
    if not stripped or len(stripped) > MAX_AUTHORED_TARGET_CHARS:
        raise WorkerError("authored_target length out of bounds")
    return f"a {stripped}"


def validate_authored_target(value: Any) -> str:
    if not isinstance(value, str):
        raise WorkerError("authored_target must be a string")
    if value != value.strip("\ufeff") or not value.strip("\ufeff"):
        raise WorkerError("authored_target must be nonempty")
    if len(value) > MAX_AUTHORED_TARGET_CHARS:
        raise WorkerError("authored_target length out of bounds")
    return value


def path_is_inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
        return True
    except ValueError:
        return False


def require_external_path(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if path_is_inside_repo(resolved):
        raise WorkerError(f"{label} must resolve outside repository: {resolved}")
    return resolved


def validate_sha256_hex(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not SHA256_HEX_PATTERN.fullmatch(value):
        raise WorkerError(f"{field_name} must be a lowercase SHA-256 hex digest")
    return value


def require_string_field(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise WorkerError(f"{field_name} must be a string")
    return value


def require_positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise WorkerError(f"{field_name} must be a positive integer")
    return value


def require_json_object(value: Any, field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WorkerError(f"{field_name} must be a JSON object")
    return value


def validate_request_id(value: Any) -> str:
    request_id = require_string_field(value, "request_id")
    if len(request_id) != 36 or request_id[8] != "-" or request_id[13] != "-":
        raise WorkerError("request_id must be a UUID string")
    return request_id


def validate_native_request(raw: Any) -> dict[str, Any]:
    payload = require_json_object(raw, "native request")
    unknown = set(payload.keys()) - NATIVE_REQUEST_ALLOWED_KEYS
    if unknown:
        raise WorkerError(f"unknown native request fields: {', '.join(sorted(unknown))}")
    schema = payload.get("schema")
    if schema != NATIVE_REQUEST_SCHEMA:
        raise WorkerError("native request schema mismatch")
    request_id = validate_request_id(payload.get("request_id"))
    recipe_id = require_string_field(payload.get("recipe_id"), "recipe_id")
    if recipe_id not in RECIPE_IDS:
        raise WorkerError("recipe_id mismatch")
    authored_target = validate_authored_target(payload.get("authored_target"))
    task_dir = require_external_path(
        Path(require_string_field(payload.get("task_dir"), "task_dir")),
        "task_dir",
    )
    assets_dir = Path(require_string_field(payload.get("assets_dir"), "assets_dir")).resolve()
    source_path = Path(require_string_field(payload.get("source_path"), "source_path")).resolve()
    source_sha256 = validate_sha256_hex(payload.get("source_sha256"), "source_sha256")
    width = require_positive_int(payload.get("width"), "width")
    height = require_positive_int(payload.get("height"), "height")
    if width * height > MAX_IMAGE_PIXELS:
        raise WorkerError("width*height exceeds pixel cap")
    expected_detector_prompt = build_dino_prompt(authored_target)
    supplied_detector_prompt = payload.get("detector_prompt")
    if supplied_detector_prompt is not None:
        if not isinstance(supplied_detector_prompt, str) or supplied_detector_prompt != expected_detector_prompt:
            raise WorkerError("detector_prompt must match build_dino_prompt(authored_target)")
    return {
        "schema": schema,
        "request_id": request_id,
        "recipe_id": recipe_id,
        "authored_target": authored_target,
        "task_dir": task_dir,
        "assets_dir": assets_dir,
        "source_path": source_path,
        "source_sha256": source_sha256,
        "width": width,
        "height": height,
        "detector_prompt": expected_detector_prompt,
    }


def load_pinned_recipe(recipe_id: str) -> dict[str, Any]:
    recipe = RECIPE_IDS.get(recipe_id)
    if recipe is None:
        raise WorkerError("recipe_id mismatch")
    relative_path, expected_sha256, processor_text = recipe
    path = _pinned_module_leaf(relative_path)
    if path.is_symlink():
        raise WorkerError(f"refusing symlink recipe path: {path}")
    try:
        fd = os.open(path, O_RDONLY_NOFOLLOW)
    except OSError as error:
        raise WorkerError(f"cannot open pinned recipe: {path}") from error
    try:
        chunks: list[bytes] = []
        digest = hashlib.sha256()
        while True:
            piece = os.read(fd, 1024 * 1024)
            if not piece:
                break
            chunks.append(piece)
            digest.update(piece)
    finally:
        os.close(fd)
    if digest.hexdigest() != expected_sha256:
        raise WorkerError(f"pinned recipe digest mismatch: {path}")
    try:
        value = json.loads(b"".join(chunks))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkerError(f"pinned recipe JSON invalid: {path}") from error
    if not isinstance(value, dict) or value.get("recipe_id") != recipe_id:
        raise WorkerError("pinned recipe identity mismatch")
    target_policy = value.get("target_policy")
    expected_policy: dict[str, Any] = {"dino_prefix": "a ", "verbatim_authored_target": True}
    if processor_text == "flat":
        expected_policy["processor_text"] = "stripped-lower-terminal-period"
    if target_policy != expected_policy:
        raise WorkerError("pinned recipe target policy mismatch")
    return value


def build_processor_text(recipe_id: str, detector_prompt: str) -> str | list[list[str]]:
    if recipe_id not in RECIPE_IDS:
        raise WorkerError("recipe_id mismatch")
    if RECIPE_IDS[recipe_id][2] == "verbatim":
        return [[detector_prompt]]
    flat_text = detector_prompt.strip().lower()
    if not flat_text.endswith("."):
        flat_text += "."
    return flat_text


def exif_orientation_tag(image: Any) -> int:
    if getattr(image, "format", None) == "PNG" and "exif" not in getattr(image, "info", {}):
        return 1
    try:
        exif = image.getexif()
        if exif:
            return int(exif.get(274, 1) or 1)
    except (AttributeError, TypeError, ValueError):
        return 1
    return 1


def oriented_dimensions_from_header(encoded: bytes) -> tuple[int, int]:
    from PIL import Image

    try:
        with Image.open(io.BytesIO(encoded)) as image:
            width, height = image.size
            orientation = exif_orientation_tag(image)
    except OSError as error:
        raise WorkerError(f"corrupt or unreadable source image header: {error}") from error
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    pixels = width * height
    if pixels > MAX_IMAGE_PIXELS:
        raise WorkerError(
            f"oriented source pixels {pixels} exceed cap {MAX_IMAGE_PIXELS} ({width}x{height})"
        )
    return width, height


def validate_encoded_header(encoded: bytes) -> tuple[int, int]:
    if len(encoded) > MAX_IMAGE_BYTES:
        raise WorkerError("encoded source exceeds byte cap before decode")
    return oriented_dimensions_from_header(encoded)


def load_pinned_helpers_for_generation() -> tuple[Any, Any, Any]:
    grounded = load_pinned_module(PINNED_HELPERS[0][0], PINNED_HELPERS[0][1], "h8af_grounded")
    omni = load_pinned_module(PINNED_HELPERS[1][0], PINNED_HELPERS[1][1], "h8af_omni")
    h4e = load_pinned_module(PINNED_HELPERS[2][0], PINNED_HELPERS[2][1], "h8af_h4e")
    return grounded, omni, h4e


def collect_runtime_receipt(require_pinned: bool, *, freeze_pins: dict[str, str] | None = None) -> dict[str, Any]:
    import importlib.metadata

    packages = ("torch", "torchvision", "transformers", "numpy", "Pillow", "safetensors")
    receipt: dict[str, Any] = {"packages": {}}
    for name in packages:
        try:
            dist = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            if require_pinned:
                raise WorkerError(f"missing runtime package: {name}")
            continue
        receipt["packages"][name] = dist.version
    if freeze_pins:
        receipt["freeze_pins"] = freeze_pins
    return receipt


def runtime_source_closure_digest() -> str:
    parts: list[str] = []
    for relative, digest in PINNED_HELPERS:
        parts.append(f"{relative}:{digest}")
    parts.append(f"{FROZEN_PROBE[0]}:{FROZEN_PROBE[1]}")
    worker = Path(__file__).resolve()
    parts.append(f"{worker.relative_to(REPO_ROOT)}:{sha256_file(worker)[0]}")
    common = worker.with_name("native-common.py")
    parts.append(f"{common.relative_to(REPO_ROOT)}:{sha256_file(common)[0]}")
    for relative_path, expected_sha256, _ in RECIPE_IDS.values():
        parts.append(f"{relative_path}:{expected_sha256}")
    return sha256_bytes("\n".join(parts).encode("utf-8"))
