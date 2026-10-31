"""Fixed-host URL policy for bounded Open Images and Flickr acquisition."""
from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

from validation import CurateError, InfrastructureFailure

HTTP_TIMEOUT_SECONDS = 30
MAX_FLICKR_PAGE_BYTES = 2 * 1024 * 1024
MAX_JPEG_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_ZIP_MEMBER_COMPRESSED_BYTES = 5 * 1024 * 1024
MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024
MAX_ZIP_ENTRIES = 50_000

OPEN_IMAGES_JPEG_HOST = "open-images-dataset.s3.amazonaws.com"
FLICKR_HOSTS = frozenset({"www.flickr.com", "flickr.com"})
MASK_ZIP_HOST = "storage.googleapis.com"
MASK_ZIP_PREFIX = "/openimages/v5/validation-masks/validation-masks-"
MASK_ZIP_SUFFIX = ".zip"
OPEN_IMAGES_JPEG_PREFIX = "/validation/"
IMAGE_ID_RE = re.compile(r"^[0-9a-f]{16}$")
MASK_SHARD_RE = re.compile(r"^[0-9a-f]$")


@dataclass(frozen=True)
class HttpResponse:
    url: str
    status: int
    body: bytes
    headers: dict[str, str]


class HttpTransport(Protocol):
    def fetch(self, url: str, *, byte_limit: int, range_header: str | None = None) -> HttpResponse:
        ...


def http_status_is_infrastructure_stop(status: int) -> bool:
    return status in (408, 425, 429) or 500 <= status <= 599


def _parse_https_url(url: str, *, label: str) -> tuple[str, str, str]:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise CurateError(f"{label} must use https")
    if parsed.username or parsed.password:
        raise CurateError(f"{label} must not include userinfo")
    if parsed.query or parsed.fragment:
        raise CurateError(f"{label} must not include query or fragment")
    if not parsed.netloc or not parsed.path:
        raise CurateError(f"{label} must include host and path")
    host = parsed.netloc.lower()
    if host.startswith("[") or ":" in host:
        raise CurateError(f"{label} must not include explicit port")
    return host, parsed.path, url


def _reject_private_host(host: str, *, label: str) -> None:
    lowered = host.lower()
    if lowered in {"localhost", "127.0.0.1", "::1"}:
        raise CurateError(f"{label} targets localhost")
    try:
        ip = ipaddress.ip_address(lowered)
    except ValueError:
        return
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
        raise CurateError(f"{label} targets private or non-public address")


def validate_open_images_jpeg_url(url: str, *, image_id: str) -> str:
    host, path, normalized = _parse_https_url(url, label="Open Images JPEG URL")
    _reject_private_host(host, label="Open Images JPEG URL")
    if host != OPEN_IMAGES_JPEG_HOST:
        raise CurateError("Open Images JPEG host is not allowlisted")
    expected = f"{OPEN_IMAGES_JPEG_PREFIX}{image_id}.jpg"
    if path != expected:
        raise CurateError("Open Images JPEG path does not match ImageID")
    if not IMAGE_ID_RE.fullmatch(image_id):
        raise CurateError("ImageID must be 16 lowercase hex chars")
    return normalized


def build_open_images_jpeg_url(image_id: str) -> str:
    validate_open_images_jpeg_url(
        f"https://{OPEN_IMAGES_JPEG_HOST}{OPEN_IMAGES_JPEG_PREFIX}{image_id}.jpg",
        image_id=image_id,
    )
    return f"https://{OPEN_IMAGES_JPEG_HOST}{OPEN_IMAGES_JPEG_PREFIX}{image_id}.jpg"


def validate_flickr_landing_url(url: str) -> str:
    host, path, normalized = _parse_https_url(url, label="Flickr landing URL")
    _reject_private_host(host, label="Flickr landing URL")
    if host not in FLICKR_HOSTS:
        raise CurateError("Flickr landing host is not allowlisted")
    parts = [part for part in path.split("/") if part]
    if len(parts) != 3 or parts[0] != "photos":
        raise CurateError("Flickr landing path must be /photos/{owner}/{photo_id}")
    if not parts[2].isdigit():
        raise CurateError("Flickr photo id must be numeric")
    return normalized


def validate_mask_archive_url(url: str, *, shard: str) -> str:
    host, path, normalized = _parse_https_url(url, label="mask archive URL")
    _reject_private_host(host, label="mask archive URL")
    if host != MASK_ZIP_HOST:
        raise CurateError("mask archive host is not allowlisted")
    expected = f"{MASK_ZIP_PREFIX}{shard}{MASK_ZIP_SUFFIX}"
    if path != expected:
        raise CurateError("mask archive path is not allowlisted")
    if not MASK_SHARD_RE.fullmatch(shard):
        raise CurateError("mask archive shard must be one lowercase hex char")
    return normalized


def build_mask_archive_url(shard: str) -> str:
    url = f"https://{MASK_ZIP_HOST}{MASK_ZIP_PREFIX}{shard}{MASK_ZIP_SUFFIX}"
    validate_mask_archive_url(url, shard=shard)
    return url


def validate_resolved_url_unchanged(requested: str, resolved: str, *, validator) -> str:
    if requested != resolved:
        raise CurateError("redirect or rewritten URL is not permitted")
    return validator(resolved)


