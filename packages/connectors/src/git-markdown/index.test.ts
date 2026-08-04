import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { GitMarkdownConnector, hermeticGitEnv } from "./index.js";

const LOGGER = pino({ level: "silent" });

/**
 * Builds the fixture repos. Reuses the connector's own `hermeticGitEnv()`
 * rather than re-listing the variables: git hooks export
 * `GIT_DIR`/`GIT_WORK_TREE`, and under a hook these calls would otherwise
 * commit the fixture files into the OUTER repository instead of the temp one —
 * which is what made the whole suite fail during `git push` while passing when
 * run directly.
 *
 * Sharing the helper also means the scrub list cannot drift between the code
 * and the fixture that is supposed to exercise it.
 */
function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, env: hermeticGitEnv() })
    .toString()
    .trim();
}

describe("GitMarkdownConnector", () => {
  let repoPath: string;

  beforeAll(() => {
    repoPath = mkdtempSync(path.join(tmpdir(), "git-markdown-test-"));
    git(repoPath, "init", "-q");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
  });

  afterAll(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("validate() throws when repoPath is not a git repo", async () => {
    const connector = new GitMarkdownConnector(
      { repoPath: "/nonexistent/path", extensions: [".md"] },
      LOGGER,
    );
    await expect(connector.validate()).rejects.toThrow();
  });

  it("full sync (no cursor) returns every markdown file with parsed frontmatter", async () => {
    writeFileSync(
      path.join(repoPath, "a.md"),
      "---\ntopic: alpha\nlast_verified: 2026-01-01\nvolatility: stable\n---\n\n# Alpha\n",
    );
    git(repoPath, "add", "a.md");
    git(repoPath, "commit", "-q", "-m", "commit 1");
    const sha1 = git(repoPath, "rev-parse", "HEAD");

    const connector = new GitMarkdownConnector(
      { repoPath, extensions: [".md"] },
      LOGGER,
    );
    await connector.validate();
    const result = await connector.list();

    expect(result.done).toBe(true);
    expect(result.nextCursor).toBe(sha1);
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0];
    if (!doc) throw new Error("expected one document");
    expect(doc.externalId).toBe("a.md");
    expect(doc.mimeType).toBe("text/markdown");
    expect(doc.content.toString()).toContain("# Alpha");
    expect(doc.metadata.extra).toMatchObject({
      topic: "alpha",
      last_verified: "2026-01-01",
      volatility: "stable",
    });
  });

  it("delta sync (with cursor) returns only added/modified files and reports deletions", async () => {
    const sha1 = git(repoPath, "rev-parse", "HEAD");

    writeFileSync(
      path.join(repoPath, "b.md"),
      "---\ntopic: beta\n---\n\n# Beta\n",
    );
    git(repoPath, "add", "b.md");
    git(repoPath, "rm", "-q", "a.md");
    git(repoPath, "commit", "-q", "-m", "commit 2");
    const sha2 = git(repoPath, "rev-parse", "HEAD");

    const connector = new GitMarkdownConnector(
      { repoPath, extensions: [".md"] },
      LOGGER,
    );
    const result = await connector.list({ cursor: sha1 });

    expect(result.nextCursor).toBe(sha2);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.externalId).toBe("b.md");
    expect(result.deletions).toEqual(["a.md"]);
  });

  it("fetch() returns a single document by external id at HEAD", async () => {
    const connector = new GitMarkdownConnector(
      { repoPath, extensions: [".md"] },
      LOGGER,
    );
    const doc = await connector.fetch("b.md");
    expect(doc.title).toBe("b.md");
    expect(doc.content.toString()).toContain("# Beta");
  });

  it("preserves non-UTF-8 bytes in the document body unchanged", async () => {
    const frontmatterAndHeading = Buffer.from(
      "---\ntopic: gamma\n---\n\n# Gamma\n\nbody: ",
      "utf-8",
    );
    // 0xff 0xfe is not valid UTF-8 (an isolated invalid byte sequence) and
    // would be replaced with U+FFFD if the connector round-tripped content
    // through a UTF-8 string instead of preserving raw bytes.
    const invalidUtf8Bytes = Buffer.from([0xff, 0xfe]);
    const trailer = Buffer.from("\nend\n", "utf-8");
    const expectedBytes = Buffer.concat([
      frontmatterAndHeading,
      invalidUtf8Bytes,
      trailer,
    ]);

    writeFileSync(path.join(repoPath, "c.md"), expectedBytes);
    git(repoPath, "add", "c.md");
    git(repoPath, "commit", "-q", "-m", "commit 3");

    const connector = new GitMarkdownConnector(
      { repoPath, extensions: [".md"] },
      LOGGER,
    );
    const doc = await connector.fetch("c.md");

    expect(doc.metadata.extra).toMatchObject({ topic: "gamma" });
    expect(Buffer.isBuffer(doc.content)).toBe(true);
    expect(Buffer.compare(doc.content, expectedBytes)).toBe(0);
  });

  it("delta sync handles a renamed file as a deletion + new document, without throwing", async () => {
    const shaBeforeRename = git(repoPath, "rev-parse", "HEAD");

    git(repoPath, "mv", "b.md", "b-renamed.md");
    git(repoPath, "commit", "-q", "-m", "rename b.md to b-renamed.md");
    const shaAfterRename = git(repoPath, "rev-parse", "HEAD");

    const connector = new GitMarkdownConnector(
      { repoPath, extensions: [".md"] },
      LOGGER,
    );

    const result = await connector.list({ cursor: shaBeforeRename });

    expect(result.nextCursor).toBe(shaAfterRename);
    expect(result.deletions).toEqual(["b.md"]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.externalId).toBe("b-renamed.md");
    expect(result.documents[0]?.content.toString()).toContain("# Beta");
  });
});

