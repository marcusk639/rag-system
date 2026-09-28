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
 * Git env vars inherited from an ambient git process (a hook, a rebase) point
 * git at THAT repository, silently overriding `cwd`. Strip them so every call
 * below acts on `repoPath` and nothing else.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
  ]) {
    delete env[key];
  }
  return env;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: gitEnv(),
  });
  return stdout.trim();
}

async function gitBuffer(repoPath: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: gitEnv(),
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
