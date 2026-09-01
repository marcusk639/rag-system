# Pack Scanner Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move TRI pattern definitions out of TypeScript and into `packs/cpa/pack.yaml`, behind a generic scan engine in `@rag/core` that emits every match with a `high`/`low` confidence and a stable offset.

**Architecture:** Split _find_ from _replace_. A new `scanText()` locates matches against pack-declared patterns without mutating the input, so offsets stay valid and every match is reported. `applyRedaction()` then masks only the `high` matches. Existing `redactText()` is rewired onto both and keeps its exact current behaviour. Validators and context gates are referenced from the pack by registered name and resolved to compiled-in code — no dynamic loading.

**Tech Stack:** TypeScript, zod (already a `@rag/core` dependency at `^3.24.1`), `yaml` (new direct dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-sensitive-content-discovery-design.md` §3 (and the platform spec it implements: `docs/superpowers/specs/2026-08-03-multi-vertical-rag-platform-design.md` §3.2, §3.4, §3.6)

**Scope:** This is plan 1 of 2. It delivers the pack format and scan engine only. The discovery service, `scan_*` tables, and admin API are plan 2 and depend on `scanText()` existing.

## Global Constraints

- **Behaviour preservation is a hard gate.** The 25 existing tests in `packages/core/src/content-safety.test.ts` and the 12 in `packages/ingestion/src/classify-document.test.ts` must pass unchanged at every commit. This slice is a refactor plus new capability, not a behaviour change.
- **The confidence rule is total.** Every match is emitted as `high` or `low`. A gate failure changes the label, never whether the finding exists. No match is ever silently dropped (spec §3.1).
- **No dynamic loading.** `validator` and `context` in the pack are names resolved against a registry of compiled-in functions (platform spec §3.4). Loading arbitrary modules is out.
- **Pack/core compatibility fails closed** (platform spec §3.6). An incompatible or unparseable pack throws at load; it never degrades to a default.
- **File size cap: 800 lines**, enforced by the pre-commit hook. Healthy target is 200–400.
- **Colocated tests:** `foo.ts` → `foo.test.ts` in the same directory.
- **Run a single package's tests with:** `pnpm --filter @rag/core test -- <name>`

---

## File Structure

| File                                  | Responsibility                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packs/cpa/pack.yaml`                 | **Create.** Pack data: identity, `requiresCore`, scanner declarations. No code.                          |
| `packages/core/src/pack/schema.ts`    | **Create.** Zod schema for the pack file + inferred types. Validation only.                              |
| `packages/core/src/pack/registry.ts`  | **Create.** Named validators (`luhn`, `aba`) and context matchers (`account-vocab`), resolved by name.   |
| `packages/core/src/pack/load.ts`      | **Create.** Read + parse + validate + compat-check a pack directory. Fails closed.                       |
| `packages/core/src/pack/scan.ts`      | **Create.** `scanText()` — the engine. Emits `ScanMatch[]` with offsets and confidence.                  |
| `packages/core/src/content-safety.ts` | **Modify.** `redactText()` rewired onto `scanText()` + new `applyRedaction()`. Public surface unchanged. |
| `packages/core/src/index.ts`          | **Modify.** Export the pack surface.                                                                     |

Splitting `pack/` into four small files rather than one keeps each under ~150 lines and lets schema/registry/loader be tested without touching the engine.

---

### Task 1: Pack schema

**Files:**

- Create: `packages/core/src/pack/schema.ts`
- Test: `packages/core/src/pack/schema.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `PackFile` (zod schema), `type PackFile`, `type ScannerDecl`, `type ScannerKind = "identifying" | "contextual"`, `type Disposition = "exclude" | "redact" | "flag"`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/pack/schema.test.ts
import { describe, it, expect } from "vitest";
import { PackFile } from "./schema.js";

const minimal = {
  pack: { id: "cpa", version: "1.0.0", requiresCore: "^1.0.0" },
  scanners: [
    {
      id: "ssn",
      kind: "identifying",
      disposition: "exclude",
      pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    },
  ],
};

describe("PackFile", () => {
  it("accepts a minimal valid pack", () => {
    expect(PackFile.parse(minimal).scanners[0]!.id).toBe("ssn");
  });

  it("defaults disposition from kind when omitted", () => {
    const p = PackFile.parse({
      ...minimal,
      scanners: [
        { id: "a", kind: "identifying", pattern: "x" },
        { id: "b", kind: "contextual", pattern: "y" },
      ],
    });
    expect(p.scanners[0]!.disposition).toBe("exclude");
    expect(p.scanners[1]!.disposition).toBe("flag");
  });

  it("rejects a scanner with an unknown kind", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "weird", pattern: "x" }],
      }),
    ).toThrow();
  });

  it("rejects duplicate scanner ids", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [
          { id: "dup", kind: "identifying", pattern: "x" },
          { id: "dup", kind: "contextual", pattern: "y" },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("rejects a pattern that is not a valid regex", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "[unclosed" }],
      }),
    ).toThrow(/regex/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rag/core test -- pack/schema`
Expected: FAIL — `Cannot find module './schema.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/pack/schema.ts
import { z } from "zod";

export const ScannerKind = z.enum(["identifying", "contextual"]);
export type ScannerKind = z.infer<typeof ScannerKind>;

export const Disposition = z.enum(["exclude", "redact", "flag"]);
export type Disposition = z.infer<typeof Disposition>;

/** Defaults per platform spec §3.7: identifying excludes, contextual flags. */
const DEFAULT_DISPOSITION: Record<ScannerKind, Disposition> = {
  identifying: "exclude",
  contextual: "flag",
};

const ScannerDecl = z
  .object({
    id: z.string().min(1),
    kind: ScannerKind,
    disposition: Disposition.optional(),
    /** JS regex source. Compiled at load; `g` is added by the engine. */
    pattern: z.string().min(1),
    /** Registered name of a compiled-in validator, e.g. "luhn". */
    validator: z.string().min(1).optional(),
    /** Registered name of a compiled-in context matcher, e.g. "account-vocab". */
    context: z.string().min(1).optional(),
    /** How far either side of a match the context matcher looks. */
    contextWindow: z.number().int().positive().default(60),
  })
  .transform((s) => ({
    ...s,
    disposition: s.disposition ?? DEFAULT_DISPOSITION[s.kind],
  }))
  .superRefine((s, ctx) => {
    try {
      new RegExp(s.pattern);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scanner "${s.id}": pattern is not a valid regex — ${(e as Error).message}`,
      });
    }
  });

