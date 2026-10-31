#!/usr/bin/env python3
"""Offline acquisition policy tests with injected HTTP transport only."""
from __future__ import annotations

import importlib.util
import io
import json
import struct
import sys
import tempfile
import time
import unittest
import zlib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


validation = load_module("fresh_dev_validation_acquire", "validation.py")
sys.modules["validation"] = validation
curate = load_module("fresh_dev_curate_acquire", "curate.py")
http_policy = load_module("fresh_dev_http_policy", "http_policy.py")
imaging = load_module("fresh_dev_imaging", "imaging.py")
mask_zip = load_module("fresh_dev_mask_zip", "mask_zip.py")
acquire = load_module("fresh_dev_acquire", "acquire.py")


def duplicate_policy_template(*, fingerprint_index_sha256: str = "a" * 64) -> dict[str, object]:
    return {
        "schemaVersion": validation.DUPLICATE_POLICY_SCHEMA_V1,
        "status": "frozen-pre-acquisition",
        "fingerprintIndexSha256": fingerprint_index_sha256,
        "exclusionAuditSha256": validation.EXCLUSION_AUDIT_SHA256,
        "perceptualHashAlgorithmId": validation.PERCEPTUAL_HASH_ALGORITHM_ID,
        "perceptualHashResampler": validation.PERCEPTUAL_HASH_RESAMPLER,
        "pillowVersion": validation.runtime_pillow_version(),
        "hammingRejectAtMost": validation.PHASH_HAMMING_REJECT_AT_MOST,
        "encodedSha256Reject": True,
        "decodedRgbSha256Reject": True,
    }


def fingerprint_index_template(*, entries: list[dict[str, str]]) -> dict[str, object]:
    return {
        "schemaVersion": validation.FINGERPRINT_INDEX_SCHEMA_V1,
        "exclusionAuditSha256": validation.EXCLUSION_AUDIT_SHA256,
        "perceptualHashAlgorithmId": validation.PERCEPTUAL_HASH_ALGORITHM_ID,
        "perceptualHashResampler": validation.PERCEPTUAL_HASH_RESAMPLER,
        "pillowVersion": validation.runtime_pillow_version(),
        "entries": entries,
    }


class FakeTransport:
    def __init__(self, responses: dict[str, http_policy.HttpResponse]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, int | None]] = []

    def fetch(self, url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
        self.requests.append((url, byte_limit))
        if url not in self.responses:
            raise validation.CurateError(f"unexpected URL outside fixture map: {url}")
        response = self.responses[url]
        if len(response.body) > byte_limit:
            raise validation.CurateError("fixture response exceeds requested byte limit")
        return response


def make_jpeg(width: int, height: int, *, color: tuple[int, int, int] = (120, 80, 40)) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, format="JPEG")
    return buffer.getvalue()


def flickr_page(photo_id: str, *, license_url: str = validation.PHOTO_LICENSE) -> bytes:
    payload = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "ImageObject",
                "acquireLicensePage": f"https://www.flickr.com/photos/owner/{photo_id}",
                "license": license_url,
            }
        ],
    }
    html = (
        "<html><head>"
        f'<script type="application/ld+json">{json.dumps(payload)}</script>'
        "</head><body></body></html>"
    )
    return html.encode("utf-8")


