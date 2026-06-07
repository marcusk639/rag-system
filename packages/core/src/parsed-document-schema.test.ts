import { describe, expect, it } from "vitest";
import { ParsedDocumentSchema } from "./types.js";
import type { ParsedDocument } from "./types.js";

const VALID: ParsedDocument = {
  markdown: "# Title\n\nBody text.",
  title: "Title",
  tables: [
    {
      markdown: "| a | b |\n| - | - |\n| 1 | 2 |",
      caption: "Sample",
      sheetName: "Sheet1",
      sheetType: "tabular",
      headers: ["a", "b"],
      rows: [["1", "2"]],
      rowCount: 1,
      columnCount: 2,
    },
  ],
  metadata: { title: "Title", mimeType: "text/markdown" },
};

describe("ParsedDocumentSchema", () => {
  it("accepts a fully-populated valid ParsedDocument", () => {
    const parsed = ParsedDocumentSchema.parse(VALID);
    expect(parsed).toEqual(VALID);
  });

  it("accepts a minimal document with empty tables and metadata", () => {
    const minimal = {
      markdown: "hello",
      title: "Hi",
      tables: [],
      metadata: {},
    };
    expect(ParsedDocumentSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts a table with only the required markdown field", () => {
    const doc = {
      markdown: "x",
      title: "x",
      tables: [{ markdown: "| h |" }],
      metadata: {},
    };
    expect(() => ParsedDocumentSchema.parse(doc)).not.toThrow();
  });

  it("rejects a document missing the required markdown field", () => {
    const bad = { title: "x", tables: [], metadata: {} };
    expect(() => ParsedDocumentSchema.parse(bad)).toThrow();
  });

  it("rejects a document where markdown is the wrong type", () => {
    const bad = { markdown: 123, title: "x", tables: [], metadata: {} };
    expect(() => ParsedDocumentSchema.parse(bad)).toThrow();
  });

  it("rejects an invalid sheetType enum value", () => {
    const bad = {
      markdown: "x",
      title: "x",
      tables: [{ markdown: "t", sheetType: "bogus" }],
      metadata: {},
    };
    expect(() => ParsedDocumentSchema.parse(bad)).toThrow();
  });

  it("rejects tables that are not an array", () => {
    const bad = { markdown: "x", title: "x", tables: {}, metadata: {} };
    expect(() => ParsedDocumentSchema.parse(bad)).toThrow();
  });
});
