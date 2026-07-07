import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { GitMarkdownConnector } from "./index.js";

const LOGGER = pino({ level: "silent" });

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath }).toString().trim();
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
});
