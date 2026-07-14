# Table Truncation Final-Stage Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last known gap in `MarkdownChunker`'s "never cut a table row mid-way" guarantee — `applyOverlap()` can still push a table-tailed chunk back over `MAX_EMBEDDING_TOKENS` after `hardSplitTable`/`truncateTableRow` already verified it safe, letting the downstream table-unaware `clampToTokenLimit()` corrupt the row.

**Architecture:** Make `applyOverlap()` itself the final verification point for table-tailed chunks — shrink or drop the overlap-text prefix (not the table row) when adding it would exceed `MAX_EMBEDDING_TOKENS`, verified against the real tokenizer at the point of assembly. Nothing in `MarkdownChunker.chunk()` runs after `applyOverlap()`'s output except the existing generic `clampToTokenLimit()` safety net, so a chunk `applyOverlap()` already verifies safe can never be invalidated by a later transformation — this is the structural difference from the three prior fix iterations, each of which predicted one more upstream overhead source (char-ratio accuracy, table-header tokens, heading-prefix tokens) instead of verifying the true final string.

**Tech Stack:** TypeScript (Node 22), `gpt-tokenizer` (`o200k_base` encoding), vitest.

## Background — why this plan exists

`packages/rag/src/chunking/markdown-chunker.ts`'s table-row-aware splitting (`hardSplitTable`, `truncateTableRow`) went through 4 review cycles (see `.superpowers/sdd/task-9-report.md` and `.superpowers/sdd/progress.md`'s Task 9 entry in the launch-readiness worktree for full history):

1. Base implementation split tables on row boundaries but used raw character-offset truncation for an oversized single row — got cut mid-row downstream.
2. Fix 1 made truncation token-aware via a char-ratio guess (`CHARS_PER_TOKEN = 4`) — not accurate for dense (CJK-heavy) content, so the guess could still produce a row whose _real_ token count exceeded the limit.
3. Fix 2 replaced the guess with a real-tokenizer verify+shrink loop, but the ceiling calculation didn't account for the outer section-heading prefix (`# Heading › Sub\n\n`) that gets prepended _after_ `hardSplitTable` returns — a deep/verbose heading path could still push the assembled chunk over budget.
4. Fix 3 threaded the real heading-prefix text through the whole pipeline and verified the fully-assembled chunk (`headingPrefix + header + separator + row`) against the real tokenizer — genuinely closing that gap. Final adversarial review found gap #4: `chunkSection()` calls `applyOverlap()` on its chunk array, which prepends up to `chunkOverlap` tokens' worth of the _previous_ chunk's tail to every chunk but the first — and this runs **after** `hardSplitTable`'s verification, so it can push an already-verified-safe table-tailed chunk back over `MAX_EMBEDDING_TOKENS`.

This does **not** trigger at the shipped default config (`CHUNK_SIZE=800`, `CHUNK_OVERLAP=120` — `packages/core/src/config.ts`), only when `CHUNK_SIZE` is raised toward Gemini's ~2048-token cap (documented as a known limitation in `CLAUDE.md`'s "Things that will trip you up" and in code comments in `markdown-chunker.ts`, commit `16771f0`). This plan implements the real fix so that limitation can be removed.

## Global Constraints

- No `console.log` in production code — this package has none; keep it that way.
- Prettier auto-formats `.ts`/`.md` on every Edit/Write (repo hook) — expect reformatting; re-read a file before your next edit if the previous edit touched the same region.
- Commit messages: `<type>: <description>` (feat/fix/refactor/docs/test/chore/perf/ci).
- Do not modify `packages/rag/src/chunking/token-clamp.ts` — it's a shared, table-unaware safety net used by non-table code paths throughout the chunking pipeline; this fix must stay scoped to `markdown-chunker.ts`'s own `applyOverlap()`, not change the shared clamp's generic behavior.
- The fix must not touch the table ROW content when shrinking to fit — it may only shrink or drop the _overlap-text prefix_ it is about to prepend. Losing a little cross-chunk context continuity for a table-heavy chunk is an acceptable, safe degradation; corrupting stored table data (a dropped closing `|`, a truncated cell) is not.
- Every existing test in `packages/rag/src/chunking/markdown-chunker.test.ts` (98+ tests as of this plan, spanning the 4 prior fix iterations) must keep passing unchanged — this plan adds tests, it does not rewrite existing ones.

