# Local Generation (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deployment point generation at a self-hosted, OpenAI-compatible model (Ollama, vLLM, LM Studio, llama.cpp) so a client whose data may not leave their network can still get answers — without weakening the egress boundary in the process.

**Architecture:** Add `baseURL` to `GeneratorOptions`, thread it into the OpenAI SDK client _and_ into the egress pre-flight (today the pre-flight validates a hardcoded literal). Add `GENERATION_BASE_URL` / `GENERATION_API_KEY` to config, and resolve the generation credential through a small pure function so the air-gapped combination (`EMBEDDING_PROVIDER=local` + local generation) stops silently disabling generation.

**Tech Stack:** TypeScript, pnpm workspace, Zod (config), Vitest (tests), `openai@4.104.0` SDK (`baseURL` verified present in `ClientOptions`, `node_modules/openai/index.d.ts:44`).

**Source spec:** [`../specs/2026-08-03-multi-vertical-rag-platform-design.md`](../specs/2026-08-03-multi-vertical-rag-platform-design.md) §5, §5.1, §5.2, §8 (slice 2).

---

## Corrections — four defects in this plan, found in review after implementation

**Read this before reusing any pattern here in a later slice.** The implementers
transcribed this plan faithfully; these were the plan's errors, not theirs. The
shipped code is the truth — where it diverges from the task text below, the code
is right. Corrected inline, but recorded here because the _class_ of mistake is
what generalizes.

1. **A conditional spread reopened the very bypass this plan existed to close.**
   The plan specified `...(opts.baseURL ? { baseURL: opts.baseURL } : {})`.
   Omitting a key is not the same as passing `undefined`: the OpenAI SDK
   destructures `{ baseURL = readEnv('OPENAI_BASE_URL') }` (`openai/index.js:72`),
   so the env var won while the pre-flight still asserted the hardcoded literal.
   **Lesson: pass the security-relevant value unconditionally.** An option that
   is sometimes absent is an option the SDK can default out from under you.

2. **"The Google SDK has no equivalent knob" was false.** `@google/genai` exposes
   `httpOptions.baseUrl` (`genai.d.ts:6096`) and reads `GOOGLE_GEMINI_BASE_URL`
   from the environment — so the Gemini path had the same bypass. The guard was
   right; the stated reason was invented. **Lesson: verify a capability claim
   against the SDK's types before writing it into a security rationale.**

3. **`EMBEDDING_API_KEY` does not exist in this codebase.** The plan named it in
   an interface doc, in `env.example`, and — worst — in the operator-facing
   reason logged when generation disables itself. The real variables are
   `GEMINI_API_KEY` / `OPENAI_API_KEY`, selected by `EMBEDDING_PROVIDER`
   (`packages/core/src/config.ts:539-544`).

4. **The credential precedence forwarded a hosted vendor's key to a self-hosted
   endpoint.** The plan ordered it explicit → inherited → placeholder, and pinned
   that order with a test. Shipped order is explicit → placeholder-if-`baseURL` →
   inherited. **Lesson: the spec's own §5.2 reasoning — "`localhost:11434` can be
   an SSH tunnel" — applies to credentials, not just to `triPolicy`.**

A fifth, lesser one: the empty-string config test specified in Task 3 Step 1
passed vacuously (it omitted the variables rather than setting them to `""`), so
it could not distinguish `||` from `??`. Fixed during implementation.

## Global Constraints

- **The egress allow-list is a hard boundary and is not policy-tunable.** Any code path that reaches a network host must validate _that_ host. Never validate a stand-in.
- **Fail loud on ambiguous configuration.** A setting that appears to do something but does not (e.g. `baseURL` under the Gemini provider) must throw at construction, not be ignored.
- **`triPolicy` is never inferred from the endpoint.** "Looks local" is not a security property — `localhost:11434` can be an SSH tunnel. (Spec §5.2.)
- **800-line hard cap per source file** (pre-commit hook). `generator.ts` is ~445 lines and `config.ts` is large — do not grow either more than these tasks require.
- **No `console.*`** — log via the injected pino logger. ESLint warns.
- **Never `git commit --no-verify`.** Pre-commit runs prettier, an eslint pass, a secret scan, and the file-size cap. Expect files to be reformatted by prettier after edits; do not fight it.
- **Tests are colocated** (`foo.ts` → `foo.test.ts` in the same directory).
- **The working tree already carries uncommitted work from prior sessions.** Always `git add` explicit paths — never `git add -A` or `git add .`.
- On a fresh clone run `pnpm test:fresh` once (tests resolve workspace packages via built `dist/`); after that `pnpm --filter <pkg> test` works.

---

## File Structure

