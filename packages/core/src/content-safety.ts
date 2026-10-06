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
 * Layers 1 and 3 below (pattern redaction, classification) are deterministic
 * and offline — a redactor that needed a network call would itself become an
 * egress path. Layer 1.5 (`scanForClientContextOrThrow`) is the deliberate
 * exception: it calls a `ContentScanner`, which MUST be self-hosted
 * on-process or on the firm's own network (see `docs/LOCAL-GENERATION.md`),
 * never a third-party API — calling an external LLM "is this sensitive?"
 * would itself be the disclosure this file exists to prevent.
 *
 * ── Where the rules live ───────────────────────────────────────────────────
 *
 * The per-match identifier rules are NOT in this file. They are declared as
 * data in a vertical's pack (`packs/<vertical>/pack.yaml`) and executed by
 * `scanText`; this module turns those matches into masked text and auditable
 * counts. The one exception is the tabular density sweep below, which is a
 * whole-document property the pack contract cannot yet express.
 */

import { scanText, type ScanMatch } from "./pack/scan.js";
import type { LoadedPack } from "./pack/load.js";
import type { ParsedTable } from "./types.js";
import type { ContentScanner, ContentScanResult } from "./interfaces.js";

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
 * Apply replacements for HIGH-confidence matches only, in a single
 * left-to-right pass.
 *
 * Ruling R9: overlapping `high` ranges are merged into a single masked span BEFORE
 * replacement, rather than replaced independently. Two overlapping replacements
 * applied independently corrupt the text: the second (leftmost-start) match's
 * `end` offset was computed against the ORIGINAL text and would go stale the
 * instant an earlier replacement changed the string's length — the observed
 * failure mode was silent, with a mask token AND trailing document text both
 * disappearing. Merging the union and masking it once with a single token
 * cannot do that: every byte of every overlapping match's span is covered by
 * exactly one replacement, so no fragment of a redacted value can survive.
 * Merely ADJACENT matches (one's `end` equals the next's `start`) are NOT
 * merged — they don't corrupt each other, and merging them would mask text no
 * scanner actually matched.
 *
 * Performance: after merging, `spans` is disjoint and start-sorted, so the
 * output is built with a single left-to-right pass — copy the gap before each
 * span, then the mask, advancing a cursor — collecting pieces into an array
 * joined once at the end. This is O(text length + matches), not O(matches ×
 * text length). The prior implementation rebuilt the whole string via
 * `slice`+concat once per span (`out = out.slice(0, s) + mask + out.slice(e)`),
 * which on a 1.6 MB document with 60,000 matches took ~6.9s on one core —
 * long enough to block the worker's event loop, cause pg-boss to miss its
 * heartbeat and reap the job as stalled, and have the retry repeat the same
 * quadratic pass. There is no offset-staleness risk in switching directions
 * here: spans are already disjoint and sorted, so each is resolved against
 * the immutable input `text`, never against a partially-rebuilt string.
 */
