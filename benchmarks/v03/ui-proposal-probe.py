#!/usr/bin/env python3
"""Offline, benchmark-only OmniParser v3 UI box proposal probe."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

MODEL_REVISION = "f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4"
MODEL_SHA256 = "11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c"
MODEL_BYTES = 281_182_680
LICENSE_SHA256 = "646f8936b8ddcd14e13e578ff6857e368780b0d1a4f6066bee89211923a373e2"
LICENSE_BYTES = 1_073
MANIFEST_SHA256 = "5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f"
IMAGE_SIZE = 1280
STRIDES = (8, 16, 32)
CONFIDENCE_THRESHOLD = 0.05
NMS_IOU_THRESHOLD = 0.45
MAX_CANDIDATES = 36
WALL_TIMEOUT_SECONDS = 240


class ProbeError(RuntimeError):
    """A fail-closed probe validation or inference failure."""


class ProbeTimeout(ProbeError):
    """The image deadline expired."""


@dataclass(frozen=True)
class LetterboxTransform:
    source_width: int
    source_height: int
    nominal_scale: float
    resized_width: int
    resized_height: int
    scale_x: float
    scale_y: float
    pad_left: int = 0
    pad_top: int = 0


def letterbox_transform(width: int, height: int, image_size: int = IMAGE_SIZE) -> LetterboxTransform:
    if width <= 0 or height <= 0 or image_size <= 0:
        raise ProbeError("image dimensions and model input size must be positive")
    scale = min(image_size / width, image_size / height)
    resized_width = round(width * scale)
    resized_height = round(height * scale)
    if not (0 < resized_width <= image_size and 0 < resized_height <= image_size):
        raise ProbeError("rounded letterbox dimensions are outside the fixed canvas")
    return LetterboxTransform(
        source_width=width,
        source_height=height,
        nominal_scale=scale,
        resized_width=resized_width,
        resized_height=resized_height,
        scale_x=resized_width / width,
        scale_y=resized_height / height,
    )


def source_box_from_canvas(
    box: tuple[float, float, float, float], transform: LetterboxTransform
) -> tuple[float, float, float, float] | None:
    if len(box) != 4 or not all(math.isfinite(value) for value in box):
        raise ProbeError("candidate box must contain four finite coordinates")
    left, top, right, bottom = box
    if right <= left or bottom <= top:
        raise ProbeError("candidate box must have positive area")
    mapped = (
        (left - transform.pad_left) / transform.scale_x,
        (top - transform.pad_top) / transform.scale_y,
        (right - transform.pad_left) / transform.scale_x,
        (bottom - transform.pad_top) / transform.scale_y,
    )
    clipped = (
        min(max(mapped[0], 0.0), float(transform.source_width)),
        min(max(mapped[1], 0.0), float(transform.source_height)),
        min(max(mapped[2], 0.0), float(transform.source_width)),
        min(max(mapped[3], 0.0), float(transform.source_height)),
    )
    if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
        return None
    return clipped


def select_candidates(
    candidates: list[dict[str, Any]], limit: int = MAX_CANDIDATES
) -> tuple[list[dict[str, Any]], int]:
    if limit < 0:
        raise ProbeError("candidate limit cannot be negative")
    for candidate in candidates:
        score = candidate.get("score")
        index = candidate.get("flat_index")
        box = candidate.get("box_xyxy")
        if not isinstance(score, (int, float)) or not math.isfinite(float(score)):
            raise ProbeError("candidate score must be finite")
        if not isinstance(index, int) or index < 0:
            raise ProbeError("candidate flattened head index must be a nonnegative integer")
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            raise ProbeError("candidate box must be xyxy")
    ordered = sorted(candidates, key=lambda item: (-float(item["score"]), int(item["flat_index"])))
    return ordered[:limit], max(0, len(ordered) - limit)


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def verify_file(path: Path, expected_sha256: str, expected_bytes: int | None = None) -> dict[str, Any]:
    if not path.is_file():
        raise ProbeError(f"required file does not exist: {path}")
    actual_sha256, actual_bytes = sha256_file(path)
    if actual_sha256 != expected_sha256:
        raise ProbeError(f"SHA-256 mismatch for {path}: {actual_sha256}")
    if expected_bytes is not None and actual_bytes != expected_bytes:
        raise ProbeError(f"byte-size mismatch for {path}: {actual_bytes}")
    return {"path": str(path.resolve()), "sha256": actual_sha256, "bytes": actual_bytes}


def load_manifest(manifest_path: Path, image_root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    receipt = verify_file(manifest_path, MANIFEST_SHA256)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProbeError(f"cannot parse UI manifest: {error}") from error
    if not isinstance(manifest, list) or len(manifest) != 4:
        raise ProbeError("frozen H4a input must contain exactly four UI query rows")
    unique_sources: dict[str, dict[str, Any]] = {}
    case_ids: set[str] = set()
    for item in manifest:
        if not isinstance(item, dict) or not isinstance(item.get("caseId"), str):
            raise ProbeError("invalid UI case manifest row")
        if item["caseId"] in case_ids:
            raise ProbeError("duplicate UI case ID")
        case_ids.add(item["caseId"])
        image = item.get("image")
        if not isinstance(image, dict):
            raise ProbeError("UI case missing source image metadata")
        relpath = image.get("path")
        expected_digest = image.get("sha256")
        width, height = image.get("width"), image.get("height")
        if not isinstance(relpath, str) or not isinstance(expected_digest, str):
            raise ProbeError("UI source path or digest is invalid")
        if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
            raise ProbeError("UI source dimensions are invalid")
        source = (image_root / relpath).resolve()
        try:
            source.relative_to(image_root.resolve())
        except ValueError as error:
            raise ProbeError("UI source path escapes the explicit image root") from error
        source_receipt = verify_file(source, expected_digest)
        key = expected_digest
        record = unique_sources.setdefault(
            key,
            {
                "source": source,
                "receipt": source_receipt,
                "width": width,
                "height": height,
                "case_ids": [],
            },
        )
        if (record["width"], record["height"], record["source"]) != (width, height, source):
            raise ProbeError("same source digest refers to inconsistent path or dimensions")
        record["case_ids"].append(item["caseId"])
    if len(unique_sources) != 1:
        raise ProbeError("this fixed H4a screen expects four queries over exactly one source image")
    return list(unique_sources.values()), receipt


def prepare_canvas(image: Any) -> tuple[Any, LetterboxTransform]:
    from PIL import Image

    rgb = image.convert("RGB")
    width, height = rgb.size
    transform = letterbox_transform(width, height)
    resized = rgb.resize((transform.resized_width, transform.resized_height), Image.Resampling.BILINEAR)
    canvas = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (114, 114, 114))
    canvas.paste(resized, (0, 0))
    return canvas, transform


def decode_heads(outputs: Any, torch: Any) -> tuple[Any, Any, Any]:
    if not isinstance(outputs, (tuple, list)) or len(outputs) != 6:
        raise ProbeError("expected six TorchScript output tensors (class, box) for three strides")
    all_boxes = []
    all_scores = []
    all_flat_indices = []
    offset = 0
    for stride_index, stride in enumerate(STRIDES):
        cls_tensor = outputs[2 * stride_index]
        ltrb_tensor = outputs[2 * stride_index + 1]
        if cls_tensor.ndim != 4 or cls_tensor.shape[:2] != (1, 1):
            raise ProbeError("class head must have shape [1,1,H,W]")
        if ltrb_tensor.ndim != 4 or ltrb_tensor.shape[:2] != (1, 4):
            raise ProbeError("box head must have shape [1,4,H,W]")
        height, width = int(cls_tensor.shape[-2]), int(cls_tensor.shape[-1])
        if (height, width) != (IMAGE_SIZE // stride, IMAGE_SIZE // stride):
            raise ProbeError("head geometry does not match the pinned 1280px input and stride")
        if tuple(ltrb_tensor.shape[-2:]) != (height, width) or height <= 0 or width <= 0:
            raise ProbeError("class and LTRB head geometry differs")
        cls = cls_tensor.sigmoid()[0, 0]
        ltrb = ltrb_tensor[0]
        gy, gx = torch.meshgrid(
            torch.arange(height, dtype=torch.float32, device=cls.device),
            torch.arange(width, dtype=torch.float32, device=cls.device),
            indexing="ij",
        )
        cx, cy = gx + 0.5, gy + 0.5
        left, top, right, bottom = ltrb
        boxes = torch.stack(
            [(cx - left) * stride, (cy - top) * stride, (cx + right) * stride, (cy + bottom) * stride],
            dim=-1,
        ).reshape(-1, 4)
        scores = cls.reshape(-1)
        indices = torch.arange(offset, offset + height * width, dtype=torch.int64, device=cls.device)
        all_boxes.append(boxes)
        all_scores.append(scores)
        all_flat_indices.append(indices)
        offset += height * width
    return torch.cat(all_boxes), torch.cat(all_scores), torch.cat(all_flat_indices)


def run_inference(source_record: dict[str, Any], model_path: Path, device: str) -> dict[str, Any]:
    import numpy as np
    import torch
    from PIL import Image
    from torchvision.ops import nms

    started = time.monotonic()
    source_path: Path = source_record["source"]
    with Image.open(source_path) as image:
        if image.size != (source_record["width"], source_record["height"]):
            raise ProbeError("decoded source geometry differs from the frozen manifest")
        canvas, transform = prepare_canvas(image)
    tensor = torch.from_numpy(np.asarray(canvas)).permute(2, 0, 1).float()[None].div_(255.0).to(device)
    model = torch.jit.load(str(model_path), map_location=device).eval()
    with torch.inference_mode():
        outputs = model(tensor)
        boxes, scores, indices = decode_heads(outputs, torch)
        for tensor_value in (*outputs, boxes, scores):
            if not bool(torch.isfinite(tensor_value).all().item()):
                raise ProbeError("TorchScript output contains nonfinite values")
        keep = scores > CONFIDENCE_THRESHOLD
        boxes, scores, indices = boxes[keep], scores[keep], indices[keep]
        nms_kept = nms(boxes, scores, NMS_IOU_THRESHOLD)
        boxes, scores, indices = boxes[nms_kept], scores[nms_kept], indices[nms_kept]
        raw_count = int(scores.numel())
        canvas_candidates: list[dict[str, Any]] = []
        padding_only_dropped = 0
        for row in range(raw_count):
            canvas_box = tuple(float(value) for value in boxes[row].detach().cpu().tolist())
            source_box = source_box_from_canvas(canvas_box, transform)
            if source_box is None:
                padding_only_dropped += 1
                continue
            canvas_candidates.append(
                {
                    "flat_index": int(indices[row].item()),
                    "score": float(scores[row].item()),
                    "box_canvas_xyxy": list(canvas_box),
                    "box_xyxy": list(source_box),
                }
            )
    candidates, truncated = select_candidates(canvas_candidates)
    return {
        "case_ids": source_record["case_ids"],
        "source": source_record["receipt"],
        "source_geometry": {"width": transform.source_width, "height": transform.source_height},
        "transform": asdict(transform),
        "device": device,
        "torch": torch.__version__,
        "torchvision": __import__("torchvision").__version__,
        "cuda": torch.version.cuda,
        "elapsed_seconds": time.monotonic() - started,
        "raw_after_confidence_and_nms": raw_count,
        "padding_only_dropped": padding_only_dropped,
        "visible_after_padding_drop": len(canvas_candidates),
        "retained": len(candidates),
        "truncated": truncated,
        "candidates": candidates,
    }


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def reserve_new_file(path: Path) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o644)
    os.close(descriptor)


def terminate_worker(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    try:
        # The leader may exit on SIGTERM while a native/runtime child remains in
        # the same group, so escalate against the whole group even after wait().
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def build_preflight(args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if args.timeout_seconds <= 0:
        raise ProbeError("timeout must be positive")
    manifest_rows, manifest_receipt = load_manifest(args.manifest, args.image_root)
    model_receipt = verify_file(args.model, MODEL_SHA256, MODEL_BYTES)
    license_receipt = verify_file(args.model_license, LICENSE_SHA256, LICENSE_BYTES)
    import torch
    import torchvision

    if args.device == "cuda" and not torch.cuda.is_available():
        raise ProbeError("CUDA was requested but is unavailable")
    runtime = {
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "torchvision": torchvision.__version__,
        "cuda": torch.version.cuda,
        "device": args.device,
    }
    if args.device == "cuda":
        runtime["device_name"] = torch.cuda.get_device_name()
    producer_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    freeze = {
        "state": "frozen-before-inference",
        "producer": verify_file(Path(__file__), producer_hash),
        "runtime": runtime,
        "manifest": manifest_receipt,
        "model": {**model_receipt, "repository": "microsoft/OmniParser-v2.0", "revision": MODEL_REVISION},
        "model_license": {**license_receipt, "license": "MIT"},
        "recipe": {
            "image_size": IMAGE_SIZE,
            "strides": list(STRIDES),
            "confidence_threshold": CONFIDENCE_THRESHOLD,
            "nms_iou_threshold": NMS_IOU_THRESHOLD,
            "max_candidates": MAX_CANDIDATES,
            "padding": "top-left; RGB(114,114,114)",
            "resize": "PIL bilinear with rounded dimensions",
            "timeout_seconds": args.timeout_seconds,
            "device": args.device,
        },
        "inputs": [
            {
                "case_ids": record["case_ids"],
                "source": record["receipt"],
                "width": record["width"],
                "height": record["height"],
            }
            for record in manifest_rows
        ],
    }
    return freeze, manifest_rows


def verify_after(
    args: argparse.Namespace,
    freeze: dict[str, Any],
    manifest_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    after: dict[str, Any] = {"producer": None, "manifest": None, "model": None, "model_license": None, "sources": []}
    expected_items = [
        ("producer", Path(__file__), freeze["producer"]),
        ("manifest", args.manifest, freeze["manifest"]),
        ("model", args.model, freeze["model"]),
        ("model_license", args.model_license, freeze["model_license"]),
    ]
    stable = True
    for name, path, expected in expected_items:
        try:
            digest, size = sha256_file(path)
            item = {"path": str(path.resolve()), "sha256": digest, "bytes": size}
            stable = stable and digest == expected["sha256"] and size == expected["bytes"]
        except OSError as error:
            item = {"path": str(path), "error": f"{type(error).__name__}: {error}"}
            stable = False
        after[name] = item
    for record in manifest_rows:
        try:
            digest, size = sha256_file(record["source"])
            item = {"path": str(record["source"].resolve()), "sha256": digest, "bytes": size}
            stable = stable and digest == record["receipt"]["sha256"] and size == record["receipt"]["bytes"]
        except OSError as error:
            item = {"path": str(record["source"]), "error": f"{type(error).__name__}: {error}"}
            stable = False
        after["sources"].append(item)
    after["unchanged"] = stable
    return after


def run_worker(args: argparse.Namespace) -> int:
    try:
        _freeze, manifest_rows = build_preflight(args)
        results = [run_inference(record, args.model, args.device) for record in manifest_rows]
        write_json(args.output, {"state": "complete", "results": results})
        return 0
    except Exception as error:
        write_json(args.output, {"state": "failed", "error": f"{type(error).__name__}: {error}"})
        return 1


def run_supervised(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    freeze, manifest_rows = build_preflight(args)
    output_path = args.output.resolve()
    freeze_path = output_path.with_suffix(".freeze.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    reserved: list[Path] = []
    try:
        reserve_new_file(output_path)
        reserved.append(output_path)
        reserve_new_file(freeze_path)
        reserved.append(freeze_path)
    except FileExistsError as error:
        for path in reserved:
            path.unlink(missing_ok=True)
        raise ProbeError(f"refusing to overwrite historical output path: {error.filename}") from error
    write_json(freeze_path, freeze)

    descriptor, worker_path_str = tempfile.mkstemp(prefix=".ui-probe-worker-", suffix=".json", dir=output_path.parent)
    os.close(descriptor)
    worker_path = Path(worker_path_str)
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--manifest", str(args.manifest.resolve()),
        "--image-root", str(args.image_root.resolve()),
        "--model", str(args.model.resolve()),
        "--model-license", str(args.model_license.resolve()),
        "--output", str(worker_path),
        "--device", args.device,
        "--timeout-seconds", str(args.timeout_seconds),
        "--internal-worker",
    ]
    started = time.monotonic()
    state = "failed"
    details: dict[str, Any]
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            process.wait(timeout=args.timeout_seconds)
        except subprocess.TimeoutExpired:
            terminate_worker(process)
            state = "timeout"
            details = {"error": f"worker exceeded {args.timeout_seconds}s; process group terminated and joined"}
        else:
            try:
                details = json.loads(worker_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                details = {"error": f"worker receipt unavailable: {error}; exit={process.returncode}"}
            state = "complete" if process.returncode == 0 and details.get("state") == "complete" else "failed"
    except Exception as error:
        details = {"error": f"{type(error).__name__}: {error}"}
    finally:
        worker_path.unlink(missing_ok=True)
    integrity_after = verify_after(args, freeze, manifest_rows)
    if not integrity_after["unchanged"]:
        state = "failed"
    output = {
        "state": state,
        "freeze_path": str(freeze_path),
        "elapsed_seconds": time.monotonic() - started,
        "integrity_after": integrity_after,
        **details,
    }
    write_json(output_path, output)
    return output, 0 if state == "complete" else (2 if state == "timeout" else 1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--image-root", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--model-license", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--timeout-seconds", type=int, default=WALL_TIMEOUT_SECONDS)
    parser.add_argument("--internal-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.internal_worker:
        return run_worker(args)
    try:
        _output, exit_code = run_supervised(args)
        return exit_code
    except Exception as error:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        try:
            reserve_new_file(args.output.resolve())
        except FileExistsError:
            return 1
        write_json(args.output.resolve(), {"state": "failed", "error": f"{type(error).__name__}: {error}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
