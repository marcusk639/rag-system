import { describe, expect, it, vi } from "vitest";
import {
  buildContextualizePrompt,
  contextualizeQuestion,
  type ConversationTurn,
} from "./contextualize.js";

const HISTORY: ConversationTurn[] = [
  { role: "user", content: "How do I set up a new bookkeeping client?" },
  {
    role: "assistant",
    content: "Create the client in Karbon and apply BK-CATCHUP [1].",
  },
];

describe("contextualizeQuestion", () => {
  it("returns the question unchanged and never calls the model when there is no history", async () => {
    const complete = vi.fn();
    expect(await contextualizeQuestion(complete, "What is the SOP?", [])).toBe(
      "What is the SOP?",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns the trimmed rewrite when there is history", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue("  How do I set up a new payroll client?\n");
    expect(
      await contextualizeQuestion(
        complete,
        "and for payroll clients?",
        HISTORY,
      ),
    ).toBe("How do I set up a new payroll client?");
  });

  it("fails open to the original question when the model throws", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("down"));
    expect(await contextualizeQuestion(complete, "and payroll?", HISTORY)).toBe(
      "and payroll?",
    );
  });

  it("falls back to the original question on empty model output", async () => {
    const complete = vi.fn().mockResolvedValue("   ");
    expect(await contextualizeQuestion(complete, "and payroll?", HISTORY)).toBe(
      "and payroll?",
    );
  });

  it("falls back when the model rambles instead of returning one question", async () => {
    const complete = vi.fn().mockResolvedValue("x".repeat(2_000));
    expect(await contextualizeQuestion(complete, "and payroll?", HISTORY)).toBe(
      "and payroll?",
    );
  });

  it("feeds only the last maxTurns turns, each capped at maxCharsPerTurn", async () => {
    const complete = vi.fn().mockResolvedValue("rewritten");
    const long: ConversationTurn[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn-${i} ${"y".repeat(50)}`,
    }));
    await contextualizeQuestion(complete, "q", long, {
      maxTurns: 2,
      maxCharsPerTurn: 10,
    });
    const prompt = complete.mock.calls[0]?.[0] as string;
    expect(prompt).not.toContain("turn-7");
    expect(prompt).toContain("turn-8");
    expect(prompt).toContain("turn-9");
    expect(prompt).not.toContain("y".repeat(11));
  });
});

describe("buildContextualizePrompt", () => {
  it("marks the conversation as data and asks for the question only", () => {
    const prompt = buildContextualizePrompt("and payroll?", HISTORY);
    expect(prompt).toContain("and payroll?");
    expect(prompt).toContain("BK-CATCHUP");
    expect(prompt).toMatch(/only the rewritten question/i);
  });
});
