"""Bounded ZIP member reads for Open Images V5 validation mask shards."""
from __future__ import annotations

import re
import struct
import zlib
import zipfile
from dataclasses import dataclass
from pathlib import Path

from http_policy import (
    MAX_ZIP_CENTRAL_DIRECTORY_BYTES,
    MAX_ZIP_ENTRIES,
    MAX_ZIP_MEMBER_COMPRESSED_BYTES,
    HttpTransport,
    build_mask_archive_url,
    http_status_is_infrastructure_stop,
    validate_mask_archive_url,
)
from validation import CurateError, InfrastructureFailure

MAX_ZIP_MEMBER_DECOMPRESSED_BYTES = 8 * 1024 * 1024
EOCD_SEARCH_BYTES = 65557
LOCAL_HEADER_FIXED_SIZE = 30
_CONTENT_RANGE_RE = re.compile(r"^bytes (\d+)-(\d+)/(\d+|\*)$")


@dataclass(frozen=True)
class ZipMemberLocation:
    name: str
    compression_method: int
    compressed_size: int
    uncompressed_size: int
    local_header_offset: int
    crc32: int


def _parse_range_interval(range_header: str) -> tuple[int, int]:
    if range_header.startswith("bytes=-"):
        suffix_len = int(range_header.split("-")[-1])
        return -suffix_len, -1
    start_s, end_s = range_header.removeprefix("bytes=").split("-")
    return int(start_s), int(end_s)


def _validate_content_range(
    headers: dict[str, str],
    *,
    range_header: str,
    body_length: int,
    status: int,
) -> None:
    if range_header is None:
        return
    if status == 200:
        raise CurateError("HTTP server ignored Range request")
    if status != 206:
        return
    content_range = headers.get("content-range")
    if not content_range:
        raise CurateError("HTTP 206 missing Content-Range")
    match = _CONTENT_RANGE_RE.match(content_range.strip())
    if not match:
        raise CurateError("HTTP Content-Range malformed")
    start = int(match.group(1))
    end = int(match.group(2))
    total_token = match.group(3)
    if end < start:
        raise CurateError("HTTP Content-Range malformed")
    if body_length != end - start + 1:
        raise CurateError("HTTP Content-Range length mismatch")
    req_start, req_end = _parse_range_interval(range_header)
    if req_end == -1:
        suffix_len = -req_start
        if total_token == "*":
            raise CurateError("HTTP Content-Range suffix requires explicit total")
        total = int(total_token)
        if total <= 0:
            raise CurateError("HTTP Content-Range malformed")
        expected_start = max(0, total - suffix_len)
        if start != expected_start or end != total - 1:
            raise CurateError("HTTP Content-Range suffix mismatch")
        return
    if start != req_start or end != req_end:
        raise CurateError("HTTP Content-Range interval mismatch")


def _parse_central_directory(
    central: bytes,
    *,
    expected_entry_count: int | None = None,
) -> dict[str, ZipMemberLocation]:
    entries: dict[str, ZipMemberLocation] = {}
    offset = 0
    count = 0
    while offset + 46 <= len(central):
        if central[offset : offset + 4] != b"PK\x01\x02":
            raise CurateError("invalid ZIP central directory signature")
        count += 1
        if count > MAX_ZIP_ENTRIES:
            raise CurateError("ZIP entry cap exceeded")
        compression = struct.unpack("<H", central[offset + 10 : offset + 12])[0]
        crc32 = struct.unpack("<I", central[offset + 16 : offset + 20])[0]
        compressed_size = struct.unpack("<I", central[offset + 20 : offset + 24])[0]
        uncompressed_size = struct.unpack("<I", central[offset + 24 : offset + 28])[0]
        name_length = struct.unpack("<H", central[offset + 28 : offset + 30])[0]
        extra_length = struct.unpack("<H", central[offset + 30 : offset + 32])[0]
        comment_length = struct.unpack("<H", central[offset + 32 : offset + 34])[0]
        local_header_offset = struct.unpack("<I", central[offset + 42 : offset + 46])[0]
        name_start = offset + 46
        name_end = name_start + name_length
        if name_end > len(central):
            raise CurateError("truncated ZIP central directory entry")
        name = central[name_start:name_end].decode("utf-8")
        basename = Path(name).name
        if basename in entries:
            raise CurateError("duplicate ZIP member basename")
        if compression not in (0, 8):
            raise CurateError("unsupported ZIP compression method")
        if compressed_size > MAX_ZIP_MEMBER_COMPRESSED_BYTES:
            raise CurateError("ZIP member compressed size exceeds cap")
        if uncompressed_size > MAX_ZIP_MEMBER_DECOMPRESSED_BYTES:
            raise CurateError("ZIP member decompressed size exceeds cap")
        entries[basename] = ZipMemberLocation(
            name=name,
            compression_method=compression,
            compressed_size=compressed_size,
            uncompressed_size=uncompressed_size,
            local_header_offset=local_header_offset,
            crc32=crc32,
        )
        offset = name_end + extra_length + comment_length
    if offset != len(central):
        raise CurateError("ZIP central directory malformed trailing data")
    if expected_entry_count is not None and count != expected_entry_count:
        raise CurateError("ZIP central directory entry count mismatch")
    return entries


