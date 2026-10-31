#!/usr/bin/env python3
"""Metadata-only Open Images planning for H8a fresh DEV photos (no pixels/network)."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from validation import (
    CurateError,
    MAX_BOXES_ROWS,
    MAX_CLASSES_ROWS,
    MAX_IMAGES_ROWS,
    MAX_LABELS_ROWS,
    MAX_MASK_CSV_ROWS,
    MAX_MASK_HEADER_INDEX_BYTES,
    MAX_SINGLE_CSV_BYTES,
    MAX_TOTAL_SOURCE_CSV_BYTES,
    PHOTO_LICENSE,
    CORRECTED_PRIMARY_SHORTLIST_SHA256,
    MASK_HEADER_MAX_DIMENSION,
    METADATA_PROFILE_V3,
    METADATA_PROFILE_V4,
    PRIVATE_MANIFEST_SCHEMA_V2,
    PRIVATE_MANIFEST_SCHEMA_V3,
    PRIVATE_MANIFEST_SCHEMA_V4,
    RESERVE_MANIFEST_SCHEMA_V1,
    RESERVE_MANIFEST_SCHEMA_V2,
    RESERVE_MANIFEST_SCHEMA_V3,
    ATTEMPT_LIST_SCHEMA_V1,
    ATTEMPT_LIST_SCHEMA_V2,
    ATTEMPT_LIST_SCHEMA_V3,
    validate_additive_exclusion_audit_v2,
    validate_additive_exclusion_audit_v3,
    load_private_photo_manifest_file,
    validate_attempt_list,
    validate_reserve_manifest,
    load_mask_header_index_from_bytes,
    normalize_source_group,
    parse_strict_bool01,
    parse_strict_csv_from_bytes,
    parse_strict_decimal,
    path_is_inside_repo,
    read_bounded_file_bytes,
    repo_root_from_here,
    require_audit_source_hash,
    require_external_new_directory,
    require_opaque_case_id,
    require_string,
    resolve_bounded_file,
    resolve_existing_input,
    sha256_bytes,
    open_images_v5_mask_path_matches_row,
    validate_exclusion_audit,
    validate_instance_mask_metadata,
    validate_negative_evidence,
    validate_normalized_box,
    validate_private_photo_manifest,
)

SEED = "mcp-h8a-fresh-dev-20261031-v1"
POSITIVE_QUOTA = 16
NEGATIVE_QUOTA = 4
RESERVE_POSITIVE_QUOTA = 16
RESERVE_NEGATIVE_QUOTA = 4
MAX_ACQUISITION_CANDIDATES = 40
MAX_REJECTION_EXAMPLES = 5
BOX_MATCH_TOLERANCE = 1e-6

TARGET_CLASS_NAMES = {
    "Person",
    "Dog",
    "Cat",
    "Bicycle",
    "Car",
    "Chair",
    "Bottle",
    "Coffee cup",
    "Book",
    "Backpack",
    "Bus",
    "Traffic light",
    "Boat",
    "Bird",
    "Horse",
    "Train",
    "Motorcycle",
    "Flower",
    "Vase",
    "Mobile phone",
    "Laptop",
    "Clock",
    "Suitcase",
    "Bench",
    "Stop sign",
    "Rabbit",
    "Spoon",
    "Camera",
    "Handbag",
    "Ball",
    "Plate",
    "Table",
    "Knife",
    "Tree",
    "Airplane",
    "Truck",
    "Couch",
    "Sunglasses",
    "Hat",
    "Helmet",
    "Umbrella",
    "Bowl",
    "Fork",
    "Teddy bear",
    "Orange",
    "Apple",
    "Banana",
    "Fish",
    "Butterfly",
    "Mug",
}

IMAGES_HEADERS = (
    "ImageID",
    "Subset",
    "OriginalURL",
    "OriginalLandingURL",
    "License",
    "AuthorProfileURL",
    "Author",
    "Title",
    "OriginalSize",
    "OriginalMD5",
    "Thumbnail300KURL",
    "Rotation",
)
CLASSES_HEADERS = ("LabelName", "DisplayName")
BOXES_HEADERS = (
    "ImageID",
    "Source",
    "LabelName",
    "Confidence",
    "XMin",
    "XMax",
    "YMin",
    "YMax",
    "IsOccluded",
    "IsTruncated",
    "IsGroupOf",
    "IsDepiction",
    "IsInside",
)
LABELS_HEADERS = ("ImageID", "Source", "LabelName", "Confidence")
MASK_HEADERS = (
    "MaskPath",
    "ImageID",
    "LabelName",
    "BoxID",
    "BoxXMin",
    "BoxXMax",
    "BoxYMin",
    "BoxYMax",
    "PredictedIoU",
    "Clicks",
)


def deterministic_key(category: str, image_id: str, class_id: str) -> str:
    return sha256_bytes(f"{SEED}/{category}/{image_id}/{class_id}".encode())


def opaque_case_id(image_id: str, class_id: str) -> str:
    return sha256_bytes(f"{SEED}/case-id/{image_id}/{class_id}".encode())[:32]


def note_rejection(
    tally: Counter[str],
    examples: dict[str, list[dict[str, Any]]],
    status: str,
    example: dict[str, Any],
) -> None:
    tally[status] += 1
    bucket = examples.setdefault(status, [])
    if len(bucket) < MAX_REJECTION_EXAMPLES:
        bucket.append(example)


def mask_box_xyxy(row: dict[str, str], *, label: str) -> list[float]:
    return validate_normalized_box(
        [
            float(parse_strict_decimal(row["BoxXMin"], f"{label}.BoxXMin")),
            float(parse_strict_decimal(row["BoxYMin"], f"{label}.BoxYMin")),
            float(parse_strict_decimal(row["BoxXMax"], f"{label}.BoxXMax")),
            float(parse_strict_decimal(row["BoxYMax"], f"{label}.BoxYMax")),
        ],
        label=label,
    )


def boxes_match_within_tolerance(source_xyxy: list[float], mask_xyxy: list[float]) -> bool:
    return all(abs(left - right) <= BOX_MATCH_TOLERANCE for left, right in zip(source_xyxy, mask_xyxy))


def load_openimages_metadata(source_dir: Path, *, exclusion_payload: dict[str, Any] | None = None) -> dict[str, Any]:
    total_bytes = 0
    csv_hashes: dict[str, str] = {}

    def load_one(name: str, headers: tuple[str, ...], max_rows: int) -> list[dict[str, str]]:
        nonlocal total_bytes
        path = resolve_bounded_file(source_dir, name, name)
        raw, digest = read_bounded_file_bytes(path, max_bytes=MAX_SINGLE_CSV_BYTES, label=name)
        total_bytes += len(raw)
        if total_bytes > MAX_TOTAL_SOURCE_CSV_BYTES:
            raise CurateError("Open Images source CSV total byte cap exceeded")
        rows, parsed_digest = parse_strict_csv_from_bytes(raw, headers, name, max_rows=max_rows)
        if parsed_digest != digest:
            raise CurateError(f"{name} hash mismatch during parse")
        csv_hashes[name] = digest
        return rows

    classes_rows = load_one("classes.csv", CLASSES_HEADERS, MAX_CLASSES_ROWS)
    classes: dict[str, str] = {}
    for index, row in enumerate(classes_rows, start=2):
        label_name = row["LabelName"]
        if label_name in classes:
            raise CurateError(f"duplicate LabelName in classes.csv row {index}: {label_name}")
        classes[label_name] = row["DisplayName"]
    wanted = {mid for mid, name in classes.items() if name in TARGET_CLASS_NAMES}

    images_rows = load_one("images.csv", IMAGES_HEADERS, MAX_IMAGES_ROWS)
    if exclusion_payload is not None:
        require_audit_source_hash(
            exclusion_payload,
            basename="images.csv",
            digest=csv_hashes["images.csv"],
            source_dir=source_dir,
        )

    images: dict[str, dict[str, str]] = {}
    for row in images_rows:
        image_id = row["ImageID"]
        if image_id in images:
            raise CurateError(f"duplicate ImageID in images.csv: {image_id}")
        images[image_id] = row

    boxes_rows = load_one("boxes.csv", BOXES_HEADERS, MAX_BOXES_ROWS)
    labels_rows = load_one("labels.csv", LABELS_HEADERS, MAX_LABELS_ROWS)
    return {
        "classes": classes,
        "wantedClassIds": wanted,
        "images": images,
        "boxesRows": boxes_rows,
        "labelsRows": labels_rows,
        "sourceCsvSha256": csv_hashes,
    }


def load_instance_mask_metadata(mask_csv_path: Path) -> tuple[list[dict[str, str]], str]:
    raw, digest = read_bounded_file_bytes(mask_csv_path, max_bytes=MAX_SINGLE_CSV_BYTES, label="mask CSV")
    rows, parsed_digest = parse_strict_csv_from_bytes(raw, MASK_HEADERS, "mask CSV", max_rows=MAX_MASK_CSV_ROWS)
    if parsed_digest != digest:
        raise CurateError("mask CSV hash mismatch during parse")
    for index, row in enumerate(rows, start=2):
        parse_strict_decimal(row["BoxXMin"], f"mask CSV row {index}.BoxXMin")
        parse_strict_decimal(row["BoxXMax"], f"mask CSV row {index}.BoxXMax")
        parse_strict_decimal(row["BoxYMin"], f"mask CSV row {index}.BoxYMin")
        parse_strict_decimal(row["BoxYMax"], f"mask CSV row {index}.BoxYMax")
        require_string(row["BoxID"], f"mask CSV row {index}.BoxID")
        require_string(row["MaskPath"], f"mask CSV row {index}.MaskPath")
    return rows, digest


def build_mask_row_index(mask_rows: list[dict[str, str]]) -> dict[tuple[str, str], list[tuple[int, dict[str, str]]]]:
    index: dict[tuple[str, str], list[tuple[int, dict[str, str]]]] = defaultdict(list)
    for row_number, row in enumerate(mask_rows, start=2):
        key = (row["ImageID"], row["LabelName"])
        index[key].append((row_number, row))
    return index


def build_indexes(metadata: dict[str, Any]) -> dict[str, Any]:
    classes = metadata["classes"]
    wanted = metadata["wantedClassIds"]
    images = metadata["images"]
    eligible_images: dict[str, dict[str, str]] = {}
    for image_id, row in images.items():
        if row["License"] != PHOTO_LICENSE:
            continue
        if row["Rotation"] not in ("", "0", "0.0"):
            continue
        eligible_images[image_id] = row

    target_boxes: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    visible_boxes: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(metadata["boxesRows"], start=2):
        image_id = row["ImageID"]
        if image_id not in eligible_images:
            continue
        class_id = row["LabelName"]
        xyxy = validate_normalized_box(
            [
                float(parse_strict_decimal(row["XMin"], f"boxes.csv row {index}.XMin")),
                float(parse_strict_decimal(row["YMin"], f"boxes.csv row {index}.YMin")),
                float(parse_strict_decimal(row["XMax"], f"boxes.csv row {index}.XMax")),
                float(parse_strict_decimal(row["YMax"], f"boxes.csv row {index}.YMax")),
            ],
            label=f"boxes.csv row {index}",
        )
        box = {
            "classId": class_id,
            "className": classes.get(class_id, class_id),
            "xyxy": xyxy,
            "source": row["Source"],
            "sourceCsvRow": index,
            "sourceBoxDecimals": {
                "XMin": row["XMin"],
                "YMin": row["YMin"],
                "XMax": row["XMax"],
                "YMax": row["YMax"],
            },
            "occluded": parse_strict_bool01(row["IsOccluded"], f"boxes.csv row {index}.IsOccluded"),
            "truncated": parse_strict_bool01(row["IsTruncated"], f"boxes.csv row {index}.IsTruncated"),
            "groupOf": parse_strict_bool01(row["IsGroupOf"], f"boxes.csv row {index}.IsGroupOf"),
            "depiction": parse_strict_bool01(row["IsDepiction"], f"boxes.csv row {index}.IsDepiction"),
            "inside": parse_strict_bool01(row["IsInside"], f"boxes.csv row {index}.IsInside"),
        }
        if class_id in wanted:
            target_boxes[(image_id, class_id)].append(box)
            if box["groupOf"] == 0 and box["depiction"] == 0:
                visible_boxes[(image_id, class_id)].append(box)

    verification_positive: set[tuple[str, str]] = set()
    verification_negative: dict[tuple[str, str], dict[str, Any]] = {}
    verification_contradictions: set[tuple[str, str]] = set()
    for index, row in enumerate(metadata["labelsRows"], start=2):
        image_id = row["ImageID"]
        class_id = row["LabelName"]
        if image_id not in eligible_images or class_id not in wanted:
            continue
        if row["Source"] != "verification":
            continue
        confidence = row["Confidence"]
        key = (image_id, class_id)
        if confidence in ("1", "1.0"):
            if key in verification_negative:
                verification_contradictions.add(key)
            verification_positive.add(key)
        elif confidence == "0":
            if key in verification_positive:
                verification_contradictions.add(key)
            evidence = {
                "type": "explicit-human-verified-image-label",
                "source": row["Source"],
                "confidence": 0,
                "sourceCsvRow": index,
                "sourceFile": "labels.csv",
            }
            validate_negative_evidence(evidence, label=f"labels.csv row {index} negativeEvidence")
            verification_negative[key] = evidence

    for key in verification_contradictions:
        verification_positive.discard(key)
        verification_negative.pop(key, None)

    return {
        "classes": classes,
        "eligibleImages": eligible_images,
        "targetBoxes": target_boxes,
        "visibleBoxes": visible_boxes,
        "verificationPositive": verification_positive,
        "verificationNegative": verification_negative,
        "verificationContradictions": verification_contradictions,
    }


def rights_metadata_ok(row: dict[str, str]) -> bool:
    for field in ("OriginalURL", "OriginalLandingURL", "License", "AuthorProfileURL", "Author", "Title"):
        if not row.get(field, "").strip():
            return False
    return row["License"] == PHOTO_LICENSE


def match_mask_rows(
    visible_box: dict[str, Any],
    mask_candidates: list[tuple[int, dict[str, str]]],
) -> list[tuple[int, dict[str, str], list[float]]]:
    matches: list[tuple[int, dict[str, str], list[float]]] = []
    source_xyxy = visible_box["xyxy"]
    for row_number, row in mask_candidates:
        try:
            mask_xyxy = mask_box_xyxy(row, label=f"mask CSV row {row_number}")
        except CurateError:
            continue
        if boxes_match_within_tolerance(source_xyxy, mask_xyxy):
            matches.append((row_number, row, mask_xyxy))
    return matches


def scan_candidates(
    indexes: dict[str, Any],
    exclusions: dict[str, Any],
    *,
    mask_row_index: dict[tuple[str, str], list[tuple[int, dict[str, str]]]],
    mask_header_entries: dict[str, dict[str, int]],
    require_exact_max_dimension: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Counter[str], dict[str, list[dict[str, Any]]]]:
    eligible_images = indexes["eligibleImages"]
    classes = indexes.get("classes") or {}
    tally: Counter[str] = Counter()
    examples: dict[str, list[dict[str, Any]]] = {}
    positives: list[dict[str, Any]] = []
    negatives: list[dict[str, Any]] = []

    excluded_ids = exclusions["excludedImageIds"]
    excluded_groups = exclusions["excludedSourceGroups"]

    for key in indexes.get("verificationContradictions", ()):
        image_id, class_id = key
        note_rejection(
            tally,
            examples,
            "verification-label-contradiction",
            {"imageId": image_id, "classId": class_id},
        )

    for key in indexes["verificationPositive"]:
        image_id, class_id = key
        meta = eligible_images.get(image_id)
        if meta is None:
            note_rejection(tally, examples, "missing-source-record", {"imageId": image_id, "classId": class_id})
            continue
        group = normalize_source_group(meta["AuthorProfileURL"])
        if image_id in excluded_ids:
            note_rejection(tally, examples, "excluded-image-id", {"imageId": image_id, "classId": class_id})
            continue
        if group in excluded_groups:
            note_rejection(tally, examples, "excluded-author-group", {"imageId": image_id, "authorGroup": group})
            continue
        if not rights_metadata_ok(meta):
            note_rejection(tally, examples, "rights-not-yet-verified", {"imageId": image_id, "classId": class_id})
            continue
        visible = indexes["visibleBoxes"].get(key, [])
        if not visible:
            note_rejection(
                tally,
                examples,
                "missing-valid-visible-box",
                {"imageId": image_id, "classId": class_id},
            )
            continue
        if len(visible) > 1:
            note_rejection(
                tally,
                examples,
                "ambiguous-visible-instance",
                {"imageId": image_id, "classId": class_id, "visibleBoxCount": len(visible)},
            )
            continue
        visible_box = visible[0]
        mask_candidates = mask_row_index.get(key, [])
        if not mask_candidates:
            note_rejection(
                tally,
                examples,
                "missing-instance-mask-row",
                {"imageId": image_id, "classId": class_id},
            )
            continue
        matched = match_mask_rows(visible_box, mask_candidates)
        if not matched:
            note_rejection(
                tally,
                examples,
                "instance-mask-box-mismatch",
                {"imageId": image_id, "classId": class_id},
            )
            continue
        if len(matched) > 1:
            note_rejection(
                tally,
                examples,
                "multiple-instance-mask-rows",
                {"imageId": image_id, "classId": class_id, "matchCount": len(matched)},
            )
            continue
        mask_csv_row, mask_row, _mask_xyxy = matched[0]
        mask_path = mask_row["MaskPath"]
        try:
            open_images_v5_mask_path_matches_row(
                mask_path,
                image_id=image_id,
                label_name=class_id,
                box_id=mask_row["BoxID"],
                label=f"mask CSV row {mask_csv_row}.MaskPath",
            )
        except CurateError:
            note_rejection(
                tally,
                examples,
                "mask-path-metadata-mismatch",
                {
                    "imageId": image_id,
                    "classId": class_id,
                    "maskPath": mask_path,
                    "maskCsvRow": mask_csv_row,
                },
            )
            continue
        header_dims = mask_header_entries.get(mask_path)
        if header_dims is None:
            note_rejection(
                tally,
                examples,
                "missing-mask-header-entry",
                {"imageId": image_id, "classId": class_id, "maskPath": mask_path},
            )
            continue
        header_width = header_dims.get("width")
        header_height = header_dims.get("height")
        if not isinstance(header_width, int) or not isinstance(header_height, int):
            note_rejection(
                tally,
                examples,
                "malformed-mask-header-dimensions",
                {"imageId": image_id, "classId": class_id, "maskPath": mask_path},
            )
            continue
        exceeds_cap = header_width > MASK_HEADER_MAX_DIMENSION or header_height > MASK_HEADER_MAX_DIMENSION
        misses_exact_cap = require_exact_max_dimension and max(header_width, header_height) != MASK_HEADER_MAX_DIMENSION
        if exceeds_cap or misses_exact_cap:
            note_rejection(
                tally,
                examples,
                "mask-header-dimension-exceeds-cap" if exceeds_cap else "mask-header-dimension-not-exact-1024",
                {
                    "imageId": image_id,
                    "classId": class_id,
                    "maskPath": mask_path,
                    "width": header_width,
                    "height": header_height,
                    "maxDimension": MASK_HEADER_MAX_DIMENSION,
                    "requireExactMaxDimension": require_exact_max_dimension,
                },
            )
            continue
        instance_mask_metadata = validate_instance_mask_metadata(
            {
                "boxId": mask_row["BoxID"],
                "maskPath": mask_path,
                "maskCsvRow": mask_csv_row,
                "sourceBoxDecimals": visible_box["sourceBoxDecimals"],
                "pngHeaderDimensions": header_dims,
            },
            label="instanceMaskMetadata",
        )
        positives.append(
            {
                "imageId": image_id,
                "classId": class_id,
                "target": classes.get(class_id, class_id),
                "authorProfileUrl": meta["AuthorProfileURL"],
                "targetBoxes": [visible_box],
                "instanceMaskMetadata": instance_mask_metadata,
                "sourceMetadata": {
                    "originalUrl": meta["OriginalURL"],
                    "originalLandingUrl": meta["OriginalLandingURL"],
                    "licenseUrl": meta["License"],
                    "author": meta["Author"],
                    "title": meta["Title"],
                },
                "sortKey": deterministic_key("positive", image_id, class_id),
            }
        )

    for key, evidence in indexes["verificationNegative"].items():
        image_id, class_id = key
        meta = eligible_images.get(image_id)
        if meta is None:
            note_rejection(tally, examples, "missing-source-record", {"imageId": image_id, "classId": class_id})
            continue
        group = normalize_source_group(meta["AuthorProfileURL"])
        if image_id in excluded_ids:
            note_rejection(tally, examples, "excluded-image-id", {"imageId": image_id, "classId": class_id})
            continue
        if group in excluded_groups:
            note_rejection(tally, examples, "excluded-author-group", {"imageId": image_id, "authorGroup": group})
            continue
        if not rights_metadata_ok(meta):
            note_rejection(tally, examples, "rights-not-yet-verified", {"imageId": image_id, "classId": class_id})
            continue
        if indexes["targetBoxes"].get(key):
            note_rejection(
                tally,
                examples,
                "negative-conflicts-with-box",
                {"imageId": image_id, "classId": class_id},
            )
            continue
        negatives.append(
            {
                "imageId": image_id,
                "classId": class_id,
                "target": classes.get(class_id, class_id),
                "authorProfileUrl": meta["AuthorProfileURL"],
                "negativeEvidence": evidence,
                "sourceMetadata": {
                    "originalUrl": meta["OriginalURL"],
                    "originalLandingUrl": meta["OriginalLandingURL"],
                    "licenseUrl": meta["License"],
                    "author": meta["Author"],
                    "title": meta["Title"],
                },
                "sortKey": deterministic_key("negative", image_id, class_id),
            }
        )

    positives.sort(key=lambda item: item["sortKey"])
    negatives.sort(key=lambda item: item["sortKey"])
    return positives, negatives, tally, examples


def select_shortlist(
    positives: list[dict[str, Any]],
    negatives: list[dict[str, Any]],
    tally: Counter[str],
    examples: dict[str, list[dict[str, Any]]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected: list[dict[str, Any]] = []
    used_images: set[str] = set()
    used_groups: set[str] = set()

    def admit(category: str, quota: int, pool: list[dict[str, Any]]) -> list[dict[str, Any]]:
        chosen: list[dict[str, Any]] = []
        for candidate in pool:
            image_id = candidate["imageId"]
            group = normalize_source_group(candidate["authorProfileUrl"])
            if image_id in used_images:
                note_rejection(
                    tally,
                    examples,
                    "duplicate-image-id",
                    {"imageId": image_id, "classId": candidate["classId"], "phase": category},
                )
                continue
            if group in used_groups:
                note_rejection(
                    tally,
                    examples,
                    "duplicate-author-group",
                    {"imageId": image_id, "authorGroup": group, "phase": category},
                )
                continue
            chosen.append(candidate)
            used_images.add(image_id)
            used_groups.add(group)
            if len(chosen) == quota:
                break
        if len(chosen) < quota:
            raise CurateError(
                f"insufficient {category} candidates after deduplication: need {quota}, selected {len(chosen)}"
            )
        return chosen

    selected.extend(admit("positive", POSITIVE_QUOTA, positives))
    selected.extend(admit("negative", NEGATIVE_QUOTA, negatives))
    return selected[:POSITIVE_QUOTA], selected[POSITIVE_QUOTA:]


def select_reserves(
    positives: list[dict[str, Any]],
    negatives: list[dict[str, Any]],
    tally: Counter[str],
    examples: dict[str, list[dict[str, Any]]],
    *,
    used_images: set[str],
    used_groups: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    used_images = set(used_images)
    used_groups = set(used_groups)

    def admit(category: str, quota: int, pool: list[dict[str, Any]]) -> list[dict[str, Any]]:
        chosen: list[dict[str, Any]] = []
        for candidate in pool:
            image_id = candidate["imageId"]
            group = normalize_source_group(candidate["authorProfileUrl"])
            if image_id in used_images:
                note_rejection(
                    tally,
                    examples,
                    "duplicate-image-id",
                    {"imageId": image_id, "classId": candidate["classId"], "phase": f"reserve-{category}"},
                )
                continue
            if group in used_groups:
                note_rejection(
                    tally,
                    examples,
                    "duplicate-author-group",
                    {"imageId": image_id, "authorGroup": group, "phase": f"reserve-{category}"},
                )
                continue
            chosen.append(candidate)
            used_images.add(image_id)
            used_groups.add(group)
            if len(chosen) == quota:
                break
        return chosen

    return (
        admit("positive", RESERVE_POSITIVE_QUOTA, positives),
        admit("negative", RESERVE_NEGATIVE_QUOTA, negatives),
    )


def primary_usage_from_manifest(rows: list[dict[str, Any]]) -> tuple[set[str], set[str]]:
    used_images = {require_string(row["imageId"], "imageId") for row in rows}
    used_groups = {normalize_source_group(require_string(row["authorProfileUrl"], "authorProfileUrl")) for row in rows}
    return used_images, used_groups


def build_attempt_list_rows(
    primary_rows: list[dict[str, Any]],
    reserve_rows: list[dict[str, Any]],
    *,
    primary_shortlist_sha256: str,
    reserve_commit_sha256: str,
    attempt_schema_version: str = ATTEMPT_LIST_SCHEMA_V1,
    metadata_profile: str | None = None,
) -> list[dict[str, Any]]:
    def to_attempt(row: dict[str, Any], phase: str) -> dict[str, Any]:
        return {
            "phase": phase,
            "expectedPresence": require_string(row["expectedPresence"], "expectedPresence"),
            "caseId": require_opaque_case_id(row["caseId"], "caseId"),
            "imageId": require_string(row["imageId"], "imageId"),
            "targetClassId": require_string(row["targetClassId"], "targetClassId"),
            "target": require_string(row["target"], "target"),
            "selectionKey": require_string(row["selectionKey"], "selectionKey"),
        }

    primary_pos = [row for row in primary_rows if row["expectedPresence"] == "present"]
    primary_neg = [row for row in primary_rows if row["expectedPresence"] == "absent"]
    reserve_pos = [row for row in reserve_rows if row["expectedPresence"] == "present"]
    reserve_neg = [row for row in reserve_rows if row["expectedPresence"] == "absent"]
    attempts: list[dict[str, Any]] = []
    for row in primary_pos:
        attempts.append(to_attempt(row, "primary"))
    for row in primary_neg:
        attempts.append(to_attempt(row, "primary"))
    for row in reserve_pos:
        attempts.append(to_attempt(row, "reserve"))
    for row in reserve_neg:
        attempts.append(to_attempt(row, "reserve"))
    if len(attempts) > MAX_ACQUISITION_CANDIDATES:
        raise CurateError(f"attempt list exceeds cap ({len(attempts)} > {MAX_ACQUISITION_CANDIDATES})")
    attempt_doc: dict[str, Any] = {
        "schemaVersion": attempt_schema_version,
        "selectionSeed": SEED,
        "primaryShortlistSha256": primary_shortlist_sha256,
        "reserveCommitSha256": reserve_commit_sha256,
        "attempts": attempts,
    }
    if attempt_schema_version in (ATTEMPT_LIST_SCHEMA_V2, ATTEMPT_LIST_SCHEMA_V3):
        expected_profile = METADATA_PROFILE_V3 if attempt_schema_version == ATTEMPT_LIST_SCHEMA_V2 else METADATA_PROFILE_V4
        if metadata_profile != expected_profile:
            raise CurateError("attempt list metadataProfile mismatch")
        attempt_doc["metadataProfile"] = metadata_profile
    validate_attempt_list(attempt_doc)
    return attempts


def build_private_rows(
    positives: list[dict[str, Any]],
    negatives: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for candidate in positives:
        rows.append(
            {
                "caseId": opaque_case_id(candidate["imageId"], candidate["classId"]),
                "expectedPresence": "present",
                "imageId": candidate["imageId"],
                "targetClassId": candidate["classId"],
                "target": candidate["target"],
                "authorProfileUrl": candidate["authorProfileUrl"],
                "targetBoxes": candidate["targetBoxes"],
                "instanceMaskMetadata": candidate["instanceMaskMetadata"],
                "negativeEvidence": None,
                "rightsReviewStatus": "pending",
                "datasetLicenseMetadata": {
                    "note": "Open Images annotation license metadata only; not per-photo ownership proof",
                    "licenseUrl": candidate["sourceMetadata"]["licenseUrl"],
                },
                "sourceUrls": candidate["sourceMetadata"],
                "selectionKey": candidate["sortKey"],
            }
        )
    for candidate in negatives:
        rows.append(
            {
                "caseId": opaque_case_id(candidate["imageId"], candidate["classId"]),
                "expectedPresence": "absent",
                "imageId": candidate["imageId"],
                "targetClassId": candidate["classId"],
                "target": candidate["target"],
                "authorProfileUrl": candidate["authorProfileUrl"],
                "targetBoxes": [],
                "negativeEvidence": candidate["negativeEvidence"],
                "rightsReviewStatus": "pending",
                "datasetLicenseMetadata": {
                    "note": "Open Images annotation license metadata only; not per-photo ownership proof",
                    "licenseUrl": candidate["sourceMetadata"]["licenseUrl"],
                },
                "sourceUrls": candidate["sourceMetadata"],
                "selectionKey": candidate["sortKey"],
            }
        )
    return rows


def write_blocked_audit(
    output_dir: Path,
    *,
    tally: Counter[str],
    examples: dict[str, list[dict[str, Any]]],
    eligible_positive: int,
    eligible_negative: int,
    source_hashes: dict[str, str],
    mask_csv_sha256: str,
    mask_header_index_sha256: str,
    exclusion_audit_sha256: str,
    exclusion_counts: dict[str, int],
    eligible_image_rows: int,
) -> None:
    payload = {
        "schemaVersion": 1,
        "status": "blocked-insufficient-quota",
        "selectionSeed": SEED,
        "eligibleMaskMetadataPositiveCandidates": eligible_positive,
        "eligibleNegativeCandidates": eligible_negative,
        "requiredQuotas": {"positive": POSITIVE_QUOTA, "negative": NEGATIVE_QUOTA},
        "exclusionAuditSha256": exclusion_audit_sha256,
        "exclusionCounts": exclusion_counts,
        "eligibleImageRows": eligible_image_rows,
        "sourceCsvSha256": source_hashes,
        "maskCsvSha256": mask_csv_sha256,
        "maskHeaderIndexSha256": mask_header_index_sha256,
        "rejectionTally": dict(sorted(tally.items())),
        "rejectionExamples": examples,
        "note": "Actual source JPEG canvas verification remains pending pixel acquisition",
    }
    (output_dir / "metadata-plan-audit.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def cmd_commit_reserves(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    exclusions = validate_exclusion_audit(exclusion_path)
    if args.require_corrected_primary:
        args.primary_shortlist_sha256 = CORRECTED_PRIMARY_SHORTLIST_SHA256
    return _run_commit_reserves(
        args,
        exclusions=exclusions,
        reserve_schema=RESERVE_MANIFEST_SCHEMA_V1,
    )


def cmd_commit_reserves_v3(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    expected_sha = require_string(args.expected_exclusion_audit_sha256, "expected exclusion audit sha256")
    exclusions = validate_additive_exclusion_audit_v2(exclusion_path, expected_sha256=expected_sha)
    return _run_commit_reserves(
        args,
        exclusions=exclusions,
        reserve_schema=RESERVE_MANIFEST_SCHEMA_V2,
        metadata_profile=METADATA_PROFILE_V3,
    )


def cmd_commit_reserves_v4(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    expected_sha = require_string(args.expected_exclusion_audit_sha256, "expected exclusion audit sha256")
    exclusions = validate_additive_exclusion_audit_v3(exclusion_path, expected_sha256=expected_sha)
    return _run_commit_reserves(
        args,
        exclusions=exclusions,
        reserve_schema=RESERVE_MANIFEST_SCHEMA_V3,
        metadata_profile=METADATA_PROFILE_V4,
        require_exact_max_dimension=True,
    )


def _run_plan(
    args: argparse.Namespace,
    *,
    exclusions: dict[str, Any],
    private_schema: str,
    summary_status: str,
    metadata_profile: str | None = None,
    require_exact_max_dimension: bool = False,
) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    source_dir = Path(args.source_dir).resolve()
    if path_is_inside_repo(source_dir, repo_root):
        source_dir = source_dir.resolve()
    for name in ("classes.csv", "images.csv", "boxes.csv", "labels.csv"):
        resolve_bounded_file(source_dir, name, name)
    mask_csv_path = resolve_existing_input(Path(args.mask_csv), repo_root, "mask CSV")
    mask_header_path = resolve_existing_input(Path(args.mask_header_index), repo_root, "mask header index")
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    exclusion_audit_sha256 = exclusions["auditSha256"]

    mask_rows, mask_csv_sha256 = load_instance_mask_metadata(mask_csv_path)
    mask_header_raw, _header_size_digest = read_bounded_file_bytes(
        mask_header_path,
        max_bytes=MAX_MASK_HEADER_INDEX_BYTES,
        label="mask header index",
    )
    mask_header_entries, mask_header_index_sha256 = load_mask_header_index_from_bytes(
        mask_header_raw,
        mask_csv_sha256=mask_csv_sha256,
    )
    if mask_header_index_sha256 != sha256_bytes(mask_header_raw):
        raise CurateError("mask header index hash mismatch during parse")

    metadata = load_openimages_metadata(source_dir, exclusion_payload=exclusions["payload"])
    mask_row_index = build_mask_row_index(mask_rows)
    indexes = build_indexes(metadata)
    positives, negatives, tally, examples = scan_candidates(
        indexes,
        exclusions,
        mask_row_index=mask_row_index,
        mask_header_entries=mask_header_entries,
        require_exact_max_dimension=require_exact_max_dimension,
    )

    output_dir.mkdir(parents=True, exist_ok=False)

    if len(positives) < POSITIVE_QUOTA or len(negatives) < NEGATIVE_QUOTA:
        write_blocked_audit(
            output_dir,
            tally=tally,
            examples=examples,
            eligible_positive=len(positives),
            eligible_negative=len(negatives),
            source_hashes=metadata["sourceCsvSha256"],
            mask_csv_sha256=mask_csv_sha256,
            mask_header_index_sha256=mask_header_index_sha256,
            exclusion_audit_sha256=exclusion_audit_sha256,
            exclusion_counts=exclusions["counts"],
            eligible_image_rows=len(indexes["eligibleImages"]),
        )
        return 1

    try:
        selected_pos, selected_neg = select_shortlist(positives, negatives, tally, examples)
    except CurateError:
        write_blocked_audit(
            output_dir,
            tally=tally,
            examples=examples,
            eligible_positive=len(positives),
            eligible_negative=len(negatives),
            source_hashes=metadata["sourceCsvSha256"],
            mask_csv_sha256=mask_csv_sha256,
            mask_header_index_sha256=mask_header_index_sha256,
            exclusion_audit_sha256=exclusion_audit_sha256,
            exclusion_counts=exclusions["counts"],
            eligible_image_rows=len(indexes["eligibleImages"]),
        )
        return 1

    private_rows = build_private_rows(selected_pos, selected_neg)
    private_manifest: dict[str, Any] = {
        "schemaVersion": private_schema,
        "selectionSeed": SEED,
        "status": "metadata-only-private-curator-plan",
        "disclaimer": "Private curator planning artifact; not a producer manifest and not a rights clearance",
        "quotas": {"positive": POSITIVE_QUOTA, "negative": NEGATIVE_QUOTA},
        "rows": private_rows,
    }
    if metadata_profile is not None:
        private_manifest["metadataProfile"] = metadata_profile
    validate_private_photo_manifest(private_manifest)
    summary = {
        "schemaVersion": {
            PRIVATE_MANIFEST_SCHEMA_V2: 2,
            PRIVATE_MANIFEST_SCHEMA_V3: 3,
            PRIVATE_MANIFEST_SCHEMA_V4: 4,
        }[private_schema],
        "status": summary_status,
        "selectionSeed": SEED,
        "exclusionAuditSha256": exclusion_audit_sha256,
        "exclusionCounts": exclusions["counts"],
        "eligibleImageRows": len(indexes["eligibleImages"]),
        "scannedMaskMetadataPositiveCandidates": len(positives),
        "scannedNegativeCandidates": len(negatives),
        "selectedPositive": len(selected_pos),
        "selectedNegative": len(selected_neg),
        "sourceCsvSha256": metadata["sourceCsvSha256"],
        "maskCsvSha256": mask_csv_sha256,
        "maskHeaderIndexSha256": mask_header_index_sha256,
        "coordinateConvention": (
            "Open Images normalized source XYXY values as represented in boxes.csv; "
            "continuous rectangle area for box IoU without +1; raster mask extents use half-open pixel bounds; "
            "source JPEG canvas equality remains pending pixel acquisition"
        ),
        "rejectionTally": dict(sorted(tally.items())),
        "rejectionExamples": examples,
    }
    if metadata_profile is not None:
        summary["metadataProfile"] = metadata_profile
    (output_dir / "photo-shortlist-private.json").write_text(
        json.dumps(private_manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (output_dir / "metadata-plan-summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    exclusions = validate_exclusion_audit(exclusion_path)
    return _run_plan(
        args,
        exclusions=exclusions,
        private_schema=PRIVATE_MANIFEST_SCHEMA_V2,
        summary_status="metadata-only-photo-plan-v2-pending-jpeg-canvas",
    )


def cmd_plan_v3(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    expected_sha = require_string(args.expected_exclusion_audit_sha256, "expected exclusion audit sha256")
    exclusions = validate_additive_exclusion_audit_v2(exclusion_path, expected_sha256=expected_sha)
    return _run_plan(
        args,
        exclusions=exclusions,
        private_schema=PRIVATE_MANIFEST_SCHEMA_V3,
        summary_status="metadata-only-photo-plan-v3-pending-jpeg-canvas",
        metadata_profile=METADATA_PROFILE_V3,
    )


def cmd_plan_v4(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    expected_sha = require_string(args.expected_exclusion_audit_sha256, "expected exclusion audit sha256")
    exclusions = validate_additive_exclusion_audit_v3(exclusion_path, expected_sha256=expected_sha)
    return _run_plan(
        args,
        exclusions=exclusions,
        private_schema=PRIVATE_MANIFEST_SCHEMA_V4,
        summary_status="metadata-only-photo-plan-v4-exact1024-pending-jpeg-canvas",
        metadata_profile=METADATA_PROFILE_V4,
        require_exact_max_dimension=True,
    )


def _run_commit_reserves(
    args: argparse.Namespace,
    *,
    exclusions: dict[str, Any],
    reserve_schema: str,
    metadata_profile: str | None = None,
    require_exact_max_dimension: bool = False,
) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    source_dir = Path(args.source_dir).resolve()
    for name in ("classes.csv", "images.csv", "boxes.csv", "labels.csv"):
        resolve_bounded_file(source_dir, name, name)
    mask_csv_path = resolve_existing_input(Path(args.mask_csv), repo_root, "mask CSV")
    mask_header_path = resolve_existing_input(Path(args.mask_header_index), repo_root, "mask header index")
    primary_path = resolve_existing_input(Path(args.primary_manifest), repo_root, "primary manifest")
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    expected_primary_sha = getattr(args, "primary_shortlist_sha256", None)
    if expected_primary_sha is not None:
        expected_primary_sha = require_string(expected_primary_sha, "primary shortlist sha256")
    primary_manifest = load_private_photo_manifest_file(
        primary_path,
        expected_sha256=expected_primary_sha,
    )
    primary_rows = primary_manifest["rows"]
    if len(primary_rows) != POSITIVE_QUOTA + NEGATIVE_QUOTA:
        raise CurateError("primary manifest row count mismatch")
    used_images, used_groups = primary_usage_from_manifest(primary_rows)

    mask_rows, mask_csv_sha256 = load_instance_mask_metadata(mask_csv_path)
    mask_header_raw, _header_size_digest = read_bounded_file_bytes(
        mask_header_path,
        max_bytes=MAX_MASK_HEADER_INDEX_BYTES,
        label="mask header index",
    )
    mask_header_entries, mask_header_index_sha256 = load_mask_header_index_from_bytes(
        mask_header_raw,
        mask_csv_sha256=mask_csv_sha256,
    )
    metadata = load_openimages_metadata(source_dir, exclusion_payload=exclusions["payload"])
    indexes = build_indexes(metadata)
    positives, negatives, tally, examples = scan_candidates(
        indexes,
        exclusions,
        mask_row_index=build_mask_row_index(mask_rows),
        mask_header_entries=mask_header_entries,
        require_exact_max_dimension=require_exact_max_dimension,
    )
    selected_pos, selected_neg = select_reserves(
        positives,
        negatives,
        tally,
        examples,
        used_images=used_images,
        used_groups=used_groups,
    )
    if len(selected_pos) < RESERVE_POSITIVE_QUOTA or len(selected_neg) < RESERVE_NEGATIVE_QUOTA:
        raise CurateError("insufficient reserve candidates after deduplication")
    reserve_rows = build_private_rows(selected_pos, selected_neg)
    reserve_manifest: dict[str, Any] = {
        "schemaVersion": reserve_schema,
        "selectionSeed": SEED,
        "status": "metadata-only-reserve-commit",
        "primaryShortlistSha256": primary_manifest["_sha256"],
        "quotas": {"positive": RESERVE_POSITIVE_QUOTA, "negative": RESERVE_NEGATIVE_QUOTA},
        "selectedPositive": len(selected_pos),
        "selectedNegative": len(selected_neg),
        "rows": reserve_rows,
    }
    if metadata_profile is not None:
        reserve_manifest["metadataProfile"] = metadata_profile
    validate_reserve_manifest(reserve_manifest, primary_shortlist_sha256=primary_manifest["_sha256"])
    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / "photo-reserve-commit-private.json").write_text(
        json.dumps(reserve_manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    summary = {
        "schemaVersion": 1,
        "status": "metadata-only-reserve-commit",
        "selectionSeed": SEED,
        "primaryShortlistSha256": primary_manifest["_sha256"],
        "selectedPositive": len(selected_pos),
        "selectedNegative": len(selected_neg),
        "sourceCsvSha256": metadata["sourceCsvSha256"],
        "maskCsvSha256": mask_csv_sha256,
        "maskHeaderIndexSha256": mask_header_index_sha256,
        "rejectionTally": dict(sorted(tally.items())),
        "rejectionExamples": examples,
    }
    if metadata_profile is not None:
        summary["metadataProfile"] = metadata_profile
    (output_dir / "metadata-reserve-commit-summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="H8a fresh DEV metadata-only curator")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="metadata-only Open Images photo shortlist")
    plan.add_argument("--source-dir", required=True, help="directory containing official Open Images CSV files")
    plan.add_argument("--mask-csv", required=True, help="official Open Images V5 validation instance-mask CSV")
    plan.add_argument(
        "--mask-header-index",
        required=True,
        help="PNG IHDR header index JSON bound to the mask CSV SHA-256",
    )
    plan.add_argument("--exclusion-audit", required=True, help="pinned prior-source-exclusions.json")
    plan.add_argument("--output-dir", required=True, help="new external output directory")
    plan.set_defaults(func=cmd_plan)
    plan_v3 = sub.add_parser("plan-v3", help="metadata-only Open Images photo shortlist v3")
    plan_v3.add_argument("--source-dir", required=True)
    plan_v3.add_argument("--mask-csv", required=True)
    plan_v3.add_argument("--mask-header-index", required=True)
    plan_v3.add_argument("--exclusion-audit", required=True)
    plan_v3.add_argument("--expected-exclusion-audit-sha256", required=True)
    plan_v3.add_argument("--output-dir", required=True)
    plan_v3.set_defaults(func=cmd_plan_v3)
    reserves = sub.add_parser("commit-reserves", help="freeze deterministic reserve shortlist")
    reserves.add_argument("--source-dir", required=True)
    reserves.add_argument("--mask-csv", required=True)
    reserves.add_argument("--mask-header-index", required=True)
    reserves.add_argument("--exclusion-audit", required=True)
    reserves.add_argument("--primary-manifest", required=True)
    reserves.add_argument("--output-dir", required=True)
    reserves.add_argument("--primary-shortlist-sha256", default=None)
    reserves.add_argument(
        "--require-corrected-primary",
        action="store_true",
        default=False,
    )
    reserves.set_defaults(func=cmd_commit_reserves)
    reserves_v3 = sub.add_parser("commit-reserves-v3", help="freeze deterministic reserve shortlist v3")
    reserves_v3.add_argument("--source-dir", required=True)
    reserves_v3.add_argument("--mask-csv", required=True)
    reserves_v3.add_argument("--mask-header-index", required=True)
    reserves_v3.add_argument("--exclusion-audit", required=True)
    reserves_v3.add_argument("--expected-exclusion-audit-sha256", required=True)
    reserves_v3.add_argument("--primary-manifest", required=True)
    reserves_v3.add_argument("--primary-shortlist-sha256", required=True)
    reserves_v3.add_argument("--output-dir", required=True)
    reserves_v3.set_defaults(func=cmd_commit_reserves_v3)
    plan_v4 = sub.add_parser("plan-v4", help="metadata-only Open Images photo shortlist v4 exact 1024")
    plan_v4.add_argument("--source-dir", required=True)
    plan_v4.add_argument("--mask-csv", required=True)
    plan_v4.add_argument("--mask-header-index", required=True)
    plan_v4.add_argument("--exclusion-audit", required=True)
    plan_v4.add_argument("--expected-exclusion-audit-sha256", required=True)
    plan_v4.add_argument("--output-dir", required=True)
    plan_v4.set_defaults(func=cmd_plan_v4)
    reserves_v4 = sub.add_parser("commit-reserves-v4", help="freeze deterministic exact-1024 reserves v4")
    reserves_v4.add_argument("--source-dir", required=True)
    reserves_v4.add_argument("--mask-csv", required=True)
    reserves_v4.add_argument("--mask-header-index", required=True)
    reserves_v4.add_argument("--exclusion-audit", required=True)
    reserves_v4.add_argument("--expected-exclusion-audit-sha256", required=True)
    reserves_v4.add_argument("--primary-manifest", required=True)
    reserves_v4.add_argument("--primary-shortlist-sha256", required=True)
    reserves_v4.add_argument("--output-dir", required=True)
    reserves_v4.set_defaults(func=cmd_commit_reserves_v4)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except CurateError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    raise SystemExit(main())
