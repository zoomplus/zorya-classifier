#!/usr/bin/env python3
"""Verify retained H8a photo acquisition bytes and export a private DEV fragment."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import acquire
import validation
from imaging import (
    MAX_JPEG_BYTES,
    decode_jpeg_rgb_normalized,
    decode_png_grayscale_values,
    hamming_distance64,
    mask_nonzero_half_open_bounds,
    perceptual_hash64_from_jpeg,
    sha256_bytes,
)

FRAGMENT_ID = "photo-disjoint-dev40-v1"
LICENSE_URL = validation.PHOTO_LICENSE
MAX_REPORT_BYTES = 8 * 1024 * 1024
MAX_RECEIPTS_BYTES = 16 * 1024 * 1024


def read_json(path: Path, maximum: int) -> tuple[dict[str, Any], bytes, str]:
    raw, digest = validation.read_bounded_file_bytes(path, max_bytes=maximum, label=path.name)
    payload = validation.require_json_object(
        validation.loads_strict_json(raw.decode("utf-8"), label=path.name), path.name
    )
    return payload, raw, digest


def write_json(path: Path, payload: Any) -> str:
    raw = (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    path.write_bytes(raw)
    return sha256_bytes(raw)


def artifact_ref(path: Path, root: Path) -> dict[str, str]:
    resolved = path.resolve(strict=True)
    try:
        relative = resolved.relative_to(root.resolve(strict=True)).as_posix()
    except ValueError as error:
        raise validation.CurateError("review artifact path escapes artifact root") from error
    return {"path": relative, "sha256": sha256_bytes(path.read_bytes())}


def pack_lsb0(pixels: bytes | bytearray | list[int]) -> bytes:
    packed = bytearray((len(pixels) + 7) // 8)
    for index, value in enumerate(pixels):
        if value not in (0, 1):
            raise validation.CurateError("binary mask contains a value outside {0,1}")
        if value:
            packed[index // 8] |= 1 << (index % 8)
    return bytes(packed)


def annotation_box(xyxy: list[float], width: int, height: int) -> dict[str, float]:
    x_min, y_min, x_max, y_max = xyxy
    values = [x_min * width, y_min * height, (x_max - x_min) * width, (y_max - y_min) * height]
    return {"left": values[0], "top": values[1], "width": values[2], "height": values[3]}


def build_fragment(
    *,
    acquisition_dir: Path,
    primary_path: Path,
    reserve_path: Path,
    attempt_path: Path,
    audit_path: Path,
    fingerprint_path: Path,
    review_input_path: Path,
    artifact_root: Path,
    output_dir: Path,
) -> dict[str, Any]:
    acquisition_dir = acquisition_dir.resolve(strict=True)
    root = artifact_root.resolve(strict=True)
    for path in (acquisition_dir, primary_path, reserve_path, attempt_path, audit_path, fingerprint_path):
        try:
            path.resolve(strict=True).relative_to(root)
        except ValueError as error:
            raise validation.CurateError("acquisition inputs must remain under the artifact root") from error
    output_dir = validation.require_external_new_directory(
        output_dir, validation.repo_root_from_here(Path(__file__)), "fragment output directory"
    )
    output_dir.mkdir(parents=True, exist_ok=False)

    report, _report_raw, report_sha = read_json(acquisition_dir / "acquisition-report.json", MAX_REPORT_BYTES)
    receipts, _receipts_raw, receipts_sha = read_json(
        acquisition_dir / "acquisition-private-receipts.json", MAX_RECEIPTS_BYTES
    )
    pins, _pins_raw, _pins_sha = read_json(review_input_path, validation.MAX_EXCLUSION_AUDIT_BYTES)
    _audit_payload, _audit_raw, audit_sha = read_json(audit_path, validation.MAX_EXCLUSION_AUDIT_BYTES)
    audit_view = validation.validate_disjoint_photo_exclusion_audit_v1(
        audit_path,
        expected_sha256=validation.require_string(pins.get("exclusionAuditSha256"), "exclusionAuditSha256"),
    )
    audit = audit_view["payload"]
    if pins.get("status") != "metadata-precommitted-awaiting-parent-review-before-image-fetch":
        raise validation.CurateError("pre-acquisition review receipt status mismatch")
    if report.get("status") != "complete" or report.get("selectionSeed") != audit.get("selectionSeed"):
        raise validation.CurateError("disjoint photo acquisition status or seed mismatch")
    if report_sha == "" or receipts_sha == "":
        raise validation.CurateError("acquisition receipts are missing their byte pins")
    if audit_sha != pins.get("exclusionAuditSha256"):
        raise validation.CurateError("pre-acquisition review exclusion audit pin mismatch")
    records = report.get("records")
    receipt_rows = receipts.get("attempts")
    if not isinstance(records, list) or not isinstance(receipt_rows, list):
        raise validation.CurateError("acquisition records/receipts are malformed")
    if report.get("admitted") != {"present": 16, "absent": 4} or len(records) != 20:
        raise validation.CurateError("acquisition did not admit exactly 16/4 cases")
    receipt_by_id: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(receipt_rows):
        row = validation.require_json_object(value, f"receipts.attempts[{index}]")
        case_id = validation.require_opaque_case_id(row.get("caseId"), "receipt.caseId")
        if case_id in receipt_by_id:
            raise validation.CurateError("acquisition receipts contain duplicate case IDs")
        receipt_by_id[case_id] = row

    primary_payload, primary_rows, primary_sha = _load_manifest(primary_path, reserve=False)
    reserve_payload, reserve_rows, reserve_sha = _load_manifest(reserve_path, reserve=True)
    attempt_payload, _attempt_raw, attempt_sha = read_json(attempt_path, validation.MAX_ATTEMPT_LIST_BYTES)
    attempts = validation.validate_attempt_list(attempt_payload)
    if report.get("selectionSeed") != attempt_payload.get("selectionSeed"):
        raise validation.CurateError("acquisition report seed differs from frozen attempt list")
    if primary_sha != pins.get("primaryShortlistSha256") or reserve_sha != pins.get("reserveCommitSha256"):
        raise validation.CurateError("acquisition manifests differ from metadata freeze")
    if attempt_sha != pins.get("attemptListSha256"):
        raise validation.CurateError("acquisition attempt list differs from metadata freeze")
    if primary_payload.get("selectionSeed") != audit.get("selectionSeed") or reserve_payload.get("selectionSeed") != audit.get("selectionSeed"):
        raise validation.CurateError("private manifests differ from disjoint selection seed")
    row_by_id = {row["caseId"]: row for row in primary_rows + reserve_rows}
    attempt_by_id = {row["caseId"]: (index, row) for index, row in enumerate(attempts)}
    if len(row_by_id) != 40 or len(attempt_by_id) != 40:
        raise validation.CurateError("frozen manifests/attempt list do not contain 40 unique cases")

    fingerprint_raw, fingerprint_sha = validation.read_bounded_file_bytes(
        fingerprint_path, max_bytes=validation.MAX_FINGERPRINT_INDEX_BYTES, label="fingerprint index"
    )
    fingerprint = validation.validate_fingerprint_index(
        validation.require_json_object(
            validation.loads_strict_json(fingerprint_raw.decode("utf-8"), label="fingerprint index"),
            "fingerprint index",
        )
    )
    validation.validate_fingerprint_index_exclusion_coverage(
        fingerprint,
        exclusion_audit_sha256=audit_sha,
        excluded_encoded_sha256=set(audit["encodedImageSha256"]),
    )
    if fingerprint_sha != pins.get("fingerprintIndexSha256"):
        raise validation.CurateError("fingerprint index differs from pre-acquisition pin")
    prior_state = acquire.load_duplicate_state(fingerprint)
    admitted_state = acquire.DuplicateState(set(), set(), set())

    accepted_ids: set[str] = set()
    image_ids: set[str] = set()
    source_groups: set[str] = set()
    records_by_id: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(records):
        record = validation.require_json_object(value, f"report.records[{index}]")
        case_id = validation.require_opaque_case_id(record.get("caseId"), "report.caseId")
        if case_id in records_by_id:
            raise validation.CurateError("acquisition report repeats a case ID")
        if case_id in audit["caseIds"]:
            raise validation.CurateError("acquired case ID overlaps historical photo case IDs")
        records_by_id[case_id] = record
        attempt_entry = attempt_by_id.get(case_id)
        attempt_index, attempt = attempt_entry if attempt_entry is not None else (None, None)
        private = row_by_id.get(case_id)
        receipt = receipt_by_id.get(case_id)
        if attempt is None or private is None or receipt is None:
            raise validation.CurateError("admitted record lacks a frozen input/receipt")
        if receipt.get("outcome") != "admitted" or record.get("attemptIndex") != attempt_index:
            raise validation.CurateError("admitted record differs from the frozen attempt/receipt")
        if record.get("expectedPresence") != private["expectedPresence"]:
            raise validation.CurateError("admitted record presence differs from private metadata")
        image_id = validation.require_string(private["imageId"], "private.imageId")
        source_group = validation.normalize_source_group(
            validation.require_string(private["authorProfileUrl"], "private.authorProfileUrl")
        )
        if image_id in audit["imageIds"] or source_group in audit["sourceGroups"]:
            raise validation.CurateError("acquired case overlaps historical image/source exclusions")
        if image_id in image_ids or source_group in source_groups:
            raise validation.CurateError("acquired cases repeat image or source group")
        accepted_ids.add(case_id)
        image_ids.add(image_id)
        source_groups.add(source_group)

    reports_by_index = sorted(records_by_id.values(), key=lambda item: item["attemptIndex"])
    receipt_map_digest_rows: list[dict[str, Any]] = []
    producers: list[dict[str, Any]] = []
    annotations: list[dict[str, Any]] = []
    controller: dict[str, str] = {}
    provenance: dict[str, Any] = {}
    references: dict[str, dict[str, Any]] = {}
    accepted_present = 0
    accepted_absent = 0
    new_fingerprints: list[dict[str, str]] = []

    for record in reports_by_index:
        case_id = record["caseId"]
        private = row_by_id[case_id]
        receipt = receipt_by_id[case_id]
        source_url = validation.require_string(private["sourceUrls"]["originalLandingUrl"], "originalLandingUrl")
        page_evidence = validation.require_json_object(receipt.get("flickrLandingEvidence"), "flickrLandingEvidence")
        page_path = acquire.resolve_staged_output_path(acquisition_dir, page_evidence["storedBytesPath"])
        page_bytes, page_sha = validation.read_bounded_file_bytes(
            page_path, max_bytes=acquire.MAX_FLICKR_PAGE_BYTES, label="Flickr license page"
        )
        if page_sha != page_evidence["storedBytesSha256"]:
            raise validation.CurateError("stored Flickr rights page SHA-256 mismatch")
        rights = acquire.verify_flickr_license_page(page_bytes, landing_url=source_url)
        for field, right_field in (
            ("flickrPageBodySha256", "flickrPageBodySha256"),
            ("structuredBlockSha256", "structuredBlockSha256"),
            ("matchedJsonLdBlockSha256", "matchedJsonLdBlockSha256"),
            ("verifiedLicenseUrl", "verifiedLicenseUrl"),
        ):
            if rights[right_field] != receipt.get(field):
                raise validation.CurateError(f"Flickr rights evidence {field} does not match receipt")
        if rights["verifiedLicenseUrl"] != LICENSE_URL:
            raise validation.CurateError("Flickr rights evidence is not CC BY 2.0")

        producer = validation.sanitize_producer_record(record.get("producer"))
        image_path = acquire.resolve_staged_output_path(acquisition_dir, record["imageRelPath"])
        jpeg_bytes, image_sha = validation.read_bounded_file_bytes(
            image_path, max_bytes=MAX_JPEG_BYTES, label="admitted JPEG"
        )
        if image_sha != record["encodedSha256"] or image_sha != producer["image"]["sha256"]:
            raise validation.CurateError("admitted JPEG source digest mismatch")
        decoded_rgb, width, height = decode_jpeg_rgb_normalized(jpeg_bytes)
        phash_value, decoded_sha, repeat_width, repeat_height = perceptual_hash64_from_jpeg(jpeg_bytes)
        phash = f"{phash_value:016x}"
        if decoded_sha != record["decodedRgbSha256"] or phash != record["perceptualHash64"]:
            raise validation.CurateError("admitted JPEG decoded/pHash receipt mismatch")
        if [width, height] != [repeat_width, repeat_height] or [width, height] != [producer["image"]["width"], producer["image"]["height"]]:
            raise validation.CurateError("admitted JPEG canvas differs from producer dimensions")
        if len(decoded_rgb) != width * height * 3:
            raise validation.CurateError("admitted RGB decode byte count mismatch")
        acquire.check_duplicate_policy(jpeg_bytes=jpeg_bytes, state=prior_state, accepted=admitted_state)
        admitted_state.encoded_sha256.add(image_sha)
        admitted_state.decoded_rgb_sha256.add(decoded_sha)
        admitted_state.perceptual_hash64.add(phash_value)
        new_fingerprints.append(
            {"encodedSha256": image_sha, "decodedRgbSha256": decoded_sha, "perceptualHash64": phash}
        )
        if image_sha in audit["encodedImageSha256"]:
            raise validation.CurateError("admitted JPEG encoded bytes overlap historical exclusion audit")

        case_id = producer["caseId"]
        producer_case = {
            "opaqueCaseId": case_id,
            "sourceBytesSha256": image_sha,
            "sourceCanvasWidth": width,
            "sourceCanvasHeight": height,
            "targetTaskText": producer["target"],
        }
        producers.append(producer_case)
        controller[case_id] = str(image_path.resolve())
        expected = private["expectedPresence"]
        if expected == "present":
            accepted_present += 1
            mask_meta = validation.validate_instance_mask_metadata(private.get("instanceMaskMetadata"))
            mask_bytes_path = acquire.resolve_staged_output_path(acquisition_dir, record["maskRelPath"])
            mask_png, mask_png_sha = validation.read_bounded_file_bytes(
                mask_bytes_path, max_bytes=acquire.MAX_ZIP_MEMBER_DECOMPRESSED_BYTES, label="official mask PNG"
            )
            if mask_png_sha != record["maskEncodedSha256"]:
                raise validation.CurateError("official mask PNG SHA-256 differs from acquisition report")
            validation.validate_png_mask_framing(mask_png)
            grayscale_values, mask_width, mask_height = decode_png_grayscale_values(mask_png)
            if [mask_width, mask_height] != [width, height]:
                raise validation.CurateError("official mask canvas differs from source JPEG")
            binary = bytes(1 if value != 0 else 0 for value in grayscale_values)
            extent = mask_nonzero_half_open_bounds(grayscale_values, width, height)
            if extent != record["maskExtentHalfOpen"] or extent is None:
                raise validation.CurateError("official mask extent differs from acquisition report")
            packed = pack_lsb0(binary)
            packed_sha = sha256_bytes(packed)
            mask_file = output_dir / "reference-masks" / f"{packed_sha}.binary-lsb0"
            mask_file.parent.mkdir(parents=True, exist_ok=True)
            mask_file.write_bytes(packed)
            references[packed_sha] = {
                "width": width,
                "height": height,
                "path": mask_file,
                "sha256": packed_sha,
            }
            boxes = private["targetBoxes"]
            if len(boxes) != 1:
                raise validation.CurateError("positive private row does not have exactly one official box")
            xyxy = boxes[0]["xyxy"]
            annotation = {
                "opaqueCaseId": case_id,
                "stratum": "photo",
                "sourceGroup": private["authorProfileUrl"],
                "expectedPresence": "present",
                "referenceBoxes": [annotation_box(xyxy, width, height)],
                "referenceMasks": [
                    {"width": width, "height": height, "packedBinarySha256": packed_sha}
                ],
                "exactOriginalCanvasMaskRef": True,
            }
            provenance[case_id] = {
                "provenance": "Open Images V5 source annotation and independently verified Flickr CC BY 2.0 license page",
                "admissionReview": "disjoint-photo-source-admission-review-v1",
                "sourceId": private["imageId"],
                "officialNormalizedBox": xyxy,
                "sourceMaskPngSha256": mask_png_sha,
                "sourceMaskPath": mask_meta["maskPath"],
                "actualSourceMaskBounds": extent,
                "licensePageSha256": page_sha,
                "licenseStructuredBlockSha256": rights["matchedJsonLdBlockSha256"],
            }
        else:
            accepted_absent += 1
            if private.get("targetBoxes") not in ([], None) or private.get("instanceMaskMetadata") not in (None, {}):
                raise validation.CurateError("negative row unexpectedly carries a target box or mask")
            annotation = {
                "opaqueCaseId": case_id,
                "stratum": "photo",
                "sourceGroup": private["authorProfileUrl"],
                "expectedPresence": "absent",
                "referenceBoxes": [],
                "referenceMasks": [],
                "exactOriginalCanvasMaskRef": False,
            }
            negative_evidence = validation.validate_negative_evidence(private["negativeEvidence"])
            provenance[case_id] = {
                "provenance": "Open Images V5 explicit human verification label and independently verified Flickr CC BY 2.0 license page",
                "admissionReview": "disjoint-photo-source-admission-review-v1",
                "sourceId": private["imageId"],
                "negativeEvidence": negative_evidence,
                "licensePageSha256": page_sha,
                "licenseStructuredBlockSha256": rights["matchedJsonLdBlockSha256"],
            }
        annotations.append(annotation)
        receipt_map_digest_rows.append(
            {
                "caseId": case_id,
                "attemptIndex": record["attemptIndex"],
                "expectedPresence": expected,
                "landingUrl": source_url,
                "licenseUrl": rights["verifiedLicenseUrl"],
                "landingPageSha256": page_sha,
                "structuredBlockSha256": rights["matchedJsonLdBlockSha256"],
                "sourceSha256": image_sha,
                "sourceCanvas": [width, height],
                "sourceMaskPngSha256": record.get("maskEncodedSha256"),
            }
        )

    if (accepted_present, accepted_absent) != (16, 4):
        raise validation.CurateError("independently verified admission counts differ from 16/4")
    if accepted_ids != set(records_by_id) or set(records_by_id) != set(row["opaqueCaseId"] for row in producers):
        raise validation.CurateError("producer export case ID set differs from acquisition report")

    source_receipt = {
        "schema": "disjoint-photo-source-admission-review-v1",
        "status": "independently-verified-source-rights-canvas-and-mask-review",
        "selectionSeed": attempt_payload["selectionSeed"],
        "attemptListSha256": attempt_sha,
        "primaryShortlistSha256": primary_sha,
        "reserveCommitSha256": reserve_sha,
        "exclusionAuditSha256": audit_sha,
        "fingerprintIndexSha256": fingerprint_sha,
        "acquisitionReportSha256": report_sha,
        "acquisitionPrivateReceiptsSha256": receipts_sha,
        "pillowVersion": validation.runtime_pillow_version(),
        "admitted": {"present": accepted_present, "absent": accepted_absent},
        "independentlyRehashedHistoricalAndNewFingerprints": {
            "priorEntries": len(fingerprint["entries"]),
            "newEntries": len(new_fingerprints),
            "encoded": True,
            "decodedRgb": True,
            "perceptualHash": True,
            "hammingRejectAtMost": validation.PHASH_HAMMING_REJECT_AT_MOST,
        },
        "sourceFetchCallsDerivedFromFrozenAcquisitionFlow": {
            "flickrLandingPages": len(receipt_rows),
            "openImagesJpegs": len(records),
            "officialMaskZipRanges": accepted_present * 4,
            "total": len(receipt_rows) + len(records) + accepted_present * 4,
            "basis": "One recorded landing fetch per attempt; one Open Images JPEG fetch per admitted row; each uncached remote official ZIP mask read uses four bounded range fetches (tail, central directory, local header, member span). No retries or fallback requests.",
        },
        "candidateAttempts": len(receipt_rows),
        "rejections": report.get("rejections"),
        "sourceAdmissions": receipt_map_digest_rows,
        "providerCalls": 0,
    }
    write_json(output_dir / "source-admission-review-v1.json", source_receipt)

    producer_path = output_dir / "producer-input-rows.json"
    annotation_path = output_dir / "evaluator-private-annotations.json"
    controller_path = output_dir / "controller-path-index.json"
    provenance_path = output_dir / "curator-source-provenance.json"
    producer_sha = write_json(producer_path, producers)
    annotation_sha = write_json(annotation_path, annotations)
    controller_sha = write_json(controller_path, controller)
    provenance_sha = write_json(provenance_path, provenance)
    review_receipt_ref = artifact_ref(output_dir / "source-admission-review-v1.json", root)
    fragment_receipt = {
        "schema": "private-dev-source-fragment-v1",
        "notPhaseFreeze": True,
        "modelCalls": 0,
        "caseCount": 20,
        "maskCount": 16,
        "positiveCases": 16,
        "negativeCases": 4,
        "sourceGroupCounts": {"photo": 20},
        "sha256": {
            "producer-input-rows.json": producer_sha,
            "evaluator-private-annotations.json": annotation_sha,
            "controller-path-index.json": controller_sha,
            "curator-source-provenance.json": provenance_sha,
        },
        "selectionSeed": attempt_payload["selectionSeed"],
        "acquisitionReportSha256": report_sha,
        "acquisitionPrivateReceiptsSha256": receipts_sha,
        "sourceAdmissionReviewSha256": review_receipt_ref["sha256"],
    }
    fragment_receipt_path = output_dir / "fragment-receipt.json"
    fragment_receipt_sha = write_json(fragment_receipt_path, fragment_receipt)
    refs = {
        "producerRows": artifact_ref(producer_path, root),
        "annotations": artifact_ref(annotation_path, root),
        "controllerPathIndex": artifact_ref(controller_path, root),
        "provenance": artifact_ref(provenance_path, root),
        "fragmentReceipt": artifact_ref(fragment_receipt_path, root),
    }
    review_rows = []
    for producer, annotation in zip(producers, annotations, strict=True):
        case_id = producer["opaqueCaseId"]
        review_rows.append(
            {
                "opaqueCaseId": case_id,
                "fragmentId": FRAGMENT_ID,
                "accepted": True,
                "sourceSha256": producer["sourceBytesSha256"],
                "annotationSha256": _hash_identity(annotation),
                "sourceGroup": annotation["sourceGroup"],
                "provenanceSha256": _hash_identity(provenance[case_id]),
                "reviewReceiptSha256": review_receipt_ref["sha256"],
            }
        )
    review_manifest = {
        "schema": "h8a-dev-reviewed-fragment-v1",
        "fragmentId": FRAGMENT_ID,
        **refs,
        "referenceMasks": [artifact_ref(value["path"], root) for value in references.values()],
        "reviewReceipts": [review_receipt_ref],
        "rows": review_rows,
    }
    review_path = output_dir / "main-review-disjoint-photo-dev40.json"
    review_sha = write_json(review_path, review_manifest)
    receipt = {
        "status": "ready-reviewed-fragment",
        "fragmentReviewPath": str(review_path),
        "fragmentReviewSha256": review_sha,
        "fragmentId": FRAGMENT_ID,
        "producerRowsSha256": refs["producerRows"]["sha256"],
        "annotationsSha256": refs["annotations"]["sha256"],
        "controllerPathIndexSha256": refs["controllerPathIndex"]["sha256"],
        "provenanceSha256": refs["provenance"]["sha256"],
        "fragmentReceiptSha256": refs["fragmentReceipt"]["sha256"],
        "referenceMaskCount": len(references),
        "reviewReceiptSha256": review_receipt_ref["sha256"],
        "sourceAdmissionReviewSha256": source_receipt and review_receipt_ref["sha256"],
        "admitted": {"present": accepted_present, "absent": accepted_absent},
        "sourceAttempts": len(receipt_rows),
        "sourceRejections": len(report.get("rejections", [])),
        "providerCalls": 0,
    }
    write_json(output_dir / "fragment-export-receipt-v1.json", receipt)
    return receipt


def _load_manifest(path: Path, *, reserve: bool) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    raw, digest = validation.read_bounded_file_bytes(
        path, max_bytes=validation.MAX_PRIVATE_MANIFEST_BYTES, label=path.name
    )
    payload = validation.require_json_object(
        validation.loads_strict_json(raw.decode("utf-8"), label=path.name), path.name
    )
    rows = (
        validation.validate_reserve_manifest(payload)
        if reserve
        else validation.validate_private_photo_manifest(payload)
    )
    return payload, rows, digest


def _js_numbers(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _js_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_js_numbers(item) for item in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _hash_identity(value: Any) -> str:
    raw = json.dumps(_js_numbers(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return sha256_bytes(raw)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--acquisition-dir", type=Path, required=True)
    parser.add_argument("--primary-manifest", type=Path, required=True)
    parser.add_argument("--reserve-manifest", type=Path, required=True)
    parser.add_argument("--attempt-list", type=Path, required=True)
    parser.add_argument("--exclusion-audit", type=Path, required=True)
    parser.add_argument("--fingerprint-index", type=Path, required=True)
    parser.add_argument("--pre-acquisition-review", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = build_fragment(
        acquisition_dir=args.acquisition_dir,
        primary_path=args.primary_manifest,
        reserve_path=args.reserve_manifest,
        attempt_path=args.attempt_list,
        audit_path=args.exclusion_audit,
        fingerprint_path=args.fingerprint_index,
        review_input_path=args.pre_acquisition_review,
        artifact_root=args.artifact_root,
        output_dir=args.output_dir,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
