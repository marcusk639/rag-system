import { execFile } from "node:child_process";
import { promisify } from "node:util";
import matter from "gray-matter";
import type { Logger } from "pino";
import {
  type Connector,
  type ConnectorListOptions,
  type ConnectorListResult,
  type SourceDocument,
  ValidationError,
} from "@rag/core";
import {
  GitMarkdownConfig,
  type GitMarkdownConfig as Config,
} from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Git environment variables that select which repository a command operates on.
 *
 * These **override `cwd`**, so inheriting them silently redirects every command
 * below at a different repository — returning the wrong documents rather than
 * failing. Git hooks always export them (which is how a pre-push run surfaced
 * this), but the production shape is the same: a worker started with `GIT_DIR`
 * in its environment would ingest the wrong repo.
 *
 * Scrubbed as an explicit deny-list rather than dropping every `GIT_*` var,
 * because unrelated ones — `GIT_SSH_COMMAND`, `GIT_TERMINAL_PROMPT`,
 * `GIT_SSL_CAINFO` — are legitimate deployment configuration, and an
 * allow-list that omitted one would fail at runtime in production rather than
 * in tests.
 *
 * `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS` are here while
 * `GIT_CONFIG_GLOBAL` is not, which looks inconsistent but is not.
 * `GIT_CONFIG_GLOBAL` only redirects which FILE is read as global config. The
 * other two inject arbitrary config pairs directly from the environment —
 * including `core.worktree`, which redirects the working tree, and
 * `core.hooksPath`/`core.fsmonitor`, which name executables.
 *
 * They are two INDEPENDENT mechanisms, and covering only one leaves the hole
 * open:
 *   - `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 *     (git ≥ 2.31). Git reads only as many pairs as the count declares, so
 *     removing it is sufficient; the indexed keys are removed anyway rather
 *     than depending on that.
 *   - `GIT_CONFIG_PARAMETERS`, which git uses internally to propagate `-c` to
 *     subprocesses. Nothing stops it being set directly, and its name matches
 *     neither prefix above. Verified injectable on git 2.55.
 *
 * Neither is exploitable through this connector's current argv (`rev-parse`,
 * `ls-tree`, `diff --name-status`, `show` — all read-only plumbing that never
 * touches the index, working tree, or hooks). They are scrubbed so that stays
 * true if someone later adds a command where it would not be.
 *
 * Exported so the test fixture helper uses this list instead of a hand-copied
 * duplicate — a security-relevant list maintained in two places drifts.
 */
// `Object.freeze` rather than `as const` alone: the latter is compile-time
// only, leaving a mutable singleton array that any importer could empty and
// silently neuter the scrub for the whole process.
export const REPO_LOCATION_ENV = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
] as const);

/** `process.env` minus the vars that would override `cwd` or inject config. */
export function hermeticGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of REPO_LOCATION_ENV) delete env[key];
  // GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> are indexed, so they cannot be
  // named in a fixed list. Removing GIT_CONFIG_COUNT above already neuters
  // them; these go too so nothing is left for a future git to reinterpret.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    )
      delete env[key];
  }
  return env;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: hermeticGitEnv(),
  });
  return stdout.trim();
}

async function gitBuffer(repoPath: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: hermeticGitEnv(),
    encoding: "buffer",
  } as Parameters<typeof execFileAsync>[2]);
  return stdout as unknown as Buffer;
}

// gray-matter's YAML engine (js-yaml) auto-converts bare date-like scalars
// (e.g. `2026-01-01`) into JS Date objects. Frontmatter is passed through
// verbatim as document metadata, so dates are normalized back to the plain
// date string they were written as.
function normalizeFrontmatterValue(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeFrontmatterValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        normalizeFrontmatterValue(val),
      ]),
    );
  }
  return value;
}

export class GitMarkdownConnector implements Connector {
  readonly kind = "git-markdown";
  private readonly config: Config;

  constructor(
    rawConfig: Record<string, unknown>,
    private readonly logger: Logger,
  ) {
    this.config = GitMarkdownConfig.parse(rawConfig);
  }

  async validate(): Promise<void> {
    try {
      await git(this.config.repoPath, ["rev-parse", "HEAD"]);
    } catch (err) {
      throw new ValidationError(
        `git-markdown connector: ${this.config.repoPath} is not a git repository with at least one commit: ${String(err)}`,
      );
    }
  }

  private matchesExtension(filePath: string): boolean {
    return this.config.extensions.some((ext) => filePath.endsWith(ext));
  }

  private async buildDocument(
    filePath: string,
    headSha: string,
  ): Promise<SourceDocument> {
    const rawBytes = await gitBuffer(this.config.repoPath, [
      "show",
      `${headSha}:${filePath}`,
    ]);
    const parsed = matter(rawBytes.toString("utf-8"));
    return {
      externalId: filePath,
      title: filePath,
      modifiedAt: new Date().toISOString(),
      mimeType: "text/markdown",
      content: rawBytes,
      metadata: {
        title: filePath,
        mimeType: "text/markdown",
        extra: normalizeFrontmatterValue(parsed.data) as Record<
          string,
          unknown
        >,
      },
    };
  }

  async list(options?: ConnectorListOptions): Promise<ConnectorListResult> {
    const headSha = await git(this.config.repoPath, ["rev-parse", "HEAD"]);
    this.logger.debug({ headSha }, "git-markdown: resolved HEAD");

    if (!options?.cursor) {
      const allFiles = (
        await git(this.config.repoPath, [
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
        ])
      )
        .split("\n")
        .filter((f) => f.length > 0 && this.matchesExtension(f));

      const documents = await Promise.all(
        allFiles.map((f) => this.buildDocument(f, headSha)),
      );
      return { documents, nextCursor: headSha, done: true };
    }

    if (options.cursor === headSha) {
      return { documents: [], nextCursor: headSha, done: true };
    }

    const diffOutput = await git(this.config.repoPath, [
      "diff",
      "--name-status",
      "--no-renames",
      options.cursor,
      "HEAD",
    ]);

    const documents: SourceDocument[] = [];
    const deletions: string[] = [];
    for (const line of diffOutput.split("\n").filter(Boolean)) {
      const [status, filePath] = line.split("\t");
      if (!filePath || !this.matchesExtension(filePath)) continue;
      if (status === "D") {
        deletions.push(filePath);
      } else {
        documents.push(await this.buildDocument(filePath, headSha));
      }
    }

    return {
      documents,
      nextCursor: headSha,
      done: true,
      ...(deletions.length > 0 ? { deletions } : {}),
    };
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    const headSha = await git(this.config.repoPath, ["rev-parse", "HEAD"]);
    return this.buildDocument(externalId, headSha);
  }
}
