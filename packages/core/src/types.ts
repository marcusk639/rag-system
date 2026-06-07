import { z } from "zod";

// ============================================================================
// Source — an external system the ingestion pipeline can pull from
// ============================================================================

export const SourceKind = z.enum([
  "sharepoint",
  "gdrive",
  "gmail",
  "outlook",
  "custom",
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceConfig = z.object({
  id: z.string().uuid(),
  kind: SourceKind,
  name: z.string().min(1).max(120),
  // Per-connector configuration. Each connector defines its own shape and
  // validates it on construction. We store as JSON to keep the schema generic.
  config: z.record(z.unknown()),
  // Last successful delta cursor (opaque to the core, interpreted by the connector).
  cursor: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

// ============================================================================
// Document — a single retrievable unit from a source (file, email, etc.)
// ============================================================================

export const DocumentMetadata = z
  .object({
    title: z.string().optional(),
    author: z.string().optional(),
    url: z.string().url().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    createdAt: z.string().datetime().optional(),
    modifiedAt: z.string().datetime().optional(),
    // Path-like address inside the source (e.g. "Marketing/2024/plan.docx").
    path: z.string().optional(),
    // Email-only fields
    subject: z.string().optional(),
    from: z.string().optional(),
    to: z.array(z.string()).optional(),
    // Free-form for connector-specific extras (drive id, sharepoint site id, etc.)
    extra: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type DocumentMetadata = z.infer<typeof DocumentMetadata>;

export interface SourceDocument {
  /** Stable id within the source (file id, message id, etc.) */
  externalId: string;
  /** Human-readable title used in citations */
  title: string;
  /** ISO timestamp the source reports as "last modified" */
  modifiedAt: string;
  /** MIME type as the source reports it */
  mimeType: string;
  /** Raw bytes of the document */
  content: Buffer;
  /** Anything else worth storing for retrieval/filtering */
  metadata: DocumentMetadata;
}

// ============================================================================
// Parsed document — output of the parser sidecar
// ============================================================================

/**
 * Routing label assigned by the parser per spreadsheet sheet. Drives downstream
 * choices about chunking (row-grouping vs. semantic), text-to-SQL eligibility,
 * and citation formatting. For non-spreadsheet sources `sheetType` is undefined.
 *
 *  - `tabular`         — database-like sheet, consistent headers, no narrative.
 *                        Best treated row-by-row; SQL-routable when needed.
 *  - `narrative`       — report-style sheet: headings, prose, mixed tables.
 *                        Best treated as markdown chunks with surrounding context.
 *  - `financial_model` — small, dense, formula-heavy. Embed COMPUTED values
 *                        and treat the whole sheet as one logical section.
 *  - `freeform`        — todo lists, plans, irregular layouts. Best-effort.
 */
export const SheetType = z.enum([
  "tabular",
  "narrative",
  "financial_model",
  "freeform",
]);
export type SheetType = z.infer<typeof SheetType>;

export const ParsedTableSchema = z.object({
  /** Markdown rendering of the table — embedded in `markdown` for retrieval */
  markdown: z.string(),
  /** Optional caption/title near the table */
  caption: z.string().optional(),
  /** Sheet name for spreadsheet sources; undefined for tables embedded in other docs */
  sheetName: z.string().optional(),
  /** Routing label for downstream chunking + retrieval (spreadsheets only) */
  sheetType: SheetType.optional(),
  /** Header row(s), one entry per column. Empty for non-spreadsheet tables. */
  headers: z.array(z.string()).optional(),
  /** Data rows. Each inner array has `headers.length` entries (right-padded with "") */
  rows: z.array(z.array(z.string())).optional(),
  /** Convenience for callers that don't want to count `rows.length` */
  rowCount: z.number().int().nonnegative().optional(),
  /** Convenience for callers that don't want to count `headers.length` */
  columnCount: z.number().int().nonnegative().optional(),
});
export type ParsedTable = z.infer<typeof ParsedTableSchema>;

/**
 * Zod schema for the parser sidecar's response. Mirrors `ParsedDocument`
 * exactly and is the validation gate at the TS↔Python parser boundary —
 * `HttpParserClient` `.parse()`s the sidecar JSON through this instead of an
 * unchecked `as` cast, so a malformed response fails loudly instead of
 * silently corrupting downstream chunks.
 */
export const ParsedDocumentSchema = z.object({
  /** Cleaned markdown representation of the document */
  markdown: z.string(),
  /** Detected/normalized title (may differ from source title) */
  title: z.string(),
  /** Structured tables extracted from the document */
  tables: z.array(ParsedTableSchema),
  /** Metadata extracted by the parser (overrides/augments source metadata) */
  metadata: DocumentMetadata,
});
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;

// ============================================================================
// Chunk — a slice of a document ready to embed
// ============================================================================

export interface Chunk {
  /** SHA-256 of the chunk text. Used for dedupe and idempotency. */
  hash: string;
  /** The chunk text */
  text: string;
  /** Token count estimate (used for retrieval budget calculations) */
  tokenCount: number;
  /** Position within the document (0-indexed) */
  ordinal: number;
  /** Heading path at this chunk's location, e.g. ["Introduction", "Setup"] */
  headingPath: string[];
  /** Page number when known (PDFs, Word docs) */
  page?: number;
}

// ============================================================================
// Embedding
// ============================================================================

export interface Embedding {
  /** Raw float vector */
  vector: number[];
  /** Provider name, e.g. "gemini" */
  provider: string;
  /** Model identifier, e.g. "text-embedding-004" */
  model: string;
  /** Dimensions (matches vector.length, included for fast validation) */
  dimensions: number;
}

// ============================================================================
// Retrieval
// ============================================================================

export interface RetrievalQuery {
  query: string;
  topK: number;
  /** Optional metadata filter: AND across keys, OR across array values per key */
  filter?: Record<string, string | string[]>;
  /** Restrict to specific source IDs */
  sourceIds?: string[];
  /** Override hybrid weights for this query */
  weights?: { dense: number; sparse: number };
}

export interface RetrievalResult {
  /** Chunk text */
  text: string;
  /** Combined score (0-1, higher is better) */
  score: number;
  /** Dense (cosine) score component */
  denseScore: number;
  /** Sparse (BM25) score component */
  sparseScore: number;
  /** Document this chunk came from */
  document: {
    id: string;
    title: string;
    sourceId: string;
    sourceKind: SourceKind;
    url?: string;
    metadata: DocumentMetadata;
  };
  /** Position within the document */
  chunk: {
    id: string;
    ordinal: number;
    headingPath: string[];
    page?: number;
  };
}
