/**
 * `pnpm eval:gold` — score the DEPLOYED knowledge base against the gold set.
 *
 * Standalone runner, not a vitest spec: it needs a running API and a token,
 * and it measures the real SharePoint corpus rather than a synthetic one.
 * Read-only — it only calls POST /ask and GET /documents/:id.
 *
 * Usage:
 *   GOLD_API_URL=https://rag-api.example GOLD_API_TOKEN=... pnpm eval:gold
 *   GOLD_OUT=gold-2026-09-16.json   # optional: also write the JSON report
 *
 * ⚠ GOLD_OUT contains real answers from the firm's knowledge base. It is
 * gitignored (gold-*.json) but is still firm-confidential material.
 *
 * Refuses to run while the gold set is empty or invalid (see gold-set.ts and
 * docs/EVAL-GOLD-SET-GUIDE.md) — an empty run would print healthy-looking
 * zeros that mean nothing.
 */
import { writeFile } from "node:fs/promises";
import { GOLD_QUESTIONS, validateGoldSet } from "./gold-set.js";
import {
  scoreGoldRun,
  type GoldObservation,
  type GoldReport,
} from "./gold-eval.js";

interface AskResponse {
  answer: string;
  citations: Array<{ documentId: string }>;
  retrieved: Array<{ document: { id: string } }>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`eval:gold: ${name} is required\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  if (GOLD_QUESTIONS.length === 0) {
    process.stderr.write(
      "eval:gold: the gold set is empty — nothing to score. Author questions " +
        "with firm staff first (docs/EVAL-GOLD-SET-GUIDE.md).\n",
    );
    process.exit(2);
  }
  const issues = validateGoldSet(GOLD_QUESTIONS);
  if (issues.length > 0) {
    for (const i of issues) process.stderr.write(`  ${i.id}: ${i.problem}\n`);
    process.stderr.write("eval:gold: fix the gold set before scoring.\n");
    process.exit(2);
  }

  const apiUrl = requireEnv("GOLD_API_URL").replace(/\/$/, "");
  assertSafeApiUrl(apiUrl);
  const token = requireEnv("GOLD_API_TOKEN");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const externalIds = new Map<string, string>();
  async function externalIdOf(documentId: string): Promise<string> {
    const cached = externalIds.get(documentId);
    if (cached) return cached;
    const res = await fetch(`${apiUrl}/documents/${documentId}`, { headers });
    if (!res.ok)
      throw new Error(`GET /documents/${documentId} → ${res.status}`);
    const doc = (await res.json()) as { externalId: string };
    externalIds.set(documentId, doc.externalId);
    return doc.externalId;
  }
  const unique = (xs: string[]) => [...new Set(xs)];

  const observations: GoldObservation[] = [];
  for (const q of GOLD_QUESTIONS) {
    try {
      const res = await fetch(`${apiUrl}/ask`, {
        method: "POST",
        headers,
        body: JSON.stringify({ question: q.query }),
      });
      if (!res.ok) throw new Error(`POST /ask → ${res.status}`);
      const body = (await res.json()) as AskResponse;
      observations.push({
        id: q.id,
        answer: body.answer,
        retrievedExternalIds: unique(
          await Promise.all(
            body.retrieved.map((r) => externalIdOf(r.document.id)),
          ),
        ),
        citedExternalIds: unique(
          await Promise.all(
            body.citations.map((c) => externalIdOf(c.documentId)),
          ),
        ),
      });
      process.stdout.write(".");
    } catch (err) {
      process.stdout.write("x");
      process.stderr.write(`\n  ${q.id}: ${String(err)}\n`);
    }
    // /ask is rate-limited to 10/min per client.
    await new Promise((r) => setTimeout(r, 6_500));
  }
  process.stdout.write("\n");

  const report = scoreGoldRun(GOLD_QUESTIONS, observations);
  process.stdout.write(formatGoldReport(report) + "\n");
  if (process.env.GOLD_OUT) {
    process.stderr.write(
      `eval:gold: writing REAL knowledge-base answers to ${process.env.GOLD_OUT} — ` +
        "treat it as firm-confidential; do not commit or share it.\n",
    );
    await writeFile(
      process.env.GOLD_OUT,
      JSON.stringify(
        { ranAt: new Date().toISOString(), report, observations },
        null,
        2,
      ),
    );
  }
  const hardFail =
    report.fabricatedCitations.length > 0 || report.missing.length > 0;
  process.exit(hardFail ? 1 : 0);
}

/**
 * The bearer token goes to this URL on every request: require https, except
 * for a local API during development.
 */
function assertSafeApiUrl(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    process.stderr.write("eval:gold: GOLD_API_URL is not a valid URL\n");
    process.exit(2);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    process.stderr.write(
      "eval:gold: GOLD_API_URL must be https (http is allowed only for localhost) — the API token is sent with every request\n",
    );
    process.exit(2);
  }
}

function formatGoldReport(r: GoldReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `Gold set — ${r.answerable} answerable, ${r.coverage.total} out-of-coverage`,
    ...r.ks.map((k) => `  recall@${k}: ${pct(r.recallAtK[k] ?? 0)}`),
    `  MRR: ${r.mrr.toFixed(3)}`,
    `  out-of-coverage correctly refused: ${r.coverage.correctlyRefused}/${r.coverage.total}`,
    `  answerable but refused: ${r.wrongRefusals.join(", ") || "none"}`,
    `  fabricated citations (hard fail): ${r.fabricatedCitations.map((f) => f.id).join(", ") || "none"}`,
    `  truncated: ${r.truncated.join(", ") || "none"}`,
    `  failed requests (hard fail): ${r.missing.join(", ") || "none"}`,
  ].join("\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`eval:gold failed: ${String(err)}\n`);
  process.exit(1);
});
