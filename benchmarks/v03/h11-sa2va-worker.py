#!/usr/bin/env python3
"""Owned H11 Sa2VA GPU worker (JSONL stdin/stdout, load once)."""

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

_COMMON_PATH = Path(__file__).with_name("h11-sa2va-common.py")
_spec = importlib.util.spec_from_file_location("h11_sa2va_common_worker", _COMMON_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError("failed to load h11-sa2va-common.py")
h11 = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = h11
_spec.loader.exec_module(h11)


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _configure_hf_cache(output_root: Path) -> None:
    cache_root = output_root / ".hf_modules_cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(cache_root)
    os.environ["HF_MODULES_CACHE"] = str(cache_root / "modules")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")


def load_stack(asset_dir: Path, device: str, contract: dict[str, Any]) -> tuple[Any, Any, torch.device]:
    h11.verify_asset_directory(asset_dir, contract)
    if device != "cuda:0":
        raise h11.H11Error(f"requested device must be cuda:0, got {device}")
    if not torch.cuda.is_available():
        raise h11.H11Error("CUDA is unavailable")
    torch_device = torch.device(device)
    if torch_device.index not in (None, 0):
        raise h11.H11Error("only cuda:0 is authorized")

    from transformers import AutoModel, AutoProcessor

    processor = AutoProcessor.from_pretrained(
        str(asset_dir),
        trust_remote_code=True,
        local_files_only=True,
        use_fast=h11.PROCESSOR_USE_FAST,
        revision=h11.MODEL_REVISION,
    )
    h11.verify_live_processor(processor)

    model = AutoModel.from_pretrained(
        str(asset_dir),
        trust_remote_code=True,
        local_files_only=True,
        revision=h11.MODEL_REVISION,
        low_cpu_mem_usage=True,
        torch_dtype=torch.bfloat16,
        attn_implementation="eager",
        use_flash_attn=False,
    )
    model_type = type(model)
    if model_type.__name__ != "Sa2VAChatModelQwen":
        raise h11.H11Error(f"unexpected model class: {model_type.__name__}")
    if getattr(model, "config", None) is not None:
        config_type = type(model.config)
        if config_type.__name__ != "Sa2VAChatConfigQwen":
            raise h11.H11Error(f"unexpected config class: {config_type.__name__}")

    model.to(torch_device)
    model.eval()
    h11.verify_attention_runtime(model)
    h11.verify_sam2_runtime(model, asset_dir=asset_dir, contract=contract)
    return processor, model, torch_device


def _row_diagnostics(device: torch.device, wall_start: float) -> dict[str, Any]:
    if device.type == "cuda" and torch.cuda.is_available():
        torch.cuda.synchronize(device)
    wall_ms = (time.perf_counter() - wall_start) * 1000.0
    peaks = h11.read_cuda_row_peak_bytes(device)
    return {"wall_ms": wall_ms, **peaks}


def run_row(
    processor: Any,
    model: Any,
    device: torch.device,
    row: dict[str, Any],
    masks_dir: Path,
) -> dict[str, Any]:
    row_index = row["row_index"]
    row_key = row["row_key"]
    authored_target = row["authored_target"]
    source_path = Path(row["source_path"])
    if device.type == "cuda" and torch.cuda.is_available():
        torch.cuda.synchronize(device)
        torch.cuda.reset_peak_memory_stats(device)
    wall_start = time.perf_counter()
    base = {
        "type": "row",
        "row_index": row_index,
        "row_key": row_key,
        "authored_target": authored_target,
    }
    oriented = None
    try:
        expected_hash = row.get("expected_source_sha256")
        oriented = h11.read_oriented_source(
            source_path,
            expected_raw_sha256=expected_hash if isinstance(expected_hash, str) else None,
        )
        composed = h11.compose_prompt(authored_target)
        prompt_sha = h11.composed_prompt_sha256(authored_target)
        inner = getattr(model, "model", None)
        if inner is None or not hasattr(inner, "generate"):
            raise h11.H11Error("Sa2VA inner language model missing generate")
        eos_token_id = getattr(processor.tokenizer, "eos_token_id", None)
        restore_generate, recorder = h11.install_generate_interceptor(
            inner,
            eos_token_id=eos_token_id if isinstance(eos_token_id, int) else None,
        )
        try:
            with torch.inference_mode():
                forward_result = model.predict_forward(
                    image=oriented.rgb,
                    text=composed,
                    processor=processor,
                    tokenizer=processor.tokenizer,
                )
        finally:
            inner.generate = restore_generate

        generation = recorder.get("generation")
        if not isinstance(generation, h11.GenerationRecord):
            raise h11.H11Error("generate interceptor did not record generation metadata")
        gen_diag = h11.generation_record_to_diagnostics(generation)
        if generation.truncated:
            return {
                **_row_diagnostics(device, wall_start),
                **base,
                "outcome_kind": "technical_error",
                "error_code": "GENERATION_TRUNCATED",
                "error_message": "generation hit max_new_tokens without EOS",
                "source_width": oriented.width,
                "source_height": oriented.height,
                "source_sha256": oriented.raw_source_sha256,
                "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
                "composed_prompt_sha256": prompt_sha,
                "prediction_text": None,
                "generation_token_count": generation.token_count,
                "generation_truncated": True,
                "generation_diagnostics": gen_diag,
                "native_mask_count": None,
                "candidate_masks": [],
                "selected_mask_index": None,
                "mask_path": None,
                "mask_sha256": None,
                "foreground_bounds": None,
            }

        if not isinstance(forward_result, dict):
            raise h11.H11Error("predict_forward must return a dict")
        prediction_text = forward_result.get("prediction")
        if isinstance(prediction_text, str) and len(prediction_text) > 16_384:
            prediction_text = prediction_text[:16_384]
        native_masks = forward_result.get("prediction_masks")
        if native_masks is None:
            native_masks = []
        if not isinstance(native_masks, list):
            raise h11.H11Error("prediction_masks must be a list")

        candidates, selected_index, selected_bounds = h11.retain_native_masks(
            native_masks,
            height=oriented.height,
            width=oriented.width,
            masks_dir=masks_dir,
            row_key=row_key,
        )
        candidate_json = [h11.candidate_record_to_json(item) for item in candidates]
        if selected_index is None:
            return {
                **_row_diagnostics(device, wall_start),
                **base,
                "outcome_kind": "unresolved_no_mask",
                "source_width": oriented.width,
                "source_height": oriented.height,
                "source_sha256": oriented.raw_source_sha256,
                "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
                "composed_prompt_sha256": prompt_sha,
                "prediction_text": prediction_text if isinstance(prediction_text, str) else None,
                "generation_token_count": generation.token_count,
                "generation_truncated": False,
                "generation_diagnostics": gen_diag,
                "native_mask_count": len(native_masks),
                "candidate_masks": candidate_json,
                "selected_mask_index": None,
                "mask_path": None,
                "mask_sha256": None,
                "foreground_bounds": None,
            }

        selected = candidates[selected_index]
        return {
            **_row_diagnostics(device, wall_start),
            **base,
            "outcome_kind": "candidate",
            "source_width": oriented.width,
            "source_height": oriented.height,
            "source_sha256": oriented.raw_source_sha256,
            "oriented_rgb_sha256": oriented.oriented_rgb_sha256,
            "composed_prompt_sha256": prompt_sha,
            "prediction_text": prediction_text if isinstance(prediction_text, str) else None,
            "generation_token_count": generation.token_count,
            "generation_truncated": False,
            "generation_diagnostics": gen_diag,
            "native_mask_count": len(native_masks),
            "candidate_masks": candidate_json,
            "selected_mask_index": selected_index,
            "mask_path": f"masks/{row_key}/mask.u8",
            "mask_sha256": selected.sha256,
            "foreground_bounds": selected_bounds,
        }
    except h11.H11Error as error:
        return _technical_row(base, oriented, row, device, wall_start, "H11_ERROR", str(error))
    except Exception as error:  # noqa: BLE001 — worker boundary
        return _technical_row(base, oriented, row, device, wall_start, "WORKER_FAILURE", str(error))
    finally:
        if oriented is not None:
            oriented.rgb.close()


def _technical_row(
    base: dict[str, Any],
    oriented: Any,
    row: dict[str, Any],
    device: torch.device,
    wall_start: float,
    code: str,
    message: str,
) -> dict[str, Any]:
    authored_target = row["authored_target"]
    prompt_sha = None
    try:
        prompt_sha = h11.composed_prompt_sha256(authored_target)
    except h11.H11Error:
        prompt_sha = None
    return {
        **_row_diagnostics(device, wall_start),
        **base,
        "outcome_kind": "technical_error",
        "error_code": code,
        "error_message": message,
        "source_width": oriented.width if oriented is not None else None,
        "source_height": oriented.height if oriented is not None else None,
        "source_sha256": oriented.raw_source_sha256 if oriented is not None else row.get("expected_source_sha256"),
        "oriented_rgb_sha256": oriented.oriented_rgb_sha256 if oriented is not None else None,
        "composed_prompt_sha256": prompt_sha,
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
    }


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
        output_root = masks_dir.parent
        _configure_hf_cache(output_root)
        contract = h11.load_contract(contract_path)
        load_start = time.perf_counter()
        processor, model, torch_device = load_stack(asset_dir, device, contract)
        load_ms = (time.perf_counter() - load_start) * 1000.0
        emit(
            {
                "type": "ready",
                "load_ms": load_ms,
                "device": str(torch_device),
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
            emit(run_row(processor, model, torch_device, row_payload, masks_dir))
        return 0
    except Exception as error:  # noqa: BLE001
        emit({"type": "fatal", "message": str(error), "traceback": traceback.format_exc(limit=8)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
