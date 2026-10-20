#!/usr/bin/env python3
"""Capture an owned Wesnoth map-editor screen under one village-layer state.

Run this helper inside an owned Xvfb. A/B/A orchestration is deliberately
external so each phase receives an immutable preference snapshot and output
directory. This script starts and reaps only its own Wesnoth child process.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path


VERSION = "1.16.11"
SCREEN_SIZE = "1024x768"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_json_exclusive(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("map_file", type=Path)
    parser.add_argument("output", type=Path, help="new private phase directory")
    parser.add_argument("--villages", choices=("yes", "no"), required=True)
    parser.add_argument("--wait", type=float, default=3.0)
    parser.add_argument("--seed", type=int, default=20261021)
    args = parser.parse_args()
    if not args.map_file.is_file() or not args.map_file.name.endswith(".map"):
        raise ValueError("map_file must be an existing .map file")
    if not (0.5 <= args.wait <= 20):
        raise ValueError("wait must be in [0.5,20] seconds")
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("run this capture only inside the caller-owned Xvfb")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    map_file = args.map_file.resolve()
    user_data = output / "userdata"
    user_config = output / "userconfig"
    home = output / "home"
    for folder in (user_data, user_config, home):
        folder.mkdir()
    prefs = user_config / "preferences"
    prefs.write_text(
        "\n".join(
            (
                f"minimap_draw_villages={args.villages}",
                "animate_map=no",
                "animate_water=no",
                "show_standing_animations=no",
                "",
            )
        ),
        encoding="utf-8",
    )
    version_out = subprocess.check_output(
        ["wesnoth", "--version"], text=True, stderr=subprocess.STDOUT, timeout=10
    )
    match = re.search(r"Battle for Wesnoth v(\d+\.\d+\.\d+)", version_out)
    if match is None or match.group(1) != VERSION:
        raise RuntimeError("this proof is pinned to Wesnoth 1.16.11")
    command = [
        "wesnoth",
        "--noaddons",
        "--nosound",
        "--nomusic",
        "--windowed",
        "--resolution",
        SCREEN_SIZE,
        "--rng-seed",
        str(args.seed),
        "--userconfig-dir",
        str(user_config),
        "--userdata-dir",
        str(user_data),
        "-e",
        str(map_file),
    ]
    log = output / "wesnoth.log"
    started = time.monotonic()
    with log.open("xb") as log_stream:
        app = subprocess.Popen(
            command,
            cwd=output,
            env={**os.environ, "HOME": str(home), "SDL_VIDEODRIVER": "x11"},
            stdin=subprocess.DEVNULL,
            stdout=log_stream,
            stderr=subprocess.STDOUT,
        )
        try:
            time.sleep(args.wait)
            if app.poll() is not None:
                raise RuntimeError(f"Wesnoth exited before capture ({app.returncode})")
            screenshot = output / "screen.png"
            subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-n",
                    "-v",
                    "error",
                    "-f",
                    "x11grab",
                    "-video_size",
                    SCREEN_SIZE,
                    "-i",
                    os.environ["DISPLAY"],
                    "-frames:v",
                    "1",
                    str(screenshot),
                ],
                check=True,
                timeout=15,
            )
            metadata = {
                "application": "Battle for Wesnoth",
                "version": VERSION,
                "mode": "map editor",
                "controlled": True,
                "mapSha256": sha256(map_file),
                "preferenceSha256": sha256(prefs),
                "minimapDrawVillages": args.villages,
                "rngSeed": args.seed,
                "screenSize": SCREEN_SIZE,
                "waitSeconds": args.wait,
                "screenshotSha256": sha256(screenshot),
                "ownedGamePid": app.pid,
                "captureElapsedMonotonicSeconds": round(time.monotonic() - started, 3),
            }
            write_json_exclusive(output / "capture.json", metadata)
            return 0
        finally:
            if app.poll() is None:
                app.terminate()
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    app.kill()
                    app.wait()


if __name__ == "__main__":
    raise SystemExit(main())
