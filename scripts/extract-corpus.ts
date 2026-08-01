/**
 * Read-only corpus extraction pass.
 *
 * Walks every indexed document and produces two artefacts:
 *
 *   1. **An inventory** — one JSONL row per document (externalId, title,
 *      last-modified, size, path). This is the raw material for corpus-grounded
 *      claim extraction, and it is also the first time anyone has seen the shape
 *      of the corpus as a list rather than as search results.
 *
 *   2. **A client-identifier screen** — a deterministic scan for material that
 *      would place a document outside the Class A/B safe lane. ISS-05 calls this
 *      "the real gate": the corpus is classified internal-only **by default, not
 *      because anyone checked.** This pass reads every document anyway, so the
 *      screen is nearly free here and expensive to retrofit.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────
 *
 * This script touches PRODUCTION data. It therefore:
 *   - opens the database through `createReadOnlyDb`, whose connections begin
 *     every transaction read-only at the server (`default_transaction_read_only`);
 *   - proves it with `assertReadOnly` before reading anything, so the guarantee
 *     is "the server just refused a write," not "I passed the right factory";
 *   - never imports `truncateAll` or `seedEvalCorpus`. See C3 in
 *     `docs/ISSUES-AND-OPTIMIZATIONS.md` — the only pre-existing real-embedder
 *     runner truncates the database, and copying it is the failure mode this
 *     script exists to avoid.
 *
 * ── Output is firm-confidential ────────────────────────────────────────────
 *
 * The inventory contains real SOP titles and folder paths. `corpus-analysis/`
 * is gitignored. Do not move the output anywhere tracked, and do not paste
 * titles into a commit message or an issue.
 *
 * Run from the repo root:
 *   DATABASE_URL=... pnpm exec tsx scripts/extract-corpus.ts
 *   DATABASE_URL=... pnpm exec tsx scripts/extract-corpus.ts --source <uuid> --limit 30
 *
 * (`@rag/*` are root devDependencies so scripts here resolve them. Before
 * 2026-08-01 they were not, which meant no script in this directory could
 * import a workspace package — `reembed-chunks.ts` documented an invocation
 * that could not have worked.)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertReadOnly,
  countDocuments,
  createReadOnlyDb,
  iterateDocuments,
  pgSslOption,
  type DocumentSummary,
} from "@rag/db";

// ---------------------------------------------------------------------------
// Client-identifier screen
// ---------------------------------------------------------------------------

/**
 * Deterministic patterns only — no model judgment. A regex that fires is a
 * *candidate* for human review, never a verdict: the output of this screen is a
 * shortlist for Chris or Doug, not a classification.
 *
 * Deliberately tuned to over-report. A false positive costs someone ten seconds
 * of reading; a false negative is a Class C/D document sitting in a corpus
 * everyone believes is Class A/B.
 */
interface ScreenPattern {
  id: string;
  /** What a hit would mean, in plain language, for the reviewer. */
  meaning: string;
  re: RegExp;
}

