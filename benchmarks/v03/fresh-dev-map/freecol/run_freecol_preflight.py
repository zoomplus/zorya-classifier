#!/usr/bin/env python3
"""Launch an isolated FreeCol state-only preflight and retain owned receipts."""

import argparse
import hashlib
import json
import os
import re
import selectors
import shutil
import subprocess
import sys
import time
from pathlib import Path
from collections import Counter
from xml.etree import ElementTree
import zipfile

from preflight_runtime import BoundedLogWriter, bounded_tail, stop_owned_group


EXPECTED_ROOT = Path("/root/.codex/artifacts/zorya-classifier-mcp-20261031/fresh-map")
CARAVEL_EVIDENCE_ROOT = Path("/root/.codex/artifacts/zorya-classifier-mcp-20261101/freecol-caravel")
CLEAR_OCEAN_EVIDENCE_ROOT = CARAVEL_EVIDENCE_ROOT / "clear-ocean-v1"
ALLOWED_EVIDENCE_ROOTS = (EXPECTED_ROOT, CARAVEL_EVIDENCE_ROOT, CLEAR_OCEAN_EVIDENCE_ROOT)
CLEAR_OCEAN_PARENT_CASES = {
    2026110101: {
        "save": CARAVEL_EVIDENCE_ROOT / "metadata-v2-new-2026110101/official-state.fsg",
        "saveSha256": "b18d9f9d3b48f5a682c3cfbe6329299b65f579a3df73aedce1616f9a9bc00ef4",
        "stateSignatureSha256": "56f30a642f205ba83be6c89a15f2c61585c59e59750ba9fec975fe533c61cd6e",
        "unitId": "unit:5880", "start": (33, 59), "final": (30, 59),
    },
    2026110102: {
        "save": CARAVEL_EVIDENCE_ROOT / "metadata-v2-new-2026110102/official-state.fsg",
        "saveSha256": "8d6e5cfd7505998b983230b210edc1bc73626284c8ed97db4b7f334cdcb81aa7",
        "stateSignatureSha256": "feb74e8a96b679b48081aa65a08f083a1d8a80fb38a6dbbbc1cbde33d9d05cf4",
        "unitId": "unit:5859", "start": (30, 13), "final": (27, 13),
    },
    2026110103: {
        "save": CARAVEL_EVIDENCE_ROOT / "metadata-v2-new-2026110103/official-state.fsg",
        "saveSha256": "8d11f64ac38ec1fd6ed9ff457e425d633c6ebcbfb6aace4961a1723f14b47125",
        "stateSignatureSha256": "3d4f1b11290fdc6925997c0b7de4546c1a53ffa6d7c344c951e15cb12fee7765",
        "unitId": "unit:6113", "start": (38, 36), "final": (35, 36),
    },
    2026110104: {
        "save": CARAVEL_EVIDENCE_ROOT / "metadata-v2-new-2026110104/official-state.fsg",
        "saveSha256": "c8f7c9420555d72061baf40fb8cdffa51669f6d0249125ca46276dd35b144033",
        "stateSignatureSha256": "9d04f5c9b324259635c831b9950002cdb882914cd58c35f486bec47813a23517",
        "unitId": "unit:5873", "start": (34, 59), "final": (31, 59),
    },
}
JAR = Path("/usr/share/java/FreeCol-1.1.0.jar")
RESOURCE_MAPPING = Path("/usr/share/games/freecol/default/resources.properties")
PACKAGE_COPYRIGHT = Path("/usr/share/doc/freecol/copyright")
FREECOL = Path("/usr/games/freecol")
JAVA = Path("/usr/lib/jvm/java-21-openjdk-amd64/bin/java")
JAVAC_MODULE = "jdk.compiler/com.sun.tools.javac.Main"
JAR_MODULE = "jdk.jartool/sun.tools.jar.Main"
PACKAGE_VERSION = "1.1.0-1"
MAX_LOG_BYTES = 2_000_000
MAX_RUN_SECONDS = 600
MAX_SAVEGAME_XML_BYTES = 100 * 1024 * 1024
MAX_SAVED_UNIT_ROWS = 20_000
SOURCE_FILES = (
    Path("Manifest.mf"),
    Path("namespace_init.py"),
    Path("preflight_runtime.py"),
    Path("run_freecol_preflight.py"),
    Path("session_worker.py"),
    Path("test_run_freecol_preflight.py"),
    Path("src/zorya/mapprobe/FreeColProbe.java"),
    Path("src/zorya/mapprobe/FreeColCaptureUiGateFixture.java"),
    Path("src/zorya/mapprobe/FreeColNationSelectionFixture.java"),
)

NATION_ID_PATTERN = re.compile(r"model\.nation\.[A-Za-z0-9._-]{1,96}\Z")
NATION_TYPE_ID_PATTERN = re.compile(r"model\.nationType\.[A-Za-z0-9._-]{1,96}\Z")


def validate_nation_selection(nation_id: str | None, nation_type_id: str | None,
                              capture_requested: bool = False) -> None:
    if (nation_id is None) != (nation_type_id is None):
        raise ValueError("nation selection requires both --nation-id and --nation-type-id")
    if nation_id is not None and (NATION_ID_PATTERN.fullmatch(nation_id) is None
                                  or NATION_TYPE_ID_PATTERN.fullmatch(nation_type_id or "") is None):
        raise ValueError("nation selection IDs must be safe FreeCol nation and nation-type IDs")
    if nation_id is not None and capture_requested:
        raise ValueError("nation selection cannot be combined with screenshot capture options")


