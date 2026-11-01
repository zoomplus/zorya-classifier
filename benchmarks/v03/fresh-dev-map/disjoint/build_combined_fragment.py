#!/usr/bin/env python3
"""Combine two exported native map fragments in their registered order."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from fragment_tools import (
    create_new_output_dir,
    external_study_root,
    repository_root_from_file,
    study_input,
    write_immutable_json,
)

ORDER_SHA256 = "e0a5079820961fa1ece2aa8931d5f229a0706dd35f08c202036de8e718e7b479"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load(path: Path):
    return json.loads(path.read_text())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study-root", required=True, help="absolute external study/artifact root")
    parser.add_argument("--output-dir", required=True, help="absolute new directory below --study-root")
    parser.add_argument("--xsok-fragment", required=True, help="fragment directory relative to --study-root")
    parser.add_argument("--gnurobbo-fragment", required=True, help="fragment directory relative to --study-root")
    args = parser.parse_args()
    repo = repository_root_from_file(__file__)
    study = external_study_root(args.study_root, repo)
    xsok = study_input(study, args.xsok_fragment)
    gnurobbo = study_input(study, args.gnurobbo_fragment)
    if not xsok.is_dir() or not gnurobbo.is_dir():
        raise ValueError("family fragment arguments must identify directories")
    output = create_new_output_dir(study, args.output_dir, repo)
    sys.path.insert(0, str(repo / "benchmarks/v03/fresh-dev"))
    import imaging

    order_path = study_input(study, "integration/registered-map-order-r2.json")
    order = load(order_path)
    assert sha(order_path.read_bytes()) == ORDER_SHA256
    assert order["parentProtocolSha256"] == "f059bd6b4bfe91ea90d8d2bb1a63ce324048d732fe96fafff1b941c462c87294"
    directories = [xsok, gnurobbo]
    rows = []
    annotations = []
    paths = {}
    provenance = {}
    frames = []
    for directory in directories:
        relative = directory.relative_to(study)
        rows.extend(load(study_input(study, relative / "producer-input-rows.json")))
        annotations.extend(load(study_input(study, relative / "evaluator-private-annotations.json")))
        paths.update(load(study_input(study, relative / "controller-path-index.json")))
        provenance.update(load(study_input(study, relative / "curator-source-provenance.json")))
        frames.extend(load(study_input(study, relative / "frame-fingerprints.json"))["frames"])

    registered_ids = [item["opaqueCaseId"] for item in order["rows"]]
    assert [item["opaqueCaseId"] for item in rows] == registered_ids
    assert [item["opaqueCaseId"] for item in annotations] == registered_ids
    assert list(paths) == registered_ids
    assert list(provenance) == registered_ids
    assert [item["id"] for item in frames] == registered_ids
    assert sum(item["expectedPresence"] == "present" for item in annotations) == 7
    assert sum(item["expectedPresence"] == "absent" for item in annotations) == 3
    expected_annotation_keys = [
        "opaqueCaseId", "stratum", "sourceGroup", "expectedPresence", "referenceBoxes",
        "referenceMasks", "exactOriginalCanvasMaskRef",
    ]
    if any(list(item) != expected_annotation_keys for item in annotations):
        raise ValueError("evaluator annotation fields/order do not match the strict closed schema")

    inherited_path = study_input(study, "inherited-dev-frame-fingerprints.json")
    inherited = load(inherited_path)
    compare = inherited["frames"] + frames
    nearest = {}
    for frame in frames:
        exact_encoded = [item["id"] for item in compare if item["id"] != frame["id"] and item["encodedSha256"] == frame["encodedSha256"]]
        exact_rgb = [item["id"] for item in compare if item["id"] != frame["id"] and item["decodedRgbSha256"] == frame["decodedRgbSha256"]]
        distances = sorted((imaging.hamming_distance64(int(frame["perceptualHash"], 16), int(other["perceptualHash"], 16)), other["id"]) for other in compare if other["id"] != frame["id"])
        if exact_encoded or exact_rgb or distances[0][0] <= 4:
            raise ValueError(f"combined duplicate rejection for {frame['id']}: {exact_encoded} {exact_rgb} {distances[0]}")
        nearest[frame["id"]] = {"hamming": distances[0][0], "referenceId": distances[0][1]}

    files = {
        "producer-input-rows.json": rows,
        "evaluator-private-annotations.json": annotations,
        "controller-path-index.json": paths,
        "curator-source-provenance.json": provenance,
        "frame-fingerprints.json": {
            "algorithm": inherited["algorithm"],
            "inheritedFingerprintsSha256": sha(inherited_path.read_bytes()),
            "cutoffInclusiveHamming": 4,
            "frames": frames,
            "nearestReferenceDistances": nearest,
        },
    }
    for filename, value in files.items():
        write_immutable_json(output, filename, value)
    receipt = {
        "schema": "private-dev-source-fragment-v1",
        "notPhaseFreeze": True,
        "modelCalls": 0,
        "caseCount": 10,
        "positiveCases": 7,
        "negativeCases": 3,
        "maskCount": 0,
        "sourceGroupCounts": {"map": 2},
        "familySlugs": ["xsok", "gnurobbo"],
        "registeredOrderSha256": sha(order_path.read_bytes()),
        "xsokFragmentReceiptSha256": sha(study_input(study, xsok.relative_to(study) / "fragment-receipt.json").read_bytes()),
        "gnurobboFragmentReceiptSha256": sha(study_input(study, gnurobbo.relative_to(study) / "fragment-receipt.json").read_bytes()),
        "duplicateAuditSha256": sha((output / "frame-fingerprints.json").read_bytes()),
        "sha256": {name: sha((output / name).read_bytes()) for name in files if name != "frame-fingerprints.json"},
    }
    write_immutable_json(output, "fragment-receipt.json", receipt)
    print(json.dumps({"path": str(output), "receipt": receipt, "nearestReferenceDistances": nearest}, indent=2))


if __name__ == "__main__":
    main()
