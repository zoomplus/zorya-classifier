#!/usr/bin/env python3
"""Convert frozen Calculator source truth to evaluator-normalized truth rows.

The source wrapper is preserved; this writes a separate derived array using
matched producer dimensions and the original painted-button pixel geometry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from oracle import canonicalize_calculator_evaluator_truth


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-truth", type=Path, required=True)
    parser.add_argument("--producer-inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="new output path; never overwritten")
    args = parser.parse_args()
    source_bytes = args.source_truth.read_bytes()
    input_bytes = args.producer_inputs.read_bytes()
    rows = canonicalize_calculator_evaluator_truth(json.loads(source_bytes), json.loads(input_bytes))
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with args.output.open("xb") as stream:
        stream.write(payload)
    digest = hashlib.sha256(payload).hexdigest()
    print(json.dumps({
        "status": "derived",
        "caseCount": len(rows),
        "present": sum(row["expectedPresence"] == "present" for row in rows),
        "absent": sum(row["expectedPresence"] == "absent" for row in rows),
        "sourceTruthSha256": hashlib.sha256(source_bytes).hexdigest(),
        "producerInputsSha256": hashlib.sha256(input_bytes).hexdigest(),
        "derivedSha256": digest,
        "modelCalls": 0,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