def mask_png(width: int, height: int) -> bytes:
    from PIL import Image

    image = Image.new("L", (width, height), 0)
    for x in range(width // 4, width // 2):
        for y in range(height // 4, height // 2):
            image.putpixel((x, y), 255)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def write_zip_with_member(path: Path, member_name: str, payload: bytes) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member_name, payload)
    path.write_bytes(buffer.getvalue())


def minimal_manifest_row(
    *,
    case_id: str,
    image_id: str,
    class_id: str,
    target: str,
    presence: str,
    landing_photo_id: str,
    mask_path: str | None,
    mask_dims: tuple[int, int] | None,
) -> dict[str, object]:
    row: dict[str, object] = {
        "caseId": case_id,
        "expectedPresence": presence,
        "imageId": image_id,
        "targetClassId": class_id,
        "target": target,
        "authorProfileUrl": f"https://www.flickr.com/people/{case_id[:8]}",
        "rightsReviewStatus": "pending",
        "datasetLicenseMetadata": {"note": "n", "licenseUrl": validation.PHOTO_LICENSE},
        "sourceUrls": {
            "originalUrl": "https://example.invalid/not-used.jpg",
            "originalLandingUrl": f"https://www.flickr.com/photos/owner/{landing_photo_id}",
            "licenseUrl": validation.PHOTO_LICENSE,
            "author": "Author",
            "title": "Title",
        },
        "selectionKey": "c" * 64,
    }
    if presence == "present":
        assert mask_path and mask_dims
        row["targetBoxes"] = [
            {
                "classId": class_id,
                "className": target,
                "xyxy": [0.1, 0.1, 0.4, 0.4],
                "source": "xclick",
                "sourceCsvRow": 2,
                "sourceBoxDecimals": {"XMin": "0.1", "YMin": "0.1", "XMax": "0.4", "YMax": "0.4"},
                "occluded": 0,
                "truncated": 0,
                "groupOf": 0,
                "depiction": 0,
                "inside": 0,
            }
        ]
        row["instanceMaskMetadata"] = {
            "boxId": "abcd1234",
            "maskPath": mask_path,
            "maskCsvRow": 2,
            "sourceBoxDecimals": {"XMin": "0.1", "YMin": "0.1", "XMax": "0.4", "YMax": "0.4"},
            "pngHeaderDimensions": {"width": mask_dims[0], "height": mask_dims[1]},
        }
        row["negativeEvidence"] = None
    else:
        row["targetBoxes"] = []
        row["negativeEvidence"] = {
            "type": "explicit-human-verified-image-label",
            "source": "verification",
            "confidence": 0,
            "sourceCsvRow": 3,
            "sourceFile": "labels.csv",
        }
    return row


class UrlPolicyTests(unittest.TestCase):
    def test_rejects_non_allowlisted_jpeg_host(self) -> None:
        with self.assertRaises(validation.CurateError):
            http_policy.validate_open_images_jpeg_url(
                "https://evil.example/validation/0123456789abcdef.jpg",
                image_id="0123456789abcdef",
            )

    def test_rejects_flickr_query_string(self) -> None:
        with self.assertRaises(validation.CurateError):
            http_policy.validate_flickr_landing_url(
                "https://www.flickr.com/photos/owner/12345?param=1",
            )


class FingerprintPolicyTests(unittest.TestCase):
    def test_missing_pillow_version_fails_fingerprint_index(self) -> None:
        payload = {
            "schemaVersion": validation.FINGERPRINT_INDEX_SCHEMA_V1,
            "exclusionAuditSha256": validation.EXCLUSION_AUDIT_SHA256,
            "perceptualHashAlgorithmId": validation.PERCEPTUAL_HASH_ALGORITHM_ID,
            "perceptualHashResampler": validation.PERCEPTUAL_HASH_RESAMPLER,
            "entries": [],
        }
        with self.assertRaises(validation.CurateError):
            validation.validate_fingerprint_index(payload)

    def test_fingerprint_index_allows_duplicate_decoded_and_phash_rows(self) -> None:
        shared_decoded = "b" * 64
        shared_phash = "0123456789abcdef"
        payload = fingerprint_index_template(
            entries=[
                {
                    "encodedSha256": "a" * 64,
                    "decodedRgbSha256": shared_decoded,
                    "perceptualHash64": shared_phash,
                },
                {
                    "encodedSha256": "c" * 64,
                    "decodedRgbSha256": shared_decoded,
                    "perceptualHash64": shared_phash,
                },
            ]
        )
        validated = validation.validate_fingerprint_index(payload)
        self.assertEqual(len(validated["entries"]), 2)

    def test_fingerprint_index_rejects_duplicate_encoded_sha256(self) -> None:
        payload = fingerprint_index_template(
            entries=[
                {
                    "encodedSha256": "a" * 64,
                    "decodedRgbSha256": "b" * 64,
                    "perceptualHash64": "0123456789abcdef",
                },
                {
                    "encodedSha256": "a" * 64,
                    "decodedRgbSha256": "d" * 64,
                    "perceptualHash64": "fedcba9876543210",
                },
            ]
        )
        with self.assertRaises(validation.CurateError):
            validation.validate_fingerprint_index(payload)

    def test_fingerprint_index_coverage_count_from_exclusion_set(self) -> None:
        excluded = {f"{index:064x}" for index in (1, 2, 3)}
        entries = [
            {
                "encodedSha256": digest,
                "decodedRgbSha256": f"{(offset + 10):064x}",
                "perceptualHash64": f"{offset:016x}",
            }
            for offset, digest in enumerate(sorted(excluded))
        ]
        payload = validation.validate_fingerprint_index(fingerprint_index_template(entries=entries))
        validation.validate_fingerprint_index_exclusion_coverage(
            payload,
            exclusion_audit_sha256=validation.EXCLUSION_AUDIT_SHA256,
            excluded_encoded_sha256=excluded,
        )
        short_excluded = set(list(excluded)[:2])
        with self.assertRaises(validation.CurateError):
            validation.validate_fingerprint_index_exclusion_coverage(
                payload,
                exclusion_audit_sha256=validation.EXCLUSION_AUDIT_SHA256,
                excluded_encoded_sha256=short_excluded,
            )

    def test_fingerprint_index_requires_full_exclusion_coverage(self) -> None:
        payload = fingerprint_index_template(
            entries=[
                {
                    "encodedSha256": "a" * 64,
                    "decodedRgbSha256": "b" * 64,
                    "perceptualHash64": "0123456789abcdef",
                }
            ]
        )
        with self.assertRaises(validation.CurateError):
            validation.validate_fingerprint_index_exclusion_coverage(
                validation.validate_fingerprint_index(payload),
                exclusion_audit_sha256=validation.EXCLUSION_AUDIT_SHA256,
                excluded_encoded_sha256={"a" * 64, "b" * 64},
            )


class AcquisitionFlowTests(unittest.TestCase):
    def _fingerprint_index_from_jpeg(self, jpeg: bytes) -> dict[str, object]:
        encoded = imaging.sha256_bytes(jpeg)
        phash, decoded_rgb, _w, _h = imaging.perceptual_hash64_from_jpeg(jpeg)
        return fingerprint_index_template(
            entries=[
                {
                    "encodedSha256": "f" * 64,
                    "decodedRgbSha256": "e" * 64,
                    "perceptualHash64": "0123456789abcdef",
                }
            ]
        )

    def _run_single_positive(self, *, jpeg: bytes, mask_png_bytes: bytes, landing: bytes, license_url: str | None = None) -> dict[str, object]:
        image_id = "0123456789abcdef"
        case_id = "0123456789abcdef0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        landing_photo_id = "999888777"
        row = minimal_manifest_row(
            case_id=case_id,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id=landing_photo_id,
            mask_path=mask_path,
            mask_dims=(64, 48),
        )
        if license_url is not None:
            landing = flickr_page(landing_photo_id, license_url=license_url)
        jpeg_url = http_policy.build_open_images_jpeg_url(image_id)
        landing_url = f"https://www.flickr.com/photos/owner/{landing_photo_id}"
        transport = FakeTransport(
            {
                landing_url: http_policy.HttpResponse(landing_url, 200, landing, {}),
                jpeg_url: http_policy.HttpResponse(jpeg_url, 200, jpeg, {}),
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "mask.zip"
            write_zip_with_member(zip_path, mask_path, mask_png_bytes)
            output_dir = tmp_path / "out"
            output_dir.mkdir()
            fingerprint = self._fingerprint_index_from_jpeg(jpeg)
            duplicate_policy = duplicate_policy_template(
                fingerprint_index_sha256=imaging.sha256_bytes(json.dumps(fingerprint).encode()),
            )
            validation.validate_duplicate_policy(
                duplicate_policy,
                fingerprint_index_sha256=duplicate_policy["fingerprintIndexSha256"],
            )
            attempt_doc = {
                "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                "selectionSeed": curate.SEED,
                "primaryShortlistSha256": "a" * 64,
                "reserveCommitSha256": "b" * 64,
                "attempts": [
                    {
                        "phase": "primary",
                        "expectedPresence": "present",
                        "caseId": case_id,
                        "imageId": image_id,
                        "targetClassId": "/m/person",
                        "target": "Person",
                        "selectionKey": "c" * 64,
                    }
                ],
            }
            return acquire.run_acquisition(
                attempt_doc=attempt_doc,
                primary_rows=[row],
                reserve_rows=[],
                duplicate_policy=duplicate_policy,
                fingerprint_index=fingerprint,
                transport=transport,
                output_dir=output_dir,
                local_mask_archives={image_id[0].lower(): zip_path},
            )

    def test_happy_path_admits_png_mask_and_producer(self) -> None:
        jpeg = make_jpeg(64, 48)
        png = mask_png(64, 48)
        report = self._run_single_positive(jpeg=jpeg, mask_png_bytes=png, landing=flickr_page("999888777"))
        self.assertEqual(report["admitted"]["present"], 1)
        record = report["records"][0]
        validation.sanitize_producer_record(record["producer"])

    def test_flickr_private_evidence_stays_out_of_producer_payload(self) -> None:
        jpeg = make_jpeg(64, 48)
        png = mask_png(64, 48)
        landing = flickr_page("999888777")
        image_id = "0123456789abcdef"
        case_id = "0123456789abcdef0123456789abcdef"
        landing_url = f"https://www.flickr.com/photos/owner/999888777"
        jpeg_url = http_policy.build_open_images_jpeg_url(image_id)
        transport = FakeTransport(
            {
                landing_url: http_policy.HttpResponse(landing_url, 200, landing, {}),
                jpeg_url: http_policy.HttpResponse(jpeg_url, 200, jpeg, {}),
            }
        )
        row = minimal_manifest_row(
            case_id=case_id,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path=f"{image_id}_mperson_abcd1234.png",
            mask_dims=(64, 48),
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "mask.zip"
            write_zip_with_member(zip_path, f"{image_id}_mperson_abcd1234.png", png)
            output_dir = tmp_path / "out"
            output_dir.mkdir()
            fingerprint = fingerprint_index_template(
                entries=[
                    {
                        "encodedSha256": "f" * 64,
                        "decodedRgbSha256": "e" * 64,
                        "perceptualHash64": "0123456789abcdef",
                    }
                ]
            )
            duplicate_policy = duplicate_policy_template()
            attempt_doc = {
                "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                "selectionSeed": curate.SEED,
                "primaryShortlistSha256": "a" * 64,
                "reserveCommitSha256": "b" * 64,
                "attempts": [
                    {
                        "phase": "primary",
                        "expectedPresence": "present",
                        "caseId": case_id,
                        "imageId": image_id,
                        "targetClassId": "/m/person",
                        "target": "Person",
                        "selectionKey": "c" * 64,
                    }
                ],
            }
            acquire.run_acquisition(
                attempt_doc=attempt_doc,
                primary_rows=[row],
                reserve_rows=[],
                duplicate_policy=duplicate_policy,
                fingerprint_index=fingerprint,
                transport=transport,
                output_dir=output_dir,
                local_mask_archives={image_id[0].lower(): zip_path},
                persist_artifacts=True,
            )
            report = json.loads((output_dir / "acquisition-report.json").read_text(encoding="utf-8"))
            producer = report["records"][0]["producer"]
            validation.sanitize_producer_record(producer)
            producer_blob = json.dumps(producer)
            self.assertNotIn(landing_url, producer_blob)
            self.assertNotIn(validation.PHOTO_LICENSE, producer_blob)
            receipts = json.loads((output_dir / "acquisition-private-receipts.json").read_text(encoding="utf-8"))
            admitted = receipts["attempts"][0]
            evidence = admitted["flickrLandingEvidence"]
            self.assertEqual(evidence["sourceLandingUrl"], landing_url)
            stored_path = output_dir / evidence["storedBytesPath"]
            stored_bytes = stored_path.read_bytes()
            self.assertEqual(evidence["responseBodySha256"], imaging.sha256_bytes(stored_bytes))
            replay = acquire.verify_flickr_license_page(stored_bytes, landing_url=landing_url)
            self.assertEqual(evidence["structuredBlockSha256"], replay["structuredBlockSha256"])
            self.assertEqual(evidence["verifiedLicenseUrl"], validation.PHOTO_LICENSE)

    def test_rights_mismatch_rejected(self) -> None:
        jpeg = make_jpeg(64, 48)
        png = mask_png(64, 48)
        report = self._run_single_positive(
            jpeg=jpeg,
            mask_png_bytes=png,
            landing=b"",
            license_url="https://creativecommons.org/licenses/by/4.0/",
        )
        self.assertEqual(report["admitted"]["present"], 0)
        self.assertTrue(report["rejections"])

    def test_canvas_mismatch_rejected(self) -> None:
        jpeg = make_jpeg(80, 60)
        png = mask_png(64, 48)
        report = self._run_single_positive(jpeg=jpeg, mask_png_bytes=png, landing=flickr_page("999888777"))
        self.assertEqual(report["admitted"]["present"], 0)

    def test_redirect_rejected(self) -> None:
        jpeg = make_jpeg(64, 48)
        png = mask_png(64, 48)
        image_id = "0123456789abcdef"
        case_id = "0123456789abcdef0123456789abcdef"
        row = minimal_manifest_row(
            case_id=case_id,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path=f"{image_id}_mperson_abcd1234.png",
            mask_dims=(64, 48),
        )
        landing_url = "https://www.flickr.com/photos/owner/999888777"
        jpeg_url = http_policy.build_open_images_jpeg_url(image_id)
        transport = FakeTransport(
            {
                landing_url: http_policy.HttpResponse(
                    "https://www.flickr.com/photos/owner/999888777?bad=1",
                    200,
                    flickr_page("999888777"),
                    {},
                ),
                jpeg_url: http_policy.HttpResponse(jpeg_url, 200, jpeg, {}),
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "mask.zip"
            write_zip_with_member(zip_path, f"{image_id}_mperson_abcd1234.png", png)
            output_dir = tmp_path / "out"
            output_dir.mkdir()
            fingerprint = fingerprint_index_template(
                entries=[
                    {
                        "encodedSha256": "f" * 64,
                        "decodedRgbSha256": "e" * 64,
                        "perceptualHash64": "0123456789abcdef",
                    }
                ]
            )
            duplicate_policy = duplicate_policy_template()
            attempt_doc = {
                "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                "selectionSeed": curate.SEED,
                "primaryShortlistSha256": "a" * 64,
                "reserveCommitSha256": "b" * 64,
                "attempts": [
                    {
                        "phase": "primary",
                        "expectedPresence": "present",
                        "caseId": case_id,
                        "imageId": image_id,
                        "targetClassId": "/m/person",
                        "target": "Person",
                        "selectionKey": "c" * 64,
                    }
                ],
            }
            report = acquire.run_acquisition(
                attempt_doc=attempt_doc,
                primary_rows=[row],
                reserve_rows=[],
                duplicate_policy=duplicate_policy,
                fingerprint_index=fingerprint,
                transport=transport,
                output_dir=output_dir,
                local_mask_archives={image_id[0].lower(): zip_path},
            )
            self.assertEqual(report["admitted"]["present"], 0)

    def test_oversize_jpeg_rejected(self) -> None:
        jpeg = make_jpeg(64, 48)
        png = mask_png(64, 48)
        image_id = "0123456789abcdef"
        case_id = "0123456789abcdef0123456789abcdef"
        row = minimal_manifest_row(
            case_id=case_id,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path=f"{image_id}_mperson_abcd1234.png",
            mask_dims=(64, 48),
        )
        landing_url = "https://www.flickr.com/photos/owner/999888777"
        jpeg_url = http_policy.build_open_images_jpeg_url(image_id)
        oversized = jpeg + b"x" * (http_policy.MAX_JPEG_RESPONSE_BYTES + 1)
        transport = FakeTransport(
            {
                landing_url: http_policy.HttpResponse(landing_url, 200, flickr_page("999888777"), {}),
                jpeg_url: http_policy.HttpResponse(jpeg_url, 200, oversized, {}),
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "mask.zip"
            write_zip_with_member(zip_path, f"{image_id}_mperson_abcd1234.png", png)
            output_dir = tmp_path / "out"
            output_dir.mkdir()
            fingerprint = fingerprint_index_template(
                entries=[
                    {
                        "encodedSha256": "f" * 64,
                        "decodedRgbSha256": "e" * 64,
                        "perceptualHash64": "0123456789abcdef",
                    }
                ]
            )
            duplicate_policy = duplicate_policy_template()
            attempt_doc = {
                "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                "selectionSeed": curate.SEED,
                "primaryShortlistSha256": "a" * 64,
                "reserveCommitSha256": "b" * 64,
                "attempts": [
                    {
                        "phase": "primary",
                        "expectedPresence": "present",
                        "caseId": case_id,
                        "imageId": image_id,
                        "targetClassId": "/m/person",
                        "target": "Person",
                        "selectionKey": "c" * 64,
                    }
                ],
            }
            report = acquire.run_acquisition(
                attempt_doc=attempt_doc,
                primary_rows=[row],
                reserve_rows=[],
                duplicate_policy=duplicate_policy,
                fingerprint_index=fingerprint,
                transport=transport,
                output_dir=output_dir,
                local_mask_archives={image_id[0].lower(): zip_path},
            )
            self.assertEqual(report["admitted"]["present"], 0)

    def test_nonbinary_mask_rejected(self) -> None:
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("L", (64, 48), 128).save(buffer, format="PNG")
        report = self._run_single_positive(
            jpeg=make_jpeg(64, 48),
            mask_png_bytes=buffer.getvalue(),
            landing=flickr_page("999888777"),
        )
        self.assertEqual(report["admitted"]["present"], 0)

    def test_duplicate_encoded_sha_rejected(self) -> None:
        jpeg = make_jpeg(64, 48)
        encoded = imaging.sha256_bytes(jpeg)
        png = mask_png(64, 48)
        fingerprint = fingerprint_index_template(
            entries=[
                {
                    "encodedSha256": encoded,
                    "decodedRgbSha256": "d" * 64,
                    "perceptualHash64": "0123456789abcdef",
                }
            ]
        )
        image_id = "0123456789abcdef"
        case_id = "0123456789abcdef0123456789abcdef"
        row = minimal_manifest_row(
            case_id=case_id,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path=f"{image_id}_mperson_abcd1234.png",
            mask_dims=(64, 48),
        )
        landing_url = "https://www.flickr.com/photos/owner/999888777"
        jpeg_url = http_policy.build_open_images_jpeg_url(image_id)
        transport = FakeTransport(
            {
                landing_url: http_policy.HttpResponse(landing_url, 200, flickr_page("999888777"), {}),
                jpeg_url: http_policy.HttpResponse(jpeg_url, 200, jpeg, {}),
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "mask.zip"
            write_zip_with_member(zip_path, f"{image_id}_mperson_abcd1234.png", png)
            output_dir = tmp_path / "out"
            output_dir.mkdir()
            duplicate_policy = duplicate_policy_template()
            attempt_doc = {
                "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                "selectionSeed": curate.SEED,
                "primaryShortlistSha256": "a" * 64,
                "reserveCommitSha256": "b" * 64,
                "attempts": [
                    {
                        "phase": "primary",
                        "expectedPresence": "present",
                        "caseId": case_id,
                        "imageId": image_id,
                        "targetClassId": "/m/person",
                        "target": "Person",
                        "selectionKey": "c" * 64,
                    }
                ],
            }
            report = acquire.run_acquisition(
                attempt_doc=attempt_doc,
                primary_rows=[row],
                reserve_rows=[],
                duplicate_policy=duplicate_policy,
                fingerprint_index=fingerprint,
                transport=transport,
                output_dir=output_dir,
                local_mask_archives={image_id[0].lower(): zip_path},
                persist_artifacts=True,
            )
            self.assertEqual(report["admitted"]["present"], 0)
            receipts = json.loads((output_dir / "acquisition-private-receipts.json").read_text(encoding="utf-8"))
            rejected = receipts["attempts"][0]
            self.assertEqual(rejected["outcome"], "rejected")
            self.assertEqual(rejected["reasonCode"], "encoded-jpeg-sha256-duplicate")
            evidence = rejected["rejectionSourceEvidence"]
            self.assertEqual(evidence["reasonCode"], "encoded-jpeg-sha256-duplicate")
            jpeg_evidence = evidence["jpeg"]
            stored_path = output_dir / jpeg_evidence["storedBytesPath"]
            self.assertTrue(stored_path.is_file())
            self.assertEqual(imaging.sha256_bytes(stored_path.read_bytes()), jpeg_evidence["storedBytesSha256"])
            self.assertEqual(imaging.sha256_bytes(stored_path.read_bytes()), encoded)

    def test_duplicate_decoded_rgb_rejected_even_when_index_allows_duplicate_rows(self) -> None:
        jpeg = make_jpeg(64, 48)
        _phash, decoded_rgb, _w, _h = imaging.perceptual_hash64_from_jpeg(jpeg)
        png = mask_png(64, 48)
        fingerprint = fingerprint_index_template(
            entries=[
                {
                    "encodedSha256": "a" * 64,
                    "decodedRgbSha256": decoded_rgb,
                    "perceptualHash64": "0123456789abcdef",
                },
                {
                    "encodedSha256": "b" * 64,
                    "decodedRgbSha256": decoded_rgb,
                    "perceptualHash64": "0123456789abcdef",
                },
            ]
        )
        validation.validate_fingerprint_index(fingerprint)
        image_id = "0123456789abcdef"
        case_id = "0123456789abcdef0123456789abcdef"
        row = minimal_manifest_row(
            case_id=case_id,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path=f"{image_id}_mperson_abcd1234.png",
            mask_dims=(64, 48),
        )
        landing_url = "https://www.flickr.com/photos/owner/999888777"
        jpeg_url = http_policy.build_open_images_jpeg_url(image_id)
        transport = FakeTransport(
            {
                landing_url: http_policy.HttpResponse(landing_url, 200, flickr_page("999888777"), {}),
                jpeg_url: http_policy.HttpResponse(jpeg_url, 200, jpeg, {}),
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "mask.zip"
            write_zip_with_member(zip_path, f"{image_id}_mperson_abcd1234.png", png)
            output_dir = tmp_path / "out"
            output_dir.mkdir()
            report = acquire.run_acquisition(
                attempt_doc={
                    "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                    "selectionSeed": curate.SEED,
                    "primaryShortlistSha256": "a" * 64,
                    "reserveCommitSha256": "b" * 64,
                    "attempts": [
                        {
                            "phase": "primary",
                            "expectedPresence": "present",
                            "caseId": case_id,
                            "imageId": image_id,
                            "targetClassId": "/m/person",
                            "target": "Person",
                            "selectionKey": "c" * 64,
                        }
                    ],
                },
                primary_rows=[row],
                reserve_rows=[],
                duplicate_policy=duplicate_policy_template(),
                fingerprint_index=fingerprint,
                transport=transport,
                output_dir=output_dir,
                local_mask_archives={image_id[0].lower(): zip_path},
            )
            self.assertEqual(report["admitted"]["present"], 0)

    def test_flickr_acquire_license_page_must_match_full_landing_url(self) -> None:
        photo_id = "999888777"
        landing_url = f"https://www.flickr.com/photos/owner/{photo_id}"
        wrong_page = {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "ImageObject",
                    "acquireLicensePage": "https://www.flickr.com/photos/other/111222333",
                    "license": validation.PHOTO_LICENSE,
                }
            ],
        }
        html = (
            "<html><head>"
            f'<script type="application/ld+json">{json.dumps(wrong_page)}</script>'
            "</head><body></body></html>"
        ).encode("utf-8")
        with self.assertRaises(validation.CurateError):
            acquire.verify_flickr_license_page(html, landing_url=landing_url)

    def test_malformed_jsonld_block_is_ignored_not_crash(self) -> None:
        photo_id = "999888777"
        landing_url = f"https://www.flickr.com/photos/owner/{photo_id}"
        html = (
            "<html><head>"
            '<script type="application/ld+json">{not-json</script>'
            f'<script type="application/ld+json">{json.dumps({"@type": "ImageObject", "acquireLicensePage": landing_url, "license": validation.PHOTO_LICENSE})}</script>'
            "</head><body></body></html>"
        ).encode("utf-8")
        receipt = acquire.verify_flickr_license_page(html, landing_url=landing_url)
        self.assertIn("structuredBlockSha256", receipt)


class MaskZipRangedTests(unittest.TestCase):
    def test_remote_ranged_member_read(self) -> None:
        image_id = "0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        payload = mask_png(64, 48)
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            write_zip_with_member(zip_path, mask_path, payload)
            archive_bytes = zip_path.read_bytes()
            url = http_policy.build_mask_archive_url(image_id[0].lower())

            class RangedTransport:
                def fetch(self, fetch_url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                    if fetch_url != url:
                        raise validation.CurateError("unexpected URL")
                    if range_header is None:
                        raise validation.CurateError("range required")
                    total = len(archive_bytes)
                    if range_header.startswith("bytes=-"):
                        suffix_len = int(range_header.split("-")[-1])
                        start = max(0, total - suffix_len)
                        end = total - 1
                        body = archive_bytes[start : end + 1]
                    else:
                        start_s, end_s = range_header.removeprefix("bytes=").split("-")
                        start = int(start_s)
                        end = int(end_s)
                        body = archive_bytes[start : end + 1]
                    if len(body) > byte_limit:
                        raise validation.CurateError("byte limit exceeded")
                    headers = {"content-range": f"bytes {start}-{end}/{total}"}
                    return http_policy.HttpResponse(fetch_url, 206, body, headers)

            decoded = mask_zip.read_mask_member_bytes(
                mask_basename=mask_path,
                image_id=image_id,
                transport=RangedTransport(),
                local_archive=None,
            )
            self.assertEqual(decoded, payload)

    def test_remote_range_ignored_by_server_rejected(self) -> None:
        image_id = "0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        payload = mask_png(64, 48)
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            write_zip_with_member(zip_path, mask_path, payload)
            archive_bytes = zip_path.read_bytes()
            url = http_policy.build_mask_archive_url(image_id[0].lower())

            class FullBodyTransport:
                def fetch(self, fetch_url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                    if range_header is not None:
                        return http_policy.HttpResponse(fetch_url, 200, archive_bytes, {})
                    return http_policy.HttpResponse(fetch_url, 200, archive_bytes[:byte_limit], {})

            with self.assertRaises(validation.CurateError):
                mask_zip.read_mask_member_bytes(
                    mask_basename=mask_path,
                    image_id=image_id,
                    transport=FullBodyTransport(),
                    local_archive=None,
                )

    def test_remote_member_crc_mismatch_rejected(self) -> None:
        image_id = "0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        payload = mask_png(64, 48)
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            write_zip_with_member(zip_path, mask_path, payload)
            archive_bytes = bytearray(zip_path.read_bytes())
            archive_bytes[-10] ^= 0xFF
            archive_bytes = bytes(archive_bytes)
            url = http_policy.build_mask_archive_url(image_id[0].lower())

            class RangedTransport:
                def fetch(self, fetch_url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                    if range_header is None:
                        raise validation.CurateError("range required")
                    total = len(archive_bytes)
                    if range_header.startswith("bytes=-"):
                        suffix_len = int(range_header.split("-")[-1])
                        start = max(0, total - suffix_len)
                        end = total - 1
                        body = archive_bytes[start : end + 1]
                    else:
                        start_s, end_s = range_header.removeprefix("bytes=").split("-")
                        start = int(start_s)
                        end = int(end_s)
                        body = archive_bytes[start : end + 1]
                    headers = {"content-range": f"bytes {start}-{end}/{total}"}
                    return http_policy.HttpResponse(fetch_url, 206, body, headers)

            with self.assertRaises(validation.CurateError):
                mask_zip.read_mask_member_bytes(
                    mask_basename=mask_path,
                    image_id=image_id,
                    transport=RangedTransport(),
                    local_archive=None,
                )


class ImagingContractTests(unittest.TestCase):
    def test_one_bit_grayscale_png_preserves_binary_pixels_and_canvas(self) -> None:
        from PIL import Image

        buffer = io.BytesIO()
        image = Image.new("1", (7, 3), 0)
        image.putpixel((1, 0), 1)
        image.putpixel((6, 2), 1)
        image.save(buffer, format="PNG")
        encoded = buffer.getvalue()
        self.assertEqual(encoded[24], 1)
        self.assertEqual(encoded[25], 0)
        pixels, width, height = imaging.decode_png_grayscale_values(encoded)
        self.assertEqual((width, height), (7, 3))
        expected = bytearray(width * height)
        expected[1] = 255
        expected[2 * width + 6] = 255
        self.assertEqual(pixels, bytes(expected))

    def test_png_corrupted_crc_rejected(self) -> None:
        png = bytearray(mask_png(8, 8))
        png[-4] ^= 0xFF
        with self.assertRaises(validation.CurateError):
            imaging.decode_png_grayscale_values(bytes(png))

    def test_colored_png_rejected_by_ihdr(self) -> None:
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (8, 8), (255, 0, 0)).save(buffer, format="PNG")
        with self.assertRaises(validation.CurateError):
            imaging.decode_png_grayscale_values(buffer.getvalue())

    def test_perceptual_hash_uses_bicubic_resampler_constant(self) -> None:
        self.assertEqual(imaging.perceptual_hash_resampler_id(), validation.PERCEPTUAL_HASH_RESAMPLER)


class ReserveOverlapTests(unittest.TestCase):
    def test_reserve_rows_do_not_reuse_primary_image_or_group(self) -> None:
        primary_row = {
            "caseId": "0123456789abcdef0123456789abcdef",
            "expectedPresence": "present",
            "imageId": "0000000000000001",
            "authorProfileUrl": "https://www.flickr.com/people/author-a",
        }
        used_images, used_groups = curate.primary_usage_from_manifest([primary_row])
        positives = [
            {
                "imageId": "0000000000000001",
                "classId": "/m/person",
                "authorProfileUrl": "https://www.flickr.com/people/author-a",
                "sortKey": "1",
            },
            {
                "imageId": "0000000000000002",
                "classId": "/m/person",
                "authorProfileUrl": "https://www.flickr.com/people/author-b",
                "sortKey": "2",
            },
        ]
        tally: dict[str, int] = {}
        from collections import Counter

        counter = Counter()
        selected_pos, _selected_neg = curate.select_reserves(
            positives,
            [],
            counter,
            {},
            used_images=used_images,
            used_groups=used_groups,
        )
        self.assertEqual(len(selected_pos), 1)
        self.assertEqual(selected_pos[0]["imageId"], "0000000000000002")


class SymlinkOutputTests(unittest.TestCase):
    def test_external_output_dir_symlink_rejected(self) -> None:
        repo_root = validation.repo_root_from_here(ROOT)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            target = tmp_path / "target-out"
            link = tmp_path / "linked-out"
            target.mkdir()
            link.symlink_to(target)
            with self.assertRaises(validation.CurateError):
                validation.require_external_new_directory(link, repo_root, "output directory")


def build_zip_false_uncompressed_size(path: Path, member_name: str, uncompressed_payload: bytes, *, declared_size: int) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member_name, uncompressed_payload)
    data = bytearray(buffer.getvalue())
    false_size = struct.pack("<I", declared_size)
    local_off = data.find(b"PK\x03\x04")
    data[local_off + 18 : local_off + 22] = false_size
    data[local_off + 22 : local_off + 26] = false_size
    central_off = data.find(b"PK\x01\x02")
    data[central_off + 20 : central_off + 24] = false_size
    data[central_off + 24 : central_off + 28] = false_size
    path.write_bytes(data)


class ZipBombTests(unittest.TestCase):
    def test_false_small_declared_size_rejects_before_cap(self) -> None:
        image_id = "0123456789abcdef"
        member_name = f"{image_id}_mperson_abcd1234.png"
        payload = b"\x00" * (9 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "bomb.zip"
            build_zip_false_uncompressed_size(
                zip_path,
                member_name,
                payload,
                declared_size=128,
            )
            entries = mask_zip._read_local_archive_index(zip_path)
            member = entries[Path(member_name).name]
            with self.assertRaises(validation.CurateError):
                mask_zip._read_local_member(zip_path, member)


class HttpDeadlineTests(unittest.TestCase):
    def test_slow_trickle_stops_at_absolute_deadline(self) -> None:
        class SlowResponse:
            def read1(self, size: int = -1) -> bytes:
                time.sleep(0.05)
                return b"x" * min(size, 1024)

        deadline = time.monotonic() + 0.15
        start = time.monotonic()
        with self.assertRaises(validation.InfrastructureFailure):
            http_policy.read_http_body_with_deadline(
                SlowResponse(),
                byte_limit=1024 * 1024,
                deadline=deadline,
            )
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, 1.0)
        self.assertGreaterEqual(elapsed, 0.1)


class InfrastructureStopTests(unittest.TestCase):
    def test_http_503_stops_remaining_attempts(self) -> None:
        image_id = "0123456789abcdef"
        case_a = "0123456789abcdef0123456789abcdef"
        case_b = "123456789012345678901234567890ab"
        row_a = minimal_manifest_row(
            case_id=case_a,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path=f"{image_id}_mperson_abcd1234.png",
            mask_dims=(64, 48),
        )
        row_b = minimal_manifest_row(
            case_id=case_b,
            image_id="1234567890123456",
            class_id="/m/person",
            target="Person",
            presence="absent",
            landing_photo_id="888777666",
            mask_path=None,
            mask_dims=None,
        )
        landing_a = "https://www.flickr.com/photos/owner/999888777"
        landing_b = "https://www.flickr.com/photos/owner/888777666"
        transport = FakeTransport(
            {
                landing_a: http_policy.HttpResponse(landing_a, 503, b"", {}),
                landing_b: http_policy.HttpResponse(landing_b, 200, flickr_page("888777666"), {}),
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "out"
            output_dir.mkdir()
            report = acquire.run_acquisition(
                attempt_doc={
                    "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                    "selectionSeed": curate.SEED,
                    "primaryShortlistSha256": "a" * 64,
                    "reserveCommitSha256": "b" * 64,
                    "attempts": [
                        {
                            "phase": "primary",
                            "expectedPresence": "present",
                            "caseId": case_a,
                            "imageId": image_id,
                            "targetClassId": "/m/person",
                            "target": "Person",
                            "selectionKey": "c" * 64,
                        },
                        {
                            "phase": "primary",
                            "expectedPresence": "absent",
                            "caseId": case_b,
                            "imageId": "1234567890123456",
                            "targetClassId": "/m/person",
                            "target": "Person",
                            "selectionKey": "c" * 64,
                        },
                    ],
                },
                primary_rows=[row_a, row_b],
                reserve_rows=[],
                duplicate_policy=duplicate_policy_template(),
                fingerprint_index=fingerprint_index_template(entries=[]),
                transport=transport,
                output_dir=output_dir,
                primary_shortlist_sha256="a" * 64,
                reserve_commit_sha256="b" * 64,
            )
        self.assertEqual(report["status"], "infrastructure-stopped")
        statuses = [item["status"] for item in report["rejections"]]
        self.assertIn(acquire.NOT_ATTEMPTED_INFRASTRUCTURE_STOP, statuses)

    def test_mask_zip_503_stops_remaining_attempts(self) -> None:
        image_id = "0123456789abcdef"
        case_a = "0123456789abcdef0123456789abcdef"
        case_b = "123456789012345678901234567890ab"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        row_a = minimal_manifest_row(
            case_id=case_a,
            image_id=image_id,
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path=mask_path,
            mask_dims=(64, 48),
        )
        row_b = minimal_manifest_row(
            case_id=case_b,
            image_id="1234567890123456",
            class_id="/m/person",
            target="Person",
            presence="absent",
            landing_photo_id="888777666",
            mask_path=None,
            mask_dims=None,
        )
        landing_a = "https://www.flickr.com/photos/owner/999888777"
        landing_b = "https://www.flickr.com/photos/owner/888777666"
        jpeg_url = http_policy.build_open_images_jpeg_url(image_id)
        jpeg = make_jpeg(64, 48)
        zip_url = http_policy.build_mask_archive_url(image_id[0].lower())
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            write_zip_with_member(zip_path, mask_path, mask_png(64, 48))
            archive_bytes = zip_path.read_bytes()
            member_requests = {"count": 0}

            class Zip503DuringMemberTransport:
                def fetch(self, url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                    if url == landing_a:
                        return http_policy.HttpResponse(landing_a, 200, flickr_page("999888777"), {})
                    if url == landing_b:
                        return http_policy.HttpResponse(landing_b, 200, flickr_page("888777666"), {})
                    if url == jpeg_url:
                        return http_policy.HttpResponse(jpeg_url, 200, jpeg, {})
                    if url != zip_url:
                        raise validation.CurateError(f"unexpected URL: {url}")
                    total = len(archive_bytes)
                    if range_header and range_header.startswith("bytes=-"):
                        suffix_len = int(range_header.split("-")[-1])
                        start = max(0, total - suffix_len)
                        end = total - 1
                        body = archive_bytes[start : end + 1]
                        headers = {"content-range": f"bytes {start}-{end}/{total}"}
                        return http_policy.HttpResponse(url, 206, body, headers)
                    member_requests["count"] += 1
                    if member_requests["count"] >= 2:
                        return http_policy.HttpResponse(url, 503, b"", {})
                    start_s, end_s = range_header.removeprefix("bytes=").split("-")
                    start = int(start_s)
                    end = int(end_s)
                    body = archive_bytes[start : end + 1]
                    headers = {"content-range": f"bytes {start}-{end}/{total}"}
                    return http_policy.HttpResponse(url, 206, body, headers)

            output_dir = Path(tmp) / "out"
            output_dir.mkdir()
            report = acquire.run_acquisition(
                attempt_doc={
                    "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                    "selectionSeed": curate.SEED,
                    "primaryShortlistSha256": "a" * 64,
                    "reserveCommitSha256": "b" * 64,
                    "attempts": [
                        {
                            "phase": "primary",
                            "expectedPresence": "present",
                            "caseId": case_a,
                            "imageId": image_id,
                            "targetClassId": "/m/person",
                            "target": "Person",
                            "selectionKey": "c" * 64,
                        },
                        {
                            "phase": "primary",
                            "expectedPresence": "absent",
                            "caseId": case_b,
                            "imageId": "1234567890123456",
                            "targetClassId": "/m/person",
                            "target": "Person",
                            "selectionKey": "c" * 64,
                        },
                    ],
                },
                primary_rows=[row_a, row_b],
                reserve_rows=[],
                duplicate_policy=duplicate_policy_template(),
                fingerprint_index=fingerprint_index_template(entries=[]),
                transport=Zip503DuringMemberTransport(),
                output_dir=output_dir,
                local_mask_archives=None,
            )
        self.assertEqual(report["status"], "infrastructure-stopped")
        self.assertIn(acquire.NOT_ATTEMPTED_INFRASTRUCTURE_STOP, [item["status"] for item in report["rejections"]])


class ContentRangeTests(unittest.TestCase):
    def test_content_range_mismatch_rejected(self) -> None:
        image_id = "0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        payload = mask_png(64, 48)
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            write_zip_with_member(zip_path, mask_path, payload)
            archive_bytes = zip_path.read_bytes()
            url = http_policy.build_mask_archive_url(image_id[0].lower())

            class BadRangeTransport:
                def fetch(self, fetch_url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                    total = len(archive_bytes)
                    if range_header and range_header.startswith("bytes=-"):
                        suffix_len = int(range_header.split("-")[-1])
                        start = max(0, total - suffix_len)
                        end = total - 1
                        body = archive_bytes[start : end + 1]
                        headers = {"content-range": f"bytes 0-{end}/{total}"}
                        return http_policy.HttpResponse(fetch_url, 206, body, headers)
                    start_s, end_s = range_header.removeprefix("bytes=").split("-")
                    start = int(start_s)
                    end = int(end_s)
                    body = archive_bytes[start : end + 1]
                    headers = {"content-range": f"bytes {start + 1}-{end}/{total}"}
                    return http_policy.HttpResponse(fetch_url, 206, body, headers)

            with self.assertRaises(validation.CurateError):
                mask_zip.read_mask_member_bytes(
                    mask_basename=mask_path,
                    image_id=image_id,
                    transport=BadRangeTransport(),
                    local_archive=None,
                )


class PngFramingTests(unittest.TestCase):
    def test_chunk_before_ihdr_rejected(self) -> None:
        png = mask_png(8, 8)
        bogus = bytes(png[:8]) + struct.pack(">I", 0) + b"tEXt" + struct.pack(">I", 0) + png[8:]
        with self.assertRaises(validation.CurateError):
            validation.validate_png_mask_framing(bogus)

    def test_ihdr_wrong_length_rejected(self) -> None:
        png = bytearray(mask_png(8, 8))
        png[8:12] = struct.pack(">I", 12)
        with self.assertRaises(validation.CurateError):
            validation.validate_png_mask_framing(bytes(png))


class JpegExifOrientationTests(unittest.TestCase):
    def _jpeg_with_orientation(self, orientation: int) -> bytes:
        from PIL import Image

        buffer = io.BytesIO()
        image = Image.new("RGB", (32, 24), (10, 20, 30))
        exif = image.getexif()
        exif[274] = orientation
        image.save(buffer, format="JPEG", exif=exif)
        return buffer.getvalue()

    def test_orientation_1_allowed(self) -> None:
        validation.reject_non_identity_jpeg_exif_orientation(self._jpeg_with_orientation(1))

    def test_orientation_2_rejected(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.reject_non_identity_jpeg_exif_orientation(self._jpeg_with_orientation(2))


class AttemptBindingTests(unittest.TestCase):
    def test_tampered_attempt_hash_fails_closed(self) -> None:
        row = minimal_manifest_row(
            case_id="0123456789abcdef0123456789abcdef",
            image_id="0123456789abcdef",
            class_id="/m/person",
            target="Person",
            presence="present",
            landing_photo_id="999888777",
            mask_path="0123456789abcdef_mperson_abcd1234.png",
            mask_dims=(64, 48),
        )

        class NoNetworkTransport:
            def fetch(self, url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                raise AssertionError("network must not run when attempt list is tampered")

        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "out"
            output_dir.mkdir()
            with self.assertRaises(validation.CurateError):
                acquire.run_acquisition(
                    attempt_doc={
                        "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                        "selectionSeed": curate.SEED,
                        "primaryShortlistSha256": "f" * 64,
                        "reserveCommitSha256": "b" * 64,
                        "attempts": [
                            {
                                "phase": "primary",
                                "expectedPresence": "present",
                                "caseId": row["caseId"],
                                "imageId": row["imageId"],
                                "targetClassId": "/m/person",
                                "target": "Person",
                                "selectionKey": "c" * 64,
                            }
                        ],
                    },
                    primary_rows=[row],
                    reserve_rows=[],
                    duplicate_policy=duplicate_policy_template(),
                    fingerprint_index=fingerprint_index_template(entries=[]),
                    transport=NoNetworkTransport(),
                    output_dir=output_dir,
                    primary_shortlist_sha256="a" * 64,
                    reserve_commit_sha256="b" * 64,
                )


CORRECTED_PRIMARY_ARTIFACT = Path(
    "/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-dev/metadata-plan-v2-corrected/photo-shortlist-private.json"
)
RESERVE_COMMIT_ARTIFACT = Path(
    "/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-dev/metadata-reserve-v1/photo-reserve-commit-private.json"
)
RESERVE_COMMIT_SHA256 = "49a497b30dca3a7c508985006dbd2b5c85fc8f5c63d76a12751a9b2034b12dd2"


class FreezeAttemptListCliTests(unittest.TestCase):
    def test_freeze_attempt_list_cli_writes_valid_frozen_document(self) -> None:
        if not CORRECTED_PRIMARY_ARTIFACT.is_file() or not RESERVE_COMMIT_ARTIFACT.is_file():
            self.skipTest("external frozen metadata artifacts are unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "attempt-list-out"
            exit_code = acquire.main(
                [
                    "freeze-attempt-list",
                    "--primary-manifest",
                    str(CORRECTED_PRIMARY_ARTIFACT),
                    "--reserve-manifest",
                    str(RESERVE_COMMIT_ARTIFACT),
                    "--output-dir",
                    str(output_dir),
                ]
            )
            self.assertEqual(exit_code, 0)
            frozen_path = output_dir / "photo-acquisition-attempt-list.json"
            self.assertTrue(frozen_path.is_file())
            payload = json.loads(frozen_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], validation.ATTEMPT_LIST_SCHEMA_V1)
            self.assertEqual(payload["selectionSeed"], curate.SEED)
            self.assertEqual(payload["primaryShortlistSha256"], validation.CORRECTED_PRIMARY_SHORTLIST_SHA256)
            self.assertEqual(payload["reserveCommitSha256"], RESERVE_COMMIT_SHA256)
            attempts = validation.validate_attempt_list(payload)
            self.assertGreater(len(attempts), 0)
            self.assertLessEqual(len(attempts), validation.MAX_ACQUISITION_CANDIDATES)

    def test_freeze_attempt_list_cli_binds_v4_profile(self) -> None:
        root = Path("/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-dev")
        primary = root / "metadata-plan-v4-exact1024/photo-shortlist-private.json"
        reserve = root / "metadata-reserve-v4-exact1024/photo-reserve-commit-private.json"
        if not primary.is_file() or not reserve.is_file():
            self.skipTest("external v4 metadata artifacts are unavailable")
        primary_sha = validation.sha256_file(primary)
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "attempt-list-v4-out"
            exit_code = acquire.main(
                [
                    "freeze-attempt-list",
                    "--primary-manifest",
                    str(primary),
                    "--primary-shortlist-sha256",
                    primary_sha,
                    "--reserve-manifest",
                    str(reserve),
                    "--metadata-profile",
                    validation.METADATA_PROFILE_V4,
                    "--output-dir",
                    str(output_dir),
                ]
            )
            self.assertEqual(exit_code, 0)
            payload = json.loads(
                (output_dir / "photo-acquisition-attempt-list.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["schemaVersion"], validation.ATTEMPT_LIST_SCHEMA_V3)
            self.assertEqual(payload["metadataProfile"], validation.METADATA_PROFILE_V4)
            self.assertEqual(len(validation.validate_attempt_list(payload)), 40)


class FingerprintIndexV2Tests(unittest.TestCase):
    def test_exact_only_hashes_block_without_phash(self) -> None:
        exact = "9" * 64
        payload = {
            "schemaVersion": validation.FINGERPRINT_INDEX_SCHEMA_V2,
            "exclusionAuditSha256": "a" * 64,
            "perceptualHashAlgorithmId": validation.PERCEPTUAL_HASH_ALGORITHM_ID,
            "perceptualHashResampler": validation.PERCEPTUAL_HASH_RESAMPLER,
            "pillowVersion": validation.runtime_pillow_version(),
            "entries": [],
            "exactOnlyEncodedSha256": [exact],
        }
        validated = validation.validate_fingerprint_index(payload)
        state = acquire.load_duplicate_state(validated)
        self.assertIn(exact, state.encoded_sha256)
        self.assertEqual(state.decoded_rgb_sha256, set())
        self.assertEqual(state.perceptual_hash64, set())

    def test_v2_coverage_requires_union_of_entries_and_exact_only(self) -> None:
        full = "1" * 64
        exact = "2" * 64
        payload = validation.validate_fingerprint_index(
            {
                "schemaVersion": validation.FINGERPRINT_INDEX_SCHEMA_V2,
                "exclusionAuditSha256": "a" * 64,
                "perceptualHashAlgorithmId": validation.PERCEPTUAL_HASH_ALGORITHM_ID,
                "perceptualHashResampler": validation.PERCEPTUAL_HASH_RESAMPLER,
                "pillowVersion": validation.runtime_pillow_version(),
                "entries": [
                    {
                        "encodedSha256": full,
                        "decodedRgbSha256": "3" * 64,
                        "perceptualHash64": "0123456789abcdef",
                    }
                ],
                "exactOnlyEncodedSha256": [exact],
            }
        )
        validation.validate_fingerprint_index_v2_exclusion_coverage(
            payload,
            exclusion_audit_sha256="a" * 64,
            excluded_encoded_sha256={full, exact},
        )


class AcquisitionExitCodeTests(unittest.TestCase):
    def test_exit_code_mapping(self) -> None:
        self.assertEqual(acquire.acquisition_exit_code({"status": "complete"}), 0)
        self.assertEqual(acquire.acquisition_exit_code({"status": "quota-shortfall"}), 2)
        self.assertEqual(acquire.acquisition_exit_code({"status": "infrastructure-stopped"}), 3)


class AttemptCapTests(unittest.TestCase):
    def test_attempt_list_rejects_more_than_forty_rows(self) -> None:
        attempts = [
            {
                "phase": "primary",
                "expectedPresence": "present",
                "caseId": f"{index:032x}",
                "imageId": f"{index:016x}",
                "targetClassId": "/m/person",
                "target": "Person",
                "selectionKey": "a" * 64,
            }
            for index in range(41)
        ]
        with self.assertRaises(validation.CurateError):
            validation.validate_attempt_list(
                {
                    "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
                    "selectionSeed": curate.SEED,
                    "primaryShortlistSha256": "a" * 64,
                    "reserveCommitSha256": "b" * 64,
                    "attempts": attempts,
                }
            )


if __name__ == "__main__":
    unittest.main()
