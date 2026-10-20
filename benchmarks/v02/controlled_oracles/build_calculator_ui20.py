#!/usr/bin/env python3
"""Create a private, controlled GNOME Calculator 20-case UI proof cohort.

The task images are captured from the real application in owned Xvfb sessions.
Positive geometry comes only from the pinned GtkBuilder grid relation and
pixel-verified painted button borders. Negatives use the complete 24-widget
basic-keypad inventory. Nothing calls a model or depends on model output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from .oracle import GREEN, MAGENTA, _is_full_border, exact_color_components, read_png_rgb, sha256_file
except ImportError:
    from oracle import GREEN, MAGENTA, _is_full_border, exact_color_components, read_png_rgb, sha256_file


SOURCE_URL = "https://raw.githubusercontent.com/GNOME/gnome-calculator/46.3/src/ui/buttons-basic.ui"
SOURCE_SHA256 = "248e9fca5c32a6197b6495a9dc4e1e4f7d176a17f86a76e18de25a7ec6a644a6"
APP_VERSION = "gnome-calculator 46.3"
CSS_URL = "private capture CSS embedded by capture_calculator.py"
SOURCE_GROUP = "gnome-calculator-46.3-controlled-basic-keypad"

POSITIVE_KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "+", "−", "×", "÷", "√"]
NEGATIVE_KEYS = ["10", "11", "12", "13", "14"]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def source_key_grid(source_path: Path) -> dict[str, tuple[int, int]]:
    if sha256_file(source_path) != SOURCE_SHA256:
        raise ValueError("GNOME Calculator GtkBuilder source pin mismatch")
    root = ET.parse(source_path).getroot()
    grid = root.find(".//object[@id='basic']")
    if grid is None:
        raise ValueError("pinned source has no basic keypad grid")
    result: dict[str, tuple[int, int]] = {}
    for button in grid.findall("./child/object[@class='GtkButton']"):
        label = button.findtext("property[@name='label']")
        if label is None:
            label = button.findtext("child/object/property[@name='label']")
        if button.get("id") == "calc_x_squared_button":
            label = "x2"
        if label is None:
            raise ValueError(f"button {button.get('id')} has no source label")
        layout = button.find("layout")
        if layout is None:
            raise ValueError(f"button {button.get('id')} has no grid layout")
        row = layout.findtext("property[@name='row']")
        column = layout.findtext("property[@name='column']")
        # GtkGrid assigns the initial item to (0,0); this pinned file omits a
        # coordinate only for the first clear key (row 0) and the 4 key (col 0).
        row_value = 0 if row is None and button.get("id") == "calc_clear_button" else int(row) if row is not None else None
        column_value = 0 if column is None and button.get("id") == "calc_4_button" else int(column) if column is not None else None
        if row_value is None or column_value is None:
            raise ValueError(f"unresolved source grid cell for {button.get('id')}")
        if label in result:
            raise ValueError(f"duplicate source keypad label {label!r}")
        result[label] = (row_value, column_value)
    if len(result) != 24:
        raise ValueError(f"expected 24 source keypad actions, found {len(result)}")
    return result


def source_key_widget_ids(source_path: Path) -> dict[str, str]:
    root = ET.parse(source_path).getroot()
    grid = root.find(".//object[@id='basic']")
    if grid is None:
        raise ValueError("pinned source has no basic keypad grid")
    result: dict[str, str] = {}
    for button in grid.findall("./child/object[@class='GtkButton']"):
        label = button.findtext("property[@name='label']")
        if label is None:
            label = button.findtext("child/object/property[@name='label']")
        if button.get("id") == "calc_x_squared_button":
            label = "x2"
        widget_id = button.get("id")
        if label is None or widget_id is None:
            raise ValueError("pinned keypad widget has no stable label or ID")
        result[label] = widget_id
    return result


def painted_grid_boxes(screenshot: Path, source_grid: dict[str, tuple[int, int]]) -> dict[str, tuple[int, int, int, int]]:
    width, height, rgb = read_png_rgb(screenshot)
    components = exact_color_components(width, height, rgb, MAGENTA)
    # The keypad controls are the large fully painted components. Toolbar
    # controls have height at most 34 px; all keypad controls are 44 px high,
    # except the equals action which spans two rows.
    boxes = [
        box for box in components
        if box[2] - box[0] >= 50
        and box[3] - box[1] >= 40
        and _is_full_border(width, rgb, box, MAGENTA, 3)
    ]
    if len(boxes) != 24:
        raise ValueError(f"expected 24 fully painted keypad controls, found {len(boxes)}")
    row_tops = sorted({box[1] for box in boxes})
    col_lefts = sorted({box[0] for box in boxes})
    if len(row_tops) != 5 or len(col_lefts) != 5:
        raise ValueError("painted buttons do not form the pinned five-by-five keypad grid")
    box_by_cell: dict[tuple[int, int], tuple[int, int, int, int]] = {}
    for box in boxes:
        row, column = row_tops.index(box[1]), col_lefts.index(box[0])
        if (row, column) in box_by_cell:
            raise ValueError(f"duplicate painted keypad cell {(row, column)}")
        x1, y1, x2, y2 = box
        # Verify all four green interior corners independently of the border.
        for x, y in ((x1 + 5, y1 + 5), (x2 - 6, y1 + 5), (x1 + 5, y2 - 6), (x2 - 6, y2 - 6)):
            offset = (y * width + x) * 3
            if tuple(rgb[offset:offset + 3]) != GREEN:
                raise ValueError("visible keypad button fill does not match pinned CSS")
        box_by_cell[(row, column)] = box

    source_cells = {
        (0, 0): "C", (0, 1): "(", (0, 2): ")", (0, 3): "mod", (0, 4): "π",
        (1, 0): "7", (1, 1): "8", (1, 2): "9", (1, 3): "÷", (1, 4): "√",
        (2, 0): "4", (2, 1): "5", (2, 2): "6", (2, 3): "×", (2, 4): "x2",
        (3, 0): "1", (3, 1): "2", (3, 2): "3", (3, 3): "−", (3, 4): "=",
        (4, 0): "0", (4, 1): ".", (4, 2): "%", (4, 3): "+",
    }
    source_by_label = {label: cell for cell, label in source_cells.items()}
    if source_by_label != source_grid or set(source_by_label) != set(source_grid) or set(source_cells) - set(box_by_cell):
        raise ValueError("painted source grid and full keypad inventory disagree")
    output = {label: box_by_cell[cell] for label, cell in source_by_label.items()}
    if (3, 4) not in box_by_cell or box_by_cell[(3, 4)][3] != box_by_cell[(4, 0)][3]:
        raise ValueError("equals key span does not match the pinned two-row control")
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path, help="new ignored/private output directory")
    parser.add_argument("--gtk-builder", type=Path, required=True, help="official source file pinned by SHA-256")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    grid = source_key_grid(args.gtk_builder)
    widget_ids = source_key_widget_ids(args.gtk_builder)
    expected_labels = set(grid)
    script = Path(__file__).with_name("capture_calculator.py").resolve()
    cases = []
    truths = []
    ledger = []
    tasks = [(label, True) for label in POSITIVE_KEYS] + [(label, False) for label in NEGATIVE_KEYS]
    if len(tasks) != 20:
        raise ValueError("cohort must have exactly 20 cases")

    for index, (label, present) in enumerate(tasks, start=1):
        case_id = f"calculator-ctl-{index:02d}"
        case_dir = output / "captures" / case_id
        screen = "400x600" if index <= 10 else "640x800"
        window_size = None if index <= 10 else "600x700"
        seed = f"{(index - 1) % 9 + 1}+{(index - 1) // 9 + 1}"
        command = [
            "unshare", "-n", "--", "dbus-run-session", "--", "xvfb-run", "-a", "-s",
            f"-screen 0 {screen}x24", sys.executable, str(script), str(case_dir),
            "--screen", screen, "--seed-text", seed,
        ]
        if window_size is not None:
            command += ["--window-size", window_size]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        screenshot = case_dir / "screen.png"
        accessibility_path = case_dir / "accessibility.json"
        accessibility = json.loads(accessibility_path.read_text(encoding="utf-8"))
        labels = accessibility.get("keypadNames")
        if not isinstance(labels, list) or not expected_labels.issubset(set(labels)):
            raise ValueError(f"case {case_id} has incomplete AT-SPI keypad inventory")
        actual_button_names = [item.get("name") for item in accessibility.get("accessibilityButtons", [])]
        for required in expected_labels:
            if actual_button_names.count(required) != 1:
                raise ValueError(f"case {case_id} AT-SPI does not show exactly one {required!r} keypad action")
        boxes = painted_grid_boxes(screenshot, grid)
        if present:
            if label not in boxes:
                raise ValueError(f"positive target {label!r} has no independent painted-box evidence")
            truth = {
                "caseId": case_id,
                "expectedPresence": True,
                "box": list(boxes[label]),
                "reviewer": "source-layout-plus-pixel-edge-oracle",
                "evidence": ["GtkBuilder widget ID/action label/grid position", "AT-SPI complete visible keypad inventory", "all four 3px magenta border edges and green interior corners"],
            }
        else:
            if label in boxes or label in expected_labels or label in set(labels):
                raise ValueError(f"negative target digit {label} unexpectedly appears in the complete keypad inventory")
            truth = {
                "caseId": case_id,
                "expectedPresence": False,
                "reviewer": "source-layout-plus-pixel-edge-oracle",
                "negativeEvidence": "The pinned GtkBuilder basic keypad defines exactly 24 visible actions and the full AT-SPI keypad inventory omits this digit label.",
            }
        image_rel = f"captures/{case_id}/screen.png"
        cases.append({
            "caseId": case_id,
            "image": {"path": image_rel, "sha256": sha256_file(screenshot), "width": read_png_rgb(screenshot)[0], "height": read_png_rgb(screenshot)[1]},
            "locate": {
                "target": f"the visible physical button labeled '{label}' in GNOME Calculator's basic keypad",
                "instruction": "Locate the visible physical instance of the named object; return unknown when unsupported.",
            },
            "classify": {
                "question": f"Is there a visible physical button labeled '{label}' in GNOME Calculator's basic keypad?",
                "options": ["present", "absent"],
            },
        })
        truths.append(truth)
        ledger.append({
            "caseId": case_id,
            "sourceGroupId": SOURCE_GROUP,
            "application": "GNOME Calculator",
            "version": APP_VERSION,
            "applicationLicense": "GPL-2+ (Debian package copyright metadata)",
            "gtkBuilderUrl": "https://github.com/GNOME/gnome-calculator/blob/46.3/src/ui/buttons-basic.ui",
            "gtkBuilderSha256": SOURCE_SHA256,
            "cssSha256": accessibility["cssSha256"],
            "screenshotSha256": sha256_file(screenshot),
            "screen": screen,
            "requestedWindowSize": window_size,
            "seedText": seed,
            "targetSourceWidgetId": widget_ids[label] if present else None,
            "targetGtkGridCell": list(grid[label]) if present else None,
            "fullATSPINamesSha256": sha256_bytes(json.dumps(sorted(actual_button_names), ensure_ascii=False, separators=(",", ":")).encode("utf-8")),
            "paintedButtonBoxes": {key: list(value) for key, value in sorted(boxes.items())},
        })
    inputs = {
        "version": "calculator-controlled-ui20-v1",
        "sourceGroupId": SOURCE_GROUP,
        "cases": cases,
        "controls": {"positive": len(POSITIVE_KEYS), "negative": len(NEGATIVE_KEYS), "sourceDisjointSplitClaim": False},
    }
    truth_document = {
        "version": "calculator-controlled-ui20-truth-v1",
        "sourceGroupId": SOURCE_GROUP,
        "cases": truths,
    }
    source_ledger = {
        "version": "calculator-controlled-ui20-source-ledger-v1",
        "application": APP_VERSION,
        "applicationLicense": "GPL-2+ (Debian package copyright metadata)",
        "controlledStyle": {"description": "task-owned opaque green button fill and 3px magenta border", "cssCaptureScript": str(script.name)},
        "gtkBuilder": {"url": SOURCE_URL, "sha256": SOURCE_SHA256},
        "cases": ledger,
        "limitations": ["one controlled GNOME Calculator source family", "two viewport/window layouts", "AT-SPI provides button labels and sizes but reports x=y=0; geometry is independently bound by GtkBuilder grid cell and four painted edges", "controlled authored keypad contents, not natural user capture"],
    }
    # loadFreshCorpus consumes arrays; metadata lives in its separate source ledger.
    write_json(output / "inputs.json", cases)
    write_json(output / "truth.json", truth_document)
    write_json(output / "source-ledger.json", source_ledger)
    receipt = {
        "inputsSha256": sha256_file(output / "inputs.json"),
        "truthSha256": sha256_file(output / "truth.json"),
        "sourceLedgerSha256": sha256_file(output / "source-ledger.json"),
        "caseCount": len(cases),
        "present": sum(case["expectedPresence"] for case in truths),
        "absent": sum(not case["expectedPresence"] for case in truths),
        "sourceSha256": SOURCE_SHA256,
        "captureScriptSha256": sha256_file(script),
        "oracleScriptSha256": sha256_file(Path(__file__).with_name("oracle.py")),
    }
    write_json(output / "receipt.json", receipt)
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
