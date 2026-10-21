#!/usr/bin/env python3
"""H11 Sa2VA benchmark runner (explicit paths, freeze separated from --run)."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

_H11_COMMON_PATH = Path(__file__).with_name("h11-sa2va-common.py")
_h11_spec = importlib.util.spec_from_file_location("h11_sa2va_common_runner", _H11_COMMON_PATH)
if _h11_spec is None or _h11_spec.loader is None:
    raise RuntimeError("failed to load h11-sa2va-common.py")
h11 = importlib.util.module_from_spec(_h11_spec)
sys.modules[_h11_spec.name] = h11
_h11_spec.loader.exec_module(h11)

_H10_RUNNER_PATH = Path(__file__).with_name("h10-clipseg-runner.py")
_h10_runner_spec = importlib.util.spec_from_file_location("h10_clipseg_runner_h11", _H10_RUNNER_PATH)
if _h10_runner_spec is None or _h10_runner_spec.loader is None:
    raise RuntimeError("failed to load h10-clipseg-runner.py")
h10_runner = importlib.util.module_from_spec(_h10_runner_spec)
sys.modules[_h10_runner_spec.name] = h10_runner
_h10_runner_spec.loader.exec_module(h10_runner)

_H10_COMMON_PATH = Path(__file__).with_name("h10-clipseg-common.py")
_H11_WORKER_PATH = Path(__file__).with_name("h11-sa2va-worker.py")
_CONTRACT_DEFAULT = Path(__file__).with_name("h11-sa2va-contract.json")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_python_executable(value: str) -> Path:
    return Path(value).expanduser().absolute()


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def write_jsonl_atomic(path: Path, rows: list[dict[str, Any]]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    os.replace(temporary, path)


def assert_no_existing_freeze(output_dir: Path) -> None:
    freeze_path = output_dir / "freeze.json"
    if freeze_path.exists():
        raise h11.H11Error("refusing to overwrite existing freeze.json")


def assert_no_prior_run_artifacts(output_dir: Path) -> None:
    for name in ("run.json", "rows.jsonl"):
        if (output_dir / name).is_file():
            raise h11.H11Error(f"refusing to start: {name} already exists in output directory")
    masks_dir = output_dir / "masks"
    if masks_dir.is_dir():
        for entry in masks_dir.rglob("*"):
            if entry.is_file():
                raise h11.H11Error("refusing to start: mask artifacts already exist under masks/")


def normalize_execute_rows_result(
    raw: dict[str, Any],
    manifest_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    terminal: list[dict[str, Any]] = []
    raw_rows = raw.get("rows")
    if not isinstance(raw_rows, list):
        raise h11.H11Error("execute_rows returned invalid rows payload")
    for index, manifest_row in enumerate(manifest_rows):
        if index < len(raw_rows) and isinstance(raw_rows[index], dict):
            terminal.append(h11.normalize_terminal_row(raw_rows[index], manifest_row))
        else:
            shell = h11.empty_row_shell(manifest_row)
            shell["error_code"] = "INCOMPLETE_RUN"
            shell["error_message"] = "missing terminal row from worker lifecycle"
            terminal.append(shell)
    if len(terminal) != 12:
        raise h11.H11Error(f"expected 12 normalized rows, got {len(terminal)}")
    for left, right in zip(terminal, manifest_rows, strict=True):
        if left["row_index"] != right["row_index"] or left["row_key"] != right["row_key"]:
            raise h11.H11Error("normalized rows misaligned with manifest order")
    return {
        "worker_pid": raw.get("worker_pid"),
        "load_ms": raw.get("load_ms"),
        "wall_ms": raw.get("wall_ms"),
        "rows": terminal,
        "worker_stderr_tail": raw.get("worker_stderr_tail") or "",
        "cleanup_failed": bool(raw.get("cleanup_failed")),
        "cancelled": bool(raw.get("cancelled")),
    }


def cmd_validate_manifest(args: argparse.Namespace) -> int:
    contract_path = Path(args.contract).resolve()
    contract = h11.load_contract(contract_path)
    manifest = load_json(Path(args.manifest))
    rows = h11.validate_manifest(manifest, contract=contract)
    digest = h11.assert_minimal_manifest_hash_if_applicable(Path(args.manifest).resolve())
    print(json.dumps({"ok": True, "row_count": len(rows), "manifest_sha256": digest}, indent=2))
    return 0


def cmd_verify_assets(args: argparse.Namespace) -> int:
    contract_path = Path(args.contract).resolve()
    contract = h11.load_contract(contract_path)
    asset_dir = Path(args.assets).resolve()
    receipts = h11.verify_asset_directory(asset_dir, contract)
    print(json.dumps({"ok": True, "files": receipts}, indent=2))
    return 0


def cmd_prepare_freeze(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).resolve()
    asset_dir = Path(args.assets).resolve()
    contract_path = Path(args.contract).resolve()
    output_dir = Path(args.output).resolve()
    python_executable = resolve_python_executable(args.python)
    worker_script = Path(args.worker).resolve()
    runner_script = Path(__file__).resolve()
    common_script = _H11_COMMON_PATH.resolve()
    contract = h11.load_contract(contract_path)
    manifest = load_json(manifest_path)
    rows = h11.validate_manifest(manifest, contract=contract)
    manifest_sha256 = h11.assert_minimal_manifest_hash_if_applicable(manifest_path)
    asset_receipts = h11.verify_asset_directory(asset_dir, contract)
    runtime = {
        **h11.collect_runtime_receipt(python_executable),
        "cuda_device": h11.cuda_runtime_details(),
    }
    h11.assert_runtime_pins(runtime)
    requested_device = str(args.device)
    output_dir.mkdir(parents=True, exist_ok=True)
    assert_no_existing_freeze(output_dir)
    freeze = {
        "schema": h11.FREEZE_SCHEMA,
        "prepared_at_unix_ms": int(time.time() * 1000),
        "manifest_path": str(manifest_path),
        "manifest_sha256": manifest_sha256,
        "contract_path": str(contract_path),
        "contract_sha256": h11.file_digest_hex(contract_path),
        "asset_dir": str(asset_dir),
        "asset_receipts": asset_receipts,
        "requested_device": requested_device,
        "runtime": runtime,
        "processor_attestation": h11.processor_attestation_from_contract(contract),
        "recipe": h11.build_recipe(requested_device=requested_device, contract=contract),
        "rows": rows,
        "script_receipts": h11.build_script_receipts(
            h11_common=common_script,
            h11_runner=runner_script,
            h11_worker=worker_script,
            h10_common=_H10_COMMON_PATH.resolve(),
            h10_runner=_H10_RUNNER_PATH.resolve(),
            contract_path=contract_path,
        ),
        "input_image_receipts": h11.build_input_image_receipts(rows),
        "overlay_wheels": h11.overlay_wheels_from_contract(contract),
    }
    write_json_atomic(output_dir / "freeze.json", freeze)
    print(json.dumps({"ok": True, "freeze_path": str(output_dir / "freeze.json")}, indent=2))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    if not args.run:
        raise SystemExit("--run flag is required to execute inference")
    freeze_path = Path(args.freeze).resolve()
    if not freeze_path.is_file():
        raise h11.H11Error(f"freeze file missing: {freeze_path}")
    output_dir = Path(args.output).resolve()
    if freeze_path.parent != output_dir:
        raise h11.H11Error("freeze file must live inside the output directory")
    python_executable = resolve_python_executable(args.python)
    worker_script = Path(args.worker).resolve()
    runner_script = Path(__file__).resolve()
    common_script = _H11_COMMON_PATH.resolve()
    contract_path = Path(args.contract).resolve()
    freeze = load_json(freeze_path)
    rows, contract = h11.revalidate_freeze_closure(
        freeze,
        freeze_path=freeze_path,
        python_executable=python_executable,
        contract_path=contract_path,
        h11_worker=worker_script,
        h11_runner=runner_script,
        h11_common=common_script,
        h10_runner=_H10_RUNNER_PATH.resolve(),
        h10_common=_H10_COMMON_PATH.resolve(),
    )
    frozen_device = freeze.get("requested_device")
    if frozen_device != str(args.device):
        raise h11.H11Error("run --device does not match freeze requested_device")
    script_receipts = h11.build_script_receipts(
        h11_common=common_script,
        h11_runner=runner_script,
        h11_worker=worker_script,
        h10_common=_H10_COMMON_PATH.resolve(),
        h10_runner=_H10_RUNNER_PATH.resolve(),
        contract_path=contract_path,
    )
    for key, value in script_receipts.items():
        if key.endswith("_path"):
            continue
        frozen_value = (freeze.get("script_receipts") or {}).get(key)
        if frozen_value != value:
            raise h11.H11Error(f"launch script receipt mismatch for {key}")
    assert_no_prior_run_artifacts(output_dir)
    asset_dir = Path(str(freeze["asset_dir"])).resolve()
    raw_result = h10_runner.execute_rows(
        python_executable=python_executable,
        worker_script=worker_script,
        contract_path=contract_path,
        asset_dir=asset_dir,
        output_dir=output_dir,
        rows=rows,
        device=str(args.device),
        whole_run_timeout_seconds=h11.WHOLE_RUN_TIMEOUT_SECONDS,
        case_timeout_seconds=h11.CASE_TIMEOUT_SECONDS,
    )
    result = normalize_execute_rows_result(raw_result, rows)
    freeze_sha256 = h11.file_digest_hex(freeze_path)
    status = h11.derive_run_status(
        result["rows"],
        cleanup_failed=bool(result["cleanup_failed"]),
        cancelled=bool(result["cancelled"]),
    )
    runtime = {
        **h11.collect_runtime_receipt(python_executable),
        "cuda_device": h11.cuda_runtime_details(),
    }
    run_record = {
        "schema": h11.RUN_SCHEMA,
        "status": status,
        "freeze_path": str(freeze_path),
        "freeze_sha256": freeze_sha256,
        "manifest_sha256": freeze["manifest_sha256"],
        "contract_sha256": freeze["contract_sha256"],
        "device": str(args.device),
        "row_count": len(result["rows"]),
        "load_ms": result["load_ms"],
        "wall_ms": result["wall_ms"],
        "worker_pid": result["worker_pid"],
        "worker_stderr_tail": result["worker_stderr_tail"],
        "cleanup_failed": result["cleanup_failed"],
        "cancelled": result["cancelled"],
        "cuda_runtime": runtime["cuda_device"],
        "runtime": runtime,
        "script_receipts": script_receipts,
    }
    write_jsonl_atomic(output_dir / "rows.jsonl", result["rows"])
    write_json_atomic(output_dir / "run.json", run_record)
    ok = not result["cleanup_failed"]
    print(json.dumps({"ok": ok, "output_dir": str(output_dir), "status": status}, indent=2))
    return 0 if ok else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="H11 Sa2VA benchmark runner")
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate-manifest")
    validate.add_argument("--manifest", required=True)
    validate.add_argument("--contract", default=str(_CONTRACT_DEFAULT))
    validate.set_defaults(func=cmd_validate_manifest)

    verify = sub.add_parser("verify-assets")
    verify.add_argument("--assets", required=True)
    verify.add_argument("--contract", default=str(_CONTRACT_DEFAULT))
    verify.set_defaults(func=cmd_verify_assets)

    freeze = sub.add_parser("prepare-freeze")
    freeze.add_argument("--manifest", required=True)
    freeze.add_argument("--assets", required=True)
    freeze.add_argument("--contract", required=True)
    freeze.add_argument("--output", required=True)
    freeze.add_argument("--python", required=True)
    freeze.add_argument("--worker", required=True)
    freeze.add_argument("--device", default="cuda:0")
    freeze.set_defaults(func=cmd_prepare_freeze)

    run = sub.add_parser("run")
    run.add_argument("--run", action="store_true")
    run.add_argument("--freeze", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--python", required=True)
    run.add_argument("--worker", required=True)
    run.add_argument("--contract", default=str(_CONTRACT_DEFAULT))
    run.add_argument("--device", default="cuda:0")
    run.set_defaults(func=cmd_run)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except h11.H11Error as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2), file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001
        print(
            json.dumps(
                {"ok": False, "error": str(error), "traceback": traceback.format_exc(limit=8)},
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
