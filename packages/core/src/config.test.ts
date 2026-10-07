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
      {
        ...BASE_ENV,
        COMPLIANCE_MODE: "client-data",
        // Required now: see the Layer 1.5 test below.
        CONTENT_SCAN_PROVIDER: "ollama",
        CONTENT_SCAN_BASE_URL: "http://ollama.railway.internal:11434/v1",
        CONTENT_SCAN_MODEL: "llama3.2:3b",
      },
      { checkDpa: () => true },
    );
    expect(cfg.complianceMode).toBe("client-data");
  });

  it("client-data with Layer 1.5 disabled throws loud", () => {
    // CONTENT_SCAN_PROVIDER defaults to "none", which turns Layer 1.5 OFF.
    // That is a defensible default for general material, but not once the
    // operator has declared real client data is in scope: "off" would then be
    // a silent bypass of the only layer that catches a client named in prose,
    // which pattern redaction structurally cannot see. Before this gate, a
    // client-data deployment could boot with the check simply absent and
    // nothing logged.
    expect(() =>
      loadConfig(
        { ...BASE_ENV, COMPLIANCE_MODE: "client-data" },
        { checkDpa: () => true },
      ),
    ).toThrow(/requires CONTENT_SCAN_PROVIDER/);
  });

  it("none mode does not require a content scanner", () => {
    const cfg = loadConfig({ ...BASE_ENV, COMPLIANCE_MODE: "none" });
    expect(cfg.contentScan.provider).toBe("none");
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

describe("loadConfig — platform PORT fallback", () => {
  it("prefers API_PORT / MCP_HTTP_PORT when set", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      API_PORT: "8080",
      MCP_HTTP_PORT: "8080",
      PORT: "9999",
    });
    expect(cfg.api.port).toBe(8080);
    expect(cfg.mcp.httpPort).toBe(8080);
  });

  it("falls back to the platform-injected PORT", () => {
    const cfg = loadConfig({ ...BASE_ENV, PORT: "8080" });
    expect(cfg.api.port).toBe(8080);
    expect(cfg.mcp.httpPort).toBe(8080);
  });

  it("falls back to the historical defaults when neither is set", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.api.port).toBe(3000);
    expect(cfg.mcp.httpPort).toBe(3001);
  });
});

describe("loadConfig — neighbour chunk expansion", () => {
  it("defaults to expanding the top 2 documents by up to 4 chunks each", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.retrieval.neighborExpansion).toEqual({
      documents: 2,
      chunksPerDocument: 4,
    });
  });

  it("reads NEIGHBOR_EXPANSION_DOCUMENTS / NEIGHBOR_EXPANSION_CHUNKS, where 0 disables", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      NEIGHBOR_EXPANSION_DOCUMENTS: "0",
      NEIGHBOR_EXPANSION_CHUNKS: "6",
    });
    expect(cfg.retrieval.neighborExpansion).toEqual({
      documents: 0,
      chunksPerDocument: 6,
    });
  });

  it("rejects a negative value", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, NEIGHBOR_EXPANSION_CHUNKS: "-1" }),
    ).toThrow();
  });
});

describe("loadConfig — GENERATION_THINKING_BUDGET", () => {
  const GEN = {
    ...BASE_ENV,
    GENERATION_PROVIDER: "gemini",
    GENERATION_MODEL: "gemini-2.5-flash",
    GEMINI_API_KEY: "k",
  } as NodeJS.ProcessEnv;

  it("is unset by default (provider default thinking)", () => {
    expect(loadConfig(GEN).generation?.thinkingBudget).toBeUndefined();
  });

  it("reads an explicit budget, including 0", () => {
    expect(
      loadConfig({ ...GEN, GENERATION_THINKING_BUDGET: "0" }).generation
        ?.thinkingBudget,
    ).toBe(0);
    expect(
      loadConfig({ ...GEN, GENERATION_THINKING_BUDGET: "1024" }).generation
        ?.thinkingBudget,
    ).toBe(1024);
  });
});

