import type { DocumentClass } from "@rag/core";
import type { RedactionFinding } from "@rag/core";

/**
 * Layer 3 — per-document classification gate.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * Classification was **source-level only**: one `sources.data_class` value
 * decided the class of every document beneath it. The knowledge base was
 * declared `general` → Class A, so all 858 documents were treated as public
 * regardless of what they actually contained. That is how a spreadsheet with
 * 522 Social-Security-shaped values reached a third-party embedding API.
 *
 * The pipeline also read `deps.sourceDocClass ?? "A"` — defaulting an *unknown*
 * class to the most permissive one. An unclassified document should never be
 * treated as public.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * **A source's declared class is a ceiling, not a verdict.** Evidence from the
 * document itself can only make the classification *stricter*, never looser.
 * A document in a "general" source that contains an SSN is not general.
 *
 * This is deliberately asymmetric: evidence of sensitivity is trusted, absence
 * of evidence is not. A screen that finds nothing means "nothing detected", not
 * "nothing present" — patterns cannot see a client's name.
 */

export type ClassificationReason =
  | "source-declared"
  | "identifier-found"
  | "client-context-path"
  | "unclassified-source";

export interface DocumentClassification {
  docClass: DocumentClass;
  /** Why this class was assigned — every escalation is auditable. */
  reasons: ClassificationReason[];
  /** True when the document must not be indexed. */
  quarantine: boolean;
}

export interface ClassifyDocumentInput {
  /** The source's declared class. `undefined` means the source never declared one. */
  sourceClass?: DocumentClass;
  /** Findings from Layer 1 redaction, if it ran. */
  redactionFindings?: readonly RedactionFinding[];
  /** True when Layer 2 flagged the path as client-context (even if not excluded). */
  clientContextPath?: boolean;
}

const ORDER: Record<DocumentClass, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Return the stricter of two classes. */
function stricter(a: DocumentClass, b: DocumentClass): DocumentClass {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/**
 * Identifiers that, if present, mean the document is taxpayer/financial data
 * regardless of where it sits or what its source claims.
 *
 * `card` is included but `account` is not: the account heuristic is the weakest
 * signal in the redactor and would escalate on context words alone.
 */
const CLASS_D_IDENTIFIERS = new Set(["ssn", "ein", "routing", "card"]);

/**
 * Classify a single document.
 *
 * Returns the **stricter** of the source's declared class and whatever the
 * document's own evidence implies, and quarantines anything reaching C or D.
 */
export function classifyDocument(
  input: ClassifyDocumentInput,
): DocumentClassification {
  const reasons: ClassificationReason[] = [];

  // Fail CLOSED on an undeclared source. Previously this defaulted to "A"
  // (public) — the most permissive possible answer to "we don't know".
  let docClass: DocumentClass;
  if (input.sourceClass) {
    docClass = input.sourceClass;
    reasons.push("source-declared");
  } else {
    docClass = "D";
    reasons.push("unclassified-source");
  }

  // Structured identifiers are dispositive: an SSN is taxpayer data wherever
  // it sits, whatever the folder claims.
  const hasIdentifier = (input.redactionFindings ?? []).some(
    (f) => f.count > 0 && CLASS_D_IDENTIFIERS.has(f.kind),
  );
  if (hasIdentifier) {
    docClass = stricter(docClass, "D");
    reasons.push("identifier-found");
  }

  // Client-context location implies client business records even with no
  // detectable identifier — this is the case patterns structurally cannot see.
  if (input.clientContextPath) {
    docClass = stricter(docClass, "C");
    reasons.push("client-context-path");
  }

  return {
    docClass,
    reasons,
    quarantine: docClass === "C" || docClass === "D",
  };
}

/**
 * Whether redaction alone is enough to make a document safe to index.
 *
 * **It is not, and this returns false for anything that tripped an identifier.**
 * Redaction masks the value it recognised; it cannot prove it recognised every
 * value, and it cannot mask a name. A document that contained an SSN is treated
 * as taxpayer data even after the SSN has been masked — the masking is damage
 * limitation, not absolution.
 */
export function isSafeAfterRedaction(
  classification: DocumentClassification,
): boolean {
  return !classification.quarantine;
}
