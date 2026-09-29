from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from markitdown import MarkItDown

from .models import ParsedDocument, ParsedTable
from .tabular import _extract_tables_from_markdown, _html_table_to_markdown

logger = logging.getLogger("parser")

# Single shared instance; MarkItDown is stateless and cheap to keep around.
_markitdown = MarkItDown()


# ----------------------------------------------------------------------------
# Parser implementations
# ----------------------------------------------------------------------------
def _extract_title(parser_title: str | None, markdown: str, fname: str) -> str:
    """Prefer parser-provided title, then first H1, then filename stem."""
    if parser_title:
        return parser_title.strip()
    m = re.search(r"^#\s+(.+)$", markdown, re.MULTILINE)
    if m:
        return m.group(1).strip()
    return Path(fname).stem


def _parse_with_markitdown(path: Path, fname: str, mime: str) -> ParsedDocument | None:
    """
    MarkItDown is the preferred parser: fast, handles 25+ formats, produces
    clean markdown with proper heading hierarchy and table rendering.
    Returns None on failure so the caller can try the fallback.
    """
    try:
        result = _markitdown.convert(str(path))
        markdown = (result.text_content or "").strip()
        if not markdown:
            return None

        title = _extract_title(result.title, markdown, fname)
        tables = _extract_tables_from_markdown(markdown)
        return ParsedDocument(
            title=title,
            markdown=markdown,
            tables=tables,
            metadata={
                "parser": "markitdown",
                "mime_type": mime,
                "source_filename": fname,
            },
        )
    except (KeyboardInterrupt, SystemExit, GeneratorExit):
        raise
    except BaseException as e:  # noqa: BLE001
        # Catch BaseException, not just Exception: markitdown's
        # UnsupportedFormatException does NOT subclass Exception in 0.0.1a4, so a
        # plain `except Exception` lets it escape to a hard 500. We genuinely want
        # "markitdown failed for ANY reason -> try the fallback", so we swallow
        # everything except the control-flow signals re-raised above.
        logger.warning("markitdown failed for %s (%s): %s", fname, mime, e)
        return None


def _parse_general(path: Path, fname: str, mime: str) -> ParsedDocument:
    return _parse_with_markitdown(path, fname, mime) or _parse_with_unstructured(
        path, fname, mime
    )


# OCR is the one parse that can exhaust the sidecar (CPU for minutes, GBs of
# layout-model memory). Bound how many run at once; a request that cannot get a
# slot in time gets 503, which the worker treats as retryable.
_OCR_MAX_CONCURRENT = max(1, int(os.environ.get("PARSER_MAX_CONCURRENT_OCR", "1")))
_OCR_WAIT_SECONDS = float(os.environ.get("PARSER_OCR_WAIT_SECONDS", "120"))
_OCR_SLOTS = threading.BoundedSemaphore(_OCR_MAX_CONCURRENT)
_OCR_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".heic"}


def _has_text(elements: Any) -> bool:
    return any((getattr(el, "text", None) or "").strip() for el in elements)


def _ocr_applicable(mime: str, fname: str) -> bool:
    return (
        mime == "application/pdf"
        or mime.startswith("image/")
        or Path(fname).suffix.lower() in _OCR_EXTENSIONS
    )


def _partition_with_ocr(partition: Any, path: Path, fname: str) -> Any:
    if not _OCR_SLOTS.acquire(timeout=_OCR_WAIT_SECONDS):
        logger.warning("OCR capacity exhausted; deferring %s", fname)
        raise HTTPException(status_code=503, detail="parser busy: OCR capacity exhausted")
    try:
        return partition(filename=str(path), strategy="hi_res")
    finally:
        _OCR_SLOTS.release()


