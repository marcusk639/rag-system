/**
 * Content safety — keep client-identifying material out of the index.
 *
 * Built 2026-08-03 after a screen found client identifiers in 355 of 858
 * indexed documents. Design: docs/superpowers/plans/2026-08-03-pii-redaction-before-index.md
 *
 * ── The ordering constraint, restated because it is the whole point ────────
 *
 * This must run **before the embedding call**, not merely before storage.
 * Embeddings go to a third party. A pipeline that redacts on the way into
 * Postgres but embeds the raw text has protected the database and disclosed the
 * document — which is exactly how the original incident happened.
 *
 * Everything here is deterministic and offline. A redactor that needed a network
 * call would itself become an egress path.
 */

import { scanText, type ScanMatch } from "./pack/scan.js";
import type { LoadedPack } from "./pack/load.js";

/** A single redaction, recorded so a run can be audited without the value. */
export interface RedactionFinding {
  kind: RedactionKind;
  /** How many instances were replaced. The values themselves are never kept. */
  count: number;
}

export type RedactionKind = "ssn" | "ein" | "routing" | "card" | "account";

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
  /** Total replacements across all kinds. */
  totalRedacted: number;
}

/** Placeholder left in place of a redacted value. */
const MASK: Record<RedactionKind, string> = {
  ssn: "[REDACTED-SSN]",
  ein: "[REDACTED-EIN]",
  routing: "[REDACTED-ROUTING]",
  card: "[REDACTED-CARD]",
  account: "[REDACTED-ACCT]",
};

/**
 * Apply replacements for HIGH-confidence matches only, right-to-left.
 *
 * Right-to-left matters: replacing left-to-right shifts every later offset by the
 * difference between the match length and the mask length, silently corrupting
 * subsequent replacements in a dense document.
 */
export function applyRedaction(
  text: string,
  matches: ScanMatch[],
  mask: (m: ScanMatch) => string,
): string {
  const high = matches
    .filter((m) => m.confidence === "high")
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of high)
    out = out.slice(0, m.start) + mask(m) + out.slice(m.end);
  return out;
}

/** Maps a pack scanner id onto the legacy RedactionKind for the mask table. */
function kindFor(scannerId: string): RedactionKind | undefined {
  return (["ssn", "ein", "routing", "card", "account"] as const).find(
    (k) => k === scannerId,
  );
}

/**
 * Redact structured identifiers from parsed document text, using every scanner
 * declared by `pack`.
 *
 * **This is the floor, not the whole answer.** It cannot detect a client's
 * *name*, which is the most common identifier in this corpus and is why
 * `isExcludedPath` (structural exclusion) does more of the real work.
 */
export function redactText(input: string, pack: LoadedPack): RedactionResult {
  const matches = scanText(input, pack);
  const text = applyRedaction(input, matches, (m) => {
    const k = kindFor(m.scannerId);
    return k ? MASK[k] : `[REDACTED-${m.scannerId.toUpperCase()}]`;
  });

  const counts = new Map<RedactionKind, number>();
  for (const m of matches) {
    if (m.confidence !== "high") continue;
    const k = kindFor(m.scannerId);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const findings = [...counts.entries()].map(([kind, count]) => ({
    kind,
    count,
  }));
  return {
    text,
    findings,
    totalRedacted: findings.reduce((a, f) => a + f.count, 0),
  };
}

// ── Layer 2 — structural exclusion ─────────────────────────────────────────

/**
 * Path fragments that mark a location as client-specific rather than
 * procedural. Derived from the 2026-08-03 screen, whose strongest signal was
 * **location, not content**: per-client billing and pricing files sat under
 * client-named folders.
 *
 * This layer is cheaper and more reliable than any detector, because a document
 * that is never fetched cannot leak. Expect it to remove most of the real risk.
 */
export const DEFAULT_EXCLUDED_PATH_FRAGMENTS: readonly string[] = [
  "client service package files",
  "client package pricing",
  "billing & production analysis",
  "billing and production analysis",
  "billing analysis",
  "production time analysis",
  "engagement letter",
  // Added 2026-08-03 after replaying the denylist against the real manifest:
  // 7 of the 17 highest-severity documents (all SSN-bearing) sat here, and no
  // billing-folder rule would ever have reached them.
  "/va disability",
];

export interface PathExclusionResult {
  excluded: boolean;
  /** Which fragment matched — recorded so exclusions are auditable. */
  reason?: string;
}

/**
 * Decide whether a source path should never be ingested.
 *
 * Case-insensitive substring match on the full path. Substring rather than
 * segment matching is deliberate: folder naming in this corpus is inconsistent
 * ("Batch 2/Client Package Pricing Sheets"), and a stricter matcher would miss
 * variants while offering no real precision benefit — the cost of a false
 * exclusion is one unindexed procedure, versus an indexed client file.
 */
export function isExcludedPath(
  path: string | undefined | null,
  fragments: readonly string[] = DEFAULT_EXCLUDED_PATH_FRAGMENTS,
): PathExclusionResult {
  if (!path) return { excluded: false };
  const haystack = path.toLowerCase();
  for (const f of fragments) {
    if (haystack.includes(f.toLowerCase())) {
      return { excluded: true, reason: f };
    }
  }
  return { excluded: false };
}

// ── Fail-closed wrapper ────────────────────────────────────────────────────

export class ContentSafetyError extends Error {
  readonly code = "CONTENT_SAFETY_FAILED";
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ContentSafetyError";
  }
}

/**
 * Apply redaction, failing CLOSED.
 *
 * If redaction throws, the caller must quarantine the document rather than
 * index it raw. A redactor that silently passes text through on failure is
 * worse than having none at all, because it manufactures confidence — the same
 * class of failure as an unmonitored backup.
 */
export function redactOrThrow(
  input: string,
  pack: LoadedPack,
): RedactionResult {
  try {
    return redactText(input, pack);
  } catch (err) {
    throw new ContentSafetyError(
      "redaction failed; document must be quarantined, not indexed",
      err,
    );
  }
}
