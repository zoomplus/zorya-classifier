#!/usr/bin/env python3
"""Prepare and capture a separately frozen Gnumeric/Evince UI development cohort."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import socket
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from imaging import perceptual_hash64_from_rgb, hamming_distance64
from validation import read_bounded_file_bytes
import ui_capture as legacy

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
ARTIFACT_ROOT: Path | None = None
ARTIFACTS_ROOT: Path | None = None
PACKAGE_ROOT: Path | None = None
PACKAGE_DEBS: Path | None = None
OLD_FRAMES: Path | None = None
NAMESPACE = uuid.UUID("81726c36-f03b-43b0-9d9c-c06ac254a5d7")
SEED = "h8a-disjoint-gnumeric-evince-dev40-20261101-v2"
WIDTH = 1280
HEIGHT = 1024
MAX_PNG_BYTES = 12 * 1024 * 1024
MAX_LOG_BYTES = 256 * 1024
CASE_SECONDS = 35

CASES: tuple[dict[str, Any], ...] = (
    {"slot": "g1", "app": "gnumeric", "presence": "present", "role": "push button", "name": "Save", "query": "Save button in the spreadsheet toolbar", "source": "grid-01.gnumeric", "state": "wide populated worksheet, active first sheet; no modal window", "actions": []},
    {"slot": "g2", "app": "gnumeric", "presence": "present", "role": "push button", "name": "Cancel", "query": "Cancel button in the native print dialog", "source": "grid-02.gnumeric", "state": "populated worksheet with the native print dialog open", "actions": ["ctrl+p"]},
    {"slot": "g3", "app": "gnumeric", "presence": "present", "role": "push button", "name": "Find", "query": "Find button in the native worksheet search dialog", "source": "grid-03.gnumeric", "state": "populated worksheet with the native Search dialog open", "actions": ["ctrl+f"]},
    {"slot": "g4", "app": "gnumeric", "presence": "present", "role": "page tab", "name": "Alignment", "query": "Alignment tab in the native Format Cells dialog", "source": "grid-04.gnumeric", "state": "populated worksheet with native Format Cells dialog open", "actions": ["ctrl+1"]},
    {"slot": "g5", "app": "gnumeric", "presence": "absent", "role": "push button", "name": "Zoom In", "query": "Zoom In button in the worksheet toolbar", "source": "grid-05.gnumeric", "state": "large worksheet with a different row and column layout; active first sheet", "actions": []},
    {"slot": "e1", "app": "evince", "presence": "present", "role": "toggle button", "name": "Find", "query": "Find control in the document viewer toolbar", "source": "paper-01.pdf", "state": "single portrait page in ordinary document view", "actions": []},
    {"slot": "e2", "app": "evince", "presence": "present", "role": "push button", "name": "Cancel", "query": "Cancel button in the native Open Document dialog", "source": "paper-02.pdf", "state": "two landscape pages with the native Open Document file chooser open", "actions": ["ctrl+o"]},
    {"slot": "e3", "app": "evince", "presence": "present", "role": "push button", "name": "Down", "query": "Down result-navigation button in the document search bar", "source": "paper-03.pdf", "state": "three portrait pages with the native document search bar open", "actions": ["ctrl+f"]},
    {"slot": "e4-search-down-absent-v1", "app": "evince", "presence": "absent", "role": "push button", "name": "Down", "query": "Down result-navigation button in the document search bar", "source": "paper-04.pdf", "state": "four landscape pages in native Evince full-screen mode with the document search bar closed", "actions": [], "launchArgs": ["--fullscreen"]},
    {"slot": "e5", "app": "evince", "presence": "absent", "role": "toggle button", "name": "Find", "query": "Find control in the document viewer toolbar", "source": "paper-05.pdf", "state": "five square pages in native Evince presentation mode", "actions": [], "launchArgs": ["--presentation"]},
)


class UiDisjointError(RuntimeError):
    pass


def configure_roots(artifact_root: str | Path, artifacts_root: str | Path, old_frames: str | Path) -> None:
    global ARTIFACT_ROOT, ARTIFACTS_ROOT, PACKAGE_ROOT, PACKAGE_DEBS, OLD_FRAMES
    ARTIFACT_ROOT = Path(artifact_root).resolve(strict=False)
    ARTIFACTS_ROOT = Path(artifacts_root).resolve(strict=False)
    PACKAGE_ROOT = ARTIFACT_ROOT / "extracted"
    PACKAGE_DEBS = ARTIFACT_ROOT / "package-debs"
    OLD_FRAMES = Path(old_frames).resolve(strict=False)
    repo = REPO_ROOT.resolve()
    if any(_is_within(path, repo) for path in (ARTIFACT_ROOT, ARTIFACTS_ROOT, OLD_FRAMES)):
        raise UiDisjointError("artifact, evidence, and fingerprint roots must be outside the repository")
    if not _is_within(ARTIFACT_ROOT, ARTIFACTS_ROOT) or not _is_within(OLD_FRAMES, ARTIFACTS_ROOT):
        raise UiDisjointError("study root and prior-frame fingerprints must be inside the declared artifacts root")
    if not ARTIFACTS_ROOT.is_dir() or not ARTIFACT_ROOT.is_dir() or not OLD_FRAMES.is_file():
        raise UiDisjointError("declared external roots must exist; artifacts root and study root are directories and old frames are a file")


def _is_within(path: Path, root: Path) -> bool:
    return path.resolve(strict=False).is_relative_to(root.resolve(strict=False))


def _require_existing_path(path: str | Path, root: Path, *, directory: bool = False) -> Path:
    resolved = Path(path).resolve(strict=False)
    if not _is_within(resolved, root) or resolved == root.resolve(strict=False):
        raise UiDisjointError("input path must be below its declared external root")
    if not resolved.exists() or resolved.is_symlink() or (directory and not resolved.is_dir()) or (not directory and not resolved.is_file()):
        raise UiDisjointError("declared input path is missing, linked, or has the wrong type")
    return resolved


def _require_new_output(path: str | Path, root: Path) -> Path:
    raw = Path(path)
    if raw.exists() or raw.is_symlink():
        raise UiDisjointError("output path must not already exist")
    resolved = raw.resolve(strict=False)
    if not _is_within(resolved, root) or resolved == root.resolve(strict=False):
        raise UiDisjointError("output path must be below its declared external root")
    existing_parent = resolved.parent
    while not existing_parent.exists() and existing_parent != existing_parent.parent:
        existing_parent = existing_parent.parent
    if not existing_parent.is_dir() or not _is_within(existing_parent.resolve(), root):
        raise UiDisjointError("output parent must resolve inside the declared external root")
    return resolved


def validate_runtime_inputs(*, need_converter: bool = False) -> None:
    _require_existing_path(ARTIFACT_ROOT / "package-license-lock.json", ARTIFACT_ROOT)
    _require_existing_path(ARTIFACT_ROOT / "runtime-schemas", ARTIFACT_ROOT, directory=True)
    _require_existing_path(OLD_FRAMES, ARTIFACTS_ROOT)
    executables = [PACKAGE_ROOT / "usr/bin/gnumeric", PACKAGE_ROOT / "usr/bin/evince"]
    if need_converter:
        executables.append(PACKAGE_ROOT / "usr/bin/ssconvert")
    for executable in executables:
        _require_existing_path(executable, ARTIFACT_ROOT)
    _load_old_frames()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json_new(path: Path, document: Any) -> str:
    raw = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode()
    with path.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    return sha256(raw)


def ordered_json_sha256(document: Any) -> str:
    """Match the evaluator's historical SHA-256(JSON.stringify(value)) protocol."""
    return sha256(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode())


def _canonical_annotation(row: dict[str, Any], reference_box: dict[str, int] | None = None) -> dict[str, Any]:
    """Build the evaluator row in the canonical historical JSON property order."""
    return {
        "opaqueCaseId": row["caseId"],
        "stratum": "ui",
        "sourceGroup": row["sourceGroup"],
        "expectedPresence": row["expectedPresence"],
        "referenceBoxes": [reference_box] if reference_box is not None else [],
        "referenceMasks": [],
        "exactOriginalCanvasMaskRef": False,
    }


def _canonical_annotations(captures: list[dict[str, Any]], corrections: dict[str, dict[str, int]] | None = None) -> dict[str, dict[str, Any]]:
    corrections = corrections or {}
    annotations: dict[str, dict[str, Any]] = {}
    for row in captures:
        box = corrections.get(row["caseId"])
        if box is None and row["expectedPresence"] == "present":
            extents = row["oracle"]["matches"][0]["extents"]
            box = {"left": extents["x"], "top": extents["y"], "width": extents["width"], "height": extents["height"]}
        annotations[row["caseId"]] = _canonical_annotation(row, box)
    return annotations


def _write_source_draft(export_dir: Path, artifacts_root: Path, captures: list[dict[str, Any]], producer_hash: str, annotation_hash: str, controller_hash: str, provenance_hash: str, receipt_hash: str, annotations: dict[str, dict[str, Any]], provenance: dict[str, dict[str, Any]]) -> str:
    prefix = export_dir.relative_to(artifacts_root).as_posix()
    draft = {
        "schema": "h8a-ui-source-draft-v1",
        "sourceReviewStatus": "unreviewed-source-draft",
        "reviewRequired": True,
        "fragmentId": "gnumeric-evince-disjoint-dev10",
        "producerRows": {"path": f"{prefix}/producer-input-rows.json", "sha256": producer_hash},
        "annotations": {"path": f"{prefix}/evaluator-private-annotations.json", "sha256": annotation_hash},
        "controllerPathIndex": {"path": f"{prefix}/controller-path-index.json", "sha256": controller_hash},
        "provenance": {"path": f"{prefix}/curator-source-provenance.json", "sha256": provenance_hash},
        "fragmentReceipt": {"path": f"{prefix}/fragment-receipt.json", "sha256": receipt_hash},
        "rows": [{"opaqueCaseId": row["caseId"], "sourceSha256": row["imageSha256"], "annotationSha256": ordered_json_sha256(annotations[row["caseId"]]), "sourceGroup": row["sourceGroup"], "provenanceSha256": ordered_json_sha256(provenance[row["caseId"]])} for row in captures],
    }
    return write_json_new(export_dir / "source-draft.json", draft)


def _load_target_boundary_revision(path: Path, approved_sha256: str, captures: list[dict[str, Any]]) -> tuple[dict[str, dict[str, int]], dict[str, Any]]:
    raw = read_bounded_file_bytes(path, max_bytes=2 * 1024 * 1024, label="native target boundary revision")[0]
    if sha256(raw) != approved_sha256:
        raise UiDisjointError("target boundary revision hash does not match approved value")
    revision = json.loads(raw)
    if revision.get("schema") != "h8a-ui-target-boundary-revisions-v2" or revision.get("sourceOnlyCorrection") is not True or revision.get("screenshotsCaptured") is not False or revision.get("providerCalls") != 0:
        raise UiDisjointError("target boundary revision is not an approved source-only XTest correction")
    by_id = {row["caseId"]: row for row in captures}
    corrections: dict[str, dict[str, int]] = {}
    for item in revision.get("rows", []):
        case_id = item.get("caseId")
        capture = by_id.get(case_id)
        if capture is None or case_id in corrections:
            raise UiDisjointError("target boundary revision contains an unknown or repeated case")
        actual_matches = capture["oracle"].get("matches", [])
        if len(actual_matches) != 1:
            raise UiDisjointError("target boundary revision is only valid for a unique positive target")
        extents = actual_matches[0].get("extents", {})
        expected_original = {"left": extents.get("x"), "top": extents.get("y"), "width": extents.get("width"), "height": extents.get("height")}
        if item.get("sourceStateId") != capture["sourceStateId"] or item.get("sourceSha256") != capture["sourceSha256"] or item.get("imageSha256") != capture["imageSha256"] or item.get("originalAtspiBounds") != expected_original:
            raise UiDisjointError("target boundary revision does not bind to the preregistered source and captured positive")
        rect = item.get("correctedXtestBounds")
        if not isinstance(rect, dict) or set(rect) != {"left", "top", "width", "height"} or any(type(rect[key]) is not int for key in rect) or rect["width"] <= 0 or rect["height"] <= 0:
            raise UiDisjointError("target boundary revision has an invalid corrected rectangle")
        if rect["left"] < 0 or rect["top"] < 0 or rect["left"] + rect["width"] > WIDTH or rect["top"] + rect["height"] > HEIGHT:
            raise UiDisjointError("corrected target rectangle falls outside the registered screen")
        if item.get("target") != capture["target"] or not item.get("evidence"):
            raise UiDisjointError("target boundary revision target/evidence does not match the frozen row")
        corrections[case_id] = rect
    return corrections, revision


