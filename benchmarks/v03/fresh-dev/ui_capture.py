#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import io
import json
import os
import re
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from imaging import CurateError as ImagingValidationError, _read_png_chunks, png_ihdr_dimensions
from validation import CurateError as FileValidationError, read_bounded_file_bytes

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.resolve().parents[3]

SEED = "mcp-h8a-fresh-dev-ui-20261031-v1"
UUID_NAMESPACE = uuid.UUID("8f4e3c2a-1b0d-4e5f-9a8b-7c6d5e4f3a2b")
STATE_MANIFEST_SCHEMA = "h8a-fresh-dev-ui-state-manifest-v1"
PRODUCER_MANIFEST_SCHEMA = "h8a-fresh-dev-ui-producer-manifest-v1"
PREFLIGHT_RECEIPT_SCHEMA = "h8a-fresh-dev-ui-preflight-receipt-v1"
CAPTURE_RECEIPT_SCHEMA = "h8a-fresh-dev-ui-capture-receipt-v1"

VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 1024
MAX_CASE_SECONDS = 30
MAX_LOG_BYTES = 256 * 1024
MAX_RUNTIME_DIR_PATH_BYTES = 48
MAX_ATSPI_NODES = 2000
MAX_ATSPI_DEPTH = 64
MAX_ATSPI_CHILDREN = 512
MAX_ATSPI_APPLICATIONS = 32
MAX_ATSPI_TEXT_CHARS = 256
MAX_ATSPI_FAILURE_BYTES = 4 * 1024 * 1024
AT_SPI_READY_SECONDS = 8.0
AT_SPI_POLL_INTERVAL = 0.2
MAX_PREFLIGHT_SUMMARY_BYTES = 16 * 1024 * 1024
MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
MAX_NEUTRAL_INPUT_BYTES = 16 * 1024 * 1024
MAX_NEUTRAL_INPUT_FILES = 256
MAX_NEUTRAL_INPUT_FILE_BYTES = 8 * 1024 * 1024
SHA256_HEX = re.compile(r"^[a-f0-9]{64}$")
CASE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

DEFAULT_OUTSIDE_ROOT_PICTURES_BASE = Path("/var/tmp/zorya-h8a-ui-authored-v1/pictures")
_outside_root_pictures_base_override: Path | None = None

DpkgQueryRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]
_dpkg_query_runner_override: DpkgQueryRunner | None = None

PINNED_GTK3_SO = Path("/usr/lib/x86_64-linux-gnu/libgtk-3.so.0")
PINNED_GTK3_SO_SHA = "0611fd19d1354a39a7cfafceffa3bdf4289d4c497c7f69ff337f86e99cf37d93"
PINNED_GTK3_PKG = ("libgtk-3-0t64", "3.24.41-4ubuntu1.3")

PINNED_DEJAVU = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
PINNED_DEJAVU_SHA = "ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280"
PINNED_DEJAVU_PKG = ("fonts-dejavu-core", "2.37-8")

PINNED_OPENBOX_THEME = Path("/usr/share/themes/Clearlooks/openbox-3/themerc")
PINNED_OPENBOX_THEME_SHA = "bdbb6bbb28890cd6c22bee46de7801184ca8b601b2010e3e8d20adea7924ee4a"
PINNED_OPENBOX_PKG = ("openbox", "3.6.1-12build5")

PINNED_OPENBOX_RC = Path("/etc/xdg/openbox/rc.xml")
PINNED_OPENBOX_RC_SHA = "dc4906ce83e6130a4f622871039a80d872d3b3bc72030bc887f2fbe73bbfd38f"

PINNED_ADWAITA_ICONS_PKG = ("adwaita-icon-theme", "46.0-1")

PINNED_ICON_FILES: dict[str, Path] = {
    "go-previous": Path("/usr/share/icons/Adwaita/symbolic/actions/go-previous-symbolic.svg"),
    "go-up": Path("/usr/share/icons/Adwaita/symbolic/actions/go-up-symbolic.svg"),
    "go-home": Path("/usr/share/icons/Adwaita/symbolic/actions/go-home-symbolic.svg"),
    "system-search": Path("/usr/share/icons/Adwaita/symbolic/actions/system-search-symbolic.svg"),
    "zoom-in": Path("/usr/share/icons/Adwaita/symbolic/actions/zoom-in-symbolic.svg"),
    "zoom-out": Path("/usr/share/icons/Adwaita/symbolic/actions/zoom-out-symbolic.svg"),
    "view-fullscreen": Path("/usr/share/icons/Adwaita/symbolic/actions/view-fullscreen-symbolic.svg"),
}

THUNAR_BINARY = Path("/usr/bin/thunar")
EOG_BINARY = Path("/usr/bin/eog")
THUNAR_PKG = ("thunar", "4.18.8-1build3")
EOG_PKG = ("eog", "45.3-1ubuntu2")


class UiCaptureError(Exception):
    pass


@dataclass(frozen=True)
class TargetSpec:
    role: str
    name: str


@dataclass(frozen=True)
class CaseSpec:
    slot_key: str
    source_group: str
    expected_presence: str
    target: TargetSpec
    image_size: tuple[int, int] | None
    thunar_recipe: str | None


CASE_SPECS: tuple[CaseSpec, ...] = (
    CaseSpec("thunar-p1", "thunar", "present", TargetSpec("push button", "Back"), None, "p1_back_history"),
    CaseSpec("thunar-p2", "thunar", "present", TargetSpec("push button", "Open Parent"), None, "p2_open_parent"),
    CaseSpec("thunar-p3", "thunar", "present", TargetSpec("push button", "Home"), None, "p3_home_outside_root"),
    CaseSpec("thunar-p4", "thunar", "present", TargetSpec("toggle button", "Search for Files..."), None, "p4_search"),
    CaseSpec("thunar-n1", "thunar", "absent", TargetSpec("push button", "Fullscreen"), None, "n1_fullscreen_absent"),
    CaseSpec("eog-p1", "eog", "present", TargetSpec("push button", "Zoom In"), (480, 480), None),
    CaseSpec("eog-p2", "eog", "present", TargetSpec("push button", "Zoom Out"), (640, 400), None),
    CaseSpec("eog-p3", "eog", "present", TargetSpec("push button", "Fullscreen"), (400, 640), None),
    CaseSpec("eog-n1", "eog", "absent", TargetSpec("toggle button", "Search for Files..."), (520, 380), None),
    CaseSpec("eog-n2", "eog", "absent", TargetSpec("push button", "Open Parent"), (380, 520), None),
)

NEUTRAL_FRAME_NAME = "generic frame.png"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def path_is_inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
        return True
    except ValueError:
        return False


def require_external_new_directory(path: Path, label: str) -> Path:
    if path.is_symlink():
        raise UiCaptureError(f"{label} must not be a symlink: {path}")
    resolved = path.resolve()
    if path_is_inside_repo(resolved):
        raise UiCaptureError(f"{label} must resolve outside repository: {resolved}")
    if resolved.exists():
        raise UiCaptureError(f"{label} must not exist yet: {resolved}")
    return resolved


