"""
Format routing + graceful-skip behaviour for /parse.

Covers the two fixes for the SharePoint extensionless-file blocker:
  (a) a generic/missing MIME (e.g. application/octet-stream) is re-sniffed from
      the bytes with libmagic so extensionless files route to the right
      parser/temp-suffix instead of a ".bin" file MarkItDown can't recognize;
  (b) when neither MarkItDown nor Unstructured can handle a file, /parse returns
      422 (skip) instead of 500 (hard failure), so one junk SharePoint item does
      not poison the whole document — while genuine internal errors stay 500.

These tests are hermetic: they monkeypatch `app.main.magic.from_buffer` and
`app.main._markitdown.convert`, and inject a fake `unstructured.partition.auto`,
so they need neither libmagic nor the ~500 MB unstructured models.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import (
    _GENERIC_MIMES,
    _is_unsupported_format_error,
    app,
)

client = TestClient(app)


class _MarkItDownUnsupported(BaseException):
    """Mirrors markitdown 0.0.1a4's UnsupportedFormatException, which subclasses
    BaseException (not Exception) — the bug that let it escape to a hard 500."""


def _post(content: bytes, filename: str, mime: str):
    files = {"file": (filename, content, mime)}
    data = {"filename": filename, "mime_type": mime}
    return client.post("/parse", files=files, data=data)


def _raise(exc: Exception):
    def _convert(*_args, **_kwargs):
        raise exc

    return _convert


def _install_fake_unstructured(monkeypatch: pytest.MonkeyPatch, partition) -> None:
    """Make the lazy `from unstructured.partition.auto import partition` resolve
    to a controllable stub without installing the real package."""
    pkg = types.ModuleType("unstructured")
    sub = types.ModuleType("unstructured.partition")
    auto = types.ModuleType("unstructured.partition.auto")
    auto.partition = partition  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "unstructured", pkg)
    monkeypatch.setitem(sys.modules, "unstructured.partition", sub)
    monkeypatch.setitem(sys.modules, "unstructured.partition.auto", auto)


# ── fix (b): unsupported-format classification helper ───────────────────────
@pytest.mark.parametrize(
    "msg",
    [
        "Invalid file /tmp/x.bin. The FileType.UNK file type is not supported in partition.",
        "unsupported file type",
        "UnsupportedFormatException: '.sndr'",
    ],
)
def test_unsupported_format_error_detected(msg: str) -> None:
    assert _is_unsupported_format_error(ValueError(msg)) is True


def test_internal_error_not_classified_as_unsupported() -> None:
    assert _is_unsupported_format_error(RuntimeError("connection reset by peer")) is False
    # "invalid file" alone must NOT be treated as an unsupported-format skip —
    # otherwise unrelated internal errors would be silently 422'd.
    assert _is_unsupported_format_error(OSError("invalid file handle")) is False


def test_octet_stream_and_empty_are_generic() -> None:
    assert "application/octet-stream" in _GENERIC_MIMES
    assert "" in _GENERIC_MIMES


# ── fix (a): a generic MIME is re-sniffed and drives the temp suffix ─────────
def test_generic_mime_is_resniffed_to_route_extensionless_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # libmagic sniffs the bytes as plain text even though the caller said
    # octet-stream and gave no extension.
    monkeypatch.setattr(main.magic, "from_buffer", lambda raw, mime=False: "text/plain")

    seen: dict[str, str] = {}

    def fake_convert(path: str):
        seen["path"] = path
        return SimpleNamespace(text_content="Hello world from a plain text file.", title=None)

    monkeypatch.setattr(main._markitdown, "convert", fake_convert)

    resp = _post(b"Hello world from a plain text file.\n", "document", "application/octet-stream")

    assert resp.status_code == 200
    # The sniffed text/plain MIME must have selected a .txt temp suffix, not .bin.
    assert seen["path"].endswith(".txt")
    assert "Hello world" in resp.json()["markdown"]


def test_specific_mime_is_trusted_without_sniffing(monkeypatch: pytest.MonkeyPatch) -> None:
    # A concrete caller MIME must NOT trigger a sniff (sniffing would be wrong here).
    def _boom(*_a, **_k):
        raise AssertionError("magic.from_buffer must not be called for a specific MIME")

    monkeypatch.setattr(main.magic, "from_buffer", _boom)
    monkeypatch.setattr(
        main._markitdown,
        "convert",
        lambda path: SimpleNamespace(text_content="# Hi\n\nbody", title="Hi"),
    )

    resp = _post(b"# Hi\n\nbody", "note.md", "text/markdown")
    assert resp.status_code == 200


# ── fix (b): 422 when both parsers reject; 500 only for real internal errors ─
def test_unsupported_binary_returns_422(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main.magic, "from_buffer", lambda raw, mime=False: "application/octet-stream")
    # MarkItDown rejects the format (broad except → None).
    monkeypatch.setattr(
        main._markitdown,
        "convert",
        _raise(_MarkItDownUnsupported("Could not convert '/tmp/x.bin'. ['.bin','.sndr'] not supported")),
    )

    def partition(filename: str, **_kwargs):
        raise ValueError(
            f"Invalid file {filename}. The FileType.UNK file type is not supported in partition."
        )

    _install_fake_unstructured(monkeypatch, partition)

    resp = _post(b"\x00\x01\x02rubbish\xff\xfe", "weird.bin", "application/octet-stream")
    assert resp.status_code == 422


def test_internal_unstructured_error_still_returns_500(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main.magic, "from_buffer", lambda raw, mime=False: "application/octet-stream")
    monkeypatch.setattr(
        main._markitdown,
        "convert",
        _raise(_MarkItDownUnsupported("Could not convert '/tmp/x.bin'. ['.bin','.sndr'] not supported")),
    )

    def partition(filename: str, **_kwargs):
        raise RuntimeError("OCR engine crashed mid-page")

    _install_fake_unstructured(monkeypatch, partition)

    resp = _post(b"\x00\x01\x02rubbish\xff\xfe", "weird.bin", "application/octet-stream")
    assert resp.status_code == 500


def test_control_flow_exception_not_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    # The broad BaseException catch must still let KeyboardInterrupt/SystemExit
    # propagate, otherwise the process becomes uninterruptible.
    monkeypatch.setattr(main.magic, "from_buffer", lambda raw, mime=False: "application/octet-stream")
    monkeypatch.setattr(main._markitdown, "convert", _raise(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        _post(b"whatever", "x.bin", "application/octet-stream")
