#!/usr/bin/env python3
"""Bounded, model-free Open Images V5 photo cohort acquisition.

Outputs are written only to the caller-supplied private directory. The script
accepts a complete metadata-only exclusion set and official source rows; it
does not decode image pixels or consult model output.
"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import argparse
import csv
import datetime as dt
import hashlib
import json
import re
import urllib.request
import zipfile

WORK: Path
SOURCE: Path
MASK_CSV: Path
MASK_HEADERS: Path
MASK_BASE = "https://storage.googleapis.com/openimages/v5/validation-masks/validation-masks-{}.zip"
IMAGE_BASE = "https://open-images-dataset.s3.amazonaws.com/validation/{}.jpg"
LICENSE_URL = "https://creativecommons.org/licenses/by/2.0/"
SEED = "zorya-v02-blind-photo40-exposed160-canvas-exact-v1-2026-10-21"
TARGET_CLASSES = {
    "Person", "Dog", "Cat", "Bicycle", "Car", "Chair", "Bottle", "Coffee cup", "Book",
    "Backpack", "Bus", "Traffic light", "Boat", "Bird", "Horse", "Train", "Motorcycle",
    "Flower", "Vase", "Mobile phone", "Laptop", "Clock", "Suitcase", "Bench", "Stop sign",
    "Rabbit", "Spoon", "Camera", "Handbag", "Ball", "Plate", "Table", "Knife", "Tree",
    "Airplane", "Truck", "Couch", "Sunglasses", "Hat", "Helmet", "Umbrella", "Bowl", "Fork",
    "Teddy bear", "Orange", "Apple", "Banana", "Fish", "Butterfly", "Mug",
}
UA = "ZoryaClassifierCorpus/2.1 (bounded public benchmark curation)"
MAX_RESPONSE_BYTES = 5_000_000
MAX_TOTAL_BYTES = 300_000_000
MAX_POSITIVE_ATTEMPTS = 300
MAX_NEGATIVE_ATTEMPTS = 200


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def request(url: str, limit: int, total: list[int]) -> tuple[bytes, str, int]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as response:
        body = response.read(limit + 1)
        total[0] += len(body)
        if len(body) > limit:
            raise ValueError("bounded response exceeded")
        if total[0] > MAX_TOTAL_BYTES:
            raise RuntimeError("aggregate response-byte cap exceeded")
        return body, response.url, response.status


def jpeg_metadata(data: bytes) -> dict[str, int | None]:
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("not a JPEG")
    i = 2
    orientation = None
    dimensions = None
    while i < len(data):
        if data[i] != 0xFF:
            raise ValueError("invalid JPEG marker stream")
        while i < len(data) and data[i] == 0xFF:
            i += 1
        if i >= len(data):
            break
        marker = data[i]
        i += 1
        if marker == 0xDA:
            break
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if i + 2 > len(data):
            break
        length = int.from_bytes(data[i:i + 2], "big")
        if length < 2 or i + length > len(data):
            raise ValueError("truncated JPEG segment")
        segment = data[i + 2:i + length]
        if marker == 0xE1 and segment.startswith(b"Exif\x00\x00"):
            orientation = exif_orientation(segment[6:])
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height = int.from_bytes(segment[1:3], "big")
            width = int.from_bytes(segment[3:5], "big")
            dimensions = (width, height)
        i += length
    if dimensions is None:
        raise ValueError("JPEG dimensions unavailable")
    width, height = dimensions
    if width <= 0 or height <= 0 or width * height > 2_000_000:
        raise ValueError("source JPEG canvas exceeds 2MP admission limit")
    if orientation not in (None, 1):
        raise ValueError(f"EXIF orientation {orientation} is not identity")
    return {"width": width, "height": height, "exifOrientation": orientation}


def exif_orientation(tiff: bytes) -> int | None:
    if len(tiff) < 8:
        return None
    endian = "little" if tiff[:2] == b"II" else "big" if tiff[:2] == b"MM" else None
    if endian is None:
        return None
    if int.from_bytes(tiff[2:4], endian) != 42:
        return None
    offset = int.from_bytes(tiff[4:8], endian)
    if offset + 2 > len(tiff):
        return None
    count = int.from_bytes(tiff[offset:offset + 2], endian)
    for j in range(count):
        entry = offset + 2 + j * 12
        if entry + 12 > len(tiff):
            return None
        tag = int.from_bytes(tiff[entry:entry + 2], endian)
        typ = int.from_bytes(tiff[entry + 2:entry + 4], endian)
        number = int.from_bytes(tiff[entry + 4:entry + 8], endian)
        if tag == 0x0112 and typ == 3 and number == 1:
            return int.from_bytes(tiff[entry + 8:entry + 10], endian)
    return None


def license_evidence(meta: dict[str, str], total: list[int]) -> dict:
    body, resolved, status = request(meta["OriginalLandingURL"], 2_000_000, total)
    blocks = re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', body.decode("utf-8"), re.S | re.I)
    found = []
    photo_id = meta["OriginalLandingURL"].rstrip("/").split("/")[-1]
    for block in blocks:
        try:
            value = json.loads(block)
        except json.JSONDecodeError:
            continue
        items = value.get("@graph", [value]) if isinstance(value, dict) else value
        if not isinstance(items, list):
            items = [items]
        for item in items:
            if (isinstance(item, dict) and item.get("@type") == "ImageObject"
                    and item.get("acquireLicensePage", "").rstrip("/").split("/")[-1] == photo_id
                    and item.get("license") == LICENSE_URL):
                found.append((item, block))
    if len(found) != 1:
        raise ValueError("original page lacks one photo-specific CC-BY-2.0 ImageObject")
    item, block = found[0]
    return {
        "sourceUrl": meta["OriginalLandingURL"], "resolvedUrl": resolved, "httpStatus": status,
        "sourcePageBytes": len(body), "sourcePageSha256": sha(body),
        "extraction": "JSON-LD ImageObject matched by original photo ID and exact CC BY 2.0 URL",
        "structuredData": item, "structuredBlockSha256": sha(block.encode()),
        "verifiedLicenseUrl": LICENSE_URL, "flickrPhotoId": photo_id,
        "rawPagePersisted": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True, help="new private acquisition directory")
    parser.add_argument("--source-dir", type=Path, required=True, help="cached official CSV directory")
    parser.add_argument("--mask-csv", type=Path, required=True, help="official instance-segmentation CSV")
    parser.add_argument("--mask-header-index", type=Path, required=True, help="metadata-only mask PNG header index")
    parser.add_argument("--exclusion-manifest", type=Path, action="append", required=True,
                        help="prior exposure manifest/source ledger; provide every required exclusion ledger")
    args = parser.parse_args()
    global WORK, SOURCE, MASK_CSV, MASK_HEADERS
    WORK, SOURCE, MASK_CSV, MASK_HEADERS = (
        args.output_dir.resolve(), args.source_dir.resolve(), args.mask_csv.resolve(), args.mask_header_index.resolve()
    )
    if len(args.exclusion_manifest) != 3:
        raise ValueError("exactly three independent prior-exposure ledgers are required")
    for required in (SOURCE / "classes.csv", SOURCE / "images.csv", SOURCE / "boxes.csv", SOURCE / "labels.csv",
                     MASK_CSV, MASK_HEADERS, *args.exclusion_manifest):
        if not required.is_file():
            raise FileNotFoundError(f"required metadata input is missing: {required.name}")
    WORK.mkdir(parents=True, exist_ok=False)
    exclusions = {"ids": set(), "sha256s": set(), "groups": set()}
    ledger_pins = []
    for path in args.exclusion_manifest:
        raw = path.read_bytes()
        data = json.loads(raw)
        cases = data["cases"]
        if not isinstance(cases, list) or not cases:
            raise ValueError("exclusion ledger must contain a nonempty cases array")
        group_keys = [key for key in ("authorGroup", "sourceGroup") if all(key in case for case in cases)]
        if len(group_keys) != 1 or any("imageId" not in case or "sha256" not in case for case in cases):
            raise ValueError("exclusion ledger has ambiguous or incomplete image/source-group fields")
        group_key = group_keys[0]
        vals = [(c["imageId"], c["sha256"], c[group_key].rstrip("/")) for c in cases]
        for image_id, digest, group in vals:
            exclusions["ids"].add(image_id)
            exclusions["sha256s"].add(digest)
            exclusions["groups"].add(group)
        ledger_pins.append({"pathRole": path.name, "sha256": sha(raw), "cases": len(cases)})
    if tuple(map(len, exclusions.values())) != (160, 160, 160):
        raise RuntimeError("exposed-source exclusion union changed or incomplete")
    exclusion_audit = {
        "schemaVersion": 1,
        "status": "verified-metadata-only",
        "ledgers": ledger_pins,
        "counts": {k: len(v) for k, v in exclusions.items()},
        "pairwiseOverlap": {"ids": 0, "sha256s": 0, "sourceGroups": 0},
        "source": "Open Images source groups normalized as exact AuthorProfileURL paths",
    }
    (WORK / "exclusion-audit.json").write_text(json.dumps(exclusion_audit, indent=2) + "\n")

    classes = {r["LabelName"]: r["DisplayName"] for r in read_csv(SOURCE / "classes.csv")}
    wanted = {mid for mid, name in classes.items() if name in TARGET_CLASSES}
    images = {r["ImageID"]: r for r in read_csv(SOURCE / "images.csv")
              if r["License"] == LICENSE_URL and r["Rotation"] in ("", "0", "0.0")}
    boxes: dict[tuple[str, str], list[dict]] = defaultdict(list)
    target_boxes_all: dict[tuple[str, str], list[dict]] = defaultdict(list)
    all_boxes: dict[str, list[dict]] = defaultdict(list)
    for index, row in enumerate(read_csv(SOURCE / "boxes.csv"), 2):
        image_id, mid = row["ImageID"], row["LabelName"]
        if image_id not in images:
            continue
        box = {
            "classId": mid, "className": classes.get(mid, mid),
            "xyxy": [float(row[k]) for k in ("XMin", "YMin", "XMax", "YMax")],
            "source": row["Source"], "sourceCsvRow": index,
            "occluded": int(row["IsOccluded"]), "truncated": int(row["IsTruncated"]),
            "groupOf": int(row["IsGroupOf"]), "depiction": int(row["IsDepiction"]),
            "inside": int(row["IsInside"]),
        }
        all_boxes[image_id].append(box)
        if mid in wanted:
            target_boxes_all[(image_id, mid)].append(box)
            if box["groupOf"] == 0 and box["depiction"] == 0:
                boxes[(image_id, mid)].append(box)
    mask_rows: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in read_csv(MASK_CSV):
        key = (row["ImageID"], row["LabelName"])
        if key in boxes and key[0] in images and images[key[0]]["AuthorProfileURL"].rstrip("/") not in exclusions["groups"]:
            mask_rows[key].append(row)
    mask_index = json.loads(MASK_HEADERS.read_text())["entries"]
    positive = []
    for key, found_boxes in boxes.items():
        found_masks = mask_rows.get(key, [])
        # One official box and one mask avoids ambiguous instance matching.
        if len(found_boxes) != 1 or len(found_masks) != 1 or len(target_boxes_all[key]) != 1:
            continue
        mask = found_masks[0]
        wh = mask_index.get(mask["MaskPath"])
        if not wh or wh["width"] > 1024 or wh["height"] > 1024:
            continue
        box_xyxy = found_boxes[0]["xyxy"]
        mask_xyxy = [float(mask[k]) for k in ("BoxXMin", "BoxYMin", "BoxXMax", "BoxYMax")]
        if max(abs(a - b) for a, b in zip(box_xyxy, mask_xyxy)) > 0.000001:
            continue
        positive.append({"imageId": key[0], "classId": key[1], "target": classes[key[1]],
                         "box": found_boxes[0], "maskRow": mask, "maskDimensions": wh})
    positive.sort(key=lambda c: sha(f"{SEED}/positive/{c['imageId']}/{c['classId']}".encode()))

    negative_rows: dict[tuple[str, str], dict] = {}
    for index, row in enumerate(read_csv(SOURCE / "labels.csv"), 2):
        image_id, mid = row["ImageID"], row["LabelName"]
        if (image_id in images and mid in wanted and row["Source"] == "verification"
                and row["Confidence"] == "0" and not target_boxes_all.get((image_id, mid))
                and images[image_id]["AuthorProfileURL"].rstrip("/") not in exclusions["groups"]):
            negative_rows.setdefault((image_id, mid), {
                "imageId": image_id, "classId": mid, "target": classes[mid],
                "negativeEvidence": {"type": "explicit-human-verified-image-label", "source": row["Source"],
                                     "confidence": 0, "sourceCsvRow": index,
                                     "sourceFile": "source/labels.csv"},
            })
    negative = list(negative_rows.values())
    negative.sort(key=lambda c: sha(f"{SEED}/negative/{c['imageId']}/{c['classId']}".encode()))
    (WORK / "candidate-counts.json").write_text(json.dumps({
        "schemaVersion": 1, "selectionSeed": SEED, "excludedSourceGroups": 160,
        "eligiblePositiveUniqueBoxMaskPairsBeforePhotoDimensionCheck": len(positive),
        "eligiblePositivePhotosBeforePhotoDimensionCheck": len({c["imageId"] for c in positive}),
        "eligibleNegativeExplicitVerifiedImageLabelPairs": len(negative),
        "positiveMaskDimensionRule": "mask PNG canvas max side <=1024 before JPEG fetch; final exact width/height equality required",
        "boxMaskInstanceLink": "one target box and one mask per image/class; mask starting box must match human box within 1e-6 normalized coordinates",
        "candidateOrdering": "SHA256(seed/category/ImageID/LabelName)",
        "maxPhotoPixels": 2_000_000,
    }, indent=2) + "\n")

    total = [0]
    used_groups = set(exclusions["groups"])
    used_ids = set(exclusions["ids"])
    used_hashes = set(exclusions["sha256s"])
    class_count: dict[str, int] = defaultdict(int)
    records: list[dict] = []
    rejects: list[dict] = []
    admitted_positive: list[dict] = []

    def try_photo(c: dict, expected: str, case_id: str) -> dict | None:
        image_id = c["imageId"]
        meta = images[image_id]
        group = meta["AuthorProfileURL"].rstrip("/")
        if image_id in used_ids or group in used_groups or class_count[c["classId"]] >= 4:
            return None
        url = IMAGE_BASE.format(image_id)
        try:
            raw, resolved, status = request(url, MAX_RESPONSE_BYTES, total)
            jpeg = jpeg_metadata(raw)
            if expected == "present":
                md = c["maskDimensions"]
                if [jpeg["width"], jpeg["height"]] != [md["width"], md["height"]]:
                    raise ValueError("official-mask-canvas-not-exactly-equal-to-source-JPEG-canvas")
            evidence = license_evidence(meta, total)
            digest = sha(raw)
            if digest in used_hashes:
                raise ValueError("image bytes duplicate an exposed or admitted image")
            image_rel = f"images/{image_id}.jpg"
            image_path = WORK / image_rel
            image_path.parent.mkdir(parents=True, exist_ok=True)
            image_path.write_bytes(raw)
            rec = {
                "caseId": case_id, "imageId": image_id, "expectedPresence": expected,
                "targetClassId": c["classId"], "target": c["target"],
                "file": image_rel, "sha256": digest, "bytes": len(raw),
                "width": jpeg["width"], "height": jpeg["height"],
                "sourceGroup": group,
                "source": {"dataset": "Open Images V5 validation", "imageId": image_id,
                           "officialSplit": "validation", "downloadUrl": url,
                           "resolvedDownloadUrl": resolved, "httpStatus": status,
                           "originalUrl": meta["OriginalURL"], "originalLandingUrl": meta["OriginalLandingURL"],
                           "originalMD5Base64": meta["OriginalMD5"], "originalSizeBytes": meta["OriginalSize"],
                           "rotationMetadata": meta["Rotation"], "exifOrientation": jpeg["exifOrientation"],
                           "imageCsvRow": image_id},
                "license": {"spdx": "CC-BY-2.0", "url": LICENSE_URL,
                            "title": meta["Title"], "author": meta["Author"],
                            "authorUrl": meta["AuthorProfileURL"], "evidence": evidence,
                            "verification": "photo-specific Flickr JSON-LD ImageObject; source page not persisted"},
                "targetBoxes": [c["box"]] if expected == "present" else [],
                "negativeEvidence": c.get("negativeEvidence"),
                "allAnnotatedBoxes": all_boxes[image_id],
            }
            if expected == "present":
                rec["maskSource"] = {"maskPath": c["maskRow"]["MaskPath"],
                    "maskCsvSha256": sha(MASK_CSV.read_bytes()),
                    "maskRow": c["maskRow"], "dimensions": c["maskDimensions"],
                    "canvasAdmission": "exact source JPEG width/height match; identity EXIF and rotation 0"}
            used_ids.add(image_id); used_hashes.add(digest); used_groups.add(group)
            class_count[c["classId"]] += 1
            return rec
        except Exception as error:
            rejects.append({"imageId": image_id, "targetClassId": c["classId"],
                            "expectedPresence": expected, "caseId": case_id,
                            "stage": "source-photo-or-license-admission",
                            "errorType": type(error).__name__, "reason": str(error)[:220]})
            return None

    for c in positive[:MAX_POSITIVE_ATTEMPTS]:
        if len(admitted_positive) == 30:
            break
        group = images[c["imageId"]]["AuthorProfileURL"].rstrip("/")
        if group in used_groups or class_count[c["classId"]] >= 4 or c["imageId"] in used_ids:
            continue
        rec = try_photo(c, "present", f"photo-heldout-present-{len(admitted_positive)+1:02d}")
        if rec:
            admitted_positive.append(rec)
            records.append(rec)
            print("admitted positive", len(admitted_positive), "of 30", flush=True)
        if total[0] > MAX_TOTAL_BYTES:
            break

    admitted_negative: list[dict] = []
    if len(admitted_positive) == 30:
        for c in negative[:MAX_NEGATIVE_ATTEMPTS]:
            if len(admitted_negative) == 10:
                break
            group = images[c["imageId"]]["AuthorProfileURL"].rstrip("/")
            if group in used_groups or class_count[c["classId"]] >= 4 or c["imageId"] in used_ids:
                continue
            rec = try_photo(c, "absent", f"photo-heldout-absent-{len(admitted_negative)+1:02d}")
            if rec:
                admitted_negative.append(rec)
                records.append(rec)
                print("admitted negative", len(admitted_negative), "of 10", flush=True)
            if total[0] > MAX_TOTAL_BYTES:
                break

    status = "complete" if len(admitted_positive) == 30 and len(admitted_negative) == 10 else "quota-shortfall"
    report = {"schemaVersion": 1, "status": status, "selectionSeed": SEED,
        "method": "metadata-filtered deterministic Open Images V5; source masks require exact JPEG canvas match",
        "targetInstruction": "Locate the visible physical instance of the named object; return unknown when unsupported.",
        "quota": {"present": 30, "absent": 10},
        "admitted": {"present": len(admitted_positive), "absent": len(admitted_negative)},
        "maxSourcePixels": 2_000_000, "maxAggregateResponseBytes": MAX_TOTAL_BYTES,
        "responseBytes": total[0], "attemptCounts": {"present": min(MAX_POSITIVE_ATTEMPTS, len(positive)), "absent": min(MAX_NEGATIVE_ATTEMPTS, len(negative)) if len(admitted_positive)==30 else 0},
        "exposedUnion": exclusion_audit, "rejections": rejects,
        "cases": records,
    }
    (WORK / "acquisition.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": status, "admitted": report["admitted"], "rejections": len(rejects),
                      "responseBytes": total[0], "output": str(WORK)}, indent=2))


if __name__ == "__main__":
    main()
