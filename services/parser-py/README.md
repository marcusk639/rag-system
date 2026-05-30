# Parser Sidecar

Single-purpose Python service. Receives a binary document, returns clean markdown + metadata + structured tables.

## Why a sidecar instead of pure TypeScript

Document parsing in 2026 still belongs to Python:

- **MarkItDown** (Microsoft, MIT) covers 25+ formats including PDF, DOCX, XLSX, PPTX, HTML, and CSV with consistent markdown output.
- **Unstructured** handles the long tail: legacy `.doc`, scanned PDFs with OCR, exotic layouts.
- TypeScript equivalents (`mammoth`, `pdf-parse`, `xlsx`) work for the easy cases but quietly fail on complex documents — formulas in Excel, footnotes in Word, multi-column PDFs.

The sidecar isolates the heavy Python deps (LibreOffice, Tesseract, Poppler) from the main TS runtime and makes the whole system horizontally scalable: spin up more parser containers when ingestion is bottlenecked there.

## API

### `POST /parse`

`multipart/form-data`:

| Field       | Required | Description                                          |
| ----------- | -------- | ---------------------------------------------------- |
| `file`      | yes      | The binary document                                  |
| `filename`  | no       | Original filename (used for extension-based routing) |
| `mime_type` | no       | MIME hint (otherwise sniffed via `libmagic`)         |

**Response** (`application/json`, camelCase on the wire):

```json
{
  "title": "Q3 2025 Strategy",
  "markdown": "# Q3 2025 Strategy\n\n...",
  "tables": [
    {
      "markdown": "| A | B |\n| - | - |\n| 1 | 2 |",
      "sheetName": "Revenue",
      "sheetType": "tabular",
      "headers": ["A", "B"],
      "rows": [["1", "2"]],
      "rowCount": 1,
      "columnCount": 2
    }
  ],
  "metadata": {
    "parser": "openpyxl",
    "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "sourceFilename": "strategy.xlsx"
  }
}
```

`sheetName`, `sheetType`, `headers`, `rows`, `rowCount`, `columnCount` are populated for spreadsheets (XLSX/XLS/CSV/TSV); for tables extracted from PDFs/DOCX/HTML they remain empty/undefined. `sheetType` is one of:

- `tabular` — database-like rows. Safe to route to row-grouping chunkers or text-to-SQL.
- `narrative` — long-text cells or irregular layout. Treat as prose.
- `financial_model` — formula density ≥ 20%. Embed computed values, treat sheet as one section.
- `freeform` — none of the above.

### `GET /health`

Returns `{"status": "ok"}` when the service is alive.

## Running

```bash
docker compose -f docker/docker-compose.yml up parser
# Or locally:
cd services/parser-py
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## Parsing strategy

The router picks one of three paths by extension and MIME type:

1. **Spreadsheets (`.xlsx`/`.xls`/`.csv`/`.tsv`)** — bypass MarkItDown entirely. XLSX goes through openpyxl with `data_only=True` so formula cells surface as their computed values (not `=SUM(...)`). A second `data_only=False` pass counts formulas to drive the classifier. CSV/TSV use the stdlib `csv` module with delimiter sniffing.
2. **MarkItDown first** — for everything else: PDF, DOCX, PPTX, HTML, MD, etc. Fast (<1s for most docs), no model loads, clean markdown output.
3. **Unstructured fallback** — invoked only when MarkItDown returns empty. Triggers OCR for scanned PDFs and handles legacy `.doc` via LibreOffice round-tripping.

### Per-sheet classifier (rule-based, no LLM)

The XLSX/CSV path classifies each sheet to drive downstream chunking and retrieval choices:

| Label             | Triggered by                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `financial_model` | Formula density ≥ 20% of non-empty cells                                                  |
| `narrative`       | Any cell > 200 chars OR more than 3 distinct populated-column-counts across rows          |
| `tabular`         | ≥ 5 rows, ≥ 2 columns, headers ≥ 80% non-numeric, ≥ 75% of rows match header column count |
| `freeform`        | Anything else                                                                             |

The classifier is intentionally heuristic and fast. The downstream chunker can ignore the label and treat everything as plain markdown — the routing is opt-in.

## Adding a new format

If MarkItDown supports it, nothing to do — it routes by file extension automatically. For something truly exotic:

1. Add the system dependency to the `Dockerfile` `apt-get` line.
2. If the new format needs custom logic, add a branch in `_parse_with_unstructured()` or write a dedicated handler before the MarkItDown call.
3. Add the extension mapping to `_suffix_for_mime()` if MIME-only callers will hit it.
