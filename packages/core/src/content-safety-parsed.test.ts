import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactParsedDocument, ContentSafetyError } from "./content-safety.js";
import type { LoadedPack } from "./pack/load.js";
import { loadPack } from "./pack/load.js";
import type { ParsedTable } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CPA_PACK = loadPack(join(__dirname, "../../../packs/cpa"));

/**
 * A pack whose scanner id is NOT one of the Class-D identifiers, so a match is
 * masked but does not quarantine the document. That is the case where the
 * index can still receive the document — and therefore the case where table
 * cells leaking past redaction would actually reach the chunks table.
 */
const ACCOUNT_PACK: LoadedPack = {
  id: "acct",
  version: "1.0.0",
  scanners: [
    {
      id: "account",
      kind: "identifying",
      disposition: "redact",
      re: /\bACCT-\d{6}\b/g,
      contextWindow: 60,
    },
  ],
};

function table(overrides: Partial<ParsedTable> = {}): ParsedTable {
  return {
    markdown: "",
    sheetName: "Sheet1",
    sheetType: "tabular",
    headers: [],
    rows: [],
    rowCount: 0,
    columnCount: 0,
    ...overrides,
  };
}

describe("redactParsedDocument — tables are redacted, not only markdown", () => {
  it("masks identifiers in table rows, headers, markdown, caption, and sheet name", () => {
    const r = redactParsedDocument(
      {
        title: "Accounts",
        markdown: "| Name | Account |\n| --- | --- |\n| A | ACCT-123456 |",
        tables: [
          table({
            markdown: "| Name | Account |\n| --- | --- |\n| A | ACCT-123456 |",
            caption: "see ACCT-222222",
            sheetName: "ACCT-333333",
            headers: ["Name", "ACCT-444444"],
            rows: [["A", "ACCT-123456"]],
            rowCount: 1,
            columnCount: 2,
          }),
        ],
      },
      ACCOUNT_PACK,
    );

    const serialized = JSON.stringify(r.tables);
    expect(serialized).not.toMatch(/ACCT-\d{6}/);
    expect(r.tables[0]?.rows?.[0]).toEqual(["A", "[REDACTED-ACCT]"]);
    expect(r.tables[0]?.headers).toEqual(["Name", "[REDACTED-ACCT]"]);
    expect(r.markdown).not.toMatch(/ACCT-\d{6}/);
  });

  it("preserves table shape (row and column counts) and non-sensitive cells", () => {
    const rows = [
      ["Step 1", "Open Karbon"],
      ["Step 2", "Apply BK-CATCHUP"],
    ];
    const r = redactParsedDocument(
      {
        title: "SOP",
        markdown: "x",
        tables: [
          table({
            headers: ["Step", "Action"],
            rows,
            rowCount: 2,
            columnCount: 2,
          }),
        ],
      },
      CPA_PACK,
    );
    expect(r.tables[0]?.rows).toEqual(rows);
    expect(r.tables[0]?.headers).toEqual(["Step", "Action"]);
    expect(r.totalRedacted).toBe(0);
  });

  it("catches an SSN roster column whose label sits only in the header row", () => {
    // The shape that motivated the tabular sweep: `SSN` appears once, in the
    // header, and the 9-digit values sit in the rows beneath it.
    const r = redactParsedDocument(
      {
        title: "Roster",
        markdown: "",
        tables: [
          table({
            headers: ["Name", "SSN"],
            rows: [
              ["A", "123456789"],
              ["B", "234567891"],
              ["C", "345678912"],
            ],
            rowCount: 3,
            columnCount: 2,
          }),
        ],
      },
      CPA_PACK,
    );
    expect(JSON.stringify(r.tables)).not.toMatch(/\b\d{9}\b/);
    expect(r.findings).toContainEqual(expect.objectContaining({ kind: "ssn" }));
  });

  it("does not let a pattern match across two cells", () => {
    // "123-45" | "6789" must not be read as one SSN spanning the boundary.
    const r = redactParsedDocument(
      {
        title: "t",
        markdown: "",
        tables: [
          table({
            headers: ["a", "b"],
            rows: [["123-45", "6789"]],
            rowCount: 1,
            columnCount: 2,
          }),
        ],
      },
      CPA_PACK,
    );
    expect(r.tables[0]?.rows?.[0]).toEqual(["123-45", "6789"]);
  });

  it("redacts the document title", () => {
    const r = redactParsedDocument(
      { title: "Notes for SSN 123-45-6789", markdown: "body", tables: [] },
      CPA_PACK,
    );
    expect(r.title).not.toContain("123-45-6789");
    expect(r.findings).toContainEqual(expect.objectContaining({ kind: "ssn" }));
  });

  it("counts a value mirrored in markdown and a table once, not twice", () => {
    const md = "| Account |\n| --- |\n| ACCT-123456 |";
    const r = redactParsedDocument(
      {
        title: "t",
        markdown: md,
        tables: [
          table({
            markdown: md,
            headers: ["Account"],
            rows: [["ACCT-123456"]],
            rowCount: 1,
            columnCount: 1,
          }),
        ],
      },
      ACCOUNT_PACK,
    );
    expect(r.findings).toEqual([{ kind: "account", count: 1 }]);
  });

  it("fails closed when a cell contains the internal separator", () => {
    expect(() =>
      redactParsedDocument(
        {
          title: "t",
          markdown: "",
          tables: [
            table({
              headers: ["a"],
              rows: [["x␟y"]],
              rowCount: 1,
              columnCount: 1,
            }),
          ],
        },
        CPA_PACK,
      ),
    ).toThrow(ContentSafetyError);
  });

  it("fails closed on an empty-scanner pack", () => {
    expect(() =>
      redactParsedDocument(
        { title: "t", markdown: "m", tables: [] },
        { ...CPA_PACK, scanners: [] },
      ),
    ).toThrow(ContentSafetyError);
  });
});