def _csv_rows() -> tuple[tuple[tuple[str, ...], ...], ...]:
    headers = ("index", "region", "period", "count", "rate", "status", "group", "total", "change", "note", "score", "rank")
    out: list[tuple[tuple[str, ...], ...]] = []
    shapes = ((36, 8), (28, 10), (44, 6), (32, 12), (52, 5))
    labels = ("cedar", "north", "amber", "station", "catalog")
    for sheet_index, (row_count, col_count) in enumerate(shapes):
        rows = [tuple(headers[:col_count])]
        for row in range(1, row_count + 1):
            values = [str(row), f"{labels[sheet_index]}-{(row % 7) + 1}", f"p{(row % 4) + 1}", str((row * 7 + sheet_index * 3) % 41 + 1), str((row * 13 + 5) % 100), ("steady", "rising", "level", "falling")[row % 4], f"set-{(row % 5) + 1}", str(row * 11 + 2), str((row * 3 + 2) % 23), f"memo-{row % 6}", str((row * 17 + 9) % 101), str((row + 2) % 8 + 1)]
            rows.append(tuple(values[:col_count]))
        out.append(tuple(rows))
    return tuple(out)


def make_pdf(page_sizes: tuple[tuple[int, int], ...], variant: int) -> bytes:
    """Create a tiny authored PDF with varied page count, ratio, and neutral vector content."""
    objects: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>", b""]
    page_ids: list[int] = []
    font_id = 3 + 2 * len(page_sizes)
    next_id = 3
    for page_index, (width, height) in enumerate(page_sizes, start=1):
        page_id, content_id = next_id, next_id + 1
        next_id += 2
        page_ids.append(page_id)
        text = f"BT /F1 16 Tf 48 {height - 58} Td (Reading sheet {variant}-{page_index}) Tj 0 -28 Td (Station {page_index}) Tj 0 -22 Td (Units {variant + page_index * 3}) Tj ET\n"
        content = text.encode("ascii")
        objects.extend(
            [
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>".encode(),
                f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream",
            ]
        )
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(f'{value} 0 R' for value in page_ids)}] /Count {len(page_ids)} >>".encode()
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    output = bytearray(b"%PDF-1.4\n% self-authored neutral source state\n")
    offsets = [0]
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


