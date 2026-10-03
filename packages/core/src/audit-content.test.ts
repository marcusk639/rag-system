import { describe, expect, it } from "vitest";
import { resolveAuditContent } from "./audit-content.js";

/**
 * The single place the AUDIT_LOG_CONTENT decision is applied. It exists so the
 * four audit call sites (api ask/search, mcp ask/search-documents) cannot
 * drift: a site that forgot the check would silently retain content on a
 * deployment that chose not to.
 */
describe("resolveAuditContent", () => {
  const q = "What is our intake checklist for Schedule F filings?";
  const a = "Per the intake SOP [1], Schedule F engagements require...";

  it("retains nothing under the default policy", () => {
    expect(resolveAuditContent("none", q, a)).toEqual({
      questionText: null,
      answerText: null,
    });
  });

  it("retains both when the firm has opted in", () => {
    expect(resolveAuditContent("full", q, a)).toEqual({
      questionText: q,
      answerText: a,
    });
  });

  it("keeps a null answer null rather than inventing an empty string", () => {
    // /search has no generated answer. The column must stay NULL so a query
    // for 'answers we retained' cannot pick up empty-string search rows.
    expect(resolveAuditContent("full", q, null)).toEqual({
      questionText: q,
      answerText: null,
    });
  });

  it("treats an unrecognised policy as 'none' rather than retaining", () => {
    // Fail closed: a typo in AUDIT_LOG_CONTENT must not retain content.
    expect(resolveAuditContent("Full" as unknown as "full", q, a)).toEqual({
      questionText: null,
      answerText: null,
    });
  });
});
