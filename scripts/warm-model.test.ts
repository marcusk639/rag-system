import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The EMBEDDING_PROVIDER guard in warm-model.ts, exercised by running the real
 * script rather than a stub.
 *
 * Why a subprocess instead of importing the module: warm-model.ts is a
 * top-level-await script whose module scope constructs an embedder and calls
 * `embed()`, so importing it in-process would start a ~430MB download.
 *
 * Why that is affordable anyway: the guard runs BEFORE the provider is
 * constructed, so the refuse path exits in milliseconds and downloads nothing.
 * The pass-through path is checked only as far as the line the script prints
 * before loading weights, then the child is killed — enough to prove the guard
 * let it through, without fetching the model.
 *
 * Requires a built workspace (`pnpm -r build`), because warm-model.ts imports
 * @rag/core and @rag/rag via their `dist/` entry points. CI builds before
 * testing; locally use `pnpm test:fresh` on a cold checkout.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT = "scripts/warm-model.ts";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the script with `env` overrides. `killOn` lets the pass-through case
 * stop as soon as the script reaches weight loading, so no download occurs.
 */
function runScript(env: Record<string, string>, killOn?: RegExp): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      if (killOn && killOn.test(stdout) && !killed) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("warm-model.ts — EMBEDDING_PROVIDER guard", () => {
  it.each([["gemini"], ["openai"]])(
    "refuses %s, which has no local cache to warm",
    async (provider) => {
      // Without this the script would warm Xenova/bge-base-en-v1.5 for a
      // deployment that embeds via a remote API and will never read it.
      const { code, stderr } = await runScript({
        EMBEDDING_PROVIDER: provider,
      });
      expect(code).toBe(1);
      expect(stderr).toContain(`EMBEDDING_PROVIDER=${provider}`);
      expect(stderr).toContain("no local weight cache to warm");
    },
    60_000,
  );

  it.each([
    ["unset", {}],
    ["empty", { EMBEDDING_PROVIDER: "" }],
    ["whitespace", { EMBEDDING_PROVIDER: "   " }],
    ["local", { EMBEDDING_PROVIDER: "local" }],
  ])(
    "proceeds when EMBEDDING_PROVIDER is %s",
    async (_label, env) => {
      // Empty and whitespace must behave as unset: Compose and Railway inject
      // an always-present empty variable rather than omitting it, which is the
      // behavior behind the defects in #102 and #104.
      //
      // Killed at the "Warming local embedding model" line — printed after the
      // guard, before any weights load — so this proves the guard let it
      // through without downloading the model.
      const { stdout, stderr } = await runScript(
        { HF_CACHE_DIR: "", ...env } as Record<string, string>,
        /Warming local embedding model/,
      );
      expect(stdout).toContain("Warming local embedding model");
      expect(stderr).not.toContain("no local weight cache to warm");
    },
    60_000,
  );
});