| File                                               | Responsibility                                                                                                                               | Change |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/rag/src/generation/generator.ts`         | `baseURL` on options; OpenAI client honors it; pre-flight validates the **effective** host; `createGenerator` rejects `baseURL` under Gemini | Modify |
| `packages/rag/src/generation/generator.test.ts`    | Pins the effective-host behavior and the Gemini guard                                                                                        | Modify |
| `packages/core/src/generation-credentials.ts`      | Pure resolution of which API key generation uses, and whether it is viable at all                                                            | Create |
| `packages/core/src/generation-credentials.test.ts` | Its unit tests                                                                                                                               | Create |
| `packages/core/src/index.ts`                       | Re-export the new module                                                                                                                     | Modify |
| `packages/core/src/config.ts`                      | `generation.baseURL` + `generation.apiKey` in the schema and the env reader                                                                  | Modify |
| `packages/runtime/src/index.ts`                    | Pass `baseURL` through; use the credential resolver instead of `config.embedding.apiKey` directly                                            | Modify |
| `env.example`                                      | Document `GENERATION_BASE_URL`, `GENERATION_API_KEY`, and the egress consequence                                                             | Modify |
| `docs/LOCAL-GENERATION.md`                         | The air-gapped recipe end to end                                                                                                             | Create |

**Why a separate `generation-credentials.ts`** rather than inlining in `runtime`: `packages/runtime` has no test setup (it is the repo's known coverage gap, and `.claude/rules/tdd.md` says not to widen it). The resolution has three real branches and a security-relevant fallback, so it goes where it can be tested.

---

## Background: three findings this plan must handle

Read these before starting. Two of them mean this slice is **not** a pure addition.

**1. The pre-flight validates a hardcoded literal.**

```
generator.ts:372   this.client = new OpenAI({ apiKey: opts.apiKey });   // no baseURL
generator.ts:380   runPreFlight(prompt, "https://api.openai.com", ...)  // hardcoded
generator.ts:294   egressPolicy.assertAllowed(endpoint);
```

Adding `baseURL` alone would make `EgressPolicy` approve `api.openai.com` while the request goes to an entirely different host. That is a silent bypass of the same boundary the reranker was deliberately gated on. Task 1 closes it in the same change that opens it.

**2. `buildCoreDeps` sources the generation key from the embedding config.**

`packages/runtime/src/index.ts:184` reads `config.embedding.apiKey`, and `embedding.apiKey` is `z.string().optional()` because `EMBEDDING_PROVIDER=local` needs no key. So the exact air-gapped pairing the spec promises — local embeddings **and** local generation — hits the `if (!apiKey)` branch at line 185 and **disables generation with a warning**. Without Task 3 this slice ships a feature that cannot be turned on in its headline configuration.

**3. The OpenAI SDK requires a non-empty `apiKey` even when the endpoint ignores it.** Self-hosted endpoints accept any value. Hence the placeholder in Task 2.

---

## Task 1: `baseURL` reaches both the client and the egress check

**Files:**

- Modify: `packages/rag/src/generation/generator.ts` (options interface ~line 40s; `OpenAIGenerator` constructor `:372`; `preFlight` `:377-385`; `createGenerator` `:434-444`)
- Test: `packages/rag/src/generation/generator.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `GeneratorOptions.baseURL?: string`, honored by `OpenAIGenerator` and rejected by `createGenerator` when `provider === "gemini"`. Tasks 2–4 depend on this field name.

**Why one task, not two:** splitting "add the field" from "fix the egress host" would produce an intermediate commit in which the allow-list can be bypassed. There is no reviewable state between them.

- [ ] **Step 1: Write the failing tests**

Append to `packages/rag/src/generation/generator.test.ts`, at the end of the file. `127.0.0.1:9` is the discard port — the connection is refused immediately, so tests that get _past_ the egress check stay fast and need no network.

