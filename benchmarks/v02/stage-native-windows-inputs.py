#!/usr/bin/env python3
"""Stage only the reviewed dev photo fixtures and pinned CPU model into a WSL-visible WinTemp."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_MANIFEST = ROOT / "benchmarks/v02/native-dev-photo-fixtures.json"
MODEL_DIR = Path("/root/work/zorya-worktrees/locator-segmentation-model/.run/segmentation-model/models")
ASSETS = {
    "mobile_sam_image_encoder.onnx": (28_157_093, "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749"),
    "sam_mask_decoder_multi.onnx": (16_496_559, "8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe"),
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify_copy(source: Path, target: Path, expected_size: int, expected_hash: str) -> None:
    if source.stat().st_size != expected_size or sha256(source) != expected_hash:
        raise SystemExit(f"Refusing unverified input: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.stat().st_size != expected_size or sha256(target) != expected_hash:
            raise SystemExit(f"Existing staged file differs; refusing overwrite: {target}")
    else:
        shutil.copyfile(source, target)
    if target.stat().st_size != expected_size or sha256(target) != expected_hash:
        raise SystemExit(f"Staged file did not verify: {target}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, type=Path, help="Unique /mnt/c/.../zorya-classifier-v02-native-* directory")
    parser.add_argument("--archive", type=Path, help="Optional already-produced npm .tgz archive")
    parser.add_argument("--sha256", help="Required with --archive")
    args = parser.parse_args()
    target = args.target.resolve()
    if not str(target).startswith("/mnt/c/") or not target.name.startswith("zorya-classifier-v02-native-"):
        raise SystemExit("Target must be a uniquely named native-v02 folder beneath /mnt/c")
    if args.archive is not None:
        if not args.sha256 or len(args.sha256) != 64 or any(c not in "0123456789abcdef" for c in args.sha256):
            raise SystemExit("--archive requires a lowercase SHA-256 in --sha256")
        archive_hash = sha256(args.archive)
        if archive_hash != args.sha256:
            raise SystemExit("Package archive hash does not match --sha256")
        verify_copy(args.archive, target / "verified-package.tgz", args.archive.stat().st_size, archive_hash)
    elif args.sha256:
        raise SystemExit("--sha256 is valid only with --archive")

    for filename, (size, checksum) in ASSETS.items():
        verify_copy(MODEL_DIR / filename, target / "weights" / filename, size, checksum)

    rows = json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))
    expected_ids = {
        "photo-dev-present-06",
        "photo-dev-present-08",
        "photo-dev-present-09",
        "photo-dev-present-13",
        "photo-dev-present-15",
    }
    if {row.get("id") for row in rows} != expected_ids or len(rows) != len(expected_ids):
        raise SystemExit("Dev manifest is not the expected five-case allowlist")
    staged_rows = []
    for row in rows:
        image_source = (FIXTURE_MANIFEST.parent / row["imagePath"]).resolve()
        image_name = image_source.name
        image_target = target / "fixtures" / "images" / image_name
        verify_copy(image_source, image_target, image_source.stat().st_size, row["sha256"])
        staged = dict(row)
        staged["imagePath"] = f"images/{image_name}"
        mask_source = (FIXTURE_MANIFEST.parent / row["referenceMaskPath"]).resolve()
        mask_name = mask_source.name
        mask_target = target / "fixtures" / "masks" / mask_name
        verify_copy(mask_source, mask_target, mask_source.stat().st_size, row["referenceMaskSha256"])
        staged["referenceMaskPath"] = f"masks/{mask_name}"
        staged_rows.append(staged)
    manifest_path = target / "fixtures" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(staged_rows, ensure_ascii=False, indent=2) + "\n"
    if manifest_path.exists() and manifest_path.read_text(encoding="utf-8") != content:
        raise SystemExit(f"Existing fixture manifest differs; refusing overwrite: {manifest_path}")
    manifest_path.write_text(content, encoding="utf-8")
    runner = target / "native-windows-acceptance.mjs"
    source_runner = ROOT / "benchmarks/v02/native-windows-acceptance.mjs"
    shutil.copyfile(source_runner, runner)
    print(json.dumps({
        "target": str(target),
        "photos": len(staged_rows),
        "heldout": 0,
        "fixturesManifest": str(manifest_path),
        "assets": {name: {"bytes": size, "sha256": checksum} for name, (size, checksum) in ASSETS.items()},
        "archive": str(target / "verified-package.tgz") if args.archive else None,
    }, indent=2))


if __name__ == "__main__":
    main()
