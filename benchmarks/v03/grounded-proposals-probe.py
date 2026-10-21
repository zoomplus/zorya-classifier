#!/usr/bin/env python3
"""Bounded, producer-only GroundingDINO-T + SAM2-Tiny DEV availability probe."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from pathlib import Path
from typing import Any


GROUNDING_REPO = "IDEA-Research/grounding-dino-tiny"
GROUNDING_REVISION = "a2bb814dd30d776dcf7e30523b00659f4f141c71"
SAM2_REPO = "facebook/sam2-hiera-tiny"
SAM2_REVISION = "7c218beaf0bb87874785f32b582f640134fc1c09"
TRANSFORMERS_VERSION = "4.57.3"
BOX_THRESHOLD = 0.15
TEXT_THRESHOLD = 0.15
MAX_CANDIDATES = 36
CASE_DEADLINE_SECONDS = 240
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_IMAGE_PIXELS = 2_097_152
EXPECTED_CASE_IDS = tuple(
    [f"pilot-v03-photo-{i:02d}" for i in range(1, 5)]
    + [f"pilot-v03-ui-{i:02d}" for i in range(1, 5)]
    + [f"pilot-v03-map-{i:02d}" for i in range(1, 5)]
)

# The original effc2e8 input serialization and the later whitespace-only pinned
# serialization carry the same twelve rows. No other manifest digest is accepted.
MANIFESTS = {
    "photo.json": {
        "sha256": {
            "daa1759c5a08b7abf827641843df80e6b777fae8c0c04ac651fa7435235003fa",
            "ee1d36d254f3aeddd9b9739143754dfbdc3409e155ab76334e10cf04e0bfb44b",
        },
        "ids": tuple(f"pilot-v03-photo-{i:02d}" for i in range(1, 5)),
    },
    "ui.json": {
        "sha256": {
            "7b1038e6ecb32b7ddce0af7fabe1b9afbcc63e6aaa075b77591357a28681b1bb",
            "5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f",
        },
        "ids": tuple(f"pilot-v03-ui-{i:02d}" for i in range(1, 5)),
    },
    "map.json": {
        "sha256": {
            "602844b8c2add14ec6d96424dc03a8c0a39c4cb15a0397f78a9d29778d805d81",
            "6886670e7f9529805196fe8502975f78c968ff612bfa3279c323cad215ba89c4",
        },
        "ids": tuple(f"pilot-v03-map-{i:02d}" for i in range(1, 5)),
    },
}

MODEL_FILES: tuple[dict[str, Any], ...] = (
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "model.safetensors",
        "size": 689_359_096,
        "sha256": "1a2412ef99bd74bcd3c2a246fa1e48581f8889a1300c9051974741314fc042f3",
        "xet_hash": "acd477aee0458b97b8193f69297506afa0b913b560a45928c04a3bc2fbff7584",
    },
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "added_tokens.json",
        "size": 82,
        "sha256": "909e96cb32d92ce728a01bc99850cbba26196d74115c17ebeb019275412588f2",
    },
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "config.json",
        "size": 1644,
        "sha256": "eec82c5ab66e16df12a9a212e68ac011779927c2536cf9078658e35d85f0c67a",
    },
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "preprocessor_config.json",
        "size": 457,
        "sha256": "8454179ba95e2ad22947835aad7b45862a601fc0055ab88bf1ee70892d3aea60",
    },
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "special_tokens_map.json",
        "size": 125,
        "sha256": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    },
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "tokenizer.json",
        "size": 711_396,
        "sha256": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    },
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "tokenizer_config.json",
        "size": 1237,
        "sha256": "d40ab645b68211910b9170d22433d43186a6ec8ee6fd10ba170524b25bf4fb56",
    },
    {
        "repo": GROUNDING_REPO,
        "revision": GROUNDING_REVISION,
        "directory": "grounding-dino-tiny",
        "filename": "vocab.txt",
        "size": 231_508,
        "sha256": "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    },
    {
        "repo": SAM2_REPO,
        "revision": SAM2_REVISION,
        "directory": "sam2-hiera-tiny",
        "filename": "model.safetensors",
        "size": 155_841_672,
        "sha256": "1449035ba6ba2ed524c646da989e5cb3a9b93b97f1c1b2d474e598c3b748d99f",
        "xet_hash": "5cccdbf88e48ab0a87fc4bbbc0ab619f0c97a572d370280f30e86f991bd388a9",
    },
    {
        "repo": SAM2_REPO,
        "revision": SAM2_REVISION,
        "directory": "sam2-hiera-tiny",
        "filename": "config.json",
        "size": 5697,
        "sha256": "3239c7ecf212b1a9d9f98310c8993612335c5596a12c8cfba25e512e9dc5965b",
    },
    {
        "repo": SAM2_REPO,
        "revision": SAM2_REVISION,
        "directory": "sam2-hiera-tiny",
        "filename": "preprocessor_config.json",
        "size": 683,
        "sha256": "6ebf229ee259368ce4a8d4f2fe893a72b053023710853e257253939e601f583d",
    },
    {
        "repo": SAM2_REPO,
        "revision": SAM2_REVISION,
        "directory": "sam2-hiera-tiny",
        "filename": "processor_config.json",
        "size": 95,
        "sha256": "f8a68e865cfad115c1c2763f3d93eca7b1c622da06da2a9273eb437fb2389b6d",
    },
)


class ProbeError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def model_manifest() -> dict[str, Any]:
    return {
        "license": "Apache-2.0",
        "transformers_version": TRANSFORMERS_VERSION,
        "models": [
            {
                "repo": GROUNDING_REPO,
                "revision": GROUNDING_REVISION,
                "directory": "grounding-dino-tiny",
            },
            {"repo": SAM2_REPO, "revision": SAM2_REVISION, "directory": "sam2-hiera-tiny"},
        ],
        "files": [
            {
                key: item[key]
                for key in ("repo", "revision", "directory", "filename", "size", "sha256", "xet_hash")
                if key in item
            }
            for item in MODEL_FILES
        ],
    }


def file_path(assets_dir: Path, item: dict[str, Any]) -> Path:
    return assets_dir / item["directory"] / item["filename"]


def verify_assets(assets_dir: Path) -> dict[str, Any]:
    verified = []
    for item in MODEL_FILES:
        path = file_path(assets_dir, item)
        if not path.is_file():
            raise ProbeError(f"Required pinned model file is missing: {item['directory']}/{item['filename']}")
        size = path.stat().st_size
        digest = sha256_file(path)
        if size != item["size"] or digest != item["sha256"]:
            raise ProbeError(f"Pinned model file hash or size mismatch: {item['directory']}/{item['filename']}")
        verified.append({**item, "actual_size": size, "actual_sha256": digest})
    result = model_manifest()
    result["verified_files"] = verified
    return result


def fetch_assets(assets_dir: Path) -> dict[str, Any]:
    assets_dir.mkdir(parents=True, exist_ok=True)
    for item in MODEL_FILES:
        path = file_path(assets_dir, item)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            raise ProbeError(f"Refusing symlink at pinned asset path: {path}")
        if path.exists():
            size = path.stat().st_size
            digest = sha256_file(path) if path.is_file() else ""
            if size == item["size"] and digest == item["sha256"]:
                continue
            raise ProbeError(f"Existing pinned asset differs; refusing overwrite: {path}")
        url = f"https://huggingface.co/{item['repo']}/resolve/{item['revision']}/{item['filename']}"
        temp_path: Path | None = None
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept-Encoding": "identity"}), timeout=60) as response:
                fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
                temp_path = Path(temp_name)
                count = 0
                digest = hashlib.sha256()
                with os.fdopen(fd, "wb") as stream:
                    while chunk := response.read(1024 * 1024):
                        count += len(chunk)
                        if count > item["size"]:
                            raise ProbeError(f"Pinned asset exceeds expected byte size: {path.name}")
                        digest.update(chunk)
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
            if count != item["size"] or digest.hexdigest() != item["sha256"]:
                raise ProbeError(f"Downloaded asset hash or size mismatch: {path.name}")
            os.replace(temp_path, path)
            temp_path = None
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
    result = verify_assets(assets_dir)
    manifest_path = assets_dir / "asset-manifest.json"
    write_json_atomic(manifest_path, result)
    return result


def normalize_target(target: str) -> str:
    """Normalize only the frozen authored target grammar, never image/truth data."""
    value = target.strip()
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*", value):
        return value

    value = re.sub(r"^(?:the|a|an)\s+", "", value, flags=re.IGNORECASE).strip()
    map_match = re.match(
        r"^visible body sprite of unit type ([A-Za-z0-9-]+) in the main Freeciv map canvas; exclude health bars and selection brackets$",
        value,
        flags=re.IGNORECASE,
    )
    if map_match:
        return f"{map_match.group(1)} unit"

    if " in the " in value:
        phrase = value.split(" in the ", 1)[0].strip()
        if phrase and len(phrase.split()) <= 5:
            return phrase

    raise ProbeError("Authored target does not match the frozen noun normalization grammar")


def load_fixed_cases(manifest_dir: Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
    cases: list[dict[str, Any]] = []
    manifest_hashes: dict[str, str] = {}
    for name, expected in MANIFESTS.items():
        path = manifest_dir / name
        raw = path.read_bytes()
        digest = sha256_bytes(raw)
        if digest not in expected["sha256"]:
            raise ProbeError(f"Fixed producer manifest hash mismatch: {name}")
        rows = json.loads(raw)
        if not isinstance(rows, list) or tuple(row.get("caseId") for row in rows) != expected["ids"]:
            raise ProbeError(f"Fixed producer manifest case IDs differ: {name}")
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("locate"), dict):
                raise ProbeError(f"Malformed fixed producer row in {name}")
            target = row["locate"].get("target")
            if not isinstance(target, str):
                raise ProbeError(f"Missing authored target in {name}")
            row["normalized_target"] = normalize_target(target)
            row["manifest_file"] = name
        cases.extend(rows)
        manifest_hashes[name] = digest
    if tuple(row["caseId"] for row in cases) != EXPECTED_CASE_IDS:
        raise ProbeError("Fixed producer cohort differs from the twelve-case DEV manifest")
    return cases, manifest_hashes


def resolve_source(image_root: Path, case: dict[str, Any]) -> Path:
    root = image_root.resolve(strict=True)
    candidate = (root / case["image"]["path"]).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ProbeError("Manifest image path escaped configured image root") from error
    return candidate


def validate_image_bytes(case: dict[str, Any], image_root: Path) -> None:
    path = resolve_source(image_root, case)
    if path.stat().st_size > MAX_IMAGE_BYTES:
        raise ProbeError("Manifest image exceeds the fixed byte budget")
    data = path.read_bytes()
    try:
        if sha256_bytes(data) != case["image"]["sha256"]:
            raise ProbeError(f"Source image hash mismatch for {case['caseId']}")
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ProbeError("Unsupported source image format")
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ProbeError("Source image exceeds the fixed pixel budget")
            if (image.width, image.height) != (case["image"]["width"], case["image"]["height"]):
                raise ProbeError(f"Source dimensions differ from manifest for {case['caseId']}")
            if image.getexif().get(274, 1) != 1:
                raise ProbeError(f"Source orientation is not already normalized for {case['caseId']}")
    finally:
        data = b""


def validate_box(box: list[float], width: int, height: int) -> list[float]:
    if len(box) != 4 or not all(math.isfinite(float(value)) for value in box):
        raise ProbeError("Detector returned a malformed source box")
    x0, y0, x1, y1 = map(float, box)
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ProbeError("Detector box is outside the oriented source canvas")
    return [x0, y0, x1, y1]


def mask_bbox(mask: Any) -> list[int] | None:
    """Return half-open [left, top, right, bottom] bounds for a boolean mask."""
    ys, xs = mask.nonzero()
    if len(xs) == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def initialize_cuda_peak_tracking(torch: Any, device: Any) -> None:
    """Initialize the CUDA allocator before requesting its peak counters."""
    torch.cuda.init()
    torch.cuda.set_device(device)
    torch.cuda.synchronize(device)
    torch.cuda.reset_peak_memory_stats(device)


def mark_remaining_not_run(
    output_dir: Path,
    cases: list[dict[str, Any]],
    statuses: list[dict[str, Any]],
    after_index: int,
    failed_case_id: str,
) -> None:
    for index in range(after_index + 1, len(cases)):
        case_id = cases[index]["caseId"]
        row = {
            "case_id": case_id,
            "status": "not_run_after_first_error",
            "after_case_id": failed_case_id,
        }
        row_path = output_dir / "cases" / f"{case_id}.json"
        write_json_atomic(row_path, row)
        statuses[index] = {
            "case_id": case_id,
            "status": row["status"],
            "row_sha256": sha256_file(row_path),
        }


def bound_detections(detections: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Apply the fixed cap in model-return order, without score sorting."""
    return detections[:MAX_CANDIDATES], max(0, len(detections) - MAX_CANDIDATES)


