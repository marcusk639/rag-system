"""
Document parsing sidecar.

Exposes a single endpoint, POST /parse, that accepts a binary document and
returns a normalized JSON representation:

    {
      "title": "...",
      "markdown": "...",      # cleaned markdown of the whole document
      "tables": [             # tables extracted in markdown form
        {"markdown": "...", "caption": "..."},
        ...
      ],
      "metadata": {           # parser-derived metadata; merged with source metadata
        "page_count": 12,
        "language": "en",
        ...
      }
    }

Parsing strategy:
  1. Try MarkItDown first — fast, broad format coverage, no OCR.
  2. Fall back to Unstructured if MarkItDown can't handle it (e.g. scanned PDFs).

MarkItDown sources:        https://github.com/microsoft/markitdown
Unstructured sources:      https://github.com/Unstructured-IO/unstructured
"""

from __future__ import annotations

import hmac
import logging
import os
import re
import tempfile
from pathlib import Path

import magic
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from .models import ParsedDocument, ParsedTable
from .parsing import _markitdown, _parse_general
from .tabular import _parse_csv, _parse_xlsx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("parser")

# Cap accepted upload size. 100 MB is large enough for any reasonable office
# document (PDFs with high-res images, large Excel workbooks) while making
# accidental or malicious oversized uploads cheap to reject.
MAX_UPLOAD_BYTES = int(os.environ.get("PARSER_MAX_UPLOAD_BYTES", 100 * 1024 * 1024))

# MIME values that carry no routing information. SharePoint (and other
# connectors) frequently hand us a generic `application/octet-stream` — or
# nothing — for items it can't classify. Trusting that value routes an
# extensionless file to a ".bin" temp suffix that MarkItDown can't recognize, so
# when the caller-supplied MIME is one of these we sniff the actual bytes with
# libmagic instead.
_GENERIC_MIMES = {"", "application/octet-stream", "binary/octet-stream"}

_sentry_dsn = os.environ.get("SENTRY_DSN")
if _sentry_dsn:
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration

    sentry_sdk.init(dsn=_sentry_dsn, integrations=[FastApiIntegration()])

app = FastAPI(title="rag-parser", version="0.1.0")


# ----------------------------------------------------------------------------
# Authentication
#
# Opt-in shared-secret auth. The env var is read per-request (not cached at
# import) so the value is easy to rotate and trivial to exercise in tests.
# ----------------------------------------------------------------------------
def _warn_if_parser_secret_missing_in_prod() -> None:
    """
    PARSER_SECRET is documented (env.example) as required in production, and
    packages/core/src/config.ts fails loud on the Node side when
    NODE_ENV=production and it's unset. The sidecar itself has no equivalent
    check — an unset secret here just silently disables auth. Log (don't
    fail) so a misconfigured prod deploy is visible without changing this
    service's own permissive default.
    """
    environment = os.environ.get("NODE_ENV", "development").strip().lower()
    if environment != "development" and not os.environ.get("PARSER_SECRET", "").strip():
        logger.warning(
            "PARSER_SECRET is unset with NODE_ENV=%s — the /parse endpoint is "
            "unauthenticated. Required in production; see env.example.",
            environment,
        )


_warn_if_parser_secret_missing_in_prod()


def require_parser_token(x_parser_token: str | None = Header(default=None)) -> None:
    """
    Guard /parse with a shared secret when PARSER_SECRET is configured.

    When PARSER_SECRET is unset or empty, no auth is enforced — adequate only
    for single-host dev where the sidecar is bound to loopback. When it is set,
    every request must carry a matching `X-Parser-Token` header; the comparison
    is constant-time to avoid leaking the secret through response timing.
    """
    secret = os.environ.get("PARSER_SECRET", "").strip()
    if not secret:
        return
    # Starlette joins duplicate inbound headers with ", " (a proxy/LB can
    # legitimately duplicate them), so accept the token if ANY value matches.
    candidates = [v.strip() for v in (x_parser_token or "").split(",") if v.strip()]
    if not any(hmac.compare_digest(c, secret) for c in candidates):
        raise HTTPException(status_code=401, detail="invalid or missing X-Parser-Token")