def _read_local_archive_index(path: Path) -> dict[str, ZipMemberLocation]:
    if path.is_symlink():
        raise CurateError("local mask archive must not be a symlink")
    resolved = path.resolve()
    with resolved.open("rb") as stream:
        with zipfile.ZipFile(stream) as archive:
            entries: dict[str, ZipMemberLocation] = {}
            for info in archive.infolist():
                basename = Path(info.filename).name
                if basename in entries:
                    raise CurateError("duplicate ZIP member basename")
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise CurateError("unsupported ZIP compression method")
                if info.compress_size > MAX_ZIP_MEMBER_COMPRESSED_BYTES:
                    raise CurateError("ZIP member compressed size exceeds cap")
                if info.file_size > MAX_ZIP_MEMBER_DECOMPRESSED_BYTES:
                    raise CurateError("ZIP member decompressed size exceeds cap")
                entries[basename] = ZipMemberLocation(
                    name=info.filename,
                    compression_method=info.compress_type,
                    compressed_size=info.compress_size,
                    uncompressed_size=info.file_size,
                    local_header_offset=info.header_offset,
                    crc32=info.CRC,
                )
            if len(entries) > MAX_ZIP_ENTRIES:
                raise CurateError("ZIP entry cap exceeded")
            return entries


def _raise_zip_http_status(status: int, *, label: str) -> None:
    if http_status_is_infrastructure_stop(status):
        raise InfrastructureFailure("http-infrastructure-stop", http_status=status)
    raise CurateError(f"{label} fetch failed")


def _enforce_bounded_response(
    response,
    *,
    range_header: str | None,
    expected_length: int,
    label: str,
) -> bytes:
    if response.status not in (200, 206):
        _raise_zip_http_status(response.status, label=label)
    _validate_content_range(
        response.headers,
        range_header=range_header,
        body_length=len(response.body),
        status=response.status,
    )
    body = response.body
    if len(body) != expected_length:
        raise CurateError(f"{label} response length mismatch")
    return body


