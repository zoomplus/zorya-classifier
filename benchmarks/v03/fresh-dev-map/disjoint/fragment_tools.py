"""Small safety and oracle helpers shared by the private source exporters."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def repository_root_from_file(source_file: str | Path) -> Path:
    """Find the checkout containing this script, without a machine-specific path."""
    source = Path(source_file).resolve(strict=True)
    for candidate in source.parents:
        if (candidate / "AGENTS.md").is_file() and (candidate / "benchmarks").is_dir():
            return candidate.resolve(strict=True)
    raise ValueError(f"cannot locate repository root above {source}")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def external_study_root(value: str | Path, repository_root: Path) -> Path:
    raw = Path(value).expanduser()
    if not raw.is_absolute():
        raise ValueError("--study-root must be an absolute path")
    root = raw.resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"study root is not a directory: {root}")
    repo = repository_root.resolve(strict=True)
    if _is_relative_to(root, repo):
        raise ValueError("study root must be outside the repository checkout")
    return root


def study_input(study_root: Path, relative_path: str | Path) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute():
        raise ValueError(f"study input must be relative to --study-root: {relative}")
    result = (study_root / relative).resolve(strict=True)
    if not _is_relative_to(result, study_root):
        raise ValueError(f"study input escapes --study-root through a symlink: {relative}")
    if not result.is_file() and not result.is_dir():
        raise ValueError(f"study input is neither a file nor directory: {relative}")
    return result


def create_new_output_dir(
    study_root: Path,
    output_value: str | Path,
    repository_root: Path,
) -> Path:
    """Create a fresh output directory below the external study root."""
    raw = Path(output_value).expanduser()
    if not raw.is_absolute():
        raise ValueError("--output-dir must be an absolute path")
    if os.path.lexists(raw):
        raise FileExistsError(f"output path already exists; choose a new path: {raw}")
    parent = raw.parent.resolve(strict=True)
    repo = repository_root.resolve(strict=True)
    if _is_relative_to(parent, repo):
        raise ValueError("output directory must be outside the repository checkout")
    if not _is_relative_to(parent, study_root):
        raise ValueError("output directory must be below --study-root")
    target = parent / raw.name
    if target == study_root or target == repo:
        raise ValueError("output directory cannot replace a root directory")
    target.mkdir(mode=0o700, exist_ok=False)
    return target


def write_immutable(output_dir: Path, filename: str, data: bytes) -> Path:
    if Path(filename).name != filename or filename in {"", ".", ".."}:
        raise ValueError(f"expected a plain output filename, got {filename!r}")
    path = output_dir / filename
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(path, 0o444)
    return path


def write_immutable_json(output_dir: Path, filename: str, value: Any) -> Path:
    raw = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    return write_immutable(output_dir, filename, raw)


def select_predeclared_cell_box(
    target_cell_xy: list[int] | tuple[int, int] | None,
    pixel_proofs: list[dict[str, Any]],
    box_width: int,
    box_height: int,
) -> list[dict[str, int]]:
    """Return only the proof box for the preregistered cell, never its peers."""
    if target_cell_xy is None:
        if pixel_proofs:
            raise ValueError("absent source target unexpectedly has pixel proofs")
        return []
    selected = [item for item in pixel_proofs if item.get("sourceCellXY") == list(target_cell_xy)]
    if len(selected) != 1:
        raise ValueError(
            f"expected one pixel proof for predeclared cell {list(target_cell_xy)}, got {len(selected)}"
        )
    top_left = selected[0].get("matchTopLeftXY")
    if not isinstance(top_left, list) or len(top_left) != 2:
        raise ValueError("selected pixel proof lacks a two-coordinate matchTopLeftXY")
    x, y = top_left
    return [{"left": int(x), "top": int(y), "width": box_width, "height": box_height}]


def parse_export_args(description: str, source_file: str | Path):
    """Parse required paths and validate checkout/study boundaries."""
    import argparse

    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--study-root", required=True, help="absolute external study/artifact root")
    parser.add_argument("--output-dir", required=True, help="absolute new directory below --study-root")
    args = parser.parse_args()
    repo = repository_root_from_file(source_file)
    study = external_study_root(args.study_root, repo)
    output = create_new_output_dir(study, args.output_dir, repo)
    return study, output, repo
