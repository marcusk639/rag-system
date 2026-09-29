import {
  ComplianceError,
  identifyingTRIPatterns,
  scanForTRI,
  type RetrievalResult,
} from "@rag/core";

export type TriPolicy = "block" | "warn" | "off";

export interface DroppedContext {
  chunkId: string;
  documentId: string;
  patterns: string[];
}

export interface ScreenedContext {
  context: RetrievalResult[];
  dropped: DroppedContext[];
}

/** Would this set of detected patterns block under `policy`? */
function blocks(patterns: string[], policy: TriPolicy): boolean {
  if (patterns.length === 0) return false;
  return policy === "block" || identifyingTRIPatterns(patterns).length > 0;
}

/**
 * Remove TRI-bearing chunks from generation context, one chunk at a time.
 *
 * The prompt used to be scanned as a single string, so one retrieved chunk
 * with a false-positive match failed EVERY question that happened to retrieve
 * it, and the user had no way to tell why. Screening per chunk keeps the same
 * guarantee — nothing that would block reaches the provider — while answering
 * from the chunks that are clean.
 *
 * - The question is screened on its own: a user who typed an identifier gets a
 *   ComplianceError naming the question, not a silently degraded answer.
 * - A chunk is screened together with its document title and heading path,
 *   which are sent to the model as attributes.
 * - If nothing survives, a ComplianceError is thrown, as before.
 * - Under `warn`, matches that do not block are reported via `onTriDetected`.
 *
 * The provider call still runs the whole-prompt pre-flight afterwards; this
 * narrows what reaches it, it does not replace it.
 */
export function screenGenerationContext(
  question: string,
  context: RetrievalResult[],
  policy: TriPolicy,
  onTriDetected?: (patterns: string[]) => void,
): ScreenedContext {
  if (policy === "off") return { context, dropped: [] };

  const questionScan = scanForTRI(question);
  if (blocks(questionScan.patterns, policy)) {
    throw new ComplianceError(
      `TRI detected in the question (patterns: ${questionScan.patterns.join(", ")}). ` +
        "Remove client identifiers from the question and ask again.",
    );
  }

  const kept: RetrievalResult[] = [];
  const dropped: DroppedContext[] = [];
  const warned = new Set<string>(questionScan.patterns);
  for (const r of context) {
    const scan = scanForTRI(
      [r.document.title, r.chunk.headingPath.join(" › "), r.text].join("\n"),
    );
    if (blocks(scan.patterns, policy)) {
      dropped.push({
        chunkId: r.chunk.id,
        documentId: r.document.id,
        patterns: scan.patterns,
      });
    } else {
      for (const p of scan.patterns) warned.add(p);
      kept.push(r);
    }
  }

  if (kept.length === 0 && context.length > 0) {
    throw new ComplianceError(
      `TRI detected in every retrieved passage (${dropped.length} dropped). ` +
        "Use self-hosted generation or obtain §7216 consent before sending client data to an external API.",
    );
  }
  if (warned.size > 0) onTriDetected?.([...warned]);
  return { context: kept, dropped };
}
