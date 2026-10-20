#!/usr/bin/env python3
"""Bounded Open Images v5 photo acquisition for the v0.2 blind corpus.

Reads the existing local source CSV cache; fetches only individually selected
image bytes and their public Flickr license pages. No model is called. Raw
photos and masks stay under ignored benchmarks/cache/v02/corpus/.
"""
from __future__ import annotations

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import csv
import datetime as dt
import hashlib
import json
import os
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "benchmarks/cache/v02/corpus"
SOURCE = Path(os.environ.get("ZORYA_OI_SOURCE_CACHE", "/root/work/zorya-classifier/benchmarks/corpus/source"))
OLD = ROOT / "benchmarks/corpus/photo-manifest.json"
LICENSE = "https://creativecommons.org/licenses/by/2.0/"
SEED = "zorya-v02-fresh-openimages-2026-10-20"
QUOTA = {"dev": {"present": 16, "absent": 4}, "heldout": {"present": 30, "absent": 10}}
CLASSES = {
    "Person", "Dog", "Cat", "Bicycle", "Car", "Chair", "Bottle", "Coffee cup", "Book",
    "Backpack", "Bus", "Traffic light", "Boat", "Bird", "Horse", "Train", "Motorcycle",
    "Flower", "Vase", "Mobile phone", "Laptop", "Clock", "Suitcase", "Bench", "Stop sign",
    "Rabbit", "Spoon", "Camera", "Handbag", "Ball", "Plate", "Table", "Knife", "Tree",
    "Airplane", "Truck", "Couch", "Sunglasses", "Hat", "Helmet", "Umbrella", "Bowl", "Fork",
    "Teddy bear", "Orange", "Apple", "Banana", "Fish", "Butterfly", "Mug",
}
UA = "ZoryaClassifierCorpus/2.0 (bounded public benchmark acquisition)"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def get(url: str, limit: int) -> tuple[bytes, str, int]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("bounded response exceeded")
        return data, response.url, response.status


