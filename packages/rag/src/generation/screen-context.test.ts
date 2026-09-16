import { describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@rag/core";
import { ComplianceError, EgressPolicy } from "@rag/core";
import { screenGenerationContext } from "./screen-context.js";
import {
  ClaudeGenerator,
  GeminiGenerator,
  OpenAIGenerator,
} from "./generator.js";

function chunk(id: string, text: string, title = "SOP"): RetrievalResult {
  return {
    text,
    score: 1,
    denseScore: 1,
    sparseScore: 0,
    document: { id: `doc-${id}`, title, sourceId: "s", metadata: {} },
    chunk: { id, ordinal: 0, headingPath: [] },
  } as unknown as RetrievalResult;
}

const CLEAN = chunk(
  "clean",
  "File the engagement letter in the client folder.",
);
const SSN = chunk("ssn", "Client record on file: SSN 123-45-6789.");
const CONTEXTUAL = chunk(
  "ctx",
  "Confirm the Form 1040 refund does not exceed $25,000 before release.",
);

describe("screenGenerationContext", () => {
  it("drops a chunk carrying an identifying pattern and keeps the rest (any policy but off)", () => {
    for (const policy of ["block", "warn"] as const) {
      const r = screenGenerationContext(
        "how do we file?",
        [SSN, CLEAN],
        policy,
      );
      expect(r.context).toEqual([CLEAN]);
      expect(r.dropped).toEqual([
        {
          chunkId: "ssn",
          documentId: "doc-ssn",
          patterns: expect.arrayContaining([expect.any(String)]),
        },
      ]);
    }
  });

  it("drops a contextual-only match under block, but keeps it (and reports it) under warn", () => {
    const blocked = screenGenerationContext("q", [CONTEXTUAL, CLEAN], "block");
    expect(blocked.context).toEqual([CLEAN]);

    const onWarn = vi.fn();
    const warned = screenGenerationContext(
      "q",
      [CONTEXTUAL, CLEAN],
      "warn",
      onWarn,
    );
    expect(warned.context).toEqual([CONTEXTUAL, CLEAN]);
    expect(onWarn).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it("screens the document title too, not only the chunk text", () => {
    const titled = chunk("t", "Clean body.", "Return for SSN 123-45-6789");
    const r = screenGenerationContext("q", [titled, CLEAN], "warn");
    expect(r.context).toEqual([CLEAN]);
  });

  it("throws a ComplianceError when the QUESTION itself carries an identifier", () => {
    expect(() =>
      screenGenerationContext("what about SSN 123-45-6789?", [CLEAN], "warn"),
    ).toThrow(ComplianceError);
  });

  it("throws a ComplianceError when every chunk is dropped", () => {
    expect(() => screenGenerationContext("q", [SSN], "warn")).toThrow(
      ComplianceError,
    );
  });

  it("does not scan at all under off", () => {
    const r = screenGenerationContext("SSN 123-45-6789", [SSN], "off");
    expect(r.context).toEqual([SSN]);
    expect(r.dropped).toEqual([]);
  });
});

describe("Generator.screen", () => {
  const base = {
    apiKey: "k",
    model: "m",
    egressPolicy: new EgressPolicy([
      "generativelanguage.googleapis.com",
      "api.openai.com",
      "api.anthropic.com",
    ]),
    triPolicy: "warn" as const,
  };

  for (const [name, Gen] of [
    ["gemini", GeminiGenerator],
    ["openai", OpenAIGenerator],
    ["claude", ClaudeGenerator],
  ] as const) {
    it(`${name} screens with its configured policy and reports drops`, () => {
      const onContextDropped = vi.fn();
      const gen = new Gen({ ...base, onContextDropped });
      expect(gen.screen("q", [SSN, CLEAN])).toEqual([CLEAN]);
      expect(onContextDropped).toHaveBeenCalledWith([
        expect.objectContaining({ chunkId: "ssn" }),
      ]);
    });
  }
});
