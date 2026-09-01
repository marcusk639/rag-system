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
});
