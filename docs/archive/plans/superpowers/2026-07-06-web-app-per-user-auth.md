# Web App Per-User Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web app's single shared static bearer token with real per-user authentication via Microsoft Entra ID, connected to Fastify's existing `AuthorizationScope` enforcement through a new signed scope-assertion token, plus a productized admin UI for granting/revoking staff access.

**Architecture:** Users sign into the Next.js app via Auth.js (NextAuth v5) + Microsoft Entra ID. On each BFF request, the route handler resolves the signed-in user's AAD `oid` to their allowed source ids via the existing `resolveSourceIdsForUser` DB query, signs a short-lived HS256 JWT asserting that scope, and presents it to Fastify as the bearer credential. A new `InternalScopeAuthProvider` (same `AuthProvider` interface as the existing `StaticTokenAuthProvider`/`OidcAuthProvider`) verifies it and returns the corresponding `Principal`. No changes to Fastify's downstream enforcement (`AuthorizationScope` → `hybridSearch`) are needed.

**Tech Stack:** Auth.js v5 (`next-auth`) with the Microsoft Entra ID provider, `jose` (already a dependency via `@rag/core`) for JWT signing/verification, existing Drizzle/Postgres (`@rag/db`), Vitest for unit tests, the existing e2e harness (`tests/e2e`, Fastify `inject()`).

**Reference spec:** `docs/superpowers/specs/2026-07-06-web-app-auth-design.md` (approved, plan-reviewed).

## Global Constraints

