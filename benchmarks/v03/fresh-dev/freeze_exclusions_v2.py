#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from validation import (
    ATTEMPT_LIST_SCHEMA_V1,
    CORRECTED_PRIMARY_SHORTLIST_SHA256,
    EXCLUSION_AUDIT_SHA256,
    EXCLUSION_AUDIT_V2_STATUS,
    V1_ATTEMPT_JOIN_COUNT,
    V1_ATTEMPT_LIST_SHA256,
    V2_ACQUISITION_RECEIPTS_SHA256,
    V2_ACQUISITION_REPORT_SHA256,
    V2_RESERVE_COMMIT_SHA256,
    CurateError,
    MAX_ATTEMPT_LIST_BYTES,
    MAX_EXCLUSION_AUDIT_BYTES,
    MAX_PRIVATE_MANIFEST_BYTES,
    loads_strict_json,
    normalize_source_group,
    read_bounded_file_bytes,
    repo_root_from_here,
    require_external_new_directory,
    require_json_object,
    require_opaque_case_id,
    require_sha256_hex,
    require_string,
    resolve_existing_input,
    sha256_bytes,
    validate_attempt_list,
    validate_exclusion_audit,
    validate_exclusion_audit_payload_v2,
    validate_private_photo_manifest,
    validate_reserve_manifest,
)

MAX_ACQUISITION_REPORT_BYTES = 8 * 1024 * 1024
MAX_ACQUISITION_RECEIPTS_BYTES = 16 * 1024 * 1024


def _parent_record(label: str, path: Path, digest: str) -> dict[str, str]:
    return {"label": label, "path": str(path.resolve()), "sha256": digest}


def join_v1_attempt_manifest_rows(
    attempt_doc: dict[str, Any],
    primary_rows: list[dict[str, Any]],
    reserve_rows: list[dict[str, Any]],
) -> tuple[set[str], set[str]]:
    rows_by_case: dict[str, dict[str, Any]] = {}
    for row in primary_rows + reserve_rows:
        case_id = require_opaque_case_id(row.get("caseId"), "caseId")
        if case_id in rows_by_case:
            raise CurateError("manifest rows contain duplicate caseId")
        rows_by_case[case_id] = row
    attempts = attempt_doc.get("attempts")
    if not isinstance(attempts, list):
        raise CurateError("attempt list attempts must be an array")
    if len(attempts) != V1_ATTEMPT_JOIN_COUNT:
        raise CurateError("attempt list must contain exactly 40 rows for v1 join")
    image_ids: list[str] = []
    source_groups: list[str] = []
    for index, item in enumerate(attempts):
        attempt = require_json_object(item, f"attempt list.attempts[{index}]")
        case_id = require_opaque_case_id(attempt.get("caseId"), f"attempt list.attempts[{index}].caseId")
        source_row = rows_by_case.get(case_id)
        if source_row is None:
            raise CurateError("attempt list caseId missing from primary/reserve manifests")
        attempt_image_id = require_string(attempt.get("imageId"), f"attempt list.attempts[{index}].imageId")
        source_image_id = require_string(source_row.get("imageId"), "imageId")
        if attempt_image_id != source_image_id:
            raise CurateError("attempt list imageId mismatch against manifest row")
        author_url = require_string(source_row.get("authorProfileUrl"), "authorProfileUrl")
        image_ids.append(source_image_id)
        source_groups.append(normalize_source_group(author_url))
    if len(set(image_ids)) != V1_ATTEMPT_JOIN_COUNT:
        raise CurateError("v1 attempt join imageId set is not distinct")
    if len(set(source_groups)) != V1_ATTEMPT_JOIN_COUNT:
        raise CurateError("v1 attempt join source group set is not distinct")
    return set(image_ids), set(source_groups)


def extract_v2_accepted_fingerprints(report: dict[str, Any]) -> list[dict[str, str]]:
    records = report.get("records")
    if not isinstance(records, list):
        raise CurateError("acquisition report.records must be an array")
    fingerprints: list[dict[str, str]] = []
    seen_encoded: set[str] = set()
    for index, item in enumerate(records):
        record = require_json_object(item, f"acquisition report.records[{index}]")
        encoded = require_sha256_hex(record.get("encodedSha256"), f"records[{index}].encodedSha256")
        decoded = require_sha256_hex(record.get("decodedRgbSha256"), f"records[{index}].decodedRgbSha256")
        phash = require_string(record.get("perceptualHash64"), f"records[{index}].perceptualHash64")
        if encoded in seen_encoded:
            raise CurateError("acquisition report contains duplicate encodedSha256")
        seen_encoded.add(encoded)
        fingerprints.append(
            {"encodedSha256": encoded, "decodedRgbSha256": decoded, "perceptualHash64": phash}
        )
    return fingerprints