export type ScannerDecl = z.infer<typeof ScannerDecl>;

export const PackFile = z
  .object({
    pack: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      /** Semver range against the PACK CONTRACT version (platform spec §3.6). */
      requiresCore: z.string().min(1),
    }),
    scanners: z.array(ScannerDecl).min(1),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const s of p.scanners) {
      if (seen.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate scanner id "${s.id}"`,
        });
      }
      seen.add(s.id);
    }
  });

export type PackFile = z.infer<typeof PackFile>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rag/core test -- pack/schema`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pack/schema.ts packages/core/src/pack/schema.test.ts
git commit -m "feat(pack): zod schema for pack scanner declarations"
```

---

### Task 2: Registered validators and context matchers

Moves `luhnValid`, `abaValid`, and `ACCOUNT_CONTEXT` out of `content-safety.ts` and behind names the pack can reference. Nothing is deleted from `content-safety.ts` yet — Task 5 rewires it.

**Files:**

- Create: `packages/core/src/pack/registry.ts`
- Test: `packages/core/src/pack/registry.test.ts`
- Read for reference: `packages/core/src/content-safety.ts` (`luhnValid`, `abaValid`, `ACCOUNT_CONTEXT`)

**Interfaces:**

- Consumes: nothing
- Produces: `resolveValidator(name: string): (m: string) => boolean`, `resolveContext(name: string): RegExp`, `VALIDATOR_NAMES: readonly string[]`, `CONTEXT_NAMES: readonly string[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/pack/registry.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveValidator,
  resolveContext,
  VALIDATOR_NAMES,
  CONTEXT_NAMES,
} from "./registry.js";

describe("registry", () => {
  it("resolves luhn and accepts a valid card number", () => {
    expect(resolveValidator("luhn")("4111111111111111")).toBe(true);
  });

  it("luhn rejects a number one digit off", () => {
    expect(resolveValidator("luhn")("4111111111111112")).toBe(false);
  });

  it("resolves aba and accepts a valid routing number", () => {
    expect(resolveValidator("aba")("011000015")).toBe(true);
  });

  it("aba rejects a 9-digit run that fails the checksum", () => {
    expect(resolveValidator("aba")("123456789")).toBe(false);
  });

  it("resolves account-vocab and matches nearby banking words", () => {
    expect(resolveContext("account-vocab").test("routing number follows")).toBe(
      true,
    );
    expect(resolveContext("account-vocab").test("invoice total follows")).toBe(
      false,
    );
  });

  it("throws on an unknown validator name rather than defaulting", () => {
    expect(() => resolveValidator("nope")).toThrow(/unknown validator "nope"/);
  });

  it("throws on an unknown context name rather than defaulting", () => {
    expect(() => resolveContext("nope")).toThrow(/unknown context "nope"/);
  });

  it("exposes its registered names for pack validation", () => {
    expect(VALIDATOR_NAMES).toContain("luhn");
    expect(CONTEXT_NAMES).toContain("account-vocab");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rag/core test -- pack/registry`
Expected: FAIL — `Cannot find module './registry.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/pack/registry.ts

/**
 * Compiled-in implementations a pack may reference BY NAME (platform spec §3.4).
 * A pack cannot supply code; unusual verticals get a new entry here and an image
 * rebuild, so the supply chain stays auditable.
 */

/** Luhn check — cheap and precise, kills most false card matches. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** ABA routing checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 mod 10. */
function abaValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map((c) => c.charCodeAt(0) - 48);
  const sum =
    3 * (d[0]! + d[3]! + d[6]!) +
    7 * (d[1]! + d[4]! + d[7]!) +
    1 * (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

const VALIDATORS: Record<string, (m: string) => boolean> = {
  luhn: (m) => luhnValid(m.replace(/[ -]/g, "")),
  aba: (m) => abaValid(m),
};

const CONTEXTS: Record<string, RegExp> = {
  "account-vocab":
    /\b(account|acct|routing|aba|bank|iban|swift|deposit|wire)\b/i,
};

export const VALIDATOR_NAMES: readonly string[] = Object.keys(VALIDATORS);
export const CONTEXT_NAMES: readonly string[] = Object.keys(CONTEXTS);

export function resolveValidator(name: string): (m: string) => boolean {
  const fn = VALIDATORS[name];
  if (!fn)
    throw new Error(
      `unknown validator "${name}" — packs may only reference compiled-in names`,
    );
  return fn;
}

export function resolveContext(name: string): RegExp {
  const re = CONTEXTS[name];
  if (!re)
    throw new Error(
      `unknown context "${name}" — packs may only reference compiled-in names`,
    );
  return re;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rag/core test -- pack/registry`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pack/registry.ts packages/core/src/pack/registry.test.ts
git commit -m "feat(pack): registry of compiled-in validators and context matchers"
```

---

### Task 3: Pack loader with fail-closed compatibility

**Files:**

- Create: `packages/core/src/pack/load.ts`
- Test: `packages/core/src/pack/load.test.ts`
- Modify: `packages/core/package.json` (add `yaml` dependency)

**Interfaces:**

- Consumes: `PackFile` (Task 1); `resolveValidator`, `resolveContext`, `VALIDATOR_NAMES`, `CONTEXT_NAMES` (Task 2)
- Produces: `loadPack(dir: string): LoadedPack`, `type LoadedPack = { id: string; version: string; scanners: CompiledScanner[] }`, `type CompiledScanner = { id: string; kind: ScannerKind; disposition: Disposition; re: RegExp; validate?: (m: string) => boolean; context?: RegExp; contextWindow: number }`, `PACK_CONTRACT_VERSION`

- [ ] **Step 1: Add the yaml dependency**

Run: `pnpm --filter @rag/core add yaml`

Commit this on its own so a dependency change is reviewable in isolation:

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore(core): add yaml for pack file parsing"
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/pack/load.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, PACK_CONTRACT_VERSION } from "./load.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pack-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writePack(body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.yaml"), body, "utf8");
}

describe("loadPack", () => {
  it("loads a valid pack and compiles its patterns", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^${PACK_CONTRACT_VERSION.split(".")[0]}.0.0" }
scanners:
  - id: ssn
    kind: identifying
    pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b'
`);
    const p = loadPack(dir);
    expect(p.id).toBe("cpa");
    expect(p.scanners[0]!.re.test("123-45-6789")).toBe(true);
    expect(p.scanners[0]!.disposition).toBe("exclude");
  });

  it("resolves a named validator onto the compiled scanner", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^${PACK_CONTRACT_VERSION.split(".")[0]}.0.0" }
scanners:
  - id: card
    kind: identifying
    pattern: '\\b(?:\\d[ -]?){12,18}\\d\\b'
    validator: luhn
`);
    expect(loadPack(dir).scanners[0]!.validate!("4111111111111111")).toBe(true);
  });

  it("throws when the pack requires an incompatible core", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^99.0.0" }
scanners:
  - id: ssn
    kind: identifying
    pattern: 'x'
`);
    expect(() => loadPack(dir)).toThrow(/incompatible/i);
  });

  it("throws on an unknown validator name rather than skipping the scanner", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^${PACK_CONTRACT_VERSION.split(".")[0]}.0.0" }
scanners:
  - id: x
    kind: identifying
    pattern: 'x'
    validator: not-registered
`);
    expect(() => loadPack(dir)).toThrow(/unknown validator/);
  });

  it("throws on malformed yaml rather than returning an empty pack", () => {
    writePack("pack: { id: cpa\nscanners: [");
    expect(() => loadPack(dir)).toThrow();
  });

  it("throws when pack.yaml is absent", () => {
    expect(() => loadPack(dir)).toThrow(/pack\.yaml/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rag/core test -- pack/load`
Expected: FAIL — `Cannot find module './load.js'`

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/core/src/pack/load.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PackFile, type Disposition, type ScannerKind } from "./schema.js";
import { resolveValidator, resolveContext } from "./registry.js";

/**
 * The PACK CONTRACT version — not the npm package version. A pack declares the
 * contract it targets via `requiresCore`; bumping this major is what breaks
 * older packs, and doing so deliberately is the point (platform spec §3.6).
 */
export const PACK_CONTRACT_VERSION = "1.0.0";

export interface CompiledScanner {
  id: string;
  kind: ScannerKind;
  disposition: Disposition;
  re: RegExp;
  validate?: (m: string) => boolean;
  context?: RegExp;
  contextWindow: number;
}

export interface LoadedPack {
  id: string;
  version: string;
  scanners: CompiledScanner[];
}

/** Minimal caret-range check. Only `^X.Y.Z` is supported, deliberately. */
function satisfiesCaret(range: string, version: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!m)
    throw new Error(
      `requiresCore must be a caret range like "^1.0.0", got "${range}"`,
    );
  const [rMaj, rMin, rPatch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)!;
  const [maj, min, patch] = [Number(v[1]), Number(v[2]), Number(v[3])];
  if (maj !== rMaj) return false;
  if (min > rMin) return true;
  if (min < rMin) return false;
  return patch >= rPatch;
}

export function loadPack(dir: string): LoadedPack {
  const file = join(dir, "pack.yaml");
  if (!existsSync(file)) throw new Error(`pack.yaml not found in ${dir}`);

  const parsed = PackFile.parse(parseYaml(readFileSync(file, "utf8")));

  if (!satisfiesCaret(parsed.pack.requiresCore, PACK_CONTRACT_VERSION)) {
    throw new Error(
      `pack "${parsed.pack.id}" requires core ${parsed.pack.requiresCore}, ` +
        `but this image implements pack contract ${PACK_CONTRACT_VERSION} — incompatible, refusing to load`,
    );
  }

  return {
    id: parsed.pack.id,
    version: parsed.pack.version,
    scanners: parsed.scanners.map((s) => ({
      id: s.id,
      kind: s.kind,
      disposition: s.disposition,
      // `g` is required — the engine iterates all matches.
      re: new RegExp(s.pattern, "g"),
      validate: s.validator ? resolveValidator(s.validator) : undefined,
      context: s.context ? resolveContext(s.context) : undefined,
      contextWindow: s.contextWindow,
    })),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rag/core test -- pack/load`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pack/load.ts packages/core/src/pack/load.test.ts
git commit -m "feat(pack): fail-closed pack loader with contract-version check"
```

---

### Task 4: The scan engine

The core of the slice. Emits **every** match with a stable offset into the **input** string, so nothing shifts and nothing is dropped.

**Files:**

- Create: `packages/core/src/pack/scan.ts`
- Test: `packages/core/src/pack/scan.test.ts`

**Interfaces:**

- Consumes: `LoadedPack`, `CompiledScanner` (Task 3)
- Produces: `scanText(text: string, pack: LoadedPack): ScanMatch[]`, `type Confidence = "high" | "low"`, `interface ScanMatch { scannerId: string; kind: ScannerKind; disposition: Disposition; confidence: Confidence; start: number; end: number; maskedSample: string }`, `maskValue(v: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/pack/scan.test.ts
import { describe, it, expect } from "vitest";
import { scanText, maskValue, type ScanMatch } from "./scan.js";
import type { LoadedPack } from "./load.js";

const pack: LoadedPack = {
  id: "test",
  version: "1.0.0",
  scanners: [
    {
      id: "ssn",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{3}-\d{2}-\d{4}\b/g,
      contextWindow: 60,
    },
    {
      id: "routing",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{9}\b/g,
      validate: (m) => m === "011000015",
      context: /\b(routing|account)\b/i,
      contextWindow: 60,
    },
  ],
};

describe("scanText", () => {
  it("reports a clean match as high with correct offsets", () => {
    const text = "SSN 123-45-6789 here";
    const [m] = scanText(text, pack);
    expect(m!.scannerId).toBe("ssn");
    expect(m!.confidence).toBe("high");
    expect(text.slice(m!.start, m!.end)).toBe("123-45-6789");
  });

  it("offsets stay valid for every match in a dense document", () => {
    const text = "111-11-1111 222-22-2222 333-33-3333";
    const ms = scanText(text, pack);
    expect(ms).toHaveLength(3);
    for (const m of ms)
      expect(text.slice(m.start, m.end)).toMatch(/^\d{3}-\d{2}-\d{4}$/);
  });

  it("demotes to low when the context gate fails, and does NOT drop it", () => {
    const [m] = scanText("value 011000015 alone", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(m).toBeDefined();
    expect(m!.confidence).toBe("low");
  });

  it("promotes to high when context is present", () => {
    const [m] = scanText("routing 011000015", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(m!.confidence).toBe("high");
  });

  it("demotes to low when the VALIDATOR fails, and does NOT drop it", () => {
    // Spec §3.1: an earlier draft defined `low` as "fails only the context gate",
    // which left validator failures belonging to no bucket at all.
    const ms = scanText("routing 123456789", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(ms).toHaveLength(1);
    expect(ms[0]!.confidence).toBe("low");
  });

  it("never returns a match whose masked sample contains the raw value", () => {
    const text = "SSN 123-45-6789";
    for (const m of scanText(text, pack)) {
      expect(m.maskedSample).not.toContain("123-45-6789");
    }
  });
});

describe("maskValue", () => {
  it("preserves shape and first/last character", () => {
    expect(maskValue("123-45-6789")).toBe("1XXXXXXXXX9");
  });

  it("masks a two-character value entirely", () => {
    expect(maskValue("ab")).toBe("XX");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rag/core test -- pack/scan`
Expected: FAIL — `Cannot find module './scan.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/pack/scan.ts
import type { LoadedPack } from "./load.js";
import type { Disposition, ScannerKind } from "./schema.js";

export type Confidence = "high" | "low";

export interface ScanMatch {
  scannerId: string;
  kind: ScannerKind;
  disposition: Disposition;
  confidence: Confidence;
  /** Offsets into the INPUT text. Never mutated, so they stay valid. */
  start: number;
  end: number;
  /** Shape-preserving mask. The raw value is never carried on this object. */
  maskedSample: string;
}

/** Keep shape, drop the value: 123-45-6789 -> 1XXXXXXXXX9. */
export function maskValue(v: string): string {
  if (v.length <= 2) return "X".repeat(v.length);
  return v[0]! + "X".repeat(v.length - 2) + v[v.length - 1]!;
}

/**
 * Find every match of every scanner in the pack.
 *
 * **The confidence rule is total** (spec §3.1). A match that satisfies every gate
 * its scanner declares is `high`; a match that fails ANY gate is `low`. Nothing is
 * ever dropped — gates decide the label, never whether the finding exists. An
 * earlier draft defined `low` as "fails only the context gate", which left a
 * validator failure belonging to no bucket and silently discarded.
 *
 * Matching runs against the unmodified input, so `start`/`end` remain valid for
 * every match regardless of what a caller later does with the text.
 */
export function scanText(text: string, pack: LoadedPack): ScanMatch[] {
  const out: ScanMatch[] = [];

  for (const s of pack.scanners) {
    const re = new RegExp(
      s.re.source,
      s.re.flags.includes("g") ? s.re.flags : s.re.flags + "g",
    );
    for (const m of text.matchAll(re)) {
      const value = m[0];
      const start = m.index;
      let confidence: Confidence = "high";

      if (s.validate && !s.validate(value)) confidence = "low";

      if (confidence === "high" && s.context) {
        const window = text.slice(
          Math.max(0, start - s.contextWindow),
          start + value.length + s.contextWindow,
        );
        if (!s.context.test(window)) confidence = "low";
      }

      out.push({
        scannerId: s.id,
        kind: s.kind,
        disposition: s.disposition,
        confidence,
        start,
        end: start + value.length,
        maskedSample: maskValue(value),
      });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rag/core test -- pack/scan`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pack/scan.ts packages/core/src/pack/scan.test.ts
git commit -m "feat(pack): scan engine emitting every match with confidence and stable offsets"
```

---

### Task 5: Rewire `redactText` onto the engine

Behaviour-preserving. The 25 existing `content-safety.test.ts` tests are the specification here and must not be edited.

**Files:**

- Modify: `packages/core/src/content-safety.ts`
- Test: `packages/core/src/content-safety.test.ts` (existing — do **not** edit; add the new case below)

**Interfaces:**

- Consumes: `scanText`, `ScanMatch` (Task 4); `LoadedPack` (Task 3)
- Produces: `applyRedaction(text: string, matches: ScanMatch[], mask: (m: ScanMatch) => string): string`. `redactText` and `redactOrThrow` keep their existing signatures exactly.

- [ ] **Step 1: Write the failing test (append to the existing file)**

```ts
// append to packages/core/src/content-safety.test.ts
import { applyRedaction } from "./content-safety.js";
import type { ScanMatch } from "./pack/scan.js";

describe("applyRedaction", () => {
  it("replaces right-to-left so earlier offsets stay valid", () => {
    const text = "a 111-11-1111 b 222-22-2222 c";
    const matches: ScanMatch[] = [
      {
        scannerId: "ssn",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 2,
        end: 13,
        maskedSample: "1XXXXXXXXX1",
      },
      {
        scannerId: "ssn",
        kind: "identifying",
        disposition: "exclude",
        confidence: "high",
        start: 16,
        end: 27,
        maskedSample: "2XXXXXXXXX2",
      },
    ];
    expect(applyRedaction(text, matches, () => "[X]")).toBe("a [X] b [X] c");
  });

  it("ignores low-confidence matches", () => {
    const text = "a 111-11-1111 b";
    const matches: ScanMatch[] = [
      {
        scannerId: "ssn",
        kind: "identifying",
        disposition: "exclude",
        confidence: "low",
        start: 2,
        end: 13,
        maskedSample: "1XXXXXXXXX1",
      },
    ];
    expect(applyRedaction(text, matches, () => "[X]")).toBe(text);
  });
});
```

- [ ] **Step 2: Run the whole existing suite to confirm the baseline is green**

Run: `pnpm --filter @rag/core test -- content-safety`
Expected: the 25 existing tests PASS; the 2 new ones FAIL with `applyRedaction is not a function`

- [ ] **Step 3: Add `applyRedaction` and rewire `redactText`**

Replace the body of `redactText` (currently `packages/core/src/content-safety.ts:119`) and add `applyRedaction`. Keep `MASK`, `RedactionKind`, `RedactionFinding`, `RedactionResult`, `ContentSafetyError`, `redactOrThrow`, `isExcludedPath`, and `DEFAULT_EXCLUDED_PATH_FRAGMENTS` exactly as they are.

```ts
import { scanText, type ScanMatch } from "./pack/scan.js";
import type { LoadedPack } from "./pack/load.js";

/**
 * Apply replacements for HIGH-confidence matches only, right-to-left.
 *
 * Right-to-left matters: replacing left-to-right shifts every later offset by the
 * difference between the match length and the mask length, silently corrupting
 * subsequent replacements in a dense document.
 */
export function applyRedaction(
  text: string,
  matches: ScanMatch[],
  mask: (m: ScanMatch) => string,
): string {
  const high = matches
    .filter((m) => m.confidence === "high")
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of high)
    out = out.slice(0, m.start) + mask(m) + out.slice(m.end);
  return out;
}

/** Maps a pack scanner id onto the legacy RedactionKind for the mask table. */
function kindFor(scannerId: string): RedactionKind | undefined {
  return (["ssn", "ein", "routing", "card", "account"] as const).find(
    (k) => k === scannerId,
  );
}

export function redactText(input: string, pack: LoadedPack): RedactionResult {
  const matches = scanText(input, pack);
  const text = applyRedaction(input, matches, (m) => {
    const k = kindFor(m.scannerId);
    return k ? MASK[k] : `[REDACTED-${m.scannerId.toUpperCase()}]`;
  });

  const counts = new Map<RedactionKind, number>();
  for (const m of matches) {
    if (m.confidence !== "high") continue;
    const k = kindFor(m.scannerId);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const findings = [...counts.entries()].map(([kind, count]) => ({
    kind,
    count,
  }));
  return {
    text,
    findings,
    totalRedacted: findings.reduce((a, f) => a + f.count, 0),
  };
}
```

`redactText` now takes a second parameter. Update `redactOrThrow` to accept and forward it, and update the single call site in `packages/ingestion/src/pipeline.ts` (the `redactOrThrow(parsed.markdown)` call) to pass the loaded pack.

- [ ] **Step 4: Run the full core and ingestion suites**

Run: `pnpm --filter @rag/core test && pnpm --filter @rag/ingestion test`
Expected: PASS — all 25 original content-safety tests, the 2 new `applyRedaction` tests, and all 12 classify-document tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/content-safety.ts packages/core/src/content-safety.test.ts packages/ingestion/src/pipeline.ts
git commit -m "refactor(core): rewire redactText onto the pack scan engine"
```

---

### Task 6: Author `packs/cpa/pack.yaml` and prove equivalence

The pack must reproduce today's behaviour exactly. This task is the gate that says the migration lost nothing.

**Files:**

- Create: `packs/cpa/pack.yaml`
- Create: `packages/core/src/pack/cpa-pack.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: `loadPack` (Task 3), `scanText` (Task 4)
- Produces: `packs/cpa/pack.yaml` as the canonical pattern source; `export * from "./pack/schema.js"`, `"./pack/load.js"`, `"./pack/scan.js"` from `@rag/core`

- [ ] **Step 1: Write the failing equivalence test**

```ts
// packages/core/src/pack/cpa-pack.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadPack } from "./load.js";
import { scanText } from "./scan.js";

const pack = loadPack(join(__dirname, "../../../../packs/cpa"));

describe("cpa pack", () => {
  it("declares the four identifier scanners the redactor relied on", () => {
    expect(pack.scanners.map((s) => s.id).sort()).toEqual([
      "card",
      "ein",
      "routing",
      "ssn",
    ]);
  });

  it("matches a formatted SSN as high", () => {
    const [m] = scanText("SSN 123-45-6789", pack).filter(
      (x) => x.scannerId === "ssn",
    );
    expect(m!.confidence).toBe("high");
  });

  it("matches an EIN as high", () => {
    const [m] = scanText("EIN 12-3456789", pack).filter(
      (x) => x.scannerId === "ein",
    );
    expect(m!.confidence).toBe("high");
  });

  it("treats a Luhn-valid card as high", () => {
    const [m] = scanText("card 4111 1111 1111 1111", pack).filter(
      (x) => x.scannerId === "card",
    );
    expect(m!.confidence).toBe("high");
  });

  it("treats a Luhn-invalid card as low rather than dropping it", () => {
    const ms = scanText("card 4111 1111 1111 1112", pack).filter(
      (x) => x.scannerId === "card",
    );
    expect(ms).toHaveLength(1);
    expect(ms[0]!.confidence).toBe("low");
  });

  it("requires account vocabulary for a routing number", () => {
    const near = scanText("routing 011000015", pack).filter(
      (x) => x.scannerId === "routing",
    );
    const far = scanText("total 011000015", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(near[0]!.confidence).toBe("high");
    expect(far[0]!.confidence).toBe("low");
  });

  it("does NOT treat a bare 9-digit run as an SSN", () => {
    // The pattern is delimiter-anchored on purpose: bare runs in this corpus are
    // far more often amounts or IDs, and over-redaction destroys the SOPs.
    expect(
      scanText("total 123456789", pack).filter((x) => x.scannerId === "ssn"),
    ).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rag/core test -- cpa-pack`
Expected: FAIL — `pack.yaml not found`

- [ ] **Step 3: Author the pack**

```yaml
# packs/cpa/pack.yaml
# Pattern definitions for the CPA vertical. This file is DATA — the scan engine
# in @rag/core knows nothing about tax. Adding a pattern here does not require a
# code change; adding a new `validator` or `context` name does (see
# packages/core/src/pack/registry.ts).
pack:
  id: cpa
  version: 1.0.0
  requiresCore: "^1.0.0"

scanners:
  # 123-45-6789 — delimiter-anchored, so a form number cannot match, and a bare
  # 9-digit run is deliberately NOT an SSN.
  - id: ssn
    kind: identifying
    disposition: exclude
    pattern: '\b\d{3}-\d{2}-\d{4}\b'

  # 12-3456789
  - id: ein
    kind: identifying
    disposition: exclude
    pattern: '\b\d{2}-\d{7}\b'

  # 9-digit runs only when the ABA checksum passes AND routing vocabulary is near.
  - id: routing
    kind: identifying
    disposition: exclude
    pattern: '\b\d{9}\b'
    validator: aba
    context: account-vocab
    contextWindow: 60

  # 13-19 digits, Luhn-valid, optionally space/dash grouped.
  - id: card
    kind: identifying
    disposition: exclude
    pattern: '\b(?:\d[ -]?){12,18}\d\b'
    validator: luhn
```

- [ ] **Step 4: Export the pack surface**

Add to `packages/core/src/index.ts`, after the existing `export * from "./content-safety.js";`:

```ts
export * from "./pack/schema.js";
export * from "./pack/load.js";
export * from "./pack/scan.js";
```

- [ ] **Step 5: Run the full workspace suite**

Run: `pnpm -r build && pnpm -r --filter '!@rag/e2e' run test`
Expected: PASS everywhere, including the 25 unchanged `content-safety` tests

- [ ] **Step 6: Commit**

```bash
git add packs/cpa/pack.yaml packages/core/src/pack/cpa-pack.test.ts packages/core/src/index.ts
git commit -m "feat(pack): author the cpa pack and export the pack surface"
```

---

## What this plan deliberately does not do

- **Does not touch `tri-scanner.ts`.** It serves the generation-time egress gate, whose `identifying`/`contextual` split is already correct and whose 3 open exemption items are tracked separately in `docs/superpowers/plans/2026-08-31-tri-identifying-pattern-exemptions.md`. Folding it in would put two behaviour changes in one slice.
- **Does not add `classification.yaml`, `prompt.md`, or the pack conformance suite.** Those are the rest of the pack format, not the `scanners:` slice.
- **Does not change disposition behaviour.** `classify-document.ts` keeps its own `CLASS_D_IDENTIFIERS` for now; wiring disposition to the pack is a follow-on once discovery exists to validate it.
- **Does not build discovery.** That is plan 2, and it consumes `scanText()` as delivered here.

## Self-review

**Spec coverage.** §3 pack scanner slice → Tasks 1–3, 6. §3.1 total confidence rule → Task 4 (with the validator-failure case tested explicitly). §3.4 registered names → Task 2. §3.6 fail-closed compat → Task 3. Shape-preserving masks (D2) → Task 4 `maskValue`. §3.2 "patterns move out of `tri-scanner.ts` and `content-safety.ts`" → partially: `content-safety.ts` is migrated in Task 5, `tri-scanner.ts` is explicitly deferred above, since it belongs to the egress gate rather than to ingest redaction.

**Placeholders.** None. Every code step carries the actual code; every test step carries the actual assertions.

**Type consistency.** `ScanMatch` is defined in Task 4 and consumed with the same field names in Tasks 5 and 6. `LoadedPack`/`CompiledScanner` are defined in Task 3 and consumed unchanged in Task 4. `ScannerKind` and `Disposition` originate in Task 1 and are re-used, not redefined. `redactText`'s new second parameter is introduced in Task 5 and its one call site is named there.

**Known follow-on, deliberately left to plan 2:** `ScanMatch` carries `start`/`end` into the parsed markdown. The spec flags that mapping an offset back to a `ParsedTable.sheetName` is undesigned. Discovery needs it; redaction does not, so it does not block this slice.
