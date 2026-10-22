---
title: Multi-vertical platform — remaining work
status: current
last_verified: 2026-10-21
verified_against: ae08541
answers: Which slices of the multi-vertical (core plus vertical pack) design are built, and what each unbuilt slice must do and must not break.
read_when: Making core domain-neutral, opening the data-class tiers, adding DB-resident settings or an admin surface, or building pack conformance, acceptance or drift checks.
supersedes:
  [
    archive/specs/2026-08-03-multi-vertical-rag-platform-design.md,
    archive/plans/superpowers/2026-08-03-generic-core-and-vertical-plugin.md,
    archive/specs/2026-07-11-generic-document-classification-engine-design.md,
  ]
code:
  [
    packages/core/src/pack/load.ts,
    packages/core/src/pack/schema.ts,
    packs/cpa/pack.yaml,
    packages/rag/src/generation/generator.ts,
    packages/services/src/ask.ts,
    packages/db/src/schema.ts,
    packages/core/src/types.ts,
    packages/ingestion/src/pipeline.ts,
    packages/ingestion/src/classify-source.ts,
    packages/ingestion/src/classify-document.ts,
  ]
---

# Multi-vertical platform — remaining work

This spec answers what is left of the multi-vertical design, under which the same core image serves several regulated
verticals (CPA firms, insurance, banking, hospitals, behavioural health). Domain policy lives in a data-only
**vertical pack** (`packs/<vertical>/`), and each client runs an isolated deployment of its own. **Bottom line on
2026-10-21:** local generation, the pack scanner engine and redact-before-persist are built. Core is still
CPA-specific in its system prompt, answer disclaimer and data-class taxonomy. Slices 1a, 1b, 3 and 4 are open, and
none of the documentation the design promised exists yet.

The principles behind this spec are recorded elsewhere:

