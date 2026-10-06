import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Failure-branch coverage for the Docker build gate in
 * `warm-model-verified.sh`.
 *
 * Why this exists as a unit test rather than a Docker build: CI builds only
 * `services/parser-py`'s image (see .github/workflows/{ci,e2e,web-e2e}.yml) —
 * none of apps/{worker,api,mcp}/Dockerfile is built anywhere in CI, so until
 * now this gate's first real exercise was a Railway deploy build. Its happy
 * path runs on every image build; its FAILURE branches, by construction, never
 * do. That is exactly where a silent-pass bug hid (see the non-numeric `du`
 * case below), so those branches are the ones worth automating.
 *
 * The gate is pure shell and filesystem logic, so each branch runs here in
 * milliseconds with a stubbed `tsx` — no Docker, no ~430MB model download.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "warm-model-verified.sh",
);

let work: string;

/** Writes an executable stub and returns its path. */
function stub(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
}

/**
 * Stands in for `node_modules/.bin/tsx scripts/warm-model.ts`. The real script
 * is invoked by that relative path, so the stub goes at the same relative path
 * inside a temp cwd.
 */
function stubTsx(body: string) {
  stub(join(work, "node_modules/.bin/tsx"), body);
}

/** Runs the gate with `work` as cwd. Returns status + combined output. */
function runGate(env: Record<string, string | undefined> = {}): {
  status: number;
  output: string;
} {
  try {
    const output = execFileSync("sh", [SCRIPT], {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_CACHE_DIR: join(work, "cache"), ...env },
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

/** A cache directory holding `kb` kilobytes, so the size floor can be met. */
function seedCache(kb: number) {
  const dir = join(work, "cache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "model.onnx"), Buffer.alloc(kb * 1024, 1));
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "warm-gate-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("warm-model-verified.sh — the gate must refuse", () => {
  it("fails when HF_CACHE_DIR is unset", () => {
    // Unset is the silent-no-op case: the warm would populate a default path
    // that the Dockerfile's `COPY --from=warmer` never reads, shipping an
    // empty cache that passes every other check.
    stubTsx('#!/bin/sh\necho "Model ready. Cache: x"\n');
    const { status, output } = runGate({ HF_CACHE_DIR: "" });
    expect(status).toBe(1);
    expect(output).toContain("HF_CACHE_DIR is not set");
  });

  it("fails when the warm reports success but the cache is undersized", () => {
    stubTsx('#!/bin/sh\necho "Model ready. Cache: x"\n');
    mkdirSync(join(work, "cache"), { recursive: true });
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("expected >=50MB");
  });

  it("fails on exit 134 when the success line is absent", () => {
    // The gate tolerates 134 because onnxruntime-node aborts at teardown
    // AFTER a successful embed. That tolerance is only safe because the
    // success line is required first — this is the test that proves it.
    stubTsx('#!/bin/sh\necho "libc++abi: mutex lock failed"\nexit 134\n');
    seedCache(60 * 1024);
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("did not report success");
  });

  it("fails on a non-zero exit that is not the known abort", () => {
    stubTsx('#!/bin/sh\necho "Model ready. Cache: x"\nexit 7\n');
    seedCache(60 * 1024);
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("neither 0 nor the known");
  });

  // REGRESSION (fixed in cb451e9). `cache_kb=${cache_kb:-0}` guarded only an
  // EMPTY du result. On a non-numeric value, `[ "$cache_kb" -lt N ]` fails with
  // "integer expression expected", and because the script runs under `set +e`
  // the failed test is read by `if` as simply false — skipping the FATAL branch
  // and falling through to the success line with exit 0. A green build would
  // then have certified a cache nobody measured.
  it("fails when du reports a non-numeric size", () => {
    stubTsx('#!/bin/sh\necho "Model ready. Cache: x"\n');
    seedCache(60 * 1024);
    // Shadow `du` on PATH so it emits garbage the way a BusyBox/locale
    // variant or a warning-on-stdout could.
    stub(join(work, "bin/du"), '#!/bin/sh\necho "not-a-number"\n');
    const { status, output } = runGate({
      PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
    });
    expect(status).toBe(1);
    expect(output).toContain("could not determine the size");
  });

  it("fails when du reports nothing at all", () => {
    stubTsx('#!/bin/sh\necho "Model ready. Cache: x"\n');
    seedCache(60 * 1024);
    stub(join(work, "bin/du"), "#!/bin/sh\nexit 1\n");
    const { status, output } = runGate({
      PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
    });
    expect(status).toBe(1);
    expect(output).toContain("could not determine the size");
  });
});

describe("warm-model-verified.sh — the gate must accept", () => {
  it("passes when the warm succeeds and the cache is populated", () => {
    stubTsx('#!/bin/sh\necho "Model ready. Cache: x"\n');
    seedCache(60 * 1024);
    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("warmed and verified");
  });

  it("tolerates exit 134 when the success line IS present", () => {
    // The whole reason the tolerance exists: a correctly warmed cache must
    // not fail the build just because onnxruntime aborts on the way out.
    stubTsx(
      '#!/bin/sh\necho "Model ready. Cache: x"\necho "libc++abi: mutex lock failed" >&2\nexit 134\n',
    );
    seedCache(60 * 1024);
    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("warmed and verified");
  });
});
