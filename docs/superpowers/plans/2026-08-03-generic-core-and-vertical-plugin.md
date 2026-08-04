# Generic Core + Vertical Plugin — making `rag-system` consumable

> ## ⛔ SUPERSEDED as the build order (marked 2026-08-03) — read §0 anyway
>
> **The live design is
> [`../specs/2026-08-03-multi-vertical-rag-platform-design.md`](../specs/2026-08-03-multi-vertical-rag-platform-design.md).**
> It supersedes the 2026-07-17 tenancy spec that this plan implements, and
> explicitly _"replaces its code-plugin-first mechanism with data-first packs."_
> Confirmation that the packs design is the one being built:
> [`2026-08-03-local-generation.md`](./2026-08-03-local-generation.md) — the only
> committed 2026-08-03 plan — names that spec as its source.
>
> **Where the two disagree, follow the spec:**
>
> |                | This plan                                        | The packs spec                   |
> | -------------- | ------------------------------------------------ | -------------------------------- |
> | Mechanism      | `packages/plugin-cpa/` + `PluginRegistry` (code) | `packs/cpa/pack.yaml` (data)     |
> | npm publishing | Phase 2 — publish `@rag/core` + `@rag/rag`       | §7 **out of scope**, explicitly  |
> | First step     | Phase 1, externalize the prompt                  | §8.1 — slice 2, local generation |
>
> **What is still worth reading here, and is not duplicated in the spec:**
>
> - **§0a** — the three-tier inventory of what is CPA-specific in core today, with file:line citations. The spec assumes this; it does not restate it.
> - **§0b** — `apps/web` is already generic (`grep` for firm names returns nothing); only two hardcoded product-name strings.
> - **§0c** — all eight packages are `private: true` with no `files` allow-list, so `npm pack` would ship source and no `dist/`. Still true, still a trap if publishing is ever revisited.
> - **§0d** — `cpa-consulting` is a docs repo with no `package.json`; the 2026-07-17 spec placed the plugin there without checking.
> - **§1a** — the domain-neutral vs CPA-specific decomposition of the system prompt. The spec's slice 1a needs exactly this and does not contain it.
>
> Phases 1–6 below are **not** the build order. Do not execute them.

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `rag-system` a generic RAG platform that external projects consume
and extend — starting with the ability to supply a different system prompt and
configure retrieval/generation per deployment — with the TWK knowledge base
becoming a consumer rather than something baked into core.

**This implements an existing design.**
[`specs/2026-07-17-platform-tenancy-and-plugin-boundary.md`](../specs/2026-07-17-platform-tenancy-and-plugin-boundary.md)
already specifies three layers (core / vertical plugin / tenant config), a
`PluginRegistry` replacing the closed factory switches, and `@rag/plugin-cpa` in
the product repo. **Status: Design, zero implementation** — `grep -rn
"PluginRegistry\|RagPlugin\|DocumentClassifier" packages apps` → **0 hits**. Read
that spec before starting; this plan is its build order plus the gaps it did not
anticipate.

**Decided 2026-08-03:**

1. `apps/web` **stays generic in `rag-system`, branded per tenant** (spec §2.3, `APP_NAME`). It is not moving to a consumer repo.
2. **`@rag/*` packages may be published publicly** — but publishing is **not a prerequisite** (see decision 4). Phase 2 is deferred, not blocking.
3. **Core is not opinionated about any domain. Domain belongs to the consumer.**
4. **Do not split the repo to get the boundary.** The CPA plugin starts as a **workspace package in `rag-system`, built to be extractable**. TWK's _deployment_ — prompt file, tenant env, folder exclusions, staff roster — lives in a consumer repo (`twk-kb` or `cpa-consulting`).

