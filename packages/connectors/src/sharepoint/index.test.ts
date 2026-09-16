import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { SharePointConnector } from "./index.js";
import type { GraphReader } from "./client.js";
import type { GraphCredentials } from "./client.js";

const CREDS: GraphCredentials = {
  tenantId: "t",
  clientId: "c",
  clientSecret: "s",
};

const noop = () => undefined;
const LOGGER = {
  info: noop,
  error: noop,
  warn: noop,
  debug: noop,
  child: () => LOGGER,
} as unknown as Logger;

/** A Graph reader driven by a url→json router; records every requested URL. */
class FakeGraph implements GraphReader {
  readonly calls: string[] = [];
  constructor(
    private readonly route: (url: string) => unknown,
    private readonly contentType = "application/pdf",
  ) {}

  async getJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    const res = this.route(url);
    if (res === undefined) {
      throw new Error(`FakeGraph: no json route for ${url}`);
    }
    return res as T;
  }

  async getBytes(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    this.calls.push(url);
    return { bytes: Buffer.from("file-bytes"), contentType: this.contentType };
  }
}

interface FileOpts {
  size?: number;
  deleted?: boolean;
}

/** Build a Graph driveItem fixture (a file, or a tombstone when deleted). */
function file(id: string, opts: FileOpts = {}): Record<string, unknown> {
  if (opts.deleted) {
    return { id, deleted: { state: "deleted" } };
  }
  return {
    id,
    name: `${id}.pdf`,
    webUrl: `https://sp.example.com/${id}`,
    lastModifiedDateTime: "2026-01-01T00:00:00.000Z",
    createdDateTime: "2025-12-01T00:00:00.000Z",
    size: opts.size ?? 1000,
    file: { mimeType: "application/pdf" },
  };
}

function makeConnector(config: unknown, route: (url: string) => unknown) {
  const graph = new FakeGraph(route);
  const connector = new SharePointConnector(config, CREDS, LOGGER, graph);
  return { connector, graph };
}

