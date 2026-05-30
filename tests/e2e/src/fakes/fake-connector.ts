import type {
  Connector,
  ConnectorListOptions,
  ConnectorListResult,
  SourceDocument,
} from "@rag/core";

/**
 * In-memory Connector. Constructed with a fixed list of SourceDocuments; the
 * first `list()` returns them all, subsequent calls return empty + done.
 *
 * Real connectors paginate against external APIs; for E2E we want determinism
 * and zero external dependencies, so this is the substrate every spec ingests
 * against.
 */
export class FakeConnector implements Connector {
  readonly kind = "custom";
  private exhausted = false;

  constructor(private readonly docs: SourceDocument[]) {}

  async validate(): Promise<void> {
    // FakeConnector is always valid by construction.
  }

  async list(_options?: ConnectorListOptions): Promise<ConnectorListResult> {
    if (this.exhausted) {
      return { documents: [], nextCursor: null, done: true };
    }
    this.exhausted = true;
    return {
      documents: this.docs,
      nextCursor: "e2e-cursor-1",
      done: true,
    };
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    const doc = this.docs.find((d) => d.externalId === externalId);
    if (!doc) throw new Error(`FakeConnector: no document ${externalId}`);
    return doc;
  }

  /**
   * Mutate the doc set in place between ingestion runs. Useful for the
   * idempotency / update specs.
   */
  reset(docs: SourceDocument[]): void {
    this.docs.splice(0, this.docs.length, ...docs);
    this.exhausted = false;
  }
}
