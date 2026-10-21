#!/usr/bin/env python3
"""Owned H10 CLIPSeg GPU worker (JSONL stdin/stdout, load once)."""

from __future__ import annotations


def _bootstrap_linux_parent_death_guard() -> None:
    import ctypes
    import os
    import signal
    import sys

    env_key = "H10_EXPECTED_LAUNCHER_PID"
    pr_set_pdeathsig = 1
    if sys.platform != "linux":
        raise RuntimeError("parent-death registration requires Linux")
    raw = os.environ.get(env_key)
    if raw is None or not str(raw).strip():
        raise RuntimeError(f"missing {env_key} for owned worker startup")
    try:
        expected_launcher_pid = int(str(raw).strip())
    except ValueError as error:
        raise RuntimeError(f"invalid {env_key}: {raw!r}") from error
    if expected_launcher_pid <= 0:
        raise RuntimeError(f"invalid {env_key}: must be a positive pid")
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.prctl(pr_set_pdeathsig, signal.SIGKILL) != 0:
        errno = ctypes.get_errno()
        raise RuntimeError(f"prctl(PR_SET_PDEATHSIG, SIGKILL) failed: errno {errno}")
    if os.getppid() != expected_launcher_pid:
        os.kill(os.getpid(), signal.SIGKILL)


_bootstrap_linux_parent_death_guard()

import importlib.util
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import torch

_COMMON_PATH = Path(__file__).with_name("h10-clipseg-common.py")
_spec = importlib.util.spec_from_file_location("h10_clipseg_common", _COMMON_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError("failed to load h10-clipseg-common.py")
h10 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = h10
_spec.loader.exec_module(h10)


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def load_stack(asset_dir: Path, device: str) -> tuple[Any, Any, Any, torch.device]:
    h10.verify_asset_directory(asset_dir)
    h10.verify_preprocessor_config_on_disk(asset_dir)
    h10.assert_forward_accepts_interpolate_pos_encoding()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    from transformers import CLIPSegForImageSegmentation

    torch_device = torch.device(device)
    processor = h10.load_clipseg_processor(asset_dir)
    model = CLIPSegForImageSegmentation.from_pretrained(
        str(asset_dir),
        local_files_only=True,
        trust_remote_code=False,
        torch_dtype=torch.float32,
    )
    model.to(torch_device)
    model.eval()
    h10.verify_effective_image_processor(processor.image_processor)
    return processor, model, processor.tokenizer, torch_device


def run_row(
    processor: Any,
    model: Any,
    tokenizer: Any,
    device: torch.device,
    row: dict[str, Any],
    masks_dir: Path,
) -> dict[str, Any]:
    wall_start = time.perf_counter()
    prep_ms = forward_ms = post_ms = 0.0
    row_index = row["row_index"]
    row_key = row["row_key"]
    authored_target = row["authored_target"]
    source_path = Path(row["source_path"])
    base = {
        "row_index": row_index,
        "row_key": row_key,
        "authored_target": authored_target,
        "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
    }
    oriented = None
    h10.reset_cuda_peak(device)
    try:
        prep_start = time.perf_counter()
        expected_hash = row.get("expected_source_sha256")
        oriented = h10.read_oriented_source(
            source_path,
            expected_raw_sha256=expected_hash if isinstance(expected_hash, str) else None,
        )
        text_inputs, model_max_length = h10.encode_target_or_reject(tokenizer, authored_target)
        image_inputs = processor.image_processor(images=[oriented.rgb], return_tensors="pt")
        prep_ms = (time.perf_counter() - prep_start) * 1000.0

        forward_start = time.perf_counter()
        pixel_values = image_inputs["pixel_values"].to(device=device, dtype=torch.float32)
        input_ids = text_inputs["input_ids"].to(device)
        attention_mask = text_inputs["attention_mask"].to(device)
        with torch.inference_mode():
            outputs = model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                pixel_values=pixel_values,
                interpolate_pos_encoding=h10.INTERPOLATE_POS_ENCODING,
                return_dict=True,
            )
            if device.type == "cuda":
                torch.cuda.synchronize(device)
        forward_ms = (time.perf_counter() - forward_start) * 1000.0

        post_start = time.perf_counter()
        logits = h10.select_logits_plane(outputs.logits.detach().cpu())
        mask_result = h10.logits_to_mask(logits, oriented.height, oriented.width)
        post_ms = (time.perf_counter() - post_start) * 1000.0

        peaks = h10.read_cuda_peak_bytes(device)
        if mask_result.foreground_bounds is None:
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            wall_ms = (time.perf_counter() - wall_start) * 1000.0
            return {
                **base,
                "type": "row",
                "outcome_kind": "unresolved_empty",
                "mask_path": None,
                "mask_sha256": None,
                "foreground_bounds": None,
                "source_width": oriented.width,
                "source_height": oriented.height,
                "source_sha256": oriented.raw_source_sha256,
                "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
                "encoded_bytes": oriented.encoded_bytes,
                "model_max_length": model_max_length,
                "prep_ms": prep_ms,
                "forward_ms": forward_ms,
                "post_ms": post_ms,
                "wall_ms": wall_ms,
                "peak_allocated_bytes": peaks["peak_allocated_bytes"],
                "peak_reserved_bytes": peaks["peak_reserved_bytes"],
            }
        mask_path = masks_dir / f"{row_key}.png"
        mask_sha256 = h10.write_mask_png(mask_path, mask_result.mask_u8)
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        wall_ms = (time.perf_counter() - wall_start) * 1000.0
        return {
            **base,
            "type": "row",
            "outcome_kind": "candidate",
            "mask_path": str(mask_path),
            "mask_sha256": mask_sha256,
            "foreground_bounds": mask_result.foreground_bounds,
            "source_width": oriented.width,
            "source_height": oriented.height,
            "source_sha256": oriented.raw_source_sha256,
            "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
            "encoded_bytes": oriented.encoded_bytes,
            "model_max_length": model_max_length,
            "prep_ms": prep_ms,
            "forward_ms": forward_ms,
            "post_ms": post_ms,
            "wall_ms": wall_ms,
            "peak_allocated_bytes": peaks["peak_allocated_bytes"],
            "peak_reserved_bytes": peaks["peak_reserved_bytes"],
        }
    except h10.H10Error as error:
        wall_ms = (time.perf_counter() - wall_start) * 1000.0
        return {
            **base,
            "type": "row",
            "outcome_kind": "technical_error",
            "error_code": "H10_ERROR",
            "error_message": str(error),
            "wall_ms": wall_ms,
        }
    except Exception as error:  # noqa: BLE001 — worker boundary
        wall_ms = (time.perf_counter() - wall_start) * 1000.0
        return {
            **base,
            "type": "row",
            "outcome_kind": "technical_error",
            "error_code": "WORKER_FAILURE",
            "error_message": str(error),
            "traceback": traceback.format_exc(limit=8),
            "wall_ms": wall_ms,
        }
    finally:
        if oriented is not None:
            oriented.rgb.close()


