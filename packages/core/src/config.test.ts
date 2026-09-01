import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  API_TOKENS: "tok1",
} as NodeJS.ProcessEnv;

describe("loadConfig — PARSER_SECRET production gate", () => {
  it("development (default) does not require PARSER_SECRET", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.environment).toBe("development");
    expect(cfg.parser.secret).toBeUndefined();
  });

  it("test env does not require PARSER_SECRET", () => {
    const cfg = loadConfig({ ...BASE_ENV, NODE_ENV: "test" });
    expect(cfg.environment).toBe("test");
  });

  it("production WITHOUT PARSER_SECRET fails loud", () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: "production" })).toThrow(
      /PARSER_SECRET is required in production/,
    );
  });

  it("production WITH PARSER_SECRET loads", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      PARSER_SECRET: "shared-secret",
    });
    expect(cfg.environment).toBe("production");
    expect(cfg.parser.secret).toBe("shared-secret");
  });
});

describe("loadConfig — COMPLIANCE_MODE gate", () => {
  it("defaults to 'none' and does not check DPA", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.complianceMode).toBe("none");
  });

  it("client-data WITHOUT DPA on file throws loud", () => {
    expect(() =>
      loadConfig(
        { ...BASE_ENV, COMPLIANCE_MODE: "client-data" },
        { checkDpa: () => false },
      ),
    ).toThrow(/COMPLIANCE_MODE=client-data requires a signed DPA/);
  });

  it("client-data WITH DPA on file loads successfully", () => {
    const cfg = loadConfig(
      { ...BASE_ENV, COMPLIANCE_MODE: "client-data" },
      { checkDpa: () => true },
    );
    expect(cfg.complianceMode).toBe("client-data");
  });

  it("none mode does not invoke checkDpa at all", () => {
    let called = false;
    loadConfig(
      { ...BASE_ENV, COMPLIANCE_MODE: "none" },
      {
        checkDpa: () => {
          called = true;
          return false;
        },
      },
    );
    expect(called).toBe(false);
  });
});

