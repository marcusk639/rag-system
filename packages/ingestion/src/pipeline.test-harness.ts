import { vi } from "vitest";
import type { Logger } from "pino";
import type {
  Chunk,
  Connector,
  ConnectorListResult,
  ContentScanner,
  LoadedPack,
  Parser,
} from "@rag/core";
import { FakeEmbedder, FakeObjectStore } from "@rag/test-fixtures";
import type { PipelineDeps } from "./pipeline.js";

/**
 * `packs/cpa/pack.yaml` exists (Task 6 authored it), but this suite builds
 * the equivalent pack in memory rather than loading it — same shape as the
 * scanners `redactText` used to hardcode. Only `ssn`/`ein` are needed: the
 * "BLOCKS a document containing an SSN" test below depends on this pack
 * actually finding the identifier, exactly as the pre-migration hardcoded
 * patterns did.
 */
export const TEST_PACK: LoadedPack = {
  id: "test",
  version: "1.0.0",
  scanners: [
    {
      id: "ssn",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{3}-\d{2}-\d{4}\b/g,
      contextWindow: 60,
    },
    {
      id: "ein",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{2}-\d{7}\b/g,
      contextWindow: 60,
    },
  ],
};

/** Layer 1.5 fake: reports nothing flagged. Tests that need the flagged path
 * build their own scanner inline, same convention as `objectStore` overrides. */
export const CLEAN_SCANNER: ContentScanner = {
  name: "fake-clean",
  scan: async () => ({ flagged: false, findings: [] }),
};

export const OPTS = { concurrency: 2, pageSize: 50 };

export interface FakePage {
  documents: string[]; // externalIds
  nextCursor: string | null;
  done: boolean;
  deletions?: string[];
  skippedOversize?: number;
}

/** A connector that hands back a fixed sequence of pages, one per list() call. */
export function makeConnector(pages: FakePage[]) {
  const received: { cursor: string | null }[] = [];
  let i = 0;
  const connector = {
    kind: "custom",
    validate: vi.fn(),
    fetch: vi.fn(),
    list: vi.fn(
      async (opts: { cursor: string | null }): Promise<ConnectorListResult> => {
        received.push({ cursor: opts.cursor });
        const page = pages[Math.min(i, pages.length - 1)];
        if (!page) throw new Error("makeConnector: no page configured");
        i++;
        return {
          documents: page.documents.map((externalId) => ({
            externalId,
            title: externalId,
            modifiedAt: new Date().toISOString(),
            mimeType: "text/plain",
            content: Buffer.from(`content-${externalId}`),
            metadata: {},
          })),
          nextCursor: page.nextCursor,
          done: page.done,
          deletions: page.deletions,
          skippedOversize: page.skippedOversize,
        };
      },
    ),
  };
  return { connector: connector as unknown as Connector, received };
}

export function makeDeps(): PipelineDeps {
  // Layer 3 (2026-08-03) made an undeclared source class fail CLOSED to "D",
  // so every document quarantines unless the caller declares a class. These
  // tests previously relied on the implicit `?? "A"` public default — the same
  // implicit default that let 858 unclassified documents into a public index.
  // Declaring it here keeps the tests' intent and makes the dependency visible.
  const parser: Parser = {
    parse: vi.fn(async ({ filename }) => ({
      title: String(filename),
      markdown: `# ${filename}\n\nbody`,
      tables: [],
      metadata: {},
    })),
  } as unknown as Parser;

  const chunk: Chunk = {
    hash: "h",
    text: "t",
    tokenCount: 1,
    ordinal: 0,
    headingPath: [],
  };
  const chunker = {
    chunk: vi.fn(async (): Promise<Chunk[]> => [chunk]),
  } as unknown as PipelineDeps["chunker"];

  const embedder = new FakeEmbedder();

  const noop = () => undefined;
  const logger = {
    info: noop,
    error: noop,
    warn: noop,
    debug: noop,
    child: () => logger,
  } as unknown as Logger;

  return {
    sourceDocClass: "A",
    db: {} as PipelineDeps["db"],
    parser,
    chunker,
    embedder,
    logger,
    pack: TEST_PACK,
    scanner: CLEAN_SCANNER,
  };
}

export function makeObjectStore() {
  const store = new FakeObjectStore(new Map());
  vi.spyOn(store, "put");
  vi.spyOn(store, "delete");
  return store as FakeObjectStore & {
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}
