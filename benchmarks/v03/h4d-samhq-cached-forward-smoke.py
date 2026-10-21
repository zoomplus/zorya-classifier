#!/usr/bin/env python3
"""Bounded, one-prompt comparison of direct and cached SAM-HQ forwards."""

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

MODEL_REPO = "syscv-community/sam-hq-vit-base"
MODEL_REVISION = "f906a2e3f60fda2f12eb717cef18614f66c43124"
UPSTREAM_REVISION = "e696978d60352dc9a26b12631cd91781502c6546"
ASSETS = {
    "model.safetensors": (379_266_384, "b3a4c62fa9ebff888b3a891010392b32233ec3dce12d2ece8e19c746ca71cb64"),
    "config.json": (1_400, "3cbf6aa7445e19224e9f3d47faefcdb8c0efa015107de9527eef85be87879939"),
    "preprocessor_config.json": (576, "4d68d8d8ff5a3d813f02a1baef859d9ee82217998acd225b793fb6e9bd867bbc"),
    "LICENSE": (11_357, "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"),
}
H4A_OUTPUT_SHA256 = "d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1"
H4A_FREEZE_SHA256 = "30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753"
SOURCE_SHA256 = "0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09"
TIMEOUT_SECONDS = 240


class SmokeError(RuntimeError):
    pass


def hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def receipt(path: Path, digest: str, size: int | None = None) -> dict[str, Any]:
    actual, actual_size = hash_file(path)
    if actual != digest or (size is not None and actual_size != size):
        raise SmokeError(f"pinned input integrity mismatch: {path}")
    return {"path": str(path.resolve()), "sha256": actual, "bytes": actual_size}


