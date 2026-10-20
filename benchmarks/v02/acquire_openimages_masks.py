#!/usr/bin/env python3
"""Fetch only Open Images V5 validation mask shards needed by acquired photo IDs."""
from pathlib import Path
import csv
import hashlib
import io
import json
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "benchmarks/cache/v02/corpus"
CSV_URL = "https://storage.googleapis.com/openimages/v5/validation-annotations-object-segmentation.csv"
ZIP_BASE = "https://storage.googleapis.com/openimages/v5/validation-masks/validation-masks-"
UA = "ZoryaClassifierCorpus/2.0 (bounded public benchmark acquisition)"


def get(url: str, limit: int) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise ValueError(f"unexpected HTTP status {response.status}")
        raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError(f"response exceeds {limit} byte cap")
    return raw


def main() -> None:
    manifest = json.loads((CACHE / "photo-manifest.json").read_text())
    cases = manifest["caseMetadata"]
    truth_by_id = {}
    for split in ("dev", "heldout"):
        for item in json.loads((CACHE / f"ground-truth-{split}.json").read_text()):
            truth_by_id[item["caseId"]] = item
    csv_path = CACHE / "openimages-validation-masks.csv"
    raw = csv_path.read_bytes() if csv_path.exists() else get(CSV_URL, 4_000_000)
    csv_path.write_bytes(raw)
    mask_rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    wanted = {(c["imageId"], truth_by_id[c["caseId"]]["targetClassId"]): c
              for c in cases if truth_by_id[c["caseId"]]["expectedPresence"] == "present"}
    matching: dict[str, list[dict[str, str]]] = {}
    for index, row in enumerate(mask_rows, 2):
        case = wanted.get((row["ImageID"], row["LabelName"]))
        if case is not None:
            matching.setdefault(case["caseId"], []).append({**row, "sourceCsvRow": str(index)})
    needed_shards = sorted({case["imageId"][0].lower() for case in cases if case["caseId"] in matching})
    masks_dir = CACHE / "masks"
    masks_dir.mkdir(parents=True, exist_ok=True)
    source_shards = []
    for shard in needed_shards:
        zip_url = ZIP_BASE + shard + ".zip"
        zip_raw = get(zip_url, 25_000_000)
        source_shards.append({"shard": shard, "url": zip_url, "bytes": len(zip_raw),
                              "sha256": hashlib.sha256(zip_raw).hexdigest()})
        with zipfile.ZipFile(io.BytesIO(zip_raw)) as zf:
            archive_names = set(zf.namelist())
            for case in cases:
                if case["imageId"][0].lower() != shard:
                    continue
                rows = matching.get(case["caseId"], [])
                for row in rows:
                    name = row["MaskPath"]
                    if name not in archive_names:
                        raise ValueError(f"listed mask absent from official shard: {name}")
                    mask = zf.read(name)
                    out = masks_dir / name
                    out.write_bytes(mask)
                    row["localPath"] = str(out)
                    row["maskBytes"] = str(len(mask))
                    row["maskSha256"] = hashlib.sha256(mask).hexdigest()
    output = []
    for case in cases:
        if case["caseId"] not in matching:
            continue
        output.append({"caseId": case["caseId"], "targetClassId": truth_by_id[case["caseId"]]["targetClassId"],
                       "annotation": "Open Images V5 source mask; mask extent computed from reference binary PNG",
                       "sourceCsvRows": matching[case["caseId"]]})
    (CACHE / "mask-ground-truth.json").write_text(json.dumps({"schemaVersion": 1,
        "source": CSV_URL, "sourceCsvBytes": len(raw), "sourceCsvSha256": hashlib.sha256(raw).hexdigest(),
        "sourceLicense": "https://creativecommons.org/licenses/by/4.0/",
        "shards": source_shards, "cases": output}, ensure_ascii=False, indent=2) + "\n")
    ledger = json.loads((CACHE / "source-ledger.json").read_text())
    ledger["officialMasks"] = {"csvUrl": CSV_URL, "csvBytes": len(raw),
        "csvSha256": hashlib.sha256(raw).hexdigest(),
        "annotationLicense": "https://creativecommons.org/licenses/by/4.0/", "shards": source_shards}
    (CACHE / "source-ledger.json").write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"presentCases": sum(truth_by_id[c["caseId"]]["expectedPresence"] == "present" for c in cases),
        "officialMaskCases": len(output), "matchingMaskInstances": sum(len(x["sourceCsvRows"]) for x in output),
        "uniqueShards": len(needed_shards), "downloadBytes": sum(x["bytes"] for x in source_shards),
        "maskCsvBytes": len(raw)}, indent=2))


if __name__ == "__main__":
    main()