> ### Decision 4 needs one distinction to be coherent
>
> "Keep it as a workspace package" and "it lives in `cpa-consulting` or `twk-kb`"
> are describing **two different artifacts**, and conflating them is how this goes
> wrong:
>
> | Artifact                               | What it is                                                                                                                           | Where it lives         | Why                                                                                                                                                         |
> | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **`packages/plugin-cpa/`**             | CPA _code_ — classifier, prompt text, optional generator wrapper                                                                     | `rag-system` workspace | Needs to compile against `@rag/core`. Publishing purely to satisfy a repo boundary buys nothing at this team size.                                          |
> | **`twk-kb/`** (or in `cpa-consulting`) | TWK _deployment_ — `SYSTEM_PROMPT_PATH` target, tenant env, SharePoint folder exclusions, staff roster, the content-boundary runbook | Consumer repo          | Firm data and firm config. Already required to stay out of core by the content-boundary plan. Mostly **not code**, so it needs no package mechanism at all. |
>
> **Say the quiet part:** under decision 4 the `rag-system` _repo_ still contains
> CPA code, even though `@rag/core` does not. That is a real cost and it is worth
> paying for now — but it means the boundary has to be **enforced**, not merely
> intended.
>
> **What actually makes it "extractable" is not where the files sit — it is
> whether the dependency boundary holds.** A workspace package that reaches into
> `@rag/db`, relative-imports across package roots, or touches the scope/audit
> machinery is not extractable no matter which repo it is in. So Task 4.4 adds a
> mechanical check. Without it, "extractable later" is a sentence in a doc that
> stops being true in about three commits.

> ### What decision 3 changes, and it is not cosmetic
>
> The earlier draft of this plan made the CPA system prompt **overridable, with
> itself as the default**. That is not the same thing. A default that ships CPA
> framing means every consumer who doesn't override it gets a knowledge-base
> assistant that announces itself as working for "a CPA firm of roughly 20 staff"
> and cites `BK-CATCHUP`. Overridable-but-CPA-by-default is still an opinionated
> core; it just hides the opinion behind a config key nobody sets.
>
> So the target is stronger: **the CPA framing leaves core in Phase 1**, not
> Phase 4, and what remains as the default is the domain-neutral part — which is
> most of it, and is genuinely reusable (see §1a). For Phase 5's compliance
> machinery the question is no longer _whether_ it leaves core, only _when_.

**Tech Stack:** TypeScript, pnpm workspaces, Fastify, Drizzle/Postgres, vitest.

---

## Global Constraints

- **The confidentiality boundary stays in core.** Spec §1: _"the confidentiality/scoping/audit boundary (per-user scope, `dataClass` gate, `resolveSourceIdsForUser`, `InternalScopeAuthProvider`) lives **only in core**. Plugins add domain *behavior* … but can never widen or reimplement the security boundary."_ A plugin may _classify_ into `dataClass`; it may never _enforce_ access, and it may never call outside `EGRESS_ALLOWED_HOSTS`.
- **Non-breaking, one factory at a time.** Spec §3.2: built-ins register themselves; behavior stays identical until a plugin adds something. No big-bang refactor.
- **No dynamic plugin loading.** Spec §6: static, in-image plugins only — `PLUGINS=cpa` selects among registered implementations; there is no `import()` of arbitrary paths. This keeps the supply chain and the egress boundary auditable.
- **Sequencing: containment before architecture.** [`2026-08-03-kb-content-boundary.md`](./2026-08-03-kb-content-boundary.md) Phase 1 removes confirmed Class D data (a 522-SSN client roster) from the live index. **Do that first.** Refactoring the platform while that sits retrievable is the wrong order.
- Commit format `<type>: <description>`. Pre-commit runs prettier + secret scan + 800-line cap — never `--no-verify`.
- ⚠ `pnpm typecheck` is RED on `main` (5 pre-existing `eval-faithfulness.spec.ts` errors). Not your regression.

---

# Phase 0 — Discovery

## 0a. What is CPA-specific in core today, in three tiers

Tier 1 is behavior a non-CPA deployment would get **wrong**. Tier 3 is cosmetic.
Treat them very differently — conflating them turns a 2-day job into a month.

**Tier 1 — must become pluggable:**

| What                                                                                                                                               | Where                                                                               | Why it's Tier 1                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SYSTEM_PROMPT` — _"You are the knowledge-base assistant for a CPA firm of roughly 20 staff…"_, with `BK-CATCHUP` and Karbon in the worked example | `packages/rag/src/generation/generator.ts:39`, consumed at `:330, :352, :398, :420` | A module `const`. Any other domain gets CPA framing with no override. **This is the one you named.** |
| `REVIEW_STATUS = "draft_requires_practitioner_review"` + `ANSWER_DISCLAIMER` stamped on **every** answer                                           | `packages/services/src/ask.ts:51-59`                                                | A Circular 230 §10.37 artifact hardcoded in the transport-agnostic service layer                     |
| TRI scanner — IRC §7216 pattern machinery                                                                                                          | `packages/core/src/tri-scanner.ts` (15 CPA/tax refs)                                | An entire US-tax module inside `@rag/core`                                                           |
| Class A/B/C/D semantics; `ClassBlockedError` citing §314.4(f) and §7216                                                                            | `packages/core/src/types.ts:30-35`, `errors.ts:71-84`                               | CPA compliance vocabulary in the generic type layer                                                  |

