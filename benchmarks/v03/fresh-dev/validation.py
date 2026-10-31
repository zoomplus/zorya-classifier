"""Strict metadata validation helpers for H8a fresh DEV curation (metadata-only)."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import struct
from pathlib import Path
from typing import Any, Iterable

PHOTO_LICENSE = "https://creativecommons.org/licenses/by/2.0/"
EXCLUSION_AUDIT_SHA256 = (
    "3419d4e5f6cbdf391b3a4b01ea0fdbe6451866e62a05f2af7d4260bcf5d60574"
)
EXCLUSION_AUDIT_STATUS = "metadata-only-prior-exclusions"
EXCLUSION_AUDIT_V2_STATUS = "metadata-only-prior-exclusions-v2-additive"
EXCLUSION_AUDIT_V2_SHA256 = "72d3037fd95fbd64d4cece5eb0af5c177974533901d4a77311d96215f1d670ab"
EXCLUSION_AUDIT_V3_STATUS = "metadata-only-prior-exclusions-v3-additive"
V1_ATTEMPT_LIST_SHA256 = (
    "3a972a9964fa2f04ffb167befa0736b91c03607874daa1f66fcf618e6068ba0d"
)
V2_RESERVE_COMMIT_SHA256 = (
    "49a497b30dca3a7c508985006dbd2b5c85fc8f5c63d76a12751a9b2034b12dd2"
)
V2_ACQUISITION_REPORT_SHA256 = (
    "77a456f43f7ecec32826e8ddf77813fb6779299841d042e018909c2fddbedf5f"
)
V2_ACQUISITION_RECEIPTS_SHA256 = (
    "d71a2ba22f9d7453fbbc83039e58b45bb5520fff98ae0ecc4179e7d79e42e3b5"
)
PRIOR_FINGERPRINT_INDEX_SHA256 = (
    "8822ed7d5f7ae5529b8d1aaf66d046648f5a9f268d170990fd904f598cb9da36"
)
PRIOR_FINGERPRINT_INDEX_RECEIPT_SHA256 = (
    "7bf36cbd61eee66c4fc6926d986f73ee52aa1035390727f5149c59cea4996ffa"
)
MASK_HEADER_MAX_DIMENSION = 1024
V1_ATTEMPT_JOIN_COUNT = 40
SHA256_HEX = re.compile(r"^[a-f0-9]{64}$")
CASE_ID_HEX32 = re.compile(r"^[0-9a-f]{32}$")
CASE_ID_UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
MASK_PATH_LABEL_SLUG = re.compile(r"^[A-Za-z0-9_]+$")
EXCLUSION_AUDIT_TOP_LEVEL_KEYS = frozenset(
    {
        "schemaVersion",
        "status",
        "ledgers",
        "imageIds",
        "encodedImageSha256",
        "sourceGroups",
        "missingSourceMetadataIds",
        "sources",
    }
)
EXCLUSION_AUDIT_V2_ADDITIVE_TOP_LEVEL_KEYS = EXCLUSION_AUDIT_TOP_LEVEL_KEYS | {
    "priorAuditSha256",
    "v1AttemptListSha256",
    "v2PrimaryShortlistSha256",
    "v2ReserveCommitSha256",
    "v2AcquisitionReportSha256",
    "v2AcquisitionPrivateReceiptsSha256",
    "parentInputs",
}
EXCLUSION_AUDIT_V3_ADDITIVE_TOP_LEVEL_KEYS = EXCLUSION_AUDIT_TOP_LEVEL_KEYS | {
    "priorAuditV2Sha256",
    "v3AttemptListSha256",
    "v3PrimaryShortlistSha256",
    "v3ReserveCommitSha256",
    "v3AcquisitionReportSha256",
    "v3AcquisitionPrivateReceiptsSha256",
    "v3AcquisitionEncodedImageSha256",
    "parentInputs",
}
PARENT_INPUT_RECORD_KEYS = frozenset({"label", "path", "sha256"})
LEDGER_RECORD_KEYS = frozenset({"path", "sha256", "imageRows"})
SOURCE_RECORD_KEYS = frozenset({"path", "sha256"})
NEGATIVE_EVIDENCE_SOURCE = "verification"
NEGATIVE_EVIDENCE_SOURCE_FILE = "labels.csv"

MASK_HEADER_INDEX_SCHEMA_VERSION = 1
MASK_HEADER_INDEX_SOURCE = (
    "Open Images V5 validation mask archives; only PNG signature/IHDR dimensions read"
)

MAX_SINGLE_CSV_BYTES = 28 * 1024 * 1024
MAX_TOTAL_SOURCE_CSV_BYTES = 110 * 1024 * 1024
MAX_MASK_HEADER_INDEX_BYTES = 8 * 1024 * 1024
MAX_CSV_FIELD_CHARS = 16 * 384
MAX_CLASSES_ROWS = 10_000
MAX_IMAGES_ROWS = 50_000
MAX_BOXES_ROWS = 350_000
MAX_LABELS_ROWS = 300_000
MAX_MASK_CSV_ROWS = 50_000
MAX_EXCLUSION_AUDIT_BYTES = 32 * 1024 * 1024

FORBIDDEN_PRODUCER_KEY_FRAGMENTS = (
    "imageId",
    "ImageID",
    "targetClassId",
    "authorGroup",
    "AuthorProfileURL",
    "negativeEvidence",
    "targetBoxes",
    "expectedPresence",
    "truth",
    "oracle",
    "license",
    "source",
    "sourceGroup",
    "groundTruth",
    "OriginalURL",
    "OriginalLandingURL",
)

PRODUCER_TOP_LEVEL_KEYS = frozenset({"caseId", "target", "task", "image", "locate", "classify"})
PRODUCER_IMAGE_KEYS = frozenset({"path", "sha256", "width", "height"})
PRODUCER_LOCATE_KEYS = frozenset({"target"})
PRODUCER_CLASSIFY_KEYS = frozenset({"task"})

PRIVATE_MANIFEST_SCHEMA_V2 = "h8a-fresh-dev-photo-plan-v2"
PRIVATE_MANIFEST_SCHEMA_V3 = "h8a-fresh-dev-photo-plan-v3"
PRIVATE_MANIFEST_SCHEMA_V4 = "h8a-fresh-dev-photo-plan-v4"
METADATA_PROFILE_V3 = "h8a-fresh-dev-metadata-v3"
METADATA_PROFILE_V4 = "h8a-fresh-dev-metadata-v4-exact1024"
RESERVE_MANIFEST_SCHEMA_V1 = "h8a-fresh-dev-photo-reserve-commit-v1"
RESERVE_MANIFEST_SCHEMA_V2 = "h8a-fresh-dev-photo-reserve-commit-v2"
RESERVE_MANIFEST_SCHEMA_V3 = "h8a-fresh-dev-photo-reserve-commit-v3"
ATTEMPT_LIST_SCHEMA_V1 = "h8a-fresh-dev-photo-acquisition-attempt-list-v1"
ATTEMPT_LIST_SCHEMA_V2 = "h8a-fresh-dev-photo-acquisition-attempt-list-v2"
ATTEMPT_LIST_SCHEMA_V3 = "h8a-fresh-dev-photo-acquisition-attempt-list-v3"
DUPLICATE_POLICY_SCHEMA_V1 = "h8a-fresh-dev-photo-duplicate-policy-v1"
DUPLICATE_POLICY_SCHEMA_V2 = "h8a-fresh-dev-photo-duplicate-policy-v2"
DUPLICATE_POLICY_SCHEMA_V3 = "h8a-fresh-dev-photo-duplicate-policy-v3"
FINGERPRINT_INDEX_SCHEMA_V1 = "h8a-fresh-dev-prior-fingerprint-index-v1"
FINGERPRINT_INDEX_SCHEMA_V2 = "h8a-fresh-dev-prior-fingerprint-index-v2"
FINGERPRINT_INDEX_SCHEMA_V3 = "h8a-fresh-dev-prior-fingerprint-index-v3"
CORRECTED_PRIMARY_SHORTLIST_SHA256 = (
    "e30a8b03d7d0aa2268babf53419a13d475b7bdda475df8e914bac469fde3b299"
)
MAX_FINGERPRINT_INDEX_BYTES = 32 * 1024 * 1024
MAX_ATTEMPT_LIST_BYTES = 4 * 1024 * 1024
MAX_PRIVATE_MANIFEST_BYTES = 8 * 1024 * 1024
PHASH64_HEX = re.compile(r"^[0-9a-f]{16}$")
MAX_DUPLICATE_POLICY_BYTES = 512 * 1024
PHASH_HAMMING_REJECT_AT_MOST = 4
PERCEPTUAL_HASH_ALGORITHM_ID = (
    "h8a-fresh-dev-perceptual-hash-v1-exif-transpose-rgb-bicubic32-dct2-median63"
)
PERCEPTUAL_HASH_RESAMPLER = "Pillow.Image.Resampling.BICUBIC"
MAX_ACQUISITION_CANDIDATES = 40


class InfrastructureFailure(Exception):
    def __init__(self, reason_code: str, *, http_status: int | None = None) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.http_status = http_status


def runtime_pillow_version() -> str:
    try:
        from PIL import __version__ as pillow_version
    except ImportError as error:
        raise CurateError("Pillow is required for fingerprint validation") from error
    return pillow_version


class CurateError(Exception):
    """Metadata curation or validation failure."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def repo_root_from_here(here: Path) -> Path:
    return here.resolve().parents[3]


