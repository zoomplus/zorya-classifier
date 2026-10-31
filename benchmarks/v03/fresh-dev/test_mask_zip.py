#!/usr/bin/env python3
"""Focused offline tests for mask_zip range validation and EOCD hardening."""
from __future__ import annotations

import importlib.util
import io
import struct
import sys
import tempfile
import unittest
import zlib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


validation = load_module("fresh_dev_validation_mask_zip", "validation.py")
sys.modules["validation"] = validation
http_policy = load_module("fresh_dev_http_policy_mask_zip", "http_policy.py")
mask_zip = load_module("fresh_dev_mask_zip_focused", "mask_zip.py")


def mask_png(width: int, height: int) -> bytes:
    from PIL import Image

    image = Image.new("L", (width, height), 0)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def write_zip_with_member(path: Path, member_name: str, payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member_name, payload)
    data = buffer.getvalue()
    path.write_bytes(data)
    return data


def patch_eocd(archive_bytes: bytes, *, offset: int, value: bytes) -> bytes:
    data = bytearray(archive_bytes)
    eocd_index = data.rfind(b"PK\x05\x06")
    if eocd_index < 0:
        raise ValueError("EOCD missing")
    data[eocd_index + offset : eocd_index + offset + len(value)] = value
    return bytes(data)


class ContentRangeSuffixTests(unittest.TestCase):
    def test_valid_suffix_interval_accepted(self) -> None:
        total = 1000
        suffix_len = 100
        start = total - suffix_len
        end = total - 1
        body_length = end - start + 1
        mask_zip._validate_content_range(
            {"content-range": f"bytes {start}-{end}/{total}"},
            range_header=f"bytes=-{suffix_len}",
            body_length=body_length,
            status=206,
        )

    def test_suffix_star_total_rejected(self) -> None:
        with self.assertRaises(validation.CurateError):
            mask_zip._validate_content_range(
                {"content-range": "bytes 900-999/*"},
                range_header="bytes=-100",
                body_length=100,
                status=206,
            )

    def test_suffix_wrong_start_rejected(self) -> None:
        with self.assertRaises(validation.CurateError):
            mask_zip._validate_content_range(
                {"content-range": "bytes 0-999/1000"},
                range_header="bytes=-100",
                body_length=1000,
                status=206,
            )

    def test_suffix_wrong_end_rejected(self) -> None:
        with self.assertRaises(validation.CurateError):
            mask_zip._validate_content_range(
                {"content-range": "bytes 900-998/1000"},
                range_header="bytes=-100",
                body_length=99,
                status=206,
            )


