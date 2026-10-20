#!/usr/bin/env python3
"""Materialize exact-canvas OID masks and frozen producer/evaluator files in a supplied private run directory."""
from __future__ import annotations

from pathlib import Path
import argparse
import hashlib
import io
import json
import subprocess
import urllib.request
import zipfile

WORK: Path
SOURCE: Path
MASK_CSV: Path
MASK_BASE = "https://storage.googleapis.com/openimages/v5/validation-masks/validation-masks-{}.zip"
UA = "ZoryaClassifierCorpus/2.1 (bounded public benchmark curation)"
MAX_SHARD_BYTES = 5_000_000
MAX_TOTAL_BYTES = 60_000_000


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_same_or_new(path: Path, data: bytes) -> None:
    if path.exists():
        existing = path.read_bytes()
        if existing == data:
            return
        backup = path.with_name(path.name + ".previous-attempt")
        if not backup.exists():
            backup.write_bytes(existing)
    path.write_bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True, help="existing private acquisition directory")
    parser.add_argument("--source-dir", type=Path, required=True, help="cached official CSV directory")
    parser.add_argument("--mask-csv", type=Path, required=True, help="official instance-segmentation CSV")
    args = parser.parse_args()
    global WORK, SOURCE, MASK_CSV
    WORK, SOURCE, MASK_CSV = args.work_dir.resolve(), args.source_dir.resolve(), args.mask_csv.resolve()
    for required in (WORK / "acquisition.json", SOURCE / "images.csv", SOURCE / "boxes.csv", SOURCE / "labels.csv",
                     SOURCE / "classes.csv", MASK_CSV):
        if not required.is_file():
            raise FileNotFoundError(f"required metadata input is missing: {required.name}")
    acq_path = WORK / "acquisition.json"
    acq = json.loads(acq_path.read_text())
    if acq["status"] != "complete" or acq["admitted"] != {"present": 30, "absent": 10}:
        raise SystemExit("photo acquisition is not a complete 30/10 cohort")
    total = 0
    zips: dict[str, zipfile.ZipFile] = {}
    shard_meta: dict[str, dict] = {}
    mask_outputs = []
    for case in acq["cases"]:
        if case["expectedPresence"] != "present":
            continue
        entry = case["maskSource"]["maskPath"].split("/")[-1]
        prefix = case["imageId"][0].lower()
        if prefix not in zips:
            url = MASK_BASE.format(prefix)
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as response:
                body = response.read(MAX_SHARD_BYTES + 1)
                if len(body) > MAX_SHARD_BYTES:
                    raise ValueError("mask shard exceeded per-file bound")
                total += len(body)
                if total > MAX_TOTAL_BYTES:
                    raise ValueError("mask shard aggregate byte budget exceeded")
                zips[prefix] = zipfile.ZipFile(io.BytesIO(body))
                shard_meta[prefix] = {"url": url, "resolvedUrl": response.url,
                    "httpStatus": response.status, "bytes": len(body), "sha256": sha(body)}
        members = [name for name in zips[prefix].namelist() if Path(name).name == entry]
        if len(members) != 1:
            raise ValueError(f"expected one matching member for official mask {entry}")
        with zips[prefix].open(members[0]) as stream:
            mask = stream.read(5_000_000 + 1)
        if len(mask) > 5_000_000 or mask[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"invalid or oversized mask for {case['caseId']}")
        width = int.from_bytes(mask[16:20], "big")
        height = int.from_bytes(mask[20:24], "big")
        if [width, height] != [case["width"], case["height"]]:
            raise ValueError(f"mask canvas no longer matches photo for {case['caseId']}")
        rel = f"masks/{case['caseId']}/{entry}"
        destination = WORK / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        write_same_or_new(destination, mask)
        decoded = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(destination),
                                  "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                                 capture_output=True, timeout=15, check=True).stdout
        if len(decoded) != width * height or any(value not in (0, 255) for value in decoded):
            raise ValueError(f"official instance mask is not a binary source-sized plane for {case['caseId']}")
        foreground = [idx for idx, value in enumerate(decoded) if value != 0]
        if not foreground:
            raise ValueError(f"official instance mask is empty for {case['caseId']}")
        xs = [idx % width for idx in foreground]
        ys = [idx // width for idx in foreground]
        descriptor = {"path": rel, "sha256": sha(mask), "width": width, "height": height,
            "format": "png-binary", "sourceMaskPath": entry,
            "sourceMaskClassId": case["targetClassId"], "sourceMaskBoxId": case["maskSource"]["maskRow"]["BoxID"],
            "maskExtentPixelsHalfOpen": [min(xs), min(ys), max(xs) + 1, max(ys) + 1]}
        case["referenceMasks"] = [descriptor]
        case["maskShard"] = shard_meta[prefix]
        mask_outputs.append(descriptor)
    for archive in zips.values():
        archive.close()

    inputs = []
    truths = []
    ledger = []
    for case in acq["cases"]:
        inputs.append({"caseId": case["caseId"], "image": {"path": case["file"],
            "sha256": case["sha256"], "width": case["width"], "height": case["height"]},
            "locate": {"target": case["target"],
                "instruction": "Locate the visible physical instance of the named object; return unknown when unsupported."},
            "classify": {"question": f"Does this photograph contain a physical {case['target']}?",
                "options": ["present", "absent"]}})
        truths.append({"caseId": case["caseId"], "expectedPresence": case["expectedPresence"],
            "targetClassId": case["targetClassId"], "targetBoxes": case["targetBoxes"],
            "negativeEvidence": case.get("negativeEvidence"), "allAnnotatedBoxes": case["allAnnotatedBoxes"],
            "referenceMasks": case.get("referenceMasks", []),
            "annotationSource": "Open Images V5 validation human boxes, verification labels, and instance masks",
            "annotationLicense": "https://creativecommons.org/licenses/by/4.0/"})
        ledger.append({k: case[k] for k in ("caseId", "imageId", "sha256", "bytes", "sourceGroup", "source", "license")})
    source_files = []
    for filename, url in (
        ("images.csv", "https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv"),
        ("boxes.csv", "https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv"),
        ("labels.csv", "https://storage.googleapis.com/openimages/v5/validation-annotations-human-imagelabels-boxable.csv"),
        ("classes.csv", "https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv"),
        ("validation-annotations-object-segmentation.csv", "https://storage.googleapis.com/openimages/v5/validation-annotations-object-segmentation.csv"),
    ):
        path = SOURCE / filename if filename != "validation-annotations-object-segmentation.csv" else MASK_CSV
        raw = path.read_bytes()
        source_files.append({"file": filename, "url": url, "bytes": len(raw), "sha256": sha(raw)})
    for name, value in (("inputs.json", inputs), ("ground-truth.json", truths), ("source-ledger.json", {"sourceFiles": source_files, "cases": ledger})):
        payload = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
        write_same_or_new(WORK / name, payload)
    mask_ledger = {"schemaVersion": 1, "dataset": "Open Images V5 validation instance segmentations",
        "annotationLicense": "https://creativecommons.org/licenses/by/4.0/",
        "officialDataPage": "https://storage.googleapis.com/openimages/web/download_v5.html",
        "sourceCsvSha256": source_files[-1]["sha256"], "shards": shard_meta,
        "maskCount": len(mask_outputs), "masks": mask_outputs}
    write_same_or_new(WORK / "mask-source-ledger.json", (json.dumps(mask_ledger, ensure_ascii=False, indent=2) + "\n").encode())
    manifest = {"schemaVersion": 1, "status": "frozen-private-blind-photo40", "selectionSeed": acq["selectionSeed"],
        "caseCount": 40, "present": 30, "absent": 10, "inputsSha256": sha((WORK / "inputs.json").read_bytes()),
        "groundTruthSha256": sha((WORK / "ground-truth.json").read_bytes()),
        "sourceLedgerSha256": sha((WORK / "source-ledger.json").read_bytes()),
        "maskSourceLedgerSha256": sha((WORK / "mask-source-ledger.json").read_bytes()),
        "sourceGroupDisjointFromAllPriorExposures": True, "exactSourceJpegMaskCanvasEquality": True,
        "maxSourcePixels": 2_000_000, "modelCalls": 0, "maskShardDownloadBytes": total}
    write_same_or_new(WORK / "manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode())
    acq["maskShardDownloadBytes"] = total
    acq["sourceMaskFiles"] = len(mask_outputs)
    acq["attemptCounts"] = {presence: sum(1 for row in acq["cases"] if row["expectedPresence"] == presence)
        + sum(1 for row in acq["rejections"] if row["expectedPresence"] == presence)
        for presence in ("present", "absent")}
    acq["frozenFiles"] = {k: v for k, v in manifest.items() if k.endswith("Sha256")}
    acq["sourceFiles"] = source_files
    (WORK / "acquisition.json").write_text(json.dumps(acq, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "frozen-private-blind-photo40", "cases": 40, "positives": 30,
        "negatives": 10, "officialMasks": len(mask_outputs), "manifest": manifest}, indent=2))


if __name__ == "__main__":
    main()
