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

import csv as csvmod
import io
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Literal

import magic
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from markitdown import MarkItDown
from openpyxl import load_workbook
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("parser")

# Cap accepted upload size. 100 MB is large enough for any reasonable office
# document (PDFs with high-res images, large Excel workbooks) while making
# accidental or malicious oversized uploads cheap to reject.
MAX_UPLOAD_BYTES = int(os.environ.get("PARSER_MAX_UPLOAD_BYTES", 100 * 1024 * 1024))

app = FastAPI(title="rag-parser", version="0.1.0")

# Single shared instance; MarkItDown is stateless and cheap to keep around.
_markitdown = MarkItDown()


# ----------------------------------------------------------------------------
# Response models
#
# Pydantic field names are snake_case (Python idiom) but the wire format is
# camelCase to match the TypeScript consumer. `alias_generator=to_camel`
# auto-derives the alias; `populate_by_name=True` lets internal code construct
# instances with snake_case kwargs. The /parse endpoint sets
# `response_model_by_alias=True` so FastAPI serializes by alias.
# ----------------------------------------------------------------------------
SheetType = Literal["tabular", "narrative", "financial_model", "freeform"]


class _CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


class ParsedTable(_CamelModel):
    markdown: str
    caption: str | None = None
    # Spreadsheet-only fields (None for tables extracted from PDFs/DOCX/HTML)
    sheet_name: str | None = None
    sheet_type: SheetType | None = None
    headers: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    row_count: int = 0
    column_count: int = 0