def _fetch_central_directory(transport: HttpTransport, url: str) -> dict[str, ZipMemberLocation]:
    validate_mask_archive_url(url, shard=url.rsplit("-", 1)[-1].split(".", 1)[0])
    tail_range = f"bytes=-{EOCD_SEARCH_BYTES}"
    tail = transport.fetch(url, byte_limit=EOCD_SEARCH_BYTES, range_header=tail_range)
    if tail.status not in (200, 206):
        _raise_zip_http_status(tail.status, label="mask archive tail")
    _validate_content_range(
        tail.headers,
        range_header=tail_range,
        body_length=len(tail.body),
        status=tail.status,
    )
    tail_bytes = tail.body
    if len(tail_bytes) > EOCD_SEARCH_BYTES:
        raise CurateError("mask archive tail exceeds cap")
    eocd_index = tail_bytes.rfind(b"PK\x05\x06")
    if eocd_index < 0:
        raise CurateError("ZIP EOCD not found")
    eocd = tail_bytes[eocd_index:]
    if len(eocd) < 22:
        raise CurateError("truncated ZIP EOCD")
    disk_number = struct.unpack("<H", eocd[4:6])[0]
    central_dir_disk = struct.unpack("<H", eocd[6:8])[0]
    if disk_number != 0 or central_dir_disk != 0:
        raise CurateError("multi-disk ZIP archive is not supported")
    disk_entries = struct.unpack("<H", eocd[8:10])[0]
    cd_entries = struct.unpack("<H", eocd[10:12])[0]
    if disk_entries != cd_entries:
        raise CurateError("ZIP EOCD entry count mismatch")
    if disk_entries == 0xFFFF or cd_entries == 0xFFFF:
        raise CurateError("ZIP64 EOCD entry count is not supported")
    expected_count = cd_entries
    central_size = struct.unpack("<I", eocd[12:16])[0]
    central_offset = struct.unpack("<I", eocd[16:20])[0]
    if central_size == 0xFFFFFFFF or central_offset == 0xFFFFFFFF:
        raise CurateError("ZIP64 EOCD size or offset is not supported")
    if central_size > MAX_ZIP_CENTRAL_DIRECTORY_BYTES:
        raise CurateError("ZIP central directory exceeds cap")
    central_range = f"bytes={central_offset}-{central_offset + central_size - 1}"
    central = transport.fetch(url, byte_limit=central_size, range_header=central_range)
    central_bytes = _enforce_bounded_response(
        central,
        range_header=central_range,
        expected_length=central_size,
        label="mask archive central directory",
    )
    return _parse_central_directory(central_bytes, expected_entry_count=expected_count)


def _parse_local_header(local_bytes: bytes, member: ZipMemberLocation) -> bytes:
    if len(local_bytes) < LOCAL_HEADER_FIXED_SIZE:
        raise CurateError("truncated ZIP local header")
    if local_bytes[:4] != b"PK\x03\x04":
        raise CurateError("invalid ZIP local header signature")
    compression = struct.unpack("<H", local_bytes[8:10])[0]
    crc32 = struct.unpack("<I", local_bytes[14:18])[0]
    compressed_size = struct.unpack("<I", local_bytes[18:22])[0]
    uncompressed_size = struct.unpack("<I", local_bytes[22:26])[0]
    name_length = struct.unpack("<H", local_bytes[26:28])[0]
    extra_length = struct.unpack("<H", local_bytes[28:30])[0]
    name_start = LOCAL_HEADER_FIXED_SIZE
    name_end = name_start + name_length
    if name_end > len(local_bytes):
        raise CurateError("truncated ZIP local header name")
    name = local_bytes[name_start:name_end].decode("utf-8")
    if name != member.name:
        raise CurateError("ZIP local header name mismatch")
    if compression != member.compression_method:
        raise CurateError("ZIP local header compression mismatch")
    if compressed_size != member.compressed_size or uncompressed_size != member.uncompressed_size:
        raise CurateError("ZIP local header size mismatch")
    if crc32 != member.crc32:
        raise CurateError("ZIP local header CRC mismatch")
    data_start = name_end + extra_length
    data_end = data_start + compressed_size
    if data_end > len(local_bytes):
        raise CurateError("truncated ZIP compressed payload")
    return local_bytes[data_start:data_end]


def _decompress_payload(compressed: bytes, member: ZipMemberLocation) -> bytes:
    declared = member.uncompressed_size
    cap = MAX_ZIP_MEMBER_DECOMPRESSED_BYTES
    max_length = min(declared, cap) + 1
    if member.compression_method == 0:
        payload = compressed
        if len(payload) > max_length - 1:
            raise CurateError("ZIP member decompressed size exceeds cap")
    elif member.compression_method == 8:
        decompressor = zlib.decompressobj(-zlib.MAX_WBITS)
        try:
            payload = decompressor.decompress(compressed, max_length)
        except zlib.error as error:
            raise CurateError("ZIP deflate decode failed") from error
        if len(payload) >= max_length:
            raise CurateError("ZIP member decompressed size exceeds cap")
        if decompressor.unused_data:
            raise CurateError("ZIP deflate unused_data")
        if decompressor.unconsumed_tail:
            raise CurateError("ZIP deflate unconsumed_tail")
        try:
            extra = decompressor.decompress(b"", 1)
        except zlib.error as error:
            raise CurateError("ZIP deflate decode failed") from error
        if extra:
            raise CurateError("ZIP deflate output overflow")
        if not decompressor.eof:
            raise CurateError("ZIP deflate stream truncated")
        if decompressor.unused_data or decompressor.unconsumed_tail:
            raise CurateError("ZIP deflate stream incomplete")
    else:
        raise CurateError("unsupported ZIP compression method")
    if len(payload) > cap:
        raise CurateError("ZIP member decompressed size exceeds cap")
    if len(payload) != declared:
        raise CurateError("ZIP member decompressed size mismatch")
    crc_actual = zlib.crc32(payload) & 0xFFFFFFFF
    if crc_actual != member.crc32:
        raise CurateError("ZIP member CRC mismatch")
    return payload