def path_is_inside_repo(path: Path, repo_root: Path) -> bool:
    try:
        path.resolve().relative_to(repo_root.resolve())
        return True
    except ValueError:
        return False


def require_external_new_directory(path: Path, repo_root: Path, label: str) -> Path:
    if path.is_symlink():
        raise CurateError(f"{label} must not be a symlink: {path}")
    resolved = path.resolve()
    if path_is_inside_repo(resolved, repo_root):
        raise CurateError(f"{label} must resolve outside repository: {resolved}")
    if resolved.exists():
        raise CurateError(f"{label} must not exist yet: {resolved}")
    return resolved


def resolve_bounded_file(base_dir: Path, relative_name: str, label: str) -> Path:
    if not relative_name or relative_name != Path(relative_name).name:
        raise CurateError(f"{label} must be a plain filename without traversal")
    base_real = base_dir.resolve()
    candidate = (base_dir / relative_name).resolve()
    try:
        candidate.relative_to(base_real)
    except ValueError as error:
        raise CurateError(f"{label} escapes source directory") from error
    if candidate != base_real / relative_name:
        raise CurateError(f"{label} resolves outside source directory")
    return candidate


def resolve_existing_input(path: Path, repo_root: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise CurateError(f"{label} is not a file: {resolved}")
    if path_is_inside_repo(resolved, repo_root):
        pass
    return resolved


def read_bounded_file_bytes(path: Path, *, max_bytes: int, label: str) -> tuple[bytes, str]:
    if path.is_symlink():
        raise CurateError(f"{label} must not be a symlink: {path}")
    size = path.stat().st_size
    if size > max_bytes:
        raise CurateError(f"{label} exceeds byte cap ({size} > {max_bytes})")
    raw = path.read_bytes()
    if len(raw) != size:
        raise CurateError(f"{label} size changed during read")
    if len(raw) > max_bytes:
        raise CurateError(f"{label} exceeds byte cap after read")
    return raw, sha256_bytes(raw)


def validate_csv_header_row(headers: tuple[str, ...] | list[str], required: tuple[str, ...], label: str) -> None:
    if len(headers) != len(required):
        raise CurateError(f"{label} header mismatch: expected {required}, got {tuple(headers)}")
    if tuple(headers) != required:
        raise CurateError(f"{label} header mismatch: expected {required}, got {tuple(headers)}")
    if len(set(headers)) != len(headers):
        raise CurateError(f"{label} contains duplicate header names")


def require_csv_field(value: str | None, label: str) -> str:
    if value is None:
        raise CurateError(f"{label} is missing")
    if not isinstance(value, str):
        raise CurateError(f"{label} must be a string")
    if len(value) > MAX_CSV_FIELD_CHARS:
        raise CurateError(f"{label} exceeds field length cap")
    return value


def parse_strict_bool01(value: str, label: str) -> int:
    text = require_csv_field(value, label)
    if text == "0":
        return 0
    if text == "1":
        return 1
    raise CurateError(f"{label} must be 0 or 1")


def parse_strict_decimal(value: str, label: str) -> str:
    text = require_csv_field(value, label)
    if not text:
        raise CurateError(f"{label} must be nonempty")
    try:
        parsed = float(text)
    except ValueError as error:
        raise CurateError(f"{label} must be a finite number") from error
    if not math.isfinite(parsed):
        raise CurateError(f"{label} must be a finite number")
    return text


def parse_strict_csv_from_bytes(
    raw: bytes,
    required_headers: tuple[str, ...],
    label: str,
    *,
    max_rows: int,
) -> tuple[list[dict[str, str]], str]:
    if len(raw) > MAX_SINGLE_CSV_BYTES:
        raise CurateError(f"{label} exceeds single-file byte cap")
    digest = sha256_bytes(raw)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CurateError(f"{label} is not valid UTF-8") from error
    if len(text.encode("utf-8")) > MAX_SINGLE_CSV_BYTES:
        raise CurateError(f"{label} exceeds single-file byte cap")
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if reader.fieldnames is None:
        raise CurateError(f"{label} is missing a header row")
    headers = tuple(reader.fieldnames)
    validate_csv_header_row(headers, required_headers, label)
    rows: list[dict[str, str]] = []
    for index, row in enumerate(reader, start=2):
        if index - 1 > max_rows:
            raise CurateError(f"{label} exceeds row cap ({max_rows})")
        if None in row:
            raise CurateError(f"{label} row {index} has extra columns")
        values = {key: require_csv_field(row.get(key), f"{label} row {index} column {key}") for key in headers}
        if len(values) != len(headers):
            raise CurateError(f"{label} row {index} has wrong column count")
        rows.append(values)
    return rows, digest


def read_strict_csv(path: Path, required_headers: tuple[str, ...], label: str, *, max_rows: int) -> tuple[list[dict[str, str]], str]:
    raw, _size_digest = read_bounded_file_bytes(path, max_bytes=MAX_SINGLE_CSV_BYTES, label=label)
    return parse_strict_csv_from_bytes(raw, required_headers, label, max_rows=max_rows)


def require_audit_source_hash(
    exclusion_payload: dict[str, Any],
    *,
    basename: str,
    digest: str,
    source_dir: Path,
) -> None:
    sources = exclusion_payload.get("sources")
    if not isinstance(sources, list):
        return
    loaded_path = (source_dir / basename).resolve()
    for index, source in enumerate(sources):
        item = require_json_object(source, f"exclusion audit.sources[{index}]")
        path_text = require_string(item.get("path"), f"exclusion audit.sources[{index}].path")
        if Path(path_text).name != basename:
            continue
        if Path(path_text).resolve() != loaded_path:
            continue
        expected = require_sha256_hex(item.get("sha256"), f"exclusion audit.sources[{index}].sha256")
        if expected != digest:
            raise CurateError(
                f"{basename} SHA-256 mismatch against exclusion audit: expected {expected}, got {digest}"
            )
        return


def validate_mask_path_key(mask_path: str, label: str) -> str:
    text = require_string(mask_path, label)
    if not text or text != text.strip():
        raise CurateError(f"{label} must be a safe basename")
    if "/" in text or "\\" in text or ".." in text:
        raise CurateError(f"{label} must be a safe basename")
    if Path(text).name != text:
        raise CurateError(f"{label} must be a safe basename")
    return text


def require_mask_path_token(value: str, label: str) -> str:
    text = require_string(value, label)
    if not text or text != text.strip():
        raise CurateError(f"{label} must be a nonempty mask-path token")
    if "/" in text or "\\" in text or ".." in text or "_" in text:
        raise CurateError(f"{label} must be a safe mask-path token")
    return text


def require_mask_path_label_slug(label_slug: str, label: str) -> str:
    text = require_string(label_slug, label)
    if not text or text != text.strip():
        raise CurateError(f"{label} must be a nonempty Open Images V5 mask-path label slug")
    if "/" in text or "\\" in text or ".." in text:
        raise CurateError(f"{label} must be a safe Open Images V5 mask-path label slug")
    if not MASK_PATH_LABEL_SLUG.fullmatch(text):
        raise CurateError(f"{label} must be a safe Open Images V5 mask-path label slug")
    return text


def expected_open_images_v5_mask_path(image_id: str, label_name: str, box_id: str) -> str:
    validated_image_id = require_mask_path_token(image_id, "ImageID")
    validated_box_id = require_mask_path_token(box_id, "BoxID")
    label_text = require_string(label_name, "LabelName")
    label_slug = require_mask_path_label_slug(label_text.replace("/", ""), "LabelName mask-path slug")
    return f"{validated_image_id}_{label_slug}_{validated_box_id}.png"


def open_images_v5_mask_path_matches_row(
    mask_path: str,
    *,
    image_id: str,
    label_name: str,
    box_id: str,
    label: str,
) -> None:
    safe_path = validate_mask_path_key(mask_path, label)
    if not safe_path.endswith(".png"):
        raise CurateError(f"{label} must end with .png")
    stem = safe_path[: -len(".png")]
    parts = stem.split("_")
    if len(parts) < 3:
        raise CurateError(f"{label} must match <ImageID>_<LabelSlug>_<BoxID>.png")
    path_box_id = parts[-1]
    path_image_id = parts[0]
    path_label_slug = "_".join(parts[1:-1])
    if path_image_id != image_id or path_box_id != box_id:
        raise CurateError(f"{label} filename tokens disagree with row metadata")
    expected_slug = require_string(label_name, f"{label} LabelName").replace("/", "")
    if path_label_slug != expected_slug:
        raise CurateError(f"{label} filename label slug disagrees with row LabelName")
    expected = expected_open_images_v5_mask_path(image_id, label_name, box_id)
    if safe_path != expected:
        raise CurateError(f"{label} must be exactly {expected!r}")


def load_mask_header_index_from_bytes(raw: bytes, *, mask_csv_sha256: str) -> tuple[dict[str, dict[str, int]], str]:
    if len(raw) > MAX_MASK_HEADER_INDEX_BYTES:
        raise CurateError("mask header index exceeds byte cap")
    digest = sha256_bytes(raw)
    payload = require_json_object(
        loads_strict_json(raw.decode("utf-8"), label="mask header index"),
        "mask header index",
    )
    extra = set(payload) - {"schemaVersion", "source", "maskCsvSha256", "entries"}
    if extra:
        raise CurateError(f"mask header index has unexpected keys: {sorted(extra)}")
    if require_int_not_bool(payload.get("schemaVersion"), "mask header index.schemaVersion") != MASK_HEADER_INDEX_SCHEMA_VERSION:
        raise CurateError("mask header index.schemaVersion must be 1")
    if require_string(payload.get("source"), "mask header index.source") != MASK_HEADER_INDEX_SOURCE:
        raise CurateError("mask header index.source mismatch")
    pinned_csv = require_sha256_hex(payload.get("maskCsvSha256"), "mask header index.maskCsvSha256")
    if pinned_csv != mask_csv_sha256:
        raise CurateError("mask header index.maskCsvSha256 does not match mask CSV bytes")
    entries_raw = payload.get("entries")
    if not isinstance(entries_raw, dict):
        raise CurateError("mask header index.entries must be an object")
    entries: dict[str, dict[str, int]] = {}
    for key, value in entries_raw.items():
        mask_path = validate_mask_path_key(key, "mask header index.entries key")
        if mask_path in entries:
            raise CurateError(f"mask header index.entries contains duplicate MaskPath: {mask_path}")
        item = require_json_object(value, f"mask header index.entries[{mask_path}]")
        extra_entry = set(item) - {"width", "height"}
        if extra_entry:
            raise CurateError(f"mask header index.entries[{mask_path}] has unexpected keys: {sorted(extra_entry)}")
        width = require_int_not_bool(item.get("width"), f"mask header index.entries[{mask_path}].width")
        height = require_int_not_bool(item.get("height"), f"mask header index.entries[{mask_path}].height")
        if width <= 0 or height <= 0:
            raise CurateError(f"mask header index.entries[{mask_path}] dimensions must be positive")
        entries[mask_path] = {"width": width, "height": height}
    return entries, digest


def loads_strict_json(text: str, *, label: str = "JSON") -> Any:
    def reject_non_finite(value: str) -> float:
        parsed = float(value)
        if not math.isfinite(parsed):
            raise CurateError(f"{label} contains non-finite number")
        return parsed

    def object_pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        keys = [key for key, _ in pairs]
        if len(keys) != len(set(keys)):
            raise CurateError(f"{label} contains duplicate object keys")
        return dict(pairs)

    def reject_constants(value: str) -> None:
        raise CurateError(f"{label} contains non-finite constant {value!r}")

    try:
        return json.loads(
            text,
            object_pairs_hook=object_pairs_hook,
            parse_float=reject_non_finite,
            parse_constant=reject_constants,
        )
    except json.JSONDecodeError as error:
        raise CurateError(f"{label} is not valid JSON: {error}") from error


def require_json_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CurateError(f"{label} must be a JSON object")
    return value


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise CurateError(f"{label} must be a string")
    return value


def require_int_not_bool(value: Any, label: str) -> int:
    if type(value) is not int or isinstance(value, bool):
        raise CurateError(f"{label} must be an integer")
    return value


def require_finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CurateError(f"{label} must be a finite number")
    parsed = float(value)
    if not math.isfinite(parsed):
        raise CurateError(f"{label} must be a finite number")
    return parsed


def require_opaque_case_id(value: Any, label: str) -> str:
    case_id = require_string(value, label)
    if case_id != case_id.strip():
        raise CurateError(f"{label} must be an opaque token without path separators")
    if "/" in case_id or "\\" in case_id or ".." in case_id:
        raise CurateError(f"{label} must be an opaque token without path separators")
    lowered = case_id.lower()
    if "pos" in lowered or "neg" in lowered:
        raise CurateError(f"{label} must not encode expected presence")
    if not (CASE_ID_HEX32.fullmatch(case_id) or CASE_ID_UUID_V4.fullmatch(case_id)):
        raise CurateError(f"{label} must be 32 lowercase hex chars or a lowercase UUIDv4")
    return case_id


def validate_negative_evidence(value: Any, *, label: str = "negativeEvidence") -> dict[str, Any]:
    evidence = require_json_object(value, label)
    if require_string(evidence.get("type"), f"{label}.type") != "explicit-human-verified-image-label":
        raise CurateError(f"{label}.type must be explicit-human-verified-image-label")
    if require_string(evidence.get("source"), f"{label}.source") != NEGATIVE_EVIDENCE_SOURCE:
        raise CurateError(f"{label}.source must be {NEGATIVE_EVIDENCE_SOURCE!r}")
    confidence = require_int_not_bool(evidence.get("confidence"), f"{label}.confidence")
    if confidence != 0:
        raise CurateError(f"{label}.confidence must be 0")
    source_csv_row = require_int_not_bool(evidence.get("sourceCsvRow"), f"{label}.sourceCsvRow")
    if source_csv_row <= 0:
        raise CurateError(f"{label}.sourceCsvRow must be a positive integer")
    if require_string(evidence.get("sourceFile"), f"{label}.sourceFile") != NEGATIVE_EVIDENCE_SOURCE_FILE:
        raise CurateError(f"{label}.sourceFile must be {NEGATIVE_EVIDENCE_SOURCE_FILE!r}")
    extra = set(evidence) - {"type", "source", "confidence", "sourceCsvRow", "sourceFile"}
    if extra:
        raise CurateError(f"{label} has unexpected keys: {sorted(extra)}")
    return evidence


def validate_instance_mask_metadata(value: Any, *, label: str = "instanceMaskMetadata") -> dict[str, Any]:
    item = require_json_object(value, label)
    required = {"boxId", "maskPath", "maskCsvRow", "sourceBoxDecimals", "pngHeaderDimensions"}
    missing = required - set(item)
    if missing:
        raise CurateError(f"{label} missing fields: {sorted(missing)}")
    box_id = require_string(item.get("boxId"), f"{label}.boxId")
    if not box_id:
        raise CurateError(f"{label}.boxId must be nonempty")
    mask_path = validate_mask_path_key(item.get("maskPath"), f"{label}.maskPath")
    mask_csv_row = require_int_not_bool(item.get("maskCsvRow"), f"{label}.maskCsvRow")
    if mask_csv_row <= 0:
        raise CurateError(f"{label}.maskCsvRow must be positive")
    decimals = require_json_object(item.get("sourceBoxDecimals"), f"{label}.sourceBoxDecimals")
    for field in ("XMin", "YMin", "XMax", "YMax"):
        parse_strict_decimal(require_string(decimals.get(field), f"{label}.sourceBoxDecimals.{field}"), f"{label}.sourceBoxDecimals.{field}")
    dims = require_json_object(item.get("pngHeaderDimensions"), f"{label}.pngHeaderDimensions")
    width = require_int_not_bool(dims.get("width"), f"{label}.pngHeaderDimensions.width")
    height = require_int_not_bool(dims.get("height"), f"{label}.pngHeaderDimensions.height")
    if width <= 0 or height <= 0:
        raise CurateError(f"{label}.pngHeaderDimensions must be positive")
    extra = set(item) - required
    if extra:
        raise CurateError(f"{label} has unexpected keys: {sorted(extra)}")
    return {
        "boxId": box_id,
        "maskPath": mask_path,
        "maskCsvRow": mask_csv_row,
        "sourceBoxDecimals": {key: decimals[key] for key in ("XMin", "YMin", "XMax", "YMax")},
        "pngHeaderDimensions": {"width": width, "height": height},
    }


def require_sha256_hex(value: Any, label: str) -> str:
    text = require_string(value, label)
    if not SHA256_HEX.fullmatch(text):
        raise CurateError(f"{label} must be a lowercase SHA-256 hex digest")
    return text


def normalize_source_group(url: str) -> str:
    return url.rstrip("/")


def validate_normalized_box(xyxy: Any, *, label: str = "box") -> list[float]:
    if not isinstance(xyxy, (list, tuple)):
        raise CurateError(f"{label} must contain four finite coordinates")
    if len(xyxy) != 4:
        raise CurateError(f"{label} must contain four finite coordinates")
    values = [require_finite_number(v, f"{label}[{index}]") for index, v in enumerate(xyxy)]
    x_min, y_min, x_max, y_max = values
    if not (0.0 <= x_min < x_max <= 1.0 and 0.0 <= y_min < y_max <= 1.0):
        raise CurateError(f"{label} coordinates are out of image bounds or degenerate")
    return values


def _validate_exclusion_audit_collection_fields(payload: dict[str, Any]) -> None:
    image_ids = payload.get("imageIds")
    image_hashes = payload.get("encodedImageSha256")
    source_groups = payload.get("sourceGroups")
    for field_name, value in (
        ("imageIds", image_ids),
        ("encodedImageSha256", image_hashes),
    ):
        if not isinstance(value, list):
            raise CurateError(f"exclusion audit.{field_name} must be an array")
        seen: set[str] = set()
        for index, item in enumerate(value):
            text = require_string(item, f"exclusion audit.{field_name}[{index}]")
            if field_name == "encodedImageSha256":
                require_sha256_hex(text, f"exclusion audit.{field_name}[{index}]")
            if text in seen:
                raise CurateError(f"exclusion audit.{field_name} contains duplicate entries")
            seen.add(text)
    if not isinstance(source_groups, list):
        raise CurateError("exclusion audit.sourceGroups must be an array")
    seen_groups: set[str] = set()
    for index, item in enumerate(source_groups):
        text = require_string(item, f"exclusion audit.sourceGroups[{index}]")
        normalized = normalize_source_group(text)
        if normalized in seen_groups:
            raise CurateError("exclusion audit.sourceGroups contains duplicate entries after normalization")
        seen_groups.add(normalized)
    missing = payload.get("missingSourceMetadataIds")
    if not isinstance(missing, list):
        raise CurateError("exclusion audit.missingSourceMetadataIds must be an array")
    for index, item in enumerate(missing):
        require_string(item, f"exclusion audit.missingSourceMetadataIds[{index}]")
    sources = payload.get("sources")
    if not isinstance(sources, list) or not sources:
        raise CurateError("exclusion audit.sources must be a nonempty array")
    for index, source in enumerate(sources):
        item = require_json_object(source, f"exclusion audit.sources[{index}]")
        source_extra = set(item) - SOURCE_RECORD_KEYS
        if source_extra:
            raise CurateError(f"exclusion audit.sources[{index}] has unexpected keys: {sorted(source_extra)}")
        require_string(item.get("path"), f"exclusion audit.sources[{index}].path")
        require_sha256_hex(item.get("sha256"), f"exclusion audit.sources[{index}].sha256")


def exclusion_audit_view(payload: dict[str, Any], digest: str) -> dict[str, Any]:
    ledgers = payload["ledgers"]
    image_ids = payload["imageIds"]
    image_hashes = payload["encodedImageSha256"]
    source_groups = payload["sourceGroups"]
    return {
        "payload": payload,
        "auditSha256": digest,
        "counts": {
            "imageIds": len(image_ids),
            "encodedImageSha256": len(image_hashes),
            "sourceGroups": len(source_groups),
            "ledgers": len(ledgers),
        },
        "excludedImageIds": set(require_string(v, "imageId") for v in image_ids),
        "excludedImageSha256": set(require_sha256_hex(v, "encodedImageSha256") for v in image_hashes),
        "excludedSourceGroups": set(normalize_source_group(require_string(v, "sourceGroup")) for v in source_groups),
    }


def validate_exclusion_audit_payload(payload: dict[str, Any]) -> None:
    extra_top = set(payload) - EXCLUSION_AUDIT_TOP_LEVEL_KEYS
    if extra_top:
        raise CurateError(f"exclusion audit has unexpected top-level keys: {sorted(extra_top)}")
    if require_int_not_bool(payload.get("schemaVersion"), "exclusion audit.schemaVersion") != 1:
        raise CurateError("exclusion audit.schemaVersion must be 1")
    if require_string(payload.get("status"), "exclusion audit.status") != EXCLUSION_AUDIT_STATUS:
        raise CurateError("exclusion audit.status mismatch")
    ledgers = payload.get("ledgers")
    if not isinstance(ledgers, list) or not ledgers:
        raise CurateError("exclusion audit.ledgers must be a nonempty array")
    for index, ledger in enumerate(ledgers):
        item = require_json_object(ledger, f"exclusion audit.ledgers[{index}]")
        ledger_extra = set(item) - LEDGER_RECORD_KEYS
        if ledger_extra:
            raise CurateError(f"exclusion audit.ledgers[{index}] has unexpected keys: {sorted(ledger_extra)}")
        require_string(item.get("path"), f"exclusion audit.ledgers[{index}].path")
        require_sha256_hex(item.get("sha256"), f"exclusion audit.ledgers[{index}].sha256")
        require_int_not_bool(item.get("imageRows"), f"exclusion audit.ledgers[{index}].imageRows")
    _validate_exclusion_audit_collection_fields(payload)


def validate_exclusion_audit_payload_v2(payload: dict[str, Any]) -> None:
    extra_top = set(payload) - EXCLUSION_AUDIT_V2_ADDITIVE_TOP_LEVEL_KEYS
    if extra_top:
        raise CurateError(f"exclusion audit has unexpected top-level keys: {sorted(extra_top)}")
    if require_int_not_bool(payload.get("schemaVersion"), "exclusion audit.schemaVersion") != 2:
        raise CurateError("exclusion audit.schemaVersion must be 2")
    if require_string(payload.get("status"), "exclusion audit.status") != EXCLUSION_AUDIT_V2_STATUS:
        raise CurateError("exclusion audit.status mismatch")
    pinned_prior = require_sha256_hex(payload.get("priorAuditSha256"), "exclusion audit.priorAuditSha256")
    if pinned_prior != EXCLUSION_AUDIT_SHA256:
        raise CurateError("exclusion audit.priorAuditSha256 mismatch")
    require_sha256_hex(payload.get("v1AttemptListSha256"), "exclusion audit.v1AttemptListSha256")
    require_sha256_hex(payload.get("v2PrimaryShortlistSha256"), "exclusion audit.v2PrimaryShortlistSha256")
    require_sha256_hex(payload.get("v2ReserveCommitSha256"), "exclusion audit.v2ReserveCommitSha256")
    require_sha256_hex(payload.get("v2AcquisitionReportSha256"), "exclusion audit.v2AcquisitionReportSha256")
    require_sha256_hex(payload.get("v2AcquisitionPrivateReceiptsSha256"), "exclusion audit.v2AcquisitionPrivateReceiptsSha256")
    parent_inputs = payload.get("parentInputs")
    if not isinstance(parent_inputs, list) or not parent_inputs:
        raise CurateError("exclusion audit.parentInputs must be a nonempty array")
    seen_labels: set[str] = set()
    for index, source in enumerate(parent_inputs):
        item = require_json_object(source, f"exclusion audit.parentInputs[{index}]")
        record_extra = set(item) - PARENT_INPUT_RECORD_KEYS
        if record_extra:
            raise CurateError(f"exclusion audit.parentInputs[{index}] has unexpected keys: {sorted(record_extra)}")
        label = require_string(item.get("label"), f"exclusion audit.parentInputs[{index}].label")
        if label in seen_labels:
            raise CurateError("exclusion audit.parentInputs contains duplicate labels")
        seen_labels.add(label)
        require_string(item.get("path"), f"exclusion audit.parentInputs[{index}].path")
        require_sha256_hex(item.get("sha256"), f"exclusion audit.parentInputs[{index}].sha256")
    ledgers = payload.get("ledgers")
    if not isinstance(ledgers, list) or not ledgers:
        raise CurateError("exclusion audit.ledgers must be a nonempty array")
    for index, ledger in enumerate(ledgers):
        item = require_json_object(ledger, f"exclusion audit.ledgers[{index}]")
        ledger_extra = set(item) - LEDGER_RECORD_KEYS
        if ledger_extra:
            raise CurateError(f"exclusion audit.ledgers[{index}] has unexpected keys: {sorted(ledger_extra)}")
        require_string(item.get("path"), f"exclusion audit.ledgers[{index}].path")
        require_sha256_hex(item.get("sha256"), f"exclusion audit.ledgers[{index}].sha256")
        require_int_not_bool(item.get("imageRows"), f"exclusion audit.ledgers[{index}].imageRows")
    _validate_exclusion_audit_collection_fields(payload)


def validate_exclusion_audit_payload_v3(payload: dict[str, Any]) -> None:
    extra_top = set(payload) - EXCLUSION_AUDIT_V3_ADDITIVE_TOP_LEVEL_KEYS
    if extra_top:
        raise CurateError(f"exclusion audit has unexpected top-level keys: {sorted(extra_top)}")
    if require_int_not_bool(payload.get("schemaVersion"), "exclusion audit.schemaVersion") != 3:
        raise CurateError("exclusion audit.schemaVersion must be 3")
    if require_string(payload.get("status"), "exclusion audit.status") != EXCLUSION_AUDIT_V3_STATUS:
        raise CurateError("exclusion audit.status mismatch")
    prior_sha = require_sha256_hex(payload.get("priorAuditV2Sha256"), "exclusion audit.priorAuditV2Sha256")
    if prior_sha != EXCLUSION_AUDIT_V2_SHA256:
        raise CurateError("exclusion audit.priorAuditV2Sha256 mismatch")
    for field in (
        "v3AttemptListSha256",
        "v3PrimaryShortlistSha256",
        "v3ReserveCommitSha256",
        "v3AcquisitionReportSha256",
        "v3AcquisitionPrivateReceiptsSha256",
    ):
        require_sha256_hex(payload.get(field), f"exclusion audit.{field}")
    retained = payload.get("v3AcquisitionEncodedImageSha256")
    if not isinstance(retained, list):
        raise CurateError("exclusion audit.v3AcquisitionEncodedImageSha256 must be an array")
    retained_set: set[str] = set()
    for index, item in enumerate(retained):
        digest = require_sha256_hex(item, f"exclusion audit.v3AcquisitionEncodedImageSha256[{index}]")
        if digest in retained_set:
            raise CurateError("exclusion audit.v3AcquisitionEncodedImageSha256 contains duplicates")
        retained_set.add(digest)
    all_encoded_raw = payload.get("encodedImageSha256")
    if not isinstance(all_encoded_raw, list):
        raise CurateError("exclusion audit.encodedImageSha256 must be an array")
    all_encoded = {
        require_sha256_hex(value, "exclusion audit.encodedImageSha256") for value in all_encoded_raw
    }
    if not retained_set or not retained_set.issubset(all_encoded):
        raise CurateError("exclusion audit retained v3 image hashes must be included in encodedImageSha256")
    parent_inputs = payload.get("parentInputs")
    if not isinstance(parent_inputs, list) or not parent_inputs:
        raise CurateError("exclusion audit.parentInputs must be a nonempty array")
    seen_labels: set[str] = set()
    for index, source in enumerate(parent_inputs):
        item = require_json_object(source, f"exclusion audit.parentInputs[{index}]")
        record_extra = set(item) - PARENT_INPUT_RECORD_KEYS
        if record_extra:
            raise CurateError(f"exclusion audit.parentInputs[{index}] has unexpected keys: {sorted(record_extra)}")
        label = require_string(item.get("label"), f"exclusion audit.parentInputs[{index}].label")
        if label in seen_labels:
            raise CurateError("exclusion audit.parentInputs contains duplicate labels")
        seen_labels.add(label)
        require_string(item.get("path"), f"exclusion audit.parentInputs[{index}].path")
        require_sha256_hex(item.get("sha256"), f"exclusion audit.parentInputs[{index}].sha256")
    ledgers = payload.get("ledgers")
    if not isinstance(ledgers, list) or not ledgers:
        raise CurateError("exclusion audit.ledgers must be a nonempty array")
    for index, ledger in enumerate(ledgers):
        item = require_json_object(ledger, f"exclusion audit.ledgers[{index}]")
        if set(item) - LEDGER_RECORD_KEYS:
            raise CurateError(f"exclusion audit.ledgers[{index}] has unexpected keys")
        require_string(item.get("path"), f"exclusion audit.ledgers[{index}].path")
        require_sha256_hex(item.get("sha256"), f"exclusion audit.ledgers[{index}].sha256")
        require_int_not_bool(item.get("imageRows"), f"exclusion audit.ledgers[{index}].imageRows")
    _validate_exclusion_audit_collection_fields(payload)


def validate_exclusion_audit(path: Path) -> dict[str, Any]:
    raw, digest = read_bounded_file_bytes(
        path,
        max_bytes=MAX_EXCLUSION_AUDIT_BYTES,
        label="exclusion audit",
    )
    if digest != EXCLUSION_AUDIT_SHA256:
        raise CurateError(
            f"exclusion audit SHA-256 mismatch: expected {EXCLUSION_AUDIT_SHA256}, got {digest}"
        )
    payload = require_json_object(loads_strict_json(raw.decode("utf-8"), label="exclusion audit"), "exclusion audit")
    validate_exclusion_audit_payload(payload)
    return exclusion_audit_view(payload, digest)


def validate_additive_exclusion_audit_v2(path: Path, *, expected_sha256: str) -> dict[str, Any]:
    raw, digest = read_bounded_file_bytes(
        path,
        max_bytes=MAX_EXCLUSION_AUDIT_BYTES,
        label="exclusion audit",
    )
    if digest != expected_sha256:
        raise CurateError(
            f"exclusion audit SHA-256 mismatch: expected {expected_sha256}, got {digest}"
        )
    payload = require_json_object(loads_strict_json(raw.decode("utf-8"), label="exclusion audit"), "exclusion audit")
    validate_exclusion_audit_payload_v2(payload)
    return exclusion_audit_view(payload, digest)


def validate_additive_exclusion_audit_v3(path: Path, *, expected_sha256: str) -> dict[str, Any]:
    raw, digest = read_bounded_file_bytes(
        path,
        max_bytes=MAX_EXCLUSION_AUDIT_BYTES,
        label="exclusion audit",
    )
    if digest != expected_sha256:
        raise CurateError(f"exclusion audit SHA-256 mismatch: expected {expected_sha256}, got {digest}")
    payload = require_json_object(
        loads_strict_json(raw.decode("utf-8"), label="exclusion audit"),
        "exclusion audit",
    )
    validate_exclusion_audit_payload_v3(payload)
    return exclusion_audit_view(payload, digest)


def producer_record_has_forbidden_leak(value: Any, *, path: str = "") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = require_string(key, "producer key")
            joined = f"{path}.{key_text}" if path else key_text
            if key_text in FORBIDDEN_PRODUCER_KEY_FRAGMENTS or any(
                fragment.lower() in key_text.lower() for fragment in ("truth", "oracle", "license", "imageid")
            ):
                return joined
            found = producer_record_has_forbidden_leak(child, path=joined)
            if found:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = producer_record_has_forbidden_leak(child, path=f"{path}[{index}]")
            if found:
                return found
    elif isinstance(value, str):
        lowered = value.lower()
        if "flickr.com/people/" in lowered or "open-images" in lowered:
            return path or "string value"
    return None


def sanitize_producer_record(raw: Any) -> dict[str, Any]:
    record = require_json_object(raw, "producer record")
    leak = producer_record_has_forbidden_leak(record)
    if leak:
        raise CurateError(f"producer record leaks private metadata at {leak}")
    extra = set(record) - PRODUCER_TOP_LEVEL_KEYS
    if extra:
        raise CurateError(f"producer record has unexpected top-level keys: {sorted(extra)}")
    case_id = require_opaque_case_id(record.get("caseId"), "producer.caseId")
    target = require_string(record.get("target"), "producer.target")
    if not target:
        raise CurateError("producer.target must be nonempty")
    task = require_string(record.get("task"), "producer.task")
    if not task:
        raise CurateError("producer.task must be nonempty")
    image = require_json_object(record.get("image"), "producer.image")
    image_extra = set(image) - PRODUCER_IMAGE_KEYS
    if image_extra:
        raise CurateError(f"producer.image has unexpected keys: {sorted(image_extra)}")
    image_path = require_string(image.get("path"), "producer.image.path")
    if not image_path or image_path != image_path.strip():
        raise CurateError("producer.image.path must be a safe relative path without traversal")
    if "\\" in image_path or image_path.startswith(("/", "\\")):
        raise CurateError("producer.image.path must be a safe relative path without traversal")
    path_parts = Path(image_path)
    if path_parts.is_absolute() or ".." in path_parts.parts:
        raise CurateError("producer.image.path must be a safe relative path without traversal")
    image_sha = require_sha256_hex(image.get("sha256"), "producer.image.sha256")
    width = require_int_not_bool(image.get("width"), "producer.image.width")
    height = require_int_not_bool(image.get("height"), "producer.image.height")
    if width <= 0 or height <= 0:
        raise CurateError("producer.image dimensions must be positive")
    locate = require_json_object(record.get("locate"), "producer.locate")
    if set(locate) != PRODUCER_LOCATE_KEYS:
        raise CurateError("producer.locate must contain only target")
    if require_string(locate.get("target"), "producer.locate.target") != target:
        raise CurateError("producer.locate.target must match producer.target")
    classify = require_json_object(record.get("classify"), "producer.classify")
    if set(classify) != PRODUCER_CLASSIFY_KEYS:
        raise CurateError("producer.classify must contain only task")
    if require_string(classify.get("task"), "producer.classify.task") != task:
        raise CurateError("producer.classify.task must match producer.task")
    return {
        "caseId": case_id,
        "target": target,
        "task": task,
        "image": {"path": image_path, "sha256": image_sha, "width": width, "height": height},
        "locate": {"target": target},
        "classify": {"task": task},
    }


def validate_private_photo_row(row: Any, *, index: int) -> dict[str, Any]:
    item = require_json_object(row, f"private manifest row {index}")
    required = {
        "caseId",
        "expectedPresence",
        "imageId",
        "targetClassId",
        "target",
        "authorProfileUrl",
        "rightsReviewStatus",
        "datasetLicenseMetadata",
        "sourceUrls",
    }
    missing = required - set(item)
    if missing:
        raise CurateError(f"private manifest row {index} missing fields: {sorted(missing)}")
    require_opaque_case_id(item.get("caseId"), f"private row {index}.caseId")
    expected = require_string(item.get("expectedPresence"), f"private row {index}.expectedPresence")
    if expected not in {"present", "absent"}:
        raise CurateError(f"private manifest row {index} has invalid expectedPresence")
    if expected == "present":
        boxes = item.get("targetBoxes")
        if not isinstance(boxes, list) or len(boxes) != 1:
            raise CurateError(f"private manifest row {index} must include exactly one positive targetBox")
        for box_index, box in enumerate(boxes):
            box_obj = require_json_object(box, f"private row {index}.targetBoxes[{box_index}]")
            validate_normalized_box(box_obj.get("xyxy"), label=f"private row {index} box {box_index}")
        validate_instance_mask_metadata(item.get("instanceMaskMetadata"), label=f"private row {index}.instanceMaskMetadata")
        if item.get("negativeEvidence") not in (None, {}):
            raise CurateError(f"private manifest row {index} must not include negativeEvidence")
    else:
        validate_negative_evidence(item.get("negativeEvidence"), label=f"private row {index}.negativeEvidence")
        if item.get("targetBoxes") not in ([], None):
            raise CurateError(f"private manifest row {index} absent row must not include targetBoxes")
        if item.get("instanceMaskMetadata") not in (None, {}):
            raise CurateError(f"private manifest row {index} absent row must not include instanceMaskMetadata")
    if require_string(item.get("rightsReviewStatus"), "rightsReviewStatus") != "pending":
        raise CurateError("private manifest rightsReviewStatus must be pending at metadata-plan stage")
    return item


def load_private_photo_manifest_file(path: Path, *, expected_sha256: str | None = None) -> dict[str, Any]:
    raw, digest = read_bounded_file_bytes(path, max_bytes=MAX_PRIVATE_MANIFEST_BYTES, label="private photo manifest")
    if expected_sha256 is not None and digest != expected_sha256:
        raise CurateError(
            f"private photo manifest SHA-256 mismatch: expected {expected_sha256}, got {digest}"
        )
    payload = require_json_object(
        loads_strict_json(raw.decode("utf-8"), label="private photo manifest"),
        "private photo manifest",
    )
    validate_private_photo_manifest(payload)
    payload["_sha256"] = digest
    return payload


def _validate_fingerprint_index_entries(entries_raw: Any) -> list[dict[str, str]]:
    if not isinstance(entries_raw, list):
        raise CurateError("fingerprint index.entries must be an array")
    entries: list[dict[str, str]] = []
    seen_encoded: set[str] = set()
    for index, item in enumerate(entries_raw):
        row = require_json_object(item, f"fingerprint index.entries[{index}]")
        row_extra = set(row) - {"encodedSha256", "decodedRgbSha256", "perceptualHash64"}
        if row_extra:
            raise CurateError(f"fingerprint index.entries[{index}] has unexpected keys: {sorted(row_extra)}")
        encoded = require_sha256_hex(row.get("encodedSha256"), f"fingerprint index.entries[{index}].encodedSha256")
        decoded = require_sha256_hex(row.get("decodedRgbSha256"), f"fingerprint index.entries[{index}].decodedRgbSha256")
        phash_text = require_string(row.get("perceptualHash64"), f"fingerprint index.entries[{index}].perceptualHash64")
        if not PHASH64_HEX.fullmatch(phash_text):
            raise CurateError("fingerprint index perceptualHash64 must be 16 lowercase hex chars")
        if encoded in seen_encoded:
            raise CurateError("fingerprint index contains duplicate encodedSha256")
        seen_encoded.add(encoded)
        entries.append({"encodedSha256": encoded, "decodedRgbSha256": decoded, "perceptualHash64": phash_text})
    return entries


def validate_fingerprint_index(raw: Any, *, require_runtime_pillow_match: bool = True) -> dict[str, Any]:
    payload = require_json_object(raw, "fingerprint index")
    schema_version = require_string(payload.get("schemaVersion"), "fingerprint index.schemaVersion")
    if schema_version not in (
        FINGERPRINT_INDEX_SCHEMA_V1,
        FINGERPRINT_INDEX_SCHEMA_V2,
        FINGERPRINT_INDEX_SCHEMA_V3,
    ):
        raise CurateError("fingerprint index schemaVersion mismatch")
    allowed_keys = {
        "schemaVersion",
        "exclusionAuditSha256",
        "perceptualHashAlgorithmId",
        "perceptualHashResampler",
        "pillowVersion",
        "entries",
    }
    if schema_version in (FINGERPRINT_INDEX_SCHEMA_V2, FINGERPRINT_INDEX_SCHEMA_V3):
        allowed_keys = allowed_keys | {"exactOnlyEncodedSha256"}
    extra = set(payload) - allowed_keys
    if extra:
        raise CurateError(f"fingerprint index has unexpected keys: {sorted(extra)}")
    pinned_audit = require_sha256_hex(payload.get("exclusionAuditSha256"), "fingerprint index.exclusionAuditSha256")
    algorithm_id = require_string(payload.get("perceptualHashAlgorithmId"), "fingerprint index.perceptualHashAlgorithmId")
    if algorithm_id != PERCEPTUAL_HASH_ALGORITHM_ID:
        raise CurateError("fingerprint index perceptualHashAlgorithmId mismatch")
    resampler = require_string(payload.get("perceptualHashResampler"), "fingerprint index.perceptualHashResampler")
    if resampler != PERCEPTUAL_HASH_RESAMPLER:
        raise CurateError("fingerprint index perceptualHashResampler mismatch")
    pillow_version = require_string(payload.get("pillowVersion"), "fingerprint index.pillowVersion")
    if require_runtime_pillow_match:
        if pillow_version != runtime_pillow_version():
            raise CurateError("fingerprint index pillowVersion mismatch")
    entries = _validate_fingerprint_index_entries(payload.get("entries"))
    exact_only: list[str] = []
    if schema_version in (FINGERPRINT_INDEX_SCHEMA_V2, FINGERPRINT_INDEX_SCHEMA_V3):
        exact_raw = payload.get("exactOnlyEncodedSha256")
        if not isinstance(exact_raw, list):
            raise CurateError("fingerprint index.exactOnlyEncodedSha256 must be an array")
        seen_exact: set[str] = set()
        entry_encoded = {row["encodedSha256"] for row in entries}
        for index, item in enumerate(exact_raw):
            digest = require_sha256_hex(item, f"fingerprint index.exactOnlyEncodedSha256[{index}]")
            if digest in seen_exact:
                raise CurateError("fingerprint index.exactOnlyEncodedSha256 contains duplicate entries")
            if digest in entry_encoded:
                raise CurateError("fingerprint index exact-only encoded SHA overlaps complete entries")
            seen_exact.add(digest)
            exact_only.append(digest)
    result: dict[str, Any] = {
        "schemaVersion": schema_version,
        "exclusionAuditSha256": pinned_audit,
        "perceptualHashAlgorithmId": algorithm_id,
        "perceptualHashResampler": resampler,
        "pillowVersion": pillow_version,
        "entries": entries,
    }
    if schema_version in (FINGERPRINT_INDEX_SCHEMA_V2, FINGERPRINT_INDEX_SCHEMA_V3):
        result["exactOnlyEncodedSha256"] = exact_only
    return result


def validate_fingerprint_index_exclusion_coverage(
    payload: dict[str, Any],
    *,
    exclusion_audit_sha256: str,
    excluded_encoded_sha256: set[str],
) -> None:
    if payload["exclusionAuditSha256"] != exclusion_audit_sha256:
        raise CurateError("fingerprint index exclusion audit SHA-256 mismatch")
    if payload["schemaVersion"] in (FINGERPRINT_INDEX_SCHEMA_V2, FINGERPRINT_INDEX_SCHEMA_V3):
        validate_fingerprint_index_v2_exclusion_coverage(
            payload,
            exclusion_audit_sha256=exclusion_audit_sha256,
            excluded_encoded_sha256=excluded_encoded_sha256,
        )
        return
    expected_count = len(excluded_encoded_sha256)
    if len(payload["entries"]) != expected_count:
        raise CurateError("fingerprint index entry count must match exclusion audit encodedImageSha256 count")
    indexed = {row["encodedSha256"] for row in payload["entries"]}
    if indexed != excluded_encoded_sha256:
        raise CurateError("fingerprint index encodedSha256 set must equal exclusion audit encodedImageSha256 set")


def validate_fingerprint_index_v2_exclusion_coverage(
    payload: dict[str, Any],
    *,
    exclusion_audit_sha256: str,
    excluded_encoded_sha256: set[str],
) -> None:
    if payload["schemaVersion"] not in (FINGERPRINT_INDEX_SCHEMA_V2, FINGERPRINT_INDEX_SCHEMA_V3):
        raise CurateError("fingerprint index schemaVersion mismatch")
    if payload["exclusionAuditSha256"] != exclusion_audit_sha256:
        raise CurateError("fingerprint index exclusion audit SHA-256 mismatch")
    indexed = {row["encodedSha256"] for row in payload["entries"]}
    exact_only = set(payload.get("exactOnlyEncodedSha256") or [])
    if indexed & exact_only:
        raise CurateError("fingerprint index exact-only encoded SHA overlaps complete entries")
    if indexed | exact_only != excluded_encoded_sha256:
        raise CurateError("fingerprint index encoded coverage must equal exclusion audit encodedImageSha256 set")


def load_fingerprint_index_for_v2_merge(path: Path, *, expected_sha256: str) -> dict[str, Any]:
    raw, digest = read_bounded_file_bytes(path, max_bytes=MAX_FINGERPRINT_INDEX_BYTES, label="prior fingerprint index")
    if digest != expected_sha256:
        raise CurateError("prior fingerprint index SHA-256 mismatch")
    payload = validate_fingerprint_index(
        require_json_object(loads_strict_json(raw.decode("utf-8"), label="prior fingerprint index"), "prior fingerprint index"),
        require_runtime_pillow_match=False,
    )
    if payload["schemaVersion"] != FINGERPRINT_INDEX_SCHEMA_V1:
        raise CurateError("prior fingerprint index schemaVersion mismatch")
    return payload


def load_fingerprint_index(
    path: Path,
    *,
    exclusion_audit_sha256: str | None = None,
    excluded_encoded_sha256: set[str] | None = None,
) -> tuple[dict[str, Any], str]:
    raw, digest = read_bounded_file_bytes(path, max_bytes=MAX_FINGERPRINT_INDEX_BYTES, label="fingerprint index")
    payload = validate_fingerprint_index(
        require_json_object(loads_strict_json(raw.decode("utf-8"), label="fingerprint index"), "fingerprint index")
    )
    for index, row in enumerate(payload["entries"]):
        if not row["decodedRgbSha256"] or not row["perceptualHash64"]:
            raise CurateError(f"fingerprint index.entries[{index}] missing decoded/perceptual fields")
    if payload["schemaVersion"] in (FINGERPRINT_INDEX_SCHEMA_V2, FINGERPRINT_INDEX_SCHEMA_V3):
        exact_only = payload.get("exactOnlyEncodedSha256")
        if not isinstance(exact_only, list):
            raise CurateError("fingerprint index.exactOnlyEncodedSha256 must be an array")
    if exclusion_audit_sha256 is not None and excluded_encoded_sha256 is not None:
        validate_fingerprint_index_exclusion_coverage(
            payload,
            exclusion_audit_sha256=exclusion_audit_sha256,
            excluded_encoded_sha256=excluded_encoded_sha256,
        )
    return payload, digest


def validate_duplicate_policy(
    raw: Any,
    *,
    fingerprint_index_sha256: str,
    exclusion_audit_sha256: str | None = None,
) -> dict[str, Any]:
    payload = require_json_object(raw, "duplicate policy")
    extra = set(payload) - {
        "schemaVersion",
        "status",
        "fingerprintIndexSha256",
        "exclusionAuditSha256",
        "perceptualHashAlgorithmId",
        "perceptualHashResampler",
        "pillowVersion",
        "hammingRejectAtMost",
        "encodedSha256Reject",
        "decodedRgbSha256Reject",
        "exactOnlyEncodedSha256Reject",
    }
    if extra:
        raise CurateError(f"duplicate policy has unexpected keys: {sorted(extra)}")
    schema_version = require_string(payload.get("schemaVersion"), "duplicate policy.schemaVersion")
    if schema_version not in (
        DUPLICATE_POLICY_SCHEMA_V1,
        DUPLICATE_POLICY_SCHEMA_V2,
        DUPLICATE_POLICY_SCHEMA_V3,
    ):
        raise CurateError("duplicate policy schemaVersion mismatch")
    if require_string(payload.get("status"), "duplicate policy.status") != "frozen-pre-acquisition":
        raise CurateError("duplicate policy status mismatch")
    pinned = require_sha256_hex(payload.get("fingerprintIndexSha256"), "duplicate policy.fingerprintIndexSha256")
    if pinned != fingerprint_index_sha256:
        raise CurateError("duplicate policy fingerprint index SHA-256 mismatch")
    audit_pinned = require_sha256_hex(payload.get("exclusionAuditSha256"), "duplicate policy.exclusionAuditSha256")
    if exclusion_audit_sha256 is not None and audit_pinned != exclusion_audit_sha256:
        raise CurateError("duplicate policy exclusion audit SHA-256 mismatch")
    algorithm_id = require_string(payload.get("perceptualHashAlgorithmId"), "duplicate policy.perceptualHashAlgorithmId")
    if algorithm_id != PERCEPTUAL_HASH_ALGORITHM_ID:
        raise CurateError("duplicate policy perceptualHashAlgorithmId mismatch")
    resampler = require_string(payload.get("perceptualHashResampler"), "duplicate policy.perceptualHashResampler")
    if resampler != PERCEPTUAL_HASH_RESAMPLER:
        raise CurateError("duplicate policy perceptualHashResampler mismatch")
    policy_pillow = require_string(payload.get("pillowVersion"), "duplicate policy.pillowVersion")
    if policy_pillow != runtime_pillow_version():
        raise CurateError("duplicate policy pillowVersion mismatch")
    hamming = require_int_not_bool(payload.get("hammingRejectAtMost"), "duplicate policy.hammingRejectAtMost")
    if hamming != PHASH_HAMMING_REJECT_AT_MOST:
        raise CurateError("duplicate policy hamming threshold mismatch")
    if payload.get("encodedSha256Reject") is not True:
        raise CurateError("duplicate policy must reject encoded SHA-256 duplicates")
    if payload.get("decodedRgbSha256Reject") is not True:
        raise CurateError("duplicate policy must reject decoded RGB SHA-256 duplicates")
    if schema_version in (DUPLICATE_POLICY_SCHEMA_V2, DUPLICATE_POLICY_SCHEMA_V3):
        if payload.get("exactOnlyEncodedSha256Reject") is not True:
            raise CurateError("duplicate policy must reject exact-only encoded SHA-256 duplicates")
    return payload


def validate_png_mask_framing(png_bytes: bytes) -> None:
    if len(png_bytes) < 33 or png_bytes[:8] != b"\x89PNG\r\n\x1a\n":
        raise CurateError("invalid PNG signature")
    first_length = struct.unpack(">I", png_bytes[8:12])[0]
    if first_length != 13:
        raise CurateError("PNG IHDR chunk length must be 13")
    if png_bytes[12:16] != b"IHDR":
        raise CurateError("PNG first chunk must be IHDR")


def reject_non_identity_jpeg_exif_orientation(jpeg_bytes: bytes) -> None:
    if len(jpeg_bytes) > 5 * 1024 * 1024:
        raise CurateError("JPEG exceeds byte cap")
    try:
        from PIL import Image
    except ImportError as error:
        raise CurateError("Pillow is required for JPEG EXIF inspection") from error
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as image:
            exif = image.getexif()
            if not exif:
                return
            orientation = exif.get(274)
            if orientation not in (None, 1):
                raise CurateError("jpeg-exif-orientation-not-identity")
    except OSError as error:
        raise CurateError("JPEG EXIF inspection failed") from error


def bind_frozen_attempt_list(
    attempt_doc: dict[str, Any],
    *,
    primary_shortlist_sha256: str,
    reserve_commit_sha256: str,
) -> list[dict[str, Any]]:
    payload = require_json_object(attempt_doc, "attempt list")
    pinned_primary = require_sha256_hex(
        payload.get("primaryShortlistSha256"),
        "attempt list.primaryShortlistSha256",
    )
    pinned_reserve = require_sha256_hex(
        payload.get("reserveCommitSha256"),
        "attempt list.reserveCommitSha256",
    )
    if pinned_primary != primary_shortlist_sha256:
        raise CurateError("attempt list primaryShortlistSha256 mismatch")
    if pinned_reserve != reserve_commit_sha256:
        raise CurateError("attempt list reserveCommitSha256 mismatch")
    return validate_attempt_list(payload)


def verify_attempt_row_matches_source(
    attempt: dict[str, Any],
    source_row: dict[str, Any],
    *,
    attempt_index: int,
) -> None:
    bindings = (
        ("caseId", "caseId"),
        ("imageId", "imageId"),
        ("target", "target"),
        ("targetClassId", "targetClassId"),
        ("expectedPresence", "expectedPresence"),
        ("selectionKey", "selectionKey"),
    )
    for attempt_key, source_key in bindings:
        attempt_value = require_string(attempt.get(attempt_key), f"attempt row {attempt_index}.{attempt_key}")
        source_value = require_string(source_row.get(source_key), source_key)
        if attempt_value != source_value:
            raise CurateError("attempt-list-source-row-mismatch")


def validate_attempt_list(raw: Any) -> list[dict[str, Any]]:
    payload = require_json_object(raw, "attempt list")
    schema_version = require_string(payload.get("schemaVersion"), "attempt list.schemaVersion")
    if schema_version not in (ATTEMPT_LIST_SCHEMA_V1, ATTEMPT_LIST_SCHEMA_V2, ATTEMPT_LIST_SCHEMA_V3):
        raise CurateError("attempt list schemaVersion mismatch")
    allowed_top = {"schemaVersion", "selectionSeed", "primaryShortlistSha256", "reserveCommitSha256", "attempts"}
    if schema_version in (ATTEMPT_LIST_SCHEMA_V2, ATTEMPT_LIST_SCHEMA_V3):
        allowed_top = allowed_top | {"metadataProfile"}
    extra = set(payload) - allowed_top
    if extra:
        raise CurateError(f"attempt list has unexpected keys: {sorted(extra)}")
    if schema_version in (ATTEMPT_LIST_SCHEMA_V2, ATTEMPT_LIST_SCHEMA_V3):
        expected_profile = METADATA_PROFILE_V3 if schema_version == ATTEMPT_LIST_SCHEMA_V2 else METADATA_PROFILE_V4
        if require_string(payload.get("metadataProfile"), "attempt list.metadataProfile") != expected_profile:
            raise CurateError("attempt list metadataProfile mismatch")
    attempts = payload.get("attempts")
    if not isinstance(attempts, list) or not attempts:
        raise CurateError("attempt list attempts must be a nonempty array")
    if len(attempts) > MAX_ACQUISITION_CANDIDATES:
        raise CurateError("attempt list exceeds acquisition candidate cap")
    validated: list[dict[str, Any]] = []
    seen_case: set[str] = set()
    for index, item in enumerate(attempts):
        row = require_json_object(item, f"attempt list.attempts[{index}]")
        row_extra = set(row) - {"phase", "expectedPresence", "caseId", "imageId", "targetClassId", "target", "selectionKey"}
        if row_extra:
            raise CurateError(f"attempt list row {index} has unexpected keys: {sorted(row_extra)}")
        phase = require_string(row.get("phase"), f"attempt list row {index}.phase")
        if phase not in {"primary", "reserve"}:
            raise CurateError("attempt phase must be primary or reserve")
        expected = require_string(row.get("expectedPresence"), f"attempt list row {index}.expectedPresence")
        if expected not in {"present", "absent"}:
            raise CurateError("attempt expectedPresence invalid")
        case_id = require_opaque_case_id(row.get("caseId"), f"attempt list row {index}.caseId")
        if case_id in seen_case:
            raise CurateError("attempt list contains duplicate caseId")
        seen_case.add(case_id)
        require_string(row.get("imageId"), f"attempt list row {index}.imageId")
        require_string(row.get("targetClassId"), f"attempt list row {index}.targetClassId")
        require_string(row.get("target"), f"attempt list row {index}.target")
        require_string(row.get("selectionKey"), f"attempt list row {index}.selectionKey")
        validated.append(row)
    return validated


def validate_reserve_manifest(
    raw: Any,
    *,
    primary_shortlist_sha256: str | None = None,
) -> list[dict[str, Any]]:
    payload = require_json_object(raw, "reserve manifest")
    schema_version = require_string(payload.get("schemaVersion"), "schemaVersion")
    if schema_version not in (RESERVE_MANIFEST_SCHEMA_V1, RESERVE_MANIFEST_SCHEMA_V2, RESERVE_MANIFEST_SCHEMA_V3):
        raise CurateError("reserve manifest schemaVersion mismatch")
    if schema_version in (RESERVE_MANIFEST_SCHEMA_V2, RESERVE_MANIFEST_SCHEMA_V3):
        expected_profile = METADATA_PROFILE_V3 if schema_version == RESERVE_MANIFEST_SCHEMA_V2 else METADATA_PROFILE_V4
        if require_string(payload.get("metadataProfile"), "metadataProfile") != expected_profile:
            raise CurateError("reserve manifest metadataProfile mismatch")
    if require_string(payload.get("status"), "status") != "metadata-only-reserve-commit":
        raise CurateError("reserve manifest status mismatch")
    pinned_primary = require_sha256_hex(payload.get("primaryShortlistSha256"), "primaryShortlistSha256")
    if primary_shortlist_sha256 is not None and pinned_primary != primary_shortlist_sha256:
        raise CurateError("reserve manifest primaryShortlistSha256 mismatch")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise CurateError("reserve manifest rows must be an array")
    if len(rows) > 20:
        raise CurateError("reserve manifest exceeds 20-row cap")
    validated = [validate_private_photo_row(row, index=index) for index, row in enumerate(rows)]
    if validated:
        case_ids = [require_string(row["caseId"], "caseId") for row in validated]
        if len(set(case_ids)) != len(case_ids):
            raise CurateError("reserve manifest contains duplicate caseId values")
        image_ids = [require_string(row["imageId"], "imageId") for row in validated]
        if len(set(image_ids)) != len(image_ids):
            raise CurateError("reserve manifest contains duplicate imageId values")
        groups = [normalize_source_group(require_string(row["authorProfileUrl"], "authorProfileUrl")) for row in validated]
        if len(set(groups)) != len(groups):
            raise CurateError("reserve manifest contains duplicate authorProfileUrl values")
    return validated


def validate_private_photo_manifest(raw: Any) -> list[dict[str, Any]]:
    payload = require_json_object(raw, "private photo manifest")
    schema_version = require_string(payload.get("schemaVersion"), "schemaVersion")
    if schema_version not in (PRIVATE_MANIFEST_SCHEMA_V2, PRIVATE_MANIFEST_SCHEMA_V3, PRIVATE_MANIFEST_SCHEMA_V4):
        raise CurateError("private photo manifest schemaVersion mismatch")
    if schema_version in (PRIVATE_MANIFEST_SCHEMA_V3, PRIVATE_MANIFEST_SCHEMA_V4):
        expected_profile = METADATA_PROFILE_V3 if schema_version == PRIVATE_MANIFEST_SCHEMA_V3 else METADATA_PROFILE_V4
        if require_string(payload.get("metadataProfile"), "metadataProfile") != expected_profile:
            raise CurateError("private photo manifest metadataProfile mismatch")
    rows = payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise CurateError("private photo manifest rows must be a nonempty array")
    validated = [validate_private_photo_row(row, index=index) for index, row in enumerate(rows)]
    case_ids = [require_string(row["caseId"], "caseId") for row in validated]
    if len(set(case_ids)) != len(case_ids):
        raise CurateError("private photo manifest contains duplicate caseId values")
    image_ids = [require_string(row["imageId"], "imageId") for row in validated]
    if len(set(image_ids)) != len(image_ids):
        raise CurateError("private photo manifest contains duplicate imageId values")
    groups = [normalize_source_group(require_string(row["authorProfileUrl"], "authorProfileUrl")) for row in validated]
    if len(set(groups)) != len(groups):
        raise CurateError("private photo manifest contains duplicate authorProfileUrl values")
    return validated