class ParsedDocument(_CamelModel):
    title: str
    markdown: str
    tables: list[ParsedTable] = Field(default_factory=list)
    # `dict[str, Any]` alone makes Pydantic emit a bare `{"type": "object"}`
    # with no `additionalProperties`, which openapi-typescript renders as the
    # useless `Record<string, never>`. Forcing `additionalProperties` makes the
    # generator emit `{ [key: string]: unknown }` instead.
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        json_schema_extra={"additionalProperties": True},
    )


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
) -> ParsedDocument:
    """
    Convert any supported document to clean markdown + structured metadata.

    Routing:
      1. .xlsx / .xls       → openpyxl with data_only=True (computed values);
                              per-sheet classifier; structured headers+rows.
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
    detected_mime = mime_type or file.content_type or magic.from_buffer(raw, mime=True)
    ext = Path(fname).suffix.lower()

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
        return _parse_with_markitdown(tmp_path, fname, detected_mime) or _parse_with_unstructured(
            tmp_path, fname, detected_mime
        )
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


# ----------------------------------------------------------------------------
# Parser implementations
# ----------------------------------------------------------------------------
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
    except Exception as e:  # noqa: BLE001 — broad on purpose, we fall back
        logger.warning("markitdown failed for %s (%s): %s", fname, mime, e)
        return None


def _parse_with_unstructured(path: Path, fname: str, mime: str) -> ParsedDocument:
    """
    Fallback parser. Heavier (slow first import, OCR is expensive) but handles
    scanned PDFs, images, exotic formats, and is more permissive on malformed docs.
    """
    try:
        # Lazy import — Unstructured has slow startup and ~500MB of models.
        from unstructured.partition.auto import partition

        elements = partition(filename=str(path))
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
    except Exception as e:
        logger.error("unstructured failed for %s (%s): %s", fname, mime, e)
        raise HTTPException(status_code=500, detail=f"parse failed: {e}") from e


# ----------------------------------------------------------------------------
# Spreadsheet path: XLSX + CSV → structured rows + per-sheet classification
# ----------------------------------------------------------------------------
def _parse_xlsx(raw: bytes, fname: str, mime: str) -> ParsedDocument:
    """
    Parse an .xlsx/.xls workbook into a ParsedDocument with one ParsedTable
    per sheet. Uses two openpyxl loads:
      - data_only=True   to get COMPUTED values (formula results), not "=SUM(...)"
      - data_only=False  to count formulas for the financial_model classifier
    Both are in read_only mode for bounded memory on large workbooks.
    """
    try:
        wb_values = load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
        # Separate load just to detect formulas. We can avoid this for files
        # without any formula cells by short-circuiting later if we want, but
        # the read_only streaming pass is cheap.
        wb_formulas = load_workbook(io.BytesIO(raw), data_only=False, read_only=True)
    except Exception as e:
        logger.error("openpyxl failed for %s: %s", fname, e)
        raise HTTPException(status_code=422, detail=f"unreadable workbook: {e}") from e

    tables: list[ParsedTable] = []
    markdown_sections: list[str] = []

    formula_sheets = {ws.title: ws for ws in wb_formulas.worksheets}

    for sheet in wb_values.worksheets:
        all_rows = [list(r) for r in sheet.iter_rows(values_only=True)]
        # Trim trailing empty rows; openpyxl reports trailing blanks from the
        # max-used range, which inflates row_count and confuses the classifier.
        while all_rows and all(c is None or _cell_to_str(c).strip() == "" for c in all_rows[-1]):
            all_rows.pop()
        if not all_rows:
            continue

        headers = [_cell_to_str(c) for c in all_rows[0]]
        data_rows = [[_cell_to_str(c) for c in r] for r in all_rows[1:]]
        # Pad short rows so every row has `len(headers)` columns. The chunker
        # downstream relies on this invariant when prepending headers.
        ncols = len(headers)
        data_rows = [r + [""] * max(0, ncols - len(r)) for r in data_rows]

        formula_count = _count_formulas(formula_sheets.get(sheet.title))
        sheet_type = _classify_sheet(headers, data_rows, formula_count)

        sheet_markdown = _rows_to_markdown(headers, data_rows, sheet.title)
        markdown_sections.append(sheet_markdown)

        tables.append(
            ParsedTable(
                markdown=sheet_markdown,
                sheet_name=sheet.title,
                sheet_type=sheet_type,
                headers=headers,
                rows=data_rows,
                row_count=len(data_rows),
                column_count=ncols,
            )
        )

    if not tables:
        raise HTTPException(status_code=422, detail="workbook is empty")

    title = Path(fname).stem
    return ParsedDocument(
        title=title,
        markdown="\n\n".join(markdown_sections),
        tables=tables,
        metadata={
            "parser": "openpyxl",
            "mime_type": mime,
            "source_filename": fname,
            "sheet_count": len(tables),
        },
    )


def _parse_csv(raw: bytes, fname: str, mime: str, ext: str) -> ParsedDocument:
    """
    Parse a CSV/TSV with delimiter sniffing. Falls back to comma if sniffing
    fails (common for CSVs with single-column or unusual content). The whole
    file is one "sheet" with no formula concept, so sheet_type is decided by
    structure only.
    """
    # Best-effort encoding: try UTF-8 (the dominant case), fall back to
    # latin-1 (which never fails) so we at least produce something.
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")
        logger.warning("CSV %s was not UTF-8; decoded as latin-1", fname)

    sample = text[:4096]
    try:
        dialect = csvmod.Sniffer().sniff(sample, delimiters=",\t;|")
    except csvmod.Error:
        # Default to TSV when extension says so, otherwise CSV.
        dialect = csvmod.excel_tab if ext == ".tsv" else csvmod.excel

    reader = csvmod.reader(io.StringIO(text), dialect=dialect)
    all_rows = [r for r in reader]
    if not all_rows:
        raise HTTPException(status_code=422, detail="CSV is empty")

    headers = [c.strip() for c in all_rows[0]]
    data_rows = [[c.strip() for c in r] for r in all_rows[1:]]
    ncols = len(headers)
    data_rows = [r + [""] * max(0, ncols - len(r)) for r in data_rows]

    sheet_type = _classify_sheet(headers, data_rows, formula_count=0)
    sheet_name = Path(fname).stem
    markdown = _rows_to_markdown(headers, data_rows, sheet_name=sheet_name)

    return ParsedDocument(
        title=sheet_name,
        markdown=markdown,
        tables=[
            ParsedTable(
                markdown=markdown,
                # Use the filename stem as the sheet name so downstream
                # chunkers can attach it to headingPath for citation context.
                # The rendered markdown already prefixes the table with this
                # value as an H1 — making the structured field match.
                sheet_name=sheet_name,
                sheet_type=sheet_type,
                headers=headers,
                rows=data_rows,
                row_count=len(data_rows),
                column_count=ncols,
            )
        ],
        metadata={
            "parser": "csv",
            "mime_type": mime,
            "source_filename": fname,
        },
    )


def _classify_sheet(
    headers: list[str],
    rows: list[list[str]],
    formula_count: int,
) -> SheetType:
    """
    Rule-based per-sheet classifier. Cheap (no LLM call) and deterministic.
    See docs/ARCHITECTURE.md for the rationale per label.

      tabular         — database-like rows, ready for row-grouping or text-to-SQL
      financial_model — small, formula-heavy; embed computed values whole
      narrative       — long-text cells or irregular layout; treat as prose
      freeform        — none of the above; best-effort
    """
    if not rows:
        return "freeform"

    non_empty_cells = sum(1 for r in rows for c in r if c.strip())
    if non_empty_cells == 0:
        return "freeform"

    # ── financial_model: formula-heavy, small structured sheets
    formula_density = formula_count / max(non_empty_cells, 1)
    if formula_density >= 0.20:
        return "financial_model"

    # ── narrative: any cell >200 chars OR very irregular column counts
    has_long_text = any(len(c) > 200 for r in rows for c in r)
    distinct_lengths = len({len([c for c in r if c.strip()]) for r in rows})
    if has_long_text or distinct_lengths > 3:
        return "narrative"

    # ── tabular: ≥5 rows, headers non-numeric, ≥75% consistent column count
    ncols = len(headers)
    if (
        len(rows) >= 5
        and ncols >= 2
        and _headers_are_non_numeric(headers)
        and _column_count_consistency(rows, ncols) >= 0.75
    ):
        return "tabular"

    return "freeform"


def _headers_are_non_numeric(headers: list[str]) -> bool:
    """At least 80% of non-empty headers must be non-numeric to look like a real header row."""
    non_empty = [h for h in headers if h.strip()]
    if not non_empty:
        return False
    non_numeric = sum(1 for h in non_empty if not _is_numeric(h))
    return (non_numeric / len(non_empty)) >= 0.80


def _column_count_consistency(rows: list[list[str]], expected_cols: int) -> float:
    """Fraction of data rows whose populated-cell count equals expected_cols."""
    if not rows:
        return 0.0
    matches = sum(1 for r in rows if len([c for c in r if c.strip()]) == expected_cols)
    return matches / len(rows)


def _is_numeric(s: str) -> bool:
    """Heuristic numeric check that tolerates common formatting (commas, $, %)."""
    if not s:
        return False
    cleaned = s.strip().replace(",", "").replace("$", "").replace("%", "").replace(" ", "")
    if cleaned in ("", "-", "+", "."):
        return False
    try:
        float(cleaned)
        return True
    except ValueError:
        return False


def _count_formulas(sheet: Any) -> int:
    """Count cells whose value starts with `=`. Requires data_only=False workbook."""
    if sheet is None:
        return 0
    count = 0
    for row in sheet.iter_rows(values_only=True):
        for cell in row:
            if isinstance(cell, str) and cell.startswith("="):
                count += 1
    return count


def _cell_to_str(value: Any) -> str:
    """Stable string rendering for arbitrary openpyxl cell values."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    # datetime/date/time → ISO; numbers → str; everything else → str
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _rows_to_markdown(
    headers: list[str],
    rows: list[list[str]],
    sheet_name: str | None,
) -> str:
    """
    Render a header+rows pair as a GFM table prefixed with the sheet name as
    an H1. Used both for the document-level markdown blob (so unchanged
    downstream code keeps working) and for the per-table `markdown` field.
    """
    if not headers:
        return ""
    title_block = f"# {sheet_name}\n\n" if sheet_name else ""
    # Escape pipes inside cells so they don't break the table syntax.
    def esc(c: str) -> str:
        return c.replace("|", "\\|").replace("\n", " ")
    header_line = "| " + " | ".join(esc(h) for h in headers) + " |"
    separator = "| " + " | ".join(["---"] * len(headers)) + " |"
    body_lines = [
        "| " + " | ".join(esc(c) for c in r) + " |" for r in rows
    ]
    return title_block + "\n".join([header_line, separator, *body_lines])


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def _extract_title(parser_title: str | None, markdown: str, fname: str) -> str:
    """Prefer parser-provided title, then first H1, then filename stem."""
    if parser_title:
        return parser_title.strip()
    m = re.search(r"^#\s+(.+)$", markdown, re.MULTILINE)
    if m:
        return m.group(1).strip()
    return Path(fname).stem