describe("loadConfig — RETRIEVAL_MIN_DENSE_SIMILARITY", () => {
  it("is off by default", () => {
    expect(
      loadConfig({ ...BASE_ENV }).retrieval.minDenseSimilarity,
    ).toBeUndefined();
  });
  it("reads a floor and rejects one outside [-1, 1]", () => {
    expect(
      loadConfig({ ...BASE_ENV, RETRIEVAL_MIN_DENSE_SIMILARITY: "0.55" })
        .retrieval.minDenseSimilarity,
    ).toBe(0.55);
    expect(() =>
      loadConfig({ ...BASE_ENV, RETRIEVAL_MIN_DENSE_SIMILARITY: "2" }),
    ).toThrow();
  });
});

describe("loadConfig — EMBEDDING_MODEL fallthrough", () => {
  // Compose and Railway commonly inject an always-present but EMPTY env var
  // rather than omitting it. `??` only falls through on undefined, so an empty
  // string became the literal embedding model id -- wrong for every provider.
  it("falls back to the provider default when EMBEDDING_MODEL is empty", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      EMBEDDING_PROVIDER: "local",
      EMBEDDING_MODEL: "",
    });
    expect(cfg.embedding.model).toBe("Xenova/bge-base-en-v1.5");
  });

  // The other two arms of defaultEmbeddingModel. Each must equal the
  // provider's OWN default, or an operator who sets only EMBEDDING_PROVIDER
  // gets a model the provider never intended.
  it.each([
    ["gemini", "gemini-embedding-001"],
    // openai.ts defaults to this too, and v3 models honour the `dimensions`
    // request parameter (openai.ts passes it), so pairing it with the 768
    // default below is coherent rather than a 1536-vs-768 mismatch.
    ["openai", "text-embedding-3-small"],
  ])("defaults %s to its own provider default", (provider, expected) => {
    const cfg = loadConfig({
      ...BASE_ENV,
      EMBEDDING_PROVIDER: provider,
      EMBEDDING_MODEL: "",
      ...(provider === "openai" ? { OPENAI_API_KEY: "sk-test" } : {}),
    });
    expect(cfg.embedding.model).toBe(expected);
  });

  it("pairs every provider default with the 768-d column width", () => {
    // chunks.embedding is vector(768) (EMBEDDING_COLUMN_DIMENSIONS). A
    // provider default whose dimensions disagree with that would only fail at
    // insert time, per document, after the API spend -- so pin it here.
    for (const provider of ["gemini", "openai", "local"]) {
      const cfg = loadConfig({
        ...BASE_ENV,
        EMBEDDING_PROVIDER: provider,
        EMBEDDING_MODEL: "",
        ...(provider === "openai" ? { OPENAI_API_KEY: "sk-test" } : {}),
      });
      expect(cfg.embedding.dimensions).toBe(768);
    }
  });

  it("still honours an explicitly set EMBEDDING_MODEL", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      EMBEDDING_PROVIDER: "local",
      EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
    });
    expect(cfg.embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
  });
});

describe("loadConfig — contentScan (Layer 1.5)", () => {
  it("defaults to provider 'none'", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.contentScan.provider).toBe("none");
    expect(cfg.contentScan.baseUrl).toBeUndefined();
  });

  it("reads an ollama provider configuration from env", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      CONTENT_SCAN_PROVIDER: "ollama",
      CONTENT_SCAN_BASE_URL: "http://ollama.railway.internal:11434/v1",
      CONTENT_SCAN_MODEL: "llama3.2:3b",
      CONTENT_SCAN_TIMEOUT_MS: "45000",
    });
    expect(cfg.contentScan).toEqual({
      provider: "ollama",
      baseUrl: "http://ollama.railway.internal:11434/v1",
      model: "llama3.2:3b",
      timeoutMs: 45000,
    });
  });

  // `isLikelySelfHosted` parses this value with `new URL()` and returns false
  // on a throw, so a non-URL reaches the compliance gate as "not self-hosted"
  // rather than as the configuration error it is. Rejecting it at the schema
  // means the operator is told which field is wrong instead of being told
  // their host is not self-hosted.
  it.each([
    ["a bare hostname", "ollama.railway.internal:11434"],
    ["a path with no scheme", "/v1/chat"],
    ["an empty-ish value", "not a url"],
  ])("refuses %s as CONTENT_SCAN_BASE_URL", (_label, baseUrl) => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        CONTENT_SCAN_PROVIDER: "ollama",
        CONTENT_SCAN_BASE_URL: baseUrl,
        CONTENT_SCAN_MODEL: "llama3.2:3b",
      }),
    ).toThrow();
  });
});
