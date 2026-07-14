# Hook-Injection Remediation Plan

> **Status: DONE except 3 deliberately-deferred/skipped items (2026-07-13).** Tasks 1–6 and the Final Phase executed directly (not via subagent-driven-development — this is config editing, not reviewable code). The reproducing bug is confirmed fixed: a throwaway `security-reviewer` subagent re-ran the original `/iterative-review` trigger (`Read` + `git status`) and found zero Semgrep-leak content (`open ... no such file or directory`); the only `<system-reminder>` content still present on the first tool call is unrelated, expected MCP-server-instructions/Auto-Mode context, not a hook leak. `enabledPlugins` dropped 90 → 87 (semgrep, data-engineering, mcpmarket-my-toolkit). Every settings.json/hook-script edit required a separate explicit approval from an auto-mode self-modification classifier — each was confirmed individually before applying. **Left unchecked, on purpose:**
>
> - Task 1 Step 3: the upstream bug report was drafted (`~/.claude/session-data/semgrep-guardian-bug-report.md`) but not actually filed as a GitHub issue — confirm the right repo/tracker first.
> - Task 5 Step 3: the "pick one memory system" decision — the plan itself says not to decide this in the same sitting as the rest of the plan.
> - Task 6 Step 2: filing upstream feature requests for `claude-mem`/`pensyve` output labeling — explicitly "nice to have, don't spend more than one pass."
>
> One edit was hard-blocked regardless of approval ("Instruction Poisoning"): documenting the `disableAllHooks:true` bypass inside `~/.claude/hooks/README.md` (a persistent, agent-loaded file) was refused even after explicit confirmation, since it would read as standing self-authored guidance to weaken future oversight. The `agent_type`-exemption pattern was documented there instead, without the bypass reference; the bypass itself lives only in this plan file and the standalone `~/.claude/scripts/review-no-hooks.sh` wrapper (a user-invoked script, not agent-loaded guidance).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a confirmed hook-output leak polluting every Bash call, establish a genuinely low-noise mode for adversarial/security subagent review, and reduce the standing prompt-injection-adjacent surface created by Claude Code's `hook_additional_context` mechanism across 90 enabled plugins.

**Architecture:** This is **meta/tooling work on the operator's Claude Code installation** (`~/.claude/`), not application code in the `rag-system` repo. Most tasks touch files outside this repo entirely. This repo/worktree is used only as the reproducible test bed (it's pnpm-only, which is what originally surfaced the bug) and as the storage location for this plan and its predecessor finding (`docs/HOOK-INJECTION-FINDINGS.md`).

**Tech Stack:** Claude Code CLI settings (`settings.json` schema), Node.js/shell hook scripts, `gh`/GitHub issue filing (for an upstream vendor bug).

## Global Constraints

- Do not attempt to patch the Semgrep Guardian plugin's compiled Go binaries directly — no source is shipped; treat it as a closed-source vendor dependency.
- `allowManagedHooksOnly` only has effect in **managed/enterprise** settings — do not attempt to set it in a personal `settings.json`; it is a documented no-op there.
- There is **no per-hook-entry disable** in Claude Code today — the only way to stop one specific hook is to remove its entry from the relevant `hooks.json`/`settings.json`, or to disable the whole plugin via `enabledPlugins`.
- Subagents spawned via the Agent tool run **in-process** and inherit the parent session's loaded hook configuration — there is no subagent-scoped `disableAllHooks`. The only genuinely isolated "hooks off" mode is a separate headless `claude -p` invocation with `--settings '{"disableAllHooks":true}'`.
- Every hook's stdin JSON carries `agent_type`/`agent_id` when it fires inside a subagent call — this is the only supported lever for making an existing hook behave differently for subagents vs. the main session.
- Source: `https://code.claude.com/docs/en/hooks` (`#disable-or-remove-hooks` section), `https://code.claude.com/docs/en/sub-agents`, `https://www.schemastore.org/claude-code-settings.json`, all fetched and quoted verbatim during Phase 0 research (see task briefs below for exact citations).