describe("loadConfig — provider-aware chunk-size cap (local embedding provider)", () => {
  it("non-local providers are unaffected by the 512-token cap", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      EMBEDDING_PROVIDER: "gemini",
      CHUNK_SIZE: "800",
    });
    expect(cfg.retrieval.chunkSize).toBe(800);
  });

  it("local provider with no explicit CHUNK_SIZE is capped to 512 (default 800 exceeds the limit) without warning", () => {
    const warn = () => {
      throw new Error("warn should not be called for the implicit default");
    };
    const cfg = loadConfig(
      { ...BASE_ENV, EMBEDDING_PROVIDER: "local" },
      { warn },
    );
    expect(cfg.retrieval.chunkSize).toBe(512);
  });

  it("local provider with CHUNK_SIZE <= 512 passes through unchanged and does not warn", () => {
    let warned = false;
    const cfg = loadConfig(
      { ...BASE_ENV, EMBEDDING_PROVIDER: "local", CHUNK_SIZE: "400" },
      { warn: () => (warned = true) },
    );
    expect(cfg.retrieval.chunkSize).toBe(400);
    expect(warned).toBe(false);
  });

  it("local provider with an explicit CHUNK_SIZE > 512 is capped to 512 and logs a warning", () => {
    const warnings: string[] = [];
    const cfg = loadConfig(
      { ...BASE_ENV, EMBEDDING_PROVIDER: "local", CHUNK_SIZE: "800" },
      { warn: (msg) => warnings.push(msg) },
    );
    expect(cfg.retrieval.chunkSize).toBe(512);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CHUNK_SIZE=800/);
    expect(warnings[0]).toMatch(/512/);
  });

  it("defaults the warn sink to stderr when none is injected (pino isn't constructed yet at loadConfig time)", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      loadConfig({
        ...BASE_ENV,
        EMBEDDING_PROVIDER: "local",
        CHUNK_SIZE: "800",
      });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0]![0]).toMatch(/CHUNK_SIZE=800/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("loadConfig — INTERNAL_SCOPE_JWT_SECRETS", () => {
  // Valid 64-character hex secrets for testing (256 bits of entropy)
  const VALID_SECRET_ONE = "a".repeat(64);
  const VALID_SECRET_TWO = "b".repeat(64);
  const VALID_SECRET_THREE = "c".repeat(64);
  const VALID_SECRET_WITH_COMMAS = "d".repeat(30) + "," + "e".repeat(33); // 64 total

  it("defaults to an empty array when unset", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.auth.internalScopeSecrets).toEqual([]);
  });

  it("parses a single secret", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: VALID_SECRET_ONE,
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([VALID_SECRET_ONE]);
  });

  it("parses multiple comma-separated secrets (rotation) and trims whitespace", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: `${VALID_SECRET_ONE}, ${VALID_SECRET_TWO} , ${VALID_SECRET_THREE}`,
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([
      VALID_SECRET_ONE,
      VALID_SECRET_TWO,
      VALID_SECRET_THREE,
    ]);
  });

  it("filters out empty entries from trailing/double commas", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: `${VALID_SECRET_ONE},,`,
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([VALID_SECRET_ONE]);
  });

  it("accepts a JSON array form for secrets that might contain a comma", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: JSON.stringify([
        VALID_SECRET_WITH_COMMAS,
        VALID_SECRET_TWO,
      ]),
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([
      VALID_SECRET_WITH_COMMAS,
      VALID_SECRET_TWO,
    ]);
  });

  it("still supports the legacy comma-separated form for backward compatibility", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: `${VALID_SECRET_ONE},${VALID_SECRET_TWO}`,
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([
      VALID_SECRET_ONE,
      VALID_SECRET_TWO,
    ]);
  });

  it("rejects an INTERNAL_SCOPE_JWT_SECRETS entry shorter than 64 characters", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, INTERNAL_SCOPE_JWT_SECRETS: "a".repeat(63) }),
    ).toThrow(/at least 64/);
  });

  it("accepts an INTERNAL_SCOPE_JWT_SECRETS entry exactly 64 characters", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "a".repeat(64),
    });
    expect(cfg.auth.internalScopeSecrets).toEqual(["a".repeat(64)]);
  });

  it("fails loud on malformed JSON-looking input", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        INTERNAL_SCOPE_JWT_SECRETS: "[not valid json",
      }),
    ).toThrow(/Expected a JSON array/);
  });
});

describe("loadConfig — DOCS_GAP_DIGEST_* (Phase 4 documentation-gap digest)", () => {
  it("defaults to weekly Monday 6am UTC with a 0.3 score threshold when unset", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.docsGapDigest).toEqual({
      cron: "0 6 * * 1",
      tz: "UTC",
      minScore: 0.3,
    });
  });

  it("overrides cron/tz/minScore from env", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      DOCS_GAP_DIGEST_CRON: "0 0 * * *",
      DOCS_GAP_DIGEST_TZ: "America/Chicago",
      DOCS_GAP_DIGEST_MIN_SCORE: "0.5",
    });
    expect(cfg.docsGapDigest).toEqual({
      cron: "0 0 * * *",
      tz: "America/Chicago",
      minScore: 0.5,
    });
  });

  it("DOCS_GAP_DIGEST_MIN_SCORE=0 is a legitimate boundary value, not 'unset'", () => {
    const cfg = loadConfig({ ...BASE_ENV, DOCS_GAP_DIGEST_MIN_SCORE: "0" });
    expect(cfg.docsGapDigest.minScore).toBe(0);
  });

  it("a non-numeric DOCS_GAP_DIGEST_MIN_SCORE fails loud rather than silently coercing", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DOCS_GAP_DIGEST_MIN_SCORE: "not-a-number" }),
    ).toThrow();
  });

  it("an out-of-range DOCS_GAP_DIGEST_MIN_SCORE (outside 0-1) fails loud", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DOCS_GAP_DIGEST_MIN_SCORE: "1.5" }),
    ).toThrow();
  });
});