- core enforces and packs supply policy, with no dynamic loading and no npm publishing
  ([D-32](../architecture/DECISIONS.md#d-32-core-enforces-packs-supply-policy));
- one isolated deployment per tenant
  ([D-05](../architecture/DECISIONS.md#d-05-one-isolated-deployment-per-tenant));
- the TRI gate is never relaxed automatically for local endpoints
  ([D-34](../architecture/DECISIONS.md#d-34-never-auto-relax-the-tri-gate-for-local-endpoints));
- scanners split into identifying and contextual, and redaction is an egress control
  ([D-35](../architecture/DECISIONS.md#d-35-content-safety-layering), detailed in
  [CONTENT-SAFETY-DESIGN](../compliance/CONTENT-SAFETY-DESIGN.md)).

This spec restates only what a slice implementer needs. The sensitivity-boundary versus retrieval-scope distinction
has no decision entry yet, so it is stated in the next section. The original design is archived at
[../archive/specs/2026-08-03-multi-vertical-rag-platform-design.md](../archive/specs/2026-08-03-multi-vertical-rag-platform-design.md).

## Slice status

| Slice                                | What it delivers                                                                     | Status                       | Evidence in code                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 — local generation                 | `GENERATION_BASE_URL` for OpenAI-compatible self-hosted endpoints; egress-check fix  | **Done**                     | `packages/rag/src/generation/generator.ts` `effectiveBaseURL`, `GEMINI_BASE_URL_REFUSAL`; operator doc [../operations/LOCAL-GENERATION.md](../operations/LOCAL-GENERATION.md)                                                           |
| Pack scanner engine                  | Scanner patterns as pack data, a generic engine, and a fail-closed contract check    | **Done**                     | `packages/core/src/pack/{schema,registry,load,scan}.ts`; `packs/cpa/pack.yaml`; `PACK_CONTRACT_VERSION = "1.0.0"` in `load.ts`. Design: [sensitive-content-discovery.md](sensitive-content-discovery.md#the-pack-scanner-slice-shipped) |
| Redact before persist (§3.7 reorder) | Every refusing gate runs between parse and the first write or embed                  | **Done**                     | `packages/ingestion/src/pipeline.ts` `ingestOne`: Layer 1 redaction and Layer 3 quarantine run before `upsertDocument`; [CONTENT-SAFETY-DESIGN](../compliance/CONTENT-SAFETY-DESIGN.md#the-order-of-operations)                         |
| 1a — domain-neutral core             | Neutral default prompt; pack-supplied prompt and disclaimer                          | **Not done**                 | `SYSTEM_PROMPT` in `generator.ts` is the CPA prompt; `REVIEW_STATUS` and `ANSWER_DISCLAIMER` are hardcoded in `packages/services/src/ask.ts`; there is no `packs/cpa/prompt.md`                                                         |
| 1b — open tiers and provenance       | Pack-declared tiers, scanners behind pack policy, a `processingVersion`              | **Not done**                 | `dataClassEnum` is a four-value `pgEnum` in `packages/db/src/schema.ts`; `DocumentClass` is `z.enum(["A","B","C","D"])` in `packages/core/src/types.ts`; no `processingVersion` anywhere                                                |
| 3 — settings catalog                 | Typed settings with `protected` flags, DB-resident values, admin UI, scrub toggle    | **Not done**                 | No `adminEditable`, `scrubBeforeIndex` or settings table in `packages/` or `apps/`                                                                                                                                                      |
| 4 — verification framework           | Pack validation, conformance suite, nightly behavioural check, acceptance run, drift | **Partial: validation only** | `loadPack` checks the schema and contract version. There is no conformance suite, acceptance run or drift check                                                                                                                         |

The order still recommended is **1a → 1b → 3 → 4**. Slice 2 went first because it had no gate in front of it and
because its `GeneratorOptions` → config → `buildCoreDeps` path is the same one slice 1a's prompt has to travel.

## What a slice implementer must hold to

- **A pack supplies policy, never enforcement.** It can say what trips the sensitivity gate and what a tier means. It
  can't widen, disable or reimplement the gate, scoping or audit.
- **Extensions are registered names compiled into the image.** A pack refers to a validator, context matcher or
  classifier by name (`packages/core/src/pack/registry.ts`). Nothing is loaded by path at runtime.
- **The sensitivity boundary is pack-only, and DB config can't move it in either direction.** Retrieval scope
  (sources, folder exclusions, `topK`) is DB-editable, can widen or narrow, and every write is audited.
- **Pack/core compatibility fails closed.** `requiresCore` is a caret range against `PACK_CONTRACT_VERSION`, which is
  the version of the pack format's meaning, not the product version. Bump it only when the meaning of a field changes,
  a field becomes required, or a capability is removed.
- **No client data in diagnostics.** Anything a client runs and sends back carries counts and hashed ids, never titles
  or text.

## Slice 1a — domain-neutral prompt and disclaimer

**Goal:** an unconfigured core answers as a generic knowledge-base assistant, and the CPA framing is supplied by the
CPA pack. There is no schema migration and no pipeline change. The inputs are
[Appendix A](#appendix-a--cpa-specific-code-in-core) and [Appendix B](#appendix-b--system-prompt-decomposition).

### Today

- `SYSTEM_PROMPT` in `packages/rag/src/generation/generator.ts` is a module constant. All three generators (Gemini,
  OpenAI, Claude) send it, and nothing can override it. `GeneratorOptions` has no `systemPrompt` field.
- `REVIEW_STATUS = "draft_requires_practitioner_review"` and `ANSWER_DISCLAIMER` in `packages/services/src/ask.ts` are
  stamped on every answer. `AskResult.reviewStatus` is typed as `typeof REVIEW_STATUS`, so the literal is part of the
  API contract.
- The pack is loaded only by the worker (`apps/worker/src/deps.ts`, from `WORKER_SCANNER_PACK_DIR`, default
  `packs/cpa`). The API and MCP processes, where generation runs, load no pack.

### Work

1. Write a domain-neutral `DEFAULT_SYSTEM_PROMPT` from the neutral half of Appendix B. Give it a neutral identity line,
   for example "You are a knowledge-base assistant answering strictly from the documents supplied below."
2. Let a deployment supply a complete replacement prompt, threaded `GeneratorOptions` → config → `buildCoreDeps` →
   `createGenerator`, the same path `baseURL` took in slice 2.
3. Move the current CPA text into the CPA pack (the design's `packs/cpa/prompt.md`).
4. Make the disclaimer and review status pack-supplied, with the current CPA text as the CPA pack's value.
5. Test first: a generator built with a custom prompt sends it, on all three providers. One built without it sends
   `DEFAULT_SYSTEM_PROMPT`. `DEFAULT_SYSTEM_PROMPT` contains none of `CPA`, `tax advisor`, `Karbon`, `BK-CATCHUP` or
   `SharePoint`. That last assertion is what keeps core neutral later.

### Constraints

- **The CPA prompt is a full replacement, not a preamble.** Concatenating a domain preamble onto core's prompt couples
  the two. The pack author would have to know what core says to avoid contradicting it, and neither half could be
  reviewed alone.
- **Carry the header comment across.** The comment above `SYSTEM_PROMPT` documents three load-bearing properties:
  near-verbatim steps, a partial answer beats a refusal, and conflicts are surfaced, never resolved. Each comes with
  the failure it prevents. All three sit in the neutral half and stay in core.
- **Fail loud on a configured but unreadable prompt.** A prompt that silently falls back to the default leaves a
  deployment that looks configured and isn't.
- **Ship the neutral default and the CPA pack prompt in one deploy.** The live pilot's answers change the moment the
  default goes neutral. Before deploying, check that the CPA deployment produces a byte-identical generation request
  to the one it sends today.
- **No prompt text in an env var.** A prompt of about 45 lines belongs in a reviewable file. Keep the default as well,
  because an unconfigured deployment must still answer, just generically.
- **Not yet decided:** how the API and MCP processes get the pack. Either they call `loadPack` as the worker does, or
  a prompt path is configured separately (the superseded plan's `SYSTEM_PROMPT_PATH`). Decide this before writing
  task 2, and also whether `AskResult.reviewStatus` stays a literal type or widens to `string`, which is a contract
  change for `apps/web`, MCP and the Teams bot.
- **Branding is independent.** `apps/web` carries no firm branding. The product name "RAG Knowledge Hub" is hardcoded
  in `apps/web/src/app/layout.tsx` and `apps/web/src/components/knowledge-base/knowledge-base.tsx`, and no `APP_NAME`
  exists. A per-deployment name is a two-line change plus an env var, and can ship at any time.

## Slice 1b — open tiers and processing provenance

**Goal:** a pack declares its own sensitivity tiers and which of them are indexable, and core enforces "tier X is not
indexable, so refuse and log" without interpreting the labels. Reprocessing is driven by an explicit processing
version. This is the highest-risk slice, measured in weeks.

### Today

- `sources.data_class` is `pgEnum("data_class", ["general","research","sop","client_confidential"])`.
  `mapDataClassToDocumentClass` (`packages/ingestion/src/classify-source.ts`) maps `general` and `sop` to A,
  `research` to B and `client_confidential` to D, and throws on an unknown value.
- `classifyDocument` (`packages/ingestion/src/classify-document.ts`) can only make a document stricter than its source.
  Any `CLASS_D_IDENTIFIERS` hit (`ssn`, `ein`, `routing`, `card`) escalates it to D, a client-context path escalates it
  to C, and C or D is quarantined before `upsertDocument`. An identifying hit is therefore excluded today, whatever the
  pack's `disposition` says. Nothing branches on `disposition` ([KI-SAFE-8](../KNOWN-ISSUES.md#data-safety-and-compliance)).
- The generation-side patterns in `packages/core/src/tri-scanner.ts` are still TypeScript, separate from the pack, and
  they must agree with it ([CONTENT-SAFETY-DESIGN](../compliance/CONTENT-SAFETY-DESIGN.md#identifying-versus-contextual-patterns)).
- The content hash is `sha256("v" + CONTENT_PROCESSING_VERSION + "\n" + markdown)`, computed over the **redacted**
  markdown (`pipeline.ts` `CONTENT_PROCESSING_VERSION`, currently 2). The pack's version isn't part of it.

### Work

1. **Tiers in the pack.** For example:

   ```yaml
   tiers:
     - id: firm-internal
       label: "Class A — firm-internal, how-we-work"
       indexable: true
     - id: client-tax
       label: "Class D — client tax-return data"
       indexable: false
       reason: "requires §7216 consent workflow"
   ```

   This needs migration #1: `data_class` becomes `text` validated against the pack's vocabulary, `DocumentClass` is
   opened up, and the ingestion gate reads `indexable`.

2. **Scanners behind pack policy.** Move the `tri-scanner.ts` patterns onto the pack engine. Remove the hardcoded
   scanner ids (`kindFor` in `content-safety.ts`, `CLASS_D_IDENTIFIERS`), so that a new pack scanner can't mask text
   without recording or escalating it. Wire `disposition` into the gate, or drop the field.
3. **`processingVersion`** (migration #2). Record per document which `(scrub setting, scanner ruleset version)`
   produced its rows, and re-process when either changes:

   | Source  | Ruleset | Action     |
   | ------- | ------- | ---------- |
   | same    | same    | skip       |
   | same    | changed | re-process |
   | changed | any     | re-process |

4. **An operator view of exclusions.** A quarantined document leaves an `ingest_log` row and nothing else. To a user it
   looks the same as a document that was never synced. Ship the view with the tier change, not after the first support
   call.

### Constraints

- **The C/D collapse.** `data_class` has one value (`client_confidential`) for Class C and Class D, so any change that
  lets C through lets D through. The tier migration needs its own design pass before implementation, not just a task.
  See [KI-SAFE-11](../KNOWN-ISSUES.md#data-safety-and-compliance) and the root `CLAUDE.md` effort-calibration list.
- **Containment first.** The design gated this slice on confirmed Class D data being out of the live index. The
  2026-08-03 purge ([records/PURGE-RECORD-2026-08-03.md](../compliance/records/PURGE-RECORD-2026-08-03.md)) and the
  rebuilt corpus that passed Gate 1 on 2026-10-02 met that gate. Re-check it against
  [LAUNCH-STATUS](../launch/LAUNCH-STATUS.md) before starting.
- **Decide what the hash means before writing migration #2.** The design wanted `contentHash` to stay a hash of the
  pre-scrub source, with processing versioned separately. The code instead folds a processing version into a hash of
  the redacted text. Under either scheme, editing a pack pattern doesn't reach documents the connector doesn't offer
  again, so the policy changes and the corpus quietly doesn't. `processingVersion` must carry the pack version to close
  that gap.
- **Ship `processingVersion` here, not in slice 3.** Retrofitting provenance onto an ingested corpus means a full
  re-sync at every client.
- **Human review stays load-bearing.** Scanner false negatives are unmeasured. A client name in prose trips no pattern,
  so exclusion is a floor, not a guarantee.

## Slice 3 — settings catalog and admin surface

**Goal:** settings that take effect without a restart, editable by a client admin within limits that core enforces.
Nothing exists yet.

- **Three-way ownership.** Core owns the **catalog**: which settings exist, their types and ranges, and which are
  `protected` (for example, `tiers` is protected and `retrieval.topK` is an integer from 1 to 100). The pack owns
  `adminEditable`, the unprotected settings this vertical exposes. The DB owns current values, plus who changed them
  and when.
- **A pack that lists a protected setting fails at boot**, not at first edit. "No pack can expose a protected setting"
  is a single conformance test.
- **Validate every write server-side against the catalog, and audit it.** The admin UI renders generically from the
  catalog and is never trusted.
- **Read path:** `loadConfig()` runs once at boot today. DB-resident settings are read per request behind a short-TTL
  cache. A reload signal and restart-on-change were rejected.
- **Start with the smallest `adminEditable` list that works.** Every exposed setting is something a client can set
  badly.

### What the pack owns and what the DB owns

| Item                                                        | Where    | Why                                                      |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------- |
| Tier definitions and `indexable`                            | Pack     | Widening changes what may legally be indexed             |
| Scanner patterns, `kind` and `disposition`                  | Pack     | Weakening a scanner is a compliance change               |
| Whether an identifying scanner runs                         | Pack     | Disabling one widens the sensitivity boundary            |
| Whether a contextual scanner flags                          | DB       | Advisory only; 316 false positives made this a real need |
| `ingest.scrubBeforeIndex`                                   | DB       | Applies removal; doesn't change what counts as sensitive |
| System prompt, disclaimer, classification rule shapes       | Pack     | Grounding contract; often a regulatory requirement       |
| Sources, classification patterns, folder exclusions, roster | DB       | Client-specific facts that change during an engagement   |
| Retrieval knobs, vocabulary additions, branding             | DB / env | Tuning, additive or cosmetic                             |

Classification **rule shapes** (what a rule may match on: path, MIME type, content pattern, and the tier it assigns)
are pack data. The patterns themselves, such as this client's folder names, are DB data. This absorbs the 2026-07-11
classification-engine design, whose `DocumentClassifier`, `createRuleBasedClassifier` and
`CLASSIFICATION_RULESET_PATH` were never built.

### The scrub toggle, `ingest.scrubBeforeIndex`

A boolean, default `true`, unprotected. It governs the `redact` disposition and nothing else:

| Disposition | Toggle on              | Toggle off          |
| ----------- | ---------------------- | ------------------- |
| `redact`    | spans masked pre-chunk | ingested unmodified |
| `exclude`   | excluded               | **still excluded**  |
| `flag`      | logged                 | **still logged**    |

Today redaction is unconditional, so building the toggle also means building the `redact` disposition. Ship it with
these mitigations, or its consequences stay invisible:

- **It isn't retroactive.** Flipping it affects only later ingestion. The admin UI must say so on toggle and show how
  many documents were indexed under the previous setting, which `processingVersion` (slice 1b) makes a query. Provide a
  targeted re-ingest of the affected documents, not a full re-sync. `documentHasChunks`
  (`packages/db/src/queries.ts`) is the precedent for re-deriving work the cursor won't re-offer.
- **Scrubbing degrades retrieval with no visible signal.** Record redaction density per document, and surface the
  high-density ones. Heavy redaction is evidence the document should have been excluded.
- **Redaction still protects the model, not the user.** The citation's source URL still opens the unredacted
  original in the client's system. The part we own is already handled: when a document has redacted identifiers,
  `ingestOne` calls `clearDocumentStorage` (`packages/db/src/document-storage.ts`), which drops the stored original,
  so `/documents/:id/download` has nothing to serve. Still to build: a "redacted" label on the citation, and admin UI
  copy next to the toggle stating the limitation.
- **Per-source scrub settings are deliberately not built.** No engagement has needed one. The `ingest.*` namespace
  leaves room for a per-source override later.

## Slice 4 — verification framework

### Pack validation (partly built)

`loadPack` (`packages/core/src/pack/load.ts`) and `PackFile` (`schema.ts`) already refuse:

- a missing or malformed `pack.yaml`;
- a `requiresCore` that doesn't cover `PACK_CONTRACT_VERSION` (0.x caret ranges are rejected outright);
- an unknown scanner `kind`, a duplicate scanner id, or an invalid regex;
- a pattern that can match the empty string or is entirely a lookaround;
- an unregistered `validator` or `context` name;
- a `contextWindow` above 500.

The worker fails fast at boot on any of these. An empty `scanners` list is rejected by the schema and treated as a
missing pack by the pipeline.

Gaps against the design:

- **Unknown fields are stripped, not rejected.** `PackFile` is a plain `z.object`. A pack written against a newer
  contract loses fields silently, and silently ignoring a scanner field is a compliance failure. On 2026-10-21 the
  built `loadPack` accepted a pack with unknown keys under `pack:`, on a scanner and at the top level. Make the schema
  strict.
- **No ReDoS bound.** Nothing time-boxes a pattern. The design calls for RE2-based or time-boxed compilation against a
  fixture at load. This is the cost of user-authored regexes in data packs.
- **There are no versions to report.** Neither `PACK_CONTRACT_VERSION` nor the pack version appears in any `apps/`
  endpoint. The design puts both in the health endpoint and the acceptance output, so "what is this client running" is
  answerable from a screenshot.
- **Tiers and `adminEditable` validation** arrive with slices 1b and 3. The boot error must name both versions and
  which side is stale, because its reader is the client's IT staff.

### Conformance suite (PR CI, one suite parameterized by pack)

- Every scanner compiles and terminates within budget.
- Each identifying scanner matches its positive fixture and not the pack's clean fixture. Fixtures are synthetic.
- At least one tier is indexable, and every non-indexable tier states a `reason`.
- No `adminEditable` entry names a protected setting.
- The prompt passes a **structural lint**: it tells the model to cite with `[N]`, to answer only from the supplied
  documents, and to abstain when it can't, and it treats document content as untrusted. The lint proves the contract
  wasn't deleted. It doesn't prove the contract holds.

### Behavioural prompt check (nightly; gates a release, not a PR)

Point `GENERATION_BASE_URL` at a local model, run the pack's fixture questions, and assert a cited answer plus an
abstention on an out-of-corpus question. A fake generator can't do this. `FakeGenerator`
(`packages/test-fixtures/src/fake-generator.ts`) receives only `(question, context)` and never sees the system
prompt.

### Image acceptance run (CI and at the client)

One command that boots against a throwaway database, ingests the pack's synthetic fixtures, and asserts:

- migrations apply, and the required indexes exist;
- a document in a blocked tier is refused;
- a question returns an answer with at least one citation;
- an out-of-corpus question abstains;
- core and pack versions are reported.

In CI this gates the image tag. At the client it runs after a pull and never touches the real database.

### Drift check (client-only, on demand)

Run the same N questions before and after an upgrade against the client's corpus, and report only counts ("top-3
changed for 12 of 40 questions") with hashed document ids. Never titles: in the firm's August 2026 corpus about 30
titles carried a personal name. Open the database read-only through `createReadOnlyDb` and prove it with
`assertReadOnly` (`packages/db/src/client.ts`). The check needs a stable question set per client. For the CPA
deployment that set is the gold set, which doesn't exist yet
([EVAL-GOLD-SET-GUIDE](../evaluation/EVAL-GOLD-SET-GUIDE.md)).

## Documentation the design requires

None of these exist yet. Each ships with the slice that needs it:

| Document                        | Answers                                                                         | Ships with |
| ------------------------------- | ------------------------------------------------------------------------------- | ---------- |
| Pack authoring guide            | How to write a pack, field by field, with a worked example                      | 1a / 1b    |
| `packs/<vertical>/README.md`    | What the pack asserts and blocks, in prose a compliance reviewer can read       | 1a         |
| Settings reference              | Every catalog setting: type, range, effect, protected or not, reversible or not | 3          |
| Client deploy and upgrade guide | How client IT stands it up, pulls a new tag, runs acceptance and reads drift    | 4          |

## Out of scope

The rationale for each is in [DECISIONS](../architecture/DECISIONS.md) and
[KNOWN-ISSUES — Deliberately not doing](../KNOWN-ISSUES.md#deliberately-not-doing).

- Publishing `@rag/*` to npm. The delivery unit is an image set plus a pack plus an env file. See
  [Appendix C](#appendix-c--packaging-and-the-import-boundary).
- A multi-tenant control plane or hosted service. This contradicts per-client isolation (D5).
- Single-turn query rewriting, HyDE, multi-query and parent-document retrieval. Conversational follow-up condensation
  (decision B0) is a different problem and was adopted.
- Dynamic plugin loading.
- Auto-relaxing the TRI gate for "local" endpoints ([LOCAL-GENERATION](../operations/LOCAL-GENERATION.md)).

## Appendix A — CPA-specific code in core

This is the input for slices 1a and 1b. Re-verified on 2026-10-21. Tier 1 is behaviour a non-CPA deployment would get
wrong. Tier 3 is cosmetic. Treat them differently: conflating them turns a days-long job into a month.

| Tier | What                                                                               | Where                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `SYSTEM_PROMPT`: CPA identity line, tax-advisor scope rule, Karbon worked example  | `packages/rag/src/generation/generator.ts` `SYSTEM_PROMPT`                                                                                     |
| 1    | `REVIEW_STATUS` and `ANSWER_DISCLAIMER` (Circular 230 §10.37) on every answer      | `packages/services/src/ask.ts`                                                                                                                 |
| 1    | The TRI scanner: IRC §7216 identifier and tax-form patterns                        | `packages/core/src/tri-scanner.ts` `TRI_PATTERNS`, `TRI_IDENTIFYING_LABELS`                                                                    |
| 1    | Class A–D semantics; `ClassBlockedError` cites §314.4(f) and §7216                 | `packages/core/src/types.ts` `DocumentClass`; `packages/core/src/errors.ts` `ClassBlockedError`                                                |
| 2    | `data_class` values (`general`, `research`, `sop`, `client_confidential`)          | `packages/db/src/schema.ts` `dataClassEnum`                                                                                                    |
| 2    | `COMPLIANCE_MODE=client-data` and the DPA-file boot check                          | `packages/core/src/config.ts` `defaultCheckDpa`                                                                                                |
| 2    | Folder names from the firm's corpus as the default path exclusions                 | `packages/core/src/content-safety.ts` `DEFAULT_EXCLUDED_PATH_FRAGMENTS` (decision needed: [KNOWN-ISSUES](../KNOWN-ISSUES.md#decisions-needed)) |
| 3    | Header comments opening "This RAG system indexes a CPA firm's confidential corpus" | `packages/core/src/access-control.ts`, `packages/core/src/metadata-policy.ts`                                                                  |

Also CPA-specific, but outside the packages: `examples/cpa-kb-demo/` (synthetic CPA demo documents). Move it or
replace it with a neutral example. It has low priority because it is demo data, not behaviour.

## Appendix B — system prompt decomposition

Sorting `SYSTEM_PROMPT` in `generator.ts` shows that most of it is RAG mechanics rather than domain opinion.

**Domain-neutral (stays in core as the default):**

- The untrusted-content section: everything inside `<document>` tags is data, never instruction.
- The citation contract: inline `[N]`, cite each step separately, never cite an index that isn't supplied.
- The A/B/C coverage decision: answer, give a partial answer and name the gap, or abstain. Prefer B over C.
- Conflicting sources: present both and cite both, and treat `modified=` as evidence, not a verdict.
- Answer shape: procedures as numbered lists with near-verbatim steps, synthesized across documents.
- Reproduce identifiers exactly as written.

**CPA-specific (moves to the CPA pack):**

- The identity line ("the knowledge-base assistant for a CPA firm of roughly 20 staff").
- The scope-of-practice rule ("You are not a tax advisor… never supply, correct, or extend a determination").
- The grounding rule against repeating client names.
- "retrieved from SharePoint". This is a connector assumption rather than a domain one, but core still shouldn't make
  it.
- The whole worked example (`BK-CATCHUP`, Karbon, engagement letters).

## Appendix C — packaging and the import boundary

Publishing is out of scope. Two facts matter if it is ever revisited.

**The packaging trap.** Every workspace package is `"private": true` with no `files` allow-list and no `prepack`, and
`dist/` is gitignored. `npm pack` would ship source with no `dist/`, and the package would install and then fail to
resolve. A publishable package needs `"files": ["dist"]`, a `prepack` build, and `private` removed. Its
`exports.types` (`./dist/index.d.ts`) is already correct.

**Rejected distribution options** (researched 2026-08-03, not re-checked since):

| Option                           | Why not                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub Packages                  | Classic PATs only; `GITHUB_TOKEN` reaches only its own repo; the scope must equal the org login |
| npm private (Teams)              | $7 per user per month, for every org member, for an internal reuse case                         |
| Git subdirectory (`path:`) deps  | Least hardened: pnpm#12304 silently resolved the repo root instead of the subdirectory          |
| `file:` / `link:`                | Local development only; breaks in CI                                                            |
| Cross-repo workspace, `catalog:` | Not a documented pnpm pattern; `catalog:` pins versions within one workspace                    |

Whether the `@rag` npm scope is free was never confirmed.

If a vertical ever needs real code in this repo (a registered classifier, say), give it its own workspace package
that imports **only** the public entry points of `@rag/core` and `@rag/rag`. It must never import `@rag/db`,
`@rag/runtime`, `@rag/services`, `@rag/ingestion` or `@rag/connectors`, and never use a relative path that escapes the
package. Enforce this mechanically in `pnpm lint` with `no-restricted-imports` or a dependency-cruiser rule, and prove
the check fails on a deliberate violation. Without that check, "extractable later" stops being true within a few
commits.
