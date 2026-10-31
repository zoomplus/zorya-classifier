#!/usr/bin/env python3
"""Bounded Open Images photo acquisition planning and offline-capable execution."""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from curate import (
    NEGATIVE_QUOTA,
    POSITIVE_QUOTA,
    SEED,
    build_attempt_list_rows,
)
from http_policy import (
    MAX_FLICKR_PAGE_BYTES,
    MAX_JPEG_RESPONSE_BYTES,
    HttpTransport,
    UrllibHttpTransport,
    build_open_images_jpeg_url,
    http_status_is_infrastructure_stop,
    validate_flickr_landing_url,
    validate_open_images_jpeg_url,
    validate_resolved_url_unchanged,
)
from imaging import (
    MAX_JPEG_BYTES,
    decode_jpeg_rgb_normalized,
    decode_png_grayscale_values,
    hamming_distance64,
    mask_nonzero_half_open_bounds,
    perceptual_hash64_from_jpeg,
    png_ihdr_dimensions,
    runtime_pillow_version,
    sha256_bytes,
)
from mask_zip import MAX_ZIP_MEMBER_DECOMPRESSED_BYTES, read_mask_member_bytes
import validation
from freeze_exclusions_v2 import (
    extract_v2_accepted_fingerprints,
    extract_v2_rejection_encoded_sha256,
)
from validation import (
    ATTEMPT_LIST_SCHEMA_V1,
    ATTEMPT_LIST_SCHEMA_V2,
    ATTEMPT_LIST_SCHEMA_V3,
    CORRECTED_PRIMARY_SHORTLIST_SHA256,
    DUPLICATE_POLICY_SCHEMA_V1,
    DUPLICATE_POLICY_SCHEMA_V2,
    DUPLICATE_POLICY_SCHEMA_V3,
    FINGERPRINT_INDEX_SCHEMA_V2,
    FINGERPRINT_INDEX_SCHEMA_V3,
    METADATA_PROFILE_V3,
    METADATA_PROFILE_V4,
    InfrastructureFailure,
    PRIOR_FINGERPRINT_INDEX_SHA256,
    validate_additive_exclusion_audit_v2,
    validate_additive_exclusion_audit_v3,
    PHASH_HAMMING_REJECT_AT_MOST,
    PERCEPTUAL_HASH_ALGORITHM_ID,
    PERCEPTUAL_HASH_RESAMPLER,
    CurateError,
    bind_frozen_attempt_list,
    load_fingerprint_index,
    load_private_photo_manifest_file,
    read_bounded_file_bytes,
    reject_non_identity_jpeg_exif_orientation,
    repo_root_from_here,
    require_external_new_directory,
    require_json_object,
    require_string,
    resolve_existing_input,
    sanitize_producer_record,
    validate_attempt_list,
    validate_duplicate_policy,
    validate_exclusion_audit,
    validate_fingerprint_index_exclusion_coverage,
    validate_png_mask_framing,
    validate_reserve_manifest,
    verify_attempt_row_matches_source,
)

JSON_LD_RE = re.compile(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)
PHOTO_LICENSE = "https://creativecommons.org/licenses/by/2.0/"
NOT_ATTEMPTED_INFRASTRUCTURE_STOP = "not-attempted-due-infrastructure-stop"
PRIVATE_EVIDENCE_DIR = "private-evidence"
_REJECTION_SOURCE_EVIDENCE_SKIP_REASONS = frozenset(
    {
        "concurrency limit exceeded",
        "output path already exists",
        "output path must not be a symlink",
        "output relative path escapes output directory",
        "output relative path invalid",
        "private evidence byte cap exceeded",
        "private evidence filename invalid",
    }
)


@dataclass(frozen=True)
class DuplicateState:
    encoded_sha256: set[str]
    decoded_rgb_sha256: set[str]
    perceptual_hash64: set[int]


class ConcurrencyGate:
    def __init__(self, limit: int) -> None:
        self._semaphore = threading.BoundedSemaphore(limit)

    def acquire(self) -> None:
        if not self._semaphore.acquire(blocking=False):
            raise CurateError("concurrency limit exceeded")

    def release(self) -> None:
        self._semaphore.release()


def flickr_photo_id_from_landing(url: str) -> str:
    validate_flickr_landing_url(url)
    return url.rstrip("/").split("/")[-1]


def normalized_flickr_landing(url: str) -> str:
    validate_flickr_landing_url(url)
    return url.rstrip("/")


def verify_flickr_license_page(body: bytes, *, landing_url: str) -> dict[str, Any]:
    if len(body) > MAX_FLICKR_PAGE_BYTES:
        raise CurateError("flickr-page-byte-cap-exceeded")
    expected_landing = normalized_flickr_landing(landing_url)
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CurateError("flickr-page-not-utf8") from error
    matches: list[tuple[dict[str, Any], str]] = []
    for block in JSON_LD_RE.findall(text):
        try:
            value = json.loads(block)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        items = value.get("@graph", [value])
        if not isinstance(items, list):
            items = [items]
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("@type") != "ImageObject":
                continue
            page_url_raw = item.get("acquireLicensePage")
            if not isinstance(page_url_raw, str):
                continue
            try:
                page_url = normalized_flickr_landing(page_url_raw)
            except CurateError:
                continue
            if page_url != expected_landing:
                continue
            if item.get("license") != PHOTO_LICENSE:
                continue
            matches.append((item, block))
    if len(matches) != 1:
        raise CurateError("flickr-license-jsonld-rejected")
    _item, block = matches[0]
    block_bytes = block.encode("utf-8")
    return {
        "flickrPhotoId": flickr_photo_id_from_landing(landing_url),
        "flickrPageBodySha256": sha256_bytes(body),
        "structuredBlockSha256": sha256_bytes(block_bytes),
        "matchedJsonLdBlockSha256": sha256_bytes(block_bytes),
        "verifiedLicenseUrl": PHOTO_LICENSE,
    }


def load_duplicate_state(index_payload: dict[str, Any]) -> DuplicateState:
    encoded: set[str] = set()
    decoded: set[str] = set()
    phash: set[int] = set()
    for row in index_payload["entries"]:
        encoded.add(row["encodedSha256"])
        decoded.add(row["decodedRgbSha256"])
        phash.add(int(row["perceptualHash64"], 16))
    exact_only = index_payload.get("exactOnlyEncodedSha256")
    if isinstance(exact_only, list):
        for index, item in enumerate(exact_only):
            encoded.add(validation.require_sha256_hex(item, f"exactOnlyEncodedSha256[{index}]"))
    return DuplicateState(encoded_sha256=encoded, decoded_rgb_sha256=decoded, perceptual_hash64=phash)


def acquisition_exit_code(report: dict[str, Any]) -> int:
    status = require_string(report.get("status"), "acquisition report.status")
    if status == "complete":
        return 0
    if status == "quota-shortfall":
        return 2
    if status == "infrastructure-stopped":
        return 3
    return 2


def check_duplicate_policy(
    *,
    jpeg_bytes: bytes,
    state: DuplicateState,
    accepted: DuplicateState,
) -> None:
    encoded = sha256_bytes(jpeg_bytes)
    if encoded in state.encoded_sha256 or encoded in accepted.encoded_sha256:
        raise CurateError("encoded-jpeg-sha256-duplicate")
    phash, decoded_rgb, _width, _height = perceptual_hash64_from_jpeg(jpeg_bytes)
    if decoded_rgb in state.decoded_rgb_sha256 or decoded_rgb in accepted.decoded_rgb_sha256:
        raise CurateError("decoded-rgb-sha256-duplicate")
    for prior in state.perceptual_hash64 | accepted.perceptual_hash64:
        if hamming_distance64(phash, prior) <= PHASH_HAMMING_REJECT_AT_MOST:
            raise CurateError("perceptual-hash-near-duplicate")


