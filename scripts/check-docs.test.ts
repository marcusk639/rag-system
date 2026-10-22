import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * check-docs.mjs, exercised against throwaway git repos rather than this one,
 * so each rule is proven to fire (and to stay quiet) on a known tree.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-docs.mjs");

const FRONT = (title: string) =>
  [
    "---",
    `title: ${title}`,
    "status: current",
    "last_verified: 2026-10-21",
    "answers: What this fixture is for.",
    "---",
    "",
  ].join("\n");

const roots: string[] = [];

// Hooks (husky pre-push) export GIT_DIR, GIT_INDEX_FILE and friends for the real
// repository; inherited, they redirect every fixture git call into it.
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
}

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-docs-"));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: root, env: gitEnv() });
  execFileSync("git", ["add", "-A"], { cwd: root, env: gitEnv() });
  return root;
}

function run(root: string) {
  const r = spawnSync("node", [SCRIPT, "--root", root], {
    encoding: "utf-8",
    env: gitEnv(),
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const BASE: Record<string, string> = {
  "docs/README.md": `${FRONT("Index")}# Index\n\n- [Guide](ops/GUIDE.md)\n- [Archive](archive/README.md)\n- [DPA](compliance/vendor-dpa-x.md)\n`,
  "docs/ops/GUIDE.md": `${FRONT("Guide")}See [index](../README.md#index).\n`,
  "docs/archive/README.md":
    "# Archive\n\nOld [link](GONE.md) and no client files claim.\n",
  "docs/compliance/vendor-dpa-x.md":
    "# DPA record\n\n[old](../OLD.md) no front matter here.\n",
  "src/a.ts":
    "// see docs/ops/GUIDE.md and ~/dev/other-repo/docs/rag/scope.md\n",
};

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("check-docs", () => {
  it("passes a clean tree, ignoring archive, evidence and cross-repo paths", () => {
    const r = run(repo(BASE));
    expect(r.out).toContain("check-docs: ok");
    expect(r.code).toBe(0);
  });

  it("fails when a live doc is missing from the index", () => {
    const r = run(
      repo({ ...BASE, "docs/ops/ORPHAN.md": `${FRONT("Orphan")}text\n` }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /not linked from docs\/README\.md: docs\/ops\/ORPHAN\.md/,
    );
  });

  it("fails on a broken relative link in a live doc", () => {
    const r = run(
      repo({
        ...BASE,
        "docs/ops/GUIDE.md": `${FRONT("Guide")}[x](../MISSING.md)\n`,
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/broken link .*MISSING\.md/);
  });

  it("fails when a live doc has no front matter", () => {
    const r = run(repo({ ...BASE, "docs/ops/GUIDE.md": "# Guide\n" }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/front matter.*docs\/ops\/GUIDE\.md/);
  });

  it("fails when a live doc has an unknown status", () => {
    const r = run(
      repo({
        ...BASE,
        "docs/ops/GUIDE.md": FRONT("Guide").replace(
          "status: current",
          "status: draft",
        ),
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/status/);
  });

  it("fails when code cites a docs path that does not exist", () => {
    const r = run(repo({ ...BASE, "src/b.ts": "// see docs/OLD-PLAN.md#x\n" }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/src\/b\.ts.*docs\/OLD-PLAN\.md/);
  });

  it("fails on a link to a heading anchor that does not exist", () => {
    const r = run(
      repo({
        ...BASE,
        "docs/ops/GUIDE.md": `${FRONT("Guide")}## Real — section\n\n[ok](#real--section) [bad](../README.md#nope)\n`,
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/broken anchor .*README\.md#nope/);
    expect(r.out).not.toMatch(/real--section/);
  });

  it("accepts explicit id anchors and GitHub's duplicate-heading suffixes", () => {
    const r = run(
      repo({
        ...BASE,
        "docs/ops/GUIDE.md": `${FRONT("Guide")}<a id="custom"></a>\n\n## Step\n\n## Step\n\n[a](#custom) [b](#step-1)\n`,
      }),
    );
    expect(r.out).toContain("check-docs: ok");
  });

  it("accepts a docs/ path that resolves relative to the citing file", () => {
    const r = run(
      repo({
        ...BASE,
        "examples/demo/README.md": "Load docs/sop.md first.\n",
        "examples/demo/docs/sop.md": "# SOP\n",
      }),
    );
    expect(r.out).toContain("check-docs: ok");
  });

  it("fails on a known-false phrase in a live doc", () => {
    const r = run(
      repo({
        ...BASE,
        "docs/ops/GUIDE.md": `${FRONT("Guide")}The bot has no client files.\n`,
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no client files/);
  });

  it("allows a retired model name only in a line that says it is retired", () => {
    const ok = run(
      repo({
        ...BASE,
        "docs/ops/GUIDE.md": `${FRONT("Guide")}text-embedding-004 is retired; never configure it.\n`,
      }),
    );
    expect(ok.code).toBe(0);
    const bad = run(
      repo({
        ...BASE,
        "docs/ops/GUIDE.md": `${FRONT("Guide")}Default: text-embedding-004.\n`,
      }),
    );
    expect(bad.code).toBe(1);
  });
});

// husky runs the pre-push test suite with GIT_DIR (and friends) pointing at the
// real repository. A fixture `git init` that inherits it re-initialises that
// repository as bare instead of creating the throwaway one.
describe("check-docs fixtures under an inherited git environment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("never touches the repository named by GIT_DIR", () => {
    const decoy = mkdtempSync(join(tmpdir(), "check-docs-decoy-"));
    roots.push(decoy);
    const clean = gitEnv();
    execFileSync("git", ["init", "-q"], { cwd: decoy, env: clean });
    process.env.GIT_DIR = join(decoy, ".git");
    process.env.GIT_INDEX_FILE = join(decoy, ".git", "index");

    const r = run(repo(BASE));

    const bare = spawnSync("git", ["config", "--get", "core.bare"], {
      cwd: decoy,
      env: clean,
      encoding: "utf-8",
    }).stdout.trim();
    const staged = execFileSync("git", ["ls-files"], {
      cwd: decoy,
      env: clean,
      encoding: "utf-8",
    });
    expect(bare).toBe("false");
    expect(staged).toBe("");
    expect(r.out).toContain("check-docs: ok");
    expect(r.code).toBe(0);
  });
});