def rows(name: str) -> list[dict[str, str]]:
    with (SOURCE / name).open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def license_evidence(meta: dict[str, str]) -> dict:
    image_id = meta["ImageID"]
    path = CACHE / "licenses" / f"{image_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    body, resolved, status = get(meta["OriginalLandingURL"], 2 * 1024 * 1024)
    matches = []
    for raw in re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', body.decode("utf-8"), re.S | re.I):
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        items = obj.get("@graph", [obj]) if isinstance(obj, dict) else obj
        for item in items if isinstance(items, list) else [items]:
            if isinstance(item, dict) and item.get("@type") == "ImageObject":
                matches.append((item, raw))
    photo_id = meta["OriginalLandingURL"].rstrip("/").split("/")[-1]
    admitted = [(item, raw) for item, raw in matches
                if item.get("acquireLicensePage", "").rstrip("/").split("/")[-1] == photo_id
                and item.get("license") == LICENSE]
    if len(admitted) != 1:
        raise ValueError("original page does not expose exactly one photo-specific CC BY 2.0 ImageObject")
    item, raw = admitted[0]
    evidence = {
        "sourceUrl": meta["OriginalLandingURL"], "resolvedUrl": resolved, "httpStatus": status,
        "checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "sourcePageBytes": len(body),
        "sourcePageSha256": sha(body), "extraction": "ImageObject matched by Flickr photo ID and CC BY 2.0; global license strings excluded",
        "structuredData": item, "structuredBlockSha256": sha(raw.encode()), "verifiedLicenseUrl": LICENSE,
        "flickrPhotoId": photo_id, "rawPagePersisted": False,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    return evidence


def fetch_photo(image_id: str) -> tuple[bytes, str]:
    path = CACHE / "photos" / f"{image_id}.jpg"
    if path.exists():
        return path.read_bytes(), f"https://open-images-dataset.s3.amazonaws.com/validation/{image_id}.jpg"
    url = f"https://open-images-dataset.s3.amazonaws.com/validation/{image_id}.jpg"
    body, resolved, _ = get(url, 5 * 1024 * 1024)
    if not body.startswith(b"\xff\xd8"):
        raise ValueError("source response is not JPEG")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return body, resolved


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    old_cases = json.loads(OLD.read_text())["cases"]
    old_ids = {c["imageId"] for c in old_cases}
    old_hashes = {c["sha256"] for c in old_cases}
    old_groups = {c["authorGroup"].rstrip("/") for c in old_cases}
    image_rows = {r["ImageID"]: r for r in rows("images.csv")
                  if r["License"] == LICENSE and r["Rotation"] in ("", "0", "0.0")}
    classes = {r["LabelName"]: r["DisplayName"] for r in rows("classes.csv")}
    selected_class_ids = {mid for mid, title in classes.items() if title in CLASSES}
    box_rows = rows("boxes.csv")
    label_rows = rows("labels.csv")
    box_by_key: dict[tuple[str, str], list[dict]] = defaultdict(list)
    all_boxes: dict[str, list[dict]] = defaultdict(list)
    for index, row in enumerate(box_rows, 2):
        image, mid = row["ImageID"], row["LabelName"]
        if image not in image_rows:
            continue
        b = {"classId": mid, "className": classes.get(mid, mid),
             "xyxy": [float(row[k]) for k in ("XMin", "YMin", "XMax", "YMax")],
             "source": row["Source"], "sourceCsvRow": index,
             "occluded": int(row["IsOccluded"]), "truncated": int(row["IsTruncated"]),
             "groupOf": int(row["IsGroupOf"]), "depiction": int(row["IsDepiction"]),
             "inside": int(row["IsInside"])}
        all_boxes[image].append(b)
        if mid in selected_class_ids:
            box_by_key[(image, mid)].append(b)

    candidates: dict[str, list[dict]] = {"present": [], "absent": []}
    for (image, mid), boxes in box_by_key.items():
        if image in old_ids or any(b["groupOf"] or b["depiction"] for b in boxes):
            continue
        candidates["present"].append({"imageId": image, "targetClassId": mid,
            "target": classes[mid], "expectedPresence": "present", "targetBoxes": boxes,
            "negativeEvidence": None, "allAnnotatedBoxes": all_boxes[image]})
    for index, row in enumerate(label_rows, 2):
        image, mid = row["ImageID"], row["LabelName"]
        if (image not in image_rows or image in old_ids or mid not in selected_class_ids
                or row["Confidence"] != "0" or row["Source"] != "verification"
                or box_by_key.get((image, mid))):
            continue
        candidates["absent"].append({"imageId": image, "targetClassId": mid,
            "target": classes[mid], "expectedPresence": "absent", "targetBoxes": [],
            "negativeEvidence": {"type": "explicit-human-verified-image-label", "source": row["Source"],
                                 "confidence": 0, "sourceCsvRow": index, "sourceFile": "source/labels.csv"},
            "allAnnotatedBoxes": all_boxes[image]})
    for category in candidates:
        candidates[category].sort(key=lambda c: sha(f"{SEED}/{category}/{c['imageId']}/{c['targetClassId']}".encode()))

    # Candidate selection is deterministic. Selection/provenance excludes all v1 IDs, bytes,
    # and Flickr authors before fetching any new photo. Group disjointness is then enforced
    # across dev and heldout together.
    counts_by_class: dict[str, int] = defaultdict(int)
    used_images: set[str] = set(old_ids)
    used_groups = set(old_groups)
    used_hashes = set(old_hashes)
    records = []
    rejected = []
    for split, quotas in QUOTA.items():
        for category, quota in quotas.items():
            accepted = 0
            for candidate in candidates[category]:
                if accepted == quota:
                    break
                image = candidate["imageId"]
                meta = image_rows[image]
                group = meta["AuthorProfileURL"].rstrip("/")
                if image in used_images or group in used_groups or counts_by_class[candidate["targetClassId"]] >= 4:
                    continue
                try:
                    license_doc = license_evidence(meta)
                    raw, resolved = fetch_photo(image)
                    digest = sha(raw)
                    if digest in used_hashes:
                        raise ValueError("photo byte hash duplicates an excluded/admitted photo")
                    if len(raw) < 100 or len(raw) > 5 * 1024 * 1024:
                        raise ValueError("invalid image byte length")
                except Exception as error:
                    rejected.append({"imageId": image, "target": candidate["target"], "split": split,
                                     "kind": category, "errorType": type(error).__name__, "detail": str(error)[:180]})
                    continue
                wh = _jpeg_dimensions(raw)
                case_id = f"photo-{split}-{category}-{accepted + 1:02d}"
                record = {
                    "caseId": case_id, "split": split, "kind": category,
                    "imageId": image, "file": f"photos/{image}.jpg", "sha256": digest,
                    "bytes": len(raw), "width": wh[0], "height": wh[1],
                    "sourceGroup": group,
                    "source": {"dataset": "Open Images V5 validation", "imageId": image,
                               "officialSplit": "validation", "downloadUrl": f"https://open-images-dataset.s3.amazonaws.com/validation/{image}.jpg",
                               "resolvedDownloadUrl": resolved, "originalUrl": meta["OriginalURL"],
                               "originalLandingUrl": meta["OriginalLandingURL"], "originalMD5Base64": meta["OriginalMD5"],
                               "originalSize": meta["OriginalSize"], "rotation": meta["Rotation"],
                               "retrievedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                               "transform": "upstream Open Images 1024px max-side JPEG; no local transform"},
                    "license": {"spdx": "CC-BY-2.0", "url": LICENSE, "title": meta["Title"],
                                "author": meta["Author"], "authorUrl": meta["AuthorProfileURL"],
                                "evidence": f"licenses/{image}.json", "evidenceSha256": sha((CACHE / "licenses" / f"{image}.json").read_bytes()),
                                "verification": "page-specific Flickr JSON-LD ImageObject; no ownership warranty"},
                    "target": candidate["target"], "targetClassId": candidate["targetClassId"],
                    "expectedPresence": candidate["expectedPresence"],
                    "targetBoxes": candidate["targetBoxes"], "negativeEvidence": candidate["negativeEvidence"],
                    "allAnnotatedBoxes": candidate["allAnnotatedBoxes"],
                }
                records.append(record)
                used_images.add(image); used_groups.add(group); used_hashes.add(digest)
                counts_by_class[candidate["targetClassId"]] += 1
                accepted += 1
                print("accepted", case_id, candidate["target"], image, flush=True)
            if accepted != quota:
                raise RuntimeError(f"quota shortfall {split}/{category}: {accepted}/{quota}")

    source_manifest = []
    for name, url in (("images.csv", "https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv"),
                      ("boxes.csv", "https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv"),
                      ("labels.csv", "https://storage.googleapis.com/openimages/v5/validation-annotations-human-imagelabels-boxable.csv"),
                      ("classes.csv", "https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv")):
        data = (SOURCE / name).read_bytes()
        source_manifest.append({"file": name, "url": url, "bytes": len(data), "sha256": sha(data), "cachePath": str(SOURCE / name)})
    stamp = dt.datetime.now(dt.timezone.utc).isoformat()
    cases = [{k: v for k, v in record.items() if k not in (
        "kind", "targetBoxes", "negativeEvidence", "allAnnotatedBoxes", "expectedPresence", "target", "targetClassId")}
        for record in records]
    input_records = []
    truth_records = []
    for record in records:
        input_records.append({"caseId": record["caseId"], "image": {"path": str(CACHE / record["file"]),
            "sha256": record["sha256"], "width": record["width"], "height": record["height"]},
            "locate": {"target": record["target"], "instruction": "Locate the visible physical instance of the named object; return unknown when unsupported."},
            "classify": {"question": f"Does this photograph contain a physical {record['target']}?",
                         "options": ["present", "absent"]}})
        truth_records.append({"caseId": record["caseId"], "expectedPresence": record["expectedPresence"],
            "targetClassId": record["targetClassId"], "targetBoxes": record["targetBoxes"],
            "negativeEvidence": record["negativeEvidence"], "allAnnotatedBoxes": record["allAnnotatedBoxes"],
            "annotationSource": "Open Images V5 validation human boxes / verification labels",
            "annotationLicense": "https://creativecommons.org/licenses/by/4.0/"})
    # The source/license ledger is independently allowlisted and contains no target/truth fields.
    (CACHE / "source-ledger.json").write_text(json.dumps({"schemaVersion": 1, "createdAt": stamp,
        "annotationDataset": "Open Images V5 validation",
        "annotationLicense": "https://creativecommons.org/licenses/by/4.0/",
        "annotationSources": source_manifest,
        "excludedV1": {"photoManifest": "benchmarks/corpus/photo-manifest.json",
        "imageIds": len(old_ids), "sha256s": len(old_hashes), "sourceGroups": len(old_groups)},
        "selectionSeed": SEED, "selectionBeforeModelOutputs": True,
        "cases": [
        {"caseId": c["caseId"], "imageId": c["imageId"], "sha256": c["sha256"],
         "bytes": c["bytes"], "sourceGroup": c["sourceGroup"], "source": c["source"], "license": c["license"]}
        for c in cases]}, ensure_ascii=False, indent=2) + "\n")
    (CACHE / "photo-manifest.json").write_text(json.dumps({"schemaVersion": 1,
        "status": "acquired-photos-pending-map-ui", "selectionSeed": SEED,
        "excludedV1": {"ids": len(old_ids), "sha256s": len(old_hashes), "sourceGroups": len(old_groups)},
        "expectedCounts": {"dev": 20, "heldout": 40}, "rejections": rejected,
        "caseMetadata": cases}, ensure_ascii=False, indent=2) + "\n")
    for split in QUOTA:
        split_inputs = [x for x, r in zip(input_records, records) if r["split"] == split]
        split_truth = [x for x, r in zip(truth_records, records) if r["split"] == split]
        (CACHE / f"inputs-{split}.json").write_text(json.dumps(split_inputs, ensure_ascii=False, indent=2) + "\n")
        (CACHE / f"ground-truth-{split}.json").write_text(json.dumps(split_truth, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "photos-acquired", "count": len(records),
        "bySplit": {s: sum(r["split"] == s for r in records) for s in QUOTA},
        "bySplitAndPresence": {s: {k: sum(r["split"] == s and r["kind"] == k for r in records)
                                   for k in ("present", "absent")} for s in QUOTA},
        "rejections": len(rejected), "modelCalls": 0, "cache": str(CACHE)}, indent=2))


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("not JPEG")
    i = 2
    while i < len(data):
        if data[i] != 0xFF:
            raise ValueError("bad JPEG marker")
        while i < len(data) and data[i] == 0xFF:
            i += 1
        marker = data[i]; i += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        n = int.from_bytes(data[i:i + 2], "big")
        if n < 2 or i + n > len(data):
            raise ValueError("truncated JPEG")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h = int.from_bytes(data[i + 3:i + 5], "big")
            w = int.from_bytes(data[i + 5:i + 7], "big")
            if not 32 <= w <= 4096 or not 32 <= h <= 4096 or w * h > 16_000_000:
                raise ValueError("pixel bounds")
            return w, h
        i += n
    raise ValueError("dimensions absent")


if __name__ == "__main__":
    main()
