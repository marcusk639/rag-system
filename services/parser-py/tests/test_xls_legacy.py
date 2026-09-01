"""
Legacy .xls (OLE2) parsing.

The router and the /parse docstring both advertised .xls as supported, but every
.xls was handed to openpyxl — which reads OOXML (a zip) and cannot open an OLE2
compound file at all. The result was a 422 "unreadable workbook: File is not a
zip file" on every legacy spreadsheet, in a code path that claimed to handle
them. It was found in production, where one .xls was the only document in a
50-file corpus that never ingested.

Fixtures are written with xlwt (dev-only) rather than committed as binary blobs,
so the bytes under test are reproducible and reviewable.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from app.main import app

xlwt = pytest.importorskip("xlwt", reason="dev-only fixture writer")

client = TestClient(app)


def _xls_bytes(sheets: dict[str, list[list[str]]]) -> bytes:
    wb = xlwt.Workbook()
    for name, rows in sheets.items():
        ws = wb.add_sheet(name)
        for r, row in enumerate(rows):
            for c, val in enumerate(row):
                ws.write(r, c, val)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _post(raw: bytes, filename: str, mime: str = "application/vnd.ms-excel"):
    return client.post(
        "/parse",
        files={"file": (filename, raw, mime)},
        data={"filename": filename, "mime_type": mime},
    )


def test_fixture_really_is_ole2_not_zip() -> None:
    """Guards the test itself: if xlwt ever emitted a zip, this suite would be
    exercising the xlsx path and silently prove nothing."""
    raw = _xls_bytes({"Sheet1": [["a"], ["b"]]})
    assert raw[:4] == b"\xd0\xcf\x11\xe0"
    assert raw[:4] != b"PK\x03\x04"


def test_parses_a_legacy_xls() -> None:
    raw = _xls_bytes(
        {
            "Q1": [
                ["Quarter", "Form", "Amount"],
                ["Q1 2026", "941", "1000"],
                ["Q2 2026", "941", "2000"],
            ]
        }
    )
    res = _post(raw, "Payroll Recap.xls")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["metadata"]["parser"] == "xlrd"
    assert len(body["tables"]) == 1
    table = body["tables"][0]
    assert table["sheetName"] == "Q1"
    assert table["headers"] == ["Quarter", "Form", "Amount"]
    assert table["rows"] == [["Q1 2026", "941", "1000"], ["Q2 2026", "941", "2000"]]
    assert table["rowCount"] == 2
    assert table["columnCount"] == 3


def test_multiple_sheets_each_become_a_table() -> None:
    raw = _xls_bytes(
        {
            "Federal": [["Form", "Due"], ["941", "04-30"]],
            "State": [["Form", "Due"], ["L-1", "04-30"]],
        }
    )
    res = _post(raw, "Payroll.xls")
    assert res.status_code == 200, res.text
    names = [t["sheetName"] for t in res.json()["tables"]]
    assert names == ["Federal", "State"]


def test_routes_by_content_not_extension() -> None:
    """An OLE2 workbook misnamed .xlsx must still parse.

    Renaming rather than re-saving is common, and extension-based routing sent
    those to openpyxl too. Sniffing the signature fixes both cases at once.
    """
    raw = _xls_bytes({"S": [["h"], ["v"]]})
    res = _post(
        raw,
        "misnamed.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    assert res.status_code == 200, res.text
    assert res.json()["metadata"]["parser"] == "xlrd"


def test_short_rows_are_padded_to_header_width() -> None:
    """The downstream chunker prepends headers to every chunk and relies on
    every row having len(headers) columns."""
    raw = _xls_bytes({"S": [["a", "b", "c"], ["1"], ["1", "2"]]})
    res = _post(raw, "ragged.xls")
    assert res.status_code == 200, res.text
    rows = res.json()["tables"][0]["rows"]
    assert all(len(r) == 3 for r in rows), rows


def test_corrupt_ole2_returns_422_not_500() -> None:
    """A junk file must be skippable, not a hard failure that poisons the whole
    sync — same contract the xlsx path already honours."""
    raw = b"\xd0\xcf\x11\xe0" + b"garbage" * 50
    res = _post(raw, "broken.xls")
    assert res.status_code == 422
    assert "unreadable workbook" in res.json()["detail"]


def test_xlsx_path_still_works() -> None:
    """Regression guard: the dispatch must not have broken OOXML."""
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Quarter", "Amount"])
    ws.append(["Q1", "100"])
    buf = io.BytesIO()
    wb.save(buf)
    raw = buf.getvalue()
    assert raw[:4] == b"PK\x03\x04"

    res = _post(
        raw,
        "modern.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    assert res.status_code == 200, res.text
    assert res.json()["metadata"]["parser"] == "openpyxl"
