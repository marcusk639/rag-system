import { describe, expect, it } from "vitest";
import { answerCard, emptyScopeCard, errorCard } from "./cards.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Attachment structure not fully typed; deps are injected
function text(att: any): string {
  return JSON.stringify(att.content);
}

describe("cards", () => {
  it("answer card always includes the server disclaimer verbatim", () => {
    const att = answerCard({
      answer: "A",
      citations: [],
      disclaimer: "AI-generated draft — verify.",
    });
    expect(text(att)).toContain("AI-generated draft — verify.");
    expect(text(att)).toContain("A");
  });
  it("answer card renders each citation title with its index", () => {
    const att = answerCard({
      answer: "A",
      citations: [
        {
          index: 1,
          title: "Intake SOP",
          documentId: "d1",
          downloadable: false,
        },
      ],
      disclaimer: "d",
    });
    expect(text(att)).toContain("Intake SOP");
    expect(text(att)).toContain("1");
  });
  it("empty-scope channel card guides the user to DM", () => {
    expect(text(emptyScopeCard("channel"))).toMatch(/direct message/i);
  });
  it("error card shows the given message", () => {
    expect(text(errorCard("temporarily unavailable"))).toContain(
      "temporarily unavailable",
    );
  });
});