```ts
describe("baseURL — self-hosted generation endpoints", () => {
  const cleanChunk = [
    rr({ text: "File the engagement letter in the client folder." }),
  ];

  it("validates the effective host, not api.openai.com, when baseURL is set", async () => {
    // The allow-list names OpenAI and nothing else. Pointing baseURL somewhere
    // else must be blocked — otherwise the allow-list is approving a host the
    // client is not calling, which is worse than having no allow-list at all.
    const gen = new OpenAIGenerator({
      apiKey: "test-key",
      model: "test-model",
      baseURL: "http://127.0.0.1:9/v1",
      egressPolicy: new EgressPolicy(["api.openai.com"]),
      triPolicy: "off",
    });
    await expect(gen.answer("q", cleanChunk)).rejects.toThrow(EgressError);
  });

  it("allows the effective host when the allow-list names it", async () => {
    const gen = new OpenAIGenerator({
      apiKey: "test-key",
      model: "test-model",
      baseURL: "http://127.0.0.1:9/v1",
      egressPolicy: new EgressPolicy(["127.0.0.1"]),
      triPolicy: "off",
    });
    // Reaching a connection error proves the pre-flight passed. Asserting "not
    // EgressError" rather than a specific network error keeps this from
    // depending on how the SDK surfaces ECONNREFUSED.
    const err = await gen.answer("q", cleanChunk).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(EgressError);
  });

  it("still validates api.openai.com when baseURL is omitted", async () => {
    const gen = new OpenAIGenerator({
      apiKey: "test-key",
      model: "test-model",
      egressPolicy: new EgressPolicy([]),
      triPolicy: "off",
    });
    await expect(gen.answer("q", cleanChunk)).rejects.toThrow(EgressError);
  });

  it("blocks an SSN through a local endpoint under the default policy", async () => {
    // §5.2: a local endpoint does not relax the TRI gate. Nothing about
    // "looks local" is verifiable — localhost can be a tunnel.
    const gen = new OpenAIGenerator({
      apiKey: "test-key",
      model: "test-model",
      baseURL: "http://127.0.0.1:9/v1",
      egressPolicy: new EgressPolicy(["127.0.0.1"]),
    });
    await expect(
      gen.answer("q", [rr({ text: "Client SSN 123-45-6789 on file." })]),
    ).rejects.toThrow(ComplianceError);
  });

  it("refuses baseURL under the gemini provider rather than ignoring it", async () => {
    // Silently ignoring it would let an operator believe they are air-gapped
    // while every prompt goes to Google.
    expect(() =>
      createGenerator({
        provider: "gemini",
        apiKey: "test-key",
        model: "test-model",
        baseURL: "http://127.0.0.1:9/v1",
      }),
    ).toThrow(/baseURL/);
  });
});
```

Add `createGenerator` to the existing import from `./generator.js` at the top of the file (it currently imports `buildPrompt`, `filterCitationsToAnswer`, `GeminiGenerator`, `OpenAIGenerator`).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @rag/rag test -- generator
```

Expected: the two `baseURL`-carrying construction tests fail to typecheck / throw on an unknown property, and the effective-host test fails because no `EgressError` is raised (the hardcoded `api.openai.com` is on the allow-list). The "omitted" and "SSN" tests should already pass — they pin behavior that must not change.

- [ ] **Step 3: Add `baseURL` to the options interface**

In `packages/rag/src/generation/generator.ts`, add to `GeneratorOptions`:

```ts
  /**
   * Override the API base URL. Applies to the `openai` provider only, and is
   * how a self-hosted OpenAI-compatible endpoint (Ollama, vLLM, LM Studio,
   * llama.cpp) is selected — combined with `EMBEDDING_PROVIDER=local` it
   * yields a deployment that makes no third-party calls at all.
   *
   * The egress allow-list applies to THIS host, not to api.openai.com — see
   * `preFlight` below. `EGRESS_ALLOWED_HOSTS` must name it or every call
   * throws `EgressError`.
   *
   * This does NOT relax `triPolicy`. A local-looking host is not verifiable
   * as local, so the scan stays under explicit operator control.
   */
  baseURL?: string;
```

- [ ] **Step 4: Honor it in the client and in the pre-flight**

Replace the `OpenAIGenerator` constructor and `preFlight` (`generator.ts:371-385`):

```ts
  constructor(private readonly opts: GeneratorOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
    this._egressPolicy = opts.egressPolicy ?? EgressPolicy.fromEnv();
  }

  /** TRI + egress pre-flight. Throws ComplianceError or EgressError on violation. */
  private preFlight(prompt: string): void {
    runPreFlight(
      prompt,
      // The host actually being called. Passing a literal here would have the
      // allow-list vouch for a host the client never contacts.
      this.opts.baseURL ?? "https://api.openai.com",
      this._egressPolicy,
      this.opts.triPolicy ?? "warn",
      this.opts.onTriDetected,
    );
  }