const SCREEN_PATTERNS: ScreenPattern[] = [
  {
    id: "ssn",
    meaning: "Looks like a Social Security number — Class D if real",
    // Not \d{3}-\d{2}-\d{4} alone: that also matches phone-ish and date-ish
    // strings. Require the canonical shape at a word boundary.
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    id: "ein",
    meaning: "Looks like an Employer Identification Number",
    re: /\b\d{2}-\d{7}\b/g,
  },
  {
    id: "bank-account",
    meaning: "Possible bank routing/account number",
    re: /\b(?:routing|aba|account)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d{6,17}\b/gi,
  },
  {
    id: "tax-form-with-data",
    meaning: "Names a taxpayer-specific return form — may be a filled return",
    re: /\b(?:form\s*)?(?:1040|1120S?|1065|941|940|W-2|1099-[A-Z]{1,4}|K-1)\b/gi,
  },
  {
    id: "client-file-language",
    meaning: "Phrasing typical of a client deliverable rather than an SOP",
    re: /\b(?:dear\s+(?:mr|mrs|ms|dr)\b|engagement\s+letter|invoice\s+(?:no|number|#)|taxpayer\s+name)/gi,
  },
];

interface ScreenHit {
  patternId: string;
  meaning: string;
  count: number;
  /** First match, truncated — enough to triage, not enough to leak a full id. */
  sample: string;
}

function redact(s: string): string {
  // Keep shape, drop the value: 123-45-6789 -> 1XX-XX-XXX9
  if (s.length <= 2) return "X".repeat(s.length);
  return s[0] + "X".repeat(Math.min(s.length - 2, 12)) + s[s.length - 1];
}

function screenDocument(markdown: string): ScreenHit[] {
  const hits: ScreenHit[] = [];
  for (const p of SCREEN_PATTERNS) {
    const matches = markdown.match(p.re);
    if (!matches || matches.length === 0) continue;
    hits.push({
      patternId: p.id,
      meaning: p.meaning,
      count: matches.length,
      sample: redact(matches[0]!.slice(0, 24)),
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface InventoryRow {
  externalId: string;
  title: string;
  mimeType: string;
  sourceModifiedAt: string | null;
  sizeBytes: number | null;
  markdownChars: number;
  /** Folder path if the connector recorded one — the KB's actual structure. */
  path?: string;
  url?: string;
  screenHits: ScreenHit[];
}

function toInventoryRow(doc: DocumentSummary, markdown: string): InventoryRow {
  const meta = doc.metadata ?? {};
  return {
    externalId: doc.externalId,
    title: doc.title,
    mimeType: doc.mimeType,
    sourceModifiedAt: doc.sourceModifiedAt
      ? doc.sourceModifiedAt.toISOString()
      : null,
    sizeBytes: doc.sizeBytes,
    markdownChars: markdown.length,
    path: typeof meta.path === "string" ? meta.path : undefined,
    url: typeof meta.url === "string" ? meta.url : undefined,
    screenHits: screenDocument(markdown),
  };
}

// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { sourceId?: string; limit?: number } {
  const out: { sourceId?: string; limit?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) out.sourceId = argv[++i];
    if (argv[i] === "--limit" && argv[i + 1]) out.limit = Number(argv[++i]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Deliberately NOT loadConfig(): this pass needs a database URL and nothing
  // else. Pulling the full config would demand embedding/generation settings
  // and API keys the walk never uses — and requiring no keys is a property
  // worth keeping, because it means this script makes zero external calls.
  // Nothing leaves the machine; the corpus is only read.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (read-only connection).");
  }
  const sslMode = process.env.DATABASE_SSL as
    "disable" | "require" | "no-verify" | undefined;

  const { db, close } = createReadOnlyDb(databaseUrl, {
    ssl: pgSslOption(sslMode || undefined),
  });

  try {
    // Prove it, do not assume it. This is the whole safety story.
    await assertReadOnly(db);
    console.log(
      "✓ connection verified read-only (server refused a write probe)",
    );

    const total = await countDocuments(db, { sourceId: args.sourceId });
    console.log(
      `Walking ${args.limit ? `up to ${args.limit} of ` : ""}${total} document(s)` +
        (args.sourceId ? ` in source ${args.sourceId}` : " across all sources"),
    );

    const rows: InventoryRow[] = [];
    let scanned = 0;
    let withHits = 0;

    for await (const doc of iterateDocuments(db, {
      sourceId: args.sourceId,
      includeMarkdown: true,
      limit: 50,
    })) {
      const row = toInventoryRow(doc, doc.markdown ?? "");
      rows.push(row);
      scanned++;
      if (row.screenHits.length > 0) withHits++;

      if (scanned % 100 === 0) console.log(`  … ${scanned}/${total}`);
      if (args.limit && scanned >= args.limit) break;
    }

    // Relative to this file, NOT cwd: `pnpm --filter … exec` runs from the
    // package directory, so cwd-relative output would scatter across packages.
    const repoRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
    );
    const outDir = path.join(repoRoot, "corpus-analysis");
    await mkdir(outDir, { recursive: true });

    const inventoryPath = path.join(outDir, "inventory.jsonl");
    await writeFile(
      inventoryPath,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    // Screen report — the artefact a human actually reads.
    const flagged = rows.filter((r) => r.screenHits.length > 0);
    const byPattern = new Map<string, number>();
    for (const r of flagged) {
      for (const h of r.screenHits) {
        byPattern.set(h.patternId, (byPattern.get(h.patternId) ?? 0) + 1);
      }
    }

    const report = [
      "# Corpus client-identifier screen",
      "",
      `Scanned **${scanned}** documents. **${withHits}** carry at least one pattern hit.`,
      "",
      "> ⚠ **A hit is a candidate for review, not a verdict.** The screen is",
      "> deliberately tuned to over-report — a false positive costs ten seconds of",
      "> reading; a false negative is a Class C/D document sitting in a corpus",
      "> everyone believes is Class A/B. Expect most `tax-form-with-data` hits to",
      "> be SOPs that legitimately *name* a form without containing one.",
      "",
      "## Hits by pattern",
      "",
      "| Pattern | Documents | What a hit would mean |",
      "| ------- | --------: | --------------------- |",
      ...SCREEN_PATTERNS.map(
        (p) => `| \`${p.id}\` | ${byPattern.get(p.id) ?? 0} | ${p.meaning} |`,
      ),
      "",
      "## Documents to review",
      "",
      ...(flagged.length === 0
        ? ["_None flagged._"]
        : flagged.map(
            (r) =>
              `- **${r.title}** — ${r.screenHits
                .map((h) => `\`${h.patternId}\`×${h.count}`)
                .join(", ")}${r.path ? ` — \`${r.path}\`` : ""}`,
          )),
      "",
      "---",
      "",
      "**Next:** this list is the document-list review ISS-05 calls the real gate.",
      "It needs Chris or Doug, not an attorney — the question is only whether any",
      "of these hold client-identifying material.",
      "",
    ].join("\n");

    const reportPath = path.join(outDir, "client-identifier-screen.md");
    await writeFile(reportPath, report, "utf8");

    console.log(`\n✓ inventory → ${inventoryPath}  (${rows.length} rows)`);
    console.log(`✓ screen    → ${reportPath}  (${withHits} flagged)`);
    console.log(
      "\n🔒 Both files contain real SOP titles and paths. `corpus-analysis/` is " +
        "gitignored — keep it that way, and do not paste titles into commits.",
    );
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