describe("loadConfig — generation baseURL and apiKey", () => {
  it("reads GENERATION_BASE_URL and GENERATION_API_KEY into the generation block", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      GENERATION_PROVIDER: "openai",
      GENERATION_MODEL: "llama3.1:8b",
      GENERATION_BASE_URL: "http://127.0.0.1:11434/v1",
      GENERATION_API_KEY: "gen-key",
    });
    expect(cfg.generation?.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(cfg.generation?.apiKey).toBe("gen-key");
  });

  it("leaves both undefined when unset, rather than empty strings", () => {
    // An empty string would defeat the "is a key present" check downstream.
    const cfg = loadConfig({
      ...BASE_ENV,
      GENERATION_PROVIDER: "gemini",
      GENERATION_MODEL: "gemini-2.5-flash",
    });
    expect(cfg.generation?.baseURL).toBeUndefined();
    expect(cfg.generation?.apiKey).toBeUndefined();
  });

  it("collapses empty-string GENERATION_BASE_URL and GENERATION_API_KEY to undefined", () => {
    // `FOO=` in a .env yields "", which would read as "a value is present"
    // downstream. This is what `|| undefined` is for, and what the
    // omitted-variable test above cannot exercise.
    const cfg = loadConfig({
      ...BASE_ENV,
      GENERATION_PROVIDER: "openai",
      GENERATION_MODEL: "llama3.1:8b",
      GENERATION_BASE_URL: "",
      GENERATION_API_KEY: "",
    });
    expect(cfg.generation?.baseURL).toBeUndefined();
    expect(cfg.generation?.apiKey).toBeUndefined();
  });

  it("rejects a malformed GENERATION_BASE_URL rather than passing it to the SDK", () => {
    // z.string().url() — a typo'd host should fail at boot, not at first query.
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        GENERATION_PROVIDER: "openai",
        GENERATION_MODEL: "llama3.1:8b",
        GENERATION_BASE_URL: "127.0.0.1:11434",
      }),
    ).toThrow();
  });
});

describe("loadConfig — generation TRI policy default", () => {
  // The default is a compliance posture, not a convenience: a deployment that
  // never mentions GENERATION_TRI_POLICY gets the strict policy, and leniency
  // has to be asked for in writing. Pinned so a future schema edit has to argue
  // with a test rather than quietly relax it.
  it("defaults to block when GENERATION_TRI_POLICY is unset", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      GENERATION_PROVIDER: "gemini",
      GENERATION_MODEL: "gemini-2.5-flash",
    });
    expect(cfg.generation?.triPolicy).toBe("block");
  });

  it("still honours an explicit warn", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      GENERATION_PROVIDER: "gemini",
      GENERATION_MODEL: "gemini-2.5-flash",
      GENERATION_TRI_POLICY: "warn",
    });
    expect(cfg.generation?.triPolicy).toBe("warn");
  });

  it("still honours an explicit off", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      GENERATION_PROVIDER: "gemini",
      GENERATION_MODEL: "gemini-2.5-flash",
      GENERATION_TRI_POLICY: "off",
    });
    expect(cfg.generation?.triPolicy).toBe("off");
  });
});

describe("loadConfig — embedding request pacing", () => {
  // Pacing is opt-in: a deployment that was not hitting a rate limit must see
  // no behaviour change from this field existing.
  it("defaults to 0 (unpaced)", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.embedding.requestsPerMinute).toBe(0);
  });

  it("reads EMBEDDING_REQUESTS_PER_MINUTE", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      EMBEDDING_REQUESTS_PER_MINUTE: "60",
    });
    expect(cfg.embedding.requestsPerMinute).toBe(60);
  });
});

describe("loadConfig — WORKER_SCANNER_PACK_DIR", () => {
  it("defaults to packs/cpa so a deployment that sets nothing still redacts", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.worker.scannerPackDir).toBe("packs/cpa");
  });

  it("honours an override, so another vertical's pack can be swapped in", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      WORKER_SCANNER_PACK_DIR: "packs/legal",
    });
    expect(cfg.worker.scannerPackDir).toBe("packs/legal");
  });

  it("rejects an empty pack dir rather than silently resolving to cwd", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, WORKER_SCANNER_PACK_DIR: "" }),
    ).toThrow();
  });
});
