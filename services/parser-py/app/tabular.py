from __future__ import annotations

import csv as csvmod
import io
import re
from pathlib import Path
from typing import Any

from fastapi import HTTPException
import xlrd
from openpyxl import load_workbook

from .models import ParsedDocument, ParsedTable, SheetType

import logging

logger = logging.getLogger("parser")


# ----------------------------------------------------------------------------
# Spreadsheet path: XLSX + CSV → structured rows + per-sheet classification
# ----------------------------------------------------------------------------
def _read_xlsx_sheets(
    raw: bytes, fname: str
) -> list[tuple[str, list[list[Any]], int]]:
    """
    (sheet_name, rows, formula_count) per sheet, via openpyxl (OOXML only).

    Two loads: `data_only=True` yields COMPUTED values (formula results, not
    "=SUM(...)"), and `data_only=False` is needed only to count formulas for the
    financial_model classifier. Both stream in read_only mode so a large
    workbook stays memory-bounded.
    """
    try:
        wb_values = load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
        wb_formulas = load_workbook(io.BytesIO(raw), data_only=False, read_only=True)
    except Exception as e:
        logger.error("openpyxl failed for %s: %s", fname, e)
        raise HTTPException(status_code=422, detail=f"unreadable workbook: {e}") from e

    formula_sheets = {ws.title: ws for ws in wb_formulas.worksheets}
    out: list[tuple[str, list[list[Any]], int]] = []
    for sheet in wb_values.worksheets:
        rows = [list(r) for r in sheet.iter_rows(values_only=True)]
        out.append(
            (sheet.title, rows, _count_formulas(formula_sheets.get(sheet.title)))
        )
    return out


def _read_xls_sheets(
    raw: bytes, fname: str
) -> list[tuple[str, list[list[Any]], int]]:
    """
    (sheet_name, rows, formula_count) per sheet, via xlrd (legacy OLE2 only).

    xlrd>=2.0 dropped .xlsx and reads .xls exclusively, which is precisely the
    half openpyxl cannot do. It returns the cached computed value for formula
    cells — the same thing `data_only=True` gives us on the xlsx path — so the
    values match across formats.

    formula_count is always 0: xlrd surfaces cached results, not the formulas
    that produced them, so we cannot distinguish a computed cell from a literal
    one. The only consequence is that `_classify_sheet` will not label an .xls
    sheet `financial_model`, so it row-groups like any other table rather than
    being kept whole. That degrades chunking slightly for one sheet type; it is
    strictly better than the previous behaviour, which was to reject the file.
    """
    try:
        book = xlrd.open_workbook(file_contents=raw)
    except Exception as e:
        logger.error("xlrd failed for %s: %s", fname, e)
        raise HTTPException(status_code=422, detail=f"unreadable workbook: {e}") from e

    out: list[tuple[str, list[list[Any]], int]] = []
    for sheet in book.sheets():
        rows = [sheet.row_values(i) for i in range(sheet.nrows)]
        out.append((sheet.name, rows, 0))
    return out


def _parse_xlsx(raw: bytes, fname: str, mime: str) -> ParsedDocument:
    """
    Parse an .xlsx or legacy .xls workbook into a ParsedDocument with one
    ParsedTable per sheet. The reader is chosen by content signature — see
    `_read_xlsx_sheets` / `_read_xls_sheets`.
    """
    # Dispatch on the CONTENT, not the extension. .xlsx is a zip (PK\x03\x04);
    # legacy .xls is an OLE2 compound file (\xd0\xcf\x11\xe0). openpyxl reads
    # only the former and xlrd>=2 only the latter, so sending an .xls to
    # openpyxl fails with the opaque "File is not a zip file" — which is exactly
    # what happened in production, on every .xls, while the docstring above and
    # the router both advertised .xls as supported.
    #
    # Sniffing bytes rather than trusting `ext` also covers the mislabelled
    # file: a .xlsx-named OLE2 workbook (common when someone renames rather
    # than re-saves) now routes correctly instead of 422-ing.
    if raw[:4] == b"\xd0\xcf\x11\xe0":
        sheets, parser_name = _read_xls_sheets(raw, fname), "xlrd"
    else:
        sheets, parser_name = _read_xlsx_sheets(raw, fname), "openpyxl"

    tables: list[ParsedTable] = []
    markdown_sections: list[str] = []

    for sheet_name, all_rows, formula_count in sheets:
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

        sheet_type = _classify_sheet(headers, data_rows, formula_count)

        sheet_markdown = _rows_to_markdown(headers, data_rows, sheet_name)
        markdown_sections.append(sheet_markdown)

        tables.append(
            ParsedTable(
                markdown=sheet_markdown,
                sheet_name=sheet_name,
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
            "parser": parser_name,
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
        # Insert a header separator after the first row. A rendered row
        # "| a | b | c |" has N+1 pipes for N columns, so subtract one.
        ncols = max(1, md_rows[0].count("|") - 1)
        separator = "| " + " | ".join(["---"] * ncols) + " |"
        return "\n".join([md_rows[0], separator, *md_rows[1:]])
    except Exception:
        return ""
