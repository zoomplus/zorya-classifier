#!/usr/bin/env python3
"""Normalize selected Open Images source masks to the exact acquired JPEG raster."""
from pathlib import Path
import hashlib
import json
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "benchmarks/cache/v02/corpus"


def dimensions(path: Path) -> tuple[int, int]:
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        raise ValueError(f"invalid PNG: {path.name}")
    return struct.unpack(">II", raw[16:24])


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    manifest = json.loads((CACHE / "photo-manifest.json").read_text())
    source_meta = {c["caseId"]: c for c in manifest["caseMetadata"]}
    truth = {}
    for split in ("dev", "heldout"):
        path = CACHE / f"ground-truth-{split}.json"
        truth[split] = json.loads(path.read_text())
    masks_manifest = json.loads((CACHE / "mask-ground-truth.json").read_text())
    normalized_dir = CACHE / "masks-source-size"
    normalized_dir.mkdir(parents=True, exist_ok=True)
    for split in ("dev", "heldout"):
        for item in truth[split]:
            candidates = next((c["sourceCsvRows"] for c in masks_manifest["cases"]
                               if c["caseId"] == item["caseId"]), None)
            if not candidates:
                continue
            # Keep the explicitly annotated target instance matching one of the Open Images boxes.
            wanted_rows = {b["sourceCsvRow"] for b in item["targetBoxes"]}
            eligible = [x for x in candidates if int(x["sourceCsvRow"]) in wanted_rows]
            if not eligible:
                # A source mask may use an associated Mask Box ID rather than the box CSV row.
                # In this case its exact target class and same-image identity still ground it;
                # retain each instance separately rather than forcing a one-mask match.
                eligible = candidates
            outputs = []
            for index, row in enumerate(eligible, 1):
                source = Path(row["localPath"])
                mask_w, mask_h = dimensions(source)
                photo = source_meta[item["caseId"]]
                width, height = photo["width"], photo["height"]
                out = normalized_dir / f"{item['caseId']}-{index:02d}.png"
                vf = f"scale={width}:{height}:flags=neighbor,format=gray"
                subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(source),
                                "-vf", vf, "-frames:v", "1", str(out)], check=True, timeout=15)
                decoded = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(out),
                                          "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                                         check=True, capture_output=True, timeout=15).stdout
                if len(decoded) != width * height or any(pixel not in (0, 255) for pixel in decoded):
                    raise ValueError(f"normalized source mask is not binary: {out.name}")
                xs, ys = [], []
                for y in range(height):
                    row_start = y * width
                    for x, value in enumerate(decoded[row_start:row_start + width]):
                        if value:
                            xs.append(x); ys.append(y)
                if not xs:
                    raise ValueError(f"empty annotated positive mask: {out.name}")
                outputs.append({"path": str(out), "sha256": sha(out), "bytes": out.stat().st_size,
                    "width": width, "height": height, "sourceMaskPath": row["MaskPath"],
                    "sourceMaskSha256": row["maskSha256"], "sourceMaskDimensions": [mask_w, mask_h],
                    "maskExtentPixelsHalfOpen": [min(xs), min(ys), max(xs) + 1, max(ys) + 1],
                    "maskExtentNormalized": [min(xs) / width, min(ys) / height,
                                             (max(xs) + 1) / width, (max(ys) + 1) / height],
                    "resampling": "nearest-neighbor to the acquired Open Images JPEG raster; verified 0/255 binary values"})
            item["referenceMasks"] = outputs
        (CACHE / f"ground-truth-{split}.json").write_text(json.dumps(truth[split], ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"casesWithMasks": sum(bool(x.get("referenceMasks")) for split in truth for x in truth[split]),
        "maskInstances": sum(len(x.get("referenceMasks", [])) for split in truth for x in truth[split]),
        "normalization": "exact acquired JPEG raster, nearest-neighbor, binary verified"}, indent=2))


if __name__ == "__main__":
    main()