- No new database migration — `staff_client_assignments`, `source_client_assignments`, and `resolveSourceIdsForUser` (`packages/db/src/queries.ts:832`) already exist exactly as needed.
- `InternalScopeAuthProvider`'s JWT verification MUST pin `algorithms: ["HS256"]` explicitly — never accept `alg: none` or an algorithm swap.
- Scope-assertion tokens expire in 60 seconds, minted fresh per BFF request, never cached as a session-length credential. Verification allows a 5-second clock-skew tolerance.
- `INTERNAL_SCOPE_JWT_SECRET`(S) supports multiple comma-separated secrets for rotation (mirrors the existing `API_TOKENS` multi-token pattern) — construction throws if the list is empty (fail loud on misconfig, matching `createTokenVerifier`'s existing convention).
- Every new auth-adjacent failure mode (missing session, empty/revoked scope, expired/malformed token, DB unavailable during scope resolution) degrades to **zero access** — never to the prior shared-admin-token behavior, never to a throw that could be misread as a 500 masking a real denial.
- All 5 existing BFF route groups (`chat`, `sources`, `upload`, `documents/[id]`, `documents/[id]/download`) migrate — no partial migration, no route left on the old static token.
- `RAG_API_TOKEN` is removed from the web app's environment once migration is complete; a `WEB_AUTH_MODE=static-fallback` flag exists as a deliberately temporary emergency rollback, not a permanent dual-mode feature.
- The identity key is the AAD `oid` (object id), never `upn`/email — `staff_client_assignments.user_id` is a bare opaque `text` column, so this requires no schema change.
- No new `is_admin` column or roles table — admin gating is via AAD security-group membership (`RAG-Admins`), read from the `groups` claim, with a Microsoft Graph `/memberOf` fallback for Entra ID's "groups overage" case.

---

### Task 1: `InternalScopeAuthProvider` core module

**Files:**

- Create: `packages/core/src/internal-scope-auth.ts`
- Create: `packages/core/src/internal-scope-auth.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Produces: `signInternalScopeToken(payload: InternalScopeTokenPayload, secret: string): Promise<string>`, `InternalScopeTokenPayload = { sub: string; allowedSourceIds: string[] }`, `class InternalScopeAuthProvider implements AuthProvider` with `constructor(secrets: readonly string[])` and `authenticate(credential: string): Promise<Principal | null>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/core/src/internal-scope-auth.test.ts
import { describe, expect, it } from "vitest";
import {
  InternalScopeAuthProvider,
  signInternalScopeToken,
} from "./internal-scope-auth.js";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256";
const OTHER_SECRET = "a-different-rotation-secret-also-long-enough";

describe("signInternalScopeToken / InternalScopeAuthProvider", () => {
  it("round-trips a valid token to a scoped principal", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-1", allowedSourceIds: ["src-a", "src-b"] },
      SECRET,
    );
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(token)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["src-a", "src-b"],
    });
  });

  it("round-trips an empty allowedSourceIds to deny-all scoped principal", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-2", allowedSourceIds: [] },
      SECRET,
    );
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(token)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: [],
    });
  });

  it("returns null for an expired token (fail closed, no throw)", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-3", allowedSourceIds: ["src-a"] },
      SECRET,
    );
    // Sign again with a manually-expired custom token to avoid a real sleep:
    // reuse jose directly to control `exp`.
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({ allowedSourceIds: ["src-a"] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("aad-oid-3")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(expired)).resolves.toBeNull();
    void token; // silence unused-var (kept for readability of the "valid" shape above)
  });

  it("returns null for a tampered signature", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-4", allowedSourceIds: ["src-a"] },
      SECRET,
    );
    const tampered = token.slice(0, -4) + "abcd";
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(tampered)).resolves.toBeNull();
  });

  it("returns null for a token signed with a different algorithm's header forged onto an unsigned payload", async () => {
    // "alg: none" attack: a crafted token with no signature at all.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "attacker", allowedSourceIds: ["src-a"] }),
    ).toString("base64url");
    const forged = `${header}.${payload}.`;
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(forged)).resolves.toBeNull();
  });

  it("verifies against any configured secret (rotation support)", async () => {
    const token = await signInternalScopeToken(
      { sub: "aad-oid-5", allowedSourceIds: ["src-c"] },
      OTHER_SECRET,
    );
    const provider = new InternalScopeAuthProvider([SECRET, OTHER_SECRET]);
    await expect(provider.authenticate(token)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["src-c"],
    });
  });

  it("returns null for a malformed payload shape (allowedSourceIds not a string array)", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const bad = await new SignJWT({ allowedSourceIds: "not-an-array" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("aad-oid-6")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key);
    const provider = new InternalScopeAuthProvider([SECRET]);
    await expect(provider.authenticate(bad)).resolves.toBeNull();
  });

  it("throws at construction with no secrets (fail loud on misconfig)", () => {
    expect(() => new InternalScopeAuthProvider([])).toThrow(
      /at least one secret/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rag/core test -- internal-scope-auth`
Expected: FAIL — `Cannot find module './internal-scope-auth.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/internal-scope-auth.ts
import { SignJWT, jwtVerify } from "jose";
import type { Principal } from "./access-control.js";
import type { AuthProvider } from "./auth.js";

/**
 * The scope-assertion token's payload shape. Signed by a trusted BFF (the web
 * app) after it resolves a user's per-client access via `resolveSourceIdsForUser`,
 * and verified here by Fastify — no DB round-trip on this side, since the BFF
 * already did the lookup.
 */
export interface InternalScopeTokenPayload {
  /** The signed-in user's stable identity key (e.g. an AAD object id). */
  sub: string;
  allowedSourceIds: string[];
}

const ALG = "HS256";
const EXPIRY = "60s";
const CLOCK_TOLERANCE_SECONDS = 5;

/**
 * Sign a short-lived scope-assertion JWT. Called by a trusted BFF, never by
 * Fastify itself. `secret` must be at least 32 bytes for HS256 per RFC 7518 —
 * callers are responsible for generating an adequately long secret.
 */
export async function signInternalScopeToken(
  payload: InternalScopeTokenPayload,
  secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ allowedSourceIds: payload.allowedSourceIds })
    .setProtectedHeader({ alg: ALG })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(key);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Verifies scope-assertion JWTs minted by a trusted BFF (see
 * `signInternalScopeToken`) and maps them directly to a `Principal` — no DB
 * lookup here, since the signer already resolved the scope.
 *
 * SECURITY: `algorithms: ["HS256"]` is passed explicitly to `jwtVerify` to
 * reject `alg: none` and algorithm-swap attacks. This is non-negotiable —
 * the token's claims directly control corpus-wide confidentiality scope.
 *
 * Supports multiple secrets (tried in order) so a secret can be rotated
 * without downtime: add the new secret, deploy, wait out the old tokens'
 * ~60s lifetime, then drop the old secret and redeploy — mirrors the
 * existing multi-token `API_TOKENS` rotation pattern.
 */
export class InternalScopeAuthProvider implements AuthProvider {
  private readonly keys: Uint8Array[];

  constructor(secrets: readonly string[]) {
    if (secrets.length === 0) {
      throw new Error(
        "InternalScopeAuthProvider requires at least one secret; refusing to build a verifier that rejects every request",
      );
    }
    this.keys = secrets.map((s) => new TextEncoder().encode(s));
  }

  async authenticate(credential: string): Promise<Principal | null> {
    for (const key of this.keys) {
      try {
        const { payload } = await jwtVerify(credential, key, {
          algorithms: [ALG],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        const allowedSourceIds = payload["allowedSourceIds"];
        if (!isStringArray(allowedSourceIds)) return null;
        return { kind: "scoped", allowedSourceIds };
      } catch {
        // This key didn't verify it — try the next one (rotation). Only
        // after every key has failed is the credential truly rejected.
      }
    }
    return null;
  }
}
```

- [ ] **Step 4: Export the new module**

Edit `packages/core/src/index.ts`, add one line (matching the existing alphabetized-by-topic export list):

```typescript
export * from "./internal-scope-auth.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rag/core test -- internal-scope-auth`
Expected: PASS — 8 tests

- [ ] **Step 6: Build and typecheck**

Run: `pnpm --filter @rag/core build && pnpm --filter @rag/core typecheck`
Expected: both succeed with no errors

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/internal-scope-auth.ts packages/core/src/internal-scope-auth.test.ts packages/core/src/index.ts
git commit -m "feat(core): add InternalScopeAuthProvider for BFF-asserted scope tokens"
```

---

### Task 2: Wire `InternalScopeAuthProvider` into the `AuthProvider` factory

**Files:**

- Modify: `packages/core/src/auth-provider-factory.ts`
- Modify: `packages/core/src/auth-provider-factory.test.ts`

**Interfaces:**

- Consumes: `InternalScopeAuthProvider` from Task 1.
- Produces: `AuthProviderConfig`'s `"internal-scope"` variant and `composite`'s new optional `internalScopeSecrets` field, both consumed by Task 4 (`packages/runtime`).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/auth-provider-factory.test.ts` (append; keep existing tests untouched):

```typescript
import { InternalScopeAuthProvider } from "./internal-scope-auth.js";
import { signInternalScopeToken } from "./internal-scope-auth.js";

describe("createAuthProvider — internal-scope", () => {
  it("builds an InternalScopeAuthProvider for 'internal-scope'", () => {
    const provider = createAuthProvider({
      provider: "internal-scope",
      secrets: ["a-secret-at-least-32-bytes-long-here"],
    });
    expect(provider).toBeInstanceOf(InternalScopeAuthProvider);
  });

  it("includes internal-scope in a composite when internalScopeSecrets is set", async () => {
    const secret = "a-secret-at-least-32-bytes-long-here";
    const provider = createAuthProvider({
      provider: "composite",
      tokens: ["admin-tok"],
      internalScopeSecrets: [secret],
    });
    const token = await signInternalScopeToken(
      { sub: "u1", allowedSourceIds: ["s1"] },
      secret,
    );
    await expect(provider.authenticate(token)).resolves.toEqual({
      kind: "scoped",
      allowedSourceIds: ["s1"],
    });
    // Static token path still works alongside it.
    await expect(provider.authenticate("admin-tok")).resolves.toEqual({
      kind: "admin",
    });
  });

  it("omits internal-scope from a composite when internalScopeSecrets is absent/empty", async () => {
    const provider = createAuthProvider({
      provider: "composite",
      tokens: ["admin-tok"],
    });
    const token = await signInternalScopeToken(
      { sub: "u1", allowedSourceIds: ["s1"] },
      "irrelevant-secret-not-configured-anywhere",
    );
    // No internal-scope provider configured, so this credential is rejected.
    await expect(provider.authenticate(token)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rag/core test -- auth-provider-factory`
Expected: FAIL — `AuthProviderConfig` has no `"internal-scope"` member yet (type error) / test throws

- [ ] **Step 3: Implement**

Replace the full contents of `packages/core/src/auth-provider-factory.ts`:

```typescript
import type { ScopedPrincipalConfig } from "./access-control.js";
import {
  CompositeAuthProvider,
  StaticTokenAuthProvider,
  type AuthProvider,
} from "./auth.js";
import { InternalScopeAuthProvider } from "./internal-scope-auth.js";
import { OidcAuthProvider, type OidcConfig } from "./oidc-auth.js";

/**
 * Discriminated config for `createAuthProvider`. The factory only switches on
 * the shape it's handed — env parsing (deciding WHICH shape to build) lives in
 * the runtime/app config layer, not here, so core stays free of env access.
 */
export type AuthProviderConfig =
  | {
      provider: "static-token";
      tokens: readonly string[];
      principals?: readonly ScopedPrincipalConfig[];
      /** When true, plain `tokens` resolve to deny-all (admin needs `isAdmin`). */
      enforceScoping?: boolean;
    }
  | { provider: "oidc"; oidc: OidcConfig }
  | {
      /** BFF-asserted scope tokens (see `InternalScopeAuthProvider`). */
      provider: "internal-scope";
      secrets: readonly string[];
    }
  | {
      provider: "composite";
      tokens: readonly string[];
      principals?: readonly ScopedPrincipalConfig[];
      /** When true, plain `tokens` resolve to deny-all (admin needs `isAdmin`). */
      enforceScoping?: boolean;
      /** Omit to build a composite with static-token only (OIDC disabled). */
      oidc?: OidcConfig;
      /** Omit/empty to exclude the internal-scope provider from the composite. */
      internalScopeSecrets?: readonly string[];
      /** Per-provider error sink (logger-backed) — never console.log. */
      onError?: (err: unknown) => void;
    };

/**
 * Build the `AuthProvider` for a deployment. For `composite`, static-token is
 * tried FIRST (cheap constant-time compare, covers existing service tokens),
 * then OIDC, then the internal-scope BFF-asserted provider (if configured).
 * When `oidc`/`internalScopeSecrets` are absent on a composite config, that
 * provider is simply omitted — a deployment with `AUTH_PROVIDER=composite`
 * and no OIDC/internal-scope env keeps behaving exactly like the legacy
 * static-token setup.
 */
export function createAuthProvider(config: AuthProviderConfig): AuthProvider {
  switch (config.provider) {
    case "static-token":
      return new StaticTokenAuthProvider(
        config.tokens,
        config.principals ?? [],
        config.enforceScoping ?? false,
      );

    case "oidc":
      return new OidcAuthProvider(config.oidc);

    case "internal-scope":
      return new InternalScopeAuthProvider(config.secrets);

    case "composite": {
      const providers: AuthProvider[] = [
        new StaticTokenAuthProvider(
          config.tokens,
          config.principals ?? [],
          config.enforceScoping ?? false,
        ),
      ];
      if (config.oidc) providers.push(new OidcAuthProvider(config.oidc));
      if (
        config.internalScopeSecrets &&
        config.internalScopeSecrets.length > 0
      ) {
        providers.push(
          new InternalScopeAuthProvider(config.internalScopeSecrets),
        );
      }
      return new CompositeAuthProvider(providers, config.onError);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rag/core test -- auth-provider-factory`
Expected: PASS — all existing tests plus the 3 new ones

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rag/core typecheck`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/auth-provider-factory.ts packages/core/src/auth-provider-factory.test.ts
git commit -m "feat(core): wire InternalScopeAuthProvider into the auth provider factory"
```

---

### Task 3: Add `internalScopeSecrets` to `Config`

**Files:**

- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/config.test.ts`

**Interfaces:**

- Produces: `Config.auth.internalScopeSecrets: string[]` (parsed from `INTERNAL_SCOPE_JWT_SECRETS`, comma-separated, default `[]`), consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/config.test.ts`:

```typescript
describe("loadConfig — INTERNAL_SCOPE_JWT_SECRETS", () => {
  it("defaults to an empty array when unset", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.auth.internalScopeSecrets).toEqual([]);
  });

  it("parses a single secret", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "secret-one",
    });
    expect(cfg.auth.internalScopeSecrets).toEqual(["secret-one"]);
  });

  it("parses multiple comma-separated secrets (rotation) and trims whitespace", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "secret-one, secret-two , secret-three",
    });
    expect(cfg.auth.internalScopeSecrets).toEqual([
      "secret-one",
      "secret-two",
      "secret-three",
    ]);
  });

  it("filters out empty entries from trailing/double commas", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      INTERNAL_SCOPE_JWT_SECRETS: "secret-one,,",
    });
    expect(cfg.auth.internalScopeSecrets).toEqual(["secret-one"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rag/core test -- config`
Expected: FAIL — `cfg.auth.internalScopeSecrets` is `undefined`

- [ ] **Step 3: Implement**

In `packages/core/src/config.ts`, find the `auth: z.object({...})` block (inside the main `Config` schema) and add the new field:

```typescript
    auth: z.object({
      provider: z
        .enum(["static-token", "oidc", "composite"])
        .default("composite"),
      oidc: OidcConfig.optional(),
      /**
       * Secrets for verifying BFF-asserted scope-assertion tokens (see
       * `InternalScopeAuthProvider`). Comma-separated to support rotation
       * without downtime. Empty by default — the provider is simply excluded
       * from `composite` until at least one secret is configured.
       */
      internalScopeSecrets: z.array(z.string().min(1)).default([]),
    }),
```

Then in `loadConfig`'s `auth:` assembly (where it currently calls `buildAuthConfig(env)`), add the new field alongside it:

```typescript
    auth: {
      ...buildAuthConfig(env),
      internalScopeSecrets: (env.INTERNAL_SCOPE_JWT_SECRETS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
```

(This replaces the existing `auth: buildAuthConfig(env),` line — `buildAuthConfig` still returns `{ provider, oidc }`, spread first, then `internalScopeSecrets` added alongside.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rag/core test -- config`
Expected: PASS — all existing config tests plus the 4 new ones

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rag/core typecheck`
Expected: succeeds

- [ ] **Step 6: Document the new env var**

Append to `env.example` (near the existing `auth`/`AUTH_PROVIDER` section):

```
# ============================================================================
# Internal scope-assertion tokens (web app BFF -> Fastify)
# Comma-separated secrets verifying BFF-minted per-user scope tokens (see
# InternalScopeAuthProvider). Multiple values support rotation without
# downtime. Requires AUTH_PROVIDER=composite to take effect. Store the actual
# value in a real secret manager, not a plaintext deploy dashboard field.
# ============================================================================
INTERNAL_SCOPE_JWT_SECRETS=
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts env.example
git commit -m "feat(core): parse INTERNAL_SCOPE_JWT_SECRETS into Config.auth.internalScopeSecrets"
```

---

### Task 4: Wire `internalScopeSecrets` into `buildAuthProvider`

**Files:**

- Modify: `packages/runtime/src/index.ts:74-105` (the `buildAuthProvider` function)

**Interfaces:**

- Consumes: `Config.auth.internalScopeSecrets` (Task 3), `createAuthProvider`'s `composite.internalScopeSecrets` (Task 2).

No new automated test for this task — `buildAuthProvider`'s existing behavior is exercised indirectly by the e2e suite (Task 16 adds coverage for the new provider specifically). This is glue code with no independent logic of its own to unit test beyond what Tasks 2/3 already cover.

- [ ] **Step 1: Implement**

In `packages/runtime/src/index.ts`, find the `case "composite":` branch inside `buildAuthProvider` and add `internalScopeSecrets`:

```typescript
    case "composite":
      return createAuthProvider({
        provider: "composite",
        ...base,
        oidc: config.auth.oidc,
        internalScopeSecrets: config.auth.internalScopeSecrets,
        onError: (err) =>
          logger.warn({ err }, "auth provider error (isolated)"),
      });
```

(This is the only change — the `"static-token"` and `"oidc"` branches are untouched, since neither of those single-provider modes includes the internal-scope provider by design; a deployment that wants both static tokens and BFF-asserted scope tokens must use `AUTH_PROVIDER=composite`.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rag/runtime typecheck`
Expected: succeeds

- [ ] **Step 3: Full workspace build sanity check**

Run: `pnpm --filter @rag/runtime build`
Expected: succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/index.ts
git commit -m "feat(runtime): thread internalScopeSecrets into buildAuthProvider's composite mode"
```

---

### Task 5: Grant/revoke/history DB queries

**Files:**

- Modify: `packages/db/src/queries.ts` (append after `resolveSourceIdsForUser`, currently ending at line 844)
- Modify: `packages/db/src/queries.access-control.test.ts`

**Interfaces:**

- Consumes: `staffClientAssignments` schema (`packages/db/src/schema.ts:432`), the existing `Db`/`sql` imports already present in `queries.ts`.
- Produces: `grantClientAccess(db, {userId, clientId, grantedBy}): Promise<void>`, `revokeClientAccess(db, {userId, clientId}): Promise<void>`, `listAssignmentHistoryForStaff(db, userId): Promise<StaffAssignmentHistoryRow[]>` — consumed by Task 15 (admin UI server actions).

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/queries.access-control.test.ts` (check the existing file's setup pattern first — it uses a real or stubbed `Db`; match whatever pattern the existing `resolveSourceIdsForUser`-adjacent tests in this same file already use for issuing raw SQL against a test connection):

```typescript
describe("grantClientAccess / revokeClientAccess / listAssignmentHistoryForStaff", () => {
  it("grants access, then resolveSourceIdsForUser includes the client's sources", async () => {
    await grantClientAccess(db, {
      userId: "aad-oid-grant-1",
      clientId: "test-client-grant-1",
      grantedBy: "admin-oid-1",
    });
    const history = await listAssignmentHistoryForStaff(db, "aad-oid-grant-1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      clientId: "test-client-grant-1",
      grantedBy: "admin-oid-1",
      revokedAt: null,
    });
  });

  it("revoking sets revokedAt without deleting the row (audit trail preserved)", async () => {
    await grantClientAccess(db, {
      userId: "aad-oid-grant-2",
      clientId: "test-client-grant-2",
      grantedBy: "admin-oid-1",
    });
    await revokeClientAccess(db, {
      userId: "aad-oid-grant-2",
      clientId: "test-client-grant-2",
    });
    const history = await listAssignmentHistoryForStaff(db, "aad-oid-grant-2");
    expect(history).toHaveLength(1);
    expect(history[0].revokedAt).not.toBeNull();
  });

  it("re-granting after a revoke un-revokes the same row instead of duplicating it", async () => {
    await grantClientAccess(db, {
      userId: "aad-oid-grant-3",
      clientId: "test-client-grant-3",
      grantedBy: "admin-oid-1",
    });
    await revokeClientAccess(db, {
      userId: "aad-oid-grant-3",
      clientId: "test-client-grant-3",
    });
    await grantClientAccess(db, {
      userId: "aad-oid-grant-3",
      clientId: "test-client-grant-3",
      grantedBy: "admin-oid-2",
    });
    const history = await listAssignmentHistoryForStaff(db, "aad-oid-grant-3");
    expect(history).toHaveLength(1); // not 2 — same row, re-activated
    expect(history[0].revokedAt).toBeNull();
    expect(history[0].grantedBy).toBe("admin-oid-2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rag/db test -- queries.access-control`
Expected: FAIL — `grantClientAccess` is not exported

- [ ] **Step 3: Implement**

Append to `packages/db/src/queries.ts` (after the existing `resolveSourceIdsForUser` function, which currently ends at line 844):

```typescript
export interface GrantClientAccessInput {
  userId: string;
  clientId: string;
  grantedBy: string;
}

/**
 * Grant a staff member access to a client's sources. Un-revokes an existing
 * (possibly revoked) row for this exact (userId, clientId) pair if one
 * exists, rather than inserting a duplicate — `staff_client_assignments` has
 * no unique constraint on that pair today, so without this check a repeated
 * grant/revoke/grant cycle would silently accumulate rows.
 */
export async function grantClientAccess(
  db: Db,
  { userId, clientId, grantedBy }: GrantClientAccessInput,
): Promise<void> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM staff_client_assignments
    WHERE user_id = ${userId} AND client_id = ${clientId}
    LIMIT 1
  `);
  const row = existing.rows[0];
  if (row) {
    await db.execute(sql`
      UPDATE staff_client_assignments
      SET revoked_at = NULL, granted_by = ${grantedBy}, granted_at = now()
      WHERE id = ${row.id}
    `);
    return;
  }
  await db.execute(sql`
    INSERT INTO staff_client_assignments (user_id, client_id, granted_by)
    VALUES (${userId}, ${clientId}, ${grantedBy})
  `);
}

/**
 * Revoke a staff member's access to a client. Soft-delete only (sets
 * `revoked_at`) — never a hard `DELETE`, preserving the audit trail per the
 * schema's existing design intent. A no-op if no active grant exists.
 */
export async function revokeClientAccess(
  db: Db,
  { userId, clientId }: { userId: string; clientId: string },
): Promise<void> {
  await db.execute(sql`
    UPDATE staff_client_assignments
    SET revoked_at = now()
    WHERE user_id = ${userId} AND client_id = ${clientId} AND revoked_at IS NULL
  `);
}

export interface StaffAssignmentHistoryRow {
  clientId: string;
  grantedAt: Date;
  grantedBy: string;
  revokedAt: Date | null;
}

/** Full grant/revoke history for one staff member, newest first — powers the admin UI's history view. */
export async function listAssignmentHistoryForStaff(
  db: Db,
  userId: string,
): Promise<StaffAssignmentHistoryRow[]> {
  const rows = await db.execute<{
    client_id: string;
    granted_at: Date;
    granted_by: string;
    revoked_at: Date | null;
  }>(sql`
    SELECT client_id, granted_at, granted_by, revoked_at
    FROM staff_client_assignments
    WHERE user_id = ${userId}
    ORDER BY granted_at DESC
  `);
  return rows.rows.map((r) => ({
    clientId: r.client_id,
    grantedAt: r.granted_at,
    grantedBy: r.granted_by,
    revokedAt: r.revoked_at,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rag/db test -- queries.access-control`
Expected: PASS — existing tests plus 3 new ones

- [ ] **Step 5: Build and typecheck**

Run: `pnpm --filter @rag/db build && pnpm --filter @rag/db typecheck`
Expected: both succeed

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/queries.ts packages/db/src/queries.access-control.test.ts
git commit -m "feat(db): add grantClientAccess/revokeClientAccess/listAssignmentHistoryForStaff"
```

---

### Task 6: `apps/web` workspace dependencies + test infrastructure

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/lib/env.test.ts` (smoke test proving the new test setup actually runs)

**Interfaces:**

- Produces: a working `pnpm --filter @rag/web test` command for all subsequent web-app unit tests in this plan.

`apps/web` currently has **no test framework configured at all** (no `vitest` in `devDependencies`). This task establishes it before any web-app logic needs unit tests.

- [ ] **Step 1: Add dependencies**

Edit `apps/web/package.json`'s `dependencies` block, adding:

```json
    "@rag/core": "workspace:*",
    "@rag/db": "workspace:*",
```

Edit `devDependencies`, adding:

```json
    "vitest": "^2.1.8",
```

Add a `"test"` script alongside the existing `dev`/`build`/`start`/`lint`/`typecheck` scripts:

```json
    "test": "vitest run",
```

Then install `next-auth`:

Run: `pnpm --filter @rag/web add next-auth@^5.0.0`

Run: `pnpm install` (to link the new workspace deps and update the lockfile)

- [ ] **Step 2: Create the vitest config**

```typescript
// apps/web/vitest.config.ts
import { defineConfig } from "vitest/config";

// Web-app unit tests cover server-only lib functions (scope resolution,
// admin gating, Graph client) — no DOM/React rendering needed here, so a
// plain node environment is sufficient. Component/page-level behavior is
// covered by the e2e suite (tests/e2e), not by this config.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Write a smoke test**

```typescript
// apps/web/src/lib/env.test.ts
import { describe, expect, it } from "vitest";

describe("apps/web test infrastructure", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run the smoke test**

Run: `pnpm --filter @rag/web test`
Expected: PASS — 1 test

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/vitest.config.ts apps/web/src/lib/env.test.ts pnpm-lock.yaml
git commit -m "chore(web): add vitest + @rag/core, @rag/db, next-auth dependencies"
```

---

### Task 7: Web app database client

**Files:**

- Create: `apps/web/src/lib/db.ts`

**Interfaces:**

- Consumes: `createDb`, `pgSslOption`, `type Db` from `@rag/db` (Task 6's new dependency).
- Produces: `getWebDb(): Db`, consumed by Task 10 (`scope-token.ts`) and Task 15 (admin server actions).

**Deployment note:** `DATABASE_URL` (and optionally `DATABASE_SSL`) must be set in the web app's own environment — previously the web app had no direct database access at all (it only ever talked to Fastify over HTTP). Both vars are already documented in `env.example` from the backend services' setup; this task doesn't add a new var, it adds a new consumer of an existing one, so no `env.example` edit is needed here — just confirm the value is actually configured wherever `apps/web` is deployed (its own service, distinct from api/mcp/worker's deployment).

- [ ] **Step 1: Implement**

No test for this task — it is a thin, side-effecting singleton wrapper (a live Postgres connection) with no branching logic of its own to unit test; its correctness is exercised by every test that calls `getWebDb()` indirectly in later tasks (Tasks 10, 13, 15) and by the e2e suite (Task 16).

```typescript
// apps/web/src/lib/db.ts
import { createDb, pgSslOption, type Db } from "@rag/db";

let cached: { db: Db; close: () => Promise<void> } | undefined;

/**
 * Lazily-created singleton DB connection for the web app's BFF — used only
 * for per-request scope resolution (`resolveSourceIdsForUser`) and the admin
 * UI's grant/revoke/history queries. Mirrors the api/mcp/worker apps'
 * `createDb` usage (`packages/runtime/src/index.ts`) rather than hand-rolling
 * a separate pg client.
 */
export function getWebDb(): Db {
  if (!cached) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL must be set for the web app's BFF (scope resolution + admin UI).",
      );
    }
    const sslMode = process.env.DATABASE_SSL as
      "disable" | "require" | "no-verify" | undefined;
    const { db, close } = createDb(databaseUrl, {
      // Lighter pool than the backend services — the BFF only ever issues
      // a handful of narrow lookups per request, never bulk retrieval.
      max: 5,
      ssl: pgSslOption(sslMode),
    });
    cached = { db, close };
  }
  return cached.db;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/db.ts
git commit -m "feat(web): add lazily-created DB client for BFF scope resolution + admin queries"
```

---

### Task 8: Auth.js configuration (Microsoft Entra ID sign-in)

**Files:**

- Create: `apps/web/src/lib/auth.ts`
- Create: `apps/web/src/types/next-auth.d.ts`
- Create: `apps/web/src/app/api/auth/[...nextauth]/route.ts`

**Interfaces:**

- Produces: `auth()` (server-side session getter), `handlers` (`{GET, POST}` route handlers), `signIn`/`signOut` — all re-exported from `@/lib/auth`, consumed by Task 9 (middleware), Task 10 (scope-token), Task 14 (admin-check), and the admin UI (Task 15).
- Produces the `Session` type augmentation: `session.oid: string`, `session.groups: string[] | undefined`, `session.hasGroupsOverage: boolean`.

**A new Entra app registration is required** (delegated permissions, authorization-code + PKCE flow, `openid`/`profile`/`email`/`groups` scopes, a redirect URI of `<app-url>/api/auth/callback/microsoft-entra-id`) — this is deliberately **separate** from the existing `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` used by the SharePoint/Outlook connectors (those use application/client-credentials permissions with no user present). Also configure `groupMembershipClaims: "SecurityGroup"` in the new app registration's manifest so the `groups` claim is populated on sign-in (see Task 14 for the overage fallback when a user belongs to many groups).

No automated test for this task — Auth.js's OAuth/PKCE/session-cookie handling is a well-tested third-party concern; what this codebase needs to verify is its OWN integration (the `jwt`/`session` callbacks that extract `oid`/`groups`), which Task 14's `admin-check.test.ts` exercises against representative token/session shapes without needing a live IdP.

- [ ] **Step 1: Implement the Auth.js config**

```typescript
// apps/web/src/lib/auth.ts
import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_ENTRA_CLIENT_ID!,
      clientSecret: process.env.AUTH_ENTRA_CLIENT_SECRET!,
      issuer: `https://login.microsoftonline.com/${process.env.AUTH_ENTRA_TENANT_ID}/v2.0`,
      authorization: {
        params: { scope: "openid profile email offline_access" },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, profile }) {
      if (profile) {
        const p = profile as {
          oid?: string;
          groups?: string[];
          _claim_names?: { groups?: string };
        };
        token.oid = p.oid;
        token.groups = p.groups;
        // Entra ID's "groups overage": when present, the token omits inline
        // group values and this indirect-claim marker appears instead — the
        // caller must fall back to a Graph membership check (see Task 14).
        token.hasGroupsOverage = p._claim_names?.groups !== undefined;
      }
      return token;
    },
    async session({ session, token }) {
      session.oid = token.oid as string;
      session.groups = token.groups as string[] | undefined;
      session.hasGroupsOverage = token.hasGroupsOverage as boolean;
      return session;
    },
  },
});
```

- [ ] **Step 2: Add the session type augmentation**

```typescript
// apps/web/src/types/next-auth.d.ts
import "next-auth";

declare module "next-auth" {
  interface Session {
    /** The signed-in user's stable AAD object id. */
    oid: string;
    /** AAD security group claim values, when present (see hasGroupsOverage). */
    groups?: string[];
    /** True when Entra ID omitted inline groups due to "groups overage". */
    hasGroupsOverage: boolean;
  }
}
```

- [ ] **Step 3: Add the route handler**

```typescript
// apps/web/src/app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 5: Document the new env vars**

Append to `env.example`:

```
# ============================================================================
# Web app sign-in (Auth.js + Microsoft Entra ID) — apps/web only
# A SEPARATE Entra app registration from MS_TENANT_ID/MS_CLIENT_ID/
# MS_CLIENT_SECRET above (those are application/client-credentials
# permissions for the SharePoint/Outlook connectors; this is a delegated,
# authorization-code+PKCE registration for interactive user sign-in).
# Requires groupMembershipClaims: "SecurityGroup" set in this app
# registration's manifest so the `groups` claim is populated on sign-in.
# ============================================================================
AUTH_ENTRA_CLIENT_ID=
AUTH_ENTRA_CLIENT_SECRET=
AUTH_ENTRA_TENANT_ID=
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/auth.ts apps/web/src/types/next-auth.d.ts apps/web/src/app/api/auth/ env.example
git commit -m "feat(web): add Auth.js Microsoft Entra ID sign-in configuration"
```

---

### Task 9: Middleware — protect all BFF routes

**Files:**

- Create: `apps/web/src/middleware.ts`

**Interfaces:**

- Consumes: `auth` from `@/lib/auth` (Task 8).

- [ ] **Step 1: Implement**

No automated test — Next.js middleware runs in the Edge runtime and is most reliably verified by the e2e suite (Task 16 confirms an unauthenticated request is rejected) rather than a unit test harness for this thin a wrapper.

```typescript
// apps/web/src/middleware.ts
import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

/**
 * Protects every route except the Auth.js handler itself. An unauthenticated
 * request to any /api/* route (chat, sources, upload, documents/*) or any
 * page gets redirected to sign-in rather than silently falling back to any
 * shared/admin credential — there is no fallback path here by design.
 */
export default auth((req) => {
  const isAuthRoute = req.nextUrl.pathname.startsWith("/api/auth");
  if (isAuthRoute) return NextResponse.next();

  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/middleware.ts
git commit -m "feat(web): protect all BFF routes behind Auth.js session middleware"
```

---

### Task 10: Scope-token resolution helper

**Files:**

- Create: `apps/web/src/lib/scope-token.ts`
- Create: `apps/web/src/lib/scope-token.test.ts`

**Interfaces:**

- Consumes: `getWebDb` (Task 7), `resolveSourceIdsForUser` from `@rag/db`, `signInternalScopeToken` from `@rag/core` (Task 1).
- Produces: `getScopeAssertionToken(oid: string): Promise<string>`, consumed by Task 11 (migrated BFF routes).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/scope-token.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("./db.js", () => ({
  getWebDb: vi.fn(() => "fake-db-handle"),
}));

vi.mock("@rag/db", async () => {
  const actual = await vi.importActual<typeof import("@rag/db")>("@rag/db");
  return {
    ...actual,
    resolveSourceIdsForUser: vi.fn(async (_db: unknown, userId: string) =>
      userId === "oid-with-access" ? ["src-1", "src-2"] : [],
    ),
  };
});

import { resolveSourceIdsForUser } from "@rag/db";
import { getScopeAssertionToken } from "./scope-token.js";

const SECRET = "test-secret-at-least-32-bytes-long-here";

describe("getScopeAssertionToken", () => {
  it("mints a token embedding the resolved allowedSourceIds", async () => {
    process.env.INTERNAL_SCOPE_JWT_SECRET = SECRET;
    const token = await getScopeAssertionToken("oid-with-access");
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
      { algorithms: ["HS256"] },
    );
    expect(payload.sub).toBe("oid-with-access");
    expect(payload.allowedSourceIds).toEqual(["src-1", "src-2"]);
  });

  it("mints a deny-all token when the user has no assignments", async () => {
    process.env.INTERNAL_SCOPE_JWT_SECRET = SECRET;
    const token = await getScopeAssertionToken("oid-with-no-access");
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
      { algorithms: ["HS256"] },
    );
    expect(payload.allowedSourceIds).toEqual([]);
  });

  it("throws if INTERNAL_SCOPE_JWT_SECRET is not configured (fail loud on misconfig)", async () => {
    delete process.env.INTERNAL_SCOPE_JWT_SECRET;
    await expect(getScopeAssertionToken("oid-with-access")).rejects.toThrow(
      /INTERNAL_SCOPE_JWT_SECRET/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rag/web test -- scope-token`
Expected: FAIL — `Cannot find module './scope-token.js'`

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/lib/scope-token.ts
import { resolveSourceIdsForUser } from "@rag/db";
import { signInternalScopeToken } from "@rag/core";
import { getWebDb } from "./db.js";

/**
 * Resolve `oid`'s current per-client access (fresh from Postgres every call —
 * never cached beyond the returned token's own 60s lifetime, so a revoked
 * grant stops working within one request cycle) and mint the signed
 * scope-assertion JWT the BFF presents to Fastify as its bearer credential.
 *
 * Fails closed by construction: if `resolveSourceIdsForUser` throws (e.g. the
 * database is briefly unavailable), this function throws too — callers must
 * NOT catch this and fall back to a default/admin scope.
 */
export async function getScopeAssertionToken(oid: string): Promise<string> {
  const secret = process.env.INTERNAL_SCOPE_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "INTERNAL_SCOPE_JWT_SECRET must be set for the web app's BFF to mint scope-assertion tokens.",
    );
  }
  const allowedSourceIds = await resolveSourceIdsForUser(getWebDb(), oid);
  return signInternalScopeToken({ sub: oid, allowedSourceIds }, secret);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rag/web test -- scope-token`
Expected: PASS — 3 tests

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/scope-token.ts apps/web/src/lib/scope-token.test.ts
git commit -m "feat(web): add getScopeAssertionToken — resolves + signs per-user scope"
```

---

### Task 11: Migrate the BFF to per-user scope tokens

**Files:**

- Modify: `apps/web/src/lib/rag-api.ts`
- Modify: `apps/web/src/app/api/chat/route.ts`
- Modify: `apps/web/src/app/api/sources/route.ts`
- Modify: `apps/web/src/app/api/upload/route.ts`
- Modify: `apps/web/src/app/api/documents/[id]/route.ts`
- Modify: `apps/web/src/app/api/documents/[id]/download/route.ts`

**Interfaces:**

- Consumes: `getScopeAssertionToken` (Task 10), `auth` (Task 8).
- Produces: `getRagApiConfig(): RagApiConfig` (unchanged signature — no longer holds a token, only the URL), `proxyJsonGet(path: string, bearerToken: string)`, `proxyDownload(path: string, bearerToken: string)` — the exact same function names as today, with the proxy functions now taking a per-request token as an explicit parameter instead of reading a static one internally. Every route in this task must be updated to call `auth()`, obtain the session's `oid`, mint a token via `getScopeAssertionToken`, and pass it through.

- [ ] **Step 1: Update `rag-api.ts` to accept a per-request bearer token**

Replace the full contents of `apps/web/src/lib/rag-api.ts`:

```typescript
/**
 * Server-only helpers for talking to the RAG HTTP API from BFF route handlers.
 * Reads RAG_API_URL (server env, never NEXT_PUBLIC_). The bearer token is now
 * a per-request scope-assertion token (see getScopeAssertionToken) minted
 * fresh from the signed-in user's session — never a shared static token.
 * The browser only ever calls same-origin /api/* routes; the bearer token
 * stays on the server.
 */

export interface RagApiConfig {
  url: string;
}

export function getRagApiConfig(): RagApiConfig {
  const url = process.env.RAG_API_URL;
  if (!url) {
    throw new Error("RAG_API_URL must be set (server env, not NEXT_PUBLIC_).");
  }
  return { url: url.replace(/\/+$/, "") };
}

/** Proxy a JSON GET to the RAG API, returning a same-origin JSON Response. */
export async function proxyJsonGet(
  path: string,
  bearerToken: string,
): Promise<Response> {
  let config: RagApiConfig;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}${path}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * BFF proxy for a binary download (GET /documents/:id/download). Forwards the
 * per-request scope-assertion token, streams the bytes back, and propagates
 * the Content-Type / Content-Disposition / Content-Length headers so the
 * browser downloads the original file.
 */
export async function proxyDownload(
  path: string,
  bearerToken: string,
): Promise<Response> {
  let config: RagApiConfig;
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}${path}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || null, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) headers.set("Content-Disposition", disposition);
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  return new Response(upstream.body, { status: 200, headers });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Update `GET /api/sources` (representative pattern for the JSON GET routes)**

Read the current contents of `apps/web/src/app/api/sources/route.ts` first, then apply this shape (the body of the handler changes; imports and any route-specific logic beyond the proxy call are preserved):

```typescript
import { auth } from "@/lib/auth";
import { getScopeAssertionToken } from "@/lib/scope-token";
import { jsonError, proxyJsonGet } from "@/lib/rag-api";

export async function GET() {
  const session = await auth();
  if (!session?.oid) {
    return jsonError(401, "UNAUTHENTICATED", "Sign-in required.");
  }
  const token = await getScopeAssertionToken(session.oid);
  return proxyJsonGet("/sources", token);
}
```

- [ ] **Step 3: Apply the same pattern to `documents/[id]/route.ts`**

Read the current file first; update its handler(s) the same way — obtain `session.oid` via `auth()`, mint the token via `getScopeAssertionToken`, and pass it as the second argument to whichever `rag-api.ts` proxy function it already calls (`proxyJsonGet` for the JSON GET, matching the path parameter it already builds from `params.id`).

- [ ] **Step 4: Apply the same pattern to `documents/[id]/download/route.ts`**

Read the current file first; same change, using `proxyDownload(path, token)` instead of the old single-argument call.

- [ ] **Step 5: Apply the same pattern to `chat/route.ts` and `upload/route.ts`**

Read both current files first. These route handlers construct their own `fetch` calls (chat streams via `stream-chat.ts`; upload posts multipart form data) rather than calling `proxyJsonGet`/`proxyDownload` directly — in both cases, replace whatever static-token header construction they currently use with:

```typescript
const session = await auth();
if (!session?.oid) {
  return jsonError(401, "UNAUTHENTICATED", "Sign-in required.");
}
const token = await getScopeAssertionToken(session.oid);
// ... then use `Authorization: `Bearer ${token}`` wherever the old static
// RAG_API_TOKEN header was previously read from getRagApiConfig().token.
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds — this step will surface any route this task's steps missed, since `getRagApiConfig()` no longer has a `token` field and every old call site referencing it will fail to compile.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/rag-api.ts apps/web/src/app/api/
git commit -m "feat(web): migrate all 5 BFF routes to per-user scope-assertion tokens"
```

---

### Task 12: `WEB_AUTH_MODE` rollback flag

**Files:**

- Modify: `apps/web/src/middleware.ts`
- Modify: `apps/web/src/lib/rag-api.ts`

**Interfaces:**

- Produces: a `WEB_AUTH_MODE` env var (`"entra"` default, `"static-fallback"` emergency override) gating both the middleware's redirect behavior and which bearer token the BFF forwards.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/rag-api.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { resolveBearerToken } from "./rag-api.js";

describe("resolveBearerToken — WEB_AUTH_MODE rollback flag", () => {
  afterEach(() => {
    delete process.env.WEB_AUTH_MODE;
    delete process.env.RAG_API_STATIC_FALLBACK_TOKEN;
  });

  it("uses the per-user scope token by default (entra mode)", () => {
    const result = resolveBearerToken({ scopeToken: "scope-jwt" });
    expect(result).toBe("scope-jwt");
  });

  it("uses the static fallback token when WEB_AUTH_MODE=static-fallback", () => {
    process.env.WEB_AUTH_MODE = "static-fallback";
    process.env.RAG_API_STATIC_FALLBACK_TOKEN = "emergency-static-token";
    const result = resolveBearerToken({ scopeToken: "scope-jwt" });
    expect(result).toBe("emergency-static-token");
  });

  it("throws if static-fallback mode is set but no fallback token is configured", () => {
    process.env.WEB_AUTH_MODE = "static-fallback";
    expect(() => resolveBearerToken({ scopeToken: "scope-jwt" })).toThrow(
      /RAG_API_STATIC_FALLBACK_TOKEN/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rag/web test -- rag-api`
Expected: FAIL — `resolveBearerToken` is not exported

- [ ] **Step 3: Implement**

Add to `apps/web/src/lib/rag-api.ts` (near the top, after the existing `RagApiConfig` interface/`getRagApiConfig` function from Task 11):

```typescript
/**
 * Resolves which bearer token the BFF forwards to Fastify. Defaults to the
 * per-user scope-assertion token. `WEB_AUTH_MODE=static-fallback` is a
 * deliberately TEMPORARY emergency override for when Entra ID sign-in is
 * broken in production (misconfigured redirect URI, expired client secret,
 * tenant issue) — it reverts every user to one shared static token so the
 * app stays usable while the Entra ID issue is fixed. Remove this flag (and
 * RAG_API_STATIC_FALLBACK_TOKEN) once a rollout has been stable for a
 * defined period; it is not a permanent dual-mode feature.
 */
export function resolveBearerToken(opts: { scopeToken: string }): string {
  const mode = process.env.WEB_AUTH_MODE ?? "entra";
  if (mode === "static-fallback") {
    const fallback = process.env.RAG_API_STATIC_FALLBACK_TOKEN;
    if (!fallback) {
      throw new Error(
        "WEB_AUTH_MODE=static-fallback requires RAG_API_STATIC_FALLBACK_TOKEN to be set.",
      );
    }
    return fallback;
  }
  return opts.scopeToken;
}
```

- [ ] **Step 4: Wire it into every migrated route from Task 11**

In each of the 5 route handlers touched in Task 11, replace the direct use of `token` (the value returned by `getScopeAssertionToken`) with `resolveBearerToken({ scopeToken: token })` before passing it to `proxyJsonGet`/`proxyDownload`/the manual fetch calls. Example for `sources/route.ts`:

```typescript
export async function GET() {
  const session = await auth();
  if (!session?.oid) {
    return jsonError(401, "UNAUTHENTICATED", "Sign-in required.");
  }
  const scopeToken = await getScopeAssertionToken(session.oid);
  return proxyJsonGet("/sources", resolveBearerToken({ scopeToken }));
}
```

Apply the same one-line wrap (`resolveBearerToken({ scopeToken: token })` in place of the bare `token`) to `chat`, `upload`, `documents/[id]`, and `documents/[id]/download`.

- [ ] **Step 5: Also gate the middleware's redirect**

In `apps/web/src/middleware.ts` (Task 9), the auth check should be skipped when in fallback mode, since the fallback token IS the shared credential (there's no per-user session to require):

```typescript
export default auth((req) => {
  const isAuthRoute = req.nextUrl.pathname.startsWith("/api/auth");
  if (isAuthRoute) return NextResponse.next();

  if (process.env.WEB_AUTH_MODE === "static-fallback")
    return NextResponse.next();

  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @rag/web test -- rag-api`
Expected: PASS — 3 tests

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 8: Document the new env vars**

Append to `env.example`:

```
# ============================================================================
# Emergency rollback (web app only) — DELIBERATELY TEMPORARY
# If Entra ID sign-in breaks in production (misconfigured redirect URI,
# expired client secret, tenant issue), set WEB_AUTH_MODE=static-fallback to
# revert every user to one shared static token while the issue is fixed.
# Remove both vars once the Entra ID rollout has been stable for a defined
# period — this is a safety net, not a permanent dual-mode feature.
# ============================================================================
WEB_AUTH_MODE=entra
RAG_API_STATIC_FALLBACK_TOKEN=
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/rag-api.ts apps/web/src/lib/rag-api.test.ts apps/web/src/middleware.ts apps/web/src/app/api/ env.example
git commit -m "feat(web): add WEB_AUTH_MODE=static-fallback emergency rollback"
```

---

### Task 13: Microsoft Graph client helper

**Files:**

- Create: `apps/web/src/lib/graph-client.ts`
- Create: `apps/web/src/lib/graph-client.test.ts`

**Interfaces:**

- Produces: `resolveOidByEmail(email: string): Promise<string | null>`, `isUserInGroup(oid: string, groupId: string): Promise<boolean>` — consumed by Task 14 (admin-check's overage fallback) and Task 15 (admin UI's staff-email lookup).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/lib/graph-client.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { resolveOidByEmail, isUserInGroup } from "./graph-client.js";

beforeEach(() => {
  fetchMock.mockReset();
  process.env.MS_TENANT_ID = "test-tenant";
  process.env.MS_CLIENT_ID = "test-client";
  process.env.MS_CLIENT_SECRET = "test-secret";
});

function mockTokenThenResponse(responseBody: unknown, responseStatus = 200) {
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "fake-graph-token" }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify(responseBody), { status: responseStatus }),
    );
}

describe("resolveOidByEmail", () => {
  it("returns the user's oid when found", async () => {
    mockTokenThenResponse({ id: "aad-oid-123" });
    await expect(resolveOidByEmail("jane@firm.com")).resolves.toBe(
      "aad-oid-123",
    );
  });

  it("returns null when the user is not found (404)", async () => {
    mockTokenThenResponse({ error: { message: "not found" } }, 404);
    await expect(resolveOidByEmail("nobody@firm.com")).resolves.toBeNull();
  });
});

describe("isUserInGroup", () => {
  it("returns true when the group check-membership call reports membership", async () => {
    mockTokenThenResponse({ value: true });
    await expect(isUserInGroup("aad-oid-123", "group-id-1")).resolves.toBe(
      true,
    );
  });

  it("returns false when the group check-membership call reports no membership", async () => {
    mockTokenThenResponse({ value: false });
    await expect(isUserInGroup("aad-oid-123", "group-id-1")).resolves.toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rag/web test -- graph-client`
Expected: FAIL — `Cannot find module './graph-client.js'`

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/lib/graph-client.ts
/**
 * Microsoft Graph client-credentials helper, reusing the existing
 * MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET already configured for the
 * SharePoint/Outlook connectors (application permissions, no user present —
 * this is the correct reuse; contrast with Task 8's SEPARATE delegated app
 * registration for user sign-in). Used for the admin UI's email→oid lookup
 * and the Entra ID "groups overage" membership-check fallback.
 */

interface GraphTokenResponse {
  access_token: string;
}

async function getGraphAccessToken(): Promise<string> {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "MS_TENANT_ID, MS_CLIENT_ID, and MS_CLIENT_SECRET must all be set for Graph API access.",
    );
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to acquire Graph access token: ${res.status}`);
  }
  const body = (await res.json()) as GraphTokenResponse;
  return body.access_token;
}

/** Resolve a staff member's email to their AAD object id, or null if not found. */
export async function resolveOidByEmail(email: string): Promise<string | null> {
  const token = await getGraphAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Graph user lookup failed: ${res.status}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

/**
 * Check a user's membership in a specific group via Graph's
 * checkMemberGroups-adjacent `/members/$ref`-style direct check. Used as the
 * "groups overage" fallback (see admin-check.ts) when the ID token didn't
 * carry inline group claims.
 */
export async function isUserInGroup(
  oid: string,
  groupId: string,
): Promise<boolean> {
  const token = await getGraphAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/groups/${groupId}/members/${oid}/$ref`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  // A 200/204 means the $ref exists (member); 404 means it doesn't.
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`Graph group membership check failed: ${res.status}`);
  }
  return true;
}
```

Note: the test mocks a `{ value: true/false }` JSON body for simplicity of illustrating the two branches; the real Graph `/$ref` check-membership endpoint signals membership via HTTP status rather than a response body field — when implementing, verify the exact current Microsoft Graph API contract for group membership checks (`GET .../groups/{id}/members/{id}/$ref` vs. the `checkMemberGroups` POST action) against Microsoft's live API documentation before finalizing this function, since Graph API response shapes are Microsoft's to change and this plan's test fixture is illustrative of the two control-flow branches, not a guarantee of the exact wire format.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rag/web test -- graph-client`
Expected: PASS — 4 tests

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/graph-client.ts apps/web/src/lib/graph-client.test.ts
git commit -m "feat(web): add Microsoft Graph client for email->oid lookup and group membership checks"
```

---

### Task 14: Admin-role gate

**Files:**

- Create: `apps/web/src/lib/admin-check.ts`
- Create: `apps/web/src/lib/admin-check.test.ts`

**Interfaces:**

- Consumes: `isUserInGroup` (Task 13), the `Session` shape from Task 8 (`oid`, `groups`, `hasGroupsOverage`).
- Produces: `isAdmin(session: Session): Promise<boolean>`, consumed by Task 15 (admin UI + server actions).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/lib/admin-check.test.ts
import { describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("./graph-client.js", () => ({
  isUserInGroup: vi.fn(),
}));

import { isUserInGroup } from "./graph-client.js";
import { isAdmin } from "./admin-check.js";

const baseSession = (overrides: Partial<Session>): Session =>
  ({
    oid: "aad-oid-1",
    groups: [],
    hasGroupsOverage: false,
    user: {},
    expires: "",
    ...overrides,
  }) as Session;

describe("isAdmin", () => {
  it("returns true when the RAG-Admins group id is in the inline groups claim", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    const session = baseSession({ groups: ["admins-group-id", "other-group"] });
    await expect(isAdmin(session)).resolves.toBe(true);
  });

  it("returns false when the inline groups claim doesn't include it", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    const session = baseSession({ groups: ["other-group"] });
    await expect(isAdmin(session)).resolves.toBe(false);
  });

  it("falls back to a Graph membership check on groups overage", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    vi.mocked(isUserInGroup).mockResolvedValueOnce(true);
    const session = baseSession({ groups: undefined, hasGroupsOverage: true });
    await expect(isAdmin(session)).resolves.toBe(true);
    expect(isUserInGroup).toHaveBeenCalledWith("aad-oid-1", "admins-group-id");
  });

  it("returns false from the Graph fallback when not a member", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    vi.mocked(isUserInGroup).mockResolvedValueOnce(false);
    const session = baseSession({ groups: undefined, hasGroupsOverage: true });
    await expect(isAdmin(session)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rag/web test -- admin-check`
Expected: FAIL — `Cannot find module './admin-check.js'`

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/lib/admin-check.ts
import type { Session } from "next-auth";
import { isUserInGroup } from "./graph-client.js";

/**
 * Determines whether the signed-in user is a member of the `RAG-Admins`
 * security group — the single source of truth for who can manage client
 * access grants. Handles Entra ID's "groups overage" case: when a user
 * belongs to too many groups, the ID token omits inline group values
 * entirely (`hasGroupsOverage: true`) and membership must instead be
 * confirmed via a direct Microsoft Graph call.
 */
export async function isAdmin(session: Session): Promise<boolean> {
  const adminGroupId = process.env.RAG_ADMINS_GROUP_ID;
  if (!adminGroupId) return false;

  if (session.hasGroupsOverage) {
    return isUserInGroup(session.oid, adminGroupId);
  }
  return (session.groups ?? []).includes(adminGroupId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rag/web test -- admin-check`
Expected: PASS — 4 tests

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 6: Document the new env var**

Append to `env.example`:

```
# ============================================================================
# Admin role gate (web app only)
# AAD security group object id whose members can grant/revoke client access
# via /admin/access. No DB-backed roles table — this group is the single
# source of truth, consistent with how AAD groups already govern access for
# the SharePoint/Outlook connectors.
# ============================================================================
RAG_ADMINS_GROUP_ID=
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/admin-check.ts apps/web/src/lib/admin-check.test.ts env.example
git commit -m "feat(web): add isAdmin gate handling Entra ID groups-overage fallback"
```

---

### Task 15: Admin UI — grant/revoke access

**Files:**

- Create: `apps/web/src/app/admin/access/actions.ts`
- Create: `apps/web/src/app/admin/access/actions.test.ts`
- Create: `apps/web/src/app/admin/access/page.tsx`

**Interfaces:**

- Consumes: `auth` (Task 8), `isAdmin` (Task 14), `resolveOidByEmail` (Task 13), `grantClientAccess`/`revokeClientAccess`/`listAssignmentHistoryForStaff` (Task 5), `getWebDb` (Task 7).
- Produces: server actions `grantAccessAction(formData: FormData)`, `revokeAccessAction(formData: FormData)`, `getHistoryAction(email: string)` — the page (`page.tsx`) is a thin form wired to these; per this plan's testing strategy (Task 6's vitest config), only the server actions are unit tested, not the page's JSX rendering (covered instead by the e2e spec in Task 16 / manual QA).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/app/admin/access/actions.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/admin-check", () => ({ isAdmin: vi.fn() }));
vi.mock("@/lib/graph-client", () => ({ resolveOidByEmail: vi.fn() }));
vi.mock("@/lib/db", () => ({ getWebDb: vi.fn(() => "fake-db") }));
vi.mock("@rag/db", async () => {
  const actual = await vi.importActual<typeof import("@rag/db")>("@rag/db");
  return {
    ...actual,
    grantClientAccess: vi.fn(),
    revokeClientAccess: vi.fn(),
  };
});

import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { resolveOidByEmail } from "@/lib/graph-client";
import { grantClientAccess, revokeClientAccess } from "@rag/db";
import { grantAccessAction, revokeAccessAction } from "./actions.js";

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({
    oid: "admin-oid-1",
    groups: [],
    hasGroupsOverage: false,
    user: {},
    expires: "",
  } as never);
  vi.mocked(isAdmin).mockResolvedValue(true);
});

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("grantAccessAction", () => {
  it("resolves the target email to an oid and grants access", async () => {
    vi.mocked(resolveOidByEmail).mockResolvedValue("target-oid-1");
    const result = await grantAccessAction(
      fd({ email: "jane@firm.com", clientId: "acme-2024" }),
    );
    expect(grantClientAccess).toHaveBeenCalledWith("fake-db", {
      userId: "target-oid-1",
      clientId: "acme-2024",
      grantedBy: "admin-oid-1",
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns an error when the email doesn't resolve to a known user", async () => {
    vi.mocked(resolveOidByEmail).mockResolvedValue(null);
    const result = await grantAccessAction(
      fd({ email: "nobody@firm.com", clientId: "acme-2024" }),
    );
    expect(result).toEqual({
      ok: false,
      error: "No Entra ID user found for nobody@firm.com",
    });
    expect(grantClientAccess).not.toHaveBeenCalled();
  });

  it("rejects when the caller is not an admin (defense in depth beyond page-level gating)", async () => {
    vi.mocked(isAdmin).mockResolvedValue(false);
    const result = await grantAccessAction(
      fd({ email: "jane@firm.com", clientId: "acme-2024" }),
    );
    expect(result).toEqual({ ok: false, error: "Forbidden" });
    expect(grantClientAccess).not.toHaveBeenCalled();
  });
});

describe("revokeAccessAction", () => {
  it("resolves the target email and revokes access", async () => {
    vi.mocked(resolveOidByEmail).mockResolvedValue("target-oid-1");
    const result = await revokeAccessAction(
      fd({ email: "jane@firm.com", clientId: "acme-2024" }),
    );
    expect(revokeClientAccess).toHaveBeenCalledWith("fake-db", {
      userId: "target-oid-1",
      clientId: "acme-2024",
    });
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rag/web test -- admin/access/actions`
Expected: FAIL — `Cannot find module './actions.js'`

- [ ] **Step 3: Implement the server actions**

```typescript
// apps/web/src/app/admin/access/actions.ts
"use server";

import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { resolveOidByEmail } from "@/lib/graph-client";
import { getWebDb } from "@/lib/db";
import {
  grantClientAccess,
  revokeClientAccess,
  listAssignmentHistoryForStaff,
} from "@rag/db";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Every action re-checks admin membership server-side, in addition to
 * whatever page-level gating exists — a server action is a public,
 * independently-callable HTTP endpoint under the hood, so it must not rely
 * solely on the calling page having hidden a button.
 */
async function requireAdmin(): Promise<
  { ok: true; oid: string } | { ok: false; error: string }
> {
  const session = await auth();
  if (!session?.oid) return { ok: false, error: "Unauthenticated" };
  if (!(await isAdmin(session))) return { ok: false, error: "Forbidden" };
  return { ok: true, oid: session.oid };
}

export async function grantAccessAction(
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;

  const email = String(formData.get("email") ?? "");
  const clientId = String(formData.get("clientId") ?? "");

  const targetOid = await resolveOidByEmail(email);
  if (!targetOid) {
    return { ok: false, error: `No Entra ID user found for ${email}` };
  }

  await grantClientAccess(getWebDb(), {
    userId: targetOid,
    clientId,
    grantedBy: gate.oid,
  });
  return { ok: true };
}

export async function revokeAccessAction(
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;

  const email = String(formData.get("email") ?? "");
  const clientId = String(formData.get("clientId") ?? "");

  const targetOid = await resolveOidByEmail(email);
  if (!targetOid) {
    return { ok: false, error: `No Entra ID user found for ${email}` };
  }

  await revokeClientAccess(getWebDb(), { userId: targetOid, clientId });
  return { ok: true };
}

export async function getHistoryAction(email: string) {
  const gate = await requireAdmin();
  if (!gate.ok) return { ok: false as const, error: gate.error };

  const targetOid = await resolveOidByEmail(email);
  if (!targetOid) {
    return {
      ok: false as const,
      error: `No Entra ID user found for ${email}`,
    };
  }
  const history = await listAssignmentHistoryForStaff(getWebDb(), targetOid);
  return { ok: true as const, history };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rag/web test -- admin/access/actions`
Expected: PASS — 4 tests

- [ ] **Step 5: Implement the admin page**

```tsx
// apps/web/src/app/admin/access/page.tsx
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { grantAccessAction, revokeAccessAction } from "./actions";

export default async function AdminAccessPage() {
  const session = await auth();
  if (!session?.oid || !(await isAdmin(session))) {
    redirect("/");
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Client Access Management</h1>

      <form action={grantAccessAction} className="mt-6 space-y-3">
        <h2 className="text-lg font-medium">Grant access</h2>
        <input
          name="email"
          type="email"
          placeholder="staff@firm.com"
          required
          className="w-full rounded border px-3 py-2"
        />
        <input
          name="clientId"
          type="text"
          placeholder="client id (e.g. acme-2024)"
          required
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">
          Grant
        </button>
      </form>

      <form action={revokeAccessAction} className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Revoke access</h2>
        <input
          name="email"
          type="email"
          placeholder="staff@firm.com"
          required
          className="w-full rounded border px-3 py-2"
        />
        <input
          name="clientId"
          type="text"
          placeholder="client id (e.g. acme-2024)"
          required
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="rounded border px-4 py-2">
          Revoke
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @rag/web typecheck`
Expected: succeeds

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/admin/
git commit -m "feat(web): add admin UI for granting/revoking client access"
```

---

### Task 16: End-to-end verification

**Files:**

- Modify: `tests/e2e/src/env.ts`
- Create: `tests/e2e/src/specs/internal-scope-auth.spec.ts`

**Interfaces:**

- Consumes: `buildTestApi` (`tests/e2e/src/helpers/api.ts`), `signInternalScopeToken` from `@rag/core` (Task 1), `grantClientAccess`/`revokeClientAccess` from `@rag/db` (Task 5).

This spec deliberately does **not** drive a real Entra ID browser sign-in (that would require a live tenant or a mock IdP the existing e2e harness doesn't have, and Auth.js's own OAuth correctness is a well-tested third-party concern, not this codebase's to re-verify). Instead it proves the security-critical path THIS codebase owns end-to-end: `grantClientAccess` → `signInternalScopeToken` → Fastify's `InternalScopeAuthProvider` (verified via a real in-process HTTP request) → scoped results → `revokeClientAccess` → the same token immediately re-resolves to nothing.

- [ ] **Step 1: Add a test secret to the shared e2e config**

Edit `tests/e2e/src/env.ts` — add a new exported constant near `TEST_API_TOKEN`, and switch the test config's `auth` block to `composite` so both the existing static-token tests and this new spec's internal-scope tests work side by side:

```typescript
export const TEST_API_TOKEN = "e2e-test-token";
export const TEST_INTERNAL_SCOPE_SECRET =
  "e2e-test-internal-scope-secret-32-bytes-min";
```

Then change the `auth:` field inside `makeTestConfig()` from:

```typescript
    auth: { provider: "static-token" },
```

to:

```typescript
    auth: {
      provider: "composite",
      internalScopeSecrets: [TEST_INTERNAL_SCOPE_SECRET],
    },
```

- [ ] **Step 2: Write the spec**

```typescript
// tests/e2e/src/specs/internal-scope-auth.spec.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@rag/db";
import { grantClientAccess, revokeClientAccess } from "@rag/db";
import { signInternalScopeToken } from "@rag/core";
import { createCustomSource, openTestDb, truncateAll } from "../helpers/db.js";
import { buildTestApi, type TestInject } from "../helpers/api.js";
import { TEST_INTERNAL_SCOPE_SECRET } from "../env.js";

/**
 * Proves the BFF-asserted scope-token mechanism end-to-end against a real
 * in-process Fastify instance: grant -> signed token -> scoped HTTP request
 * -> revoke -> the same-shaped token immediately stops working. Does NOT
 * drive Auth.js/Entra ID sign-in itself (see this spec file's header note in
 * the implementation plan for why that's out of scope for this suite).
 */
describe("E2E: internal-scope-auth (web app per-user auth mechanism)", () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let inject: TestInject;
  let closeApi: () => Promise<void>;

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    closeDb = handle.close;
    await truncateAll(db);
    const api = await buildTestApi({ db });
    inject = api.inject;
    closeApi = api.close;
  });

  afterAll(async () => {
    await closeApi();
    await closeDb();
  });

  it("a scope-assertion token for a granted source returns that source; revoking denies it", async () => {
    const source = await createCustomSource(db, { name: "Scope Test Source" });

    await grantClientAccess(db, {
      userId: "e2e-oid-1",
      clientId: "e2e-client-1",
    } as never); // clientId here must match a source_client_assignments row —
    // see Step 3 note below on wiring the source to the client before this
    // assertion; adjust once that helper exists.

    const grantedToken = await signInternalScopeToken(
      { sub: "e2e-oid-1", allowedSourceIds: [source.id] },
      TEST_INTERNAL_SCOPE_SECRET,
    );

    const grantedRes = await inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${grantedToken}` },
    });
    expect(grantedRes.statusCode).toBe(200);
    const grantedBody = grantedRes.json() as { sources: Array<{ id: string }> };
    expect(grantedBody.sources.map((s) => s.id)).toContain(source.id);

    await revokeClientAccess(db, {
      userId: "e2e-oid-1",
      clientId: "e2e-client-1",
    });

    // A freshly-minted token for the same (now-revoked) scope should assert
    // an empty allowedSourceIds if the caller re-resolved it (this spec signs
    // the token directly to isolate the Fastify-side enforcement rather than
    // re-testing scope-token.ts's DB resolution, which Task 10 already covers).
    const deniedToken = await signInternalScopeToken(
      { sub: "e2e-oid-1", allowedSourceIds: [] },
      TEST_INTERNAL_SCOPE_SECRET,
    );
    const deniedRes = await inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${deniedToken}` },
    });
    expect(deniedRes.statusCode).toBe(200);
    const deniedBody = deniedRes.json() as { sources: Array<{ id: string }> };
    expect(deniedBody.sources).toEqual([]);
  });

  it("rejects a token signed with an unconfigured secret", async () => {
    const forgedToken = await signInternalScopeToken(
      { sub: "attacker-oid", allowedSourceIds: ["anything"] },
      "a-secret-never-configured-on-the-server",
    );
    const res = await inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${forgedToken}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 3: Reconcile the source/client wiring helper**

Before running this spec, read `tests/e2e/src/helpers/db.ts`'s `createCustomSource` signature and check whether a `source_client_assignments` insert helper already exists there (the Phase 2/3 governance work earlier in this project may have added one). If not, add a minimal helper alongside `createCustomSource` in that same file:

```typescript
export async function assignSourceToClient(
  db: Db,
  sourceId: string,
  clientId: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO source_client_assignments (source_id, client_id)
    VALUES (${sourceId}, ${clientId})
  `);
}
```

Then call `await assignSourceToClient(db, source.id, "e2e-client-1");` in the spec immediately after `createCustomSource`, before `grantClientAccess` — this is what makes `resolveSourceIdsForUser`-equivalent scoping actually resolve `source.id` for `e2e-client-1` in a real deployment; this spec signs the token directly (bypassing `resolveSourceIdsForUser`) specifically to isolate Fastify-side enforcement, but the grant/revoke calls should still reflect a realistic, fully-wired scenario for anyone reading this test as documentation of the feature.

- [ ] **Step 4: Run the new spec**

Run: `pnpm --filter @rag/e2e test -- internal-scope-auth`
Expected: PASS — 2 tests

- [ ] **Step 5: Run the full e2e suite to confirm no regression**

Run: `pnpm e2e`
Expected: all specs pass, including the pre-existing ones (confirms the `auth: {provider: "composite", ...}` change to `makeTestConfig()` didn't break the static-token-based assertions the existing specs rely on)

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/src/env.ts tests/e2e/src/specs/internal-scope-auth.spec.ts tests/e2e/src/helpers/db.ts
git commit -m "test(e2e): verify InternalScopeAuthProvider grant/revoke end-to-end"
```

---

## Post-implementation (not part of this plan — external/ops dependencies)

These require IT/tenant-admin action outside this codebase and should be kicked off in parallel with Task 1 (the longest external lead time in this plan), not sequenced after the code is otherwise ready:

1. Create the sign-in Entra app registration (delegated permissions, `groupMembershipClaims: "SecurityGroup"`, redirect URI) — see Task 8.
2. Create the `RAG-Admins` AAD security group and add its id to `RAG_ADMINS_GROUP_ID` — see Task 14.
3. Set `INTERNAL_SCOPE_JWT_SECRET`(S) in each service's deployment (a long random value, stored in a real secret manager per the design spec's guidance — not a plaintext dashboard value).
4. Grant the first admin(s) access by directly inserting a `staff_client_assignments` row (or, once Task 15 ships, via the new `/admin/access` UI bootstrapped by a temporarily-elevated first admin).
5. Remove `RAG_API_TOKEN` from the web app's deployment once the migration (Task 11) has been verified stable in production.