# Substrings (matched case-insensitively against a parser exception message)
# that indicate a genuinely unsupported/undetectable file format rather than an
# unexpected internal error. unstructured raises, e.g.,
# "Invalid file <path>. The FileType.UNK file type is not supported in partition."
# Kept deliberately specific. "invalid file" alone was too broad (it matches
# unrelated errors like "invalid file handle/object"); unstructured's real
# unsupported-format message is "... file type is not supported in partition",
# which "not supported" already covers.
_UNSUPPORTED_FORMAT_MARKERS = (
    "not supported",
    "unsupported file",
    "unsupportedformat",
)


def _is_unsupported_format_error(exc: BaseException) -> bool:
    """True when an exception means the file format simply can't be parsed."""
    msg = str(exc).lower()
    return any(marker in msg for marker in _UNSUPPORTED_FORMAT_MARKERS)


def _parse_with_unstructured(path: Path, fname: str, mime: str) -> ParsedDocument:
    """
    Fallback parser. Heavier (slow first import, OCR is expensive) but handles
    scanned PDFs, images, exotic formats, and is more permissive on malformed docs.
    """
    try:
        # Lazy import — Unstructured has slow startup and ~500MB of models.
        from unstructured.partition.auto import partition

        # Cheap text-layer extraction first. Unstructured's default may choose
        # `hi_res` (layout model + OCR) on its own, which is slow and memory
        # hungry; only a PDF or image that yields no text at all needs OCR.
        elements = partition(filename=str(path), strategy="fast")
        if not _has_text(elements) and _ocr_applicable(mime, fname):
            elements = _partition_with_ocr(partition, path, fname)
        markdown_lines: list[str] = []
        tables: list[ParsedTable] = []
        title: str | None = None

        for el in elements:
            category = el.category if hasattr(el, "category") else type(el).__name__
            text = (el.text or "").strip() if hasattr(el, "text") else ""
            if not text:
                continue

            if category == "Title" and title is None:
                title = text
                markdown_lines.append(f"# {text}")
            elif category in ("Header", "Heading"):
                markdown_lines.append(f"## {text}")
            elif category == "Table":
                # Unstructured exposes HTML tables in metadata; convert to markdown if present.
                table_md = _html_table_to_markdown(
                    getattr(el.metadata, "text_as_html", None) or ""
                )
                if table_md:
                    tables.append(ParsedTable(markdown=table_md))
                    markdown_lines.append(table_md)
                else:
                    markdown_lines.append(text)
            elif category == "ListItem":
                markdown_lines.append(f"- {text}")
            else:
                markdown_lines.append(text)

        markdown = "\n\n".join(markdown_lines).strip()
        if not markdown:
            raise HTTPException(status_code=422, detail="no extractable content")

        return ParsedDocument(
            title=title or Path(fname).stem,
            markdown=markdown,
            tables=tables,
            metadata={
                "parser": "unstructured",
                "mime_type": mime,
                "source_filename": fname,
            },
        )
    except HTTPException:
        raise
    except (KeyboardInterrupt, SystemExit, GeneratorExit):
        raise
    except BaseException as e:  # noqa: BLE001 — see markitdown note below
        # MarkItDown already returned None for this file, so reaching an error
        # here means neither parser could handle it. If the failure is an
        # unsupported/undetectable format, treat it as a skip (422) so a single
        # junk item (e.g. an extensionless `.bin`/`.sndr` SharePoint file) does
        # not poison the whole document as a hard failure. Genuine internal
        # errors (OCR crash, OOM, import failure) still surface as 500.
        # BaseException (minus control-flow signals) mirrors the markitdown path:
        # some unstructured/dep errors also bypass `Exception`.
        if _is_unsupported_format_error(e):
            logger.warning("unsupported format for %s (%s): %s", fname, mime, e)
            raise HTTPException(
                status_code=422, detail=f"unsupported document format: {e}"
            ) from e
        logger.error("unstructured failed for %s (%s): %s", fname, mime, e)
        raise HTTPException(status_code=500, detail=f"parse failed: {e}") from e
