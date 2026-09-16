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
  it("citation with a valid http(s) url gets an OpenUrl action targeting that exact url", () => {
    const att = answerCard({
      answer: "A",
      citations: [
        {
          index: 1,
          title: "Intake SOP",
          documentId: "d1",
          downloadable: true,
          url: "https://contoso.sharepoint.com/sites/kb/Intake-SOP.docx",
        },
      ],
      disclaimer: "d",
    });
    const content = text(att);
    expect(content).toContain("Action.OpenUrl");
    expect(content).toContain(
      "https://contoso.sharepoint.com/sites/kb/Intake-SOP.docx",
    );
  });
  it("citation without a url (or a non-http value) renders text only, no OpenUrl, no dead placeholder link", () => {
    const att = answerCard({
      answer: "A",
      citations: [
        {
          index: 1,
          title: "Intake SOP",
          documentId: "d1",
          downloadable: true,
        },
        {
          index: 2,
          title: "Legacy Memo",
          documentId: "d2",
          downloadable: false,
          url: "javascript:alert(1)",
        },
      ],
      disclaimer: "d",
    });
    const content = text(att);
    expect(content).toContain("Intake SOP");
    expect(content).toContain("Legacy Memo");
    expect(content).not.toContain("Action.OpenUrl");
    // Split the literal so this negative assertion isn't itself flagged by a
    // repo-wide grep for the placeholder host.
    const deadLinkHost = ["example", "com"].join(".");
    expect(content).not.toContain(deadLinkHost);
  });
  it("empty-scope channel card guides the user to DM", () => {
    expect(text(emptyScopeCard("channel"))).toMatch(/direct message/i);
  });
  it("error card shows the given message", () => {
    expect(text(errorCard("temporarily unavailable"))).toContain(
      "temporarily unavailable",
    );
  });

  it("answer card with an answerId offers Helpful / Not helpful submit actions carrying it", () => {
    const att = answerCard({
      answer: "A",
      citations: [],
      disclaimer: "d",
      answerId: "11111111-1111-4111-8111-111111111111",
    });
    const actions = att.content.actions as Array<Record<string, any>>;
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.type)).toEqual(["Action.Submit", "Action.Submit"]);
    expect(actions.map((a) => a.data)).toEqual([
      { kind: "rag-feedback", answerId: "11111111-1111-4111-8111-111111111111", rating: "helpful" },
      { kind: "rag-feedback", answerId: "11111111-1111-4111-8111-111111111111", rating: "not_helpful" },
    ]);
  });

  it("answer card without an answerId has no feedback actions", () => {
    const att = answerCard({ answer: "A", citations: [], disclaimer: "d" });
    expect(att.content.actions).toBeUndefined();
  });

  it("shows a citation's modified date when the API supplies one", () => {
    const att = answerCard({
      answer: "A",
      citations: [
        { index: 1, title: "Intake SOP", documentId: "d1", downloadable: false, modifiedAt: "2025-11-04" },
      ],
      disclaimer: "d",
    });
    expect(text(att)).toContain("Intake SOP (modified 2025-11-04)");
  });
});