class EocdHardeningTests(unittest.TestCase):
    def _fetch_index_with_archive(self, archive_bytes: bytes):
        image_id = "0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        url = http_policy.build_mask_archive_url(image_id[0].lower())

        class RangedTransport:
            def fetch(self, fetch_url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                if fetch_url != url:
                    raise validation.CurateError("unexpected URL")
                total = len(archive_bytes)
                if range_header and range_header.startswith("bytes=-"):
                    suffix_len = int(range_header.split("-")[-1])
                    start = max(0, total - suffix_len)
                    end = total - 1
                    body = archive_bytes[start : end + 1]
                    headers = {"content-range": f"bytes {start}-{end}/{total}"}
                    return http_policy.HttpResponse(fetch_url, 206, body, headers)
                start_s, end_s = range_header.removeprefix("bytes=").split("-")
                start = int(start_s)
                end = int(end_s)
                body = archive_bytes[start : end + 1]
                headers = {"content-range": f"bytes {start}-{end}/{total}"}
                return http_policy.HttpResponse(fetch_url, 206, body, headers)

        return mask_zip.read_mask_member_bytes(
            mask_basename=mask_path,
            image_id=image_id,
            transport=RangedTransport(),
            local_archive=None,
        )

    def test_multi_disk_eocd_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            image_id = "0123456789abcdef"
            member = f"{image_id}_mperson_abcd1234.png"
            base = write_zip_with_member(zip_path, member, mask_png(8, 8))
            archive = patch_eocd(base, offset=4, value=struct.pack("<H", 1))
            with self.assertRaises(validation.CurateError):
                self._fetch_index_with_archive(archive)

    def test_entry_count_mismatch_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            image_id = "0123456789abcdef"
            member = f"{image_id}_mperson_abcd1234.png"
            base = write_zip_with_member(zip_path, member, mask_png(8, 8))
            archive = patch_eocd(base, offset=8, value=struct.pack("<H", 2))
            with self.assertRaises(validation.CurateError):
                self._fetch_index_with_archive(archive)

    def test_zip64_entry_count_sentinel_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            image_id = "0123456789abcdef"
            member = f"{image_id}_mperson_abcd1234.png"
            base = write_zip_with_member(zip_path, member, mask_png(8, 8))
            archive = patch_eocd(base, offset=8, value=struct.pack("<H", 0xFFFF))
            archive = patch_eocd(archive, offset=10, value=struct.pack("<H", 0xFFFF))
            with self.assertRaises(validation.CurateError):
                self._fetch_index_with_archive(archive)

    def test_zip64_central_size_sentinel_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            image_id = "0123456789abcdef"
            member = f"{image_id}_mperson_abcd1234.png"
            base = write_zip_with_member(zip_path, member, mask_png(8, 8))
            archive = patch_eocd(base, offset=12, value=struct.pack("<I", 0xFFFFFFFF))
            with self.assertRaises(validation.CurateError):
                self._fetch_index_with_archive(archive)

    def test_zip64_central_offset_sentinel_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            image_id = "0123456789abcdef"
            member = f"{image_id}_mperson_abcd1234.png"
            base = write_zip_with_member(zip_path, member, mask_png(8, 8))
            archive = patch_eocd(base, offset=16, value=struct.pack("<I", 0xFFFFFFFF))
            with self.assertRaises(validation.CurateError):
                self._fetch_index_with_archive(archive)


def build_truncated_deflate_zip(path: Path, member_name: str, payload: bytes) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(member_name, payload)
    data = bytearray(buffer.getvalue())
    local_off = data.find(b"PK\x03\x04")
    name_len = struct.unpack("<H", data[local_off + 26 : local_off + 28])[0]
    extra_len = struct.unpack("<H", data[local_off + 28 : local_off + 30])[0]
    comp_size = struct.unpack("<I", data[local_off + 18 : local_off + 22])[0]
    data_start = local_off + 30 + name_len + extra_len
    data_end = data_start + comp_size
    del data[data_end - 1]
    new_comp_size = comp_size - 1
    data[local_off + 18 : local_off + 22] = struct.pack("<I", new_comp_size)
    central_off = data.find(b"PK\x01\x02")
    data[central_off + 20 : central_off + 24] = struct.pack("<I", new_comp_size)
    path.write_bytes(data)


class DeflateTruncationTests(unittest.TestCase):
    def test_truncated_deflate_stream_rejected(self) -> None:
        payload = mask_png(8, 8)
        compressor = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
        compressed = (compressor.compress(payload) + compressor.flush())[:-1]
        member = mask_zip.ZipMemberLocation(
            name="member.png",
            compression_method=8,
            compressed_size=len(compressed),
            uncompressed_size=len(payload),
            local_header_offset=0,
            crc32=zlib.crc32(payload) & 0xFFFFFFFF,
        )
        with self.assertRaises(validation.CurateError) as ctx:
            mask_zip._decompress_payload(compressed, member)
        self.assertIn("truncated", str(ctx.exception))

    def test_truncated_deflate_zip_member_read_rejected(self) -> None:
        image_id = "0123456789abcdef"
        member_name = f"{image_id}_mperson_abcd1234.png"
        payload = mask_png(8, 8)
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "valid.zip"
            write_zip_with_member(zip_path, member_name, payload)
            member = mask_zip._read_local_archive_index(zip_path)[Path(member_name).name]
            build_truncated_deflate_zip(zip_path, member_name, payload)
            with self.assertRaises(validation.CurateError):
                mask_zip._read_local_member(zip_path, member)


class ZipInfrastructureStopTests(unittest.TestCase):
    def test_central_directory_429_raises_infrastructure_failure(self) -> None:
        image_id = "0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        url = http_policy.build_mask_archive_url(image_id[0].lower())
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            write_zip_with_member(zip_path, mask_path, mask_png(8, 8))
            archive_bytes = zip_path.read_bytes()

            class Central429Transport:
                def fetch(self, fetch_url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                    total = len(archive_bytes)
                    if range_header and range_header.startswith("bytes=-"):
                        suffix_len = int(range_header.split("-")[-1])
                        start = max(0, total - suffix_len)
                        end = total - 1
                        body = archive_bytes[start : end + 1]
                        headers = {"content-range": f"bytes {start}-{end}/{total}"}
                        return http_policy.HttpResponse(fetch_url, 206, body, headers)
                    return http_policy.HttpResponse(fetch_url, 429, b"", {})

            with self.assertRaises(validation.InfrastructureFailure) as ctx:
                mask_zip._fetch_central_directory(Central429Transport(), url)
            self.assertEqual(ctx.exception.http_status, 429)

    def test_member_range_503_raises_infrastructure_failure(self) -> None:
        image_id = "0123456789abcdef"
        mask_path = f"{image_id}_mperson_abcd1234.png"
        url = http_policy.build_mask_archive_url(image_id[0].lower())
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "archive.zip"
            write_zip_with_member(zip_path, mask_path, mask_png(64, 48))
            archive_bytes = zip_path.read_bytes()
            entries = mask_zip._read_local_archive_index(zip_path)
            member = entries[Path(mask_path).name]
            request_count = {"member": 0}

            class Member503Transport:
                def fetch(self, fetch_url: str, *, byte_limit: int, range_header: str | None = None) -> http_policy.HttpResponse:
                    total = len(archive_bytes)
                    if range_header and range_header.startswith("bytes=-"):
                        suffix_len = int(range_header.split("-")[-1])
                        start = max(0, total - suffix_len)
                        end = total - 1
                        body = archive_bytes[start : end + 1]
                        headers = {"content-range": f"bytes {start}-{end}/{total}"}
                        return http_policy.HttpResponse(fetch_url, 206, body, headers)
                    request_count["member"] += 1
                    if request_count["member"] >= 2:
                        return http_policy.HttpResponse(fetch_url, 503, b"", {})
                    start_s, end_s = range_header.removeprefix("bytes=").split("-")
                    start = int(start_s)
                    end = int(end_s)
                    body = archive_bytes[start : end + 1]
                    headers = {"content-range": f"bytes {start}-{end}/{total}"}
                    return http_policy.HttpResponse(fetch_url, 206, body, headers)

            with self.assertRaises(validation.InfrastructureFailure) as ctx:
                mask_zip._fetch_remote_member(Member503Transport(), url, member)
            self.assertEqual(ctx.exception.http_status, 503)


if __name__ == "__main__":
    unittest.main()