def validate_https_fetch_url(url: str) -> None:
    host, path, _normalized = _parse_https_url(url, label="HTTPS fetch URL")
    _reject_private_host(host, label="HTTPS fetch URL")
    if host == OPEN_IMAGES_JPEG_HOST:
        if not path.startswith(OPEN_IMAGES_JPEG_PREFIX) or not path.endswith(".jpg"):
            raise CurateError("Open Images JPEG path is not allowlisted")
        image_id = path[len(OPEN_IMAGES_JPEG_PREFIX) : -len(".jpg")]
        validate_open_images_jpeg_url(url, image_id=image_id)
        return
    if host in FLICKR_HOSTS:
        validate_flickr_landing_url(url)
        return
    if host == MASK_ZIP_HOST:
        if not path.startswith(MASK_ZIP_PREFIX) or not path.endswith(MASK_ZIP_SUFFIX):
            raise CurateError("mask archive path is not allowlisted")
        shard = path[len(MASK_ZIP_PREFIX) : -len(MASK_ZIP_SUFFIX)]
        validate_mask_archive_url(url, shard=shard)
        return
    raise CurateError("HTTPS fetch host is not allowlisted")


class _RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise CurateError("redirect is not permitted")


def _socket_from_response(response) -> socket.socket | None:
    fp = getattr(response, "fp", None)
    if fp is None:
        return None
    raw = getattr(fp, "raw", None)
    if raw is None:
        return None
    sock = getattr(raw, "_sock", None)
    return sock if isinstance(sock, socket.socket) else None


def _set_read_timeout(sock: socket.socket | None, deadline: float) -> None:
    if sock is None:
        return
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise InfrastructureFailure("http-transport-failure")
    try:
        sock.settimeout(remaining)
    except OSError as error:
        raise InfrastructureFailure("http-transport-failure") from error


def _remaining_content_length_bytes(response) -> int | None:
    if getattr(response, "chunked", False):
        return None
    length = getattr(response, "length", None)
    if isinstance(length, int) and length > 0:
        return length
    return None


def _body_fully_delivered(response) -> bool:
    if not hasattr(response, "fp"):
        return False
    if response.fp is None:
        return True
    length = getattr(response, "length", None)
    if isinstance(length, int) and length <= 0:
        return True
    return False


def _read_body_chunk(response, size: int, *, sock: socket.socket | None) -> bytes:
    if size <= 0:
        return b""
    read1 = getattr(response, "read1", None)
    if callable(read1):
        return read1(size)
    readchunk = getattr(response, "readchunk", None)
    if callable(readchunk):
        return readchunk(size)
    if sock is None:
        raise InfrastructureFailure("http-transport-failure")
    read = getattr(response, "read", None)
    if not callable(read):
        raise InfrastructureFailure("http-transport-failure")
    return read(size)


def read_http_body_with_deadline(
    response,
    *,
    byte_limit: int,
    deadline: float,
) -> bytes:
    read1 = getattr(response, "read1", None)
    readchunk = getattr(response, "readchunk", None)
    if (
        _socket_from_response(response) is None
        and not callable(read1)
        and not callable(readchunk)
    ):
        raise InfrastructureFailure("http-transport-failure")
    chunks: list[bytes] = []
    total = 0
    while True:
        if time.monotonic() >= deadline:
            raise InfrastructureFailure("http-transport-failure")
        sock = _socket_from_response(response)
        try:
            _set_read_timeout(sock, deadline)
            piece = _read_body_chunk(
                response,
                min(65536, byte_limit + 1 - total),
                sock=sock,
            )
        except OSError as error:
            raise InfrastructureFailure("http-transport-failure") from error
        except http.client.HTTPException as error:
            raise InfrastructureFailure("http-transport-failure") from error
        if time.monotonic() >= deadline:
            raise InfrastructureFailure("http-transport-failure")
        if not piece:
            if _remaining_content_length_bytes(response) is not None:
                raise InfrastructureFailure("http-transport-failure")
            break
        chunks.append(piece)
        total += len(piece)
        if total > byte_limit:
            raise CurateError("HTTP response exceeds byte cap")
        if _body_fully_delivered(response):
            break
    return b"".join(chunks)


class UrllibHttpTransport:
    def __init__(self, *, timeout_seconds: int = HTTP_TIMEOUT_SECONDS) -> None:
        self._timeout_seconds = timeout_seconds
        handlers = [
            _RejectRedirectHandler(),
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(),
        ]
        self._opener = urllib.request.build_opener(*handlers)

    def fetch(self, url: str, *, byte_limit: int, range_header: str | None = None) -> HttpResponse:
        if byte_limit < 0:
            raise CurateError("byte limit must be nonnegative")
        validate_https_fetch_url(url)
        request = urllib.request.Request(url, method="GET")
        request.add_header("Accept", "*/*")
        if range_header is not None:
            request.add_header("Range", range_header)
        deadline = time.monotonic() + self._timeout_seconds
        try:
            sock_timeout = max(0.001, deadline - time.monotonic())
            with self._opener.open(request, timeout=sock_timeout) as response:
                status = getattr(response, "status", None) or response.getcode()
                resolved = response.geturl()
                if resolved != url:
                    raise CurateError("redirect or rewritten URL is not permitted")
                body = read_http_body_with_deadline(
                    response,
                    byte_limit=byte_limit,
                    deadline=deadline,
                )
                headers = {key.lower(): value for key, value in response.headers.items()}
                return HttpResponse(url=url, status=int(status), body=body, headers=headers)
        except InfrastructureFailure:
            raise
        except urllib.error.HTTPError as error:
            fp = error.fp
            if fp is not None:
                try:
                    fp.close()
                except OSError:
                    pass
            return HttpResponse(url=url, status=int(error.code), body=b"", headers={})
        except (urllib.error.URLError, socket.timeout, TimeoutError) as error:
            raise InfrastructureFailure("http-transport-failure") from error