def main() -> int:
    try:
        init_line = sys.stdin.readline()
        if not init_line:
            emit({"type": "fatal", "message": "missing init line"})
            return 2
        init = json.loads(init_line)
        if init.get("command") != "init":
            emit({"type": "fatal", "message": "first message must be init"})
            return 2
        asset_dir = Path(init["asset_dir"]).resolve()
        device = str(init.get("device") or "cuda:0")
        masks_dir = Path(init["masks_dir"]).resolve()
        contract_path = Path(init["contract_path"]).resolve()
        h10.load_contract(contract_path)
        load_start = time.perf_counter()
        processor, model, tokenizer, torch_device = load_stack(asset_dir, device)
        load_ms = (time.perf_counter() - load_start) * 1000.0
        emit(
            {
                "type": "ready",
                "load_ms": load_ms,
                "device": str(torch_device),
                "model_max_length": int(tokenizer.model_max_length),
                "interpolate_pos_encoding": h10.INTERPOLATE_POS_ENCODING,
            }
        )
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            message = json.loads(line)
            command = message.get("command")
            if command == "close":
                emit({"type": "closed"})
                break
            if command != "row":
                emit({"type": "fatal", "message": f"unsupported command {command!r}"})
                return 2
            row_payload = message.get("row")
            if not isinstance(row_payload, dict):
                emit({"type": "fatal", "message": "row command requires row object"})
                return 2
            emit(run_row(processor, model, tokenizer, torch_device, row_payload, masks_dir))
        return 0
    except Exception as error:  # noqa: BLE001
        emit({"type": "fatal", "message": str(error), "traceback": traceback.format_exc(limit=8)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