**Tier 2 — CPA-shaped but generalizes:** `dataClassEnum`
(`general|research|sop|client_confidential`), `contentTypeEnum`,
`complianceMode: "client-data"`, the DPA-file check in `loadConfig`.

**Tier 3 — comments only:** `access-control.ts:5` and `metadata-policy.ts:6` both
open _"This RAG system indexes a CPA firm's confidential corpus."_ No behavior;
rewrite opportunistically, never as a task.

## 0b. `apps/web` is already generic — it just isn't configurable

Good news for the decision above: `grep -rniE "twk|terranova"` over `apps/web/src`
returns **nothing**. There is no TWK branding to remove. But `APP_NAME` is
referenced **nowhere**, and the product name is hardcoded twice:

- `apps/web/src/app/layout.tsx:8` — `title: "RAG Knowledge Hub"`
- `apps/web/src/components/knowledge-base/knowledge-base.tsx:35` — the `<h1>`

Per-tenant branding is a two-line change plus an env var (Phase 6), not a port.

## 0c. ⛔ The consumption mechanism does not exist

The spec says `@rag/plugin-cpa` _"depends on `@rag/core` (+ `@rag/rag`)"_. **There
is currently no way for anything outside this repo to depend on them.**

```
@rag/core   0.1.0  private=true  files=no  publishConfig=no
@rag/rag    0.1.0  private=true  files=no  publishConfig=no
@rag/db     0.1.0  private=true  files=no  publishConfig=no
@rag/runtime 0.1.0 private=true  files=no  publishConfig=no
```

All eight workspace packages are `"private": true` with no `files` allow-list and
no `publishConfig`. They resolve internally via the workspace protocol and build
to `dist/` (root `CLAUDE.md`: tests resolve via built `dist/` entry points, which
is why `pnpm test` fails on a fresh clone). **Nothing is publishable.** Phase 2
exists solely to fix this, and everything downstream is blocked on it.

## 0d. ⛔ `cpa-consulting` is not a code repo

The spec places the plugin in _"the product repo (`cpa-consulting`)"_. That repo
has **no `package.json`, no `tsconfig.json`, no `src/`, `packages/`, or `apps/`**
— it is a strategy/planning docs repo (with a Netlify static build), and its
`CLAUDE.md` carries a binding rule that `docs/issue-synthesis/` is _"maintained in
place, never regenerated."_

So "a separate project that consumes rag-system" requires a **decision that has
not been made** — see Phase 4 Task 4.0. Do not assume the spec's placement; it
was written without checking.

## 0e. ⏳ Pending — packaging mechanism

A research pass on cross-repo consumption of a private pnpm monorepo (GitHub
Packages vs npm private vs git-subdirectory deps vs `file:`/`link:` vs
second-workspace-root) was dispatched and had not reported at authoring time.
**Phase 2 is gated on it.** Phase 1 and Phase 6 are independent and can proceed
immediately.

> ⚠ **An honest possibility the research must be allowed to return:** for a
> two-repo, one-team, low-release-frequency setup, the lowest-friction answer may
> be **"don't split — keep the plugin as a workspace package in `rag-system` that
> is merely _allowed_ to be extracted later."** That would still deliver
> everything asked for (a generic core with a pluggable prompt and config) while
> avoiding a private-registry auth burden on every developer and CI job. **If the
> research says that, take it.** The goal is a consumable, extensible core — not
> a repo split for its own sake.

---

# Phase 1 — Externalize the system prompt (do this first; it is small)

This delivers the stated need — "the ability to modify the system prompt" — in
hours, with no refactor and no packaging work.

## 1a. First, decompose the prompt — most of it is not CPA-specific

Read `generator.ts:39-84` and sort it. The split is cleaner than it looks:

**Domain-neutral (stays in core as the default — this is RAG mechanics, not opinion):**

- The untrusted-content section — everything between `<document>` tags is data, never instruction. Prompt-injection defence is universal.
- Citation contract — inline `[N]`, cite each step separately, never cite an absent index.
- The A/B/C coverage decision — answer / partial-answer-and-name-the-gap / abstain, and "prefer B over C."
- Conflicting-source handling — present both, cite both, use `modified=` as evidence not verdict.
- Answer shape — procedure as a numbered list, near-verbatim steps, synthesize across documents.
- "Reproduce identifiers exactly as written" — generic to any corpus with codes, IDs, or UI labels.