def extract_v2_rejection_encoded_sha256(receipts: dict[str, Any]) -> list[str]:
    attempts = receipts.get("attempts")
    if not isinstance(attempts, list):
        raise CurateError("acquisition receipts attempts must be an array")
    encoded: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(attempts):
        attempt = require_json_object(item, f"receipts.attempts[{index}]")
        evidence = attempt.get("rejectionSourceEvidence")
        if evidence is None:
            continue
        evidence_obj = require_json_object(evidence, f"receipts.attempts[{index}].rejectionSourceEvidence")
        jpeg = evidence_obj.get("jpeg")
        if jpeg is None:
            continue
        jpeg_obj = require_json_object(jpeg, f"receipts.attempts[{index}].rejectionSourceEvidence.jpeg")
        digest = require_sha256_hex(
            jpeg_obj.get("storedBytesSha256"),
            f"receipts.attempts[{index}].rejectionSourceEvidence.jpeg.storedBytesSha256",
        )
        if digest in seen:
            raise CurateError("duplicate rejection JPEG encoded SHA in receipts")
        seen.add(digest)
        encoded.append(digest)
    return encoded


def build_additive_exclusion_audit_v2(
    *,
    prior_audit_path: Path,
    prior_audit_payload: dict[str, Any],
    prior_audit_sha256: str,
    v1_attempt_path: Path,
    v1_attempt_sha256: str,
    v1_attempt_doc: dict[str, Any],
    v2_primary_path: Path,
    v2_primary_sha256: str,
    v2_primary_rows: list[dict[str, Any]],
    v2_reserve_path: Path,
    v2_reserve_sha256: str,
    v2_reserve_rows: list[dict[str, Any]],
    v2_report_path: Path,
    v2_report_sha256: str,
    v2_report: dict[str, Any],
    v2_receipts_path: Path,
    v2_receipts_sha256: str,
    v2_receipts: dict[str, Any],
) -> dict[str, Any]:
    if prior_audit_sha256 != EXCLUSION_AUDIT_SHA256:
        raise CurateError("prior exclusion audit SHA-256 mismatch")
    attempt_image_ids, attempt_source_groups = join_v1_attempt_manifest_rows(
        v1_attempt_doc,
        v2_primary_rows,
        v2_reserve_rows,
    )
    accepted_fingerprints = extract_v2_accepted_fingerprints(v2_report)
    rejection_encoded = extract_v2_rejection_encoded_sha256(v2_receipts)

    image_ids = sorted(set(prior_audit_payload["imageIds"]) | attempt_image_ids)
    source_groups_raw = list(prior_audit_payload["sourceGroups"])
    normalized_groups = {normalize_source_group(require_string(v, "sourceGroup")) for v in source_groups_raw}
    normalized_groups |= attempt_source_groups
    source_groups = sorted(normalized_groups)

    encoded_union = set(require_sha256_hex(v, "encodedImageSha256") for v in prior_audit_payload["encodedImageSha256"])
    for row in accepted_fingerprints:
        encoded_union.add(row["encodedSha256"])
    for digest in rejection_encoded:
        encoded_union.add(digest)
    encoded_image_sha256 = sorted(encoded_union)

    parent_inputs = [
        _parent_record("priorAudit", prior_audit_path, prior_audit_sha256),
        _parent_record("v1AttemptList", v1_attempt_path, v1_attempt_sha256),
        _parent_record("v2PrimaryShortlist", v2_primary_path, v2_primary_sha256),
        _parent_record("v2ReserveCommit", v2_reserve_path, v2_reserve_sha256),
        _parent_record("v2AcquisitionReport", v2_report_path, v2_report_sha256),
        _parent_record("v2AcquisitionPrivateReceipts", v2_receipts_path, v2_receipts_sha256),
    ]

    payload: dict[str, Any] = {
        "schemaVersion": 2,
        "status": EXCLUSION_AUDIT_V2_STATUS,
        "priorAuditSha256": prior_audit_sha256,
        "v1AttemptListSha256": v1_attempt_sha256,
        "v2PrimaryShortlistSha256": v2_primary_sha256,
        "v2ReserveCommitSha256": v2_reserve_sha256,
        "v2AcquisitionReportSha256": v2_report_sha256,
        "v2AcquisitionPrivateReceiptsSha256": v2_receipts_sha256,
        "parentInputs": parent_inputs,
        "ledgers": prior_audit_payload["ledgers"],
        "imageIds": image_ids,
        "encodedImageSha256": encoded_image_sha256,
        "sourceGroups": source_groups,
        "missingSourceMetadataIds": prior_audit_payload["missingSourceMetadataIds"],
        "sources": prior_audit_payload["sources"],
    }
    validate_exclusion_audit_payload_v2(payload)
    return payload


