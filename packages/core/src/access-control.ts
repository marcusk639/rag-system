/**
 * Per-principal source-id access control — the CONFIDENTIALITY boundary for
 * this corpus.
 *
 * This RAG system indexes a CPA firm's confidential corpus: client emails, tax
 * workpapers, engagement documents. Different staff/partners are walled off
 * from clients they don't work. Historically ANY valid API/MCP token could read
 * the ENTIRE corpus (ARCHITECTURE.md: "Not a permission/ACL system"). That is a
 * confidentiality incident waiting to happen.
 *
 * This module is the PURE core of the fix:
 *   - A `Principal` is the resolved identity behind a bearer token.
 *   - An `AuthorizationScope` is the MANDATORY enforcement input threaded into
 *     `Retriever.search` / `hybridSearch`. It is NOT optional — a route cannot
 *     "forget" it, because `search` requires it as a positional argument.
 *   - `effectiveSourceFilter` computes the actual source-id set the SQL must
 *     restrict to: the caller's optional convenience filter ANDed with the
 *     enforced set, with admin-bypass and empty-set-fail-closed semantics.
 *
 * MVP storage: config/env-driven (no DB table/migration). The shape is kept
 * structured so a DB-backed principal store can replace `resolvePrincipal`
 * later without touching the enforcement path.
 *
 * ── DEFAULT-FOR-UNSCOPED-TOKENS POLICY (READ THIS) ─────────────────────────
 * A plain token in `API_TOKENS` resolves to an **ADMIN / all-access** principal,
 * preserving the pre-ACL behavior for existing deployments (backward-compatible,
 * NOT a breaking change). Scoping is OPT-IN via the new `API_PRINCIPALS` config:
 * any token listed there is ENFORCED to its `allowedSourceIds` and CANNOT see
 * anything else — even if the same string also appears in `API_TOKENS`
 * (scoped wins; least privilege). To wall off staff, give them `API_PRINCIPALS`
 * tokens and reserve `API_TOKENS` for admin/service callers.
 */

/**
 * Resolved identity behind a bearer token.
 *   - `admin`  — unrestricted; sees the whole corpus.
 *   - `scoped` — enforced to exactly `allowedSourceIds`. An empty list means
 *     "may read NOTHING" (fail closed), never "everything".
 *
 * `subject` (scoped only) is the verified per-user identity (the AAD oid from
 * a BFF-asserted scope-assertion JWT's `sub` claim) — populated ONLY by
 * `InternalScopeAuthProvider`. Static-token/OIDC-derived scoped principals
 * omit it; it exists purely to carry per-user attribution into `audit_log`
 * (CR-10), not to affect authorization — the enforced source-id set is
 * unchanged by its presence or absence.
 */
export type Principal =
  | { kind: "admin" }
  | { kind: "scoped"; allowedSourceIds: string[]; subject?: string };

/**
 * The MANDATORY enforcement input for retrieval.
 *   - `enforcedSourceIds: null`   => admin / unrestricted (no WHERE restriction).
 *   - `enforcedSourceIds: []`     => fail closed (zero rows).
 *   - `enforcedSourceIds: [...]`  => results MUST be within this set.
 */
export interface AuthorizationScope {
  /** `null` === admin/unrestricted. `[]` === fail closed (no results). */
  enforcedSourceIds: string[] | null;
}

/** The unrestricted (admin) scope — explicit, for stdio/local/trusted callers. */
export const ADMIN_SCOPE: AuthorizationScope = { enforcedSourceIds: null };

/**
 * The deny-all / fail-closed scope — distinct from ADMIN_SCOPE (null). An empty
 * `enforcedSourceIds` means "may read NOTHING" (zero rows), the safe failure for
 * a confidentiality boundary when no principal resolves.
 */
export const DENY_ALL_SCOPE: AuthorizationScope = { enforcedSourceIds: [] };

