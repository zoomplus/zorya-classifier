#!/usr/bin/env python3
"""Audit a source-pinned Wesnoth A/B/A village-layer proof by hashes/counts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from oracle import read_png_rgb, sha256_file, wesnoth_project_village_support


EXPECTED_MAP_SHA256 = "41d2b65d3098c77c68d560832938c9e38bf2a549496e338cb158835ebbdff417"
MINIMAP_AREA = (856, 11, 160, 212)


def parse_map(path: Path) -> tuple[int, int, list[tuple[int, int]]]:
    rows = [line.split(", ") for line in path.read_text(encoding="utf-8").splitlines()]
    if not rows or len({len(row) for row in rows}) != 1:
        raise ValueError("source map is empty or nonrectangular")
    villages = [(column, row) for row, cells in enumerate(rows) for column, cell in enumerate(cells) if "^V" in cell]
    return len(rows[0]), len(rows), villages


def crop(width: int, pixels: bytes, area: tuple[int, int, int, int]) -> list[bytes]:
    x, y, w, h = area
    return [pixels[((y + dy) * width + x) * 3 : ((y + dy) * width + x + w) * 3] for dy in range(h)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("map", type=Path)
    parser.add_argument("before", type=Path)
    parser.add_argument("present", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--output", type=Path, help="optional new exclusive JSON receipt")
    args = parser.parse_args()
    map_hash = sha256_file(args.map)
    if map_hash != EXPECTED_MAP_SHA256:
        raise ValueError("proof map hash differs from the pinned official map")
    map_width, map_height, villages = parse_map(args.map)
    if (map_width, map_height, len(villages)) != (38, 38, 51):
        raise ValueError("pinned map dimensions or village count changed")
    frames = [read_png_rgb(path) for path in (args.before, args.present, args.after)]
    if len({(w, h) for w, h, _ in frames}) != 1:
        raise ValueError("A/B/A frame canvases differ")
    width, height, before = frames[0]
    _, _, middle = frames[1]
    _, _, after = frames[2]
    x, y, w, h = MINIMAP_AREA
    if (width, height) != (1024, 768) or crop(width, before, MINIMAP_AREA) != crop(width, after, MINIMAP_AREA):
        raise ValueError("A/A2 minimap crop is not stable at the pinned theme area")
    changed = {
        (px, py)
        for py in range(y, y + h)
        for px in range(x, x + w)
        if before[(py * width + px) * 3 : (py * width + px) * 3 + 3]
        != middle[(py * width + px) * 3 : (py * width + px) * 3 + 3]
    }
    support = wesnoth_project_village_support(
        villages,
        map_width=map_width,
        map_height=map_height,
        scale=24,
        area=MINIMAP_AREA,
    )
    receipt = {
        "scope": "excluded source-geometry proof only; not a corpus case",
        "mapSha256": map_hash,
        "mapCanvas": [map_width, map_height],
        "sourceVillageCount": len(villages),
        "themeArea": list(MINIMAP_AREA),
        "float32AccumulatedSampling": True,
        "beforeSha256": sha256_file(args.before),
        "presentSha256": sha256_file(args.present),
        "afterSha256": sha256_file(args.after),
        "aA2MinimapEqual": True,
        "changedPixels": len(changed),
        "projectedUnionPixels": len(support),
        "changedInsideProjectedUnion": len(changed & support),
        "changedOutsideProjectedUnion": len(changed - support),
        "projectedPixelsUnchanged": len(support - changed),
        "villagesIntersectingObservedDelta": sum(
            bool(
                changed
                & wesnoth_project_village_support(
                    [village], map_width=map_width, map_height=map_height, scale=24, area=MINIMAP_AREA
                )
            )
            for village in villages
        ),
    }
    if args.output:
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(receipt, stream, indent=2, sort_keys=True)
            stream.write("\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