def build_additive_exclusion_audit_v2_from_paths(
    *,
    prior_audit_path: Path,
    v1_attempt_path: Path,
    v1_attempt_sha256: str,
    v2_primary_path: Path,
    v2_primary_sha256: str,
    v2_reserve_path: Path,
    v2_reserve_sha256: str,
    v2_report_path: Path,
    v2_report_sha256: str,
    v2_receipts_path: Path,
    v2_receipts_sha256: str,
) -> dict[str, Any]:
    prior_view = validate_exclusion_audit(prior_audit_path)
    if v1_attempt_sha256 != V1_ATTEMPT_LIST_SHA256:
        raise CurateError("v1 attempt list SHA-256 mismatch")
    attempt_raw, attempt_digest = read_bounded_file_bytes(
        v1_attempt_path,
        max_bytes=MAX_ATTEMPT_LIST_BYTES,
        label="v1 attempt list",
    )
    if attempt_digest != v1_attempt_sha256:
        raise CurateError("v1 attempt list SHA-256 mismatch on read")
    attempt_doc = require_json_object(
        loads_strict_json(attempt_raw.decode("utf-8"), label="v1 attempt list"),
        "v1 attempt list",
    )
    if require_string(attempt_doc.get("schemaVersion"), "schemaVersion") != ATTEMPT_LIST_SCHEMA_V1:
        raise CurateError("v1 attempt list schemaVersion mismatch")
    validate_attempt_list(attempt_doc)

    primary_raw, primary_digest = read_bounded_file_bytes(
        v2_primary_path,
        max_bytes=MAX_PRIVATE_MANIFEST_BYTES,
        label="v2 primary shortlist",
    )
    if primary_digest != v2_primary_sha256:
        raise CurateError("v2 primary shortlist SHA-256 mismatch")
    primary_payload = require_json_object(
        loads_strict_json(primary_raw.decode("utf-8"), label="v2 primary shortlist"),
        "v2 primary shortlist",
    )
    primary_rows = validate_private_photo_manifest(primary_payload)

    reserve_raw, reserve_digest = read_bounded_file_bytes(
        v2_reserve_path,
        max_bytes=MAX_PRIVATE_MANIFEST_BYTES,
        label="v2 reserve commit",
    )
    if reserve_digest != v2_reserve_sha256:
        raise CurateError("v2 reserve commit SHA-256 mismatch")
    reserve_payload = require_json_object(
        loads_strict_json(reserve_raw.decode("utf-8"), label="v2 reserve commit"),
        "v2 reserve commit",
    )
    validate_reserve_manifest(reserve_payload, primary_shortlist_sha256=v2_primary_sha256)
    reserve_rows = reserve_payload["rows"]

    report_raw, report_digest = read_bounded_file_bytes(
        v2_report_path,
        max_bytes=MAX_ACQUISITION_REPORT_BYTES,
        label="v2 acquisition report",
    )
    if report_digest != v2_report_sha256:
        raise CurateError("v2 acquisition report SHA-256 mismatch")
    v2_report = require_json_object(
        loads_strict_json(report_raw.decode("utf-8"), label="v2 acquisition report"),
        "v2 acquisition report",
    )

    receipts_raw, receipts_digest = read_bounded_file_bytes(
        v2_receipts_path,
        max_bytes=MAX_ACQUISITION_RECEIPTS_BYTES,
        label="v2 acquisition receipts",
    )
    if receipts_digest != v2_receipts_sha256:
        raise CurateError("v2 acquisition receipts SHA-256 mismatch")
    v2_receipts = require_json_object(
        loads_strict_json(receipts_raw.decode("utf-8"), label="v2 acquisition receipts"),
        "v2 acquisition receipts",
    )

    return build_additive_exclusion_audit_v2(
        prior_audit_path=prior_audit_path,
        prior_audit_payload=prior_view["payload"],
        prior_audit_sha256=prior_view["auditSha256"],
        v1_attempt_path=v1_attempt_path,
        v1_attempt_sha256=v1_attempt_sha256,
        v1_attempt_doc=attempt_doc,
        v2_primary_path=v2_primary_path,
        v2_primary_sha256=v2_primary_sha256,
        v2_primary_rows=primary_rows,
        v2_reserve_path=v2_reserve_path,
        v2_reserve_sha256=v2_reserve_sha256,
        v2_reserve_rows=reserve_rows,
        v2_report_path=v2_report_path,
        v2_report_sha256=v2_report_sha256,
        v2_report=v2_report,
        v2_receipts_path=v2_receipts_path,
        v2_receipts_sha256=v2_receipts_sha256,
        v2_receipts=v2_receipts,
    )


