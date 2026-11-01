#!/usr/bin/env python3
"""Source-only Crimson roster gate and one-shot isolated metadata launch."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import resource
import select
import struct
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path("/root/.codex/artifacts/zorya-classifier-mcp-20261101")
SOURCE = ROOT / "crimson-metadata-contingency"
ARTIFACT = ROOT / "crimson-source-v1"
FACING_VARIANTS = ARTIFACT / "facing-variants-v2"
FACING_MANIFEST_SHA256 = "63a952d69c5e0576954d246ae9e3f5a66dc09bbdc5404c90fbd9b3d1c403e873"
REGISTERED_MAP_ORDER = ROOT / "main-dev-map-order-v3.json"
REGISTERED_MAP_ORDER_SHA256 = "7971c99ab729703d51ddea894d57ac1f1e8ca2d0a48c24329a583a1274047b5a"
PACKAGE = ARTIFACT / "packages/crimson_0.5.2-1.1build2_amd64.deb"
NATIVE_BLIT_TRACER = ARTIFACT / "native_blit_trace.so"
NATIVE_BLIT_TRACER_SHA256 = "4827880e153dfd68076a1bbc67e93f19af298c58c7fef8cb8d9b5443af738080"
NATIVE_PALETTE_MAP = ARTIFACT / "native-color-diagnostic-v3/native-palette-map.json"
NATIVE_PALETTE_MAP_SHA256 = "34719c2a768b506a8b4f7042715534be7c514ac09823fdfe2c76df936b82a3b8"
NATIVE_INPUT_WITNESS = ARTIFACT / "input-diagnostic-v3/receipt.json"
NATIVE_INPUT_WITNESS_SHA256 = "47eac85c7cb3b3dbfead775d43664750903e9a88a7a43047e545702784f8c74d"
DISPLAY_SOURCE_PINS = {
    "src-common-globals.h": "e4d779460b8b1f68237b8645ae72eef738dc8e7e63678332fae37d4f3eaf208b",
    "src-common-view.cpp": "c8341fc81b727a9673c00f4df33e204164ba9bcd6f58426e2db37f978845d4a1",
    "src-common-view.h": "12415404139ecbb4835c55ffa767a1dc988b4d9175409054f48c9f9756ca318e",
    "src-cf-platform.h": "b81a374d095ec77af93701fa5c951bbefb730db08cf50de4173afc559a8969cc",
    "src-common-color.h": "6b2a7761ab4ce2921aef0eb51018f5cd71d46e3a3f6fb1b4d9f7688b20d73a61",
}
RUNTIME_PACKAGE_HASHES = {
    "libmad0_0.15.1b-10.2ubuntu1_amd64.deb": "b482b33dc7c3490bb47c6e92351630b678f3d16c2d9c72236f8ab8ec63b1fcb3",
    "libmikmod3_3.3.11.1-7build1_amd64.deb": "5f4e2bf188f4fa8d2a5c29f08ece8295007364b3b42b65768e40bb0337e01e1c",
    "libsdl-mixer1.2_1.2.12-18_amd64.deb": "9e3effdbdd53c29da091fd19ef6004e59a55e5a865f863c795cfa4be218447b7",
    "libsdl-ttf2.0-0_2.0.11-6_amd64.deb": "e154f6224545ca65a0bfe97e4e72666b0425a9296195bfa29f2c413a6d924a88",
    "libsdl1.2debian_1.2.68-2_amd64.deb": "ab96fe60369fe364b00668d811e1a55d4b85ea483be7bbecb31ca18a73216540",
    "libopenal-data_1%3a1.23.1-4build1_all.deb": "0de2f2b7a29fa337432fa044ce6c238bc511b83dac14d68a32673d9803cbab83",
    "libopenal1_1%3a1.23.1-4build1_amd64.deb": "1781774a540ab7c9baccc41b49592e3b427c5820c64e390af4868d6a861ef8c7",
    "libsndio7.0_1.9.0-0.3build3_amd64.deb": "b3944745ee48ea2c7a851fb78a617d34bb731a2f956a2c213cc9dffcaba35382",
}
EXTRACTED = ARTIFACT / "extracted"
DATA = EXTRACTED / "usr/share/games/crimson"
CLIENT = EXTRACTED / "usr/games/crimson"
MAX_PACKAGE_BYTES = 40 * 1024 * 1024
MAX_EXTRACTED_BYTES = 200 * 1024 * 1024
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_CASE_SECONDS = 24
MAX_TRACE_BYTES = 8 * 1024 * 1024
MAX_TRACE_FILE_BYTES = 2 * 1024 * 1024
MAX_SANDBOX_TMP_BYTES = 16 * 1024 * 1024
MAX_MILESTONE_BYTES = 64 * 1024
MAX_CONTROLLER_DIAGNOSTICS = 256
MISSION_HANDICAP_BYTE_OFFSET = 15
HANDICAP_NONE_MASK = 0x01
EVENT_FLAG_DISABLED = 0x0001
EVENT_FLAG_DISCARDED = 0x8000
EXPECTED_PACKAGE_SHA256 = "cbb88cba562238457e32e5df245819e7c511eddcb76fa69b76c50fdf49e06fba"
SOURCE_HASHES = {
    "debian/copyright": "59139428a9b5dc5f0c8303afb63888d227cefb2a11287f1935ffc8217255d718",
    "doc/crimson.6": "c612bfc1051b8f8477d87d24a1719f26a8df07bf2ec3aa89b40c4e30d070c6a3",
    "doc/cfed.6": "ddec42e60d6f5b35da59e806d49d5b5a0ea4da4c5dd2952ac45be7aaabb7145e",
    "levels/Anthill.src": "ed655947d8655dfc12ce120ad1e716cdebb64150a75d126a62447fe23e82b4a7",
    "levels/ArmsRace.src": "7aecfbcc6fa4c15e27923abb3d8b30a417cd322bd6754e8aa43f96d993039d59",
    "levels/Baptism.src": "40eccbc54823d8d7745c2990eebf0f8cdab66aa4b111f9b92bdfc0a1bf4064f5",
    "levels/BeachRaid.src": "7a553d7c2c5d1db47510b63f4cb87e3537f41b11b40dc20e3ba31052ab0024ae",
    "levels/ClippedWings.src": "7c7cead188a356ec76f263d6ab1193d6a18eb01c0737b7866cf28c198c94d88d",
    "src/cf/main.cpp": "e5fbf358c4e5390ec3056d507f08e3976af80eaabc31f2efaaaaeedcdb3b8dba",
    "src/cf/game.cpp": "5d98a06b9d88cef903f8f0c3d8cb6d77899cdd0e1407753b0e4ba98aceec78a9",
    "src/cf/mission.cpp": "8e47c9e473ded8e48e48f3b28c0141aba2629018bfead02669ab180f2895506f",
    "src/cf/mapwindow.cpp": "34ef28b981b0611f1700e94aecb0cc10c4fe31ba6e2f2fd85b676fd96eb3d7e6",
    "src/cf/map.cpp": "ebc2caa937fb7eb4ed54e06fcb66b3f32cb2523ee90439e1147a9e2f0250f81e",
    "src/cf/unit.cpp": "a43fa930e64602ab9402aa8a5c25fc8248c018dd12387c42ed15d7dd6f1f7fcc",
    "src/cf/event.cpp": "7b374b7e89faed7e40cbb5c89002d2de7f0b79ee9041f38b0c386474108e733e",
    "src/common/gamedefs.h": "b62fd234dc5a44403af27c41b2b0847fcb6f7bafc48afa41a04369ee436d31eb",
    "src/common/hexsup.cpp": "e9de6204d10c55cdf00ff155128276fe2412fbf739fb45473ef2534898a8990b",
    "src/common/mapview.cpp": "3d69202f8da749285d13c26b69873d661659bd18287c1c63f33f99671eef34cc",
    "src/common/mapview.h": "018125186ffdd07ab7d5c36ca4c73d5628dd63b6bf0a14f9fddb92ed9cd4d6c1",
    "src/common/surface.cpp": "00ba2b23bdc8ccfb713c9c866c87df7bb83e6af444669fdbd0006fe080fe7680",
    "tools/default.usrc": "e5226bb0331630934706748f6ce04553f3ff8ce975487ac95fd59bc20cf28d51",
    "levels.json": "5ff710b9f87363d23eec64e536a54343541878bcb36af341e07504a608052dab",
    "tools.json": "dd2ae7bc7f553f900d35d269e743d0f6c5bad8218ceae347ea6d23bea9de89e0",
}
ASSET_HASHES = {
    "Bepa-Roman.ttf": "15f28ce8aabe52c2518b03ee8ac37a8a3eb408e96dce96f8078322514a7f046b",
    "cf.dat": "07d765542ee0908355d9853c371cc360d0c9942803742b7f8142e0af6cbfff61",
    "default.tiles": "c93ff85d7edb38f09e088a7bda86e939966f85092d91d00ba7e52b29bc1a0d20",
    "default.units": "297c9b5f2a6b9b61a16d0e35c79d53fb3cc1697378ac061b1d8b624765a35540",
    "levels/Anthill.lev": "e5781bf4a17efd16f2acd0641e49d9b6b450d9a84fafaf86dbe0f84e51c1004e",
    "levels/ArmsRace.lev": "8fceeaf9d1594980bb9252574744f2208e1790195de5e07aadebe6a920d46ebb",
    "levels/Baptism.lev": "42039a581501be3f0df41a0d76a5d8d85c17744b32f10faa5fda1743cc9fc32d",
    "levels/BeachRaid.lev": "ccf12201c995e07cfc7c46e3c2a9074b1cb7c079bf4c17683d67f13c6140b05d",
    "levels/ClippedWings.lev": "b93bf77711ed4571ce365c15c9dd2e6f42dfc217f838ae47c895842716412696",
}
HOST_TOOL_HASHES = {
    "/usr/bin/bwrap": "e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71",
    "/usr/bin/strace": "28f957c227012de0b18d1bd7fff2d396cb693ea60ed8013be68de071e84b5001",
    "/usr/bin/xdotool": "a21dba4297e197ef27035071f6a36061cc8604ac360df19792db99ad3fd9a5f5",
    "/usr/bin/Xvfb": "2c7f5a9534410fed5092d782a69ca7ffd9fce80e98b81ffe4944d703dd11d3b1",
}
NEGATIVE_ANCHOR_FACES = {"ArmsRace": 2, "Baptism": 5}
NEGATIVE_ANCHOR_UNITS = {
    "ArmsRace": {"unitId": 3, "hex": [5, 2], "face": 2, "sourceRect": [64, 0, 32, 28]},
    "Baptism": {"unitId": 1, "hex": [32, 48], "face": 5, "sourceRect": [160, 0, 32, 28]},
}
NEGATIVE_HEALTHBAR_OVERLAP = {"ArmsRace": [19, 23], "Baptism": None}
ROSTER = [
    {
        "caseId": "crimson-anthill-p1", "mapId": "a9fc2cddf65b5d3d8e11c1d5dd8d5011",
        "stateId": "cfed-anthill-97-face2", "level": "Anthill", "label": "positive",
        "variantState": "crimson-anthill-artillery-face2-v1",
        "query": "Where is the westernmost yellow artillery unit on the play map?", "type": "Artillery", "player": 1,
        "unitId": 97, "hex": [14, 23], "face": 2, "selection": "westernmost",
    },
    {
        "caseId": "crimson-beachraid-p1", "mapId": "f57a524407ce9c570749d60ced201405",
        "stateId": "cfed-beachraid-8-face1", "level": "BeachRaid", "label": "positive",
        "variantState": "crimson-beachraid-troop-train-face1-v1",
        "query": "Where is a yellow troop train on the play map?", "type": "Troop Train", "player": 1,
        "unitId": 8, "hex": [1, 10], "face": 1,
    },
    {
        "caseId": "crimson-clippedwings-p1", "mapId": "68194e1fe9c3e86f1d81948f935c2da5",
        "stateId": "cfed-clippedwings-30-face2", "level": "ClippedWings", "label": "positive",
        "variantState": "crimson-clippedwings-aa-guns-face2-v1",
        "query": "Where is a yellow anti-aircraft gun on the play map?", "type": "Anti-Aircraft Guns", "player": 1,
        "unitId": 30, "hex": [6, 13], "face": 2,
    },
    {
        "caseId": "crimson-armsrace-n1", "mapId": "e748eab70e95ed69c66950aacc285860",
        "stateId": "stock-armsrace", "level": "ArmsRace", "label": "negative",
        "query": "Where is a submarine on the play map?", "type": "Submarines",
    },
    {
        "caseId": "crimson-baptism-n1", "mapId": "dfebd59e01fbd7034a16d3a6de1ef993",
        "stateId": "stock-baptism", "level": "Baptism", "label": "negative",
        "query": "Where is a submarine on the play map?", "type": "Submarines",
    },
]

FACING_RECIPE_PINS = {
    "Anthill": {
        "stateId": "crimson-anthill-artillery-face2-v1",
        "source": ("sources/crimson-anthill-artillery-face2-v1.src", "302c4e9bb483331379467ab729bfb3011b957d2c96c53098a7b8ec090c7158e2"),
        "level": ("compiled/crimson-anthill-artillery-face2-v1.lev", "feee1e1b3d838c378e8c5b57426e927dd41c484492ca2e536abbb898cbc83dec"),
        "faceOffset": 10886, "stockFace": 0, "privateFace": 2,
    },
    "BeachRaid": {
        "stateId": "crimson-beachraid-troop-train-face1-v1",
        "source": ("sources/crimson-beachraid-troop-train-face1-v1.src", "772dde205e1dac961abb48c0bfecc86ac6c8bfb04195886afeec028226ae9377"),
        "level": ("compiled/crimson-beachraid-troop-train-face1-v1.lev", "ea85194c8602f17b43749cd3a8fabe16c62be2c303db219216c28a862b07644b"),
        "faceOffset": 7590, "stockFace": 0, "privateFace": 1,
    },
    "ClippedWings": {
        "stateId": "crimson-clippedwings-aa-guns-face2-v1",
        "source": ("sources/crimson-clippedwings-aa-guns-face2-v1.src", "8aa969cfbd6809cd8595fbf3d01b7ecc9c4bb1e782c8c5ae7d52c8e06e33f2e2"),
        "level": ("compiled/crimson-clippedwings-aa-guns-face2-v1.lev", "28f69babce6b7a9706d254eb72d2d140535a32d1adfcdfff1f8ebce63dd85234"),
        "faceOffset": 12775, "stockFace": 0, "privateFace": 2,
    },
}
BAPTISM_TIMER_ZERO_CREATE_DEPENDENCIES = {
    "14": None, "15": "14", "16": "14", "17": "14", "18": "14", "19": "14", "20": "14",
    "24": "14", "25": "14", "26": "14", "27": "14",
    "0": None, "1": "0", "2": "0", "3": "0", "4": "0",
}
UNIT_ATLAS = {
    "Artillery": {"icon": 24, "face": 2, "tile": 26, "opaque": 272, "box": [4, 3, 27, 23]},
    "Troop Train": {"icon": 228, "face": 1, "tile": 229, "opaque": 286, "box": [4, 3, 27, 24]},
    "Anti-Aircraft Guns": {"icon": 156, "face": 2, "tile": 158, "opaque": 246, "box": [6, 3, 26, 23]},
}
ATLAS_AUDIT = SOURCE / "main-independent-unit-atlas-audit-v1.json"
ATLAS_AUDIT_SHA256 = "11e0ce97d9a93860df7067bdda6006c150171ccafe1e05e84e4cd1042b364420"
ATLAS_HEADER_OFFSET = 3518
ATLAS_RASTER_OFFSET = 3907
ATLAS_TILE_WIDTH = 32
ATLAS_TILE_HEIGHT = 28
HEALTH_BAR_RECT = (12, 23, 20, 27)
MAPVIEW_SOURCE_PINS = {
    "src/common/lset.cpp": "c6e42cb8f6850b6d81bf3b69e1ea696079d146b2c1a2a0ba2540556589a08290",
    "src/common/lset.h": "795210729b41fbc71aa09f50810d5cc9ecb0b36864e787843814be18bc040cd0",
    "src/common/mapview.cpp": SOURCE_HASHES["src/common/mapview.cpp"],
    "src/cf/mapwindow.cpp": "34ef28b981b0611f1700e94aecb0cc10c4fe31ba6e2f2fd85b676fd96eb3d7e6",
    "src/cf/game.cpp": SOURCE_HASHES["src/cf/game.cpp"],
}


class OracleError(RuntimeError):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _controller_environment(display: str) -> dict[str, str]:
    if not display.startswith(":") or not display[1:].isdecimal():
        raise OracleError("Xvfb returned an invalid dynamically allocated display")
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "DISPLAY": display}


def _display_binding(display: str) -> list[str]:
    return ["--setenv", "DISPLAY", display]


def _xdotool(
    display: str, arguments: list[str], diagnostics: list[dict[str, Any]],
    run_store: MetadataRunStore | None = None,
) -> subprocess.CompletedProcess[bytes]:
    argv = ["/usr/bin/xdotool", *arguments]
    try:
        result = subprocess.run(
            argv, check=False, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=2, env=_controller_environment(display),
        )
    except subprocess.TimeoutExpired as error:
        row = {
            "argv": ["xdotool", *arguments], "returncode": None, "timedOut": True,
            "stdout": (error.stdout or b"").decode("ascii", "replace")[:2048],
            "stderr": (error.stderr or b"").decode("utf-8", "replace")[:2048],
        }
        if len(diagnostics) < MAX_CONTROLLER_DIAGNOSTICS:
            diagnostics.append(row)
        if run_store is not None:
            run_store.milestone("controller-command", row)
        raise
    except OSError as error:
        row = {
            "argv": ["xdotool", *arguments], "returncode": None,
            "launchError": f"{type(error).__name__}: {error}",
        }
        if len(diagnostics) < MAX_CONTROLLER_DIAGNOSTICS:
            diagnostics.append(row)
        if run_store is not None:
            run_store.milestone("controller-command", row)
        raise
    row = {
        "argv": ["xdotool", *arguments], "returncode": result.returncode,
        "stdout": result.stdout.decode("ascii", "replace")[:2048],
        "stderr": result.stderr.decode("utf-8", "replace")[:2048],
    }
    if len(diagnostics) >= MAX_CONTROLLER_DIAGNOSTICS:
        raise OracleError("controller diagnostics exceeded their fixed call bound")
    diagnostics.append(row)
    if run_store is not None:
        run_store.milestone("controller-command", row)
    return result


def read_pinned(path: Path, expected: str, cap: int = MAX_SOURCE_BYTES) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise OracleError(f"pinned input is missing or not a regular file: {path.name}")
    size = path.stat().st_size
    if size > cap:
        raise OracleError(f"pinned input exceeds {cap} bytes: {path.name}")
    data = path.read_bytes()
    if len(data) != size or sha256(data) != expected:
        raise OracleError(f"pinned input digest mismatch: {path.name}")
    return data


def parse_level_units(payload: bytes) -> list[dict[str, Any]]:
    """Parse ordered [unit] records; omitted type inherits the last declared type."""
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise OracleError("level source is not UTF-8") from error
    rows: list[dict[str, Any]] = []
    current: dict[str, str] | None = None
    inherited_type: str | None = None
    section: str | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            if section == "unit" and current is not None:
                rows.append(_finish_unit(current, inherited_type))
            section = line[1:-1].strip().lower()
            current = {} if section == "unit" else None
            continue
        if section != "unit" or current is None or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        current[key.lower()] = value
        if key.lower() == "type":
            inherited_type = value
    if section == "unit" and current is not None:
        rows.append(_finish_unit(current, inherited_type))
    return rows


def parse_level_buildings(payload: bytes) -> list[dict[str, Any]]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise OracleError("level source is not UTF-8") from error
    rows: list[dict[str, Any]] = []
    fields: dict[str, str] | None = None
    section: str | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            if section == "building" and fields is not None:
                rows.append(_finish_building(fields))
            section = line[1:-1].strip().lower()
            fields = {} if section == "building" else None
            continue
        if section == "building" and fields is not None and "=" in line:
            key, value = (part.strip() for part in line.split("=", 1))
            fields[key.lower()] = value
    if section == "building" and fields is not None:
        rows.append(_finish_building(fields))
    return rows


def _finish_building(fields: dict[str, str]) -> dict[str, Any]:
    try:
        player = int(fields["player"], 10)
        building_id = int(fields["id"], 10)
        hex_x, hex_y = (int(part, 10) for part in fields["pos"].split("/", 1))
    except (KeyError, ValueError) as error:
        raise OracleError("building source record is missing valid player/id/pos") from error
    return {"type": fields.get("type", ""), "player": player, "buildingId": building_id, "hex": [hex_x, hex_y]}


def _native_constant(header: bytes, symbol: str) -> int:
    pattern = re.compile(rb"^#define\s+" + re.escape(symbol.encode("ascii")) + rb"\s+(-?\d+)", re.MULTILINE)
    match = pattern.search(header)
    if match is None:
        raise OracleError(f"pinned native header lacks constant {symbol}")
    return int(match.group(1), 10)


def verify_compiled_event_order(
    level_bytes: bytes, events: list[dict[str, str]], gamedefs_header: bytes,
) -> dict[str, Any]:
    """Locate and compare the exact Event::Save records in a native compiled .lev."""
    event_type_symbols = {
        "message": "EVENT_MESSAGE", "mining": "EVENT_MINING", "score": "EVENT_SCORE",
        "configure": "EVENT_CONFIGURE", "createunit": "EVENT_CREATE_UNIT",
        "manipulateevent": "EVENT_MANIPULATE_EVENT", "research": "EVENT_RESEARCH",
        "sethex": "EVENT_SET_HEX", "settimer": "EVENT_SET_TIMER", "destroyunit": "EVENT_DESTROY_UNIT",
    }
    trigger_symbols = {
        "timer": "ETRIGGER_TIMER", "unitdestroyed": "ETRIGGER_UNIT_DESTROYED",
        "havebuilding": "ETRIGGER_HAVE_BUILDING", "haveunit": "ETRIGGER_HAVE_UNIT",
        "unitposition": "ETRIGGER_UNIT_POSITION", "handicap": "ETRIGGER_HANDICAP",
        "havecrystals": "ETRIGGER_HAVE_CRYSTALS",
    }
    record_size = 24  # Event::Save: 5 bytes, 6 signed words, 3 unsigned words, player byte.
    field_by_trigger = {
        "timer": ("ttime", None, None),
        "handicap": ("thandicap", None, None),
        "unitdestroyed": ("tunit", "towner", None),
        "havebuilding": ("tbuilding", "towner", "ttime"),
        "haveunit": ("tunit", "towner", "ttime"),
        "unitposition": ("tunit", "pos", "towner"),
    }
    encoded_rows: list[tuple[int, int, int, int, int, int, int, int]] = []
    for event in events:
        event_type = event.get("type", "").lower()
        trigger = event.get("trigger", "").lower()
        if event_type not in event_type_symbols or trigger not in trigger_symbols:
            raise OracleError("source event type/trigger cannot be matched to native event constants")
        fields = field_by_trigger.get(trigger)
        trigger_data = [0xFFFF, 0xFFFF, 0xFFFF]
        if fields is not None:
            for index, field in enumerate(fields):
                if field is not None and field in event:
                    value = int(event[field].split("/", 1)[0], 10)
                    trigger_data[index] = value & 0xFFFF
        dependency = int(event.get("depend", "-1"), 10) & 0xFF
        discard = int(event.get("discard", "-1"), 10) & 0xFF
        flags = int(event.get("flags", "0"), 10) & 0xFFFF
        player = (int(event.get("player", "1"), 10) - 1) & 0xFF
        encoded_rows.append((
            int(event["id"], 10), _native_constant(gamedefs_header, event_type_symbols[event_type]),
            _native_constant(gamedefs_header, trigger_symbols[trigger]), dependency, discard,
            trigger_data[0], flags, player,
        ))
    count = len(events)
    candidates: list[int] = []
    for start in range(2, len(level_bytes) - count * record_size + 1):
        if int.from_bytes(level_bytes[start - 2:start], "little") != count:
            continue
        valid = True
        for index, expected in enumerate(encoded_rows):
            offset = start + index * record_size
            record = level_bytes[offset:offset + record_size]
            if len(record) != record_size:
                valid = False
                break
            event_id, event_type, trigger, dependency, discard, tdata0, flags, player = expected
            native_tdata0 = int.from_bytes(record[5:7], "little", signed=True)
            if (
                (record[0], record[1], record[2], record[3], record[4], native_tdata0,
                 int.from_bytes(record[21:23], "little"), record[23])
                != (event_id, event_type, trigger, dependency, discard, (tdata0 if tdata0 < 0x8000 else tdata0 - 0x10000), flags, player)
            ):
                valid = False
                break
        if valid:
            candidates.append(start)
    if len(candidates) != 1:
        raise OracleError("compiled level does not contain one exact source-ordered native event queue")
    return {
        "status": "compiled-event-queue-matches-source-order",
        "recordCount": count, "recordSizeBytes": record_size,
        "eventQueueOffset": candidates[0], "eventIdsInNativeOrder": [row[0] for row in encoded_rows],
        "matchingStartCount": 1,
    }


def verify_source_target_is_on_play_map(
    item: dict[str, Any], units: list[dict[str, Any]], buildings: list[dict[str, Any]],
) -> dict[str, Any]:
    target_rows = [
        (index, unit) for index, unit in enumerate(units)
        if unit["unitId"] == item["unitId"] and unit["hex"] == item["hex"]
        and unit["type"] == item["type"] and unit["player"] == item["player"]
    ]
    if len(target_rows) != 1:
        raise OracleError("positive target is not uniquely identified in the initial source units")
    index, target = target_rows[0]
    position = tuple(target["hex"])
    same_hex_buildings = [building for building in buildings if tuple(building["hex"]) == position]
    earlier_units = [unit for unit in units[:index] if tuple(unit["hex"]) == position]
    if same_hex_buildings or earlier_units:
        raise OracleError("positive target may be inside a building or an earlier transporter")
    return {
        "status": "source-order-target-is-a-play-map-unit",
        "unitId": item["unitId"], "hex": item["hex"],
        "buildingAtHex": False, "earlierUnitAtHex": False,
        "sourceOrderIndex": index,
    }


def parse_level_events(payload: bytes) -> list[dict[str, str]]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise OracleError("level source is not UTF-8") from error
    rows: list[dict[str, str]] = []
    fields: dict[str, str] | None = None
    section: str | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            if section == "event" and fields is not None:
                rows.append(fields)
            section = line[1:-1].strip().lower()
            fields = {} if section == "event" else None
            continue
        if section == "event" and fields is not None and "=" in line:
            key, value = (part.strip() for part in line.split("=", 1))
            fields[key.lower()] = value
    if section == "event" and fields is not None:
        rows.append(fields)
    if any(not {"id", "type", "trigger"}.issubset(row) for row in rows):
        raise OracleError("level event source record is missing id/type/trigger")
    return rows


def _finish_unit(fields: dict[str, str], inherited_type: str | None) -> dict[str, Any]:
    unit_type = fields.get("type", inherited_type)
    if unit_type is None:
        raise OracleError("first unit record has no explicit type")
    try:
        player = int(fields["player"], 10)
        unit_id = int(fields["id"], 10)
        hex_x, hex_y = (int(part, 10) for part in fields["pos"].split("/", 1))
    except (KeyError, ValueError) as error:
        raise OracleError("unit source record is missing valid player/id/pos") from error
    row: dict[str, Any] = {"type": unit_type, "player": player, "unitId": unit_id, "hex": [hex_x, hex_y]}
    if "face" in fields:
        try:
            row["face"] = int(fields["face"], 10)
        except ValueError as error:
            raise OracleError("unit source record has an invalid face") from error
    return row


def _event_integer(event: dict[str, str], field: str, default: int | None = None) -> int:
    value = event.get(field)
    if value is None and default is not None:
        return default
    if value is None:
        raise OracleError(f"event source is missing required field {field}")
    try:
        return int(value, 10)
    except ValueError as error:
        raise OracleError(f"event source field {field} is not an integer") from error


def _event_trigger_matches(event: dict[str, str], handicap_mask: int, time_at_start: int) -> bool:
    flags = _event_integer(event, "flags", 0)
    if flags & EVENT_FLAG_DISCARDED:
        return True
    if flags & EVENT_FLAG_DISABLED:
        return False
    trigger = event.get("trigger", "").lower()
    if trigger == "handicap":
        return (handicap_mask & _event_integer(event, "thandicap")) != 0
    if trigger == "timer":
        return time_at_start >= _event_integer(event, "ttime")
    return False


def _event_dependency_matches(
    event: dict[str, str], by_id: dict[str, dict[str, str]], removed: set[str],
    handicap_mask: int, time_at_start: int, visiting: set[str] | None = None,
) -> bool:
    dependency = event.get("depend")
    if dependency is None:
        return True
    if dependency in removed:
        return True
    parent = by_id.get(dependency)
    if parent is None:
        return True
    if _event_integer(parent, "flags", 0) & EVENT_FLAG_DISCARDED:
        return True
    active_path = set() if visiting is None else set(visiting)
    if dependency in active_path:
        raise OracleError("event dependency cycle prevents exact initialization proof")
    active_path.add(dependency)
    if not _event_trigger_matches(parent, handicap_mask, time_at_start):
        return False
    return _event_dependency_matches(parent, by_id, removed, handicap_mask, time_at_start, active_path)


def _event_is_ready(
    event: dict[str, str], by_id: dict[str, dict[str, str]], removed: set[str],
    handicap_mask: int, time_at_start: int,
) -> bool:
    return _event_trigger_matches(event, handicap_mask, time_at_start) and _event_dependency_matches(
        event, by_id, removed, handicap_mask, time_at_start, {event["id"]},
    )


def _spawn_from_event(
    event: dict[str, str], units: list[dict[str, Any]], buildings: list[dict[str, Any]],
    occupied_hexes: set[tuple[int, int]], used_ids: set[int], phase: str,
) -> dict[str, Any]:
    try:
        hex_x, hex_y = (int(part, 10) for part in event["pos"].split("/", 1))
        player = int(event["player"], 10)
        face = int(event.get("face", "0"), 10)
        group = int(event.get("group", "6"), 10)
        experience = int(event.get("xp", "0"), 10)
    except (KeyError, ValueError) as error:
        raise OracleError("active createunit event lacks a valid native unit specification") from error
    position = (hex_x, hex_y)
    if position in occupied_hexes:
        raise OracleError("active createunit event targets an occupied unit/building hex")
    if not 1 <= group <= 6 or not 0 <= face <= 5:
        raise OracleError("active createunit event has out-of-range face or group")
    unit_id = 32000
    while unit_id in used_ids and unit_id > 0:
        unit_id -= 1
    if unit_id <= 0:
        raise OracleError("native unit ID allocation exhausted")
    used_ids.add(unit_id)
    occupied_hexes.add(position)
    created = {
        "type": event.get("unit", ""), "player": player, "unitId": unit_id,
        "hex": [hex_x, hex_y], "face": face, "group": group, "experienceLevel": experience,
        "createdByEventId": event["id"], "creationPhase": phase,
    }
    units.append(created)
    return created


def simulate_initial_unit_inventory(
    events: list[dict[str, str]], units: list[dict[str, Any]], buildings: list[dict[str, Any]],
    handicap_mask: int, level: str,
) -> dict[str, Any]:
    """Apply all source-proven pre-start and due-now createunit events in queue order."""
    by_id: dict[str, dict[str, str]] = {}
    for event in events:
        if event["id"] in by_id:
            raise OracleError("level event IDs are not unique")
        by_id[event["id"]] = event
    if level == "Baptism":
        observed_dependencies = {
            event["id"]: event.get("depend")
            for event in events
            if event.get("type", "").lower() == "createunit"
            and event.get("trigger", "").lower() == "timer"
            and _event_integer(event, "ttime", 1) == 0
        }
        if observed_dependencies != BAPTISM_TIMER_ZERO_CREATE_DEPENDENCIES:
            raise OracleError("Baptism due-now spawn dependency graph differs from the pinned proof")
    unsupported_unit_paths = [
        event for event in events
        if event.get("type", "").lower() in {"createunit", "destroyunit"}
        and event.get("trigger", "").lower() not in {"handicap", "timer"}
    ]
    if unsupported_unit_paths:
        raise OracleError("unit inventory has an unsupported non-handicap/non-timer event path")
    original_units = len(units)
    occupied_hexes = {tuple(row["hex"]) for row in units} | {tuple(row["hex"]) for row in buildings}
    used_ids = {int(row["unitId"]) for row in units}
    removed: set[str] = set()
    executed_prestart: list[str] = []
    generated: list[dict[str, Any]] = []
    for event in events:
        if event.get("trigger", "").lower() != "handicap":
            continue
        if not _event_is_ready(event, by_id, removed, handicap_mask, 0):
            continue
        kind = event["type"].lower()
        if kind == "createunit":
            generated.append(_spawn_from_event(event, units, buildings, occupied_hexes, used_ids, "pre-start-handicap"))
        elif kind == "destroyunit":
            raise OracleError("active pre-start destroyunit event prevents exact inventory proof")
        elif kind not in {"message", "score", "configure", "mining", "research", "sethex", "settimer"}:
            raise OracleError("active pre-start event type is not covered by the unit inventory proof")
        removed.add(event["id"])
        executed_prestart.append(event["id"])

    executed_turn_start: list[str] = []
    for event in events:
        if event.get("trigger", "").lower() != "timer" or _event_integer(event, "ttime", 1) > 0:
            continue
        if event["id"] in removed or not _event_is_ready(event, by_id, removed, handicap_mask, 0):
            continue
        kind = event["type"].lower()
        if kind == "createunit":
            generated.append(_spawn_from_event(event, units, buildings, occupied_hexes, used_ids, "turn-start-timer-zero"))
        elif kind == "destroyunit":
            raise OracleError("active timer-zero destroyunit event prevents exact inventory proof")
        elif kind not in {"message", "score", "configure", "mining", "research", "sethex", "settimer"}:
            raise OracleError("active timer-zero event type is not covered by the unit inventory proof")
        removed.add(event["id"])
        executed_turn_start.append(event["id"])

    setters: list[dict[str, Any]] = []
    for event in events:
        if event.get("type", "").lower() != "settimer":
            continue
        target_id = event.get("event")
        target = by_id.get(target_id or "")
        if target is None:
            raise OracleError("settimer event references a missing timer target")
        delay = _event_integer(event, "time")
        offset = _event_integer(event, "offset", 0)
        if offset not in {0, 1, 2}:
            raise OracleError("settimer offset is unsupported by the source-level inventory proof")
        base_time = 0 if offset == 1 else (_event_integer(target, "ttime", 0) if offset == 2 else 0)
        resulting_time = delay + base_time
        if resulting_time <= 0:
            raise OracleError("settimer event can schedule a map mutation at first-turn time")
        setters.append({"id": event["id"], "trigger": event.get("trigger"), "targetEvent": target_id,
                        "delay": delay, "offset": offset, "resultingTime": resulting_time})

    interactive_messages = [
        event["id"] for event in events
        if event["id"] in executed_turn_start and event.get("type", "").lower() == "message"
        and event.get("player") == "1"
    ]
    return {
        "status": "exact-source-event-inventory-simulated",
        "handicapMask": handicap_mask, "timeAtFirstTurn": 0,
        "initialUnitCount": original_units, "postInitializationUnitCount": len(units),
        "sourceUnitCount": original_units, "createdUnits": generated,
        "preStartEventsExecuted": executed_prestart,
        "timerZeroEventsExecuted": executed_turn_start,
        "interactiveTimerMessageEventIds": interactive_messages,
        "additionalMessageDismissalsRequired": len(interactive_messages),
        "screenReadyForCapture": False,
        "timerSetters": setters,
        "completePostInitializationInventory": units,
        "inventoryUnchangedByPinnedInitialEvents": not generated,
        "inventoryProofComplete": True,
        "basis": "pinned mission handicap byte, event flags/dependencies/order, Mission::CreateUnitID, Event::Execute, and empty spawn hexes",
    }


def audit_native_unit_atlas() -> dict[str, Any]:
    """Decode the pinned native surface and verify the three prospective clean sprites."""
    audit_bytes = read_pinned(ATLAS_AUDIT, ATLAS_AUDIT_SHA256)
    audit = json.loads(audit_bytes)
    compressed = read_pinned(DATA / "default.units", ASSET_HASHES["default.units"], MAX_EXTRACTED_BYTES)
    try:
        payload = gzip.decompress(compressed)
    except OSError as error:
        raise OracleError("pinned native unit set is not a valid gzip stream") from error
    if len(payload) != audit.get("decompressedStockBytes"):
        raise OracleError("decompressed unit-set size differs from the independent atlas audit")
    header_end = ATLAS_HEADER_OFFSET + 8
    if len(payload) < header_end:
        raise OracleError("native atlas header is truncated")
    width, height, bpp, flags, palette_count = struct.unpack_from("<HHBBH", payload, ATLAS_HEADER_OFFSET)
    key_offset = header_end
    key_rgb = tuple(payload[key_offset:key_offset + 3]) if flags & 0x01 else None
    palette_offset = key_offset + (3 if flags & 0x01 else 0)
    palette_end = palette_offset + palette_count * 3
    raster_offset = palette_end
    raster_end = raster_offset + width * height
    if (width, height, bpp, flags, palette_count, raster_offset) != (768, 336, 8, 1, 126, ATLAS_RASTER_OFFSET):
        raise OracleError("native unit atlas dimensions, flags, palette or raster offset changed")
    if raster_end > len(payload):
        raise OracleError("native unit atlas raster is truncated")
    palette = [tuple(payload[index:index + 3]) for index in range(palette_offset, palette_end, 3)]
    pixels = payload[raster_offset:raster_end]
    if payload.find(pixels) != raster_offset or payload.count(pixels) != 1:
        raise OracleError("native atlas raster is not present exactly once at its pinned offset")
    key_indices = [index for index, color in enumerate(palette) if color == key_rgb]
    if key_rgb != (210, 2, 252) or key_indices != [0] or audit.get("colorkeyIndex") != 0:
        raise OracleError("native atlas colorkey does not match the pinned independent audit")
    if palette != [tuple(row) for row in audit.get("palette", [])] and audit.get("palette") is not None:
        raise OracleError("native atlas palette differs from the independent audit")
    if audit.get("paletteBytesExact") is not True or audit.get("stockTileSize") != [32, 28]:
        raise OracleError("independent atlas audit lacks the required exact palette and tile evidence")

    rows: list[dict[str, Any]] = []
    for unit_type, expected in UNIT_ATLAS.items():
        icon_rows = audit.get("sourceRows", {}).get(unit_type, [])
        reference = next((row for row in icon_rows if row.get("facing") == expected["face"]), None)
        if reference is None or reference.get("atlasTileNumber") != expected["tile"]:
            raise OracleError(f"independent native source does not confirm the atlas tile for {unit_type}")
        if expected["tile"] != expected["icon"] + expected["face"]:
            raise OracleError(f"atlas icon/facing arithmetic is inconsistent for {unit_type}")
        tiles_per_row = width // ATLAS_TILE_WIDTH
        x0 = (expected["tile"] % tiles_per_row) * ATLAS_TILE_WIDTH
        y0 = (expected["tile"] // tiles_per_row) * ATLAS_TILE_HEIGHT
        opaque_points: list[tuple[int, int]] = []
        for local_y in range(ATLAS_TILE_HEIGHT):
            for local_x in range(ATLAS_TILE_WIDTH):
                raster_index = (y0 + local_y) * width + x0 + local_x
                if pixels[raster_index] != 0:
                    opaque_points.append((local_x, local_y))
        if not opaque_points:
            raise OracleError(f"native atlas tile is fully transparent: {unit_type}")
        xs = [point[0] for point in opaque_points]
        ys = [point[1] for point in opaque_points]
        box = [min(xs), min(ys), max(xs) + 1, max(ys) + 1]
        hp_left, hp_top, hp_right, hp_bottom = HEALTH_BAR_RECT
        health_intersection = sum(
            hp_left <= px < hp_right and hp_top <= py < hp_bottom for px, py in opaque_points
        )
        if len(opaque_points) != expected["opaque"] or box != expected["box"] or health_intersection != 0:
            raise OracleError(f"native atlas sprite mask or healthbar clearance differs for {unit_type}")
        if reference.get("nonColorkeyPixels") != len(opaque_points) or reference.get("localBoxXYXY") != box:
            raise OracleError(f"decoded native sprite differs from independent raster audit for {unit_type}")
        rows.append({
            "type": unit_type, "icon": expected["icon"], "playerRuntimeId": 0,
            "face": expected["face"], "atlasTile": expected["tile"],
            "sourceRect": [x0, y0, ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT],
            "nonColorkeyPixels": len(opaque_points), "localMaskBoxXYXY": box,
            "healthBarOverlapPixels": health_intersection,
            "tileIndexSha256": sha256(b"".join(
                pixels[(y0 + row) * width + x0:(y0 + row) * width + x0 + ATLAS_TILE_WIDTH]
                for row in range(ATLAS_TILE_HEIGHT)
            )),
        })
    return {
        "status": "native-atlas-and-clean-target-masks-verified",
        "independentAuditSha256": ATLAS_AUDIT_SHA256,
        "stockUnitSetSha256": ASSET_HASHES["default.units"],
        "decompressedBytes": len(payload), "atlasHeaderOffset": ATLAS_HEADER_OFFSET,
        "rasterOffset": raster_offset, "rasterSha256": sha256(pixels),
        "width": width, "height": height, "bitsPerPixel": bpp,
        "paletteEntries": palette_count, "colorKey": {"index": 0, "rgb": list(key_rgb)},
        "tileSize": [ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT],
        "healthBarRectHalfOpen": list(HEALTH_BAR_RECT), "sprites": rows,
        "screenVisibilityProven": False,
    }


def audit_native_palette_display() -> dict[str, Any]:
    """Verify the exact stock SDL 16-bit DisplayFormat to XCB RGB lookup."""
    mapping_bytes = read_pinned(NATIVE_PALETTE_MAP, NATIVE_PALETTE_MAP_SHA256, 64 * 1024)
    try:
        mapping = json.loads(mapping_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OracleError("pinned native SDL palette map is not valid JSON") from error
    if mapping.get("schema") != "crimson-native-sdl16-xcb-palette-map-v1":
        raise OracleError("native display palette map has an unsupported schema")
    pins = mapping.get("sourcePins", {})
    if pins.get("stockUnitSetSha256") != ASSET_HASHES["default.units"]:
        raise OracleError("native display palette map refers to different stock unit bytes")
    if sha256(read_pinned(ARTIFACT / "packages/libsdl1.2debian_1.2.68-2_amd64.deb",
                          RUNTIME_PACKAGE_HASHES["libsdl1.2debian_1.2.68-2_amd64.deb"],
                          MAX_PACKAGE_BYTES)) != RUNTIME_PACKAGE_HASHES["libsdl1.2debian_1.2.68-2_amd64.deb"]:
        raise OracleError("native SDL palette map runtime package is not the pinned SDL 1.2 build")
    library = read_pinned(EXTRACTED / "usr/lib/x86_64-linux-gnu/libSDL-1.2.so.1.2.68",
                          pins.get("sdlLibrarySha256", ""), MAX_EXTRACTED_BYTES)
    fixture_source = Path(__file__).with_name("native_sdl_palette_fixture.c").read_bytes()
    fixture_binary = read_pinned(ARTIFACT / "native-color-diagnostic-v3/native_sdl_palette_fixture",
                                 pins.get("fixtureBinarySha256", ""), 2 * 1024 * 1024)
    if (sha256(library) != pins.get("sdlLibrarySha256")
            or sha256(fixture_source) != pins.get("fixtureSourceSha256")
            or not fixture_binary):
        raise OracleError("native SDL palette fixture source or executable differs from the audited run")

    display_source_root = ARTIFACT / "main-display-source-diagnosis-v1"
    display_source = {
        name: read_pinned(display_source_root / name, digest, MAX_SOURCE_BYTES)
        for name, digest in DISPLAY_SOURCE_PINS.items()
    }
    stock_main = read_pinned(SOURCE / "src/cf/main.cpp", SOURCE_HASHES["src/cf/main.cpp"])
    try:
        globals_text = display_source["src-common-globals.h"].decode("utf-8")
        view_text = display_source["src-common-view.cpp"].decode("utf-8")
        color_text = display_source["src-common-color.h"].decode("utf-8")
        main_text = stock_main.decode("utf-8")
    except UnicodeDecodeError as error:
        raise OracleError("pinned native display sources are not UTF-8") from error
    if (not re.search(r"(?m)^#define\s+DISPLAY_BPP\s+16\b", globals_text)
            or "SDL_SetVideoMode( w, h, bpp, flags )" not in view_text
            or not re.search(r"(?m)^#define\s+CF_COLOR_BLACK\s+0x00,0x00,0x00\s*$", color_text)
            or "--bpp" in main_text):
        raise OracleError("native stock display depth, black color constant, or supported CLI options changed")
    mapview_source = read_pinned(SOURCE / "src/common/mapview.cpp", SOURCE_HASHES["src/common/mapview.cpp"])
    mapview_text = mapview_source.decode("utf-8")
    health_draw = mapview_text.split("void MapView::DrawUnitHealth", 1)
    if (len(health_draw) != 2 or "dest->FillRect( outer, Color(CF_COLOR_BLACK) );" not in health_draw[1]
            or "dest->FillRect( inner, hcol );" not in health_draw[1]):
        raise OracleError("native health-bar outer black border or inner color draw differs from pinned MapView")

    renderer = mapping.get("rendererFormat", {})
    if (renderer.get("sourceFormat") != "stock indexed 8bpp with stock palette and colorkey index0"
            or renderer.get("conversion") != "SDL_DisplayFormat to SDL_SetVideoMode(16)"
            or renderer.get("nativeAndScreenBitsPerPixel") != 16
            or renderer.get("nativeAndScreenMasks") != {"red": 63488, "green": 2016, "blue": 31}
            or renderer.get("xvfbRoot") != "800x600x24"):
        raise OracleError("native palette fixture did not use the pinned 16-bit RGB565 SDL path")
    validation = mapping.get("validation", {})
    runs = validation.get("runs", [])
    if (validation.get("independentProcesses") != 2
            or validation.get("paletteSamplesPerRun") != 126
            or validation.get("fullCaptureDimensions") != [800, 600]
            or validation.get("directSampleCoordinates") != "(palette index, 6)"
            or validation.get("exactAcrossTwoRuns") is not True
            or validation.get("rawPixelTolerance") != 0
            or validation.get("colorkeyIndices") != [0]
            or validation.get("nonKeyColorsDistinctFromColorkey") is not True
            or len(runs) != 2):
        raise OracleError("native SDL palette map lacks two exact full-frame XCB confirmations")

    source_bytes = read_pinned(DATA / "default.units", ASSET_HASHES["default.units"], MAX_EXTRACTED_BYTES)
    payload = gzip.decompress(source_bytes)
    width, height, bpp, flags, palette_count = struct.unpack_from("<HHBBH", payload, ATLAS_HEADER_OFFSET)
    key_offset = ATLAS_HEADER_OFFSET + 8
    palette_offset = key_offset + (3 if flags & 1 else 0)
    source_palette = [list(payload[index:index + 3])
                      for index in range(palette_offset, palette_offset + palette_count * 3, 3)]
    raster_offset = palette_offset + palette_count * 3
    entries = mapping.get("palette", [])
    if (width != 768 or height != 336 or bpp != 8 or flags != 1 or palette_count != 126
            or len(entries) != 126):
        raise OracleError("native display map does not cover the complete stock unit palette")
    for index, entry in enumerate(entries):
        if (entry.get("atlasIndex") != index or entry.get("stockRGB") != source_palette[index]
                or not isinstance(entry.get("nativePixel565"), int)
                or len(entry.get("nativeSDLDisplayRgb", [])) != 3 or len(entry.get("xcbRgb", [])) != 3
                or entry.get("transparentColorkey") != (index == 0)):
            raise OracleError("native display palette entry differs from its pinned stock index")
    key_pixel = entries[0]["nativePixel565"]
    if any(entry["nativePixel565"] == key_pixel for entry in entries[1:]):
        raise OracleError("a non-key stock palette entry collapses to the converted SDL colorkey")
    if [entry.get("type") for entry in mapping.get("targetSpriteChecks", [])] != [
        "Artillery", "Troop Train", "Anti-Aircraft Guns",
    ]:
        raise OracleError("native palette witness lacks all three registered positive sprite checks")
    for target in mapping["targetSpriteChecks"]:
        if target.get("hasConvertedColorkeyCollision") is not False:
            raise OracleError("registered target sprite has an opaque palette pixel equal to the SDL colorkey")
    atlas_targets = {row["type"]: row for row in audit_native_unit_atlas()["sprites"]}
    for target in mapping["targetSpriteChecks"]:
        sprite = atlas_targets.get(target["type"])
        if sprite is None or sprite["sourceRect"] != target.get("sourceRect"):
            raise OracleError("native palette proof is bound to a different registered sprite tile")
        source_x, source_y, tile_width, tile_height = sprite["sourceRect"]
        actual_indices = {
            payload[raster_offset + (source_y + local_y) * width + source_x + local_x]
            for local_y in range(tile_height) for local_x in range(tile_width)
            if payload[raster_offset + (source_y + local_y) * width + source_x + local_x] != 0
        }
        opaque_count = sum(
            payload[raster_offset + (source_y + local_y) * width + source_x + local_x] != 0
            for local_y in range(tile_height) for local_x in range(tile_width)
        )
        if (opaque_count != target.get("opaquePixelCount")
                or sorted(actual_indices) != target.get("uniqueNonKeyPaletteIndices")
                or any(entries[index]["nativePixel565"] == key_pixel for index in actual_indices)):
            raise OracleError("registered native sprite pixel indices do not match the complete colorkey audit")

    palette_rgb = [entry["xcbRgb"] for entry in entries]
    for label, run in zip(("a", "b"), runs, strict=True):
        run_receipt_bytes = read_pinned(ARTIFACT / f"native-color-diagnostic-v3/run-{label}.json",
                                        sha256((ARTIFACT / f"native-color-diagnostic-v3/run-{label}.json").read_bytes()),
                                        64 * 1024)
        run_receipt = json.loads(run_receipt_bytes)
        frame = read_pinned(ARTIFACT / f"native-color-diagnostic-v3/stock-palette-xcb-{label}.png",
                            run["pngSha256"], 4 * 1024 * 1024)
        run_entries = run_receipt.get("paletteEntries", [])
        if (run_receipt.get("xcbPaletteRGB") != palette_rgb
                or len(run_entries) != 126
                or run_receipt.get("imageDimensions") != [800, 600]
                or run_receipt.get("pixelsRead") is not True
                or not frame):
            raise OracleError("native display palette receipt does not reproduce the pinned full-frame samples")
        if any(
            sample.get("inputRGB") != entries[index]["stockRGB"]
            or sample.get("nativePixel") != entries[index]["nativePixel565"]
            or sample.get("nativeRGB") != entries[index]["nativeSDLDisplayRgb"]
            or sample.get("colorkeyCollision") != (index == 0)
            for index, sample in enumerate(run_entries)
        ):
            raise OracleError("independent SDL palette process differs from the pinned source-index mapping")

    return {
        "status": "native-sdl16-palette-xcb-map-verified",
        "mapSha256": NATIVE_PALETTE_MAP_SHA256,
        "stockUnitSetSha256": ASSET_HASHES["default.units"],
        "paletteEntries": entries, "paletteXcbRgb": palette_rgb,
        "healthBarOuterBorderRgb": [0, 0, 0],
        "healthBarColorSourceSha256": DISPLAY_SOURCE_PINS["src-common-color.h"],
        "healthBarDrawSourceSha256": SOURCE_HASHES["src/common/mapview.cpp"],
        "sdlPackageSha256": RUNTIME_PACKAGE_HASHES["libsdl1.2debian_1.2.68-2_amd64.deb"],
        "fixtureBinarySha256": pins["fixtureBinarySha256"],
        "independentRuns": 2, "pixelTolerance": 0,
        "paletteSourceBytes": 126, "colorkeyIndex": 0,
    }


def audit_native_key_input() -> dict[str, Any]:
    """Verify that the fixed X11 key action reaches the native SDL scroll branch."""
    witness_bytes = read_pinned(NATIVE_INPUT_WITNESS, NATIVE_INPUT_WITNESS_SHA256, 32 * 1024)
    try:
        witness = json.loads(witness_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OracleError("pinned native SDL key witness is not valid JSON") from error
    if witness.get("schema") != "crimson-native-sdl-x11-input-witness-v2":
        raise OracleError("native SDL key witness has an unsupported schema")
    source = Path(__file__).with_name("native_sdl_input_fixture.c").read_bytes()
    if sha256(source) != witness.get("fixtureSourceSha256"):
        raise OracleError("native SDL key witness fixture source differs from its pinned version")
    read_pinned(ARTIFACT / "input-diagnostic-v3/native_sdl_input_fixture",
                witness.get("fixtureBinarySha256", ""), 2 * 1024 * 1024)
    library = read_pinned(EXTRACTED / "usr/lib/x86_64-linux-gnu/libSDL-1.2.so.1.2.68",
                          witness.get("sdlLibrarySha256", ""), MAX_EXTRACTED_BYTES)
    if sha256(library) != witness.get("sdlLibrarySha256") or witness.get("pixelsRead") is not False:
        raise OracleError("native SDL key witness runtime pin or pixel-isolation flag differs")
    runs = {row.get("case"): row for row in witness.get("runs", [])}
    if set(runs) != {"fixed-v11", "legacy-kp2-clearmodifiers"}:
        raise OracleError("native SDL key witness does not separate the fixed input from the rejected keypad input")
    fixed = runs["fixed-v11"]
    legacy = runs["legacy-kp2-clearmodifiers"]
    fixed_keys = [(event.get("symbol"), event.get("mod")) for event in fixed.get("events", [])]
    legacy_keys = [(event.get("symbol"), event.get("mod")) for event in legacy.get("events", [])]
    if (fixed.get("exitStatus") != 0 or legacy.get("exitStatus") != 0
            or fixed.get("pixelsRead") is not False or legacy.get("pixelsRead") is not False
            or fixed_keys != [(13, 0), (13, 0), (258, 0)]
            or legacy_keys != [(13, 0), (13, 0), (300, 4096), (258, 4096)]
            or fixed.get("controller", [])[-1].get("argv") != ["/usr/bin/xdotool", "key", "KP_Down"]
            or legacy.get("controller", [])[-1].get("argv") != [
                "/usr/bin/xdotool", "key", "--clearmodifiers", "KP_2",
            ]):
        raise OracleError("native SDL key symbols or modifier bits differ from the reviewed scroll input")
    return {
        "status": "fixed-key-input-reaches-native-scroll-branch",
        "witnessSha256": NATIVE_INPUT_WITNESS_SHA256,
        "fixtureBinarySha256": witness["fixtureBinarySha256"],
        "legacyKp2Disposition": "SDLK_KP2 with KMOD_NUM; MoveCommand",
        "fixedKpDownDisposition": "SDLK_KP2 without KMOD_NUM; ScrollCommand",
        "fixedKeyEvents": fixed_keys, "pixelsRead": False,
    }


def project_hex_to_view(
    hex_position: list[int] | tuple[int, int], camera: tuple[int, int],
    viewport: tuple[int, int, int, int],
) -> tuple[int, int]:
    """Apply the pinned MapView::Hex2Pixel integer projection without image fitting."""
    hx, hy = hex_position
    curx, cury = camera
    viewport_x, viewport_y, _width, _height = viewport
    if hx < 0 or hy < 0 or curx < 0 or cury < 0:
        raise OracleError("hex coordinates and camera offsets must be nonnegative")
    return (
        hx * (ATLAS_TILE_WIDTH - 9) - curx + viewport_x,
        hy * ATLAS_TILE_HEIGHT + (hx & 1) * 14 - cury + viewport_y,
    )


def derive_capture_camera(
    level_source: bytes, units: list[dict[str, Any]], viewport: tuple[int, int, int, int] = (0, 0, 800, 600),
    scroll_south_once: bool = False,
) -> dict[str, Any]:
    """Simulate native turn-start centering and one predeclared keypad-scroll action."""
    try:
        text = level_source.decode("utf-8")
    except UnicodeDecodeError as error:
        raise OracleError("level source is not UTF-8") from error
    mission_block = text.split("[mission]", 1)[1].split("[", 1)[0]
    fields = dict(re.findall(r"(?m)^\s*(mapwidth|mapheight)\s*=\s*(\d+)\s*$", mission_block))
    if set(fields) != {"mapwidth", "mapheight"}:
        raise OracleError("pinned level lacks exact native map dimensions")
    map_width, map_height = int(fields["mapwidth"]), int(fields["mapheight"])
    vx, vy, vw, vh = viewport
    if (vx, vy) != (0, 0) or (vw, vh) != (800, 600):
        raise OracleError("camera simulation requires the fixed source-pinned 800x600 view")
    start_units = [unit for unit in units if unit["player"] == 1]
    if not start_units:
        raise OracleError("native turn start has no current-player unit for cursor initialization")
    start_hex = tuple(start_units[0]["hex"])
    max_x = max(0, map_width * (ATLAS_TILE_WIDTH - 9) + 9 - vw)
    max_y = max(0, map_height * ATLAS_TILE_HEIGHT + 14 - vh)
    start_px = start_hex[0] * (ATLAS_TILE_WIDTH - 9)
    start_py = start_hex[1] * ATLAS_TILE_HEIGHT + (start_hex[0] & 1) * 14
    curx = max(0, min(max_x, start_px + (ATLAS_TILE_WIDTH - vw) // 2))
    cury = max(0, min(max_y, start_py + (ATLAS_TILE_HEIGHT - vh) // 2))
    action: dict[str, Any] | None = None
    if scroll_south_once:
        shift_hexes = (vh * 3 // 4) // ATLAS_TILE_HEIGHT
        cursor_hex = (start_hex[0], min(map_height - 1, start_hex[1] + shift_hexes))
        cursor_px_y = cursor_hex[1] * ATLAS_TILE_HEIGHT + (cursor_hex[0] & 1) * 14 - cury
        if cury > 0 and cursor_px_y <= vy + ATLAS_TILE_HEIGHT:
            scroll_y = -(vh // 2)
        elif cury < max_y and vh + vy - cursor_px_y - ATLAS_TILE_HEIGHT <= ATLAS_TILE_HEIGHT:
            scroll_y = vh // 2
        else:
            scroll_y = 0
        old_cury = cury
        cury = max(0, min(max_y, cury + scroll_y))
        action = {
            "input": "KP_Down mapped to SDL_KP2 with NumLock clear",
            "nativeAction": "Game::ScrollCommand south then Game::SetCursor",
            "cursorHexBefore": list(start_hex), "cursorHexAfter": list(cursor_hex),
            "scrollPixelsRequested": scroll_y, "cameraYBefore": old_cury, "cameraYAfter": cury,
            "cursorIsPositiveTarget": False,
        }
    return {
        "mapSizeHex": [map_width, map_height], "firstPlayerUnitHex": list(start_hex),
        "cameraAfterNativeTurnStart": [curx, max(0, min(max_y, start_py + (ATLAS_TILE_HEIGHT - vh) // 2))],
        "cameraForCapture": [curx, cury], "maxCameraOffset": [max_x, max_y],
        "preCaptureScroll": action,
        "basis": "Game::StartTurn first-owner unit, MapView::CenterOnHex, MapView::CheckScroll, Game::ScrollCommand",
    }


def target_draw_expectation(item: dict[str, Any], camera: tuple[int, int] = (0, 0)) -> dict[str, Any]:
    """Return source-derived atlas and projected screen rectangles; this is not a pixel verdict."""
    expected = UNIT_ATLAS.get(item.get("type", ""))
    if expected is None or item.get("label") != "positive":
        raise OracleError("native sprite projection is defined only for the three positive roster targets")
    viewport = (0, 0, 800, 600)
    dst_x, dst_y = project_hex_to_view(item["hex"], camera, viewport)
    src_x = (expected["tile"] % (768 // ATLAS_TILE_WIDTH)) * ATLAS_TILE_WIDTH
    src_y = (expected["tile"] // (768 // ATLAS_TILE_WIDTH)) * ATLAS_TILE_HEIGHT
    left, top, right, bottom = expected["box"]
    visible_box = [dst_x + left, dst_y + top, dst_x + right, dst_y + bottom]
    view_left, view_top, view_width, view_height = viewport
    fully_inside = (
        visible_box[0] >= view_left and visible_box[1] >= view_top
        and visible_box[2] <= view_left + view_width and visible_box[3] <= view_top + view_height
    )
    return {
        "status": "source-projected-target-draw-coordinate",
        "caseId": item["caseId"], "hex": list(item["hex"]), "cameraOffset": list(camera),
        "viewportXYWH": list(viewport), "viewportBasis": "Game::InitWindows creates MapWindow(0,0,view width,height)",
        "sourceRect": [src_x, src_y, ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT],
        "tileTopLeftXY": [dst_x, dst_y], "opaqueSpriteBoxXYXY": visible_box,
        "opaqueMaskFullyInsideViewport": fully_inside,
        "nativeBlitObserved": False, "framePixelsRead": False,
    }


def verify_native_blit_trace(
    trace_bytes: bytes, item: dict[str, Any], expected_draw: dict[str, Any] | None = None,
    expected_anchor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Check bounded SDL_LowerBlit records against the pinned map and sprite source geometry."""
    if len(trace_bytes) > MAX_TRACE_FILE_BYTES:
        raise OracleError("native SDL blit trace exceeds the fixed 2 MiB cap")
    try:
        rows = [json.loads(line) for line in trace_bytes.decode("utf-8").splitlines() if line]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OracleError("native SDL blit trace contains invalid UTF-8 or JSON") from error
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict) or not all(key in row for key in (
            "sourceWidth", "sourceHeight", "sourceFlags", "sourceRect", "destinationRect",
            "destinationWidth", "destinationHeight", "result",
        )):
            raise OracleError("native SDL blit trace row lacks required dimensions or rectangles")
        if len(row["sourceRect"]) != 4 or len(row["destinationRect"]) != 4:
            raise OracleError("native SDL blit trace has malformed source or destination rectangle")
        if row["destinationWidth"] != 800 or row["destinationHeight"] != 600:
            continue
        if row["result"] != 0:
            raise OracleError("a blit to the pinned native view surface failed")
        normalized.append(row)
    map_tile_rows = [
        row for row in normalized
        if row["sourceRect"][2:] == [ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT]
        and row["destinationRect"][2:] == [ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT]
    ]
    unique_destinations = {tuple(row["destinationRect"][:2]) for row in map_tile_rows}
    if len(map_tile_rows) < 30 or len(unique_destinations) < 20:
        raise OracleError("native viewport trace does not show a populated map draw stage")
    result: dict[str, Any] = {
        "status": "native-map-draw-stage-observed",
        "traceRows": len(rows), "viewportBlits": len(normalized),
        "fullNativeTileBlits": len(map_tile_rows), "uniqueTileDestinations": len(unique_destinations),
        "sourceGeometryBasis": "TileSet::DrawTile uses 32x28 tile sources and Surface::LowerBlit",
        "pixelsRead": False,
    }
    if item["label"] == "negative":
        if expected_anchor is None:
            raise OracleError("negative native map verification requires its predeclared visible source anchor")
        anchor_x, anchor_y = expected_anchor["tileTopLeftXY"]
        source_rect = expected_anchor.get("sourceRect")
        if source_rect not in ([64, 0, 32, 28], [160, 0, 32, 28]):
            raise OracleError("negative source anchor lacks the exact player-1 Medium Tanks face tile")
        expected_dx = anchor_x - source_rect[0]
        expected_dy = anchor_y - source_rect[1]
        anchor_blits = [
            (trace_index, row) for trace_index, row in enumerate(normalized)
            if row["sourceWidth"] == 768 and row["sourceHeight"] == 336
            and row["sourceFlags"] & 0x1000
            and row["destinationRect"][0] - row["sourceRect"][0] == expected_dx
            and row["destinationRect"][1] - row["sourceRect"][1] == expected_dy
            and row["destinationRect"][2] > 0 and row["destinationRect"][3] > 0
        ]
        if not anchor_blits:
            raise OracleError("native unit draw was not observed at the predeclared negative-map anchor")
        final_anchor_index, final_anchor = anchor_blits[-1]
        if (final_anchor["sourceRect"] != source_rect
                or final_anchor["destinationRect"] != [anchor_x, anchor_y, ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT]):
            raise OracleError("the final negative-map anchor draw is clipped at the capture barrier")
        result["status"] = "native-negative-map-anchor-and-draw-stage-observed"
        result["targetSpriteBlitMatched"] = None
        result["nativeAnchorBlitObserved"] = True
        result["anchorName"] = expected_anchor["name"]
        result["anchorTileTopLeft"] = [anchor_x, anchor_y]
        result["finalAnchorTraceRowIndex"] = final_anchor_index
        return result
    if expected_draw is None:
        raise OracleError("positive native draw verification requires the precomputed source projection")
    source_rect = expected_draw["sourceRect"]
    tile_x, tile_y = expected_draw["tileTopLeftXY"]
    expected_dx = tile_x - source_rect[0]
    expected_dy = tile_y - source_rect[1]
    target_fragments = [
        (trace_index, row) for trace_index, row in enumerate(normalized)
        if row["sourceWidth"] == 768 and row["sourceHeight"] == 336
        and row["sourceFlags"] & 0x1000
        and row["destinationRect"][0] - row["sourceRect"][0] == expected_dx
        and row["destinationRect"][1] - row["sourceRect"][1] == expected_dy
        and row["sourceRect"][2] > 0 and row["sourceRect"][3] > 0
        and row["destinationRect"][2] > 0 and row["destinationRect"][3] > 0
    ]
    if not target_fragments:
        raise OracleError("native target sprite source-to-destination transform was not observed")
    final_trace_index, final_target_fragment = target_fragments[-1]
    if (final_target_fragment["sourceRect"] != source_rect
            or final_target_fragment["destinationRect"] != [tile_x, tile_y, ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT]):
        raise OracleError("the final native target draw is clipped or incomplete at the capture barrier")
    result.update({
        "status": "native-target-sprite-final-complete-source-and-destination-observed",
        "targetSpriteBlitMatched": True, "matchingTargetBlits": len(target_fragments),
        "sourceRect": source_rect, "destinationRect": [tile_x, tile_y, ATLAS_TILE_WIDTH, ATLAS_TILE_HEIGHT],
        "sourceColorkeyFlagObserved": True, "finalTargetTraceRowIndex": final_trace_index,
        "finalTargetDrawComplete": True,
    })
    return result


