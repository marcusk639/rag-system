import { Readable } from "node:stream";
import type { ObjectStore } from "@rag/core";

/** In-memory object store keyed by logical storage key. */
export class FakeObjectStore implements ObjectStore {
  readonly bucket = "test-bucket";
  constructor(private readonly objects: Map<string, Buffer>) {}
  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, body);
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error(`FakeObjectStore: missing key ${key}`);
    return { body: Readable.from(body), contentType: "application/pdf" };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