def cmd_build(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    prior_audit_path = resolve_existing_input(Path(args.prior_audit), repo_root, "prior exclusion audit")
    v1_attempt_path = resolve_existing_input(Path(args.v1_attempt_list), repo_root, "v1 attempt list")
    v2_primary_path = resolve_existing_input(Path(args.v2_primary_shortlist), repo_root, "v2 primary shortlist")
    v2_reserve_path = resolve_existing_input(Path(args.v2_reserve_commit), repo_root, "v2 reserve commit")
    v2_report_path = resolve_existing_input(Path(args.v2_acquisition_report), repo_root, "v2 acquisition report")
    v2_receipts_path = resolve_existing_input(
        Path(args.v2_acquisition_receipts),
        repo_root,
        "v2 acquisition receipts",
    )
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    payload = build_additive_exclusion_audit_v2_from_paths(
        prior_audit_path=prior_audit_path,
        v1_attempt_path=v1_attempt_path,
        v1_attempt_sha256=args.v1_attempt_list_sha256,
        v2_primary_path=v2_primary_path,
        v2_primary_sha256=args.v2_primary_shortlist_sha256,
        v2_reserve_path=v2_reserve_path,
        v2_reserve_sha256=args.v2_reserve_commit_sha256,
        v2_report_path=v2_report_path,
        v2_report_sha256=args.v2_acquisition_report_sha256,
        v2_receipts_path=v2_receipts_path,
        v2_receipts_sha256=args.v2_acquisition_receipts_sha256,
    )
    output_dir.mkdir(parents=True, exist_ok=False)
    out_path = output_dir / "prior-source-exclusions-v2-additive.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    digest = sha256_bytes(out_path.read_bytes())
    (output_dir / "prior-source-exclusions-v2-additive.sha256").write_text(digest + "\n", encoding="utf-8")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build additive exclusion audit v2")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--prior-audit", required=True)
    build.add_argument("--v1-attempt-list", required=True)
    build.add_argument(
        "--v1-attempt-list-sha256",
        default=V1_ATTEMPT_LIST_SHA256,
    )
    build.add_argument("--v2-primary-shortlist", required=True)
    build.add_argument(
        "--v2-primary-shortlist-sha256",
        default=CORRECTED_PRIMARY_SHORTLIST_SHA256,
    )
    build.add_argument("--v2-reserve-commit", required=True)
    build.add_argument(
        "--v2-reserve-commit-sha256",
        default=V2_RESERVE_COMMIT_SHA256,
    )
    build.add_argument("--v2-acquisition-report", required=True)
    build.add_argument(
        "--v2-acquisition-report-sha256",
        default=V2_ACQUISITION_REPORT_SHA256,
    )
    build.add_argument("--v2-acquisition-receipts", required=True)
    build.add_argument(
        "--v2-acquisition-receipts-sha256",
        default=V2_ACQUISITION_RECEIPTS_SHA256,
    )
    build.add_argument("--output-dir", required=True)
    build.set_defaults(func=cmd_build)
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
