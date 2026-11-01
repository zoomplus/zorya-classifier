#!/usr/bin/env python3
"""Offline fixture tests for H8a fresh DEV metadata curation helpers."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[2]
PINNED_AUDIT = Path("/root/.codex/artifacts/zorya-classifier-mcp-20261031/prior-source-exclusions.json")


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


validation = load_module("fresh_dev_validation", "validation.py")
curate = load_module("fresh_dev_curate", "curate.py")

IMAGES_HEADERS = curate.IMAGES_HEADERS
CLASSES_HEADERS = curate.CLASSES_HEADERS
BOXES_HEADERS = curate.BOXES_HEADERS
LABELS_HEADERS = curate.LABELS_HEADERS
MASK_HEADERS = curate.MASK_HEADERS
PHOTO_LICENSE = validation.PHOTO_LICENSE


def write_csv(path: Path, headers: tuple[str, ...], rows: list[tuple[str, ...]]) -> None:
    import csv

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        for row in rows:
            writer.writerow(row)


def image_row(image_id: str, author_slug: str) -> tuple[str, ...]:
    return (
        image_id,
        "validation",
        f"https://farm.example/{image_id}.jpg",
        f"https://www.flickr.com/photos/owner/{image_id}",
        PHOTO_LICENSE,
        f"https://www.flickr.com/people/{author_slug}",
        "Author Name",
        "Title",
        "1000",
        "abc123==",
        f"https://farm.example/{image_id}_t.jpg",
        "0",
    )


def box_row(
    image_id: str,
    class_id: str,
    xmin: str = "0.1",
    ymin: str = "0.1",
    xmax: str = "0.4",
    ymax: str = "0.4",
    *,
    group_of: str = "0",
    depiction: str = "0",
) -> tuple[str, ...]:
    return (
        image_id,
        "xclick",
        class_id,
        "1",
        xmin,
        xmax,
        ymin,
        ymax,
        "0",
        "0",
        group_of,
        depiction,
        "0",
    )


def label_row(image_id: str, class_id: str, confidence: str) -> tuple[str, ...]:
    return (image_id, "verification", class_id, confidence)


def mask_path_for(image_id: str, class_id: str, box_id: str) -> str:
    slug = class_id.replace("/", "")
    return f"{image_id}_{slug}_{box_id}.png"


def mask_row(
    image_id: str,
    class_id: str,
    box_id: str = "b62eb236",
    xmin: str = "0.1",
    xmax: str = "0.4",
    ymin: str = "0.1",
    ymax: str = "0.4",
) -> tuple[str, ...]:
    return (
        mask_path_for(image_id, class_id, box_id),
        image_id,
        class_id,
        box_id,
        xmin,
        xmax,
        ymin,
        ymax,
        "0.00000",
        "",
    )


def write_mask_fixtures(
    tmp: Path,
    *,
    positives: int,
    negatives: int,
    mask_rows: list[tuple[str, ...]] | None = None,
    header_entries: dict[str, dict[str, int]] | None = None,
) -> tuple[Path, Path]:
    mask_csv = tmp / "masks.csv"
    rows = mask_rows if mask_rows is not None else []
    if not rows:
        for index in range(positives):
            image_id = f"{index:016x}"
            class_id = ["/m/person", "/m/car", "/m/dog"][index % 3]
            rows.append(mask_row(image_id, class_id, box_id=f"{index:08x}"))
    write_csv(mask_csv, MASK_HEADERS, rows)
    mask_bytes = mask_csv.read_bytes()
    mask_csv_sha256 = validation.sha256_bytes(mask_bytes)
    if header_entries is None:
        entries = {row[0]: {"width": 640, "height": 480} for row in rows}
    else:
        entries = header_entries
    header_path = tmp / "mask-header-index.json"
    header_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "source": validation.MASK_HEADER_INDEX_SOURCE,
                "maskCsvSha256": mask_csv_sha256,
                "entries": entries,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return mask_csv, header_path


def write_synthetic_source(source_dir: Path, *, positives: int, negatives: int) -> None:
    write_csv(
        source_dir / "classes.csv",
        CLASSES_HEADERS,
        [("/m/person", "Person"), ("/m/car", "Car"), ("/m/dog", "Dog")],
    )
    image_rows: list[tuple[str, ...]] = []
    box_rows: list[tuple[str, ...]] = []
    label_rows: list[tuple[str, ...]] = []
    for index in range(positives):
        image_id = f"{index:016x}"
        class_id = ["/m/person", "/m/car", "/m/dog"][index % 3]
        image_rows.append(image_row(image_id, f"author-pos-{index:03d}"))
        box_rows.append(box_row(image_id, class_id))
        label_rows.append(label_row(image_id, class_id, "1"))
    for index in range(negatives):
        image_id = f"neg{index:012x}"
        class_id = ["/m/person", "/m/car", "/m/dog"][index % 3]
        image_rows.append(image_row(image_id, f"author-neg-{index:03d}"))
        label_rows.append(label_row(image_id, class_id, "0"))
    write_csv(source_dir / "images.csv", IMAGES_HEADERS, image_rows)
    write_csv(source_dir / "boxes.csv", BOXES_HEADERS, box_rows)
    write_csv(source_dir / "labels.csv", LABELS_HEADERS, label_rows)


def plan_argv(source_dir: Path, output_dir: Path, mask_csv: Path, mask_header: Path) -> list[str]:
    return [
        "plan",
        "--source-dir",
        str(source_dir),
        "--mask-csv",
        str(mask_csv),
        "--mask-header-index",
        str(mask_header),
        "--exclusion-audit",
        str(PINNED_AUDIT),
        "--output-dir",
        str(output_dir),
    ]


class StrictJsonTests(unittest.TestCase):
    def test_rejects_duplicate_keys(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.loads_strict_json('{"a": 1, "a": 2}', label="payload")

    def test_rejects_nan(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.loads_strict_json(json.dumps({"x": float("nan")}), label="payload")

    def test_rejects_non_object_root_for_private_manifest(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.validate_private_photo_manifest([])


class BoxTests(unittest.TestCase):
    def test_accepts_normalized_source_bounds(self) -> None:
        self.assertEqual(validation.validate_normalized_box([0.0, 0.0, 1.0, 1.0]), [0.0, 0.0, 1.0, 1.0])

    def test_rejects_inverted_bounds(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.validate_normalized_box([0.5, 0.5, 0.4, 0.6])

    def test_rejects_string_coordinates(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.validate_normalized_box(["0.1", 0.1, 0.4, 0.4])

    def test_rejects_bool_coordinates(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.validate_normalized_box([True, 0.1, 0.4, 0.4])


def minimal_producer_record(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "caseId": "0123456789abcdef0123456789abcdef",
        "target": "Car",
        "task": "classify-visible-object",
        "image": {"path": "images/a.jpg", "sha256": "a" * 64, "width": 640, "height": 480},
        "locate": {"target": "Car"},
        "classify": {"task": "classify-visible-object"},
    }
    record.update(overrides)
    return record


class ProducerSanitizerTests(unittest.TestCase):
    def test_accepts_minimal_opaque_record(self) -> None:
        case_id = "0123456789abcdef0123456789abcdef"
        record = validation.sanitize_producer_record(minimal_producer_record(caseId=case_id))
        self.assertEqual(record["caseId"], case_id)

    def test_accepts_uuidv4_case_id(self) -> None:
        case_id = "550e8400-e29b-41d4-a716-446655440000"
        record = validation.sanitize_producer_record(minimal_producer_record(caseId=case_id))
        self.assertEqual(record["caseId"], case_id)

    def test_rejects_non_opaque_case_id(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.sanitize_producer_record(minimal_producer_record(caseId="opaque-case-001"))

    def test_rejects_case_id_path_separators(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.sanitize_producer_record(
                minimal_producer_record(caseId="0123456789abcdef0123456789abc/def")
            )

    def test_rejects_truth_leak(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.sanitize_producer_record(
                minimal_producer_record(
                    caseId="1234567890abcdef1234567890abcdef",
                    imageId="secret",
                )
            )


class NegativeEvidenceTests(unittest.TestCase):
    def test_rejects_bool_confidence(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.validate_negative_evidence(
                {
                    "type": "explicit-human-verified-image-label",
                    "source": "verification",
                    "confidence": False,
                    "sourceCsvRow": 3,
                    "sourceFile": "labels.csv",
                }
            )


class PrivateManifestTests(unittest.TestCase):
    def test_absent_requires_negative_evidence(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.validate_private_photo_row(
                {
                    "caseId": "0123456789abcdef0123456789abcdef",
                    "expectedPresence": "absent",
                    "imageId": "abc",
                    "targetClassId": "/m/car",
                    "target": "Car",
                    "authorProfileUrl": "https://www.flickr.com/people/x",
                    "rightsReviewStatus": "pending",
                    "datasetLicenseMetadata": {"note": "n", "licenseUrl": PHOTO_LICENSE},
                    "sourceUrls": {
                        "originalUrl": "u",
                        "originalLandingUrl": "l",
                        "licenseUrl": PHOTO_LICENSE,
                        "author": "a",
                        "title": "t",
                    },
                    "targetBoxes": [],
                    "negativeEvidence": None,
                },
                index=0,
            )


class CsvLoaderTests(unittest.TestCase):
    def test_rejects_duplicate_headers(self) -> None:
        raw = b"ImageID,ImageID\nabc,def\n"
        with self.assertRaises(validation.CurateError):
            validation.parse_strict_csv_from_bytes(raw, ("ImageID", "ImageID"), "dup.csv", max_rows=10)

    def test_rejects_extra_columns(self) -> None:
        raw = b"ImageID,Subset\nabc,validation,extra\n"
        with self.assertRaises(validation.CurateError):
            validation.parse_strict_csv_from_bytes(raw, ("ImageID", "Subset"), "extra.csv", max_rows=10)

    def test_rejects_short_rows(self) -> None:
        raw = b"ImageID,Subset\nabc\n"
        with self.assertRaises(validation.CurateError):
            validation.parse_strict_csv_from_bytes(raw, ("ImageID", "Subset"), "short.csv", max_rows=10)

    def test_hash_stable_on_reparse(self) -> None:
        raw = b"LabelName,DisplayName\n/m/person,Person\n"
        _, digest_a = validation.parse_strict_csv_from_bytes(raw, CLASSES_HEADERS, "classes.csv", max_rows=10)
        _, digest_b = validation.parse_strict_csv_from_bytes(raw, CLASSES_HEADERS, "classes.csv", max_rows=10)
        self.assertEqual(digest_a, digest_b)
        self.assertEqual(digest_a, validation.sha256_bytes(raw))

    def test_rejects_field_length_cap(self) -> None:
        long_value = "x" * (validation.MAX_CSV_FIELD_CHARS + 1)
        raw = f"ImageID,Subset\n{long_value},validation\n".encode("utf-8")
        with self.assertRaises(validation.CurateError) as ctx:
            validation.parse_strict_csv_from_bytes(raw, ("ImageID", "Subset"), "long-field.csv", max_rows=10)
        self.assertIn("field length cap", str(ctx.exception))

    def test_rejects_single_file_byte_cap_in_parser(self) -> None:
        oversized = b"x" * (validation.MAX_SINGLE_CSV_BYTES + 1)
        with self.assertRaises(validation.CurateError) as ctx:
            validation.parse_strict_csv_from_bytes(oversized, ("ImageID",), "big.csv", max_rows=1)
        self.assertIn("byte cap", str(ctx.exception))

    def test_read_bounded_file_rejects_byte_cap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tiny.csv"
            path.write_bytes(b"a" * 64)
            with self.assertRaises(validation.CurateError) as ctx:
                validation.read_bounded_file_bytes(path, max_bytes=32, label="tiny.csv")
            self.assertIn("byte cap", str(ctx.exception))

    def test_load_metadata_hashes_unchanged_after_source_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [("/m/person", "Person")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [])
            classes_path = source_dir / "classes.csv"
            original_bytes = classes_path.read_bytes()
            metadata = curate.load_openimages_metadata(source_dir)
            self.assertEqual(metadata["sourceCsvSha256"]["classes.csv"], validation.sha256_bytes(original_bytes))
            classes_path.write_bytes(original_bytes + b"\n# mutated on disk\n")
            self.assertEqual(metadata["sourceCsvSha256"]["classes.csv"], validation.sha256_bytes(original_bytes))
            self.assertNotEqual(
                validation.sha256_bytes(classes_path.read_bytes()),
                metadata["sourceCsvSha256"]["classes.csv"],
            )

    def test_rejects_row_cap(self) -> None:
        header = b"ImageID,Subset\n"
        body = b"a,validation\n" * 3
        raw = header + body
        with self.assertRaises(validation.CurateError):
            validation.parse_strict_csv_from_bytes(raw, ("ImageID", "Subset"), "rows.csv", max_rows=2)

    def test_audit_images_hash_enforced_when_paths_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            images_path = source_dir / "images.csv"
            write_csv(images_path, IMAGES_HEADERS, [])
            digest = validation.sha256_bytes(images_path.read_bytes())
            payload = {
                "sources": [{"path": str(images_path.resolve()), "sha256": "f" * 64}],
            }
            with self.assertRaises(validation.CurateError):
                validation.require_audit_source_hash(
                    payload,
                    basename="images.csv",
                    digest=digest,
                    source_dir=source_dir,
                )

    def test_duplicate_class_ids_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [("/m/person", "Person"), ("/m/person", "Person")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [])
            with self.assertRaises(curate.CurateError) as ctx:
                curate.load_openimages_metadata(source_dir)
            self.assertIn("duplicate LabelName", str(ctx.exception))

    def test_malformed_boxes_row_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "f" * 16
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [("/m/person", "Person")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-box-bad")])
            write_csv(
                source_dir / "boxes.csv",
                BOXES_HEADERS,
                [box_row(image_id, "/m/person", xmin="not-a-number")],
            )
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [])
            metadata = curate.load_openimages_metadata(source_dir)
            with self.assertRaises(curate.CurateError) as ctx:
                curate.build_indexes(metadata)
            self.assertIn("boxes.csv row 2", str(ctx.exception))


class OpaqueCaseIdTests(unittest.TestCase):
    def test_case_id_ignores_presence_polarity(self) -> None:
        image_id = "0123456789abcdef"
        class_id = "/m/person"
        case_a = curate.opaque_case_id(image_id, class_id)
        case_b = curate.opaque_case_id(image_id, class_id)
        self.assertEqual(case_a, case_b)
        self.assertEqual(len(case_a), 32)
        self.assertNotIn("positive", case_a)
        self.assertNotIn("negative", case_a)

    def test_named_seed_is_local_and_does_not_change_historical_default_after_error(self) -> None:
        image_id = "seed-locality-image"
        class_id = "seed-locality-class"
        historical_key = curate.deterministic_key("positive", image_id, class_id)
        historical_case = curate.opaque_case_id(image_id, class_id)
        disjoint_seed = "h8a-independent-dev40-20261101-r1"
        disjoint_key = curate.deterministic_key("positive", image_id, class_id, seed=disjoint_seed)
        disjoint_case = curate.opaque_case_id(image_id, class_id, seed=disjoint_seed)
        self.assertNotEqual(disjoint_key, historical_key)
        self.assertNotEqual(disjoint_case, historical_case)

        with self.assertRaises(KeyError):
            curate.scan_candidates(
                {},
                {"excludedImageIds": set(), "excludedSourceGroups": set()},
                mask_row_index={},
                mask_header_entries={},
                selection_seed=disjoint_seed,
            )

        self.assertEqual(curate.deterministic_key("positive", image_id, class_id), historical_key)
        self.assertEqual(curate.opaque_case_id(image_id, class_id), historical_case)


class MaskPathSlugTests(unittest.TestCase):
    def test_expected_path_allows_underscore_in_label_slug(self) -> None:
        image_id = "b3c6af94adbac4af"
        class_id = "/m/04_sv"
        box_id = "42114318"
        expected = validation.expected_open_images_v5_mask_path(image_id, class_id, box_id)
        self.assertEqual(expected, f"{image_id}_m04_sv_{box_id}.png")
        validation.open_images_v5_mask_path_matches_row(
            expected,
            image_id=image_id,
            label_name=class_id,
            box_id=box_id,
            label="mask CSV row 2.MaskPath",
        )

    def test_rejects_underscore_in_image_or_box_tokens(self) -> None:
        with self.assertRaises(validation.CurateError):
            validation.expected_open_images_v5_mask_path("bad_image_id", "/m/04_sv", "42114318")
        with self.assertRaises(validation.CurateError):
            validation.expected_open_images_v5_mask_path("b3c6af94adbac4af", "/m/04_sv", "bad_box_id")

    def test_wrong_image_class_or_box_tokens_still_rejected(self) -> None:
        image_id = "b3c6af94adbac4af"
        class_id = "/m/04_sv"
        box_id = "42114318"
        expected = validation.expected_open_images_v5_mask_path(image_id, class_id, box_id)
        with self.assertRaises(validation.CurateError):
            validation.open_images_v5_mask_path_matches_row(
                expected,
                image_id="0" * 16,
                label_name=class_id,
                box_id=box_id,
                label="mask CSV row 2.MaskPath",
            )
        with self.assertRaises(validation.CurateError):
            validation.open_images_v5_mask_path_matches_row(
                expected,
                image_id=image_id,
                label_name="/m/person",
                box_id=box_id,
                label="mask CSV row 2.MaskPath",
            )
        with self.assertRaises(validation.CurateError):
            validation.open_images_v5_mask_path_matches_row(
                expected,
                image_id=image_id,
                label_name=class_id,
                box_id="deadbeef",
                label="mask CSV row 2.MaskPath",
            )

    def test_underscore_label_slug_passes_candidate_scan(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "b3c6af94adbac4af"
            class_id = "/m/04_sv"
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [(class_id, "Car")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-underscore-slug")])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [box_row(image_id, class_id)])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [label_row(image_id, class_id, "1")])
            mask_csv, header_path = write_mask_fixtures(
                Path(tmp),
                positives=0,
                negatives=0,
                mask_rows=[mask_row(image_id, class_id, box_id="42114318")],
            )
            mask_rows, _mask_digest = curate.load_instance_mask_metadata(mask_csv)
            header_entries, _header_digest = validation.load_mask_header_index_from_bytes(
                header_path.read_bytes(),
                mask_csv_sha256=validation.sha256_bytes(mask_csv.read_bytes()),
            )
            metadata = curate.load_openimages_metadata(source_dir)
            indexes = curate.build_indexes(metadata)
            positives, _negatives, tally, _examples = curate.scan_candidates(
                indexes,
                {"excludedImageIds": set(), "excludedSourceGroups": set()},
                mask_row_index=curate.build_mask_row_index(mask_rows),
                mask_header_entries=header_entries,
            )
            self.assertEqual(tally.get("mask-path-metadata-mismatch", 0), 0)
            self.assertEqual(len(positives), 1)
            self.assertEqual(positives[0]["imageId"], image_id)
            self.assertEqual(positives[0]["classId"], class_id)


class MaskIndexTests(unittest.TestCase):
    def test_rejects_mask_csv_sha_mismatch(self) -> None:
        payload = {
            "schemaVersion": 1,
            "source": validation.MASK_HEADER_INDEX_SOURCE,
            "maskCsvSha256": "a" * 64,
            "entries": {},
        }
        raw = (json.dumps(payload) + "\n").encode("utf-8")
        with self.assertRaises(validation.CurateError):
            validation.load_mask_header_index_from_bytes(raw, mask_csv_sha256="b" * 64)

    def test_rejects_nonpositive_dimensions(self) -> None:
        payload = {
            "schemaVersion": 1,
            "source": validation.MASK_HEADER_INDEX_SOURCE,
            "maskCsvSha256": "a" * 64,
            "entries": {"mask.png": {"width": 0, "height": 10}},
        }
        raw = (json.dumps(payload) + "\n").encode("utf-8")
        with self.assertRaises(validation.CurateError):
            validation.load_mask_header_index_from_bytes(raw, mask_csv_sha256="a" * 64)


class MaskJoinTests(unittest.TestCase):
    def _scan(self, source_dir: Path, mask_csv: Path, header_path: Path) -> tuple[list, list, dict, dict]:
        mask_rows, _mask_digest = curate.load_instance_mask_metadata(mask_csv)
        header_raw = header_path.read_bytes()
        header_entries, _header_digest = validation.load_mask_header_index_from_bytes(
            header_raw,
            mask_csv_sha256=validation.sha256_bytes(mask_csv.read_bytes()),
        )
        metadata = curate.load_openimages_metadata(source_dir)
        indexes = curate.build_indexes(metadata)
        return curate.scan_candidates(
            indexes,
            {"excludedImageIds": set(), "excludedSourceGroups": set()},
            mask_row_index=curate.build_mask_row_index(mask_rows),
            mask_header_entries=header_entries,
        )

    def test_ambiguous_visible_instance_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "0" * 16
            class_id = "/m/person"
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [(class_id, "Person")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-a")])
            write_csv(
                source_dir / "boxes.csv",
                BOXES_HEADERS,
                [
                    box_row(image_id, class_id, "0.1", "0.1", "0.3", "0.3"),
                    box_row(image_id, class_id, "0.5", "0.5", "0.8", "0.8"),
                ],
            )
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [label_row(image_id, class_id, "1")])
            mask_csv, header_path = write_mask_fixtures(
                Path(tmp),
                positives=0,
                negatives=0,
                mask_rows=[mask_row(image_id, class_id)],
            )
            positives, _negatives, tally, _examples = self._scan(source_dir, mask_csv, header_path)
            self.assertEqual(positives, [])
            self.assertEqual(tally["ambiguous-visible-instance"], 1)

    def test_missing_and_multiple_mask_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "1" * 16
            class_id = "/m/car"
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [(class_id, "Car")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-b")])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [box_row(image_id, class_id)])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [label_row(image_id, class_id, "1")])
            mask_csv, header_path = write_mask_fixtures(Path(tmp), positives=0, negatives=0, mask_rows=[])
            positives, _negatives, tally, _examples = self._scan(source_dir, mask_csv, header_path)
            self.assertEqual(positives, [])
            self.assertEqual(tally["missing-instance-mask-row"], 1)

            duplicate_rows = [
                mask_row(image_id, class_id, box_id="aaaaaaaa"),
                mask_row(image_id, class_id, box_id="bbbbbbbb"),
            ]
            dup_dir = Path(tmp) / "dup"
            dup_dir.mkdir()
            mask_csv2, header_path2 = write_mask_fixtures(
                dup_dir,
                positives=0,
                negatives=0,
                mask_rows=duplicate_rows,
            )
            positives2, _negatives2, tally2, _examples2 = self._scan(source_dir, mask_csv2, header_path2)
            self.assertEqual(positives2, [])
            self.assertEqual(tally2["multiple-instance-mask-rows"], 1)

    def test_box_mismatch_and_missing_header_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "2" * 16
            class_id = "/m/dog"
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [(class_id, "Dog")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-c")])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [box_row(image_id, class_id)])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [label_row(image_id, class_id, "1")])
            mask_csv, header_path = write_mask_fixtures(
                Path(tmp),
                positives=0,
                negatives=0,
                mask_rows=[mask_row(image_id, class_id, xmin="0.9", xmax="0.95", ymin="0.9", ymax="0.95")],
            )
            positives, _negatives, tally, _examples = self._scan(source_dir, mask_csv, header_path)
            self.assertEqual(positives, [])
            self.assertEqual(tally["instance-mask-box-mismatch"], 1)

            hdr_dir = Path(tmp) / "hdr"
            hdr_dir.mkdir()
            mask_csv2, header_path2 = write_mask_fixtures(
                hdr_dir,
                positives=0,
                negatives=0,
                mask_rows=[mask_row(image_id, class_id, box_id="cccccccc")],
                header_entries={},
            )
            positives2, _negatives2, tally2, _examples2 = self._scan(source_dir, mask_csv2, header_path2)
            self.assertEqual(positives2, [])
            self.assertEqual(tally2["missing-mask-header-entry"], 1)

    def test_mask_path_metadata_mismatch_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "3" * 16
            class_id = "/m/person"
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [(class_id, "Person")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-d")])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [box_row(image_id, class_id)])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [label_row(image_id, class_id, "1")])
            wrong_path = mask_path_for("4" * 16, class_id, "b62eb236")
            mask_csv, header_path = write_mask_fixtures(
                Path(tmp),
                positives=0,
                negatives=0,
                mask_rows=[
                    (
                        wrong_path,
                        image_id,
                        class_id,
                        "b62eb236",
                        "0.1",
                        "0.4",
                        "0.1",
                        "0.4",
                        "0.00000",
                        "",
                    )
                ],
            )
            positives, _negatives, tally, _examples = self._scan(source_dir, mask_csv, header_path)
            self.assertEqual(positives, [])
            self.assertEqual(tally["mask-path-metadata-mismatch"], 1)

    def test_mask_path_wrong_box_id_in_filename_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "5" * 16
            class_id = "/m/car"
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [(class_id, "Car")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-e")])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [box_row(image_id, class_id)])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [label_row(image_id, class_id, "1")])
            wrong_path = mask_path_for(image_id, class_id, "deadbeef")
            mask_csv, header_path = write_mask_fixtures(
                Path(tmp),
                positives=0,
                negatives=0,
                mask_rows=[
                    (
                        wrong_path,
                        image_id,
                        class_id,
                        "b62eb236",
                        "0.1",
                        "0.4",
                        "0.1",
                        "0.4",
                        "0.00000",
                        "",
                    )
                ],
            )
            positives, _negatives, tally, _examples = self._scan(source_dir, mask_csv, header_path)
            self.assertEqual(positives, [])
            self.assertEqual(tally["mask-path-metadata-mismatch"], 1)


class ExclusionAuditTests(unittest.TestCase):
    @unittest.skipUnless(PINNED_AUDIT.is_file(), "pinned exclusion audit unavailable")
    def test_validate_exclusion_audit_returns_bounded_digest(self) -> None:
        result = validation.validate_exclusion_audit(PINNED_AUDIT)
        self.assertEqual(result["auditSha256"], validation.EXCLUSION_AUDIT_SHA256)
        self.assertIn("payload", result)


class ReserveCommitTests(unittest.TestCase):
    @unittest.skipUnless(PINNED_AUDIT.is_file(), "pinned exclusion audit unavailable")
    def test_commit_reserves_disjoint_from_primary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            write_synthetic_source(source_dir, positives=40, negatives=10)
            mask_csv, header_path = write_mask_fixtures(Path(tmp), positives=40, negatives=0)
            plan_out = Path(tmp) / "plan-out"
            self.assertEqual(curate.main(plan_argv(source_dir, plan_out, mask_csv, header_path)), 0)
            primary_path = plan_out / "photo-shortlist-private.json"
            reserve_out = Path(tmp) / "reserve-out"
            argv = [
                "commit-reserves",
                "--source-dir",
                str(source_dir),
                "--mask-csv",
                str(mask_csv),
                "--mask-header-index",
                str(header_path),
                "--exclusion-audit",
                str(PINNED_AUDIT),
                "--primary-manifest",
                str(primary_path),
                "--output-dir",
                str(reserve_out),
            ]
            self.assertEqual(curate.main(argv), 0)
            reserve_payload = json.loads((reserve_out / "photo-reserve-commit-private.json").read_text(encoding="utf-8"))
            validation.validate_reserve_manifest(reserve_payload)
            primary = json.loads(primary_path.read_text(encoding="utf-8"))
            primary_images = {row["imageId"] for row in primary["rows"]}
            primary_groups = {validation.normalize_source_group(row["authorProfileUrl"]) for row in primary["rows"]}
            reserve_images = {row["imageId"] for row in reserve_payload["rows"]}
            reserve_groups = {validation.normalize_source_group(row["authorProfileUrl"]) for row in reserve_payload["rows"]}
            self.assertFalse(primary_images & reserve_images)
            self.assertFalse(primary_groups & reserve_groups)


class PlanCommandTests(unittest.TestCase):
    @unittest.skipUnless(PINNED_AUDIT.is_file(), "pinned exclusion audit unavailable")
    def test_plan_writes_external_private_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            output_dir = Path(tmp) / "plan-out"
            source_dir.mkdir()
            write_synthetic_source(source_dir, positives=20, negatives=6)
            mask_csv, header_path = write_mask_fixtures(Path(tmp), positives=20, negatives=0)
            self.assertEqual(curate.main(plan_argv(source_dir, output_dir, mask_csv, header_path)), 0)
            private_path = output_dir / "photo-shortlist-private.json"
            summary_path = output_dir / "metadata-plan-summary.json"
            self.assertTrue(private_path.is_file())
            self.assertTrue(summary_path.is_file())
            private = json.loads(private_path.read_text(encoding="utf-8"))
            validation.validate_private_photo_manifest(private)
            self.assertEqual(len(private["rows"]), 20)
            for row in private["rows"]:
                validation.require_opaque_case_id(row["caseId"], "caseId")
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["selectedPositive"], 16)
            self.assertEqual(summary["selectedNegative"], 4)
            self.assertIn("pending-jpeg-canvas", summary["status"])
            self.assertIn("maskCsvSha256", summary)
            self.assertNotIn("inclusive upper bounds", summary["coordinateConvention"])

    @unittest.skipUnless(PINNED_AUDIT.is_file(), "pinned exclusion audit unavailable")
    def test_plan_blocked_insufficient_quota(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            output_dir = Path(tmp) / "plan-out"
            source_dir.mkdir()
            write_synthetic_source(source_dir, positives=10, negatives=6)
            mask_csv, header_path = write_mask_fixtures(Path(tmp), positives=10, negatives=0)
            self.assertEqual(curate.main(plan_argv(source_dir, output_dir, mask_csv, header_path)), 1)
            self.assertFalse((output_dir / "photo-shortlist-private.json").exists())
            audit = json.loads((output_dir / "metadata-plan-audit.json").read_text(encoding="utf-8"))
            self.assertEqual(audit["status"], "blocked-insufficient-quota")
            self.assertEqual(audit["eligibleMaskMetadataPositiveCandidates"], 10)

    def test_plan_rejects_existing_output_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            output_dir = Path(tmp) / "plan-out"
            source_dir.mkdir()
            output_dir.mkdir()
            write_synthetic_source(source_dir, positives=20, negatives=6)
            mask_csv, header_path = write_mask_fixtures(Path(tmp), positives=20, negatives=0)
            if not PINNED_AUDIT.is_file():
                self.skipTest("pinned exclusion audit unavailable")
            with self.assertRaises(SystemExit):
                curate.main(plan_argv(source_dir, output_dir, mask_csv, header_path))


class VerificationContradictionTests(unittest.TestCase):
    def test_contradictory_labels_rejected_from_both_pools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "0" * 16
            class_id = "/m/person"
            write_csv(
                source_dir / "classes.csv",
                CLASSES_HEADERS,
                [(class_id, "Person")],
            )
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-contradiction")])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [box_row(image_id, class_id)])
            write_csv(
                source_dir / "labels.csv",
                LABELS_HEADERS,
                [
                    label_row(image_id, class_id, "1"),
                    label_row(image_id, class_id, "0"),
                ],
            )
            metadata = curate.load_openimages_metadata(source_dir)
            indexes = curate.build_indexes(metadata)
            self.assertIn((image_id, class_id), indexes["verificationContradictions"])
            mask_csv, header_path = write_mask_fixtures(Path(tmp), positives=1, negatives=0)
            mask_rows, _ = curate.load_instance_mask_metadata(mask_csv)
            header_raw = header_path.read_bytes()
            header_entries, _ = validation.load_mask_header_index_from_bytes(
                header_raw,
                mask_csv_sha256=validation.sha256_bytes(mask_csv.read_bytes()),
            )
            positives, negatives, tally, _examples = curate.scan_candidates(
                indexes,
                {"excludedImageIds": set(), "excludedSourceGroups": set()},
                mask_row_index=curate.build_mask_row_index(mask_rows),
                mask_header_entries=header_entries,
            )
            self.assertEqual(positives, [])
            self.assertEqual(negatives, [])
            self.assertEqual(tally["verification-label-contradiction"], 1)


class MaskDimensionCapTests(unittest.TestCase):
    def _scan_with_dims(
        self,
        width: int,
        height: int,
        *,
        require_exact_max_dimension: bool = False,
    ) -> tuple[list, dict]:
        with tempfile.TemporaryDirectory() as tmp:
            source_dir = Path(tmp) / "source"
            source_dir.mkdir()
            image_id = "6" * 16
            class_id = "/m/person"
            write_csv(source_dir / "classes.csv", CLASSES_HEADERS, [(class_id, "Person")])
            write_csv(source_dir / "images.csv", IMAGES_HEADERS, [image_row(image_id, "author-dim-cap")])
            write_csv(source_dir / "boxes.csv", BOXES_HEADERS, [box_row(image_id, class_id)])
            write_csv(source_dir / "labels.csv", LABELS_HEADERS, [label_row(image_id, class_id, "1")])
            mask_path = mask_path_for(image_id, class_id, "b62eb236")
            mask_csv, header_path = write_mask_fixtures(
                Path(tmp),
                positives=0,
                negatives=0,
                mask_rows=[mask_row(image_id, class_id, box_id="b62eb236")],
                header_entries={mask_path: {"width": width, "height": height}},
            )
            mask_rows, _ = curate.load_instance_mask_metadata(mask_csv)
            header_entries, _ = validation.load_mask_header_index_from_bytes(
                header_path.read_bytes(),
                mask_csv_sha256=validation.sha256_bytes(mask_csv.read_bytes()),
            )
            metadata = curate.load_openimages_metadata(source_dir)
            indexes = curate.build_indexes(metadata)
            positives, _negatives, tally, _examples = curate.scan_candidates(
                indexes,
                {"excludedImageIds": set(), "excludedSourceGroups": set()},
                mask_row_index=curate.build_mask_row_index(mask_rows),
                mask_header_entries=header_entries,
                require_exact_max_dimension=require_exact_max_dimension,
            )
            return positives, tally

    def test_1024_by_1024_admitted(self) -> None:
        positives, tally = self._scan_with_dims(1024, 1024)
        self.assertEqual(len(positives), 1)
        self.assertEqual(tally.get("mask-header-dimension-exceeds-cap", 0), 0)

    def test_width_1025_rejected(self) -> None:
        positives, tally = self._scan_with_dims(1025, 512)
        self.assertEqual(positives, [])
        self.assertEqual(tally["mask-header-dimension-exceeds-cap"], 1)

    def test_height_1025_rejected(self) -> None:
        positives, tally = self._scan_with_dims(512, 1025)
        self.assertEqual(positives, [])
        self.assertEqual(tally["mask-header-dimension-exceeds-cap"], 1)

    def test_v4_rejects_smaller_canvas_while_v3_keeps_prior_cap(self) -> None:
        v3_positives, _ = self._scan_with_dims(800, 600)
        v4_positives, v4_tally = self._scan_with_dims(
            800,
            600,
            require_exact_max_dimension=True,
        )
        self.assertEqual(len(v3_positives), 1)
        self.assertEqual(v4_positives, [])
        self.assertEqual(v4_tally["mask-header-dimension-not-exact-1024"], 1)

    def test_v4_admits_landscape_or_portrait_at_exact_cap(self) -> None:
        for width, height in ((1024, 768), (768, 1024)):
            with self.subTest(width=width, height=height):
                positives, tally = self._scan_with_dims(
                    width,
                    height,
                    require_exact_max_dimension=True,
                )
                self.assertEqual(len(positives), 1)
                self.assertEqual(tally.get("mask-header-dimension-not-exact-1024", 0), 0)


class ExclusionAuditV2Tests(unittest.TestCase):
    def test_v1_audit_still_requires_pinned_sha(self) -> None:
        if not PINNED_AUDIT.is_file():
            self.skipTest("pinned exclusion audit unavailable")
        validation.validate_exclusion_audit(PINNED_AUDIT)

    def test_additive_builder_fixture_union(self) -> None:
        freeze_exclusions = load_module("fresh_dev_freeze_exclusions_v2", "freeze_exclusions_v2.py")
        prior_payload = {
            "schemaVersion": 1,
            "status": validation.EXCLUSION_AUDIT_STATUS,
            "ledgers": [{"path": "/x/a.csv", "sha256": "a" * 64, "imageRows": 1}],
            "imageIds": ["img-prior"],
            "encodedImageSha256": ["1" * 64],
            "sourceGroups": ["https://www.flickr.com/people/prior"],
            "missingSourceMetadataIds": [],
            "sources": [{"path": "/x/a.csv", "sha256": "a" * 64}],
        }
        attempt_doc = {
            "schemaVersion": validation.ATTEMPT_LIST_SCHEMA_V1,
            "selectionSeed": curate.SEED,
            "primaryShortlistSha256": "b" * 64,
            "reserveCommitSha256": "c" * 64,
            "attempts": [
                {
                    "phase": "primary",
                    "expectedPresence": "present",
                    "caseId": f"{index:032x}",
                    "imageId": f"{index:016x}",
                    "targetClassId": "/m/person",
                    "target": "Person",
                    "selectionKey": "d" * 64,
                }
                for index in range(40)
            ],
        }
        primary_rows = []
        reserve_rows = []
        for index, attempt in enumerate(attempt_doc["attempts"]):
            row = {
                "caseId": attempt["caseId"],
                "expectedPresence": "present",
                "imageId": attempt["imageId"],
                "targetClassId": "/m/person",
                "target": "Person",
                "authorProfileUrl": f"https://www.flickr.com/people/author-{index:03d}",
                "targetBoxes": [
                    {
                        "classId": "/m/person",
                        "className": "Person",
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
                ],
                "instanceMaskMetadata": {
                    "boxId": "abcd1234",
                    "maskPath": f"{attempt['imageId']}_mperson_abcd1234.png",
                    "maskCsvRow": 2,
                    "sourceBoxDecimals": {"XMin": "0.1", "YMin": "0.1", "XMax": "0.4", "YMax": "0.4"},
                    "pngHeaderDimensions": {"width": 640, "height": 480},
                },
                "negativeEvidence": None,
                "rightsReviewStatus": "pending",
                "datasetLicenseMetadata": {"note": "n", "licenseUrl": PHOTO_LICENSE},
                "sourceUrls": {
                    "originalUrl": "https://example.invalid/u.jpg",
                    "originalLandingUrl": "https://www.flickr.com/photos/owner/1",
                    "licenseUrl": PHOTO_LICENSE,
                    "author": "Author",
                    "title": "Title",
                },
                "selectionKey": attempt["selectionKey"],
            }
            if index < 20:
                primary_rows.append(row)
            else:
                reserve_rows.append(row)
        report = {
            "records": [
                {
                    "encodedSha256": "2" * 64,
                    "decodedRgbSha256": "3" * 64,
                    "perceptualHash64": "0123456789abcdef",
                }
            ]
        }
        receipts = {
            "attempts": [
                {
                    "rejectionSourceEvidence": {
                        "jpeg": {"storedBytesSha256": "4" * 64},
                    }
                }
            ]
        }
        payload = freeze_exclusions.build_additive_exclusion_audit_v2(
            prior_audit_path=Path("/tmp/prior-audit.json"),
            prior_audit_payload=prior_payload,
            prior_audit_sha256=validation.EXCLUSION_AUDIT_SHA256,
            v1_attempt_path=Path("/tmp/v1-attempts.json"),
            v1_attempt_sha256=validation.V1_ATTEMPT_LIST_SHA256,
            v1_attempt_doc=attempt_doc,
            v2_primary_path=Path("/tmp/v2-primary.json"),
            v2_primary_sha256=validation.CORRECTED_PRIMARY_SHORTLIST_SHA256,
            v2_primary_rows=primary_rows,
            v2_reserve_path=Path("/tmp/v2-reserve.json"),
            v2_reserve_sha256=validation.V2_RESERVE_COMMIT_SHA256,
            v2_reserve_rows=reserve_rows,
            v2_report_path=Path("/tmp/v2-report.json"),
            v2_report_sha256=validation.V2_ACQUISITION_REPORT_SHA256,
            v2_report=report,
            v2_receipts_path=Path("/tmp/v2-receipts.json"),
            v2_receipts_sha256=validation.V2_ACQUISITION_RECEIPTS_SHA256,
            v2_receipts=receipts,
        )
        validation.validate_exclusion_audit_payload_v2(payload)
        self.assertIn("img-prior", payload["imageIds"])
        self.assertEqual(len({row["imageId"] for row in primary_rows + reserve_rows}), 40)
        self.assertIn("2" * 64, payload["encodedImageSha256"])
        self.assertIn("4" * 64, payload["encodedImageSha256"])


class CliSmokeTests(unittest.TestCase):
    def test_module_import_has_no_network_side_effects(self) -> None:
        root = str(ROOT)
        code = (
            "import sys\n"
            f"sys.path.insert(0, {root!r})\n"
            "import validation\n"
            "import curate\n"
        )
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/tmp"),
            "PYTHONNOUSERSITE": "1",
        }
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr or result.stdout)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