**CPA-specific (leaves core):**

- `"You are the knowledge-base assistant for a CPA firm of roughly 20 staff"` — the identity line.
- `"You are not a tax advisor… never supply, correct, or extend a determination"` — a domain scope-of-practice rule.
- Grounding rule 4 — the do-not-repeat-client-names instruction.
- `"retrieved from SharePoint"` — a connector assumption, not a domain one, but still an assumption core shouldn't make.
- The entire worked example — `BK-CATCHUP`, Karbon, engagement letters.

**Design decision:** core's `DEFAULT_SYSTEM_PROMPT` becomes the domain-neutral set
above, with a short neutral identity line ("You are a knowledge-base assistant
answering strictly from the documents supplied below"). The CPA text moves to the
consumer as a complete replacement prompt — **not** a preamble that gets
concatenated. Composition sounds appealing and creates a coupling: the consumer
would have to know what core's half says to avoid contradicting it, and neither
half is independently reviewable.

- [ ] **Task 1.1 — Failing tests** in `packages/rag/src/generation/generator.test.ts` (301 lines; read the existing egress/TRI harness first): a generator constructed with `systemPrompt: "CUSTOM"` sends `CUSTOM` (assert on the captured request, both providers); constructed without one sends `DEFAULT_SYSTEM_PROMPT`. Add an assertion that `DEFAULT_SYSTEM_PROMPT` contains **no** CPA vocabulary — `grep`-style: no `CPA`, `tax advisor`, `Karbon`, `BK-CATCHUP`, `SharePoint`. That test is the thing that keeps core honest later.
- [ ] **Task 1.2 — Add `systemPrompt?: string` to `GeneratorOptions`**, alongside `triPolicy`/`onTriDetected`. Replace the four consumption sites (`:330, :352, :398, :420`) with `this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT`. Export `DEFAULT_SYSTEM_PROMPT`.
- [ ] **Task 1.3 — Write the domain-neutral default** from the §1a split. **⚠ Carry the header comment across** (`generator.ts:19-38`): it documents three load-bearing properties — near-verbatim steps, partial-answer-beats-refusal, conflicts-surfaced-never-resolved — each with the failure it prevents. Those properties are all in the neutral half, so they stay; a consumer replacing the prompt needs to know they exist.
- [ ] **Task 1.4 — Wire `SYSTEM_PROMPT_PATH`** through `loadConfig` → `buildCoreDeps` → `createGenerator`. Read at startup; **fail loud** if set-but-unreadable. A silently-defaulting prompt is the worst outcome — the deployment looks configured and isn't.
- [ ] **Task 1.5 — ⚠ Ship TWK's prompt in the same change.** This is a **behavior change for the running pilot**: once the default is neutral, TWK gets a materially different assistant unless `SYSTEM_PROMPT_PATH` is set at the same deploy. Put the current CPA text in a file the TWK deployment points at, and verify with one real question before/after that the answer is unchanged. Do not land Task 1.3 and Task 1.5 in separate deploys.
- [ ] **Task 1.6 — Document in `env.example`** beside `GENERATION_*`: the default is domain-neutral, and a domain deployment is expected to supply its own.

**Verify:** `pnpm --filter @rag/rag test` green; the no-CPA-vocabulary assertion
passes; TWK's configured prompt produces a byte-identical request to today's.

**Anti-pattern guards:** do not put prompt text in an env var — a 60-line prompt
belongs in a reviewable file. Do not delete the default — an unconfigured
deployment must still work, it just answers generically. Do not build
preamble-concatenation.

---

# Phase 2 — Publish to public npm (DEFERRED — not a prerequisite)

> **Do not do this yet.** Decision 4 makes the plugin a workspace package, so
> nothing needs to be published for the boundary to exist. This phase stays here
> because publishing is the eventual move once there is a second consumer — and
> because a few of its prerequisites (§2.1's packaging trap) are worth fixing
> early regardless, since they are cheap now and invisible until they bite.
>
> **Skip to Phase 3 unless a genuine external consumer appears.**

When it does happen: **publish `@rag/core` and `@rag/rag` publicly.** Public
publishing removes every friction point the research surfaced for the private
options — no `.npmrc` auth for consumers, no classic-PAT-per-developer, no
per-seat cost, CI works with no secret, and semver ranges work normally.

Rejected, with reasons:

| Option                                     | Why not                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Packages**                        | Auth is **classic-PAT only** (no fine-grained tokens); `GITHUB_TOKEN` only reaches packages in its _own_ repo, so a cross-repo install needs a shared PAT; and the **scope must equal the GitHub org login** — `@rag/*` would only work under an org literally named `rag`.                                                                                     |
| **npm private (Teams)**                    | **$7/user/month charged for every org member**, for an internal 2-repo reuse case.                                                                                                                                                                                                                                                                              |
| **Git subdirectory (`path:`)**             | Real but the least-hardened path — two load-bearing bugs fixed in 2026 alone ([pnpm#12304](https://github.com/pnpm/pnpm/issues/12304), fixed in 11.7, where `path:` was silently stripped from the lockfile and installs **resolved the repo root instead, with no error**). Also needs `allowBuilds` allow-listing plus a `prepare` script that doesn't exist. |
| **`file:`/`link:`**                        | Local-dev only; dies in CI or on any machine without both repos checked out at the matching relative path. Keep as a dev supplement.                                                                                                                                                                                                                            |
| **Cross-repo workspace root / `catalog:`** | Not a documented pnpm pattern. `catalog:` is version-pinning _within one_ workspace and is unrelated.                                                                                                                                                                                                                                                           |
| **GitHub Release tarballs**                | The research's top pick **for private packages** — but public npm beats it on every axis (semver ranges, `pnpm outdated`, no manual URL bumps).                                                                                                                                                                                                                 |

> ⚠ **The scope name is not yet confirmed available.** `@rag/core` and `@rag/rag`
> both 404 on the registry and the `@rag` scope has **0 packages**, which is a
> strong signal — but npm scopes bind to a user/org account, so "no packages"
> does not prove the **org name `rag`** is unclaimed. **Task 2.0 is to try to
> create it.** If taken, renaming the scope touches every `package.json`, every
> internal import, and every consumer — cheap now, expensive after Phase 4.

- [ ] **Task 2.0 — Claim the npm scope before anything else.** If `@rag` is unavailable, pick the replacement now (`@ragkit`, `@rag-system`, …) and rename in one commit.
- [ ] **Task 2.1 — ⛔ Fix the packaging trap first; it is verified and it silently ships a broken package.** `dist/` is gitignored (`.gitignore:6`) and **no package has `files`, `prepack`, or `prepublishOnly`** (confirmed: `grep -l '"files"\|"prepack"' packages/*/package.json` → none). With no `files` allow-list, `npm pack` falls back to "everything not gitignored" — so the published tarball would contain **source but no `dist/`, no `.js`, no `.d.ts`**. It installs fine and then fails to resolve. Add to each published package: `"files": ["dist"]`, `"prepack": "pnpm build"`, and drop `"private": true`. `exports.types` is **already correct** (`./dist/index.d.ts`) — do not touch it.
- [ ] **Task 2.2 — Versioning.** All eight packages are pinned at `0.1.0`; npm rejects republishing a version. Pick a release mechanism (changesets, or manual `pnpm version` at low frequency) before the first publish, not after.
- [ ] **Task 2.3 — Decide the public API surface.** Every package currently barrel-exports everything from `index.ts`; publishing that makes all of it a compatibility surface you owe semver on. **Publish only `@rag/core` and `@rag/rag`.** `@rag/db`, `@rag/runtime`, `@rag/ingestion`, `@rag/connectors`, `@rag/services` stay private — a plugin has no business importing them, and `@rag/db` in particular would expose the confidentiality machinery the Global Constraints say stays in core.
- [ ] **Task 2.4 — Prove it end to end before building on it.** A throwaway project outside this repo: `pnpm add @rag/core`, import one symbol, `tsc --noEmit`. Do not proceed on a mechanism that has only been reasoned about — the `files` trap above is exactly the kind of thing that only shows up here.
- [ ] **Task 2.5 — ⚠ Public means public.** Once published, the code is world-readable and versions are effectively permanent (unpublish windows are narrow). Before the first publish, confirm no package embeds firm-specific content — which is precisely what Phase 1 and Phase 5 remove. **Do not publish before Phase 1 lands**, or the CPA prompt ships to the public registry.

---

# Phase 3 — Registry refactor in core (spec §3.2, non-breaking)

- [ ] **Task 3.1** — Add `PluginRegistry` + `RagPlugin` to `@rag/core` exactly as the spec sketches (§3.2 lines 105-119). Ship a `DocumentClassifier` interface and a **default no-op classifier**, so the seam exists before anything fills it.
- [ ] **Task 3.2** — Convert factories to registries **one at a time**, built-ins registering themselves. Order by risk, lowest first: `createReranker` (2 providers, freshly tested, just gained an `opts` bag) → `createGenerator` → `createChunker` → `createConnector` (6 providers, most surface). After each, the full suite must be green with **zero behavior change**.
- [ ] **Task 3.3** — `buildCoreDeps` builds the registry, seeds built-ins, then loads plugins named in `config.plugins` (`PLUGINS=cpa`) and calls `register()`.
- [ ] **Task 3.4** — Tests: a registered custom generator is selected by name; an unknown plugin name fails **loud at startup**, not at first query.

**Anti-pattern guards:** no dynamic `import()` (spec §6). Do not let a plugin
register anything that touches scope, audit, or the `dataClass` gate — add a test
asserting the registry has no such extension point.

---

# Phase 4 — The CPA vertical plugin

Settled by decision 4: `packages/plugin-cpa/` in this workspace, built so that
extracting it later is a `git mv` plus a `package.json` dependency swap.

- [ ] **Task 4.1 — Create `packages/plugin-cpa/`.** Depends on `@rag/core` (and `@rag/rag` for base classes) via `workspace:*` — **and nothing else from this repo**. Contents: the CPA prompt file that Phase 1 moved out of core, and the `DocumentClassifier` the spec calls _"the primary CPA seam."_ Add it to `pnpm-workspace.yaml`.
- [ ] **Task 4.2 — Register through the Phase 3 registry**, not by editing a core factory. If registering the plugin requires touching a `switch` in core, Phase 3 is incomplete — go back.
- [ ] **Task 4.3 — Keep firm data out of the plugin too.** The plugin holds _domain_ logic (what a CPA SOP looks like); TWK folder exclusions, the staff roster, and POL-01 class rules are _firm_ data and belong in the deployment repo. The distinction is "would another CPA firm reuse this?" — same test the content-boundary plan applies.
- [ ] **Task 4.4 — ⛔ Enforce the extraction boundary mechanically.** This is the task that makes decision 4 honest rather than aspirational. Add a check (an eslint `no-restricted-imports` rule, a `depcruise` config, or a test that walks the import graph) asserting `packages/plugin-cpa/**` imports **only** from `@rag/core` and `@rag/rag` public entry points — never `@rag/db`, `@rag/runtime`, `@rag/services`, `@rag/ingestion`, `@rag/connectors`, and never a relative path escaping the package root. Wire it into `pnpm lint` so CI enforces it. **Without this, "extractable later" stops being true within a few commits and nobody notices until extraction day.**
- [ ] **Task 4.5 — Write the extraction procedure down** in the plugin's README, in five lines: `git mv` to the new repo, swap `workspace:*` → a published version, run Phase 2, done. A boundary you can't describe the crossing of isn't one.
- [ ] **Task 4.6 — Move `examples/cpa-kb-demo`** (CPA synthetic docs: `1040-intake-checklist.md`, `boi-filing-sop.md`, `k1-treatment-reference.md`, `karbon-template-catalog.md`) into the plugin or the deployment repo, or replace it with a domain-neutral example. Low priority — demo data, not behavior.

## Phase 4b — The TWK deployment repo (`twk-kb` or in `cpa-consulting`)

Separate artifact, mostly **not code** — so the choice between a new repo and a
folder in `cpa-consulting` is low-stakes and reversible. Pick either.

- [ ] **Task 4b.1** — Holds: the TWK `SYSTEM_PROMPT_PATH` file, tenant env (`tenants/twk.env` per spec §2.3), SharePoint folder exclusions, staff roster, and the content-boundary runbook.
- [ ] **Task 4b.2 — Move [`2026-08-03-kb-content-boundary.md`](./2026-08-03-kb-content-boundary.md) here.** It is entirely TWK-specific and currently sits in `rag-system/docs/`, which is exactly the coupling this plan exists to remove. Its _code_ tasks stay in `rag-system`; the firm-specific runbook goes with the deployment.
- [ ] **Task 4b.3 — ⚠ If it lands in `cpa-consulting`, respect that repo's rules.** Its `CLAUDE.md` binds `docs/issue-synthesis/` as _"maintained in place, never regenerated"_ — do not let a deployment folder disturb it.

---

# Phase 5 — Move the compliance artifacts out of core (LAST, and deliberately so)

Tier 1's remaining items — the TRI scanner, the Circular 230 disclaimer, Class
A/B/C/D — are the hardest and **must come last**.

**Why last, explicitly:** these are the machinery the TWK pilot's regulatory
posture rests on, and the corpus currently has confirmed Class D data in it.
Relocating §7216 controls while that is true, on a system in front of real staff,
trades a real compliance property for an architectural one. Do it when the
corpus is clean and the pilot is stable.

- [ ] **Task 5.1** — `ANSWER_DISCLAIMER` / `REVIEW_STATUS` (`services/ask.ts:51-59`) become configurable with the current text as default. Smallest and safest of the three — start here.
- [ ] **Task 5.2** — TRI scanning moves behind a core interface (`ContentScanner`?) that the CPA plugin implements. Core keeps the _hook_ and the egress/policy enforcement; the _patterns_ go to the plugin. Note the identifying-vs-contextual split (`tri-scanner.ts:95-131`) is recent and carries real corpus evidence in its doc comment — **move it intact**.
- [ ] **Task 5.3** — Generalize `DocumentClass` A/B/C/D to a domain-neutral sensitivity tier, with the CPA meanings supplied by the plugin. **Highest-risk change in this plan** — `dataClass` gates ingestion (`pipeline.ts:245`) and the enum collapses Class C and D into one value, so, per `r5-compliance-gate.md`, _"any change that lets C through lets D through."_ Treat as its own spec, not a task.

---

# Phase 6 — Per-tenant branding (independent; do any time)

- [ ] **Task 6.1** — Add `APP_NAME` (default `"RAG Knowledge Hub"`) and consume it at `apps/web/src/app/layout.tsx:8` and `knowledge-base.tsx:35`.
- [ ] **Task 6.2** — Document in `env.example` per spec §2.3.

---

# Final Phase — Verification

- [ ] `pnpm -r build` · `pnpm lint` 0 errors · full unit suite green.
- [ ] `pnpm typecheck` shows **only** the 5 pre-existing `eval-faithfulness.spec.ts` errors.
- [ ] **The behavior-unchanged proof — note the one deliberate exception.** With no `PLUGINS` and no `APP_NAME`, everything is byte-identical to today. **The prompt is not**: Phase 1 intentionally makes the unconfigured default domain-neutral, so an un-configured deployment now answers generically. That is the point of decision 3, not a regression. **The proof that matters instead:** the TWK deployment, with its `SYSTEM_PROMPT_PATH` set, produces a byte-identical request to today's. Verify that before deploying Phase 1 (Task 1.5).
- [ ] `grep -rniE "CPA|§7216|Karbon|BK-CATCHUP|tax advisor" packages/core/src packages/rag/src packages/services/src` → **zero** after Phase 1 and Phase 5. Tier-3 comment hits (`access-control.ts:5`, `metadata-policy.ts:6`) are acceptable until Phase 5; nothing behavioral is.
- [ ] Registry has no extension point touching scope/audit/`dataClass` enforcement (Phase 3 test).
- [ ] **The extraction-boundary check is wired into `pnpm lint` and fails on a deliberate violation** — add `import { createDb } from "@rag/db"` to the plugin, confirm lint goes red, revert. An unverified boundary check is worse than none: it grants false confidence at exactly the moment it matters.
- [ ] **The consumability proof, adapted to decision 4:** since nothing is published yet, the achievable test is that `packages/plugin-cpa` supplies a custom prompt and a classifier **through the public seams only**, and gets an answer. That is the same acceptance criterion as an external consumer, minus the distribution step — which is precisely the claim decision 4 makes. If publishing happens later (Phase 2), re-run it from a genuinely external project.
- [ ] Update `specs/2026-07-17-platform-tenancy-and-plugin-boundary.md` status from Design to reflect what shipped, and record the 0c/0d gaps it did not anticipate.
- [ ] Reconcile `docs/DECISION-CPA-KB-RAG-CONVERGENCE.md` — it says rag-system is "platform of record" and deprecates a standalone repo. That decision concerned a **UI mock**, and `apps/web` staying generic is consistent with it — but say so explicitly, or the next reader will think this reverses it.