def run_owned_child(
    command: list[str], stderr_log: Any, timeout_seconds: float
) -> tuple[str, float, str, bytes]:
    """Run one owned worker group and enforce its absolute wall-clock deadline."""
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=stderr_log,
        start_new_session=True,
        env={
            **os.environ,
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TOKENIZERS_PARALLELISM": "false",
        },
    )
    try:
        stdout, _ = process.communicate(timeout=timeout_seconds)
        elapsed_ms = (time.monotonic() - started) * 1000
        if process.returncode == 0:
            return "complete", elapsed_ms, "", stdout
        return "error", elapsed_ms, f"worker exited with status {process.returncode}", stdout
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
        return "timeout", (time.monotonic() - started) * 1000, "case exceeded absolute deadline", b""


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def child_case(case: dict[str, Any], image_root: Path, assets_dir: Path, output_dir: Path) -> dict[str, Any]:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

    import numpy as np
    import torch
    from PIL import Image
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor

    if not torch.cuda.is_available():
        raise ProbeError("CUDA device is unavailable")
    device = torch.device("cuda:0")
    dino_dir = assets_dir / "grounding-dino-tiny"
    sam_dir = assets_dir / "sam2-hiera-tiny"
    for path in (dino_dir, sam_dir):
        if not path.is_dir():
            raise ProbeError("Pinned local model directory is unavailable")

    started = time.monotonic()
    initialize_cuda_peak_tracking(torch, device)
    dino_processor = AutoProcessor.from_pretrained(dino_dir, local_files_only=True)
    dino_model = AutoModelForZeroShotObjectDetection.from_pretrained(
        dino_dir,
        local_files_only=True,
        use_safetensors=True,
        torch_dtype=torch.float16,
    ).to(device).eval()
    sam_processor = Sam2Processor.from_pretrained(sam_dir, local_files_only=True)
    sam_model = Sam2Model.from_pretrained(
        sam_dir,
        local_files_only=True,
        use_safetensors=True,
        torch_dtype=torch.float16,
    ).to(device).eval()

    source_path = resolve_source(image_root, case)
    source_bytes = source_path.read_bytes()
    if len(source_bytes) > MAX_IMAGE_BYTES or sha256_bytes(source_bytes) != case["image"]["sha256"]:
        raise ProbeError(f"Source image ownership/hash check failed for {case['caseId']}")
    with Image.open(io.BytesIO(source_bytes)) as opened:
        image = opened.convert("RGB")
    width, height = image.size
    if (width, height) != (case["image"]["width"], case["image"]["height"]):
        raise ProbeError(f"Source image dimensions differ for {case['caseId']}")

    detector_prompt = f"a {case['normalized_target']}"
    inputs = dino_processor(images=image, text=[[detector_prompt]], return_tensors="pt").to(device)
    torch.cuda.synchronize(device)
    detector_started = time.monotonic()
    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
        raw_outputs = dino_model(**inputs)
    detections = dino_processor.post_process_grounded_object_detection(
        raw_outputs,
        inputs.input_ids,
        threshold=BOX_THRESHOLD,
        text_threshold=TEXT_THRESHOLD,
        target_sizes=[(height, width)],
    )[0]
    torch.cuda.synchronize(device)
    detector_ms = (time.monotonic() - detector_started) * 1000

    raw_boxes = detections["boxes"].detach().float().cpu().tolist()
    raw_scores = detections["scores"].detach().float().cpu().tolist()
    raw_labels = detections.get("labels")
    labels = raw_labels.detach().cpu().tolist() if hasattr(raw_labels, "detach") else list(raw_labels or [])
    if len(raw_boxes) != len(raw_scores) or (labels and len(labels) != len(raw_boxes)):
        raise ProbeError("GroundingDINO returned inconsistent candidate arrays")
    all_detections = []
    for index, (box, score) in enumerate(zip(raw_boxes, raw_scores, strict=True)):
        all_detections.append(
            {
                "detector_index": index,
                "box_xyxy": validate_box(box, width, height),
                "score": float(score),
                "label": str(labels[index]) if labels else case["normalized_target"],
            }
        )

    bounded, truncated_count = bound_detections(all_detections)
    mask_records: list[dict[str, Any]] = []
    sam_ms = 0.0
    if bounded:
        prompt_boxes = [item["box_xyxy"] for item in bounded]
        sam_inputs = sam_processor(images=image, input_boxes=[prompt_boxes], return_tensors="pt").to(device)
        torch.cuda.synchronize(device)
        sam_started = time.monotonic()
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
            sam_outputs = sam_model(**sam_inputs, multimask_output=False)
        masks = sam_processor.post_process_masks(sam_outputs.pred_masks.cpu(), sam_inputs["original_sizes"])[0]
        torch.cuda.synchronize(device)
        sam_ms = (time.monotonic() - sam_started) * 1000
        if len(masks) != len(bounded):
            raise ProbeError("SAM2 mask count differs from bounded box count")

        case_mask_dir = output_dir / "masks" / case["caseId"]
        case_mask_dir.mkdir(parents=True, exist_ok=True)
        for index, (detection, mask_tensor) in enumerate(zip(bounded, masks, strict=True)):
            mask_array = mask_tensor.detach().float().cpu().numpy()
            mask_array = np.squeeze(mask_array)
            if mask_array.shape != (height, width):
                raise ProbeError("SAM2 mask was not mapped back to source-canvas dimensions")
            binary = mask_array > 0.0
            mask_path = case_mask_dir / f"C{index:02d}.png"
            Image.fromarray((binary.astype(np.uint8) * 255), mode="L").save(mask_path, format="PNG", optimize=False)
            mask_records.append(
                {
                    "id": f"C{index:02d}",
                    **detection,
                    "mask_path": str(mask_path.relative_to(output_dir)),
                    "mask_sha256": sha256_file(mask_path),
                    "mask_box_xyxy": mask_bbox(binary),
                    "sam2_mask_threshold": 0.0,
                }
            )

    torch.cuda.synchronize(device)
    row = {
        "case_id": case["caseId"],
        "stratum": case["caseId"].split("-")[2],
        "status": "complete",
        "manifest_file": case["manifest_file"],
        "image_path": case["image"]["path"],
        "source_sha256": case["image"]["sha256"],
        "source_dimensions": {"width": width, "height": height},
        "authored_target": case["locate"]["target"],
        "normalized_target": case["normalized_target"],
        "detector_prompt": detector_prompt,
        "model": {
            "grounding_repo": GROUNDING_REPO,
            "grounding_revision": GROUNDING_REVISION,
            "sam2_repo": SAM2_REPO,
            "sam2_revision": SAM2_REVISION,
            "transformers_version": TRANSFORMERS_VERSION,
            "dtype": "float16",
            "box_threshold": BOX_THRESHOLD,
            "text_threshold": TEXT_THRESHOLD,
        },
        "detector_candidate_count": len(all_detections),
        "candidate_cap": MAX_CANDIDATES,
        "truncated_detector_count": truncated_count,
        "detector_candidates": all_detections,
        "mask_candidates": mask_records,
        "timing_ms": {
            "detector_forward_and_postprocess": detector_ms,
            "sam2_forward_and_postprocess": sam_ms,
            "child_total_including_model_load": (time.monotonic() - started) * 1000,
        },
        "peak_vram_bytes": {
            "allocated": torch.cuda.max_memory_allocated(device),
            "reserved": torch.cuda.max_memory_reserved(device),
        },
    }
    source_bytes = b""
    image.close()
    del dino_model, dino_processor, sam_model, sam_processor
    torch.cuda.empty_cache()
    return row