def verify_blit_trace_status(status_bytes: bytes) -> dict[str, Any]:
    if len(status_bytes) > MAX_MILESTONE_BYTES:
        raise OracleError("native SDL trace status exceeds its fixed byte cap")
    try:
        events = [json.loads(line) for line in status_bytes.decode("utf-8").splitlines() if line]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OracleError("native SDL trace status contains invalid UTF-8 or JSON") from error
    names = [event.get("event") for event in events if isinstance(event, dict)]
    if names != ["trace-start", "capture-barrier"]:
        raise OracleError("native SDL trace lacks one complete post-capture barrier")
    if events[-1].get("complete") is not True:
        raise OracleError("native SDL trace marked overflow or I/O failure before capture barrier")
    return {"status": "native-trace-complete-through-capture-barrier", "events": names}


def request_native_trace_barrier(native_pid: int, status_path: Path) -> dict[str, Any]:
    """Fence the completed UI action sequence before the one screenshot readback."""
    if native_pid <= 0:
        raise OracleError("native trace barrier requires a positive owned PID")
    try:
        actual = Path(f"/proc/{native_pid}/exe").stat()
        expected = CLIENT.stat()
    except OSError as error:
        raise OracleError("native client process disappeared before the trace barrier") from error
    if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
        raise OracleError("trace barrier PID is not the pinned Crimson ELF")
    if status_path.is_symlink() or not status_path.is_file() or status_path.stat().st_size > MAX_MILESTONE_BYTES:
        raise OracleError("native trace status sidecar is missing, linked or oversized")
    initial = status_path.read_bytes()
    try:
        initial_events = [json.loads(line) for line in initial.decode("utf-8").splitlines() if line]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OracleError("native trace start sidecar is invalid") from error
    if initial_events != [{"event": "trace-start", "schema": 1}]:
        raise OracleError("native trace barrier cannot be requested from a stale or already closed status sidecar")
    try:
        os.kill(native_pid, signal.SIGUSR1)
    except ProcessLookupError as error:
        raise OracleError("native client exited before the trace barrier") from error
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        payload = status_path.read_bytes()
        if b'"event":"capture-barrier"' in payload:
            return verify_blit_trace_status(payload)
        time.sleep(0.05)
    raise OracleError("native SDL tracer did not acknowledge the post-capture barrier")