def _fetch_remote_member(transport: HttpTransport, url: str, member: ZipMemberLocation) -> bytes:
    prefix_range = (
        f"bytes={member.local_header_offset}-{member.local_header_offset + LOCAL_HEADER_FIXED_SIZE - 1}"
    )
    prefix_response = transport.fetch(
        url,
        byte_limit=LOCAL_HEADER_FIXED_SIZE,
        range_header=prefix_range,
    )
    prefix_bytes = _enforce_bounded_response(
        prefix_response,
        range_header=prefix_range,
        expected_length=LOCAL_HEADER_FIXED_SIZE,
        label="mask archive local header prefix",
    )
    name_length = struct.unpack("<H", prefix_bytes[26:28])[0]
    extra_length = struct.unpack("<H", prefix_bytes[28:30])[0]
    if name_length != len(member.name):
        raise CurateError("ZIP local header name length mismatch")
    total_span = LOCAL_HEADER_FIXED_SIZE + name_length + extra_length + member.compressed_size
    full_range = f"bytes={member.local_header_offset}-{member.local_header_offset + total_span - 1}"
    full_response = transport.fetch(url, byte_limit=total_span, range_header=full_range)
    full_bytes = _enforce_bounded_response(
        full_response,
        range_header=full_range,
        expected_length=total_span,
        label="mask archive member span",
    )
    compressed = _parse_local_header(full_bytes, member)
    return _decompress_payload(compressed, member)


def _read_local_member(path: Path, member: ZipMemberLocation) -> bytes:
    with path.open("rb") as stream:
        stream.seek(member.local_header_offset)
        prefix = stream.read(LOCAL_HEADER_FIXED_SIZE)
        if len(prefix) != LOCAL_HEADER_FIXED_SIZE:
            raise CurateError("truncated ZIP local header prefix")
        name_length = struct.unpack("<H", prefix[26:28])[0]
        extra_length = struct.unpack("<H", prefix[28:30])[0]
        total_span = LOCAL_HEADER_FIXED_SIZE + name_length + extra_length + member.compressed_size
        stream.seek(member.local_header_offset)
        full_bytes = stream.read(total_span)
    if len(full_bytes) != total_span:
        raise CurateError("truncated ZIP local member span")
    compressed = _parse_local_header(full_bytes, member)
    return _decompress_payload(compressed, member)


def read_mask_member_bytes(
    *,
    mask_basename: str,
    image_id: str,
    transport: HttpTransport | None,
    local_archive: Path | None,
) -> bytes:
    shard = image_id[0].lower()
    if local_archive is not None:
        entries = _read_local_archive_index(local_archive)
    else:
        if transport is None:
            raise CurateError("HTTP transport required when local mask archive is absent")
        url = build_mask_archive_url(shard)
        try:
            entries = _fetch_central_directory(transport, url)
        except InfrastructureFailure:
            raise
    member = entries.get(mask_basename)
    if member is None:
        raise CurateError("mask member not found in archive index")
    if Path(member.name).name != mask_basename:
        raise CurateError("mask member path basename mismatch")
    if local_archive is not None:
        return _read_local_member(local_archive.resolve(), member)
    url = build_mask_archive_url(shard)
    try:
        return _fetch_remote_member(transport, url, member)
    except InfrastructureFailure:
        raise
