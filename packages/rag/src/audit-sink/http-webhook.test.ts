import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogRecord } from "@rag/core";
import { EgressPolicy } from "@rag/core";
import { HttpWebhookAuditLogSink } from "./http-webhook.js";

function makeRow(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: "row-1",
    principalKind: "scoped",
    principalSources: ["source-a"],
    principalSubject: "aad-oid-123",
    questionHash: "hash-1",
    channel: "api",
    model: "gemini-2.5-flash",
    sourceIds: ["source-a"],
    chunkIds: ["chunk-1"],
    docIds: ["doc-1"],
    retrievedCount: 1,
    endpoint: "ask",
    topScore: 0.8,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("HttpWebhookAuditLogSink", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  it("POSTs rows as JSON to the configured URL with the configured auth header", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const policy = new EgressPolicy(["collector.example.com"]);
    const sink = new HttpWebhookAuditLogSink({
      url: "https://collector.example.com/ingest",
      token: "secret-token",
      egressPolicy: policy,
    });
    const rows = [makeRow()];

    await sink.ship(rows);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://collector.example.com/ingest");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      }),
    });
    expect(JSON.parse(init.body)).toEqual(
      rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  });

  it("throws when the response is not ok", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    const policy = new EgressPolicy(["collector.example.com"]);
    const sink = new HttpWebhookAuditLogSink({
      url: "https://collector.example.com/ingest",
      egressPolicy: policy,
    });

    await expect(sink.ship([makeRow()])).rejects.toThrow(/500/);
  });

  it("calls EgressPolicy.assertAllowed(webhookUrl) before ever calling fetch, and throws (never silently swallows) if the URL is not allowed", async () => {
    // Policy allows a DIFFERENT host than the configured webhook URL, so
    // assertAllowed must reject it.
    const policy = new EgressPolicy(["allowed-host.example.com"]);
    const sink = new HttpWebhookAuditLogSink({
      url: "https://not-allowed.example.com/ingest",
      egressPolicy: policy,
    });

    await expect(sink.ship([makeRow()])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
