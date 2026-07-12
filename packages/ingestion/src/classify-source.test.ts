import { describe, expect, it } from "vitest";
import { mapDataClassToDocumentClass } from "./classify-source.js";

describe("mapDataClassToDocumentClass", () => {
  it("maps 'general' to Class A", () => {
    expect(mapDataClassToDocumentClass("general")).toBe("A");
  });

  it("maps 'sop' to Class A", () => {
    expect(mapDataClassToDocumentClass("sop")).toBe("A");
  });

  it("maps 'research' to Class B", () => {
    expect(mapDataClassToDocumentClass("research")).toBe("B");
  });

  it("maps 'client_confidential' to Class D (blocked)", () => {
    expect(mapDataClassToDocumentClass("client_confidential")).toBe("D");
  });
});
