import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { ConnectorTransientError } from "@rag/core";
import { EcfrPart4Connector } from "./index.js";

const LOGGER = pino({ level: "silent" });

const LAST_MODIFIED = "Tue, 16 Jun 2026 21:20:12 GMT";

// Mirrors the real govinfo.gov bulk XML structure: DIV5 (part) is nested
// under DIV1 (title) -> DIV3 (chapter), and DIV8 (section) sits under an
// intermediate DIV6 (subpart), not directly under DIV5.
const TITLE_XML = `<?xml version="1.0"?>
<DLPSTEXTCLASS>
<TEXT>
<BODY>
<ECFRBRWS>
<DIV1 N="38" TYPE="TITLE">
  <HEAD>TITLE 38--Pensions, Bonuses, and Veterans' Relief</HEAD>
  <DIV3 N="I" TYPE="CHAPTER">
    <HEAD>CHAPTER I--Department of Veterans Affairs</HEAD>
    <DIV5 N="4" NODE="38:1.0.1.1.5" TYPE="PART">
      <HEAD>PART 4--SCHEDULE FOR RATING DISABILITIES</HEAD>
      <DIV6 N="A" TYPE="SUBPART">
        <HEAD>Subpart A--General Provisions</HEAD>
        <DIV8 N="§ 4.1" TYPE="SECTION">
          <HEAD>§ 4.1 Essentials of evaluative rating.</HEAD>
          <P>This is the essentials of evaluative rating text.</P>
        </DIV8>
      </DIV6>
      <DIV6 N="B" TYPE="SUBPART">
        <HEAD>Subpart B--Disability Ratings</HEAD>
        <DIV8 N="§ 4.130" TYPE="SECTION">
          <HEAD>§ 4.130 Schedule of ratings -- mental disorders.</HEAD>
          <P>This is the mental disorders rating schedule text.</P>
        </DIV8>
      </DIV6>
    </DIV5>
  </DIV3>
</DIV1>
</ECFRBRWS>
</BODY>
</TEXT>
</DLPSTEXTCLASS>`;

function mockFetchOnce(response: {
  body: string;
  status?: number;
  headers?: Record<string, string>;
}) {
  const fetchMock = vi.fn(async () => {
    const status = response.status ?? 200;
    return {
      status,
      ok: status < 300,
      text: async () => response.body,
      headers: {
        get: (name: string) =>
          response.headers?.[name.toLowerCase()] ?? null,
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("EcfrPart4Connector", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("validate() throws ConnectorTransientError when the bulk XML source returns a 503", async () => {
    mockFetchOnce({ body: "", status: 503 });
    const connector = new EcfrPart4Connector({ title: 38, part: "4" }, LOGGER);
    await expect(connector.validate()).rejects.toBeInstanceOf(
      ConnectorTransientError,
    );
  });

  it("validate() throws ConnectorTransientError when the bulk XML source returns a 429", async () => {
    mockFetchOnce({ body: "", status: 429 });
    const connector = new EcfrPart4Connector({ title: 38, part: "4" }, LOGGER);
    await expect(connector.validate()).rejects.toBeInstanceOf(
      ConnectorTransientError,
    );
  });

  it("sends a realistic browser User-Agent header on its fetch", async () => {
    const fetchMock = mockFetchOnce({
      body: TITLE_XML,
      headers: { "last-modified": LAST_MODIFIED },
    });
    const connector = new EcfrPart4Connector({ title: 38, part: "4" }, LOGGER);
    await connector.validate();

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla/);
  });

  it("full sync (no cursor) recursively finds sections nested under DIV1/DIV3/DIV5/DIV6", async () => {
    mockFetchOnce({
      body: TITLE_XML,
      headers: { "last-modified": LAST_MODIFIED },
    });
    const connector = new EcfrPart4Connector({ title: 38, part: "4" }, LOGGER);
    const result = await connector.list();

    expect(result.nextCursor).toBe(LAST_MODIFIED);
    expect(result.done).toBe(true);
    expect(result.documents).toHaveLength(2);

    const section130 = result.documents.find((d) => d.externalId === "4.130");
    expect(section130?.externalId).toBe("4.130");
    expect(section130?.title).toContain("mental disorders");
    expect(section130?.content.toString()).toContain(
      "mental disorders rating schedule text",
    );
    expect(section130?.modifiedAt).toBe(LAST_MODIFIED);

    const section1 = result.documents.find((d) => d.externalId === "4.1");
    expect(section1).toBeDefined();
    expect(section1?.modifiedAt).toBe(LAST_MODIFIED);
  });

  it("returns no documents when the cursor matches the current last-modified value", async () => {
    mockFetchOnce({
      body: TITLE_XML,
      headers: { "last-modified": LAST_MODIFIED },
    });
    const connector = new EcfrPart4Connector({ title: 38, part: "4" }, LOGGER);
    const result = await connector.list({ cursor: LAST_MODIFIED });

    expect(result.documents).toHaveLength(0);
    expect(result.nextCursor).toBe(LAST_MODIFIED);
  });

  it("fetch() returns a single section by its stripped external id", async () => {
    mockFetchOnce({
      body: TITLE_XML,
      headers: { "last-modified": LAST_MODIFIED },
    });
    const connector = new EcfrPart4Connector({ title: 38, part: "4" }, LOGGER);
    const doc = await connector.fetch("4.1");
    expect(doc.title).toContain("Essentials of evaluative rating");
    expect(doc.modifiedAt).toBe(LAST_MODIFIED);
  });
});
