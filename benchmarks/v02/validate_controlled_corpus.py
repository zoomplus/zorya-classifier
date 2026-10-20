#!/usr/bin/env python3
"""Validate the controlled map/UI supplement manifests and local image bytes."""
from collections import Counter
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "benchmarks/cache/v02/corpus/controlled"
DEV = ROOT / "benchmarks/v02/corpus/dev-controlled"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(directory: Path, split: str, published: bool) -> dict:
    manifest = json.loads((directory / "manifest.json").read_text())
    inputs = json.loads((directory / "inputs.json").read_text())
    truth = json.loads((directory / "ground-truth.json").read_text())
    ledger = json.loads((directory / "source-ledger.json").read_text())
    assert manifest["split"] == split and manifest["stratum"] == "controlled-only-supplement"
    assert manifest["cases"] == len(inputs) == len(truth) == len(ledger["cases"])
    assert digest(directory / "inputs.json") == manifest["inputsSha256"]
    assert digest(directory / "ground-truth.json") == manifest["groundTruthSha256"]
    assert digest(directory / "source-ledger.json") == manifest["sourceLedgerSha256"]
    assert all(set(x) == {"caseId", "image", "locate", "classify"} for x in inputs)
    assert len({x["caseId"] for x in inputs}) == len(inputs)
    assert {x["caseId"] for x in inputs} == {x["caseId"] for x in truth} == {x["caseId"] for x in ledger["cases"]}
    assert len({x["sourceGroup"] for x in ledger["cases"]}) == 2
    count = Counter()
    by_id = {x["caseId"]: x for x in ledger["cases"]}
    for item, gt in zip(inputs, truth):
        rec = by_id[item["caseId"]]
        path = Path(item["image"]["path"])
        if published:
            assert not path.is_absolute() and str(path).startswith("benchmarks/cache/v02/corpus/controlled/")
            path = ROOT / path
        assert path.exists() and digest(path) == item["image"]["sha256"] == rec["sha256"]
        assert [item["image"]["width"], item["image"]["height"]] == [1280, 900]
        assert item["classify"]["options"] == ["present", "absent"]
        assert rec["split"] == split
        assert gt["sourceGroup"] == rec["sourceGroup"]
        assert gt["expectedPresence"] in ("present", "absent")
        count[("ui" if rec["appOrGame"].startswith("ui-") else "map", gt["expectedPresence"])] += 1
        if gt["expectedPresence"] == "present":
            assert len(gt["targetBoxes"]) == 1 and gt["negativeEvidence"] is None
            box = gt["targetBoxes"][0]
            assert len(box["pixelXYXY"]) == 4
            assert box["source"] == "model-assisted-independent-visual-annotation"
            assert all(0 <= x <= 1 for x in box["xyxy"])
            assert box["xyxy"] == [box["pixelXYXY"][0] / 1280, box["pixelXYXY"][1] / 900, box["pixelXYXY"][2] / 1280, box["pixelXYXY"][3] / 900]
        else:
            assert not gt["targetBoxes"] and gt["negativeEvidence"]["confidence"] == 0
            assert "complete-image-review" in gt["negativeEvidence"]["source"]
        producer = json.dumps({"locate": item["locate"], "classify": item["classify"]})
        for forbidden in ("sourceGroup", "expectedPresence", "negativeEvidence", "ground-truth", "source-ledger", "heldout", "split"):
            assert forbidden not in producer
    expected = {("ui", "present"): 7, ("ui", "absent"): 3, ("map", "present"): 7, ("map", "absent"): 3} if split == "dev" else {("ui", "present"): 15, ("ui", "absent"): 5, ("map", "present"): 15, ("map", "absent"): 5}
    assert dict(count) == expected, (dict(count), expected)
    for source in ledger["sources"] + ledger["harnessComponents"]:
        p = Path(source["evidencePath"])
        assert p.exists() and digest(p) == source["evidenceSha256"]
    return {"split": split, "counts": {f"{k[0]}-{k[1]}": v for k, v in sorted(count.items())}, "groups": len({x["sourceGroup"] for x in ledger["cases"]}), "cases": len(inputs)}


def main() -> None:
    print(json.dumps({"scope": "controlled supplement structural check; not natural-image qualification or annotation adjudication", "dev": audit(DEV, "dev", True), "heldout": audit(CACHE / "heldout-controlled", "heldout", False)}, indent=2))


if __name__ == "__main__":
    main()
