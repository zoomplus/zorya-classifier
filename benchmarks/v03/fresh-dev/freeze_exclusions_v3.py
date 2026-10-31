#!/usr/bin/env python3
"""Freeze an additive source exclusion audit from the retained v3 acquisition."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import validation
from freeze_exclusions_v2 import extract_v2_accepted_fingerprints, extract_v2_rejection_encoded_sha256


def _parent_record(label: str, path: Path, digest: str) -> dict[str, str]:
    return {"label": label, "path": str(path.resolve()), "sha256": digest}


def _read_json(path: Path, *, max_bytes: int, label: str, expected_sha256: str) -> tuple[dict[str, Any], str]:
    raw, digest = validation.read_bounded_file_bytes(path, max_bytes=max_bytes, label=label)
    if digest != expected_sha256:
        raise validation.CurateError(f"{label} SHA-256 mismatch")
    value = validation.require_json_object(
        validation.loads_strict_json(raw.decode("utf-8"), label=label), label
    )
    return value, digest


def _distinct_ids(rows: list[dict[str, Any]], field: str, label: str) -> set[str]:
    values = {validation.require_opaque_case_id(row.get(field), f"{label}.{field}") for row in rows}
    if len(values) != len(rows):
        raise validation.CurateError(f"{label} contains duplicate {field}")
    return values


def build_v3_additive_exclusion_audit(
    *,
    prior_audit_path: Path,
    prior_audit: dict[str, Any],
    prior_audit_sha256: str,
    attempt_path: Path,
    attempt_sha256: str,
    attempt_doc: dict[str, Any],
    primary_path: Path,
    primary_sha256: str,
    primary_rows: list[dict[str, Any]],
    reserve_path: Path,
    reserve_sha256: str,
    reserve_rows: list[dict[str, Any]],
    report_path: Path,
    report_sha256: str,
    report: dict[str, Any],
    receipts_path: Path,
    receipts_sha256: str,
    receipts: dict[str, Any],
) -> dict[str, Any]:
    if prior_audit_sha256 != validation.EXCLUSION_AUDIT_V2_SHA256:
        raise validation.CurateError("prior v2 exclusion audit SHA-256 mismatch")
    attempts = validation.validate_attempt_list(attempt_doc)
    if attempt_doc.get("schemaVersion") != validation.ATTEMPT_LIST_SCHEMA_V2:
        raise validation.CurateError("v3 prior acquisition attempt list schema mismatch")
    if attempt_doc.get("metadataProfile") != validation.METADATA_PROFILE_V3:
        raise validation.CurateError("v3 prior acquisition metadata profile mismatch")
    if attempt_doc.get("primaryShortlistSha256") != primary_sha256:
        raise validation.CurateError("v3 attempt list primary hash mismatch")
    if attempt_doc.get("reserveCommitSha256") != reserve_sha256:
        raise validation.CurateError("v3 attempt list reserve hash mismatch")
    source_rows: dict[str, dict[str, Any]] = {}
    for row in primary_rows + reserve_rows:
        case_id = validation.require_opaque_case_id(row.get("caseId"), "manifest.caseId")
        if case_id in source_rows:
            raise validation.CurateError("v3 primary/reserve case IDs overlap")
        source_rows[case_id] = row
    image_ids: set[str] = set()
    source_groups: set[str] = set()
    for index, attempt in enumerate(attempts):
        case_id = validation.require_opaque_case_id(attempt.get("caseId"), f"attempts[{index}].caseId")
        source = source_rows.get(case_id)
        if source is None:
            raise validation.CurateError("v3 attempt is missing from its manifest")
        for field in ("imageId", "target", "targetClassId", "expectedPresence"):
            if attempt.get(field) != source.get(field):
                raise validation.CurateError(f"v3 attempt/manifest {field} mismatch")
        image_id = validation.require_string(source.get("imageId"), "manifest.imageId")
        group = validation.normalize_source_group(
            validation.require_string(source.get("authorProfileUrl"), "manifest.authorProfileUrl")
        )
        image_ids.add(image_id)
        source_groups.add(group)
    if len(image_ids) != len(attempts) or len(source_groups) != len(attempts):
        raise validation.CurateError("v3 attempts must have unique image IDs and author groups")

    if report.get("schemaVersion") != 1 or report.get("attemptCount") != len(attempts):
        raise validation.CurateError("v3 acquisition report attempt count mismatch")
    report_records = report.get("records")
    report_rejections = report.get("rejections")
    receipt_attempts = receipts.get("attempts")
    if not isinstance(report_records, list) or not isinstance(report_rejections, list):
        raise validation.CurateError("v3 acquisition report rows are malformed")
    if not isinstance(receipt_attempts, list):
        raise validation.CurateError("v3 acquisition receipt attempts are malformed")
    accepted_case_ids = _distinct_ids(report_records, "caseId", "report.records")
    rejected_case_ids = _distinct_ids(report_rejections, "caseId", "report.rejections")
    receipt_case_ids = _distinct_ids(receipt_attempts, "caseId", "receipts.attempts")
    if accepted_case_ids & rejected_case_ids or accepted_case_ids | rejected_case_ids != receipt_case_ids:
        raise validation.CurateError("v3 report/receipt outcome coverage mismatch")
    attempt_case_ids = {row["caseId"] for row in attempts}
    if not receipt_case_ids.issubset(attempt_case_ids):
        raise validation.CurateError("v3 acquisition receipt contains a case outside its frozen attempt list")

    accepted_fingerprints = extract_v2_accepted_fingerprints(report)
    rejected_encoded = extract_v2_rejection_encoded_sha256(receipts)
    retained_encoded = {row["encodedSha256"] for row in accepted_fingerprints} | set(rejected_encoded)
    encoded_union = {
        validation.require_sha256_hex(value, "prior v2 encodedImageSha256")
        for value in prior_audit.get("encodedImageSha256", [])
    } | retained_encoded
    prior_image_ids = set(prior_audit.get("imageIds", []))
    prior_groups = {
        validation.normalize_source_group(validation.require_string(value, "prior source group"))
        for value in prior_audit.get("sourceGroups", [])
    }
    payload: dict[str, Any] = {
        "schemaVersion": 3,
        "status": validation.EXCLUSION_AUDIT_V3_STATUS,
        "priorAuditV2Sha256": prior_audit_sha256,
        "v3AttemptListSha256": attempt_sha256,
        "v3PrimaryShortlistSha256": primary_sha256,
        "v3ReserveCommitSha256": reserve_sha256,
        "v3AcquisitionReportSha256": report_sha256,
        "v3AcquisitionPrivateReceiptsSha256": receipts_sha256,
        "v3AcquisitionEncodedImageSha256": sorted(retained_encoded),
        "parentInputs": [
            _parent_record("priorAuditV2", prior_audit_path, prior_audit_sha256),
            _parent_record("v3AttemptList", attempt_path, attempt_sha256),
            _parent_record("v3PrimaryShortlist", primary_path, primary_sha256),
            _parent_record("v3ReserveCommit", reserve_path, reserve_sha256),
            _parent_record("v3AcquisitionReport", report_path, report_sha256),
            _parent_record("v3AcquisitionPrivateReceipts", receipts_path, receipts_sha256),
        ],
        "ledgers": prior_audit["ledgers"],
        "imageIds": sorted(prior_image_ids | image_ids),
        "encodedImageSha256": sorted(encoded_union),
        "sourceGroups": sorted(prior_groups | source_groups),
        "missingSourceMetadataIds": prior_audit["missingSourceMetadataIds"],
        "sources": prior_audit["sources"],
    }
    validation.validate_exclusion_audit_payload_v3(payload)
    return payload


def build_from_paths(args: argparse.Namespace) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    repo_root = validation.repo_root_from_here(Path(__file__))
    prior_path = validation.resolve_existing_input(Path(args.prior_audit_v2), repo_root, "prior v2 audit")
    prior_view = validation.validate_additive_exclusion_audit_v2(
        prior_path, expected_sha256=validation.EXCLUSION_AUDIT_V2_SHA256
    )
    attempt_path = validation.resolve_existing_input(Path(args.v3_attempt_list), repo_root, "v3 attempt list")
    primary_path = validation.resolve_existing_input(Path(args.v3_primary_shortlist), repo_root, "v3 primary shortlist")
    reserve_path = validation.resolve_existing_input(Path(args.v3_reserve_commit), repo_root, "v3 reserve commit")
    report_path = validation.resolve_existing_input(Path(args.v3_acquisition_report), repo_root, "v3 acquisition report")
    receipts_path = validation.resolve_existing_input(
        Path(args.v3_acquisition_receipts), repo_root, "v3 acquisition private receipts"
    )
    attempt_doc, attempt_sha = _read_json(
        attempt_path, max_bytes=validation.MAX_ATTEMPT_LIST_BYTES, label="v3 attempt list",
        expected_sha256=args.v3_attempt_list_sha256,
    )
    primary_payload, primary_sha = _read_json(
        primary_path, max_bytes=validation.MAX_PRIVATE_MANIFEST_BYTES, label="v3 primary shortlist",
        expected_sha256=args.v3_primary_shortlist_sha256,
    )
    primary_rows = validation.validate_private_photo_manifest(primary_payload)
    reserve_payload, reserve_sha = _read_json(
        reserve_path, max_bytes=validation.MAX_PRIVATE_MANIFEST_BYTES, label="v3 reserve commit",
        expected_sha256=args.v3_reserve_commit_sha256,
    )
    reserve_rows = validation.validate_reserve_manifest(
        reserve_payload, primary_shortlist_sha256=primary_sha
    )
    report, report_sha = _read_json(
        report_path, max_bytes=8 * 1024 * 1024, label="v3 acquisition report",
        expected_sha256=args.v3_acquisition_report_sha256,
    )
    receipts, receipts_sha = _read_json(
        receipts_path, max_bytes=16 * 1024 * 1024, label="v3 acquisition receipts",
        expected_sha256=args.v3_acquisition_receipts_sha256,
    )
    payload = build_v3_additive_exclusion_audit(
        prior_audit_path=prior_path,
        prior_audit=prior_view["payload"],
        prior_audit_sha256=prior_view["auditSha256"],
        attempt_path=attempt_path,
        attempt_sha256=attempt_sha,
        attempt_doc=attempt_doc,
        primary_path=primary_path,
        primary_sha256=primary_sha,
        primary_rows=primary_rows,
        reserve_path=reserve_path,
        reserve_sha256=reserve_sha,
        reserve_rows=reserve_rows,
        report_path=report_path,
        report_sha256=report_sha,
        report=report,
        receipts_path=receipts_path,
        receipts_sha256=receipts_sha,
        receipts=receipts,
    )
    parents = [(item["label"], item["sha256"]) for item in payload["parentInputs"]]
    return payload, parents


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build additive exclusion audit v3 from retained v3 evidence")
    parser.add_argument("--prior-audit-v2", required=True)
    parser.add_argument("--v3-attempt-list", required=True)
    parser.add_argument("--v3-attempt-list-sha256", required=True)
    parser.add_argument("--v3-primary-shortlist", required=True)
    parser.add_argument("--v3-primary-shortlist-sha256", required=True)
    parser.add_argument("--v3-reserve-commit", required=True)
    parser.add_argument("--v3-reserve-commit-sha256", required=True)
    parser.add_argument("--v3-acquisition-report", required=True)
    parser.add_argument("--v3-acquisition-report-sha256", required=True)
    parser.add_argument("--v3-acquisition-receipts", required=True)
    parser.add_argument("--v3-acquisition-receipts-sha256", required=True)
    parser.add_argument("--output-dir", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = validation.repo_root_from_here(Path(__file__))
    output_dir = validation.require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    payload, _parents = build_from_paths(args)
    output_dir.mkdir(parents=True, exist_ok=False)
    output = output_dir / "prior-source-exclusions-v3-additive.json"
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    digest = validation.sha256_bytes(output.read_bytes())
    (output_dir / "prior-source-exclusions-v3-additive.sha256").write_text(digest + "\n", encoding="utf-8")
    print(json.dumps({"status": "frozen", "sha256": digest, "path": str(output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
