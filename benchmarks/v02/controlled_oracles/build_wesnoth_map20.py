#!/usr/bin/env python3
"""Build a private 15-positive/5-negative controlled Wesnoth map cohort.

The source maps are shipped with Wesnoth 1.16.11 under GPL-2-or-later. For
each positive case, a deterministic source-only rule selects the median
row-major village from one frozen official map and removes other village
overlays. The actual minimap layer is toggled off/on/off in three owned
map-editor launches. Ground-truth boxes come only from the repeatable
screen-pixel delta and are checked against the source-derived float32
projection. Negatives remove every village overlay and require a pixel-stable
minimap across the same layer toggle. No model calls are made.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

from oracle import read_png_rgb, sha256_file, wesnoth_project_village_support


MAP_ROOT = Path("/usr/share/games/wesnoth/1.16/data/multiplayer/maps")
CAPTURE = Path(__file__).with_name("capture_wesnoth_editor.py")
MAP_VERSION = "1.16.11"
SCREEN_WIDTH = 1024
SCREEN_HEIGHT = 768
MINIMAP_AREA = (856, 11, 160, 212)
TARGET = "village marker in the minimap"
INSTRUCTION = "Locate the visible physical instance of the named object; return unknown when unsupported."
QUESTION = "Does the minimap show a village marker?"

POSITIVE_MAPS = (
    "2p_Clearing_Gushes.map",
    "2p_Den_of_Onis.map",
    "2p_Elensefar_Courtyard.map",
    "2p_Hamlets.map",
    "2p_Hornshark_Island.map",
    "2p_Howling_Ghost_Badlands.map",
    "2p_Isle_of_Mists_basic.map",
    "2p_Ruphus_Isle.map",
    "2p_Sablestone_Delta.map",
    "2p_Silverhead_Crossing.map",
    "2p_Sullas_Ruins.map",
    "2p_Swamp_of_Dread.map",
    "2p_The_Freelands.map",
    "2p_The_Walls_of_Pyrennis.map",
    "2p_Thousand_Stings_Garrison.map",
)
NEGATIVE_MAPS = (
    "2p_Tombs_of_Kesorak.map",
    "2p_Weldyn_Channel.map",
    "3p_Alirok_Marsh.map",
    "3p_Island_of_the_Horatii.map",
    "3p_Morituri.map",
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_exclusive(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def parse_map(path: Path) -> tuple[list[str], list[list[str]]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError(f"empty map {path.name}")
    rows = [line.split(", ") for line in lines]
    if len({len(row) for row in rows}) != 1:
        raise ValueError(f"nonrectangular map {path.name}")
    if len(rows) < 3 or len(rows[0]) < 3:
        raise ValueError(f"map lacks the expected one-cell border: {path.name}")
    return lines, rows


def without_village(token: str) -> str:
    if "^V" not in token:
        return token
    base, suffix = token.split("^V", 1)
    # Official map data uses one village overlay per terrain token. Refuse an
    # unexpected combined overlay rather than silently rewriting it.
    if "^" in suffix:
        raise ValueError(f"unsupported combined village overlay {token!r}")
    return base


def derive_map(source: Path, output: Path, selected: tuple[int, int] | None) -> dict[str, Any]:
    raw = source.read_bytes()
    lines, rows = parse_map(source)
    villages = [(r, c) for r, row in enumerate(rows) for c, cell in enumerate(row) if "^V" in cell]
    if selected is not None and selected not in villages:
        raise ValueError("selected source village is not present")
    if selected is not None:
        r, c = selected
        if not (1 <= r < len(rows) - 1 and 1 <= c < len(rows[0]) - 1):
            raise ValueError("selected source village is in the map border")
    rewritten = [[without_village(cell) for cell in row] for row in rows]
    if selected is not None:
        r, c = selected
        rewritten[r][c] = rows[r][c]
    text = "\n".join(", ".join(row) for row in rewritten) + "\n"
    output.write_text(text, encoding="utf-8")
    rewritten_lines = text.splitlines()
    rewritten_rows = [line.split(", ") for line in rewritten_lines]
    remaining = [(r, c) for r, row in enumerate(rewritten_rows) for c, cell in enumerate(row) if "^V" in cell]
    if remaining != ([] if selected is None else [selected]):
        raise ValueError("derived map village inventory does not match the frozen selector")
    return {
        "sourceMapName": source.name,
        "sourceMapSha256": sha256_bytes(raw),
        "derivedMapSha256": sha256_file(output),
        "rawRows": len(rows),
        "rawColumns": len(rows[0]),
        "sourceVillageCount": len(villages),
        "remainingVillageCount": len(remaining),
        "selectedRawRowColumn": list(selected) if selected is not None else None,
        "selectionRule": "median row-major ^V source cell" if selected is not None else "remove every ^V overlay from the pinned map",
    }


def run_phase(map_file: Path, case_dir: Path, phase: str, villages: str, wait: float) -> dict[str, Any]:
    phase_dir = case_dir / phase
    command = [
        "xvfb-run",
        "-a",
        "-s",
        "-screen 0 1024x768x24 -nolisten tcp",
        sys.executable,
        str(CAPTURE),
        str(map_file),
        str(phase_dir),
        "--villages",
        villages,
        "--wait",
        str(wait),
    ]
    log_path = case_dir / f"{phase}-capture-launch.log"
    with log_path.open("xb") as log:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            process.wait(timeout=35)
            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, command)
        except subprocess.TimeoutExpired:
            # This process group contains only this phase's owned Xvfb,
            # helper and Wesnoth child. Reap it together if helper cleanup
            # cannot run because the parent hard timeout fired.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            raise
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
    metadata = json.loads((phase_dir / "capture.json").read_text(encoding="utf-8"))
    if metadata["mapSha256"] != sha256_file(map_file):
        raise ValueError("capture helper rendered a different map asset")
    return metadata


def crop_rows(rgb: bytes, width: int, crop: tuple[int, int, int, int]) -> list[bytes]:
    x, y, crop_width, crop_height = crop
    return [rgb[((y + row) * width + x) * 3 : ((y + row) * width + x + crop_width) * 3] for row in range(crop_height)]


def delta_pixels(before: tuple[int, int, bytes], present: tuple[int, int, bytes], after: tuple[int, int, bytes]) -> set[tuple[int, int]]:
    if before[:2] != present[:2] or before[:2] != after[:2]:
        raise ValueError("A/B/A screenshot dimensions differ")
    width, height, first = before
    _, _, middle = present
    _, _, last = after
    x, y, crop_width, crop_height = MINIMAP_AREA
    if x + crop_width > width or y + crop_height > height:
        raise ValueError("theme-pinned minimap area exceeds screenshot canvas")
    if crop_rows(first, width, MINIMAP_AREA) != crop_rows(last, width, MINIMAP_AREA):
        raise ValueError("A/A2 minimap pixels are not identical")
    return {
        (px, py)
        for py in range(y, y + crop_height)
        for px in range(x, x + crop_width)
        if first[(py * width + px) * 3 : (py * width + px) * 3 + 3]
        != middle[(py * width + px) * 3 : (py * width + px) * 3 + 3]
    }


def bbox(points: set[tuple[int, int]]) -> tuple[int, int, int, int]:
    if not points:
        raise ValueError("empty pixel set has no visible bounding box")
    return min(x for x, _ in points), min(y for _, y in points), max(x for x, _ in points) + 1, max(y for _, y in points) + 1


def build_case(output: Path, index: int, source: Path, presence: str, wait: float) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    case_id = f"wesnoth-map-{presence}-{index:02d}"
    case_dir = output / "captures" / case_id
    case_dir.mkdir(parents=True, exist_ok=False)
    _, rows = parse_map(source)
    villages = [(r, c) for r, row in enumerate(rows) for c, cell in enumerate(row) if "^V" in cell]
    selected = sorted(villages)[len(villages) // 2] if presence == "present" else None
    derived = output / "derived-maps" / f"{case_id}.map"
    derived.parent.mkdir(exist_ok=True)
    source_record = derive_map(source, derived, selected)
    phases = (
        ("a", "no"),
        ("b", "yes"),
        ("a2", "no"),
    )
    capture_records = [run_phase(derived, case_dir, phase, pref, wait) for phase, pref in phases]
    frames = [
        read_png_rgb(case_dir / phase / "screen.png")
        for phase in ("a", "b", "a2")
    ]
    changed = delta_pixels(frames[0], frames[1], frames[2])
    if presence == "present":
        if not changed:
            raise ValueError(f"source-positive case produced no visible minimap marker: {case_id}")
        assert selected is not None
        expected = wesnoth_project_village_support(
            [(selected[1], selected[0])],
            map_width=len(rows[0]),
            map_height=len(rows),
            scale=24,
            area=MINIMAP_AREA,
        )
        outside = changed - expected
        if outside:
            raise ValueError(f"pixel delta escaped source-derived marker support in {case_id}")
        box = bbox(changed)
        gt = {
            "caseId": case_id,
            "expectedPresence": "present",
            "targetClassId": "wesnoth-village-marker",
            "targetBoxes": [
                {
                    "className": "wesnoth-village-marker",
                    "pixelXYXY": list(box),
                    "xyxy": [box[0] / SCREEN_WIDTH, box[1] / SCREEN_HEIGHT, box[2] / SCREEN_WIDTH, box[3] / SCREEN_HEIGHT],
                    "source": "Actual A/B/A village-layer pixel delta, constrained by the source-derived Wesnoth 1.16.11 float32 minimap projection; visible-body bbox only.",
                }
            ],
            "negativeEvidence": None,
            "annotationSource": "Independent controlled renderer oracle: official map source state, real Wesnoth map editor, source-derived minimap transform, repeated A/B/A pixels; no human or model-derived box.",
            "sourceGroup": f"controlled-wesnoth-map:{source.stem}",
            "sceneStratum": "controlled-real-game-map",
        }
        evidence = {
            "positivePixelDeltaCount": len(changed),
            "projectedSourceSupportCount": len(expected),
            "changedPixelsOutsideProjectedSupport": 0,
            "projectedSupportPixelsUnchanged": len(expected - changed),
            "visiblePixelBox": list(box),
        }
    else:
        if changed:
            raise ValueError(f"source-negative map produced a village-layer pixel delta in {case_id}")
        gt = {
            "caseId": case_id,
            "expectedPresence": "absent",
            "targetClassId": "wesnoth-village-marker",
            "targetBoxes": [],
            "negativeEvidence": {
                "source": "Complete derived map_data scan found zero ^V overlays; actual map-editor minimap was pixel-identical with the village layer toggled off/on/off.",
                "confidence": 1.0,
            },
            "annotationSource": "Independent controlled game state plus stable source-layer pixel oracle; no model-derived absence.",
            "sourceGroup": f"controlled-wesnoth-map:{source.stem}",
            "sceneStratum": "controlled-real-game-map",
        }
        evidence = {"negativePixelDeltaCount": 0, "completeMapVillageCount": 0}
    image_path = case_dir / "b" / "screen.png"
    width, height, _ = frames[1]
    inputs = {
        "caseId": case_id,
        "image": {"path": f"map/{case_id}.png", "sha256": sha256_file(image_path), "width": width, "height": height},
        "locate": {"target": TARGET, "instruction": INSTRUCTION},
        "classify": {"question": QUESTION, "options": ["present", "absent"]},
    }
    source_record.update(
        {
            "caseId": case_id,
            "sourceMapPath": str(source),
            "derivedMapPath": str(derived),
            "derivedMapRows": len(rows),
            "derivedMapColumns": len(rows[0]),
            "capturePhases": [
                {
                    "phase": name,
                    "villagesPreference": pref,
                    "screenshotSha256": record["screenshotSha256"],
                    "preferenceSha256": record["preferenceSha256"],
                    "ownedGamePid": record["ownedGamePid"],
                }
                for (name, pref), record in zip(phases, capture_records, strict=True)
            ],
            "proof": evidence,
            "capturedInputSha256": inputs["image"]["sha256"],
        }
    )
    return inputs, gt, source_record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path, help="new ignored private cohort directory")
    parser.add_argument("--map-root", type=Path, default=MAP_ROOT)
    parser.add_argument("--wait", type=float, default=2.5)
    parser.add_argument("--limit", type=int, help="metadata/proof smoke limit; omitted builds all 20")
    args = parser.parse_args()
    if not (0.5 <= args.wait <= 20):
        raise ValueError("wait must be between 0.5 and 20 seconds")
    if args.limit is not None and not 1 <= args.limit <= 20:
        raise ValueError("limit must be in [1,20]")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    maps = [(name, "present") for name in POSITIVE_MAPS] + [(name, "absent") for name in NEGATIVE_MAPS]
    if args.limit is not None:
        maps = maps[: args.limit]
    inputs: list[dict[str, Any]] = []
    truths: list[dict[str, Any]] = []
    ledger: dict[str, Any] = {
        "schema": "controlled-wesnoth-map-source-ledger-v1",
        "game": "Battle for Wesnoth",
        "version": MAP_VERSION,
        "mode": "map editor",
        "sceneStratum": "controlled-real-game-map",
        "license": "GNU General Public License v2 or later (Wesnoth 1.16.11 official data package)",
        "licenseEvidence": {
            "sourceRole": "Debian wesnoth-1.16-data package copyright metadata",
            "sha256": "fe5e12e3447f2b114a30a29748b2fb458b5809b64d2d323019a80655dd084ab3",
            "version": "1:1.16.11-1build3",
        },
        "sourceRootRole": "official Wesnoth 1.16.11 multiplayer map directory supplied by --map-root",
        "theme": {
            "initialCfgSha256": "7c1caae7b9636061dd9bc8b6b4c5bfd8abe1eafc7aa15f4be8c42602f924bd80",
            "editorCfgSha256": "48e6594b785edbc75b5934c5f8274bc6549bb997697abdadc37b21348fa6ddb3",
            "requestedMinimapArea": list(MINIMAP_AREA),
            "bitmapViewport": [856, 11, 159, 212],
            "screen": [SCREEN_WIDTH, SCREEN_HEIGHT],
        },
        "renderer": {
            "minimapCppSha256": "e889375b80b7f886b403954e3ee02ee48c16240fb8d24bbecdb5a9224ed6c030",
            "displayCppSha256": "20203f564470d3f8ddf01bd560472257f9785f1ad178422c38f60a77e0b465b0",
            "utilsCppSha256": "ee66d5a2b3d1b8aa6205aba69e5215963a7c8c77d801a1c0401b6f6afbe4e249",
            "mapHeaderSha256": "33e13a400bdbd8e4c9b16d3ece31226c4f0c20a2c6512db153b86021d9e376bc",
            "mapSourceSha256": "91627ad840ec9c7a0d09e5d90b8dbaf5141d568f47347fccd26be6f2786a684a",
            "sampler": "float32 accumulated source coordinate, source index truncation, area sampler source behavior",
            "projectionMethod": "one selected source village per positive; transformed support only bounds actual A/B/A delta; bbox is measured from visible pixel delta",
        },
        "selection": {
            "positiveMapNames": list(POSITIVE_MAPS),
            "negativeMapNames": list(NEGATIVE_MAPS),
            "positiveVillageRule": "median row-major ^V cell from each pinned official source map; all other village overlays removed in the private derived map",
            "negativeRule": "all ^V overlays removed from each pinned official source map and zero retained overlays verified before capture",
            "excludedProofMap": "4p_Siege_Castles.map",
            "proofScreensExcluded": True,
        },
        "cases": [],
    }
    for index, (name, presence) in enumerate(maps, start=1):
        source = args.map_root / name
        if not source.is_file():
            raise FileNotFoundError(source)
        input_row, truth_row, source_row = build_case(output, index, source, presence, args.wait)
        inputs.append(input_row)
        truths.append(truth_row)
        ledger["cases"].append(source_row)
    counts = Counter(row["expectedPresence"] for row in truths)
    if args.limit is None and counts != {"present": 15, "absent": 5}:
        raise ValueError(f"unexpected map cohort counts: {counts}")
    write_exclusive(output / "inputs.json", inputs)
    write_exclusive(output / "ground-truth.json", truths)
    write_exclusive(output / "source-ledger.json", ledger)
    summary = {
        "cases": len(inputs),
        "counts": dict(counts),
        "inputsSha256": sha256_file(output / "inputs.json"),
        "truthSha256": sha256_file(output / "ground-truth.json"),
        "ledgerSha256": sha256_file(output / "source-ledger.json"),
        "sourceGroupCount": len({row["sourceGroup"] for row in truths}),
        "allCapturePhaseScreens": sum(len(row["capturePhases"]) for row in ledger["cases"]),
        "modelCalls": 0,
    }
    write_exclusive(output / "summary.json", summary)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
