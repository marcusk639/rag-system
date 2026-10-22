import { describe, expect, it } from "vitest";
import { PROMPT_NAMES, loadPrompt, renderPrompt } from ".";

describe("loadPrompt", () => {
  it.each(PROMPT_NAMES)(
    "loads %s as non-empty text without the file's final newline",
    (name) => {
      const text = loadPrompt(name);
      expect(text.length).toBeGreaterThan(0);
      expect(text.endsWith("\n")).toBe(false);
    },
  );
});

describe("renderPrompt", () => {
  it("fills every placeholder", () => {
    expect(
      renderPrompt("Q: {{question}} / {{context}}", {
        question: "a",
        context: "b",
      }),
    ).toBe("Q: a / b");
  });

  it("never re-expands placeholders or replacement patterns inside values", () => {
    expect(
      renderPrompt("{{question}}|{{context}}", {
        question: "{{context}} $& $1 $$",
        context: "c",
      }),
    ).toBe("{{context}} $& $1 $$|c");
  });

  it("throws on a placeholder with no value", () => {
    expect(() =>
      renderPrompt("{{question}} {{missing}}", { question: "a" }),
    ).toThrow(/\{\{missing\}\}/);
  });

  it("throws on a value the template never uses", () => {
    expect(() =>
      renderPrompt("{{question}}", { question: "a", extra: "b" }),
    ).toThrow(/extra/);
  });
});
