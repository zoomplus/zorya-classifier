#!/usr/bin/env python3
"""Freeze a disjoint H8a photo cohort without fetching candidate image pixels."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import curate
import validation
from imaging import MAX_JPEG_BYTES, perceptual_hash64_from_jpeg, runtime_pillow_version, sha256_bytes

SELECTION_SEED = "h8a-independent-dev40-20261101-r1"
OLD_V3_AUDIT_SHA256 = "4232f8d08bb885435724d6765afeefe79ef6ee0c1f85804881b0c936718a39c7"
OLD_V4_COMPLETE_INDEX_SHA256 = "a0443bdb22e4d9952460415c5eff91d9f4db55fbce4248af0050be9f4ce36ec8"
V4_REVIEW_SHA256 = "3163edb02fdac46667a3adb46d7c4926e1e0cfa1e05281ec784d88c68159a251"
DISJOINT_AUDIT_SCHEMA = "h8a-fresh-dev-disjoint-photo-exclusion-v1"
DISJOINT_AUDIT_STATUS = "frozen-prior-exclusions-and-v4-retained-images"


def read_json(path: Path, *, maximum: int = 32 * 1024 * 1024) -> tuple[dict[str, Any], str]:
    raw, digest = validation.read_bounded_file_bytes(path, max_bytes=maximum, label=path.name)
    payload = validation.require_json_object(
        validation.loads_strict_json(raw.decode("utf-8"), label=path.name), path.name
    )
    return payload, digest


def write_json(path: Path, payload: dict[str, Any]) -> str:
    raw = (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    path.write_bytes(raw)
    return sha256_bytes(raw)


def pin(label: str, path: Path, expected_sha256: str | None = None) -> dict[str, str]:
    raw, digest = validation.read_bounded_file_bytes(
        path, max_bytes=validation.MAX_EXCLUSION_AUDIT_BYTES, label=label
    )
    if expected_sha256 is not None and digest != expected_sha256:
        raise validation.CurateError(f"{label} SHA-256 mismatch")
    return {"label": label, "path": str(path.resolve()), "sha256": digest}


def load_manifest(path: Path, *, reserve: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    payload, digest = read_json(path, maximum=validation.MAX_PRIVATE_MANIFEST_BYTES)
    rows = (
        validation.validate_reserve_manifest(payload)
        if reserve
        else validation.validate_private_photo_manifest(payload)
    )
    return payload, rows, digest


def _case_rows(paths: list[Path]) -> tuple[set[str], set[str], set[str]]:
    case_ids: set[str] = set()
    image_ids: set[str] = set()
    author_groups: set[str] = set()
    for path in paths:
        if not path.is_file():
            continue
        payload, _ = read_json(path, maximum=validation.MAX_PRIVATE_MANIFEST_BYTES)
        if "attempts" in payload:
            for index, row_value in enumerate(validation.validate_attempt_list(payload)):
                row = validation.require_json_object(row_value, f"{path.name}.attempts[{index}]")
                case_ids.add(validation.require_opaque_case_id(row.get("caseId"), "attempt.caseId"))
                image_ids.add(validation.require_string(row.get("imageId"), "attempt.imageId"))
        elif "rows" in payload:
            rows = payload["rows"]
            if not isinstance(rows, list):
                raise validation.CurateError(f"{path.name}.rows must be an array")
            for index, row_value in enumerate(rows):
                row = validation.require_json_object(row_value, f"{path.name}.rows[{index}]")
                case_ids.add(validation.require_string(row.get("caseId"), "manifest.caseId"))
                image_ids.add(validation.require_string(row["imageId"], "manifest.imageId"))
                author_groups.add(
                    validation.normalize_source_group(
                        validation.require_string(row["authorProfileUrl"], "manifest.authorProfileUrl")
                    )
                )
    return case_ids, image_ids, author_groups


def build_history(
    *,
    old_audit_path: Path,
    old_index_path: Path,
    v4_primary_path: Path,
    v4_reserve_path: Path,
    v4_attempt_path: Path,
    v4_report_path: Path,
    v4_receipts_path: Path,
    v4_acquisition_dir: Path,
    split_path: Path,
    output_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    old_view = validation.validate_additive_exclusion_audit_v3(
        old_audit_path, expected_sha256=OLD_V3_AUDIT_SHA256
    )
    prior_index_raw, prior_index_sha = validation.read_bounded_file_bytes(
        old_index_path, max_bytes=validation.MAX_FINGERPRINT_INDEX_BYTES, label="prior fingerprint index"
    )
    prior_index = validation.validate_fingerprint_index(
        validation.require_json_object(
            validation.loads_strict_json(prior_index_raw.decode("utf-8"), label="prior fingerprint index"),
            "prior fingerprint index",
        ),
        require_runtime_pillow_match=False,
    )
    if prior_index_sha != OLD_V4_COMPLETE_INDEX_SHA256:
        raise validation.CurateError("historical v4 complete fingerprint index SHA-256 mismatch")
    if prior_index["pillowVersion"] != runtime_pillow_version():
        raise validation.CurateError("historical fingerprint Pillow runtime does not match pinned version")
    validation.validate_fingerprint_index_exclusion_coverage(
        prior_index,
        exclusion_audit_sha256=old_view["auditSha256"],
        excluded_encoded_sha256=old_view["excludedImageSha256"],
    )
    primary_payload, primary_rows, primary_sha = load_manifest(v4_primary_path)
    reserve_payload, reserve_rows, reserve_sha = load_manifest(v4_reserve_path, reserve=True)
    if reserve_payload.get("primaryShortlistSha256") != primary_sha:
        raise validation.CurateError("historical v4 reserve is not bound to primary shortlist")
    attempt_payload, attempt_sha = read_json(v4_attempt_path, maximum=validation.MAX_ATTEMPT_LIST_BYTES)
    attempts = validation.validate_attempt_list(attempt_payload)
    if attempt_payload.get("primaryShortlistSha256") != primary_sha:
        raise validation.CurateError("historical v4 attempts are not bound to primary shortlist")
    if attempt_payload.get("reserveCommitSha256") != reserve_sha:
        raise validation.CurateError("historical v4 attempts are not bound to reserve commit")
    report, report_sha = read_json(v4_report_path, maximum=8 * 1024 * 1024)
    receipts, receipts_sha = read_json(v4_receipts_path, maximum=16 * 1024 * 1024)
    if report.get("status") != "complete" or report.get("attemptCount") != 40:
        raise validation.CurateError("historical v4 acquisition was not a complete 40-slot run")
    if report.get("admitted") != {"present": 16, "absent": 4}:
        raise validation.CurateError("historical v4 admission counts mismatch")
    if not isinstance(receipts.get("attempts"), list):
        raise validation.CurateError("historical v4 receipts are missing attempts")
    try:
        review_raw = (v4_report_path.parent.parent / "main-v4-photo-acquisition-review.json").read_bytes()
        review = validation.require_json_object(
            validation.loads_strict_json(review_raw.decode("utf-8"), label="v4 acquisition review"),
            "v4 acquisition review",
        )
    except OSError as error:
        raise validation.CurateError("historical v4 review receipt is missing") from error
    if sha256_bytes(review_raw) != V4_REVIEW_SHA256:
        raise validation.CurateError("historical v4 review receipt SHA-256 mismatch")
    if review.get("reportSha256") != report_sha or review.get("privateReceiptsSha256") != receipts_sha:
        raise validation.CurateError("historical v4 acquisition report/receipt pins mismatch")

    source_root = v4_acquisition_dir.resolve(strict=True)
    if v4_acquisition_dir.is_symlink():
        raise validation.CurateError("historical v4 acquisition directory must not be a symlink")
    records = report.get("records")
    if not isinstance(records, list):
        raise validation.CurateError("historical v4 report records are malformed")
    report_paths: dict[str, dict[str, Any]] = {}
    for index, record_value in enumerate(records):
        record = validation.require_json_object(record_value, f"v4 report.records[{index}]")
        rel = validation.require_string(record.get("imageRelPath"), "v4 report imageRelPath")
        encoded = validation.require_sha256_hex(record.get("encodedSha256"), "v4 report encodedSha256")
        if rel in report_paths:
            raise validation.CurateError("historical v4 report repeats image path")
        report_paths[rel] = {**record, "encodedSha256": encoded}

    jpeg_paths = sorted(source_root.glob("images/*.jpg"))
    if len(jpeg_paths) != len(report_paths):
        raise validation.CurateError("historical v4 retained JPEG file count differs from report")
    retained: list[dict[str, Any]] = []
    for path in jpeg_paths:
        relative = path.relative_to(source_root).as_posix()
        expected = report_paths.get(relative)
        if expected is None:
            raise validation.CurateError("historical v4 contains an unreceipted retained JPEG")
        jpeg, digest = validation.read_bounded_file_bytes(path, max_bytes=MAX_JPEG_BYTES, label="v4 JPEG")
        if digest != expected["encodedSha256"]:
            raise validation.CurateError("historical v4 retained JPEG SHA-256 differs from report")
        phash_value, decoded, width, height = perceptual_hash64_from_jpeg(jpeg)
        phash = f"{phash_value:016x}"
        if expected.get("decodedRgbSha256") != decoded or expected.get("perceptualHash64") != phash:
            raise validation.CurateError("historical v4 decoded/pHash differs from pinned acquisition report")
        retained.append(
            {
                "encodedSha256": digest,
                "decodedRgbSha256": decoded,
                "perceptualHash64": phash,
                "source": "retained-v4-acquisition-jpeg",
                "sourcePath": str(path.resolve()),
                "width": width,
                "height": height,
            }
        )

    prior_entries = [dict(row) for row in prior_index["entries"]]
    known_encoded = {row["encodedSha256"] for row in prior_entries}
    for row in retained:
        if row["encodedSha256"] in known_encoded:
            raise validation.CurateError("historical v4 JPEG duplicates earlier encoded fingerprint")
        known_encoded.add(row["encodedSha256"])
    historical_manifests = sorted(
        set(v4_primary_path.parent.parent.glob("metadata-plan*/photo-shortlist-private.json"))
        | set(v4_primary_path.parent.parent.glob("metadata-reserve*/photo-reserve-commit-private.json"))
        | {v4_primary_path, v4_reserve_path, v4_attempt_path}
    )
    all_case_ids, all_image_ids, all_groups = _case_rows(historical_manifests)
    split, split_sha = read_json(split_path, maximum=validation.MAX_EXCLUSION_AUDIT_BYTES)
    for key in ("devSourceGroupIds", "exclusionSourceGroupIds"):
        group_values = split.get(key)
        if not isinstance(group_values, list):
            raise validation.CurateError(f"source group split {key} must be an array")
        all_groups.update(validation.normalize_source_group(validation.require_string(v, key)) for v in group_values)

    prior_payload = old_view["payload"]
    excluded_ids = set(prior_payload["imageIds"]) | all_image_ids
    excluded_groups = {
        validation.normalize_source_group(value) for value in prior_payload["sourceGroups"]
    } | all_groups
    excluded_case_ids = all_case_ids
    encoded_union = set(prior_payload["encodedImageSha256"]) | {row["encodedSha256"] for row in retained}
    source_paths = {item["path"] for item in prior_payload["sources"]}
    source_records = list(prior_payload["sources"])
    for path in historical_manifests + [v4_report_path, v4_receipts_path, split_path]:
        item = pin(path.name, path)
        if item["path"] not in source_paths:
            source_records.append({"path": item["path"], "sha256": item["sha256"]})
            source_paths.add(item["path"])

    parent_inputs = [
        pin("prior-v3-exclusion-audit", old_audit_path, OLD_V3_AUDIT_SHA256),
        pin("prior-v4-complete-fingerprint-index", old_index_path, OLD_V4_COMPLETE_INDEX_SHA256),
        pin("v4-primary-shortlist", v4_primary_path, primary_sha),
        pin("v4-reserve-commit", v4_reserve_path, reserve_sha),
        pin("v4-attempt-list", v4_attempt_path, attempt_sha),
        pin("v4-acquisition-report", v4_report_path, report_sha),
        pin("v4-private-receipts", v4_receipts_path, receipts_sha),
        pin("source-group-split", split_path, split_sha),
    ]
    audit_payload: dict[str, Any] = {
        "schemaVersion": DISJOINT_AUDIT_SCHEMA,
        "status": DISJOINT_AUDIT_STATUS,
        "selectionSeed": SELECTION_SEED,
        "priorAuditV3Sha256": old_view["auditSha256"],
        "priorFingerprintIndexSha256": prior_index_sha,
        "v4AttemptListSha256": attempt_sha,
        "v4PrimaryShortlistSha256": primary_sha,
        "v4ReserveCommitSha256": reserve_sha,
        "v4AcquisitionReportSha256": report_sha,
        "v4PrivateReceiptsSha256": receipts_sha,
        "sourceGroupSplitSha256": split_sha,
        "parentInputs": parent_inputs,
        "ledgers": prior_payload["ledgers"],
        "imageIds": sorted(excluded_ids),
        "caseIds": sorted(excluded_case_ids),
        "encodedImageSha256": sorted(encoded_union),
        "sourceGroups": sorted(excluded_groups),
        "missingSourceMetadataIds": prior_payload["missingSourceMetadataIds"],
        "sources": source_records,
        "v4RetainedJpegFingerprints": sorted(retained, key=lambda row: row["encodedSha256"]),
    }
    audit_path = output_dir / "disjoint-photo-exclusions-v1.json"
    audit_sha = write_json(audit_path, audit_payload)
    fingerprint_payload = {
        "schemaVersion": validation.FINGERPRINT_INDEX_SCHEMA_V3,
        "exclusionAuditSha256": audit_sha,
        "perceptualHashAlgorithmId": validation.PERCEPTUAL_HASH_ALGORITHM_ID,
        "perceptualHashResampler": validation.PERCEPTUAL_HASH_RESAMPLER,
        "pillowVersion": prior_index["pillowVersion"],
        "entries": prior_entries + [
            {key: row[key] for key in ("encodedSha256", "decodedRgbSha256", "perceptualHash64")}
            for row in sorted(retained, key=lambda item: item["encodedSha256"])
        ],
        "exactOnlyEncodedSha256": [],
    }
    fingerprint_payload = validation.validate_fingerprint_index(
        fingerprint_payload, require_runtime_pillow_match=False
    )
    validation.validate_fingerprint_index_exclusion_coverage(
        fingerprint_payload,
        exclusion_audit_sha256=audit_sha,
        excluded_encoded_sha256=set(encoded_union),
    )
    fingerprint_path = output_dir / "disjoint-photo-fingerprint-index-v1.json"
    fingerprint_sha = write_json(fingerprint_path, fingerprint_payload)
    duplicate_policy = {
        "schemaVersion": validation.DUPLICATE_POLICY_SCHEMA_V3,
        "status": "frozen-pre-acquisition-disjoint-photo-v1",
        "fingerprintIndexSha256": fingerprint_sha,
        "exclusionAuditSha256": audit_sha,
        "perceptualHashAlgorithmId": validation.PERCEPTUAL_HASH_ALGORITHM_ID,
        "perceptualHashResampler": validation.PERCEPTUAL_HASH_RESAMPLER,
        "pillowVersion": prior_index["pillowVersion"],
        "hammingRejectAtMost": validation.PHASH_HAMMING_REJECT_AT_MOST,
        "encodedSha256Reject": True,
        "decodedRgbSha256Reject": True,
        "exactOnlyEncodedSha256Reject": True,
    }
    duplicate_path = output_dir / "disjoint-photo-duplicate-policy-v1.json"
    duplicate_sha = write_json(duplicate_path, duplicate_policy)
    pins = {
        "schema": "h8a-disjoint-photo-input-pins-v1",
        "selectionSeed": SELECTION_SEED,
        "metadataProfile": validation.METADATA_PROFILE_V4,
        "sourceCsvSha256": {},
        "maskCsvSha256": None,
        "maskHeaderIndexSha256": None,
        "historical": parent_inputs,
        "exclusionAuditSha256": audit_sha,
        "fingerprintIndexSha256": fingerprint_sha,
        "duplicatePolicySha256": duplicate_sha,
        "pillowVersion": prior_index["pillowVersion"],
        "candidateImagePixelsFetched": 0,
        "providerCalls": 0,
    }
    write_json(output_dir / "disjoint-photo-input-pins-v1.json", pins)
    return old_view, {"payload": audit_payload, "auditSha256": audit_sha, "excludedEncoded": encoded_union}, {
        "fingerprint": fingerprint_payload,
        "fingerprintSha256": fingerprint_sha,
        "duplicatePolicy": duplicate_policy,
        "duplicatePolicySha256": duplicate_sha,
        "retainedCount": len(retained),
        "oldCaseIds": excluded_case_ids,
    }


def _history_view(payload: dict[str, Any], digest: str) -> dict[str, Any]:
    validation._validate_exclusion_audit_collection_fields(payload)
    return {
        "payload": payload,
        "auditSha256": digest,
        "excludedImageIds": set(payload["imageIds"]),
        "excludedEncodedSha256": set(payload["encodedImageSha256"]),
        "excludedSourceGroups": set(payload["sourceGroups"]),
        "counts": {
            "imageIds": len(payload["imageIds"]),
            "encodedImageSha256": len(payload["encodedImageSha256"]),
            "sourceGroups": len(payload["sourceGroups"]),
        },
    }


def build_plan(
    *,
    old_case_ids: set[str],
    audit_view: dict[str, Any],
    fingerprint: dict[str, Any],
    fingerprint_sha: str,
    duplicate_policy: dict[str, Any],
    duplicate_sha: str,
    source_dir: Path,
    mask_csv: Path,
    mask_header_index: Path,
    output_dir: Path,
) -> dict[str, Any]:
    mask_rows, mask_csv_sha = curate.load_instance_mask_metadata(mask_csv)
    header_raw, _ = validation.read_bounded_file_bytes(
        mask_header_index,
        max_bytes=validation.MAX_MASK_HEADER_INDEX_BYTES,
        label="mask header index",
    )
    headers, header_sha = validation.load_mask_header_index_from_bytes(
        header_raw, mask_csv_sha256=mask_csv_sha
    )
    metadata = curate.load_openimages_metadata(source_dir, exclusion_payload=audit_view["payload"])
    indexes = curate.build_indexes(metadata)
    positives, negatives, tally, examples = curate.scan_candidates(
        indexes,
        audit_view,
        mask_row_index=curate.build_mask_row_index(mask_rows),
        mask_header_entries=headers,
        require_exact_max_dimension=True,
        selection_seed=SELECTION_SEED,
    )
    primary_pos, primary_neg = curate.select_shortlist(positives, negatives, tally, examples)
    primary_rows = curate.build_private_rows(primary_pos, primary_neg, selection_seed=SELECTION_SEED)
    primary_doc: dict[str, Any] = {
        "schemaVersion": validation.PRIVATE_MANIFEST_SCHEMA_V4,
        "metadataProfile": validation.METADATA_PROFILE_V4,
        "selectionSeed": SELECTION_SEED,
        "status": "metadata-only-private-curator-plan",
        "disclaimer": "Private curator planning artifact; metadata, source rights and pixels still require independent review.",
        "quotas": {"positive": 16, "negative": 4},
        "rows": primary_rows,
    }
    validation.validate_private_photo_manifest(primary_doc)
    used_images, used_groups = curate.primary_usage_from_manifest(primary_rows)
    reserve_pos, reserve_neg = curate.select_reserves(
        positives,
        negatives,
        tally,
        examples,
        used_images=used_images,
        used_groups=used_groups,
    )
    if len(reserve_pos) != 16 or len(reserve_neg) != 4:
        raise validation.CurateError("disjoint photo reserves do not meet the 16/4 quota")
    reserve_rows = curate.build_private_rows(reserve_pos, reserve_neg, selection_seed=SELECTION_SEED)
    primary_raw = (json.dumps(primary_doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    primary_sha = sha256_bytes(primary_raw)
    reserve_doc = {
        "schemaVersion": validation.RESERVE_MANIFEST_SCHEMA_V3,
        "metadataProfile": validation.METADATA_PROFILE_V4,
        "status": "metadata-only-reserve-commit",
        "selectionSeed": SELECTION_SEED,
        "primaryShortlistSha256": primary_sha,
        "quotas": {"positive": 16, "negative": 4},
        "rows": reserve_rows,
    }
    validation.validate_reserve_manifest(reserve_doc, primary_shortlist_sha256=primary_sha)
    reserve_raw = (json.dumps(reserve_doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    reserve_sha = sha256_bytes(reserve_raw)
    attempts = curate.build_attempt_list_rows(
        primary_rows,
        reserve_rows,
        primary_shortlist_sha256=primary_sha,
        reserve_commit_sha256=reserve_sha,
        attempt_schema_version=validation.ATTEMPT_LIST_SCHEMA_V3,
        metadata_profile=validation.METADATA_PROFILE_V4,
    )
    attempt_doc = {
        "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V3,
        "metadataProfile": validation.METADATA_PROFILE_V4,
        "selectionSeed": SELECTION_SEED,
        "primaryShortlistSha256": primary_sha,
        "reserveCommitSha256": reserve_sha,
        "attempts": attempts,
    }
    validation.validate_attempt_list(attempt_doc)
    new_ids = {row["imageId"] for row in primary_rows + reserve_rows}
    new_case_ids = {row["caseId"] for row in primary_rows + reserve_rows}
    new_groups = {
        validation.normalize_source_group(row["authorProfileUrl"])
        for row in primary_rows + reserve_rows
    }
    if len(new_ids) != 40 or len(new_case_ids) != 40 or len(new_groups) != 40:
        raise validation.CurateError("new primary and reserve must have unique image, case and author IDs")
    if new_ids & audit_view["excludedImageIds"] or new_groups & audit_view["excludedSourceGroups"]:
        raise validation.CurateError("new photo plan overlaps frozen historical image/source exclusions")
    if new_case_ids & old_case_ids:
        raise validation.CurateError("new photo case IDs overlap historical photo case IDs")

    source_hashes = metadata["sourceCsvSha256"]
    input_pins_path = output_dir / "disjoint-photo-input-pins-v1.json"
    pins, _ = read_json(input_pins_path)
    pins["sourceCsvSha256"] = source_hashes
    pins["maskCsvSha256"] = mask_csv_sha
    pins["maskHeaderIndexSha256"] = header_sha
    pins["primaryShortlistSha256"] = primary_sha
    pins["reserveCommitSha256"] = reserve_sha
    pins["attemptListSha256"] = sha256_bytes((json.dumps(attempt_doc, indent=2, ensure_ascii=False) + "\n").encode())
    pins["candidateImagePixelsFetched"] = 0
    write_json(input_pins_path, pins)
    write_json(output_dir / "disjoint-photo-primary-shortlist-v1.json", primary_doc)
    write_json(output_dir / "disjoint-photo-reserve-commit-v1.json", reserve_doc)
    write_json(output_dir / "disjoint-photo-attempt-list-v1.json", attempt_doc)
    rights_rows = []
    for index, row in enumerate(primary_rows + reserve_rows):
        item = {
            "attemptIndex": index,
            "phase": "primary" if index < 20 else "reserve",
            "caseId": row["caseId"],
            "imageId": row["imageId"],
            "expectedPresence": row["expectedPresence"],
            "target": row["target"],
            "targetClassId": row["targetClassId"],
            "sourceUrls": row["sourceUrls"],
            "authorProfileUrl": row["authorProfileUrl"],
            "rightsMetadataStatus": "dataset-metadata-CC-BY-2.0; per-photo Flickr license page pending",
            "sourceCanvas": {
                "width": None,
                "height": None,
                "originalSizeBytes": metadata["images"][row["imageId"]]["OriginalSize"],
                "dimensionsStatus": "pending-exact-canvas-check-against-downloaded-JPEG",
            },
            "officialMask": row.get("instanceMaskMetadata"),
        }
        rights_rows.append(item)
    review_input = {
        "schema": "h8a-disjoint-photo-pre-acquisition-review-v1",
        "status": "metadata-precommitted-awaiting-parent-review-before-image-fetch",
        "selectionSeed": SELECTION_SEED,
        "exclusionAuditSha256": audit_view["auditSha256"],
        "fingerprintIndexSha256": fingerprint_sha,
        "duplicatePolicySha256": duplicate_sha,
        "primaryShortlistSha256": primary_sha,
        "reserveCommitSha256": reserve_sha,
        "attemptListSha256": pins["attemptListSha256"],
        "primaryCounts": {"present": 16, "absent": 4},
        "reserveCounts": {"present": 16, "absent": 4},
        "historicalFingerprintEntries": len(fingerprint["entries"]),
        "historicalEncodedOnlyCount": len(fingerprint.get("exactOnlyEncodedSha256", [])),
        "sourceCsvSha256": source_hashes,
        "maskCsvSha256": mask_csv_sha,
        "maskHeaderIndexSha256": header_sha,
        "dedupeCoverage": {
            "encodedSha256": len(fingerprint["entries"]),
            "decodedRgbSha256": len(fingerprint["entries"]),
            "perceptualHash64": len(fingerprint["entries"]),
            "hammingRejectAtMost": validation.PHASH_HAMMING_REJECT_AT_MOST,
            "historicalV4JpegsEncodedBytesRehashed": 20,
            "historicalV4DecodedAndPhashFromPinnedReport": 20,
            "newCandidateImagePixelsFetched": 0,
        },
        "rightsAndMasks": rights_rows,
        "providerCalls": 0,
    }
    write_json(output_dir / "disjoint-photo-pre-acquisition-review-v1.json", review_input)
    summary = {
        "status": "metadata-only-plan-frozen",
        "selectionSeed": SELECTION_SEED,
        "eligiblePositiveCandidates": len(positives),
        "eligibleNegativeCandidates": len(negatives),
        "primaryCounts": {"present": len(primary_pos), "absent": len(primary_neg)},
        "reserveCounts": {"present": len(reserve_pos), "absent": len(reserve_neg)},
        "rejectionTally": dict(sorted(tally.items())),
        "exclusionCounts": audit_view["counts"],
        "exclusionAuditSha256": audit_view["auditSha256"],
        "fingerprintIndexSha256": fingerprint_sha,
        "duplicatePolicySha256": duplicate_sha,
        "sourceCsvSha256": source_hashes,
        "maskCsvSha256": mask_csv_sha,
        "maskHeaderIndexSha256": header_sha,
        "candidateImagePixelsFetched": 0,
        "providerCalls": 0,
    }
    write_json(output_dir / "disjoint-photo-metadata-plan-summary-v1.json", summary)
    return review_input


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-audit", type=Path, required=True)
    parser.add_argument("--old-fingerprint-index", type=Path, required=True)
    parser.add_argument("--v4-primary", type=Path, required=True)
    parser.add_argument("--v4-reserve", type=Path, required=True)
    parser.add_argument("--v4-attempts", type=Path, required=True)
    parser.add_argument("--v4-report", type=Path, required=True)
    parser.add_argument("--v4-receipts", type=Path, required=True)
    parser.add_argument("--v4-acquisition-dir", type=Path, required=True)
    parser.add_argument("--source-group-split", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--mask-csv", type=Path, required=True)
    parser.add_argument("--mask-header-index", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output = validation.require_external_new_directory(
        args.output_dir, validation.repo_root_from_here(Path(__file__)), "output directory"
    )
    output.mkdir(parents=True, exist_ok=False)
    _old, audit, history = build_history(
        old_audit_path=args.old_audit,
        old_index_path=args.old_fingerprint_index,
        v4_primary_path=args.v4_primary,
        v4_reserve_path=args.v4_reserve,
        v4_attempt_path=args.v4_attempts,
        v4_report_path=args.v4_report,
        v4_receipts_path=args.v4_receipts,
        v4_acquisition_dir=args.v4_acquisition_dir,
        split_path=args.source_group_split,
        output_dir=output,
    )
    review_input = build_plan(
        old_case_ids=history["oldCaseIds"],
        audit_view=_history_view(audit["payload"], audit["auditSha256"]),
        fingerprint=history["fingerprint"],
        fingerprint_sha=history["fingerprintSha256"],
        duplicate_policy=history["duplicatePolicy"],
        duplicate_sha=history["duplicatePolicySha256"],
        source_dir=args.source_dir,
        mask_csv=args.mask_csv,
        mask_header_index=args.mask_header_index,
        output_dir=output,
    )
    print(json.dumps({"status": review_input["status"], "outputDir": str(output), "attemptListSha256": review_input["attemptListSha256"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