/** A single scoped-principal entry from the `API_PRINCIPALS` config. */
export interface ScopedPrincipalConfig {
  token: string;
  allowedSourceIds: string[];
  /**
   * Explicit admin grant. When true, this token resolves to an `admin`
   * (all-corpus) principal regardless of `allowedSourceIds`. This is the ONLY
   * way to get admin once `enforceScoping` is on, so admin is always a
   * deliberate, auditable choice rather than a silent default.
   */
  isAdmin?: boolean;
}

/**
 * Parse the `API_PRINCIPALS` env value (a JSON array of
 * `{ token, allowedSourceIds: string[] }`) into a typed list.
 *
 * Fails LOUDLY on malformed input so a misconfiguration is caught at startup
 * rather than silently degrading to "no scoping" (which would re-open the leak).
 * An absent/blank value is valid and yields `[]` (no scoped principals).
 */
export function parsePrincipalsConfig(
  raw: string | undefined,
): ScopedPrincipalConfig[] {
  if (!raw || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `API_PRINCIPALS is not valid JSON: ${(err as Error).message}. ` +
        `Expected a JSON array of {"token": string, "allowedSourceIds": string[]}.`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `API_PRINCIPALS must be a JSON array of ` +
        `{"token": string, "allowedSourceIds": string[]}.`,
    );
  }

  const principals = parsed.map((entry, i) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).token !== "string" ||
      !Array.isArray((entry as Record<string, unknown>).allowedSourceIds) ||
      !(entry as ScopedPrincipalConfig).allowedSourceIds.every(
        (s) => typeof s === "string",
      )
    ) {
      throw new Error(
        `API_PRINCIPALS[${i}] is invalid: each entry must be ` +
          `{"token": string, "allowedSourceIds": string[]}.`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (e.isAdmin !== undefined && typeof e.isAdmin !== "boolean") {
      throw new Error(
        `API_PRINCIPALS[${i}].isAdmin must be a boolean when present.`,
      );
    }
    return {
      token: e.token as string,
      allowedSourceIds: e.allowedSourceIds as string[],
      ...(e.isAdmin === true ? { isAdmin: true } : {}),
    };
  });

  // Fail LOUDLY on a duplicate token. A repeated token is a silent footgun on a
  // security-config surface: only the first entry would ever win in
  // `resolvePrincipal`, so the second `allowedSourceIds` is silently ignored —
  // an admin who pastes the same token under two different scopes would not be
  // warned. Catch it at startup instead.
  const seen = new Set<string>();
  principals.forEach((p, i) => {
    if (seen.has(p.token)) {
      throw new Error(
        `API_PRINCIPALS contains a duplicate token (entry ${i}). ` +
          `Each token must appear at most once.`,
      );
    }
    seen.add(p.token);
  });

  return principals;
}

/**
 * Resolve a presented bearer token to a `Principal`, or `null` if the token is
 * unknown (caller should respond 401).
 *
 * Resolution order enforces LEAST PRIVILEGE: a token present in BOTH the scoped
 * list and the admin list resolves to its SCOPED principal — scoping wins.
 * Token comparison here is plain equality; the constant-time check that the
 * token is valid at all already happened in the auth layer. (We keep this pure
 * and synchronous so it's trivially testable and DB-swappable later.)
 *
 * NOTE: callers SHOULD still verify the token via the constant-time allow-list
 * BEFORE calling this; this function only maps a known-valid token to its scope.
 */
export function resolvePrincipal(
  token: string,
  adminTokens: readonly string[],
  scopedPrincipals: readonly ScopedPrincipalConfig[],
  opts?: { enforceScoping?: boolean },
): Principal | null {
  const scoped = scopedPrincipals.find((p) => p.token === token);
  if (scoped) {
    // An explicit `isAdmin` principal is the only way to get admin once scoping
    // enforcement is on; otherwise the entry is enforced to its source set.
    return scoped.isAdmin
      ? { kind: "admin" }
      : { kind: "scoped", allowedSourceIds: scoped.allowedSourceIds };
  }
  if (adminTokens.includes(token)) {
    // Plain `API_TOKENS` tokens are admin for backward compatibility. With
    // scoping enforcement on, they authenticate but resolve to deny-all — admin
    // must be granted explicitly via an `isAdmin` principal.
    return opts?.enforceScoping
      ? { kind: "scoped", allowedSourceIds: [] }
      : { kind: "admin" };
  }
  return null;
}

