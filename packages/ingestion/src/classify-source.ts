import type { DocumentClass } from "@rag/core";
import type { DataClass } from "@rag/db";

/**
 * Maps a source's declared §7216/GLBA classification (`sources.data_class`)
 * onto the ingestion pipeline's compliance gate (`DocumentClass`, A|B|C|D).
 *
 * `sources.data_class` does not distinguish Class C (client business records)
 * from Class D (client tax-return data) — it only knows `client_confidential`.
 * Since both are blocked identically in Phase 1 (see `ClassBlockedError` in
 * pipeline.ts), `client_confidential` maps to the more conservative "D" so a
 * source that turns out to hold return data is never under-classified as
 * merely "business records."
 */
export function mapDataClassToDocumentClass(
  dataClass: DataClass,
): DocumentClass {
  switch (dataClass) {
    case "general":
    case "sop":
      return "A";
    case "research":
      return "B";
    case "client_confidential":
      return "D";
  }
}
