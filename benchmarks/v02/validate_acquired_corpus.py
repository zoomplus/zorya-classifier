#!/usr/bin/env python3
"""Offline structural audit for the fresh Open Images v0.2 photo corpus."""
from collections import Counter
from pathlib import Path
import csv
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "benchmarks/cache/v02/corpus"
SOURCE = Path("/root/work/zorya-classifier/benchmarks/corpus/source")
OLD = ROOT / "benchmarks/corpus/photo-manifest.json"


def sha(path: Path | bytes) -> str:
    data = path if isinstance(path, bytes) else path.read_bytes()
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    manifest = json.loads((CACHE / "photo-manifest.json").read_text())
    source = json.loads((CACHE / "source-ledger.json").read_text())
    inputs, truth, records = {}, {}, manifest["caseMetadata"]
    old = json.loads(OLD.read_text())["cases"]
    old_ids = {c["imageId"] for c in old}; old_sha = {c["sha256"] for c in old}
    old_groups = {c["authorGroup"].rstrip("/") for c in old}
    for split in ("dev", "heldout"):
        inputs[split] = json.loads((CACHE / f"inputs-{split}.json").read_text())
        truth[split] = json.loads((CACHE / f"ground-truth-{split}.json").read_text())
    assert len(records) == 60
    assert len({c["imageId"] for c in records}) == 60
    assert len({c["sha256"] for c in records}) == 60
    assert len({c["sourceGroup"] for c in records}) == 60
    assert not ({c["imageId"] for c in records} & old_ids)
    assert not ({c["sha256"] for c in records} & old_sha)
    assert not ({c["sourceGroup"].rstrip("/") for c in records} & old_groups)
    assert len(source["cases"]) == 60
    by_id = {c["caseId"]: c for c in records}
    for ledger_case in source["cases"]:
        case = by_id[ledger_case["caseId"]]
        assert ledger_case["sha256"] == case["sha256"] and ledger_case["imageId"] == case["imageId"]
        evidence_path = CACHE / "licenses" / f"{case['imageId']}.json"
        evidence = json.loads(evidence_path.read_text())
        assert sha(evidence_path) == case["license"]["evidenceSha256"]
        image_object = evidence["structuredData"]
        assert image_object["@type"] == "ImageObject" and image_object["license"] == "https://creativecommons.org/licenses/by/2.0/"
        assert image_object["acquireLicensePage"].rstrip("/").split("/")[-1] == evidence["flickrPhotoId"]
    assert {c["caseId"] for c in source["cases"]} == set(by_id)
    for split, expected in (("dev", (16, 4)), ("heldout", (30, 10))):
        assert len(inputs[split]) == expected[0] + expected[1]
        assert len(truth[split]) == len(inputs[split])
        assert sum(g["expectedPresence"] == "present" for g in truth[split]) == expected[0]
        assert sum(g["expectedPresence"] == "absent" for g in truth[split]) == expected[1]
        for inp, gt in zip(inputs[split], truth[split]):
            case = by_id[inp["caseId"]]
            assert inp["caseId"] == gt["caseId"] == case["caseId"]
            assert set(inp) == {"caseId", "image", "locate", "classify"}
            assert inp["image"]["sha256"] == case["sha256"]
            assert inp["image"]["path"] == str(CACHE / case["file"])
            assert inp["locate"]["target"] and inp["classify"]["options"] == ["present", "absent"]
            text = json.dumps(inp)
            for forbidden in ("sourceGroup", "targetBoxes", "negativeEvidence", "expectedPresence", "sourceCsvRow", "split"):
                assert forbidden not in text
            image = Path(inp["image"]["path"])
            assert image.stat().st_size == case["bytes"] and sha(image) == case["sha256"]
            if gt["expectedPresence"] == "present":
                assert gt["targetBoxes"] and not gt["negativeEvidence"]
            else:
                ev = gt["negativeEvidence"]
                assert not gt["targetBoxes"] and ev["source"] == "verification" and ev["confidence"] == 0
    with (SOURCE / "boxes.csv").open(newline="") as f:
        boxes = list(csv.DictReader(f))
    with (SOURCE / "labels.csv").open(newline="") as f:
        labels = list(csv.DictReader(f))
    for split in ("dev", "heldout"):
        for gt in truth[split]:
            if gt["expectedPresence"] == "present":
                for box in gt["targetBoxes"]:
                    row = boxes[box["sourceCsvRow"] - 2]
                    assert row["ImageID"] == by_id[gt["caseId"]]["imageId"]
                    assert row["LabelName"] == gt["targetClassId"]
                    assert [float(row[k]) for k in ("XMin", "YMin", "XMax", "YMax")] == box["xyxy"]
            else:
                ev = gt["negativeEvidence"]
                row = labels[ev["sourceCsvRow"] - 2]
                assert row["ImageID"] == by_id[gt["caseId"]]["imageId"]
                assert row["LabelName"] == gt["targetClassId"] and row["Confidence"] == "0"
                assert row["Source"] == "verification"
    mask_truth = json.loads((CACHE / "mask-ground-truth.json").read_text())
    mask_cases = {x["caseId"]: x for x in mask_truth["cases"]}
    masks = 0
    for split in ("dev", "heldout"):
        for gt in truth[split]:
            if not gt.get("referenceMasks"):
                continue
            assert gt["expectedPresence"] == "present"
            for mask in gt["referenceMasks"]:
                path = Path(mask["path"])
                assert path.exists() and sha(path) == mask["sha256"]
                assert [mask["width"], mask["height"]] == [by_id[gt["caseId"]]["width"], by_id[gt["caseId"]]["height"]]
                assert mask["maskExtentPixelsHalfOpen"][2] <= mask["width"]
                assert mask["maskExtentPixelsHalfOpen"][3] <= mask["height"]
                raw_mask = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path),
                                           "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                                          capture_output=True, timeout=12, check=True).stdout
                assert len(raw_mask) == mask["width"] * mask["height"]
                assert all(pixel in (0, 255) for pixel in raw_mask)
                masks += 1
    # Every input case is independently decoded by ffmpeg; no model is invoked.
    decodes = 0
    for c in records:
        result = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(CACHE / c["file"]),
                                 "-frames:v", "1", "-f", "null", "-"], capture_output=True, timeout=12)
        assert result.returncode == 0, (c["caseId"], result.stderr.decode(errors="replace"))
        decodes += 1
    published = ROOT / "benchmarks/v02/corpus/dev"
    pub_inputs = (published / "inputs.json").read_bytes()
    pub_truth = (published / "ground-truth.json").read_bytes()
    pub_ledger = (published / "source-ledger.json").read_bytes()
    pub_manifest = json.loads((published / "manifest.json").read_text())
    assert sha(pub_inputs) == pub_manifest["inputsSha256"]
    assert sha(pub_truth) == pub_manifest["groundTruthSha256"]
    assert sha(pub_ledger) == pub_manifest["sourceLedgerSha256"]
    public_inputs = json.loads(pub_inputs)
    public_truth = json.loads(pub_truth)
    assert len(public_inputs) == len(public_truth) == 20
    assert all(set(case) == {"caseId", "image", "locate", "classify"} for case in public_inputs)
    assert all(not Path(case["image"]["path"]).is_absolute() for case in public_inputs)
    assert all(case["image"]["path"].startswith("benchmarks/cache/v02/corpus/") for case in public_inputs)
    assert pub_manifest["present"] == 16 and pub_manifest["absent"] == 4
    report = {"status": "passed", "scope": "source rows, byte/license/source-group separation, negative evidence, image decode; not human reviewer adjudication or model accuracy",
        "photos": 60, "dev": {"present": 16, "absent": 4}, "heldout": {"present": 30, "absent": 10},
        "independentSourceGroups": len({c["sourceGroup"] for c in records}), "oldCorpusIDsHashesGroupsExcluded": True,
        "officialMaskCases": len(mask_cases), "officialMaskInstances": masks, "jpegDecodes": decodes,
        "modelCalls": 0, "inputDevSha256": sha(CACHE / "inputs-dev.json"),
        "inputHeldoutSha256": sha(CACHE / "inputs-heldout.json"),
        "devTruthSha256": sha(CACHE / "ground-truth-dev.json"),
        "publishedDevInputSha256": sha(published / "inputs.json"),
        "publishedDevTruthSha256": sha(published / "ground-truth.json"),
        "publishedDevLedgerSha256": sha(published / "source-ledger.json")}
    (CACHE / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAILED {type(error).__name__}: {error}", file=sys.stderr)
        raise
