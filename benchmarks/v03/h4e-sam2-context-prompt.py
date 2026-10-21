#!/usr/bin/env python3
"""Bounded SAM2 context-expanded prompt probe for immutable H4a UI boxes; benchmark-only."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

SAM2_REPO = "facebook/sam2-hiera-tiny"
SAM2_REVISION = "7c218beaf0bb87874785f32b582f640134fc1c09"
SAM2_FILES = {
    "model.safetensors": (155_841_672, "1449035ba6ba2ed524c646da989e5cb3a9b93b97f1c1b2d474e598c3b748d99f"),
    "config.json": (5_697, "3239c7ecf212b1a9d9f98310c8993612335c5596a12c8cfba25e512e9dc5965b"),
    "preprocessor_config.json": (683, "6ebf229ee259368ce4a8d4f2fe893a72b053023710853e257253939e601f583d"),
    "processor_config.json": (95, "f8a68e865cfad115c1c2763f3d93eca7b1c622da06da2a9273eb437fb2389b6d"),
}
H4A_OUTPUT_SHA256 = "d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1"
H4A_FREEZE_SHA256 = "30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753"
SOURCE_SHA256 = "0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09"
TIMEOUT_SECONDS = 240


class ProbeError(RuntimeError):
    pass


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def verify_file(path: Path, expected_digest: str, expected_size: int | None = None) -> dict[str, Any]:
    if not path.is_file():
        raise ProbeError(f"required pinned file is missing: {path}")
    digest, size = sha256_file(path)
    if digest != expected_digest or (expected_size is not None and size != expected_size):
        raise ProbeError(f"pinned file integrity mismatch: {path}")
    return {"path": str(path.resolve()), "sha256": digest, "bytes": size}


def mask_bounds(mask: Any) -> list[int] | None:
    """Return source-coordinate xyxy with inclusive minima and exclusive maxima."""
    import numpy as np

    binary = np.asarray(mask, dtype=bool)
    if binary.ndim != 2:
        raise ProbeError("mask bounds require a two-dimensional binary source mask")
    ys, xs = np.nonzero(binary)
    if len(xs) == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def expand_prompt_box(box: list[float], width: int, height: int) -> list[float]:
    """Expand each source-coordinate side by 25% of original extent, then clip to source."""
    if len(box) != 4 or any(not math.isfinite(float(value)) for value in box):
        raise ProbeError("prompt box must contain four finite coordinates")
    x0, y0, x1, y1 = [float(value) for value in box]
    box_width, box_height = x1 - x0, y1 - y0
    if box_width <= 0 or box_height <= 0:
        raise ProbeError("prompt box must have positive width and height")
    expanded = [
        max(0.0, x0 - 0.25 * box_width),
        max(0.0, y0 - 0.25 * box_height),
        min(float(width), x1 + 0.25 * box_width),
        min(float(height), y1 + 0.25 * box_height),
    ]
    if expanded[2] <= expanded[0] or expanded[3] <= expanded[1]:
        raise ProbeError("expanded prompt box is degenerate after source clipping")
    return expanded


def candidate_rows(h4a_path: Path, h4a_freeze_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    verify_file(h4a_path, H4A_OUTPUT_SHA256)
    verify_file(h4a_freeze_path, H4A_FREEZE_SHA256)
    try:
        payload = json.loads(h4a_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProbeError("cannot parse frozen H4a proposals") from error
    if payload.get("state") != "complete" or len(payload.get("results", [])) != 1:
        raise ProbeError("expected one completed H4a source result")
    result = payload["results"][0]
    source = result.get("source")
    geometry = result.get("source_geometry")
    proposals = result.get("candidates")
    if not isinstance(source, dict) or not isinstance(geometry, dict) or not isinstance(proposals, list):
        raise ProbeError("H4a source or proposal fields are malformed")
    if source.get("sha256") != SOURCE_SHA256 or geometry != {"height": 800, "width": 1280}:
        raise ProbeError("H4a source digest or geometry differs from the frozen UI input")
    if len(proposals) != 36 or result.get("retained") != 36:
        raise ProbeError("H4a retained proposal count differs from the frozen 36-row recipe")
    rows: list[dict[str, Any]] = []
    for ordinal, proposal in enumerate(proposals):
        box = proposal.get("box_xyxy")
        score = proposal.get("score")
        flat_index = proposal.get("flat_index")
        if (
            not isinstance(box, list)
            or len(box) != 4
            or any(not isinstance(value, (int, float)) or not math.isfinite(float(value)) for value in box)
            or box[2] <= box[0]
            or box[3] <= box[1]
            or not isinstance(score, (int, float))
            or not math.isfinite(float(score))
            or not isinstance(flat_index, int)
        ):
            raise ProbeError(f"invalid frozen H4a candidate at ordinal {ordinal}")
        original_box = [float(v) for v in box]
        rows.append({"proposal_ordinal": ordinal, "flat_index": flat_index, "score": float(score), "box_xyxy": original_box, "expanded_prompt_xyxy": expand_prompt_box(original_box, 1280, 800)})
    return result, rows


def asset_receipts(model_dir: Path) -> list[dict[str, Any]]:
    records = []
    for filename, (expected_size, expected_digest) in SAM2_FILES.items():
        records.append({"name": filename, **verify_file(model_dir / filename, expected_digest, expected_size)})
    return records


def worker(args: argparse.Namespace) -> int:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    import numpy as np
    import torch
    from PIL import Image
    from transformers import Sam2Model, Sam2Processor

    if not torch.cuda.is_available():
        raise ProbeError("pinned GPU runtime is unavailable")
    h4a_path = Path(args.h4a).resolve()
    h4a_freeze_path = Path(args.h4a_freeze).resolve()
    source_path = Path(args.source).resolve()
    model_dir = Path(args.model_dir).resolve()
    out_dir = Path(args.output).resolve()
    h4a_result, proposals = candidate_rows(h4a_path, h4a_freeze_path)
    source_receipt = verify_file(source_path, SOURCE_SHA256, 39_902)
    receipts = asset_receipts(model_dir)
    image = Image.open(source_path).convert("RGB")
    width, height = image.size
    if (width, height) != (1280, 800):
        raise ProbeError("source image dimensions differ from frozen H4a geometry")

    started = time.monotonic()
    processor = Sam2Processor.from_pretrained(model_dir, local_files_only=True)
    model = Sam2Model.from_pretrained(
        model_dir,
        local_files_only=True,
        use_safetensors=True,
        torch_dtype=torch.float16,
    ).to("cuda:0").eval()
    # The image is encoded once; all frozen boxes are passed together in original order.
    model_inputs = processor(images=image, input_boxes=[[row["expanded_prompt_xyxy"] for row in proposals]], return_tensors="pt").to("cuda:0")
    torch.cuda.synchronize()
    infer_started = time.monotonic()
    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
        outputs = model(**model_inputs, multimask_output=False)
    masks = processor.post_process_masks(outputs.pred_masks.cpu(), model_inputs["original_sizes"])[0]
    torch.cuda.synchronize()
    inference_ms = (time.monotonic() - infer_started) * 1000
    if len(masks) != len(proposals):
        raise ProbeError(f"SAM2 returned {len(masks)} masks for {len(proposals)} prompts")

    masks_dir = out_dir / "masks"
    masks_dir.mkdir(exist_ok=False)
    records = []
    for ordinal, (proposal, tensor) in enumerate(zip(proposals, masks, strict=True)):
        array = np.squeeze(tensor.detach().float().cpu().numpy())
        if array.shape != (height, width):
            raise ProbeError(f"SAM2 mask {ordinal} was not restored to original source dimensions")
        binary = array > 0.0
        mask_path = masks_dir / f"candidate-{ordinal:03d}-mask.png"
        Image.fromarray(binary.astype(np.uint8) * 255, mode="L").save(mask_path, format="PNG", optimize=False)
        mask_digest, mask_bytes = sha256_file(mask_path)
        area = int(np.count_nonzero(binary))
        records.append({
            **proposal,
            "mask_path": str(mask_path.relative_to(out_dir)),
            "mask_sha256": mask_digest,
            "mask_bytes": mask_bytes,
            "source_width": width,
            "source_height": height,
            "mask_pixel_area": area,
            "empty": area == 0,
            "mask_box_xyxy": mask_bounds(binary),
            "sam2_quality_diagnostic": float(outputs.iou_scores.reshape(-1)[ordinal].detach().float().cpu().item()),
            "expanded_prompt_xyxy": proposal["expanded_prompt_xyxy"],
            "sam2_mask_threshold": 0.0,
        })
    torch.cuda.synchronize()
    run = {
        "state": "complete",
        "hypothesis": "H4e-sam2-context-prompt",
        "source": source_receipt,
        "h4a_output": {"path": str(h4a_path), "sha256": H4A_OUTPUT_SHA256},
        "h4a_freeze": {"path": str(h4a_freeze_path), "sha256": H4A_FREEZE_SHA256},
        "model": {"repo": SAM2_REPO, "revision": SAM2_REVISION, "license": "Apache-2.0", "assets": receipts,
                  "transformers": __import__("transformers").__version__, "torch": torch.__version__, "torchvision": __import__("torchvision").__version__,
                  "cuda": torch.version.cuda, "device": torch.cuda.get_device_name(0), "dtype": "float16"},
        "protocol": {"image_encoding_calls": 1, "prompt_count": len(proposals), "order": "frozen H4a candidate order", "prompt": "box XYXY expanded 25% per original side and clipped to source", "multimask_output": False,
                     "mask_frame": "full original source", "mask_threshold": 0.0, "clip_to_box": False},
        "candidate_count": len(records),
        "results": records,
        "timing_ms": {"sam2_forward_and_postprocess": inference_ms, "worker_total": (time.monotonic() - started) * 1000},
        "peak_vram_bytes": {"allocated": torch.cuda.max_memory_allocated(0), "reserved": torch.cuda.max_memory_reserved(0)},
    }
    print(json.dumps(run, ensure_ascii=False, separators=(",", ":")))
    image.close()
    del model, processor
    torch.cuda.empty_cache()
    return 0


def kill_owned_group(process: subprocess.Popen[bytes]) -> None:
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


def write_exclusive_json(path: Path, value: dict[str, Any]) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def parent(args: argparse.Namespace) -> int:
    h4a_path, freeze_path, source_path, model_dir = map(Path, (args.h4a, args.h4a_freeze, args.source, args.model_dir))
    h4a_path, freeze_path, source_path, model_dir = [p.resolve() for p in (h4a_path, freeze_path, source_path, model_dir)]
    h4a_result, proposals = candidate_rows(h4a_path, freeze_path)
    source_record = verify_file(source_path, SOURCE_SHA256, 39_902)
    model_records = asset_receipts(model_dir)
    script = Path(__file__).resolve()
    script_hash, script_bytes = sha256_file(script)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    freeze = {
        "state": "frozen-before-inference",
        "hypothesis": "H4e-sam2-context-prompt",
        "source": source_record,
        "h4a_output": {"path": str(h4a_path), "sha256": H4A_OUTPUT_SHA256, "bytes": h4a_path.stat().st_size},
        "h4a_freeze": {"path": str(freeze_path), "sha256": H4A_FREEZE_SHA256, "bytes": freeze_path.stat().st_size},
        "proposals": [{"proposal_ordinal": row["proposal_ordinal"], "flat_index": row["flat_index"], "score": row["score"], "box_xyxy": row["box_xyxy"], "expanded_prompt_xyxy": row["expanded_prompt_xyxy"]} for row in proposals],
        "model": {"repo": SAM2_REPO, "revision": SAM2_REVISION, "license": "Apache-2.0", "assets": model_records},
        "producer": {"path": str(script), "sha256": script_hash, "bytes": script_bytes},
        "recipe": {"device": "cuda:0", "dtype": "float16", "image_encoding_calls": 1, "ordered_box_prompts": 36, "multimask_output": False,
                   "prompt_expansion": {"fraction_per_original_side": 0.25, "clipped_to_source": True},
                   "mask_frame": "full original source", "clip_to_box": False, "mask_threshold": 0.0, "timeout_seconds": TIMEOUT_SECONDS},
    }
    freeze_path_out = output / "freeze.json"
    write_exclusive_json(freeze_path_out, freeze)
    child_args = [sys.executable, str(script), "--worker", "--h4a", str(h4a_path), "--h4a-freeze", str(freeze_path), "--source", str(source_path), "--model-dir", str(model_dir), "--output", str(output)]
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"}
    started = time.monotonic()
    with (output / "worker.stderr.log").open("x", encoding="utf-8") as stderr:
        process = subprocess.Popen(child_args, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True, env=env)
        try:
            stdout, _ = process.communicate(timeout=TIMEOUT_SECONDS)
            status = "complete" if process.returncode == 0 else "error"
            error = None if status == "complete" else f"worker exited with status {process.returncode}"
        except subprocess.TimeoutExpired:
            kill_owned_group(process)
            stdout = b""
            status, error = "timeout", f"worker exceeded {TIMEOUT_SECONDS}-second deadline"
    integrity = {
        "h4a_output": verify_file(h4a_path, H4A_OUTPUT_SHA256),
        "h4a_freeze": verify_file(freeze_path, H4A_FREEZE_SHA256),
        "source": verify_file(source_path, SOURCE_SHA256, 39_902),
        "model_assets": asset_receipts(model_dir),
        "producer": {"path": str(script), "sha256": sha256_file(script)[0], "bytes": sha256_file(script)[1]},
    }
    integrity["unchanged"] = (
        integrity["h4a_output"]["sha256"] == freeze["h4a_output"]["sha256"]
        and integrity["h4a_freeze"]["sha256"] == freeze["h4a_freeze"]["sha256"]
        and integrity["source"]["sha256"] == freeze["source"]["sha256"]
        and integrity["model_assets"] == freeze["model"]["assets"]
        and integrity["producer"]["sha256"] == script_hash
    )
    if not integrity["unchanged"]:
        status, error = "integrity_error", "one or more frozen inputs changed during inference"
    run: dict[str, Any] = {"state": status, "hypothesis": "H4e-sam2-context-prompt", "elapsed_seconds": time.monotonic() - started,
                           "freeze_path": str(freeze_path_out), "integrity_after": integrity}
    if status == "complete":
        try:
            worker_run = json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as parse_error:
            status, error = "error", f"worker returned invalid JSON: {parse_error}"
            run["state"] = status
        else:
            run.update(worker_run)
            run["integrity_after"] = integrity
            if len(run.get("results", [])) != 36:
                run["state"], status, error = "error", "error", "worker omitted mask rows"
    if error:
        run["error"] = error
    write_exclusive_json(output / "run.json", run)
    print(json.dumps({"state": run["state"], "output": str(output), "run_json": str(output / "run.json"), "integrity_unchanged": integrity["unchanged"], "error": error}))
    return 0 if run["state"] == "complete" else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--h4a", default=".run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.json")
    parser.add_argument("--h4a-freeze", default=".run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.freeze.json")
    parser.add_argument("--source", default="/root/work/zorya-classifier-worktrees/v02/corpus/benchmarks/cache/v02/corpus/independent-ui/geany-dev-oracle-20261020-run02.png")
    parser.add_argument("--model-dir", default="/root/work/zorya-classifier-models/v03/sam2-hiera-tiny")
    parser.add_argument("--output", default=".run/v03/h4e-sam2-context-prompt-v1")
    parser.add_argument("--worker", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    parsed = parse_args()
    try:
        exit_code = worker(parsed) if parsed.worker else parent(parsed)
    except Exception as error:  # benchmark CLI converts failures to an explicit failed command
        print(json.dumps({"state": "error", "error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        exit_code = 1
    raise SystemExit(exit_code)
