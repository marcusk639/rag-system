import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE, NotFoundError } from "@rag/core";
import type { AuthorizationScope } from "@rag/core";
import { FakeObjectStore } from "@rag/test-fixtures";
import { getDocumentDownload } from "./documents.js";
import type { ServiceDeps } from "./deps.js";

const { getDocumentMock } = vi.hoisted(() => ({ getDocumentMock: vi.fn() }));

vi.mock("@rag/db", () => ({ getDocument: getDocumentMock }));

function makeObjectStore() {
  const store = new FakeObjectStore(
    new Map([[ROW.storageKey, Buffer.from("file-bytes")]]),
  );
  vi.spyOn(store, "get");
  return store;
}

function makeDeps(objectStore: unknown): ServiceDeps {
  return {
    db: {},
    queue: {},
    retriever: {},
    generator: null,
    objectStore,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  } as unknown as ServiceDeps;
}

const ROW = {
  id: "doc-1",
  sourceId: "src-1",
  title: 'Report "Q1"/2026.pdf',
  mimeType: "application/pdf",
  storageKey: "sources/src-1/abc",
  originalSizeBytes: 10,
};

const RESTRICTED: AuthorizationScope = { enforcedSourceIds: ["other-src"] };

describe("getDocumentDownload", () => {
  it("streams the original with a sanitized attachment filename when in scope", async () => {
    getDocumentMock.mockResolvedValue(ROW);
    const objectStore = makeObjectStore();

    const dl = await getDocumentDownload(
      makeDeps(objectStore),
      "doc-1",
      ADMIN_SCOPE,
    );

    expect(objectStore.get).toHaveBeenCalledWith("sources/src-1/abc");
    expect(dl.contentType).toBe("application/pdf");
    // CR/LF/quotes stripped, path separators replaced — no header injection.
    expect(dl.filename).toBe("Report Q1_2026.pdf");
    expect(dl.contentLength).toBe(10);
  });

  it("404s a document outside the caller's scope (indistinguishable from missing)", async () => {
    getDocumentMock.mockResolvedValue(ROW);
    await expect(
      getDocumentDownload(makeDeps(makeObjectStore()), "doc-1", RESTRICTED),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s when the document is missing", async () => {
    getDocumentMock.mockResolvedValue(undefined);
    await expect(
      getDocumentDownload(makeDeps(makeObjectStore()), "doc-1", ADMIN_SCOPE),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s when the original was never stored (null storageKey)", async () => {
    getDocumentMock.mockResolvedValue({ ...ROW, storageKey: null });
    await expect(
      getDocumentDownload(makeDeps(makeObjectStore()), "doc-1", ADMIN_SCOPE),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s when object storage is disabled (no store)", async () => {
    getDocumentMock.mockResolvedValue(ROW);
    await expect(
      getDocumentDownload(makeDeps(null), "doc-1", ADMIN_SCOPE),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it("refuses to serve the original of a document that had identifiers redacted", async () => {
    getDocumentMock.mockResolvedValue({
      ...ROW,
      metadata: { redactedIdentifierCount: 2 },
    });
    const objectStore = makeObjectStore();

    await expect(
      getDocumentDownload(makeDeps(objectStore), "doc-1", ADMIN_SCOPE),
    ).rejects.toThrow(NotFoundError);
    expect(objectStore.get).not.toHaveBeenCalled();
  });
});