```

- [ ] **Step 5: Reject `baseURL` under Gemini in the factory**

Replace `createGenerator` (`generator.ts:434-444`):

```ts
export function createGenerator(
  opts: GeneratorOptions & { provider: "gemini" | "openai" },
): Generator {
  const { provider, ...generatorOpts } = opts;
  switch (provider) {
    case "gemini":
      if (generatorOpts.baseURL) {
        // CORRECTED (see Corrections #2): the original text here claimed the
        // Google SDK has no equivalent knob. It does — httpOptions.baseUrl.
        // Fail loud because self-hosted generation is supported through the
        // `openai` provider only (one path, not two), so accepting this
        // would leave an operator believing they are self-hosted while every
        // prompt goes to generativelanguage.googleapis.com.
        throw new Error(
          "generation baseURL is supported by the 'openai' provider only; " +
            "set GENERATION_PROVIDER=openai to use a self-hosted endpoint",
        );
      }
      return new GeminiGenerator(generatorOpts);
    case "openai":
      return new OpenAIGenerator(generatorOpts);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @rag/rag test -- generator
```

Expected: PASS, including every pre-existing TRI and citation test in the file.

- [ ] **Step 7: Commit**

```bash
git add packages/rag/src/generation/generator.ts packages/rag/src/generation/generator.test.ts
git commit -m "feat(generation): support self-hosted endpoints via baseURL

The egress pre-flight passed a hardcoded \"https://api.openai.com\" to
assertAllowed, so adding baseURL without threading it through would have
had the allow-list vouch for a host the client never calls. The
pre-flight now validates the effective host.

baseURL under the gemini provider throws rather than being ignored, and
a local endpoint does not relax triPolicy (spec 5.2)."
```

---

## Task 2: Resolve the generation credential

**Files:**

- Create: `packages/core/src/generation-credentials.ts`
- Create: `packages/core/src/generation-credentials.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: nothing from Task 1 (independent; can be done in parallel).
- Produces:
  - `resolveGenerationCredentials(input: GenerationCredentialInput): GenerationCredentials`
  - `GenerationCredentialInput = { generationApiKey?: string; embeddingApiKey?: string; baseURL?: string }`
  - `GenerationCredentials = { kind: "ok"; apiKey: string } | { kind: "disabled"; reason: string }`
  - `LOCAL_ENDPOINT_PLACEHOLDER_KEY: string`
  - Task 4 calls this.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/generation-credentials.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  LOCAL_ENDPOINT_PLACEHOLDER_KEY,
  resolveGenerationCredentials,
} from "./generation-credentials.js";

describe("resolveGenerationCredentials", () => {
  it("prefers an explicit generation key over the embedding key", () => {
    // Mixed vendors (Gemini embeddings, OpenAI generation) is a real
    // configuration; inheriting silently would send the wrong key.
    expect(
      resolveGenerationCredentials({
        generationApiKey: "gen-key",
        embeddingApiKey: "embed-key",
      }),
    ).toEqual({ kind: "ok", apiKey: "gen-key" });
  });

  it("inherits the embedding key when no generation key is set", () => {
    // Preserves the pre-existing single-vendor behavior.
    expect(
      resolveGenerationCredentials({ embeddingApiKey: "embed-key" }),
    ).toEqual({ kind: "ok", apiKey: "embed-key" });
  });

  it("supplies a placeholder for a keyless local endpoint", () => {
    // EMBEDDING_PROVIDER=local means there is no embedding key to inherit.
    // Without this branch the headline air-gapped configuration silently
    // disables generation, because the SDK requires a non-empty key.
    expect(
      resolveGenerationCredentials({ baseURL: "http://127.0.0.1:11434/v1" }),
    ).toEqual({ kind: "ok", apiKey: LOCAL_ENDPOINT_PLACEHOLDER_KEY });
  });

  // CORRECTED (see Corrections #4). This test originally asserted
  // `apiKey: "embed-key"` — pinning a precedence that leaked a hosted
  // vendor's key to a self-hosted endpoint. DELIBERATE ORDER: do not
  // "restore" inheritance ahead of the baseURL branch.
  it("never forwards an inherited vendor key to a self-hosted endpoint", () => {
    expect(
      resolveGenerationCredentials({
        embeddingApiKey: "embed-key",
        baseURL: "http://127.0.0.1:11434/v1",
      }),
    ).toEqual({ kind: "ok", apiKey: LOCAL_ENDPOINT_PLACEHOLDER_KEY });
  });

  it("disables generation when there is no key and no local endpoint", () => {
    const result = resolveGenerationCredentials({});
    expect(result.kind).toBe("disabled");
  });

  it("treats whitespace-only values as absent", () => {
    // A key set to "" or " " in a .env is the common way this is misconfigured,
    // and the SDK would accept it and fail later at the provider.
    const result = resolveGenerationCredentials({
      generationApiKey: "   ",
      embeddingApiKey: "",
    });
    expect(result.kind).toBe("disabled");
  });

  it("trims a padded key rather than passing the padding through", () => {
    expect(
      resolveGenerationCredentials({ generationApiKey: "  gen-key  " }),
    ).toEqual({ kind: "ok", apiKey: "gen-key" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rag/core test -- generation-credentials
```

Expected: FAIL — `Cannot find module './generation-credentials.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/generation-credentials.ts`:

```ts
/**
 * Which API key generation should use, and whether generation is viable at all.
 *
 * Generation historically borrowed `config.embedding.apiKey` on the assumption
 * that embeddings and generation come from the same vendor. That assumption
 * breaks in exactly the deployment this exists to serve: `EMBEDDING_PROVIDER=
 * local` needs no key, so a self-hosted generation endpoint paired with local
 * embeddings would find no key and disable itself.
 */
export interface GenerationCredentialInput {
  /** `GENERATION_API_KEY` — explicit, wins over everything. */
  generationApiKey?: string | undefined;
  /** `GEMINI_API_KEY`/`OPENAI_API_KEY` — inherited when generation has none. */
  embeddingApiKey?: string | undefined;
  /** `GENERATION_BASE_URL` — presence means a self-hosted endpoint. */
  baseURL?: string | undefined;
}

export type GenerationCredentials =
  { kind: "ok"; apiKey: string } | { kind: "disabled"; reason: string };

/**
 * Sent to self-hosted endpoints, which ignore the value. The OpenAI SDK
 * rejects an empty `apiKey`, so something must be supplied; naming it plainly
 * beats an empty string that reads like a bug in logs.
 */
export const LOCAL_ENDPOINT_PLACEHOLDER_KEY = "local-endpoint-no-key";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveGenerationCredentials(
  input: GenerationCredentialInput,
): GenerationCredentials {
  const explicit = clean(input.generationApiKey);
  if (explicit) return { kind: "ok", apiKey: explicit };

  // CORRECTED (see Corrections #4). This branch originally came AFTER
  // inheritance, which sent a real GEMINI_API_KEY as a bearer token to
  // whatever GENERATION_BASE_URL named. A self-hosted endpoint gets the
  // placeholder, never a hosted vendor's key — "looks local" is not
  // verifiable, the same reason triPolicy is not inferred from the endpoint.
  if (clean(input.baseURL)) {
    return { kind: "ok", apiKey: LOCAL_ENDPOINT_PLACEHOLDER_KEY };
  }

  const inherited = clean(input.embeddingApiKey);
  if (inherited) return { kind: "ok", apiKey: inherited };

  return {
    kind: "disabled",
    reason:
      "no GENERATION_API_KEY, no GEMINI_API_KEY/OPENAI_API_KEY to inherit from the embedding provider, and no GENERATION_BASE_URL",
  };
}
```

- [ ] **Step 4: Export it from the package entry point**

In `packages/core/src/index.ts`, add alongside the existing exports (`./egress-policy.js` is at line 12):

```ts
export * from "./generation-credentials.js";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @rag/core test -- generation-credentials
```

Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/generation-credentials.ts packages/core/src/generation-credentials.test.ts packages/core/src/index.ts
git commit -m "feat(core): resolve the generation credential independently of embeddings

Generation borrowed the embedding API key, which is absent under
EMBEDDING_PROVIDER=local — so local embeddings plus a self-hosted
generation endpoint disabled generation entirely. Adds an explicit key,
inheritance as the fallback, and a placeholder for keyless local
endpoints."
```

---

## Task 3: Config schema and env reader

**Files:**

- Modify: `packages/core/src/config.ts` (schema `generation` block `:160-209`; env reader `:630-641`)
- Test: `packages/core/src/config.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `config.generation.baseURL?: string` and `config.generation.apiKey?: string`, read from `GENERATION_BASE_URL` and `GENERATION_API_KEY`. Task 4 reads both.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/config.test.ts`. The file already imports `loadConfig` and defines `BASE_ENV` (a minimal valid env: `DATABASE_URL` + `API_TOKENS`) at the top — reuse both; do not add a new helper.

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rag/core test -- config
```

Expected: FAIL — `baseURL` is `undefined` in the first test because the schema strips unknown keys.

- [ ] **Step 3: Add the fields to the schema**

In `packages/core/src/config.ts`, inside the `generation` object (after `maxOutputTokens`, before the `triPolicy` block at `:207`):

```ts
        /**
         * Base URL for an OpenAI-compatible generation endpoint. Set this to
         * run generation against a self-hosted model (Ollama, vLLM, LM Studio,
         * llama.cpp) instead of a third-party API; combined with
         * `EMBEDDING_PROVIDER=local` nothing leaves the client's network.
         *
         * `openai` provider only — `GENERATION_PROVIDER=gemini` with this set
         * throws at generator construction rather than ignoring it.
         *
         * The egress allow-list applies to THIS host: add it to
         * `EGRESS_ALLOWED_HOSTS` or every call throws `EgressError`.
         *
         * Set via `GENERATION_BASE_URL`.
         */
        baseURL: z.string().url().optional(),

        /**
         * API key for generation. Optional: falls back to the embedding
         * provider's key (the single-vendor case), and is unnecessary
         * altogether for a self-hosted endpoint, which ignores it.
         *
         * Set via `GENERATION_API_KEY`.
         */
        apiKey: z.string().optional(),
```

- [ ] **Step 4: Read them in the env reader**

In the `generation:` object of the env reader (`config.ts:630-641`), add after `maxOutputTokens`:

```ts
            baseURL: env.GENERATION_BASE_URL || undefined,
            apiKey: env.GENERATION_API_KEY || undefined,
```

The `|| undefined` (rather than `??`) is deliberate and matches the surrounding style: it collapses `""` to `undefined`, which is what the second test pins.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @rag/core test -- config
```

Expected: PASS, with no regression in the rest of `config.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "feat(config): add GENERATION_BASE_URL and GENERATION_API_KEY"
```

---

## Task 4: Wire it through `buildCoreDeps`

**Files:**

- Modify: `packages/runtime/src/index.ts:182-219`

**Interfaces:**

- Consumes: `resolveGenerationCredentials`, `GenerationCredentials`, `LOCAL_ENDPOINT_PLACEHOLDER_KEY` (Task 2); `config.generation.baseURL` / `.apiKey` (Task 3); `GeneratorOptions.baseURL` (Task 1).
- Produces: a `generator` that reaches a self-hosted endpoint when configured. Nothing downstream consumes new names.

**This task is what makes the feature reachable.** Tasks 1–3 are inert without it: `buildCoreDeps` currently disables generation whenever `config.embedding.apiKey` is falsy, which is precisely the air-gapped case.

- [ ] **Step 1: Replace the credential branch**

In `packages/runtime/src/index.ts`, replace lines 183-190 (`if (config.generation) { const apiKey = ... } else {`) so the block reads:

```ts
  if (config.generation) {
    // Generation used to borrow the embedding provider's key outright, on the
    // assumption of a single vendor. That assumption fails for the deployment
    // this feature exists to serve: EMBEDDING_PROVIDER=local has no key, so a
    // self-hosted generation endpoint would have disabled itself here.
    const credentials = resolveGenerationCredentials({
      generationApiKey: config.generation.apiKey,
      embeddingApiKey: config.embedding.apiKey,
      baseURL: config.generation.baseURL,
    });
    if (credentials.kind === "disabled") {
      logger.warn(
        { provider: config.generation.provider, reason: credentials.reason },
        "generation configured but no usable API key — generation disabled",
      );
    } else {
```

Leave the `triPolicy` computation (`:196-205`) exactly as it is — the compliance-mode override still applies, and a local endpoint must not change it (§5.2).

- [ ] **Step 2: Pass `apiKey` and `baseURL` to the factory**

Replace the `createGenerator` call (`:206-217`):

```ts
generator = createGenerator({
  provider: config.generation.provider,
  model: config.generation.model,
  apiKey: credentials.apiKey,
  ...(config.generation.baseURL ? { baseURL: config.generation.baseURL } : {}),
  maxOutputTokens: config.generation.maxOutputTokens,
  triPolicy,
  onTriDetected: (patterns) =>
    logger.warn(
      { triPatterns: patterns, marker: "generation.tri.warned" },
      "TRI patterns detected in generation prompt; proceeding under triPolicy=warn",
    ),
});
```

- [ ] **Step 3: Log the endpoint at startup**

Immediately after the `createGenerator` call, add:

```ts
if (config.generation.baseURL) {
  // An operator who believes they are air-gapped needs one line in the
  // boot log confirming it — and needs the failure to be obvious if the
  // allow-list does not name the host.
  logger.info(
    { baseURL: config.generation.baseURL },
    "generation using a self-hosted endpoint",
  );
}
```

- [ ] **Step 4: Import the resolver**

Add `resolveGenerationCredentials` to the existing `@rag/core` import in `packages/runtime/src/index.ts`.

- [ ] **Step 5: Typecheck and build**

```bash
pnpm typecheck && pnpm --filter @rag/runtime build
```

Expected: clean. If `@rag/core` types are stale, run `pnpm --filter @rag/core build` first.

- [ ] **Step 6: Verify manually against a real local model**

This is the only end-to-end proof, and no unit test substitutes for it. If Ollama is unavailable, say so in the task report rather than marking the step done.

```bash
ollama serve &
ollama pull llama3.2:1b

# In the API's environment:
#   GENERATION_PROVIDER=openai
#   GENERATION_MODEL=llama3.2:1b
#   GENERATION_BASE_URL=http://127.0.0.1:11434/v1
#   EGRESS_ALLOWED_HOSTS=127.0.0.1
pnpm dev:api
curl -s -X POST localhost:3000/ask \
  -H 'content-type: application/json' \
  -d '{"question":"what is in the knowledge base?"}' | head -40
```

Expected: an answer, and `generation using a self-hosted endpoint` in the boot log. Then confirm the boundary holds — remove `127.0.0.1` from `EGRESS_ALLOWED_HOSTS`, restart, and re-run: the request must fail with `EGRESS_BLOCKED` (HTTP 503).

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/index.ts
git commit -m "feat(runtime): wire self-hosted generation through buildCoreDeps

buildCoreDeps disabled generation whenever the embedding API key was
absent, which is exactly the EMBEDDING_PROVIDER=local case — so the
air-gapped configuration could not be turned on. Uses the credential
resolver and passes baseURL through."
```

---

## Task 5: Documentation

**Files:**

- Create: `docs/LOCAL-GENERATION.md`
- Modify: `env.example` (generation block at `:302-309`)

**Interfaces:**

- Consumes: the env var names from Task 3.
- Produces: the recipe that `docs/DEPLOYING.md` will absorb in a later slice.

> **Hook warning:** a PreToolUse hook blocks writes to `.env`-pattern files and its pattern may match `env.example`. If the edit is denied, do not work around it — put the exact block in the task report and ask the user to paste it in.

- [ ] **Step 1: Write `docs/LOCAL-GENERATION.md`**

````markdown
# Self-Hosted (Air-Gapped) Generation

Point generation at a model running on the client's own network, so no prompt
text reaches a third party. Combined with `EMBEDDING_PROVIDER=local` (ONNX,
in-process) the deployment makes no outbound calls at all.

This exists because some deployments cannot use a hosted API: a treatment
center under 42 CFR Part 2, a hospital under HIPAA, or a firm whose engagement
terms forbid third-party disclosure. Without it, such a corpus can be indexed
but not answered from.

## Requirements

Any OpenAI-compatible server. Verified shapes:

| Server    | Typical base URL            | Notes                          |
| --------- | --------------------------- | ------------------------------ |
| Ollama    | `http://127.0.0.1:11434/v1` | Easiest to stand up            |
| vLLM      | `http://127.0.0.1:8000/v1`  | Best throughput for many users |
| LM Studio | `http://127.0.0.1:1234/v1`  | GUI, useful for evaluation     |
| llama.cpp | `http://127.0.0.1:8080/v1`  | `llama-server --api-key ...`   |

## Configuration

```bash
GENERATION_PROVIDER=openai          # required — see "Gemini" below
GENERATION_MODEL=llama3.1:8b        # the model name the server exposes
GENERATION_BASE_URL=http://127.0.0.1:11434/v1
EGRESS_ALLOWED_HOSTS=127.0.0.1      # REQUIRED — see below

EMBEDDING_PROVIDER=local            # for a fully air-gapped deployment
```

`GENERATION_API_KEY` is optional. Self-hosted servers ignore it; when no key is
configured anywhere, a placeholder is sent because the OpenAI SDK requires a
non-empty value.

## The egress allow-list applies to your endpoint

`EGRESS_ALLOWED_HOSTS` is a deny-by-default allow-list, and it validates the
host you are actually calling. If `GENERATION_BASE_URL` points at
`127.0.0.1` and the allow-list does not name it, every request fails with
`EGRESS_BLOCKED` (HTTP 503). This is deliberate: the allow-list must never
vouch for a host that is not the one being contacted.

Removing `api.openai.com` and `generativelanguage.googleapis.com` from the
list once you are fully self-hosted is the point of the exercise — it makes a
misconfiguration that would reach a third party fail loudly.

## Gemini cannot be self-hosted this way

`GENERATION_PROVIDER=gemini` with `GENERATION_BASE_URL` set **throws at
startup**. Self-hosted generation is supported through the `openai` provider
only — one path rather than two — so accepting the setting on the Gemini
provider would leave you believing you were self-hosted while every prompt went
to Google. Use `GENERATION_PROVIDER=openai`; that provider is a client for any
OpenAI-compatible server, not only OpenAI's.

_(Corrections #2: earlier text here claimed the Google SDK has no base-URL
option. It has one — `httpOptions.baseUrl` — and the shipped `GeminiGenerator`
now sets it explicitly so `GOOGLE_GEMINI_BASE_URL` cannot redirect the client
behind the egress check.)_

## The TRI scan is not relaxed automatically

`GENERATION_TRI_POLICY` keeps whatever value you gave it. A local-looking host
is not verifiably local — `localhost:11434` can be an SSH tunnel to anywhere —
so nothing infers "self-hosted, therefore safe."

Where you genuinely control the endpoint, the scan is guarding against a
disclosure that cannot occur, and `GENERATION_TRI_POLICY=off` is a defensible
choice. Make it deliberately. Note that `COMPLIANCE_MODE=client-data` forces
`block` regardless, so a deployment that has declared client data in scope
cannot select `off` by omission.

## Verifying

1. Boot the API. The log should carry `generation using a self-hosted endpoint`
   with your base URL.
2. Ask a question through `/ask` and confirm you get a cited answer.
3. Remove your endpoint's host from `EGRESS_ALLOWED_HOSTS`, restart, and ask
   again. It must fail with `EGRESS_BLOCKED`. If it succeeds, the allow-list is
   not being applied to your endpoint — stop and investigate.
4. For a genuinely air-gapped claim, confirm with `tcpdump` or the host
   firewall that no outbound connections leave the network during a query.
   Configuration review is not evidence.
````

- [ ] **Step 2: Update the `env.example` generation block**

Insert after `GENERATION_MAX_OUTPUT_TOKENS=2048` (`env.example:309`):

```bash
# Self-hosted, OpenAI-compatible generation endpoint (Ollama, vLLM, LM Studio,
# llama.cpp). Set this to keep prompt text on the client's network; pair with
# EMBEDDING_PROVIDER=local for a deployment that makes no outbound calls.
# Requires GENERATION_PROVIDER=openai — gemini + this throws at startup rather
# than silently calling Google.
# The host below MUST also appear in EGRESS_ALLOWED_HOSTS or every call throws.
# See docs/LOCAL-GENERATION.md.
# GENERATION_BASE_URL=http://127.0.0.1:11434/v1

# API key for generation. When unset it falls back to the embedding provider's
# key (GEMINI_API_KEY or OPENAI_API_KEY, per EMBEDDING_PROVIDER) for the
# single-vendor case, and is unnecessary for a self-hosted endpoint — which
# receives a placeholder, never an inherited vendor key. See Corrections #3/#4.
# GENERATION_API_KEY=
```

- [ ] **Step 3: Verify the docs match the code**

```bash
grep -n "GENERATION_BASE_URL\|GENERATION_API_KEY" env.example docs/LOCAL-GENERATION.md packages/core/src/config.ts
```

Expected: every name appears in all three, spelled identically.

- [ ] **Step 4: Commit**

```bash
git add docs/LOCAL-GENERATION.md env.example
git commit -m "docs: document self-hosted generation and its egress consequence"
```

---

## Task 6: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the full workspace test suite**

```bash
pnpm -r build && pnpm -r --filter '!@rag/e2e' run test
```

Expected: PASS. This is what the pre-push hook runs.

- [ ] **Step 2: Lint and typecheck**

```bash
pnpm lint && pnpm typecheck
```

- [ ] **Step 3: Confirm no hardcoded provider host remains in a pre-flight path**

```bash
grep -rn "api.openai.com" packages/rag/src/
```

Expected: the only occurrence in `generator.ts` is the `??` fallback inside `preFlight`. Any other literal reaching `runPreFlight` is the same bug in a new place.

- [ ] **Step 4: Confirm the retrieval eval is unaffected**

This slice changes no retrieval or prompt behavior, so `pnpm eval` should be unchanged. Per `.claude/rules/tdd.md` the harness is required for retrieval-affecting changes; run it to confirm this is not one.

```bash
pnpm eval
```

Expected: results consistent with `docs/EVAL-BASELINE.md`. A difference means something in this slice touched retrieval and needs explaining before merge.

- [ ] **Step 5: Report**

State plainly which steps passed, and whether Task 4 Step 6 (the real local-model run) was actually performed or skipped for lack of a local model. A skipped end-to-end check is the difference between "implemented" and "verified" — do not blur it.

---

## Out of scope

Deliberately excluded, per spec §7 and §8:

- **Local reranking.** `RERANK_PROVIDER` has the same third-party problem and the same shape of fix. Separate change.
- **A local audit-log sink.** Also egress-gated, also separate.
- **Auto-relaxing `triPolicy` for local endpoints.** Rejected in §5.2 — not deferred, decided against.
- **Model-quality evaluation of self-hosted models.** Whether `llama3.1:8b` answers well enough for a given corpus is an eval question, and it depends on slice 4's harness.
- **Anything in slices 1a/1b/3/4.** The neutral prompt, the pack format, the tier migration, and the settings catalog are all separate plans.
