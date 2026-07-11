import type { DocumentClass } from "@rag/core";
import type { DataClass } from "@rag/db";

/**
 * Maps a source's declared §7216/GLBA classification (`sources.data_class`)
 * onto the ingestion pipeline's compliance gate (`DocumentClass`, A|B|C|D).
 *
 * `sources.data_class` does not distinguish Class C (client business
 * records) from Class D (client tax-return data) — it only knows
 * `client_confidential`. Both are blocked identically today (see
 * `ClassBlockedError` in pipeline.ts), so this choice has no behavioral
 * effect yet, but `client_confidential` maps to the more conservative "D"
 * (resolved decision — see `docs/TWK-MANUAL-RUNBOOK.md` item 9) so a source
 * that turns out to hold return data is never under-classified as merely
 * "business records."
 *
 * Fails CLOSED on an unrecognized value (throws) rather than falling
 * through to `undefined`, which the pipeline's `?? "A"` default would
 * otherwise silently treat as public Class A.
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
    default: {
      const exhaustive: never = dataClass;
      throw new Error(
        `Unrecognized sources.data_class value: ${String(exhaustive)} — refusing to default to Class A. Add an explicit mapping before this value can be ingested.`,
      );
    }
  }
}
