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

/** Luhn check — cheap and precise, kills most false card matches. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ABA routing checksum. Same rationale as Luhn: precision over recall. */
function abaValid(d: string): boolean {
  if (d.length !== 9) return false;
  // Weighted 3-7-1 repeating. Written as a loop rather than indexed arithmetic
  // so it type-checks under noUncheckedIndexedAccess without non-null casts.
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const digit = d.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    sum += digit * (weights[i % 3] as number);
  }
  return sum % 10 === 0;
}

/**
 * A tax SOP legitimately contains form numbers, dates, dollar amounts, section
 * references and percentages. Redacting those turns the document into unusable
 * prose — the failure that looks like success. Every pattern below is therefore
 * either delimiter-anchored or checksum-gated.
 *
 * ⚠ Bare 9-digit runs are NOT treated as SSNs. In this corpus they are far more
 * often amounts or IDs, and the resulting over-redaction would destroy the SOPs
 * the assistant exists to answer from. Context-gated only (see `account`).
 */
const PATTERNS: {
  kind: RedactionKind;
  re: RegExp;
  validate?: (m: string) => boolean;
}[] = [
  // 123-45-6789 — delimiter-anchored, so a form number cannot match.
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // 12-3456789
  { kind: "ein", re: /\b\d{2}-\d{7}\b/g },
  // 9-digit runs only when the ABA checksum passes AND routing vocabulary is near.
  {
    kind: "routing",
    re: /\b\d{9}\b/g,
    validate: (m) => abaValid(m),
  },
  // 13–19 digits, Luhn-valid, optionally space/dash grouped.
  {
    kind: "card",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhnValid(m.replace(/[ -]/g, "")),
  },
];

/** Vocabulary that must appear near a candidate for the weak patterns to fire. */
const ACCOUNT_CONTEXT =
  /\b(account|acct|routing|aba|bank|iban|swift|deposit|wire)\b/i;

/**
 * Redact structured identifiers from parsed document text.
 *
 * **This is the floor, not the whole answer.** It cannot detect a client's
 * *name*, which is the most common identifier in this corpus and is why
 * `isExcludedPath` (structural exclusion) does more of the real work.
 */
export function redactText(input: string): RedactionResult {
  const counts = new Map<RedactionKind, number>();
  let text = input;

  for (const { kind, re, validate } of PATTERNS) {
    text = text.replace(new RegExp(re.source, re.flags), (match, offset) => {
      if (validate && !validate(match)) return match;

      // Checksum-only patterns still need context, or every 9-digit number that
      // happens to satisfy ABA gets masked.
      if (kind === "routing") {
        const window = text.slice(
          Math.max(0, Number(offset) - 60),
          Number(offset) + match.length + 60,
        );
        if (!ACCOUNT_CONTEXT.test(window)) return match;
      }

      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return MASK[kind];
    });
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
export function redactOrThrow(input: string): RedactionResult {
  try {
    return redactText(input);
  } catch (err) {
    throw new ContentSafetyError(
      "redaction failed; document must be quarantined, not indexed",
      err,
    );
  }
}