def run_child(case_json: Path, image_root: Path, assets_dir: Path, output_dir: Path) -> int:
    case = json.loads(case_json.read_text(encoding="utf-8"))
    try:
        result = child_case(case, image_root, assets_dir, output_dir)
        write_json_atomic(output_dir / "cases" / f"{case['caseId']}.json", result)
        print(json.dumps({"case_id": case["caseId"], "status": "complete"}), flush=True)
        return 0
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            raise
        result = {
            "case_id": case.get("caseId", "unknown"),
            "status": "error",
            "error_type": type(error).__name__,
            "error": str(error)[:1000],
        }
        traceback.print_exc(file=sys.stderr)
        write_json_atomic(output_dir / "cases" / f"{case['caseId']}.json", result)
        print(json.dumps({"case_id": case["caseId"], "status": "error", "error_type": type(error).__name__, "error": result["error"]}), flush=True)
        return 1


def run_parent(args: argparse.Namespace) -> int:
    assets_dir = args.assets_dir.resolve(strict=True)
    asset_metadata = verify_assets(assets_dir)
    manifest_dir = args.manifest_dir.resolve(strict=True)
    image_root = args.image_root.resolve(strict=True)
    cases, manifest_hashes = load_fixed_cases(manifest_dir)
    for case in cases:
        validate_image_bytes(case, image_root)

    output_dir = args.output_dir.resolve()
    if output_dir.exists():
        raise ProbeError("Output directory already exists; use a new run directory")
    output_dir.mkdir(parents=True)
    (output_dir / "cases").mkdir()
    case_statuses = [
        {"case_id": case["caseId"], "status": "not_started"} for case in cases
    ]
    run_record: dict[str, Any] = {
        "schema": "v03-grounded-proposals-probe-v1",
        "status": "running",
        "cohort": "fixed-v03-dev-12-effc2e8",
        "case_ids": list(EXPECTED_CASE_IDS),
        "manifest_sha256": manifest_hashes,
        "image_root": str(image_root),
        "model_assets": asset_metadata,
        "source_freeze": {
            "producer_script_sha256": sha256_file(Path(__file__).resolve()),
            "environment_freeze_sha256": sha256_file(assets_dir / "python-freeze.txt"),
        },
        "cases": case_statuses,
        "candidate_semantics": "availability-only; candidate count on a negative is not a false positive",
        "deadline_seconds_per_case": CASE_DEADLINE_SECONDS,
    }
    run_path = output_dir / "run.json"
    write_json_atomic(run_path, run_record)

    for index, case in enumerate(cases):
        case_file = output_dir / "worker-input" / f"{case['caseId']}.json"
        write_json_atomic(case_file, case)
        log_path = output_dir / "worker-logs" / f"{case['caseId']}.stderr.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--worker-case",
            str(case_file),
            "--image-root",
            str(image_root),
            "--assets-dir",
            str(assets_dir),
            "--output-dir",
            str(output_dir),
        ]
        started = time.monotonic()
        status = "error"
        error_message = "worker exited without a result"
        with log_path.open("wb") as stderr_log:
            status, elapsed_ms, error_message, stdout = run_owned_child(
                command, stderr_log, CASE_DEADLINE_SECONDS
            )
        if stdout:
            try:
                message = json.loads(stdout.decode("utf-8").splitlines()[-1])
                status = message.get("status", status)
                if status != "complete":
                    error_message = message.get("error", message.get("error_type", error_message))
            except (ValueError, UnicodeDecodeError):
                error_message = "worker returned malformed status"

        if status != "complete":
            (output_dir / "masks" / case["caseId"]).exists() and shutil.rmtree(
                output_dir / "masks" / case["caseId"]
            )
            row = {
                "case_id": case["caseId"],
                "status": status,
                "error": error_message,
                "elapsed_ms": elapsed_ms,
            }
            write_json_atomic(output_dir / "cases" / f"{case['caseId']}.json", row)
        row_path = output_dir / "cases" / f"{case['caseId']}.json"
        case_statuses[index] = {
            "case_id": case["caseId"],
            "status": status,
            "elapsed_ms": elapsed_ms,
            "row_sha256": sha256_file(row_path),
        }
        write_json_atomic(run_path, run_record)
        case_file.unlink(missing_ok=True)
        if status != "complete":
            mark_remaining_not_run(output_dir, cases, case_statuses, index, case["caseId"])
            write_json_atomic(run_path, run_record)
            break

    run_record["status"] = "complete" if all(item["status"] == "complete" for item in case_statuses) else "incomplete"
    run_record["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json_atomic(run_path, run_record)
    print(json.dumps({"output_dir": str(output_dir), "status": run_record["status"], "cases": len(case_statuses)}))
    return 0 if run_record["status"] == "complete" else 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-assets", action="store_true", help="Download only the frozen public files.")
    parser.add_argument("--verify-assets", action="store_true", help="Verify all frozen local assets without network.")
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--manifest-dir", type=Path)
    parser.add_argument("--image-root", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--worker-case", type=Path, help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.fetch_assets:
            manifest = fetch_assets(args.assets_dir)
            print(json.dumps({"status": "assets-verified", "files": len(manifest["verified_files"])}))
            return 0
        if args.verify_assets:
            manifest = verify_assets(args.assets_dir.resolve(strict=True))
            print(json.dumps({"status": "assets-verified", "files": len(manifest["verified_files"])}))
            return 0
        if args.worker_case:
            if not args.image_root or not args.output_dir:
                raise ProbeError("Worker requires image root and output directory")
            return run_child(args.worker_case, args.image_root, args.assets_dir, args.output_dir)
        if not args.manifest_dir or not args.image_root or not args.output_dir:
            raise ProbeError("Probe requires manifest directory, image root and output directory")
        return run_parent(args)
    except (OSError, ValueError, ProbeError) as error:
        print(f"probe error: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
