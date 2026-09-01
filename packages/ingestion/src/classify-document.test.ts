import { describe, it, expect } from "vitest";
import { classifyDocument, isSafeAfterRedaction } from "./classify-document.js";

describe("classifyDocument — fails closed on an undeclared source", () => {
  it("classifies an undeclared source as D, not A", () => {
    // The original hole: `sourceDocClass ?? "A"` answered "we don't know" with
    // the most permissive class available.
    const r = classifyDocument({});
    expect(r.docClass).toBe("D");
    expect(r.quarantine).toBe(true);
    expect(r.reasons).toContain("unclassified-source");
  });
});

describe("classifyDocument — source class is a ceiling, not a verdict", () => {
  it("keeps a clean Class A document at A", () => {
    const r = classifyDocument({ sourceClass: "A", redactionFindings: [] });
    expect(r.docClass).toBe("A");
    expect(r.quarantine).toBe(false);
  });

  it("escalates a Class A document containing an SSN to D", () => {
    // This is the 858-document failure in one test: a "general" source does not
    // make a document with an SSN in it general.
    const r = classifyDocument({
      sourceClass: "A",
      redactionFindings: [{ kind: "ssn", count: 1 }],
    });
    expect(r.docClass).toBe("D");
    expect(r.quarantine).toBe(true);
    expect(r.reasons).toContain("identifier-found");
  });

  it("escalates on EIN, routing and card identifiers too", () => {
    for (const kind of ["ein", "routing", "card"] as const) {
      const r = classifyDocument({
        sourceClass: "A",
        redactionFindings: [{ kind, count: 1 }],
      });
      expect(r.docClass, kind).toBe("D");
    }
  });

  it("escalates a client-context path to at least C", () => {
    const r = classifyDocument({ sourceClass: "A", clientContextPath: true });
    expect(r.docClass).toBe("C");
    expect(r.quarantine).toBe(true);
    expect(r.reasons).toContain("client-context-path");
  });

  it("never downgrades a stricter source class", () => {
    // Absence of evidence must not relax a declared classification.
    const r = classifyDocument({ sourceClass: "D", redactionFindings: [] });
    expect(r.docClass).toBe("D");
  });

  it("takes the stricter of path and identifier evidence", () => {
    const r = classifyDocument({
      sourceClass: "A",
      clientContextPath: true,
      redactionFindings: [{ kind: "ssn", count: 1 }],
    });
    expect(r.docClass).toBe("D");
  });
});

describe("classifyDocument — does not escalate on weak signals", () => {
  it("ignores a zero-count finding", () => {
    const r = classifyDocument({
      sourceClass: "A",
      redactionFindings: [{ kind: "ssn", count: 0 }],
    });
    expect(r.docClass).toBe("A");
  });

  it("does not escalate on the weak account heuristic alone", () => {
    // `account` is the least precise signal in the redactor; escalating on it
    // would quarantine ordinary bookkeeping SOPs.
    const r = classifyDocument({
      sourceClass: "A",
      redactionFindings: [{ kind: "account", count: 3 }],
    });
    expect(r.docClass).toBe("A");
    expect(r.quarantine).toBe(false);
  });

  it("keeps a Class B research document at B when clean", () => {
    const r = classifyDocument({ sourceClass: "B", redactionFindings: [] });
    expect(r.docClass).toBe("B");
    expect(r.quarantine).toBe(false);
  });
});

describe("isSafeAfterRedaction — redaction is not absolution", () => {
  it("treats a document that contained an SSN as unsafe even after masking", () => {
    // Redaction masks what it recognised. It cannot prove it recognised
    // everything, and it cannot mask a name.
    const c = classifyDocument({
      sourceClass: "A",
      redactionFindings: [{ kind: "ssn", count: 4 }],
    });
    expect(isSafeAfterRedaction(c)).toBe(false);
  });

  it("allows a clean document through", () => {
    const c = classifyDocument({ sourceClass: "A", redactionFindings: [] });
    expect(isSafeAfterRedaction(c)).toBe(true);
  });
});
