#!/usr/bin/env python3
"""Copy frozen photo/UI/map producer images into one private image root.

Only image paths are rewritten in the derived producer manifests. Original
manifests and truth files are read-only inputs and remain byte-for-byte intact.
All copied raster/mask payloads are verified against their frozen SHA-256.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any


PHOTO_INPUT_SHA256 = "8ba27cd0a5f0aaafeeb612c412e2078e9e5f5b0e1d996fab863182fc56e9b99f"
UI_INPUT_SHA256 = "2a0fafceeefa3253b1b99f993d3a7a41b7595aa70b60abbb9b3f1ee654866781"
MAP_INPUT_SHA256 = "d7c0e31f0b798a1e79d79d56434b4622f1bd09ee48debb2a5047b6d92a03abe8"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def load_array(path: Path, expected_hash: str) -> tuple[bytes, list[dict[str, Any]]]:
    raw = path.read_bytes()
    if sha256_bytes(raw) != expected_hash:
        raise ValueError(f"frozen producer manifest hash mismatch: {path}")
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise ValueError(f"producer manifest is not a JSON array: {path}")
    if any(set(row) != {"caseId", "image", "locate", "classify"} for row in value):
        raise ValueError(f"producer manifest row has unexpected fields: {path}")
    return raw, value


def within(root: Path, path: Path) -> Path:
    root_real = root.resolve(strict=True)
    path_real = path.resolve(strict=True)
    if path_real == root_real or root_real not in path_real.parents or not path_real.is_file():
        raise ValueError("source image escaped its declared root")
    return path_real


def copy_exact(source: Path, destination: Path, expected_sha: str) -> int:
    source_hash = sha256_file(source)
    if source_hash != expected_sha:
        raise ValueError(f"source image hash mismatch: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as src, destination.open("xb") as dst:
        shutil.copyfileobj(src, dst, length=1024 * 1024)
    if sha256_file(destination) != expected_sha:
        raise ValueError("copied image hash mismatch")
    return destination.stat().st_size


def write_json(path: Path, value: object) -> bytes:
    raw = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(raw)
    return raw


def derive_images(
    rows: list[dict[str, Any]],
    *,
    kind: str,
    source_root: Path,
    destination_root: Path,
    map_case_root: Path | None = None,
) -> tuple[list[dict[str, Any]], int, int]:
    result: list[dict[str, Any]] = []
    count = total_bytes = 0
    for row in rows:
        item = json.loads(json.dumps(row))
        image = item.get("image")
        case_id = item.get("caseId")
        if not isinstance(image, dict) or not isinstance(case_id, str):
            raise ValueError("invalid producer case image binding")
        source_path = Path(image["path"])
        if kind == "map":
            if map_case_root is None:
                raise ValueError("map capture root was not provided")
            source = within(map_case_root, map_case_root / case_id / "b" / "screen.png")
            suffix = ".png"
        else:
            if source_path.is_absolute() or ".." in source_path.parts:
                raise ValueError("producer image path is not a safe relative path")
            source = within(source_root, source_root / source_path)
            suffix = source.suffix.lower()
            if suffix not in (".jpg", ".jpeg", ".png", ".webp"):
                raise ValueError("unsupported frozen raster extension")
        new_relative = f"{kind}/{case_id}{suffix}"
        size = copy_exact(source, destination_root / new_relative, image["sha256"])
        item["image"]["path"] = new_relative
        result.append(item)
        count += 1
        total_bytes += size
    return result, count, total_bytes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--photo-input", type=Path, required=True)
    parser.add_argument("--photo-root", type=Path, required=True)
    parser.add_argument("--photo-truth", type=Path, required=True)
    parser.add_argument("--photo-mask-index", type=Path, required=True)
    parser.add_argument("--ui-input", type=Path, required=True)
    parser.add_argument("--ui-root", type=Path, required=True)
    parser.add_argument("--ui-truth", type=Path, required=True)
    parser.add_argument("--map-input", type=Path, required=True)
    parser.add_argument("--map-cohort", type=Path, required=True)
    parser.add_argument("--map-truth", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new private directory containing imageRoot and manifests")
    args = parser.parse_args()

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    image_root = output / "imageRoot"
    image_root.mkdir()
    photo_raw, photo_rows = load_array(args.photo_input, PHOTO_INPUT_SHA256)
    ui_raw, ui_rows = load_array(args.ui_input, UI_INPUT_SHA256)
    map_raw, map_rows = load_array(args.map_input, MAP_INPUT_SHA256)
    if (len(photo_rows), len(ui_rows), len(map_rows)) != (40, 20, 20):
        raise ValueError("frozen producer manifests must contain 40/20/20 cases")
    all_ids = [row["caseId"] for row in photo_rows + ui_rows + map_rows]
    if len(set(all_ids)) != len(all_ids):
        raise ValueError("case IDs overlap across frozen source strata")
    photo, photo_count, photo_bytes = derive_images(
        photo_rows, kind="photo", source_root=args.photo_root, destination_root=image_root
    )
    ui, ui_count, ui_bytes = derive_images(
        ui_rows, kind="ui", source_root=args.ui_root, destination_root=image_root
    )
    map_cases = args.map_cohort / "captures"
    map_rows_derived, map_count, map_bytes = derive_images(
        map_rows,
        kind="map",
        source_root=args.map_cohort,
        destination_root=image_root,
        map_case_root=map_cases,
    )

    # Preserve every official reference-mask path expected by the evaluator;
    # the canonical source index names these under masks/<caseId>/...
    index_raw = args.photo_mask_index.read_bytes()
    mask_index = json.loads(index_raw)
    if not isinstance(mask_index, dict) or not isinstance(mask_index.get("masks"), list):
        raise ValueError("photo mask index has an unknown schema")
    mask_count = mask_bytes = 0
    for record in mask_index["masks"]:
        rel = Path(record["path"])
        if rel.is_absolute() or ".." in rel.parts or not rel.parts[:1] == ("masks",):
            raise ValueError("official mask index contains an unsafe path")
        source = within(args.photo_root, args.photo_root / rel)
        mask_bytes += copy_exact(source, image_root / rel, record["sha256"])
        mask_count += 1

    photo_manifest = write_json(output / "photo-inputs.json", photo)
    ui_manifest = write_json(output / "ui-inputs.json", ui)
    map_manifest = write_json(output / "map-inputs.json", map_rows_derived)
    combined_manifest = write_json(output / "combined-inputs.json", photo + ui + map_rows_derived)
    immutable_truths = {}
    for key, path in (
        ("photoTruth", args.photo_truth),
        ("uiTruth", args.ui_truth),
        ("mapTruth", args.map_truth),
    ):
        raw = path.read_bytes()
        name = f"{key}.json"
        (output / name).write_bytes(raw)
        immutable_truths[key] = {"sha256": sha256_bytes(raw), "bytes": len(raw), "file": name}
    receipt = {
        "scope": "private frozen-input/image-root derivation; no model dispatch or truth mutation",
        "originalProducerInputs": {
            "photo": {"sha256": sha256_bytes(photo_raw), "file": str(args.photo_input), "cases": len(photo_rows)},
            "ui": {"sha256": sha256_bytes(ui_raw), "file": str(args.ui_input), "cases": len(ui_rows)},
            "map": {"sha256": sha256_bytes(map_raw), "file": str(args.map_input), "cases": len(map_rows)},
        },
        "derivedProducerInputs": {
            "photo": {"sha256": sha256_bytes(photo_manifest), "cases": photo_count},
            "ui": {"sha256": sha256_bytes(ui_manifest), "cases": ui_count},
            "map": {"sha256": sha256_bytes(map_manifest), "cases": map_count},
            "combined": {"sha256": sha256_bytes(combined_manifest), "cases": 80},
        },
        "sourceRoots": {"photo": str(args.photo_root.resolve()), "ui": str(args.ui_root.resolve()), "mapCohort": str(args.map_cohort.resolve())},
        "imageRoot": str(image_root),
        "copiedRasters": {"photo": photo_count, "ui": ui_count, "map": map_count},
        "copiedRasterBytes": {"photo": photo_bytes, "ui": ui_bytes, "map": map_bytes},
        "copiedPhotoReferenceMasks": {"count": mask_count, "bytes": mask_bytes, "sourceIndexSha256": sha256_bytes(index_raw)},
        "truthPinsUnchanged": immutable_truths,
        "noSourceProducerInputsModified": True,
    }
    write_json(output / "derivation-receipt.json", receipt)
    public_receipt = {
        "scope": receipt["scope"],
        "originalProducerInputs": receipt["originalProducerInputs"],
        "derivedProducerInputs": receipt["derivedProducerInputs"],
        "copiedRasters": receipt["copiedRasters"],
        "copiedRasterBytes": receipt["copiedRasterBytes"],
        "copiedPhotoReferenceMasks": receipt["copiedPhotoReferenceMasks"],
        "truthPinsUnchanged": immutable_truths,
        "noSourceProducerInputsModified": True,
    }
    write_json(output / "public-metadata-receipt.json", public_receipt)
    print(json.dumps(public_receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
