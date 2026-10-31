#!/usr/bin/env python3
"""Focused offline tests for http_policy transport hardening."""
from __future__ import annotations

import http.client
import importlib.util
import socket
import sys
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


validation = load_module("fresh_dev_validation_http_policy", "validation.py")
sys.modules["validation"] = validation
http_policy = load_module("fresh_dev_http_policy_focused", "http_policy.py")

ALLOWED_JPEG_URL = (
    "https://open-images-dataset.s3.amazonaws.com/validation/0123456789abcdef.jpg"
)


class _SlowTrickleFp:
    def __init__(self) -> None:
        self.closed = False

    def read(self, size: int = -1) -> bytes:
        time.sleep(5.0)
        return b"x" * 1024

    def close(self) -> None:
        self.closed = True


class HttpErrorFetchTests(unittest.TestCase):
    def test_http_error_does_not_wait_on_slow_body(self) -> None:
        slow_fp = _SlowTrickleFp()

        def raise_http_error(*_args, **_kwargs) -> None:
            raise urllib.error.HTTPError(
                ALLOWED_JPEG_URL,
                503,
                "Service Unavailable",
                {},
                slow_fp,
            )

        transport = http_policy.UrllibHttpTransport(timeout_seconds=30)
        opener = mock.Mock()
        opener.open.side_effect = raise_http_error
        transport._opener = opener

        start = time.monotonic()
        response = transport.fetch(ALLOWED_JPEG_URL, byte_limit=1024)
        elapsed = time.monotonic() - start

        self.assertEqual(response.status, 503)
        self.assertEqual(response.body, b"")
        self.assertLess(elapsed, 1.0)
        self.assertTrue(slow_fp.closed)

    def test_successful_response_deadline_still_infrastructure_failure(self) -> None:
        class SlowOkResponse:
            status = 200

            def getcode(self) -> int:
                return 200

            def geturl(self) -> str:
                return ALLOWED_JPEG_URL

            @property
            def headers(self):
                return {}

            def read1(self, size: int = -1) -> bytes:
                time.sleep(0.05)
                return b"x" * min(size, 1024)

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        transport = http_policy.UrllibHttpTransport(timeout_seconds=0.15)
        opener = mock.Mock()
        opener.open.return_value = SlowOkResponse()
        transport._opener = opener

        start = time.monotonic()
        with self.assertRaises(validation.InfrastructureFailure):
            transport.fetch(ALLOWED_JPEG_URL, byte_limit=1024 * 1024)
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, 1.0)


class ReadHttpBodyWithDeadlineTests(unittest.TestCase):
    def _read_http_message_body(self, message: bytes, *, deadline_seconds: float = 5.0) -> bytes:
        server_sock, client_sock = socket.socketpair()
        thread: threading.Thread | None = None
        try:

            def serve() -> None:
                try:
                    server_sock.sendall(message)
                finally:
                    server_sock.close()

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            response = http.client.HTTPResponse(client_sock)
            response.begin()
            deadline = time.monotonic() + deadline_seconds
            return http_policy.read_http_body_with_deadline(
                response,
                byte_limit=1024 * 1024,
                deadline=deadline,
            )
        finally:
            try:
                client_sock.close()
            finally:
                if thread is not None:
                    thread.join(timeout=2.0)

    def test_complete_content_length_body_via_real_http_response(self) -> None:
        body = b"hello-bytes"
        message = (
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body
        )
        self.assertEqual(self._read_http_message_body(message), body)

    def test_complete_chunked_body_via_real_http_response(self) -> None:
        body = b"chunked-payload"
        chunk = f"{len(body):x}\r\n".encode("ascii") + body + b"\r\n0\r\n\r\n"
        message = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + chunk
        self.assertEqual(self._read_http_message_body(message), body)

    def test_truncated_content_length_rejected(self) -> None:
        message = b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhel"
        with self.assertRaises(validation.InfrastructureFailure):
            self._read_http_message_body(message)

    def test_slow_trickle_body_read_expires(self) -> None:
        server_sock, client_sock = socket.socketpair()
        stop = threading.Event()
        bytes_sent_lock = threading.Lock()
        bytes_sent = 0
        thread: threading.Thread | None = None
        trickle_interval_seconds = 0.035
        content_length = 64
        try:

            def serve() -> None:
                nonlocal bytes_sent
                try:
                    header = (
                        b"HTTP/1.1 200 OK\r\n"
                        b"Content-Length: "
                        + str(content_length).encode("ascii")
                        + b"\r\n\r\n"
                    )
                    server_sock.sendall(header)
                    payload = b"x" * content_length
                    for index in range(len(payload)):
                        if stop.is_set():
                            break
                        time.sleep(trickle_interval_seconds)
                        if stop.is_set():
                            break
                        try:
                            server_sock.sendall(payload[index : index + 1])
                        except OSError:
                            break
                        with bytes_sent_lock:
                            bytes_sent += 1
                finally:
                    server_sock.close()

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            response = http.client.HTTPResponse(client_sock)
            response.begin()
            deadline = time.monotonic() + 0.25
            start = time.monotonic()
            with self.assertRaises(validation.InfrastructureFailure):
                http_policy.read_http_body_with_deadline(
                    response,
                    byte_limit=1024 * 1024,
                    deadline=deadline,
                )
            elapsed = time.monotonic() - start
            with bytes_sent_lock:
                sent = bytes_sent
            self.assertGreaterEqual(sent, 2)
            self.assertLess(sent, content_length)
            self.assertLess(elapsed, 2.0)
            self.assertGreaterEqual(elapsed, 0.1)
        finally:
            stop.set()
            try:
                client_sock.close()
            finally:
                if thread is not None:
                    thread.join(timeout=2.0)


if __name__ == "__main__":
    unittest.main()
