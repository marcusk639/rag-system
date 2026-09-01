import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, satisfiesCaret, PACK_CONTRACT_VERSION } from "./load.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pack-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writePack(body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.yaml"), body, "utf8");
}

describe("loadPack", () => {
  it("loads a valid pack and compiles its patterns", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^${PACK_CONTRACT_VERSION.split(".")[0]}.0.0" }
scanners:
  - id: ssn
    kind: identifying
    pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b'
`);
    const p = loadPack(dir);
    expect(p.id).toBe("cpa");
    expect(p.scanners[0]!.re.test("123-45-6789")).toBe(true);
    expect(p.scanners[0]!.disposition).toBe("exclude");
  });

  it("resolves a named validator onto the compiled scanner", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^${PACK_CONTRACT_VERSION.split(".")[0]}.0.0" }
scanners:
  - id: card
    kind: identifying
    pattern: '\\b(?:\\d[ -]?){12,18}\\d\\b'
    validator: luhn
`);
    expect(loadPack(dir).scanners[0]!.validate!("4111111111111111")).toBe(true);
  });

  it("throws when the pack requires an incompatible core", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^99.0.0" }
scanners:
  - id: ssn
    kind: identifying
    pattern: 'x'
`);
    expect(() => loadPack(dir)).toThrow(/incompatible/i);
  });

  it("throws on an unknown validator name rather than skipping the scanner", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^${PACK_CONTRACT_VERSION.split(".")[0]}.0.0" }
scanners:
  - id: x
    kind: identifying
    pattern: 'x'
    validator: not-registered
`);
    expect(() => loadPack(dir)).toThrow(/unknown validator/);
  });

  it("throws on malformed yaml rather than returning an empty pack", () => {
    writePack("pack: { id: cpa\nscanners: [");
    expect(() => loadPack(dir)).toThrow();
  });

  it("throws when pack.yaml is absent", () => {
    expect(() => loadPack(dir)).toThrow(/pack\.yaml/);
  });

  it("throws when the pack requires a 0.x core (0.x caret semantics unimplemented)", () => {
    writePack(`
pack: { id: cpa, version: 1.0.0, requiresCore: "^0.1.0" }
scanners:
  - id: ssn
    kind: identifying
    pattern: 'x'
`);
    expect(() => loadPack(dir)).toThrow(/0\.x/);
  });
});

describe("satisfiesCaret", () => {
  it("rejects a 0.x range rather than applying the 1.x+ rule to it", () => {
    expect(() => satisfiesCaret("^0.1.0", "0.2.0")).toThrow(
      /0\.x pre-1\.0 caret semantics are not implemented/,
    );
  });

  it("throws a descriptive error on a malformed version instead of a TypeError", () => {
    expect(() => satisfiesCaret("^1.0.0", "not-a-version")).toThrow(
      /PACK_CONTRACT_VERSION must be a plain "X\.Y\.Z" version/,
    );
  });
});