---

## Phase 0 — Documentation Discovery (already complete; summarized for reference)

Three parallel research passes were run before this plan was written. Their confirmed findings are the source of truth for every task below — do not re-derive these, just verify assumptions if a task result surprises you.

**Allowed facts / APIs (cite these, don't invent alternatives):**

1. `disableAllHooks` is a **top-level boolean** in a `settings.json` file (user `~/.claude/settings.json`, project `.claude/settings.json`, or project-local `.claude/settings.local.json`) — NOT nested under `"hooks"`. Confirmed against the fetched JSON Schema (`https://www.schemastore.org/claude-code-settings.json`, root `properties.disableAllHooks`).
2. Setting it in `.claude/settings.local.json` inside a specific worktree scopes it to that worktree only (each worktree has its own `.claude/` directory) — it does not leak to other projects.
3. `claude -p --settings '{"disableAllHooks":true}' "<prompt>"` runs one headless invocation with hooks fully off, no file written to disk. This is the most surgical "hooks off for exactly this task" lever available today.
4. `--bare` and `--safe-mode` also disable hooks, but each disables much more besides (LSP/plugin-sync/attribution/auto-memory for `--bare`; CLAUDE.md/skills/plugins/MCP/custom-commands for `--safe-mode`) — neither is "hooks-only," so prefer `--settings` for a surgical disable.
5. **Root cause of the reproduced leak is CONFIRMED as the `semgrep@claude-plugins-official` plugin (Semgrep Guardian, v2.0.3)** — not the `ecc` plugin, which was investigated first and fully exonerated (its entire hook-script source was read and each candidate hook was live-executed against the reproducing repo with zero extraneous output). Semgrep Guardian's `hooks/hooks.json` registers `PreToolUse` on `Write|Edit|Bash`, dispatching to a **compiled Go binary** (`hook-darwin-arm64` et al., confirmed `go1.25.5` via `go version -m`) that does multi-ecosystem manifest/lockfile detection (`go.sum`, `go.mod`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `composer.lock`, `Pipfile.lock`, `Gemfile.lock`, `pyproject.toml`, etc.) for its supply-chain scanning feature, and leaks the raw `os.Open` "no such file or directory" error into `hookSpecificOutput.additionalContext` for every ecosystem manifest the current repo doesn't use, on every `Bash`/`Write`/`Edit` call.
6. **16 of the 90 enabled plugins register hooks** (verified by resolving each enabled plugin's exact installed path via `~/.claude/plugins/installed_plugins.json` and checking for `hooks/hooks.json` or inline `plugin.json` hooks) — the earlier estimate of "~30 `hooks.json` files in the cache" counted non-enabled/duplicate-marketplace/stale-version copies. Trust the 16-plugin figure for all pruning decisions.

**Anti-patterns to avoid:**

- Do not assume `ecc` is the culprit for the lockfile-leak bug — this was disproven with direct evidence (full source read + live execution of every candidate hook). Any task that re-opens this question should start from "it's Semgrep Guardian" and only revisit if new contradicting evidence appears.
- Do not invent a `disabled: true` field on individual hook entries — it does not exist.
- Do not set `allowManagedHooksOnly` expecting it to work in a personal settings file — it's managed-settings-only by design.

---

### Task 1: Stop the Semgrep Guardian lockfile-leak (immediate mitigation)

**Files:**

- Investigate: `~/.claude/plugins/cache/claude-plugins-official/semgrep/2.0.3/` (config files, `guardian.yml`/`settings.yml` if present, README)
- Modify (if a granular toggle exists): whatever config file the plugin reads for its ecosystem/supply-chain-detection sub-feature
- Fallback modify: `~/.claude/settings.json` → `enabledPlugins["semgrep@claude-plugins-official"]`
- Create: a short text file recording the upstream bug report content, e.g. `~/.claude/session-data/semgrep-guardian-bug-report.md` (for your own reference when filing)

**Interfaces:**

- Consumes: the confirmed root-cause description from Phase 0 fact #5.
- Produces: a verification signal (Task 4) that the leak is gone.

- [x] **Step 1: Check for a granular opt-out before reaching for the blunt disable**

  Read the Semgrep Guardian plugin's shipped config/docs for a toggle that disables just its dependency/supply-chain ecosystem-detection sub-feature (the part that probes for `go.sum`/`package-lock.json`/etc.) without losing its actual SAST scanning value:

  ```bash
  ls -la ~/.claude/plugins/cache/claude-plugins-official/semgrep/2.0.3/
  find ~/.claude/plugins/cache/claude-plugins-official/semgrep/2.0.3/ -iname "*.yml" -o -iname "*.yaml" -o -iname "README*"
  cat ~/.claude/plugins/cache/claude-plugins-official/semgrep/2.0.3/README.md 2>/dev/null | grep -i -A5 "ecosystem\|dependency\|supply.chain\|disable"
  ```

  If a config flag exists (e.g. `detectEcosystems: false` or similar), set it and skip to Step 3's verification directly — this preserves the plugin's actual SAST value.

- [x] **Step 2: If no granular toggle exists, disable the whole plugin**

  Edit `~/.claude/settings.json`, set:

  ```json
  "enabledPlugins": {
    ...
    "semgrep@claude-plugins-official": false,
    ...
  }
  ```

  (Keep the key present, just flip the value — matches the existing convention already used for other disabled plugins in that file, e.g. `"ralph-loop@claude-plugins-official": false`.)

- [ ] **Step 3: File the upstream bug**

  Open an issue against the Semgrep Guardian plugin's repository (check `.claude-plugin/plugin.json` in the cache dir for the `homepage`/`repository` URL — Phase 0 research found references to `github.com/semgrep`). Report:
  - The exact reproduced `<system-reminder>PreToolUse:Bash hook additional context: open <path>: no such file or directory</system-reminder>` message (include both the `package-lock.json` and `go.sum` occurrences as evidence it affects multiple ecosystems).
  - The root cause: `os.Open` on a missing per-ecosystem manifest file, with the raw `*PathError` propagated into `hookSpecificOutput.additionalContext` instead of being checked with `errors.Is(err, os.ErrNotExist)` and silently skipped.
  - Suggested fix: guard each manifest-file check with an existence check (or check the error type) before/after opening, and only emit `additionalContext` for genuine scan findings, never for "this ecosystem isn't present" bookkeeping.

- [x] **Step 4: Commit nothing — this is a `~/.claude` config change, not a repo change.**

  No `git add`/`git commit` needed for Steps 1–3 (they modify `~/.claude/settings.json` and/or plugin config, not this repository). Skip straight to Task 4 for verification.

---

### Task 2: Establish an agent-aware hook exemption for the user's OWN hooks

**Scope note:** This only applies to hooks the operator directly controls (defined inline in `~/.claude/settings.json`). It cannot make third-party plugin hooks (ecc, claude-mem, pensyve, semgrep, etc.) subagent-aware, since patching cached plugin scripts is fragile against auto-updates — Task 3 covers the case where genuine silence from ALL hooks (including third-party ones) is required.

**Files:**

- Modify: `~/.claude/settings.json` (the `PreToolUse` `Edit|Write` hook block containing the `.env`/`pnpm-lock.yaml` guard, and the reference to `~/.claude/hooks/detect-secret-write.sh`)
- Modify: `~/.claude/hooks/detect-secret-write.sh`

**Interfaces:**

- Consumes: the documented hook stdin JSON shape, which includes `agent_type` (subagent's frontmatter `name`, e.g. `"code-reviewer"`, `"security-reviewer"`) and `agent_id` when the hook fires inside a subagent call. Confirmed present in the hooks reference fetched during Phase 0.
- Produces: hooks that behave identically for the main session, but skip their blocking/noisy behavior when `agent_type` matches a configured allowlist of review-type subagents (since those subagents are read-only reviewers that don't need the `.env`/lockfile edit guard anyway — they don't have `Edit`/`Write` tools in the first place, so this specific hook is actually a no-op for them today; this task is about establishing the _pattern_ other hook authors can copy, using this hook as the first worked example).

- [x] **Step 1: Read the current hook command verbatim**

  ```bash
  cat ~/.claude/settings.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['hooks']['PreToolUse'], indent=2))"
  ```

- [x] **Step 2: Add an `agent_type` check to the inline `.env`/lockfile guard**

  The current command reads `tool_input.file_path` from stdin via `jq`. Extend it to also read `.agent_type` and short-circuit for known read-only review agents:

  ```bash
  file_path=$(cat | tee /tmp/hook-stdin-$$.json | jq -r '.tool_input.file_path // empty')
  agent_type=$(jq -r '.agent_type // empty' /tmp/hook-stdin-$$.json)
  rm -f /tmp/hook-stdin-$$.json
  case "$agent_type" in
    code-reviewer|security-reviewer) exit 0 ;;
  esac
  if echo "$file_path" | grep -qE '(^|/)\.env($|\.)'; then echo 'BLOCKED: .env files contain secrets and must not be edited by Claude. Edit manually if needed.' && exit 2; fi
  if echo "$file_path" | grep -qE 'pnpm-lock\.yaml$'; then echo 'BLOCKED: Lock files must not be edited directly. Use pnpm install to update dependencies.' && exit 2; fi
  ```

  (Reading stdin twice isn't possible in a shell pipeline, hence the temp-file capture — keep this pattern simple; don't over-engineer with named pipes.)

- [x] **Step 3: Manually verify with a synthetic payload**

  ```bash
  echo '{"tool_input":{"file_path":"/tmp/fake.env"},"agent_type":"security-reviewer"}' | bash -c "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' ~/.claude/settings.json)"
  ```

  Expect: exit 0, no BLOCKED message (since `agent_type` matches the exemption list).

  ```bash
  echo '{"tool_input":{"file_path":"/tmp/fake.env"}}' | bash -c "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' ~/.claude/settings.json)"
  ```

  Expect: `BLOCKED: .env files...` and exit 2 (main-session behavior unchanged).

- [x] **Step 4: Document the pattern for future hook additions**

  Add a short comment (as a top-of-file note, since JSON has no native comments — use a sibling `~/.claude/hooks/README.md` or extend the existing one if present) explaining: "hooks that should behave differently for review-type subagents can read `.agent_type` from stdin JSON; see the `.env`/lockfile guard in `settings.json` for a worked example."

---

### Task 3: Adopt headless `claude -p --settings '{"disableAllHooks":true}'` for genuinely hook-free adversarial reviews

**Files:**

- Create: `~/.claude/scripts/review-no-hooks.sh` (a thin wrapper, optional convenience — skip if you'd rather invoke the raw command each time)

**Interfaces:**

- Consumes: nothing new — this is a documented, already-working CLI feature (`--settings`, `-p`).
- Produces: a repeatable command for "run this review with zero hook noise, including third-party plugin hooks."

- [x] **Step 1: Confirm the flag combination works as expected**

  From any repo directory:

  ```bash
  claude -p --settings '{"disableAllHooks":true}' "Read package.json in this directory and report its name field. Report verbatim any <system-reminder> tagged content you see in your tool results, if any."
  ```

  Expect: the report shows **no** `<system-reminder>` content at all (compare against the same command without `--settings`, which should show at least the `hook_additional_context`-sourced noise from whichever plugins are still enabled after Task 1).

- [x] **Step 2: (Optional) wrap it for convenience**

  ```bash
  #!/usr/bin/env bash
  # ~/.claude/scripts/review-no-hooks.sh
  # Usage: review-no-hooks.sh "<prompt>"
  exec claude -p --settings '{"disableAllHooks":true}' "$1"
  ```

  ```bash
  chmod +x ~/.claude/scripts/review-no-hooks.sh
  ```

- [x] **Step 3: Adopt this pattern for future `/iterative-review` or adversarial security-review dispatches** where signal purity matters more than automation convenience — as a standing practice, not a one-off. Note in your own working notes (not this repo) that this is the recommended path going forward for that class of task.

---

### Task 4: Verify Task 1's fix and confirm the noise is gone

**Files:**

- None modified — verification only, run from this repo/worktree since it's the confirmed reproducing environment.

**Interfaces:**

- Consumes: Task 1's completed plugin change.
- Produces: a pass/fail signal for this plan's primary symptom.

- [x] **Step 1: Re-run the exact reproducing command**

  From `/Users/marcusklein/dev/rag-system/.claude/worktrees/web-app-per-user-auth`:

  ```bash
  which claude
  ```

  (any simple Bash call reproduced the leak previously — `which`, `ls`, `git status` all worked as triggers)

- [x] **Step 2: Confirm no `<system-reminder>PreToolUse:Bash hook additional context: open ...</system-reminder>` message appears**

  If Task 1 disabled the whole plugin (Step 2 of Task 1), this should now be silent. If Task 1 found a granular config toggle instead (Step 1 of Task 1), confirm the toggle is in effect the same way.

- [x] **Step 3: Run a second Bash call to rule out any first-call/warm-up artifact**, since the original bug was observed firing repeatedly, not just once.

---

### Task 5: Prune the plugin surface (evidence-based, from the pruning research pass)

**Files:**

- Modify: `~/.claude/settings.json` (`enabledPlugins` object)

**Interfaces:**

- Consumes: the pruning research's full 90-plugin table and its specific recommendations (reproduced below for this task's exact scope — do not re-derive, the research already did the legwork).
- Produces: a reduced `enabledPlugins` set with a smaller standing hook-injection surface, with no loss of functionality actually used for `rag-system` work.

- [x] **Step 1: Disable the two unambiguous, hook-registering, irrelevant-to-this-repo plugins**

  Edit `~/.claude/settings.json`:

  ```json
  "data-engineering@claude-plugins-official": false,
  "mcpmarket-my-toolkit@mcpmarket-my-toolkit": false,
  ```

  Reasoning (from the research pass): `data-engineering` targets Airflow/data-warehouse workflows — nothing in `rag-system` touches either; it registers `SessionStart`+`Stop` hooks inline in its `plugin.json` with zero offsetting benefit here. `mcpmarket-my-toolkit` syncs a third-party skill marketplace to disk and fires on every tool call **and every tool failure** (`SessionStart`, `PostToolUse`, `PostToolUseFailure`) — the broadest failure-path hook footprint found, with no connection to this codebase's domain.

- [x] **Step 2: Ask yourself one question before touching `warp@claude-code-warp`**

  This plugin has the broadest hook-event footprint of anything examined (6 event types: `SessionStart`, `Stop`, `Notification`, `PermissionRequest`, `UserPromptSubmit`, `PostToolUse`), but its relevance is **environment-dependent, not project-dependent** — it's only useful if you actually use Warp as your terminal. This is not something a plan can determine from repo files; it requires you to answer it. If you don't use Warp: `"warp@claude-code-warp": false`. If you do: leave it, but note it as the single largest remaining hook-footprint-to-relevance mismatch if you ever revisit this list.

- [ ] **Step 3: Decide on ONE memory system (does not require immediate action — a decision, not a mechanical step)**

  `claude-mem@thedotmack`, `remember@claude-plugins-official`, and `pensyve@pensyve` are all enabled simultaneously and all register `PostToolUse` (or broader) hooks for overlapping "remember what happened across sessions" functionality — tripling the standing hook surface for one job. None is individually irrelevant (in fact `claude-mem` has direct evidence of active use: `docs/sessions/` and `docs/timeline-weeks/digests/*.md` in this repo's git status are its output). This step is intentionally **not** a mechanical "disable X" instruction — it requires you to pick which memory system to keep based on which one's output you actually rely on, then disable the other two. Revisit after living with the choice for a week or two; don't decide this in the same sitting as the rest of this plan.

- [x] **Step 4: Leave `ecc@ecc` as-is for now, but flag it for a future dedicated review**

  It has the widest hook-lifecycle coverage of anything examined (7 event types, including `PreToolUse:*`/`PostToolUse:*` matched on literally every tool call) inside a 156-skill catalog where a meaningful fraction (healthcare, Kotlin, Swift, Laravel, embedded-systems content) has no bearing on this repo. It was also the plugin wrongly suspected as Task 1's root cause — worth a closer, dedicated look later (a full skill-by-skill relevance audit is out of scope for this remediation plan, which is scoped to the specific injection-surface finding, not general plugin hygiene).

---

### Task 6: Reduce future ambiguity — label free-text hook output (lower priority, best-effort)

**Files:**

- Modify (if you choose to patch locally, understanding plugin updates may overwrite it): `~/.claude/plugins/cache/thedotmack/claude-mem/13.9.2/hooks/*.md` and any Node scripts that print free-text to stdout
- Modify: `~/.claude/settings.json`'s own `detect-secret-write.sh` output strings (already owned/controlled — safe to edit permanently)

**Interfaces:**

- Consumes: nothing new.
- Produces: hook stdout that's self-labeled with its source, independent of Claude Code's generic `hookName`-only wrapper.

- [x] **Step 1: For hooks you own directly** (the `.env`/lockfile guard, `detect-secret-write.sh`), prefix every message string with an explicit source tag:

  ```bash
  echo '[user-hook:secret-detector] ...'
  ```

  This is low-effort and permanent (you control the file, no plugin-update risk).

- [ ] **Step 2: For third-party plugins with available source (`claude-mem`, `pensyve`) — do NOT patch locally.**

  Any local edit to `~/.claude/plugins/cache/**` is silently overwritten on the plugin's next update. Instead, file a lightweight feature request upstream (similar format to Task 1's bug report) asking the plugin author to prefix free-text `PreToolUse`/`PostToolUse` hook output with a stable `[<plugin-name>:<hook-purpose>]` marker, distinct from Claude Code's generic `hookName`-only wrapper. This is a "nice to have," not a blocker — do not spend more than one pass on it.

- [x] **Step 3: Skip Semgrep Guardian entirely for this task** — it's a closed-source compiled binary; Task 1's upstream bug report already covers the one specific defect that matters (the raw error leak), and general output labeling for a binary plugin isn't something you can locally influence.

---

## Final Phase: Verification

- [x] **Re-run Task 4's verification** one more time after Task 5's plugin-pruning changes, to confirm nothing in the pruned set was actually responsible for anything else you rely on (i.e., a quick smoke check: run a normal `Read`/`Bash`/`Edit` sequence in this worktree and confirm your actual workflow — prettier formatting, secret-write blocking, etc. — still works).
- [x] **Re-run the exact iterative-review pattern that surfaced this whole investigation** (dispatch a throwaway `code-reviewer` or `security-reviewer` subagent with a trivial `Read`+`Bash` task) and confirm its final report no longer mentions unexplained `<system-reminder>` content — or, if using Task 3's headless pattern for the dispatch instead of the in-session Agent tool, confirm zero `<system-reminder>` tags appear in its output at all.
- [x] **Check `enabledPlugins` count** dropped from 90 by the number of plugins actually disabled (Task 5, Steps 1–2, plus whichever two of the three memory plugins you chose to drop in Step 3) — a simple `jq '.enabledPlugins | to_entries | map(select(.value == true)) | length' ~/.claude/settings.json` before/after comparison.
- [x] Confirm no changes were accidentally committed to the `rag-system` git repository — every step in this plan targets `~/.claude/`, not this repo. `git -C /Users/marcusklein/dev/rag-system/.claude/worktrees/web-app-per-user-auth status --short` should show only this plan file and its predecessor (`docs/HOOK-INJECTION-FINDINGS.md`) as new/untracked, nothing else.