describe("GitMarkdownConnector — ambient GIT_* environment", () => {
  // Regression: `execFileAsync("git", args, { cwd })` inherits process.env, and
  // git's repo-location variables OVERRIDE cwd. So an ambient GIT_DIR made the
  // connector read whatever repo that pointed at instead of `repoPath` —
  // silently, returning the wrong documents rather than erroring.
  //
  // Git hooks always export these, which is how the pre-push hook surfaced it.
  // The production risk is the same shape: a worker running with GIT_DIR set in
  // its environment would ingest the wrong repository.
  let repoPath: string;
  let decoyPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    repoPath = mkdtempSync(path.join(tmpdir(), "git-markdown-real-"));
    git(repoPath, "init", "-q");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(path.join(repoPath, "real.md"), "# Real\n");
    git(repoPath, "add", ".");
    git(repoPath, "commit", "-q", "-m", "real");

    // A second, VALID repo with different content. Pointing GIT_DIR at a
    // nonexistent path would only prove the connector errors; pointing it at a
    // real repo proves it read the right one.
    decoyPath = mkdtempSync(path.join(tmpdir(), "git-markdown-decoy-"));
    git(decoyPath, "init", "-q");
    git(decoyPath, "config", "user.email", "test@example.com");
    git(decoyPath, "config", "user.name", "Test");
    writeFileSync(path.join(decoyPath, "decoy.md"), "# Decoy\n");
    git(decoyPath, "add", ".");
    git(decoyPath, "commit", "-q", "-m", "decoy");

    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      saved[key] = process.env[key];
    }
    process.env.GIT_DIR = path.join(decoyPath, ".git");
    process.env.GIT_WORK_TREE = decoyPath;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(decoyPath, { recursive: true, force: true });
  });

  it("reads repoPath, not the repo an ambient GIT_DIR points at", async () => {
    const connector = new GitMarkdownConnector(
      { repoPath, extensions: [".md"] },
      LOGGER,
    );

    const result = await connector.list();

    expect(result.documents.map((d) => d.externalId)).toEqual(["real.md"]);
  });

  it("fetch() also ignores the ambient GIT_DIR", async () => {
    // Separate call path (gitBuffer), so it needs its own scrubbing.
    const connector = new GitMarkdownConnector(
      { repoPath, extensions: [".md"] },
      LOGGER,
    );

    const doc = await connector.fetch("real.md");

    expect(doc.content.toString()).toContain("# Real");
  });
});

describe("hermeticGitEnv", () => {
  it("removes the env-injected config mechanism, not just repo location", () => {
    // GIT_CONFIG_COUNT + GIT_CONFIG_KEY_<n>/VALUE_<n> (git >= 2.31) inject
    // arbitrary config from the environment — core.worktree redirects the
    // working tree, core.hooksPath/core.fsmonitor name executables. Distinct
    // mechanism from GIT_CONFIG_GLOBAL, which only picks a file.
    const saved = { ...process.env };
    try {
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "core.worktree";
      process.env.GIT_CONFIG_VALUE_0 = "/tmp/elsewhere";

      const env = hermeticGitEnv();

      expect(env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it("removes GIT_CONFIG_PARAMETERS, the second injection mechanism", () => {
    // Independent of the COUNT/KEY/VALUE family and matching neither prefix.
    // git uses it to propagate `-c` to subprocesses; nothing stops it being set
    // directly. Verified injectable on git 2.55:
    //   env GIT_CONFIG_PARAMETERS="'core.bare=true'" git config --get core.bare
    const saved = { ...process.env };
    try {
      process.env.GIT_CONFIG_PARAMETERS = "'core.worktree=/tmp/elsewhere'";

      expect(hermeticGitEnv().GIT_CONFIG_PARAMETERS).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it("preserves unrelated deployment configuration", () => {
    // An allow-list would drop these and fail in production rather than in
    // tests. The deny-list keeps them on purpose.
    const saved = { ...process.env };
    try {
      process.env.GIT_SSH_COMMAND = "ssh -i /key";
      process.env.GIT_TERMINAL_PROMPT = "0";

      const env = hermeticGitEnv();

      expect(env.GIT_SSH_COMMAND).toBe("ssh -i /key");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      process.env = saved;
    }
  });
});
