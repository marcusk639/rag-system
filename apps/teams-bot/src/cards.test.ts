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
});