def load_row_lookup(manifest_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for row in manifest_rows:
        case_id = require_string(row["caseId"], "caseId")
        if case_id in lookup:
            raise CurateError("duplicate-case-id-in-manifest")
        lookup[case_id] = row
    return lookup


def resolve_staged_output_path(output_dir: Path, relative_path: str) -> Path:
    text = require_string(relative_path, "output relative path")
    if not text or text != text.strip():
        raise CurateError("output relative path invalid")
    if text.startswith(("/", "\\")) or "\\" in text:
        raise CurateError("output relative path invalid")
    parts = Path(text)
    if parts.is_absolute() or ".." in parts.parts:
        raise CurateError("output relative path invalid")
    base = output_dir.resolve()
    destination = (output_dir / text).resolve()
    try:
        destination.relative_to(base)
    except ValueError as error:
        raise CurateError("output relative path escapes output directory") from error
    if destination.is_symlink():
        raise CurateError("output path must not be a symlink")
    return destination


def _private_evidence_relative_path(case_id: str, filename: str) -> str:
    validation.require_opaque_case_id(case_id, "caseId")
    name = require_string(filename, "private evidence filename")
    if not name or name != name.strip() or name.startswith("."):
        raise CurateError("private evidence filename invalid")
    if "/" in name or "\\" in name:
        raise CurateError("private evidence filename invalid")
    return f"{PRIVATE_EVIDENCE_DIR}/{case_id}/{name}"


def _persist_private_evidence_file(
    output_dir: Path,
    *,
    case_id: str,
    filename: str,
    payload: bytes,
    max_bytes: int,
) -> dict[str, str]:
    if len(payload) > max_bytes:
        raise CurateError("private evidence byte cap exceeded")
    rel = _private_evidence_relative_path(case_id, filename)
    destination = resolve_staged_output_path(output_dir, rel)
    atomic_write_bytes(destination, payload)
    return {
        "storedBytesPath": rel,
        "storedBytesSha256": sha256_bytes(payload),
    }


def _record_flickr_landing_evidence(
    output_dir: Path,
    *,
    case_id: str,
    attempt_index: int,
    landing_url: str,
    http_status: int,
    body: bytes,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "sourceLandingUrl": landing_url,
        "httpStatus": http_status,
    }
    if not body:
        return record
    if len(body) > MAX_FLICKR_PAGE_BYTES:
        raise CurateError("flickr-page-byte-cap-exceeded")
    record["responseBodySha256"] = sha256_bytes(body)
    stored = _persist_private_evidence_file(
        output_dir,
        case_id=case_id,
        filename=f"flickr-landing-{attempt_index:04d}.bin",
        payload=body,
        max_bytes=MAX_FLICKR_PAGE_BYTES,
    )
    record.update(stored)
    return record


def _record_rejection_source_evidence(
    output_dir: Path,
    *,
    case_id: str,
    attempt_index: int,
    reason_code: str,
    jpeg_bytes: bytes | None = None,
    mask_bytes: bytes | None = None,
) -> dict[str, Any]:
    evidence: dict[str, Any] = {"reasonCode": reason_code}
    if jpeg_bytes is not None:
        if len(jpeg_bytes) > MAX_JPEG_RESPONSE_BYTES:
            raise CurateError("private evidence byte cap exceeded")
        evidence["jpeg"] = _persist_private_evidence_file(
            output_dir,
            case_id=case_id,
            filename=f"rejection-{attempt_index:04d}-{reason_code}.jpg",
            payload=jpeg_bytes,
            max_bytes=MAX_JPEG_RESPONSE_BYTES,
        )
    if mask_bytes is not None:
        if len(mask_bytes) > MAX_ZIP_MEMBER_DECOMPRESSED_BYTES:
            raise CurateError("private evidence byte cap exceeded")
        evidence["mask"] = _persist_private_evidence_file(
            output_dir,
            case_id=case_id,
            filename=f"rejection-{attempt_index:04d}-{reason_code}.png",
            payload=mask_bytes,
            max_bytes=MAX_ZIP_MEMBER_DECOMPRESSED_BYTES,
        )
    return evidence


def _maybe_attach_rejection_source_evidence(
    attempt_private: dict[str, Any],
    output_dir: Path,
    *,
    case_id: str,
    attempt_index: int,
    reason_code: str,
    jpeg_bytes: bytes | None,
    mask_bytes: bytes | None,
    source_bytes_downloaded: bool,
) -> None:
    if "rejectionSourceEvidence" in attempt_private:
        return
    if not source_bytes_downloaded:
        return
    if jpeg_bytes is None and mask_bytes is None:
        return
    if reason_code in _REJECTION_SOURCE_EVIDENCE_SKIP_REASONS:
        return
    attempt_private["rejectionSourceEvidence"] = _record_rejection_source_evidence(
        output_dir,
        case_id=case_id,
        attempt_index=attempt_index,
        reason_code=reason_code,
        jpeg_bytes=jpeg_bytes,
        mask_bytes=mask_bytes,
    )


def atomic_write_bytes(destination: Path, payload: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = destination.with_name(f".{destination.name}.tmp")
    if tmp_path.exists() or destination.exists():
        raise CurateError("output path already exists")
    try:
        tmp_path.write_bytes(payload)
        tmp_path.replace(destination)
    except OSError as error:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise InfrastructureFailure("output-write-failure") from error


def _commit_admitted_assets(
    *,
    output_dir: Path,
    image_rel: str,
    jpeg_bytes: bytes,
    mask_rel: str | None,
    mask_bytes: bytes | None,
) -> None:
    image_destination = resolve_staged_output_path(output_dir, image_rel)
    mask_destination = resolve_staged_output_path(output_dir, mask_rel) if mask_rel is not None else None
    try:
        atomic_write_bytes(image_destination, jpeg_bytes)
        if mask_destination is not None and mask_bytes is not None:
            atomic_write_bytes(mask_destination, mask_bytes)
    except InfrastructureFailure:
        if image_destination.exists():
            try:
                image_destination.unlink()
            except OSError as error:
                raise InfrastructureFailure("output-write-failure") from error
        raise


def _bind_acquisition_inputs(
    *,
    duplicate_policy: dict[str, Any],
    fingerprint_index: dict[str, Any],
    fingerprint_index_sha256: str,
    exclusion_audit_sha256: str,
    excluded_encoded_sha256: set[str],
) -> None:
    validate_duplicate_policy(
        duplicate_policy,
        fingerprint_index_sha256=fingerprint_index_sha256,
        exclusion_audit_sha256=exclusion_audit_sha256,
    )
    validate_fingerprint_index_exclusion_coverage(
        fingerprint_index,
        exclusion_audit_sha256=exclusion_audit_sha256,
        excluded_encoded_sha256=excluded_encoded_sha256,
    )
    if duplicate_policy["exclusionAuditSha256"] != exclusion_audit_sha256:
        raise CurateError("duplicate policy exclusion audit SHA-256 mismatch")
    if fingerprint_index["exclusionAuditSha256"] != exclusion_audit_sha256:
        raise CurateError("fingerprint index exclusion audit SHA-256 mismatch")


def _load_exclusions_for_acquire(args: argparse.Namespace, exclusion_path: Path) -> dict[str, Any]:
    expected_v2 = getattr(args, "expected_exclusion_audit_sha256", None)
    if expected_v2:
        expected = require_string(expected_v2, "expected exclusion audit sha256")
        if expected == validation.EXCLUSION_AUDIT_V2_SHA256:
            return validate_additive_exclusion_audit_v2(exclusion_path, expected_sha256=expected)
        return validate_additive_exclusion_audit_v3(exclusion_path, expected_sha256=expected)
    return validate_exclusion_audit(exclusion_path)


def cmd_freeze_duplicate_policy(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    fingerprint_path = resolve_existing_input(Path(args.fingerprint_index), repo_root, "fingerprint index")
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    exclusions = _load_exclusions_for_acquire(args, exclusion_path)
    _payload, fingerprint_sha256 = load_fingerprint_index(
        fingerprint_path,
        exclusion_audit_sha256=exclusions["auditSha256"],
        excluded_encoded_sha256=exclusions["excludedImageSha256"],
    )
    index_schema = _payload["schemaVersion"]
    policy_schema = {
        validation.FINGERPRINT_INDEX_SCHEMA_V1: DUPLICATE_POLICY_SCHEMA_V1,
        FINGERPRINT_INDEX_SCHEMA_V2: DUPLICATE_POLICY_SCHEMA_V2,
        FINGERPRINT_INDEX_SCHEMA_V3: DUPLICATE_POLICY_SCHEMA_V3,
    }.get(index_schema)
    if policy_schema is None:
        raise CurateError("unsupported fingerprint index schema for duplicate policy")
    policy = {
        "schemaVersion": policy_schema,
        "status": "frozen-pre-acquisition",
        "fingerprintIndexSha256": fingerprint_sha256,
        "exclusionAuditSha256": exclusions["auditSha256"],
        "perceptualHashAlgorithmId": PERCEPTUAL_HASH_ALGORITHM_ID,
        "perceptualHashResampler": PERCEPTUAL_HASH_RESAMPLER,
        "pillowVersion": runtime_pillow_version(),
        "hammingRejectAtMost": PHASH_HAMMING_REJECT_AT_MOST,
        "encodedSha256Reject": True,
        "decodedRgbSha256Reject": True,
    }
    if policy["schemaVersion"] == DUPLICATE_POLICY_SCHEMA_V2:
        policy["exactOnlyEncodedSha256Reject"] = True
    elif policy["schemaVersion"] == DUPLICATE_POLICY_SCHEMA_V3:
        policy["exactOnlyEncodedSha256Reject"] = True
    elif policy["schemaVersion"] != DUPLICATE_POLICY_SCHEMA_V1:
        raise CurateError("unsupported fingerprint index schema for duplicate policy")
    validate_duplicate_policy(policy, fingerprint_index_sha256=fingerprint_sha256, exclusion_audit_sha256=exclusions["auditSha256"])
    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / "photo-duplicate-policy.json").write_text(
        json.dumps(policy, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return 0


def cmd_freeze_fingerprint_index_v2(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    prior_index_path = resolve_existing_input(Path(args.prior_fingerprint_index), repo_root, "prior fingerprint index")
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")
    report_path = resolve_existing_input(Path(args.v2_acquisition_report), repo_root, "v2 acquisition report")
    receipts_path = resolve_existing_input(Path(args.v2_acquisition_receipts), repo_root, "v2 acquisition receipts")
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    expected_prior = require_string(args.prior_fingerprint_index_sha256, "prior fingerprint index sha256")
    prior_payload = validation.load_fingerprint_index_for_v2_merge(
        prior_index_path,
        expected_sha256=expected_prior,
    )
    exclusions = validate_additive_exclusion_audit_v2(
        exclusion_path,
        expected_sha256=require_string(args.expected_exclusion_audit_sha256, "expected exclusion audit sha256"),
    )
    report_raw, report_digest = read_bounded_file_bytes(
        report_path,
        max_bytes=8 * 1024 * 1024,
        label="v2 acquisition report",
    )
    if args.v2_acquisition_report_sha256 and report_digest != args.v2_acquisition_report_sha256:
        raise CurateError("v2 acquisition report SHA-256 mismatch")
    report = validation.require_json_object(
        validation.loads_strict_json(report_raw.decode("utf-8"), label="v2 acquisition report"),
        "v2 acquisition report",
    )
    receipts_raw, receipts_digest = read_bounded_file_bytes(
        receipts_path,
        max_bytes=16 * 1024 * 1024,
        label="v2 acquisition receipts",
    )
    if args.v2_acquisition_receipts_sha256 and receipts_digest != args.v2_acquisition_receipts_sha256:
        raise CurateError("v2 acquisition receipts SHA-256 mismatch")
    receipts = validation.require_json_object(
        validation.loads_strict_json(receipts_raw.decode("utf-8"), label="v2 acquisition receipts"),
        "v2 acquisition receipts",
    )
    entries = [dict(row) for row in prior_payload["entries"]]
    seen_encoded = {row["encodedSha256"] for row in entries}
    for row in extract_v2_accepted_fingerprints(report):
        if row["encodedSha256"] in seen_encoded:
            raise CurateError("accepted v2 fingerprint encoded SHA duplicates prior index")
        seen_encoded.add(row["encodedSha256"])
        entries.append(row)
    exact_only = extract_v2_rejection_encoded_sha256(receipts)
    for digest in exact_only:
        if digest in seen_encoded:
            raise CurateError("rejection encoded SHA duplicates complete fingerprint entry")
    index_payload = {
        "schemaVersion": FINGERPRINT_INDEX_SCHEMA_V2,
        "exclusionAuditSha256": exclusions["auditSha256"],
        "perceptualHashAlgorithmId": PERCEPTUAL_HASH_ALGORITHM_ID,
        "perceptualHashResampler": PERCEPTUAL_HASH_RESAMPLER,
        "pillowVersion": prior_payload["pillowVersion"],
        "entries": entries,
        "exactOnlyEncodedSha256": exact_only,
    }
    validated = validation.validate_fingerprint_index(index_payload, require_runtime_pillow_match=False)
    validation.validate_fingerprint_index_exclusion_coverage(
        validated,
        exclusion_audit_sha256=exclusions["auditSha256"],
        excluded_encoded_sha256=exclusions["excludedImageSha256"],
    )
    output_dir.mkdir(parents=True, exist_ok=False)
    out_path = output_dir / "prior-fingerprint-index-v2.json"
    out_path.write_text(json.dumps(validated, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


def _read_retained_jpeg(source_root: Path, relative_path: str, expected_sha256: str) -> tuple[bytes, str]:
    if not source_root.is_absolute() or source_root.is_symlink() or not source_root.is_dir():
        raise CurateError("v3 acquisition source root must be an absolute non-symlink directory")
    root_real = source_root.resolve()
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts or "\\" in relative_path or not relative.parts:
        raise CurateError("retained JPEG path is not a safe relative path")
    candidate = source_root
    for part in relative.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise CurateError("retained JPEG path crosses a symlink")
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root_real)
    except ValueError as error:
        raise CurateError("retained JPEG path escapes acquisition source root") from error
    raw, digest = read_bounded_file_bytes(resolved, max_bytes=MAX_JPEG_BYTES, label="retained v3 JPEG")
    if digest != expected_sha256:
        raise CurateError("retained v3 JPEG SHA-256 mismatch")
    if len(raw) < 4 or not raw.startswith(b"\xff\xd8"):
        raise CurateError("retained v3 asset is not a JPEG")
    return raw, digest


def cmd_freeze_fingerprint_index_v3(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    prior_index_path = resolve_existing_input(Path(args.prior_fingerprint_index), repo_root, "prior fingerprint index")
    prior_audit_path = resolve_existing_input(Path(args.prior_exclusion_audit_v2), repo_root, "prior v2 exclusion audit")
    v3_audit_path = resolve_existing_input(Path(args.v3_exclusion_audit), repo_root, "v3 exclusion audit")
    report_path = resolve_existing_input(Path(args.v3_acquisition_report), repo_root, "v3 acquisition report")
    receipts_path = resolve_existing_input(Path(args.v3_acquisition_receipts), repo_root, "v3 acquisition receipts")
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")

    prior_audit = validation.validate_additive_exclusion_audit_v2(
        prior_audit_path, expected_sha256=validation.EXCLUSION_AUDIT_V2_SHA256
    )
    v3_audit = validation.validate_additive_exclusion_audit_v3(
        v3_audit_path,
        expected_sha256=require_string(args.expected_v3_exclusion_audit_sha256, "v3 exclusion audit sha256"),
    )
    prior_payload, prior_index_sha = load_fingerprint_index(
        prior_index_path,
        exclusion_audit_sha256=prior_audit["auditSha256"],
        excluded_encoded_sha256=prior_audit["excludedImageSha256"],
    )
    if prior_index_sha != args.prior_fingerprint_index_sha256:
        raise CurateError("prior fingerprint index SHA-256 mismatch")
    if prior_payload["schemaVersion"] != FINGERPRINT_INDEX_SCHEMA_V2:
        raise CurateError("prior fingerprint index must use complete v2 schema")
    if prior_payload.get("exactOnlyEncodedSha256") != []:
        raise CurateError("prior v2 fingerprint index must have complete fingerprint coverage")

    report_raw, report_sha = read_bounded_file_bytes(
        report_path, max_bytes=8 * 1024 * 1024, label="v3 acquisition report"
    )
    if report_sha != v3_audit["payload"]["v3AcquisitionReportSha256"]:
        raise CurateError("v3 acquisition report differs from frozen exclusion audit")
    report = validation.require_json_object(
        validation.loads_strict_json(report_raw.decode("utf-8"), label="v3 acquisition report"),
        "v3 acquisition report",
    )
    receipts_raw, receipts_sha = read_bounded_file_bytes(
        receipts_path, max_bytes=16 * 1024 * 1024, label="v3 acquisition receipts"
    )
    if receipts_sha != v3_audit["payload"]["v3AcquisitionPrivateReceiptsSha256"]:
        raise CurateError("v3 acquisition receipts differ from frozen exclusion audit")
    receipts = validation.require_json_object(
        validation.loads_strict_json(receipts_raw.decode("utf-8"), label="v3 acquisition receipts"),
        "v3 acquisition receipts",
    )
    if report.get("status") != "quota-shortfall":
        raise CurateError("v3 acquisition report status mismatch")
    source_root = Path(args.v3_acquisition_dir).absolute()
    for component in (source_root, *source_root.parents):
        if component.is_symlink():
            raise CurateError("v3 acquisition source directory path must not cross a symlink")
    prior_entries = [dict(row) for row in prior_payload["entries"]]
    seen_encoded = {row["encodedSha256"] for row in prior_entries}
    additions: list[dict[str, str]] = []
    total_bytes = 0

    accepted = report.get("records")
    receipt_attempts = receipts.get("attempts")
    if not isinstance(accepted, list) or not isinstance(receipt_attempts, list):
        raise CurateError("v3 fingerprint source rows are malformed")
    sources: list[tuple[str, str, str]] = []
    for index, record_value in enumerate(accepted):
        record = validation.require_json_object(record_value, f"v3 report.records[{index}]")
        sources.append(
            (
                validation.require_opaque_case_id(record.get("caseId"), f"records[{index}].caseId"),
                require_string(record.get("imageRelPath"), f"records[{index}].imageRelPath"),
                validation.require_sha256_hex(record.get("encodedSha256"), f"records[{index}].encodedSha256"),
            )
        )
    for index, attempt_value in enumerate(receipt_attempts):
        attempt = validation.require_json_object(attempt_value, f"v3 receipts.attempts[{index}]")
        evidence_value = attempt.get("rejectionSourceEvidence")
        if evidence_value is None:
            continue
        evidence = validation.require_json_object(evidence_value, f"receipts.attempts[{index}].rejectionSourceEvidence")
        jpeg_value = evidence.get("jpeg")
        if jpeg_value is None:
            continue
        jpeg = validation.require_json_object(jpeg_value, f"receipts.attempts[{index}].rejectionSourceEvidence.jpeg")
        sources.append(
            (
                validation.require_opaque_case_id(attempt.get("caseId"), f"receipts.attempts[{index}].caseId"),
                require_string(jpeg.get("storedBytesPath"), f"receipts.attempts[{index}].storedBytesPath"),
                validation.require_sha256_hex(
                    jpeg.get("storedBytesSha256"), f"receipts.attempts[{index}].storedBytesSha256"
                ),
            )
        )

    seen_case_ids: set[str] = set()
    for case_id, relative_path, expected_sha in sources:
        if case_id in seen_case_ids:
            raise CurateError("v3 fingerprint source contains duplicate case IDs")
        seen_case_ids.add(case_id)
        jpeg_bytes, encoded_sha = _read_retained_jpeg(source_root, relative_path, expected_sha)
        if encoded_sha in seen_encoded:
            raise CurateError("retained v3 JPEG duplicates a prior encoded SHA")
        phash, decoded_sha, _width, _height = perceptual_hash64_from_jpeg(jpeg_bytes)
        entry = {
            "encodedSha256": encoded_sha,
            "decodedRgbSha256": decoded_sha,
            "perceptualHash64": f"{phash:016x}",
        }
        seen_encoded.add(encoded_sha)
        additions.append(entry)
        total_bytes += len(jpeg_bytes)

    expected_retained = set(v3_audit["payload"]["v3AcquisitionEncodedImageSha256"])
    actual_retained = {row["encodedSha256"] for row in additions}
    if actual_retained != expected_retained:
        raise CurateError("retained v3 JPEG fingerprint set differs from exclusion audit")
    index_payload = {
        "schemaVersion": FINGERPRINT_INDEX_SCHEMA_V3,
        "exclusionAuditSha256": v3_audit["auditSha256"],
        "perceptualHashAlgorithmId": PERCEPTUAL_HASH_ALGORITHM_ID,
        "perceptualHashResampler": PERCEPTUAL_HASH_RESAMPLER,
        "pillowVersion": prior_payload["pillowVersion"],
        "entries": prior_entries + sorted(additions, key=lambda row: row["encodedSha256"]),
        "exactOnlyEncodedSha256": [],
    }
    validated = validation.validate_fingerprint_index(index_payload, require_runtime_pillow_match=False)
    validate_fingerprint_index_exclusion_coverage(
        validated,
        exclusion_audit_sha256=v3_audit["auditSha256"],
        excluded_encoded_sha256=v3_audit["excludedImageSha256"],
    )
    output_dir.mkdir(parents=True, exist_ok=False)
    out_path = output_dir / "prior-fingerprint-index-v3.json"
    out_path.write_text(json.dumps(validated, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    receipt = {
        "schemaVersion": 1,
        "status": "metadata-only-complete-prior-fingerprint-index-v3",
        "priorFingerprintIndexPath": str(prior_index_path.resolve()),
        "priorFingerprintIndexSha256": prior_index_sha,
        "priorExclusionAuditSha256": prior_audit["auditSha256"],
        "v3ExclusionAuditSha256": v3_audit["auditSha256"],
        "v3AcquisitionReportSha256": report_sha,
        "v3AcquisitionPrivateReceiptsSha256": receipts_sha,
        "imagingModuleSha256": sha256_bytes(Path(__file__).with_name("imaging.py").read_bytes()),
        "pillowVersion": runtime_pillow_version(),
        "newJpegCount": len(additions),
        "newJpegBytes": total_bytes,
        "entryCount": len(validated["entries"]),
        "exactOnlyCount": 0,
        "fingerprintIndexSha256": sha256_bytes(out_path.read_bytes()),
    }
    (output_dir / "fingerprint-build-receipt.json").write_text(
        json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return 0


def cmd_freeze_attempt_list(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    primary_path = resolve_existing_input(Path(args.primary_manifest), repo_root, "primary manifest")
    reserve_path = resolve_existing_input(Path(args.reserve_manifest), repo_root, "reserve manifest")
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    primary_expected = args.primary_shortlist_sha256 or CORRECTED_PRIMARY_SHORTLIST_SHA256
    primary = load_private_photo_manifest_file(
        primary_path,
        expected_sha256=primary_expected,
    )
    reserve_raw, reserve_sha256 = read_bounded_file_bytes(
        reserve_path,
        max_bytes=validation.MAX_PRIVATE_MANIFEST_BYTES,
        label="reserve manifest",
    )
    reserve_payload = validation.require_json_object(
        validation.loads_strict_json(reserve_raw.decode("utf-8"), label="reserve manifest"),
        "reserve manifest",
    )
    validate_reserve_manifest(reserve_payload, primary_shortlist_sha256=primary["_sha256"])
    if args.metadata_profile == METADATA_PROFILE_V3:
        attempt_schema = ATTEMPT_LIST_SCHEMA_V2
    elif args.metadata_profile == METADATA_PROFILE_V4:
        attempt_schema = ATTEMPT_LIST_SCHEMA_V3
    else:
        attempt_schema = ATTEMPT_LIST_SCHEMA_V1
    attempts = build_attempt_list_rows(
        primary["rows"],
        reserve_payload["rows"],
        primary_shortlist_sha256=primary["_sha256"],
        reserve_commit_sha256=reserve_sha256,
        attempt_schema_version=attempt_schema,
        metadata_profile=(
            args.metadata_profile
            if attempt_schema in (ATTEMPT_LIST_SCHEMA_V2, ATTEMPT_LIST_SCHEMA_V3)
            else None
        ),
    )
    attempt_doc: dict[str, Any] = {
        "schemaVersion": attempt_schema,
        "selectionSeed": SEED,
        "primaryShortlistSha256": primary["_sha256"],
        "reserveCommitSha256": reserve_sha256,
        "attempts": attempts,
    }
    if attempt_schema in (ATTEMPT_LIST_SCHEMA_V2, ATTEMPT_LIST_SCHEMA_V3):
        attempt_doc["metadataProfile"] = args.metadata_profile
    validate_attempt_list(attempt_doc)
    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / "photo-acquisition-attempt-list.json").write_text(
        json.dumps(attempt_doc, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return 0


def _append_rejection(
    rejections: list[dict[str, Any]],
    private_receipts: list[dict[str, Any]],
    tally: Counter[str],
    http_status_tally: Counter[int],
    *,
    case_id: str,
    attempt_index: int,
    phase: str,
    expected: str,
    reason_code: str,
    http_status: int | None = None,
    private_extension: dict[str, Any] | None = None,
) -> None:
    entry: dict[str, Any] = {
        "caseId": case_id,
        "attemptIndex": attempt_index,
        "phase": phase,
        "expectedPresence": expected,
        "status": reason_code,
    }
    if http_status is not None:
        entry["http"] = {"httpStatus": http_status}
        http_status_tally[http_status] += 1
    rejections.append(entry)
    receipt: dict[str, Any] = {
        "caseId": case_id,
        "attemptIndex": attempt_index,
        "outcome": "rejected",
        "reasonCode": reason_code,
    }
    if http_status is not None:
        receipt["httpStatus"] = http_status
    if private_extension:
        receipt.update(private_extension)
    private_receipts.append(receipt)
    tally[reason_code] += 1


def _append_not_attempted(
    rejections: list[dict[str, Any]],
    private_receipts: list[dict[str, Any]],
    *,
    case_id: str,
    attempt_index: int,
    phase: str,
    expected: str,
) -> None:
    rejections.append(
        {
            "caseId": case_id,
            "attemptIndex": attempt_index,
            "phase": phase,
            "expectedPresence": expected,
            "status": NOT_ATTEMPTED_INFRASTRUCTURE_STOP,
        }
    )
    private_receipts.append(
        {
            "caseId": case_id,
            "attemptIndex": attempt_index,
            "outcome": NOT_ATTEMPTED_INFRASTRUCTURE_STOP,
        }
    )


def _append_infrastructure_failure(
    rejections: list[dict[str, Any]],
    private_receipts: list[dict[str, Any]],
    tally: Counter[str],
    http_status_tally: Counter[int],
    *,
    case_id: str,
    attempt_index: int,
    phase: str,
    expected: str,
    reason_code: str,
    http_status: int | None = None,
    private_extension: dict[str, Any] | None = None,
) -> None:
    entry: dict[str, Any] = {
        "caseId": case_id,
        "attemptIndex": attempt_index,
        "phase": phase,
        "expectedPresence": expected,
        "status": reason_code,
    }
    if http_status is not None:
        entry["http"] = {"httpStatus": http_status}
        http_status_tally[http_status] += 1
    rejections.append(entry)
    receipt: dict[str, Any] = {
        "caseId": case_id,
        "attemptIndex": attempt_index,
        "outcome": "infrastructure-stop",
        "reasonCode": reason_code,
    }
    if http_status is not None:
        receipt["httpStatus"] = http_status
    if private_extension:
        receipt.update(private_extension)
    private_receipts.append(receipt)
    tally[reason_code] += 1


def _curate_error_reason_code(error: CurateError) -> str:
    message = str(error)
    if message and " " not in message and len(message) <= 96:
        return message
    return "candidate-processing-rejected"


def _persist_acquisition_artifacts(
    output_dir: Path,
    report: dict[str, Any],
    private_receipts: list[dict[str, Any]],
    rejections: list[dict[str, Any]],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "acquisition-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (output_dir / "acquisition-private-receipts.json").write_text(
        json.dumps({"schemaVersion": 1, "attempts": private_receipts}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (output_dir / "acquisition-failure-artifacts.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "rejections": rejections,
                "rejectionTally": report["rejectionTally"],
                "rejectionHttpStatusTally": report["rejectionHttpStatusTally"],
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


def run_acquisition(
    *,
    attempt_doc: dict[str, Any],
    primary_rows: list[dict[str, Any]],
    reserve_rows: list[dict[str, Any]],
    duplicate_policy: dict[str, Any],
    fingerprint_index: dict[str, Any],
    transport: HttpTransport,
    output_dir: Path,
    local_mask_archives: dict[str, Path] | None = None,
    exclusion_audit_sha256: str | None = None,
    excluded_encoded_sha256: set[str] | None = None,
    fingerprint_index_sha256: str | None = None,
    persist_artifacts: bool = False,
    primary_shortlist_sha256: str | None = None,
    reserve_commit_sha256: str | None = None,
) -> dict[str, Any]:
    if (
        exclusion_audit_sha256 is not None
        and excluded_encoded_sha256 is not None
        and fingerprint_index_sha256 is not None
    ):
        _bind_acquisition_inputs(
            duplicate_policy=duplicate_policy,
            fingerprint_index=fingerprint_index,
            fingerprint_index_sha256=fingerprint_index_sha256,
            exclusion_audit_sha256=exclusion_audit_sha256,
            excluded_encoded_sha256=excluded_encoded_sha256,
        )
    else:
        validate_duplicate_policy(
            duplicate_policy,
            fingerprint_index_sha256=duplicate_policy["fingerprintIndexSha256"],
        )
    attempts = bind_frozen_attempt_list(
        attempt_doc,
        primary_shortlist_sha256=primary_shortlist_sha256
        or require_string(attempt_doc["primaryShortlistSha256"], "primaryShortlistSha256"),
        reserve_commit_sha256=reserve_commit_sha256
        or require_string(attempt_doc["reserveCommitSha256"], "reserveCommitSha256"),
    )
    row_lookup = load_row_lookup(primary_rows + reserve_rows)
    for attempt_index, attempt in enumerate(attempts):
        source_row = row_lookup.get(attempt["caseId"])
        if source_row is None:
            raise CurateError("attempt-list-source-row-mismatch")
        verify_attempt_row_matches_source(attempt, source_row, attempt_index=attempt_index)
    prior_state = load_duplicate_state(fingerprint_index)
    accepted_state = DuplicateState(set(), set(), set())
    gate = ConcurrencyGate(2)
    admitted_present = 0
    admitted_absent = 0
    rejections: list[dict[str, Any]] = []
    private_receipts: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    tally: Counter[str] = Counter()
    http_status_tally: Counter[int] = Counter()
    infrastructure_stopped = False
    infrastructure_stop_reason: str | None = None

    images_dir = output_dir / "images"
    masks_dir = output_dir / "masks"
    images_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)

    for attempt_index, attempt in enumerate(attempts):
        if infrastructure_stopped:
            _append_not_attempted(
                rejections,
                private_receipts,
                case_id=attempt["caseId"],
                attempt_index=attempt_index,
                phase=attempt["phase"],
                expected=attempt["expectedPresence"],
            )
            continue
        if admitted_present >= POSITIVE_QUOTA and admitted_absent >= NEGATIVE_QUOTA:
            break
        expected = attempt["expectedPresence"]
        if expected == "present" and admitted_present >= POSITIVE_QUOTA:
            continue
        if expected == "absent" and admitted_absent >= NEGATIVE_QUOTA:
            continue
        case_id = attempt["caseId"]
        source_row = row_lookup[case_id]
        image_id = attempt["imageId"]
        landing_url = require_string(source_row["sourceUrls"]["originalLandingUrl"], "originalLandingUrl")
        gate.acquire()
        attempt_private: dict[str, Any] = {}
        jpeg_bytes: bytes | None = None
        mask_bytes: bytes | None = None
        source_bytes_downloaded = False
        try:
            validate_flickr_landing_url(landing_url)
            landing_response = transport.fetch(landing_url, byte_limit=MAX_FLICKR_PAGE_BYTES)
            attempt_private["flickrLandingEvidence"] = _record_flickr_landing_evidence(
                output_dir,
                case_id=case_id,
                attempt_index=attempt_index,
                landing_url=landing_url,
                http_status=landing_response.status,
                body=landing_response.body,
            )
            if landing_response.status != 200:
                if http_status_is_infrastructure_stop(landing_response.status):
                    raise InfrastructureFailure(
                        "http-infrastructure-stop",
                        http_status=landing_response.status,
                    )
                _append_rejection(
                    rejections,
                    private_receipts,
                    tally,
                    http_status_tally,
                    case_id=case_id,
                    attempt_index=attempt_index,
                    phase=attempt["phase"],
                    expected=expected,
                    reason_code="flickr-landing-http-rejected",
                    http_status=landing_response.status,
                    private_extension=attempt_private,
                )
                continue
            validate_resolved_url_unchanged(
                landing_url,
                landing_response.url,
                validator=validate_flickr_landing_url,
            )
            flickr_receipt = verify_flickr_license_page(landing_response.body, landing_url=landing_url)
            flickr_evidence = attempt_private["flickrLandingEvidence"]
            flickr_evidence["flickrPageBodySha256"] = flickr_receipt["flickrPageBodySha256"]
            flickr_evidence["structuredBlockSha256"] = flickr_receipt["structuredBlockSha256"]
            flickr_evidence["matchedJsonLdBlockSha256"] = flickr_receipt["matchedJsonLdBlockSha256"]
            flickr_evidence["verifiedLicenseUrl"] = flickr_receipt["verifiedLicenseUrl"]

            jpeg_url = build_open_images_jpeg_url(image_id)
            jpeg_response = transport.fetch(jpeg_url, byte_limit=MAX_JPEG_RESPONSE_BYTES)
            if jpeg_response.status != 200:
                if http_status_is_infrastructure_stop(jpeg_response.status):
                    raise InfrastructureFailure(
                        "http-infrastructure-stop",
                        http_status=jpeg_response.status,
                    )
                _append_rejection(
                    rejections,
                    private_receipts,
                    tally,
                    http_status_tally,
                    case_id=case_id,
                    attempt_index=attempt_index,
                    phase=attempt["phase"],
                    expected=expected,
                    reason_code="open-images-jpeg-http-rejected",
                    http_status=jpeg_response.status,
                    private_extension=attempt_private,
                )
                continue
            validate_resolved_url_unchanged(
                jpeg_url,
                jpeg_response.url,
                validator=lambda url: validate_open_images_jpeg_url(url, image_id=image_id),
            )
            jpeg_bytes = jpeg_response.body
            source_bytes_downloaded = True
            if len(jpeg_bytes) > MAX_JPEG_RESPONSE_BYTES:
                attempt_private["rejectionSourceEvidence"] = _record_rejection_source_evidence(
                    output_dir,
                    case_id=case_id,
                    attempt_index=attempt_index,
                    reason_code="jpeg-byte-cap-exceeded",
                    jpeg_bytes=jpeg_bytes[:MAX_JPEG_RESPONSE_BYTES],
                )
                _append_rejection(
                    rejections,
                    private_receipts,
                    tally,
                    http_status_tally,
                    case_id=case_id,
                    attempt_index=attempt_index,
                    phase=attempt["phase"],
                    expected=expected,
                    reason_code="jpeg-byte-cap-exceeded",
                    private_extension=attempt_private,
                )
                continue
            check_duplicate_policy(jpeg_bytes=jpeg_bytes, state=prior_state, accepted=accepted_state)
            reject_non_identity_jpeg_exif_orientation(jpeg_bytes)
            rgb_bytes, width, height = decode_jpeg_rgb_normalized(jpeg_bytes)
            decoded_rgb = sha256_bytes(rgb_bytes)
            phash, _decoded_repeat, width_repeat, height_repeat = perceptual_hash64_from_jpeg(jpeg_bytes)
            if width_repeat != width or height_repeat != height:
                raise CurateError("jpeg-dimension-mismatch-after-decode")
            mask_rel: str | None = None
            mask_bounds: list[int] | None = None
            if expected == "present":
                mask_meta = require_json_object(source_row.get("instanceMaskMetadata"), "instanceMaskMetadata")
                header_dims = require_json_object(mask_meta.get("pngHeaderDimensions"), "pngHeaderDimensions")
                expected_width = header_dims["width"]
                expected_height = header_dims["height"]
                if [width, height] != [expected_width, expected_height]:
                    attempt_private["rejectionSourceEvidence"] = _record_rejection_source_evidence(
                        output_dir,
                        case_id=case_id,
                        attempt_index=attempt_index,
                        reason_code="source-jpeg-canvas-mismatch",
                        jpeg_bytes=jpeg_bytes,
                    )
                    _append_rejection(
                        rejections,
                        private_receipts,
                        tally,
                        http_status_tally,
                        case_id=case_id,
                        attempt_index=attempt_index,
                        phase=attempt["phase"],
                        expected=expected,
                        reason_code="source-jpeg-canvas-mismatch",
                        private_extension=attempt_private,
                    )
                    continue
                mask_path = require_string(mask_meta.get("maskPath"), "maskPath")
                shard = image_id[0].lower()
                local_archive = (local_mask_archives or {}).get(shard)
                mask_bytes = read_mask_member_bytes(
                    mask_basename=mask_path,
                    image_id=image_id,
                    transport=transport,
                    local_archive=local_archive,
                )
                validate_png_mask_framing(mask_bytes)
                ihdr_width, ihdr_height = png_ihdr_dimensions(mask_bytes)
                if [ihdr_width, ihdr_height] != [width, height]:
                    attempt_private["rejectionSourceEvidence"] = _record_rejection_source_evidence(
                        output_dir,
                        case_id=case_id,
                        attempt_index=attempt_index,
                        reason_code="mask-png-ihdr-canvas-mismatch",
                        jpeg_bytes=jpeg_bytes,
                        mask_bytes=mask_bytes,
                    )
                    _append_rejection(
                        rejections,
                        private_receipts,
                        tally,
                        http_status_tally,
                        case_id=case_id,
                        attempt_index=attempt_index,
                        phase=attempt["phase"],
                        expected=expected,
                        reason_code="mask-png-ihdr-canvas-mismatch",
                        private_extension=attempt_private,
                    )
                    continue
                mask_pixels, decoded_mask_w, decoded_mask_h = decode_png_grayscale_values(mask_bytes)
                if [decoded_mask_w, decoded_mask_h] != [width, height]:
                    attempt_private["rejectionSourceEvidence"] = _record_rejection_source_evidence(
                        output_dir,
                        case_id=case_id,
                        attempt_index=attempt_index,
                        reason_code="mask-decode-canvas-mismatch",
                        jpeg_bytes=jpeg_bytes,
                        mask_bytes=mask_bytes,
                    )
                    _append_rejection(
                        rejections,
                        private_receipts,
                        tally,
                        http_status_tally,
                        case_id=case_id,
                        attempt_index=attempt_index,
                        phase=attempt["phase"],
                        expected=expected,
                        reason_code="mask-decode-canvas-mismatch",
                        private_extension=attempt_private,
                    )
                    continue
                mask_bounds = mask_nonzero_half_open_bounds(mask_pixels, width, height)
                mask_rel = f"masks/{case_id}/{mask_path}"

            image_rel = f"images/{case_id}.jpg"
            _commit_admitted_assets(
                output_dir=output_dir,
                image_rel=image_rel,
                jpeg_bytes=jpeg_bytes,
                mask_rel=mask_rel,
                mask_bytes=mask_bytes,
            )

            encoded = sha256_bytes(jpeg_bytes)
            accepted_state.encoded_sha256.add(encoded)
            accepted_state.decoded_rgb_sha256.add(decoded_rgb)
            accepted_state.perceptual_hash64.add(phash)
            producer = sanitize_producer_record(
                {
                    "caseId": case_id,
                    "target": attempt["target"],
                    "task": "classify-visible-object",
                    "image": {
                        "path": image_rel,
                        "sha256": encoded,
                        "width": width,
                        "height": height,
                    },
                    "locate": {"target": attempt["target"]},
                    "classify": {"task": "classify-visible-object"},
                }
            )
            record = {
                "caseId": case_id,
                "attemptIndex": attempt_index,
                "phase": attempt["phase"],
                "expectedPresence": expected,
                "producer": producer,
                "imageRelPath": image_rel,
                "encodedSha256": encoded,
                "decodedRgbSha256": decoded_rgb,
                "perceptualHash64": f"{phash:016x}",
            }
            if expected == "present":
                record["maskRelPath"] = mask_rel
                record["maskEncodedSha256"] = sha256_bytes(mask_bytes or b"")
                record["maskExtentHalfOpen"] = mask_bounds
                record["annotationBoxXyxy"] = source_row["targetBoxes"][0]["xyxy"]
                admitted_present += 1
            else:
                admitted_absent += 1
            records.append(record)
            private_receipts.append(
                {
                    "caseId": case_id,
                    "attemptIndex": attempt_index,
                    "outcome": "admitted",
                    **attempt_private,
                    "flickrPageBodySha256": flickr_receipt["flickrPageBodySha256"],
                    "structuredBlockSha256": flickr_receipt["structuredBlockSha256"],
                    "matchedJsonLdBlockSha256": flickr_receipt["matchedJsonLdBlockSha256"],
                    "verifiedLicenseUrl": flickr_receipt["verifiedLicenseUrl"],
                }
            )
        except InfrastructureFailure as error:
            infrastructure_stopped = True
            infrastructure_stop_reason = error.reason_code
            _append_infrastructure_failure(
                rejections,
                private_receipts,
                tally,
                http_status_tally,
                case_id=case_id,
                attempt_index=attempt_index,
                phase=attempt["phase"],
                expected=expected,
                reason_code=error.reason_code,
                http_status=error.http_status,
                private_extension=attempt_private or None,
            )
            report_partial = {
                "schemaVersion": 1,
                "status": "infrastructure-stopped",
                "infrastructureStopReason": error.reason_code,
                "selectionSeed": SEED,
                "attemptCount": len(attempts),
                "admitted": {"present": admitted_present, "absent": admitted_absent},
                "rejections": rejections,
                "rejectionTally": dict(sorted(tally.items())),
                "rejectionHttpStatusTally": {
                    str(key): value for key, value in sorted(http_status_tally.items())
                },
                "records": records,
            }
            if persist_artifacts:
                _persist_acquisition_artifacts(output_dir, report_partial, private_receipts, rejections)
        except CurateError as error:
            reason_code = _curate_error_reason_code(error)
            _maybe_attach_rejection_source_evidence(
                attempt_private,
                output_dir,
                case_id=case_id,
                attempt_index=attempt_index,
                reason_code=reason_code,
                jpeg_bytes=jpeg_bytes,
                mask_bytes=mask_bytes,
                source_bytes_downloaded=source_bytes_downloaded,
            )
            _append_rejection(
                rejections,
                private_receipts,
                tally,
                http_status_tally,
                case_id=case_id,
                attempt_index=attempt_index,
                phase=attempt["phase"],
                expected=expected,
                reason_code=reason_code,
                private_extension=attempt_private or None,
            )
        finally:
            gate.release()

    if infrastructure_stopped:
        status = "infrastructure-stopped"
    elif admitted_present == POSITIVE_QUOTA and admitted_absent == NEGATIVE_QUOTA:
        status = "complete"
    else:
        status = "quota-shortfall"
    report = {
        "schemaVersion": 1,
        "status": status,
        "selectionSeed": SEED,
        "attemptCount": len(attempts),
        "admitted": {"present": admitted_present, "absent": admitted_absent},
        "rejections": rejections,
        "rejectionTally": dict(sorted(tally.items())),
        "rejectionHttpStatusTally": {str(key): value for key, value in sorted(http_status_tally.items())},
        "records": records,
    }
    if infrastructure_stop_reason is not None:
        report["infrastructureStopReason"] = infrastructure_stop_reason
    if persist_artifacts:
        _persist_acquisition_artifacts(output_dir, report, private_receipts, rejections)
    return report


def cmd_acquire(args: argparse.Namespace) -> int:
    repo_root = repo_root_from_here(Path(__file__))
    output_dir = require_external_new_directory(Path(args.output_dir), repo_root, "output directory")
    attempt_path = resolve_existing_input(Path(args.attempt_list), repo_root, "attempt list")
    primary_path = resolve_existing_input(Path(args.primary_manifest), repo_root, "primary manifest")
    reserve_path = resolve_existing_input(Path(args.reserve_manifest), repo_root, "reserve manifest")
    duplicate_policy_path = resolve_existing_input(Path(args.duplicate_policy), repo_root, "duplicate policy")
    fingerprint_path = resolve_existing_input(Path(args.fingerprint_index), repo_root, "fingerprint index")
    exclusion_path = resolve_existing_input(Path(args.exclusion_audit), repo_root, "exclusion audit")

    exclusions = _load_exclusions_for_acquire(args, exclusion_path)
    fingerprint_index, fingerprint_sha256 = load_fingerprint_index(
        fingerprint_path,
        exclusion_audit_sha256=exclusions["auditSha256"],
        excluded_encoded_sha256=exclusions["excludedImageSha256"],
    )

    attempt_raw, attempt_digest = read_bounded_file_bytes(
        attempt_path,
        max_bytes=validation.MAX_ATTEMPT_LIST_BYTES,
        label="attempt list",
    )
    if getattr(args, "expected_attempt_list_sha256", None):
        expected_attempt = require_string(args.expected_attempt_list_sha256, "expected attempt list sha256")
        if attempt_digest != expected_attempt:
            raise CurateError("attempt list SHA-256 mismatch")
    attempt_doc = validation.require_json_object(
        validation.loads_strict_json(attempt_raw.decode("utf-8"), label="attempt list"),
        "attempt list",
    )
    duplicate_raw, _duplicate_digest = read_bounded_file_bytes(
        duplicate_policy_path,
        max_bytes=validation.MAX_DUPLICATE_POLICY_BYTES,
        label="duplicate policy",
    )
    duplicate_policy = validation.require_json_object(
        validation.loads_strict_json(duplicate_raw.decode("utf-8"), label="duplicate policy"),
        "duplicate policy",
    )
    validate_duplicate_policy(
        duplicate_policy,
        fingerprint_index_sha256=fingerprint_sha256,
        exclusion_audit_sha256=exclusions["auditSha256"],
    )

    primary_expected = args.primary_shortlist_sha256 or CORRECTED_PRIMARY_SHORTLIST_SHA256
    primary = load_private_photo_manifest_file(
        primary_path,
        expected_sha256=primary_expected,
    )
    reserve_raw, reserve_digest = read_bounded_file_bytes(
        reserve_path,
        max_bytes=validation.MAX_PRIVATE_MANIFEST_BYTES,
        label="reserve manifest",
    )
    reserve_payload = validation.require_json_object(
        validation.loads_strict_json(reserve_raw.decode("utf-8"), label="reserve manifest"),
        "reserve manifest",
    )
    validate_reserve_manifest(reserve_payload, primary_shortlist_sha256=primary["_sha256"])
    bind_frozen_attempt_list(
        attempt_doc,
        primary_shortlist_sha256=primary["_sha256"],
        reserve_commit_sha256=reserve_digest,
    )

    if args.transport != "live":
        raise CurateError("acquire CLI requires live transport")

    output_dir.mkdir(parents=True, exist_ok=False)
    transport: HttpTransport = UrllibHttpTransport()
    report = run_acquisition(
        attempt_doc=attempt_doc,
        primary_rows=primary["rows"],
        reserve_rows=reserve_payload["rows"],
        duplicate_policy=duplicate_policy,
        fingerprint_index=fingerprint_index,
        transport=transport,
        output_dir=output_dir,
        exclusion_audit_sha256=exclusions["auditSha256"],
        excluded_encoded_sha256=exclusions["excludedImageSha256"],
        fingerprint_index_sha256=fingerprint_sha256,
        persist_artifacts=True,
        primary_shortlist_sha256=primary["_sha256"],
        reserve_commit_sha256=reserve_digest,
    )
    return acquisition_exit_code(report)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="H8a fresh DEV photo acquisition")
    sub = parser.add_subparsers(dest="command", required=True)
    freeze_policy = sub.add_parser("freeze-duplicate-policy")
    freeze_policy.add_argument("--fingerprint-index", required=True)
    freeze_policy.add_argument("--exclusion-audit", required=True)
    freeze_policy.add_argument("--expected-exclusion-audit-sha256", default=None)
    freeze_policy.add_argument("--output-dir", required=True)
    freeze_policy.set_defaults(func=cmd_freeze_duplicate_policy)
    freeze_index = sub.add_parser("freeze-fingerprint-index-v2")
    freeze_index.add_argument("--prior-fingerprint-index", required=True)
    freeze_index.add_argument(
        "--prior-fingerprint-index-sha256",
        default=PRIOR_FINGERPRINT_INDEX_SHA256,
    )
    freeze_index.add_argument("--exclusion-audit", required=True)
    freeze_index.add_argument("--expected-exclusion-audit-sha256", required=True)
    freeze_index.add_argument("--v2-acquisition-report", required=True)
    freeze_index.add_argument("--v2-acquisition-report-sha256", default=None)
    freeze_index.add_argument("--v2-acquisition-receipts", required=True)
    freeze_index.add_argument("--v2-acquisition-receipts-sha256", default=None)
    freeze_index.add_argument("--output-dir", required=True)
    freeze_index.set_defaults(func=cmd_freeze_fingerprint_index_v2)
    freeze_index_v3 = sub.add_parser("freeze-fingerprint-index-v3")
    freeze_index_v3.add_argument("--prior-fingerprint-index", required=True)
    freeze_index_v3.add_argument("--prior-fingerprint-index-sha256", required=True)
    freeze_index_v3.add_argument("--prior-exclusion-audit-v2", required=True)
    freeze_index_v3.add_argument("--v3-exclusion-audit", required=True)
    freeze_index_v3.add_argument("--expected-v3-exclusion-audit-sha256", required=True)
    freeze_index_v3.add_argument("--v3-acquisition-report", required=True)
    freeze_index_v3.add_argument("--v3-acquisition-receipts", required=True)
    freeze_index_v3.add_argument("--v3-acquisition-dir", required=True)
    freeze_index_v3.add_argument("--output-dir", required=True)
    freeze_index_v3.set_defaults(func=cmd_freeze_fingerprint_index_v3)
    freeze_attempts = sub.add_parser("freeze-attempt-list")
    freeze_attempts.add_argument("--primary-manifest", required=True)
    freeze_attempts.add_argument("--primary-shortlist-sha256", default=None)
    freeze_attempts.add_argument("--reserve-manifest", required=True)
    freeze_attempts.add_argument("--metadata-profile", default=None)
    freeze_attempts.add_argument("--output-dir", required=True)
    freeze_attempts.set_defaults(func=cmd_freeze_attempt_list)
    acquire = sub.add_parser("acquire")
    acquire.add_argument("--attempt-list", required=True)
    acquire.add_argument("--primary-manifest", required=True)
    acquire.add_argument("--reserve-manifest", required=True)
    acquire.add_argument("--duplicate-policy", required=True)
    acquire.add_argument("--fingerprint-index", required=True)
    acquire.add_argument("--exclusion-audit", required=True)
    acquire.add_argument("--expected-exclusion-audit-sha256", default=None)
    acquire.add_argument("--primary-shortlist-sha256", default=None)
    acquire.add_argument("--expected-attempt-list-sha256", default=None)
    acquire.add_argument("--output-dir", required=True)
    acquire.add_argument("--transport", choices=("live", "injected"), default="live")
    acquire.set_defaults(func=cmd_acquire)
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