def require_existing_bundle(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_dir():
        raise UiCaptureError(f"bundle directory missing: {resolved}")
    manifest = resolved / "private" / "state-manifest.json"
    if not manifest.is_file():
        raise UiCaptureError(f"bundle missing private/state-manifest.json: {resolved}")
    return resolved


def create_private_ui_profile(bundle: Path, phase: str, role: str, case_id: str) -> dict[str, Path]:
    if phase not in {"preflight", "capture"} or role not in {"worker", "app"}:
        raise UiCaptureError("invalid private UI profile identity")
    if not CASE_ID_RE.fullmatch(case_id):
        raise UiCaptureError("invalid private UI profile case ID")
    root = bundle / "private" / "profiles" / phase / role / case_id
    for component in (bundle, *root.parents):
        if component.is_symlink():
            raise UiCaptureError("private UI profile path crosses a symlink")
    if root.exists():
        raise UiCaptureError("private UI profile already exists; use a new bundle")
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    root.chmod(0o700)
    paths = {"home": root / "home"}
    paths.update({name: root / name for name in ("config", "data", "cache", "state")})
    for path in paths.values():
        path.mkdir(mode=0o700, exist_ok=False)
        path.chmod(0o700)
    return paths


def build_ui_process_environment(profile: dict[str, Path], *, runtime_dir: Path | None = None) -> dict[str, str]:
    required_paths = {"home", "config", "data", "cache", "state"}
    if set(profile) != required_paths:
        raise UiCaptureError("private UI profile paths mismatch")
    env = {
        "HOME": str(profile["home"]),
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "LC_CTYPE": "C.UTF-8",
        "GTK_THEME": "Adwaita",
        "GTK_MODULES": "atk-bridge",
        "GTK_A11Y": "always",
        "GTK_USE_PORTAL": "0",
        "GDK_BACKEND": "x11",
        "XDG_CONFIG_HOME": str(profile["config"]),
        "XDG_DATA_HOME": str(profile["data"]),
        "XDG_CACHE_HOME": str(profile["cache"]),
        "XDG_STATE_HOME": str(profile["state"]),
        "XDG_DATA_DIRS": "/usr/local/share:/usr/share",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if runtime_dir is not None:
        env["XDG_RUNTIME_DIR"] = str(runtime_dir)
        env["TMPDIR"] = str(runtime_dir)
        env["ZORYA_UI_NEUTRAL_ROOT"] = str(runtime_dir / "n")
    return env


def copy_neutral_case_input(bundle: Path, row: dict[str, Any], neutral_root: Path) -> Path:
    if neutral_root.is_symlink() or not neutral_root.is_dir():
        raise UiCaptureError("private neutral tmpfs root is unavailable")
    if not _is_private_tmpfs_mount(neutral_root):
        raise UiCaptureError("private neutral input root is not the expected tmpfs mount")
    if row.get("sourceGroup") == "thunar":
        if row_uses_outside_root_pictures(row):
            source = resolve_case_launch_path(bundle, row)
            destination = neutral_root / "Pictures"
            _copy_neutral_tree(source, destination, forbidden_ids=(row["caseId"], row["sourceStateId"]))
            return destination

        input_root = _case_input_root(bundle, row)
        if not input_root.is_dir():
            raise UiCaptureError("Thunar authored input root is missing or symlinked")
        neutral_input_root = neutral_root / "roots"
        _copy_neutral_tree(input_root, neutral_input_root, forbidden_ids=(row["caseId"], row["sourceStateId"]))
        authored = row.get("authored")
        launch_relative = authored.get("launchInputRelative") if isinstance(authored, dict) else None
        if not isinstance(launch_relative, str):
            launch_relative = row.get("launchInputRelative")
        return _safe_neutral_child(neutral_input_root, launch_relative, "Thunar launch path")

    if row.get("sourceGroup") != "eog":
        raise UiCaptureError("unknown UI source group for neutral input")
    input_root = _case_input_root(bundle, row)
    authored = row.get("authored")
    source_name = authored.get("frameRelativePath") if isinstance(authored, dict) else None
    if not isinstance(source_name, str) or Path(source_name).name != source_name:
        raise UiCaptureError("EOG authored image filename is unsafe")
    source = input_root / source_name
    if source.is_symlink() or not source.is_file():
        raise UiCaptureError("EOG authored image is missing or symlinked")
    data, _digest = read_bounded_file_bytes(
        source,
        max_bytes=MAX_NEUTRAL_INPUT_FILE_BYTES,
        label="EOG authored image",
    )
    if len(data) > MAX_NEUTRAL_INPUT_BYTES:
        raise UiCaptureError("EOG authored image exceeds neutral input cap")
    destination = neutral_root / source_name
    with destination.open("xb") as handle:
        handle.write(data)
    return destination


def _case_input_root(bundle: Path, row: dict[str, Any]) -> Path:
    relative_text = row.get("inputRootRelative")
    if not isinstance(relative_text, str):
        raise UiCaptureError("case input root metadata is missing")
    relative = Path(relative_text)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise UiCaptureError("case input root metadata contains traversal")
    raw = bundle / relative
    if raw.is_symlink():
        raise UiCaptureError("case input root must not be a symlink")
    for parent in raw.parents:
        if parent == bundle:
            break
        if parent.is_symlink():
            raise UiCaptureError("case input root path crosses a symlink")
    resolved = raw.resolve()
    allowed_root = bundle / "private" / "input-roots"
    try:
        resolved.relative_to(allowed_root.resolve())
    except ValueError as error:
        raise UiCaptureError("case input root escapes the bundle input area") from error
    return resolved


def _is_private_tmpfs_mount(path: Path) -> bool:
    resolved = path.resolve()
    if path.is_symlink() or not path.is_dir() or not os.path.ismount(path):
        return False
    try:
        mount_info = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
    except OSError:
        return False
    if len(mount_info) > 2 * 1024 * 1024:
        return False
    for line in mount_info.splitlines():
        before, separator, after = line.partition(" - ")
        fields = before.split()
        filesystem_fields = after.split()
        if separator and len(fields) >= 5 and filesystem_fields:
            mountpoint = fields[4].replace("\\040", " ")
            if Path(mountpoint) == resolved and filesystem_fields[0] == "tmpfs":
                return True
    return False


def _copy_neutral_tree(source: Path, destination: Path, *, forbidden_ids: tuple[str, ...]) -> None:
    if source.is_symlink() or not source.is_dir() or destination.exists() or destination.is_symlink():
        raise UiCaptureError("neutral input tree source or destination is invalid")
    entries = sorted(source.rglob("*"))
    if len(entries) > MAX_NEUTRAL_INPUT_FILES:
        raise UiCaptureError("neutral input tree exceeds file count cap")
    destination.mkdir(mode=0o700)
    total_bytes = 0
    for entry in entries:
        relative = entry.relative_to(source)
        if any(identifier and identifier in relative.as_posix() for identifier in forbidden_ids):
            raise UiCaptureError("authored input filename contains a private case or state ID")
        target = destination / relative
        if entry.is_symlink():
            raise UiCaptureError("authored input tree contains a symlink")
        if entry.is_dir():
            target.mkdir(mode=0o700)
            continue
        if not entry.is_file():
            raise UiCaptureError("authored input tree contains a non-regular file")
        payload, _digest = read_bounded_file_bytes(
            entry,
            max_bytes=MAX_NEUTRAL_INPUT_FILE_BYTES,
            label="authored neutral input file",
        )
        total_bytes += len(payload)
        if total_bytes > MAX_NEUTRAL_INPUT_BYTES:
            raise UiCaptureError("authored neutral input tree exceeds byte cap")
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with target.open("xb") as handle:
            handle.write(payload)


def _safe_neutral_child(root: Path, relative: Any, label: str) -> Path:
    if not isinstance(relative, str) or not relative or relative.startswith(("/", "\\")):
        raise UiCaptureError(f"{label} is invalid")
    parts = Path(relative).parts
    if any(part in ("", ".", "..") for part in parts) or "\\" in relative:
        raise UiCaptureError(f"{label} contains traversal")
    child = root.joinpath(*parts)
    try:
        child.resolve().relative_to(root.resolve())
    except ValueError as error:
        raise UiCaptureError(f"{label} escapes neutral root") from error
    if not child.is_dir():
        raise UiCaptureError(f"{label} target directory is missing")
    return child


def create_short_runtime_directory() -> tuple[Path, str]:
    path = Path(tempfile.mkdtemp(prefix="zui-", dir="/tmp"))
    token = uuid.uuid4().hex
    try:
        path.chmod(0o700)
        if len(os.fsencode(str(path))) > MAX_RUNTIME_DIR_PATH_BYTES:
            raise UiCaptureError("short runtime directory path exceeds socket-safe cap")
        if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o777 != 0o700:
            raise UiCaptureError("short runtime directory ownership or mode mismatch")
        marker = path / ".zorya-owned-runtime"
        with marker.open("x", encoding="ascii") as handle:
            handle.write(token)
    except BaseException:
        remove_short_runtime_directory(path, token, require_marker=False)
        raise
    return path, token


def remove_short_runtime_directory(path: Path, token: str, *, require_marker: bool = True) -> None:
    candidate = path.absolute()
    if candidate.parent != Path("/tmp") or not re.fullmatch(r"zui-[A-Za-z0-9_-]{8}", candidate.name):
        raise UiCaptureError(f"refusing to remove non-owned short runtime path: {path}")
    if candidate.is_symlink() or not candidate.is_dir():
        raise UiCaptureError(f"refusing to remove missing or symlink runtime directory: {path}")
    metadata = candidate.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o777 != 0o700:
        raise UiCaptureError(f"refusing to remove runtime directory with changed ownership or mode: {path}")
    marker = candidate / ".zorya-owned-runtime"
    if require_marker:
        if marker.is_symlink() or not marker.is_file() or marker.read_text(encoding="ascii") != token:
            raise UiCaptureError(f"refusing to remove runtime directory without matching owner marker: {path}")
    elif marker.exists() and (marker.is_symlink() or marker.read_text(encoding="ascii") != token):
        raise UiCaptureError(f"refusing to remove runtime directory with mismatched owner marker: {path}")
    shutil.rmtree(candidate)


def deterministic_uuid(label: str) -> str:
    return str(uuid.uuid5(UUID_NAMESPACE, f"{SEED}:{label}"))


def canonical_manifest_bytes(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def write_grayscale_png(path: Path, width: int, height: int, pixel_at: Callable[[int, int], int]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw_rows = bytearray()
    for y in range(height):
        raw_rows.append(0)
        for x in range(width):
            raw_rows.append(pixel_at(x, y) & 0xFF)
    compressed = zlib.compress(bytes(raw_rows), level=9)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    return sha256_bytes(png)


def eog_pixel_factory(slot_key: str) -> Callable[[int, int], int]:
    seed = int(hashlib.sha256(f"{SEED}:{slot_key}:pixels".encode()).hexdigest()[:8], 16)

    def pixel_at(x: int, y: int) -> int:
        return (seed + x * 17 + y * 31 + (x ^ y) * 3) % 256

    return pixel_at


def mkdir_neutral(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=False)


def set_outside_root_pictures_base_for_tests(path: Path | None) -> None:
    global _outside_root_pictures_base_override
    _outside_root_pictures_base_override = path


def outside_root_pictures_base() -> Path:
    if _outside_root_pictures_base_override is not None:
        return _outside_root_pictures_base_override
    return DEFAULT_OUTSIDE_ROOT_PICTURES_BASE


def bundle_outside_root_key(bundle_root: Path) -> str:
    return sha256_bytes(str(bundle_root.resolve()).encode("utf-8"))


def outside_root_pictures_runtime_path(bundle_root: Path, state_id: str) -> Path:
    base_input = outside_root_pictures_base().absolute()
    for component in (base_input, *base_input.parents):
        if component.is_symlink():
            raise UiCaptureError("outside-root pictures path must not cross a symlink")
    base = base_input.resolve()
    if str(base).startswith("/root"):
        raise UiCaptureError("outside-root pictures base must resolve outside /root")
    leaf = base / bundle_outside_root_key(bundle_root) / state_id / "Pictures"
    resolved = leaf.resolve()
    try:
        resolved.relative_to(base)
    except ValueError as error:
        raise UiCaptureError("outside-root pictures path escapes base") from error
    if str(resolved).startswith("/root"):
        raise UiCaptureError("outside-root pictures path must resolve outside /root")
    return resolved


def materialize_outside_root_pictures_tree(bundle_root: Path, state_id: str) -> None:
    target = outside_root_pictures_runtime_path(bundle_root, state_id)
    if target.is_symlink():
        raise UiCaptureError("outside-root pictures tree must not be a symlink")
    if target.exists():
        raise UiCaptureError("outside-root pictures tree already exists")
    for parent in (target, *target.parents):
        if parent == outside_root_pictures_base().resolve():
            break
        if parent.is_symlink():
            raise UiCaptureError("outside-root pictures path crosses a symlink")
    target.mkdir(parents=True, exist_ok=False)


def build_thunar_authored_tree(state_root: Path, recipe: str) -> dict[str, Any]:
    rel: dict[str, Any] = {}
    if recipe == "p1_back_history":
        parent = state_root / "archive"
        child = parent / "work"
        mkdir_neutral(parent)
        mkdir_neutral(child)
        rel["launchInputRelative"] = "archive"
        rel["ctrlLTargetInputRelative"] = "archive/work"
    elif recipe == "p2_open_parent":
        outer = state_root / "level"
        inner = outer / "inner"
        mkdir_neutral(outer)
        mkdir_neutral(inner)
        rel["launchInputRelative"] = "level/inner"
    elif recipe == "p3_home_outside_root":
        raise UiCaptureError("p3 outside-root pictures are materialized separately")
    elif recipe in ("p4_search", "n1_fullscreen_absent"):
        storage = state_root / "storage"
        mkdir_neutral(storage)
        rel["launchInputRelative"] = "storage"
    else:
        raise UiCaptureError(f"unknown thunar recipe: {recipe}")
    return rel


def build_case_row(spec: CaseSpec, bundle_root: Path) -> dict[str, Any]:
    case_id = deterministic_uuid(f"case:{spec.slot_key}")
    state_id = deterministic_uuid(f"state:{spec.slot_key}")
    input_rel = Path("private") / "input-roots" / state_id
    input_root = bundle_root / input_rel
    authored: dict[str, Any] = {}
    if spec.source_group == "thunar":
        assert spec.thunar_recipe
        if spec.thunar_recipe == "p3_home_outside_root":
            materialize_outside_root_pictures_tree(bundle_root, state_id)
            authored = {"launchOutsideRootPictures": True}
        else:
            authored = build_thunar_authored_tree(input_root, spec.thunar_recipe)
    else:
        assert spec.image_size
        width, height = spec.image_size
        frame_path = input_root / NEUTRAL_FRAME_NAME
        digest = write_grayscale_png(frame_path, width, height, eog_pixel_factory(spec.slot_key))
        authored = {
            "frameRelativePath": NEUTRAL_FRAME_NAME,
            "frameSha256": digest,
            "frameWidth": width,
            "frameHeight": height,
        }
    row: dict[str, Any] = {
        "caseId": case_id,
        "sourceStateId": state_id,
        "sourceGroup": spec.source_group,
        "slotKey": spec.slot_key,
        "expectedPresence": spec.expected_presence,
        "targetRole": spec.target.role,
        "targetName": spec.target.name,
        "inputRootRelative": input_rel.as_posix(),
        "authored": authored,
    }
    if spec.source_group == "thunar":
        row["thunarRecipe"] = spec.thunar_recipe
    else:
        row["launchInputRelative"] = NEUTRAL_FRAME_NAME
    return row


def row_uses_outside_root_pictures(row: dict[str, Any]) -> bool:
    if row.get("launchOutsideRootPictures"):
        return True
    authored = row.get("authored")
    return isinstance(authored, dict) and bool(authored.get("launchOutsideRootPictures"))


def resolve_case_launch_path(bundle: Path, row: dict[str, Any]) -> Path:
    if row_uses_outside_root_pictures(row):
        state_id = row.get("sourceStateId")
        if not isinstance(state_id, str):
            raise UiCaptureError("sourceStateId missing for outside-root pictures case")
        return outside_root_pictures_runtime_path(bundle, state_id)
    input_root = (bundle / str(row["inputRootRelative"])).resolve()
    rel = row.get("launchInputRelative")
    if not isinstance(rel, str):
        authored = row.get("authored")
        if isinstance(authored, dict) and isinstance(authored.get("launchInputRelative"), str):
            rel = authored["launchInputRelative"]
        else:
            raise UiCaptureError("launch path metadata missing")
    launch = (input_root / rel).resolve()
    try:
        launch.relative_to(input_root)
    except ValueError as error:
        raise UiCaptureError("launch path escapes input root") from error
    return launch


def resolve_ctrl_l_target(bundle: Path, row: dict[str, Any]) -> Path | None:
    authored = row.get("authored")
    if not isinstance(authored, dict):
        return None
    rel = authored.get("ctrlLTargetInputRelative")
    if not isinstance(rel, str):
        return None
    input_root = (bundle / str(row["inputRootRelative"])).resolve()
    target = (input_root / rel).resolve()
    try:
        target.relative_to(input_root)
    except ValueError as error:
        raise UiCaptureError("ctrl-l target escapes input root") from error
    return target


def build_state_manifest(bundle_root: Path) -> dict[str, Any]:
    rows = [build_case_row(spec, bundle_root) for spec in CASE_SPECS]
    present = sum(1 for row in rows if row["expectedPresence"] == "present")
    absent = len(rows) - present
    thunar_rows = [row for row in rows if row["sourceGroup"] == "thunar"]
    eog_rows = [row for row in rows if row["sourceGroup"] == "eog"]
    manifest: dict[str, Any] = {
        "schemaVersion": STATE_MANIFEST_SCHEMA,
        "seed": SEED,
        "status": "prepared",
        "viewport": {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
        "quotas": {
            "totalCases": len(rows),
            "present": present,
            "absent": absent,
            "thunar": {"present": 4, "absent": 1},
            "eog": {"present": 3, "absent": 2},
        },
        "locale": "C.UTF-8",
        "gtkTheme": "Adwaita",
        "apps": {
            "thunar": {"binary": str(THUNAR_BINARY), "package": THUNAR_PKG[0], "version": THUNAR_PKG[1]},
            "eog": {"binary": str(EOG_BINARY), "package": EOG_PKG[0], "version": EOG_PKG[1]},
        },
        "rows": rows,
    }
    if len(thunar_rows) != 5 or len(eog_rows) != 5:
        raise UiCaptureError("case roster size mismatch")
    return manifest


def validate_quota_manifest(manifest: dict[str, Any]) -> None:
    rows = manifest.get("rows")
    if not isinstance(rows, list) or len(rows) != 10:
        raise UiCaptureError("state manifest must contain exactly 10 rows")
    counts: dict[str, dict[str, int]] = {
        "thunar": {"present": 0, "absent": 0},
        "eog": {"present": 0, "absent": 0},
    }
    case_ids: set[str] = set()
    state_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise UiCaptureError("invalid manifest row")
        case_id = row.get("caseId")
        state_id = row.get("sourceStateId")
        if not isinstance(case_id, str) or not isinstance(state_id, str):
            raise UiCaptureError("case/state id missing")
        if case_id in case_ids or state_id in state_ids:
            raise UiCaptureError("duplicate case or state id")
        case_ids.add(case_id)
        state_ids.add(state_id)
        group = row.get("sourceGroup")
        presence = row.get("expectedPresence")
        if group not in counts or presence not in ("present", "absent"):
            raise UiCaptureError("invalid group or presence")
        counts[group][presence] += 1
    if counts["thunar"] != {"present": 4, "absent": 1}:
        raise UiCaptureError("thunar quota mismatch")
    if counts["eog"] != {"present": 3, "absent": 2}:
        raise UiCaptureError("eog quota mismatch")


def load_frozen_state_manifest(bundle_root: Path) -> tuple[dict[str, Any], str]:
    manifest_path = bundle_root / "private" / "state-manifest.json"
    raw = manifest_path.read_bytes()
    digest = sha256_bytes(raw)
    sidecar = bundle_root / "private" / "state-manifest.sha256"
    if sidecar.is_file():
        pinned = sidecar.read_text(encoding="utf-8").strip()
        if pinned != digest:
            raise UiCaptureError("state manifest bytes do not match sidecar sha256")
    payload = json.loads(raw.decode("utf-8"))
    if payload.get("schemaVersion") != STATE_MANIFEST_SCHEMA:
        raise UiCaptureError("state manifest schema mismatch")
    validate_quota_manifest(payload)
    return payload, digest


def verify_manifest_authored_files(bundle_root: Path, manifest: dict[str, Any]) -> None:
    for row in manifest["rows"]:
        input_rel = row.get("inputRootRelative")
        if not isinstance(input_rel, str):
            raise UiCaptureError("inputRootRelative missing")
        input_root = (bundle_root / input_rel).resolve()
        try:
            input_root.relative_to(bundle_root.resolve())
        except ValueError as error:
            raise UiCaptureError("input root escapes bundle") from error
        authored = row.get("authored")
        if not isinstance(authored, dict):
            raise UiCaptureError("authored metadata missing")
        if row["sourceGroup"] == "eog":
            frame_rel = authored.get("frameRelativePath")
            expected_sha = authored.get("frameSha256")
            if frame_rel != NEUTRAL_FRAME_NAME or not isinstance(expected_sha, str):
                raise UiCaptureError("eog frame metadata invalid")
            frame_path = input_root / frame_rel
            if sha256_file(frame_path) != expected_sha:
                raise UiCaptureError("eog frame sha256 mismatch")


def set_dpkg_query_runner_for_tests(runner: DpkgQueryRunner | None) -> None:
    global _dpkg_query_runner_override
    _dpkg_query_runner_override = runner


def run_dpkg_query(argv: Sequence[str]) -> subprocess.CompletedProcess[str]:
    if _dpkg_query_runner_override is not None:
        return _dpkg_query_runner_override(argv)
    return subprocess.run(
        list(argv),
        check=False,
        capture_output=True,
        text=True,
    )


def parse_dpkg_search_line(line: str) -> str:
    stripped = line.strip()
    if not stripped or ": " not in stripped:
        raise UiCaptureError(f"malformed dpkg-query -S output: {line!r}")
    package_field = stripped.split(": ", 1)[0].strip()
    if not package_field:
        raise UiCaptureError(f"malformed dpkg-query -S output: {line!r}")
    return package_field.split(":")[0]


def dpkg_file_owner_version(path: Path) -> tuple[str, str]:
    search = run_dpkg_query(["dpkg-query", "-S", str(path)])
    if search.returncode != 0:
        raise UiCaptureError(f"dpkg-query -S failed for {path}: {search.stderr.strip()}")
    owners: list[str] = []
    for line in search.stdout.splitlines():
        if not line.strip():
            continue
        owners.append(parse_dpkg_search_line(line))
    unique = sorted(set(owners))
    if len(unique) == 0:
        raise UiCaptureError(f"dpkg-query -S returned no owner for {path}")
    if len(unique) > 1:
        raise UiCaptureError(f"dpkg-query -S returned ambiguous owners for {path}: {unique}")
    package = unique[0]
    version_proc = run_dpkg_query(["dpkg-query", "-W", "-f=${Version}\n", package])
    if version_proc.returncode != 0:
        raise UiCaptureError(f"dpkg-query -W failed for {package}: {version_proc.stderr.strip()}")
    version = version_proc.stdout.strip()
    if not version or "\n" in version:
        raise UiCaptureError(f"unexpected dpkg-query -W output for {package}")
    return package, version


def read_copyright_file(package: str) -> tuple[str, str]:
    copyright_path = Path("/usr/share/doc") / package / "copyright"
    if not copyright_path.is_file():
        raise UiCaptureError(f"copyright file missing for package {package}")
    raw = copyright_path.read_bytes()
    return sha256_bytes(raw), raw.decode("utf-8", errors="replace")


def debian_copyright_path_key(path: Path) -> str:
    if path.is_absolute():
        resolved = str(path.resolve())
        return resolved[1:] if resolved.startswith("/") else resolved
    if ".." in path.parts:
        raise UiCaptureError("copyright source path must not traverse parents")
    return path.as_posix().lstrip("/")


def split_debian_files_patterns(files_value: str) -> list[str]:
    patterns: list[str] = []
    for part in re.split(r",\s*", files_value.replace("\n", " ").strip()):
        token = part.strip()
        if token:
            patterns.append(token)
    return patterns


def debian_files_pattern_matches(pattern: str, file_path: Path) -> bool:
    key = debian_copyright_path_key(file_path)
    normalized = pattern.strip()
    if not normalized or normalized == "*":
        return True
    if normalized.startswith("/"):
        normalized = normalized.lstrip("/")
    return fnmatch.fnmatchcase(key, normalized)


def parse_debian_copyright_stanzas(copyright_text: str) -> list[dict[str, str]]:
    stanzas: list[dict[str, str]] = []
    current: dict[str, str] = {}
    current_field: str | None = None

    def flush() -> None:
        nonlocal current
        if current:
            stanzas.append(current)
        current = {}

    for line in copyright_text.splitlines():
        if not line.strip():
            flush()
            current_field = None
            continue
        if line.startswith(" ") and current_field is not None:
            current[current_field] = current.get(current_field, "") + "\n" + line.strip()
            continue
        if ":" not in line:
            flush()
            current_field = None
            continue
        field, value = line.split(":", 1)
        field_key = field.strip().lower()
        current[field_key] = value.strip()
        current_field = field_key
    flush()
    return stanzas


def debian_files_pattern_specificity(pattern: str) -> int:
    normalized = pattern.strip()
    if normalized in ("", "*"):
        return 0
    return len(normalized.replace("*", ""))


def license_for_debian_copyright_file(copyright_text: str, file_path: Path) -> str:
    return debian_copyright_entry_for_file(copyright_text, file_path)["license"]


def debian_copyright_entry_for_file(copyright_text: str, file_path: Path) -> dict[str, str]:
    matches: list[tuple[int, str, str]] = []
    for stanza in parse_debian_copyright_stanzas(copyright_text):
        files_value = stanza.get("files")
        license_value = stanza.get("license")
        if not files_value or not license_value:
            continue
        for pattern in split_debian_files_patterns(files_value):
            if debian_files_pattern_matches(pattern, file_path):
                license_expression = license_value.strip().splitlines()[0]
                matches.append(
                    (debian_files_pattern_specificity(pattern), pattern, license_expression)
                )
                break
    if not matches:
        raise UiCaptureError(f"no debian copyright stanza matches file {file_path}")
    best_specificity = max(item[0] for item in matches)
    best = [item for item in matches if item[0] == best_specificity]
    unique_licenses = {item[2] for item in best}
    if len(unique_licenses) > 1:
        raise UiCaptureError(f"ambiguous debian copyright stanzas for file {file_path}")
    return {"filesPattern": best[0][1], "license": best[0][2]}


def verify_pinned_file(
    path: Path,
    expected_sha: str,
    package_version: tuple[str, str],
    *,
    source_path: str | None = None,
) -> dict[str, Any]:
    if not path.is_file():
        raise UiCaptureError(f"pinned resource missing: {path}")
    digest = sha256_file(path)
    if digest != expected_sha:
        raise UiCaptureError(f"pinned resource sha256 mismatch for {path}")
    package, version = dpkg_file_owner_version(path)
    expected_pkg, expected_ver = package_version
    if package != expected_pkg or version != expected_ver:
        raise UiCaptureError(
            f"pinned package/version mismatch for {path}: {package} {version} != {expected_pkg} {expected_ver}"
        )
    copyright_sha, copyright_text = read_copyright_file(package)
    receipt: dict[str, Any] = {
        "path": str(path),
        "sha256": digest,
        "package": package,
        "version": version,
        "copyrightSha256": copyright_sha,
    }
    if source_path is not None:
        relative = Path(source_path)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise UiCaptureError(f"invalid package source path mapping for {path}")
        evidence = debian_copyright_entry_for_file(copyright_text, relative)
        receipt.update(
            {
                "debianSourcePath": relative.as_posix(),
                "matchedFilesPattern": evidence["filesPattern"],
                "licenseExpression": evidence["license"],
            }
        )
    return receipt


def verify_pinned_resources() -> dict[str, Any]:
    receipts: dict[str, Any] = {
        "gtk3So": verify_pinned_file(PINNED_GTK3_SO, PINNED_GTK3_SO_SHA, PINNED_GTK3_PKG),
        "dejavuSans": verify_pinned_file(
            PINNED_DEJAVU,
            PINNED_DEJAVU_SHA,
            PINNED_DEJAVU_PKG,
            source_path="ttf/DejaVuSans.ttf",
        ),
        "openboxClearlooks": verify_pinned_file(
            PINNED_OPENBOX_THEME,
            PINNED_OPENBOX_THEME_SHA,
            PINNED_OPENBOX_PKG,
            source_path="data/themes/Clearlooks/openbox-3/themerc",
        ),
        "openboxRcXml": verify_pinned_file(PINNED_OPENBOX_RC, PINNED_OPENBOX_RC_SHA, ("openbox", "3.6.1-12build5")),
        "icons": {},
        "apps": {},
    }
    for name, icon_path in PINNED_ICON_FILES.items():
        if not icon_path.is_file():
            raise UiCaptureError(f"pinned icon missing: {icon_path}")
        package, version = dpkg_file_owner_version(icon_path)
        expected_pkg, expected_ver = PINNED_ADWAITA_ICONS_PKG
        if package != expected_pkg or version != expected_ver:
            raise UiCaptureError(f"adwaita icon package mismatch for {icon_path}")
        copyright_sha, copyright_text = read_copyright_file(package)
        icon_receipt = verify_pinned_file(
            icon_path,
            sha256_file(icon_path),
            PINNED_ADWAITA_ICONS_PKG,
            source_path=f"src/symbolic/actions/{icon_path.name}",
        )
        if icon_receipt["copyrightSha256"] != copyright_sha:
            raise UiCaptureError(f"copyright snapshot changed while auditing {icon_path}")
        receipts["icons"][name] = icon_receipt
    for label, binary, pkg in (
        ("thunar", THUNAR_BINARY, THUNAR_PKG),
        ("eog", EOG_BINARY, EOG_PKG),
    ):
        if not binary.is_file():
            raise UiCaptureError(f"app binary missing: {binary}")
        package, version = dpkg_file_owner_version(binary)
        if package != pkg[0] or version != pkg[1]:
            raise UiCaptureError(f"app package mismatch for {binary}")
        copyright_sha, _ = read_copyright_file(package)
        receipts["apps"][label] = {
            "path": str(binary),
            "sha256": sha256_file(binary),
            "package": package,
            "version": version,
            "copyrightSha256": copyright_sha,
        }
    return receipts


def normalize_role(role: str) -> str:
    return " ".join(role.strip().lower().split())


def normalize_name(name: str) -> str:
    return " ".join(name.strip().split())


def extents_positive(ext: dict[str, int]) -> bool:
    return ext["width"] > 0 and ext["height"] > 0


def extents_inside_frame(ext: dict[str, int], frame: dict[str, int]) -> bool:
    left = ext["x"]
    top = ext["y"]
    right = ext["x"] + ext["width"]
    bottom = ext["y"] + ext["height"]
    fx, fy = frame["x"], frame["y"]
    fw, fh = frame["width"], frame["height"]
    return left >= fx and top >= fy and right <= fx + fw and bottom <= fy + fh


def inventory_node_matches_target(node: dict[str, Any], target: TargetSpec) -> bool:
    if not node.get("showing") or not node.get("visible"):
        return False
    if normalize_role(str(node.get("role", ""))) != normalize_role(target.role):
        return False
    return normalize_name(str(node.get("name", ""))) == normalize_name(target.name)


def collect_target_matches(
    nodes: list[dict[str, Any]], target: TargetSpec, *, app_frame: dict[str, int] | None
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for node in nodes:
        if not inventory_node_matches_target(node, target):
            continue
        ext = node.get("extents")
        if not isinstance(ext, dict):
            continue
        if not extents_positive(ext):
            continue
        if app_frame is not None and not extents_inside_frame(ext, app_frame):
            continue
        matches.append(node)
    return matches


def evaluate_case_oracle(
    *,
    inventory: dict[str, Any],
    expected_presence: str,
    target_role: str,
    target_name: str,
) -> dict[str, Any]:
    if inventory.get("traversalErrors"):
        raise UiCaptureError("inventory traversal errors present")
    if not inventory.get("complete"):
        raise UiCaptureError("inventory incomplete")
    nodes = inventory.get("nodes")
    if not isinstance(nodes, list):
        raise UiCaptureError("inventory nodes missing")
    if "applicationMatchCount" in inventory and inventory.get("applicationMatchCount") != 1:
        raise UiCaptureError("inventory must contain exactly one expected application")
    if "frameCandidates" in inventory:
        frame_candidates = inventory.get("frameCandidates")
        if not isinstance(frame_candidates, list) or len(frame_candidates) != 1:
            raise UiCaptureError("inventory must contain exactly one visible application frame")
    frame = inventory.get("appFrameExtents")
    if not isinstance(frame, dict):
        raise UiCaptureError("app frame extents missing")
    target = TargetSpec(target_role, target_name)
    matches = collect_target_matches(nodes, target, app_frame=frame)
    result = {
        "matchCount": len(matches),
        "matches": matches,
        "appFrameExtents": frame,
        "viewport": inventory.get("viewport"),
    }
    if expected_presence == "present":
        if len(matches) != 1:
            raise UiCaptureError(f"expected exactly one target match, got {len(matches)}")
    elif expected_presence == "absent":
        if len(matches) != 0:
            raise UiCaptureError(f"expected zero target matches, got {len(matches)}")
    else:
        raise UiCaptureError("invalid expectedPresence")
    return result


def cmd_prepare(args: argparse.Namespace) -> int:
    output_dir = require_external_new_directory(Path(args.output_dir), "prepare output directory")
    output_dir.mkdir(parents=True, exist_ok=False)
    private = output_dir / "private"
    private.mkdir(parents=True, exist_ok=True)
    manifest = build_state_manifest(output_dir)
    validate_quota_manifest(manifest)
    manifest_bytes = canonical_manifest_bytes(manifest)
    manifest_path = private / "state-manifest.json"
    manifest_path.write_bytes(manifest_bytes)
    digest = sha256_bytes(manifest_bytes)
    (private / "state-manifest.sha256").write_text(digest + "\n", encoding="utf-8")
    loaded, loaded_digest = load_frozen_state_manifest(output_dir)
    if loaded_digest != digest:
        raise UiCaptureError("manifest hash mismatch after write")
    verify_manifest_authored_files(output_dir, loaded)
    summary = {
        "schemaVersion": STATE_MANIFEST_SCHEMA,
        "outputDir": str(output_dir),
        "stateManifestSha256": digest,
        "caseCount": len(loaded["rows"]),
    }
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")
    return 0


class ProcessGroupRunner:
    def __init__(self, command: list[str], *, env: dict[str, str], cwd: Path) -> None:
        self.command = command
        self.env = env
        self.cwd = cwd
        self.proc: subprocess.Popen[bytes] | None = None
        self.stdout = b""
        self.stderr = b""
        self.stdout_total_bytes = 0
        self.stderr_total_bytes = 0
        self._threads: list[threading.Thread] = []
        self._tails: dict[str, bytearray] = {"stdout": bytearray(), "stderr": bytearray()}

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.command,
            cwd=str(self.cwd),
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        assert self.proc.stdout and self.proc.stderr

        def drain(stream: Any, attr: str) -> None:
            tail = self._tails[attr]
            while True:
                block = stream.read(4096)
                if not block:
                    break
                if attr == "stdout":
                    self.stdout_total_bytes += len(block)
                else:
                    self.stderr_total_bytes += len(block)
                tail.extend(block)
                if len(tail) > MAX_LOG_BYTES:
                    del tail[: len(tail) - MAX_LOG_BYTES]

        for stream, attr in ((self.proc.stdout, "stdout"), (self.proc.stderr, "stderr")):
            thread = threading.Thread(target=drain, args=(stream, attr))
            thread.start()
            self._threads.append(thread)

    def wait(self, timeout: float) -> int:
        if self.proc is None:
            raise UiCaptureError("process not started")
        timed_out = False
        reader_leak = False
        try:
            return_code = self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            self._signal_owned_group(signal.SIGTERM)
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._signal_owned_group(signal.SIGKILL)
                self.proc.wait()
            return_code = self.proc.returncode
        finally:
            if self.proc.poll() is None:
                self._signal_owned_group(signal.SIGTERM)
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._signal_owned_group(signal.SIGKILL)
                    self.proc.wait()
            for thread in self._threads:
                thread.join(timeout=0.25)
            if any(thread.is_alive() for thread in self._threads):
                reader_leak = not timed_out
                self._signal_owned_group(signal.SIGTERM)
                for thread in self._threads:
                    thread.join(timeout=2)
                if any(thread.is_alive() for thread in self._threads):
                    self._signal_owned_group(signal.SIGKILL)
                for thread in self._threads:
                    thread.join()
            for name, tail in self._tails.items():
                setattr(self, name, bytes(tail))
            if self.proc.stdout is not None:
                self.proc.stdout.close()
            if self.proc.stderr is not None:
                self.proc.stderr.close()
            if self.proc.poll() is None or any(thread.is_alive() for thread in self._threads):
                raise UiCaptureError("owned process tree or output reader failed to close")
        if timed_out:
            raise UiCaptureError("case exceeded time limit")
        if reader_leak:
            raise UiCaptureError("owned descendants kept output streams open after leader exit")
        assert return_code is not None
        return return_code

    def _signal_owned_group(self, signum: int) -> None:
        if self.proc is None:
            return
        try:
            os.killpg(self.proc.pid, signum)
        except ProcessLookupError:
            return


def worker_entry(argv: list[str]) -> int:
    if not argv:
        raise UiCaptureError("worker mode requires subcommand")
    mode = argv[0]
    if mode == "preflight-case":
        return _worker_preflight_case(argv[1:])
    if mode == "capture-case":
        return _worker_capture_case(argv[1:])
    raise UiCaptureError(f"unknown worker mode: {mode}")


def _parse_worker_args(argv: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        if token.startswith("--") and index + 1 < len(argv):
            out[token[2:]] = argv[index + 1]
            index += 2
        else:
            index += 1
    return out


def _worker_preflight_case(argv: list[str]) -> int:
    args = _parse_worker_args(argv)
    bundle = Path(args["bundle"]).resolve()
    case_id = args["case-id"]
    manifest, _ = load_frozen_state_manifest(bundle)
    row = next(item for item in manifest["rows"] if item["caseId"] == case_id)
    receipt = _run_live_case(bundle, manifest, row, phase="preflight", screenshot_path=None)
    out_path = bundle / "private" / "preflight" / "cases" / f"{case_id}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    return 0


def _worker_capture_case(argv: list[str]) -> int:
    args = _parse_worker_args(argv)
    bundle = Path(args["bundle"]).resolve()
    case_id = args["case-id"]
    approved = args.get("approved-manifest-sha256")
    approved_preflight = args.get("preflight-summary-sha256")
    if not approved or not SHA256_HEX.match(approved):
        raise UiCaptureError("approved manifest sha256 required")
    if not approved_preflight or not SHA256_HEX.match(approved_preflight):
        raise UiCaptureError("approved preflight summary sha256 required")
    manifest, digest = load_frozen_state_manifest(bundle)
    if digest != approved:
        raise UiCaptureError("approved manifest sha256 mismatch")
    _, preflight_digest = load_validated_preflight_summary(
        bundle,
        manifest,
        state_manifest_sha256=digest,
        expected_summary_sha256=approved_preflight,
    )
    row = next(item for item in manifest["rows"] if item["caseId"] == case_id)
    screenshot_rel = Path("private") / "screenshots" / f"{case_id}.png"
    screenshot_path = bundle / screenshot_rel
    receipt = _run_live_case(bundle, manifest, row, phase="capture", screenshot_path=screenshot_path)
    receipt["preflightSummarySha256"] = preflight_digest
    receipt["screenshotRelative"] = screenshot_rel.as_posix()
    out_path = bundle / "private" / "capture" / "cases" / f"{case_id}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    return 0


def _run_live_case(
    bundle: Path,
    manifest: dict[str, Any],
    row: dict[str, Any],
    *,
    phase: str,
    screenshot_path: Path | None,
) -> dict[str, Any]:
    case_id = row["caseId"]
    if phase not in {"preflight", "capture"}:
        raise UiCaptureError("invalid live case phase")
    case_private = bundle / "private" / "runtime" / phase / case_id
    case_private.mkdir(mode=0o700, parents=True, exist_ok=False)
    app_profile = create_private_ui_profile(bundle, phase, "app", case_id)
    short_runtime_dir, ownership_marker = create_short_runtime_directory()
    neutral_root = short_runtime_dir / "n"
    neutral_root.mkdir(mode=0o700)
    env = build_ui_process_environment(app_profile, runtime_dir=short_runtime_dir)

    try:
        display_file = case_private / "xvfb-display-number"
        if display_file.is_symlink():
            raise UiCaptureError("Xvfb display-number file must not be a symlink")
        display_file.unlink(missing_ok=True)
        worker_argv = [
            sys.executable,
            str(_HERE / "ui_capture.py"),
            "_worker-inner",
            case_id,
            str(bundle),
            str(screenshot_path) if screenshot_path else "",
        ]
        session_script = case_private / "session.sh"
        with session_script.open("x", encoding="utf-8") as handle:
            handle.write(
                build_owned_session_wrapper_script(
                    display_file=display_file,
                    worker_argv=worker_argv,
                    neutral_root=neutral_root,
                )
            )
        session_script.chmod(0o700)

        command = [
            "unshare",
            "--pid",
            "--mount",
            "--fork",
            "--kill-child",
            "--mount-proc",
            "--",
            "dbus-run-session",
            "--",
            "sh",
            str(session_script),
        ]
        runner = ProcessGroupRunner(command, env=env, cwd=bundle)
        runner.start()
        exit_code = runner.wait(MAX_CASE_SECONDS)
    finally:
        remove_short_runtime_directory(short_runtime_dir, ownership_marker)
    if exit_code != 0:
        inner_failure_path = _write_inner_case_failure(
                bundle,
                phase,
                case_id,
                exit_code=exit_code,
                runner=runner,
            )
        suffix = f"; bounded inner output saved to {inner_failure_path}"
        raise UiCaptureError(f"case worker failed with exit code {exit_code}{suffix}")

    receipt_path = case_private / "case-receipt.json"
    if not receipt_path.is_file():
        raise UiCaptureError("case receipt missing after worker")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt["process"] = {"exitCode": exit_code, "stdoutBytes": len(runner.stdout), "stderrBytes": len(runner.stderr)}
    return receipt


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def build_owned_session_wrapper_script(
    *,
    display_file: Path,
    worker_argv: list[str],
    neutral_root: Path | None = None,
) -> str:
    quoted_worker = " ".join(sh_quote(value) for value in worker_argv)
    lines = [
        "#!/bin/sh",
        "set -eu",
        "XVFB_PID=",
        "OPENBOX_PID=",
        "WORKER_PID=",
        "WORKER_STATUS=0",
        "cleanup() {",
        "  WORKER_STATUS=$?",
        "  trap - EXIT",
        "  trap '' INT TERM HUP",
        '  for pid in "$WORKER_PID" "$OPENBOX_PID" "$XVFB_PID"; do',
        '    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi',
        "  done",
        '  for pid in "$WORKER_PID" "$OPENBOX_PID" "$XVFB_PID"; do',
        '    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi',
        "  done",
        '  exit "$WORKER_STATUS"',
        "}",
        "trap cleanup EXIT",
        "trap 'exit 130' INT",
        "trap 'exit 143' TERM",
        "trap 'exit 129' HUP",
    ]
    if neutral_root is not None:
        lines.extend(
            [
                "mount --make-rprivate /",
                f"mount -t tmpfs -o size=32m,mode=700,nosuid,nodev tmpfs {sh_quote(str(neutral_root))}",
            ]
        )
    lines.extend(
        [
            f"Xvfb -displayfd 3 -screen 0 {VIEWPORT_WIDTH}x{VIEWPORT_HEIGHT}x24 -noreset -nolisten tcp 3>{sh_quote(str(display_file))} &",
            "XVFB_PID=$!",
            "DISPLAY_NUMBER=",
            "DISPLAY_ATTEMPT=0",
            "while [ \"$DISPLAY_ATTEMPT\" -lt 50 ]; do",
            f"  if [ -s {sh_quote(str(display_file))} ]; then DISPLAY_NUMBER=$(cat {sh_quote(str(display_file))}); break; fi",
            '  if ! kill -0 "$XVFB_PID" 2>/dev/null; then wait "$XVFB_PID" || true; XVFB_PID=; echo "Xvfb exited before display startup" >&2; exit 1; fi',
            "  DISPLAY_ATTEMPT=$((DISPLAY_ATTEMPT + 1))",
            "  sleep 0.1",
            "done",
            'case "$DISPLAY_NUMBER" in ""|*[!0-9]*) echo "invalid Xvfb display number" >&2; exit 1 ;; esac',
            'DISPLAY=":$DISPLAY_NUMBER"; export DISPLAY',
            "openbox &",
            "OPENBOX_PID=$!",
            "sleep 0.2",
            'if ! kill -0 "$OPENBOX_PID" 2>/dev/null; then wait "$OPENBOX_PID" || true; OPENBOX_PID=; echo "Openbox exited during startup" >&2; exit 1; fi',
            f"{quoted_worker} &",
            "WORKER_PID=$!",
            'if wait "$WORKER_PID"; then WORKER_STATUS=0; else WORKER_STATUS=$?; fi',
            "WORKER_PID=",
            'exit "$WORKER_STATUS"',
        ]
    )
    return "\n".join(lines) + "\n"


def _worker_inner(case_id: str, bundle_s: str, screenshot_s: str) -> int:
    bundle = Path(bundle_s)
    manifest, _ = load_frozen_state_manifest(bundle)
    row = next(item for item in manifest["rows"] if item["caseId"] == case_id)
    screenshot_path = Path(screenshot_s) if screenshot_s else None
    phase = "preflight" if screenshot_path is None else "capture"
    receipt = _interactive_case(bundle, manifest, row, phase=phase, screenshot_path=screenshot_path)
    out = bundle / "private" / "runtime" / phase / case_id / "case-receipt.json"
    with out.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    return 0


def _interactive_case(
    bundle: Path,
    manifest: dict[str, Any],
    row: dict[str, Any],
    *,
    phase: str,
    screenshot_path: Path | None,
) -> dict[str, Any]:
    import pyatspi  # noqa: PLC0415

    _apply_gsettings()
    resource_receipts = verify_pinned_resources()
    icon_receipts = _resolve_gtk_icons(resource_receipts["icons"])
    neutral_root_value = os.environ.get("ZORYA_UI_NEUTRAL_ROOT")
    if not neutral_root_value:
        raise UiCaptureError("private neutral tmpfs path missing from app environment")
    neutral_root = Path(neutral_root_value)
    if neutral_root.is_symlink() or not _is_private_tmpfs_mount(neutral_root):
        raise UiCaptureError("private neutral input path is not an owned mount")
    neutral_launch_path = copy_neutral_case_input(bundle, row, neutral_root)
    app_proc = _launch_app_for_row(row, neutral_launch_path)
    try:
        pre_inventory = _wait_for_atspi_inventory(
            bundle,
            row,
            phase=phase,
            require_target=row["sourceGroup"] != "thunar",
        )
        if row["sourceGroup"] == "thunar":
            _drive_thunar(row, neutral_launch_path, neutral_root)
            pre_inventory = _wait_for_atspi_inventory(bundle, row, phase=phase, require_target=True)
        pre_oracle = evaluate_case_oracle(
            inventory=pre_inventory,
            expected_presence=row["expectedPresence"],
            target_role=row["targetRole"],
            target_name=row["targetName"],
        )
        post_inventory = pre_inventory
        screenshot_meta: dict[str, Any] | None = None
        if screenshot_path is not None:
            from PIL import ImageGrab  # noqa: PLC0415

            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            image = ImageGrab.grab(bbox=(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT))
            if image.size != (VIEWPORT_WIDTH, VIEWPORT_HEIGHT):
                raise UiCaptureError("screenshot dimensions invalid")
            png_buffer = io.BytesIO()
            image.save(png_buffer, format="PNG")
            screenshot_bytes = png_buffer.getvalue()
            if len(screenshot_bytes) > MAX_SCREENSHOT_BYTES:
                raise UiCaptureError("screenshot exceeds byte cap")
            try:
                with screenshot_path.open("xb") as handle:
                    handle.write(screenshot_bytes)
            except FileExistsError as error:
                raise UiCaptureError("capture screenshot already exists; use a new bundle") from error
            screenshot_meta = {
                "path": str(screenshot_path),
                "sha256": sha256_bytes(screenshot_bytes),
                "width": image.size[0],
                "height": image.size[1],
            }
            post_inventory = _wait_for_atspi_inventory(bundle, row, phase=phase, require_target=True)
            if _visible_inventory_signature(pre_inventory) != _visible_inventory_signature(post_inventory):
                failure_path = _write_capture_inventory_failure(
                    bundle,
                    row["caseId"],
                    reason="visible AT-SPI inventory changed across screenshot capture",
                    before=pre_inventory,
                    after=post_inventory,
                )
                raise UiCaptureError(f"visible AT-SPI inventory changed across capture; evidence saved to {failure_path}")
        post_oracle = evaluate_case_oracle(
            inventory=post_inventory,
            expected_presence=row["expectedPresence"],
            target_role=row["targetRole"],
            target_name=row["targetName"],
        )
    finally:
        _terminate_process_tree(app_proc)
    return {
        "schemaVersion": PREFLIGHT_RECEIPT_SCHEMA if screenshot_path is None else CAPTURE_RECEIPT_SCHEMA,
        "caseId": row["caseId"],
        "sourceStateId": row["sourceStateId"],
        "preInventory": pre_inventory,
        "postInventory": post_inventory,
        "preOracle": pre_oracle,
        "postOracle": post_oracle,
        "resourceReceipts": resource_receipts,
        "iconResolutionReceipts": icon_receipts,
        "screenshot": screenshot_meta,
        "viewport": {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
    }


def _apply_gsettings() -> None:
    env = os.environ.copy()
    commands = [
        ["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", "Adwaita"],
        ["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", "Adwaita"],
        ["gsettings", "set", "org.gnome.desktop.interface", "font-name", "DejaVu Sans 11"],
    ]
    for cmd in commands:
        subprocess.run(cmd, check=True, env=env, capture_output=True)


def _resolve_gtk_icons(pinned_icons: dict[str, Any]) -> dict[str, Any]:
    import gi  # noqa: PLC0415

    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk  # noqa: PLC0415

    theme = Gtk.IconTheme.get_default()
    mapping = {
        "go-previous": "go-previous-symbolic",
        "go-up": "go-up-symbolic",
        "go-home": "go-home-symbolic",
        "system-search": "system-search-symbolic",
        "zoom-in": "zoom-in-symbolic",
        "zoom-out": "zoom-out-symbolic",
        "view-fullscreen": "view-fullscreen-symbolic",
    }
    out: dict[str, Any] = {}
    for key, icon_name in mapping.items():
        info = theme.lookup_icon(icon_name, 16, Gtk.IconLookupFlags.FORCE_SYMBOLIC)
        if info is None:
            raise UiCaptureError(f"gtk failed to resolve icon {icon_name}")
        path = Path(info.get_filename())
        expected = Path(pinned_icons[key]["path"])
        if path.resolve() != expected.resolve():
            raise UiCaptureError(f"resolved icon path mismatch for {icon_name}: {path} != {expected}")
        out[key] = {"iconName": icon_name, "resolvedPath": str(path), "sha256": sha256_file(path)}
    return out


def _launch_app_for_row(row: dict[str, Any], neutral_launch_path: Path) -> subprocess.Popen[bytes]:
    launch = str(neutral_launch_path)
    if row["sourceGroup"] == "thunar":
        cmd = [str(THUNAR_BINARY), launch]
    else:
        cmd = [str(EOG_BINARY), launch]
    proc = subprocess.Popen(cmd)
    return proc


def _drive_thunar(row: dict[str, Any], neutral_launch_path: Path, neutral_root: Path) -> None:
    recipe = row.get("thunarRecipe")
    if recipe == "p1_back_history":
        authored = row.get("authored")
        relative = authored.get("ctrlLTargetInputRelative") if isinstance(authored, dict) else None
        if not isinstance(relative, str):
            raise UiCaptureError("Thunar history target relative path missing")
        neutral_root_path = neutral_root / "roots"
        child = _safe_neutral_child(neutral_root_path, relative, "Thunar Ctrl+L target")
        if neutral_launch_path == child:
            raise UiCaptureError("Thunar history launch and Ctrl+L target unexpectedly match")
        _xdotool(["key", "ctrl+l"])
        time.sleep(0.2)
        _xdotool(["type", str(child)])
        _xdotool(["key", "Return"])
        time.sleep(0.8)


def _xdotool(args: list[str]) -> None:
    subprocess.run(["xdotool"] + args, check=True, capture_output=True)


def _wait_for_atspi_inventory(
    bundle: Path,
    row: dict[str, Any],
    *,
    phase: str,
    require_target: bool,
) -> dict[str, Any]:
    deadline = time.monotonic() + AT_SPI_READY_SECONDS
    last_inventory: dict[str, Any] = {
        "complete": False,
        "traversalErrors": ["AT-SPI inventory not yet observed"],
        "applicationNames": [],
        "expectedApplicationName": row.get("sourceGroup"),
        "applicationMatchCount": 0,
        "frameCandidates": [],
        "nodes": [],
        "appFrameExtents": None,
        "viewport": {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
    }
    previous_signature: str | None = None
    stable_polls = 0
    last_reason = "AT-SPI registration did not become ready"

    while True:
        try:
            inventory = _collect_atspi_inventory(row)
        except Exception as error:  # noqa: BLE001
            inventory = dict(last_inventory)
            inventory["traversalErrors"] = [f"AT-SPI collector: {type(error).__name__}"]
            inventory["complete"] = False
        last_inventory = inventory
        reason = _atspi_inventory_readiness_error(
            inventory,
            row,
            require_target=require_target,
        )
        if reason is None:
            signature = sha256_bytes(
                _visible_inventory_signature(inventory)
            )
            stable_polls = stable_polls + 1 if signature == previous_signature else 1
            previous_signature = signature
            if stable_polls >= 2:
                return inventory
            last_reason = "AT-SPI inventory has not stabilized"
        else:
            previous_signature = None
            stable_polls = 0
            last_reason = reason

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            receipt_path = _write_atspi_failure_receipt(
                bundle,
                phase,
                row["caseId"],
                reason=last_reason,
                inventory=last_inventory,
            )
            raise UiCaptureError(f"{last_reason}; bounded AT-SPI inventory saved to {receipt_path}")
        time.sleep(min(AT_SPI_POLL_INTERVAL, remaining))


def _atspi_inventory_readiness_error(
    inventory: dict[str, Any],
    row: dict[str, Any],
    *,
    require_target: bool,
) -> str | None:
    if not inventory.get("complete") or inventory.get("traversalErrors"):
        return "AT-SPI inventory is incomplete"
    if inventory.get("applicationMatchCount") != 1:
        return "expected exactly one real application in AT-SPI inventory"
    frames = inventory.get("frameCandidates")
    if not isinstance(frames, list) or len(frames) != 1:
        return "expected exactly one visible in-viewport application frame"
    frame = inventory.get("appFrameExtents")
    if not isinstance(frame, dict) or not _valid_visible_extents(
        frame,
        {"x": 0, "y": 0, "width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
    ):
        return "visible application frame has invalid viewport extents"
    if require_target:
        try:
            evaluate_case_oracle(
                inventory=inventory,
                expected_presence=row["expectedPresence"],
                target_role=row["targetRole"],
                target_name=row["targetName"],
            )
        except UiCaptureError as error:
            return str(error)
    return None


def _write_atspi_failure_receipt(
    bundle: Path,
    phase: str,
    case_id: str,
    *,
    reason: str,
    inventory: dict[str, Any],
) -> Path:
    failure_dir = bundle / "private" / phase / "failures"
    failure_dir.mkdir(parents=True, exist_ok=True)
    bounded_inventory = dict(inventory)
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "caseId": case_id,
        "status": "atspi-readiness-failed",
        "reason": reason,
        "inventory": bounded_inventory,
    }
    path = failure_dir / f"{case_id}-atspi.json"
    _write_bounded_private_json(path, payload, MAX_ATSPI_FAILURE_BYTES, "AT-SPI failure receipt")
    return path


def _write_capture_inventory_failure(
    bundle: Path,
    case_id: str,
    *,
    reason: str,
    before: dict[str, Any],
    after: dict[str, Any],
    screenshot: dict[str, Any] | None,
) -> Path:
    failure_dir = bundle / "private" / "capture" / "failures"
    failure_dir.mkdir(parents=True, exist_ok=True)
    path = failure_dir / f"{case_id}-inventory.json"
    payload = {
        "schemaVersion": 1,
        "caseId": case_id,
        "status": "capture-inventory-changed",
        "reason": reason,
        "before": before,
        "after": after,
        "screenshot": screenshot,
    }
    _write_bounded_private_json(path, payload, MAX_ATSPI_FAILURE_BYTES, "capture inventory failure receipt")
    return path


def _write_bounded_private_json(path: Path, payload: dict[str, Any], byte_cap: int, label: str) -> None:
    bounded = dict(payload)
    raw = json.dumps(bounded, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    while len(raw) > byte_cap:
        shortened = False
        for field in ("inventory", "before", "after"):
            value = bounded.get(field)
            if not isinstance(value, dict):
                continue
            nodes = value.get("nodes")
            if isinstance(nodes, list) and len(nodes) > 1:
                copy = dict(value)
                copy["nodes"] = nodes[: max(1, len(nodes) // 2)]
                copy["nodesTruncatedForReceipt"] = True
                bounded[field] = copy
                shortened = True
        if not shortened:
            raise UiCaptureError(f"{label} exceeds byte cap")
        raw = json.dumps(bounded, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    try:
        with path.open("xb") as handle:
            handle.write(raw + b"\n")
    except FileExistsError as error:
        raise UiCaptureError(f"{label} already exists: {path}") from error


def _collect_atspi_inventory(row: dict[str, Any]) -> dict[str, Any]:
    import pyatspi  # noqa: PLC0415

    desktop = pyatspi.Registry.getDesktop(0)
    traversal_errors: list[str] = []
    if row["sourceGroup"] == "thunar":
        expected_app_name = "thunar"
    elif row["sourceGroup"] == "eog":
        expected_app_name = "eog"
    else:
        raise UiCaptureError("unknown AT-SPI source group")

    applications: list[tuple[Any, str]] = []
    search_state = {"visited": 0}
    _find_application_nodes(
        desktop,
        applications,
        traversal_errors,
        depth=0,
        pyatspi=pyatspi,
        search_state=search_state,
    )
    application_names = [name for _app, name in applications]
    matching = [(app, name) for app, name in applications if name == expected_app_name]
    nodes: list[dict[str, Any]] = []
    for application_index, (app, _name) in enumerate(matching):
        _walk_accessible(
            app,
            nodes,
            traversal_errors,
            depth=0,
            application_index=application_index,
            pyatspi=pyatspi,
        )

    frame_candidates: list[dict[str, Any]] = []
    viewport = {"x": 0, "y": 0, "width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT}
    for node in nodes:
        if node.get("role") != "frame" or not node.get("showing") or not node.get("visible"):
            continue
        extents = node.get("extents")
        if not isinstance(extents, dict) or not _valid_visible_extents(extents, viewport):
            continue
        frame_candidates.append(
            {
                "applicationIndex": node["applicationIndex"],
                "name": node["name"],
                "extents": extents,
            }
        )
    app_frame = frame_candidates[0]["extents"] if len(frame_candidates) == 1 else None

    return {
        "complete": len(traversal_errors) == 0,
        "traversalErrors": traversal_errors,
        "applicationNames": application_names,
        "expectedApplicationName": expected_app_name,
        "applicationMatchCount": len(matching),
        "frameCandidates": frame_candidates,
        "nodes": nodes,
        "appFrameExtents": app_frame,
        "viewport": {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
    }


def _valid_visible_extents(extents: dict[str, Any], viewport: dict[str, int]) -> bool:
    try:
        if any(isinstance(extents[key], bool) or not isinstance(extents[key], int) for key in ("x", "y", "width", "height")):
            return False
        if not extents_positive(extents):
            return False
        return extents_inside_frame(extents, viewport)
    except (KeyError, TypeError):
        return False


def _append_atspi_error(errors: list[str], message: str) -> None:
    if message not in errors and len(errors) < 100:
        errors.append(message)


def _bounded_accessible_text(value: Any, field: str, errors: list[str]) -> str:
    if value is None:
        return ""
    text = str(value)
    if len(text) > MAX_ATSPI_TEXT_CHARS:
        _append_atspi_error(errors, f"{field} exceeds text cap")
        return text[:MAX_ATSPI_TEXT_CHARS]
    return text


def _find_application_nodes(
    node: Any,
    applications: list[tuple[Any, str]],
    errors: list[str],
    *,
    depth: int,
    pyatspi: Any,
    search_state: dict[str, int],
) -> None:
    if depth > MAX_ATSPI_DEPTH:
        _append_atspi_error(errors, "application search depth cap exceeded")
        return
    if search_state["visited"] >= MAX_ATSPI_NODES:
        _append_atspi_error(errors, "application search node cap exceeded")
        return
    search_state["visited"] += 1
    try:
        count = node.childCount
        role = node.getRoleName()
        if role == "application":
            name = _bounded_accessible_text(node.name, "application name", errors)
            if len(applications) >= MAX_ATSPI_APPLICATIONS:
                _append_atspi_error(errors, "application count cap exceeded")
                return
            applications.append((node, name))
            return
        if count > MAX_ATSPI_CHILDREN:
            _append_atspi_error(errors, f"application search child cap exceeded at depth {depth}")
            count = MAX_ATSPI_CHILDREN
        for index in range(count):
            if search_state["visited"] >= MAX_ATSPI_NODES:
                break
            try:
                child = node.getChildAtIndex(index)
            except Exception as error:  # noqa: BLE001
                _append_atspi_error(errors, f"application search child {index} at depth {depth}: {type(error).__name__}")
                continue
            _find_application_nodes(
                child,
                applications,
                errors,
                depth=depth + 1,
                pyatspi=pyatspi,
                search_state=search_state,
            )
    except Exception as error:  # noqa: BLE001
        _append_atspi_error(errors, f"application search node at depth {depth}: {type(error).__name__}")


def _walk_accessible(
    node: Any,
    nodes: list[dict[str, Any]],
    errors: list[str],
    *,
    depth: int,
    application_index: int,
    pyatspi: Any,
) -> None:
    if depth > MAX_ATSPI_DEPTH:
        _append_atspi_error(errors, "accessible tree depth cap exceeded")
        return
    if len(nodes) >= MAX_ATSPI_NODES:
        _append_atspi_error(errors, "accessible tree node cap exceeded")
        return
    try:
        role = _bounded_accessible_text(node.getRoleName(), "accessible role", errors)
        name = _bounded_accessible_text(node.name, "accessible name", errors)
        states = node.getState()
        showing = states.contains(pyatspi.STATE_SHOWING)
        visible = states.contains(pyatspi.STATE_VISIBLE)
        record: dict[str, Any] = {
            "role": role,
            "name": name,
            "showing": showing,
            "visible": visible,
            "applicationIndex": application_index,
        }
        try:
            component = node.queryComponent()
            ext = component.getExtents(pyatspi.DESKTOP_COORDS)
            record["extents"] = {"x": ext.x, "y": ext.y, "width": ext.width, "height": ext.height}
        except Exception:  # noqa: BLE001
            pass
        nodes.append(record)
        count = node.childCount
        if count > MAX_ATSPI_CHILDREN:
            _append_atspi_error(errors, f"accessible child cap exceeded at depth {depth}")
            count = MAX_ATSPI_CHILDREN
        for index in range(count):
            if len(nodes) >= MAX_ATSPI_NODES:
                break
            try:
                child = node.getChildAtIndex(index)
            except Exception as error:  # noqa: BLE001
                _append_atspi_error(errors, f"accessible child {index} at depth {depth}: {type(error).__name__}")
                continue
            _walk_accessible(
                child,
                nodes,
                errors,
                depth=depth + 1,
                application_index=application_index,
                pyatspi=pyatspi,
            )
    except Exception as error:  # noqa: BLE001
        _append_atspi_error(errors, f"accessible node at depth {depth}: {type(error).__name__}")


def _terminate_process_tree(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def isolated_ui_worker_command(command: list[str]) -> list[str]:
    return [
        "unshare",
        "--user",
        "--map-root-user",
        "--net",
        "--pid",
        "--fork",
        "--kill-child",
        "--mount-proc",
        "--",
        *command,
    ]


def _new_ui_phase_path(path: Path, label: str) -> None:
    if path.is_symlink() or path.exists():
        raise UiCaptureError(f"{label} already exists; use a new bundle")


def cmd_preflight(args: argparse.Namespace) -> int:
    bundle = require_existing_bundle(Path(args.bundle))
    manifest_before, digest_before = load_frozen_state_manifest(bundle)
    verify_manifest_authored_files(bundle, manifest_before)
    resource_receipts = verify_pinned_resources()
    preflight_root = bundle / "private" / "preflight"
    cases_dir = preflight_root / "cases"
    summary_path = preflight_root / "summary.json"
    _new_ui_phase_path(preflight_root, "preflight output")
    preflight_root.mkdir(mode=0o700, parents=True, exist_ok=False)
    cases_dir.mkdir(mode=0o700, exist_ok=False)
    case_receipts: list[dict[str, Any]] = []
    for row in manifest_before["rows"]:
        worker_cmd = [
            sys.executable,
            str(_HERE / "ui_capture.py"),
            "_worker",
            "preflight-case",
            "--bundle",
            str(bundle),
            "--case-id",
            row["caseId"],
        ]
        worker_profile = create_private_ui_profile(bundle, "preflight", "worker", row["caseId"])
        runner = ProcessGroupRunner(
            isolated_ui_worker_command(worker_cmd),
            env=build_ui_process_environment(worker_profile),
            cwd=bundle,
        )
        try:
            runner.start()
            code = runner.wait(MAX_CASE_SECONDS + 15)
        except Exception as error:
            _write_preflight_failure(bundle, row["caseId"], str(error), runner)
            raise
        if code != 0:
            _write_preflight_failure(bundle, row["caseId"], f"worker exit {code}", runner)
            raise UiCaptureError(f"preflight worker failed for {row['caseId']}")
        receipt_path = cases_dir / f"{row['caseId']}.json"
        if receipt_path.is_symlink() or not receipt_path.is_file():
            _write_preflight_failure(bundle, row["caseId"], "case receipt missing after worker", runner)
            raise UiCaptureError(f"preflight case receipt missing for {row['caseId']}")
        case_receipts.append(json.loads(receipt_path.read_text(encoding="utf-8")))
    _, digest_after = load_frozen_state_manifest(bundle)
    if digest_after != digest_before:
        raise UiCaptureError("preflight altered state manifest hash")
    summary_path = bundle / "private" / "preflight" / "summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary = {
        "schemaVersion": PREFLIGHT_RECEIPT_SCHEMA,
        "status": "complete",
        "stateManifestSha256": digest_before,
        "caseCount": len(case_receipts),
        "caseIds": [row["caseId"] for row in manifest_before["rows"]],
        "resourceReceipts": resource_receipts,
        "cases": case_receipts,
        "viewport": {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT},
    }
    validate_preflight_summary_document(summary, manifest_before, state_manifest_sha256=digest_before)
    with summary_path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.write(json.dumps({"status": "ok", "stateManifestSha256": digest_before}, ensure_ascii=False) + "\n")
    return 0


def _write_preflight_failure(bundle: Path, case_id: str, reason: str, runner: ProcessGroupRunner) -> None:
    _write_phase_worker_failure(bundle, "preflight", case_id, reason, runner)


def _write_phase_worker_failure(
    bundle: Path,
    phase: str,
    case_id: str,
    reason: str,
    runner: ProcessGroupRunner,
) -> Path:
    failure_dir = bundle / "private" / phase / "failures"
    failure_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 3,
        "caseId": case_id,
        "phase": phase,
        "reason": reason,
        "stdout": runner.stdout.decode("utf-8", errors="replace"),
        "stderr": runner.stderr.decode("utf-8", errors="replace"),
        "stdoutBytes": runner.stdout_total_bytes,
        "stderrBytes": runner.stderr_total_bytes,
        "stdoutRetainedBytes": len(runner.stdout),
        "stderrRetainedBytes": len(runner.stderr),
        "stdoutTruncated": runner.stdout_total_bytes > len(runner.stdout),
        "stderrTruncated": runner.stderr_total_bytes > len(runner.stderr),
    }
    for suffix, field in (
        ("inner", "innerFailureReceipt"),
        ("atspi", "atspiFailureReceipt"),
        ("inventory", "inventoryFailureReceipt"),
    ):
        evidence_path = failure_dir / f"{case_id}-{suffix}.json"
        if evidence_path.is_file() and not evidence_path.is_symlink():
            payload[field] = evidence_path.name
    path = failure_dir / f"{case_id}.json"
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, indent=2) + "\n")
    except FileExistsError as error:
        raise UiCaptureError(f"{phase} worker failure receipt already exists: {path}") from error
    return path


def _write_inner_case_failure(
    bundle: Path,
    phase: str,
    case_id: str,
    *,
    exit_code: int,
    runner: ProcessGroupRunner,
) -> Path:
    failure_dir = bundle / "private" / phase / "failures"
    failure_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "caseId": case_id,
        "status": "case-worker-failed",
        "exitCode": exit_code,
        "stdout": runner.stdout.decode("utf-8", errors="replace"),
        "stderr": runner.stderr.decode("utf-8", errors="replace"),
        "stdoutBytes": runner.stdout_total_bytes,
        "stderrBytes": runner.stderr_total_bytes,
        "stdoutRetainedBytes": len(runner.stdout),
        "stderrRetainedBytes": len(runner.stderr),
        "stdoutTruncated": runner.stdout_total_bytes > len(runner.stdout),
        "stderrTruncated": runner.stderr_total_bytes > len(runner.stderr),
    }
    path = failure_dir / f"{case_id}-inner.json"
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, indent=2) + "\n")
    except FileExistsError as error:
        raise UiCaptureError(f"inner {phase} failure receipt already exists: {path}") from error
    return path


def sanitize_producer_row(row: dict[str, Any], *, screenshot_rel: str, screenshot_sha: str, width: int, height: int) -> dict[str, Any]:
    allowed_top = {"caseId", "target", "image"}
    if set(row) - allowed_top:
        raise UiCaptureError("producer row contains forbidden keys")
    target = row.get("target")
    if not isinstance(target, str) or not target.strip():
        raise UiCaptureError("producer target invalid")
    image = row.get("image")
    if not isinstance(image, dict):
        raise UiCaptureError("producer image invalid")
    if set(image) != {"path", "sha256", "width", "height"}:
        raise UiCaptureError("producer image keys invalid")
    return {
        "caseId": row["caseId"],
        "target": target,
        "image": {
            "path": screenshot_rel,
            "sha256": screenshot_sha,
            "width": width,
            "height": height,
        },
    }


def _expected_app_name(source_group: str) -> str:
    if source_group == "thunar":
        return "thunar"
    if source_group == "eog":
        return "eog"
    raise UiCaptureError("unknown UI source group")


def _validate_preflight_inventory(row: dict[str, Any], inventory: Any) -> dict[str, Any]:
    if not isinstance(inventory, dict):
        raise UiCaptureError("preflight case inventory missing")
    if inventory.get("complete") is not True or inventory.get("traversalErrors") != []:
        raise UiCaptureError("preflight case inventory is incomplete")
    expected_app = _expected_app_name(row["sourceGroup"])
    if inventory.get("applicationNames") != [expected_app]:
        raise UiCaptureError("preflight application roster mismatch")
    if inventory.get("expectedApplicationName") != expected_app or inventory.get("applicationMatchCount") != 1:
        raise UiCaptureError("preflight expected application match mismatch")
    expected_viewport = {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT}
    if inventory.get("viewport") != expected_viewport:
        raise UiCaptureError("preflight inventory viewport mismatch")
    nodes = inventory.get("nodes")
    if not isinstance(nodes, list) or len(nodes) > MAX_ATSPI_NODES:
        raise UiCaptureError("preflight inventory node count invalid")
    for node in nodes:
        if not isinstance(node, dict):
            raise UiCaptureError("preflight inventory node malformed")
        if not isinstance(node.get("role"), str) or not isinstance(node.get("name"), str):
            raise UiCaptureError("preflight inventory node identity malformed")
        if len(node["role"]) > MAX_ATSPI_TEXT_CHARS or len(node["name"]) > MAX_ATSPI_TEXT_CHARS:
            raise UiCaptureError("preflight inventory node identity exceeds text cap")
        if node.get("applicationIndex") != 0 or not isinstance(node.get("showing"), bool) or not isinstance(node.get("visible"), bool):
            raise UiCaptureError("preflight inventory node state malformed")

    viewport_rect = {"x": 0, "y": 0, "width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT}
    derived_frames: list[dict[str, Any]] = []
    for node in nodes:
        extents = node.get("extents")
        if (
            node.get("role") == "frame"
            and node.get("showing") is True
            and node.get("visible") is True
            and isinstance(extents, dict)
            and _valid_visible_extents(extents, viewport_rect)
        ):
            derived_frames.append(
                {"applicationIndex": 0, "name": node["name"], "extents": extents}
            )
    if inventory.get("frameCandidates") != derived_frames or len(derived_frames) != 1:
        raise UiCaptureError("preflight visible frame evidence is ambiguous or inconsistent")
    frame = derived_frames[0]["extents"]
    if inventory.get("appFrameExtents") != frame:
        raise UiCaptureError("preflight application frame extents mismatch")
    return inventory


def validate_preflight_summary_document(
    summary: Any,
    manifest: dict[str, Any],
    *,
    state_manifest_sha256: str,
) -> None:
    if not isinstance(summary, dict):
        raise UiCaptureError("preflight summary must be an object")
    required_keys = {
        "schemaVersion",
        "status",
        "stateManifestSha256",
        "caseCount",
        "caseIds",
        "resourceReceipts",
        "cases",
        "viewport",
    }
    if set(summary) != required_keys:
        raise UiCaptureError("preflight summary keys mismatch")
    if summary.get("schemaVersion") != PREFLIGHT_RECEIPT_SCHEMA or summary.get("status") != "complete":
        raise UiCaptureError("preflight summary is not complete")
    if summary.get("stateManifestSha256") != state_manifest_sha256:
        raise UiCaptureError("preflight summary state manifest hash mismatch")
    expected_viewport = {"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT}
    if summary.get("viewport") != expected_viewport:
        raise UiCaptureError("preflight summary viewport mismatch")
    rows = manifest.get("rows")
    cases = summary.get("cases")
    case_ids = summary.get("caseIds")
    if not isinstance(rows, list) or not isinstance(cases, list) or not isinstance(case_ids, list):
        raise UiCaptureError("preflight summary roster is malformed")
    if summary.get("caseCount") != len(rows) or len(cases) != len(rows) or len(case_ids) != len(rows):
        raise UiCaptureError("preflight summary case count mismatch")
    expected_ids = [row["caseId"] for row in rows]
    if case_ids != expected_ids:
        raise UiCaptureError("preflight summary case order or identity mismatch")
    if not isinstance(summary.get("resourceReceipts"), dict):
        raise UiCaptureError("preflight summary resource receipts missing")
    by_id: dict[str, dict[str, Any]] = {}
    for value in cases:
        if not isinstance(value, dict):
            raise UiCaptureError("preflight case receipt malformed")
        case_id = value.get("caseId")
        if not isinstance(case_id, str) or case_id in by_id:
            raise UiCaptureError("preflight case receipt identity duplicated")
        by_id[case_id] = value
    if set(by_id) != set(expected_ids):
        raise UiCaptureError("preflight case receipt roster mismatch")

    for row in rows:
        receipt = by_id[row["caseId"]]
        if receipt.get("schemaVersion") != PREFLIGHT_RECEIPT_SCHEMA:
            raise UiCaptureError("preflight case receipt schema mismatch")
        if receipt.get("sourceStateId") != row["sourceStateId"]:
            raise UiCaptureError("preflight case receipt state identity mismatch")
        if receipt.get("screenshot") is not None or receipt.get("viewport") != expected_viewport:
            raise UiCaptureError("preflight case receipt has screenshot or viewport mismatch")
        before = _validate_preflight_inventory(row, receipt.get("preInventory"))
        after = _validate_preflight_inventory(row, receipt.get("postInventory"))
        if before != after:
            raise UiCaptureError("preflight before/after inventory differs")
        expected_oracle = evaluate_case_oracle(
            inventory=before,
            expected_presence=row["expectedPresence"],
            target_role=row["targetRole"],
            target_name=row["targetName"],
        )
        if receipt.get("preOracle") != expected_oracle or receipt.get("postOracle") != expected_oracle:
            raise UiCaptureError("preflight oracle evidence does not match inventory")


def load_validated_preflight_summary(
    bundle: Path,
    manifest: dict[str, Any],
    *,
    state_manifest_sha256: str,
    expected_summary_sha256: str | None = None,
) -> tuple[dict[str, Any], str]:
    path = bundle / "private" / "preflight" / "summary.json"
    if path.is_symlink() or not path.is_file():
        raise UiCaptureError("complete bound preflight summary is required before capture")
    if path.stat().st_size > MAX_PREFLIGHT_SUMMARY_BYTES:
        raise UiCaptureError("preflight summary exceeds byte cap")
    raw = path.read_bytes()
    digest = sha256_bytes(raw)
    if expected_summary_sha256 is not None and digest != expected_summary_sha256:
        raise UiCaptureError("preflight summary hash mismatch")
    try:
        summary = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_json_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UiCaptureError("preflight summary JSON invalid") from error
    validate_preflight_summary_document(
        summary,
        manifest,
        state_manifest_sha256=state_manifest_sha256,
    )
    return summary, digest


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise UiCaptureError("preflight summary contains duplicate JSON keys")
        result[key] = value
    return result


def _visible_inventory_signature(inventory: dict[str, Any]) -> bytes:
    nodes = inventory.get("nodes")
    if not isinstance(nodes, list):
        raise UiCaptureError("AT-SPI inventory nodes missing")
    visible_nodes = [
        {
            "role": node.get("role"),
            "name": node.get("name"),
            "showing": node.get("showing"),
            "visible": node.get("visible"),
            "applicationIndex": node.get("applicationIndex"),
            "extents": node.get("extents"),
        }
        for node in nodes
        if isinstance(node, dict) and node.get("showing") is True and node.get("visible") is True
    ]
    content = {
        "applicationNames": inventory.get("applicationNames"),
        "expectedApplicationName": inventory.get("expectedApplicationName"),
        "applicationMatchCount": inventory.get("applicationMatchCount"),
        "frameCandidates": inventory.get("frameCandidates"),
        "appFrameExtents": inventory.get("appFrameExtents"),
        "viewport": inventory.get("viewport"),
        "visibleNodes": visible_nodes,
    }
    return json.dumps(content, sort_keys=True, separators=(",", ":")).encode("utf-8")


def validate_screenshot_png(png_bytes: bytes) -> tuple[int, int]:
    try:
        _read_png_chunks(png_bytes)
        width, height = png_ihdr_dimensions(png_bytes)
        from PIL import Image  # noqa: PLC0415

        with Image.open(io.BytesIO(png_bytes)) as image:
            if image.size != (width, height) or image.mode not in {"RGB", "RGBA"}:
                raise UiCaptureError("screenshot PNG mode or decoded canvas mismatch")
            image.load()
    except ImagingValidationError as error:
        raise UiCaptureError(f"screenshot PNG validation failed: {error}") from error
    except OSError as error:
        raise UiCaptureError("screenshot PNG cannot be decoded") from error
    return width, height


def cmd_capture(args: argparse.Namespace) -> int:
    bundle = require_existing_bundle(Path(args.bundle))
    approved = args.approved_manifest_sha256
    if not SHA256_HEX.match(approved):
        raise UiCaptureError("approved-manifest-sha256 must be 64 hex chars")
    manifest, digest = load_frozen_state_manifest(bundle)
    if digest != approved:
        raise UiCaptureError("approved manifest sha256 does not match frozen state manifest")
    approved_preflight = args.approved_preflight_summary_sha256
    if not SHA256_HEX.fullmatch(approved_preflight):
        raise UiCaptureError("approved-preflight-summary-sha256 must be 64 hex chars")
    _summary, preflight_summary_sha256 = load_validated_preflight_summary(
        bundle,
        manifest,
        state_manifest_sha256=digest,
        expected_summary_sha256=approved_preflight,
    )
    verify_manifest_authored_files(bundle, manifest)
    screenshots_dir = bundle / "private" / "screenshots"
    capture_root = bundle / "private" / "capture"
    capture_cases_dir = capture_root / "cases"
    producer_path = bundle / "producer-manifest.json"
    _new_ui_phase_path(screenshots_dir, "capture screenshots")
    _new_ui_phase_path(capture_root, "capture outputs")
    _new_ui_phase_path(producer_path, "producer manifest")
    screenshots_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    capture_root.mkdir(mode=0o700, exist_ok=False)
    capture_cases_dir.mkdir(mode=0o700, exist_ok=False)
    producer_rows: list[dict[str, Any]] = []
    for row in manifest["rows"]:
        worker_cmd = [
            sys.executable,
            str(_HERE / "ui_capture.py"),
            "_worker",
            "capture-case",
            "--bundle",
            str(bundle),
            "--case-id",
            row["caseId"],
            "--approved-manifest-sha256",
            approved,
            "--preflight-summary-sha256",
            preflight_summary_sha256,
        ]
        worker_profile = create_private_ui_profile(bundle, "capture", "worker", row["caseId"])
        runner = ProcessGroupRunner(
            isolated_ui_worker_command(worker_cmd),
            env=build_ui_process_environment(worker_profile),
            cwd=bundle,
        )
        try:
            runner.start()
            code = runner.wait(MAX_CASE_SECONDS + 15)
        except Exception as error:
            _write_phase_worker_failure(bundle, "capture", row["caseId"], str(error), runner)
            raise
        if code != 0:
            _write_phase_worker_failure(bundle, "capture", row["caseId"], f"worker exit {code}", runner)
            raise UiCaptureError(f"capture worker failed for {row['caseId']}; bounded logs saved")
        receipt_path = bundle / "private" / "capture" / "cases" / f"{row['caseId']}.json"
        if receipt_path.is_symlink() or not receipt_path.is_file():
            _write_phase_worker_failure(bundle, "capture", row["caseId"], "case receipt missing", runner)
            raise UiCaptureError(f"capture receipt missing for {row['caseId']}")
        if receipt_path.stat().st_size > MAX_ATSPI_FAILURE_BYTES:
            _write_phase_worker_failure(bundle, "capture", row["caseId"], "case receipt exceeds byte cap", runner)
            raise UiCaptureError("capture receipt exceeds byte cap")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt.get("preflightSummarySha256") != preflight_summary_sha256:
            _write_phase_worker_failure(bundle, "capture", row["caseId"], "preflight hash binding missing", runner)
            raise UiCaptureError("capture receipt is not bound to reviewed preflight summary")
        screenshot = receipt.get("screenshot")
        if not isinstance(screenshot, dict):
            raise UiCaptureError("capture receipt missing screenshot metadata")
        screenshot_rel = receipt.get("screenshotRelative")
        expected_screenshot_rel = (Path("private") / "screenshots" / f"{row['caseId']}.png").as_posix()
        if screenshot_rel != expected_screenshot_rel:
            raise UiCaptureError("capture receipt screenshot path mismatch")
        screenshot_path = bundle / Path(screenshot_rel)
        if screenshot_path.is_symlink() or not screenshot_path.is_file():
            raise UiCaptureError("capture screenshot missing or symlinked")
        try:
            screenshot_bytes, screenshot_sha = read_bounded_file_bytes(
                screenshot_path,
                max_bytes=MAX_SCREENSHOT_BYTES,
                label="captured screenshot",
            )
        except FileValidationError as error:
            raise UiCaptureError(f"captured screenshot read failed: {error}") from error
        if screenshot_sha != screenshot.get("sha256"):
            raise UiCaptureError("capture screenshot SHA-256 mismatch")
        width, height = validate_screenshot_png(screenshot_bytes)
        if (width, height) != (VIEWPORT_WIDTH, VIEWPORT_HEIGHT):
            raise UiCaptureError("capture screenshot canvas mismatch")
        producer_rows.append(
            sanitize_producer_row(
                {
                    "caseId": row["caseId"],
                    "target": row["targetName"],
                    "image": {
                        "path": screenshot_rel,
                        "sha256": screenshot["sha256"],
                        "width": screenshot["width"],
                        "height": screenshot["height"],
                    },
                },
                screenshot_rel=screenshot_rel,
                screenshot_sha=screenshot_sha,
                width=width,
                height=height,
            )
        )
    _, digest_after = load_frozen_state_manifest(bundle)
    if digest_after != digest:
        raise UiCaptureError("capture altered state manifest hash")
    producer_manifest = {
        "schemaVersion": PRODUCER_MANIFEST_SCHEMA,
        "rows": producer_rows,
    }
    out_path = producer_path
    with out_path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(producer_manifest, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.write(json.dumps({"status": "ok", "producerManifest": str(out_path)}, ensure_ascii=False) + "\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ui_capture.py")
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--output-dir", required=True)
    preflight = sub.add_parser("preflight")
    preflight.add_argument("--bundle", required=True)
    capture = sub.add_parser("capture")
    capture.add_argument("--bundle", required=True)
    capture.add_argument("--approved-manifest-sha256", required=True)
    capture.add_argument("--approved-preflight-summary-sha256", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    if args_list[:1] == ["_worker"]:
        return worker_entry(args_list[1:])
    if args_list[:1] == ["_worker-inner"]:
        if len(args_list) != 4:
            raise UiCaptureError("_worker-inner requires case_id bundle screenshot_path")
        return _worker_inner(args_list[1], args_list[2], args_list[3])
    parser = build_parser()
    args = parser.parse_args(args_list)
    try:
        if args.command == "prepare":
            return cmd_prepare(args)
        if args.command == "preflight":
            return cmd_preflight(args)
        if args.command == "capture":
            return cmd_capture(args)
    except UiCaptureError as error:
        sys.stderr.write(f"ui-capture error: {error}\n")
        return 2
    raise UiCaptureError(f"unknown command {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