/**
 * The enforced source-id set for a principal.
 *   - admin  => `null` (unrestricted).
 *   - scoped => its `allowedSourceIds` (possibly `[]` => fail closed).
 */
export function computeEnforcedSourceIds(
  principal: Principal,
): string[] | null {
  return principal.kind === "admin" ? null : principal.allowedSourceIds;
}

/** Convert a principal into the `AuthorizationScope` threaded into retrieval. */
export function principalToScope(principal: Principal): AuthorizationScope {
  return { enforcedSourceIds: computeEnforcedSourceIds(principal) };
}

/**
 * Compute the EFFECTIVE source-id filter the SQL must apply, given the caller's
 * optional convenience filter and the principal's enforced set.
 *
 *   enforced = null (admin):
 *     - no caller filter   => null   (no restriction)
 *     - caller filter [..] => the caller filter (admin may narrow at will)
 *   enforced = [..] (scoped):
 *     - no caller filter   => the enforced set
 *     - caller filter [..] => intersection(caller, enforced)  (narrow within scope)
 *   enforced = [] (scoped, empty):
 *     - always []          => fail closed, zero rows
 *
 * The caller filter can only ever NARROW within the enforced set; it can never
 * widen beyond it. A disjoint caller filter yields `[]` (zero rows), not an
 * error — the caller simply asked for sources they cannot see.
 *
 * Returns `null` only for the genuine admin-unrestricted case. Any non-null
 * array is passed verbatim to `hybridSearch`'s mandatory `enforcedSourceIds`.
 */
/**
 * Pure per-document scope check for the FETCH-BY-ID boundaries (REST
 * `GET /documents/:id`, the MCP `get_document` tool, and the `documents://{id}`
 * resource). Unlike `effectiveSourceFilter` (which narrows a search's WHERE
 * clause), this answers a single yes/no: may THIS principal read a document
 * that belongs to `sourceId`?
 *
 *   - `enforcedSourceIds === null` (admin / unrestricted) => ALWAYS allowed.
 *   - `enforcedSourceIds === []`   (fail closed)           => NOTHING allowed.
 *   - `enforcedSourceIds === [..]` (scoped)                => allowed only when
 *     `sourceId` is in the set.
 *
 * Callers MUST treat a `false` result as NOT FOUND (return the same response a
 * genuinely-missing id returns) so a forbidden document is indistinguishable
 * from one that does not exist — never reveal its existence or its source.
 */
export function isSourceAllowed(
  scope: AuthorizationScope,
  sourceId: string,
): boolean {
  // Admin / unrestricted sees everything.
  if (scope.enforcedSourceIds === null) return true;
  // Scoped (including the empty fail-closed set): allowed iff in the set.
  return scope.enforcedSourceIds.includes(sourceId);
}

export function effectiveSourceFilter(
  callerSourceIds: readonly string[] | undefined,
  enforcedSourceIds: readonly string[] | null,
): string[] | null {
  // Admin / unrestricted: the caller's optional filter (if any) is the only
  // restriction, and absent means "search everything".
  if (enforcedSourceIds === null) {
    return callerSourceIds ? [...callerSourceIds] : null;
  }

  // Scoped. Empty enforced set => fail closed regardless of caller input.
  if (enforcedSourceIds.length === 0) return [];

  const enforcedSet = new Set(enforcedSourceIds);

  // No caller filter => the full enforced set.
  if (!callerSourceIds) return [...enforcedSourceIds];

  // Caller filter => intersection (narrow within scope; never widen).
  return callerSourceIds.filter((id) => enforcedSet.has(id));
}
