"""
OCR strategy and concurrency for the Unstructured fallback.

Unstructured's default strategy may pick `hi_res` (layout model + OCR) for a
PDF, which is slow and memory-hungry. The sidecar tries the cheap `fast`
text-layer extraction first and only OCRs PDFs/images that yield no text, and
never runs more concurrent OCR parses than PARSER_MAX_CONCURRENT_OCR allows.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main

client = TestClient(main.app)


def _install_partition(monkeypatch: pytest.MonkeyPatch, partition) -> None:
    pkg = types.ModuleType("unstructured")
    sub = types.ModuleType("unstructured.partition")
    auto = types.ModuleType("unstructured.partition.auto")
    auto.partition = partition  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "unstructured", pkg)
    monkeypatch.setitem(sys.modules, "unstructured.partition", sub)
    monkeypatch.setitem(sys.modules, "unstructured.partition.auto", auto)


def _element(text: str, category: str = "NarrativeText"):
    return SimpleNamespace(text=text, category=category, metadata=SimpleNamespace())


@pytest.fixture(autouse=True)
def _markitdown_declines(monkeypatch: pytest.MonkeyPatch) -> None:
    def convert(_path: str):
        raise RuntimeError("markitdown cannot read this")

    monkeypatch.setattr(main._markitdown, "convert", convert)


def _post_pdf():
    return client.post(
        "/parse",
        files={"file": ("scan.pdf", b"%PDF-1.4 fake", "application/pdf")},
        data={"filename": "scan.pdf", "mime_type": "application/pdf"},
    )


def test_fast_strategy_first_and_no_ocr_when_it_finds_text(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def partition(filename: str, **kwargs):
        calls.append(kwargs.get("strategy", "<default>"))
        return [_element("Engagement letter procedure text.")]

    _install_partition(monkeypatch, partition)
    resp = _post_pdf()
    assert resp.status_code == 200
    assert calls == ["fast"]


def test_ocr_only_when_fast_yields_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def partition(filename: str, **kwargs):
        strategy = kwargs.get("strategy")
        calls.append(strategy)
        return [] if strategy == "fast" else [_element("Text recovered by OCR.")]

    _install_partition(monkeypatch, partition)
    resp = _post_pdf()
    assert resp.status_code == 200
    assert calls == ["fast", "hi_res"]
    assert "recovered by OCR" in resp.json()["markdown"]


def test_non_pdf_formats_are_never_ocrd(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def partition(filename: str, **kwargs):
        calls.append(kwargs.get("strategy"))
        return []

    _install_partition(monkeypatch, partition)
    resp = client.post(
        "/parse",
        files={"file": ("notes.docx", b"PK fake", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
        data={"filename": "notes.docx", "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    )
    assert resp.status_code == 422
    assert calls == ["fast"]


def test_ocr_busy_returns_503(monkeypatch: pytest.MonkeyPatch) -> None:
    def partition(filename: str, **kwargs):
        return [] if kwargs.get("strategy") == "fast" else [_element("x")]

    _install_partition(monkeypatch, partition)

    class Full:
        def acquire(self, timeout: float | None = None) -> bool:
            return False

        def release(self) -> None:  # pragma: no cover - never acquired
            raise AssertionError("released a slot that was never acquired")

    monkeypatch.setattr(main, "_OCR_SLOTS", Full())
    resp = _post_pdf()
    assert resp.status_code == 503
