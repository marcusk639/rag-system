#!/usr/bin/env node
/**
 * Generates the P0 gate #1 content-audit worksheet — the short list Chris and
 * Doug sign off on, one row per indexed document.
 *
 * WHY THIS EXISTS AS A GENERATOR AND NOT A COMMITTED FILE
 *
 * The worksheet contains document titles and SharePoint paths. The TRI scanner
 * screens document *bodies* for identifier patterns; it does not promise that a
 * title or a folder name is free of client-identifying material, and that is
 * exactly the judgment gate #1 asks a human to make. So the output must never
 * enter git — the same reasoning that keeps `gold-*.json` out (see .gitignore),
 * and the same mistake PR #43 was cleaning up.
 *
 * This script therefore:
 *   - writes to a path matched by .gitignore, and refuses to overwrite a
 *     git-TRACKED file even if asked;
 *   - prints only aggregate counts to stdout, never a title or a path, so a
 *     terminal transcript or CI log cannot leak the corpus.
 *
 * WHERE TO POINT IT
 *
 * Production `DATABASE_URL` resolves `rag-postgres.railway.internal`, which does
 * not resolve outside Railway's network, and `rag-postgres` deliberately exposes
 * no public URL. Run this against a RESTORED COPY of a nightly backup
 * (docs/BACKUP-SCHEDULE-RUNBOOK.md) rather than production. That is not a
 * workaround — it makes every audit double as a restore drill, which is the
 * open row in P0 gate #3.
 *
 * Usage:
 *   node scripts/gate1-content-audit.mjs --url postgresql://rag:drill@localhost:55433/rag
 *   node scripts/gate1-content-audit.mjs --url "$URL" --out gate1-audit-2026-10-02.md
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const url = argOf("--url") ?? process.env.DATABASE_URL ?? null;
const today = new Date().toISOString().slice(0, 10);
const out = argOf("--out") ?? `gate1-audit-${today}.md`;

if (!url) {
  console.error(
    "ERROR: no connection string. Pass --url, or set DATABASE_URL.\n" +
      "Point it at a RESTORED COPY of a nightly backup, not production —\n" +
      "see the header comment and docs/compliance/GATE-1-CONTENT-AUDIT.md.",
  );
  process.exit(2);
}

// Refuse to write anywhere git is watching. A worksheet full of titles must not
// become a commit, and "it was only local" is not recoverable once pushed.
let tracked = false;
try {
  execFileSync("git", ["ls-files", "--error-unmatch", out], {
    stdio: "ignore",
  });
  tracked = true;
} catch {
  tracked = false;
}
if (tracked) {
  console.error(
    `ERROR: ${out} is tracked by git. The worksheet holds document titles and\n` +
      "paths and must stay untracked. Choose a path matched by .gitignore\n" +
      "(the default `gate1-audit-<date>.md` is).",
  );
  process.exit(2);
}

const q = (sql) =>
  execFileSync("psql", [url, "-At", "-F", "", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split(""));

// One row per document. `flag_form` marks the documents whose body names an IRS
// form — not a defect, but the population that trips the TRI pre-flight (finding
// C-1), so a reviewer should know which ones they are.
const rows = q(`
  select
    d.title,
    coalesce(d.metadata->>'path', '(no path)'),
    coalesce(d.mime_type, '?'),
    coalesce(d.size_bytes, 0)::text,
    (select count(*) from chunks c where c.document_id = d.id)::text,
    case when d.markdown ~ 'Form [0-9]{3,4}' then 'IRS-form' else '' end,
    d.lifecycle_status,
    s.data_class::text
  from documents d
  join sources s on s.id = d.source_id
  order by coalesce(d.metadata->>'path', ''), d.title
`);

const esc = (s) => s.replace(/\|/g, "\\|");
const lines = [];
lines.push(`# P0 gate #1 — content audit worksheet`);
lines.push("");
lines.push(`**Generated:** ${today} · **Documents:** ${rows.length}`);
lines.push("");
lines.push(
  "⚠ **Do not commit this file.** It holds document titles and SharePoint paths.",
);
lines.push("");
lines.push(
  "Decision column: `OK` = may stay in the staff-wide knowledge base · " +
    "`WITHDRAW` = remove from the index · `ASK` = needs a second opinion.",
);
lines.push("");
lines.push(
  "| # | Title | Path | Type | Chunks | Note | Decision | Reviewer | Date | Why |",
);
lines.push(
  "| - | ----- | ---- | ---- | ------ | ---- | -------- | -------- | ---- | --- |",
);
rows.forEach((r, i) => {
  const [title, path, mime, , chunks, flag] = r;
  const short = mime.replace(/^application\/(vnd\.[^;]*\.)?/, "").slice(0, 18);
  lines.push(
    `| ${i + 1} | ${esc(title)} | ${esc(path)} | ${esc(short)} | ${chunks} | ${flag} |  |  |  |  |`,
  );
});
lines.push("");
lines.push("## Sign-off");
lines.push("");
lines.push(
  "Gate #1 is closed when every row above carries a Decision and a Reviewer, " +
    "and every `WITHDRAW` has been applied to the index AND confirmed absent " +
    "from a fresh query. Recording a verdict here does not enforce it — see " +
    "`docs/compliance/GATE-1-CONTENT-AUDIT.md` §3.",
);
lines.push("");
lines.push("| Reviewer | Role | Rows reviewed | Date | Signature |");
lines.push("| -------- | ---- | ------------- | ---- | --------- |");
lines.push("|  |  |  |  |  |");
lines.push("");

if (existsSync(out)) {
  console.error(`ERROR: ${out} already exists. Move or delete it first.`);
  process.exit(2);
}
writeFileSync(out, lines.join("\n"), "utf8");

// Aggregates only. Never a title, never a path.
const withForm = rows.filter((r) => r[5] === "IRS-form").length;
const classes = [...new Set(rows.map((r) => r[7]))].sort();
const statuses = [...new Set(rows.map((r) => r[6]))].sort();
console.log(`wrote ${out}`);
console.log(`  documents        ${rows.length}`);
console.log(`  chunks           ${rows.reduce((a, r) => a + Number(r[4]), 0)}`);
console.log(
  `  names an IRS form ${withForm}  (trips the TRI pre-flight; see finding C-1)`,
);
console.log(`  source data_class ${classes.join(", ")}`);
console.log(`  lifecycle_status  ${statuses.join(", ")}`);
console.log("");
console.log(
  "Titles and paths are in the file only — not printed here on purpose.",
);
