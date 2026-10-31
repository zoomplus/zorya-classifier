#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("h8af_common", _DIR / "native-common.py")
assert _spec and _spec.loader
common = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = common
_spec.loader.exec_module(common)


def generate_proposals(request_path: Path) -> int:
    os.environ.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
        }
    )
    request_path = request_path.resolve(strict=True)
    payload = common.validate_native_request(json.loads(request_path.read_text(encoding="utf-8")))
    task_dir = payload["task_dir"]
    task_dir.mkdir(parents=True, exist_ok=True)
    identity = {
        "request_id": payload["request_id"],
        "recipe_id": payload["recipe_id"],
        "source_sha256": payload["source_sha256"],
    }
    started = time.monotonic()
    asset_session = common.VerifiedAssetSession()
    try:
        grounded, omni_mod, h4e = common.load_pinned_helpers_for_generation()
        import numpy as np
        import torch
        from PIL import Image
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor

        if torch.cuda.is_available():
            raise common.WorkerError("CUDA must be unavailable for CPU recipe")
        torch.set_num_threads(8)
        torch.set_num_interop_threads(1)
        device = torch.device("cpu")

        assets_dir = payload["assets_dir"].resolve(strict=True)
        common.verify_model_assets(assets_dir, grounded)
        loader_paths = common.prepare_verified_loader_paths(assets_dir, grounded, asset_session)
        freeze_pins = common.parse_python_freeze_pins(
            loader_paths["python-freeze.txt"].read_text(encoding="utf-8")
        )
        common.collect_runtime_receipt(require_pinned=True, freeze_pins=freeze_pins)

        source_path = payload["source_path"].resolve(strict=True)
        source_open = asset_session.open_verified(source_path, expected_sha256=payload["source_sha256"])
        if source_open.size > common.MAX_IMAGE_BYTES:
            raise common.WorkerError("source byte ownership or hash check failed")
        owned_source = source_open.read_all_bytes()
        common.enforce_owned_bytes_digest(owned_source, payload["source_sha256"])
        common.validate_encoded_header(owned_source)
        with Image.open(io.BytesIO(owned_source)) as opened:
            image = opened.convert("RGB")
        width, height = image.size
        if (width, height) != (payload["width"], payload["height"]):
            raise common.WorkerError("decoded source dimensions differ from request")

        dino_dir = loader_paths["grounding-dino-tiny"]
        sam_dir = loader_paths["sam2-hiera-tiny"]
        omni_model = loader_paths["omniparser-v3"] / "model.pt"

        dino_processor = AutoProcessor.from_pretrained(dino_dir, local_files_only=True)
        dino_model = AutoModelForZeroShotObjectDetection.from_pretrained(
            dino_dir, local_files_only=True, use_safetensors=True, torch_dtype=torch.float32
        ).to(device).eval()
        sam_processor = Sam2Processor.from_pretrained(sam_dir, local_files_only=True)
        sam_model = Sam2Model.from_pretrained(
            sam_dir, local_files_only=True, use_safetensors=True, torch_dtype=torch.float32
        ).to(device).eval()

        detector_prompt = payload["detector_prompt"]
        inputs = dino_processor(images=image, text=[[detector_prompt]], return_tensors="pt").to(device)
        with torch.inference_mode():
            raw_outputs = dino_model(**inputs)
        detections = dino_processor.post_process_grounded_object_detection(
            raw_outputs,
            inputs.input_ids,
            threshold=common.BOX_THRESHOLD,
            text_threshold=common.TEXT_THRESHOLD,
            target_sizes=[(height, width)],
        )[0]
        raw_boxes = detections["boxes"].detach().float().cpu().tolist()
        raw_scores = detections["scores"].detach().float().cpu().tolist()
        all_detections: list[dict[str, Any]] = []
        for index, (box, score) in enumerate(zip(raw_boxes, raw_scores, strict=True)):
            all_detections.append(
                {
                    "detector_index": index,
                    "box_xyxy": grounded.validate_box(box, width, height),
                    "score": float(score),
                }
            )
        d_bounded, d_truncated = grounded.bound_detections(all_detections)

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(owned_source)
            tmp_path = Path(tmp.name)
        try:
            source_record = {
                "source": tmp_path,
                "receipt": {"sha256": payload["source_sha256"], "bytes": len(owned_source)},
                "width": width,
                "height": height,
                "case_ids": [],
            }
            omni_result = omni_mod.run_inference(source_record, omni_model, "cpu")
        finally:
            tmp_path.unlink(missing_ok=True)
        u_candidates = omni_result["candidates"]
        d_count = len(d_bounded)
        u_count = len(u_candidates)
        if d_count > common.MAX_CANDIDATES_PER_FAMILY or u_count > common.MAX_CANDIDATES_PER_FAMILY:
            raise common.WorkerError("family candidate cap exceeded")
        if d_count + u_count > common.MAX_CANDIDATES_TOTAL:
            raise common.WorkerError("combined candidate cap exceeded")
        prospective_packed = common.aggregate_packed_limit(width, height, d_count, u_count)
        if prospective_packed > common.MAX_PACKED_BYTES:
            raise common.WorkerError("aggregate packed-mask limit exceeded before SAM2 decode")

        image_inputs = sam_processor(images=image, return_tensors="pt").to(device)
        with torch.inference_mode():
            image_embeddings = sam_model.get_image_embeddings(image_inputs["pixel_values"])

        def decode_serial(
            boxes: list[list[float]],
            family: str,
            detector_meta: list[dict[str, Any]] | None,
            source_candidates: list[dict[str, Any]] | None,
        ) -> list[dict[str, Any]]:
            records: list[dict[str, Any]] = []
            for index, box in enumerate(boxes):
                box_inputs = sam_processor(images=image, input_boxes=[[box]], return_tensors="pt").to(device)
                with torch.inference_mode():
                    outputs = sam_model(
                        image_embeddings=image_embeddings,
                        input_boxes=box_inputs["input_boxes"],
                        multimask_output=False,
                    )
                masks = sam_processor.post_process_masks(outputs.pred_masks.cpu(), box_inputs["original_sizes"])[0]
                array = np.squeeze(masks[0].detach().float().cpu().numpy())
                if array.shape != (height, width):
                    raise common.WorkerError("SAM2 mask is not source-sized")
                binary = array > 0.0
                packed = common.pack_mask_with_validation(binary, width, height)
                meta: dict[str, Any] = {
                    "id": f"{family}{index:02d}",
                    "family": family,
                    "ordinal": index,
                    "box_xyxy": box,
                    "packed_sha256": common.sha256_bytes(packed),
                    "packed_bytes": len(packed),
                    "mask_box_xyxy": common.mask_bbox_np(binary),
                    "empty": not bool(np.any(binary)),
                }
                if detector_meta is not None:
                    meta["detector_index"] = detector_meta[index]["detector_index"]
                    meta["score"] = detector_meta[index]["score"]
                elif source_candidates is not None:
                    src = source_candidates[index]
                    meta.update(
                        {
                            "flat_index": src["flat_index"],
                            "score": src["score"],
                            "omni_box_xyxy": src["box_xyxy"],
                        }
                    )
                records.append({**meta, "_packed": packed})
            return records

        d_boxes = [item["box_xyxy"] for item in d_bounded]
        u_boxes = [h4e.expand_prompt_box(item["box_xyxy"], width, height) for item in u_candidates]
        d_records = decode_serial(d_boxes, "D", d_bounded, None)
        u_records = decode_serial(u_boxes, "U", None, u_candidates)

        mask_dir = task_dir / "packed-masks"
        mask_dir.mkdir(parents=True, exist_ok=True)
        total_packed = 0
        written: list[dict[str, Any]] = []
        for record in d_records + u_records:
            packed_bytes = record.pop("_packed")
            common.validate_packed_bytes(packed_bytes, width, height)
            total_packed += len(packed_bytes)
            if total_packed > common.MAX_PACKED_BYTES:
                raise common.WorkerError("aggregate packed-mask limit exceeded")
            packed_path = mask_dir / f"{record['id']}.bin"
            packed_path.write_bytes(packed_bytes)
            written.append(
                {
                    "id": record["id"],
                    "family": record["family"],
                    "ordinal": record["ordinal"],
                    "packed_path": str(packed_path),
                    "packed_bytes": record["packed_bytes"],
                    "packed_sha256": common.sha256_bytes(packed_bytes),
                    "empty": record["empty"],
                    "mask_box_xyxy": record.get("mask_box_xyxy"),
                }
            )

        response = {
            "schema": common.NATIVE_RESPONSE_SCHEMA,
            "status": "complete",
            "request_id": payload["request_id"],
            "recipe_id": payload["recipe_id"],
            "width": width,
            "height": height,
            "authored_target": payload["authored_target"],
            "source_sha256": payload["source_sha256"],
            "detector_prompt": detector_prompt,
            "families": {
                "D": [item for item in written if item["family"] == "D"],
                "U": [item for item in written if item["family"] == "U"],
            },
            "packed_mask_bytes_total": total_packed,
        }
        common.write_json_atomic(task_dir / "native-response.json", response)
        print(json.dumps({"schema": common.NATIVE_RESPONSE_SCHEMA, "status": "complete"}))
        return 0
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            raise
        response = {
            "schema": common.NATIVE_RESPONSE_SCHEMA,
            "status": "error",
            **identity,
            "error_type": type(error).__name__,
            "error": str(error)[:1000],
        }
        try:
            common.write_json_atomic(task_dir / "native-response.json", response)
        except OSError:
            pass
        traceback.print_exc(file=sys.stderr)
        print(json.dumps(response))
        return 1
    finally:
        asset_session.close()


def validate_request_only(request_path: Path) -> int:
    request_path = request_path.resolve(strict=True)
    common.validate_native_request(json.loads(request_path.read_text(encoding="utf-8")))
    print(json.dumps({"status": "valid"}))
    return 0


def self_test() -> int:
    common.build_dino_prompt("fixture target")
    common.validate_packed_bytes(b"\x00", 8, 1)
    print(json.dumps({"status": "self_test_ok", "recipe_id": common.RECIPE_ID}))
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--validate-request", metavar="PATH")
    parser.add_argument("--generate", metavar="PATH")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    if args.validate_request:
        return validate_request_only(Path(args.validate_request))
    if args.generate:
        return generate_proposals(Path(args.generate))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