def private_converter_env(profile: Path) -> dict[str, str]:
    for name in ("home", "config", "data", "cache", "state", "runtime"):
        (profile / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(profile / "home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "XDG_CONFIG_HOME": str(profile / "config"),
        "XDG_DATA_HOME": str(profile / "data"),
        "XDG_CACHE_HOME": str(profile / "cache"),
        "XDG_STATE_HOME": str(profile / "state"),
        "XDG_RUNTIME_DIR": str(profile / "runtime"),
        "XDG_DATA_DIRS": f"{PACKAGE_ROOT / 'usr/share'}:/usr/local/share:/usr/share",
        "GSETTINGS_BACKEND": "memory",
        "GNUMERIC_DATA_DIR": str(PACKAGE_ROOT / "usr/share/gnumeric/1.12.56"),
        "GNM_PLUGIN_PATH": str(PACKAGE_ROOT / "usr/lib/gnumeric/1.12.56/plugins"),
        "LD_LIBRARY_PATH": ":".join(str(p) for p in (PACKAGE_ROOT / "usr/lib", PACKAGE_ROOT / "usr/lib/x86_64-linux-gnu", PACKAGE_ROOT / "lib/x86_64-linux-gnu")),
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def build_authored_inputs(bundle: Path) -> dict[str, Any]:
    bundle = _require_new_output(bundle, ARTIFACT_ROOT)
    bundle.mkdir(mode=0o700, parents=True, exist_ok=False)
    private = bundle / "private"
    source_dir = private / "authored-source"
    app_input = private / "app-inputs"
    profiles = private / "profiles" / "converter"
    for path in (source_dir, app_input, profiles):
        path.mkdir(mode=0o700, parents=True, exist_ok=False)
    gnumeric_dir = source_dir / "gnumeric"
    evince_dir = source_dir / "evince"
    gnumeric_dir.mkdir(mode=0o700)
    evince_dir.mkdir(mode=0o700)
    input_rows: dict[str, dict[str, Any]] = {}
    for index, rows in enumerate(_csv_rows(), start=1):
        case = CASES[index - 1]
        csv_path = gnumeric_dir / f"grid-{index:02}.csv"
        csv_data = "\n".join(",".join(row) for row in rows) + "\n"
        csv_path.write_text(csv_data, encoding="utf-8", newline="")
        target = app_input / case["source"]
        command = [str(PACKAGE_ROOT / "usr/bin/ssconvert"), str(csv_path), str(target)]
        completed = subprocess.run(command, env=private_converter_env(profiles / case["slot"]), cwd=private, capture_output=True, text=True, timeout=30, check=False)
        log_root = private / "logs" / "converter"
        log_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        (log_root / f"{case['slot']}.stdout.log").write_bytes(completed.stdout.encode()[:MAX_LOG_BYTES])
        (log_root / f"{case['slot']}.stderr.log").write_bytes(completed.stderr.encode()[:MAX_LOG_BYTES])
        if completed.returncode != 0 or not target.is_file():
            raise UiDisjointError(f"private ssconvert failed for {case['slot']}: exit={completed.returncode}")
        input_rows[case["slot"]] = {"path": target.relative_to(private).as_posix(), "sourceSha256": hash_file(target), "sourceBytes": target.stat().st_size, "authoredSha256": sha256(csv_data.encode())}
    pdf_sizes = (((612, 792),), ((792, 612), (792, 612)), ((540, 720),) * 3, ((720, 540),) * 4, ((600, 600),) * 5)
    for index, sizes in enumerate(pdf_sizes, start=1):
        case = CASES[index + 4]
        pdf = make_pdf(sizes, index)
        path = app_input / case["source"]
        path.write_bytes(pdf)
        input_rows[case["slot"]] = {"path": path.relative_to(private).as_posix(), "sourceSha256": sha256(pdf), "sourceBytes": len(pdf), "pages": len(sizes), "pageSizesPoints": [list(item) for item in sizes], "authoredSha256": sha256(pdf)}

    rows: list[dict[str, Any]] = []
    for case in CASES:
        case_id = str(uuid.uuid5(NAMESPACE, f"{SEED}:{case['slot']}:case"))
        state_id = str(uuid.uuid5(NAMESPACE, f"{SEED}:{case['slot']}:state"))
        authored = input_rows[case["slot"]]
        rows.append({
            "caseId": case_id,
            "sourceStateId": state_id,
            "sourceGroup": case["app"],
            "expectedPresence": case["presence"],
            "target": {"role": case["role"], "name": case["name"], "query": case["query"]},
            "sourceState": case["state"],
            "actions": list(case.get("actions", [])),
            "launchArgs": list(case.get("launchArgs", [])),
            "authored": {"relativePath": authored["path"], "sourceSha256": authored["sourceSha256"], "sourceBytes": authored["sourceBytes"], **{key: value for key, value in authored.items() if key not in {"path", "sourceSha256", "sourceBytes"}}},
        })
    manifest = {
        "schema": "h8a-disjoint-ui-state-manifest-v1",
        "profileId": "h8a-disjoint-ui-dev40-v2",
        "seed": SEED,
        "viewport": {"width": WIDTH, "height": HEIGHT},
        "quotas": {"gnumeric": {"present": 4, "absent": 1}, "evince": {"present": 3, "absent": 2}},
        "runtimePackageLock": {"path": str((ARTIFACT_ROOT / "package-license-lock.json").relative_to(ARTIFACTS_ROOT)), "sha256": hash_file(ARTIFACT_ROOT / "package-license-lock.json")},
        "themeProfile": {"gtkTheme": "Yaru", "iconTheme": "Adwaita", "fontFamily": "DejaVu Sans", "windowManager": "Openbox 3.6.1-12build5"},
        "priorFrameExclusion": {"path": str(OLD_FRAMES.relative_to(ARTIFACTS_ROOT)), "sha256": hash_file(OLD_FRAMES), "cutoffHammingInclusive": 4},
        "duplicatePolicy": {"rejectExactEncodedSha256": True, "rejectExactRgbSha256": True, "rejectPriorOrPeerPHashHammingAtMost": 4, "noReplacementAfterPixels": True},
        "sourceRules": ["all ten states are independently authored and have unique source-state and case IDs", "all source files remain private and apps receive only a neutral basename from per-case tmpfs", "AT-SPI inventory is the sole pre-capture oracle; every negative requires complete inventory and rejects any positive-area visible intersection with the viewport and app/dialog window", "positive targets require one unique fully visible node; any other partial match rejects as ambiguous", "registered order and targets are immutable after any screenshot capture"],
        "rows": rows,
    }
    manifest_hash = write_json_new(private / "state-manifest.json", manifest)
    return {"manifestSha256": manifest_hash, "caseCount": len(rows), "sourceFiles": len(input_rows)}


def _atspi_inventory(expected_app: str) -> dict[str, Any]:
    import pyatspi

    desktop = pyatspi.Registry.getDesktop(0)
    applications: list[Any] = []
    errors: list[str] = []
    stack: list[tuple[Any, int]] = [(desktop, 0)]
    searched = 0
    while stack:
        node, depth = stack.pop()
        searched += 1
        if searched > 6000 or depth > 64:
            errors.append("application traversal cap exceeded")
            break
        try:
            if node.getRoleName() == "application" and (node.name or "").casefold() == expected_app:
                applications.append(node)
            children = [node.getChildAtIndex(i) for i in range(min(node.childCount, 512))]
            stack.extend((child, depth + 1) for child in reversed(children))
        except Exception as error:  # record traversal failure; do not turn it into semantic absence
            errors.append(type(error).__name__)
    nodes: list[dict[str, Any]] = []
    for app_index, app in enumerate(applications):
        stack2: list[tuple[Any, int, tuple[int, ...]]] = [(app, 0, ())]
        seen = 0
        while stack2:
            node, depth, child_path = stack2.pop()
            seen += 1
            if seen > 2500 or depth > 64:
                errors.append("accessible inventory cap exceeded")
                break
            try:
                state = node.getState()
                showing = state.contains(pyatspi.STATE_SHOWING)
                visible = state.contains(pyatspi.STATE_VISIBLE)
                extents = None
                try:
                    component = node.queryComponent()
                    rect = component.getExtents(pyatspi.DESKTOP_COORDS)
                    extents = {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
                except Exception:
                    pass
                item = {"applicationIndex": app_index, "depth": depth, "role": node.getRoleName(), "name": node.name or "", "showing": showing, "visible": visible, "extents": extents}
                if os.environ.get("ZORYA_UI_INCLUDE_CHILD_PATHS") == "1":
                    item["childPath"] = list(child_path)
                nodes.append(item)
                children = [node.getChildAtIndex(i) for i in range(min(node.childCount, 512))]
                stack2.extend((child, depth + 1, child_path + (index,)) for index, child in reversed(list(enumerate(children))))
            except Exception as error:
                errors.append(type(error).__name__)
    frames = [node for node in nodes if node["role"] == "frame" and node["showing"] and node["visible"] and node["extents"]]
    frame = frames[0]["extents"] if len(frames) == 1 else None
    auxiliary = [node["extents"] for node in nodes if node["role"] in {"dialog", "file chooser"} and node["showing"] and node["visible"] and isinstance(node["extents"], dict)]
    return {"complete": not errors, "traversalErrors": errors, "expectedApplicationName": expected_app, "applicationMatchCount": len(applications), "nodes": nodes, "appFrameExtents": frame, "visibleAuxiliaryWindowExtents": auxiliary, "viewport": {"x": 0, "y": 0, "width": WIDTH, "height": HEIGHT}}


def _component_hit_tests(expected_app: str, target: dict[str, str]) -> list[dict[str, Any]]:
    """Probe native AT-SPI Component hit testing independently of reported extents."""
    import pyatspi

    desktop = pyatspi.Registry.getDesktop(0)
    apps = [desktop.getChildAtIndex(i) for i in range(min(desktop.childCount, 512))]
    app = next((node for node in apps if node.getRoleName() == "application" and (node.name or "").casefold() == expected_app), None)
    if app is None:
        raise UiDisjointError("component hit-test could not find the expected application")
    stack: list[tuple[Any, tuple[int, ...]]] = [(app, ())]
    output: list[dict[str, Any]] = []
    while stack:
        node, child_path = stack.pop()
        if node.getRoleName() == target["role"] and (node.name or "") == target["name"]:
            state = node.getState()
            if state.contains(pyatspi.STATE_SHOWING) and state.contains(pyatspi.STATE_VISIBLE):
                component = node.queryComponent()
                rect = component.getExtents(pyatspi.DESKTOP_COORDS)
                extents = {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
                if rect.width > 0 and rect.height > 0:
                    points = {
                        "topLeft": (rect.x, rect.y),
                        "topRightInside": (rect.x + rect.width - 1, rect.y),
                        "bottomLeftInside": (rect.x, rect.y + rect.height - 1),
                        "bottomRightInside": (rect.x + rect.width - 1, rect.y + rect.height - 1),
                        "center": (rect.x + rect.width // 2, rect.y + rect.height // 2),
                        "leftOutside": (rect.x - 1, rect.y + rect.height // 2),
                        "rightOutside": (rect.x + rect.width, rect.y + rect.height // 2),
                        "topOutside": (rect.x + rect.width // 2, rect.y - 1),
                        "bottomOutside": (rect.x + rect.width // 2, rect.y + rect.height),
                    }
                    results = {name: {"x": xy[0], "y": xy[1], "inside": bool(component.contains(xy[0], xy[1], pyatspi.DESKTOP_COORDS))} for name, xy in points.items()}
                else:
                    results = {}
                output.append({"role": target["role"], "name": target["name"], "childPath": list(child_path), "extents": extents, "componentContains": results})
        children = [node.getChildAtIndex(i) for i in range(min(node.childCount, 512))]
        stack.extend((child, child_path + (index,)) for index, child in reversed(list(enumerate(children))))
    return output


def _selected_page_tabs(expected_app: str) -> list[dict[str, Any]]:
    import pyatspi

    desktop = pyatspi.Registry.getDesktop(0)
    apps = [desktop.getChildAtIndex(i) for i in range(min(desktop.childCount, 512))]
    app = next((node for node in apps if node.getRoleName() == "application" and (node.name or "").casefold() == expected_app), None)
    if app is None:
        raise UiDisjointError("selected-tab probe could not find the expected application")
    selected: list[dict[str, Any]] = []
    stack: list[tuple[Any, tuple[int, ...]]] = [(app, ())]
    while stack:
        node, child_path = stack.pop()
        state = node.getState()
        if node.getRoleName() == "page tab" and state.contains(pyatspi.STATE_SELECTED):
            component = node.queryComponent()
            rect = component.getExtents(pyatspi.DESKTOP_COORDS)
            selected.append({"name": node.name or "", "childPath": list(child_path), "extents": {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}})
        children = [node.getChildAtIndex(i) for i in range(min(node.childCount, 512))]
        stack.extend((child, child_path + (index,)) for index, child in reversed(list(enumerate(children))))
    return selected


def _tab_state_at_path(expected_app: str, child_path: list[int]) -> dict[str, Any]:
    import pyatspi

    desktop = pyatspi.Registry.getDesktop(0)
    apps = [desktop.getChildAtIndex(i) for i in range(min(desktop.childCount, 512))]
    node = next((item for item in apps if item.getRoleName() == "application" and (item.name or "").casefold() == expected_app), None)
    if node is None:
        raise UiDisjointError("XTest tab state lookup could not find the expected application")
    for index in child_path:
        if index < 0 or index >= node.childCount:
            raise UiDisjointError("XTest tab child path left the accessible tree")
        node = node.getChildAtIndex(index)
    state = node.getState()
    component = node.queryComponent()
    rect = component.getExtents(pyatspi.DESKTOP_COORDS)
    return {"name": node.name or "", "role": node.getRoleName(), "selected": state.contains(pyatspi.STATE_SELECTED), "showing": state.contains(pyatspi.STATE_SHOWING), "visible": state.contains(pyatspi.STATE_VISIBLE), "extents": {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}}


def _atspi_activate_sidebar_toggle(expected_app: str, env: dict[str, str]) -> dict[str, Any]:
    import pyatspi

    desktop = pyatspi.Registry.getDesktop(0)
    stack = [(desktop, 0)]
    app = None
    while stack:
        node, depth = stack.pop()
        if depth > 64:
            raise UiDisjointError("AT-SPI action search exceeded depth cap")
        if node.getRoleName() == "application" and (node.name or "").casefold() == expected_app:
            app = node
            break
        stack.extend((node.getChildAtIndex(i), depth + 1) for i in reversed(range(min(node.childCount, 512))))
    if app is None:
        raise UiDisjointError("AT-SPI application missing before sidebar action")
    stack2 = [(app, 0)]
    candidates = []
    while stack2:
        node, depth = stack2.pop()
        if depth > 64:
            raise UiDisjointError("AT-SPI action traversal exceeded depth cap")
        states = node.getState()
        if node.getRoleName() == "toggle button" and not (node.name or "") and states.contains(pyatspi.STATE_SHOWING) and states.contains(pyatspi.STATE_VISIBLE):
            candidates.append(node)
        stack2.extend((node.getChildAtIndex(i), depth + 1) for i in reversed(range(min(node.childCount, 512))))
    if len(candidates) != 1:
        raise UiDisjointError(f"expected one unnamed visible sidebar toggle, got {len(candidates)}")
    component = candidates[0].queryComponent()
    rect = component.getExtents(pyatspi.DESKTOP_COORDS)
    if rect.x < 0 or rect.y < 0 or rect.width <= 0 or rect.height <= 0:
        raise UiDisjointError("sidebar control has invalid screen extents")
    x, y = rect.x + rect.width // 2, rect.y + rect.height // 2
    subprocess.run(["xdotool", "mousemove", "--sync", str(x), str(y), "click", "1"], env=env, capture_output=True, timeout=3, check=True)
    return {"method": "mouse-click-AT-SPI-extents", "center": {"x": x, "y": y}, "accessibleName": ""}


def evaluate_oracle(inventory: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    if inventory.get("complete") is not True:
        raise UiDisjointError("AT-SPI inventory is incomplete")
    if inventory.get("applicationMatchCount") != 1 or not isinstance(inventory.get("appFrameExtents"), dict):
        raise UiDisjointError("expected exactly one visible application frame")
    frame = inventory["appFrameExtents"]
    if frame["x"] < 0 or frame["y"] < 0 or frame["x"] + frame["width"] > WIDTH or frame["y"] + frame["height"] > HEIGHT or frame["width"] <= 0 or frame["height"] <= 0:
        raise UiDisjointError("visible application frame is clipped by the viewport")
    target = row["target"]
    scopes = [frame, *inventory.get("visibleAuxiliaryWindowExtents", [])]
    viewport = inventory.get("viewport")
    if not isinstance(viewport, dict) or any(not isinstance(viewport.get(key), int) for key in ("x", "y", "width", "height")) or viewport["width"] <= 0 or viewport["height"] <= 0:
        raise UiDisjointError("viewport extents are missing or invalid")
    candidates = [node for node in inventory["nodes"] if node["role"] == target["role"] and node["name"] == target["name"] and node["showing"] and node["visible"] and isinstance(node["extents"], dict) and _intersects(node["extents"], viewport) and any(_intersects(node["extents"], scope) for scope in scopes)]
    if row["expectedPresence"] == "present":
        if len(candidates) != 1:
            raise UiDisjointError(f"positive target visible/partial match count is {len(candidates)}, expected one")
        match = candidates[0]
        if not _inside(match["extents"], viewport) or not any(_inside(match["extents"], scope) for scope in scopes):
            raise UiDisjointError("positive target is partially clipped by the viewport or its window")
    if row["expectedPresence"] == "absent" and candidates:
        raise UiDisjointError(f"negative target visible/partial match count is {len(candidates)}, expected zero")
    if row["expectedPresence"] not in {"present", "absent"}:
        raise UiDisjointError("invalid expected presence")
    return {"matchCount": len(candidates), "matches": candidates, "inventorySha256": inventory_digest(inventory), "frameExtents": frame}


def _inside(rect: dict[str, int], frame: dict[str, int]) -> bool:
    return rect["width"] > 0 and rect["height"] > 0 and rect["x"] >= frame["x"] and rect["y"] >= frame["y"] and rect["x"] + rect["width"] <= frame["x"] + frame["width"] and rect["y"] + rect["height"] <= frame["y"] + frame["height"]


def _intersects(rect: dict[str, int], frame: dict[str, int]) -> bool:
    return rect["width"] > 0 and rect["height"] > 0 and frame["width"] > 0 and frame["height"] > 0 and rect["x"] < frame["x"] + frame["width"] and frame["x"] < rect["x"] + rect["width"] and rect["y"] < frame["y"] + frame["height"] and frame["y"] < rect["y"] + rect["height"]


def inventory_digest(inventory: dict[str, Any]) -> str:
    return sha256(json.dumps(inventory, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def _create_profile(bundle: Path, phase: str, case_id: str) -> Path:
    root = bundle / "private" / "profiles" / phase / case_id
    if root.exists():
        raise UiDisjointError("private UI profile already exists")
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ("home", "config", "data", "cache", "state", "runtime"):
        (root / name).mkdir(mode=0o700)
    return root


def _profile_tree_fingerprint(root: Path) -> str:
    rows: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            rows.append({"path": path.relative_to(root).as_posix(), "kind": "symlink", "target": os.readlink(path)})
        elif path.is_dir():
            stat = path.stat()
            rows.append({"path": path.relative_to(root).as_posix(), "kind": "dir", "mode": stat.st_mode & 0o777, "mtimeNs": stat.st_mtime_ns, "ctimeNs": stat.st_ctime_ns})
        elif path.is_file():
            stat = path.stat()
            rows.append({"path": path.relative_to(root).as_posix(), "kind": "file", "mode": stat.st_mode & 0o777, "size": stat.st_size, "mtimeNs": stat.st_mtime_ns, "ctimeNs": stat.st_ctime_ns, "sha256": hash_file(path)})
        else:
            rows.append({"path": path.relative_to(root).as_posix(), "kind": "other"})
    return sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode())


def _app_env(profile: Path, *, display: str, xauthority: str, bus: str, neutral: Path) -> dict[str, str]:
    root = PACKAGE_ROOT
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(profile / "home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "LC_CTYPE": "C.UTF-8",
        "DISPLAY": display,
        "XAUTHORITY": xauthority,
        "DBUS_SESSION_BUS_ADDRESS": bus,
        "XDG_CONFIG_HOME": str(profile / "config"),
        "XDG_DATA_HOME": str(profile / "data"),
        "XDG_CACHE_HOME": str(profile / "cache"),
        "XDG_STATE_HOME": str(profile / "state"),
        "XDG_RUNTIME_DIR": str(neutral.parent),
        "TMPDIR": str(neutral.parent),
        "XDG_DATA_DIRS": f"{PACKAGE_ROOT / 'usr/share'}:/usr/local/share:/usr/share",
        "GTK_THEME": "Yaru",
        "GTK_ICON_THEME": "Adwaita",
        "GTK_MODULES": "atk-bridge",
        "GTK_A11Y": "always",
        "GTK_USE_PORTAL": "0",
        "GDK_BACKEND": "x11",
        "GSETTINGS_SCHEMA_DIR": str(ARTIFACT_ROOT / "runtime-schemas"),
        "GNUMERIC_DATA_DIR": str(root / "usr/share/gnumeric/1.12.56"),
        "GNM_PLUGIN_PATH": str(root / "usr/lib/gnumeric/1.12.56/plugins"),
        "LD_LIBRARY_PATH": ":".join(str(p) for p in (root / "usr/lib", root / "usr/lib/x86_64-linux-gnu", root / "lib/x86_64-linux-gnu")),
        "PYTHONDONTWRITEBYTECODE": "1",
        "ZORYA_UI_NEUTRAL_ROOT": str(neutral),
    }
    if profile.name.startswith("probe"):
        raise UiDisjointError("unexpected profile identity")
    return env


class _BoundedDrain:
    def __init__(self, stream: Any, path: Path) -> None:
        self.stream = stream
        self.path = path
        self.digest = hashlib.sha256()
        self.total = 0
        self.saved = 0
        self.thread = threading.Thread(target=self._run, daemon=False)

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        with self.path.open("xb") as out:
            while True:
                block = self.stream.read(4096)
                if not block:
                    break
                self.digest.update(block)
                self.total += len(block)
                keep = block[:max(0, MAX_LOG_BYTES - self.saved)]
                if keep:
                    out.write(keep)
                    self.saved += len(keep)

    def receipt(self) -> dict[str, Any]:
        return {"observedBytes": self.total, "storedBytes": self.saved, "truncated": self.total > self.saved, "sha256": self.digest.hexdigest()}


def _kill_process_group(proc: subprocess.Popen[bytes] | None) -> bool:
    if proc is None or proc.poll() is not None:
        return True
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)
    return proc.poll() is not None


def _worker(bundle_s: str, case_id: str, phase: str, approved_digest: str | None) -> int:
    bundle = _require_existing_path(bundle_s, ARTIFACT_ROOT, directory=True)
    manifest = json.loads((bundle / "private/state-manifest.json").read_text())
    row = next(item for item in manifest["rows"] if item["caseId"] == case_id)
    runtime_root = Path(os.environ["ZORYA_UI_NEUTRAL_ROOT"])
    if not os.path.ismount(runtime_root) or not legacy._is_private_tmpfs_mount(runtime_root):
        raise UiDisjointError("case neutral root is not mounted tmpfs")
    private = bundle / "private"
    source = private / row["authored"]["relativePath"]
    if source.is_symlink() or not source.is_file() or hash_file(source) != row["authored"]["sourceSha256"]:
        raise UiDisjointError("authored case input failed pinned path/hash validation")
    app_input = runtime_root / ("record.gnumeric" if row["sourceGroup"] == "gnumeric" else "viewer.pdf")
    shutil.copyfile(source, app_input)
    profile = Path(os.environ["ZORYA_UI_PRIVATE_PROFILE"])
    profile_for_app = Path(os.environ.get("ZORYA_UI_PROFILE_ALIAS", str(profile)))
    env = _app_env(profile_for_app, display=os.environ["DISPLAY"], xauthority=os.environ.get("XAUTHORITY", ""), bus=os.environ["DBUS_SESSION_BUS_ADDRESS"], neutral=runtime_root)
    if phase.startswith("diagnostic-path-"):
        os.environ["ZORYA_UI_INCLUDE_CHILD_PATHS"] = "1"
        env["ZORYA_UI_INCLUDE_CHILD_PATHS"] = "1"
    subprocess.run(["gsettings", "set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"], env=env, check=False, timeout=5, capture_output=True)
    time.sleep(0.15)
    exe = PACKAGE_ROOT / ("usr/bin/gnumeric" if row["sourceGroup"] == "gnumeric" else "usr/bin/evince")
    if row["sourceGroup"] == "evince":
        env["EV_BACKENDS_DIR"] = str(PACKAGE_ROOT / "usr/lib/x86_64-linux-gnu/evince/4/backends")
    log_dir = private / "logs" / phase / case_id
    log_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    proc = subprocess.Popen([str(exe), *row.get("launchArgs", []), str(app_input)], env=env, cwd=runtime_root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    assert proc.stdout is not None and proc.stderr is not None
    stdout = _BoundedDrain(proc.stdout, log_dir / "app.stdout.log")
    stderr = _BoundedDrain(proc.stderr, log_dir / "app.stderr.log")
    stdout.start(); stderr.start()
    try:
        time.sleep(1.0)
        if row.get("actions"):
            window_pattern = "Gnumeric" if row["sourceGroup"] == "gnumeric" else "viewer.pdf"
            windows = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", window_pattern], env=env, capture_output=True, text=True, timeout=3, check=False)
            window_ids = windows.stdout.split()
            if windows.returncode != 0 or not window_ids:
                raise UiDisjointError("cannot locate the owned application window for the preregistered UI action")
            window_id = window_ids[-1]
            subprocess.run(["xdotool", "windowactivate", "--sync", window_id], env=env, capture_output=True, timeout=3, check=True)
            active = subprocess.run(["xdotool", "getwindowfocus"], env=env, capture_output=True, text=True, timeout=3, check=True).stdout.strip()
            if active != window_id:
                raise UiDisjointError("the owned application window did not receive keyboard focus")
            performed_actions = []
            for action in row["actions"]:
                if action == "atspi:activate-sidebar-toggle":
                    performed_actions.append({"action": action, "activation": _atspi_activate_sidebar_toggle(row["sourceGroup"], env)})
                else:
                    subprocess.run(["xdotool", "key", "--clearmodifiers", action], env=env, capture_output=True, timeout=3, check=True)
                    performed_actions.append({"action": action, "accessibleActions": []})
                time.sleep(0.6)
        else:
            performed_actions = []
        deadline = time.monotonic() + 12
        inventory = None
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise UiDisjointError(f"application exited before AT-SPI inventory: {proc.returncode}")
            try:
                inventory = _atspi_inventory(row["sourceGroup"])
                if inventory["complete"] and inventory["applicationMatchCount"] == 1 and isinstance(inventory["appFrameExtents"], dict):
                    break
            except Exception:
                time.sleep(0.25)
            time.sleep(0.25)
        if inventory is None or not inventory.get("complete") or inventory.get("applicationMatchCount") != 1:
            raise UiDisjointError("timed out waiting for complete accessible app frame")
        try:
            oracle = evaluate_oracle(inventory, row)
        except UiDisjointError as error:
            failure = {"caseId": case_id, "status": "target-oracle-rejected", "target": row["target"], "expectedPresence": row["expectedPresence"], "error": str(error), "inventory": inventory}
            write_json_new(private / "runtime" / phase / case_id / "target-oracle-rejection.json", failure)
            raise
        if phase.startswith("capture"):
            if oracle["inventorySha256"] != approved_digest:
                raise UiDisjointError("capture AT-SPI inventory differs from reviewed preflight")
            from PIL import ImageGrab
            image = ImageGrab.grab().convert("RGB")
            if image.size != (WIDTH, HEIGHT):
                raise UiDisjointError(f"screenshot canvas mismatch: {image.size}")
            rgb = image.tobytes()
            phash = perceptual_hash64_from_rgb(rgb, WIDTH, HEIGHT)
            import io
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=False)
            png = output.getvalue()
            if len(png) > MAX_PNG_BYTES:
                raise UiDisjointError("screenshot exceeds byte cap")
            post = _atspi_inventory(row["sourceGroup"])
            post_oracle = evaluate_oracle(post, row)
            if post_oracle["inventorySha256"] != oracle["inventorySha256"]:
                raise UiDisjointError("accessible state changed during screenshot capture")
            screenshot_dir = private / "screenshots"
            screenshot_dir.mkdir(mode=0o700, exist_ok=True)
            screenshot_path = screenshot_dir / f"{case_id}.png"
            with screenshot_path.open("xb") as handle:
                handle.write(png)
                handle.flush(); os.fsync(handle.fileno())
            report = {"caseId": case_id, "status": "captured", "imagePath": screenshot_path.relative_to(bundle).as_posix(), "imageSha256": sha256(png), "rgbSha256": sha256(rgb), "perceptualHash": f"{phash:016x}", "width": WIDTH, "height": HEIGHT, "target": row["target"], "expectedPresence": row["expectedPresence"], "oracle": oracle, "postCaptureInventorySha256": post_oracle["inventorySha256"]}
        else:
            report = {"caseId": case_id, "status": "preflight", "target": row["target"], "expectedPresence": row["expectedPresence"], "oracle": oracle, "inventory": inventory, "performedActions": performed_actions, "screenshotsCaptured": False, "providerCalls": 0}
            if phase.startswith("diagnostic-"):
                report["componentHitTests"] = _component_hit_tests(row["sourceGroup"], row["target"])
                after_hit_test = _atspi_inventory(row["sourceGroup"])
                report["postHitTestInventorySha256"] = inventory_digest(after_hit_test)
                report["stateStableDuringHitTest"] = report["postHitTestInventorySha256"] == oracle["inventorySha256"]
            click_point_raw = os.environ.get("ZORYA_UI_XTEST_POINT")
            if click_point_raw:
                point = json.loads(click_point_raw)
                if set(point) != {"x", "y"} or not all(isinstance(point[key], int) for key in ("x", "y")):
                    raise UiDisjointError("XTest click point is malformed")
                if os.environ.get("ZORYA_UI_EXPECTED_INVENTORY_SHA256") != oracle["inventorySha256"]:
                    raise UiDisjointError("XTest probe baseline does not match the approved preflight inventory")
                before_tabs = _selected_page_tabs(row["sourceGroup"])
                private_input_sha_before = hash_file(app_input)
                subprocess.run(["xdotool", "mousemove", "--sync", str(point["x"]), str(point["y"]), "click", "1"], env=env, capture_output=True, timeout=3, check=True)
                time.sleep(0.3)
                after_click = _atspi_inventory(row["sourceGroup"])
                report["physicalXTestProbe"] = {"point": point, "method": "XTest pointer motion plus primary-button event", "beforeInventorySha256": oracle["inventorySha256"], "afterInventorySha256": inventory_digest(after_click), "privateInputSha256BeforeClick": private_input_sha_before, "privateInputSha256AfterClick": hash_file(app_input), "beforeSelectedTabs": before_tabs, "afterSelectedTabs": _selected_page_tabs(row["sourceGroup"]), "targetNodesAfterClick": [node for node in after_click["nodes"] if node["role"] == row["target"]["role"] and node["name"] == row["target"]["name"] and node["showing"] and node["visible"]], "visibleAuxiliaryWindowExtentsAfterClick": after_click["visibleAuxiliaryWindowExtents"], "visibleNamedNodesAfterClick": [{key: node.get(key) for key in ("role", "name", "extents")} for node in after_click["nodes"] if node["showing"] and node["visible"] and node["name"] and isinstance(node["extents"], dict)][:80], "screenshotsCaptured": False, "providerCalls": 0}
            sweep_raw = os.environ.get("ZORYA_UI_XTEST_SWEEP_JSON")
            if sweep_raw:
                sweep = json.loads(sweep_raw)
                reset = sweep.get("resetPoint")
                points = sweep.get("points")
                reset_path = sweep.get("resetTabPath")
                target_path = sweep.get("targetTabPath")
                if not isinstance(reset, dict) or not isinstance(points, list) or not points or not isinstance(reset_path, list) or not isinstance(target_path, list):
                    raise UiDisjointError("XTest sweep is malformed")
                if set(reset) != {"x", "y"} or not all(isinstance(reset[key], int) for key in ("x", "y")):
                    raise UiDisjointError("XTest reset point is malformed")
                if os.environ.get("ZORYA_UI_EXPECTED_INVENTORY_SHA256") != oracle["inventorySha256"]:
                    raise UiDisjointError("XTest sweep baseline does not match the approved preflight inventory")
                reset_click = ["xdotool", "mousemove", "--sync", str(reset["x"]), str(reset["y"]), "click", "1"]
                sweep_rows = []
                for point in points:
                    if set(point) != {"x", "y"} or not all(isinstance(point[key], int) for key in ("x", "y")):
                        raise UiDisjointError("XTest sweep contains an invalid point")
                    subprocess.run(reset_click, env=env, capture_output=True, timeout=3, check=True)
                    time.sleep(0.2)
                    reset_state = _tab_state_at_path(row["sourceGroup"], reset_path)
                    target_before = _tab_state_at_path(row["sourceGroup"], target_path)
                    if reset_state["name"] != "Number" or not reset_state["selected"] or target_before["name"] != row["target"]["name"] or target_before["selected"]:
                        raise UiDisjointError("XTest sweep did not restore the native Number tab selection")
                    subprocess.run(["xdotool", "mousemove", "--sync", str(point["x"]), str(point["y"]), "click", "1"], env=env, capture_output=True, timeout=3, check=True)
                    time.sleep(0.12)
                    target_after = _tab_state_at_path(row["sourceGroup"], target_path)
                    reset_after = _tab_state_at_path(row["sourceGroup"], reset_path)
                    sweep_rows.append({"point": point, "resetPoint": reset, "resetTabState": reset_state, "targetTabBefore": target_before, "targetTabAfter": target_after, "resetTabAfterClick": reset_after})
                report["physicalXTestSweep"] = {"method": "XTest primary-button clicks; reset tab selection before each point", "expectedBaselineInventorySha256": oracle["inventorySha256"], "points": sweep_rows, "screenshotsCaptured": False, "providerCalls": 0}
    finally:
        app_closed = _kill_process_group(proc)
        stdout.thread.join(timeout=5); stderr.thread.join(timeout=5)
        if not app_closed or stdout.thread.is_alive() or stderr.thread.is_alive():
            raise UiDisjointError("owned app/log-reader process did not close cleanly")
    actual_ns = {name: os.readlink(f"/proc/self/ns/{name}") for name in ("net", "mnt", "pid")}
    host_ns = {name: os.environ[f"ZORYA_HOST_NS_{name.upper()}"] for name in ("net", "mnt", "pid")}
    if any(actual_ns[name] == host_ns[name] for name in actual_ns):
        raise UiDisjointError("worker is sharing a host net/mount/pid namespace")
    interfaces = sorted(name for _index, name in socket.if_nameindex())
    if interfaces != ["lo"]:
        raise UiDisjointError("isolated worker has an unexpected network interface")
    report["isolation"] = {"networkNamespace": actual_ns["net"], "mountNamespace": actual_ns["mnt"], "pidNamespace": actual_ns["pid"], "allDifferentFromHost": True, "networkInterfaces": interfaces, "hostNetworkNamespaceShared": False, "sourceInputTmpfs": True, "privateDbusSession": True, "privateXdgHome": str(profile_for_app / "home"), "profileStoragePath": str(profile), "profileAliasPath": str(profile_for_app) if profile_for_app != profile else None}
    report["ownedAppProcessClosed"] = app_closed
    report["ownedLogReadersClosed"] = not stdout.thread.is_alive() and not stderr.thread.is_alive()
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    return 0


def _owned_session(bundle: Path, row: dict[str, Any], phase: str, expected_digest: str | None, *, profile_alias_phase: str | None = None, xtest_point: dict[str, int] | None = None, xtest_sweep: dict[str, Any] | None = None) -> dict[str, Any]:
    case_id = row["caseId"]
    profile = _create_profile(bundle, phase, case_id)
    profile_alias = bundle / "private" / "profiles" / profile_alias_phase / case_id if profile_alias_phase else None
    alias_baseline = None
    if profile_alias is not None:
        if not profile_alias.is_dir() or profile_alias.is_symlink():
            raise UiDisjointError("profile alias target must be an existing owned directory")
        alias_baseline = _profile_tree_fingerprint(profile_alias)
    runtime_name = tempfile.mkdtemp(prefix="zui-")
    runtime = Path(runtime_name)
    runtime.chmod(0o700)
    marker = runtime / "owned-runtime-marker"
    marker.write_text(f"{os.getpid()} {case_id}\n")
    marker.chmod(0o600)
    neutral = runtime / "n"
    neutral.mkdir(mode=0o700)
    case_dir = bundle / "private" / "runtime" / phase / case_id
    case_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    display_file = case_dir / "display-number"
    worker_argv = [sys.executable, str(HERE / "ui_disjoint.py"), "_worker", str(bundle), case_id, phase, expected_digest or "", "--artifact-root", str(ARTIFACT_ROOT), "--artifacts-root", str(ARTIFACTS_ROOT), "--old-frames", str(OLD_FRAMES)]
    script_path = case_dir / "session.sh"
    with script_path.open("x", encoding="utf-8") as handle:
        wrapper = legacy.build_owned_session_wrapper_script(display_file=display_file, worker_argv=worker_argv, neutral_root=neutral)
        if profile_alias is not None:
            bind = f"mount --bind {legacy.sh_quote(str(profile))} {legacy.sh_quote(str(profile_alias))}\n"
            wrapper = wrapper.replace("mount --make-rprivate /\n", "mount --make-rprivate /\n" + bind, 1)
        handle.write(wrapper)
    script_path.chmod(0o700)
    env = private_converter_env(profile)
    env.update({"ZORYA_UI_PRIVATE_PROFILE": str(profile), "ZORYA_UI_NEUTRAL_ROOT": str(neutral)})
    if profile_alias is not None:
        env["ZORYA_UI_PROFILE_ALIAS"] = str(profile_alias)
    if xtest_point is not None:
        env["ZORYA_UI_XTEST_POINT"] = json.dumps(xtest_point, separators=(",", ":"))
        env["ZORYA_UI_EXPECTED_INVENTORY_SHA256"] = expected_digest or ""
    if xtest_sweep is not None:
        env["ZORYA_UI_XTEST_SWEEP_JSON"] = json.dumps(xtest_sweep, separators=(",", ":"))
        env["ZORYA_UI_EXPECTED_INVENTORY_SHA256"] = expected_digest or ""
    command = ["unshare", "--net", "--mount", "--pid", "--fork", "--kill-child", "--mount-proc", "--", "dbus-run-session", "--", "sh", str(script_path)]
    host_ids = {name: os.readlink(f"/proc/self/ns/{name}") for name in ("net", "mnt", "pid")}
    env.update({f"ZORYA_HOST_NS_{name.upper()}": value for name, value in host_ids.items()})
    proc = subprocess.Popen(command, env=env, cwd=bundle, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=CASE_SECONDS)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        raise UiDisjointError(f"case worker timed out: {case_id}")
    finally:
        if marker.is_file() and runtime.is_dir() and not runtime.is_symlink():
            shutil.rmtree(runtime)
    if profile_alias is not None and _profile_tree_fingerprint(profile_alias) != alias_baseline:
        raise UiDisjointError("profile alias changed its original owned target directory")
    if proc.returncode != 0:
        bounded_out, bounded_err = stdout[:MAX_LOG_BYTES], stderr[:MAX_LOG_BYTES]
        receipt_path = case_dir / "runner-failure.json"
        write_json_new(receipt_path, {"caseId": case_id, "returnCode": proc.returncode, "stdoutBytes": len(stdout), "stderrBytes": len(stderr), "stdoutSha256": sha256(stdout), "stderrSha256": sha256(stderr), "stdoutExcerpt": bounded_out.decode("utf-8", "replace"), "stderrExcerpt": bounded_err.decode("utf-8", "replace")})
        raise UiDisjointError(f"case worker failed: {case_id}; bounded receipt={receipt_path}")
    lines = [line for line in stdout.splitlines() if line.startswith(b"{")]
    if not lines:
        raise UiDisjointError(f"case worker emitted no receipt: {case_id}")
    receipt = json.loads(lines[-1].decode())
    return receipt


def cmd_prepare(args: argparse.Namespace) -> int:
    output_dir = _require_new_output(args.output_dir, ARTIFACT_ROOT)
    validate_runtime_inputs(need_converter=True)
    result = build_authored_inputs(output_dir)
    print(json.dumps(result, indent=2))
    return 0


def cmd_preflight(args: argparse.Namespace) -> int:
    bundle = _require_existing_path(args.bundle, ARTIFACT_ROOT, directory=True)
    validate_runtime_inputs()
    manifest_path = _require_existing_path(bundle / "private/state-manifest.json", bundle)
    raw = read_bounded_file_bytes(manifest_path, max_bytes=2 * 1024 * 1024, label="UI state manifest")[0]
    manifest = json.loads(raw)
    if sha256(raw) != args.approved_manifest_sha256:
        raise UiDisjointError("manifest hash does not match explicit reviewed hash")
    validate_roster(manifest)
    summary_output = _require_new_output(bundle / "private/preflight-summary.json", bundle)
    for row in manifest["rows"]:
        case_id = row["caseId"]
        _require_new_output(bundle / "private" / "profiles" / "preflight" / case_id, bundle)
        _require_new_output(bundle / "private" / "runtime" / "preflight" / case_id, bundle)
    summary_rows = []
    for row in manifest["rows"]:
        receipt = _owned_session(bundle, row, "preflight", None)
        summary_rows.append({key: receipt[key] for key in ("caseId", "status", "target", "expectedPresence", "oracle", "inventory", "performedActions", "isolation", "ownedAppProcessClosed", "ownedLogReadersClosed", "screenshotsCaptured", "providerCalls")})
        print(json.dumps({"slot": row["caseId"], "status": receipt["status"], "matchCount": receipt["oracle"]["matchCount"], "frame": receipt["oracle"]["frameExtents"]}, separators=(",", ":")))
    summary = {"schema": "h8a-disjoint-ui-preflight-v1", "manifestSha256": args.approved_manifest_sha256, "caseCount": len(summary_rows), "rows": summary_rows}
    summary_hash = write_json_new(summary_output, summary)
    print(json.dumps({"preflightSummarySha256": summary_hash, "caseCount": len(summary_rows)}))
    return 0


def _load_old_frames() -> list[dict[str, Any]]:
    data = json.loads(OLD_FRAMES.read_text())
    if data.get("cutoffInclusive") != 4 or not isinstance(data.get("frames"), list):
        raise UiDisjointError("old-frame fingerprint pin is invalid")
    return data["frames"]


def cmd_capture(args: argparse.Namespace) -> int:
    bundle = _require_existing_path(args.bundle, ARTIFACT_ROOT, directory=True)
    private = bundle / "private"
    # Validate the destination before launching any capture worker. A typo here
    # must not leave an otherwise accepted screenshot cohort without its export.
    export_dir = _require_new_output(args.export_dir, ARTIFACT_ROOT)
    validate_runtime_inputs()
    manifest_path = _require_existing_path(private / "state-manifest.json", bundle)
    raw = read_bounded_file_bytes(manifest_path, max_bytes=2 * 1024 * 1024, label="UI state manifest")[0]
    if sha256(raw) != args.approved_manifest_sha256:
        raise UiDisjointError("manifest hash does not match approved value")
    manifest = json.loads(raw)
    validate_roster(manifest)
    summary_path = _require_existing_path(private / "preflight-summary.json", bundle)
    summary_raw = read_bounded_file_bytes(summary_path, max_bytes=16 * 1024 * 1024, label="preflight summary")[0]
    if sha256(summary_raw) != args.approved_preflight_summary_sha256:
        raise UiDisjointError("preflight summary hash does not match approved value")
    summary = json.loads(summary_raw)
    if summary.get("manifestSha256") != args.approved_manifest_sha256 or len(summary.get("rows", [])) != 10:
        raise UiDisjointError("reviewed preflight summary does not cover this full roster")
    by_id = {row["caseId"]: row for row in summary["rows"]}
    if len(by_id) != 10 or set(by_id) != {row["caseId"] for row in manifest["rows"]}:
        raise UiDisjointError("reviewed preflight summary does not cover the exact roster")
    if any(row.get("screenshotsCaptured") is not False or row.get("providerCalls") != 0 for row in summary["rows"]):
        raise UiDisjointError("preflight summary contains unexpected capture or provider activity")
    for row in manifest["rows"]:
        case_id = row["caseId"]
        if (private / "screenshots" / f"{case_id}.png").exists() or (private / "screenshots" / f"{case_id}.png").is_symlink():
            raise UiDisjointError("capture refuses any existing screenshot for a registered case")
        _require_new_output(private / "profiles" / "capture" / case_id, bundle)
        _require_new_output(private / "runtime" / "capture" / case_id, bundle)
    old_frames = _load_old_frames()
    captures: list[dict[str, Any]] = []
    for row in manifest["rows"]:
        expected = by_id.get(row["caseId"])
        if not expected or expected.get("status") != "preflight":
            raise UiDisjointError("preflight row missing or invalid")
        receipt = _owned_session(bundle, row, "capture", expected["oracle"]["inventorySha256"])
        captures.append(receipt)
    all_hashes = [int(frame["perceptualHash"], 16) for frame in old_frames]
    for receipt in captures:
        current = int(receipt["perceptualHash"], 16)
        near = [(frame["id"], hamming_distance64(current, previous)) for frame, previous in zip(old_frames, all_hashes) if hamming_distance64(current, previous) <= 4]
        if near:
            raise UiDisjointError(f"captured screen is visually duplicate/near old cohort: {receipt['caseId']}")
    for index, left in enumerate(captures):
        for right in captures[index + 1:]:
            if left["imageSha256"] == right["imageSha256"] or left["rgbSha256"] == right["rgbSha256"] or hamming_distance64(int(left["perceptualHash"], 16), int(right["perceptualHash"], 16)) <= 4:
                raise UiDisjointError("new UI screenshots contain exact or near duplicate frames")
    producer = [{"opaqueCaseId": row["caseId"], "sourceBytesSha256": row["imageSha256"], "sourceCanvasWidth": WIDTH, "sourceCanvasHeight": HEIGHT, "targetTaskText": next(case["query"] for case in CASES if str(uuid.uuid5(NAMESPACE, f"{SEED}:{case['slot']}:case")) == row["caseId"])} for row in captures]
    annotations = _canonical_annotations(captures)
    # Write exports outside the corpus bundle, in the caller-owned export directory.
    export_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    producer_hash = write_json_new(export_dir / "producer-input-rows.json", producer)
    annotation_hash = write_json_new(export_dir / "evaluator-private-annotations.json", list(annotations.values()))
    controller = {row["caseId"]: str(bundle / row["imagePath"]) for row in captures}
    controller_hash = write_json_new(export_dir / "controller-path-index.json", controller)
    provenance = {row["caseId"]: {"opaqueCaseId": row["caseId"], "sourceGroup": annotations[row["caseId"]]["sourceGroup"], "sourceStateId": next(item["sourceStateId"] for item in manifest["rows"] if item["caseId"] == row["caseId"]), "sourceBytesSha256": next(item["authored"]["sourceSha256"] for item in manifest["rows"] if item["caseId"] == row["caseId"]), "targetRole": row["target"]["role"], "targetName": row["target"]["name"], "imageSha256": row["imageSha256"], "imagePerceptualHash": row["perceptualHash"], "appTargetOracle": row["oracle"]} for row in captures}
    provenance_hash = write_json_new(export_dir / "curator-source-provenance.json", provenance)
    receipt = {"schema": "h8a-ui-source-draft-receipt-v1", "sourceReviewStatus": "unreviewed-source-draft", "notPhaseFreeze": True, "modelCalls": 0, "caseCount": len(captures), "positiveCases": sum(item["expectedPresence"] == "present" for item in captures), "negativeCases": sum(item["expectedPresence"] == "absent" for item in captures), "sourceGroupCounts": {"gnumeric": {"present": 4, "absent": 1}, "evince": {"present": 3, "absent": 2}}, "producerRowsSha256": producer_hash, "annotationsSha256": annotation_hash, "controllerPathIndexSha256": controller_hash, "provenanceSha256": provenance_hash}
    receipt_hash = write_json_new(export_dir / "fragment-receipt.json", receipt)
    draft_hash = _write_source_draft(export_dir, ARTIFACTS_ROOT, captures, producer_hash, annotation_hash, controller_hash, provenance_hash, receipt_hash, annotations, provenance)
    print(json.dumps({"sourceDraft": "gnumeric-evince-disjoint-dev10", "sourceDraftSha256": draft_hash, "cases": len(captures), "producerRowsSha256": producer_hash, "fragmentReceiptSha256": receipt_hash, "export": str(export_dir)}, indent=2))
    return 0


def cmd_continue_capture(args: argparse.Namespace) -> int:
    bundle = _require_existing_path(args.bundle, ARTIFACT_ROOT, directory=True)
    validate_runtime_inputs()
    private = bundle / "private"
    manifest_path = _require_existing_path(private / "state-manifest.json", bundle)
    manifest_raw = read_bounded_file_bytes(manifest_path, max_bytes=2 * 1024 * 1024, label="UI state manifest")[0]
    if sha256(manifest_raw) != args.approved_manifest_sha256:
        raise UiDisjointError("manifest hash does not match approved value")
    manifest = json.loads(manifest_raw)
    validate_roster(manifest)
    summary_path = _require_existing_path(private / "preflight-summary.json", bundle)
    summary_raw = read_bounded_file_bytes(summary_path, max_bytes=16 * 1024 * 1024, label="preflight summary")[0]
    if sha256(summary_raw) != args.approved_preflight_summary_sha256:
        raise UiDisjointError("preflight summary hash does not match approved value")
    summary = json.loads(summary_raw)
    if summary.get("manifestSha256") != args.approved_manifest_sha256:
        raise UiDisjointError("preflight summary does not belong to the reviewed manifest")
    prior_path = _require_existing_path(args.partial_receipt, ARTIFACT_ROOT)
    prior = json.loads(read_bounded_file_bytes(prior_path, max_bytes=4 * 1024 * 1024, label="partial capture receipt")[0])
    if prior.get("schema") != "h8a-ui-r17-partial-capture-receipt-v1" or prior.get("manifestSha256") != args.approved_manifest_sha256 or prior.get("preflightSha256") != args.approved_preflight_summary_sha256:
        raise UiDisjointError("partial receipt is not pinned to this manifest and preflight")
    failed_id = args.after_failed_case_id
    if prior.get("stoppedCaseId") != failed_id:
        raise UiDisjointError("continuation must follow the recorded failed case")
    failed_receipt_path = _require_existing_path(private / "runtime" / "capture" / failed_id / "runner-failure.json", bundle)
    if not failed_receipt_path.is_file():
        raise UiDisjointError("continuation failure receipt is missing")
    failed_receipt = json.loads(failed_receipt_path.read_text())
    if failed_receipt.get("caseId") != failed_id or "capture AT-SPI inventory differs" not in failed_receipt.get("stderrExcerpt", ""):
        raise UiDisjointError("continuation failure receipt does not match the recorded inventory mismatch")
    rows = manifest["rows"]
    failed_index = next((index for index, row in enumerate(rows) if row["caseId"] == failed_id), -1)
    if failed_index < 1 or {item.get("caseId") for item in prior.get("rows", [])} != {row["caseId"] for row in rows[:failed_index]}:
        raise UiDisjointError("partial captured rows are not the exact roster prefix before the failure")
    screenshots = private / "screenshots"
    existing = sorted(screenshots.glob("*.png")) if screenshots.exists() else []
    recorded = {item["caseId"]: item for item in prior["rows"]}
    if {path.stem for path in existing} != set(recorded):
        raise UiDisjointError("screenshot directory contains unexpected or missing prior captures")
    for path in existing:
        if hash_file(path) != recorded[path.stem]["imageSha256"]:
            raise UiDisjointError("a previously captured frame changed after its receipt")
    by_id = {row["caseId"]: row for row in summary.get("rows", [])}
    if set(by_id) != {row["caseId"] for row in rows}:
        raise UiDisjointError("preflight summary does not cover the exact roster")
    ledger_path = private / "runtime" / "capture-continuation-r17.jsonl"
    validation_path = private / "runtime" / "capture-continuation-validation-r17.json"
    _require_new_output(ledger_path, bundle)
    _require_new_output(validation_path, bundle)
    for row in manifest["rows"][failed_index + 1:]:
        case_id = row["caseId"]
        _require_new_output(private / "profiles" / "capture" / case_id, bundle)
        _require_new_output(private / "runtime" / "capture" / case_id, bundle)
        _require_new_output(private / "screenshots" / f"{case_id}.png", bundle)
    with ledger_path.open("x", encoding="utf-8") as ledger:
        for row in rows[failed_index + 1:]:
            case_id = row["caseId"]
            if case_id in recorded or (screenshots / f"{case_id}.png").exists():
                raise UiDisjointError("refusing to recapture an already captured case")
            expected = by_id[case_id]
            if expected.get("status") != "preflight" or expected.get("screenshotsCaptured") is not False or expected.get("providerCalls") != 0:
                raise UiDisjointError("continuation target lacks a clean preflight receipt")
            receipt = _owned_session(bundle, row, "capture", expected["oracle"]["inventorySha256"])
            case_receipt_path = private / "runtime" / "capture" / case_id / "successful-capture-receipt.json"
            write_json_new(case_receipt_path, receipt)
            line = json.dumps({"caseId": case_id, "status": receipt["status"], "imageSha256": receipt["imageSha256"], "rgbSha256": receipt["rgbSha256"], "perceptualHash": receipt["perceptualHash"], "oracleInventorySha256": receipt["oracle"]["inventorySha256"], "postCaptureInventorySha256": receipt["postCaptureInventorySha256"]}, separators=(",", ":"))
            ledger.write(line + "\n")
            ledger.flush(); os.fsync(ledger.fileno())
            print(line)
    all_rows = [next(item for item in prior["rows"] if item["caseId"] == row["caseId"]) for row in rows[:failed_index]]
    for row in rows[failed_index + 1:]:
        case_receipt_path = private / "runtime" / "capture" / row["caseId"] / "successful-capture-receipt.json"
        receipt = json.loads(case_receipt_path.read_text())
        all_rows.append({"caseId": row["caseId"], "imageSha256": receipt["imageSha256"], "rgbSha256": receipt["rgbSha256"], "perceptualHash": receipt["perceptualHash"], "imagePath": receipt["imagePath"]})
    old_frames = _load_old_frames()
    violations = []
    for capture in all_rows:
        value = int(capture["perceptualHash"], 16)
        for frame in old_frames:
            distance = hamming_distance64(value, int(frame["perceptualHash"], 16))
            if distance <= 4:
                violations.append({"caseId": capture["caseId"], "priorFrameId": frame["id"], "hamming": distance})
    for index, left in enumerate(all_rows):
        for right in all_rows[index + 1:]:
            distance = hamming_distance64(int(left["perceptualHash"], 16), int(right["perceptualHash"], 16))
            if left["imageSha256"] == right["imageSha256"] or left["rgbSha256"] == right["rgbSha256"] or distance <= 4:
                violations.append({"caseId": left["caseId"], "peerCaseId": right["caseId"], "hamming": distance, "exactEncoded": left["imageSha256"] == right["imageSha256"], "exactRgb": left["rgbSha256"] == right["rgbSha256"]})
    result = {"schema": "h8a-ui-r17-continuation-validation-v1", "manifestSha256": args.approved_manifest_sha256, "preflightSha256": args.approved_preflight_summary_sha256, "priorReceiptSha256": hash_file(prior_path), "failedCaseId": failed_id, "capturedCaseIds": [row["caseId"] for row in all_rows], "captureCount": len(all_rows), "rosterCount": len(rows), "providerCalls": 0, "violations": violations, "ledgerPath": str(ledger_path), "screenshotsCaptured": True}
    write_json_new(validation_path, result)
    print(json.dumps({"validation": str(validation_path), "captureCount": len(all_rows), "violations": violations}, indent=2))
    if violations:
        raise UiDisjointError("continued captures contain duplicate/near frames; all results preserved without replacement")
    return 0


def cmd_capture_alias_case(args: argparse.Namespace) -> int:
    bundle = _require_existing_path(args.bundle, ARTIFACT_ROOT, directory=True)
    validate_runtime_inputs()
    private = bundle / "private"
    manifest_path = _require_existing_path(private / "state-manifest.json", bundle)
    manifest_raw = read_bounded_file_bytes(manifest_path, max_bytes=2 * 1024 * 1024, label="UI state manifest")[0]
    if sha256(manifest_raw) != args.approved_manifest_sha256:
        raise UiDisjointError("manifest hash does not match approved value")
    manifest = json.loads(manifest_raw)
    validate_roster(manifest)
    summary_path = _require_existing_path(private / "preflight-summary.json", bundle)
    summary_raw = read_bounded_file_bytes(summary_path, max_bytes=16 * 1024 * 1024, label="preflight summary")[0]
    if sha256(summary_raw) != args.approved_preflight_summary_sha256:
        raise UiDisjointError("preflight summary hash does not match approved value")
    summary = json.loads(summary_raw)
    alias_path = _require_existing_path(args.alias_verification, ARTIFACT_ROOT)
    alias_raw = read_bounded_file_bytes(alias_path, max_bytes=2 * 1024 * 1024, label="profile alias verification")[0]
    if sha256(alias_raw) != args.approved_alias_verification_sha256:
        raise UiDisjointError("profile alias verification hash does not match approved value")
    alias_report = json.loads(alias_raw)
    if alias_report.get("schema") != "h8a-ui-r17-profile-path-alias-verification-v1" or alias_report.get("caseId") != args.case_id or alias_report.get("screenshotsCaptured") is not False or alias_report.get("providerCalls") != 0:
        raise UiDisjointError("profile alias verification does not cover a metadata-only probe of this case")
    expected = next((row for row in summary.get("rows", []) if row.get("caseId") == args.case_id), None)
    if not expected or len(alias_report.get("diagnostics", [])) != 2 or alias_report.get("exactInventoryMatchesPreflight") != [True, True] or alias_report.get("diagnosticInventoriesIdentical") is not True or alias_report.get("originalPreflightProfileImmutable") is not True:
        raise UiDisjointError("two stable exact-inventory profile-alias diagnostics are required")
    if any(item.get("inventorySha256") != expected["oracle"]["inventorySha256"] for item in alias_report["diagnostics"]):
        raise UiDisjointError("profile-alias diagnostic does not match the exact reviewed preflight digest")
    failed_path = private / "runtime" / "capture" / args.case_id / "runner-failure.json"
    if not failed_path.is_file():
        raise UiDisjointError("the original failed capture receipt must remain present")
    failed = json.loads(failed_path.read_text())
    if failed.get("caseId") != args.case_id or "capture AT-SPI inventory differs" not in failed.get("stderrExcerpt", ""):
        raise UiDisjointError("original failed capture receipt does not match the approved recovery case")
    screenshot = private / "screenshots" / f"{args.case_id}.png"
    if screenshot.exists() or screenshot.is_symlink():
        raise UiDisjointError("refusing to overwrite or recapture a case with a screenshot")
    _require_new_output(private / "runtime" / "capture-alias" / args.case_id, bundle)
    _require_new_output(private / "profiles" / "capture-alias" / args.case_id, bundle)
    _require_new_output(screenshot, bundle)
    row = next(item for item in manifest["rows"] if item["caseId"] == args.case_id)
    if row["sourceGroup"] != "evince" or row["expectedPresence"] != "present" or row["target"]["name"] != "Cancel":
        raise UiDisjointError("profile path alias recovery is restricted to the registered Evince Cancel case")
    profile = private / "profiles" / "preflight" / args.case_id
    before = _profile_tree_fingerprint(profile)
    receipt = _owned_session(bundle, row, "capture-alias", expected["oracle"]["inventorySha256"], profile_alias_phase="preflight")
    after = _profile_tree_fingerprint(profile)
    if before != after:
        raise UiDisjointError("original preflight profile changed across the isolated alias capture")
    if receipt.get("status") != "captured" or receipt.get("oracle", {}).get("inventorySha256") != expected["oracle"]["inventorySha256"] or receipt.get("postCaptureInventorySha256") != expected["oracle"]["inventorySha256"]:
        raise UiDisjointError("alias capture did not preserve the complete exact preflight inventory")
    capture_receipt = {"schema": "h8a-ui-r17-profile-alias-capture-receipt-v1", "caseId": args.case_id, "sourceStateId": row["sourceStateId"], "sourceSha256": row["authored"]["sourceSha256"], "manifestSha256": args.approved_manifest_sha256, "preflightSha256": args.approved_preflight_summary_sha256, "aliasVerificationSha256": args.approved_alias_verification_sha256, "originalFailureSha256": hash_file(failed_path), "profileTreeSha256Before": before, "profileTreeSha256After": after, "capture": receipt, "screenshotsCaptured": True, "providerCalls": 0}
    capture_receipt_path = private / "runtime" / "capture-alias" / args.case_id / "profile-alias-capture-receipt.json"
    write_json_new(capture_receipt_path, capture_receipt)
    print(json.dumps({"receipt": str(capture_receipt_path), "caseId": args.case_id, "imageSha256": receipt["imageSha256"], "inventorySha256": receipt["oracle"]["inventorySha256"], "profileImmutable": before == after}, indent=2))
    return 0


def cmd_export_capture_ledger(args: argparse.Namespace) -> int:
    bundle = _require_existing_path(args.bundle, ARTIFACT_ROOT, directory=True)
    export_dir = _require_new_output(args.export_dir, ARTIFACT_ROOT)
    ledger_path = _require_existing_path(args.capture_ledger, ARTIFACTS_ROOT)
    revision_path = _require_existing_path(args.target_boundary_revision, ARTIFACTS_ROOT) if args.target_boundary_revision else None
    if bool(revision_path) != bool(args.approved_target_boundary_revision_sha256):
        raise UiDisjointError("target boundary revision path and approved hash must be supplied together")
    validate_runtime_inputs()
    private = bundle / "private"
    manifest_path = _require_existing_path(private / "state-manifest.json", bundle)
    manifest_raw = read_bounded_file_bytes(manifest_path, max_bytes=2 * 1024 * 1024, label="UI state manifest")[0]
    if sha256(manifest_raw) != args.approved_manifest_sha256:
        raise UiDisjointError("manifest hash does not match reviewed value")
    manifest = json.loads(manifest_raw)
    validate_roster(manifest)
    summary_path = _require_existing_path(private / "preflight-summary.json", bundle)
    summary_raw = read_bounded_file_bytes(summary_path, max_bytes=16 * 1024 * 1024, label="preflight summary")[0]
    if sha256(summary_raw) != args.approved_preflight_summary_sha256:
        raise UiDisjointError("preflight summary hash does not match reviewed value")
    summary = json.loads(summary_raw)
    ledger_raw = read_bounded_file_bytes(ledger_path, max_bytes=8 * 1024 * 1024, label="capture ledger")[0]
    if sha256(ledger_raw) != args.approved_capture_ledger_sha256:
        raise UiDisjointError("capture ledger hash does not match reviewed value")
    ledger = json.loads(ledger_raw)
    if ledger.get("schema") != "h8a-ui-r17-complete-capture-ledger-v1" or ledger.get("manifestSha256") != args.approved_manifest_sha256 or ledger.get("preflightSha256") != args.approved_preflight_summary_sha256 or ledger.get("captureCount") != 10 or ledger.get("caseCount") != 10 or ledger.get("providerCalls") != 0 or ledger.get("violations"):
        raise UiDisjointError("capture ledger is incomplete, unpinned, or contains a duplicate/exclusion violation")
    if len(ledger.get("rows", [])) != 10 or [row.get("caseId") for row in ledger["rows"]] != [row["caseId"] for row in manifest["rows"]]:
        raise UiDisjointError("capture ledger rows do not preserve the exact full registry order")
    row7_id = "9af54502-9b2c-5992-a18a-e68eb9848277"
    failed_attempt_path = private / "runtime" / "capture" / row7_id / "runner-failure.json"
    alias_capture_path = private / "runtime" / "capture-alias" / row7_id / "profile-alias-capture-receipt.json"
    alias_verification_path = ledger_path.parent / "row7-profile-path-alias-verification-r17.json"
    failed_attempt_path = _require_existing_path(failed_attempt_path, bundle)
    alias_capture_path = _require_existing_path(alias_capture_path, bundle)
    alias_verification_path = _require_existing_path(alias_verification_path, ARTIFACTS_ROOT)
    alias_capture = json.loads(read_bounded_file_bytes(alias_capture_path, max_bytes=4 * 1024 * 1024, label="alias capture receipt")[0])
    alias_verification = json.loads(read_bounded_file_bytes(alias_verification_path, max_bytes=4 * 1024 * 1024, label="alias verification receipt")[0])
    row7_capture = next((row for row in ledger["rows"] if row.get("caseId") == row7_id), None)
    if not row7_capture or alias_capture.get("capture", {}).get("imageSha256") != row7_capture.get("imageSha256") or alias_verification.get("originalPreflightProfileImmutable") is not True:
        raise UiDisjointError("recovered case evidence does not bind to the captured frame and immutable preflight profile")
    preflight_by_id = {row["caseId"]: row for row in summary.get("rows", [])}
    if set(preflight_by_id) != {row["caseId"] for row in manifest["rows"]}:
        raise UiDisjointError("preflight summary does not cover the exact roster")
    captures: list[dict[str, Any]] = []
    for row, capture in zip(manifest["rows"], ledger["rows"]):
        source = _require_existing_path(private / row["authored"]["relativePath"], private)
        if hash_file(source) != row["authored"]["sourceSha256"]:
            raise UiDisjointError("registered source bytes changed before export")
        image = _require_existing_path(capture["imagePath"], bundle)
        expected_image = (private / "screenshots" / f"{row['caseId']}.png").resolve()
        if image != expected_image or hash_file(image) != capture["imageSha256"]:
            raise UiDisjointError("capture ledger image bytes or path do not match the registered case")
        expected = preflight_by_id[row["caseId"]]
        if capture.get("preflightInventorySha256") != expected["oracle"]["inventorySha256"] or capture.get("captureInventorySha256") != expected["oracle"]["inventorySha256"] or capture.get("postCaptureInventorySha256") != expected["oracle"]["inventorySha256"]:
            raise UiDisjointError("capture frame does not preserve the exact preflight inventory")
        if expected.get("status") != "preflight" or expected.get("screenshotsCaptured") is not False or expected.get("providerCalls") != 0:
            raise UiDisjointError("preflight proof contains unexpected activity")
        oracle = expected["oracle"]
        if oracle["matchCount"] != (1 if row["expectedPresence"] == "present" else 0):
            raise UiDisjointError("preflight oracle is inconsistent with the registered expected presence")
        if row["expectedPresence"] == "present" and len(oracle["matches"]) != 1:
            raise UiDisjointError("positive capture lacks one unique visible target proof")
        if row["expectedPresence"] == "absent" and oracle["matches"]:
            raise UiDisjointError("negative capture contains a visible partial or complete match")
        if capture["dimensions"] != [WIDTH, HEIGHT]:
            raise UiDisjointError("registered capture has unexpected canvas dimensions")
        captures.append({"caseId": row["caseId"], "imageSha256": capture["imageSha256"], "rgbSha256": capture["rgbSha256"], "perceptualHash": capture["perceptualHash"], "imagePath": str(image), "oracle": oracle, "expectedPresence": row["expectedPresence"], "target": row["target"], "sourceGroup": row["sourceGroup"], "sourceStateId": row["sourceStateId"], "sourceSha256": row["authored"]["sourceSha256"]})
    if sum(x["sourceGroup"] == "gnumeric" and x["expectedPresence"] == "present" for x in captures) != 4 or sum(x["sourceGroup"] == "gnumeric" and x["expectedPresence"] == "absent" for x in captures) != 1 or sum(x["sourceGroup"] == "evince" and x["expectedPresence"] == "present" for x in captures) != 3 or sum(x["sourceGroup"] == "evince" and x["expectedPresence"] == "absent" for x in captures) != 2:
        raise UiDisjointError("export cohort family quotas do not match the preregistration")
    producer = [{"opaqueCaseId": row["caseId"], "sourceBytesSha256": row["imageSha256"], "sourceCanvasWidth": WIDTH, "sourceCanvasHeight": HEIGHT, "targetTaskText": next(case["query"] for case in CASES if str(uuid.uuid5(NAMESPACE, f"{SEED}:{case['slot']}:case")) == row["caseId"])} for row in captures]
    corrections: dict[str, dict[str, int]] = {}
    revision: dict[str, Any] | None = None
    if revision_path:
        corrections, revision = _load_target_boundary_revision(revision_path, args.approved_target_boundary_revision_sha256, captures)
    annotations = _canonical_annotations(captures, corrections)
    export_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    producer_hash = write_json_new(export_dir / "producer-input-rows.json", producer)
    annotation_hash = write_json_new(export_dir / "evaluator-private-annotations.json", list(annotations.values()))
    controller = {row["caseId"]: row["imagePath"] for row in captures}
    controller_hash = write_json_new(export_dir / "controller-path-index.json", controller)
    revision_sha256 = sha256(read_bounded_file_bytes(revision_path, max_bytes=2 * 1024 * 1024, label="native target boundary revision")[0]) if revision_path else None
    provenance = {row["caseId"]: {"opaqueCaseId": row["caseId"], "sourceGroup": row["sourceGroup"], "sourceStateId": row["sourceStateId"], "sourceBytesSha256": row["sourceSha256"], "targetRole": row["target"]["role"], "targetName": row["target"]["name"], "imageSha256": row["imageSha256"], "imagePerceptualHash": row["perceptualHash"], "appTargetOracle": row["oracle"], "targetBoundaryRevisionSha256": revision_sha256, "targetBoundaryRevision": next((item for item in revision.get("rows", []) if item["caseId"] == row["caseId"]), None) if revision else None} for row in captures}
    provenance_hash = write_json_new(export_dir / "curator-source-provenance.json", provenance)
    receipt = {"schema": "h8a-ui-source-draft-receipt-v1", "sourceReviewStatus": "unreviewed-source-draft", "notPhaseFreeze": True, "manifestPath": str(manifest_path), "manifestSha256": args.approved_manifest_sha256, "preflightPath": str(summary_path), "preflightSha256": args.approved_preflight_summary_sha256, "captureLedgerPath": str(ledger_path), "captureLedgerSha256": args.approved_capture_ledger_sha256, "originalRow7Failure": {"path": str(failed_attempt_path), "sha256": hash_file(failed_attempt_path)}, "row7AliasCapture": {"path": str(alias_capture_path), "sha256": hash_file(alias_capture_path)}, "row7AliasVerification": {"path": str(alias_verification_path), "sha256": hash_file(alias_verification_path)}, "runtimePackageLock": {"path": str(ARTIFACT_ROOT / "package-license-lock.json"), "sha256": hash_file(ARTIFACT_ROOT / "package-license-lock.json")}, "priorFrameExclusion": {"path": str(OLD_FRAMES), "sha256": hash_file(OLD_FRAMES), "cutoffHammingInclusive": 4}, "modelCalls": 0, "caseCount": 10, "positiveCases": 7, "negativeCases": 3, "sourceGroupCounts": {"gnumeric": {"present": 4, "absent": 1}, "evince": {"present": 3, "absent": 2}}, "producerRowsSha256": producer_hash, "annotationsSha256": annotation_hash, "controllerPathIndexSha256": controller_hash, "provenanceSha256": provenance_hash}
    receipt_hash = write_json_new(export_dir / "fragment-receipt.json", receipt)
    draft_hash = _write_source_draft(export_dir, ARTIFACTS_ROOT, captures, producer_hash, annotation_hash, controller_hash, provenance_hash, receipt_hash, annotations, provenance)
    print(json.dumps({"sourceDraft": "gnumeric-evince-disjoint-dev10", "sourceDraftSha256": draft_hash, "cases": len(captures), "producerRowsSha256": producer_hash, "fragmentReceiptSha256": receipt_hash, "export": str(export_dir)}, indent=2))
    return 0


def validate_roster(manifest: dict[str, Any]) -> None:
    rows = manifest.get("rows")
    if not isinstance(rows, list) or len(rows) != 10:
        raise UiDisjointError("roster must contain exactly ten cases")
    ids = [row.get("caseId") for row in rows]
    states = [row.get("sourceStateId") for row in rows]
    if len(set(ids)) != 10 or len(set(states)) != 10:
        raise UiDisjointError("case and source-state IDs must be unique")
    apps = {app: {presence: 0 for presence in ("present", "absent")} for app in ("gnumeric", "evince")}
    for row in rows:
        apps[row["sourceGroup"]][row["expectedPresence"]] += 1
        target = row.get("target")
        if not isinstance(target, dict) or set(target) != {"role", "name", "query"} or not all(isinstance(target[key], str) and target[key] for key in target):
            raise UiDisjointError("target contract invalid")
        if not (row.get("sourceStateId") and row.get("authored", {}).get("sourceSha256")):
            raise UiDisjointError("state/source identity incomplete")
    if apps != {"gnumeric": {"present": 4, "absent": 1}, "evince": {"present": 3, "absent": 2}}:
        raise UiDisjointError("UI family quotas differ from preregistration")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    def add_roots(command: argparse.ArgumentParser) -> None:
        command.add_argument("--artifact-root", required=True, help="external directory containing extracted runtime packages and receipts")
        command.add_argument("--artifacts-root", required=True, help="external parent directory used for relative artifact references")
        command.add_argument("--old-frames", required=True, help="external pinned old-frame fingerprint file")
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--output-dir", required=True)
    add_roots(prepare)
    preflight = sub.add_parser("preflight")
    preflight.add_argument("--bundle", required=True)
    preflight.add_argument("--approved-manifest-sha256", required=True)
    add_roots(preflight)
    capture = sub.add_parser("capture")
    capture.add_argument("--bundle", required=True)
    capture.add_argument("--approved-manifest-sha256", required=True)
    capture.add_argument("--approved-preflight-summary-sha256", required=True)
    capture.add_argument("--export-dir", required=True)
    add_roots(capture)
    continuation = sub.add_parser("continue-capture")
    continuation.add_argument("--bundle", required=True)
    continuation.add_argument("--approved-manifest-sha256", required=True)
    continuation.add_argument("--approved-preflight-summary-sha256", required=True)
    continuation.add_argument("--partial-receipt", required=True)
    continuation.add_argument("--after-failed-case-id", required=True)
    add_roots(continuation)
    alias_capture = sub.add_parser("capture-alias-case")
    alias_capture.add_argument("--bundle", required=True)
    alias_capture.add_argument("--approved-manifest-sha256", required=True)
    alias_capture.add_argument("--approved-preflight-summary-sha256", required=True)
    alias_capture.add_argument("--alias-verification", required=True)
    alias_capture.add_argument("--approved-alias-verification-sha256", required=True)
    alias_capture.add_argument("--case-id", required=True)
    add_roots(alias_capture)
    export = sub.add_parser("export-capture-ledger")
    export.add_argument("--bundle", required=True)
    export.add_argument("--approved-manifest-sha256", required=True)
    export.add_argument("--approved-preflight-summary-sha256", required=True)
    export.add_argument("--capture-ledger", required=True)
    export.add_argument("--approved-capture-ledger-sha256", required=True)
    export.add_argument("--target-boundary-revision")
    export.add_argument("--approved-target-boundary-revision-sha256")
    export.add_argument("--export-dir", required=True)
    add_roots(export)
    worker = sub.add_parser("_worker")
    worker.add_argument("bundle")
    worker.add_argument("case_id")
    worker.add_argument("phase")
    worker.add_argument("approved_digest")
    add_roots(worker)
    args = parser.parse_args(argv)
    try:
        configure_roots(args.artifact_root, args.artifacts_root, args.old_frames)
        if args.command == "_worker" and args.phase not in {"preflight", "capture", "capture-alias"} and not re.fullmatch(r"diagnostic-[a-z0-9-]{1,48}", args.phase):
            raise UiDisjointError("worker phase is outside the bounded phase namespace")
        if args.command == "prepare":
            return cmd_prepare(args)
        if args.command == "preflight":
            return cmd_preflight(args)
        if args.command == "capture":
            return cmd_capture(args)
        if args.command == "continue-capture":
            return cmd_continue_capture(args)
        if args.command == "capture-alias-case":
            return cmd_capture_alias_case(args)
        if args.command == "export-capture-ledger":
            return cmd_export_capture_ledger(args)
        return _worker(args.bundle, args.case_id, args.phase, args.approved_digest or None)
    except (UiDisjointError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ui-disjoint: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
