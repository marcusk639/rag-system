from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

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