# ----------------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/parse", response_model=ParsedDocument, response_model_by_alias=True)
async def parse(
    file: UploadFile = File(...),
    filename: str | None = Form(None),
    mime_type: str | None = Form(None),
    _auth: None = Depends(require_parser_token),
) -> ParsedDocument:
    """
    Convert any supported document to clean markdown + structured metadata.

    Routing:
      1. .xlsx              → openpyxl with data_only=True (computed values);
         .xls (legacy OLE2) → xlrd; both give a per-sheet classifier and
                              structured headers+rows. Chosen by content
                              sniffing, not extension.
      2. .csv / .tsv        → stdlib csv with delimiter sniffing.
      3. Everything else    → MarkItDown first, Unstructured fallback.

    The caller should supply the original filename in the `filename` form field
    so we can route by extension when MIME sniffing is ambiguous (e.g. legacy
    .doc looks the same as application/octet-stream).
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    # Hard cap on upload size. The Node API enforces 25 MB on its own body
    # parser, but the parser sidecar is reachable directly from any pod that
    # can resolve its service name; without a guard here a single oversized
    # POST could OOM the worker process.
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large (max {MAX_UPLOAD_BYTES} bytes)",
        )

    fname = filename or file.filename or "document.bin"
    ext = Path(fname).suffix.lower()
    # Resolve the MIME type. A caller-supplied MIME wins, but only when it is
    # specific — a generic/missing value (e.g. SharePoint's octet-stream for
    # extensionless items) is re-sniffed from the bytes with libmagic so we
    # route to the real parser/suffix instead of falling through to ".bin".
    # Drop any `; charset=…`/parameter portion and normalize, so a caller MIME
    # like "application/pdf; charset=utf-8" still routes (and a generic value is
    # recognized as generic rather than slipping through to a ".bin" suffix).
    provided_mime = (mime_type or file.content_type or "").split(";")[0].strip().lower()
    if provided_mime in _GENERIC_MIMES:
        # libmagic output can carry stray case/whitespace on some builds —
        # normalize it too, since it feeds the spreadsheet/suffix lookups.
        detected_mime = (magic.from_buffer(raw, mime=True) or provided_mime).strip().lower()
    else:
        detected_mime = provided_mime

    # Spreadsheet fast path — we want structured rows + classification, not
    # MarkItDown's flat rendering. The TS chunker downstream uses these to
    # do row-grouping with header repetition (otherwise large sheets get
    # sliced mid-row by the markdown chunker).
    if ext in {".xlsx", ".xls"} or detected_mime in {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
    }:
        return _parse_xlsx(raw, fname, detected_mime)

    if ext in {".csv", ".tsv"} or detected_mime in {"text/csv", "text/tab-separated-values"}:
        return _parse_csv(raw, fname, detected_mime, ext)

    # General path: MarkItDown first, Unstructured fallback.
    suffix = ext or _suffix_for_mime(detected_mime)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)

    try:
        # Both parsers are blocking (MarkItDown, and Unstructured's OCR can run
        # for minutes). Calling them directly inside this async handler froze
        # the event loop, so one slow document stalled every other request,
        # /health included. Run them on the threadpool instead.
        return await run_in_threadpool(_parse_general, tmp_path, fname, detected_mime)
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------




def _suffix_for_mime(mime: str) -> str:
    """Best-effort extension when none is supplied — keeps MarkItDown's routing happy."""
    return {
        "application/pdf": ".pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/msword": ".doc",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "text/html": ".html",
        "text/markdown": ".md",
        "text/csv": ".csv",
        "text/plain": ".txt",
        "application/json": ".json",
    }.get(mime, ".bin")