describe("SharePointConnector", () => {
  it("validate() probes the configured site", async () => {
    const { connector, graph } = makeConnector({ siteId: "s" }, () => ({}));
    await connector.validate();
    expect(graph.calls).toContain("/sites/s");
  });

  it("enumerates EVERY document library across paginated /drives pages", async () => {
    // The site's drives span two Graph pages; the connector must follow the
    // `@odata.nextLink` or it would silently drop drives past page one.
    const route = (url: string): unknown => {
      if (url.endsWith("/sites/site1/drives")) {
        return {
          value: [
            { id: "d1", driveType: "documentLibrary" },
            { id: "d2", driveType: "documentLibrary" },
          ],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/sites/site1/drives?page=2",
        };
      }
      if (url.includes("drives?page=2")) {
        return { value: [{ id: "d3", driveType: "documentLibrary" }] };
      }
      // Each drive's delta yields one file then terminates.
      const m = url.match(/\/drives\/(d\d)\/root\/delta/);
      if (m) {
        return {
          value: [file(`${m[1]}f1`)],
          "@odata.deltaLink": `https://graph.microsoft.com/v1.0/delta-${m[1]}`,
        };
      }
      return undefined;
    };

    const { connector } = makeConnector({ siteId: "site1" }, route);
    const res = await connector.list({ maxItems: 50 });

    expect(res.documents.map((d) => d.externalId).sort()).toEqual([
      "d1:d1f1",
      "d2:d2f1",
      "d3:d3f1",
    ]);
    expect(res.done).toBe(true);
  });

  it("follows the delta @odata.nextLink within a single drive", async () => {
    const route = (url: string): unknown => {
      if (url.endsWith("/drives/d1/root/delta")) {
        return {
          value: [file("f1")],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/delta-d1-page2",
        };
      }
      if (url.includes("delta-d1-page2")) {
        return {
          value: [file("f2")],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-final",
        };
      }
      return undefined;
    };

    const { connector } = makeConnector({ siteId: "s", driveId: "d1" }, route);
    const res = await connector.list({ maxItems: 50 });

    expect(res.documents.map((d) => d.externalId)).toEqual(["d1:f1", "d1:f2"]);
    expect(res.done).toBe(true);
  });

  it("honors folderPath only on the explicitly targeted drive", async () => {
    const { connector, graph } = makeConnector(
      { siteId: "s", driveId: "d1", folderPath: "Marketing/2024" },
      () => ({ value: [], "@odata.deltaLink": "x" }),
    );
    await connector.list({ maxItems: 50 });

    expect(graph.calls).toContain("/drives/d1/root:/Marketing/2024:/delta");
  });

  it("skips and COUNTS oversize files instead of dropping them silently", async () => {
    const route = () => ({
      value: [file("big", { size: 1000 }), file("ok", { size: 50 })],
      "@odata.deltaLink": "x",
    });
    const { connector } = makeConnector(
      { siteId: "s", driveId: "d1", maxFileBytes: 100 },
      route,
    );
    const res = await connector.list({ maxItems: 50 });

    expect(res.documents.map((d) => d.externalId)).toEqual(["d1:ok"]);
    expect(res.skippedOversize).toBe(1);
  });

  it("surfaces delta tombstones as deletions (for chunk reconciliation)", async () => {
    const route = () => ({
      value: [file("f1"), file("del1", { deleted: true })],
      "@odata.deltaLink": "x",
    });
    const { connector } = makeConnector({ siteId: "s", driveId: "d1" }, route);
    const res = await connector.list({ maxItems: 50 });

    expect(res.documents.map((d) => d.externalId)).toEqual(["d1:f1"]);
    expect(res.deletions).toEqual(["d1:del1"]);
  });

  it("captures webUrl and source identifiers in document metadata", async () => {
    const route = () => ({
      value: [file("f1")],
      "@odata.deltaLink": "x",
    });
    const { connector } = makeConnector(
      { siteId: "site9", driveId: "d1" },
      route,
    );
    const res = await connector.list({ maxItems: 50 });

    const doc = res.documents[0]!;
    expect(doc.metadata.url).toBe("https://sp.example.com/f1");
    expect(doc.metadata.extra).toEqual({
      siteId: "site9",
      driveId: "d1",
      itemId: "f1",
    });
  });

  describe("per-source excludePaths", () => {
    function inFolder(id: string, parentPath: string) {
      return { ...file(id), parentReference: { driveId: "d1", path: parentPath } };
    }

    it("never downloads an item under an excluded folder, and reports it as a deletion", async () => {
      const route = () => ({
        value: [
          inFolder("sop", "/drive/root:/Procedures"),
          inFolder("client", "/drive/root:/Clients/Smith Family"),
        ],
        "@odata.deltaLink": "x",
      });
      const { connector, graph } = makeConnector(
        { siteId: "s", driveId: "d1", excludePaths: ["/clients/"] },
        route,
      );
      const res = await connector.list({ maxItems: 50 });

      expect(res.documents.map((d) => d.externalId)).toEqual(["d1:sop"]);
      // Removes any copy indexed before the exclusion was configured.
      expect(res.deletions).toEqual(["d1:client"]);
      expect(graph.calls.some((u) => u.includes("/items/client/content"))).toBe(false);
    });

    it("applies the built-in client-content denylist even with no excludePaths configured", async () => {
      const route = () => ({
        value: [inFolder("letter", "/drive/root:/Admin/Engagement Letters")],
        "@odata.deltaLink": "x",
      });
      const { connector, graph } = makeConnector({ siteId: "s", driveId: "d1" }, route);
      const res = await connector.list({ maxItems: 50 });
      expect(res.documents).toEqual([]);
      expect(graph.calls.some((u) => u.includes("/content"))).toBe(false);
    });

    it("refuses to fetch an excluded item by id (retry path)", async () => {
      const route = (url: string) =>
        url.includes("/items/client") ? inFolder("client", "/drive/root:/Clients/Jones") : undefined;
      const { connector, graph } = makeConnector(
        { siteId: "s", driveId: "d1", excludePaths: ["/clients/"] },
        route,
      );
      await expect(connector.fetch("d1:client")).rejects.toThrow(/excluded/i);
      expect(graph.calls.some((u) => u.includes("/content"))).toBe(false);
    });
  });
});