export function applyRedaction(
  text: string,
  matches: ScanMatch[],
  mask: (m: ScanMatch) => string,
): string {
  const high = matches
    .filter((m) => m.confidence === "high")
    .sort((a, b) => a.start - b.start);

  // Coalesce overlapping matches into spans. Each span's `token` is the FIRST
  // (earliest-starting, i.e. outermost) match that opened it — never
  // reassigned as later overlapping matches extend the span — per R9's
  // instruction to mask with the earliest contributing scanner's token.
  const spans: { start: number; end: number; token: ScanMatch }[] = [];
  for (const m of high) {
    const open = spans[spans.length - 1];
    if (open && m.start < open.end) {
      open.end = Math.max(open.end, m.end);
    } else {
      spans.push({ start: m.start, end: m.end, token: m });
    }
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(text.slice(cursor, span.start), mask(span.token));
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/**
 * Maps a pack scanner id onto the RedactionKind used for the mask token and
 * the finding counts.
 *
 * The segment before the first `-` is the kind, so a pack can declare several
 * scanners for one identifier — `ssn` (delimited) and `ssn-unformatted`
 * (label-gated bare digits) both count as `ssn` and both mask as
 * `[REDACTED-SSN]`. Pack ids must be unique, so variants of one identifier
 * need distinct ids; without this they would each report as their own kind and
 * fragment the audit counts.
 *
 * An unrecognised id is not an error — `redactText` falls back to a generic
 * `[REDACTED-<ID>]` token, so a pack can declare a scanner this list has never
 * heard of and still get it redacted.
 */
function kindFor(scannerId: string): RedactionKind | undefined {
  const base = scannerId.split("-")[0];
  return (["ssn", "ein", "routing", "card", "account"] as const).find(
    (k) => k === base,
  );
}

/**
 * Identifier vocabulary anywhere in the document. Deliberately narrower than
 * the pack's `account-vocab` context: this gates a whole-document sweep, so it
 * must not fire on ordinary banking prose.
 */
const IDENTIFIER_VOCAB =
  /\b(ssn|ssns|social\s+security|tin|itin|taxpayer\s+id)\b/i;

/**
 * Minimum bare 9-digit runs before the tabular sweep fires.
 *
 * The corpus screen's worst document held 522 SSN-shaped values in a
 * spreadsheet. Parsed to markdown a row reads `| Smith, John | 123456789 |
 * 45,200 |` — the "SSN" header sits rows away, so no adjacent-label rule can
 * reach it, and the ABA gate does not fire on a non-routing number. It was
 * caught by nothing.
 *
 * DENSITY separates a roster from a procedure: a roster carries a column of
 * them, an SOP carries none or one incidental reference number. Requiring
 * repetition AND vocabulary targets the roster shape without redacting the
 * documents the assistant exists to answer from. Three is low enough to catch a
 * short roster, high enough that a lone reference number is safe.
 *
 * This sweep stays in code rather than moving into the pack with the other
 * rules: it is a property of the WHOLE DOCUMENT (how many candidates appear,
 * and whether vocabulary occurs anywhere in it), and a pack scanner is a
 * per-match regex with a bounded context window. Expressing it as pack data
 * needs a document-scoped scanner kind the contract does not have yet.
 */
const COLUMN_DENSITY_THRESHOLD = 3;

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
  // `let` — the tabular sweep below rewrites this after the pack's scanners run.
  let text = applyRedaction(input, matches, (m) => {
    const k = kindFor(m.scannerId);
    return k ? MASK[k] : `[REDACTED-${m.scannerId.toUpperCase()}]`;
  });

  const counts = new Map<RedactionKind, number>();
  for (const m of matches) {
    if (m.confidence !== "high") continue;
    const k = kindFor(m.scannerId);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  // Tabular sweep. A roster's SSN column has its header rows away, so no
  // adjacent-label rule reaches it. Gated on vocabulary AND repetition so a
  // procedure document with one incidental reference number is untouched.
  // Density is measured against the ORIGINAL input: the label-gated pattern
  // above may already have masked the first value in the column, and counting
  // the survivors would drop a genuine roster below the threshold.
  if (IDENTIFIER_VOCAB.test(input)) {
    const bare = input.match(/\b\d{9}\b/g) ?? [];
    if (bare.length >= COLUMN_DENSITY_THRESHOLD) {
      text = text.replace(/\b\d{9}\b/g, () => {
        counts.set("ssn", (counts.get("ssn") ?? 0) + 1);
        return MASK.ssn;
      });
    }
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
 *
 * `LoadedPack` is an exported, structurally-constructible interface, so a
 * caller (a test fixture, or a future direct construction of `WorkerDeps.pack`)
 * can hand in a pack with `scanners: []`. `loadPack` enforces `scanners.min(1)`
 * at load time, but nothing downstream re-checked that invariant: an
 * empty-scanner pack made every guard pass — `scanText` loops zero times,
 * `applyRedaction` returns the input verbatim, `findings` stays empty,
 * `totalRedacted` is 0 — while raw identifiers went to the embedding provider
 * on a run that looked completely healthy. This check closes that hole here,
 * at the one function every redaction path funnels through, so the failure
 * surfaces as a `ContentSafetyError` and flows into the same quarantine path
 * as any other redaction failure, rather than a silent pass-through.
 */
export function redactOrThrow(
  input: string,
  pack: LoadedPack,
): RedactionResult {
  if (pack.scanners.length === 0) {
    throw new ContentSafetyError(
      `pack "${pack.id}" declares no scanners — refusing to redact; an ` +
        "empty-scanner pack would let every document through unredacted " +
        "while every guard reports a clean, healthy run",
    );
  }
  try {
    return redactText(input, pack);
  } catch (err) {
    throw new ContentSafetyError(
      "redaction failed; document must be quarantined, not indexed",
      err,
    );
  }
}

/**
 * Layer 1.5 — semantic scan for client-identifying context that pattern
 * redaction (Layer 1) structurally cannot see. A name in running prose has no
 * fixed shape a regex can match, which is exactly the gap the 2026-08-03
 * screen found: per-client files were identified by folder and by content a
 * human recognized, not by a pattern.
 *
 * This layer DETECTS rather than redacts. Surgically masking a name out of
 * prose risks under-redaction (a nickname, a second mention) and
 * over-redaction (destroying the sentence around it) in a way a fixed-width
 * `[REDACTED-SSN]` substitution does not. A flagged finding is handed to the
 * Layer 3 classification gate, which quarantines for human review — the same
 * disposition redaction findings already get, and the one this corpus's own
 * audit (Gate 1) exists to perform.
 *
 * Fail-closed on a scanner that THROWS: the document is quarantined rather
 * than indexed with the check silently skipped.
 *
 * This is deliberately NOT the same contract as `redactOrThrow`, which runs
 * unconditionally. Layer 1.5 is opt-in (`CONTENT_SCAN_PROVIDER`, default
 * `none`), and "the operator did not turn it on" cannot justify quarantining
 * every document — that is the shipped default, and it has to behave as it
 * did before this layer existed. So the caller decides whether to scan at
 * all, and this function takes a scanner that EXISTS. The two states that
 * must never be confused are kept apart upstream instead: a provider set but
 * unbuildable throws in `createContentScanner` at startup, and `loadConfig`
 * refuses `none` under `COMPLIANCE_MODE=client-data`.
 */
export async function scanForClientContextOrThrow(
  text: string,
  scanner: ContentScanner,
): Promise<ContentScanResult> {
  try {
    return await scanner.scan(text);
  } catch (err) {
    throw new ContentSafetyError(
      "semantic content scan failed; document must be quarantined, not indexed",
      err,
    );
  }
}

// ── Whole-document redaction ───────────────────────────────────────────────

/**
 * Separators used to redact a table grid as ONE string. Neither is a word
 * character or whitespace, so no pack pattern (`\b`, `\s`, `[-\s]`) can match
 * across a cell or row boundary, while the grid still gives the whole-table
 * context the label-gated and density-swept rules need (an `SSN` header rows
 * above its values).
 *
 * ⚠ The guarantee is only as strong as the pack's patterns: a regex `.` or
 * `[\s\S]` DOES match these separators. The label-gated `ssn-unformatted`
 * lookbehind relies on exactly that to reach from a header into a row. Do not
 * write a VALUE pattern that uses `.` between digit groups.
 */
const CELL_SEP = "␟";
const ROW_SEP = "␞";

export interface RedactableParsedDocument {
  title: string;
  markdown: string;
  tables?: ParsedTable[];
}

export interface RedactedParsedDocument extends RedactionResult {
  title: string;
  /** Alias of `text`: the redacted markdown. */
  markdown: string;
  tables: ParsedTable[];
}

function redactGrid(
  table: ParsedTable,
  pack: LoadedPack,
): { headers: string[]; rows: string[][]; findings: RedactionFinding[] } {
  const grid = [table.headers ?? [], ...(table.rows ?? [])];
  for (const row of grid) {
    for (const cell of row) {
      if (cell.includes(CELL_SEP) || cell.includes(ROW_SEP)) {
        throw new ContentSafetyError(
          "table cell contains an internal redaction separator; cannot " +
            "redact the grid safely, so the document must be quarantined",
        );
      }
    }
  }
  const joined = grid.map((row) => row.join(CELL_SEP)).join(ROW_SEP);
  const r = redactText(joined, pack);
  const out = r.text.split(ROW_SEP).map((row) => row.split(CELL_SEP));
  const shapeMatches =
    out.length === grid.length &&
    out.every((row, i) => row.length === Math.max(grid[i]?.length ?? 0, 1));
  // A zero-cell row joins to "" and splits back to [""] — accept that as the
  // only permitted shape difference; anything else means a mask consumed a
  // separator, and the cells can no longer be trusted to line up.
  if (!shapeMatches) {
    throw new ContentSafetyError(
      "table redaction changed the grid shape; refusing to index the table",
    );
  }
  const restored = out.map((row, i) =>
    (grid[i]?.length ?? 0) === 0 ? [] : row,
  );
  return {
    headers: restored[0] ?? [],
    rows: restored.slice(1),
    findings: r.findings,
  };
}

function addFindings(
  into: Map<RedactionKind, number>,
  findings: readonly RedactionFinding[],
): void {
  for (const f of findings) into.set(f.kind, (into.get(f.kind) ?? 0) + f.count);
}

/**
 * Redact EVERY text-bearing field of a parsed document, failing CLOSED.
 *
 * Redacting only `markdown` is not enough: spreadsheet chunks are built from
 * `tables[].headers/rows`, and the title is stored, displayed in citations, and
 * sent to the model. Those were never redacted, so a pack match that masked the
 * markdown left the same value intact in the table chunks.
 *
 * Findings are reported per kind as `title + max(markdown, tables)`. Every
 * parser route renders its tables INTO the markdown as well (spreadsheet
 * sheets, Unstructured HTML tables, MarkItDown tables extracted from its own
 * markdown — services/parser-py/app/main.py), so the tables are a mirror, and
 * summing would double every count in the audit trail.
 */
export function redactParsedDocument(
  doc: RedactableParsedDocument,
  pack: LoadedPack,
): RedactedParsedDocument {
  const markdown = redactOrThrow(doc.markdown, pack);
  const title = redactOrThrow(doc.title, pack);
  const tableCounts = new Map<RedactionKind, number>();
  let tables: ParsedTable[];
  try {
    tables = (doc.tables ?? []).map((t) => {
      const grid = redactGrid(t, pack);
      addFindings(tableCounts, grid.findings);
      // `markdown` mirrors the grid, so it is masked but not counted; caption
      // and sheet name are independent text, so their findings count.
      const optional = (value: string | null | undefined) => {
        if (value == null) return value;
        const r = redactText(value, pack);
        addFindings(tableCounts, r.findings);
        return r.text;
      };
      return {
        ...t,
        markdown: redactText(t.markdown, pack).text,
        caption: optional(t.caption),
        sheetName: optional(t.sheetName),
        headers: grid.headers,
        rows: grid.rows,
      };
    });
  } catch (err) {
    if (err instanceof ContentSafetyError) throw err;
    throw new ContentSafetyError(
      "table redaction failed; document must be quarantined, not indexed",
      err,
    );
  }

  const markdownCounts = new Map<RedactionKind, number>();
  addFindings(markdownCounts, markdown.findings);
  const totals = new Map<RedactionKind, number>();
  for (const kind of new Set([
    ...markdownCounts.keys(),
    ...tableCounts.keys(),
  ])) {
    totals.set(
      kind,
      Math.max(markdownCounts.get(kind) ?? 0, tableCounts.get(kind) ?? 0),
    );
  }
  addFindings(totals, title.findings);
  const findings = [...totals.entries()].map(([kind, count]) => ({
    kind,
    count,
  }));
  return {
    text: markdown.text,
    markdown: markdown.text,
    title: title.text,
    tables,
    findings,
    totalRedacted: findings.reduce((a, f) => a + f.count, 0),
  };
}
