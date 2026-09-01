import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPack } from "./load.js";
import { scanText } from "./scan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pack = loadPack(join(__dirname, "../../../../packs/cpa"));

describe("cpa pack", () => {
  it("declares the identifier scanners the redactor relied on", () => {
    expect(pack.scanners.map((s) => s.id).sort()).toEqual([
      "card",
      "ein",
      "routing",
      "ssn",
      "ssn-unformatted",
    ]);
  });

  it("compiles ssn-unformatted case-insensitively so a lowercase label still gates", () => {
    const s = pack.scanners.find((x) => x.id === "ssn-unformatted");
    expect(s!.re.flags).toContain("i");
  });

  it("matches a label-gated bare SSN as high, masking only the digits", () => {
    const text = "Client ssn on file: 123456789 — see the folder.";
    const [m] = scanText(text, pack).filter(
      (x) => x.scannerId === "ssn-unformatted",
    );
    expect(m!.confidence).toBe("high");
    // The lookbehind must leave the label and the prose between it and the
    // number outside the match — otherwise redaction swallows the sentence.
    expect(text.slice(m!.start, m!.end)).toBe("123456789");
  });

  it("leaves an unlabelled bare 9-digit run to the density sweep, not this scanner", () => {
    const hits = scanText("Reference document 100200300 in the folder.", pack);
    expect(hits.filter((x) => x.scannerId === "ssn-unformatted")).toEqual([]);
  });

  it("matches a formatted SSN as high", () => {
    const [m] = scanText("SSN 123-45-6789", pack).filter(
      (x) => x.scannerId === "ssn",
    );
    expect(m!.confidence).toBe("high");
  });

  it("matches an EIN as high", () => {
    const [m] = scanText("EIN 12-3456789", pack).filter(
      (x) => x.scannerId === "ein",
    );
    expect(m!.confidence).toBe("high");
  });

  it("treats a Luhn-valid card as high", () => {
    const [m] = scanText("card 4111 1111 1111 1111", pack).filter(
      (x) => x.scannerId === "card",
    );
    expect(m!.confidence).toBe("high");
  });

  it("treats a Luhn-invalid card as low rather than dropping it", () => {
    const ms = scanText("card 4111 1111 1111 1112", pack).filter(
      (x) => x.scannerId === "card",
    );
    expect(ms).toHaveLength(1);
    expect(ms[0]!.confidence).toBe("low");
  });

  it("requires account vocabulary for a routing number", () => {
    const near = scanText("routing 011000015", pack).filter(
      (x) => x.scannerId === "routing",
    );
    const far = scanText("total 011000015", pack).filter(
      (x) => x.scannerId === "routing",
    );
    expect(near[0]!.confidence).toBe("high");
    expect(far[0]!.confidence).toBe("low");
  });

  it("does NOT treat a bare 9-digit run as an SSN", () => {
    // The pattern is delimiter-anchored on purpose: bare runs in this corpus are
    // far more often amounts or IDs, and over-redaction destroys the SOPs.
    expect(
      scanText("total 123456789", pack).filter((x) => x.scannerId === "ssn"),
    ).toHaveLength(0);
  });
});
