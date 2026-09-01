import { describe, it, expect } from "vitest";
import { scanText, maskValue } from "./scan.js";
import { resolveValidator } from "./registry.js";
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
    // The actual incident shape (task-4 fix round 1, finding 3): a validator with
    // NO context gate. This is the exact configuration where an earlier draft's
    // "low = fails only the context gate" definition left a validator failure
    // belonging to no bucket and silently dropped it — a Luhn-failing card number
    // (one digit lost to OCR) hit this hole in production.
    {
      id: "card",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{16}\b/g,
      validate: resolveValidator("luhn"),
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
    // Exact expected values, not a shape pattern (task-4 fix round 1, finding 4):
    // asserting each slice merely MATCHES /^\d{3}-\d{2}-\d{4}$/ would still pass if
    // the engine returned the same match three times over (e.g. start 0,0,0), since
    // every candidate slice happens to fit that pattern here. Asserting the exact,
    // distinct list is the only check that discriminates real per-match offsets
    // from a degenerate engine that repeats one match.
    expect(ms.map((m) => text.slice(m.start, m.end))).toEqual([
      "111-11-1111",
      "222-22-2222",
      "333-33-3333",
    ]);
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

  it("demotes to low when the validator fails and there is NO context gate (the card/luhn shape), and does NOT drop it", () => {
    // task-4 fix round 1, finding 3: neither fixture above exercises "validator,
    // no context" — the exact shape of the original incident. A card number one
    // digit off from a valid Luhn checksum (as if OCR dropped a digit) must still
    // appear, labeled low, never absent.
    const ms = scanText("card 4111111111111112 on file", pack).filter(
      (x) => x.scannerId === "card",
    );
    expect(ms).toHaveLength(1);
    expect(ms[0]!.confidence).toBe("low");
  });

  it("still finds a match when a hand-constructed scanner regex carries the sticky (y) flag", () => {
    // task-4 fix round 1, finding 2: CompiledScanner is exported and hand-
    // constructible (as this very fixture proves), so a `y`-flagged scanner regex
    // is reachable even though loadPack always compiles with plain "g". Preserving
    // the author's flags via passthrough (`flags.includes("g") ? flags : flags +
    // "g"`) previously produced "yg", which anchors every match attempt at
    // lastIndex and returns nothing for a document that visibly contains the
    // identifier — a silent total-drop path.
    const stickyPack: LoadedPack = {
      id: "test",
      version: "1.0.0",
      scanners: [
        {
          id: "sticky-ssn",
          kind: "identifying",
          disposition: "exclude",
          re: /\d{3}-\d{2}-\d{4}/y,
          contextWindow: 60,
        },
      ],
    };
    const text = "prefix 123-45-6789 suffix";
    const ms = scanText(text, stickyPack);
    expect(ms).toHaveLength(1);
    expect(text.slice(ms[0]!.start, ms[0]!.end)).toBe("123-45-6789");
  });
});

describe("scanText — zero-width matches", () => {
  it("throws, naming the scanner id, rather than inserting a mask token at every position", () => {
    // Fix (MEDIUM, whole-branch review), and a DELIBERATE override of the
    // reviewer's suggested `if (m[0].length === 0) continue;` fix: silently
    // skipping a zero-width match would leave the scanner effectively
    // disabled while everything downstream still reports a healthy run —
    // the same silent-scanner-disablement shape as an empty-scanner pack.
    // `(?=\d)` compiles fine and returns false for `.test("")` (the schema
    // guard's check), but matches zero-width before every digit in real text.
    const pack: LoadedPack = {
      id: "test",
      version: "1.0.0",
      scanners: [
        {
          id: "zero-width-lookahead",
          kind: "identifying",
          disposition: "exclude",
          re: /(?=\d)/g,
          contextWindow: 60,
        },
      ],
    };
    expect(() => scanText("value 123 here", pack)).toThrow(
      /zero-width-lookahead/,
    );
    expect(() => scanText("value 123 here", pack)).toThrow(/zero-width/);
  });

  it("throws for a bare \\b scanner pattern the same way", () => {
    const pack: LoadedPack = {
      id: "test",
      version: "1.0.0",
      scanners: [
        {
          id: "word-boundary",
          kind: "identifying",
          disposition: "exclude",
          re: /\b/g,
          contextWindow: 60,
        },
      ],
    };
    expect(() => scanText("hello world", pack)).toThrow(/word-boundary/);
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
