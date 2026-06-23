import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { FakeObjectStore } from "@rag/test-fixtures";
import {
  CustomConnector,
  type StagedUpload,
  type UploadStagingStore,
} from "./index.js";

const noop = () => undefined;
const LOGGER = {
  info: noop,
  error: noop,
  warn: noop,
  debug: noop,
  child: () => LOGGER,
} as unknown as Logger;

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

/** Staging store driven by a queue of pending uploads; claim() drains it. */
class FakeStore implements UploadStagingStore {
  claimCalls: Array<{ sourceId: string; limit: number }> = [];
  constructor(private pending: StagedUpload[]) {}
  async claim(sourceId: string, limit: number): Promise<StagedUpload[]> {
    this.claimCalls.push({ sourceId, limit });
    const batch = this.pending.slice(0, limit);
    this.pending = this.pending.slice(limit);
    return batch;
  }
  async get(
    _sourceId: string,
    externalId: string,
  ): Promise<StagedUpload | null> {
    return this.pending.find((u) => u.externalId === externalId) ?? null;
  }
}

function upload(
  externalId: string,
  storageKey: string,
  overrides: Partial<StagedUpload> = {},
): StagedUpload {
  return {
    externalId,
    filename: `${externalId}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 3,
    storageKey,
    uploadedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("CustomConnector", () => {
  it("validate() throws when no object store is configured", async () => {
    const connector = new CustomConnector(
      SOURCE_ID,
      new FakeStore([]),
      null,
      LOGGER,
    );
    await expect(connector.validate()).rejects.toThrow(/object store/i);
  });

  it("validate() passes when an object store is present", async () => {
    const connector = new CustomConnector(
      SOURCE_ID,
      new FakeStore([]),
      new FakeObjectStore(new Map()),
      LOGGER,
    );
    await expect(connector.validate()).resolves.toBeUndefined();
  });

  it("list() claims uploads and maps each to a SourceDocument with its bytes", async () => {
    const objects = new Map<string, Buffer>([
      ["uploads/s/a", Buffer.from("AAA")],
      ["uploads/s/b", Buffer.from("BBB")],
    ]);
    const store = new FakeStore([
      upload("a", "uploads/s/a", { filename: "alpha.pdf" }),
      upload("b", "uploads/s/b", { filename: "beta.pdf" }),
    ]);
    const connector = new CustomConnector(
      SOURCE_ID,
      store,
      new FakeObjectStore(objects),
      LOGGER,
    );

    const result = await connector.list({ maxItems: 50 });

    expect(result.done).toBe(true); // 2 claimed < 50 limit => drained
    expect(result.nextCursor).toBeNull();
    expect(result.documents).toHaveLength(2);

    const a = result.documents[0];
    const b = result.documents[1];
    if (!a || !b) throw new Error("expected two documents");
    expect(a.externalId).toBe("a");
    expect(a.title).toBe("alpha.pdf");
    expect(a.mimeType).toBe("application/pdf");
    expect(a.modifiedAt).toBe("2026-06-22T00:00:00.000Z");
    expect(a.content.toString()).toBe("AAA");
    expect(a.metadata).toMatchObject({
      title: "alpha.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    });
    expect(b.content.toString()).toBe("BBB");

    expect(store.claimCalls).toEqual([{ sourceId: SOURCE_ID, limit: 50 }]);
  });

  it("list() reports done=false on a full page (more may remain)", async () => {
    const objects = new Map<string, Buffer>([
      ["uploads/s/a", Buffer.from("A")],
    ]);
    const store = new FakeStore([upload("a", "uploads/s/a")]);
    const connector = new CustomConnector(
      SOURCE_ID,
      store,
      new FakeObjectStore(objects),
      LOGGER,
    );

    const result = await connector.list({ maxItems: 1 });
    expect(result.documents).toHaveLength(1);
    expect(result.done).toBe(false); // claimed === limit => maybe more
  });

  it("list() returns an empty, done page when nothing is pending", async () => {
    const connector = new CustomConnector(
      SOURCE_ID,
      new FakeStore([]),
      new FakeObjectStore(new Map()),
      LOGGER,
    );
    const result = await connector.list();
    expect(result.documents).toEqual([]);
    expect(result.done).toBe(true);
  });

  it("fetch() throws for an unknown external id", async () => {
    const connector = new CustomConnector(
      SOURCE_ID,
      new FakeStore([]),
      new FakeObjectStore(new Map()),
      LOGGER,
    );
    await expect(connector.fetch("nope")).rejects.toThrow(/no staged upload/i);
  });
});
