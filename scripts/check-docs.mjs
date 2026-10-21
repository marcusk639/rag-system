#!/usr/bin/env node
// Mechanical guard for docs/. A previous cleanup's fixes were silently undone
// by a later commit while its "all fixed" banner kept claiming success; these
// checks make that class of regression fail CI instead.
//
// Live docs = docs/**/*.md outside docs/archive/ and the evidence records.
//   1. every non-archive doc is linked from docs/README.md
//   2. relative links in live docs resolve
//   3. live docs carry front matter with a known status
//   4. every docs/... path cited from outside docs/ exists
//   5. live docs contain no known-false phrase
//
// Usage: node scripts/check-docs.mjs [--root <repo>]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const STATUSES = new Set(["current", "living-tracker", "evidence", "archived"]);

// Dated legal/compliance records: never rewritten, so their historical links
// and wording are exempt from the live-doc rules (they must still be indexed).
const EVIDENCE = [
  /^docs\/compliance\/records\//,
  /^docs\/compliance\/GATE-1-CONTENT-AUDIT\.md$/,
  /^docs\/compliance\/scope-conformance-[^/]+\.md$/,
  /^docs\/compliance\/vendor-dpa-[^/]+\.md$/,
];

const BANNED = [
  { re: /no client files/i, why: "falsified by the 2026-08-01 corpus screen" },
  {
    re: /RAG-VALIDATION-REPORT\.md/,
    why: "cites a document that never existed",
  },
  {
    re: /\/Users\/marcus\//,
    why: "stale absolute path (wrong home directory)",
  },
  { re: /PropelAuth/, why: "removed; the web app uses Entra ID" },
  {
    re: /text-embedding-004/,
    why: "retired model; mention it only to say so",
    unless: /retired/i,
  },
];

// Paths that legitimately mention old doc locations: the consolidation prompt
// and its digests describe the pre-move tree.
const CITATION_EXCLUDES = [":!docs", ":!.claude/prompts", ":!pnpm-lock.yaml"];

function parseArgs(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

const isArchive = (rel) => rel.startsWith("docs/archive/");
const isEvidence = (rel) => EVIDENCE.some((re) => re.test(rel));

function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

// Markdown links outside fenced code blocks: [text](target)
function links(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
      out.push(m[1]);
  }
  return out;
}

function check(root) {
  const errors = [];
  const docs = walk(join(root, "docs")).map((p) => relative(root, p));

  const live = docs.filter((d) => !isArchive(d) && !isEvidence(d));
  const indexed = docs.filter(
    (d) => !isArchive(d) || d === "docs/archive/README.md",
  );

  // 1. index completeness
  const indexPath = join(root, "docs/README.md");
  if (!existsSync(indexPath)) {
    errors.push("docs/README.md is missing");
  } else {
    const targets = new Set(
      links(readFileSync(indexPath, "utf-8"))
        .filter((t) => !/^[a-z]+:/i.test(t))
        .map((t) => normalize(join("docs", t.split("#")[0]))),
    );
    for (const d of indexed) {
      if (d !== "docs/README.md" && !targets.has(d)) {
        errors.push(`not linked from docs/README.md: ${d}`);
      }
    }
  }

  for (const d of live) {
    const text = readFileSync(join(root, d), "utf-8");

    // 2. relative links resolve
    for (const t of links(text)) {
      if (/^[a-z]+:/i.test(t) || t.startsWith("#")) continue;
      const path = t.split("#")[0];
      if (!path) continue;
      const target = normalize(
        join(dirname(join(root, d)), decodeURIComponent(path)),
      );
      if (!existsSync(target)) errors.push(`broken link in ${d}: ${t}`);
    }

    // 3. front matter
    const fm = frontMatter(text);
    if (!fm) {
      errors.push(`missing front matter: ${d}`);
    } else {
      for (const key of ["title", "status", "last_verified", "answers"]) {
        if (!fm[key]) errors.push(`front matter in ${d} lacks "${key}"`);
      }
      if (fm.status && !STATUSES.has(fm.status)) {
        errors.push(`front matter in ${d} has unknown status "${fm.status}"`);
      }
      if (fm.last_verified && !/^\d{4}-\d{2}-\d{2}$/.test(fm.last_verified)) {
        errors.push(`front matter in ${d}: last_verified must be YYYY-MM-DD`);
      }
    }

    // 5. known-false phrases
    text.split("\n").forEach((line, i) => {
      for (const b of BANNED) {
        if (b.re.test(line) && !(b.unless && b.unless.test(line))) {
          errors.push(`${d}:${i + 1}: "${line.match(b.re)[0]}" (${b.why})`);
        }
      }
    });
  }

  // 4. docs paths cited from code/config resolve. The lookbehind skips paths
  // inside other repos (e.g. ~/dev/other-repo/docs/...).
  let grep = "";
  try {
    grep = execFileSync(
      "git",
      [
        "grep",
        "--untracked",
        "-nIoP",
        "(?<![\\w./-])docs/[A-Za-z0-9_./-]+\\.md",
        "--",
        ".",
        ...CITATION_EXCLUDES,
      ],
      { cwd: root, encoding: "utf-8" },
    );
  } catch (err) {
    if (err.status !== 1) throw err; // 1 = no matches
  }
  for (const line of grep.split("\n").filter(Boolean)) {
    const [file, lineNo, path] = line.split(":");
    if (!existsSync(join(root, path)))
      errors.push(`${file}:${lineNo} cites missing ${path}`);
  }

  return errors;
}

const root = parseArgs(process.argv.slice(2));
const errors = check(root);
if (errors.length) {
  console.error(
    `check-docs: ${errors.length} problem(s)\n  ${errors.join("\n  ")}`,
  );
  process.exit(1);
}
console.log("check-docs: ok");
