import { describe, it, expect } from "vitest";
import { scanText, maskValue } from "./scan.js";
import type { LoadedPack } from "./load.js";

const pack: LoadedPack = {
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
      id: "routing",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{9}\b/g,
      validate: (m) => m === "011000015",
      context: /\b(routing|account)\b/i,
      contextWindow: 60,
    },
  ],
};

describe("scanText", () => {
  it("reports a clean match as high with correct offsets", () => {
    const text = "SSN 123-45-6789 here";
    const [m] = scanText(text, pack);
    expect(m!.scannerId).toBe("ssn");
    expect(m!.confidence).toBe("high");
    expect(text.slice(m!.start, m!.end)).toBe("123-45-6789");
  });

  it("offsets stay valid for every match in a dense document", () => {
    const text = "111-11-1111 222-22-2222 333-33-3333";
    const ms = scanText(text, pack);
    expect(ms).toHaveLength(3);
    for (const m of ms)
      expect(text.slice(m.start, m.end)).toMatch(/^\d{3}-\d{2}-\d{4}$/);
  });

  it("demotes to low when the context gate fails, and does NOT drop it", () => {
    const [m] = scanText("value 011000015 alone", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(m).toBeDefined();
    expect(m!.confidence).toBe("low");
  });

  it("promotes to high when context is present", () => {
    const [m] = scanText("routing 011000015", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(m!.confidence).toBe("high");
  });

  it("demotes to low when the VALIDATOR fails, and does NOT drop it", () => {
    // Spec §3.1: an earlier draft defined `low` as "fails only the context gate",
    // which left validator failures belonging to no bucket at all.
    const ms = scanText("routing 123456789", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(ms).toHaveLength(1);
    expect(ms[0]!.confidence).toBe("low");
  });

  it("never returns a match whose masked sample contains the raw value", () => {
    const text = "SSN 123-45-6789";
    for (const m of scanText(text, pack)) {
      expect(m.maskedSample).not.toContain("123-45-6789");
    }
  });
});

describe("maskValue", () => {
  it("preserves shape and first/last character", () => {
    expect(maskValue("123-45-6789")).toBe("1XXXXXXXXX9");
  });

  it("masks a two-character value entirely", () => {
    expect(maskValue("ab")).toBe("XX");
  });
});