---

## File Structure

| File                                                 | Responsibility                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rag/src/chunking/markdown-chunker.ts`      | **Modify**: `applyOverlap()` gains a table-tail check and a real-tokenizer verify+shrink loop on the overlap-text prefix; adds `looksLikeTableTail()` helper.                                                                                                                         |
| `packages/rag/src/chunking/markdown-chunker.test.ts` | **Modify**: adds the specific repro this plan exists to fix (deep heading path + dense oversized row + `chunkOverlap > 0` + `chunkSize` bound by `MAX_EMBEDDING_TOKENS`), plus a boundary/regression test for normal (non-table) chunks continuing to receive full overlap unchanged. |
| `CLAUDE.md`                                          | **Modify**: remove the now-resolved "Things that will trip you up" entry added in commit `16771f0`.                                                                                                                                                                                   |

---

## Task 1: Table-aware overlap in `applyOverlap()`

**Files:**

- Modify: `packages/rag/src/chunking/markdown-chunker.ts`
- Modify: `packages/rag/src/chunking/markdown-chunker.test.ts`

**Interfaces:**

- Consumes: `MAX_EMBEDDING_TOKENS` (already imported at the top of `markdown-chunker.ts` from `./token-clamp.js`), `countTokens(text: string): number` (already defined in this file), `encode` (already imported from `gpt-tokenizer`).
- Produces: `looksLikeTableTail(text: string): boolean` (new, module-private) — true when the last non-blank line of `text` is a GFM table row (starts and ends with `|`). `applyOverlap`'s existing signature (`(chunks: string[], overlapTokens: number): string[]`) is unchanged; only its internal behavior changes for table-tailed chunks.

- [ ] **Step 1: Write the failing test reproducing the exact gap**

Add to `packages/rag/src/chunking/markdown-chunker.test.ts`:

```typescript
describe("MarkdownChunker — applyOverlap does not corrupt table rows", () => {
  it("shrinks the overlap prefix instead of letting a table row get cut mid-string", async () => {
    // Three-level heading path (pushes the heading prefix itself to several
    // hundred tokens) followed by a paragraph dense enough to fill most of a
    // chunk, then a table whose single oversized row is dense CJK text —
    // this is the exact shape the final review in the prior fix iteration
    // used to demonstrate the gap. chunkSize=5000 with chunkOverlap=120
    // means the effective per-chunk ceiling is bound by MAX_EMBEDDING_TOKENS
    // (1700), not chunkSize — the condition under which this bug can occur.
    const denseCell = "统计数据分析报告".repeat(400); // ~3200+ real tokens
    const markdown = [
      "# 年度报告与合规审查总结",
      "## 财务数据与风险评估概览",
      "### 详细季度分析结果汇总",
      "",
      "Regular prose padding to occupy a preceding chunk so overlap has real content to carry forward. ".repeat(
        40,
      ),
      "",
      "| Client | Notes |",
      "| --- | --- |",
      `| Row One | ${denseCell} |`,
    ].join("\n");

    const chunker = new MarkdownChunker({
      chunkSize: 5000,
      chunkOverlap: 120,
    });

    const chunks = await chunker.chunk({
      title: "Dense Report",
      markdown,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(1);

    // The row-boundary guarantee: every line that looks like a table row
    // (starts with "|") must also END with "|" — never cut mid-cell.
    for (const c of chunks) {
      const lines = c.text.split("\n").filter((l) => l.trim().startsWith("|"));
      for (const line of lines) {
        expect(line.trim().endsWith("|")).toBe(true);
      }
    }

    // Every chunk must genuinely respect the hard embedding cap.
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(1700);
    }
  });

  it("still applies full overlap to ordinary (non-table-tailed) chunks", async () => {
    // Regression guard: the table-tail check must not accidentally shrink
    // or drop overlap for chunks that never contained a table.
    const chunker = new MarkdownChunker({ chunkSize: 60, chunkOverlap: 20 });
    const markdown = [
      "# Notes",
      "",
      "First paragraph with enough words to force a split into multiple chunks so overlap actually applies here today.",
      "",
      "Second paragraph continues the same section with more prose content that pushes this section over the chunk size limit.",
    ].join("\n");

    const chunks = await chunker.chunk({
      title: "Notes",
      markdown,
      tables: [],
      metadata: {},
    });

    expect(chunks.length).toBeGreaterThan(1);
    // The second chunk should start with a nonzero-length prefix carried
    // over from the first chunk's tail (i.e. overlap was actually applied,
    // not silently zeroed out by the new table-tail logic).
    const firstChunkTailWords = chunks[0]!.text.trim().split(/\s+/).slice(-3);
    const secondChunkText = chunks[1]!.text;
    expect(
      firstChunkTailWords.some((word) => secondChunkText.includes(word)),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

```bash
pnpm --filter @rag/rag test -- markdown-chunker
```

Expected: the first new test FAILs — some chunk's table row line does not end with `|` (the exact defect: `applyOverlap`'s prepended dense-CJK overlap text pushes the chunk over `MAX_EMBEDDING_TOKENS`, and `chunk()`'s generic `clampToTokenLimit()` then cuts it mid-row). The second new test passes already (it doesn't exercise the bug) — that's expected and fine, it's a regression guard for the fix you're about to write.

- [ ] **Step 3: Implement `looksLikeTableTail` and the table-aware overlap shrink**

Replace `applyOverlap` in `packages/rag/src/chunking/markdown-chunker.ts` (currently the last function-sized block before `countTokens`/`sha256`):

```typescript
/**
 * True when the LAST non-blank line of `text` is a GFM table row (starts and
 * ends with `|`). Used by `applyOverlap` to detect chunks that came out of
 * `hardSplitTable` — those chunks already have a `hardSplitTable`/
 * `truncateTableRow`-verified token count, and prepending overlap text to
 * them must not be allowed to silently push them back over
 * `MAX_EMBEDDING_TOKENS`, or the downstream generic `clampToTokenLimit()`
 * safety net (table-unaware) will cut the trailing row mid-string.
 */
function looksLikeTableTail(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1];
  return (
    lastLine !== undefined &&
    lastLine.trim().startsWith("|") &&
    lastLine.trim().endsWith("|")
  );
}

/**
 * Prepend up to `overlapTokens` worth of each chunk's predecessor's tail, for
 * cross-chunk context continuity.
 *
 * For a table-tailed chunk (see `looksLikeTableTail`), the chunk's own token
 * count is already verified safe by `hardSplitTable`/`truncateTableRow`
 * BEFORE this function runs. Blindly prepending overlap text could push it
 * back over `MAX_EMBEDDING_TOKENS`, and this is genuinely the LAST assembly
 * step before `chunk()`'s generic, table-unaware `clampToTokenLimit()` net —
 * so if this function doesn't verify the real result here, nothing else
 * downstream can. Rather than ever touching the table row itself, this
 * shrinks (or, in the extreme, drops entirely) the OVERLAP TEXT prefix until
 * the real assembled token count is back under the cap — losing a little
 * cross-chunk context continuity is an acceptable, safe degradation; a
 * dropped closing `|` or a truncated table cell is not.
 */
function applyOverlap(chunks: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0 || chunks.length <= 1) return chunks;
  const out: string[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const current = chunks[i]!;
    const prevTokens = encode(prev);
    // Take the tail tokens of the previous chunk as the prefix of this one.
    const tail = prevTokens.slice(-overlapTokens);
    // Decoding back to string isn't exact for arbitrary tokens, so we
    // approximate by slicing the previous chunk's string. For most languages
    // the ratio is ~4 chars/token; this overshoots slightly, which is fine
    // for ordinary chunks and is exactly what the table-tail branch below
    // verifies and corrects for table-tailed ones.
    let approxChars = tail.length * 4;
    let overlapText = approxChars > 0 ? prev.slice(-approxChars) : "";
    let assembled = overlapText ? `${overlapText}\n\n${current}` : current;

    if (looksLikeTableTail(current)) {
      // Verify against the real tokenizer and shrink the overlap prefix
      // (never the table row) until the assembled chunk is genuinely safe.
      // `current` alone is already known-safe (hardSplitTable/
      // truncateTableRow verified it before applyOverlap ever ran), so this
      // loop always terminates: worst case, approxChars reaches 0 and
      // `assembled` becomes exactly `current`, which is already under
      // MAX_EMBEDDING_TOKENS by construction of the table-splitting path.
      while (countTokens(assembled) > MAX_EMBEDDING_TOKENS && approxChars > 0) {
        approxChars = Math.floor(approxChars * 0.75);
        overlapText = approxChars > 0 ? prev.slice(-approxChars) : "";
        assembled = overlapText ? `${overlapText}\n\n${current}` : current;
      }
    }

    out.push(assembled);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify both pass**

```bash
pnpm --filter @rag/rag test -- markdown-chunker
```

Expected: both new tests PASS. Then run the full package suite to confirm none of the prior 4 fix iterations' tests regressed:

```bash
pnpm --filter @rag/rag test
```

Expected: all PASS (98+ tests, exact count depends on what's landed since this plan was written — the point is zero failures, not an exact number).

- [ ] **Step 5: Remove the now-resolved known-limitation documentation**

In `CLAUDE.md`, delete the bullet point added in commit `16771f0` under "Things that will trip you up" that begins `**\`CHUNK_SIZE\` above ~1600 can re-break table-row splitting.**` — this plan's fix closes that gap, so the warning is no longer accurate.

Also in `packages/rag/src/chunking/markdown-chunker.ts`, update the two comments that reference the "KNOWN LIMITATION" and this plan file (near `bufferTokens = baseOverheadTokens;` in `hardSplitTable`, and the comment on the `if (baseOverheadTokens + rowTokens > effectiveMax)` branch) — replace the "KNOWN LIMITATION" paragraph and the "See the KNOWN LIMITATION note... `applyOverlap()` runs after this and can still reopen the gap" sentence with a short note that `applyOverlap()` now independently verifies table-tailed chunks against the real tokenizer after this function returns, so the guarantee genuinely holds end-to-end. Read the current file first — line numbers will have shifted since this plan was written.

- [ ] **Step 6: Run the full test suite and typecheck one more time**

```bash
pnpm --filter @rag/rag test
pnpm --filter @rag/rag typecheck
```

Expected: both PASS/exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/rag/src/chunking/markdown-chunker.ts packages/rag/src/chunking/markdown-chunker.test.ts CLAUDE.md
git commit -m "fix: applyOverlap verifies table-tailed chunks against the real tokenizer

Closes the last known gap in the table-row-truncation guarantee: overlap
text prepended after hardSplitTable/truncateTableRow already verified a
chunk safe could still push it back over MAX_EMBEDDING_TOKENS, letting
the downstream table-unaware clampToTokenLimit() cut a row mid-string.
Shrinks/drops the overlap prefix (never the table row itself) when
needed, verified against the real tokenizer at the point of assembly —
this is the final assembly stage, so a chunk verified safe here cannot
be invalidated by anything that runs after it."
```

---

## Final Verification

- [ ] Re-run the exact adversarial repro from the prior review cycle one more time as a sanity check (3-level heading path, dense CJK oversized row, `chunkSize=5000`, `chunkOverlap>0`) — this is now covered by Step 1's first test, so a green `pnpm --filter @rag/rag test -- markdown-chunker` run is sufficient; no separate manual repro is needed.
- [ ] Confirm `git grep -n "KNOWN LIMITATION" packages/rag/src/chunking/markdown-chunker.ts` returns no results (both comments were updated in Step 5).
- [ ] Confirm `git grep -n "CHUNK_SIZE.*above.*1600\|re-break table-row" CLAUDE.md` returns no results (the resolved limitation was removed in Step 5).

## Self-Review

**Spec coverage:** The single task covers the entire gap identified in the prior review: table-tailed chunks now get their overlap-prefix verified against the real tokenizer, with the row itself never touched. Both the failure-reproducing test and a non-table regression guard are included.

**Placeholder scan:** No TBD/TODO. All code blocks are complete, runnable TypeScript matching the existing file's exact style (JSDoc comments, `const`/`let` patterns, existing helper functions reused rather than reinvented).

**Type consistency:** `looksLikeTableTail(text: string): boolean` and the modified `applyOverlap(chunks: string[], overlapTokens: number): string[]` match the existing file's established naming/signature conventions (`looksLikeMarkdownTable`, `looksLikeTableSeparatorRow` are the direct precedents this task's new helper follows).
