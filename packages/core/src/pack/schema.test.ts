import { describe, it, expect } from "vitest";
import { PackFile } from "./schema.js";

const minimal = {
  pack: { id: "cpa", version: "1.0.0", requiresCore: "^1.0.0" },
  scanners: [
    {
      id: "ssn",
      kind: "identifying",
      disposition: "exclude",
      pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    },
  ],
};

describe("PackFile", () => {
  it("accepts a minimal valid pack", () => {
    expect(PackFile.parse(minimal).scanners[0]!.id).toBe("ssn");
  });

  it("defaults disposition from kind when omitted", () => {
    const p = PackFile.parse({
      ...minimal,
      scanners: [
        { id: "a", kind: "identifying", pattern: "x" },
        { id: "b", kind: "contextual", pattern: "y" },
      ],
    });
    expect(p.scanners[0]!.disposition).toBe("exclude");
    expect(p.scanners[1]!.disposition).toBe("flag");
  });

  it("rejects a scanner with an unknown kind", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "weird", pattern: "x" }],
      }),
    ).toThrow();
  });

  it("rejects duplicate scanner ids", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [
          { id: "dup", kind: "identifying", pattern: "x" },
          { id: "dup", kind: "contextual", pattern: "y" },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("rejects a pattern that is not a valid regex", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "[unclosed" }],
      }),
    ).toThrow(/regex/i);
  });

  it("rejects a pattern that can match the empty string", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "\\d*" }],
      }),
    ).toThrow(/empty string/i);
  });

  it("rejects a pattern that is ONLY a lookahead, even though it fails .test('')", () => {
    // `(?=\d)` returns false for `.test("")` (there's no digit to look ahead
    // to in an empty string), so the empty-string guard above does not catch
    // it — this is exactly the context-dependent zero-width gap `scanText`'s
    // runtime throw backstops.
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "(?=\\d)" }],
      }),
    ).toThrow(/zero-width/i);
  });

  it("rejects a pattern that is ONLY a negative lookahead", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "(?!\\d)" }],
      }),
    ).toThrow(/zero-width/i);
  });

  it("rejects a pattern that is ONLY a lookbehind", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "(?<=x)" }],
      }),
    ).toThrow(/zero-width/i);
  });

  it("ACCEPTS a lookbehind that gates a pattern which does consume characters", () => {
    // The regression this guards: the check used to test only the PREFIX, so
    // any pattern beginning `(?<` was rejected as zero-width. That is the
    // exact shape a label-gated identifier rule needs — assert the label,
    // consume only the digits — and it is what `ssn-unformatted` in
    // packs/cpa/pack.yaml uses. Rejecting it meant the rule could not be
    // expressed as pack data at all.
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [
          {
            id: "a",
            kind: "identifying",
            pattern: "(?<=SSN[\\s:]{0,4})\\b\\d{9}\\b",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("still rejects a lookaround that closes at the very end with nothing after it", () => {
    // A nested group inside the lookaround must not be mistaken for the
    // lookaround closing early.
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [
          { id: "a", kind: "identifying", pattern: "(?=(?:ab|cd)\\d)" },
        ],
      }),
    ).toThrow(/zero-width/i);
  });

  it("does not mistake an escaped or class-bracketed paren for the lookaround's close", () => {
    // `\)` and `[)]` both contain a `)` that must NOT close the group.
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "(?<=\\()\\d{4}" }],
      }),
    ).not.toThrow();
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "b", kind: "identifying", pattern: "(?=[)])" }],
      }),
    ).toThrow(/zero-width/i);
  });

  it("rejects a pattern that is exactly a bare word boundary", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [{ id: "a", kind: "identifying", pattern: "\\b" }],
      }),
    ).toThrow(/zero-width/i);
  });

  it("still accepts a pattern that merely CONTAINS \\b as an anchor", () => {
    // The structural guard rejects a pattern that IS just `\b`; it must not
    // over-reach and reject a normal anchored pattern like the SSN scanner.
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [
          {
            id: "ssn",
            kind: "identifying",
            pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a contextWindow above 500", () => {
    expect(() =>
      PackFile.parse({
        ...minimal,
        scanners: [
          {
            id: "a",
            kind: "identifying",
            pattern: "\\d{3}",
            contextWindow: 50_000_000,
          },
        ],
      }),
    ).toThrow(/neighbourhood/i);
  });

  it("accepts a contextWindow at the 500 boundary", () => {
    const p = PackFile.parse({
      ...minimal,
      scanners: [
        {
          id: "a",
          kind: "identifying",
          pattern: "\\d{3}",
          contextWindow: 500,
        },
      ],
    });
    expect(p.scanners[0]!.contextWindow).toBe(500);
  });

  it("still defaults contextWindow to 60 when omitted", () => {
    expect(PackFile.parse(minimal).scanners[0]!.contextWindow).toBe(60);
  });
});
