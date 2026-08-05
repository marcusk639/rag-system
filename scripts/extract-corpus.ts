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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  corpusFingerprint,
  evaluateExtractionGate,
  extractClaims,
  type ExtractedClaim,
  type ScreenSignoff,
  type ScreenState,
} from "@rag/rag";
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
  /** Ties a sign-off to a specific corpus state — see `corpusFingerprint`. */
  contentHash: string;
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
    contentHash: doc.contentHash,
    markdownChars: markdown.length,
    path: typeof meta.path === "string" ? meta.path : undefined,
    url: typeof meta.url === "string" ? meta.url : undefined,
    screenHits: screenDocument(markdown),
  };
}

// ---------------------------------------------------------------------------

interface Args {
  sourceId?: string;
  limit?: number;
  /** Opt-in. Extraction is an egress event and is never the default. */
  extract: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { extract: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) out.sourceId = argv[++i];
    if (argv[i] === "--limit" && argv[i + 1]) out.limit = Number(argv[++i]);
    if (argv[i] === "--extract") out.extract = true;
  }
  return out;
}

async function readJsonIfPresent<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Bare prompt-in/text-out call. Deliberately NOT `GeminiGenerator`, which
 * prepends the question-answering system prompt ("cite every claim using [N]",
 * "if the context does not contain the answer, say so") — tuned for cited Q&A
 * and actively hostile to a JSON extraction instruction.
 */
function makeGeminiComplete(apiKey: string, model: string) {
  const client = new GoogleGenAI({ apiKey });
  return async (prompt: string): Promise<string> => {
    const res = await client.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0 },
    });
    return res.text ?? "";
  };
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
    // Only retained when extraction was requested — holding the full text of
    // the whole corpus in memory is pointless for a screen-only run.
    const markdownByExternalId = new Map<string, string>();
    let scanned = 0;
    let withHits = 0;

    for await (const doc of iterateDocuments(db, {
      sourceId: args.sourceId,
      includeMarkdown: true,
      limit: 50,
    })) {
      const markdown = doc.markdown ?? "";
      const row = toInventoryRow(doc, markdown);
      rows.push(row);
      if (args.extract) markdownByExternalId.set(row.externalId, markdown);
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

    const statePath = path.join(outDir, "screen-state.json");
    const signoffPath = path.join(outDir, "screen-signoff.json");

    const fingerprint = corpusFingerprint(rows);
    const flaggedIds = rows
      .filter((r) => r.screenHits.length > 0)
      .map((r) => r.externalId);

    const screenState: ScreenState = {
      generatedAt: new Date().toISOString(),
      documentCount: rows.length,
      flaggedExternalIds: flaggedIds,
      corpusFingerprint: fingerprint,
    };
    await writeFile(
      statePath,
      JSON.stringify(screenState, null, 2) + "\n",
      "utf8",
    );

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
    console.log(`✓ state     → ${statePath}`);

    // -----------------------------------------------------------------------
    // Extraction — gated. Never runs without an explicit flag AND a current,
    // complete human sign-off on the screen above.
    // -----------------------------------------------------------------------
    if (!args.extract) {
      console.log(
        "\nScreen only. Extraction was not requested (`--extract`), and would " +
          "be refused until the screen is signed off.",
      );
    } else {
      const signoff = await readJsonIfPresent<ScreenSignoff>(signoffPath);
      const gate = evaluateExtractionGate(screenState, signoff);

      if (!gate.allowed) {
        console.error(`\n⛔ EXTRACTION REFUSED\n\n${gate.reason}\n`);
        console.error(
          "Extraction sends document text to a third-party model. The screen " +
            "is what establishes the corpus holds no client data, so it runs " +
            "first and a human signs for it.\n\n" +
            `To sign off, review ${reportPath} and write ${signoffPath}:\n` +
            JSON.stringify(
              {
                approvedBy: "Chris",
                approvedOn: new Date().toISOString().slice(0, 10),
                corpusFingerprint: screenState.corpusFingerprint,
                clearedExternalIds: screenState.flaggedExternalIds,
                excludedExternalIds: [],
              },
              null,
              2,
            ),
        );
        process.exitCode = 1;
        return;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is required for --extract.");
      }
      const complete = makeGeminiComplete(
        apiKey,
        process.env.GENERATION_MODEL || "gemini-2.0-flash",
      );

      console.log(
        `\n✓ gate passed — signed off by ${signoff!.approvedBy} on ${signoff!.approvedOn}`,
      );
      const skipped = gate.excludedExternalIds;
      if (skipped.size > 0) {
        console.log(`  excluding ${skipped.size} document(s) per the sign-off`);
      }

      const claims: ExtractedClaim[] = [];
      let rejected = 0;
      // Shape drops are counted by reason, not lumped. They used to be
      // reported wholesale as "missing distractor", which was true only while
      // an empty claim was silently discarded upstream and never counted at
      // all. Now that it is counted, one label for two causes would misname
      // whichever one actually happened.
      let droppedNoDistractor = 0;
      let droppedEmptyClaim = 0;
      const rungTotals = { exact: 0, whitespace: 0, unicode: 0, markdown: 0 };

      for (const row of rows) {
        if (skipped.has(row.externalId)) continue;
        const markdown = markdownByExternalId.get(row.externalId) ?? "";
        if (!markdown) continue;

        const res = await extractClaims(complete, {
          externalId: row.externalId,
          title: row.title,
          markdown,
          sourceModifiedAt: row.sourceModifiedAt,
        });
        claims.push(...res.claims);
        rejected += res.rejected.length;
        for (const d of res.droppedForShape) {
          if (d.reason.startsWith("no claim text")) droppedEmptyClaim++;
          else droppedNoDistractor++;
        }
        for (const k of Object.keys(
          rungTotals,
        ) as (keyof typeof rungTotals)[]) {
          rungTotals[k] += res.verification.rungCounts[k];
        }
        console.log(
          `  ${row.title}: ${res.claims.length} kept, ${res.rejected.length} unverifiable`,
        );
      }

      const claimsPath = path.join(outDir, "claims.jsonl");
      await writeFile(
        claimsPath,
        claims.map((c) => JSON.stringify(c)).join("\n") + "\n",
        "utf8",
      );

      const exactShare = claims.length ? rungTotals.exact / claims.length : 1;
      console.log(`\n✓ claims    → ${claimsPath}  (${claims.length} verified)`);
      console.log(
        `  ${rejected} claim(s) dropped — quote not locatable in the source`,
      );
      console.log(
        `  ${droppedNoDistractor} dropped for shape (missing distractor)`,
      );
      if (droppedEmptyClaim > 0) {
        console.log(
          `  ${droppedEmptyClaim} dropped for shape (empty claim text) — the ` +
            "model emitted a claim object with nothing in it",
        );
      }
      console.log(
        `  rung mix: exact ${rungTotals.exact} · whitespace ${rungTotals.whitespace} ` +
          `· unicode ${rungTotals.unicode} · markdown ${rungTotals.markdown}`,
      );
      if (claims.length > 0 && exactShare < 0.5) {
        console.log(
          `\n⚠ Only ${Math.round(exactShare * 100)}% matched exactly. The model is ` +
            "paraphrasing rather than quoting. Tighten the extraction prompt — " +
            "do NOT loosen the matcher.",
        );
      }
    }
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
