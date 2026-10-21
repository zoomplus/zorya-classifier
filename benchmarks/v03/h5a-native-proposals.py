#!/usr/bin/env python3
"""Bounded producer-only H5a composition of frozen DINO and Omni/SAM2 masks."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path("/root/work/zorya-classifier")
ASSETS = Path("/root/work/zorya-classifier-models/v03")
PYTHON = Path("/root/work/zorya-classifier/.run/v03/python-env/bin/python")
H3_DIR = Path("/root/work/zorya-classifier/.run/v03/grounded-proposals-h3-run-02")
H3_SCRIPT = ROOT / "benchmarks/v03/grounded-proposals-probe.py"
OMNI_SCRIPT = ROOT / "benchmarks/v03/ui-proposal-probe.py"
H4E_SCRIPT = Path(__file__).with_name("h4e-sam2-context-prompt.py")
H4E_DIR = Path(__file__).resolve().parents[2] / ".run/v03/h4e-sam2-context-prompt-v1"
H4A_DIR = Path(__file__).resolve().parents[2] / ".run/v03/ui-proposal-probe-v1"
MANIFEST_DIR = ROOT / "benchmarks/v03/pilot-inputs"
IMAGE_ROOT = Path("/root/work/zorya-classifier-worktrees/v02/corpus")
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / ".run/v03/h5a-native-proposals-v1"
H3_RUN_SHA256 = "df26427390fa0bc20ceaa12d372041a7c012d47bd9e1483c379171c43960e401"
H3_SEALED_RUN_SHA256 = "1dd6408dc1b584ddd884c79ee5c0afea17f85ca3c607e4d3fc2fc6fa602e89d5"
H4E_RUN_SHA256 = "dab327f4ee13af4b5b742e681fd180bbc96372a4669833754f77a3c5f9ea55d4"
H4A_OUTPUT_SHA256 = "d1ff8a0fd97e6197834c673d399fe9f1ecfcd2d93182ab2a4fd3767e702755a1"
H4A_FREEZE_SHA256 = "30ff2cf2f1894745c8e5e227e35ef1858432c63f55ae454a1e10f86118668753"
H4E_SOURCE_SHA256 = "0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09"
H3_SCRIPT_SHA256 = "7695cb42cd6e4e583f6cb5bab08d93d40c18d08c188651948b4fed0b43fdc8b5"
OMNI_SCRIPT_SHA256 = "fd1cc46823913e143219dcb4e2faf28393f21324b146e14d9feebbb6d58d217d"
H4E_SCRIPT_SHA256 = "4b74661b0fe156c4f1da46a24fc25e313150ac9d0f83076a1eae441425fb3582"
OMNI_MODEL_SHA256 = "11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c"
OMNI_LICENSE_SHA256 = "646f8936b8ddcd14e13e578ff6857e368780b0d1a4f6066bee89211923a373e2"
OMNI_MODEL_REVISION = "f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4"
DEADLINE_SECONDS = 240
MAX_PIXELS = 2_097_152
MAX_CANDIDATES = 36
MAX_PACKED_BYTES = 19 * 1024 * 1024
MANIFEST_HASHES = {
    "photo.json": {"ee1d36d254f3aeddd9b9739143754dfbdc3409e155ab76334e10cf04e0bfb44b", "daa1759c5a08b7abf827641843df80e6b777fae8c0c04ac651fa7435235003fa"},
    "ui.json": {"5732d534990bfa98299a4e85f760acfa5319e0193e86bc182853558786cb0e9f", "7b1038e6ecb32b7ddce0af7fabe1b9afbcc63e6aaa075b77591357a28681b1bb"},
    "map.json": {"6886670e7f9529805196fe8502975f78c968ff612bfa3279c323cad215ba89c4", "602844b8c2add14ec6d96424dc03a8c0a39c4cb15a0397f78a9d29778d805d81"},
}


class ProbeError(RuntimeError):
    pass


def sha256_file(path: Path) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def file_receipt(path: Path, expected: str | None = None) -> dict[str, Any]:
    digest, size = sha256_file(path)
    if expected and digest != expected:
        raise ProbeError(f"pinned file digest mismatch: {path}")
    return {"path": str(path.resolve()), "sha256": digest, "bytes": size}


def load_module(path: Path, name: str, expected_sha256: str):
    if file_receipt(path, expected_sha256)["sha256"] != expected_sha256:
        raise ProbeError(f"pinned helper mismatch: {path}")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ProbeError(f"cannot load frozen helper: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def expand_prompt_box(box: list[float], width: int, height: int) -> list[float]:
    if len(box) != 4 or any(not math.isfinite(float(value)) for value in box):
        raise ProbeError("box must contain four finite coordinates")
    x0, y0, x1, y1 = map(float, box)
    bw, bh = x1 - x0, y1 - y0
    if bw <= 0 or bh <= 0:
        raise ProbeError("box must have positive area")
    result = [max(0.0, x0 - .25 * bw), max(0.0, y0 - .25 * bh), min(float(width), x1 + .25 * bw), min(float(height), y1 + .25 * bh)]
    if result[2] <= result[0] or result[3] <= result[1]:
        raise ProbeError("expanded box is degenerate")
    return result


def packed_mask_bytes(width: int, height: int, total_candidates: int) -> int:
    if width <= 0 or height <= 0 or total_candidates < 0:
        raise ProbeError("invalid packed-mask dimensions or count")
    return ((width * height + 7) // 8) * total_candidates


def validate_mask_count(width: int, height: int, dino_count: int, omni_count: int) -> int:
    if dino_count > MAX_CANDIDATES or omni_count > MAX_CANDIDATES:
        raise ProbeError("family candidate cap exceeded")
    total = packed_mask_bytes(width, height, dino_count + omni_count)
    if total > MAX_PACKED_BYTES:
        raise ProbeError("aggregate packed-mask limit exceeded")
    return total


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


def run_bounded(command: list[str], deadline_seconds: int, log_path: Path) -> tuple[str, str | None, bytes]:
    with log_path.open("xb") as stderr:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
        try:
            stdout, _ = process.communicate(timeout=deadline_seconds)
        except subprocess.TimeoutExpired:
            kill_owned_group(process)
            return "timeout", f"exceeded {deadline_seconds}-second image deadline", b""
    if process.returncode != 0:
        return "error", f"worker exited with status {process.returncode}", stdout
    return "complete", None, stdout


def load_inputs(image_root: Path, manifest_dir: Path) -> list[dict[str, Any]]:
    rows = []
    for filename in ("photo.json", "ui.json", "map.json"):
        path = manifest_dir / filename
        digest, _ = sha256_file(path)
        if digest not in MANIFEST_HASHES[filename]:
            raise ProbeError(f"fixed manifest changed: {filename}")
        manifest_rows = json.loads(path.read_text(encoding="utf-8"))
        for row in manifest_rows:
            item = dict(row)
            image_path = (image_root / item["image"]["path"]).resolve(strict=True)
            try:
                image_path.relative_to(image_root.resolve(strict=True))
            except ValueError as error:
                raise ProbeError("source image escaped the explicit root") from error
            receipt = file_receipt(image_path, item["image"]["sha256"])
            if receipt["bytes"] > 24 * 1024 * 1024 or item["image"]["width"] * item["image"]["height"] > MAX_PIXELS:
                raise ProbeError(f"source resource ceiling exceeded: {item['caseId']}")
            item["_resolved_source"] = str(image_path)
            rows.append(item)
    if len(rows) != 12 or len({row["caseId"] for row in rows}) != 12:
        raise ProbeError("expected twelve unique fixed case rows")
    return rows


def load_h3_artifacts(h3_dir: Path, source_by_case: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    run_path = h3_dir / "run.json"
    file_receipt(run_path, H3_RUN_SHA256)
    run = json.loads(run_path.read_text(encoding="utf-8"))
    if run.get("status") != "complete" or len(run.get("cases", [])) != 12:
        raise ProbeError("H3b producer run is not the frozen complete 12-case run")
    candidates: dict[str, list[dict[str, Any]]] = {}
    rows_receipt = []
    for case_id, source in source_by_case.items():
        path = h3_dir / "cases" / f"{case_id}.json"
        item_receipt = file_receipt(path)
        row = json.loads(path.read_text(encoding="utf-8"))
        if row.get("status") != "complete" or row.get("source_sha256") != source["image"]["sha256"]:
            raise ProbeError(f"H3b source/result mismatch for {case_id}")
        masks = row.get("mask_candidates")
        if not isinstance(masks, list) or len(masks) > MAX_CANDIDATES:
            raise ProbeError(f"invalid H3b candidates for {case_id}")
        records = []
        for candidate in masks:
            mask_path = (h3_dir / candidate["mask_path"]).resolve(strict=True)
            try:
                mask_path.relative_to(h3_dir.resolve(strict=True))
            except ValueError as error:
                raise ProbeError("H3b mask escaped its owned run directory") from error
            mask_receipt = file_receipt(mask_path, candidate["mask_sha256"])
            records.append({**candidate, "mask_path": str(mask_path), "mask_receipt": mask_receipt})
        candidates[case_id] = records
        rows_receipt.append({"case_id": case_id, "row": item_receipt, "candidate_count": len(records), "mask_hashes": [r["mask_sha256"] for r in records]})
    return {"run": file_receipt(run_path), "cases": rows_receipt, "sealed_h3_run_sha256": H3_SEALED_RUN_SHA256}, candidates


def h4e_ui_candidates(h4e_dir: Path, h4a_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    run_path = h4e_dir / "run.json"
    file_receipt(run_path, H4E_RUN_SHA256)
    h4a_path = h4a_dir / "omniparser-ui-boxes-corrected-image-root.json"
    h4a_freeze = h4a_dir / "omniparser-ui-boxes-corrected-image-root.freeze.json"
    file_receipt(h4a_path, H4A_OUTPUT_SHA256)
    file_receipt(h4a_freeze, H4A_FREEZE_SHA256)
    run = json.loads(run_path.read_text(encoding="utf-8"))
    if run.get("state") != "complete" or run.get("candidate_count") != MAX_CANDIDATES:
        raise ProbeError("H4e closed result is incomplete")
    records = []
    for row in run["results"]:
        path = (h4e_dir / row["mask_path"]).resolve(strict=True)
        try:
            path.relative_to((h4e_dir / "masks").resolve(strict=True))
        except ValueError as error:
            raise ProbeError("H4e mask escaped its immutable output directory") from error
        receipt = file_receipt(path, row["mask_sha256"])
        records.append({**row, "mask_path": str(path), "mask_receipt": receipt})
    if len(records) != MAX_CANDIDATES:
        raise ProbeError("H4e mask count differs from the frozen 36-box run")
    return {"run": file_receipt(run_path), "h4a_output": file_receipt(h4a_path), "h4a_freeze": file_receipt(h4a_freeze), "cached_without_rerun": True}, records


def verify_generation_inputs() -> dict[str, Any]:
    for path, digest in ((H3_SCRIPT, H3_SCRIPT_SHA256), (OMNI_SCRIPT, OMNI_SCRIPT_SHA256), (H4E_SCRIPT, H4E_SCRIPT_SHA256)):
        file_receipt(path, digest)
    omni_model = ASSETS / "omniparser-v3" / "model.pt"
    omni_license = ASSETS / "omniparser-v3" / "LICENSE"
    dino_sam_model_manifest = json.loads((ASSETS / "asset-manifest.json").read_text(encoding="utf-8"))
    verified_asset_files = []
    for item in dino_sam_model_manifest["verified_files"]:
        path = ASSETS / item["directory"] / item["filename"]
        receipt = file_receipt(path, item["sha256"])
        if receipt["bytes"] != item["size"]:
            raise ProbeError(f"pinned model file size mismatch: {path}")
        verified_asset_files.append(receipt)
    return {
        "h3_producer": file_receipt(H3_SCRIPT, H3_SCRIPT_SHA256),
        "omni_detector_producer": file_receipt(OMNI_SCRIPT, OMNI_SCRIPT_SHA256),
        "h4e_producer": file_receipt(H4E_SCRIPT, H4E_SCRIPT_SHA256),
        "omni_model": file_receipt(omni_model, OMNI_MODEL_SHA256),
        "omni_license": file_receipt(omni_license, OMNI_LICENSE_SHA256),
        "dino_sam2_asset_manifest": dino_sam_model_manifest,
        "dino_sam2_verified_files": verified_asset_files,
        "python_freeze": file_receipt(ASSETS / "python-freeze.txt"),
        "runtime": {"python": sys.version.split()[0], "transformers": "4.57.3", "torch": "2.6.0+cu124", "torchvision": "0.21.0+cu124", "cuda": "12.4", "device": "one sequential GPU worker"},
    }


def worker(source: dict[str, Any], proposals: list[dict[str, Any]], output_dir: Path, models_dir: Path) -> dict[str, Any]:
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"})
    omni = load_module(OMNI_SCRIPT, "h5a_pinned_omni", OMNI_SCRIPT_SHA256)
    h4e = load_module(H4E_SCRIPT, "h5a_pinned_h4e", H4E_SCRIPT_SHA256)
    import numpy as np
    import torch
    from PIL import Image
    from transformers import Sam2Model, Sam2Processor

    if not torch.cuda.is_available():
        raise ProbeError("CUDA device is unavailable")
    source_path = Path(source["_resolved_source"])
    source_receipt = file_receipt(source_path, source["image"]["sha256"])
    with Image.open(source_path) as opened:
        image = opened.convert("RGB")
    width, height = image.size
    if (width, height) != (source["image"]["width"], source["image"]["height"]):
        raise ProbeError("source dimensions differ from frozen manifest")
    source_record = {"source": source_path, "receipt": source_receipt, "width": width, "height": height, "case_ids": [source["caseId"]]}
    omni_start = time.monotonic()
    omni_result = omni.run_inference(source_record, models_dir / "omniparser-v3/model.pt", "cuda")
    omni_ms = (time.monotonic() - omni_start) * 1000
    boxes = [row["box_xyxy"] for row in omni_result["candidates"]]
    expanded = [h4e.expand_prompt_box(box, width, height) for box in boxes]
    model_dir = models_dir / "sam2-hiera-tiny"
    processor = Sam2Processor.from_pretrained(model_dir, local_files_only=True)
    model = Sam2Model.from_pretrained(model_dir, local_files_only=True, use_safetensors=True, torch_dtype=torch.float16).to("cuda:0").eval()
    image_inputs = processor(images=image, return_tensors="pt").to("cuda:0")
    with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
        image_embeddings = model.get_image_embeddings(image_inputs["pixel_values"])
    box_inputs = processor(images=image, input_boxes=[expanded], return_tensors="pt").to("cuda:0") if expanded else None
    masks_dir = output_dir / "masks" / source["image"]["sha256"]
    masks_dir.mkdir(parents=True, exist_ok=False)
    records = []
    sam_started = time.monotonic()
    for index, (detector, expanded_box) in enumerate(zip(omni_result["candidates"], expanded, strict=True)):
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
            outputs = model(image_embeddings=image_embeddings, input_boxes=box_inputs["input_boxes"][:, index:index + 1], multimask_output=False)
        masks = processor.post_process_masks(outputs.pred_masks.cpu(), image_inputs["original_sizes"])[0]
        array = np.squeeze(masks[0].detach().float().cpu().numpy())
        if array.shape != (height, width):
            raise ProbeError(f"SAM2 mask {index} is not source-sized")
        binary = array > 0.0
        mask_path = masks_dir / f"U{index:02d}.png"
        Image.fromarray(binary.astype(np.uint8) * 255, mode="L").save(mask_path, format="PNG", optimize=False)
        mask_hash, mask_bytes = sha256_file(mask_path)
        ys, xs = np.nonzero(binary)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None
        records.append({"id": f"U{index:02d}", "detector_index": detector["flat_index"], "box_xyxy": detector["box_xyxy"], "expanded_prompt_xyxy": expanded_box, "omni_score": detector["score"], "mask_path": str(mask_path), "mask_sha256": mask_hash, "mask_bytes": mask_bytes, "mask_box_xyxy": bbox, "empty": not bool(len(xs)), "sam2_mask_threshold": 0.0, "mask_frame": "full source"})
        del outputs, masks, array, binary
    torch.cuda.synchronize()
    sam_ms = (time.monotonic() - sam_started) * 1000
    peak = {"allocated": torch.cuda.max_memory_allocated(0), "reserved": torch.cuda.max_memory_reserved(0)}
    result = {"source": source_receipt, "dimensions": {"width": width, "height": height}, "runtime": {"python": sys.version.split()[0], "torch": torch.__version__, "torchvision": __import__("torchvision").__version__, "transformers": __import__("transformers").__version__, "cuda": torch.version.cuda, "device": torch.cuda.get_device_name(0), "dtype": "float16"}, "omni": {"revision": OMNI_MODEL_REVISION, "model_sha256": OMNI_MODEL_SHA256, "threshold": omni.CONFIDENCE_THRESHOLD, "nms_iou": omni.NMS_IOU_THRESHOLD, "candidate_count": len(omni_result["candidates"]), "truncated_count": omni_result["truncated"], "candidates": omni_result["candidates"], "elapsed_ms": omni_ms}, "sam2": {"revision": "7c218beaf0bb87874785f32b582f640134fc1c09", "prompt_count": len(records), "serial_decodes": True, "image_encodes": 1, "mask_threshold": 0.0, "elapsed_ms": sam_ms, "candidates": records}, "timing_ms": {"omni_detector": omni_ms, "sam2_serial_prompts": sam_ms}, "peak_vram_bytes": peak}
    image.close()
    del model, processor, image_embeddings
    torch.cuda.empty_cache()
    return result


def run_parent(args: argparse.Namespace) -> int:
    if args.worker:
        payload = json.loads(Path(args.worker).read_text(encoding="utf-8"))
        print(json.dumps(worker(payload["source"], payload["proposals"], Path(payload["output_dir"]), Path(payload["models_dir"])), separators=(",", ":")))
        return 0
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    for child in ("cases", "masks", "worker-logs", "worker-input"):
        (output / child).mkdir()
    inputs = load_inputs(args.image_root.resolve(strict=True), args.manifest_dir.resolve(strict=True))
    source_by_case = {row["caseId"]: row for row in inputs}
    h3_receipt, h3_candidates = load_h3_artifacts(args.h3_dir.resolve(strict=True), source_by_case)
    h4e_receipt, ui_cached = h4e_ui_candidates(args.h4e_dir.resolve(strict=True), args.h4a_dir.resolve(strict=True))
    ui_source_hashes = {row["image"]["sha256"] for row in inputs if row["caseId"].startswith("pilot-v03-ui-")}
    if len(ui_source_hashes) != 1 or next(iter(ui_source_hashes)) != H4E_SOURCE_SHA256:
        raise ProbeError("H4e cache source does not match the fixed UI source identity")
    receipts = verify_generation_inputs()
    module_hash = file_receipt(Path(__file__).resolve())
    freeze = {"state": "frozen-before-generation", "hypothesis": "H5a-native-proposals-v1", "source_freeze": receipts, "producer": module_hash, "h3b": h3_receipt, "h4e_ui_cache": h4e_receipt, "cases": [{"case_id": row["caseId"], "source": file_receipt(Path(row["_resolved_source"]), row["image"]["sha256"]), "target": row["locate"]["target"]} for row in inputs], "caps": {"deadline_seconds_per_unique_source": DEADLINE_SECONDS, "max_candidates_per_family": MAX_CANDIDATES, "max_source_pixels": MAX_PIXELS, "aggregate_packed_masks_bytes": MAX_PACKED_BYTES, "sam2_decode_batch_size": 1, "same_source_cache": "source SHA-256"}, "runtime_partition": "native generation only; any later paid composition replay is a separate phase"}
    (output / "freeze.json").write_text(json.dumps(freeze, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    source_cache: dict[str, dict[str, Any]] = {}
    for row in inputs:
        source_cache.setdefault(row["image"]["sha256"], row)
    generated: dict[str, dict[str, Any]] = {}
    integrity = []
    for sha, source in source_cache.items():
        if sha == H4E_SOURCE_SHA256:
            generated[sha] = {"source": file_receipt(Path(source["_resolved_source"])), "omni": {"candidate_count": MAX_CANDIDATES, "cached_from_h4a": True, "candidates": [{"id": item["id"] if "id" in item else f"U{index:02d}", "box_xyxy": item["box_xyxy"], "expanded_prompt_xyxy": item["expanded_prompt_xyxy"], "mask_path": item["mask_path"], "mask_sha256": item["mask_sha256"], "mask_bytes": item["mask_bytes"], "mask_box_xyxy": item["mask_box_xyxy"], "empty": item["empty"], "sam2_mask_threshold": 0.0, "cached_h4e": True} for index, item in enumerate(ui_cached)]}, "peak_vram_bytes": None, "timing_ms": {"generation": 0, "source_cache_reuse": True}}
            integrity.append({"source_sha256": sha, "h4e_masks": [file_receipt(Path(row["mask_path"]), row["mask_sha256"]) for row in ui_cached]})
            continue
        started = time.monotonic()
        case_row_path = output / "worker-input" / f"{sha}.json"
        proposals = h3_candidates[source["caseId"]]
        payload = {"source": source, "proposals": proposals, "output_dir": str(output), "models_dir": str(ASSETS)}
        case_row_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        log_path = output / "worker-logs" / f"{sha}.stderr.log"
        worker_cmd = [str(PYTHON), str(Path(__file__).resolve()), "--worker", str(case_row_path)]
        status, error, stdout = run_bounded(worker_cmd, DEADLINE_SECONDS, log_path)
        case_row_path.unlink(missing_ok=True)
        if status != "complete":
            generated[sha] = {"status": status, "error": error, "elapsed_ms": (time.monotonic() - started) * 1000}
            for not_run_sha in source_cache:
                generated.setdefault(not_run_sha, {"status": "not_run_after_failure"})
            break
        try:
            native = json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            generated[sha] = {"status": "error", "error": f"invalid worker JSON: {error}"}
            break
        native["status"] = "complete"
        native["elapsed_ms_including_child_startup"] = (time.monotonic() - started) * 1000
        native.setdefault("timing_ms", {})["worker_total"] = native["elapsed_ms_including_child_startup"]
        dino_count = len(proposals)
        packed_bytes = validate_mask_count(source["image"]["width"], source["image"]["height"], dino_count, len(native["sam2"]["candidates"]))
        native["packed_mask_bytes_combined"] = packed_bytes
        native["dino_candidate_count_replayed"] = dino_count
        generated[sha] = native
        integrity.append({"source_sha256": sha, "source": file_receipt(Path(source["_resolved_source"])), "omni_masks": [file_receipt(Path(item["mask_path"]), item["mask_sha256"]) for item in native["sam2"]["candidates"]]})
        (output / "cases" / f"source-{sha}.json").write_text(json.dumps(native, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    case_rows = []
    for row in inputs:
        sha = row["image"]["sha256"]
        native = generated.get(sha, {"status": "not_run"})
        h3 = h3_candidates[row["caseId"]]
        packed_bytes = validate_mask_count(row["image"]["width"], row["image"]["height"], len(h3), len(native.get("sam2", {}).get("candidates", native.get("omni", {}).get("candidates", [])))) if native.get("status", "complete") == "complete" else None
        case_rows.append({"case_id": row["caseId"], "source_sha256": sha, "target": row["locate"]["target"], "status": native.get("status", "complete"), "packed_mask_bytes_combined": packed_bytes, "dino_candidates": [{k: v for k, v in candidate.items() if k in ("id", "detector_index", "box_xyxy", "score", "mask_box_xyxy", "mask_path", "mask_sha256", "sam2_mask_threshold", "mask_receipt")} for candidate in h3], "omni_cache_source_sha256": sha, "omni_source_result": str((output / "cases" / f"source-{sha}.json").resolve()) if (output / "cases" / f"source-{sha}.json").exists() else None})
    integrity_after = verify_generation_inputs()
    if integrity_after != receipts:
        raise ProbeError("runtime, models, or producer hashes changed during generation")
    run = {"state": "complete" if all(row["status"] == "complete" for row in case_rows) else "incomplete", "hypothesis": "H5a-native-proposals-v1", "freeze": file_receipt(output / "freeze.json"), "source_freeze_after": integrity_after, "h3b": h3_receipt, "h4e_ui_cache": h4e_receipt, "source_cache_entries": len(source_cache), "source_integrity_after": integrity, "cases": case_rows, "native_generation_ms": sum(value.get("elapsed_ms_including_child_startup", value.get("timing_ms", {}).get("generation", 0)) for value in generated.values()), "paid_calls": 0, "candidate_semantics": "availability evidence only; no candidate is selected and no truth/evaluator artifacts were read"}
    (output / "run.json").write_text(json.dumps(run, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"state": run["state"], "output": str(output), "unique_sources": len(source_cache), "cases": len(case_rows)}))
    return 0 if run["state"] == "complete" else 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-root", type=Path, default=IMAGE_ROOT)
    parser.add_argument("--manifest-dir", type=Path, default=MANIFEST_DIR)
    parser.add_argument("--h3-dir", type=Path, default=H3_DIR)
    parser.add_argument("--h4e-dir", type=Path, default=H4E_DIR)
    parser.add_argument("--h4a-dir", type=Path, default=H4A_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        raise SystemExit(run_parent(parse_args()))
    except Exception as error:
        print(json.dumps({"state": "error", "error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        raise SystemExit(1)