_TABLE_LINE_RE = re.compile(r"^\s*\|.+\|\s*$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$")


def _extract_tables_from_markdown(markdown: str) -> list[ParsedTable]:
    """
    Walk the markdown and pull out anything that looks like a GFM table.
    We keep the original table inline (do not strip it from `markdown`) so
    that retrieval still has table-row text in the chunk pool. The separate
    `tables` field is for callers that want to surface tables specifically.
    """
    lines = markdown.splitlines()
    out: list[ParsedTable] = []
    i = 0
    while i < len(lines):
        if _TABLE_LINE_RE.match(lines[i]) and i + 1 < len(lines) and _TABLE_SEP_RE.match(
            lines[i + 1]
        ):
            start = i
            i += 2
            while i < len(lines) and _TABLE_LINE_RE.match(lines[i]):
                i += 1
            out.append(ParsedTable(markdown="\n".join(lines[start:i])))
        else:
            i += 1
    return out


def _html_table_to_markdown(html: str) -> str:
    """Tiny HTML table → GFM markdown converter; good enough for Unstructured output."""
    if "<table" not in html.lower():
        return ""
    try:
        import html as _html

        # Very small regex-based stripper; we're already in fallback land.
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.DOTALL | re.IGNORECASE)
        md_rows: list[str] = []
        for r in rows:
            cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, flags=re.DOTALL | re.IGNORECASE)
            cleaned = [_html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in cells]
            if cleaned:
                md_rows.append("| " + " | ".join(cleaned) + " |")
        if not md_rows:
            return ""
        # Insert a header separator after the first row.
        separator = "| " + " | ".join(["---"] * md_rows[0].count("|")) + " |"
        return "\n".join([md_rows[0], separator, *md_rows[1:]])
    except Exception:
        return ""


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
