import type { DocumentClass } from "@rag/core";
import type { DataClass } from "@rag/db";

/**
 * Maps the operator-facing `sources.data_class` classification (general |
 * research | sop | client_confidential) to the pipeline's compliance-gate
 * `DocumentClass` (A | B | C | D). `client_confidential` maps to C, not D —
 * D is reserved for tax-return-specific data; both C and D are blocked at
 * the pipeline level today (`pipeline.ts:245`), so this distinction has no
 * behavioral effect yet. This C-vs-D semantic assignment is a provisional
 * engineering default, NOT a ratified compliance-classification decision —
 * see docs/TWK-MANUAL-RUNBOOK.md item 9, which flags it for confirmation
 * against the firm's actual data-classification policy before any
 * D-specific behavior is ever built on top of it.
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
      return "C";
    default: {
      const exhaustive: never = dataClass;
      throw new Error(
        `Unrecognized sources.data_class value: ${String(exhaustive)} — refusing to default to Class A. Add an explicit mapping before this value can be ingested.`,
      );
    }
  }
}
