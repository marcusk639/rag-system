import { describe, expect, it } from "vitest";
import type { RetrievalResult } from "@rag/core";
import {
  buildCitations,
  buildPrompt,
  groupContextByDocument,
} from "./prompt-context.js";

function chunk(
  docId: string,
  ordinal: number,
  score: number,
  text = `${docId} chunk ${ordinal}`,
): RetrievalResult {
  return {
    text,
    score,
    denseScore: score,
    sparseScore: 0,
    document: {
      id: docId,
      title: `Title ${docId}`,
      sourceId: "s",
      sourceKind: "sharepoint",
      url: `https://x/${docId}`,
      hasOriginal: true,
      metadata: {},
    },
    chunk: { id: `${docId}-c${ordinal}`, ordinal, headingPath: ["Steps"] },
  } as RetrievalResult;
}

// Retrieval order (by score): doc A step 3, doc B, doc A step 1, doc A step 2.
const RESULTS = [
  chunk("A", 3, 0.9),
  chunk("B", 0, 0.8),
  chunk("A", 1, 0.7),
  chunk("A", 2, 0.6),
];

describe("groupContextByDocument", () => {
  it("groups chunks by document, ordered by each document's best-ranked chunk", () => {
    const groups = groupContextByDocument(RESULTS);
    expect(groups.map((g) => g.document.id)).toEqual(["A", "B"]);
    expect(groups.map((g) => g.index)).toEqual([1, 2]);
  });

  it("orders a document's chunks in reading order, not score order", () => {
    const [a] = groupContextByDocument(RESULTS);
    expect(a?.chunks.map((c) => c.chunk.ordinal)).toEqual([1, 2, 3]);
  });

  it("drops a chunk that appears twice", () => {
    const groups = groupContextByDocument([...RESULTS, chunk("A", 1, 0.5)]);
    expect(groups[0]?.chunks).toHaveLength(3);
  });
});

describe("buildPrompt — one block per document", () => {
  it("emits a single <document> per source document with chunks in reading order", () => {
    const prompt = buildPrompt("how?", RESULTS);
    expect(prompt.match(/<document index=/g)).toHaveLength(2);
    const a = prompt.slice(
      prompt.indexOf('<document index="1"'),
      prompt.indexOf('<document index="2"'),
    );
    expect(a.indexOf("A chunk 1")).toBeLessThan(a.indexOf("A chunk 2"));
    expect(a.indexOf("A chunk 2")).toBeLessThan(a.indexOf("A chunk 3"));
  });

  it("marks a gap between non-adjacent chunks and not between adjacent ones", () => {
    const prompt = buildPrompt("how?", [
      chunk("A", 1, 0.9),
      chunk("A", 2, 0.8),
      chunk("A", 5, 0.7),
    ]);
    const body = prompt.slice(prompt.indexOf("A chunk 1"));
    expect(body.slice(0, body.indexOf("A chunk 2"))).not.toContain("[…]");
    expect(
      body.slice(body.indexOf("A chunk 2"), body.indexOf("A chunk 5")),
    ).toContain("[…]");
  });
});

describe("buildCitations — one citation per document", () => {
  it("returns one entry per document, indexed to match the prompt blocks", () => {
    const citations = buildCitations(RESULTS);
    expect(citations.map((c) => [c.index, c.documentId])).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
  });

  it("keeps every contributing chunk id (reading order), the best chunk, and the best score", () => {
    const [a] = buildCitations(RESULTS);
    expect(a?.chunkIds).toEqual(["A-c1", "A-c2", "A-c3"]);
    expect(a?.chunkId).toBe("A-c3");
    expect(a?.score).toBe(0.9);
    expect(a?.downloadable).toBe(true);
  });
});

describe("buildCitations — modified date", () => {
  it("carries the document's modified date (date only) when it is a valid ISO date", () => {
    const r = chunk("A", 0, 0.9);
    r.document.metadata = { modifiedAt: "2025-11-04T10:22:00Z" };
    expect(buildCitations([r])[0]?.modifiedAt).toBe("2025-11-04");
  });

  it("omits a missing or malformed date", () => {
    const r = chunk("A", 0, 0.9);
    r.document.metadata = { modifiedAt: "yesterday" };
    expect(buildCitations([r])[0]?.modifiedAt).toBeUndefined();
  });
});

describe("buildCitations — data classification label", () => {
  /**
   * `docClass` is already permitted across the output boundary
   * (`EXPOSABLE_METADATA_FIELDS`, packages/core/src/metadata-policy.ts) but had
   * no consumer: the label was computed at ingest, stored, allowed through
   * sanitization, and then ignored by every staff surface. Carrying it on the
   * citation is what lets web, Teams and MCP show the same provenance.
   */
  it("carries the document's class when the metadata has one", () => {
    const r = chunk("A", 0, 0.9);
    r.document.metadata = { docClass: "B" };
    expect(buildCitations([r])[0]?.docClass).toBe("B");
  });

  /**
   * The load-bearing case. `isSourceUrlExposable`
   * (packages/core/src/metadata-policy.ts) treats an ABSENT class as STRICTER
   * than A, because an untagged row is not evidence that it is class A. A
   * display that defaulted to "A" would therefore invent a reassurance the
   * data does not support — so absence must stay absent all the way out.
   */
  it("omits the class entirely when the document is untagged", () => {
    const r = chunk("A", 0, 0.9);
    r.document.metadata = {};
    expect(buildCitations([r])[0]?.docClass).toBeUndefined();
    expect("docClass" in (buildCitations([r])[0] ?? {})).toBe(false);
  });
});

describe("buildCitations — source URL class gate", () => {
  /**
   * Mirrors `metadata-policy.url-class.test.ts` on the citation path.
   *
   * `metadata.url` is the connector's link and embeds the folder path, which at
   * this firm is named for clients — the same reason `metadata.path` is
   * stripped. `sanitizeRetrievalResult` withholds it above class A, but
   * citations are built from the RAW `RetrievalResult`, so until this gate the
   * link reached every surface that renders a citation (Teams as a clickable
   * OpenUrl action, MCP as printed text) regardless of class.
   */
  function citationFor(docClass: unknown) {
    const r = chunk("A", 0, 0.9);
    r.document.metadata = docClass === undefined ? {} : ({ docClass } as never);
    return buildCitations([r])[0];
  }

  /**
   * Positive control. Without it the absence assertions below would pass
   * against a `buildCitations` that never set `url` at all, proving nothing
   * about whether the gate discriminates.
   */
  it("keeps the source URL for a class A document", () => {
    expect(citationFor("A")?.url).toBe("https://x/A");
  });

  it("omits the source URL for a class B document", () => {
    expect("url" in (citationFor("B") ?? {})).toBe(false);
  });

  /**
   * An absent class is stricter than A on purpose (`isSourceUrlExposable`): an
   * untagged row is not evidence that it is class A.
   */
  it("omits the source URL when the document is untagged", () => {
    expect("url" in (citationFor(undefined) ?? {})).toBe(false);
  });

  /**
   * `document.metadata` is `.passthrough()` and is never zod-parsed on the read
   * path, so `docClass` can hold anything the jsonb column holds. The gate must
   * fail CLOSED on a value the enum does not know, not fall through to a
   * truthiness check.
   */
  it("omits the source URL for an unrecognized class value", () => {
    expect("url" in (citationFor("E") ?? {})).toBe(false);
    expect("url" in (citationFor("a") ?? {})).toBe(false);
  });
});