def build_agent_arguments(output: Path, timeout_ms: int, save_path: Path | None,
                          capture_fields: tuple[str, ...] | None,
                          nation_id: str | None, nation_type_id: str | None) -> str:
    parts = [str(output), str(timeout_ms)]
    if capture_fields is not None:
        if len(capture_fields) != 5:
            raise ValueError("capture agent arguments require exactly five bounded fields")
        validate_nation_selection(nation_id, nation_type_id, capture_requested=True)
        parts.extend(capture_fields)
    if save_path is not None:
        parts.append(str(save_path))
    if nation_id is not None:
        validate_nation_selection(nation_id, nation_type_id)
        parts.extend((nation_id, nation_type_id or ""))
    return ",".join(parts)


def build_west_move_agent_arguments(output: Path, timeout_ms: int, save_path: Path,
                                    unit_id: str, expected_state_signature: str,
                                    start_tile: tuple[int, int], final_tile: tuple[int, int]) -> str:
    if not re.fullmatch(r"unit:[A-Za-z0-9._-]{1,96}", unit_id):
        raise ValueError("west movement requires one safe dynamic unit ID")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_state_signature):
        raise ValueError("west movement requires the exact initial state signature")
    coordinates = (*start_tile, *final_tile)
    if any(not isinstance(value, int) or value < 0 or value > 100_000 for value in coordinates):
        raise ValueError("west movement coordinates must be bounded non-negative integers")
    return ",".join((str(output), str(timeout_ms), "MOVE-WWW-CLEAR-OCEAN", str(save_path), unit_id,
                     expected_state_signature, *(str(value) for value in coordinates)))


def build_clear_ocean_evidence_arguments(output: Path, timeout_ms: int, unit_id: str,
                                         expected_state_signature: str) -> str:
    if not re.fullmatch(r"unit:[A-Za-z0-9._-]{1,96}", unit_id):
        raise ValueError("clear-ocean evidence requires one safe dynamic unit ID")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_state_signature):
        raise ValueError("clear-ocean evidence requires an exact state signature")
    return ",".join((str(output), str(timeout_ms), "CLEAR-OCEAN-EVIDENCE", unit_id, expected_state_signature))


def build_clear_ocean_capture_arguments(output: Path, timeout_ms: int,
                                        capture_fields: tuple[str, ...], unit_id: str,
                                        save_path: Path | None = None) -> str:
    if len(capture_fields) != 5 or capture_fields[2] != unit_id or capture_fields[3] != "-":
        raise ValueError("clear-ocean capture requires its selected positive target and exact five fields")
    if not re.fullmatch(r"unit:[A-Za-z0-9._-]{1,96}", unit_id):
        raise ValueError("clear-ocean capture requires one safe dynamic unit ID")
    parts = [str(output), str(timeout_ms), "CLEAR-OCEAN-CAPTURE", *capture_fields, unit_id]
    if save_path is not None:
        parts.append(str(save_path))
    return ",".join(parts)


def loaded_state_signature_matches(expected: str, observed_final: object,
                                   movement: dict[str, object] | None = None) -> bool:
    observed = movement.get("initialStateSignatureSha256") if movement is not None else observed_final
    return isinstance(observed, str) and observed == expected


def selected_clear_ocean_evidence(live_state: dict[str, object], unit_id: str) -> dict[str, object] | None:
    rows = live_state.get("units")
    if not isinstance(rows, list):
        return None
    matches = [row for row in rows if isinstance(row, dict) and row.get("id") == unit_id]
    if len(matches) != 1:
        return None
    evidence = matches[0].get("aboveTileFootprintEvidence")
    return evidence if isinstance(evidence, dict) else None


def canonical_reload_state_signature(movement: object) -> str | None:
    if not isinstance(movement, dict):
        return None
    signature = movement.get("canonicalReloadStateSignatureSha256")
    return signature if isinstance(signature, str) and re.fullmatch(r"[0-9a-f]{64}", signature) else None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_official_savegame(path: Path) -> dict[str, object]:
    """Read the complete dynamic Unit inventory from a pinned official FreeCol save."""
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("official save inventory requires a regular non-symlink save")
    unit_rows: list[str] = []
    unit_details: list[dict[str, str]] = []
    type_counts: Counter[str] = Counter()
    unit_count = 0
    malformed_units = 0
    root_tag: str | None = None
    with zipfile.ZipFile(path, "r") as archive:
        entries = [entry for entry in archive.infolist() if entry.filename == "savegame.xml"]
        if len(entries) != 1:
            raise RuntimeError("official FreeCol save must contain exactly one savegame.xml")
        entry = entries[0]
        if entry.file_size <= 0 or entry.file_size > MAX_SAVEGAME_XML_BYTES or entry.compress_size > MAX_SAVEGAME_XML_BYTES:
            raise RuntimeError("official savegame.xml exceeds the bounded XML evidence limit")
        with archive.open(entry, "r") as stream:
            for event, element in ElementTree.iterparse(stream, events=("start", "end")):
                if root_tag is None and event == "start":
                    root_tag = element.tag
                if event != "end" or element.tag != "unit":
                    continue
                object_id = element.attrib.get("id", "")
                if not object_id.startswith("unit:"):
                    element.clear()
                    continue
                unit_type = element.attrib.get("unitType")
                if not unit_type:
                    malformed_units += 1
                    element.clear()
                    continue
                unit_count += 1
                type_counts[unit_type] += 1
                unit_rows.append("|".join((object_id, unit_type, element.attrib.get("owner", ""), element.attrib.get("location", ""))))
                unit_details.append({
                    "id": object_id,
                    "typeId": unit_type,
                    "ownerId": element.attrib.get("owner", ""),
                    "locationId": element.attrib.get("location", ""),
                })
                if unit_count > MAX_SAVED_UNIT_ROWS:
                    raise RuntimeError("official saved Unit inventory exceeds the bounded row limit")
                element.clear()
    if root_tag != "savedGame" or unit_count == 0:
        raise RuntimeError("official FreeCol save has no recognized complete game Unit inventory")
    unit_rows.sort()
    inventory_hash = hashlib.sha256(("\n".join(unit_rows) + "\n").encode("utf-8")).hexdigest()
    return {
        "complete": malformed_units == 0,
        "xmlEntry": "savegame.xml",
        "xmlBytes": entry.file_size,
        "dynamicUnitCount": unit_count,
        "malformedDynamicUnitCount": malformed_units,
        "unitTypeCounts": dict(sorted(type_counts.items())),
        "inventorySha256": inventory_hash,
        "units": unit_details,
    }


