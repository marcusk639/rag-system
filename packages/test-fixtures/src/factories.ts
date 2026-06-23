import type { SourceDocument } from "@rag/core";

/**
 * Factory helpers for building SourceDocuments inline. Each one returns the
 * shape the ingestion pipeline expects from a connector.
 */
export function markdownDoc(args: {
  externalId: string;
  title: string;
  markdown: string;
  modifiedAt?: string;
}): SourceDocument {
  return {
    externalId: args.externalId,
    title: args.title,
    modifiedAt: args.modifiedAt ?? "2026-05-26T00:00:00Z",
    mimeType: "text/markdown",
    content: Buffer.from(args.markdown, "utf8"),
    metadata: {
      title: args.title,
      mimeType: "text/markdown",
    },
  };
}

export function plainTextDoc(args: {
  externalId: string;
  title: string;
  text: string;
  metadata?: Record<string, unknown>;
}): SourceDocument {
  return {
    externalId: args.externalId,
    title: args.title,
    modifiedAt: "2026-05-26T00:00:00Z",
    mimeType: "text/plain",
    content: Buffer.from(args.text, "utf8"),
    metadata: {
      title: args.title,
      mimeType: "text/plain",
      ...(args.metadata ?? {}),
    },
  };
}

/**
 * Build a CSV SourceDocument. The parser routes CSV through the same
 * structured-table path as XLSX: classifier emits a `sheetType`, the
 * TableChunker handles row-grouping. This is the cheapest way to exercise the
 * v0 spreadsheet path without adding an xlsx library dependency.
 */
export function csvDoc(args: {
  externalId: string;
  title: string;
  headers: string[];
  rows: string[][];
  metadata?: Record<string, unknown>;
}): SourceDocument {
  const lines = [args.headers.join(","), ...args.rows.map((r) => r.join(","))];
  return {
    externalId: args.externalId,
    title: args.title,
    modifiedAt: "2026-05-26T00:00:00Z",
    mimeType: "text/csv",
    content: Buffer.from(lines.join("\n"), "utf8"),
    metadata: {
      title: args.title,
      mimeType: "text/csv",
      ...(args.metadata ?? {}),
    },
  };
}
