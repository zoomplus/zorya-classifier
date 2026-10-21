#!/usr/bin/env python3
"""Local-only SigLIP2 shadow scoring for frozen proposal masks.

This module has no automatic download path. The CLI's synthetic probe requires
an explicitly staged, pinned checkpoint and never reads benchmark inputs.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import signal
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from PIL import Image, ImageOps

MODEL_ID = "google/siglip2-base-patch16-512"
MODEL_REVISION = "a89f5c5093f902bf39d3cd4d81d2c09867f0724b"
EXPECTED_LICENSE = "apache-2.0"
EXPECTED_ASSETS = {
    "config.json": ("a15bc39fbcd92498dea6d5d3cb2b0d8b9ba389d6a3f2b565ea66128a2d141934", 276),
    "model.safetensors": ("fe0e601c625e69eed8e73500d39e9b6164403fe03db8048e87913c3cefbbb3fe", 1_503_344_520),
    "preprocessor_config.json": ("63ff380d3e424f93e6fbca5cc8e74eeed882e96fd6be2b7728aed308f3ad1513", 394),
    "special_tokens_map.json": ("baec30ea10906f16adb8c18af7a34023002c1746542612b8b41c9f09e1351351", 636),
    "tokenizer.json": ("cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322", 34_363_039),
    "tokenizer_config.json": ("14afe629fe4959b9e0d51e1852b8d9f7ad074f90a1a7125a4fcdd17f06e78fc8", 47_164),
}
ASSET_FILES = (
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
)
MODEL_INPUT_SIZE = 512
CONTEXT_FRACTION = 0.25
GRAY = (128, 128, 128)
MAX_ALLOCATED_BYTES = 10 * 1024**3
MAX_PACKED_MASK_BYTES = 19 * 1024**2
MAX_SOURCE_BYTES = 24 * 1024**2
MAX_SOURCE_PIXELS = 2_097_152
INIT_DEADLINE_SECONDS = 120
CASE_DEADLINE_SECONDS = 240
FAMILY_ORDER = {"D": 0, "U": 1}


class ProbeError(RuntimeError):
    pass


class DeadlineExceeded(ProbeError):
    pass


@dataclass(frozen=True)
class Candidate:
    family: str
    ordinal: int
    alias: str
    source_family: str
    source_alias: str
    source_mask_path: str
    source_mask_sha256: str
    mask_packed: bytes


@dataclass(frozen=True)
class CropGeometry:
    crop_xyxy: tuple[int, int, int, int]
    source_crop_size: tuple[int, int]
    resized_size: tuple[int, int]
    pad_ltrb: tuple[int, int, int, int]
    output_size: tuple[int, int]


@dataclass(frozen=True)
class CandidateScore:
    family: str
    ordinal: int
    alias: str
    source_family: str
    source_alias: str
    source_mask_path: str
    source_mask_sha256: str
    crop_xyxy: tuple[int, int, int, int]
    resize_geometry: CropGeometry
    clean_cosine: float
    masked_cosine: float
    mean_cosine: float
    global_rank: int
    family_rank: int


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def build_asset_lock(asset_dir: Path) -> dict[str, Any]:
    """Verify the explicit local asset directory and return its byte lock."""
    asset_dir = asset_dir.resolve(strict=True)
    receipts: list[dict[str, Any]] = []
    for name in ASSET_FILES:
        path = asset_dir / name
        if path.is_symlink() or not path.is_file():
            raise ProbeError(f"missing or symlinked pinned model file: {name}")
        digest, size = sha256_file(path)
        expected_digest, expected_size = EXPECTED_ASSETS[name]
        if digest != expected_digest or size != expected_size:
            raise ProbeError(f"pinned byte lock mismatch: {name}")
        receipts.append({"path": name, "sha256": digest, "bytes": size})
    extra = sorted(path.name for path in asset_dir.iterdir() if path.is_file() and path.name not in ASSET_FILES)
    if extra:
        raise ProbeError("unexpected files in model asset directory: " + ", ".join(extra))
    return {
        "model_id": MODEL_ID,
        "revision": MODEL_REVISION,
        "license": EXPECTED_LICENSE,
        "asset_directory": str(asset_dir),
        "files": receipts,
    }


def unpack_packed_mask(mask_packed: bytes, width: int, height: int) -> np.ndarray:
    if not isinstance(mask_packed, bytes) or width < 1 or height < 1:
        raise ProbeError("candidate mask must be owned packed bytes with positive dimensions")
    pixel_count = width * height
    expected_bytes = (pixel_count + 7) // 8
    if len(mask_packed) != expected_bytes:
        raise ProbeError("packed mask byte length differs from source dimensions")
    if pixel_count % 8 and mask_packed[-1] & ~((1 << (pixel_count % 8)) - 1):
        raise ProbeError("packed mask has nonzero padding bits")
    return np.unpackbits(
        np.frombuffer(mask_packed, dtype=np.uint8), bitorder="little", count=pixel_count
    ).reshape(height, width).astype(np.bool_, copy=False)


def _validate_image(image: Image.Image) -> None:
    if image.mode != "RGB":
        raise ProbeError("source image must be RGB")


def context_crop_xyxy(mask: np.ndarray, width: int, height: int) -> tuple[int, int, int, int]:
    if mask.dtype != np.bool_ or mask.shape != (height, width):
        raise ProbeError("candidate mask dimensions differ from declared source dimensions")
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise ProbeError("empty mask has no actual-foreground context crop")
    left = int(xs.min())
    top = int(ys.min())
    right = int(xs.max()) + 1
    bottom = int(ys.max()) + 1
    foreground_width = right - left
    foreground_height = bottom - top
    x0 = max(0, math.floor(left - CONTEXT_FRACTION * foreground_width))
    y0 = max(0, math.floor(top - CONTEXT_FRACTION * foreground_height))
    x1 = min(width, math.ceil(right + CONTEXT_FRACTION * foreground_width))
    y1 = min(height, math.ceil(bottom + CONTEXT_FRACTION * foreground_height))
    if x1 <= x0 or y1 <= y0:
        raise ProbeError("foreground context crop is degenerate")
    return x0, y0, x1, y1


def contain512(image: Image.Image) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """Resize bilinearly without stretch, then center on opaque neutral gray."""
    if image.mode != "RGB" or image.width < 1 or image.height < 1:
        raise ProbeError("view must be a non-empty RGB image")
    scale = min(MODEL_INPUT_SIZE / image.width, MODEL_INPUT_SIZE / image.height)
    resized_width = min(MODEL_INPUT_SIZE, max(1, math.floor(image.width * scale + 0.5)))
    resized_height = min(MODEL_INPUT_SIZE, max(1, math.floor(image.height * scale + 0.5)))
    resized = image.resize((resized_width, resized_height), Image.Resampling.BILINEAR)
    left = (MODEL_INPUT_SIZE - resized_width) // 2
    top = (MODEL_INPUT_SIZE - resized_height) // 2
    right = MODEL_INPUT_SIZE - resized_width - left
    bottom = MODEL_INPUT_SIZE - resized_height - top
    canvas = Image.new("RGB", (MODEL_INPUT_SIZE, MODEL_INPUT_SIZE), GRAY)
    canvas.paste(resized, (left, top))
    resized.close()
    return canvas, (left, top, right, bottom)


def candidate_views(image: Image.Image, mask_packed: bytes) -> tuple[Image.Image, Image.Image, CropGeometry]:
    _validate_image(image)
    mask_copy = unpack_packed_mask(mask_packed, image.width, image.height)
    crop = context_crop_xyxy(mask_copy, image.width, image.height)
    x0, y0, x1, y1 = crop
    clean_crop = image.crop(crop)
    crop_mask: np.ndarray | None = None
    masked_pixels: np.ndarray | None = None
    masked_crop: Image.Image | None = None
    clean_view: Image.Image | None = None
    masked_view: Image.Image | None = None
    try:
        crop_mask = mask_copy[y0:y1, x0:x1]
        masked_pixels = np.asarray(clean_crop, dtype=np.uint8).copy()
        masked_pixels[~crop_mask] = GRAY
        masked_crop = Image.fromarray(masked_pixels, mode="RGB")
        clean_view, clean_padding = contain512(clean_crop)
        masked_view, masked_padding = contain512(masked_crop)
        if clean_padding != masked_padding:
            raise ProbeError("clean and mask-aware view transforms diverged")
    except BaseException:
        if clean_view is not None:
            clean_view.close()
        if masked_view is not None:
            masked_view.close()
        raise
    finally:
        clean_crop.close()
        if masked_crop is not None:
            masked_crop.close()
        del mask_copy
        if crop_mask is not None:
            del crop_mask
        if masked_pixels is not None:
            del masked_pixels
    if clean_view is None or masked_view is None:
        raise ProbeError("view transform did not produce both required views")
    geometry = CropGeometry(
        crop_xyxy=crop,
        source_crop_size=(x1 - x0, y1 - y0),
        resized_size=(MODEL_INPUT_SIZE - clean_padding[0] - clean_padding[2], MODEL_INPUT_SIZE - clean_padding[1] - clean_padding[3]),
        pad_ltrb=clean_padding,
        output_size=(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE),
    )
    return clean_view, masked_view, geometry


def _candidate_identity_key(candidate: Candidate) -> tuple[int, int]:
    if candidate.family not in FAMILY_ORDER:
        raise ProbeError("candidate family must be D or U")
    if candidate.ordinal < 0:
        raise ProbeError("candidate ordinal must be nonnegative")
    return FAMILY_ORDER[candidate.family], candidate.ordinal


def rank_scores(
    candidates: Sequence[Candidate],
    view_scores: Sequence[tuple[float, float]],
    geometries: Sequence[CropGeometry],
) -> list[CandidateScore]:
    if len(candidates) != len(view_scores) or len(candidates) != len(geometries):
        raise ProbeError("candidate score and geometry lengths must match")
    if len(candidates) > 72:
        raise ProbeError("candidate total exceeds the frozen 72-mask limit")
    if len({(candidate.family, candidate.ordinal) for candidate in candidates}) != len(candidates):
        raise ProbeError("candidate family/ordinal keys must be unique")
    means: list[float] = []
    for clean, masked in view_scores:
        if not math.isfinite(clean) or not math.isfinite(masked):
            raise ProbeError("similarity score is non-finite")
        means.append((clean + masked) / 2)
    order = sorted(
        range(len(candidates)),
        key=lambda index: (-means[index], *_candidate_identity_key(candidates[index])),
    )
    global_ranks = {index: rank + 1 for rank, index in enumerate(order)}
    family_orders: dict[str, list[int]] = {"D": [], "U": []}
    for index in order:
        family_orders[candidates[index].family].append(index)
    family_ranks = {
        index: rank + 1
        for indexes in family_orders.values()
        for rank, index in enumerate(indexes)
    }
    result: list[CandidateScore] = []
    for index, candidate in enumerate(candidates):
        clean, masked = view_scores[index]
        result.append(
            CandidateScore(
                family=candidate.family,
                ordinal=candidate.ordinal,
                alias=candidate.alias,
                source_family=candidate.source_family,
                source_alias=candidate.source_alias,
                source_mask_path=candidate.source_mask_path,
                source_mask_sha256=candidate.source_mask_sha256,
                crop_xyxy=geometries[index].crop_xyxy,
                resize_geometry=geometries[index],
                clean_cosine=clean,
                masked_cosine=masked,
                mean_cosine=means[index],
                global_rank=global_ranks[index],
                family_rank=family_ranks[index],
            )
        )
    return result


class Deadline:
    """Caller-owned absolute deadline; construct before decode/preparation."""

    def __init__(self, seconds: float, label: str):
        self.seconds = seconds
        self.label = label
        self.started = time.monotonic()

    def check(self) -> None:
        if time.monotonic() - self.started >= self.seconds:
            raise DeadlineExceeded(f"{self.label} deadline exceeded")


def load_encoder(asset_dir: Path) -> tuple[Any, Any, Any, dict[str, Any]]:
    """Load the pinned local encoder only; never resolves or downloads a model."""
    import torch
    from transformers import AutoTokenizer, SiglipImageProcessor, SiglipModel

    lock = build_asset_lock(asset_dir)
    config = json.loads((asset_dir / "config.json").read_text(encoding="utf-8"))
    image_config = json.loads((asset_dir / "preprocessor_config.json").read_text(encoding="utf-8"))
    if config.get("model_type") != "siglip" or config.get("vision_config", {}).get("image_size") != MODEL_INPUT_SIZE:
        raise ProbeError("checkpoint config differs from the pinned SigLIP 2 base/512 recipe")
    if image_config.get("image_processor_type") != "SiglipImageProcessor" or image_config.get("size") != {"height": 512, "width": 512}:
        raise ProbeError("image processor config differs from pinned 512-pixel recipe")
    if not torch.cuda.is_available():
        raise ProbeError("CUDA is required for this frozen experiment")
    total_bytes = torch.cuda.get_device_properties(0).total_memory
    if total_bytes < MAX_ALLOCATED_BYTES:
        raise ProbeError("CUDA device has less than the fixed 10 GiB allocation ceiling")
    torch.cuda.set_per_process_memory_fraction(MAX_ALLOCATED_BYTES / total_bytes, 0)
    torch.cuda.reset_peak_memory_stats(0)
    deadline = Deadline(INIT_DEADLINE_SECONDS, "encoder initialization")
    model = SiglipModel.from_pretrained(
        str(asset_dir),
        local_files_only=True,
        trust_remote_code=False,
        use_safetensors=True,
        dtype=torch.float16,
    )
    deadline.check()
    model.to(torch.device("cuda:0"))
    model.eval()
    processor = SiglipImageProcessor.from_pretrained(
        str(asset_dir), local_files_only=True, trust_remote_code=False
    )
    tokenizer = AutoTokenizer.from_pretrained(
        str(asset_dir), local_files_only=True, trust_remote_code=False, use_fast=True
    )
    if not getattr(tokenizer, "is_fast", False):
        raise ProbeError("the pinned fast tokenizer did not load")
    deadline.check()
    return model, processor, tokenizer, lock


def tokenize_padded_target(tokenizer: Any, target: str, maximum: int) -> dict[str, Any]:
    if not target or not target.strip():
        raise ProbeError("authored target must be non-empty")
    tokens = tokenizer(target, truncation=False, padding=False)
    if len(tokens["input_ids"]) > maximum:
        raise ProbeError("authored target exceeds the pinned model text limit")
    # The tokenizer call above returns one unbatched feature mapping. Wrap that
    # existing encoding for pad() so its tensor output keeps a batch dimension;
    # this does not re-tokenize the authored target.
    padded = tokenizer.pad([tokens], padding="max_length", max_length=maximum, return_tensors="pt")
    if padded["input_ids"].shape[1] != maximum:
        raise ProbeError("checkpoint tokenizer failed fixed-length text padding")
    return dict(padded)


def encode_target(model: Any, tokenizer: Any, target: str) -> Any:
    import torch
    import torch.nn.functional as functional

    maximum = int(model.config.text_config.max_position_embeddings)
    tokens = tokenize_padded_target(tokenizer, target, maximum)
    tokens = {name: value.to("cuda:0") for name, value in tokens.items()}
    with torch.inference_mode():
        features = model.get_text_features(**tokens)
        normalized = functional.normalize(features.float(), p=2, dim=-1)
    del tokens, features
    return normalized


def score_case(
    model: Any,
    processor: Any,
    tokenizer: Any,
    image: Image.Image,
    target: str,
    candidates: Sequence[Candidate],
    case_deadline: Deadline,
) -> tuple[list[CandidateScore], dict[str, int], dict[str, float]]:
    import torch
    import torch.nn.functional as functional

    if len(candidates) > 72:
        raise ProbeError("candidate total exceeds the frozen 72-mask limit")
    family_counts = {family: sum(candidate.family == family for candidate in candidates) for family in ("D", "U")}
    if any(count > 36 for count in family_counts.values()):
        raise ProbeError("candidate family exceeds the frozen 36-mask limit")
    if sum(len(candidate.mask_packed) for candidate in candidates) > MAX_PACKED_MASK_BYTES:
        raise ProbeError("aggregate packed masks exceed the frozen 19 MiB limit")
    case_deadline.check()
    case_started = time.perf_counter()
    torch.cuda.reset_peak_memory_stats(0)
    text_started = time.perf_counter()
    text_embedding = encode_target(model, tokenizer, target)
    text_encoding_ms = (time.perf_counter() - text_started) * 1000
    try:
        view_scores: list[tuple[float, float]] = []
        geometries: list[CropGeometry] = []
        preparation_ms = 0.0
        image_encoding_ms = 0.0
        for start in range(0, len(candidates), 2):
            case_deadline.check()
            batch_candidates = candidates[start : start + 2]
            views: list[Image.Image] = []
            try:
                preparation_started = time.perf_counter()
                for candidate in batch_candidates:
                    clean, masked, geometry = candidate_views(image, candidate.mask_packed)
                    views.extend((clean, masked))
                    geometries.append(geometry)
                pixel_values = processor(
                    images=views, do_resize=False, return_tensors="pt"
                )["pixel_values"].to(
                    device="cuda:0", dtype=torch.float16
                )
                preparation_ms += (time.perf_counter() - preparation_started) * 1000
                encoding_started = time.perf_counter()
                with torch.inference_mode():
                    visual = functional.normalize(
                        model.get_image_features(pixel_values=pixel_values).float(), p=2, dim=-1
                    )
                    cosine = (visual @ text_embedding.T).squeeze(1).detach().cpu().tolist()
                image_encoding_ms += (time.perf_counter() - encoding_started) * 1000
                if len(cosine) != 2 * len(batch_candidates):
                    raise ProbeError("image encoder returned an unexpected number of features")
                view_scores.extend(
                    (float(cosine[index]), float(cosine[index + 1]))
                    for index in range(0, len(cosine), 2)
                )
                del pixel_values, visual, cosine
                if torch.cuda.max_memory_allocated(0) > MAX_ALLOCATED_BYTES:
                    raise ProbeError("CUDA allocation exceeded the fixed 10 GiB ceiling")
            finally:
                for view in views:
                    view.close()
        case_deadline.check()
        scores = rank_scores(candidates, view_scores, geometries)
        return scores, {
            "allocated_peak_bytes": int(torch.cuda.max_memory_allocated(0)),
            "reserved_peak_bytes": int(torch.cuda.max_memory_reserved(0)),
        }, {
            "target_encoding_ms": text_encoding_ms,
            "view_preparation_ms": preparation_ms,
            "image_encoding_ms": image_encoding_ms,
            "case_scoring_ms": (time.perf_counter() - case_started) * 1000,
        }
    finally:
        text_embedding = None


def synthetic_case() -> tuple[Image.Image, str, list[Candidate]]:
    width, height = 360, 240
    yy, xx = np.mgrid[:height, :width]
    pixels = np.stack(
        [xx.astype(np.uint8), yy.astype(np.uint8), ((xx + yy) // 2).astype(np.uint8)], axis=-1
    )
    image = Image.fromarray(pixels, mode="RGB")
    red = np.zeros((height, width), dtype=np.bool_)
    red[72:144, 64:148] = True
    green = np.zeros((height, width), dtype=np.bool_)
    green[(xx - 260) ** 2 + (yy - 122) ** 2 <= 42**2] = True
    red_packed = np.packbits(red.reshape(-1), bitorder="little").tobytes()
    green_packed = np.packbits(green.reshape(-1), bitorder="little").tobytes()
    candidates = [
        Candidate("D", 0, "D00", "synthetic", "D00", "synthetic/D00.png", "0" * 64, red_packed),
        Candidate("U", 0, "U00", "synthetic", "U00", "synthetic/U00.png", "1" * 64, green_packed),
    ]
    return image, "a red square", candidates


def run_synthetic_probe(asset_dir: Path, output: Path) -> dict[str, Any]:
    started = time.monotonic()
    model, processor, tokenizer, asset_lock = load_encoder(asset_dir)
    init_elapsed = time.monotonic() - started
    image, target, candidates = synthetic_case()
    case_deadline = Deadline(CASE_DEADLINE_SECONDS, "synthetic case")
    try:
        scores, memory, timing = score_case(
            model, processor, tokenizer, image, target, candidates, case_deadline
        )
    finally:
        image.close()
    result = {
        "schema": "v03-h7-synthetic-runtime-probe-v1",
        "kind": "synthetic-runtime-only",
        "producer_source": {
            "path": Path(__file__).name,
            "sha256": sha256_file(Path(__file__))[0],
        },
        "model_lock": asset_lock,
        "runtime": {
            "torch": __import__("torch").__version__,
            "transformers": __import__("transformers").__version__,
            "device": __import__("torch").cuda.get_device_name(0),
            "dtype": "float16",
            "initialization_ms": round(init_elapsed * 1000, 3),
        },
        "limits": {
            "batch_candidates": 2,
            "visual_views_per_candidate": 2,
            "input_size": MODEL_INPUT_SIZE,
            "max_cuda_allocated_bytes": MAX_ALLOCATED_BYTES,
            "initialization_deadline_ms": INIT_DEADLINE_SECONDS * 1000,
            "case_deadline_ms": CASE_DEADLINE_SECONDS * 1000,
        },
        "memory": memory,
        "timing_ms": timing,
        "rows": [
            {
                "case_id": "synthetic-local-probe",
                "status": "complete",
                "scores": [asdict(score) for score in sorted(scores, key=lambda item: item.global_rank)],
                "presence_decision": None,
            }
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return result


def _candidate_receipt_row(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "family": candidate.get("family"),
        "ordinal": candidate.get("ordinal"),
        "alias": candidate.get("alias"),
        "source_family": candidate.get("source_family"),
        "source_alias": candidate.get("source_alias"),
        "source_mask_path": candidate.get("source_mask_path"),
        "source_mask_sha256": candidate.get("source_mask_sha256"),
        "crop_xyxy": None,
        "resize_geometry": None,
        "clean_cosine": None,
        "masked_cosine": None,
        "mean_cosine": None,
        "global_rank": None,
        "family_rank": None,
    }


def _resolve_inside(path_value: str, root_value: str) -> Path:
    path = Path(path_value)
    if path.is_symlink():
        raise ProbeError("worker input path is a symlink")
    resolved = path.resolve(strict=True)
    root = Path(root_value).resolve(strict=True)
    if not root.is_dir():
        raise ProbeError("worker source root is not a directory")
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ProbeError("worker input escaped its pinned source root") from error
    if not resolved.is_file():
        raise ProbeError("worker input is not a regular file")
    return resolved


def _load_packed_candidate_mask(
    descriptor: dict[str, Any],
    roots: dict[str, str],
    width: int,
    height: int,
) -> Candidate:
    source_family = descriptor.get("source_family")
    root_key = {
        "h3b-dino-sam2": "h3b_run_directory",
        "omni-sam2": "h5a_run_directory",
        "h4e-sam2": "h4e_run_directory",
    }.get(source_family)
    if root_key is None:
        raise ProbeError("candidate has an unknown frozen source family")
    path = _resolve_inside(descriptor["resolved_source_mask_path"], roots[root_key])
    relative_path = Path(roots["h5a_run_directory"]) / descriptor["source_mask_path"]
    if relative_path.resolve(strict=True) != path:
        raise ProbeError("candidate relative mask path does not resolve to its locked source")
    digest, size = sha256_file(path)
    if digest != descriptor.get("source_mask_sha256"):
        raise ProbeError("candidate source mask SHA-256 differs from the frozen input")
    if size > MAX_SOURCE_BYTES:
        raise ProbeError("candidate source mask exceeds the per-file byte ceiling")
    with Image.open(path) as source:
        if source.format != "PNG" or getattr(source, "n_frames", 1) != 1:
            raise ProbeError("candidate source mask must be a single-frame PNG")
        source.load()
        grayscale = source.convert("L")
    try:
        if grayscale.size != (width, height):
            raise ProbeError("candidate mask dimensions differ from the source image")
        values = np.asarray(grayscale, dtype=np.uint8)
        if np.any((values != 0) & (values != 255)):
            raise ProbeError("candidate mask is not strictly binary")
        packed_mask = np.packbits((values == 255).reshape(-1), bitorder="little").tobytes()
        del values
    finally:
        grayscale.close()
    if not any(packed_mask):
        raise ProbeError("candidate mask has no actual foreground pixels")
    return Candidate(
        family=descriptor["family"],
        ordinal=descriptor["ordinal"],
        alias=descriptor["alias"],
        source_family=source_family,
        source_alias=descriptor["source_alias"],
        source_mask_path=descriptor["source_mask_path"],
        source_mask_sha256=digest,
        mask_packed=packed_mask,
    )


def _load_source_image(case: dict[str, Any], roots: dict[str, str]) -> Image.Image:
    path = _resolve_inside(case["source_path"], roots["source_image_root"])
    digest, size = sha256_file(path)
    if digest != case.get("source_sha256"):
        raise ProbeError("source image SHA-256 differs from the frozen input")
    if size > MAX_SOURCE_BYTES:
        raise ProbeError("source image exceeds the frozen 24 MiB byte ceiling")
    if case["source_width"] * case["source_height"] > MAX_SOURCE_PIXELS:
        raise ProbeError("source image exceeds the frozen decoded pixel ceiling")
    with Image.open(path) as source:
        if source.format not in {"PNG", "JPEG", "WEBP"} or getattr(source, "n_frames", 1) != 1:
            raise ProbeError("source image must be a single-frame PNG, JPEG or WebP")
        source.load()
        oriented = ImageOps.exif_transpose(source)
        try:
            image = oriented.convert("RGB")
        finally:
            if oriented is not source:
                oriented.close()
    if image.size != (case["source_width"], case["source_height"]):
        image.close()
        raise ProbeError("oriented source dimensions differ from frozen native masks")
    return image


def _validate_worker_case(case: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    if not isinstance(case, dict) or case.get("command") != "case":
        raise ProbeError("worker expected a case command")
    payload = case.get("payload")
    if not isinstance(payload, dict):
        raise ProbeError("worker case payload is invalid")
    candidate_inputs = payload.get("candidates")
    roots = payload.get("source_roots")
    if not isinstance(candidate_inputs, list) or not isinstance(roots, dict):
        raise ProbeError("worker case is missing candidate roster or source roots")
    if len(candidate_inputs) > 72:
        raise ProbeError("candidate total exceeds the frozen 72-mask limit")
    if any(not isinstance(root, str) or not root for root in roots.values()):
        raise ProbeError("worker source root map is invalid")
    for root_key in ("h5a_run_directory", "h3b_run_directory", "h4e_run_directory", "source_image_root"):
        if root_key not in roots:
            raise ProbeError(f"worker source root missing: {root_key}")
        root = Path(roots[root_key])
        if root.is_symlink() or not root.resolve(strict=True).is_dir():
            raise ProbeError(f"worker source root is not a real directory: {root_key}")
    family_counts = {family: 0 for family in ("D", "U")}
    for candidate in candidate_inputs:
        if candidate.get("family") not in family_counts:
            raise ProbeError("candidate family must be D or U")
        ordinal = candidate.get("ordinal")
        if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal != family_counts[candidate["family"]]:
            raise ProbeError("candidate ordinals are not contiguous in frozen family order")
        if candidate.get("alias") != f"{candidate['family']}{ordinal:02d}":
            raise ProbeError("candidate composer alias differs from frozen family ordinal")
        family_counts[candidate["family"]] += 1
        if family_counts[candidate["family"]] > 36:
            raise ProbeError("candidate family exceeds the frozen 36-mask limit")
    if [item["family"] for item in candidate_inputs] != sorted(
        (item["family"] for item in candidate_inputs), key=lambda family: FAMILY_ORDER[family]
    ):
        raise ProbeError("candidate roster is not in frozen D-before-U order")
    if not isinstance(payload.get("target"), str) or not payload["target"].strip() or len(payload["target"]) > 2000:
        raise ProbeError("authored target is invalid")
    return candidate_inputs, roots


def run_worker_case(
    model: Any,
    processor: Any,
    tokenizer: Any,
    request: dict[str, Any],
) -> dict[str, Any]:
    payload = request["payload"]
    case_id = str(payload.get("case_id", "unknown-case"))
    candidates_input = payload.get("candidates", [])
    row = {
        "case_id": case_id,
        "target": payload.get("target"),
        "source_sha256": payload.get("source_sha256"),
        "source_width": payload.get("source_width"),
        "source_height": payload.get("source_height"),
        "status": "error",
        "error_code": None,
        "error": None,
        "timing_ms": {
            "input_load_ms": 0.0,
            "target_encoding_ms": 0.0,
            "view_preparation_ms": 0.0,
            "image_encoding_ms": 0.0,
            "case_scoring_ms": 0.0,
            "case_total_ms": 0.0,
            "serialization_ms": 0.0,
        },
        "memory": {"allocated_peak_bytes": None, "reserved_peak_bytes": None},
        "candidates": [_candidate_receipt_row(candidate) for candidate in candidates_input],
    }
    started = time.perf_counter()
    deadline = Deadline(CASE_DEADLINE_SECONDS, "H7 absolute case")
    image: Image.Image | None = None
    try:
        candidate_inputs, roots = _validate_worker_case(request)
        deadline.check()
        image = _load_source_image(payload, roots)
        source_dimensions = (image.width, image.height)
        packed_candidates = [
            _load_packed_candidate_mask(candidate, roots, *source_dimensions)
            for candidate in candidate_inputs
        ]
        total_packed = sum(len(candidate.mask_packed) for candidate in packed_candidates)
        if total_packed > MAX_PACKED_MASK_BYTES:
            raise ProbeError("aggregate packed masks exceed the frozen 19 MiB limit")
        row["timing_ms"]["input_load_ms"] = (time.perf_counter() - started) * 1000
        deadline.check()
        scores, memory, scoring = score_case(
            model, processor, tokenizer, image, payload["target"], packed_candidates, deadline
        )
        row["status"] = "complete"
        row["memory"] = memory
        row["timing_ms"].update(scoring)
        row["candidates"] = [asdict(score) for score in scores]
        deadline.check()
    except Exception as error:
        row["status"] = "timeout" if isinstance(error, DeadlineExceeded) else "error"
        row["error_code"] = error.__class__.__name__
        row["error"] = str(error)[:500]
    finally:
        row["timing_ms"]["case_total_ms"] = (time.perf_counter() - started) * 1000
        if image is not None:
            image.close()
    return row


def run_worker(asset_dir: Path) -> int:
    _bind_worker_to_parent()
    model, processor, tokenizer, asset_lock = load_encoder(asset_dir)
    import torch
    import transformers

    ready = {
        "type": "ready",
        "model_lock": asset_lock,
        "runtime": {
            "python": sys.version.split()[0],
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "numpy": np.__version__,
            "pillow": Image.__version__,
            "cuda_runtime": torch.version.cuda,
            "device": torch.cuda.get_device_name(0),
            "dtype": "float16",
            "ownership": "linux-pr-set-pdeathsig-sigterm",
        },
        "memory": {
            "allocated_baseline_bytes": int(torch.cuda.memory_allocated(0)),
            "reserved_baseline_bytes": int(torch.cuda.memory_reserved(0)),
        },
    }
    sys.stdout.write(json.dumps(ready, allow_nan=False) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        if not line:
            break
        try:
            request = json.loads(line)
            if request.get("command") == "close":
                sys.stdout.write(json.dumps({"type": "closed"}) + "\n")
                sys.stdout.flush()
                break
            row = run_worker_case(model, processor, tokenizer, request)
            serialization_start = time.perf_counter()
            response = {"type": "case_result", "case_id": row["case_id"], "row": row}
            serialized = json.dumps(response, allow_nan=False)
            row["timing_ms"]["serialization_ms"] = (time.perf_counter() - serialization_start) * 1000
            serialized = json.dumps(response, allow_nan=False)
            sys.stdout.write(serialized + "\n")
            sys.stdout.flush()
        except Exception as error:
            failure = {
                "type": "protocol_error",
                "error_code": error.__class__.__name__,
                "error": str(error)[:500],
            }
            sys.stdout.write(json.dumps(failure, allow_nan=False) + "\n")
            sys.stdout.flush()
    return 0


def _bind_worker_to_parent() -> None:
    """Ensure a lost Node owner cannot leave this model worker alive on GPU."""
    if not sys.platform.startswith("linux"):
        raise ProbeError("the frozen worker lifecycle requires Linux parent-death signaling")
    parent_pid = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
    prctl.restype = ctypes.c_int
    # Linux PR_SET_PDEATHSIG=1. Check after registration to cover the setup race.
    if prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise ProbeError(f"could not bind worker to owner process (errno {error})")
    if os.getppid() != parent_pid:
        raise ProbeError("worker owner exited during parent-death registration")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--synthetic-probe", type=Path, help="write one synthetic-only runtime receipt")
    mode.add_argument("--worker", action="store_true", help="run the persistent JSON-lines worker")
    args = parser.parse_args()
    if args.worker:
        return run_worker(args.asset_dir)
    if args.synthetic_probe is None:
        raise ProbeError("synthetic probe output path is required")
    run_synthetic_probe(args.asset_dir, args.synthetic_probe)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProbeError as error:
        raise SystemExit(f"H7 probe failed: {error}") from error
