import { describe, expect, it, vi } from "vitest";
import type { SourceDocument } from "@rag/core";
import { paginate, type ConnectorPage } from "./paginate.js";

function doc(externalId: string): SourceDocument {
  return {
    externalId,
    title: `doc ${externalId}`,
    modifiedAt: "2026-06-10T00:00:00.000Z",
    mimeType: "text/plain",
    content: Buffer.from(externalId),
    metadata: {},
  };
}

/** A trivial cursor: a monotonic page index, encoded as its decimal string. */
const encode = (cursor: number): string => String(cursor);

describe("paginate", () => {
  it("does NOT terminate on an empty page that reports done:false", async () => {
    // Regression guard: a page of only drafts/skips yields zero documents but
    // is still a real page — the walk must continue to later pages.
    const pages: ConnectorPage<number>[] = [
      { documents: [], cursor: 1, done: false },
      { documents: [doc("a"), doc("b")], cursor: 2, done: true },
    ];
    const fetchPage = vi.fn(async (cursor: number) => pages[cursor]!);

    const result = await paginate({
      maxItems: 10,
      cursor: 0,
      encode,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.documents.map((d) => d.externalId)).toEqual(["a", "b"]);
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBe("2");
  });

  it("terminates as soon as a page reports done:true", async () => {
    const fetchPage = vi.fn(async () => ({
      documents: [doc("only")],
      cursor: 42,
      done: true,
    }));

    const result = await paginate({
      maxItems: 10,
      cursor: 0,
      encode,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(result.nextCursor).toBe("42");
  });

  it("clamps maxItems <= 0 to 1 (still fetches exactly one page)", async () => {
    const fetchPage = vi.fn(async (_cursor: number, remaining: number) => {
      expect(remaining).toBe(1);
      return { documents: [doc("x"), doc("y")], cursor: 1, done: true };
    });

    const result = await paginate({
      maxItems: 0,
      cursor: 0,
      encode,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    // Even though the page over-filled, the accumulator is truncated to 1.
    expect(result.documents.map((d) => d.externalId)).toEqual(["x"]);
  });

  it("truncates an over-filling page and never exceeds maxItems", async () => {
    const fetchPage = vi.fn(async () => ({
      documents: [doc("a"), doc("b"), doc("c"), doc("d")],
      cursor: 1,
      done: false,
    }));

    const result = await paginate({
      maxItems: 2,
      cursor: 0,
      encode,
      fetchPage,
    });

    expect(result.documents.map((d) => d.externalId)).toEqual(["a", "b"]);
    expect(result.documents.length).toBeLessThanOrEqual(2);
    // Loop exits on the maxItems guard, not on done.
    expect(result.done).toBe(false);
  });

  it("shrinks `remaining` across pages and applies encode to the final cursor", async () => {
    const remainings: number[] = [];
    const pages: ConnectorPage<number>[] = [
      { documents: [doc("a")], cursor: 1, done: false },
      { documents: [doc("b")], cursor: 2, done: false },
      { documents: [doc("c")], cursor: 3, done: false },
    ];
    const fetchPage = vi.fn(async (cursor: number, remaining: number) => {
      remainings.push(remaining);
      return pages[cursor]!;
    });

    const result = await paginate({
      maxItems: 3,
      cursor: 0,
      encode,
      fetchPage,
    });

    expect(remainings).toEqual([3, 2, 1]);
    expect(result.documents.map((d) => d.externalId)).toEqual(["a", "b", "c"]);
    expect(result.nextCursor).toBe("3");
    expect(result.done).toBe(false);
  });
});
