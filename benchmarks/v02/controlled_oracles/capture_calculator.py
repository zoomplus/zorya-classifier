#!/usr/bin/env python3
"""Capture GNOME Calculator in a caller-owned Xvfb/DBus session.

Run under an isolated X server and network namespace, for example:
  unshare -n -- dbus-run-session -- xvfb-run -a -s '-screen 0 1024x768x24' \
    python3 benchmarks/v02/controlled_oracles/capture_calculator.py .run/private-proof

The output directory must not exist. Only the calculator process started here is
terminated. The screenshot and inventory are private evidence, not training data.
"""

from __future__ import annotations

import hashlib
import json
import os
import argparse
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from oracle import sha256_file


CSS = """button {
  background-image: none;
  background-color: rgb(0, 210, 80);
  color: black;
  border: 3px solid rgb(240, 0, 200);
  border-radius: 0;
  box-shadow: none;
  opacity: 1;
  padding: 0;
}
"""
GTK_BUILDER_URL = "https://github.com/GNOME/gnome-calculator/blob/46.3/src/ui/buttons-basic.ui"
GTK_BUILDER_SHA256 = "248e9fca5c32a6197b6495a9dc4e1e4f7d176a17f86a76e18de25a7ec6a644a6"
EXPECTED_KEYS = ["(", ")", "%", "+", "−", ".", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "mod", "π", "√", "×", "÷", "x2", "="]


def _atomic_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path, help="new private evidence directory")
    parser.add_argument("--screen", default="1024x768")
    parser.add_argument("--window-size", help="optional owned application window size WIDTHxHEIGHT")
    parser.add_argument("--seed-text", default="", help="controlled ASCII calculator display entry")
    args = parser.parse_args()
    if re.fullmatch(r"[0-9+*/().% -]{0,48}", args.seed_text) is None:
        raise ValueError("seed text may contain only digits and basic ASCII calculator keys")
    for spec in (args.screen, args.window_size):
        if spec is None:
            continue
        match = re.fullmatch(r"([1-9][0-9]{2,3})x([1-9][0-9]{2,3})", spec)
        if match is None:
            raise ValueError("screen sizes must be WIDTHxHEIGHT")
        if int(match.group(1)) * int(match.group(2)) > 2_097_152:
            raise ValueError("capture display exceeds the 2MP source budget")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    config = output / "xdg-config"
    css_path = config / "gtk-4.0" / "gtk.css"
    css_path.parent.mkdir(parents=True)
    css_path.write_text(CSS, encoding="utf-8")
    if shutil.which("gnome-calculator") is None:
        raise RuntimeError("gnome-calculator is not installed")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required to capture the owned X11 display")
    version = subprocess.check_output(["gnome-calculator", "--version"], text=True, stderr=subprocess.STDOUT).strip()
    if version != "gnome-calculator 46.3":
        raise RuntimeError(f"unexpected calculator version: {version}")
    env = os.environ.copy()
    env.update({
        "GTK_A11Y": "atspi",
        "GDK_BACKEND": "x11",
        "GDK_SCALE": "1",
        "XDG_CONFIG_HOME": str(config),
        "XDG_CACHE_HOME": str(output / "xdg-cache"),
        "XDG_DATA_HOME": str(output / "xdg-data"),
    })
    app = subprocess.Popen(["gnome-calculator"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        import pyatspi

        root = pyatspi.Registry.getDesktop(0)
        app_node = None
        for _ in range(100):
            if app.poll() is not None:
                raise RuntimeError(f"calculator exited early ({app.returncode})")
            for i in range(root.childCount):
                candidate = root.getChildAtIndex(i)
                if (candidate.name or "") == "gnome-calculator":
                    app_node = candidate
                    break
            if app_node is not None and app_node.childCount:
                break
            time.sleep(0.1)
        if app_node is None or app_node.childCount == 0:
            raise RuntimeError("Calculator did not expose an AT-SPI tree")
        time.sleep(1.0)
        window_ids = subprocess.check_output(["xdotool", "search", "--onlyvisible", "--class", "gnome-calculator"], text=True).split()
        if not window_ids:
            raise RuntimeError("Calculator exposed no visible X11 window")
        geometries = []
        for window_id in window_ids:
            output_text = subprocess.check_output(["xdotool", "getwindowgeometry", "--shell", window_id], text=True)
            values = dict(line.split("=", 1) for line in output_text.splitlines() if "=" in line)
            geometries.append((int(values["WIDTH"]) * int(values["HEIGHT"]), window_id, values))
        _, main_window_id, main_window_geometry = max(geometries)
        if args.window_size is not None:
            width, height = args.window_size.split("x", 1)
            subprocess.run(["xdotool", "windowsize", main_window_id, width, height], check=True)
            time.sleep(0.5)
        if args.seed_text:
            subprocess.run(["xdotool", "windowfocus", "--sync", main_window_id], check=True)
            subprocess.run(["xdotool", "type", "--clearmodifiers", "--delay", "30", args.seed_text], check=True)
            time.sleep(0.25)
        screen_width, screen_height = (int(value) for value in args.screen.split("x", 1))
        # Keep the X11 cursor in the empty screen margin, away from painted
        # borders. On this Xvfb setup it starts at the screen center.
        subprocess.run(["xdotool", "mousemove", str(screen_width - 2), str(screen_height - 2)], check=True)
        time.sleep(0.1)
        records: list[dict[str, object]] = []
        stack = [app_node]
        while stack:
            node = stack.pop()
            role = node.getRoleName()
            name = node.name or ""
            if "button" in role.lower():
                rec: dict[str, object] = {"role": role, "name": name}
                try:
                    rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                    rec["extents"] = {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
                except Exception as exc:  # accessibility component position may be unavailable.
                    rec["extentsError"] = type(exc).__name__
                records.append(rec)
            for index in reversed(range(node.childCount)):
                stack.append(node.getChildAtIndex(index))
        names = sorted({record["name"] for record in records if record.get("name")})
        if not set(EXPECTED_KEYS).issubset(names):
            raise RuntimeError("AT-SPI inventory is missing one or more keypad keys")
        if sum(record.get("name") == "7" for record in records) != 1:
            raise RuntimeError("AT-SPI inventory did not identify exactly one key 7")
        screenshot = output / "screen.png"
        subprocess.run(
            ["ffmpeg", "-nostdin", "-n", "-v", "error", "-f", "x11grab", "-video_size", args.screen, "-i", os.environ["DISPLAY"], "-frames:v", "1", str(screenshot)],
            check=True,
            env=env,
        )
        metadata = {
            "application": "GNOME Calculator",
            "version": version,
            "controlled": True,
            "cssSha256": sha256_file(css_path),
            "gtkBuilderSource": GTK_BUILDER_URL,
            "gtkBuilderSha256": GTK_BUILDER_SHA256,
            "screenshotSha256": sha256_file(screenshot),
            "accessibilityButtons": sorted(records, key=lambda r: (str(r.get("name")), str(r.get("role")))),
            "keypadNames": names,
            "targetWidgetId": "calc_7_button",
            "targetAction": "insert digit 7",
            "networkIsolationRequired": True,
            "screen": args.screen,
            "requestedWindowSize": args.window_size,
            "seedText": args.seed_text,
            "mainWindow": main_window_geometry,
        }
        _atomic_json(output / "accessibility.json", metadata)
        return 0
    finally:
        if app.poll() is None:
            app.terminate()
            try:
                app.wait(timeout=3)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()


if __name__ == "__main__":
    raise SystemExit(main())
