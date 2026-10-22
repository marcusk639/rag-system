---
paths:
  [
    "packages/core/src/*auth*.ts",
    "packages/runtime/src/index.ts",
    "apps/api/src/auth.ts",
  ]
---

## Adding a new auth provider

1. Implement `AuthProvider` (`authenticate(credential) → Promise<Principal | null>`) in `packages/core/src/`. Fail closed: return `null` for anything you can't positively authenticate; never throw for a bad credential.
2. Add its config shape to `AuthProviderConfig` and a `case` in `createAuthProvider` (`packages/core/src/auth-provider-factory.ts`). Keep env parsing OUT of core — it lives in the runtime/app config layer.
3. Wire env → config in `buildAuthProvider` (`packages/runtime/src/index.ts`).
4. Document the env vars in `env.example`.