def capture_native_window_png(
    display: str, window_rect: tuple[int, int, int, int], output_path: Path,
    native_pid: int, window_owner_pid: int,
) -> dict[str, Any]:
    """Capture one verified native X11 client window; callers must first receive parent release."""
    if native_pid <= 0 or window_owner_pid != native_pid:
        raise OracleError("mapped window is not proven to belong to the pinned native PID")
    if not display.startswith(":") or not display[1:].isdecimal():
        raise OracleError("capture requires the dynamically allocated private Xvfb display")
    x, y, width, height = window_rect
    if (x, y, width, height) != (0, 0, 800, 600):
        raise OracleError("native window geometry differs from the pinned 800x600 viewport")
    try:
        output_path.resolve(strict=False).relative_to(ARTIFACT.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise OracleError("capture output must stay beneath the external artifact root") from error
    if output_path.exists() or output_path.is_symlink():
        raise OracleError("capture output already exists or is a symlink")
    try:
        from PIL import ImageGrab
        image = ImageGrab.grab(bbox=(x, y, x + width, y + height), xdisplay=display)
    except Exception as error:
        raise OracleError(f"native XCB window capture failed: {type(error).__name__}: {error}") from error
    if image.size != (width, height) or image.mode != "RGB":
        raise OracleError("native screenshot is not an exact 800x600 RGB window readback")
    output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(
        output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600,
    )
    with os.fdopen(descriptor, "wb") as output:
        image.save(output, format="PNG", optimize=False)
        output.flush()
        os.fsync(output.fileno())
    return {
        "status": "one-native-window-png-captured", "sha256": sha256(output_path.read_bytes()),
        "bytes": output_path.stat().st_size, "dimensions": [width, height], "mode": image.mode,
        "windowOwnerPid": window_owner_pid, "nativePid": native_pid, "display": display,
    }


def _verify_native_frame_sprite_pixels(
    frame_png: bytes, case_id: str, source_rect: list[int], destination_tile: list[int], expected_count: int,
    status: str, expected_rgb_overrides: dict[tuple[int, int], tuple[int, int, int]] | None = None,
) -> dict[str, Any]:
    """Compare every opaque native atlas pixel with its exact SDL16/XCB palette output."""
    if len(frame_png) > 4 * 1024 * 1024:
        raise OracleError("native screenshot exceeds the fixed 4 MiB image cap")
    try:
        from PIL import Image
        with Image.open(io.BytesIO(frame_png)) as image:
            if image.format != "PNG" or image.mode != "RGB" or image.size != (800, 600):
                raise OracleError("native frame must remain an unmodified 800x600 RGB PNG")
            image.load()
            frame = image.copy()
    except OracleError:
        raise
    except Exception as error:
        raise OracleError(f"native frame PNG cannot be decoded: {type(error).__name__}: {error}") from error
    atlas = audit_native_unit_atlas()
    if atlas["status"] != "native-atlas-and-clean-target-masks-verified":
        raise OracleError("pinned native atlas verification did not pass")
    display = audit_native_palette_display()
    if display["status"] != "native-sdl16-palette-xcb-map-verified":
        raise OracleError("pinned native SDL display palette conversion did not pass")
    source = read_pinned(DATA / "default.units", ASSET_HASHES["default.units"], MAX_EXTRACTED_BYTES)
    payload = gzip.decompress(source)
    width, height, _bpp, flags, palette_count = struct.unpack_from("<HHBBH", payload, ATLAS_HEADER_OFFSET)
    key_offset = ATLAS_HEADER_OFFSET + 8
    palette_offset = key_offset + (3 if flags & 1 else 0)
    raster_offset = palette_offset + palette_count * 3
    raster = payload[raster_offset:raster_offset + width * height]
    source_x, source_y, tile_width, tile_height = source_rect
    destination_x, destination_y = destination_tile
    rgb_overrides = expected_rgb_overrides or {}
    if any(not (0 <= point[0] < tile_width and 0 <= point[1] < tile_height)
           for point in rgb_overrides):
        raise OracleError("native sprite color override is outside the pinned source tile")
    mismatches: list[list[int]] = []
    compared = 0
    for local_y in range(tile_height):
        for local_x in range(tile_width):
            atlas_index = raster[(source_y + local_y) * width + source_x + local_x]
            if atlas_index == 0:
                continue
            compared += 1
            expected_rgb = tuple(display["paletteXcbRgb"][atlas_index])
            expected_rgb = rgb_overrides.get((local_x, local_y), expected_rgb)
            observed_rgb = frame.getpixel((destination_x + local_x, destination_y + local_y))
            if observed_rgb != expected_rgb:
                mismatches.append([local_x, local_y])
    if compared != expected_count:
        raise OracleError("native frame comparison did not visit every opaque native-atlas source pixel")
    if mismatches:
        raise OracleError(f"native rendered RGB differs from exact SDL16/XCB palette output at {len(mismatches)} pixels")
    return {
        "status": "native-frame-matches-all-opaque-source-sprite-pixels",
        "caseId": case_id, "comparisonKind": status,
        "comparedOpaquePixels": compared, "mismatchCount": 0,
        "expectedRgbOverrides": [
            {"sourceLocalXY": list(point), "xcbRgb": list(color)}
            for point, color in sorted(rgb_overrides.items(), key=lambda entry: (entry[0][1], entry[0][0]))
        ],
        "sourceRect": source_rect, "destinationTileTopLeft": [destination_x, destination_y],
        "frameSha256": sha256(frame_png), "nativePaletteMapSha256": display["mapSha256"],
        "comparison": "exact-native-sdl16-to-xcb-palette-colors-zero-tolerance",
        "pixelsRead": True,
    }


def verify_native_frame_sprite(
    frame_png: bytes, item: dict[str, Any], expected_draw: dict[str, Any],
) -> dict[str, Any]:
    """Compare a positive target's complete opaque atlas mask at its source-projected destination."""
    atlas = audit_native_unit_atlas()
    sprite = next((row for row in atlas["sprites"] if row["type"] == item.get("type")), None)
    if sprite is None or item.get("label") != "positive":
        raise OracleError("native target sprite comparison is defined only for the three positive rows")
    if not expected_draw["opaqueMaskFullyInsideViewport"]:
        raise OracleError("source-projected target mask is clipped by the fixed viewport")
    return _verify_native_frame_sprite_pixels(
        frame_png, item["caseId"], sprite["sourceRect"], expected_draw["tileTopLeftXY"],
        sprite["nonColorkeyPixels"], "positive-target",
    )


def verify_native_frame_anchor(
    frame_png: bytes, item: dict[str, Any], expected_anchor: dict[str, Any],
) -> dict[str, Any]:
    """Compare a negative map's exact named native unit anchor at its source-projected position."""
    if item.get("label") != "negative" or expected_anchor.get("type") != "Medium Tanks":
        raise OracleError("negative native frame verification requires its predeclared Medium Tanks anchor")
    if expected_anchor.get("sourceRect") not in ([64, 0, 32, 28], [160, 0, 32, 28]):
        raise OracleError("negative native anchor source rectangle is not the registered owner/facing tile")
    source = read_pinned(DATA / "default.units", ASSET_HASHES["default.units"], MAX_EXTRACTED_BYTES)
    payload = gzip.decompress(source)
    width, height, _bpp, flags, palette_count = struct.unpack_from("<HHBBH", payload, ATLAS_HEADER_OFFSET)
    palette_offset = ATLAS_HEADER_OFFSET + 8 + (3 if flags & 1 else 0)
    raster_offset = palette_offset + palette_count * 3
    sx, sy, tile_width, tile_height = expected_anchor["sourceRect"]
    raster = payload[raster_offset:raster_offset + width * height]
    count = sum(
        raster[(sy + local_y) * width + sx + local_x] != 0
        for local_y in range(tile_height) for local_x in range(tile_width)
    )
    overlay_point = NEGATIVE_HEALTHBAR_OVERLAP[item["level"]]
    if count != 245:
        raise OracleError("pinned negative anchor opaque-pixel count differs from its healthbar overlap audit")
    actual_overlap = [
        [local_x, local_y]
        for local_y in range(HEALTH_BAR_RECT[1], min(HEALTH_BAR_RECT[3], tile_height))
        for local_x in range(HEALTH_BAR_RECT[0], min(HEALTH_BAR_RECT[2], tile_width))
        if raster[(sy + local_y) * width + sx + local_x] != 0
    ]
    expected_overlap = [overlay_point] if overlay_point is not None else []
    if actual_overlap != expected_overlap:
        raise OracleError("pinned negative anchor healthbar overlap coordinates differ from the registered audit")
    overrides = {tuple(overlay_point): (0, 0, 0)} if overlay_point is not None else {}
    result = _verify_native_frame_sprite_pixels(
        frame_png, item["caseId"], expected_anchor["sourceRect"], expected_anchor["tileTopLeftXY"],
        count, "negative-named-anchor", expected_rgb_overrides=overrides,
    )
    result["totalOpaqueSourcePixels"] = count
    result["healthbarOverlap"] = (
        {
            "sourceLocalXY": overlay_point,
            "screenXY": [expected_anchor["tileTopLeftXY"][0] + overlay_point[0],
                         expected_anchor["tileTopLeftXY"][1] + overlay_point[1]],
            "reason": "pinned MapView draws the black outer health-bar border over this pixel",
            "expectedXcbRgb": [0, 0, 0], "pixelCompared": True,
        }
        if overlay_point is not None else {"sourceLocalXY": None, "overlapPixelCount": 0}
    )
    return result


def native_unit_icon(unit_type: str) -> int:
    """Read one unit's pinned default.usrc icon without guessing atlas layout."""
    source = read_pinned(SOURCE / "tools/default.usrc", SOURCE_HASHES["tools/default.usrc"])
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as error:
        raise OracleError("pinned default.usrc is not UTF-8") from error
    records = re.split(r"(?m)(?=^name\(en\)\s*=)", text)
    for record in records:
        name = re.search(r"(?m)^name\(en\)\s*=\s*(.*?)\s*$", record)
        if name and name.group(1) == unit_type:
            icon = re.search(r"(?m)^icon\s*=\s*(\d+)\s*$", record)
            if icon is None:
                raise OracleError(f"pinned unit source has no icon index for {unit_type}")
            return int(icon.group(1), 10)
    raise OracleError(f"pinned unit source has no record for {unit_type}")


def native_unit_source_rect(icon: int, player: int, face: int) -> list[int]:
    if icon < 0 or player < 1 or face < 0 or face > 5:
        raise OracleError("native atlas icon, player or facing is outside its source range")
    atlas_tile = icon + (player - 1) * 6 + face
    tiles_per_row = 768 // ATLAS_TILE_WIDTH
    return [
        (atlas_tile % tiles_per_row) * ATLAS_TILE_WIDTH,
        (atlas_tile // tiles_per_row) * ATLAS_TILE_HEIGHT,
        ATLAS_TILE_WIDTH,
        ATLAS_TILE_HEIGHT,
    ]


def audit_roster() -> dict[str, Any]:
    registration_bytes = read_pinned(REGISTERED_MAP_ORDER, REGISTERED_MAP_ORDER_SHA256)
    registration = json.loads(registration_bytes)
    registered_crimson_rows = [row for row in registration.get("rows", []) if row.get("familySlug") == "crimson"]
    if [(row.get("predeclaredStateId"), row.get("opaqueCaseId")) for row in registered_crimson_rows] != [
        (row["stateId"], row["mapId"]) for row in ROSTER
    ]:
        raise OracleError("local Crimson roster does not match the parent-registered map order")
    package_paths = [PACKAGE, *(ARTIFACT / "packages" / name for name in RUNTIME_PACKAGE_HASHES)]
    package_total = sum(path.stat().st_size for path in package_paths if path.is_file() and not path.is_symlink())
    if len(package_paths) != len(RUNTIME_PACKAGE_HASHES) + 1 or package_total > MAX_PACKAGE_BYTES:
        raise OracleError("package exceeds the 40 MiB download cap")
    if sha256(read_pinned(PACKAGE, EXPECTED_PACKAGE_SHA256, MAX_PACKAGE_BYTES)) != EXPECTED_PACKAGE_SHA256:
        raise OracleError("package hash mismatch")
    runtime_packages: list[dict[str, Any]] = []
    for name, expected in RUNTIME_PACKAGE_HASHES.items():
        package_path = ARTIFACT / "packages" / name
        payload = read_pinned(package_path, expected, MAX_PACKAGE_BYTES)
        runtime_packages.append({"filename": name, "sha256": expected, "bytes": len(payload)})
    source_rows: dict[str, list[dict[str, Any]]] = {}
    source_buildings: dict[str, list[dict[str, Any]]] = {}
    source_events: dict[str, list[dict[str, str]]] = {}
    source_receipts: dict[str, str] = {}
    gamedefs_header = read_pinned(SOURCE / "src/common/gamedefs.h", SOURCE_HASHES["src/common/gamedefs.h"])
    for relative, expected in SOURCE_HASHES.items():
        payload = read_pinned(SOURCE / relative, expected)
        source_receipts[relative] = expected
        if relative.startswith("levels/") and relative.endswith(".src"):
            source_rows[Path(relative).stem] = parse_level_units(payload)
            source_buildings[Path(relative).stem] = parse_level_buildings(payload)
            source_events[Path(relative).stem] = parse_level_events(payload)
    for relative, expected in MAPVIEW_SOURCE_PINS.items():
        read_pinned(SOURCE / relative, expected)

    facing_manifest = read_pinned(FACING_VARIANTS / "manifest.json", FACING_MANIFEST_SHA256)
    facing_manifest_data = json.loads(facing_manifest)
    if [recipe.get("sourceScenario") for recipe in facing_manifest_data.get("recipes", [])] != [
        "Anthill", "BeachRaid", "ClippedWings",
    ]:
        raise OracleError("private facing recipe order or scenarios differ from the fixed roster")
    variant_receipts: dict[str, dict[str, Any]] = {}
    for item in ROSTER:
        recipe = FACING_RECIPE_PINS.get(item["level"])
        if recipe is None:
            continue
        manifest_recipe = next(
            (candidate for candidate in facing_manifest_data["recipes"] if candidate.get("sourceScenario") == item["level"]),
            None,
        )
        if manifest_recipe is None or manifest_recipe.get("stateId") != recipe["stateId"]:
            raise OracleError(f"private facing manifest state ID mismatch: {item['caseId']}")
        source_relative, source_hash = recipe["source"]
        level_relative, level_hash = recipe["level"]
        private_source = read_pinned(FACING_VARIANTS / source_relative, source_hash)
        private_level = read_pinned(FACING_VARIANTS / level_relative, level_hash)
        stock_source = read_pinned(SOURCE / f"levels/{item['level']}.src", SOURCE_HASHES[f"levels/{item['level']}.src"])
        stock_level = read_pinned(DATA / f"levels/{item['level']}.lev", ASSET_HASHES[f"levels/{item['level']}.lev"])
        target_position = f"pos = {item['hex'][0]}/{item['hex'][1]}\n".encode("ascii")
        if stock_source.count(target_position) != 1:
            raise OracleError(f"pinned source does not uniquely contain the target position: {item['caseId']}")
        expected_source = stock_source.replace(
            target_position,
            target_position + f"face = {recipe['privateFace']}\n".encode("ascii"),
            1,
        )
        if private_source != expected_source:
            raise OracleError(f"private source differs outside the one declared facing line: {item['caseId']}")
        stock_bytes = stock_level
        changed = [index for index, (before_byte, after_byte) in enumerate(zip(stock_bytes, private_level)) if before_byte != after_byte]
        offset = recipe["faceOffset"]
        if len(stock_bytes) != len(private_level) or changed != [offset]:
            raise OracleError(f"compiled private level differs outside the pinned face byte: {item['caseId']}")
        if (stock_bytes[offset], private_level[offset]) != (recipe["stockFace"], recipe["privateFace"]):
            raise OracleError(f"compiled private face byte has unexpected values: {item['caseId']}")
        if stock_bytes[MISSION_HANDICAP_BYTE_OFFSET] != HANDICAP_NONE_MASK or private_level[MISSION_HANDICAP_BYTE_OFFSET] != HANDICAP_NONE_MASK:
            raise OracleError(f"private scenario changed the compiled native handicap state: {item['caseId']}")
        base_units = source_rows[item["level"]]
        private_units = parse_level_units(private_source)
        expected_units = [dict(unit, **({"face": recipe["privateFace"]} if unit["unitId"] == item["unitId"] else {})) for unit in base_units]
        if private_units != expected_units:
            raise OracleError(f"private source changes level inventory beyond the declared facing: {item['caseId']}")
        variant_receipts[item["level"]] = {
            "stateId": recipe["stateId"], "sourceSha256": source_hash,
            "compiledSha256": level_hash, "stockCompiledSha256": ASSET_HASHES[f"levels/{item['level']}.lev"],
            "onlySourceLineChange": f"face = {recipe['privateFace']}", "compiledChangedOffsets": changed,
            "stockFaceByte": stock_bytes[offset], "privateFaceByte": private_level[offset],
            "completeUnitInventoryUnchanged": True,
        }

    if not EXTRACTED.is_dir() or EXTRACTED.is_symlink():
        raise OracleError("private package extraction is missing")
    extracted_size = sum(path.stat().st_size for path in EXTRACTED.rglob("*") if path.is_file() and not path.is_symlink())
    if extracted_size > MAX_EXTRACTED_BYTES:
        raise OracleError("private extraction exceeds the 200 MiB cap")
    asset_receipts: dict[str, str] = {}
    package_copyright = EXTRACTED / "usr/share/doc/crimson/copyright"
    copyright_hash = sha256(read_pinned(package_copyright, source_receipts["debian/copyright"]))
    for relative, expected in ASSET_HASHES.items():
        asset_receipts[relative] = sha256(read_pinned(DATA / relative, expected, MAX_EXTRACTED_BYTES))
    host_tools: dict[str, str] = {}
    for raw_path, expected in HOST_TOOL_HASHES.items():
        tool_path = Path(raw_path)
        host_tools[raw_path] = sha256(read_pinned(tool_path, expected, MAX_EXTRACTED_BYTES))
    binary_relative = "usr/games/crimson"
    if CLIENT.is_symlink() or not CLIENT.is_file() or CLIENT.stat().st_size > MAX_EXTRACTED_BYTES:
        raise OracleError("pinned client binary is missing or oversized")
    binary_data = CLIENT.read_bytes()

    rows: list[dict[str, Any]] = []
    for item in ROSTER:
        units = [dict(unit) for unit in source_rows[item["level"]]]
        if item["level"] in FACING_RECIPE_PINS:
            recipe = FACING_RECIPE_PINS[item["level"]]
            units = parse_level_units(read_pinned(FACING_VARIANTS / recipe["source"][0], recipe["source"][1]))
            private_variant = dict(variant_receipts[item["level"]])
            private_variant["completeUnitInventoryUnchanged"] = True
            variant_receipts[item["level"]] = private_variant
        buildings = source_buildings[item["level"]]
        source_target_placement = (
            verify_source_target_is_on_play_map(item, units, buildings)
            if item["label"] == "positive" else None
        )
        selected_level = (
            read_pinned(FACING_VARIANTS / FACING_RECIPE_PINS[item["level"]]["level"][0],
                        FACING_RECIPE_PINS[item["level"]]["level"][1])
            if item["level"] in FACING_RECIPE_PINS
            else read_pinned(DATA / f"levels/{item['level']}.lev", ASSET_HASHES[f"levels/{item['level']}.lev"])
        )
        handicap_mask = selected_level[MISSION_HANDICAP_BYTE_OFFSET]
        if handicap_mask != HANDICAP_NONE_MASK:
            raise OracleError(f"compiled mission does not encode the registered no-handicap state: {item['caseId']}")
        event_state = simulate_initial_unit_inventory(
            source_events[item["level"]], units, buildings, handicap_mask, item["level"],
        )
        event_state["compiledEventQueue"] = verify_compiled_event_order(
            selected_level, source_events[item["level"]], gamedefs_header,
        )
        units = event_state["completePostInitializationInventory"]
        event_state["sourceBuildingCount"] = len(buildings)
        event_state["sourceBuildingInventory"] = buildings
        event_state["handicapSourceByteOffset"] = MISSION_HANDICAP_BYTE_OFFSET
        event_state["missionHandicapByte"] = handicap_mask
        event_state["handicapFlagConstant"] = HANDICAP_NONE_MASK
        event_state["eventDisabledFlagConstant"] = EVENT_FLAG_DISABLED
        target_creation_events = [
            {
                "id": event["id"], "trigger": event["trigger"], "threshold": event.get("thandicap"),
                "type": event.get("unit"), "player": event.get("player"), "hex": event.get("pos"),
            }
            for event in source_events[item["level"]]
            if event["type"].lower() == "createunit" and event.get("unit") == item["type"]
        ]
        active_target_creations = [unit for unit in event_state["createdUnits"] if unit["type"] == item["type"]]
        if item["label"] == "positive":
            exact = [unit for unit in units if unit["type"] == item["type"] and unit["player"] == item["player"]]
            target = [unit for unit in exact if unit["unitId"] == item["unitId"] and unit["hex"] == item["hex"]]
            if len(target) != 1:
                raise OracleError(f"positive post-initialization target is not exact: {item['caseId']}")
            if item.get("selection") == "westernmost":
                westmost = min(exact, key=lambda unit: (unit["hex"][0], unit["hex"][1]))
                if len(exact) != 2 or westmost["unitId"] != item["unitId"]:
                    raise OracleError(f"westernmost target is not unique in the post-initialization inventory: {item['caseId']}")
                verdict = {"status": "source-target-exact-and-westmost-among-owner-type", "matchingTypeOwnerCount": len(exact)}
            else:
                if len(exact) != 1:
                    raise OracleError(f"positive target is not owner-unique after initialization: {item['caseId']}")
                verdict = {"status": "source-target-exact-and-owner-unique", "matchingTypeOwnerCount": len(exact)}
        else:
            target = [unit for unit in units if unit["type"] == item["type"]]
            if target:
                raise OracleError(f"negative target type exists after initialization: {item['caseId']}")
            verdict = {"status": "source-target-type-absent-after-initial-events", "worldTargetCount": 0}
        rows.append({
            **item,
            "sourceUnitCount": event_state["initialUnitCount"],
            "postInitializationUnitCount": len(units),
            "sourceInventory": units,
            "sourceInventorySha256": sha256(json.dumps(units, ensure_ascii=False, separators=(",", ":")).encode("utf-8")),
            "sourceTruth": verdict,
            "sourceTargetPlacement": source_target_placement,
            "targetCreationEvents": target_creation_events,
            "activeTargetCreationEventsAtDirectStart": active_target_creations,
            "initialTurnEventAudit": event_state,
            "directStartInventoryProven": event_state["inventoryProofComplete"],
            "metadataRunEligible": event_state["inventoryProofComplete"],
            "screenReadyForCapture": False,
            "privateFacingVariant": variant_receipts.get(item["level"]),
        })

    atlas_audit = audit_native_unit_atlas()
    palette_display_audit = audit_native_palette_display()
    key_input_audit = audit_native_key_input()
    projection_rows = []
    capture_plan_rows = []
    for item in ROSTER:
        selected_source = (
            read_pinned(FACING_VARIANTS / FACING_RECIPE_PINS[item["level"]]["source"][0],
                        FACING_RECIPE_PINS[item["level"]]["source"][1])
            if item["level"] in FACING_RECIPE_PINS
            else read_pinned(SOURCE / f"levels/{item['level']}.src", SOURCE_HASHES[f"levels/{item['level']}.src"])
        )
        camera_plan = derive_capture_camera(
            selected_source, rows[[case["caseId"] for case in ROSTER].index(item["caseId"])] ["sourceInventory"],
            scroll_south_once=(item["level"] == "Anthill"),
        )
        target_projection = None
        anchor = None
        if item["label"] == "positive":
            target_projection = target_draw_expectation(item, tuple(camera_plan["cameraForCapture"]))
            target_projection["cameraPlan"] = camera_plan
            projection_rows.append(target_projection)
            if camera_plan["firstPlayerUnitHex"] == item["hex"]:
                raise OracleError(f"turn-start cursor would remain on the positive target: {item['caseId']}")
            anchor = {
                "name": f"target {item['type']} id {item['unitId']} at {item['hex'][0]}/{item['hex'][1]}",
                "unitId": item["unitId"], "type": item["type"], "hex": item["hex"],
                "tileTopLeftXY": target_projection["tileTopLeftXY"],
            }
        else:
            case_truth = rows[[case["caseId"] for case in ROSTER].index(item["caseId"])]
            anchor_source = NEGATIVE_ANCHOR_UNITS[item["level"]]
            if native_unit_icon("Medium Tanks") != 0:
                raise OracleError("pinned default.usrc changed the registered Medium Tanks icon index")
            if anchor_source["face"] != NEGATIVE_ANCHOR_FACES[item["level"]]:
                raise OracleError("negative anchor source facing differs from the predeclared native face")
            candidate_units = [
                unit for unit in case_truth["sourceInventory"]
                if unit["player"] == 1 and unit["type"] == "Medium Tanks"
                and unit["unitId"] == anchor_source["unitId"]
                and unit["hex"] == anchor_source["hex"]
                and unit.get("face") == anchor_source["face"]
            ]
            if len(candidate_units) != 1:
                raise OracleError(f"negative named source anchor differs from its pinned native unit: {item['caseId']}")
            for candidate in candidate_units:
                anchor_x, anchor_y = project_hex_to_view(candidate["hex"], tuple(camera_plan["cameraForCapture"]), (0, 0, 800, 600))
                if anchor_x < 0 or anchor_y < 0 or anchor_x + ATLAS_TILE_WIDTH > 800 or anchor_y + ATLAS_TILE_HEIGHT > 600:
                    continue
                anchor = {
                    "name": f"player 1 {candidate['type']} id {candidate['unitId']} at {candidate['hex'][0]}/{candidate['hex'][1]}",
                    "unitId": candidate["unitId"], "type": candidate["type"], "hex": candidate["hex"],
                    "face": candidate.get("face"), "sourceRect": native_unit_source_rect(
                        native_unit_icon(candidate["type"]), candidate["player"], candidate["face"],
                    ), "tileTopLeftXY": [anchor_x, anchor_y],
                }
                break
            if anchor is None:
                raise OracleError(f"no complete visible native unit anchor exists for negative map: {item['caseId']}")
        capture_plan_rows.append({
            "caseId": item["caseId"], "opaqueMapId": item["mapId"],
            "stateId": item["stateId"], "query": item["query"], "labelForPrivateAuditOnly": item["label"],
            "worldInventoryTruth": rows[[case["caseId"] for case in ROSTER].index(item["caseId"])] ["sourceTruth"],
            "cameraPlan": camera_plan, "targetProjection": target_projection, "nativeAnchor": anchor,
            "fixedActions": ["Return", "Return", *( ["KP_Down mapped to SDL_KP2 with NumLock clear"] if item["level"] == "Anthill" else [])],
            "nativeArgv": ["/usr/games/crimson", "--level", f"/usr/share/games/crimson/levels/{item['level']}.lev",
                           "--width", "800", "--height", "600", "--fullscreen", "0", "--sound", "0"],
            "captureEnvironment": [
                ["LD_PRELOAD", "/opt/crimson_blit_trace.so"],
                ["CRIMSON_BLIT_TRACE", "/run/crimson-profile/runtime/native-blit.jsonl"],
                ["CRIMSON_BLIT_STATUS", "/run/crimson-profile/runtime/native-blit.status"],
            ],
            "traceBind": ["--ro-bind", "<pinned-tracer-artifact>", "/opt/crimson_blit_trace.so"],
            "controllerArgv": [
                ["/usr/bin/xdotool", "key", "--clearmodifiers", "Return"],
                ["/usr/bin/xdotool", "key", "--clearmodifiers", "Return"],
                *( [["/usr/bin/xdotool", "key", "KP_Down"]] if item["level"] == "Anthill" else []),
            ],
            "actionPurposes": ["dismiss turn briefing", "dismiss one timer-zero player message",
                           *( ["pan south to the map boundary with an SDL_KP2 key event whose NumLock bit is clear"] if item["level"] == "Anthill" else [])],
            "waitAfterLastActionMs": 1000, "captureCount": 1,
            "captureGate": "mapped XID owned by native PID; two known messages dismissed; native map draw trace; fixed 800x600 view; parent release required",
        })
    capture_plan_sha256 = sha256(json.dumps(capture_plan_rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return {
        "schemaVersion": "crimson-source-roster-audit-v1",
        "status": "metadata-only-inputs-pinned",
        "package": {"version": "0.5.2-1.1build2", "sha256": EXPECTED_PACKAGE_SHA256, "bytes": PACKAGE.stat().st_size},
        "downloadedPackageTotalBytes": package_total,
        "runtimePackages": runtime_packages,
        "packageExtractionBytes": extracted_size,
        "packageCopyrightSha256": copyright_hash,
        "sourceInputs": source_receipts,
        "licensedDisplayedAssets": asset_receipts,
        "hostIsolationAndProbeTools": host_tools,
        "nativeBlitTracerSha256": sha256(read_pinned(NATIVE_BLIT_TRACER, NATIVE_BLIT_TRACER_SHA256)),
        "stockBinarySha256": sha256(binary_data),
        "stockBinaryRelativePath": binary_relative,
        "registeredMapOrderSha256": REGISTERED_MAP_ORDER_SHA256,
        "privateFacingManifestSha256": FACING_MANIFEST_SHA256,
        "privateFacingVariants": variant_receipts,
        "nativeAtlasAudit": atlas_audit,
        "nativePaletteDisplayAudit": palette_display_audit,
        "nativeKeyInputAudit": key_input_audit,
        "defaultCameraProjection": projection_rows,
        "prospectiveCapturePlan": capture_plan_rows,
        "prospectiveCapturePlanSha256": capture_plan_sha256,
        "rendererProjectionSourceSha256": {path: digest for path, digest in MAPVIEW_SOURCE_PINS.items()},
        "nativeEventConstants": {
            "handicapNoneMask": HANDICAP_NONE_MASK, "eventFlagDisabled": EVENT_FLAG_DISABLED,
            "eventFlagDiscarded": EVENT_FLAG_DISCARDED,
            "missionHandicapByteOffset": MISSION_HANDICAP_BYTE_OFFSET,
        },
        "screenshotCount": 0,
        "pixelsRead": False,
        "cases": rows,
    }


def _exclusive_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        data = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        view = memoryview(data)
        while view:
            count = os.write(descriptor, view)
            if count <= 0:
                raise OracleError("short write while saving receipt")
            view = view[count:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class MetadataRunStore:
    """Owns one fresh run directory and persists bounded, append-only milestones."""

    def __init__(self, run_dir: Path, ledger_path: Path, case_id: str, attempt: int) -> None:
        if run_dir.parent.resolve() != ledger_path.parent.resolve() or run_dir == ledger_path:
            raise OracleError("run directory and external ledger must be distinct siblings")
        if run_dir.is_symlink() or ledger_path.is_symlink() or run_dir.exists() or ledger_path.exists():
            raise OracleError("per-run output or external ledger already exists or is a symlink")
        run_dir.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        run_dir.mkdir(mode=0o700)
        self.run_dir = run_dir
        self.ledger_path = ledger_path
        self.case_id = case_id
        self.attempt = attempt
        self.action_count = 0
        self.sequence = 0
        self.milestone_path = run_dir / "milestones.jsonl"
        self._milestone_fd = os.open(
            self.milestone_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        _exclusive_json(ledger_path, {
            "schemaVersion": "crimson-attempt-ledger-v1", "caseId": case_id,
            "attempt": attempt, "runDirectoryName": run_dir.name, "started": True,
        })
        self.milestone("run-started", {"caseId": case_id, "attempt": attempt})

    def milestone(self, name: str, details: dict[str, Any]) -> None:
        self.sequence += 1
        record = {
            "sequence": self.sequence, "milestone": name,
            "caseId": self.case_id, "details": details,
        }
        payload = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        current_size = os.fstat(self._milestone_fd).st_size
        if current_size + len(payload) > MAX_MILESTONE_BYTES:
            self.sequence -= 1
            raise OracleError("run milestone journal exceeded its fixed byte bound")
        view = memoryview(payload)
        while view:
            written = os.write(self._milestone_fd, view)
            if written <= 0:
                self.sequence -= 1
                raise OracleError("short write while persisting run milestone")
            view = view[written:]
        os.fsync(self._milestone_fd)

    def input_invoked(self, key: str) -> int:
        next_count = self.action_count + 1
        self.milestone("input-invoked", {"count": next_count, "key": key})
        self.action_count = next_count
        return next_count

    def write_receipt(self, payload: dict[str, Any]) -> None:
        _exclusive_json(self.run_dir / "receipt.json", payload)

    def close(self) -> None:
        if self._milestone_fd >= 0:
            os.fsync(self._milestone_fd)
            os.close(self._milestone_fd)
            self._milestone_fd = -1


def _metadata_run_paths(base_dir: Path, run_id: str) -> tuple[Path, Path]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,79}", run_id):
        raise OracleError("metadata run id must be a bounded lowercase path component")
    return base_dir / run_id, base_dir / f"{run_id}.ledger.json"


def _native_pids_in_group(group_id: int) -> list[int]:
    expected = CLIENT.stat()
    result: list[int] = []
    for candidate in Path("/proc").iterdir():
        if not candidate.name.isdecimal():
            continue
        process_id = int(candidate.name)
        try:
            if os.getpgid(process_id) != group_id:
                continue
            actual = (candidate / "exe").stat()
            if (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino):
                result.append(process_id)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return result


def _process_group_pids(group_id: int) -> list[int]:
    result: list[int] = []
    for candidate in Path("/proc").iterdir():
        if not candidate.name.isdecimal():
            continue
        process_id = int(candidate.name)
        try:
            if os.getpgid(process_id) == group_id:
                result.append(process_id)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return result


def _read_target_level_trace(output: Path, level_in_sandbox: str, native_pid: int) -> dict[str, Any]:
    trace_path = output / f"strace.{native_pid}"
    trace_paths = [trace_path]
    if trace_path.is_symlink() or not trace_path.is_file():
        raise OracleError("native ELF process syscall trace is missing")
    pieces: list[bytes] = []
    total = 0
    for trace_path in trace_paths:
        if trace_path.is_symlink() or not trace_path.is_file():
            raise OracleError("syscall trace contains a non-file entry")
        size = trace_path.stat().st_size
        if size > MAX_TRACE_FILE_BYTES:
            raise OracleError("one native syscall trace exceeds its byte cap")
        total += size
        if total > MAX_TRACE_BYTES:
            raise OracleError("native syscall traces exceed their total byte cap")
        pieces.append(trace_path.read_bytes())
    text = b"\n".join(pieces).decode("utf-8", "replace")
    matching = [line for line in text.splitlines() if level_in_sandbox in line]
    opened = any("openat(" in line and "= -1 " not in line for line in matching)
    read = any(line.lstrip().startswith("read(") and "= -1 " not in line and not line.rstrip().endswith("= 0") for line in matching)
    if not opened or not read:
        raise OracleError("the owned native process did not open and read the selected stock level")
    return {
        "status": "exact-level-opened-and-read", "nativePid": native_pid,
        "levelPath": level_in_sandbox, "readTraceLines": len(matching), "traceBytes": total,
    }


def run_metadata_case(
    item: dict[str, Any], run_dir: Path, ledger_path: Path, attempt: int,
    capture: bool = False, approved_plan_sha256: str | None = None,
) -> dict[str, Any]:
    audit = audit_roster()
    source_case = next(row for row in audit["cases"] if row["caseId"] == item["caseId"])
    capture_plan = next(row for row in audit["prospectiveCapturePlan"] if row["caseId"] == item["caseId"])
    if capture and approved_plan_sha256 != audit["prospectiveCapturePlanSha256"]:
        raise OracleError("capture-run requires the parent-approved exact prospective plan digest")
    if not capture and approved_plan_sha256 is not None:
        raise OracleError("metadata-run cannot accept a capture release digest")
    if not source_case["metadataRunEligible"]:
        raise OracleError(
            f"direct-start inventory is not proven from pinned initial events: {item['caseId']}"
        )
    store = MetadataRunStore(run_dir, ledger_path, item["caseId"], attempt)
    profile = run_dir / "profile"
    for name in ("home", "config", "cache", "data", "runtime"):
        (profile / name).mkdir(mode=0o700, parents=True, exist_ok=True)

    xvfb_log = (run_dir / "xvfb.log").open("xb")
    app_log = (run_dir / "application.log").open("xb")
    server = subprocess.Popen(
        ["/usr/bin/Xvfb", "-displayfd", "1", "-screen", "0", "800x600x24", "-nolisten", "tcp", "-noreset"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=xvfb_log,
        cwd=str(DATA), env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        start_new_session=True,
    )
    client: subprocess.Popen[bytes] | None = None
    stdout_bytes = b""
    failure: str | None = None
    window_metadata: dict[str, Any] | None = None
    level_readback: dict[str, Any] | None = None
    map_state_gate: dict[str, Any] | None = None
    native_pid: int | None = None
    start_group: int | None = None
    run_status: str | None = None
    display: str | None = None
    controller_environment: dict[str, str] | None = None
    controller_diagnostics: list[dict[str, Any]] = []
    screenshot_receipt: dict[str, Any] | None = None
    native_draw_gate: dict[str, Any] | None = None
    pixel_gate: dict[str, Any] | None = None
    native_anchor_pixel_gate: dict[str, Any] | None = None
    startup_input_count = store.action_count
    store.milestone("xvfb-started", {"pid": server.pid})
    try:
        if server.stdout is None:
            raise OracleError("Xvfb display descriptor was not opened")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            readable, _, _ = select.select([server.stdout], [], [], max(0.0, deadline - time.monotonic()))
            display_line = server.stdout.readline() if readable else b""
            if display_line:
                break
            if server.poll() is not None:
                raise OracleError(f"Xvfb exited before readiness with status {server.returncode}")
            time.sleep(0.05)
        else:
            raise OracleError("Xvfb readiness deadline expired")
        display = ":" + display_line.decode("ascii", "strict").strip()
        controller_environment = _controller_environment(display)
        store.milestone("xvfb-ready", {"display": display})
        sandbox_home = "/run/crimson-profile/home"
        sandbox_level = f"/usr/share/games/crimson/levels/{item['level']}.lev"
        facing_recipe = FACING_RECIPE_PINS.get(item["level"])
        selected_level_host = (
            FACING_VARIANTS / facing_recipe["level"][0]
            if facing_recipe is not None
            else DATA / f"levels/{item['level']}.lev"
        )
        selected_level_hash = (
            facing_recipe["level"][1]
            if facing_recipe is not None
            else ASSET_HASHES[f"levels/{item['level']}.lev"]
        )
        read_pinned(selected_level_host, selected_level_hash, MAX_EXTRACTED_BYTES)
        command = [
            "/usr/bin/strace", "-ff", "-qq", "-yy", "-s", "0", "-e", "trace=openat,read",
            "-o", str(run_dir / "strace"), "--",
            "/usr/bin/bwrap", "--die-with-parent", "--unshare-net",
            "--ro-bind", "/usr", "/usr",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--ro-bind", str(EXTRACTED / "usr/share/games"), "/usr/share/games",
            *( ["--ro-bind", str(selected_level_host), sandbox_level] if facing_recipe is not None else [] ),
            "--ro-bind", str(EXTRACTED / "usr/games"), "/usr/games",
            "--dir", "/opt", "--dir", "/opt/crimson-runtime",
            "--ro-bind", str(EXTRACTED / "usr/lib/x86_64-linux-gnu"), "/opt/crimson-runtime",
            *( ["--ro-bind", str(NATIVE_BLIT_TRACER), "/opt/crimson_blit_trace.so"] if capture else [] ),
            "--proc", "/proc", "--dev", "/dev", "--size", str(MAX_SANDBOX_TMP_BYTES), "--tmpfs", "/tmp",
            "--dir", "/tmp/.X11-unix", "--ro-bind", "/tmp/.X11-unix", "/tmp/.X11-unix",
            "--dir", "/run", "--dir", "/run/crimson-profile",
            "--bind", str(profile), "/run/crimson-profile",
            "--chdir", "/usr/share/games/crimson",
            "--setenv", "PATH", "/usr/bin:/bin",
            "--setenv", "LANG", "C.UTF-8", "--setenv", "LC_ALL", "C.UTF-8",
            "--setenv", "HOME", sandbox_home,
            "--setenv", "XDG_CONFIG_HOME", "/run/crimson-profile/config",
            "--setenv", "XDG_CACHE_HOME", "/run/crimson-profile/cache",
            "--setenv", "XDG_DATA_HOME", "/run/crimson-profile/data",
            "--setenv", "XDG_RUNTIME_DIR", "/run/crimson-profile/runtime",
            *_display_binding(display),
            "--setenv", "SDL_VIDEODRIVER", "x11", "--setenv", "SDL_AUDIODRIVER", "dummy",
            "--setenv", "LD_LIBRARY_PATH", "/opt/crimson-runtime",
            *( ["--setenv", "LD_PRELOAD", "/opt/crimson_blit_trace.so",
                "--setenv", "CRIMSON_BLIT_TRACE", "/run/crimson-profile/runtime/native-blit.jsonl",
                "--setenv", "CRIMSON_BLIT_STATUS", "/run/crimson-profile/runtime/native-blit.status"] if capture else [] ),
            "--",
            "/usr/games/crimson", "--level", sandbox_level, "--width", "800", "--height", "600",
            "--fullscreen", "0", "--sound", "0",
        ]
        client = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=app_log, stderr=subprocess.STDOUT,
            cwd=str(DATA), env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            start_new_session=True,
            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_TRACE_BYTES, MAX_TRACE_BYTES)),
        )
        start_group = os.getpgid(client.pid)
        store.milestone("client-started", {
            "pid": client.pid, "processGroup": start_group, "captureMode": capture,
            "capturePlanSha256": audit["prospectiveCapturePlanSha256"] if capture else None,
            "nativeArgv": capture_plan["nativeArgv"],
            "tracerSha256": NATIVE_BLIT_TRACER_SHA256 if capture else None,
        })
        deadline = time.monotonic() + MAX_CASE_SECONDS
        while time.monotonic() < deadline:
            if client.poll() is not None:
                raise OracleError(f"isolated Crimson process group exited before native-window proof; status={client.returncode}")
            native_pids = _native_pids_in_group(start_group)
            probe = _xdotool(display, ["search", "--onlyvisible", "--name", ".*"], controller_diagnostics, store)
            window_ids = [line for line in probe.stdout.decode("ascii", "ignore").splitlines() if line.isdecimal()]
            native_windows: list[tuple[str, int]] = []
            window_diagnostics: list[dict[str, Any]] = []
            for window_id in window_ids:
                pid_result = _xdotool(display, ["getwindowpid", window_id], controller_diagnostics, store)
                if pid_result.returncode != 0:
                    window_diagnostics.append({"windowId": window_id, "pidReturncode": pid_result.returncode})
                    continue
                try:
                    reported_pid = int(pid_result.stdout.decode("ascii").strip(), 10)
                except ValueError:
                    window_diagnostics.append({
                        "windowId": window_id, "pidReturncode": pid_result.returncode,
                        "pidStdout": pid_result.stdout.decode("ascii", "replace")[:256],
                    })
                    continue
                window_diagnostics.append({"windowId": window_id, "reportedPid": reported_pid})
                if reported_pid in native_pids:
                    native_windows.append((window_id, reported_pid))
            if probe.returncode == 0 and len(native_windows) == 1:
                active_id, native_pid = native_windows[0]
                geometry = _xdotool(display, ["getwindowgeometry", "--shell", active_id], controller_diagnostics, store)
                if geometry.returncode == 0:
                    geometry_text = geometry.stdout.decode("ascii", "replace")[:2048]
                    if "WIDTH=800" not in geometry_text or "HEIGHT=600" not in geometry_text:
                        raise OracleError("owned Crimson window geometry differs from the pinned viewport")
                    window_metadata = {
                        "windowId": active_id, "nativePid": native_pid, "geometry": geometry_text,
                        "probeReturncode": probe.returncode, "windowDiagnostics": window_diagnostics,
                    }
                    store.milestone("app-owned-window", {
                        "display": display, "window": window_metadata,
                        "controllerDiagnostics": controller_diagnostics,
                    })
                    break
            time.sleep(0.1)
        if window_metadata is None:
            raise OracleError("no mapped non-root X11 window owned by the pinned Crimson executable")
        assert window_metadata is not None and display is not None and native_pid is not None
        focus = _xdotool(display, ["windowfocus", "--sync", window_metadata["windowId"]], controller_diagnostics, store)
        if focus.returncode != 0:
            raise OracleError("could not focus the verified native window directly")
        focused = _xdotool(display, ["getwindowfocus"], controller_diagnostics, store)
        focused_id = focused.stdout.decode("ascii", "replace").strip()
        if focused.returncode != 0 or focused_id != window_metadata["windowId"]:
            raise OracleError("focused X11 window does not equal the verified native XID")
        focus_pid = _xdotool(display, ["getwindowpid", focused_id], controller_diagnostics, store)
        try:
            focused_pid = int(focus_pid.stdout.decode("ascii").strip(), 10)
        except ValueError:
            focused_pid = -1
        if focus_pid.returncode != 0 or focused_pid != native_pid:
            raise OracleError("focused verified XID is not owned by the live Crimson process")
        startup_input_count = store.input_invoked("Return")
        dismissal = _xdotool(display, ["key", "--clearmodifiers", "Return"], controller_diagnostics, store)
        if dismissal.returncode != 0:
            raise OracleError("normal turn-briefing dismissal input failed")
        time.sleep(0.4)
        if capture:
            store.input_invoked("Return")
            second_dismissal = _xdotool(display, ["key", "--clearmodifiers", "Return"], controller_diagnostics, store)
            if second_dismissal.returncode != 0:
                raise OracleError("predeclared timer-zero message dismissal input failed")
            if item["level"] == "Anthill":
                time.sleep(0.4)
                store.input_invoked("KP_Down")
                scroll = _xdotool(display, ["key", "KP_Down"], controller_diagnostics, store)
                if scroll.returncode != 0:
                    raise OracleError("predeclared south map scroll input failed")
            startup_input_count = store.action_count
        time.sleep(1)
        if client.poll() is not None:
            raise OracleError(f"Crimson exited after owned-window proof; status={client.returncode}")
        native_pids = _native_pids_in_group(start_group)
        if native_pid not in native_pids:
            raise OracleError("owned Crimson process stopped after briefing dismissal")
        level_readback = _read_target_level_trace(run_dir, sandbox_level, native_pid)
        store.milestone("native-level-read", level_readback)
        if not source_case["directStartInventoryProven"]:
            raise OracleError("pinned initial event set can change the selected map inventory")
        map_state_gate = {
            "status": "native-level-load-with-exact-source-simulated-post-start-inventory",
            "nativeReadback": level_readback,
            "sourceScenario": item["level"],
            "registeredStateId": item["stateId"], "registeredOpaqueMapId": item["mapId"],
            "sourceUnitCount": source_case["sourceUnitCount"],
            "postInitializationUnitCount": source_case["postInitializationUnitCount"],
            "sourceInventorySha256": source_case["sourceInventorySha256"],
            "completeSourceUnitInventory": source_case["sourceInventory"],
            "sourceTruth": source_case["sourceTruth"],
            "targetCreationEvents": source_case["targetCreationEvents"],
            "activeDirectStartEvents": source_case["activeTargetCreationEventsAtDirectStart"],
            "initialTurnEventAudit": source_case["initialTurnEventAudit"],
            "privateFacingVariant": source_case["privateFacingVariant"],
            "loadedLevelSha256": selected_level_hash,
            "screenReadyForCapture": False,
            "additionalMessageDismissalsRequired": source_case["initialTurnEventAudit"]["additionalMessageDismissalsRequired"],
            "gameplayActionsAfterLoad": 0,
            "basis": "the app-owned native process read the exact pinned level bytes; the Mission handicap mask and all active handicap/timer-zero unit events were simulated from pinned sources and native event semantics; only the normal briefing dismissal was issued",
        }
        store.milestone("map-state-gate", {
            "status": map_state_gate["status"], "sourceScenario": item["level"],
            "sourceUnitCount": source_case["sourceUnitCount"],
            "postInitializationUnitCount": source_case["postInitializationUnitCount"],
            "sourceInventorySha256": source_case["sourceInventorySha256"],
            "sourceTruth": source_case["sourceTruth"],
        })
        app_log.flush()
        log_bytes = (run_dir / "application.log").read_bytes()
        if b"Error loading " in log_bytes or b"Couldn't load language resources" in log_bytes:
            raise OracleError("Crimson logged a language or selected-level load failure")
        run_status = "active-pinned-level-loaded-and-native-window-owned"
        if capture:
            if store.action_count != len(capture_plan["controllerArgv"]):
                raise OracleError("actual native UI action count differs from the frozen per-case argv")
            focused = _xdotool(display, ["getwindowfocus"], controller_diagnostics, store)
            focused_id = focused.stdout.decode("ascii", "replace").strip()
            if focused.returncode != 0 or focused_id != window_metadata["windowId"]:
                raise OracleError("native capture focus no longer matches the verified app XID")
            focused_pid_result = _xdotool(display, ["getwindowpid", focused_id], controller_diagnostics, store)
            try:
                focused_pid = int(focused_pid_result.stdout.decode("ascii").strip(), 10)
            except ValueError:
                focused_pid = -1
            if focused_pid_result.returncode != 0 or focused_pid != native_pid:
                raise OracleError("capture XID is not owned by the original native PID")
            dimensions = {name: int(value) for name, value in re.findall(r"(?m)^(X|Y|WIDTH|HEIGHT)=(-?\d+)$", window_metadata["geometry"])}
            if set(dimensions) != {"X", "Y", "WIDTH", "HEIGHT"}:
                raise OracleError("native window geometry response is incomplete at capture time")
            trace_status_path = profile / "runtime/native-blit.status"
            barrier = request_native_trace_barrier(native_pid, trace_status_path)
            status_path_bytes = trace_status_path.read_bytes()
            store.milestone("native-trace-action-barrier", barrier)
            trace_path = profile / "runtime/native-blit.jsonl"
            if trace_path.is_symlink() or not trace_path.is_file() or trace_path.stat().st_size > MAX_TRACE_FILE_BYTES:
                raise OracleError("native SDL blit trace is missing, linked or over its 2 MiB cap")
            trace_bytes = trace_path.read_bytes()
            expected_draw = next(
                (row for row in audit["defaultCameraProjection"] if row["caseId"] == item["caseId"]), None,
            )
            native_draw_gate = verify_native_blit_trace(
                trace_bytes, item, expected_draw, capture_plan["nativeAnchor"],
            )
            frame_path = run_dir / "native-window.png"
            screenshot_receipt = capture_native_window_png(
                display, (dimensions["X"], dimensions["Y"], dimensions["WIDTH"], dimensions["HEIGHT"]),
                frame_path, native_pid, focused_pid,
            )
            store.milestone("native-window-captured", screenshot_receipt)
            trace_after_frame = trace_path.read_bytes()
            status_after_frame = trace_status_path.read_bytes()
            if sha256(trace_after_frame) != sha256(trace_bytes) or status_after_frame != status_path_bytes:
                raise OracleError("native map draw state changed between the trace barrier and screenshot readback")
            frame_size = frame_path.stat().st_size
            if frame_path.is_symlink() or frame_size > 4 * 1024 * 1024:
                raise OracleError("captured native frame is linked or over its 4 MiB cap")
            frame_bytes = frame_path.read_bytes()
            if sha256(frame_bytes) != screenshot_receipt["sha256"]:
                raise OracleError("captured frame bytes changed between write and pixel audit")
            if item["label"] == "positive":
                if expected_draw is None:
                    raise OracleError("positive capture lacks the source-derived target projection")
                pixel_gate = verify_native_frame_sprite(frame_bytes, item, expected_draw)
                store.milestone("native-sprite-pixel-gate", pixel_gate)
            else:
                native_anchor_pixel_gate = verify_native_frame_anchor(
                    frame_bytes, item, capture_plan["nativeAnchor"],
                )
                store.milestone("native-anchor-pixel-gate", native_anchor_pixel_gate)
            run_status = "one-native-frame-captured-awaiting-manual-admission"
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        if client is not None and client.poll() is None:
            try:
                os.killpg(client.pid, signal.SIGTERM)
                client.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(client.pid, signal.SIGKILL)
                except OSError:
                    pass
                client.wait(timeout=3)
        client_status = None if client is None else client.returncode
        if start_group is not None:
            close_deadline = time.monotonic() + 3
            while _process_group_pids(start_group) and time.monotonic() < close_deadline:
                time.sleep(0.05)
        process_group_closed = start_group is None or not _process_group_pids(start_group)
        if server.poll() is None:
            try:
                os.killpg(server.pid, signal.SIGTERM)
                server.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(server.pid, signal.SIGKILL)
                except OSError:
                    pass
                server.wait(timeout=3)
        server_status = server.returncode
        if client is not None and client.stdout is not None:
            client.stdout.close()
        if server.stdout is not None:
            stdout_bytes = server.stdout.read(1024)
            server.stdout.close()
        app_log.close()
        xvfb_log.close()
        store.milestone("process-closure", {
            "clientExitStatus": client_status, "xvfbExitStatus": server_status,
            "ownedProcessesClosed": (client is None or client.poll() is not None) and server.poll() is not None and process_group_closed,
            "processGroupClosed": process_group_closed,
        })

    result = {
        "schemaVersion": "crimson-metadata-run-v5",
        "status": "completed" if failure is None else "failed",
        "runtimeGate": run_status,
        "caseId": item["caseId"],
        "registeredStateId": item["stateId"], "registeredOpaqueMapId": item["mapId"],
        "commandProfile": ["stock-level", "800x600", "windowed", "sound-disabled", "bubblewrap-ro-data", "private-mount-namespace", "private-network-namespace"],
        "display": display,
        "controllerEnvironment": controller_environment,
        "controllerDiagnostics": controller_diagnostics,
        "x11Window": window_metadata,
        "selectedLevelReadback": level_readback,
        "mapStateGate": map_state_gate,
        "startupInput": {
            "count": startup_input_count,
            "purpose": "normal turn/message dismissal and predeclared camera scroll" if capture else "normal turn-briefing dismissal",
            "controllerArgv": capture_plan["controllerArgv"] if capture else [["/usr/bin/xdotool", "key", "--clearmodifiers", "Return"]],
        },
        "clientExitStatus": client_status,
        "xvfbExitStatus": server_status,
        "ownedProcessesClosed": (client is None or client.poll() is not None) and server.poll() is not None and process_group_closed,
        "failure": failure,
        "packageInputAudit": audit,
        "xvfbDiagnosticBytes": len(stdout_bytes),
        "capturePlanSha256": audit["prospectiveCapturePlanSha256"] if capture else None,
        "screenshotCount": 1 if screenshot_receipt is not None else 0,
        "pixelsRead": screenshot_receipt is not None,
        "nativeWindowPng": screenshot_receipt,
        "nativeDrawGate": native_draw_gate,
        "targetSpritePixelGate": pixel_gate,
        "nativeAnchorPixelGate": native_anchor_pixel_gate,
        "physicalProviderCalls": 0,
    }
    store.write_receipt(result)
    store.close()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("audit", help="verify pinned source, assets and prospective roster only")
    metadata = subparsers.add_parser("metadata-run", help="run one source-pinned scenario without image capture")
    metadata.add_argument("--case-id", choices=[row["caseId"] for row in ROSTER], required=True)
    metadata.add_argument("--run-id", required=True)
    metadata.add_argument("--attempt", type=int, required=True)
    capture = subparsers.add_parser("capture-run", help="run one approved map case and capture exactly one native frame")
    capture.add_argument("--case-id", choices=[row["caseId"] for row in ROSTER], required=True)
    capture.add_argument("--run-id", required=True)
    capture.add_argument("--attempt", type=int, required=True)
    capture.add_argument("--release-plan-sha256", required=True)
    args = parser.parse_args()
    try:
        if args.command == "audit":
            receipt = audit_roster()
        else:
            item = next(row for row in ROSTER if row["caseId"] == args.case_id)
            run_dir, ledger_path = _metadata_run_paths(ARTIFACT, args.run_id)
            receipt = run_metadata_case(
                item, run_dir, ledger_path, args.attempt,
                capture=(args.command == "capture-run"),
                approved_plan_sha256=(args.release_plan_sha256 if args.command == "capture-run" else None),
            )
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
        return 0 if receipt.get("status") in {"metadata-only-inputs-pinned", "completed"} else 1
    except (OracleError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "refused-or-failed", "failure": f"{type(error).__name__}: {error}", "pixelsRead": False}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
