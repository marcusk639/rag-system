import { describe, expect, it } from "vitest";
import {
  EXPOSABLE_METADATA_FIELDS,
  sanitizeMetadata,
  sanitizeRetrievalResult,
} from "./metadata-policy.js";
import type { DocumentMetadata, RetrievalResult } from "./types.js";

describe("sanitizeMetadata", () => {
  it("strips PII fields (author, from, to, subject)", () => {
    const meta: DocumentMetadata = {
      title: "Q3 Tax Workpaper",
      author: "Jane Q. Taxpayer",
      from: "jane@example.com",
      to: ["bob@firm.com", "alice@firm.com"],
      subject: "Re: your 1040 — SSN ending 4321",
      url: "https://example.com/doc",
      mimeType: "application/pdf",
    };

    // Cast to a loose view: `ExposedMetadata` deliberately narrows these keys
    // away at the type level, but we still assert they are gone at runtime.
    const safe = sanitizeMetadata(meta) as Record<string, unknown>;

    expect(safe.author).toBeUndefined();
    expect(safe.from).toBeUndefined();
    expect(safe.to).toBeUndefined();
    expect(safe.subject).toBeUndefined();
  });

  it("preserves allowlisted non-PII display/citation fields", () => {
    const meta: DocumentMetadata = {
      title: "Q3 Tax Workpaper",
      url: "https://example.com/doc",
      mimeType: "application/pdf",
      sizeBytes: 12345,
      createdAt: "2024-01-01T00:00:00.000Z",
      modifiedAt: "2024-02-01T00:00:00.000Z",
      path: "Clients/2024/workpaper.pdf",
    };

    const safe = sanitizeMetadata(meta);

    expect(safe.title).toBe("Q3 Tax Workpaper");
    expect(safe.url).toBe("https://example.com/doc");
    expect(safe.mimeType).toBe("application/pdf");
    expect(safe.sizeBytes).toBe(12345);
    expect(safe.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(safe.modifiedAt).toBe("2024-02-01T00:00:00.000Z");
    // Folder paths are NOT exposed: at a CPA firm they routinely name clients
    // ("Clients/Smith Family/2024"). Kept internally for path exclusion only.
    expect((safe as Record<string, unknown>).path).toBeUndefined();
  });

  it("is default-deny: drops `extra` and any unknown passthrough keys", () => {
    const meta = {
      title: "doc",
      extra: { driveId: "abc", ownerEmail: "secret@x.com" },
      // arbitrary passthrough key a connector/parser might inject
      ssn: "123-45-6789",
      internalNotes: "client owes back taxes",
    } as DocumentMetadata;

    const safe = sanitizeMetadata(meta) as Record<string, unknown>;

    expect(safe.extra).toBeUndefined();
    expect(safe.ssn).toBeUndefined();
    expect(safe.internalNotes).toBeUndefined();
    // only the one allowlisted field survives
    expect(Object.keys(safe)).toEqual(["title"]);
  });

  it("returns only keys from the documented allowlist", () => {
    const everything = {
      title: "t",
      author: "a",
      url: "u",
      mimeType: "m",
      sizeBytes: 1,
      createdAt: "c",
      modifiedAt: "mod",
      path: "p",
      subject: "s",
      from: "f",
      to: ["x"],
      extra: { y: 1 },
    } as unknown as DocumentMetadata;

    const safe = sanitizeMetadata(everything);

    for (const key of Object.keys(safe)) {
      expect(EXPOSABLE_METADATA_FIELDS).toContain(
        key as (typeof EXPOSABLE_METADATA_FIELDS)[number],
      );
    }
  });

  it("handles empty / undefined-valued metadata without throwing", () => {
    expect(sanitizeMetadata({})).toEqual({});
    expect(sanitizeMetadata({ title: undefined, author: undefined })).toEqual(
      {},
    );
  });
});

describe("sanitizeRetrievalResult", () => {
  const baseResult: RetrievalResult = {
    text: "chunk text",
    score: 0.9,
    denseScore: 0.8,
    sparseScore: 0.7,
    document: {
      id: "11111111-1111-1111-1111-111111111111",
      title: "Q3 Tax Workpaper",
      sourceId: "22222222-2222-2222-2222-222222222222",
      sourceKind: "gmail",
      url: "https://example.com/doc",
      metadata: {
        title: "Q3 Tax Workpaper",
        author: "Jane Q. Taxpayer",
        from: "jane@example.com",
        to: ["bob@firm.com"],
        subject: "Re: your 1040",
        path: "Inbox/thread-1",
      },
    },
    chunk: {
      id: "33333333-3333-3333-3333-333333333333",
      ordinal: 0,
      headingPath: ["Intro"],
    },
  };

  it("strips PII from document.metadata but keeps the rest of the result intact", () => {
    const safe = sanitizeRetrievalResult(baseResult);
    const safeMeta = safe.document.metadata as Record<string, unknown>;

    expect(safeMeta.author).toBeUndefined();
    expect(safeMeta.from).toBeUndefined();
    expect(safeMeta.to).toBeUndefined();
    expect(safeMeta.subject).toBeUndefined();
    // non-metadata fields untouched
    expect(safe.text).toBe("chunk text");
    expect(safe.score).toBe(0.9);
    expect(safe.document.id).toBe(baseResult.document.id);
    expect(safe.document.title).toBe("Q3 Tax Workpaper");
    expect(safe.document.metadata.title).toBe("Q3 Tax Workpaper");
    expect(
      (safe.document.metadata as Record<string, unknown>).path,
    ).toBeUndefined();
  });

  it("does not mutate the input result", () => {
    const input = structuredClone(baseResult);
    sanitizeRetrievalResult(input);
    expect(input.document.metadata.author).toBe("Jane Q. Taxpayer");
    expect(input.document.metadata.from).toBe("jane@example.com");
  });
});
