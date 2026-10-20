#!/usr/bin/env python3
"""Materialize the acquired dev-only photo artifacts for review and regression use."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "benchmarks/cache/v02/corpus"
DEST = ROOT / "benchmarks/v02/corpus/dev"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((CACHE / "photo-manifest.json").read_text())
    ledger = json.loads((CACHE / "source-ledger.json").read_text())
    source_by_id = {c["caseId"]: c for c in ledger["cases"]}
    cases = [c for c in manifest["caseMetadata"] if c["split"] == "dev"]
    inputs = json.loads((CACHE / "inputs-dev.json").read_text())
    truth = json.loads((CACHE / "ground-truth-dev.json").read_text())
    for item in inputs:
        case = next(c for c in cases if c["caseId"] == item["caseId"])
        item["image"]["path"] = f"benchmarks/cache/v02/corpus/{case['file']}"
    for item in truth:
        for mask in item.get("referenceMasks", []):
            mask["path"] = "benchmarks/cache/v02/corpus/masks-source-size/" + Path(mask["path"]).name
    input_bytes = (json.dumps(inputs, ensure_ascii=False, indent=2) + "\n").encode()
    truth_bytes = (json.dumps(truth, ensure_ascii=False, indent=2) + "\n").encode()
    (DEST / "inputs.json").write_bytes(input_bytes)
    (DEST / "ground-truth.json").write_bytes(truth_bytes)

    source_meta = json.loads((CACHE / "source-ledger.json").read_text())
    mask_meta = source_meta.get("officialMasks", {})
    dev_masks = json.loads((CACHE / "mask-ground-truth.json").read_text())
    dev_case_ids = {c["caseId"] for c in cases}
    dev_mask_image_ids = {m["MaskPath"][:16] for c in dev_masks["cases"]
                          if c["caseId"] in dev_case_ids for m in c["sourceCsvRows"]}
    dev_shards = [s for s in mask_meta.get("shards", []) if s["shard"] in {x[0].lower() for x in dev_mask_image_ids}]
    public_ledger = {
        "schemaVersion": 1,
        "annotationDataset": "Open Images V5 validation",
        "annotationLicense": "https://creativecommons.org/licenses/by/4.0/",
        "annotationSources": source_meta["annotationSources"],
        "maskSource": {"csvUrl": mask_meta.get("csvUrl"), "csvBytes": mask_meta.get("csvBytes"),
                       "csvSha256": mask_meta.get("csvSha256"), "shards": dev_shards},
        "excludedV1": source_meta["excludedV1"],
        "cases": [],
    }
    for case in cases:
        source_case = source_by_id[case["caseId"]]
        evidence_path = CACHE / "licenses" / f"{case['imageId']}.json"
        evidence = json.loads(evidence_path.read_text())
        public_ledger["cases"].append({
            "caseId": case["caseId"], "imageId": case["imageId"], "sha256": case["sha256"],
            "bytes": case["bytes"], "sourceGroup": case["sourceGroup"], "source": source_case["source"],
            "license": source_case["license"],
            "licensePageEvidence": {k: evidence[k] for k in ("sourceUrl", "resolvedUrl", "httpStatus", "checkedAt",
                "sourcePageBytes", "sourcePageSha256", "extraction", "structuredData", "structuredBlockSha256",
                "verifiedLicenseUrl", "flickrPhotoId", "rawPagePersisted")},
        })
    ledger_bytes = (json.dumps(public_ledger, ensure_ascii=False, indent=2) + "\n").encode()
    (DEST / "source-ledger.json").write_bytes(ledger_bytes)
    (DEST / "manifest.json").write_text(json.dumps({
        "schemaVersion": 1,
        "status": "dev-photo-only",
        "caseCount": len(cases),
        "present": sum(c["expectedPresence"] == "present" for c in truth),
        "absent": sum(c["expectedPresence"] == "absent" for c in truth),
        "officialMaskCases": sum(bool(c.get("referenceMasks")) for c in truth),
        "officialMaskInstances": sum(len(c.get("referenceMasks", [])) for c in truth),
        "inputsSha256": sha(input_bytes), "groundTruthSha256": sha(truth_bytes),
        "sourceLedgerSha256": sha(ledger_bytes), "modelsInvoked": 0,
        "assets": "benchmarks/cache/v02/corpus (gitignored; not part of the MIT archive)",
    }, indent=2) + "\n")
    print(json.dumps(json.loads((DEST / "manifest.json").read_text()), indent=2))


if __name__ == "__main__":
    main()