def create_owned_run_dir(root: Path, run_id: str, approved_root: Path = EXPECTED_ROOT) -> Path:
    if root.resolve() != approved_root.resolve():
        raise ValueError("evidence root must be the task-owned external artifact root")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}", run_id):
        raise ValueError("run id contains unsupported characters")
    if root.is_symlink():
        raise ValueError("evidence root must not be a symlink")
    root.mkdir(mode=0o700, parents=False, exist_ok=True)
    run_dir = root / run_id
    run_dir.mkdir(mode=0o700, exist_ok=False)
    return run_dir


def bounded_file_bytes(path: Path) -> int:
    return path.stat().st_size if path.exists() else 0


def write_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def physical_screenshot_created(live_data: dict[str, object]) -> bool:
    capture = live_data.get("actualScreenCapture")
    if not isinstance(capture, dict) or capture.get("status") != "captured" or capture.get("screenshotCreated") is not True:
        return False
    screenshot = capture.get("screenshot")
    return bool(
        isinstance(screenshot, dict)
        and isinstance(screenshot.get("path"), str)
        and bool(screenshot["path"])
        and isinstance(screenshot.get("sha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", screenshot["sha256"]) is not None
        and isinstance(screenshot.get("bytes"), int)
        and screenshot["bytes"] > 0
    )


def snapshot_source_closure(source_dir: Path, run_dir: Path) -> tuple[Path, dict[str, object]]:
    """Copy the exact reviewed source/test closure before compiling or launching it."""
    snapshot = run_dir / "source-snapshot"
    snapshot.mkdir(mode=0o700, exist_ok=False)
    files: list[dict[str, object]] = []
    for relative in SOURCE_FILES:
        source = source_dir / relative
        if source.is_symlink() or not source.is_file():
            raise RuntimeError(f"required source-closure file is missing or linked: {relative}")
        target = snapshot / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        content = source.read_bytes()
        target.write_bytes(content)
        target.chmod(0o444)
        files.append({"path": relative.as_posix(), "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
    closure_hash = hashlib.sha256(
        "".join(f"{entry['path']}\0{entry['sha256']}\n" for entry in files).encode("utf-8")
    ).hexdigest()
    receipt = {"schemaVersion": 1, "files": files, "closureSha256": closure_hash, "capturedBeforeCompile": True}
    manifest = snapshot / "source-snapshot.json"
    manifest.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest.chmod(0o444)
    for directory in sorted((path for path in snapshot.rglob("*") if path.is_dir()), key=lambda path: len(path.parts), reverse=True):
        directory.chmod(0o555)
    snapshot.chmod(0o555)
    return snapshot, receipt


def compile_agent(run_dir: Path, source_dir: Path) -> Path:
    build_dir = run_dir / "agent-build"
    build_dir.mkdir(mode=0o700)
    source = source_dir / "src/zorya/mapprobe/FreeColProbe.java"
    compile_result = subprocess.run(
        [str(JAVA), "-m", JAVAC_MODULE, "-classpath", str(JAR), "-d", str(build_dir), str(source)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=60,
        check=False,
    )
    (run_dir / "javac.log").write_bytes(compile_result.stdout[:MAX_LOG_BYTES])
    if compile_result.returncode != 0:
        raise RuntimeError(f"FreeCol observer compilation failed ({compile_result.returncode})")
    manifest = source_dir / "Manifest.mf"
    agent = run_dir / "freecol-state-probe.jar"
    jar_result = subprocess.run(
        [str(JAVA), "-m", JAR_MODULE, "cfm", str(agent), str(manifest), "-C", str(build_dir), "."],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=30,
        check=False,
    )
    (run_dir / "jar.log").write_bytes(jar_result.stdout[:MAX_LOG_BYTES])
    if jar_result.returncode != 0:
        raise RuntimeError(f"FreeCol observer packaging failed ({jar_result.returncode})")
    return agent


def make_private_dirs(run_dir: Path) -> dict[str, Path]:
    private_root = run_dir / "private"
    private_root.mkdir(mode=0o700)
    (private_root / ".owned-by-zorya-freecol-preflight").write_text("zorya-freecol-preflight-v1\n", encoding="utf-8")
    paths = {name: private_root / name for name in ("home", "config", "data", "cache", "state", "runtime", "user-data", "user-config", "user-cache")}
    for path in paths.values():
        path.mkdir(mode=0o700)
    return paths


def remove_owned_private_root(run_dir: Path) -> bool:
    private_root = run_dir / "private"
    marker = private_root / ".owned-by-zorya-freecol-preflight"
    if not private_root.exists():
        return True
    if private_root.is_symlink() or private_root.parent.resolve() != run_dir.resolve() or marker.is_symlink() or not marker.is_file():
        raise RuntimeError("refusing to remove a private directory without its ownership marker")
    if marker.read_text(encoding="utf-8") != "zorya-freecol-preflight-v1\n":
        raise RuntimeError("private directory ownership marker does not match")
    shutil.rmtree(private_root)
    return not private_root.exists()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--evidence-root", choices=tuple(str(root) for root in ALLOWED_EVIDENCE_ROOTS),
                        default=str(EXPECTED_ROOT), help="bounded task-owned evidence root")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--seed", type=int, default=20261031)
    parser.add_argument("--capture-target-unit-id")
    parser.add_argument("--capture-absent-unit-type-id")
    parser.add_argument("--expected-state-signature-sha256")
    parser.add_argument("--nation-id", help="optional exact FreeCol nation ID selected through the pre-game controller")
    parser.add_argument("--nation-type-id", help="optional exact FreeCol nation-type ID selected through the pre-game controller")
    operations = parser.add_mutually_exclusive_group()
    operations.add_argument("--save-state", action="store_true", help="save the fresh live game through FreeCol's official client API")
    operations.add_argument("--load-savegame", type=Path, help="load a previously frozen owned FreeCol save")
    parser.add_argument("--expected-save-sha256")
    parser.add_argument("--expected-loaded-state-signature-sha256")
    parser.add_argument("--move-west-unit-id", help="opt-in: request exactly three normal west moves for this active front unit")
    parser.add_argument("--move-west-start", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument("--move-west-final", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument("--clear-ocean-evidence-unit-id", help="opt-in: inspect full above-tile alpha evidence for exactly one selected unit")
    args = parser.parse_args()
    if not 30 <= args.timeout_seconds <= MAX_RUN_SECONDS:
        parser.error(f"--timeout-seconds must be between 30 and {MAX_RUN_SECONDS}")
    if args.seed < 0 or args.seed > 2**31 - 1:
        parser.error("--seed must be a non-negative 32-bit integer")
    capture_targets = sum((args.capture_target_unit_id is not None, args.capture_absent_unit_type_id is not None))
    move_requested = args.move_west_unit_id is not None or args.move_west_start is not None or args.move_west_final is not None
    clear_ocean_evidence_requested = args.clear_ocean_evidence_unit_id is not None
    evidence_only_requested = clear_ocean_evidence_requested and not move_requested and capture_targets == 0
    if clear_ocean_evidence_requested and re.fullmatch(r"unit:[A-Za-z0-9._-]{1,96}", args.clear_ocean_evidence_unit_id or "") is None:
        parser.error("clear-ocean evidence requires one safe dynamic unit ID")
    if clear_ocean_evidence_requested and (
        args.load_savegame is None or args.expected_state_signature_sha256 is None
        or args.expected_loaded_state_signature_sha256 != args.expected_state_signature_sha256
        or args.save_state or args.nation_id is not None or args.nation_type_id is not None
    ):
        parser.error("clear-ocean evidence requires a pinned loaded save and matching state signatures")
    if clear_ocean_evidence_requested and capture_targets and (
        capture_targets != 1 or args.capture_target_unit_id != args.clear_ocean_evidence_unit_id
        or args.capture_absent_unit_type_id is not None
    ):
        parser.error("clear-ocean screenshot evidence requires the same selected positive unit ID")
    if move_requested and (args.move_west_unit_id is None or args.move_west_start is None or args.move_west_final is None):
        parser.error("west movement requires --move-west-unit-id, --move-west-start and --move-west-final")
    if move_requested and (args.load_savegame is None or args.expected_state_signature_sha256 is None
                           or args.expected_loaded_state_signature_sha256 is None
                           or args.expected_loaded_state_signature_sha256 != args.expected_state_signature_sha256):
        parser.error("west movement requires one pinned loaded save and matching initial state signatures")
    if move_requested and (args.move_west_unit_id is None
                           or re.fullmatch(r"unit:[A-Za-z0-9._-]{1,96}", args.move_west_unit_id) is None):
        parser.error("west movement requires one safe dynamic unit ID")
    if move_requested and (not clear_ocean_evidence_requested
                           or args.clear_ocean_evidence_unit_id != args.move_west_unit_id):
        parser.error("west movement requires explicit clear-ocean evidence for the same unit")
    if move_requested and (args.save_state or capture_targets or args.nation_id is not None or args.nation_type_id is not None):
        parser.error("west movement cannot be combined with fresh-save, screenshot, or nation-selection options")
    if move_requested and (any(value < 0 or value > 100_000 for value in (*args.move_west_start, *args.move_west_final))):
        parser.error("west movement coordinates must be bounded non-negative integers")
    if move_requested:
        pinned = CLEAR_OCEAN_PARENT_CASES.get(args.seed)
        if (Path(args.evidence_root) != CLEAR_OCEAN_EVIDENCE_ROOT or pinned is None
                or args.load_savegame != pinned["save"]
                or args.expected_save_sha256 != pinned["saveSha256"]
                or args.expected_state_signature_sha256 != pinned["stateSignatureSha256"]
                or args.expected_loaded_state_signature_sha256 != pinned["stateSignatureSha256"]
                or args.move_west_unit_id != pinned["unitId"]
                or tuple(args.move_west_start or ()) != pinned["start"]
                or tuple(args.move_west_final or ()) != pinned["final"]):
            parser.error("west movement inputs must exactly match the frozen source row")
    capture_requested = capture_targets > 0 or (
        args.expected_state_signature_sha256 is not None and not move_requested and not evidence_only_requested)
    try:
        validate_nation_selection(args.nation_id, args.nation_type_id, capture_requested)
    except ValueError as error:
        parser.error(str(error))
    if capture_requested and (capture_targets != 1 or args.expected_state_signature_sha256 is None):
        parser.error("capture requires exactly one positive unit ID or absent unit type ID and an expected state signature")
    if args.expected_state_signature_sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", args.expected_state_signature_sha256):
        parser.error("expected state signature must be a lowercase SHA-256")
    if args.save_state and args.expected_save_sha256 is not None:
        parser.error("--expected-save-sha256 applies only to --load-savegame")
    if args.load_savegame is None and args.expected_save_sha256 is not None:
        parser.error("--expected-save-sha256 requires --load-savegame")
    if args.load_savegame is None and args.expected_loaded_state_signature_sha256 is not None:
        parser.error("--expected-loaded-state-signature-sha256 requires --load-savegame")
    if args.expected_loaded_state_signature_sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", args.expected_loaded_state_signature_sha256):
        parser.error("expected loaded state signature must be a lowercase SHA-256")
    resolved_save: Path | None = None
    load_save_sha256: str | None = None
    loaded_world_inventory: dict[str, object] | None = None
    if args.load_savegame is not None:
        if args.load_savegame.is_symlink() or not args.load_savegame.is_file():
            parser.error("--load-savegame must name an existing regular, non-symlink save file")
        try:
            resolved_save = args.load_savegame.resolve(strict=True)
            try:
                resolved_save.relative_to(Path(args.evidence_root).resolve())
            except ValueError:
                if not move_requested or resolved_save != CLEAR_OCEAN_PARENT_CASES[args.seed]["save"].resolve(strict=True):
                    raise
        except (OSError, ValueError):
            parser.error("--load-savegame must be inside the evidence root or be the exact pinned movement input")
        load_save_sha256 = sha256(resolved_save)
        try:
            loaded_world_inventory = inspect_official_savegame(resolved_save)
        except (OSError, zipfile.BadZipFile, ElementTree.ParseError, RuntimeError) as error:
            parser.error(f"--load-savegame is not a bounded complete official FreeCol save: {error}")
        if args.expected_save_sha256 is None or not re.fullmatch(r"[0-9a-f]{64}", args.expected_save_sha256):
            parser.error("--load-savegame requires a pinned --expected-save-sha256")
        if load_save_sha256 != args.expected_save_sha256:
            parser.error("--load-savegame hash differs from the supplied frozen save hash")
    if capture_requested and resolved_save is None:
        parser.error("real screenshot capture requires a pinned official --load-savegame state")
    capture_server_absence: dict[str, object] | None = None
    if args.capture_absent_unit_type_id is not None:
        assert loaded_world_inventory is not None
        counts = loaded_world_inventory.get("unitTypeCounts")
        if loaded_world_inventory.get("complete") is not True or not isinstance(counts, dict):
            parser.error("negative capture requires a complete official server-world unit inventory")
        server_count = counts.get(args.capture_absent_unit_type_id, 0)
        capture_server_absence = {
            "source": "official-FreeCol-server-savegame.xml-dynamic-Unit-inventory",
            "unitTypeId": args.capture_absent_unit_type_id,
            "complete": True,
            "dynamicUnitCount": loaded_world_inventory.get("dynamicUnitCount"),
            "typeCount": server_count,
            "inventorySha256": loaded_world_inventory.get("inventorySha256"),
        }
        if server_count != 0:
            parser.error("negative capture unit type exists in the official authoritative saved world")

    source_dir = Path(__file__).resolve().parent
    evidence_root = Path(args.evidence_root)
    run_dir = create_owned_run_dir(evidence_root, args.run_id, approved_root=evidence_root)
    started = time.monotonic()
    status = "startup-error"
    owned_close: dict[str, object] = {"closed": True, "notStarted": True}
    process: subprocess.Popen[bytes] | None = None
    private_root: Path | None = None
    snapshot: Path | None = None
    source_snapshot_receipt: dict[str, object] | None = None
    namespace_receipt: dict[str, object] | None = None
    post_stop_drain_completed = True
    try:
        dpkg = subprocess.run(["/usr/bin/dpkg-query", "-W", "-f=${Version}", "freecol"], capture_output=True, text=True, timeout=10, check=False)
        if dpkg.returncode != 0 or dpkg.stdout.strip() != PACKAGE_VERSION:
            raise RuntimeError("installed FreeCol package version is not the pinned 1.1.0-1")
        if not all(path.is_file() for path in (JAR, FREECOL, JAVA, RESOURCE_MAPPING, PACKAGE_COPYRIGHT)):
            raise RuntimeError("pinned FreeCol, jar, or Java executable is unavailable")

        snapshot, source_snapshot_receipt = snapshot_source_closure(source_dir, run_dir)
        agent = compile_agent(run_dir, snapshot)
        private = make_private_dirs(run_dir)
        private_root = run_dir / "private"
        receipt_path = run_dir / "live-state.json"
        agent_timeout_ms = min(args.timeout_seconds * 1000 - 20_000, 580_000)
        capture_fields: tuple[str, ...] | None = None
        save_path: Path | None = run_dir / "official-state.fsg" if args.save_state or move_requested else None
        capture_mode: str | None = None
        if capture_requested:
            capture_dir = run_dir / "capture"
            capture_dir.mkdir(mode=0o700, exist_ok=False)
            screen_path = capture_dir / "full-screen.png"
            sprite_path = capture_dir / "target-sprite.png" if args.capture_target_unit_id is not None else None
            capture_mode = "positive-unit" if sprite_path is not None else "negative-type-absence"
            capture_fields = (
                str(screen_path),
                "-" if sprite_path is None else str(sprite_path),
                args.capture_target_unit_id or "-",
                args.capture_absent_unit_type_id or "-",
                args.expected_state_signature_sha256 or "-",
            )
        if move_requested:
            assert save_path is not None and args.move_west_unit_id is not None
            assert args.expected_state_signature_sha256 is not None
            assert args.move_west_start is not None and args.move_west_final is not None
            agent_args = build_west_move_agent_arguments(
                receipt_path, agent_timeout_ms, save_path, args.move_west_unit_id,
                args.expected_state_signature_sha256, tuple(args.move_west_start), tuple(args.move_west_final))
        elif clear_ocean_evidence_requested and capture_fields is not None:
            assert args.clear_ocean_evidence_unit_id is not None
            agent_args = build_clear_ocean_capture_arguments(
                receipt_path, agent_timeout_ms, capture_fields, args.clear_ocean_evidence_unit_id, save_path)
        elif evidence_only_requested:
            assert args.clear_ocean_evidence_unit_id is not None
            assert args.expected_loaded_state_signature_sha256 is not None
            agent_args = build_clear_ocean_evidence_arguments(
                receipt_path, agent_timeout_ms, args.clear_ocean_evidence_unit_id,
                args.expected_loaded_state_signature_sha256)
        else:
            agent_args = build_agent_arguments(receipt_path, agent_timeout_ms, save_path, capture_fields,
                                              args.nation_id, args.nation_type_id)
        env = {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "HOME": str(private["home"]),
            "JAVA_HOME": str(JAVA.parent.parent),
            "XDG_CONFIG_HOME": str(private["config"]),
            "XDG_DATA_HOME": str(private["data"]),
            "XDG_CACHE_HOME": str(private["cache"]),
            "XDG_STATE_HOME": str(private["state"]),
            "XDG_RUNTIME_DIR": "/tmp/runtime",
            "TMPDIR": "/tmp",
        }
        env["JAVA_TOOL_OPTIONS"] = f"-XX:-UsePerfData -Duser.home={private['home']} -Djava.util.prefs.userRoot={private['config']}/java -javaagent:{agent}={agent_args}"
        command = [
            "/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork",
            "--kill-child=SIGKILL", "--mount-proc=/proc", "--",
            sys.executable, str(snapshot / "namespace_init.py"),
            str(snapshot / "session_worker.py"), str(run_dir), str(args.timeout_seconds), str(args.seed),
            "load" if args.load_savegame is not None else ("save" if args.save_state else "fresh"),
            str(resolved_save) if resolved_save is not None else (str(save_path) if save_path is not None else "-"),
        ]
        stdout_path = run_dir / "namespace.stdout.log"
        stderr_path = run_dir / "namespace.stderr.log"
        selector = selectors.DefaultSelector()
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            assert process.stdout is not None and process.stderr is not None
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            sink = BoundedLogWriter({"stdout": stdout, "stderr": stderr}, 16_384)
            deadline = started + args.timeout_seconds + 15
            status = "namespace-timeout"
            while time.monotonic() < deadline:
                for key, _ in selector.select(timeout=0.1):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        sink.write(key.data, block)
                if sink.overflowed:
                    status = "namespace-control-output-limit-exceeded"
                    break
                if process.poll() is not None and not selector.get_map():
                    status = "namespace-exited"
                    break
            owned_close = stop_owned_group(process, grace_seconds=5.0)
            drain_deadline = time.monotonic() + 3.0
            while selector.get_map() and time.monotonic() < drain_deadline:
                for key, _ in selector.select(timeout=0.1):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                    else:
                        sink.write(key.data, block)
            post_stop_drain_completed = not selector.get_map()
            for stream in (process.stdout, process.stderr):
                stream.close()
            selector.close()
        if not owned_close.get("closed", False) or not post_stop_drain_completed:
            status = "owned-namespace-closure-unconfirmed"

        session_receipt_path = run_dir / "session-receipt.json"
        namespace_receipt_path = run_dir / "namespace-receipt.json"
        session_receipt = None
        namespace_receipt = None
        for source, target in ((session_receipt_path, "session"), (namespace_receipt_path, "namespace")):
            if source.is_file():
                try:
                    value = json.loads(source.read_text(encoding="utf-8"))
                    if target == "session":
                        session_receipt = value
                    else:
                        namespace_receipt = value
                except (OSError, json.JSONDecodeError):
                    status = "invalid-worker-receipt"
        namespace_children_reaped = bool(namespace_receipt and namespace_receipt.get("allNamespaceChildrenReaped") is True)
        if status == "namespace-exited" and not namespace_children_reaped:
            status = "namespace-descendant-reaping-unconfirmed"
        if status == "namespace-exited" and namespace_receipt and namespace_receipt.get("sessionWorkerOutputTruncated") is True:
            status = "namespace-worker-output-limit-exceeded"

        freecol_tail_path = run_dir / "freecol-log-tail.txt"
        freecol_tail = b""
        if private_root is not None and private_root.exists() and owned_close.get("closed", False) and post_stop_drain_completed:
            freecol_tail = bounded_tail(private_root / "user-cache" / "FreeCol.log", 64 * 1024)
            if freecol_tail:
                freecol_tail_path.write_bytes(freecol_tail)
        namespace_workers_closed = bool(
            owned_close.get("closed", False)
            and post_stop_drain_completed
            and process is not None
            and process.poll() is not None
            and namespace_children_reaped
        )
        private_profile_removed = False
        if namespace_workers_closed and private_root is not None:
            private_profile_removed = remove_owned_private_root(run_dir)
        live_data: dict[str, object] = {}
        if receipt_path.exists():
            try:
                parsed_live = json.loads(receipt_path.read_text(encoding="utf-8"))
                if isinstance(parsed_live, dict):
                    live_data = parsed_live
            except (OSError, json.JSONDecodeError):
                pass
        official_save = live_data.get("officialSave") if isinstance(live_data.get("officialSave"), dict) else None
        nation_selection = live_data.get("nationSelection") if isinstance(live_data.get("nationSelection"), dict) else None
        save_file_sha256 = sha256(save_path) if save_path is not None and save_path.is_file() else None
        saved_world_inventory: dict[str, object] | None = None
        if save_path is not None and save_file_sha256 is not None:
            try:
                saved_world_inventory = inspect_official_savegame(save_path)
            except (OSError, zipfile.BadZipFile, ElementTree.ParseError, RuntimeError):
                status = "official-save-world-inventory-invalid"
        client_inventory = live_data.get("mapUnitInventory") if isinstance(live_data.get("mapUnitInventory"), dict) else {}
        client_unit_rows = client_inventory.get("rows") if isinstance(client_inventory.get("rows"), list) else []
        authoritative_units = (saved_world_inventory or loaded_world_inventory or {}).get("units")
        authoritative_by_id = {
            unit.get("id"): unit for unit in authoritative_units if isinstance(unit, dict) and isinstance(unit.get("id"), str)
        } if isinstance(authoritative_units, list) else {}
        server_crosscheck_complete = bool(
            authoritative_units is not None
            and isinstance(client_inventory.get("complete"), bool)
            and client_inventory.get("complete") is True
            and all(
                isinstance(row, dict)
                and (saved := authoritative_by_id.get(row.get("id"))) is not None
                and saved.get("typeId") == row.get("typeId")
                and saved.get("ownerId") == (row.get("ownerId") or "")
                for row in client_unit_rows
            )
        )
        if save_path is not None and (official_save is None or official_save.get("status") != "saved" or official_save.get("sha256") != save_file_sha256):
            status = "official-save-not-verified"
        if (save_path is not None or resolved_save is not None) and not server_crosscheck_complete:
            status = "official-save-client-inventory-crosscheck-failed"
        if resolved_save is not None and sha256(resolved_save) != load_save_sha256:
            status = "frozen-save-changed-during-load"
        movement = live_data.get("normalWestMovement") if isinstance(live_data.get("normalWestMovement"), dict) else None
        clear_ocean_evidence = selected_clear_ocean_evidence(live_data, args.clear_ocean_evidence_unit_id) if clear_ocean_evidence_requested else None
        if args.expected_loaded_state_signature_sha256 is not None:
            if not loaded_state_signature_matches(args.expected_loaded_state_signature_sha256,
                                                  live_data.get("stateSignatureSha256"), movement if move_requested else None):
                status = "loaded-state-signature-mismatch"
        if clear_ocean_evidence_requested and (
            clear_ocean_evidence is None or clear_ocean_evidence.get("complete") is not True
        ):
            status = "clear-ocean-native-evidence-incomplete"
        if move_requested and (
            movement is None or movement.get("requested") != 3 or movement.get("requests") != 3
            or movement.get("confirmed") != 3 or movement.get("failure") is not None
            or movement.get("initialStateSignatureSha256") != args.expected_loaded_state_signature_sha256
            or movement.get("finalStateSignatureSha256") != live_data.get("stateSignatureSha256")
            or movement.get("expectedFinalTile") != {"x": args.move_west_final[0], "y": args.move_west_final[1]}
            or not isinstance(official_save, dict) or official_save.get("status") != "saved"
        ):
            status = "normal-west-movement-not-fully-confirmed"
        canonical_reload_signature = canonical_reload_state_signature(movement)
        if move_requested and canonical_reload_signature is None:
            status = "canonical-reload-state-signature-unavailable"
        if capture_requested and args.capture_absent_unit_type_id is not None:
            valid_types = live_data.get("validGameUnitTypeIds")
            if not isinstance(valid_types, list) or args.capture_absent_unit_type_id not in valid_types:
                status = "negative-capture-unit-type-not-valid-in-specification"
        if args.nation_id is not None:
            start_actions = live_data.get("startActionObservations")
            selection_confirmed = bool(
                nation_selection is not None
                and nation_selection.get("selectionAttempted") is True
                and nation_selection.get("requestedNationId") == args.nation_id
                and nation_selection.get("requestedNationTypeId") == args.nation_type_id
                and nation_selection.get("confirmed") is True
                and nation_selection.get("observedPlayerNationId") == args.nation_id
                and nation_selection.get("observedPlayerNationTypeId") == args.nation_type_id
                and nation_selection.get("observedServerNationId") == args.nation_id
                and nation_selection.get("observedServerNationTypeId") == args.nation_type_id
            )
            if nation_selection is None:
                status = "requested-nation-selection-observation-missing"
            elif not selection_confirmed:
                status = "requested-nation-selection-not-confirmed-before-start"
            elif not isinstance(start_actions, list) or len(start_actions) != 1 or not any(
                isinstance(action, dict) and action.get("normalDoClickCalled") is True
                and action.get("actionEventObserved") is True for action in start_actions
            ):
                status = "requested-nation-selection-start-action-not-observed"
        meta = {
            "schemaVersion": 1,
            "status": status,
            "seed": args.seed,
            "requestedNationSelection": None if args.nation_id is None else {
                "nationId": args.nation_id,
                "nationTypeId": args.nation_type_id,
                "selectionMethod": "FreeColClient.getPreGameController().setNation/setNationType",
                "confirmationRequiredBeforeStart": True,
            },
            "nationSelectionResult": nation_selection,
            "renderingSettingsUnchanged": {
                "display": "1024x768 windowed",
                "gameAssets": "installed default resources",
                "scale": "FreeCol default",
                "overlayAndHUDChanges": False,
            },
            "packageVersion": dpkg.stdout.strip(),
            "freecolJarSha256": sha256(JAR),
            "resourceMappingPath": str(RESOURCE_MAPPING),
            "resourceMappingSha256": sha256(RESOURCE_MAPPING),
            "packageCopyrightPath": str(PACKAGE_COPYRIGHT),
            "packageCopyrightSha256": sha256(PACKAGE_COPYRIGHT),
            "observerJarSha256": sha256(agent),
            "observerSourceSha256": source_snapshot_receipt,
            "compiledFromSnapshot": snapshot is not None and source_snapshot_receipt is not None,
            "compiledSourceClosureSha256": None if source_snapshot_receipt is None else source_snapshot_receipt.get("closureSha256"),
            "command": command,
            "timeoutSeconds": args.timeout_seconds,
            "captureRequested": capture_requested,
            "captureMode": capture_mode,
            "stateOperation": "load-savegame-and-three-normal-west-moves" if move_requested else ("load-savegame" if resolved_save is not None else ("official-save" if save_path is not None else "fresh-seed")),
            "normalWestMovementRequest": None if not move_requested else {
                "direction": "W", "requestCount": 3, "expectedStartTile": args.move_west_start,
                "expectedFinalTile": args.move_west_final, "unitId": args.move_west_unit_id,
            },
            "normalWestMovementResult": movement,
            "canonicalReloadStateSignatureSha256": canonical_reload_signature,
            "clearOceanEvidenceRequested": clear_ocean_evidence_requested,
            "clearOceanEvidenceUnitId": args.clear_ocean_evidence_unit_id,
            "clearOceanAboveTileEvidence": clear_ocean_evidence,
            "finalStateSignatureSha256": live_data.get("stateSignatureSha256"),
            "loadedSavePath": None if resolved_save is None else str(resolved_save),
            "loadedSaveSha256Before": load_save_sha256,
            "loadedSaveSha256After": None if resolved_save is None else sha256(resolved_save),
            "officialSavePath": None if save_path is None else str(save_path),
            "officialSaveSha256": save_file_sha256,
            "officialSaveEvidence": official_save,
            "officialServerWorldInventory": saved_world_inventory if saved_world_inventory is not None else loaded_world_inventory,
            "officialServerCrosscheckAgainstClientMapInventory": server_crosscheck_complete,
            "captureServerWorldAbsenceProof": capture_server_absence,
            "maxLogBytes": MAX_LOG_BYTES,
            "namespaceControlOutputBytes": sink.bytes_written,
            "postStopOutputDrainCompleted": post_stop_drain_completed,
            "namespaceWorkerClosureConfirmed": namespace_workers_closed,
            "namespaceWorkerReturnCode": None if namespace_receipt is None else namespace_receipt.get("sessionWorkerReturnCode"),
            "namespaceDescendantsReaped": namespace_children_reaped,
            "namespaceWorkerOutputTruncated": bool(namespace_receipt and namespace_receipt.get("sessionWorkerOutputTruncated") is True),
            "sessionWorkerStatus": None if session_receipt is None else session_receipt.get("status"),
            "freecolLogTail": None if not freecol_tail else {
                "path": str(freecol_tail_path),
                "bytes": len(freecol_tail),
                "sha256": hashlib.sha256(freecol_tail).hexdigest(),
            },
            "logs": {
                "stdoutBytes": bounded_file_bytes(stdout_path),
                "stderrBytes": bounded_file_bytes(stderr_path),
            },
            "ownedProcessGroupClosure": owned_close,
            "screenshotCreated": physical_screenshot_created(live_data),
            "corpusCaseStateCaptured": False,
            "privateProfileRoot": str(private_root),
            "privateProfileRemoved": private_profile_removed,
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }
        write_json(run_dir / "run-receipt.json", meta)
        live_status = None
        capture_status = None
        if receipt_path.exists():
            try:
                live = json.loads(receipt_path.read_text(encoding="utf-8"))
                live_status = live.get("status")
                capture_status = (live.get("actualScreenCapture") or {}).get("status")
                print(json.dumps({"status": status, "liveStatus": live.get("status"), "captureStatus": capture_status, "sourceStateFeasibility": live.get("sourceStateFeasibility"), "spriteIntersectingViewportCount": live.get("spriteIntersectingViewportCount"), "runReceipt": str(run_dir / "run-receipt.json")}, sort_keys=True))
            except (OSError, json.JSONDecodeError):
                print(json.dumps({"status": status, "liveReceipt": "invalid", "runReceipt": str(run_dir / "run-receipt.json")}, sort_keys=True))
        else:
            print(json.dumps({"status": status, "runReceipt": str(run_dir / "run-receipt.json")}, sort_keys=True))
        return 0 if (
            status == "namespace-exited"
            and live_status == "live-map-observed"
            and session_receipt is not None
            and session_receipt.get("status") == "receipt-created"
            and session_receipt.get("appProcessGroupClosure", {}).get("closed")
            and session_receipt.get("xvfbProcessGroupClosure", {}).get("closed")
            and namespace_workers_closed
            and namespace_children_reaped
            and not (namespace_receipt and namespace_receipt.get("sessionWorkerOutputTruncated"))
            and (not capture_requested or capture_status == "captured")
            and (not move_requested or (movement is not None and movement.get("requests") == 3
                                        and movement.get("confirmed") == 3 and movement.get("failure") is None))
            and (not clear_ocean_evidence_requested or (clear_ocean_evidence is not None
                                                       and clear_ocean_evidence.get("complete") is True))
            and private_profile_removed
            and not sink.overflowed
        ) else 1
    except Exception as error:
        if process is not None:
            owned_close = stop_owned_group(process)
        post_stop_drain_completed = process is None or process.poll() is not None
        freecol_tail = b""
        if private_root is not None and private_root.exists() and owned_close.get("closed", False) and post_stop_drain_completed:
            freecol_tail = bounded_tail(private_root / "user-cache" / "FreeCol.log", 64 * 1024)
            if freecol_tail:
                (run_dir / "freecol-log-tail.txt").write_bytes(freecol_tail)
        private_profile_removed = False
        if owned_close.get("closed", False) and post_stop_drain_completed and private_root is not None:
            try:
                private_profile_removed = remove_owned_private_root(run_dir)
            except Exception:
                private_profile_removed = False
        (run_dir / "failure.txt").write_text(f"{type(error).__name__}: {str(error)[:300]}\n", encoding="utf-8")
        failure = {
            "schemaVersion": 1,
            "status": status,
            "errorType": type(error).__name__,
            "errorMessage": str(error)[:300],
            "ownedProcessGroupClosure": owned_close,
            "postStopDrainCompleted": post_stop_drain_completed,
            "privateProfileRemoved": private_profile_removed,
            "freecolLogTail": None if not freecol_tail else {
                "path": str(run_dir / "freecol-log-tail.txt"),
                "bytes": len(freecol_tail),
                "sha256": hashlib.sha256(freecol_tail).hexdigest(),
            },
            "observerSourceSha256": source_snapshot_receipt,
            "namespaceDescendantsReaped": bool(namespace_receipt and namespace_receipt.get("allNamespaceChildrenReaped") is True),
            "namespaceWorkerOutputTruncated": bool(namespace_receipt and namespace_receipt.get("sessionWorkerOutputTruncated") is True),
        }
        write_json(run_dir / "run-receipt.json", failure)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