def inputs(args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    h4a_path, freeze_path, source_path, model_dir = [Path(v).resolve() for v in (args.h4a, args.h4a_freeze, args.source, args.model_dir)]
    h4a_receipt = receipt(h4a_path, H4A_OUTPUT_SHA256)
    freeze_receipt = receipt(freeze_path, H4A_FREEZE_SHA256)
    source_receipt = receipt(source_path, SOURCE_SHA256, 39_902)
    with h4a_path.open("r", encoding="utf-8") as stream:
        payload = json.load(stream)
    proposals = payload.get("results", [{}])[0].get("candidates")
    if not isinstance(proposals, list) or not proposals:
        raise SmokeError("frozen H4a proposal ordinal 0 is missing")
    proposal = proposals[0]
    box = proposal.get("box_xyxy")
    if (proposal.get("flat_index") != 2052 or not isinstance(box, list) or len(box) != 4
            or any(not isinstance(v, (int, float)) or not math.isfinite(float(v)) for v in box)):
        raise SmokeError("frozen H4a ordinal 0 differs from its pinned proposal identity")
    asset_receipts = []
    for name, (size, digest) in ASSETS.items():
        asset_receipts.append({"name": name, **receipt(model_dir / name, digest, size)})
    identity = {
        "source": source_receipt,
        "h4a_output": h4a_receipt,
        "h4a_freeze": freeze_receipt,
        "proposal": {"proposal_ordinal": 0, "flat_index": 2052, "box_xyxy": [float(v) for v in box]},
        "model": {"repo": MODEL_REPO, "revision": MODEL_REVISION, "upstream_repo_revision": UPSTREAM_REVISION, "license": "Apache-2.0", "assets": asset_receipts},
    }
    return identity, asset_receipts, {"h4a": h4a_path, "h4a_freeze": freeze_path, "source": source_path, "model_dir": model_dir}


def tensor_summary(value: Any) -> dict[str, Any]:
    import torch

    return {"shape": list(value.shape), "dtype": str(value.dtype), "device": str(value.device), "finite": bool(torch.isfinite(value).all().item())}


def logits_summary(logits: Any) -> dict[str, Any]:
    import numpy as np
    import torch

    cpu = logits.detach().to(device="cpu", dtype=torch.float32).contiguous()
    raw = cpu.numpy()
    return {
        **tensor_summary(logits),
        "sha256_float32_contiguous": hashlib.sha256(raw.tobytes(order="C")).hexdigest(),
        "min": float(np.min(raw)),
        "max": float(np.max(raw)),
    }


def mask_summary(mask: Any) -> dict[str, Any]:
    import numpy as np

    array = np.squeeze(mask.detach().to(device="cpu", dtype=__import__("torch").float32).numpy())
    if array.ndim != 2:
        raise SmokeError(f"postprocessed mask must be 2-D, got {array.shape}")
    binary = array > 0.0
    ys, xs = np.nonzero(binary)
    return {
        "shape": list(array.shape),
        "threshold": 0.0,
        "pixel_area": int(binary.sum()),
        "bounds_xyxy_exclusive_max": None if len(xs) == 0 else [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
        "binary_sha256": hashlib.sha256(binary.astype("uint8").tobytes(order="C")).hexdigest(),
    }


def worker(paths: dict[str, Path], proposal: dict[str, Any]) -> dict[str, Any]:
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"})
    import resource
    import numpy as np
    import torch
    import transformers
    import torchvision
    from PIL import Image
    from transformers import SamHQModel, SamHQProcessor

    if not torch.cuda.is_available():
        raise SmokeError("pinned CUDA runtime unavailable")
    image = Image.open(paths["source"]).convert("RGB")
    width, height = image.size
    if (width, height) != (1280, 800):
        raise SmokeError(f"pinned source dimensions changed: {width}x{height}")
    processor = SamHQProcessor.from_pretrained(paths["model_dir"], local_files_only=True)
    model = SamHQModel.from_pretrained(paths["model_dir"], local_files_only=True, use_safetensors=True, torch_dtype=torch.float16).to("cuda:0").eval()
    model_inputs = processor(images=image, input_boxes=[[proposal["box_xyxy"]]], return_tensors="pt").to("cuda:0")
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats(0)
    call_counts = {"direct_forward": 0, "get_image_embeddings": 0, "cached_forward": 0}

    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
        direct = model(pixel_values=model_inputs["pixel_values"], input_boxes=model_inputs["input_boxes"], multimask_output=False, hq_token_only=True)
        call_counts["direct_forward"] += 1
        torch.cuda.synchronize()
        embeddings = model.get_image_embeddings(model_inputs["pixel_values"])
        call_counts["get_image_embeddings"] += 1
        cached = model(image_embeddings=embeddings[0], intermediate_embeddings=embeddings[1], input_boxes=model_inputs["input_boxes"], multimask_output=False, hq_token_only=True)
        call_counts["cached_forward"] += 1
        torch.cuda.synchronize()

    direct_logits = direct.pred_masks
    cached_logits = cached.pred_masks
    direct_iou, cached_iou = direct.iou_scores, cached.iou_scores
    direct_post = processor.post_process_masks(direct_logits.float().cpu(), model_inputs["original_sizes"].cpu(), model_inputs["reshaped_input_sizes"].cpu())[0]
    cached_post = processor.post_process_masks(cached_logits.float().cpu(), model_inputs["original_sizes"].cpu(), model_inputs["reshaped_input_sizes"].cpu())[0]
    direct_binary = np.squeeze(direct_post[0].numpy()) > 0.0
    cached_binary = np.squeeze(cached_post[0].numpy()) > 0.0
    if direct_logits.shape == cached_logits.shape and bool(torch.isfinite(direct_logits).all()) and bool(torch.isfinite(cached_logits).all()):
        difference = (direct_logits.float() - cached_logits.float()).abs()
        exact_fraction = float((direct_logits == cached_logits).float().mean().item())
        max_abs_difference = float(difference.max().item())
        mean_abs_difference = float(difference.mean().item())
    else:
        exact_fraction = max_abs_difference = mean_abs_difference = None
    union = int(np.logical_or(direct_binary, cached_binary).sum())
    intersection = int(np.logical_and(direct_binary, cached_binary).sum())
    return {
        "state": "complete",
        "runtime": {"python": sys.version.split()[0], "transformers": transformers.__version__, "torch": torch.__version__, "torchvision": torchvision.__version__, "cuda": torch.version.cuda, "device": torch.cuda.get_device_name(0), "model_dtype": "float16", "autocast_dtype": "float16"},
        "processor_inputs": {"pixel_values": tensor_summary(model_inputs["pixel_values"]), "input_boxes": tensor_summary(model_inputs["input_boxes"]), "input_boxes_values": model_inputs["input_boxes"].float().cpu().tolist(), "original_sizes": model_inputs["original_sizes"].cpu().tolist(), "reshaped_input_sizes": model_inputs["reshaped_input_sizes"].cpu().tolist()},
        "embeddings": {"image_embeddings": tensor_summary(embeddings[0]), "intermediate_embeddings": [tensor_summary(item) for item in embeddings[1]]},
        "calls": call_counts,
        "direct": {"pred_masks": logits_summary(direct_logits), "iou_scores": tensor_summary(direct_iou), "iou_scores_values": direct_iou.float().cpu().tolist(), "mask": mask_summary(direct_post[0])},
        "cached": {"pred_masks": logits_summary(cached_logits), "iou_scores": tensor_summary(cached_iou), "iou_scores_values": cached_iou.float().cpu().tolist(), "mask": mask_summary(cached_post[0])},
        "comparison": {"shape_equal": list(direct_logits.shape) == list(cached_logits.shape), "max_abs_logit_difference": max_abs_difference, "mean_abs_logit_difference": mean_abs_difference, "exact_logit_fraction": exact_fraction, "binary_mask_iou": None if union == 0 else intersection / union, "binary_masks_equal": bool(np.array_equal(direct_binary, cached_binary))},
        "peak_vram_bytes": {"allocated": torch.cuda.max_memory_allocated(0), "reserved": torch.cuda.max_memory_reserved(0)},
        "peak_rss_bytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024,
    }


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--h4a", default=".run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.json")
    parser.add_argument("--h4a-freeze", default=".run/v03/ui-proposal-probe-v1/omniparser-ui-boxes-corrected-image-root.freeze.json")
    parser.add_argument("--source", default="/root/work/zorya-classifier-worktrees/v02/corpus/benchmarks/cache/v02/corpus/independent-ui/geany-dev-oracle-20261020-run02.png")
    parser.add_argument("--model-dir", default="/root/work/zorya-classifier-models/v03/sam-hq-vit-base")
    parser.add_argument("--output", default=".run/v03/h4d-samhq-cached-forward-smoke-v1")
    args = parser.parse_args()
    identity, assets, paths = inputs(args)
    script = Path(__file__).resolve()
    script_hash, script_bytes = hash_file(script)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    freeze = {"state": "frozen-before-inference", "hypothesis": "H4d-samhq-cached-forward-smoke-v1", **identity, "producer": {"path": str(script), "sha256": script_hash, "bytes": script_bytes}, "recipe": {"proposal_ordinal": 0, "direct_forward_calls": 1, "cached_image_encode_calls": 1, "cached_forward_calls": 1, "order": "direct then cached", "multimask_output": False, "hq_token_only": True, "dtype": "fp16 model plus fp16 autocast", "threshold": 0.0, "device": "cuda:0", "timeout_seconds": TIMEOUT_SECONDS}}
    with (output / "freeze.json").open("x", encoding="utf-8") as stream:
        json.dump(freeze, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
    # Run this exact script in worker mode to keep the worker process isolated.
    command = [sys.executable, str(script), "--worker", "--source", str(paths["source"]), "--model-dir", str(paths["model_dir"]), "--proposal", json.dumps(identity["proposal"], separators=(",", ":"))]
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"}
    started = time.monotonic()
    with (output / "worker.stderr.log").open("x", encoding="utf-8") as stderr:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True, env=env)
        try:
            stdout, _ = process.communicate(timeout=TIMEOUT_SECONDS)
            status, error = ("complete", None) if process.returncode == 0 else ("error", f"worker exited with status {process.returncode}")
        except subprocess.TimeoutExpired:
            kill_owned_group(process)
            stdout, status, error = b"", "timeout", f"worker exceeded {TIMEOUT_SECONDS}-second deadline"
    identity_after, _, _ = inputs(args)
    script_after, script_size_after = hash_file(script)
    unchanged = identity_after == identity and script_after == script_hash and script_size_after == script_bytes
    if not unchanged:
        status, error = "integrity_error", "a frozen input or producer changed during inference"
    run: dict[str, Any] = {"state": status, "hypothesis": "H4d-samhq-cached-forward-smoke-v1", "freeze_path": str(output / "freeze.json"), "elapsed_seconds": time.monotonic() - started, "integrity_after": {"unchanged": unchanged, "producer": {"path": str(script), "sha256": script_after, "bytes": script_size_after}, **identity_after}}
    if status == "complete":
        try:
            run.update(json.loads(stdout.decode("utf-8")))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            run["state"], error = "error", f"worker returned invalid JSON: {exc}"
    if error:
        run["error"] = error
    with (output / "run.json").open("x", encoding="utf-8") as stream:
        json.dump(run, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
    print(json.dumps({"state": run["state"], "output": str(output), "run_json": str(output / "run.json"), "integrity_unchanged": unchanged, "error": error}))
    return 0 if run["state"] == "complete" else 1


def worker_main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--source", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--proposal", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(worker({"source": Path(args.source), "model_dir": Path(args.model_dir)}, json.loads(args.proposal)), separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"state": "error", "error": f"{type(exc).__name__}: {exc}"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    if "--worker" in sys.argv:
        raise SystemExit(worker_main())
    raise SystemExit(main())
